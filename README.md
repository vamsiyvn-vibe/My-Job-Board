# PM Job Board & Interview Prep Cockpit

A local-first Flask + vanilla JS web application for sourcing Product Management roles, tracking applications, and practicing structured interview delivery.

## Core Capabilities
- **Job Sourcing & Pipeline Board**: Filter, search, star, and track open roles with custom evaluation scoring, company cohorts, and application status tracking.
- **Streamlined 5-Tab Prep Hub**:
  - **Overview** — Unified status cockpit and async AI job queue indicator.
  - **My Roles** — Per-role interview prep dossiers and targeted practice questions.
  - **Performance** — Interview evaluation history and longitudinal coaching insights.
  - **Practice Gym** — Category-based timed & untimed audio/transcript practice across:
    - **Hiring Manager** (`120s` default cap with live `H-C-T-R` pacing rail)
    - **Recruiter** (`90s` default cap + standard quick drills)
    - **Product Sense** (`No Limit` stopwatch mode)
    - **Execution & Analytical** (`No Limit` stopwatch mode)
    - **Leadership & Drive** (`120s` default cap)
    - **STAR Story Bank** (searchable reference cards with 1-click timed drill)
  - **Question Bank** — Filterable question log with 1-click jump into Practice Gym.
- **PWA & Theme Support**: Responsive light/dark UI with service worker and installable manifest.

## Quick Start

```bash
pip install -r requirements.txt
cp board/config.example.json board/config.json
python board/server.py
```

Then open **http://127.0.0.1:5050** in your browser.

### Optional Environment Variables
| Variable | Description |
| :--- | :--- |
| `PM_BOARD_DATA_DIR` | Directory where `board.db` and uploaded practice audio are stored (defaults to `board/data/`). |
| `PM_BOARD_DB_PATH` | Explicit path to SQLite database file. |
| `PM_BOARD_MIN_BASE_SALARY` | Optional integer minimum base salary threshold for criteria checks (default `0` / disabled). |

## Architecture
- **Backend**: `board/server.py` (Python / Flask + SQLite auto-initialized on first boot)
- **Job Crawler**: `scripts/check_new_jobs.py` (live Greenhouse, Lever, Ashby, Workday & custom career-portal scanner triggered from the UI or CLI)
- **Frontend**: `board/index.html`, `board/app.js`, `board/styles.css` (zero build step)
- **CI/CD**: `.gitlab-ci.yml` runs Python syntax checks, Flask route smoke tests, and Node JS syntax validation on every Merge Request.

> **Privacy Note**: Personal data (databases, resumes, interview transcripts, rubrics, and API keys) are excluded via `.gitignore` and never stored in this repository.
