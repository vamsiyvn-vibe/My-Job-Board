import socket
import os
import sys
import re
import requests
import datetime
import traceback
import subprocess
import json
import threading
import time
import sqlite3
import uuid
import random
from flask import Flask, jsonify, request, send_from_directory, session, redirect, render_template_string
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from bs4 import BeautifulSoup
import urllib3
import docx
from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
import shutil

try:
    import telemetry
except Exception:
    telemetry = None

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BOARD_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BOARD_DIR)
SCRIPTS_DIR = os.path.join(PROJECT_ROOT, "scripts")
LOCAL_DIR = os.environ.get("PM_BOARD_DATA_DIR") or os.path.join(BOARD_DIR, "data")
os.makedirs(LOCAL_DIR, exist_ok=True)
DB_PATH = os.environ.get("PM_BOARD_DB_PATH") or os.path.join(LOCAL_DIR, "board.db")
GDRIVE_DB_PATH = os.environ.get("PM_BOARD_SYNC_DB_PATH") or ""
CONFIG_PATH = os.path.join(BOARD_DIR, "config.json")

_last_sync_to_gdrive = 0
_gdrive_sync_lock = threading.Lock()

def sync_from_gdrive():
    """On boot, copy the latest board.db from Google Drive to local SSD if available."""
    try:
        if GDRIVE_DB_PATH and os.path.exists(GDRIVE_DB_PATH):
            if not os.path.exists(DB_PATH) or os.path.getmtime(GDRIVE_DB_PATH) > os.path.getmtime(DB_PATH):
                shutil.copy2(GDRIVE_DB_PATH, DB_PATH)
                print(f"[SSD Cache] Ingested latest board.db from Google Drive -> {DB_PATH}")
    except Exception as e:
        print(f"[SSD Cache] Sync from Google Drive warning: {e}")

def sync_to_gdrive(force=False):
    """Asynchronously checkpoint WAL and mirror local SSD board.db to Google Drive only when modified."""
    global _last_sync_to_gdrive
    if not _gdrive_sync_lock.acquire(blocking=False):
        return  # another sync is already in flight
    try:
        if os.path.exists(DB_PATH):
            wal_path = DB_PATH + "-wal"
            current_mtime = max(
                os.path.getmtime(DB_PATH),
                os.path.getmtime(wal_path) if os.path.exists(wal_path) else 0
            )
            # Only mirror if database was modified since last sync (or forced)
            if not force and _last_sync_to_gdrive > 0 and current_mtime <= _last_sync_to_gdrive:
                return

            try:
                c = sqlite3.connect(DB_PATH, timeout=5.0)
                c.execute("PRAGMA wal_checkpoint(PASSIVE);")
                c.close()
            except Exception:
                pass
            if GDRIVE_DB_PATH: shutil.copy2(DB_PATH, GDRIVE_DB_PATH)
            _last_sync_to_gdrive = time.time()
    except Exception as e:
        print(f"[SSD Cache] Sync to Google Drive warning: {e}")
    finally:
        _gdrive_sync_lock.release()

def _gdrive_sync_worker():
    """Background worker that periodically checks if local database has changed and mirrors to Google Drive."""
    while True:
        time.sleep(300)  # Check every 5 minutes instead of every 30 seconds
        sync_to_gdrive()

app = Flask(__name__, static_url_path='', static_folder='.')
CORS(app)

# --- Session / auth setup -----------------------------------------------------
# A persisted random secret keeps login sessions valid across server restarts.
_SECRET_FILE = os.path.join(PROJECT_ROOT, "board", ".flask_secret")
def _load_or_create_secret():
    try:
        with open(_SECRET_FILE, "r") as f:
            s = f.read().strip()
            if s:
                return s
    except OSError:
        pass
    s = uuid.uuid4().hex + uuid.uuid4().hex
    try:
        with open(_SECRET_FILE, "w") as f:
            f.write(s)
    except OSError:
        pass
    return s

app.secret_key = _load_or_create_secret()
app.permanent_session_lifetime = datetime.timedelta(days=30)  # stay logged in on mobile


_access_hash_cache = None

def _get_access_hash():
    """Return the configured access-password hash, or '' if the gate is off."""
    global _access_hash_cache
    if _access_hash_cache is not None:
        return _access_hash_cache
    try:
        conn = get_db(); cur = conn.cursor()
        row = cur.execute("SELECT access_password_hash FROM profile WHERE id = 1").fetchone()
        conn.close()
        _access_hash_cache = (row["access_password_hash"] if row else "") or ""
        return _access_hash_cache
    except Exception:
        return ""


# Paths always reachable without a session: the login page/action, PWA assets, the
# watchdog health endpoint, and static shell files (code/styling, not personal data).
_PUBLIC_EXACT = {"/login", "/logout", "/manifest.webmanifest", "/sw.js",
                 "/favicon.ico", "/api/jobs/fit-status", "/api/auth-status"}
_PUBLIC_EXTS = ("css", "js", "png", "jpg", "jpeg", "gif", "svg", "ico",
                "webmanifest", "woff", "woff2", "ttf", "map")


def _is_public_path(p):
    if p in _PUBLIC_EXACT:
        return True
    if p != "/" and "." in p and p.rsplit(".", 1)[-1].lower() in _PUBLIC_EXTS:
        return True
    return False


@app.before_request
def _track_request_start():
    try:
        request._start_time = time.time()
    except Exception:
        pass

@app.after_request
def _track_request_end(response):
    try:
        if telemetry:
            dur_ms = (time.time() - getattr(request, '_start_time', time.time())) * 1000.0
            telemetry.record_request(request.path, request.method, response.status_code, dur_ms)
    except Exception:
        pass
    return response

@app.before_request
def _require_login():
    p = request.path
    if _is_public_path(p):
        return
    if request.remote_addr in ('127.0.0.1', '::1', 'localhost'):
        return
    if not _get_access_hash():
        return  # no password configured yet -> gate disabled (first-run)
    if session.get("authed"):
        return
    if p.startswith("/api/"):
        return jsonify({"error": "Authentication required", "auth": False}), 401
    return redirect("/login")
# ------------------------------------------------------------------------------

# Global variables for async background scanning
is_scanning = False
auto_scan_triggered = False
scan_lock = threading.Lock()

# Database Helper Functions
def dict_factory(cursor, row):
    d = {}
    for idx, col in enumerate(cursor.description):
        d[col[0]] = row[idx]
    return d

def get_db():
    last = None
    for attempt in range(8):
        try:
            conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute("PRAGMA busy_timeout=10000;")
            conn.row_factory = dict_factory
            return conn
        except sqlite3.OperationalError as e:
            last = e
            time.sleep(0.1 * (attempt + 1))
    raise last

def init_sqlite_db():
    sync_from_gdrive()
    db_dir = os.path.dirname(DB_PATH)
    if not os.path.exists(db_dir):
        os.makedirs(db_dir)
        
    conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=10000;")
    cursor = conn.cursor()
    
    # 1. Profile Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        location TEXT DEFAULT '',
        linkedin TEXT DEFAULT '',
        summary TEXT DEFAULT '',
        locations TEXT DEFAULT '[]',
        keywords TEXT DEFAULT '[]',
        seniority_levels TEXT DEFAULT '[]',
        expected_comp TEXT DEFAULT '',
        canonical_resume TEXT DEFAULT '',
        contributions_bank TEXT DEFAULT '[]',
        education TEXT DEFAULT '[]',
        gemini_api_key TEXT DEFAULT '',
        onboarded INTEGER DEFAULT 0
    )
    """)
    
    for col_name, col_type in [
        ("email", "TEXT DEFAULT ''"),
        ("phone", "TEXT DEFAULT ''"),
        ("location", "TEXT DEFAULT ''"),
        ("linkedin", "TEXT DEFAULT ''"),
        ("summary", "TEXT DEFAULT ''"),
        ("education", "TEXT DEFAULT '[]'"),
        ("gemini_api_key", "TEXT DEFAULT ''"),
        # Role-fit scoring LLM (OpenAI-compatible: Groq, OpenAI, Together, ...).
        ("llm_api_key", "TEXT DEFAULT ''"),
        ("llm_base_url", "TEXT DEFAULT 'https://api.groq.com/openai/v1'"),
        ("llm_model", "TEXT DEFAULT 'meta-llama/llama-4-scout-17b-16e-instruct'"),
        ("llm_daily_token_budget", "INTEGER DEFAULT 400000"),
        ("last_scanned_at", "TEXT DEFAULT ''"),
        # Optional access password (werkzeug hash). Empty = no gate (first-run).
        ("access_password_hash", "TEXT DEFAULT ''"),
    ]:
        try:
            cursor.execute(f"ALTER TABLE profile ADD COLUMN {col_name} {col_type}")
        except sqlite3.OperationalError:
            pass # Column already exists
    
    # Insert default profile row if empty
    cursor.execute("SELECT COUNT(*) FROM profile")
    if cursor.fetchone()[0] == 0:
        cursor.execute("""
        INSERT INTO profile (name, locations, keywords, seniority_levels, expected_comp, canonical_resume, contributions_bank, education, onboarded)
        VALUES ('', '["New York", "NYC", "NY", "NJ", "New Jersey", "Remote", "US Remote"]', '["product manager", "product management", "technical product manager"]', '["Senior", "Group", "Staff", "Principal", "Director"]', '', '', '[]', '[]', 0)
        """)
        
    # 2. Companies Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        board_id TEXT DEFAULT '',
        cohort TEXT NOT NULL DEFAULT 'Non-Mag 7',
        hq TEXT DEFAULT '',
        founded TEXT DEFAULT '',
        revenue TEXT DEFAULT '',
        employees TEXT DEFAULT '',
        domain TEXT DEFAULT '',
        capability TEXT DEFAULT 'active_sync',
        portal_url TEXT DEFAULT '',
        levels TEXT DEFAULT '[]'
    )
    """)
    
    # 3. Jobs Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        title TEXT NOT NULL,
        location TEXT DEFAULT '',
        url TEXT NOT NULL,
        salary TEXT DEFAULT 'N/A',
        status TEXT DEFAULT 'Lead',
        archive_reason TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        relevancy_score INTEGER DEFAULT 0,
        first_seen_at TEXT DEFAULT '',
        pipeline_status TEXT DEFAULT 'Sourced',
        pipeline_notes TEXT DEFAULT '',
        last_checked_at TEXT DEFAULT '',
        resume_url TEXT DEFAULT ''
    )
    """)
    
    # Run dynamic schema migration to add resume_url column to jobs if not present
    try:
        cursor.execute("ALTER TABLE jobs ADD COLUMN resume_url TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass # Column already exists

    # Role-fit scoring columns (role-fit-evaluator skill). -1 means "not yet scored".
    for _col, _type in [
        ("experience_fit", "INTEGER DEFAULT -1"),
        ("criteria_fit", "INTEGER DEFAULT -1"),
        ("fit_experience_note", "TEXT DEFAULT ''"),
        ("fit_criteria_note", "TEXT DEFAULT ''"),
        ("fit_recommendation", "TEXT DEFAULT ''"),
        ("fit_flag", "TEXT DEFAULT ''"),
        ("fit_framing", "TEXT DEFAULT ''"),   # honest "how to frame for this role" when criteria fit is good
        ("fit_scored_at", "TEXT DEFAULT ''"),
        ("fit_model", "TEXT DEFAULT ''"),
        ("alerted_at", "TEXT DEFAULT ''"),
        # Manual re-score now queues the job for Claude (Opus) scoring in a Claude Code
        # session rather than calling Groq inline. 'queued' marks it waiting; cleared on apply.
        ("claude_rescore_status", "TEXT DEFAULT ''"),
        ("claude_rescore_at", "TEXT DEFAULT ''"),
        ("source", "TEXT DEFAULT 'NewPMJobs'"),
    ]:
        try:
            cursor.execute(f"ALTER TABLE jobs ADD COLUMN {_col} {_type}")
        except sqlite3.OperationalError:
            pass # Column already exists


    # 4. Pipeline Events Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS pipeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        event_date TEXT DEFAULT '',
        status TEXT DEFAULT 'Scheduled',
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT '',
        FOREIGN KEY(job_id) REFERENCES jobs(id)
    )
    """)
    
    # 5. Tailored Resumes Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS tailored_resumes (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        selected_bullets TEXT NOT NULL,
        formatting TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT DEFAULT '',
        FOREIGN KEY(job_id) REFERENCES jobs(id)
    )
    """)
    
    # 5b. Resume Requests Queue
    # The tailored-resume-builder skill runs inside Claude (it needs the Google Drive
    # connector and a PDF page-count verification loop), so the board cannot build the
    # doc itself. The UI button enqueues here; Claude drains the queue and writes back.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS resume_requests (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        status TEXT DEFAULT 'Queued',
        doc_url TEXT DEFAULT '',
        error TEXT DEFAULT '',
        requested_at TEXT DEFAULT '',
        fulfilled_at TEXT DEFAULT '',
        FOREIGN KEY(job_id) REFERENCES jobs(id)
    )
    """)

    # 5c. LLM daily token usage (for auto-throttling fit scoring against a free-tier cap)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS llm_usage (
        day TEXT PRIMARY KEY,
        tokens INTEGER DEFAULT 0,
        requests INTEGER DEFAULT 0
    )
    """)
    # Timestamped, model-tagged usage log for true rolling-24h accounting (Groq's TPD caps
    # are rolling windows, and 120B vs 20B are capped separately). Created once here so the
    # hot write path (record_llm_usage) does no DDL under multi-process lock contention.
    cursor.execute("CREATE TABLE IF NOT EXISTS llm_usage_log (ts REAL, tokens INTEGER, model TEXT)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_llm_usage_log_ts ON llm_usage_log(ts)")

    # 5d. Preparation Guides Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS prep_guides (
        app_id INTEGER PRIMARY KEY,
        job_id TEXT DEFAULT '',
        company_name TEXT NOT NULL,
        role_title TEXT NOT NULL,
        guide_json TEXT DEFAULT '{}',
        user_notes TEXT DEFAULT '',
        updated_at TEXT DEFAULT ''
    )
    """)

    # 6. Connections Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        company TEXT NOT NULL,
        position TEXT NOT NULL,
        url TEXT DEFAULT ''
    )
    """)

    # Job application tracker (formal portal submissions + emails to recruiters/HMs)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        role TEXT NOT NULL,
        submission_method TEXT DEFAULT 'Job Portal',
        referral TEXT DEFAULT 'No',
        progress TEXT DEFAULT 'Submitted',
        outcome TEXT DEFAULT 'In Progress',
        feedback TEXT DEFAULT '',
        resume_link TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT ''
    )
    """)

    # --- Application answer bank ---------------------------------------------------
    # The reusable answers every ATS form asks for. Single row (id = 1), grouped as JSON
    # so sections can grow without a migration each time. Populated by the form in
    # Profile & Settings and read by the agent when filling an application.
    #
    # Deliberately NOT stored here: SSN, date of birth, government ID, bank details,
    # passwords. None are required before an offer and the agent must never handle them.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS application_answers (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        contact_json TEXT DEFAULT '{}',
        eligibility_json TEXT DEFAULT '{}',
        logistics_json TEXT DEFAULT '{}',
        demographics_json TEXT DEFAULT '{}',
        narrative_json TEXT DEFAULT '{}',
        rules_json TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT ''
    )
    """)
    cursor.execute("INSERT OR IGNORE INTO application_answers (id) VALUES (1)")

    # --- Agentic apply queue -------------------------------------------------------
    # One row per role being taken through the agentic pipeline. This is what the
    # "Under Consideration" tab renders. Mirrors the proven resume_requests pattern:
    # the board enqueues, an agent session drains, every stage is resumable.
    #
    #   source  : 'starred' (you picked it) | 'auto' (scheduled top-up)
    #   ats_mode: 'auto'   -> agent can drive the form end-to-end (Greenhouse/Lever/...)
    #             'manual' -> Workday & big-tech: resume + staged answers only, because
    #                         they need a per-employer account we cannot create.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS apply_requests (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        source TEXT DEFAULT 'starred',
        status TEXT DEFAULT 'Queued',
        ats TEXT DEFAULT '',
        ats_mode TEXT DEFAULT 'auto',
        resume_doc_url TEXT DEFAULT '',
        resume_verdict TEXT DEFAULT '',
        resume_findings TEXT DEFAULT '',
        form_url TEXT DEFAULT '',
        qa_verdict TEXT DEFAULT '',
        qa_report TEXT DEFAULT '',
        screenshot_path TEXT DEFAULT '',
        unanswered_fields TEXT DEFAULT '',
        staged_answers TEXT DEFAULT '',
        log_path TEXT DEFAULT '',
        application_id INTEGER,
        attempts INTEGER DEFAULT 0,
        error TEXT DEFAULT '',
        created_at TEXT DEFAULT '',
        updated_at TEXT DEFAULT ''
    )
    """)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS worker_lease (
        id INTEGER PRIMARY KEY CHECK(id=1),
        holder TEXT,
        heartbeat REAL
    )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_apply_requests_job ON apply_requests(job_id)")
    # Added after the table shipped; ALTER covers existing installs.
    # prep_requested_at marks a role YOU asked for by name, as opposed to one merely sitting
    # in the queue. Everything in the queue is 'Queued', so without this the per-row button
    # was indistinguishable from the bulk one - it re-set a status the row already had.
    for _c, _t in [("log_path", "TEXT DEFAULT ''"), ("brief_doc_url", "TEXT DEFAULT ''"),
                   ("prep_requested_at", "TEXT DEFAULT ''")]:
        try:
            cursor.execute(f"ALTER TABLE apply_requests ADD COLUMN {_c} {_t}")
        except sqlite3.OperationalError:
            pass

    # Application date-tracking + auto-close bookkeeping.
    #   applied_date     - YYYY-MM-DD the application was actually submitted (editable; may
    #                      predate the row if it was seeded from the spreadsheet).
    #   outcome_date     - YYYY-MM-DD the outcome became final. Set automatically when the
    #                      outcome flips to Closed, cleared if it is reopened.
    #   auto_close_state - 0 eligible, 1 auto-closed by the stale rule, 2 user reopened it
    #                      (permanently exempt, so we never auto-close the same row twice).
    for _col, _type in [
        ("applied_date", "TEXT DEFAULT ''"),
        ("outcome_date", "TEXT DEFAULT ''"),
        ("auto_close_state", "INTEGER DEFAULT 0"),
    ]:
        try:
            cursor.execute(f"ALTER TABLE applications ADD COLUMN {_col} {_type}")
        except sqlite3.OperationalError:
            pass  # Column already exists

    # Backfill applied_date from created_at ('YYYY-MM-DD hh:mm AM') for pre-existing rows.
    # outcome_date is deliberately NOT backfilled for already-closed rows: we don't know
    # when they closed, and inventing a date would be worse than leaving it blank.
    cursor.execute("""
        UPDATE applications
           SET applied_date = substr(created_at, 1, 10)
         WHERE (applied_date IS NULL OR applied_date = '')
           AND created_at LIKE '____-__-__%'
    """)

    # Data integrity: fix any rows where salary and first_seen_at are swapped (old migration artifact)
    import re as _re
    _date_pat = _re.compile(r'^\d{4}-\d{2}-\d{2}$')
    _sal_pat = _re.compile(r'\$[\d,]+')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT id, salary, first_seen_at FROM jobs")
    for row in cursor.fetchall():
        sal, seen = (row['salary'] or ''), (row['first_seen_at'] or '')
        if _date_pat.match(sal.strip()) and _sal_pat.search(seen):
            cursor.execute("UPDATE jobs SET salary = ?, first_seen_at = ? WHERE id = ?", (seen, sal, row['id']))

    # Self-heal legacy rows whose first_seen_at isn't a valid YYYY-MM-DD ('N/A', empty,
    # or junk from old imports). The live crawler always stamps a real date, so this only
    # touches historical strays and is idempotent (valid dates are skipped). Backfill with
    # the job's fit_scored_at date (a real lower bound for when we had it) when available,
    # otherwise the board's earliest known date (genesis) so the row reads as old, never new.
    _all_rows = cursor.execute("SELECT id, first_seen_at, fit_scored_at FROM jobs").fetchall()
    _valid = [(r['first_seen_at'] or '').strip() for r in _all_rows
              if _date_pat.match((r['first_seen_at'] or '').strip())]
    genesis = min(_valid) if _valid else datetime.datetime.now().strftime('%Y-%m-%d')
    for row in _all_rows:
        if _date_pat.match((row['first_seen_at'] or '').strip()):
            continue
        scored10 = (row['fit_scored_at'] or '').strip()[:10]
        cursor.execute("UPDATE jobs SET first_seen_at = ? WHERE id = ?",
                       (scored10 if _date_pat.match(scored10) else genesis, row['id']))

    # STAR Behavioral Prep module. One row per accomplishment story; queryable bits are
    # scalar columns, the nested intake sections are JSON blobs (mirrors 01-star-intake-form
    # JSON schema without over-normalizing). Stories are company-agnostic and reused.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT '',
        decision_headline TEXT DEFAULT '',
        target_company TEXT DEFAULT 'Amazon',
        primary_lp TEXT DEFAULT '',
        framing_json TEXT DEFAULT '{}',
        situation_json TEXT DEFAULT '{}',
        action_json TEXT DEFAULT '{}',
        tension_json TEXT DEFAULT '{}',
        result_json TEXT DEFAULT '{}',
        depth_json TEXT DEFAULT '{}',
        mapping_json TEXT DEFAULT '{}',
        self_drafts_json TEXT DEFAULT '{}',
        generated_json TEXT DEFAULT '',
        created_at TEXT DEFAULT '',
        updated_at TEXT DEFAULT ''
    )
    """)
    # One row per recorded/critiqued delivery attempt, matching 02-star-delivery-rubric's
    # JSON scoring schema. Powers the progress view (weighted_score + recurring auto-deduction).
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS delivery_attempts (
        attempt_id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        length TEXT DEFAULT '',
        source TEXT DEFAULT 'recording',
        duration_seconds REAL DEFAULT 0,
        word_count INTEGER DEFAULT 0,
        wpm REAL DEFAULT 0,
        transcript TEXT DEFAULT '',
        scores_json TEXT DEFAULT '{}',
        auto_deductions_json TEXT DEFAULT '[]',
        weighted_score REAL DEFAULT 0,
        the_one_fix TEXT DEFAULT '',
        what_worked TEXT DEFAULT '',
        re_record INTEGER DEFAULT 0,
        created_at TEXT DEFAULT ''
    )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_delivery_attempts_story ON delivery_attempts(story_id)")

    # Audio directory for raw audio storage (Flask app does not transcribe/analyze)
    data_audio_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "audio")
    os.makedirs(data_audio_dir, exist_ok=True)

    # Delivery Training & Role-Related Reps unified queue and session tables (Rubric v1.1)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS ai_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT NOT NULL,
        result_json TEXT,
        rubric_version TEXT,
        session_id INTEGER,
        role_job_id INTEGER,
        error_msg TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
    )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ai_jobs_session ON ai_jobs(session_id)")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS delivery_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        answer_type TEXT,
        question TEXT,
        role_job_id INTEGER,
        is_baseline INTEGER DEFAULT 0,
        audio_path TEXT,
        transcript TEXT,
        transcript_source TEXT,
        overall REAL,
        scores_json TEXT,
        vocal_scores_json TEXT,
        acoustic_json TEXT,
        result_json TEXT,
        rubric_version TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_delivery_sessions_mode ON delivery_sessions(mode)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_delivery_sessions_role ON delivery_sessions(role_job_id)")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS mock_question_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_job_id INTEGER NOT NULL,
        questions_json TEXT NOT NULL,
        rubric_version TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_mock_question_sets_role ON mock_question_sets(role_job_id)")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS interview_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT NOT NULL,
        role_title TEXT NOT NULL,
        role_job_id INTEGER,
        round_type TEXT NOT NULL,
        interview_date TEXT,
        interviewer_info TEXT,
        audio_path TEXT,
        transcript TEXT,
        transcript_source TEXT,
        overall_score REAL,
        scores_json TEXT,
        questions_json TEXT,
        strengths_json TEXT,
        gaps_json TEXT,
        the_one_fix TEXT,
        rewrites_json TEXT,
        acoustic_json TEXT,
        rubric_version TEXT DEFAULT 'v1.1',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
    )
    """)
    # Cleaned, properly-diarized turn-by-turn transcript (same "[MM:SS - MM:SS] Speaker: text"
    # format as `transcript`, but with real alternating turns). The Structured Dialogue timeline
    # renders from this when present; `transcript` stays as the raw source for the Raw Text view.
    try:
        cursor.execute("ALTER TABLE interview_reviews ADD COLUMN structured_transcript TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass  # already exists
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_interview_reviews_company ON interview_reviews(company_name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_interview_reviews_date ON interview_reviews(interview_date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_resume_requests_job_id_id ON resume_requests(job_id, id DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status_relevancy ON jobs(status, relevancy_score DESC, first_seen_at DESC)")

    conn.commit()
    conn.close()


# --- ROLE FIT EVALUATOR ---
# Rubric ported from the `role-fit-evaluator` skill. The two dimensions are scored
# independently and must not be conflated: a role can be a strong experience fit and a
# weak criteria fit, or the reverse.
# The scoring substance lives in the canonical single-source file role_fit_rubric.md next
# to this module, so the board scorer and the role-fit-evaluator skill never drift. Edit the
# rubric THERE. Loaded once at import; falls back to a concise embedded rubric only if the
# file is missing, so unattended scoring degrades gracefully rather than crashing.
_RUBRIC_FALLBACK = (
    "You are evaluating a Product Management role against the candidate profile provided in context. "
    "Score TWO INDEPENDENT dimensions 0-10 (or N/A if the JD is missing/generic): "
    "A) professional experience fit, B) desired-criteria fit (level, location/remote, domain, compensation). "
    "Do not inflate scores; explain WHAT MATCHES and WHAT IS THE GAP separately, grounded strictly in the JD text."
)

def _load_role_fit_rubric():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "role_fit_rubric.md")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        # Keep the scoring substance; drop the human-facing header above it. The substance
        # starts at the stable anchor line below.
        anchor = text.find("You are evaluating a Product Management role")
        return text[anchor:].strip() if anchor != -1 else text.strip()
    except Exception as e:
        print("WARNING: could not load role_fit_rubric.md (%s); using fallback rubric." % e)
        return _RUBRIC_FALLBACK


ROLE_FIT_RUBRIC = _load_role_fit_rubric()


# ---- STAR Behavioral Prep: shared constant + markdown-as-system-prompt loaders ----
# One source of truth for the word bands, used by the JS counters, injected into the
# generator prompt, and used by the rubric's time check (design invariant #4).
WORD_BANDS = {"2min": (260, 320), "60s": (130, 160), "30s": (65, 85)}


def _load_star_spec(filename, fallback):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "Interview Prep-Behavioral", filename)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception as e:
        print(f"WARNING: could not load STAR spec {filename} ({e}); using fallback.")
        return fallback


STAR_GENERATOR_PROMPT = _load_star_spec(
    "star-story-generator-SKILL.md",
    "You convert a STAR intake JSON into three spoken scripts (2-min 260-320w, 60-sec "
    "130-160w, 30-sec 65-85w), each OPENING on the decision and ENDING on the metric, plus "
    "leadership-principle mapping, best-fit questions, and 5-8 anticipated follow-ups. "
    "Never open on situation; never append a qualifier after the metric.")
STAR_RUBRIC_PROMPT = _load_star_spec(
    "02-star-delivery-rubric.md",
    "You are a behavioral-interview delivery coach. Score a STAR narration transcript on the "
    "nine delivery dimensions (0-4) with per-length weights, apply red-flag auto-deductions, "
    "return the JSON scoring schema, and give the ONE fix that most improves the next rep.")

STAR_GEN_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"]
STAR_SCORE_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.6-27b"]


def star_chat(system_prompt, user_content, api_key, models=None, json_mode=True, max_tokens=3000,
              reasoning_effort="low", temperature=0.4):
    if not api_key:
        raise ValueError("LLM API key is not configured. Add your Groq key in the Profile tab.")
    grant_manual_priority()
    conn = get_db()
    prof_row = conn.execute("SELECT llm_base_url, llm_model FROM profile WHERE id = 1").fetchone()
    conn.close()
    prof = dict(prof_row) if prof_row else {}
    base_url = (prof.get("llm_base_url") or "https://api.groq.com/openai/v1").rstrip("/")
    
    models_to_try = list(models) if models else list(STAR_GEN_MODELS)
    prof_model = prof.get("llm_model")
    if prof_model and prof_model not in models_to_try:
        models_to_try.insert(0, prof_model)

    last_rle = None
    last_err = None
    for model_name in models_to_try:
        payload = {
            "model": model_name,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        }
        if "gpt-oss" in model_name or "reasoning" in model_name:
            payload["reasoning_effort"] = reasoning_effort
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        try:
            res = requests.post(f"{base_url}/chat/completions",
                                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                                json=payload, timeout=90)
            if res.status_code == 429:
                retry_after = res.headers.get("retry-after") or res.headers.get("x-ratelimit-reset-tokens")
                body = (res.text or "").lower()
                is_daily = ("per day" in body) or ("tpd" in body)
                last_rle = RateLimitError(f"LLM provider rate limit on {model_name} (429)",
                                          retry_after=parse_retry_after(retry_after), daily=is_daily)
                continue
            if res.status_code != 200:
                last_err = RuntimeError(f"LLM API ({model_name}) returned {res.status_code}: {res.text[:200]}")
                continue

            body = res.json()
            content = (body["choices"][0]["message"]["content"] or "").strip()
            tokens = int((body.get("usage") or {}).get("total_tokens", 0))
            if content.startswith("```"):
                content = content.strip('`')
                if content.lower().startswith("json"):
                    content = content[4:].strip()
            try:
                conn = get_db()
                record_llm_usage(conn.cursor(), tokens, model=model_name)
                conn.commit()
                conn.close()
            except Exception:
                pass
            return (json.loads(content) if json_mode else content), tokens
        except Exception as e:
            if isinstance(e, RateLimitError):
                last_rle = e
            else:
                last_err = e
            continue

    if last_rle:
        raise last_rle
    if last_err:
        raise last_err
    raise RuntimeError("All candidate LLM models failed.")



def star_transcribe(audio_bytes, filename, api_key):
    """Transcribe audio using Gemini 3.5 Transcribe (gemini-3.5-transcribe) as primary model,
    with graceful fallback to configured LLM/Whisper provider."""
    import base64
    conn = get_db()
    prof_row = conn.execute("SELECT gemini_api_key, llm_base_url, llm_api_key FROM profile WHERE id = 1").fetchone()
    conn.close()
    prof = dict(prof_row) if prof_row else {}

    gemini_key = os.environ.get("GEMINI_API_KEY") or prof.get("gemini_api_key")
    if gemini_key:
        # Determine mime type from filename
        ext = os.path.splitext(filename or "")[1].lower()
        mime_map = {
            ".mp3": "audio/mp3",
            ".wav": "audio/wav",
            ".m4a": "audio/m4a",
            ".ogg": "audio/ogg",
            ".webm": "audio/webm",
            ".mp4": "video/mp4"
        }
        mime_type = mime_map.get(ext, "audio/webm")
        b64_data = base64.b64encode(audio_bytes).decode("utf-8")

        # Try gemini-3.5-transcribe primary model
        models = ["gemini-3.5-transcribe", "gemini-2.5-flash", "gemini-1.5-flash"]
        for m in models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={gemini_key}"
            payload = {
                "contents": [{
                    "parts": [
                        {"inline_data": {"mime_type": mime_type, "data": b64_data}},
                        {"text": "Transcribe this spoken interview audio verbatim. Preserve all words, natural speech fillers, and pause boundaries accurately. Return ONLY the transcription text."}
                    ]
                }],
                "generationConfig": {"temperature": 0.0, "maxOutputTokens": 8192}
            }
            try:
                g_res = requests.post(url, headers={"Content-Type": "application/json"}, json=payload, timeout=120)
                if g_res.status_code == 200:
                    g_data = g_res.json()
                    candidates = g_data.get("candidates", [])
                    if candidates:
                        text_part = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                        return text_part.strip(), None
            except Exception as ge:
                print(f"[Gemini Transcribe] Model {m} failed, trying next: {ge}")

    # Fallback to standard OpenAI/Groq compatible audio transcription
    if not api_key:
        api_key = prof.get("llm_api_key")
    if not api_key:
        raise ValueError("Neither Gemini API key nor LLM API key is configured for transcription.")

    base_url = (prof.get("llm_base_url") or "https://api.groq.com/openai/v1").rstrip("/")
    res = requests.post(
        f"{base_url}/audio/transcriptions",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": (filename or "recording.webm", audio_bytes, "application/octet-stream")},
        data={"model": "whisper-large-v3", "response_format": "verbose_json", "language": "en"},
        timeout=120,
    )
    if res.status_code == 429:
        raise RateLimitError("LLM provider rate limit (429)", daily=False)
    if res.status_code != 200:
        raise RuntimeError(f"Transcription API returned {res.status_code}: {res.text[:200]}")
    data = res.json()
    return (data.get("text") or "").strip(), data.get("duration")


# Cap on how long we will sleep for a single provider rate-limit response. Groq sends
# multi-thousand-second retry-after values when a daily window is exhausted; sleeping
# those in one block leaves the worker idle long after capacity returns.
MAX_BACKOFF = 300  # 5 minutes


class RateLimitError(RuntimeError):
    def __init__(self, message, retry_after=None, daily=False):
        super().__init__(message)
        self.retry_after = retry_after
        self.daily = daily


def parse_retry_after(val):
    if not val:
        return 20.0
    val_str = str(val).strip()
    try:
        return float(val_str)
    except ValueError:
        pass
    import re
    if val_str.endswith('ms'):
        try:
            return float(val_str[:-2]) / 1000.0
        except ValueError:
            pass
    m = re.match(r'^(?:(\d+)m)?(?:([\d\.]+)s)?$', val_str)
    if m:
        mins = float(m.group(1)) if m.group(1) else 0.0
        secs = float(m.group(2)) if m.group(2) else 0.0
        total = mins * 60.0 + secs
        if total > 0:
            return total
    return 20.0


NYC_PAT = re.compile(r'(?i)\b(new york|nyc|manhattan|brooklyn|,\s*ny\b|\bny,)')
REMOTE_US_PAT = re.compile(r'(?i)\b(remote)\b')
NON_US_PAT = re.compile(r'(?i)\b(serbia|armenia|cyprus|georgia|portugal|turkey|india|canada|uk|united kingdom|london|ireland|germany|poland|brazil|mexico|singapore|australia)\b')


def analyze_location(location):
    loc = location or ""
    nyc = bool(NYC_PAT.search(loc))
    remote = bool(REMOTE_US_PAT.search(loc))
    non_us = bool(NON_US_PAT.search(loc))
    if nyc:
        verdict = "NYC IS an eligible location for this role (matches his top preference)."
    elif remote and not non_us:
        verdict = "Remote (appears US-based) - acceptable to him."
    elif non_us:
        verdict = "Location appears NON-US - this is a hard miss on his location criterion."
    elif remote and non_us:
        verdict = "Remote but non-US - hard miss."
    else:
        verdict = "Not NYC and not remote - a US relocation would be required."
    return verdict


SALARY_NUM_PAT = re.compile(r'\$?\s*([\d][\d,\.]{2,})\s*(k\b)?', re.I)


def analyze_compensation(salary):
    raw = (salary or "").strip()
    if not raw or raw.upper() in ("N/A", "NA", "-", "NONE"):
        return "Compensation NOT DISCLOSED - treat as unknown/neutral; do NOT penalize."
    nums = []
    for m in SALARY_NUM_PAT.finditer(raw):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if m.group(2):          # "180k"
            v *= 1000
        if v < 1000:            # bare "180" meaning 180k
            v *= 1000
        if 10000 <= v <= 2000000:
            nums.append(v)
    if not nums:
        return f"Compensation string present but unparseable ({raw[:60]}) - treat as unknown; do NOT penalize."
    hi = max(nums)
    target_floor = int(os.environ.get("PM_BOARD_MIN_BASE_SALARY", "0") or 0)
    if target_floor <= 0:
        return f"Posted base range ${min(nums):,.0f}-${hi:,.0f} (compare against candidate criteria)."
    if hi < target_floor:
        return (f"Posted base MAX is ${hi:,.0f}, BELOW target floor ${target_floor:,.0f} - HARD MISS. "
                f"Cap criteria_fit at 4 and flag it.")
    if min(nums) < target_floor <= hi:
        return (f"Posted base range ${min(nums):,.0f}-${hi:,.0f} STRADDLES target floor ${target_floor:,.0f} - "
                f"partial miss; an offer must land near the top of the band.")
    return f"Posted base ${min(nums):,.0f}-${hi:,.0f} CLEARS target floor ${target_floor:,.0f}."


JUNK_DESC_PAT = re.compile(r'(?i)(themeOptions|varTheme|"#[0-9a-f]{6}"|border-radius|primary-color|font-family\s*:)')


# Markers of a failed page load / crawler placeholder rather than a real JD. These are
# clean text (so they slip past the CSS/JSON check) but signal there is no usable JD.
SHELL_MARKERS = re.compile(
    r'(?i)(javascript turned off|please enable javascript|you need to enable javascript|'
    r'enable it to improve your browsing|description snippet:|scored via local|'
    r'description page fetch failed|are you a robot|enable javascript to view)')


def looks_like_junk(desc):
    if not desc or len(desc.strip()) < 600:
        return True
    if SHELL_MARKERS.search(desc):
        return True
    hits = len(JUNK_DESC_PAT.findall(desc))
    hexes = len(re.findall(r'#[0-9a-fA-F]{6}', desc))
    return hits >= 2 or hexes >= 8


SCORE_NA = -2   # a dimension the model couldn't assess (no usable JD); distinct from -1 (never scored)


def derive_recommendation(exp, crit):
    """Single source of truth for the Apply/Stretch/Skip label.

    We do NOT trust the model's own recommendation string: audits showed ~33% of them
    contradicted the scores the same model produced (e.g. exp=5, crit=4 labelled
    "Stretch"). The recommendation is a pure, transparent function of the two /10 scores:

        SKIP    - can't do the job well (exp <= 5) OR a hard criteria miss (crit <= 4,
                  which includes compensation floor miss and wrong location/level)
        APPLY   - strong on BOTH: exp >= 8 AND crit >= 7
        STRETCH - everything in between (worth a look, with a real gap)
    """
    # N/A on either dimension (SCORE_NA) means we couldn't assess it (no usable JD), so no
    # honest Apply/Skip is possible - surface it for a human look instead of a fake verdict.
    if exp == SCORE_NA or crit == SCORE_NA:
        return "Review"
    if exp <= 5 or crit <= 4:
        return "Skip"
    if exp >= 8 and crit >= 7:
        return "Apply"
    return "Stretch"


def calculate_role_fit_batch(jobs, profile, api_key, jd_chars=3500):
    """EXPERIMENTAL - not wired into the worker. Scores several roles in ONE request so
    the rubric + resume (91% of a single-job prompt) are sent once instead of per job.
    `jobs` is a list of dicts with title/company_name/location/salary/desc.
    Returns (list_of_fit_dicts_in_input_order, tokens_used)."""
    import requests

    if not api_key:
        raise ValueError("LLM API key is not configured.")

    base_url = (profile.get("llm_base_url") or "https://api.groq.com/openai/v1").rstrip("/")
    model = profile.get("llm_model") or "openai/gpt-oss-20b"

    blocks = []
    for i, j in enumerate(jobs, start=1):
        desc = j.get("desc") or ""
        desc_out = ("[NO USABLE JOB DESCRIPTION AVAILABLE - apply the calibration rule: cap "
                    "experience_fit at 5 and say the description was unusable]"
                    if looks_like_junk(desc) else desc[:jd_chars])
        blocks.append(
            f"""--- ROLE {i} ---
Company: {j.get('company_name','')}
Title: {j.get('title','')}
Location: {j.get('location','')}
LOCATION VERDICT (pre-computed, trust this): {analyze_location(j.get('location'))}
COMPENSATION VERDICT (pre-computed, trust this): {analyze_compensation(j.get('salary'))}
Description: {desc_out}"""
        )

    prompt = f"""{ROLE_FIT_RUBRIC}

CANDIDATE PROFILE SUMMARY
{profile.get("summary", "")}

CANDIDATE CANONICAL RESUME
{(profile.get("canonical_resume", "") or "")[:9000]}

You will now evaluate {len(jobs)} SEPARATE roles against the rubric above.

CRITICAL INDEPENDENCE REQUIREMENT: Evaluate each role COMPLETELY INDEPENDENTLY. Do not
let one role's score influence another's. Do not compare the roles to each other or try
to spread/rank them relative to one another. Score each exactly as you would if it were
the only role you had been given. Apply the same calibration rules to every role,
including the last one - do not give later roles less scrutiny than earlier ones.

{chr(10).join(blocks)}

Respond with ONLY a JSON object of the form:
{{"evaluations": [{{"role": 1, "experience_fit": <0-10 int>, "criteria_fit": <0-10 int>,
"experience_note": "...", "criteria_note": "...", "recommendation": "Apply|Stretch|Skip",
"flag": "..."}}, ... one entry per role, in order, {len(jobs)} entries total]}}"""

    payload = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": 400 * len(jobs) + 500,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": "You are a precise career-fit evaluator. Respond with a single JSON object and nothing else."},
            {"role": "user", "content": prompt},
        ],
    }

    res = requests.post(f"{base_url}/chat/completions",
                        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                        json=payload, timeout=120)
    if res.status_code == 429:
        ra = res.headers.get("retry-after") or res.headers.get("x-ratelimit-reset-tokens")
        raise RateLimitError("LLM provider rate limit (429)", retry_after=parse_retry_after(ra))
    if res.status_code != 200:
        raise RuntimeError(f"LLM API returned {res.status_code}: {res.text[:200]}")

    body = res.json()
    content = body["choices"][0]["message"]["content"].strip()
    tokens = int((body.get("usage") or {}).get("total_tokens", 0))
    if content.startswith("```"):
        content = content.strip("`")
        if content.lower().startswith("json"):
            content = content[4:]
    parsed = json.loads(content)
    evals = parsed.get("evaluations") or parsed.get("results") or []
    if len(evals) != len(jobs):
        raise ValueError(f"Batch returned {len(evals)} evaluations for {len(jobs)} roles")

    def _clamp(v):
        try:
            return max(0, min(10, int(round(float(v)))))
        except (TypeError, ValueError):
            raise ValueError(f"Non-numeric score in batch: {v!r}")

    out = []
    for e in evals:
        exp, crit = _clamp(e.get("experience_fit")), _clamp(e.get("criteria_fit"))
        rec = derive_recommendation(exp, crit)  # deterministic; model's own label ignored
        out.append({"experience_fit": exp, "criteria_fit": crit,
                    "experience_note": str(e.get("experience_note", "")).strip(),
                    "criteria_note": str(e.get("criteria_note", "")).strip(),
                    "recommendation": rec, "flag": str(e.get("flag", "")).strip()[:60]})
    return out, tokens


