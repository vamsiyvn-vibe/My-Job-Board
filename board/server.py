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
import datetime
import traceback
import subprocess
import json
import threading
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from bs4 import BeautifulSoup
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

SCRIPTS_DIR = r"G:\My Drive\.Agents\1_Projects\2026 Job Search\scripts"
if SCRIPTS_DIR not in sys.path:
    sys.path.append(SCRIPTS_DIR)

TRACKER_PATH = r"G:\My Drive\.Agents\1_Projects\2026 Job Search\Job_Leads_Tracker.xlsx"
CONFIG_PATH = r"G:\My Drive\.Agents\1_Projects\2026 Job Search\board\config.json"

app = Flask(__name__, static_url_path='', static_folder='.')
CORS(app)

# Global variables for async background scanning
is_scanning = False
auto_scan_triggered = False
scan_lock = threading.Lock()

# In-memory cache for jobs to avoid slow Excel loading on every request
JOBS_CACHE = {
    "jobs": [],
    "last_scanned": "",
    "last_loaded_mtime": 0
}

def load_jobs_from_excel():
    global JOBS_CACHE
    try:
        if not os.path.exists(TRACKER_PATH):
            return [], "Never"
            
        mtime = os.path.getmtime(TRACKER_PATH)
        # Reload cache if file is newer on disk or if cache is empty
        if mtime > JOBS_CACHE["last_loaded_mtime"] or not JOBS_CACHE["jobs"]:
            print(f"Loading jobs from Excel (mtime: {mtime})...")
            wb = openpyxl.load_workbook(TRACKER_PATH)
            if "Job Leads" in wb.sheetnames:
                ws = wb["Job Leads"]
                jobs = []
                # Read from row 2
                for r_idx in range(2, ws.max_row + 1):
                    company = ws.cell(row=r_idx, column=3).value
                    role = ws.cell(row=r_idx, column=4).value
                    
                    if not company or not role:
                        continue
                        
                    status = ws.cell(row=r_idx, column=7).value
                    if not status:
                        status = "Lead"
                        
                    url_cell = ws.cell(row=r_idx, column=8)
                    url = url_cell.hyperlink.target if url_cell.hyperlink else url_cell.value
                    
                    salary = ws.cell(row=r_idx, column=11).value or "N/A"
                    app_status = ws.cell(row=r_idx, column=12).value or "Not Applied"
                    app_outcome = ws.cell(row=r_idx, column=13).value or "Active / Pending"
                    resume_url = ws.cell(row=r_idx, column=14).value or ""
                    archive_reason = ws.cell(row=r_idx, column=15).value or ""
                    
                    jobs.append({
                        "id": r_idx,
                        "select": ws.cell(row=r_idx, column=1).value or "[ ]",
                        "cohort": ws.cell(row=r_idx, column=2).value or "Other",
                        "company": company,
                        "role": role,
                        "location": ws.cell(row=r_idx, column=5).value or "N/A",
                        "key_focus": ws.cell(row=r_idx, column=6).value or "",
                        "status": status,
                        "url": url,
                        "date_added": ws.cell(row=r_idx, column=9).value or "",
                        "notes": ws.cell(row=r_idx, column=10).value or "",
                        "salary": salary,
                        "app_status": app_status,
                        "app_outcome": app_outcome,
                        "resume_url": resume_url,
                        "archive_reason": archive_reason
                    })
                JOBS_CACHE["jobs"] = jobs
                JOBS_CACHE["last_scanned"] = datetime.datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %I:%M %p')
                JOBS_CACHE["last_loaded_mtime"] = mtime
                print(f"Loaded {len(jobs)} jobs from Excel into cache.")
            else:
                print("Sheet 'Job Leads' not found in spreadsheet.")
    except Exception as e:
        print("Error loading jobs from Excel file:", e)
        traceback.print_exc()
        # On error (e.g. file sharing lock), we retain the existing cache
    return JOBS_CACHE["jobs"], JOBS_CACHE["last_scanned"]

