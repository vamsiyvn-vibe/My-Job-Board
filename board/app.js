// State Management
let state = {
    allJobs: [],
    currentView: 'Lead', // All, Lead, Consideration, Archived, Criteria
    currentLayout: 'grid', // grid, list
    selectedCohort: 'all', // all, Mag 7, AI Labs, High-Growth Startups, Non-Mag 7
    selectedCompany: 'all',
    selectedLevel: 'all',
    selectedSalary: 'all',
    searchQuery: '',
    lastScanned: '',
    selectedJob: null,
    sortColumn: null,
    sortDirection: 'asc',
    
    // Background Sync Polling
    isScanning: false,
    pollInterval: null,
    
    // Search Criteria
    searchCriteria: {
        locations: [],
        role_levels: [],
        custom_keywords: [],
        strict_level_filtering: false
    },
    
    // Tracked Companies list
    trackedCompanies: [],
    companiesSortColumn: 'cohort',
    companiesSortDirection: 'asc',
    
    // LinkedIn Connections Network
    connections: [],
    connSearchQuery: ''
};

// API Base URL
const API_BASE = '';

// DOM Elements
const elements = {
    navItems: document.querySelectorAll('.nav-menu .nav-item'),
    badgeAll: document.getElementById('badge-all'),
    badgeLeads: document.getElementById('badge-leads'),
    badgeConsidered: document.getElementById('badge-considered'),
    badgeArchived: document.getElementById('badge-archived'),
    lastScannedTime: document.getElementById('last-scanned-time'),
    btnScan: document.getElementById('btn-scan'),
    scanIcon: document.getElementById('scan-icon'),
    viewTitle: document.getElementById('view-title'),
    viewDesc: document.getElementById('view-desc'),
    headerStats: document.getElementById('header-stats'),
    statTotal: document.getElementById('stat-total'),
    statConversion: document.getElementById('stat-conversion'),
    syncBanner: document.getElementById('sync-banner'),
    
    // Controls Section
    dashboardControls: document.getElementById('dashboard-controls'),
    searchInput: document.getElementById('search-input'),
    clearSearch: document.getElementById('clear-search'),
    cohortFilters: document.getElementById('cohort-filters'),
    companyFilter: document.getElementById('company-filter'),
    roleFilter: document.getElementById('role-filter'),
    salaryFilter: document.getElementById('salary-filter'),
    viewCardsBtn: document.getElementById('view-cards-btn'),
    viewListBtn: document.getElementById('view-list-btn'),
    
    // Content Areas
    jobsContainerSec: document.getElementById('jobs-container-sec'),
    loadingState: document.getElementById('loading-state'),
    emptyState: document.getElementById('empty-state'),
    jobsGrid: document.getElementById('jobs-grid'),
    jobsListWrapper: document.getElementById('jobs-list-wrapper'),
    jobsListBody: document.getElementById('jobs-list-body'),
    portalsSectionWrapper: document.getElementById('portals-section-wrapper'),
    portalsGrid: document.getElementById('portals-grid'),
    
    // Criteria Panel Elements
    criteriaSection: document.getElementById('criteria-section'),
    criteriaLocations: document.getElementById('criteria-locations'),
    criteriaKeywords: document.getElementById('criteria-keywords'),
    criteriaStrictLevels: document.getElementById('criteria-strict-levels'),
    criteriaForm: document.getElementById('search-criteria-form'),
    companiesListBody: document.getElementById('companies-list-body'),
    
    // Add Company Modal
    btnShowAddCo: document.getElementById('btn-show-add-co'),
    addCompanyModal: document.getElementById('add-company-modal'),
    addCompanyClose: document.getElementById('add-company-close'),
    addCompanyCancel: document.getElementById('add-company-cancel'),
    addCompanyForm: document.getElementById('add-company-form'),
    
    // Job Details Modal
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
    modalJobLink: document.getElementById('modal-job-link'),
    modalFooterActions: document.getElementById('modal-footer-actions'),
    toastContainer: document.getElementById('toast-container'),
    
    // Company Info tab elements
    compHq: document.getElementById('comp-hq'),
    compFounded: document.getElementById('comp-founded'),
    compRevenue: document.getElementById('comp-revenue'),
    compEmployees: document.getElementById('comp-employees'),
    compDomain: document.getElementById('comp-domain'),
    
    // Application Tracker elements
    modalTabTracking: document.getElementById('modal-tab-tracking'),
    jobTrackingForm: document.getElementById('job-tracking-form'),
    trackStatus: document.getElementById('track-status'),
    trackOutcome: document.getElementById('track-outcome'),
    trackResume: document.getElementById('track-resume'),
    btnViewResume: document.getElementById('btn-view-resume'),

    // Connections Panel elements
    badgeConnections: document.getElementById('badge-connections'),
    connectionsSection: document.getElementById('connections-section'),
    connectionsDropzone: document.getElementById('connections-dropzone'),
    connectionsFileInput: document.getElementById('connections-file-input'),
    btnClearConnections: document.getElementById('btn-clear-connections'),
    connStatTotal: document.getElementById('conn-stat-total'),
    connStatCompanies: document.getElementById('conn-stat-companies'),
    connSearchInput: document.getElementById('conn-search-input'),
    connectionsListBody: document.getElementById('connections-list-body'),
    
    // Referrals modal elements
    modalTabReferrals: document.getElementById('modal-tab-referrals'),
    referralsListBody: document.getElementById('referrals-list-body'),
    referralMessageDraft: document.getElementById('referral-message-draft'),
    btnCopyReferral: document.getElementById('btn-copy-referral')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    fetchJobs();
    fetchCriteria();
    fetchCompanies();
    fetchConnections();
    setupEventListeners();
});

// Setup Event Listeners
function setupEventListeners() {
    // Navigation items
    elements.navItems.forEach(item => {
        item.addEventListener('click', () => {
            elements.navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            state.currentView = item.getAttribute('data-status');
            updateViewHeader();
            render();
        });
    });

    // Search input
    elements.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim().toLowerCase();
        elements.clearSearch.style.display = state.searchQuery ? 'block' : 'none';
        render();
    });

    // Clear search
    elements.clearSearch.addEventListener('click', () => {
        elements.searchInput.value = '';
        state.searchQuery = '';
        elements.clearSearch.style.display = 'none';
        render();
    });

    // Cohort Filters
    elements.cohortFilters.addEventListener('click', (e) => {
        if (e.target.classList.contains('pill')) {
            elements.cohortFilters.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
            e.target.classList.add('active');
            state.selectedCohort = e.target.getAttribute('data-cohort');
            render();
        }
    });

    // Company Dropdown Filter
    elements.companyFilter.addEventListener('change', (e) => {
        state.selectedCompany = e.target.value;
        render();
    });

    // Role Dropdown Filter
    elements.roleFilter.addEventListener('change', (e) => {
        state.selectedLevel = e.target.value;
        render();
    });

    // Salary Dropdown Filter
    if (elements.salaryFilter) {
        elements.salaryFilter.addEventListener('change', (e) => {
            state.selectedSalary = e.target.value;
            render();
        });
    }

    // Layout buttons
    elements.viewCardsBtn.addEventListener('click', () => {
        state.currentLayout = 'grid';
        elements.viewCardsBtn.classList.add('active');
        elements.viewListBtn.classList.remove('active');
        render();
    });

    elements.viewListBtn.addEventListener('click', () => {
        state.currentLayout = 'list';
        elements.viewListBtn.classList.add('active');
        elements.viewCardsBtn.classList.remove('active');
        render();
    });

    // Run Daily Scan manually
    elements.btnScan.addEventListener('click', runScan);

    // Modal Close
    elements.modalCloseBtn.addEventListener('click', closeModal);
    elements.jobModal.addEventListener('click', (e) => {
        if (e.target === elements.jobModal) closeModal();
    });

    // Modal Tabs
    elements.modalTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            elements.modalTabs.forEach(t => t.classList.remove('active'));
            elements.tabPanes.forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            const targetPane = document.getElementById(`pane-${tab.getAttribute('data-tab')}`);
            if (targetPane) targetPane.classList.add('active');
        });
    });

    // Criteria Form Submit & Save Button click
    elements.criteriaForm.addEventListener('submit', saveCriteriaForm);
    const saveBtn = document.getElementById('btn-save-criteria');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveCriteriaForm);
    }

    // Listen for level checkbox toggles in the companies table
    elements.companiesListBody.addEventListener('change', (e) => {
        if (e.target.classList.contains('co-level-checkbox')) {
            const companyName = e.target.getAttribute('data-company');
            const levelVal = e.target.value;
            const checked = e.target.checked;
            console.log(`Company level changed: ${companyName} -> ${levelVal} (${checked})`);
            
            const company = state.trackedCompanies.find(c => c.name.toLowerCase().trim() === companyName.toLowerCase().trim());
            if (company) {
                if (!company.levels) {
                    company.levels = [];
                }
                if (checked) {
                    if (!company.levels.includes(levelVal)) {
                        company.levels.push(levelVal);
                    }
                } else {
                    company.levels = company.levels.filter(l => l !== levelVal);
                }
                console.log(`Updated levels in memory for ${company.name}:`, company.levels);
            } else {
                console.warn(`Company not found for checkbox level toggle: ${companyName}`);
            }
        }
    });

    // Companies table header sort listener
    document.addEventListener('click', (e) => {
        const th = e.target.closest('.sortable-company-th');
        if (th) {
            const col = th.getAttribute('data-col');
            if (state.companiesSortColumn === col) {
                state.companiesSortDirection = state.companiesSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                state.companiesSortColumn = col;
                state.companiesSortDirection = 'asc';
            }
            renderCompaniesTable();
        }
    });

    // Track Company dialog triggers
    elements.btnShowAddCo.addEventListener('click', () => {
        elements.addCompanyModal.classList.add('open');
    });
    elements.addCompanyClose.addEventListener('click', closeAddCompanyModal);
    elements.addCompanyCancel.addEventListener('click', closeAddCompanyModal);
    elements.addCompanyForm.addEventListener('submit', submitNewCompany);

    // Application Tracking Form Submit
    elements.jobTrackingForm.addEventListener('submit', saveJobTrackingDetails);

    // Dynamic Resume url attachment listener
    elements.trackResume.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (val) {
            elements.btnViewResume.href = val;
            elements.btnViewResume.style.display = 'inline-flex';
        } else {
            elements.btnViewResume.style.display = 'none';
        }
    });

    // Connections Drag-and-Drop Dropzone Setup
    if (elements.connectionsDropzone) {
        elements.connectionsDropzone.addEventListener('click', () => {
            if (elements.connectionsFileInput) elements.connectionsFileInput.click();
        });
        
        elements.connectionsDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            elements.connectionsDropzone.classList.add('dragover');
        });
        
        ['dragleave', 'dragend', 'drop'].forEach(evt => {
            elements.connectionsDropzone.addEventListener(evt, () => {
                elements.connectionsDropzone.classList.remove('dragover');
            });
        });
        
        elements.connectionsDropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                handleConnectionsUpload(files[0]);
            }
        });
    }
    
    // Connections upload mode selection buttons toggling
    document.querySelectorAll('.mode-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const radio = btn.querySelector('input[type="radio"]');
            if (radio) {
                radio.checked = true;
                document.querySelectorAll('.mode-option-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            }
        });
    });
    
    if (elements.connectionsFileInput) {
        elements.connectionsFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleConnectionsUpload(e.target.files[0]);
            }
        });
    }
    
    if (elements.btnClearConnections) {
        elements.btnClearConnections.addEventListener('click', clearConnections);
    }
    
    if (elements.connSearchInput) {
        elements.connSearchInput.addEventListener('input', (e) => {
            state.connSearchQuery = e.target.value;
            renderConnectionsTable();
        });
    }
    
    if (elements.btnCopyReferral) {
        elements.btnCopyReferral.addEventListener('click', copyReferralMessage);
    }
}

