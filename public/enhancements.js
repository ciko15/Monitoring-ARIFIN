/**
 * enhancements.js
 * Menambahkan fitur ke aplikasi Arifin tanpa mengubah file yang sudah ada:
 *  1. Klik card equipment → panel kanan menampilkan sources
 *  2. Klik source card → modal detail parameter
 */

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────────────────────
    let _selectedEqId = null;
    let _sourcesCache = {};
    let _sourceFetchMeta = {};
    let _activeSourceDetail = null;
    let _sourceDetailTimer = null;
    let _sourceDetailSignature = '';
    window.templatesCache = [];
    window.limitationsCache = [];
    const SOURCE_FETCH_TTL_MS = 15000;
    const SOURCE_DETAIL_REFRESH_MS = 5000;

    const PREVIEW_SCHEMAS = {
        'dvor_maru_220': ['mon1_azimuth', 'mon1_carrier_power', 'mon2_azimuth', 'mon2_carrier_power', 'tx_active', 'lcu_dc_28v'],
        'dme_maru_310_320': ['txp_active', 'txp1_m1_fwd_power', 'txp1_m1_reply_eff', 'txp2_m1_fwd_power', 'txp2_m1_reply_eff', 'ident'],
        'vhf_t6tv': ['overall_status', 'ac_power', 'dc_power', 'dc_supply_v', 'rf_power_w', 'vswr'],
        'snmp_host_resources_01': ['cpu_usage', 'ram_usage_pct', 'disk_usage_pct', 'sys_uptime'],
        'asterix_radar': ['connectivity', 'radar_name', 'last_cat034', 'data_source'],
        'asterix_adsb': ['connectivity', 'station', 'last_cat021', 'data_source'],
        'temp_humidity_modbus': ['temperature_c', 'humidity_pct', 'status_text', 'location'],
        'snmp_system': ['connectivity', 'sys_name', 'resolved_ip', 'hardware', 'operating_system', 'cpu_usage', 'physical_memory_usage_pct', 'disk_usage_pct', 'temperature_c'],
        'snmp_network_basic': ['connectivity', 'sys_name', 'resolved_ip', 'top_interface_name', 'top_interface_status', 'top_interface_in_octets', 'top_interface_out_octets', 'temperature_c'],
        'pm5560_modbus': ['VLN_avg', 'VLL_avg', 'HZ', 'PF', 'KW', 'KWH'],
        'diris_a20': ['VLN_avg', 'VLL_avg', 'HZ', 'PF', 'KW', 'KVAR'],
        'pm5350_modbus': ['V_RN', 'V_SN', 'V_TN', 'V_RS', 'V_ST', 'V_TR', 'I_R', 'I_S', 'I_T', 'FREQ', 'KW', 'KVA', 'PF'],
        'ils_gp_thales421': ['GP_ANGLE', 'RF_POWER', 'DDM_COURSE', 'CARRIER_PWR', 'RF_OUT', 'MON_POWER'],
        'ils_llz_thales421': ['CRS_RF', 'WIDTH_RF', 'NF_RF', 'CRS_SDM', 'IDENT_AM', 'FREQ_DEV']
    };

    function isMetricPlaceholder(value) {
        return value === null || value === undefined || value === '—' || value === '-';
    }

    function parseMetricNumber(value) {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : null;
        }

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed || trimmed === '—' || trimmed === '-') return null;
            const normalized = trimmed.replace(/,/g, '');
            const parsed = Number(normalized);
            return Number.isFinite(parsed) ? parsed : null;
        }

        return null;
    }

    function formatCompactNumber(value, decimals = 0) {
        const num = parseMetricNumber(value);
        if (num === null) return '—';

        return num.toLocaleString('id-ID', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });
    }

    function formatScaledUnit(value, units, decimals = 2, base = 1000) {
        const num = parseMetricNumber(value);
        if (num === null) return '—';
        if (num === 0) return `0 ${units[0]}`;

        const sign = num < 0 ? '-' : '';
        let scaled = Math.abs(num);
        let unitIndex = 0;

        while (scaled >= base && unitIndex < units.length - 1) {
            scaled /= base;
            unitIndex += 1;
        }

        const fractionDigits = unitIndex === 0 ? 0 : decimals;
        return `${sign}${scaled.toLocaleString('id-ID', {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
        })} ${units[unitIndex]}`;
    }

    function formatSnmpMetricValue(key, value) {
        if (isMetricPlaceholder(value)) return '—';

        if (typeof value === 'string' && /[a-z%]/i.test(value) && !/^\d+(\.\d+)?$/.test(value.trim())) {
            return value;
        }

        if (/_octets?$/.test(key) || /_bytes?$/.test(key)) {
            return formatScaledUnit(value, ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], 2, 1000);
        }

        if (/_mb$/.test(key)) {
            return formatScaledUnit(value, ['MB', 'GB', 'TB', 'PB'], 2, 1000);
        }

        if (/_gb$/.test(key)) {
            return formatScaledUnit(value, ['GB', 'TB', 'PB'], 2, 1000);
        }

        if (/_count$/.test(key) || key === 'interface_count' || key === 'processor_count') {
            return formatCompactNumber(value, 0);
        }

        if (/_c$/.test(key) && parseMetricNumber(value) !== null) {
            return `${formatCompactNumber(value, 1)} °C`;
        }

        return value;
    }

    function normalizeLimitLabel(label) {
        return String(label || '')
            .split('(')[0]
            .replace(/\[.*?\]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function calcAverage(values) {
        const nums = values
            .map(v => (v != null && !isNaN(parseFloat(v))) ? parseFloat(v) : null)
            .filter(v => v != null);
        if (nums.length === 0) return null;
        return +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1);
    }

    function resolvePreviewValue(srcData, parserId, key) {
        if (!srcData) return null;

        // Custom resolution untuk ioLogik dynamic pins dari sidebar preview
        if (parserId === 'iologik_modbus' && key.startsWith('iologik_pin_')) {
            // key format: iologik_pin_DeviceName_pinName
            const parts = key.replace('iologik_pin_', '').split('_');
            if (parts.length >= 2) {
                // Device name bisa saja mengandung underscore, jadi kita harus rekonstruksi
                // Tapi lebih aman kita iterasi saja:
                if (srcData.devices) {
                    for (const [dName, dData] of Object.entries(srcData.devices)) {
                        if (key.startsWith(`iologik_pin_${dName}_`)) {
                            const pName = key.replace(`iologik_pin_${dName}_`, '');
                            if (dData[pName] !== undefined) return dData[pName];
                        }
                    }
                }
            }
            return '-'; // Fallback jika belum ada data dari backend
        }

        if (srcData[key] !== undefined && srcData[key] !== null && srcData[key] !== '-') {
            return srcData[key];
        }

        if (parserId === 'pm5560_modbus' || parserId === 'diris_a20') {
            if (key === 'VLN_avg') {
                return calcAverage([srcData.VL1N, srcData.VL2N, srcData.VL3N]);
            }
            if (key === 'VLL_avg') {
                return calcAverage([srcData.VL12, srcData.VL23, srcData.VL31]);
            }
        }

        return srcData[key] ?? null;
    }

    async function loadTemplates() {
        try {
            const token = localStorage.getItem('authToken');
            const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
            const res = await fetch('/api/templates', { headers });
            const data = await res.json();
            window.templatesCache = Array.isArray(data) ? data : [];
        } catch (e) {
            console.warn('[Enhancements] Failed to load templates:', e);
        }
    }

    async function loadLimitations() {
        try {
            const token = localStorage.getItem('authToken');
            const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
            const res = await fetch('/api/config/limitations', { headers });
            const data = await res.json();
            window.limitationsCache = Array.isArray(data) ? data : [];
        } catch (e) {
            console.warn('[Enhancements] Failed to load limitations:', e);
        }
    }

    // Centralized color/threshold logic using payload metadata from Cabang
    function getLimitColor(supCategory, label, value, rowData = {}) {
        if (value === null || value === undefined || value === '—' || value === '-') return '#4a7a9a';
        
        // Cek Array Indikator Limit (Warna Teks UI) yang dikirim oleh Cabang
        if (rowData._triggered_alarms && rowData._triggered_alarms.includes(label)) {
            return '#ff3355'; // Merah (Alarm)
        } else if (rowData._triggered_warnings && rowData._triggered_warnings.includes(label)) {
            return '#ffcc00'; // Kuning (Warning)
        }
        
        return '#e8f4ff'; // Putih/Normal (Tidak ada pelanggaran)
    }   // equipmentId → [{...source}]

    // ── Wait until cabang-app renders ────────────────────────────────────────
    function waitForGrid(cb) {
        const grid = document.getElementById('cabangGrid');
        if (!grid) { setTimeout(() => waitForGrid(cb), 300); return; }
        // Wait until cards are rendered
        const check = () => {
            if (grid.querySelectorAll('.cabang-card').length > 0) cb(grid);
            else setTimeout(check, 300);
        };
        check();
    }

    // ── Patch cabang-app: add click + drag to every card after render ─────────
    // ── Event Delegation: single click listener on grid (survives re-renders) ──
    function setupGridClickDelegation() {
        const grid = document.getElementById('cabangGrid');
        if (!grid || grid.dataset.delegated === '1') return;
        grid.dataset.delegated = '1';
        grid.addEventListener('click', (e) => {
            const card = e.target.closest('.cabang-card');
            if (!card || !card.dataset.id) return;

            // Check for authentication
            if (!localStorage.getItem('authToken')) {
                if (window.showToast) {
                    window.showToast('Silakan login untuk melihat detail peralatan.', 'warning');
                } else {
                    alert('Silakan login untuk melihat detail peralatan.');
                }
                return;
            }

            openSourcePanel(card.dataset.id, card);
        });
    }

    function patchCards() {
        const grid = document.getElementById('cabangGrid');
        if (!grid) return;

        // Setup delegation
        setupGridClickDelegation();

        const cards = grid.querySelectorAll('.cabang-card');
        cards.forEach((card) => {
            const id = card.dataset.id;
            if (!id || card.dataset.enhanced === '1') return;
            card.dataset.enhanced = '1';
            card.style.cursor = 'pointer';
        });
    }


    // ── Observer: re-patch whenever grid re-renders ───────────────────────────
    function observeGrid() {
        const grid = document.getElementById('cabangGrid');
        if (!grid) return;
        // Setup delegation immediately — before any cards exist
        setupGridClickDelegation();
        const obs = new MutationObserver(() => {
            // Delegation already set, only need drag/drop re-patch
            setTimeout(patchCards, 100);
        });
        obs.observe(grid, { childList: true, subtree: false });
        patchCards();
    }

    function getCachedEquipmentById(equipmentId) {
        if (Array.isArray(window.equipmentDataCache)) {
            const found = window.equipmentDataCache.find(e => String(e.id) === String(equipmentId));
            if (found) return found;
        }

        const raw = localStorage.getItem('cabang_equipment_cache');
        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.find(e => String(e.id) === String(equipmentId)) || null : null;
        } catch (e) {
            console.warn('[Enhancements] Failed to parse equipment cache:', e);
            return null;
        }
    }

    function getCachedAuthSources(equipmentId) {
        const allSources = Array.isArray(window.authenticationsDataCache) ? window.authenticationsDataCache : [];
        return allSources.filter(src => String(src.equipt_id) === String(equipmentId));
    }

    function buildSourcesFromLastData(equipmentId) {
        const eq = getCachedEquipmentById(equipmentId);
        const lastData = eq && eq.lastData ? eq.lastData : null;
        if (!lastData) return [];

        return Object.entries(lastData).map(([sourceName, sourceData]) => ({
            id: `cached-${equipmentId}-${sourceName}`,
            equipt_id: equipmentId,
            name: sourceName,
            ip_address: sourceData?._ip || '—',
            parsing_id: sourceData?._parsing_id || ''
        }));
    }

    function getBestAvailableSources(equipmentId) {
        const cachedSources = _sourcesCache[equipmentId];
        if (Array.isArray(cachedSources) && cachedSources.length > 0) return cachedSources;

        const authSources = getCachedAuthSources(equipmentId);
        if (authSources.length > 0) return authSources;

        return buildSourcesFromLastData(equipmentId);
    }

    function shouldRefreshSources(equipmentId) {
        const lastFetchedAt = _sourceFetchMeta[equipmentId] || 0;
        return (Date.now() - lastFetchedAt) > SOURCE_FETCH_TTL_MS;
    }

    function mergeLastDataMaps(existingLastData, incomingLastData) {
        const existing = existingLastData && typeof existingLastData === 'object' ? existingLastData : {};
        const incoming = incomingLastData && typeof incomingLastData === 'object' ? incomingLastData : {};
        return Object.keys(incoming).length > 0 ? { ...existing, ...incoming } : existing;
    }

    function resolveSourceData(eq, src) {
        if (!eq || !eq.lastData || !src) return null;

        if (eq.lastData[src.name]) return eq.lastData[src.name];

        const normalizedName = String(src.name || '').trim().toLowerCase();
        const exactKey = Object.keys(eq.lastData).find(key => String(key).trim().toLowerCase() === normalizedName);
        if (exactKey) return eq.lastData[exactKey];

        const byIp = Object.values(eq.lastData).find(entry => entry && entry._ip && src.ip_address && String(entry._ip) === String(src.ip_address));
        if (byIp) return byIp;

        const entries = Object.values(eq.lastData);
        return entries.length === 1 ? entries[0] : null;
    }

    function updateEquipmentCacheEntry(eqData) {
        if (!eqData || !eqData.id) return;

        if (!Array.isArray(window.equipmentDataCache)) {
            window.equipmentDataCache = [];
        }

        const idx = window.equipmentDataCache.findIndex(e => String(e.id) === String(eqData.id));
        if (idx !== -1) {
            const existing = window.equipmentDataCache[idx];
            window.equipmentDataCache[idx] = {
                ...existing,
                ...eqData,
                lastData: mergeLastDataMaps(existing.lastData, eqData.lastData),
                lastUpdate: eqData.lastUpdate || existing.lastUpdate
            };
        } else {
            window.equipmentDataCache.push(eqData);
        }

        localStorage.setItem('cabang_equipment_cache', JSON.stringify(window.equipmentDataCache));
    }

    function getSourceDetailPayload(src) {
        let latestData = null;
        let eqSup = '';
        const effParserId = resolveEffectiveParserId(src);

        if (window.equipmentDataCache) {
            const eq = window.equipmentDataCache.find(e => String(e.id) === String(src.equipt_id));
            eqSup = eq ? eq.sup_category : '';

            if (eq && eq.lastData) {
                if (effParserId === 'vhf_marc_rse') {
                    const radioData = resolveSourceData(eq, src);
                    latestData = radioData ? { _isMarcMulti: true, radios: { [src.name]: radioData } } : null;
                } else {
                    latestData = resolveSourceData(eq, src);
                }
            }
        }

        return { latestData, eqSup };
    }

    function buildSourceDetailSignature(src, data, eqSup) {
        return JSON.stringify({
            sourceId: src?.id || '',
            parserId: src?.parsing_id || '',
            eqSup: eqSup || '',
            data: data || null
        });
    }

    function stopSourceDetailLiveUpdates() {
        if (_sourceDetailTimer) {
            clearInterval(_sourceDetailTimer);
            _sourceDetailTimer = null;
        }
        _activeSourceDetail = null;
        _sourceDetailSignature = '';
    }

    function closeDetailModal() {
        const modal = document.getElementById('dataSourceDetailModal');
        if (modal) modal.style.display = 'none';
        stopSourceDetailLiveUpdates();
    }

    async function refreshSourceDetailModal(src, forceRender = false) {
        if (!src) return;

        try {
            const res = await fetch(`/api/equipment/${src.equipt_id}`, {
                headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
            });

            if (res.ok) {
                const eqData = await res.json();
                updateEquipmentCacheEntry(eqData);
            }
        } catch (e) {
            console.warn('[Enhancements] Failed to refresh source detail:', e);
        }

        // Cegah popup terbuka kembali jika sudah ditutup saat fetch berlangsung
        if (!_activeSourceDetail || _activeSourceDetail.id !== src.id) return;

        const { latestData, eqSup } = getSourceDetailPayload(src);
        const nextSignature = buildSourceDetailSignature(src, latestData, eqSup);
        if (!forceRender && nextSignature === _sourceDetailSignature) return;

        const body = document.getElementById('srcDetailBody');
        const scrollTop = body ? body.scrollTop : 0;

        showDetailModal(src, latestData, eqSup);
        _sourceDetailSignature = nextSignature;

        if (body) body.scrollTop = scrollTop;
    }

    function startSourceDetailLiveUpdates(src) {
        stopSourceDetailLiveUpdates();
        _activeSourceDetail = src;
        refreshSourceDetailModal(src, true);

        _sourceDetailTimer = setInterval(() => {
            const modal = document.getElementById('dataSourceDetailModal');
            if (!modal || modal.style.display === 'none' || !_activeSourceDetail) {
                stopSourceDetailLiveUpdates();
                return;
            }
            refreshSourceDetailModal(_activeSourceDetail);
        }, SOURCE_DETAIL_REFRESH_MS);
    }

    // ── Source Panel ──────────────────────────────────────────────────────────
    window.openSourcePanel = async function openSourcePanel(equipmentId, cardEl) {
        _selectedEqId = equipmentId;
        window.selectedEquipmentId = equipmentId;

        // Highlight selected card
        document.querySelectorAll('.cabang-card').forEach(c => c.classList.remove('card-selected'));
        if (cardEl) cardEl.classList.add('card-selected');

        // Get equipment name
        const eqName = cardEl ? cardEl.querySelector('h3')?.textContent || 'Equipment' : 'Equipment';

        // Open panel
        const panel = document.getElementById('equipmentDetailPanel');
        const overlay = document.getElementById('detailPanelOverlay');
        const body = document.getElementById('detailPanelBody');
        if (!panel || !body) return;

        // Show cached data immediately if available
        const immediateSources = getBestAvailableSources(equipmentId);
        if (immediateSources.length > 0) {
            _sourcesCache[equipmentId] = immediateSources;
            renderSourcePanel(immediateSources, body, equipmentId);
        } else {
            body.innerHTML = `<div style="padding:20px;text-align:center;color:#4a7a9a">
                <i class="fas fa-spinner fa-spin"></i><p style="margin-top:8px">Loading sources...</p>
            </div>`;
        }

        panel.classList.add('open');
        if (overlay) overlay.classList.add('open');

        // Update panel header
        const header = panel.querySelector('.detail-panel-header h3');
        if (header) header.innerHTML = `<i class="fas fa-satellite-dish"></i> ${eqName}`;

        // Avoid forcing a network round-trip on every click if cached data is still fresh.
        if (!shouldRefreshSources(equipmentId)) {
            return;
        }

        // Fetch sources + lastData terbaru secara paralel
        try {
            const [srcJson, dataRes] = await Promise.all([
                fetch(`/api/otentication/${equipmentId}`).then(async r => { const t = await r.text(); return t ? JSON.parse(t) : []; }),
                fetch(`/api/equipment/${equipmentId}`, { headers: window.getAuthHeaders ? window.getAuthHeaders() : {} })
            ]);

            // Update equipmentDataCache dengan lastData terbaru
            if (dataRes.ok) {
                const eqText = await dataRes.text();
                if (eqText) {
                    try {
                        const eqData = JSON.parse(eqText);
                        updateEquipmentCacheEntry(eqData);
                    } catch (err) {
                        console.warn("Failed to parse equipment data JSON:", err);
                    }
                }
            }

            const finalSources = Array.isArray(srcJson) ? srcJson : [];
            _sourceFetchMeta[equipmentId] = Date.now();
            if (finalSources.length > 0) {
                _sourcesCache[equipmentId] = finalSources;
                const mergedAuthCache = Array.isArray(window.authenticationsDataCache) ? [...window.authenticationsDataCache] : [];
                const preserved = mergedAuthCache.filter(src => String(src.equipt_id) !== String(equipmentId));
                window.authenticationsDataCache = preserved.concat(finalSources);
                localStorage.setItem('authentications_cache', JSON.stringify(window.authenticationsDataCache));
                renderSourcePanel(finalSources, body, equipmentId);
            } else if (immediateSources.length === 0) {
                _sourcesCache[equipmentId] = finalSources;
                renderSourcePanel(finalSources, body, equipmentId);
            } else {
                _sourcesCache[equipmentId] = immediateSources;
                renderSourcePanel(immediateSources, body, equipmentId);
            }
        } catch (e) {
            _sourceFetchMeta[equipmentId] = 0;
            if (immediateSources.length === 0) {
                body.innerHTML = `<div style="padding:20px;color:#ff3355">Gagal memuat sources: ${e.message}</div>`;
            }
        }
    }

    function resolveEffectiveParserId(src) {
        if (!src || !src.parsing_id) return '';
        let id = src.parsing_id;
        if (id.startsWith('custom_')) {
            const tmpl = window.templatesCache?.find(t => t.id === id);
            if (tmpl && tmpl.files) {
                if (tmpl.files.includes('iologik_modbus')) return 'iologik_modbus';
                if (tmpl.files.includes('pm5560_modbus')) return 'pm5560_modbus';
            }
        }
        return id;
    }

    function renderSourcePanel(sources, body, equipmentId) {
        if (sources.length === 0) {
            body.innerHTML = `
                <div style="padding:20px;text-align:center;color:#4a7a9a">
                    <i class="fas fa-plug" style="font-size:24px;margin-bottom:8px"></i>
                    <p>Belum ada data source</p>
                </div>
                <div style="padding:0 14px 14px">
                </div>`;
            return;
        }

        const cards = sources.map(src => {
            const srcStatus = getSourceStatus(src);
            const ip = src.ip_address || '—';
            const port = src.tcp_port || src.udp_port || '—';
            const tmpl = window.templatesCache?.find(t => t.id === src.parsing_id);
            const parserName = tmpl ? tmpl.name : (src.parsing_id || '—');

            // Get live data preview for this source based on schema or template
            let previewHtml = '';
            let lastTime = '—';
            let srcData = null;

            if (window.equipmentDataCache) {
                const eq = window.equipmentDataCache.find(e => String(e.id) === String(src.equipt_id));
                srcData = resolveSourceData(eq, src);

                if (srcData && srcData._logged_at) {
                    lastTime = new Date(srcData._logged_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                }

                // Determine what keys to show
                let keysToShow = PREVIEW_SCHEMAS[src.parsing_id] || [];

                // If no hardcoded schema, try template parameters
                if (keysToShow.length === 0 && tmpl && tmpl.parameters) {
                    keysToShow = tmpl.parameters.slice(0, 6).map(p => p.name || p.label);
                }

                const effParserId = resolveEffectiveParserId(src);

                // KHUSUS: iologik_modbus (dinamis dari extra_config)
                if (effParserId === 'iologik_modbus') {
                    keysToShow = []; // reset
                    try {
                        if (src.extra_config) {
                            const cfg = JSON.parse(src.extra_config);
                            if (cfg && cfg.devices) {
                                // Ambil 6 pin pertama dari seluruh device untuk preview
                                for (const [dName, mapping] of Object.entries(cfg.devices)) {
                                    for (const pinName of Object.keys(mapping)) {
                                        if (keysToShow.length < 6) {
                                            keysToShow.push(`iologik_pin_${dName}_${pinName}`);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                }

                // Fallback to first 6 keys if still empty and we have data
                if (keysToShow.length === 0 && effParserId !== 'iologik_modbus' && srcData) {
                    keysToShow = Object.keys(srcData)
                        .filter(k => !k.startsWith('_') && k !== 'error' && k !== 'cached' && k !== 'status' && k !== 'success' && k !== 'timestamp')
                        .slice(0, 6);
                }

                if (keysToShow.length > 0) {
                    previewHtml = `<div class="sp-card-preview-grid">
                        ${keysToShow.map(k => {
                        const resolvedVal = resolvePreviewValue(srcData, effParserId, k);
                        const valObj = resolvedVal;
                        const isObj = valObj !== null && typeof valObj === 'object';

                        // Try to get label from template if available
                        let label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

                        if (k.startsWith('iologik_pin_')) {
                            const pName = k.split('_').slice(3).join(' ');
                            const dName = k.split('_')[2];
                            label = `${dName}: ${pName.replace(/\b\w/g, l => l.toUpperCase())}`;
                        }

                        if (tmpl && tmpl.parameters) {
                            const param = tmpl.parameters.find(p => p.name === k || p.label === k);
                            if (param) label = param.label || param.name;
                        }
                        if (isObj && valObj.label) label = valObj.label;

                        let rawVal = '—';
                        let unit = '';
                        if (isObj) {
                            if (valObj.value !== undefined) {
                                rawVal = valObj.value;
                                unit = valObj.unit || '';
                            } else {
                                // Nested group case: find first numeric or string primitive
                                const firstKey = Object.keys(valObj).find(gk => !gk.startsWith('_') && typeof valObj[gk] !== 'object');
                                if (firstKey) {
                                    rawVal = valObj[firstKey];
                                    unit = valObj[`${firstKey}_unit`] || '';
                                }
                            }
                        } else {
                            rawVal = valObj ?? '—';
                        }
                        
                        const val = src.parsing_id.startsWith('snmp_')
                            ? formatSnmpMetricValue(k, rawVal)
                            : rawVal;
                        const eqSup = eq ? eq.sup_category : '';
                        const valColor = getLimitColor(eqSup, label, rawVal, srcData || {});

                        return `<div class="sp-card-preview-point">
                                <span class="sp-preview-label" title="${label}">${label}</span>
                                <span class="sp-preview-value" style="color:${valColor}">${val}${unit}</span>
                            </div>`;
                    }).join('')}
                    </div>`;
                }
            }

            if (!previewHtml) {
                previewHtml = `<div class="sp-card-no-data">
                    <i class="fas fa-satellite-dish"></i>
                    <span>Menunggu data...</span>
                </div>`;
            }

            // Tampilkan status Ping dinamis hasil check latar belakang
            let pingLabel = '';
            if (srcStatus.toLowerCase() === 'disconnect' || srcStatus.toLowerCase() === 'error') {
                const pingStatus = srcData ? srcData.ping_status : null;
                if (pingStatus === 'Normal') {
                    pingLabel = ` <span class="sp-conn-badge" style="background: rgba(0,255,136,0.1); color: #00ff88; border-color: #00ff88; margin-left: auto;"><i class="fas fa-network-wired"></i> Koneksi Ditolak (Ping Normal)</span>`;
                } else if (pingStatus === 'Gagal') {
                    pingLabel = ` <span class="sp-conn-badge" style="background: rgba(255,51,85,0.1); color: #ff3355; border-color: #ff3355; margin-left: auto;"><i class="fas fa-network-wired"></i> Alat Mati / Ping Gagal</span>`;
                }
            }

            return `
                <div class="sp-source-card ${srcStatus.toLowerCase()}" onclick="window.openSourceDetail('${src.id}')">
                    <div class="sp-card-main">
                        <div class="sp-card-header">
                            <div class="sp-card-title">
                                <span class="sp-status-dot ${srcStatus.toLowerCase()}"></span>
                                <span class="sp-source-name">${src.name}</span>
                            </div>
                            <span class="sp-status-pill ${srcStatus.toLowerCase()}">${srcStatus}</span>
                        </div>
                        
                        <div class="sp-card-body">
                            ${previewHtml}
                        </div>

                        <div class="sp-card-meta" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; width: 100%;">
                            <span class="sp-conn-badge"><i class="fas fa-database"></i> ${ip}:${port}</span>
                            <span class="sp-conn-badge sp-parser-badge" title="${parserName}"><i class="fas fa-code"></i> ${parserName}</span>
                            ${pingLabel}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        body.innerHTML = `
            <div class="sp-panel-content">
                <div class="sp-panel-toolbar">
                    <span class="sp-panel-count"><i class="fas fa-database"></i> DATA SOURCES (${sources.length})</span>
                </div>
                <div class="sp-sources-grid">
                    ${cards}
                </div>
            </div>
        `;

        // Update equipment card color berdasarkan status terburuk dari semua source
        const statuses = sources.map(s => getSourceStatus(s).toLowerCase());
        const eqCard = document.querySelector(`.cabang-card[data-id="${equipmentId}"]`);
        if (eqCard) {
            eqCard.classList.remove('has-alarm', 'has-warning');
            if (statuses.length > 0 && statuses.every(st => st === 'alarm')) {
                eqCard.classList.add('has-alarm');
            } else if (statuses.length > 0 && statuses.every(st => st === 'offline' || st === 'disconnect')) {
                // Biarkan abu-abu
            } else if (statuses.includes('alarm') || statuses.includes('warning') || statuses.includes('disconnect') || statuses.includes('offline')) {
                eqCard.classList.add('has-warning');
            }
        }
    }

    function getSourceStatus(src) {
        let rawStatus = 'Disconnect';
        if (window.equipmentDataCache) {
            const eq = window.equipmentDataCache.find(e => String(e.id) === String(src.equipt_id));
            if (eq && eq.lastData) {
                const srcData = resolveSourceData(eq, src);
                if (srcData) {
                    rawStatus = srcData._status || 'Normal';
                } else {
                    // Fallback: try first available
                    const first = Object.values(eq.lastData)[0];
                    if (first) rawStatus = first._status || 'Normal';
                }
            }
        }
        return window.normalizeSourceStatus ? window.normalizeSourceStatus(rawStatus) : rawStatus;
    }

    // ── Source Detail Modal ───────────────────────────────────────────────────
    window.openSourceDetail = async function (sourceId) {
        if (!localStorage.getItem('authToken')) {
            window.showToast('Silakan login untuk melihat detail parameter.', 'warning');
            return;
        }

        // Close the sliding panel when opening detail modal
        const panel = document.getElementById('equipmentDetailPanel');
        const overlay = document.getElementById('detailPanelOverlay');
        if (panel) panel.classList.remove('open');
        if (overlay) overlay.classList.remove('open');

        // Find source from cache
        let src = null;
        const sourcePools = [
            ...Object.values(_sourcesCache),
            _selectedEqId ? getBestAvailableSources(_selectedEqId) : []
        ];
        for (const sources of sourcePools) {
            if (!Array.isArray(sources)) continue;
            src = sources.find(s => String(s.id) === String(sourceId));
            if (src) break;
        }
        if (!src) return;

        // Build modal
        const modal = document.getElementById('dataSourceDetailModal');
        if (!modal) { createDetailModal(); }

        window._activeSourceDetail = src; // Set ini DULU sebelum memanggil showDetailModal agar fallback UI bisa baca extra_config

        const { latestData, eqSup } = getSourceDetailPayload(src);
        showDetailModal(src, latestData, eqSup);
        _sourceDetailSignature = buildSourceDetailSignature(src, latestData, eqSup);
        startSourceDetailLiveUpdates(src);
    };

    function createDetailModal() {
        const div = document.createElement('div');
        div.id = 'dataSourceDetailModal';
        div.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:5000;align-items:center;justify-content:center;';
        div.innerHTML = `
            <div style="background:#0a1628;border:1px solid #1a3a5c;border-radius:10px;width:90vw;max-width:800px;max-height:85vh;display:flex;flex-direction:column;">
                <div style="display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid #1a3a5c;gap:12px">
                    <span id="srcDetailTitle" style="font-size:14px;font-weight:bold;color:#00d4ff;flex:1"></span>
                    <span id="srcDetailStatus"></span>
                    <button id="srcDetailCloseBtn"
                        style="background:none;border:none;color:#4a7a9a;font-size:18px;cursor:pointer">✕</button>
                </div>
                <div id="srcDetailBody" style="flex:1;overflow-y:auto;padding:16px"></div>
            </div>`;
        div.addEventListener('click', e => { if (e.target === div) closeDetailModal(); });
        document.body.appendChild(div);
        const closeBtn = document.getElementById('srcDetailCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeDetailModal);
    }

    function showDetailModal(src, data, eqSup) {
        let modal = document.getElementById('dataSourceDetailModal');
        if (!modal) { createDetailModal(); modal = document.getElementById('dataSourceDetailModal'); }

        document.getElementById('srcDetailTitle').textContent = src.name + ' — ' + (src.ip_address || '');

        const status = data ? (data._status || 'Normal') : 'Disconnect';
        const statusColors = { Normal: '#00ff88', Alarm: '#ff3355', Warning: '#ffcc00', Disconnect: '#3a5a7a' };
        
        let pingBadge = '';
        if (data && data.ping_status) {
            let pc = '#4a7a9a';
            if (data.ping_status === 'Normal') pc = '#00ff88';
            else if (data.ping_status === 'Gagal') pc = '#ff3355';
            
            const icon = data.ping_status === 'Normal' ? '<i class="fas fa-network-wired"></i>' : '<i class="fas fa-plug-circle-xmark"></i>';
            pingBadge = `<span style="font-size:11px;font-weight:bold;padding:3px 10px;border-radius:3px;background:${pc}22;color:${pc};border:1px solid ${pc};margin-right:8px;" title="Status Ping dari Server ke IP Perangkat">${icon} Ping: ${data.ping_status}</span>`;
        }

        document.getElementById('srcDetailStatus').innerHTML =
            pingBadge + `<span style="font-size:11px;font-weight:bold;padding:3px 10px;border-radius:3px;background:${statusColors[status]}22;color:${statusColors[status]};border:1px solid ${statusColors[status]}">${status === 'Alarm' ? 'Offline' : status}</span>`;

        const body = document.getElementById('srcDetailBody');

        if (!data || Object.keys(data).filter(k => !k.startsWith('_')).length === 0) {
            body.innerHTML = `<div style="text-align:center;padding:40px;color:#4a7a9a">
                <i class="fas fa-satellite-dish fa-2x" style="margin-bottom:12px"></i>
                <p>Belum ada data diterima</p>
            </div>`;
        } else if (data._isMarcMulti) {
            // MARC RSE: render radio detail (1 radio per source)
            body.innerHTML = renderMarcMultiRadioDetail(data.radios, eqSup, data._logged_at);
        } else if (data._parsing_id === 'vhf_marc_rse' || data._parsing_id === 'marc_pae') {
            // MARC RSE single radio (direct lastData entry)
            const radioName = src ? src.name : 'Radio';
            body.innerHTML = renderMarcMultiRadioDetail({ [radioName]: data }, eqSup, data._logged_at);
        } else {
            body.innerHTML = renderDetailData(src.parsing_id, data, eqSup);
        }

        modal.style.display = 'flex';
    }


    function renderMarcMultiRadioDetail(radios, supCategory, rootLoggedAt) {
        if (!radios || Object.keys(radios).length === 0) {
            return `<div style="text-align:center;padding:40px;color:#4a7a9a">
                <i class="fas fa-satellite-dish fa-2x"></i>
                <p>Belum ada data diterima</p>
            </div>`;
        }

        const MARC_PARAMS = [
            ['Frequency (MHz)', 'frequency_mhz'],
            ['Mode', 'mode'],
            ['Status', 'status'],
            ['Fwd Power (W)', 'fwd_power_w'],
            ['Refl Power (W)', 'refl_power_w'],
            ['VSWR', 'vswr'],
            ['PA Temp (°C)', 'pa_temp_c'],
            ['Modulation (%)', 'modulation_pct'],
            ['Sensitivity (dBm)', 'sensitivity_dbm'],
            ['Squelch (dBm)', 'squelch_dbm'],
            ['TX Supply (V)', 'supply_voltage'],
            ['RX Supply (V)', 'rx_supply_voltage'],
        ];

        return Object.entries(radios).map(([radioName, rd]) => {
            const isRx = rd.is_rx;
            const radioType = rd.radio_type || (isRx ? 'RX' : 'TX');
            const params = MARC_PARAMS;
            let status = rd._status;
            if (!status) {
                status = rd.status === 'ALARM' ? 'Alarm' : (rd.connected ? 'Normal' : 'Disconnect');
            }
            const statusColors = { Normal: '#00ff88', Alarm: '#ff3355', Warning: '#ffcc00', Disconnect: '#3a5a7a' };
            const sc = statusColors[status] || '#3a5a7a';
            const loggedAtVal = rd._logged_at || rootLoggedAt;
            const loggedAt = loggedAtVal
                ? new Date(loggedAtVal).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '—';

            return `
            <div style="margin-bottom:14px;border:1px solid #1a3a5c;border-radius:8px;overflow:hidden;">
                <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1e35;border-bottom:1px solid #1a3a5c;">
                    <i class="fas fa-broadcast-tower" style="color:${isRx ? '#00d4ff' : '#e8a000'};font-size:12px;"></i>
                    <span style="font-size:12px;font-weight:bold;color:${isRx ? '#00d4ff' : '#e8a000'};flex:1;">${radioName}</span>
                    <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${isRx ? '#001a33' : '#1a1000'};color:${isRx ? '#00d4ff' : '#e8a000'};border:1px solid ${isRx ? '#00d4ff' : '#e8a000'};font-weight:bold;">${radioType}</span>
                    <span style="font-size:10px;font-weight:bold;padding:2px 8px;border-radius:4px;background:${sc}22;color:${sc};border:1px solid ${sc};">${status === 'Alarm' ? 'Offline' : status}</span>
                    <span style="font-size:9px;color:#3a6a8a;">${loggedAt}</span>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;padding:10px 12px;background:#080f1e;">
                    ${params.map(([label, key]) => {
                const val = rd[key];
                const display = (val === null || val === undefined || val === '-' || val === '—') ? '—' : val;
                const isStale = status === 'Disconnect';
                const valColor = isStale ? '#3a5a7a' : getLimitColor(supCategory || 'VHF A/G', label, val);
                return `<div style="background:#0f1e35;border:1px solid #0d2a45;border-radius:5px;padding:8px 10px;">
                            <div style="font-size:9px;color:#4a7a9a;letter-spacing:1px;margin-bottom:3px;">${label}</div>
                            <div style="font-size:13px;font-weight:bold;color:${valColor};">${display}</div>
                        </div>`;
            }).join('')}
                </div>
            </div>`;
        }).join('');
    }

    function renderDetailData(parserId, data, supCategory) {
        // Group by section based on parser
        const sections = getDetailSections(parserId, data, supCategory);
        return sections.map(sec => `
            <div style="margin-bottom:16px">
                <div style="font-size:10px;color:#007a9e;letter-spacing:2px;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #0d2a45">${sec.title}</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px">
                    ${sec.params.map(([label, val, cls]) => `
                        <div style="background:#0f1e35;border:1px solid #0d2a45;border-radius:5px;padding:8px 10px">
                            <div style="font-size:9px;color:#4a7a9a;letter-spacing:1px;margin-bottom:3px">${label}</div>
                            <div style="font-size:13px;font-weight:bold;color:${cls || '#e8f4ff'}">${val !== null && val !== undefined ? val : '—'}</div>
                        </div>`).join('')}
                </div>
            </div>`).join('');
    }

    function getDetailSections(parserId, data, supCategory) {
        const sections = [];

        // Global Error Handling: if data has error (e.g. disconnected)
        if (data && data.error) {
            sections.push({
                title: 'Connection Error',
                params: [
                    ['Status', 'Disconnect', getLimitColor(data.sup_category || 'Generic', 'Status', 'Disconnect', data)],
                    ['Detail', data.error, getLimitColor(data.sup_category || 'Generic', 'Detail', data.error, data)]
                ]
            });
            // Tidak me-return agar layout fallback (dengan '-') tetap di-render di bawahnya
        }

        // Helper: value color berdasarkan range min-max
        const vc = (v, min, max) => {
            const n = parseFloat(v);
            if (isNaN(n)) return '#4a7a9a';
            return (n >= min && n <= max) ? '#00ff88' : (n >= min * 0.9 && n <= max * 1.1) ? '#ffcc00' : '#ff3355';
        };

        // Helper function to unflatten DVOR data
        function unflattenDvorData(flatData) {
            const result = {};
            const prefixes = ['mon1_', 'mon2_', 'tx1_', 'tx2_', 'lcu_'];

            prefixes.forEach(prefix => {
                const sectionKey = prefix.replace('_', '');
                result[sectionKey] = {};

                Object.keys(flatData).forEach(key => {
                    if (key.startsWith(prefix)) {
                        const fieldName = key.replace(prefix, '');
                        result[sectionKey][fieldName] = flatData[key];
                    }
                });
            });

            // Handle tx_active separately
            if (flatData.tx_active !== undefined) {
                result.tx_active = flatData.tx_active;
            }

            return result;
        }

        if (parserId === 'dvor_maru_220') {
            // Unflatten the data first
            const unflattenedData = unflattenDvorData(data);
            const sup = 'DVOR';

            // Monitor 1
            sections.push({
                title: 'MONITOR 1', params: [
                    ['Carrier Power (W)', unflattenedData.mon1?.carrier_power, getLimitColor(sup, 'Carrier Power', unflattenedData.mon1?.carrier_power)],
                    ['RF Input (dBm)', unflattenedData.mon1?.rf_input, getLimitColor(sup, 'RF Input', unflattenedData.mon1?.rf_input)],
                    ['Azimuth (°)', unflattenedData.mon1?.azimuth, getLimitColor(sup, 'Azimuth', unflattenedData.mon1?.azimuth)],
                    ['FM Index', unflattenedData.mon1?.fm_index, getLimitColor(sup, 'FM Index', unflattenedData.mon1?.fm_index)],
                    ['30Hz AM (%)', unflattenedData.mon1?.am_30hz, getLimitColor(sup, 'AM 30Hz', unflattenedData.mon1?.am_30hz)],
                    ['9960Hz AM (%)', unflattenedData.mon1?.am_9960hz, getLimitColor(sup, 'AM 9960Hz', unflattenedData.mon1?.am_9960hz)],
                    ['1020Hz AM (%)', unflattenedData.mon1?.am_1020hz, getLimitColor(sup, 'AM 1020Hz', unflattenedData.mon1?.am_1020hz)],
                    ['Carrier Freq (MHz)', unflattenedData.mon1?.carrier_freq, getLimitColor(data.sup_category || 'Generic', 'Carrier Freq (MHz)', unflattenedData.mon1?.carrier_freq, data)],
                    ['USB Freq (MHz)', unflattenedData.mon1?.usb_freq, getLimitColor(data.sup_category || 'Generic', 'USB Freq (MHz)', unflattenedData.mon1?.usb_freq, data)],
                    ['LSB Freq (MHz)', unflattenedData.mon1?.lsb_freq, getLimitColor(data.sup_category || 'Generic', 'LSB Freq (MHz)', unflattenedData.mon1?.lsb_freq, data)],
                    ['Ident', unflattenedData.mon1?.ident, getLimitColor(data.sup_category || 'Generic', 'Ident', unflattenedData.mon1?.ident, data)],
                    ['TSG 30Hz', unflattenedData.mon1?.tsg_30hz, getLimitColor(data.sup_category || 'Generic', 'TSG 30Hz', unflattenedData.mon1?.tsg_30hz, data)],
                    ['TSG Azimuth', unflattenedData.mon1?.tsg_azimuth, getLimitColor(data.sup_category || 'Generic', 'TSG Azimuth', unflattenedData.mon1?.tsg_azimuth, data)],
                ]
            });

            // Monitor 2
            sections.push({
                title: 'MONITOR 2', params: [
                    ['Carrier Power (W)', unflattenedData.mon2?.carrier_power, getLimitColor(supCategory || 'DVOR', 'Carrier Power', unflattenedData.mon2?.carrier_power)],
                    ['RF Input (dBm)', unflattenedData.mon2?.rf_input, getLimitColor(supCategory || 'DVOR', 'RF Input', unflattenedData.mon2?.rf_input)],
                    ['Azimuth (°)', unflattenedData.mon2?.azimuth, getLimitColor(supCategory || 'DVOR', 'Azimuth', unflattenedData.mon2?.azimuth)],
                    ['FM Index', unflattenedData.mon2?.fm_index, getLimitColor(supCategory || 'DVOR', 'FM Index', unflattenedData.mon2?.fm_index)],
                    ['30Hz AM (%)', unflattenedData.mon2?.am_30hz, getLimitColor(supCategory || 'DVOR', 'AM 30Hz', unflattenedData.mon2?.am_30hz)],
                    ['9960Hz AM (%)', unflattenedData.mon2?.am_9960hz, getLimitColor(supCategory || 'DVOR', 'AM 9960Hz', unflattenedData.mon2?.am_9960hz)],
                    ['1020Hz AM (%)', unflattenedData.mon2?.am_1020hz, getLimitColor(supCategory || 'DVOR', 'AM 1020Hz', unflattenedData.mon2?.am_1020hz)],
                    ['Carrier Freq (MHz)', unflattenedData.mon2?.carrier_freq, getLimitColor(data.sup_category || 'Generic', 'Carrier Freq (MHz)', unflattenedData.mon2?.carrier_freq, data)],
                    ['USB Freq (MHz)', unflattenedData.mon2?.usb_freq, getLimitColor(data.sup_category || 'Generic', 'USB Freq (MHz)', unflattenedData.mon2?.usb_freq, data)],
                    ['LSB Freq (MHz)', unflattenedData.mon2?.lsb_freq, getLimitColor(data.sup_category || 'Generic', 'LSB Freq (MHz)', unflattenedData.mon2?.lsb_freq, data)],
                    ['Ident', unflattenedData.mon2?.ident, getLimitColor(data.sup_category || 'Generic', 'Ident', unflattenedData.mon2?.ident, data)],
                ]
            });
            // Transmitter
            sections.push({
                title: 'TRANSMITTER', params: [
                    ['TX Active', unflattenedData.tx_active ? 'TX' + unflattenedData.tx_active : '—', getLimitColor(data.sup_category || 'Generic', 'TX Active', unflattenedData.tx_active ? 'TX' + unflattenedData.tx_active : '—', data)],
                    ['TX1 Carrier (W)', unflattenedData.tx1?.carrier_power, getLimitColor(data.sup_category || 'Generic', 'TX1 Carrier (W)', unflattenedData.tx1?.carrier_power, data)],
                    ['TX1 USB Sin', unflattenedData.tx1?.usb_sin, getLimitColor(data.sup_category || 'Generic', 'TX1 USB Sin', unflattenedData.tx1?.usb_sin, data)],
                    ['TX1 USB Cos', unflattenedData.tx1?.usb_cos, getLimitColor(data.sup_category || 'Generic', 'TX1 USB Cos', unflattenedData.tx1?.usb_cos, data)],
                    ['TX1 LSB Sin', unflattenedData.tx1?.lsb_sin, getLimitColor(data.sup_category || 'Generic', 'TX1 LSB Sin', unflattenedData.tx1?.lsb_sin, data)],
                    ['TX1 LSB Cos', unflattenedData.tx1?.lsb_cos, getLimitColor(data.sup_category || 'Generic', 'TX1 LSB Cos', unflattenedData.tx1?.lsb_cos, data)],
                    ['TX1 Az Offset', unflattenedData.tx1?.az_offset, getLimitColor(data.sup_category || 'Generic', 'TX1 Az Offset', unflattenedData.tx1?.az_offset, data)],
                    ['TX1 AM 30Hz', unflattenedData.tx1?.am_30hz, getLimitColor(data.sup_category || 'Generic', 'TX1 AM 30Hz', unflattenedData.tx1?.am_30hz, data)],
                    ['TX1 AM 1020Hz', unflattenedData.tx1?.am_1020hz, getLimitColor(data.sup_category || 'Generic', 'TX1 AM 1020Hz', unflattenedData.tx1?.am_1020hz, data)],
                    ['TX1 Phase Offset', unflattenedData.tx1?.phase_offset, getLimitColor(data.sup_category || 'Generic', 'TX1 Phase Offset', unflattenedData.tx1?.phase_offset, data)],
                    ['TX1 CPA Temp (°C)', unflattenedData.tx1?.cpa_temp, getLimitColor(data.sup_category || 'Generic', 'TX1 CPA Temp (°C)', unflattenedData.tx1?.cpa_temp, data)],
                    ['TX1 MSG Temp (°C)', unflattenedData.tx1?.msg_temp, getLimitColor(data.sup_category || 'Generic', 'TX1 MSG Temp (°C)', unflattenedData.tx1?.msg_temp, data)],
                    ['TX1 Ident', unflattenedData.tx1?.ident, getLimitColor(data.sup_category || 'Generic', 'TX1 Ident', unflattenedData.tx1?.ident, data)],
                    ['TX2 Carrier (W)', unflattenedData.tx2?.carrier_power, getLimitColor(data.sup_category || 'Generic', 'TX2 Carrier (W)', unflattenedData.tx2?.carrier_power, data)],
                    ['TX2 USB Sin', unflattenedData.tx2?.usb_sin, getLimitColor(data.sup_category || 'Generic', 'TX2 USB Sin', unflattenedData.tx2?.usb_sin, data)],
                    ['TX2 USB Cos', unflattenedData.tx2?.usb_cos, getLimitColor(data.sup_category || 'Generic', 'TX2 USB Cos', unflattenedData.tx2?.usb_cos, data)],
                    ['TX2 LSB Sin', unflattenedData.tx2?.lsb_sin, getLimitColor(data.sup_category || 'Generic', 'TX2 LSB Sin', unflattenedData.tx2?.lsb_sin, data)],
                    ['TX2 LSB Cos', unflattenedData.tx2?.lsb_cos, getLimitColor(data.sup_category || 'Generic', 'TX2 LSB Cos', unflattenedData.tx2?.lsb_cos, data)],
                    ['TX2 Az Offset', unflattenedData.tx2?.az_offset, getLimitColor(data.sup_category || 'Generic', 'TX2 Az Offset', unflattenedData.tx2?.az_offset, data)],
                    ['TX2 AM 30Hz', unflattenedData.tx2?.am_30hz, getLimitColor(data.sup_category || 'Generic', 'TX2 AM 30Hz', unflattenedData.tx2?.am_30hz, data)],
                    ['TX2 AM 1020Hz', unflattenedData.tx2?.am_1020hz, getLimitColor(data.sup_category || 'Generic', 'TX2 AM 1020Hz', unflattenedData.tx2?.am_1020hz, data)],
                    ['TX2 Phase Offset', unflattenedData.tx2?.phase_offset, getLimitColor(data.sup_category || 'Generic', 'TX2 Phase Offset', unflattenedData.tx2?.phase_offset, data)],
                    ['TX2 CPA Temp (°C)', unflattenedData.tx2?.cpa_temp, getLimitColor(data.sup_category || 'Generic', 'TX2 CPA Temp (°C)', unflattenedData.tx2?.cpa_temp, data)],
                    ['TX2 MSG Temp (°C)', unflattenedData.tx2?.msg_temp, getLimitColor(data.sup_category || 'Generic', 'TX2 MSG Temp (°C)', unflattenedData.tx2?.msg_temp, data)],
                    ['TX2 Ident', unflattenedData.tx2?.ident, getLimitColor(data.sup_category || 'Generic', 'TX2 Ident', unflattenedData.tx2?.ident, data)],
                ]
            });

            // LCU
            sections.push({
                title: 'LCU — POWER SUPPLY', params: [
                    ['DC +5V', unflattenedData.lcu?.dc_5v, getLimitColor(data.sup_category || 'Generic', 'DC +5V', unflattenedData.lcu?.dc_5v, data)],
                    ['DC +7V', unflattenedData.lcu?.dc_7v, getLimitColor(data.sup_category || 'Generic', 'DC +7V', unflattenedData.lcu?.dc_7v, data)],
                    ['DC +15V', unflattenedData.lcu?.dc_15v, getLimitColor(data.sup_category || 'Generic', 'DC +15V', unflattenedData.lcu?.dc_15v, data)],
                    ['DC +28V', unflattenedData.lcu?.dc_28v, getLimitColor(data.sup_category || 'Generic', 'DC +28V', unflattenedData.lcu?.dc_28v, data)],
                    // ['AC +28V', unflattenedData.lcu?.ac_28v, getLimitColor(data.sup_category || 'Generic', 'AC +28V', unflattenedData.lcu?.ac_28v, data)],
                    ['MSG1 Comm', unflattenedData.lcu?.msg1_comm, getLimitColor(data.sup_category || 'Generic', 'MSG1 Comm', unflattenedData.lcu?.msg1_comm, data)],
                    ['MSG2 Comm', unflattenedData.lcu?.msg2_comm, getLimitColor(data.sup_category || 'Generic', 'MSG2 Comm', unflattenedData.lcu?.msg2_comm, data)],
                    ['MON1 Comm', unflattenedData.lcu?.mon1_comm, getLimitColor(data.sup_category || 'Generic', 'MON1 Comm', unflattenedData.lcu?.mon1_comm, data)],
                    ['MON2 Comm', unflattenedData.lcu?.mon2_comm, getLimitColor(data.sup_category || 'Generic', 'MON2 Comm', unflattenedData.lcu?.mon2_comm, data)],
                    ['Battery 1', unflattenedData.lcu?.battery1, getLimitColor(data.sup_category || 'Generic', 'Battery 1', unflattenedData.lcu?.battery1, data)],
                    ['Battery 2', unflattenedData.lcu?.battery2, getLimitColor(data.sup_category || 'Generic', 'Battery 2', unflattenedData.lcu?.battery2, data)],
                    ['ACDC 1', unflattenedData.lcu?.acdc1, getLimitColor(data.sup_category || 'Generic', 'ACDC 1', unflattenedData.lcu?.acdc1, data)],
                    ['ACDC 2', unflattenedData.lcu?.acdc2, getLimitColor(data.sup_category || 'Generic', 'ACDC 2', unflattenedData.lcu?.acdc2, data)],
                ]
            });
        }

        if (parserId === 'iologik_modbus') {

            const renderDevice = (title, deviceData) => {
                if (!deviceData) return [];
                const params = [];

                let cfg = null;
                if (window._activeSourceDetail && window._activeSourceDetail.extra_config) {
                    try {
                        cfg = JSON.parse(window._activeSourceDetail.extra_config);
                    } catch (e) { }
                }

                for (const [key, val] of Object.entries(deviceData)) {
                    let type = 'normal';
                    if (cfg && cfg.devices && cfg.devices[title] && cfg.devices[title][key]) {
                        type = cfg.devices[title][key].type || 'normal';
                    }

                    let color = '#4a7a9a'; // Default abu-abu gelap (Tidak Aktif)
                    if (type === 'alarm') {
                        color = (val === 'Aktif') ? '#ff3355' : '#00ffcc';
                    } else if (type === 'warning') {
                        color = (val === 'Aktif') ? '#ffcc00' : '#00ffcc';
                    } else {
                        if (val === 'Aktif' || val === 'TX 1' || val === 'TX 2' || val === 'Normal') color = '#00ffcc';
                    }

                    params.push([key, val, color]);
                }

                return params;
            };

            let devicesToRender = data.devices;

            // Jika backend belum mengirim data (misal karena offline sejak server nyala)
            // maka kita buatkan struktur '—' dari extra_config agar UI tetap tergambar
            if (!devicesToRender || Object.keys(devicesToRender).length === 0) {
                devicesToRender = {};
                if (window._activeSourceDetail && window._activeSourceDetail.extra_config) {
                    try {
                        const cfg = JSON.parse(window._activeSourceDetail.extra_config);
                        if (cfg && cfg.devices) {
                            for (const [dName, mapping] of Object.entries(cfg.devices)) {
                                const dummy = {};
                                for (const key of Object.keys(mapping)) {
                                    dummy[key] = '-';
                                }
                                devicesToRender[dName] = dummy;
                            }
                        }
                    } catch (e) { }
                }
            }

            if (devicesToRender) {
                for (const [deviceName, deviceData] of Object.entries(devicesToRender)) {
                    sections.push({
                        title: deviceName, params: renderDevice(deviceName, deviceData)
                    });
                }
            }

        } else if (parserId === 'dme_maru_310_320') {
            const sup = 'DME';
            sections.push({
                title: 'STATUS', params: [
                    ['TXP Active', data.txp_active || '—', getLimitColor(data.sup_category || 'Generic', 'TXP Active', data.txp_active || '—', data)],
                    ['Ident', data.ident || '—', getLimitColor(data.sup_category || 'Generic', 'Ident', data.ident || '—', data)],
                ]
            });
            sections.push({
                title: 'TXP1 — MON1', params: [
                    ['Sys Delay', data.txp1_m1_sys_delay, getLimitColor(sup, 'System Delay', data.txp1_m1_sys_delay)],
                    ['Reply Eff (%)', data.txp1_m1_reply_eff, getLimitColor(sup, 'Reply Efficiency', data.txp1_m1_reply_eff)],
                    ['Pair Rate', data.txp1_m1_pair_rate, getLimitColor(data.sup_category || 'Generic', 'Pair Rate', data.txp1_m1_pair_rate, data)],
                    ['Fwd Power (W)', data.txp1_m1_fwd_power, getLimitColor(sup, 'Forward Power', data.txp1_m1_fwd_power)],
                    ['Dur A', data.txp1_m1_dur_a, getLimitColor(data.sup_category || 'Generic', 'Dur A', data.txp1_m1_dur_a, data)],
                    ['Dur B', data.txp1_m1_dur_b, getLimitColor(data.sup_category || 'Generic', 'Dur B', data.txp1_m1_dur_b, data)],
                    ['Rise A', data.txp1_m1_rise_a, getLimitColor(data.sup_category || 'Generic', 'Rise A', data.txp1_m1_rise_a, data)],
                    ['Rise B', data.txp1_m1_rise_b, getLimitColor(data.sup_category || 'Generic', 'Rise B', data.txp1_m1_rise_b, data)],
                    ['Decay A', data.txp1_m1_decay_a, getLimitColor(data.sup_category || 'Generic', 'Decay A', data.txp1_m1_decay_a, data)],
                    ['Decay B', data.txp1_m1_decay_b, getLimitColor(data.sup_category || 'Generic', 'Decay B', data.txp1_m1_decay_b, data)],
                    ['Spacing', data.txp1_m1_spacing, getLimitColor(sup, 'Pulse Spacing', data.txp1_m1_spacing)],
                ]
            });
            sections.push({
                title: 'TXP1 — MON2', params: [
                    ['Sys Delay', data.txp1_m2_sys_delay, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_sys_delay', data.txp1_m2_sys_delay, data)],
                    ['Reply Eff (%)', data.txp1_m2_reply_eff, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_reply_eff', data.txp1_m2_reply_eff, data)],
                    ['Pair Rate', data.txp1_m2_pair_rate, getLimitColor(data.sup_category || 'Generic', 'Pair Rate', data.txp1_m2_pair_rate, data)],
                    ['Fwd Power (W)', data.txp1_m2_fwd_power, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_fwd_power', data.txp1_m2_fwd_power, data)],
                    ['Dur A', data.txp1_m2_dur_a, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_dur_a', data.txp1_m2_dur_a, data)],
                    ['Dur B', data.txp1_m2_dur_b, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_dur_b', data.txp1_m2_dur_b, data)],
                    ['Rise A', data.txp1_m2_rise_a, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_rise_a', data.txp1_m2_rise_a, data)],
                    ['Rise B', data.txp1_m2_rise_b, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_rise_b', data.txp1_m2_rise_b, data)],
                    ['Decay A', data.txp1_m2_decay_a, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_decay_a', data.txp1_m2_decay_a, data)],
                    ['Decay B', data.txp1_m2_decay_b, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_decay_b', data.txp1_m2_decay_b, data)],
                    ['Spacing', data.txp1_m2_spacing, getLimitColor(data.sup_category || 'Generic', 'txp1_m2_spacing', data.txp1_m2_spacing, data)],
                ]
            });
            sections.push({
                title: 'TXP2 — MON1', params: [
                    ['Sys Delay', data.txp2_m1_sys_delay, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_sys_delay', data.txp2_m1_sys_delay, data)],
                    ['Reply Eff (%)', data.txp2_m1_reply_eff, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_reply_eff', data.txp2_m1_reply_eff, data)],
                    ['Pair Rate', data.txp2_m1_pair_rate, getLimitColor(data.sup_category || 'Generic', 'Pair Rate', data.txp2_m1_pair_rate, data)],
                    ['Fwd Power (W)', data.txp2_m1_fwd_power, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_fwd_power', data.txp2_m1_fwd_power, data)],
                    ['Dur A', data.txp2_m1_dur_a, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_dur_a', data.txp2_m1_dur_a, data)],
                    ['Dur B', data.txp2_m1_dur_b, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_dur_b', data.txp2_m1_dur_b, data)],
                    ['Rise A', data.txp2_m1_rise_a, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_rise_a', data.txp2_m1_rise_a, data)],
                    ['Rise B', data.txp2_m1_rise_b, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_rise_b', data.txp2_m1_rise_b, data)],
                    ['Decay A', data.txp2_m1_decay_a, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_decay_a', data.txp2_m1_decay_a, data)],
                    ['Decay B', data.txp2_m1_decay_b, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_decay_b', data.txp2_m1_decay_b, data)],
                    ['Spacing', data.txp2_m1_spacing, getLimitColor(data.sup_category || 'Generic', 'txp2_m1_spacing', data.txp2_m1_spacing, data)],
                ]
            });
            sections.push({
                title: 'TXP2 — MON2', params: [
                    ['Sys Delay', data.txp2_m2_sys_delay, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_sys_delay', data.txp2_m2_sys_delay, data)],
                    ['Reply Eff (%)', data.txp2_m2_reply_eff, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_reply_eff', data.txp2_m2_reply_eff, data)],
                    ['Pair Rate', data.txp2_m2_pair_rate, getLimitColor(data.sup_category || 'Generic', 'Pair Rate', data.txp2_m2_pair_rate, data)],
                    ['Fwd Power (W)', data.txp2_m2_fwd_power, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_fwd_power', data.txp2_m2_fwd_power, data)],
                    ['Dur A', data.txp2_m2_dur_a, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_dur_a', data.txp2_m2_dur_a, data)],
                    ['Dur B', data.txp2_m2_dur_b, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_dur_b', data.txp2_m2_dur_b, data)],
                    ['Rise A', data.txp2_m2_rise_a, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_rise_a', data.txp2_m2_rise_a, data)],
                    ['Rise B', data.txp2_m2_rise_b, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_rise_b', data.txp2_m2_rise_b, data)],
                    ['Decay A', data.txp2_m2_decay_a, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_decay_a', data.txp2_m2_decay_a, data)],
                    ['Decay B', data.txp2_m2_decay_b, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_decay_b', data.txp2_m2_decay_b, data)],
                    ['Spacing', data.txp2_m2_spacing, getLimitColor(data.sup_category || 'Generic', 'txp2_m2_spacing', data.txp2_m2_spacing, data)],
                ]
            });
        } else if (parserId === 'dme_mopah_binary') {
            const ok = '#00ff88', warn = '#ffcc00', err = '#ff3355', info = '#e8f4ff';

            sections.push({
                title: 'DME STATUS', params: [
                    ['Overall Status', data.overall_status || '—', data.overall_status === 'Normal' ? ok : warn],
                    ['TX Active', data.tx_active || '—', getLimitColor(data.sup_category || 'Generic', 'TX Active', data.tx_active || '—', data)],
                    ['Power Output (W)', data.power_watts || '—', getLimitColor(data.sup_category || 'Generic', 'Power Output (W)', data.power_watts || '—', data)],
                    ['Reply Efficiency (%)', data.reply_efficiency || '—', getLimitColor(data.sup_category || 'Generic', 'Reply Efficiency (%)', data.reply_efficiency || '—', data)],
                    ['Time Delay (us)', data.time_delay || '—', getLimitColor(data.sup_category || 'Generic', 'Time Delay (us)', data.time_delay || '—', data)]
                ]
            });

            // Tampilkan baris raw dari Hex dump jika ada (seperti _amv_txs_rows)
            const dmeRows = data._amv_txs_rows || [];
            if (dmeRows.length > 0) {
                sections.push({
                    title: 'HEX DUMP VALUES', params:
                        dmeRows.map(r => [r[0], r[1], info])
                });
            }
        } else if (parserId === 'vhf_t6tv') {
            const ok = '#00ff88', warn = '#ffcc00', err = '#ff3355', info = '#e8f4ff', accent = '#00d4ff';
            const pwr = (v) => !v || v === '—' ? '#4a7a9a' : (v.includes('Not') || v === 'OFF' || v === '0') ? err : ok;

            sections.push({
                title: 'SERVICE STATUS', params: [
                    ['Overall Status', data.overall_status, data.overall_status?.includes('Full Service') ? ok : err],
                    ['AC Power', data.ac_power, pwr(data.ac_power)],
                    ['DC Power', data.dc_power, pwr(data.dc_power)],
                    ['DC Supply (V)', data.dc_supply_v, info],
                    ['Ambient Temp', data.ambient_temp, info],
                    ['Internal Temp', data.internal_temp, info],
                    ['Elapsed Time', data.elapsed_time, info],
                    ['Status Messages', data.status_messages, data.status_messages && data.status_messages !== '—' ? warn : '#4a7a9a'],
                ]
            });

            const fwdColor = (v) => {
                const n = parseFloat(v); if (isNaN(n)) return '#4a7a9a';
                return n >= 80 ? ok : n >= 60 ? warn : err;
            };
            const reflColor = (v) => {
                const n = parseFloat(v); if (isNaN(n)) return '#4a7a9a';
                return n <= 5 ? ok : n <= 10 ? warn : err;
            };
            const sinadColor = (v) => {
                const n = parseFloat(v); if (isNaN(n)) return '#4a7a9a';
                return n >= 20 ? ok : n >= 12 ? warn : err;
            };

            // RADIO SETTINGS — hanya tampilkan yang bukan boolean True/False murni
            // (Channel tetap tampil, boolean lain disembunyikan karena tidak informatif)
            const radioRows = (data._radio_rows || []).filter(r => {
                if (r[0] === 'Channel') return true;
                const v = String(r[1]).trim().toLowerCase();
                return v !== 'true' && v !== 'false'; // sembunyikan pure boolean
            });
            if (radioRows.length > 0) {
                sections.push({
                    title: 'RADIO SETTINGS', params:
                        radioRows.map(r => [r[0], r[1], r[0] === 'Channel' ? accent : info])
                });
            }

            // BIT_ESC — Normal/Escalated status per parameter
            const escRows = data._bit_esc_rows || [];
            if (escRows.length > 0) {
                sections.push({
                    title: 'BIT ESCALATION STATUS', params:
                        escRows.map(([k, v]) => {
                            const vl = String(v).toLowerCase();
                            const col = vl.includes('escalat') ? err
                                : vl.includes('normal') ? ok : info;
                            return [k, v, col];
                        })
                });
            }

            // AMV_TXS — TX settings (hanya tampil jika ada data, sembunyikan pure boolean)
            const txRows = (data._amv_txs_rows || []).filter(r => {
                const v = String(r[1]).trim().toLowerCase();
                return v !== 'true' && v !== 'false';
            });
            if (txRows.length > 0) {
                sections.push({
                    title: 'AM VOICE TX SETTINGS', params:
                        txRows.map(([k, v]) => [k, v, info])
                });
            }

            // AMV_RXS — tampilkan hanya parameter yang punya nilai informatif (bukan pure boolean)
            const rxRows = (data._amv_rxs_rows || []).filter(r => {
                const v = String(r[1]).trim().toLowerCase();
                return v !== 'true' && v !== 'false';
            });
            if (rxRows.length > 0) {
                sections.push({
                    title: 'AM VOICE RX', params:
                        rxRows.map(([k, v]) => [k, v, info])
                });
            }

            sections.push({
                title: 'SYSTEM INFO', params: [
                    ['System Name', data.snmp_name, accent],
                    ['Model', data.model, info],
                    ['Equipment', data.equipment, info],
                    ['Serial Number', data.serial_number, info],
                    ['Firmware', data.firmware, info],
                    ['Boot Installed', data.boot_installed, info],
                ]
            });
        } else if (parserId === 'pm5560_modbus' || parserId === 'diris_a20') {
            const sup = 'Power Meter';
            const fn = (v, d) => (v != null && !isNaN(parseFloat(v))) ? parseFloat(v).toFixed(d) : '—';
            const vn = (v) => (v != null && !isNaN(parseFloat(v))) ? '#e8f4ff' : '#4a7a9a';

            sections.push({
                title: 'STATUS', params: [
                    ['Tegangan VLN Avg (V)', fn(data.VLN_avg, 1), getLimitColor(sup, 'Van Voltage', data.VLN_avg)],
                    ['Tegangan VLL Avg (V)', fn(data.VLL_avg, 1), getLimitColor(data.sup_category || 'Generic', 'Tegangan VLL Avg (V)', fn(data.VLL_avg, 1), data)],
                    ['Frekuensi (Hz)', fn(data.HZ, 2), getLimitColor(sup, 'Frequency', data.HZ)],
                    ['Power Factor', fn(data.PF, 3), getLimitColor(sup, 'Power Factor', Math.abs(data.PF || 0))],
                    ['Offline', (data.alarmDetail && data.alarmDetail.length > 0) ? data.alarmDetail.join(' | ') : 'Tidak Ada', data.alarmDetail && data.alarmDetail.length > 0 ? '#ff3355' : '#00ff88'],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-NEUTRAL (V)', params: [
                    ['Van (L1-N)', fn(data.VL1N, 1), getLimitColor(data.sup_category || 'Generic', 'VL1N', data.VL1N, data)],
                    ['Vbn (L2-N)', fn(data.VL2N, 1), getLimitColor(data.sup_category || 'Generic', 'VL2N', data.VL2N, data)],
                    ['Vcn (L3-N)', fn(data.VL3N, 1), getLimitColor(data.sup_category || 'Generic', 'VL3N', data.VL3N, data)],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-LINE (V)', params: [
                    ['Vab (L1-L2)', fn(data.VL12, 1), getLimitColor(data.sup_category || 'Generic', 'VL12', data.VL12, data)],
                    ['Vbc (L2-L3)', fn(data.VL23, 1), getLimitColor(data.sup_category || 'Generic', 'VL23', data.VL23, data)],
                    ['Vca (L3-L1)', fn(data.VL31, 1), getLimitColor(data.sup_category || 'Generic', 'VL31', data.VL31, data)],
                ]
            });

            sections.push({
                title: 'ARUS (A)', params: [
                    ['Ia (L1)', fn(data.IL1, 2), vn(data.IL1)],
                    ['Ib (L2)', fn(data.IL2, 2), vn(data.IL2)],
                    ['Ic (L3)', fn(data.IL3, 2), vn(data.IL3)],
                ]
            });

            sections.push({
                title: 'DAYA', params: [
                    ['Real (kW)', fn(data.KW, 3), vn(data.KW)],
                    ['Reaktif (kVAR)', fn(data.KVAR, 3), vn(data.KVAR)],
                    ['Semu (kVA)', fn(data.KVA, 3), vn(data.KVA)],
                    ['Power Factor', fn(data.PF, 3), getLimitColor(data.sup_category || 'Generic', 'PF', data.PF, data)],
                    ['Frekuensi (Hz)', fn(data.HZ, 2), getLimitColor(data.sup_category || 'Generic', 'HZ', data.HZ, data)],
                    ['Energi (kWh)', data.KWH != null ? (+data.KWH).toLocaleString('id-ID', { minimumFractionDigits: 1 }) : '—', getLimitColor(data.sup_category || 'Generic', 'Energi (kWh)', data.KWH != null ? (+data.KWH).toLocaleString('id-ID', { minimumFractionDigits: 1 }) : '—', data)],
                ]
            });
        } else if (parserId === 'pm5350_modbus') {
            const fn = (v, d) => (v != null && !isNaN(parseFloat(v))) ? parseFloat(v).toFixed(d) : '—';
            const vn = (v) => (v != null && !isNaN(parseFloat(v))) ? '#e8f4ff' : '#4a7a9a';
            const vc = (v, min, max) => {
                const num = parseFloat(v);
                if (isNaN(num)) return '#4a7a9a';
                return (num >= min && num <= max) ? '#00ff88' : '#ff3355';
            };

            sections.push({
                title: 'STATUS', params: [
                    ['Frekuensi (Hz)', fn(data.FREQ, 2), getLimitColor(data.sup_category || 'Generic', 'FREQ', data.FREQ, data)],
                    ['Power Factor', fn(data.PF, 3), getLimitColor(data.sup_category || 'Generic', 'Power Factor', fn(data.PF, 3), data)],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-NEUTRAL (V)', params: [
                    ['V_RN (L1-N)', fn(data.V_RN, 1), getLimitColor(data.sup_category || 'Generic', 'V_RN', data.V_RN, data)],
                    ['V_SN (L2-N)', fn(data.V_SN, 1), getLimitColor(data.sup_category || 'Generic', 'V_SN', data.V_SN, data)],
                    ['V_TN (L3-N)', fn(data.V_TN, 1), getLimitColor(data.sup_category || 'Generic', 'V_TN', data.V_TN, data)],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-LINE (V)', params: [
                    ['V_RS (L1-L2)', fn(data.V_RS, 1), getLimitColor(data.sup_category || 'Generic', 'V_RS', data.V_RS, data)],
                    ['V_ST (L2-L3)', fn(data.V_ST, 1), getLimitColor(data.sup_category || 'Generic', 'V_ST', data.V_ST, data)],
                    ['V_TR (L3-L1)', fn(data.V_TR, 1), getLimitColor(data.sup_category || 'Generic', 'V_TR', data.V_TR, data)],
                ]
            });

            sections.push({
                title: 'ARUS (A)', params: [
                    ['I_R (L1)', fn(data.I_R, 2), vn(data.I_R)],
                    ['I_S (L2)', fn(data.I_S, 2), vn(data.I_S)],
                    ['I_T (L3)', fn(data.I_T, 2), vn(data.I_T)],
                ]
            });

            sections.push({
                title: 'DAYA', params: [
                    ['Aktif (kW)', fn(data.KW, 3), vn(data.KW)],
                    ['Semu (kVA)', fn(data.KVA, 3), vn(data.KVA)],
                ]
            });
        } else if (parserId === 'snmp_system') {
            const sup = 'RADAR'; // Assuming standard limits for servers/radar
            const isConn = data.connectivity === 'Connected';
            const cc = isConn ? '#00ff88' : '#ff3355';
            const toNum = (v) => {
                const n = parseFloat(v);
                return Number.isFinite(n) ? n : null;
            };
            const ramTotalNum = toNum(data.ram_total_mb);
            const ramUsedNum = toNum(data.ram_used_mb);
            const ramUsedPctNum = toNum(data.ram_usage_pct);
            const ramAvailMbNum = toNum(data.ram_available_mb);
            const ramAvailPctNum = toNum(data.ram_available_pct);

            const effectiveRamUsedPct = ramUsedPctNum !== null
                ? ramUsedPctNum
                : (ramTotalNum && ramUsedNum !== null ? (ramUsedNum / ramTotalNum) * 100 : null);
            const effectiveRamAvailMb = ramAvailMbNum !== null
                ? ramAvailMbNum
                : (ramTotalNum !== null && ramUsedNum !== null ? Math.max(0, ramTotalNum - ramUsedNum) : null);
            const effectiveRamAvailPct = ramAvailPctNum !== null
                ? ramAvailPctNum
                : (ramTotalNum && effectiveRamAvailMb !== null ? (effectiveRamAvailMb / ramTotalNum) * 100 : null);

            sections.push({
                title: 'SISTEM', params: [
                    ['Konektivitas', data.connectivity || '—', cc],
                    ['Hostname', data.sys_name || '—', getLimitColor(data.sup_category || 'Generic', 'Hostname', data.sys_name || '—', data)],
                    ['Deskripsi', data.sys_descr || '—', getLimitColor(data.sup_category || 'Generic', 'Deskripsi', data.sys_descr || '—', data)],
                    ['Uptime', data.sys_uptime || '—', getLimitColor(data.sup_category || 'Generic', 'Uptime', data.sys_uptime || '—', data)],
                ]
            });
            sections.push({
                title: 'CPU', params: [
                    ['CPU Usage (%)', data.cpu_usage !== '—' ? `${data.cpu_usage} %` : '—', getLimitColor(sup, 'CPU Usage', data.cpu_usage)],
                ]
            });
            sections.push({
                title: 'TEMPERATURE', params: [
                    ['Temperature', formatSnmpMetricValue('temperature_c', data.temperature_c), getLimitColor(sup, 'Temperature', data.temperature_c)],
                    ['Sensor Name', data.temperature_sensor_name || '—', getLimitColor(data.sup_category || 'Generic', 'Sensor Name', data.temperature_sensor_name || '—', data)],
                    ['Sensor Count', formatSnmpMetricValue('temperature_sensor_count', data.temperature_sensor_count), getLimitColor(data.sup_category || 'Generic', 'Sensor Count', formatSnmpMetricValue('temperature_sensor_count', data.temperature_sensor_count), data)],
                ]
            });
            sections.push({
                title: 'MEMORY (RAM)', params: [
                    ['RAM Total', formatSnmpMetricValue('ram_total_mb', data.ram_total_mb), getLimitColor(data.sup_category || 'Generic', 'RAM Total', formatSnmpMetricValue('ram_total_mb', data.ram_total_mb), data)],
                    ['RAM Used [SNMP]', formatSnmpMetricValue('ram_used_mb', data.ram_used_mb), getLimitColor(data.sup_category || 'Generic', 'RAM Used [SNMP]', formatSnmpMetricValue('ram_used_mb', data.ram_used_mb), data)],
                    ['RAM Used (%) [SNMP]', effectiveRamUsedPct !== null ? `${effectiveRamUsedPct.toFixed(1)} %` : '—', getLimitColor(data.sup_category || 'Generic', 'RAM Used (%) [SNMP]', effectiveRamUsedPct !== null ? `${effectiveRamUsedPct.toFixed(1)} %` : '—', data)],
                    ['RAM Available', effectiveRamAvailMb !== null ? formatSnmpMetricValue('ram_available_mb', Math.round(effectiveRamAvailMb)) : '—', getLimitColor(data.sup_category || 'Generic', 'RAM Available', effectiveRamAvailMb !== null ? formatSnmpMetricValue('ram_available_mb', Math.round(effectiveRamAvailMb)) : '—', data)],
                    ['RAM Available (%)', effectiveRamAvailPct !== null ? `${effectiveRamAvailPct.toFixed(1)} %` : '—', getLimitColor('UPS', 'RAM Available', effectiveRamAvailPct)],
                ]
            });
            sections.push({
                title: 'MEMORY (PHYSICAL/VIRTUAL)', params: [
                    ['Physical Total', formatSnmpMetricValue('physical_memory_total_mb', data.physical_memory_total_mb), getLimitColor(data.sup_category || 'Generic', 'Physical Total', formatSnmpMetricValue('physical_memory_total_mb', data.physical_memory_total_mb), data)],
                    ['Physical Used', formatSnmpMetricValue('physical_memory_used_mb', data.physical_memory_used_mb), getLimitColor(data.sup_category || 'Generic', 'Physical Used', formatSnmpMetricValue('physical_memory_used_mb', data.physical_memory_used_mb), data)],
                    ['Physical Usage (%)', data.physical_memory_usage_pct !== '—' ? `${data.physical_memory_usage_pct} %` : '—', getLimitColor(data.sup_category || 'Generic', 'Physical Usage (%)', data.physical_memory_usage_pct !== '—' ? `${data.physical_memory_usage_pct} %` : '—', data)],
                    ['Virtual Total', formatSnmpMetricValue('virtual_memory_total_mb', data.virtual_memory_total_mb), getLimitColor(data.sup_category || 'Generic', 'Virtual Total', formatSnmpMetricValue('virtual_memory_total_mb', data.virtual_memory_total_mb), data)],
                    ['Virtual Used', formatSnmpMetricValue('virtual_memory_used_mb', data.virtual_memory_used_mb), getLimitColor(data.sup_category || 'Generic', 'Virtual Used', formatSnmpMetricValue('virtual_memory_used_mb', data.virtual_memory_used_mb), data)],
                    ['Virtual Usage (%)', data.virtual_memory_usage_pct !== '—' ? `${data.virtual_memory_usage_pct} %` : '—', getLimitColor(data.sup_category || 'Generic', 'Virtual Usage (%)', data.virtual_memory_usage_pct !== '—' ? `${data.virtual_memory_usage_pct} %` : '—', data)],
                    ['Swap Total', formatSnmpMetricValue('swap_total_mb', data.swap_total_mb), getLimitColor(data.sup_category || 'Generic', 'Swap Total', formatSnmpMetricValue('swap_total_mb', data.swap_total_mb), data)],
                    ['Swap Used', formatSnmpMetricValue('swap_used_mb', data.swap_used_mb), getLimitColor(data.sup_category || 'Generic', 'Swap Used', formatSnmpMetricValue('swap_used_mb', data.swap_used_mb), data)],
                    ['Swap Usage (%)', data.swap_usage_pct !== '—' ? `${data.swap_usage_pct} %` : '—', getLimitColor(data.sup_category || 'Generic', 'Swap Usage (%)', data.swap_usage_pct !== '—' ? `${data.swap_usage_pct} %` : '—', data)],
                    ['Buffers', formatSnmpMetricValue('memory_buffers_mb', data.memory_buffers_mb), getLimitColor(data.sup_category || 'Generic', 'Buffers', formatSnmpMetricValue('memory_buffers_mb', data.memory_buffers_mb), data)],
                    ['Cached', formatSnmpMetricValue('cached_memory_mb', data.cached_memory_mb), getLimitColor(data.sup_category || 'Generic', 'Cached', formatSnmpMetricValue('cached_memory_mb', data.cached_memory_mb), data)],
                    ['Shared', formatSnmpMetricValue('shared_memory_mb', data.shared_memory_mb), getLimitColor(data.sup_category || 'Generic', 'Shared', formatSnmpMetricValue('shared_memory_mb', data.shared_memory_mb), data)],
                ]
            });
            if (data.mount_points && data.mount_points.length > 0) {
                const diskParams = data.mount_points.map(mp => [
                    mp.mount,
                    mp.used_str + ' / ' + mp.total_str,
                    mp.state === 'Alarm' ? '#ff3355' : mp.state === 'Warning' ? '#ffcc00' : '#e8f4ff'
                ]);
                sections.push({ title: 'DISK', params: diskParams });
            } else {
                sections.push({
                    title: 'DISK', params: [
                        ['Disk Total', formatSnmpMetricValue('disk_total_gb', data.disk_total_gb), getLimitColor(data.sup_category || 'Generic', 'Disk Total', formatSnmpMetricValue('disk_total_gb', data.disk_total_gb), data)],
                        ['Disk Used', formatSnmpMetricValue('disk_used_gb', data.disk_used_gb), getLimitColor(data.sup_category || 'Generic', 'Disk Used', formatSnmpMetricValue('disk_used_gb', data.disk_used_gb), data)],
                        ['Disk Usage (%)', data.disk_usage_pct !== '—' ? `${data.disk_usage_pct} %` : '—', getLimitColor(data.sup_category || 'Generic', 'Disk Usage (%)', data.disk_usage_pct !== '—' ? `${data.disk_usage_pct} %` : '—', data)],
                    ]
                });
            }
        } else if (parserId === 'snmp_network_basic') {
            const isConn = data.connectivity === 'Connected';
            const cc = isConn ? '#00ff88' : '#ff3355';
            sections.push({
                title: 'SISTEM JARINGAN', params: [
                    ['Konektivitas', data.connectivity || '—', cc],
                    ['Hostname', data.sys_name || '—', getLimitColor(data.sup_category || 'Generic', 'Hostname', data.sys_name || '—', data)],
                    ['IP', data.resolved_ip || '—', getLimitColor(data.sup_category || 'Generic', 'IP', data.resolved_ip || '—', data)],
                    ['Hardware', data.hardware || '—', getLimitColor(data.sup_category || 'Generic', 'Hardware', data.hardware || '—', data)],
                    ['OS', data.operating_system || '—', getLimitColor(data.sup_category || 'Generic', 'OS', data.operating_system || '—', data)],
                    ['Uptime', data.sys_uptime || '—', getLimitColor(data.sup_category || 'Generic', 'Uptime', data.sys_uptime || '—', data)],
                    ['Lokasi', data.sys_location || '—', getLimitColor(data.sup_category || 'Generic', 'Lokasi', data.sys_location || '—', data)],
                ]
            });
            sections.push({
                title: 'INTERFACE', params: [
                    ['Total Interface', formatSnmpMetricValue('interface_count', data.interface_count), getLimitColor(data.sup_category || 'Generic', 'Total Interface', formatSnmpMetricValue('interface_count', data.interface_count), data)],
                    ['Interface Up', formatSnmpMetricValue('active_interface_count', data.active_interface_count), getLimitColor(data.sup_category || 'Generic', 'Interface Up', formatSnmpMetricValue('active_interface_count', data.active_interface_count), data)],
                    ['Interface Down', formatSnmpMetricValue('down_interface_count', data.down_interface_count), getLimitColor(data.sup_category || 'Switch', 'Interface Down', data.down_interface_count, data)],
                    ['Port Aktif', data.active_interfaces_summary || '—', getLimitColor(data.sup_category || 'Generic', 'Port Aktif', data.active_interfaces_summary || '—', data)],
                    ['Port Tidak Aktif', data.down_interfaces_summary || '—', getLimitColor(data.sup_category || 'Switch', 'Port Tidak Aktif', data.down_interface_count, data)],
                    ['Top Interface', data.top_interface_name || '—', getLimitColor(data.sup_category || 'Generic', 'Top Interface', data.top_interface_name || '—', data)],
                    ['Status Top Interface', data.top_interface_status || '—', getLimitColor(data.sup_category || 'Generic', 'Status Top Interface', data.top_interface_status || '—', data)],
                    ['In Octets', formatSnmpMetricValue('top_interface_in_octets', data.top_interface_in_octets), getLimitColor(data.sup_category || 'Generic', 'In Octets', formatSnmpMetricValue('top_interface_in_octets', data.top_interface_in_octets), data)],
                    ['Out Octets', formatSnmpMetricValue('top_interface_out_octets', data.top_interface_out_octets), getLimitColor(data.sup_category || 'Generic', 'Out Octets', formatSnmpMetricValue('top_interface_out_octets', data.top_interface_out_octets), data)],
                    ['Temperature', formatSnmpMetricValue('temperature_c', data.temperature_c), getLimitColor('Switch', 'Temperature', data.temperature_c)],
                    ['Temp Sensor', data.temperature_sensor_name || '—', getLimitColor(data.sup_category || 'Generic', 'Temp Sensor', data.temperature_sensor_name || '—', data)],
                ]
            });
        } else if (parserId === 'asterix_radar') {
            const isConn = data.connectivity === 'Connected';
            const cc = isConn ? '#00ff88' : '#ff3355';
            sections.push({
                title: 'STATUS RADAR MSSR', params: [
                    ['Konektivitas', data.connectivity || '—', cc],
                    ['Nama Radar', data.radar_name || '—', getLimitColor(data.sup_category || 'Generic', 'Nama Radar', data.radar_name || '—', data)],
                    ['SAC', data.sac || '—', getLimitColor(data.sup_category || 'Generic', 'SAC', data.sac || '—', data)],
                    ['SIC', data.sic || '—', getLimitColor(data.sup_category || 'Generic', 'SIC', data.sic || '—', data)],
                    ['Radar ID', data.radar_id || '—', getLimitColor(data.sup_category || 'Generic', 'Radar ID', data.radar_id || '—', data)],
                    ['Message Type', data.msg_type || '—', getLimitColor(data.sup_category || 'Generic', 'Message Type', data.msg_type || '—', data)],
                    ['Time of Day', data.time_of_day || '—', getLimitColor(data.sup_category || 'Generic', 'Time of Day', data.time_of_day || '—', data)],
                    ['Sector', data.sector_number || '—', getLimitColor(data.sup_category || 'Generic', 'Sector', data.sector_number || '—', data)],
                    ['Antenna Rot.', data.antenna_rotation || '—', getLimitColor(data.sup_category || 'Generic', 'Antenna Rot.', data.antenna_rotation || '—', data)],
                    ['Sys Config', data.system_config || '—', getLimitColor(data.sup_category || 'Generic', 'Sys Config', data.system_config || '—', data)],
                    ['Last CAT034', data.last_cat034 || '—', getLimitColor(data.sup_category || 'Generic', 'Last CAT034', data.last_cat034 || '—', data)],
                    ['Koordinat', data.lat && data.lon ? `${data.lat}, ${data.lon}` : '—', getLimitColor(data.sup_category || 'Generic', 'Koordinat', data.lat && data.lon ? `${data.lat}, ${data.lon}` : '—', data)],
                    ['Data Source', data.data_source || '—', getLimitColor(data.sup_category || 'Generic', 'Data Source', data.data_source || '—', data)],
                ]
            });

        } else if (parserId === 'asterix_adsb') {
            const isConn = data.connectivity === 'Connected';
            const cc = isConn ? '#00ff88' : '#ff3355';
            sections.push({
                title: 'STATUS ADS-B STATION', params: [
                    ['Konektivitas', data.connectivity || '—', cc],
                    ['Station', data.station || '—', getLimitColor(data.sup_category || 'Generic', 'Station', data.station || '—', data)],
                    ['SAC', data.sac || '—', getLimitColor(data.sup_category || 'Generic', 'SAC', data.sac || '—', data)],
                    ['SIC', data.sic || '—', getLimitColor(data.sup_category || 'Generic', 'SIC', data.sic || '—', data)],
                    ['Radar ID', data.radar_id || '—', getLimitColor(data.sup_category || 'Generic', 'Radar ID', data.radar_id || '—', data)],
                    ['Multicast IP', data.multicast_ip || '—', getLimitColor(data.sup_category || 'Generic', 'Multicast IP', data.multicast_ip || '—', data)],
                    ['Multicast Port', data.multicast_port || '—', getLimitColor(data.sup_category || 'Generic', 'Multicast Port', data.multicast_port || '—', data)],
                    ['Last CAT021', data.last_cat021 || '—', getLimitColor(data.sup_category || 'Generic', 'Last CAT021', data.last_cat021 || '—', data)],
                    ['Koordinat', data.lat && data.lon ? `${data.lat}, ${data.lon}` : '—', getLimitColor(data.sup_category || 'Generic', 'Koordinat', data.lat && data.lon ? `${data.lat}, ${data.lon}` : '—', data)],
                    ['Data Source', data.data_source || '—', getLimitColor(data.sup_category || 'Generic', 'Data Source', data.data_source || '—', data)],
                ]
            });

        } else if (parserId === 'temp_humidity_modbus') {
            const sup = 'SHELTER';
            const temp = parseFloat(data.temperature_c);
            const humi = parseFloat(data.humidity_pct);
            sections.push({
                title: 'SENSOR SUHU & KELEMBABAN', params: [
                    ['Suhu (°C)', isNaN(temp) ? '—' : `${temp.toFixed(1)} °C`, getLimitColor(sup, 'Temperature', temp)],
                    ['Kelembaban (%)', isNaN(humi) ? '—' : `${humi.toFixed(1)} %`, getLimitColor(data.sup_category || 'Generic', 'Kelembaban (%)', isNaN(humi) ? '—' : `${humi.toFixed(1)} %`, data)],
                    ['Lokasi', data.location || '—', getLimitColor(data.sup_category || 'Generic', 'Lokasi', data.location || '—', data)],
                    ['Status', data.status_text || '—',
                        data.status_text === 'Alarm' ? '#ff3355' : data.status_text === 'Warning' ? '#ffcc00' : '#00ff88'],
                ]
            });
            sections.push({
                title: 'THRESHOLD', params: [
                    ['Warning threshold', '≥ 30.0 °C', getLimitColor(data.sup_category || 'Generic', 'Warning threshold', '≥ 30.0 °C', data)],
                    ['Alarm threshold', '≥ 35.0 °C', getLimitColor(data.sup_category || 'Generic', 'Alarm threshold', '≥ 35.0 °C', data)],
                ]
            });
        } else if (parserId === 'ils_gp_thales421' || parserId === 'ils_gp_normac') {
            const sup = 'ILS-GP';
            sections.push({
                title: 'SYSTEM STATUS', params: [
                    ['TX MAIN', data.tx_main_label || '—', getLimitColor(data.sup_category || 'Generic', 'TX MAIN', data.tx_main_label || '—', data)],
                    ['TX STANDBY', data.tx_stby_label || '—', getLimitColor(data.sup_category || 'Generic', 'TX STANDBY', data.tx_stby_label || '—', data)],
                    ['MODE', data.status_label || '—', data.is_remote ? '#ffcc00' : '#00d4ff'],
                    ['DATA SOURCE', data.tx_data || '—', getLimitColor(data.sup_category || 'Generic', 'DATA SOURCE', data.tx_data || '—', data)],
                ]
            });

            const paramLabels = {
                RF_POWER: 'CRS Pos. RF Level', DDM_COURSE: 'CRS Pos. DDM', CARRIER_PWR: 'CRS Pos. SDM',
                CSB_POWER: 'CRS Width RF Level', DDM_CLR: 'CRS Width DDM', SBO_POWER: 'CRS Width SDM',
                CLR_POWER: 'CLR Width RF Level', CLR_DDM: 'CLR Width DDM', CLR_SDM: 'CLR Width SDM',
                RF_OUT: 'Nearfield Pos. RF', DDM_MON: 'Nearfield Pos. DDM', MON_POWER: 'Monitor Power',
                GP_ANGLE: 'GP Angle'
            };

            sections.push({
                title: 'MONITORING PARAMETERS', params: Object.entries(paramLabels).map(([key, label]) => {
                    const val = data[key];
                    const unit = (key === 'GP_ANGLE') ? '°' : '%';
                    return [label + (unit ? ` (${unit})` : ''), val, getLimitColor(sup, label, val)];
                })
            });

        } else if (parserId === 'ils_llz_thales421') {
            const sup = 'ILS-LLZ';
            sections.push({
                title: 'SYSTEM STATUS', params: [
                    ['TX MAIN', data.tx_main_label || '—', getLimitColor(data.sup_category || 'Generic', 'TX MAIN', data.tx_main_label || '—', data)],
                    ['TX STANDBY', data.tx_stby_label || '—', getLimitColor(data.sup_category || 'Generic', 'TX STANDBY', data.tx_stby_label || '—', data)],
                ]
            });

            const paramLabels = {
                CRS_RF: 'CRS Pos. RF Level', CRS_DDM: 'CRS Pos. DDM', CRS_SDM: 'CRS Pos. SDM',
                IDENT_AM: 'Ident AM', WIDTH_RF: 'CRS Width RF Level', WIDTH_DDM: 'CRS Width DDM',
                WIDTH_SDM: 'CRS Width SDM', CLR_RF: 'CLR Width RF Level', CLR_DDM: 'CLR Width DDM',
                CLR_SDM: 'CLR Width SDM', NF_RF: 'Nearfield Pos. RF Level', NF_DDM: 'Nearfield Pos. DDM',
                NF_SDM: 'Nearfield Pos. SDM', FREQ_DEV: 'Freq Deviation'
            };

            sections.push({
                title: `MONITORING PARAMETERS`,
                params: Object.entries(paramLabels).map(([key, label]) => {
                    const val = data[key];
                    const unit = (key === 'FREQ_DEV') ? 'kHz' : (key.includes('DDM') ? '' : '%');
                    return [label + (unit ? ` (${unit})` : ''), val, getLimitColor(sup, label, val)];
                })
            });
        } else {
            // Check if we have a template for this parser
            let tmpl = window.templatesCache?.find(t => t.id === parserId);

            // Map custom IDs to known templates based on equipment name
            if (!tmpl && parserId && parserId.startsWith('custom_')) {
                const nameLower = (data.equipment || supCategory || '').toLowerCase();
                if (nameLower.includes('glide') || nameLower.includes('gp')) {
                    tmpl = window.templatesCache?.find(t => t.id === 'ils_gp_normac');
                } else if (nameLower.includes('localizer') || nameLower.includes('llz')) {
                    tmpl = window.templatesCache?.find(t => t.id === 'ils_llz_normac');
                } else if (nameLower.includes('vhf')) {
                    tmpl = window.templatesCache?.find(t => t.id === 'vhf_t6tv');
                }
            }

            if (parserId === 'vhf_t6tv_snmp') {
                const dataParams = [];
                const meterParams = [];
                const meterKeys = [
                    'tx_frequency_mhz', 'rf_power_watts', 'modulation_depth', 'tone_keying_freq',
                    'fwd_power', 'refl_power', 'tx_level', 'mod_level', 'rx_level', 'squelch_level',
                    'sinad', 'audio_level', 'rx_freq', 'ambient_temp', 'internal_temp', 'dc_supply_v'
                ];

                Object.entries(data)
                    .filter(([k, v]) => !k.startsWith('_') && !isMetricPlaceholder(v))
                    .forEach(([k, v]) => {
                        const label = k.replace(/_/g, ' ').toUpperCase();
                        const displayValue = formatSnmpMetricValue(k, v);
                        const item = [label, displayValue, getLimitColor(supCategory, label, v)];

                        if (meterKeys.includes(k.toLowerCase())) {
                            meterParams.push(item);
                        } else {
                            dataParams.push(item);
                        }
                    });

                if (dataParams.length > 0) sections.push({ title: 'DATA', params: dataParams });
                if (meterParams.length > 0) sections.push({ title: 'METER READING', params: meterParams });
            } else if (parserId === 'ups_netagent_snmp') {
                const inputParams = [];
                const outputParams = [];
                const batteryParams = [];
                const otherParams = [];

                Object.entries(data)
                    .filter(([k, v]) => !k.startsWith('_') && k !== 'connectivity' && k !== 'sys_descr' && k !== 'sys_name' && !isMetricPlaceholder(v))
                    .forEach(([k, v]) => {
                        const label = k.replace(/_/g, ' ').toUpperCase();
                        const displayValue = formatSnmpMetricValue(k, v);
                        const item = [label, displayValue, getLimitColor(supCategory, label, v)];

                        if (k.startsWith('input_')) inputParams.push(item);
                        else if (k.startsWith('output_')) outputParams.push(item);
                        else if (k.startsWith('battery_')) batteryParams.push(item);
                        else otherParams.push(item);
                    });

                const generalParams = Object.entries(data)
                    .filter(([k]) => ['connectivity', 'sys_descr', 'sys_name'].includes(k))
                    .map(([k, v]) => [k.replace(/_/g, ' ').toUpperCase(), v, getLimitColor(supCategory, k, v)]);

                if (generalParams.length > 0 || otherParams.length > 0) sections.push({ title: 'SYSTEM INFO', params: [...generalParams, ...otherParams] });
                if (inputParams.length > 0) sections.push({ title: 'INPUT', params: inputParams });
                if (outputParams.length > 0) sections.push({ title: 'OUTPUT', params: outputParams });
                if (batteryParams.length > 0) sections.push({ title: 'BATTERY', params: batteryParams });

            } else if (tmpl && tmpl.parameters && tmpl.parameters.length > 0) {
                const params = tmpl.parameters.map(p => {
                    const key = p.name || p.label;
                    const val = data[key] !== undefined ? data[key] : '—';
                    const unit = p.unit ? ` (${p.unit})` : '';
                    const label = p.label || p.name;
                    return [`${label}${unit}`, val, getLimitColor(supCategory, label, val)];
                });
                sections.push({ title: tmpl.name || 'DATA', params });
            } else {
                // Fallback to existing logic: show keys present in data, with support for nested groups
                if (sections.length === 0) {
                    const flatParams = [];
                    Object.entries(data).forEach(([k, v]) => {
                        if (k.startsWith('_') || isMetricPlaceholder(v)) return;
                        
                        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                            // This is a nested group!
                            const groupParams = Object.entries(v)
                                .filter(([gk, gv]) => !gk.startsWith('_') && !isMetricPlaceholder(gv))
                                .map(([gk, gv]) => {
                                    const label = gk.replace(/_/g, ' ').toUpperCase();
                                    return [label, gv, getLimitColor(supCategory, label, gv)];
                                });
                            if (groupParams.length > 0) {
                                sections.push({ title: k.toUpperCase(), params: groupParams });
                            }
                        } else {
                            // Flat metric
                            const label = k.replace(/_/g, ' ').toUpperCase();
                            const displayValue = parserId && parserId.startsWith('snmp_')
                                ? formatSnmpMetricValue(k, v)
                                : v;
                            flatParams.push([label, displayValue, getLimitColor(supCategory, label, v)]);
                        }
                    });
                    
                    if (flatParams.length > 0) {
                        sections.unshift({ title: sections.length > 0 ? 'GENERAL' : 'DATA', params: flatParams });
                    }
                    
                    if (sections.length === 0) {
                        sections.push({ title: 'DATA', params: [['No data available', '—', getLimitColor(data.sup_category || 'Generic', 'No data available', '—', data)]] });
                    }
                }
            }
        }

        return sections;
    }

    // ── Edit/Delete source from panel ────────────────────────────────────────
    window.editSourceFromPanel = function (sourceId, equipmentId) {
        const sources = _sourcesCache[equipmentId] || [];
        const src = sources.find(s => String(s.id) === String(sourceId));
        if (src && window.showAddDataSourceForm) {
            window.showAddDataSourceForm(equipmentId, src);
        }
    };

    window.deleteSourceFromPanel = async function (sourceId, equipmentId) {
        if (!confirm('Hapus data source ini?')) return;
        if (window.deleteDataSource) {
            window.deleteDataSource(sourceId, equipmentId);
            // Refresh panel after delete
            setTimeout(() => openSourcePanel(equipmentId, document.querySelector(`.cabang-card[data-id="${equipmentId}"]`)), 500);
        }
    };

    // ── Cache equipment data for detail view ─────────────────────────────────
    // Hook into existing data refresh
    const _origFetch = window.fetch;
    window.fetch = function (url, opts) {
        return _origFetch(url, opts).then(res => {
            const clone = res.clone();
            if (typeof url === 'string' && url.includes('/api/equipment') && !url.includes('otentication')) {
                clone.json().then(data => {
                    const list = data.data || (Array.isArray(data) ? data : null);
                    if (list) window.equipmentDataCache = list;
                }).catch(() => { });
            }
            return res;
        });
    };

    // ── Close panel ───────────────────────────────────────────────────────────
    function initClosePanel() {
        const closeBtn = document.getElementById('closeDetailPanel');
        const overlay = document.getElementById('detailPanelOverlay');

        const closeAction = () => {
            const panel = document.getElementById('equipmentDetailPanel');
            const overlay = document.getElementById('detailPanelOverlay');
            if (panel) panel.classList.remove('open');
            if (overlay) overlay.classList.remove('open');
            document.querySelectorAll('.cabang-card').forEach(c => c.classList.remove('card-selected'));
            _selectedEqId = null;
        };

        if (closeBtn) {
            closeBtn.addEventListener('click', closeAction);
        }
        if (overlay) {
            overlay.addEventListener('click', closeAction);
        }
    }

    // ── Helper: get auth token ────────────────────────────────────────────────
    function getToken() {
        return localStorage.getItem('authToken') || '';
    }

    // Intercept login to capture token
    const _origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this._url = url;
        return _origXHROpen.call(this, method, url, ...args);
    };

    // ── Add CSS ───────────────────────────────────────────────────────────────
    function addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .cabang-card { cursor: pointer; transition: all .15s; }
            .cabang-card:hover { transform: translateY(-1px); }
            .cabang-card.card-selected { outline: 2px solid #00d4ff !important; }
            .cabang-card.drag-over-card { outline: 2px dashed #00d4ff; opacity: .8; }

            .source-item-card {
                background: #0f1e35;
                border: 1px solid #1a3a5c;
                border-radius: 6px;
                padding: 12px;
                cursor: pointer;
                transition: all .15s;
            }
            .source-item-card:hover { border-color: #007a9e; background: #162540; }

            .source-status-pill {
                font-size: 10px;
                font-weight: bold;
                padding: 2px 8px;
                border-radius: 3px;
            }
            .source-status-pill.normal   { background: #005533; color: #00ff88; border: 1px solid #00ff88; }
            .source-status-pill.alarm    { background: #660022; color: #ff3355; border: 1px solid #ff3355; }
            .source-status-pill.warning  { background: #332200; color: #ffcc00; border: 1px solid #ffcc00; }
            .source-status-pill.disconnect { background: #0f1e35; color: #3a5a7a; border: 1px solid #1a3a5c; }

            .btn-mini {
                background: transparent;
                border: 1px solid #1a3a5c;
                color: #a0c8e8;
                border-radius: 4px;
                padding: 3px 8px;
                font-size: 10px;
                cursor: pointer;
                transition: all .15s;
                font-family: inherit;
            }
            .btn-mini:hover { border-color: #00d4ff; color: #00d4ff; }
            .btn-mini-danger:hover { border-color: #ff3355; color: #ff3355; }

            /* ── Source card status styling ─────────────────────────────── */
            .sp-source-card {
                box-sizing: border-box;
                background: #0a1628;
                border: 1px solid #1a3a5c;
                border-radius: 8px;
                padding: 12px;
                cursor: pointer;
                transition: all .2s;
                position: relative;
                overflow: hidden;
            }
            .sp-source-card:hover { border-color: #007a9e; background: #0d1e38; }

            /* NORMAL — border hijau tipis */
            .sp-source-card.normal {
                border-color: #1a4a2e;
            }
            .sp-source-card.normal:hover { border-color: #00ff88; }

            /* WARNING — border kuning */
            .sp-source-card.warning {
                border-color: #4a3a00;
                background: #0f1a08;
            }
            .sp-source-card.warning:hover { border-color: #ffcc00; }

            /* ALARM — border merah tebal + background merah gelap + pulse */
            .sp-source-card.alarm {
                border: 2px solid #ff3355 !important;
                background: #1a0810 !important;
                box-shadow: 0 0 12px #ff335544, inset 0 0 20px #ff335511;
                animation: alarm-pulse 1.5s ease-in-out infinite;
            }
            @keyframes alarm-pulse {
                0%   { box-shadow: 0 0 8px #ff335544,  inset 0 0 20px #ff335511; }
                50%  { box-shadow: 0 0 20px #ff335599, inset 0 0 30px #ff335522; }
                100% { box-shadow: 0 0 8px #ff335544,  inset 0 0 20px #ff335511; }
            }

            /* DISCONNECT — redup */
            .sp-source-card.disconnect {
                border-color: #0f2030;
                opacity: 0.6;
            }

            /* Alarm indicator dot di pojok kiri atas */
            .sp-source-card.alarm::before {
                content: '';
                position: absolute;
                top: 8px; left: 8px;
                width: 8px; height: 8px;
                border-radius: 50%;
                background: #ff3355;
                animation: dot-blink 1s step-end infinite;
            }
            .sp-source-card.warning::before {
                content: '';
                position: absolute;
                top: 8px; left: 8px;
                width: 8px; height: 8px;
                border-radius: 50%;
                background: #ffcc00;
                animation: dot-blink 2s step-end infinite;
            }
            @keyframes dot-blink {
                0%, 100% { opacity: 1; }
                50%       { opacity: 0; }
            }

            /* cabang-card (equipment card di grid) juga ikut merah saat ada source alarm */
            .cabang-card.has-alarm {
                border-color: #ff3355 !important;
                box-shadow: 0 0 10px #ff335533;
            }
            .cabang-card.has-warning {
                border-color: #ffcc00 !important;
            }

            .sp-panel-content { padding: 14px; box-sizing: border-box; width: 100%; overflow-x: hidden; }
            .sp-panel-toolbar { 
                margin-bottom: 14px; 
                display: flex; 
                justify-content: space-between; 
                align-items: center;
                border-bottom: 1px solid #1a3a5c;
                padding-bottom: 10px;
            }
            .sp-panel-count { font-size: 10px; color: #5a8aaa; letter-spacing: 1px; font-weight: bold; }
            .sp-sources-grid {
                display: grid;
                grid-template-columns: 1fr;
                gap: 12px;
                box-sizing: border-box;
                width: 100%;
            }
            @media (min-width: 1200px) {
                .sp-sources-grid { grid-template-columns: 1fr 1fr; }
            }

            .sp-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
            .sp-card-title { display: flex; align-items: center; gap: 8px; }
            .sp-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4a7a9a; flex-shrink: 0; }
            .sp-status-dot.normal { background: #00ff88; box-shadow: 0 0 8px #00ff8844; }
            .sp-status-dot.alarm { background: #ff3355; box-shadow: 0 0 8px #ff335544; }
            .sp-status-dot.warning { background: #ffcc00; box-shadow: 0 0 8px #ffcc0044; }
            .sp-source-name { font-size: 13px; font-weight: 600; color: #e8f4ff; word-break: break-word; }
            .sp-status-pill { font-size: 9px; font-weight: bold; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; flex-shrink: 0; }
            .sp-status-pill.normal { background: #005533; color: #00ff88; }
            .sp-status-pill.alarm { background: #660022; color: #ff3355; }
            .sp-status-pill.warning { background: #332200; color: #ffcc00; }

            .sp-card-preview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
            .sp-card-preview-point { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
            .sp-preview-label { font-size: 9px; color: #5a8aaa; text-transform: uppercase; letter-spacing: 0.5px; white-space: normal; word-break: break-word; line-height: 1.2; }
            .sp-preview-value { font-size: 11px; color: #e8f4ff; font-family: monospace; font-weight: bold; white-space: normal; word-break: break-word; }

            .sp-card-meta { display: flex; gap: 8px; flex-wrap: wrap; }
            .sp-conn-badge { 
                font-size: 9px; 
                background: #0d2a45; 
                color: #5a8aaa; 
                padding: 2px 6px; 
                border-radius: 4px; 
                display: flex; 
                align-items: center; 
                gap: 4px;
                border: 1px solid #1a3a5c;
            }
            .sp-parser-badge { background: #1a3a5c; color: #a0c8e8; }
            .sp-card-no-data { padding: 20px; text-align: center; color: #3a5a7a; font-size: 11px; display: flex; flex-direction: column; gap: 8px; }
        `;
        document.head.appendChild(style);
    }

    // ── INIT ──────────────────────────────────────────────────────────────────
    function init() {
        addStyles();
        initClosePanel();
        loadTemplates();   // Load templates for schemas
        loadLimitations(); // Load dynamic limits
        waitForGrid(() => {
            observeGrid();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