def calculate_role_fit(job_title, company_name, location, job_desc, profile, api_key, salary=None):
    """Score a role on experience fit and criteria fit (each /10) per the
    role-fit-evaluator rubric, via an OpenAI-compatible chat endpoint (Groq by default).
    Returns (fit_dict, tokens_used); raises on failure so the caller can surface a real
    error rather than silently persisting a fake score."""
    import requests

    if not api_key:
        raise ValueError("LLM API key is not configured. Add your Groq (or OpenAI-compatible) key in the Profile tab.")

    base_url = (profile.get("llm_base_url") or "https://api.groq.com/openai/v1").rstrip("/")
    model = profile.get("llm_model") or "openai/gpt-oss-20b"

    prompt = f"""{ROLE_FIT_RUBRIC}

CANDIDATE PROFILE SUMMARY
{profile.get("summary", "")}

CANDIDATE CANONICAL RESUME
{(profile.get("canonical_resume", "") or "")[:4500]}

ROLE UNDER EVALUATION
Company: {company_name}
Title: {job_title}
Location: {location}
LOCATION VERDICT (pre-computed, trust this over your own parsing): {analyze_location(location)}
COMPENSATION VERDICT (pre-computed, trust this over your own parsing): {analyze_compensation(salary)}
Description: {"[NO USABLE JOB DESCRIPTION AVAILABLE - see calibration rule: cap experience_fit at 5 and say the description was unusable]" if looks_like_junk(job_desc) else (job_desc or "")[:2500]}

Respond with ONLY a JSON object with these fields:
"experience_fit": integer 0-10, or the string "N/A" if there are no usable JD themes to score against (see the N/A rule)
"experience_match": 1-2 sentences on the strongest experience matches, each naming the specific role/cluster or theme AND the closest single proof point
"experience_gap": 1 sentence on the honest gap and what drives it (structural vs domain), or "None material"
"criteria_fit": integer 0-10, or "N/A" only if title, level, location and comp are all missing
"criteria_match": 1 sentence on the level/location/domain/comp that align
"criteria_gap": 1 sentence on any of those that miss, or "None material"
"framing_suggestion": ONLY when criteria_fit >= 7 AND experience has a real gap: 1-2 sentences on how to HONESTLY reposition his profile to close the gap (which cluster/theme to lead with, which adjacency to foreground). Never imply experience he lacks. Otherwise "".
"flag": a short (<=60 char) up-front location/level warning, or "" if none.
"""

    payload = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        # Bound the output. Reasoning models (gpt-oss) will otherwise spend their whole
        # budget "thinking" and return empty content, which fails JSON validation (400).
        "max_tokens": 1800,
        "messages": [
            {"role": "system", "content": "You are a precise career-fit evaluator. Respond with a single JSON object and nothing else."},
            {"role": "user", "content": prompt},
        ],
    }
    # gpt-oss (and other reasoning models) support reasoning_effort; keep it low so the
    # bulk of the token budget goes to the JSON answer, not internal reasoning. This
    # parameter is invalid on the llama models, so only send it when relevant.
    if "gpt-oss" in model or "reasoning" in model:
        payload["reasoning_effort"] = "low"

    res = requests.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload, timeout=45,
    )
    if res.status_code == 429:
        retry_after = res.headers.get("retry-after") or res.headers.get("x-ratelimit-reset-requests") or res.headers.get("x-ratelimit-reset-tokens")
        wait_sec = parse_retry_after(retry_after)
        # Groq spells out the offending window in the body, e.g. "tokens per day (TPD):
        # Limit 500000, Used 498908". A daily cap means retrying now is pointless.
        body_txt = (res.text or "").lower()
        is_daily = ("per day" in body_txt) or ("tpd" in body_txt) or ("per-day" in body_txt)
        raise RateLimitError("LLM provider rate limit (429)", retry_after=wait_sec, daily=is_daily)
    if res.status_code != 200:
        raise RuntimeError(f"LLM API returned {res.status_code}: {res.text[:200]}")

    body = res.json()
    content = body["choices"][0]["message"]["content"].strip()
    tokens = int((body.get("usage") or {}).get("total_tokens", 0))

    # Some models wrap JSON in ```json fences despite json_object mode; strip if present.
    if content.startswith("```"):
        content = content.strip("`")
        if content.lower().startswith("json"):
            content = content[4:]
    parsed = json.loads(content)

    def _clamp(v):
        # SCORE_NA (-2) marks a dimension the model could not assess (no usable JD). It is
        # distinct from -1 (never scored) so the worker won't re-pick it forever, and >=0
        # checks (is-scored, thresholds) correctly treat it as "no real score".
        if isinstance(v, str) and v.strip().upper() in ("N/A", "NA", "N.A.", "NONE", ""):
            return SCORE_NA
        try:
            return max(0, min(10, int(round(float(v)))))
        except (TypeError, ValueError):
            raise ValueError(f"LLM returned a non-numeric score: {v!r}")

    exp_score = _clamp(parsed.get("experience_fit"))
    crit_score = _clamp(parsed.get("criteria_fit"))

    # Recommendation is derived deterministically from the two scores (see
    # derive_recommendation) - the model's own label is intentionally ignored because it
    # was inconsistent with its own scores ~33% of the time.
    rec = derive_recommendation(exp_score, crit_score)

    # Compose the stored notes from the structured fields so the board shows the match and
    # the gap on separate, unmistakable lines.
    def _note(match_key, gap_key):
        match = str(parsed.get(match_key, "")).strip()
        gap = str(parsed.get(gap_key, "")).strip()
        parts = []
        if match:
            parts.append(f"Matches: {match}")
        if gap and gap.lower() not in ("none", "none material", "n/a"):
            parts.append(f"Gap: {gap}")
        elif gap:
            parts.append("Gap: None material")
        return "  ".join(parts)

    fit = {
        "experience_fit": exp_score,
        "criteria_fit": crit_score,
        "experience_note": _note("experience_match", "experience_gap")
                           or str(parsed.get("experience_note", "")).strip(),
        "criteria_note": _note("criteria_match", "criteria_gap")
                         or str(parsed.get("criteria_note", "")).strip(),
        "framing": str(parsed.get("framing_suggestion", "")).strip(),
        "recommendation": rec,
        "flag": str(parsed.get("flag", "")).strip()[:60],
    }
    return fit, tokens


# Relevancy Scoring Engine Heuristic
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

def calculate_relevancy_score(job_title, job_desc, profile):
    title_lower = job_title.lower()
    desc_lower = job_desc.lower()
    
    score = 0
    
    # 1. PM Keyword Match (with abbreviations)
    keywords = json.loads(profile.get("keywords", "[]"))
    if not keywords:
        keywords = ["product manager", "product management", "technical product manager"]
        
    matched_kws = 0
    for kw in keywords:
        kw_l = kw.lower().strip()
        # Expand keywords for matching
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
    seniority_targets = json.loads(profile.get("seniority_levels", "[]"))
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

# Word DOCX Resume Exporter
def generate_resume_docx(profile, selected_bullets, formatting, job_title, company_name):
    font_name = formatting.get("font", "Calibri")
    font_size_pt = float(formatting.get("fontSize", 11))
    margin_in = float(formatting.get("margin", 0.75))
    
    doc = docx.Document()
    
    # Set margins
    for section in doc.sections:
        section.top_margin = Inches(margin_in)
        section.bottom_margin = Inches(margin_in)
        section.left_margin = Inches(margin_in)
        section.right_margin = Inches(margin_in)
        
    # Default font styles
    style = doc.styles['Normal']
    font = style.font
    font.name = font_name
    font.size = Pt(font_size_pt)
    
    # 1. Header Section
    name_para = doc.add_paragraph()
    name_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    name_para.paragraph_format.space_after = Pt(2)
    run_name = name_para.add_run(profile.get("name", "Candidate Name").upper())
    run_name.bold = True
    run_name.font.size = Pt(font_size_pt + 8)
    run_name.font.color.rgb = docx.shared.RGBColor(12, 30, 58)
    
    contact_para = doc.add_paragraph()
    contact_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    contact_para.paragraph_format.space_after = Pt(12)
    email = profile.get("email", "email@example.com")
    phone = profile.get("phone", "(123) 456-7890")
    loc = profile.get("location", "City, State")
    linkedin = profile.get("linkedin", "linkedin.com/in/profile")
    
    contact_info = f"{email}   |   {phone}   |   {loc}   |   {linkedin}"
    contact_para.add_run(contact_info).font.size = Pt(font_size_pt - 1)
    
    # 2. Professional Summary
    summary = profile.get("summary", "").strip()
    if summary:
        h = doc.add_heading("PROFESSIONAL SUMMARY", level=1)
        h.paragraph_format.keep_with_next = True
        doc.add_paragraph(summary).paragraph_format.space_after = Pt(8)
        
    # 3. Work Experience Section
    h_exp = doc.add_heading("PROFESSIONAL EXPERIENCE", level=1)
    h_exp.paragraph_format.keep_with_next = True
    
    all_contributions = json.loads(profile.get("contributions_bank", "[]"))
    selected_ids = set(selected_bullets)
    
    # Group contributions by company name and role
    # Order them as they appear in the bank
    grouped = []
    seen_groups = {}
    
    for c in all_contributions:
        c_id = c.get("id")
        # If it is selected, add it to grouped
        if c_id in selected_ids or not selected_ids: # if none selected, show all as fallback
            comp = c.get("company", "Company").strip()
            role = c.get("role", "Product Manager").strip()
            dates = c.get("dates", "Dates").strip()
            bullet = c.get("bullet", "").strip()
            
            group_key = (comp, role, dates)
            if group_key not in seen_groups:
                seen_groups[group_key] = len(grouped)
                grouped.append({
                    "company": comp,
                    "role": role,
                    "dates": dates,
                    "bullets": []
                })
            grouped[seen_groups[group_key]]["bullets"].append(bullet)
            
    for exp in grouped:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.keep_with_next = True
        
        # Company name
        run_comp = p.add_run(exp["company"])
        run_comp.bold = True
        run_comp.font.color.rgb = docx.shared.RGBColor(12, 30, 58)
        
        # Right aligned dates (using tab stops)
        p.paragraph_format.tab_stops.add_tab_stop(Inches(8.5 - 2*margin_in), docx.enum.text.WD_TAB_ALIGNMENT.RIGHT)
        p.add_run(f"\t{exp['dates']}")
        
        # Title Line
        p_title = doc.add_paragraph()
        p_title.paragraph_format.space_after = Pt(4)
        p_title.paragraph_format.keep_with_next = True
        run_title = p_title.add_run(exp["role"])
        run_title.italic = True
        
        for bullet in exp["bullets"]:
            p_b = doc.add_paragraph(bullet, style='List Bullet')
            p_b.paragraph_format.space_after = Pt(2)
            p_b.paragraph_format.line_spacing = 1.15
            
    # 4. Education Section
    education = json.loads(profile.get("education", "[]"))
    if education:
        h_ed = doc.add_heading("EDUCATION", level=1)
        h_ed.paragraph_format.keep_with_next = True
        
        for ed in education:
            p_ed = doc.add_paragraph()
            p_ed.paragraph_format.space_before = Pt(4)
            p_ed.paragraph_format.space_after = Pt(2)
            
            run_sch = p_ed.add_run(ed.get("school", "University Name"))
            run_sch.bold = True
            
            p_ed.paragraph_format.tab_stops.add_tab_stop(Inches(8.5 - 2*margin_in), docx.enum.text.WD_TAB_ALIGNMENT.RIGHT)
            p_ed.add_run(f"\t{ed.get('dates', '')}")
            
            p_deg = doc.add_paragraph()
            p_deg.paragraph_format.space_after = Pt(4)
            run_deg = p_deg.add_run(ed.get("degree", "Degree Details"))
            run_deg.italic = True
            
    # Format all headings beautifully
    for p in doc.paragraphs:
        if p.style.name.startswith("Heading"):
            for r in p.runs:
                r.font.name = font_name
                r.font.bold = True
                r.font.size = Pt(font_size_pt + 1)
                r.font.color.rgb = docx.shared.RGBColor(12, 30, 58)
            p.paragraph_format.space_before = Pt(12)
            p.paragraph_format.space_after = Pt(4)
            
    # Save document
    filename = f"Tailored_Resume_{company_name.replace(' ', '_')}_{str(uuid.uuid4())[:8]}.docx"
    output_dir = os.path.join(PROJECT_ROOT, "board", "generated_resumes")
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
    file_path = os.path.join(output_dir, filename)
    doc.save(file_path)
    return filename, file_path

# Verified Interview Insights Data
INTERVIEW_INSIGHTS = {
    "google": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Logistical check, resume walkthrough, and introductory behavioral screening questions."},
            {"title": "2. Product Sense Screen (45m)", "desc": "Product case interview led by a senior PM. Focuses on user-centric design, creative prioritization, and structured problem-solving."},
            {"title": "3. Final Onsite Loop (4-5 rounds)", "desc": "Rounds covering Product Design (user-first case), Analytical Thinking (metric definition/diagnostic), Product Strategy (long-term vision/monetization), and Leadership/Googleyness."}
        ],
        "tips": [
            "Use design frameworks like CIRCLES but tailor them dynamically to avoid sounding robotic or overly template-driven.",
            "Align all product recommendations with Google's core mission to make information universally accessible and useful.",
            "Think about extreme scale. Be ready to explain how solutions adapt to support billions of diverse daily users."
        ]
    },
    "microsoft": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Review of background, general motivation, and basic behavioral alignment check."},
            {"title": "2. Hiring Manager Screen (45m)", "desc": "Conversational screen evaluating product sense, role-specific strategy, and team cultural fit."},
            {"title": "3. Onsite Loop (3-6 rounds)", "desc": "Deep dive interviews covering Product Design & Strategy, Execution & Prioritization (data-driven decisions), and Behavioral Scenarios (collaboration/growth mindset)."}
        ],
        "tips": [
            "Demonstrate a growth mindset (a core Microsoft value) by discussing how you learn from failures and feedback.",
            "Focus on enterprise customer empathy. Understand multi-stakeholder needs, security compliance, and migration paths.",
            "Be highly structured: break complex, ambiguous enterprise/platform problems into logical phases."
        ]
    },
    "apple": {
        "stages": [
            {"title": "1. Recruiter Screen", "desc": "Initial logistics check, review of background, and compensation expectations."},
            {"title": "2. Hiring Manager Round", "desc": "Introductory conversation focusing on experience, team fit, and the crucial 'Why Apple?' assessment."},
            {"title": "3. Screening Rounds", "desc": "1-2 rounds focusing on product sense (situational design) and technical/domain depth depending on the team's area."},
            {"title": "4. Onsite Loop (4-5 rounds)", "desc": "Back-to-back rounds covering Apple-specific Product Sense & Strategy, Technical/Architectural Depth (trade-offs), and Culture/Behavioral alignment."}
        ],
        "tips": [
            "Prepare a highly authentic answer for 'Why Apple?' that aligns with their design philosophy, simplicity, and privacy values.",
            "Apple's PM loop is highly decentralized. Research your specific team's product lines and domain challenges deeply.",
            "Incorporate Apple's principles into your cases: prioritize user simplicity, privacy protection, and ecosystem continuity."
        ]
    },
    "amazon": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Basic alignment on background, logistics, and resume verification."},
            {"title": "2. Written Exercise (1-2 pages)", "desc": "Take-home written response to a behavioral prompt, structured in narrative STAR format, submitted within 48 hours."},
            {"title": "3. Phone Screen (60m)", "desc": "1-2 video rounds with PMs focusing on behavioral scenarios (Leadership Principles) and product design case questions."},
            {"title": "4. Final Onsite Loop (4-5 rounds)", "desc": "Rounds focusing heavily (80%) on Amazon's 16 Leadership Principles using STAR stories, with remaining focus on analytical design/execution cases."}
        ],
        "tips": [
            "Prepare 10-12 STAR stories mapped directly to Amazon's Leadership Principles, as every interviewer evaluates against them.",
            "Understand Amazon's document-driven culture. Focus on how you write specifications, PRFAQs, or narrative memos.",
            "Be highly quantitative: structure answers with data, metrics, and clear trade-off calculations."
        ]
    },
    "nvidia": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Initial screening on technical background, career goals, and compensation expectations."},
            {"title": "2. Hiring Manager Screen", "desc": "Deep technical and domain-specific discussion with the PM lead focusing on past projects and team-specific tech stack."},
            {"title": "3. Final Onsite Loop (3-6 rounds)", "desc": "Conversational rounds with PMs and engineering stakeholders focusing on real-world engineering trade-offs, developer ecosystems, and technical depth."}
        ],
        "tips": [
            "Possess a strong technical baseline. Understand GPU computing, developer tooling, parallel compute, or machine learning infrastructure.",
            "Highlight developer empathy. Nvidia PMs build products for developers, researchers, and system architects.",
            "Focus on behavioral history over generic design cases. Be ready to explain past project tradeoffs in detailed technical terms."
        ]
    },
    "meta": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "General background scan, interest in Meta, and leveling mapping."},
            {"title": "2. Product Sense Screen (45m)", "desc": "Initial case screening evaluating product design, user segmentations, feature prioritization, and success metrics."},
            {"title": "3. Onsite Loop (4-5 rounds)", "desc": "Rounds covering Product Sense (user-first design), Analytical Thinking (execution metrics, bug triage, trade-offs), and Leadership & Drive (behavioral alignment)."}
        ],
        "tips": [
            "For Analytical Thinking (Execution), focus heavily on data: practice metric frameworks, debugging, and counter-metric trade-offs.",
            "Structure all product sense cases: identify target user segments, define specific pain points, prioritize features, and define success metrics.",
            "Align recommendations with Meta's strategic pillars (e.g. connecting people, creator ecosystem, open-source AI, VR/AR)."
        ]
    },
    "tesla": {
        "stages": [
            {"title": "1. Recruiter Screen (20-60m)", "desc": "Alignment on logistics, interest in Tesla's mission, and general background check."},
            {"title": "2. Hiring Manager Screen", "desc": "Domain discussion evaluating hardware-software integration, manufacturing constraints, autonomy software, and team-specific fit."},
            {"title": "3. Onsite Loop & Presentation (5-6 rounds)", "desc": "Technical rounds with HW/SW engineering and PM leads, featuring a 45-minute technical presentation on a past complex project."}
        ],
        "tips": [
            "Demonstrate a high tolerance for ambiguity, speed, and shifting priorities. Tesla values quick decision cycles.",
            "Show extreme alignment with Tesla's mission: accelerating the transition to sustainable energy.",
            "Be highly technical: understand physical architectures, code optimization, or machine learning pipelines (e.g. FSD networks)."
        ]
    },
    "netflix": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Core screening checking alignment with Netflix's unique culture and values."},
            {"title": "2. Hiring Manager Screen", "desc": "Product discussion evaluating product sense, technical intuition, and culture fit."},
            {"title": "3. Culture Fit Screen (45m)", "desc": "Structured conversation with an HR Business Partner focusing on the Netflix Culture Memo values."},
            {"title": "4. Onsite Loop (4-5 rounds)", "desc": "Rounds with PMs, engineering leads, and design heads. Tests collaboration, conflict resolution, A/B testing standards, and metrics."}
        ],
        "tips": [
            "Memorize and internalize the Netflix Culture Memo. Expect interviewers to evaluate you against 'Freedom and Responsibility' values.",
            "Show strong familiarity with data-driven decision-making, specifically A/B testing, cohort metrics, and product instrumentation.",
            "Demonstrate absolute autonomy. Netflix values PMs who operate independently as high-performing 'stunners' without hand-holding."
        ]
    },
    "openai": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Initial sync on background, interest in AI, and alignment with safety mission."},
            {"title": "2. Hiring Manager Screen (1-2 rounds)", "desc": "Conversations focusing on products you shipped, technical capabilities, and strategic thinking."},
            {"title": "3. Take-Home / Case Assessment", "desc": "Skills-based assessment requiring candidates to develop a growth strategy or turn a vague prompt into a product spec deck."},
            {"title": "4. Onsite Loop (4-6 rounds)", "desc": "Highly ambiguous rounds covering Product Sense (vague single-sentence prompts), Execution, GTM Strategy, engineering collaboration, and safety/alignment."}
        ],
        "tips": [
            "Practice handling high ambiguity. Prepare to impose structure on abstract, single-sentence prompts with minimal guidance.",
            "Have deep AI/ML literacy: understand transformer architectures, context windows, tokens, latency, fine-tuning, and APIs.",
            "Highlight safety and ethical deployment. OpenAI evaluates candidates on their commitment to responsible AI development."
        ]
    },
    "anthropic": {
        "stages": [
            {"title": "1. Recruiter Screen (15-45m)", "desc": "Logistics check and screening on motivation, AI safety interest, and alignment with Anthropic's research philosophy."},
            {"title": "2. Hiring Manager Screen (45-60m)", "desc": "Discussion evaluating product judgment, cross-functional collaboration, and AI/ML domain understanding."},
            {"title": "3. Take-Home / Case Study", "desc": "Practical specification task requiring candidates to draft a spec for an AI feature, balancing UX with safety boundaries."},
            {"title": "4. Final Onsite Loop (3-5 rounds)", "desc": "Rounds focusing on Product Sense, Execution, and a dedicated, challenging Constitutional AI ethics and safety alignment round."}
        ],
        "tips": [
            "Study Anthropic's research papers (Constitutional AI, Model Alignment) to understand their safety-first product decisions.",
            "Treat the safety and ethics round as a hard technical interview; practice reasoning through complex AI deployment tradeoffs.",
            "Demonstrate developer empathy and familiarity with Claude, API developer tools, and model latency constraints."
        ]
    },
    "huggingface": {
        "stages": [
            {"title": "1. Recruiter/Hiring Manager Screen", "desc": "Conversational screen on background, open-source alignment, and ML familiarity."},
            {"title": "2. Conversations (2-3 rounds)", "desc": "Interviews with engineers and product leads exploring collaborative problem-solving and open-source contribution patterns."},
            {"title": "3. Role-Specific Take-Home/Assessment", "desc": "Practical exercise designing a hub integration, Spaces monetization, or API packaging strategy."},
            {"title": "4. Final Discussions & Debrief", "desc": "Final round with product leadership focusing on open-source community value vs commercial SaaS monetization."}
        ],
        "tips": [
            "Demonstrate a deep commitment to the open-source community and transparent development practices.",
            "Be active in or highly familiar with the Hugging Face Hub (models, datasets, Spaces, model hubs).",
            "Be ready to explain how to balance developer-centric open-source goodwill with enterprise monetization models."
        ]
    },
    "datadog": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Technical screen focusing on DevOps, cloud architectures, and observability landscape."},
            {"title": "2. Hiring Manager Screen (60m)", "desc": "Observability/telemetry case study focusing on developer personas and system dashboard designs."},
            {"title": "3. Onsite Panel (3-4 rounds)", "desc": "Rounds covering Observability System Design, Cloud APM/Logging Product Sense, Analytical Metrics (churn/adoption), and Behavioral alignment."}
        ],
        "tips": [
            "Understand highly technical developer personas (SREs, platform engineers, cloud architects) and their debugging workflows.",
            "Be fluent in observability concepts: APM, logging, metrics, tracing, distributed systems, and cloud-native Kubernetes environments.",
            "Focus on execution: showcase how you prioritize features and deliver value in short, iterative product cycles."
        ]
    },
    "cockroachlabs": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "Initial scan checking database market experience and career alignment."},
            {"title": "2. Technical Work Experience Round", "desc": "Detailed walk-through of a complex product/feature you shipped, explaining architecture, trade-offs, and engineering negotiation."},
            {"title": "3. Product Positioning Exercise", "desc": "Exercise creating a B2B product messaging framework (elevator pitch, pillars, positioning) for a database feature."},
            {"title": "4. Onsite Panel (4-5 rounds)", "desc": "Exercise-based rounds evaluating developer experience (DX), distributed system trades, planning, and cultural values."}
        ],
        "tips": [
            "Review Cockroach Labs' open-sourced interview templates on GitHub to understand their exercise-based philosophy.",
            "Focus on B2B developer experience (DX) and technical scaling constraints (distributed consensus, latency, zero downtime).",
            "Be transparent and logical. They value clear problem-solving processes and structured thinking over guessing."
        ]
    },
    "disney": {
        "stages": [
            {"title": "1. Recruiter Screen (30m)", "desc": "General background alignment check, streaming/parks interest, and 'Why Disney?' scan."},
            {"title": "2. Hiring Manager Screen", "desc": "Discussion on PM methodologies, stakeholder management, and cross-functional shipping experience."},
            {"title": "3. Cross-Functional Panel (3-4 rounds)", "desc": "Interviews with engineering, design, and business leads evaluating collaboration, consumer product sense, and metrics (e.g. churn, CAC, watch-time)."},
            {"title": "4. Final/Director Round", "desc": "Conversations with senior directors evaluating long-term strategic vision, brand alignment, and leadership potential."}
        ],
        "tips": [
            "Articulate a clear, authentic passion for Disney's brand, storytelling, and user experiences across physical or streaming platforms.",
            "Know streaming metrics (CAC, churn, LTV, engagement, watch-time) and how technical features (player optimization, billing) affect them.",
            "Structure behavioral responses using the STAR method, emphasizing your ability to translate complex details for diverse creative/business stakeholders."
        ]
    }
}