// Fetch Jobs
async function fetchJobs() {
    showLoader(true);
    try {
        const response = await fetch(`${API_BASE}/api/jobs`);
        if (!response.ok) throw new Error('Failed to load jobs from server');
        
        const data = await response.json();
        state.allJobs = data.jobs || [];
        state.lastScanned = data.last_scanned || 'Unknown';
        state.isScanning = !!data.is_scanning;
        
        elements.lastScannedTime.textContent = state.lastScanned;
        updateBadges();
        populateCompanyFilter();
        
        // Handle background scanning status indicator
        if (state.isScanning) {
            showSyncBanner(true);
            startPollingScanStatus();
        } else {
            showSyncBanner(false);
        }
        
        render();
    } catch (error) {
        console.error(error);
        showToast('Error loading jobs. Is server active?', 'error');
    } finally {
        showLoader(false);
    }
}

// Show/Hide background sync banner
function showSyncBanner(show) {
    if (show) {
        elements.syncBanner.style.display = 'flex';
        elements.btnScan.disabled = true;
        elements.scanIcon.classList.add('spin-anim');
    } else {
        elements.syncBanner.style.display = 'none';
        elements.btnScan.disabled = false;
        elements.scanIcon.classList.remove('spin-anim');
    }
}

// Poll scanning status from backend
function startPollingScanStatus() {
    if (state.pollInterval) return;
    
    state.pollInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE}/api/scan-status`);
            const data = await response.json();
            
            if (!data.is_scanning) {
                clearInterval(state.pollInterval);
                state.pollInterval = null;
                state.isScanning = false;
                showSyncBanner(false);
                showToast('Daily scan complete! Listings updated.', 'success');
                // Re-fetch jobs to render updated list
                fetchJobs();
            }
        } catch (error) {
            console.error("Error polling scan status:", error);
        }
    }, 4000);
}

// Fetch Search Criteria
async function fetchCriteria() {
    try {
        const response = await fetch(`${API_BASE}/api/criteria`);
        if (!response.ok) throw new Error('Failed to load criteria');
        
        const data = await response.json();
        state.searchCriteria = data;
        
        elements.criteriaLocations.value = (data.locations || []).join(', ');
        elements.criteriaKeywords.value = (data.custom_keywords || []).join(', ');
    } catch (error) {
        console.error(error);
    }
}

// Fetch Monitored Companies list
async function fetchCompanies() {
    try {
        const response = await fetch(`${API_BASE}/api/companies`);
        if (!response.ok) throw new Error('Failed to load companies');
        
        const data = await response.json();
        state.trackedCompanies = data || [];
        renderCompaniesTable();
    } catch (error) {
        console.error(error);
    }
}

// Save Search Criteria Form
async function saveCriteriaForm(e) {
    if (e) e.preventDefault();
    
    const locations = elements.criteriaLocations.value.split(',').map(s => s.trim()).filter(s => s);
    const keywords = elements.criteriaKeywords.value.split(',').map(s => s.trim()).filter(s => s);
    
    const bodyData = {
        search_criteria: {
            locations: locations,
            custom_keywords: keywords
        },
        companies: state.trackedCompanies
    };

    try {
        const response = await fetch(`${API_BASE}/api/criteria`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
        
        if (response.ok) {
            state.searchCriteria = bodyData.search_criteria;
            showToast('Search parameters and levels saved successfully.', 'success');
            // Trigger crawler scan immediately on save/update!
            runScan();
        } else {
            showToast('Failed to save search parameters.', 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('Error saving criteria.', 'error');
    }
}

// Close Add Company Modal
function closeAddCompanyModal() {
    elements.addCompanyModal.classList.remove('open');
    elements.addCompanyForm.reset();
}

// Submit New Company
async function submitNewCompany(e) {
    e.preventDefault();
    
    const selectedLevels = [];
    document.querySelectorAll('input[name="new-co-level"]:checked').forEach(chk => {
        selectedLevels.push(chk.value);
    });

    const newCo = {
        name: document.getElementById('new-co-name').value.trim(),
        cohort: document.getElementById('new-co-cohort').value,
        portal_url: document.getElementById('new-co-portal-url').value.trim(),
        levels: selectedLevels
    };

    try {
        const response = await fetch(`${API_BASE}/api/companies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newCo)
        });
        
        const data = await response.json();
        if (response.ok) {
            showToast(data.message || 'Company board added successfully.', 'success');
            closeAddCompanyModal();
            fetchCompanies();
        } else {
            showToast(data.error || 'Failed to add company.', 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('Network error saving company.', 'error');
    }
}

