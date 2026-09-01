/* GERD Diet Meal Planner — Main Application Module */
const API = {
    get: (url) => fetch(url).then(r => r.json()),
    post: (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json()),
    put: (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
    del: (url) => fetch(url, { method: 'DELETE' }),
};

const DEFAULT_IMG = '/resources/default_meal_img.jpg';
let currentMealPlan = [];
let allFoods = [];
let allMeals = [];
let allFavorites = [];
let availableCategories = [];
let scrapePollInterval = null;

// Pagination state
let foodPage = 1;
let mealPage = 1;
let favPage = 1;
const PAGE_SIZE = 50;

// ─── UI Utilities ────────────────────────────────
function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s || ''; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function showNotification(title, message) {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const alert = document.createElement('div');
    alert.className = 'alert-shadcn';
    alert.innerHTML = `
        <button class="alert-shadcn-close" title="Dismiss">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="alert-shadcn-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            ${title}
        </div>
        <div class="alert-shadcn-description">${message}</div>
    `;

    const dismiss = () => {
        if (autoDismissTimer) clearTimeout(autoDismissTimer);
        alert.classList.add('fade-out');
        setTimeout(() => alert.remove(), 300);
    };

    // Add progress bar for 15s timeout
    const progress = document.createElement('div');
    progress.className = 'alert-shadcn-progress';
    alert.appendChild(progress);

    let autoDismissTimer = setTimeout(dismiss, 15000);

    const closeBtn = alert.querySelector('.alert-shadcn-close');
    closeBtn.onclick = dismiss;

    container.appendChild(alert);
}

function showConfirmDialog(title, message, confirmText = 'Delete') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const confirmBtn = document.getElementById('confirm-modal-confirm');
        const cancelBtn = document.getElementById('confirm-modal-cancel');

        titleEl.textContent = title;
        messageEl.textContent = message;
        confirmBtn.textContent = confirmText;

        const cleanup = () => {
            modal.classList.remove('visible');
            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
        };

        confirmBtn.onclick = () => {
            cleanup();
            resolve(true);
        };

        cancelBtn.onclick = () => {
            cleanup();
            resolve(false);
        };

        modal.classList.add('visible');
    });
}

// ─── Quantity Helpers ─────────────────────────────
function parseQtyJS(qtyStr) {
    if (!qtyStr) return 0;
    const unicodeMap = {
        '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
        '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅛': 0.125,
        '⅜': 0.375, '⅝': 0.625, '⅞': 0.875
    };

    let total = 0;
    let normalized = qtyStr;
    Object.keys(unicodeMap).forEach(u => {
        normalized = normalized.replace(u, ' ' + unicodeMap[u]);
    });

    let parts = normalized.split(/\s+/);
    parts.forEach(p => {
        if (!p) return;
        if (p.includes('/')) {
            let [n, d] = p.split('/');
            total += (parseFloat(n) / parseFloat(d)) || 0;
        } else {
            total += parseFloat(p) || 0;
        }
    });
    return total;
}

function humanizeQtyJS(val) {
    if (val === null || val === undefined || isNaN(val)) return '';
    if (val === 0) return '0';
    if (Number.isInteger(val)) return val.toString();

    const whole = Math.floor(val);
    const fraction = val - whole;

    if (fraction < 0.01) return whole.toString();

    const common = [
        { v: 0.5, s: '½' }, { v: 0.3333, s: '⅓' }, { v: 0.6666, s: '⅔' },
        { v: 0.25, s: '¼' }, { v: 0.75, s: '¾' }, { v: 0.2, s: '⅕' },
        { v: 0.4, s: '⅖' }, { v: 0.6, s: '⅗' }, { v: 0.8, s: '⅘' },
        { v: 0.125, s: '⅛' }, { v: 0.375, s: '⅜' }, { v: 0.625, s: '⅝' },
        { v: 0.875, s: '⅞' }
    ];

    let best = common[0];
    let minDiff = Math.abs(fraction - common[0].v);

    for (let i = 1; i < common.length; i++) {
        let diff = Math.abs(fraction - common[i].v);
        if (diff < minDiff) {
            minDiff = diff;
            best = common[i];
        }
    }

    if (minDiff < 0.02) {
        return (whole > 0 ? whole + ' ' : '') + best.s;
    }

    return val.toFixed(1).replace(/\.0$/, '');
}

function renderPagination(containerId, totalPages, currentPage, onPageChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    let html = `
        <div class="pagination-container">
            <button class="pagination-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="${onPageChange}(${currentPage - 1})">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                Previous
            </button>
            <div class="pagination-pages">
    `;

    const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

    let pages = [];
    if (totalPages <= 7) {
        pages = range(1, totalPages);
    } else {
        if (currentPage <= 4) {
            pages = [...range(1, 5), '...', totalPages];
        } else if (currentPage >= totalPages - 3) {
            pages = [1, '...', ...range(totalPages - 4, totalPages)];
        } else {
            pages = [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
        }
    }

    pages.forEach(p => {
        if (p === '...') {
            html += `<span class="pagination-ellipsis">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </span>`;
        } else {
            html += `<button class="pagination-btn ${p === currentPage ? 'active' : ''}" onclick="${onPageChange}(${p})">${p}</button>`;
        }
    });

    html += `
            </div>
            <button class="pagination-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="${onPageChange}(${currentPage + 1})">
                Next
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            </button>
        </div>
    `;
    container.innerHTML = html;
}

// ─── Tab Navigation ────────────────────────────────
function switchTab(tabName) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (!btn) return;

    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const tab = document.getElementById('tab-' + tabName);
    if (tab) tab.classList.add('active');

    sessionStorage.setItem('selectedTab', tabName);

    if (tabName === 'home') loadWeeklyPlan();
    if (tabName === 'food-library') loadFoods();
    if (tabName === 'meal-library') loadMeals();
    if (tabName === 'favorites') loadFavorites();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ─── HOME: Weekly Meal Plan ────────────────────────
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// ─── Global State for Overlays ──────────────────────
let activePopover = null;
let activeCommand = null;

// Global listeners for closing overlays
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closePopover();
        closeCommand();
    }
});

document.addEventListener('click', (e) => {
    if (activePopover && !activePopover.contains(e.target)) {
        closePopover();
    }
});

function closePopover() {
    if (activePopover) {
        activePopover.remove();
        activePopover = null;
    }
}

function closeCommand() {
    if (activeCommand) {
        activeCommand.remove();
        activeCommand = null;
    }
}

let currentWeekStart = new Date();
// Adjust to previous Monday
currentWeekStart.setDate(currentWeekStart.getDate() - (currentWeekStart.getDay() === 0 ? 6 : currentWeekStart.getDay() - 1));
currentWeekStart.setHours(0, 0, 0, 0);
const REAL_WEEK_START = new Date(currentWeekStart);

function getWeekString(date) {
    const end = new Date(date);
    end.setDate(end.getDate() + 6);
    const fmt = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    return `${fmt(date)} - ${fmt(end)}`;
}
function getISODate(date) {
    return date.toISOString().split('T')[0];
}

function getDomain(url) {
    if (!url) return "";
    try {
        const domain = new URL(url).hostname.replace('www.', '');
        return domain;
    } catch (e) { return ""; }
}

function getShortDomain(url) {
    if (!url) return "";
    try {
        let hostname = new URL(url).hostname.replace('www.', '');
        if (hostname.includes('samsungfood.com')) return 'samsungfood';

        const parts = hostname.split('.');
        return parts.length >= 2 ? parts[0] : hostname;
    } catch (e) { return ""; }
}

function updateWeekDropdown() {
    const dropdown = document.getElementById('week-dropdown');
    const selectedVal = getISODate(currentWeekStart);
    dropdown.innerHTML = '';

    // Always show +-3 weeks relative to REAL_WEEK_START (Fixed list)
    for (let i = -3; i <= 3; i++) {
        const d = new Date(REAL_WEEK_START);
        d.setDate(d.getDate() + (i * 7));
        const opt = document.createElement('option');
        opt.value = getISODate(d);
        opt.textContent = getWeekString(d);
        if (opt.value === selectedVal) opt.selected = true;
        dropdown.appendChild(opt);
    }
}

async function loadWeeklyPlan() {
    const dateStr = getISODate(currentWeekStart);
    try {
        const data = await API.get(`/api/meal-plan/week/${dateStr}`);
        currentMealPlan = data.slots || [];
        renderWeeklyPlan();
    } catch (e) { console.error("Failed to load plan", e); }
}

document.getElementById('btn-prev-week').addEventListener('click', () => {
    const nextDate = new Date(currentWeekStart);
    nextDate.setDate(nextDate.getDate() - 7);
    const diffWeeks = Math.round((nextDate - REAL_WEEK_START) / (7 * 24 * 60 * 60 * 1000));
    if (diffWeeks >= -3) {
        currentWeekStart = nextDate;
        updateWeekDropdown();
        loadWeeklyPlan();
    }
});
document.getElementById('btn-next-week').addEventListener('click', () => {
    const nextDate = new Date(currentWeekStart);
    nextDate.setDate(nextDate.getDate() + 7);
    const diffWeeks = Math.round((nextDate - REAL_WEEK_START) / (7 * 24 * 60 * 60 * 1000));
    if (diffWeeks <= 3) {
        currentWeekStart = nextDate;
        updateWeekDropdown();
        loadWeeklyPlan();
    }
});
document.getElementById('week-dropdown').addEventListener('change', (e) => {
    currentWeekStart = new Date(e.target.value);
    updateWeekDropdown();
    loadWeeklyPlan();
});

document.getElementById('btn-generate-plan').addEventListener('click', async function () {
    this.classList.add('loading');
    this.innerHTML = '<span class="loading-spinner"></span> Generating...';
    try {
        const dateStr = getISODate(currentWeekStart);
        await API.post(`/api/meal-plan/generate?start_date=${dateStr}`);
        await loadWeeklyPlan();
    } catch (e) { alert('Failed to generate plan. Make sure you have meals in the library.'); }
    this.classList.remove('loading');
    this.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg> Generate Meal Plan';
});

