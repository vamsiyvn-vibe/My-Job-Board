import socket
# Force IPv4 only to prevent connection hangs on misconfigured IPv6 environments
old_getaddrinfo = socket.getaddrinfo
def new_getaddrinfo(*args, **kwargs):
    responses = old_getaddrinfo(*args, **kwargs)
    return [r for r in responses if r[0] == socket.AF_INET]
socket.getaddrinfo = new_getaddrinfo

import os
import sys
import requests
import json
from datetime import datetime
import re
import urllib.parse
from bs4 import BeautifulSoup
import urllib3

# Suppress SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

import sqlite3
import shutil

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPTS_DIR)
BOARD_DIR = os.path.join(PROJECT_ROOT, "board")
CONFIG_PATH = os.path.join(BOARD_DIR, "config.json")
LOCAL_DIR = os.environ.get("PM_BOARD_DATA_DIR") or os.path.join(BOARD_DIR, "data")
os.makedirs(LOCAL_DIR, exist_ok=True)
DB_PATH = os.environ.get("PM_BOARD_DB_PATH") or os.path.join(LOCAL_DIR, "board.db")
GDRIVE_DB_PATH = os.environ.get("PM_BOARD_SYNC_DB_PATH") or ""

def load_config():
    conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=10000;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Load profile
    cursor.execute("SELECT * FROM profile WHERE id = 1")
    profile = cursor.fetchone()
    
    # Load companies
    cursor.execute("SELECT * FROM companies")
    companies_rows = cursor.fetchall()
    conn.close()
    
    companies = []
    for r in companies_rows:
        companies.append({
            "name": r["name"],
            "platform": r["platform"],
            "board_id": r["board_id"] or "",
            "cohort": r["cohort"],
            "portal_url": r["portal_url"] or "",
            "capability": r["capability"],
            "levels": json.loads(r["levels"]) if r["levels"] else []
        })
        
    search_criteria = {
        "locations": json.loads(profile["locations"]) if profile else ["New York", "NYC", "Remote"],
        "custom_keywords": json.loads(profile["keywords"]) if profile else ["product manager", "product management", "technical product manager"],
        "role_levels": json.loads(profile["seniority_levels"]) if profile else ["Senior", "Group", "Staff", "Principal", "Director", "VP"],
        "strict_level_filtering": False
    }
    
    return {
        "search_criteria": search_criteria,
        "companies": companies,
        "profile": dict(profile) if profile else {}
    }

def calculate_gemini_relevancy_score(job_title, job_desc, profile, api_key):
    try:
        import requests
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
        headers = {"Content-Type": "application/json"}
        
        prompt = f"""
You are an expert technical product manager career coach.
Score the compatibility of this open job role against the candidate's canonical resume.

Candidate Profile Summary:
{profile.get("summary", "")}

Candidate Canonical Resume text:
{profile.get("canonical_resume", "")}

Open Role:
Title: {job_title}
Description: {job_desc[:3000]}

Rate the match strictly on a scale of 0 to 100 based on keyword match, seniority compatibility, and prior contributions overlap.
Respond with ONLY a JSON object containing two fields:
"score": an integer from 0 to 100.
"justification": a single concise sentence explanation.

JSON Response:
"""
        payload = {
            "contents": [{
                "parts": [{
                    "text": prompt
                }]
            }],
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        }
        
        res = requests.post(url, headers=headers, json=payload, timeout=12)
        if res.status_code == 200:
            data = res.json()
            text_resp = data["candidates"][0]["content"]["parts"][0]["text"].strip()
            parsed = json.loads(text_resp)
            return int(parsed.get("score", 70)), parsed.get("justification", "Scored via Gemini Flash AI.")
    except Exception as e:
        print(f"Gemini API score failed: {e}")
    # Fallback to local heuristic
    return calculate_relevancy_score(job_title, job_desc, profile), "Scored via local NLP heuristic (Gemini fallback)."

def get_supabase_anon_key():
    FALLBACK_ANON_KEY = "sb_publishable_WJm8OasR4BVsDd8pspSdfw_jIGm69ez"
    pub_pattern = re.compile(r'sb_publishable_[a-zA-Z0-9_\-]+')
    jwt_pattern = re.compile(r'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9_\-\.]+')
    
    try:
        r = requests.get("https://newpmjobs.com/", verify=False, timeout=10)
        if r.status_code == 200:
            # Check homepage HTML directly (prefer new Supabase publishable key format)
            match = pub_pattern.search(r.text) or jwt_pattern.search(r.text)
            if match:
                return match.group(0)
                
            # Match Next.js script chunks (supports /_next/static/chunks/ and /_next/static/immutable/chunks/)
            chunks = re.findall(r'/_next/static/(?:immutable/)?chunks/[^"\']+\.js', r.text)
            if not chunks:
                chunks = re.findall(r'src=["\'](/_next/static/[^"\']+\.js)["\']', r.text)
                
            found_jwt = None
            for chunk in dict.fromkeys(chunks):
                chunk_url = f"https://newpmjobs.com{chunk}"
                try:
                    res = requests.get(chunk_url, verify=False, timeout=5)
                    if res.status_code == 200:
                        pub_match = pub_pattern.search(res.text)
                        if pub_match:
                            return pub_match.group(0)
                        if not found_jwt:
                            jwt_match = jwt_pattern.search(res.text)
                            if jwt_match:
                                found_jwt = jwt_match.group(0)
                except Exception:
                    continue
            if found_jwt:
                return found_jwt
    except Exception as e:
        print(f"Warning: Dynamic API key extraction encountered error ({e}), using fallback key.")
        return FALLBACK_ANON_KEY

    # If extraction failed, return tested fallback key
    return FALLBACK_ANON_KEY

def calculate_relevancy_score(job_title, job_desc, profile):
    title_lower = job_title.lower()
    desc_lower = job_desc.lower()
    
    score = 0
    
    # 1. PM Keyword Match
    keywords = profile.get("keywords", "[]")
    if isinstance(keywords, str):
        keywords = json.loads(keywords)
    if not keywords:
        keywords = ["product manager", "product management", "technical product manager"]
        
    matched_kws = 0
    for kw in keywords:
        kw_l = kw.lower().strip()
        kws_to_check = [kw_l]
        if "product manager" in kw_l or "product management" in kw_l or kw_l in ["pm", "product"]:
            kws_to_check.extend(["product manager", "product management", "product managment", "product mgr", "pm", "pmt"])
        elif "technical product manager" in kw_l or "technical product management" in kw_l or kw_l in ["tpm"]:
            kws_to_check.extend(["technical product manager", "technical product management", "technical product mgr", "tpm", "pmt"])
            
        for k in kws_to_check:
            if k in ["pm", "tpm", "pmt"]:
                if re.search(r'\b' + re.escape(k) + r'\b', title_lower):
                    matched_kws += 1
                    score += 40
                    break
            else:
                if k in title_lower:
                    matched_kws += 1
                    score += 40
                    break
                    
    # 2. Seniority Level match
    seniority_targets = profile.get("seniority_levels", "[]")
    if isinstance(seniority_targets, str):
        seniority_targets = json.loads(seniority_targets)
    if seniority_targets:
        matched_level = False
        title_words = re.findall(r'\b\w+\b', title_lower)
        for lvl in seniority_targets:
            lvl_l = lvl.lower().strip()
            if lvl_l == "senior" and ("senior" in title_lower or "sr" in title_words or "lead" in title_lower):
                matched_level = True
            elif lvl_l == "principal" and ("principal" in title_lower or "staff" in title_lower):
                matched_level = True
            elif lvl_l == "director" and ("director" in title_lower or "head" in title_lower or "gpm" in title_words or "group product" in title_lower):
                matched_level = True
            elif lvl_l == "vp" and ("vp" in title_words or "vice president" in title_lower or "cpo" in title_words):
                matched_level = True
            elif lvl_l == "early" and not any(x in title_lower for x in ["senior", "sr", "principal", "staff", "director", "head", "vp", "lead"]):
                matched_level = True
        if matched_level:
            score += 30
            
    # 3. Resume text overlap
    resume_text = profile.get("canonical_resume", "").lower()
    if resume_text:
        stop_words = {"the", "and", "a", "of", "to", "in", "is", "for", "on", "with", "at", "by", "an", "this", "that", "it", "from", "as", "our", "us", "we"}
        resume_words = set(re.findall(r'\b\w{3,}\b', resume_text)) - stop_words
        desc_words = set(re.findall(r'\b\w{3,}\b', desc_lower)) - stop_words
        
        if resume_words:
            overlap = len(resume_words.intersection(desc_words))
            score += min(overlap, 30)
            
    return min(max(score, 0), 100)

def normalize_string(s):
    if not s:
        return ""
    # Retain parentheses because they distinguish specific focus areas (e.g. Netflix PM focus teams)
    s = s.replace("-", " ").replace(",", " ")
    return " ".join(s.split()).lower().strip()

def is_placeholder_url(url):
    if not url:
        return True
    url_lower = url.lower()
    placeholders = [
        "grounding-api-redirect", "search-results", "/search?", "/search/",
        "careers.google.com/jobs/results/?", "careers.microsoft.com",
        "jobs.apple.com", "openai.com/careers", "huggingface/jobs",
        "disneycareers.com", "cockroachlabs.com/careers/jobs",
        "/careers/jobs", "/careers", "/jobs"
    ]
    for p in placeholders:
        if p in url_lower:
            if "details/" in url_lower or "jobs/" in url_lower or "detail/" in url_lower or "job/" in url_lower or "pid=" in url_lower:
                continue
            return True
    return False


def is_job_url_closed(url, company_name):
    if not url or is_placeholder_url(url):
        return False
        
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
    }
    
    try:
        # 1. Greenhouse
        if "greenhouse.io" in url.lower():
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True, verify=False)
            if r.status_code == 404:
                return True
            if "/jobs/" not in r.url.lower() and "/postings/" not in r.url.lower():
                return True
            soup = BeautifulSoup(r.text, 'html.parser')
            text = soup.get_text().lower()
            if "job is no longer available" in text or "no longer open" in text or "position you are looking for has been filled" in text:
                return True
            return False
            
        # 2. Ashby
        elif "ashbyhq.com" in url.lower():
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True, verify=False)
            if r.status_code == 404:
                return True
            if "posting" not in r.url.lower():
                return True
            soup = BeautifulSoup(r.text, 'html.parser')
            text = soup.get_text().lower()
            if "no longer available" in text or "posting is closed" in text or "position you are looking for has been filled" in text:
                return True
            return False
            
        # 3. Workable
        elif "workable.com" in url.lower():
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True, verify=False)
            if r.status_code == 404:
                return True
            soup = BeautifulSoup(r.text, 'html.parser')
            text = soup.get_text().lower()
            if "no longer available" in text or "job is closed" in text or "not accepting applications" in text:
                return True
            return False
            
        # 4. Microsoft
        elif "careers.microsoft.com" in url.lower() or "apply.careers.microsoft.com" in url.lower():
            pid_match = re.search(r'/job/(\d+)', url)
            if not pid_match:
                pid_match = re.search(r'position_id=(\d+)', url)
            if pid_match:
                pid = pid_match.group(1)
                detail_url = f"https://apply.careers.microsoft.com/api/pcsx/position_details?domain=microsoft.com&position_id={pid}"
                r = requests.get(detail_url, headers=headers, timeout=10, verify=False)
                if r.status_code == 200:
                    try:
                        data = r.json()
                        if not data.get('data') or not data.get('data', {}).get('jobDescription'):
                            return True
                    except:
                        return True
                else:
                    return True
            return False
            
        # 5. Netflix
        elif "explore.jobs.netflix.net" in url.lower():
            parsed = urllib.parse.urlparse(url)
            query_params = urllib.parse.parse_qs(parsed.query)
            pid_list = query_params.get("pid")
            if pid_list:
                pid = pid_list[0]
                r = requests.get(url, headers=headers, timeout=10, verify=False)
                if r.status_code == 200:
                    soup = BeautifulSoup(r.text, 'html.parser')
                    code_tag = soup.find('code', id='smartApplyData')
                    if code_tag:
                        try:
                            config = json.loads(code_tag.get_text())
                            if not config.get("positions"):
                                return True
                        except:
                            return True
                    else:
                        text = soup.get_text().lower()
                        if "no longer available" in text or "not found" in text:
                            return True
                else:
                    return True
            return False
            
        # 6. Apple
        elif "jobs.apple.com" in url.lower():
            r = requests.get(url, headers=headers, timeout=10, verify=False)
            if r.status_code == 404:
                return True
            if r.status_code in [400, 403]:
                return False
            soup = BeautifulSoup(r.text, 'html.parser')
            text = soup.get_text().lower()
            if "no longer available" in text or "page not found" in text or "invalid job" in text:
                return True
            return False
            
        # 7. Amazon
        elif "amazon.jobs" in url.lower():
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True, verify=False)
            if r.status_code == 404:
                return True
            if r.status_code in [400, 403]:
                return False
            if "jobs" not in r.url.lower():
                return True
            soup = BeautifulSoup(r.text, 'html.parser')
            text = soup.get_text().lower()
            indicators = ["no longer available", "position has been filled", "job is closed", "not accepting applications", "posting has expired", "job is no longer active"]
            if any(ind in text for ind in indicators):
                return True
            return False
            
        # 8. Meta
        elif "metacareers.com" in url.lower():
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True, verify=False)
            if r.status_code == 404:
                return True
            if r.status_code in [400, 403]:
                return False
            soup = BeautifulSoup(r.text, 'html.parser')
            text = soup.get_text().lower()
            if "no longer available" in text or "job you are looking for is closed" in text:
                return True
            return False
            
        # 9. Google Careers
        elif "google.com/about/careers" in url.lower():
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True, verify=False)
            if r.status_code == 404:
                return True
            if r.status_code in [400, 403]:
                return False
            soup = BeautifulSoup(r.text, 'html.parser')
            title = soup.title.string if soup.title else ""
            if title:
                title_lower = title.strip().lower()
                # If title contains 'jobs search' or is exactly 'google careers', the job listing is closed/inactive
                if "jobs search" in title_lower or title_lower == "google careers":
                    return True
            # Fallback text check
            text = soup.get_text().lower()
            if "no longer available" in text or "job you are looking for is closed" in text:
                return True
            return False
            
        # 10. Generic
        else:
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True, verify=False)
            if r.status_code == 404:
                return True
            if r.status_code in [400, 403]:
                return False
            soup = BeautifulSoup(r.text, 'html.parser')
            text = soup.get_text().lower()
            indicators = [
                "no longer available",
                "position is no longer available",
                "job is no longer available",
                "this job is closed",
                "no longer accepting applications",
                "job posting has expired",
                "listing has expired",
                "position has been filled",
                "page you are looking for has been filled",
                "invalid job"
            ]
            if any(ind in text for ind in indicators):
                return True
            return False
            
    except Exception as e:
        print(f"Error checking status for URL {url}: {e}")
        return False

def extract_salary(text):
    if not text:
        return None
    
    import html
    unescaped = html.unescape(text)
    soup = BeautifulSoup(unescaped, 'html.parser')
    clean_text = soup.get_text(separator=' ')
    clean_text = re.sub(r'\s+', ' ', clean_text)
    
    pattern = r'(\$?)\s*([0-9]{2,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]{5,6})\s*([kK]?)\s*(USD|/yr|/year|/hr|/hour|per year|per hour)?\s*(?:-|to|and|through|\u2013|\u2014)\s*(\$?)\s*([0-9]{2,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]{5,6})\s*([kK]?)\s*(USD|/yr|/year|/hr|/hour|per year|per hour)?'
    
    matches = re.finditer(pattern, clean_text)
    for m in matches:
        has_dollar = bool(m.group(1) or m.group(5))
        val1_str = m.group(2)
        k1 = m.group(3)
        unit1 = m.group(4) or ""
        val2_str = m.group(6)
        k2 = m.group(7)
        unit2 = m.group(8) or ""
        
        # Clean commas and decimals
        v1_clean = re.sub(r'[,\.]', '', val1_str).strip()
        if '.' in val1_str:
            v1_clean = val1_str.split('.')[0].replace(',', '')
            
        v2_clean = re.sub(r'[,\.]', '', val2_str).strip()
        if '.' in val2_str:
            v2_clean = val2_str.split('.')[0].replace(',', '')
            
        try:
            v1 = int(v1_clean)
            v2 = int(v2_clean)
            
            # Apply k/K multipliers
            if k1.lower() == 'k':
                v1 *= 1000
            if k2.lower() == 'k':
                v2 *= 1000
                
            if v1 < 1000 and (k1.lower() == 'k' or k2.lower() == 'k' or v2 >= 30000):
                v1 *= 1000
            if v2 < 1000 and (k1.lower() == 'k' or k2.lower() == 'k' or v1 >= 30000):
                v2 *= 1000
                
            # Range check for annual salary
            if (30000 <= v1 <= 1000000 and 30000 <= v2 <= 1000000):
                if v1 > v2:
                    v1, v2 = v2, v1
                return f"${v1:,} - ${v2:,}"
                
            # Range check for hourly rate (e.g., 30 to 300)
            elif (30 <= v1 <= 300 and 30 <= v2 <= 300):
                unit_str = (unit1 + unit2).lower()
                is_hourly = 'hr' in unit_str or 'hour' in unit_str or 'hourly' in unit_str
                
                if has_dollar or is_hourly:
                    if v1 > v2:
                        v1, v2 = v2, v1
                    return f"${v1}/hr - ${v2}/hr"
        except:
            pass
    return None