// Trigger daily scan in background asynchronously
async function runScan() {
    if (state.isScanning) return;
    
    showSyncBanner(true);
    showToast('Crawl scan started in background. Feel free to browse.', 'info');

    try {
        const response = await fetch(`${API_BASE}/api/scan`, { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            state.isScanning = true;
            startPollingScanStatus();
        } else {
            showSyncBanner(false);
            showToast(`Scan failed to start: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error(error);
        showSyncBanner(false);
        showToast('Failed to trigger scan. Connection error.', 'error');
    }
}

// Populate Company filter dropdown
function populateCompanyFilter() {
    const filter = elements.companyFilter;
    const currentSel = filter.value;
    
    filter.innerHTML = '<option value="all">All Companies</option>';
    const uniqueCompanies = [...new Set(state.allJobs.map(j => j.company))].sort();
    
    uniqueCompanies.forEach(co => {
        const opt = document.createElement('option');
        opt.value = co;
        opt.textContent = co;
        filter.appendChild(opt);
    });
    
    if (uniqueCompanies.includes(currentSel)) {
        filter.value = currentSel;
        state.selectedCompany = currentSel;
    } else {
        filter.value = 'all';
        state.selectedCompany = 'all';
    }
}


function getCompanyStandardLevels(companyName) {
    const nameLower = companyName.toLowerCase().trim();
    if (nameLower === 'google') {
        return ["Product Manager I", "Product Manager II", "Senior", "Group", "Director", "Senior Director", "Vice President"];
    } else if (nameLower === 'meta') {
        return ["Standard", "Leadership"];
    } else if (nameLower === 'microsoft') {
        return ["Standard", "Senior", "Principal", "Director", "Senior Director", "Vice President"];
    } else if (nameLower === 'netflix') {
        return ["Standard (up to L6)", "Group", "Director", "Senior Director", "Vice President"];
    } else if (nameLower === 'amazon' || nameLower === 'nvidia') {
        return ["Standard", "Senior", "Principal", "Director", "Senior Director", "Vice President"];
    } else if (nameLower === 'openai' || nameLower === 'anthropic' || nameLower === 'perplexity' || nameLower === 'cursor') {
        return ["Standard"];
    } else if (nameLower === 'apple') {
        return ["Standard", "Director", "Senior Director"];
    } else if (nameLower === 'datadog') {
        return ["Standard", "Senior", "Group", "Staff", "Principal", "Director", "Senior Director", "Vice President", "Chief Product Officer"];
    } else {
        return ["Standard", "Senior", "Staff", "Principal", "Director", "Senior Director", "Vice President", "Chief Product Officer"];
    }
}

function sortCompanies() {
    state.trackedCompanies.sort((a, b) => {
        let valA, valB;
        const col = state.companiesSortColumn || 'cohort';
        const dir = state.companiesSortDirection === 'desc' ? -1 : 1;
        
        if (col === 'company') {
            valA = a.name || '';
            valB = b.name || '';
            return valA.localeCompare(valB) * dir;
        } else if (col === 'cohort') {
            valA = a.cohort || '';
            valB = b.cohort || '';
            const comp = valA.localeCompare(valB);
            if (comp !== 0) return comp * dir;
            return (a.name || '').localeCompare(b.name || '');
        } else if (col === 'scraped_capability') {
            valA = a.capability || 'active_sync';
            valB = b.capability || 'active_sync';
            return valA.localeCompare(valB) * dir;
        } else if (col === 'scraped_count') {
            valA = state.allJobs.filter(j => j.company.toLowerCase().trim() === a.name.toLowerCase().trim()).length;
            valB = state.allJobs.filter(j => j.company.toLowerCase().trim() === b.name.toLowerCase().trim()).length;
            return (valA - valB) * dir;
        }
        return 0;
    });
}

function renderCompaniesTable() {
    // Sort before rendering
    sortCompanies();

    // Update sort indicators on headers
    document.querySelectorAll('.sortable-company-th').forEach(th => {
        const col = th.getAttribute('data-col');
        const indicator = th.querySelector('.sort-indicator');
        if (indicator) {
            if (col === state.companiesSortColumn) {
                indicator.innerHTML = state.companiesSortDirection === 'asc' ? ' &uarr;' : ' &darr;';
                indicator.style.opacity = 1;
            } else {
                indicator.innerHTML = ' &updownarrow;';
                indicator.style.opacity = 0.3;
            }
        }
    });

    const body = elements.companiesListBody;
    body.innerHTML = '';
    
    if (state.trackedCompanies.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No tracked companies configured.</td></tr>';
        return;
    }

    state.trackedCompanies.forEach(co => {
        const row = document.createElement('tr');
        const capability = co.capability || 'active_sync';
        let capabilityHtml = '';
        
        if (capability === 'active_sync') {
            capabilityHtml = `<span class="capability-badge active-sync" title="All jobs matching criteria are fully sync'd automatically"><i class="fa-solid fa-circle-check"></i> Full</span>`;
        } else {
            const reason = getPortalOnlyReason(co.name);
            capabilityHtml = `<span class="capability-badge portal-only" title="${reason}"><i class="fa-solid fa-circle-xmark"></i> Portal Only</span>`;
        }

        // Count jobs matching company
        const scrapedJobsCount = state.allJobs.filter(j => j.company.toLowerCase().trim() === co.name.toLowerCase().trim()).length;

        // Render levels selection
        const levels = getCompanyStandardLevels(co.name);
        const checkedLevels = co.levels || [];
        const levelsHtml = `
            <div class="checkbox-tag-group mini-tags" style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${levels.map(lvl => {
                    const isChecked = checkedLevels.includes(lvl);
                    return `
                        <label class="check-tag mini" style="display: inline-block;">
                            <input type="checkbox" class="co-level-checkbox" data-company="${co.name.replace(/"/g, '&quot;')}" value="${lvl}" ${isChecked ? 'checked' : ''}>
                            <span>${lvl}</span>
                        </label>
                    `;
                }).join('')}
            </div>
        `;

        row.innerHTML = `
            <td style="font-weight: 600; padding: 12px 16px;">${co.name}</td>
            <td style="padding: 12px 16px;"><span class="cohort-tag ${getCohortClass(co.cohort)}" title="${getCohortTooltip(co.cohort)}">${co.cohort}</span></td>
            <td style="padding: 12px 16px;">${capabilityHtml}</td>
            <td style="padding: 12px 16px; font-weight: 600; text-align: center;">${scrapedJobsCount}</td>
            <td style="padding: 12px 16px;">${levelsHtml}</td>
            <td style="padding: 12px 16px;">
                <div class="table-actions" style="justify-content: flex-end; padding-right: 8px;">
                    <button type="button" class="btn-icon action-delete" style="color: #ef4444;" title="Delete Company & Related Jobs" onclick="event.stopPropagation(); deleteTrackedCompany('${co.name.replace(/'/g, "\\'")}')">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </td>
        `;
        body.appendChild(row);
    });
}

// Delete Tracked Company and all associated jobs
async function deleteTrackedCompany(companyName) {
    if (!confirm(`Are you sure you want to permanently delete '${companyName}'? This will stop tracking this board and remove all job listings for this company from your spreadsheet.`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/companies/${encodeURIComponent(companyName)}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        if (response.ok) {
            showToast(data.message || 'Company deleted.', 'success');
            // Refresh tracked companies and jobs list
            fetchCompanies();
            fetchJobs();
        } else {
            showToast(data.error || 'Failed to delete company.', 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('Error deleting company.', 'error');
    }
}

// Get reasons for crawl limits of portal_only platforms
function getPortalOnlyReason(companyName) {
    const name = companyName.toLowerCase();
    if (name.includes('google') || name.includes('alphabet')) return 'Google uses a dynamic batch API that limits public indexing and paginates listings.';
    if (name.includes('apple')) return 'Apple uses a strict session validation token and limits external API requests to page 1.';
    if (name.includes('amazon')) return 'Amazon restricts public jobs API search results to a small sample size limit.';
    if (name.includes('nvidia')) return 'Nvidia Workday portal is protected by temporary session challenges and blocks bots.';
    if (name.includes('meta')) return 'Meta is protected by strict Cloudflare and Meta anti-bot verification.';
    if (name.includes('tesla')) return 'Tesla is protected by Cloudflare verification; lacks a public query endpoint.';
    if (name.includes('netflix')) return 'Netflix is protected by Cloudflare verification; requires full JS rendering.';
    if (name.includes('disney')) return 'Disney is protected by Workday/Session protection and anti-scraping blocks.';
    if (name.includes('universal')) return 'Universal is protected by strict Workday session verification.';
    if (name.includes('walmart')) return 'Walmart is protected by Walmart security blocks; requires browser challenges.';
    return 'Lacks open search API or uses strict anti-bot verification.';
}

// Update Badges & Counts
function updateBadges() {
    const totalJobs = state.allJobs.length;
    const leads = state.allJobs.filter(j => j.status === 'Lead').length;
    const considered = state.allJobs.filter(j => j.status === 'Consideration').length;
    const archived = state.allJobs.filter(j => j.status === 'Archived').length;

    if (elements.badgeAll) elements.badgeAll.textContent = totalJobs;
    elements.badgeLeads.textContent = leads;
    elements.badgeConsidered.textContent = considered;
    elements.badgeArchived.textContent = archived;

    const total = leads + considered;
    elements.statTotal.textContent = total;
    const rate = total > 0 ? Math.round((considered / total) * 100) : 0;
    elements.statConversion.textContent = `${rate}%`;
}

// Update View Header titles
function updateViewHeader() {
    if (elements.connectionsSection) elements.connectionsSection.style.display = 'none';

    if (state.currentView === 'All') {
        elements.headerStats.style.display = 'flex';
        elements.dashboardControls.style.display = 'block';
        elements.jobsContainerSec.style.display = 'flex';
        elements.criteriaSection.style.display = 'none';
        
        elements.viewTitle.textContent = 'All Job Leads';
        elements.viewDesc.textContent = 'Overview of all active, considered, and archived jobs in your tracker pipeline.';
    } else if (state.currentView === 'Lead') {
        elements.headerStats.style.display = 'flex';
        elements.dashboardControls.style.display = 'block';
        elements.jobsContainerSec.style.display = 'flex';
        elements.criteriaSection.style.display = 'none';
        
        elements.viewTitle.textContent = 'New Leads';
        elements.viewDesc.textContent = 'Review crawled job openings and build your consideration set.';
    } else if (state.currentView === 'Consideration') {
        elements.headerStats.style.display = 'flex';
        elements.dashboardControls.style.display = 'block';
        elements.jobsContainerSec.style.display = 'flex';
        elements.criteriaSection.style.display = 'none';
        
        elements.viewTitle.textContent = 'Consideration Set';
        elements.viewDesc.textContent = 'Roles you are currently preparing for or planning to apply to.';
    } else if (state.currentView === 'Archived') {
        elements.headerStats.style.display = 'flex';
        elements.dashboardControls.style.display = 'block';
        elements.jobsContainerSec.style.display = 'flex';
        elements.criteriaSection.style.display = 'none';
        
        elements.viewTitle.textContent = 'Archived Leads';
        elements.viewDesc.textContent = 'Archived leads. Restore them anytime if priorities change.';
    } else if (state.currentView === 'Criteria') {
        elements.headerStats.style.display = 'none';
        elements.dashboardControls.style.display = 'none';
        elements.jobsContainerSec.style.display = 'none';
        elements.criteriaSection.style.display = 'block';
        
        elements.viewTitle.textContent = 'Search Settings';
        elements.viewDesc.textContent = 'Manage crawler search filters, roles leveling targets, and company board triggers.';
        
        fetchCriteria();
        fetchCompanies();
    } else if (state.currentView === 'Connections') {
        elements.headerStats.style.display = 'none';
        elements.dashboardControls.style.display = 'none';
        elements.jobsContainerSec.style.display = 'none';
        elements.criteriaSection.style.display = 'none';
        if (elements.connectionsSection) elements.connectionsSection.style.display = 'block';
        
        elements.viewTitle.textContent = 'LinkedIn Network Connections';
        elements.viewDesc.textContent = 'Import and search LinkedIn connections to identify potential referrals.';
        
        fetchConnections();
    }
}

// Cohort style tags mapping
function getCohortClass(cohort) {
    if (!cohort) return 'cohort-other';
    const c = cohort.toLowerCase();
    if (c.includes('non-mag') || c.includes('midsize') || c.includes('mid-sized')) return 'cohort-nonmag7';
    if (c.includes('mag 7')) return 'cohort-mag7';
    if (c.includes('labs') || c.includes('ai')) return 'cohort-ailabs';
    if (c.includes('startup') || c.includes('high-growth')) return 'cohort-startups';
    return 'cohort-other';
}

// Cohort tooltip descriptions
function getCohortTooltip(cohort) {
    if (!cohort) return '';
    const c = cohort.toLowerCase();
    if (c.includes('mag 7')) return 'Mag 7 (Magnificent Seven): Alphabet, Amazon, Apple, Meta, Microsoft, Nvidia, Tesla';
    if (c.includes('labs') || c.includes('ai')) return 'AI Research Labs: OpenAI, Anthropic, Perplexity, Cursor, etc.';
    if (c.includes('startup') || c.includes('high-growth')) return 'High-Growth Startups: Cockroach Labs, Hugging Face, etc.';
    if (c.includes('midsize') || c.includes('mid-sized') || c.includes('non-mag') || c.includes('non-mag 7')) return 'Non-Mag 7: Publicly listed companies that are not Mag 7, offering Product management opportunities';
    return '';
}

// Update Job Status on Server
async function updateJobStatus(jobId, newStatus) {
    try {
        const response = await fetch(`${API_BASE}/api/jobs/${jobId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        
        if (!response.ok) throw new Error('Status update failed');
        
        // Update locally
        state.allJobs = state.allJobs.map(job => {
            if (job.id === jobId) {
                return { ...job, status: newStatus, select: newStatus === 'Consideration' ? '[x]' : '[ ]' };
            }
            return job;
        });

        if (state.selectedJob && state.selectedJob.id === jobId) {
            closeModal();
        }

        updateBadges();
        render();
        
        let msg = '';
        if (newStatus === 'Consideration') msg = 'Added to consideration set.';
        else if (newStatus === 'Archived') msg = 'Lead moved to archive.';
        else msg = 'Lead restored to active pipeline.';
        showToast(msg, 'success');
    } catch (error) {
        console.error(error);
        showToast('Failed to update job status in spreadsheet.', 'error');
    }
}

// Delete Job Listing from Spreadsheet
async function deleteJobListing(jobId) {
    if (!confirm('Are you sure you want to permanently delete this job listing from the spreadsheet?')) return;
    try {
        const response = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete job listing');
        
        showToast('Listing deleted successfully.', 'success');
        
        // Remove locally from state
        state.allJobs = state.allJobs.filter(job => job.id !== jobId);
        
        if (state.selectedJob && state.selectedJob.id === jobId) {
            closeModal();
        }
        
        // Re-fetch jobs to sync shifted row IDs
        await fetchJobs();
    } catch (error) {
        console.error(error);
        showToast('Failed to delete listing.', 'error');
    }
}

// Save Job Tracking Details (Stage, Outcome, Resume Link)
async function saveJobTrackingDetails(e) {
    e.preventDefault();
    if (!state.selectedJob) return;

    const trackingData = {
        app_status: elements.trackStatus.value,
        app_outcome: elements.trackOutcome.value,
        resume_url: elements.trackResume.value.trim()
    };

    try {
        const response = await fetch(`${API_BASE}/api/jobs/${state.selectedJob.id}/tracking`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(trackingData)
        });

        if (response.ok) {
            // Update local state
            state.allJobs = state.allJobs.map(job => {
                if (job.id === state.selectedJob.id) {
                    return { ...job, ...trackingData };
                }
                return job;
            });
            
            showToast('Application tracking updates saved to Excel.', 'success');
            render();
            closeModal();
        } else {
            showToast('Failed to save application tracking updates.', 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('Error saving tracking updates.', 'error');
    }
}

// Get CSS class name for tracking tag
function getTrackerTagClass(status) {
    if (!status || status === 'Not Applied') return 'tracker-not-applied';
    if (status.includes('Interviewing')) return 'tracker-interviewing';
    return 'tracker-applied';
}

// Loading state
function showLoader(show) {
    if (show) {
        elements.loadingState.style.display = 'flex';
        elements.jobsGrid.style.display = 'none';
        elements.jobsListWrapper.style.display = 'none';
        elements.emptyState.style.display = 'none';
    } else {
        elements.loadingState.style.display = 'none';
    }
}

// Render main list / grid view
function render() {
    if (state.currentView === 'Criteria' || state.currentView === 'Connections') return;

    // Get active sync companies to only display their leads
    const activeSyncCompanies = state.trackedCompanies
        .filter(co => co.capability === 'active_sync')
        .map(co => co.name.toLowerCase());

    // Filter jobs based on tab status
    let filtered = [];
    if (state.currentView === 'Lead') {
        // For new leads, only show jobs from active_sync (Full) companies
        filtered = state.allJobs.filter(j => j.status === 'Lead' && activeSyncCompanies.includes(j.company.toLowerCase()));
    } else if (state.currentView === 'All') {
        // For All view, show active_sync jobs (all statuses) AND portal_only jobs ONLY if they are Considered/Archived
        filtered = state.allJobs.filter(j => 
            activeSyncCompanies.includes(j.company.toLowerCase()) || 
            (j.status !== 'Lead')
        );
    } else {
        // For Consideration or Archived, show everything in that status (no filtering out)
        filtered = state.allJobs.filter(j => j.status === state.currentView);
    }

    // Filter by cohort pill
    if (state.selectedCohort !== 'all') {
        filtered = filtered.filter(j => {
            const c = j.cohort.toLowerCase();
            const s = state.selectedCohort.toLowerCase();
            if (s.includes('non-mag') || s.includes('mid-sized') || s.includes('midsize')) {
                return c.includes('non-mag') || c.includes('mid-sized') || c.includes('midsize');
            }
            if (s.includes('mag 7')) {
                return c.includes('mag 7') && !c.includes('non-mag');
            }
            if (s.includes('ai labs')) return c.includes('labs') || c.includes('ai');
            if (s.includes('startups')) return c.includes('startup') || c.includes('high-growth');
            return c === s;
        });
    }

    // Filter by company dropdown
    if (state.selectedCompany !== 'all') {
        filtered = filtered.filter(j => j.company === state.selectedCompany);
    }

    // Filter by level dropdown
    if (state.selectedLevel !== 'all') {
        filtered = filtered.filter(j => {
            const title = j.role.toLowerCase();
            const level = state.selectedLevel.toLowerCase();
            if (level === 'other') {
                return !['senior', 'principal', 'staff', 'director', 'vp'].some(word => title.includes(word));
            }
            return title.includes(level);
        });
    }

    // Filter by salary dropdown
    if (state.selectedSalary && state.selectedSalary !== 'all') {
        filtered = filtered.filter(j => {
            if (state.selectedSalary === 'has_salary') {
                return j.salary && j.salary !== 'N/A';
            }
            const threshold = parseInt(state.selectedSalary.replace('k', '000'), 10);
            const range = parseSalaryRange(j.salary);
            if (!range) return false;
            return range.max >= threshold;
        });
    }

    // Filter by text search query
    if (state.searchQuery) {
        filtered = filtered.filter(j => 
            j.role.toLowerCase().includes(state.searchQuery) ||
            j.company.toLowerCase().includes(state.searchQuery) ||
            j.location.toLowerCase().includes(state.searchQuery) ||
            j.key_focus.toLowerCase().includes(state.searchQuery)
        );
    }

    // Sort if a sort column is active (list view only)
    if (state.sortColumn && state.currentLayout === 'list') {
        filtered = sortJobs(filtered, state.sortColumn, state.sortDirection);
    }

    // Empty state check
    if (filtered.length === 0) {
        elements.jobsGrid.style.display = 'none';
        elements.jobsListWrapper.style.display = 'none';
        elements.emptyState.style.display = 'flex';
        renderPortals();
        return;
    }

    elements.emptyState.style.display = 'none';

    // Route to appropriate view render
    if (state.currentLayout === 'grid') {
        elements.jobsListWrapper.style.display = 'none';
        elements.jobsGrid.style.display = 'grid';
        renderGrid(filtered);
    } else {
        elements.jobsGrid.style.display = 'none';
        elements.jobsListWrapper.style.display = 'block';
        renderList(filtered);
    }

    renderPortals();
}

// Render manual portal check cards
function renderPortals() {
    if (!elements.portalsSectionWrapper || !elements.portalsGrid) return;
    
    // Only show manual portal links on All Leads and New Leads views
    if (state.currentView !== 'All' && state.currentView !== 'Lead') {
        elements.portalsSectionWrapper.style.display = 'none';
        return;
    }
    
    // Filter portal-only companies based on current cohort selection
    let portalCompanies = state.trackedCompanies.filter(co => co.capability === 'portal_only');
    
    if (state.selectedCohort !== 'all') {
        portalCompanies = portalCompanies.filter(co => {
            const c = co.cohort.toLowerCase();
            const s = state.selectedCohort.toLowerCase();
            if (s.includes('non-mag') || s.includes('mid-sized') || s.includes('midsize')) {
                return c.includes('non-mag') || c.includes('mid-sized') || c.includes('midsize');
            }
            if (s.includes('mag 7')) {
                return c.includes('mag 7') && !c.includes('non-mag');
            }
            if (s.includes('ai labs')) return c.includes('labs') || c.includes('ai');
            if (s.includes('startups')) return c.includes('startup') || c.includes('high-growth');
            return c === s;
        });
    }
    
    // Filter by company filter dropdown (if a single company is selected)
    if (state.selectedCompany !== 'all') {
        portalCompanies = portalCompanies.filter(co => co.name === state.selectedCompany);
    }
    
    // Filter by search query
    if (state.searchQuery) {
        portalCompanies = portalCompanies.filter(co => 
            co.name.toLowerCase().includes(state.searchQuery) ||
            co.domain.toLowerCase().includes(state.searchQuery)
        );
    }
    
    if (portalCompanies.length === 0) {
        elements.portalsSectionWrapper.style.display = 'none';
        return;
    }
    
    elements.portalsSectionWrapper.style.display = 'block';
    elements.portalsGrid.innerHTML = '';
    
    portalCompanies.forEach(co => {
        const card = document.createElement('div');
        card.className = 'portal-card';
        
        const cohortClass = getCohortClass(co.cohort);
        const reason = getPortalOnlyReason(co.name);
        
        card.innerHTML = `
            <div class="portal-header">
                <span class="portal-company-title">${co.name}</span>
                <span class="cohort-tag ${cohortClass}" title="${getCohortTooltip(co.cohort)}">${co.cohort}</span>
            </div>
            <div class="portal-limits-info">
                <i class="fa-solid fa-triangle-exclamation"></i> <strong>Crawl Limitation:</strong> ${reason}
            </div>
            <p style="font-size: 0.82rem; color: var(--text-muted); margin: 0;">
                <i class="fa-solid fa-circle-info"></i> Revenue: ${co.revenue || 'N/A'} | Employees: ${co.employees || 'N/A'}
            </p>
            <a href="${co.portal_url || '#'}" target="_blank" class="btn btn-outline btn-sm btn-portal-link">
                <span>Search Careers Page</span>
                <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
        `;
        elements.portalsGrid.appendChild(card);
    });
}

// Render grid cards layout
function renderGrid(jobs) {
    elements.jobsGrid.innerHTML = '';
    
    jobs.forEach(job => {
        const card = document.createElement('div');
        card.className = `job-card status-${job.status.toLowerCase()}`;
        card.addEventListener('click', () => openJobDetails(job));
        card.title = "Click to view details & tracking settings";

        const cohortClass = getCohortClass(job.cohort);
        let actionsHtml = getActionsHtml(job);

        // Include tracker tags on cards in considered tab
        let trackingTagsHtml = '';
        if (job.status === 'Consideration') {
            const trackerTagClass = getTrackerTagClass(job.app_status);
            
            // Outcome badge styling
            let outcomeTagClass = 'outcome-pending';
            if (job.app_outcome === 'Accepted') outcomeTagClass = 'outcome-accepted';
            else if (job.app_outcome === 'Rejected') outcomeTagClass = 'outcome-rejected';
            else if (job.app_outcome === 'Not applicable') outcomeTagClass = 'outcome-na';

            trackingTagsHtml = `
                <div class="card-tracker-details">
                    <div class="tracker-row">
                        <span class="tracker-label">Stage:</span>
                        <span class="card-tracker-tag ${trackerTagClass}">
                            <i class="fa-solid fa-play-circle"></i> ${job.app_status || 'Not Applied'}
                        </span>
                    </div>
                    <div class="tracker-row">
                        <span class="tracker-label">Outcome:</span>
                        <span class="card-outcome-tag ${outcomeTagClass}">
                            ${job.app_outcome || 'Active / Pending'}
                        </span>
                    </div>
                    <div class="tracker-row">
                        <span class="tracker-label">Resume:</span>
                        ${job.resume_url ? `
                            <a href="${job.resume_url}" target="_blank" class="card-resume-link" onclick="event.stopPropagation();" title="Open PDF Resume in new tab">
                                <i class="fa-solid fa-file-pdf"></i> View Attached
                            </a>
                        ` : `
                            <span class="card-resume-none"><i class="fa-solid fa-file-circle-minus"></i> None</span>
                        `}
                    </div>
                </div>
            `;
        } else if (state.currentView === 'All') {
            trackingTagsHtml = `
                <div class="card-status-row">
                    <span class="card-status-badge status-${job.status.toLowerCase()}">
                        ${job.status}
                    </span>
                </div>
            `;
        }

        const hasSalary = job.salary && job.salary !== 'N/A';
        const salaryClass = hasSalary ? 'salary-value' : 'salary-na';
        const salaryText = hasSalary ? job.salary : 'Salary N/A';

        // Check LinkedIn Connections
        const matches = findCompanyConnections(job.company);
        let connectionsHtml = '';
        if (matches.length > 0) {
            const first = matches[0];
            const name = `${first.first_name} ${first.last_name}`;
            const linkHtml = `<a href="${first.url}" target="_blank" class="conn-link" onclick="event.stopPropagation();"><i class="fa-brands fa-linkedin"></i> ${name}</a>`;
            if (matches.length > 1) {
                connectionsHtml = `
                    <div class="card-connections">
                        <i class="fa-solid fa-users text-primary"></i>
                        <span>${linkHtml} <span class="conn-badge-pill" onclick="showConnectionsPopover(event, this, '${job.company.replace(/'/g, "\\'")}')" title="Click to view all ${matches.length} connections">+${matches.length - 1}</span></span>
                    </div>
                `;
            } else {
                connectionsHtml = `
                    <div class="card-connections">
                        <i class="fa-solid fa-users text-primary"></i>
                        <span>${linkHtml}</span>
                    </div>
                `;
            }
        }

        card.innerHTML = `
            <div class="card-top">
                <div class="card-header">
                    <span class="company-title-logo">${job.company}</span>
                    <span class="cohort-tag ${cohortClass}" title="${getCohortTooltip(job.cohort)}">${job.cohort}</span>
                </div>
                <h3 class="job-title">
                    <a href="${job.url || '#'}" target="_blank" class="job-title-link" onclick="event.stopPropagation();" title="Open external job description">
                        ${job.role}
                        <i class="fa-solid fa-arrow-up-right-from-square title-link-icon"></i>
                    </a>
                </h3>
                <div class="location-tag">
                    <i class="fa-solid fa-location-dot"></i>
                    <span>${job.location}</span>
                </div>
                <div class="salary-highlight ${salaryClass}">
                    <i class="fa-solid fa-money-bill-wave"></i>
                    <span>${salaryText}</span>
                </div>
                ${connectionsHtml}
                ${trackingTagsHtml}
            </div>
            <div class="card-bottom">
                <span class="date-added">
                    <i class="fa-solid fa-calendar-day"></i>
                    <span>${job.date_added}</span>
                </span>
                <div class="card-actions">
                    ${actionsHtml}
                </div>
            </div>
        `;
        elements.jobsGrid.appendChild(card);
    });
}

// Render list layout table
function renderList(jobs) {
    const tableEl = elements.jobsListWrapper.querySelector('.jobs-table');
    const headerEl = tableEl.querySelector('thead');
    
    // Dynamically build sortable header rows based on current view
    if (state.currentView === 'Consideration') {
        headerEl.innerHTML = `
            <tr>
                ${sortableTh('Role Title', 'role')}
                ${sortableTh('Company', 'company')}
                ${sortableTh('Location', 'location')}
                ${sortableTh('Cohort', 'cohort')}
                <th>Connections</th>
                ${sortableTh('Compensation', 'salary')}
                ${sortableTh('Application Stage', 'app_status')}
                ${sortableTh('Outcome', 'app_outcome')}
                <th>Resume</th>
                <th style="text-align: right; padding-right: 24px;">Actions</th>
            </tr>
        `;
    } else {
        let statusOrDateHeader = '';
        if (state.currentView === 'All') {
            statusOrDateHeader = sortableTh('Status', 'status');
        } else if (state.currentView === 'Archived') {
            statusOrDateHeader = sortableTh('Archive Reason', 'archive_reason');
        } else {
            statusOrDateHeader = sortableTh('Date Added', 'date_added');
        }
        headerEl.innerHTML = `
            <tr>
                ${sortableTh('Role Title', 'role')}
                ${sortableTh('Company', 'company')}
                ${sortableTh('Location', 'location')}
                ${sortableTh('Cohort', 'cohort')}
                <th>Connections</th>
                ${sortableTh('Compensation', 'salary')}
                ${statusOrDateHeader}
                <th style="text-align: right; padding-right: 24px;">Actions</th>
            </tr>
        `;
    }

    // Attach click handlers to sortable headers
    headerEl.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.getAttribute('data-sort');
            if (state.sortColumn === col) {
                state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortColumn = col;
                state.sortDirection = 'asc';
            }
            render();
        });
    });
    
    elements.jobsListBody.innerHTML = '';
    
    jobs.forEach(job => {
        const row = document.createElement('tr');
        row.addEventListener('click', () => openJobDetails(job));
        row.title = "Click to view details & tracking settings";
        
        const cohortClass = getCohortClass(job.cohort);
        let actionsHtml = getActionsHtml(job);

        // Fetch LinkedIn Connections matches for this row
        const matches = findCompanyConnections(job.company);
        let connectionsCellHtml = '<td style="color: var(--text-muted); font-size: 0.85rem;">None</td>';
        if (matches.length > 0) {
            const first = matches[0];
            const name = `${first.first_name} ${first.last_name}`;
            const linkHtml = `<a href="${first.url}" target="_blank" class="conn-link" onclick="event.stopPropagation();"><i class="fa-brands fa-linkedin"></i> ${name}</a>`;
            if (matches.length > 1) {
                connectionsCellHtml = `
                    <td>
                        <div class="conn-cell-wrapper">
                            ${linkHtml}
                            <span class="conn-badge-pill" onclick="showConnectionsPopover(event, this, '${job.company.replace(/'/g, "\\'")}')" title="Click to view all ${matches.length} connections">+${matches.length - 1}</span>
                        </div>
                    </td>
                `;
            } else {
                connectionsCellHtml = `
                    <td>
                        <div class="conn-cell-wrapper">
                            ${linkHtml}
                        </div>
                    </td>
                `;
            }
        }

        if (state.currentView === 'Consideration') {
            const trackerTagClass = getTrackerTagClass(job.app_status);
            
            // Outcome badge styling
            let outcomeTagClass = 'outcome-pending';
            if (job.app_outcome === 'Accepted') outcomeTagClass = 'outcome-accepted';
            else if (job.app_outcome === 'Rejected') outcomeTagClass = 'outcome-rejected';
            else if (job.app_outcome === 'Not applicable') outcomeTagClass = 'outcome-na';
            
            const salaryCellHtml = job.salary && job.salary !== 'N/A' 
                ? `<span style="font-weight: 600; color: #10b981;">${job.salary}</span>` 
                : `<span style="color: var(--text-muted);">N/A</span>`;

            row.innerHTML = `
                <td>
                    <span class="table-role-title">
                        <a href="${job.url || '#'}" target="_blank" class="job-title-link" onclick="event.stopPropagation();" title="Open external job description">
                            ${job.role}
                            <i class="fa-solid fa-arrow-up-right-from-square title-link-icon"></i>
                        </a>
                    </span>
                </td>
                <td class="table-company">${job.company}</td>
                <td style="color: var(--text-secondary);">${job.location}</td>
                <td><span class="cohort-tag ${cohortClass}" title="${getCohortTooltip(job.cohort)}">${job.cohort}</span></td>
                ${connectionsCellHtml}
                <td>${salaryCellHtml}</td>
                <td>
                    <span class="card-tracker-tag ${trackerTagClass}" style="margin-top:0;">
                        <i class="fa-solid fa-play-circle"></i> ${job.app_status || 'Not Applied'}
                    </span>
                </td>
                <td>
                    <span class="card-outcome-tag ${outcomeTagClass}">
                        ${job.app_outcome || 'Active / Pending'}
                    </span>
                </td>
                <td>
                    ${job.resume_url ? `
                        <a href="${job.resume_url}" target="_blank" class="card-resume-link" onclick="event.stopPropagation();" title="Open PDF Resume in new tab">
                            <i class="fa-solid fa-file-pdf"></i> View Resume
                        </a>
                    ` : `
                        <span class="card-resume-none"><i class="fa-solid fa-file-circle-minus"></i> None</span>
                    `}
                </td>
                <td>
                    <div class="table-actions">
                        ${actionsHtml}
                    </div>
                </td>
            `;
        } else {
            let middleColHtml = '';
            if (state.currentView === 'All') {
                middleColHtml = `<td><span class="card-status-badge status-${job.status.toLowerCase()}">${job.status}</span></td>`;
            } else if (state.currentView === 'Archived') {
                const reasonVal = job.archive_reason || 'User Archived';
                const reasonClass = reasonVal === 'Closed' ? 'reason-closed' : (reasonVal === 'Not meeting Search Criteria' ? 'reason-criteria' : 'reason-user');
                middleColHtml = `<td><span class="archive-reason-tag ${reasonClass}">${reasonVal}</span></td>`;
            } else {
                middleColHtml = `<td style="color: var(--text-muted); font-size: 0.85rem;">${job.date_added}</td>`;
            }
            
            const salaryCellHtml = job.salary && job.salary !== 'N/A' 
                ? `<span style="font-weight: 600; color: #10b981;">${job.salary}</span>` 
                : `<span style="color: var(--text-muted);">N/A</span>`;

            row.innerHTML = `
                <td>
                    <span class="table-role-title">
                        <a href="${job.url || '#'}" target="_blank" class="job-title-link" onclick="event.stopPropagation();" title="Open external job description">
                            ${job.role}
                            <i class="fa-solid fa-arrow-up-right-from-square title-link-icon"></i>
                        </a>
                    </span>
                </td>
                <td class="table-company">${job.company}</td>
                <td style="color: var(--text-secondary);">${job.location}</td>
                <td><span class="cohort-tag ${cohortClass}" title="${getCohortTooltip(job.cohort)}">${job.cohort}</span></td>
                ${connectionsCellHtml}
                <td>${salaryCellHtml}</td>
                ${middleColHtml}
                <td>
                    <div class="table-actions">
                        ${actionsHtml}
                    </div>
                </td>
            `;
        }
        
        elements.jobsListBody.appendChild(row);
    });
}

