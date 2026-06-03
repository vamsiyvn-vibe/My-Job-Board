import os
import sys
from io import BytesIO
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request

# If modifying these scopes, delete the file token.json.
SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']

CREDENTIALS_FILE = r"G:\My Drive\.Agents\1_Projects\2026 Job Search\credentials.json"
TOKEN_FILE = r"G:\My Drive\.Agents\1_Projects\2026 Job Search\token.json"

PRD_HTML = """
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Product Requirement Document (PRD): Automated PM Job Board</title>
</head>
<body>
    <h1>Product Requirement Document (PRD): Automated PM Job Board</h1>
    
    <h2>1. Executive Summary</h2>
    <p>Finding high-quality Product Management (PM) opportunities at premier companies (Mag 7, AI Labs, High-Growth Startups) is a time-consuming, highly fragmented process. Companies frequently update their internal portals, change job details, or close listings without notifying job aggregators immediately.</p>
    <p>This Job Board project solves this by creating a unified, automated, developer-fluent, and self-updating PM Job Leads tracking board. The board runs lightweight, targeted web scraping pipelines against target company career portals, updates a centralized Excel spreadsheet, and renders an interactive, premium web dashboard.</p>
    
    <hr>
    
    <h2>2. Key Problem Statements</h2>
    <ol>
        <li><strong>API and URL Fragmentation:</strong> Major platforms (Google, Microsoft, Meta, Amazon, Apple, Nvidia, Netflix) use completely different architectures (Eightfold PCSX, Phenom, Workday, Greenhouse, Ashby, custom GraphQL/batch endpoints), making standard HTML scrapers obsolete quickly.</li>
        <li><strong>Duplicate & Redundant Listings:</strong> Traditional job sites often display outdated or duplicate postings. Job hunters need to see only <strong>net new</strong> listings.</li>
        <li><strong>Ghost Postings:</strong> Closed roles continue to sit on job boards long after hiring has ended. Automatic archival is necessary to verify active opportunities.</li>
        <li><strong>Compensation Extraction:</strong> Career portals bury salary ranges deep inside text descriptions, requiring candidates to open every listing manually.</li>
        <li><strong>No Level Filtering:</strong> Senior, Principal, and Director-level roles are mixed together, wasting search time for experienced candidates.</li>
    </ol>
    
    <hr>
    
    <h2>3. Key Product Features</h2>
    <ul>
        <li><strong>Active Sync Engine:</strong> Automatically runs daily scans across Greenhouse, Ashby, Workable, and custom endpoints (Google, Microsoft, Netflix, Nvidia, Apple, Meta, Amazon) to fetch PM listings.</li>
        <li><strong>Unified Status Workflow:</strong> Allows labeling jobs as <code>Lead</code>, <code>Consideration</code> (Double-click lists to view details), or <code>Archived</code>.</li>
        <li><strong>Archival Tracking & Reason-Mapping:</strong> Automatically archives roles that disappear from career portals, classifying them as <code>Closed</code>, while user-triggered archives are marked as <code>User Archived</code>.</li>
        <li><strong>Smart Compensation Extractor:</strong> Employs a multi-format regex parser to extract salary ranges from job descriptions, displaying them as columns in lists and highlights in cards.</li>
        <li><strong>Cohort-Based Level Filtering:</strong> Standardizes filters by target company cohorts (e.g. Mag 7 vs. Non-Mag 7 vs. High-Growth Startups vs. AI Labs) and supports strict level filtering (e.g. restricting Amazon to Principal PMs and above, and supporting a "Generic" target level for entries with no seniority titles).</li>
        <li><strong>Dynamic Company Feeds:</strong> Enables users to add new companies dynamically with auto-platform and board ID detection, immediately triggering a single-company scraper run and automatic data enrichment.</li>
    </ul>
    
    <hr>
    
    <h2>4. System Design & User Experience</h2>
    <p>The application is designed around a premium developer-style dashboard. Users can toggle between Grid Card layouts and dense spreadsheet List layouts, filter job listings by company name, location, cohort role level, and salary range (e.g. min $150k+, min $200k+, etc.). Double-clicking on a job card opens a slide-over modal containing the live scraped job description and a custom PM Interview Loop preparation guide customized for that company.</p>
    
    <hr>
    
    <h2>5. System Limitations & Mitigations</h2>
    <ul>
        <li><strong>Anti-Scraping / Cloudflare:</strong> Sites like Meta block direct requests. <em>Mitigation:</em> We use session-based cookie persistence and browser-impersonation headers (<code>Sec-Ch-Ua</code>, <code>Sec-Fetch-Mode</code>) to avoid 400 Bad Request errors.</li>
        <li><strong>Rate Limits:</strong> Rapid queries can cause IP bans. <em>Mitigation:</em> The scrapers implement sleep delays (e.g., 0.2s - 0.5s) between consecutive detail page queries.</li>
        <li><strong>Schema Drift:</strong> If a company updates its GraphQL query ID or changes its endpoint, the scraper will fail. <em>Mitigation:</em> The architecture falls back to generic DuckDuckGo search indexes if the main API endpoint throws an exception.</li>
    </ul>
</body>
</html>
"""