# DuckDuckGo HTML Search Helper
def search_ddg(query):
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    for attempt in range(3):
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')
                links = []
                for a in soup.find_all('a', class_='result__snippet', href=True):
                    href = a['href']
                    if "/l/?uddg=" in href:
                        parsed = urllib.parse.urlparse(href)
                        query_params = urllib.parse.parse_qs(parsed.query)
                        real_url = query_params.get("uddg", [None])[0]
                        if real_url:
                            links.append(real_url)
                    elif href.startswith("http"):
                        links.append(href)
                for a in soup.find_all('a', class_='result__a', href=True):
                    href = a['href']
                    if "/l/?uddg=" in href:
                        parsed = urllib.parse.urlparse(href)
                        query_params = urllib.parse.parse_qs(parsed.query)
                        real_url = query_params.get("uddg", [None])[0]
                        if real_url:
                            links.append(real_url)
                    elif href.startswith("http"):
                        links.append(href)
                if links:
                    return list(set(links))
            elif r.status_code == 202:
                # Meta refresh redirect
                soup = BeautifulSoup(r.text, 'html.parser')
                meta_refresh = soup.find('meta', attrs={'http-equiv': 'refresh'})
                if meta_refresh:
                    content = meta_refresh.get('content', '')
                    if 'url=' in content:
                        refresh_url = content.split('url=')[-1]
                        if refresh_url.startswith('/'):
                            refresh_url = f"https://html.duckduckgo.com{refresh_url}"
                        url = refresh_url
                        continue
        except Exception as e:
            print(f"DDG Search attempt {attempt} failed: {e}")
        import time
        time.sleep(1)
    return []

# A CSS/icon token glued directly onto the front of a title with no separator, e.g.
# "output-arrowSenior Product Manager". Requiring a HYPHEN in the lowercase run is what
# makes this safe: that shape is characteristic of markup tokens ("output-arrow",
# "icon-chevron") and cannot match legitimate camelCase titles such as
# "eCommerce Product Manager", "eCRMs ... Sr. Digital Product Manager" or
# "eDiscovery Program Manager", all of which exist upstream and must be preserved.
_GLUED_PREFIX_RE = re.compile(r'^[a-z]+(?:-[a-z0-9]+)+(?=[A-Z])')

# Scraped UI labels that upstream sometimes glues onto a field with no separator, e.g.
# job_location "locationNYC". These have no hyphen, so they need an explicit list rather
# than the pattern above - a bare "lowercase-run followed by uppercase" rule would also
# destroy legitimate values like "eCommerce Product Manager".
_GLUED_LABEL_RE = re.compile(r'^(location|department|jobtype|job type|posted|salary|apply)(?=[A-Z])',
                             re.IGNORECASE)


def sanitize_scraped_field(value):
    """Strip a scraped UI label glued to the front of a field value (e.g. 'locationNYC')."""
    v = (value or "").strip()
    if not v:
        return v
    cleaned = _GLUED_LABEL_RE.sub('', v, count=1).strip()
    cleaned = _GLUED_PREFIX_RE.sub('', cleaned, count=1).strip()
    return cleaned or v


def parse_posted_date(val):
    """Normalize a raw posting date (epoch sec/ms, ISO-8601, 'Month DD, YYYY', 'Mon DD, YYYY') to 'YYYY-MM-DD'."""
    if val is None or val == "":
        return ""
    if isinstance(val, (int, float)):
        ts = float(val)
        if ts > 1e12:
            ts /= 1000.0
        if 1500000000 <= ts <= 2100000000:
            from datetime import timezone as _tz
            return datetime.fromtimestamp(ts, tz=_tz.utc).strftime("%Y-%m-%d")
        return ""
    s = str(val).strip()
    if not s:
        return ""
    if re.match(r'^\d{10,13}$', s):
        return parse_posted_date(int(s))
    m_iso = re.match(r'^(\d{4}-\d{2}-\d{2})', s)
    if m_iso:
        return m_iso.group(1)
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return ""


def _date_posted_from_jsonld(html_text):
    """Extract schema.org JobPosting datePosted ('YYYY-MM-DD') from HTML if present."""
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html_text or "", re.S | re.I):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        for obj in (data if isinstance(data, list) else [data]):
            if isinstance(obj, dict) and obj.get("@type") == "JobPosting":
                dt = parse_posted_date(obj.get("datePosted"))
                if dt:
                    return dt
    return ""


def normalize_job_url(url):
    """Reduce a posting URL to a stable requisition identifier for de-duplication.

    Strips scheme, 'www.', query string, fragment and trailing slash so cosmetic variations
    of the same link collapse together. If the URL carries an obvious requisition id
    (gh_jid=..., pid=..., or a long digit run in the path) that id alone is used, which keeps
    ?gh_jid=123 / ?pid=123 and /jobs/123 as one job across NewPMJobs and Company Scrapers.
    """
    u = (url or "").strip().lower()
    if not u:
        return ""
    mid = re.search(r'(?:gh_jid|jobid|job_id|requisitionid|reqid|pid)=(\w+)', u)
    if mid:
        return "req:" + mid.group(1)
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'^www\.', '', u)
    u = u.split('#', 1)[0].split('?', 1)[0].rstrip('/')
    apple_m = re.search(r'jobs\.apple\.com/(?:[a-z\-]+/)?details/(\d{7,12})', u)
    if apple_m:
        return "req:" + apple_m.group(1)
    tail = re.findall(r'(\d{6,})', u)
    if tail:
        return "req:" + tail[-1]
    return u


# Known ATS URL shapes that carry the employer slug as a path/subdomain segment. Used only
# as a LAST-RESORT company name when the upstream `companies` table is unreachable and the id
# was never seen before (see reconstruct_company_map). Deliberately conservative: returns a
# readable display name, or "" so the caller can decide to skip rather than invent garbage.
def derive_company_from_url(url):
    u = (url or "").strip().lower()
    if not u:
        return ""
    slug = ""
    patterns = [
        r'boards\.greenhouse\.io/(?:embed/job_app\?for=)?([a-z0-9\-]+)',
        r'job-boards\.greenhouse\.io/([a-z0-9\-]+)',
        r'jobs\.lever\.co/([a-z0-9\-]+)',
        r'jobs\.ashbyhq\.com/([a-z0-9\-]+)',
        r'apply\.workable\.com/([a-z0-9\-]+)',
        r'([a-z0-9\-]+)\.workable\.com',
        r'([a-z0-9\-]+)\.breezy\.hr',
    ]
    for pat in patterns:
        mo = re.search(pat, u)
        if mo:
            slug = mo.group(1)
            break
    if not slug:
        return ""
    # "acme-corp" / "acme_corp" -> "Acme Corp"
    return " ".join(w.capitalize() for w in re.split(r'[-_]+', slug) if w)


def _clean_company_name(name):
    """Tidy a scraped employer name into a board-style display name."""
    n = " ".join((name or "").split()).strip().strip(",")
    # Strip a glued leading number (Workday embeds "102 Yahoo Inc." - a rating count fused onto
    # the name). Only when a space follows, so "1Password", "3M", "23andMe" survive untouched.
    n = re.sub(r'^\d+\s+', '', n)
    # Drop a trailing legal suffix so "Yahoo Inc." matches how the board names "Yahoo".
    n = re.sub(r'[\s,]+(inc\.?|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|co\.|plc|'
               r'gmbh|s\.a\.|pvt\.?\s*ltd\.?|holdings?)\.?$', '', n, flags=re.IGNORECASE).strip()
    return n


def _company_from_jsonld(html):
    """Pull hiringOrganization.name from a posting's schema.org JobPosting JSON-LD.

    Every major ATS (Workday, Oracle, Greenhouse, Lever, SmartRecruiters, ...) embeds this
    block in the served HTML, so it is the most reliable ATS-agnostic source of the employer
    name - which matters now that NewPMJobs' companies table is RLS-locked and a brand-new
    company's id cannot be reconstructed from board history.
    """
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>',
                            html or "", re.S | re.I):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        for obj in (data if isinstance(data, list) else [data]):
            if not isinstance(obj, dict):
                continue
            org = obj.get("hiringOrganization")
            if isinstance(org, dict) and org.get("name"):
                return _clean_company_name(org["name"])
            if isinstance(org, str) and org.strip():
                return _clean_company_name(org)
    return ""


# Career-site boilerplate that surrounds the employer name in a <title> / og:site_name, e.g.
# "Akamai Career Site", "GitHub Careers", "JPMC Candidate Experience page". Stripped so only
# the company survives. A value that is ENTIRELY boilerplate (Oracle's generic "Candidate
# Experience site") collapses to empty and is correctly treated as unresolved.
_ATS_BOILERPLATE_RE = re.compile(
    r'\b(candidate experience(?: (?:page|site))?|career(?:s)?(?: (?:page|portal|site|center))?|'
    r'job search|open positions|current openings|job openings|talent (?:community|network)|'
    r'we are hiring|jobs?(?: at)?|workday|careers site)\b', re.IGNORECASE)

_GENERIC_HOST_LABELS = {"www", "jobs", "job", "careers", "career", "apply", "boards", "work",
                        "fa", "wd1", "wd2", "wd3", "wd4", "wd5", "us2", "ocs", "eu", "hire"}


# Words that mark a string as a JOB TITLE rather than a company name. Used to reject a <title>
# that is really the role (e.g. Elastic serves "Senior Product Manager, Logs" as the title).
_ROLE_WORDS_RE = re.compile(
    r'\b(product manager|program manager|project manager|engineer|developer|designer|analyst|'
    r'scientist|director|principal|senior|staff|lead|vp|vice president|head of|manager|'
    r'specialist|consultant|architect|intern|officer|associate|\$\d)\b', re.IGNORECASE)


def _strip_boilerplate(seg):
    return re.sub(r'\s+', ' ', _ATS_BOILERPLATE_RE.sub(' ', seg)).strip(" -|:–—,")