// Generate action buttons
function getActionsHtml(job) {
    const detailsBtn = `
        <button class="btn-icon action-details" title="View Details" onclick="event.stopPropagation(); openJobDetailsById(${job.id})">
            <i class="fa-solid fa-circle-info"></i>
        </button>
    `;
    
    if (job.status === 'Lead') {
        return `
            ${detailsBtn}
            <button class="btn-icon action-star" title="Add to Consideration" onclick="event.stopPropagation(); updateJobStatus(${job.id}, 'Consideration')">
                <i class="fa-solid fa-star"></i>
            </button>
            <button class="btn-icon action-archive" title="Archive Lead" onclick="event.stopPropagation(); updateJobStatus(${job.id}, 'Archived')">
                <i class="fa-solid fa-box-archive"></i>
            </button>
        `;
    } else if (job.status === 'Consideration') {
        return `
            ${detailsBtn}
            <button class="btn-icon action-restore" title="Remove back to Leads" onclick="event.stopPropagation(); updateJobStatus(${job.id}, 'Lead')">
                <i class="fa-solid fa-undo"></i>
            </button>
            <button class="btn-icon action-archive" title="Archive Lead" onclick="event.stopPropagation(); updateJobStatus(${job.id}, 'Archived')">
                <i class="fa-solid fa-box-archive"></i>
            </button>
        `;
    } else if (job.status === 'Archived') {
        return `
            ${detailsBtn}
            <button class="btn-icon action-restore" title="Restore to Leads" onclick="event.stopPropagation(); updateJobStatus(${job.id}, 'Lead')">
                <i class="fa-solid fa-rotate-left"></i>
            </button>
            <button class="btn-icon action-delete" style="color: #ef4444;" title="Delete Listing Permanently" onclick="event.stopPropagation(); deleteJobListing(${job.id})">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `;
    }
    return '';
}

