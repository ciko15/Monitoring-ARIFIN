/**
 * configure-app.js
 * Integrated Configuration Management System for dev-smart
 * Migrated from Monitoring-ARIFIN-main
 */

(function() {
    'use strict';

    // --- State & Cache ---
    let configLimitationCache = [];
    let configAuthenticationCache = [];
    let configParsingCache = [];
    let configSupCategoryCache = [];
    let configCategoryCache = [];

    const configPagination = {
        'limitation': { currentPage: 1, pageSize: 10 },
        'authentication': { currentPage: 1, pageSize: 10 },
        'parsing': { currentPage: 1, pageSize: 10 }
    };

    window.changeLimitationPageSize = function(size) {
        configPagination['limitation'].pageSize = parseInt(size, 10) || 10;
        configPagination['limitation'].currentPage = 1;
        renderConfigTable('limitation');
    };

    window.changeAuthenticationPageSize = function(size) {
        configPagination['authentication'].pageSize = parseInt(size, 10) || 10;
        configPagination['authentication'].currentPage = 1;
        renderConfigTable('authentication');
    };

    window.changeParsingPageSize = function(size) {
        configPagination['parsing'].pageSize = parseInt(size, 10) || 10;
        configPagination['parsing'].currentPage = 1;
        renderConfigTable('parsing');
    };

    const pluralMap = {
        'limitation': 'limitations',
        'parsing': 'parsings',
        'sup-category': 'sup-categories',
        'category': 'categories'
    };

    // --- Initialization ---
    window.initConfigureModule = function() {
        console.log('[Configure] Initializing module...');
        initNav();
        // Ensure limitation tab is visually active and its content is shown
        const limitationTab = document.querySelector('#configureSection .config-nav-item[data-config="limitation"]');
        if (limitationTab) {
            limitationTab.click();
        } else {
            loadConfigData('limitation');
        }
    };

    function initNav() {
        if (window._configNavInitialized) return;
        window._configNavInitialized = true;

        const navItems = document.querySelectorAll('#configureSection .config-nav-item');
        const contents = document.querySelectorAll('#configureSection .config-content-item');

        navItems.forEach(item => {
            item.addEventListener('click', () => {
                const type = item.dataset.config;
                
                // Update nav
                navItems.forEach(n => n.classList.remove('active'));
                item.classList.add('active');

                // Update content visibility
                contents.forEach(c => {
                    const targetId = `config${type.charAt(0).toUpperCase() + type.slice(1).replace(/-([a-z])/g, g => g[1].toUpperCase())}Content`;
                    if (c.id === targetId) c.classList.remove('hidden');
                    else c.classList.add('hidden');
                });

                loadConfigData(type);
            });
        });
    }

    // --- Data Loading ---
    window.loadConfigData = async function(type, silent = false) {
        console.log('[Configure] loadConfigData called with type:', type, 'silent:', silent);
        if (type === 'ems-settings') {
            if (typeof window.loadEmsSettings === 'function') window.loadEmsSettings();
            return;
        }
        if (type === 'templates') {
            console.log('[Configure] Checking window.loadTemplates:', typeof window.loadTemplates);
            if (typeof window.loadTemplates === 'function') {
                console.log('[Configure] Calling window.loadTemplates()');
                window.loadTemplates();
            } else {
                console.error('[Configure] window.loadTemplates is NOT a function!');
            }
            return;
        }

        const baseTab = type.charAt(0).toUpperCase() + type.slice(1);
        const formattedTab = baseTab.replace(/-([a-z])/g, g => g[1].toUpperCase());
        const tbodyId = `config${formattedTab}TableBody`;
        const tbody = document.getElementById(tbodyId);

        if (!tbody) return;
        if (!silent) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
        }

        try {
            const pathType = pluralMap[type] || (type + 's');
            const res = await fetch(`/api/config/${pathType}`, { headers: window.getAuthHeaders() });
            const data = await res.json();

            if (!Array.isArray(data)) {
                tbody.innerHTML = '<tr><td colspan="10" class="empty-state text-danger">Error: Invalid data format</td></tr>';
                return;
            }

            // Update Caches
            if (type === 'limitation') {
                configLimitationCache = data;
                updateLimitationFilterOptions();
            } else if (type === 'authentication') {
                configAuthenticationCache = data;
                updateAuthenticationFilterOptions();
            } else if (type === 'parsing') {
                configParsingCache = data;
            } else if (type === 'sup-category') {
                configSupCategoryCache = data;
            } else if (type === 'category') {
                configCategoryCache = data;
            }

            renderConfigTable(type);
        } catch (err) {
            console.error('[Configure] Load error:', err);
            tbody.innerHTML = `<tr><td colspan="10" class="empty-state text-danger">Error: ${err.message}</td></tr>`;
        }
    };

    // --- Rendering ---
    function renderConfigTable(type) {
        const baseTab = type.charAt(0).toUpperCase() + type.slice(1);
        const formattedTab = baseTab.replace(/-([a-z])/g, g => g[1].toUpperCase());
        const tbodyId = `config${formattedTab}TableBody`;
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;

        let rawData = [];
        if (type === 'limitation') rawData = configLimitationCache;
        else if (type === 'authentication') rawData = configAuthenticationCache;
        else if (type === 'parsing') rawData = configParsingCache;
        else if (type === 'sup-category') rawData = configSupCategoryCache;
        else if (type === 'category') rawData = configCategoryCache;

        // Apply Search / Filters
        const searchIdMap = {
            'limitation': 'searchLimitation',
            'authentication': 'searchAuthentication',
            'parsing': 'searchParsing',
            'sup-category': 'searchSupCategory',
            'category': 'searchCategory'
        };
        const searchEl = document.getElementById(searchIdMap[type]);
        const term = (searchEl?.value || '').toLowerCase().trim();

        let filteredData = rawData.filter(item => {
            if (type === 'limitation') {
                const limitFilter = document.getElementById('filterLimitationSupCategory')?.value;
                if (limitFilter && item.sup_category !== limitFilter) return false;
                if (term) {
                    const matchName = String(item.name || '').toLowerCase().includes(term);
                    const matchSup = String(item.sup_category || '').toLowerCase().includes(term);
                    const matchVal = String(item.value_type || '').toLowerCase().includes(term);
                    return matchName || matchSup || matchVal;
                }
                return true;
            } else if (type === 'authentication') {
                const linkedFilter = document.getElementById('filterAuthenticationLinkedEquipment')?.value;
                if (linkedFilter === 'global') {
                    if (item.equipt_id) return false;
                } else if (linkedFilter) {
                    if (String(item.equipt_id) !== linkedFilter) return false;
                }
                if (term) {
                    const matchName = String(item.name || '').toLowerCase().includes(term);
                    const matchIp = String(item.ip_address || '').toLowerCase().includes(term);
                    const matchId = String(item.equipt_id || '').toLowerCase().includes(term);
                    const equipt = (window.equipmentData || []).find(e => String(e.id) === String(item.equipt_id));
                    const matchEqName = equipt ? String(equipt.name || '').toLowerCase().includes(term) : false;
                    return matchName || matchIp || matchId || matchEqName;
                }
                return true;
            } else if (type === 'parsing') {
                if (term) {
                    const matchName = String(item.name || '').toLowerCase().includes(term);
                    const matchCat = String(item.category || '').toLowerCase().includes(term);
                    const matchFiles = String(item.files || '').toLowerCase().includes(term);
                    return matchName || matchCat || matchFiles;
                }
                return true;
            } else if (type === 'sup-category') {
                if (term) {
                    const matchCat = String(item.category || '').toLowerCase().includes(term);
                    const matchSub = (item.sub_categories || []).some(s => String(s).toLowerCase().includes(term));
                    return matchCat || matchSub;
                }
                return true;
            } else if (type === 'category') {
                if (term) {
                    const categoryName = typeof item === 'object' ? (item.category || item.name || item.id || JSON.stringify(item)) : String(item);
                    return categoryName.toLowerCase().includes(term);
                }
                return true;
            }
            return true;
        });

        tbody.innerHTML = '';

        const paginationContainer = document.getElementById(`${type}Pagination`);

        if (filteredData.length === 0) {
            tbody.innerHTML = term
                ? `<tr><td colspan="10" class="empty-state" style="color:var(--text-muted); padding:24px; text-align:center;"><i class="fas fa-search" style="margin-right:6px;"></i>Tidak ada hasil untuk "<strong>${term}</strong>"</td></tr>`
                : '<tr><td colspan="10" class="empty-state">No configuration items found</td></tr>';
            if (paginationContainer) {
                paginationContainer.innerHTML = '';
                paginationContainer.style.display = 'none';
            }
            return;
        }

        let displayData = filteredData;
        if (configPagination[type]) {
            const paginationState = configPagination[type];
            const pageSize = paginationState.pageSize || 10;
            const total = filteredData.length;
            const totalPages = Math.max(1, Math.ceil(total / pageSize));

            if (paginationState.currentPage > totalPages) {
                paginationState.currentPage = totalPages;
            }
            if (paginationState.currentPage < 1) {
                paginationState.currentPage = 1;
            }
            const currentPage = paginationState.currentPage;

            const startIndex = (currentPage - 1) * pageSize;
            displayData = filteredData.slice(startIndex, startIndex + pageSize);

            if (paginationContainer) {
                const fnMap = {
                    'limitation': 'changeLimitationPageSize',
                    'authentication': 'changeAuthenticationPageSize',
                    'parsing': 'changeParsingPageSize'
                };
                if (window.generateSharedPaginationHTML) {
                    paginationContainer.innerHTML = window.generateSharedPaginationHTML(
                        currentPage,
                        totalPages,
                        pageSize,
                        fnMap[type]
                    );
                    paginationContainer.querySelectorAll('button[data-page]').forEach(btn => {
                        btn.addEventListener('click', e => {
                            e.preventDefault();
                            const p = parseInt(btn.getAttribute('data-page'), 10);
                            if (!isNaN(p) && p >= 1 && p <= totalPages && p !== currentPage) {
                                paginationState.currentPage = p;
                                renderConfigTable(type);
                            }
                        });
                    });
                    paginationContainer.style.display = 'flex';
                }
            }
        }

        displayData.forEach(item => {
            const tr = document.createElement('tr');

            if (type === 'limitation') {
                const minLimits = `min: ${item.min_alarm_limit || item.alv || '-'} / ${item.min_warning_limit || item.wlv || '-'}`;
                const maxLimits = `max: ${item.max_warning_limit || item.whv || '-'} / ${item.max_alarm_limit || item.ahv || '-'}`;
                const isActive = item.is_active !== false && item.is_active !== 0 && item.is_active !== '0';
                const statusBadge = isActive
                    ? `<button type="button" class="badge" onclick="toggleLimitationStatus('${item.id}', false)" title="Klik untuk menonaktifkan" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); cursor: pointer; transition: all 0.2s;"><i class="fas fa-check-circle" style="margin-right: 4px;"></i>Active</button>`
                    : `<button type="button" class="badge" onclick="toggleLimitationStatus('${item.id}', true)" title="Klik untuk mengaktifkan" style="background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3); cursor: pointer; transition: all 0.2s;"><i class="fas fa-pause-circle" style="margin-right: 4px;"></i>Disabled</button>`;

                tr.innerHTML = `
                    <td><strong>${item.name}</strong></td>
                    <td><span class="badge badge-info">${item.sup_category}</span></td>
                    <td>${item.value_type || 'numeric'}</td>
                    <td style="font-size: 0.85rem;">
                        <div><small style="color:var(--text-muted)">Expected:</small> ${item.expected_value || '-'}</div>
                        <div style="color:var(--status-warning)">${minLimits}</div>
                        <div style="color:var(--status-alert)">${maxLimits}</div>
                    </td>
                    <td>${statusBadge}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-action btn-edit" onclick="editConfigItem('limitation', '${item.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                            <button class="btn-action btn-delete" onclick="deleteConfigItem('limitation', '${item.id}')" title="Hapus"><i class="fas fa-trash"></i></button>
                        </div>
                    </td>
                `;
            } else if (type === 'parsing') {
                tr.innerHTML = `
                    <td><strong>${item.name}</strong></td>
                    <td><span class="badge badge-secondary">${item.category}</span></td>
                    <td><code>${item.files || '-'}</code></td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-action btn-edit" onclick="editConfigItem('parsing', '${item.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                            <button class="btn-action btn-delete" onclick="deleteConfigItem('parsing', '${item.id}')" title="Hapus"><i class="fas fa-trash"></i></button>
                        </div>
                    </td>
                `;
            } else if (type === 'sup-category') {
                tr.innerHTML = `
                    <td><strong>${item.category}</strong></td>
                    <td>${(item.sub_categories || []).map(s => `<span class="badge badge-outline">${s}</span>`).join(' ')}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-action btn-edit" onclick="editConfigItem('sup-category', '${item.category}')" title="Edit"><i class="fas fa-edit"></i></button>
                            <button class="btn-action btn-delete" onclick="deleteConfigItem('sup-category', '${item.category}')" title="Hapus"><i class="fas fa-trash"></i></button>
                        </div>
                    </td>
                `;
            } else if (type === 'category') {
                const categoryName = typeof item === 'object' ? (item.category || item.name || item.id || JSON.stringify(item)) : item;
                tr.innerHTML = `
                    <td><strong>${categoryName}</strong></td>
                    <td><span class="badge badge-success">System Fixed</span></td>
                `;
            } else if (type === 'authentication') {
                const equipt = (window.equipmentData || []).find(e => String(e.id) === String(item.equipt_id));
                const equiptName = equipt ? equipt.name : (item.equipt_id ? `ID: ${item.equipt_id}` : '<span class="text-muted">Global</span>');

                tr.innerHTML = `
                    <td><strong>${item.name}</strong></td>
                    <td><code>${item.ip_address || '-'}</code></td>
                    <td><span class="badge badge-outline">${equiptName}</span></td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-action btn-edit" onclick="editConfigItem('authentication', '${item.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                            <button class="btn-action btn-delete" onclick="deleteConfigItem('authentication', '${item.id}')" title="Hapus"><i class="fas fa-trash"></i></button>
                        </div>
                    </td>
                `;
            }

            tbody.appendChild(tr);
        });
    }

    // --- Modal Actions ---
    window.showAddConfigModal = function(type) {
        const modal = document.getElementById('configModal');
        const title = document.getElementById('configModalTitle');
        const container = document.getElementById('configFormFields');
        const form = document.getElementById('configForm');

        form.reset();
        document.getElementById('configItemType').value = type;
        document.getElementById('configItemId').value = '';
        
        title.innerHTML = `<i class="fas fa-plus"></i> Add New ${type.charAt(0).toUpperCase() + type.slice(1)}`;
        
        renderFields(type, null, container);
        modal.classList.remove('hidden');
    };

    window.editConfigItem = async function(type, id) {
        try {
            const pathType = pluralMap[type] || (type + 's');
            const res = await fetch(`/api/config/${pathType}`, { headers: window.getAuthHeaders() });
            const list = await res.json();
            const item = Array.isArray(list) ? list.find(i => (i.id == id || (type === 'sup-category' && i.category == id))) : null;

            if (!item) {
                alert('Item not found');
                return;
            }

            const modal = document.getElementById('configModal');
            const title = document.getElementById('configModalTitle');
            const container = document.getElementById('configFormFields');
            
            document.getElementById('configItemType').value = type;
            document.getElementById('configItemId').value = id;
            
            title.innerHTML = `<i class="fas fa-edit"></i> Edit ${type.charAt(0).toUpperCase() + type.slice(1)}`;
            
            renderFields(type, item, container);
            modal.classList.remove('hidden');
        } catch (err) {
            console.error('[Configure] Edit error:', err);
            alert('Error loading item details');
        }
    };

    window.closeConfigModal = function() {
        document.getElementById('configModal').classList.add('hidden');
    };

    function renderFields(type, item, container) {
        container.innerHTML = '';

        if (type === 'limitation') {
            const categories = ['Communication', 'Navigation', 'Surveillance', 'Data Processing', 'Support'];
            const catOptions = categories.map(c => `<option value="${c}" ${item?.category === c ? 'selected' : ''}>${c}</option>`).join('');

            container.innerHTML = `
                <div class="form-group-ux">
                    <label>Parameter Name</label>
                    <input type="text" name="name" value="${item?.name || ''}" required>
                </div>
                <div class="form-row-ux">
                    <div class="form-group-ux">
                        <label>Category</label>
                        <select name="category" required onchange="window.updateModalSubCategories(this.value)">
                            ${catOptions}
                        </select>
                    </div>
                    <div class="form-group-ux">
                        <label>Sub-Category</label>
                        <select name="sup_category" id="configModalSubCategory" required>
                            <option value="${item?.sup_category || ''}">${item?.sup_category || 'Select Category First'}</option>
                        </select>
                    </div>
                </div>
                <div class="form-row-ux">
                    <div class="form-group-ux">
                        <label>Value Type</label>
                        <select name="value_type">
                            <option value="numeric" ${item?.value_type === 'numeric' ? 'selected' : ''}>Numeric Range</option>
                            <option value="string" ${item?.value_type === 'string' ? 'selected' : ''}>String Match</option>
                            <option value="percent" ${item?.value_type === 'percent' ? 'selected' : ''}>Percentage</option>
                        </select>
                    </div>
                    <div class="form-group-ux">
                        <label>Expected Value</label>
                        <input type="text" name="expected_value" value="${item?.expected_value || ''}">
                    </div>
                </div>
                <div class="form-row-ux">
                    <div class="form-group-ux">
                        <label>Min Alarm / Warning</label>
                        <div style="display:flex; gap:5px;">
                            <input type="number" step="any" name="min_alarm_limit" value="${item?.min_alarm_limit || item?.alv || ''}" placeholder="Alarm">
                            <input type="number" step="any" name="min_warning_limit" value="${item?.min_warning_limit || item?.wlv || ''}" placeholder="Warning">
                        </div>
                    </div>
                    <div class="form-group-ux">
                        <label>Max Warning / Alarm</label>
                        <div style="display:flex; gap:5px;">
                            <input type="number" step="any" name="max_warning_limit" value="${item?.max_warning_limit || item?.whv || ''}" placeholder="Warning">
                            <input type="number" step="any" name="max_alarm_limit" value="${item?.max_alarm_limit || item?.ahv || ''}" placeholder="Alarm">
                        </div>
                    </div>
                </div>
                <div class="form-group-ux" style="margin-top: 10px; background: rgba(255,255,255,0.02); padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border-color);">
                    <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin: 0; font-size: 0.95rem;">
                        <input type="checkbox" name="is_active" value="true" ${item?.is_active !== false && item?.is_active !== 0 && item?.is_active !== '0' ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer; accent-color: #3b82f6;">
                        <span style="font-weight: 600; color: #fff;">Aktifkan Alarm Limit (is_active)</span>
                    </label>
                    <div style="color: var(--text-muted); font-size: 0.8rem; margin-top: 4px; margin-left: 28px;">
                        Jika dinonaktifkan, alarm dan warning untuk parameter ini akan di-bypass (status Normal/Netral).
                    </div>
                </div>
            `;
            // Trigger sub-cat load
            setTimeout(() => window.updateModalSubCategories(item?.category || 'Communication', item?.sup_category), 50);
        } else if (type === 'parsing') {
            container.innerHTML = `
                <div class="form-group-ux">
                    <label>Template Name</label>
                    <input type="text" name="name" value="${item?.name || ''}" required>
                </div>
                <div class="form-group-ux">
                    <label>Category</label>
                    <select name="category">
                        <option value="Communication" ${item?.category === 'Communication' ? 'selected' : ''}>Communication</option>
                        <option value="Navigation" ${item?.category === 'Navigation' ? 'selected' : ''}>Navigation</option>
                        <option value="Surveillance" ${item?.category === 'Surveillance' ? 'selected' : ''}>Surveillance</option>
                        <option value="Data Processing" ${item?.category === 'Data Processing' ? 'selected' : ''}>Data Processing</option>
                        <option value="Support" ${item?.category === 'Support' ? 'selected' : ''}>Support</option>
                    </select>
                </div>
                <div class="form-group-ux">
                    <label>Parser File Path</label>
                    <input type="text" name="files" value="${item?.files || ''}" required placeholder="e.g. /public/parsers/vscs.js">
                </div>
            `;
        } else if (type === 'authentication') {
            container.innerHTML = `
                <div class="form-row-ux">
                    <div class="form-group-ux">
                        <label>Data Source Name</label>
                        <input type="text" name="name" value="${item?.name || ''}" required placeholder="e.g. VHF PAE 1">
                    </div>
                    <div class="form-group-ux">
                        <label>Source ID / IP Address</label>
                        <input type="text" name="ip_address" value="${item?.ip_address || ''}" placeholder="e.g. 192.168.1.10">
                    </div>
                </div>
                <div class="form-row-ux">
                    <div class="form-group-ux">
                        <label>Linked Equipment ID</label>
                        <input type="text" name="equipt_id" value="${item?.equipt_id || ''}" placeholder="Leave empty for global">
                    </div>
                    <div class="form-group-ux">
                        <label>Parsing ID</label>
                        <input type="text" name="parsing_id" value="${item?.parsing_id || ''}" placeholder="e.g. ping_monitor">
                    </div>
                </div>
            `;
        } else if (type === 'sup-category') {
            window._tempSubCategories = item?.sub_categories ? [...item.sub_categories] : [];
            container.innerHTML = `
                <div class="form-group-ux">
                    <label>Main Category</label>
                    <input type="text" name="category" value="${item?.category || ''}" ${item ? 'readonly' : ''} required>
                </div>
                <div class="form-group-ux" style="align-items: flex-start;">
                    <label style="margin-top: 8px;">Sub Categories</label>
                    <div style="flex: 1; display: flex; flex-direction: column; gap: 12px; min-width: 0;">
                        <div id="subCategoryChipsContainer" style="display: flex; flex-wrap: wrap; gap: 8px; min-height: 42px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 6px; border: 1px solid var(--border-color);">
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="newSubCategoryInput" placeholder="Type category and press Add..." class="form-control-ux" style="flex: 1;" onkeypress="if(event.key === 'Enter') { event.preventDefault(); window.addSubCategoryChip(); }">
                            <button type="button" class="btn btn-primary" onclick="window.addSubCategoryChip()" style="padding: 0 20px; display: flex; align-items: center; gap: 6px;">
                                <i class="fas fa-plus"></i> Add
                            </button>
                        </div>
                        <input type="hidden" name="sub_categories_raw" id="sub_categories_raw" value="">
                    </div>
                </div>
            `;
            setTimeout(() => window.renderSubCategoryChips(), 50);
        }
    }

    // --- Form Submission ---
    document.getElementById('configForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const type = formData.get('configItemType');
        const id = formData.get('configItemId');
        const data = Object.fromEntries(formData.entries());

        if (type === 'sup-category') {
            data.sub_categories = window._tempSubCategories || [];
            delete data.sub_categories_raw;
        } else if (type === 'limitation') {
            data.is_active = formData.has('is_active');
        }

        try {
            const pathType = pluralMap[type] || (type + 's');
            const method = id ? 'PUT' : 'POST';
            const url = id ? `/api/config/${pathType}/${id}` : `/api/config/${pathType}`;

            const res = await fetch(url, {
                method,
                headers: window.getAuthHeaders(),
                body: JSON.stringify(data)
            });

            if (res.ok) {
                closeConfigModal();
                loadConfigData(type, true);
                if (window.showToast) window.showToast('Configuration saved successfully', 'success');
            } else {
                const err = await res.json();
                alert(`Error: ${err.message || 'Operation failed'}`);
            }
        } catch (err) {
            console.error('[Configure] Save error:', err);
            alert('Failed to save configuration');
        }
    });

    window.deleteConfigItem = async function(type, id) {
        if (!confirm('Are you sure you want to delete this configuration?')) return;

        try {
            const pathType = pluralMap[type] || (type + 's');
            const res = await fetch(`/api/config/${pathType}/${id}`, {
                method: 'DELETE',
                headers: window.getAuthHeaders()
            });

            if (res.ok) {
                loadConfigData(type, true);
                if (window.showToast) window.showToast('Item deleted', 'success');
            } else {
                alert('Delete failed');
            }
        } catch (err) {
            console.error('[Configure] Delete error:', err);
            alert('Error during deletion');
        }
    };

    window.toggleLimitationStatus = async function(id, targetState) {
        try {
            const item = configLimitationCache.find(l => String(l.id) === String(id));
            const itemName = item?.name || `Limitation #${id}`;
            const actionText = targetState ? 'mengaktifkan' : 'menonaktifkan';

            const payload = {
                ...(item || {}),
                is_active: targetState
            };

            const res = await fetch(`/api/config/limitations/${id}`, {
                method: 'PUT',
                headers: window.getAuthHeaders(),
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                // Update local cache instantly
                if (item) item.is_active = targetState;
                if (window.limitationsCache) {
                    const cached = window.limitationsCache.find(l => String(l.id) === String(id));
                    if (cached) cached.is_active = targetState;
                }
                renderConfigTable('limitation');
                if (window.showToast) {
                    window.showToast(`Berhasil ${actionText} ${itemName}`, 'success');
                }
            } else {
                const err = await res.json().catch(() => ({}));
                alert(`Gagal ${actionText}: ${err.message || res.statusText}`);
            }
        } catch (err) {
            console.error('[Configure] Toggle status error:', err);
            alert('Terjadi kesalahan saat mengubah status.');
        }
    };

    // --- Helpers ---
    window.updateModalSubCategories = function(category, selected = null) {
        const select = document.getElementById('configModalSubCategory');
        if (!select) return;

        const group = (window.supCategoriesData || []).find(c => c.category === category);
        const options = group ? group.sub_categories : [];

        select.innerHTML = options.map(o => `<option value="${o}" ${o === selected ? 'selected' : ''}>${o}</option>`).join('');
    };

    function updateLimitationFilterOptions() {
        const select = document.getElementById('filterLimitationSupCategory');
        if (!select) return;
        const current = select.value;
        const unique = [...new Set(configLimitationCache.map(i => i.sup_category).filter(Boolean))].sort();
        select.innerHTML = '<option value="">All Sub-Categories</option>' + 
            unique.map(c => `<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`).join('');
    }

    function updateAuthenticationFilterOptions() {
        const select = document.getElementById('filterAuthenticationLinkedEquipment');
        if (!select) return;
        const current = select.value;
        const linkedIds = [...new Set(configAuthenticationCache.map(i => i.equipt_id).filter(Boolean))];
        let optionsHtml = '<option value="">All Equipment</option><option value="global" ' + (current === 'global' ? 'selected' : '') + '>Global (No Link)</option>';
        linkedIds.forEach(id => {
            const eq = (window.equipmentData || []).find(e => String(e.id) === String(id));
            const name = eq ? `${eq.name} (ID: ${id})` : `ID: ${id}`;
            optionsHtml += `<option value="${id}" ${String(id) === current ? 'selected' : ''}>${name}</option>`;
        });
        select.innerHTML = optionsHtml;
    }



    // --- Sub-Category Chip UI Logic ---
    window._tempSubCategories = [];
    window.renderSubCategoryChips = function() {
        const container = document.getElementById('subCategoryChipsContainer');
        const hiddenInput = document.getElementById('sub_categories_raw');
        if (!container) return;
        
        container.innerHTML = window._tempSubCategories.map((sc, index) => `
            <div style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); color: #60a5fa; padding: 6px 12px; border-radius: 16px; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; transition: all 0.2s ease;">
                ${sc}
                <div style="display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; cursor: pointer; transition: all 0.2s ease;" onmouseover="this.style.background='rgba(248, 113, 113, 0.2)'; this.style.color='#f87171'" onmouseout="this.style.background='transparent'; this.style.color='inherit'" onclick="window.removeSubCategoryChip(${index})">
                    <i class="fas fa-times" style="font-size: 10px;"></i>
                </div>
            </div>
        `).join('');
        
        if (window._tempSubCategories.length === 0) {
            container.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">No sub-categories added yet.</span>';
        }
        if (hiddenInput) {
            hiddenInput.value = window._tempSubCategories.join(',');
        }
    };

    window.addSubCategoryChip = function() {
        const input = document.getElementById('newSubCategoryInput');
        if (!input) return;
        const val = input.value.trim();
        if (val && !window._tempSubCategories.includes(val)) {
            window._tempSubCategories.push(val);
            input.value = '';
            window.renderSubCategoryChips();
        }
    };

    window.removeSubCategoryChip = function(index) {
        window._tempSubCategories.splice(index, 1);
        window.renderSubCategoryChips();
    };

    // --- Search / Filter Config Table ---
    window.filterConfigTable = function(type) {
        if (configPagination[type]) {
            configPagination[type].currentPage = 1;
        }
        renderConfigTable(type);
    };

    // --- Sync Limitations to All Branches ---
    window.syncLimitationsToBranches = async function() {
        if (!confirm('Kirim konfigurasi alarm limit terbaru dari Pusat ke SEMUA bandara cabang yang terdaftar?')) return;
        
        const btn = document.getElementById('syncLimitationsToBranchesBtn');
        const originalHtml = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyinkronkan...';
        }

        try {
            const res = await fetch('/api/config/limitations/sync-branches', {
                method: 'POST',
                headers: window.getAuthHeaders()
            });
            const result = await res.json();

            if (res.ok && result.success) {
                const results = result.results || [];
                const okList = results.filter(r => r.success).map(r => r.code || r.airport);
                const failList = results.filter(r => !r.success).map(r => `${r.code || r.airport} (${r.error})`);

                let msg = `Sinkronisasi selesai!\n- Berhasil: ${okList.length} cabang (${okList.join(', ') || 'tidak ada'})`;
                if (failList.length > 0) {
                    msg += `\n- Gagal / Offline: ${failList.length} cabang (${failList.join(', ')})`;
                }
                alert(msg);
                if (window.showToast) {
                    window.showToast(`Berhasil sinkronisasi limitasi ke ${okList.length} cabang`, 'success');
                }
            } else {
                alert(`Gagal sinkronisasi: ${result.message || 'Terjadi kesalahan sistem'}`);
            }
        } catch (err) {
            console.error('[Limitation Sync] Error:', err);
            alert(`Terjadi kesalahan jaringan: ${err.message}`);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        }
    };

})();