def _company_from_meta(html):
    """Employer name from TRUSTED page metadata only.

    Uses og:site_name (career sites set it to the employer, e.g. "Akamai Career Site") and the
    LinkedIn "<Company> hiring <role> ..." title pattern. Deliberately does NOT mine arbitrary
    <title> segments - those are usually the ROLE (Elastic serves "Senior Product Manager,
    Logs") and produced garbage company names. When this returns "", the hostname fallback in
    resolve_company_name names the company instead (jobs.elastic.co -> Elastic).
    """
    title = re.search(r'<title[^>]*>([^<]+)</title>', html, re.I)
    title_raw = title.group(1).strip() if title else ""

    mo = re.match(r'(.+?)\s+hiring\s+', title_raw, re.I)   # LinkedIn-style
    if mo and len(mo.group(1)) >= 2:
        return _clean_company_name(mo.group(1))

    og = (re.search(r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\']([^"\']+)', html, re.I)
          or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:site_name', html, re.I))
    if og:
        for seg in re.split(r'\s[\-–—|:]\s', og.group(1).strip()):
            seg = _strip_boilerplate(seg)
            if len(seg) >= 2 and not _ROLE_WORDS_RE.search(seg):
                return _clean_company_name(seg)
    return ""


def _company_from_host(url):
    """Last-resort: the distinctive label of the careers hostname (jobs.elastic.co -> Elastic).

    Skips known ATS/generic labels so it never emits "greenhouse" / "workday" / "www".
    """
    host = re.sub(r'^https?://', '', (url or "").lower()).split('/')[0]
    labels = [l for l in host.split('.') if l not in _GENERIC_HOST_LABELS
              and l not in ("com", "co", "io", "net", "org", "oraclecloud", "myworkdayjobs",
                            "greenhouse", "lever", "ashbyhq", "workable", "breezy", "smartrecruiters",
                            "icims", "myworkday", "saasfaprod1", "extu")]
    if labels:
        cand = max(labels, key=len)
        if len(cand) >= 3:
            return " ".join(w.capitalize() for w in re.split(r'[-_]+', cand) if w)
    return ""


def resolve_company_name(url):
    """Best-effort employer name for a posting when the upstream companies table is gone.

    Order of reliability: schema.org JSON-LD hiringOrganization -> og:site_name / <title>
    (boilerplate stripped) -> ATS URL slug -> distinctive hostname label. Returns "" only if
    all fail. Short-timeout so a slow careers page cannot stall the whole scan.
    """
    if not url:
        return ""
    try:
        headers_req = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        r = requests.get(url, headers=headers_req, timeout=8, verify=False, allow_redirects=True)
        if r.status_code == 200:
            nm = _company_from_jsonld(r.text) or _company_from_meta(r.text)
            if nm:
                return nm
    except Exception as e:
        print(f"  Company-name resolve failed for {url[:60]}: {e}")
    return derive_company_from_url(url) or _company_from_host(url)


def reconstruct_company_map(agg_jobs, existing_jobs):
    """Rebuild the source's company_id -> name map WITHOUT the upstream `companies` table.

    NewPMJobs.com revoked anonymous read access to its `companies` table (Supabase RLS now
    returns 401), which used to abort the whole aggregator scan. But every job we have ALREADY
    ingested carries both the source's job_url_path (in seen_jobs) and the resolved company
    name (in our board), so a URL join recovers the id->name mapping for every company we have
    ever seen. Brand-new companies fall back to a slug parsed from the posting URL so nothing
    is silently dropped.
    """
    url2name = {}
    for j in existing_jobs:
        u = j["url"] if not isinstance(j, dict) else j.get("url")
        n = j["company_name"] if not isinstance(j, dict) else j.get("company_name")
        if u and n:
            url2name[normalize_job_url(u)] = n
    votes = {}
    for aj in agg_jobs:
        nm = url2name.get(normalize_job_url(aj.get("job_url_path") or ""))
        if nm:
            cid = aj.get("company_id")
            votes.setdefault(cid, {}).setdefault(nm, 0)
            votes[cid][nm] += 1
    id2name = {cid: max(vc, key=vc.get) for cid, vc in votes.items()}
    # Slug fallback for company_ids never seen before.
    for aj in agg_jobs:
        cid = aj.get("company_id")
        if cid and cid not in id2name:
            nm = derive_company_from_url(aj.get("job_url_path") or "")
            if nm:
                id2name[cid] = nm
    return id2name


def job_identity_key(company, title, url):
    """De-dup key for a posting across all sources (NewPMJobs & Individual Company Scrapers).

    Uses (company, normalized_posting_url) whenever a valid job URL is present:
      - Two openings with the same title at the same company that have DIFFERENT posting URLs
        get distinct keys and are never collapsed together.
      - The same opening discovered by both NewPMJobs and an Individual Company Scraper (or
        whose title punctuation was slightly tweaked on the same requisition URL) shares one
        normalized URL key and is de-duplicated into a single row.
    Falls back to (company, title, '') only if the URL is missing or a generic placeholder.
    """
    norm_u = normalize_job_url(url)
    if norm_u and not is_placeholder_url(url):
        return (normalize_string(company), norm_u)
    return (normalize_string(company), normalize_string(title), "")


def sanitize_job_title(title):
    """Strip scraped UI artifacts glued to the front of a job title.

    The upstream feed (NewPMJobs) occasionally captures an icon label attached to the title
    with no separating space. Because there is then no word boundary before the real title,
    downstream title logic misreads the role - the board's seniority classifier matches
    \\bsenior\\b, so "output-arrowSenior Product Manager" was bucketed Early instead of Mid.

    Deliberately conservative: it only strips the hyphenated-token shape above, and never
    returns an empty string.
    """
    t = (title or "").strip()
    if not t:
        return t
    cleaned = _GLUED_PREFIX_RE.sub('', t, count=1).strip()
    return cleaned or t


# Product functions that merely contain the word "product" but are NOT product-management
# roles. Only these are rejected; everything else with "product" in the title counts.
_NON_PM_ROLE_NOUNS = (
    r'(?:marketing|marketer|design|designer|engineering|engineer|developer|development|'
    r'architect|architecture|analyst|analytics|research|researcher|scientist|science|'
    r'counsel|legal|policy|support|sales|specialist|recruiter|recruiting|'
    r'operations|ops|strategy|strategist|deployment|delivery|release|enablement|'
    r'education|training|communications|comms|pr|security|finance|financial|'
    r'quality|qa|test|tester|safety|physician|technician|coordinator|administrator|admin|'
    r'writer|editor|copywriter|actuary|underwriter|controller|accountant|auditor|'
    r'buyer|merchandising|merchandiser|sourcing|manufacturing|supply|logistics|fulfillment|'
    r'creative|content|solutions|program|project)'
)


def is_pm_title(title):
    """True if `title` is a Product Manager, Product Management, or Head/VP/Director of Product role.

    Accepts:
      1. Explicit Product Manager / Product Management / Product Mgr / PM / TPM / PMT / GPM / APM roles
      2. Product Leadership / Owner framing: Head of Product, VP/SVP/EVP/AVP of Product,
         Director of Product (including comma forms like 'Director, Product', 'VP, Product'),
         Chief Product Officer (CPO / CPTO), Product Owner, Product Lead / Leader.
    Rejects:
      - Non-PM functions with 'Product' in the title: Product Deployment Engineer,
        Product Development Engineer, Software Engineer - Product, Product Designer,
        Product Marketing Manager, Product Strategy Lead, Product Operations Manager,
        Product Policy Manager, Product Communications Manager, Product Security,
        Product Analytics / Analyst / Data Scientist, Product Counsel / Legal,
        Product Finance, Product Architecture / Architect, Product Delivery / Release,
        Executive Communications, Program Manager, Chief of Staff, etc.
    """
    t = " ".join((title or "").lower().replace("_", " ").split())
    if not t:
        return False

    if re.search(r'\b(?:chief\s+of\s+staff|executive\s+communications|communications\s+director|business\s+program\s+manager|program\s+manager)\b', t):
        if not re.search(r'\b(?:product\s+manag(?:er|ers|ement|ment)|product\s+mgr)\b', t):
            return False

    if re.search(
        r'^(?:senior\s+|sr\.?\s+|staff\s+|principal\s+|lead\s+|manager\s*,\s*|director\s*,\s*)*'
        r'(?:software|systems|data|ml|ai|machine\s+learning|security|cloud|platform|frontend|backend|full\s*stack|qa|test|quality|sales|solutions|customer|field|electrical|mechanical|hardware|firmware|silicon|research|applied|quantitative|business|financial|operations|program|project|marketing|design|ux|ui|content|legal|policy|communications)?\s*'
        r'(?:engineer|engineering|scientist|analyst|designer|architect|counsel|attorney|recruiter|specialist|strategist|physician|writer|producer|coordinator)\b',
        t
    ) and not re.search(r'\b(?:product\s+manag(?:er|ers|ement|ment)|product\s+mgr|pmt)\b', t):
        return False

    if re.search(
        r'\bproduct\s+(?:[a-z0-9/&\-\s]{0,25}\s+)?'
        r'(?:engineer|engineering|designer|scientist|analyst|architect|counsel|attorney|recruiter|specialist|strategist|physician|marketer|writer|copywriter|technician|coordinator|administrator)\b',
        t
    ) and not re.search(r'\b(?:product\s+manag(?:er|ers|ement|ment)|product\s+mgr)\b', t):
        return False

    t_cleaned = re.sub(
        r'\bproduct\s+(?:[a-z]+\s+)?' + _NON_PM_ROLE_NOUNS + r'\s+manag(?:er|ers|ement|ment|er\s*[i12345v]+)\b',
        ' ',
        t
    )
    if re.search(r'\b(?:product\s+manag(?:er|ers|ement|ment)|product\s+mgr|pm|tpm|pmt|gpm|apm)\b', t_cleaned):
        return True

    if re.search(r'\bproduct\s+(?:&\s+[a-z]+\s+)?' + _NON_PM_ROLE_NOUNS + r'\b', t):
        return False

    leadership_patterns = [
        r'\bmember\s+of\s+product\s+staff\b',
        r'\bchief\s+product\s+(?:&\s+technology\s+)?officer\b',
        r'\b(?:cpo|cpto)\b',
        r'\b(?:head|vp|vice\s+president|svp|evp|avp|director)\s*(?:of\s+|,\s*|\s+-\s*|\s+)(?:(?:global|regional|group|enterprise|consumer|commercial|platform|core|ai|ml|data|digital|growth|technical|cloud|financial|fintech|payments|ads|advertising|search|commerce|marketplace|b2b|b2c|saas|healthcare|health)\s+){0,2}product\b',
        r'\bproduct\s+(?:head|director|vp|vice\s+president|owner|lead|leader)\b',
        r'\b(?:lead|principal|staff|group|senior|sr\.?)\s+product\s+(?:owner|lead|leader|director)\b',
    ]
    for pat in leadership_patterns:
        if re.search(pat, t):
            return True

    return False


def title_matches_company_levels(title, company_name, config=None):
    if config is None:
        config = load_config()
    title_lower = title.lower()
    
    # Find company in config
    companies = config.get("companies", [])
    target_company = None
    for co in companies:
        if co.get("name", "").lower().strip() == company_name.lower().strip():
            target_company = co
            break
            
    if not target_company:
        return True
        
    selected_levels = target_company.get("levels")
    if selected_levels is None or len(selected_levels) == 0:
        return True
        
    selected_levels_lower = [l.lower().strip() for l in selected_levels]
    company_name_lower = company_name.lower().strip()
    
    # Helper to check if a title is a product role. Seniority is handled separately by the
    # exclude_markers in each level branch, so this only answers "is this a product role?".
    def is_generic_pm_title(t_lower):
        return is_pm_title(t_lower)
        
    if company_name_lower == "google":
        for lvl in selected_levels_lower:
            if lvl == "product manager i":
                exclude_markers = ["ii", "senior", "sr.", "sr ", "group", "gpm", "director", "vp", "vice president", "lead", "principal", "staff"]
                if "pm i" in title_lower or "product manager i" in title_lower or (is_generic_pm_title(title_lower) and not any(m in title_lower for m in exclude_markers)):
                    return True
            elif lvl == "product manager ii":
                if "product manager ii" in title_lower or "pm ii" in title_lower or "l6" in title_lower:
                    return True
            elif lvl == "senior":
                if "senior" in title_lower or "sr." in title_lower or "sr " in title_lower:
                    return True
            elif lvl == "group":
                if "group" in title_lower or "gpm" in title_lower or "group product" in title_lower:
                    return True
            elif lvl == "director":
                if "director" in title_lower and "senior director" not in title_lower:
                    return True
            elif lvl == "senior director":
                if "senior director" in title_lower:
                    return True
            elif lvl == "vice president":
                if "vice president" in title_lower or "vp" in title_lower:
                    return True
                    
    elif company_name_lower == "meta":
        for lvl in selected_levels_lower:
            if lvl == "standard":
                # NOTE: the marker used to be a bare "manager," which excluded EVERY
                # "Product Manager, <area>" title - i.e. Meta's normal IC PM title format -
                # so Standard-level Meta roles were silently dropped. The intent was to
                # exclude the people-manager title "Manager, Product Management".
                exclude_markers = ["director", "vp", "vice president", "head of", "lead",
                                   "manager, product management", "group", "leadership"]
                if is_generic_pm_title(title_lower) and not any(m in title_lower for m in exclude_markers):
                    return True
            elif lvl == "leadership":
                include_markers = ["director", "vp", "vice president", "head of", "lead", "manager, product management", "group", "leadership"]
                if any(m in title_lower for m in include_markers):
                    return True
                    
    else:
        for lvl in selected_levels_lower:
            if lvl == "standard" or lvl.startswith("standard"):
                # "partner" was removed: in PM titles it almost always names a DOMAIN
                # ("Partner Interfaces", "Partnerships"), not a seniority, so it was
                # wrongly excluding standard-level roles.
                exclude_markers = ["senior", "sr.", "sr ", "principal", "staff", "director", "vp", "vice president", "lead", "associate", " ii", " iii", "head of", "chief", "group", "gpm"]
                if is_generic_pm_title(title_lower) and not any(m in title_lower for m in exclude_markers):
                    return True
            elif lvl == "senior":
                if "senior" in title_lower or "sr." in title_lower or "sr " in title_lower:
                    return True
            elif lvl == "staff":
                if "staff" in title_lower:
                    return True
            elif lvl == "group":
                if "group" in title_lower or "gpm" in title_lower or "group product" in title_lower:
                    return True
            elif lvl == "principal":
                if "principal" in title_lower:
                    return True
            elif lvl == "director":
                if "director" in title_lower and "senior director" not in title_lower:
                    return True
            elif lvl == "senior director":
                if "senior director" in title_lower:
                    return True
            elif lvl == "vice president":
                if "vice president" in title_lower or "vp" in title_lower:
                    return True
            elif lvl == "chief product officer" or lvl.startswith("chief product"):
                if "chief product" in title_lower or "cpo" in title_lower:
                    return True
                    
    return False

def matches_criteria(title, locations_list, search_criteria, company_name, config=None):
    title_lower = title.lower()
    
    # 1. PM Keyword Match. Uses the shared is_pm_title() so the whole product-leadership
    # family counts (VP/Head/Director of Product, Product Owner/Lead, CPO). This function
    # also drives auto-archiving, so keeping it in sync with ingestion is essential -
    # otherwise newly-ingested senior product roles get archived as
    # "Not meeting Search Criteria" on the very next scan.
    if not is_pm_title(title):
        return False
        
    # 2. Level Match - INTENTIONALLY DISABLED.
    # Seniority is now filtered in the board UI (the Early / Mid / Dir+ toggles on the
    # Sourcing Board), which is non-destructive and adjustable per-view. Filtering by level
    # at CRAWL time was lossy and irreversible: it silently refused to ingest roles, and via
    # matches_criteria it also auto-archived existing ones as "Not meeting Search Criteria".
    # Ingest everything that is a PM role in an eligible location; let the UI narrow it.
                
    # 3. Location Match. Delegates to the shared location_is_eligible() so the ATS-direct
    # crawlers apply the exact same rules as aggregator ingestion and the parity audit -
    # nationwide US, the non-US-only guard, and the title fallback. Each posting location is
    # checked individually so a multi-location role qualifies on any one eligible slot.
    for l in locations_list:
        if not l or l == "N/A":
            continue
        if location_is_eligible(l, search_criteria, title):
            return True
    return False

# Crawler functions per platform
def check_greenhouse_jobs(board, company_name, cohort, search_criteria, config=None):
    url = f"https://api.greenhouse.io/v1/boards/{board}/jobs?content=true"
    leads = []
    try:
        r = requests.get(url, timeout=12)
        if r.status_code == 200:
            data = r.json()
            jobs = data.get("jobs", [])
            for job in jobs:
                title = job.get("title", "")
                loc = job.get("location", {}).get("name", "") if job.get("location") else ""
                
                if matches_criteria(title, [loc], search_criteria, company_name, config):
                    salary = "N/A"
                    content = job.get("content")
                    if content:
                        salary = extract_salary(content) or "N/A"
                    leads.append({
                        "cohort": cohort,
                        "company": company_name,
                        "role": title,
                        "location": loc,
                        "key_focus": "Discovered via Greenhouse automated crawl",
                        "url": job.get("absolute_url"),
                        "salary": salary,
                        "posted_at": parse_posted_date(job.get("first_published") or job.get("updated_at"))
                    })
    except Exception as e:
        print(f"Error checking Greenhouse {board} ({company_name}): {e}")
    return leads

def check_ashby_jobs(board, company_name, cohort, search_criteria, config=None):
    url = f"https://api.ashbyhq.com/posting-api/job-board/{board}"
    leads = []
    try:
        r = requests.get(url, timeout=12)
        if r.status_code == 200:
            jobs = r.json().get("jobs", [])
            for j in jobs:
                title = j.get("title", "")
                loc = j.get("location", "")
                
                if matches_criteria(title, [loc], search_criteria, company_name, config):
                    salary = "N/A"
                    desc = j.get("descriptionPlain") or j.get("descriptionHtml")
                    if desc:
                        salary = extract_salary(desc) or "N/A"
                    leads.append({
                        "cohort": cohort,
                        "company": company_name,
                        "role": title,
                        "location": loc,
                        "key_focus": "Discovered via Ashby automated crawl",
                        "url": j.get("jobUrl"),
                        "salary": salary,
                        "posted_at": parse_posted_date(j.get("publishedAt") or j.get("publishedDate"))
                    })
    except Exception as e:
        print(f"Error checking Ashby {board} ({company_name}): {e}")
    return leads

def check_workable_jobs(board, company_name, cohort, search_criteria, config=None):
    url = f"https://apply.workable.com/api/v1/accounts/{board}/jobs"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/json"
    }
    leads = []
    try:
        r = requests.post(url, json={}, headers=headers, timeout=12)
        if r.status_code == 200:
            jobs = r.json().get("results", [])
            for j in jobs:
                title = j.get("title", "")
                loc_dict = j.get("location", {})
                city = loc_dict.get("city", "") if loc_dict else ""
                region = loc_dict.get("region", "") if loc_dict else ""
                loc_str = f"{city}, {region}" if city else "Remote"
                
                if matches_criteria(title, [loc_str], search_criteria, company_name, config):
                    leads.append({
                        "cohort": cohort,
                        "company": company_name,
                        "role": title,
                        "location": loc_str,
                        "key_focus": "Discovered via Workable automated crawl",
                        "url": f"https://apply.workable.com/{board}/j/{j.get('shortcode')}",
                        "posted_at": parse_posted_date(j.get("published") or j.get("created_at"))
                    })
    except Exception as e:
        print(f"Error checking Workable {board} ({company_name}): {e}")
    return leads

def check_lever_jobs(board, company_name, cohort, search_criteria, config=None):
    url = f"https://api.lever.co/v0/postings/{board}?mode=json"
    leads = []
    try:
        r = requests.get(url, timeout=12)
        if r.status_code == 200:
            jobs = r.json()
            if isinstance(jobs, list):
                for j in jobs:
                    title = j.get("text", "")
                    categories = j.get("categories", {})
                    loc = categories.get("location", "") if isinstance(categories, dict) else ""
                    
                    if matches_criteria(title, [loc], search_criteria, company_name, config):
                        salary = "N/A"
                        desc = j.get("descriptionPlain") or ""
                        addl = j.get("additionalPlain") or ""
                        combined_desc = desc + "\n" + addl
                        if combined_desc.strip():
                            salary = extract_salary(combined_desc) or "N/A"
                        
                        leads.append({
                            "cohort": cohort,
                            "company": company_name,
                            "role": title,
                            "location": loc,
                            "key_focus": "Discovered via Lever automated crawl",
                            "url": j.get("hostedUrl"),
                            "salary": salary,
                            "posted_at": parse_posted_date(j.get("createdAt"))
                        })
    except Exception as e:
        print(f"Error checking Lever {board} ({company_name}): {e}")
    return leads

def check_workday_jobs(board, company_name, cohort, search_criteria, config=None):
    leads = []
    if not board or "|" not in board:
        print(f"Error checking Workday {company_name}: invalid board parameter format. Expected 'host|tenant|site'.")
        return leads
        
    parts = board.split("|")
    if len(parts) < 3:
        print(f"Error checking Workday {company_name}: invalid board parameters {parts}")
        return leads
        
    host, tenant, site = parts[0], parts[1], parts[2]
    url = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    
    keywords = search_criteria.get("custom_keywords", ["Product Manager"])
    seen_paths = set()
    
    for kw in keywords[:3]:
        payload = {
            "appliedFacets": {},
            "limit": 50,
            "offset": 0,
            "searchText": kw
        }
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=12)
            if r.status_code == 200:
                data = r.json()
                job_postings = data.get("jobPostings", [])
                for job in job_postings:
                    title = job.get("title", "")
                    external_path = job.get("externalPath", "")
                    loc = job.get("locationsText", "")
                    
                    if external_path and external_path not in seen_paths:
                        seen_paths.add(external_path)
                        if matches_criteria(title, [loc], search_criteria, company_name, config):
                            job_url = f"https://{host}/en-US/{site}{external_path}"
                            
                            salary = "N/A"
                            posted_at = ""
                            try:
                                detail_url = f"https://{host}/wday/cxs/{tenant}/{site}{external_path}"
                                r_det = requests.get(detail_url, headers={"User-Agent": headers["User-Agent"], "Accept": "application/json"}, timeout=8)
                                if r_det.status_code == 200:
                                    det_data = r_det.json()
                                    info = det_data.get("jobPostingInfo", {})
                                    posted_at = parse_posted_date(info.get("startDate"))
                                    desc = info.get("jobDescription", "")
                                    if desc:
                                        salary = extract_salary(desc) or "N/A"
                            except Exception as e_det:
                                print(f"Error fetching Workday details/salary for {title}: {e_det}")
                                
                            leads.append({
                                "cohort": cohort,
                                "company": company_name,
                                "role": title,
                                "location": loc,
                                "key_focus": "Discovered via Workday automated API sync",
                                "url": job_url,
                                "salary": salary,
                                "posted_at": posted_at
                            })
        except Exception as e:
            print(f"Error checking Workday for {company_name} on '{kw}': {e}")
            
    return leads

def check_tiktok_jobs(company_name, cohort, search_criteria, config=None):
    url = "https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts"
    leads = []
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://lifeattiktok.com",
        "Referer": "https://lifeattiktok.com/",
        "website-path": "tiktok"
    }
    
    keywords = search_criteria.get("custom_keywords", ["Product Manager"])
    seen_ids = set()
    
    for kw in keywords[:3]:
        payload = {
            "keyword": kw,
            "limit": 100,
            "offset": 0
        }
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=12)
            if r.status_code == 200:
                data = r.json()
                job_post_list = data.get("data", {}).get("job_post_list", []) or []
                for p in job_post_list:
                    title = p.get("title", "")
                    pos_id = p.get("id", "")
                    
                    if pos_id and pos_id not in seen_ids:
                        seen_ids.add(pos_id)
                        
                        city_info = p.get("city_info", {})
                        city_name = city_info.get("en_name") if city_info else None
                        parent_name = city_info.get("parent", {}).get("en_name") if city_info and city_info.get("parent") else None
                        loc_str = f"{city_name}, {parent_name}" if (city_name and parent_name) else (city_name or "Remote / Various")
                        
                        if matches_criteria(title, [loc_str], search_criteria, company_name, config):
                            job_url = f"https://careers.tiktok.com/position/{pos_id}"
                            
                            desc = p.get("description", "") or ""
                            req = p.get("requirement", "") or ""
                            combined = desc + "\n" + req
                            salary = "N/A"
                            if combined.strip():
                                salary = extract_salary(combined) or "N/A"
                                
                            leads.append({
                                "cohort": cohort,
                                "company": company_name,
                                "role": title,
                                "location": loc_str,
                                "key_focus": "Discovered via TikTok automated API sync",
                                "url": job_url,
                                "salary": salary,
                                "posted_at": parse_posted_date(p.get("publish_time") or p.get("create_time"))
                            })
        except Exception as e:
            print(f"Error checking TikTok for '{kw}': {e}")
            
    return leads