async function refreshMealSlot(date, mealType) {
    try {
        const data = await API.post(`/api/meal-plan/refresh?date=${date}&meal_type=${mealType}`);
        if (data.status === 'success') {
            await loadWeeklyPlan();
        }
    } catch (e) { alert("Failed to refresh meal."); }
}
window.refreshMealSlot = refreshMealSlot;

function renderWeeklyPlan() {
    const grid = document.getElementById('week-grid');
    if (!currentMealPlan.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>No Meal Plan Yet</h3><p>Click Generate Meal Plan to create a GERD-safe weekly plan.</p></div>';
        return;
    }
    grid.innerHTML = '';
    DAYS.forEach(day => {
        const container = document.createElement('div');
        container.className = 'day-row-container';

        const labelDiv = document.createElement('div');
        labelDiv.className = 'day-label';
        labelDiv.textContent = day; // Full name
        container.appendChild(labelDiv);

        const dayGrid = document.createElement('div');
        dayGrid.className = 'day-grid';

        const slots = currentMealPlan.filter(s => s.day === day);

        // 1. Breakfast Column
        const bCol = document.createElement('div');
        bCol.className = 'meal-col';
        const bSlot = slots.find(s => s.meal_type === 'breakfast' && s.slot_index === 0);
        if (bSlot) bCol.appendChild(createMealCard(bSlot.meal, 'breakfast', bSlot.date, 'breakfast_0'));
        dayGrid.appendChild(bCol);

        // 2. Lunch Column
        const lCol = document.createElement('div');
        lCol.className = 'meal-col';
        [0, 1, 2].forEach(i => {
            const s = slots.find(sl => sl.meal_type === 'lunch' && sl.slot_index === i);
            if (s) lCol.appendChild(createMealCard(s.meal, i === 0 ? 'lunch-dinner' : 'compact', s.date, `lunch_${i}`));
        });
        dayGrid.appendChild(lCol);

        // 3. Dinner Column
        const dCol = document.createElement('div');
        dCol.className = 'meal-col';
        [0, 1, 2].forEach(i => {
            const s = slots.find(sl => sl.meal_type === 'dinner' && sl.slot_index === i);
            if (s) dCol.appendChild(createMealCard(s.meal, i === 0 ? 'lunch-dinner' : 'compact', s.date, `dinner_${i}`));
        });
        dayGrid.appendChild(dCol);

        container.appendChild(dayGrid);
        grid.appendChild(container);
    });
}