INTERVIEW_INSIGHTS = {
    "google": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Behavioral alignment, resume walkthrough, and verification of PM qualifications."},
            {"title": "2. Product Design / Product Sense (45m)", "desc": "Designing a new product or improving an existing one. Focus on user-centric problem solving, clear frameworks (CIRCLES), and creative prioritization. (e.g., 'Design an alarm clock for the blind')."},
            {"title": "3. Analytical / Execution (45m)", "desc": "Metrics definition, root cause analysis of metric drops, prioritization under constraints, and estimation/market sizing. (e.g., 'How would you measure success of YouTube Shorts?')."},
            {"title": "4. Product Strategy (45m)", "desc": "High-level strategic questions focusing on market entrance, business models, monetization, and competitive dynamics. (e.g., 'Should Google acquire Zoom?')."},
            {"title": "5. Googlyness & Leadership (45m)", "desc": "Behavioral round assessing conflict resolution, cross-functional collaboration, ethical standards, and cultural alignment."}
        ],
        "tips": [
            "Use the CIRCLES method for product design rounds, but customize it so it doesn't sound robotic.",
            "Always align recommendations with Google's core mission to organize the world's information and make it universally accessible.",
            "Focus on scale: solutions must work for billions of users worldwide."
        ]
    },
    "microsoft": {
        "stages": [
            {"title": "1. Initial Phone Screen (45m)", "desc": "PM or Hiring Manager screen checking product design basics and resume fit."},
            {"title": "2. Technical / System Design (45m)", "desc": "Probing technical fluency, database design, API design, or Azure architecture depending on the group."},
            {"title": "3. Product Design & Strategy (45m)", "desc": "Focus on enterprise scaling, SaaS mechanics (Office 365, Teams), or developer platforms."},
            {"title": "4. As Appropriate (AA) Interview (45m)", "desc": "Final round with a Partner PM Director who evaluates leadership, long-term vision, and capability to work across massive cross-functional boundaries."}
        ],
        "tips": [
            "Focus on enterprise customer empathy: understand security, data compliance, and migration paths.",
            "Demonstrate growth mindset (a core Microsoft culture value).",
            "Be structured: break down complex, multi-stakeholder problems into clear phases."
        ]
    },
    "apple": {
        "stages": [
            {"title": "1. Recruiter & Hiring Manager Screens", "desc": "1-2 rounds to assess general background and specific team alignment. Highly team-dependent."},
            {"title": "2. Case Presentation / Panel (60m)", "desc": "Presenting a deep-dive case study or past product launch to a panel of 3-5 PMs/Engineers."},
            {"title": "3. Onsite Loop (5-6 rounds)", "desc": "Intense individual rounds with engineering leads, hardware managers, design leads, and PM Directors. Focuses on extreme detail, quality, design sensitivity, and collaboration."}
        ],
        "tips": [
            "Apple is highly team-specific. Make sure you understand the exact product line (e.g. Health, Map, Apple Pay, iOS Core) you are interviewing for.",
            "Show extreme user empathy and a taste for simple, elegant UI/UX design.",
            "Prioritize privacy and security in every product feature discussion."
        ]
    },
    "amazon": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Overview of background, resume scan, and general alignment with role requirements."},
            {"title": "2. Phone / Video Screen (60m)", "desc": "1-2 rounds with PMs focusing on behavioral scenarios (Leadership Principles) and product design case questions."},
            {"title": "3. Onsite Loop (5-6 rounds)", "desc": "Intense rounds focusing on Amazon Leadership Principles (Customer Obsession, Ownership, Dive Deep, Deliver Results). Typically includes a writing exercise (6-pager/PRFAQ critique) and a Product Design/Execution case."}
        ],
        "tips": [
            "Prepare 10-12 STAR stories mapped to Amazon's Leadership Principles. Every single question is evaluated against them.",
            "Understand their document culture. Be comfortable discussing how you write product specification docs, PRFAQs, or 6-pagers.",
            "Amazon PMs are expected to be highly analytical. Be ready to drill down into metrics, costs, and customer funnels."
        ]
    },
    "nvidia": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "General background and salary expectations checking. Focus on technical background."},
            {"title": "2. Technical Hiring Manager Screen (60m)", "desc": "Interview with the PM lead focusing on GPU architecture, machine learning system workflows, software developer kits (e.g. CUDA, TensorRT), or specific vertical applications."},
            {"title": "3. Onsite Panel (4-5 rounds)", "desc": "Deep technical system design, developer ecosystem strategy, cross-functional execution with HW/SW engineers, and product roadmap prioritization."}
        ],
        "tips": [
            "Possess a strong technical baseline: understand GPU virtualization, developer tooling, parallel compute, or deep learning libraries.",
            "Highlight developer empathy: Nvidia products are built for software engineers, research scientists, and system architects.",
            "Demonstrate a solid understanding of the AI compute hardware stack."
        ]
    },
    "meta": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Review of PM background, interest in Meta, and mapping to appropriate PM level."},
            {"title": "2. Product Sense Screen (45m)", "desc": "First round case check: product design, user segmentations, prioritizations, and success metrics definition."},
            {"title": "3. Onsite Loop (4-5 rounds)", "desc": "Includes Product Sense (product design), Execution (metrics, analytics, debugging, prioritization), Leadership & Drive (behavioral, cross-functional collaboration, challenges), and Product Strategy (long-term tech/business vision)."}
        ],
        "tips": [
            "Execution is heavily focused on data: practice metrics frameworks, handling bug triage, and trade-off metrics (e.g., user growth vs retention).",
            "Align strategy with Meta's pillars (connecting people, developer tools, open-source AI, VR/AR).",
            "Be structured and decisive: state your frameworks and stick to them."
        ]
    },
    "tesla": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Basic alignment on background, interest in Tesla's mission, and salary expectations."},
            {"title": "2. Technical & PM Screen (45m)", "desc": "Screening with hiring manager, focusing on physical engineering processes, software-hardware integrations, supply chain constraints, or autonomy software."},
            {"title": "3. Onsite Loop & Presentation (5-6 rounds)", "desc": "Deep technical loops with hardware, manufacturing, software, and PM leads. Usually includes a 45-minute technical presentation on a past complex project you shipped."}
        ],
        "tips": [
            "Demonstrate a high tolerance for chaos and quick decision cycles. Tesla operates at extreme speeds.",
            "Be highly technical: understand physical architectures, manufacturing constraints, code optimization, or machine learning pipelines (e.g., FSD occupancy networks).",
            "Show extreme alignment with Tesla's mission of accelerating sustainable transition."
        ]
    },
    "netflix": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Core values screening. Extremely focused on whether you fit the 'Freedom and Responsibility' culture."},
            {"title": "2. Initial Technical / Product Screen (45m)", "desc": "1-2 video calls with PMs focusing on product intuition, strategic thinking, and telemetry/testing standards."},
            {"title": "3. Onsite Panel (4-5 rounds)", "desc": "Interviews with Product Directors, VPs of Product, engineering leads, and design heads. Highly collaborative case-oriented discussions, probing metrics, prioritization, and cultural alignment (Keeper Test questions)."}
        ],
        "tips": [
            "Memorize and internalize the Netflix Culture Memo. Every interviewer will evaluate you against it.",
            "Expect a strong emphasis on data-driven decision-making, particularly A/B testing and cohort metrics.",
            "Netflix values 'Stunners'—PMs who can operate with near-absolute autonomy without close supervision."
        ]
    },
    "openai": {
        "stages": [
            {"title": "1. Recruiter Sync (30m)", "desc": "Introductory call on background, interest in artificial intelligence, and alignment with safety mission."},
            {"title": "2. Technical Case Study & API Round (60m)", "desc": "Probing your technical understanding of large language models, compute constraints, prompt engineering, and pricing APIs. Usually involves a technical system walkthrough."},
            {"title": "3. Onsite Loop (4 rounds)", "desc": "Rounds with ML Research Engineers, PM Directors, and Product designers. Probing product intuition, engineering collaboration, AI safety alignment, and developer ecosystem strategy."}
        ],
        "tips": [
            "Possess a strong technical baseline: understand transformers, context windows, tokens, latency, fine-tuning vs RAG.",
            "Prepare for developer-focused product questions (APIs, developer platforms, developer experience).",
            "Demonstrate a high priority for safety, alignment, and responsible product deployment."
        ]
    },
    "anthropic": {
        "stages": [
            {"title": "1. Recruiter Call (30m)", "desc": "Alignment on background, interest in safety-oriented AI, and values."},
            {"title": "2. Technical Spec Exercise (60m)", "desc": "Critique or design a product specification for an AI feature. Focuses on system architecture, safety boundaries, latency, and user interface design."},
            {"title": "3. Virtual Onsite Loop (4 rounds)", "desc": "Interviews testing engineering collaboration, AI safety principles, product strategy, and organizational values."}
        ],
        "tips": [
            "Read Anthropic's research blogs on Constitutional AI, alignment, and model safety.",
            "Be prepared to answer how to balance commercial pressure to deploy features with security and safety protocols.",
            "Demonstrate familiarity with Claude and developer tools."
        ]
    },
    "huggingface": {
        "stages": [
            {"title": "1. Introductory Sync (30m)", "desc": "Aligning on open-source philosophy, ML background, and developer relations."},
            {"title": "2. Open-Source Product Spec (60m)", "desc": "Case round reviewing how you would drive hub integrations, Spaces usage, or API monetization while keeping the core platform open-source friendly."},
            {"title": "3. Engineering & Community Panel (45m)", "desc": "Round evaluating collaboration with open-source engineering teams and external developers."}
        ],
        "tips": [
            "Be active in or highly familiar with the Hugging Face Hub ecosystem.",
            "Show how you balance developer developer-centric community goals with enterprise SaaS monetization.",
            "Emphasize transparency and open-source values."
        ]
    },
    "datadog": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Technical screen assessing familiarity with Cloud, Devops, and monitoring landscapes."},
            {"title": "2. Telemetry Case Study (60m)", "desc": "Designing a dashboard, alert rule, or integration for cloud services. Focus on data modeling and developer personas."},
            {"title": "3. Onsite Panel (4 rounds)", "desc": "System design, PM case study, engineering collab, and executive alignment."}
        ],
        "tips": [
            "Understand DevOps pipelines, APM, logging, metrics, traces, and Kubernetes/Cloud architectures.",
            "Target highly technical user personas (SREs, System Architects, Developers).",
            "Focus on execution: how to roll out features in short, iterative cycles."
        ]
    },
    "cockroachlabs": {
        "stages": [
            {"title": "1. Initial Screen (30m)", "desc": "Overview of database market experience, career goals, and basic technical screen."},
            {"title": "2. Database Case Study (60m)", "desc": "Designing a feature or SaaS pricing model for a distributed database. Probing system design and developer experience (DX)."},
            {"title": "3. Onsite Loop (4 rounds)", "desc": "Technical/DB architecture sync, PM product design round, collaborative planning round, and cultural values."}
        ],
        "tips": [
            "Familiarize yourself with CockroachDB architecture (RAFT consensus, distributed transactions, SQL parsing).",
            "Focus on developer experience (DX) and reliability constraints (multi-region latency, zero downtime).",
            "Be structured and precise in analytical answers."
        ]
    },
    "disney": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "General background review, salary alignment, and interest in Disney Streaming Services."},
            {"title": "2. PM Interview (60m)", "desc": "Product case study on video player features, streaming quality of service, content discovery algorithms, or app store billing integrations."},
            {"title": "3. Panel Interview (3 rounds)", "desc": "Consumer metrics, cross-functional collaboration with creative teams, and technical feasibility."}
        ],
        "tips": [
            "Understand core streaming metrics: subscriber growth, acquisition cost (CAC), churn, engagement, watch-time.",
            "Be prepared to speak about consumer platforms (Smart TVs, mobile, web, game consoles) and video encoding fundamentals.",
            "Emphasize a customer-first approach to personalization and content recommendations."
        ]
    }
}