def check_google_jobs(company_name, cohort, search_criteria, config=None):
    import urllib.parse
    import time
    leads = []
    
    if config is None:
        config = load_config()
        
    google_co = next((c for c in config.get("companies", []) if c.get("name", "").lower() == "google"), None)
    google_levels = google_co.get("levels") if google_co else None
    if google_levels is None:
        google_levels = ["Product Manager I", "Product Manager II", "Senior", "Group", "Director", "Senior Director", "Vice President"]
        
    keywords = search_criteria.get("custom_keywords", ["Product Manager"])
    
    # Build unique search queries
    queries = []
    for kw in keywords:
        for lvl in google_levels:
            lvl_lower = lvl.lower().strip()
            if lvl_lower in ["product manager i", "product manager ii"]:
                queries.append(kw)
            elif lvl_lower == "senior":
                queries.append(f"Senior {kw}")
            elif lvl_lower == "group":
                queries.append(f"Group {kw}")
            elif lvl_lower == "director":
                queries.append(f"Director {kw}")
            elif lvl_lower == "senior director":
                queries.append(f"Senior Director {kw}")
            elif lvl_lower == "vice president":
                queries.append(f"Vice President {kw}")
                
    # Deduplicate queries while preserving order
    seen_queries = set()
    unique_queries = []
    for q in queries:
        q_norm = q.lower().strip()
        if q_norm not in seen_queries:
            seen_queries.add(q_norm)
            unique_queries.append(q)
            
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    seen_job_ids = set()
    
    for query_term in unique_queries:
        # We query for New York, NY, USA as location to avoid global result dilution
        url = f"https://www.google.com/about/careers/applications/jobs/results?q={urllib.parse.quote(query_term)}&location=New%20York%2C%20NY%2C%20USA"
        try:
            r = requests.get(url, headers=headers, timeout=12)
            if r.status_code != 200:
                print(f"  Google Careers: failed to fetch query '{query_term}', status {r.status_code}")
                continue
                
            text_content = r.text  # Cache string to prevent loop decoding overhead
            idx = text_content.find("key: 'ds:1'")
            if idx == -1:
                idx = text_content.find('key: "ds:1"')
                
            if idx != -1:
                data_idx = text_content.find("data:", idx)
                if data_idx != -1:
                     start_array = text_content.find("[", data_idx)
                     if start_array != -1:
                        bracket_count = 0
                        end_array = -1
                        total_len = len(text_content)
                        
                        for i in range(start_array, total_len):
                            char = text_content[i]
                            if char == '[':
                                bracket_count += 1
                            elif char == ']':
                                bracket_count -= 1
                                if bracket_count == 0:
                                    end_array = i + 1
                                    break
                                    
                        if end_array != -1:
                            json_str = text_content[start_array:end_array]
                            data = json.loads(json_str)
                            jobs_list = data[0] if data and len(data) > 0 else []
                            
                            for job in jobs_list:
                                job_id = job[0]
                                if job_id in seen_job_ids:
                                    continue
                                    
                                title = job[1]
                                locs = [loc[0] for loc in job[9]] if len(job) > 9 and job[9] else []
                                
                                if matches_criteria(title, locs, search_criteria, company_name, config):
                                    seen_job_ids.add(job_id)
                                    job_url = f"https://www.google.com/about/careers/applications/jobs/results/{job_id}"
                                    g_posted = parse_posted_date(job[12][0]) if (len(job) > 12 and isinstance(job[12], list) and job[12]) else ""
                                    leads.append({
                                        "cohort": cohort,
                                        "company": company_name,
                                        "role": title,
                                        "location": ", ".join(locs),
                                        "key_focus": f"Google Careers HTML crawl ({query_term})",
                                        "url": job_url,
                                        "salary": "N/A",
                                        "posted_at": g_posted
                                    })
            time.sleep(0.5)
        except Exception as e:
            print(f"  Error checking Google Careers for '{query_term}': {e}")
            
    return leads


def check_microsoft_jobs(company_name, cohort, search_criteria, config=None):
    """
    Query Microsoft's Eightfold PCSX career API to find PM roles.
    Steps: 1) Get CSRF token from landing page, 2) Paginate GET /api/pcsx/search,
    3) Fetch position_details for salary, 4) Return leads with individual job URLs.
    """
    import time as _time
    leads = []
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    }
    session = requests.Session()
    
    try:
        # Step 1: Get CSRF token from landing page
        landing_url = "https://apply.careers.microsoft.com/careers?query=product+manager&start=0&location=New+York%2C++NY%2C++United+States&sort_by=relevance&filter_distance=160&filter_include_remote=1"
        resp = session.get(landing_url, headers=headers, timeout=15)
        csrf_match = re.search(r'name="_csrf"\s+content="([^"]+)"', resp.text)
        csrf_token = csrf_match.group(1) if csrf_match else ""
        
        api_headers = {
            "User-Agent": headers["User-Agent"],
            "Accept": "application/json",
            "X-CSRF-Token": csrf_token,
            "Referer": landing_url,
        }
        
        # Step 2: Paginate through search results
        search_url = "https://apply.careers.microsoft.com/api/pcsx/search"
        all_positions = []
        start = 0
        page_size = 10
        
        while True:
            params = {
                "domain": "microsoft.com",
                "query": "product manager",
                "location": "New York, NY, United States",
                "start": start,
                "num": page_size,
                "sort_by": "relevance",
                "filter_distance": 160,
                "filter_include_remote": 1,
            }
            
            resp2 = session.get(search_url, params=params, headers=api_headers, timeout=15)
            if resp2.status_code != 200:
                print(f"  Microsoft API error at start={start}: {resp2.status_code}")
                break
            
            data = resp2.json()
            positions = data.get('data', {}).get('positions', [])
            total = data.get('data', {}).get('count', 0)
            
            if not positions:
                break
            
            all_positions.extend(positions)
            start += page_size
            if start >= total:
                break
            _time.sleep(0.3)
        
        print(f"  Microsoft: fetched {len(all_positions)}/{total if 'total' in dir() else '?'} total search results")
        
        # Step 3: Filter for PM roles and build leads with salary
        for pos in all_positions:
            title = pos.get('name', '')
            pid = pos.get('id', '')
            locations = pos.get('locations', [])
            loc_str = '; '.join(locations) if locations else 'N/A'
            
            # Filter using criteria matcher
            if not matches_criteria(title, locations, search_criteria, company_name, config):
                continue
            
            job_url = f"https://apply.careers.microsoft.com/careers/job/{pid}"
            
            # Fetch salary and postedTs from position details
            salary = 'N/A'
            posted_at = parse_posted_date(pos.get('t_create') or pos.get('postedTs'))
            try:
                detail_url = f"https://apply.careers.microsoft.com/api/pcsx/position_details?domain=microsoft.com&position_id={pid}"
                resp3 = session.get(detail_url, headers=api_headers, timeout=10)
                if resp3.status_code == 200:
                    d_data = resp3.json().get('data', {})
                    if not posted_at:
                        posted_at = parse_posted_date(d_data.get('postedTs') or d_data.get('creationTs'))
                    desc = d_data.get('jobDescription', '')
                    salary_match = re.search(r'\$[\d,]+\s*[-\u2013to]+\s*\$[\d,]+(?:\s*(?:per\s+)?(?:year|annually|USD))?', desc)
                    if salary_match:
                        salary = salary_match.group(0)
                    elif not salary:
                        salary = extract_salary(desc)
            except Exception:
                pass
            _time.sleep(0.2)
            
            leads.append({
                "cohort": cohort,
                "company": company_name,
                "role": title,
                "location": loc_str,
                "key_focus": "Microsoft PCSX API",
                "url": job_url,
                "salary": salary,
                "posted_at": posted_at,
            })
    except Exception as e:
        print(f"Error checking Microsoft: {e}")
    return leads

def check_apple_jobs(company_name, cohort, search_criteria, config=None):
    leads = []
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    # Get query terms from settings, default to "Product Manager"
    keywords = search_criteria.get("custom_keywords", ["Product Manager"])
    query_term = keywords[0] if keywords else "Product Manager"
    query_quoted = urllib.parse.quote(query_term)
    
    # Fetch NY State search pages 1-3 (relevance & newest) and general search pages 1-2
    # Apple's location=new-york-state985 filter matches any role where NY is a primary OR secondary location
    urls_to_crawl = [
        f"https://jobs.apple.com/en-us/search?search={query_quoted}&sort=relevance&location=new-york-state985&page=1",
        f"https://jobs.apple.com/en-us/search?search={query_quoted}&sort=relevance&location=new-york-state985&page=2",
        f"https://jobs.apple.com/en-us/search?search={query_quoted}&sort=relevance&location=new-york-state985&page=3",
        f"https://jobs.apple.com/en-us/search?search={query_quoted}&sort=newest&location=new-york-state985&page=1",
        f"https://jobs.apple.com/en-us/search?search={query_quoted}&sort=relevance&page=1",
        f"https://jobs.apple.com/en-us/search?search={query_quoted}&sort=relevance&page=2"
    ]
    
    seen_req_keys = set()
    
    for url in urls_to_crawl:
        try:
            r = requests.get(url, headers=headers, timeout=12)
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')
                items = soup.find_all('li', class_='rc-accordion-item')
                for li in items:
                    a_tag = li.find('a', class_='link-inline')
                    if a_tag:
                        title = a_tag.get_text(strip=True)
                        href = a_tag['href']
                        job_url = f"https://jobs.apple.com{href}"
                        req_key = normalize_job_url(job_url)
                        
                        if req_key not in seen_req_keys:
                            # Extract location
                            loc_div = li.find(class_='job-title-location')
                            location = "N/A"
                            if loc_div:
                                spans = loc_div.find_all('span')
                                location = " ".join(s.get_text(strip=True) for s in spans if 'a11y' not in s.get('class', []))
                            
                            # Match criteria
                            if matches_criteria(title, [location], search_criteria, company_name, config):
                                seen_req_keys.add(req_key)
                                
                                # Fetch salary, posting date, and full JD from React hydration data
                                salary = "N/A"
                                full_jd_text = ""
                                posted_at = ""
                                try:
                                    r_det = requests.get(job_url, headers=headers, timeout=10)
                                    if r_det.status_code == 200:
                                        match_hyd = re.search(r'window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\);', r_det.text)
                                        if match_hyd:
                                            escaped_json = match_hyd.group(1)
                                            raw_json_str = json.loads(f'"{escaped_json}"')
                                            hyd_data = json.loads(raw_json_str)
                                            jobs_data = hyd_data.get("loaderData", {}).get("jobDetails", {}).get("jobsData", {})
                                            posted_at = parse_posted_date(jobs_data.get("postingDateMeta") or jobs_data.get("postDateInGMT") or jobs_data.get("postingDate"))
                                            
                                            jd_sections = []
                                            if jobs_data.get("jobSummary"):
                                                jd_sections.append(f"Summary:\n{jobs_data['jobSummary']}")
                                            if jobs_data.get("description"):
                                                jd_sections.append(f"Description:\n{jobs_data['description']}")
                                            if jobs_data.get("minimumQualifications"):
                                                jd_sections.append(f"Minimum Qualifications:\n{jobs_data['minimumQualifications']}")
                                            if jobs_data.get("preferredQualifications"):
                                                jd_sections.append(f"Preferred Qualifications:\n{jobs_data['preferredQualifications']}")
                                            
                                            text_chunks = list(jd_sections)
                                            for foot in jobs_data.get("postingFooters", []):
                                                for loc_key, loc_list in foot.get("localizations", {}).items():
                                                    for loc_item in loc_list:
                                                        c_txt = loc_item.get("content", "")
                                                        if c_txt:
                                                            text_chunks.append(c_txt)
                                            
                                            full_desc = " ".join(text_chunks)
                                            salary = extract_salary(full_desc) or "N/A"
                                            full_jd_text = "\n\n".join(jd_sections)
                                except Exception as e:
                                    print(f"Error fetching Apple salary/JD for {title}: {e}")
                                    
                                leads.append({
                                    "cohort": cohort,
                                    "company": company_name,
                                    "role": title,
                                    "location": location,
                                    "key_focus": full_jd_text if full_jd_text else "Apple Careers HTML crawl",
                                    "url": job_url,
                                    "salary": salary,
                                    "posted_at": posted_at
                                })
        except Exception as e:
            print(f"Error crawling Apple URL {url}: {e}")
            
    return leads

def check_amazon_jobs(company_name, cohort, search_criteria, config=None):
    leads = []
    url = "https://www.amazon.jobs/en/search.json"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    if config is None:
        config = load_config()
        
    amazon_co = next((c for c in config.get("companies", []) if c.get("name", "").lower() == "amazon"), None)
    amazon_levels = amazon_co.get("levels") if amazon_co else None
    if amazon_levels is None:
        amazon_levels = ["Standard", "Senior", "Staff", "Principal", "Director", "Senior Director", "Vice President", "Chief Product Officer"]
        
    queries = []
    for lvl in amazon_levels:
        lvl_lower = lvl.lower().strip()
        if lvl_lower == "standard":
            queries.append("product manager")
        elif lvl_lower == "senior":
            queries.append("senior product manager")
        elif lvl_lower == "principal":
            queries.append("principal product manager")
        elif lvl_lower == "staff":
            queries.append("staff product manager")
        elif lvl_lower == "director":
            queries.append("director product manager")
        elif lvl_lower == "vice president":
            queries.append("vp product manager")
            
    seen_queries = set()
    unique_queries = []
    for q in queries:
        if q not in seen_queries:
            seen_queries.add(q)
            unique_queries.append(q)
            
    if not unique_queries:
        unique_queries = ["product manager"]
        
    seen_job_ids = set()
    
    for base_query in unique_queries:
        params = {
            "offset": 0,
            "result_limit": 100,
            "sort": "relevant",
            "loc_group_id": "new-york-metro-area",
            "base_query": base_query
        }
        try:
            r = requests.get(url, params=params, headers=headers, timeout=12)
            if r.status_code == 200:
                jobs = r.json().get("jobs", [])
                for j in jobs:
                    job_id = j.get("id")
                    if job_id in seen_job_ids:
                        continue
                    seen_job_ids.add(job_id)
                    
                    title = j.get("title", "")
                    loc = j.get("normalized_location", "")
                    
                    # Verify location and level/keywords matching
                    if matches_criteria(title, [loc], search_criteria, company_name, config):
                        job_url = f"https://www.amazon.jobs{j.get('job_path')}"
                        leads.append({
                            "cohort": cohort,
                            "company": company_name,
                            "role": title,
                            "location": loc,
                            "key_focus": f"Amazon Public Search API ({base_query})",
                            "url": job_url,
                            "posted_at": parse_posted_date(j.get("posted_date"))
                        })
        except Exception as e:
            print(f"Error checking Amazon query '{base_query}': {e}")
            
    return leads

def check_meta_jobs(company_name, cohort, search_criteria, config=None):
    import time
    leads = []
    session = requests.Session()
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1"
    }
    
    try:
        # Step 1: GET jobsearch to fetch cookies and extract LSD token
        landing_url = "https://www.metacareers.com/jobsearch?q=product%20manager&offices[0]=New%20York%2C%20NY"
        r = session.get(landing_url, headers=headers, timeout=12)
        if r.status_code != 200:
            print(f"Meta Careers GET request failed: {r.status_code}")
            return leads
            
        lsd_match = re.search(r'"LSD"\s*,\s*\[\],\s*\{"token"\s*:\s*["\']([^"\']+)["\']', r.text)
        if not lsd_match:
            lsd_match = re.search(r'"lsd"\s*:\s*["\']([^"\']+)["\']', r.text)
        
        if not lsd_match:
            print("Meta Scraper: LSD token not found.")
            return leads
            
        lsd_token = lsd_match.group(1)
        
        # Step 2: POST to GraphQL
        api_url = "https://www.metacareers.com/api/graphql/"
        api_headers = {
            "User-Agent": headers["User-Agent"],
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded",
            "Sec-Ch-Ua": headers["Sec-Ch-Ua"],
            "Sec-Ch-Ua-Mobile": headers["Sec-Ch-Ua-Mobile"],
            "Sec-Ch-Ua-Platform": headers["Sec-Ch-Ua-Platform"],
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "Origin": "https://www.metacareers.com",
            "Referer": landing_url,
            "X-FB-LSD": lsd_token
        }
        
        payload = {
            "lsd": lsd_token,
            "doc_id": "26703205452636175",
            "variables": json.dumps({
                "search_input": {
                    "q": "product manager",
                    "offices": ["New York, NY"],
                    "divisions": [],
                    "roles": [],
                    "leadership_levels": [],
                    "saved_jobs": [],
                    "saved_searches": [],
                    "sub_teams": [],
                    "teams": [],
                    "is_leadership": False,
                    "is_remote_only": False,
                    "sort_by_new": False,
                    "page": 1
                }
            })
        }
        
        r2 = session.post(api_url, data=payload, headers=api_headers, timeout=12)
        if r2.status_code == 200:
            data = r2.json()
            search_res = data.get("data", {}).get("job_search_with_featured_jobs_v2", {})
            all_jobs = search_res.get("all_jobs", [])
            featured_jobs = search_res.get("featured_jobs", [])
            total_jobs = all_jobs + featured_jobs
            
            seen_ids = set()
            for j in total_jobs:
                jid = j.get("id")
                if not jid or jid in seen_ids:
                    continue
                seen_ids.add(jid)
                
                title = j.get("title", "")
                locations = j.get("locations", [])
                
                if matches_criteria(title, locations, search_criteria, company_name, config):
                    job_url = f"https://www.metacareers.com/jobs/{jid}/"
                    
                    # Fetch salary from details page
                    salary = "N/A"
                    try:
                        detail_headers = headers.copy()
                        detail_headers["Referer"] = landing_url
                        r3 = session.get(job_url, headers=detail_headers, timeout=8)
                        if r3.status_code == 200:
                            min_match = re.search(r'"compensation_amount_minimum"\s*:\s*["\']([^"\']+)["\']', r3.text)
                            max_match = re.search(r'"compensation_amount_maximum"\s*:\s*["\']([^"\']+)["\']', r3.text)
                            if min_match and max_match:
                                min_val = min_match.group(1).replace('\\/', '/')
                                max_val = max_match.group(1).replace('\\/', '/')
                                salary = f"{min_val} - {max_val}"
                    except Exception as ex:
                        print(f"Error fetching Meta salary details for job {jid}: {ex}")
                    time.sleep(0.2)
                    
                    leads.append({
                        "cohort": cohort,
                        "company": company_name,
                        "role": title,
                        "location": ", ".join(locations),
                        "key_focus": "Meta GraphQL API",
                        "url": job_url,
                        "salary": salary
                    })
    except Exception as e:
        print(f"Error checking Meta: {e}")
    return leads

