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
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
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
    if (!isMissing && meal.has_avoid_food) card.classList.add('has-avoid');
    if (!isMissing) card.dataset.mealId = meal.id;

    // Hover tooltip (only if meal exists)
    if (!isMissing) {
        card.addEventListener('mouseenter', e => showTooltip(e, meal));
        card.addEventListener('mousemove', e => moveTooltip(e));
        card.addEventListener('mouseleave', hideTooltip);
    }

    const favIcon = !isMissing && meal.is_favorite
        ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

    const refreshIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>';
    const editIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5C3.5 3.5 3.5 3.5 3.5 12S3.5 20.5 12 20.5 20.5 20.5 20.5 12M14.9 5.2S17.9 2.2 19.9 4.2 19 9.2 19 9.2M14.9 5.2 9.9 10.2C9.2 10.9 8.7 11.7 8.6 12.6 8.4 13.5 8.4 14.7 8.6 15.5S10.3 16 11.5 15.8C12.4 15.6 13.2 15.1 13.9 14.5L19 9.2M14.9 5.2 19 9.2" stroke="currentColor" fill="none"/></svg>';

    const formatTime = (h) => {
        if (!h) return '';
        if (h < 1) return Math.round(h * 60) + ' mins';
        if (Number.isInteger(h)) return h + ' hrs';
        return h.toFixed(1) + ' hrs';
    };

    const mealName = isMissing ? 'Meal Deleted' : meal.name;
    const infoStatsHTML = `
        <div class="meal-card-title" onclick="${!isMissing ? `openViewMeal(${meal.id})` : ''}">${esc(mealName)}</div>
        <div class="meal-card-stats">
            ${!isMissing && meal.calories ? `<span class="calorie-tag" ${meal.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${Math.round(meal.calories)} kcal${meal.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • ` : ''}
            ${!isMissing ? (meal.ingredient_count || 0) + ' ingredients' : ''}
            ${!isMissing && meal.cook_time_hours ? ' • ' + formatTime(meal.cook_time_hours) : ''}
        </div>
    `;

    const actionsHTML = `
        ${!isMissing ? `<button class="btn-icon ${meal.is_favorite ? 'fav-active' : ''}" onclick="event.stopPropagation();toggleFav(${meal.id},this)" title="Favorite">${favIcon}</button>` : ''}
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
            <div class="meal-card-img-wrapper" onclick="${!isMissing ? `openViewMeal(${meal.id})` : ''}">
                <img class="meal-card-img" src="${esc(imgSrc)}" alt="${esc(mealName)}" onerror="this.src='${DEFAULT_IMG}'">
                <div class="meal-card-gradient meal-card-gradient-top"></div>
                <div class="meal-card-gradient meal-card-gradient-bottom"></div>
                
                ${!isMissing ? `<button class="meal-card-overlay-edit" onclick="event.stopPropagation();openEditMealFromHome(${meal.id})" title="Edit">${editIcon}</button>` : ''}
                
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
        wrapper.classList.toggle('open', force);
        if (wrapper.classList.contains('open')) {
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
        const editIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.9087 3.87352C16.4681 3.31421 17.2266 3 18.0176 3C18.4093 3 18.7971 3.07714 19.1589 3.22702C19.5208 3.3769 19.8495 3.59658 20.1265 3.87352C20.4034 4.15046 20.6231 4.47924 20.773 4.84108C20.9229 5.20292 21 5.59074 21 5.98239C21 6.37404 20.9229 6.76186 20.773 7.1237C20.6231 7.48554 20.4034 7.81432 20.1265 8.09126L19.0231 9.19466C18.6326 9.58519 17.9994 9.58519 17.6089 9.19467L14.8053 6.39114C14.4148 6.00062 14.4148 5.36745 14.8053 4.97693L15.9087 3.87352ZM13.3911 7.80536C13.0006 7.41483 12.3674 7.41483 11.9769 7.80536L5.01084 14.7714C4.37004 15.4122 3.91545 16.2151 3.69566 17.0943L3.02986 19.7575C2.94467 20.0982 3.04452 20.4587 3.2929 20.7071C3.54128 20.9555 3.90177 21.0553 4.24254 20.9701L6.90572 20.3043C7.78488 20.0846 8.58778 19.63 9.22857 18.9892L16.1946 12.0231C16.5852 11.6326 16.5852 10.9994 16.1946 10.6089L13.3911 7.80536Z M12 20C12 19.4477 12.4477 19 13 19L20 19C20.5523 19 21 19.4477 21 20C21 20.5523 20.5523 21 20 21L13 21C12.4477 21 12 20.5523 12 20Z" fill="currentColor"/></svg>';
        const deleteIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.1111 2C9.37473 2 8.77778 2.59695 8.77778 3.33333C8.77778 3.70152 8.4793 4 8.11111 4L8 4L5 4C4.44772 4 4 4.44772 4 5C4 5.55228 4.44772 6 5 6L8 6H8.11111L15.8873 6C15.8878 6 15.8884 6 15.8889 6H16L19 6C19.5523 6 20 5.55228 20 5C20 4.44772 19.5523 4 19 4H15.8881C15.5203 3.99956 15.2222 3.70126 15.2222 3.33333C15.2222 2.59695 14.6253 2 13.8889 2H10.1111Z M6 8C5.72035 8 5.45348 8.1171 5.26412 8.32289C5.07477 8.52868 4.98023 8.80436 5.00346 9.08305L5.77422 18.3322C5.94698 20.4054 7.68005 22 9.7604 22H14.2396C16.32 22 18.053 20.4054 18.2258 18.3322L18.9965 9.08305C19.0198 8.80436 18.9252 8.52868 18.7359 8.32289C18.5465 8.1171 18.2797 8 18 8H6Z" fill="currentColor"/></svg>';

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
                <button class="btn-icon" onclick="openEditFood(${f.id})" title="Edit">${editIcon}</button>
                <button class="btn-icon" onclick="deleteFood(${f.id})" title="Delete">${deleteIcon}</button>
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
    setComboboxValue('');
    document.getElementById('food-form-reflux').value = 'ok';
    document.getElementById('food-form-meal-type').value = 'none';
    document.getElementById('food-modal').classList.add('visible');
});

window.openEditFood = async (id) => {
    const food = allFoods.find(f => f.id === id);
    if (!food) return;
    editingFoodId = id;
    document.getElementById('food-modal-title').textContent = 'Edit Food';
    document.getElementById('food-form-name').value = food.name;
    setComboboxValue(food.category);
    document.getElementById('food-form-reflux').value = food.reflux;
    document.getElementById('food-form-meal-type').value = food.meal_type || 'none';
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
    if (!confirm('Delete this food?')) return;
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
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
        const editIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5C3.5 3.5 3.5 3.5 3.5 12S3.5 20.5 12 20.5 20.5 20.5 20.5 12M14.9 5.2S17.9 2.2 19.9 4.2 19 9.2 19 9.2M14.9 5.2 9.9 10.2C9.2 10.9 8.7 11.7 8.6 12.6 8.4 13.5 8.4 14.7 8.6 15.5S10.3 16 11.5 15.8C12.4 15.6 13.2 15.1 13.9 14.5L19 9.2M14.9 5.2 19 9.2" stroke="currentColor" fill="none"/></svg>';
        const deleteIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

        const sourceDomain = m.source_url ? getDomain(m.source_url) : '';
        const formatTime = (h) => {
            if (!h) return '';
            if (h < 1) return Math.round(h * 60) + ' mins';
            if (Number.isInteger(h)) return h + ' hrs';
            return h.toFixed(1) + ' hrs';
        };

        return `
        <div class="meal-lib-card ${m.has_avoid_food ? 'has-avoid' : ''}">
            <div class="meal-lib-card-img-wrapper" onclick="openViewMeal(${m.id})">
                <img class="meal-lib-card-img" src="${esc(m.image_url || DEFAULT_IMG)}" alt="${esc(m.name)}" onerror="this.src='${DEFAULT_IMG}'">
                ${sourceDomain ? `
                    <a class="meal-lib-card-overlay-link" href="${esc(m.source_url)}" target="_blank" onclick="event.stopPropagation()">
                        ${esc(sourceDomain)}
                    </a>
                ` : ''}
            </div>
            <div class="meal-lib-card-body">
                <div class="meal-lib-card-title" onclick="openViewMeal(${m.id})">${esc(m.name)}</div>
                <div class="meal-lib-card-stats">
                    ${m.calories ? `<span class="calorie-tag" ${m.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${Math.round(m.calories)} kcal${m.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • ` : ''}
                    ${(m.ingredient_count || 0)} ingredients
                    ${m.cook_time_hours ? ' • ' + formatTime(m.cook_time_hours) : ''}
                    ${m.language === 'vi' ? '<span class="vn-badge">VN</span>' : '<span class="en-badge">EN</span>'}
                </div>
                <div class="meal-lib-card-actions">
                    <button class="btn-icon" onclick="openEditMeal(${m.id})" title="Edit">${editIcon}</button>
                    <button class="btn-icon ${m.is_favorite ? 'fav-active' : ''}" onclick="toggleFav(${m.id},this)" title="Favorite">${favIcon}</button>
                    <button class="btn-icon" onclick="deleteMeal(${m.id})" title="Delete">${deleteIcon}</button>
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

document.getElementById('btn-add-meal').addEventListener('click', () => openMealModal('add'));
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

async function openMealModal(mode, mealId) {
    mealModalMode = mode;
    editingMealId = mealId || null;
    const title = document.getElementById('meal-modal-title');
    const footer = document.getElementById('meal-modal-footer');
    const formFields = document.querySelectorAll('#meal-modal .form-group input, #meal-modal .form-group textarea');

    if (mode === 'view') {
        title.textContent = 'View Meal';
        footer.innerHTML = '<button class="btn btn-secondary" onclick="document.getElementById(\'meal-modal\').classList.remove(\'visible\')">Close</button><button class="btn btn-primary" onclick="openMealModal(\'edit\',' + mealId + ')">Edit</button>';
        formFields.forEach(f => f.setAttribute('readonly', true));
    } else if (mode === 'edit') {
        title.textContent = 'Edit Meal';
        footer.innerHTML = '<button class="btn btn-secondary" id="meal-modal-cancel-2">Cancel</button><button class="btn btn-primary" id="meal-modal-save-2">Save</button>';
        formFields.forEach(f => f.removeAttribute('readonly'));
    } else {
        title.textContent = 'Add Meal';
        footer.innerHTML = '<button class="btn btn-secondary" id="meal-modal-cancel-2">Cancel</button><button class="btn btn-primary" id="meal-modal-save-2">Save</button>';
        formFields.forEach(f => f.removeAttribute('readonly'));
    }

    // Clear form
    document.getElementById('meal-form-name').value = '';
    document.getElementById('meal-form-desc').value = '';
    document.getElementById('meal-form-image').value = '';
    document.getElementById('meal-form-time').value = '';
    document.getElementById('meal-form-calories').value = '';
    document.getElementById('meal-form-link').value = '';
    document.getElementById('meal-form-ingredients').innerHTML = '';
    document.getElementById('meal-form-calories-incomplete').style.display = 'none';
    document.getElementById('meal-modal-img').src = DEFAULT_IMG;

    // Load data if editing/viewing
    if (mealId) {
        try {
            const meal = await API.get(`/api/meals/${mealId}`);
            document.getElementById('meal-form-name').value = meal.name || '';
            document.getElementById('meal-form-desc').value = meal.description || '';
            document.getElementById('meal-form-image').value = meal.image_url || '';
            document.getElementById('meal-form-time').value = meal.cook_time_hours || '';
            document.getElementById('meal-form-calories').value = meal.calories || '';
            const incIndicator = document.getElementById('meal-form-calories-incomplete');
            if (meal.calories_incomplete) {
                incIndicator.style.display = 'inline-flex';
                incIndicator.innerHTML = '<span class="incomplete-tag">(!)</span>';
                incIndicator.title = "Some ingredients missing kcal data";
            } else {
                incIndicator.style.display = 'none';
            }
            document.getElementById('meal-form-link').value = meal.source_url || '';
            document.getElementById('meal-modal-img').src = meal.image_url || DEFAULT_IMG;
            (meal.ingredients || []).forEach(ing => addIngredientRow(ing.name, ing.quantity, ing.unit, ing.comment, mode === 'view'));
        } catch (e) { }
    }

    if (!mealId || mode === 'add') addIngredientRow('', '', '', '');

    document.getElementById('meal-modal').classList.add('visible');

    // Rebind footer buttons
    const save2 = document.getElementById('meal-modal-save-2');
    const cancel2 = document.getElementById('meal-modal-cancel-2');
    if (save2) save2.addEventListener('click', saveMeal);
    if (cancel2) cancel2.addEventListener('click', () => document.getElementById('meal-modal').classList.remove('visible'));
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
    if (!confirm('Delete this meal?')) return;
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
        const favStarIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

        const sourceDomain = m.source_url ? getDomain(m.source_url) : '';
        const formatTime = (h) => {
            if (!h) return '';
            if (h < 1) return Math.round(h * 60) + ' mins';
            if (Number.isInteger(h)) return h + ' hrs';
            return h.toFixed(1) + ' hrs';
        };

        return `
        <div class="meal-lib-card ${m.has_avoid_food ? 'has-avoid' : ''}">
            <div class="meal-lib-card-img-wrapper" onclick="openViewMeal(${m.id})">
                <img class="meal-lib-card-img" src="${esc(m.image_url || DEFAULT_IMG)}" alt="${esc(m.name)}" onerror="this.src='${DEFAULT_IMG}'">
                ${sourceDomain ? `
                    <a class="meal-lib-card-overlay-link" href="${esc(m.source_url)}" target="_blank" onclick="event.stopPropagation()">
                        ${esc(sourceDomain)}
                    </a>
                ` : ''}
            </div>
            <div class="meal-lib-card-body">
                <div class="meal-lib-card-title" onclick="openViewMeal(${m.id})">${esc(m.name)}</div>
                <div class="meal-lib-card-stats">
                    ${m.calories ? `<span class="calorie-tag" ${m.calories_incomplete ? 'title="Some ingredients missing kcal data"' : ''}>${Math.round(m.calories)} kcal${m.calories_incomplete ? ' <span class="incomplete-tag">(!)</span>' : ''}</span> • ` : ''}
                    ${(m.ingredient_count || 0)} ingredients
                    ${m.cook_time_hours ? ' • ' + formatTime(m.cook_time_hours) : ''}
                    ${m.language === 'vi' ? '<span class="vn-badge">VN</span>' : '<span class="en-badge">EN</span>'}
                </div>
                <div class="meal-lib-card-actions">
                    <button class="btn btn-secondary" onclick="removeFav(${m.id})" style="font-size:.75rem; padding: 4px 10px; height: auto; display: flex; align-items: center; gap: 6px;">
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

// ─── Utilities ─────────────────────────────────────
function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s || ''; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ─── Init: Seed data on first load ─────────────────
async function init() {
    try {
        await API.post('/api/foods/seed');
        await API.post('/api/fdc/seed');
        await API.post('/api/meal-plan/cleanup'); // Cleanup old plans outside range
    } catch (e) { }

    // Initialize Weekly Plan dropdown regardless of tab
    updateWeekDropdown();

    // Restore previously selected tab or default to home
    const savedTab = sessionStorage.getItem('selectedTab') || 'home';
    switchTab(savedTab);
}
init();