// Open Job Details Modal
async function openJobDetails(job) {
    state.selectedJob = job;
    
    // Set static details
    elements.modalCohort.textContent = job.cohort;
    elements.modalCohort.className = `modal-cohort-tag ${getCohortClass(job.cohort)}`;
    elements.modalCohort.title = getCohortTooltip(job.cohort);
    elements.modalDate.textContent = `Added ${job.date_added}`;
    elements.modalRoleTitle.textContent = job.role;
    elements.modalCompany.textContent = job.company;
    elements.modalLocText.textContent = job.location;
    
    // Reset apply link
    elements.modalJobLink.href = job.url || '#';
    if (!job.url || isPlaceholderUrl(job.url)) {
        elements.modalJobLink.classList.add('btn-outline');
        elements.modalJobLink.classList.remove('btn-primary');
        elements.modalJobLink.querySelector('span').textContent = 'Search Company Careers Portal';
    } else {
        elements.modalJobLink.classList.add('btn-primary');
        elements.modalJobLink.classList.remove('btn-outline');
        elements.modalJobLink.querySelector('span').textContent = 'Apply on Careers Site';
    }

    // Set modal footer actions based on status
    let footerActionsHtml = '';
    if (job.status === 'Lead') {
        footerActionsHtml = `
            <button class="btn btn-primary" onclick="updateJobStatus(${job.id}, 'Consideration')">
                <i class="fa-solid fa-star"></i>
                <span>Add to Consideration</span>
            </button>
            <button class="btn btn-outline" onclick="updateJobStatus(${job.id}, 'Archived')">
                <i class="fa-solid fa-box-archive"></i>
                <span>Archive</span>
            </button>
        `;
    } else if (job.status === 'Consideration') {
        footerActionsHtml = `
            <button class="btn btn-outline" onclick="updateJobStatus(${job.id}, 'Lead')">
                <i class="fa-solid fa-undo"></i>
                <span>Move back to Leads</span>
            </button>
            <button class="btn btn-outline" onclick="updateJobStatus(${job.id}, 'Archived')">
                <i class="fa-solid fa-box-archive"></i>
                <span>Archive</span>
            </button>
        `;
    } else if (job.status === 'Archived') {
        footerActionsHtml = `
            <button class="btn btn-primary" onclick="updateJobStatus(${job.id}, 'Lead')">
                <i class="fa-solid fa-rotate-left"></i>
                <span>Restore to Leads</span>
            </button>
            <button class="btn btn-outline" style="border-color: #ef4444; color: #ef4444;" onclick="deleteJobListing(${job.id})">
                <i class="fa-solid fa-trash-can"></i>
                <span>Delete Permanently</span>
            </button>
        `;
    }
    elements.modalFooterActions.innerHTML = footerActionsHtml;

    // Toggle Tracking Tab display: only show if in Consideration Set
    if (job.status === 'Consideration') {
        elements.modalTabTracking.style.display = 'block';
        
        // Populate tracking fields
        elements.trackStatus.value = job.app_status || 'Not Applied';
        elements.trackOutcome.value = job.app_outcome || 'Active / Pending';
        elements.trackResume.value = job.resume_url || '';
        
        if (job.resume_url) {
            elements.btnViewResume.href = job.resume_url;
            elements.btnViewResume.style.display = 'inline-flex';
        } else {
            elements.btnViewResume.style.display = 'none';
        }
    } else {
        elements.modalTabTracking.style.display = 'none';
    }

    // Toggle Referrals Tab display: only show if in Consideration Set and has matching connections
    const matches = findCompanyConnections(job.company);
    const modalTabReferrals = document.getElementById('modal-tab-referrals');
    if (job.status === 'Consideration' && matches.length > 0) {
        if (modalTabReferrals) modalTabReferrals.style.display = 'block';
        populateReferralsTab(job, matches);
    } else {
        if (modalTabReferrals) modalTabReferrals.style.display = 'none';
    }

    // Reset modal tabs to Description
    elements.modalTabs.forEach(t => t.classList.remove('active'));
    elements.tabPanes.forEach(p => p.classList.remove('active'));
    elements.modalTabs[0].classList.add('active');
    elements.tabPanes[0].classList.add('active');

    // Show description skeleton
    elements.descLoader.style.display = 'flex';
    elements.modalDescContent.style.display = 'none';

    // Clear Company Info fields
    elements.compHq.textContent = 'Loading...';
    elements.compFounded.textContent = 'Loading...';
    elements.compRevenue.textContent = 'Loading...';
    elements.compEmployees.textContent = 'Loading...';
    elements.compDomain.textContent = 'Loading...';

    // Open Modal Overlay
    elements.jobModal.classList.add('open');

    // Fetch dynamic details
    fetchJobDescription(job.url);
    fetchInterviewInsights(job.company);
    fetchCompanyMetadata(job.company);
}