def load_config_json():
    if not os.path.exists(CONFIG_PATH):
        return {"search_criteria": {}, "companies": []}
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config_json(config_data):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config_data, f, indent=2)

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

def get_insights(company_name):
    normalized = company_name.lower().replace(" ", "")
    for key, data in INTERVIEW_INSIGHTS.items():
        if key in normalized:
            return data
    return {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Resume review, experience sanity check, and motivation for joining."},
            {"title": "2. Hiring Manager Screen (45m)", "desc": "Reviewing past PM successes/failures, alignment with company roadmap, and basic product design case."},
            {"title": "3. Product Case / Panel (60m)", "desc": "Product design or strategy exercise. Focus on user needs, prioritization, metrics, and technical viability."},
            {"title": "4. Onsite/Collaborative Rounds", "desc": "Interviews with Engineering leads, UI/UX designers, and cross-functional partners evaluating execution and communication."}
        ],
        "tips": [
            "Research the company's core product, business model, and recent news/releases.",
            "Prepare 3 strong STAR-method stories illustrating leadership, engineering collaboration, and data-driven prioritization.",
            "Be customer-centric: always start case questions by identifying who the target users are and what problems they face."
        ]
    }

def background_scan_thread():
    global is_scanning
    print("Background thread scan started...")
    try:
        python_executable = sys.executable
        script_path = os.path.join(SCRIPTS_DIR, "check_new_jobs.py")
        
        # Stream output in real-time using subprocess.Popen
        # Run python with -u flag to disable buffering of stdout/stderr
        process = subprocess.Popen(
            [python_executable, "-u", script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        
        # Read stdout line by line and print to console
        while True:
            line = process.stdout.readline()
            if not line:
                break
            print(f"[Crawler] {line.rstrip()}")
            
        process.wait(timeout=900)  # Safe timeout of 15 minutes
        if process.returncode == 0:
            print("Background thread scan completed successfully.")
        else:
            print(f"Background thread scan failed with return code {process.returncode}")
    except subprocess.TimeoutExpired:
        print("Background thread scan timed out after 900 seconds.")
        if 'process' in locals():
            process.kill()
    except Exception as e:
        print("Error during background thread scan:", e)
        traceback.print_exc()
    finally:
        with scan_lock:
            is_scanning = False

@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

def update_amazon_portal_url(url, selected_levels):
    import urllib.parse
    if not selected_levels:
        query = "product manager"
    else:
        if "Standard" in selected_levels or "Generic" in selected_levels:
            query = "product manager"
        elif "Senior" in selected_levels:
            query = "senior product manager"
        elif "Principal" in selected_levels:
            query = "principal product manager"
        elif "Staff" in selected_levels:
            query = "staff product manager"
        elif "Director" in selected_levels:
            query = "director of product"
        elif "Vice President" in selected_levels or "VP" in selected_levels:
            query = "vp of product"
        else:
            query = "product manager"
            
    parsed = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qs(parsed.query)
    params["base_query"] = [query]
    new_query = urllib.parse.urlencode(params, doseq=True)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_query, parsed.fragment))

