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

    const closeBtn = alert.querySelector('.alert-shadcn-close');
    const dismiss = () => {
        alert.classList.add('fade-out');
        setTimeout(() => alert.remove(), 300);
    };
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
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

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
    if (!isMissing && meal.avoid_percentage > 20) card.classList.add('has-avoid');
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
            ${!isMissing && meal.calories ? `<span class="calorie-tag" ${meal.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${Math.round(meal.calories)} kcal${meal.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • ` : ''}
            ${!isMissing ? (meal.ingredient_count || 0) + ' ingredients' : ''}
            ${!isMissing && meal.cook_time_hours ? ' • ' + formatTime(meal.cook_time_hours) : ''}
        </div>
    `;

    const actionsHTML = `
        ${!isMissing ? `<button class="btn-icon ${meal.is_favorite ? 'fav-active' : ''}" onclick="event.stopPropagation();toggleFav('${meal.id}',this)" title="Favorite">${favIcon}</button>` : ''}
        <button class="btn-icon" onclick="event.stopPropagation();refreshMealSlot('${dateStr}', '${mealTypeStr}')" title="Refresh Meal">${refreshIcon}</button>
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
                
                ${!isMissing ? `<button class="meal-card-overlay-edit" onclick="event.stopPropagation();openEditMealFromHome('${meal.id}')" title="Edit">${editIcon}</button>` : ''}
                
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