def check_nvidia_jobs(board, company_name, cohort, search_criteria, config=None):
    leads = []
    
    base_url = "https://jobs.nvidia.com/careers"
    api_url = "https://jobs.nvidia.com/api/pcsx/search"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        session = requests.Session()
        r = session.get(base_url, headers=headers, timeout=12)
        if r.status_code != 200:
            return leads
            
        soup = BeautifulSoup(r.text, 'html.parser')
        csrf_tag = soup.find('meta', attrs={'name': '_csrf'})
        csrf_token = csrf_tag.get('content') if csrf_tag else None
        
        if not csrf_token:
            csrf_token = r.headers.get("X-CSRF-Token")
            
        if not csrf_token:
            print("Nvidia Scraper: CSRF token not found.")
            return leads
            
        get_headers = {
            "User-Agent": headers["User-Agent"],
            "Accept": "application/json",
            "X-CSRF-Token": csrf_token,
            "Referer": base_url
        }
        
        keywords = search_criteria.get("custom_keywords", ["Product Manager"])
        query_term = keywords[0] if keywords else "Product Manager"
        
        locs = search_criteria.get("locations", ["New York", "NYC", "Remote"])
        seen_pos_ids = set()
        
        for loc in locs:
            params = {
                "domain": "nvidia.com",
                "query": query_term,
                "location": loc,
                "limit": 100,
                "start": 0
            }
            
            r_api = session.get(api_url, params=params, headers=get_headers, timeout=12)
            if r_api.status_code == 200:
                data = r_api.json()
                inner_data = data.get("data", {})
                positions = inner_data.get("positions", [])
                for pos in positions:
                    title = pos.get("name")
                    pos_id = pos.get("id")
                    locations = pos.get("locations", [])
                    
                    if title and pos_id and pos_id not in seen_pos_ids:
                        if matches_criteria(title, locations, search_criteria, company_name, config):
                            seen_pos_ids.add(pos_id)
                            job_url = f"https://jobs.nvidia.com/careers?pid={pos_id}"
                            
                            # Fetch salary and postedTs from Nvidia Eightfold API details
                            salary = "N/A"
                            posted_at = parse_posted_date(pos.get("t_create") or pos.get("postedTs"))
                            try:
                                detail_url = f"https://jobs.nvidia.com/api/pcsx/position_details?domain=nvidia.com&position_id={pos_id}"
                                r_det = session.get(detail_url, headers=get_headers, timeout=10)
                                if r_det.status_code == 200:
                                    nv_data = r_det.json().get("data", {})
                                    if not posted_at:
                                        posted_at = parse_posted_date(nv_data.get("postedTs") or nv_data.get("creationTs"))
                                    desc = nv_data.get("jobDescription", "")
                                    salary = extract_salary(desc) or "N/A"
                            except Exception as e:
                                print(f"Error fetching Nvidia salary for {title}: {e}")
                                
                            leads.append({
                                "cohort": cohort,
                                "company": company_name,
                                "role": title,
                                "location": ", ".join(locations),
                                "key_focus": "Nvidia Eightfold API crawl",
                                "url": job_url,
                                "salary": salary,
                                "posted_at": posted_at
                            })
            else:
                print(f"Nvidia Scraper API request failed for location '{loc}': {r_api.status_code}")
    except Exception as e:
        print(f"Error checking Nvidia: {e}")
        
    return leads

def check_netflix_jobs(company_name, cohort, search_criteria, config=None):
    import html
    leads = []
    
    # Get first query term from settings, default to "Product Manager"
    keywords = search_criteria.get("custom_keywords", ["Product Manager"])
    query_term = keywords[0] if keywords else "Product Manager"
    
    # Query Netflix Careers (Phenom) pre-filtered for NYC/US
    loc_query = "New York, NY, United States"
    url = f"https://explore.jobs.netflix.net/careers?query={urllib.parse.quote(query_term)}&location={urllib.parse.quote(loc_query)}&domain=netflix.com&sort_by=relevance"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        r = requests.get(url, headers=headers, timeout=12)
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, 'html.parser')
            code_tag = soup.find('code', id='smartApplyData')
            if code_tag:
                decoded = html.unescape(code_tag.get_text())
                config_loaded = json.loads(decoded)
                positions = config_loaded.get("positions", [])
                for pos in positions:
                    title = pos.get("name") or pos.get("jobTitle", "")
                    pos_id = pos.get("id") or pos.get("postingId")
                    locs_list = pos.get("locations", [])
                    
                    if pos_id and title:
                        if matches_criteria(title, locs_list, search_criteria, company_name, config):
                            job_url = f"https://explore.jobs.netflix.net/careers?pid={pos_id}"
                            
                            # Fetch salary and datePosted from JSON-LD (fallback to smartApplyData t_create)
                            salary = "N/A"
                            posted_at = parse_posted_date(pos.get("t_create") or pos.get("postedTs"))
                            try:
                                r_det = requests.get(job_url, headers=headers, timeout=10)
                                if r_det.status_code == 200:
                                    det_soup = BeautifulSoup(r_det.text, 'html.parser')
                                    ld_scripts = det_soup.find_all('script', type='application/ld+json')
                                    for s in ld_scripts:
                                        if s.string:
                                            try:
                                                ld_data = json.loads(s.string)
                                                if ld_data.get("@type") == "JobPosting":
                                                    ld_dt = parse_posted_date(ld_data.get("datePosted"))
                                                    if ld_dt:
                                                        posted_at = ld_dt
                                                    desc = ld_data.get("description", "")
                                                    salary = extract_salary(desc) or "N/A"
                                                    break
                                            except:
                                                pass
                            except Exception as e:
                                print(f"Error fetching Netflix salary for {title}: {e}")
                                
                            leads.append({
                                "cohort": cohort,
                                "company": company_name,
                                "role": title,
                                "location": ", ".join(locs_list),
                                "key_focus": "Netflix Phenom Portal crawl",
                                "url": job_url,
                                "salary": salary,
                                "posted_at": posted_at
                            })
    except Exception as e:
        print(f"Error checking Netflix: {e}")
    return leads