function createMealCard(meal, type, dateStr, mealTypeStr) {
    const card = document.createElement('div');
    const isCompact = type === 'compact';
    const isMissing = !meal || !meal.name;

    card.className = isCompact ? 'meal-card-compact' : `meal-card-full ${type}`;
    if (!isMissing && meal.avoid_percentage > 25) card.classList.add('has-avoid');
    if (!isMissing) card.dataset.mealId = meal.id;

    // Hover tooltip (only if meal exists)
    if (!isMissing) {
        card.addEventListener('mouseenter', e => showTooltip(e, meal));
        card.addEventListener('mousemove', e => moveTooltip(e));
        card.addEventListener('mouseleave', hideTooltip);
    }

    const favIcon = !isMissing && meal.is_favorite
        ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 0 24 24" fill="currentColor"><path d="M 14.8108 4.2207 C 13.9712 2.8257 11.9488 2.8257 11.1093 4.2207 L 9.0712 7.6074 L 5.2205 8.4992 C 3.6343 8.8666 3.0093 10.79 4.0766 12.0195 L 6.6677 15.0044 L 6.326 18.9423 C 6.1852 20.5644 7.8214 21.7532 9.3205 21.118 L 12.96 19.5761 L 16.5996 21.118 C 18.0987 21.7532 19.7348 20.5644 19.5941 18.9423 L 19.2524 15.0044 L 21.8435 12.0195 C 22.9108 10.79 22.2858 8.8666 20.6997 8.4992 L 16.8489 7.6074 L 14.8108 4.2207 Z"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 0 24 24" fill="currentcolor"><path d="M 14.8108 4.2207 C 13.9712 2.8257 11.9488 2.8257 11.1093 4.2207 L 9.0712 7.6074 L 5.2205 8.4992 C 3.6343 8.8666 3.0093 10.79 4.0766 12.0195 L 6.6677 15.0044 L 6.326 18.9423 C 6.1852 20.5644 7.8214 21.7532 9.3205 21.118 L 12.96 19.5761 L 16.5996 21.118 C 18.0987 21.7532 19.7348 20.5644 19.5941 18.9423 L 19.2524 15.0044 L 21.8435 12.0195 C 22.9108 10.79 22.2858 8.8666 20.6997 8.4992 L 16.8489 7.6074 L 14.8108 4.2207 Z"/></svg>';

    const refreshIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 0 24 24" fill="currentColor"><path d="M 12.6 2.1 C 6.804 2.1 2.1 6.804 2.1 12.6 C 2.1 18.396 6.804 23.1 12.6 23.1 C 18.396 23.1 23.1 18.396 23.1 12.6 C 23.1 6.804 18.396 2.1 12.6 2.1 Z M 6.93 11.7915 C 7.1085 10.542 7.665 9.4185 8.5365 8.5365 C 10.6365 6.447 13.944 6.3315 16.191 8.1585 V 7.161 C 16.191 6.7305 16.548 6.3735 16.9785 6.3735 C 17.409 6.3735 17.766 6.7305 17.766 7.161 V 9.9645 C 17.766 10.395 17.409 10.752 16.9785 10.752 H 14.175 C 13.7445 10.752 13.3875 10.395 13.3875 9.9645 C 13.3875 9.534 13.7445 9.177 14.175 9.177 H 14.9625 C 13.335 8.043 11.088 8.2005 9.639 9.6495 C 9.009 10.2795 8.61 11.0985 8.4735 12.012 C 8.421 12.4005 8.085 12.684 7.6965 12.684 C 7.6545 12.684 7.623 12.684 7.581 12.6735 C 7.1715 12.621 6.867 12.222 6.93 11.7915 Z M 16.6635 16.6635 C 15.54 17.787 14.07 18.3435 12.6 18.3435 C 11.319 18.3435 10.0485 17.892 8.9985 17.0415 V 18.0285 C 8.9985 18.459 8.6415 18.816 8.211 18.816 C 7.7805 18.816 7.4235 18.459 7.4235 18.0285 V 15.225 C 7.4235 14.7945 7.7805 14.4375 8.211 14.4375 H 11.0145 C 11.445 14.4375 11.802 14.7945 11.802 15.225 C 11.802 15.6555 11.445 16.0125 11.0145 16.0125 H 10.227 C 11.8545 17.1465 14.1015 16.989 15.5505 15.54 C 16.1805 14.91 16.5795 14.091 16.716 13.1775 C 16.779 12.747 17.1675 12.4425 17.6085 12.5055 C 18.039 12.5685 18.333 12.9675 18.2805 13.398 C 18.0915 14.6685 17.535 15.792 16.6635 16.6635 Z"/></svg>';
    const editIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" viewBox="0 0 24 24" fill="currentColor"><path d="M15.9087 3.87352C16.4681 3.31421 17.2266 3 18.0176 3C18.4093 3 18.7971 3.07714 19.1589 3.22702C19.5208 3.3769 19.8495 3.59658 20.1265 3.87352C20.4034 4.15046 20.6231 4.47924 20.773 4.84108C20.9229 5.20292 21 5.59074 21 5.98239C21 6.37404 20.9229 6.76186 20.773 7.1237C20.6231 7.48554 20.4034 7.81432 20.1265 8.09126L19.0231 9.19466C18.6326 9.58519 17.9994 9.58519 17.6089 9.19467L14.8053 6.39114C14.4148 6.00062 14.4148 5.36745 14.8053 4.97693L15.9087 3.87352ZM13.3911 7.80536C13.0006 7.41483 12.3674 7.41483 11.9769 7.80536L5.01084 14.7714C4.37004 15.4122 3.91545 16.2151 3.69566 17.0943L3.02986 19.7575C2.94467 20.0982 3.04452 20.4587 3.2929 20.7071C3.54128 20.9555 3.90177 21.0553 4.24254 20.9701L6.90572 20.3043C7.78488 20.0846 8.58778 19.63 9.22857 18.9892L16.1946 12.0231C16.5852 11.6326 16.5852 10.9994 16.1946 10.6089L13.3911 7.80536Z M12 20C12 19.4477 12.4477 19 13 19L20 19C20.5523 19 21 19.4477 21 20C21 20.5523 20.5523 21 20 21L13 21C12.4477 21 12 20.5523 12 20Z"/></svg>';

    const formatTime = (h) => {
        if (!h) return '';
        if (h < 1) return Math.round(h * 60) + ' mins';
        if (Number.isInteger(h)) return h + ' hrs';
        return h.toFixed(1) + ' hrs';
    };

    const mealName = isMissing ? 'Meal Deleted' : meal.name;
    const infoStatsHTML = `
        <div class="meal-card-title" onclick="${!isMissing ? `openViewMeal('${meal.id}')` : ''}">${esc(mealName)}</div>
        <div class="meal-card-stats">
            ${!isMissing ? `
                <span class="calorie-tag" ${meal.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>
                    ${(meal.calories !== null && meal.calories !== undefined) ? Math.round(meal.calories) : '---'} kcal${meal.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}
                </span> • ` : ''}
            ${!isMissing ? (meal.ingredient_count || 0) + ' ingredients' : ''}
            ${!isMissing && meal.cook_time_hours ? ' • ' + formatTime(meal.cook_time_hours) : ''}
        </div>
    `;
    const actionsHTML = `
        ${!isMissing ? `
            <button class="btn-icon ${meal.is_favorite ? 'fav-active' : ''}" onclick="event.stopPropagation();toggleFav('${meal.id}',this)" title="Favorite">${favIcon}</button>
        ` : ''}
        <button class="btn-icon" onclick="event.stopPropagation();toggleRefreshPopover(event, '${meal ? meal.id : ''}', '${dateStr}', '${mealTypeStr}')" title="Refresh Meal">${refreshIcon}</button>
    `;

    if (isCompact) {
        card.innerHTML = `
            <div class="meal-card-text">
                ${infoStatsHTML}
            </div>
            <div class="meal-card-actions">
                ${actionsHTML}
            </div>`;
    } else {
        const imgSrc = (!isMissing && meal.image_url) ? meal.image_url : DEFAULT_IMG;
        const sourceDomain = !isMissing && meal.source_url ? getDomain(meal.source_url) : '';

        card.innerHTML = `
            <div class="meal-card-img-wrapper" onclick="${!isMissing ? `openViewMeal('${meal.id}')` : ''}">
                <img class="meal-card-img" src="${esc(imgSrc)}" alt="${esc(mealName)}" onerror="this.src='${DEFAULT_IMG}'">
                <div class="meal-card-gradient meal-card-gradient-top"></div>
                <div class="meal-card-gradient meal-card-gradient-bottom"></div>
                
                ${!isMissing ? `<button class="meal-card-overlay-edit" onclick="event.stopPropagation();openMealModal('edit', '${meal.id}')" title="Edit Meal">${editIcon}</button>` : ''}
                
                ${!isMissing && sourceDomain ? `
                    <a class="meal-card-overlay-link" href="${esc(meal.source_url)}" target="_blank" onclick="event.stopPropagation()">
                        ${esc(sourceDomain)}
                    </a>
                ` : ''}
            </div>
            <div class="meal-card-info-box">
                <div class="meal-card-text">
                    ${infoStatsHTML}
                </div>
                <div class="meal-card-actions">
                    ${actionsHTML}
                </div>
            </div>`;
    }
    return card;
}

// ─── Meal Plan Interactions ────────────────────────
window.toggleRefreshPopover = (event, mealId, dateStr, mealTypeStr) => {
    const button = event.currentTarget;
    const isSameButton = activePopover && activePopover._trigger === button;

    if (activePopover) {
        closePopover();
        if (isSameButton) return;
    }

    const rect = button.getBoundingClientRect();
    const popover = document.createElement('div');
    popover._trigger = button;
    popover.className = 'popover-menu';
    popover.innerHTML = `
        <div class="popover-item" id="btn-select-another">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            Select another meal
        </div>
        <div class="popover-item" id="btn-random-refresh">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M19.9381 13C19.979 12.6724 20 12.3387 20 12C20 7.58172 16.4183 4 12 4C9.49942 4 7.26681 5.14727 5.7998 6.94416M4.06189 11C4.02104 11.3276 4 11.6613 4 12C4 16.4183 7.58172 20 12 20C14.3894 20 16.5341 18.9525 18 17.2916M15 17H18V17.2916M5.7998 4V6.94416M5.7998 6.94416V6.99993L8.7998 7M18 20V17.2916"/></svg>
            Random refresh
        </div>
    `;

    document.body.appendChild(popover);
    activePopover = popover;

    // Position logic
    const popoverWidth = 220;
    popover.style.top = (rect.bottom + window.scrollY + 8) + 'px';
    popover.style.left = (rect.right + window.scrollX - popoverWidth) + 'px';

    // Handlers
    popover.querySelector('#btn-select-another').onclick = () => openMealLibraryCommand(mealId, dateStr, mealTypeStr);
    popover.querySelector('#btn-random-refresh').onclick = () => {
        closePopover();
        refreshMealSlot(dateStr, mealTypeStr);
    };

    event.stopPropagation();
};

async function openMealLibraryCommand(currentMealId, dateStr, mealTypeStr) {
    closePopover();
    if (activeCommand) return;

    const overlay = document.createElement('div');
    overlay.className = 'command-overlay';
    overlay.innerHTML = `
        <div class="command-container glass-panel">
            <div class="command-header">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                <input type="text" class="command-search-input" placeholder="Search recipe name..." id="command-search-input">
            </div>
            <div class="command-list" id="command-results-list">
                <div class="command-loading">Loading meals...</div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    activeCommand = overlay;

    const searchInput = document.getElementById('command-search-input');
    const listContainer = document.getElementById('command-results-list');

    searchInput.focus();

    let currentPage = 1;
    let currentSearch = '';
    let isLoading = false;
    let hasMore = true;

    const loadItems = async (reset = false) => {
        if (isLoading || (!hasMore && !reset)) return;
        isLoading = true;

        if (reset) {
            currentPage = 1;
            listContainer.innerHTML = '<div class="command-loading">Searching...</div>';
            hasMore = true;
            listContainer.scrollTop = 0; // Reset scroll on search
        }

        try {
            console.log(`[LazyLoad] Fetching page ${currentPage} (search: "${currentSearch}")`);
            const data = await API.get(`/api/meals/?page=${currentPage}&page_size=10&search=${encodeURIComponent(currentSearch)}`);
            if (reset) listContainer.innerHTML = '';

            const loaders = listContainer.querySelectorAll('.command-loading');
            loaders.forEach(l => l.remove());

            if (data.items && data.items.length > 0) {
                data.items.forEach(meal => {
                    const item = document.createElement('div');
                    item.className = 'command-item';
                    if (meal.id == currentMealId) item.classList.add('active');

                    item.innerHTML = `
                        <div class="command-item-name">${esc(meal.name)}</div>
                    `;

                    item.onclick = async () => {
                        await replaceSpecificMealSlot(dateStr, mealTypeStr, meal.id);
                        closeCommand();
                    };

                    listContainer.appendChild(item);
                });

                currentPage++;
                hasMore = data.items.length === 10;
            } else {
                if (reset) listContainer.innerHTML = '<div class="command-empty">No meals found.</div>';
                hasMore = false;
            }
        } catch (e) {
            console.error("Error loading meals:", e);
            listContainer.innerHTML = '<div class="command-empty">Error loading meals. Please try again.</div>';
        } finally {
            isLoading = false;
        }

        // AUTO-FILL: If the list is too short to scroll, load more automatically
        // This ensures the scrollbar appears if there are more items to fetch.
        if (hasMore && listContainer.scrollHeight <= listContainer.clientHeight && listContainer.clientHeight > 0) {
            console.log("[LazyLoad] Auto-filling container...");
            await loadItems();
        }
    };

    await loadItems();

    let debounceTimer;
    searchInput.oninput = (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            currentSearch = e.target.value;
            loadItems(true);
        }, 300);
    };

    listContainer.onscroll = () => {
        if (listContainer.scrollTop + listContainer.clientHeight >= listContainer.scrollHeight - 50) {
            loadItems();
        }
    };

    overlay.onclick = (e) => {
        if (e.target === overlay) closeCommand();
    };
}

async function replaceSpecificMealSlot(date, mealType, mealId) {
    try {
        const data = await API.post(`/api/meal-plan/replace-specific?date=${date}&meal_type=${mealType}&meal_id=${mealId}`);
        if (data.status === 'success') {
            await loadWeeklyPlan();
        }
    } catch (e) {
        alert("Failed to replace meal.");
    }
}

// ─── Tooltip ───────────────────────────────────────
const tooltip = document.getElementById('meal-tooltip');
function showTooltip(e, meal) {
    document.getElementById('tooltip-img').src = meal.image_url || DEFAULT_IMG;
    document.getElementById('tooltip-name').textContent = meal.name;
    document.getElementById('tooltip-details').innerHTML =
        `${(meal.calories !== null && meal.calories !== undefined) ? Math.round(meal.calories) + ' kcal' + (meal.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : '') : 'N/A'} · ${meal.ingredient_count || 0} ingredients · ${meal.cook_time_hours || 0}h<br>${meal.source_site || ''}${meal.language === 'vi' ? ' 🇻🇳' : ''}`;
    tooltip.classList.add('visible');
    moveTooltip(e);
}
function moveTooltip(e) {
    const x = Math.min(e.clientX + 16, window.innerWidth - 300);
    const y = Math.min(e.clientY + 16, window.innerHeight - 240);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
}
function hideTooltip() { tooltip.classList.remove('visible'); }

/**
 * Transforms a native <select> into a Shadcn-style custom dropdown.
 */
window.initShadcnSelect = (selectId, options = {}) => {
    const select = document.getElementById(selectId);
    if (!select) return;

    const wrapper = document.createElement('div');
    wrapper.className = `cb-wrapper ${options.className || ''}`;

    const trigger = document.createElement('div');
    trigger.className = 'cb-trigger';
    trigger.innerHTML = `
        <span></span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" class="cb-chevron">
            <path d="m6 9 6 6 6-6" />
        </svg>
    `;
    const displayValue = trigger.querySelector('span');

    const content = document.createElement('div');
    content.className = 'cb-content';

    const list = document.createElement('div');
    list.className = 'cb-list';
    content.appendChild(list);

    wrapper.appendChild(trigger);
    wrapper.appendChild(content);

    select.style.display = 'none';
    select.parentNode.insertBefore(wrapper, select.nextSibling);

    const toggle = (force) => {
        const isOpen = wrapper.classList.toggle('open', force);
        if (isOpen) {
            // Close other open selects
            document.querySelectorAll('.cb-wrapper.open').forEach(w => {
                if (w !== wrapper) w.classList.remove('open');
            });
        }
    };

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });

    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
    });

    const refreshOptions = () => {
        const currentVal = String(select.value);
        list.innerHTML = Array.from(select.options).map(opt => `
            <div class="cb-item ${String(opt.value) === currentVal ? 'selected' : ''}" data-value="${esc(opt.value)}">
                <span>${esc(opt.textContent)}</span>
                ${String(opt.value) === currentVal ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
            </div>
        `).join('');

        const selectedOpt = select.options[select.selectedIndex];
        displayValue.textContent = selectedOpt ? selectedOpt.textContent : (options.placeholder || 'Select...');

        list.querySelectorAll('.cb-item').forEach(item => {
            item.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                select.value = item.dataset.value;
                select.dispatchEvent(new Event('change'));
                wrapper.classList.remove('open');
            };
        });
    };

    const observer = new MutationObserver((mutations) => {
        refreshOptions();
    });
    observer.observe(select, { childList: true, attributes: true });
    select.addEventListener('change', refreshOptions);

    // Initial and periodic refresh to ensure sync
    refreshOptions();
    // Sometimes values change without events in complex frameworks or scripts
    setTimeout(refreshOptions, 100);

    return { refresh: refreshOptions };
};

// ─── Combobox Helper ───────────────────────────────
function initCategoryCombobox() {
    const wrapper = document.getElementById('category-combobox');
    const trigger = document.getElementById('combobox-trigger');
    const searchInput = document.getElementById('combobox-search');
    const list = document.getElementById('combobox-list');
    const empty = document.getElementById('combobox-empty');
    const newValueSpan = document.getElementById('new-category-name');
    const addBtn = document.getElementById('btn-add-new-category');
    const hiddenInput = document.getElementById('food-form-category');
    const displayValue = document.getElementById('combobox-value');

    const toggle = async (force) => {
        if (availableCategories.length === 0) {
            try {
                availableCategories = await API.get('/api/foods/categories');
            } catch (err) {
                console.error("Failed to load categories:", err);
            }
        }
        const isOpen = wrapper.classList.toggle('open', force);
        if (isOpen) {
            // Close other open selects/comboboxes
            document.querySelectorAll('.cb-wrapper.open').forEach(w => {
                if (w !== wrapper) w.classList.remove('open');
            });
            searchInput.value = '';
            renderList('');
            setTimeout(() => searchInput.focus(), 50);
        }
    };

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });

    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
    });

    const select = (val) => {
        hiddenInput.value = val;
        displayValue.textContent = val || 'Select category...';
        wrapper.classList.remove('open');
    };

    const renderList = (filter) => {
        const normalizedFilter = filter.toLowerCase().trim();
        const filtered = availableCategories.filter(c => c.toLowerCase().includes(normalizedFilter));

        list.innerHTML = filtered.map(c => `
            <div class="cb-item ${c === hiddenInput.value ? 'selected' : ''}" data-value="${esc(c)}">
                ${esc(c)}
                ${c === hiddenInput.value ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
            </div>
        `).join('');

        const exactMatch = availableCategories.some(c => c.toLowerCase() === normalizedFilter);

        if (!exactMatch && normalizedFilter) {
            empty.style.display = 'block';
            newValueSpan.textContent = filter;
        } else {
            empty.style.display = 'none';
        }

        list.querySelectorAll('.cb-item').forEach(item => {
            item.addEventListener('click', () => select(item.dataset.value));
        });
    };

    searchInput.addEventListener('input', (e) => renderList(e.target.value));

    addBtn.addEventListener('click', () => {
        const val = searchInput.value.trim();
        if (val) {
            if (!availableCategories.includes(val)) availableCategories.push(val);
            select(val);
        }
    });

    window.setComboboxValue = (val) => {
        hiddenInput.value = val;
        displayValue.textContent = val || 'Select category...';
    };
}
initCategoryCombobox();


// ─── FOOD LIBRARY ──────────────────────────────────
async function loadFoods(page = 1) {
    foodPage = page;
    const cat = document.getElementById('food-category-filter').value;
    const reflux = document.getElementById('food-reflux-filter').value;
    const search = document.getElementById('food-search').value;
    let url = `/api/foods/?page=${foodPage}&page_size=${PAGE_SIZE}&`;
    if (cat) url += `category=${encodeURIComponent(cat)}&`;
    if (reflux) url += `reflux=${reflux}&`;
    if (search) url += `search=${encodeURIComponent(search)}&`;

    const data = await API.get(url);
    allFoods = data.items;
    renderFoods();
    renderPagination('food-pagination', data.total_pages, data.page, 'loadFoods');

    // Load categories
    availableCategories = await API.get('/api/foods/categories');
    const sel = document.getElementById('food-category-filter');
    const current = sel.value;
    sel.innerHTML = '<option value="">All Categories</option>';
    availableCategories.forEach(c => { sel.innerHTML += `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`; });
}

function renderFoods() {
    const grid = document.getElementById('food-grid');
    if (!allFoods.length) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>No Foods Found</h3><p>Add foods or seed from the database.</p></div>'; return; }
    grid.innerHTML = allFoods.map(f => {
        const editIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M15.9087 3.87352C16.4681 3.31421 17.2266 3 18.0176 3C18.4093 3 18.7971 3.07714 19.1589 3.22702C19.5208 3.3769 19.8495 3.59658 20.1265 3.87352C20.4034 4.15046 20.6231 4.47924 20.773 4.84108C20.9229 5.20292 21 5.59074 21 5.98239C21 6.37404 20.9229 6.76186 20.773 7.1237C20.6231 7.48554 20.4034 7.81432 20.1265 8.09126L19.0231 9.19466C18.6326 9.58519 17.9994 9.58519 17.6089 9.19467L14.8053 6.39114C14.4148 6.00062 14.4148 5.36745 14.8053 4.97693L15.9087 3.87352ZM13.3911 7.80536C13.0006 7.41483 12.3674 7.41483 11.9769 7.80536L5.01084 14.7714C4.37004 15.4122 3.91545 16.2151 3.69566 17.0943L3.02986 19.7575C2.94467 20.0982 3.04452 20.4587 3.2929 20.7071C3.54128 20.9555 3.90177 21.0553 4.24254 20.9701L6.90572 20.3043C7.78488 20.0846 8.58778 19.63 9.22857 18.9892L16.1946 12.0231C16.5852 11.6326 16.5852 10.9994 16.1946 10.6089L13.3911 7.80536Z M12 20C12 19.4477 12.4477 19 13 19L20 19C20.5523 19 21 19.4477 21 20C21 20.5523 20.5523 21 20 21L13 21C12.4477 21 12 20.5523 12 20Z"/></svg>';
        const deleteIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M10.1111 2C9.37473 2 8.77778 2.59695 8.77778 3.33333C8.77778 3.70152 8.4793 4 8.11111 4L8 4L5 4C4.44772 4 4 4.44772 4 5C4 5.55228 4.44772 6 5 6L8 6H8.11111L15.8873 6C15.8878 6 15.8884 6 15.8889 6H16L19 6C19.5523 6 20 5.55228 20 5C20 4.44772 19.5523 4 19 4H15.8881C15.5203 3.99956 15.2222 3.70126 15.2222 3.33333C15.2222 2.59695 14.6253 2 13.8889 2H10.1111Z M6 8C5.72035 8 5.45348 8.1171 5.26412 8.32289C5.07477 8.52868 4.98023 8.80436 5.00346 9.08305L5.77422 18.3322C5.94698 20.4054 7.68005 22 9.7604 22H14.2396C16.32 22 18.053 20.4054 18.2258 18.3322L18.9965 9.08305C19.0198 8.80436 18.9252 8.52868 18.7359 8.32289C18.5465 8.1171 18.2797 8 18 8H6Z" fill="currentColor"/></svg>';

        const mealIcons = {
            'breakfast': '🍳',
            'lunch/dinner': '🍲',
            'both': '🍱',
            'none': '✖'
        };
        const mType = f.meal_type || 'none';
        const mIcon = mealIcons[mType] || '🍴';

        return `
        <div class="food-card">
            <h4 title="${esc(f.name)}">${esc(f.name)}</h4>
            <div class="food-category">${esc(f.category)}</div>
            <div class="food-card-meta">
                <span class="food-badge ${f.reflux === 'avoid' ? 'avoid' : f.reflux === 'remedy' ? 'remedy' : 'safe'}">${f.reflux === 'avoid' ? '🚫 Avoid' : f.reflux === 'remedy' ? '💊 Remedy' : '✅ Safe'}</span>
                <span class="food-type-tag">${mIcon} ${esc(mType)}</span>
            </div>
            <div class="food-card-actions">
                <button class="btn-icon" onclick="openEditFood('${f.id}')" title="Edit">${editIcon}</button>
                <button class="btn-icon" onclick="deleteFood('${f.id}')" title="Delete">${deleteIcon}</button>
            </div>
        </div>
        `;
    }).join('');
}

document.getElementById('food-search').addEventListener('input', debounce(() => loadFoods(1), 300));
document.getElementById('food-category-filter').addEventListener('change', () => loadFoods(1));
document.getElementById('food-reflux-filter').addEventListener('change', () => loadFoods(1));

// Food Modal
let editingFoodId = null;
document.getElementById('btn-add-food').addEventListener('click', () => {
    editingFoodId = null;
    document.getElementById('food-modal-title').textContent = 'Add Food';
    document.getElementById('food-form-name').value = '';

    if (window.setComboboxValue) setComboboxValue('');

    const refluxSel = document.getElementById('food-form-reflux');
    refluxSel.value = 'ok';
    refluxSel.dispatchEvent(new Event('change'));

    const mealTypeSel = document.getElementById('food-form-meal-type');
    mealTypeSel.value = 'none';
    mealTypeSel.dispatchEvent(new Event('change'));

    document.getElementById('food-modal').classList.add('visible');
});

window.openEditFood = async (id) => {
    // Ensure allFoods is available and populated
    if (!allFoods || !allFoods.length) {
        await loadFoods();
    }
    const food = allFoods.find(f => String(f.id) === String(id));
    if (!food) {
        console.error("Food not found for id:", id);
        return;
    }
    editingFoodId = id;
    document.getElementById('food-modal-title').textContent = 'Edit Food';
    document.getElementById('food-form-name').value = food.name;

    setComboboxValue(food.category);

    const refluxSel = document.getElementById('food-form-reflux');
    refluxSel.value = food.reflux;
    refluxSel.dispatchEvent(new Event('change'));

    const mealTypeSel = document.getElementById('food-form-meal-type');
    mealTypeSel.value = food.meal_type || 'none';
    mealTypeSel.dispatchEvent(new Event('change'));

    document.getElementById('food-modal').classList.add('visible');
};

document.getElementById('food-modal-save').addEventListener('click', async () => {
    const data = {
        name: document.getElementById('food-form-name').value.trim(),
        category: document.getElementById('food-form-category').value.trim() || 'Uncategorized',
        reflux: document.getElementById('food-form-reflux').value,
        meal_type: document.getElementById('food-form-meal-type').value,
    };
    if (!data.name) return alert('Name is required');
    if (editingFoodId) await API.put(`/api/foods/${editingFoodId}`, data);
    else await API.post('/api/foods/', data);
    document.getElementById('food-modal').classList.remove('visible');
    loadFoods();
});

document.getElementById('food-modal-close').addEventListener('click', () => document.getElementById('food-modal').classList.remove('visible'));
document.getElementById('food-modal-cancel').addEventListener('click', () => document.getElementById('food-modal').classList.remove('visible'));

window.deleteFood = async (id) => {
    const confirmed = await showConfirmDialog('Delete Food', 'Are you sure you want to delete this food item? This action cannot be undone.');
    if (!confirmed) return;
    await API.del(`/api/foods/${id}`);
    loadFoods();
};

// ─── MEAL LIBRARY ──────────────────────────────────
async function loadMeals(page = 1) {
    mealPage = page;
    const search = document.getElementById('meal-search').value;
    let url = `/api/meals/?page=${mealPage}&page_size=${PAGE_SIZE}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    const data = await API.get(url);
    allMeals = data.items;
    renderMealLibrary();
    renderPagination('meal-pagination', data.total_pages, data.page, 'loadMeals');
}

function renderMealLibrary() {
    const grid = document.getElementById('meal-lib-grid');
    if (!allMeals.length) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>No Meals Yet</h3><p>Add meals manually or scrape from recipe sites.</p></div>'; return; }
    grid.innerHTML = allMeals.map(m => {
        const favIcon = m.is_favorite
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 0 24 24" fill="currentColor"><path d="M 14.8108 4.2207 C 13.9712 2.8257 11.9488 2.8257 11.1093 4.2207 L 9.0712 7.6074 L 5.2205 8.4992 C 3.6343 8.8666 3.0093 10.79 4.0766 12.0195 L 6.6677 15.0044 L 6.326 18.9423 C 6.1852 20.5644 7.8214 21.7532 9.3205 21.118 L 12.96 19.5761 L 16.5996 21.118 C 18.0987 21.7532 19.7348 20.5644 19.5941 18.9423 L 19.2524 15.0044 L 21.8435 12.0195 C 22.9108 10.79 22.2858 8.8666 20.6997 8.4992 L 16.8489 7.6074 L 14.8108 4.2207 Z"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 0 24 24" fill="currentcolor"><path d="M 14.8108 4.2207 C 13.9712 2.8257 11.9488 2.8257 11.1093 4.2207 L 9.0712 7.6074 L 5.2205 8.4992 C 3.6343 8.8666 3.0093 10.79 4.0766 12.0195 L 6.6677 15.0044 L 6.326 18.9423 C 6.1852 20.5644 7.8214 21.7532 9.3205 21.118 L 12.96 19.5761 L 16.5996 21.118 C 18.0987 21.7532 19.7348 20.5644 19.5941 18.9423 L 19.2524 15.0044 L 21.8435 12.0195 C 22.9108 10.79 22.2858 8.8666 20.6997 8.4992 L 16.8489 7.6074 L 14.8108 4.2207 Z"/></svg>';
        const editIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" viewBox="0 0 24 24" fill="currentColor"><path d="M15.9087 3.87352C16.4681 3.31421 17.2266 3 18.0176 3C18.4093 3 18.7971 3.07714 19.1589 3.22702C19.5208 3.3769 19.8495 3.59658 20.1265 3.87352C20.4034 4.15046 20.6231 4.47924 20.773 4.84108C20.9229 5.20292 21 5.59074 21 5.98239C21 6.37404 20.9229 6.76186 20.773 7.1237C20.6231 7.48554 20.4034 7.81432 20.1265 8.09126L19.0231 9.19466C18.6326 9.58519 17.9994 9.58519 17.6089 9.19467L14.8053 6.39114C14.4148 6.00062 14.4148 5.36745 14.8053 4.97693L15.9087 3.87352ZM13.3911 7.80536C13.0006 7.41483 12.3674 7.41483 11.9769 7.80536L5.01084 14.7714C4.37004 15.4122 3.91545 16.2151 3.69566 17.0943L3.02986 19.7575C2.94467 20.0982 3.04452 20.4587 3.2929 20.7071C3.54128 20.9555 3.90177 21.0553 4.24254 20.9701L6.90572 20.3043C7.78488 20.0846 8.58778 19.63 9.22857 18.9892L16.1946 12.0231C16.5852 11.6326 16.5852 10.9994 16.1946 10.6089L13.3911 7.80536Z M12 20C12 19.4477 12.4477 19 13 19L20 19C20.5523 19 21 19.4477 21 20C21 20.5523 20.5523 21 20 21L13 21C12.4477 21 12 20.5523 12 20Z"/></svg>';
        const deleteIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M10.1111 2C9.37473 2 8.77778 2.59695 8.77778 3.33333C8.77778 3.70152 8.4793 4 8.11111 4L8 4L5 4C4.44772 4 4 4.44772 4 5C4 5.55228 4.44772 6 5 6L8 6H8.11111L15.8873 6C15.8878 6 15.8884 6 15.8889 6H16L19 6C19.5523 6 20 5.55228 20 5C20 4.44772 19.5523 4 19 4H15.8881C15.5203 3.99956 15.2222 3.70126 15.2222 3.33333C15.2222 2.59695 14.6253 2 13.8889 2H10.1111Z M6 8C5.72035 8 5.45348 8.1171 5.26412 8.32289C5.07477 8.52868 4.98023 8.80436 5.00346 9.08305L5.77422 18.3322C5.94698 20.4054 7.68005 22 9.7604 22H14.2396C16.32 22 18.053 20.4054 18.2258 18.3322L18.9965 9.08305C19.0198 8.80436 18.9252 8.52868 18.7359 8.32289C18.5465 8.1171 18.2797 8 18 8H6Z" fill="currentColor"/></svg>';
        const sourceDomain = m.source_url ? getDomain(m.source_url) : '';
        const formatTime = (h) => {
            if (!h) return '';
            if (h < 1) return Math.round(h * 60) + ' mins';
            if (Number.isInteger(h)) return h + ' hrs';
            return h.toFixed(1) + ' hrs';
        };

        return `
        <div class="meal-lib-card ${m.avoid_percentage > 25 ? 'has-avoid' : ''}">
            <div class="meal-lib-card-img-wrapper" onclick="openViewMeal('${m.id}')">
                <img class="meal-lib-card-img" src="${esc(m.image_url || DEFAULT_IMG)}" alt="${esc(m.name)}" onerror="this.src='${DEFAULT_IMG}'">
                ${sourceDomain ? `
                    <a class="meal-lib-card-overlay-link" href="${esc(m.source_url)}" target="_blank" onclick="event.stopPropagation()">
                        ${esc(sourceDomain)}
                    </a>
                ` : ''}
            </div>
            <div class="meal-lib-card-body">
                <div class="meal-lib-card-title" onclick="openViewMeal('${m.id}')">${esc(m.name)}</div>
                <div class="meal-lib-card-stats">
                    <span class="calorie-tag" ${m.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${(m.calories !== null && m.calories !== undefined) ? Math.round(m.calories) : '---'} kcal${m.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • 
                    ${(m.ingredient_count || 0)} ingredients
                    ${m.cook_time_hours ? ' • ' + formatTime(m.cook_time_hours) : ''}
                    ${m.language === 'vi' ? '<span class="vn-badge">VN</span>' : '<span class="en-badge">EN</span>'}
                </div>
                <div class="meal-lib-card-actions">
                    <button class="btn-icon" onclick="openEditMeal('${m.id}')" title="Edit">${editIcon}</button>
                    <button class="btn-icon ${m.is_favorite ? 'fav-active' : ''}" onclick="toggleFav('${m.id}',this)" title="Favorite">${favIcon}</button>
                    <button class="btn-icon" onclick="deleteMeal('${m.id}')" title="Delete">${deleteIcon}</button>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

document.getElementById('btn-search-meals').addEventListener('click', () => loadMeals(1));
document.getElementById('meal-search').addEventListener('input', debounce(() => loadMeals(1), 300));
document.getElementById('meal-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadMeals(1); });

// Scrape button
document.getElementById('btn-scrape-meals').addEventListener('click', async function () {
    const query = document.getElementById('meal-search').value.trim();
    const modal = document.getElementById('scrape-progress-modal');
    const progressBar = document.getElementById('scrape-progress-bar');
    const statusMsg = document.getElementById('scrape-status-msg');
    const terminateBtn = document.getElementById('btn-terminate-scrape');

    modal.classList.add('visible');
    progressBar.style.width = '0%';
    terminateBtn.style.display = 'inline-block';
    terminateBtn.disabled = false;
    terminateBtn.textContent = 'Terminate Process';

    const startScrapePolling = () => {
        if (scrapePollInterval) clearInterval(scrapePollInterval);
        progressBar.style.width = '10%'; // Immediate feedback
        scrapePollInterval = setInterval(async () => {
            try {
                const status = await API.get(`/api/scrape/status?t=${Date.now()}`);
                if (status.is_running) {
                    const newWidth = Math.max(status.progress, parseInt(progressBar.style.width) || 0);
                    progressBar.style.width = newWidth + '%';
                    statusMsg.textContent = status.message;
                } else {
                    // Process stopped
                    clearInterval(scrapePollInterval);
                    if (status.progress >= 100) {
                        progressBar.style.width = '100%';
                    }
                    if (status.message === "Process terminated.") {
                        statusMsg.textContent = "Process terminated.";
                        setTimeout(() => modal.classList.remove('visible'), 1500);
                    } else {
                        modal.classList.remove('visible');
                    }
                }
            } catch (e) {
                console.error("Polling error:", e);
            }
        }, 1000);
    };

    statusMsg.textContent = query ? `Scraping recipes for "${query}"...` : 'Starting bulk population...';
    startScrapePolling();

    try {
        const endpoint = query
            ? `/api/scrape/search?query=${encodeURIComponent(query)}&max_per_source=3`
            : `/api/scrape/populate`;

        const result = await API.post(endpoint);
        clearInterval(scrapePollInterval);

        if (result.message === "Process terminated.") {
            showNotification('Scraping Terminated', 'The process was stopped by the user.');
            modal.classList.remove('visible');
            return;
        }

        progressBar.style.width = '100%';
        const stats = `Run for ${result.duration || 0}s; Found ${result.found || 0}, Skipped ${(result.skipped || 0) + (result.duplicated || 0)}, Saved ${result.saved || 0} meals.`;
        showNotification('Scraping Done', stats);

        setTimeout(() => {
            modal.classList.remove('visible');
            loadMeals(); // Refresh library
        }, 2000);
    } catch (e) {
        console.error("Scraping error:", e);
        clearInterval(scrapePollInterval);
        showNotification('Scraping Failed', 'The process was interrupted or encountered an error.');
        modal.classList.remove('visible');
    }
});

// Terminate button logic
document.getElementById('btn-terminate-scrape').addEventListener('click', async function () {
    this.disabled = true;
    this.textContent = 'Terminating Process...';
    try {
        await API.post('/api/scrape/terminate');
    } catch (e) {
        console.error("Failed to send termination signal", e);
        this.disabled = false;
        this.textContent = 'Terminate Process';
    }
});

// Global termination signal on page close/refresh
window.addEventListener('beforeunload', () => {
    if (scrapePollInterval) {
        navigator.sendBeacon('/api/scrape/terminate');
    }
});

// Meal Modal
let mealModalMode = 'add'; // add, edit, view
let editingMealId = null;

// New Add Meal Workflow
document.getElementById('btn-add-meal').addEventListener('click', () => {
    document.getElementById('meal-choice-modal').classList.add('visible');
});

document.getElementById('btn-choice-manual').addEventListener('click', () => {
    document.getElementById('meal-choice-modal').classList.remove('visible');
    openMealModal('add');
});

document.getElementById('btn-choice-url').addEventListener('click', () => {
    document.getElementById('meal-choice-modal').classList.remove('visible');
    document.getElementById('scrape-url-input').value = '';
    document.getElementById('scrape-url-modal').classList.add('visible');
});

document.getElementById('scrape-url-cancel').addEventListener('click', () => {
    document.getElementById('scrape-url-modal').classList.remove('visible');
});

document.getElementById('scrape-url-confirm').addEventListener('click', async function () {
    const url = document.getElementById('scrape-url-input').value.trim();
    if (!url) return;

    this.disabled = true;
    const originalText = this.innerHTML;
    this.innerHTML = '<span class="loading-spinner"></span> Scraping...';

    try {
        const response = await fetch(`/api/scrape/url?url=${encodeURIComponent(url)}`, { method: 'POST' });
        const result = await response.json();

        if (response.ok && result.status === 'success') {
            document.getElementById('scrape-url-modal').classList.remove('visible');
            openMealModal('add', null, result.meal);
            showNotification('Scrape Successful', `Loaded "${result.meal.name}"`);
        } else {
            alert(result.detail || 'Failed to scrape recipe. Please check the URL and try again.');
        }
    } catch (e) {
        console.error("Scrape error:", e);
        alert('An error occurred while scraping the recipe.');
    } finally {
        this.disabled = false;
        this.innerHTML = originalText;
    }
});

window.openEditMeal = (id) => openMealModal('edit', id);
// Removed redundant window.openEditMealFromHome definition as it's now handled by the popover logic above
window.openViewMeal = (id) => openMealModal('view', id);
window.openMealModal = openMealModal;

document.getElementById('btn-open-source').addEventListener('click', () => {
    const url = document.getElementById('meal-form-link').value;
    if (url) {
        window.open(url, '_blank');
    }
});

async function openMealModal(mode, mealId = null, prefillData = null) {
    editingMealId = mealId;
    mealModalMode = mode;

    // Reset components
    document.getElementById('meal-form').reset();
    document.getElementById('meal-form-ingredients').innerHTML = '';
    document.getElementById('view-ingredients-list').innerHTML = '';
    document.getElementById('meal-modal-img').src = DEFAULT_IMG;

    // Toggle image upload button and reset popover state
    const uploadBtnEl = document.getElementById('btn-meal-image-upload');
    if (uploadBtnEl) {
        uploadBtnEl.style.display = (mode === 'view') ? 'none' : 'flex';
    }
    if (window.resetPopoverState) {
        window.resetPopoverState();
    }

    const viewContent = document.getElementById('meal-modal-view-content');
    const editContent = document.getElementById('meal-modal-edit-content');
    const saveBtn = document.getElementById('meal-modal-save');
    const cancelBtn = document.getElementById('meal-modal-cancel');
    const editBtn = document.getElementById('meal-modal-edit-btn');
    const title = document.getElementById('meal-modal-title');
    const recalcBtn = document.getElementById('view-meal-recalculate');


    // Toggle mode visibility
    const mealForm = document.getElementById('meal-form');
    if (mode === 'view') {
        viewContent.style.display = 'flex';
        mealForm.style.display = 'none';
        saveBtn.style.display = 'none';
        cancelBtn.innerText = 'Close';
        editBtn.style.display = 'inline-block';
        recalcBtn.style.display = 'inline-block';
        title.innerText = 'Meal Details';

    } else {
        viewContent.style.display = 'none';
        mealForm.style.display = 'block';
        saveBtn.style.display = 'inline-block';
        cancelBtn.innerText = 'Cancel';
        editBtn.style.display = 'none';
        recalcBtn.style.display = 'none';
        title.innerText = mode === 'add' ? 'Add New Meal' : 'Edit Meal';

        saveBtn.innerText = mode === 'add' ? 'Save Meal' : 'Update Meal';
    }

    // Populate data
    if (mealId) {
        try {
            const meal = await API.get(`/api/meals/${mealId}`);

            // Populate Edit Form safely
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = (val !== null && val !== undefined) ? val : '';
            };
            setVal('meal-form-name', meal.name);
            setVal('meal-form-desc', meal.description);
            setVal('meal-form-image', meal.image_url);
            setVal('meal-form-time', meal.cook_time_hours);
            setVal('meal-form-servings', meal.servings);
            setVal('meal-form-link', meal.source_url);

            // Update Modal Image
            const modalImg = document.getElementById('meal-modal-img');
            if (modalImg) modalImg.src = meal.image_url || DEFAULT_IMG;

            // Populate View Content
            document.getElementById('view-meal-name').innerText = meal.name || 'Unnamed Recipe';

            const shortDomain = getShortDomain(meal.source_url);
            document.getElementById('view-meal-source').innerHTML = meal.source_url
                ? `From <a href="${esc(meal.source_url)}" target="_blank" class="view-source-link">${esc(shortDomain)}</a>`
                : 'Custom Recipe';

            const formatTime = (h) => {
                if (!h) return 'N/A';
                if (h < 1) return Math.round(h * 60) + 'm';
                return h + 'h';
            };

            const kcalText = (meal.calories !== null && meal.calories !== undefined) ? `${Math.round(meal.calories)} kcal` : '--- kcal';
            const kcalWarning = meal.calories_incomplete ? ' <span class="incomplete-tag" title="Some ingredients missing kcal data">(!)</span>' : '';

            const hasServings = !!meal.servings && !isNaN(parseInt(meal.servings));
            let originalServings = hasServings ? parseInt(meal.servings) : 1;
            let currentServings = originalServings;

            document.getElementById('view-meal-stats').innerHTML = `
                <span>🕒 ${formatTime(meal.cook_time_hours)}</span>
                <span class="stats-divider"></span>
                <span id="view-servings-display">🍚 ${meal.servings ? meal.servings + ' servings' : 'N/A'}</span>
                <span class="stats-divider"></span>
                <span id="view-kcal-display">⚡ ${kcalText}${kcalWarning}</span>
            `;

            let viewUnitsMode = 'origin';

            const btnOrigin = document.getElementById('unit-switch-origin');
            const btnMetric = document.getElementById('unit-switch-metric');
            if (btnOrigin && btnMetric) {
                // reset to origin initially
                viewUnitsMode = 'origin';
                btnOrigin.style.background = 'var(--primary)';
                btnOrigin.style.color = 'white';
                btnMetric.style.background = 'transparent';
                btnMetric.style.color = 'var(--text-muted)';

                btnOrigin.onclick = (e) => {
                    e.stopPropagation();
                    viewUnitsMode = 'origin';
                    btnOrigin.style.background = 'var(--primary)';
                    btnOrigin.style.color = 'white';
                    btnMetric.style.background = 'transparent';
                    btnMetric.style.color = 'var(--text-muted)';
                    renderScaledIngredients(currentServings);
                };
                btnMetric.onclick = (e) => {
                    e.stopPropagation();
                    viewUnitsMode = 'metric';
                    btnMetric.style.background = 'var(--primary)';
                    btnMetric.style.color = 'white';
                    btnOrigin.style.background = 'transparent';
                    btnOrigin.style.color = 'var(--text-muted)';
                    renderScaledIngredients(currentServings);
                };
            }


            // Servings Adjuster Logic
            const adjContainer = document.getElementById('view-servings-adj');
            const minusBtn = document.getElementById('adj-servings-minus');
            const plusBtn = document.getElementById('adj-servings-plus');
            const adjValEl = document.getElementById('adj-servings-val');

            if (!hasServings) {
                adjContainer.style.opacity = '0.5';
                minusBtn.disabled = true;
                plusBtn.disabled = true;
                adjValEl.innerText = '-';
            } else {
                adjContainer.style.opacity = '1';
                minusBtn.disabled = false;
                plusBtn.disabled = false;
                adjValEl.innerText = currentServings;
            }

            const renderScaledIngredients = (servings) => {
                const tbody = document.getElementById('view-ingredients-list');
                tbody.innerHTML = '';
                const multiplier = servings / originalServings;

                meal.ingredients.forEach(ing => {
                    const baseQty = parseQtyJS(ing.quantity);
                    const unitRaw = (ing.unit || '').trim();
                    const unitLower = unitRaw.toLowerCase();
                    let finalQtyStr;
                    let finalUnitStr = ing.unit || '';

                    if (viewUnitsMode === 'metric' && ing.metric_weight_grams > 0 && unitRaw !== '') {
                        if (['tsp', 't', 'teaspoon', 'teaspoons', 'tbsp', 'tbs', 'tablespoon', 'tablespoons'].includes(unitLower)) {
                            finalQtyStr = baseQty > 0 ? humanizeQtyJS(baseQty * multiplier) : ing.quantity;
                        } else {
                            finalQtyStr = Math.round(ing.metric_weight_grams * multiplier);
                            finalUnitStr = 'g';
                        }
                    } else {
                        finalQtyStr = baseQty > 0 ? humanizeQtyJS(baseQty * multiplier) : ing.quantity;
                    }

                    const scaledKcal = (ing.calories !== null && ing.calories !== undefined) ? Math.round(ing.calories * multiplier) : 0;

                    let tooltipText = 'No matching FDC food';
                    if (ing.fdc_name) {
                        tooltipText = ing.calories_incomplete
                            ? `${esc(ing.fdc_name)} (Missing weight/portion data)`
                            : `${esc(ing.fdc_name)}, ${scaledKcal} kcal`;
                    }

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="view-ingredient-name-cell">
                            <div class="view-ingredient-name ${ing.is_avoid ? 'avoid-text' : ''}" title="${tooltipText}">
                                ${esc(ing.name)}${ing.calories_incomplete ? ' <span class="incomplete-tag" title="Missing kcal data">(!)</span>' : ''}
                            </div>
                            ${ing.comment ? `<div class="view-ingredient-comment" title="${esc(ing.comment)}">${esc(ing.comment)}</div>` : ''}
                        </td>
                        <td class="view-ingredient-qty">${esc(finalQtyStr)}</td>
                        <td class="view-ingredient-unit">${esc(finalUnitStr)}</td>
                    `;
                    tbody.appendChild(tr);
                });

                // Update the stats display
                const servingsText = hasServings ? `${servings} servings` : 'N/A';
                document.getElementById('view-servings-display').innerText = `🍚 ${servingsText}`;

                const scaledKcal = (meal.calories !== null && meal.calories !== undefined) ? Math.round(meal.calories * multiplier) : null;
                const updatedKcalText = scaledKcal !== null ? `${scaledKcal} kcal` : '--- kcal';
                const kcalDisplay = document.getElementById('view-kcal-display');
                if (kcalDisplay) {
                    kcalDisplay.innerHTML = `⚡ ${updatedKcalText}${kcalWarning}`;
                }
            };

            minusBtn.onclick = (e) => {
                e.stopPropagation();
                if (currentServings > 1) {
                    currentServings--;
                    adjValEl.innerText = currentServings;
                    renderScaledIngredients(currentServings);
                }
            };

            plusBtn.onclick = (e) => {
                e.stopPropagation();
                currentServings++;
                adjValEl.innerText = currentServings;
                renderScaledIngredients(currentServings);
            };

            document.getElementById('view-meal-desc').innerText = meal.description || 'No description provided.';

            const ingredients = meal.ingredients || [];
            document.getElementById('view-ingredient-count').innerText = `${ingredients.length} items`;

            renderScaledIngredients(currentServings);

            // Also add to edit form for edit mode preparation
            meal.ingredients.forEach(ing => {
                addIngredientRow(ing.name, ing.quantity, ing.unit, ing.comment);
            });

            document.getElementById('meal-modal-img').src = meal.image_url || DEFAULT_IMG;

            // Edit button logic within view mode
            editBtn.onclick = () => openMealModal('edit', mealId);

            // Recalculate button logic
            recalcBtn.onclick = async () => {
                const originalText = recalcBtn.innerHTML;
                recalcBtn.disabled = true;
                recalcBtn.innerHTML = '<span class="loading-spinner"></span> Calculating...';
                try {
                    await API.post(`/api/fdc/calculate/${mealId}?use_api=true`);
                    showNotification('Calculation Done', 'Calories and ingredients updated from FDC.');
                    // Refresh modal
                    openMealModal('view', mealId);
                    // Refresh main list
                    loadMeals();
                } catch (e) {
                    console.error("Recalculation error:", e);
                    showNotification('Error', 'Failed to recalculate calories.');
                } finally {
                    recalcBtn.disabled = false;
                    recalcBtn.innerHTML = originalText;
                }
            };


        } catch (e) {
            console.error("Error loading meal details:", e);
        }
    } else if (prefillData) {
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = (val !== null && val !== undefined) ? val : '';
        };
        setVal('meal-form-name', prefillData.name);
        setVal('meal-form-desc', prefillData.description);
        setVal('meal-form-image', prefillData.image_url);
        setVal('meal-form-time', prefillData.cook_time_hours);
        setVal('meal-form-servings', prefillData.servings);
        setVal('meal-form-link', prefillData.source_url);
        const modalImg = document.getElementById('meal-modal-img');
        if (modalImg) modalImg.src = prefillData.image_url || DEFAULT_IMG;
        (prefillData.ingredients || []).forEach(ing => addIngredientRow(ing.name, ing.quantity, ing.unit, ing.comment, false));
    }

    if ((!mealId && !prefillData) || mode === 'add') {
        if (!prefillData || !prefillData.ingredients || prefillData.ingredients.length === 0) {
            addIngredientRow('', '', '', '');
        }
    }

    document.getElementById('meal-modal').classList.add('visible');

    // Rebind footer buttons
    saveBtn.onclick = saveMeal;
    cancelBtn.onclick = () => document.getElementById('meal-modal').classList.remove('visible');
}

