/* Home Page Configuration Logic */

document.addEventListener('DOMContentLoaded', () => {
    const configBtn = document.getElementById('btn-home-config');
    if (!configBtn) return; // Might not exist if script loads weirdly
    
    const modal = document.getElementById('home-config-modal');
    const closeBtn = document.getElementById('btn-close-config-modal');
    const cancelBtn = document.getElementById('btn-config-cancel');
    const saveBtn = document.getElementById('btn-config-save');
    const resetBtn = document.getElementById('btn-config-reset');

    // Default configuration (same as backend defaults)
    const DEFAULT_CONFIG = {
        slot_count_breakfast: 1,
        slot_count_lunch: 3,
        slot_count_dinner: 3,
        card_height_single: 420,
        card_height_compact: 85,
        card_gap: 10,
        categories: {
            "breakfast": ["ăn sáng", "bữa sáng", "breakfast"],
            "meat_fish": ["thịt", "cá", "gà", "bò", "lợn", "heo", "meat", "fish", "chicken", "beef", "pork"]
        },
        slot_pool_assignments: {
            "breakfast_0": ["breakfast"],
            "lunch_0": [],
            "lunch_1": [],
            "lunch_2": [],
            "dinner_0": [],
            "dinner_1": [],
            "dinner_2": []
        },
        slot_meal_types: {
            "breakfast_0": ["breakfast", "none"]
        },
        slot_include_keywords: {},
        slot_exclude_keywords: {},
        vi_language_bias_breakfast: 0.6,
        vi_language_bias_lunch: 0.8,
        vi_language_bias_dinner: 0.8,
        favorite_boost_weight: 1.3,
        remedy_boost_weight: 1.3,
        avoid_threshold_percent: 25
    };

    let editingConfig = {};

    function openModal() {
        editingConfig = JSON.parse(JSON.stringify(window.homeConfig || DEFAULT_CONFIG));
        populateUI();
        modal.classList.add('visible');
    }

    function closeModal() {
        modal.classList.remove('visible');
    }

    configBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);

    // Accordions
    document.querySelectorAll('#home-config-modal .config-accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const accordion = header.closest('.config-accordion');
            accordion.classList.toggle('open');
        });
    });

    // Dynamic slider track fill helper
    function updateSliderFill(slider) {
        if (!slider) return;
        const min = parseFloat(slider.min) || 0;
        const max = parseFloat(slider.max) || 100;
        const val = parseFloat(slider.value);
        const percent = Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100));
        slider.style.background = `linear-gradient(to right, var(--primary) 0%, var(--primary) ${percent}%, var(--bg) ${percent}%, var(--bg) 100%)`;
    }

    // Setup input bindings for steppers and sliders
    function setupBinding(inputId, key, isStepper = false) {
        const el = document.getElementById(inputId);
        const valDisp = document.getElementById(inputId ? inputId.replace('input_', 'val_') : '') || 
                        document.getElementById(`val_${key}`) || 
                        document.getElementById(`disp_${key}`);
        
        if (!el && !isStepper) return;

        if (isStepper) {
            document.querySelectorAll(`.stepper-btn[data-target="${key}"]`).forEach(btn => {
                btn.addEventListener('click', (e) => {
                    let current = editingConfig[key] || 1;
                    if (btn.dataset.action === 'plus') current = Math.min(5, current + 1);
                    if (btn.dataset.action === 'minus') current = Math.max(1, current - 1);
                    editingConfig[key] = current;
                    valDisp.textContent = current;
                    renderSlotGrid(); // Re-render grid when slots change
                });
            });
        } else {
            if (el.type === 'checkbox') {
                el.addEventListener('change', () => {
                    editingConfig[key] = el.checked;
                });
            } else {
                el.addEventListener('input', () => {
                    let rawVal = parseFloat(el.value);
                    if (key.includes('bias')) {
                        editingConfig[key] = rawVal / 100;
                    } else {
                        editingConfig[key] = rawVal;
                    }
                    if (valDisp) {
                        if (key === 'favorite_boost_weight' || key === 'remedy_boost_weight') {
                            valDisp.textContent = rawVal.toFixed(1);
                        } else {
                            valDisp.textContent = Math.round(rawVal);
                        }
                    }
                    updateSliderFill(el);
                });
            }
        }
    }

    // Initialize bindings
    setupBinding('', 'slot_count_breakfast', true);
    setupBinding('', 'slot_count_lunch', true);
    setupBinding('', 'slot_count_dinner', true);
    
    setupBinding('input_card_height_single', 'card_height_single');
    setupBinding('input_card_height_compact', 'card_height_compact');
    setupBinding('input_card_gap', 'card_gap');
    
    setupBinding('input_vi_bias_breakfast', 'vi_language_bias_breakfast');
    setupBinding('input_vi_bias_lunch', 'vi_language_bias_lunch');
    setupBinding('input_vi_bias_dinner', 'vi_language_bias_dinner');
    setupBinding('input_fav_boost', 'favorite_boost_weight');
    setupBinding('input_remedy_boost', 'remedy_boost_weight');
    setupBinding('input_avoid_thresh', 'avoid_threshold_percent');

    function populateUI() {
        // Populate Steppers
        ['slot_count_breakfast', 'slot_count_lunch', 'slot_count_dinner'].forEach(k => {
            const v = editingConfig[k] || 1;
            document.getElementById(`disp_${k}`).textContent = v;
        });

        // Populate Sliders
        const setSlider = (id, key, multiplier = 1) => {
            const el = document.getElementById(`input_${id}`);
            const valDisp = document.getElementById(`val_${id}`);
            if (el && valDisp) {
                let v = editingConfig[key];
                if (v === undefined) v = DEFAULT_CONFIG[key];
                el.value = v * multiplier;
                if (key === 'favorite_boost_weight' || key === 'remedy_boost_weight') {
                    valDisp.textContent = (v * multiplier).toFixed(1);
                } else {
                    valDisp.textContent = Math.round(v * multiplier);
                }
                updateSliderFill(el);
            }
        };

        setSlider('card_height_single', 'card_height_single');
        setSlider('card_height_compact', 'card_height_compact');
        setSlider('card_gap', 'card_gap');
        setSlider('vi_bias_breakfast', 'vi_language_bias_breakfast', 100);
        setSlider('vi_bias_lunch', 'vi_language_bias_lunch', 100);
        setSlider('vi_bias_dinner', 'vi_language_bias_dinner', 100);
        setSlider('fav_boost', 'favorite_boost_weight');
        setSlider('remedy_boost', 'remedy_boost_weight');
        setSlider('avoid_thresh', 'avoid_threshold_percent');

        renderCategories();
        renderSlotGrid();
    }

    // Categories Logic
    const catList = document.getElementById('config-categories-list');
    document.getElementById('btn-add-category').addEventListener('click', () => {
        const name = prompt("Enter new category key (e.g. 'seafood'):");
        if (name && !editingConfig.categories[name]) {
            editingConfig.categories[name] = [];
            renderCategories();
            renderSlotGrid();
        }
    });

    function renameCategory(oldCat) {
        const newCat = prompt(`Rename category "${oldCat}" to:`, oldCat);
        if (!newCat) return;
        const trimmed = newCat.trim().toLowerCase();
        if (!trimmed || trimmed === oldCat.toLowerCase()) return;
        if (editingConfig.categories[trimmed]) {
            alert(`Category "${trimmed}" already exists.`);
            return;
        }

        // Rebuild categories object to preserve key ordering
        const newCategories = {};
        Object.keys(editingConfig.categories).forEach(k => {
            if (k === oldCat) {
                newCategories[trimmed] = editingConfig.categories[oldCat];
            } else {
                newCategories[k] = editingConfig.categories[k];
            }
        });
        editingConfig.categories = newCategories;

        // Update slot_pool_assignments if any slot was using oldCat
        if (editingConfig.slot_pool_assignments) {
            Object.keys(editingConfig.slot_pool_assignments).forEach(slotId => {
                const pools = editingConfig.slot_pool_assignments[slotId];
                if (Array.isArray(pools)) {
                    editingConfig.slot_pool_assignments[slotId] = pools.map(p => p === oldCat ? trimmed : p);
                }
            });
        }

        renderCategories();
        renderSlotGrid();
    }

    function renderCategories() {
        catList.innerHTML = '';
        Object.keys(editingConfig.categories).forEach(cat => {
            const div = document.createElement('div');
            div.className = 'category-item';
            div.innerHTML = `
                <div class="category-header">
                    <span class="category-title">${cat}</span>
                    <div class="category-actions">
                        <button class="btn-edit-cat" title="Rename category">
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                        </button>
                        <button class="btn-del-cat" style="color: #e74c3c;" title="Delete category">
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                        <button class="btn-toggle-cat" title="Toggle keywords">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                        </button>
                    </div>
                </div>
                <div class="category-body">
                    <div class="tag-input-container" data-cat="${cat}"></div>
                </div>
            `;
            catList.appendChild(div);

            const header = div.querySelector('.category-header');
            header.onclick = (e) => {
                if (e.target.closest('.btn-edit-cat') || e.target.closest('.btn-del-cat')) return;
                div.classList.toggle('expanded');
            };

            div.querySelector('.btn-edit-cat').onclick = (e) => {
                e.stopPropagation();
                renameCategory(cat);
            };

            div.querySelector('.btn-del-cat').onclick = (e) => {
                e.stopPropagation();
                if (confirm(`Delete category "${cat}"?`)) {
                    delete editingConfig.categories[cat];
                    if (editingConfig.slot_pool_assignments) {
                        Object.keys(editingConfig.slot_pool_assignments).forEach(slotId => {
                            const pools = editingConfig.slot_pool_assignments[slotId];
                            if (Array.isArray(pools)) {
                                editingConfig.slot_pool_assignments[slotId] = pools.filter(p => p !== cat);
                            }
                        });
                    }
                    renderCategories();
                    renderSlotGrid();
                }
            };

            const tagContainer = div.querySelector('.tag-input-container');
            renderTags(tagContainer, editingConfig.categories[cat], (newTags) => {
                editingConfig.categories[cat] = newTags;
            });
        });
    }

    function renderTags(container, tagsArray, onChange) {
        container.innerHTML = '';
        tagsArray.forEach((tag, idx) => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.innerHTML = `${tag} <button class="tag-chip-delete">×</button>`;
            chip.querySelector('button').onclick = () => {
                tagsArray.splice(idx, 1);
                onChange(tagsArray);
                renderTags(container, tagsArray, onChange);
            };
            container.appendChild(chip);
        });

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tag-input';
        input.placeholder = 'Type and press Enter';
        input.onkeydown = (e) => {
            if (e.key === 'Enter' && input.value.trim()) {
                e.preventDefault();
                tagsArray.push(input.value.trim().toLowerCase());
                onChange(tagsArray);
                renderTags(container, tagsArray, onChange);
                const newInput = container.querySelector('.tag-input');
                if (newInput) newInput.focus();
            }
        };
        container.appendChild(input);
    }

    // Close open custom selects when clicking outside or scrolling
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-multi-select-dropdown') && !e.target.closest('.custom-multi-select-trigger')) {
            document.querySelectorAll('.custom-multi-select.open').forEach(el => el.classList.remove('open'));
        }
    });

    document.addEventListener('scroll', (e) => {
        if (e.target && e.target.closest && e.target.closest('#home-config-modal')) {
            document.querySelectorAll('.custom-multi-select.open').forEach(el => el.classList.remove('open'));
        }
    }, true);

    window.addEventListener('resize', () => {
        document.querySelectorAll('.custom-multi-select.open').forEach(el => el.classList.remove('open'));
    });

    function createCustomMultiSelect(options, selectedValues, placeholder, onChange) {
        const container = document.createElement('div');
        container.className = 'custom-multi-select';
        
        const trigger = document.createElement('div');
        trigger.className = 'custom-multi-select-trigger';
        
        const valueContainer = document.createElement('div');
        valueContainer.className = 'custom-multi-select-value';
        
        const icon = document.createElement('div');
        icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
        
        trigger.appendChild(valueContainer);
        trigger.appendChild(icon);
        
        const dropdown = document.createElement('div');
        dropdown.className = 'custom-multi-select-dropdown';
        
        container.appendChild(trigger);
        container.appendChild(dropdown);
        
        const renderValues = () => {
            valueContainer.innerHTML = '';
            if (selectedValues.length === 0) {
                valueContainer.innerHTML = `<span class="custom-multi-select-placeholder">${placeholder}</span>`;
            } else {
                const maxChips = 2; // Show up to 2 chips
                const chipsToShow = selectedValues.slice(0, maxChips);
                chipsToShow.forEach(val => {
                    const opt = options.find(o => o.value === val);
                    const label = opt ? opt.label : val;
                    const chip = document.createElement('span');
                    chip.className = 'custom-multi-select-chip';
                    chip.textContent = label;
                    valueContainer.appendChild(chip);
                });
                if (selectedValues.length > maxChips) {
                    const extra = document.createElement('span');
                    extra.className = 'custom-multi-select-chip-extra';
                    extra.textContent = `+${selectedValues.length - maxChips}`;
                    valueContainer.appendChild(extra);
                }
            }
        };
        
        const renderOptions = () => {
            dropdown.innerHTML = '';
            options.forEach(opt => {
                const isSelected = selectedValues.includes(opt.value);
                const item = document.createElement('div');
                item.className = `custom-multi-select-option ${isSelected ? 'selected' : ''}`;
                
                const checkbox = document.createElement('div');
                checkbox.className = 'custom-multi-select-checkbox';
                
                const label = document.createElement('span');
                label.textContent = opt.label;
                
                item.appendChild(checkbox);
                item.appendChild(label);
                
                item.onclick = (e) => {
                    e.stopPropagation();
                    if (isSelected) {
                        selectedValues = selectedValues.filter(v => v !== opt.value);
                    } else {
                        selectedValues.push(opt.value);
                    }
                    renderValues();
                    renderOptions();
                    onChange(selectedValues);
                };
                dropdown.appendChild(item);
            });
        };
        
        const positionDropdown = () => {
            const rect = trigger.getBoundingClientRect();
            const dropdownHeight = 220;
            const spaceBelow = window.innerHeight - rect.bottom;
            
            dropdown.style.position = 'fixed';
            dropdown.style.left = `${rect.left}px`;
            dropdown.style.width = `${rect.width}px`;
            dropdown.style.zIndex = '99999';
            
            if (spaceBelow < dropdownHeight && rect.top > dropdownHeight) {
                // Open upwards if not enough space below
                dropdown.style.top = 'auto';
                dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            } else {
                // Open downwards
                dropdown.style.bottom = 'auto';
                dropdown.style.top = `${rect.bottom + 4}px`;
            }
        };

        trigger.onclick = (e) => {
            e.stopPropagation();
            const willOpen = !container.classList.contains('open');
            document.querySelectorAll('.custom-multi-select.open').forEach(el => {
                if (el !== container) el.classList.remove('open');
            });
            if (willOpen) {
                positionDropdown();
                container.classList.add('open');
            } else {
                container.classList.remove('open');
            }
        };
        
        renderValues();
        renderOptions();
        
        return container;
    }

    // Slot Grid Logic
    function renderSlotGrid() {
        const tbody = document.getElementById('config-slots-tbody');
        tbody.innerHTML = '';
        
        ['breakfast', 'lunch', 'dinner'].forEach(mealCat => {
            const count = editingConfig[`slot_count_${mealCat}`] || 1;
            for (let i = 0; i < count; i++) {
                const slotId = `${mealCat}_${i}`;
                const isSingle = count === 1;
                
                const tr = document.createElement('tr');
                
                // Ensure slot_card_types exists
                editingConfig.slot_card_types = editingConfig.slot_card_types || {};
                
                let cardTypeHtml = '';
                if (isSingle) {
                    editingConfig.slot_card_types[slotId] = 'full_single';
                    cardTypeHtml = `<span style="color:var(--text-muted); font-size:0.85rem;">Full Single</span>`;
                } else {
                    const currentType = editingConfig.slot_card_types[slotId] || (i === 0 ? 'full_multi' : 'compact');
                    editingConfig.slot_card_types[slotId] = currentType;
                    cardTypeHtml = `
                        <select class="select-shadcn card-type-select" data-slot="${slotId}">
                            <option value="full_multi" ${currentType === 'full_multi' ? 'selected' : ''}>Full Multi</option>
                            <option value="compact" ${currentType === 'compact' ? 'selected' : ''}>Compact</option>
                        </select>
                    `;
                }
                
                // Pools Selector Data
                const assigned = (editingConfig.slot_pool_assignments[slotId] || []).filter(p => p !== 'none');
                const poolOptions = Object.keys(editingConfig.categories).map(cat => ({value: cat, label: cat}));

                // Meal Types Selector Data
                const mtypes = editingConfig.slot_meal_types ? (editingConfig.slot_meal_types[slotId] || []) : [];
                const typeOptions = [
                    {value: 'breakfast', label: 'Breakfast'},
                    {value: 'lunch', label: 'Lunch'},
                    {value: 'dinner', label: 'Dinner'},
                    {value: 'none', label: 'None'}
                ];

                tr.innerHTML = `
                    <td><strong>${slotId}</strong></td>
                    <td>${cardTypeHtml}</td>
                    <td class="pool-td"></td>
                    <td class="type-td"></td>
                    <td><div class="tag-input-container inc-tags" data-slot="${slotId}"></div></td>
                    <td><div class="tag-input-container exc-tags" data-slot="${slotId}"></div></td>
                `;
                tbody.appendChild(tr);

                // Attach Card Type Change
                const typeSelectEl = tr.querySelector('.card-type-select');
                if (typeSelectEl) {
                    typeSelectEl.onchange = (e) => {
                        editingConfig.slot_card_types[slotId] = e.target.value;
                    };
                }

                // Mount Custom Selects
                const poolSelect = createCustomMultiSelect(poolOptions, assigned, 'Select Pools', (newVals) => {
                    editingConfig.slot_pool_assignments = editingConfig.slot_pool_assignments || {};
                    editingConfig.slot_pool_assignments[slotId] = newVals;
                });
                tr.querySelector('.pool-td').appendChild(poolSelect);
                
                const typeSelect = createCustomMultiSelect(typeOptions, mtypes, 'Select Types', (newVals) => {
                    editingConfig.slot_meal_types = editingConfig.slot_meal_types || {};
                    editingConfig.slot_meal_types[slotId] = newVals;
                });
                tr.querySelector('.type-td').appendChild(typeSelect);

                // Keywords
                editingConfig.slot_include_keywords = editingConfig.slot_include_keywords || {};
                editingConfig.slot_exclude_keywords = editingConfig.slot_exclude_keywords || {};
                
                const incTags = editingConfig.slot_include_keywords[slotId] || [];
                const excTags = editingConfig.slot_exclude_keywords[slotId] || [];
                
                renderTags(tr.querySelector('.inc-tags'), incTags, (newTags) => {
                    editingConfig.slot_include_keywords[slotId] = newTags;
                });
                renderTags(tr.querySelector('.exc-tags'), excTags, (newTags) => {
                    editingConfig.slot_exclude_keywords[slotId] = newTags;
                });
            }
        });
    }

    // Save and Reset
    saveBtn.addEventListener('click', async () => {
        try {
            saveBtn.innerHTML = 'Saving...';
            const updated = await window.API.put('/api/config', editingConfig);
            window.homeConfig = updated;
            if (window.applyHomeConfigStyles) window.applyHomeConfigStyles();
            if (window.renderWeeklyPlan) window.renderWeeklyPlan();
            closeModal();
            showNotification('Success', 'Configuration saved successfully. Generating a new meal plan is recommended.');
        } catch (e) {
            alert('Failed to save config: ' + (e.message || e));
        } finally {
            saveBtn.innerHTML = 'Save Configuration';
        }
    });

    resetBtn.addEventListener('click', async () => {
        if (!confirm("Are you sure you want to reset to system defaults?")) return;
        try {
            const reset = await window.API.post('/api/config/reset');
            window.homeConfig = reset;
            editingConfig = JSON.parse(JSON.stringify(window.homeConfig));
            populateUI();
            if (window.applyHomeConfigStyles) window.applyHomeConfigStyles();
            if (window.renderWeeklyPlan) window.renderWeeklyPlan();
            showNotification('Reset', 'Configuration reset to default.');
        } catch (e) {
            alert('Failed to reset config: ' + (e.message || e));
        }
    });

});