TDD_HTML = """
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Technical Design Document (TDD): Automated PM Job Board</title>
</head>
<body>
    <h1>Technical Design Document (TDD): Automated PM Job Board</h1>
    
    <h2>1. System Architecture Overview</h2>
    <p>The application consists of three main components: a crawler/scraper script, a central Excel-based database, and a local Flask API server that serves the frontend UI. The application is completely local, ensuring all credentials, spreadsheets, and scraper configurations are stored securely on the user's G: Drive.</p>
    
    <table border="1" cellpadding="5" cellspacing="0">
        <thead>
            <tr style="background-color: #f2f2f2;">
                <th>Component</th>
                <th>File / Tech Stack</th>
                <th>Responsibilities</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>Database</strong></td>
                <td><code>Job_Leads_Tracker.xlsx</code></td>
                <td>Stores all job listings, cohorts, URLs, salaries, notes, and application status. Serves as the single source of truth.</td>
            </tr>
            <tr>
                <td><strong>Scraper Engine</strong></td>
                <td><code>scripts/check_new_jobs.py</code></td>
                <td>Executes web crawlers for all listed companies, filters listings, extracts salary ranges, and appends rows to Excel.</td>
            </tr>
            <tr>
                <td><strong>Flask API Server</strong></td>
                <td><code>board/server.py</code></td>
                <td>Serves UI static assets, reads Excel database with caching, handles status updates, scrapes job descriptions on-the-fly, and triggers background crawls.</td>
            </tr>
            <tr>
                <td><strong>Web Dashboard</strong></td>
                <td>HTML5 / CSS3 / Vanilla JS (ES6+)</td>
                <td>Provides responsive dark-themed UI. Features card and list layouts, search filtering, and slide-over detailed job description modals with interview guides.</td>
            </tr>
        </tbody>
    </table>

    <hr>

    <h2>2. Database Schema (Excel Rows Mapping)</h2>
    <p>The Excel sheet <code>Job Leads</code> uses a 15-column schema, structured as follows:</p>
    <table border="1" cellpadding="5" cellspacing="0">
        <thead>
            <tr style="background-color: #f2f2f2;">
                <th>Col #</th>
                <th>Column Name</th>
                <th>Data Type</th>
                <th>Description / Sample Value</th>
            </tr>
        </thead>
        <tbody>
            <tr><td>1</td><td>Select to Apply</td><td>String (Checkbox)</td><td><code>[ ]</code> or <code>[x]</code> (mapped to Consideration status)</td></tr>
            <tr><td>2</td><td>Cohort</td><td>String</td><td><code>Mag 7</code>, <code>Non-Mag 7</code>, <code>High-Growth Startups</code>, <code>AI Labs</code></td></tr>
            <tr><td>3</td><td>Company</td><td>String</td><td>Company name (e.g. <code>Apple</code>, <code>Greenhouse Company</code>)</td></tr>
            <tr><td>4</td><td>Role Title</td><td>String</td><td>Job title (e.g. <code>Senior Product Manager</code>)</td></tr>
            <tr><td>5</td><td>Location</td><td>String</td><td>Location string or <code>Remote</code></td></tr>
            <tr><td>6</td><td>Key Focus</td><td>String</td><td>Extracted domain focus (e.g. <code>Growth</code>, <code>Core Tech</code>)</td></tr>
            <tr><td>7</td><td>Status</td><td>String</td><td><code>Lead</code>, <code>Consideration</code>, <code>Archived</code></td></tr>
            <tr><td>8</td><td>URL</td><td>String (Hyperlink)</td><td>The application portal link</td></tr>
            <tr><td>9</td><td>Date Added</td><td>String (Date)</td><td>Format: <code>YYYY-MM-DD</code></td></tr>
            <tr><td>10</td><td>Notes</td><td>String</td><td>Additional custom comments</td></tr>
            <tr><td>11</td><td>Compensation</td><td>String</td><td>Normalized range (e.g. <code>$185k-$240k</code> or <code>N/A</code>)</td></tr>
            <tr><td>12</td><td>App Status</td><td>String</td><td>Application state (e.g. <code>Not Applied</code>, <code>Applied</code>, <code>Interviewing</code>)</td></tr>
            <tr><td>13</td><td>App Outcome</td><td>String</td><td>Application result (e.g. <code>Active / Pending</code>, <code>Rejected</code>)</td></tr>
            <tr><td>14</td><td>Resume Link</td><td>String</td><td>File path/link to the resume submitted</td></tr>
            <tr><td>15</td><td>Archive Reason</td><td>String</td><td>Reason (e.g. <code>Closed</code>, <code>User Archived</code>)</td></tr>
        </tbody>
    </table>

    <hr>

    <h2>3. Scraper Specifications (Per Company)</h2>
    <p>Scraping is executed per company depending on the underlying careers architecture:</p>
    <ul>
        <li><strong>Google:</strong> Simulated HTTP POST payload hitting Google's <code>batchexecute</code> endpoint. Parses internal job lists and extracts titles and locations.</li>
        <li><strong>Microsoft:</strong> Fetches the Microsoft Careers Eightfold search API (<code>GET /api/pcsx/search</code>) after establishing a session and resolving CSRF tokens.</li>
        <li><strong>Nvidia:</strong> Queries Nvidia's Eightfold search API similar to Microsoft, applying correct headers and session states.</li>
        <li><strong>Netflix:</strong> Crawls the Phenom-powered portal. Parses the initial HTML and extracts pre-rendered job lists from the <code>&lt;code id="smartApplyData"&gt;</code> script block.</li>
        <li><strong>Apple:</strong> Accesses Apple careers website. Parses and hydrates variables injected in script blocks directly in Apple's HTML response.</li>
        <li><strong>Meta:</strong> Direct GraphQL call to <code>/api/graphql/</code> with doc ID <code>26703205452636175</code>, utilizing session cookies and browser headers (<code>Sec-Ch-Ua</code>, etc.) to prevent blocks.</li>
        <li><strong>Amazon:</strong> Queries Amazon's public careers search API (<code>GET /en/search.json</code>) with dynamically built search terms.</li>
        <li><strong>Standard ATS (Greenhouse, Ashby, Workable):</strong> Auto-detected from URL parameters; parses job list JSON/HTML directly.</li>
    </ul>

    <hr>

    <h2>4. Core Engineering Flows</h2>
    
    <h3>4.1 Performance Caching (JOBS_CACHE)</h3>
    <p>To avoid reading the Excel spreadsheet on every single user interaction or filter update, <code>server.py</code> loads jobs into a global in-memory cache variable <code>JOBS_CACHE</code>. On every API query, it checks the spreadsheet modification time (<code>mtime</code>) and only reloads the Excel file if the file on disk has changed.</p>
    
    <h3>4.2 Immediate Scan & Company Enrichment</h3>
    <p>When a new company is added in the UI, the backend creates a database entry in <code>config.json</code>, parses the portal type, and spawns a background thread running the scraper script specifically for that company (e.g., <code>check_new_jobs.py "Company Name"</code>). Simultaneously, it queries DuckDuckGo search indexes to automatically discover company metadata (HQ location, foundation year, revenue, employee count, and company domain) to populate the dashboard.</p>
    
    <h3>4.3 Smart Compensation Parser</h3>
    <p>When scraping a job description, a regular expression parser runs to extract salary numbers. It processes expressions like <code>$150,000 - $220,000</code>, <code>$180k to $250k</code>, or <code>$120/hr</code>, and normalizes them into standard <code>$Xk-$Yk</code> formats. This details is written to Column 11 of the spreadsheet and rendered directly on the dashboard cards.</p>

    <h3>4.4 Cohort-Based Level Filtering</h3>
    <p>Job titles are filtered against the target company's cohort settings. When a crawl executes, <code>title_matches_levels</code> checks if the job title contains level-specific whitelisted phrases or falls back to "Generic" if the title contains no seniority suffixes (like <i>Senior</i>, <i>Lead</i>, <i>Principal</i>, <i>Staff</i>, <i>Director</i>, <i>VP</i>, <i>Head</i>, <i>II</i>, etc.).</p>

    <h3>4.5 Deletion Cascade</h3>
    <p>Deleting a monitored company from the feeds widget triggers a <code>DELETE</code> API request. The backend removes the company config from <code>config.json</code>, iterates backwards through rows in the Excel spreadsheet to delete all job rows belonging to that company, and clears the in-memory cache to sync the UI immediately.</p>
</body>
</html>
"""