# --- SEARCH CRITERIA API ---
@app.route('/api/criteria', methods=['GET'])
def get_criteria():
    config = load_config_json()
    return jsonify(config.get("search_criteria", {}))

@app.route('/api/criteria', methods=['POST'])
def save_criteria():
    try:
        data = request.get_json()
        config = load_config_json()
        
        # 1. Update search criteria
        if "search_criteria" in data:
            config["search_criteria"] = data["search_criteria"]
        else:
            config["search_criteria"] = {
                "locations": data.get("locations", []),
                "custom_keywords": data.get("custom_keywords", []),
                "strict_level_filtering": data.get("strict_level_filtering", False)
            }
            
        # 2. Update company levels if provided
        if "companies" in data:
            company_levels = {c.get("name", "").lower().strip(): c.get("levels", []) for c in data["companies"] if c.get("name")}
            for co in config.get("companies", []):
                co_name_lower = co.get("name", "").lower().strip()
                if co_name_lower in company_levels:
                    co["levels"] = company_levels[co_name_lower]
                    
        # 3. Update Amazon portal URL using Amazon's level settings
        amazon_levels = []
        for co in config.get("companies", []):
            if co.get("name", "").lower() == "amazon":
                amazon_levels = co.get("levels", [])
                co["portal_url"] = update_amazon_portal_url(co.get("portal_url", ""), amazon_levels)
                break
                
        save_config_json(config)
        return jsonify({"success": True, "message": "Search parameters and levels saved successfully."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- COMPANIES API ---
@app.route('/api/companies', methods=['GET'])
def get_companies():
    config = load_config_json()
    companies = config.get("companies", [])
    
    config_changed = False
    for co in companies:
        if "levels" not in co or co["levels"] is None:
            name_lower = co.get("name", "").lower().strip()
            if name_lower == "google":
                co["levels"] = ["Product Manager I", "Product Manager II", "Senior", "Group", "Director", "Senior Director", "Vice President"]
            elif name_lower == "meta":
                co["levels"] = ["Standard", "Leadership"]
            elif name_lower == "microsoft":
                co["levels"] = ["Standard", "Senior", "Principal", "Director", "Senior Director", "Vice President"]
            elif name_lower == "netflix":
                co["levels"] = ["Standard (up to L6)", "Group", "Director", "Senior Director", "Vice President"]
            elif name_lower in ["amazon", "nvidia"]:
                co["levels"] = ["Standard", "Senior", "Principal", "Director", "Senior Director", "Vice President"]
            elif name_lower in ["openai", "anthropic", "perplexity", "cursor"]:
                co["levels"] = ["Standard"]
            elif name_lower == "apple":
                co["levels"] = ["Standard", "Director", "Senior Director"]
            elif name_lower == "datadog":
                co["levels"] = ["Standard", "Senior", "Group", "Staff", "Principal", "Director", "Senior Director", "Vice President", "Chief Product Officer"]
            else:
                co["levels"] = ["Standard", "Senior", "Staff", "Principal", "Director", "Senior Director", "Vice President", "Chief Product Officer"]
            config_changed = True
            
    if config_changed:
        config["companies"] = companies
        save_config_json(config)
        
    return jsonify(companies)

def single_company_scan_thread(company_name):
    global is_scanning
    print(f"Background single-company scan started for {company_name}...")
    try:
        python_executable = sys.executable
        script_path = os.path.join(SCRIPTS_DIR, "check_new_jobs.py")
        
        process = subprocess.Popen(
            [python_executable, "-u", script_path, company_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        
        while True:
            line = process.stdout.readline()
            if not line:
                break
            print(f"[SingleCrawler:{company_name}] {line.rstrip()}")
            
        process.wait(timeout=240)  # Double the timeout to 4 minutes
        if process.returncode == 0:
            print(f"Background single-company scan completed for {company_name}.")
        else:
            print(f"Background single-company scan failed for {company_name} with return code {process.returncode}")
    except subprocess.TimeoutExpired:
        print(f"Background single-company scan timed out for {company_name} after 240 seconds.")
        if 'process' in locals():
            process.kill()
    except Exception as e:
        print(f"Error during background single-company scan for {company_name}:", e)
        traceback.print_exc()
    finally:
        with scan_lock:
            is_scanning = False

def delete_company_jobs_from_excel(company_name):
    if not os.path.exists(TRACKER_PATH):
        return 0
    try:
        wb = openpyxl.load_workbook(TRACKER_PATH)
        if "Job Leads" in wb.sheetnames:
            ws = wb["Job Leads"]
            deleted_count = 0
            # Iterate backwards to avoid row offset shift bugs
            for r_idx in range(ws.max_row, 1, -1):
                company_val = ws.cell(row=r_idx, column=3).value
                if company_val and company_val.lower().strip() == company_name.lower().strip():
                    ws.delete_rows(r_idx)
                    deleted_count += 1
            if deleted_count > 0:
                wb.save(TRACKER_PATH)
            return deleted_count
    except Exception as e:
        print(f"Error deleting jobs for company '{company_name}' from Excel:", e)
    return 0

@app.route('/api/companies', methods=['POST'])
def add_company():
    try:
        new_co = request.get_json()
        name = new_co.get("name", "").strip()
        if not name:
            return jsonify({"error": "Company name is required"}), 400
            
        config = load_config_json()
        companies = config.get("companies", [])
        if any(c.get("name", "").lower() == name.lower() for c in companies):
            return jsonify({"error": f"Company '{name}' is already in your tracked list."}), 400
            
        portal_url = new_co.get("portal_url", "").strip()
        if not portal_url:
            return jsonify({"error": "Careers Search Portal URL is required"}), 400
            
        # Detect platform and board ID from careers portal URL
        import urllib.parse
        platform = "ddg"
        board_id = ""
        portal_url_lower = portal_url.lower()
        name_lower = name.lower()

        if "doordash" in portal_url_lower or name_lower == "doordash":
            platform = "greenhouse"
            board_id = "doordashusa"
        elif "google.com" in portal_url_lower:
            platform = "google"
        elif "microsoft.com" in portal_url_lower:
            platform = "microsoft"
        elif "netflix.com" in portal_url_lower:
            platform = "netflix"
        elif "amazon.jobs" in portal_url_lower or "amazon.com" in portal_url_lower:
            platform = "amazon"
        elif "nvidia.com" in portal_url_lower:
            platform = "nvidia"
            board_id = "NVIDIAExternalCareerSite"
        elif "metacareers.com" in portal_url_lower or "meta.com" in portal_url_lower:
            platform = "meta"
        elif "tesla.com" in portal_url_lower:
            platform = "tesla"
        elif "apple.com" in portal_url_lower:
            platform = "apple"
        elif "greenhouse.io" in portal_url_lower:
            platform = "greenhouse"
            parsed_url = urllib.parse.urlparse(portal_url)
            path_parts = [p for p in parsed_url.path.split('/') if p]
            if path_parts:
                board_id = path_parts[-1]
        elif "ashbyhq.com" in portal_url_lower:
            platform = "ashby"
            parsed_url = urllib.parse.urlparse(portal_url)
            path_parts = [p for p in parsed_url.path.split('/') if p]
            if path_parts:
                board_id = path_parts[-1]
        elif "workable.com" in portal_url_lower:
            platform = "workable"
            parsed_url = urllib.parse.urlparse(portal_url)
            path_parts = [p for p in parsed_url.path.split('/') if p]
            if path_parts:
                board_id = path_parts[0]
                
        capability = "portal_only" if platform in ["tesla", "ddg"] else "active_sync"

        # Determine default levels if none provided in POST request
        levels = new_co.get("levels", [])
        if not levels:
            name_lower = name.lower().strip()
            if name_lower == "google":
                levels = ["Product Manager I", "Product Manager II", "Senior", "Group", "Director", "Senior Director", "Vice President"]
            elif name_lower == "meta":
                levels = ["Standard", "Leadership"]
            elif name_lower == "microsoft":
                levels = ["Standard", "Senior", "Principal", "Director", "Senior Director", "Vice President"]
            elif name_lower == "netflix":
                levels = ["Standard (up to L6)", "Group", "Director", "Senior Director", "Vice President"]
            elif name_lower in ["amazon", "nvidia"]:
                levels = ["Standard", "Senior", "Principal", "Director", "Senior Director", "Vice President"]
            elif name_lower in ["openai", "anthropic", "perplexity", "cursor"]:
                levels = ["Standard"]
            elif name_lower == "apple":
                levels = ["Standard", "Director", "Senior Director"]
            elif name_lower == "datadog":
                levels = ["Standard", "Senior", "Group", "Staff", "Principal", "Director", "Senior Director", "Vice President", "Chief Product Officer"]
            else:
                levels = ["Standard", "Senior", "Staff", "Principal", "Director", "Senior Director", "Vice President", "Chief Product Officer"]

        companies.append({
            "name": name,
            "platform": platform,
            "board_id": board_id,
            "cohort": new_co.get("cohort", "Non-Mag 7").strip(),
            "hq": "N/A",
            "founded": "N/A",
            "revenue": "N/A",
            "employees": "N/A",
            "domain": "N/A",
            "capability": capability,
            "portal_url": portal_url,
            "levels": levels
        })
        config["companies"] = companies
        save_config_json(config)

        # Trigger single company scan immediately in background
        global is_scanning
        with scan_lock:
            is_scanning = True
        thread = threading.Thread(target=single_company_scan_thread, args=(name,))
        thread.daemon = True
        thread.start()

        return jsonify({"success": True, "message": f"Company '{name}' added. Starting immediate crawl scan in the background..."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/companies/<string:company_name>', methods=['DELETE'])
def delete_company(company_name):
    try:
        config = load_config_json()
        companies = config.get("companies", [])
        
        company_exists = any(c.get("name", "").lower() == company_name.lower().strip() for c in companies)
        if not company_exists:
            return jsonify({"error": f"Company '{company_name}' not found."}), 404
            
        # Filter out company
        updated_companies = [c for c in companies if c.get("name", "").lower() != company_name.lower().strip()]
        config["companies"] = updated_companies
        save_config_json(config)
        
        # Delete jobs related to that company from Excel
        deleted_jobs = delete_company_jobs_from_excel(company_name)
        
        # Invalidate in-memory cache to force immediate reload
        JOBS_CACHE["last_loaded_mtime"] = 0
        
        return jsonify({
            "success": True, 
            "message": f"Company '{company_name}' removed. Deleted {deleted_jobs} related job listings from spreadsheet."
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- COMPANY SPECIFIC INFO ---
@app.route('/api/company-info', methods=['GET'])
def get_company_info():
    company_name = request.args.get("company", "").strip().lower()
    config = load_config_json()
    
    for co in config.get("companies", []):
        if co.get("name", "").lower() == company_name:
            return jsonify(co)
            
    return jsonify({
        "name": request.args.get("company", "Generic"),
        "hq": "Information not tracked",
        "founded": "N/A",
        "revenue": "Unknown / Private",
        "employees": "N/A",
        "domain": "Technology"
    })

# --- JOBS LIST API (ASYNCHRONOUS AUTO-TRIGGER GENTLE FIRST SCAN) ---
@app.route('/api/jobs', methods=['GET'])
def get_jobs():
    try:
        global auto_scan_triggered, is_scanning
        
        # Trigger background scan automatically on first load in session
        if not auto_scan_triggered:
            with scan_lock:
                if not is_scanning:
                    is_scanning = True
                    auto_scan_triggered = True
                    thread = threading.Thread(target=background_scan_thread)
                    thread.daemon = True
                    thread.start()
                    print("Auto-first scan triggered asynchronously in background thread.")
        
        jobs, last_scanned = load_jobs_from_excel()
        
        return jsonify({
            "jobs": jobs,
            "last_scanned": last_scanned,
            "is_scanning": is_scanning
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/jobs/<int:row_id>/status', methods=['POST'])
def update_job_status(row_id):
    try:
        data = request.get_json()
        new_status = data.get("status")
        
        if new_status not in ["Lead", "Consideration", "Archived"]:
            return jsonify({"error": f"Invalid status: {new_status}"}), 400
            
        if not os.path.exists(TRACKER_PATH):
            return jsonify({"error": "Job leads tracker file not found."}), 404
            
        wb = openpyxl.load_workbook(TRACKER_PATH)
        ws = wb["Job Leads"]
        
        if row_id < 2 or row_id > ws.max_row:
            return jsonify({"error": f"Invalid job ID: {row_id}"}), 400
            
        ws.cell(row=row_id, column=7).value = new_status
        
        if new_status == "Consideration":
            ws.cell(row=row_id, column=1).value = "[x]"
            ws.cell(row=row_id, column=15).value = ""
        elif new_status == "Archived":
            ws.cell(row=row_id, column=1).value = "[ ]"
            # Set to User Archived unless it's already set (e.g. was auto-archived as Closed)
            if not ws.cell(row=row_id, column=15).value:
                ws.cell(row=row_id, column=15).value = "User Archived"
        else:
            ws.cell(row=row_id, column=1).value = "[ ]"
            ws.cell(row=row_id, column=15).value = ""
            
        wb.save(TRACKER_PATH)
        
        # Invalidate in-memory cache to force immediate reload
        JOBS_CACHE["last_loaded_mtime"] = 0
        
        return jsonify({"success": True, "message": f"Job row {row_id} updated to {new_status}."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/jobs/<int:row_id>', methods=['DELETE'])
def delete_job(row_id):
    try:
        if not os.path.exists(TRACKER_PATH):
            return jsonify({"error": "Job leads tracker file not found."}), 404
            
        wb = openpyxl.load_workbook(TRACKER_PATH)
        ws = wb["Job Leads"]
        
        if row_id < 2 or row_id > ws.max_row:
            return jsonify({"error": f"Invalid job ID: {row_id}"}), 400
            
        ws.delete_rows(row_id)
        wb.save(TRACKER_PATH)
        
        # Invalidate in-memory cache to force immediate reload
        JOBS_CACHE["last_loaded_mtime"] = 0
        
        return jsonify({"success": True, "message": f"Job row {row_id} deleted successfully."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- JOBS TRACKING DETAILS API ---
@app.route('/api/jobs/<int:row_id>/tracking', methods=['POST'])
def update_job_tracking(row_id):
    try:
        data = request.get_json()
        app_status = data.get("app_status", "Not Applied")
        app_outcome = data.get("app_outcome", "Active / Pending")
        resume_url = data.get("resume_url", "")
        
        if not os.path.exists(TRACKER_PATH):
            return jsonify({"error": "Job leads tracker file not found."}), 404
            
        wb = openpyxl.load_workbook(TRACKER_PATH)
        ws = wb["Job Leads"]
        
        if row_id < 2 or row_id > ws.max_row:
            return jsonify({"error": f"Invalid job ID: {row_id}"}), 400
            
        # Ensure tracking headers exist in Excel
        if ws.max_column < 14 or ws.cell(row=1, column=12).value is None:
            ws.cell(row=1, column=11).value = "Compensation"
            ws.cell(row=1, column=12).value = "App Status"
            ws.cell(row=1, column=13).value = "App Outcome"
            ws.cell(row=1, column=14).value = "Resume Link"
            
        ws.cell(row=row_id, column=12).value = app_status
        ws.cell(row=row_id, column=13).value = app_outcome
        ws.cell(row=row_id, column=14).value = resume_url
        
        wb.save(TRACKER_PATH)
        
        # Invalidate in-memory cache to force immediate reload
        JOBS_CACHE["last_loaded_mtime"] = 0
        
        return jsonify({"success": True, "message": "Application tracking updated successfully in Excel."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- ASYNC SCAN TRIGGER API ---
@app.route('/api/scan', methods=['POST'])
def run_scan():
    global is_scanning
    with scan_lock:
        if is_scanning:
            return jsonify({"success": False, "error": "A scan is already in progress in the background."}), 400
        is_scanning = True
        
    thread = threading.Thread(target=background_scan_thread)
    thread.daemon = True
    thread.start()
    
    return jsonify({
        "success": True,
        "message": "Crawl scan started asynchronously in the background thread."
    })

# --- SCAN STATUS API ---
@app.route('/api/scan-status', methods=['GET'])
def get_scan_status():
    global is_scanning
    return jsonify({"is_scanning": is_scanning})

@app.route('/api/job-description', methods=['GET'])
def get_job_description():
    url = request.args.get("url")
    if not url or is_placeholder_url(url):
        return jsonify({
            "description": "<p><strong>Placeholder URL:</strong> No direct job description can be parsed. This occurs when the automated crawl only identifies the careers landing portal. Please follow the link below to search for this role on the company's careers site.</p>"
        })
        
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5"
        }
        
        r = requests.get(url, headers=headers, timeout=12)
        if r.status_code != 200:
            return jsonify({
                "description": f"<p><strong>Failed to load content:</strong> The remote server returned status code {r.status_code}. <a href='{url}' target='_blank' class='inline-link'>Click here to open the page directly.</a></p>"
            })
            
        soup = BeautifulSoup(r.text, 'html.parser')
        
        desc_html = ""
        
        # Try to parse Apple Careers first
        if "jobs.apple.com" in url.lower():
            import re
            match = re.search(r'window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\);', r.text)
            if match:
                try:
                    escaped_json = match.group(1)
                    raw_json_str = json.loads(f'"{escaped_json}"')
                    data = json.loads(raw_json_str)
                    job_data = data.get("loaderData", {}).get("jobDetails", {}).get("jobsData", {})
                    if job_data:
                        summary = job_data.get('jobSummary', '')
                        if summary:
                            desc_html += f"<h3>Job Summary</h3><p>{summary}</p>"
                        
                        desc_text = job_data.get('description', '')
                        if desc_text:
                            desc_text_html = desc_text.replace('\n', '<br/>')
                            desc_html += f"<h3>Description</h3><p>{desc_text_html}</p>"
                            
                        min_quals = job_data.get('minimumQualifications', '')
                        if min_quals:
                            quals_list = "".join(f"<li>{q.strip()}</li>" for q in min_quals.split("\n") if q.strip())
                            desc_html += f"<h3>Minimum Qualifications</h3><ul>{quals_list}</ul>"
                            
                        pref_quals = job_data.get('preferredQualifications', '')
                        if pref_quals:
                            pref_list = "".join(f"<li>{q.strip()}</li>" for q in pref_quals.split("\n") if q.strip())
                            desc_html += f"<h3>Preferred Qualifications</h3><ul>{pref_list}</ul>"
                except Exception as e:
                    print("Error parsing Apple details page hydration data:", e)
                    
        # 1. Try to extract description from JSON-LD schema (JobPosting)
        if not desc_html:
            for s in soup.find_all('script', type='application/ld+json'):
                try:
                    data = json.loads(s.string or "")
                    if isinstance(data, dict):
                        if data.get("@type") == "JobPosting" and data.get("description"):
                            desc_html = data["description"]
                            break
                    elif isinstance(data, list):
                        for item in data:
                            if isinstance(item, dict) and item.get("@type") == "JobPosting" and item.get("description"):
                                desc_html = item["description"]
                                break
                        if desc_html:
                            break
                except Exception:
                    pass
                
        # If not found via JSON-LD, fall back to parsing the HTML body
        if not desc_html:
            for element in soup(["script", "style", "nav", "footer", "header", "noscript"]):
                element.decompose()
        url_lower = url.lower()
        
        if "greenhouse.io" in url_lower:
            container = soup.find(id="content") or soup.find(class_="job-body") or soup.find(id="main")
            if container:
                desc_html = str(container)
        elif "ashbyhq.com" in url_lower:
            container = soup.find(class_="_jobPosting_") or soup.find(class_="job-posting") or soup.find(id="app")
            if container:
                desc_html = str(container)
        elif "workable.com" in url_lower:
            container = soup.find(attrs={"data-ui": "job-description"}) or soup.find(class_="section--job-description")
            if container:
                desc_html = str(container)
        elif "careers.google.com" in url_lower or "google.com/about/careers" in url_lower:
            container = soup.find(class_="job-description") or soup.find(attrs={"itemprop": "description"}) or soup.find(class_="gc-card__job-description")
            if container:
                desc_html = str(container)
                
        if not desc_html:
            candidates = soup.find_all(lambda tag: tag.name in ['div', 'section', 'article'] and 
                                      (any('description' in str(attr).lower() for attr in tag.attrs.values()) or
                                       any('job-body' in str(attr).lower() for attr in tag.attrs.values()) or
                                       any('posting' in str(attr).lower() for attr in tag.attrs.values())))
            
            if candidates:
                candidates = sorted(candidates, key=lambda tag: len(tag.text), reverse=True)
                desc_html = str(candidates[0])
            else:
                body = soup.find('body')
                if body:
                    main = body.find('main') or body.find('article') or body.find(id='content')
                    if main:
                        desc_html = str(main)
                    else:
                        paragraphs = body.find_all(['p', 'ul', 'ol', 'h1', 'h2', 'h3'])
                        desc_html = "".join(str(p) for p in paragraphs[:30])
                        
        if not desc_html:
            desc_html = f"<p>Could not extract the description text automatically. Please <a href='{url}' target='_blank' class='inline-link'>view the job posting on the careers page.</a></p>"
            
        return jsonify({
            "description": desc_html
        })
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "description": f"<p><strong>Error loading description:</strong> {str(e)}. <a href='{url}' target='_blank' class='inline-link'>Open job listing directly.</a></p>"
        })

@app.route('/api/insights', methods=['GET'])
def get_company_insights():
    company = request.args.get("company", "")
    insights = get_insights(company)
    return jsonify(insights)

# --- LINKEDIN CONNECTIONS API ---
CONNECTIONS_PATH = r"G:\My Drive\.Agents\1_Projects\2026 Job Search\board\connections.json"

def load_connections():
    if not os.path.exists(CONNECTIONS_PATH):
        return []
    try:
        with open(CONNECTIONS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print("Error loading connections:", e)
        return []

def save_connections(data):
    try:
        with open(CONNECTIONS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        print("Error saving connections:", e)
        return False

@app.route('/api/connections', methods=['GET'])
def get_connections():
    return jsonify(load_connections())

@app.route('/api/connections/clear', methods=['POST'])
def clear_connections():
    if save_connections([]):
        return jsonify({"success": True, "message": "Connections cleared successfully."})
    return jsonify({"error": "Failed to clear connections."}), 500

@app.route('/api/connections/upload', methods=['POST'])
def upload_connections():
    import csv
    import io
    import urllib.parse
    
    if 'file' not in request.files:
        return jsonify({"error": "No file part in the request."}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file."}), 400
        
    if not file.filename.endswith('.csv'):
        return jsonify({"error": "Only CSV files are supported."}), 400
        
    try:
        # Read the file content as text
        stream = io.StringIO(file.stream.read().decode("utf-8"), newline=None)
        csv_content = stream.read()
        
        lines = csv_content.splitlines()
        header_idx = -1
        for idx, line in enumerate(lines):
            # Check if this line looks like the header
            if "First Name" in line and "Last Name" in line:
                header_idx = idx
                break
                
        if header_idx == -1:
            header_idx = 0
            
        csv_data = "\n".join(lines[header_idx:])
        reader = csv.DictReader(io.StringIO(csv_data))
        
        # Normalize header names (strip whitespace and remove BOM if present)
        if reader.fieldnames:
            reader.fieldnames = [name.strip().replace('\ufeff', '') for name in reader.fieldnames]
            
        parsed_connections = []
        for row in reader:
            first_name = (row.get("First Name") or "").strip()
            last_name = (row.get("Last Name") or "").strip()
            company = (row.get("Company") or "").strip()
            position = (row.get("Position") or "").strip()
            url = (row.get("URL") or "").strip()
            
            # Skip rows where name is empty
            if not first_name and not last_name:
                continue
                
            # If no URL is provided, generate a search URL
            if not url:
                query = f"{first_name} {last_name}".strip()
                url = f"https://www.linkedin.com/search/results/people/?keywords={urllib.parse.quote(query)}"
                
            parsed_connections.append({
                "first_name": first_name,
                "last_name": last_name,
                "company": company,
                "position": position,
                "url": url
            })
            
        save_connections(parsed_connections)
        return jsonify({
            "success": True, 
            "message": f"Successfully parsed and saved {len(parsed_connections)} connections.",
            "connections": parsed_connections
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"Failed to parse CSV file: {str(e)}"}), 500

if __name__ == '__main__':
    print("Starting My Job Board backend on http://localhost:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
