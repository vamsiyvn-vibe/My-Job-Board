// Global auth guard: if any API call comes back 401 (session expired), bounce to login.
(function () {
    const _fetch = window.fetch;
    window.fetch = function (...args) {
        return _fetch.apply(this, args).then((res) => {
            if (res && res.status === 401 && !location.pathname.startsWith('/login')) {
                window.location.href = '/login';
            }
            return res;
        });
    };
})();

// ---------------------------------------------------------------------------
// JOB LEVEL CLASSIFIER  (single source of truth)
//
// Replaces three separate, mutually-inconsistent keyword lists that previously lived in
// the Sourcing filter, the Insights filter and the Insights chart (they disagreed - e.g.
// "Principal" counted as Dir+ in Insights but Mid on the Sourcing Board).
//
// Two deliberate improvements over both the old logic and the upstream source's own
// `job_level` field:
//   1. WORD-BOUNDARY matching, not substring. The old `title.includes('vp')` tagged
//      "Product Manager for ERP..." as Dir+, and `includes('lead')` caught "Leader".
//      Positional patterns also stop "Lead Generation" / "Group Benefits" (domains)
//      from reading as seniority.
//   2. A distinct senior-IC tier, shown in the UI as "Principal". NewPMJobs collapses
//      Principal / Staff / Group / Lead into one "mid" bucket that is 55% of all postings,
//      which hides exactly the level being targeted. Splitting it out separates
//      Principal/Group/Staff PM (~15+ yrs) from Senior PM (~5-8 yrs).
//
// Precedence is strict: dir > seniorIC > mid > early, so "Senior Director" is Dir+ and
// "Senior Principal PM" is Principal. The internal key stays `seniorIC`; the display
// label is "Principal".
// ---------------------------------------------------------------------------
const JOB_LEVEL_PATTERNS = {
    dir: [
        /\bchief\b/, /\bcpo\b/,
        /\b(svp|evp|avp)\b/, /\bvp\b/, /\bvice\s+president\b/,
        /\bdirector\b/,
        /\bhead\s+of\b/, /\bhead\s*,/, /\bproduct\s+head\b/,
        /\bgeneral\s+manager\b/
    ],
    seniorIC: [
        /\bprincipal\b/, /\bdistinguished\b/, /\bfellow\b/, /\bstaff\b/,
        // "Group" is only a seniority marker when it leads the title ("Group AI Product
        // Manager") or directly qualifies product. Mid-title it is usually a business unit
        // ("Private Equity Group - Product Owner"), which must stay Early.
        /^\s*group\b/, /\bgroup\s+product\b/, /\bgpm\b/,
        // Likewise "Lead": positional only, so "Product Manager, Lead Generation" (a domain)
        // does not read as seniority, while "Product Manager Lead" does.
        /\blead\s+product\b/, /\bproduct\s+lead\b/, /\blead\s+pm\b/, /^\s*lead\b/,
        /\bmanager\s+lead\b/, /\bproduct\s+(management\s+)?leader\b/
    ],
    // "sr" as a whole word also catches the "Sr." abbreviation, which the upstream source
    // mishandles - it files ~77 "Sr Product Manager" roles under `early`.
    mid: [/\bsenior\b/, /\bsnr\b/, /\bsr\b/]
};

// Company groups (Mag 7, AI Labs, High Growth) come from company_groups.json via
// /api/company-groups, so the pills and the worker's 120B scoring priority read one
// roster. A second copy here would drift, and a drifted roster silently changes which
// roles get the expensive score.
//
// Matching is on the WHOLE normalised name, never a substring: the board contains
// "LiveRamp" and "Mrbeastyoutube", which substring matching files under Ramp and Alphabet.
function loadCompanyGroups() {
    return fetch('/api/company-groups')
        .then(r => r.json())
        .then(groups => { state.companyGroups = groups || {}; })
        .catch(() => { state.companyGroups = {}; });
}

function matchesMag7(companyName, selection) {
    const name = String(companyName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name) return false;
    const groups = state.companyGroups || {};

    // A group key ("mag7" / "ai_labs" / "high_growth") -> any member matches.
    if (groups[selection]) {
        return Object.values(groups[selection].members || {})
            .some(aliases => aliases.includes(name));
    }
    // Otherwise it's a single company pill; find it inside whichever group defines it.
    for (const group of Object.values(groups)) {
        const aliases = (group.members || {})[selection];
        if (aliases) return aliases.includes(name);
    }
    // Roster unavailable (fetch failed): fall back to matching the pill's own label so the
    // filter degrades to "exact company name" rather than silently matching nothing.
    return name === selection.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function classifyJobLevel(title) {
    const t = " " + String(title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (JOB_LEVEL_PATTERNS.dir.some(re => re.test(t))) return 'dir';
    if (JOB_LEVEL_PATTERNS.seniorIC.some(re => re.test(t))) return 'seniorIC';
    if (JOB_LEVEL_PATTERNS.mid.some(re => re.test(t))) return 'mid';
    return 'early';
}

// Date Posted filter, shared by the Sourcing Board and Market Insights so the two tabs
// can't drift apart. Filters on first_seen_at - when the job first appeared on the board,
// which is our best available proxy for a posting date (the source carries no true one).
//
// `value` is either:
//   'all'          -> no filtering
//   a days-back number ('0' = today only, '7' = last 7 days)
//   an exact 'YYYY-MM-DD' -> set by clicking the "New since last scan" badge
function applyDatePostedFilter(jobs, value) {
    if (!value || value === 'all') return jobs;

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return jobs.filter(j => (j.first_seen_at || '').substring(0, 10) === value);
    }
    const days = parseInt(value, 10);
    if (isNaN(days)) return jobs;

    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - days);
    return jobs.filter(j => {
        const fs = (j.first_seen_at || '').substring(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fs)) return false; // exclude 'N/A' / blanks
        return new Date(fs + 'T00:00:00') >= cutoff;
    });
}

// Does a job pass the four seniority toggles? `f` is state or state.insightsFilters.
// Suffixes of the state flags the seniority filter reads (state.seniorityEarly etc.).
// Kept in one place so the pills, the reset and the filter cannot drift apart.
const SENIORITY_KEYS = ['Early', 'Mid', 'SeniorIC', 'Dir'];

// Paint one pill set from a filter object (state, or state.insightsFilters). "All" lights up
// only when every level is on, so the control always tells you the truth about what it shows.
function paintSeniorityPills(wrapId, f) {
    const wrap = document.getElementById(wrapId);
    if (!wrap || !f) return;
    const allOn = SENIORITY_KEYS.every(k => f['seniority' + k] !== false);
    wrap.querySelectorAll('.sen-pill').forEach(p => {
        const key = p.getAttribute('data-sen');
        const active = key === 'all' ? allOn : (!allOn && f['seniority' + key] !== false);
        p.classList.toggle('active', active);
    });
}

// Keeps both boards' pills in sync with their respective filter state.
function syncSeniorityPills() {
    paintSeniorityPills('seniority-pills', state);
    paintSeniorityPills('insights-seniority-pills', state.insightsFilters);
    paintSeniorityPills('insights-intake-seniority-pills', state.insightsFilters);
}

function passesSeniorityFilter(job, f) {
    const lvl = classifyJobLevel(job.title);
    if (lvl === 'early') return f.seniorityEarly !== false;
    if (lvl === 'mid') return f.seniorityMid !== false;
    if (lvl === 'seniorIC') return f.senioritySeniorIC !== false;
    return f.seniorityDir !== false;
}

// State Management
let state = {
    activeTab: 'sourcing', // sourcing, pipeline, resumes, prep, connections, profile
    allJobs: [],
    profile: {
        name: '',
        email: '',
        phone: '',
        location: '',
        linkedin: '',
        summary: '',
        locations: [],
        keywords: [],
        seniority_levels: [],
        expected_comp: '',
        canonical_resume: '',
        contributions_bank: [],
        education: [],
        onboarded: 0
    },
    trackedCompanies: [],
    connections: [],
    selectedJob: null,
    
    // View Filters for Sourcing
    currentLayout: 'list',
    companyGroups: {},        // filled from /api/company-groups (see loadCompanyGroups)
    selectedMag7: 'all',
    selectedIndustry: 'all',
    selectedMinComp: 'all',
    selectedExpFit: 'all',
    selectedCritFit: 'all',
    selectedRec: 'all',
    selectedDatePosted: 'all',
    appFilterMethod: 'all',
    appFilterReferral: 'all',
    appFilterProgress: 'all',
    appFilterOutcome: 'all',
    appFilterSearch: '',
    appInsightsGrain: 'week',  // Application Insights trend granularity: 'week' | 'month'
    appCharts: {},             // Chart.js instances for the Application Insights panel
    appStatCard: null,   // which stat card (if any) is filtering the table
    consideration: [],   // Under Consideration rows (agentic apply queue)
    selectedCompany: 'all',
    selectedSort: 'recommended_desc',
    sourceNewPMJobs: true, // filter by source: NewPMJobs
    sourceCompanyScraper: true, // filter by source: Individual Company Scrapers
    hideActioned: true,    // default ON: actioned roles are hidden from triage until unchecked
    showOnlyActioned: false, // set by clicking the Actioned stat card / "Show actioned only"
    showOnlyNA: false,     // set by clicking the N/A badge; shows only experience_fit === -2
    // Authoritative "actioned" lookups, rebuilt from the SAME data the Under Consideration
    // tab (apply_requests, by job_id) and the Applications pipeline (applications, by
    // company+role) render from — so the board's stars/actioned filter agree with them.
    _actionedIds: new Set(),   // job_ids currently in Under Consideration
    _appKeys: new Set(),       // "companyrole" keys currently in the Applications pipeline
    _actionedLoaded: false,    // false until Under Consideration has loaded at least once
    ucSort: { key: null, dir: 1 },  // Under Consideration column sort (null = server order)
    appSort: { key: null, dir: 1 }, // Application & Interview Pipeline sort: null (default: outcome rank, then company), or { key, dir }
    searchQuery: '',
    
    // Insights Tab Filters & Charts State
    insightsFilters: {
        searchQuery: '',
        seniorityEarly: true,
        seniorityMid: true,
        senioritySeniorIC: true,
        seniorityDir: true,
        selectedDatePosted: 'all',
        selectedRegion: 'all',
        selectedIndustry: 'all',
        selectedMinComp: 'all',
        selectedCompany: 'all'
    },
    insightsCharts: {},
    allJobsWithArchived: null,
    _intakeJobsPromise: null,
    insightsIntakeGrain: 'week',
    insightsIntakeWindowByGrain: { day: '30', week: 'all', month: 'all' },
    
    // Checkboxes for seniority
    seniorityEarly: true,
    seniorityMid: true,
    senioritySeniorIC: true,
    seniorityDir: true,
    
    // Connections search
    connSearchQuery: '',
    
    // Company table sorting
    companySortKey: 'company',
    companySortDir: 'asc',
    
    // Scanning state
    isScanning: false,
    pollInterval: null
};

// API Base URL
const API_BASE = '';

// DOM Elements
const elements = {
    // Navigation & Tabs
    navItems: document.querySelectorAll('.nav-menu .nav-item'),
    tabViews: document.querySelectorAll('.tab-view'),
    badgeLeads: document.getElementById('badge-leads'),
    badgePipeline: document.getElementById('badge-pipeline'),
    badgeConnections: document.getElementById('badge-connections'),
    lastScannedTime: document.getElementById('last-scanned-time'),
    btnScan: document.getElementById('btn-scan'),
    scanIcon: document.getElementById('scan-icon'),
    viewTitle: document.getElementById('view-title'),
    viewDesc: document.getElementById('view-desc'),
    syncBanner: document.getElementById('sync-banner'),
    
    // Insights Controls & Stats
    insightsSearchInput: document.getElementById('insights-search-input'),
    insightsClearSearch: document.getElementById('insights-clear-search'),
    insightsSeniorityPills: document.getElementById('insights-seniority-pills'),
    insightsRegionFilters: document.getElementById('insights-region-filters'),
    insightsIndustryFilters: document.getElementById('insights-industry-filters'),
    insightsCompFilters: document.getElementById('insights-comp-filters'),
    insightsExpfitFilters: document.getElementById('insights-expfit-filters'),
    insightsCritfitFilters: document.getElementById('insights-critfit-filters'),
    insightsRecFilters: document.getElementById('insights-rec-filters'),
    insightsDatePostedFilters: document.getElementById('insights-dateposted-filters'),
    insightsCompanyFilter: document.getElementById('insights-company-filter'),
    
    insightsStatTotal: document.getElementById('insights-stat-total'),
    insightsStatTopco: document.getElementById('insights-stat-topco'),
    insightsStatDirshare: document.getElementById('insights-stat-dirshare'),
    insightsStatHighfit: document.getElementById('insights-stat-highfit'),
    
    // Controls Section
    dashboardControls: document.getElementById('dashboard-controls'),
    sourcingResultsBar: document.getElementById('sourcing-results-bar'),
    sourcingCountText: document.getElementById('sourcing-count-text'),
    sourcingSubcountText: document.getElementById('sourcing-subcount-text'),
    searchInput: document.getElementById('search-input'),
    clearSearch: document.getElementById('clear-search'),
    
    seniorityPills: document.getElementById('seniority-pills'),
    
    mag7Filters: document.getElementById('mag7-filters'),
    industryFilters: document.getElementById('industry-filters'),
    compFilters: document.getElementById('comp-filters'),
    companyFilter: document.getElementById('company-filter'),
    btnResetCompanyFilter: document.getElementById('btn-reset-company-filter'),
    sortFilter: document.getElementById('sort-filter'),
    chkSourceNewPMJobs: document.getElementById('chk-source-newpmjobs'),
    chkSourceScraper: document.getElementById('chk-source-scraper'),
    chkTopSourceNewPMJobs: document.getElementById('chk-top-source-newpmjobs'),
    chkTopSourceScraper: document.getElementById('chk-top-source-scraper'),
    chkHideActioned: document.getElementById('chk-hide-actioned'),
    chkShowActionedOnly: document.getElementById('chk-show-actioned-only'),
    
    viewCardsBtn: document.getElementById('view-cards-btn'),
    viewListBtn: document.getElementById('view-list-btn'),
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    
    // Sourcing View Panels
    jobsGrid: document.getElementById('jobs-grid'),
    jobsListWrapper: document.getElementById('jobs-list-wrapper'),
    jobsListBody: document.getElementById('jobs-list-body'),
    portalsSectionWrapper: document.getElementById('portals-section-wrapper'),
    portalsGrid: document.getElementById('portals-grid'),
    loadingState: document.getElementById('loading-state'),
    emptyState: document.getElementById('empty-state'),
    
    // Kanban Pipeline View Panels
    kanbanBoard: document.getElementById('kanban-board'),
    
    // Resume Builder Tab
    profileName: document.getElementById('profile-name'),
    profileEmail: document.getElementById('profile-email'),
    profilePhone: document.getElementById('profile-phone'),
    profileLocation: document.getElementById('profile-location'),
    profileLinkedin: document.getElementById('profile-linkedin'),
    profileSummary: document.getElementById('profile-summary'),
    educationList: document.getElementById('education-list'),
    btnAddEducation: document.getElementById('btn-add-education'),
    contributionsEditor: document.getElementById('contributions-editor'),
    btnAddContribution: document.getElementById('btn-add-contribution'),
    btnSaveProfile: document.getElementById('btn-save-profile'),
    
    tailorSelectJob: document.getElementById('tailor-select-job'),
    tailorJobDetails: document.getElementById('tailor-job-details'),
    tailorJobTitle: document.getElementById('tailor-job-title'),
    tailorJobCompany: document.getElementById('tailor-job-company'),
    tailorJobDescSnippet: document.getElementById('tailor-job-desc-snippet'),
    tailorBulletsList: document.getElementById('tailor-bullets-list'),
    tailorFont: document.getElementById('tailor-font'),
    tailorFontSize: document.getElementById('tailor-fontsize'),
    tailorMargin: document.getElementById('tailor-margin'),
    btnGenerateTailored: document.getElementById('btn-generate-tailored'),
    tailoredResumeResult: document.getElementById('tailored-resume-result'),
    linkDownloadTailored: document.getElementById('link-download-tailored'),
    
    // Prep Hub Tab
    prepSelectCompany: document.getElementById('prep-select-company'),
    prepEmptyState: document.getElementById('prep-empty-state'),
    prepDetailsContainer: document.getElementById('prep-details-container'),
    prepRoleTitle: document.getElementById('prep-role-title'),
    prepRoleCompany: document.getElementById('prep-role-company'),
    prepRoleMeta: document.getElementById('prep-role-meta'),
    prepRoleStageBadge: document.getElementById('prep-role-stage-badge'),
    prepUpdatedTime: document.getElementById('prep-updated-time'),
    btnGeneratePrepGuide: document.getElementById('btn-generate-prep-guide'),
    btnGeneratePrepGuideHeader: document.getElementById('btn-generate-prep-guide-header'),
    prepInsightsTitle: document.getElementById('prep-insights-title'),
    prepInterviewSummary: document.getElementById('prep-interview-summary'),
    prepInterviewStages: document.getElementById('prep-interview-stages'),
    prepInterviewRubric: document.getElementById('prep-interview-rubric'),
    prepStrategicFocus: document.getElementById('prep-strategic-focus'),
    prepInterviewTips: document.getElementById('prep-interview-tips'),
    prepQuestionBank: document.getElementById('prep-question-bank'),
    prepNotes: document.getElementById('prep-notes'),
    btnSavePrepNotes: document.getElementById('btn-save-prep-notes'),
    
    // Connections Panel
    connectionsDropzone: document.getElementById('connections-dropzone'),
    connectionsFileInput: document.getElementById('connections-file-input'),
    btnClearConnections: document.getElementById('btn-clear-connections'),
    connStatTotal: document.getElementById('conn-stat-total'),
    connStatCompanies: document.getElementById('conn-stat-companies'),
    connSearchInput: document.getElementById('conn-search-input'),
    connectionsListBody: document.getElementById('connections-list-body'),
    
    // Profile & Search settings Form
    profileSettingsForm: document.getElementById('profile-settings-form'),
    profileLocationsSettings: document.getElementById('profile-locations-settings'),
    profileKeywordsSettings: document.getElementById('profile-keywords-settings'),
    profileCompSettings: document.getElementById('profile-comp-settings'),
    profileLlmKeySettings: document.getElementById('profile-llm-key-settings'),
    companiesListBody: document.getElementById('companies-list-body'),
    btnSaveProfileSettings: document.getElementById('btn-save-profile-settings'),
    btnShowAddCo: document.getElementById('btn-show-add-co'),
    
    // Company Add dialog
    addCompanyModal: document.getElementById('add-company-modal'),
    addCompanyClose: document.getElementById('add-company-close'),
    addCompanyCancel: document.getElementById('add-company-cancel'),
    addCompanyForm: document.getElementById('add-company-form'),
    newCoName: document.getElementById('new-co-name'),
    newCoCohort: document.getElementById('new-co-cohort'),
    newCoPortalUrl: document.getElementById('new-co-portal-url'),
    newCoLevelsGroup: document.getElementById('new-co-levels-group'),
    
    // Job Detail Dialog
    jobModal: document.getElementById('job-modal'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    modalCohort: document.getElementById('modal-cohort'),
    modalDate: document.getElementById('modal-date'),
    modalRoleTitle: document.getElementById('modal-role-title'),
    modalCompany: document.getElementById('modal-company'),
    modalLocText: document.getElementById('modal-loc-text'),
    modalTabs: document.querySelectorAll('.modal-tab'),
    tabPanes: document.querySelectorAll('.tab-pane'),
    descLoader: document.getElementById('desc-loader'),
    modalDescContent: document.getElementById('modal-desc-content'),
    modalInterviewSummary: document.getElementById('modal-interview-summary'),
    modalInterviewStages: document.getElementById('modal-interview-stages'),
    modalInterviewTips: document.getElementById('modal-interview-tips'),
    compHq: document.getElementById('comp-hq'),
    compFounded: document.getElementById('comp-founded'),
    compRevenue: document.getElementById('comp-revenue'),
    compEmployees: document.getElementById('comp-employees'),
    compDomain: document.getElementById('comp-domain'),
    modalTabTracking: document.getElementById('modal-tab-tracking'),
    jobTrackingForm: document.getElementById('job-tracking-form'),
    trackStatus: document.getElementById('track-status'),
    trackOutcome: document.getElementById('track-outcome'),
    trackResume: document.getElementById('track-resume'),
    btnViewResume: document.getElementById('btn-view-resume'),
    modalTabReferrals: document.getElementById('modal-tab-referrals'),
    referralsListBody: document.getElementById('referrals-list-body'),
    referralMessageDraft: document.getElementById('referral-message-draft'),
    btnCopyReferral: document.getElementById('btn-copy-referral'),
    modalJobLink: document.getElementById('modal-job-link'),
    modalFooterActions: document.getElementById('modal-footer-actions'),
    toastContainer: document.getElementById('toast-container'),
    
    // Onboarding wizard modal
    onboardingModal: document.getElementById('onboarding-modal'),
    onboardLocations: document.getElementById('onboard-locations'),
    onboardKeywords: document.getElementById('onboard-keywords'),
    onboardComp: document.getElementById('onboard-comp'),
    onboardName: document.getElementById('onboard-name'),
    onboardEmail: document.getElementById('onboard-email'),
    onboardPhone: document.getElementById('onboard-phone'),
    onboardLocation: document.getElementById('onboard-location'),
    onboardLinkedin: document.getElementById('onboard-linkedin'),
    onboardSummary: document.getElementById('onboard-summary'),
    onboardResumeText: document.getElementById('onboard-resume-text'),
    onboardContributionsList: document.getElementById('onboard-contributions-list'),
    onboardLlmKey: document.getElementById('onboard-llm-key'),
    btnOnboardPrev: document.getElementById('btn-onboard-prev'),
    btnOnboardNext: document.getElementById('btn-onboard-next'),
    btnOnboardFinish: document.getElementById('btn-onboard-finish')
};

// Load saved theme preference immediately to avoid flash of unstyled content
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light') {
    document.documentElement.classList.add('light-theme');
}

let onboardingStep = 1;

// Initialize Application

document.addEventListener('DOMContentLoaded', () => {
    fetchProfile().then(() => {
        fetchJobs();
        fetchCompanies();
        fetchConnections();
        fetchApplications();
        fetchConsideration();
        if (state.profile.onboarded === 0) {
            showOnboardingWizard();
        }
    });
    // Each of these is isolated so a failure in one can't silently disable the others -
    // that is exactly how every Market Insights filter ended up dead (a TypeError partway
    // through setupEventListeners aborted it before the Insights listeners were attached).
    [setupEventListeners, startFitProgressPolling, refreshPasswordStatus, refreshParityAudit,
     loadApplicationAnswers, loadCompanyGroups, syncSeniorityPills]
        .forEach(fn => {
            try { fn(); } catch (err) { console.error(`${fn.name} failed:`, err); }
        });
});

// Shows the result of the crawler's source-parity self-audit. Green when the board matches
// the upstream feed; amber when eligible source jobs are missing (which means a crawler bug,
// since a completed scan should have ingested them).
function refreshParityAudit() {
    fetch('/api/scan-audit').then(r => r.json()).then((a) => {
        const box = document.getElementById('parity-audit-banner');
        const txt = document.getElementById('parity-audit-text');
        const icon = document.getElementById('parity-audit-icon');
        const btn = document.getElementById('parity-audit-details');
        if (!box || !a || !a.available) return;

        box.style.display = 'flex';

        // Check if the latest scan encountered a failure pulling from source
        if (a.status === 'error' || a.error_message) {
            box.style.background = 'rgba(239, 68, 68, 0.12)';
            box.style.border = '1px solid rgba(239, 68, 68, 0.4)';
            box.style.color = '#ef4444';
            icon.className = 'fa-solid fa-circle-exclamation';
            txt.textContent = `Source check failed (${a.ran_at}): Unable to pull new jobs from source — ${a.error_message || 'Unknown crawler error'}.`;
            box.title = `Crawler Error: ${a.error_message || 'Unknown error'}`;
            btn.style.display = 'inline-block';
            btn.textContent = 'Error Details';
            btn.onclick = () => {
                alert(`CRAWLER SYNC ERROR\nTime: ${a.ran_at}\n\nError: ${a.error_message}\n\nThe crawler could not pull the latest listings from the source. Please check network connectivity or authentication tokens.`);
            };
            return;
        }

        const missing = a.missing_count || 0;
        if (missing === 0) {
            box.style.background = 'rgba(16,185,129,0.08)';
            box.style.border = '1px solid rgba(16,185,129,0.3)';
            box.style.color = '#10b981';
            icon.className = 'fa-solid fa-circle-check';
            // Report the DEDUPLICATED counts. Raw row counts differ on each side purely
            // because the same requisition can be listed at several locations, which made
            // the banner look like it disagreed with the board's own job count.
            const srcD = a.source_eligible_distinct || a.source_eligible;
            const brdD = a.board_active_distinct || a.board_active;
            txt.textContent = `Source check (${a.ran_at}): in sync with NewPMJobs — `
                + `${srcD} distinct eligible jobs, none missing.`;
            box.title = `Source: ${a.source_eligible} eligible listings → ${srcD} distinct jobs.\n`
                + `Board: ${a.board_active} rows → ${brdD} distinct jobs.\n`
                + `Row counts differ because the same role can be listed at multiple locations.`;
            btn.style.display = 'none';
        } else {
            box.style.background = 'rgba(245,158,11,0.10)';
            box.style.border = '1px solid rgba(245,158,11,0.35)';
            box.style.color = '#f59e0b';
            icon.className = 'fa-solid fa-triangle-exclamation';
            txt.textContent = `Source check (${a.ran_at}): ${missing} eligible job`
                + `${missing === 1 ? '' : 's'} on NewPMJobs ${missing === 1 ? 'is' : 'are'} missing from the board.`;
            btn.style.display = 'inline-block';
            btn.textContent = 'Details';
            btn.onclick = () => {
                const rows = (a.missing_sample || []).map(m =>
                    `• ${m.company} — ${m.title}\n     ${m.location}`).join('\n');
                alert(`Missing from the board (${missing} total`
                    + `${missing > (a.missing_sample || []).length ? `, showing first ${(a.missing_sample || []).length}` : ''}):\n\n${rows}`);
            };
        }
    }).catch(() => {});
}

// --- APPLICATION ANSWER BANK ----------------------------------------------------
// Every field carries data-ans="section.key", so the form maps to the API without a
// hand-maintained field list — adding a field to the HTML is enough.
function collectAnswersForm() {
    const payload = {};
    document.querySelectorAll('[data-ans]').forEach(el => {
        const [sec, key] = el.getAttribute('data-ans').split('.');
        if (!sec || !key) return;
        (payload[sec] = payload[sec] || {})[key] =
            el.type === 'number' ? (parseInt(el.value, 10) || 0) : el.value;
    });
    return payload;
}

function paintAnswersStatus(complete, missing) {
    const badge = document.getElementById('answers-status');
    if (!badge) return;
    if (complete) {
        badge.textContent = 'Ready';
        badge.className = 'answers-status ok';
        badge.title = 'The agent has everything it needs to fill an application.';
    } else {
        badge.textContent = `${missing.length} still needed`;
        badge.className = 'answers-status warn';
        badge.title = 'Missing: ' + missing.join(', ');
    }
}

function loadApplicationAnswers() {
    return fetch('/api/application-answers')
        .then(r => r.json())
        .then(d => {
            if (!d || !d.answers) return;
            document.querySelectorAll('[data-ans]').forEach(el => {
                const [sec, key] = el.getAttribute('data-ans').split('.');
                const v = (d.answers[sec] || {})[key];
                if (v !== undefined && v !== null) el.value = v;
            });
            paintAnswersStatus(d.complete, d.missing || []);
        })
        .catch(() => {});
}

function saveApplicationAnswers() {
    const fb = document.getElementById('answers-feedback');
    if (fb) { fb.textContent = 'Saving…'; fb.className = 'answers-feedback'; }
    fetch('/api/application-answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectAnswersForm())
    })
        .then(r => r.json())
        .then(d => {
            if (d.success) {
                if (fb) { fb.textContent = '✓ Saved'; fb.className = 'answers-feedback ok'; }
                paintAnswersStatus(d.complete, d.missing || []);
            } else if (fb) {
                fb.textContent = d.error || 'Could not save'; fb.className = 'answers-feedback err';
            }
        })
        .catch(() => { if (fb) { fb.textContent = 'Network error'; fb.className = 'answers-feedback err'; } });
}

function refreshPasswordStatus() {
    fetch('/api/auth-status').then(r => r.json()).then((s) => {
        const line = document.getElementById('pw-status-line');
        if (!line) return;
        line.textContent = s.password_set
            ? '🔒 A password is currently set — required from phones and other devices.'
            : '🔓 No password set — the board is open to anyone who can reach this machine.';
        line.style.color = s.password_set ? '#10b981' : '#f59e0b';
    }).catch(() => {});
}

// --- FIT-SCORING BACKFILL PROGRESS ---
// The auto-throttle worker scores jobs over days; this polls its status so the user can
// see progress and know it's alive (and paused when the daily budget is hit).
function startFitProgressPolling() {
    updateFitProgress();
    setInterval(updateFitProgress, 20000); // every 20s
}

function updateFitProgress() {
    fetch('/api/jobs/fit-status')
        .then(res => res.json())
        .then(s => {
            // Single source of truth: the top "AI Fit Evaluation Progress" banner used to be
            // computed from the client-side state.allJobs snapshot, which only refreshes on a
            // re-render, so it drifted out of step with this live 20s poll while the worker
            // scored in the background. Cache the live figures and let the top banner use them
            // so both banners always show the same numbers.
            state.fitStatus = s;
            if (typeof updateScoringStatsBanner === 'function') updateScoringStatsBanner();

            const box = document.getElementById('fit-progress');
            const txt = document.getElementById('fit-progress-text');
            const fill = document.getElementById('fit-progress-fill');
            if (!box || !txt || !fill) return;

            // Keep the banner up while the worker is actively scoring OR re-scoring the
            // backlog (backlog jobs already count as "scored", so unscored can be 0 while
            // 120B work continues). Hide only when there's genuinely nothing happening.
            const workerBusy = s.worker && /scoring|re-scoring|yielding/i.test(s.worker.status || '');
            if (!s.configured || s.total === 0 || (s.unscored === 0 && !workerBusy)) {
                box.style.display = 'none';
                return;
            }

            box.style.display = 'flex';
            const pct = s.total ? Math.round((s.scored / s.total) * 100) : 0;
            fill.style.width = pct + '%';

            const budgetHit = (s.worker && /budget|cap/i.test(s.worker.status || ''));
            const statusText = budgetHit
                ? 'daily token cap reached — resumes as the window frees'
                : (s.worker && s.worker.status) || 'scoring';
            // Show the TRUE rolling-24h usage per model (what Groq's separate caps measure),
            // not the misleading calendar-day count. This is why a manual 120B re-score can
            // be refused even when "today" looks low. 20B and 120B are capped separately.
            let budgetStr = '';
            if (typeof s.tokens_120b_24h === 'number') {
                const k = n => Math.round(n / 1000) + 'K';
                const p120 = Math.round((s.tokens_120b_24h / (s.cap_120b || 200000)) * 100);
                budgetStr = ` · 120B 24h ${k(s.tokens_120b_24h)}/${k(s.cap_120b || 200000)} (${p120}%)`
                          + ` · 20B ${k(s.tokens_8b_24h || 0)}`;
            }
            txt.textContent = `Fit scoring: ${s.scored}/${s.total} (${pct}%) · ${statusText}${budgetStr}`;
        })
        .catch(() => {});
}

// Setup Event Listeners
// Null-safe addEventListener. The `elements` map is built once at load, so any entry whose
// markup has since been removed is null; calling .addEventListener on it throws and kills
// every listener registered after it. Use this for anything not guaranteed to exist.
function on(el, event, handler, opts) {
    if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(event, handler, opts);
        return true;
    }
    return false;
}

function setupEventListeners() {
    // Initialize theme icon and label based on current class
    const updateThemeUI = (isLight) => {
        if (!elements.themeToggleBtn) return;
        const icon = elements.themeToggleBtn.querySelector('i');
        const label = document.getElementById('theme-btn-label');
        if (isLight) {
            if (icon) icon.className = 'fa-solid fa-moon';
            if (label) label.textContent = 'Dark Mode';
            elements.themeToggleBtn.title = 'Switch to Dark Theme';
        } else {
            if (icon) icon.className = 'fa-solid fa-sun';
            if (label) label.textContent = 'Light Mode';
            elements.themeToggleBtn.title = 'Switch to Light Theme';
        }
    };

    updateThemeUI(document.documentElement.classList.contains('light-theme'));

    if (elements.themeToggleBtn) {
        elements.themeToggleBtn.addEventListener('click', () => {
            const isNowLight = document.documentElement.classList.toggle('light-theme');
            updateThemeUI(isNowLight);
            localStorage.setItem('theme', isNowLight ? 'light' : 'dark');
        });
    }

    // Navigation Tabs
    elements.navItems.forEach(item => {
        item.addEventListener('click', () => {
            elements.navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            
            const tabName = item.getAttribute('data-tab');
            state.activeTab = tabName;
            
            // Switch tabs visually
            elements.tabViews.forEach(view => {
                view.style.display = view.id === `view-${tabName}` ? 'block' : 'none';
            });
            if (tabName === 'pipeline' || tabName === 'resumes') {
                elements.tabViews.forEach(view => {
                    if (view.id === `view-${tabName}`) {
                        view.style.display = tabName === 'resumes' ? 'grid' : 'flex';
                    }
                });
            }
            
            updateViewHeader();
            renderActiveTab();
        });
    });

    // Run Daily Scan
    elements.btnScan.addEventListener('click', () => {
        if (state.isScanning) return;
        triggerCrawlerScan();
    });

    // Onboarding Wizard Nav
    elements.btnOnboardNext.addEventListener('click', () => {
        if (onboardingStep < 3) {
            document.getElementById(`pane-step-${onboardingStep}`).classList.remove('active');
            document.getElementById(`indicator-step-${onboardingStep}`).classList.remove('active');
            document.getElementById(`indicator-step-${onboardingStep}`).classList.add('completed');
            onboardingStep++;
            document.getElementById(`pane-step-${onboardingStep}`).classList.add('active');
            document.getElementById(`indicator-step-${onboardingStep}`).classList.add('active');
            elements.btnOnboardPrev.style.display = 'block';
            if (onboardingStep === 3) {
                elements.btnOnboardNext.style.display = 'none';
                elements.btnOnboardFinish.style.display = 'block';
            }
        }
    });

    elements.btnOnboardPrev.addEventListener('click', () => {
        if (onboardingStep > 1) {
            document.getElementById(`pane-step-${onboardingStep}`).classList.remove('active');
            document.getElementById(`indicator-step-${onboardingStep}`).classList.remove('active');
            onboardingStep--;
            document.getElementById(`pane-step-${onboardingStep}`).classList.add('active');
            document.getElementById(`indicator-step-${onboardingStep}`).classList.add('active');
            document.getElementById(`indicator-step-${onboardingStep}`).classList.remove('completed');
            elements.btnOnboardNext.style.display = 'block';
            elements.btnOnboardFinish.style.display = 'none';
            if (onboardingStep === 1) {
                elements.btnOnboardPrev.style.display = 'none';
            }
        }
    });

    elements.btnOnboardFinish.addEventListener('click', submitOnboarding);

    // Sourcing View Filtering
    elements.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim().toLowerCase();
        elements.clearSearch.style.display = state.searchQuery ? 'block' : 'none';
        renderSourcingTab();
    });
    
    elements.clearSearch.addEventListener('click', () => {
        elements.searchInput.value = '';
        state.searchQuery = '';
        elements.clearSearch.style.display = 'none';
        renderSourcingTab();
    });

    // Seniority pills. These replaced four checkboxes: seeing only Dir+ used to take three
    // separate unchecks, which is the wrong cost for the most common filter on the board.
    // Plain click = that level only. Ctrl/Cmd/Shift click = add or remove a level.
    on(elements.seniorityPills, 'click', (e) => {
        const pill = e.target.closest('.sen-pill');
        if (!pill) return;
        const key = pill.getAttribute('data-sen');
        const additive = e.ctrlKey || e.metaKey || e.shiftKey;

        if (key === 'all') {
            SENIORITY_KEYS.forEach(k => { state['seniority' + k] = true; });
        } else if (additive) {
            // Never let the user reach "nothing selected" — an empty board looks broken and
            // reads as a bug rather than a filter.
            const on_ = SENIORITY_KEYS.filter(k => state['seniority' + k] !== false);
            if (on_.length === 1 && on_[0] === key) return;
            state['seniority' + key] = state['seniority' + key] === false;
        } else {
            SENIORITY_KEYS.forEach(k => { state['seniority' + k] = (k === key); });
        }
        syncSeniorityPills();
        renderSourcingTab();
    });

    // "Actioned" stat card -> show only those roles. Answers "which 10 are they?" in place,
    // with each row's star and résumé state visible, rather than sending you to another tab
    // that would only hold the subset you have actually submitted.
    on(document.getElementById('stat-card-actioned'), 'click', () => {
        state.showOnlyActioned = !state.showOnlyActioned;
        if (state.showOnlyActioned) state.hideActioned = false;   // the two are contradictory
        if (elements.chkHideActioned) elements.chkHideActioned.checked = state.hideActioned;
        if (elements.chkShowActionedOnly) elements.chkShowActionedOnly.checked = state.showOnlyActioned;
        const card = document.getElementById('stat-card-actioned');
        if (card) card.classList.toggle('stat-card-on', state.showOnlyActioned);
        renderSourcingTab();
    });

    // Under Consideration sortable headers. Click cycles asc -> desc -> off (server order).
    on(document.getElementById('uc-header-row'), 'click', (e) => {
        const th = e.target.closest('.uc-sortable');
        if (!th) return;
        const key = th.getAttribute('data-sort');
        const s = state.ucSort;
        if (s.key !== key) { state.ucSort = { key, dir: 1 }; }
        else if (s.dir === 1) { state.ucSort = { key, dir: -1 }; }
        else { state.ucSort = { key: null, dir: 1 }; }   // third click clears
        updateUcSortIndicators();
        renderConsiderationTab();
    });

    // Application & Interview Pipeline sortable headers. Click cycles sort direction or clears to default.
    on(document.getElementById('apps-header-row'), 'click', (e) => {
        const th = e.target.closest('.apps-sortable');
        if (!th) return;
        const key = th.getAttribute('data-sort');
        const s = state.appSort || { key: null, dir: 1 };
        if (s.key !== key) {
            // Dates default to descending (newest first); text/progress/outcome default to ascending
            const defaultDir = (key === 'applied_date' || key === 'outcome_date') ? -1 : 1;
            state.appSort = { key, dir: defaultDir };
        } else if ((key === 'applied_date' || key === 'outcome_date') ? s.dir === -1 : s.dir === 1) {
            state.appSort = { key, dir: -s.dir };
        } else {
            state.appSort = { key: null, dir: 1 }; // third click clears back to default
        }
        updateAppsSortIndicators();
        renderApplicationsTab();
    });

    // Mag 7 & Lenny 100 company pills
    on(elements.mag7Filters, 'click', (e) => {
        const btn = e.target.closest('.pill');
        if (btn && elements.mag7Filters.contains(btn)) {
            elements.mag7Filters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            state.selectedMag7 = btn.getAttribute('data-mag7');
            renderSourcingTab();
        }
    });

    // Industry pills
    elements.industryFilters.addEventListener('click', (e) => {
        if (e.target.classList.contains('pill')) {
            elements.industryFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
            e.target.classList.add('active');
            state.selectedIndustry = e.target.getAttribute('data-industry');
            renderSourcingTab();
        }
    });

    // Comp filter: 'Any comp' button (default on load, includes unlisted comp) + $200K-$1M slider (upper-end comp)
    const compAnyBtn = document.getElementById('comp-any-btn');
    const compSlider = document.getElementById('comp-slider');
    const compSliderWrap = document.getElementById('comp-slider-wrap');
    const compSliderLabel = document.getElementById('comp-slider-label');

    const formatCompSliderVal = (valK) => {
        const k = parseInt(valK, 10);
        if (k >= 1000) return '$1M+ max comp';
        return `$${k}K+ max comp`;
    };

    const syncCompControlsUI = () => {
        const isAll = state.selectedMinComp === 'all';
        if (compAnyBtn) compAnyBtn.classList.toggle('active', isAll);
        if (compSliderWrap) {
            compSliderWrap.style.opacity = isAll ? '0.65' : '1';
            compSliderWrap.style.borderColor = isAll ? 'var(--border-color)' : 'var(--primary)';
        }
        if (compSliderLabel) {
            compSliderLabel.textContent = isAll ? 'All (incl. N/A)' : formatCompSliderVal(state.selectedMinComp);
            compSliderLabel.style.color = isAll ? 'var(--text-muted)' : 'var(--primary)';
        }
    };

    if (compAnyBtn) {
        compAnyBtn.addEventListener('click', () => {
            state.selectedMinComp = 'all';
            syncCompControlsUI();
            renderSourcingTab();
        });
    }
    if (compSlider) {
        const onSliderChange = (e) => {
            state.selectedMinComp = String(e.target.value);
            syncCompControlsUI();
            renderSourcingTab();
        };
        compSlider.addEventListener('input', onSliderChange);
        compSlider.addEventListener('change', onSliderChange);
        compSlider.addEventListener('mousedown', () => {
            if (state.selectedMinComp === 'all') {
                state.selectedMinComp = String(compSlider.value);
                syncCompControlsUI();
                renderSourcingTab();
            }
        });
    }

    // Source filter checkboxes (top filter grid + table header bar kept in sync)
    const syncSourceCheckboxes = () => {
        if (elements.chkSourceNewPMJobs) elements.chkSourceNewPMJobs.checked = state.sourceNewPMJobs;
        if (elements.chkTopSourceNewPMJobs) elements.chkTopSourceNewPMJobs.checked = state.sourceNewPMJobs;
        if (elements.chkSourceScraper) elements.chkSourceScraper.checked = state.sourceCompanyScraper;
        if (elements.chkTopSourceScraper) elements.chkTopSourceScraper.checked = state.sourceCompanyScraper;
    };
    [elements.chkSourceNewPMJobs, elements.chkTopSourceNewPMJobs].forEach(chk => {
        if (chk) {
            chk.addEventListener('change', (e) => {
                state.sourceNewPMJobs = e.target.checked;
                syncSourceCheckboxes();
                renderSourcingTab();
            });
        }
    });
    [elements.chkSourceScraper, elements.chkTopSourceScraper].forEach(chk => {
        if (chk) {
            chk.addEventListener('change', (e) => {
                state.sourceCompanyScraper = e.target.checked;
                syncSourceCheckboxes();
                renderSourcingTab();
            });
        }
    });

    // Hide already-actioned roles (starred, or tailored resume queued/created)
    if (elements.chkHideActioned) {
        elements.chkHideActioned.addEventListener('change', (e) => {
            state.hideActioned = e.target.checked;
            if (state.hideActioned && state.showOnlyActioned) {
                state.showOnlyActioned = false;   // can't show only these and hide them at once
                if (elements.chkShowActionedOnly) elements.chkShowActionedOnly.checked = false;
                const card = document.getElementById('stat-card-actioned');
                if (card) card.classList.remove('stat-card-on');
            }
            renderSourcingTab();
        });
    }

    // Show ONLY actioned roles (mirror of the Actioned stat card; inverse of Hide already-actioned)
    if (elements.chkShowActionedOnly) {
        elements.chkShowActionedOnly.addEventListener('change', (e) => {
            state.showOnlyActioned = e.target.checked;
            if (state.showOnlyActioned && state.hideActioned) {
                state.hideActioned = false;   // contradictory with hiding them
                if (elements.chkHideActioned) elements.chkHideActioned.checked = false;
            }
            const card = document.getElementById('stat-card-actioned');
            if (card) card.classList.toggle('stat-card-on', state.showOnlyActioned);
            renderSourcingTab();
        });
    }

    // Fit-score and Recommendation pills
    [['expfit-filters', 'data-expfit', 'selectedExpFit'],
     ['critfit-filters', 'data-critfit', 'selectedCritFit'],
     ['dateposted-filters', 'data-dateposted', 'selectedDatePosted'],
     ['rec-filters', 'data-rec', 'selectedRec']].forEach(([id, attr, key]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                el.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                state[key] = e.target.getAttribute(attr);
                renderSourcingTab();
            }
        });
    });

    // "New since last scan" badge → one-click filter to jobs from the most recent scan
    const newBadge = document.getElementById('badge-new-count');
    if (newBadge) {
        newBadge.addEventListener('click', () => {
            const scanDate = ((state.profile && state.profile.last_scanned_at) || '').substring(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDate)) return;
            state.selectedDatePosted = scanDate; // exact-date filter
            // Reflect on the Date Posted pills: light up "Today" when the scan was today.
            const now = new Date();
            const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            document.querySelectorAll('#dateposted-filters .pill').forEach(p => p.classList.remove('active'));
            if (scanDate === todayStr) {
                const todayPill = document.querySelector('#dateposted-filters .pill[data-dateposted="0"]');
                if (todayPill) todayPill.classList.add('active');
            }
            renderSourcingTab();
        });
    }

    // "N/A" badge → toggle filter to only N/A-verdict roles (experience_fit === -2)
    const naBadge = document.getElementById('badge-na-count');
    if (naBadge) {
        naBadge.addEventListener('click', () => {
            state.showOnlyNA = !state.showOnlyNA;
            naBadge.style.outline = state.showOnlyNA ? '2px solid currentColor' : 'none';
            renderSourcingTab();
        });
    }

    // Access password (mobile/remote gate)
    const setPwBtn = document.getElementById('btn-set-password');
    if (setPwBtn) {
        setPwBtn.addEventListener('click', async () => {
            const input = document.getElementById('access-password-input');
            const fb = document.getElementById('pw-feedback');
            const pw = (input.value || '').trim();
            if (pw.length < 6) {
                fb.style.color = '#ef4444';
                fb.textContent = 'Password must be at least 6 characters.';
                return;
            }
            fb.style.color = 'var(--text-secondary)';
            fb.textContent = 'Saving…';
            try {
                const res = await fetch('/api/set-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_password: pw })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.success) {
                    fb.style.color = '#10b981';
                    fb.textContent = '✓ Password set. It’s now required from other devices.';
                    input.value = '';
                    refreshPasswordStatus();
                } else {
                    fb.style.color = '#ef4444';
                    fb.textContent = data.error || 'Could not set password.';
                }
            } catch (e) {
                fb.style.color = '#ef4444';
                fb.textContent = 'Network error.';
            }
        });
    }

    // Company Filter dropdown
    if (elements.companyFilter) {
        elements.companyFilter.addEventListener('change', (e) => {
            state.selectedCompany = e.target.value;
            updateCompanyResetButton();
            renderSourcingTab();
        });
    }

    // Quick Reset Company Filter button
    if (elements.btnResetCompanyFilter) {
        elements.btnResetCompanyFilter.addEventListener('click', () => {
            state.selectedCompany = 'all';
            if (elements.companyFilter) elements.companyFilter.value = 'all';
            updateCompanyResetButton();
            renderSourcingTab();
        });
    }

    // Sort Filter dropdown (removed from the UI — sorting is via table column headers).
    // Guard in case the element is absent so wiring doesn't throw.
    if (elements.sortFilter) {
        elements.sortFilter.addEventListener('change', (e) => {
            state.selectedSort = e.target.value;
            renderSourcingTab();
        });
    }

    // Include closed jobs checkbox


    elements.viewCardsBtn.addEventListener('click', () => {
        elements.viewCardsBtn.classList.add('active');
        elements.viewListBtn.classList.remove('active');
        state.currentLayout = 'grid';
        renderSourcingTab();
    });

    elements.viewListBtn.addEventListener('click', () => {
        elements.viewListBtn.classList.add('active');
        elements.viewCardsBtn.classList.remove('active');
        state.currentLayout = 'list';
        renderSourcingTab();
    });

    // Profile Settings save
    elements.btnSaveProfileSettings.addEventListener('click', saveProfileSettings);
    
    // Add Company modal
    elements.btnShowAddCo.addEventListener('click', () => {
        elements.addCompanyModal.style.display = 'flex';
    });
    
    [elements.addCompanyClose, elements.addCompanyCancel].forEach(b => {
        b.addEventListener('click', () => {
            elements.addCompanyModal.style.display = 'none';
        });
    });

    // Edit Company modal
    const editCompanyModal = document.getElementById('edit-company-modal');
    [document.getElementById('edit-company-close'), document.getElementById('edit-company-cancel')].forEach(b => {
        if (b) b.addEventListener('click', () => { editCompanyModal.style.display = 'none'; });
    });
    const editCompanyForm = document.getElementById('edit-company-form');
    if (editCompanyForm) editCompanyForm.addEventListener('submit', saveEditedCompany);

    // Sortable company table headers
    document.querySelectorAll('.sortable-company-th').forEach(th => {
        th.addEventListener('click', () => sortCompaniesBy(th.dataset.col));
    });

    // Modal sub-tab toggle events
    const tabSingle = document.getElementById('tab-add-single');
    const tabIndustry = document.getElementById('tab-add-industry');
    const formSingle = document.getElementById('form-single-co');
    const formIndustry = document.getElementById('form-industry-co');
    const btnSaveCo = document.getElementById('btn-save-tracked-co');
    
    if (tabSingle && tabIndustry) {
        tabSingle.addEventListener('click', () => {
            tabSingle.classList.add('active');
            tabIndustry.classList.remove('active');
            tabSingle.style.borderBottom = '2px solid var(--primary)';
            tabSingle.style.color = 'var(--text-primary)';
            tabIndustry.style.borderBottom = '2px solid transparent';
            tabIndustry.style.color = 'var(--text-secondary)';
            
            formSingle.style.display = 'block';
            formIndustry.style.display = 'none';
            btnSaveCo.style.display = 'inline-block';
        });
        
        tabIndustry.addEventListener('click', () => {
            tabIndustry.classList.add('active');
            tabSingle.classList.remove('active');
            tabIndustry.style.borderBottom = '2px solid var(--primary)';
            tabIndustry.style.color = 'var(--text-primary)';
            tabSingle.style.borderBottom = '2px solid transparent';
            tabSingle.style.color = 'var(--text-secondary)';
            
            formSingle.style.display = 'none';
            formIndustry.style.display = 'block';
            btnSaveCo.style.display = 'none';
        });
    }
    
    // Bulk Industry Feed Addition
    const btnBulkAdd = document.getElementById('btn-bulk-add-industry');
    const selectBulkIndustry = document.getElementById('bulk-industry-select');
    if (btnBulkAdd && selectBulkIndustry) {
        btnBulkAdd.addEventListener('click', () => {
            const industry = selectBulkIndustry.value;
            if (!industry) return;
            
            btnBulkAdd.disabled = true;
            btnBulkAdd.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Adding Feeds...';
            
            fetch('/api/companies/bulk-industry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ industry })
            })
            .then(res => res.json())
            .then(data => {
                btnBulkAdd.disabled = false;
                btnBulkAdd.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Bulk Add Industry Feeds';
                                if (data.success) {
                    showToast(data.message);
                    elements.addCompanyModal.style.display = 'none';
                    fetchCompanies(); // Reload companies list
                } else {
                    showToast('Error: ' + data.error);
                }
            })
            .catch(() => {
                btnBulkAdd.disabled = false;
                btnBulkAdd.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Bulk Add Industry Feeds';
                showToast('Failed to connect to API.');
            });
        });
    }
    
    elements.addCompanyForm.addEventListener('submit', handleAddCompany);

    const addAppForm = document.getElementById('add-application-form');
    if (addAppForm) addAppForm.addEventListener('submit', submitNewApplication);

    const appFilterMethod = document.getElementById('app-filter-method');
    if (appFilterMethod) appFilterMethod.addEventListener('change', (e) => {
        state.appFilterMethod = e.target.value; renderApplicationsTab();
    });
    const appFilterReferral = document.getElementById('app-filter-referral');
    if (appFilterReferral) appFilterReferral.addEventListener('change', (e) => {
        state.appFilterReferral = e.target.value; renderApplicationsTab();
    });
    const appFilterProgress = document.getElementById('app-filter-progress');
    if (appFilterProgress) appFilterProgress.addEventListener('change', (e) => {
        state.appFilterProgress = e.target.value; renderApplicationsTab();
    });
    const appFilterOutcome = document.getElementById('app-filter-outcome');
    if (appFilterOutcome) appFilterOutcome.addEventListener('change', (e) => {
        state.appFilterOutcome = e.target.value; renderApplicationsTab();
    });
    const appFilterSearch = document.getElementById('app-filter-search');
    if (appFilterSearch) appFilterSearch.addEventListener('input', (e) => {
        state.appFilterSearch = e.target.value.trim(); renderApplicationsTab();
    });
    // Application Insights: weekly / monthly submission-trend toggle.
    on(document.getElementById('apps-grain-toggle'), 'click', (e) => {
        const btn = e.target.closest('.pill');
        if (!btn) return;
        state.appInsightsGrain = btn.getAttribute('data-grain');
        document.querySelectorAll('#apps-grain-toggle .pill').forEach(p =>
            p.classList.toggle('active', p === btn));
        renderApplicationInsights();
    });
    // Application Insights: the funnel-stage KPI cards act as one-click table filters.
    // Delegated because the cards are re-rendered on every insights refresh. Clicking the
    // selected card again clears it. Shares state.appStatCard with the top stat cards.
    const applyKpiCard = (card) => {
        const key = card.getAttribute('data-app-card');
        state.appStatCard = (state.appStatCard === key) ? null : key;
        renderApplicationsTab();
    };
    on(document.getElementById('apps-kpis'), 'click', (e) => {
        const card = e.target.closest('[data-app-card]');
        if (card) applyKpiCard(card);
    });
    on(document.getElementById('apps-kpis'), 'keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest('[data-app-card]');
        if (card) { e.preventDefault(); applyKpiCard(card); }
    });
    // Stat cards act as one-click filters. Clicking the selected card again clears it.
    document.querySelectorAll('#apps-stats .apps-stat[data-stat-card]').forEach(card => {
        const activate = () => {
            const key = card.getAttribute('data-stat-card');
            state.appStatCard = (state.appStatCard === key) ? null : key;
            renderApplicationsTab();
        };
        card.addEventListener('click', activate);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
    });

    // Referral-share cards drive the existing "Referral Type" dropdown, so the two controls
    // always agree. Clicking the selected card again clears the filter.
    document.querySelectorAll('#apps-stats .apps-stat[data-referral-card]').forEach(card => {
        const activate = () => {
            const value = card.getAttribute('data-referral-card');
            state.appFilterReferral = (state.appFilterReferral === value) ? 'all' : value;
            const dd = document.getElementById('app-filter-referral');
            if (dd) dd.value = state.appFilterReferral;   // keep the dropdown in sync
            renderApplicationsTab();
        };
        card.addEventListener('click', activate);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
    });

    // Application Answer Bank
    on(document.getElementById('btn-save-answers'), 'click', saveApplicationAnswers);

    // Under Consideration — build every queued résumé without waiting for the schedule.
    on(document.getElementById('btn-uc-build-all'), 'click', () => {
        const queued = (state.consideration || []).filter(r => !(r.resume_doc_url && r.brief_doc_url) && r.status !== 'Submitted');
        if (!queued.length) { showToast('Nothing waiting to be prepared.', 'info'); return; }
        Promise.all(queued.map(r => fetch(`/api/apply-requests/${r.id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Queued', error: '' })
        }))).then(() => {
            showToast(`${queued.length} role${queued.length === 1 ? '' : 's'} queued — ask Claude to "prepare the queued applications".`, 'success');
            fetchConsideration();
        }).catch(() => showToast('Could not queue all', 'error'));
    });

    const btnClearAppFilters = document.getElementById('btn-clear-app-filters');
    if (btnClearAppFilters) btnClearAppFilters.addEventListener('click', () => {
        state.appFilterMethod = 'all';
        state.appFilterReferral = 'all';
        state.appFilterProgress = 'all';
        state.appFilterOutcome = 'all';
        state.appFilterSearch = '';
        state.appStatCard = null;
        state.appSort = { key: null, dir: 1 };
        const m = document.getElementById('app-filter-method'); if (m) m.value = 'all';
        const r = document.getElementById('app-filter-referral'); if (r) r.value = 'all';
        const p = document.getElementById('app-filter-progress'); if (p) p.value = 'all';
        const o = document.getElementById('app-filter-outcome'); if (o) o.value = 'all';
        const s = document.getElementById('app-filter-search'); if (s) s.value = '';
        renderApplicationsTab();
    });

    // Job Modal actions
    elements.modalCloseBtn.addEventListener('click', () => {
        elements.jobModal.style.display = 'none';
        state.selectedJob = null;
    });

    // Modal Tabs routing
    elements.modalTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            elements.modalTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const targetPane = tab.getAttribute('data-tab');
            elements.tabPanes.forEach(pane => {
                pane.classList.toggle('active', pane.id === `pane-${targetPane}`);
            });
        });
    });

    // Job tracking update form
    elements.jobTrackingForm.addEventListener('submit', handleJobTrackingUpdate);

    // Copy referral button
    elements.btnCopyReferral.addEventListener('click', () => {
        elements.referralMessageDraft.select();
        document.execCommand('copy');
        showToast('Referral draft copied to clipboard!');
    });

    // Connections upload dropzone
    elements.connectionsDropzone.addEventListener('click', () => {
        elements.connectionsFileInput.click();
    });

    elements.connectionsFileInput.addEventListener('change', () => {
        const file = elements.connectionsFileInput.files[0];
        if (file) handleConnectionsCSVUpload(file);
    });

    elements.btnClearConnections.addEventListener('click', clearConnectionsNetwork);

    elements.connSearchInput.addEventListener('input', (e) => {
        state.connSearchQuery = e.target.value.trim().toLowerCase();
        renderConnectionsTab();
    });

    // Prep Hub integrations (guarded for elements)
    on(elements.prepSelectCompany, 'change', (e) => {
        const jobId = e.target.value;
        if (!jobId) {
            if (elements.prepEmptyState) elements.prepEmptyState.style.display = 'block';
            if (elements.prepDetailsContainer) elements.prepDetailsContainer.style.display = 'none';
            if (elements.btnGeneratePrepGuide) elements.btnGeneratePrepGuide.style.display = 'none';
            return;
        }
        loadPrepHubDetails(jobId);
    });

    on(elements.btnGeneratePrepGuide, 'click', () => {
        const jobId = elements.prepSelectCompany ? elements.prepSelectCompany.value : '';
        if (jobId) generateAiPrepGuide(jobId);
    });

    on(elements.btnGeneratePrepGuideHeader, 'click', () => {
        const jobId = elements.prepSelectCompany ? elements.prepSelectCompany.value : '';
        if (jobId) generateAiPrepGuide(jobId);
    });

    on(elements.btnSavePrepNotes, 'click', savePrepHubNotes);

    // Resume Profile / Tailor integration.
    // These belong to an older Profile & Tailor UI whose markup no longer exists, so the
    // lookups return null. They were UNGUARDED, and the first one threw a TypeError that
    // aborted the rest of this function - which silently killed
    // initInsightsEventListeners() below, leaving every Market Insights filter dead while
    // the Sourcing filters (registered earlier) still worked. Guarded via `on()`.
    on(elements.btnSaveProfile, 'click', saveCandidateProfile);
    on(elements.btnAddEducation, 'click', () => addEducationRow());
    on(elements.btnAddContribution, 'click', () => addContributionRow());
    on(elements.tailorSelectJob, 'change', handleTailorJobSelection);
    on(elements.btnGenerateTailored, 'click', generateTailoredResume);

    initInsightsEventListeners();
}

// Fetch Profile
function fetchProfile() {
    return fetch('/api/profile')
        .then(res => res.json())
        .then(data => {
            if (data.id) {
                state.profile = {
                    name: data.name || '',
                    email: data.email || '',
                    phone: data.phone || '',
                    location: data.location || '',
                    linkedin: data.linkedin || '',
                    summary: data.summary || '',
                    locations: JSON.loadsSafely(data.locations, []),
                    keywords: JSON.loadsSafely(data.keywords, []),
                    seniority_levels: JSON.loadsSafely(data.seniority_levels, []),
                    expected_comp: data.expected_comp || '',
                    canonical_resume: data.canonical_resume || '',
                    contributions_bank: JSON.loadsSafely(data.contributions_bank, []),
                    education: JSON.loadsSafely(data.education, []),
                    gemini_api_key: data.gemini_api_key || '',
                    llm_api_key: data.llm_api_key || '',
                    onboarded: data.onboarded || 0,
                    last_scanned_at: data.last_scanned_at || ''
                };
                if (elements.lastScannedTime) {
                    elements.lastScannedTime.innerText = data.last_scanned_at || 'July 20, 2026 08:00 AM';
                }
                // Repaint the "New since last scan" badge now that the scan date is known
                // (jobs may have loaded first, before profile resolved).
                if (typeof updateScoringStatsBanner === 'function') updateScoringStatsBanner();
            }
        });
}

// Render active tab panel
function renderActiveTab() {
    if (state.activeTab === 'sourcing') {
        renderSourcingTab();
    } else if (state.activeTab === 'insights') {
        renderInsightsTab();
    } else if (state.activeTab === 'pipeline') {
        renderPipelineTab();
    } else if (state.activeTab === 'resumes') {
        renderResumesTab();
    } else if (state.activeTab === 'prep') {
        renderPrepTab();
    } else if (state.activeTab === 'connections') {
        renderConnectionsTab();
    } else if (state.activeTab === 'consideration') {
        renderConsiderationTab();
    } else if (state.activeTab === 'applications') {
        renderApplicationsTab();
    } else if (state.activeTab === 'profile') {
        renderProfileTab();
    }
}

// --- UNDER CONSIDERATION (agentic apply queue) ---------------------------------
// Renders apply_requests. Each row shows how far the agent has taken the role:
// résumé built & verified, form filled, submitted. The agent never advances past
// ReadyForReview - submitting is always yours.
const UC_STATUS_META = {
    Queued:         { label: 'Queued',            cls: 'uc-pill-idle' },
    ResumeBuilding: { label: 'Building…',         cls: 'uc-pill-work' },
    ResumeVerified: { label: 'Verified',          cls: 'uc-pill-ok' },
    Filling:        { label: 'Filling…',          cls: 'uc-pill-work' },
    ReadyForReview: { label: 'Ready for review',  cls: 'uc-pill-ready' },
    Submitted:      { label: 'Submitted',         cls: 'uc-pill-ok' },
    NeedsAttention: { label: 'Needs attention',   cls: 'uc-pill-warn' },
    Failed:         { label: 'Failed',            cls: 'uc-pill-warn' }
};
// Order matters: used to decide whether a stage has been reached.
const UC_ORDER = ['Queued', 'ResumeBuilding', 'ResumeVerified', 'Filling',
                  'ReadyForReview', 'Submitted'];

function ucReached(status, stage) {
    const a = UC_ORDER.indexOf(status), b = UC_ORDER.indexOf(stage);
    return a >= 0 && b >= 0 && a >= b;
}

function fetchConsideration() {
    return fetch('/api/apply-requests')
        .then(r => r.json())
        .then(rows => {
            state.consideration = Array.isArray(rows) ? rows : [];
            rebuildActionedSets();
            state._actionedLoaded = true;
            const badge = document.getElementById('badge-consideration');
            // Badge counts live work, not history - submitted rows have moved on.
            const live = state.consideration.filter(r => r.status !== 'Submitted').length;
            if (badge) badge.innerText = live;
            if (state.activeTab === 'consideration') renderConsiderationTab();
            // Stars/actioned on the Sourcing board derive from this list — refresh it too.
            if (state.activeTab === 'sourcing') renderSourcingTab();
        })
        .catch(() => {});
}

function ucResumeCell(r) {
    if (r.resume_doc_url) {
        const verdict = (r.resume_verdict || '').toUpperCase() === 'PASS'
            ? '<span class="uc-pill uc-pill-ok">Verified</span>'
            : '<span class="uc-pill uc-pill-idle">Built</span>';
        return `${verdict} <a href="${escapeAttr(r.resume_doc_url)}" target="_blank" class="view-link">Open</a>`;
    }
    if (r.status === 'ResumeBuilding') return '<span class="uc-pill uc-pill-work">Building…</span>';
    if ((r.resume_verdict || '').toUpperCase() === 'FAIL')
        return `<span class="uc-pill uc-pill-warn">Failed</span>`;
    return '<span class="uc-pill uc-pill-idle">Not started</span>';
}

// The brief is the ready-to-paste answer sheet for this specific form: every question the
// application asks, the answers already known, the drafted long-form ones, and whatever
// needs your decision. It replaced agent form-filling, which needed a live browser session
// you couldn't reach and stalled on file uploads and CAPTCHAs anyway.
// Posting date, with a relative age — "3d ago" is the number you actually act on.
function ucPostedCell(dateStr) {
    const d = (dateStr || '').substring(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '<span class="uc-pill uc-pill-idle">—</span>';
    const days = Math.round((new Date().setHours(0,0,0,0) - new Date(d + 'T00:00:00')) / 86400000);
    const age = days <= 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
    const cls = days <= 3 ? 'uc-fresh' : days <= 14 ? '' : 'uc-stale';
    return `<span class="${cls}">${d}</span><div class="uc-age ${cls}">${age}</div>`;
}

// Experience / Criteria fit, with the model that produced them. The small bulk model has
// been observed missing the people-management cap on VP/Director roles, so the row exposes
// a one-click re-score on the far more accurate gpt-oss-120b.
function ucFitCell(r) {
    // -1 = never scored; -2 = N/A (couldn't assess, e.g. no usable JD). Everything else is 0-10.
    const NA = -2;
    const unscored = (v) => v === -1 || v === null || v === undefined;
    if (unscored(r.experience_fit) && unscored(r.criteria_fit))
        return '<span class="uc-pill uc-pill-idle">unscored</span>';
    // A "precise" (final) score: 120B/70B, OR a Gemini score produced out-of-band. Both are
    // treated as final - the worker won't re-score them, so we show the marker not the button.
    const precise = isFinalFitModel(r.fit_model);  // only Claude/Gemini; Groq (incl. 120B/8B) keeps the wand
    const tone = v => v === NA ? 'uc-fit-na' : v >= 8 ? 'uc-fit-hi' : v >= 6 ? 'uc-fit-mid' : 'uc-fit-lo';
    const show = v => v === NA ? 'N/A' : unscored(v) ? '–' : v;
    const tip = [r.fit_experience_note ? `Experience — ${r.fit_experience_note}` : '',
                 r.fit_criteria_note ? `Criteria — ${r.fit_criteria_note}` : '',
                 r.fit_framing ? `Framing: ${r.fit_framing}` : '',
                 r.fit_flag ? `Flag: ${r.fit_flag}` : '',
                 r.fit_recommendation ? `Recommendation: ${r.fit_recommendation}` : '',
                 `Scored by: ${r.fit_model || 'unknown'}`].filter(Boolean).join('\n\n');

    const scores = `<span class="${tone(r.experience_fit)}" title="${escapeAttr(tip)}">${show(r.experience_fit)}</span>`
                 + `<span class="uc-fit-sep">/</span>`
                 + `<span class="${tone(r.criteria_fit)}" title="${escapeAttr(tip)}">${show(r.criteria_fit)}</span>`
                 + (r.fit_framing ? ' <span class="uc-fit-framing" title="' + escapeAttr(r.fit_framing) + '">💡</span>' : '');

    const queuedTag = r.claude_rescore_status === 'queued'
        ? ' <span class="uc-fit-model precision-badge-queued" title="Queued for Claude re-score — trigger it in your Claude Code session">Queued</span>'
        : '';

    // Always show which model produced the score (readable without hovering).
    const label = fitModelLabel(r.fit_model);
    const modelChip = label
        ? ` <span class="uc-fit-model ${fitModelClass(r.fit_model)}" title="Scored by ${escapeAttr(r.fit_model || 'unknown')}">${label}</span>`
        : '';

    // Final model, or already queued: model chip only, no re-score trigger.
    if (precise || r.claude_rescore_status === 'queued') {
        return scores + modelChip + queuedTag;
    }

    // Bulk (20B) score: model chip + a wand to queue a Claude (Opus) re-score.
    return scores + modelChip
         + `<button class="btn-precision uc-fit-btn" title="Queue for Claude (Opus) re-score — trigger it in your Claude Code session (reads the full JD and applies the rubric)"
                    onclick="event.stopPropagation(); ucRescore('${r.id}','${r.job_id}')">
                <i class="fa-solid fa-wand-sparkles"></i>
            </button>`;
}

function ucBriefCell(r) {
    if (r.brief_doc_url) {
        const decisions = (r.unanswered_fields || '').trim();
        const n = decisions ? decisions.split('\n').filter(Boolean).length : 0;
        return `<a href="${escapeAttr(r.brief_doc_url)}" target="_blank" class="uc-pill uc-pill-ready uc-pill-link">Open brief</a>`
             + (n ? ` <span class="uc-blanks" title="${escapeAttr(decisions)}">${n} need you</span>` : '');
    }
    if (r.status === 'ResumeBuilding' || r.status === 'Filling') {
        return '<span class="uc-pill uc-pill-work">Preparing…</span>';
    }
    return '<span class="uc-pill uc-pill-idle">Not prepared</span>';
}

// Sort keys for the Under Consideration table headers. Each returns a comparable value;
// strings sort case-insensitively, everything else numerically. Default (no active sort)
// keeps the server order: rows you asked to prepare first, then newest posting.
const UC_SORT_KEYS = {
    company: r => (r.company_name || '').toLowerCase(),
    role:    r => (r.title || '').toLowerCase(),
    posted:  r => (r.first_seen_at || ''),                       // ISO date string
    fit:     r => (r.experience_fit >= 0 ? r.experience_fit * 10 + r.criteria_fit : -1),
    resume:  r => (r.resume_doc_url ? 1 : 0),
    brief:   r => (r.brief_doc_url ? 1 : 0),
    applied: r => (r.status === 'Submitted' ? 1 : 0),
};

// Show a ▲/▼ on the active sort header (and clear the others).
function updateUcSortIndicators() {
    const hdr = document.getElementById('uc-header-row');
    if (!hdr) return;
    hdr.querySelectorAll('.uc-sortable').forEach(th => {
        const key = th.getAttribute('data-sort');
        th.classList.toggle('uc-sort-active', state.ucSort.key === key);
        th.setAttribute('data-arrow',
            state.ucSort.key === key ? (state.ucSort.dir === 1 ? ' ▲' : ' ▼') : '');
    });
}

function sortConsiderationRows(rows) {
    const s = state.ucSort;
    if (!s || !s.key || !UC_SORT_KEYS[s.key]) return rows;   // default server order
    const get = UC_SORT_KEYS[s.key];
    return rows.sort((a, b) => {
        const va = get(a), vb = get(b);
        let c = (typeof va === 'string') ? va.localeCompare(vb) : (va < vb ? -1 : va > vb ? 1 : 0);
        return c * s.dir;
    });
}

function renderConsiderationTab() {
    const body = document.getElementById('consideration-body');
    if (!body) return;
    const rows = sortConsiderationRows((state.consideration || []).slice());

    const n = sel => rows.filter(sel).length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
    const today = new Date().toISOString().slice(0, 10);
    // "Ready to apply" = both artifacts exist and you haven't sent it yet. That is the only
    // number that tells you there is work waiting for you.
    const isReady = r => !!r.resume_doc_url && !!r.brief_doc_url && r.status !== 'Submitted';
    set('uc-stat-queued', n(r => r.status !== 'Submitted' && !(r.resume_doc_url && r.brief_doc_url)
                                 && r.status !== 'NeedsAttention' && r.status !== 'Failed'));
    set('uc-stat-ready', n(isReady));
    set('uc-stat-attention', n(r => r.status === 'NeedsAttention' || r.status === 'Failed'));
    set('uc-stat-today', n(r => r.status === 'Submitted' && (r.updated_at || '').startsWith(today)));

    const countEl = document.getElementById('uc-count');
    if (countEl) countEl.innerText = rows.length ? `${rows.length} in queue` : '';

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="8" class="table-empty">Nothing queued yet — star a role on the Sourcing Board to add it here.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(r => {
        const lvl = classifyJobLevel(r.title);
        const lvlLabel = { dir: 'Dir+', seniorIC: 'Principal', mid: 'Mid', early: 'Early' }[lvl];
        const fit = (r.experience_fit >= 0 && r.criteria_fit >= 0)
            ? `${r.experience_fit}/${r.criteria_fit} fit` : '';
        const applied = r.status === 'Submitted'
            ? '<span class="uc-pill uc-pill-ok">Yes</span>'
            : '<span class="uc-pill uc-pill-idle">Not yet</span>';
        const blocker = r.status === 'NeedsAttention' || r.status === 'Failed'
            ? (r.error || 'Held after repeated failure') : '';
        const src = r.source === 'auto'
            ? '<span class="uc-src" title="Auto-selected by the scheduled run">auto</span>'
            : '<span class="uc-src uc-src-star" title="You starred this">★</span>';

        // Name what's actually missing. "Prepare" on a row that already has the résumé but
        // no brief was misleading about what the click would do.
        const missing = [!r.resume_doc_url ? 'résumé' : '', !r.brief_doc_url ? 'brief' : ''].filter(Boolean);
        const needsPrep = missing.length > 0 && r.status !== 'Submitted';
        const asked = (r.prep_requested_at || '').trim();
        const prepLabel = missing.length === 2 ? 'Prepare' : `Prepare ${missing[0] === 'résumé' ? 'résumé' : 'brief'}`;
        const actions = [
            needsPrep
                ? (asked
                    ? `<button class="uc-btn uc-btn-asked" onclick="ucPrepareOne('${r.id}')" title="You asked for this on ${escapeAttr(asked)} — click to bump it again">Requested</button>`
                    : `<button class="uc-btn" onclick="ucPrepareOne('${r.id}')" title="Build the tailored ${missing.join(' and ')} for this role next">${prepLabel}</button>`)
                : '',
            r.log_path ? `<button class="uc-btn uc-btn-log" onclick="ucViewLog('${r.id}')" title="How the résumé was tailored, and why">Log</button>` : '',
            r.status !== 'Submitted' ? `<button class="uc-btn uc-btn-primary" onclick="ucMarkSubmitted('${r.id}')" title="You submitted this — add it to Application &amp; Interview Pipeline">Mark applied</button>` : '',
            `<button class="uc-btn uc-btn-ghost" onclick="ucRemove('${r.id}')" title="Remove from Under Consideration">Remove</button>`
        ].filter(Boolean).join(' ');

        // Level and fit ride under the role rather than owning columns — they are context
        // for the decision you already made when you starred it, not primary data here.
        return `
        <tr class="uc-row uc-row-${r.status}">
            <td style="font-weight:700">${src} ${escapeHtml(r.company_name)}</td>
            <td>
                <a href="${escapeAttr(r.job_url || '#')}" target="_blank" class="view-link">${escapeHtml(r.title)}</a>
                <div class="uc-sub"><span class="badge-level level-${lvl === 'seniorIC' ? 'senioric' : lvl}">${lvlLabel}</span></div>
                ${blocker ? `<div class="uc-blocker">${escapeHtml(blocker)}</div>` : ''}
            </td>
            <td class="uc-posted">${ucPostedCell(r.first_seen_at)}</td>
            <td class="uc-fitcell" id="uc-fit-${r.job_id}">${ucFitCell(r)}</td>
            <td>${ucResumeCell(r)}</td>
            <td>${ucBriefCell(r)}</td>
            <td>${applied}</td>
            <td style="text-align:center">${actions}</td>
        </tr>`;
    }).join('');
}

// Request ONE role's résumé + brief. Distinct from "Prepare all waiting": this stamps
// prep_requested_at, which sorts the row to the top of the queue and tells the agent
// draining it that you asked for this one specifically.
window.ucPrepareOne = function (reqId) {
    fetch(`/api/apply-requests/${reqId}/prepare`, { method: 'POST' })
        .then(r => r.json().then(b => ({ ok: r.ok, b })))
        .then(({ ok, b }) => {
            if (ok && b.success) {
                showToast(`${b.company} — ${b.wants.join(' + ')} requested. Ask Claude to `
                          + `"prepare the requested applications".`, 'success');
                fetchConsideration();
            } else showToast(b.error || 'Could not request', 'error');
        })
        .catch(() => showToast('Could not request', 'error'));
};

// Opens the application log — the audit trail of how the résumé was tailored and what
// went into the form. This is what makes the review step substantive.
window.ucViewLog = function (reqId) {
    fetch(`/api/apply-requests/${reqId}/log`)
        .then(r => r.json())
        .then(d => {
            if (!d.exists) { showToast('No log written for this role yet.', 'info'); return; }
            let ov = document.getElementById('uc-log-overlay');
            if (!ov) {
                ov = document.createElement('div');
                ov.id = 'uc-log-overlay';
                ov.className = 'uc-log-overlay';
                ov.innerHTML = `
                    <div class="uc-log-panel">
                        <div class="uc-log-head">
                            <strong>Application log</strong>
                            <div class="uc-log-actions">
                                <button class="uc-btn" id="uc-log-copy">Copy</button>
                                <button class="uc-btn uc-btn-ghost" id="uc-log-close">Close</button>
                            </div>
                        </div>
                        <pre id="uc-log-body"></pre>
                        <div class="uc-log-path" id="uc-log-path"></div>
                    </div>`;
                document.body.appendChild(ov);
                ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; });
                ov.querySelector('#uc-log-close').addEventListener('click', () => { ov.style.display = 'none'; });
                ov.querySelector('#uc-log-copy').addEventListener('click', () => {
                    navigator.clipboard.writeText(document.getElementById('uc-log-body').textContent)
                        .then(() => showToast('Log copied.', 'success')).catch(() => {});
                });
                document.addEventListener('keydown', e => {
                    if (e.key === 'Escape' && ov.style.display === 'flex') ov.style.display = 'none';
                });
            }
            document.getElementById('uc-log-body').textContent = d.content;
            document.getElementById('uc-log-path').textContent = d.path || '';
            ov.style.display = 'flex';
        })
        .catch(() => showToast('Could not load the log.', 'error'));
};

window.ucRescore = function (reqId, jobId) {
    const cell = document.getElementById(`uc-fit-${jobId}`);
    if (cell) cell.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color:var(--primary)"></i>';
    // Queues the role for a Claude (Opus) re-score, drained in a Claude Code session.
    fetch(`/api/jobs/${jobId}/claude-rescore`, { method: 'POST' })
        .then(res => res.json().then(body => ({ ok: res.ok, body })))
        .then(({ ok, body }) => {
            if (!ok || body.error) throw new Error(body.error || 'Could not queue');
            showToast(`Queued for Claude re-score (${body.queued_count} in queue) — trigger it in your Claude Code session.`, 'success');
            fetchConsideration();
            fetchJobs();
        })
        .catch(err => {
            showToast('Could not queue re-score: ' + err.message, 'error');
            fetchConsideration();
        });
};

window.ucMarkSubmitted = function (reqId) {
    fetch(`/api/apply-requests/${reqId}/submitted`, { method: 'POST' })
        .then(r => r.json()).then(b => {
            if (b.success) {
                showToast(b.already ? 'Already in the pipeline.' : 'Added to Application & Interview Pipeline.', 'success');
                fetchConsideration();
                fetchApplications();
            } else showToast(b.error || 'Could not mark submitted', 'error');
        }).catch(() => showToast('Could not mark submitted', 'error'));
};

window.ucRemove = function (reqId) {
    fetch(`/api/apply-requests/${reqId}`, { method: 'DELETE' })
        .then(r => r.json()).then(() => { fetchConsideration(); })
        .catch(() => showToast('Could not remove', 'error'));
};

// --- JOB APPLICATION TRACKER ---
const APP_METHODS = ['Job Portal', 'Mail to Recruiter/Hiring Manager'];
const APP_REFERRALS = ['No', 'Yes - System', 'Yes - Direct Connection', 'Outreach from Recruiter/HM'];
const APP_PROGRESS = ['Submitted', 'Received a Response from Recruiter', 'Synced w/ Recruiter',
                      'Synced with HM', 'Did Full Interview Loop'];
const APP_OUTCOMES = ['In Progress', 'Closed'];

function fetchApplications() {
    return fetch('/api/applications')
        .then(r => r.json())
        .then(rows => {
            state.applications = Array.isArray(rows) ? rows : [];
            rebuildActionedSets();
            const badge = document.getElementById('badge-applications');
            // Left-nav count shows Recent Submissions (still in progress), not the all-time total.
            if (badge) badge.innerText = state.applications.filter(a => a.outcome !== 'Closed').length;
            if (state.activeTab === 'applications') renderApplicationsTab();
            // Applied/pipeline roles also render a star on the Sourcing board — refresh it.
            if (state.activeTab === 'sourcing') renderSourcingTab();
            loadActiveRepRoles();
            populateInterviewReviewRoleDropdown();
        })
        .catch(() => {});
}

function appDropdown(app, field, options) {
    const val = app[field] || options[0];
    const opts = options.map(o =>
        `<option value="${escapeAttr(o)}" ${o === val ? 'selected' : ''}>${o}</option>`).join('');
    return `<select class="apps-cell-select" onchange="updateApplication(${app.id}, '${field}', this.value)">${opts}</select>`;
}

const APP_SHORTLIST_STAGES = ['Synced w/ Recruiter', 'Synced with HM', 'Did Full Interview Loop'];

// The five stat cards double as one-click filters. Each card's predicate is the single
// source of truth for BOTH its count and the rows it filters to, so the number on a card
// always equals the number of rows you get when you click it.
const APP_STAT_CARDS = {
    submissions: () => true,          // every application; acts as "show all" (Overall Submissions)
    active:      a => a.outcome !== 'Closed',   // "Recent Submissions": still in progress, not Closed
    // "Active Discussions": in-progress roles where a real conversation is underway — synced
    // with a recruiter or HM, or a full interview loop (the shortlist stages), and not Closed.
    activeDiscussions: a => a.outcome !== 'Closed' && APP_SHORTLIST_STAGES.includes(a.progress),
    shortlists:  a => APP_SHORTLIST_STAGES.includes(a.progress),
    loops:       a => a.progress === 'Did Full Interview Loop',
    closed:      a => a.outcome === 'Closed'
};

function renderApplicationsStats(appsList, referralBase) {
    const list = appsList !== undefined ? appsList : (state.applications || []);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
    Object.keys(APP_STAT_CARDS).forEach(cardKey => {
        set('apps-stat-' + cardKey, list.filter(APP_STAT_CARDS[cardKey]).length);
    });

    // Referral-share cards: percentage of applications sent with each referral type.
    const base = referralBase !== undefined ? referralBase : list;
    document.querySelectorAll('#apps-stats .apps-stat[data-referral-card]').forEach(el => {
        const value = el.getAttribute('data-referral-card');
        const hits = base.filter(a => a.referral === value).length;
        const pct = base.length ? Math.round((hits / base.length) * 100) : 0;
        const valEl = el.querySelector('.apps-stat-val');
        if (valEl) valEl.innerText = pct + '%';
        el.title = `${hits} of ${base.length} application${base.length === 1 ? '' : 's'}`
            + ` — click to filter Referral Type to "${value}"`;
        el.classList.toggle('selected', state.appFilterReferral === value);
    });

    // Highlight whichever card is currently driving the table filter.
    document.querySelectorAll('#apps-stats .apps-stat[data-stat-card]').forEach(el => {
        el.classList.toggle('selected', el.getAttribute('data-stat-card') === state.appStatCard);
    });
}

// Funnel ordering: `progress` stores only the FURTHEST stage a role reached, so "reached
// stage k" = rank(progress) >= k. This is the single source of truth for the funnel counts.
const APP_STAGE_RANK = {
    'Submitted': 0,
    'Received a Response from Recruiter': 1,
    'Synced w/ Recruiter': 2,
    'Synced with HM': 3,
    'Did Full Interview Loop': 4
};

function appRank(a) {
    return APP_STAGE_RANK[a.progress] !== undefined ? APP_STAGE_RANK[a.progress] : 0;
}

// The four rightmost Application-Insights KPI cards double as one-click table filters:
// each narrows the table to applications that REACHED that funnel stage (rank >= k). Keyed
// by the same `data-app-card` values rendered on the cards. Shares state.appStatCard with the
// top stat cards, so at most one card (stat or insight) filters at a time.
const APP_STAGE_FILTERS = {
    'stage-response': a => appRank(a) >= 1,
    'stage-screen':   a => appRank(a) >= 2,
    'stage-hm':       a => appRank(a) >= 3,
    'stage-loop':     a => appRank(a) >= 4
};

// Single lookup for whichever card is currently filtering the table.
function appCardPredicate(key) {
    return APP_STAT_CARDS[key] || APP_STAGE_FILTERS[key] || null;
}

// The datestamp a submission should be bucketed under. applied_date is authoritative; fall
// back to the created_at timestamp so older rows entered before applied_date existed still
// land somewhere sensible.
function appSubmitDate(a) {
    const d = (a.applied_date || '').substring(0, 10) || (a.created_at || '').substring(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

function mondayOf(d) {
    const dt = new Date(d + 'T00:00:00');
    const day = (dt.getDay() + 6) % 7;          // 0 = Monday
    dt.setDate(dt.getDate() - day);
    return dt;
}

// Local YYYY-MM-DD. Avoids toISOString()'s UTC shift, which could bucket a Monday into the
// wrong week for anyone west of UTC.
function ymdLocal(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Build an ordered, GAP-FILLED set of day, week or month buckets spanning first date -> now,
// so a quiet period still shows as a zero bar instead of being silently skipped.
function buildTimeBuckets(dates, grain) {
    if (!dates.length) return [];
    const min = dates.reduce((a, b) => a < b ? a : b);
    const buckets = [];
    const seen = new Set();
    const push = (key, label) => { if (!seen.has(key)) { seen.add(key); buckets.push({ key, label, count: 0 }); } };
    if (grain === 'day') {
        let cur = new Date(min + 'T00:00:00');
        const end = new Date();
        while (cur <= end) {
            const key = ymdLocal(cur);
            push(key, `${_MONTHS[cur.getMonth()]} ${cur.getDate()}`);
            cur.setDate(cur.getDate() + 1);
        }
    } else if (grain === 'month') {
        let cur = new Date(min.substring(0, 7) + '-01T00:00:00');
        const end = new Date();
        while (cur <= end) {
            const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
            push(key, `${_MONTHS[cur.getMonth()]} '${String(cur.getFullYear()).slice(2)}`);
            cur.setMonth(cur.getMonth() + 1);
        }
    } else {
        let cur = mondayOf(min);
        const end = new Date();
        while (cur <= end) {
            const key = ymdLocal(cur);
            push(key, `${_MONTHS[cur.getMonth()]} ${cur.getDate()}`);
            cur.setDate(cur.getDate() + 7);
        }
    }
    return buckets;
}

function bucketKeyFor(date, grain) {
    if (grain === 'day') return date.substring(0, 10);
    if (grain === 'month') return date.substring(0, 7);
    return ymdLocal(mondayOf(date));
}

// Renders the two Application-Insights charts (submission trend + conversion funnel) and the
// KPI row. Driven by the full application history, independent of the table's active filters.
function renderApplicationInsights() {
    const all = state.applications || [];
    if (!state.appCharts) state.appCharts = {};
    if (typeof Chart === 'undefined') return;

    const grain = state.appInsightsGrain || 'week';
    const textColor = '#94a3b8';
    const gridColor = 'rgba(148, 163, 184, 0.1)';

    // --- Time series: submissions per week/month ---
    const dates = all.map(appSubmitDate).filter(Boolean);
    const buckets = buildTimeBuckets(dates, grain);
    const byKey = Object.fromEntries(buckets.map(b => [b.key, b]));
    dates.forEach(d => { const k = bucketKeyFor(d, grain); if (byKey[k]) byKey[k].count++; });

    ['trend', 'funnel'].forEach(k => { if (state.appCharts[k]) state.appCharts[k].destroy(); });

    const trendCtx = document.getElementById('apps-chart-trend');
    if (trendCtx) {
        state.appCharts.trend = new Chart(trendCtx, {
            type: 'bar',
            data: {
                labels: buckets.map(b => b.label),
                datasets: [{
                    label: grain === 'month' ? 'Submissions / month' : 'Submissions / week',
                    data: buckets.map(b => b.count),
                    backgroundColor: 'rgba(99, 102, 241, 0.75)',
                    borderColor: '#6366f1',
                    borderWidth: 1.5,
                    borderRadius: 6,
                    maxBarThickness: 46
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { cornerRadius: 8, padding: 10 } },
                scales: {
                    x: { ticks: { color: textColor, maxRotation: 0, autoSkip: true }, grid: { display: false } },
                    y: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } }
                }
            }
        });
    }

    // --- Funnel: reached-stage counts (rank >= k) ---
    const rank = a => (APP_STAGE_RANK[a.progress] !== undefined ? APP_STAGE_RANK[a.progress] : 0);
    const total = all.length;
    const reached = k => all.filter(a => rank(a) >= k).length;
    const stages = [
        { label: 'Submitted', n: total },
        { label: 'Recruiter response', n: reached(1) },
        { label: 'Recruiter screen', n: reached(2) },
        { label: 'Hiring manager', n: reached(3) },
        { label: 'Interview loop', n: reached(4) }
    ];
    const funnelCtx = document.getElementById('apps-chart-funnel');
    if (funnelCtx) {
        state.appCharts.funnel = new Chart(funnelCtx, {
            type: 'bar',
            data: {
                labels: stages.map(s => s.label),
                datasets: [{
                    label: 'Applications',
                    data: stages.map(s => s.n),
                    backgroundColor: ['#6366f1', '#0ea5e9', '#06b6d4', '#f59e0b', '#10b981'],
                    borderWidth: 0,
                    borderRadius: 6
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        cornerRadius: 8, padding: 10,
                        callbacks: {
                            label: (c) => {
                                const n = c.parsed.x;
                                const pct = total ? Math.round((n / total) * 100) : 0;
                                return `${n} of ${total} (${pct}% of submitted)`;
                            }
                        }
                    }
                },
                scales: {
                    x: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } },
                    y: { ticks: { color: textColor, font: { weight: '600' } }, grid: { display: false } }
                }
            }
        });
    }

    // --- KPI row ---
    const kpiEl = document.getElementById('apps-kpis');
    if (kpiEl) {
        const activeWeeks = buckets.filter(b => b.count > 0).length || 1;
        const perGrain = (total / (grain === 'month'
            ? (buckets.length || 1)
            : activeWeeks)).toFixed(1);
        const pct = n => total ? Math.round((n / total) * 100) : 0;
        // The rightmost four carry a `key`: clicking them filters the table to applications
        // that reached that stage (see APP_STAGE_FILTERS). The first two are plain metrics.
        const kpis = [
            { v: total, l: 'Total submitted' },
            { v: perGrain, l: grain === 'month' ? 'Avg / month' : 'Avg / active week' },
            { v: pct(reached(1)) + '%', l: 'Response rate',   key: 'stage-response', title: 'Filter to applications that got a recruiter response or further' },
            { v: pct(reached(2)) + '%', l: 'Recruiter screen', key: 'stage-screen',  title: 'Filter to applications that reached a recruiter screen or further' },
            { v: pct(reached(3)) + '%', l: 'Reached HM+',      key: 'stage-hm',      title: 'Filter to applications that reached the hiring manager or further' },
            { v: reached(4),            l: 'Interview loops',  key: 'stage-loop',    title: 'Filter to applications where you did a full interview loop' }
        ];
        kpiEl.innerHTML = kpis.map(k => {
            if (!k.key) {
                return `<div class="apps-kpi"><span class="apps-kpi-val">${k.v}</span><span class="apps-kpi-lbl">${k.l}</span></div>`;
            }
            const sel = state.appStatCard === k.key ? ' selected' : '';
            return `<div class="apps-kpi apps-kpi-clickable${sel}" data-app-card="${k.key}" role="button" tabindex="0" title="${escapeAttr(k.title)}">`
                 + `<span class="apps-kpi-val">${k.v}</span><span class="apps-kpi-lbl">${k.l}</span></div>`;
        }).join('');
    }
}

const APP_PROGRESS_ORDER = {
    'Submitted': 1,
    'Received a Response from Recruiter': 2,
    'Synced w/ Recruiter': 3,
    'Synced with HM': 4,
    'Did Full Interview Loop': 5
};

// Compute Total Comp = max(listed comp ceiling, recruiter-provided annual TC ceiling)
function getApplicationCompInfo(a) {
    let listedStr = (a.listed_comp || '').trim();
    if (!listedStr && state.allJobs && state.allJobs.length) {
        const m = (a.notes || '').match(/https?:\/\/[^\s|)]+/);
        const rawUrl = m ? m[0].split('?')[0].replace(/\/+$/, '') : '';
        const k = normKey(a.company) + '' + normKey(a.role);
        for (const j of state.allJobs) {
            if (!j || !j.salary || j.salary === 'N/A') continue;
            const ju = (j.url || '').split('?')[0].replace(/\/+$/, '');
            if ((rawUrl && ju && rawUrl === ju) || (normKey(j.company_name) + '' + normKey(j.title) === k)) {
                listedStr = j.salary;
                break;
            }
        }
    }
    const recStr = (a.recruiter_comp || '').trim();
    const listedMax = listedStr ? (parseSalaryNumber(listedStr) || 0) : 0;
    const recMax = recStr ? (parseSalaryNumber(recStr) || 0) : 0;
    const maxVal = Math.max(listedMax, recMax);
    const source = maxVal === 0 ? null : (recMax >= listedMax && recMax > 0 ? 'recruiter' : 'listed');
    return { maxVal, listedMax, recMax, listedStr, recStr, compNotes: (a.comp_notes || '').trim(), source };
}

function formatAppTotalCompBadge(a) {
    const info = getApplicationCompInfo(a);
    if (!info.maxVal) {
        return `<span class="app-comp-empty" onclick="promptRecruiterComp(${a.id})" title="Click to enter recruiter-shared Total Comp (Base + Bonus + Stock/yr)" style="color:var(--text-muted); cursor:pointer; font-size:0.8rem;">—</span>`;
    }
    const kVal = info.maxVal / 1000;
    const numLabel = (kVal % 1 === 0) ? `$${kVal.toFixed(0)}K` : `$${kVal.toFixed(1)}K`;
    const isPlus = (info.source === 'recruiter' && info.recStr.includes('+'));
    const displayVal = numLabel + (isPlus ? '+' : '');
    const tooltipParts = [];
    if (info.recStr) {
        tooltipParts.push(`Recruiter Comp: ${info.recStr}`);
    }
    if (info.compNotes) {
        tooltipParts.push(info.compNotes);
    }
    if (info.listedStr) {
        tooltipParts.push(`Listed Range: ${info.listedStr}`);
    }
    tooltipParts.push('Click to edit Recruiter Comp');
    const tooltip = tooltipParts.join(' • ');

    if (info.source === 'recruiter') {
        return `<div onclick="promptRecruiterComp(${a.id})" title="${escapeAttr(tooltip)}" style="cursor:pointer; display:inline-flex; flex-direction:column; align-items:flex-start; gap:2px; line-height:1.15;">
            <span style="font-weight:700; font-size:0.84rem; color:#10b981;">${escapeHtml(displayVal)}</span>
            <span style="font-size:0.65rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(16,185,129,0.14); color:#059669; letter-spacing:0.01em;">Recruiter</span>
        </div>`;
    }
    return `<div onclick="promptRecruiterComp(${a.id})" title="${escapeAttr(tooltip)}" style="cursor:pointer; display:inline-flex; flex-direction:column; align-items:flex-start; gap:2px; line-height:1.15;">
        <span style="font-weight:600; font-size:0.84rem; color:var(--text-primary);">${escapeHtml(displayVal)}</span>
        <span style="font-size:0.65rem; font-weight:500; padding:1px 5px; border-radius:4px; background:rgba(148,163,184,0.16); color:var(--text-secondary);">Listed</span>
    </div>`;
}

window.promptRecruiterComp = function(appId) {
    const app = (state.applications || []).find(x => x.id === appId);
    if (!app) return;
    const current = app.recruiter_comp || '';
    const next = window.prompt(
        `Enter Recruiter-Provided Total Comp (Base + Bonus + Stock/yr) for ${app.company} — ${app.role}\n(e.g. "$504K" or "$459K - $504K"):`,
        current
    );
    if (next === null) return;
    app.recruiter_comp = next.trim();
    updateApplication(appId, 'recruiter_comp', app.recruiter_comp);
    renderApplicationsTab();
};

function updateAppsSortIndicators() {
    const hdr = document.getElementById('apps-header-row');
    if (!hdr) return;
    const s = state.appSort || { key: null, dir: 1 };
    hdr.querySelectorAll('.apps-sortable').forEach(th => {
        const key = th.getAttribute('data-sort');
        const isActive = s.key === key;
        th.classList.toggle('apps-sort-active', isActive);
        th.setAttribute('data-arrow',
            isActive ? (s.dir === 1 ? ' \u25b2' : ' \u25bc') : '');
    });
}

function sortApplicationRows(apps) {
    const s = state.appSort;
    if (!s || !s.key) {
        // Default sort: In Progress (yellow) on top, Closed (red) at the bottom.
        // Within each colour block, sort alphabetically by company (case-insensitive), then by role.
        return apps.sort((a, b) => {
            const rank = x => (x.outcome === 'Closed' ? 1 : 0);
            if (rank(a) !== rank(b)) return rank(a) - rank(b);
            const byCompany = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            if (byCompany !== 0) return byCompany;
            return (a.role || '').localeCompare((b.role || ''), undefined, { sensitivity: 'base' });
        });
    }

    return apps.sort((a, b) => {
        let diff = 0;
        if (s.key === 'company') {
            diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            if (diff === 0) diff = (a.role || '').localeCompare((b.role || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'role') {
            diff = (a.role || '').localeCompare((b.role || ''), undefined, { sensitivity: 'base' });
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'total_comp') {
            const ca = getApplicationCompInfo(a).maxVal || 0;
            const cb = getApplicationCompInfo(b).maxVal || 0;
            if (!ca && !cb) return (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            if (!ca) return 1; // empty comp sinks to bottom
            if (!cb) return -1;
            diff = ca - cb;
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'submission_method') {
            diff = (a.submission_method || '').localeCompare((b.submission_method || ''), undefined, { sensitivity: 'base' });
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'referral') {
            diff = (a.referral || '').localeCompare((b.referral || ''), undefined, { sensitivity: 'base' });
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'progress') {
            const pa = APP_PROGRESS_ORDER[a.progress] || 0;
            const pb = APP_PROGRESS_ORDER[b.progress] || 0;
            diff = pa - pb;
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'outcome') {
            const oa = (a.outcome === 'Closed' ? 1 : 0);
            const ob = (b.outcome === 'Closed' ? 1 : 0);
            diff = oa - ob;
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'applied_date') {
            const da = a.applied_date || a.created_at || '';
            const db = b.applied_date || b.created_at || '';
            if (!da && !db) diff = 0;
            else if (!da) return 1; // empty dates sink to bottom
            else if (!db) return -1;
            else diff = da.localeCompare(db);
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        } else if (s.key === 'outcome_date') {
            const da = a.outcome_date || '';
            const db = b.outcome_date || '';
            if (!da && !db) diff = 0;
            else if (!da) return 1; // empty dates sink to bottom
            else if (!db) return -1;
            else diff = da.localeCompare(db);
            if (diff === 0) diff = (a.company || '').localeCompare((b.company || ''), undefined, { sensitivity: 'base' });
            return diff * s.dir;
        }
        return 0;
    });
}

function renderApplicationsTab() {
    const body = document.getElementById('applications-body');
    if (!body) return;
    let apps = (state.applications || []).slice();

    // Filters (Submission Method + Referral Type + Progress + Outcome + Search)
    if (state.appFilterMethod && state.appFilterMethod !== 'all') {
        apps = apps.filter(a => a.submission_method === state.appFilterMethod);
    }
    if (state.appFilterProgress && state.appFilterProgress !== 'all') {
        if (state.appFilterProgress === 'Stopped at Recruiter (No HM)') {
            apps = apps.filter(a =>
                (a.progress === 'Synced w/ Recruiter' || a.progress === 'Received a Response from Recruiter') &&
                a.outcome === 'Closed'
            );
        } else {
            apps = apps.filter(a => a.progress === state.appFilterProgress);
        }
    }
    if (state.appFilterOutcome && state.appFilterOutcome !== 'all') {
        apps = apps.filter(a => a.outcome === state.appFilterOutcome);
    }
    if (state.appFilterSearch) {
        const q = state.appFilterSearch.toLowerCase();
        apps = apps.filter(a =>
            (a.company || '').toLowerCase().includes(q) ||
            (a.role || '').toLowerCase().includes(q) ||
            (a.notes || '').toLowerCase().includes(q) ||
            (a.feedback || '').toLowerCase().includes(q)
        );
    }

    // Snapshot BEFORE the referral filter: the referral % cards divide by this, so their
    // percentages stay meaningful when one of them is selected. (Computing them after the
    // referral filter would make the clicked card read a useless 100%.)
    const preReferral = apps.slice();

    if (state.appFilterReferral && state.appFilterReferral !== 'all') {
        apps = apps.filter(a => a.referral === state.appFilterReferral);
    }

    // Stats are computed BEFORE the stat-card filter is applied, using the dropdown/search
    // filters only. That keeps every card's number visible while one card is selected, so
    // you can see what you'd get and switch cards directly instead of clearing first.
    renderApplicationsStats(apps, preReferral);

    // Insights panel (trend + funnel) is driven by the WHOLE application history, not the
    // active table filters, so the charts show the full picture regardless of the table view.
    renderApplicationInsights();

    // Stat-card filter (clicking a top stat card OR an insights stage card narrows the table).
    const cardPred = appCardPredicate(state.appStatCard);
    if (cardPred) {
        apps = apps.filter(cardPred);
    }

    const countEl = document.getElementById('apps-filter-count');
    if (countEl) {
        const filtered = (state.appFilterMethod && state.appFilterMethod !== 'all') ||
                         (state.appFilterReferral && state.appFilterReferral !== 'all') ||
                         (state.appFilterProgress && state.appFilterProgress !== 'all') ||
                         (state.appFilterOutcome && state.appFilterOutcome !== 'all') ||
                         (state.appFilterSearch && state.appFilterSearch.trim() !== '') ||
                         !!state.appStatCard;
        countEl.innerText = filtered ? `Showing ${apps.length} of ${(state.applications || []).length}` : '';
    }

    if (!apps.length) {
        body.innerHTML = '<tr><td colspan="12" class="table-empty">No applications match. Add one above or clear filters.</td></tr>';
        return;
    }
    updateAppsSortIndicators();
    apps = sortApplicationRows(apps);
    // JD links: the applications table has no url column, so recover each role's job
    // description by matching it to its board job on company+role. Fall back to a URL saved
    // in the row's notes (starring writes the JD link there). Built once per render.
    const jdByKey = new Map();
    (state.allJobs || []).forEach(j => {
        if (!j || !j.url) return;
        const k = normKey(j.company_name) + '' + normKey(j.title);
        const cur = jdByKey.get(k);
        // Prefer a still-open job's link over an archived one.
        if (!cur || (cur.archived && j.status !== 'Archived')) {
            jdByKey.set(k, { url: j.url, archived: j.status === 'Archived' });
        }
    });
    const jdUrlForApp = (a) => {
        const m = (a.notes || '').match(/https?:\/\/[^\s)]+/);
        if (m) return m[0];
        const hit = jdByKey.get(normKey(a.company) + '' + normKey(a.role));
        if (hit && hit.url) return hit.url;
        return '';
    };
    body.innerHTML = apps.map(a => {
        const outcomeClass = a.outcome === 'Closed' ? 'app-outcome-closed' : 'app-outcome-progress';
        const resume = a.resume_link
            ? `<a href="${escapeAttr(a.resume_link)}" target="_blank" class="view-link">Open</a>`
            : '<span style="color:var(--text-muted)">—</span>';
        const jdUrl = jdUrlForApp(a);
        return `
        <tr id="app-row-${a.id}" class="${outcomeClass}">
            <td><input class="apps-text-edit apps-text-company" value="${escapeAttr(a.company)}"
                    title="${escapeAttr(a.company)}"
                    onblur="updateApplicationText(${a.id}, 'company', this)"
                    onkeydown="if(event.key==='Enter'){this.blur();}if(event.key==='Escape'){this.value=this.defaultValue;this.blur();}"></td>
            <td>${jdUrl
                ? `<a href="${escapeAttr(jdUrl)}" target="_blank" class="apps-role-link" title="${escapeAttr(a.role)} — open job description" onclick="event.stopPropagation();" style="color:var(--text-primary); font-weight:600; text-decoration:none; display:inline-flex; align-items:center; gap:5px;">${escapeHtml(a.role)}<i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.6rem; color:#3b82f6;"></i></a>`
                : `<input class="apps-text-edit apps-text-role" value="${escapeAttr(a.role)}" title="${escapeAttr(a.role)}" onblur="updateApplicationText(${a.id}, 'role', this)" onkeydown="if(event.key==='Enter'){this.blur();}if(event.key==='Escape'){this.value=this.defaultValue;this.blur();}">`
            }</td>
            <td style="white-space:nowrap;">${formatAppTotalCompBadge(a)}</td>
            <td>${appDropdown(a, 'submission_method', APP_METHODS)}</td>
            <td>${appDropdown(a, 'referral', APP_REFERRALS)}</td>
            <td>${appDropdown(a, 'progress', APP_PROGRESS)}</td>
            <td>${appDropdown(a, 'outcome', APP_OUTCOMES)}</td>
            <td><input type="date" class="apps-date-edit" value="${escapeAttr(a.applied_date || '')}"
                    title="Date you submitted this application"
                    onchange="updateApplication(${a.id}, 'applied_date', this.value)"></td>
            <td><input type="date" class="apps-date-edit" value="${escapeAttr(a.outcome_date || '')}"
                    title="Set automatically when Outcome becomes Closed; editable"
                    onchange="updateApplication(${a.id}, 'outcome_date', this.value)"></td>
            <td><textarea class="apps-feedback" rows="1" placeholder="Add notes…"
                    onblur="updateApplication(${a.id}, 'feedback', this.value)">${escapeHtml(a.feedback || '')}</textarea></td>
            <td style="text-align:center">${resume}</td>
            <td style="text-align:center">
                <button class="app-delete-btn" title="Delete" onclick="deleteApplication(${a.id})"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>`;
    }).join('');
}

// Inline edit for the free-text identity fields (company / role). These are required and
// also drive the table's alphabetical sort, so they need blank-guarding and a re-render.
function updateApplicationText(id, field, inputEl) {
    const app = (state.applications || []).find(a => a.id === id);
    const previous = app ? (app[field] || '') : '';
    const value = (inputEl.value || '').trim();

    if (!value) {                       // never allow a row to lose its company/role
        inputEl.value = previous;
        showToast(`${field === 'company' ? 'Company' : 'Role'} can't be empty`, 'error');
        return;
    }
    if (value === previous) {           // nothing changed - don't churn the table
        inputEl.value = previous;
        return;
    }

    inputEl.value = value;
    updateApplication(id, field, value);
    // Company/role determine sort position, so re-sort once the edit lands.
    renderApplicationsTab();
}

function updateApplication(id, field, value) {
    const app = (state.applications || []).find(a => a.id === id);
    if (app) app[field] = value;  // optimistic
    fetch(`/api/applications/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value })
    })
        .then(r => r.json())
        .then(b => {
            if (!b.success) { showToast('Update failed: ' + (b.error || 'unknown'), 'error'); return; }
            // Changing the outcome has server-side side effects the optimistic local update
            // can't know about (it stamps or clears outcome_date, and exempts a reopened row
            // from auto-close), so re-fetch rather than just re-render.
            if (field === 'outcome') fetchApplications();
        })
        .catch(() => showToast('Update failed', 'error'));
}

function deleteApplication(id) {
    const app = (state.applications || []).find(a => a.id === id);
    if (!confirm(`Delete application: ${app ? app.company + ' — ' + app.role : 'this row'}?`)) return;
    fetch(`/api/applications/${id}`, { method: 'DELETE' })
        .then(r => r.json())
        .then(b => {
            if (b.success) { state.applications = state.applications.filter(a => a.id !== id); fetchApplications(); showToast('Application removed.'); }
            else showToast('Delete failed', 'error');
        });
}

// Add a starred Sourcing-Board role into the Applications tracker (deduped by
// company + role, so re-starring or an already-tracked role won't create a duplicate).
function addJobToApplications(job) {
    const norm = s => (s || '').toLowerCase().trim();
    const exists = (state.applications || []).some(a =>
        norm(a.company) === norm(job.company_name) && norm(a.role) === norm(job.title));
    if (exists) return;
    fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            company: job.company_name,
            role: job.title,
            notes: 'Starred from Sourcing Board' + (job.url ? ' — ' + job.url : '')
        })
    })
        .then(r => r.json())
        .then(b => { if (b && b.success) fetchApplications(); })
        .catch(() => {});
}

function submitNewApplication(e) {
    e.preventDefault();
    const company = document.getElementById('app-company-input').value.trim();
    const role = document.getElementById('app-role-input').value.trim();
    if (!company || !role) { showToast('Company and Role are required.', 'error'); return; }
    fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            company, role,
            submission_method: document.getElementById('app-method-input').value,
            referral: document.getElementById('app-referral-input').value
        })
    })
        .then(r => r.json())
        .then(b => {
            if (!b.success) { showToast('Add failed: ' + (b.error || 'unknown'), 'error'); return; }
            document.getElementById('add-application-form').reset();
            fetchApplications();
            showToast(`Added ${company} — ${role}.`, 'success');
        })
        .catch(() => showToast('Add failed', 'error'));
}

// 1.5 Market Insights Tab Renderer & Filtering

function populateInsightsCompanyFilter() {
    if (!elements.insightsCompanyFilter) return;
    const companies = [...new Set(state.allJobs.filter(j => {
        // Starred rows carry status 'Consideration' — they must stay on the board
        // (filtering to 'Lead' was silently hiding everything you actioned).
        return j.status !== 'Archived';
    }).map(j => j.company_name).filter(Boolean))].sort();
    
    const current = elements.insightsCompanyFilter.value || 'all';
    elements.insightsCompanyFilter.innerHTML = `<option value="all">All companies (${companies.length})</option>` +
        companies.map(co => `<option value="${co}">${co}</option>`).join('');
    if (companies.includes(current)) {
        elements.insightsCompanyFilter.value = current;
    } else {
        elements.insightsCompanyFilter.value = 'all';
    }
}

function getCompanyCohort(companyName) {
    if (!companyName) return 'Tech';
    const cname = companyName.toLowerCase().trim();
    const co = (state.trackedCompanies || []).find(c => (c.name || '').toLowerCase().trim() === cname);
    return co ? (co.cohort || 'Tech') : 'Tech';
}

function getFilteredJobsForInsights(sourceJobs, opts = {}) {
    const { includeArchived = false, applyDateFilter = true } = opts;
    const base = Array.isArray(sourceJobs) ? sourceJobs : state.allJobs;
    let filtered = includeArchived ? base.slice() : base.filter(j => {
        // Starred rows carry status 'Consideration' — they must stay on the board
        // (filtering to 'Lead' was silently hiding everything you actioned).
        return j.status !== 'Archived';
    });
    
    const filters = state.insightsFilters || {};
    
    // Insights Search Query
    if (filters.searchQuery) {
        const q = filters.searchQuery.toLowerCase();
        filtered = filtered.filter(j => 
            (j.title || '').toLowerCase().includes(q) ||
            (j.company_name || '').toLowerCase().includes(q) ||
            (j.location || '').toLowerCase().includes(q)
        );
    }
    
    // Seniority Checkboxes (shared classifier - see classifyJobLevel)
    filtered = filtered.filter(j => passesSeniorityFilter(j, filters));

    // Region filter
    if (filters.selectedRegion && filters.selectedRegion !== 'all') {
        filtered = filtered.filter(j => {
            const loc = (j.location || '').toLowerCase();
            const reg = filters.selectedRegion;
            if (reg === 'West') {
                return ['ca', 'california', 'wa', 'washington', 'or', 'oregon', 'co', 'colorado', 'seattle', 'san francisco', 'sf', 'los angeles', 'la', 'denver'].some(k => loc.includes(k));
            }
            if (reg === 'Northeast') {
                return ['ny', 'new york', 'nyc', 'ma', 'massachusetts', 'boston', 'pa', 'pennsylvania', 'philadelphia', 'nj', 'new jersey'].some(k => loc.includes(k));
            }
            if (reg === 'Midwest') {
                return ['il', 'illinois', 'chicago', 'mi', 'michigan', 'oh', 'ohio', 'mn', 'minnesota'].some(k => loc.includes(k));
            }
            if (reg === 'South') {
                return ['tx', 'texas', 'austin', 'dallas', 'houston', 'ga', 'georgia', 'atlanta', 'fl', 'florida', 'miami', 'nc', 'north carolina'].some(k => loc.includes(k));
            }
            if (reg === 'Remote') {
                return loc.includes('remote') || loc.includes('anywhere') || 
                       loc.includes('work from home') || loc === 'us' || 
                       loc.includes('usa - remote') || loc.includes('us-remote') ||
                       loc.includes('remote - u.s') || loc.includes('united states') ||
                       loc.includes('remote-eligible') || loc.includes('remote - eligible');
            }
            return false;
        });
    }

    // Industry Filter
    if (filters.selectedIndustry && filters.selectedIndustry !== 'all') {
        const indTarget = filters.selectedIndustry.toLowerCase();
        filtered = filtered.filter(j => getCompanyCohort(j.company_name).toLowerCase() === indTarget);
    }

    // Min Comp Filter
    if (filters.selectedMinComp && filters.selectedMinComp !== 'all') {
        const minK = parseInt(filters.selectedMinComp, 10);
        filtered = filtered.filter(j => {
            const num = parseSalaryNumber(j.salary);
            return num !== null && num >= minK * 1000;
        });
    }

    // Exp Fit Filter
    if (filters.selectedExpFit && filters.selectedExpFit !== 'all') {
        const min = parseInt(filters.selectedExpFit, 10);
        filtered = filtered.filter(j => hasFitScore(j) && j.experience_fit >= min);
    }

    // Criteria Fit Filter
    if (filters.selectedCritFit && filters.selectedCritFit !== 'all') {
        const min = parseInt(filters.selectedCritFit, 10);
        filtered = filtered.filter(j => j.criteria_fit !== null && j.criteria_fit >= min);
    }

    // Recommendation Filter
    if (filters.selectedRec && filters.selectedRec !== 'all') {
        if (filters.selectedRec === 'unscored') {
            filtered = filtered.filter(j => !hasFitScore(j));
        } else {
            filtered = filtered.filter(j => j.fit_recommendation === filters.selectedRec);
        }
    }

    // Date Posted Filter (shared with the Sourcing Board - see applyDatePostedFilter)
    if (applyDateFilter) {
        filtered = applyDatePostedFilter(filtered, filters.selectedDatePosted);
    }

    // Company Filter
    if (filters.selectedCompany && filters.selectedCompany !== 'all') {
        filtered = filtered.filter(j => (j.company_name || '').toLowerCase().trim() === filters.selectedCompany.toLowerCase().trim());
    }

    return filtered;
}

function handleInsightsSeniorityClick(e) {
    const pill = e.target.closest('.sen-pill');
    if (!pill) return;
    if (!state.insightsFilters) state.insightsFilters = {};
    const f = state.insightsFilters;
    const key = pill.getAttribute('data-sen');
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;

    if (key === 'all') {
        SENIORITY_KEYS.forEach(k => { f['seniority' + k] = true; });
    } else if (additive) {
        // Never let the user reach "nothing selected" — an empty board reads as a bug.
        const on_ = SENIORITY_KEYS.filter(k => f['seniority' + k] !== false);
        if (on_.length === 1 && on_[0] === key) return;
        f['seniority' + key] = f['seniority' + key] === false;
    } else {
        SENIORITY_KEYS.forEach(k => { f['seniority' + k] = (k === key); });
    }
    syncSeniorityPills();
    renderInsightsTab();
}

function initInsightsEventListeners() {
    if (elements.insightsSearchInput) {
        elements.insightsSearchInput.addEventListener('input', (e) => {
            if (!state.insightsFilters) state.insightsFilters = {};
            state.insightsFilters.searchQuery = e.target.value.trim().toLowerCase();
            elements.insightsClearSearch.style.display = state.insightsFilters.searchQuery ? 'block' : 'none';
            renderInsightsTab();
        });
        elements.insightsClearSearch.addEventListener('click', () => {
            elements.insightsSearchInput.value = '';
            if (!state.insightsFilters) state.insightsFilters = {};
            state.insightsFilters.searchQuery = '';
            elements.insightsClearSearch.style.display = 'none';
            renderInsightsTab();
        });
    }

    // Insights seniority pills — same interaction as the Sourcing board's pills.
    // Plain click = that level only. Ctrl/Cmd/Shift click = add or remove a level.
    on(elements.insightsSeniorityPills, 'click', handleInsightsSeniorityClick);
    on(document.getElementById('insights-intake-seniority-pills'), 'click', handleInsightsSeniorityClick);

    const intakeGrainEl = document.getElementById('insights-intake-grain');
    on(intakeGrainEl, 'click', (e) => {
        const pill = e.target.closest('.pill[data-grain]');
        if (!pill) return;
        const grain = pill.getAttribute('data-grain');
        if (!grain || grain === state.insightsIntakeGrain) return;
        state.insightsIntakeGrain = grain;
        renderIntakeTrends();
    });

    const intakeWinEl = document.getElementById('insights-intake-window');
    on(intakeWinEl, 'click', (e) => {
        const pill = e.target.closest('.pill[data-window]');
        if (!pill) return;
        const win = pill.getAttribute('data-window');
        if (!win) return;
        if (!state.insightsIntakeWindowByGrain) {
            state.insightsIntakeWindowByGrain = { day: '30', week: 'all', month: 'all' };
        }
        state.insightsIntakeWindowByGrain[state.insightsIntakeGrain || 'week'] = win;
        renderIntakeTrends();
    });

    if (elements.insightsRegionFilters) {
        elements.insightsRegionFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                elements.insightsRegionFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                if (!state.insightsFilters) state.insightsFilters = {};
                state.insightsFilters.selectedRegion = e.target.getAttribute('data-region');
                renderInsightsTab();
            }
        });
    }

    if (elements.insightsIndustryFilters) {
        elements.insightsIndustryFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                elements.insightsIndustryFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                if (!state.insightsFilters) state.insightsFilters = {};
                state.insightsFilters.selectedIndustry = e.target.getAttribute('data-industry');
                renderInsightsTab();
            }
        });
    }

    if (elements.insightsCompFilters) {
        elements.insightsCompFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                elements.insightsCompFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                if (!state.insightsFilters) state.insightsFilters = {};
                state.insightsFilters.selectedMinComp = e.target.getAttribute('data-comp');
                renderInsightsTab();
            }
        });
    }

    if (elements.insightsExpfitFilters) {
        elements.insightsExpfitFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                elements.insightsExpfitFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                if (!state.insightsFilters) state.insightsFilters = {};
                state.insightsFilters.selectedExpFit = e.target.getAttribute('data-expfit');
                renderInsightsTab();
            }
        });
    }

    if (elements.insightsCritfitFilters) {
        elements.insightsCritfitFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                elements.insightsCritfitFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                if (!state.insightsFilters) state.insightsFilters = {};
                state.insightsFilters.selectedCritFit = e.target.getAttribute('data-critfit');
                renderInsightsTab();
            }
        });
    }

    if (elements.insightsRecFilters) {
        elements.insightsRecFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                elements.insightsRecFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                if (!state.insightsFilters) state.insightsFilters = {};
                state.insightsFilters.selectedRec = e.target.getAttribute('data-rec');
                renderInsightsTab();
            }
        });
    }

    if (elements.insightsDatePostedFilters) {
        elements.insightsDatePostedFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('pill')) {
                elements.insightsDatePostedFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                if (!state.insightsFilters) state.insightsFilters = {};
                state.insightsFilters.selectedDatePosted = e.target.getAttribute('data-dateposted');
                renderInsightsTab();
            }
        });
    }

    if (elements.insightsCompanyFilter) {
        elements.insightsCompanyFilter.addEventListener('change', (e) => {
            if (!state.insightsFilters) state.insightsFilters = {};
            state.insightsFilters.selectedCompany = e.target.value;
            renderInsightsTab();
        });
    }
}

function renderInsightsTab() {
    populateInsightsCompanyFilter();
    
    // Get filtered dataset using Insights tab filter controls
    const filtered = getFilteredJobsForInsights();
    
    // Update summary metric cards
    const total = filtered.length;
    if (elements.insightsStatTotal) elements.insightsStatTotal.innerText = total.toLocaleString();
    
    if (total === 0) {
        if (elements.insightsStatTopco) elements.insightsStatTopco.innerText = '-';
        if (elements.insightsStatDirshare) elements.insightsStatDirshare.innerText = '0%';
        if (elements.insightsStatHighfit) elements.insightsStatHighfit.innerText = '0';
    } else {
        // Top company share
        const coCounts = {};
        filtered.forEach(j => {
            const c = j.company_name || 'Unknown';
            coCounts[c] = (coCounts[c] || 0) + 1;
        });
        const sortedCos = Object.entries(coCounts).sort((a, b) => b[1] - a[1]);
        if (sortedCos.length > 0) {
            const [topCoName, topCoCount] = sortedCos[0];
            const pct = Math.round((topCoCount / total) * 100);
            if (elements.insightsStatTopco) elements.insightsStatTopco.innerText = `${topCoName} (${topCoCount}, ${pct}%)`;
        } else {
            if (elements.insightsStatTopco) elements.insightsStatTopco.innerText = '-';
        }
        
        // Director+ share
        const isDirKeywords = ['director', 'vp', 'vice president', 'head of', 'chief', 'executive', 'principal', 'general manager'];
        const dirCount = filtered.filter(j => isDirKeywords.some(kw => (j.title || '').toLowerCase().includes(kw))).length;
        const dirPct = ((dirCount / total) * 100).toFixed(1);
        if (elements.insightsStatDirshare) elements.insightsStatDirshare.innerText = `${dirPct}% (${dirCount})`;
        
        // High fit roles (80%+)
        const highFitCount = filtered.filter(j => {
            const s = (j.overall_fit_score !== undefined && j.overall_fit_score >= 0) ? j.overall_fit_score : (j.relevancy_score || 0);
            return s >= 80;
        }).length;
        if (elements.insightsStatHighfit) elements.insightsStatHighfit.innerText = highFitCount.toLocaleString();
    }
    
    // Destroy previous Chart instances if they exist
    if (!state.insightsCharts) state.insightsCharts = {};
    Object.keys(state.insightsCharts).forEach(key => {
        if (state.insightsCharts[key]) {
            state.insightsCharts[key].destroy();
        }
    });
    state.insightsCharts = {};
    
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js library not loaded yet.');
        return;
    }

    ensureIntakeJobsLoaded();
    renderIntakeTrends();
    
    const textColor = '#94a3b8';
    const gridColor = 'rgba(148, 163, 184, 0.1)';

    // --- CHART 1: Jobs by Company (Top 10 + 'Other' aggregate) ---
    const companyCounts = {};
    filtered.forEach(j => {
        const c = j.company_name || 'Unknown';
        companyCounts[c] = (companyCounts[c] || 0) + 1;
    });
    const sortedCompanyPairs = Object.entries(companyCounts).sort((a, b) => b[1] - a[1]);
    const top10Companies = sortedCompanyPairs.slice(0, 10);
    const otherCompanyPairs = sortedCompanyPairs.slice(10);
    const otherSum = otherCompanyPairs.reduce((sum, item) => sum + item[1], 0);
    
    const compLabels = top10Companies.map(item => item[0]);
    const compData = top10Companies.map(item => item[1]);
    if (otherSum > 0) {
        compLabels.push(`Other (${otherCompanyPairs.length} co.)`);
        compData.push(otherSum);
    }
    
    const ctxComp = document.getElementById('chart-company');
    if (ctxComp) {
        state.insightsCharts.company = new Chart(ctxComp, {
            type: 'bar',
            data: {
                labels: compLabels,
                datasets: [{
                    label: '# of Jobs',
                    data: compData,
                    backgroundColor: 'rgba(14, 165, 233, 0.75)',
                    borderColor: '#0ea5e9',
                    borderWidth: 1.5,
                    borderRadius: 6
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { cornerRadius: 8, padding: 10 }
                },
                scales: {
                    x: { ticks: { color: textColor }, grid: { color: gridColor } },
                    y: { ticks: { color: textColor, font: { weight: '600' } }, grid: { display: false } }
                }
            }
        });
    }

    // --- CHART 2: Jobs by Seniority (uses the shared classifier so the chart, the
    // Sourcing filter and the Insights filter can never drift apart again) ---
    let earlyCount = 0, midCount = 0, seniorICCount = 0, dirCount = 0;
    filtered.forEach(j => {
        const lvl = classifyJobLevel(j.title);
        if (lvl === 'dir') dirCount++;
        else if (lvl === 'seniorIC') seniorICCount++;
        else if (lvl === 'mid') midCount++;
        else earlyCount++;
    });

    const ctxSen = document.getElementById('chart-seniority');
    if (ctxSen) {
        state.insightsCharts.seniority = new Chart(ctxSen, {
            type: 'doughnut',
            data: {
                labels: ['Early PM / Assoc', 'Mid (Senior PM)', 'Principal (incl. Staff/Group/Lead)', 'Director+ / Executive'],
                datasets: [{
                    data: [earlyCount, midCount, seniorICCount, dirCount],
                    backgroundColor: ['#10b981', '#f59e0b', '#06b6d4', '#a855f7'],
                    borderWidth: 2,
                    borderColor: 'rgba(15, 23, 42, 0.6)'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: textColor, font: { weight: '600' }, padding: 16 } }
                },
                cutout: '65%'
            }
        });
    }

    // --- CHART 3: Jobs by Recommendation Type (Fit Score Slabs) ---
    let highFit = 0, medFit = 0, lowFit = 0, unscored = 0;
    filtered.forEach(j => {
        let score = j.overall_fit_score;
        if (score === undefined || score < 0) score = j.relevancy_score;
        if (score === undefined || score <= 0) {
            unscored++;
        } else if (score >= 80) {
            highFit++;
        } else if (score >= 50) {
            medFit++;
        } else {
            lowFit++;
        }
    });

    const ctxRec = document.getElementById('chart-recommendation');
    if (ctxRec) {
        state.insightsCharts.recommendation = new Chart(ctxRec, {
            type: 'bar',
            data: {
                labels: ['High Fit (80%+)', 'Medium Fit (50-79%)', 'Low Fit (<50%)', 'Unscored / Pending'],
                datasets: [{
                    label: '# of Jobs',
                    data: [highFit, medFit, lowFit, unscored],
                    backgroundColor: ['rgba(16, 185, 129, 0.8)', 'rgba(2, 132, 199, 0.8)', 'rgba(245, 158, 11, 0.8)', 'rgba(148, 163, 184, 0.5)'],
                    borderColor: ['#10b981', '#0284c7', '#f59e0b', '#94a3b8'],
                    borderWidth: 1.5,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: textColor, font: { weight: '600' } }, grid: { display: false } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });
    }

    // --- CHART 4: Jobs by Industry ---
    const industryCounts = {
        'Tech': 0, 'Fintech': 0, 'Banking': 0, 'Biotech': 0, 'Hardware': 0, 
        'Consumer': 0, 'Gaming': 0, 'Media': 0, 'Consulting': 0, 'Health-tech': 0
    };
    
    filtered.forEach(j => {
        const ind = getCompanyCohort(j.company_name);
        if (industryCounts[ind] !== undefined) {
            industryCounts[ind]++;
        } else {
            industryCounts['Tech']++;
        }
    });

    const ctxInd = document.getElementById('chart-industry');
    if (ctxInd) {
        state.insightsCharts.industry = new Chart(ctxInd, {
            type: 'bar',
            data: {
                labels: Object.keys(industryCounts),
                datasets: [{
                    label: '# of Jobs',
                    data: Object.values(industryCounts),
                    backgroundColor: 'rgba(245, 158, 11, 0.75)',
                    borderColor: '#f59e0b',
                    borderWidth: 1.5,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: textColor, font: { size: 10, weight: '600' } }, grid: { display: false } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });
    }

    // --- CHART 5: Jobs by Compensation Slabs ---
    const compSlabs = { '<$150k': 0, '$150k-$200k': 0, '$200k-$250k': 0, '$250k+': 0, 'Undisclosed / N/A': 0 };
    filtered.forEach(j => {
        const num = parseSalaryNumber(j.salary);
        if (num === null) {
            compSlabs['Undisclosed / N/A']++;
        } else if (num < 150000) {
            compSlabs['<$150k']++;
        } else if (num < 200000) {
            compSlabs['$150k-$200k']++;
        } else if (num < 250000) {
            compSlabs['$200k-$250k']++;
        } else {
            compSlabs['$250k+']++;
        }
    });

    const ctxCompSlab = document.getElementById('chart-comp');
    if (ctxCompSlab) {
        state.insightsCharts.comp = new Chart(ctxCompSlab, {
            type: 'bar',
            data: {
                labels: Object.keys(compSlabs),
                datasets: [{
                    label: '# of Jobs',
                    data: Object.values(compSlabs),
                    backgroundColor: ['rgba(139, 92, 246, 0.65)', 'rgba(124, 58, 237, 0.75)', 'rgba(109, 40, 217, 0.85)', 'rgba(91, 33, 182, 0.95)', 'rgba(100, 116, 139, 0.4)'],
                    borderColor: '#8b5cf6',
                    borderWidth: 1.5,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: textColor, font: { weight: '600' } }, grid: { display: false } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });
    }
}

const INTAKE_LEVEL_META = [
    { key: 'Early',    lvl: 'early',    label: 'Early',     color: '#64748b' },
    { key: 'Mid',      lvl: 'mid',      label: 'Mid',       color: '#0ea5e9' },
    { key: 'SeniorIC', lvl: 'seniorIC', label: 'Principal', color: '#8b5cf6' },
    { key: 'Dir',      lvl: 'dir',      label: 'Dir+',      color: '#f59e0b' }
];

// Lazy-loads full job history (Lead + Consideration + Archived) so DoD/WoW/MoM
// intake counts reflect every role that arrived on the board, not just still-open ones.
function ensureIntakeJobsLoaded() {
    if (Array.isArray(state.allJobsWithArchived)) {
        return Promise.resolve(state.allJobsWithArchived);
    }
    if (state._intakeJobsPromise) return state._intakeJobsPromise;

    state._intakeJobsPromise = fetch('/api/jobs?include_archived=true')
        .then(res => res.json())
        .then(jobs => {
            state.allJobsWithArchived = Array.isArray(jobs) ? jobs : [];
            state._intakeJobsPromise = null;
            if (state.activeTab === 'insights') renderIntakeTrends();
            return state.allJobsWithArchived;
        })
        .catch(err => {
            console.error('Failed to fetch archived jobs for intake trends:', err);
            state._intakeJobsPromise = null;
            return state.allJobs;
        });
    return state._intakeJobsPromise;
}

function formatIntakeDelta(delta, prior) {
    if (delta === null || prior === null) {
        return { text: '—', cls: 'flat' };
    }
    const sign = delta > 0 ? '+' : '';
    if (prior === 0) {
        return {
            text: delta === 0 ? '0' : `${sign}${delta}`,
            cls: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
        };
    }
    const pct = Math.round((delta / prior) * 100);
    const pctSign = pct > 0 ? '+' : '';
    return {
        text: `${sign}${delta} (${pctSign}${pct}%)`,
        cls: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    };
}

// Aggregates filtered jobs by first_seen_at into gap-filled DoD/WoW/MoM buckets,
// computing period-over-period deltas BEFORE slicing to the requested lookback window.
function computeIntakeSeries(jobs, grain, windowKey) {
    const dated = [];
    let activeCount = 0;
    let archivedCount = 0;

    (jobs || []).forEach(job => {
        const d = (job.first_seen_at || '').substring(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
        const lvl = classifyJobLevel(job.title);
        dated.push({ date: d, lvl, archived: job.status === 'Archived' });
    });

    const buckets = buildTimeBuckets(dated.map(x => x.date), grain).map(b => ({
        ...b,
        early: 0,
        mid: 0,
        seniorIC: 0,
        dir: 0,
        active: 0,
        archived: 0,
        priorCount: null,
        delta: null,
        pctDelta: null,
        inProgress: false
    }));

    const byKey = Object.fromEntries(buckets.map(b => [b.key, b]));
    dated.forEach(item => {
        const b = byKey[bucketKeyFor(item.date, grain)];
        if (!b) return;
        b.count++;
        if (b[item.lvl] !== undefined) b[item.lvl]++;
        if (item.archived) b.archived++;
        else b.active++;
    });

    for (let i = 0; i < buckets.length; i++) {
        if (i === buckets.length - 1) buckets[i].inProgress = true;
        if (i > 0) {
            const prev = buckets[i - 1].count;
            const cur = buckets[i].count;
            buckets[i].priorCount = prev;
            buckets[i].delta = cur - prev;
            buckets[i].pctDelta = prev > 0 ? ((cur - prev) / prev) * 100 : null;
        }
    }

    let visible = buckets;
    if (windowKey && windowKey !== 'all' && buckets.length > 0) {
        const days = parseInt(windowKey, 10);
        if (!isNaN(days) && days > 0) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - (days - 1));
            const minBucketKey = bucketKeyFor(ymdLocal(cutoff), grain);
            visible = buckets.filter(b => b.key >= minBucketKey);
        }
    }

    visible.forEach(b => {
        activeCount += b.active;
        archivedCount += b.archived;
    });

    return {
        allBuckets: buckets,
        visible,
        totalDated: visible.reduce((s, b) => s + b.count, 0),
        activeCount,
        archivedCount
    };
}

function renderIntakeTrends() {
    const grain = state.insightsIntakeGrain || 'week';
    const winMap = state.insightsIntakeWindowByGrain || { day: '30', week: 'all', month: 'all' };
    const windowKey = winMap[grain] || (grain === 'day' ? '30' : 'all');

    // Sync cadence & window pills cleanly with active state.
    const grainWrap = document.getElementById('insights-intake-grain');
    if (grainWrap) {
        grainWrap.querySelectorAll('.pill[data-grain]').forEach(p => {
            p.classList.toggle('active', p.getAttribute('data-grain') === grain);
        });
    }
    const winWrap = document.getElementById('insights-intake-window');
    if (winWrap) {
        winWrap.querySelectorAll('.pill[data-window]').forEach(p => {
            p.classList.toggle('active', p.getAttribute('data-window') === windowKey);
        });
    }

    const usingArchived = Array.isArray(state.allJobsWithArchived);
    const sourceJobs = usingArchived ? state.allJobsWithArchived : state.allJobs;
    const filtered = getFilteredJobsForInsights(sourceJobs, { includeArchived: true, applyDateFilter: false });
    const series = computeIntakeSeries(filtered, grain, windowKey);

    const grainLabels = {
        day:   { adj: 'Daily',   unit: 'Day',   short: 'DoD', currentLbl: 'Today (in progress)',     prevLbl: 'Yesterday' },
        week:  { adj: 'Weekly',  unit: 'Week',  short: 'WoW', currentLbl: 'This Week (WTD)',          prevLbl: 'Last Full Week' },
        month: { adj: 'Monthly', unit: 'Month', short: 'MoM', currentLbl: 'This Month (MTD)',         prevLbl: 'Last Full Month' }
    };
    const meta = grainLabels[grain] || grainLabels.week;

    const subEl = document.getElementById('insights-intake-subtitle');
    if (subEl) {
        const activeLevels = INTAKE_LEVEL_META
            .filter(m => (state.insightsFilters || {})['seniority' + m.key] !== false)
            .map(m => m.label);
        const senNote = activeLevels.length === INTAKE_LEVEL_META.length
            ? 'All seniority tiers'
            : activeLevels.join(' + ');
        const histNote = usingArchived
            ? 'full board intake history (active + archived)'
            : 'loading archived history...';
        subEl.textContent = `${senNote} · ${histNote} (note: historical first-seen dates omit deleted rows, if any)`;
    }

    const chartHeading = document.getElementById('insights-intake-chart-heading');
    if (chartHeading) chartHeading.textContent = `${meta.adj} New Jobs by Seniority`;
    const tableHeading = document.getElementById('insights-intake-table-heading');
    if (tableHeading) tableHeading.textContent = `Recent ${meta.adj} Changes (${meta.short})`;
    const deltaCol = document.getElementById('insights-intake-delta-col');
    if (deltaCol) deltaCol.textContent = `${meta.short} Δ`;

    // --- KPI Cards ---
    const kpiEl = document.getElementById('insights-intake-kpis');
    if (kpiEl) {
        const allB = series.allBuckets;
        const curB = allB.length ? allB[allB.length - 1] : null;
        const prevB = allB.length >= 2 ? allB[allB.length - 2] : null;
        const priorCompleteB = allB.length >= 3 ? allB[allB.length - 3] : null;

        // Prefer complete-period-to-complete-period comparison when >= 3 buckets exist so an
        // in-progress day/week/month does not look like a sudden artificial drop.
        const cmpTarget = priorCompleteB ? prevB : curB;
        const cmpBase = priorCompleteB ? priorCompleteB : prevB;
        const cmpDelta = (cmpTarget && cmpBase)
            ? formatIntakeDelta(cmpTarget.count - cmpBase.count, cmpBase.count)
            : { text: '—', cls: 'flat' };
        const cmpSub = (cmpTarget && cmpBase)
            ? `${cmpTarget.label} vs ${cmpBase.label}`
            : 'Need 2+ periods';

        const completeVisible = series.visible.length > 1 ? series.visible.slice(0, -1) : series.visible;
        const avgPerPeriod = completeVisible.length
            ? (completeVisible.reduce((s, b) => s + b.count, 0) / completeVisible.length).toFixed(1)
            : '0.0';

        const kpiCards = [
            {
                val: curB ? curB.count.toLocaleString() : '0',
                lbl: meta.currentLbl,
                sub: curB ? curB.label : 'No dated roles'
            },
            {
                val: prevB ? prevB.count.toLocaleString() : '—',
                lbl: meta.prevLbl,
                sub: prevB ? prevB.label : 'No prior period'
            },
            {
                val: `<span class="intake-delta ${cmpDelta.cls}">${escapeHtml(cmpDelta.text)}</span>`,
                lbl: `${meta.short} Change`,
                sub: cmpSub,
                rawHtml: true
            },
            {
                val: avgPerPeriod,
                lbl: `Avg / Complete ${meta.unit}`,
                sub: `${completeVisible.length} ${meta.unit.toLowerCase()}${completeVisible.length === 1 ? '' : 's'} in range`
            },
            {
                val: series.totalDated.toLocaleString(),
                lbl: 'New Jobs in Range',
                sub: `${series.activeCount.toLocaleString()} active · ${series.archivedCount.toLocaleString()} archived`
            }
        ];

        kpiEl.innerHTML = kpiCards.map(c => `
            <div class="apps-kpi">
                <div class="apps-kpi-val">${c.rawHtml ? c.val : escapeHtml(String(c.val))}</div>
                <div class="apps-kpi-lbl">${escapeHtml(c.lbl)}</div>
                <div class="insights-intake-kpi-sub">${escapeHtml(c.sub)}</div>
            </div>
        `).join('');
    }

    // --- Recent Periods Comparison Table ---
    const tbody = document.getElementById('insights-intake-table-body');
    if (tbody) {
        const recent = series.visible.slice(-14).reverse();
        if (!recent.length) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-secondary);padding:16px;">No roles match the selected filters.</td></tr>`;
        } else {
            tbody.innerHTML = recent.map(b => {
                const dInfo = formatIntakeDelta(b.delta, b.priorCount);
                const tag = b.inProgress ? ' <span title="Current in-progress period">*</span>' : '';
                return `<tr class="${b.inProgress ? 'in-progress' : ''}">
                    <td>${escapeHtml(b.label)}${tag}</td>
                    <td class="num"><strong>${b.count.toLocaleString()}</strong></td>
                    <td class="num">${b.priorCount === null ? '—' : b.priorCount.toLocaleString()}</td>
                    <td class="num"><span class="intake-delta ${dInfo.cls}">${escapeHtml(dInfo.text)}</span></td>
                </tr>`;
            }).join('');
        }
    }

    // --- Chart.js Stacked Intake Bar Chart ---
    if (typeof Chart === 'undefined') return;
    if (!state.insightsCharts) state.insightsCharts = {};
    if (state.insightsCharts.intakeTrend) {
        state.insightsCharts.intakeTrend.destroy();
        delete state.insightsCharts.intakeTrend;
    }

    const ctx = document.getElementById('chart-intake-trend');
    if (!ctx) return;

    const f = state.insightsFilters || {};
    const activeMeta = INTAKE_LEVEL_META.filter(m => f['seniority' + m.key] !== false);
    const textColor = document.documentElement.classList.contains('light-theme') ? '#475569' : '#94a3b8';
    const gridColor = document.documentElement.classList.contains('light-theme') ? 'rgba(15, 23, 42, 0.08)' : 'rgba(148, 163, 184, 0.1)';

    const datasets = activeMeta.map(m => ({
        label: m.label,
        data: series.visible.map(b => b[m.lvl] || 0),
        backgroundColor: m.color,
        borderRadius: activeMeta.length === 1 ? 6 : 2,
        maxBarThickness: 44
    }));

    state.insightsCharts.intakeTrend = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: series.visible.map(b => b.inProgress ? `${b.label} *` : b.label),
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: activeMeta.length > 1,
                    position: 'top',
                    labels: { color: textColor, boxWidth: 12, font: { size: 11, weight: '600' } }
                },
                tooltip: {
                    cornerRadius: 8,
                    padding: 10,
                    callbacks: {
                        afterBody: (items) => {
                            if (!items || !items.length) return [];
                            const b = series.visible[items[0].dataIndex];
                            if (!b) return [];
                            const dInfo = formatIntakeDelta(b.delta, b.priorCount);
                            const lines = [`Total: ${b.count.toLocaleString()} (${b.active} active, ${b.archived} archived)`];
                            if (b.priorCount !== null) {
                                lines.push(`${meta.short} vs prior (${b.priorCount.toLocaleString()}): ${dInfo.text}`);
                            }
                            if (b.inProgress) lines.push('* Period in progress');
                            return lines;
                        }
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { color: textColor, maxRotation: 0, autoSkip: true },
                    grid: { display: false }
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { color: textColor, precision: 0 },
                    grid: { color: gridColor }
                }
            }
        }
    });
}

// 1. Sourcing Tab Renderer
function renderSourcingTab() {
    // Populate filters
    populateCompanyFilter();
    
    // Filter active leads (status = 'Lead' or including closed if check active)
    let filtered = state.allJobs.filter(j => {
        // Starred rows carry status 'Consideration' — they must stay on the board
        // (filtering to 'Lead' was silently hiding everything you actioned).
        return j.status !== 'Archived';
    });
    
    // Query filter
    if (state.searchQuery) {
        filtered = filtered.filter(j => 
            j.title.toLowerCase().includes(state.searchQuery) ||
            j.company_name.toLowerCase().includes(state.searchQuery) ||
            j.location.toLowerCase().includes(state.searchQuery)
        );
    }
    
    // Company Filter
    if (state.selectedCompany !== 'all') {
        filtered = filtered.filter(j => j.company_name.toLowerCase().trim() === state.selectedCompany.toLowerCase().trim());
    }
    
    // Seniority Checkbox Filters (shared classifier - see classifyJobLevel)
    filtered = filtered.filter(j => passesSeniorityFilter(j, state));

    // Mag 7 company filter (replaced the Region filter - the crawl is already scoped to
    // preferred locations, so region was slicing an already-filtered set).
    if (state.selectedMag7 !== 'all') {
        filtered = filtered.filter(j => matchesMag7(j.company_name, state.selectedMag7));
    }

    // Industry filter (compares with company's cohort column which stores the industry)
    if (state.selectedIndustry !== 'all') {
        filtered = filtered.filter(j => {
            const co = state.trackedCompanies.find(c => c.name.toLowerCase().trim() === j.company_name.toLowerCase().trim());
            return co && co.cohort === state.selectedIndustry;
        });
    }

    // Min Comp filter
    if (state.selectedMinComp !== 'all') {
        filtered = filtered.filter(j => {
            const minK = parseInt(state.selectedMinComp);
            const val = parseSalaryNumber(j.salary);
            return val >= minK * 1000;
        });
    }

    // Experience Fit / Criteria Fit thresholds. Unscored jobs (-1/null) are excluded
    // whenever a threshold is set, since we can't claim they meet a bar we never measured.
    if (state.selectedExpFit !== 'all') {
        const min = parseInt(state.selectedExpFit);
        filtered = filtered.filter(j => hasFitScore(j) && j.experience_fit >= min);
    }
    if (state.selectedCritFit !== 'all') {
        const min = parseInt(state.selectedCritFit);
        filtered = filtered.filter(j => j.criteria_fit !== null && j.criteria_fit >= min);
    }

    // Recommendation filter ('unscored' surfaces jobs still awaiting evaluation)
    if (state.selectedRec !== 'all') {
        if (state.selectedRec === 'unscored') {
            filtered = filtered.filter(j => !hasFitScore(j));
        } else {
            filtered = filtered.filter(j => j.fit_recommendation === state.selectedRec);
        }
    }

    // N/A-only filter (set by clicking the N/A badge): assessed but not scorable (exp = -2)
    if (state.showOnlyNA) {
        filtered = filtered.filter(j => j.experience_fit === -2);
    }

    // Date Posted filter (shared with Market Insights - see applyDatePostedFilter).
    filtered = applyDatePostedFilter(filtered, state.selectedDatePosted);

    // Update source counts before applying source checkbox filter
    const isScraperSource = (j) => (j.source || 'NewPMJobs') === 'Company Scraper';
    const newPmCount = filtered.filter(j => !isScraperSource(j)).length;
    const scraperCount = filtered.filter(j => isScraperSource(j)).length;
    const countNewPmEl = document.getElementById('count-source-newpmjobs');
    const countScraperEl = document.getElementById('count-source-scraper');
    if (countNewPmEl) countNewPmEl.textContent = `(${newPmCount.toLocaleString()})`;
    if (countScraperEl) countScraperEl.textContent = `(${scraperCount.toLocaleString()})`;

    // Source checkbox filter (NewPMJobs vs Individual Company Scrapers)
    filtered = filtered.filter(j => {
        const isScraper = isScraperSource(j);
        if (isScraper && !state.sourceCompanyScraper) return false;
        if (!isScraper && !state.sourceNewPMJobs) return false;
        return true;
    });

    // Hide roles already acted on: starred/tracked, or with a tailored resume
    // queued/in-progress/done. Those need no further triage decision.
    if (state.showOnlyActioned) {
        filtered = filtered.filter(isActionedJob);
    } else if (state.hideActioned) {
        filtered = filtered.filter(j => !isActionedJob(j));
    }

    // Sorting
    filtered.sort((a, b) => {
        if (state.selectedSort === 'recommended_desc') {
            return recommendedRank(b) - recommendedRank(a);
        }
        if (state.selectedSort === 'exp_fit_desc') {
            const scoreA = (a.experience_fit !== null && a.experience_fit !== undefined && a.experience_fit !== -1) ? a.experience_fit : -99;
            const scoreB = (b.experience_fit !== null && b.experience_fit !== undefined && b.experience_fit !== -1) ? b.experience_fit : -99;
            return scoreB - scoreA;
        }
        if (state.selectedSort === 'exp_fit_asc') {
            const scoreA = (a.experience_fit !== null && a.experience_fit !== undefined && a.experience_fit !== -1) ? a.experience_fit : 99;
            const scoreB = (b.experience_fit !== null && b.experience_fit !== undefined && b.experience_fit !== -1) ? b.experience_fit : 99;
            return scoreA - scoreB;
        }
        if (state.selectedSort === 'crit_fit_desc') {
            const scoreA = (a.criteria_fit !== null && a.criteria_fit !== undefined && a.criteria_fit !== -1) ? a.criteria_fit : -99;
            const scoreB = (b.criteria_fit !== null && b.criteria_fit !== undefined && b.criteria_fit !== -1) ? b.criteria_fit : -99;
            return scoreB - scoreA;
        }
        if (state.selectedSort === 'crit_fit_asc') {
            const scoreA = (a.criteria_fit !== null && a.criteria_fit !== undefined && a.criteria_fit !== -1) ? a.criteria_fit : 99;
            const scoreB = (b.criteria_fit !== null && b.criteria_fit !== undefined && b.criteria_fit !== -1) ? b.criteria_fit : 99;
            return scoreA - scoreB;
        }
        if (state.selectedSort === 'rec_desc') {
            const map = { 'Apply': 3, 'Stretch': 2, 'Skip': 1 };
            const valA = map[a.fit_recommendation] || 0;
            const valB = map[b.fit_recommendation] || 0;
            return valB - valA;
        }
        if (state.selectedSort === 'rec_asc') {
            const map = { 'Apply': 3, 'Stretch': 2, 'Skip': 1 };
            const valA = map[a.fit_recommendation] || 0;
            const valB = map[b.fit_recommendation] || 0;
            return valA - valB;
        }
        if (state.selectedSort === 'connections_desc') {
            const countA = getLinkedInConnectionsForJob(a).length;
            const countB = getLinkedInConnectionsForJob(b).length;
            return countB - countA;
        }
        if (state.selectedSort === 'connections_asc') {
            const countA = getLinkedInConnectionsForJob(a).length;
            const countB = getLinkedInConnectionsForJob(b).length;
            return countA - countB;
        }
        if (state.selectedSort === 'company_asc') {
            return a.company_name.localeCompare(b.company_name);
        }
        if (state.selectedSort === 'company_desc') {
            return b.company_name.localeCompare(a.company_name);
        }
        if (state.selectedSort === 'title_asc') {
            return a.title.localeCompare(b.title);
        }
        if (state.selectedSort === 'title_desc') {
            return b.title.localeCompare(a.title);
        }
        if (state.selectedSort === 'location_asc') {
            return formatLocationConcise(a.location, a.title).localeCompare(formatLocationConcise(b.location, b.title));
        }
        if (state.selectedSort === 'location_desc') {
            return formatLocationConcise(b.location, b.title).localeCompare(formatLocationConcise(a.location, a.title));
        }
        if (state.selectedSort === 'salary_desc') {
            return parseSalaryNumber(b.salary) - parseSalaryNumber(a.salary);
        }
        if (state.selectedSort === 'salary_asc') {
            return parseSalaryNumber(a.salary) - parseSalaryNumber(b.salary);
        }
        if (state.selectedSort === 'relevancy_desc') {
            return b.relevancy_score - a.relevancy_score;
        }
        if (state.selectedSort === 'date_desc') {
            const dateA = a.first_seen_at || '0000-00-00';
            const dateB = b.first_seen_at || '0000-00-00';
            return dateB.localeCompare(dateA);
        }
        if (state.selectedSort === 'date_asc') {
            const dateA = a.first_seen_at || '0000-00-00';
            const dateB = b.first_seen_at || '0000-00-00';
            return dateA.localeCompare(dateB);
        }
        if (state.selectedSort === 'source_asc') {
            return (a.source || 'NewPMJobs').localeCompare(b.source || 'NewPMJobs');
        }
        if (state.selectedSort === 'source_desc') {
            return (b.source || 'NewPMJobs').localeCompare(a.source || 'NewPMJobs');
        }
        return 0;
    });

    // Expose the post-filter list so the bulk fit-scorer only touches what's on screen.
    state.visibleJobs = filtered;

    elements.loadingState.style.display = 'none';
    elements.emptyState.style.display = filtered.length === 0 ? 'block' : 'none';

    // Update badge count & scoring stats (active rows, incl. starred — see updateSidebarCounts)
    elements.badgeLeads.innerText = state.allJobs.filter(j => j.status !== 'Archived').length;
    updateScoringStatsBanner();
    updateSourcingHeaderStats();

    // Update Sourcing Results Bar Counter
    const totalLeads = state.allJobs.filter(j => j.status !== 'Archived').length;
    if (elements.sourcingCountText) {
        elements.sourcingCountText.innerText = `Showing ${filtered.length.toLocaleString()} of ${totalLeads.toLocaleString()} job leads`;
    }
    if (elements.sourcingSubcountText) {
        if (filtered.length === totalLeads) {
            elements.sourcingSubcountText.innerText = `All filters matching`;
        } else {
            elements.sourcingSubcountText.innerText = `${(totalLeads - filtered.length).toLocaleString()} filtered out`;
        }
    }

    if (state.currentLayout === 'grid') {
        elements.jobsGrid.style.display = filtered.length > 0 ? 'grid' : 'none';
        elements.jobsListWrapper.style.display = 'none';
        elements.jobsGrid.innerHTML = filtered.map(j => renderJobCard(j)).join('');
    } else {
        elements.jobsGrid.style.display = 'none';
        elements.jobsListWrapper.style.display = filtered.length > 0 ? 'block' : 'none';
        elements.jobsListBody.innerHTML = filtered.map(j => renderJobListRow(j)).join('');
    }
}

// Render Sourcing Cards
function renderJobCard(job) {
    const co = state.trackedCompanies.find(c => c.name.toLowerCase().trim() === job.company_name.toLowerCase().trim());
    const cohortClass = co ? getCohortBadgeClass(co.cohort) : 'cohort-other';
    const cohortName = co ? co.cohort : 'Tech';
    
    // Find connections count
    const connCount = state.connections.filter(c => c.company.toLowerCase().includes(job.company_name.toLowerCase())).length;
    const connText = connCount > 0 ? `<span class="card-tag conn-tag"><i class="fa-solid fa-users"></i> ${connCount} Contacts</span>` : '';
    
    // Add Closed badge if archived
    const closedBadge = job.status === 'Archived' ? `<span style="font-size:0.65rem; background:#ef4444; color:#fff; padding:2px 6px; border-radius:4px; margin-right:8px; font-weight:700;">CLOSED</span>` : '';
    
    return `
        <div class="job-card" onclick="openJobDetails('${job.id}')" style="position: relative;">
            <div class="score-badge">${job.relevancy_score}% Match</div>
            <div class="job-card-header">
                <h3 class="job-card-title">${job.title}</h3>
                <span class="job-card-company">${job.company_name}</span>
            </div>
            <div class="job-card-body">
                <div class="job-meta-row">
                    <span class="meta-item" title="${escapeAttr(job.location || 'N/A')}"><i class="fa-solid fa-location-dot"></i> ${formatLocationConcise(job.location, job.title)}</span>
                    <span class="meta-item"><i class="fa-solid fa-money-bill-wave"></i> ${job.salary || 'N/A'}</span>
                </div>
                <p class="job-card-snippet">${job.notes ? job.notes.substring(0, 100) + '...' : 'No description available. Click to parse details.'}</p>
            </div>
            <div class="job-card-footer">
                ${closedBadge}
                <span class="card-tag ${cohortClass}">${cohortName}</span>
                ${connText}
            </div>
        </div>
    `;
}

// Render Sourcing List row
function renderJobListRow(job) {
    // Uses the shared classifier so the badge always agrees with the seniority filter.
    // (This badge previously had its own keyword list, so selecting "Principal" could
    // surface rows still labelled Mid or Early.)
    const LEVEL_BADGE = {
        dir:      '<span class="badge-level level-dir">Dir+</span>',
        seniorIC: '<span class="badge-level level-senioric">Principal</span>',
        mid:      '<span class="badge-level level-mid">Mid</span>',
        early:    '<span class="badge-level level-early">Early</span>'
    };
    const levelBadge = LEVEL_BADGE[classifyJobLevel(job.title)] || LEVEL_BADGE.early;

    const isStarred = isJobStarred(job);
    const starIcon = isStarred ? '<i class="fa-solid fa-star starred"></i>' : '<i class="fa-regular fa-star unstarred"></i>';

    return `
        <tr id="job-row-${job.id}" onclick="openJobDetails('${job.id}')" style="cursor: pointer;">
            <td style="text-align: center;" onclick="event.stopPropagation(); toggleTrackJob('${job.id}')">${starIcon}</td>
            <td style="font-weight: 700; color: var(--text-primary);">${job.company_name}</td>
            <td>${job.title}</td>
            <td title="${escapeAttr(job.location || 'N/A')}" style="white-space: nowrap;"><i class="fa-solid fa-location-dot" style="color: #64748b; margin-right: 4px; font-size: 0.75rem;"></i> ${formatLocationConcise(job.location, job.title)}</td>
            <td>${levelBadge}</td>
            <td>${formatSalaryCompact(job.salary)}</td>
            <td>${formatDateFriendly(job.first_seen_at)}</td>
            <td style="text-align: center;">${renderSourceBadge(job)}</td>
            <td class="fit-cell" id="fit-exp-${job.id}" style="text-align: center;">${renderFitBadge(job, 'experience')}</td>
            <td class="fit-cell" id="fit-crit-${job.id}" style="text-align: center;">${renderFitBadge(job, 'criteria')}</td>
            <td class="rec-cell" id="fit-rec-${job.id}" style="text-align: center;">${renderRecBadge(job)}</td>
            <td class="conn-cell" id="conn-cell-${job.id}" style="text-align: center;">${renderLinkedInConnectionsBadge(job)}</td>
            <td style="text-align: right; padding-right: 24px;">
                <a href="${job.url}" target="_blank" class="view-link" onclick="event.stopPropagation();">
                    View <i class="fa-solid fa-arrow-up-right-from-square" style="font-size: 0.7rem; margin-left: 2px;"></i>
                </a>
            </td>
        </tr>
    `;
}

// A role is "actioned" once you've starred it or a tailored resume exists/is queued —
// i.e. you've already made the call, so it shouldn't clutter the triage view.
// A job is starred when YOU actioned it — not merely because it has a pipeline_status.
// Archived rows carry pipeline_status='Archived', which the old inline test
// (pipeline_status !== 'Sourced') read as starred, so every closed job rendered with a
// filled star. Defined once so the row, the modal and the actioned-count agree.
function normKey(s) { return (s || '').toString().toLowerCase().trim(); }

// Rebuild the authoritative "actioned" lookups from the two lists the user compares against:
// Under Consideration (apply_requests, keyed by job_id) and the Applications pipeline
// (applications, keyed by company+role because that table has no job_id). Call this whenever
// either list is (re)fetched so the board's stars and actioned-filter stay in lockstep.
function rebuildActionedSets() {
    const ids = new Set();
    (state.consideration || []).forEach(r => { if (r && r.job_id) ids.add(r.job_id); });
    const keys = new Set();
    (state.applications || []).forEach(a => {
        if (!a) return;
        const co = a.company != null ? a.company : a.company_name;
        const role = a.role != null ? a.role : a.title;
        keys.add(normKey(co) + '' + normKey(role));
    });
    state._actionedIds = ids;
    state._appKeys = keys;
}

// Starred === the role is actually in Under Consideration OR the Applications pipeline.
// Driving this off those two lists (not the mutable jobs.status / a leftover résumé) is what
// keeps the board honest: a submitted role that LEFT Under Consideration still shows a star
// (it's in Applications), and a role with a stale status or an orphaned résumé does not.
function isJobStarred(job) {
    if (!job) return false;
    // The server matches each posting against the Applications pipeline (by URL, then by
    // punctuation-insensitive company + title), which catches reposts the exact-string key
    // below misses. An applied role always shows its star.
    if (job.already_applied) return true;
    // Until Under Consideration has loaded once, fall back to the status flag so stars don't
    // blank out on first paint or if the fetch fails.
    if (!state._actionedLoaded) return job.status === 'Consideration';
    if (state._actionedIds.has(job.id)) return true;                       // in Under Consideration
    if (state._appKeys.size) {                                             // in the Applications pipeline
        if (state._appKeys.has(normKey(job.company_name) + '' + normKey(job.title))) return true;
    }
    return false;
}

// Actioned === starred (in Under Consideration or the Applications pipeline). No separate
// "has a résumé" clause: starring is what queues a résumé, so a genuinely actioned role is
// already in one of those two lists; a leftover résumé on an un-starred role is not actioned.
function isActionedJob(job) {
    if (!job || job.status === 'Archived') return false;
    return isJobStarred(job);
}

// Composite "Recommended for You" rank: Apply outranks Stretch outranks Skip, then by
// combined fit strength. Unscored jobs sort last so they never crowd out real matches.
function recommendedRank(job) {
    if (!hasFitScore(job)) return -1;
    const recWeight = { Apply: 200, Stretch: 100, Skip: 0 }[job.fit_recommendation] ?? 50;
    const exp = job.experience_fit || 0;
    const crit = job.criteria_fit || 0;
    // Weight both dimensions equally, and reward roles that are strong on BOTH
    // (min term) rather than lopsided ones.
    return recWeight + (exp + crit) * 2 + Math.min(exp, crit);
}

// --- ROLE FIT SCORING (role-fit-evaluator rubric, computed server-side via Gemini) ---

// Scores are cached in the DB. -1 / null means "never scored" so an honest 0 stays 0.
function hasFitScore(job) {
    return job.experience_fit !== null && job.experience_fit !== undefined && job.experience_fit >= 0;
}

function fitTier(score) {
    if (score >= 8) return 'fit-strong';
    if (score >= 5) return 'fit-moderate';
    return 'fit-weak';
}

// Which model produced a fit score, as a short visible label + a color class. Kept in one
// place so every surface (Sourcing Board, Under Consideration) labels scores identically.
function fitModelLabel(fitModel) {
    const fm = fitModel || '';
    if (/gemini/i.test(fm)) return 'Gemini';
    if (/opus|claude|sonnet/i.test(fm)) return 'Claude';
    if (/120b|70b/i.test(fm)) return '120B';
    if (/20b/i.test(fm)) return '20B';
    if (/llama|8b/i.test(fm)) return '8B';
    return '';
}
function fitModelClass(fitModel) {
    const fm = fitModel || '';
    if (/gemini/i.test(fm)) return 'model-gemini';
    if (/opus|claude|sonnet/i.test(fm)) return 'model-claude';
    if (/120b|70b/i.test(fm)) return 'model-120b';
    return 'model-small';   // gpt-oss-20b bulk, legacy llama/8b, or unknown
}
// True for a "final" score no re-score button is offered for. Only Claude (Opus/Sonnet) and
// Gemini count as final. Groq scores (20B, 8B, 120B, 70B) all keep the per-row wand so any of
// them can be selectively queued for a Claude (Opus) re-score.
function isFinalFitModel(fitModel) {
    return /gemini|opus|claude|sonnet/i.test(fitModel || '');
}

// SCORE_NA sentinel: the role WAS assessed but a dimension couldn't be scored (no usable JD).
const FIT_NA = -2;

function renderFitBadge(job, dimension) {
    const score = dimension === 'experience' ? job.experience_fit : job.criteria_fit;
    const never = (v) => v === null || v === undefined || v === -1;
    // "Assessed" = has a real score on either dimension, OR was explicitly marked N/A.
    const assessed = job.experience_fit >= 0 || job.criteria_fit >= 0
                     || job.experience_fit === FIT_NA || job.criteria_fit === FIT_NA;

    // Never assessed at all -> offer the Score trigger (experience column only).
    if (!assessed) {
        if (dimension === 'experience') {
            return `<button class="btn-fit-score" onclick="event.stopPropagation(); scoreJobFit('${job.id}')" title="Score this role with the role-fit evaluator">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Score
                    </button>`;
        }
        return '<span class="fit-empty">—</span>';
    }

    const fm = job.fit_model || '';
    const note = dimension === 'experience' ? job.fit_experience_note : job.fit_criteria_note;
    const queued = job.claude_rescore_status === 'queued';

    // The score / N-A / dash badge for THIS dimension.
    let badge;
    if (score === FIT_NA) {
        // Assessed but not scorable: show N/A and explain WHY on hover.
        const reason = (job.fit_flag && job.fit_flag.trim())
            ? job.fit_flag
            : (note || 'No usable job description was available to score against.');
        const naTip = `N/A — ${reason}\n\nScored by: ${fm || 'unknown'}`;
        badge = `<span class="badge-fit fit-na" title="${escapeAttr(naTip)}">N/A</span>`;
    } else if (never(score)) {
        badge = '<span class="fit-empty" title="Not scored for this dimension">—</span>';
    } else {
        const tip = [note, job.fit_flag ? `Flag: ${job.fit_flag}` : '',
                     job.fit_recommendation ? `Recommendation: ${job.fit_recommendation}` : '',
                     `Scored by: ${fm || 'unknown'}`].filter(Boolean).join('\n\n');
        badge = `<span class="badge-fit ${fitTier(score)}" title="${escapeAttr(tip)}">${score}<span class="fit-denom">/10</span></span>`;
    }

    // Always show which model produced the assessment, readable without hovering.
    const label = fitModelLabel(fm);
    const modelBadge = label
        ? `<span class="precision-badge ${fitModelClass(fm)}" title="Scored by ${escapeAttr(fm || 'unknown')}">${label}</span>`
        : '';
    const queuedTag = (queued && dimension === 'experience')
        ? '<span class="precision-badge precision-badge-queued" title="Queued for Claude re-score — trigger it in your Claude Code session">Queued</span>'
        : '';

    // Final model (incl. an N/A verdict from one), or already queued: chip only, no trigger.
    if (isFinalFitModel(fm) || queued) {
        return `${badge}${modelBadge}${queuedTag}`;
    }

    // Bulk (20B) score: model chip + a wand to queue a Claude (Opus) re-score.
    return `${badge}${modelBadge}<button class="btn-precision" title="Queue for Claude (Opus) re-score — trigger it in your Claude Code session"
                   onclick="event.stopPropagation(); rescorePrecise('${job.id}')">
               <i class="fa-solid fa-wand-sparkles"></i>
           </button>`;
}

function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applyFitToJob(jobId, fit) {
    const job = (state.allJobs || []).find(j => j.id === jobId);
    if (!job) return;
    job.experience_fit = fit.experience_fit;
    job.criteria_fit = fit.criteria_fit;
    job.fit_experience_note = fit.experience_note;
    job.fit_criteria_note = fit.criteria_note;
    job.fit_recommendation = fit.recommendation;
    job.fit_flag = fit.flag;

    const expCell = document.getElementById(`fit-exp-${jobId}`);
    const critCell = document.getElementById(`fit-crit-${jobId}`);
    if (expCell) expCell.innerHTML = renderFitBadge(job, 'experience');
    if (critCell) critCell.innerHTML = renderFitBadge(job, 'criteria');
}

// Manual re-score now QUEUES the role for a Claude (Opus) re-score, drained interactively in
// a Claude Code session (reads the full JD, applies the rubric). It no longer calls Groq inline.
function rescorePrecise(jobId) {
    const cell = document.getElementById(`fit-exp-${jobId}`);
    if (cell) cell.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color: var(--primary);"></i>';

    fetch(`/api/jobs/${jobId}/claude-rescore`, { method: 'POST' })
        .then(res => res.json().then(body => ({ ok: res.ok, body })))
        .then(({ ok, body }) => {
            if (!ok || body.error) throw new Error(body.error || 'Could not queue');
            const job = (state.allJobs || []).find(j => j.id === jobId);
            if (job) job.claude_rescore_status = 'queued';
            if (cell) cell.innerHTML = renderFitBadge(job || {}, 'experience');
            showToast(`Queued for Claude re-score (${body.queued_count} in queue) — trigger it in your Claude Code session.`, 'success');
        })
        .catch(err => {
            const job = (state.allJobs || []).find(j => j.id === jobId);
            if (cell) cell.innerHTML = renderFitBadge(job || {}, 'experience');
            showToast('Could not queue re-score: ' + err.message, 'error');
        });
}

function scoreJobFit(jobId) {
    const cell = document.getElementById(`fit-exp-${jobId}`);
    if (cell) cell.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color: var(--primary);"></i>';

    fetch(`/api/jobs/${jobId}/fit-score`, { method: 'POST' })
        .then(res => res.json().then(body => ({ ok: res.ok, body })))
        .then(({ ok, body }) => {
            if (!ok || body.error) throw new Error(body.error || 'Scoring failed');
            applyFitToJob(jobId, body);
        })
        .catch(err => {
            if (cell) {
                cell.innerHTML = `<span class="fit-error" title="${escapeAttr(err.message)}">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <a href="#" onclick="event.preventDefault(); event.stopPropagation(); scoreJobFit('${jobId}')">retry</a>
                </span>`;
            }
            showToast(`Fit scoring failed: ${err.message}`, 'error');
        });
}

// Scores every currently-visible unscored job, in one batched request.
function scoreVisibleJobsFit() {
    const unscored = (state.visibleJobs || []).filter(j => !hasFitScore(j));
    if (!unscored.length) {
        showToast('All visible jobs are already scored.', 'info');
        return;
    }

    const batch = unscored.slice(0, 50);
    const btn = document.getElementById('btn-score-visible');
    const original = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Scoring ${batch.length}…`;
    }
    batch.forEach(j => {
        const cell = document.getElementById(`fit-exp-${j.id}`);
        if (cell) cell.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color: var(--primary);"></i>';
    });

    fetch('/api/jobs/fit-score/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: batch.map(j => j.id) })
    })
        .then(res => res.json().then(body => ({ ok: res.ok, body })))
        .then(({ ok, body }) => {
            if (!ok || body.error) throw new Error(body.error || 'Bulk scoring failed');
            Object.entries(body.scored || {}).forEach(([jid, fit]) => applyFitToJob(jid, fit));

            const errs = Object.entries(body.errors || {});
            errs.forEach(([jid]) => {
                const cell = document.getElementById(`fit-exp-${jid}`);
                if (cell) cell.innerHTML = `<span class="fit-error"><i class="fa-solid fa-triangle-exclamation"></i>
                    <a href="#" onclick="event.preventDefault(); event.stopPropagation(); scoreJobFit('${jid}')">retry</a></span>`;
            });

            const done = Object.keys(body.scored || {}).length;
            const remaining = unscored.length - batch.length;
            let msg = `Scored ${done} role${done === 1 ? '' : 's'}.`;
            if (errs.length) msg += ` ${errs.length} failed.`;
            if (remaining > 0) msg += ` ${remaining} still unscored — run again to continue.`;
            showToast(msg, errs.length ? 'error' : 'success');
        })
        .catch(err => showToast(`Bulk scoring failed: ${err.message}`, 'error'))
        .finally(() => {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        });
}

// --- TAILORED RESUME REQUESTS ---
// The tailored-resume-builder skill runs inside Claude (it needs the Google Drive
// connector and a 2-page PDF verification loop), so this button enqueues a request
// and Claude fulfils it. The row reflects queue state.

function renderResumeButton(job) {
    const status = job.resume_request_status;

    // In-flight and failed states take priority, so the row always exposes the next
    // useful action even if an older resume already exists for this job.
    if (status === 'Queued' || status === 'In Progress') {
        return `<span class="btn-resume btn-resume-pending" title="Queued for Claude to build with the tailored-resume-builder skill">
                    <i class="fa-solid fa-hourglass-half"></i> ${status}
                </span>`;
    }
    if (status === 'Failed') {
        return `<button class="btn-resume btn-resume-failed" onclick="event.stopPropagation(); requestTailoredResume('${job.id}')" title="Last attempt failed — click to requeue">
                    <i class="fa-solid fa-rotate-right"></i> Retry
                </button>`;
    }

    // A job may also carry a resume from the older DOCX flow with no queue row at all,
    // so fall back to job.resume_url instead of gating purely on the queue status.
    const docUrl = (status === 'Done' ? job.resume_doc_url : '') || job.resume_url;
    if (docUrl) {
        return `<a href="${docUrl}" target="_blank" class="btn-resume btn-resume-done" title="Open the tailored resume">
                    <i class="fa-solid fa-file-lines"></i> Open
                </a>`;
    }

    // The "Tailor" button is gone. Starring is now the single entry point: it puts the
    // role into Under Consideration and queues the résumé there, where the build can also
    // be triggered manually. Firing a build from here meant building for a role that had
    // not yet made the shortlist.
    return `<span class="btn-resume btn-resume-idle" title="Star this role to queue a tailored résumé in Under Consideration">
                <i class="fa-regular fa-star"></i> Star to queue
            </span>`;
}

function requestTailoredResume(jobId) {
    const cell = document.getElementById(`resume-cell-${jobId}`);
    if (cell) cell.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color: var(--primary);"></i>';

    fetch('/api/resumes/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
    })
        .then(res => res.json().then(body => ({ ok: res.ok, body })))
        .then(({ ok, body }) => {
            if (!ok || body.error) throw new Error(body.error || 'Request failed');
            const job = (state.allJobs || []).find(j => j.id === jobId);
            if (job) {
                job.resume_request_status = body.status;
                job.resume_doc_url = body.doc_url || '';
                if (cell) cell.innerHTML = renderResumeButton(job);
            }
            showToast(
                body.existing
                    ? `Already ${String(body.status).toLowerCase()} for this role.`
                    : 'Queued. Ask Claude to "build the queued resumes" to generate it.',
                'success'
            );
        })
        .catch(err => {
            if (cell) {
                const job = (state.allJobs || []).find(j => j.id === jobId);
                cell.innerHTML = job ? renderResumeButton(job) : '';
            }
            showToast(`Could not queue resume: ${err.message}`, 'error');
        });
}

// 2. Kanban Interview Pipeline Tab
function renderPipelineTab() {
    // Populate active pipeline jobs (Consideration leads or tracking status != Sourced)
    fetch('/api/pipeline')
        .then(res => res.json())
        .then(pipeline => {
            // Count total pipeline active roles
            let total = 0;
            for (let round in pipeline) {
                total += pipeline[round].length;
            }
            if (elements.badgePipeline) elements.badgePipeline.innerText = total;

            const stages = ["Applied", "Recruiter Screen", "Phone Screen", "Onsite Loop", "Offer", "Rejected"];
            elements.kanbanBoard.innerHTML = stages.map(stage => {
                const list = pipeline[stage] || [];
                const cardsHtml = list.map(job => `
                    <div class="kanban-card" draggable="true" ondragstart="dragCard(event, '${job.id}')" onclick="openJobDetails('${job.id}')">
                        <div class="kanban-card-title">${job.title}</div>
                        <div class="kanban-card-company">${job.company_name}</div>
                        <div class="kanban-card-meta">
                            <span>${job.location}</span>
                            <span class="kanban-card-score">${job.relevancy_score}% Match</span>
                        </div>
                    </div>
                `).join('');

                return `
                    <div class="kanban-column">
                        <div class="kanban-column-header">
                            <h3>${stage}</h3>
                            <span class="badge">${list.length}</span>
                        </div>
                        <div class="kanban-cards-list" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="dropCard(event, '${stage}')">
                            ${cardsHtml}
                        </div>
                    </div>
                `;
            }).join('');
        });
}

// Drag and drop mechanics
let draggedJobId = null;

function dragCard(e, jobId) {
    draggedJobId = jobId;
    e.dataTransfer.setData("text", jobId);
}

function allowDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}

function dragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

function dropCard(e, newStage) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const jobId = e.dataTransfer.getData("text") || draggedJobId;
    if (!jobId) return;

    // Update DB
    fetch(`/api/jobs/${jobId}/tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_status: newStage, notes: 'Stage drag-and-drop update' })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast(`Moved application to ${newStage}`);
            fetchJobs(); // refresh local cache
            renderPipelineTab();
        }
    });
}

// Move job to pipeline
function moveToConsideration(jobId) {
    fetch(`/api/jobs/${jobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Consideration' })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast('Role added to Interview Pipeline!');
            fetchJobs();
        }
    });
}

// 3. Resume Builder Tab
function renderResumesTab() {
    // Populate profile inputs
    elements.profileName.value = state.profile.name;
    elements.profileEmail.value = state.profile.email;
    elements.profilePhone.value = state.profile.phone;
    elements.profileLocation.value = state.profile.location;
    elements.profileLinkedin.value = state.profile.linkedin;
    elements.profileSummary.value = state.profile.summary;
    
    // Render education inputs list
    renderEducationList();

    // Render Accomplishments editors
    renderAccomplishmentsBank();

    // Populate Job Selector for Exporter
    const pipelineJobs = state.allJobs.filter(j => j.status === 'Consideration' || j.pipeline_status !== 'Sourced');
    elements.tailorSelectJob.innerHTML = '<option value="">General (No Specific Role)</option>' +
        pipelineJobs.map(j => `<option value="${j.id}">${j.company_name} - ${j.title}</option>`).join('');

    renderTailorBulletsSelector();
}

function renderEducationList() {
    elements.educationList.innerHTML = state.profile.education.map((ed, idx) => `
        <div class="bullet-item-editor" data-idx="${idx}">
            <input type="text" placeholder="School Name" value="${ed.school || ''}" style="flex: 1;" onchange="updateEducation(${idx}, 'school', this.value)">
            <input type="text" placeholder="Degree Details" value="${ed.degree || ''}" style="flex: 1;" onchange="updateEducation(${idx}, 'degree', this.value)">
            <input type="text" placeholder="Dates (e.g. 2018-2020)" value="${ed.dates || ''}" style="width: 120px;" onchange="updateEducation(${idx}, 'dates', this.value)">
            <button class="btn-delete-bullet" onclick="deleteEducation(${idx})"><i class="fa-solid fa-trash"></i></button>
        </div>
    `).join('');
}

function addEducationRow() {
    state.profile.education.push({ school: '', degree: '', dates: '' });
    renderEducationList();
}

function updateEducation(idx, field, val) {
    state.profile.education[idx][field] = val;
}

function deleteEducation(idx) {
    state.profile.education.splice(idx, 1);
    renderEducationList();
}

function renderAccomplishmentsBank() {
    elements.contributionsEditor.innerHTML = state.profile.contributions_bank.map((c, idx) => `
        <div style="border: 1px solid var(--border-color); padding: 12px; border-radius: var(--radius-sm); margin-bottom: 12px;">
            <div class="form-row" style="margin-bottom: 8px;">
                <input type="text" placeholder="Competency Category" value="${c.category || ''}" class="col-4" style="background: transparent; border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px; font-size:0.8rem;" onchange="updateContribution(${idx}, 'category', this.value)">
                <input type="text" placeholder="Company" value="${c.company || ''}" class="col-3" style="background: transparent; border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px; font-size:0.8rem;" onchange="updateContribution(${idx}, 'company', this.value)">
                <input type="text" placeholder="Role" value="${c.role || ''}" class="col-3" style="background: transparent; border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px; font-size:0.8rem;" onchange="updateContribution(${idx}, 'role', this.value)">
                <input type="text" placeholder="Dates" value="${c.dates || ''}" class="col-2" style="background: transparent; border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px; font-size:0.8rem;" onchange="updateContribution(${idx}, 'dates', this.value)">
            </div>
            <div class="bullet-item-editor" style="border: none; padding: 0;">
                <textarea placeholder="Achievement Bullet Point (STAR format with metrics)" rows="2" style="width: 100%;" onchange="updateContribution(${idx}, 'bullet', this.value)">${c.bullet || ''}</textarea>
                <button class="btn-delete-bullet" onclick="deleteContribution(${idx})" style="padding-left:8px;"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

function addContributionRow() {
    const newId = 'c_' + Math.random().toString(36).substring(2, 9);
    state.profile.contributions_bank.push({ id: newId, category: '', company: '', role: '', dates: '', bullet: '' });
    renderAccomplishmentsBank();
}

function updateContribution(idx, field, val) {
    state.profile.contributions_bank[idx][field] = val;
}

function deleteContribution(idx) {
    state.profile.contributions_bank.splice(idx, 1);
    renderAccomplishmentsBank();
}

function saveCandidateProfile() {
    state.profile.name = elements.profileName.value.trim();
    state.profile.email = elements.profileEmail.value.trim();
    state.profile.phone = elements.profilePhone.value.trim();
    state.profile.location = elements.profileLocation.value.trim();
    state.profile.linkedin = elements.profileLinkedin.value.trim();
    state.profile.summary = elements.profileSummary.value.trim();
    
    saveProfileDataToServer().then(() => {
        showToast('Resume profile details updated successfully!');
        renderAccomplishmentsBank();
    });
}

function saveProfileDataToServer() {
    return fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.profile)
    })
    .then(res => res.json());
}

// Resume Tailoring UI selectors
function handleTailorJobSelection() {
    const jobId = elements.tailorSelectJob.value;
    if (!jobId) {
        elements.tailorJobDetails.style.display = 'none';
        renderTailorBulletsSelector();
        return;
    }
    
    const job = state.allJobs.find(j => j.id === jobId);
    if (job) {
        elements.tailorJobTitle.innerText = job.title;
        elements.tailorJobCompany.innerText = job.company_name;
        elements.tailorJobDescSnippet.innerText = job.notes || 'No description fetched.';
        elements.tailorJobDetails.style.display = 'block';
        
        // Auto-select match bullets
        renderTailorBulletsSelector(job.notes || '');
    }
}

function renderTailorBulletsSelector(descText = '') {
    const bank = state.profile.contributions_bank;
    if (!bank || bank.length === 0) {
        elements.tailorBulletsList.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted); text-align:center; padding:12px;">No contributions in your bullet bank. Add some on the left.</div>';
        return;
    }

    // If descText is present, calculate keywords match count to prioritize/pre-check
    const descWords = new Set((descText.toLowerCase().match(/\b\w{4,}\b/g) || []));
    
    let scoredBullets = bank.map(c => {
        const bulletWords = (c.bullet.toLowerCase().match(/\b\w{4,}\b/g) || []);
        let matches = 0;
        bulletWords.forEach(w => {
            if (descWords.has(w)) matches++;
        });
        return { ...c, matches };
    });

    // Sort: highest matches first
    scoredBullets.sort((a, b) => b.matches - a.matches);

    elements.tailorBulletsList.innerHTML = scoredBullets.map((c, idx) => {
        // Pre-check top 5 if they have matches, or precheck all if general
        const checked = (descText === '') ? 'checked' : (idx < 5 && c.matches > 0) ? 'checked' : '';
        const recClass = (descText !== '' && c.matches > 0) ? 'recommended' : '';
        const recBadge = (descText !== '' && c.matches > 0) ? `<span style="font-size:0.65rem; background:var(--primary-glow); color:var(--primary); padding:1px 4px; border-radius:2px; margin-left:4px;">${c.matches} Keyword Matches</span>` : '';

        return `
            <label class="tailor-bullet-checkbox ${recClass}">
                <input type="checkbox" name="tailor-bullet" value="${c.id}" ${checked}>
                <div>
                    <strong>${c.company || 'General'} - ${c.category || 'Achievement'}</strong> ${recBadge}
                    <p style="font-size:0.76rem; color:var(--text-primary); margin-top:2px; line-height:1.35;">${c.bullet}</p>
                </div>
            </label>
        `;
    }).join('');
}

function generateTailoredResume() {
    const jobId = elements.tailorSelectJob.value;
    const checkedBoxes = elements.tailorBulletsList.querySelectorAll('input[name="tailor-bullet"]:checked');
    const selectedBullets = Array.from(checkedBoxes).map(cb => cb.value);
    
    const formatting = {
        font: elements.tailorFont.value,
        fontSize: elements.tailorFontSize.value,
        margin: elements.tailorMargin.value
    };
    
    elements.btnGenerateTailored.disabled = true;
    elements.btnGenerateTailored.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating Word Doc...';
    
    fetch('/api/resumes/tailor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            job_id: jobId || null,
            selected_bullets: selectedBullets,
            formatting: formatting
        })
    })
    .then(res => res.json())
    .then(data => {
        elements.btnGenerateTailored.disabled = false;
        elements.btnGenerateTailored.innerHTML = '<i class="fa-solid fa-file-word"></i> <span>Generate Tailored Resume (DOCX)</span>';
        
        if (data.success) {
            elements.linkDownloadTailored.href = data.download_url;
            elements.tailoredResumeResult.style.display = 'block';
            showToast('Tailored Resume compiled successfully!');
        } else {
            showToast('Error: ' + data.error);
        }
    })
    .catch(err => {
        elements.btnGenerateTailored.disabled = false;
        elements.btnGenerateTailored.innerHTML = '<i class="fa-solid fa-file-word"></i> <span>Generate Tailored Resume (DOCX)</span>';
        showToast('Connection failed.');
    });
}

// Prompt copy helper
window.copyPromptText = function(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Prompt copied! Paste into Antigravity or Claude.', 'success');
        }).catch(() => {
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
};

function fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Prompt copied! Paste into Antigravity or Claude.', 'success');
    } catch(e) {
        showToast('Could not copy prompt automatically.', 'warn');
    }
}

function updatePrepQueueStatusBadge() {
    fetch('/api/prep/queue/status')
        .then(r => r.json())
        .then(data => {
            const badge = document.getElementById('prep-global-queue-badge');
            const breakdown = document.getElementById('prep-queue-breakdown');
            const tot = data.total_pending || 0;
            if (badge) {
                badge.innerText = `${tot} Job${tot === 1 ? '' : 's'} Pending`;
                if (tot > 0) {
                    badge.classList.remove('badge-queued-ai');
                    badge.classList.add('badge-queued-pending');
                } else {
                    badge.classList.remove('badge-queued-pending');
                    badge.classList.add('badge-queued-ai');
                }
                badge.style.background = '';
                badge.style.color = '';
            }
            if (breakdown) {
                breakdown.innerText = `STAR: ${data.star_pending || 0} · Reps: ${data.reps_pending || 0} · Delivery: ${data.delivery_pending || 0} · Review: ${data.interview_review_pending || 0}`;
            }
        })
        .catch(() => {});
}

// 4. Interview Preparation Hub Tab Router
// Prep Hub redesign: a left sub-rail (Overview / My Roles / Performance / Practice / Coaching
// Report) drives which content pane shows. Practice has its own Behavioral/Delivery sub-nav.
let prepCurrentMode = localStorage.getItem('pm_board_prep_mode_v1') || 'overview';
let prepPracticeSub = 'delivery';

function renderPrepTab() {
    updatePrepQueueStatusBadge();
    initPrepToggles();
    applyPrepMode(prepCurrentMode || 'overview');
}

function applyPrepMode(mode) {
    if (mode === 'coaching_report') {
        // Consolidated inside Performance: load Performance and open the Longitudinal Coaching Report.
        applyPrepMode('interview_review');
        if (typeof toggleLongitudinalSummaryModal === 'function') toggleLongitudinalSummaryModal();
        return;
    }
    if (mode === 'practice') {
        // Legacy route consolidated into unified Practice Gym.
        mode = 'delivery';
    }
    prepCurrentMode = mode;
    try { localStorage.setItem('pm_board_prep_mode_v1', mode); } catch (_) {}
    ['prep-mode-overview', 'prep-mode-delivery', 'prep-mode-reps', 'prep-mode-interview-review', 'prep-mode-question-bank']
        .forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
    document.querySelectorAll('.prep-rail [data-prep-nav]').forEach(b =>
        b.classList.toggle('active', b.getAttribute('data-prep-nav') === mode));

    if (mode === 'overview') {
        const e = document.getElementById('prep-mode-overview'); if (e) e.style.display = '';
        renderAiCenter();
    } else if (mode === 'reps') {
        const e = document.getElementById('prep-mode-reps'); if (e) e.style.display = '';
        const home = document.getElementById('myroles-home'), ws = document.getElementById('myroles-workspace');
        if (home) home.style.display = '';
        if (ws) ws.style.display = 'none';
        renderMyRolesHome();
        initRepsModule(); loadActiveRepRoles();
    } else if (mode === 'interview_review') {
        const e = document.getElementById('prep-mode-interview-review'); if (e) e.style.display = '';
        initInterviewReviewModule();
    } else if (mode === 'question_bank') {
        const e = document.getElementById('prep-mode-question-bank'); if (e) e.style.display = '';
        renderQuestionBank();
    } else if (mode === 'delivery') {
        const e = document.getElementById('prep-mode-delivery'); if (e) e.style.display = '';
        if (typeof initDeliveryModule === 'function') initDeliveryModule();
    }
    updatePrepQueueStatusBadge();
}

function applyPracticeSub(sub) {
    applyPrepMode('delivery');
    if (sub === 'star' && typeof setGymTab === 'function') setGymTab('star_bank');
}

// Legacy helper: preloads any prompt directly into the unified Practice Gym recorder.
window.startPracticeMock = function (question, answerType) {
    applyPrepMode('delivery');
    if (typeof setGymTab === 'function') {
        const tabMap = { product_sense: 'product_sense', product_strategy: 'product_sense', analytics: 'execution', people_leadership: 'leadership' };
        setGymTab(tabMap[answerType] || 'hm');
    }
    const qIn = document.getElementById('delivery-question-input');
    if (qIn) qIn.value = question;
    if (typeof deliveryState === 'object' && deliveryState) deliveryState.currentDrill = answerType || 'custom';
    const del = document.getElementById('prep-mode-delivery');
    if (del) del.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ---- Master Question Bank (Prep Hub) : live-aggregates questions from interview reviews,
// classifies by type, groups similar ones, and renders grouped cards. Regroups as reviews are added.
const QB_TYPES = [
    ['Motivation & Fit', '#4FB98A'],
    ['Logistics & Leveling', '#9AA5B5'],
    ['Leadership', '#E88B72'],
    ['Behavioral', '#C4A0E0'],
    ['Product Sense', '#6FB6E0'],
    ['Strategy & Business', '#DBA94B'],
    ['Technical & Craft', '#5FC0BC'],
    ['Execution', '#A0C060'],
    ['Ways of Working', '#D48AC0'],
    ['Your Reverse Questions', '#9AA5B5'],
    ['Other', '#8892A0'],
];
const QB_GROUPS = [
    { key: 'bg', type: 'Motivation & Fit', label: 'Walk me through your background / tell me about yourself', eval: 'A single organizing career thesis (not a chronology), and making the role feel like the obvious next step. Lead with the thesis + the two most role-relevant proof points.', re: /(background|tell me about yourself|walk me through|drew you|brought you to this role|overview of your (background|experience))/i, watch: true },
    { key: 'why', type: 'Motivation & Fit', label: 'Why now / why this company / why this role', eval: 'Genuine, specific pull vs a generic search; alignment of what you want next with the role.', re: /(why (looking|are you|now|this)|draws you|drawn to|why this .*role)/i },
    { key: 'leaving', type: 'Motivation & Fit', label: 'What is prompting your search / career transition', eval: 'Composure and clear, forward-looking framing around career transition and what you want next.', re: /(prompting your search|leaving|context behind|what are you looking for)/i },
    { key: 'logistics', type: 'Logistics & Leveling', label: 'Comp, location, timeline, work authorization', eval: 'Comp alignment and a clean screen gate. One-sentence anchors, then stop — looping reads as a lack of executive economy.', re: /(compensation|\bcomp\b|salary|location|work authoriz|timeline|hybrid schedule|logistics)/i },
    { key: 'level', type: 'Logistics & Leveling', label: 'Level & scope calibration (L7/L8, VP/Director); interviewed here before', eval: 'Honest self-calibration against the level bar; do not negotiate title in a screen — anchor scope through an outcome.', re: /(leveling|\bl7\b|\bl8\b|senior principal|vp vs|director roles|interviewed .*(here|past)|scope for|organizational structure and leadership scope)/i },
    { key: 'ledteam', type: 'Leadership', label: 'Have you led a team? How many, and what authority?', eval: 'Whether the buck stops with you on the hard people-calls; "did they report to you" is the proxy. Concede the reporting line in half a clause, then a hard people-decision.', re: /(led a team|team you led|building out a team|team of \d|size of the team|leadership style)/i, watch: true },
    { key: 'influence', type: 'Leadership', label: 'Drive alignment / rally a matrixed team without formal authority', eval: 'Influence without authority, matrix alignment, vision casting — the influence IS the authority. Drop the "without authority" hedge.', re: /(without formal authority|drive alignment|rally a matrix|cross[- ]functional team)/i, watch: true },
    { key: 'goodgreat', type: 'Leadership', label: 'How do you take a good team to great?', eval: 'People-leadership altitude, talent development, elevating teams to outcome ownership. Bring a concrete coaching case.', re: /(good team|to be great|take a good team)/i },
    { key: 'lessons', type: 'Behavioral', label: 'Hardest lessons learned / a failure', eval: 'Self-awareness, post-mortem rigor, maturity under failure — not a humble-brag. Own a real miss and the change it produced.', re: /(hardest lesson|lessons you|\bfailure\b)/i },
    { key: 'conflict', type: 'Behavioral', label: 'Cross-functional / leadership pushback — how you navigated it', eval: 'Owning a hard call: a real conflict, your judgment, a cost accepted, and YOU resolving it — never "leadership decided".', re: /(pushback|opposing interests)/i, watch: true },
    { key: 'build', type: 'Product Sense', label: 'How would you build [X] from scratch?', eval: 'Architectural altitude and product intuition; open with a 30-second mental model before the mechanics.', re: /(from scratch|how would you (approach|build|design)|building a .*mcp)/i },
    { key: 'stratplat', type: 'Strategy & Business', label: 'What should our platform strategy be (expose vs proprietary; 1P vs 3P)?', eval: 'A real strategic POV on platform bets and ecosystem dynamics — the neutral-gateway question and where defensibility lives.', re: /(strateg.*(is|should|expose)|expose vs|proprietary|first-party vs|third-party model|routing|ecosystem balance)/i },
    { key: 'commercial', type: 'Strategy & Business', label: 'How does your experience connect to our mission / commercial value?', eval: 'Grasp of the commercial value of the domain and how the product drives revenue.', re: /(connect to .*(mission|mads)|commercial value)/i },
    { key: 'channel', type: 'Strategy & Business', label: 'Channel conflict / disintermediation', eval: 'Commercial acumen, channel strategy, platform defense against ecosystem disintermediation.', re: /(disintermediat|channel conflict|meeting users where)/i },
    { key: 'revenue', type: 'Strategy & Business', label: 'Have you owned a revenue / ARR / P&L number?', eval: 'GM accountability and honest self-awareness. Concede any direct P&L gap cleanly, then anchor on the business levers you owned (revenue, activation, retention).', re: /(revenue|\barr\b|p&l|p and l number)/i, watch: true },
    { key: 'explain', type: 'Technical & Craft', label: 'What did you build / most successful platform product?', eval: 'Explaining deep technical work simply, plus concrete execution proof. Lead with the outcome, then the how.', re: /(layman terms|most successful|what were the mcp tools)/i },
    { key: 'mcpdepth', type: 'Technical & Craft', label: 'What do people get wrong about MCP? tools vs plugins?', eval: 'Opinionated depth on agentic tooling — a real POV, not a definition. Have a contrarian-but-defensible take.', re: /(getting wrong about mcp|tools vs plugins|general tools vs)/i },
    { key: 'evals', type: 'Technical & Craft', label: 'Evals, monitoring & model drift', eval: 'Platform-engineering rigor with non-deterministic models. Frame evals as a layered system: pre-launch gates → regression → live telemetry.', re: /(\bevals?\b|invocation logic|model.{0,3}drift|monitoring when)/i },
    { key: 'govern', type: 'Technical & Craft', label: 'AI governance & risk (bias, privacy, leakage, non-determinism, T&C)', eval: 'Governance for uncharted AI where precedent is nascent; enterprise security & compliance. Ground in concrete risk-proportionate governance, privacy controls, and measurable guardrails.', re: /(govern|algorithmic bias|non-invoker|data (privacy|leakage)|proprietary data leakage|non-deterministic|t&c|disclosures|responsible ai|security governance)/i },
    { key: 'arch', type: 'Technical & Craft', label: 'Architecture & standards trade-offs', eval: 'Technical architecture depth and holding a roadmap steady under shifting standards — speed-to-market vs consolidation debt.', re: /(extensibility|architectur|fragmentation|a2ui|multi-model standard)/i },
    { key: 'tradeoff', type: 'Technical & Craft', label: 'Core trade-off / driving clarity from ambiguous data', eval: 'Principled decision frameworks, and whether your story reveals an offense (growth) or defense (risk) instinct. Pick a story that ladders to a business number and holds a real conflict.', re: /(trade-?off|ambiguous data|exact delta|user (data )?harm|raw data coverage)/i, watch: true },
    { key: 'exec', type: 'Execution', label: '0→1 vs evolutionary / how you drove activity', eval: 'Concrete delivery, the 0→1 vs 1→N distinction, measurable outcomes. Crisp before/after with a metric.', re: /(zero-to-one|0->n|0-to-1|evolutionary|were these initiatives)/i },
    { key: 'vibe', type: 'Ways of Working', label: 'Using AI tools / vibe coding day-to-day', eval: 'An authentic, hands-on practitioner vs a legacy process manager. Concrete hands-on workflows and evaluation loops demonstrate real practitioner depth.', re: /(vibe cod|ai tools|day-to-day workflow)/i },
    { key: 'pace', type: 'Ways of Working', label: 'Big-tech vs startup operating model / low process', eval: 'Speed, decisiveness under incomplete info, culture fit. Answer with proof of speed — don’t over-explain or launch a mini-speech.', re: /(big-?tech vs startup|process burden|operating model|low process)/i, watch: true },
    { key: 'reverse', type: 'Your Reverse Questions', label: 'Your strategic discovery questions (what to ask them)', eval: 'Whether your questions reveal a POV on where the hard problems and value are. Keep one provocative, business-level question loaded per round.', re: /(candidate (strategic|prob|synthesis|discovery)|reverse|role genesis|hm hierarchy|bottlenecks|hiring priorities|media mix)/i },
    { key: 'sysdesignflaw', type: 'Technical & Craft', label: 'Caught a flaw in Engineering\'s system design before launch and addressed it', eval: 'Amazon Dive Deep + Are Right, A Lot: depth to spot a design flaw others missed, judgment to weigh your fix against the customer experience it costs, and honesty about what actually shipped. Engage Engineering\'s reasoning charitably before overriding it.', re: /((caught|spotted|found).{0,30}(flaw|issue|problem).{0,30}(system|engineering).{0,15}design|flaw in .{0,20}(system|engineering).{0,10}design|system design.{0,20}(flaw|before .{0,10}launch))/i },
    { key: 'sysdesignesc', type: 'Technical & Craft', label: 'Escalated your feedback on an eng system design to senior leadership', eval: 'Have Backbone; Disagree & Commit: take a technical disagreement up the chain with evidence, manage the relationship through it, and be honest about the outcome vs what shipped, including where you committed after losing the call. Keep this story distinct from the caught-a-flaw one.', re: /(escalat\w*|raised (it|an escalation|to)).{0,40}(system design|eng\w* leadership|senior .{0,10}leadership)/i },
    { key: 'baddecision', type: 'Behavioral', label: 'A bad decision you made — team impact and how you addressed it', eval: 'Ownership + Earn Trust: a genuinely self-caused bad call (not a reframed success), the real team impact and reaction, and a concrete corrective mechanism. Blame owned, not externalized.', re: /(bad decision|made a (bad|poor|wrong) (call|decision)|wrong decision)/i },
    { key: 'saidno', type: 'Behavioral', label: 'Said no to an important customer', eval: 'Customer Obsession in tension with Have Backbone: decline a loud, important ask for the broader customer base or long-term value, hold the line with a rationale, and preserve the relationship — principled prioritization, not appeasement.', re: /(said|say) no to.{0,25}(customer|client|stakeholder)/i },
];

function qbShortCompany(c) {
    return c || 'Unknown';
}
function qbShortStage(r) {
    r = r || '';
    if (/mock/i.test(r)) return r;
    if (/recruiter/i.test(r)) return 'Recruiter';
    if (/hiring manager/i.test(r)) return 'HM';
    if (/product sense|design/i.test(r)) return 'Product Sense';
    if (/leadership|culture|behavioral/i.test(r)) return 'Behavioral';
    if (/loop/i.test(r)) return 'Loop';
    return r;
}
function qbClassify(text) {
    for (const g of QB_GROUPS) { if (g.re.test(text)) return g; }
    return null;
}

let qbAllQuestions = [];
let qbAllReviews = [];
let qbCurrentView = 'table';

function setQbViewMode(mode) {
    qbCurrentView = mode;
    const btnTable = document.getElementById('btn-qb-view-table');
    const btnGrouped = document.getElementById('btn-qb-view-grouped');
    const secTable = document.getElementById('qb-table-view-section');
    const secGrouped = document.getElementById('qb-grouped-view-section');

    if (btnTable) btnTable.classList.toggle('active', mode === 'table');
    if (btnGrouped) btnGrouped.classList.toggle('active', mode === 'grouped');
    if (secTable) secTable.style.display = (mode === 'table') ? '' : 'none';
    if (secGrouped) secGrouped.style.display = (mode === 'grouped') ? '' : 'none';
}

function getQbRoundBadge(round) {
    const r = (round || '').toLowerCase();
    let cls = 'qb-round-other';
    let label = round || 'General';
    if (r.includes('mock')) { cls = 'qb-round-mock'; label = round; }
    else if (r.includes('recruiter')) { cls = 'qb-round-recruiter'; label = 'Recruiter Screen'; }
    else if (r.includes('hiring manager') || r.includes('hm')) { cls = 'qb-round-hm'; label = 'Hiring Manager'; }
    else if (r.includes('system') || r.includes('architecture') || r.includes('tech')) { cls = 'qb-round-tech'; label = 'System Architecture'; }
    else if (r.includes('behavioral') || r.includes('leadership') || r.includes('culture')) { cls = 'qb-round-behavioral'; label = 'Behavioral & Leadership'; }
    else if (r.includes('product sense') || r.includes('design')) { cls = 'qb-round-product'; label = 'Product Sense'; }
    else if (r.includes('loop')) { cls = 'qb-round-loop'; label = 'Full Loop'; }
    const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
    return `<span class="qb-badge-round ${cls}">${esc(label)}</span>`;
}

function toggleQbCoaching(rowId) {
    const drawer = document.getElementById(`qb-drawer-${rowId}`);
    const parentRow = document.getElementById(`qb-row-${rowId}`);
    const btn = document.getElementById(`qb-toggle-btn-${rowId}`);
    if (!drawer) return;
    const isHidden = drawer.style.display === 'none';
    drawer.style.display = isHidden ? '' : 'none';
    if (parentRow) parentRow.classList.toggle('qb-expanded', isHidden);
    if (btn) {
        btn.innerHTML = isHidden ? '<i class="fa-solid fa-chevron-up"></i>' : '<i class="fa-solid fa-lightbulb" style="color:#f59e0b;"></i>';
        btn.title = isHidden ? 'Hide coaching details' : 'Show coaching details';
    }
}

function copyQbQuestionText(text, btn) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        const origHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check" style="color:#10b981;"></i>';
        setTimeout(() => { btn.innerHTML = origHtml; }, 1800);
    }).catch(err => {
        console.error('Failed to copy question text:', err);
    });
}

function practiceQbQuestion(uid) {
    const q = qbAllQuestions.find(item => String(item.uid) === String(uid));
    if (!q) return;
    const rl = (q.round || '').toLowerCase();
    let pool = 'hm';
    if (rl.includes('recruiter')) pool = 'recruiter';
    else if (rl.includes('product sense') || rl.includes('product design')) pool = 'product_sense';
    else if (rl.includes('execution') || rl.includes('analytical') || rl.includes('metrics')) pool = 'execution';
    else if (rl.includes('leadership') || rl.includes('behavioral') || rl.includes('culture')) pool = 'leadership';

    applyPrepMode('delivery');
    if (typeof setGymTab === 'function') setGymTab(pool);
    if (typeof loadQuestionIntoGym === 'function') {
        loadQuestionIntoGym({
            uid: `qb:${q.reviewId}:${q.uid}`,
            source: 'my_interview',
            review_id: q.reviewId,
            pool: pool,
            company: q.company || '',
            role: q.role || '',
            round_type: q.round || '',
            interview_date: q.interviewDate || '',
            question: q.question,
            score: q.score != null ? Number(q.score) : null,
            is_weak: q.score != null && Number(q.score) < 7.2,
            gaps: q.misses || [],
            what_it_tests: q.whatItTests || '',
            how_to_approach: q.howToApproach || '',
            model_answer: q.modelAnswer || '',
            practice_count: 0
        });
    }
    const del = document.getElementById('prep-mode-delivery');
    if (del) del.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyQbFilters() {
    const searchVal = (document.getElementById('qb-filter-search')?.value || '').toLowerCase().trim();
    const compVal = document.getElementById('qb-filter-company')?.value || '';
    const roundVal = document.getElementById('qb-filter-round')?.value || '';

    const filtered = qbAllQuestions.filter(q => {
        if (compVal && q.company !== compVal) return false;
        if (roundVal && q.round !== roundVal) return false;
        if (searchVal) {
            const matchQ = q.question.toLowerCase().includes(searchVal);
            const matchEval = (q.whatItTests || '').toLowerCase().includes(searchVal);
            const matchComp = q.company.toLowerCase().includes(searchVal);
            const matchRound = q.round.toLowerCase().includes(searchVal);
            const matchApproach = (q.howToApproach || '').toLowerCase().includes(searchVal);
            if (!matchQ && !matchEval && !matchComp && !matchRound && !matchApproach) return false;
        }
        return true;
    });

    renderQbTable(filtered);
}

function resetQbFilters() {
    const searchInput = document.getElementById('qb-filter-search');
    const compSelect = document.getElementById('qb-filter-company');
    const roundSelect = document.getElementById('qb-filter-round');
    if (searchInput) searchInput.value = '';
    if (compSelect) compSelect.value = '';
    if (roundSelect) roundSelect.value = '';
    applyQbFilters();
}

function renderQbTable(questions) {
    const tbody = document.getElementById('qb-factual-tbody');
    const statCount = document.getElementById('qb-stat-count');
    const statComps = document.getElementById('qb-stat-companies');
    const statRounds = document.getElementById('qb-stat-rounds');

    if (!tbody) return;

    const uniqueComps = new Set(questions.map(q => q.company));
    const uniqueRounds = new Set(questions.map(q => q.round));

    if (statCount) statCount.innerHTML = `<i class="fa-solid fa-clipboard-question"></i> ${questions.length} questions`;
    if (statComps) statComps.innerHTML = `<i class="fa-solid fa-building"></i> ${uniqueComps.size} companies`;
    if (statRounds) statRounds.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> ${uniqueRounds.size} rounds`;

    if (!questions.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:32px; text-align:center; color:var(--text-muted);"><i class="fa-solid fa-filter-circle-xmark" style="font-size:1.5rem; margin-bottom:8px; display:block;"></i>No questions match your current filters. <button type="button" class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="resetQbFilters()">Reset Filters</button></td></tr>`;
        return;
    }

    const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));

    let html = '';
    questions.forEach((q, idx) => {
        const hasCoaching = !!(q.howToApproach || q.modelAnswer || q.answerSummary || (q.strengths && q.strengths.length) || (q.misses && q.misses.length));
        const roundBadge = getQbRoundBadge(q.round);
        const scoreBadge = q.score != null ? `<span class="qb-tag-score" title="Calibrated Turn Score">${q.score}/10</span>` : '';
        const timeBadge = q.timestamp ? `<span style="font-size:0.75rem; color:var(--text-muted); font-family:monospace; margin-left:6px;">${esc(q.timestamp)}</span>` : '';
        const roleSubtitle = q.role ? `<div style="font-size:0.74rem; color:var(--text-muted); margin-top:3px; max-width:145px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${esc(q.role)}">${esc(q.role)}</div>` : '';

        // Safe attribute string for copy
        const safeQText = q.question.replace(/'/g, "\\'").replace(/"/g, '&quot;');

        html += `<tr id="qb-row-${q.uid}" class="qb-q-row">
            <td style="text-align:center; font-size:0.78rem; color:var(--text-muted); font-family:monospace;">${idx + 1}</td>
            <td>
                <span class="qb-badge-company"><i class="fa-regular fa-building"></i> ${esc(q.company)}</span>
                ${roleSubtitle}
            </td>
            <td>${roundBadge}</td>
            <td>
                <div class="qb-question-text">${esc(q.question)} ${scoreBadge} ${timeBadge}</div>
            </td>
            <td>
                <div class="qb-eval-content">
                    <i class="fa-solid fa-bullseye" style="color:var(--primary); font-size:0.8rem; margin-right:4px;"></i>
                    ${esc(q.whatItTests || 'Core PM competencies, strategic depth, and communication clarity.')}
                </div>
            </td>
            <td style="text-align:center; white-space:nowrap;">
                <button type="button" class="qb-action-btn" title="Practice this question in Practice Gym" onclick="practiceQbQuestion('${q.uid}')" style="color:var(--primary);"><i class="fa-solid fa-microphone-lines"></i></button>
                <button type="button" class="qb-action-btn" title="Copy question text" onclick="copyQbQuestionText('${safeQText}', this)" style="margin-left:4px;"><i class="fa-regular fa-copy"></i></button>
                ${hasCoaching ? `<button type="button" class="qb-action-btn" id="qb-toggle-btn-${q.uid}" title="View coaching tips & model response" onclick="toggleQbCoaching('${q.uid}')" style="margin-left:4px;"><i class="fa-solid fa-lightbulb" style="color:#f59e0b;"></i></button>` : ''}
            </td>
        </tr>`;

        if (hasCoaching) {
            html += `<tr id="qb-drawer-${q.uid}" style="display:none;" class="qb-drawer-row">
                <td colspan="6" style="padding:0 14px 14px 14px; border-bottom:1px solid var(--border-color);">
                    <div class="qb-coaching-drawer">
                        ${q.whatItTests ? `<div style="margin-bottom:8px;"><b><i class="fa-solid fa-bullseye" style="color:var(--primary); margin-right:4px;"></i> What this question tests:</b> <span style="color:var(--text-primary);">${esc(q.whatItTests)}</span></div>` : ''}
                        ${q.howToApproach ? `<div style="margin-bottom:8px;"><b><i class="fa-solid fa-compass" style="color:#818cf8; margin-right:4px;"></i> How a bar-raiser approaches it:</b> <span style="color:var(--text-secondary);">${esc(q.howToApproach)}</span></div>` : ''}
                        ${q.modelAnswer ? `<div style="margin-bottom:8px;"><b><i class="fa-solid fa-star" style="color:#10b981; margin-right:4px;"></i> Exemplary Model Response:</b> <div style="margin-top:4px; padding:10px 12px; background:var(--bg-card); border-left:3px solid #10b981; border-radius:4px; font-style:italic; color:var(--text-primary);">"${esc(q.modelAnswer)}"</div></div>` : ''}
                        ${q.answerSummary ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:6px;"><b>Candidate Answer Summary:</b> ${esc(q.answerSummary)}</div>` : ''}
                    </div>
                </td>
            </tr>`;
        }
    });

    tbody.innerHTML = html;
}

function renderQbGrouped(reviews, esc) {
    const body = document.getElementById('question-bank-body');
    if (!body) return;
    const groups = {};
    const other = {};
    let total = 0;

    (reviews || []).forEach(rv => {
        const qs = Array.isArray(rv.questions) ? rv.questions : [];
        qs.forEach(q => {
            const text = (q && (q.question || q.question_text || '')).trim();
            if (!text) return;
            total++;
            const src = qbShortCompany(rv.company_name) + ' · ' + qbShortStage(rv.round_type);
            const g = qbClassify(text);
            if (g) {
                if (!groups[g.key]) groups[g.key] = { g, variants: new Set(), sources: new Set(), watch: !!g.watch };
                groups[g.key].variants.add(text);
                groups[g.key].sources.add(src);
            } else {
                const nk = text.toLowerCase().slice(0, 60);
                if (!other[nk]) other[nk] = { text, sources: new Set() };
                other[nk].sources.add(src);
            }
        });
    });

    if (!total) {
        body.innerHTML = '<div style="color:var(--text-muted); font-size:0.92rem; padding:20px 0;">No questions captured yet. Add interview reviews under <b>Performance</b>, and they’ll be grouped here automatically.</div>';
        return;
    }

    const byType = {};
    Object.values(groups).forEach(entry => {
        (byType[entry.g.type] = byType[entry.g.type] || []).push(entry);
    });
    const otherList = Object.values(other);
    const watchCount = Object.values(groups).filter(e => e.watch).length;

    let html = '';
    html += '<div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px;">'
        + '<span class="qb-stat">' + total + ' questions</span>'
        + '<span class="qb-stat">' + (reviews || []).filter(r => (r.questions || []).length).length + ' interviews</span>'
        + '<span class="qb-stat" style="color:#DBA94B;">⚠ ' + watchCount + ' flagged to prep first</span>'
        + '</div>';
    QB_TYPES.forEach(([type, color]) => {
        const entries = byType[type] || [];
        if (type === 'Other') return;
        if (!entries.length) return;
        html += '<div style="margin:22px 0 10px; display:flex; align-items:center; gap:10px;">'
            + '<span style="display:inline-block; width:10px; height:10px; border-radius:3px; background:' + color + ';"></span>'
            + '<h4 style="margin:0; font-size:1.02rem; color:var(--text-primary);">' + esc(type) + '</h4>'
            + '<span style="color:var(--text-muted); font-size:0.78rem;">' + entries.length + '</span></div>';
        entries.forEach(entry => {
            const g = entry.g;
            const variants = Array.from(entry.variants);
            const canonical = g.label;
            const extra = variants.filter(v => v.toLowerCase() !== canonical.toLowerCase()).slice(0, 4);
            const srcChips = Array.from(entry.sources).map(s => '<span class="qb-src">' + esc(s) + '</span>').join('');
            html += '<div class="qb-card' + (entry.watch ? ' qb-watch' : '') + '" style="border-left-color:' + color + ';">'
                + '<div class="qb-q">' + esc(canonical) + (entry.watch ? ' <span class="qb-flag">⚠ tripped you before</span>' : '') + '</div>'
                + (extra.length ? '<ul class="qb-variants">' + extra.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul>' : '')
                + '<div class="qb-srcs">' + srcChips + '</div>'
                + '<div class="qb-eval"><b>Evaluating:</b> ' + esc(g.eval) + '</div>'
                + '</div>';
        });
    });
    if (otherList.length) {
        html += '<div style="margin:22px 0 10px; display:flex; align-items:center; gap:10px;">'
            + '<span style="display:inline-block; width:10px; height:10px; border-radius:3px; background:#8892A0;"></span>'
            + '<h4 style="margin:0; font-size:1.02rem; color:var(--text-primary);">Other / Uncategorized</h4>'
            + '<span style="color:var(--text-muted); font-size:0.78rem;">' + otherList.length + '</span></div>';
        otherList.forEach(o => {
            html += '<div class="qb-card" style="border-left-color:#8892A0;">'
                + '<div class="qb-q">' + esc(o.text) + '</div>'
                + '<div class="qb-srcs">' + Array.from(o.sources).map(s => '<span class="qb-src">' + esc(s) + '</span>').join('') + '</div>'
                + '</div>';
        });
    }
    body.innerHTML = html;
}

function renderQuestionBank() {
    const tbody = document.getElementById('qb-factual-tbody');
    const groupedBody = document.getElementById('question-bank-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:28px; text-align:center; color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading interview questions...</td></tr>`;
    if (groupedBody) groupedBody.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem; padding:24px 0;">Loading questions&hellip;</div>';

    fetch('/api/interview-reviews').then(r => r.json()).then(reviews => {
        qbAllReviews = reviews || [];
        const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));

        // Flatten all questions
        qbAllQuestions = [];
        let uidCounter = 0;
        const compCounts = {};
        const roundCounts = {};

        qbAllReviews.forEach(rv => {
            const comp = rv.company_name || 'Unknown';
            const rnd = rv.round_type || 'General';
            const role = rv.role_title || '';
            const qs = Array.isArray(rv.questions) ? rv.questions : [];

            qs.forEach(q => {
                const text = (q && (q.question || q.question_text || '')).trim();
                if (!text) return;
                uidCounter++;

                compCounts[comp] = (compCounts[comp] || 0) + 1;
                roundCounts[rnd] = (roundCounts[rnd] || 0) + 1;

                // What it tests resolution
                let whatItTests = q.what_it_tests || q.eval || q.what_it_evaluates || q.dimension || '';
                if (!whatItTests) {
                    const classified = qbClassify(text);
                    if (classified && classified.eval) whatItTests = classified.eval;
                }

                qbAllQuestions.push({
                    uid: uidCounter,
                    reviewId: rv.id,
                    company: comp,
                    round: rnd,
                    role: role,
                    interviewDate: rv.interview_date || '',
                    question: text,
                    whatItTests: whatItTests,
                    score: q.score != null ? q.score : null,
                    timestamp: q.timestamp || q.timestamp_range || '',
                    howToApproach: q.how_to_approach || '',
                    modelAnswer: q.model_answer || '',
                    answerSummary: q.answer_summary || q.summary || '',
                    strengths: q.strengths || [],
                    misses: q.misses || q.gaps || []
                });
            });
        });

        // Populate Company dropdown
        const compSelect = document.getElementById('qb-filter-company');
        if (compSelect) {
            const currentComp = compSelect.value;
            const sortedComps = Object.keys(compCounts).sort();
            let compHtml = `<option value="">All Companies (${qbAllQuestions.length})</option>`;
            sortedComps.forEach(c => {
                compHtml += `<option value="${esc(c)}">${esc(c)} (${compCounts[c]})</option>`;
            });
            compSelect.innerHTML = compHtml;
            if (currentComp) compSelect.value = currentComp;
        }

        // Populate Round dropdown
        const roundSelect = document.getElementById('qb-filter-round');
        if (roundSelect) {
            const currentRound = roundSelect.value;
            const sortedRounds = Object.keys(roundCounts).sort();
            let roundHtml = `<option value="">All Interview Rounds (${qbAllQuestions.length})</option>`;
            sortedRounds.forEach(r => {
                roundHtml += `<option value="${esc(r)}">${esc(r)} (${roundCounts[r]})</option>`;
            });
            roundSelect.innerHTML = roundHtml;
            if (currentRound) roundSelect.value = currentRound;
        }

        // Render Table View
        applyQbFilters();

        // Render Grouped View as well
        renderQbGrouped(qbAllReviews, esc);

    }).catch(err => {
        console.error('Error loading question bank:', err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:24px; text-align:center; color:var(--text-muted);">Could not load questions. Please check connection and refresh.</td></tr>`;
        if (groupedBody) groupedBody.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem; padding:20px 0;">Could not load the question bank.</div>';
    });
}

function loadPrepHubDetails(appId) {
    const role = (state.activePrepRoles || []).find(r => String(r.app_id || r.id) === String(appId));
    if (!role) {
        if (elements.prepEmptyState) elements.prepEmptyState.style.display = 'block';
        elements.prepDetailsContainer.style.display = 'none';
        return;
    }

    // Role Metadata Header
    if (elements.prepRoleTitle) elements.prepRoleTitle.innerText = role.role_title || role.title;
    if (elements.prepRoleCompany) elements.prepRoleCompany.innerText = role.company_name;
    if (elements.prepRoleMeta) elements.prepRoleMeta.innerText = role.resume_link ? `Resume Attached • Outcome: ${role.outcome || 'In Progress'}` : `Outcome: ${role.outcome || 'In Progress'}`;
    if (elements.prepRoleStageBadge) elements.prepRoleStageBadge.innerText = `Progress: ${role.pipeline_status || 'Submitted'}`;
    if (elements.prepUpdatedTime) elements.prepUpdatedTime.innerText = role.updated_at ? `AI Research Updated: ${role.updated_at}` : 'AI Guide Not Generated Yet';
    if (elements.btnGeneratePrepGuide) elements.btnGeneratePrepGuide.style.display = 'inline-flex';
    if (elements.prepNotes) elements.prepNotes.value = role.user_notes || role.app_notes || '';

    // Parse guide JSON
    let guide = null;
    try {
        if (role.guide_json) guide = typeof role.guide_json === 'string' ? JSON.parse(role.guide_json) : role.guide_json;
    } catch (e) {
        console.error('Error parsing guide_json:', e);
    }

    if (guide && guide.summary) {
        if (elements.prepInsightsTitle) elements.prepInsightsTitle.innerText = `${role.company_name} — ${role.title} Interview Strategy`;
        if (elements.prepInterviewSummary) elements.prepInterviewSummary.innerText = guide.summary;

        // Loop Stages Timeline
        if (elements.prepInterviewStages && guide.stages) {
            elements.prepInterviewStages.innerHTML = guide.stages.map((stg, idx) => `
                <div class="timeline-item">
                    <div class="timeline-marker">${idx + 1}</div>
                    <div class="timeline-content">
                        <h4 style="font-weight: 600; color: var(--text-primary);">${stg.title || ('Stage ' + (idx + 1))}</h4>
                        <p style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 2px;">${stg.desc || ''}</p>
                    </div>
                </div>
            `).join('');
        }

        // Evaluation Rubric & Signals
        if (elements.prepInterviewRubric && guide.rubric) {
            elements.prepInterviewRubric.innerHTML = guide.rubric.map(rub => `
                <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px 16px;">
                    <h5 style="font-size: 0.85rem; font-weight: 600; color: var(--primary); margin: 0 0 4px 0;">
                        <i class="fa-solid fa-square-check" style="margin-right: 6px;"></i> ${rub.competency || 'Competency'}
                    </h5>
                    <p style="font-size: 0.8rem; color: var(--text-secondary); margin: 0; line-height: 1.4;">${rub.details || ''}</p>
                </div>
            `).join('');
        }

        // Strategic Focus & Case Topics
        if (elements.prepStrategicFocus && guide.strategic_focus) {
            elements.prepStrategicFocus.innerHTML = guide.strategic_focus.map(fcs => `
                <li style="margin-bottom: 6px;"><i class="fa-solid fa-bullseye" style="color: var(--secondary); margin-right: 8px;"></i> ${fcs}</li>
            `).join('');
        }

        // Pro-Tips
        if (elements.prepInterviewTips && guide.tips) {
            elements.prepInterviewTips.innerHTML = guide.tips.map(tip => `
                <li style="margin-bottom: 6px;"><i class="fa-solid fa-circle-chevron-right" style="color: #0284c7; margin-right: 8px;"></i> ${tip}</li>
            `).join('');
        }

        // Question Bank
        if (elements.prepQuestionBank && guide.question_bank) {
            elements.prepQuestionBank.innerHTML = guide.question_bank.map(q => `
                <li style="margin-bottom: 8px; line-height: 1.4;"><i class="fa-solid fa-circle-question" style="color: var(--primary); margin-right: 8px;"></i> <strong>${q}</strong></li>
            `).join('');
        }
    } else {
        // Fallback before AI guide generation
        if (elements.prepInsightsTitle) elements.prepInsightsTitle.innerText = `${role.company_name} — Interview Prep Setup`;
        if (elements.prepInterviewSummary) elements.prepInterviewSummary.innerText = `Click 'Re-Generate AI Research' above to research ${role.company_name}'s standard interview process, evaluation rubric, case topics, and sample question bank for ${role.title}.`;
        
        if (elements.prepInterviewStages) {
            elements.prepInterviewStages.innerHTML = `
                <div class="timeline-item"><div class="timeline-marker">1</div><div class="timeline-content"><h4>1. Recruiter Screen (30m)</h4><p>Background, resume walkthrough, and motivation for ${role.company_name}.</p></div></div>
                <div class="timeline-item"><div class="timeline-marker">2</div><div class="timeline-content"><h4>2. Product Sense / Design (45m)</h4><p>Product vision, user empathy, and feature design case study.</p></div></div>
                <div class="timeline-item"><div class="timeline-marker">3</div><div class="timeline-content"><h4>3. Product Execution & Metrics (45m)</h4><p>Root cause analysis, success metrics definition, and trade-off decisions.</p></div></div>
                <div class="timeline-item"><div class="timeline-marker">4</div><div class="timeline-content"><h4>4. Leadership & Cultural Alignment (45m)</h4><p>Behavioral STAR stories, cross-functional collaboration, and leadership principles.</p></div></div>
            `;
        }
        if (elements.prepInterviewRubric) {
            elements.prepInterviewRubric.innerHTML = `
                <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px 16px;">
                    <h5 style="font-size: 0.85rem; font-weight: 600; color: var(--primary); margin: 0 0 4px 0;">Product Vision & Design</h5>
                    <p style="font-size: 0.8rem; color: var(--text-secondary); margin: 0;">Ability to define user personas, pain points, and creative product solutions.</p>
                </div>
                <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px 16px;">
                    <h5 style="font-size: 0.85rem; font-weight: 600; color: var(--primary); margin: 0 0 4px 0;">Execution & Data Rigor</h5>
                    <p style="font-size: 0.8rem; color: var(--text-secondary); margin: 0;">Setting metrics, debugging retention drops, and prioritizing technical trade-offs.</p>
                </div>
            `;
        }
        if (elements.prepStrategicFocus) elements.prepStrategicFocus.innerHTML = `<li><i class="fa-solid fa-bullseye" style="color: var(--secondary); margin-right: 8px;"></i> Research ${role.company_name}'s recent product announcements and strategic goals.</li>`;
        if (elements.prepInterviewTips) elements.prepInterviewTips.innerHTML = `<li><i class="fa-solid fa-circle-chevron-right" style="color: #0284c7; margin-right: 8px;"></i> Structure answers using CIRCLES method for Product Design and STAR method for Behavioral.</li>`;
        if (elements.prepQuestionBank) elements.prepQuestionBank.innerHTML = `<li><i class="fa-solid fa-circle-question" style="color: var(--primary); margin-right: 8px;"></i> Why ${role.company_name}? How would you improve their flagship product?</li>`;
    }

    if (elements.prepEmptyState) elements.prepEmptyState.style.display = 'none';
    elements.prepDetailsContainer.style.display = 'block';

    // P4: adaptive "prepare for your next round" panel from prior interview rounds.
    renderPrepNextRound(role.app_id || role.id);
}

// P4: pull the role's completed rounds and show what to fix before the next one. Renders into
// the Role-Related Prep surface (above the mock-question runner); falls back to the guide view.
function renderPrepNextRound(appId) {
    const runner = document.getElementById('reps-runner-container');
    const anchor = runner ? runner.parentNode : ((typeof elements !== 'undefined' && elements.prepDetailsContainer) || null);
    let panel = document.getElementById('prep-next-round-panel');
    if (!anchor || !appId) { if (panel) panel.innerHTML = ''; return; }
    fetch('/api/prep/next-round/' + encodeURIComponent(appId))
        .then(r => r.json())
        .then(data => {
            panel = document.getElementById('prep-next-round-panel');
            if (!panel) { panel = document.createElement('div'); panel.id = 'prep-next-round-panel'; }
            if (runner) { anchor.insertBefore(panel, runner); }        // sit above the mock runner
            else if (!panel.parentNode) { anchor.insertBefore(panel, anchor.firstChild); }
            data = data || {};
            const completed = data.rounds || [];
            const planned = data.planned || [];
            window._plannedCache = window._plannedCache || {};
            window._plannedCache[appId] = planned;

            const completedRows = completed.map(r => `
                <div style="display:flex; justify-content:space-between; gap:8px; font-size:0.8rem; padding:5px 0; border-bottom:1px solid var(--border-color);">
                    <span style="color:var(--text-secondary);">${escapeHtml(r.round_type || 'Round')} <span style="color:var(--text-muted);">${r.date || ''}</span></span>
                    <span style="color:var(--text-primary); font-weight:700;">${r.overall != null ? Number(r.overall).toFixed(1) : '—'}${r.weakest ? ` <span style="color:var(--text-muted); font-weight:500;">· weak: ${escapeHtml(r.weakest)}${r.weakest_score != null ? ' ' + r.weakest_score : ''}</span>` : ''}</span>
                </div>`).join('');

            const plannedRows = planned.map((p, i) => `
                <div style="padding:6px 0; border-bottom:1px solid var(--border-color);">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:0.8rem;">
                        <span style="color:var(--text-primary); font-weight:600;"><i class="fa-regular fa-circle" style="margin-right:6px; color:var(--primary);"></i>${escapeHtml(p.round_type || 'Round')}${p.interviewer ? ` <span style="color:var(--text-secondary); font-weight:500;">· ${escapeHtml(p.interviewer)}</span>` : ''} <span style="color:var(--text-muted); font-size:0.75rem;">${p.date ? '· ' + escapeHtml(p.date) : ''} [${escapeHtml(p.status || 'scheduled')}]</span></span>
                        <button type="button" title="Remove" onclick="removePlannedRound('${appId}', ${i})" style="background:none; border:0; color:var(--text-muted); cursor:pointer; font-size:0.9rem;">&times;</button>
                    </div>
                    ${p.evaluates ? `<div style="font-size:0.75rem; color:var(--text-secondary); margin-left:18px; margin-top:3px; line-height:1.35;"><b style="color:var(--text-muted); text-transform:uppercase; font-size:0.68rem; letter-spacing:0.03em;">Evaluates:</b> ${escapeHtml(p.evaluates)}</div>` : ''}
                </div>`).join('');

            const adaptiveHtml = completed.length ? `
                    <div style="font-weight:700; font-size:0.82rem; color:#c7d2fe; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
                        <i class="fa-solid fa-arrow-trend-up"></i> Prepare for your next round · adaptive
                    </div>
                    ${data.recommendation ? `<div style="font-size:0.86rem; color:var(--text-primary); font-weight:600; margin-bottom:8px;">${escapeHtml(data.recommendation)}</div>` : ''}
                    ${data.latest_one_fix ? `<div style="font-size:0.82rem; color:var(--text-secondary); margin-bottom:10px;"><b style="color:var(--text-primary);">Carry over from last round:</b> ${escapeHtml(data.latest_one_fix)}</div>` : ''}` : `
                    <div style="font-weight:700; font-size:0.82rem; color:#c7d2fe; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
                        <i class="fa-solid fa-list-check"></i> Prepare for your next round
                    </div>`;

            panel.innerHTML = `
                <div class="delivery-card" style="margin-bottom:16px; border-color:rgba(99,102,241,0.4); background:rgba(99,102,241,0.06);">
                    ${adaptiveHtml}
                    <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; margin:2px 0;">Upcoming rounds (as your recruiter shared)</div>
                    <div>${plannedRows || '<div style="font-size:0.78rem; color:var(--text-muted); padding:4px 0;">None added yet.</div>'}</div>
                    <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; align-items:center;">
                        <input id="pr-name-${appId}" placeholder="Round (e.g. Peer-director, people leadership)" style="flex:2; min-width:150px; font-size:0.78rem; padding:6px 9px; background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm);">
                        <input id="pr-who-${appId}" placeholder="Interviewer" style="flex:1; min-width:90px; font-size:0.78rem; padding:6px 9px; background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm);">
                        <input id="pr-date-${appId}" type="date" style="font-size:0.78rem; padding:6px 9px; background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm);">
                        <button type="button" onclick="addPlannedRound('${appId}')" style="font-size:0.78rem; font-weight:600; padding:6px 12px; background:var(--primary); color:#fff; border:0; border-radius:var(--radius-sm); cursor:pointer;">+ Add round</button>
                    </div>
                </div>`;
        })
        .catch(() => {});
}

// Role workspace (prototype flow): interview notes + associated interview performance for the
// selected role, rendered above the adaptive next-round panel and the mock-question runner.
function renderRoleWorkspace(appId) {
    const host = document.getElementById('role-workspace');
    if (!host) return;
    if (!appId) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = '';
    host.innerHTML = '<div class="delivery-card" style="margin-bottom:16px; color:var(--text-muted); font-size:0.82rem;">Loading role workspace…</div>';
    Promise.all([
        fetch('/api/prep/active-roles').then(r => r.json()).catch(() => []),
        fetch('/api/interview-reviews').then(r => r.json()).catch(() => [])
    ]).then(([roles, reviews]) => {
        const role = (roles || []).find(r => String(r.app_id) === String(appId)) || {};
        const notes = role.user_notes || role.app_notes || '';
        const roleReviews = (reviews || []).filter(rv => String(rv.role_job_id) === String(appId))
            .sort((a, b) => (Date.parse(a.interview_date || a.created_at || 0) || 0) - (Date.parse(b.interview_date || b.created_at || 0) || 0));
        const perfRows = roleReviews.length ? roleReviews.map(rv => {
            const scored = rv.overall_score != null;
            const s = scored ? Number(rv.overall_score).toFixed(1) : null;
            const tier = scored ? (s >= 7.5 ? 'score-tier-hi' : (s >= 5 ? 'score-tier-mid' : 'score-tier-lo')) : '';
            return `
              <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--border-color);">
                <div style="min-width:0;"><b style="color:var(--text-primary);">${escapeHtml(rv.round_type || 'Round')}</b>
                  <span style="color:var(--text-muted); font-size:0.76rem;">${rv.interview_date || (rv.created_at || '').split(' ')[0] || ''}${rv.interviewer_info ? ' · ' + escapeHtml(rv.interviewer_info) : ''}</span></div>
                <div style="display:flex; align-items:center; gap:10px; white-space:nowrap;">
                  ${scored ? `<span class="${tier}" style="font-weight:800;">${s}/10</span>` : '<span class="badge badge-queued-ai" style="font-size:0.66rem;">Queued</span>'}
                  <button type="button" class="btn btn-secondary btn-sm" onclick="openRoleReview(${rv.id})">View</button></div>
              </div>`;
        }).join('') : '<div style="color:var(--text-muted); font-size:0.82rem; padding:6px 0;">No interviews reviewed for this role yet.</div>';

        host.innerHTML = `
          <div class="sectlabel" style="margin:0 0 12px; display:flex; align-items:center; gap:12px;"><span class="prep-eyebrow">Rounds &amp; performance</span><span style="flex:1; height:1px; background:var(--border-color);"></span></div>
          <div class="delivery-card" style="margin-bottom:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:10px; flex-wrap:wrap;">
              <div style="font-weight:700; font-size:0.9rem; color:var(--text-primary);"><i class="fa-solid fa-clipboard-user" style="color:var(--primary);"></i> Interview performance (${roleReviews.length})</div>
              <div style="display:flex; gap:8px;">
                <button type="button" class="btn btn-primary btn-sm" onclick="attachRoundRecording(${appId})"><i class="fa-solid fa-cloud-arrow-up"></i> Attach audio / transcript</button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="applyPrepMode('interview_review')">Open Performance &rarr;</button>
              </div>
            </div>
            ${perfRows}
          </div>
          <div class="delivery-card" style="margin-bottom:16px;">
            <div style="font-weight:700; font-size:0.9rem; color:var(--text-primary); margin-bottom:8px;"><i class="fa-solid fa-note-sticky" style="color:var(--primary);"></i> Interview notes</div>
            <textarea id="role-ws-notes" style="width:100%; min-height:90px; font-size:0.85rem; padding:10px 12px; background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm); resize:vertical;" placeholder="Notes from the recruiter or HM, what to prep, comp discussion, interviewer intel…">${escapeHtml(notes)}</textarea>
            <div style="display:flex; justify-content:flex-end; margin-top:8px;"><button type="button" class="btn btn-primary btn-sm" onclick="saveRoleNotes(${appId})"><i class="fa-solid fa-floppy-disk"></i> Save notes</button></div>
          </div>`;
    }).catch(() => { host.innerHTML = ''; });
}

// 1h: attach a recording to a round — routes to the Performance ingest, preselected to this role.
window.attachRoundRecording = function (appId) {
    applyPrepMode('interview_review');
    let tries = 0;
    const focusIngest = () => {
        const sel = document.getElementById('ir-select-role');
        if (sel && sel.options.length > 1) {
            // match the ingest option to this application (by value, else by company name text)
            const role = (state.applications || []).find(a => String(a.id) === String(appId));
            let opt = [...sel.options].find(o => String(o.value) === String(appId));
            if (!opt && role) opt = [...sel.options].find(o => (o.text || '').toLowerCase().includes((role.company || '').toLowerCase()));
            if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
            sel.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        if (tries++ < 20) setTimeout(focusIngest, 200);
    };
    setTimeout(focusIngest, 300);
};

window.saveRoleNotes = function (appId) {
    const ta = document.getElementById('role-ws-notes');
    if (!ta) return;
    fetch('/api/prep/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: Number(appId), notes: ta.value }) })
        .then(r => r.json())
        .then(() => { if (typeof showToast === 'function') showToast('Interview notes saved.', 'success'); })
        .catch(() => { if (typeof showToast === 'function') showToast('Could not save notes.', 'error'); });
};

window.openRoleReview = function (reviewId) {
    applyPrepMode('interview_review');
    // The review list loads async; retry the selection until the target review is present.
    let tries = 0;
    const trySelect = () => {
        const ready = window.interviewReviewState && (interviewReviewState.reviews || []).some(r => r.id === reviewId);
        if (ready && typeof selectInterviewReview === 'function') { selectInterviewReview(reviewId); return; }
        if (tries++ < 25) setTimeout(trySelect, 200);
    };
    setTimeout(trySelect, 250);
};

// ===== Consolidated AI Processing Center: every queue that needs an AI pass, in one place =====
function renderAiCenter() {
    const el = document.getElementById('ai-processing-center');
    if (!el) return;
    Promise.all([
        fetch('/api/prep/queue/status').then(r => r.json()).catch(() => ({})),
        fetch('/api/claude-rescore/queue').then(r => r.json()).catch(() => ({ count: 0 })),
        fetch('/api/prep/active-roles').then(r => r.json()).catch(() => []),
        fetch('/api/interview-reviews').then(r => r.json()).catch(() => [])
    ]).then(([q, rescore, roles, reviews]) => {
        const byApp = {};
        (reviews || []).forEach(rv => { const k = String(rv.role_job_id); byApp[k] = (byApp[k] || 0) + 1; });
        // The server owns this queue: it adds a dossier job whenever an application moves
        // past 'Submitted' or changes stage.
        const dossierPending = q.dossier_pending || 0;
        const queues = [
            { name: 'Role dossier prep / update', icon: 'fa-building-columns', count: dossierPending, prompt: 'Process the role dossier queue' },
            { name: 'Interview performance eval', icon: 'fa-clipboard-user', count: q.interview_review_pending || 0, prompt: 'Process the interview performance review queue' },
            { name: 'Coaching report rewrite', icon: 'fa-graduation-cap', count: q.coaching_report_pending || 0, prompt: 'Process the coaching report queue' },
            { name: 'STAR story generation', icon: 'fa-comments', count: q.star_pending || 0, prompt: 'Process the behavioral STAR delivery scoring queue' },
            { name: 'Mock practice scoring (Behavioral / Craft / Fundamentals)', icon: 'fa-microphone-lines', count: (q.reps_pending || 0) + (q.delivery_pending || 0), prompt: 'Process the role prep queue' },
            { name: 'Fit re-scoring (Claude)', icon: 'fa-wand-magic-sparkles', count: (rescore && rescore.count) || 0, prompt: 'rescore the queued jobs' }
        ];
        const total = queues.reduce((s, x) => s + x.count, 0);
        el.innerHTML = `
          <div class="delivery-card">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:4px; flex-wrap:wrap;">
              <div style="display:flex; align-items:center; gap:10px;"><i class="fa-solid fa-robot" style="color:var(--primary);"></i><div style="font-weight:700; font-size:1rem; color:var(--text-primary);">AI Processing</div></div>
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="ai-queue-count ${total ? 'has' : ''}">${total} total pending</span>
                <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('Process all interview prep queues (STAR, Role Prep, Delivery Analysis, Interview Review)')"><i class="fa-solid fa-copy"></i> Copy all-queues prompt</button>
              </div>
            </div>
            <p style="font-size:0.82rem; color:var(--text-secondary); margin:0 0 14px;">Content the app generates or scores waits in these queues. Copy a prompt into Antigravity or Claude Code to process it; results then appear in the app. Counts refresh when you open this tab.</p>
            <div class="ai-queue-list">
              ${queues.map(qq => `
                <div class="ai-queue">
                  <div class="ai-queue-head"><i class="fa-solid ${qq.icon}"></i><span class="ai-queue-name">${qq.name}</span><span class="ai-queue-count ${qq.count ? 'has' : ''}">${qq.count} pending</span></div>
                  <div class="ai-queue-prompt"><code>${escapeHtml(qq.prompt)}</code><button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('${escapeAttr(qq.prompt)}')"><i class="fa-solid fa-copy"></i> Copy</button></div>
                </div>`).join('')}
            </div>
          </div>`;
    }).catch(() => { el.innerHTML = ''; });
}

// ===== My Roles: card-based home + role workspace with a living company dossier =====
function renderMyRolesHome() {
    const home = document.getElementById('myroles-home');
    if (!home) return;
    home.innerHTML = '<div style="color:var(--text-muted); padding:16px; font-size:0.85rem;">Loading roles…</div>';
    Promise.all([
        fetch('/api/prep/active-roles').then(r => r.json()).catch(() => []),
        fetch('/api/interview-reviews').then(r => r.json()).catch(() => []),
        fetch('/api/applications').then(r => r.json()).catch(() => [])
    ]).then(([roles, reviews, apps]) => {
        const byApp = {};
        (reviews || []).forEach(rv => { const k = String(rv.role_job_id); (byApp[k] = byApp[k] || []).push(rv); });
        // "Engaged" = actually talked to a recruiter/HM or interviewed (not just applied / got an email).
        const engaged = p => /sync|interview loop|full interview|onsite|panel|hiring manager|\bhm\b/i.test(String(p || ''));
        const isStarted = role => (byApp[String(role.app_id)] || []).length > 0 || !!role.guide_json || !!(role.user_notes && String(role.user_notes).trim()) || engaged(role.pipeline_status);
        const activeIds = new Set((roles || []).map(r => String(r.app_id)));

        // Active (In Progress) roles: split into prep-started vs not-yet-started.
        const activeStarted = [], activeNotStarted = [];
        (roles || []).forEach(role => {
            const rc = (byApp[String(role.app_id)] || []).length;
            const item = { id: role.app_id, company: role.company_name, role: role.role_title, rc, guide: role.guide_json, closed: false };
            (isStarted(role) ? activeStarted : activeNotStarted).push(item);
        });
        // Closed roles you actually engaged with (recruiter/HM sync or interview loop) — not every closed app.
        const closedEngaged = (apps || []).filter(a =>
            String(a.outcome || '').toLowerCase() === 'closed' && engaged(a.progress) && !activeIds.has(String(a.id)))
            .map(a => ({ id: a.id, company: a.company, role: a.role, rc: (byApp[String(a.id)] || []).length, guide: null, closed: true, progress: a.progress }));

        const card = (r) => `
            <button type="button" class="role-card" onclick="openRoleWorkspace(${r.id})"${r.closed ? ' style="opacity:.72"' : ''}>
              <div class="rc-head"><span class="rc-name">${escapeHtml(r.company || '')}</span><span class="status ${r.closed ? 'closed' : 'active'}">${r.closed ? 'Closed' : 'Active'}</span></div>
              <div class="rc-role">${escapeHtml(r.role || '')}</div>
              <div class="rc-pills">${r.rc > 0 ? `<span class="pill pri">${r.rc} round${r.rc === 1 ? '' : 's'}</span>` : `<span class="pill">${r.closed ? escapeHtml(r.progress || 'Engaged') : 'Prep started'}</span>`}${r.guide ? '<span class="pill">Dossier</span>' : ''}</div>
            </button>`;
        const pickerOptions = activeNotStarted
            .sort((a, b) => (a.company || '').localeCompare(b.company || ''))
            .map(r => `<option value="${r.id}">${escapeHtml(r.company)} — ${escapeHtml(r.role || '')}</option>`).join('');

        home.innerHTML = `
          <div class="prep-overview-head"><div class="prep-eyebrow">My Roles</div>
            <h2 class="prep-hero-title">Roles you are prepping for.</h2>
            <p class="prep-hero-sub">Active roles where you have started prep, plus closed roles you interviewed for. Open one for its living dossier, your round reports, and what to prep next.</p></div>
          <div class="delivery-card" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px;">
            <div style="font-weight:700; font-size:0.88rem; color:var(--text-primary); white-space:nowrap;"><i class="fa-solid fa-plus" style="color:var(--primary);"></i> Start prep on a role</div>
            <select id="startprep-select" style="flex:1; min-width:240px; font-size:0.85rem; padding:9px 12px; background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm);">
              <option value="">Pick an active (In Progress) role…</option>
              ${pickerOptions || '<option value="" disabled>All active roles already started</option>'}
            </select>
            <button type="button" class="btn btn-primary btn-sm" onclick="startPrepOnRole()">Start prep</button>
          </div>
          ${activeStarted.length ? `<div class="sectlabel" style="margin:6px 0 12px; display:flex; align-items:center; gap:12px;"><span class="status active">Active</span><span style="flex:1; height:1px; background:var(--border-color);"></span></div>
            <div class="role-card-grid">${activeStarted.map(card).join('')}</div>` : '<div style="color:var(--text-muted); font-size:0.85rem; padding:12px 0;">No active roles in prep yet. Pick one above to start.</div>'}
          ${closedEngaged.length ? `<div class="sectlabel" style="margin:24px 0 12px; display:flex; align-items:center; gap:12px;"><span class="status closed">Closed · interviewed</span><span style="flex:1; height:1px; background:var(--border-color);"></span></div>
            <div class="role-card-grid">${closedEngaged.map(card).join('')}</div>` : ''}
        `;
    }).catch(() => { home.innerHTML = '<div style="color:var(--text-muted); padding:16px;">Could not load roles.</div>'; });
}
window.startPrepOnRole = function () {
    const sel = document.getElementById('startprep-select');
    if (!sel || !sel.value) { if (typeof showToast === 'function') showToast('Pick a role to start prep on.', 'info'); return; }
    const appId = sel.value;
    fetch('/api/prep/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: Number(appId) }) })
        .then(() => openRoleWorkspace(appId))
        .catch(() => openRoleWorkspace(appId));
};

window.openRoleWorkspace = function (appId) {
    const home = document.getElementById('myroles-home'), ws = document.getElementById('myroles-workspace');
    if (home) home.style.display = 'none';
    if (ws) ws.style.display = '';
    // drive the existing role flow (notes + performance + adaptive + mock questions). Ensure the
    // hidden select has an option for this role (closed roles are not in the active list) so the
    // change handler renders notes/performance/next-round for active AND closed roles alike.
    const sel = document.getElementById('reps-select-role');
    if (sel) {
        if (![...sel.options].some(o => String(o.value) === String(appId))) {
            const o = document.createElement('option'); o.value = String(appId); sel.appendChild(o);
        }
        sel.value = String(appId); sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    Promise.all([
        fetch('/api/prep/active-roles').then(r => r.json()).catch(() => []),
        fetch('/api/applications').then(r => r.json()).catch(() => []),
        fetch('/api/prep/next-round/' + appId).then(r => r.json()).catch(() => ({}))
    ]).then(([roles, apps, nr]) => {
        let role = (roles || []).find(r => String(r.app_id) === String(appId));
        if (!role) {
            const a = (apps || []).find(x => String(x.id) === String(appId));
            if (a) role = { app_id: a.id, company_name: a.company, role_title: a.role, pipeline_status: a.progress, outcome: a.outcome, resume_link: a.resume_link, guide_json: null, user_notes: a.notes, app_notes: a.notes };
        }
        role = role || {};
        renderRoleHeaderAssets(role, nr);
        renderRoleDossier(appId, role, nr);
    });
    window.scrollTo(0, 0);
};
window.closeRoleWorkspace = function () {
    const home = document.getElementById('myroles-home'), ws = document.getElementById('myroles-workspace');
    if (ws) ws.style.display = 'none';
    if (home) home.style.display = '';
    renderMyRolesHome();
};

function renderRoleHeaderAssets(role, nr) {
    const el = document.getElementById('role-ws-header');
    if (!el) return;
    const rounds = (nr && nr.rounds) ? nr.rounds.length : 0;
    el.innerHTML = `
      <div class="delivery-card" style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
          <div><div style="font-family:'Outfit',sans-serif; font-size:1.4rem; font-weight:700; color:var(--text-primary);">${escapeHtml(role.company_name || '')}</div>
            <div style="color:var(--text-secondary); font-size:0.88rem; margin-top:2px;">${escapeHtml(role.role_title || '')}</div></div>
          <span class="pill" style="align-self:flex-start;">Progress: ${escapeHtml(role.pipeline_status || role.outcome || 'In Progress')}</span>
        </div>
        <div class="role-assets">
          <div class="asset"><div class="k">Tailored résumé</div><div class="v">${role.resume_link ? `<a href="${escapeAttr(role.resume_link)}" target="_blank" rel="noopener">Open résumé</a>` : 'Not attached'}</div></div>
          <div class="asset"><div class="k">Rounds completed</div><div class="v">${rounds}</div></div>
          <div class="asset"><div class="k">Next-round focus</div><div class="v">${nr && nr.weakest_dim ? escapeHtml(nr.weakest_dim.label) : '—'}</div></div>
        </div>
      </div>`;
}

// Discussion brief: the stage-specific part of the dossier, written when the application
// moves into a recruiter or hiring-manager conversation.
function renderDiscussionBrief(g, role) {
    const d = g.discussion_brief;
    const stageNow = role.pipeline_status || '';
    if (!d) {
        const waiting = stageNow && stageNow !== 'Submitted';
        return `<details class="doss" open><summary>Discussion brief <span class="doss-tag pri">${escapeHtml(stageNow || 'not started')}</span></summary><div class="doss-body" style="color:var(--text-muted);">${waiting
            ? 'Queued. A brief for this conversation is written on the next prep-queue run and appears here.'
            : 'Written automatically once this application moves from Submitted to a recruiter or hiring-manager conversation.'}</div></details>`;
    }
    const list = arr => (arr && arr.length) ? '<ul style="margin:4px 0 10px 18px;">' + arr.map(x => `<li>${escapeHtml(String(x))}</li>`).join('') + '</ul>' : '';
    const sec = (label, body) => body ? `<div style="margin-top:10px;"><b style="color:var(--text-primary);">${label}</b><div>${body}</div></div>` : '';
    const qs = (d.likely_questions || []).map(q => `<li><b>${escapeHtml(q.question || '')}</b>${q.approach ? '<br>' + escapeHtml(q.approach) : ''}</li>`).join('');
    const outdated = g.stage && stageNow && g.stage !== stageNow;
    return `<details class="doss" open><summary>Discussion brief <span class="doss-tag pri">${escapeHtml(g.stage || stageNow)}</span></summary><div class="doss-body">
        ${outdated ? `<div style="color:#f59e0b; margin-bottom:8px;">Written for "${escapeHtml(g.stage)}"; a rewrite for "${escapeHtml(stageNow)}" is queued.</div>` : ''}
        ${d.headline ? `<div style="font-weight:700; color:var(--text-primary);">${escapeHtml(d.headline)}</div>` : ''}
        ${sec('Who you are talking to', d.people ? escapeHtml(d.people) : '')}
        ${sec('Your 60-second pitch', d.pitch ? escapeHtml(d.pitch) : '')}
        ${sec('Proof points to land', list(d.proof_points))}
        ${sec('Likely questions and how to answer', qs ? '<ul style="margin:4px 0 10px 18px;">' + qs + '</ul>' : '')}
        ${sec('The gap they will probe', d.gap_and_answer ? escapeHtml(d.gap_and_answer) : '')}
        ${sec('Logistics and comp', d.logistics ? escapeHtml(d.logistics) : '')}
        ${sec('Questions to ask', list(d.questions_to_ask))}
        ${sec('History with this company', d.history ? escapeHtml(d.history) : '')}
        ${(g.sources && g.sources.length) ? `<div style="margin-top:10px; font-size:0.74rem; color:var(--text-muted);">Sources: ${g.sources.map(x => escapeHtml(String(x))).join(' · ')}${g.generated_at ? ' · written ' + escapeHtml(g.generated_at) : ''}</div>` : ''}
    </div></details>`;
}

function renderRoleDossier(appId, role, nr) {
    const el = document.getElementById('role-dossier');
    if (!el) return;
    let g = {};
    try { g = role.guide_json ? (typeof role.guide_json === 'string' ? JSON.parse(role.guide_json) : role.guide_json) : {}; } catch (e) { g = {}; }
    const co = g.company_overview || {};
    const fin = (k, v) => `<div class="doss-fin"><span class="k">${k}</span><span class="v">${v ? escapeHtml(String(v)) : '—'}</span></div>`;
    const prepGuidance = (nr && nr.recommendation) ? nr.recommendation : (g.prep_guidance || 'Refresh to generate next-round guidance from your completed rounds.');
    const jd = g.jd_overview || (role.app_notes ? String(role.app_notes).slice(0, 600) : '');
    const anyFin = co.revenue || co.profit || co.growth || co.stock || co.employees || co.trends;
    el.innerHTML = `
      <div class="sectlabel" style="margin:0 0 12px; display:flex; align-items:center; gap:12px;">
        <span class="prep-eyebrow">Company Dossier</span><span style="flex:1; height:1px; background:var(--border-color);"></span>
        <button type="button" class="btn btn-secondary btn-sm" onclick="refreshRoleDossier(${appId})"><i class="fa-solid fa-rotate"></i> Refresh (adaptive)</button>
      </div>
      <div id="doss-msg-${appId}" style="display:none;"></div>
      <details class="doss" open><summary>JD overview <span class="doss-tag">from JD</span></summary><div class="doss-body">${jd ? escapeHtml(jd) : 'Refresh to summarize this role\'s JD.'}</div></details>
      <details class="doss"><summary>Company overview <span class="doss-tag b">web</span></summary><div class="doss-body">
        <div class="doss-fin-grid">
          ${fin('Revenue / ARR', co.revenue)}${fin('Profit', co.profit)}${fin('Growth (YoY / QoQ)', co.growth)}
          ${fin('Stock · YTD', co.stock)}${fin('Employees', co.employees)}${fin('Recent trends', co.trends)}
        </div>
        ${anyFin ? '' : '<div class="confidence" style="margin-top:10px; color:var(--text-muted); font-size:0.76rem; font-style:italic;">Refresh to populate live company facts (revenue, profit, growth, stock/YTD, employees, trends).</div>'}
      </div></details>
      ${renderDiscussionBrief(g, role)}
      <details class="doss"><summary>Prep guidance for upcoming rounds <span class="doss-tag pri">adaptive</span></summary><div class="doss-body">
        ${escapeHtml(prepGuidance)}${nr && nr.latest_one_fix ? '<div style="margin-top:8px;"><b style="color:var(--text-primary);">Carry over from last round:</b> ' + escapeHtml(nr.latest_one_fix) + '</div>' : ''}
      </div></details>`;
}
window.refreshRoleDossier = function (appId) {
    // Queues a rewrite. This used to call the Groq prep guide, which replaced the dossier
    // with a different shape the dossier view cannot render.
    const msg = document.getElementById('doss-msg-' + appId);
    const show = t => { if (msg) { msg.style.cssText = 'display:block; font-size:0.8rem; color:#c7d2fe; background:var(--primary-glow); border:1px solid rgba(129,140,248,.3); border-radius:10px; padding:10px 13px; margin-bottom:10px;'; msg.textContent = t; } };
    fetch('/api/prep/dossier/' + Number(appId) + '/request', { method: 'POST' })
        .then(r => r.json())
        .then(body => {
            show(body && body.error ? ('Could not queue: ' + body.error)
                : 'Queued. The dossier is rewritten on the next prep-queue run and appears here when done.');
            if (typeof renderAiCenter === 'function') renderAiCenter();
        })
        .catch(() => show('Could not queue the refresh right now.'));
};

// P4: manual round entry. These override any web guess and drive the "next round" logic.
function savePlannedRounds(appId, rounds) {
    return fetch('/api/prep/planned-rounds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: Number(appId), rounds })
    }).then(() => renderPrepNextRound(appId));
}
function addPlannedRound(appId) {
    const name = (document.getElementById('pr-name-' + appId) || {}).value;
    if (!name || !name.trim()) return;
    const who = (document.getElementById('pr-who-' + appId) || {}).value || '';
    const date = (document.getElementById('pr-date-' + appId) || {}).value || '';
    const list = ((window._plannedCache || {})[appId] || []).slice();
    list.push({ round_type: name.trim(), interviewer: who.trim(), date, status: 'scheduled' });
    savePlannedRounds(appId, list);
}
function removePlannedRound(appId, idx) {
    const list = ((window._plannedCache || {})[appId] || []).slice();
    list.splice(idx, 1);
    savePlannedRounds(appId, list);
}

function generateAiPrepGuide(appId) {
    const role = (state.activePrepRoles || []).find(r => String(r.app_id || r.id) === String(appId));
    if (!role) return;

    const targetAppId = role.app_id || role.id;

    const origBtnHeader = elements.btnGeneratePrepGuideHeader ? elements.btnGeneratePrepGuideHeader.innerHTML : '';
    if (elements.btnGeneratePrepGuideHeader) {
        elements.btnGeneratePrepGuideHeader.disabled = true;
        elements.btnGeneratePrepGuideHeader.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Researching Company & Generating...';
    }
    if (elements.btnGeneratePrepGuide) {
        elements.btnGeneratePrepGuide.disabled = true;
        elements.btnGeneratePrepGuide.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Researching...';
    }

    showToast(`Researching ${role.company_name} interview process & rubric via AI...`);

    fetch('/api/prep/generate-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: targetAppId })
    })
    .then(res => res.json())
    .then(data => {
        if (elements.btnGeneratePrepGuideHeader) {
            elements.btnGeneratePrepGuideHeader.disabled = false;
            elements.btnGeneratePrepGuideHeader.innerHTML = origBtnHeader || '<i class="fa-solid fa-wand-magic-sparkles"></i> Re-Generate AI Research';
        }
        if (elements.btnGeneratePrepGuide) {
            elements.btnGeneratePrepGuide.disabled = false;
            elements.btnGeneratePrepGuide.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Live AI Guide & Rubric';
        }

        if (data.error) {
            showToast('Error: ' + data.error);
            return;
        }

        showToast(`Generated AI interview guide for ${role.company_name}!`);
        // Refresh active roles data and re-render
        fetch('/api/prep/active-roles')
            .then(res => res.json())
            .then(roles => {
                state.activePrepRoles = roles || [];
                loadPrepHubDetails(targetAppId);
            });
    })
    .catch(err => {
        if (elements.btnGeneratePrepGuideHeader) {
            elements.btnGeneratePrepGuideHeader.disabled = false;
            elements.btnGeneratePrepGuideHeader.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Re-Generate AI Research';
        }
        if (elements.btnGeneratePrepGuide) {
            elements.btnGeneratePrepGuide.disabled = false;
            elements.btnGeneratePrepGuide.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Live AI Guide & Rubric';
        }
        showToast('Failed to generate guide: ' + err);
    });
}

function savePrepHubNotes() {
    const appId = elements.prepSelectCompany.value;
    const notes = elements.prepNotes.value.trim();
    if (!appId) return;

    fetch('/api/prep/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, notes: notes })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast('Saved interview notes & STAR stories successfully!');
            const role = (state.activePrepRoles || []).find(r => String(r.app_id || r.id) === String(appId));
            if (role) role.user_notes = notes;
        } else {
            showToast('Error saving notes: ' + (data.error || 'Unknown error'));
        }
    });
}

// 5. Connections Tab
function renderConnectionsTab() {
    elements.connStatTotal.innerText = state.connections.length;
    
    const uniqueCompanies = [...new Set(state.connections.map(c => c.company.toLowerCase().strip()))].length;
    elements.connStatCompanies.innerText = uniqueCompanies;

    let filtered = state.connections;
    if (state.connSearchQuery) {
        filtered = filtered.filter(c => 
            c.first_name.toLowerCase().includes(state.connSearchQuery) ||
            c.last_name.toLowerCase().includes(state.connSearchQuery) ||
            c.company.toLowerCase().includes(state.connSearchQuery) ||
            c.position.toLowerCase().includes(state.connSearchQuery)
        );
    }
    
    // Update badge count
    elements.badgeConnections.innerText = state.connections.length;

    if (filtered.length === 0) {
        elements.connectionsListBody.innerHTML = '<tr><td colspan="3" class="table-empty">No matching contacts found.</td></tr>';
        return;
    }

    elements.connectionsListBody.innerHTML = filtered.slice(0, 100).map(c => `
        <tr>
            <td style="font-weight:600;"><a href="${c.url || '#'}" target="_blank">${c.first_name} ${c.last_name}</a></td>
            <td>${c.company}</td>
            <td style="color:var(--text-secondary);">${c.position}</td>
        </tr>
    `).join('');
}

function handleConnectionsCSVUpload(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    const mode = document.querySelector('input[name="upload-mode"]:checked').value;
    formData.append('mode', mode);

    showToast('Importing contacts list...');
    
    fetch('/api/connections/upload', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast(data.message);
            fetchConnections();
        } else {
            showToast('Error: ' + data.error);
        }
    });
}

function clearConnectionsNetwork() {
    if (!confirm('Are you sure you want to clear your LinkedIn connections database?')) return;
    
    fetch('/api/connections/clear', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToast('LinkedIn network database cleared.');
                fetchConnections();
            }
        });
}

// 6. Profile & Settings Tab
function renderProfileTab() {
    // Populate form fields
    elements.profileLocationsSettings.value = state.profile.locations.join(', ');
    elements.profileKeywordsSettings.value = state.profile.keywords.join(', ');
    if (elements.profileCompSettings) elements.profileCompSettings.value = state.profile.expected_comp || '';
    elements.profileLlmKeySettings.value = state.profile.llm_api_key || state.profile.gemini_api_key || '';

    // Populate companies list rows
    renderProfileCompaniesTable();
}

function renderProfileCompaniesTable() {
    // Sort companies before rendering
    const sorted = [...state.trackedCompanies].sort((a, b) => {
        const dir = state.companySortDir === 'asc' ? 1 : -1;
        switch (state.companySortKey) {
            case 'company':
                return dir * a.name.localeCompare(b.name);
            case 'cohort':
                return dir * (a.cohort || '').localeCompare(b.cohort || '');
            case 'scraped_capability':
                return dir * (a.platform || '').localeCompare(b.platform || '');
            case 'scraped_count': {
                const countA = state.allJobs.filter(j => (j.company_name || '').toLowerCase().trim() === a.name.toLowerCase().trim()).length;
                const countB = state.allJobs.filter(j => (j.company_name || '').toLowerCase().trim() === b.name.toLowerCase().trim()).length;
                return dir * (countA - countB);
            }
            default:
                return dir * a.name.localeCompare(b.name);
        }
    });

    // Update sort indicators
    document.querySelectorAll('.sortable-company-th').forEach(th => {
        const indicator = th.querySelector('.sort-indicator');
        if (th.dataset.col === state.companySortKey) {
            indicator.textContent = state.companySortDir === 'asc' ? '▲' : '▼';
        } else {
            indicator.textContent = '';
        }
    });

    elements.companiesListBody.innerHTML = sorted.map(co => {
        const scrapedCount = state.allJobs.filter(j => (j.company_name || '').toLowerCase().trim() === co.name.toLowerCase().trim()).length;
        const escapedName = co.name.replace(/'/g, "\\'");
        const coId = co.id || co.name;
        return `
        <tr>
            <td style="font-weight: 600;">${co.name}</td>
            <td><span class="card-tag ${getCohortBadgeClass(co.cohort)}">${co.cohort}</span></td>
            <td><code style="color:var(--primary); font-family:monospace;">${co.platform}</code></td>
            <td>${scrapedCount} leads</td>
            <td>
                <span style="font-size:0.75rem; color:var(--text-secondary); max-width:250px; display:inline-block; overflow:hidden; text-overflow:ellipsis;">
                    ${co.levels && co.levels.length > 0 ? co.levels.join(', ') : 'All levels tracked'}
                </span>
            </td>
            <td style="text-align: right; padding-right: 24px; white-space: nowrap;">
                <button type="button" class="btn btn-xs btn-outline" onclick="editTrackedCompany('${coId.replace(/'/g, "\\\'")}')" title="Edit" style="color:var(--primary); border-color:rgba(var(--primary-rgb),0.25); margin-right: 4px;">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
                <button type="button" class="btn btn-xs btn-outline btn-delete-co" onclick="deleteTrackedCompany('${escapedName}')" style="color:#ef4444; border-color:rgba(239,68,68,0.2);">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </td>
        </tr>`;
    }).join('');
}

function sortCompaniesBy(colKey) {
    if (state.companySortKey === colKey) {
        state.companySortDir = state.companySortDir === 'asc' ? 'desc' : 'asc';
    } else {
        state.companySortKey = colKey;
        state.companySortDir = 'asc';
    }
    renderProfileCompaniesTable();
}

function editTrackedCompany(companyId) {
    const co = state.trackedCompanies.find(c => (c.id || c.name) === companyId);
    if (!co) return;

    document.getElementById('edit-co-id').value = co.id || co.name;
    document.getElementById('edit-co-name').value = co.name;
    document.getElementById('edit-co-cohort').value = co.cohort || 'Non-Mag 7';
    document.getElementById('edit-co-portal-url').value = co.portal_url || '';

    // Set level checkboxes
    const levels = co.levels || [];
    document.querySelectorAll('#edit-co-levels-group input[type="checkbox"]').forEach(cb => {
        cb.checked = levels.includes(cb.value);
    });

    document.getElementById('edit-company-modal').style.display = 'flex';
}

function saveEditedCompany(e) {
    e.preventDefault();
    const companyId = document.getElementById('edit-co-id').value;
    const levels = Array.from(document.querySelectorAll('#edit-co-levels-group input:checked')).map(cb => cb.value);

    const payload = {
        name: document.getElementById('edit-co-name').value.trim(),
        cohort: document.getElementById('edit-co-cohort').value,
        portal_url: document.getElementById('edit-co-portal-url').value.trim(),
        levels: levels
    };

    fetch(`/api/companies/${encodeURIComponent(companyId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToast(data.message || 'Company updated!');
                document.getElementById('edit-company-modal').style.display = 'none';
                fetchCompanies();
            } else {
                showToast(data.error || 'Failed to update company', 'error');
            }
        })
        .catch(err => showToast('Network error updating company', 'error'));
}

function deleteTrackedCompany(companyName) {
    if (!confirm(`Are you sure you want to stop tracking ${companyName}? This deletes all scraped job leads for this company.`)) return;
    
    fetch(`/api/companies/${encodeURIComponent(companyName)}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToast(data.message);
                fetchCompanies();
                fetchJobs();
            }
        });
}

function handleAddCompany(e) {
    e.preventDefault();
    
    const levelsChecked = Array.from(elements.newCoLevelsGroup.querySelectorAll('input[name="new-co-level"]:checked')).map(cb => cb.value);
    
    const payload = {
        name: elements.newCoName.value.trim(),
        cohort: elements.newCoCohort.value,
        portal_url: elements.newCoPortalUrl.value.trim(),
        levels: levelsChecked
    };
    
    fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast(`Added and started tracking company board!`);
            elements.addCompanyModal.style.display = 'none';
            elements.addCompanyForm.reset();
            fetchCompanies();
        } else {
            showToast('Error: ' + data.error);
        }
    });
}

function saveProfileSettings() {
    const locs = elements.profileLocationsSettings.value.split(',').map(s => s.trim()).filter(s => s);
    const kws = elements.profileKeywordsSettings.value.split(',').map(s => s.trim()).filter(s => s);
    const comp = elements.profileCompSettings ? elements.profileCompSettings.value.trim() : (state.profile.expected_comp || '');
    
    state.profile.locations = locs;
    state.profile.keywords = kws;
    state.profile.expected_comp = comp;
    state.profile.llm_api_key = elements.profileLlmKeySettings.value.trim();
    
    saveProfileDataToServer().then(() => {
        showToast('Search preferences updated. Active job leads re-scored!');
        fetchJobs();
    });
}

// Onboarding Wizard Overlay
function showOnboardingWizard() {
    elements.onboardLocations.value = state.profile.locations ? state.profile.locations.join(', ') : 'New York, NYC, Remote';
    elements.onboardKeywords.value = state.profile.keywords ? state.profile.keywords.join(', ') : 'Product Manager, Product Management, Technical Product Manager';
    elements.onboardComp.value = state.profile.expected_comp || '';
    elements.onboardLlmKey.value = state.profile.llm_api_key || state.profile.gemini_api_key || '';
    
    elements.onboardName.value = state.profile.name || '';
    elements.onboardEmail.value = state.profile.email || '';
    elements.onboardPhone.value = state.profile.phone || '';
    elements.onboardLocation.value = state.profile.location || '';
    elements.onboardLinkedin.value = state.profile.linkedin || '';
    elements.onboardSummary.value = state.profile.summary || '';
    elements.onboardResumeText.value = state.profile.canonical_resume || '';

    elements.onboardingModal.style.display = 'flex';
}

function submitOnboarding() {
    // Collect step 1
    const locs = elements.onboardLocations.value.split(',').map(s => s.trim()).filter(s => s);
    const kws = elements.onboardKeywords.value.split(',').map(s => s.trim()).filter(s => s);
    const comp = elements.onboardComp.value.trim();

    // Collect step 2
    const name = elements.onboardName.value.trim();
    const email = elements.onboardEmail.value.trim();
    const phone = elements.onboardPhone.value.trim();
    const location = elements.onboardLocation.value.trim();
    const linkedin = elements.onboardLinkedin.value.trim();
    const summary = elements.onboardSummary.value.trim();

    // Collect step 3
    const resumeText = elements.onboardResumeText.value.trim();
    const contributions = [];
    if (elements.onboardContributionsList) {
        elements.onboardContributionsList.querySelectorAll('.bullet-item-editor textarea').forEach(textarea => {
            const bulletText = textarea.value.trim();
            if (bulletText) {
                contributions.push({
                    id: 'c_' + Math.random().toString(36).substring(2, 9),
                    category: 'Key Accomplishment',
                    company: 'Previous Company',
                    role: 'Product Manager',
                    dates: 'Dates',
                    bullet: bulletText
                });
            }
        });
    }

    state.profile = {
        name, email, phone, location, linkedin, summary,
        locations: locs,
        keywords: kws,
        expected_comp: comp,
        seniority_levels: [],
        canonical_resume: resumeText,
        contributions_bank: contributions,
        education: [],
        llm_api_key: elements.onboardLlmKey.value.trim(),
        onboarded: 1
    };

    saveProfileDataToServer().then(() => {
        showToast('Onboarding complete! Syncing career dashboards...');
        elements.onboardingModal.style.display = 'none';
        
        // Load page
        fetchJobs();
        fetchCompanies();
        fetchConnections();
    });
}

// 7. General Helper Functions
function fetchJobs() {
    state.allJobsWithArchived = null;
    state._intakeJobsPromise = null;
    return fetch('/api/jobs')
        .then(res => res.json())
        .then(jobs => {
            state.allJobs = Array.isArray(jobs) ? jobs : [];
            renderActiveTab();
            updateSidebarCounts();
        })
        .catch(err => {
            console.error('Failed to fetch jobs:', err);
            state.allJobs = [];
        });
}

function fetchCompanies() {
    return fetch('/api/companies')
        .then(res => res.json())
        .then(companies => {
            state.trackedCompanies = Array.isArray(companies) ? companies : [];
            populateCompanyFilter();
            renderActiveTab();
        })
        .catch(err => {
            console.error('Failed to fetch companies:', err);
            state.trackedCompanies = [];
        });
}

function fetchConnections() {
    return fetch('/api/connections')
        .then(res => res.json())
        .then(rows => {
            state.connections = Array.isArray(rows) ? rows : [];
            if (elements.badgeConnections) elements.badgeConnections.innerText = state.connections.length;
            renderActiveTab();
        })
        .catch(err => {
            console.error('Failed to fetch connections:', err);
            state.connections = [];
        });
}

function triggerCrawlerScan() {
    state.isScanning = true;
    elements.btnScan.disabled = true;
    elements.scanIcon.classList.add('fa-spin');
    elements.syncBanner.style.display = 'flex';
    
    fetch('/api/scan', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            showToast('Daily job portal crawl dispatched in background...');
            pollScanStatus();
        });
}

function pollScanStatus() {
    elements.pollInterval = setInterval(() => {
        fetch('/api/scan-status')
            .then(res => res.json())
            .then(data => {
                if (!data.is_scanning) {
                    clearInterval(elements.pollInterval);
                    state.isScanning = false;
                    elements.btnScan.disabled = false;
                    // A completed scan rewrites scan_audit, so the source-check banner
                    // is stale until we re-read it.
                    refreshParityAudit();
                    elements.scanIcon.classList.remove('fa-spin');
                    elements.syncBanner.style.display = 'none';
                    fetch('/api/scan-audit').then(r => r.json()).then(audit => {
                        if (audit && audit.available && (audit.status === 'error' || audit.error_message)) {
                            showToast(`Sync failed: ${audit.error_message || 'Could not pull jobs from source'}`, 'error');
                        } else {
                            showToast('Job board sync complete! Fetched latest postings.', 'success');
                        }
                    }).catch(() => {
                        showToast('Job board sync complete! Fetched latest postings.');
                    });
                    fetchJobs();
                    fetchProfile();
                }
            });
    }, 4000);
}

// Job Details Modal handler
function openJobDetails(jobId) {
    const job = state.allJobs.find(j => j.id === jobId);
    if (!job) return;
    
    state.selectedJob = job;
    
    // Set text contents
    elements.modalRoleTitle.innerText = job.title;
    elements.modalCompany.innerText = job.company_name;
    elements.modalLocText.innerText = job.location;
    elements.modalDate.innerText = `First Seen: ${job.first_seen_at ? job.first_seen_at.substring(0, 10) : 'N/A'}`;
    elements.modalJobLink.href = job.url;
    
    // Map cohort badges
    const co = state.trackedCompanies.find(c => c.name.toLowerCase().strip() === job.company_name.toLowerCase().strip());
    elements.modalCohort.innerText = co ? co.cohort : 'Non-Mag 7';
    elements.modalCohort.className = 'modal-cohort-tag ' + (co ? getCohortBadgeClass(co.cohort) : 'cohort-other');

    // Default to description tab
    elements.modalTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === 'description'));
    elements.tabPanes.forEach(pane => pane.classList.toggle('active', pane.id === 'pane-description'));
    
    // Load description skeleton
    elements.descLoader.style.display = 'block';
    elements.modalDescContent.innerHTML = '';
    
    fetch(`/api/job-description?url=${encodeURIComponent(job.url)}`)
        .then(res => res.json())
        .then(data => {
            elements.descLoader.style.display = 'none';
            if (data.description) {
                elements.modalDescContent.innerHTML = `<div style="white-space: pre-wrap; font-size: 0.85rem; line-height: 1.5; color: var(--text-primary);">${data.description}</div>`;
                
                // If this job description text isn't saved, save it in the database notes so we retain it!
                if (!job.notes || job.notes === 'Click to parse details.') {
                    job.notes = data.description;
                    // Simple background call to update the job description in the SQLite db
                    fetch(`/api/jobs/${job.id}/tracking`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ app_status: job.pipeline_status, notes: data.description })
                    });
                }
            } else {
                elements.modalDescContent.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-muted);">Failed to extract description content. Click the link below to apply directly.</p>`;
            }
        })
        .catch(() => {
            elements.descLoader.style.display = 'none';
            elements.modalDescContent.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-muted);">Could not fetch description from link.</p>`;
        });

    // Populate Interview Strategy tab
    fetch(`/api/insights?company=${encodeURIComponent(job.company_name)}`)
        .then(res => res.json())
        .then(insights => {
            elements.modalInterviewSummary.innerText = `Detailed PM Interview Guide for ${job.company_name}.`;
            elements.modalInterviewStages.innerHTML = insights.stages.map((stage, idx) => `
                <div class="timeline-item">
                    <div class="timeline-marker">${idx + 1}</div>
                    <div class="timeline-content">
                        <h4>${stage.title}</h4>
                        <p>${stage.desc}</p>
                    </div>
                </div>
            `).join('');
            
            elements.modalInterviewTips.innerHTML = insights.tips.map(tip => `
                <li><i class="fa-solid fa-circle-chevron-right" style="color: var(--primary); margin-right: 8px;"></i> ${tip}</li>
            `).join('');
        });

    // Populate Company Info
    fetch(`/api/company-info?company=${encodeURIComponent(job.company_name)}`)
        .then(res => res.json())
        .then(info => {
            elements.compHq.innerText = info.hq || 'N/A';
            elements.compFounded.innerText = info.founded || 'N/A';
            elements.compRevenue.innerText = info.revenue || 'N/A';
            elements.compEmployees.innerText = info.employees || 'N/A';
            elements.compDomain.innerText = info.domain || 'N/A';
        });

    // Populate Application Tracker fields
    elements.modalTabTracking.style.display = 'block';
    elements.trackStatus.value = job.pipeline_status || 'Applied';
    elements.trackOutcome.value = 'Active / Pending';
    const hasResume = job.resume_url && job.resume_url.trim() !== '';
    let displayResumeUrl = '';
    if (hasResume) {
        if (job.resume_url.startsWith('/api')) {
            displayResumeUrl = `${window.location.origin}${job.resume_url}`;
        } else {
            displayResumeUrl = job.resume_url;
        }
    }
    elements.trackResume.value = displayResumeUrl;
    elements.btnViewResume.style.display = hasResume ? 'inline-block' : 'none';
    elements.btnViewResume.href = displayResumeUrl || '#';


    // Populate Connections/Referrals list
    const companyConns = state.connections.filter(c => c.company.toLowerCase().includes(job.company_name.toLowerCase()));
    elements.modalTabReferrals.style.display = companyConns.length > 0 ? 'block' : 'none';
    
    if (companyConns.length > 0) {
        elements.referralsListBody.innerHTML = companyConns.map((c, idx) => `
            <tr>
                <td style="text-align: center;"><input type="radio" name="select-referral-conn" value="${c.id}" onchange="generateReferralMessageDraft('${job.company_name}', '${c.first_name}', '${job.title}')"></td>
                <td style="font-weight: 600;">${c.first_name} ${c.last_name}</td>
                <td style="font-size:0.75rem; color:var(--text-secondary);">${c.position}</td>
            </tr>
        `).join('');
        elements.referralMessageDraft.value = '';
    }

    // Modal footer dynamic buttons
    elements.modalFooterActions.innerHTML = '';
    if (job.status === 'Lead') {
        elements.modalFooterActions.innerHTML = `
            <button class="btn btn-primary" onclick="moveToConsideration('${job.id}'); elements.jobModal.style.display = 'none';">
                <i class="fa-solid fa-star"></i> Move to Pipeline
            </button>
            <button class="btn btn-outline" style="color:#ef4444; border-color:rgba(239,68,68,0.25);" onclick="archiveJobLead('${job.id}')">
                <i class="fa-solid fa-box-archive"></i> Archive Lead
            </button>
        `;
    } else {
        elements.modalFooterActions.innerHTML = `
            <button class="btn btn-outline" style="color:#ef4444; border-color:rgba(239,68,68,0.25);" onclick="archiveJobLead('${job.id}')">
                <i class="fa-solid fa-box-archive"></i> Archive Application
            </button>
        `;
    }

    elements.jobModal.style.display = 'flex';
}

function archiveJobLead(jobId) {
    const reason = prompt('Specify archiving reason (e.g. Too Senior, Low Comp, Closed):', 'Closed');
    if (reason === null) return;
    
    fetch(`/api/jobs/${jobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Archived', archive_reason: reason })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast('Role archived.');
            elements.jobModal.style.display = 'none';
            fetchJobs();
        }
    });
}

function handleJobTrackingUpdate(e) {
    e.preventDefault();
    if (!state.selectedJob) return;
    
    const targetStatus = elements.trackStatus.value;
    const resumeLink = elements.trackResume.value;
    
    fetch(`/api/jobs/${state.selectedJob.id}/tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            app_status: targetStatus, 
            resume_url: resumeLink,
            notes: 'Manual tracking update' 
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast('Application tracking stage updated!');
            elements.jobModal.style.display = 'none';
            fetchJobs();
        }
    });
}


function generateReferralMessageDraft(company, firstName, roleTitle) {
    const draft = `Hi ${firstName},\n\nHope you are doing well!\n\nI noticed an open PM position at ${company} for a "${roleTitle}" and I'm really excited about it. Given your experience there, I would love to get your thoughts on the team culture or any advice you might have.\n\nWould you be open to a quick 10-minute chat or passing along my resume to the hiring team if you feel it's a fit?\n\nReally appreciate your help!\n\nBest,\n[Your Name]`;
    elements.referralMessageDraft.value = draft;
}

// Header and Sidebar updates
function updateViewHeader() {
    const titles = {
        sourcing: { title: "Sourcing Board", desc: "Review daily crawled job openings, matched by seniority and relevancy score." },
        insights: { title: "Market Insights", desc: "Interactive data analytics & visual distribution across companies, seniority, recommendations, industry, and compensation." },
        pipeline: { title: "Interview Pipeline", desc: "Track active job leads and drag cards between interview rounds." },
        prep: { title: "Preparation Hub", desc: "Access company-specific loop guides, tips, and write down answers." },
        connections: { title: "LinkedIn Network", desc: "Import LinkedIn CSV backups to match contacts for referral outreach." },
        consideration: { title: "Under Consideration", desc: "Roles queued for the agentic pipeline — résumé built and verified, application filled, waiting on your submit." },
        applications: { title: "Application & Interview Pipeline", desc: "Track every role you've applied to — submission method, referral, progress, and outcome." },
        profile: { title: "Profile & Settings", desc: "Adjust onboarding preferences, seniority targets, and track companies." }
    };

    const info = titles[state.activeTab] || titles.sourcing;
    elements.viewTitle.innerText = info.title;
    elements.viewDesc.innerText = info.desc;

    // The generic "Total Leads / Considered Rate" header panel is Sourcing-specific and
    // confusing elsewhere; hide it on the Applications tab (which shows its own stats bar).
    const headerStats = document.getElementById('header-stats');
    if (headerStats) headerStats.style.display = state.activeTab === 'applications' ? 'none' : '';
}

function updateSidebarCounts() {
    // Count every active row, not just status === 'Lead'. Starring a job flips its status to
    // 'Consideration', so the old test quietly dropped starred roles from the nav badge and
    // it disagreed with the "Open Roles" header stat (1,476 vs 1,480).
    const leads = state.allJobs.filter(j => j.status !== 'Archived').length;
    elements.badgeLeads.innerText = leads;
    
    const pipelineCount = state.allJobs.filter(j => j.status === 'Consideration' || (j.pipeline_status && j.pipeline_status !== 'Sourced')).length;
    if (elements.badgePipeline) elements.badgePipeline.innerText = pipelineCount;
}

function updateCompanyResetButton() {
    if (!elements.btnResetCompanyFilter) return;
    if (state.selectedCompany && state.selectedCompany !== 'all') {
        elements.btnResetCompanyFilter.style.display = 'inline-flex';
    } else {
        elements.btnResetCompanyFilter.style.display = 'none';
    }
}

function populateCompanyFilter() {
    const companies = [...new Set(state.allJobs.filter(j => {
        // Starred rows carry status 'Consideration' — they must stay on the board
        // (filtering to 'Lead' was silently hiding everything you actioned).
        return j.status !== 'Archived';
    }).map(j => j.company_name))].sort();
    const current = state.selectedCompany || (elements.companyFilter ? elements.companyFilter.value : 'all');
    
    if (elements.companyFilter) {
        elements.companyFilter.innerHTML = `<option value="all">All companies (${companies.length})</option>` +
            companies.map(co => `<option value="${co}">${co}</option>`).join('');
            
        elements.companyFilter.value = current;
    }
    updateCompanyResetButton();
}

function getCohortBadgeClass(industry) {
    const ind = (industry || '').toLowerCase().trim();
    if (ind === 'tech') return 'cohort-tech';
    if (ind === 'fintech') return 'cohort-fintech';
    if (ind === 'biotech') return 'cohort-biotech';
    if (ind === 'hardware') return 'cohort-hardware';
    if (ind === 'consumer') return 'cohort-consumer';
    if (ind === 'gaming') return 'cohort-gaming';
    if (ind === 'media') return 'cohort-media';
    if (ind === 'banking') return 'cohort-banking';
    if (ind === 'consulting') return 'cohort-consulting';
    if (ind === 'health-tech') return 'cohort-healthtech';
    return 'cohort-other';
}

// Extracts the HIGHER end (ceiling) of a job's compensation range in dollars.
// Supports "$184,700 - $324,800", "$220K - $350K", "$1.1M", etc. Returns 0 if unlisted ('N/A').
function parseSalaryNumber(salaryStr) {
    if (!salaryStr || salaryStr === 'N/A') return 0;
    const s = String(salaryStr).replace(/,/g, '');
    const nums = [];
    const regex = /\$?\s*(\d+(?:\.\d+)?)\s*([kKmM])?/g;
    let m;
    while ((m = regex.exec(s)) !== null) {
        let val = parseFloat(m[1]);
        if (isNaN(val)) continue;
        const unit = (m[2] || '').toLowerCase();
        if (unit === 'm') {
            val *= 1000000;
        } else if (unit === 'k') {
            val *= 1000;
        } else if (val > 0 && val < 1000) {
            // Bare number like "$200 - $300" (if ever formatted in thousands without K)
            continue;
        }
        if (val >= 30000 && val <= 10000000) {
            nums.push(Math.round(val));
        }
    }
    return nums.length ? Math.max(...nums) : 0;
}

// Utility Safe JSON
JSON.loadsSafely = function(str, fallback = []) {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch(e) {
        return fallback;
    }
};

// Toast notification
// `type` is optional ('success' | 'error' | 'info') and maps to the existing
// .toast.success / .toast.error accent styles. Errors linger longer.
function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = type === 'info' ? 'toast' : `toast ${type}`;
    const icon = { success: 'fa-circle-check', error: 'fa-circle-exclamation' }[type] || 'fa-circle-info';
    toast.innerHTML = `<i class="fa-solid ${icon}" style="margin-right:8px;"></i> ${msg}`;
    elements.toastContainer.appendChild(toast);

    // Fade in
    setTimeout(() => toast.classList.add('show'), 100);
    // Remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, type === 'error' ? 7000 : 4000);
}

// String polyfills
String.prototype.strip = function() {
    return this.trim();
};

// Global File Upload handlers called on change
window.handleOnboardResumeUpload = function(input) {
    const file = input.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    showToast("Extracting text from resume file...");
    fetch('/api/profile/upload-resume', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            const txtArea = document.getElementById('onboard-resume-text');
            if (txtArea) txtArea.value = data.text;
            showToast("Resume parsed and loaded successfully!");
            fetchProfile();
        } else {
            showToast("Parse failed: " + data.error);
        }
    })
    .catch(() => showToast("Error connecting to resume parse API."));
};

window.handleTemplateUpload = function(input) {
    const file = input.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    showToast("Uploading resume template...");
    fetch('/api/profile/upload-template', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast("Resume template saved successfully!");
        } else {
            showToast("Upload failed: " + data.error);
        }
    })
    .catch(() => showToast("Error connecting to template API."));
};

window.handleContributionsUpload = function(input) {
    const file = input.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    showToast("Importing achievements bank...");
    fetch('/api/profile/upload-contributions', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast(`Loaded ${data.count} achievements into your Contributions Bank!`);
            fetchProfile().then(() => {
                const editor = document.getElementById('contributions-editor');
                if (editor) {
                    renderAccomplishmentsBank();
                }
                handleTailorJobSelection();
            });
        } else {
            showToast("Import failed: " + data.error);
        }
    })
    .catch(() => showToast("Error connecting to contributions API."));
};

// Modern list formatting & tracking helpers
// Concise location formatter: shows only the user's target locations
// (New York, specific New Jersey city/state, and/or Remote), while keeping full raw location on hover.
const _UNAMBIGUOUS_NJ_CITIES = [
    "Jersey City", "Newark", "Hoboken", "Weehawken", "Secaucus",
    "Princeton", "Plainsboro", "Lawrenceville", "Skillman", "Titusville", "Pennington",
    "Short Hills", "Millburn", "New Providence", "Berkeley Heights",
    "Whippany", "Morristown", "Parsippany", "Florham Park", "East Hanover", "Chatham",
    "Basking Ridge", "Bridgewater", "Raritan", "Somerville", "Bedminster", "Peapack", "Branchburg",
    "New Brunswick", "East Brunswick", "North Brunswick", "Piscataway", "Edison", "Iselin", "Woodbridge", "Metuchen", "Cranbury", "Monmouth Junction",
    "Rahway", "Kenilworth", "Roseland", "Livingston", "West Orange", "Montclair", "Nutley",
    "Englewood Cliffs", "Fort Lee", "Teaneck", "Hackensack", "Paramus", "Ridgefield Park", "Rutherford", "Lyndhurst", "Montvale", "Woodcliff Lake", "Park Ridge", "Mahwah", "Ramsey", "Franklin Lakes", "Wyckoff",
    "Wayne", "Paterson", "Clifton", "Totowa", "Little Falls",
    "Holmdel", "Eatontown", "Red Bank",
    "Mount Laurel", "Mt. Laurel", "Mt Laurel", "Cherry Hill", "Camden", "Voorhees", "Moorestown"
];
const _AMBIGUOUS_NJ_CHECK = new Set([
    "wayne", "camden", "princeton", "livingston", "roseland", "middletown",
    "red bank", "bridgewater", "somerville", "edison", "woodbridge", "clifton", "paterson", "fort lee"
]);
const _NY_SUBURB_CITIES = [
    "Harrison", "Purchase", "Armonk", "White Plains", "Tarrytown", "Rye", "Yonkers",
    "Melville", "Lake Success", "Jericho", "Garden City", "Hauppauge", "Albany", "Rochester", "Buffalo"
];

function formatLocationConcise(rawLoc, title) {
    const s = String(rawLoc || '').replace(/\s+/g, ' ').trim();
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    const combined = `${s} ${t}`;
    const low = combined.toLowerCase();
    if (!s && !t) return 'N/A';

    const parts = [];

    // 1. New York (NYC or specific NY city)
    const hasNyc = /\b(new\s+york(\s+city)?|nyc|manhattan|brooklyn|queens|long\s+island\s+city|bronx|staten\s+island)\b/.test(low)
        && !/\bwest\s+new\s+york\b/.test(low);
    let nySuburb = null;
    if (!hasNyc) {
        for (const sub of _NY_SUBURB_CITIES) {
            const re = new RegExp('\\b' + sub.toLowerCase().replace(/\./g, '\\.') + '\\s*,\\s*(?:ny|new\\s+york)\\b');
            if (re.test(low)) {
                nySuburb = sub;
                break;
            }
        }
    }
    const hasAnyNy = hasNyc
        || !!nySuburb
        || /,\s*ny\b/.test(low)
        || /\bny\s*[\-–—|/,]\s*(new\s+york|nyc|us|usa)\b/.test(low)
        || /\b(usa|us)\s+ny\b/.test(low)
        || /\(ny\)/.test(low);
    if (hasAnyNy) {
        parts.push((nySuburb && !hasNyc) ? `${nySuburb}, NY` : 'New York, NY');
    }

    // 2. New Jersey (include specific NJ city if present)
    const hasExplicitNjState = /\bnew\s+jersey\b/.test(low) || /(?:,|\b)\s*nj\b/.test(low);
    const njCities = [];
    for (const city of _UNAMBIGUOUS_NJ_CITIES) {
        const clow = city.toLowerCase();
        const re = new RegExp('\\b' + clow.replace(/\./g, '\\.') + '\\b');
        if (re.test(low)) {
            if (_AMBIGUOUS_NJ_CHECK.has(clow) && !hasExplicitNjState) continue;
            const normCity = (clow === 'mt. laurel' || clow === 'mt laurel') ? 'Mount Laurel' : city;
            if (!njCities.includes(normCity)) njCities.push(normCity);
        }
    }
    if (!njCities.length && hasExplicitNjState) {
        const m1 = s.match(/\b([A-Z][a-zA-Z.\s]{2,20}?),\s*(?:NJ|New\s+Jersey)\b/);
        if (m1) {
            const cand = m1[1].trim();
            if (!/^(remote|hybrid|usa|us|united states|new york|ny|nj|new jersey|onsite|in-office|office|home)$/i.test(cand)) {
                njCities.push(cand);
            }
        }
        if (!njCities.length) {
            const m2 = s.match(/\b(?:NJ|New\s+Jersey)\s*[\-–—:]\s*([A-Z][a-zA-Z.\s]{2,20}?)(?:\s*[|,;(/]|$)/);
            if (m2) {
                const cand = m2[1].trim();
                if (!/^(remote|hybrid|usa|us|united states|new jersey|nj)$/i.test(cand)) {
                    njCities.push(cand);
                }
            }
        }
    }
    if (njCities.length) {
        parts.push(`${njCities[0]}, NJ`);
    } else if (hasExplicitNjState) {
        parts.push('New Jersey');
    }

    // 3. Remote (or also Remote)
    const hasRemote = /\b(remote|work\s+from\s+home|wfh|anywhere|distributed|telecommute|virtual)\b/.test(low);
    if (hasRemote) {
        parts.push('Remote');
    }

    if (!parts.length) {
        if (/\b(united\s+states(\s+of\s+america)?|usa|u\.s\.a\.?|u\.s\.?|us|north\s+america)\b/.test(low)) {
            parts.push('Remote');
        } else {
            return s || 'N/A';
        }
    }

    return parts.join(' · ');
}

function formatSalaryCompact(salaryStr) {
    if (!salaryStr || salaryStr === 'N/A') return '—';
    return salaryStr.replace(/\$(\d{1,3}),\d{3}/g, '$$$1K').replace(/\$(\d{1,3}),\d{2}\d/g, '$$$1K');
}

function formatDateFriendly(dateStr) {
    if (!dateStr) return 'N/A';
    try {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            const date = new Date(parts[0], parts[1] - 1, parts[2]);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
    } catch(e) {}
    return dateStr;
}

window.toggleTrackJob = function(jobId) {
    const job = state.allJobs.find(j => j.id === jobId);
    if (!job) return;

    const isStarred = isJobStarred(job);

    // UNSTAR: hand off to the server, which removes the role from Under Consideration and
    // releases the star - UNLESS it's already been applied to, in which case it refuses and
    // the star stays (the application record lives in the pipeline and must not be orphaned).
    if (isStarred) {
        fetch(`/api/jobs/${jobId}/unstar`, { method: 'POST' })
            .then(res => res.json().then(body => ({ ok: res.ok, body })))
            .then(({ ok, body }) => {
                if (body && body.applied) {
                    showToast(body.error || "Can't unstar — you've already applied to this role.", 'error');
                    return;   // keep the star exactly as it was
                }
                if (ok && body && body.success) {
                    job.status = 'Lead';
                    job.pipeline_status = '';
                    showToast('Removed from Under Consideration.');
                    fetchConsideration();
                    fetchJobs();
                } else {
                    showToast((body && body.error) || 'Could not remove from Under Consideration.', 'error');
                }
            })
            .catch(() => showToast('Could not remove from Under Consideration.', 'error'));
        return;
    }

    // STAR: put the role into Under Consideration and queue a tailored résumé.
    const newStage = 'Consideration';
    const newStatus = 'Consideration';

    fetch(`/api/jobs/${jobId}/tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_status: newStage, notes: 'Toggle star update' })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            job.status = newStatus;
            job.pipeline_status = newStage;

            // Starring is the single entry point to the agentic pipeline: the role goes to
            // UNDER CONSIDERATION and is queued for a tailored résumé.
            //
            // It deliberately no longer writes straight into Application & Interview
            // Pipeline. Doing that counted a starred role as a submission before it was
            // ever sent - inflating Submissions/Active and starting the 14-day auto-close
            // clock on an application that did not exist. The pipeline row is now created
            // on "Mark submitted" and not before.
            fetch('/api/apply-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, source: 'starred' })
            })
            .then(r => r.json())
            .then(b => {
                // Already applied: the server refuses to queue it. Roll the star back
                // and skip the résumé request - there is nothing to prepare for a role
                // that already came back a decision. The résumé request lives inside
                // this callback precisely so it cannot fire past this guard.
                if (b.already_applied) {
                    showToast(b.error, 'error');
                    job.status = 'Lead';
                    job.pipeline_status = '';
                    fetch(`/api/jobs/${jobId}/tracking`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ app_status: 'Sourced', notes: 'Already applied — star reverted' })
                    }).finally(() => fetchJobs());
                    return;
                }
                if (b.success) {
                    showToast(b.already_queued
                        ? 'Already under consideration.'
                        : 'Added to Under Consideration — queued for a tailored résumé.', 'success');
                    fetchConsideration();
                }

                // Starring no longer also drops a row into the separate Tailor queue
                // (/api/resumes/request). That queue collected 232 requests and fulfilled
                // none; the Under Consideration row created above already covers the résumé
                // and the brief. The per-row Tailor button still works when you want one.
                fetchJobs();
            })
            .catch(() => {});
        }
    });
};

// Source badge rendering helper (NewPMJobs vs Individual Company Scrapers)
function renderSourceBadge(job) {
    const src = job.source || 'NewPMJobs';
    if (src === 'Company Scraper') {
        return `<span class="badge-source source-scraper" style="background: rgba(168, 85, 247, 0.14); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.32); padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.71rem; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;" title="Discovered directly via Individual Company Scraper"><i class="fa-solid fa-spider" style="font-size: 0.65rem;"></i> Company Scraper</span>`;
    }
    return `<span class="badge-source source-newpmjobs" style="background: rgba(59, 130, 246, 0.12); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.28); padding: 3px 8px; border-radius: 6px; font-weight: 600; font-size: 0.71rem; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;" title="Sourced from NewPMJobs.com aggregator"><i class="fa-solid fa-layer-group" style="font-size: 0.65rem;"></i> NewPMJobs</span>`;
}

// Recommendation badge rendering helper
function renderRecBadge(job) {
    const rec = job.fit_recommendation || (hasFitScore(job) ? 'Evaluated' : '');
    if (!rec) {
        return `<span style="color: var(--text-muted); font-size: 0.75rem;">—</span>`;
    }
    let bg = 'rgba(100, 116, 139, 0.15)', text = '#64748b', border = 'rgba(100, 116, 139, 0.3)';
    if (rec === 'Apply') {
        bg = 'rgba(16, 185, 129, 0.15)'; text = '#10b981'; border = 'rgba(16, 185, 129, 0.3)';
    } else if (rec === 'Stretch') {
        bg = 'rgba(245, 158, 11, 0.15)'; text = '#f59e0b'; border = 'rgba(245, 158, 11, 0.3)';
    } else if (rec === 'Skip') {
        bg = 'rgba(239, 68, 68, 0.15)'; text = '#ef4444'; border = 'rgba(239, 68, 68, 0.3)';
    }
    return `<span class="badge-rec" style="background: ${bg}; color: ${text}; border: 1px solid ${border}; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.72rem; text-transform: uppercase;">${rec}</span>`;
}

// Top banner AI scoring stats helper
// The two header stats had no setter anywhere in the app, so they read 0 / 0% permanently.
function updateSourcingHeaderStats() {
    const active = (state.allJobs || []).filter(j => j.status !== 'Archived');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
    set('stat-total', active.length.toLocaleString());
    set('stat-actioned', active.filter(isActionedJob).length.toLocaleString());
}

function updateScoringStatsBanner() {
    // Prefer the live fit-status figures cached by the 20s poll (updateFitProgress) so this
    // top banner always agrees with the middle "Fit scoring" banner. Only fall back to the
    // client-side state.allJobs snapshot before the first poll returns — that snapshot is
    // frozen between re-renders, which is what used to make the two banners disagree.
    const live = state.fitStatus;
    let total, scored, na, remaining;
    if (live && typeof live.total === 'number' && typeof live.scored === 'number') {
        total = live.total;
        scored = live.scored;
        na = typeof live.na === 'number' ? live.na : 0;
        // Remaining = truly-unscored only. N/A (assessed, no usable JD) is a finished verdict,
        // not pending work, so it must not inflate "Remaining".
        remaining = typeof live.unscored === 'number' ? live.unscored : Math.max(0, total - scored - na);
    } else {
        total = state.allJobs.filter(j => j.status !== 'Archived').length;
        scored = state.allJobs.filter(j => j.status !== 'Archived' && j.experience_fit >= 0).length;
        na = state.allJobs.filter(j => j.status !== 'Archived' && j.experience_fit === -2).length;
        remaining = Math.max(0, total - scored - na);
    }

    const scoredElem = document.getElementById('badge-scored-count');
    const remainingElem = document.getElementById('badge-remaining-count');
    const textElem = document.getElementById('scoring-stats-text');
    const newElem = document.getElementById('badge-new-count');

    if (scoredElem) scoredElem.innerText = `Scored: ${scored}`;
    if (remainingElem) {
        remainingElem.innerText = `Remaining: ${remaining}`;
        remainingElem.title = `${remaining} roles still to score`;
    }
    // N/A is its own clickable pill (filter to only N/A-verdict roles); hidden when none.
    const naElem = document.getElementById('badge-na-count');
    if (naElem) {
        naElem.style.display = na > 0 ? '' : 'none';
        naElem.innerText = `N/A: ${na}`;
        naElem.title = `${na} role${na === 1 ? '' : 's'} marked N/A (assessed, but no usable job description was available). Click to show only these; click again to clear. Hover a job's N/A badge for the reason.`;
        naElem.style.outline = state.showOnlyNA ? '2px solid currentColor' : 'none';
    }
    if (textElem) textElem.innerText = na > 0
        ? `AI Fit Evaluation Progress (${scored} / ${total} scored · ${na} N/A)`
        : `AI Fit Evaluation Progress (${scored} / ${total} scored)`;
    if (newElem) {
        // "New since last scan" also comes from the live poll when available (the server
        // computes it with the same de-dup rule); otherwise fall back to the local snapshot.
        const scanDate = ((state.profile && state.profile.last_scanned_at) || '').substring(0, 10);
        let n = 0;
        if (live && typeof live.new_since_last_scan === 'number') {
            n = live.new_since_last_scan;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(scanDate)) {
            n = state.allJobs.filter(j => j.status !== 'Archived' &&
                (j.first_seen_at || '').substring(0, 10) === scanDate).length;
        }
        newElem.innerText = `New: ${n}`;
        newElem.title = /^\d{4}-\d{2}-\d{2}$/.test(scanDate)
            ? `${n} genuinely new job${n === 1 ? '' : 's'} (de-duplicated) since the last scan on ${scanDate}`
            : 'Genuinely new jobs (de-duplicated) added by the most recent scan';
    }
}

// Clickable table header sorting helper
window.sortTableBy = function(sortKey) {
    if (state.selectedSort === sortKey) {
        if (sortKey.endsWith('_desc')) {
            sortKey = sortKey.replace('_desc', '_asc');
        } else if (sortKey.endsWith('_asc')) {
            sortKey = sortKey.replace('_asc', '_desc');
        }
    }
    state.selectedSort = sortKey;
    if (elements.sortFilter) {
        elements.sortFilter.value = sortKey;
    }
    renderSourcingTab();
};
// HTML entity escaping helper
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Get matched LinkedIn connections for a job's company
function getLinkedInConnectionsForJob(job) {
    if (!job || !job.company_name || !state.connections) return [];
    const normCo = job.company_name.toLowerCase().trim();
    return state.connections.filter(c => c.company && c.company.toLowerCase().trim().includes(normCo));
}

// LinkedIn Connections badge rendering helper for table rows
function renderLinkedInConnectionsBadge(job) {
    const conns = getLinkedInConnectionsForJob(job);
    if (!conns || conns.length === 0) {
        return `<span style="color: var(--text-muted); font-size: 0.78rem;">—</span>`;
    }
    const tooltipText = conns.map(c => `${c.first_name || ''} ${c.last_name || ''} (${c.position || 'Connection'})`).join(' • ');
    return `<span class="badge-conn" style="background: rgba(14, 116, 144, 0.15); color: #06b6d4; border: 1px solid rgba(6, 182, 212, 0.3); padding: 3px 10px; border-radius: 12px; font-weight: 700; font-size: 0.74rem; display: inline-flex; align-items: center; gap: 5px;" title="${escapeHtml(tooltipText)}"><i class="fa-brands fa-linkedin" style="color: #0a66c2; font-size: 0.85rem;"></i> ${conns.length} ${conns.length === 1 ? 'Contact' : 'Contacts'}</span>`;
}



/* ==================================================================================
 * STAR Behavioral Prep module (lives in the Prep Hub tab).
 * Backend: /api/stories* . Uses the app's state/fetch/401-guard conventions.
 * ================================================================================== */
const STAR_BANDS = { '2min': [260, 320], '60s': [130, 160], '30s': [65, 85] };  // mirrors server WORD_BANDS
const LP_LIST = ['Customer Obsession','Ownership','Invent and Simplify','Are Right, A Lot',
  'Learn and Be Curious','Hire and Develop the Best','Insist on the Highest Standards','Think Big',
  'Bias for Action','Frugality','Earn Trust','Dive Deep','Have Backbone; Disagree and Commit',
  'Deliver Results','Strive to be Earth\'s Best Employer','Success and Scale Bring Broad Responsibility'];

const star = {
  inited: false,
  stories: [],
  currentId: null,
  view: 'intake',       // intake | generate | critique | record | progress
  saveTimer: null,
  current: null,        // full story object
  attempts: [],
  recorder: null,
  recChunks: [],
  recStart: 0,
};

function wc(s) { return (s || '').trim() ? (s || '').trim().split(/\s+/).length : 0; }
function starToast(msg, type) { if (typeof showToast === 'function') showToast(msg, type || 'info'); }

function initPrepToggles() {
  const globalBtn = document.getElementById('btn-copy-global-prompt');
  if (globalBtn && !globalBtn.dataset.bound) {
    globalBtn.dataset.bound = 'true';
    on(globalBtn, 'click', () => {
      copyPromptText('Process all interview prep queues (STAR, Role Prep, Delivery Analysis, Interview Review)');
    });
  }

  // Rail items + Overview pillar cards both carry data-prep-nav.
  document.querySelectorAll('#view-prep [data-prep-nav]').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    on(btn, 'click', () => applyPrepMode(btn.getAttribute('data-prep-nav')));
  });
  // Practice sub-nav (Behavioral / Delivery).
  document.querySelectorAll('#practice-subnav [data-practice-sub]').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    on(btn, 'click', () => applyPracticeSub(btn.getAttribute('data-practice-sub')));
  });
}

function initStarModule() {
  if (star.inited) return;
  star.inited = true;
  initPrepToggles();
  const btnNew = document.getElementById('star-new-story');
  if (btnNew) on(btnNew, 'click', createStarStory);
}

function loadStarStories() {
  fetch('/api/stories').then(r => r.json()).then(list => {
    star.stories = Array.isArray(list) ? list : [];
    renderStarList();
    if (!star.currentId && star.stories.length) selectStory(star.stories[0].id);
    else if (star.currentId) renderStarWorkspace();
    else renderStarWorkspace();
  }).catch(() => {});
}

function createStarStory() {
  fetch('/api/stories', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Untitled story' }) })
    .then(r => r.json()).then(s => { star.stories.unshift(s); star.currentId = s.id; star.view = 'intake';
      renderStarList(); selectStory(s.id); }).catch(() => starToast('Could not create story', 'error'));
}

function selectStory(id) {
  star.currentId = id;
  fetch(`/api/stories/${id}`).then(r => r.json()).then(s => {
    star.current = s; renderStarList(); renderStarWorkspace();
  });
}

function deleteStarStory(id) {
  if (!confirm('Delete this story and its attempts?')) return;
  fetch(`/api/stories/${id}`, { method: 'DELETE' }).then(() => {
    star.stories = star.stories.filter(s => s.id !== id);
    if (star.currentId === id) { star.currentId = null; star.current = null; }
    loadStarStories();
  });
}

function renderStarList() {
  const el = document.getElementById('star-story-list');
  if (!el) return;
  if (!star.stories.length) {
    el.innerHTML = '<div class="star-empty">No stories yet. Click <b>New story</b> to start.</div>';
    return;
  }
  el.innerHTML = star.stories.map(s => {
    const active = s.id === star.currentId ? ' active' : '';
    const hl = escapeHtml(s.decision_headline || 'No decision headline yet');
    return `<button class="star-story-item${active}" onclick="selectStory('${s.id}')">
      <span class="star-story-title">${escapeHtml(s.title || 'Untitled')}</span>
      <span class="star-story-hl">${hl}</span>
      ${s.generated ? '<span class="star-chip">generated</span>' : ''}
    </button>`;
  }).join('');
}

/* ---- P6: read-all story gallery (scan every generated story at a glance) ---- */
window.toggleStarReadAll = function () {
  const layout = document.querySelector('#prep-mode-star .star-layout');
  const gallery = document.getElementById('star-readall');
  const btn = document.getElementById('star-readall-toggle');
  if (!layout || !gallery) return;
  const showing = gallery.style.display !== 'none';
  if (showing) {
    gallery.style.display = 'none'; layout.style.display = '';
    if (btn) btn.innerHTML = '<i class="fa-solid fa-book-open"></i> Read all';
  } else {
    layout.style.display = 'none'; gallery.style.display = '';
    const reps = document.getElementById('star-reps'); if (reps) reps.style.display = 'none';
    const repsBtn = document.getElementById('star-reps-toggle'); if (repsBtn) repsBtn.innerHTML = '<i class="fa-solid fa-dumbbell"></i> Reps';
    if (btn) btn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Edit stories';
    renderStarReadAll();
  }
};

function renderStarReadAll() {
  const el = document.getElementById('star-readall');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem; padding:16px;">Loading stories…</div>';
  fetch('/api/stories').then(r => r.json()).then(stories => {
    if (!stories || !stories.length) {
      el.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem; padding:16px;">No stories yet. Click <b>New story</b> to build one.</div>';
      return;
    }
    const lpName = (l) => escapeHtml(String(l || '').split('—')[0].split(' - ')[0].trim());
    const chip = (l, draft) => `<span style="font-size:0.68rem; font-weight:700; padding:2px 8px; border-radius:999px; background:${draft ? 'rgba(148,163,184,0.18)' : 'var(--primary-glow)'}; color:${draft ? 'var(--text-muted)' : 'var(--primary)'};">${draft ? 'not generated' : lpName(l)}</span>`;
    el.innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(290px, 1fr)); gap:14px;">` +
      stories.map(s => {
        const g = s.generated || {};
        const scripts = g.scripts || {};
        const has = !!(g && g.scripts);
        const lps = has ? [g.primary_lp || s.primary_lp].filter(Boolean).concat(g.secondary_lps || []) : [];
        const chips = has ? lps.map(l => chip(l)).join(' ') : chip(null, true);
        const qs = (g.best_fit_questions || []).slice(0, 3)
          .map(q => escapeHtml(typeof q === 'string' ? q : (q.question || ''))).filter(Boolean).join(' · ');
        return `
          <div style="border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:14px; background:rgba(255,255,255,0.02); display:flex; flex-direction:column; gap:6px;">
            <div style="font-weight:700; font-size:0.95rem; color:var(--text-primary);">${escapeHtml(s.title || 'Untitled')}</div>
            <div style="font-size:0.8rem; color:var(--text-secondary);">${escapeHtml(s.decision_headline || '')}</div>
            <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:2px;">${chips}</div>
            ${has ? `
              <div class="readall-lentabs" data-sid="${s.id}" style="display:flex; gap:5px; margin-top:6px;">
                <button type="button" data-len="two_min" class="on" style="font-size:0.72rem; font-weight:600; padding:3px 9px; border-radius:6px; border:1px solid var(--border-color); background:var(--primary-glow); color:var(--primary); cursor:pointer;">2 min</button>
                <button type="button" data-len="sixty_sec" style="font-size:0.72rem; font-weight:600; padding:3px 9px; border-radius:6px; border:1px solid var(--border-color); background:none; color:var(--text-muted); cursor:pointer;">60 sec</button>
                <button type="button" data-len="thirty_sec" style="font-size:0.72rem; font-weight:600; padding:3px 9px; border-radius:6px; border:1px solid var(--border-color); background:none; color:var(--text-muted); cursor:pointer;">30 sec</button>
              </div>
              <div id="readall-script-${s.id}" style="font-size:0.82rem; line-height:1.55; color:var(--text-secondary); border-left:2px solid var(--border-color); padding-left:10px; margin-top:4px; max-height:200px; overflow:auto;">${escapeHtml(scripts.two_min || '')}</div>
              ${qs ? `<div style="font-size:0.73rem; color:var(--text-muted); margin-top:6px; padding-top:6px; border-top:1px solid var(--border-color);"><b>Use for:</b> ${qs}</div>` : ''}
            ` : `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">Open in the editor and Generate to see the 2m / 60s / 30s versions.</div>`}
          </div>`;
      }).join('') + `</div>`;

    // length toggles per card
    el.querySelectorAll('.readall-lentabs').forEach(tabs => {
      tabs.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        tabs.querySelectorAll('button').forEach(x => {
          const on = x === b;
          x.classList.toggle('on', on);
          x.style.background = on ? 'var(--primary-glow)' : 'none';
          x.style.color = on ? 'var(--primary)' : 'var(--text-muted)';
        });
        const sid = tabs.getAttribute('data-sid');
        const st = stories.find(x => String(x.id) === String(sid));
        const scripts = (st && st.generated && st.generated.scripts) || {};
        const target = document.getElementById('readall-script-' + sid);
        if (target) target.textContent = scripts[b.getAttribute('data-len')] || '(no text for this length)';
      });
    });
  }).catch(() => {
    el.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem; padding:16px;">Could not load stories.</div>';
  });
}

/* ---- P6/2d: Behavioral "Reps" LP-coverage board ---- */
const AMAZON_LPS = ['Customer Obsession', 'Ownership', 'Invent and Simplify', 'Are Right, A Lot',
    'Learn and Be Curious', 'Hire and Develop the Best', 'Insist on the Highest Standards', 'Think Big',
    'Bias for Action', 'Frugality', 'Earn Trust', 'Dive Deep', 'Have Backbone; Disagree and Commit', 'Deliver Results'];

window.toggleStarReps = function () {
    const layout = document.querySelector('#prep-mode-star .star-layout');
    const readall = document.getElementById('star-readall');
    const reps = document.getElementById('star-reps');
    const btn = document.getElementById('star-reps-toggle');
    if (!layout || !reps) return;
    const showing = reps.style.display !== 'none';
    if (showing) {
        reps.style.display = 'none'; layout.style.display = '';
        if (btn) btn.innerHTML = '<i class="fa-solid fa-dumbbell"></i> Reps';
    } else {
        layout.style.display = 'none';
        if (readall) readall.style.display = 'none';
        const raBtn = document.getElementById('star-readall-toggle');
        if (raBtn) raBtn.innerHTML = '<i class="fa-solid fa-book-open"></i> Read all';
        reps.style.display = '';
        if (btn) btn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Edit stories';
        renderStarReps();
    }
};

function renderStarReps() {
    const el = document.getElementById('star-reps');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem; padding:16px;">Loading LP coverage…</div>';
    fetch('/api/stories').then(r => r.json()).then(stories => {
        stories = stories || [];
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
        const cover = {};
        stories.forEach(s => {
            const g = s.generated || {};
            const lps = [s.primary_lp, (s.mapping && s.mapping.primary_lp), g.primary_lp].concat(g.secondary_lps || []).filter(Boolean);
            lps.forEach(lp => {
                const key = norm(String(lp).split('—')[0].split(' - ')[0]);
                (cover[key] = cover[key] || []).push(s.title || 'Untitled');
            });
        });
        const covered = AMAZON_LPS.filter(lp => cover[norm(lp)]).length;
        const rows = AMAZON_LPS.map(lp => {
            const st = cover[norm(lp)];
            const ready = st && st.length;
            return `
              <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid var(--border-color);">
                <div style="min-width:0;"><b style="color:var(--text-primary);">${escapeHtml(lp)}</b>
                  <small style="display:block; color:var(--text-muted); font-size:0.76rem;">${ready ? 'Uses: ' + escapeHtml(st[0]) : 'No mapped story yet'}</small></div>
                <div style="display:flex; align-items:center; gap:8px; white-space:nowrap;">
                  ${ready ? '<span class="pill g" style="font-size:0.66rem;">Story ready</span>' : '<span class="pill r" style="font-size:0.66rem;">Gap</span>'}
                  ${ready
                    ? `<button type="button" class="btn btn-primary btn-sm" onclick="startPracticeMock('Behavioral (${escapeAttr(lp)}): tell me about a time you demonstrated ${escapeAttr(lp)}. Use your ${escapeAttr(st[0])} story.','behavioral')">Live mock</button>`
                    : `<button type="button" class="btn btn-secondary btn-sm" onclick="toggleStarReps(); var b=document.getElementById('star-new-story'); if(b) b.click();">Build story</button>`}
                </div>
              </div>`;
        }).join('');
        el.innerHTML = `
          <div class="delivery-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:10px;">
              <div style="font-weight:700; font-size:0.95rem; color:var(--text-primary);">LP coverage</div>
              <span class="pill">${covered} of ${AMAZON_LPS.length} LPs covered</span>
            </div>
            <p style="color:var(--text-secondary); font-size:0.82rem; margin:0 0 10px;">Each Leadership Principle: whether a story maps to it, and a rep to drill. Gaps show where to build a story.</p>
            ${rows}
          </div>`;
    }).catch(() => { el.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem; padding:16px;">Could not load stories.</div>'; });
}

/* ---- autosave: debounced PUT of one section ---- */
function starPatch(patch) {
  if (!star.currentId) return;
  Object.assign(star.current, patch);
  clearTimeout(star.saveTimer);
  star.saveTimer = setTimeout(() => {
    fetch(`/api/stories/${star.currentId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch) }).then(r => r.json()).then(s => {
        const i = star.stories.findIndex(x => x.id === s.id);
        if (i >= 0) star.stories[i] = s;
        renderStarList();
        const dot = document.getElementById('star-saved-dot'); if (dot) { dot.textContent = 'saved'; setTimeout(() => dot.textContent = '', 1500); }
      });
  }, 700);
}

function renderStarWorkspace() {
  const el = document.getElementById('star-workspace');
  if (!el) return;
  if (!star.current) { el.innerHTML = '<div class="star-empty">Select a story on the left, or create a new one.</div>'; return; }
  const tabs = [['intake','Intake'],['generate','Generate'],['critique','My drafts'],['record','Record & score'],['progress','Progress']];
  el.innerHTML = `
    <div class="star-subnav">
      ${tabs.map(([k,l]) => `<button class="star-subtab${star.view===k?' active':''}" data-star-view="${k}">${l}</button>`).join('')}
      <span id="star-saved-dot" class="star-saved-dot"></span>
      <button class="star-del" title="Delete story" onclick="deleteStarStory('${star.currentId}')"><i class="fa-solid fa-trash"></i></button>
    </div>
    <div id="star-view-body"></div>`;
  el.querySelectorAll('[data-star-view]').forEach(b => on(b, 'click', () => { star.view = b.getAttribute('data-star-view'); renderStarWorkspace(); }));
  const body = document.getElementById('star-view-body');
  if (star.view === 'intake') renderStarIntake(body);
  else if (star.view === 'generate') renderStarGenerate(body);
  else if (star.view === 'critique') renderStarCritique(body);
  else if (star.view === 'record') renderStarRecord(body);
  else if (star.view === 'progress') renderStarProgress(body);
}

/* ---------------- Intake form (Sections A-G) ---------------- */
function renderStarIntake(body) {
  const s = star.current;
  const f = s.framing || {}, st = s.situation || {}, ac = s.action || {}, te = s.tension || {},
        re = s.result || {}, de = s.depth || {}, mp = s.mapping || {}, sd = s.self_drafts || {};
  const inter = te.interpersonal || {}, dec = te.decision || {};
  const dhWords = wc(f.decision_headline);
  const sitWords = wc(st.situation);
  body.innerHTML = `
  <div class="star-form">
    <div class="star-section"><div class="star-sec-h">A · Framing</div>
      <label class="star-l">Title</label>
      <input class="star-in" id="f_title" value="${escapeAttr(s.title||'')}" placeholder="Deprecated 86 developer endpoints">
      <label class="star-l">Decision headline <span class="star-hint">lead with the verb — what did you decide/drive? (≤15 words)</span></label>
      <input class="star-in" id="f_dh" value="${escapeAttr(f.decision_headline||'')}" placeholder="In ONE sentence: what did you decide or drive?">
      <div class="star-counter ${dhWords>15?'bad':''}" id="c_dh">${dhWords}/15 words${dhWords>15?' — too long, cut it':''}</div>
      <div class="star-row2">
        <div><label class="star-l">Your role</label><input class="star-in" id="f_role" value="${escapeAttr(f.your_role||'')}" placeholder="Pillar lead, Developer Governance (IC)"></div>
        <div><label class="star-l">Scope</label><input class="star-in" id="f_scope" value="${escapeAttr(f.scope||'')}" placeholder="37-eng org, ~1M developers"></div>
      </div>
      <div class="star-row2">
        <div><label class="star-l">Company context</label><input class="star-in" id="f_ctx" value="${escapeAttr(f.company_context||'')}" placeholder="Meta cross-platform developer surface"></div>
        <div><label class="star-l">Timeframe</label><input class="star-in" id="f_tf" value="${escapeAttr(f.timeframe||'')}" placeholder="Q3 2024, ~5 months"></div>
      </div>
    </div>

    <div class="star-section"><div class="star-sec-h">B · Situation & Task <span class="star-hint">capped on purpose</span></div>
      <label class="star-l">Situation <span class="star-hint">2–3 sentences MAX; ~40 words</span></label>
      <textarea class="star-ta" id="s_sit" rows="2" placeholder="Just enough tension for the stakes to land.">${escapeHtml(st.situation||'')}</textarea>
      <div class="star-counter ${sitWords>40?'warn':''}" id="c_sit">${sitWords} words${sitWords>40?' — over ~40, tighten':''}</div>
      <label class="star-l">Stakes</label>
      <input class="star-in" id="s_stakes" value="${escapeAttr(st.stakes||'')}" placeholder="Why did this matter? What broke if nobody acted?">
      <label class="star-l">Task <span class="star-hint">what was YOURS to solve, not the team's</span></label>
      <textarea class="star-ta" id="s_task" rows="2">${escapeHtml(st.task||'')}</textarea>
    </div>

    <div class="star-section"><div class="star-sec-h">C · Action <span class="star-hint">the judgment core</span></div>
      <label class="star-l">Key decision <span class="star-hint">state it as a decision, not an activity</span></label>
      <textarea class="star-ta" id="a_dec" rows="2">${escapeHtml(ac.key_decision||'')}</textarea>
      <label class="star-l">Actions <span class="star-hint">verb-led, one idea per row, 3–6 rows. Star the two that carried the outcome.</span></label>
      <div id="a_rows"></div>
      <button class="btn btn-secondary btn-sm" id="a_add" style="margin-top:8px;"><i class="fa-solid fa-plus"></i> Add action</button>
      <label class="star-l" style="margin-top:14px;">How you influenced (no authority)</label>
      <textarea class="star-ta" id="a_infl" rows="2">${escapeHtml(ac.how_you_influenced||'')}</textarea>
    </div>

    <div class="star-section"><div class="star-sec-h">C2 · Tension — interpersonal <span class="star-hint">feeds Have Backbone / Earn Trust</span></div>
      <div class="star-row2">
        <div><label class="star-l">Who pushed</label><input class="star-in" id="ti_who" value="${escapeAttr(inter.who_pushed||'')}" placeholder="Role + stake"></div>
        <div><label class="star-l">Their position (steel-man)</label><input class="star-in" id="ti_pos" value="${escapeAttr(inter.their_position||'')}"></div>
      </div>
      <label class="star-l">How you navigated</label>
      <textarea class="star-ta" id="ti_nav" rows="2">${escapeHtml(inter.how_you_navigated||'')}</textarea>
      <label class="star-l">Resolution</label>
      <input class="star-in" id="ti_res" value="${escapeAttr(inter.resolution||'')}" placeholder="Where did it land with them afterward?">
    </div>

    <div class="star-section"><div class="star-sec-h">C2 · Tension — decision <span class="star-hint">feeds Are Right, A Lot / the tradeoff line</span></div>
      <label class="star-l">Options considered</label>
      <input class="star-in" id="td_opt" value="${escapeAttr(dec.options_considered||'')}" placeholder="2–3 real options, each with a genuine upside">
      <label class="star-l">What made it hard</label>
      <input class="star-in" id="td_hard" value="${escapeAttr(dec.what_made_it_hard||'')}">
      <label class="star-l">Decision criteria <span class="star-hint">"I optimized for X over Y because…"</span></label>
      <textarea class="star-ta" id="td_crit" rows="2">${escapeHtml(dec.decision_criteria||'')}</textarea>
      <label class="star-l">What you gave up</label>
      <input class="star-in" id="td_gave" value="${escapeAttr(dec.what_you_gave_up||'')}">
    </div>

    <div class="star-section"><div class="star-sec-h">D · Result <span class="star-hint">clean landing, caveats quarantined</span></div>
      <label class="star-l">Result headline <span class="star-hint">one line, with a number — where you STOP talking</span></label>
      <input class="star-in" id="r_head" value="${escapeAttr(re.result_headline||'')}">
      <label class="star-l">Primary metric</label>
      <input class="star-in" id="r_metric" value="${escapeAttr(re.primary_metric||'')}" placeholder="86 endpoints · 75% · $5M capacity">
      <label class="star-l">Caveats <span class="star-hint">kept OUT of the spoken landing; deep-dive only</span></label>
      <textarea class="star-ta" id="r_cav" rows="2">${escapeHtml(re.caveats||'')}</textarea>
      <label class="star-l">Secondary effects</label>
      <input class="star-in" id="r_sec" value="${escapeAttr(re.secondary_effects||'')}">
    </div>

    <div class="star-section"><div class="star-sec-h">E · Depth <span class="star-hint">for follow-ups</span></div>
      <label class="star-l">Most obvious objection + one-line answer</label>
      <textarea class="star-ta" id="d_moo" rows="2">${escapeHtml(de.most_obvious_objection||'')}</textarea>
      <label class="star-l">What you'd do differently (as a lesson now applied)</label>
      <textarea class="star-ta" id="d_diff" rows="2">${escapeHtml(de.what_youd_do_differently||'')}</textarea>
      <label class="star-l">Learning (the reflective button)</label>
      <input class="star-in" id="d_learn" value="${escapeAttr(de.learning||'')}">
    </div>

    <div class="star-section"><div class="star-sec-h">F · Mapping</div>
      <div class="star-row2">
        <div><label class="star-l">Target company</label>
          <select class="star-in" id="m_co">${['Amazon','Meta','Google','Other'].map(c=>`<option ${((mp.target_company||s.target_company)===c)?'selected':''}>${c}</option>`).join('')}</select></div>
        <div><label class="star-l">Primary LP (or let Generate suggest)</label>
          <select class="star-in" id="m_lp"><option value="">— auto —</option>${LP_LIST.map(l=>`<option ${mp.primary_lp===l?'selected':''}>${l}</option>`).join('')}</select></div>
      </div>
    </div>

    <div class="star-section"><div class="star-sec-h">G · Your own drafts <span class="star-hint">write it yourself; critique in the "My drafts" tab</span></div>
      ${['2min','60s','30s'].map(len=>{const key={'2min':'two_min','60s':'sixty_sec','30s':'thirty_sec'}[len];const v=sd[key]||'';const n=wc(v);const [lo,hi]=STAR_BANDS[len];return `
        <label class="star-l">${len} draft <span class="star-hint">target ${lo}–${hi} words</span></label>
        <textarea class="star-ta" id="g_${len}" data-band="${len}" rows="3">${escapeHtml(v)}</textarea>
        <div class="star-counter ${n&&(n<lo||n>hi)?'warn':''}" id="gc_${len}">${n} words (target ${lo}–${hi})</div>`;}).join('')}
    </div>
  </div>`;

  wireStarIntake();
  renderActionRows();
}

function wireStarIntake() {
  const on_ = (id, ev, fn) => { const e = document.getElementById(id); if (e) e.addEventListener(ev, fn); };
  // Section A
  on_('f_title','input',e=>starPatch({title:e.target.value}));
  on_('f_dh','input',e=>{ const n=wc(e.target.value); const c=document.getElementById('c_dh');
    c.textContent=`${n}/15 words`+(n>15?' — too long, cut it':''); c.className='star-counter'+(n>15?' bad':'');
    starPatch({framing:{...(star.current.framing||{}),decision_headline:e.target.value}}); });
  on_('f_role','input',e=>starPatch({framing:{...(star.current.framing||{}),your_role:e.target.value}}));
  on_('f_scope','input',e=>starPatch({framing:{...(star.current.framing||{}),scope:e.target.value}}));
  on_('f_ctx','input',e=>starPatch({framing:{...(star.current.framing||{}),company_context:e.target.value}}));
  on_('f_tf','input',e=>starPatch({framing:{...(star.current.framing||{}),timeframe:e.target.value}}));
  // B
  on_('s_sit','input',e=>{ const n=wc(e.target.value); const c=document.getElementById('c_sit');
    c.textContent=`${n} words`+(n>40?' — over ~40, tighten':''); c.className='star-counter'+(n>40?' warn':'');
    starPatch({situation:{...(star.current.situation||{}),situation:e.target.value}}); });
  on_('s_stakes','input',e=>starPatch({situation:{...(star.current.situation||{}),stakes:e.target.value}}));
  on_('s_task','input',e=>starPatch({situation:{...(star.current.situation||{}),task:e.target.value}}));
  // C
  on_('a_dec','input',e=>starPatch({action:{...(star.current.action||{}),key_decision:e.target.value}}));
  on_('a_infl','input',e=>starPatch({action:{...(star.current.action||{}),how_you_influenced:e.target.value}}));
  on_('a_add','click',()=>{ const a=star.current.action||{}; const rows=(a.key_actions||[]).slice();
    if(rows.length>=6){ starToast('6 actions max — force yourself to select','info'); return; }
    rows.push({action:'',why:'',owned_solo:false,starred:false}); starPatch({action:{...a,key_actions:rows}}); renderActionRows(); });
  // C2 interpersonal
  const ti=(k,id)=>on_(id,'input',e=>starPatch({tension:{...(star.current.tension||{}),interpersonal:{...((star.current.tension||{}).interpersonal||{}),[k]:e.target.value}}}));
  ti('who_pushed','ti_who'); ti('their_position','ti_pos'); ti('how_you_navigated','ti_nav'); ti('resolution','ti_res');
  const td=(k,id)=>on_(id,'input',e=>starPatch({tension:{...(star.current.tension||{}),decision:{...((star.current.tension||{}).decision||{}),[k]:e.target.value}}}));
  td('options_considered','td_opt'); td('what_made_it_hard','td_hard'); td('decision_criteria','td_crit'); td('what_you_gave_up','td_gave');
  // D
  const rd=(k,id)=>on_(id,'input',e=>starPatch({result:{...(star.current.result||{}),[k]:e.target.value}}));
  rd('result_headline','r_head'); rd('primary_metric','r_metric'); rd('caveats','r_cav'); rd('secondary_effects','r_sec');
  // E
  const dd=(k,id)=>on_(id,'input',e=>starPatch({depth:{...(star.current.depth||{}),[k]:e.target.value}}));
  dd('most_obvious_objection','d_moo'); dd('what_youd_do_differently','d_diff'); dd('learning','d_learn');
  // F
  on_('m_co','change',e=>starPatch({target_company:e.target.value,mapping:{...(star.current.mapping||{}),target_company:e.target.value}}));
  on_('m_lp','change',e=>starPatch({primary_lp:e.target.value,mapping:{...(star.current.mapping||{}),primary_lp:e.target.value}}));
  // G self-drafts
  ['2min','60s','30s'].forEach(len=>{ const key={'2min':'two_min','60s':'sixty_sec','30s':'thirty_sec'}[len];
    on_('g_'+len,'input',e=>{ const n=wc(e.target.value); const [lo,hi]=STAR_BANDS[len]; const c=document.getElementById('gc_'+len);
      c.textContent=`${n} words (target ${lo}–${hi})`; c.className='star-counter'+(n&&(n<lo||n>hi)?' warn':'');
      starPatch({self_drafts:{...(star.current.self_drafts||{}),[key]:e.target.value}}); }); });
}

const VERB_HINT = /^(built|led|drove|cut|shipped|rebuilt|unified|deprecated|architected|launched|created|designed|negotiated|convinced|scaled|reduced|removed|owned|ran|set|delivered|migrated|consolidated|prioritized|escalated|reframed|audited|automated|defined|established|spearheaded|championed|formulated|overhauled|productized|standardized|instrumented|onboarded)/i;

function renderActionRows() {
  const wrap = document.getElementById('a_rows'); if (!wrap) return;
  const rows = ((star.current.action||{}).key_actions)||[];
  wrap.innerHTML = rows.map((r,i)=>{
    const hasAnd = /\band\b/i.test(r.action||'');
    const notVerb = (r.action||'').trim() && !VERB_HINT.test((r.action||'').trim());
    return `<div class="star-action-row${r.starred?' starred':''}">
      <button class="star-star ${r.starred?'on':''}" title="Star if this carried the outcome (max 2)" data-star-idx="${i}"><i class="fa-solid fa-star"></i></button>
      <div class="star-action-main">
        <input class="star-in star-action-in" data-act-idx="${i}" value="${escapeAttr(r.action||'')}" placeholder="Verb-led: 'Rebuilt the review pipeline as an async queue.'">
        <input class="star-in star-why" data-why-idx="${i}" value="${escapeAttr(r.why||'')}" placeholder="why this, not the obvious move (optional)">
        ${hasAnd?'<div class="star-nudge">Contains "and" — split into two rows?</div>':''}
        ${notVerb?'<div class="star-nudge">Start with a verb (Rebuilt, Cut, Negotiated…)</div>':''}
      </div>
      <label class="star-solo"><input type="checkbox" data-solo-idx="${i}" ${r.owned_solo?'checked':''}> solo</label>
      <button class="star-del-row" data-del-idx="${i}"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }).join('') + (rows.length<3?'<div class="star-nudge" style="margin-top:6px;">Add at least 3 actions — decompose the work.</div>':'');
  const commit=(fn)=>{ const a=star.current.action||{}; const arr=(a.key_actions||[]).slice(); fn(arr); starPatch({action:{...a,key_actions:arr}}); };
  wrap.querySelectorAll('[data-act-idx]').forEach(el=>el.addEventListener('input',e=>{const i=+el.getAttribute('data-act-idx'); const a=star.current.action||{}; const arr=(a.key_actions||[]).slice(); arr[i]={...arr[i],action:e.target.value}; star.current.action={...a,key_actions:arr};
    clearTimeout(star.saveTimer); star.saveTimer=setTimeout(()=>fetch(`/api/stories/${star.currentId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:star.current.action})}),700);
    // live nudges without full re-render steal focus: only re-render on blur
  }));
  wrap.querySelectorAll('[data-act-idx]').forEach(el=>el.addEventListener('blur',()=>renderActionRows()));
  wrap.querySelectorAll('[data-why-idx]').forEach(el=>el.addEventListener('input',e=>{const i=+el.getAttribute('data-why-idx'); commit(arr=>arr[i]={...arr[i],why:e.target.value});}));
  wrap.querySelectorAll('[data-solo-idx]').forEach(el=>el.addEventListener('change',e=>{const i=+el.getAttribute('data-solo-idx'); commit(arr=>arr[i]={...arr[i],owned_solo:e.target.checked}); renderActionRows();}));
  wrap.querySelectorAll('[data-del-idx]').forEach(el=>el.addEventListener('click',()=>{const i=+el.getAttribute('data-del-idx'); commit(arr=>arr.splice(i,1)); renderActionRows();}));
  wrap.querySelectorAll('[data-star-idx]').forEach(el=>el.addEventListener('click',()=>{const i=+el.getAttribute('data-star-idx');
    const arr=((star.current.action||{}).key_actions||[]).slice(); const starred=arr.filter(r=>r.starred).length;
    if(!arr[i].starred && starred>=2){ starToast('Star only the two that carried the outcome','info'); return; }
    commit(a=>a[i]={...a[i],starred:!a[i].starred}); renderActionRows(); }));
}

/* ---------------- Generate view ---------------- */
function renderStarGenerate(body) {
  const gen = star.current.generated;
  body.innerHTML = `
    <div class="star-gen-head">
      <button class="btn btn-primary" id="star-gen-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> ${gen?'Regenerate':'Generate scripts'}</button>
      <span class="star-hint">Runs GPT-OSS-120B on your intake. Each script opens on the decision, ends on the metric.</span>
    </div>
    <div id="star-gen-out">${gen?renderGenerated(gen):'<div class="star-empty">No scripts yet. Fill the intake, then Generate.</div>'}</div>`;
  on(document.getElementById('star-gen-btn'),'click',()=>{
    const b=document.getElementById('star-gen-btn'); b.disabled=true; b.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Generating…';
    fetch(`/api/stories/${star.currentId}/generate`,{method:'POST'}).then(r=>r.json().then(j=>({ok:r.ok,j})))
      .then(({ok,j})=>{ if(ok&&j.success){ star.current.generated=j.generated; renderStarWorkspace(); }
        else { starToast(j.error||'Generation failed','error'); b.disabled=false; b.innerHTML='<i class="fa-solid fa-wand-magic-sparkles"></i> Generate scripts'; } })
      .catch(()=>{ starToast('Generation failed','error'); b.disabled=false; });
  });
}

function renderGenerated(g) {
  const script = (label, key, len) => {
    const txt = (g.scripts||{})[key]||''; const n = wc(txt); const [lo,hi]=STAR_BANDS[len];
    const cls = n&&(n<lo||n>hi)?'warn':'ok';
    return `<div class="star-card">
      <div class="star-card-h">${label} <span class="star-counter ${cls}">${n} words (${lo}–${hi})</span></div>
      <p class="star-script">${escapeHtml(txt)}</p></div>`;
  };
  const q = (g.best_fit_questions||[]).map(x=>`<li>${escapeHtml(x.question||'')} <span class="star-lp">${escapeHtml(x.lp||'')}</span></li>`).join('');
  const fu = (g.follow_ups||[]).map(x=>`<li class="${x.trap?'trap':''}">${x.trap?'⚠ ':''}${escapeHtml(x.question||'')} <span class="star-lp">${escapeHtml(x.lp||'')}</span><br><span class="star-angle">angle: ${escapeHtml(x.angle||'')}</span></li>`).join('');
  return `
    <div class="star-lpmap">
      <b>Primary LP:</b> ${escapeHtml(g.primary_lp||'')}<br>
      <b>Secondary:</b> ${(g.secondary_lps||[]).map(escapeHtml).join(', ')||'—'}<br>
      <b>Avoid using for:</b> ${escapeHtml(g.anti_lp||'—')}
    </div>
    ${script('2-minute','two_min','2min')}
    ${script('60-second','sixty_sec','60s')}
    ${script('30-second','thirty_sec','30s')}
    <div class="star-card"><div class="star-card-h">Best-fit questions</div><ul class="star-ul">${q}</ul>
      <div class="star-volunteer"><b>Volunteer first for:</b> ${escapeHtml(g.volunteer_first||'')}</div></div>
    <div class="star-card"><div class="star-card-h">Anticipated follow-ups <span class="star-hint">rehearse the ⚠ first</span></div><ul class="star-ul star-fu">${fu}</ul></div>
    <div class="star-card"><div class="star-card-h">Deep-dive kit</div>
      <div><b>Objection:</b> ${escapeHtml((g.deep_dive||{}).objection||'')}</div>
      <div><b>Rebuttal:</b> ${escapeHtml((g.deep_dive||{}).rebuttal||'')}</div></div>
    ${(g.coach_flags||[]).length?`<div class="star-card star-flags"><div class="star-card-h">Coach flags</div><ul class="star-ul">${g.coach_flags.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`:''}`;
}

/* ---------------- Critique (self-drafts) ---------------- */
function renderStarCritique(body) {
  const sd = star.current.self_drafts||{};
  body.innerHTML = ['2min','60s','30s'].map(len=>{
    const key={'2min':'two_min','60s':'sixty_sec','30s':'thirty_sec'}[len]; const v=sd[key]||''; const n=wc(v); const [lo,hi]=STAR_BANDS[len];
    return `<div class="star-card">
      <div class="star-card-h">${len} draft <span class="star-counter ${n&&(n<lo||n>hi)?'warn':'ok'}">${n} words (${lo}–${hi})</span></div>
      <textarea class="star-ta" id="cr_${len}" rows="4" placeholder="Write your ${len} version, or edit the one from Intake…">${escapeHtml(v)}</textarea>
      <div class="star-gen-head" style="margin-top:8px;">
        <button class="btn btn-secondary btn-sm" data-crit="${len}"><i class="fa-solid fa-gavel"></i> Critique my draft</button>
        <button class="btn btn-secondary btn-sm" data-crit-tight="${len}"><i class="fa-solid fa-compress"></i> Show a tighter version</button>
      </div>
      <div id="cr_out_${len}"></div></div>`;
  }).join('');
  ['2min','60s','30s'].forEach(len=>{ const key={'2min':'two_min','60s':'sixty_sec','30s':'thirty_sec'}[len];
    const ta=document.getElementById('cr_'+len);
    if(ta) ta.addEventListener('input',()=>starPatch({self_drafts:{...(star.current.self_drafts||{}),[key]:ta.value}}));
  });
  body.querySelectorAll('[data-crit]').forEach(b=>b.addEventListener('click',()=>runCritique(b.getAttribute('data-crit'),false,b)));
  body.querySelectorAll('[data-crit-tight]').forEach(b=>b.addEventListener('click',()=>runCritique(b.getAttribute('data-crit-tight'),true,b)));
}

function runCritique(len, tighter, btn) {
  const draft = (document.getElementById('cr_'+len)||{}).value||'';
  if (!draft.trim()) { starToast('Write a draft first', 'info'); return; }
  const out = document.getElementById('cr_out_'+len);
  btn.disabled=true; const old=btn.innerHTML; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i>';
  fetch(`/api/stories/${star.currentId}/critique`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({length:len,draft,tighter})}).then(r=>r.json().then(j=>({ok:r.ok,j})))
    .then(({ok,j})=>{ btn.disabled=false; btn.innerHTML=old;
      if(!ok||!j.success){ starToast(j.error||'Critique failed','error'); return; }
      const c=j.critique;
      out.innerHTML=`<div class="star-critique">
        <div class="star-score">Rubric: <b>${c.rubric_score??'?'}/100</b> ${(c.auto_deductions||[]).map(d=>`<span class="star-deduct">${d.code} ${d.penalty}</span>`).join('')}</div>
        <div class="star-fix"><b>The one fix:</b> ${escapeHtml(c.the_one_fix||'')}</div>
        <div class="star-worked"><b>What worked:</b> ${escapeHtml(c.what_worked||'')}</div>
        ${c.tighter_version?`<div class="star-card-h" style="margin-top:10px;">Tighter version</div><p class="star-script">${escapeHtml(c.tighter_version)}</p>`:''}
        ${(c.changed||[]).length?`<div class="star-card-h">Changed, and why</div><ul class="star-ul">${c.changed.map(x=>`<li>${escapeHtml(x.edit||'')} — <i>${escapeHtml(x.why||'')}</i></li>`).join('')}</ul>`:''}
      </div>`;
    }).catch(()=>{ btn.disabled=false; btn.innerHTML=old; starToast('Critique failed','error'); });
}

/* ---------------- Record & score ---------------- */
function renderStarRecord(body) {
  body.innerHTML = `
    <div class="star-hint" style="margin-bottom:12px;">Pick a length, record yourself narrating, and get a delivery scorecard. Supports live in-browser speech recognition and Gemini 3.5 Transcribe audio intelligence.</div>
    <div class="star-rec-lens">${['2min','60s','30s'].map(l=>`<button class="pill${l==='2min'?' active':''}" data-rec-len="${l}">${l}</button>`).join('')}</div>
    <div class="star-rec-controls">
      <button class="btn btn-primary" id="star-rec-btn"><i class="fa-solid fa-microphone"></i> Start recording</button>
      <span id="star-rec-timer" class="star-rec-timer"></span>
    </div>
    <div id="star-live-transcript" style="display:none; font-style:italic; margin-bottom:12px; color:var(--primary); font-size:0.85rem; padding:8px; background:rgba(99,102,241,0.06); border-radius:var(--radius-sm);"></div>
    <div class="star-card" style="margin-top:16px;">
      <div class="star-card-h">Or evaluate a written / pasted narration transcript</div>
      <textarea class="star-ta" id="star-manual-transcript" rows="3" placeholder="Paste or type a spoken narration transcript here to score directly without recording…"></textarea>
      <div style="margin-top:8px;">
        <button class="btn btn-secondary btn-sm" id="star-score-manual-btn"><i class="fa-solid fa-calculator"></i> Score this transcript</button>
      </div>
    </div>
    <div id="star-rec-out"></div>`;
  star.recLen = '2min';
  body.querySelectorAll('[data-rec-len]').forEach(b=>b.addEventListener('click',()=>{
    body.querySelectorAll('[data-rec-len]').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    star.recLen=b.getAttribute('data-rec-len');
  }));
  on(document.getElementById('star-rec-btn'),'click',toggleRecording);
  on(document.getElementById('star-score-manual-btn'),'click',()=>{
    const txt = (document.getElementById('star-manual-transcript')||{}).value || '';
    if (!txt.trim()) { starToast('Enter a transcript to score', 'info'); return; }
    const wc_ = len => len === '2min' ? 120 : len === '60s' ? 60 : 30;
    const simulatedDur = Math.max(10, (txt.trim().split(/\s+/).length / 140) * 60);
    scoreTranscriptDirect(txt.trim(), star.recLen, simulatedDur, 'manual');
  });
}

function scoreTranscriptDirect(transcript, length, duration, source) {
  const out = document.getElementById('star-rec-out');
  if (out) out.innerHTML = `<div class="star-card"><div class="star-card-h">Transcript</div><p class="star-script">${escapeHtml(transcript)}</p><div class="star-hint"><i class="fa-solid fa-spinner fa-spin"></i> Queueing attempt for AI scoring…</div></div>`;
  fetch(`/api/stories/${star.currentId}/attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, length, duration_seconds: duration, source: source || 'recording' })
  }).then(r => r.json().then(a => ({ ok: r.ok, a })))
    .then(({ ok, a }) => {
      if (!ok || !a.success) { starToast(a.error || 'Queueing failed', 'error'); return; }
      updatePrepQueueStatusBadge();
      if (out) out.innerHTML = renderScorecard(a.attempt);
    }).catch(e => { starToast(e.message || 'Queueing failed', 'error'); });
}

function toggleRecording() {
  const btn = document.getElementById('star-rec-btn');
  const liveEl = document.getElementById('star-live-transcript');
  if (star.recorder && star.recorder.state === 'recording') {
    star.recorder.stop();
    if (star.speechRec) {
      try { star.speechRec.stop(); } catch(e){}
    }
    return;
  }
  
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    star.recChunks = [];
    star.liveText = '';
    star.recorder = new MediaRecorder(stream);
    star.recorder.ondataavailable = e => { if (e.data.size > 0) star.recChunks.push(e.data); };
    star.recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(star.recTimer);
      const blob = new Blob(star.recChunks, { type: star.recorder.mimeType || 'audio/webm' });
      const dur = (Date.now() - star.recStart) / 1000;
      submitRecording(blob, dur, star.liveText);
    };
    star.recStart = Date.now();
    star.recorder.start();
    btn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
    btn.classList.add('recording');
    
    // Live Web Speech Recognition if supported
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRec) {
      try {
        const sr = new SpeechRec();
        sr.continuous = true;
        sr.interimResults = true;
        sr.lang = 'en-US';
        sr.onresult = (evt) => {
          let str = '';
          for (let i = 0; i < evt.results.length; ++i) {
            str += evt.results[i][0].transcript + ' ';
          }
          star.liveText = str.trim();
          if (liveEl) {
            liveEl.style.display = 'block';
            liveEl.textContent = 'Listening: ' + star.liveText;
          }
        };
        sr.start();
        star.speechRec = sr;
      } catch(err){}
    }

    star.recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - star.recStart) / 1000);
      const t = document.getElementById('star-rec-timer');
      if (t) t.textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
    }, 250);
  }).catch(() => starToast('Microphone access denied', 'error'));
}

function submitRecording(blob, duration, liveTranscript) {
  const btn = document.getElementById('star-rec-btn');
  btn.classList.remove('recording');
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing…';
  btn.disabled = true;
  const out = document.getElementById('star-rec-out');
  const liveEl = document.getElementById('star-live-transcript');
  if (liveEl) liveEl.style.display = 'none';

  if (liveTranscript && liveTranscript.trim().length > 10) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Start recording';
    scoreTranscriptDirect(liveTranscript.trim(), star.recLen, duration, 'speech_api');
    return;
  }

  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  fetch(`/api/stories/${star.currentId}/transcribe`, { method: 'POST', body: fd })
    .then(r => r.json().then(j => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Start recording';
      if (!ok || !j.success) throw new Error(j.error || 'Transcription failed');
      const transcript = j.transcript;
      const dur = j.duration_seconds || duration;
      scoreTranscriptDirect(transcript, star.recLen, dur, 'whisper');
    }).catch(e => {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Start recording';
      starToast(e.message || 'Failed', 'error');
    });
}


function renderScorecard(at) {
  if (at.weighted_score === null || !at.scores || Object.keys(at.scores).length === 0) {
    return `<div class="star-card star-scorecard" style="border-left: 4px solid var(--primary);">
      <div class="star-card-h">Delivery Scoring <span class="badge badge-queued-ai">Queued for AI Evaluation</span>
        <span class="star-hint">${at.word_count} words · ${Math.round(at.duration_seconds)}s · ${at.wpm} wpm</span></div>
      <div style="margin:14px 0; font-size:0.85rem; line-height:1.5;">
        <i class="fa-solid fa-clock" style="color:var(--primary); margin-right:6px;"></i>
        <b>Attempt queued in <code>ai_jobs</code>.</b> Run this prompt in Antigravity or Claude to generate your delivery scorecard:
        <div class="prompt-copy-box">
          <code class="prompt-code">Process the behavioral STAR delivery scoring queue</code>
          <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('Process the behavioral STAR delivery scoring queue')">
            <i class="fa-solid fa-copy"></i> Copy
          </button>
        </div>
      </div>
      <div class="star-card-h">Transcript Submitted</div>
      <p class="star-script">${escapeHtml(at.transcript || '')}</p>
    </div>`;
  }

  const sc=at.scores||{}; const dims=[['lead_with_decision','Lead with decision'],['clean_metric_landing','Clean metric landing'],['compression','Compression'],['signposting_arc','Signposting & arc'],['tradeoff_judgment','Tradeoff & judgment'],['pushback_beat','Pushback beat'],['accurate_confidence','Accurate confidence'],['conversational_delivery','Conversational'],['time_adherence','Time adherence']];
  const rows=dims.map(([k,l])=>`<div class="star-dim"><span>${l}</span><span class="star-dim-v v${sc[k]??0}">${sc[k]??'–'}/4</span></div>`).join('');
  const ded=(at.auto_deductions||[]).map(d=>`<span class="star-deduct">${d.code} ${d.penalty}</span>`).join('');
  return `<div class="star-card star-scorecard">
    <div class="star-card-h">Delivery score <b class="star-big ${at.weighted_score<70?'lo':'hi'}">${Math.round(at.weighted_score)}/100</b>
      <span class="star-hint">${at.word_count} words · ${Math.round(at.duration_seconds)}s · ${at.wpm} wpm</span></div>
    ${ded?`<div class="star-deducts">Auto-deductions: ${ded}</div>`:''}
    <div class="star-dims">${rows}</div>
    <div class="star-fix"><b>The one fix:</b> ${escapeHtml(at.the_one_fix||'')}</div>
    <div class="star-worked"><b>What worked:</b> ${escapeHtml(at.what_worked||'')}</div>
    ${at.re_record?'<div class="star-rerecord">↻ Re-record recommended (score &lt;70 or a deduction fired).</div>':'<div class="star-worked">✓ Solid — bank it.</div>'}
  </div>`;
}

/* ---------------- Progress ---------------- */
function renderStarProgress(body) {
  fetch(`/api/stories/${star.currentId}/attempts`).then(r=>r.json()).then(list=>{
    star.attempts=Array.isArray(list)?list:[];
    if(!star.attempts.length){ body.innerHTML='<div class="star-empty">No attempts yet. Record a version in "Record & score".</div>'; return; }
    // recurring auto-deduction
    const counts={}; star.attempts.forEach(a=>(a.auto_deductions||[]).forEach(d=>counts[d.code]=(counts[d.code]||0)+1));
    const top=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    const byLen={};
    star.attempts.forEach(a=>{ (byLen[a.length]=byLen[a.length]||[]).push(a); });
    const series=Object.entries(byLen).map(([len,arr])=>{
      const pts=arr.map((a,i)=>({x:i,y:a.weighted_score}));
      const w=280,h=90,pad=8; const xs=(i)=>pad+(pts.length<2?w/2:i*(w-2*pad)/(pts.length-1)); const ys=(v)=>h-pad-(v/100)*(h-2*pad);
      const path=pts.map((p,i)=>`${i?'L':'M'}${xs(i).toFixed(0)},${ys(p.y).toFixed(0)}`).join(' ');
      const dots=pts.map((p,i)=>`<circle cx="${xs(i).toFixed(0)}" cy="${ys(p.y).toFixed(0)}" r="3" fill="var(--primary)"></circle>`).join('');
      const last=arr[arr.length-1].weighted_score;
      return `<div class="star-card"><div class="star-card-h">${len} · ${arr.length} attempt${arr.length>1?'s':''} <span class="star-hint">latest ${Math.round(last)}/100</span></div>
        <svg viewBox="0 0 ${w} ${h}" class="star-spark"><line x1="${pad}" y1="${ys(70).toFixed(0)}" x2="${w-pad}" y2="${ys(70).toFixed(0)}" class="star-spark-thresh"></line><path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2"></path>${dots}</svg></div>`;
    }).join('');
    body.innerHTML=`
      ${top?`<div class="star-card star-pattern"><div class="star-card-h">Your recurring pattern</div>
        <div class="star-big-pattern">${top[0]}</div>
        <div class="star-hint">fired in ${top[1]} of ${star.attempts.length} attempts — this is the drill. Watch it fade over weeks.</div></div>`:''}
      ${series}`;
  });
}


/* ==============================================================================
   DELIVERY TRAINING & ROLE-RELATED REPS (Rubric v1.1 + ai_jobs Queue)
   ============================================================================== */

const GYM_TAB_META = {
  hm: {
    label: 'Hiring Manager',
    title: 'Hiring Manager & Loop Reps',
    btnLabel: 'Draw Random Hiring Manager Question',
    hint: 'All of your past Hiring Manager & Full Loop questions — weak responses (< 7.2) automatically prioritized. Target: ≤ 120s.',
    filterType: 'weight',
    defaultCap: 120
  },
  recruiter: {
    label: 'Recruiter',
    title: 'Recruiter Screen Reps',
    btnLabel: 'Draw Random Recruiter Question',
    hint: 'All of your past Recruiter screen questions + 6 quick drills — weak responses prioritized. Target: 60–90s.',
    filterType: 'weight',
    defaultCap: 90
  },
  product_sense: {
    label: 'Product Sense',
    title: 'Product Sense Reps',
    btnLabel: 'Draw Random Product Sense Question',
    hint: 'Blends your past Product Sense rounds with optional external PM question bank prompts. Untimed stopwatch mode so you can think & structure freely.',
    filterType: 'source',
    defaultCap: 0
  },
  execution: {
    label: 'Execution & Analytical',
    title: 'Execution & Analytical Reps',
    btnLabel: 'Draw Random Execution / Analytical Question',
    hint: 'Blends your past Execution & Metrics rounds with optional external analytical question bank prompts. Untimed stopwatch mode so you can work through the problem cleanly.',
    filterType: 'source',
    defaultCap: 0
  },
  leadership: {
    label: 'Leadership & Drive',
    title: 'Leadership & Drive Reps',
    btnLabel: 'Draw Random Leadership & Drive Question',
    hint: 'Blends your past Leadership & behavioral rounds with optional external leadership prompts. Target: ≤ 120s.',
    filterType: 'source',
    defaultCap: 120
  }
};

const deliveryState = {
  inited: false,
  sessions: [],
  selectedSessionId: null,
  currentDrill: 'hm_real',
  captureMode: 'mic',
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  recTimerInterval: null,
  recSeconds: 0,
  targetSeconds: 120,
  showHctr: true,
  activeChartType: 'text',
  chartInstance: null,
  filterAnswerType: '',
  // Unified Practice Gym state
  activeTab: 'hm',               // 'hm' | 'recruiter' | 'product_sense' | 'execution' | 'leadership' | 'star_bank'
  activePool: 'hm',
  realQuestions: [],
  poolCounts: {},
  weightMode: 'weak_priority',   // 'weak_priority' | 'weak_only' | 'all'
  sourceMode: 'mix',             // 'mix' | 'mine' | 'lewis_lin'
  currentRealQ: null,
  lastRealQUid: null,
  currentTake: 1,
  // Canonical STAR Story Bank state
  starBankLoaded: false,
  starBankData: null,
  starBankCompany: 'all',
  starBankSearch: '',
  starBankExpandAll: false
};

function playSoftChime(freq = 660, durationMs = 140) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch (_) {}
}

function updateGymCountBadges() {
  const pc = deliveryState.poolCounts || {};
  Object.keys(GYM_TAB_META).forEach(k => {
    const el = document.getElementById(`gym-tab-cnt-${k}`);
    if (!el) return;
    const c = pc[k];
    el.textContent = c ? `(${c.total})` : '';
  });

  const active = deliveryState.activeTab;
  const badge = document.getElementById('badge-gym-draw-cnt');
  if (!badge || !GYM_TAB_META[active]) return;
  const c = pc[active];
  if (!c) {
    badge.textContent = '0 Qs';
    return;
  }
  if (GYM_TAB_META[active].filterType === 'weight') {
    badge.textContent = `${c.mine} Qs · ${c.weak} weak`;
  } else {
    if (deliveryState.sourceMode === 'mine') {
      badge.textContent = `${c.mine} Mine · ${c.weak} weak`;
    } else if (deliveryState.sourceMode === 'lewis_lin') {
      badge.textContent = `${c.lewis_lin} External Bank`;
    } else {
      badge.textContent = `${c.mine} Mine + ${c.lewis_lin} External`;
    }
  }
}

function loadRealPracticeQuestions() {
  fetch('/api/delivery/real-questions')
    .then(r => r.json())
    .then(data => {
      deliveryState.realQuestions = Array.isArray(data.questions) ? data.questions : [];
      deliveryState.poolCounts = data.pool_counts || {};
      updateGymCountBadges();

      // If currentRealQ was hydrated from a session fallback, upgrade it with full past-interview metadata
      if (deliveryState.currentRealQ && String(deliveryState.currentRealQ.uid || '').startsWith('sess:')) {
        const qKey = normalizeGymQText(deliveryState.currentRealQ.question);
        const fullMatch = deliveryState.realQuestions.find(q => normalizeGymQText(q.question) === qKey);
        if (fullMatch) {
          deliveryState.currentRealQ = fullMatch;
          renderRealQuestionMeta(fullMatch);
          saveGymDraftState();
        }
      }
    })
    .catch(() => {});
}

const GYM_STORAGE_KEY = 'pm_board_gym_active_v1';

function normalizeGymQText(txt) {
  return String(txt || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function countTakesForQuestion(qText) {
  const key = normalizeGymQText(qText);
  if (!key || !Array.isArray(deliveryState.sessions)) return 0;
  return deliveryState.sessions.filter(s => normalizeGymQText(s.question) === key).length;
}

function renderPersistentTakeAlert(completedTakeNum, recordedSec) {
  const qAlert = document.getElementById('delivery-queue-alert');
  const qAlertTitle = document.getElementById('delivery-queue-alert-title');
  const btnTake2 = document.getElementById('btn-delivery-take2');
  if (!qAlert) return;
  const nextTake = (completedTakeNum || 1) + 1;
  const secStr = recordedSec ? ` (${recordedSec}s)` : '';
  if (qAlertTitle) qAlertTitle.textContent = `Take #${completedTakeNum || 1} Saved${secStr} — Ready for Take #${nextTake}!`;
  if (btnTake2) btnTake2.innerHTML = `<i class="fa-solid fa-rotate-right"></i> Record Take #${nextTake} (Same Question)`;
  qAlert.style.display = 'block';
}

function saveGymDraftState(overrides = {}) {
  try {
    const qIn = document.getElementById('delivery-question-input');
    const prev = JSON.parse(localStorage.getItem(GYM_STORAGE_KEY) || '{}');
    const state = {
      activeTab: deliveryState.activeTab || 'hm',
      activePool: deliveryState.activePool || 'hm',
      currentDrill: deliveryState.currentDrill || 'hm_real',
      questionText: qIn ? qIn.value : (prev.questionText || ''),
      currentRealQ: deliveryState.currentRealQ || null,
      currentTake: deliveryState.currentTake || 1,
      targetSeconds: deliveryState.targetSeconds !== undefined ? deliveryState.targetSeconds : 120,
      weightMode: deliveryState.weightMode || 'weak_priority',
      sourceMode: deliveryState.sourceMode || 'mix',
      pendingTake2: deliveryState.pendingTake2 || false,
      lastCompletedTake: deliveryState.lastCompletedTake || 0,
      lastRecordedSec: deliveryState.lastRecordedSec || 0,
      ...overrides
    };
    localStorage.setItem(GYM_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

function restoreGymDraftState() {
  try {
    const raw = localStorage.getItem(GYM_STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.questionText) return false;

    if (saved.weightMode) {
      deliveryState.weightMode = saved.weightMode;
      document.querySelectorAll('#delivery-weight-pills .pill').forEach(x => {
        x.classList.toggle('active', x.getAttribute('data-weight') === saved.weightMode);
      });
    }
    if (saved.sourceMode) {
      deliveryState.sourceMode = saved.sourceMode;
      document.querySelectorAll('#delivery-source-pills .pill').forEach(x => {
        x.classList.toggle('active', x.getAttribute('data-source') === saved.sourceMode);
      });
    }
    if (saved.activeTab) {
      setGymTab(saved.activeTab, { preserveCap: true, skipSave: true });
    }
    if (saved.targetSeconds !== undefined && saved.targetSeconds !== null) {
      setDeliveryTargetCap(Number(saved.targetSeconds), { skipSave: true });
    }
    deliveryState.currentDrill = saved.currentDrill || 'hm_real';
    deliveryState.currentRealQ = saved.currentRealQ || null;
    deliveryState.lastRealQUid = saved.currentRealQ ? saved.currentRealQ.uid : null;
    deliveryState.currentTake = saved.currentTake || 1;
    deliveryState.pendingTake2 = Boolean(saved.pendingTake2);
    deliveryState.lastCompletedTake = saved.lastCompletedTake || 0;
    deliveryState.lastRecordedSec = saved.lastRecordedSec || 0;

    const qIn = document.getElementById('delivery-question-input');
    if (qIn) qIn.value = saved.questionText;

    if (deliveryState.currentRealQ) {
      renderRealQuestionMeta(deliveryState.currentRealQ);
    }
    updateRecButtonIdleLabel();
    if (deliveryState.pendingTake2 && deliveryState.lastCompletedTake >= 1) {
      renderPersistentTakeAlert(deliveryState.lastCompletedTake, deliveryState.lastRecordedSec);
    }
    deliveryState.hasRestoredDraft = true;
    return true;
  } catch (_) {
    return false;
  }
}

window.retryDeliverySession = function (sid, autoStart = false) {
  const sess = (deliveryState.sessions || []).find(s => Number(s.id) === Number(sid));
  if (!sess || !sess.question) return;

  const qKey = normalizeGymQText(sess.question);
  const existingTakes = Math.max(1, countTakesForQuestion(sess.question));
  const nextTake = existingTakes + 1;

  // Match back to full real-question metadata if present (company, round, past score, gaps, model)
  let matched = (deliveryState.realQuestions || []).find(q => normalizeGymQText(q.question) === qKey);
  let pool = 'hm';
  const at = String(sess.answer_type || '').toLowerCase();
  if (matched && matched.pool) pool = matched.pool;
  else if (at.includes('recruiter') || ['intro', 'why_role', 'why_company', 'next_role', 'comp', 'people_mgmt'].includes(at)) pool = 'recruiter';
  else if (at.includes('product_sense')) pool = 'product_sense';
  else if (at.includes('execution')) pool = 'execution';
  else if (at.includes('leadership')) pool = 'leadership';

  if (!matched) {
    matched = {
      uid: `sess:${sess.id}`,
      source: 'my_interview',
      review_id: null,
      pool: pool,
      company: 'Previous Rep',
      role: '',
      round_type: sess.answer_type || 'Practice',
      interview_date: (sess.created_at || '').slice(0, 10),
      question: sess.question,
      score: sess.overall != null ? Number(sess.overall) : null,
      is_weak: sess.overall != null && Number(sess.overall) < 7.2,
      gaps: [],
      how_to_approach: (sess.result && sess.result.top_fix) ? sess.result.top_fix : '',
      model_answer: (sess.result && sess.result.opening_rewrite) ? sess.result.opening_rewrite : '',
      practice_count: existingTakes
    };
  }

  applyPrepMode('delivery');
  setGymTab(pool, { preserveCap: true });
  loadQuestionIntoGym(matched, {
    takeNumber: nextTake,
    pendingTake2: true,
    lastCompletedTake: existingTakes,
    lastRecordedSec: (sess.acoustic && sess.acoustic.duration_sec) ? Math.round(sess.acoustic.duration_sec) : 0
  });
  renderPersistentTakeAlert(existingTakes, (sess.acoustic && sess.acoustic.duration_sec) ? Math.round(sess.acoustic.duration_sec) : 0);

  const del = document.getElementById('prep-mode-delivery');
  if (del) del.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(`Loaded Take #${nextTake} for this question — ready to compare against Take #${existingTakes}!`);
  if (autoStart && !deliveryState.isRecording) {
    toggleDeliveryRecording();
  }
};

function setDeliveryTargetCap(sec, opts = {}) {
  const cap = Number.isFinite(Number(sec)) ? Number(sec) : 120;
  deliveryState.targetSeconds = cap;
  document.querySelectorAll('#delivery-target-pills .pill[data-cap]').forEach(x => {
    x.classList.toggle('active', parseInt(x.getAttribute('data-cap'), 10) === cap);
  });

  // Update H-C-T-R beat sub-labels & auto-hide behavioral rail during untimed (cap === 0) case work
  const hctrRail = document.getElementById('delivery-hctr-rail');
  const btnHctr = document.getElementById('btn-toggle-hctr');
  if (cap === 0) {
    if (hctrRail) hctrRail.style.display = 'none';
    if (btnHctr) btnHctr.classList.remove('active');
  } else {
    if (hctrRail) hctrRail.style.display = deliveryState.showHctr ? 'grid' : 'none';
    if (btnHctr) btnHctr.classList.toggle('active', deliveryState.showHctr);
    const hEnd = Math.round(cap * 0.17);
    const cEnd = Math.round(cap * 0.33);
    const rStart = Math.max(cap - 25, Math.round(cap * 0.79));
    const subH = document.getElementById('hctr-sub-H');
    const subC = document.getElementById('hctr-sub-C');
    const subT = document.getElementById('hctr-sub-T');
    const subR = document.getElementById('hctr-sub-R');
    if (subH) subH.textContent = `0–${hEnd}s: Prompt + pain`;
    if (subC) subC.textContent = `${hEnd}–${cEnd}s: S + Mandate`;
    if (subT) subT.textContent = `${cEnd}–${rStart}s: Strategy`;
    if (subR) subR.textContent = `${rStart}–${cap}s: #s + STOP`;
  }

  updateRecButtonIdleLabel();
  if (!opts.skipSave) saveGymDraftState();
}

function setGymTab(tab, opts = {}) {
  deliveryState.activeTab = tab;
  document.querySelectorAll('#gym-category-tabs [data-gym-tab]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-gym-tab') === tab);
  });

  const practiceWs = document.getElementById('gym-practice-workspace');
  const starWs = document.getElementById('gym-star-bank-workspace');

  if (tab === 'star_bank') {
    if (practiceWs) practiceWs.style.display = 'none';
    if (starWs) starWs.style.display = '';
    loadCanonicalStarBank();
    if (!opts.skipSave) saveGymDraftState();
    return;
  }

  if (practiceWs) practiceWs.style.display = '';
  if (starWs) starWs.style.display = 'none';

  const meta = GYM_TAB_META[tab] || GYM_TAB_META.hm;
  deliveryState.activePool = tab;

  const titleEl = document.getElementById('gym-card-title');
  const hintEl = document.getElementById('gym-card-hint');
  const btnLbl = document.getElementById('lbl-gym-draw-random');
  const weightPills = document.getElementById('delivery-weight-pills');
  const sourcePills = document.getElementById('delivery-source-pills');
  const recDrills = document.getElementById('gym-recruiter-quick-drills');

  if (titleEl) titleEl.innerHTML = `<i class="fa-solid fa-shuffle"></i> ${escapeHtml(meta.title)}`;
  if (hintEl) hintEl.textContent = meta.hint;
  if (btnLbl) btnLbl.innerHTML = `<i class="fa-solid fa-dice" style="margin-right:7px;"></i>${escapeHtml(meta.btnLabel)}`;
  if (weightPills) weightPills.style.display = meta.filterType === 'weight' ? 'flex' : 'none';
  if (sourcePills) sourcePills.style.display = meta.filterType === 'source' ? 'flex' : 'none';
  if (recDrills) recDrills.style.display = tab === 'recruiter' ? 'block' : 'none';

  if (!opts.preserveCap && meta.defaultCap !== undefined) {
    setDeliveryTargetCap(meta.defaultCap, { skipSave: true });
  }
  updateGymCountBadges();
  if (!opts.skipSave) saveGymDraftState();
}

function loadQuestionIntoGym(picked, opts = {}) {
  if (!picked) return;
  deliveryState.currentRealQ = picked;
  deliveryState.lastRealQUid = picked.uid;
  const existingTakes = countTakesForQuestion(picked.question);
  deliveryState.currentTake = opts.takeNumber || (existingTakes > 0 ? existingTakes + 1 : 1);
  deliveryState.currentDrill = `${picked.pool || 'hm'}_real`;
  deliveryState.pendingTake2 = Boolean(opts.pendingTake2);
  deliveryState.lastCompletedTake = opts.lastCompletedTake || existingTakes;
  deliveryState.lastRecordedSec = opts.lastRecordedSec || 0;

  document.querySelectorAll('.btn-drill').forEach(b => b.classList.remove('active'));
  const qIn = document.getElementById('delivery-question-input');
  if (qIn) qIn.value = picked.question;

  renderRealQuestionMeta(picked);
  updateRecButtonIdleLabel();
  const qAlert = document.getElementById('delivery-queue-alert');
  if (qAlert && !deliveryState.pendingTake2) qAlert.style.display = 'none';
  saveGymDraftState();
}

function sampleWeightedQuestion(candidates, prioritizeWeak) {
  const weights = candidates.map(q => {
    let w = 1.0;
    if (prioritizeWeak) {
      if (q.is_weak) w = 3.5;
      else if (q.score !== null && q.score < 7.5) w = 1.6;
    }
    if ((q.practice_count || 0) === 0) w *= 1.35;
    else w /= (1 + 0.35 * q.practice_count);
    return w;
  });

  const totalW = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalW;
  let picked = candidates[candidates.length - 1];
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      picked = candidates[i];
      break;
    }
  }
  return picked;
}

function pickRandomRealQuestion(pool) {
  const targetPool = pool || deliveryState.activePool || 'hm';
  deliveryState.activePool = targetPool;
  const meta = GYM_TAB_META[targetPool] || GYM_TAB_META.hm;
  const allInPool = deliveryState.realQuestions.filter(q => q.pool === targetPool);

  if (!allInPool.length) {
    showToast(`No ${meta.label} questions loaded yet.`, 'warn');
    return;
  }

  let candidates = allInPool;
  let prioritizeWeak = false;

  if (meta.filterType === 'weight') {
    prioritizeWeak = deliveryState.weightMode === 'weak_priority';
    if (deliveryState.weightMode === 'weak_only') {
      const weakOnly = allInPool.filter(q => q.is_weak);
      if (weakOnly.length > 0) {
        candidates = weakOnly;
      } else {
        showToast('No questions scored < 7.2 in this pool; pulling from all questions instead.', 'info');
      }
    }
  } else {
    const mine = allInPool.filter(q => q.source !== 'lewis_lin');
    const ll = allInPool.filter(q => q.source === 'lewis_lin');
    if (deliveryState.sourceMode === 'mine') {
      candidates = mine.length ? mine : allInPool;
      prioritizeWeak = true;
    } else if (deliveryState.sourceMode === 'lewis_lin') {
      candidates = ll.length ? ll : allInPool;
    } else {
      // Mix mode: give My Past Interviews a 45% draw chance (weak-prioritized) so they stay visible alongside the external question bank
      if (mine.length && ll.length) {
        if (Math.random() < 0.45) {
          candidates = mine;
          prioritizeWeak = true;
        } else {
          candidates = ll;
        }
      } else {
        candidates = allInPool;
        prioritizeWeak = true;
      }
    }
  }

  if (candidates.length > 1 && deliveryState.lastRealQUid) {
    candidates = candidates.filter(q => q.uid !== deliveryState.lastRealQUid);
  }

  const picked = sampleWeightedQuestion(candidates, prioritizeWeak);
  loadQuestionIntoGym(picked);
}

function renderRealQuestionMeta(q) {
  const metaWrap = document.getElementById('delivery-real-q-meta');
  const badgesEl = document.getElementById('delivery-real-q-badges');
  const takeBadge = document.getElementById('delivery-take-badge');
  const revBox = document.getElementById('delivery-past-review-box');
  const toggleBtn = document.getElementById('btn-toggle-past-coach');

  if (!metaWrap) return;
  if (!q) {
    metaWrap.style.display = 'none';
    return;
  }

  metaWrap.style.display = 'block';
  const isLewis = q.source === 'lewis_lin';
  const scoreColor = q.score === null ? '#94a3b8' : (q.score < 6.5 ? '#ef4444' : (q.score < 7.5 ? '#f59e0b' : '#10b981'));
  const poolLabel = (GYM_TAB_META[q.pool] && GYM_TAB_META[q.pool].label) || q.pool || 'Practice';
  const srcBadge = isLewis
    ? `<span style="font-weight:700; padding:2px 8px; border-radius:99px; background:rgba(20,184,166,0.18); color:#14b8a6;">External Bank</span>`
    : `<span style="font-weight:700; padding:2px 8px; border-radius:99px; background:rgba(99,102,241,0.18); color:var(--primary);">My Interview · ${escapeHtml(poolLabel)}</span>`;
  const scoreBadge = !isLewis
    ? `<span style="font-weight:700; color:${scoreColor}; padding:1px 7px; border-radius:99px; border:1px solid ${scoreColor};">${q.score !== null ? `Past: ${q.score}/10` : 'Unscored'}</span>`
    : '';
  const datePart = q.interview_date ? ` (${escapeHtml(q.interview_date)})` : '';

  if (badgesEl) {
    badgesEl.innerHTML = `
      ${srcBadge}
      <span style="font-weight:700; color:var(--text-primary);">${escapeHtml(q.company || 'General PM')}</span>
      <span style="color:var(--text-secondary);">· ${escapeHtml(q.round_type || poolLabel)}${datePart}</span>
      ${scoreBadge}
      ${q.practice_count ? `<span style="color:var(--text-muted);">Drilled ${q.practice_count}x</span>` : ''}
    `;
  }
  if (takeBadge) {
    takeBadge.textContent = `Take #${deliveryState.currentTake}`;
    takeBadge.style.background = deliveryState.currentTake > 1 ? 'rgba(245,158,11,0.18)' : 'rgba(16,185,129,0.16)';
    takeBadge.style.color = deliveryState.currentTake > 1 ? '#f59e0b' : '#10b981';
  }

  const hasCoachNotes = (Array.isArray(q.gaps) && q.gaps.length > 0) || !!q.how_to_approach || !!q.model_answer || !!q.notes;
  if (revBox) {
    revBox.style.display = 'none';
    const gapsHtml = Array.isArray(q.gaps) && q.gaps.length
      ? `<div style="margin-bottom:6px;"><b style="color:#f59e0b;">Past Gaps:</b> ${q.gaps.map(g => escapeHtml(g)).join(' · ')}</div>`
      : '';
    const approachHtml = q.how_to_approach
      ? `<div style="margin-bottom:6px;"><b style="color:var(--primary);">${isLewis ? 'Bank Notes' : 'How to Approach'}:</b> ${escapeHtml(q.how_to_approach)}</div>`
      : '';
    const modelHtml = q.model_answer
      ? `<div><b style="color:#10b981;">Model Answer:</b> ${escapeHtml(q.model_answer)}</div>`
      : '';
    revBox.innerHTML = (gapsHtml + approachHtml + modelHtml) || '<i>No stored coaching notes for this question yet.</i>';
  }
  if (toggleBtn) {
    toggleBtn.style.display = hasCoachNotes ? '' : 'none';
    toggleBtn.innerHTML = isLewis
      ? '<i class="fa-solid fa-eye"></i> Show Bank Notes'
      : '<i class="fa-solid fa-eye"></i> Reveal Past Gap &amp; Model';
  }
}

/* --- Canonical STAR Story Bank (33 Stories inside Practice Gym) --- */
function loadCanonicalStarBank() {
  if (deliveryState.starBankLoaded && deliveryState.starBankData) {
    renderStarBank();
    return;
  }
  fetch('/api/delivery/star-bank')
    .then(r => r.json())
    .then(data => {
      deliveryState.starBankLoaded = true;
      deliveryState.starBankData = data;
      const cntEl = document.getElementById('gym-tab-cnt-star_bank');
      if (cntEl && data.story_count) cntEl.textContent = `(${data.story_count})`;
      const docLink = document.getElementById('star-bank-doc-link');
      if (docLink && data.source_url) docLink.href = data.source_url;

      const ovEl = document.getElementById('star-bank-overlap-list');
      if (ovEl && Array.isArray(data.overlap_notes) && data.overlap_notes.length) {
        ovEl.innerHTML = data.overlap_notes.map(o =>
          `<div style="margin-bottom:4px;"><b style="color:var(--text-primary);">${escapeHtml(o.cluster)}:</b> ${escapeHtml(o.note)}</div>`
        ).join('');
      }
      renderStarBank();
    })
    .catch(err => {
      const wrap = document.getElementById('star-bank-cards');
      if (wrap) wrap.innerHTML = `<div style="color:#ef4444; padding:18px;">Failed to load Canonical STAR Story Bank: ${escapeHtml(err.message)}</div>`;
    });
}

function renderStarBank() {
  const wrap = document.getElementById('star-bank-cards');
  if (!wrap || !deliveryState.starBankData) return;

  const all = deliveryState.starBankData.stories || [];
  const co = deliveryState.starBankCompany || 'all';
  const q = (deliveryState.starBankSearch || '').trim().toLowerCase();

  const filtered = all.filter(s => {
    if (co === 'confirm' && !s.needs_confirmation) return false;
    if (co !== 'all' && co !== 'confirm' && s.company !== co) return false;
    if (q) {
      const blob = `${s.id} ${s.company} ${s.section} ${s.title} ${s.recall} ${s.use_for} ${s.full_text || ''}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    wrap.innerHTML = `<div class="delivery-card" style="text-align:center; padding:28px; color:var(--text-muted);">No STAR stories match "${escapeHtml(deliveryState.starBankSearch)}".</div>`;
    return;
  }

  const coColors = { Meta: '#3b82f6', Google: '#10b981', Infosys: '#a855f7' };
  const labelOrder = [
    ['headline', 'Headline', '#3b82f6'],
    ['situation', 'Situation', '#94a3b8'],
    ['task', 'Task', '#818cf8'],
    ['action', 'Action', '#10b981'],
    ['result', 'Result', '#22c55e'],
    ['learning', 'Learning', '#f59e0b'],
    ['evidence_note', 'Evidence Note', '#f97316']
  ];

  wrap.innerHTML = filtered.map(s => {
    const col = coColors[s.company] || '#6366f1';
    const expanded = deliveryState.starBankExpandAll;
    const secs = s.sections || {};
    const bodyHtml = Object.keys(secs).length
      ? labelOrder.filter(([k]) => secs[k]).map(([k, lbl, c]) =>
          `<div style="margin-bottom:8px;"><span style="font-weight:700; color:${c}; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.04em; margin-right:6px;">${lbl}</span><span style="color:var(--text-primary);">${escapeHtml(secs[k])}</span></div>`
        ).join('')
      : `<div style="white-space:pre-wrap; color:var(--text-secondary);">${escapeHtml(s.full_text || '')}</div>`;

    const useTags = (s.use_for || '').split('·').map(t => t.trim()).filter(Boolean)
      .map(t => `<span style="font-size:0.71rem; padding:2px 8px; border-radius:99px; background:rgba(99,102,241,0.12); color:var(--text-secondary);">${escapeHtml(t)}</span>`).join('');

    return `
      <div class="delivery-card" style="padding:14px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
          <div style="flex:1; min-width:240px; cursor:pointer;" onclick="toggleStarCard('${escapeHtml(s.id)}')">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
              <span style="font-family:monospace; font-weight:800; font-size:0.78rem; padding:2px 8px; border-radius:6px; background:rgba(99,102,241,0.18); color:var(--primary);">${escapeHtml(s.id)}</span>
              <span style="font-size:0.72rem; font-weight:700; padding:2px 8px; border-radius:99px; border:1px solid ${col}; color:${col};">${escapeHtml(s.company)}</span>
              <span style="font-weight:700; font-size:0.94rem; color:var(--text-primary);">${escapeHtml(s.title)}</span>
              ${s.needs_confirmation ? `<span style="font-size:0.7rem; font-weight:700; padding:2px 7px; border-radius:99px; background:rgba(245,158,11,0.18); color:#f59e0b;" title="Check Evidence Note before quoting exact figures">† Confirm Metrics</span>` : ''}
            </div>
            <div style="font-size:0.81rem; color:var(--text-primary); background:rgba(16,185,129,0.08); border-left:3px solid #10b981; padding:6px 10px; border-radius:4px; margin-bottom:8px;">
              <b style="color:#10b981; font-size:0.74rem; text-transform:uppercase; margin-right:6px;">Recall:</b>${escapeHtml(s.recall)}
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:5px; align-items:center;">
              <span style="font-size:0.72rem; color:var(--text-muted); font-weight:600; margin-right:2px;">Use for:</span>
              ${useTags}
            </div>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <button type="button" class="btn btn-primary btn-sm" onclick="drillCanonicalStarStory('${escapeHtml(s.id)}')" title="Jump to Leadership & Drive 120s timer with this story">
              <i class="fa-solid fa-microphone-lines"></i> Drill (120s)
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="star-card-btn-${escapeHtml(s.id)}" onclick="toggleStarCard('${escapeHtml(s.id)}')">
              <i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}"></i> ${expanded ? 'Hide' : 'Full STAR'}
            </button>
          </div>
        </div>
        <div id="star-card-body-${escapeHtml(s.id)}" style="display:${expanded ? 'block' : 'none'}; margin-top:12px; padding-top:12px; border-top:1px solid var(--border-color); font-size:0.83rem; line-height:1.55;">
          ${bodyHtml}
        </div>
      </div>
    `;
  }).join('');
}

window.toggleStarCard = function (id) {
  const body = document.getElementById(`star-card-body-${id}`);
  const btn = document.getElementById(`star-card-btn-${id}`);
  if (!body) return;
  const open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  if (btn) btn.innerHTML = open
    ? '<i class="fa-solid fa-chevron-down"></i> Full STAR'
    : '<i class="fa-solid fa-chevron-up"></i> Hide';
};

window.drillCanonicalStarStory = function (id) {
  const stories = (deliveryState.starBankData && deliveryState.starBankData.stories) || [];
  const s = stories.find(x => x.id === id);
  if (!s) return;
  setGymTab('leadership');
  setDeliveryTargetCap(120);
  loadQuestionIntoGym({
    uid: `star:${s.id}`,
    source: 'my_interview',
    review_id: null,
    pool: 'leadership',
    company: s.company,
    role: 'Canonical STAR Story',
    round_type: `STAR ${s.id}`,
    interview_date: '',
    question: `[STAR ${s.id} · ${s.title}] Tell me about a time demonstrating: ${s.use_for}.`,
    score: null,
    is_weak: false,
    gaps: [],
    how_to_approach: `Anchor metrics to hit: ${s.recall}`,
    model_answer: (s.sections && s.sections.headline) ? `Headline: ${s.sections.headline}` : '',
    practice_count: 0
  });
  const del = document.getElementById('prep-mode-delivery');
  if (del) del.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function updateDeliveryCountdownUI() {
  const cap = deliveryState.targetSeconds !== undefined ? Number(deliveryState.targetSeconds) : 120;
  const elapsed = deliveryState.recSeconds;

  const timer = document.getElementById('delivery-rec-timer');
  const bar = document.getElementById('delivery-countdown-bar');
  const phase = document.getElementById('delivery-phase-chip');
  const elapsedEl = document.getElementById('delivery-rec-elapsed');

  const fmt = (sec) => {
    const a = Math.abs(sec);
    const m = Math.floor(a / 60);
    const s = a % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Untimed stopwatch mode (Product Sense / Execution & Analytical cases)
  if (cap === 0) {
    if (timer) {
      timer.textContent = fmt(elapsed);
      timer.style.color = '#38bdf8';
    }
    if (bar) {
      bar.style.width = '100%';
      bar.style.backgroundColor = 'rgba(56,189,248,0.45)';
    }
    if (phase) {
      phase.textContent = '⏱️ UNTIMED CASE — Clarify assumptions, structure & walk through freely';
      phase.style.color = '#38bdf8';
      phase.style.background = 'rgba(56,189,248,0.16)';
    }
    if (elapsedEl) {
      elapsedEl.textContent = `Elapsed: ${fmt(elapsed)} (No Limit) · Take a silent pause between sections instead of saying "uh / like"`;
    }
    resetDeliveryHctrHighlight();
    return;
  }

  const remaining = cap - elapsed;
  if (timer) {
    timer.textContent = remaining >= 0 ? fmt(remaining) : `+${fmt(remaining)} OVER`;
  }
  if (elapsedEl) {
    elapsedEl.textContent = `Elapsed: ${fmt(elapsed)} / ${fmt(cap)} · Pause silently at periods instead of saying "uh / like"`;
  }

  const pct = Math.min(100, Math.round((elapsed / cap) * 100));
  const headlineEnd = Math.round(cap * 0.17);   // ~20s on 120s, ~15s on 90s
  const stakesEnd = Math.round(cap * 0.33);     // ~40s on 120s, ~30s on 90s
  const landStart = Math.max(cap - 25, Math.round(cap * 0.79)); // ~95s on 120s, ~71s on 90s

  let color = '#3b82f6';
  let bg = 'rgba(59,130,246,0.18)';
  let phaseText = '🎯 HEADLINE — Mirror prompt + state the core pain/call';
  let activeBeat = 'H';

  if (elapsed > cap) {
    color = '#ef4444';
    bg = 'rgba(239,68,68,0.22)';
    phaseText = '🔴 OVER CAP — Wrap up and stop clean!';
    activeBeat = 'R';
  } else if (elapsed >= landStart) {
    color = '#f59e0b';
    bg = 'rgba(245,158,11,0.2)';
    phaseText = '🏁 LAND — Give 2 numbers + guardrail, drop pitch, STOP';
    activeBeat = 'R';
  } else if (elapsed >= stakesEnd) {
    color = '#10b981';
    bg = 'rgba(16,185,129,0.18)';
    phaseText = '🧱 STRATEGY & MOVES — Walk through your 2 key bets';
    activeBeat = 'T';
  } else if (elapsed >= headlineEnd) {
    color = '#10b981';
    bg = 'rgba(16,185,129,0.16)';
    phaseText = '⚡ SCALE & MANDATE — 1–2 sentences on scope & stakes';
    activeBeat = 'C';
  }

  if (timer) timer.style.color = color;
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.style.backgroundColor = color;
  }
  if (phase) {
    phase.textContent = phaseText;
    phase.style.color = color;
    phase.style.background = bg;
  }

  // Soft audio cues at wrap-up window and at cap
  if (elapsed === landStart) playSoftChime(587, 130);
  if (elapsed === cap) playSoftChime(880, 220);

  // Highlight active H-C-T-R beat
  document.querySelectorAll('#delivery-hctr-rail .hctr-beat').forEach(el => {
    const isMatch = el.getAttribute('data-beat') === activeBeat;
    el.style.boxShadow = isMatch ? `0 0 0 2px ${color}` : 'none';
    el.style.opacity = isMatch ? '1' : '0.62';
  });
}

function resetDeliveryHctrHighlight() {
  document.querySelectorAll('#delivery-hctr-rail .hctr-beat').forEach(el => {
    el.style.boxShadow = 'none';
    el.style.opacity = '1';
  });
}

function updateRecButtonIdleLabel() {
  const btn = document.getElementById('btn-delivery-rec');
  if (btn && !deliveryState.isRecording) {
    const takeStr = deliveryState.currentRealQ && deliveryState.currentTake > 1 ? `Take #${deliveryState.currentTake} ` : '';
    const cap = deliveryState.targetSeconds !== undefined ? Number(deliveryState.targetSeconds) : 120;
    const capLabel = cap === 0 ? 'No Limit' : `${cap}s Cap`;
    btn.innerHTML = `<i class="fa-solid fa-microphone"></i> Start Recording ${takeStr}(${capLabel})`;
  }
}

const DRILL_QUESTIONS = {
  intro: "Walk me through your background and why you're looking for your next role.",
  why_role: "Why are you interested in this specific Product Management role?",
  why_company: "Why do you want to join our company at this stage?",
  next_role: "What specific scope, culture, and team structure are you looking for in your next role?",
  comp: "What are your compensation expectations for this level?",
  people_mgmt: "Walk me through your people-management and cross-functional leadership approach."
};

function initDeliveryModule() {
  if (deliveryState.inited) return;
  deliveryState.inited = true;

  // 0. Unified Practice Gym 6 Category Sub-Tabs
  document.querySelectorAll('#gym-category-tabs [data-gym-tab]').forEach(tabBtn => {
    on(tabBtn, 'click', () => {
      const t = tabBtn.getAttribute('data-gym-tab') || 'hm';
      setGymTab(t);
    });
  });

  // 1. Common recruiter quick drill presets
  document.querySelectorAll('.btn-drill').forEach(btn => {
    on(btn, 'click', () => {
      document.querySelectorAll('.btn-drill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const drill = btn.getAttribute('data-drill');
      deliveryState.currentDrill = drill;
      deliveryState.currentRealQ = null;
      deliveryState.currentTake = 1;
      renderRealQuestionMeta(null);
      updateRecButtonIdleLabel();
      const qIn = document.getElementById('delivery-question-input');
      if (qIn && DRILL_QUESTIONS[drill]) {
        qIn.value = DRILL_QUESTIONS[drill];
      }
    });
  });

  // 1b. Category Randomizer + Weight / Source Pills + Cap + H-C-T-R + Reveal + Take 2
  const btnDraw = document.getElementById('btn-gym-draw-random');
  if (btnDraw) {
    on(btnDraw, 'click', () => {
      pickRandomRealQuestion(deliveryState.activePool || 'hm');
      updateRecButtonIdleLabel();
    });
  }

  document.querySelectorAll('#delivery-weight-pills .pill').forEach(p => {
    on(p, 'click', () => {
      document.querySelectorAll('#delivery-weight-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      deliveryState.weightMode = p.getAttribute('data-weight') || 'weak_priority';
      saveGymDraftState();
    });
  });

  document.querySelectorAll('#delivery-source-pills .pill').forEach(p => {
    on(p, 'click', () => {
      document.querySelectorAll('#delivery-source-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      deliveryState.sourceMode = p.getAttribute('data-source') || 'mix';
      updateGymCountBadges();
      saveGymDraftState();
    });
  });

  const qInputEl = document.getElementById('delivery-question-input');
  if (qInputEl) {
    on(qInputEl, 'input', () => {
      saveGymDraftState();
    });
  }

  document.querySelectorAll('#delivery-target-pills .pill[data-cap]').forEach(p => {
    on(p, 'click', () => {
      const raw = parseInt(p.getAttribute('data-cap'), 10);
      const cap = isNaN(raw) ? 120 : raw;
      setDeliveryTargetCap(cap);
    });
  });

  const btnHctr = document.getElementById('btn-toggle-hctr');
  const hctrRail = document.getElementById('delivery-hctr-rail');
  if (btnHctr && hctrRail) {
    on(btnHctr, 'click', () => {
      deliveryState.showHctr = !deliveryState.showHctr;
      btnHctr.classList.toggle('active', deliveryState.showHctr);
      hctrRail.style.display = deliveryState.showHctr ? 'grid' : 'none';
    });
  }

  const btnToggleCoach = document.getElementById('btn-toggle-past-coach');
  const revBox = document.getElementById('delivery-past-review-box');
  if (btnToggleCoach && revBox) {
    on(btnToggleCoach, 'click', () => {
      const open = revBox.style.display === 'block';
      revBox.style.display = open ? 'none' : 'block';
      const isLewis = deliveryState.currentRealQ && deliveryState.currentRealQ.source === 'lewis_lin';
      btnToggleCoach.innerHTML = open
        ? (isLewis ? '<i class="fa-solid fa-eye"></i> Show Bank Notes' : '<i class="fa-solid fa-eye"></i> Reveal Past Gap &amp; Model')
        : (isLewis ? '<i class="fa-solid fa-eye-slash"></i> Hide Bank Notes' : '<i class="fa-solid fa-eye-slash"></i> Hide Past Gap &amp; Model');
    });
  }

  const btnTake2 = document.getElementById('btn-delivery-take2');
  if (btnTake2) {
    on(btnTake2, 'click', () => {
      const nextTake = Math.max(deliveryState.currentTake || 1, (deliveryState.lastCompletedTake || 1) + 1);
      deliveryState.currentTake = nextTake;
      const takeBadge = document.getElementById('delivery-take-badge');
      if (takeBadge) {
        takeBadge.textContent = `Take #${deliveryState.currentTake}`;
        takeBadge.style.background = 'rgba(245,158,11,0.18)';
        takeBadge.style.color = '#f59e0b';
      }
      updateRecButtonIdleLabel();
      saveGymDraftState();
      if (!deliveryState.isRecording) toggleDeliveryRecording();
    });
  }

  const btnNextRand = document.getElementById('btn-delivery-next-rand');
  if (btnNextRand) {
    on(btnNextRand, 'click', () => {
      pickRandomRealQuestion(deliveryState.activePool || 'hm');
      updateRecButtonIdleLabel();
    });
  }

  // 1c. Canonical STAR Story Bank controls (Company pills, Search, Expand All)
  document.querySelectorAll('#star-bank-company-pills .pill').forEach(p => {
    on(p, 'click', () => {
      document.querySelectorAll('#star-bank-company-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      deliveryState.starBankCompany = p.getAttribute('data-star-co') || 'all';
      renderStarBank();
    });
  });

  const starSearch = document.getElementById('star-bank-search');
  if (starSearch) {
    on(starSearch, 'input', () => {
      deliveryState.starBankSearch = starSearch.value || '';
      renderStarBank();
    });
  }

  const btnStarToggleAll = document.getElementById('btn-star-bank-toggle-all');
  if (btnStarToggleAll) {
    on(btnStarToggleAll, 'click', () => {
      deliveryState.starBankExpandAll = !deliveryState.starBankExpandAll;
      btnStarToggleAll.innerHTML = deliveryState.starBankExpandAll
        ? '<i class="fa-solid fa-angles-up"></i> Collapse All'
        : '<i class="fa-solid fa-angles-down"></i> Expand All';
      renderStarBank();
    });
  }

  const restored = restoreGymDraftState();
  if (!restored) {
    setGymTab(deliveryState.activeTab || 'hm', { preserveCap: true, skipSave: true });
  }
  loadRealPracticeQuestions();

  // 2. Mode toggle: Mic vs Paste
  const pillMic = document.getElementById('pill-mode-mic');
  const pillPaste = document.getElementById('pill-mode-paste');
  const micBox = document.getElementById('delivery-mic-box');
  const pasteBox = document.getElementById('delivery-paste-box');

  if (pillMic && pillPaste) {
    on(pillMic, 'click', () => {
      pillMic.classList.add('active');
      pillPaste.classList.remove('active');
      if (micBox) micBox.style.display = 'block';
      if (pasteBox) pasteBox.style.display = 'none';
      deliveryState.captureMode = 'mic';
    });
    on(pillPaste, 'click', () => {
      pillPaste.classList.add('active');
      pillMic.classList.remove('active');
      if (micBox) micBox.style.display = 'none';
      if (pasteBox) pasteBox.style.display = 'block';
      deliveryState.captureMode = 'paste';
    });
  }

  // 3. Mic Recording Logic (stores raw audio only)
  const btnRec = document.getElementById('btn-delivery-rec');
  if (btnRec) {
    on(btnRec, 'click', toggleDeliveryRecording);
  }

  // 4. Paste Submit Logic
  const btnSubmitPaste = document.getElementById('btn-delivery-submit-paste');
  if (btnSubmitPaste) {
    on(btnSubmitPaste, 'click', submitPastedDelivery);
  }

  // 5. Progress Chart toggles & filter
  const pillChartText = document.getElementById('pill-chart-text');
  const pillChartVocal = document.getElementById('pill-chart-vocal');
  if (pillChartText && pillChartVocal) {
    on(pillChartText, 'click', () => {
      pillChartText.classList.add('active');
      pillChartVocal.classList.remove('active');
      deliveryState.activeChartType = 'text';
      renderDeliveryProgressChart();
    });
    on(pillChartVocal, 'click', () => {
      pillChartVocal.classList.add('active');
      pillChartText.classList.remove('active');
      deliveryState.activeChartType = 'vocal';
      renderDeliveryProgressChart();
    });
  }

  const filterTypeSelect = document.getElementById('delivery-filter-type');
  if (filterTypeSelect) {
    on(filterTypeSelect, 'change', () => {
      deliveryState.filterAnswerType = filterTypeSelect.value;
      loadDeliverySessions();
    });
  }

  // 6. Baseline Seeding Modal
  const btnOpenSeed = document.getElementById('btn-seed-baseline-modal');
  const modalSeed = document.getElementById('modal-seed-baseline');
  const btnCloseSeed = document.getElementById('btn-close-seed-modal');
  const btnCancelSeed = document.getElementById('btn-cancel-seed');
  const btnSubmitSeed = document.getElementById('btn-submit-baseline-upload');

  if (btnOpenSeed && modalSeed) {
    on(btnOpenSeed, 'click', () => { modalSeed.style.display = 'flex'; });
    if (btnCloseSeed) on(btnCloseSeed, 'click', () => { modalSeed.style.display = 'none'; });
    if (btnCancelSeed) on(btnCancelSeed, 'click', () => { modalSeed.style.display = 'none'; });
    if (btnSubmitSeed) on(btnSubmitSeed, 'click', submitBaselineUpload);

    const fileInput = document.getElementById('baseline-file-input');
    if (fileInput) {
      on(fileInput, 'change', renderBaselineFilesPreview);
    }
  }

  // 7. Clear Stats Button
  const btnClearStats = document.getElementById('btn-clear-delivery-stats');
  if (btnClearStats && !btnClearStats.dataset.bound) {
    btnClearStats.dataset.bound = 'true';
    on(btnClearStats, 'click', () => {
      if (!confirm('Are you sure you want to clear all delivery statistics and practice sessions? This cannot be undone.')) return;
      fetch('/api/delivery/sessions/clear', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          deliveryState.sessions = [];
          deliveryState.activeSessionId = null;
          updateDeliveryStats();
          renderDeliverySessionsTable();
          renderDeliveryProgressChart();
          renderDeliveryScorecard(null);
          showToast('Delivery statistics and sessions have been cleared.');
        })
        .catch(err => {
          showToast('Failed to clear delivery stats: ' + err.message, 'error');
        });
    });
  }

  loadDeliverySessions();
}

function toggleDeliveryRecording() {
  const btn = document.getElementById('btn-delivery-rec');
  const cdWrap = document.getElementById('delivery-countdown-wrap');
  const qAlert = document.getElementById('delivery-queue-alert');

  if (!deliveryState.isRecording) {
    // Start recording
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Microphone access not supported in this browser.', 'error');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      deliveryState.mediaRecorder = new MediaRecorder(stream);
      deliveryState.audioChunks = [];
      deliveryState.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) deliveryState.audioChunks.push(e.data);
      };
      deliveryState.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        finishDeliveryAudioUpload();
      };
      deliveryState.mediaRecorder.start();
      deliveryState.isRecording = true;
      deliveryState.recSeconds = 0;

      btn.classList.add('btn-danger');
      btn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop &amp; Queue Answer';
      if (cdWrap) cdWrap.style.display = 'block';
      if (qAlert) qAlert.style.display = 'none';
      updateDeliveryCountdownUI();

      deliveryState.recTimerInterval = setInterval(() => {
        deliveryState.recSeconds++;
        updateDeliveryCountdownUI();
      }, 1000);
    }).catch(err => {
      showToast('Microphone permission denied or unavailable.', 'error');
    });
  } else {
    // Stop recording
    deliveryState.isRecording = false;
    clearInterval(deliveryState.recTimerInterval);
    resetDeliveryHctrHighlight();
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving &amp; queuing audio...';
    if (deliveryState.mediaRecorder && deliveryState.mediaRecorder.state !== 'inactive') {
      deliveryState.mediaRecorder.stop();
    }
  }
}

function finishDeliveryAudioUpload() {
  const btn = document.getElementById('btn-delivery-rec');
  const cdWrap = document.getElementById('delivery-countdown-wrap');
  const qIn = document.getElementById('delivery-question-input');
  const qAlert = document.getElementById('delivery-queue-alert');
  const qAlertTitle = document.getElementById('delivery-queue-alert-title');
  const btnTake2 = document.getElementById('btn-delivery-take2');

  const recordedSec = deliveryState.recSeconds || 0;
  const rq = deliveryState.currentRealQ;
  const takeNum = deliveryState.currentTake || 1;

  const blob = new Blob(deliveryState.audioChunks, { type: 'audio/webm' });
  const fd = new FormData();
  fd.append('audio', blob, `rep_${deliveryState.currentDrill}_t${takeNum}_${Date.now()}.webm`);

  fetch('/api/delivery/audio', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(res => {
      if (!res.success) throw new Error(res.error || 'Audio upload failed');
      const audioPath = res.audio_path;

      const body = {
        mode: 'delivery',
        answer_type: deliveryState.currentDrill,
        question: qIn ? qIn.value.trim() : '',
        audio_path: audioPath,
        target_seconds: deliveryState.targetSeconds !== undefined ? deliveryState.targetSeconds : 120,
        duration_sec: recordedSec,
        take_number: takeNum
      };
      if (rq) {
        body.pool_type = rq.pool;
        body.source_type = rq.source || 'my_interview';
        body.source_review_id = rq.review_id;
        body.source_company = rq.company;
        body.source_role = rq.role;
        body.source_round_type = rq.round_type;
        body.past_score = rq.score;
        body.past_gaps = rq.gaps;
      }

      return fetch('/api/delivery/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    })
    .then(r => r.json())
    .then(sessRes => {
      btn.disabled = false;
      btn.classList.remove('btn-danger');
      if (cdWrap) cdWrap.style.display = 'none';
      deliveryState.lastCompletedTake = takeNum;
      deliveryState.lastRecordedSec = recordedSec;
      deliveryState.currentTake = takeNum + 1;
      deliveryState.pendingTake2 = true;
      const takeBadge = document.getElementById('delivery-take-badge');
      if (takeBadge) {
        takeBadge.textContent = `Take #${deliveryState.currentTake}`;
        takeBadge.style.background = 'rgba(245,158,11,0.18)';
        takeBadge.style.color = '#f59e0b';
      }
      updateRecButtonIdleLabel();
      renderPersistentTakeAlert(takeNum, recordedSec);
      if (rq) rq.practice_count = (rq.practice_count || 0) + 1;
      saveGymDraftState();
      updatePrepQueueStatusBadge();
      showToast(`Take #${takeNum} (${recordedSec}s) recorded & queued!`);
      loadDeliverySessions();
    })
    .catch(err => {
      btn.disabled = false;
      btn.classList.remove('btn-danger');
      updateRecButtonIdleLabel();
      showToast('Error saving audio: ' + err.message, 'error');
    });
}

function submitPastedDelivery() {
  const ta = document.getElementById('delivery-paste-transcript');
  const qIn = document.getElementById('delivery-question-input');
  const qAlert = document.getElementById('delivery-queue-alert');
  const text = (ta ? ta.value : '').trim();

  if (!text) {
    showToast('Please paste a transcript first.', 'warn');
    return;
  }

  const rq = deliveryState.currentRealQ;
  const pasteBody = {
    mode: 'delivery',
    answer_type: deliveryState.currentDrill,
    question: qIn ? qIn.value.trim() : '',
    transcript: text,
    target_seconds: deliveryState.targetSeconds !== undefined ? deliveryState.targetSeconds : 120,
    take_number: deliveryState.currentTake || 1
  };
  if (rq) {
    pasteBody.pool_type = rq.pool;
    pasteBody.source_type = rq.source || 'my_interview';
    pasteBody.source_review_id = rq.review_id;
    pasteBody.source_company = rq.company;
    pasteBody.source_role = rq.role;
    pasteBody.source_round_type = rq.round_type;
    pasteBody.past_score = rq.score;
    pasteBody.past_gaps = rq.gaps;
  }

  fetch('/api/delivery/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pasteBody)
  })
  .then(r => r.json())
  .then(res => {
    if (res.success) {
      if (ta) ta.value = '';
      const completedTake = deliveryState.currentTake || 1;
      deliveryState.lastCompletedTake = completedTake;
      deliveryState.lastRecordedSec = 0;
      deliveryState.currentTake = completedTake + 1;
      deliveryState.pendingTake2 = true;
      renderPersistentTakeAlert(completedTake, 0);
      updateRecButtonIdleLabel();
      saveGymDraftState();
      updatePrepQueueStatusBadge();
      showToast('Transcript queued for evaluation!');
      loadDeliverySessions();
    } else {
      showToast('Error: ' + res.error, 'error');
    }
  })
  .catch(err => showToast('Failed to queue transcript.', 'error'));
}

function loadDeliverySessions() {
  let url = '/api/delivery/sessions?';
  if (deliveryState.filterAnswerType) url += `answer_type=${encodeURIComponent(deliveryState.filterAnswerType)}&`;

  fetch(url)
    .then(r => r.json())
    .then(list => {
      deliveryState.sessions = Array.isArray(list) ? list : [];
      updateDeliveryStats();
      renderDeliveryProgressChart();
      renderDeliverySparklines();
      renderDeliveryHistoryTable();

      if (deliveryState.sessions.length > 0) {
        if (!deliveryState.selectedSessionId) {
          deliveryState.selectedSessionId = deliveryState.sessions[0].id;
        }
        const current = deliveryState.sessions.find(s => s.id === deliveryState.selectedSessionId) || deliveryState.sessions[0];
        renderDeliveryScorecard(current);

        // If no localStorage draft exists yet (e.g., first refresh after a Take #1), auto-resume the latest delivery question as Take #N
        if (!deliveryState.hasRestoredDraft && !deliveryState.currentRealQ) {
          const latestDel = deliveryState.sessions.find(s => s.mode === 'delivery' && s.question);
          if (latestDel) {
            deliveryState.hasRestoredDraft = true;
            const existingTakes = Math.max(1, countTakesForQuestion(latestDel.question));
            const nextTake = existingTakes + 1;
            const qKey = normalizeGymQText(latestDel.question);
            let matched = (deliveryState.realQuestions || []).find(q => normalizeGymQText(q.question) === qKey);
            if (!matched) {
              matched = {
                uid: `sess:${latestDel.id}`,
                source: 'my_interview',
                review_id: null,
                pool: (latestDel.answer_type || '').replace('_real', '') || 'hm',
                company: 'Latest Rep',
                role: '',
                round_type: latestDel.answer_type || 'Practice',
                interview_date: (latestDel.created_at || '').slice(0, 10),
                question: latestDel.question,
                score: latestDel.overall != null ? Number(latestDel.overall) : null,
                is_weak: latestDel.overall != null && Number(latestDel.overall) < 7.2,
                gaps: [],
                how_to_approach: (latestDel.result && latestDel.result.top_fix) ? latestDel.result.top_fix : '',
                model_answer: (latestDel.result && latestDel.result.opening_rewrite) ? latestDel.result.opening_rewrite : '',
                practice_count: existingTakes
              };
            }
            const pool = GYM_TAB_META[matched.pool] ? matched.pool : 'hm';
            setGymTab(pool, { preserveCap: true, skipSave: true });
            const sec = (latestDel.acoustic && latestDel.acoustic.duration_sec) ? Math.round(latestDel.acoustic.duration_sec) : 0;
            loadQuestionIntoGym(matched, {
              takeNumber: nextTake,
              pendingTake2: true,
              lastCompletedTake: existingTakes,
              lastRecordedSec: sec
            });
            renderPersistentTakeAlert(existingTakes, sec);
          }
        }
      } else {
        const empty = document.getElementById('delivery-empty-scorecard');
        const details = document.getElementById('delivery-scorecard-details');
        if (empty) empty.style.display = 'block';
        if (details) details.style.display = 'none';
      }
    })
    .catch(() => {});
}

function renderDeliveryScorecard(sess) {
  const empty = document.getElementById('delivery-empty-scorecard');
  const details = document.getElementById('delivery-scorecard-details');
  if (!sess) {
    if (empty) empty.style.display = 'block';
    if (details) details.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (details) details.style.display = 'block';

  // If session is still pending / unscored
  if (sess.overall === null || sess.overall === undefined) {
    const promptTxt = 'Process the delivery analysis queue';
    const nextTakePending = Math.max(1, countTakesForQuestion(sess.question)) + 1;
    details.innerHTML = `
      <div class="delivery-card" style="border-left:4px solid var(--primary); padding:20px;">
        <div class="scorecard-header">
          <div>
            <span class="star-chip" style="text-transform:uppercase;">${escapeHtml(sess.answer_type || 'Screen')} · Drill</span>
            <h4 style="font-size:1.05rem; font-weight:700; color:var(--text-primary); margin:6px 0 2px;">${escapeHtml(sess.question || 'Interview Question')}</h4>
            <span style="font-size:0.74rem; color:var(--text-muted);">${sess.created_at || ''}</span>
          </div>
          <span class="badge badge-queued-ai">Queued for AI Evaluation</span>
        </div>
        <div style="margin:12px 0;">
          <button type="button" class="btn btn-primary btn-sm" onclick="retryDeliverySession(${sess.id}, false)">
            <i class="fa-solid fa-rotate-right"></i> Load Take #${nextTakePending} (Same Question)
          </button>
        </div>
        <div style="margin:16px 0; font-size:0.85rem; line-height:1.5;">
          <i class="fa-solid fa-clock" style="color:var(--primary); margin-right:6px;"></i>
          <b>Answer audio stored & queued in <code>ai_jobs</code>.</b> Run this prompt in Antigravity or Claude to generate transcription, acoustic features, and Rubric v1.1 scores:
          <div class="prompt-copy-box">
            <code class="prompt-code">${promptTxt}</code>
            <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('${promptTxt}')">
              <i class="fa-solid fa-copy"></i> Copy Prompt
            </button>
          </div>
        </div>
        ${sess.audio_path ? `<div style="font-size:0.75rem; color:var(--text-muted);"><i class="fa-solid fa-file-audio"></i> Raw audio stored at: <code>${escapeHtml(sess.audio_path)}</code></div>` : ''}
      </div>
    `;
    return;
  }

  const res = sess.result || {};
  const dims = res.dims || {};
  const vocal = sess.vocal_scores || res.vocal || {};
  const acoustic = sess.acoustic || res.acoustic || {};
  const isFillerStripped = Boolean(res.filler_stripped);

  const dimKeys = [
    ['headline', 'Headline-First', 'First 1–2 sentences ARE the decision'],
    ['selection', 'Ruthless Selection', 'Cuts to the turn; no highlight-reel'],
    ['landing', 'Clean Landing', 'Ends on the result and STOPS'],
    ['structure', 'Signposting', 'Decision / tradeoff / result / learning'],
    ['confidence', 'Accurate Confidence', 'Command language calibrated to evidence'],
    ['filler', 'Filler & Disfluency', 'Clean delivery with minimal disfluencies'],
    ['metric', 'Metric Precision', 'Concrete, anchored, categorized numbers'],
    ['directness', 'Directness', 'First sentence answers the actual question']
  ];

  if (sess.answer_type === 'behavioral' || dims.pushback) {
    dimKeys.push(['pushback', 'Objection Pre-load', 'Names the obvious objection']);
  }

  const dimRows = dimKeys.map(([k, label, desc]) => {
    const d = dims[k] || { score: (sess.scores ? sess.scores[k] : 0) || 0, why: '', q: '' };
    const score = Number(d.score) || 0;
    const tierClass = score >= 7 ? 'score-tier-hi' : (score >= 4 ? 'score-tier-mid' : 'score-tier-lo');
    return `
      <div class="score-bar-row">
        <div class="score-bar-meta">
          <span style="color:var(--text-primary);">${label} <small style="font-weight:400; color:var(--text-muted);">(${desc})</small></span>
          <span class="${tierClass}">${score}/10</span>
        </div>
        <div class="score-bar-track">
          <div class="score-bar-fill ${tierClass}" style="width:${Math.min(100, score * 10)}%;"></div>
        </div>
        ${d.why ? `<div style="font-size:0.75rem; color:var(--text-secondary); margin-top:3px;">${escapeHtml(d.why)}</div>` : ''}
        ${d.q ? `<div class="dim-quote">"${escapeHtml(d.q)}"</div>` : ''}
      </div>
    `;
  }).join('');

  // Voice block HTML (if audio session)
  let voiceBlockHtml = '';
  if (vocal && vocal.dims) {
    const vDims = [
      ['pace_rhythm', 'Pace & Rhythm (130–160 WPM)', vocal.dims.pace_rhythm],
      ['pauses_command', 'Pauses & Command (<2 fillers/min)', vocal.dims.pauses_command],
      ['pitch_conviction', 'Pitch & Conviction (Steady terminals)', vocal.dims.pitch_conviction],
      ['energy_projection', 'Energy & Projection (No trailing off)', vocal.dims.energy_projection]
    ];
    const vRows = vDims.map(([vk, vLabel, vData]) => {
      const vScore = vData ? (Number(vData.score) || 0) : 0;
      const vTier = vScore >= 7 ? 'score-tier-hi' : (vScore >= 4 ? 'score-tier-mid' : 'score-tier-lo');
      return `
        <div class="score-bar-row">
          <div class="score-bar-meta">
            <span style="color:var(--text-primary);">${vLabel}</span>
            <span class="${vTier}">${vScore}/10</span>
          </div>
          <div class="score-bar-track">
            <div class="score-bar-fill ${vTier}" style="width:${Math.min(100, vScore * 10)}%;"></div>
          </div>
          ${vData && vData.why ? `<div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">${escapeHtml(vData.why)}</div>` : ''}
          ${vData && vData.evidence ? `<div style="font-size:0.72rem; color:#38bdf8; margin-top:1px;">Evidence: ${escapeHtml(vData.evidence)}</div>` : ''}
        </div>
      `;
    }).join('');

    voiceBlockHtml = `
      <div class="voice-block-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div class="voice-title"><i class="fa-solid fa-waveform-lines"></i> Vocal Acoustics & Delivery Tone</div>
          <span class="badge" style="background:rgba(56,189,248,0.15); color:#38bdf8; font-weight:700;">Vocal Overall: ${(Number(vocal.vocal_overall) || 0).toFixed(1)}/10</span>
        </div>
        ${vRows}
      </div>
    `;
  }

  // Acoustic Readout Table
  let acousticTableHtml = '';
  if (acoustic && acoustic.duration_sec) {
    acousticTableHtml = `
      <div style="margin-top:14px;">
        <div style="font-weight:700; font-size:0.78rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Objective Acoustic Telemetry</div>
        <table class="acoustic-table">
          <tr><th>Metric</th><th>Observed Value</th><th>Target Benchmark</th></tr>
          <tr><td>Speaking Pace</td><td><b>${acoustic.wpm || 0} WPM</b> (${acoustic.articulation_rate || 0} art. rate)</td><td>130–160 WPM</td></tr>
          <tr><td>Pauses</td><td>${acoustic.pause_count || 0} total · ${acoustic.long_pause_count || 0} long (>0.75s)</td><td>Ratio: ${acoustic.pause_ratio || 0}</td></tr>
          <tr><td>Filler Density</td><td><b>${acoustic.filled_pause_per_min || 0} / min</b></td><td>&lt; 2.0 / min</td></tr>
          <tr><td>Pitch Dynamics</td><td>${acoustic.pitch_mean_hz || 0} Hz (CV: ${acoustic.pitch_cv || 0}, Range: ${acoustic.pitch_range_hz || 0} Hz)</td><td>Expressive &gt;0.10</td></tr>
          <tr><td>Uptalk Ratio</td><td><b>${acoustic.uptalk_ratio || 0}</b></td><td>&lt; 0.10 (Declarative endings)</td></tr>
          <tr><td>Energy Trend</td><td>${acoustic.energy_slope_db || 0} dB/s slope · ${acoustic.sentence_end_energy_drop_db || 0} dB drop</td><td>Projection &gt; -1.0 dB</td></tr>
        </table>
      </div>
    `;
  }

  // JD Alignment block (for reps)
  let jdAlignHtml = '';
  if (res.jd_alignment) {
    const jdScore = Number(res.jd_alignment.score) || 0;
    const jdTier = jdScore >= 7 ? 'score-tier-hi' : (jdScore >= 4 ? 'score-tier-mid' : 'score-tier-lo');
    jdAlignHtml = `
      <div class="delivery-card" style="background:rgba(99,102,241,0.06); border-color:rgba(99,102,241,0.3); margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="font-weight:700; font-size:0.85rem; color:var(--primary);"><i class="fa-solid fa-bullseye"></i> JD & Role Alignment</div>
          <span class="${jdTier}" style="font-weight:800; font-size:1.1rem;">${jdScore}/10</span>
        </div>
        <p style="font-size:0.82rem; color:var(--text-primary); margin:0 0 8px;">${escapeHtml(res.jd_alignment.why || '')}</p>
        ${res.jd_alignment.misses && res.jd_alignment.misses.length ? `
          <div style="font-size:0.75rem; color:#f59e0b;"><b>Missed JD Priorities:</b> ${res.jd_alignment.misses.map(m => escapeHtml(m)).join(' · ')}</div>
        ` : ''}
      </div>
    `;
  }

  const isAudioSess = Boolean(sess.audio_path || sess.transcript_source === 'whisper' || sess.transcript_source === 'multimodal_audio');
  const existingTakeCount = Math.max(1, countTakesForQuestion(sess.question));
  const nextTakeNum = existingTakeCount + 1;

  details.innerHTML = `
    <div class="delivery-card">
      <div class="scorecard-header">
        <div>
          <span class="star-chip" style="text-transform:uppercase;">${escapeHtml(sess.answer_type || 'Screen')} · ${isAudioSess ? 'Spoken Audio' : 'Pasted'}</span>
          <h4 style="font-size:1.05rem; font-weight:700; color:var(--text-primary); margin:6px 0 2px;">${escapeHtml(sess.question || 'Interview Question')}</h4>
          <span style="font-size:0.74rem; color:var(--text-muted);">${sess.created_at || ''} ${sess.is_baseline ? '· <span style="color:#22c55e; font-weight:600;">[Baseline]</span>' : ''}</span>
        </div>
        <div class="score-circle-big">
          ${(Number(sess.overall) || 0).toFixed(1)}
          <span>Overall</span>
        </div>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
        <button type="button" class="btn btn-primary btn-sm" onclick="retryDeliverySession(${sess.id}, false)">
          <i class="fa-solid fa-rotate-right"></i> Load Take #${nextTakeNum} (Same Question)
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="retryDeliverySession(${sess.id}, true)">
          <i class="fa-solid fa-microphone"></i> Record Take #${nextTakeNum} Now
        </button>
      </div>

      ${isFillerStripped ? `
        <div style="background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.3); border-radius:var(--radius-sm); padding:8px 12px; font-size:0.75rem; color:#f59e0b; margin-bottom:14px;">
          <i class="fa-solid fa-triangle-exclamation"></i> <b>Transcript Auto-Cleaned:</b> Filler disfluencies were removed prior to analysis. The filler dimension score may not reflect spoken reality.
        </div>
      ` : ''}

      <!-- 8 Core Text Dimensions -->
      <div>
        <div style="font-weight:700; font-size:0.78rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:10px;">8 Core Text Dimensions (Rubric v1.1)</div>
        ${dimRows}
      </div>

      ${jdAlignHtml}
      ${voiceBlockHtml}
      ${acousticTableHtml}

      <!-- Top Fix & Rewrites -->
      ${res.top_fix ? `
        <div class="delivery-card" style="background:rgba(245,158,11,0.06); border-color:rgba(245,158,11,0.25); margin-top:16px;">
          <div style="font-weight:700; font-size:0.78rem; color:#f59e0b; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:4px;"><i class="fa-solid fa-wrench"></i> The Single Highest-Leverage Fix</div>
          <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary);">${escapeHtml(res.top_fix)}</div>
        </div>
      ` : ''}

      ${(res.opening_rewrite || res.landing_rewrite) ? `
        <div class="rewrites-container">
          <div style="font-weight:700; font-size:0.78rem; color:var(--primary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:10px;"><i class="fa-solid fa-pen-nib"></i> Concrete Spoken Rewrites</div>
          ${res.opening_rewrite ? `
            <div class="rewrite-label">Opening Rewrite (Headline-First):</div>
            <div class="rewrite-text">"${escapeHtml(res.opening_rewrite)}"</div>
          ` : ''}
          ${res.landing_rewrite ? `
            <div class="rewrite-label">Landing Rewrite (Clean Stop):</div>
            <div class="rewrite-text">"${escapeHtml(res.landing_rewrite)}"</div>
          ` : ''}
        </div>
      ` : ''}

      <!-- Verbatim Transcript -->
      ${sess.transcript ? `
        <div style="margin-top:16px;">
          <details style="font-size:0.8rem; color:var(--text-secondary);">
            <summary style="cursor:pointer; font-weight:600; color:var(--text-primary); margin-bottom:6px;"><i class="fa-solid fa-quote-left"></i> View Verbatim Transcript</summary>
            <div style="background:rgba(0,0,0,0.25); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:12px; line-height:1.55; white-space:pre-wrap; color:var(--text-primary); font-family:monospace; font-size:0.78rem;">${escapeHtml(sess.transcript)}</div>
          </details>
        </div>
      ` : ''}
    </div>
  `;
}

function updateDeliveryStats() {
  const sessions = deliveryState.sessions;
  const scored = sessions.filter(s => s.overall !== null && s.overall !== undefined);

  const elSessions = document.getElementById('stat-del-sessions');
  const elReps = document.getElementById('stat-del-reps');
  const elOverall = document.getElementById('stat-del-overall');
  const elTextAvg = document.getElementById('stat-del-text-avg');
  const elVocalAvg = document.getElementById('stat-del-vocal-avg');

  if (elSessions) elSessions.innerText = sessions.length;
  if (elReps) elReps.innerText = sessions.filter(s => s.mode === 'rep').length;

  if (scored.length > 0) {
    const latest = scored[0];
    if (elOverall) elOverall.innerText = (Number(latest.overall) || 0).toFixed(1);
    
    // Calculate text average
    let textScores = [];
    if (latest.scores) {
      textScores = Object.values(latest.scores).map(Number).filter(n => !isNaN(n));
    }
    const textAvg = textScores.length ? (textScores.reduce((a, b) => a + b, 0) / textScores.length).toFixed(1) : '--';
    if (elTextAvg) elTextAvg.innerText = textAvg;

    // Calculate vocal average
    const vocalAvg = latest.vocal_scores && latest.vocal_scores.vocal_overall ? Number(latest.vocal_scores.vocal_overall).toFixed(1) : '--';
    if (elVocalAvg) elVocalAvg.innerText = vocalAvg;

    // Baseline Delta Calculations
    const baselineSess = scored.find(s => s.is_baseline === 1) || scored[scored.length - 1];
    if (baselineSess && baselineSess.id !== latest.id) {
      computeBaselineCallouts(baselineSess, latest);
    }
  } else {
    if (elOverall) elOverall.innerText = '--';
    if (elTextAvg) elTextAvg.innerText = '--';
    if (elVocalAvg) elVocalAvg.innerText = '--';
  }
}

function computeBaselineCallouts(baseSess, latestSess) {
  const impEl = document.getElementById('callout-improved-text');
  const stuckEl = document.getElementById('callout-stuck-text');
  if (!impEl || !stuckEl) return;

  const baseScores = baseSess.scores || {};
  const curScores = latestSess.scores || {};

  const deltas = [];
  const dimNames = {
    headline: 'Headline-First',
    selection: 'Ruthless Selection',
    landing: 'Clean Landing',
    structure: 'Signposting',
    confidence: 'Accurate Confidence',
    filler: 'Filler & Disfluency',
    metric: 'Metric Precision',
    directness: 'Directness'
  };

  for (const [k, name] of Object.entries(dimNames)) {
    if (baseScores[k] !== undefined && curScores[k] !== undefined) {
      const delta = Number(curScores[k]) - Number(baseScores[k]);
      deltas.push({ key: k, name, delta, cur: Number(curScores[k]) });
    }
  }

  if (deltas.length > 0) {
    deltas.sort((a, b) => b.delta - a.delta);
    const topImp = deltas[0];
    if (topImp.delta > 0) {
      impEl.innerText = `${topImp.name} (+${topImp.delta.toFixed(1)} vs baseline — now ${topImp.cur}/10)`;
    } else {
      impEl.innerText = `Scores steady across all dimensions.`;
    }

    // Lowest current score or negative delta
    const lowest = [...deltas].sort((a, b) => a.cur - b.cur)[0];
    if (lowest && lowest.cur < 7) {
      stuckEl.innerText = `${lowest.name} (${lowest.cur}/10) — focus on this drill pattern next.`;
    } else {
      stuckEl.innerText = `All core dimensions performing above target (≥7/10).`;
    }
  }
}

function renderDeliveryProgressChart() {
  const canvas = document.getElementById('chart-delivery-progress');
  if (!canvas || typeof Chart === 'undefined') return;

  const scored = deliveryState.sessions
    .filter(s => s.overall !== null && s.overall !== undefined)
    .slice()
    .reverse(); // chronological

  if (scored.length === 0) {
    if (deliveryState.chartInstance) {
      deliveryState.chartInstance.destroy();
      deliveryState.chartInstance = null;
    }
    return;
  }

  const labels = scored.map((s, i) => `#${s.id} ${s.answer_type || 'Screen'}`);

  let datasets = [];
  if (deliveryState.activeChartType === 'text') {
    datasets = [
      {
        label: 'Overall Score',
        data: scored.map(s => s.overall),
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,0.15)',
        borderWidth: 3,
        tension: 0.3,
        pointRadius: 4
      },
      {
        label: 'Headline-First',
        data: scored.map(s => (s.scores ? s.scores.headline : null)),
        borderColor: '#38bdf8',
        borderWidth: 1.5,
        borderDash: [4, 4],
        tension: 0.2,
        pointRadius: 3
      },
      {
        label: 'Clean Landing',
        data: scored.map(s => (s.scores ? s.scores.landing : null)),
        borderColor: '#22c55e',
        borderWidth: 1.5,
        borderDash: [4, 4],
        tension: 0.2,
        pointRadius: 3
      },
      {
        label: 'Confidence',
        data: scored.map(s => (s.scores ? s.scores.confidence : null)),
        borderColor: '#f59e0b',
        borderWidth: 1.5,
        borderDash: [4, 4],
        tension: 0.2,
        pointRadius: 3
      }
    ];
  } else {
    datasets = [
      {
        label: 'Vocal Overall',
        data: scored.map(s => (s.vocal_scores ? s.vocal_scores.vocal_overall : null)),
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56,189,248,0.15)',
        borderWidth: 3,
        tension: 0.3,
        pointRadius: 4
      },
      {
        label: 'Pace & Rhythm',
        data: scored.map(s => (s.vocal_scores && s.vocal_scores.dims ? s.vocal_scores.dims.pace_rhythm?.score : null)),
        borderColor: '#a855f7',
        borderWidth: 1.5,
        borderDash: [4, 4],
        tension: 0.2,
        pointRadius: 3
      },
      {
        label: 'Pauses & Command',
        data: scored.map(s => (s.vocal_scores && s.vocal_scores.dims ? s.vocal_scores.dims.pauses_command?.score : null)),
        borderColor: '#22c55e',
        borderWidth: 1.5,
        borderDash: [4, 4],
        tension: 0.2,
        pointRadius: 3
      },
      {
        label: 'Energy & Projection',
        data: scored.map(s => (s.vocal_scores && s.vocal_scores.dims ? s.vocal_scores.dims.energy_projection?.score : null)),
        borderColor: '#f43f5e',
        borderWidth: 1.5,
        borderDash: [4, 4],
        tension: 0.2,
        pointRadius: 3
      }
    ];
  }

  if (deliveryState.chartInstance) {
    deliveryState.chartInstance.destroy();
  }

  deliveryState.chartInstance = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 10,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8' }
        },
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8', font: { size: 10 } }
        }
      },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: '#f8fafc', font: { size: 11 } }
        }
      }
    }
  });
}

function renderDeliverySparklines() {
  const wpmBox = document.getElementById('sparkline-wpm');
  const fillBox = document.getElementById('sparkline-fillers');

  const scored = deliveryState.sessions
    .filter(s => s.acoustic && s.acoustic.wpm)
    .slice()
    .reverse();

  if (wpmBox) {
    if (scored.length < 2) {
      wpmBox.innerHTML = '<div style="font-size:0.75rem; color:var(--text-muted); padding-top:24px;">Need ≥2 audio sessions for trend sparkline.</div>';
    } else {
      const vals = scored.map(s => Number(s.acoustic.wpm) || 0);
      wpmBox.innerHTML = buildSvgSparkline(vals, 145, 100, 200);
    }
  }

  if (fillBox) {
    if (scored.length < 2) {
      fillBox.innerHTML = '<div style="font-size:0.75rem; color:var(--text-muted); padding-top:24px;">Need ≥2 audio sessions for trend sparkline.</div>';
    } else {
      const vals = scored.map(s => Number(s.acoustic.filled_pause_per_min) || 0);
      fillBox.innerHTML = buildSvgSparkline(vals, 2.0, 0, 10);
    }
  }
}

function buildSvgSparkline(vals, targetLineVal, minVal, maxVal) {
  const w = 320, h = 60, pad = 6;
  const xs = (i) => pad + (vals.length < 2 ? w / 2 : i * (w - 2 * pad) / (vals.length - 1));
  const ys = (v) => h - pad - Math.max(0, Math.min(1, (v - minVal) / (maxVal - minVal))) * (h - 2 * pad);

  const path = vals.map((v, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ');
  const targetY = ys(targetLineVal);

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%; height:60px;">
      <line x1="${pad}" y1="${targetY.toFixed(1)}" x2="${w - pad}" y2="${targetY.toFixed(1)}" stroke="var(--text-muted)" stroke-dasharray="3 3" opacity="0.5"></line>
      <path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2"></path>
      ${vals.map((v, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(v).toFixed(1)}" r="3" fill="var(--primary)"></circle>`).join('')}
    </svg>
  `;
}

function renderDeliveryHistoryTable() {
  const container = document.getElementById('delivery-session-history-table');
  if (!container) return;

  if (deliveryState.sessions.length === 0) {
    container.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted);">No sessions recorded yet.</div>';
    return;
  }

  const rows = deliveryState.sessions.map(s => {
    const isSelected = s.id === deliveryState.selectedSessionId;
    const ov = s.overall !== null && s.overall !== undefined ? `${Number(s.overall).toFixed(1)}/10` : '<span style="color:#f59e0b;">Pending</span>';
    const voc = s.vocal_scores && s.vocal_scores.vocal_overall ? `${Number(s.vocal_scores.vocal_overall).toFixed(1)}/10` : '--';
    return `
      <tr style="cursor:pointer; background:${isSelected ? 'rgba(99,102,241,0.1)' : 'transparent'};" onclick="selectDeliverySession(${s.id})">
        <td style="font-weight:600;">#${s.id}</td>
        <td><span class="star-chip">${escapeHtml(s.answer_type || 'Screen')}</span></td>
        <td style="max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(s.question || '')}</td>
        <td><b>${ov}</b></td>
        <td>${voc}</td>
        <td style="font-size:0.75rem; color:var(--text-muted);">${s.created_at || ''}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="btn btn-secondary btn-sm" style="padding:2px 7px; font-size:0.72rem; margin-right:6px;" onclick="event.stopPropagation(); retryDeliverySession(${s.id}, false)" title="Reload this exact question for next take comparison"><i class="fa-solid fa-rotate-right"></i> Next Take</button>
          <button type="button" class="star-del" onclick="event.stopPropagation(); deleteDeliverySession(${s.id})" title="Delete session"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="acoustic-table">
      <thead>
        <tr><th>ID</th><th>Type</th><th>Question</th><th>Overall</th><th>Vocal</th><th>Date</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function selectDeliverySession(sid) {
  deliveryState.selectedSessionId = sid;
  const sess = deliveryState.sessions.find(s => s.id === sid);
  if (sess) renderDeliveryScorecard(sess);
  renderDeliveryHistoryTable();
}

function deleteDeliverySession(sid) {
  if (!confirm('Delete this delivery session?')) return;
  fetch(`/api/delivery/sessions/${sid}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(res => {
      showToast('Session deleted.');
      if (deliveryState.selectedSessionId === sid) deliveryState.selectedSessionId = null;
      loadDeliverySessions();
    })
    .catch(() => showToast('Failed to delete session.', 'error'));
}

function renderBaselineFilesPreview() {
  const input = document.getElementById('baseline-file-input');
  const preview = document.getElementById('baseline-files-preview');
  if (!input || !preview) return;

  const files = Array.from(input.files || []);
  if (files.length === 0) {
    preview.innerHTML = '';
    return;
  }

  const drillOptions = Object.keys(DRILL_QUESTIONS).map(k => `<option value="${k}">${k}</option>`).join('');

  preview.innerHTML = files.map((f, i) => `
    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:8px 12px; margin-bottom:8px;">
      <div style="font-weight:600; font-size:0.8rem; color:var(--text-primary);">${escapeHtml(f.name)} (${(f.size/1024).toFixed(0)} KB)</div>
      <div style="display:grid; grid-template-columns:140px 1fr; gap:8px; margin-top:6px;">
        <select class="baseline-tag-select star-in" style="font-size:0.75rem;">${drillOptions}</select>
        <input type="text" class="baseline-q-input star-in" placeholder="Question context..." value="${escapeHtml(DRILL_QUESTIONS.intro)}" style="font-size:0.75rem;">
      </div>
    </div>
  `).join('');
}

function submitBaselineUpload() {
  const input = document.getElementById('baseline-file-input');
  const modal = document.getElementById('modal-seed-baseline');
  const files = Array.from(input ? input.files || [] : []);

  if (files.length === 0) {
    showToast('Select at least one audio file.', 'warn');
    return;
  }

  const fd = new FormData();
  files.forEach(f => fd.append('files', f));

  const tagSelects = document.querySelectorAll('.baseline-tag-select');
  const qInputs = document.querySelectorAll('.baseline-q-input');

  tagSelects.forEach(s => fd.append('answer_types', s.value));
  qInputs.forEach(inp => fd.append('questions', inp.value));

  fetch('/api/delivery/baseline/upload', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(res => {
      if (res.success) {
        showToast(res.message || 'Baseline uploaded and queued!');
        if (modal) modal.style.display = 'none';
        loadDeliverySessions();
      } else {
        showToast('Upload failed: ' + res.error, 'error');
      }
    })
    .catch(() => showToast('Baseline upload connection error.', 'error'));
}


/* ==============================================================================
   FEATURE 2: ROLE-RELATED REPS MODULE
   ============================================================================== */

const repsState = {
  inited: false,
  roles: [],
  selectedRoleId: null,
  questions: [],
  currentQIndex: 0,
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  recTimerInterval: null,
  recSeconds: 0
};

function initRepsModule() {
  if (repsState.inited) return;
  repsState.inited = true;

  const roleSelect = document.getElementById('reps-select-role');
  if (roleSelect) {
    on(roleSelect, 'change', () => {
      repsState.selectedRoleId = roleSelect.value;
      renderRoleWorkspace(repsState.selectedRoleId);   // notes + associated interview performance
      renderPrepNextRound(repsState.selectedRoleId);   // P4: adaptive next-round panel
      if (repsState.selectedRoleId) {
        loadMockQuestions(repsState.selectedRoleId);
      } else {
        const runner = document.getElementById('reps-runner-container');
        const empty = document.getElementById('reps-empty-state');
        if (runner) runner.style.display = 'none';
        if (empty) empty.style.display = 'block';
      }
    });
  }

  const btnGen = document.getElementById('btn-generate-mock-set');
  if (btnGen) {
    on(btnGen, 'click', generateMockQuestionSet);
  }

  const btnPrev = document.getElementById('btn-reps-prev-q');
  const btnNext = document.getElementById('btn-reps-next-q');
  if (btnPrev) {
    on(btnPrev, 'click', () => {
      if (repsState.currentQIndex > 0) {
        repsState.currentQIndex--;
        renderCurrentMockQuestion();
      }
    });
  }
  if (btnNext) {
    on(btnNext, 'click', () => {
      if (repsState.currentQIndex < repsState.questions.length - 1) {
        repsState.currentQIndex++;
        renderCurrentMockQuestion();
      }
    });
  }

  const btnRec = document.getElementById('btn-reps-rec');
  if (btnRec) {
    on(btnRec, 'click', toggleRepRecording);
  }

  loadActiveRepRoles();
}

function loadActiveRepRoles() {
  // 1. Immediate in-memory population from state.applications if available
  if (Array.isArray(state.applications) && state.applications.length > 0 && repsState.roles.length === 0) {
    const activeApps = state.applications.filter(a => a.outcome !== 'Closed');
    if (activeApps.length > 0) {
      repsState.roles = activeApps.map(a => ({
        role_job_id: a.id,
        company_name: a.company,
        role_title: a.role,
        pipeline_status: a.progress || 'Submitted',
        outcome: a.outcome || 'In Progress',
        jd_notes: a.notes || '',
        source: 'application'
      }));
      populateRepRolesDropdown();
    }
  }

  // 2. Fetch full metadata from backend
  fetch('/api/delivery/reps/active-roles')
    .then(r => r.json())
    .then(list => {
      if (Array.isArray(list) && list.length > 0) {
        repsState.roles = list;
      }
      populateRepRolesDropdown();
    })
    .catch(() => {
      populateRepRolesDropdown();
    });
}

function populateRepRolesDropdown() {
  const sel = document.getElementById('reps-select-role');
  if (!sel) return;

  const apps = Array.isArray(state.applications) ? state.applications : [];
  const prev = repsState.selectedRoleId || sel.value;

  if (apps.length === 0) {
    sel.innerHTML = '<option value="">No Applications Found in Pipeline</option>';
    return;
  }

  const isInterviewedStage = (progress) => {
    if (!progress) return false;
    const p = progress.toLowerCase();
    return p.includes('sync') || p.includes('loop') || p.includes('interview');
  };

  const activeApps = apps.filter(a => a.outcome !== 'Closed');
  const closedApps = apps.filter(a => a.outcome === 'Closed' && isInterviewedStage(a.progress));

  let html = `<option value="">Select an Application (${activeApps.length} active${closedApps.length ? `, ${closedApps.length} closed with interviews` : ''})...</option>`;

  if (activeApps.length > 0) {
    html += `<optgroup label="Active Applications (${activeApps.length})">`;
    html += activeApps.map(a => `
      <option value="${a.id}" ${String(a.id) === String(prev) ? 'selected' : ''}>
        ${escapeHtml(a.company || 'Unknown')} — ${escapeHtml(a.role || a.title || 'Product Manager')} (${escapeHtml(a.progress || a.outcome || 'In Progress')})
      </option>
    `).join('');
    html += `</optgroup>`;
  }

  if (closedApps.length > 0) {
    html += `<optgroup label="Closed Applications with Interviews (${closedApps.length})">`;
    html += closedApps.map(a => `
      <option value="${a.id}" ${String(a.id) === String(prev) ? 'selected' : ''}>
        ${escapeHtml(a.company || 'Unknown')} — ${escapeHtml(a.role || a.title || 'Product Manager')} (${escapeHtml(a.progress || 'Interviewed')})
      </option>
    `).join('');
    html += `</optgroup>`;
  }

  sel.innerHTML = html;

  if (prev && apps.some(a => String(a.id) === String(prev))) {
    sel.value = prev;
    repsState.selectedRoleId = prev;
    loadMockQuestions(prev);
  }
}

function loadMockQuestions(roleJobId) {
  if (!roleJobId) {
    repsState.questions = [];
    const runner = document.getElementById('reps-runner-container');
    const empty = document.getElementById('reps-empty-state');
    if (runner) runner.style.display = 'none';
    if (empty) {
      empty.style.display = 'block';
      empty.innerHTML = `
        <i class="fa-solid fa-bullseye" style="font-size:2.5rem; color:var(--primary); margin-bottom:14px;"></i>
        <h4 style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">Select an Active Role to Start</h4>
        <p class="delivery-hint" style="max-width:480px; margin:0 auto 16px;">Choose any active application from the dropdown above to load or generate targeted hiring-manager questions grounded in its JD.</p>
      `;
    }
    return;
  }

  fetch(`/api/delivery/reps/mock-questions/${encodeURIComponent(roleJobId)}`)
    .then(r => r.json())
    .then(data => {
      repsState.questions = data.questions || [];
      const runner = document.getElementById('reps-runner-container');
      const empty = document.getElementById('reps-empty-state');

      if (repsState.questions.length > 0) {
        if (runner) runner.style.display = 'block';
        if (empty) empty.style.display = 'none';
        repsState.currentQIndex = 0;
        renderCurrentMockQuestion();
      } else {
        if (runner) runner.style.display = 'none';
        if (empty) {
          empty.style.display = 'block';
          empty.innerHTML = `
            <i class="fa-solid fa-wand-magic-sparkles" style="font-size:2.5rem; color:var(--primary); margin-bottom:14px;"></i>
            <h4 style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">No Mock Question Set Generated Yet</h4>
            <p class="delivery-hint" style="max-width:480px; margin:0 auto 16px;">Click "Generate Mock Questions" above to queue generation of 10 targeted hiring-manager questions grounded in this role's JD.</p>
          `;
        }
      }
    })
    .catch(() => {});
}

function generateMockQuestionSet() {
  const roleSelect = document.getElementById('reps-select-role');
  const roleId = (roleSelect && roleSelect.value) || repsState.selectedRoleId;
  if (!roleId) {
    showToast('Select an active application role first.', 'warn');
    return;
  }
  repsState.selectedRoleId = roleId;

  const btn = document.getElementById('btn-generate-mock-set');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Queuing Question Generation...';
  }

  fetch('/api/delivery/reps/mock-questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_job_id: roleId, regenerate: true, count: 10 })
  })
  .then(async r => {
    const res = await r.json().catch(() => ({}));
    if (!r.ok || res.error) {
      throw new Error(res.error || `Server returned ${r.status}`);
    }
    return res;
  })
  .then(res => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Mock Questions';
    }
    updatePrepQueueStatusBadge();
    if (res.cached && res.questions) {
      repsState.questions = res.questions;
      renderCurrentMockQuestion();
      showToast('Loaded cached mock question set.');
    } else {
      showToast('Question generation queued!');
      const runner = document.getElementById('reps-runner-container');
      const empty = document.getElementById('reps-empty-state');
      if (runner) runner.style.display = 'none';
      if (empty) {
        empty.style.display = 'block';
        empty.innerHTML = `
          <i class="fa-solid fa-clock" style="font-size:2.5rem; color:var(--primary); margin-bottom:14px;"></i>
          <h4 style="font-weight:700; color:var(--text-primary); margin-bottom:6px;">Mock Questions Generation Queued</h4>
          <p class="delivery-hint" style="max-width:480px; margin:0 auto 14px;">Run this prompt in Antigravity or Claude to generate the 10 role-specific HM questions:</p>
          <div class="prompt-copy-box" style="max-width:480px; margin:0 auto;">
            <code class="prompt-code">Process the role prep queue</code>
            <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('Process the role prep queue')">
              <i class="fa-solid fa-copy"></i> Copy Prompt
            </button>
          </div>
        `;
      }
    }
  })
  .catch(err => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Mock Questions';
    }
    showToast('Failed to queue mock question generation: ' + err.message, 'error');
  });
}

function renderCurrentMockQuestion() {
  const runner = document.getElementById('reps-runner-container');
  if (runner) runner.style.display = 'block';

  const q = repsState.questions[repsState.currentQIndex];
  if (!q) return;

  const counter = document.getElementById('reps-q-counter');
  const qText = document.getElementById('reps-question-text');
  const probes = document.getElementById('reps-probes-for');
  const prevBtn = document.getElementById('btn-reps-prev-q');
  const nextBtn = document.getElementById('btn-reps-next-q');
  const qAlert = document.getElementById('reps-queue-alert');

  if (counter) counter.innerText = `Question ${repsState.currentQIndex + 1} of ${repsState.questions.length}`;
  if (qText) qText.innerText = q.q || q.question || 'Question';
  if (probes) probes.innerText = q.probes_for ? `Probing for: ${q.probes_for}` : '';
  if (prevBtn) prevBtn.disabled = repsState.currentQIndex === 0;
  if (nextBtn) nextBtn.disabled = repsState.currentQIndex === repsState.questions.length - 1;
  if (qAlert) qAlert.style.display = 'none';

  loadRepScorecardForQuestion(q.q || q.question);
}

function loadRepScorecardForQuestion(questionText) {
  fetch(`/api/delivery/sessions?role_job_id=${repsState.selectedRoleId}&mode=rep`)
    .then(r => r.json())
    .then(list => {
      const scContainer = document.getElementById('reps-scorecard-details');
      if (!scContainer) return;

      const matching = (list || []).find(s => s.question === questionText);
      if (matching) {
        renderDeliveryScorecardInto(matching, scContainer);
      } else {
        scContainer.innerHTML = `
          <div class="delivery-card" style="text-align:center; padding:36px 20px;">
            <i class="fa-solid fa-clipboard-check" style="font-size:2.4rem; color:var(--text-muted); margin-bottom:12px;"></i>
            <h4 style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">Ready for Drill Rep</h4>
            <p class="delivery-hint">Record your spoken answer to receive delivery scoring, vocal telemetry, and JD alignment feedback.</p>
          </div>
        `;
      }
    });
}

function renderDeliveryScorecardInto(sess, targetEl) {
  if (!sess || !targetEl) return;
  if (sess.overall === null || sess.overall === undefined) {
    targetEl.innerHTML = `
      <div class="delivery-card" style="border-left:4px solid var(--primary); padding:20px;">
        <div class="scorecard-header">
          <div>
            <span class="star-chip" style="color:var(--primary);">Role Mock Rep</span>
            <h4 style="font-size:1.05rem; font-weight:700; color:var(--text-primary); margin:6px 0 2px;">Evaluation Pending</h4>
            <span style="font-size:0.74rem; color:var(--text-muted);">${sess.created_at || ''}</span>
          </div>
          <span class="badge badge-queued-ai">Queued in ai_jobs</span>
        </div>
        <div style="margin:14px 0; font-size:0.85rem; line-height:1.5;">
          <i class="fa-solid fa-clock" style="color:var(--primary); margin-right:6px;"></i>
          <b>Spoken answer stored & queued.</b> Run this prompt in Antigravity or Claude to generate delivery and JD alignment scores:
          <div class="prompt-copy-box">
            <code class="prompt-code">Process the role prep queue</code>
            <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('Process the role prep queue')">
              <i class="fa-solid fa-copy"></i> Copy Prompt
            </button>
          </div>
        </div>
        ${sess.audio_path ? `<div style="font-size:0.75rem; color:var(--text-muted);"><i class="fa-solid fa-file-audio"></i> Raw audio: <code>${escapeHtml(sess.audio_path)}</code></div>` : ''}
      </div>
    `;
    return;
  }

  const res = sess.result || {};
  const dims = res.dims || {};
  const jdAlign = res.jd_alignment || {};

  targetEl.innerHTML = `
    <div class="delivery-card">
      <div class="scorecard-header">
        <div>
          <span class="star-chip" style="color:var(--primary);">Role Mock Rep</span>
          <h4 style="font-size:1.05rem; font-weight:700; color:var(--text-primary); margin:6px 0 2px;">Evaluation Scorecard</h4>
        </div>
        <div class="score-circle-big">
          ${(Number(sess.overall) || 0).toFixed(1)}
          <span>Overall</span>
        </div>
      </div>

      <!-- JD Alignment -->
      <div class="delivery-card" style="background:rgba(99,102,241,0.06); border-color:rgba(99,102,241,0.3); margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span style="font-weight:700; font-size:0.85rem; color:var(--primary);"><i class="fa-solid fa-bullseye"></i> JD & Role Alignment</span>
          <span class="${Number(jdAlign.score) >= 7 ? 'score-tier-hi' : (Number(jdAlign.score) >= 4 ? 'score-tier-mid' : 'score-tier-lo')}" style="font-weight:800; font-size:1.1rem;">${Number(jdAlign.score) || 0}/10</span>
        </div>
        <p style="font-size:0.82rem; color:var(--text-primary); margin:0 0 6px;">${escapeHtml(jdAlign.why || '')}</p>
        ${jdAlign.misses && jdAlign.misses.length ? `
          <div style="font-size:0.75rem; color:#f59e0b;"><b>Misses:</b> ${jdAlign.misses.map(m => escapeHtml(m)).join(' · ')}</div>
        ` : ''}
      </div>

      <!-- Single Top Fix -->
      ${res.top_fix ? `
        <div class="delivery-card" style="background:rgba(245,158,11,0.06); border-color:rgba(245,158,11,0.25); margin-bottom:14px;">
          <div style="font-weight:700; font-size:0.76rem; color:#f59e0b; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:3px;"><i class="fa-solid fa-wrench"></i> Highest-Leverage Fix</div>
          <div style="font-size:0.82rem; font-weight:600; color:var(--text-primary);">${escapeHtml(res.top_fix)}</div>
        </div>
      ` : ''}

      <!-- Quick Text Dims -->
      <div style="font-weight:700; font-size:0.78rem; color:var(--text-muted); text-transform:uppercase; margin-bottom:8px;">Core Text Dimensions</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 14px; font-size:0.78rem;">
        <div>Headline: <b>${dims.headline ? dims.headline.score : 0}/10</b></div>
        <div>Landing: <b>${dims.landing ? dims.landing.score : 0}/10</b></div>
        <div>Confidence: <b>${dims.confidence ? dims.confidence.score : 0}/10</b></div>
        <div>Filler: <b>${dims.filler ? dims.filler.score : 0}/10</b></div>
        <div>Selection: <b>${dims.selection ? dims.selection.score : 0}/10</b></div>
        <div>Metric: <b>${dims.metric ? dims.metric.score : 0}/10</b></div>
      </div>
    </div>
  `;
}

function toggleRepRecording() {
  const btn = document.getElementById('btn-reps-rec');
  const timer = document.getElementById('reps-rec-timer');
  const q = repsState.questions[repsState.currentQIndex];
  const qAlert = document.getElementById('reps-queue-alert');

  if (!q) return;

  if (!repsState.isRecording) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Microphone access not supported.', 'error');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      repsState.audioChunks = [];
      repsState.mediaRecorder = new MediaRecorder(stream);
      repsState.mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) repsState.audioChunks.push(e.data);
      };
      repsState.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        finishRepAudioUpload();
      };
      repsState.mediaRecorder.start();
      repsState.isRecording = true;
      repsState.recSeconds = 0;

      btn.classList.add('btn-danger');
      btn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop & Queue Answer';
      if (timer) {
        timer.style.display = 'block';
        timer.innerText = '0:00';
      }
      if (qAlert) qAlert.style.display = 'none';

      repsState.recTimerInterval = setInterval(() => {
        repsState.recSeconds++;
        const m = Math.floor(repsState.recSeconds / 60);
        const s = repsState.recSeconds % 60;
        if (timer) timer.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
      }, 1000);
    }).catch(err => {
      showToast('Microphone permission denied.', 'error');
    });
  } else {
    repsState.isRecording = false;
    clearInterval(repsState.recTimerInterval);
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving raw audio...';
    if (repsState.mediaRecorder && repsState.mediaRecorder.state !== 'inactive') {
      repsState.mediaRecorder.stop();
    }
  }
}

function finishRepAudioUpload() {
  const btn = document.getElementById('btn-reps-rec');
  const timer = document.getElementById('reps-rec-timer');
  const q = repsState.questions[repsState.currentQIndex];

  const blob = new Blob(repsState.audioChunks, { type: 'audio/webm' });
  const fd = new FormData();
  fd.append('audio', blob, `rep_${repsState.selectedRoleId}_q${repsState.currentQIndex + 1}_${Date.now()}.webm`);

  fetch('/api/delivery/audio', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(res => {
      if (!res.success) throw new Error(res.error || 'Audio upload failed');
      const audioPath = res.audio_path;

      return fetch('/api/delivery/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'rep',
          answer_type: 'custom',
          role_job_id: repsState.selectedRoleId,
          question: q.q || q.question || '',
          audio_path: audioPath
        })
      });
    })
    .then(r => r.json())
    .then(sessRes => {
      btn.disabled = false;
      btn.classList.remove('btn-danger');
      btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Record Spoken Answer';
      if (timer) timer.style.display = 'none';
      updatePrepQueueStatusBadge();
      showToast('Rep answer recorded and queued!');
      loadRepScorecardForQuestion(q.q || q.question);
    })
    .catch(err => {
      btn.disabled = false;
      btn.classList.remove('btn-danger');
      btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Record Spoken Answer';
      showToast('Error saving rep audio: ' + err.message, 'error');
    });
}


// =========================================================================
// 8. REVIEW INTERVIEW PERFORMANCE MODULE
// =========================================================================

const interviewReviewState = {
  inited: false,
  activeFormat: 'audio', // 'audio' | 'text'
  selectedAudioFile: null,
  reviews: [],
  selectedReviewId: null,
  trends: null
};

function initInterviewReviewModule() {
  if (interviewReviewState.inited) {
    loadInterviewReviews();
    populateInterviewReviewRoleDropdown();
    return;
  }
  interviewReviewState.inited = true;

  // Set default date to today
  const dateIn = document.getElementById('ir-input-date');
  if (dateIn && !dateIn.value) {
    const today = new Date().toISOString().split('T')[0];
    dateIn.value = today;
  }

  // Populate active roles dropdown
  populateInterviewReviewRoleDropdown();

  // Role select change
  const roleSelect = document.getElementById('ir-select-role');
  const compBox = document.getElementById('ir-custom-company-box');
  const roleBox = document.getElementById('ir-custom-role-box');
  if (roleSelect) {
    on(roleSelect, 'change', () => {
      const isCustom = roleSelect.value === 'custom';
      if (compBox) compBox.style.display = isCustom ? 'block' : 'none';
      if (roleBox) roleBox.style.display = isCustom ? 'block' : 'none';
    });
  }

  // Format Tabs: Audio vs Text
  const btnTabAudio = document.getElementById('btn-ir-tab-audio');
  const btnTabText = document.getElementById('btn-ir-tab-text');
  const paneAudio = document.getElementById('ir-pane-audio');
  const paneText = document.getElementById('ir-pane-text');

  if (btnTabAudio && btnTabText) {
    on(btnTabAudio, 'click', () => {
      btnTabAudio.classList.add('active');
      btnTabText.classList.remove('active');
      if (paneAudio) paneAudio.style.display = 'block';
      if (paneText) paneText.style.display = 'none';
      interviewReviewState.activeFormat = 'audio';
    });
    on(btnTabText, 'click', () => {
      btnTabText.classList.add('active');
      btnTabAudio.classList.remove('active');
      if (paneAudio) paneAudio.style.display = 'none';
      if (paneText) paneText.style.display = 'block';
      interviewReviewState.activeFormat = 'text';
    });
  }

  // Audio file input & Drag-drop
  const audioInput = document.getElementById('ir-audio-file-input');
  const audioDropzone = document.getElementById('ir-audio-dropzone');
  const audioFileName = document.getElementById('ir-audio-file-name');

  if (audioInput) {
    on(audioInput, 'change', () => {
      if (audioInput.files && audioInput.files[0]) {
        interviewReviewState.selectedAudioFile = audioInput.files[0];
        if (audioFileName) {
          const f = audioInput.files[0];
          const mb = (f.size / (1024 * 1024)).toFixed(2);
          audioFileName.innerText = `Selected: ${f.name} (${mb} MB)`;
          audioFileName.style.display = 'block';
        }
      }
    });
  }

  if (audioDropzone) {
    ['dragenter', 'dragover'].forEach(eventName => {
      on(audioDropzone, eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        audioDropzone.style.borderColor = 'var(--primary)';
        audioDropzone.style.background = 'rgba(99,102,241,0.08)';
      });
    });
    ['dragleave', 'drop'].forEach(eventName => {
      on(audioDropzone, eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        audioDropzone.style.borderColor = 'var(--border-color)';
        audioDropzone.style.background = 'rgba(255,255,255,0.01)';
      });
    });
    on(audioDropzone, 'drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        interviewReviewState.selectedAudioFile = e.dataTransfer.files[0];
        if (audioFileName) {
          const f = e.dataTransfer.files[0];
          const mb = (f.size / (1024 * 1024)).toFixed(2);
          audioFileName.innerText = `Selected: ${f.name} (${mb} MB)`;
          audioFileName.style.display = 'block';
        }
      }
    });
  }

  // Transcript File input loader
  const transcriptFileInput = document.getElementById('ir-transcript-file-input');
  const transcriptTextarea = document.getElementById('ir-transcript-textarea');
  if (transcriptFileInput) {
    on(transcriptFileInput, 'change', () => {
      if (transcriptFileInput.files && transcriptFileInput.files[0]) {
        const file = transcriptFileInput.files[0];
        const reader = new FileReader();
        reader.onload = (e) => {
          if (transcriptTextarea) transcriptTextarea.value = e.target.result || '';
          showToast(`Loaded ${file.name}`);
        };
        reader.readAsText(file);
      }
    });
  }

  // Submit Button
  const btnSubmit = document.getElementById('btn-submit-interview-review');
  if (btnSubmit) {
    on(btnSubmit, 'click', submitInterviewReview);
  }

  loadInterviewReviews();
}

function populateInterviewReviewRoleDropdown() {
  const roleSelect = document.getElementById('ir-select-role');
  if (!roleSelect) return;

  const currentVal = roleSelect.value;

  const isInterviewedStage = (progress) => {
    if (!progress) return false;
    const p = progress.toLowerCase();
    return p.includes('sync') || p.includes('loop') || p.includes('interview');
  };

  const renderDropdown = (apps) => {
    roleSelect.innerHTML = `
      <option value="">Select an Application (Active or Closed)...</option>
      <option value="custom">+ Custom Company & Role</option>
    `;

    const activeApps = (apps || []).filter(a => a.outcome !== 'Closed');
    const closedApps = (apps || []).filter(a => a.outcome === 'Closed' && isInterviewedStage(a.progress));

    if (activeApps.length > 0) {
      const activeGroup = document.createElement('optgroup');
      activeGroup.label = `Active Applications (${activeApps.length})`;
      activeApps.forEach(app => {
        const opt = document.createElement('option');
        opt.value = app.id;
        opt.dataset.company = app.company || 'Unknown';
        opt.dataset.role = app.role || app.title || 'Product Manager';
        const progressLabel = app.progress ? ` (${app.progress})` : '';
        opt.innerText = `${app.company || 'Unknown'} — ${app.role || app.title || 'Product Manager'}${progressLabel}`;
        activeGroup.appendChild(opt);
      });
      roleSelect.appendChild(activeGroup);
    }

    if (closedApps.length > 0) {
      const closedGroup = document.createElement('optgroup');
      closedGroup.label = `Closed Applications with Interviews (${closedApps.length})`;
      closedApps.forEach(app => {
        const opt = document.createElement('option');
        opt.value = app.id;
        opt.dataset.company = app.company || 'Unknown';
        opt.dataset.role = app.role || app.title || 'Product Manager';
        opt.innerText = `${app.company || 'Unknown'} — ${app.role || app.title || 'Product Manager'} (${app.progress || 'Interviewed'})`;
        closedGroup.appendChild(opt);
      });
      roleSelect.appendChild(closedGroup);
    }

    if (currentVal) roleSelect.value = currentVal;
  };

  if (!state.applications || state.applications.length === 0) {
    fetch('/api/applications')
      .then(r => r.json())
      .then(rows => {
        state.applications = Array.isArray(rows) ? rows : [];
        renderDropdown(state.applications);
      })
      .catch(() => renderDropdown([]));
  } else {
    renderDropdown(state.applications);
  }
}

function submitInterviewReview() {
  const roleSelect = document.getElementById('ir-select-role');
  const customComp = document.getElementById('ir-input-company');
  const customRole = document.getElementById('ir-input-role');
  const roundSelect = document.getElementById('ir-select-round');
  const dateInput = document.getElementById('ir-input-date');
  const interviewerInput = document.getElementById('ir-input-interviewer');
  const btnSubmit = document.getElementById('btn-submit-interview-review');
  const alertBox = document.getElementById('ir-queue-alert');

  let company = '';
  let role = '';
  let roleJobId = null;

  if (roleSelect && roleSelect.value === 'custom') {
    company = (customComp ? customComp.value : '').trim();
    role = (customRole ? customRole.value : '').trim();
  } else if (roleSelect && roleSelect.value) {
    const selectedOpt = roleSelect.options[roleSelect.selectedIndex];
    company = selectedOpt.dataset.company || '';
    role = selectedOpt.dataset.role || '';
    roleJobId = roleSelect.value;
  }

  if (!company || !role) {
    showToast('Please select or specify a Company and Role.', 'error');
    return;
  }

  const round = roundSelect ? roundSelect.value : 'Hiring Manager Interview';
  const dateVal = dateInput ? dateInput.value : '';
  const interviewerVal = interviewerInput ? interviewerInput.value : '';

  if (interviewReviewState.activeFormat === 'audio') {
    const file = interviewReviewState.selectedAudioFile;
    if (!file) {
      showToast('Please choose an audio file to upload.', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('company_name', company);
    formData.append('role_title', role);
    if (roleJobId) formData.append('role_job_id', roleJobId);
    formData.append('round_type', round);
    formData.append('interview_date', dateVal);
    formData.append('interviewer_info', interviewerVal);
    formData.append('file', file);

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading & Queuing...';

    fetch('/api/interview-reviews/upload', {
      method: 'POST',
      body: formData
    })
    .then(r => r.json())
    .then(data => {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Queue Interview for Performance Evaluation';
      if (data.error) throw new Error(data.error);

      // Clear audio selection
      interviewReviewState.selectedAudioFile = null;
      const fn = document.getElementById('ir-audio-file-name');
      if (fn) fn.style.display = 'none';
      const fileIn = document.getElementById('ir-audio-file-input');
      if (fileIn) fileIn.value = '';

      updatePrepQueueStatusBadge();
      showToast('Interview audio queued for evaluation!');
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.innerHTML = `
          <div class="delivery-card" style="padding:14px;">
            <div style="font-size:0.85rem; color:var(--text-primary);">
              <i class="fa-solid fa-circle-check" style="color:#22c55e; margin-right:6px;"></i>
              <b>Interview for ${escapeHtml(company)} (${escapeHtml(round)}) queued in <code>ai_jobs</code>!</b>
              Run this prompt to generate your multidimensional evaluation scorecard:
            </div>
            <div class="prompt-copy-box">
              <code class="prompt-code">Process the interview performance review queue</code>
              <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('Process the interview performance review queue')">
                <i class="fa-solid fa-copy"></i> Copy Prompt
              </button>
            </div>
          </div>
        `;
      }
      loadInterviewReviews();
    })
    .catch(err => {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Queue Interview for Performance Evaluation';
      showToast('Error uploading interview: ' + err.message, 'error');
    });
  } else {
    // Transcript Submit
    const transcriptTextarea = document.getElementById('ir-transcript-textarea');
    const text = transcriptTextarea ? transcriptTextarea.value.trim() : '';
    if (!text) {
      showToast('Please paste or load a transcript text.', 'error');
      return;
    }

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Queuing Transcript...';

    fetch('/api/interview-reviews/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_name: company,
        role_title: role,
        role_job_id: roleJobId,
        round_type: round,
        interview_date: dateVal,
        interviewer_info: interviewerVal,
        transcript: text
      })
    })
    .then(r => r.json())
    .then(data => {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Queue Interview for Performance Evaluation';
      if (data.error) throw new Error(data.error);

      if (transcriptTextarea) transcriptTextarea.value = '';
      updatePrepQueueStatusBadge();
      showToast('Interview transcript queued for evaluation!');
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.innerHTML = `
          <div class="delivery-card" style="padding:14px;">
            <div style="font-size:0.85rem; color:var(--text-primary);">
              <i class="fa-solid fa-circle-check" style="color:#22c55e; margin-right:6px;"></i>
              <b>Interview transcript for ${escapeHtml(company)} (${escapeHtml(round)}) queued in <code>ai_jobs</code>!</b>
              Run this prompt to generate your multidimensional evaluation scorecard:
            </div>
            <div class="prompt-copy-box">
              <code class="prompt-code">Process the interview performance review queue</code>
              <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('Process the interview performance review queue')">
                <i class="fa-solid fa-copy"></i> Copy Prompt
              </button>
            </div>
          </div>
        `;
      }
      loadInterviewReviews();
    })
    .catch(err => {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Queue Interview for Performance Evaluation';
      showToast('Error submitting transcript: ' + err.message, 'error');
    });
  }
}

function loadInterviewReviews() {
  fetch('/api/interview-reviews')
    .then(r => r.json())
    .then(reviews => {
      interviewReviewState.reviews = reviews || [];
      renderInterviewReviewsList();
      populateRoleFilter();

      if (interviewReviewState.selectedReviewId) {
        const active = (interviewReviewState.reviews || []).find(r => r.id === interviewReviewState.selectedReviewId);
        if (active) {
          renderInterviewReviewScorecard(active);
        } else if (interviewReviewState.reviews.length > 0) {
          interviewReviewState.selectedReviewId = interviewReviewState.reviews[0].id;
          renderInterviewReviewScorecard(interviewReviewState.reviews[0]);
        }
      } else if (interviewReviewState.reviews.length > 0) {
        interviewReviewState.selectedReviewId = interviewReviewState.reviews[0].id;
        renderInterviewReviewsList();
        renderInterviewReviewScorecard(interviewReviewState.reviews[0]);
      } else {
        renderInterviewReviewScorecard(null);
      }
    })
    .catch(err => console.error('Error loading interview reviews:', err));

  loadInterviewTrends(currentRoleFilter);
}

// P5: load the trajectory trend, optionally filtered to one role (applications.id) and/or round type.
let currentRoleFilter = 'all';
let currentRoundTypeFilter = 'all';
function loadInterviewTrends(roleJobId, roundType) {
  if (roleJobId !== undefined && roleJobId !== null) {
    currentRoleFilter = roleJobId;
  }
  if (roundType !== undefined && roundType !== null) {
    currentRoundTypeFilter = roundType;
  }
  const roundSel = document.getElementById('ir-round-type-filter');
  if (roundSel && roundSel.value !== currentRoundTypeFilter) {
    roundSel.value = currentRoundTypeFilter;
  }
  const roleSel = document.getElementById('ir-role-filter');
  if (roleSel && roleSel.value !== currentRoleFilter) {
    roleSel.value = currentRoleFilter;
  }
  const params = [];
  if (currentRoleFilter && currentRoleFilter !== 'all') {
    params.push('role_job_id=' + encodeURIComponent(currentRoleFilter));
  }
  if (currentRoundTypeFilter && currentRoundTypeFilter !== 'all') {
    params.push('round_type=' + encodeURIComponent(currentRoundTypeFilter));
  }
  const q = params.length > 0 ? ('?' + params.join('&')) : '';
  fetch('/api/interview-reviews/trends' + q)
    .then(r => r.json())
    .then(trends => {
      interviewReviewState.trends = trends || {};
      renderInterviewTrends(trends);
      loadCoachingReport();   // reviews changed -> keep the Coaching Report in step
    })
    .catch(err => console.error('Error loading interview trends:', err));
}

// P5: fill the role filter from the loaded reviews (label = company · role).
function populateRoleFilter() {
  const sel = document.getElementById('ir-role-filter');
  if (!sel) return;
  const seen = new Map();
  (interviewReviewState.reviews || []).forEach(r => {
    const id = (r.role_job_id !== null && r.role_job_id !== undefined && r.role_job_id !== 0 && r.role_job_id !== '')
      ? String(r.role_job_id) : null;
    if (id && !seen.has(id)) seen.set(id, `${r.company_name || ''}${r.role_title ? ' · ' + r.role_title : ''}`);
  });
  const prev = sel.value || 'all';
  sel.innerHTML = '<option value="all">All roles</option>' +
    [...seen.entries()].map(([id, label]) => `<option value="${id}">${escapeHtml(label).slice(0, 58)}</option>`).join('');
  sel.value = [...seen.keys()].includes(prev) ? prev : 'all';
}

function renderInterviewReviewsList() {
  const feed = document.getElementById('ir-reviews-feed');
  const countEl = document.getElementById('ir-list-count');
  const reviews = interviewReviewState.reviews || [];

  if (countEl) countEl.innerText = reviews.length;
  if (!feed) return;

  if (reviews.length === 0) {
    feed.innerHTML = `
      <div style="text-align:center; padding:24px 10px; color:var(--text-muted); font-size:0.8rem;">
        No interviews reviewed yet. Upload audio or a transcript above.
      </div>
    `;
    return;
  }

  // --- P1: group rounds under their role (role_job_id, fallback company+role) ---
  const groupKey = (rev) => (rev.role_job_id !== null && rev.role_job_id !== undefined
      && rev.role_job_id !== 0 && rev.role_job_id !== '')
      ? 'app:' + rev.role_job_id
      : 'co:' + (rev.company_name || '') + '|' + (rev.role_title || '');
  const when = (r) => Date.parse(r.interview_date || r.created_at || '') || 0;
  const groups = new Map();
  reviews.forEach(rev => {
    const k = groupKey(rev);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(rev);
  });
  // roles ordered by their most recent round; rounds within a role read chronologically.
  const ordered = [...groups.values()].sort((a, b) =>
    Math.max(...b.map(when)) - Math.max(...a.map(when)));

  const roundCard = (rev) => {
    const isSelected = rev.id === interviewReviewState.selectedReviewId;
    const isScored = rev.overall_score !== null && rev.overall_score !== undefined;
    const s = isScored ? (Number(rev.overall_score) || 0) : null;
    const scoreVal = isScored ? s.toFixed(1) : null;
    const tierClass = s >= 7.5 ? 'score-tier-hi' : (s >= 5 ? 'score-tier-mid' : 'score-tier-lo');
    return `
      <div class="delivery-session-card ${isSelected ? 'active' : ''}" style="padding:8px 10px; cursor:pointer; background:${isSelected ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.02)'}; border:1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}; border-radius:var(--radius-sm);" onclick="selectInterviewReview(${rev.id})">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div style="font-weight:700; font-size:0.8rem; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${escapeHtml(rev.round_type || 'Round')}</div>
          ${isScored
            ? `<span class="${tierClass}" style="font-weight:800; font-size:0.8rem; white-space:nowrap;">${scoreVal}/10</span>`
            : `<span class="badge badge-queued-ai" style="font-size:0.66rem; padding:2px 7px;">Queued</span>`}
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; font-size:0.68rem; color:var(--text-muted);">
          <span>${rev.interview_date || (rev.created_at || '').split(' ')[0]}</span>
          <span><i class="fa-solid ${rev.transcript_source === 'audio_upload' ? 'fa-file-audio' : 'fa-file-lines'}"></i> ${rev.transcript_source === 'audio_upload' ? 'Audio' : 'Transcript'}</span>
        </div>
      </div>`;
  };

  feed.innerHTML = ordered.map(rounds => {
    rounds.sort((a, b) => when(a) - when(b));
    const head = rounds[0];
    const scored = rounds.map(r => Number(r.overall_score)).filter(v => !isNaN(v));
    const avg = scored.length ? (scored.reduce((x, y) => x + y, 0) / scored.length) : null;
    return `
      <div style="margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; padding:0 2px 6px;">
          <div style="min-width:0;">
            <div style="font-weight:800; font-size:0.9rem; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(head.company_name || '')}</div>
            <div style="font-size:0.72rem; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(head.role_title || '')}</div>
          </div>
          <span style="font-size:0.66rem; padding:2px 8px; white-space:nowrap; color:var(--text-secondary); background:rgba(255,255,255,0.05); border:1px solid var(--border-color); border-radius:999px;">${rounds.length} round${rounds.length > 1 ? 's' : ''}${avg != null ? ` · avg ${avg.toFixed(1)}` : ''}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; padding-left:9px; border-left:2px solid var(--border-color); margin-left:3px;">
          ${rounds.map(roundCard).join('')}
        </div>
      </div>`;
  }).join('');
}

function selectInterviewReview(id) {
  interviewReviewState.selectedReviewId = id;
  const rev = (interviewReviewState.reviews || []).find(r => r.id === id);
  if (rev) {
    renderInterviewReviewsList();
    renderInterviewReviewScorecard(rev);
  }
}

function deleteInterviewReview(id) {
  if (!confirm('Are you sure you want to delete this interview evaluation?')) return;
  fetch(`/api/interview-reviews/${id}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      showToast('Interview evaluation deleted.');
      if (interviewReviewState.selectedReviewId === id) {
        interviewReviewState.selectedReviewId = null;
      }
      loadInterviewReviews();
    })
    .catch(err => {
      showToast('Failed to delete: ' + err.message, 'error');
    });
}

// The Coaching Report is built from the scored interview reviews on every load, so a new
// evaluation shows up without anyone editing the page. `computed` (always current) fills the
// three columns until the coach-written `narrative` for the same set of reviews exists.
function loadCoachingReport() {
  const grid = document.getElementById('ir-coaching-grid');
  if (!grid) return;
  fetch('/api/interview-reviews/coaching-report')
    .then(r => r.json())
    .then(rep => {
      const c = rep.computed || {};
      const n = rep.narrative;
      const useNarrative = !!n && !rep.stale;
      const src = useNarrative ? n : c;
      const sub = document.getElementById('ir-coaching-sub');
      if (sub) {
        const latest = c.latest ? ` Latest: ${c.latest.company}, ${c.latest.round} (${c.latest.date || 'undated'}, ${c.latest.overall}).` : '';
        sub.textContent = c.review_count
          ? `Across ${c.review_count} evaluated interview${c.review_count === 1 ? '' : 's'} (${(c.companies || []).join(', ')}); average ${c.overall_avg}.${latest}`
          : 'No evaluated interviews yet. Upload a recording or transcript to start the report.';
      }
      const note = document.getElementById('ir-coaching-note');
      if (note) {
        let msg = '';
        if (rep.evaluations_pending) msg = 'An interview evaluation is still in the queue; this report updates when it finishes.';
        else if (rep.stale && rep.refresh_queued) msg = 'New evaluations are included below from the scores. The coach-written narrative is queued for a rewrite.';
        else if (useNarrative) msg = `Coach narrative written ${rep.narrative_generated_at || ''}; covers every evaluated interview.`;
        note.style.display = msg ? 'block' : 'none';
        note.style.color = (rep.stale || rep.evaluations_pending) ? '#f59e0b' : 'var(--text-muted)';
        note.textContent = msg;
      }
      const col = (title, icon, color, items, empty) => `
        <div class="longitudinal-col" style="border-left:3px solid ${color};">
          <div class="longitudinal-col-header" style="color:${color};"><i class="fa-solid ${icon}"></i> ${title}</div>
          <ul class="longitudinal-col-list">${(items && items.length)
            ? items.map(it => `<li><b>${escapeHtml(it.title || '')}:</b> ${escapeHtml(it.detail || '')}</li>`).join('')
            : `<li style="color:var(--text-muted);">${empty}</li>`}</ul>
        </div>`;
      grid.innerHTML =
        col("What You're Doing Better (Continue)", 'fa-circle-check', '#10b981', src.improving, 'No dimension has improved by 0.3 or more yet.') +
        col('Core Focus Areas (Elevate)', 'fa-compass', '#818cf8', src.focus, 'Nothing flagged.') +
        col('Identified Regressions (Autopsy)', 'fa-triangle-exclamation', '#f87171', src.regressions, 'No dimension has dropped by 0.3 or more.');
      const act = document.getElementById('ir-coaching-actions');
      if (act) {
        const items = useNarrative ? (n.next_actions || []) : [];
        act.style.display = (items.length || (useNarrative && n.headline)) ? 'block' : 'none';
        act.innerHTML = (useNarrative && n.headline ? `<div style="font-weight:700; color:var(--text-primary); margin-bottom:6px;">${escapeHtml(n.headline)}</div>` : '') +
          (items.length ? '<b>Before your next round:</b><ul style="margin:6px 0 0 18px;">' + items.map(x => `<li>${escapeHtml(x)}</li>`).join('') + '</ul>' : '');
      }
    })
    .catch(err => console.error('Error loading coaching report:', err));
}

function toggleLongitudinalSummaryModal() {
  const banner = document.getElementById('ir-longitudinal-banner');
  if (!banner) return;
  if (banner.style.display === 'none' || !banner.style.display) {
    loadCoachingReport();
    banner.style.display = 'block';
    banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    banner.style.display = 'none';
  }
}

let currentTrajectoryFilter = 'all';

function renderInterviewTrends(trends) {
  const statTotal = document.getElementById('stat-ir-total');
  const statAvg = document.getElementById('stat-ir-avg');
  const statStrongest = document.getElementById('stat-ir-strongest');
  const statStrongestSub = document.getElementById('stat-ir-strongest-sub');
  const statTopGap = document.getElementById('stat-ir-top-gap');
  const statTopGapSub = document.getElementById('stat-ir-top-gap-sub');
  const statDelta = document.getElementById('stat-ir-delta');

  if (!trends) return;

  const total = trends.total_evaluated || 0;
  if (statTotal) statTotal.innerText = `${total} Loops`;
  if (statAvg) statAvg.innerHTML = trends.overall_avg ? `${Number(trends.overall_avg).toFixed(1)} <small>/ 10</small>` : '--';

  const dimLabels = {
    product_sense: 'Strategic Product Sense',
    execution: 'Execution & Tech Depth',
    technical: 'Technical Architecture',
    leadership: 'Leadership & Stakeholders',
    communication: 'Spoken Communication',
    agility: 'Spoken Agility & Probes'
  };

  if (statStrongest) {
    const sKey = trends.strongest_dimension;
    statStrongest.innerText = sKey ? (dimLabels[sKey] || sKey) : '--';
    if (statStrongestSub) {
      const sVal = trends.dimension_averages ? trends.dimension_averages[sKey] : null;
      statStrongestSub.innerText = sVal ? `${Number(sVal).toFixed(1)} / 10 Benchmark` : 'Highest Calibrated Area';
    }
  }

  if (statTopGap) {
    const gKey = trends.top_gap_dimension;
    statTopGap.innerText = gKey ? (dimLabels[gKey] || gKey) : '--';
    if (statTopGapSub) {
      const gVal = trends.dimension_averages ? trends.dimension_averages[gKey] : null;
      statTopGapSub.innerText = gVal ? `${Number(gVal).toFixed(1)} / 10 Average` : 'Highest Leverage Opportunity';
    }
  }

  if (statDelta) {
    if (total >= 2 && trends.overall_delta !== undefined) {
      const d = Number(trends.overall_delta) || 0;
      const sign = d > 0 ? '+' : '';
      statDelta.innerHTML = `<span class="${d >= 0 ? 'badge-trend-up' : 'badge-trend-down'}"><i class="fa-solid fa-arrow-trend-${d >= 0 ? 'up' : 'down'}"></i> ${sign}${d.toFixed(1)} pts</span> vs prior round`;
    } else {
      statDelta.innerText = 'Baseline Established';
      statDelta.style.color = 'var(--text-muted)';
    }
  }

  // Render the Trendline SVG Chart
  renderTrajectoryChart(trends.timeline || [], currentTrajectoryFilter);
}

function setTrajectoryDimensionFilter(dim) {
  currentTrajectoryFilter = dim;
  const trends = interviewReviewState.trends || {};
  renderTrajectoryChart(trends.timeline || [], dim);
}

function renderTrajectoryChart(timeline, activeFilter) {
  const chartBox = document.getElementById('ir-trajectory-chart-box');
  const legendBox = document.getElementById('trajectory-legend-toggles');
  if (!chartBox) return;

  activeFilter = activeFilter || currentTrajectoryFilter || 'all';

  // Dimension Palette
  const dimDefs = [
    { key: 'overall', label: 'Overall Score', color: '#6366f1', width: 3.5 },
    { key: 'product_sense', label: 'Product Sense', color: '#3b82f6', width: 2 },
    { key: 'execution', label: 'Execution', color: '#10b981', width: 2 },
    { key: 'technical', label: 'Technical', color: '#8b5cf6', width: 2 },
    { key: 'leadership', label: 'Leadership', color: '#f59e0b', width: 2 },
    { key: 'communication', label: 'Communication', color: '#ec4899', width: 2 },
    { key: 'agility', label: 'Agility', color: '#06b6d4', width: 2 }
  ];

  // Render Toggle Pills
  if (legendBox) {
    const filterOptions = [
      { key: 'all', label: 'All Dimensions' },
      { key: 'overall', label: 'Overall Only', color: '#6366f1' },
      { key: 'product_sense', label: 'Product Sense', color: '#3b82f6' },
      { key: 'execution', label: 'Execution', color: '#10b981' },
      { key: 'technical', label: 'Technical', color: '#8b5cf6' },
      { key: 'leadership', label: 'Leadership', color: '#f59e0b' },
      { key: 'communication', label: 'Communication', color: '#ec4899' },
      { key: 'agility', label: 'Agility', color: '#06b6d4' }
    ];

    legendBox.innerHTML = filterOptions.map(opt => `
      <button type="button" class="trajectory-toggle-btn ${activeFilter === opt.key ? 'active' : ''}" onclick="setTrajectoryDimensionFilter('${opt.key}')">
        ${opt.color ? `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${opt.color}; margin-right:4px;"></span>` : ''}
        ${escapeHtml(opt.label)}
      </button>
    `).join('');
  }

  if (!timeline || timeline.length === 0) {
    chartBox.innerHTML = `
      <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:200px; color:var(--text-muted); font-size:0.82rem;">
        <i class="fa-solid fa-chart-line" style="font-size:2rem; margin-bottom:8px; opacity:0.4;"></i>
        <span>No interview evaluations to chart yet. Ingest your first interview audio or transcript below!</span>
      </div>
    `;
    return;
  }

  // Alias helper to extract values safely
  const aliases = {
    product_sense: ['product_sense', 'strategic_vision'],
    execution: ['execution', 'execution_tech_depth', 'execution_scalability'],
    technical: ['technical', 'execution_tech_depth', 'analytical_rigor', 'technical_depth'],
    leadership: ['leadership', 'leadership_influence', 'people_leadership'],
    communication: ['communication', 'executive_delivery'],
    agility: ['agility', 'probe_handling', 'customer_centricity']
  };

  const getScoreVal = (item, dimKey) => {
    if (dimKey === 'overall') return Number(item.overall_score || 0);
    const rawScores = item.scores || {};
    const scDict = rawScores.dimensions && typeof rawScores.dimensions === 'object' ? rawScores.dimensions : rawScores;
    const keysToTry = aliases[dimKey] || [dimKey];
    for (const k of keysToTry) {
      if (scDict[k] !== undefined && scDict[k] !== null) {
        const v = scDict[k];
        const val = typeof v === 'object' ? v.score : v;
        if (val !== undefined && val !== null) return Number(val) || 0;
      }
    }
    return 0;
  };

  // Dimensions of SVG
  const width = 1000;
  const height = 155;
  const padLeft = 45;
  const padRight = 50;
  const padTop = 16;
  const padBottom = 30;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  // Y-axis Scale: 6.0 to 10.0
  const yMin = 6.0;
  const yMax = 10.0;
  const getY = (val) => {
    const clamped = Math.max(yMin, Math.min(yMax, val));
    return padTop + plotHeight - ((clamped - yMin) / (yMax - yMin)) * plotHeight;
  };

  // X-axis coordinates
  const n = timeline.length;
  const getX = (idx) => {
    if (n === 1) return padLeft + plotWidth / 2;
    return padLeft + (idx / (n - 1)) * plotWidth;
  };

  // Y-axis gridlines & ticks: 6.0, 7.0, 8.0, 9.0, 10.0
  const yTicks = [6.0, 7.0, 8.0, 9.0, 10.0];
  const gridLinesHtml = yTicks.map(t => {
    const y = getY(t);
    return `
      <line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="2,2" />
      <text x="${padLeft - 8}" y="${y + 3}" class="chart-axis-tick" font-size="8.5" font-weight="500" text-anchor="end">${t.toFixed(1)}</text>
    `;
  }).join('');

  // X-axis points & labels
  const xLabelsHtml = timeline.map((item, idx) => {
    const x = getX(idx);
    const dateStr = item.interview_date || (item.created_at || '').split(' ')[0] || `Loop ${idx + 1}`;
    let prettyDate = dateStr;
    try {
      const p = new Date(dateStr + 'T00:00:00');
      if (!isNaN(p.getTime())) {
        prettyDate = p.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    } catch(e) {}

    const company = item.company_name || 'Interview';
    return `
      <line x1="${x}" y1="${padTop}" x2="${x}" y2="${height - padBottom}" stroke="currentColor" stroke-opacity="0.05" />
      <text x="${x}" y="${height - padBottom + 12}" class="chart-axis-date" font-size="9" font-weight="600" text-anchor="middle">${escapeHtml(prettyDate)}</text>
      <text x="${x}" y="${height - padBottom + 22}" class="chart-axis-company" font-size="8" font-weight="400" text-anchor="middle">${escapeHtml(company)}</text>
    `;
  }).join('');

  // Filter which dimensions to draw
  const activeDimsToDraw = activeFilter === 'all'
    ? dimDefs
    : (activeFilter === 'overall'
        ? [dimDefs[0]]
        : [dimDefs[0], dimDefs.find(d => d.key === activeFilter)].filter(Boolean));

  // Render Line Paths & Data Point Nodes
  let pathsHtml = '';
  let nodesHtml = '';

  activeDimsToDraw.forEach(dim => {
    const isOverall = dim.key === 'overall';
    const isIsolated = activeFilter === dim.key;
    const points = timeline.map((item, idx) => ({
      x: getX(idx),
      y: getY(getScoreVal(item, dim.key)),
      val: getScoreVal(item, dim.key),
      company: item.company_name,
      date: item.interview_date || item.created_at
    }));

    // Generate Path
    if (points.length > 1) {
      let pathD = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1];
        const p1 = points[i];
        const cx1 = p0.x + (p1.x - p0.x) / 2;
        const cy1 = p0.y;
        const cx2 = p0.x + (p1.x - p0.x) / 2;
        const cy2 = p1.y;
        pathD += ` C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p1.x} ${p1.y}`;
      }

      if (isOverall) {
        const areaD = `${pathD} L ${points[points.length - 1].x} ${height - padBottom} L ${points[0].x} ${height - padBottom} Z`;
        pathsHtml += `<path d="${areaD}" fill="url(#overall-grad)" opacity="0.10" />`;
      }

      pathsHtml += `
        <path d="${pathD}" fill="none" stroke="${dim.color}" stroke-width="${isOverall ? 2.8 : (isIsolated ? 2.2 : 1.6)}" stroke-linecap="round" stroke-linejoin="round" opacity="${isOverall || isIsolated ? 1 : 0.85}" />
      `;
    }

    // Nodes
    points.forEach((pt, pIdx) => {
      const radius = isOverall ? 4 : (isIsolated ? 3.5 : 2.8);
      nodesHtml += `
        <g class="chart-point-group" style="cursor:pointer;" onclick="selectInterviewReview(${timeline[pIdx].id})">
          <circle cx="${pt.x}" cy="${pt.y}" r="${radius + 1.2}" fill="var(--bg-card, #1e293b)" />
          <circle cx="${pt.x}" cy="${pt.y}" r="${radius}" fill="${dim.color}" stroke="#ffffff" stroke-width="${isOverall ? 1.2 : 0.8}" />
          ${(isOverall || isIsolated || activeFilter !== 'all') ? `
            <rect x="${pt.x - 10}" y="${pt.y - (isOverall ? 15 : 13)}" width="20" height="10.5" rx="2.5" fill="${dim.color}" />
            <text x="${pt.x}" y="${pt.y - (isOverall ? 7 : 5)}" class="chart-node-label" font-size="7.5" font-weight="700" text-anchor="middle" fill="#ffffff">${pt.val.toFixed(1)}</text>
          ` : ''}
          <title>${escapeHtml(dim.label)}: ${pt.val.toFixed(1)}/10 (${escapeHtml(pt.company)})</title>
        </g>
      `;
    });
  });

  chartBox.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; overflow:visible; font-family:var(--font-family, sans-serif);">
      <defs>
        <linearGradient id="overall-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#6366f1" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      ${gridLinesHtml}
      ${xLabelsHtml}
      ${pathsHtml}
      ${nodesHtml}
    </svg>
  `;
}

function renderInterviewReviewScorecard(rev) {
  const container = document.getElementById('ir-scorecard-container');
  if (!container) return;

  if (!rev) {
    container.innerHTML = `
      <div class="delivery-card" style="text-align:center; padding:48px 24px;">
        <i class="fa-solid fa-clipboard-user" style="font-size:2.8rem; color:var(--text-muted); margin-bottom:14px;"></i>
        <h4 style="font-weight:600; color:var(--text-primary); margin-bottom:8px;">Select an Interview or Upload a New Loop</h4>
        <p class="delivery-hint" style="max-width:480px; margin:0 auto;">Choose any evaluated interview from the left panel to inspect its full dimensional scorecard, question-by-question turn evaluation, and actionable model rewrites.</p>
      </div>
    `;
    return;
  }

  // If still queued / unscored
  if (rev.overall_score === null || rev.overall_score === undefined) {
    const promptTxt = 'Process the interview performance review queue';
    container.innerHTML = `
      <div class="delivery-card" style="border-left:4px solid var(--primary); padding:20px;">
        <div class="scorecard-header">
          <div>
            <span class="star-chip" style="text-transform:uppercase;">${escapeHtml(rev.round_type || 'Interview Loop')}</span>
            <h4 style="font-size:1.15rem; font-weight:700; color:var(--text-primary); margin:6px 0 2px;">${escapeHtml(rev.company_name)} — ${escapeHtml(rev.role_title)}</h4>
            <span style="font-size:0.75rem; color:var(--text-muted);">${rev.interview_date || rev.created_at || ''} ${rev.interviewer_info ? `· Interviewer: ${escapeHtml(rev.interviewer_info)}` : ''}</span>
          </div>
          <span class="badge badge-queued-ai">Queued for AI Review</span>
        </div>
        <div style="margin:16px 0; font-size:0.85rem; line-height:1.5;">
          <i class="fa-solid fa-clock" style="color:var(--primary); margin-right:6px;"></i>
          <b>Interview audio/transcript stored & queued in <code>ai_jobs</code>.</b> Run this prompt in Antigravity or Claude to generate your multi-dimensional evaluation scorecard:
          <div class="prompt-copy-box">
            <code class="prompt-code">${promptTxt}</code>
            <button type="button" class="btn btn-secondary btn-sm" onclick="copyPromptText('${promptTxt}')">
              <i class="fa-solid fa-copy"></i> Copy Prompt
            </button>
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:14px;">
          <button type="button" class="btn btn-secondary btn-sm" style="color:#ef4444;" onclick="deleteInterviewReview(${rev.id})">
            <i class="fa-solid fa-trash-can"></i> Delete Interview
          </button>
        </div>
      </div>
    `;
    return;
  }

  let scores = rev.scores || {};
  if (scores.dimensions && typeof scores.dimensions === 'object') {
    scores = scores.dimensions;
  }
  const questions = rev.questions || [];
  const rewrites = rev.rewrites || [];
  const acoustic = rev.acoustic || {};

  // --- v3 canonical six (same across every round type) + coach tips (P3) ---
  const V3_LABELS = {
    structure_clarity: 'Structure & Clarity',
    product_customer_sense: 'Product & Customer Sense',
    strategic_analytical: 'Strategic & Analytical Rigor',
    execution_craft: 'Execution & Craft',
    leadership_ownership: 'Leadership & Ownership',
    delivery_vocal: 'Delivery & Vocal Presence'
  };
  const v3dims = (rev.scores_v2 && rev.scores_v2.dims && typeof rev.scores_v2.dims === 'object') ? rev.scores_v2.dims : null;
  const v3lowConf = (rev.scores_v2 && Array.isArray(rev.scores_v2.low_confidence)) ? rev.scores_v2.low_confidence : [];
  if (interviewReviewState.coaches === undefined) {
    interviewReviewState.coaches = null;  // in-flight guard, fetch coach tips once
    fetch('/api/coaches').then(r => r.json()).then(cs => {
      interviewReviewState.coaches = cs || [];
      const cur = (interviewReviewState.reviews || []).find(x => x.id === interviewReviewState.selectedReviewId);
      if (cur) renderInterviewReviewScorecard(cur);
    }).catch(() => { interviewReviewState.coaches = []; });
  }

  const dimMetaMap = {
    product_sense: { label: 'Strategic Product Sense & Structuring', desc: 'Problem framing, customer segmentation, first-principles logic, vision' },
    strategic_vision: { label: 'Strategic & Product Vision', desc: 'Enterprise AI strategy, core product conviction, market alignment' },
    execution: { label: 'Execution, Metrics & Impact Landing', desc: 'North Star definition, trade-off velocity, quantifiable outcomes' },
    execution_tech_depth: { label: 'Execution & Technical Depth', desc: 'Platform primitives, shared service modularization, agentic readiness' },
    execution_scalability: { label: 'Execution & Platform Scalability', desc: 'Platform primitives, shared service modularization, velocity metrics' },
    technical: { label: 'Technical Architecture & System Acumen', desc: 'Technical depth, system design intuition, MCP framework literacy' },
    technical_depth: { label: 'Technical Depth & Agentic Ecosystem', desc: 'Technical depth, OAuth protocols, MCP scaffolding, eval harnesses' },
    leadership: { label: 'Leadership, Influence & Alignment', desc: 'Navigating pushback, cross-functional consensus, executive conviction' },
    leadership_influence: { label: 'Leadership & Stakeholder Influence', desc: 'Multi-tier developer governance, organizational alignment' },
    people_leadership: { label: 'People Leadership & Organizational Scaling', desc: 'PM mentorship, team empowerment, operational review cadence' },
    customer_centricity: { label: 'Customer Centricity & Insight', desc: 'Developer enablement, forward-deployed customer empathy' },
    analytical_rigor: { label: 'Analytical Rigor & Business Impact', desc: 'Engineering velocity metrics, ROI quantification, objective reasoning' },
    communication: { label: 'Clear, Structured & Concise Spoken Delivery', desc: 'Headline-first opening, low filler density (<2/min), and concise landing' },
    executive_delivery: { label: 'Executive Delivery & Communication', desc: 'Headline-first opening, conversational balance, concise closing' },
    voice_tone_clarity: { label: 'Voice Tonal Quality & Communication Clarity', desc: 'Pitch dynamics, monotone avoidance, declarative endings, pacing 130–160 WPM, <2.0 fillers/min' },
    delivery_vocal: { label: 'Delivery & Vocal Presence', desc: 'Pacing, pitch conviction, energy projection, two-way conversational resonance' },
    agility: { label: 'Spoken Agility & Probe Handling', desc: 'Handling interjections, follow-up probes, edge cases, dynamic redirection' }
  };

  const dimBars = Object.entries(scores)
    .filter(([k, _]) => k !== 'overall')
    .map(([k, d]) => {
      const meta = dimMetaMap[k] || { label: (d && (d.label || d.dimension_title)) || k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), desc: 'Core Senior PM Competency' };
      const displayLabel = (d && (d.label || d.dimension_title)) || meta.label;
      const rawScore = d && (d.score !== undefined ? d.score : (typeof d === 'number' ? d : null));
      // Not-probed dimensions are stored as null → render as N/A (excluded from scoring), never as 0.0.
      const isNA = rawScore === null || rawScore === undefined || rawScore === 'N/A' || isNaN(Number(rawScore));
      const score = isNA ? null : Number(rawScore);
      const tierClass = isNA ? 'score-tier-na' : (score >= 7.5 ? 'score-tier-hi' : (score >= 6.5 ? 'score-tier-mid' : 'score-tier-lo'));
      const whyText = (d && (d.why || d.feedback || d.assessment || (typeof d === 'string' ? d : ''))) || '';
      const quoteText = (d && (d.quote || d.evidence || '')) || '';

      if (isNA) {
        return `
          <div class="score-bar-row" style="opacity:0.72;">
            <div class="score-bar-meta">
              <span style="color:var(--text-secondary); font-weight:700;">${escapeHtml(displayLabel)} <small style="font-weight:400; color:var(--text-muted);">(${escapeHtml(meta.desc)})</small></span>
              <span style="font-weight:800; font-size:0.82rem; color:var(--text-muted); letter-spacing:0.02em;">N/A</span>
            </div>
            <div style="font-size:0.8rem; line-height:1.5; color:var(--text-muted); margin-top:3px; font-style:italic;">Not probed this round — excluded from the overall and the trend average.</div>
          </div>
        `;
      }

      return `
        <div class="score-bar-row">
          <div class="score-bar-meta">
            <span style="color:var(--text-primary); font-weight:700;">${escapeHtml(displayLabel)} <small style="font-weight:400; color:var(--text-secondary);">(${escapeHtml(meta.desc)})</small></span>
            <span class="${tierClass}" style="font-weight:800; font-size:0.9rem;">${score.toFixed(1)}/10</span>
          </div>
          <div class="score-bar-track">
            <div class="score-bar-fill ${tierClass}" style="width:${Math.min(100, score * 10)}%;"></div>
          </div>
          ${whyText ? `<div style="font-size:0.82rem; line-height:1.5; color:var(--text-secondary); margin-top:4px;">${escapeHtml(whyText)}</div>` : ''}
          ${quoteText ? `<div class="dim-quote">"${escapeHtml(quoteText)}"</div>` : ''}
        </div>
      `;
    }).join('');

  // Clear Communication 3-Pillar Deep Dive Component
  let commSubHtml = '';
  const commData = scores.communication || scores.executive_delivery || {};
  if (commData && (commData.sub_metrics || commData.filler_words || commData.filler_score)) {
    const sm = commData.sub_metrics || commData;
    const fScore = Number(sm.filler_score || (typeof sm.fillers === 'object' ? sm.fillers.score : 8)) || 8;
    const sScore = Number(sm.structure_score || (typeof sm.structure === 'object' ? sm.structure.score : 9)) || 9;
    const cScore = Number(sm.conciseness_score || (typeof sm.conciseness === 'object' ? sm.conciseness.score : 8.5)) || 8.5;

    const fTier = fScore >= 7.5 ? 'score-tier-hi' : (fScore >= 6.5 ? 'score-tier-mid' : 'score-tier-lo');
    const sTier = sScore >= 7.5 ? 'score-tier-hi' : (sScore >= 6.5 ? 'score-tier-mid' : 'score-tier-lo');
    const cTier = cScore >= 7.5 ? 'score-tier-hi' : (cScore >= 6.5 ? 'score-tier-mid' : 'score-tier-lo');

    let fillerPills = '';
    const fWords = sm.filler_words || (sm.fillers && sm.fillers.words) || {};
    if (fWords && typeof fWords === 'object') {
      fillerPills = Object.entries(fWords).map(([word, cnt]) => `
        <span class="filler-pill-tag"><b>"${escapeHtml(word)}"</b> ${cnt}x</span>
      `).join('');
    }

    commSubHtml = `
      <div class="comm-sub-container">
        <div class="comm-sub-header">
          <i class="fa-solid fa-bullhorn"></i> Clear & Concise Spoken Communication Diagnostics
        </div>
        <div class="comm-sub-grid">
          <!-- Pillar 1: Filler Words & Verbal Crutches -->
          <div class="comm-sub-card">
            <div class="comm-sub-title">
              <span>1. Filler Words & Crutches</span>
              <span class="comm-sub-score ${fTier}">${fScore}/10</span>
            </div>
            <div class="comm-sub-detail">
              <div><b>Density:</b> ${sm.filler_density || `${sm.filler_density_per_min || 0} / min`} · <b>Total:</b> ${sm.total_fillers || 0} words</div>
              ${fillerPills ? `<div style="margin-top:6px;">${fillerPills}</div>` : ''}
              ${sm.filler_note ? `<div style="margin-top:6px; font-size:0.76rem; color:var(--text-secondary);">${escapeHtml(sm.filler_note)}</div>` : ''}
            </div>
          </div>

          <!-- Pillar 2: Response Structuring (Headline-First) -->
          <div class="comm-sub-card">
            <div class="comm-sub-title">
              <span>2. Headline-First Structuring</span>
              <span class="comm-sub-score ${sTier}">${sScore}/10</span>
            </div>
            <div class="comm-sub-detail">
              <div><b>Opening Discipline:</b> ${sm.headline_fidelity || 'Headline-First Leading'}</div>
              ${sm.opening_quote ? `<div class="dim-quote" style="margin-top:6px; font-size:0.76rem;">"${escapeHtml(sm.opening_quote)}"</div>` : ''}
              ${sm.structure_note ? `<div style="margin-top:6px; font-size:0.76rem; color:var(--text-secondary);">${escapeHtml(sm.structure_note)}</div>` : ''}
            </div>
          </div>

          <!-- Pillar 3: Conciseness & Compression -->
          <div class="comm-sub-card">
            <div class="comm-sub-title">
              <span>3. Conciseness & Compression</span>
              <span class="comm-sub-score ${cTier}">${cScore}/10</span>
            </div>
            <div class="comm-sub-detail">
              <div><b>Word Economy:</b> ${sm.word_economy || 'Tight / High Signal'}</div>
              ${sm.conciseness_note ? `<div style="margin-top:6px; font-size:0.76rem; color:var(--text-secondary);">${escapeHtml(sm.conciseness_note)}</div>` : ''}
              ${sm.landing_note ? `<div style="margin-top:6px; font-size:0.76rem; color:#34d399;"><i class="fa-solid fa-check"></i> ${escapeHtml(sm.landing_note)}</div>` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Questions Diagnostic Accordion
  let questionsHtml = '';
  if (questions.length > 0) {
    const qCards = questions.map((q, idx) => {
      const hasScore = q.score !== null && q.score !== undefined;
      const qScore = Number(q.score) || 0;
      const qTier = qScore >= 7.5 ? 'score-tier-hi' : (qScore >= 6.5 ? 'score-tier-mid' : 'score-tier-lo');
      const scoreBadge = hasScore
        ? `<span class="diagnostic-q-score ${qTier}">${qScore.toFixed(1)}/10</span>`
        : `<span class="diagnostic-q-score" style="background:rgba(148,163,184,0.15); color:var(--text-muted); border:1px solid rgba(148,163,184,0.3); font-size:0.75rem; font-weight:600;">Unrecorded (N/A)</span>`;
      const qText = q.question_text || q.question || `Question ${idx + 1}`;
      const qExcerpt = q.candidate_excerpt || q.answer_summary || q.candidate_summary || '';
      const qStrengths = Array.isArray(q.strengths) ? q.strengths.join('; ') : (q.strengths || q.key_takeaway || '');
      const qMisses = Array.isArray(q.gaps) ? q.gaps.join('; ') : (q.growth_areas || q.misses || q.gaps || '');
      const qFeedback = q.turn_feedback || q.feedback || '';
      const qWhatTests = q.what_it_tests || q.what_tested || '';
      const qApproach = q.how_to_approach || q.approach || '';
      const qModel = q.model_answer || q.model_response || '';

      const hasFeedbackOrMisses = Boolean(qMisses || qFeedback);
      const hasCoachingOrModel = Boolean(qWhatTests || qApproach || qModel);

      return `
        <div class="diagnostic-card">
          <div class="diagnostic-header">
            <div class="diagnostic-q-title">
              <span class="diagnostic-q-num">Q${idx + 1}.</span> ${escapeHtml(qText)}
            </div>
            ${scoreBadge}
          </div>
          ${(qExcerpt && qExcerpt !== '[Unrecorded / Audio Cutoff - Evaluation N/A]') ? `
            <div class="diagnostic-summary-box">
              <i class="fa-solid fa-quote-left" style="opacity:0.5; margin-right:4px;"></i> <b>Candidate Response:</b> "${escapeHtml(qExcerpt)}"
            </div>
          ` : ''}
          ${qStrengths ? `
            <div class="diagnostic-strong">
              <i class="fa-solid fa-check"></i> <b>What Went Well:</b> ${escapeHtml(qStrengths)}
            </div>
          ` : ''}
          ${(hasFeedbackOrMisses || hasCoachingOrModel) ? `
            <div class="diagnostic-miss" style="margin-top:10px;">
              ${hasFeedbackOrMisses ? `
                <div style="font-weight:700;"><i class="fa-solid fa-triangle-exclamation"></i> Where it fell short &amp; how to fix it</div>
                <div style="margin-top:6px;">${escapeHtml(qMisses || qFeedback)}</div>
              ` : `
                <div style="font-weight:700; color:var(--primary);"><i class="fa-solid fa-lightbulb"></i> Executive Coaching &amp; Model Strategy</div>
              `}
              ${hasCoachingOrModel ? `
                <div style="margin-top:10px; padding-top:9px; border-top:1px dashed var(--border-color);">
                  ${qWhatTests ? `<div style="font-size:0.82rem; margin-bottom:6px;"><b style="color:var(--text-primary);"><i class="fa-solid fa-bullseye" style="color:var(--primary); margin-right:4px;"></i>What it tests:</b> ${escapeHtml(qWhatTests)}</div>` : ''}
                  ${qApproach ? `<div style="font-size:0.82rem; margin-bottom:6px;"><b style="color:var(--text-primary);"><i class="fa-solid fa-diagram-project" style="color:var(--primary); margin-right:4px;"></i>How to approach it:</b> ${escapeHtml(qApproach)}</div>` : ''}
                  ${qModel ? `<div style="font-size:0.82rem;"><b style="color:var(--text-primary);"><i class="fa-solid fa-comment-dots" style="color:var(--primary); margin-right:4px;"></i>Model answer:</b> <div style="margin-top:4px; font-style:italic; line-height:1.5; white-space:pre-wrap; background:rgba(99,102,241,0.04); padding:8px 12px; border-radius:6px; border-left:3px solid var(--primary);">${escapeHtml(qModel)}</div></div>` : ''}
                </div>
              ` : ''}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    questionsHtml = `
      <div style="margin-top:24px;">
        <div style="font-weight:700; font-size:0.86rem; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:12px;">
          <i class="fa-solid fa-list-check" style="color:var(--primary); margin-right:6px;"></i> Question-by-Question Turn Diagnostic (${questions.length} Questions Evaluated)
        </div>
        ${qCards}
      </div>
    `;
  }

  // Executive What Went Well vs What Could Be Done Better Summary Card
  let execSummaryHtml = '';
  if (scores && Object.keys(scores).length > 0) {
    const sortedDims = Object.entries(scores)
      .filter(([k, d]) => k !== 'overall' && d && (d.score !== undefined || typeof d === 'number'))
      .sort((a, b) => (Number(b[1].score !== undefined ? b[1].score : b[1]) - Number(a[1].score !== undefined ? a[1].score : a[1])));

    const topDims = sortedDims.slice(0, 2);
    const bottomDims = sortedDims.slice(-2).reverse();

    const allStrengths = [];
    const allMisses = [];
    // strengths/gaps may arrive as an array, an object map, or a string; normalize to a list.
    const toList = (x) => Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : (x ? [x] : []));
    toList(rev.strengths).forEach(s => {
      allStrengths.push(s && typeof s === 'object' ? `${s.title || ''}: ${s.detail || ''}` : s);
    });
    toList(rev.gaps).forEach(g => {
      allMisses.push(g && typeof g === 'object' ? `${g.title || ''}: ${g.detail || ''}` : g);
    });

    if (!allStrengths.length || !allMisses.length) {
      (questions || []).forEach(q => {
        if (q.strengths && !allStrengths.includes(q.strengths)) allStrengths.push(q.strengths);
        const m = q.growth_areas || q.misses || q.gaps;
        if (m && !allMisses.includes(m)) allMisses.push(m);
      });
    }

    execSummaryHtml = `
      <div class="delivery-card ir-exec-summary-card" style="margin-top:20px; padding:18px 20px;">
        <div style="font-weight:700; font-size:0.88rem; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:14px; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-clipboard-check" style="color:var(--primary);"></i> Interview Executive Summary & Key Dimension Takeaways
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
          <!-- What Went Well -->
          <div class="summary-sub-card summary-card-well">
            <div class="summary-sub-header text-emerald">
              <i class="fa-solid fa-circle-check"></i> <b>What Went Well</b>
            </div>
            <div class="summary-dim-pills">
              ${topDims.map(([k, d]) => {
                const label = (d && (d.label || d.dimension_title)) || (dimMetaMap[k] ? dimMetaMap[k].label : k);
                const sVal = Number(d && (d.score !== undefined ? d.score : (typeof d === 'number' ? d : 0))) || 0;
                return `<span class="summary-dim-pill pill-well"><b>${escapeHtml(label)}:</b> ${sVal.toFixed(1)}/10</span>`;
              }).join('')}
            </div>
            <ul class="summary-bullet-list">
              ${allStrengths.slice(0, 3).map(s => `<li>${escapeHtml(s)}</li>`).join('')}
            </ul>
          </div>

          <!-- What Could Be Done Better -->
          <div class="summary-sub-card summary-card-better">
            <div class="summary-sub-header text-amber">
              <i class="fa-solid fa-triangle-exclamation"></i> <b>What You Could Do Better</b>
            </div>
            <div class="summary-dim-pills">
              ${bottomDims.map(([k, d]) => {
                const label = (d && (d.label || d.dimension_title)) || (dimMetaMap[k] ? dimMetaMap[k].label : k);
                const sVal = Number(d && (d.score !== undefined ? d.score : (typeof d === 'number' ? d : 0))) || 0;
                return `<span class="summary-dim-pill pill-better"><b>${escapeHtml(label)}:</b> ${sVal.toFixed(1)}/10</span>`;
              }).join('')}
            </div>
            <ul class="summary-bullet-list">
              ${allMisses.slice(0, 3).map(m => `<li>${escapeHtml(m)}</li>`).join('')}
            </ul>
          </div>
        </div>
      </div>
    `;
  }

  // The One Fix
  let topFixHtml = '';
  if (rev.the_one_fix) {
    topFixHtml = `
      <div class="delivery-card" style="background:rgba(245,158,11,0.08); border-color:rgba(245,158,11,0.4); margin-top:18px;">
        <div style="font-weight:700; font-size:0.82rem; color:#fbbf24; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px;">
          <i class="fa-solid fa-wrench"></i> The Single Highest-Leverage Fix
        </div>
        <div style="font-size:0.88rem; line-height:1.5; font-weight:600; color:var(--text-primary);">${escapeHtml(rev.the_one_fix)}</div>
      </div>
    `;
  }

  // --- v3 six-dimension strip (P3): the same six for every round, for cross-round tracking ---
  let v3StripHtml = '';
  if (v3dims) {
    const bars = Object.keys(V3_LABELS).map(k => {
      const v = v3dims[k];
      const s = (typeof v === 'number') ? v : null;
      const tier = s == null ? 'score-tier-mid' : (s >= 7.5 ? 'score-tier-hi' : (s >= 6.5 ? 'score-tier-mid' : 'score-tier-lo'));
      const lc = v3lowConf.includes(k) ? ' <span title="low confidence: needs an acoustic pass on the audio" style="color:var(--text-muted);">&#9702;</span>' : '';
      return `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
          <span style="flex:0 0 42%; font-size:0.76rem; color:var(--text-secondary);">${V3_LABELS[k]}${lc}</span>
          <span style="flex:1; height:6px; background:rgba(255,255,255,0.06); border-radius:99px; overflow:hidden;"><span style="display:block; height:100%; width:${s == null ? 0 : Math.min(100, s * 10)}%; border-radius:99px;" class="score-bar-fill ${tier}"></span></span>
          <span class="${tier}" style="flex:0 0 34px; text-align:right; font-weight:700; font-size:0.76rem;">${s == null ? '&mdash;' : s.toFixed(1)}</span>
        </div>`;
    }).join('');
    v3StripHtml = `
      <div class="delivery-card" style="margin-top:14px;">
        <div style="font-weight:700; font-size:0.78rem; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:10px;">Unified Six (v3) &middot; tracked across every round</div>
        ${bars}
      </div>`;
  }

  // --- Coach's Corner (P3): matched coach + resource for the weakest v3 dimension ---
  let coachCornerHtml = '';
  const _coaches = interviewReviewState.coaches;
  if (v3dims && Array.isArray(_coaches) && _coaches.length) {
    const entries = Object.entries(v3dims).filter(([_, v]) => typeof v === 'number');
    if (entries.length) {
      entries.sort((a, b) => a[1] - b[1]);
      const weakKey = entries[0][0], weakVal = entries[0][1];
      const label = V3_LABELS[weakKey];
      const matched = _coaches.filter(c => (c.dimensions || []).some(d => String(d).toLowerCase() === label.toLowerCase())).slice(0, 2);
      if (matched.length) {
        const cards = matched.map(c => {
          const res = (c.resources || [])[0];
          const link = res && res.url ? `<a href="${escapeAttr(res.url)}" target="_blank" rel="noopener" style="color:var(--primary); font-weight:600;">${res.type === 'video' ? '&#9655; Watch' : '&#9636; Read'}: ${escapeHtml(res.title || 'resource')}</a>` : '';
          return `
            <div style="margin-top:8px;">
              <div style="font-size:0.82rem; color:var(--text-primary);"><b>${escapeHtml(c.name)}</b> <span style="color:var(--text-muted); font-size:0.74rem;">${escapeHtml(c.credibility || '')}</span></div>
              ${c.when_weak ? `<div style="font-size:0.82rem; color:var(--text-secondary); margin-top:2px;">${escapeHtml(c.when_weak)}</div>` : ''}
              ${link ? `<div style="font-size:0.8rem; margin-top:3px;">${link}</div>` : ''}
            </div>`;
        }).join('');
        coachCornerHtml = `
          <div class="delivery-card" style="margin-top:14px; border-color:rgba(99,102,241,0.4); background:rgba(99,102,241,0.06);">
            <div style="font-weight:700; font-size:0.8rem; color:#c7d2fe; text-transform:uppercase; letter-spacing:0.04em;">
              <i class="fa-solid fa-chalkboard-user"></i> Coach's corner &middot; ${escapeHtml(label)} (${weakVal.toFixed(1)}, your weakest)
            </div>
            ${cards}
          </div>`;
      }
    }
  }

  // Model Rewrites
  let rewritesHtml = '';
  if (rewrites && rewrites.length > 0) {
    const rwItems = rewrites.map(rw => `
      <div class="rewrite-item-card">
        <div class="rewrite-label">${escapeHtml(rw.title || rw.label || rw.question || 'Target Question')}:</div>
        ${rw.context ? `<div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:6px; font-style:italic;">${escapeHtml(rw.context)}</div>` : ''}
        <div class="rewrite-text">"${escapeHtml(rw.coached_rewrite || rw.model_script || rw.rewrite || rw.model_answer || '')}"</div>
        ${rw.rationale ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:6px;"><i class="fa-solid fa-lightbulb" style="color:var(--primary); margin-right:4px;"></i><b>Coach Rationale:</b> ${escapeHtml(rw.rationale)}</div>` : ''}
      </div>
    `).join('');

    rewritesHtml = `
      <div class="rewrites-container">
        <div class="rewrites-title">
          <i class="fa-solid fa-pen-nib"></i> Actionable Spoken Rewrites
        </div>
        ${rwItems}
      </div>
    `;
  }

  // Acoustic Readout Table
  let acousticHtml = '';
  if (acoustic && acoustic.duration_sec) {
    acousticHtml = `
      <div style="margin-top:18px;">
        <div style="font-weight:700; font-size:0.82rem; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">Objective Vocal Acoustic Telemetry</div>
        <table class="acoustic-table">
          <tr><th>Metric</th><th>Observed Value</th><th>Target Benchmark</th></tr>
          <tr><td>Speaking Pace</td><td><b>${acoustic.wpm || 0} WPM</b> (${acoustic.articulation_rate || 0} art. rate)</td><td>130–160 WPM</td></tr>
          <tr><td>Pauses</td><td>${acoustic.pause_count || 0} total · ${acoustic.long_pause_count || 0} long (>0.75s)</td><td>Ratio: ${acoustic.pause_ratio || 0}</td></tr>
          <tr><td>Filler Density</td><td><b>${acoustic.filled_pause_per_min || 0} / min</b></td><td>&lt; 2.0 / min</td></tr>
        </table>
      </div>
    `;
  }

  // Structured Dialogue Transcript. Prefer a cleaned, properly-diarized structured_transcript
  // (turn-by-turn, real speaker alternation) when one exists; the raw `transcript` from the
  // audio pass is kept for the "Raw Text" toggle and as the fallback source.
  let transcriptHtml = '';
  if (rev.transcript) {
    const structuredSource = (rev.structured_transcript && rev.structured_transcript.trim())
        ? rev.structured_transcript
        : rev.transcript;
    const structuredTurns = parseTranscriptIntoTurns(structuredSource, rev.interviewer_info);
    
    // Calculate aggregate speaking duration telemetry
    let totalCandSec = 0;
    let totalIntSec = 0;
    let totalCandWords = 0;
    let totalIntWords = 0;
    let candTurnCount = 0;
    let intTurnCount = 0;

    structuredTurns.forEach(t => {
      if (t.speaker === 'candidate') {
        totalCandSec += (t.durationSec || 0);
        totalCandWords += (t.words || 0);
        candTurnCount++;
      } else {
        totalIntSec += (t.durationSec || 0);
        totalIntWords += (t.words || 0);
        intTurnCount++;
      }
    });

    const totalCallSec = Math.max(1, totalCandSec + totalIntSec);
    const candPct = Math.round((totalCandSec / totalCallSec) * 100);
    const intPct = 100 - candPct;
    const avgCandTurn = candTurnCount > 0 ? formatTelemetryDuration(totalCandSec / candTurnCount) : '--';
    const avgIntTurn = intTurnCount > 0 ? formatTelemetryDuration(totalIntSec / intTurnCount) : '--';

    const turnsHtml = structuredTurns.map(t => {
      const isInterviewer = t.speaker === 'interviewer';
      const icon = isInterviewer ? 'fa-user-tie' : 'fa-user';
      return `
        <div class="transcript-turn ${isInterviewer ? 'interviewer' : 'candidate'}">
          <div class="transcript-turn-header">
            <span class="transcript-speaker-badge ${isInterviewer ? 'interviewer' : 'candidate'}">
              <i class="fa-solid ${icon}"></i> ${escapeHtml(t.speakerName)}
            </span>
            <div class="transcript-turn-timing">
              ${t.timestampRange ? `<span class="turn-timestamp-range"><i class="fa-regular fa-clock"></i> ${escapeHtml(t.timestampRange)}</span>` : ''}
              ${t.durationFormatted ? `
                <span class="turn-duration-badge ${isInterviewer ? 'interviewer' : 'candidate'}">
                  <i class="fa-solid fa-stopwatch"></i> ${escapeHtml(t.durationFormatted)}
                  <small>(${t.words} words${t.wpm ? ` · ${t.wpm} WPM` : ''})</small>
                </span>
              ` : ''}
            </div>
          </div>
          <div class="transcript-turn-body">${escapeHtml(t.text)}</div>
        </div>
      `;
    }).join('');

    transcriptHtml = `
      <div class="transcript-container" id="transcript-container-${rev.id}">
        <div class="transcript-header">
          <div class="transcript-title">
            <i class="fa-solid fa-comments" style="color:var(--primary);"></i>
            <span>Interview Transcript & Dialogue Timeline</span>
          </div>
          <div class="transcript-toolbar">
            <div class="pill-group" style="display:flex; gap:4px;">
              <button type="button" class="pill active" id="btn-transcript-mode-struct-${rev.id}" onclick="setTranscriptViewMode(${rev.id}, 'structured')">
                <i class="fa-solid fa-table-list"></i> Structured Dialogue
              </button>
              <button type="button" class="pill" id="btn-transcript-mode-raw-${rev.id}" onclick="setTranscriptViewMode(${rev.id}, 'raw')">
                <i class="fa-solid fa-code"></i> Raw Text
              </button>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" onclick="copyReviewTranscript(${rev.id})" title="Copy entire transcript">
              <i class="fa-solid fa-copy"></i> Copy
            </button>
          </div>
        </div>

        <!-- Dialogue Participation & Speaking Time Strip -->
        <div class="dialogue-telemetry-strip">
          <div class="dialogue-telemetry-card candidate">
            <div class="telemetry-card-top">
              <span class="telemetry-badge candidate"><i class="fa-solid fa-microphone"></i> Your Speaking Time</span>
              <span class="telemetry-pct">${candPct}% of Call</span>
            </div>
            <div class="telemetry-main-val">${formatTelemetryDuration(totalCandSec)}</div>
            <div class="telemetry-sub-meta">${candTurnCount} Turns · Avg ${avgCandTurn} / turn · ${totalCandWords} words</div>
            <div class="telemetry-progress-track">
              <div class="telemetry-progress-fill candidate" style="width: ${candPct}%;"></div>
            </div>
          </div>

          <div class="dialogue-telemetry-card interviewer">
            <div class="telemetry-card-top">
              <span class="telemetry-badge interviewer"><i class="fa-solid fa-user-tie"></i> Interviewer Speaking Time</span>
              <span class="telemetry-pct">${intPct}% of Call</span>
            </div>
            <div class="telemetry-main-val">${formatTelemetryDuration(totalIntSec)}</div>
            <div class="telemetry-sub-meta">${intTurnCount} Turns · Avg ${avgIntTurn} / turn · ${totalIntWords} words</div>
            <div class="telemetry-progress-track">
              <div class="telemetry-progress-fill interviewer" style="width: ${intPct}%;"></div>
            </div>
          </div>
        </div>

        <div id="transcript-structured-view-${rev.id}" class="transcript-timeline">
          ${turnsHtml}
        </div>
        <div id="transcript-raw-view-${rev.id}" class="transcript-raw-view" style="display:none;">${escapeHtml(rev.transcript)}</div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="delivery-card">
      <div class="scorecard-header">
        <div>
          <span class="star-chip" style="text-transform:uppercase;">${escapeHtml(rev.round_type || 'Interview Loop')} · ${rev.transcript_source === 'audio_upload' ? 'Spoken Audio' : 'Transcript'}</span>
          <h4 style="font-size:1.2rem; font-weight:700; color:var(--text-primary); margin:6px 0 2px;">${escapeHtml(rev.company_name)} — ${escapeHtml(rev.role_title)}</h4>
          <span style="font-size:0.78rem; color:var(--text-secondary);">${rev.interview_date || rev.created_at || ''} ${rev.interviewer_info ? `· Interviewer: ${escapeHtml(rev.interviewer_info)}` : ''}</span>
        </div>
        <div class="score-circle-big">
          ${(Number(rev.overall_score) || 0).toFixed(1)}
          <span>Overall</span>
        </div>
      </div>

      <!-- 6 Core PM Dimensions -->
      <div>
        <div style="font-weight:700; font-size:0.82rem; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:12px;">6 Core Senior PM Dimensions (Rubric ${escapeHtml(rev.rubric_version || 'v2.0')})</div>
        ${dimBars}
      </div>

      ${v3StripHtml}
      ${commSubHtml}
      ${execSummaryHtml}
      ${topFixHtml}
      ${coachCornerHtml}
      ${rewritesHtml}
      ${questionsHtml}
      ${acousticHtml}
      ${transcriptHtml}

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:22px;">
        <button type="button" class="btn btn-secondary btn-sm" style="color:#ef4444;" onclick="deleteInterviewReview(${rev.id})">
          <i class="fa-solid fa-trash-can"></i> Delete Interview
        </button>
      </div>
    </div>
  `;
}

function formatTelemetryDuration(sec) {
  if (!sec || isNaN(sec)) return '0s';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m > 0) {
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${s}s`;
}

function parseTranscriptIntoTurns(rawText, interviewerInfo) {
  if (!rawText) return [];
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const turns = [];
  let currentSpeaker = 'interviewer';
  let currentSpeakerName = interviewerInfo || 'Interviewer';
  let currentTimestampRange = '';
  let currentStartSec = null;
  let currentEndSec = null;
  let currentText = [];

  const interviewerKeywords = ['interviewer', 'recruiter', 'eric', 'celeste', 'sarah', 'rachel', 'oscar', 'hiring manager', 'hm', 'lead', 'vp'];
  if (interviewerInfo) {
    interviewerKeywords.push(interviewerInfo.toLowerCase());
  }

  // Regex matches:
  // [07:45 - 14:40] Interviewer (Oscar Ruiz (VP of Product)): text
  // [07:45] Candidate: text
  // Interviewer (Sarah (Recruiter)): text
  const speakerRegex = /^(?:\[?(\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?)\]?\s*)?(Interviewer[^\n:]*|Candidate[^\n:]*|You|Me|Speaker\s*\d+|[A-Za-z0-9_\s\(\)\/.-]+?)\s*:\s*(.*)$/i;

  function parseSec(tsStr) {
    if (!tsStr) return null;
    const parts = tsStr.split(':').map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return parts[0] * 60 + parts[1];
    }
    return null;
  }

  for (const line of lines) {
    const match = line.match(speakerRegex);
    if (match) {
      if (currentText.length > 0) {
        const fullText = currentText.join(' ');
        const words = fullText.split(/\s+/).filter(Boolean).length;
        let durSec = (currentEndSec !== null && currentStartSec !== null && currentEndSec >= currentStartSec)
          ? (currentEndSec - currentStartSec)
          : Math.max(5, Math.round(words / 2.3)); // estimate ~140 WPM fallback

        turns.push({
          speaker: currentSpeaker,
          speakerName: currentSpeakerName,
          timestampRange: currentTimestampRange,
          startSec: currentStartSec,
          endSec: currentEndSec,
          durationSec: durSec,
          durationFormatted: formatTelemetryDuration(durSec),
          words: words,
          wpm: durSec > 0 ? Math.round(words / (durSec / 60)) : 0,
          text: fullText
        });
        currentText = [];
      }

      const rawTs = (match[1] || '').trim();
      currentTimestampRange = rawTs;
      if (rawTs.includes('-') || rawTs.includes('–')) {
        const parts = rawTs.split(/[-–]/).map(s => s.trim());
        currentStartSec = parseSec(parts[0]);
        currentEndSec = parseSec(parts[1]);
      } else if (rawTs) {
        currentStartSec = parseSec(rawTs);
        currentEndSec = null;
      } else {
        currentStartSec = null;
        currentEndSec = null;
      }

      const rawSpeaker = (match[2] || '').trim();
      const content = (match[3] || '').trim();

      const lowerSpeaker = rawSpeaker.toLowerCase();
      if (lowerSpeaker.includes('candidate') || lowerSpeaker === 'you' || lowerSpeaker === 'me') {
        currentSpeaker = 'candidate';
        currentSpeakerName = 'Candidate';
      } else if (interviewerKeywords.some(kw => lowerSpeaker.includes(kw)) || lowerSpeaker.includes('interviewer') || (interviewerInfo && lowerSpeaker.includes(interviewerInfo.toLowerCase()))) {
        currentSpeaker = 'interviewer';
        currentSpeakerName = rawSpeaker.includes('(') ? rawSpeaker : `Interviewer (${rawSpeaker})`;
      } else {
        currentSpeaker = rawSpeaker.startsWith('Speaker 1') ? 'interviewer' : 'candidate';
        currentSpeakerName = rawSpeaker;
      }

      if (content) currentText.push(content);
    } else {
      currentText.push(line);
    }
  }

  if (currentText.length > 0) {
    const fullText = currentText.join(' ');
    const words = fullText.split(/\s+/).filter(Boolean).length;
    let durSec = (currentEndSec !== null && currentStartSec !== null && currentEndSec >= currentStartSec)
      ? (currentEndSec - currentStartSec)
      : Math.max(5, Math.round(words / 2.3));

    turns.push({
      speaker: currentSpeaker,
      speakerName: currentSpeakerName,
      timestampRange: currentTimestampRange,
      startSec: currentStartSec,
      endSec: currentEndSec,
      durationSec: durSec,
      durationFormatted: formatTelemetryDuration(durSec),
      words: words,
      wpm: durSec > 0 ? Math.round(words / (durSec / 60)) : 0,
      text: fullText
    });
  }

  // If no turns found, parse by paragraphs
  if (turns.length === 0 && rawText.trim()) {
    const paras = rawText.split(/\n\n+/).filter(Boolean);
    return paras.map((p, i) => {
      const words = p.split(/\s+/).filter(Boolean).length;
      const durSec = Math.max(5, Math.round(words / 2.3));
      return {
        speaker: i % 2 === 0 ? 'interviewer' : 'candidate',
        speakerName: i % 2 === 0 ? (interviewerInfo || 'Interviewer') : 'Candidate',
        timestampRange: '',
        startSec: 0,
        endSec: durSec,
        durationSec: durSec,
        durationFormatted: formatTelemetryDuration(durSec),
        words: words,
        wpm: 140,
        text: p.trim()
      };
    });
  }

  return turns;
}

window.setTranscriptViewMode = function(revId, mode) {
  const structEl = document.getElementById(`transcript-structured-view-${revId}`);
  const rawEl = document.getElementById(`transcript-raw-view-${revId}`);
  const btnStruct = document.getElementById(`btn-transcript-mode-struct-${revId}`);
  const btnRaw = document.getElementById(`btn-transcript-mode-raw-${revId}`);
  if (mode === 'structured') {
    if (structEl) structEl.style.display = 'flex';
    if (rawEl) rawEl.style.display = 'none';
    if (btnStruct) btnStruct.classList.add('active');
    if (btnRaw) btnRaw.classList.remove('active');
  } else {
    if (structEl) structEl.style.display = 'none';
    if (rawEl) rawEl.style.display = 'block';
    if (btnStruct) btnStruct.classList.remove('active');
    if (btnRaw) btnRaw.classList.add('active');
  }
};

window.copyReviewTranscript = function(revId) {
  const rev = (interviewReviewState.reviews || []).find(r => r.id === revId);
  if (rev && rev.transcript) {
    copyPromptText(rev.transcript);
    showToast('Interview transcript copied to clipboard!');
  }
};

window.setTrajectoryDimensionFilter = setTrajectoryDimensionFilter;