def main():
    print("Initializing Google Document Creation Script...")
    
    # 1. Authenticate with Google
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            print("Refreshing expired credentials token...")
            try:
                creds.refresh(Request())
            except Exception as e:
                print(f"Error refreshing token: {e}")
                creds = None
                
        if not creds:
            if not os.path.exists(CREDENTIALS_FILE):
                print("\n" + "="*80)
                print("ERROR: credentials.json NOT FOUND!")
                print("Please follow these steps to set up your Google Cloud Credentials:")
                print("1. Go to the Google Cloud Console: https://console.cloud.google.com/")
                print("2. Create a new project or select an existing one.")
                print("3. In the sidebar, navigate to 'APIs & Services' > 'Library'.")
                print("4. Search for and enable 'Google Drive API' and 'Google Docs API'.")
                print("5. Go to 'APIs & Services' > 'Credentials'.")
                print("6. Click '+ CREATE CREDENTIALS' and select 'OAuth client ID'.")
                print("7. If prompted, configure the OAuth Consent Screen (Internal/External with test users).")
                print("8. Select Application type as 'Desktop app' and give it a name.")
                print("9. Click Create, then download the client secrets JSON file.")
                print("10. Move/Save the file to this directory and name it exactly 'credentials.json':")
                print(f"    {CREDENTIALS_FILE}")
                print("11. Re-run this script to log in and create the Google Docs.")
                print("="*80 + "\n")
                sys.exit(1)
                
            print("Starting Google OAuth 2.0 flow. A browser window will open...")
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
            
            # Save token for next time
            with open(TOKEN_FILE, 'w') as token_f:
                token_f.write(creds.to_json())
            print("Authentication successful! Token saved.")

    drive_service = build('drive', 'v3', credentials=creds)
    
    # 2. Search for the folder "2026 Job Search"
    print("Searching for Google Drive folder '2026 Job Search'...")
    folder_id = None
    query = "name = '2026 Job Search' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    results = drive_service.files().list(q=query, fields="files(id, name)").execute()
    files = results.get('files', [])
    
    if files:
        folder_id = files[0]['id']
        print(f"Found folder '2026 Job Search' with ID: {folder_id}")
    else:
        print("Folder '2026 Job Search' not found. Will create the documents in the Root Drive directory.")

    # 3. Create PRD Document
    print("Creating Google Document: 'PM Jobs Board: PRD'...")
    prd_metadata = {
        'name': 'PM Jobs Board: PRD',
        'mimeType': 'application/vnd.google-apps.document'
    }
    if folder_id:
        prd_metadata['parents'] = [folder_id]
        
    prd_media = MediaIoBaseUpload(
        BytesIO(PRD_HTML.encode('utf-8')),
        mimetype='text/html',
        resumable=True
    )
    
    prd_doc = drive_service.files().create(
        body=prd_metadata,
        media_body=prd_media,
        fields='id, name, webViewLink'
    ).execute()
    
    print(f"SUCCESS: Created Doc '{prd_doc.get('name')}' successfully!")
    print(f"PRD Web View Link: {prd_doc.get('webViewLink')}")

    # 4. Create TDD Document
    print("Creating Google Document: 'PM Jobs Board: TDD'...")
    tdd_metadata = {
        'name': 'PM Jobs Board: TDD',
        'mimeType': 'application/vnd.google-apps.document'
    }
    if folder_id:
        tdd_metadata['parents'] = [folder_id]
        
    tdd_media = MediaIoBaseUpload(
        BytesIO(TDD_HTML.encode('utf-8')),
        mimetype='text/html',
        resumable=True
    )
    
    tdd_doc = drive_service.files().create(
        body=tdd_metadata,
        media_body=tdd_media,
        fields='id, name, webViewLink'
    ).execute()
    
    print(f"SUCCESS: Created Doc '{tdd_doc.get('name')}' successfully!")
    print(f"TDD Web View Link: {tdd_doc.get('webViewLink')}")
    
    print("\n" + "="*80)
    print("Google Documents successfully created!")
    print(f"1. PRD Document: {prd_doc.get('webViewLink')}")
    print(f"2. TDD Document: {tdd_doc.get('webViewLink')}")
    print("="*80 + "\n")


if __name__ == '__main__':
    main()
