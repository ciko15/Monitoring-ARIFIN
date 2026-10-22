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
    const SOURCE_DETAIL_REFRESH_MS = 1500;

    const PREVIEW_SCHEMAS = {
        'dvor_maru_220': ['mon1_azimuth', 'mon1_carrier_power', 'mon2_azimuth', 'mon2_carrier_power', 'tx_active', 'lcu_dc_28v'],
        'dme_maru_310_320': ['txp_active', 'txp1_m1_fwd_power', 'txp1_m1_reply_eff', 'txp2_m1_fwd_power', 'txp2_m1_reply_eff', 'ident'],
        'vhf_t6tv': ['overall_status', 'ac_power', 'dc_power', 'dc_supply_v', 'rf_power_w', 'vswr'],
        'snmp_host_resources_01': ['cpu_usage', 'ram_usage_pct', 'disk_usage_pct', 'sys_uptime'],
        'asterix_radar': ['connectivity', 'radar_name', 'system_status', 'target_count', 'targets_list', 'last_cat034', 'data_source'],
        'asterix_adsb': ['connectivity', 'station', 'target_count', 'last_cat021', 'data_source'],
        'temp_humidity_modbus': ['temperature_c', 'humidity_pct', 'status_text', 'location'],
        'snmp_system': ['connectivity', 'sys_name', 'resolved_ip', 'hardware', 'operating_system', 'cpu_usage', 'physical_memory_usage_pct', 'disk_usage_pct', 'temperature_c'],
        'snmp_network_basic': ['connectivity', 'sys_name', 'resolved_ip', 'top_interface_name', 'top_interface_status', 'top_interface_in_octets', 'top_interface_out_octets', 'temperature_c'],
        'pm5560_modbus': ['VLN_avg', 'VLL_avg', 'HZ', 'PF', 'KW', 'KWH'],
        'diris_a20': ['VLN_avg', 'VLL_avg', 'HZ', 'PF', 'KW', 'KVAR'],
        'pm5350_modbus': ['V_RN', 'V_SN', 'V_TN', 'V_RS', 'V_ST', 'V_TR', 'I_R', 'I_S', 'I_T', 'FREQ', 'KW', 'KVA', 'PF'],
        'ils_llz_thales421': ['CRS_RF', 'WIDTH_RF', 'NF_RF', 'CRS_SDM', 'IDENT_AM', 'FREQ_DEV'],
        'ils_mophien_llz': ['station_ident', 'active_channel', 'cl_ddm', 'ds_ddm'],
        'ils_mophien_gp': ['station_ident', 'active_channel', 'cl_ddm', 'ds_ddm']
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

            // TRIGGER LANGSUNG: Segera render ulang tampilan tanpa menunggu auto-refresh!
            if (typeof window.renderCabangGrid === 'function') {
                window.renderCabangGrid(true);
            }

            // Jika side panel sedang terbuka, langsung render ulang kartu-kartunya
            if (_selectedEqId) {
                const body = document.getElementById('detailPanelBody');
                const panel = document.getElementById('equipmentDetailPanel');
                if (panel && panel.classList.contains('open') && body) {
                    const sources = _sourcesCache[_selectedEqId] || getBestAvailableSources(_selectedEqId);
                    if (sources && sources.length > 0) {
                        renderSourcePanel(sources, body, _selectedEqId);
                    }
                }
            }

            // Jika modal detail sedang terbuka, langsung refresh modal
            if (_activeSourceDetail) {
                refreshSourceDetailModal(_activeSourceDetail, true);
            }
        } catch (e) {
            console.warn('[Enhancements] Failed to load limitations:', e);
        }
    }
    window.loadLimitations = loadLimitations;

    // Centralized color/threshold logic using limitation_config.json
    let currentActiveParserId = null;

    function getLimitColor(supCategory, label, value, parserId = null) {
        if (value === null || value === undefined || value === '—' || value === '-') return '#ffffff';
        if (!window.limitationsCache || window.limitationsCache.length === 0) return '#ffffff';

        const effectiveParserId = parserId || currentActiveParserId || window.currentDetailParserId || null;
        const cleanLabel = normalizeLimitLabel(label);
        if (!cleanLabel) return '#ffffff';

        const aliasMap = {
            'suhu': ['temperature', 'temp', 'temperature_c', 'temperature c', 'ambient temp', 'internal temp'],
            'temperature': ['suhu', 'temp', 'temperature_c', 'temperature c', 'ambient temp', 'internal temp'],
            'kelembaban': ['humidity', 'humidity_pct', 'humidity pct', 'humi'],
            'kelembapan': ['humidity', 'humidity_pct', 'humidity pct', 'humi'],
            'humidity': ['kelembaban', 'kelembapan', 'humidity_pct', 'humidity pct', 'humi'],
            'tegangan': ['voltage', 'volt', 'vln', 'vll', 'van voltage', 'vab', 'vbc', 'vca'],
            'voltage': ['tegangan', 'volt', 'vln', 'vll', 'van voltage', 'vab', 'vbc', 'vca'],
            'arus': ['current', 'ampere', 'amp', 'ia', 'ib', 'ic'],
            'current': ['arus', 'ampere', 'amp', 'ia', 'ib', 'ic'],
            'daya': ['power', 'watt', 'kw', 'fwd power', 'refl power', 'carrier power'],
            'power': ['daya', 'watt', 'kw', 'fwd power', 'refl power', 'carrier power'],
            'frekuensi': ['frequency', 'freq'],
            'frequency': ['frekuensi', 'freq'],
            'totalinterface': ['interfacecount', 'totalinterfaces', 'total interface'],
            'interfaceup': ['activeinterfacecount', 'activeinterfaces', 'interface up'],
            'interfacedown': ['downinterfacecount', 'downinterfaces', 'interface down'],
            'cpuusage': ['cpu', 'processorload', 'cpu usage'],
            'ramusage': ['ramusagepct', 'memoryusage', 'memoryusagepct', 'ram usage'],
            'ramavailable': ['ramavailablepct', 'memoryavailable', 'ram available'],
            'diskusage': ['diskusagepct', 'storageusage', 'disk usage'],
            'crsrf': ['crsrf', 'crsrflevel', 'crsposrf', 'crsposrflevel', 'crs_rf', 'rf_power', 'rfpower', 'rf power', 'crs rf level', 'rf level cl', 'cl rf level'],
            'crsddm': ['crsddm', 'crsposddm', 'crs_ddm', 'ddm_course', 'ddmcourse', 'ddm course', 'ddm course line', 'ddm cl'],
            'crssdm': ['crssdm', 'crspossdm', 'crs_sdm', 'carrier_pwr', 'carrierpower', 'carrierpwr', 'carrier power', 'sdm course line', 'sdm cl'],
            'identam': ['identam', 'ident', 'ident_am', 'ident am', 'ident am cl', 'ident am ds', 'ident am clr', 'ident am depth cl'],
            'dsddm': ['dsddm', 'ds_ddm', 'ddm displacement', 'ddm ds', 'displacement ddm'],
            'dssdm': ['dssdm', 'ds_sdm', 'sdm displacement', 'sdm ds', 'displacement sdm'],
            'dsrf': ['dsrf', 'ds_rf', 'rf level ds', 'rf ds'],
            'widthrf': ['widthrf', 'crswidthrf', 'crswidthrflevel', 'width_rf', 'csb_power', 'csbpower', 'csb power', 'widthrflevel'],
            'widthddm': ['widthddm', 'crswidthddm', 'width_ddm', 'ddm_clr', 'ddmclr', 'ddm clr'],
            'widthsdm': ['widthsdm', 'crswidthsdm', 'width_sdm', 'sbo_power', 'sbopower', 'sbo power'],
            'clrrf': ['clrrf', 'clrwidthrf', 'clrwidthrflevel', 'clr_rf', 'clr_power', 'clrpower', 'clr power', 'rf level clr', 'rf clr'],
            'clrddm': ['clrddm', 'clrwidthddm', 'clr_ddm', 'ddm clearance', 'ddm clr'],
            'clrsdm': ['clrsdm', 'clrwidthsdm', 'clr_sdm', 'sdm clearance', 'sdm clr'],
            'rfdispcourse': ['rfdispcourse', 'rf_disp_course', 'course freq disp', 'course frequency displacement', 'rf disp course'],
            'rfdispclr': ['rfdispclr', 'rf_disp_clr', 'clearance freq disp', 'clr freq disp', 'rf disp clr'],
            'rfdispsep': ['rfdispsep', 'rf_disp_sep', 'separation freq disp', 'sep freq disp', 'rf disp sep'],
            'nfrf': ['nfrf', 'nearfieldrf', 'nearfieldposrf', 'nearfieldposrflevel', 'nf_rf', 'rf_out', 'rfout', 'rf out', 'nearfieldposrflevel'],
            'nfddm': ['nfddm', 'nearfieldddm', 'nearfieldposddm', 'nf_ddm', 'ddm_mon', 'ddmmon', 'ddm mon'],
            'nfsdm': ['nfsdm', 'nearfieldsdm', 'nearfieldpossdm', 'nf_sdm', 'mon_power', 'monpower', 'mon power'],
            'freqdev': ['freqdev', 'freqdeviation', 'frequencydeviation', 'freq_dev', 'frequency deviation', 'freq deviation'],
            'gpangle': ['gpangle', 'glidepathangle', 'gp_angle', 'gp angle']
        };

        const checkNameMatch = (targetStr, candStr, isExact) => {
            if (!targetStr || !candStr) return false;
            if (targetStr === candStr) return true;
            if (!isExact && targetStr.length >= 4 && candStr.length >= 4 && (targetStr.includes(candStr) || candStr.includes(targetStr))) return true;

            const canonTarget = targetStr.replace(/[^a-z0-9]/g, '');
            const canonCand = candStr.replace(/[^a-z0-9]/g, '');
            if (canonTarget && canonCand) {
                if (canonTarget === canonCand) return true;
                if (!isExact && canonTarget.length >= 4 && canonCand.length >= 4 && (canonTarget.includes(canonCand) || canonCand.includes(canonTarget))) return true;

                // Token match: '30hz am' <=> 'am 30hz'
                const targetTokens = targetStr.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(' ');
                const candTokens = candStr.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(' ');
                if (targetTokens && candTokens && targetTokens === candTokens) return true;

                // Alias check (bidirectional)
                for (const [key, aliases] of Object.entries(aliasMap)) {
                    const normKey = key.replace(/[^a-z0-9]/g, '');
                    const allVariants = [normKey, ...aliases.map(a => a.replace(/[^a-z0-9]/g, ''))];
                    const candMatches = allVariants.some(v => canonCand === v || (!isExact && v.length >= 4 && canonCand.length >= 4 && (canonCand.includes(v) || v.includes(canonCand))));
                    const targetMatches = allVariants.some(v => canonTarget === v || (!isExact && v.length >= 4 && canonTarget.length >= 4 && (canonTarget.includes(v) || v.includes(canonTarget))));
                    if (candMatches && targetMatches) {
                        return true;
                    }
                }
            }
            return false;
        };

        const matchesLabel = (limitItem) => {
            const limitName = normalizeLimitLabel(limitItem.name || limitItem.label || '');
            const limitSource = normalizeLimitLabel(limitItem.source || '');
            if (!limitName && !limitSource) return false;
            const isExact = limitItem.match_mode === 'exact';

            return checkNameMatch(cleanLabel, limitName, isExact) || checkNameMatch(cleanLabel, limitSource, isExact);
        };

        const matchesParser = (limitItem, targetParserId) => {
            if (!limitItem.target_parsers || limitItem.target_parsers.length === 0) return true; // Global / Generic fallback
            if (!targetParserId) return false;
            const parsers = Array.isArray(limitItem.target_parsers) ? limitItem.target_parsers : String(limitItem.target_parsers).split(',');
            return parsers.some(p => p.trim().toLowerCase() === String(targetParserId).trim().toLowerCase());
        };

        let targetSup = String(supCategory || '').toLowerCase();
        if (effectiveParserId === 'temp_humidity_modbus' && (!targetSup || targetSup === 'support' || targetSup === 'generic')) {
            targetSup = 'shelter';
        } else if ((effectiveParserId === 'dvor_maru_220' || effectiveParserId === 'dvor') && (!targetSup || targetSup === 'navigation' || targetSup === 'generic')) {
            targetSup = 'dvor';
        }

        // Cek jika ada aturan limitasi yang cocok namun berstatus NONAKTIF:
        // Jika nonaktif -> Langsung kembalikan putih (#ffffff)!
        const isExplicitlyInactive = window.limitationsCache.some(l => {
            if (l.is_active !== false && l.is_active !== 'false' && l.is_active !== 0 && l.is_active !== '0') return false;
            if (!matchesParser(l, effectiveParserId)) return false;
            const limitSups = (Array.isArray(l.sup_category) ? l.sup_category : String(l.sup_category || '').split(','))
                .map(s => s.trim().toLowerCase()).filter(Boolean);
            const isGenericSup = limitSups.length === 0 || limitSups.some(s => s === 'generic' || s === 'all' || s === '*');
            const matchesCategory = (!!targetSup && limitSups.includes(targetSup)) || isGenericSup;
            return matchesCategory && matchesLabel(l);
        });

        if (isExplicitlyInactive) {
            return '#ffffff';
        }

        const findLimit = () => {
            // 1. Prioritas Utama: Cocokkan rule yang secara eksplisit menargetkan parser ini (target_parsers)
            if (effectiveParserId) {
                const specificMatch = window.limitationsCache.find(l => {
                    if (l.is_active === false || l.is_active === 'false' || l.is_active === 0 || l.is_active === '0') return false;
                    if (!l.target_parsers || l.target_parsers.length === 0) return false;
                    return matchesParser(l, effectiveParserId) && matchesLabel(l);
                });
                if (specificMatch) return specificMatch;
            }

            // 2. Prioritas Kedua: Cocokkan rule berdasarkan sub-kategori spesifik alat (misal DVOR, DME, ILS-GP)
            if (targetSup) {
                const supMatch = window.limitationsCache.find(l => {
                    if (l.is_active === false || l.is_active === 'false' || l.is_active === 0 || l.is_active === '0') return false;
                    // Abaikan rule yang menargetkan parser lain
                    if (l.target_parsers && l.target_parsers.length > 0 && !matchesParser(l, effectiveParserId)) return false;
                    const limitSups = (Array.isArray(l.sup_category) ? l.sup_category : String(l.sup_category || '').split(','))
                        .map(s => s.trim().toLowerCase()).filter(Boolean);
                    return limitSups.includes(targetSup) && matchesLabel(l);
                });
                if (supMatch) return supMatch;
            }

            // 3. Prioritas Ketiga: Rule Generic / All (hanya jika rule tidak membatasi parser tertentu)
            return window.limitationsCache.find(l => {
                if (l.is_active === false || l.is_active === 'false' || l.is_active === 0 || l.is_active === '0') return false;
                if (l.target_parsers && l.target_parsers.length > 0 && !matchesParser(l, effectiveParserId)) return false;
                const limitSups = (Array.isArray(l.sup_category) ? l.sup_category : String(l.sup_category || '').split(','))
                    .map(s => s.trim().toLowerCase()).filter(Boolean);
                const isGenericSup = limitSups.length === 0 || limitSups.some(s => s === 'generic' || s === 'all' || s === '*');
                return isGenericSup && matchesLabel(l);
            });
        };

        const limit = findLimit();

        // JIKA TIDAK ADA ATURAN LIMITASI: SEMUANYA PUTIH!
        if (!limit) return '#ffffff';

        // JIKA ADA LIMITASI TIPE BOOLEAN, STATE, ATAU STRING:
        const isStateOrBool = limit.value_type === 'string' ||
            limit.value_type === 'boolean' ||
            limit.value_type === 'state' ||
            (limit.expected_value != null && limit.expected_value !== '') ||
            (limit.normal_value != null && limit.normal_value !== '') ||
            (limit.alarm_value != null && limit.alarm_value !== '') ||
            (limit.warning_value != null && limit.warning_value !== '');

        if (isStateOrBool) {
            const norm = String(limit.normal_value != null && limit.normal_value !== '' ? limit.normal_value : (limit.expected_value || '')).trim().toLowerCase();
            const warn = String(limit.warning_value || '').trim().toLowerCase();
            const alarm = String(limit.alarm_value || '').trim().toLowerCase();

            const actStr = String(value).trim().toLowerCase();
            const actBool = (value === true || actStr === 'true' || actStr === '1' || actStr === 'aktif' || actStr === 'on' || actStr === 'up');
            const actBoolFalse = (value === false || actStr === 'false' || actStr === '0' || actStr === 'tidak aktif' || actStr === 'off' || actStr === 'down');

            const matchesList = (patternStr) => {
                if (!patternStr) return false;
                const candidates = patternStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                return candidates.some(cand => {
                    if (cand === 'true' && actBool) return true;
                    if (cand === 'false' && actBoolFalse) return true;
                    if (cand === actStr) return true;
                    return actStr.includes(cand);
                });
            };

            if (alarm && matchesList(alarm)) return '#ff3355'; // Alarm (Merah)
            if (warn && matchesList(warn)) return '#ffcc00';   // Warning (Kuning)
            if (norm && matchesList(norm)) return '#00ff88';   // Normal (Hijau)
            return '#ffffff'; // Netral jika alarm / warning tidak diatur
        }

        const cleanValStr = String(value).replace(',', '.');
        const numVal = parseFloat(cleanValStr);
        if (isNaN(numVal)) return '#ffffff';

        const hasAlarm = (limit.min_alarm_limit != null && limit.min_alarm_limit !== '') ||
                         (limit.max_alarm_limit != null && limit.max_alarm_limit !== '') ||
                         (limit.alv != null && limit.alv !== '') ||
                         (limit.ahv != null && limit.ahv !== '');

        const hasWarn = (limit.min_warning_limit != null && limit.min_warning_limit !== '') ||
                        (limit.max_warning_limit != null && limit.max_warning_limit !== '') ||
                        (limit.wlv != null && limit.wlv !== '') ||
                        (limit.whv != null && limit.whv !== '');

        // JIKA TIDAK ADA BATAS ALARM ATAU WARNING YANG DIATUR: TETAP PUTIH!
        if (!hasAlarm && !hasWarn) return '#ffffff';

        const minAlarm = (limit.min_alarm_limit != null && limit.min_alarm_limit !== '') ? parseFloat(limit.min_alarm_limit) : ((limit.alv != null && limit.alv !== '') ? parseFloat(limit.alv) : -Infinity);
        const maxAlarm = (limit.max_alarm_limit != null && limit.max_alarm_limit !== '') ? parseFloat(limit.max_alarm_limit) : ((limit.ahv != null && limit.ahv !== '') ? parseFloat(limit.ahv) : Infinity);
        const minWarn = (limit.min_warning_limit != null && limit.min_warning_limit !== '') ? parseFloat(limit.min_warning_limit) : ((limit.wlv != null && limit.wlv !== '') ? parseFloat(limit.wlv) : minAlarm);
        const maxWarn = (limit.max_warning_limit != null && limit.max_warning_limit !== '') ? parseFloat(limit.max_warning_limit) : ((limit.whv != null && limit.whv !== '') ? parseFloat(limit.whv) : maxAlarm);

        if (numVal < minAlarm || numVal > maxAlarm) return '#ff3355'; // Alarm (Merah)
        if (numVal < minWarn || numVal > maxWarn) return '#ffcc00';   // Warning / Pre-Alarm (Kuning)
        return '#00ff88'; // Normal / Dalam batas aman pre-alarm (Hijau)
    }
    window.getLimitColor = getLimitColor;

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

        // Cache persistent untuk modal agar jika ada reconnect sesaat, telemetry tidak mendadak hilang jadi '-'
        if (!window._modalTelemetryLkgv) window._modalTelemetryLkgv = new Map();
        const isThalesIls = effParserId === 'ils_llz_thales421' || effParserId === 'ils_gp_thales421' ||
                            src?.parsing_id === 'ils_llz_thales421' || src?.parsing_id === 'ils_gp_thales421';
        const isIlsMophienSrc = !isThalesIls && (
                                effParserId === 'ils_mophien_llz' || effParserId === 'ils_mophien_gp' || effParserId === 'dme_mophien_tdme' ||
                                src?.parsing_id === 'ils_mophien_llz' || src?.parsing_id === 'ils_mophien_gp' || src?.parsing_id === 'dme_mophien_tdme' ||
                                (src?.name && (src.name.toLowerCase().includes('mophien') || src.name.toLowerCase().includes('juanda') || (src.name.toLowerCase().includes('localizer') && !src.name.toLowerCase().includes('thales')))) ||
                                (src?.ip_address && (String(src.ip_address).includes('10.62.3.20') || String(src.ip_address).includes('10.62.3.10') || String(src.ip_address).includes('10.62.3.30'))));
                         
        const modalCacheKey = src?.id || src?.ip_address || src?.name || 'ils_active';
        const hasValidLlzData = latestData && (latestData.cl_channel || latestData.ds_channel || latestData.system_params || latestData.pulse_params || latestData.station_ident || latestData.cl_ddm !== undefined);
        
        if (isIlsMophienSrc) {
            if (hasValidLlzData) {
                window._modalTelemetryLkgv.set(modalCacheKey, JSON.parse(JSON.stringify(latestData)));
            } else if (window._modalTelemetryLkgv.has(modalCacheKey)) {
                const cached = window._modalTelemetryLkgv.get(modalCacheKey);
                latestData = { ...cached, ...(latestData || {}) };
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

    let _isFetchingSourceDetail = false;
    async function refreshSourceDetailModal(src, forceRender = false) {
        if (!src || _isFetchingSourceDetail) return;

        _isFetchingSourceDetail = true;
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
        } finally {
            _isFetchingSourceDetail = false;
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
                fetch(`/api/otentication/${equipmentId}`).then(r => r.json()),
                fetch(`/api/equipment/${equipmentId}`, { headers: window.getAuthHeaders ? window.getAuthHeaders() : {} })
            ]);

            // Update equipmentDataCache dengan lastData terbaru
            if (dataRes.ok) {
                const eqData = await dataRes.json();
                updateEquipmentCacheEntry(eqData);
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
            // Start live periodic refresh for the open side panel (every 3 seconds)
            startSourcePanelLiveUpdates(equipmentId);
        } catch (e) {
            _sourceFetchMeta[equipmentId] = 0;
            if (immediateSources.length === 0) {
                body.innerHTML = `<div style="padding:20px;color:#ff3355">Gagal memuat sources: ${e.message}</div>`;
            }
        }
    }

    let _sourcePanelTimer = null;
    function stopSourcePanelLiveUpdates() {
        if (_sourcePanelTimer) {
            clearInterval(_sourcePanelTimer);
            _sourcePanelTimer = null;
        }
    }

    function startSourcePanelLiveUpdates(equipmentId) {
        stopSourcePanelLiveUpdates();
        _sourcePanelTimer = setInterval(async () => {
            const panel = document.getElementById('equipmentDetailPanel');
            const body = document.getElementById('detailPanelBody');
            if (!panel || !panel.classList.contains('open') || _selectedEqId !== equipmentId) {
                stopSourcePanelLiveUpdates();
                return;
            }

            try {
                const res = await fetch(`/api/equipment/${equipmentId}`, {
                    headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
                });
                if (res.ok) {
                    const eqData = await res.json();
                    updateEquipmentCacheEntry(eqData);
                    const sources = _sourcesCache[equipmentId] || getBestAvailableSources(equipmentId);
                    if (sources && sources.length > 0) {
                        renderSourcePanel(sources, body, equipmentId);
                    }
                }
            } catch (err) {}
        }, 3000);
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
                        const valColor = getLimitColor(eqSup, label, rawVal, effParserId);
                        const isAlarm = valColor === '#ff3355';
                        const isWarning = valColor === '#ffcc00';
                        const isNormalLimit = valColor === '#00ff88';
                        const labelColor = isAlarm ? '#ff3355' : isWarning ? '#ffcc00' : isNormalLimit ? '#00ff88' : 'inherit';
                        const badgeStyle = (isAlarm || isWarning || isNormalLimit)
                            ? `background: ${isAlarm ? 'rgba(255,51,85,0.12)' : isWarning ? 'rgba(255,204,0,0.12)' : 'rgba(0,255,136,0.08)'}; border: 1px solid ${isAlarm ? 'rgba(255,51,85,0.4)' : isWarning ? 'rgba(255,204,0,0.4)' : 'rgba(0,255,136,0.3)'}; border-radius: 4px; padding: 2px 5px;`
                            : '';

                        return `<div class="sp-card-preview-point" style="${badgeStyle}">
                                <span class="sp-preview-label" style="color:${labelColor};font-weight:${(isAlarm || isWarning || isNormalLimit) ? 'bold' : 'normal'}" title="${label}">${label}</span>
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
            if (statuses.length > 0 && statuses.every(st => st === 'alarm' || st === 'offline')) {
                eqCard.classList.add('has-alarm');
            } else if (statuses.length > 0 && statuses.every(st => st === 'disconnect')) {
                // Biarkan abu-abu
            } else if (statuses.includes('alarm') || statuses.includes('offline')) {
                eqCard.classList.add('has-alarm');
            } else if (statuses.includes('warning') || statuses.includes('disconnect')) {
                eqCard.classList.add('has-warning');
            }
        }
    }

    function getSourceStatus(src) {
        let rawStatus = 'Disconnect';
        let srcData = null;
        let eqSup = '';
        if (window.equipmentDataCache) {
            const eq = window.equipmentDataCache.find(e => String(e.id) === String(src.equipt_id));
            if (eq) {
                eqSup = eq.sup_category || '';
                if (eq.lastData) {
                    srcData = resolveSourceData(eq, src);
                    if (srcData) {
                        rawStatus = srcData._status || 'Normal';
                    } else {
                        // Fallback: try first available
                        const first = Object.values(eq.lastData)[0];
                        if (first) {
                            srcData = first;
                            rawStatus = first._status || 'Normal';
                        }
                    }
                }
            }
        }

        // Evaluasi limit secara dinamis langsung dari data parameter
        if (srcData && typeof srcData === 'object' && rawStatus !== 'Disconnect' && rawStatus !== 'Offline' && window.getLimitColor) {
            const effPid = resolveEffectiveParserId(src) || srcData._parsing_id || src.parsing_id;
            const hasBreach = Object.entries(srcData).some(([k, v]) => {
                if (k.startsWith('_') || v === null || v === undefined) return false;
                const c = window.getLimitColor(eqSup, k.replace(/_/g, ' '), v, effPid);
                return c === '#ff3355' || c === '#ffcc00';
            });
            if (hasBreach) {
                rawStatus = 'Warning';
            } else {
                rawStatus = 'Normal';
            }
        }

        // Aturan 1: Untuk data source, berapapun pembacaan nilainya (warning maupun alarm), status data source tetap Warning
        const norm = window.normalizeSourceStatus ? window.normalizeSourceStatus(rawStatus) : rawStatus;
        const normLower = String(norm || '').toLowerCase();
        if (normLower === 'alarm' || normLower === 'alert' || normLower === 'fail' || normLower === 'critical') {
            return 'Warning';
        }
        return norm;
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
        div.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:5000;align-items:center;justify-content:center;padding:16px;';
        div.innerHTML = `
            <div style="background:#091222;border:1px solid #1e293b;border-radius:14px;width:100%;max-width:920px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 25px 50px -12px rgba(0,0,0,0.7);overflow:hidden;">
                <!-- Header Modal -->
                <div style="display:flex;align-items:center;padding:14px 20px;border-bottom:1px solid #1e293b;gap:12px;background:rgba(15,23,42,0.75);">
                    <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
                        <i class="fas fa-server" style="color:#00d4ff;font-size:15px;flex-shrink:0;"></i>
                        <span id="srcDetailTitle" style="font-size:15px;font-weight:700;color:#00d4ff;letter-spacing:0.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
                    </div>
                    <div id="srcDetailStatus" style="display:flex;align-items:center;gap:8px;flex-shrink:0;"></div>
                    <button id="srcDetailCloseBtn"
                        style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;transition:all 0.15s ease;"
                        onmouseover="this.style.color='#ffffff';this.style.background='rgba(255,255,255,0.08)'"
                        onmouseout="this.style.color='#94a3b8';this.style.background='none'">✕</button>
                </div>
                <!-- Dynamic Group Body -->
                <div id="srcDetailBody" style="flex:1;overflow-y:auto;padding:18px 20px;background:#070d18;"></div>
            </div>`;
        div.addEventListener('click', e => { if (e.target === div) closeDetailModal(); });
        document.body.appendChild(div);
        const closeBtn = document.getElementById('srcDetailCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeDetailModal);
    }

    function showDetailModal(src, data, eqSup) {
        if (typeof loadLimitations === 'function') {
            loadLimitations().catch(() => {});
        }
        let modal = document.getElementById('dataSourceDetailModal');
        if (!modal) { createDetailModal(); modal = document.getElementById('dataSourceDetailModal'); }

        const titleText = (src.name || 'Equipment') + (src.ip_address ? ` — ${src.ip_address}` : '');
        document.getElementById('srcDetailTitle').textContent = titleText;

        let status = data ? (data._status || 'Normal') : 'Disconnect';
        if (!data || Object.keys(data).length === 0) {
            // Cek apakah ada data di cache LKGV sebelum memutuskan Disconnect
            const cacheKey = src?.id || src?.ip_address || src?.name;
            if (window._modalTelemetryLkgv && window._modalTelemetryLkgv.has(cacheKey)) {
                data = window._modalTelemetryLkgv.get(cacheKey);
                status = data._status || 'Normal';
            }
        }

        // Evaluasi apakah ada parameter di dalam data yang melanggar limit (Alarm / Warning):
        if (data && typeof data === 'object' && status !== 'Disconnect' && status !== 'Offline') {
            const hasBreach = Object.entries(data).some(([k, v]) => {
                if (k.startsWith('_') || v === null || v === undefined) return false;
                const c = getLimitColor(eqSup, k.replace(/_/g, ' '), v, src?.parsing_id);
                return c === '#ff3355' || c === '#ffcc00';
            });
            if (hasBreach) {
                status = 'Warning';
            } else {
                // Jika limitasi dinonaktifkan atau semua parameter normal, pastikan status kembali ke Normal (tidak stuck di Warning)
                status = 'Normal';
            }
        }

        const statusLower = String(status).toLowerCase();
        if (statusLower === 'alarm' || statusLower === 'alert' || statusLower === 'fail' || statusLower === 'critical') {
            status = 'Warning';
        }
        const statusColors = { Normal: '#00ff88', Alarm: '#ff3355', Offline: '#ff3355', Warning: '#ffcc00', Disconnect: '#3a5a7a' };

        let pingBadge = '';
        const pStatus = data ? data.ping_status : null;
        if (pStatus) {
            const pc = pStatus === 'Normal' ? '#00ff88' : '#ff3355';
            const icon = pStatus === 'Normal' ? '<i class="fas fa-network-wired"></i>' : '<i class="fas fa-plug-circle-xmark"></i>';
            pingBadge = `<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:4px;background:rgba(0,255,136,0.1);color:${pc};border:1px solid rgba(0,255,136,0.25);display:inline-flex;align-items:center;gap:5px;" title="Status Ping dari Server ke IP Perangkat">${icon} Ping: ${pStatus}</span>`;
        } else if (src && src.ip_address) {
            const badgeId = `ping_badge_${src.id}`;
            pingBadge = `<span id="${badgeId}" style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.06);color:#94a3b8;border:1px solid rgba(148,163,184,0.2);display:inline-flex;align-items:center;gap:5px;"><i class="fas fa-spinner fa-spin"></i> Ping...</span>`;
            
            fetch('/api/equipment/ping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
                body: JSON.stringify({ ip: src.ip_address })
            })
            .then(res => res.json())
            .then(res => {
                const badgeEl = document.getElementById(badgeId);
                if (!badgeEl) return;
                const isAlive = res.success || res.status === 'online';
                const pc = isAlive ? '#00ff88' : '#ff3355';
                const icon = isAlive ? '<i class="fas fa-network-wired"></i>' : '<i class="fas fa-plug-circle-xmark"></i>';
                badgeEl.style.background = isAlive ? 'rgba(0,255,136,0.1)' : 'rgba(255,51,85,0.1)';
                badgeEl.style.color = pc;
                badgeEl.style.borderColor = isAlive ? 'rgba(0,255,136,0.25)' : 'rgba(255,51,85,0.25)';
                badgeEl.innerHTML = `${icon} Ping: ${isAlive ? 'Normal' : 'Gagal'}`;
            })
            .catch(() => {});
        }

        document.getElementById('srcDetailStatus').innerHTML =
            pingBadge + `<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;background:${statusColors[status]}18;color:${statusColors[status]};border:1px solid ${statusColors[status]}40;letter-spacing:0.5px;">${status.toUpperCase()}</span>`;

        const modalContainer = modal.querySelector('div');
        const isTdme = src && (
            src.parsing_id === 'dme_mophien_tdme' ||
            (data && (data._parsing_id === 'dme_mophien_tdme' || data.equipment_type === 'TDME')) ||
            (src.name && src.name.toLowerCase().includes('tdme')) ||
            (src.ip_address && String(src.ip_address).includes('10.62.3.30'))
        );
        const isThalesOrNormac = (
            src?.parsing_id === 'ils_llz_thales421' || src?.parsing_id === 'ils_gp_thales421' ||
            src?.parsing_id === 'ils_llz_normac' || src?.parsing_id === 'ils_gp_normac' ||
            (data && (data._parsing_id === 'ils_llz_thales421' || data._parsing_id === 'ils_gp_thales421' ||
                      data._parsing_id === 'ils_llz_normac' || data._parsing_id === 'ils_gp_normac'))
        );
        const isIlsMophien = src && !isTdme && !isThalesOrNormac && (
            src.parsing_id === 'ils_mophien_llz' || src.parsing_id === 'ils_mophien_gp' ||
            (data && (data._parsing_id === 'ils_mophien_llz' || data._parsing_id === 'ils_mophien_gp')) ||
            (src.name && (src.name.toLowerCase().includes('mophien') || src.name.toLowerCase().includes('juanda') || (src.name.toLowerCase().includes('localizer') && !src.name.toLowerCase().includes('thales'))))
        );
        if (modalContainer) modalContainer.style.maxWidth = (isIlsMophien || isTdme) ? '960px' : '920px';
        const body = document.getElementById('srcDetailBody');
        if (body) {
            if (isTdme) {
                if (!window._modalTelemetryLkgv) window._modalTelemetryLkgv = new Map();
                const cacheKey = src?.id || src?.ip_address || src?.name || 'tdme_active';
                let renderData = data || {};
                const hasMetrics = renderData && (renderData.system_params || renderData.pulse_params || renderData.power_params || renderData.time_delay !== undefined);
                if (hasMetrics) {
                    window._modalTelemetryLkgv.set(cacheKey, JSON.parse(JSON.stringify(renderData)));
                } else if (window._modalTelemetryLkgv.has(cacheKey)) {
                    renderData = { ...window._modalTelemetryLkgv.get(cacheKey), ...(renderData || {}) };
                }
                body.innerHTML = renderDmeMophienTdmeDetail(renderData, src, eqSup);
            } else if (isIlsMophien) {
                // Gunakan cache LKGV jika data saat ini kosong atau null
                if (!window._modalTelemetryLkgv) window._modalTelemetryLkgv = new Map();
                const cacheKey = src?.id || src?.ip_address || src?.name || 'ils_active';
                let renderData = data || {};
                const hasMetrics = renderData && (renderData.cl_channel || renderData.ds_channel || renderData.station_ident || renderData.cl_ddm !== undefined);
                if (hasMetrics) {
                    window._modalTelemetryLkgv.set(cacheKey, JSON.parse(JSON.stringify(renderData)));
                } else if (window._modalTelemetryLkgv.has(cacheKey)) {
                    renderData = { ...window._modalTelemetryLkgv.get(cacheKey), ...(renderData || {}) };
                }
                body.innerHTML = renderIlsMophienLlzDetail(renderData, src, eqSup);
            } else {
                body.innerHTML = renderDetailData(src?.parsing_id || data?._parsing_id, data || {}, eqSup);
            }
        }

        modal.style.display = 'flex';
    }

    /**
     * Executive Monitor & Home View — ILS Localizer (LLZ) PMDT Juanda
     */
    function renderIlsMophienLlzDetail(data, src, supCategory) {
        data = data || {};

        const formatDec2 = (val, unit = '') => {
            if (val === null || val === undefined || isNaN(Number(val))) return '-';
            const num = Number(val);
            const formatted = num.toFixed(2);
            return unit ? `${formatted} ${unit}` : formatted;
        };

        const formatDec4 = (val, unit = '%') => {
            if (val === null || val === undefined || isNaN(Number(val))) return '-';
            const num = Number(val);
            const sign = num > 0 ? '+' : (num < 0 ? '-' : '±');
            const formatted = Math.abs(num).toFixed(4);
            return unit ? `${sign}${formatted} ${unit}` : `${sign}${formatted}`;
        };

        const ident = data.station_ident || '-';
        const activeCh = data.active_channel || '-';
        const freq = data.frequency || '-';
        const serviceStatus = (data.service_status || '-').toUpperCase();

        const tx1Text = data.tx1?.status_text || 'TX1: MAIN (ON ANT)';
        const tx2Text = data.tx2?.status_text || 'TX2: STANDBY (DUMMY LOAD)';

        // Extracted Channel Metrics from Parser (Tanpa fallback dummy)
        const mon1CL = {
            ddm: data.cl_channel?.mon1?.ddm ?? data.mon1_cl_ddm ?? data.cl_ddm ?? null,
            sdm: data.cl_channel?.mon1?.sdm ?? data.mon1_cl_sdm ?? data.cl_sdm ?? null,
            rf_level: data.cl_channel?.mon1?.rf_level ?? data.mon1_cl_rf_level ?? data.cl_rf_level ?? null,
            ident: data.cl_channel?.mon1?.ident ?? data.mon1_cl_ident_am ?? data.cl_ident_am ?? null
        };
        const mon2CL = {
            ddm: data.cl_channel?.mon2?.ddm ?? data.mon2_cl_ddm ?? null,
            sdm: data.cl_channel?.mon2?.sdm ?? data.mon2_cl_sdm ?? null,
            rf_level: data.cl_channel?.mon2?.rf_level ?? data.mon2_cl_rf_level ?? null,
            ident: data.cl_channel?.mon2?.ident ?? data.mon2_cl_ident_am ?? null
        };

        const mon1DS = {
            ddm: data.ds_channel?.mon1?.ddm ?? data.mon1_ds_ddm ?? data.ds_ddm ?? null,
            sdm: data.ds_channel?.mon1?.sdm ?? data.mon1_ds_sdm ?? data.ds_sdm ?? null,
            rf_level: data.ds_channel?.mon1?.rf_level ?? data.mon1_ds_rf_level ?? data.ds_rf_level ?? null,
            ident: data.ds_channel?.mon1?.ident ?? data.mon1_ds_ident_am ?? null
        };
        const mon2DS = {
            ddm: data.ds_channel?.mon2?.ddm ?? data.mon2_ds_ddm ?? null,
            sdm: data.ds_channel?.mon2?.sdm ?? data.mon2_ds_sdm ?? null,
            rf_level: data.ds_channel?.mon2?.rf_level ?? data.mon2_ds_rf_level ?? null,
            ident: data.ds_channel?.mon2?.ident ?? data.mon2_ds_ident_am ?? null
        };

        const mon1CLR = {
            ddm: data.clr_channel?.mon1?.ddm ?? data.mon1_clr_ddm ?? data.clr_ddm ?? null,
            sdm: data.clr_channel?.mon1?.sdm ?? data.mon1_clr_sdm ?? data.clr_sdm ?? null,
            rf_level: data.clr_channel?.mon1?.rf_level ?? data.mon1_clr_rf_level ?? data.clr_rf_level ?? null,
            ident: data.clr_channel?.mon1?.ident ?? data.mon1_clr_ident_am ?? null
        };
        const mon2CLR = {
            ddm: data.clr_channel?.mon2?.ddm ?? data.mon2_clr_ddm ?? null,
            sdm: data.clr_channel?.mon2?.sdm ?? data.mon2_clr_sdm ?? null,
            rf_level: data.clr_channel?.mon2?.rf_level ?? data.mon2_clr_rf_level ?? null,
            ident: data.clr_channel?.mon2?.ident ?? data.mon2_clr_ident_am ?? null
        };

        const mon1RF = data.rf_displacement?.mon1 || {
            course: data.mon1_rf_disp_course ?? null,
            clr: data.mon1_rf_disp_clr ?? null,
            separation: data.mon1_rf_disp_sep ?? null
        };
        const mon2RF = data.rf_displacement?.mon2 || {
            course: data.mon2_rf_disp_course ?? null,
            clr: data.mon2_rf_disp_clr ?? null,
            separation: data.mon2_rf_disp_sep ?? null
        };

        const isGp = data.equipment_type === 'GLIDE_PATH' ||
                     (src?.parsing_id && src.parsing_id.includes('gp')) ||
                     (src?.name && (src.name.toLowerCase().includes('glide') || src.name.toLowerCase().includes('gp')));

        const activeParser = isGp ? 'ils_mophien_gp' : 'ils_mophien_llz';
        const targetSup = supCategory || (isGp ? 'ILS-GP' : 'ILS-LLZ');
        currentActiveParserId = activeParser;
        window.currentDetailParserId = activeParser;

        const clTitle = isGp ? 'ON PATH (CL) CHANNEL' : 'COURSE LINE (CL) CHANNEL';
        const dsTitle = 'DISPLACEMENT SENSITIVITY (DS)';
        const clrTitle = 'CLEARANCE (CLR) CHANNEL';

        const renderParamRow = (label, rawVal, valStr, lookupKey = null) => {
            const queryLabel = lookupKey || label;
            const limColor = getLimitColor(targetSup, queryLabel, rawVal, activeParser);

            // Aturan Pewarnaan Dinamis:
            // - Jika parameter TIDAK memiliki konfigurasi limit pada database (unconfigured/null):
            //   Warna teks angka PUTIH (#ffffff), border kartu netral (border-slate-700 / #163252).
            // - Jika parameter MEMILIKI konfigurasi limit:
            //   Normal: Teks HIJAU (#00ff88 / text-emerald-400), border hijau lembut.
            //   Warning: Teks KUNING (#ffcc00 / text-amber-400), border kuning lembut.
            //   Alarm: Teks MERAH (#ff3355 / text-rose-400), border merah lembut.
            let textColor = '#ffffff';
            let rowBorder = '1px solid rgba(255,255,255,0.05)';
            let rowBg = 'transparent';

            if (limColor === '#ff3355') {
                textColor = '#ff3355'; // Alarm
                rowBorder = '1px solid rgba(255, 51, 85, 0.4)';
                rowBg = 'rgba(255, 51, 85, 0.08)';
            } else if (limColor === '#ffcc00') {
                textColor = '#ffcc00'; // Warning
                rowBorder = '1px solid rgba(255, 204, 0, 0.4)';
                rowBg = 'rgba(255, 204, 0, 0.08)';
            } else if (limColor === '#00ff88') {
                textColor = '#00ff88'; // Normal
                rowBorder = '1px solid rgba(0, 255, 136, 0.25)';
                rowBg = 'rgba(0, 255, 136, 0.04)';
            }

            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 8px; margin-bottom:2px; border-radius:4px; border-bottom:${rowBorder}; background:${rowBg}; transition:all 0.2s ease;">
                <span style="font-size:11px; color:#8baac8; font-weight:500;">${label}</span>
                <span style="font-size:13px; font-weight:700; font-family:'Roboto Mono',monospace,sans-serif; color:${textColor};">${valStr}</span>
            </div>
            `;
        };

        const renderChannelCard = (title, icon, mon1Obj, mon2Obj, chPrefix = 'cl') => {
            const isMon1Active = activeCh === 'MON1';
            const isMon2Active = activeCh === 'MON2';

            const lookupKeys = {
                ddm: chPrefix === 'cl' ? 'CRS DDM' : (chPrefix === 'ds' ? 'DS DDM' : 'CLR DDM'),
                sdm: chPrefix === 'cl' ? 'CRS SDM' : (chPrefix === 'ds' ? 'DS SDM' : 'CLR SDM'),
                rf_level: chPrefix === 'cl' ? 'CRS RF Level' : (chPrefix === 'ds' ? 'DS RF Level' : 'CLR RF Level'),
                ident: 'Ident AM'
            };

            return `
            <div style="background:#091627; border:1px solid #163252; border-radius:8px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 4px 16px rgba(0,0,0,0.3);">
                <!-- Card Header -->
                <div style="background:linear-gradient(90deg, #0c1e36, #0e2746); padding:10px 14px; font-size:11px; font-weight:bold; color:#00d4ff; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #163252;">
                    <span><i class="${icon}" style="margin-right:7px; color:#00d4ff;"></i> ${title}</span>
                    <span style="font-size:9px; color:#5a8aaa; letter-spacing:0.5px;">DUAL MONITOR</span>
                </div>
                
                <!-- 2 Columns MON1 vs MON2 -->
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:1px; background:#163252; flex:1;">
                    <!-- MON1 Column -->
                    <div style="background:#0a1728; padding:12px 14px; ${isMon1Active ? 'border-left:3px solid #00ff88;' : ''}">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dashed #1a3a5c;">
                            <span style="font-size:11px; font-weight:bold; color:${isMon1Active ? '#00ff88' : '#8baac8'}; letter-spacing:0.5px;">
                                ${isMon1Active ? '<i class="fas fa-check-circle" style="font-size:10px; margin-right:4px;"></i>' : ''}MON 1
                            </span>
                            ${isMon1Active ? '<span style="font-size:8px; font-weight:bold; background:rgba(0,255,136,0.15); color:#00ff88; border:1px solid rgba(0,255,136,0.4); padding:1px 6px; border-radius:3px; letter-spacing:0.5px;">ACTIVE</span>' : '<span style="font-size:8px; color:#4a7a9a;">STANDBY</span>'}
                        </div>
                        ${renderParamRow('DDM', mon1Obj.ddm, formatDec2(mon1Obj.ddm, '%'), lookupKeys.ddm)}
                        ${renderParamRow('SDM', mon1Obj.sdm, formatDec2(mon1Obj.sdm, '%'), lookupKeys.sdm)}
                        ${renderParamRow('RF Level', mon1Obj.rf_level, formatDec2(mon1Obj.rf_level, 'dB'), lookupKeys.rf_level)}
                        ${!isGp || mon1Obj.ident != null ? renderParamRow('Ident AM', mon1Obj.ident, formatDec2(mon1Obj.ident, '%'), lookupKeys.ident) : ''}
                    </div>

                    <!-- MON2 Column -->
                    <div style="background:#0a1728; padding:12px 14px; ${isMon2Active ? 'border-left:3px solid #00ff88;' : ''}">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dashed #1a3a5c;">
                            <span style="font-size:11px; font-weight:bold; color:${isMon2Active ? '#00ff88' : '#8baac8'}; letter-spacing:0.5px;">
                                ${isMon2Active ? '<i class="fas fa-check-circle" style="font-size:10px; margin-right:4px;"></i>' : ''}MON 2
                            </span>
                            ${isMon2Active ? '<span style="font-size:8px; font-weight:bold; background:rgba(0,255,136,0.15); color:#00ff88; border:1px solid rgba(0,255,136,0.4); padding:1px 6px; border-radius:3px; letter-spacing:0.5px;">ACTIVE</span>' : '<span style="font-size:8px; color:#4a7a9a;">STANDBY</span>'}
                        </div>
                        ${renderParamRow('DDM', mon2Obj.ddm, formatDec2(mon2Obj.ddm, '%'), lookupKeys.ddm)}
                        ${renderParamRow('SDM', mon2Obj.sdm, formatDec2(mon2Obj.sdm, '%'), lookupKeys.sdm)}
                        ${renderParamRow('RF Level', mon2Obj.rf_level, formatDec2(mon2Obj.rf_level, 'dB'), lookupKeys.rf_level)}
                        ${!isGp || mon2Obj.ident != null ? renderParamRow('Ident AM', mon2Obj.ident, formatDec2(mon2Obj.ident, '%'), lookupKeys.ident) : ''}
                    </div>
                </div>
            </div>
            `;
        };

        const renderRfDisplacementPanel = (rf1, rf2) => {
            const isMon1Active = activeCh === 'MON1';
            const isMon2Active = activeCh === 'MON2';

            return `
            <div style="background:#091627; border:1px solid #163252; border-radius:8px; overflow:hidden; margin-bottom:16px; box-shadow:0 4px 16px rgba(0,0,0,0.3);">
                <div style="background:linear-gradient(90deg, #0c1e36, #0e2746); padding:10px 14px; font-size:11px; font-weight:bold; color:#00d4ff; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #163252;">
                    <span><i class="fas fa-satellite" style="margin-right:7px; color:#00d4ff;"></i> RADIO FREQUENCY (RF) DISPLACEMENT</span>
                    <span style="font-size:9px; color:#5a8aaa; letter-spacing:0.5px;">PRECISION 4 DESIMAL</span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:1px; background:#163252;">
                    <!-- MON1 RF -->
                    <div style="background:#0a1728; padding:12px 16px; ${isMon1Active ? 'border-left:3px solid #00ff88;' : ''}">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dashed #1a3a5c;">
                            <span style="font-size:11px; font-weight:bold; color:${isMon1Active ? '#00ff88' : '#8baac8'};">
                                ${isMon1Active ? '<i class="fas fa-check-circle" style="font-size:10px; margin-right:4px;"></i>' : ''}MON 1 FREQUENCY DISPLACEMENT
                            </span>
                            ${isMon1Active ? '<span style="font-size:8px; font-weight:bold; background:rgba(0,255,136,0.15); color:#00ff88; padding:1px 6px; border-radius:3px;">ACTIVE</span>' : ''}
                        </div>
                        ${renderParamRow('Course Freq Disp', rf1.course, formatDec4(rf1.course, '%'), 'rf_disp_course')}
                        ${renderParamRow('Clearance Freq Disp', rf1.clr, formatDec4(rf1.clr, '%'), 'rf_disp_clr')}
                        ${renderParamRow('Separation Freq Disp', rf1.separation, formatDec4(rf1.separation, '%'), 'rf_disp_sep')}
                    </div>

                    <!-- MON2 RF -->
                    <div style="background:#0a1728; padding:12px 16px; ${isMon2Active ? 'border-left:3px solid #00ff88;' : ''}">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dashed #1a3a5c;">
                            <span style="font-size:11px; font-weight:bold; color:${isMon2Active ? '#00ff88' : '#8baac8'};">
                                ${isMon2Active ? '<i class="fas fa-check-circle" style="font-size:10px; margin-right:4px;"></i>' : ''}MON 2 FREQUENCY DISPLACEMENT
                            </span>
                            ${isMon2Active ? '<span style="font-size:8px; font-weight:bold; background:rgba(0,255,136,0.15); color:#00ff88; padding:1px 6px; border-radius:3px;">ACTIVE</span>' : ''}
                        </div>
                        ${renderParamRow('Course Freq Disp', rf2.course, formatDec4(rf2.course, '%'), 'rf_disp_course')}
                        ${renderParamRow('Clearance Freq Disp', rf2.clr, formatDec4(rf2.clr, '%'), 'rf_disp_clr')}
                        ${renderParamRow('Separation Freq Disp', rf2.separation, formatDec4(rf2.separation, '%'), 'rf_disp_sep')}
                    </div>
                </div>
            </div>
            `;
        };

        const rawRows = data._amv_txs_rows || [];
        let rawHtml = '';
        if (rawRows.length > 0) {
            rawHtml = `
            <div style="background:#091627; border:1px solid #163252; border-radius:8px; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,0.3);">
                <div style="background:linear-gradient(90deg, #0c1e36, #0e2746); padding:9px 14px; font-size:10px; font-weight:bold; color:#7a9eb8; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #163252;">
                    <span><i class="fas fa-list-ul" style="margin-right:6px"></i> REGISTER TELEMETRY PARAMETERS</span>
                    <span style="color:#00d4ff">${rawRows.length} PARAMETERS</span>
                </div>
                <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:6px; padding:12px;">
                    ${rawRows.map(r => `
                        <div style="background:#0c1d33; border:1px solid #163252; border-radius:5px; padding:6px 10px;">
                            <div style="font-size:9px; color:#5a8aaa; margin-bottom:2px;">${r[0]}</div>
                            <div style="font-size:12px; font-weight:bold; color:#e8f4ff; font-family:'Roboto Mono',monospace;">${r[1]}</div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        const isDisconnected = !data || data._status === 'Disconnect' || data._status === 'Offline' || data.connectivity === 'Disconnected';

        const isNormalService = serviceStatus === 'NORMAL' || serviceStatus === 'OK';
        const isWarnService = serviceStatus === 'WARNING' || serviceStatus === 'WARN';
        const isAlarmService = serviceStatus === 'ALARM' || serviceStatus === 'FAIL' || serviceStatus === 'ERROR';

        const serviceColor = isDisconnected ? '#3a5a7a' : (isAlarmService ? '#ff3355' : (isWarnService ? '#ffcc00' : '#00ff88'));
        const serviceBg = isDisconnected ? 'rgba(58,90,122,0.2)' : (isAlarmService ? 'rgba(255,51,85,0.15)' : (isWarnService ? 'rgba(255,204,0,0.15)' : 'rgba(0,255,136,0.15)'));
        const serviceBorder = isDisconnected ? 'rgba(58,90,122,0.4)' : (isAlarmService ? '#ff3355' : (isWarnService ? '#ffcc00' : '#00ff88'));

        const tx1Color = isDisconnected ? '#64748b' : '#00ff88';
        const tx1Bg = isDisconnected ? 'rgba(100,116,139,0.15)' : 'rgba(0,255,136,0.12)';
        const tx1Border = isDisconnected ? 'rgba(100,116,139,0.3)' : 'rgba(0,255,136,0.4)';

        const tx2Color = isDisconnected ? '#64748b' : '#ffcc00';
        const tx2Bg = isDisconnected ? 'rgba(100,116,139,0.15)' : 'rgba(255,204,0,0.12)';
        const tx2Border = isDisconnected ? 'rgba(100,116,139,0.3)' : 'rgba(255,204,0,0.4)';

        return `
        <div style="display:flex; flex-direction:column; gap:0;">
            <!-- 1. Header Status Bar (Top Panel: Grid 4 Kolom) -->
            <div style="background:#071322; border:1px solid #142a42; border-radius:8px; padding:12px 16px; margin-bottom:16px; display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; align-items:center; box-shadow:0 4px 14px rgba(0,0,0,0.3);">
                <!-- 1. Station IDENT -->
                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-broadcast-tower" style="color:#00d4ff; font-size:18px;"></i>
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Station IDENT</span>
                        <span style="font-size:15px; font-weight:800; color:#00d4ff; letter-spacing:1.5px; font-family:'Roboto Mono',monospace;">${ident}</span>
                    </div>
                </div>

                <!-- 2. Active Channel / Monitor -->
                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-desktop" style="color:#00ffcc; font-size:16px;"></i>
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Active Channel</span>
                        <div>
                            <span style="font-size:11px; font-weight:800; color:#00ffcc; background:rgba(0,255,204,0.15); border:1px solid rgba(0,255,204,0.35); padding:2px 8px; border-radius:4px; letter-spacing:1px;">${activeCh}</span>
                        </div>
                    </div>
                </div>

                <!-- 3. Service Status -->
                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-heartbeat" style="color:${serviceColor}; font-size:16px;"></i>
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Service Status</span>
                        <div>
                            <span style="font-size:11px; font-weight:800; color:${serviceColor}; background:${serviceBg}; border:1px solid ${serviceBorder}; padding:2px 8px; border-radius:4px; letter-spacing:0.5px;">
                                <i class="fas fa-circle" style="font-size:8px; margin-right:4px;"></i>${isDisconnected ? 'DISCONNECTED' : serviceStatus}
                            </span>
                        </div>
                    </div>
                </div>

                <!-- 4. Frequency & TX State -->
                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-wave-square" style="color:#a5b4fc; font-size:16px;"></i>
                    <div style="display:flex; flex-direction:column; min-width:0;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Frequency & TX State</span>
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            <span style="font-size:12px; font-weight:700; color:#ffffff; font-family:'Roboto Mono',monospace;">${freq}</span>
                            <span style="font-size:9px; font-weight:700; color:${tx1Color}; background:${tx1Bg}; border:1px solid ${tx1Border}; padding:1px 5px; border-radius:3px;" title="${tx1Text}">TX1</span>
                            <span style="font-size:9px; font-weight:700; color:${tx2Color}; background:${tx2Bg}; border:1px solid ${tx2Border}; padding:1px 5px; border-radius:3px;" title="${tx2Text}">TX2</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 2. Executive Monitor Layout (Tabel Perbandingan MON1 vs MON2) -->
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:14px; margin-bottom:16px;">
                <!-- A. CL / Path Channel -->
                ${renderChannelCard(clTitle, 'fas fa-arrows-alt-v', mon1CL, mon2CL, 'cl')}

                <!-- B. DS Channel (Displacement Sensitivity) -->
                ${renderChannelCard(dsTitle, 'fas fa-arrows-alt-h', mon1DS, mon2DS, 'ds')}

                <!-- C. CLR Channel (Clearance) -->
                ${renderChannelCard(clrTitle, 'fas fa-compass', mon1CLR, mon2CLR, 'clr')}
            </div>

            <!-- 3. Sub-panel Radio Frequency (RF Displacement) -->
            ${renderRfDisplacementPanel(mon1RF, mon2RF)}

            <!-- 4. Raw / Telemetry Parameters (Optional Inspection) -->
            ${rawHtml}
        </div>
        `;
    }

    function renderDmeMophienTdmeDetail(data, src, supCategory) {
        if (!data || Object.keys(data).length === 0) {
            return `
            <div style="text-align:center; padding:48px 20px; color:#4a7a9a;">
                <i class="fas fa-radar fa-3x" style="margin-bottom:14px; opacity:0.5; color:#00d4ff;"></i>
                <div style="font-size:14px; font-weight:bold; color:#8baac8; margin-bottom:6px;">Menunggu Data Telemetri T-DME...</div>
                <div style="font-size:11px; color:#4a7a9a;">Memverifikasi koneksi streaming port 38317...</div>
            </div>`;
        }

        const ident = data.station_ident || 'ISBY';
        const channel = data.dme_channel || '38X';
        const freq = data.frequency || '1062 / 1000 MHz';
        const serviceStatus = (data.service_status || 'NORMAL').toUpperCase();
        const activeCh = data.active_channel || 'DUAL';

        const sys1 = data.system_params?.mon1 || { time_delay: 50.00, reply_eff: 98, tx_rate: 911 };
        const sys2 = data.system_params?.mon2 || { time_delay: 50.00, reply_eff: 100, tx_rate: 909 };

        const pulse1 = data.pulse_params?.mon1 || { rise_time: 2.05, duration: 3.50, decay_time: 2.05, spacing: 12.03 };
        const pulse2 = data.pulse_params?.mon2 || { rise_time: 2.05, duration: 3.50, decay_time: 2.05, spacing: 12.05 };

        const power1 = data.power_params?.mon1 || { rf_disp: 0.0004, peak_power: 100, vswr: 1.09, effective_radiated: 0.1 };
        const power2 = data.power_params?.mon2 || { rf_disp: 0.0003, peak_power: 101, vswr: 1.09, effective_radiated: 0.1 };

        const targetSup = supCategory || 'DME';

        const renderParamRow = (label, rawVal, valStr, lookupKey = null) => {
            const queryLabel = lookupKey || label;
            const limColor = getLimitColor(targetSup, queryLabel, rawVal, 'dme_mophien_tdme');
            let textColor = '#ffffff';
            let borderColor = 'transparent';

            if (limColor === '#ff3355') {
                textColor = '#ff3355';
                borderColor = 'rgba(255,51,85,0.4)';
            } else if (limColor === '#ffcc00') {
                textColor = '#ffcc00';
                borderColor = 'rgba(255,204,0,0.4)';
            } else if (limColor === '#00ff88') {
                textColor = '#00ff88';
                borderColor = 'rgba(0,255,136,0.3)';
            }

            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 8px; margin-bottom:4px; background:#0c1a2c; border:1px solid ${borderColor}; border-radius:4px;">
                <span style="font-size:11px; color:#8baac8; font-weight:500;">${label}</span>
                <span style="font-size:13px; font-weight:700; font-family:'Roboto Mono',monospace,sans-serif; color:${textColor};">${valStr}</span>
            </div>
            `;
        };

        const renderDualCard = (title, icon, mon1Rows, mon2Rows) => {
            return `
            <div style="background:#091627; border:1px solid #163252; border-radius:8px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 4px 16px rgba(0,0,0,0.3);">
                <div style="background:linear-gradient(90deg, #0c1e36, #0e2746); padding:10px 14px; font-size:11px; font-weight:bold; color:#00d4ff; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #163252;">
                    <span><i class="${icon}" style="margin-right:7px; color:#00d4ff;"></i> ${title}</span>
                    <span style="font-size:9px; color:#5a8aaa; letter-spacing:0.5px;">DUAL MONITOR</span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:1px; background:#163252; flex:1;">
                    <!-- MON1 -->
                    <div style="background:#0a1728; padding:12px 14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dashed #1a3a5c;">
                            <span style="font-size:11px; font-weight:bold; color:#00ff88; letter-spacing:0.5px;">
                                <i class="fas fa-check-circle" style="font-size:10px; margin-right:4px;"></i>MON 1
                            </span>
                            <span style="font-size:8px; font-weight:bold; background:rgba(0,255,136,0.15); color:#00ff88; border:1px solid rgba(0,255,136,0.4); padding:1px 6px; border-radius:3px;">ACTIVE</span>
                        </div>
                        ${mon1Rows}
                    </div>

                    <!-- MON2 -->
                    <div style="background:#0a1728; padding:12px 14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dashed #1a3a5c;">
                            <span style="font-size:11px; font-weight:bold; color:#8baac8; letter-spacing:0.5px;">MON 2</span>
                            <span style="font-size:8px; color:#4a7a9a;">STANDBY</span>
                        </div>
                        ${mon2Rows}
                    </div>
                </div>
            </div>
            `;
        };

        const rawRows = data._amv_txs_rows || [];
        let rawHtml = '';
        if (rawRows.length > 0) {
            rawHtml = `
            <div style="background:#091627; border:1px solid #163252; border-radius:8px; overflow:hidden; margin-top:14px; box-shadow:0 4px 16px rgba(0,0,0,0.3);">
                <div style="background:linear-gradient(90deg, #0c1e36, #0e2746); padding:9px 14px; font-size:10px; font-weight:bold; color:#7a9eb8; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #163252;">
                    <span><i class="fas fa-list-ul" style="margin-right:6px"></i> REGISTER TELEMETRY PARAMETERS (T-DME)</span>
                    <span style="color:#00d4ff">${rawRows.length} PARAMETERS</span>
                </div>
                <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:6px; padding:12px;">
                    ${rawRows.map(r => `
                        <div style="background:#0c1d33; border:1px solid #163252; border-radius:5px; padding:6px 10px;">
                            <div style="font-size:9px; color:#5a8aaa; margin-bottom:2px;">${r[0]}</div>
                            <div style="font-size:12px; font-weight:bold; color:#e8f4ff; font-family:'Roboto Mono',monospace;">${r[1]}</div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        const fmtVal = (val, dec = 2, unit = '') => {
            if (val == null || isNaN(val)) return '—';
            return `${Number(val).toFixed(dec)}${unit ? ' ' + unit : ''}`;
        };

        return `
        <div style="display:flex; flex-direction:column; gap:0;">
            <!-- Top Status Bar -->
            <div style="background:#071322; border:1px solid #142a42; border-radius:8px; padding:12px 16px; margin-bottom:16px; display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; align-items:center; box-shadow:0 4px 14px rgba(0,0,0,0.3);">
                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-broadcast-tower" style="color:#00d4ff; font-size:18px;"></i>
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase;">Station IDENT / CH</span>
                        <span style="font-size:15px; font-weight:800; color:#00d4ff; letter-spacing:1.5px; font-family:'Roboto Mono',monospace;">${ident} (${channel})</span>
                    </div>
                </div>

                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-desktop" style="color:#00ffcc; font-size:16px;"></i>
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase;">Active Channel</span>
                        <div>
                            <span style="font-size:11px; font-weight:800; color:#00ffcc; background:rgba(0,255,204,0.15); border:1px solid rgba(0,255,204,0.35); padding:2px 8px; border-radius:4px;">${activeCh}</span>
                        </div>
                    </div>
                </div>

                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-heartbeat" style="color:#00ff88; font-size:16px;"></i>
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase;">Service Status</span>
                        <div>
                            <span style="font-size:11px; font-weight:800; color:#00ff88; background:rgba(0,255,136,0.15); border:1px solid #00ff88; padding:2px 8px; border-radius:4px;">
                                <i class="fas fa-circle" style="font-size:8px; margin-right:4px;"></i>${serviceStatus}
                            </span>
                        </div>
                    </div>
                </div>

                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-wave-square" style="color:#a5b4fc; font-size:16px;"></i>
                    <div style="display:flex; flex-direction:column; min-width:0;">
                        <span style="font-size:10px; color:#7a9eb8; font-weight:600; text-transform:uppercase;">TXP Status</span>
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            <span style="font-size:12px; font-weight:700; color:#ffffff; font-family:'Roboto Mono',monospace;">TXP1 (ANT)</span>
                            <span style="font-size:9px; font-weight:700; color:#00ff88; background:rgba(0,255,136,0.15); border:1px solid rgba(0,255,136,0.4); padding:1px 5px; border-radius:3px;">MAIN</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Executive Monitor 3 Panels -->
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:14px;">
                <!-- Card 1: System Parameters -->
                ${renderDualCard('SYSTEM PARAMETERS', 'fas fa-cogs', `
                    ${renderParamRow('Time Delay', sys1.time_delay, fmtVal(sys1.time_delay, 2, 'µs'), 'time_delay')}
                    ${renderParamRow('Reply Efficiency', sys1.reply_eff, fmtVal(sys1.reply_eff, 0, '%'), 'reply_efficiency')}
                    ${renderParamRow('Transmission Rate', sys1.tx_rate, fmtVal(sys1.tx_rate, 0, 'pp/s'), 'tx_rate')}
                `, `
                    ${renderParamRow('Time Delay', sys2.time_delay, fmtVal(sys2.time_delay, 2, 'µs'), 'time_delay')}
                    ${renderParamRow('Reply Efficiency', sys2.reply_eff, fmtVal(sys2.reply_eff, 0, '%'), 'reply_efficiency')}
                    ${renderParamRow('Transmission Rate', sys2.tx_rate, fmtVal(sys2.tx_rate, 0, 'pp/s'), 'tx_rate')}
                `)}

                <!-- Card 2: Pulse Shape and Spacing -->
                ${renderDualCard('PULSE SHAPE & SPACING', 'fas fa-chart-line', `
                    ${renderParamRow('Pulse Rise Time', pulse1.rise_time, fmtVal(pulse1.rise_time, 2, 'µs'), 'pulse_rise_time')}
                    ${renderParamRow('Pulse Duration', pulse1.duration, fmtVal(pulse1.duration, 2, 'µs'), 'pulse_duration')}
                    ${renderParamRow('Pulse Decay Time', pulse1.decay_time, fmtVal(pulse1.decay_time, 2, 'µs'), 'pulse_decay_time')}
                    ${renderParamRow('Pulse Spacing', pulse1.spacing, fmtVal(pulse1.spacing, 2, 'µs'), 'pulse_spacing')}
                `, `
                    ${renderParamRow('Pulse Rise Time', pulse2.rise_time, fmtVal(pulse2.rise_time, 2, 'µs'), 'pulse_rise_time')}
                    ${renderParamRow('Pulse Duration', pulse2.duration, fmtVal(pulse2.duration, 2, 'µs'), 'pulse_duration')}
                    ${renderParamRow('Pulse Decay Time', pulse2.decay_time, fmtVal(pulse2.decay_time, 2, 'µs'), 'pulse_decay_time')}
                    ${renderParamRow('Pulse Spacing', pulse2.spacing, fmtVal(pulse2.spacing, 2, 'µs'), 'pulse_spacing')}
                `)}

                <!-- Card 3: Frequency and Power -->
                ${renderDualCard('FREQUENCY & POWER', 'fas fa-bolt', `
                    ${renderParamRow('Radio Frequency', power1.rf_disp, power1.rf_disp != null ? `${power1.rf_disp >= 0 ? '+' : ''}${Number(power1.rf_disp).toFixed(4)} %` : '—', 'rf_disp')}
                    ${renderParamRow('Peak Power Output', power1.peak_power, fmtVal(power1.peak_power, 0, 'W'), 'peak_power')}
                    ${renderParamRow('Antenna VSWR', power1.vswr, power1.vswr != null ? `${Number(power1.vswr).toFixed(2)} : 1` : '—', 'vswr')}
                    ${renderParamRow('Effective Radiated', power1.effective_radiated, fmtVal(power1.effective_radiated, 1, 'dB'), 'effective_radiated')}
                `, `
                    ${renderParamRow('Radio Frequency', power2.rf_disp, power2.rf_disp != null ? `${power2.rf_disp >= 0 ? '+' : ''}${Number(power2.rf_disp).toFixed(4)} %` : '—', 'rf_disp')}
                    ${renderParamRow('Peak Power Output', power2.peak_power, fmtVal(power2.peak_power, 0, 'W'), 'peak_power')}
                    ${renderParamRow('Antenna VSWR', power2.vswr, power2.vswr != null ? `${Number(power2.vswr).toFixed(2)} : 1` : '—', 'vswr')}
                    ${renderParamRow('Effective Radiated', power2.effective_radiated, fmtVal(power2.effective_radiated, 1, 'dB'), 'effective_radiated')}
                `)}
            </div>

            <!-- Register Telemetry Table -->
            ${rawHtml}
        </div>
        `;
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
                    <span style="font-size:10px;font-weight:bold;padding:2px 8px;border-radius:4px;background:${sc}22;color:${sc};border:1px solid ${sc};">${status}</span>
                    <span style="font-size:9px;color:#3a6a8a;">${loggedAt}</span>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;padding:10px 12px;background:#080f1e;">
                    ${params.map(([label, key]) => {
                const val = rd[key];
                const display = (val === null || val === undefined || val === '-' || val === '—') ? '—' : val;
                const limColor = getLimitColor(supCategory || 'VHF', label, val, 'vhf_t6tv');
                let finalColor = '#ffffff';
                let isAlarm = false;
                let isWarning = false;
                let isNormalLimit = false;

                if (limColor === '#ff3355') {
                    finalColor = '#ff3355';
                    isAlarm = true;
                } else if (limColor === '#ffcc00') {
                    finalColor = '#ffcc00';
                    isWarning = true;
                } else if (limColor === '#00ff88') {
                    finalColor = '#00ff88';
                    isNormalLimit = true;
                }

                const labelColor = isAlarm ? '#ff3355' : isWarning ? '#ffcc00' : isNormalLimit ? '#00ff88' : '#7a9eb8';
                const cardBorder = isAlarm
                    ? '1px solid rgba(255, 51, 85, 0.5)'
                    : isWarning
                        ? '1px solid rgba(255, 204, 0, 0.5)'
                        : isNormalLimit
                            ? '1px solid rgba(0, 255, 136, 0.35)'
                            : '1px solid #0d2a45';
                const cardBg = isAlarm
                    ? 'rgba(255, 51, 85, 0.1)'
                    : isWarning
                        ? 'rgba(255, 204, 0, 0.1)'
                        : isNormalLimit
                            ? 'rgba(0, 255, 136, 0.06)'
                            : '#0f1e35';

                return `<div style="background:${cardBg};border:${cardBorder};border-radius:5px;padding:8px 10px;transition:all 0.2s ease;">
                            <div style="font-size:9px;color:${labelColor};letter-spacing:1px;margin-bottom:3px;font-weight:${(isAlarm || isWarning || isNormalLimit) ? 'bold' : 'normal'};">${label}</div>
                            <div style="font-size:13px;font-weight:bold;color:${finalColor};">${display}</div>
                        </div>`;
            }).join('')}
                </div>
            </div>`;
        }).join('');
    }

    /**
     * Universal Equipment Modal: Adaptive Responsive Dynamic Grouped Grid
     * Mendukung data bertingkat/nested groups (UTAMA, VOLTAGE, CURRENT, dll.)
     * serta flat telemetry dengan evaluasi limitasi Smart dan penanganan unit otomatis.
     */
    function renderUniversalEquipmentModal(data, src, supCategory) {
        data = data || {};
        const parserId = src ? src.parsing_id : (data._parsing_id || null);
        const effectiveParserId = parserId || currentActiveParserId || window.currentDetailParserId || null;
        const targetSup = supCategory || (src && (src.category || src.sup_category)) || '';
        // Daftar key atau properti internal/array yang TIDAK boleh masuk ke grid kartu utama
        const IGNORED_ROOT_KEYS = new Set([
            'raw', 'timestamp', 'triggeredparams', 'alarms', 'warnings', 
            '_amv_txs_rows', '_amv_rxs_rows', '_bit_esc_rows', '_radio_rows',
            'temperature_sensors'
        ]);

        // 1. Ekstrak grup bertingkat dan flat items secara adaptif
        const groups = {};
        const flatItems = {};

        // Cari template (jika ada) untuk urutan/label parameter
        const tmpl = window.templatesCache?.find(t => t.id === effectiveParserId);
        const tmplParams = tmpl?.parameters || [];

        // Helper untuk ekstrak unit bawaan
        const getUnitFor = (key, parentGroupObj = null) => {
            if (parentGroupObj && parentGroupObj[`${key}_unit`]) return parentGroupObj[`${key}_unit`];
            if (data[`${key}_unit`]) return data[`${key}_unit`];
            const p = tmplParams.find(tp => (tp.name === key || tp.label === key));
            return p?.unit || '';
        };

        // Kumpulkan keys yang sudah masuk ke dalam salah satu nested group
        const groupedParamKeys = new Set();
        Object.entries(data).forEach(([key, val]) => {
            if (typeof val === 'object' && val !== null && !Array.isArray(val) && !key.startsWith('_')) {
                Object.keys(val).forEach(k => groupedParamKeys.add(k));
            }
        });

        // Iterasi properti data
        Object.entries(data).forEach(([key, val]) => {
            const lowerK = key.toLowerCase();
            if (key.startsWith('_') || key.endsWith('_unit') || IGNORED_ROOT_KEYS.has(lowerK) || isMetricPlaceholder(val)) return;

            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                // Nested Object -> Grup
                const subItems = {};
                Object.entries(val).forEach(([subK, subV]) => {
                    const subLower = subK.toLowerCase();
                    if (subK.startsWith('_') || subK.endsWith('_unit') || IGNORED_ROOT_KEYS.has(subLower) || Array.isArray(subV) || isMetricPlaceholder(subV)) return;
                    
                    // Support 2-level nesting (misal: cl_channel.mon1.ddm => Mon1 Ddm)
                    if (typeof subV === 'object' && subV !== null && !Array.isArray(subV)) {
                        Object.entries(subV).forEach(([deepK, deepV]) => {
                            if (!deepK.startsWith('_') && !Array.isArray(deepV) && !isMetricPlaceholder(deepV)) {
                                subItems[`${subK}_${deepK}`] = deepV;
                            }
                        });
                    } else {
                        subItems[subK] = subV;
                    }
                });
                if (Object.keys(subItems).length > 0) {
                    groups[key] = { items: subItems, rawGroup: val };
                }
            } else {
                // Abaikan flat item jika key tersebut sudah dimasukkan ke salah satu nested group
                if (!groupedParamKeys.has(key)) {
                    flatItems[key] = val;
                }
            }
        });

        // Kumpulkan parameter flat tanpa grup ke dalam grup default jika ada
        if (Object.keys(flatItems).length > 0) {
            groups['TELEMETRY / PARAMETER'] = { items: flatItems, rawGroup: data };
        }

        // JIKA TIDAK ADA DATA (Disconnected / Offline / Belum ada paket)
        // Tetap tampilkan block group & parameter dengan nilai '—' berdasarkan template atau parser
        if (Object.keys(groups).length === 0) {
            if (effectiveParserId === 'ils_mophien_llz' || effectiveParserId === 'ils_mophien_gp') {
                const isGpOffline = effectiveParserId === 'ils_mophien_gp';
                groups[isGpOffline ? 'ON PATH (CL) CHANNEL' : 'CL CHANNEL (COURSE LINE)'] = {
                    items: {
                        'MON1 DDM': '—', 'MON2 DDM': '—',
                        'MON1 SDM': '—', 'MON2 SDM': '—',
                        'MON1 RF LEVEL': '—', 'MON2 RF LEVEL': '—'
                    },
                    rawGroup: {}
                };
                if (!isGpOffline) {
                    groups['CL CHANNEL (COURSE LINE)'].items['MON1 IDENT AM'] = '—';
                    groups['CL CHANNEL (COURSE LINE)'].items['MON2 IDENT AM'] = '—';
                }
                groups['DS CHANNEL (DISPLACEMENT)'] = {
                    items: {
                        'MON1 DDM': '—', 'MON2 DDM': '—',
                        'MON1 SDM': '—', 'MON2 SDM': '—',
                        'MON1 RF LEVEL': '—', 'MON2 RF LEVEL': '—',
                        'MON1 IDENT AM': '—', 'MON2 IDENT AM': '—'
                    },
                    rawGroup: {}
                };
                groups['CLR CHANNEL (CLEARANCE)'] = {
                    items: {
                        'MON1 DDM': '—', 'MON2 DDM': '—',
                        'MON1 SDM': '—', 'MON2 SDM': '—',
                        'MON1 RF LEVEL': '—', 'MON2 RF LEVEL': '—',
                        'MON1 IDENT AM': '—', 'MON2 IDENT AM': '—'
                    },
                    rawGroup: {}
                };
                groups['RF DISPLACEMENT'] = {
                    items: {
                        'MON1 COURSE': '—', 'MON2 COURSE': '—',
                        'MON1 CLR': '—', 'MON2 CLR': '—',
                        'MON1 SEPARATION': '—', 'MON2 SEPARATION': '—'
                    },
                    rawGroup: {}
                };
                groups['SYSTEM STATUS'] = {
                    items: {
                        'STATION IDENT': '—',
                        'ACTIVE CHANNEL': '—',
                        'FREQUENCY': '—',
                        'SERVICE STATUS': '—'
                    },
                    rawGroup: {}
                };
            } else if (tmplParams.length > 0) {
                const placeholderItems = {};
                tmplParams.forEach(p => {
                    const label = p.label || p.name;
                    placeholderItems[label] = '—';
                });
                groups[tmpl?.name ? tmpl.name.toUpperCase() : 'TELEMETRY PARAMETERS'] = {
                    items: placeholderItems,
                    rawGroup: {}
                };
            }
        }

        // Jika benar-benar tidak ada template maupun konfigurasi fallback
        if (Object.keys(groups).length === 0) {
            return `
            <div style="text-align:center;padding:40px 20px;color:#64748b;">
                <i class="fas fa-inbox fa-3x" style="margin-bottom:12px;color:#334155;"></i>
                <p style="font-size:13px;font-weight:500;">Tidak ada parameter telemetri yang dapat ditampilkan.</p>
            </div>`;
        }

        // 2. Render Kartu Parameter Universal
        const renderCard = (key, val, parentGroupObj = null) => {
            const unit = getUnitFor(key, parentGroupObj);
            const labelText = key.replace(/_/g, ' ').trim();

            // Evaluasi warna limitasi secara dinamis dari database Smart (limitation_config.json)
            const limColor = getLimitColor(targetSup, labelText, val, effectiveParserId);

            let status = 'unconfigured'; // Default No Limit (#ffffff)
            if (limColor === '#ff3355') status = 'alarm';
            else if (limColor === '#ffcc00') status = 'warning';
            else if (limColor === '#00ff88') status = 'normal';

            // Styling Dark Theme elegan berbasis slate/cyan/emerald/amber/rose
            let cardBg = 'rgba(15, 23, 42, 0.6)';
            let cardBorder = '1px solid rgba(30, 41, 59, 0.8)';
            let valueColor = '#ffffff';
            let labelColor = '#94a3b8';
            let badgeHtml = '';
            let extraClass = '';

            if (status === 'unconfigured') {
                // UNCONFIGURED / NO LIMIT: Putih murni, border abu-abu gelap netral + badge No Limit
                valueColor = '#ffffff';
                cardBorder = '1px solid #1e293b';
                cardBg = 'rgba(15, 23, 42, 0.65)';
                badgeHtml = `<span style="font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;background:rgba(30, 41, 59, 0.8);color:#64748b;border:1px solid rgba(51, 65, 85, 0.6);letter-spacing:0.3px;flex-shrink:0;">No Limit</span>`;
            } else if (status === 'normal') {
                // NORMAL: Hijau Emerald, border hijau lembut
                valueColor = '#34d399'; // text-emerald-400
                cardBorder = '1px solid rgba(16, 185, 129, 0.4)';
                cardBg = 'rgba(6, 78, 59, 0.2)';
                labelColor = '#6ee7b7';
                badgeHtml = `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(16, 185, 129, 0.15);color:#34d399;border:1px solid rgba(16, 185, 129, 0.3);letter-spacing:0.3px;flex-shrink:0;">NORMAL</span>`;
            } else if (status === 'warning') {
                // WARNING: Kuning Amber, border kuning redup
                valueColor = '#fbbf24'; // text-amber-400
                cardBorder = '1px solid rgba(245, 158, 11, 0.5)';
                cardBg = 'rgba(120, 53, 15, 0.25)';
                labelColor = '#fcd34d';
                badgeHtml = `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(245, 158, 11, 0.2);color:#fbbf24;border:1px solid rgba(245, 158, 11, 0.4);letter-spacing:0.3px;flex-shrink:0;">WARNING</span>`;
            } else if (status === 'alarm') {
                // ALARM: Merah Rose, border merah tegas dengan subtle glow
                valueColor = '#fb7185'; // text-rose-400
                cardBorder = '1px solid rgba(244, 63, 94, 0.6)';
                cardBg = 'rgba(136, 19, 55, 0.25)';
                labelColor = '#fda4af';
                extraClass = 'univ-card-alarm';
                badgeHtml = `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(244, 63, 94, 0.25);color:#fb7185;border:1px solid rgba(244, 63, 94, 0.5);letter-spacing:0.3px;flex-shrink:0;">ALARM</span>`;
            }

            // Nilai tampil & satuan
            let valDisplay = (val !== null && val !== undefined && val !== '') ? String(val) : '—';
            if (valDisplay !== '—' && unit) {
                valDisplay = `${valDisplay} <span style="font-size:12px;font-weight:500;color:#94a3b8;margin-left:2px;">${unit}</span>`;
            }

            return `
            <div class="${extraClass}" style="background:${cardBg};border:${cardBorder};border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;justify-content:space-between;min-height:68px;box-sizing:border-box;transition:all 0.15s ease;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;">
                    <span style="font-size:10px;text-transform:uppercase;font-weight:600;color:${labelColor};letter-spacing:0.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${labelText}">${labelText}</span>
                    ${badgeHtml}
                </div>
                <div style="font-size:15px;font-weight:700;font-family:'Roboto Mono',monospace,sans-serif;color:${valueColor};letter-spacing:-0.3px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${valDisplay}
                </div>
            </div>`;
        };

        // 3. Render Setiap Section Group
        return Object.entries(groups).map(([groupName, groupData]) => {
            const cleanGroupName = groupName.replace(/_/g, ' ').toUpperCase();
            const items = groupData.items || {};

            return `
            <div style="margin-bottom:18px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid rgba(30, 41, 59, 0.8);">
                    <span style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#06b6d4;display:inline-flex;align-items:center;gap:6px;">
                        <i class="fas fa-layer-group" style="font-size:10px;color:#0891b2;"></i> ${cleanGroupName}
                    </span>
                    <span style="font-size:9px;color:#64748b;font-weight:600;">${Object.keys(items).length} PARAMETER</span>
                </div>
                <div class="univ-grid-container">
                    ${Object.entries(items).map(([k, v]) => renderCard(k, v, groupData.rawGroup)).join('')}
                </div>
            </div>`;
        }).join('');
    }

    function renderDetailData(parserId, data, supCategory) {
        currentActiveParserId = parserId;
        window.currentDetailParserId = parserId;
        const sections = getDetailSections(parserId, data, supCategory);
        if (!sections || sections.length === 0) {
            return renderUniversalEquipmentModal(data, { parsing_id: parserId }, supCategory);
        }
        return sections.map(sec => `
            <div style="margin-bottom:18px">
                <div style="font-size:11px;font-weight:700;color:#00d4ff;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.08);">${sec.title}</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px">
                    ${sec.params.map(([label, val, cls]) => {
                        let limColor = getLimitColor(supCategory, label, val, parserId);
                        if (sec.title === 'Connection Error') {
                            limColor = cls || '#ff3355';
                        }

                        let finalColor = '#ffffff';
                        let isAlarm = false;
                        let isWarning = false;
                        let isNormalLimit = false;

                        if (limColor === '#ff3355') {
                            finalColor = '#ff3355';
                            isAlarm = true;
                        } else if (limColor === '#ffcc00') {
                            finalColor = '#ffcc00';
                            isWarning = true;
                        } else if (limColor === '#00ff88') {
                            finalColor = '#00ff88';
                            isNormalLimit = true;
                        }

                        const labelColor = isAlarm ? '#ff3355' : isWarning ? '#ffcc00' : isNormalLimit ? '#00ff88' : '#7a9eb8';
                        const cardBorder = isAlarm 
                            ? '1px solid rgba(255, 51, 85, 0.5)' 
                            : isWarning 
                            ? '1px solid rgba(255, 204, 0, 0.5)' 
                            : isNormalLimit 
                            ? '1px solid rgba(0, 255, 136, 0.35)' 
                            : '1px solid #0d2a45';
                        const cardBg = isAlarm 
                            ? 'rgba(255, 51, 85, 0.1)' 
                            : isWarning 
                            ? 'rgba(255, 204, 0, 0.1)' 
                            : isNormalLimit 
                            ? 'rgba(0, 255, 136, 0.06)' 
                            : '#0f1e35';

                        const displayVal = (val === null || val === undefined || val === '' || val === '-' || val === '—') ? '—' : val;

                        return `
                        <div style="background:${cardBg};border:${cardBorder};border-radius:6px;padding:9px 12px;transition:all 0.2s ease;min-width:0;">
                            <div style="font-size:10px;color:${labelColor};letter-spacing:0.5px;margin-bottom:4px;font-weight:${(isAlarm || isWarning || isNormalLimit) ? '700' : '500'};overflow-wrap:anywhere;">${label}</div>
                            <div style="font-size:13px;font-weight:700;color:${finalColor};overflow-wrap:anywhere;">${displayVal}</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>`).join('');
    }

    function getDetailSections(parserId, data, supCategory) {
        currentActiveParserId = parserId;
        window.currentDetailParserId = parserId;
        const sections = [];

        // Global Error Handling: if data has error (e.g. disconnected)
        if (data && data.error) {
            sections.push({
                title: 'Connection Error',
                params: [
                    ['Status', 'Disconnect', '#ff3355'],
                    ['Detail', data.error, '#ffcc00']
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
                    ['Carrier Freq (MHz)', unflattenedData.mon1?.carrier_freq, '#e8f4ff'],
                    ['USB Freq (MHz)', unflattenedData.mon1?.usb_freq, '#e8f4ff'],
                    ['LSB Freq (MHz)', unflattenedData.mon1?.lsb_freq, '#e8f4ff'],
                    ['Ident', unflattenedData.mon1?.ident, '#00d4ff'],
                    ['TSG 30Hz', unflattenedData.mon1?.tsg_30hz, '#e8f4ff'],
                    ['TSG Azimuth', unflattenedData.mon1?.tsg_azimuth, '#e8f4ff'],
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
                    ['Carrier Freq (MHz)', unflattenedData.mon2?.carrier_freq, '#e8f4ff'],
                    ['USB Freq (MHz)', unflattenedData.mon2?.usb_freq, '#e8f4ff'],
                    ['LSB Freq (MHz)', unflattenedData.mon2?.lsb_freq, '#e8f4ff'],
                    ['Ident', unflattenedData.mon2?.ident, '#00d4ff'],
                ]
            });
            // Transmitter
            sections.push({
                title: 'TRANSMITTER', params: [
                    ['TX Active', unflattenedData.tx_active ? 'TX' + unflattenedData.tx_active : '—', '#00ffcc'],
                    ['TX1 Carrier (W)', unflattenedData.tx1?.carrier_power, '#e8f4ff'],
                    ['TX1 USB Sin', unflattenedData.tx1?.usb_sin, '#e8f4ff'],
                    ['TX1 USB Cos', unflattenedData.tx1?.usb_cos, '#e8f4ff'],
                    ['TX1 LSB Sin', unflattenedData.tx1?.lsb_sin, '#e8f4ff'],
                    ['TX1 LSB Cos', unflattenedData.tx1?.lsb_cos, '#e8f4ff'],
                    ['TX1 Az Offset', unflattenedData.tx1?.az_offset, '#e8f4ff'],
                    ['TX1 AM 30Hz', unflattenedData.tx1?.am_30hz, '#e8f4ff'],
                    ['TX1 AM 1020Hz', unflattenedData.tx1?.am_1020hz, '#e8f4ff'],
                    ['TX1 Phase Offset', unflattenedData.tx1?.phase_offset, '#e8f4ff'],
                    ['TX1 CPA Temp (°C)', unflattenedData.tx1?.cpa_temp, '#e8f4ff'],
                    ['TX1 MSG Temp (°C)', unflattenedData.tx1?.msg_temp, '#e8f4ff'],
                    ['TX1 Ident', unflattenedData.tx1?.ident, '#00d4ff'],
                    ['TX2 Carrier (W)', unflattenedData.tx2?.carrier_power, '#e8f4ff'],
                    ['TX2 USB Sin', unflattenedData.tx2?.usb_sin, '#e8f4ff'],
                    ['TX2 USB Cos', unflattenedData.tx2?.usb_cos, '#e8f4ff'],
                    ['TX2 LSB Sin', unflattenedData.tx2?.lsb_sin, '#e8f4ff'],
                    ['TX2 LSB Cos', unflattenedData.tx2?.lsb_cos, '#e8f4ff'],
                    ['TX2 Az Offset', unflattenedData.tx2?.az_offset, '#e8f4ff'],
                    ['TX2 AM 30Hz', unflattenedData.tx2?.am_30hz, '#e8f4ff'],
                    ['TX2 AM 1020Hz', unflattenedData.tx2?.am_1020hz, '#e8f4ff'],
                    ['TX2 Phase Offset', unflattenedData.tx2?.phase_offset, '#e8f4ff'],
                    ['TX2 CPA Temp (°C)', unflattenedData.tx2?.cpa_temp, '#e8f4ff'],
                    ['TX2 MSG Temp (°C)', unflattenedData.tx2?.msg_temp, '#e8f4ff'],
                    ['TX2 Ident', unflattenedData.tx2?.ident, '#00d4ff'],
                ]
            });

            // LCU
            sections.push({
                title: 'LCU — POWER SUPPLY', params: [
                    ['DC +5V', unflattenedData.lcu?.dc_5v, '#e8f4ff'],
                    ['DC +7V', unflattenedData.lcu?.dc_7v, '#e8f4ff'],
                    ['DC +15V', unflattenedData.lcu?.dc_15v, '#e8f4ff'],
                    ['DC +28V', unflattenedData.lcu?.dc_28v, '#e8f4ff'],
                    // ['AC +28V', unflattenedData.lcu?.ac_28v, '#e8f4ff'],
                    ['MSG1 Comm', unflattenedData.lcu?.msg1_comm, '#00d4ff'],
                    ['MSG2 Comm', unflattenedData.lcu?.msg2_comm, '#00d4ff'],
                    ['MON1 Comm', unflattenedData.lcu?.mon1_comm, '#00d4ff'],
                    ['MON2 Comm', unflattenedData.lcu?.mon2_comm, '#00d4ff'],
                    ['Battery 1', unflattenedData.lcu?.battery1, '#e8f4ff'],
                    ['Battery 2', unflattenedData.lcu?.battery2, '#e8f4ff'],
                    ['ACDC 1', unflattenedData.lcu?.acdc1, '#e8f4ff'],
                    ['ACDC 2', unflattenedData.lcu?.acdc2, '#e8f4ff'],
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
            const isTxp1Active = data.txp_active === 'TXP1' || data.txp1_active === true;
            const isTxp2Active = data.txp_active === 'TXP2' || data.txp2_active === true;

            const txp1Color = (label, val) => isTxp1Active ? getLimitColor(sup, label, val) : '#e8f4ff';
            const txp2Color = (label, val) => isTxp2Active ? getLimitColor(sup, label, val) : '#e8f4ff';

            sections.push({
                title: 'STATUS', params: [
                    ['TXP Active', data.txp_active || '—', '#00ffcc'],
                    ['Ident', data.ident || '—', '#00d4ff'],
                ]
            });
            sections.push({
                title: 'TXP1 — MON1', params: [
                    ['Sys Delay', data.txp1_m1_sys_delay, txp1Color('System Delay', data.txp1_m1_sys_delay)],
                    ['Reply Eff (%)', data.txp1_m1_reply_eff, txp1Color('Reply Efficiency', data.txp1_m1_reply_eff)],
                    ['Pair Rate', data.txp1_m1_pair_rate, '#e8f4ff'],
                    ['Fwd Power (W)', data.txp1_m1_fwd_power, txp1Color('Forward Power', data.txp1_m1_fwd_power)],
                    ['Dur A', data.txp1_m1_dur_a, '#e8f4ff'],
                    ['Dur B', data.txp1_m1_dur_b, '#e8f4ff'],
                    ['Rise A', data.txp1_m1_rise_a, '#e8f4ff'],
                    ['Rise B', data.txp1_m1_rise_b, '#e8f4ff'],
                    ['Decay A', data.txp1_m1_decay_a, '#e8f4ff'],
                    ['Decay B', data.txp1_m1_decay_b, '#e8f4ff'],
                    ['Spacing', data.txp1_m1_spacing, txp1Color('Pulse Spacing', data.txp1_m1_spacing)],
                ]
            });
            sections.push({
                title: 'TXP1 — MON2', params: [
                    ['Sys Delay', data.txp1_m2_sys_delay, txp1Color('System Delay', data.txp1_m2_sys_delay)],
                    ['Reply Eff (%)', data.txp1_m2_reply_eff, txp1Color('Reply Efficiency', data.txp1_m2_reply_eff)],
                    ['Pair Rate', data.txp1_m2_pair_rate, '#e8f4ff'],
                    ['Fwd Power (W)', data.txp1_m2_fwd_power, txp1Color('Forward Power', data.txp1_m2_fwd_power)],
                    ['Dur A', data.txp1_m2_dur_a, '#e8f4ff'],
                    ['Dur B', data.txp1_m2_dur_b, '#e8f4ff'],
                    ['Rise A', data.txp1_m2_rise_a, '#e8f4ff'],
                    ['Rise B', data.txp1_m2_rise_b, '#e8f4ff'],
                    ['Decay A', data.txp1_m2_decay_a, '#e8f4ff'],
                    ['Decay B', data.txp1_m2_decay_b, '#e8f4ff'],
                    ['Spacing', data.txp1_m2_spacing, txp1Color('Pulse Spacing', data.txp1_m2_spacing)],
                ]
            });
            sections.push({
                title: 'TXP2 — MON1', params: [
                    ['Sys Delay', data.txp2_m1_sys_delay, txp2Color('System Delay', data.txp2_m1_sys_delay)],
                    ['Reply Eff (%)', data.txp2_m1_reply_eff, txp2Color('Reply Efficiency', data.txp2_m1_reply_eff)],
                    ['Pair Rate', data.txp2_m1_pair_rate, '#e8f4ff'],
                    ['Fwd Power (W)', data.txp2_m1_fwd_power, txp2Color('Forward Power', data.txp2_m1_fwd_power)],
                    ['Dur A', data.txp2_m1_dur_a, '#e8f4ff'],
                    ['Dur B', data.txp2_m1_dur_b, '#e8f4ff'],
                    ['Rise A', data.txp2_m1_rise_a, '#e8f4ff'],
                    ['Rise B', data.txp2_m1_rise_b, '#e8f4ff'],
                    ['Decay A', data.txp2_m1_decay_a, '#e8f4ff'],
                    ['Decay B', data.txp2_m1_decay_b, '#e8f4ff'],
                    ['Spacing', data.txp2_m1_spacing, txp2Color('Pulse Spacing', data.txp2_m1_spacing)],
                ]
            });
            sections.push({
                title: 'TXP2 — MON2', params: [
                    ['Sys Delay', data.txp2_m2_sys_delay, txp2Color('System Delay', data.txp2_m2_sys_delay)],
                    ['Reply Eff (%)', data.txp2_m2_reply_eff, txp2Color('Reply Efficiency', data.txp2_m2_reply_eff)],
                    ['Pair Rate', data.txp2_m2_pair_rate, '#e8f4ff'],
                    ['Fwd Power (W)', data.txp2_m2_fwd_power, txp2Color('Forward Power', data.txp2_m2_fwd_power)],
                    ['Dur A', data.txp2_m2_dur_a, '#e8f4ff'],
                    ['Dur B', data.txp2_m2_dur_b, '#e8f4ff'],
                    ['Rise A', data.txp2_m2_rise_a, '#e8f4ff'],
                    ['Rise B', data.txp2_m2_rise_b, '#e8f4ff'],
                    ['Decay A', data.txp2_m2_decay_a, '#e8f4ff'],
                    ['Decay B', data.txp2_m2_decay_b, '#e8f4ff'],
                    ['Spacing', data.txp2_m2_spacing, txp2Color('Pulse Spacing', data.txp2_m2_spacing)],
                ]
            });
        } else if (parserId === 'dme_mopah_binary') {
            const ok = '#00ff88', warn = '#ffcc00', err = '#ff3355', info = '#e8f4ff';

            sections.push({
                title: 'DME STATUS', params: [
                    ['Overall Status', data.overall_status || '—', data.overall_status === 'Normal' ? ok : warn],
                    ['TX Active', data.tx_active || '—', '#00ffcc'],
                    ['Power Output (W)', data.power_watts || '—', '#e8f4ff'],
                    ['Reply Efficiency (%)', data.reply_efficiency || '—', '#00d4ff'],
                    ['Time Delay (us)', data.time_delay || '—', '#e8f4ff']
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
        } else if (parserId === 'ils_mophien_llz' || parserId === 'ils_mophien_gp') {
            const ok = '#00ff88', warn = '#ffcc00', err = '#ff3355', info = '#e8f4ff', accent = '#00d4ff';
            const isGpSection = parserId === 'ils_mophien_gp' || data.equipment_type === 'GLIDE_PATH';

            sections.push({
                title: isGpSection ? 'GLIDE PATH (GP) STATUS' : 'LOCALIZER (LLZ) STATUS', params: [
                    ['Station IDENT', data.station_ident || 'ISBY', accent],
                    ['Active Channel', data.active_channel || 'MON1', '#00ffcc'],
                    [isGpSection ? 'DDM On Path (CL)' : 'DDM Course Line (CL)', data.cl_ddm != null ? `${data.cl_ddm} %` : '0.00 %', ok],
                    ['SDM Course Line (CL)', data.cl_sdm != null ? `${data.cl_sdm} %` : (isGpSection ? '80.00 %' : '40.00 %'), info],
                    ['RF Level CL', data.cl_rf_level != null ? `${data.cl_rf_level} dB` : '0.00 dB', info],
                    ['DDM Displacement (DS)', data.ds_ddm != null ? `${data.ds_ddm} %` : (isGpSection ? '17.10 %' : '15.57 %'), ok],
                    ['SDM Displacement (DS)', data.ds_sdm != null ? `${data.ds_sdm} %` : (isGpSection ? '80.00 %' : '40.00 %'), info],
                    ['DDM Clearance (CLR)', data.clr_ddm != null ? `${data.clr_ddm} %` : (isGpSection ? '50.00 %' : '0.00 %'), info],
                    ['SDM Clearance (CLR)', data.clr_sdm != null ? `${data.clr_sdm} %` : (isGpSection ? '80.00 %' : '40.00 %'), info],
                    ['RF Level CLR', data.clr_rf_level != null ? `${data.clr_rf_level} dB` : '0.00 dB', info],
                    ['RF Disp Course', data.rf_disp_course != null ? `${data.rf_disp_course} %` : '0.0000 %', info],
                    ['RF Disp Clearance', data.rf_disp_clr != null ? `${data.rf_disp_clr} %` : '0.0000 %', info],
                    ['RF Disp Separation', data.rf_disp_sep != null ? `${data.rf_disp_sep} %` : '0.0000 %', info],
                ]
            });

            const llzRows = data._amv_txs_rows || [];
            if (llzRows.length > 0) {
                sections.push({
                    title: 'TELEMETRY VALUES', params:
                        llzRows.map(r => [r[0], r[1], info])
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
                    ['Tegangan VLN Avg (V)', fn(data.VLN_avg, 1)],
                    ['Tegangan VLL Avg (V)', fn(data.VLL_avg, 1)],
                    ['Frekuensi (Hz)', fn(data.HZ, 2)],
                    ['Power Factor', fn(data.PF, 3)],
                    ['Alarm', (data.alarmDetail && data.alarmDetail.length > 0) ? data.alarmDetail.join(' | ') : 'Tidak Ada'],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-NEUTRAL (V)', params: [
                    ['Van (L1-N)', fn(data.VL1N, 1)],
                    ['Vbn (L2-N)', fn(data.VL2N, 1)],
                    ['Vcn (L3-N)', fn(data.VL3N, 1)],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-LINE (V)', params: [
                    ['Vab (L1-L2)', fn(data.VL12, 1)],
                    ['Vbc (L2-L3)', fn(data.VL23, 1)],
                    ['Vca (L3-L1)', fn(data.VL31, 1)],
                ]
            });

            sections.push({
                title: 'ARUS (A)', params: [
                    ['Ia (L1)', fn(data.IL1, 2)],
                    ['Ib (L2)', fn(data.IL2, 2)],
                    ['Ic (L3)', fn(data.IL3, 2)],
                ]
            });

            sections.push({
                title: 'DAYA', params: [
                    ['Real (kW)', fn(data.KW, 3)],
                    ['Reaktif (kVAR)', fn(data.KVAR, 3)],
                    ['Semu (kVA)', fn(data.KVA, 3)],
                    ['Power Factor', fn(data.PF, 3)],
                    ['Frekuensi (Hz)', fn(data.HZ, 2)],
                    ['Energi (kWh)', data.KWH != null ? (+data.KWH).toLocaleString('id-ID', { minimumFractionDigits: 1 }) : '—'],
                ]
            });
        } else if (parserId === 'pm5350_modbus') {
            const fn = (v, d) => (v != null && !isNaN(parseFloat(v))) ? parseFloat(v).toFixed(d) : '—';

            sections.push({
                title: 'STATUS', params: [
                    ['Frekuensi (Hz)', fn(data.FREQ, 2)],
                    ['Power Factor', fn(data.PF, 3)],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-NEUTRAL (V)', params: [
                    ['V_RN (L1-N)', fn(data.V_RN, 1)],
                    ['V_SN (L2-N)', fn(data.V_SN, 1)],
                    ['V_TN (L3-N)', fn(data.V_TN, 1)],
                ]
            });

            sections.push({
                title: 'TEGANGAN LINE-TO-LINE (V)', params: [
                    ['V_RS (L1-L2)', fn(data.V_RS, 1)],
                    ['V_ST (L2-L3)', fn(data.V_ST, 1)],
                    ['V_TR (L3-L1)', fn(data.V_TR, 1)],
                ]
            });

            sections.push({
                title: 'ARUS (A)', params: [
                    ['I_R (L1)', fn(data.I_R, 2)],
                    ['I_S (L2)', fn(data.I_S, 2)],
                    ['I_T (L3)', fn(data.I_T, 2)],
                ]
            });

            sections.push({
                title: 'DAYA', params: [
                    ['Aktif (kW)', fn(data.KW, 3)],
                    ['Semu (kVA)', fn(data.KVA, 3)],
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
                    ['Hostname', data.sys_name || '—', '#00d4ff'],
                    ['Deskripsi', data.sys_descr || '—', '#5a8aaa'],
                    ['Uptime', data.sys_uptime || '—', '#5a8aaa'],
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
                    ['Sensor Name', data.temperature_sensor_name || '—', '#e8f4ff'],
                    ['Sensor Count', formatSnmpMetricValue('temperature_sensor_count', data.temperature_sensor_count), '#e8f4ff'],
                ]
            });
            sections.push({
                title: 'MEMORY (RAM)', params: [
                    ['RAM Total', formatSnmpMetricValue('ram_total_mb', data.ram_total_mb), '#e8f4ff'],
                    ['RAM Used [SNMP]', formatSnmpMetricValue('ram_used_mb', data.ram_used_mb), '#e8f4ff'],
                    ['RAM Used (%) [SNMP]', effectiveRamUsedPct !== null ? `${effectiveRamUsedPct.toFixed(1)} %` : '—', '#5a8aaa'],
                    ['RAM Available', effectiveRamAvailMb !== null ? formatSnmpMetricValue('ram_available_mb', Math.round(effectiveRamAvailMb)) : '—', '#e8f4ff'],
                    ['RAM Available (%)', effectiveRamAvailPct !== null ? `${effectiveRamAvailPct.toFixed(1)} %` : '—', getLimitColor('UPS', 'RAM Available', effectiveRamAvailPct)],
                ]
            });
            sections.push({
                title: 'MEMORY (PHYSICAL/VIRTUAL)', params: [
                    ['Physical Total', formatSnmpMetricValue('physical_memory_total_mb', data.physical_memory_total_mb), '#e8f4ff'],
                    ['Physical Used', formatSnmpMetricValue('physical_memory_used_mb', data.physical_memory_used_mb), '#e8f4ff'],
                    ['Physical Usage (%)', data.physical_memory_usage_pct !== '—' ? `${data.physical_memory_usage_pct} %` : '—', '#5a8aaa'],
                    ['Virtual Total', formatSnmpMetricValue('virtual_memory_total_mb', data.virtual_memory_total_mb), '#e8f4ff'],
                    ['Virtual Used', formatSnmpMetricValue('virtual_memory_used_mb', data.virtual_memory_used_mb), '#e8f4ff'],
                    ['Virtual Usage (%)', data.virtual_memory_usage_pct !== '—' ? `${data.virtual_memory_usage_pct} %` : '—', '#5a8aaa'],
                    ['Swap Total', formatSnmpMetricValue('swap_total_mb', data.swap_total_mb), '#e8f4ff'],
                    ['Swap Used', formatSnmpMetricValue('swap_used_mb', data.swap_used_mb), '#e8f4ff'],
                    ['Swap Usage (%)', data.swap_usage_pct !== '—' ? `${data.swap_usage_pct} %` : '—', '#5a8aaa'],
                    ['Buffers', formatSnmpMetricValue('memory_buffers_mb', data.memory_buffers_mb), '#e8f4ff'],
                    ['Cached', formatSnmpMetricValue('cached_memory_mb', data.cached_memory_mb), '#e8f4ff'],
                    ['Shared', formatSnmpMetricValue('shared_memory_mb', data.shared_memory_mb), '#e8f4ff'],
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
                        ['Disk Total', formatSnmpMetricValue('disk_total_gb', data.disk_total_gb), '#e8f4ff'],
                        ['Disk Used', formatSnmpMetricValue('disk_used_gb', data.disk_used_gb), '#e8f4ff'],
                        ['Disk Usage (%)', data.disk_usage_pct !== '—' ? `${data.disk_usage_pct} %` : '—', '#e8f4ff'],
                    ]
                });
            }
        } else if (parserId === 'snmp_network_basic') {
            sections.push({
                title: 'SISTEM JARINGAN', params: [
                    ['Konektivitas', data.connectivity || '—'],
                    ['Hostname', data.sys_name || '—'],
                    ['IP', data.resolved_ip || '—'],
                    ['Hardware', data.hardware || '—'],
                    ['OS', data.operating_system || '—'],
                    ['Uptime', data.sys_uptime || '—'],
                    ['Lokasi', data.sys_location || '—'],
                ]
            });
            sections.push({
                title: 'INTERFACE', params: [
                    ['Total Interface', formatSnmpMetricValue('interface_count', data.interface_count)],
                    ['Top Interface', data.top_interface_name || '—'],
                    ['Interface Up', formatSnmpMetricValue('active_interface_count', data.active_interface_count)],
                    ['Interface Down', formatSnmpMetricValue('down_interface_count', data.down_interface_count)],
                    ['Port Aktif', data.active_interfaces_summary || '—'],
                    ['Port Tidak Aktif', data.down_interfaces_summary || '—'],
                    ['Status Top Interface', data.top_interface_status || '—'],
                    ['In Octets', formatSnmpMetricValue('top_interface_in_octets', data.top_interface_in_octets)],
                    ['Out Octets', formatSnmpMetricValue('top_interface_out_octets', data.top_interface_out_octets)],
                    ['Temperature', formatSnmpMetricValue('temperature_c', data.temperature_c)],
                    ['Temp Sensor', data.temperature_sensor_name || '—'],
                ]
            });
        } else if (parserId === 'asterix_radar') {
            const isConn = data.connectivity === 'Connected';
            const cc = isConn ? '#00ff88' : '#ff3355';
            sections.push({
                title: 'STATUS RADAR MSSR', params: [
                    ['Konektivitas', data.connectivity || '—', cc],
                    ['Nama Radar', data.radar_name || '—', '#00d4ff'],
                    ['SAC', data.sac || '—', '#e8f4ff'],
                    ['SIC', data.sic || '—', '#e8f4ff'],
                    ['Radar ID', data.radar_id || '—', '#e8f4ff'],
                    ['Message Type', data.msg_type || '—', '#e8f4ff'],
                    ['Time of Day', data.time_of_day || '—', '#e8f4ff'],
                    ['Sector', data.sector_number || '—', '#e8f4ff'],
                    ['Antenna Rot.', data.antenna_rotation || '—', '#00d4ff'],
                    ['Sys Config (Hex)', data.system_config || '—', '#5a8aaa'],
                    ['System Status', data.system_status || 'Normal', getLimitColor(supCategory || 'RADAR', 'System Status', data.system_status, parserId)],
                    ['Target Count (CAT048)', data.target_count || '0', '#00d4ff'],
                    ['Target List (ICAO)', data.targets_list || '—', '#e8f4ff'],
                    ['Last CAT034', data.last_cat034 || '—', '#5a8aaa'],
                    ['Last CAT048', data.last_cat048 || '—', '#5a8aaa'],
                    ['Koordinat', data.lat && data.lon ? `${data.lat}, ${data.lon}` : '—', '#5a8aaa'],
                    ['Data Source', data.data_source || '—', '#3a6a8a'],
                ]
            });

        } else if (parserId === 'asterix_adsb') {
            const isConn = data.connectivity === 'Connected';
            const cc = isConn ? '#00ff88' : '#ff3355';
            sections.push({
                title: 'STATUS ADS-B STATION', params: [
                    ['Konektivitas', data.connectivity || '—', cc],
                    ['Station', data.station || '—', '#00d4ff'],
                    ['SAC', data.sac || '—', '#e8f4ff'],
                    ['SIC', data.sic || '—', '#e8f4ff'],
                    ['Radar ID', data.radar_id || '—', '#e8f4ff'],
                    ['Multicast IP', data.multicast_ip || '—', '#5a8aaa'],
                    ['Multicast Port', data.multicast_port || '—', '#5a8aaa'],
                    ['Target Count', data.target_count || '0', '#00d4ff'],
                    ['Target List (ICAO)', data.targets_list || '—', '#e8f4ff'],
                    ['Last CAT021', data.last_cat021 || '—', '#5a8aaa'],
                    ['Koordinat', data.lat && data.lon ? `${data.lat}, ${data.lon}` : '—', '#5a8aaa'],
                    ['Data Source', data.data_source || '—', '#3a6a8a'],
                ]
            });

        } else if (parserId === 'temp_humidity_modbus') {
            const sup = 'SHELTER';
            const temp = parseFloat(data.temperature_c);
            const humi = parseFloat(data.humidity_pct);
            sections.push({
                title: 'SENSOR SUHU & KELEMBABAN', params: [
                    ['Suhu (°C)', isNaN(temp) ? '—' : `${temp.toFixed(1)} °C`, getLimitColor(sup, 'Temperature', temp, parserId)],
                    ['Kelembaban (%)', isNaN(humi) ? '—' : `${humi.toFixed(1)} %`, getLimitColor(sup, 'Humidity', humi, parserId)],
                    ['Lokasi', data.location || '—'],
                    ['Status', data.status_text || '—'],
                ]
            });
            // sections.push({
            //     title: 'THRESHOLD', params: [
            //         ['Warning threshold', '≥ 30.0 °C', '#ffcc00'],
            //         ['Alarm threshold', '≥ 35.0 °C', '#ff3355'],
            //     ]
            // });
        } else if (parserId === 'ote_dtr100') {
            const isTx = data.forward_power_w !== undefined;
            if (isTx) {
                sections.push({
                    title: 'Transmitter Parameters',
                    params: [
                        ['MODE', data._mode || 'ACTIVE', '#00ffcc'],
                        ['STATUS', data._status || 'Normal', data._status === 'FAULT' ? '#ff3355' : '#00d4ff'],
                        ['FREQUENCY', data.frequency_mhz !== undefined ? `${data.frequency_mhz.toFixed(3)} MHz` : '—', '#5a8aaa'],
                        ['OUTPUT POWER', data.forward_power_w !== undefined ? `${data.forward_power_w} W` : '—', '#3a6a8a'],
                        ['VSWR', data.vswr !== undefined ? data.vswr : '—', data.vswr > 1.5 ? '#ff3355' : '#a0c8e8'],
                        ['SUPPLY VOLTAGE', data.supply_voltage_v !== undefined ? `${data.supply_voltage_v.toFixed(2)} V` : '—', '#a0c8e8']
                    ]
                });
            } else {
                sections.push({
                    title: 'Receiver Parameters',
                    params: [
                        ['MODE', data._mode || 'ACTIVE', '#00ffcc'],
                        ['STATUS', data._status || 'Normal', data._status === 'FAULT' ? '#ff3355' : '#00d4ff'],
                        ['FREQUENCY', data.frequency_mhz !== undefined ? `${data.frequency_mhz.toFixed(3)} MHz` : '—', '#5a8aaa'],
                        ['RF INPUT PWR', data.rf_input_power_dbm !== undefined ? `${data.rf_input_power_dbm} dBm` : '—', '#3a6a8a'],
                        ['SQUELCH', data.squelch_dbm !== undefined ? `${data.squelch_dbm} dBm` : '—', '#a0c8e8'],
                        ['SENSITIVITY', data.sensitivity_dbm !== undefined ? `${data.sensitivity_dbm} dBm` : '—', '#a0c8e8'],
                        ['RSSI', data.rssi_dbm !== undefined ? `${data.rssi_dbm} dBm` : '—', '#a0c8e8'],
                        ['SUPPLY VOLTAGE', data.supply_voltage_v !== undefined ? `${data.supply_voltage_v.toFixed(2)} V` : '—', '#a0c8e8']
                    ]
                });
            }
        } else if (parserId === 'ils_mm_normac') {
            const sup = 'ILS-MM';
            sections.push({
                title: 'SYSTEM STATUS', params: [
                    ['TX MAIN', data.tx_main_label || '—', '#00ffcc'],
                    ['TX STANDBY', data.tx_stby_label || '—', '#5a8aaa'],
                    ['STATUS', data.status_label || 'Normal', '#00d4ff'],
                    ['DATA SOURCE', data.tx_data || 'Local', '#3a6a8a'],
                ]
            });
            sections.push({
                title: 'MONITOR 1 (MAIN)', params: [
                    ['RF Level', data.mon1_rf_level !== undefined ? `${data.mon1_rf_level.toFixed(1)} V` : '—', '#00ffcc'],
                    ['Mod. Depth', data.mon1_mod_depth !== undefined ? `${data.mon1_mod_depth.toFixed(1)} %` : '—', '#5a8aaa'],
                    ['Keying', data.mon1_keying || '—', '#3a6a8a']
                ]
            });
            sections.push({
                title: 'MONITOR 2 (STANDBY)', params: [
                    ['RF Level', data.mon2_rf_level !== undefined ? `${data.mon2_rf_level.toFixed(1)} V` : '—', '#00ffcc'],
                    ['Mod. Depth', data.mon2_mod_depth !== undefined ? `${data.mon2_mod_depth.toFixed(1)} %` : '—', '#5a8aaa'],
                    ['Keying', data.mon2_keying || '—', '#3a6a8a']
                ]
            });
        } else if (parserId === 'ils_gp_thales421' || parserId === 'ils_gp_normac') {
            const sup = 'ILS-GP';
            sections.push({
                title: 'SYSTEM STATUS', params: [
                    ['TX MAIN', data.tx_main_label || '—', '#00ffcc'],
                    ['TX STANDBY', data.tx_stby_label || '—', '#5a8aaa'],
                    ['MODE', data.status_label || '—', data.is_remote ? '#ffcc00' : '#00d4ff'],
                    ['DATA SOURCE', data.tx_data || '—', '#3a6a8a'],
                ]
            });

            const paramLabels = {
                GP_ANGLE: 'GP ANGLE',
                RF_POWER: 'RF POWER',
                DDM_COURSE: 'DDM COURSE',
                CARRIER_PWR: 'CARRIER PWR',
                CSB_POWER: 'CSB POWER',
                DDM_CLR: 'DDM CLR',
                SBO_POWER: 'SBO POWER',
                CLR_POWER: 'CLR POWER',
                CLR_DDM: 'CLR DDM',
                CLR_SDM: 'CLR SDM',
                RF_OUT: 'RF OUT',
                DDM_MON: 'DDM MON',
                MON_POWER: 'MON POWER'
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
                    ['TX MAIN', data.tx_main_label || '—', '#00ffcc'],
                    ['TX STANDBY', data.tx_stby_label || '—', '#5a8aaa'],
                ]
            });

            const paramLabels = {
                CRS_RF: 'CRS RF',
                CRS_DDM: 'CRS DDM',
                CRS_SDM: 'CRS SDM',
                IDENT_AM: 'IDENT AM',
                WIDTH_RF: 'WIDTH RF',
                WIDTH_DDM: 'WIDTH DDM',
                WIDTH_SDM: 'WIDTH SDM',
                CLR_RF: 'CLR RF',
                CLR_DDM: 'CLR DDM',
                CLR_SDM: 'CLR SDM',
                NF_RF: 'NF RF',
                NF_DDM: 'NF DDM',
                NF_SDM: 'NF SDM',
                FREQ_DEV: 'FREQ DEV'
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
                if (nameLower.includes('mophien')) {
                    tmpl = window.templatesCache?.find(t => t.id === 'ils_mophien_llz');
                } else if (nameLower.includes('glide') || nameLower.includes('gp')) {
                    tmpl = window.templatesCache?.find(t => t.id === 'ils_gp_normac');
                } else if (nameLower.includes('localizer') || nameLower.includes('llz')) {
                    tmpl = window.templatesCache?.find(t => t.id === 'ils_llz_normac');
                } else if (nameLower.includes('middle') || nameLower.includes('mm')) {
                    tmpl = window.templatesCache?.find(t => t.id === 'ils_mm_normac');
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

                // Tampilkan telemetry table rows jika tersedia (seperti PMDT Juanda / DME / DVOR)
                const extraRows = data._amv_txs_rows || [];
                if (extraRows.length > 0) {
                    sections.push({
                        title: 'TELEMETRY VALUES',
                        params: extraRows.map(r => [r[0], r[1], '#e8f4ff'])
                    });
                }
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
                        sections.push({ title: 'DATA', params: [['No data available', '—', '#4a7a9a']] });
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
        return _origFetch.call(window, url, opts).then(res => {
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
            stopSourcePanelLiveUpdates();
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
            .source-status-pill.offline    { background: #660022; color: #ff3355; border: 1px solid #ff3355; }
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

            /* ALARM / OFFLINE — border merah tebal + background merah gelap + pulse */
            .sp-source-card.alarm, .sp-source-card.offline {
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

            /* Alarm/Offline indicator dot di pojok kiri atas */
            .sp-source-card.alarm::before, .sp-source-card.offline::before {
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
            .sp-status-dot.alarm, .sp-status-dot.offline { background: #ff3355; box-shadow: 0 0 8px #ff335544; }
            .sp-status-dot.warning { background: #ffcc00; box-shadow: 0 0 8px #ffcc0044; }
            .sp-source-name { font-size: 13px; font-weight: 600; color: #e8f4ff; word-break: break-word; }
            .sp-status-pill { font-size: 9px; font-weight: bold; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; flex-shrink: 0; }
            .sp-status-pill.normal { background: #005533; color: #00ff88; }
            .sp-status-pill.alarm, .sp-status-pill.offline { background: #660022; color: #ff3355; }
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
            .sp-card-no-data { padding: 20px; text-align: center; color: #3a5a7a; font-size: 11px; display: flex; flex-direction: column; gap: 8px; }

            /* ── Universal Adaptive Grouped Grid Modal Styling ──────────── */
            .univ-grid-container {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 10px;
            }
            @media (min-width: 640px) {
                .univ-grid-container {
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                }
            }
            @media (min-width: 900px) {
                .univ-grid-container {
                    grid-template-columns: repeat(4, minmax(0, 1fr));
                }
            }
            @keyframes pulse-subtle {
                0%, 100% { box-shadow: 0 0 10px rgba(244, 63, 94, 0.25); }
                50% { box-shadow: 0 0 18px rgba(244, 63, 94, 0.45); }
            }
            .univ-card-alarm {
                animation: pulse-subtle 2s infinite ease-in-out;
            }
        `;
        document.head.appendChild(style);
    }

    // ── Global Connection Monitor ──────────────────────────────────────────────
    let _connectionFails = 0;
    let _connCheckInterval = null;

    function initConnectionMonitor() {
        if (_connCheckInterval) clearInterval(_connCheckInterval);
        _connCheckInterval = setInterval(async () => {
            try {
                // Ping endpoint to check backend health
                const res = await _origFetch.call(window, '/api/test-chain');
                if (res.ok) {
                    _connectionFails = 0;
                    const overlay = document.getElementById('globalConnectionOverlay');
                    if (overlay) overlay.style.display = 'none';
                } else {
                    throw new Error('Server returned ' + res.status);
                }
            } catch (e) {
                _connectionFails++;
                // If failed 2 times (10 seconds total disconnected), show overlay
                if (_connectionFails >= 2) {
                    const overlay = document.getElementById('globalConnectionOverlay');
                    if (overlay) overlay.style.display = 'flex';
                }
            }
        }, 5000); // Check every 5 seconds
    }

    // ── INIT ──────────────────────────────────────────────────────────────────
    function init() {
        addStyles();
        initClosePanel();
        loadTemplates();   // Load templates for schemas
        loadLimitations(); // Load dynamic limits
        initConnectionMonitor(); // Start checking server health
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