// Close Modal
function closeModal() {
    elements.jobModal.classList.remove('open');
    state.selectedJob = null;
}

// Fetch Job description from Server
async function fetchJobDescription(url) {
    try {
        const response = await fetch(`${API_BASE}/api/job-description?url=${encodeURIComponent(url)}`);
        const data = await response.json();
        elements.modalDescContent.innerHTML = data.description;
    } catch (error) {
        console.error(error);
        elements.modalDescContent.innerHTML = `<p class="text-error">Could not load job description. Check your network or open the <a href="${url}" target="_blank" class="inline-link">listing directly</a>.</p>`;
    } finally {
        elements.descLoader.style.display = 'none';
        elements.modalDescContent.style.display = 'block';
    }
}

// Fetch PM Interview Insights
async function fetchInterviewInsights(company) {
    try {
        const response = await fetch(`${API_BASE}/api/insights?company=${encodeURIComponent(company)}`);
        const data = await response.json();
        
        elements.modalInterviewSummary.textContent = `PM candidates evaluating ${company} undergo a highly structured product assessment. Focus areas align with core corporate culture values.`;
        
        elements.modalInterviewStages.innerHTML = '';
        if (data.stages && data.stages.length > 0) {
            data.stages.forEach(stage => {
                const stageEl = document.createElement('div');
                stageEl.className = 'timeline-stage';
                stageEl.innerHTML = `
                    <h4 class="stage-title">${stage.title}</h4>
                    <p class="stage-desc">${stage.desc}</p>
                `;
                elements.modalInterviewStages.appendChild(stageEl);
            });
        } else {
            elements.modalInterviewStages.innerHTML = '<p class="text-secondary">No structured stage outline available.</p>';
        }

        elements.modalInterviewTips.innerHTML = '';
        if (data.tips && data.tips.length > 0) {
            data.tips.forEach(tip => {
                const tipEl = document.createElement('li');
                tipEl.textContent = tip;
                elements.modalInterviewTips.appendChild(tipEl);
            });
        } else {
            elements.modalInterviewTips.innerHTML = '<li>Research the core application platform and review modern product metrics standard frameworks.</li>';
        }
    } catch (error) {
        console.error(error);
        elements.modalInterviewSummary.textContent = 'Could not fetch specific PM insights.';
    }
}