# Fallback Generic DuckDuckGo Search Crawler
# Fallback Generic DuckDuckGo Search Crawler
def detect_ats_from_portal(portal_url, company_name=""):
    """
    Returns (platform, board_id) if detected, otherwise (None, None)
    """
    if not portal_url:
        return None, None
        
    try:
        parsed = urllib.parse.urlparse(portal_url)
        netloc = parsed.netloc.lower()
        path = parsed.path
        
        # 1. Simple URL pattern matches first
        if "greenhouse.io" in netloc:
            queries = urllib.parse.parse_qs(parsed.query)
            if "for" in queries:
                return "greenhouse", queries["for"][0]
            parts = [p for p in path.split("/") if p]
            if parts:
                return "greenhouse", parts[-1]
                
        if "lever.co" in netloc:
            parts = [p for p in path.split("/") if p]
            if parts:
                return "lever", parts[0]
                
        if "ashbyhq.com" in netloc:
            parts = [p for p in path.split("/") if p]
            if parts:
                return "ashby", parts[0]
                
        if "workable.com" in netloc:
            parts = [p for p in path.split("/") if p]
            if parts:
                return "workable", parts[0]
                
        if "myworkdayjobs.com" in netloc:
            tenant = netloc.split(".")[0]
            parts = [p for p in path.split("/") if p]
            site = "external"
            if len(parts) >= 2:
                if "-" in parts[0] or parts[0].lower() in ["en", "fr", "de", "es", "zh", "ja"]:
                    site = parts[1]
                else:
                    site = parts[0]
            elif len(parts) == 1:
                site = parts[0]
            return "workday", f"{netloc}|{tenant}|{site}"

        # 2. Custom domain checks via GET request
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        
        r = requests.get(portal_url, headers=headers, timeout=10, allow_redirects=True)
        final_url = r.url
        final_parsed = urllib.parse.urlparse(final_url)
        final_netloc = final_parsed.netloc.lower()
        
        if any(x in final_netloc for x in ["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "myworkdayjobs.com"]):
            return detect_ats_from_portal(final_url, company_name)
            
        html_text = r.text
        
        lever_match = re.search(r'jobs\.lever\.co/([^/?"\'\s>]+)', html_text)
        if lever_match:
            return "lever", lever_match.group(1)
            
        grnh_match = re.search(r'boards\.greenhouse\.io/embed/job_board\?for=([^&"\'\s>]+)', html_text)
        if grnh_match:
            return "greenhouse", grnh_match.group(1)
        grnh_match2 = re.search(r'boards\.greenhouse\.io/([^/?"\'\s>]+)', html_text)
        if grnh_match2 and grnh_match2.group(1) != "embed":
            return "greenhouse", grnh_match2.group(1)
            
        ashby_match = re.search(r'jobs\.ashbyhq\.com/([^/?"\'\s>]+)', html_text)
        if ashby_match:
            return "ashby", ashby_match.group(1)
            
        workable_match = re.search(r'apply\.workable\.com/([^/?"\'\s>]+)', html_text)
        if workable_match:
            return "workable", workable_match.group(1)
            
        workday_match = re.search(r'([^/?"\'\s>]+)\.myworkdayjobs\.com/([^/?"\'\s>]+)', html_text)
        if workday_match:
            tenant_sub = workday_match.group(1)
            site_sub = workday_match.group(2)
            site_parts = [p for p in site_sub.split("/") if p]
            site_val = site_parts[0] if site_parts else "external"
            tenant_val = tenant_sub.split(".")[0]
            host_val = f"{tenant_sub}.myworkdayjobs.com"
            return "workday", f"{host_val}|{tenant_val}|{site_val}"

        # 3. CNAME lookup
        try:
            canonical_name, aliases, ip_list = socket.gethostbyname_ex(netloc)
            for host_name in [canonical_name] + aliases:
                host_lower = host_name.lower()
                slug = company_name.lower().replace(" ", "") if company_name else "careers"
                if "greenhouse.io" in host_lower:
                    return "greenhouse", slug
                if "lever.co" in host_lower:
                    return "lever", slug
                if "ashbyhq.com" in host_lower:
                    return "ashby", slug
                if "workable.com" in host_lower:
                    return "workable", slug
                if "myworkdayjobs.com" in host_lower:
                    tenant = host_lower.split(".")[0]
                    return "workday", f"{host_lower}|{tenant}|external"
        except Exception:
            pass

        # 4. Probing standard ATS APIs with candidate slugs as generic fallback
        slugs = []
        s1 = re.sub(r'[^a-z0-9]', '', company_name.lower())
        if s1:
            slugs.append(s1)
        s2 = re.sub(r'[^a-z0-9-]', '', company_name.lower().replace(' ', '-'))
        if s2 and s2 != s1:
            slugs.append(s2)
        
        domain_slug = None
        if portal_url:
            try:
                p_url = urllib.parse.urlparse(portal_url)
                parts = p_url.netloc.split('.')
                if len(parts) >= 2:
                    domain_slug = parts[-2].lower()
            except Exception:
                pass
        if domain_slug and domain_slug not in slugs:
            slugs.append(domain_slug)
            if domain_slug.endswith("hq") and len(domain_slug) > 2:
                s3 = domain_slug[:-2]
                if s3 not in slugs:
                    slugs.append(s3)
                    
        for slug in slugs:
            # Probe Greenhouse
            try:
                probe_url = f"https://api.greenhouse.io/v1/boards/{slug}/jobs"
                probe_r = requests.get(probe_url, timeout=5)
                if probe_r.status_code == 200:
                    data = probe_r.json()
                    if isinstance(data, dict) and "jobs" in data:
                        return "greenhouse", slug
            except Exception:
                pass
                
            # Probe Lever
            try:
                probe_url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
                probe_r = requests.get(probe_url, timeout=5)
                if probe_r.status_code == 200:
                    data = probe_r.json()
                    if isinstance(data, list):
                        return "lever", slug
            except Exception:
                pass
                
            # Probe Ashby
            try:
                probe_url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
                probe_r = requests.get(probe_url, timeout=5)
                if probe_r.status_code == 200:
                    data = probe_r.json()
                    if isinstance(data, dict) and "jobs" in data:
                        return "ashby", slug
            except Exception:
                pass
                
            # Probe Workable
            try:
                probe_url = f"https://apply.workable.com/api/v1/accounts/{slug}/jobs"
                probe_r = requests.post(probe_url, json={}, timeout=5)
                if probe_r.status_code == 200:
                    data = probe_r.json()
                    if isinstance(data, dict) and "results" in data:
                        return "workable", slug
            except Exception:
                pass

            # Probe Workday
            try:
                for site in ["external", "External"]:
                    probe_url = f"https://{slug}.myworkdayjobs.com/wday/cxs/{slug}/{site}/jobs"
                    probe_r = requests.post(probe_url, json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""}, headers={"User-Agent": headers["User-Agent"], "Accept": "application/json", "Content-Type": "application/json"}, timeout=5)
                    if probe_r.status_code == 200:
                        data = probe_r.json()
                        if isinstance(data, dict) and "jobPostings" in data:
                            return "workday", f"{slug}.myworkdayjobs.com|{slug}|{site}"
            except Exception:
                pass

    except Exception as e:
        print(f"Error detecting ATS for {portal_url}: {e}")
        
    return None, None

def check_company_jobs_ddg(company_name, cohort, search_criteria, config=None):
    leads = []
    
    # 1. Attempt dynamic ATS detection from portal URL
    portal_url = None
    if config:
        for co in config.get("companies", []):
            if co.get("name", "").lower() == company_name.lower():
                portal_url = co.get("portal_url", "")
                break
                
    if portal_url:
        print(f"Attempting to auto-detect ATS for {company_name} from: {portal_url}...")
        platform, board_id = detect_ats_from_portal(portal_url, company_name)
        if platform and board_id:
            print(f" -> Auto-detected {platform} board '{board_id}' for {company_name}!")
            
            # Save the detected platform and board_id back to config.json
            if config:
                config_changed = False
                for co in config.get("companies", []):
                    if co.get("name", "").lower() == company_name.lower():
                        co["platform"] = platform
                        co["board_id"] = board_id
                        co["capability"] = "active_sync"
                        config_changed = True
                        break
                if config_changed:
                    print(f" -> Auto-updating config.json with detected {platform} settings...")
                    try:
                        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                            json.dump(config, f, indent=2)
                    except Exception as e:
                        print(f"Error saving auto-detected config settings: {e}")
            
            # Route to the appropriate sync crawler
            if platform == "greenhouse":
                return check_greenhouse_jobs(board_id, company_name, cohort, search_criteria, config)
            elif platform == "ashby":
                return check_ashby_jobs(board_id, company_name, cohort, search_criteria, config)
            elif platform == "workable":
                return check_workable_jobs(board_id, company_name, cohort, search_criteria, config)
            elif platform == "lever":
                return check_lever_jobs(board_id, company_name, cohort, search_criteria, config)
            elif platform == "workday":
                return check_workday_jobs(board_id, company_name, cohort, search_criteria, config)
        else:
            print(f" -> No standard ATS footprint detected for {company_name}. Using search fallback.")
            
    locs = search_criteria.get("locations", ["New York", "NYC", "Remote"])
    loc_clause = " OR ".join(f'"{loc}"' for loc in locs)
    
    portal_host = None
    if config:
        for co in config.get("companies", []):
            if co.get("name", "").lower() == company_name.lower():
                portal_url = co.get("portal_url", "")
                if portal_url:
                    try:
                        parsed = urllib.parse.urlparse(portal_url)
                        if parsed.netloc:
                            portal_host = parsed.netloc.lower()
                            if portal_host.startswith("www."):
                                portal_host = portal_host[4:]
                    except Exception:
                        pass
                break

    # Customize queries based on company
    if company_name.lower() == "meta":
        query = f'site:metacareers.com/jobs "Product Manager" ({loc_clause})'
    elif company_name.lower() == "tesla":
        query = f'site:tesla.com/careers "Product Manager" ({loc_clause})'
    elif portal_host and not any(x in portal_host for x in ["google.com", "microsoft.com", "amazon.jobs", "amazon.com", "netflix.com", "nvidia.com", "apple.com", "greenhouse.io", "ashbyhq.com", "workable.com"]):
        # Search the custom careers portal host AND standard boards
        query = f'"{company_name}" "Product Manager" ({loc_clause}) (site:{portal_host} OR site:lever.co OR site:greenhouse.io OR site:ashbyhq.com)'
    else:
        query = f'"{company_name}" "Product Manager" ({loc_clause}) site:lever.co OR site:greenhouse.io OR site:ashbyhq.com'
        
    try:
        urls = search_ddg(query)
        for url in urls:
            if not url or is_placeholder_url(url):
                continue
                
            # Filter URLs
            url_lower = url.lower()
            is_job_page = False
            if company_name.lower() == "meta" and ("/jobs/" in url_lower or "/v2/jobs/" in url_lower):
                is_job_page = True
            elif company_name.lower() == "tesla" and "/job/" in url_lower:
                is_job_page = True
            elif any(x in url_lower for x in ["/jobs/", "/job/", "/posting/", "/careers/", "/position/", "/positions/"]):
                is_job_page = True
            elif portal_host and portal_host in url_lower:
                if any(x in url_lower for x in ["search", "results", "category", "location", "jobs-results"]):
                    is_job_page = False
                else:
                    is_job_page = True
                
            if is_job_page:
                # Fetch page to read the title
                headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
                r = requests.get(url, headers=headers, timeout=6)
                if r.status_code == 200:
                    soup = BeautifulSoup(r.text, 'html.parser')
                    title_text = soup.title.string if soup.title else ""
                    if title_text:
                        title_clean = title_text.split(" - ")[0].split(" | ")[0].split(" at ")[0].strip()
                        
                        # Verify title matches criteria
                        if matches_criteria(title_clean, [title_text], search_criteria, company_name, config):
                            # Map location
                            loc_found = "New York, NY" if ("new york" in title_text.lower() or "nyc" in title_text.lower()) else "Remote / Various"
                            leads.append({
                                "cohort": cohort,
                                "company": company_name,
                                "role": title_clean,
                                "location": loc_found,
                                "key_focus": "DDG Indexed Crawler search",
                                "url": url
                            })
    except Exception as e:
        print(f"Error search-crawling {company_name}: {e}")
    return leads

def search_ddg_snippets(query):
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    for attempt in range(3):
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')
                snippets = []
                for a in soup.find_all('a', class_='result__snippet'):
                    snippets.append(a.get_text())
                if snippets:
                    return snippets
            elif r.status_code == 202:
                soup = BeautifulSoup(r.text, 'html.parser')
                meta_refresh = soup.find('meta', attrs={'http-equiv': 'refresh'})
                if meta_refresh:
                    content = meta_refresh.get('content', '')
                    if 'url=' in content:
                        refresh_url = content.split('url=')[-1]
                        if refresh_url.startswith('/'):
                            refresh_url = f"https://html.duckduckgo.com{refresh_url}"
                        url = refresh_url
                        continue
        except Exception as e:
            print(f"Error querying DDG for '{query}': {e}")
        import time
        time.sleep(1)
    return []

def fetch_company_details(name):
    print(f"Enriching details for: {name}")
    details = {
        "hq": "N/A",
        "founded": "N/A",
        "revenue": "N/A",
        "employees": "N/A",
        "domain": "N/A"
    }
    
    # Query: general profile
    snippets = search_ddg_snippets(f"{name} company profile headquarters founded year employees revenue")
    full_text = " ".join(snippets)
    
    # 1. Extract Founded Year
    founded_match = re.search(r'\bfounded\s+(?:in\s+)?([12][0-9]{3})\b', full_text, re.IGNORECASE)
    if not founded_match:
        founded_match = re.search(r'\bestablished\s+(?:in\s+)?([12][0-9]{3})\b', full_text, re.IGNORECASE)
    if not founded_match:
        years = re.findall(r'\b(19[789][0-9]|20[0-2][0-9])\b', full_text)
        if years:
            details["founded"] = years[0]
    else:
        details["founded"] = founded_match.group(1)
        
    # 2. Extract HQ Location
    hq_match = re.search(r'\bheadquartered\s+in\s+([^,\.\n]{2,30},?\s*[A-Z]{2})', full_text, re.IGNORECASE)
    if not hq_match:
        hq_match = re.search(r'\bheadquarters\s+(?:is\s+in|in|are\s+in)?\s*([^,\.\n]{2,30},?\s*[A-Z]{2})', full_text, re.IGNORECASE)
    if hq_match:
        details["hq"] = hq_match.group(1).strip()
    else:
        # Try a different query
        snippets_hq = search_ddg_snippets(f"{name} company headquarters location")
        text_hq = " ".join(snippets_hq)
        hq_match2 = re.search(r'\b(?:headquartered|headquarters)\s+(?:in|is\s+in|are\s+in|at)?\s*([^,\.\n]{2,30},?\s*[A-Za-z]{2,20})', text_hq, re.IGNORECASE)
        if hq_match2:
            details["hq"] = hq_match2.group(1).strip()
            
    # 3. Extract Employees
    emp_match = re.search(r'\b([0-9,]+(?:\s*\+)?)\s*employees\b', full_text, re.IGNORECASE)
    if not emp_match:
        emp_match = re.search(r'\bhas\s+(?:over|around|about|approximately)?\s*([0-9,k\+]+)\s*employees\b', full_text, re.IGNORECASE)
    if emp_match:
        details["employees"] = emp_match.group(1).strip()
    else:
        snippets_emp = search_ddg_snippets(f"{name} number of employees count")
        text_emp = " ".join(snippets_emp)
        emp_match2 = re.search(r'\b([0-9,k\+]{2,10})\s*employees\b', text_emp, re.IGNORECASE)
        if emp_match2:
            details["employees"] = emp_match2.group(1).strip()

    # 4. Extract Revenue
    rev_match = re.search(r'\b(\$[0-9\.]+(?:\s*[BMbm]illion|[BMbm]?)?)\s*(?:in\s+)?revenue\b', full_text, re.IGNORECASE)
    if not rev_match:
        rev_match = re.search(r'\bannual\s+revenue\s*(?:of|is)?\s*(\$[0-9\.]+(?:\s*[BMbm]illion|[BMbm]?)?)', full_text, re.IGNORECASE)
    if rev_match:
        details["revenue"] = rev_match.group(1).strip()
    else:
        snippets_rev = search_ddg_snippets(f"{name} annual revenue")
        text_rev = " ".join(snippets_rev)
        rev_match2 = re.search(r'(\$[0-9\.]+(?:\s*[BMbm]illion|[BMbm]?)?)', text_rev)
        if rev_match2:
            details["revenue"] = rev_match2.group(1).strip()

    # 5. Extract Domain
    if snippets:
        first_snip = snippets[0].lower()
        domain_match = re.search(rf'{name.lower()}\s+(?:is\s+a|is\s+an)\s+([^,\.]+)', first_snip)
        if domain_match:
            details["domain"] = domain_match.group(1).strip().capitalize()
        else:
            snippets_ind = search_ddg_snippets(f"{name} company industry domain")
            if snippets_ind:
                details["domain"] = snippets_ind[0][:80].strip() + "..."
                
    return details

def run_daily_scan(target_company=None):
    if target_company:
        print(f"Initiating single company job leads scan for '{target_company}'...")
    else:
        print("Initiating daily job leads scan...")
    config = load_config()
    search_criteria = config.get("search_criteria", {})
    companies = config.get("companies", [])
    
    # Auto-enrich company details if needed
    config_changed = False
    for co in companies:
        if target_company and co["name"].lower() != target_company.lower():
            continue
            
        if (not co.get("hq") or not co.get("founded") or 
            not co.get("revenue") or not co.get("employees") or 
            not co.get("domain")):
            
            print(f"Auto-enriching details for {co['name']}...")
            try:
                enriched = fetch_company_details(co["name"])
                # Update fields that are empty
                for field in ["hq", "founded", "revenue", "employees", "domain"]:
                    if not co.get(field):
                        co[field] = enriched[field]
                config_changed = True
            except Exception as e:
                print(f"Error enriching company details for {co['name']}: {e}")
            
    if config_changed:
        print("Saving enriched company details back to config.json...")
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
        except Exception as e:
            print(f"Error saving enriched config: {e}")
    
    import uuid

    conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=10000;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Read existing leads to prevent duplicates
    cursor.execute("SELECT id, company_name, title, url, status, archive_reason FROM jobs ORDER BY CASE WHEN status = 'Archived' THEN 0 ELSE 1 END ASC")
    existing_jobs = cursor.fetchall()
    existing_keys = {}
    for j in existing_jobs:
        key = job_identity_key(j["company_name"], j["title"], j["url"])
        existing_keys[key] = {
            "id": j["id"],
            "url": j["url"],
            "status": j["status"],
            "archive_reason": j["archive_reason"]
        }
            
    all_new_leads = []
    scanned_companies = set()
    crawled_keys = set()
    
    # Loop over all configured companies
    for co in companies:
        name = co["name"]
        if target_company and name.lower() != target_company.lower():
            continue
        platform = co["platform"]
        board_id = co["board_id"]
        cohort = co["cohort"]
        capability = co.get("capability", "active_sync")
        
        # Check if all levels are de-selected for this company
        if not co.get("levels"):
            print(f"Skipping {name} (no target levels selected)...")
            continue

        if capability == "portal_only":
            print(f"Skipping {name} (portal_only: manual check required)...")
            continue
            
        print(f"Scanning {name} using platform: {platform}...")
        co_leads = []
        
        try:
            if platform == "google":
                co_leads = check_google_jobs(name, cohort, search_criteria, config)
            elif platform == "microsoft":
                co_leads = check_microsoft_jobs(name, cohort, search_criteria, config)
            elif platform == "netflix":
                co_leads = check_netflix_jobs(name, cohort, search_criteria, config)
            elif platform == "apple":
                co_leads = check_apple_jobs(name, cohort, search_criteria, config)
            elif platform == "amazon":
                co_leads = check_amazon_jobs(name, cohort, search_criteria, config)
            elif platform == "meta":
                co_leads = check_meta_jobs(name, cohort, search_criteria, config)
            elif platform == "nvidia":
                co_leads = check_nvidia_jobs(board_id, name, cohort, search_criteria, config)
            elif platform == "greenhouse":
                co_leads = check_greenhouse_jobs(board_id, name, cohort, search_criteria, config)
            elif platform == "ashby":
                co_leads = check_ashby_jobs(board_id, name, cohort, search_criteria, config)
            elif platform == "workable":
                co_leads = check_workable_jobs(board_id, name, cohort, search_criteria, config)
            elif platform == "lever":
                co_leads = check_lever_jobs(board_id, name, cohort, search_criteria, config)
            elif platform == "workday":
                co_leads = check_workday_jobs(board_id, name, cohort, search_criteria, config)
            elif platform == "tiktok":
                co_leads = check_tiktok_jobs(name, cohort, search_criteria, config)
            else: # tesla, ddg, or any other general
                co_leads = check_company_jobs_ddg(name, cohort, search_criteria, config)
                
            scanned_companies.add(normalize_string(name))
            print(f" - Found {len(co_leads)} matching roles for {name}.")
            all_new_leads.extend(co_leads)
            
            for lead in co_leads:
                crawled_keys.add(job_identity_key(lead["company"], sanitize_job_title(lead.get("role", "")), lead.get("url", "")))
        except Exception as e:
            print(f"Error during scan of {name}: {e}")
            traceback.print_exc()
            
    today_str = datetime.today().strftime('%Y-%m-%d')
    updated_count = 0
    added_count = 0
    
    # Load profile details for scoring new leads
    cursor.execute("SELECT * FROM profile WHERE id = 1")
    profile_row = cursor.fetchone()
    profile_dict = dict(profile_row) if profile_row else {}
    
    for lead in all_new_leads:
        # Normalise before the dedup key is built, so a sanitised title can't be treated
        # as a different job from its already-stored clean version.
        lead["role"] = sanitize_job_title(lead.get("role", ""))
        key = job_identity_key(lead["company"], lead["role"], lead.get("url", ""))

        salary = lead.get("salary", "N/A") or "N/A"
        if salary == "N/A" and lead.get("url") and not is_placeholder_url(lead["url"]):
            try:
                headers_req = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
                res = requests.get(lead["url"], headers=headers_req, timeout=10, verify=False)
                if res.status_code == 200:
                    salary = extract_salary(res.text) or "N/A"
            except Exception as e:
                print(f"Error fetching salary for {lead['company']} - {lead['role']}: {e}")
                
        # Calculate relevancy score
        score = calculate_relevancy_score(lead["role"], lead.get("key_focus", "") + " " + lead["role"], profile_dict)
        
        posted_date = parse_posted_date(lead.get("posted_at"))
        first_date = posted_date or today_str

        # Check duplicates
        if key in existing_keys:
            existing = existing_keys[key]
            existing_url = existing["url"]
            if posted_date:
                cursor.execute("UPDATE jobs SET first_seen_at = ? WHERE id = ?", (posted_date, existing["id"]))
            
            if not existing_url or is_placeholder_url(existing_url) or existing_url != lead["url"]:
                print(f"Updating/Correcting URL for: {lead['company']} - {lead['role']}")
                cursor.execute("""
                UPDATE jobs SET url = ?, notes = ?, relevancy_score = ? WHERE id = ?
                """, (lead["url"], lead["key_focus"], score, existing["id"]))
                updated_count += 1
            
            # Restore if previously archived as closed
            if existing["status"] == "Archived" and existing["archive_reason"] == "Closed":
                print(f"Restoring reopened job: {lead['company']} - {lead['role']}")
                cursor.execute("""
                UPDATE jobs SET status = 'Lead', archive_reason = '', pipeline_status = 'Sourced', relevancy_score = ?
                WHERE id = ?
                """, (score, existing["id"]))
                updated_count += 1
            continue
            
        # Write new lead row to SQLite
        job_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{lead['company'].strip().lower()}:{lead['role'].strip().lower()}:{lead['url'].strip().lower()}"))
        
        # INSERT for genuinely-new jobs; ON CONFLICT preserve user/worker state. A drifted
        # identity key used to route a re-seen job here, and INSERT OR REPLACE then wiped its
        # status (killing the star on applied/starred roles), fit scores, pipeline linkage and
        # first_seen_at. DO UPDATE refreshes only the safe crawl fields and never touches
        # status/archive/pipeline/fit/first_seen_at, so a re-seen job keeps everything.
        cursor.execute("""
        INSERT INTO jobs (id, company_name, title, location, url, salary, status, archive_reason, notes, relevancy_score, first_seen_at, pipeline_status, last_checked_at, source)
        VALUES (?, ?, ?, ?, ?, ?, 'Lead', '', ?, ?, ?, 'Sourced', ?, 'Company Scraper')
        ON CONFLICT(id) DO UPDATE SET
            company_name=excluded.company_name, title=excluded.title, location=excluded.location,
            url=excluded.url, salary=excluded.salary, notes=excluded.notes,
            relevancy_score=excluded.relevancy_score, last_checked_at=excluded.last_checked_at,
            source=CASE WHEN jobs.source = 'NewPMJobs' THEN 'NewPMJobs' ELSE excluded.source END
        """, (
            job_id, lead["company"], lead["role"], lead["location"], lead["url"], salary, lead["key_focus"], score, first_date, today_str
        ))

        print(f"Added: {lead['company']} - {lead['role']} (Score: {score}%)")
        added_count += 1
        
    conn.commit()
        
    # Auto-archive closed roles or roles that no longer match the current criteria
    archived_closed_count = 0
    archived_criteria_count = 0
    
    # Reload active jobs from SQLite
    cursor.execute("SELECT id, company_name, title, url, status, location, notes FROM jobs WHERE status IN ('Lead', 'Consideration')")
    active_jobs = cursor.fetchall()
    
    for job in active_jobs:
        norm_co = normalize_string(job["company_name"])
        if target_company and norm_co != normalize_string(target_company):
            continue
            
        row_company = job["company_name"]
        row_role = job["title"]
        row_id = job["id"]
        
        # Check 1: Does it match search criteria and seniority levels?
        # Pass the FULL location string (not comma-split) so location_is_eligible sees the
        # whole context - splitting "Remote, Europe" into fragments would let the bare
        # "Remote" slip past the non-US-only guard.
        row_location = job["location"] or "N/A"

        if not matches_criteria(row_role, [row_location], search_criteria, row_company, config):
            print(f"Auto-archiving excluded criteria job: {row_company} - {row_role}")
            cursor.execute("""
            UPDATE jobs SET status = 'Archived', archive_reason = 'Not meeting Search Criteria', pipeline_status = 'Archived'
            WHERE id = ?
            """, (row_id,))
            archived_criteria_count += 1
            continue
            
        # Check 2: Check if it's closed (only if the company was successfully scanned in this run)
        if norm_co in scanned_companies:
            key = (norm_co, normalize_string(row_role))
            if key not in crawled_keys:
                # Double check if the URL is actually closed before archiving
                url = job["url"]
                
                if url and not is_placeholder_url(url):
                    print(f"Double-checking if job is actually closed: {row_company} - {row_role} ({url})")
                    if is_job_url_closed(url, row_company):
                        print(f"Auto-archiving closed job: {row_company} - {row_role}")
                        cursor.execute("""
                        UPDATE jobs SET status = 'Archived', archive_reason = 'Closed', pipeline_status = 'Archived'
                        WHERE id = ?
                        """, (row_id,))
                        archived_closed_count += 1
                    else:
                        print(f"Keeping job active: {row_company} - {row_role} (URL is still open/active)")
                else:
                    print(f"Auto-archiving closed job (placeholder URL): {row_company} - {row_role}")
                    cursor.execute("""
                    UPDATE jobs SET status = 'Archived', archive_reason = 'Closed', pipeline_status = 'Archived'
                    WHERE id = ?
                    """, (row_id,))
                    archived_closed_count += 1
                        
    conn.commit()
    conn.close()
    print(f"Scan finished. {added_count} roles added, {updated_count} URLs updated, {archived_closed_count} closed jobs archived, {archived_criteria_count} criteria-excluded jobs archived.")

# US-country designators that, on their own, mean "open anywhere in the US" - which includes
# the user's NY/NJ targets and is effectively US-remote. Kept explicit so the intent is clear.
_US_COUNTRY_TOKENS = ["united states of america", "united states", "u.s.a.", "u.s.a",
                      "u.s.", "usa", "america"]
_UNSCOPED_REMOTE_TOKENS = ["remote", "work from home", "wfh", "anywhere", "nationwide", "virtual"]
# "North America" (and "Remote - North America" / "Remote, North America") is treated the same
# as a bare US-country / unscoped-remote posting: open across the continent, NY/NJ included, so
# it belongs on the board. Postings that ALSO pin a concrete city (e.g. "North America - San
# Francisco") leave that city behind after stripping and are correctly left to the city rules.
_NORTH_AMERICA_TOKENS = ["north america", "north american"]


def is_us_nationwide_location(location):
    """True if `location` is a country/continent-level US or North-America / unscoped-remote
    posting with no city pinning it to a specific non-target metro.

    A bare "United States", "USA", "US", "North America", "Remote - North America" etc. means
    the role is open anywhere in the US (New York and New Jersey included), so it belongs on
    the board. Anything that ALSO names a concrete city/state (e.g. "San Francisco, United
    States", "North America - San Francisco") is left to the normal city rules, so onsite roles
    in other metros are not swept in. This only ever ADDS matches - it never rejects a location
    another rule accepts.
    """
    l = " " + (location or "").lower().strip() + " "
    if not l.strip():
        return False
    mentions_us = any(t in l for t in _US_COUNTRY_TOKENS) or bool(re.search(r'\bus\b', l))
    mentions_remote = any(w in l for w in _UNSCOPED_REMOTE_TOKENS)
    mentions_na = any(t in l for t in _NORTH_AMERICA_TOKENS)
    if not (mentions_us or mentions_remote or mentions_na):
        return False
    # Strip country/continent tokens, remote words, connective filler and punctuation. If a
    # concrete place name survives, the posting is pinned to that place and is NOT nationwide.
    # North-America phrases are stripped FIRST so the "america" country-token can't leave a
    # stray "north" behind (which would wrongly read as a pinned place).
    s = l
    for t in _NORTH_AMERICA_TOKENS:
        s = s.replace(t, " ")
    for t in _US_COUNTRY_TOKENS + _UNSCOPED_REMOTE_TOKENS:
        s = s.replace(t, " ")
    s = re.sub(r'\bu\.?s\.?\b', ' ', s)          # bare "US" / "U.S." / "U.S"
    s = re.sub(r'[\-\|,/();:•\.–—]', ' ', s)      # incl. en/em dashes used by some sources
    s = re.sub(r'\b(eligible|based|only|optional|hybrid|onsite|in|the|or|and)\b', ' ', s)
    return " ".join(s.split()) == ""


# Foreign countries / regions / hub cities. A location that names one of these and gives NO
# US signal is a non-US posting and must NOT qualify via the loose "remote" rule. Word
# boundaries are essential: a bare substring test would flag "India"na, Milwa"uk"ee, etc.
_NON_US_LOCATION_RE = re.compile(
    r'\b(canada|canadian|ontario|quebec|toronto|vancouver|montreal|'
    r'europe|european|emea|apac|latam|latin america|south america|central america|'
    r'iberia|india|indian|united kingdom|u\.k\.|uk|england|scotland|wales|ireland|'
    r'germany|france|spain|portugal|poland|italy|netherlands|amsterdam|belgium|'
    r'london|berlin|munich|paris|dublin|madrid|lisbon|barcelona|zurich|geneva|'
    r'brazil|brasil|mexico|argentina|colombia|chile|peru|'
    r'australia|new zealand|singapore|japan|china|hong kong|korea|taiwan|'
    r'philippines|indonesia|malaysia|vietnam|thailand|'
    r'israel|uae|dubai|abu dhabi|qatar|turkey|saudi|'
    r'sweden|denmark|norway|finland|switzerland|austria|romania|ukraine|czech|hungary|'
    r'south africa|nigeria|kenya|egypt|'
    r'bangalore|bengaluru|hyderabad|mumbai|delhi|pune|gurgaon|gurugram|chennai|noida)\b',
    re.IGNORECASE)

# Positive US signal. Full state NAMES (not 2-letter abbreviations, which collide with common
# words like IN/OR/OK/ME) plus the country tokens and NY/NJ. "america" is deliberately omitted
# because it also appears in "Latin America" / "South America".
_US_SIGNAL_RE = re.compile(
    r'\b(usa|u\.s\.a\.?|u\.s\.?|us|united states|'
    r'ny|nyc|nj|new york|new jersey|'
    r'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|'
    r'georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|'
    r'massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|'
    r'new hampshire|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|'
    r'pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|'
    r'virginia|washington|west virginia|wisconsin|wyoming)\b',
    re.IGNORECASE)

_REMOTE_WORD_RE = re.compile(r'\b(remote|work from home|wfh|telecommute|anywhere)\b', re.IGNORECASE)

# An explicit US-remote signal carried in the JOB TITLE, e.g. Yelp posts "... (Remote -
# United States)" in the title while job_location only says "San Francisco, CA".
_US_REMOTE_TITLE_RE = re.compile(
    r'remote[\s\-,–()]*\s*(u\.?s\.?a?\.?|united states)\b'
    r'|\b(u\.?s\.?a?\.?|united states)[\s\-,–]*remote\b',
    re.IGNORECASE)

# A parenthesized work-mode remote tag, e.g. "Senior PM, Data Platform (Remote)". Restricting
# to parentheses keeps DOMAIN uses of the word out ("Remote Monitoring", "Remote Sensing").
_PAREN_REMOTE_RE = re.compile(r'\([^)]*\bremote\b[^)]*\)', re.IGNORECASE)


def _is_non_us_only(text):
    """True if `text` names a foreign place and carries no US signal (non-US-only posting)."""
    return bool(_NON_US_LOCATION_RE.search(text)) and not _US_SIGNAL_RE.search(text)


def location_is_eligible(location, search_criteria, title=""):
    """True if a job belongs on the board for the user's target locations (NY/NJ/US-remote).

    Two refinements beyond a plain location match:
    * Non-US guard: the loose "remote" rule no longer admits EMEA/APAC/Canada-only postings.
      A remote location qualifies only when it also carries a US signal, or names no foreign
      place at all. Mixed US+foreign postings (e.g. "Remote, Canada; Remote, US") still count.
    * Title fallback: some employers (Yelp) put the true work location in the TITLE - e.g.
      "(Remote - United States)" - while job_location shows only the HQ city. An explicit
      US-remote title, or a parenthesized "(Remote)" tag on a non-foreign location, qualifies.
    """
    l = (location or "").lower().strip()
    ttl = (title or "").lower()

    # Explicit US-remote signal in the title overrides an HQ-only location field.
    if _US_REMOTE_TITLE_RE.search(ttl):
        return True

    for crit_loc in search_criteria.get("locations", []):
        c = crit_loc.lower().strip()
        if c in ["remote", "us remote", "usa remote"]:
            if _REMOTE_WORD_RE.search(l) and not _is_non_us_only(l):
                return True
        elif c in ["ny", "nyc", "new york"]:
            if re.search(r'\b(ny|nyc|new york)\b', l) or "new york" in l or "nyc" in l:
                return True
        elif c in ["nj", "new jersey"]:
            if re.search(r'\b(nj|new jersey)\b', l) or "new jersey" in l:
                return True
        elif c and (c in l or l in c) and not _is_non_us_only(l):
            return True

    # Nationwide US / unscoped-remote postings (e.g. "United States", "USA") are open to any
    # US location, NY/NJ included, so they count as eligible.
    if is_us_nationwide_location(location):
        return True

    # Parenthesized "(Remote)" work-mode tag in the title, on a location that isn't foreign.
    if l and _PAREN_REMOTE_RE.search(ttl) and not _is_non_us_only(l):
        return True

    return False


def record_scan_error(error_msg):
    """Record a failure during crawler execution to scan_audit so the UI alerts the user."""
    print(f"\n[CRAWLER ERROR AUDIT] {error_msg}")
    try:
        conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=10000;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        cursor = conn.cursor()
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS scan_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ran_at TEXT,
            source_total INTEGER,
            source_eligible INTEGER,
            board_active INTEGER,
            missing_count INTEGER,
            per_location TEXT,
            missing_sample TEXT,
            source_eligible_distinct INTEGER DEFAULT 0,
            board_active_distinct INTEGER DEFAULT 0,
            status TEXT DEFAULT 'success',
            error_message TEXT DEFAULT ''
        )
        """)
        for _c, _t in [("source_eligible_distinct", "INTEGER DEFAULT 0"),
                       ("board_active_distinct", "INTEGER DEFAULT 0"),
                       ("status", "TEXT DEFAULT 'success'"),
                       ("error_message", "TEXT DEFAULT ''")]:
            try:
                cursor.execute(f"ALTER TABLE scan_audit ADD COLUMN {_c} {_t}")
            except sqlite3.OperationalError:
                pass

        try:
            cursor.execute("SELECT COUNT(*) FROM jobs WHERE status != 'Archived'")
            board_active = cursor.fetchone()[0]
        except Exception:
            board_active = 0

        ran_at = datetime.now().strftime('%Y-%m-%d %I:%M %p')
        cursor.execute("""
            INSERT INTO scan_audit (ran_at, status, error_message, source_total, source_eligible, board_active,
                                    missing_count, per_location, missing_sample,
                                    source_eligible_distinct, board_active_distinct)
            VALUES (?, 'error', ?, 0, 0, ?, 0, '{}', '[]', 0, ?)
        """, (ran_at, str(error_msg), board_active, board_active))
        conn.commit()
        conn.close()
        try:
            if GDRIVE_DB_PATH: shutil.copy2(DB_PATH, GDRIVE_DB_PATH)
        except Exception as dbe:
            print("Mirror to Google Drive notice:", dbe)
    except Exception as e:
        print("Failed to record scan error to scan_audit:", e)


def audit_source_parity(cursor, agg_jobs, co_map, search_criteria):
    """Compare the board against the upstream source and persist the result.

    Runs at the end of every aggregator scan. Any source job that is eligible (right
    location + a PM title) but absent from the board after a completed scan indicates the
    crawler dropped it - i.e. a bug - so it gets recorded and surfaced in the UI rather
    than silently accumulating.

    Note the per-location numbers use a plain substring match on the location text so they
    line up with what you'd count by hand on newpmjobs.com. That is deliberately naive and
    over-counts (e.g. "San Jose ... (SANJOSE)" contains "nj"), so `missing` - which uses the
    real eligibility rules - is the number that actually matters.
    """
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS scan_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ran_at TEXT,
        source_total INTEGER,
        source_eligible INTEGER,
        board_active INTEGER,
        missing_count INTEGER,
        per_location TEXT,
        missing_sample TEXT,
        source_eligible_distinct INTEGER DEFAULT 0,
        board_active_distinct INTEGER DEFAULT 0,
        status TEXT DEFAULT 'success',
        error_message TEXT DEFAULT ''
    )
    """)
    # Row counts on the two sides are NOT comparable: both carry duplicates (the same
    # requisition listed at several locations), in different amounts. Comparing them made
    # the banner read "1469 eligible" beside a board showing 1456 and look like 13 lost
    # jobs, when the distinct counts were identical. Track the deduplicated figures too.
    for _c, _t in [("source_eligible_distinct", "INTEGER DEFAULT 0"),
                   ("board_active_distinct", "INTEGER DEFAULT 0"),
                   ("status", "TEXT DEFAULT 'success'"),
                   ("error_message", "TEXT DEFAULT ''")]:
        try:
            cursor.execute(f"ALTER TABLE scan_audit ADD COLUMN {_c} {_t}")
        except sqlite3.OperationalError:
            pass

    cursor.execute("SELECT company_name, title, location, url FROM jobs WHERE status != 'Archived'")
    board_rows = cursor.fetchall()
    # Same key shape as ingestion. With the old company+title key the audit was blind to
    # distinct requisitions that share a generic title, and reported "none missing" while
    # ~108 real openings were being collapsed away.
    board_keys = {job_identity_key(r["company_name"], r["title"], r["url"]) for r in board_rows}

    eligible, missing, eligible_keys = 0, [], set()
    for j in agg_jobs:
        cname = co_map.get(j.get("company_id"))
        # Must sanitise exactly as ingestion does, or a cleaned board row won't match its
        # raw upstream counterpart and the audit reports a phantom "missing" job.
        title = sanitize_job_title(j.get("job_title") or "")
        if not cname or not title or not j.get("job_url_path"):
            continue
        if not location_is_eligible(sanitize_scraped_field(j.get("job_location")), search_criteria, title):
            continue
        if not is_pm_title(title):
            continue
        eligible += 1
        k = job_identity_key(cname, title, j.get("job_url_path"))
        eligible_keys.add(k)
        if k not in board_keys:
            missing.append({"company": cname, "title": title, "location": j.get("job_location") or "",
                            "url": j.get("job_url_path") or ""})

    per_loc = {}
    for term in ["NJ", "NYC", "New York", "New Jersey", "Remote"]:
        tl = term.lower()
        per_loc[term] = {
            "source": sum(1 for j in agg_jobs
                          if tl in sanitize_scraped_field(j.get("job_location")).lower()),
            "board": sum(1 for r in board_rows if tl in (r["location"] or "").lower()),
        }

    # Deduplicated counts are the only ones that can be compared like-for-like.
    eligible_distinct = len(eligible_keys)
    board_distinct = len(board_keys)
    missing_distinct = len({job_identity_key(x["company"], x["title"], x.get("url")) for x in missing})

    ran_at = datetime.now().strftime('%Y-%m-%d %I:%M %p')
    cursor.execute("""
        INSERT INTO scan_audit (ran_at, source_total, source_eligible, board_active,
                                missing_count, per_location, missing_sample,
                                source_eligible_distinct, board_active_distinct,
                                status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', '')
    """, (ran_at, len(agg_jobs), eligible, len(board_rows), missing_distinct,
          json.dumps(per_loc), json.dumps(missing[:50]),
          eligible_distinct, board_distinct))

    print("\n--- SOURCE PARITY AUDIT ---")
    print(f"  source active={len(agg_jobs)}  eligible rows={eligible} "
          f"({eligible_distinct} distinct)  board rows={len(board_rows)} ({board_distinct} distinct)")
    print(f"  NOTE: row counts differ by duplicate volume on each side; compare the distinct figures.")
    for term, v in per_loc.items():
        print(f"    {term:<12} source={v['source']:<5} board={v['board']}")
    if missing:
        print(f"  !! {len(missing)} eligible source job(s) MISSING from the board:")
        for mrow in missing[:15]:
            print(f"     - {mrow['company']} | {mrow['title']} | {mrow['location']}")
    else:
        print("  OK - no eligible source jobs are missing from the board.")
    print("--- END AUDIT ---\n")