function addIngredientRow(name = '', qty = '', unit = '', comment = '', isReadonly = false) {
    const container = document.getElementById('meal-form-ingredients');
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    const roAttr = isReadonly ? 'readonly' : '';
    const hideRemove = isReadonly ? 'style="display:none"' : '';
    row.innerHTML = `
        <input type="text" placeholder="Ingredient name" value="${esc(name)}" style="flex: 2;" ${roAttr}>
        <input type="text" placeholder="Qty" value="${esc(qty)}" style="width: 60px;" ${roAttr}>
        <input type="text" placeholder="Unit" value="${esc(unit)}" style="width: 80px;" ${roAttr}>
        <input type="text" placeholder="Comment" value="${esc(comment)}" style="flex: 1;" ${roAttr}>
        <button class="btn-icon" onclick="this.parentElement.remove()" title="Remove" ${hideRemove}>✕</button>
    `;
    container.appendChild(row);
}

document.getElementById('btn-add-ingredient').addEventListener('click', () => addIngredientRow());
// Close button (X) for the modal
document.getElementById('meal-modal-close').addEventListener('click', () => document.getElementById('meal-modal').classList.remove('visible'));


// Live image preview
document.getElementById('meal-form-image').addEventListener('input', function () {
    document.getElementById('meal-modal-img').src = this.value || DEFAULT_IMG;
});