// Fetch Company Metadata
async function fetchCompanyMetadata(company) {
    try {
        const response = await fetch(`${API_BASE}/api/company-info?company=${encodeURIComponent(company)}`);
        const data = await response.json();
        
        elements.compHq.textContent = data.hq || 'N/A';
        elements.compFounded.textContent = data.founded || 'N/A';
        elements.compRevenue.textContent = data.revenue || 'N/A';
        elements.compEmployees.textContent = data.employees || 'N/A';
        elements.compDomain.textContent = data.domain || 'N/A';
    } catch (error) {
        console.error(error);
        elements.compHq.textContent = 'Error';
        elements.compFounded.textContent = 'Error';
        elements.compRevenue.textContent = 'Error';
        elements.compEmployees.textContent = 'Error';
        elements.compDomain.textContent = 'Error';
    }
}

// Verify placeholder URLs
function isPlaceholderUrl(url) {
    if (!url) return true;
    const urlLower = url.toLowerCase();
    const placeholders = [
        "grounding-api-redirect", "search-results", "/search?", "/search/",
        "careers.google.com/jobs/results/?", "careers.microsoft.com",
        "jobs.apple.com", "openai.com/careers", "huggingface/jobs",
        "disneycareers.com", "cockroachlabs.com/careers/jobs",
        "/careers/jobs", "/careers", "/jobs"
    ];
    for (const p of placeholders) {
        if (urlLower.includes(p)) {
            if (urlLower.includes("details/") || urlLower.includes("jobs/") || urlLower.includes("detail/") || urlLower.includes("job/")) {
                continue;
            }
            return true;
        }
    }
    return false;
}

// Parse salary range string into { min, max } numbers (annual)
function parseSalaryRange(salaryStr) {
    if (!salaryStr || salaryStr === 'N/A') return null;
    // Match dollar amounts like $150,000 or $150K
    const matches = salaryStr.match(/\$(\d[\d,]*\.?\d*)\s*[Kk]?/g);
    if (!matches || matches.length === 0) return null;
    
    const nums = matches.map(m => {
        let n = m.replace(/[$,]/g, '');
        if (/[Kk]/.test(m)) {
            n = n.replace(/[Kk]/g, '');
            return parseFloat(n) * 1000;
        }
        return parseFloat(n);
    }).filter(n => !isNaN(n));

    if (nums.length === 0) return null;
    return { min: Math.min(...nums), max: Math.max(...nums) };
}

// Generate a sortable <th> element
function sortableTh(label, dataKey) {
    const isActive = state.sortColumn === dataKey;
    const activeClass = isActive ? ' sort-active' : '';
    let iconClass = 'fa-sort';
    if (isActive) {
        iconClass = state.sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
    }
    return `<th class="sortable${activeClass}" data-sort="${dataKey}">${label} <i class="fa-solid ${iconClass} sort-icon"></i></th>`;
}

// Sort jobs array by column key and direction
function sortJobs(jobs, column, direction) {
    const dir = direction === 'asc' ? 1 : -1;
    return [...jobs].sort((a, b) => {
        let valA, valB;
        if (column === 'salary') {
            const rangeA = parseSalaryRange(a.salary);
            const rangeB = parseSalaryRange(b.salary);
            valA = rangeA ? rangeA.max : -1;
            valB = rangeB ? rangeB.max : -1;
            return (valA - valB) * dir;
        }
        if (column === 'date_added') {
            valA = a.date_added ? new Date(a.date_added).getTime() : 0;
            valB = b.date_added ? new Date(b.date_added).getTime() : 0;
            return (valA - valB) * dir;
        }
        // Text-based sort
        valA = (a[column] || '').toString().toLowerCase();
        valB = (b[column] || '').toString().toLowerCase();
        if (valA < valB) return -1 * dir;
        if (valA > valB) return 1 * dir;
        return 0;
    });
}

// Toast messaging system
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'fa-circle-info';
    if (type === 'success') icon = 'fa-circle-check';
    if (type === 'error') icon = 'fa-circle-exclamation';
    
    toast.innerHTML = `
        <i class="fa-solid ${icon}"></i>
        <div class="toast-message">${message}</div>
    `;
    
    elements.toastContainer.appendChild(toast);
    setTimeout(() => { toast.classList.add('show'); }, 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => { toast.remove(); }, 300);
    }, 4000);
}

// --- LINKEDIN CONNECTIONS LOGIC ---

// Fetch connections from server
async function fetchConnections() {
    try {
        const response = await fetch(`${API_BASE}/api/connections`);
        if (!response.ok) throw new Error('Failed to load connections');
        
        state.connections = await response.json();
        
        // Update sidebar badge
        const badge = document.getElementById('badge-connections');
        if (badge) {
            badge.textContent = state.connections.length;
            badge.style.display = state.connections.length > 0 ? 'inline-block' : 'none';
        }
        
        // Update stats
        const connTotal = document.getElementById('conn-stat-total');
        if (connTotal) connTotal.textContent = state.connections.length;
        
        const uniqueCompanies = new Set(
            state.connections
                .map(c => normalizeCompanyName(c.company))
                .filter(c => c !== '')
        );
        const connCompanies = document.getElementById('conn-stat-companies');
        if (connCompanies) connCompanies.textContent = uniqueCompanies.size;
        
        renderConnectionsTable();
    } catch (error) {
        console.error("Error fetching connections:", error);
    }
}

// Normalize company names for matching
function normalizeCompanyName(name) {
    if (!name) return '';
    return name.toLowerCase()
        .replace(/\b(llc|inc|corp|ltd|co|corporation|incorporated|technologies|services|labs|group|usa|us)\b/gi, '')
        .replace(/[^a-z0-9]/gi, '')
        .trim();
}