def _run_aggregator_scan_impl(target_company=None):
    if target_company:
        print(f"Initiating high-efficiency aggregator job leads scan for '{target_company}'...")
    else:
        print("Initiating daily high-efficiency aggregator job leads scan...")
        
    import uuid
    import time
    
    # 1. Fetch Dynamic JWT anon key
    try:
        anon_key = get_supabase_anon_key()
        print(f"Acquired dynamic Supabase JWT key: {anon_key[:30]}...")
    except Exception as e:
        err_msg = f"Failed to acquire Supabase JWT key: {e}"
        print(err_msg)
        print("Aborting aggregator scan.")
        record_scan_error(err_msg)
        return
        
    # 2. Query seen_jobs from Supabase REST API (paginated — default limit is 1000)
    supabase_url = "https://lrmxjqijaenyzdjjzmmo.supabase.co"
    base_headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}"
    }
    
    def fetch_all_pages(endpoint_url, label="records"):
        """Fetch all pages from a Supabase REST endpoint using Range headers with retry logic."""
        page_size = 1000
        offset = 0
        all_records = []
        while True:
            paged_headers = dict(base_headers)
            paged_headers["Range-Unit"] = "items"
            paged_headers["Range"] = f"{offset}-{offset + page_size - 1}"
            
            page_records = None
            for attempt in range(3):
                try:
                    resp = requests.get(endpoint_url, headers=paged_headers, verify=False, timeout=30)
                    if resp.status_code in (200, 206):
                        page_records = resp.json()
                        break
                    elif resp.status_code in (502, 503, 504):
                        print(f"  Attempt {attempt+1}: Status {resp.status_code} at offset {offset}, retrying in 3s...")
                        time.sleep(3)
                    else:
                        print(f"Failed page fetch at offset {offset}: status {resp.status_code}")
                        break
                except Exception as page_err:
                    print(f"  Attempt {attempt+1} error fetching page at offset {offset}: {page_err}")
                    time.sleep(3)
            
            if page_records is None or not page_records:
                break
                
            all_records.extend(page_records)
            print(f"  Fetched {len(all_records)} {label} so far (page offset={offset})...")
            if len(page_records) < page_size:
                break  # Last page
            offset += page_size
        return all_records
    
    # Fetch ALL active postings (paginated) — NewPMJobs.com lists open live roles with status=eq.active
    print("Fetching active PM job postings from aggregator (paginated)...")
    agg_jobs = fetch_all_pages(
        f"{supabase_url}/rest/v1/seen_jobs?status=eq.active&select=id,job_title,job_location,job_url_path,company_id,status,first_seen_at",
        label="active jobs"
    )
    if not agg_jobs:
        err_msg = "Failed to fetch active aggregator jobs from Supabase API (network timeout or empty response)"
        print(f"{err_msg}. Aborting.")
        record_scan_error(err_msg)
        return
        
    print(f"Retrieved {len(agg_jobs)} total active postings from aggregator database.")
    
    # Fetch ALL company mappings from Supabase (paginated).
    # The upstream `companies` table can be RLS-locked (401 permission denied) - when that
    # happens we must NOT abort, because the seen_jobs feed is still fully readable. We rebuild
    # the id->name map from our own board history below (reconstruct_company_map).
    print("Fetching company mappings from aggregator...")
    supabase_companies = fetch_all_pages(
        f"{supabase_url}/rest/v1/companies?select=id,name",
        label="companies"
    )
    supabase_co_map = {c["id"]: c["name"] for c in supabase_companies} if supabase_companies else {}
    if not supabase_co_map:
        print("Upstream companies table unavailable (likely RLS-locked); "
              "will reconstruct company names from board history.")

    # 3. Load tracked companies mapping from our SQLite DB
    conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=10000;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT id, name, platform, board_id, cohort, levels FROM companies")
    db_companies = cursor.fetchall()
    company_map = {}
    for co in db_companies:
        co_dict = dict(co)
        co_dict["levels"] = json.loads(co_dict["levels"]) if co_dict["levels"] else []
        company_map[co["name"].lower().strip()] = co_dict
        
    # Load profile details for scoring new leads
    cursor.execute("SELECT * FROM profile WHERE id = 1")
    profile_row = cursor.fetchone()
    profile_dict = dict(profile_row) if profile_row else {}
    gemini_key = profile_dict.get("gemini_api_key", "").strip()
    
    # Load existing leads to prevent duplicates
    cursor.execute("SELECT id, company_name, title, url, status, archive_reason FROM jobs ORDER BY CASE WHEN status = 'Archived' THEN 0 ELSE 1 END ASC")
    existing_jobs = cursor.fetchall()
    existing_keys = {}
    for j in existing_jobs:
        key = job_identity_key(j["company_name"], j["title"], j["url"])
        existing_keys[key] = {
            "id": j["id"],
            "url": j["url"],
            "status": j["status"],
            "archive_reason": j["archive_reason"]
        }

    # If the upstream companies table was unreachable, rebuild the id->name map from the URLs
    # of jobs we have already ingested. Without this, every source job maps to no company and
    # the scan ingests nothing (which is exactly how the board silently fell out of sync).
    if not supabase_co_map:
        supabase_co_map = reconstruct_company_map(agg_jobs, existing_jobs)
        try:
            feed_resp = requests.get("https://newpmjobs.com/api/app-feed?limit=100&offset=0", verify=False, timeout=10)
            if feed_resp.status_code == 200:
                for fj in (feed_resp.json().get("jobs") or []):
                    co_obj = fj.get("company") or {}
                    if co_obj.get("id") and co_obj.get("name"):
                        supabase_co_map.setdefault(co_obj["id"], co_obj["name"].strip())
        except Exception:
            pass
        print(f"Reconstructed {len(supabase_co_map)} company names from board history + app-feed.")
        if not supabase_co_map:
            err_msg = "Could not reconstruct any company names from board history"
            print(f"{err_msg}. Aborting to avoid a bad scan.")
            conn.close()
            record_scan_error(err_msg)
            return

    # Get search criteria from profile
    search_criteria = {
        "locations": json.loads(profile_dict.get("locations", "[]")) if profile_dict.get("locations") else ["New York", "NYC", "Remote"],
        "custom_keywords": json.loads(profile_dict.get("keywords", "[]")) if profile_dict.get("keywords") else ["product manager", "product management", "technical product manager"],
        "role_levels": json.loads(profile_dict.get("seniority_levels", "[]")) if profile_dict.get("seniority_levels") else ["Senior", "Group", "Staff", "Principal", "Director", "VP"],
        "strict_level_filtering": False
    }
    
    added_count = 0
    updated_count = 0
    unresolved_company_count = 0

    # Track active aggregator jobs
    active_ids_in_aggregator = set()
    
    for agg_j in agg_jobs:
        comp_id = agg_j.get("company_id")
        comp_name = supabase_co_map.get(comp_id)   # may be None for a brand-new company

        # Target company filter (only decidable once the name is known).
        if target_company and (not comp_name
                               or normalize_string(comp_name) != normalize_string(target_company)):
            continue

        title = sanitize_job_title(agg_j.get("job_title", ""))
        location = sanitize_scraped_field(agg_j.get("job_location", "")) or "N/A"
        url = agg_j.get("job_url_path", "")

        if not title or not url:
            continue

        # Check locations. Uses the shared eligibility rule (nationwide US, non-US guard, and
        # the title fallback for HQ-only location fields) so ingestion and the parity audit ->
        # location_is_eligible can never drift apart.
        if not location_is_eligible(location, search_criteria, title):
            continue

        # Check PM title keywords. NewPMJobs.com is already a PM-only curated board, so this
        # is just a sanity net - it must not be narrower than the source or the board
        # undercounts its own feed (see is_pm_title docstring).
        if not is_pm_title(title):
            continue

        # Resolve the employer name if reconstruction couldn't (companies table RLS-locked AND
        # this company_id is new to the board). Done AFTER the cheap filters so we only fetch a
        # page for roles we actually want, and cached so each company costs one lookup per scan.
        # This is what was silently dropping Yahoo (Workday), Oracle-hosted roles, etc.
        if not comp_name:
            comp_name = resolve_company_name(url)
            if comp_name:
                supabase_co_map[comp_id] = comp_name   # reused by later jobs AND the parity audit
                print(f"  Resolved new company from posting: {comp_name}")
            else:
                unresolved_company_count += 1
                continue

        # Seniority/level filtering is intentionally NOT applied at crawl time - the board
        # UI's Early / Mid / Dir+ toggles handle it non-destructively. See matches_criteria.

        key = job_identity_key(comp_name, title, url)
        active_ids_in_aggregator.add(key)
        
        # Check if already exists in local DB
        if key in existing_keys:
            existing = existing_keys[key]
            # Whenever a deduplicated role is present in NewPMJobs, link its source to NewPMJobs
            cursor.execute("UPDATE jobs SET source = 'NewPMJobs' WHERE id = ? AND COALESCE(source, '') != 'NewPMJobs'", (existing["id"],))
            # Restore if previously archived as closed
            if existing["status"] == "Archived" and existing["archive_reason"] == "Closed":
                print(f"Restoring reopened job: {comp_name} - {title}")
                cursor.execute("""
                UPDATE jobs SET status = 'Lead', archive_reason = '', pipeline_status = 'Sourced'
                WHERE id = ?
                """, (existing["id"],))
                updated_count += 1
            continue
            
        # New job: Fetch description rapidly
        print(f"New job discovered: {comp_name} - {title}")
        
        description = ""
        salary_text = "N/A"
        posted_date = ""
        try:
            headers_req = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
            res = requests.get(url, headers=headers_req, timeout=2, verify=False)
            if res.status_code == 200:
                posted_date = _date_posted_from_jsonld(res.text)
                soup = BeautifulSoup(res.text, "html.parser")
                for script in soup(["script", "style"]):
                    script.decompose()
                description = soup.get_text(separator="\n")
                lines = (line.strip() for line in description.splitlines())
                chunks_text = (phrase for phrase in lines if phrase)
                description = "\n".join(chunks_text)
                salary_text = extract_salary(description) or "N/A"
        except Exception:
            pass
            
        desc_for_score = description or title
        score = calculate_relevancy_score(title, desc_for_score, profile_dict)
        justification = "Scored via local NLP heuristic."
            
        # Write new lead row to SQLite
        job_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{comp_name.strip().lower()}:{title.strip().lower()}:{url.strip().lower()}"))
        today_str = datetime.today().strftime('%Y-%m-%d')
        first_date = posted_date or parse_posted_date(agg_j.get("first_seen_at")) or today_str
        notes_text = f"Scored: {justification}\n\nDescription Snippet: {description[:200]}..." if description else "Description page fetch failed."
        
        # See the note on the other INSERT site: non-destructive on re-see so a drifted
        # identity key can't wipe a starred/applied job's status, fit or pipeline linkage.
        cursor.execute("""
        INSERT INTO jobs (id, company_name, title, location, url, salary, status, archive_reason, notes, relevancy_score, first_seen_at, pipeline_status, last_checked_at, source)
        VALUES (?, ?, ?, ?, ?, ?, 'Lead', '', ?, ?, ?, 'Sourced', ?, 'NewPMJobs')
        ON CONFLICT(id) DO UPDATE SET
            company_name=excluded.company_name, title=excluded.title, location=excluded.location,
            url=excluded.url, salary=excluded.salary, notes=excluded.notes,
            relevancy_score=excluded.relevancy_score, last_checked_at=excluded.last_checked_at,
            source='NewPMJobs'
        """, (
            job_id, comp_name, title, location, url, salary_text, notes_text, score, first_date, today_str
        ))
        
        print(f" -> Successfully saved job (Score: {score}%)")
        added_count += 1
        conn.commit()
        
    # Tier-1 Direct NYC/Remote Supplement Pass:
    # Upstream NewPMJobs.com only records the FIRST location on multi-location requisitions
    # for employers like Apple (recording "Cupertino" while dropping "New York City"), and
    # can miss roles on custom portals. Run direct NYC crawlers for Tier-1 custom platforms
    # so multi-location NYC roles are always captured and never falsely archived as Closed.
    full_config = load_config()
    tier1_platforms = {"apple", "google", "microsoft", "amazon", "meta", "netflix", "nvidia", "tiktok"}
    for co in full_config.get("companies", []):
        co_name = co["name"]
        co_plat = (co.get("platform") or "").lower().strip()
        if co_plat not in tier1_platforms:
            continue
        if target_company and normalize_string(co_name) != normalize_string(target_company):
            continue
        print(f"Running Tier-1 direct NYC/Remote supplement scan for {co_name} ({co_plat})...")
        try:
            direct_leads = []
            if co_plat == "apple":
                direct_leads = check_apple_jobs(co_name, co["cohort"], search_criteria, full_config)
            elif co_plat == "google":
                direct_leads = check_google_jobs(co_name, co["cohort"], search_criteria, full_config)
            elif co_plat == "microsoft":
                direct_leads = check_microsoft_jobs(co_name, co["cohort"], search_criteria, full_config)
            elif co_plat == "amazon":
                direct_leads = check_amazon_jobs(co_name, co["cohort"], search_criteria, full_config)
            elif co_plat == "meta":
                direct_leads = check_meta_jobs(co_name, co["cohort"], search_criteria, full_config)
            elif co_plat == "netflix":
                direct_leads = check_netflix_jobs(co_name, co["cohort"], search_criteria, full_config)
            elif co_plat == "nvidia":
                direct_leads = check_nvidia_jobs(co.get("board_id", ""), co_name, co["cohort"], search_criteria, full_config)
            elif co_plat == "tiktok":
                direct_leads = check_tiktok_jobs(co_name, co["cohort"], search_criteria, full_config)

            print(f" -> Direct supplement found {len(direct_leads)} eligible NYC/Remote roles for {co_name}.")
            today_str = datetime.today().strftime('%Y-%m-%d')
            for dlead in direct_leads:
                d_title = sanitize_job_title(dlead.get("role", ""))
                d_loc = dlead.get("location", "N/A") or "N/A"
                d_url = dlead.get("url", "")
                d_sal = dlead.get("salary", "N/A") or "N/A"
                d_focus = dlead.get("key_focus", "")
                d_posted = parse_posted_date(dlead.get("posted_at"))
                d_first_date = d_posted or today_str
                if not d_title or not d_url:
                    continue
                d_key = job_identity_key(co_name, d_title, d_url)
                active_ids_in_aggregator.add(d_key)

                if d_key in existing_keys:
                    existing = existing_keys[d_key]
                    if d_posted:
                        cursor.execute("UPDATE jobs SET first_seen_at = ? WHERE id = ?", (d_posted, existing["id"]))
                    if existing["status"] == "Archived" and existing["archive_reason"] in ("Closed", "Not meeting Search Criteria"):
                        print(f"Restoring active multi-location/direct job: {co_name} - {d_title} ({d_loc})")
                        cursor.execute("""
                        UPDATE jobs SET status = 'Lead', archive_reason = '', pipeline_status = 'Sourced',
                            location = ?, url = ?, salary = CASE WHEN ? != 'N/A' THEN ? ELSE salary END,
                            notes = CASE WHEN length(?) > 100 THEN ? ELSE notes END,
                            last_checked_at = ?
                        WHERE id = ?
                        """, (d_loc, d_url, d_sal, d_sal, d_focus, d_focus, today_str, existing["id"]))
                        updated_count += 1
                    continue

                d_score = calculate_relevancy_score(d_title, d_focus + " " + d_title, profile_dict)
                d_job_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{co_name.strip().lower()}:{d_title.strip().lower()}:{d_url.strip().lower()}"))
                d_notes = d_focus if len(d_focus) > 100 else f"Discovered via {co_name} direct NYC crawl ({d_focus})."
                cursor.execute("""
                INSERT INTO jobs (id, company_name, title, location, url, salary, status, archive_reason, notes, relevancy_score, first_seen_at, pipeline_status, last_checked_at, source)
                VALUES (?, ?, ?, ?, ?, ?, 'Lead', '', ?, ?, ?, 'Sourced', ?, 'Company Scraper')
                ON CONFLICT(id) DO UPDATE SET
                    company_name=excluded.company_name, title=excluded.title, location=excluded.location,
                    url=excluded.url, salary=excluded.salary, notes=excluded.notes,
                    relevancy_score=excluded.relevancy_score, last_checked_at=excluded.last_checked_at,
                    first_seen_at=CASE WHEN ? != '' THEN ? ELSE jobs.first_seen_at END,
                    source=CASE WHEN jobs.source = 'NewPMJobs' THEN 'NewPMJobs' ELSE 'Company Scraper' END
                """, (d_job_id, co_name, d_title, d_loc, d_url, d_sal, d_notes, d_score, d_first_date, today_str, d_posted, d_posted))
                existing_keys[d_key] = {"id": d_job_id, "url": d_url, "status": "Lead", "archive_reason": ""}
                added_count += 1
            conn.commit()
        except Exception as de:
            print(f"Warning: Direct supplement scan for {co_name} encountered error: {de}")

    # Build set of all active normalized requisition URLs in upstream feed (even if upstream
    # only recorded the primary HQ location like "Cupertino" on a multi-location role).
    all_active_source_reqs = {normalize_job_url(aj.get("job_url_path") or "") for aj in agg_jobs if aj.get("job_url_path")}

    # Auto-archive closed roles
    archived_closed_count = 0
    cursor.execute("SELECT id, company_name, title, url, status FROM jobs WHERE status IN ('Lead', 'Consideration')")
    active_jobs = cursor.fetchall()
    
    for job in active_jobs:
        row_company = job["company_name"]
        if target_company and normalize_string(row_company) != normalize_string(target_company):
            continue
            
        row_title = job["title"]
        # MUST use the same key shape as active_ids_in_aggregator, otherwise every stored
        # row looks absent from the feed and the sweep archives the entire board.
        key = job_identity_key(row_company, row_title, job["url"])

        if key not in active_ids_in_aggregator:
            req_norm = normalize_job_url(job["url"])
            # Guard 1: If the requisition ID is still active in NewPMJobs.com (e.g., listed under
            # HQ location while board has its NYC location), do NOT archive unless URL is closed.
            if req_norm and req_norm in all_active_source_reqs:
                if not is_job_url_closed(job["url"], row_company):
                    print(f"Keeping active multi-location job: {row_company} - {row_title}")
                    continue
            # Guard 2: For Tier-1 direct-crawled companies, double-check live URL before archiving.
            co_info = company_map.get(row_company.lower().strip(), {})
            if (co_info.get("platform") or "").lower().strip() in tier1_platforms and job["url"]:
                if not is_job_url_closed(job["url"], row_company):
                    print(f"Keeping live Tier-1 job open on portal: {row_company} - {row_title}")
                    continue
            print(f"Job no longer active in aggregator feed. Archiving: {row_company} - {row_title}")
            cursor.execute("""
            UPDATE jobs SET status = 'Archived', archive_reason = 'Closed', pipeline_status = 'Archived'
            WHERE id = ?
            """, (job["id"],))
            archived_closed_count += 1
            
    # Self-audit: after a full scan, anything the source lists that we consider eligible
    # should already be in the board. Anything left over is a crawler defect, so record it
    # for the UI instead of letting it go unnoticed (this is how the 131-job title-filter
    # bug went undetected for weeks).
    try:
        audit_source_parity(cursor, agg_jobs, supabase_co_map, search_criteria)
    except Exception as audit_err:
        print("Parity audit failed (non-fatal):", audit_err)

    now_str = datetime.now().strftime('%Y-%m-%d %I:%M %p')
    cursor.execute("UPDATE profile SET last_scanned_at = ? WHERE id = (SELECT id FROM profile ORDER BY id DESC LIMIT 1)", (now_str,))
    conn.commit()
    conn.close()
    try:
        if GDRIVE_DB_PATH: shutil.copy2(DB_PATH, GDRIVE_DB_PATH)
    except Exception as dbe:
        print("Mirror to Google Drive notice:", dbe)
    print(f"Scan finished. {added_count} roles added, {updated_count} URLs updated, {archived_closed_count} closed jobs archived, {unresolved_company_count} skipped (company unresolved).")


def run_aggregator_scan(target_company=None):
    try:
        _run_aggregator_scan_impl(target_company)
    except Exception as e:
        err_msg = f"Unexpected crawler error: {e}"
        print(f"\n[Crawler Error] {err_msg}")
        record_scan_error(err_msg)
        raise

if __name__ == '__main__':
    import sys
    args = sys.argv[1:]
    direct_mode = False
    target_company = None
    
    if "--direct" in args:
        direct_mode = True
        args.remove("--direct")
        
    if len(args) > 0:
        target_company = args[0]
        
    if direct_mode:
        run_daily_scan(target_company)
    else:
        run_aggregator_scan(target_company)