// ─── Image Options Popover & Upload Logic ───
const popoverMenu = document.getElementById('meal-image-options-popover');
const optionInputUrl = document.getElementById('option-input-url');
const optionUploadImage = document.getElementById('option-upload-image');
const popoverUrlPanel = document.getElementById('popover-url-panel');
const popoverUrlInput = document.getElementById('popover-url-input');
const btnPopoverUrlOk = document.getElementById('btn-popover-url-ok');
const btnPopoverUrlCancel = document.getElementById('btn-popover-url-cancel');
const fileInput = document.getElementById('meal-image-file-input');

function resetPopoverState() {
    if (popoverMenu) popoverMenu.style.display = 'none';
    if (optionInputUrl) optionInputUrl.style.display = 'flex';
    if (optionUploadImage) optionUploadImage.style.display = 'flex';
    if (popoverUrlPanel) popoverUrlPanel.style.display = 'none';
    if (popoverUrlInput) popoverUrlInput.value = '';
}
window.resetPopoverState = resetPopoverState;

const uploadBtn = document.getElementById('btn-meal-image-upload');
if (uploadBtn && popoverMenu) {
    uploadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = popoverMenu.style.display === 'flex';
        if (isOpen) {
            resetPopoverState();
        } else {
            popoverMenu.style.display = 'flex';
        }
    });

    // Close popover when clicking anywhere else
    document.addEventListener('click', (e) => {
        if (!popoverMenu.contains(e.target) && e.target !== uploadBtn) {
            resetPopoverState();
        }
    });
}