_LOGIN_PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1117">
<title>Sign in · Job Board</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0f1117; color:#e5e7eb; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:24px; }
  .card { width:100%; max-width:360px; background:#171a21; border:1px solid #262a33;
    border-radius:16px; padding:28px 24px; box-shadow:0 10px 40px rgba(0,0,0,.4); }
  .logo { width:48px; height:48px; border-radius:12px; background:linear-gradient(135deg,#a855f7,#6366f1);
    display:flex; align-items:center; justify-content:center; font-size:24px; margin:0 auto 16px; }
  h1 { font-size:1.2rem; text-align:center; margin:0 0 4px; }
  p.sub { text-align:center; color:#9ca3af; font-size:.85rem; margin:0 0 22px; }
  label { display:block; font-size:.8rem; color:#9ca3af; margin-bottom:6px; }
  input[type=password] { width:100%; padding:13px 14px; font-size:16px; border-radius:10px;
    border:1px solid #2f333d; background:#0f1117; color:#e5e7eb; }
  input[type=password]:focus { outline:none; border-color:#a855f7; }
  button { width:100%; margin-top:16px; padding:13px; font-size:1rem; font-weight:700; border:none;
    border-radius:10px; background:linear-gradient(135deg,#a855f7,#6366f1); color:#fff; cursor:pointer; }
  button:active { transform:translateY(1px); }
  .err { background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.35); color:#fca5a5;
    padding:10px 12px; border-radius:8px; font-size:.82rem; margin-bottom:16px; text-align:center; }
</style></head>
<body>
  <form class="card" method="POST" action="/login">
    <div class="logo">🎯</div>
    <h1>Job Board</h1>
    <p class="sub">Enter your access password</p>
    {% if error %}<div class="err">{{ error }}</div>{% endif %}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autofocus autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</body></html>"""


@app.route('/login', methods=['GET', 'POST'])
def login():
    access_hash = _get_access_hash()
    # Gate disabled or already signed in -> straight to the app.
    if not access_hash or session.get("authed"):
        return redirect('/')
    if request.method == 'POST':
        pw = request.form.get('password') or ''
        if check_password_hash(access_hash, pw):
            session.permanent = True
            session['authed'] = True
            return redirect('/')
        return render_template_string(_LOGIN_PAGE, error="Incorrect password"), 401
    return render_template_string(_LOGIN_PAGE, error=None)


@app.route('/logout', methods=['GET', 'POST'])
def logout():
    session.clear()
    return redirect('/login')


@app.route('/api/set-password', methods=['POST'])
def set_password():
    """Set or change the access password. Reachable without a session only when no
    password is set yet (first-run); once set, before_request requires a valid session."""
    data = request.get_json(silent=True) or {}
    new_pw = (data.get('new_password') or '').strip()
    if len(new_pw) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    existing = _get_access_hash()
    # If a password already exists, the caller must be authed (before_request enforces this
    # for /api/set-password) OR supply the current password.
    if existing and not session.get('authed'):
        if not check_password_hash(existing, (data.get('current_password') or '')):
            return jsonify({"error": "Current password is incorrect."}), 403
    conn = get_db(); cur = conn.cursor()
    cur.execute("UPDATE profile SET access_password_hash = ? WHERE id = 1",
                (generate_password_hash(new_pw),))
    conn.commit(); conn.close()
    global _access_hash_cache
    _access_hash_cache = None
    session.permanent = True
    session['authed'] = True  # keep the setter signed in
    return jsonify({"success": True})


@app.route('/api/scan-audit', methods=['GET'])
def scan_audit():
    """Latest source-parity audit written by the daily crawler (see audit_source_parity)."""
    conn = get_db()
    cur = conn.cursor()
    try:
        row = cur.execute("SELECT * FROM scan_audit ORDER BY id DESC LIMIT 1").fetchone()
    except sqlite3.OperationalError:
        row = None  # table not created yet (no scan has run since the feature shipped)
    conn.close()
    if not row:
        return jsonify({"available": False})
    d = dict(row)
    for k in ("per_location", "missing_sample"):
        try:
            d[k] = json.loads(d.get(k) or "null")
        except Exception:
            d[k] = None
    d["status"] = d.get("status") or "success"
    d["error_message"] = d.get("error_message") or ""
    d["available"] = True
    return jsonify(d)


@app.route('/api/auth-status', methods=['GET'])
def auth_status():
    return jsonify({"password_set": bool(_get_access_hash()), "authed": bool(session.get("authed"))})


# --- PWA assets (served with explicit MIME + root scope) ---------------------
@app.route('/manifest.webmanifest')
def pwa_manifest():
    return send_from_directory(app.static_folder, 'manifest.webmanifest',
                               mimetype='application/manifest+json')


@app.route('/sw.js')
def pwa_service_worker():
    resp = send_from_directory(app.static_folder, 'sw.js', mimetype='text/javascript')
    # Root scope + always revalidate the worker script itself.
    resp.headers['Service-Worker-Allowed'] = '/'
    resp.headers['Cache-Control'] = 'no-cache'
    return resp


# Web Assets Serving
@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    # Route for downloading generated resumes
    if path.startswith("generated_resumes/"):
        return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, path)

# --- CANDIDATE PROFILE & ONBOARDING API ---
@app.route('/api/profile', methods=['GET'])
def get_profile():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM profile ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    if not row:
        return jsonify({"onboarded": 0, "last_scanned_at": "2026-07-20 08:00 AM"})
    res = dict(row)
    if not res.get("last_scanned_at"):
        res["last_scanned_at"] = "2026-07-20 08:00 AM"
    return jsonify(res)

@app.route('/api/profile', methods=['POST'])
def save_profile():
    try:
        data = request.get_json()
        conn = get_db()
        cursor = conn.cursor()
        
        # Extract profile properties
        name = data.get("name", "")
        email = data.get("email", "")
        phone = data.get("phone", "")
        location = data.get("location", "")
        linkedin = data.get("linkedin", "")
        summary = data.get("summary", "")
        locations = json.dumps(data.get("locations", []))
        keywords = json.dumps(data.get("keywords", []))
        seniority_levels = json.dumps(data.get("seniority_levels", []))
        expected_comp = data.get("expected_comp", "")
        canonical_resume = data.get("canonical_resume", "")
        contributions_bank = json.dumps(data.get("contributions_bank", []))
        education = json.dumps(data.get("education", []))
        gemini_api_key = data.get("gemini_api_key", "")
        onboarded = int(data.get("onboarded", 1))

        # INSERT OR REPLACE rebuilds the whole row, so any column not listed resets to its
        # default. Read the current row first and preserve LLM config the form may not send.
        cursor.execute("SELECT * FROM profile WHERE id = 1")
        _existing = cursor.fetchone()
        _existing = dict(_existing) if _existing else {}
        llm_api_key = data.get("llm_api_key", _existing.get("llm_api_key", ""))
        llm_base_url = data.get("llm_base_url") or _existing.get("llm_base_url") or "https://api.groq.com/openai/v1"
        llm_model = data.get("llm_model") or _existing.get("llm_model") or "meta-llama/llama-4-scout-17b-16e-instruct"
        llm_daily_token_budget = int(data.get("llm_daily_token_budget", _existing.get("llm_daily_token_budget", 5000000)) or 5000000)

        # Update existing (assuming single user row id=1)
        cursor.execute("""
        INSERT OR REPLACE INTO profile (id, name, email, phone, location, linkedin, summary, locations, keywords, seniority_levels, expected_comp, canonical_resume, contributions_bank, education, gemini_api_key, llm_api_key, llm_base_url, llm_model, llm_daily_token_budget, onboarded)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            name, email, phone, location, linkedin, summary, locations, keywords, seniority_levels, expected_comp, canonical_resume, contributions_bank, education, gemini_api_key, llm_api_key, llm_base_url, llm_model, llm_daily_token_budget, onboarded
        ))
        
        conn.commit()
        
        # Re-score all Leads in SQLite using new profile
        cursor.execute("SELECT id, title, notes FROM jobs WHERE status = 'Lead'")
        leads = cursor.fetchall()
        
        # Load the saved profile dict
        cursor.execute("SELECT * FROM profile WHERE id = 1")
        profile_row = cursor.fetchone()
        profile_dict = dict(profile_row) if profile_row else {}
        
        gemini_key = profile_dict.get("gemini_api_key", "").strip()
        
        for lead in leads:
            if gemini_key:
                score, justification = calculate_gemini_relevancy_score(lead["title"], lead["notes"], profile_dict, gemini_key)
            else:
                score = calculate_relevancy_score(lead["title"], lead["notes"], profile_dict)
            cursor.execute("UPDATE jobs SET relevancy_score = ? WHERE id = ?", (score, lead["id"]))
            
        conn.commit()
        conn.close()
        
        return jsonify({"success": True, "message": "Profile and onboarding criteria updated. Re-scored active job leads."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- FILE UPLOAD ENDPOINTS FOR PERSONALIZATION ---
@app.route('/api/profile/upload-resume', methods=['POST'])
def upload_resume():
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        file = request.files['file']
        filename = file.filename
        if not filename:
            return jsonify({"error": "No filename"}), 400
            
        ext = os.path.splitext(filename)[1].lower()
        text = ""
        
        if ext == '.txt':
            text = file.read().decode('utf-8', errors='ignore')
        elif ext == '.docx':
            doc = docx.Document(file)
            text = "\n".join([p.text for p in doc.paragraphs])
        elif ext == '.pdf':
            from pypdf import PdfReader
            reader = PdfReader(file)
            for page in reader.pages:
                text += page.extract_text() or ""
        else:
            return jsonify({"error": f"Unsupported format: {ext}. Upload PDF, DOCX, or TXT."}), 400
            
        text = text.strip()
        if not text:
            return jsonify({"error": "No text extracted from file."}), 400
            
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("UPDATE profile SET canonical_resume = ? WHERE id = 1", (text,))
        conn.commit()
        conn.close()
        
        return jsonify({"success": True, "text": text})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/profile/upload-template', methods=['POST'])
def upload_template():
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        file = request.files['file']
        filename = file.filename
        if not filename:
            return jsonify({"error": "No filename"}), 400
            
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ['.docx', '.pdf']:
            return jsonify({"error": "Must upload a valid .docx or .pdf resume template"}), 400
            
        # Ensure templates directory exists
        templates_dir = os.path.join(app.root_path, "templates")
        os.makedirs(templates_dir, exist_ok=True)
        
        target_path = os.path.join(templates_dir, f"resume_template{ext}")
        file.save(target_path)
        
        return jsonify({"success": True, "message": f"Resume template {ext.upper()[1:]} saved successfully."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/profile/upload-contributions', methods=['POST'])
def upload_contributions():
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        file = request.files['file']
        filename = file.filename
        if not filename:
            return jsonify({"error": "No filename"}), 400
            
        ext = os.path.splitext(filename)[1].lower()
        contributions = []
        
        if ext == '.json':
            content = file.read().decode('utf-8', errors='ignore')
            contributions = json.loads(content)
        elif ext in ['.txt', '.csv']:
            # Read line by line and treat each line as a generic contribution
            content = file.read().decode('utf-8', errors='ignore')
            lines = [l.strip() for l in content.split('\n') if l.strip()]
            for idx, line in enumerate(lines):
                contributions.append({
                    "id": f"uploaded_{idx}",
                    "category": "Key Accomplishment",
                    "company": "Previous Company",
                    "role": "Product Manager",
                    "dates": "Dates",
                    "bullet": line
                })
        elif ext == '.pdf':
            import pypdf
            reader = pypdf.PdfReader(file)
            pdf_text = ""
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    pdf_text += text + "\n"
            lines = [l.strip() for l in pdf_text.split('\n') if l.strip()]
            for idx, line in enumerate(lines):
                contributions.append({
                    "id": f"uploaded_{idx}",
                    "category": "Key Accomplishment",
                    "company": "Previous Company",
                    "role": "Product Manager",
                    "dates": "Dates",
                    "bullet": line
                })
        else:
            return jsonify({"error": f"Unsupported format: {ext}. Upload JSON, CSV, TXT, or PDF."}), 400
            
        if not isinstance(contributions, list):
            return jsonify({"error": "JSON file must contain an array of contribution objects."}), 400

            
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("UPDATE profile SET contributions_bank = ? WHERE id = 1", (json.dumps(contributions),))
        conn.commit()
        conn.close()
        
        return jsonify({"success": True, "count": len(contributions)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- SEARCH PARAMETERS / CRITERIA BACKWARD COMPATIBLE API ---
@app.route('/api/criteria', methods=['GET'])
def get_criteria():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT locations, keywords, seniority_levels FROM profile WHERE id = 1")
    row = cursor.fetchone()
    conn.close()
    if not row:
        return jsonify({"locations": [], "custom_keywords": []})
        
    return jsonify({
        "locations": json.loads(row["locations"]),
        "custom_keywords": json.loads(row["keywords"]),
        "role_levels": json.loads(row["seniority_levels"])
    })

@app.route('/api/criteria', methods=['POST'])
def save_criteria():
    try:
        data = request.get_json()
        conn = get_db()
        cursor = conn.cursor()
        
        # Check if legacy search_criteria nested format is sent
        if "search_criteria" in data:
            sc = data["search_criteria"]
            locs = sc.get("locations", [])
            kws = sc.get("custom_keywords", [])
            lvls = sc.get("role_levels", ["Senior", "Staff", "Principal", "Director"])
        else:
            locs = data.get("locations", [])
            kws = data.get("custom_keywords", [])
            lvls = data.get("role_levels", ["Senior", "Staff", "Principal", "Director"])
            
        cursor.execute("""
        UPDATE profile SET locations = ?, keywords = ?, seniority_levels = ? WHERE id = 1
        """, (json.dumps(locs), json.dumps(kws), json.dumps(lvls)))
        
        # Re-score
        cursor.execute("SELECT * FROM profile WHERE id = 1")
        profile = cursor.fetchone()
        profile_dict = dict(profile) if profile else {}
        gemini_key = profile_dict.get("gemini_api_key", "").strip()
        
        cursor.execute("SELECT id, title, notes FROM jobs WHERE status = 'Lead'")
        leads = cursor.fetchall()
        for lead in leads:
            if gemini_key:
                score, justification = calculate_gemini_relevancy_score(lead["title"], lead["notes"], profile_dict, gemini_key)
            else:
                score = calculate_relevancy_score(lead["title"], lead["notes"], profile_dict)
            cursor.execute("UPDATE jobs SET relevancy_score = ? WHERE id = ?", (score, lead["id"]))
            
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Search parameters updated."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- COMPANIES API ---
@app.route('/api/companies', methods=['GET'])
def get_companies():
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM companies ORDER BY name ASC")
        companies = cursor.fetchall()
        conn.close()
        
        # Backfill levels lists if strings
        for co in companies:
            if isinstance(co, dict) and co.get("levels"):
                try:
                    co["levels"] = json.loads(co["levels"])
                except Exception:
                    co["levels"] = []
            elif isinstance(co, dict):
                co["levels"] = []
            
        return jsonify(companies)
    except Exception as e:
        print("get_companies error:", e)
        return jsonify([])

@app.route('/api/companies', methods=['POST'])
def add_company():
    try:
        new_co = request.get_json()
        name = new_co.get("name", "").strip()
        if not name:
            return jsonify({"error": "Company name is required"}), 400
            
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM companies WHERE LOWER(name) = LOWER(?)", (name,))
        if cursor.fetchone()["COUNT(*)"] > 0:
            conn.close()
            return jsonify({"error": f"Company '{name}' is already in your tracked list."}), 400
            
        portal_url = new_co.get("portal_url", "").strip()
        if not portal_url:
            conn.close()
            return jsonify({"error": "Careers Search Portal URL is required"}), 400
            
        # Detect platform from URL
        platform = "generic"
        board_id = ""
        portal_url_lower = portal_url.lower()
        
        if "greenhouse.io" in portal_url_lower:
            platform = "greenhouse"
            parts = [p for p in portal_url.split('/') if p]
            if parts:
                board_id = parts[-1].split('?')[0]
        elif "ashbyhq.com" in portal_url_lower:
            platform = "ashby"
            parts = [p for p in portal_url.split('/') if p]
            if parts:
                board_id = parts[-1].split('?')[0]
        elif "workable.com" in portal_url_lower:
            platform = "workable"
            parts = [p for p in portal_url.split('/') if p]
            if parts:
                board_id = parts[0]
                
        cohort = new_co.get("cohort", "Non-Mag 7")
        levels = new_co.get("levels", ["Standard", "Senior", "Staff", "Principal", "Director"])
        co_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, name.lower().strip()))
        
        cursor.execute("""
        INSERT INTO companies (id, name, platform, board_id, cohort, portal_url, capability, levels)
        VALUES (?, ?, ?, ?, ?, ?, 'active_sync', ?)
        """, (co_id, name, platform, board_id, cohort, portal_url, json.dumps(levels)))
        
        conn.commit()
        conn.close()
        return jsonify({"success": True, "id": co_id})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/companies/<string:company_id>', methods=['PUT'])
def update_company(company_id):
    try:
        updated = request.get_json() or {}
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM companies WHERE id = ? OR LOWER(name) = LOWER(?)", (company_id, company_id.strip()))
        existing = cursor.fetchone()
        if not existing:
            conn.close()
            return jsonify({"error": "Company not found"}), 404
            
        co_id = existing["id"]
        old_name = existing["name"]
        new_name = updated.get("name", old_name).strip() or old_name
        cohort = updated.get("cohort", existing["cohort"])
        portal_url = updated.get("portal_url", existing["portal_url"]).strip()
        levels = updated.get("levels")
        if levels is None:
            levels = json.loads(existing["levels"]) if existing["levels"] else []
            
        # Detect platform from URL if URL changed
        platform = existing["platform"]
        board_id = existing["board_id"]
        if portal_url and portal_url != existing["portal_url"]:
            portal_url_lower = portal_url.lower()
            if "greenhouse.io" in portal_url_lower:
                platform = "greenhouse"
                parts = [p for p in portal_url.split('/') if p]
                if parts: board_id = parts[-1].split('?')[0]
            elif "ashbyhq.com" in portal_url_lower:
                platform = "ashby"
                parts = [p for p in portal_url.split('/') if p]
                if parts: board_id = parts[-1].split('?')[0]
            elif "workable.com" in portal_url_lower:
                platform = "workable"
                parts = [p for p in portal_url.split('/') if p]
                if parts: board_id = parts[0]
            else:
                platform = "generic"
                
        cursor.execute("""
        UPDATE companies SET name = ?, cohort = ?, portal_url = ?, platform = ?, board_id = ?, levels = ?
        WHERE id = ?
        """, (new_name, cohort, portal_url, platform, board_id, json.dumps(levels), co_id))
        
        if old_name.lower().strip() != new_name.lower().strip():
            cursor.execute("UPDATE jobs SET company_name = ? WHERE LOWER(company_name) = LOWER(?)", (new_name, old_name.lower().strip()))
            
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": f"Updated company '{new_name}'."})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/companies/<string:company_name>', methods=['DELETE'])
def delete_company(company_name):
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        # Delete company
        cursor.execute("DELETE FROM companies WHERE LOWER(name) = LOWER(?)", (company_name.strip(),))
        
        # Delete associated jobs
        cursor.execute("DELETE FROM jobs WHERE LOWER(company_name) = LOWER(?)", (company_name.strip(),))
        
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": f"Deleted company '{company_name}' and all associated job leads."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/companies/bulk-industry', methods=['POST'])
def add_bulk_industry():
    try:
        import uuid
        data = request.get_json()
        industry = data.get("industry")
        if not industry:
            return jsonify({"error": "No industry specified"}), 400
            
        # Define popular companies by industry with default Greenhouse/Ashby/Lever paths
        industry_batches = {
            "Fintech": [
                {"name": "Ramp", "platform": "ashby", "board_id": "ramp", "portal_url": "https://ramp.com/careers"},
                {"name": "Coinbase", "platform": "greenhouse", "board_id": "coinbase", "portal_url": "https://www.coinbase.com/careers"},
                {"name": "Affirm", "platform": "greenhouse", "board_id": "affirm", "portal_url": "https://www.affirm.com/careers"},
                {"name": "Plaid", "platform": "greenhouse", "board_id": "plaid", "portal_url": "https://plaid.com/careers"}
            ],
            "Biotech": [
                {"name": "Amgen", "platform": "workday", "board_id": "amgen.wd5.myworkdayjobs.com|amgen|external", "portal_url": "https://amgen.wd5.myworkdayjobs.com/amgen"},
                {"name": "Vertex", "platform": "workday", "board_id": "vertex.wd5.myworkdayjobs.com|vertex|external", "portal_url": "https://vertex.wd5.myworkdayjobs.com/vertex"}
            ],
            "Hardware": [
                {"name": "Nvidia", "platform": "nvidia", "board_id": "nvidia", "portal_url": "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"},
                {"name": "Intel", "platform": "workday", "board_id": "intel.wd5.myworkdayjobs.com|intel|external", "portal_url": "https://intel.wd5.myworkdayjobs.com/intel"}
            ],
            "Consumer": [
                {"name": "Doordash", "platform": "greenhouse", "board_id": "doordashusa", "portal_url": "https://doordash.com/careers"},
                {"name": "Airbnb", "platform": "greenhouse", "board_id": "airbnb", "portal_url": "https://airbnb.com/careers"},
                {"name": "Instacart", "platform": "greenhouse", "board_id": "instacart", "portal_url": "https://instacart.com/careers"}
            ],
            "Gaming": [
                {"name": "Roblox", "platform": "greenhouse", "board_id": "roblox", "portal_url": "https://careers.roblox.com"},
                {"name": "Unity", "platform": "greenhouse", "board_id": "unity", "portal_url": "https://unity.com/careers"}
            ],
            "Media": [
                {"name": "Netflix", "platform": "netflix", "board_id": "netflix", "portal_url": "https://netflix.com/careers"},
                {"name": "Spotify", "platform": "lever", "board_id": "spotify", "portal_url": "https://spotify.com/careers"}
            ],
            "Banking": [
                {"name": "Goldman Sachs", "platform": "workday", "board_id": "goldmansachs.wd5.myworkdayjobs.com|external", "portal_url": "https://goldmansachs.wd5.myworkdayjobs.com"}
            ],
            "Consulting": [
                {"name": "Accenture", "platform": "workday", "board_id": "accenture.wd5.myworkdayjobs.com|external", "portal_url": "https://accenture.wd5.myworkdayjobs.com"}
            ],
            "Health-tech": [
                {"name": "Zocdoc", "platform": "greenhouse", "board_id": "zocdoc", "portal_url": "https://zocdoc.com/careers"},
                {"name": "Oscar Health", "platform": "greenhouse", "board_id": "oscar", "portal_url": "https://hioscar.com/careers"}
            ]
        }
        
        batch = industry_batches.get(industry, [])
        if not batch:
            return jsonify({"error": f"No preconfigured batch for industry: {industry}"}), 400
            
        conn = get_db()
        cursor = conn.cursor()
        
        added_count = 0
        for co in batch:
            co_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, co["name"].lower().strip()))
            
            # Check duplicate
            cursor.execute("SELECT COUNT(*) FROM companies WHERE LOWER(name) = LOWER(?)", (co["name"].strip(),))
            if cursor.fetchone()[0] == 0:
                cursor.execute("""
                INSERT INTO companies (id, name, platform, board_id, cohort, portal_url, levels, capability)
                VALUES (?, ?, ?, ?, ?, ?, '["Standard", "Senior", "Staff", "Principal", "Director"]', 'active_sync')
                """, (co_id, co["name"], co["platform"], co["board_id"], industry, co["portal_url"]))
                added_count += 1
                
        conn.commit()
        conn.close()
        
        return jsonify({"success": True, "message": f"Successfully added {added_count} {industry} companies to your tracked list!"})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/company-info', methods=['GET'])
def get_company_info():
    company_name = request.args.get("company", "").strip()
    if not company_name:
        return jsonify({"error": "Company parameter required"}), 400
        
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM companies WHERE LOWER(name) = LOWER(?)", (company_name,))
    co = cursor.fetchone()
    conn.close()
    
    if co and co.get("hq"):
        return jsonify({
            "hq": co["hq"],
            "founded": co["founded"],
            "revenue": co["revenue"],
            "employees": co["employees"],
            "domain": co["domain"]
        })
        
    # DuckDuckGo fallback query (mock response or standard DDG scraping)
    return jsonify({
        "hq": "San Francisco, CA (Fallback)",
        "founded": "2015",
        "revenue": "N/A",
        "employees": "~200",
        "domain": "Software Technology"
    })

# --- JOBS LIST & BOARD API ---
_jobs_cache = {}
_jobs_cache_time = 0

def invalidate_jobs_cache():
    global _jobs_cache, _jobs_cache_time
    _jobs_cache = {}
    _jobs_cache_time = 0

@app.route('/api/jobs', methods=['GET'])
def get_jobs():
    global _jobs_cache, _jobs_cache_time
    try:
        status_filter = request.args.get("status", "Lead")  # Default to Lead only
        include_archived = request.args.get("include_archived", "false").lower() == "true"
        cohort_filter = request.args.get("cohort")
        search = request.args.get("q", "").strip().lower()
        min_score = request.args.get("min_score", type=int, default=0)
        
        cache_key = (status_filter, include_archived, cohort_filter, search, min_score)
        now = time.time()
        if (now - _jobs_cache_time < 30) and (cache_key in _jobs_cache):
            return jsonify(_jobs_cache[cache_key])

        conn = get_db()
        cursor = conn.cursor()
        
        # 1. Fetch resume requests in a single quick indexed lookup
        resume_map = {}
        try:
            cursor.execute("SELECT job_id, status, doc_url FROM resume_requests ORDER BY id ASC")
            for r in cursor.fetchall():
                resume_map[r["job_id"]] = (r["status"], r["doc_url"])
        except Exception:
            pass

        # 2. Query jobs with SUBSTR to avoid transferring massive raw HTML across virtual filesystem
        query = """
        SELECT id, company_name, title, location, salary, status, relevancy_score,
               first_seen_at, pipeline_status, resume_url, experience_fit, criteria_fit,
               fit_recommendation, fit_flag, fit_framing, fit_model,
               fit_experience_note, fit_criteria_note, claude_rescore_status,
               alerted_at, archive_reason, url, COALESCE(source, 'NewPMJobs') AS source,
               SUBSTR(notes, 1, 300) AS notes
        FROM jobs
        """
        params = []

        conditions = []
        if include_archived:
            # Include both Lead and Archived
            conditions.append("status IN ('Lead', 'Consideration', 'Archived')")
        else:
            conditions.append("status IN ('Lead', 'Consideration')")
            
        if cohort_filter:
            cursor.execute("SELECT name FROM companies WHERE cohort = ?", (cohort_filter,))
            matching_cos = [c["name"] for c in cursor.fetchall()]
            if matching_cos:
                placeholders = ",".join("?" for _ in matching_cos)
                conditions.append(f"company_name IN ({placeholders})")
                params.extend(matching_cos)
            else:
                conn.close()
                return jsonify({"jobs": [], "total": 0, "active": 0})
        
        if search:
            conditions.append("(LOWER(title) LIKE ? OR LOWER(company_name) LIKE ? OR LOWER(location) LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
        
        if min_score > 0:
            conditions.append("relevancy_score >= ?")
            params.append(min_score)
                
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
            
        # Sort by score desc, then date desc, then by title
        query += " ORDER BY relevancy_score DESC, first_seen_at DESC, title ASC"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        
        # Applied-to lookup, so the board can star a role you already applied to even when
        # the posting came back as a fresh row (repost, renamed company, changed punctuation).
        try:
            applied_index = build_applied_index(cursor)
        except Exception:
            applied_index = ({}, {})

        jobs = []
        for row in rows:
            if isinstance(row, dict):
                d = dict(row)
            else:
                d = {col[0]: row[idx] for idx, col in enumerate(cursor.description)}
            app_id = applied_application_id(d, applied_index)
            d["already_applied"] = app_id is not None
            d["application_id"] = app_id
            r_info = resume_map.get(d.get("id"))
            d["resume_request_status"] = r_info[0] if r_info else None
            d["resume_doc_url"] = r_info[1] if r_info else None
            jobs.append(d)
        
        conn.close()
        
        _jobs_cache[cache_key] = jobs
        _jobs_cache_time = now
        return jsonify(jobs)
    except Exception as e:
        print("get_jobs error:", e)
        return jsonify([])


@app.route('/api/jobs/<string:job_id>/status', methods=['POST'])
def update_job_status(job_id):
    try:
        data = request.get_json()
        status = data.get("status")
        reason = data.get("archive_reason", "")
        
        if not status:
            return jsonify({"error": "Status is required"}), 400
            
        conn = get_db()
        cursor = conn.cursor()
        
        # Determine pipeline status
        pipeline_status = "Sourced"
        if status == "Consideration":
            pipeline_status = "Applied"
        elif status == "Archived":
            pipeline_status = "Archived"
            
        cursor.execute("""
        UPDATE jobs SET status = ?, archive_reason = ?, pipeline_status = ?
        WHERE id = ?
        """, (status, reason, pipeline_status, job_id))
        
        conn.commit()
        conn.close()
        invalidate_jobs_cache()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def _today_key():
    return datetime.date.today().isoformat()


# When a user asks for a manual 120B re-score, they should win Groq's scarce rolling
# budget over the background backlog drain. The manual path sets this timestamp; the worker
# checks it and yields its 120B calls while it is in the future. See fit_scoring_worker.
_manual_priority_until = 0.0
MANUAL_PRIORITY_SEC = 60.0


def grant_manual_priority():
    global _manual_priority_until
    _manual_priority_until = time.time() + MANUAL_PRIORITY_SEC


def _ensure_usage_log(cursor):
    cursor.execute("CREATE TABLE IF NOT EXISTS llm_usage_log (ts REAL, tokens INTEGER, model TEXT)")
    # tolerate an older schema that predates the model column
    cols = [r[1] for r in cursor.execute("PRAGMA table_info(llm_usage_log)")]
    if "model" not in cols:
        cursor.execute("ALTER TABLE llm_usage_log ADD COLUMN model TEXT")


def record_llm_usage(cursor, tokens, model=""):
    """Accumulate today's token + request count, AND append a timestamped, model-tagged row
    so the true rolling-24h usage per model (what Groq's separate TPD caps actually measure)
    can be computed. The per-day `llm_usage` table only has calendar-day totals, which badly
    mislead right after a heavy day and can't tell 120B usage from 20B usage.

    Kept to exactly two writes and NO DDL: the table is created once at init. With several
    Antigravity-respawned server processes contending for the Drive-synced DB, every extra
    write or schema op in this hot path widens the lock window and starves the scorer."""
    cursor.execute(
        "INSERT INTO llm_usage (day, tokens, requests) VALUES (?, ?, 1) "
        "ON CONFLICT(day) DO UPDATE SET tokens = tokens + ?, requests = requests + 1",
        (_today_key(), tokens, tokens),
    )
    cursor.execute("INSERT INTO llm_usage_log (ts, tokens, model) VALUES (?, ?, ?)",
                   (time.time(), tokens, model or ""))
    # Prune only occasionally (old rows are ignored by the 24h WHERE filter anyway), so the
    # full-table DELETE doesn't hold a write lock on every single score.
    if random.random() < 0.02:
        cursor.execute("DELETE FROM llm_usage_log WHERE ts < ?", (time.time() - 90000,))


def get_today_tokens(cursor):
    cursor.execute("SELECT tokens FROM llm_usage WHERE day = ?", (_today_key(),))
    row = cursor.fetchone()
    if not row:
        return 0
    return (row["tokens"] if isinstance(row, dict) else row[0]) or 0


def get_rolling_24h_by_model(cursor):
    """Tokens in the trailing 24h split into the two models Groq caps separately:
    120B (200K TPD) and 8B (500K TPD). This is the window the caps actually enforce, and
    keeping them apart stops 20B fallback usage from inflating the 120B number.

    READ-ONLY: no DDL here. This runs on every status poll, and a CREATE/ALTER would grab a
    write lock and contend with the worker on the Drive-synced DB ('database is locked').
    The table/column are ensured on the write path (record_llm_usage) and at init instead."""
    since = time.time() - 86400
    try:
        rows = cursor.execute(
            "SELECT model, COALESCE(SUM(tokens),0) t FROM llm_usage_log WHERE ts >= ? GROUP BY model",
            (since,)).fetchall()
    except sqlite3.OperationalError:
        return {"p120": 0, "p8": 0}   # log not created yet
    p120 = p8 = 0
    for r in rows:
        mdl = (r["model"] if isinstance(r, dict) else r[0]) or ""
        tok = (r["t"] if isinstance(r, dict) else r[1]) or 0
        if PRECISE_MODEL_RE.search(mdl):
            p120 += tok
        else:
            p8 += tok
    return {"p120": p120, "p8": p8}


def _score_one_job(cursor, job_id, profile_dict, api_key, model_override=None, max_retries=10,
                   backoff_cap=None, daily_retries=0, daily_retry_wait=9.0):
    """Score a single job in place. Returns the fit dict, or raises.

    daily_retries > 0 (used by the MANUAL re-score path) retries through a daily-cap 429
    instead of bailing immediately: Groq's TPD frees on a rolling window, and while we wait
    the background worker yields (see grant_manual_priority), so the freed budget goes to
    this manual call. The bulk worker passes daily_retries=0 and idle-polls instead."""
    if not api_key:
        raise ValueError("LLM API key is not configured. Add your Groq key in the Profile tab.")

    if model_override:
        profile_dict = dict(profile_dict)
        profile_dict["llm_model"] = model_override

    # Fetch job info (using short-lived conn if cursor not provided)
    close_db = False
    conn = None
    if cursor is None:
        conn = get_db()
        cursor = conn.cursor()
        close_db = True

    cursor.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
    job = cursor.fetchone()
    if not job:
        if close_db and conn:
            conn.close()
        raise LookupError("Job not found")

    job = dict(job)
    desc = (job.get("notes") or "").strip()
    
    if close_db and conn:
        conn.close()
        cursor = None

    if looks_like_junk(desc) and job.get("url"):
        try:
            fetched = scrape_job_description(job["url"])
            if not looks_like_junk(fetched) and len(fetched) > len(desc):
                desc = fetched
                conn2 = get_db()
                conn2.execute("UPDATE jobs SET notes = ? WHERE id = ?", (desc[:10000], job_id))
                conn2.commit()
                conn2.close()
        except Exception as e:
            print(f"Fit scoring: live JD fetch failed for {job_id}: {e}")

    fit, tokens = None, 0
    for attempt in range(max_retries):
        try:
            fit, tokens = calculate_role_fit(
                job.get("title", ""), job.get("company_name", ""),
                job.get("location", ""), desc, profile_dict, api_key,
                salary=job.get("salary"),
            )
            break
        except RateLimitError as rle:
            # Daily token cap. The bulk worker (daily_retries=0) re-raises so it can
            # idle-poll rather than grind 10 x 300s looking hung. The manual path
            # (daily_retries>0) instead waits a short beat and retries, keeping the worker
            # yielded, so the rolling window's freed budget lands on this request.
            if rle.daily:
                if daily_retries > 0:
                    daily_retries -= 1
                    grant_manual_priority()  # keep the background worker standing down
                    print(f"Fit scoring: DAILY cap hit for {job_id}; manual retry in "
                          f"{daily_retry_wait:.0f}s ({daily_retries} left).")
                    time.sleep(daily_retry_wait)
                    continue
                print(f"Fit scoring: DAILY token cap hit for {job_id} "
                      f"(retry-after ~{rle.retry_after or 0:.0f}s). Yielding to worker idle-poll.")
                raise rle
            wait_sec = min(rle.retry_after if rle.retry_after else 15.0,
                           backoff_cap or MAX_BACKOFF)
            print(f"Fit scoring: per-minute rate limit for {job_id}. Sleeping {wait_sec:.0f}s "
                  f"(Attempt {attempt+1}/{max_retries})...")
            if attempt < max_retries - 1:
                time.sleep(wait_sec + 0.5)
            else:
                raise rle
        except Exception as e:
            if ("429" in str(e) or "rate limit" in str(e).lower()) and attempt < max_retries - 1:
                time.sleep(15.0)
            else:
                raise e

    if fit is None:
        # Retry budget (per-minute + daily) exhausted without a score. Surface it as a
        # daily cap so the manual endpoint shows the right "try again later" message
        # instead of crashing on a None fit.
        raise RateLimitError("LLM provider rate limit (429)", daily=True)

    conn_write = get_db()
    cur_write = conn_write.cursor()
    cur_write.execute("""
    UPDATE jobs SET experience_fit = ?, criteria_fit = ?, fit_experience_note = ?,
        fit_criteria_note = ?, fit_recommendation = ?, fit_flag = ?, fit_framing = ?,
        fit_scored_at = ?, fit_model = ?
    WHERE id = ?
    """, (
        fit["experience_fit"], fit["criteria_fit"], fit["experience_note"],
        fit["criteria_note"], fit["recommendation"], fit["flag"], fit.get("framing", ""),
        datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p'),
        (model_override or profile_dict.get("llm_model") or ""), job_id,
    ))
    record_llm_usage(cur_write, tokens, model=(model_override or profile_dict.get("llm_model") or ""))
    conn_write.commit()
    conn_write.close()
    return fit


@app.route('/api/jobs/<string:job_id>/fit-score', methods=['POST'])
def score_job_fit(job_id):
    """Compute experience fit and criteria fit for one job, per the role-fit-evaluator rubric."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM profile WHERE id = 1")
        profile = cursor.fetchone()
        if not profile:
            return jsonify({"error": "Profile not configured"}), 400

        profile_dict = dict(profile)
        # Optional {"model": "..."} lets the UI request a high-precision re-score on a
        # single job (70B) without changing the model the bulk worker uses.
        data = request.get_json(silent=True) or {}
        model_override = (data.get("model") or "").strip() or None
        # This is a user-initiated re-score: it should win Groq's rolling 120B budget over
        # the background backlog drain. Grant priority (worker yields) and retry through a
        # daily-cap 429 a few times so the budget that frees while the worker stands down
        # lands here rather than making the user "try again later" repeatedly.
        grant_manual_priority()
        fit = _score_one_job(cursor, job_id, profile_dict,
                             profile_dict.get("llm_api_key", "").strip(),
                             model_override=model_override,
                             # Per-minute 429s clear in seconds; cap each wait so the browser
                             # can't hang. daily_retries lets it ride out a daily-cap blip
                             # (~3 x 9s) while the worker yields. max_retries covers both.
                             max_retries=8,
                             backoff_cap=20.0,
                             daily_retries=3,
                             daily_retry_wait=9.0)
        conn.commit()
        return jsonify({"success": True, "model": model_override or profile_dict.get("llm_model"), **fit})
    except LookupError as e:
        return jsonify({"error": str(e)}), 404
    except RateLimitError as rle:
        # Report which 429 this actually is. Calling every 429 a spent daily budget sent
        # people away for hours when the real wait was a few seconds.
        if rle.daily:
            try:
                roll = get_rolling_24h_by_model(conn.cursor())["p120"]
                usage = f" ({roll:,} of ~200K used in the last 24h)"
            except Exception:
                usage = ""
            msg = (f"Groq's 120B daily budget is spent{usage}. It's a rolling 24h window, "
                   "so it frees gradually as older usage ages out - not a calendar-day reset. "
                   "Try again in a few minutes.")
        else:
            wait = f" (~{rle.retry_after:.0f}s)" if rle.retry_after else ""
            msg = (f"Hit the per-minute token limit{wait}. This clears in seconds - "
                   "wait a moment and re-score again.")
        return jsonify({"error": msg, "daily": rle.daily}), 429
    except ValueError as e:
        # Missing/invalid configuration is a client-fixable problem, not a server fault.
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/jobs/<string:job_id>/claude-rescore', methods=['POST'])
def queue_claude_rescore(job_id):
    """Queue a job for Claude (Opus) re-scoring in a Claude Code session.

    Manual re-score no longer calls Groq inline - it marks the job so that Claude, driven
    interactively in a session, reads the full JD, applies the role-fit rubric, and writes a
    high-quality score (fit_model = claude-*). The queue is drained by scripts/claude_rescore.py.
    """
    conn = get_db()
    try:
        cur = conn.cursor()
        job = cur.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not job:
            return jsonify({"error": "Job not found"}), 404
        now = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
        cur.execute("UPDATE jobs SET claude_rescore_status = 'queued', claude_rescore_at = ? "
                    "WHERE id = ?", (now, job_id))
        conn.commit()
        n = cur.execute("SELECT COUNT(*) c FROM jobs WHERE claude_rescore_status = 'queued'").fetchone()
        queued = (n["c"] if isinstance(n, dict) else n[0]) if n else 0
        return jsonify({"success": True, "queued": True, "queued_count": queued})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/claude-rescore/queue', methods=['GET'])
def claude_rescore_queue():
    """List jobs currently queued for Claude re-scoring (drives the UI count and lets a
    Claude Code session see what's pending)."""
    conn = get_db()
    try:
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT id, company_name, title, location, claude_rescore_at "
            "FROM jobs WHERE claude_rescore_status = 'queued' ORDER BY claude_rescore_at DESC"
        ).fetchall()
        return jsonify({"count": len(rows), "jobs": [dict(r) for r in rows]})
    finally:
        conn.close()


@app.route('/api/jobs/fit-score/bulk', methods=['POST'])
def score_jobs_fit_bulk():
    """Score a list of job ids. Partial failures are reported per-id, not fatal."""
    data = request.get_json() or {}
    job_ids = data.get("job_ids", [])
    if not job_ids:
        return jsonify({"error": "job_ids is required"}), 400
    if len(job_ids) > 50:
        return jsonify({"error": "Refusing to score more than 50 jobs at once"}), 400

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM profile WHERE id = 1")
        profile = cursor.fetchone()
        if not profile:
            return jsonify({"error": "Profile not configured"}), 400

        profile_dict = dict(profile)
        api_key = profile_dict.get("llm_api_key", "").strip()

        results, errors = {}, {}
        for jid in job_ids:
            try:
                results[jid] = _score_one_job(cursor, jid, profile_dict, api_key)
                conn.commit()  # commit per job so a late failure doesn't lose earlier work
            except Exception as e:
                errors[jid] = str(e)

        return jsonify({"success": True, "scored": results, "errors": errors})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


# --- TAILORED RESUME REQUEST QUEUE ---
# The tailored-resume-builder skill needs the Google Drive connector and a PDF
# page-count verification loop, so it runs inside Claude rather than in this process.
# These endpoints are the handoff: the UI enqueues, Claude drains, the UI polls.

@app.route('/api/resumes/request', methods=['POST'])
def request_tailored_resume():
    data = request.get_json() or {}
    job_id = data.get("job_id")
    if not job_id:
        return jsonify({"error": "job_id is required"}), 400

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM jobs WHERE id = ?", (job_id,))
        if not cursor.fetchone():
            return jsonify({"error": "Job not found"}), 404

        # Reuse an existing open request rather than piling up duplicates.
        cursor.execute("""
        SELECT id, status, doc_url FROM resume_requests
        WHERE job_id = ? AND status IN ('Queued', 'In Progress', 'Done')
        ORDER BY rowid DESC LIMIT 1
        """, (job_id,))
        existing = cursor.fetchone()
        if existing:
            e = dict(existing)
            return jsonify({"success": True, "request_id": e["id"], "status": e["status"],
                            "doc_url": e["doc_url"], "existing": True})

        req_id = str(uuid.uuid4())
        cursor.execute("""
        INSERT INTO resume_requests (id, job_id, status, requested_at)
        VALUES (?, ?, 'Queued', ?)
        """, (req_id, job_id, datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')))
        conn.commit()
        return jsonify({"success": True, "request_id": req_id, "status": "Queued", "existing": False})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/resumes/requests', methods=['GET'])
def list_resume_requests():
    """Queue view. `?status=Queued` is what Claude polls to find work to do."""
    status = request.args.get("status")
    conn = get_db()
    cursor = conn.cursor()
    sql = """
    SELECT r.*, j.title, j.company_name, j.url AS job_url, j.location
    FROM resume_requests r JOIN jobs j ON j.id = r.job_id
    """
    params = []
    if status:
        sql += " WHERE r.status = ?"
        params.append(status)
    sql += " ORDER BY r.rowid DESC"
    cursor.execute(sql, params)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify(rows)


@app.route('/api/resumes/requests/<string:req_id>', methods=['POST'])
def update_resume_request(req_id):
    """Claude writes the finished Google Doc URL back here."""
    data = request.get_json() or {}
    status = data.get("status")
    if status not in ("Queued", "In Progress", "Done", "Failed"):
        return jsonify({"error": "status must be Queued, In Progress, Done, or Failed"}), 400

    doc_url = data.get("doc_url", "")
    error = data.get("error", "")

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT job_id FROM resume_requests WHERE id = ?", (req_id,))
        row = cursor.fetchone()
        if not row:
            return jsonify({"error": "Request not found"}), 404

        fulfilled = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p') if status in ("Done", "Failed") else ""
        cursor.execute("""
        UPDATE resume_requests SET status = ?, doc_url = ?, error = ?, fulfilled_at = ?
        WHERE id = ?
        """, (status, doc_url, error, fulfilled, req_id))

        # The queue keeps its own doc_url and the UI reads that first, so there is no
        # need to touch jobs.resume_url -- which is owned by the older DOCX flow and
        # would be destroyed here.

        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/jobs/<string:job_id>', methods=['DELETE'])
def delete_job(job_id):
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/jobs/<string:job_id>/tracking', methods=['POST'])
def update_job_tracking(job_id):
    try:
        data = request.get_json()
        app_status = data.get("app_status", "Applied") # Maps to pipeline_status
        pipeline_notes = data.get("notes", "")
        resume_url = data.get("resume_url")
        
        conn = get_db()
        cursor = conn.cursor()
        
        if resume_url is not None:
            cursor.execute("""
            UPDATE jobs SET pipeline_status = ?, pipeline_notes = ?, resume_url = ?
            WHERE id = ?
            """, (app_status, pipeline_notes, resume_url, job_id))
        else:
            cursor.execute("""
            UPDATE jobs SET pipeline_status = ?, pipeline_notes = ?
            WHERE id = ?
            """, (app_status, pipeline_notes, job_id))
        
        # Add a pipeline event audit round record
        cursor.execute("""
        INSERT INTO pipeline_events (job_id, stage, status, created_at)
        VALUES (?, ?, 'Completed', ?)
        """, (job_id, app_status, datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')))
        
        conn.commit()
        conn.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/jobs/<string:job_id>/unstar', methods=['POST'])
def unstar_job(job_id):
    """Un-star a role: remove it from Under Consideration and release the star.

    Refuses if the role has already been APPLIED to. A submitted application lives in the
    Application & Interview Pipeline, and the star is the board-side record that it came from
    there; unstarring would orphan that history. So the star is kept and the caller is told
    why (mirrors the same find_prior_application guard that blocks re-queuing on star).
    """
    conn = get_db()
    try:
        cur = conn.cursor()
        job = cur.execute("SELECT id, url, title, company_name, status FROM jobs WHERE id = ?",
                          (job_id,)).fetchone()
        if not job:
            return jsonify({"error": "Job not found"}), 404

        prior = find_prior_application(cur, job)
        if prior:
            when = f" on {prior['applied_date']}" if prior["applied_date"] else ""
            return jsonify({
                "applied": True,
                "error": f"Can't unstar -- you already applied to this role{when}. "
                         f"It's tracked in your Application & Interview Pipeline now.",
                "application_id": prior["id"],
            }), 409

        # No application yet: drop any pending queue rows and release the star on the board.
        cur.execute("DELETE FROM apply_requests WHERE job_id = ? AND status != 'Submitted'",
                    (job_id,))
        removed = cur.rowcount
        cur.execute("""UPDATE jobs SET status = 'Lead', pipeline_status = ''
                        WHERE id = ? AND status = 'Consideration'""", (job_id,))
        conn.commit()
        return jsonify({"success": True, "removed_requests": removed})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


# --- KANBAN INTERVIEW PIPELINE API ---
@app.route('/api/pipeline', methods=['GET'])
def get_pipeline():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT j.*, c.cohort as company_cohort
    FROM jobs j
    LEFT JOIN companies c ON LOWER(c.name) = LOWER(j.company_name)
    WHERE j.status = 'Consideration' OR j.pipeline_status != 'Sourced'
    """)
    jobs = cursor.fetchall()
    
    # Group by pipeline rounds
    pipeline = {
        "Applied": [],
        "Recruiter Screen": [],
        "Phone Screen": [],
        "Onsite Loop": [],
        "Offer": [],
        "Rejected": []
    }
    
    for j in jobs:
        stage = j.get("pipeline_status", "Applied")
        if stage in pipeline:
            pipeline[stage].append(j)
            
    conn.close()
    return jsonify(pipeline)

@app.route('/api/pipeline/round', methods=['POST'])
def add_pipeline_round():
    try:
        data = request.get_json()
        job_id = data.get("job_id")
        stage = data.get("stage")
        event_date = data.get("event_date", "")
        status = data.get("status", "Scheduled")
        notes = data.get("notes", "")
        
        if not job_id or not stage:
            return jsonify({"error": "Job ID and Stage are required"}), 400
            
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
        INSERT INTO pipeline_events (job_id, stage, event_date, status, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """, (job_id, stage, event_date, status, notes, datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')))
        
        conn.commit()
        conn.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- PREPARATION HUB API ---

def call_llm_for_prep_guide(job, profile, api_key):
    base_url = (profile.get("llm_base_url") or "https://api.groq.com/openai/v1").rstrip("/")
    prof_model = profile.get("llm_model") or ""
    
    # Model fallback hierarchy (uses openai/gpt-oss-120b then openai/gpt-oss-20b):
    candidate_models = []
    if prof_model:
        candidate_models.append(prof_model)
    candidate_models.extend(["openai/gpt-oss-120b", "openai/gpt-oss-20b"])
    
    # Deduplicate preserving order
    models_to_try = []
    for m in candidate_models:
        if m and m not in models_to_try:
            models_to_try.append(m)

    company = job.get("company_name", "")
    title = job.get("title", "")
    location = job.get("location", "")
    notes = (job.get("notes") or "")[:4000]

    prompt = f"""
You are an expert executive Product Manager interview coach and career advisor.
Research and generate a comprehensive, highly actionable interview preparation strategy for a Product Management candidate interviewing at {company} for the role of {title} ({location}).

CANDIDATE CANONICAL RESUME SUMMARY:
{(profile.get("canonical_resume", "") or profile.get("summary", ""))[:3000]}

JOB DESCRIPTION / DETAILS:
{notes if notes else title + ' at ' + company}

Respond with ONLY a valid JSON object containing the following keys:
1. "summary": A 2-3 sentence strategic summary of {company}'s Product Management culture, core product priorities, and interview philosophy.
2. "stages": An array of 4-5 objects representing the standard interview loop stages at {company} for this level. Each object must have "title" (e.g. "Stage 1: Recruiter Screen", "Stage 2: Product Sense & Design", "Stage 3: Technical Execution & System Design", "Stage 4: Product Metrics & Strategy", "Stage 5: Leadership & Values") and "desc" (1-2 sentences on expectations for that stage).
3. "rubric": An array of 4 objects detailing the core competencies/rubric signals interviewers evaluate. Each object must have "competency" (e.g. "Product Vision & User Empathy", "Analytical & Data Rigor", "Cross-Functional Execution", "Strategic Thinking & Alignment") and "details" (what success looks like in this round).
4. "strategic_focus": A list of 3-4 key product focus areas, tech stack elements, or strategic challenges at {company} that the candidate must speak intelligently about.
5. "tips": A list of 4-5 actionable pro-tips for acing the interview loop at {company}.
6. "question_bank": A list of 5-7 specific, likely interview questions tailored for a {title} role at {company}.
"""

    last_err = None
    for model in models_to_try:
        payload = {
            "model": model,
            "temperature": 0.3,
            "response_format": {"type": "json_object"},
            "max_tokens": 2200,
            "messages": [
                {"role": "system", "content": "You are a top-tier PM interview coach. Return a valid JSON object with the requested interview prep strategy."},
                {"role": "user", "content": prompt}
            ]
        }
        if "gpt-oss" in model or "reasoning" in model:
            payload["reasoning_effort"] = "low"

        try:
            res = requests.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload, timeout=60
            )
            if res.status_code == 200:
                data = res.json()
                content = data["choices"][0]["message"]["content"]
                return json.loads(content)
            else:
                last_err = f"Model [{model}] returned {res.status_code}: {res.text[:200]}"
                print(f"Prep LLM warning: {last_err}, trying next candidate model...")
        except Exception as e:
            last_err = f"Model [{model}] exception: {str(e)}"
            print(f"Prep LLM exception: {last_err}, trying next candidate model...")

    raise RuntimeError(f"All LLM models failed to generate prep guide: {last_err}")


@app.route('/api/prep/active-roles', methods=['GET'])
def get_active_prep_roles():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT a.id as app_id, a.company as company_name, a.role as role_title, a.progress as pipeline_status, a.outcome, a.notes as app_notes, a.resume_link,
           g.guide_json, g.user_notes, g.updated_at
    FROM applications a
    LEFT JOIN prep_guides g ON g.app_id = a.id
    WHERE LOWER(a.outcome) = 'in progress' OR LOWER(a.outcome) NOT IN ('closed', 'rejected', 'withdrawn')
    ORDER BY a.company ASC, a.role ASC
    """)
    rows = cursor.fetchall()
    conn.close()
    return jsonify(rows)


@app.route('/api/prep/generate-guide', methods=['POST'])
def generate_prep_guide():
    data = request.get_json() or {}
    app_id = data.get("app_id") or data.get("job_id")
    if not app_id:
        return jsonify({"error": "Missing app_id"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM applications WHERE id = ?", (app_id,))
    app_row = cursor.fetchone()
    cursor.execute("SELECT * FROM profile WHERE id = 1")
    prof = cursor.fetchone()
    
    if not app_row:
        conn.close()
        return jsonify({"error": "Application not found in Application & Interview Pipeline"}), 404
        
    api_key = (prof.get("llm_api_key") or "").strip() if prof else ""
    if not api_key:
        conn.close()
        return jsonify({"error": "LLM API Key not configured. Add your Groq key in the Profile tab."}), 400

    try:
        job_dict = {
            "company_name": app_row["company"],
            "title": app_row["role"],
            "location": "",
            "notes": app_row.get("notes") or ""
        }
        guide_json = call_llm_for_prep_guide(job_dict, dict(prof) if prof else {}, api_key)
        now_str = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
        cursor.execute("""
        INSERT INTO prep_guides (app_id, company_name, role_title, guide_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(app_id) DO UPDATE SET
            company_name=excluded.company_name,
            role_title=excluded.role_title,
            guide_json=excluded.guide_json,
            updated_at=excluded.updated_at
        """, (app_row["id"], app_row["company"], app_row["role"], json.dumps(guide_json), now_str))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "guide": guide_json, "updated_at": now_str})
    except Exception as e:
        conn.close()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prep/notes', methods=['POST'])
def save_prep_notes():
    data = request.get_json() or {}
    app_id = data.get("app_id") or data.get("job_id")
    notes = data.get("notes", "")
    if not app_id:
        return jsonify({"error": "Missing app_id"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT company, role FROM applications WHERE id = ?", (app_id,))
    app_row = cursor.fetchone()
    if not app_row:
        conn.close()
        return jsonify({"error": "Application not found in Application & Interview Pipeline"}), 404

    now_str = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
    cursor.execute("""
    INSERT INTO prep_guides (app_id, company_name, role_title, user_notes, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(app_id) DO UPDATE SET
        user_notes=excluded.user_notes,
        updated_at=excluded.updated_at
    """, (app_id, app_row["company"], app_row["role"], notes, now_str))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "updated_at": now_str})


@app.route('/api/prep/next-round/<int:app_id>', methods=['GET'])
def prep_next_round(app_id):
    """Adaptive next-round context (P4): reads the role's completed interview_reviews and
    surfaces the weakest v3 dimension across rounds plus the latest round's one fix, so prep
    adapts to how earlier rounds actually went. role_job_id references applications.id."""
    V3 = {"structure_clarity": "Structure & Clarity", "product_customer_sense": "Product & Customer Sense",
          "strategic_analytical": "Strategic & Analytical Rigor", "execution_craft": "Execution & Craft",
          "leadership_ownership": "Leadership & Ownership", "delivery_vocal": "Delivery & Vocal Presence"}
    conn = get_db()
    rows = conn.execute(
        "SELECT round_type, interview_date, created_at, overall_score, the_one_fix, scores_v2_json "
        "FROM interview_reviews WHERE role_job_id = ? AND overall_score IS NOT NULL "
        "ORDER BY COALESCE(interview_date, created_at) ASC, id ASC", (app_id,)).fetchall()
    conn.close()
    rounds, dim_sums, dim_cnts, latest_fix = [], {}, {}, ""
    for r in rows:
        d = dict(r)
        try:
            dims = (json.loads(d.get("scores_v2_json") or "{}") or {}).get("dims") or {}
        except Exception:
            dims = {}
        nums = [(k, v) for k, v in dims.items() if isinstance(v, (int, float))]
        weak = min(nums, key=lambda kv: kv[1]) if nums else None
        for k, v in nums:
            dim_sums[k] = dim_sums.get(k, 0) + v
            dim_cnts[k] = dim_cnts.get(k, 0) + 1
        if d.get("the_one_fix"):
            latest_fix = d["the_one_fix"]
        rounds.append({"round_type": d["round_type"],
                       "date": d.get("interview_date") or (d.get("created_at") or "")[:10],
                       "overall": d["overall_score"],
                       "weakest": V3.get(weak[0], weak[0]) if weak else None,
                       "weakest_score": round(weak[1], 1) if weak else None})
    weakest_dim, reco = None, ""
    if dim_sums:
        avgs = {k: dim_sums[k] / dim_cnts[k] for k in dim_sums}
        wk = min(avgs, key=lambda k: avgs[k])
        weakest_dim = {"key": wk, "label": V3.get(wk, wk), "avg": round(avgs[wk], 1)}
        reco = (f"Across {len(rounds)} completed round(s), your weakest dimension is "
                f"{weakest_dim['label']} ({weakest_dim['avg']}). Focus there before the next round.")
    conn2 = get_db()
    prow = conn2.execute("SELECT planned_rounds_json FROM prep_guides WHERE app_id = ?", (app_id,)).fetchone()
    conn2.close()
    try:
        planned = json.loads((prow["planned_rounds_json"] if prow else "") or "[]")
    except Exception:
        planned = []
    return jsonify({"rounds": rounds, "planned": planned, "weakest_dim": weakest_dim,
                    "latest_one_fix": latest_fix, "recommendation": reco})


@app.route('/api/prep/planned-rounds', methods=['POST'])
def save_planned_rounds():
    """Save the manually-entered upcoming rounds for a role (P4). These are what the recruiter
    shared and override any web-derived guess. app_id references applications.id."""
    data = request.get_json() or {}
    app_id = data.get("app_id")
    rounds = data.get("rounds", [])
    if not app_id:
        return jsonify({"error": "Missing app_id"}), 400
    conn = get_db()
    app_row = conn.execute("SELECT company, role FROM applications WHERE id = ?", (app_id,)).fetchone()
    if not app_row:
        conn.close()
        return jsonify({"error": "Application not found"}), 404
    now = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
    conn.execute(
        "INSERT INTO prep_guides (app_id, company_name, role_title, planned_rounds_json, updated_at) "
        "VALUES (?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET "
        "planned_rounds_json=excluded.planned_rounds_json, updated_at=excluded.updated_at",
        (app_id, app_row["company"], app_row["role"], json.dumps(rounds), now))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route('/api/prep/start', methods=['POST'])
def start_prep():
    """Mark a role's prep as started by creating its prep_guides row, so it moves into the
    My Roles 'Active' list. app_id references applications.id."""
    data = request.get_json() or {}
    app_id = data.get("app_id")
    if not app_id:
        return jsonify({"error": "Missing app_id"}), 400
    conn = get_db()
    a = conn.execute("SELECT company, role FROM applications WHERE id = ?", (app_id,)).fetchone()
    if not a:
        conn.close()
        return jsonify({"error": "Application not found"}), 404
    now = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
    conn.execute(
        "INSERT INTO prep_guides (app_id, company_name, role_title, updated_at) VALUES (?,?,?,?) "
        "ON CONFLICT(app_id) DO UPDATE SET updated_at=excluded.updated_at",
        (app_id, a["company"], a["role"], now))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


# --- RESUME TAILORING GENERATOR API ---
@app.route('/api/resumes/tailor', methods=['POST'])
def tailor_resume():
    try:
        data = request.get_json()
        job_id = data.get("job_id")
        selected_bullets = data.get("selected_bullets", [])
        formatting = data.get("formatting", {"font": "Calibri", "fontSize": 11, "margin": 0.75})
        
        conn = get_db()
        cursor = conn.cursor()
        
        # Load profile
        cursor.execute("SELECT * FROM profile WHERE id = 1")
        profile = cursor.fetchone()
        
        if not profile:
            conn.close()
            return jsonify({"error": "Profile not configured"}), 400
            
        job_title = "Product Manager"
        company_name = "General Target"
        
        if job_id:
            cursor.execute("SELECT title, company_name FROM jobs WHERE id = ?", (job_id,))
            job = cursor.fetchone()
            if job:
                job_title = job["title"]
                company_name = job["company_name"]
                
        # Generate the Word DOCX resume
        filename, file_path = generate_resume_docx(profile, selected_bullets, formatting, job_title, company_name)
        
        # Save resume details in table
        resume_id = str(uuid.uuid4())
        cursor.execute("""
        INSERT INTO tailored_resumes (id, job_id, selected_bullets, formatting, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """, (
            resume_id, job_id or "general", json.dumps(selected_bullets), json.dumps(formatting), file_path,
            datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
        ))
        
        # Update job with tailored resume url
        if job_id:
            download_url = f"/api/resumes/download/{resume_id}"
            cursor.execute("UPDATE jobs SET resume_url = ? WHERE id = ?", (download_url, job_id))
            
        conn.commit()
        conn.close()
        
        return jsonify({
            "success": True,
            "resume_id": resume_id,
            "filename": filename,
            "download_url": f"/api/resumes/download/{resume_id}"
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/resumes/download/<string:resume_id>', methods=['GET'])
def download_resume(resume_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT file_path FROM tailored_resumes WHERE id = ?", (resume_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Resume not found"}), 404
    file_path = row["file_path"]
    directory = os.path.dirname(file_path)
    filename = os.path.basename(file_path)
    return send_from_directory(directory, filename, as_attachment=True)

# --- DAILY CRAWLER SCAN MANAGEMENT ---
def background_scan_thread(company_name=None):
    global is_scanning
    print("Background thread scan started...")
    try:
        python_executable = sys.executable
        script_path = os.path.join(SCRIPTS_DIR, "check_new_jobs.py")
        
        args = [python_executable, "-u", script_path]
        if company_name:
            args.append(company_name)
            
        process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        
        while True:
            line = process.stdout.readline()
            if not line:
                break
            print(f"[Crawler] {line.rstrip()}")
            
        process.wait(timeout=900)
        if process.returncode == 0:
            print("Background scan completed successfully.")
            try:
                conn = get_db()
                cursor = conn.cursor()
                now_str = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
                cursor.execute("UPDATE profile SET last_scanned_at = ? WHERE id = (SELECT id FROM profile ORDER BY id DESC LIMIT 1)", (now_str,))
                conn.commit()
                conn.close()
            except Exception as dbe:
                print("Failed to update last_scanned_at:", dbe)
        else:
            print(f"Background scan failed with code {process.returncode}")
            try:
                conn = get_db()
                cur = conn.cursor()
                for _c, _t in [("source_eligible_distinct", "INTEGER DEFAULT 0"),
                               ("board_active_distinct", "INTEGER DEFAULT 0"),
                               ("status", "TEXT DEFAULT 'success'"),
                               ("error_message", "TEXT DEFAULT ''")]:
                    try:
                        cur.execute(f"ALTER TABLE scan_audit ADD COLUMN {_c} {_t}")
                    except sqlite3.OperationalError:
                        pass
                row = cur.execute("SELECT status FROM scan_audit ORDER BY id DESC LIMIT 1").fetchone()
                if not row or row["status"] != "error":
                    now_str = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
                    try:
                        cur.execute("SELECT COUNT(*) FROM jobs WHERE status != 'Archived'")
                        board_active = cur.fetchone()[0]
                    except Exception:
                        board_active = 0
                    cur.execute("""
                        INSERT INTO scan_audit (ran_at, status, error_message, source_total, source_eligible,
                                                board_active, missing_count, per_location, missing_sample,
                                                source_eligible_distinct, board_active_distinct)
                        VALUES (?, 'error', ?, 0, 0, ?, 0, '{}', '[]', 0, ?)
                    """, (now_str, f"Crawler process exited with error code {process.returncode}", board_active, board_active))
                    conn.commit()
                conn.close()
            except Exception as audit_rec_err:
                print("Failed to record background scan exit error:", audit_rec_err)
    except Exception as e:
        print("Error during background scan:", e)
        traceback.print_exc()
    finally:
        with scan_lock:
            is_scanning = False

@app.route('/api/scan', methods=['POST'])
def trigger_scan():
    global is_scanning
    company_name = request.args.get("company", "").strip()
    
    with scan_lock:
        if is_scanning:
            return jsonify({"success": False, "message": "Scan already in progress."})
        is_scanning = True
        
    thread = threading.Thread(target=background_scan_thread, args=(company_name or None,))
    thread.daemon = True
    thread.start()
    
    return jsonify({"success": True, "message": "Background scan started."})

@app.route('/api/scan-status', methods=['GET'])
def get_scan_status():
    global is_scanning
    return jsonify({"is_scanning": is_scanning})

# --- JOB DESCRIPTION API ---
def _jd_from_jsonld(raw_html):
    """Many ATSs (Ashby, Greenhouse, others) embed a schema.org JobPosting as
    <script type="application/ld+json">. That's the cleanest source when the page is
    client-rendered and the DOM has no readable description.

    NOTE: this reads the RAW html, not the parsed soup -- the caller strips <script> tags
    before parsing, which would otherwise delete the very block we need."""
    pat = re.compile(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                     re.DOTALL | re.IGNORECASE)
    for m in pat.finditer(raw_html or ''):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:
            continue
        for item in (data if isinstance(data, list) else [data]):
            if not isinstance(item, dict):
                continue
            if 'jobposting' in str(item.get('@type', '')).lower():
                desc = item.get('description') or ''
                if desc:
                    return BeautifulSoup(desc, 'html.parser').get_text('\n', strip=True)
    return ""


def _jd_from_smartrecruiters(url):
    """SmartRecruiters serves a browser-check interstitial to plain HTTP clients, but
    exposes the posting via a public API."""
    m = re.search(r'smartrecruiters\.com/([^/]+)/(\d+)', url)
    if not m:
        return ""
    api = f"https://api.smartrecruiters.com/v1/companies/{m.group(1)}/postings/{m.group(2)}"
    try:
        r = requests.get(api, headers={'User-Agent': 'Mozilla/5.0'}, timeout=8, verify=False)
        if r.status_code != 200:
            return ""
        d = r.json()
        chunks = []
        for key in ('jobAd',):
            sections = (d.get(key) or {}).get('sections') or {}
            for sec in sections.values():
                if isinstance(sec, dict):
                    if sec.get('title'):
                        chunks.append(str(sec['title']))
                    if sec.get('text'):
                        chunks.append(BeautifulSoup(str(sec['text']), 'html.parser').get_text('\n', strip=True))
        return '\n'.join(c for c in chunks if c)
    except Exception:
        return ""


def _jd_from_apple(raw_html):
    """Extract full JD and pay range from Apple Careers React router hydration JSON."""
    m = re.search(r'window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\);', raw_html or '')
    if not m:
        return ""
    try:
        hyd = json.loads(json.loads(f'"{m.group(1)}"'))
        jd = hyd.get("loaderData", {}).get("jobDetails", {}).get("jobsData", {})
        if not jd:
            return ""
        chunks = []
        if jd.get("postingTitle"):
            chunks.append(f"Title: {jd['postingTitle']}")
        locs = [l.get("name", "") for l in (jd.get("locations") or []) if isinstance(l, dict) and l.get("name")]
        if locs:
            chunks.append(f"Locations: {', '.join(locs)}")
        if jd.get("jobSummary"):
            chunks.append(f"Summary:\n{jd['jobSummary']}")
        if jd.get("description"):
            chunks.append(f"Description:\n{jd['description']}")
        if jd.get("minimumQualifications"):
            chunks.append(f"Minimum Qualifications:\n{jd['minimumQualifications']}")
        if jd.get("preferredQualifications"):
            chunks.append(f"Preferred Qualifications:\n{jd['preferredQualifications']}")
        for foot in (jd.get("postingFooters") or []):
            for loc_list in (foot.get("localizations") or {}).values():
                for item in (loc_list or []):
                    if isinstance(item, dict) and item.get("content"):
                        txt = BeautifulSoup(str(item["content"]), "html.parser").get_text("\n", strip=True)
                        if txt and txt not in chunks:
                            chunks.append(txt)
        return "\n\n".join(c for c in chunks if c)
    except Exception:
        return ""


def scrape_job_description(url, max_lines=250):
    """Fetch and clean the JD text at `url`. Raises on network/parse failure."""
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

    # SmartRecruiters blocks plain scrapes; go straight to its API.
    if 'smartrecruiters.com' in url:
        api_txt = _jd_from_smartrecruiters(url)
        if len(api_txt) > 400:
            lines = [l.strip() for l in api_txt.split('\n') if l.strip()]
            return '\n'.join(lines[:max_lines])

    response = requests.get(url, headers=headers, timeout=8, verify=False)

    if 'jobs.apple.com' in (url or '').lower():
        apple_txt = _jd_from_apple(response.text)
        if len(apple_txt) > 400:
            lines = [l.strip() for l in apple_txt.split('\n') if l.strip()]
            return '\n'.join(lines[:max_lines])

    html_clean = re.sub(r'<(script|style|svg|noscript)[^>]*>.*?</\1>', '', response.text, flags=re.DOTALL|re.IGNORECASE)
    soup = BeautifulSoup(html_clean, 'html.parser')

    # Remove tags we don't want
    for s in soup(["script", "style", "nav", "footer", "header", "aside"]):
        s.decompose()

    # Candidate JD containers across the ATSs this board actually crawls.
    # Greenhouse (25% of the board) uses .job__description; Ashby/Lever/SmartRecruiters
    # and Workday each have their own. Generic ones are kept as a fallback.
    selectors = [
        # ATS-specific (highest signal)
        '.job__description', '[class*="job__description"]',          # Greenhouse
        '[class*="_descriptionText"]', '[class*="descriptionText"]', # Ashby
        '.posting-page .section-wrapper', '.posting-description',    # Lever
        '.jobad-main', '[itemprop="description"]',                   # SmartRecruiters
        '[data-automation-id="jobPostingDescription"]',              # Workday
        # Generic
        '.job-description', '.job-description-text', '#job-description',
        '[class*="jobDescription"]', '[class*="job-description"]',
        '.jobDescriptionContent', '.jobSection', '.section-job-description',
        '#content', 'main', 'article', '.description', '#description',
    ]

    # IMPORTANT: pick the LARGEST match, not the first. The previous "first match wins"
    # logic grabbed whichever selector appeared earliest in this list, which on Greenhouse
    # pages matched a 260-char compensation disclaimer (.description) and discarded the
    # real 9,978-char job description sitting in .job__description.
    best = ""
    for sel in selectors:
        try:
            for elem in soup.select(sel):
                txt = elem.get_text('\n', strip=True)
                if len(txt) > len(best):
                    best = txt
        except Exception:
            continue

    # Client-rendered boards (Ashby) have no readable DOM description -- but do embed a
    # schema.org JobPosting. Prefer whichever source yields more real content.
    jsonld = _jd_from_jsonld(response.text)
    if len(jsonld) > len(best):
        best = jsonld

    # If even the best container is too thin to be a real JD, fall back to whole-page text.
    body_content = best
    if len(body_content) < 400:
        full = soup.get_text('\n', strip=True)
        if len(full) > len(body_content):
            body_content = full

    # Clean up text lines
    lines = [line.strip() for line in body_content.split('\n') if line.strip()]
    return '\n'.join(lines[:max_lines])  # Limit length


@app.route('/api/job-description', methods=['GET'])
def get_job_description():
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "No url parameter provided"}), 400

    try:
        return jsonify({"description": scrape_job_description(url)})
    except Exception as e:
        return jsonify({"error": f"Failed to retrieve job details: {e}"}), 500

# --- VERIFIED INTERVIEW INSIGHTS API ---
@app.route('/api/insights', methods=['GET'])
def get_insights_api():
    company = request.args.get("company", "").strip()
    if not company:
        return jsonify({"error": "No company provided"}), 400
    
    normalized = company.lower().replace(" ", "")
    for key, data in INTERVIEW_INSIGHTS.items():
        if key in normalized:
            return jsonify(data)
            
    # Default stages
    return jsonify({
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
    })

# --- LINKEDIN CONNECTIONS API ---
# --- JOB APPLICATION TRACKER ---
# --- APPLICATION ANSWER BANK -----------------------------------------------------
ANSWER_SECTIONS = ("contact", "eligibility", "logistics", "demographics", "narrative", "rules")

# Defaults chosen to be safe rather than convenient: every demographic question defaults
# to "Decline to answer", which is a valid response on every US application.
ANSWER_DEFAULTS = {
    "contact": {"full_name": "", "email": "", "phone": "", "city": "", "state": "",
                "country": "United States", "linkedin": "", "portfolio": ""},
    "eligibility": {"work_authorized_us": "Yes", "requires_sponsorship_now": "No",
                    "requires_sponsorship_future": "No", "citizenship_statement": "US Citizen"},
    "logistics": {"notice_period": "2 weeks", "earliest_start": "Negotiable",
                  "willing_to_relocate": "No", "remote_preference": "Remote or Hybrid",
                  "desired_base_salary": "", "salary_disclosure_style": "range"},
    "demographics": {"gender": "Decline to answer", "ethnicity": "Decline to answer",
                     "veteran_status": "Decline to answer", "disability_status": "Decline to answer"},
    "narrative": {"why_this_company": "", "cover_letter_stance": "skip"},
    "rules": {"daily_target": 10, "run_times_et": "10:00, 17:30", "weekdays_only": "Yes",
              "min_experience_fit": 7, "min_criteria_fit": 7,
              "levels": "Senior, Staff, Principal", "manual_ats_mode": "prepare"},
}


def _answers_row_to_dict(row, profile=None):
    """Merge stored answers over the defaults, pre-filling contact from the profile."""
    out = {}
    for sec in ANSWER_SECTIONS:
        base = dict(ANSWER_DEFAULTS[sec])
        try:
            stored = json.loads((row[f"{sec}_json"] if row else "") or "{}")
        except Exception:
            stored = {}
        base.update({k: v for k, v in stored.items() if v not in (None,)})
        out[sec] = base

    # First-run convenience: seed contact details from the profile the board already has,
    # but never overwrite something the user has explicitly saved.
    if profile:
        seed = {"full_name": profile.get("name"), "email": profile.get("email"),
                "phone": profile.get("phone"), "linkedin": profile.get("linkedin")}
        for k, v in seed.items():
            if v and not out["contact"].get(k):
                out["contact"][k] = v
        if not out["contact"].get("city") and profile.get("location"):
            out["contact"]["city"] = str(profile["location"]).split(",")[0].strip()
    return out


def answers_are_complete(ans):
    """The minimum an ATS form cannot be filled without."""
    required = [("contact", "full_name"), ("contact", "email"), ("contact", "phone"),
                ("contact", "city"), ("eligibility", "work_authorized_us")]
    missing = [f"{s}.{k}" for s, k in required if not str(ans.get(s, {}).get(k, "")).strip()]
    return (not missing), missing


@app.route('/api/application-answers', methods=['GET'])
def get_application_answers():
    conn = get_db()
    cur = conn.cursor()
    row = cur.execute("SELECT * FROM application_answers WHERE id = 1").fetchone()
    prof = cur.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    conn.close()
    data = _answers_row_to_dict(row, dict(prof) if prof else None)
    complete, missing = answers_are_complete(data)
    return jsonify({"answers": data, "complete": complete, "missing": missing,
                    "updated_at": (row["updated_at"] if row else "") or ""})


@app.route('/api/application-answers', methods=['POST'])
def save_application_answers():
    """Save one or more sections. Sections absent from the body are left untouched."""
    data = request.get_json() or {}
    conn = get_db()
    try:
        cur = conn.cursor()
        row = cur.execute("SELECT * FROM application_answers WHERE id = 1").fetchone()
        current = _answers_row_to_dict(row)
        sets, vals = [], []
        for sec in ANSWER_SECTIONS:
            if sec in data and isinstance(data[sec], dict):
                merged = dict(current[sec]); merged.update(data[sec])
                sets.append(f"{sec}_json = ?"); vals.append(json.dumps(merged))
        if not sets:
            return jsonify({"error": "No recognised sections provided"}), 400
        sets.append("updated_at = ?")
        vals.append(datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p'))
        cur.execute(f"UPDATE application_answers SET {', '.join(sets)} WHERE id = 1", vals)
        conn.commit()
        # Completeness must be judged against the same profile-merged view the GET (and so
        # the agent) sees, otherwise saving one section reports contact fields as missing
        # purely because they were profile-seeded rather than explicitly stored.
        prof = cur.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        fresh = _answers_row_to_dict(
            cur.execute("SELECT * FROM application_answers WHERE id = 1").fetchone(),
            dict(prof) if prof else None)
        complete, missing = answers_are_complete(fresh)
        return jsonify({"success": True, "complete": complete, "missing": missing})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


# --- AGENTIC APPLY QUEUE ("Under Consideration") ---------------------------------
# ATS families the agent can drive end-to-end (no account required) vs. those that need
# a per-employer login we cannot create, which are prepared but never submitted.
ATS_AUTO = {
    "greenhouse": ["greenhouse.io", "job-boards.greenhouse.io", "boards.greenhouse.io"],
    "lever": ["lever.co"],
    "ashby": ["ashbyhq.com"],
    "smartrecruiters": ["smartrecruiters.com"],
}
ATS_MANUAL = {
    "workday": ["myworkdayjobs.com", "wd1.", "wd3.", "wd5."],
    "google": ["google.com/about/careers"],
    "amazon": ["amazon.jobs"],
    "meta": ["metacareers.com"],
    "microsoft": ["careers.microsoft.com", "jobs.careers.microsoft.com"],
    "apple": ["jobs.apple.com"],
    "netflix": ["explore.jobs.netflix.net", "jobs.netflix.com"],
    "nvidia": ["nvidia.wd5", "nvidia.com/en-us/about-nvidia/careers"],
}

APPLY_STATUSES = ("Queued", "ResumeBuilding", "ResumeVerified", "Filling",
                  "ReadyForReview", "Submitted", "NeedsAttention", "Failed")


def detect_ats(url):
    """Return (ats_name, mode). mode is 'auto' when the agent can complete the form."""
    u = (url or "").lower()
    for name, marks in ATS_AUTO.items():
        if any(mk in u for mk in marks):
            return name, "auto"
    for name, marks in ATS_MANUAL.items():
        if any(mk in u for mk in marks):
            return name, "manual"
    # Unknown ATS: assume manual. Better to under-promise than to have the agent
    # blunder through an unfamiliar form.
    return "other", "manual"


APPLY_UPDATABLE = ("status", "ats", "ats_mode", "resume_doc_url", "resume_verdict",
                   "resume_findings", "form_url", "qa_verdict", "qa_report",
                   "screenshot_path", "unanswered_fields", "staged_answers",
                   "log_path", "brief_doc_url", "application_id", "attempts", "error")

APPLY_ARTIFACT_DIR = os.path.join(PROJECT_ROOT, "board", "artifacts", "apply")


@app.route('/api/apply-requests/<string:req_id>/log', methods=['GET'])
def get_apply_log(req_id):
    """Return the application log for a queued role.

    The log is the audit trail behind a prepared application: how the resume was tailored
    (which themes were emphasised, which bullets were chosen and why) and every value put
    into the form, including the per-role "why this company" paragraph. It exists so the
    review step is substantive rather than a glance at a screenshot.
    """
    conn = get_db()
    cur = conn.cursor()
    row = cur.execute("SELECT log_path FROM apply_requests WHERE id = ?", (req_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Request not found"}), 404
    path = (row["log_path"] or "").strip()
    if not path:
        return jsonify({"exists": False, "content": ""})
    # Confine reads to the artifact directory - the path column must never be able to
    # serve an arbitrary file off disk.
    full = os.path.abspath(path if os.path.isabs(path) else os.path.join(APPLY_ARTIFACT_DIR, path))
    if not full.startswith(os.path.abspath(APPLY_ARTIFACT_DIR)):
        return jsonify({"error": "Invalid log path"}), 400
    if not os.path.exists(full):
        return jsonify({"exists": False, "content": ""})
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            return jsonify({"exists": True, "content": f.read(), "path": full})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/apply-requests/<string:req_id>/log', methods=['POST'])
def write_apply_log(req_id):
    """Agent writes the application log here. Body: {"content": "<markdown>"}."""
    data = request.get_json() or {}
    content = data.get("content")
    if content is None:
        return jsonify({"error": "content is required"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        if not cur.execute("SELECT id FROM apply_requests WHERE id = ?", (req_id,)).fetchone():
            return jsonify({"error": "Request not found"}), 404
        folder = os.path.join(APPLY_ARTIFACT_DIR, req_id)
        os.makedirs(folder, exist_ok=True)
        full = os.path.join(folder, "application-log.md")
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
        cur.execute("UPDATE apply_requests SET log_path = ?, updated_at = ? WHERE id = ?",
                    (full, datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p'), req_id))
        conn.commit()
        return jsonify({"success": True, "path": full})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/apply-requests', methods=['GET'])
def list_apply_requests():
    """Under Consideration rows, joined to their job so the tab can render in one call."""
    status = request.args.get("status", "").strip()
    conn = get_db()
    cur = conn.cursor()
    sql = """
        SELECT ar.*, j.title, j.company_name, j.location, j.url AS job_url,
               j.experience_fit, j.criteria_fit, j.fit_recommendation, j.salary,
               j.first_seen_at, j.claude_rescore_status,
               -- fit_model drives the "already scored with 120B" check that hides the
               -- re-score button; the notes/flag feed the hover tooltip.
               j.fit_model, j.fit_flag, j.fit_experience_note, j.fit_criteria_note, j.fit_framing
          FROM apply_requests ar
          JOIN jobs j ON j.id = ar.job_id
    """
    params, where = (), []
    if status:
        where.append("ar.status = ?")
        params = (status,)
    else:
        # Once a role is submitted it becomes an Application and leaves Under Consideration -
        # the tab is a work queue for things still to prepare/apply, not a history. The
        # application row (created by mark_apply_request_submitted) is where it lives now.
        # An explicit ?status=Submitted still returns them for any caller that wants them.
        where.append("ar.status != 'Submitted'")
    # ?requested=1 -> only roles the user requested by name (the per-row Prepare button).
    if request.args.get("requested", "").strip() in ("1", "true", "yes"):
        where.append("IFNULL(ar.prep_requested_at, '') != ''")
    if where:
        sql += " WHERE " + " AND ".join(where)
    # Roles you explicitly asked to prepare come first; then newest posting, because a role
    # that went up yesterday is worth more attention than one that has been open a month
    # and already collected a pile of applicants.
    sql += (" ORDER BY CASE WHEN IFNULL(ar.prep_requested_at, '') != '' THEN 0 ELSE 1 END,"
            " ar.prep_requested_at DESC, j.first_seen_at DESC, ar.created_at DESC")
    rows = cur.execute(sql, params).fetchall()
    conn.close()
    return jsonify(rows)


# Minimum fit for a role the SYSTEM picks. Preparing a tailored résumé and brief is ~10
# minutes of review each, so the bar is "worth your afternoon", not "plausible". Roles you
# star yourself bypass this entirely - your judgement overrides the model's.
MIN_AUTO_EXPERIENCE_FIT = 8
MIN_AUTO_CRITERIA_FIT = 7


def meets_auto_threshold(experience_fit, criteria_fit):
    return ((experience_fit or 0) >= MIN_AUTO_EXPERIENCE_FIT
            and (criteria_fit or 0) >= MIN_AUTO_CRITERIA_FIT)


def _norm_key(s):
    """Lowercase alphanumerics only - so 'Sr. Product Manager, AI' == 'Sr Product Manager AI'."""
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


_CO_SUFFIX_RE = re.compile(r'\b(inc|incorporated|llc|ltd|corp|corporation|plc|gmbh)\b\.?', re.I)


def _company_key(name):
    """Company name for matching: legal suffixes dropped, so 'Hightouch Inc' == 'Hightouch'."""
    return _norm_key(_CO_SUFFIX_RE.sub(' ', name or ''))


def build_applied_index(cur):
    """Lookup tables for 'have I already applied to this posting?', built once per jobs fetch.

    Returns (by_url, by_title): posting URL -> application id, and
    (company key, title key) -> application id. Keys are punctuation- and case-insensitive
    so a repost that differs only by a dash, a comma or 'Inc' still matches.
    """
    by_url, by_title = {}, {}
    for a in cur.execute("SELECT id, company, role, notes FROM applications").fetchall():
        found = re.search(r'https?://\S+', (a["notes"] or "") + " " + (a["role"] or ""))
        if found:
            by_url[found.group(0).rstrip('.,);')] = a["id"]
        by_title[(_company_key(a["company"]), _norm_key(a["role"]))] = a["id"]
    return by_url, by_title


def applied_application_id(job, index):
    """Application id this board job corresponds to, or None. `job` is a dict."""
    by_url, by_title = index
    url = (job.get("url") or "").strip()
    if url and url in by_url:
        return by_url[url]
    return by_title.get((_company_key(job.get("company_name")), _norm_key(job.get("title"))))


def find_prior_application(cur, job):
    """Return the application row for a job you already applied to, else None.

    Two roles at one company can share a title - Adobe has several distinct 'Principal
    Product Manager' reqs - so the posting URL is authoritative: it carries the req number.

    The title fallback exists only for applications logged before URLs were captured, and
    it must NOT apply to an application that does have a URL. Otherwise applying to Adobe
    R167716 would block every future Adobe 'Principal Product Manager' req, which is a
    silent false positive: a real role you would never see again.
    """
    url = (job["url"] if "url" in job.keys() else "") or ""
    apps = cur.execute("SELECT id, company, role, outcome, progress, applied_date, notes "
                       "FROM applications").fetchall()

    def recorded_url(a):
        found = re.search(r'https?://\S+', (a["notes"] or "") + " " + (a["role"] or ""))
        return found.group(0).rstrip('.,);') if found else ""

    if url:
        for a in apps:
            known = recorded_url(a)
            if known and (known == url or known in url or url in known):
                return a

    co, title = _norm_key(job["company_name"]), _norm_key(job["title"])
    for a in apps:
        if recorded_url(a):
            continue          # already had its say on the URL pass
        if _norm_key(a["company"]) == co and _norm_key(a["role"]) == title:
            return a
    return None


@app.route('/api/apply-requests/<string:req_id>/prepare', methods=['POST'])
def request_preparation(req_id):
    """Ask for ONE role's résumé + brief to be built next.

    Distinct from the bulk 'prepare all waiting' action: this stamps prep_requested_at so
    the agent draining the queue can do exactly what you asked for first, and so the row
    can show that you asked rather than silently looking like every other queued row.
    """
    conn = get_db()
    try:
        cur = conn.cursor()
        row = cur.execute("""SELECT ar.id, ar.status, ar.resume_doc_url, ar.brief_doc_url,
                                    j.title, j.company_name
                               FROM apply_requests ar JOIN jobs j ON j.id = ar.job_id
                              WHERE ar.id = ?""", (req_id,)).fetchone()
        if not row:
            return jsonify({"error": "Request not found"}), 404
        if row["status"] == "Submitted":
            return jsonify({"error": "Already submitted"}), 409

        wants = []
        if not (row["resume_doc_url"] or "").strip():
            wants.append("résumé")
        if not (row["brief_doc_url"] or "").strip():
            wants.append("brief")
        if not wants:
            return jsonify({"error": "Résumé and brief are already built"}), 409

        now = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
        cur.execute("""UPDATE apply_requests
                          SET prep_requested_at = ?, status = 'Queued', error = '', updated_at = ?
                        WHERE id = ?""", (now, now, req_id))
        conn.commit()
        return jsonify({"success": True, "requested_at": now, "wants": wants,
                        "company": row["company_name"], "title": row["title"]})
    finally:
        conn.close()


@app.route('/api/company-groups', methods=['GET'])
def get_company_groups():
    """Serve company_groups.json to the UI so the pills and the worker's scoring priority
    read from the same roster. Editing that one file changes both."""
    groups, _ = load_company_groups()
    return jsonify({k: v for k, v in groups.items() if not k.startswith("_")})


@app.route('/api/apply-requests', methods=['POST'])
def create_apply_request():
    """Queue a job for the agentic pipeline. Idempotent per job: re-queuing a job that is
    already in flight returns the existing row rather than creating a duplicate."""
    data = request.get_json() or {}
    job_id = (data.get("job_id") or "").strip()
    if not job_id:
        return jsonify({"error": "job_id is required"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        job = cur.execute("SELECT id, url, title, company_name, experience_fit, criteria_fit, "
                          "fit_model FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not job:
            return jsonify({"error": "Job not found"}), 404

        # Auto-selected roles must clear the fit bar. A role you starred yourself does not:
        # you may know something the scorer doesn't (a contact, a team, a product you want).
        source = (data.get("source") or "starred").strip()
        if source == "auto" and not meets_auto_threshold(job["experience_fit"], job["criteria_fit"]):
            conn.close()
            return jsonify({
                "error": f"Below the auto-queue bar: {job['experience_fit']}/{job['criteria_fit']} "
                         f"(needs experience >= {MIN_AUTO_EXPERIENCE_FIT} and "
                         f"criteria >= {MIN_AUTO_CRITERIA_FIT}).",
                "below_threshold": True,
            }), 422

        # Never queue something you already applied to. Preparing a résumé and brief for a
        # role that already came back a rejection is pure waste, and it crowds out a slot
        # in the daily target. Callers can force past this with {"force": true}.
        if not data.get("force"):
            prior = find_prior_application(cur, job)
            if prior:
                when = f" on {prior['applied_date']}" if prior["applied_date"] else ""
                verdict = "closed" if (prior["outcome"] or "") == "Closed" else (prior["progress"] or "in progress")
                conn.close()
                return jsonify({
                    "error": f"You already applied to this role{when} -- it's in your pipeline "
                             f"as \"{prior['role']}\" ({verdict}).",
                    "already_applied": True, "application_id": prior["id"],
                }), 409

        existing = cur.execute(
            "SELECT * FROM apply_requests WHERE job_id = ? AND status != 'Submitted'",
            (job_id,)).fetchone()
        if existing:
            conn.close()
            return jsonify({"success": True, "already_queued": True, "request": existing})

        ats, mode = detect_ats(job["url"])
        now = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
        rid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO apply_requests (id, job_id, source, status, ats, ats_mode,
                                        created_at, updated_at)
            VALUES (?, ?, ?, 'Queued', ?, ?, ?, ?)
        """, (rid, job_id, (data.get("source") or "starred"), ats, mode, now, now))

        # Keep the star in sync no matter how the row got queued. Queuing through the API
        # (scheduled top-up, or an agent) previously left the job unstarred on the Sourcing
        # Board, so a role could sit in Under Consideration while still looking untouched.
        cur.execute("""UPDATE jobs SET status = 'Consideration', pipeline_status = 'Consideration'
                        WHERE id = ? AND status != 'Archived'""", (job_id,))
        conn.commit()
        row = cur.execute("SELECT * FROM apply_requests WHERE id = ?", (rid,)).fetchone()
        return jsonify({"success": True, "already_queued": False, "request": row})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        try: conn.close()
        except Exception: pass


@app.route('/api/apply-requests/<string:req_id>', methods=['POST'])
def update_apply_request(req_id):
    """Partial update - only fields present in the body change."""
    data = request.get_json() or {}
    updates = {k: data[k] for k in APPLY_UPDATABLE if k in data}
    if not updates:
        return jsonify({"error": "No updatable fields provided"}), 400
    if "status" in updates and updates["status"] not in APPLY_STATUSES:
        return jsonify({"error": f"Invalid status. Expected one of {APPLY_STATUSES}"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        if not cur.execute("SELECT id FROM apply_requests WHERE id = ?", (req_id,)).fetchone():
            return jsonify({"error": "Request not found"}), 404
        updates["updated_at"] = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
        sets = ", ".join(f"{k} = ?" for k in updates)
        cur.execute(f"UPDATE apply_requests SET {sets} WHERE id = ?",
                    (*updates.values(), req_id))
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/apply-requests/<string:req_id>', methods=['DELETE'])
def delete_apply_request(req_id):
    conn = get_db()
    try:
        cur = conn.cursor()
        row = cur.execute("SELECT job_id, application_id FROM apply_requests WHERE id = ?",
                          (req_id,)).fetchone()
        cur.execute("DELETE FROM apply_requests WHERE id = ?", (req_id,))
        # Removing from Under Consideration has to release the star too. Deleting only the
        # queue row left the job at status 'Consideration' on the Sourcing Board - starred
        # and counted as actioned, with nothing behind it. Jobs already written through to
        # the pipeline keep their star: those really were actioned.
        if row and row["job_id"] and not row["application_id"]:
            cur.execute("""UPDATE jobs SET status = 'Lead', pipeline_status = ''
                            WHERE id = ? AND status = 'Consideration'""", (row["job_id"],))
        conn.commit()
        return jsonify({"success": True, "deleted": cur.rowcount})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/apply-requests/<string:req_id>/submitted', methods=['POST'])
def mark_apply_request_submitted(req_id):
    """You submitted the application yourself -> write it through to the Application &
    Interview Pipeline. Agent-prepared applications carry no referral by definition."""
    conn = get_db()
    try:
        cur = conn.cursor()
        row = cur.execute("""
            SELECT ar.*, j.title, j.company_name, j.url AS job_url
              FROM apply_requests ar JOIN jobs j ON j.id = ar.job_id
             WHERE ar.id = ?""", (req_id,)).fetchone()
        if not row:
            return jsonify({"error": "Request not found"}), 404
        if row["application_id"]:
            return jsonify({"success": True, "already": True,
                            "application_id": row["application_id"]})

        now = datetime.datetime.now()
        today = now.strftime('%Y-%m-%d')
        note = f"Agent-prepared application. Job: {row['job_url'] or ''}".strip()
        cur.execute("""
            INSERT INTO applications
              (company, role, submission_method, referral, progress, outcome,
               feedback, resume_link, notes, created_at, applied_date, outcome_date)
            VALUES (?, ?, 'Job Portal', 'No', 'Submitted', 'In Progress',
                    '', ?, ?, ?, ?, '')
        """, (row["company_name"], row["title"], row["resume_doc_url"] or "",
              note, now.strftime('%Y-%m-%d %I:%M %p'), today))
        app_id = cur.lastrowid
        cur.execute("""UPDATE apply_requests
                          SET status='Submitted', application_id=?, updated_at=?
                        WHERE id=?""",
                    (app_id, now.strftime('%Y-%m-%d %I:%M %p'), req_id))
        conn.commit()
        invalidate_jobs_cache()   # the board's already-applied flags are now out of date
        return jsonify({"success": True, "application_id": app_id})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


APPLICATION_FIELDS = ("company", "role", "submission_method", "referral",
                      "progress", "outcome", "feedback", "resume_link", "notes",
                      "applied_date", "outcome_date", "listed_comp", "recruiter_comp", "comp_notes")

# An application still sitting at "Submitted" this many days after it was sent is treated
# as a silent rejection and closed automatically.
AUTO_CLOSE_DAYS = 14


def auto_close_stale_applications(cur):
    """Close applications that never moved past 'Submitted' within AUTO_CLOSE_DAYS.

    Only rows that are still In Progress, still at the *original* 'Submitted' stage, have a
    usable applied_date, and have never been reopened by the user (auto_close_state = 0) are
    touched. Any reply from a recruiter moves `progress` off 'Submitted', which exempts the
    row - so this only ever catches genuine silence.

    Returns the number of rows closed. Idempotent: closed rows no longer match the filter.
    """
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=AUTO_CLOSE_DAYS)).strftime('%Y-%m-%d')
    today = datetime.datetime.now().strftime('%Y-%m-%d')
    note = f"Auto-closed: no response {AUTO_CLOSE_DAYS} days after applying."

    cur.execute("""
        UPDATE applications
           SET outcome = 'Closed',
               outcome_date = ?,
               auto_close_state = 1,
               feedback = CASE
                   WHEN TRIM(COALESCE(feedback, '')) = '' THEN ?
                   ELSE feedback || '  |  ' || ?
               END
         WHERE outcome != 'Closed'
           AND progress = 'Submitted'
           AND auto_close_state = 0
           AND applied_date IS NOT NULL
           AND applied_date != ''
           AND applied_date <= ?
    """, (today, note, note, cutoff))
    return cur.rowcount


@app.route('/api/applications', methods=['GET'])
def get_applications():
    try:
        conn = get_db()
        cur = conn.cursor()
        # Apply the stale-application rule before returning, so the list is always current
        # without needing a separate scheduled job.
        try:
            closed = auto_close_stale_applications(cur)
            if closed:
                conn.commit()
                print(f"Auto-closed {closed} stale application(s) with no progress in {AUTO_CLOSE_DAYS} days.")
        except Exception as e:
            print("Auto-close check failed (non-fatal):", e)
        cur.execute("SELECT * FROM applications ORDER BY id DESC")
        rows = cur.fetchall()
        conn.close()
        return jsonify(rows)
    except Exception as e:
        print("get_applications error:", e)
        return jsonify([])


@app.route('/api/applications', methods=['POST'])
def add_application():
    data = request.get_json() or {}
    company = (data.get("company") or "").strip()
    role = (data.get("role") or "").strip()
    if not company or not role:
        return jsonify({"error": "Company and Role are required"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        now = datetime.datetime.now()
        outcome = data.get("outcome") or "In Progress"
        cur.execute("""INSERT INTO applications
            (company, role, submission_method, referral, progress, outcome, feedback, resume_link, notes, created_at,
             applied_date, outcome_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
            company, role,
            data.get("submission_method") or "Job Portal",
            data.get("referral") or "No",
            data.get("progress") or "Submitted",
            outcome,
            data.get("feedback") or "",
            data.get("resume_link") or "",
            data.get("notes") or "",
            now.strftime('%Y-%m-%d %I:%M %p'),
            # Applied today unless the caller supplies a back-dated value.
            (data.get("applied_date") or now.strftime('%Y-%m-%d')),
            (data.get("outcome_date") or (now.strftime('%Y-%m-%d') if outcome == "Closed" else "")),
        ))
        new_id = cur.lastrowid
        refresh_prep_queues(cur)   # an application logged straight at a recruiter/HM stage needs its dossier
        conn.commit()
        invalidate_jobs_cache()   # the board's already-applied flags are now out of date
        cur.execute("SELECT * FROM applications WHERE id = ?", (new_id,))
        row = cur.fetchone()
        return jsonify({"success": True, "application": row})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/applications/<int:app_id>', methods=['POST'])
def update_application(app_id):
    """Partial update - only the fields present in the body are changed."""
    data = request.get_json() or {}
    updates = {k: data[k] for k in APPLICATION_FIELDS if k in data}
    if not updates:
        return jsonify({"error": "No updatable fields provided"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM applications WHERE id = ?", (app_id,))
        existing = cur.fetchone()
        if not existing:
            return jsonify({"error": "Application not found"}), 404

        # Outcome drives outcome_date, unless the caller set the date explicitly.
        if "outcome" in updates and "outcome_date" not in updates:
            today = datetime.datetime.now().strftime('%Y-%m-%d')
            if updates["outcome"] == "Closed":
                if not (existing["outcome_date"] or "").strip():
                    updates["outcome_date"] = today
            else:
                updates["outcome_date"] = ""   # reopened -> no final outcome date

        # Reopening a row we auto-closed makes it permanently exempt, otherwise the next
        # page load would simply close it again and the user could never override us.
        if updates.get("outcome") not in (None, "Closed") and existing["auto_close_state"] == 1:
            updates["auto_close_state"] = 2
        sets = ", ".join(f"{k} = ?" for k in updates)
        cur.execute(f"UPDATE applications SET {sets} WHERE id = ?", (*updates.values(), app_id))
        # Moving past 'Submitted' (recruiter or hiring-manager conversation) queues the
        # discussion dossier for that stage; a later stage change queues a rewrite.
        if "progress" in updates or "outcome" in updates:
            refresh_prep_queues(cur)
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/applications/<int:app_id>', methods=['DELETE'])
def delete_application(app_id):
    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM applications WHERE id = ?", (app_id,))
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route('/api/connections', methods=['GET'])
def get_connections():
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM connections ORDER BY last_name ASC, first_name ASC")
        rows = cursor.fetchall()
        conn.close()
        return jsonify(rows)
    except Exception as e:
        print("get_connections error:", e)
        return jsonify([])

@app.route('/api/connections/clear', methods=['POST'])
def clear_connections():
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM connections")
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Connections database successfully cleared."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/connections/upload', methods=['POST'])
def upload_connections():
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
            
        file = request.files['file']
        if file.filename == '':
            return jsonify({"error": "No selected file"}), 400
            
        content = file.stream.read().decode("utf-8")
        lines = content.splitlines()
        
        # Skip headers preamble if present
        header_idx = -1
        for idx, line in enumerate(lines[:10]):
            if "First Name" in line or "FirstName" in line or "first_name" in line:
                header_idx = idx
                break
                
        if header_idx == -1:
            return jsonify({"error": "Could not identify header row in CSV."}), 400
            
        headers = [h.strip().replace('"', '') for h in lines[header_idx].split(',')]
        
        def parse_csv_line(line):
            import csv
            reader = csv.reader([line])
            return next(reader)
            
        parsed_connections = []
        for line in lines[header_idx + 1:]:
            if not line.strip():
                continue
            try:
                row = parse_csv_line(line)
                if len(row) < 3:
                    continue
                # Map headers
                first_name = row[headers.index("First Name")] if "First Name" in headers else row[0]
                last_name = row[headers.index("Last Name")] if "Last Name" in headers else row[1]
                company = row[headers.index("Company")] if "Company" in headers else row[2]
                position = row[headers.index("Position")] if "Position" in headers else row[3]
                url = ""
                if "URL" in headers:
                    url = row[headers.index("URL")]
                elif "Profile URL" in headers:
                    url = row[headers.index("Profile URL")]
                    
                first_name = first_name.strip().replace('"', '')
                last_name = last_name.strip().replace('"', '')
                company = company.strip().replace('"', '')
                position = position.strip().replace('"', '')
                url = url.strip().replace('"', '')
                
                if not first_name or not company:
                    continue
                    
                if not url:
                    # Fallback LinkedIn search query URL
                    q = f"{first_name} {last_name} {company}"
                    url = f"https://www.linkedin.com/search/results/people/?keywords={requests.utils.quote(q)}"
                    
                parsed_connections.append({
                    "first_name": first_name,
                    "last_name": last_name,
                    "company": company,
                    "position": position,
                    "url": url
                })
            except Exception as csv_err:
                # Skip invalid lines
                continue
                
        mode = request.form.get('mode', 'replace')
        conn = get_db()
        cursor = conn.cursor()
        
        if mode == 'replace':
            cursor.execute("DELETE FROM connections")
            
        added_count = 0
        for c in parsed_connections:
            # Check for duplicate if in append mode
            if mode == 'append':
                cursor.execute("""
                SELECT COUNT(*) FROM connections 
                WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND LOWER(company) = LOWER(?)
                """, (c["first_name"], c["last_name"], c["company"]))
                if cursor.fetchone()["COUNT(*)"] > 0:
                    continue
                    
            cursor.execute("""
            INSERT INTO connections (first_name, last_name, company, position, url)
            VALUES (?, ?, ?, ?, ?)
            """, (c["first_name"], c["last_name"], c["company"], c["position"], c["url"]))
            added_count += 1
            
        conn.commit()
        conn.close()
        
        return jsonify({
            "success": True,
            "message": f"Successfully loaded {added_count} connections."
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- AUTO-THROTTLE FIT-SCORING WORKER ---
# Scores unscored active jobs one at a time in the background, respecting the provider's
# rate limit and a daily token budget. This single loop handles BOTH the one-time backfill
# of existing jobs AND ongoing auto-scoring of newly crawled jobs (they appear as
# experience_fit = -1 and get picked up on the next pass).
fit_worker_state = {"status": "starting", "last_error": "", "last_scored_at": ""}

# Kept deliberately in lockstep with JOB_LEVEL_PATTERNS / classifyJobLevel() in app.js.
# If the two drift, the backlog re-scorer stops matching the Principal / Dir+ buckets the
# UI shows, and you get a queue that disagrees with its own filter.
_LEVEL_DIR = [r'\bchief\b', r'\bcpo\b', r'\b(svp|evp|avp)\b', r'\bvp\b', r'\bvice\s+president\b',
              r'\bdirector\b', r'\bhead\s+of\b', r'\bhead\s*,', r'\bproduct\s+head\b',
              r'\bgeneral\s+manager\b']
_LEVEL_SENIOR_IC = [r'\bprincipal\b', r'\bdistinguished\b', r'\bfellow\b', r'\bstaff\b',
                    r'^\s*group\b', r'\bgroup\s+product\b', r'\bgpm\b', r'\blead\s+product\b',
                    r'\bproduct\s+lead\b', r'\blead\s+pm\b', r'^\s*lead\b', r'\bmanager\s+lead\b',
                    r'\bproduct\s+(management\s+)?leader\b']
_LEVEL_MID = [r'\bsenior\b', r'\bsnr\b', r'\bsr\b']


def classify_job_level(title):
    """-> 'dir' | 'seniorIC' | 'mid' | 'early'. Precedence: dir > seniorIC > mid > early."""
    t = (title or "").lower()
    for group, name in ((_LEVEL_DIR, "dir"), (_LEVEL_SENIOR_IC, "seniorIC"), (_LEVEL_MID, "mid")):
        if any(re.search(p, t) for p in group):
            return name
    return "early"


# Scoring models. 120B leads because it actually reads the JD; gpt-oss-20b exists only as the
# overflow valve for days when 120B's 200K token budget runs out mid-crawl.
PRIMARY_MODEL = "openai/gpt-oss-120b"
# Groq deprecated llama-3.1-8b-instant and llama-3.3-70b-versatile (Aug 2026). gpt-oss-20b
# is the current small/fast model and the fallback when 120B's daily budget is spent.
FALLBACK_MODEL = "openai/gpt-oss-20b"

# Who owns unattended lead scoring.
#   "claude" (default) - the Claude scheduled tasks (scripts/claude_rescore.py enqueue/dump/
#                        apply) score every lead; the Groq worker below stays idle.
#   "groq"             - the legacy 120B/20B background worker scores, as before.
# The small Groq model over-scored ordinary roles (10/10 on mid-level postings) and those
# scores were never upgraded, so the shortlist could not be trusted. Set the environment
# variable BOARD_SCORING_ENGINE=groq to fall back without a code change.
SCORING_ENGINE = (os.environ.get("BOARD_SCORING_ENGINE") or "claude").strip().lower()

# The 120B backlog re-scorer only upgrades priority roles first seen within this many days.
# Older postings are less likely to be applied to, so spending scarce 120B budget on them
# is waste; capping the age focuses the budget on recent, actionable roles. New jobs are
# always scored regardless of this (they arrive unscored and get 120B on the primary pass).
BACKLOG_MAX_AGE_DAYS = 21

COMPANY_GROUPS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "company_groups.json")
_company_groups_cache = {"mtime": 0, "data": {}, "alias_index": {}}


def load_company_groups():
    """Read company_groups.json, re-reading only when the file changes on disk.

    Returns (groups, alias_index) where alias_index maps a normalised company name to
    the set of group keys it belongs to - so matching is one dict lookup, not a scan of
    every alias list on every job.
    """
    try:
        mtime = os.path.getmtime(COMPANY_GROUPS_PATH)
    except OSError:
        return _company_groups_cache["data"], _company_groups_cache["alias_index"]

    if mtime != _company_groups_cache["mtime"]:
        with open(COMPANY_GROUPS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        index = {}
        for key, group in data.items():
            if key.startswith("_") or not isinstance(group, dict):
                continue
            for aliases in (group.get("members") or {}).values():
                for alias in aliases:
                    index.setdefault(alias, set()).add(key)
        _company_groups_cache.update({"mtime": mtime, "data": data, "alias_index": index})
    return _company_groups_cache["data"], _company_groups_cache["alias_index"]


def normalize_company(name):
    return re.sub(r'[^a-z0-9]', '', (name or "").lower())


def company_groups_for(name):
    """-> set of group keys ('mag7', 'ai_labs', 'high_growth') this company belongs to."""
    _, index = load_company_groups()
    return index.get(normalize_company(name), set())


def is_priority_job(title, company_name):
    """Roles that earn the scarce 120B budget.

    Targets senior/staff/principal PM roles across high-growth and tier-1 tech companies
    most wants an accurate read. Everything else is scored on 20B (gpt-oss-20b), whose budget is
    the low-priority overflow and keeps 120B for the band where 8B was wrong.
    """
    if classify_job_level(title) in ("dir", "seniorIC"):
        return True
    return bool(company_groups_for(company_name))


# "Precise" == a score the backlog re-scorer must treat as FINAL and never overwrite: the
# accurate large Groq model (120B), OR a Gemini score produced out-of-band (e.g. an Antigravity
# run). Must NOT match gpt-oss-20b (the small fallback) or the re-scorer would treat 20B scores
# as final and never upgrade them. Gemini is included so that once a job is scored by Gemini,
# the Groq worker leaves it alone instead of re-scoring and overwriting it with 120B.
PRECISE_MODEL_RE = re.compile(r'120b|70b|gemini|opus|claude|sonnet', re.I)


def is_precise_score(fit_model):
    return bool(PRECISE_MODEL_RE.search(fit_model or ""))
_fit_worker_started = False

# Unique id for THIS worker process. Used for the singleton lease below.
WORKER_ID = str(uuid.uuid4())
LEASE_TTL = 90  # seconds; a lease older than this is considered abandoned


def _acquire_scoring_lease(cur):
    """Return True if this process may score (holds or successfully claims the lease).

    Antigravity (and stray restarts) can leave MORE THAN ONE server process running, each
    with its own scoring thread. Two workers scoring at once double-spend tokens AND blow
    past Groq's per-minute token limit (each paces safely for ONE worker), which 429s both
    and stalls scoring. This lease guarantees exactly one active scorer; the others idle.

    A SEPARATE heartbeat thread (see _lease_heartbeat_thread) keeps this process's lease
    fresh every 30s so it does NOT expire while the worker is asleep in a long rate-limit
    backoff - which is the bug that previously let a second worker steal the lease.
    """
    now = time.time()
    try:
        row = cur.execute("SELECT holder, heartbeat FROM worker_lease WHERE id=1").fetchone()
        holder = (row["holder"] if isinstance(row, dict) else row[0]) if row else None
        heartbeat = (row["heartbeat"] if isinstance(row, dict) else row[1]) if row else None
        if holder is None or holder == WORKER_ID or (heartbeat is None) or (now - heartbeat > LEASE_TTL):
            cur.execute("""INSERT INTO worker_lease (id, holder, heartbeat) VALUES (1, ?, ?)
                           ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, heartbeat=excluded.heartbeat""",
                        (WORKER_ID, now))
            return True
    except Exception:
        pass
    return False


def _lease_heartbeat_thread():
    """Renew our lease every 30s, but ONLY if we already hold it. This keeps the lease
    alive across long rate-limit backoffs (the worker can sleep up to 300s per retry, far
    longer than LEASE_TTL) without letting a standby process claim a lease it doesn't own."""
    while True:
        try:
            conn = get_db(); cur = conn.cursor()
            # Update the heartbeat ONLY if this process is the current holder.
            cur.execute("UPDATE worker_lease SET heartbeat=? WHERE id=1 AND holder=?",
                        (time.time(), WORKER_ID))
            conn.commit(); conn.close()
        except Exception:
            pass
        time.sleep(30)


def fit_scoring_worker():
    # Groq free tier (Aug 2026): the old llama-3.1-8b / llama-3.3-70b were deprecated.
    # Both models now used are gpt-oss and share an 8,000 tokens/MINUTE ceiling:
    #   - PRIMARY  openai/gpt-oss-120b: 8K TPM, ~200K tokens/DAY (the binding cap; ~60 jobs).
    #   - FALLBACK openai/gpt-oss-20b : 8K TPM, used when 120B's daily budget is spent.
    # At the measured ~4K tokens/job, staying under 8K TPM needs >= 30s/call
    # (4000 / 30 * 60 = 8,000). RATE_SLEEP=45 is a safe margin for the fallback; the
    # primary runs a little hotter at PRECISE_RATE_SLEEP=35 (4000/35*60 = 6,857 TPM).
    RATE_SLEEP = 45.0        # fallback (20B) cadence: comfortably under the 8K TPM ceiling
    PRECISE_RATE_SLEEP = 35.0  # primary (120B) cadence: ~6.9K TPM, under 8K
    # How long to stand down after a 120B daily-cap 429 before re-probing. Short enough to
    # follow the rolling window as it frees, long enough not to spin on 429s.
    PRECISE_RETRY_WAIT = 1800  # 30 min
    IDLE_SLEEP = 300   # nothing to do -> re-check in 5 min (catches newly crawled jobs)
    BUDGET_SLEEP = 600 # daily cap hit -> re-check in 10 min (resumes at day rollover)
    # Allow server to complete boot and serve initial requests before starting background worker
    time.sleep(15)
    while True:
        conn = None
        try:
            if SCORING_ENGINE != "groq":
                fit_worker_state["status"] = "idle (Claude scheduled tasks own lead scoring)"
                time.sleep(IDLE_SLEEP)
                continue

            conn = get_db()
            cur = conn.cursor()

            if not _acquire_scoring_lease(cur):
                conn.commit()
                fit_worker_state["status"] = "standby (another worker is active)"
                conn.close()
                time.sleep(45)
                continue
            conn.commit()

            prof = cur.execute("SELECT * FROM profile WHERE id = 1").fetchone()
            prof = dict(prof) if prof else {}
            key = (prof.get("llm_api_key") or "").strip()
            if not key:
                fit_worker_state["status"] = "waiting for API key"
                conn.close()
                time.sleep(60)
                continue

            budget = int(prof.get("llm_daily_token_budget") or 0)
            if budget and get_today_tokens(cur) >= budget:
                fit_worker_state["status"] = f"manual daily cap ({budget:,} tokens) reached -- resumes tomorrow"
                conn.close()
                time.sleep(BUDGET_SLEEP)
                continue

            # 120B is the primary scorer: it reads the JD properly and applies the rubric's
            # people-management cap, which the small model routinely misses on senior roles. But its
            # daily budget is 200K tokens, so on a heavy crawl day it runs
            # dry. When that happens we drop to 20B rather than stalling - a rough score
            # today beats no score, and fit_model records which model produced it so the
            # backlog pass can come back and upgrade it.
            # Groq's TPD is a ROLLING 24h window, not a calendar-day bucket: capacity frees
            # continuously as older usage ages out. So a daily 429 means "wait a while",
            # never "stop until midnight" - blocking for the rest of the day strands hours
            # of usable budget (measured: 7h idle on 2026-08-10 with 120B fully available).
            precise_ok = time.time() >= fit_worker_state.get("precise_retry_at", 0)

            # Work order, and which model pays for it:
            #   1. new PRIORITY roles (Principal+/Dir+, Mag 7, high-growth)  -> 120B
            #   2. new everything-else                                      -> 20B
            #   3. PRIORITY backlog still carrying a 20B score              -> 120B
            # Ordinary roles never compete for the 120B budget: the small model absorbs the
            # and idle, so spending it on them costs nothing and keeps 120B for the band
            # where the small model is actually wrong.
            unscored = cur.execute(
                "SELECT id, title, company_name FROM jobs "
                "WHERE (experience_fit IS NULL OR experience_fit = -1) AND status != 'Archived' "
                "ORDER BY relevancy_score DESC, first_seen_at DESC"
            ).fetchall()

            row, backlog, model = None, False, FALLBACK_MODEL
            if precise_ok:
                row = next((j for j in unscored if is_priority_job(j["title"], j["company_name"])), None)
                if row:
                    model = PRIMARY_MODEL

            if not row:
                row = next((j for j in unscored
                            if not (precise_ok and is_priority_job(j["title"], j["company_name"]))), None)
                model = FALLBACK_MODEL

            if not row and precise_ok:
                # Under Consideration roles the user actioned come FIRST, at any age: if he
                # starred it and it's still on a 20B score, upgrade it before the general
                # backlog. These are the roles he's actually about to apply to.
                uc = cur.execute(
                    "SELECT j.id, j.title, j.company_name, j.fit_model FROM apply_requests ar "
                    "JOIN jobs j ON j.id = ar.job_id "
                    "WHERE j.status != 'Archived' AND j.experience_fit >= 0 AND ar.status != 'Submitted'"
                ).fetchall()
                for cand in uc:
                    if not is_precise_score(cand["fit_model"]):
                        row, backlog, model = cand, True, PRIMARY_MODEL
                        break

            if not row and precise_ok:
                # Caught up on new jobs and no pending UC upgrades -> upgrade priority roles
                # still on a 20B score. Newest posting first, and ONLY within the last
                # BACKLOG_MAX_AGE_DAYS: a role posted a month ago is unlikely to
                # apply to, so spending scarce 120B budget upgrading it is waste. Focusing on
                # recent postings gets "last few weeks fully on 120B" far faster.
                cutoff = (datetime.date.today()
                          - datetime.timedelta(days=BACKLOG_MAX_AGE_DAYS)).isoformat()
                cands = cur.execute(
                    "SELECT id, title, company_name, fit_model FROM jobs WHERE status != 'Archived' "
                    "AND experience_fit >= 0 AND substr(first_seen_at,1,10) >= ? "
                    "ORDER BY first_seen_at DESC", (cutoff,)
                ).fetchall()
                for cand in cands:
                    if is_precise_score(cand["fit_model"]):
                        continue
                    if is_priority_job(cand["title"], cand["company_name"]):
                        row, backlog, model = cand, True, PRIMARY_MODEL
                        break

            if not row:
                fit_worker_state["status"] = ("up to date" if precise_ok else
                                              "up to date (120B budget spent; new jobs on 20B)")
                conn.close()
                time.sleep(IDLE_SLEEP)
                continue

            jid = row["id"] if isinstance(row, dict) else row[0]
            conn.close()
            conn = None

            # Stand down from 120B while a manual re-score holds priority, so the user's
            # request wins the scarce rolling budget. 20B (fallback) is uncontended, so it
            # keeps going.
            if model == PRIMARY_MODEL and time.time() < _manual_priority_until:
                fit_worker_state["status"] = "yielding 120B budget to a manual re-score"
                time.sleep(8)
                continue

            fit_worker_state["status"] = f"{'re-scoring backlog' if backlog else 'scoring'} ({model.split('/')[-1]})"
            try:
                _score_one_job(None, jid, prof, key, model_override=model)
            except RateLimitError as rle:
                # A daily cap on 120B is not a reason to stop for the day - it's a reason
                # to stop using 120B for the day. Re-raised errors from 20B fall through to
                # the outer handler and idle as before.
                if rle.daily and model == PRIMARY_MODEL:
                    # Re-probe after a bounded wait so we pick the budget back up as the
                    # rolling window frees it, instead of idling until the date changes.
                    wait = min(max(rle.retry_after or PRECISE_RETRY_WAIT, 300), PRECISE_RETRY_WAIT)
                    fit_worker_state["precise_retry_at"] = time.time() + wait
                    fit_worker_state["precise_retry_human"] = (
                        datetime.datetime.now() + datetime.timedelta(seconds=wait)
                    ).strftime('%Y-%m-%d %I:%M %p')
                    fit_worker_state["status"] = (
                        f"120B budget exhausted -- retrying at "
                        f"{fit_worker_state['precise_retry_human']}; new jobs on 20B meanwhile")
                    time.sleep(5)
                    continue
                raise
            fit_worker_state["last_scored_at"] = datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')
            fit_worker_state["last_error"] = ""
            time.sleep(RATE_SLEEP if model == FALLBACK_MODEL else PRECISE_RATE_SLEEP)
        except RateLimitError as e:
            if conn:
                try: conn.close()
                except Exception: pass
            if e.daily:
                # Free-tier daily token cap on the small model exhausted. Idle-poll every
                # few minutes; the rolling 24h window frees a little at a time, and fully
                # resets after ~a day. Hammering achieves nothing and just spins.
                fit_worker_state["status"] = "daily token cap reached (Groq free tier ~500K/day) -- resumes as the window frees"
                fit_worker_state["last_error"] = "TPD daily cap"
                time.sleep(min(e.retry_after or BUDGET_SLEEP, BUDGET_SLEEP))
            else:
                # Per-minute limit: clears in seconds. Short nap, then continue.
                fit_worker_state["status"] = "rate limited (per-minute) -- backing off"
                fit_worker_state["last_error"] = "429 per-minute"
                time.sleep(min(e.retry_after or 30, 90))
        except Exception as e:
            fit_worker_state["status"] = "error -- retrying"
            fit_worker_state["last_error"] = str(e)[:200]
            print("Fit scoring worker error:", e)
            if conn:
                try: conn.close()
                except Exception: pass
            time.sleep(15)


def start_fit_worker():
    global _fit_worker_started
    if _fit_worker_started:
        return
    _fit_worker_started = True
    threading.Thread(target=fit_scoring_worker, daemon=True).start()
    threading.Thread(target=_lease_heartbeat_thread, daemon=True).start()
    print("Auto-throttle fit-scoring worker started.")


_fit_status_cache = {"data": None, "ts": 0}

@app.route('/api/jobs/fit-status', methods=['GET'])
def fit_status():
    global _fit_status_cache
    now = time.time()
    if _fit_status_cache["data"] and (now - _fit_status_cache["ts"] < 15.0):
        return jsonify(_fit_status_cache["data"])

    conn = None
    try:
        conn = get_db()
        cur = conn.cursor()
        prof = cur.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        prof = dict(prof) if prof else {}

        r_counts = cur.execute("""
        SELECT 
            COUNT(*) AS total,
            SUM(CASE WHEN experience_fit >= 0 THEN 1 ELSE 0 END) AS scored,
            SUM(CASE WHEN experience_fit = -2 THEN 1 ELSE 0 END) AS na_count,
            SUM(CASE WHEN (experience_fit IS NULL OR experience_fit = -1) THEN 1 ELSE 0 END) AS truly_unscored
        FROM jobs
        WHERE status != 'Archived'
        """).fetchone() or {}
        total = r_counts.get("total") or 0
        scored = r_counts.get("scored") or 0
        na_count = r_counts.get("na_count") or 0
        truly_unscored = r_counts.get("truly_unscored") or 0
        used = get_today_tokens(cur)
        roll = get_rolling_24h_by_model(cur)

        last_scanned = (prof.get("last_scanned_at") or "").strip()
        scan_date = last_scanned[:10] if len(last_scanned) >= 10 else ""
        new_since_last_scan = 0
        if scan_date:
            r = cur.execute(
                "SELECT COUNT(*) c FROM jobs WHERE status != 'Archived' "
                "AND substr(first_seen_at, 1, 10) = ?", (scan_date,)
            ).fetchone()
            new_since_last_scan = (r["c"] if isinstance(r, dict) else r[0]) if r else 0

        senior_total = senior_precise = 0
        for j in cur.execute("SELECT title, company_name, fit_model, experience_fit FROM jobs "
                             "WHERE status != 'Archived' AND experience_fit >= 0"):
            if is_priority_job(j["title"], j["company_name"]):
                senior_total += 1
                if is_precise_score(j["fit_model"]):
                    senior_precise += 1

        res = {
            "configured": bool((prof.get("llm_api_key") or "").strip()),
            "model": PRIMARY_MODEL,
            "fallback_model": FALLBACK_MODEL,
            "senior_total": senior_total,
            "senior_precise": senior_precise,
            "senior_backlog": max(0, senior_total - senior_precise),
            "total": total,
            "scored": scored,
            "unscored": truly_unscored,
            "na": na_count,
            "tokens_today": used,
            "tokens_120b_24h": roll["p120"],
            "tokens_8b_24h": roll["p8"],
            "cap_120b": 200000,
            "cap_8b": 500000,
            "daily_budget": int(prof.get("llm_daily_token_budget") or 0),
            "last_scanned_at": last_scanned,
            "new_since_last_scan": new_since_last_scan,
            "worker": dict(fit_worker_state),
        }
        _fit_status_cache = {"data": res, "ts": now}
        return jsonify(res)
    except Exception as e:
        if _fit_status_cache["data"]:
            return jsonify(_fit_status_cache["data"])
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            try: conn.close()
            except Exception: pass


# =========================== STAR Behavioral Prep endpoints ===========================
_STORY_JSON_COLS = ["framing_json", "situation_json", "action_json", "tension_json",
                    "result_json", "depth_json", "mapping_json", "self_drafts_json"]


def _story_to_dict(row):
    """DB row -> API shape: parse the JSON-blob columns back into nested objects."""
    d = dict(row)
    for col in _STORY_JSON_COLS:
        try:
            d[col.replace("_json", "")] = json.loads(d.pop(col) or "{}")
        except Exception:
            d[col.replace("_json", "")] = {}
    try:
        d["generated"] = json.loads(d.pop("generated_json") or "null")
    except Exception:
        d["generated"] = None
    return d


def _story_intake_json(row):
    """Assemble the full intake JSON (01-star-intake-form schema) that the generator/critique
    prompts consume, from a story DB row."""
    g = _story_to_dict(row)
    return {
        "story_id": g["id"], "title": g["title"],
        "framing": g["framing"], "situation_task": g["situation"], "action": g["action"],
        "tension": g["tension"], "result": g["result"], "depth": g["depth"],
        "mapping": g["mapping"], "self_drafts": g["self_drafts"],
    }


def _star_now():
    return datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')


@app.route('/api/stories', methods=['GET'])
def list_stories():
    conn = get_db()
    rows = conn.execute("SELECT * FROM stories ORDER BY updated_at DESC, created_at DESC").fetchall()
    conn.close()
    return jsonify([_story_to_dict(r) for r in rows])


@app.route('/api/stories', methods=['POST'])
def create_story():
    data = request.get_json(silent=True) or {}
    sid = str(uuid.uuid4())
    now = _star_now()
    conn = get_db()
    conn.execute("INSERT INTO stories (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                 (sid, (data.get("title") or "Untitled story").strip(), now, now))
    conn.commit()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (sid,)).fetchone()
    conn.close()
    return jsonify(_story_to_dict(row)), 201


@app.route('/api/stories/<string:sid>', methods=['GET'])
def get_story(sid):
    conn = get_db()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (sid,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Story not found"}), 404
    return jsonify(_story_to_dict(row))


@app.route('/api/stories/<string:sid>', methods=['PUT'])
def update_story(sid):
    """Autosave-friendly: accepts any subset of the nested sections + scalars."""
    data = request.get_json(silent=True) or {}
    conn = get_db()
    if not conn.execute("SELECT 1 FROM stories WHERE id = ?", (sid,)).fetchone():
        conn.close()
        return jsonify({"error": "Story not found"}), 404
    sets, params = [], []
    # scalar promotions (kept queryable)
    for scalar in ("title", "decision_headline", "target_company", "primary_lp"):
        if scalar in data:
            sets.append(f"{scalar} = ?"); params.append(str(data[scalar] or ""))
    # nested sections -> JSON blobs
    section_map = {"framing": "framing_json", "situation": "situation_json", "action": "action_json",
                   "tension": "tension_json", "result": "result_json", "depth": "depth_json",
                   "mapping": "mapping_json", "self_drafts": "self_drafts_json"}
    for key, col in section_map.items():
        if key in data:
            sets.append(f"{col} = ?"); params.append(json.dumps(data[key] or {}))
    # keep the decision_headline column in sync if framing carries it
    if "framing" in data and isinstance(data["framing"], dict) and "decision_headline" in data["framing"]:
        sets.append("decision_headline = ?"); params.append(str(data["framing"].get("decision_headline") or ""))
    sets.append("updated_at = ?"); params.append(_star_now())
    params.append(sid)
    conn.execute(f"UPDATE stories SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (sid,)).fetchone()
    conn.close()
    return jsonify(_story_to_dict(row))


@app.route('/api/stories/<string:sid>', methods=['DELETE'])
def delete_story(sid):
    conn = get_db()
    conn.execute("DELETE FROM delivery_attempts WHERE story_id = ?", (sid,))
    conn.execute("DELETE FROM stories WHERE id = ?", (sid,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


def _star_key():
    conn = get_db()
    prof_row = conn.execute("SELECT llm_api_key FROM profile WHERE id = 1").fetchone()
    conn.close()
    prof = dict(prof_row) if prof_row else {}
    return (prof.get("llm_api_key") or "").strip()


def _star_rate_limit_response(rle):
    if rle.daily:
        msg = ("Groq's 120B daily budget is spent (rolling 24h window). Try again in a few "
               "minutes; bulk fit-scoring is unaffected.")
    else:
        msg = "Hit the per-minute limit; wait a few seconds and retry."
    return jsonify({"error": msg, "daily": rle.daily}), 429


@app.route('/api/stories/<string:sid>/generate', methods=['POST'])
def generate_story(sid):
    conn = get_db()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (sid,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Story not found"}), 404
    intake = _story_intake_json(row)
    user = (
        "MODE: GENERATE\n\n"
        f"WORD BANDS (enforce exactly): 2-min {WORD_BANDS['2min'][0]}-{WORD_BANDS['2min'][1]} words, "
        f"60-sec {WORD_BANDS['60s'][0]}-{WORD_BANDS['60s'][1]} words, "
        f"30-sec {WORD_BANDS['30s'][0]}-{WORD_BANDS['30s'][1]} words.\n"
        "CRITICAL: each script MUST land INSIDE its band -- at or ABOVE the minimum, not just "
        "under the max. Under-length is a FAILURE, not extra polish. If a script comes in "
        "under the minimum, EXPAND it until it lands in band: for the 2-min add the full "
        "pushback beat, a fuller one-line stakes, a second selected action, and the one-line "
        "learning; for the 60-sec add the tradeoff clause and the second action. The 2-min is "
        "the full demonstration and should sit near the TOP of its band, never the bottom. "
        "Count the words of each script and confirm it is within band before returning; put "
        "the actual counts in word_counts.\n\n"
        "Follow the skill exactly. Return ONLY a JSON object with this shape:\n"
        '{"primary_lp":"<lp> -- <one-line justification>","secondary_lps":["<lp>","<lp>"],'
        '"anti_lp":"<lp> -- <why>",'
        '"scripts":{"two_min":"<spoken script>","sixty_sec":"<spoken script>","thirty_sec":"<spoken script>"},'
        '"word_counts":{"two_min":0,"sixty_sec":0,"thirty_sec":0},'
        '"best_fit_questions":[{"question":"<q>","lp":"<lp>"}],'
        '"volunteer_first":"<the single best question>",'
        '"follow_ups":[{"question":"<q>","lp":"<lp/skill>","angle":"<one line>","trap":false}],'
        '"deep_dive":{"objection":"<most obvious objection>","rebuttal":"<one-line rebuttal>"},'
        '"coach_flags":["<flag>"]}\n'
        "Every script MUST open on the decision and END on the metric (no trailing qualifier). "
        "Flag the weakest 1-2 follow-ups with \"trap\": true.\n\n"
        "INTAKE JSON:\n" + json.dumps(intake, ensure_ascii=False)
    )
    try:
        # Free-tier is 8K tokens/request; the full generator skill (~3.1K tokens) + this
        # user prompt + max_tokens must fit under it. reasoning_effort stays "low": medium
        # spends the whole budget "thinking" and returns empty JSON at this ceiling. A side
        # effect is scripts can land ~10-20% under band; the UI counters and the rubric's
        # time check surface that, and the user can regenerate or top up to band.
        out, _ = star_chat(STAR_GENERATOR_PROMPT, user, _star_key(), json_mode=True,
                           max_tokens=3500, reasoning_effort="low", temperature=0.5)
    except RateLimitError as rle:
        return _star_rate_limit_response(rle)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    conn = get_db()
    conn.execute("UPDATE stories SET generated_json = ?, updated_at = ?, primary_lp = ? WHERE id = ?",
                 (json.dumps(out, ensure_ascii=False), _star_now(),
                  str(out.get("primary_lp", ""))[:120], sid))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "generated": out})


@app.route('/api/stories/<string:sid>/critique', methods=['POST'])
def critique_story(sid):
    data = request.get_json(silent=True) or {}
    length = (data.get("length") or "").strip()          # "2min" | "60s" | "30s"
    draft = (data.get("draft") or "").strip()
    want_tighter = bool(data.get("tighter"))
    if length not in WORD_BANDS or not draft:
        return jsonify({"error": "Provide a non-empty draft and a valid length (2min/60s/30s)."}), 400
    conn = get_db()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (sid,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Story not found"}), 404
    lo, hi = WORD_BANDS[length]
    user = (
        f"MODE: CRITIQUE\nLENGTH: {length} (target {lo}-{hi} words)\n"
        f"{'Also return a tighter version with a short diff of changes.' if want_tighter else ''}\n\n"
        "Score the candidate's OWN draft below against the delivery rubric. Return ONLY JSON:\n"
        '{"rubric_score":0,"auto_deductions":[{"code":"...","penalty":-15}],'
        '"the_one_fix":"<single behavioral instruction>","what_worked":"<one line>",'
        '"tighter_version":"<your compression, or empty if not requested>",'
        '"changed":[{"edit":"<what>","why":"<principle it serves>"}]}\n\n'
        "CANDIDATE DRAFT:\n" + draft + "\n\n"
        "STORY INTAKE (context only):\n" + json.dumps(_story_intake_json(row), ensure_ascii=False)
    )
    try:
        out, _ = star_chat(STAR_GENERATOR_PROMPT, user, _star_key(), json_mode=True, max_tokens=2200)
    except RateLimitError as rle:
        return _star_rate_limit_response(rle)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"success": True, "critique": out})


@app.route('/api/stories/<string:sid>/transcribe', methods=['POST'])
def transcribe_recording(sid):
    """Groq whisper-large-v3: audio blob -> transcript. The scoring is a separate call so the
    client can show the transcript first."""
    if 'audio' not in request.files:
        return jsonify({"error": "No audio uploaded"}), 400
    f = request.files['audio']
    try:
        text, duration = star_transcribe(f.read(), f.filename, _star_key())
    except RateLimitError as rle:
        return _star_rate_limit_response(rle)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"success": True, "transcript": text, "duration_seconds": duration})


@app.route('/api/stories/<string:sid>/attempts', methods=['GET'])
def list_attempts(sid):
    conn = get_db()
    rows = conn.execute("SELECT * FROM delivery_attempts WHERE story_id = ? ORDER BY created_at ASC",
                        (sid,)).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        for jc in ("scores_json", "auto_deductions_json"):
            try: d[jc.replace("_json", "")] = json.loads(d.pop(jc) or "null")
            except Exception: d[jc.replace("_json", "")] = None
        out.append(d)
    return jsonify(out)


@app.route('/api/stories/<string:sid>/attempts', methods=['POST'])
def score_attempt(sid):
    """Queue a transcript (from a recording or a self-draft) into ai_jobs for delivery scoring."""
    data = request.get_json(silent=True) or {}
    transcript = (data.get("transcript") or "").strip()
    length = (data.get("length") or "").strip()
    duration = float(data.get("duration_seconds") or 0)
    source = (data.get("source") or "recording").strip()
    if length not in WORD_BANDS or not transcript:
        return jsonify({"error": "Provide a transcript and a valid length (2min/60s/30s)."}), 400
    conn = get_db()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (sid,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Story not found"}), 404
    word_count = len(transcript.split())
    wpm = round(word_count / (duration / 60.0), 1) if duration > 0 else 0

    aid = str(uuid.uuid4())
    now = _star_now()

    # Insert pending attempt row
    conn.execute("""INSERT INTO delivery_attempts
        (attempt_id, story_id, length, source, duration_seconds, word_count, wpm, transcript,
         scores_json, auto_deductions_json, weighted_score, the_one_fix, what_worked, re_record, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (aid, sid, length, source, duration, word_count, wpm, transcript,
         '{}', '[]', None, 'Queued for scoring', '', 0, now))

    # Construct ai_jobs payload
    payload = {
        "attempt_id": aid,
        "story_id": sid,
        "story_title": row.get("title") or "",
        "target_company": row.get("target_company") or "Amazon",
        "primary_lp": row.get("primary_lp") or "",
        "length": length,
        "source": source,
        "duration_seconds": duration,
        "word_count": word_count,
        "wpm": wpm,
        "transcript": transcript
    }

    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version)
    VALUES ('star_delivery_eval', 'pending', ?, 'v1.1')
    """, (json.dumps(payload, ensure_ascii=False),))
    job_id = cursor.lastrowid

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "queued": True,
        "attempt_id": aid,
        "job_id": job_id,
        "attempt": {
            "attempt_id": aid,
            "story_id": sid,
            "length": length,
            "source": source,
            "duration_seconds": duration,
            "word_count": word_count,
            "wpm": wpm,
            "transcript": transcript,
            "weighted_score": None,
            "the_one_fix": "Queued for scoring",
            "what_worked": "",
            "scores": {},
            "auto_deductions": [],
            "created_at": now
        },
        "message": "Attempt queued for scoring. Run 'Process the behavioral STAR delivery scoring queue' in Antigravity or Claude."
    }), 201


# ==============================================================================
# DELIVERY TRAINING & ROLE-RELATED REPS (Rubric v1.1 + ai_jobs Queue)
# Design Intent: Raw audio capture only in Flask; agent performs transcription & analysis.
# ==============================================================================

@app.route('/api/delivery/audio', methods=['POST'])
def upload_delivery_audio():
    """Receive raw audio recording blob, store to data/audio/<uuid>.webm (or .wav).
    Flask does NO transcription, NO acoustic analysis, and NO LLM calls."""
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400
    file = request.files['audio']
    if not file or not file.filename:
        return jsonify({"error": "Empty audio file"}), 400

    ext = "webm"
    if "." in file.filename:
        cand = file.filename.rsplit(".", 1)[1].lower()
        if cand in ("webm", "wav", "mp3", "m4a", "ogg"):
            ext = cand

    uid = str(uuid.uuid4())
    filename = f"{uid}.{ext}"
    data_audio_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "audio")
    os.makedirs(data_audio_dir, exist_ok=True)
    full_path = os.path.join(data_audio_dir, filename)
    file.save(full_path)
    rel_path = os.path.join("data", "audio", filename).replace("\\", "/")

    return jsonify({
        "success": True,
        "audio_path": full_path,
        "relative_path": rel_path,
        "filename": filename
    }), 201


@app.route('/api/delivery/sessions', methods=['POST'])
def create_delivery_session():
    """Create a delivery session and enqueue an ai_jobs row with status='pending'."""
    data = request.get_json(silent=True) or {}
    mode = (data.get("mode") or "delivery").strip()  # 'delivery' | 'rep'
    answer_type = (data.get("answer_type") or "custom").strip()
    question = (data.get("question") or "").strip()
    role_job_id = data.get("role_job_id")
    is_baseline = 1 if data.get("is_baseline") else 0
    audio_path = (data.get("audio_path") or "").strip() or None
    transcript = (data.get("transcript") or "").strip() or None
    transcript_source = "whisper" if audio_path else "pasted"

    if not audio_path and not transcript:
        return jsonify({"error": "Must provide either audio_path or transcript"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO delivery_sessions
    (mode, answer_type, question, role_job_id, is_baseline, audio_path, transcript,
     transcript_source, overall, scores_json, vocal_scores_json, acoustic_json, result_json, rubric_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', NULL, NULL, NULL, 'v1.1')
    """, (mode, answer_type, question, role_job_id, is_baseline, audio_path, transcript, transcript_source))
    session_id = cursor.lastrowid

    # Construct ai_jobs payload per §7 contract
    job_type = "rep_eval" if mode == "rep" else "delivery_eval"
    payload = {
        "answer_type": answer_type,
        "question": question or None,
        "audio_path": audio_path,
        "transcript": transcript,
        "is_baseline": is_baseline
    }
    # Optional real-interview practice metadata (for Gym randomizer & Take 1 vs Take 2 tracking)
    for meta_key in (
        "pool_type", "source_type", "source_review_id", "source_company", "source_role",
        "source_round_type", "past_score", "past_gaps", "target_seconds",
        "duration_sec", "take_number"
    ):
        if data.get(meta_key) is not None and data.get(meta_key) != "":
            payload[meta_key] = data.get(meta_key)
    if mode == "rep" and role_job_id:
        job_row = conn.execute("SELECT * FROM jobs WHERE id = ?", (str(role_job_id),)).fetchone()
        if not job_row:
            job_row = conn.execute("SELECT * FROM applications WHERE id = ?", (role_job_id,)).fetchone()
        
        j_dict = dict(job_row) if job_row else {}
        co = j_dict.get("company_name") or j_dict.get("company") or ""
        role_t = j_dict.get("title") or j_dict.get("role") or ""
        jd_t = j_dict.get("notes") or ""
        payload.update({
            "role_job_id": role_job_id,
            "company": co,
            "role_title": role_t,
            "jd_text": jd_t
        })

    cursor.execute("""
    INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version, session_id, role_job_id)
    VALUES (?, 'pending', ?, 'v1.1', ?, ?)
    """, (job_type, json.dumps(payload, ensure_ascii=False), session_id, role_job_id))
    job_id = cursor.lastrowid
    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "session_id": session_id,
        "job_id": job_id,
        "message": "Queued. Run 'Process the delivery analysis queue' in Antigravity to score it."
    }), 201


@app.route('/api/delivery/real-questions', methods=['GET'])
def list_real_practice_questions():
    """Return all practice questions across 5 pools:
      - hm: Hiring Manager & Full Loop questions from the user's past interviews
      - recruiter: Recruiter screen/prep/feedback questions from the user's past interviews
      - product_sense: Past Product Sense rounds + optional external question bank
      - execution: Past Execution/Analytical rounds + optional external question bank
      - leadership: Past Leadership/Behavioral rounds (+ HM/Loop behavioral/leadership Qs)
                    + optional external question bank
    Includes past scores, gaps, model answers, and practice counts so the Practice Gym randomizer
    can prioritize weak past responses (< 7.2) and filter Mix / My Past / External Bank."""
    pool_filter = (request.args.get("pool") or "all").strip().lower()
    conn = get_db()
    rows = conn.execute("""
        SELECT id, company_name, role_title, round_type, interview_date, interviewer_info,
               overall_score, questions_json
        FROM interview_reviews
        WHERE questions_json IS NOT NULL AND questions_json != '' AND questions_json != '[]'
        ORDER BY interview_date DESC, id DESC
    """).fetchall()

    # Count how many times each question text has already been drilled in delivery_sessions
    practice_counts = {}
    for sr in conn.execute("SELECT question FROM delivery_sessions WHERE question IS NOT NULL AND question != ''").fetchall():
        qk = re.sub(r"\s+", " ", (sr["question"] or "").strip().lower())
        if qk:
            practice_counts[qk] = practice_counts.get(qk, 0) + 1
    conn.close()

    LEADERSHIP_RE = re.compile(
        r"(tell me about a time|conflict|disagree|pushback|difficult|feedback|failure|mistake|"
        r"bad decision|wrong decision|said no|led a team|mentoring|people leadership|people management|"
        r"influence without|without formal authority|stakeholder|alignment|cross[- ]functional|"
        r"ownership|escalat|good team|rally a matrix|hardest lesson|opposing interests)",
        re.IGNORECASE
    )

    pools = ("hm", "recruiter", "product_sense", "execution", "leadership")
    pool_counts = {p: {"mine": 0, "weak": 0, "lewis_lin": 0, "total": 0} for p in pools}
    questions = []

    def _add_question(item):
        p = item["pool"]
        if p in pool_counts:
            if item.get("source") == "lewis_lin":
                pool_counts[p]["lewis_lin"] += 1
            else:
                pool_counts[p]["mine"] += 1
                if item.get("is_weak"):
                    pool_counts[p]["weak"] += 1
            pool_counts[p]["total"] += 1
        if pool_filter == "all" or pool_filter == p:
            questions.append(item)

    for r in rows:
        try:
            qlist = json.loads(r["questions_json"] or "[]")
        except Exception:
            continue
        rt = (r["round_type"] or "").strip()
        rtl = rt.lower()

        if "recruiter" in rtl:
            primary_pool = "recruiter"
        elif "product sense" in rtl or "product design" in rtl:
            primary_pool = "product_sense"
        elif "execution" in rtl or "analytical" in rtl or "metrics" in rtl:
            primary_pool = "execution"
        elif "leadership" in rtl or "behavioral" in rtl or "culture" in rtl:
            primary_pool = "leadership"
        else:
            primary_pool = "hm"

        for idx, q in enumerate(qlist):
            if not isinstance(q, dict):
                continue
            qtext = (q.get("question") or "").strip()
            if len(qtext) < 12:
                continue
            raw_score = q.get("score")
            try:
                qscore = float(raw_score) if raw_score is not None else None
            except Exception:
                qscore = None
            is_weak = (qscore is not None and qscore < 7.2)
            qk = re.sub(r"\s+", " ", qtext.lower())

            base_item = {
                "uid": f"{r['id']}:{q.get('question_id') or idx + 1}",
                "source": "my_interview",
                "review_id": r["id"],
                "question_id": q.get("question_id") or f"Q{idx + 1}",
                "pool": primary_pool,
                "company": r["company_name"] or "",
                "role": r["role_title"] or "",
                "round_type": rt,
                "interview_date": r["interview_date"] or "",
                "interviewer": r["interviewer_info"] or "",
                "question": qtext,
                "score": qscore,
                "is_weak": is_weak,
                "gaps": q.get("gaps") or [],
                "what_it_tests": q.get("what_it_tests") or "",
                "how_to_approach": q.get("how_to_approach") or "",
                "model_answer": q.get("model_answer") or "",
                "practice_count": practice_counts.get(qk, 0),
            }
            _add_question(base_item)

            # Cross-list HM/Full Loop behavioral & leadership prompts into the leadership pool too
            if primary_pool == "hm" and LEADERSHIP_RE.search(qtext):
                lead_copy = dict(base_item)
                lead_copy["uid"] = f"lead:{base_item['uid']}"
                lead_copy["pool"] = "leadership"
                _add_question(lead_copy)

    # Append optional external PM question bank entries if present locally
    ll_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "interview_prep", "lewis_lin_questions.json")
    if os.path.exists(ll_path):
        try:
            with open(ll_path, "r", encoding="utf-8") as f:
                ll_data = json.load(f)
            for lq in (ll_data.get("questions") or []):
                p = lq.get("pool")
                qtext = (lq.get("question") or "").strip()
                if p not in ("product_sense", "execution", "leadership") or len(qtext) < 12:
                    continue
                qk = re.sub(r"\s+", " ", qtext.lower())
                _add_question({
                    "uid": lq.get("uid") or f"ll:{len(questions)}",
                    "source": "lewis_lin",
                    "review_id": None,
                    "question_id": lq.get("uid") or "",
                    "pool": p,
                    "company": lq.get("company") or "General PM",
                    "role": lq.get("role") or "Product Manager",
                    "round_type": lq.get("round_type") or p.replace("_", " ").title(),
                    "interview_date": lq.get("interview_date") or str(lq.get("year") or "2026"),
                    "interviewer": "External Question Bank",
                    "question": qtext,
                    "notes": lq.get("notes") or "",
                    "score": None,
                    "is_weak": False,
                    "gaps": [],
                    "what_it_tests": "",
                    "how_to_approach": lq.get("notes") or "",
                    "model_answer": "",
                    "practice_count": practice_counts.get(qk, 0),
                })
        except Exception as e:
            print(f"[real-questions] Warning: failed to load lewis_lin_questions.json: {e}")

    return jsonify({
        "pool_counts": pool_counts,
        "hm_total": pool_counts["hm"]["total"],
        "hm_weak": pool_counts["hm"]["weak"],
        "recruiter_total": pool_counts["recruiter"]["total"],
        "recruiter_weak": pool_counts["recruiter"]["weak"],
        "total": len(questions),
        "questions": questions,
    })


@app.route('/api/delivery/star-bank', methods=['GET'])
def get_canonical_star_bank():
    """Return canonical STAR stories with Quick Reference recall/use_for tags
    merged with the full spoken STAR text from TAB 2 of canonical_star_story_bank.md."""
    base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "interview_prep")
    idx_path = os.path.join(base_dir, "canonical_star_index.json")
    md_path = os.path.join(base_dir, "canonical_star_story_bank.md")

    if not os.path.exists(idx_path):
        return jsonify({"story_count": 0, "by_company": {}, "stories": [], "overlap_notes": []})

    with open(idx_path, "r", encoding="utf-8") as f:
        idx_data = json.load(f)

    full_map = {}
    overlap_notes = []
    if os.path.exists(md_path):
        with open(md_path, "r", encoding="utf-8") as f:
            md_text = f.read()

        # Extract "Avoid reusing the same project" notes from Tab 1
        ov_match = re.search(r"## Avoid reusing the same project\s*(.*?)(?:\n---|\n## TAB 2)", md_text, re.DOTALL)
        if ov_match:
            for line in ov_match.group(1).splitlines():
                line = line.strip()
                if line.startswith("**"):
                    m_ov = re.match(r"\*\*(.+?)\*\*\s+(.*)", line)
                    if m_ov:
                        overlap_notes.append({"cluster": m_ov.group(1).strip(), "note": m_ov.group(2).strip()})

        # Extract TAB 2 full STAR stories keyed by ID (M01..I01)
        tab2_idx = md_text.find("## TAB 2: FULL STAR STORIES")
        if tab2_idx != -1:
            tab2 = md_text[tab2_idx:]
            matches = list(re.finditer(r"^###\s+([MGI]\d{2})\s+(.+?)$", tab2, re.MULTILINE))
            for i, m in enumerate(matches):
                sid = m.group(1).strip()
                start = m.end()
                end = matches[i + 1].start() if i + 1 < len(matches) else len(tab2)
                block = tab2[start:end].strip()
                # Remove trailing section headings like '# Google · ...' if caught at end of block
                block = re.split(r"\n#\s+", block, maxsplit=1)[0].strip()

                sections = {}
                for para in [p.strip() for p in re.split(r"\n\s*\n", block) if p.strip()]:
                    # Handles both '**Headline**  text' and '**Task  text**' formatting from Google Docs export
                    pm = re.match(r"^\*\*(Headline|Situation|Task|Action|Result|Learning|Evidence note)\*\*[:\s]*(.*)$", para, re.IGNORECASE | re.DOTALL)
                    if not pm:
                        pm = re.match(r"^\*\*(Headline|Situation|Task|Action|Result|Learning|Evidence note)\s+(.*?)\*\*$", para, re.IGNORECASE | re.DOTALL)
                    if pm:
                        key = pm.group(1).strip().lower().replace(" ", "_")
                        val = pm.group(2).strip().replace("**", "")
                        sections[key] = val
                full_map[sid] = {
                    "full_text": block,
                    "sections": sections,
                }

    stories = []
    for st in (idx_data.get("stories") or []):
        sid = st.get("id")
        enriched = dict(st)
        fm = full_map.get(sid) or {}
        enriched["sections"] = fm.get("sections") or {}
        enriched["full_text"] = fm.get("full_text") or ""
        stories.append(enriched)

    return jsonify({
        "source_url": idx_data.get("source_url") or "",
        "story_count": len(stories),
        "by_company": idx_data.get("by_company") or {},
        "needs_confirmation_ids": idx_data.get("needs_confirmation_ids") or [],
        "overlap_notes": overlap_notes,
        "stories": stories,
    })


@app.route('/api/delivery/sessions', methods=['GET'])
def list_delivery_sessions():
    mode = request.args.get("mode")
    answer_type = request.args.get("answer_type")
    role_job_id = request.args.get("role_job_id")

    query = "SELECT * FROM delivery_sessions WHERE 1=1"
    params = []
    if mode:
        query += " AND mode = ?"
        params.append(mode)
    if answer_type:
        query += " AND answer_type = ?"
        params.append(answer_type)
    if role_job_id:
        query += " AND role_job_id = ?"
        params.append(role_job_id)

    query += " ORDER BY id DESC"
    conn = get_db()
    rows = conn.execute(query, params).fetchall()
    
    jobs_map = {}
    job_rows = conn.execute("SELECT id, company_name, title FROM jobs").fetchall()
    for jr in job_rows:
        jobs_map[str(jr["id"])] = jr
    app_rows = conn.execute("SELECT id, company, role FROM applications").fetchall()
    for ar in app_rows:
        jobs_map[str(ar["id"])] = {"id": ar["id"], "company_name": ar["company"], "title": ar["role"]}
    conn.close()

    out = []
    for r in rows:
        d = dict(r)
        for col in ("scores_json", "vocal_scores_json", "acoustic_json", "result_json"):
            val = d.pop(col, None)
            key = col.replace("_json", "")
            try:
                d[key] = json.loads(val) if val else None
            except Exception:
                d[key] = None
        
        if d.get("role_job_id"):
            info = jobs_map.get(str(d["role_job_id"]))
            if info:
                d["company_name"] = info.get("company_name")
                d["role_title"] = info.get("title")
        out.append(d)

    return jsonify(out)


@app.route('/api/delivery/sessions/<int:sid>', methods=['GET'])
def get_delivery_session(sid):
    conn = get_db()
    row = conn.execute("SELECT * FROM delivery_sessions WHERE id = ?", (sid,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Session not found"}), 404

    d = dict(row)
    for col in ("scores_json", "vocal_scores_json", "acoustic_json", "result_json"):
        val = d.pop(col, None)
        key = col.replace("_json", "")
        try:
            d[key] = json.loads(val) if val else None
        except Exception:
            d[key] = None
    return jsonify(d)


@app.route('/api/delivery/sessions/<int:sid>', methods=['DELETE'])
def delete_delivery_session(sid):
    conn = get_db()
    conn.execute("DELETE FROM ai_jobs WHERE session_id = ?", (sid,))
    conn.execute("DELETE FROM delivery_sessions WHERE id = ?", (sid,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route('/api/delivery/jobs/pending', methods=['GET'])
def list_pending_delivery_jobs():
    """Endpoint for queue processing."""
    conn = get_db()
    rows = conn.execute("SELECT * FROM ai_jobs WHERE status = 'pending' ORDER BY created_at ASC").fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.pop("payload_json") or "{}")
        except Exception:
            d["payload"] = {}
        out.append(d)
    return jsonify(out)


@app.route('/api/delivery/reps/active-roles', methods=['GET'])
@app.route('/api/delivery/prep/active-roles', methods=['GET'])
def get_active_rep_roles():
    """Fetch active roles strictly from the applications table (outcome != 'Closed')."""
    conn = get_db()
    apps = conn.execute("""
    SELECT id as role_job_id, company as company_name, role as role_title, progress as pipeline_status,
           outcome, notes as app_notes, applied_date
    FROM applications
    WHERE outcome IS NOT NULL AND outcome != 'Closed'
    ORDER BY company ASC, role ASC
    """).fetchall()

    jobs = [dict(r) for r in conn.execute("""
    SELECT id as job_id, company_name, title as role_title, notes as jd_notes, salary, location
    FROM jobs
    """).fetchall()]
    conn.close()

    result = []
    for a in apps:
        d = dict(a)
        co = _norm_key(d["company_name"])
        role_t = _norm_key(d["role_title"])
        k = (co, role_t)
        matching_job = next((j for j in jobs if (_norm_key(j["company_name"]), _norm_key(j["role_title"])) == k), None)
        if matching_job:
            d["jd_notes"] = matching_job.get("jd_notes") or d.get("app_notes") or ""
            d["salary"] = matching_job.get("salary") or ""
            d["location"] = matching_job.get("location") or ""
        else:
            d["jd_notes"] = d.get("app_notes") or ""
            d["salary"] = ""
            d["location"] = ""
        d["source"] = "application"
        result.append(d)

    result.sort(key=lambda x: (x.get("company_name", "").lower(), x.get("role_title", "").lower()))
    return jsonify(result)


@app.route('/api/prep/queue/status', methods=['GET'])
@app.route('/api/delivery/queue/status', methods=['GET'])
def get_prep_queue_status():
    """Return pending jobs count broken down by section (STAR, Role Reps, Delivery Analysis)."""
    conn = get_db()
    # Top up the server-owned queues first (dossiers for roles that moved past Submitted,
    # and a Coaching Report rewrite when the scored reviews changed).
    refresh_prep_queues(conn.cursor())
    conn.commit()
    rows = conn.execute("SELECT id, job_type, status, session_id, role_job_id, created_at FROM ai_jobs WHERE status = 'pending' ORDER BY id ASC").fetchall()
    conn.close()

    star_count = sum(1 for r in rows if r["job_type"] == "star_delivery_eval")
    reps_count = sum(1 for r in rows if r["job_type"] in ("question_gen", "rep_eval"))
    del_count = sum(1 for r in rows if r["job_type"] == "delivery_eval")
    review_count = sum(1 for r in rows if r["job_type"] == "interview_review_eval")

    return jsonify({
        "total_pending": len(rows),
        "star_pending": star_count,
        "reps_pending": reps_count,
        "delivery_pending": del_count,
        "interview_review_pending": review_count,
        "dossier_pending": sum(1 for r in rows if r["job_type"] == "role_dossier"),
        "coaching_report_pending": sum(1 for r in rows if r["job_type"] == "coaching_report"),
        "jobs": [dict(r) for r in rows]
    })


@app.route('/api/prep/queue/process', methods=['POST'])
def process_prep_queue_endpoint():
    """Trigger the Gemini Multimodal Subagent to evaluate pending ai_jobs."""
    try:
        sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts"))
        from process_interview_subagent import run_queue_pass
        count = run_queue_pass()
        return jsonify({
            "success": True,
            "processed_count": count,
            "message": f"Processed {count} pending interview prep jobs using Gemini Subagent (Rubric v2.1)."
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def _handle_generate_mock_questions(data):
    role_job_id = data.get("role_job_id")
    regenerate = bool(data.get("regenerate"))
    count = min(10, int(data.get("count") or 10))

    if not role_job_id:
        return jsonify({"error": "Missing role_job_id"}), 400

    conn = get_db()
    if not regenerate:
        cached = conn.execute("SELECT * FROM mock_question_sets WHERE role_job_id = ? ORDER BY id DESC LIMIT 1",
                              (str(role_job_id),)).fetchone()
        if cached:
            try:
                qs = json.loads(cached["questions_json"] or "[]")
                conn.close()
                return jsonify({"success": True, "cached": True, "questions": qs})
            except Exception:
                pass

    job_row = conn.execute("SELECT * FROM jobs WHERE id = ?", (str(role_job_id),)).fetchone()
    if not job_row:
        job_row = conn.execute("SELECT * FROM applications WHERE id = ?", (role_job_id,)).fetchone()
    
    prof_row = conn.execute("SELECT summary, canonical_resume FROM profile WHERE id = 1").fetchone()
    prof = dict(prof_row) if prof_row else {}
    cand_ctx = (prof.get("canonical_resume") or prof.get("summary") or "")

    j_dict = dict(job_row) if job_row else {}
    jd_text = j_dict.get("notes") or ""
    co = j_dict.get("company_name") or j_dict.get("company") or ""
    role_t = j_dict.get("title") or j_dict.get("role") or ""

    payload = {
        "role_job_id": role_job_id,
        "company": co,
        "role_title": role_t,
        "jd_text": jd_text,
        "count": count,
        "candidate_context": cand_ctx[:3000]
    }

    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version, role_job_id)
    VALUES ('question_gen', 'pending', ?, 'v1.1', ?)
    """, (json.dumps(payload, ensure_ascii=False), str(role_job_id)))
    job_id = cursor.lastrowid
    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "cached": False,
        "job_id": job_id,
        "message": "Question generation queued. Run process the interview-prep queue in Antigravity to generate."
    }), 202


@app.route('/api/delivery/reps/mock-questions', methods=['GET', 'POST'])
@app.route('/api/delivery/prep/mock-questions', methods=['GET', 'POST'])
def generate_mock_questions_endpoint():
    if request.method == 'GET':
        role_job_id = request.args.get("role_job_id")
        if not role_job_id:
            return jsonify({"questions": []})
        return get_mock_questions(role_job_id)
    data = request.get_json(silent=True) or {}
    return _handle_generate_mock_questions(data)


@app.route('/api/delivery/reps/mock-questions/<string:role_job_id>', methods=['GET', 'POST'])
@app.route('/api/delivery/prep/mock-questions/<string:role_job_id>', methods=['GET', 'POST'])
def get_mock_questions(role_job_id):
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        data["role_job_id"] = role_job_id
        return _handle_generate_mock_questions(data)
    conn = get_db()
    row = conn.execute("SELECT * FROM mock_question_sets WHERE role_job_id = ? ORDER BY id DESC LIMIT 1",
                       (str(role_job_id),)).fetchone()
    conn.close()
    if not row:
        return jsonify({"questions": []})
    try:
        return jsonify({"questions": json.loads(row["questions_json"] or "[]")})
    except Exception:
        return jsonify({"questions": []})


@app.route('/api/delivery/baseline/upload', methods=['POST'])
def upload_baseline_screens():
    """Bulk upload 3-4 existing recorded screen files as baseline sessions."""
    if 'files' not in request.files:
        return jsonify({"error": "No files uploaded"}), 400
    files = request.files.getlist('files')
    answer_types = request.form.getlist('answer_types')
    questions = request.form.getlist('questions')

    data_audio_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "audio")
    os.makedirs(data_audio_dir, exist_ok=True)

    conn = get_db()
    cursor = conn.cursor()
    created = []

    for i, file in enumerate(files):
        if not file or not file.filename:
            continue
        ext = "webm"
        if "." in file.filename:
            cand = file.filename.rsplit(".", 1)[1].lower()
            if cand in ("webm", "wav", "mp3", "m4a", "ogg"):
                ext = cand
        uid = str(uuid.uuid4())
        filename = f"{uid}.{ext}"
        full_path = os.path.join(data_audio_dir, filename)
        file.save(full_path)

        ans_type = answer_types[i] if i < len(answer_types) and answer_types[i] else "intro"
        q_text = questions[i] if i < len(questions) and questions[i] else f"Baseline {ans_type}"

        cursor.execute("""
        INSERT INTO delivery_sessions
        (mode, answer_type, question, role_job_id, is_baseline, audio_path, transcript,
         transcript_source, overall, scores_json, vocal_scores_json, acoustic_json, result_json, rubric_version)
        VALUES ('delivery', ?, ?, NULL, 1, ?, NULL, 'whisper', NULL, '{}', NULL, NULL, NULL, 'v1.1')
        """, (ans_type, q_text, full_path))
        sid = cursor.lastrowid

        payload = {
            "answer_type": ans_type,
            "question": q_text,
            "audio_path": full_path,
            "transcript": None,
            "is_baseline": 1
        }
        cursor.execute("""
        INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version, session_id)
        VALUES ('delivery_eval', 'pending', ?, 'v1.1', ?)
        """, (json.dumps(payload, ensure_ascii=False), sid))
        jid = cursor.lastrowid
        created.append({"session_id": sid, "job_id": jid, "filename": file.filename})

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "count": len(created),
        "sessions": created,
        "message": f"Uploaded {len(created)} baseline screens and queued for evaluation."
    }), 201


@app.route('/api/delivery/sessions/clear', methods=['POST'])
def clear_delivery_sessions():
    """Purge all delivery sessions and reset statistics."""
    conn = get_db()
    conn.execute("DELETE FROM delivery_sessions")
    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "All delivery sessions cleared."})


@app.route('/api/interview-reviews/upload', methods=['POST'])
def upload_interview_review_audio():
    """Upload audio or transcript file for a real interview performance review."""
    company_name = (request.form.get("company_name") or "").strip()
    role_title = (request.form.get("role_title") or "").strip()
    role_job_id = request.form.get("role_job_id")
    round_type = (request.form.get("round_type") or "Hiring Manager").strip()
    interview_date = (request.form.get("interview_date") or "").strip()
    interviewer_info = (request.form.get("interviewer_info") or "").strip()

    if not company_name or not role_title:
        return jsonify({"error": "company_name and role_title are required"}), 400

    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files['file']
    if not file or not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    ext = "webm"
    if "." in file.filename:
        cand = file.filename.rsplit(".", 1)[1].lower()
        if cand in ("webm", "wav", "mp3", "m4a", "mp4", "ogg", "aac", "flac", "txt", "json", "srt", "vtt", "md"):
            ext = cand

    uid = str(uuid.uuid4())
    filename = f"interview_{uid}.{ext}"

    is_text = ext in ("txt", "json", "srt", "vtt", "md")
    if is_text:
        transcripts_dir = os.path.join(PROJECT_ROOT, "board", "interview_prep", "interview_transcripts")
        os.makedirs(transcripts_dir, exist_ok=True)
        full_path = os.path.join(transcripts_dir, filename)
        file.save(full_path)
        try:
            with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                transcript_text = f.read()
        except Exception:
            transcript_text = ""
        audio_path = None
        source = "file_upload"
    else:
        audios_dir = os.path.join(PROJECT_ROOT, "board", "interview_prep", "interview_audios")
        os.makedirs(audios_dir, exist_ok=True)
        full_path = os.path.join(audios_dir, filename)
        file.save(full_path)
        transcript_text = None
        audio_path = full_path
        source = "audio_upload"

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO interview_reviews
    (company_name, role_title, role_job_id, round_type, interview_date, interviewer_info,
     audio_path, transcript, transcript_source, overall_score, scores_json, rubric_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', 'v2.0')
    """, (company_name, role_title, int(role_job_id) if role_job_id and str(role_job_id).isdigit() else None,
          round_type, interview_date, interviewer_info, audio_path, transcript_text, source))
    review_id = cursor.lastrowid

    payload = {
        "review_id": review_id,
        "company_name": company_name,
        "role_title": role_title,
        "round_type": round_type,
        "interview_date": interview_date,
        "interviewer_info": interviewer_info,
        "audio_path": audio_path,
        "transcript": transcript_text,
        "source": source
    }

    cursor.execute("""
    INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version, session_id)
    VALUES ('interview_review_eval', 'pending', ?, 'v2.0', ?)
    """, (json.dumps(payload, ensure_ascii=False), review_id))
    job_id = cursor.lastrowid

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "review_id": review_id,
        "job_id": job_id,
        "message": "Interview uploaded and queued for evaluation."
    }), 201


@app.route('/api/interview-reviews/paste', methods=['POST'])
def paste_interview_review_transcript():
    """Submit a pasted transcript for real interview performance evaluation."""
    data = request.get_json(silent=True) or {}
    company_name = (data.get("company_name") or "").strip()
    role_title = (data.get("role_title") or "").strip()
    role_job_id = data.get("role_job_id")
    round_type = (data.get("round_type") or "Hiring Manager").strip()
    interview_date = (data.get("interview_date") or "").strip()
    interviewer_info = (data.get("interviewer_info") or "").strip()
    transcript = (data.get("transcript") or "").strip()

    if not company_name or not role_title:
        return jsonify({"error": "company_name and role_title are required"}), 400
    if not transcript:
        return jsonify({"error": "transcript text is required"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO interview_reviews
    (company_name, role_title, role_job_id, round_type, interview_date, interviewer_info,
     audio_path, transcript, transcript_source, overall_score, scores_json, rubric_version)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pasted', NULL, '{}', 'v2.0')
    """, (company_name, role_title, int(role_job_id) if role_job_id and str(role_job_id).isdigit() else None,
          round_type, interview_date, interviewer_info, transcript))
    review_id = cursor.lastrowid

    payload = {
        "review_id": review_id,
        "company_name": company_name,
        "role_title": role_title,
        "round_type": round_type,
        "interview_date": interview_date,
        "interviewer_info": interviewer_info,
        "audio_path": None,
        "transcript": transcript,
        "source": "pasted"
    }

    cursor.execute("""
    INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version, session_id)
    VALUES ('interview_review_eval', 'pending', ?, 'v2.0', ?)
    """, (json.dumps(payload, ensure_ascii=False), review_id))
    job_id = cursor.lastrowid

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "review_id": review_id,
        "job_id": job_id,
        "message": "Interview transcript stored and queued for performance evaluation."
    }), 201


@app.route('/api/interview-reviews', methods=['GET'])
def list_interview_reviews():
    """List all interview reviews with parsed JSON details."""
    conn = get_db()
    rows = conn.execute("SELECT * FROM interview_reviews ORDER BY COALESCE(interview_date, created_at) DESC, id DESC").fetchall()
    conn.close()

    out = []
    for r in rows:
        d = dict(r)
        for json_field in ("scores_json", "questions_json", "strengths_json", "gaps_json", "rewrites_json", "acoustic_json"):
            try:
                d[json_field.replace("_json", "")] = json.loads(d.pop(json_field) or "{}")
            except Exception:
                d[json_field.replace("_json", "")] = {} if "scores" in json_field or "acoustic" in json_field else []
        try:
            d["scores_v2"] = json.loads(d.get("scores_v2_json") or "{}")
        except Exception:
            d["scores_v2"] = {}
        out.append(d)
    return jsonify(out)


@app.route('/api/interview-reviews/<int:review_id>', methods=['GET'])
def get_interview_review_detail(review_id):
    """Fetch single interview review detail."""
    conn = get_db()
    row = conn.execute("SELECT * FROM interview_reviews WHERE id = ?", (review_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Interview review not found"}), 404

    d = dict(row)
    for json_field in ("scores_json", "questions_json", "strengths_json", "gaps_json", "rewrites_json", "acoustic_json"):
        try:
            d[json_field.replace("_json", "")] = json.loads(d.pop(json_field) or "{}")
        except Exception:
            d[json_field.replace("_json", "")] = {} if "scores" in json_field or "acoustic" in json_field else []
    try:
        d["scores_v2"] = json.loads(d.get("scores_v2_json") or "{}")
    except Exception:
        d["scores_v2"] = {}
    return jsonify(d)


@app.route('/api/coaches', methods=['GET'])
def list_coaches():
    """Coach wisdom + resource links (loaded by the Prep Hub migration from coaches.json).
    Optional ?dimension=<v3 dimension display name> filters to coaches for that dimension.
    Returns [] (never an error) if the coaches table has not been created yet."""
    dim = (request.args.get('dimension') or '').strip().lower()
    conn = get_db()
    try:
        rows = conn.execute("SELECT name, credibility, dimensions_json, framework, when_weak, "
                            "resources_json FROM coaches ORDER BY name").fetchall()
    except Exception:
        conn.close()
        return jsonify([])
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["dimensions"] = json.loads(d.pop("dimensions_json") or "[]")
            d["resources"] = json.loads(d.pop("resources_json") or "[]")
        except Exception:
            d["dimensions"], d["resources"] = [], []
        if dim and not any(dim in str(x).lower() for x in d["dimensions"]):
            continue
        out.append(d)
    return jsonify(out)


@app.route('/api/interview-reviews/<int:review_id>', methods=['DELETE'])
def delete_interview_review(review_id):
    """Delete an interview review and clean up files and pending jobs."""
    conn = get_db()
    row = conn.execute("SELECT audio_path FROM interview_reviews WHERE id = ?", (review_id,)).fetchone()
    if row and row["audio_path"] and os.path.exists(row["audio_path"]):
        try:
            os.remove(row["audio_path"])
        except Exception:
            pass
    conn.execute("DELETE FROM interview_reviews WHERE id = ?", (review_id,))
    conn.execute("DELETE FROM ai_jobs WHERE job_type = 'interview_review_eval' AND session_id = ?", (review_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Interview review deleted."})


@app.route('/api/interview-reviews/trends', methods=['GET'])
def get_interview_reviews_trends():
    """Compute longitudinal progress, dimension averages, and improvement/regression deltas."""
    try:
        # Optional filters: ?role_job_id=<applications.id> (P5) and ?round_type=<category>
        role_filter = (request.args.get('role_job_id') or '').strip()
        round_filter = (request.args.get('round_type') or '').strip()

        sql = ("SELECT id, company_name, role_title, round_type, interview_date, overall_score, "
               "scores_json, created_at FROM interview_reviews WHERE overall_score IS NOT NULL")
        params = []
        if role_filter and role_filter.lower() != 'all':
            sql += " AND role_job_id = ?"
            params.append(role_filter)

        if round_filter and round_filter.lower() != 'all':
            rf_lower = round_filter.lower()
            if rf_lower in ('recruiter', 'recruiter_screen'):
                sql += " AND (LOWER(round_type) LIKE '%recruiter%' OR LOWER(round_type) LIKE '%screen%') AND LOWER(round_type) NOT LIKE '%hiring manager%'"
            elif rf_lower in ('hiring_manager', 'hm'):
                sql += " AND (LOWER(round_type) LIKE '%hiring manager%' OR LOWER(round_type) LIKE '%hm%')"
            elif rf_lower in ('product_sense', 'sense'):
                sql += " AND (LOWER(round_type) LIKE '%product sense%' OR LOWER(round_type) LIKE '%sense%' OR LOWER(round_type) LIKE '%design%')"
            elif rf_lower in ('execution', 'product_execution'):
                sql += " AND (LOWER(round_type) LIKE '%execution%' OR LOWER(round_type) LIKE '%strategy%')"
            elif rf_lower in ('leadership', 'behavioral'):
                sql += " AND (LOWER(round_type) LIKE '%leadership%' OR LOWER(round_type) LIKE '%behavioral%' OR LOWER(round_type) LIKE '%culture%')"
            elif rf_lower in ('full_loop', 'loop', 'onsite'):
                sql += " AND (LOWER(round_type) LIKE '%loop%' OR LOWER(round_type) LIKE '%onsite%')"
            else:
                sql += " AND round_type = ?"
                params.append(round_filter)

        sql += " ORDER BY COALESCE(interview_date, created_at) ASC, id ASC"
        conn = get_db()
        rows = conn.execute(sql, params).fetchall()
        conn.close()

        eval_list = []
        for r in rows:
            d = dict(r)
            try:
                d["scores"] = json.loads(d.pop("scores_json") or "{}")
            except Exception:
                d["scores"] = {}
            eval_list.append(d)

        dim_keys = [
            ("product_sense", "Strategic Product Sense"),
            ("execution", "Execution & Impact Landing"),
            ("technical", "Technical Architecture"),
            ("leadership", "Leadership & Influence"),
            ("communication", "Communication Clarity"),
            ("agility", "Spoken Agility & Probes")
        ]

        aliases = {
            "product_sense": ["product_sense", "strategic_vision"],
            "execution": ["execution", "execution_tech_depth", "execution_scalability"],
            "technical": ["technical", "execution_tech_depth", "analytical_rigor", "technical_depth"],
            "leadership": ["leadership", "leadership_influence", "people_leadership"],
            "communication": ["communication", "executive_delivery"],
            "agility": ["agility", "probe_handling", "customer_centricity"]
        }

        def extract_dim_val(scores_dict, key):
            if not isinstance(scores_dict, dict):
                return None
            target = scores_dict.get("dimensions") if isinstance(scores_dict.get("dimensions"), dict) else scores_dict
            keys_to_try = aliases.get(key, [key])
            for candidate_key in keys_to_try:
                sc = target.get(candidate_key) if isinstance(target, dict) else None
                if sc is None and isinstance(scores_dict, dict):
                    sc = scores_dict.get(candidate_key)
                if sc is not None:
                    if isinstance(sc, dict):
                        val = sc.get("score")
                    else:
                        val = sc
                    if val is not None:
                        try:
                            return float(val)
                        except (ValueError, TypeError):
                            pass
            return None

        total_evaluated = len(eval_list)
        if total_evaluated == 0:
            return jsonify({
                "total_evaluated": 0,
                "overall_avg": None,
                "overall_delta": 0.0,
                "dimension_averages": {k: None for k, _ in dim_keys},
                "timeline": [],
                "deltas": {},
                "strongest_dimension": None,
                "top_gap_dimension": None
            })

        overall_avg = round(sum(e["overall_score"] for e in eval_list if e.get("overall_score") is not None) / total_evaluated, 1)

        dim_averages = {}
        for k, label in dim_keys:
            vals = []
            for e in eval_list:
                val = extract_dim_val(e.get("scores", {}), k)
                if val is not None:
                    vals.append(val)
            dim_averages[k] = round(sum(vals) / len(vals), 1) if vals else None

        # Compute deltas: compare latest vs immediately preceding
        deltas = {}
        if total_evaluated >= 2:
            latest = eval_list[-1]
            prev = eval_list[-2]
            latest_ov = latest.get("overall_score") or 0.0
            prev_ov = prev.get("overall_score") or 0.0
            overall_delta = round(latest_ov - prev_ov, 1)
            for k, label in dim_keys:
                lv = extract_dim_val(latest.get("scores", {}), k)
                pv = extract_dim_val(prev.get("scores", {}), k)
                # Not-probed dimensions are N/A, not zero: skip the delta rather than
                # fabricating a swing against a 0.0 default.
                if lv is None or pv is None:
                    deltas[k] = {
                        "latest": lv,
                        "previous": pv,
                        "delta": None,
                        "status": "n/a"
                    }
                    continue
                d_val = round(lv - pv, 1)
                deltas[k] = {
                    "latest": lv,
                    "previous": pv,
                    "delta": d_val,
                    "status": "improved" if d_val > 0.3 else ("regressed" if d_val < -0.3 else "steady")
                }
        else:
            latest = eval_list[-1]
            overall_delta = 0.0
            for k, label in dim_keys:
                lv = extract_dim_val(latest.get("scores", {}), k)
                deltas[k] = {
                    "latest": lv,
                    "previous": lv,
                    "delta": None if lv is None else 0.0,
                    "status": "n/a" if lv is None else "steady"
                }

        valid_dim_avgs = {k: v for k, v in dim_averages.items() if v is not None}
        strongest_dim = max(valid_dim_avgs, key=valid_dim_avgs.get) if valid_dim_avgs else None
        weakest_dim = min(valid_dim_avgs, key=valid_dim_avgs.get) if valid_dim_avgs else None

        return jsonify({
            "total_evaluated": total_evaluated,
            "overall_avg": overall_avg,
            "overall_delta": overall_delta,
            "dimension_averages": dim_averages,
            "timeline": eval_list,
            "deltas": deltas,
            "strongest_dimension": strongest_dim,
            "top_gap_dimension": weakest_dim
        })
    except Exception as e:
        return jsonify({
            "total_evaluated": 0,
            "overall_avg": None,
            "overall_delta": 0.0,
            "dimension_averages": {},
            "timeline": [],
            "deltas": {},
            "strongest_dimension": None,
            "top_gap_dimension": None,
            "error": str(e)
        }), 200


# --- PREP HUB AUTOMATION: coaching report + role dossier queues -------------------
# Two things used to depend on someone remembering to prompt an agent:
#   1. The longitudinal Coaching Report was static HTML, so a new evaluation never changed it.
#   2. A role dossier was only built when asked for, not when an application moved from
#      'Submitted' into a recruiter / hiring-manager conversation.
# Both are now queue-driven (ai_jobs: 'coaching_report', 'role_dossier') and the queue is
# filled by the server itself; a scheduled Claude task drains it through the endpoints below.

V3_DIM_LABELS = {"structure_clarity": "Structure & Clarity",
                 "product_customer_sense": "Product & Customer Sense",
                 "strategic_analytical": "Strategic & Analytical Rigor",
                 "execution_craft": "Execution & Craft",
                 "leadership_ownership": "Leadership & Ownership",
                 "delivery_vocal": "Delivery & Vocal Presence"}


def _prep_now():
    return datetime.datetime.now().strftime('%Y-%m-%d %I:%M %p')


def _ensure_prep_tables(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS coaching_reports (
        id INTEGER PRIMARY KEY CHECK (id = 1), report_json TEXT, signature TEXT,
        source TEXT, generated_at TEXT)""")


def _loads(val, default):
    try:
        out = json.loads(val) if isinstance(val, str) and val.strip() else val
        return out if out is not None else default
    except Exception:
        return default


def _evaluated_reviews(cur):
    return cur.execute(
        "SELECT id, company_name, role_title, round_type, interview_date, created_at, updated_at, "
        "overall_score, the_one_fix, scores_v2_json FROM interview_reviews "
        "WHERE overall_score IS NOT NULL "
        "ORDER BY COALESCE(NULLIF(interview_date, ''), created_at) ASC, id ASC").fetchall()


def _reviews_signature(rows):
    """Changes whenever a review is added, removed or re-scored."""
    if not rows:
        return ""
    return f"{len(rows)}:{max(r['id'] for r in rows)}:{max((r['updated_at'] or r['created_at'] or '') for r in rows)}"


def _has_pending_job(cur, job_type, role_job_id=None):
    if role_job_id is None:
        return cur.execute("SELECT 1 FROM ai_jobs WHERE status='pending' AND job_type=? LIMIT 1",
                           (job_type,)).fetchone() is not None
    return cur.execute("SELECT 1 FROM ai_jobs WHERE status='pending' AND job_type=? AND role_job_id=? LIMIT 1",
                       (job_type, role_job_id)).fetchone() is not None


def _finish_jobs(cur, job_type, where_sql, params, result):
    cur.execute(f"UPDATE ai_jobs SET status='done', result_json=?, updated_at=datetime('now') "
                f"WHERE status='pending' AND job_type=? AND {where_sql}",
                (json.dumps(result, ensure_ascii=False), job_type, *params))


def compute_coaching_report(rows):
    """Deterministic coaching summary straight from the scored reviews.

    Always current, because it is recomputed on every request. Compares each dimension's
    last three PROBED rounds against the rounds before them; not-probed (null) scores are
    skipped, never treated as zero.
    """
    series = {k: [] for k in V3_DIM_LABELS}
    for r in rows:
        dims = (_loads(r["scores_v2_json"], {}) or {}).get("dims") or {}
        for k in series:
            v = dims.get(k)
            if isinstance(v, (int, float)):
                series[k].append(float(v))
    stats = {}
    for k, vals in series.items():
        if not vals:
            continue
        recent, prior = vals[-3:], vals[:-3]
        r_avg = sum(recent) / len(recent)
        p_avg = (sum(prior) / len(prior)) if prior else None
        stats[k] = {"label": V3_DIM_LABELS[k], "avg": round(sum(vals) / len(vals), 1),
                    "recent": round(r_avg, 1), "prior": round(p_avg, 1) if p_avg is not None else None,
                    "delta": round(r_avg - p_avg, 1) if p_avg is not None else None, "n": len(vals)}

    def moved(s):
        return f"{s['prior']} to {s['recent']} across your last {min(3, s['n'])} probed rounds (all-time average {s['avg']})"

    improving = [{"title": s["label"], "detail": "Up from " + moved(s) + "."}
                 for s in sorted(stats.values(), key=lambda s: -(s["delta"] or 0)) if (s["delta"] or 0) >= 0.3][:3]
    if not improving:
        improving = [{"title": s["label"], "detail": f"Your strongest dimension: average {s['avg']} over {s['n']} rounds."}
                     for s in sorted(stats.values(), key=lambda s: -s["avg"])[:2]]
    focus = [{"title": s["label"], "detail": f"Lowest-scoring dimension: average {s['avg']}, recent {s['recent']}."}
             for s in sorted(stats.values(), key=lambda s: s["avg"])[:2]]
    regress = [{"title": s["label"], "detail": "Down from " + moved(s) + "."}
               for s in sorted(stats.values(), key=lambda s: (s["delta"] or 0)) if (s["delta"] or 0) <= -0.3][:3]

    latest = rows[-1] if rows else None
    if latest and (latest["the_one_fix"] or "").strip():
        focus.append({"title": f"Latest fix ({latest['company_name']}, {latest['round_type']})",
                      "detail": latest["the_one_fix"].strip()})
    companies = []
    for r in reversed(rows):
        if r["company_name"] not in companies:
            companies.append(r["company_name"])
    scored = [r["overall_score"] for r in rows if isinstance(r["overall_score"], (int, float))]
    return {
        "review_count": len(rows),
        "overall_avg": round(sum(scored) / len(scored), 1) if scored else None,
        "companies": companies[:5],
        "latest": ({"id": latest["id"], "company": latest["company_name"], "round": latest["round_type"],
                    "date": latest["interview_date"] or (latest["created_at"] or "")[:10],
                    "overall": latest["overall_score"]} if latest else None),
        "dimensions": stats, "improving": improving, "focus": focus, "regressions": regress,
    }


def ensure_coaching_report_job(cur):
    """Queue a coaching-report rewrite when the scored reviews changed since the last one.

    Waits until no evaluation is still pending, so one upload of several rounds produces one
    rewrite at the end rather than one per round.
    """
    _ensure_prep_tables(cur)
    rows = _evaluated_reviews(cur)
    if not rows:
        return False
    stored = cur.execute("SELECT signature, source FROM coaching_reports WHERE id = 1").fetchone()
    if stored and stored["signature"] == _reviews_signature(rows) and stored["source"] == "claude":
        return False
    if _has_pending_job(cur, "interview_review_eval") or _has_pending_job(cur, "coaching_report"):
        return False
    cur.execute("INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version) "
                "VALUES ('coaching_report', 'pending', ?, 'coaching-v1')",
                (json.dumps({"signature": _reviews_signature(rows), "review_count": len(rows)}),))
    return True


def enqueue_dossier_job(cur, app, reason):
    """Queue a discussion dossier for one application. Idempotent while one is pending."""
    if _has_pending_job(cur, "role_dossier", app["id"]):
        return False
    payload = {"app_id": app["id"], "company": app["company"], "role": app["role"],
               "stage": app["progress"], "reason": reason}
    cur.execute("INSERT INTO ai_jobs (job_type, status, payload_json, rubric_version, role_job_id) "
                "VALUES ('role_dossier', 'pending', ?, 'dossier-v2', ?)",
                (json.dumps(payload, ensure_ascii=False), app["id"]))
    # Creating the prep row is what moves the role into My Roles > Active.
    cur.execute("INSERT INTO prep_guides (app_id, company_name, role_title, updated_at) VALUES (?,?,?,?) "
                "ON CONFLICT(app_id) DO NOTHING", (app["id"], app["company"], app["role"], _prep_now()))
    return True


def enqueue_missing_dossiers(cur):
    """Every live application that has moved past 'Submitted' must have a dossier written for
    its CURRENT stage. Called after any application change and on every queue-status read, so
    a stage change made by any route (UI, agent, direct edit) is caught."""
    apps = cur.execute(
        "SELECT a.id, a.company, a.role, a.progress, a.outcome, g.guide_json FROM applications a "
        "LEFT JOIN prep_guides g ON g.app_id = a.id "
        "WHERE COALESCE(a.outcome, '') != 'Closed' AND COALESCE(a.progress, 'Submitted') != 'Submitted'").fetchall()
    queued = 0
    for a in apps:
        guide = _loads(a["guide_json"], {}) or {}
        if guide.get("company_overview") and guide.get("stage") == a["progress"]:
            continue
        reason = ("stage changed to " + a["progress"]) if guide.get("company_overview") else "first dossier"
        if enqueue_dossier_job(cur, a, reason):
            queued += 1
    return queued


def refresh_prep_queues(cur):
    """Fill the server-owned queues. Never raises: queue upkeep must not break a page load."""
    try:
        enqueue_missing_dossiers(cur)
        ensure_coaching_report_job(cur)
    except Exception as e:
        print("refresh_prep_queues warning:", e)


@app.route('/api/interview-reviews/coaching-report', methods=['GET'])
def get_coaching_report():
    """The longitudinal Coaching Report. `computed` is always current; `narrative` is the
    coach-written version, flagged `stale` when reviews changed after it was written."""
    conn = get_db()
    try:
        cur = conn.cursor()
        _ensure_prep_tables(cur)
        rows = _evaluated_reviews(cur)
        stored = cur.execute("SELECT * FROM coaching_reports WHERE id = 1").fetchone()
        ensure_coaching_report_job(cur)
        conn.commit()
        narrative = _loads(stored["report_json"], None) if stored else None
        return jsonify({
            "computed": compute_coaching_report(rows),
            "narrative": narrative,
            "narrative_generated_at": stored["generated_at"] if stored else None,
            "stale": bool(rows) and (not stored or stored["signature"] != _reviews_signature(rows)),
            "refresh_queued": _has_pending_job(cur, "coaching_report"),
            "evaluations_pending": _has_pending_job(cur, "interview_review_eval"),
        })
    finally:
        conn.close()


@app.route('/api/interview-reviews/coaching-report', methods=['POST'])
def save_coaching_report():
    """Agent writes the coach narrative. Body: {"report": {"headline": str,
    "improving": [{"title","detail"}], "focus": [...], "regressions": [...],
    "next_actions": [str]}}."""
    report = (request.get_json(silent=True) or {}).get("report")
    if not isinstance(report, dict) or not any(report.get(k) for k in ("improving", "focus", "regressions")):
        return jsonify({"error": "report with improving / focus / regressions lists is required"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        _ensure_prep_tables(cur)
        sig = _reviews_signature(_evaluated_reviews(cur))
        cur.execute("""INSERT INTO coaching_reports (id, report_json, signature, source, generated_at)
                       VALUES (1, ?, ?, 'claude', ?)
                       ON CONFLICT(id) DO UPDATE SET report_json=excluded.report_json,
                           signature=excluded.signature, source=excluded.source,
                           generated_at=excluded.generated_at""",
                    (json.dumps(report, ensure_ascii=False), sig, _prep_now()))
        _finish_jobs(cur, "coaching_report", "1=1", (), {"signature": sig})
        conn.commit()
        return jsonify({"success": True, "signature": sig})
    finally:
        conn.close()


REVIEW_EVAL_TEXT = ("transcript", "structured_transcript", "the_one_fix", "rubric_version",
                    "dimension_version", "transcript_source")
REVIEW_EVAL_JSON = ("scores_json", "scores_v2_json", "questions_json", "strengths_json",
                    "gaps_json", "rewrites_json", "acoustic_json")


@app.route('/api/interview-reviews/<int:review_id>/evaluation', methods=['POST'])
def save_interview_review_evaluation(review_id):
    """Agent writes a finished evaluation. Only the fields present are changed. Marks the
    review's pending evaluation job done and queues the Coaching Report rewrite, which is the
    hook the old direct-to-database writes never had."""
    data = request.get_json(silent=True) or {}
    updates = {}
    if "overall_score" in data:
        try:
            updates["overall_score"] = None if data["overall_score"] is None else float(data["overall_score"])
        except (TypeError, ValueError):
            return jsonify({"error": "overall_score must be a number"}), 400
    for k in REVIEW_EVAL_TEXT:
        if k in data:
            updates[k] = data[k]
    for k in REVIEW_EVAL_JSON:
        if k in data:
            updates[k] = data[k] if isinstance(data[k], str) else json.dumps(data[k], ensure_ascii=False)
    if not updates:
        return jsonify({"error": "No evaluation fields provided"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        if not cur.execute("SELECT id FROM interview_reviews WHERE id = ?", (review_id,)).fetchone():
            return jsonify({"error": "Review not found"}), 404
        sets = ", ".join(f"{k} = ?" for k in updates)
        cur.execute(f"UPDATE interview_reviews SET {sets}, updated_at = datetime('now') WHERE id = ?",
                    (*updates.values(), review_id))
        done = False
        if updates.get("overall_score") is not None:
            _finish_jobs(cur, "interview_review_eval", "session_id = ?", (review_id,),
                         {"review_id": review_id, "overall_score": updates["overall_score"]})
            done = True
        queued = ensure_coaching_report_job(cur)
        conn.commit()
        return jsonify({"success": True, "job_marked_done": done, "coaching_report_queued": queued})
    finally:
        conn.close()


@app.route('/api/prep/dossier/queue', methods=['GET'])
def dossier_queue():
    """Pending dossier jobs with everything needed to write one: the application, the board
    job it came from (JD text, fit notes, résumé and brief links), earlier rounds, and the
    dossier already on file."""
    conn = get_db()
    try:
        cur = conn.cursor()
        refresh_prep_queues(cur)
        conn.commit()
        out = []
        for j in cur.execute("SELECT id, payload_json, role_job_id, created_at FROM ai_jobs "
                             "WHERE status='pending' AND job_type='role_dossier' ORDER BY id").fetchall():
            app_row = cur.execute("SELECT * FROM applications WHERE id = ?", (j["role_job_id"],)).fetchone()
            if not app_row:
                continue
            src = cur.execute(
                "SELECT ar.resume_doc_url, ar.brief_doc_url, j.url, j.location, j.salary, j.notes, "
                "j.experience_fit, j.criteria_fit, j.fit_experience_note, j.fit_criteria_note, j.fit_framing "
                "FROM apply_requests ar JOIN jobs j ON j.id = ar.job_id WHERE ar.application_id = ?",
                (app_row["id"],)).fetchone()
            rounds = cur.execute(
                "SELECT id, round_type, interview_date, interviewer_info, overall_score, the_one_fix "
                "FROM interview_reviews WHERE role_job_id = ? ORDER BY id", (app_row["id"],)).fetchall()
            history = cur.execute(
                "SELECT id, role, progress, outcome, applied_date, feedback FROM applications "
                "WHERE LOWER(company) = LOWER(?) AND id != ?", (app_row["company"], app_row["id"])).fetchall()
            guide = cur.execute("SELECT guide_json, user_notes, planned_rounds_json FROM prep_guides "
                                "WHERE app_id = ?", (app_row["id"],)).fetchone()
            out.append({"job_id": j["id"], "queued_at": j["created_at"],
                        "request": _loads(j["payload_json"], {}), "application": app_row,
                        "posting": src, "rounds_so_far": rounds, "other_applications_here": history,
                        "existing": guide})
        return jsonify(out)
    finally:
        conn.close()


@app.route('/api/prep/dossier/<int:app_id>', methods=['POST'])
def save_dossier(app_id):
    """Agent writes the dossier. Body: {"guide": {...}} - must carry jd_overview and
    company_overview; stage and generated_at are stamped here."""
    guide = (request.get_json(silent=True) or {}).get("guide")
    if not isinstance(guide, dict) or not guide.get("company_overview") or not guide.get("jd_overview"):
        return jsonify({"error": "guide with jd_overview and company_overview is required"}), 400
    conn = get_db()
    try:
        cur = conn.cursor()
        a = cur.execute("SELECT id, company, role, progress FROM applications WHERE id = ?", (app_id,)).fetchone()
        if not a:
            return jsonify({"error": "Application not found"}), 404
        guide["stage"] = a["progress"]
        guide["generated_at"] = _prep_now()
        now = _prep_now()
        cur.execute("""INSERT INTO prep_guides (app_id, company_name, role_title, guide_json, updated_at, last_refreshed_at)
                       VALUES (?,?,?,?,?,?)
                       ON CONFLICT(app_id) DO UPDATE SET guide_json=excluded.guide_json,
                           updated_at=excluded.updated_at, last_refreshed_at=excluded.last_refreshed_at""",
                    (app_id, a["company"], a["role"], json.dumps(guide, ensure_ascii=False), now, now))
        _finish_jobs(cur, "role_dossier", "role_job_id = ?", (app_id,), {"app_id": app_id, "stage": a["progress"]})
        conn.commit()
        return jsonify({"success": True, "stage": a["progress"]})
    finally:
        conn.close()


@app.route('/api/prep/dossier/<int:app_id>/request', methods=['POST'])
def request_dossier(app_id):
    """Manual 'Refresh' on a role: queue a rewrite now, whatever the stage."""
    conn = get_db()
    try:
        cur = conn.cursor()
        a = cur.execute("SELECT id, company, role, progress FROM applications WHERE id = ?", (app_id,)).fetchone()
        if not a:
            return jsonify({"error": "Application not found"}), 404
        queued = enqueue_dossier_job(cur, a, "manual refresh")
        conn.commit()
        return jsonify({"success": True, "queued": queued, "already_queued": not queued})
    finally:
        conn.close()


if __name__ == '__main__':
    init_sqlite_db()
    threading.Thread(target=_gdrive_sync_worker, daemon=True).start()
    if telemetry:
        try:
            telemetry.start_background_telemetry(get_db, get_today_tokens, interval_sec=60)
        except Exception:
            pass
    start_fit_worker()
    PORT = int(os.environ.get("BOARD_PORT", 5050))
    app.run(host='0.0.0.0', port=PORT, debug=False, use_reloader=False, threaded=True)