// ─── Tooltip ───────────────────────────────────────
const tooltip = document.getElementById('meal-tooltip');
function showTooltip(e, meal) {
    document.getElementById('tooltip-img').src = meal.image_url || DEFAULT_IMG;
    document.getElementById('tooltip-name').textContent = meal.name;
    document.getElementById('tooltip-details').innerHTML =
        `${meal.calories ? Math.round(meal.calories) + ' kcal' + (meal.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : '') : 'N/A'} · ${meal.ingredient_count || 0} ingredients · ${meal.cook_time_hours || 0}h<br>${meal.source_site || ''}${meal.language === 'vi' ? ' 🇻🇳' : ''}`;
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
    wrapper.className = `combobox-wrapper ${options.className || ''}`;
    
    const trigger = document.createElement('div');
    trigger.className = 'combobox-trigger';
    trigger.innerHTML = `
        <span></span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" class="combobox-chevron">
            <path d="m6 9 6 6 6-6" />
        </svg>
    `;
    const displayValue = trigger.querySelector('span');

    const content = document.createElement('div');
    content.className = 'combobox-content';
    
    const list = document.createElement('div');
    list.className = 'command-list';
    content.appendChild(list);

    wrapper.appendChild(trigger);
    wrapper.appendChild(content);

    select.style.display = 'none';
    select.parentNode.insertBefore(wrapper, select.nextSibling);

    const toggle = (force) => {
        const isOpen = wrapper.classList.toggle('open', force);
        if (isOpen) {
            // Close other open selects
            document.querySelectorAll('.combobox-wrapper.open').forEach(w => {
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
            <div class="command-item ${String(opt.value) === currentVal ? 'selected' : ''}" data-value="${esc(opt.value)}">
                <span>${esc(opt.textContent)}</span>
                ${String(opt.value) === currentVal ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
            </div>
        `).join('');

        const selectedOpt = select.options[select.selectedIndex];
        displayValue.textContent = selectedOpt ? selectedOpt.textContent : (options.placeholder || 'Select...');

        list.querySelectorAll('.command-item').forEach(item => {
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
    const wrapper = document.getElementById('food-category-combobox');
    const trigger = document.getElementById('combobox-trigger');
    const searchInput = document.getElementById('combobox-search');
    const list = document.getElementById('combobox-list');
    const empty = document.getElementById('combobox-empty');
    const newValueSpan = document.getElementById('new-category-name');
    const addBtn = document.getElementById('btn-add-new-category');
    const hiddenInput = document.getElementById('food-form-category');
    const displayValue = document.getElementById('combobox-value');

    const toggle = (force) => {
        const isOpen = wrapper.classList.toggle('open', force);
        if (isOpen) {
            // Close other open selects/comboboxes
            document.querySelectorAll('.combobox-wrapper.open').forEach(w => {
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
            <div class="command-item ${c === hiddenInput.value ? 'selected' : ''}" data-value="${esc(c)}">
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

        list.querySelectorAll('.command-item').forEach(item => {
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
async function loadFoods() {
    const cat = document.getElementById('food-category-filter').value;
    const reflux = document.getElementById('food-reflux-filter').value;
    const search = document.getElementById('food-search').value;
    let url = '/api/foods/?';
    if (cat) url += `category=${encodeURIComponent(cat)}&`;
    if (reflux) url += `reflux=${reflux}&`;
    if (search) url += `search=${encodeURIComponent(search)}&`;
    allFoods = await API.get(url);
    renderFoods();
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

document.getElementById('food-search').addEventListener('input', debounce(loadFoods, 300));
document.getElementById('food-category-filter').addEventListener('change', loadFoods);
document.getElementById('food-reflux-filter').addEventListener('change', loadFoods);

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
async function loadMeals() {
    const search = document.getElementById('meal-search').value;
    let url = '/api/meals/?limit=200';
    if (search) url += `&search=${encodeURIComponent(search)}`;
    allMeals = await API.get(url);
    renderMealLibrary();
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
        <div class="meal-lib-card ${m.avoid_percentage > 20 ? 'has-avoid' : ''}">
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
                    ${m.calories ? `<span class="calorie-tag" ${m.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${Math.round(m.calories)} kcal${m.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • ` : ''}
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

document.getElementById('btn-search-meals').addEventListener('click', loadMeals);
document.getElementById('meal-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadMeals(); });

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
window.openEditMealFromHome = (id) => openMealModal('edit', id);
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

            // Populate Edit Form
            document.getElementById('meal-form-name').value = meal.name || '';
            document.getElementById('meal-form-desc').value = meal.description || '';
            document.getElementById('meal-form-image').value = meal.image_url || '';
            document.getElementById('meal-form-time').value = meal.cook_time_hours || '';
            document.getElementById('meal-form-servings').value = meal.servings || '';
            document.getElementById('meal-form-calories').value = meal.calories || '';
            document.getElementById('meal-form-link').value = meal.source_url || '';

            const incIndicator = document.getElementById('meal-form-calories-incomplete');
            if (meal.calories_incomplete) {
                incIndicator.style.display = 'inline-flex';
                incIndicator.innerHTML = '<span class="incomplete-tag">(!)</span>';
                incIndicator.title = "Some ingredients missing kcal data";
            } else {
                incIndicator.style.display = 'none';
            }

            // Update Modal Image
            const modalImg = document.getElementById('meal-modal-img');
            modalImg.src = meal.image_url || DEFAULT_IMG;

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

            const kcalText = meal.calories ? `${Math.round(meal.calories)} kcal` : '--- kcal';
            const kcalWarning = meal.calories_incomplete ? ' <span class="incomplete-tag" title="Some ingredients missing kcal data">(!)</span>' : '';

            const hasServings = !!meal.servings && !isNaN(parseInt(meal.servings));
            let originalServings = hasServings ? parseInt(meal.servings) : 1;
            let currentServings = originalServings;

            document.getElementById('view-meal-stats').innerHTML = `
                <span>🕒 ${formatTime(meal.cook_time_hours)}</span>
                <span class="stats-divider"></span>
                <span id="view-servings-display">🍚 ${meal.servings ? meal.servings + ' servings' : 'N/A'}</span>
                <span class="stats-divider"></span>
                <span>⚡ ${kcalText}${kcalWarning}</span>
            `;

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
                    const scaledQty = baseQty > 0 ? humanizeQtyJS(baseQty * multiplier) : ing.quantity;

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="view-ingredient-name-cell">
                            <div class="view-ingredient-name ${ing.is_avoid ? 'avoid-text' : ''}">
                                ${esc(ing.name)}${!ing.fdc_id ? ' <span class="incomplete-tag" title="Missing kcal data">(!)</span>' : ''}
                            </div>
                            ${ing.comment ? `<div class="view-ingredient-comment" title="${esc(ing.comment)}">${esc(ing.comment)}</div>` : ''}
                        </td>
                        <td class="view-ingredient-qty">${esc(scaledQty)}</td>
                        <td class="view-ingredient-unit">${esc(ing.unit)}</td>
                    `;
                    tbody.appendChild(tr);
                });

                // Update the stats display as well
                const servingsText = hasServings ? `${servings} servings` : 'N/A';
                document.getElementById('view-servings-display').innerText = `🍚 ${servingsText}`;
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
        document.getElementById('meal-form-name').value = prefillData.name || '';
        document.getElementById('meal-form-desc').value = prefillData.description || '';
        document.getElementById('meal-form-image').value = prefillData.image_url || '';
        document.getElementById('meal-form-time').value = prefillData.cook_time_hours || '';
        document.getElementById('meal-form-servings').value = prefillData.servings || '';
        document.getElementById('meal-form-link').value = prefillData.source_url || '';
        document.getElementById('meal-modal-img').src = prefillData.image_url || DEFAULT_IMG;
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
document.getElementById('meal-modal-close').addEventListener('click', () => document.getElementById('meal-modal').classList.remove('visible'));
document.getElementById('meal-modal-cancel').addEventListener('click', () => document.getElementById('meal-modal').classList.remove('visible'));
document.getElementById('meal-modal-save').addEventListener('click', saveMeal);

// Live image preview
document.getElementById('meal-form-image').addEventListener('input', function () {
    document.getElementById('meal-modal-img').src = this.value || DEFAULT_IMG;
});

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
        calories: parseFloat(document.getElementById('meal-form-calories').value) || 0,
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
async function loadFavorites() {
    allFavorites = await API.get('/api/favorites/');
    renderFavorites();
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
        <div class="meal-lib-card ${m.avoid_percentage > 20 ? 'has-avoid' : ''}">
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
                    ${m.calories ? `<span class="calorie-tag" ${m.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${Math.round(m.calories)} kcal${m.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • ` : ''}
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

    // Restore previously selected tab or default to home
    const savedTab = sessionStorage.getItem('selectedTab') || 'home';
    switchTab(savedTab);
}
init();