if (optionInputUrl && popoverUrlPanel) {
    optionInputUrl.addEventListener('click', (e) => {
        e.stopPropagation();
        optionInputUrl.style.display = 'none';
        optionUploadImage.style.display = 'none';
        popoverUrlPanel.style.display = 'flex';
        const currentImgUrl = document.getElementById('meal-form-image').value;
        popoverUrlInput.value = currentImgUrl || '';
        setTimeout(() => popoverUrlInput.focus(), 50);
    });
}

if (btnPopoverUrlOk) {
    btnPopoverUrlOk.addEventListener('click', (e) => {
        e.stopPropagation();
        const newUrl = popoverUrlInput.value.trim();
        document.getElementById('meal-form-image').value = newUrl;
        document.getElementById('meal-modal-img').src = newUrl || DEFAULT_IMG;
        resetPopoverState();
    });
}

if (btnPopoverUrlCancel) {
    btnPopoverUrlCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        resetPopoverState();
    });
}

if (optionUploadImage && fileInput) {
    optionUploadImage.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });
}

if (fileInput) {
    fileInput.addEventListener('change', async function () {
        if (!this.files || !this.files[0]) return;
        const file = this.files[0];

        // Show spinner / loading feedback in the upload button
        const originalContent = uploadBtn.innerHTML;
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = `
            <svg class="animate-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" style="animation: spin 1s linear infinite;">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 0 1 4 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor"></path>
            </svg>
        `;

        const formData = new FormData();
        formData.append('file', file);
        if (editingMealId) {
            formData.append('meal_id', editingMealId);
        }
        const currentImgUrl = document.getElementById('meal-form-image').value;
        if (currentImgUrl) {
            formData.append('previous_url', currentImgUrl);
        }

        try {
            const response = await fetch('/api/meals/upload-image', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();

            if (response.ok && result.status === 'success') {
                document.getElementById('meal-form-image').value = result.url;
                document.getElementById('meal-modal-img').src = result.url;
                showNotification('Image Uploaded', 'Your meal image has been successfully uploaded.');
            } else {
                alert(result.detail || 'Failed to upload image. Please try again.');
            }
        } catch (e) {
            console.error("Upload error:", e);
            alert('An error occurred while uploading the image.');
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.innerHTML = originalContent;
            fileInput.value = ''; // Reset file input
            resetPopoverState();
        }
    });
}

async function saveMeal() {
    const ingredients = [];
    document.querySelectorAll('#meal-form-ingredients .ingredient-row').forEach(row => {
        const inputs = row.querySelectorAll('input');
        const name = inputs[0].value.trim();
        if (name) {
            ingredients.push({
                name,
                quantity: inputs[1].value.trim(),
                unit: inputs[2].value.trim(),
                comment: inputs[3].value.trim()
            });
        }
    });
    const data = {
        name: document.getElementById('meal-form-name').value.trim(),
        description: document.getElementById('meal-form-desc').value.trim(),
        image_url: document.getElementById('meal-form-image').value.trim(),
        source_url: document.getElementById('meal-form-link').value.trim(),
        cook_time_hours: parseFloat(document.getElementById('meal-form-time').value) || 0,
        servings: document.getElementById('meal-form-servings').value.trim(),
        ingredients,
    };
    if (!data.name) return alert('Meal name is required');
    try {
        if (editingMealId && mealModalMode === 'edit') await API.put(`/api/meals/${editingMealId}`, data);
        else await API.post('/api/meals/', data);
        document.getElementById('meal-modal').classList.remove('visible');
        loadMeals();
    } catch (e) { alert('Failed to save meal.'); }
}

window.deleteMeal = async (id) => {
    const confirmed = await showConfirmDialog('Delete Meal', 'Are you sure you want to delete this meal? This action cannot be undone.');
    if (!confirmed) return;
    await API.del(`/api/meals/${id}`);
    loadMeals();
};

// ─── FAVORITES ─────────────────────────────────────
async function loadFavorites(page = 1) {
    favPage = page;
    const searchEl = document.getElementById('fav-search');
    const search = searchEl ? searchEl.value : '';
    let url = `/api/favorites/?page=${favPage}&page_size=${PAGE_SIZE}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    try {
        const data = await API.get(url);
        allFavorites = data.items;
        renderFavorites();
        renderPagination('fav-pagination', data.total_pages, data.page, 'loadFavorites');
    } catch (err) {
        console.error("Failed to load favorites:", err);
    }
}

function renderFavorites() {
    const grid = document.getElementById('fav-grid');
    if (!allFavorites.length) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>No Favorites Yet</h3><p>Heart a meal to add it here.</p></div>'; return; }
    grid.innerHTML = allFavorites.map(m => {
        const favStarIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M 14.8108 4.2207 C 13.9712 2.8257 11.9488 2.8257 11.1093 4.2207 L 9.0712 7.6074 L 5.2205 8.4992 C 3.6343 8.8666 3.0093 10.79 4.0766 12.0195 L 6.6677 15.0044 L 6.326 18.9423 C 6.1852 20.5644 7.8214 21.7532 9.3205 21.118 L 12.96 19.5761 L 16.5996 21.118 C 18.0987 21.7532 19.7348 20.5644 19.5941 18.9423 L 19.2524 15.0044 L 21.8435 12.0195 C 22.9108 10.79 22.2858 8.8666 20.6997 8.4992 L 16.8489 7.6074 L 14.8108 4.2207 Z"/></svg>`;

        const sourceDomain = m.source_url ? getDomain(m.source_url) : '';
        const formatTime = (h) => {
            if (!h) return '';
            if (h < 1) return Math.round(h * 60) + ' mins';
            if (Number.isInteger(h)) return h + ' hrs';
            return h.toFixed(1) + ' hrs';
        };

        return `
        <div class="meal-lib-card ${m.avoid_percentage > 25 ? 'has-avoid' : ''}">
            <div class="meal-lib-card-img-wrapper" onclick="openViewMeal('${m.id}')">
                <img class="meal-lib-card-img" src="${esc(m.image_url || DEFAULT_IMG)}" alt="${esc(m.name)}" onerror="this.src='${DEFAULT_IMG}'">
                ${sourceDomain ? `
                    <a class="meal-lib-card-overlay-link" href="${esc(m.source_url)}" target="_blank" onclick="event.stopPropagation()">
                        ${esc(sourceDomain)}
                    </a>
                ` : ''}
            </div>
            <div class="meal-lib-card-body">
                <div class="meal-lib-card-title" onclick="openViewMeal('${m.id}')">${esc(m.name)}</div>
                <div class="meal-lib-card-stats">
                    <span class="calorie-tag" ${m.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${(m.calories !== null && m.calories !== undefined) ? Math.round(m.calories) : '---'} kcal${m.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • 
                    ${(m.ingredient_count || 0)} ingredients
                    ${m.cook_time_hours ? ' • ' + formatTime(m.cook_time_hours) : ''}
                    ${m.language === 'vi' ? '<span class="vn-badge">VN</span>' : '<span class="en-badge">EN</span>'}
                </div>
                <div class="meal-lib-card-actions">
                    <button class="btn btn-secondary" onclick="removeFav('${m.id}')" style="font-size:.75rem; padding: 4px 10px; height: auto; display: flex; align-items: center; gap: 6px;">
                        Remove ${favStarIcon}
                    </button>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

window.toggleFav = async (mealId, btnEl) => {
    const isActive = btnEl.classList.contains('fav-active');
    if (isActive) {
        await API.del(`/api/favorites/${mealId}`);
        btnEl.classList.remove('fav-active');
    } else {
        await API.post(`/api/favorites/${mealId}`);
        btnEl.classList.add('fav-active');
    }
};

window.removeFav = async (mealId) => {
    await API.del(`/api/favorites/${mealId}`);
    loadFavorites();
};

// ─── User Guide Popover ────────────────────────────
const guideSteps = [
    { title: "Home Tab", content: "Welcome to GERD Diet Meal Planner. The Home tab is where you can generate and manage your weekly GERD-safe meal schedule. You can refresh individual meals to find something else." },
    { title: "Food Library", content: "Track individual ingredients here, categorizing them as Safe, Avoid, or Remedy for your acid reflux. This helps calculate the safety score of your meals." },
    { title: "Meal Library", content: "Store all your recipes here. You can manually add them or automatically scrape them from websites. Click on a meal to edit servings, ingredients, or check calories." },
    { title: "Favorite Meals", content: "Your go-to collection. Star your favorite meals so they are easy to find and more likely to be selected when generating your weekly plan." },
    { title: "Step 1: Add Meals", content: "To start using the app properly, go to the Meal Library and add or scrape some recipes you like. Make sure to review the ingredients so the app can calculate if they are GERD-safe." },
    { title: "Step 2: Generate Plan", content: "Once you have some meals, go back to the Home tab and click 'Generate Meal Plan'. The app will automatically build a balanced week for you." },
    { title: "Step 3: Adjust & Enjoy", content: "You can click on any meal card in your plan to see its details. Adjust the servings up or down, and the calories will update automatically. Enjoy your GERD-safe journey!" }
];

let currentGuideStep = 0;
const guideOverlay = document.getElementById('guide-overlay');
const guidePopover = document.getElementById('guide-popover');
const guideTitle = document.getElementById('guide-title');
const guideContent = document.getElementById('guide-content');
const guideProgress = document.getElementById('guide-progress');
const guideBack = document.getElementById('guide-back');
const guideNext = document.getElementById('guide-next');

document.getElementById('btn-user-guide')?.addEventListener('click', () => {
    currentGuideStep = 0;
    updateGuidePopover();
    guideOverlay.classList.add('visible');
});

document.getElementById('guide-close')?.addEventListener('click', () => {
    guideOverlay.classList.remove('visible');
});

guideBack?.addEventListener('click', () => {
    if (currentGuideStep > 0) {
        currentGuideStep--;
        updateGuidePopover();
    }
});

guideNext?.addEventListener('click', () => {
    if (currentGuideStep < guideSteps.length - 1) {
        currentGuideStep++;
        updateGuidePopover();
    } else {
        guideOverlay.classList.remove('visible');
    }
});

function updateGuidePopover() {
    const step = guideSteps[currentGuideStep];
    guideTitle.textContent = step.title;
    guideContent.textContent = step.content;
    guideProgress.textContent = `${currentGuideStep + 1} / ${guideSteps.length}`;

    guideBack.style.visibility = currentGuideStep === 0 ? 'hidden' : 'visible';
    guideNext.textContent = currentGuideStep === guideSteps.length - 1 ? 'Finish' : 'Next';

    // Switch tabs automatically based on guide step
    if (currentGuideStep === 0) switchTab('home');
    if (currentGuideStep === 1) switchTab('food-library');
    if (currentGuideStep === 2) switchTab('meal-library');
    if (currentGuideStep === 3) switchTab('favorites');
    if (currentGuideStep === 4) switchTab('meal-library');
    if (currentGuideStep >= 5) switchTab('home');
}

// ─── Init: Seed data on first load ─────────────────
async function init() {
    try {
        await API.post('/api/foods/seed');
        await API.post('/api/fdc/seed');
        await API.post('/api/meal-plan/cleanup'); // Cleanup old plans outside range
    } catch (e) { }

    // Initialize Weekly Plan dropdown regardless of tab
    updateWeekDropdown();

    // Initialize Custom Shadcn Selects
    document.querySelectorAll('.select-shadcn, .week-dropdown').forEach(s => {
        if (s.id) initShadcnSelect(s.id);
    });

    // Add search listener for Favorites
    const favSearch = document.getElementById('fav-search');
    if (favSearch) {
        favSearch.addEventListener('input', debounce(() => loadFavorites(1), 300));
    }

    // Restore previously selected tab or default to home
    const savedTab = sessionStorage.getItem('selectedTab') || 'home';
    switchTab(savedTab);
}

// Export to window for onclick handlers (module scope fix)
window.loadFoods = loadFoods;
window.loadMeals = loadMeals;
window.loadFavorites = loadFavorites;

init();