// Find matches for a specific company name
function findCompanyConnections(companyName) {
    if (!state.connections || state.connections.length === 0 || !companyName) return [];
    
    const targetNorm = normalizeCompanyName(companyName);
    if (!targetNorm) return [];
    
    return state.connections.filter(c => {
        const connNorm = normalizeCompanyName(c.company);
        if (!connNorm) return false;
        return connNorm.includes(targetNorm) || targetNorm.includes(connNorm);
    });
}

// Render the imported connections table
function renderConnectionsTable() {
    const tbody = document.getElementById('connections-list-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    const query = (state.connSearchQuery || '').trim().toLowerCase();
    const filtered = state.connections.filter(c => {
        if (!query) return true;
        const name = `${c.first_name} ${c.last_name}`.toLowerCase();
        const comp = (c.company || '').toLowerCase();
        const pos = (c.position || '').toLowerCase();
        return name.includes(query) || comp.includes(query) || pos.includes(query);
    });
    
    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="table-empty">
                    ${query ? 'No matching contacts found.' : 'No connections imported. Upload a CSV to get started.'}
                </td>
            </tr>
        `;
        return;
    }
    
    filtered.forEach(c => {
        const row = document.createElement('tr');
        const name = `${c.first_name} ${c.last_name}`;
        
        row.innerHTML = `
            <td>
                <a href="${c.url}" target="_blank" class="conn-link">
                    <i class="fa-brands fa-linkedin"></i> ${name}
                </a>
            </td>
            <td style="color: var(--text-primary); font-weight: 500;">${c.company || 'N/A'}</td>
            <td style="font-size: 0.82rem;">${c.position || 'N/A'}</td>
        `;
        tbody.appendChild(row);
    });
}

// Handle connections CSV upload
async function handleConnectionsUpload(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    // Retrieve upload mode setting (replace or append)
    const modeSelector = document.querySelector('input[name="upload-mode"]:checked');
    const mode = modeSelector ? modeSelector.value : 'replace';
    formData.append('mode', mode);
    
    showToast('Uploading and parsing connections...', 'info');
    
    try {
        const response = await fetch(`${API_BASE}/api/connections/upload`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to upload file');
        
        showToast(data.message || 'Connections uploaded successfully!', 'success');
        await fetchConnections();
        
        // Re-render the main lists to show matching badges
        render();
    } catch (error) {
        console.error("Upload error:", error);
        showToast(error.message || 'Error uploading file.', 'error');
    }
}

// Clear connections database
async function clearConnections() {
    if (!confirm('Are you sure you want to clear your connections network? This will remove all imported contacts.')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/connections/clear`, {
            method: 'POST'
        });
        const data = await response.json();
        
        if (!response.ok) throw new Error(data.error || 'Failed to clear connections');
        
        showToast('Connections database cleared.', 'success');
        await fetchConnections();
        render();
    } catch (error) {
        console.error("Clear error:", error);
        showToast('Error clearing connections.', 'error');
    }
}

// Populate modal referrals tab
function populateReferralsTab(job, matches) {
    const tbody = document.getElementById('referrals-list-body');
    const textarea = document.getElementById('referral-message-draft');
    if (!tbody || !textarea) return;
    
    tbody.innerHTML = '';
    textarea.value = '';
    
    matches.forEach((c, idx) => {
        const row = document.createElement('tr');
        row.setAttribute('data-index', idx);
        
        const name = `${c.first_name} ${c.last_name}`;
        
        row.innerHTML = `
            <td style="text-align: center; vertical-align: middle;">
                <input type="radio" name="referral-select" value="${idx}" class="referrals-radio" ${idx === 0 ? 'checked' : ''}>
            </td>
            <td>
                <a href="${c.url}" target="_blank" class="conn-link" onclick="event.stopPropagation();">
                    <i class="fa-brands fa-linkedin"></i> ${name}
                </a>
            </td>
            <td style="font-size: 0.8rem;">${c.position || 'N/A'}</td>
        `;
        
        // Select row on click
        row.addEventListener('click', () => {
            const radio = row.querySelector('.referrals-radio');
            if (radio) {
                radio.checked = true;
                updateSelection(idx);
            }
        });
        
        tbody.appendChild(row);
    });
    
    // Helper to update selected row styling and generate message
    function updateSelection(index) {
        const rows = tbody.querySelectorAll('tr');
        rows.forEach(r => r.classList.remove('selected'));
        
        const selectedRow = tbody.querySelector(`tr[data-index="${index}"]`);
        if (selectedRow) selectedRow.classList.add('selected');
        
        const connection = matches[index];
        textarea.value = generateReferralMessage(connection, job);
    }
    
    // Generate draft for the first element by default
    if (matches.length > 0) {
        updateSelection(0);
    }
    
    // Listen for radio button changes
    tbody.querySelectorAll('.referrals-radio').forEach(radio => {
        radio.addEventListener('change', (e) => {
            updateSelection(parseInt(e.target.value));
        });
    });
}

// Generate Outreach draft text
function generateReferralMessage(connection, job) {
    const name = connection.first_name || 'there';
    const myName = "Vamsi";
    const roleTitle = job.role;
    const company = job.company;
    const jobUrl = job.url && !isPlaceholderUrl(job.url) ? job.url : '';
    
    let urlSentence = '';
    if (jobUrl) {
        urlSentence = ` Here is the listing for reference: ${jobUrl}\n\n`;
    }
    
    return `Hi ${name},\n\nI hope you're doing well! I saw that you're working at ${company} as a ${connection.position || 'Professional'}.\n\nI'm currently looking for new opportunities and noticed an exciting opening for a "${roleTitle}" role at ${company}.${urlSentence}Given your experience there, I would love to get your perspective on the team culture and see if you might be open to referring me for this position. I'd be happy to share my resume and a brief summary of my background.\n\nLet me know if you have a few minutes to connect sometime soon. Thanks so much for your time and help!\n\nBest regards,\n${myName}`;
}

// Copy draft to clipboard
async function copyReferralMessage() {
    const draftTextarea = document.getElementById('referral-message-draft');
    const copyBtn = document.getElementById('btn-copy-referral');
    if (!draftTextarea || !draftTextarea.value) return;
    
    try {
        await navigator.clipboard.writeText(draftTextarea.value);
        const originalHtml = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        copyBtn.disabled = true;
        setTimeout(() => {
            copyBtn.innerHTML = originalHtml;
            copyBtn.disabled = false;
        }, 2000);
        showToast('Referral draft copied to clipboard!', 'success');
    } catch (err) {
        console.error('Failed to copy text: ', err);
        showToast('Failed to copy to clipboard.', 'error');
    }
}

// Global helper to open job details by ID from string attributes
window.openJobDetailsById = function(id) {
    const job = state.allJobs.find(j => j.id === id);
    if (job) openJobDetails(job);
};

// Reusable connections popover pop-up logic
function showConnectionsPopover(e, element, companyName) {
    e.stopPropagation();
    
    // Remove existing popover if present
    const existing = document.querySelector('.connections-popover');
    if (existing) {
        existing.remove();
        if (existing.getAttribute('data-origin-id') === element.id) {
            return;
        }
    }
    
    const matches = findCompanyConnections(companyName);
    if (matches.length === 0) return;
    
    if (!element.id) {
        element.id = 'conn-' + Math.random().toString(36).substr(2, 9);
    }
    
    const popover = document.createElement('div');
    popover.className = 'connections-popover';
    popover.setAttribute('data-origin-id', element.id);
    
    const header = document.createElement('div');
    header.className = 'popover-header';
    header.innerHTML = `
        <span>CONNECTIONS AT ${companyName.toUpperCase()} (${matches.length})</span>
        <span class="close-btn"><i class="fa-solid fa-xmark"></i></span>
    `;
    header.querySelector('.close-btn').addEventListener('click', (evt) => {
        evt.stopPropagation();
        popover.remove();
    });
    
    const body = document.createElement('div');
    body.className = 'popover-body';
    
    matches.forEach(c => {
        const item = document.createElement('div');
        item.className = 'popover-item';
        
        const name = `${c.first_name} ${c.last_name}`;
        item.innerHTML = `
            <a href="${c.url}" target="_blank">
                <i class="fa-brands fa-linkedin"></i> ${name}
            </a>
            <span>${c.position || 'Professional'}</span>
        `;
        body.appendChild(item);
    });
    
    popover.appendChild(header);
    popover.appendChild(body);
    document.body.appendChild(popover);
    
    // Position alignment relative to viewport scroll settings
    const rect = element.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    
    let top = rect.bottom + scrollY + 8;
    let left = rect.left + scrollX;
    
    const popoverWidth = 280;
    if (left + popoverWidth > window.innerWidth) {
        left = window.innerWidth - popoverWidth - 16;
    }
    
    const popoverHeight = popover.offsetHeight || 180;
    if (rect.bottom + popoverHeight > window.innerHeight) {
        top = rect.top + scrollY - popoverHeight - 8;
    }
    
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    
    const clickOutsideHandler = (evt) => {
        if (!popover.contains(evt.target) && evt.target !== element && !element.contains(evt.target)) {
            popover.remove();
            document.removeEventListener('click', clickOutsideHandler);
        }
    };
    
    setTimeout(() => {
        document.addEventListener('click', clickOutsideHandler);
    }, 10);
}

// Bind to window scope so onclick string attribute handles it correctly
window.showConnectionsPopover = showConnectionsPopover;
