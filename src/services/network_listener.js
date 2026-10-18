/**
 * Network Listener Service
 * Manages persistent UDP/TCP listeners for equipment data sources
 */

const ParserFactory = require('../parsers/factory');
const connectionManager = require('../connection/manager');
const db = require('../../db/database');
const EquipmentService = require('./equipment');
const RawEventQueue = require('./raw_event_queue');
const { SourceStatusGate } = require('./source_status_gate');
const { exec } = require('child_process');

const RAW_DEBUG = String(process.env.RAW_DEBUG || 'false').toLowerCase() === 'true';

// Cache untuk ping agar tidak flood
const _pingCache = new Map();
async function checkIcmpPing(ip) {
    if (!ip) return false;
    ip = String(ip).trim();
    const now = Date.now();
    if (_pingCache.has(ip)) {
        const cached = _pingCache.get(ip);
        if (now - cached.time < 15000) return cached.result; // Cache 15 detik
    }

    return new Promise(resolve => {
        const { exec } = require('child_process');
        const isWin = process.platform === 'win32';
        const cmd = isWin ? `ping -n 1 -w 1500 ${ip}` : `ping -c 1 -W 2 ${ip}`;

        const child = exec(cmd, { windowsHide: true }, (err, stdout) => {
            const out = (stdout || '').toLowerCase();
            let isAlive = false;
            if (isWin) {
                isAlive = (out.includes('ttl=') || out.includes('reply from') || out.includes('balasan dari')) &&
                    !out.includes('destination host unreachable') &&
                    !out.includes('tujuan host tidak dapat dijangkau') &&
                    !out.includes('request timed out') &&
                    !out.includes('waktu habis') &&
                    !out.includes('100% loss');
            } else {
                isAlive = !err && (out.includes('ttl=') || out.includes('bytes from') || out.includes('1 packets received') || out.includes('1 received'));
            }

            _pingCache.set(ip, { time: now, result: isAlive });
            resolve(isAlive);
        });

        setTimeout(() => {
            try { child.kill(); } catch (e) { }
            _pingCache.set(ip, { time: now, result: false });
            resolve(false);
        }, 2500);
    });
}

class NetworkListenerService {
    constructor() {
        this.equipmentService = new EquipmentService(db);
        this.activeListeners = new Set(); // source_id -> true
        this.parsers = new Map(); // source_id -> parser instance
        this._parseWarningTimestamps = new Map(); // Untuk mencegah spam log
        this.statusGate = new SourceStatusGate();
        this.pipelineMode = process.env.PIPELINE_MODE || 'inline';
        this.serviceRole = process.env.SERVICE_ROLE || 'all';
        this.rawEventQueue = new RawEventQueue();

        // Note: fs.watchFile dihapus karena sekarang direload secara instan 
        // langsung dari trigger db.setConfigUpdateHook di server.ts 
        // (Windows fs.watchFile sering lambat/tidak jalan)
    }

    _shouldLogParseWarning(sourceId, errorKey, throttleMs = 15000) {
        const key = `${sourceId}:${errorKey}`;
        const now = Date.now();
        const lastLoggedAt = this._parseWarningTimestamps.get(key) || 0;

        if (now - lastLoggedAt < throttleMs) {
            return false;
        }

        this._parseWarningTimestamps.set(key, now);
        return true;
    }

    _shouldLogMessage(key, throttleMs) {
        return this.statusGate.shouldLog(key, throttleMs);
    }

    _logThrottled(level, key, message, throttleMs) {
        if (!this._shouldLogMessage(key, throttleMs)) return;
        const logger = console[level] || console.log;
        logger.call(console, message);
    }

    _isSplitCollectorMode() {
        // [BYPASS] Selalu return false agar pemrosesan dilakukan di RAM (In-Memory)
        // Mencegah memory crash akibat antrean file yang membludak.
        return false;
    }

    /**
     * Helper untuk Polling dengan Circuit Breaker & Jitter.
     * @param {Object} options
     * @param {string} options.id - equipment ID
     * @param {string} options.name - equipment name
     * @param {number} options.pollSec - interval dalam detik
     * @param {Map} options.timersMap - map untuk menyimpan reference ke timer (misal: this._dseTimers)
     * @param {Function} options.doPoll - fungsi async yang melempar error jika gagal
     * @param {number} [options.maxFailures=3] - batas gagal berturut-turut
     * @param {number} [options.backoffMs=120000] - lama jeda setelah trip (default 2 menit)
     */
    _startCircuitBreakerPolling({ id, name, pollSec, timersMap, doPoll, maxFailures = 3, backoffMs = 120000 }) {
        let failureCount = 0;
        let isTripped = false;
        let isExecuting = false;

        const execute = async () => {
            if (isExecuting) return;
            isExecuting = true;
            try {
                await doPoll();
                // Jika sukses tanpa error:
                failureCount = 0;
                if (isTripped) {
                    console.log(`[CircuitBreaker] ${name} (${id}) is BACK ONLINE. Circuit CLOSED.`);
                    isTripped = false;
                }
            } catch (err) {
                failureCount++;
                if (!isTripped && failureCount >= maxFailures) {
                    isTripped = true;
                    console.warn(`[CircuitBreaker] ${name} (${id}) failed ${failureCount}x. Circuit TRIPPED! Sleeping for ${backoffMs / 1000}s.`);

                    const currentTimer = timersMap.get(id);
                    if (currentTimer) clearInterval(currentTimer);

                    const backoffTimer = setTimeout(() => {
                        console.log(`[CircuitBreaker] ${name} (${id}) backoff finished. Resuming polling...`);
                        const newTimer = setInterval(execute, pollSec * 1000);
                        timersMap.set(id, newTimer);
                        execute();
                    }, backoffMs);

                    timersMap.set(id, backoffTimer);
                }
            } finally {
                isExecuting = false;
            }
        };

        const initialDelay = 1000 + Math.floor(Math.random() * 5000); // Jitter 1-6 detik
        const startTimer = setTimeout(() => {
            execute();
            const timer = setInterval(execute, pollSec * 1000);
            timersMap.set(id, timer);
        }, initialDelay);

        timersMap.set(id, startTimer);
    }

    async _handleLogOutput(source, parsedData, connectionType, initialStatus) {
        const initialLower = String(initialStatus || '').toLowerCase();
        const isInitialDisconnect = initialLower === 'disconnect' || initialLower === 'error' || initialLower === 'offline';
        let statusToEvaluate = 'Normal';
        let isPingable = false;

        if (isInitialDisconnect) {
            // Jika parsing_id adalah ils_mophien_llz / ils_mophien_gp atau modul TCP streaming khusus,
            // jangan biarkan ping ICMP yang di-block mematikan status alat
            if (source.parsing_id === 'ils_mophien_llz' || source.parsing_id === 'ils_mophien_gp') {
                isPingable = true;
                if (!parsedData.data) parsedData.data = {};
                parsedData.data.ping_status = 'Normal';
                statusToEvaluate = 'Normal';
            } else {
                isPingable = await checkIcmpPing(source.ip_address);
                if (!parsedData.data) parsedData.data = {};
                parsedData.data.ping_status = isPingable ? 'Normal' : 'Gagal';

                if (isPingable) {
                    statusToEvaluate = 'Offline';
                } else {
                    statusToEvaluate = 'Disconnect';
                }
            }
        } else if (source.equipt_id && parsedData && parsedData.data) {
            // Dynamic Limitation Threshold Evaluation
            try {
                const limits = await this.equipmentService.db.getLimitationsByEquipment(source.equipt_id, source.parsing_id);
                if (Array.isArray(limits) && limits.length > 0) {
                    const aliasMap = {
                        'suhu': ['temperature', 'temp', 'temperature_c', 'temperature c', 'ambient temp', 'internal temp'],
                        'temperature': ['suhu', 'temp', 'temperature_c', 'temperature c', 'ambient temp', 'internal temp', 'cpatemp', 'msgtemp'],
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
                        'crsrf': ['crsrf', 'crsrflevel', 'crsposrf', 'crsposrflevel', 'crs_rf', 'rf_power', 'rfpower', 'rf power'],
                        'crsddm': ['crsddm', 'crsposddm', 'crs_ddm', 'ddm_course', 'ddmcourse', 'ddm course'],
                        'crssdm': ['crssdm', 'crspossdm', 'crs_sdm', 'carrier_pwr', 'carrierpower', 'carrierpwr', 'carrier power'],
                        'identam': ['identam', 'ident', 'ident_am', 'ident am'],
                        'widthrf': ['widthrf', 'crswidthrf', 'crswidthrflevel', 'width_rf', 'csb_power', 'csbpower', 'csb power', 'widthrflevel'],
                        'widthddm': ['widthddm', 'crswidthddm', 'width_ddm', 'ddm_clr', 'ddmclr', 'ddm clr'],
                        'widthsdm': ['widthsdm', 'crswidthsdm', 'width_sdm', 'sbo_power', 'sbopower', 'sbo power'],
                        'clrrf': ['clrrf', 'clrwidthrf', 'clrwidthrflevel', 'clr_rf', 'clr_power', 'clrpower', 'clr power'],
                        'clrddm': ['clrddm', 'clrwidthddm', 'clr_ddm'],
                        'clrsdm': ['clrsdm', 'clrwidthsdm', 'clr_sdm'],
                        'nfrf': ['nfrf', 'nearfieldrf', 'nearfieldposrf', 'nearfieldposrflevel', 'nf_rf', 'rf_out', 'rfout', 'rf out', 'nearfieldposrflevel'],
                        'nfddm': ['nfddm', 'nearfieldddm', 'nearfieldposddm', 'nf_ddm', 'ddm_mon', 'ddmmon', 'ddm mon'],
                        'nfsdm': ['nfsdm', 'nearfieldsdm', 'nearfieldpossdm', 'nf_sdm', 'mon_power', 'monpower', 'mon power'],
                        'freqdev': ['freqdev', 'freqdeviation', 'frequencydeviation', 'freq_dev', 'frequency deviation', 'freq deviation'],
                        'gpangle': ['gpangle', 'glidepathangle', 'gp_angle', 'gp angle'],
                        'am1020hz': ['am1020hz', '1020hzam', 'am1020', '1020hz'],
                        'am30hz': ['am30hz', '30hzam', 'am30', '30hz'],
                        'am9960hz': ['am9960hz', '9960hzam', 'am9960', '9960hz'],
                        'fmindex': ['fmindex', 'fm index'],
                        'carrierpower': ['carrierpower', 'carrierpwr', 'carrier power'],
                        'rfinput': ['rfinput', 'rf input'],
                        'azimuth': ['azimuth', 'azimuth deg'],
                        'systemdelay': ['sysdelay', 'systemdelay', 'system delay'],
                        'pulserefficiency': ['replyeff', 'replyefficiency', 'reply efficiency'],
                        'pulsespacing': ['spacing', 'pulsespacing', 'pulse spacing'],
                        'forwardpower': ['fwdpower', 'forwardpower', 'forward power'],
                        'reflectedpower': ['reflpower', 'reflectedpower', 'reflected power']
                    };

                    const thresholdEvaluator = require('../utils/thresholdEvaluator');

                    // Flatten nested data (seperti ioLogik devices: { DME: { TX: 'TX 1' } })
                    const flatParams = {};
                    const flatten = (obj, prefix = '') => {
                        for (const [k, v] of Object.entries(obj || {})) {
                            if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                                flatten(v, prefix ? `${prefix}_${k}` : k);
                            } else {
                                if (prefix) {
                                    flatParams[`${prefix}_${k}`] = v;
                                    flatParams[`${prefix} ${k}`] = v;
                                    flatParams[`iologik_pin_${prefix}_${k}`] = v;
                                }
                                flatParams[k] = v; // Direct key access
                            }
                        }
                    };
                    flatten(parsedData.data);

                    for (const lim of limits) {
                        if (lim.is_active === false || lim.is_active === 'false' || lim.is_active === 0 || lim.is_active === '0') continue;
                        const lName = String(lim.name || lim.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        const lSource = String(lim.source || '').toLowerCase().replace(/[^a-z0-9]/g, '');

                        for (const [key, rawVal] of Object.entries(flatParams)) {
                            if (rawVal === undefined || rawVal === null) continue;
                            const dKey = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                            // Hapus prefix umum seperti mon1_, mon2_, tx1_, tx2_, lcu_ untuk pencocokan generik
                            const strippedKey = dKey.replace(/^(mon1|mon2|tx1|tx2|lcu)/, '');

                            let isMatch = (lName === dKey || lSource === dKey || lName === strippedKey || lSource === strippedKey);
                            if (!isMatch) {
                                for (const [canon, aliases] of Object.entries(aliasMap)) {
                                    const allVariants = [canon, ...aliases];
                                    const candMatches = allVariants.some(a => a === lName || (a.length >= 4 && lName.length >= 4 && (lName.includes(a) || a.includes(lName))));
                                    const keyMatches = allVariants.some(a => a === dKey || a === strippedKey || (a.length >= 4 && dKey.length >= 4 && (dKey.includes(a) || a.includes(dKey))) || (a.length >= 4 && strippedKey.length >= 4 && (strippedKey.includes(a) || a.includes(strippedKey))));
                                    if (candMatches && keyMatches) {
                                        isMatch = true;
                                        break;
                                    }
                                }
                            }
                            if (!isMatch && lim.match_mode !== 'exact' && lName.length >= 4) {
                                isMatch = (dKey.length >= 4 && (dKey.includes(lName) || lName.includes(dKey))) || (strippedKey.length >= 4 && (strippedKey.includes(lName) || lName.includes(strippedKey)));
                            }

                            if (isMatch) {
                                const evalStatus = thresholdEvaluator.checkThreshold(rawVal, lim);
                                if (evalStatus === 'Alert' || evalStatus === 'Alarm' || evalStatus === 'Warning') {
                                    // Aturan 1: Berapapun pembacaan nilainya (warning maupun alarm), status data source tetap Warning
                                    statusToEvaluate = 'Warning';
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (evalErr) {
                // non-fatal
            }
        }

        const decision = this.statusGate.evaluate(source, statusToEvaluate, {
            now: Date.now(),
            confirmDisconnect: true,
            connectionType
        });

        if (!decision.shouldEmit) {
            if (decision.reason === 'disconnect-not-confirmed') {
                this._logThrottled(
                    'log',
                    `status-gate:${decision.state.sourceKey}:pending-disconnect`,
                    `[StatusGate] Pending disconnect for ${source.name} (${decision.state.failCount}/${this.statusGate.failCountToDisconnect})`,
                    30000
                );
            }
            return;
        }

        let finalStatus = decision.status;
        const isFrozen = decision.reason === 'disconnect-not-confirmed' || decision.reason === 'Frozen (Pending Disconnect)';

        // LKGV (Last Known Good Value) & Dash Conversion
        if (!this._lkgvCache) this._lkgvCache = new Map();
        const isDisconnect = String(finalStatus || '').toLowerCase() === 'disconnect' || String(finalStatus || '').toLowerCase() === 'error';

        if (isFrozen) {
            // Jika sedang dibekukan (karena aslinya Disconnect tapi belum 2 menit), 
            // JANGAN simpan data kosong/putus-putus dari parser ke cache.
            // Sebaliknya, kembalikan data asli dari cache agar UI tetap melihat angka terakhir.
            const prevData = this._lkgvCache.get(source.id);
            if (prevData && parsedData) {
                parsedData.data = JSON.parse(JSON.stringify(prevData));
            }
        } else if (!isDisconnect && parsedData && parsedData.data) {
            // Jika bisa connect SNMP/API dan bukan Offline murni, berarti secara logika network normal. 
            // Tapi jika Offline (karena SNMP gagal tapi Ping sukses), kita sudah isi ping_status di atas.
            if (finalStatus !== 'Offline') {
                parsedData.data.ping_status = 'Normal';
            }
            // Simpan data terakhir yang SUKSES BENERAN ke dalam cache (Hanya jika Normal/Warning)
            if (finalStatus === 'Normal' || finalStatus === 'Warning' || finalStatus === 'Alarm') {
                this._lkgvCache.set(source.id, JSON.parse(JSON.stringify(parsedData.data)));
            }
        }

        // Jangan timpa parameter menjadi strip jika alat adalah streaming TCP aktif yang sudah menerima paket
        if ((isDisconnect || finalStatus === 'Offline') && source.parsing_id !== 'ils_mophien_llz' && source.parsing_id !== 'ils_mophien_gp') {
            const prevData = this._lkgvCache.get(source.id);
            if (prevData) {
                const dashData = {};
                for (const key of Object.keys(prevData)) {
                    dashData[key] = '—';
                }
                dashData.connectivity = 'Disconnected';
                parsedData.data = { ...parsedData.data, ...dashData };
            }
            parsedData.data.ping_status = isPingable ? 'Normal' : 'Gagal';
        }

        if (this._isSplitCollectorMode()) {
            await this.rawEventQueue.enqueue({
                type: 'parsed',
                timestamp: new Date().toISOString(),
                source: {
                    id: source.id,
                    equipt_id: source.equipt_id,
                    name: source.name,
                    ip_address: source.ip_address,
                    parsing_id: source.parsing_id
                },
                parsedData,
                connectionType,
                status: finalStatus
            });
            return;
        }

        const dataToSave = { ...parsedData, source: source.name, source_id: source.id, source_name: source.name };
        if (dataToSave.data) {
            dataToSave.data.source_id = source.id;
            dataToSave.data.source_name = source.name;
            // Jika ada field equipment dari parser, override agar konsisten dengan DB config
            if (dataToSave.data.equipment) dataToSave.data.equipment = source.name;
        }

        await this.equipmentService.saveToLogs(
            source.equipt_id,
            dataToSave,
            connectionType,
            finalStatus
        );
    }

    async _enqueueRawEvent(source, rawData) {
        if (!this._isSplitCollectorMode()) return;

        const rawBuffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(String(rawData));
        await this.rawEventQueue.enqueue({
            type: 'raw',
            timestamp: new Date().toISOString(),
            source: {
                id: source.id,
                equipt_id: source.equipt_id,
                name: source.name,
                ip_address: source.ip_address,
                parsing_id: source.parsing_id
            },
            rawBase64: rawBuffer.toString('base64')
        });
    }

    /**
     * Initialize listeners for all active equipment sources
     */
    async initialize() {
        if (this._isInitializing) {
            console.log('[NetworkListener] Already initializing, scheduling a reload...');
            this._pendingReload = true;
            return;
        }
        this._isInitializing = true;

        console.log('[NetworkListener] Initializing listeners...');
        this.stopAll();

        try {
            // Fetch all equipment sources (authentications)
            const sources = await db.getAllOtentication();
            console.log(`[NetworkListener] Found ${sources.length} total sources`);

            // Parsers yang tidak butuh port (SNMP pakai UDP 161 internal) atau memiliki default port internal
            const PORTLESS_PARSERS = [
                'snmp_system', 'snmp_host_resources_01', 'snmp_network_basic', 'ups_netagent_snmp', 'vhf_t6tv_snmp', 'vhf_t6tv',
                'ils_mophien_llz', 'ils_mophien_gp', 'ils_gp_normac', 'ils_llz_normac'
            ];
            const startBatchSize = parseInt(process.env.COLLECTOR_START_BATCH_SIZE || '') || 25;
            const startBatchDelayMs = parseInt(process.env.COLLECTOR_START_BATCH_DELAY_MS || '') || 1000;
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            let startedCount = 0;

            for (const source of sources) {
                // Start jika punya port ATAU parsing_id yang memiliki default port / tidak butuh port
                if (source.udp_port || source.tcp_port || PORTLESS_PARSERS.includes(source.parsing_id)) {
                    console.log(`[NetworkListener] Starting listener for ${source.name} (${source.parsing_id})`);
                    this.startListener(source); // Tidak di-await agar berjalan paralel dan tidak memblock loop
                    startedCount++;

                    if (startedCount % startBatchSize === 0) {
                        await sleep(startBatchDelayMs);
                    }
                }
            }

            console.log(`[NetworkListener] Finished initializing ${this.activeListeners.size} active listeners`);
        } catch (error) {
            console.error('[NetworkListener] Initialization error:', error);
        } finally {
            this._isInitializing = false;
            if (this._pendingReload) {
                this._pendingReload = false;
                this.initialize();
            }
        }
    }

    /**
     * Start a listener for a specific source
     * @param {Object} source - Source configuration from database
     */
    async startT6tvListener(source) {
        const { id, equipt_id, ip_address, tcp_port, extra_config } = source;
        const extra = extra_config ? (typeof extra_config === 'string' ? JSON.parse(extra_config) : extra_config) : {};
        const port = parseInt(tcp_port) || 80;
        const wsPath = extra.ws_path || '/ws';
        const username = extra.username || 'admin';
        const password = extra.password || 'admin';
        const pollMs = (extra.interval || 5) * 1000;
        const configuredFallbackPorts = Array.isArray(extra.fallback_ports)
            ? extra.fallback_ports
            : (Array.isArray(extra.fallbackPorts) ? extra.fallbackPorts : []);
        const fallbackPorts = [...configuredFallbackPorts];
        if (port !== 80 && !fallbackPorts.includes(80)) fallbackPorts.push(80);

        const portPlan = [port, ...fallbackPorts].filter((p, i, arr) => arr.indexOf(p) === i).join(' -> ');
        console.log(`[NetworkListener] Starting T6TV WS for ${source.name} at ${ip_address}:${port}${wsPath} (ports: ${portPlan})`);

        const T6tvConnector = require('../connection/t6tv_connector');
        const VhfT6tvParser = require('../parsers/vhf_t6tv');
        const parser = new VhfT6tvParser({ equipt_id });

        const onData = async (rawData) => {
            await this.handleIncomingData(source, rawData, parser);
        };
        const onError = (err) => {
            console.error(`[NetworkListener] T6TV error for ${source.name}:`, err.message || err);
            this._handleLogOutput(source, { data: {}, source: source.name, _ip: ip_address }, 'vhf_t6tv', 'Disconnect').catch(e => console.error(e));
        };

        const connector = new T6tvConnector(
            id,
            ip_address,
            port,
            username,
            password,
            wsPath,
            pollMs,
            onData,
            onError,
            { fallbackPorts }
        );
        connector.start();
        this.activeListeners.add(id);
        this._t6tvConnectors = this._t6tvConnectors || new Map();
        this._t6tvConnectors.set(id, connector);
        console.log(`[NetworkListener] T6TV listener active for ${source.name}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VHF T6TV via SNMP (pengganti WebSocket untuk device yang sudah support SNMP)
    // ─────────────────────────────────────────────────────────────────────────
    startT6tvSnmpListener(source) {
        const { id, equipt_id, ip_address, name, community, poll_interval, extra_config } = source;

        // Ambil config: community dan interval bisa dari kolom khusus atau extra_config JSON
        let comm = community || 'public';
        let pollSec = parseInt(poll_interval) || 30;

        if (extra_config) {
            try {
                const extra = typeof extra_config === 'string' ? JSON.parse(extra_config) : extra_config;
                if (extra.community) comm = extra.community;
                if (extra.interval) pollSec = parseInt(extra.interval);
            } catch (e) {
                console.warn(`[T6TV SNMP] Invalid extra_config for ${name}`);
            }
        }

        const VhfT6tvSnmpCollector = require('../parsers/vhf_t6tv_snmp');
        const collector = new VhfT6tvSnmpCollector({
            host: ip_address,
            community: comm,
            interval: pollSec * 1000,
            timeout: 5000,
            retries: 1,
        });

        collector.on('data', async (result) => {
            try {
                const logStatus = result.success ? (result.status || 'Normal') : 'Disconnect';

                await this._handleLogOutput(
                    source,
                    {
                        data: result.data || {},
                        source: name,
                        _ip: ip_address,
                        _triggered: result.triggeredParams || [],
                    },
                    'vhf_t6tv_snmp',
                    logStatus
                );

                if (result.success) {
                    console.log(`[T6TV SNMP] ${name}: status=${logStatus} freq=${result.data?.tx_frequency_mhz || '?'} MHz`);
                } else {
                    this._logThrottled('warn', `t6tv-snmp:fail:${id}`, `[T6TV SNMP] Poll failed for ${name}: ${result.error || 'unknown'}`);
                }
            } catch (err) {
                console.error(`[T6TV SNMP] handleLogOutput error for ${name}:`, err.message);
            }
        });

        collector.on('error', (err) => {
            this._logThrottled('error', `t6tv-snmp:error:${id}:${err.message}`, `[T6TV SNMP] Error for ${name}: ${err.message}`);
        });

        collector.start();
        this.activeListeners.add(id);

        // Simpan collector untuk keperluan cleanup (stopAll)
        this._t6tvSnmpCollectors = this._t6tvSnmpCollectors || new Map();
        this._t6tvSnmpCollectors.set(id, collector);

        console.log(`[T6TV SNMP] Listener started: ${name} (${ip_address}, community=${comm}, interval=${pollSec}s)`);
    }

    /**
     * Dedicated TCP listener untuk Modbus RTU-over-TCP (seperti PM5560 atau Datakom D700).
     * Menggunakan net.Socket langsung, langsung forward tiap chunk ke parser.
     */
    startModbusTcpListener(source, moduleName) {
        const net = require('net');
        const { id, equipt_id, ip_address, tcp_port } = source;
        const port = parseInt(tcp_port) || 502;

        const ParserModule = require('../parsers/' + moduleName);
        const parser = new ParserModule({ equipt_id });

        let socket = null;
        let stopped = false;
        let lastReceivedTime = 0;

        const connect = () => {
            if (stopped) return;
            socket = new net.Socket();
            // Use dynamic timeout based on poll interval (add 15s padding)
            const pollInterval = ParserModule.POLL_INTERVAL || 15000;
            socket.setTimeout(pollInterval + 15000);

            socket.connect(port, ip_address, () => {
                console.log(`[NetworkListener] PM5560 TCP connected: ${source.name} (${ip_address}:${port})`);
                this.activeListeners.add(id);
                this._pm5560Sockets = this._pm5560Sockets || new Map();
                this._pm5560Sockets.set(id, socket);
                startPollLoop();
            });

            // Forward chunk langsung ke parser — tanpa buffering tambahan
            socket.on('data', async (chunk) => {
                lastReceivedTime = Date.now();
                await this.handleIncomingData(source, chunk, parser);
            });

            const reportDisconnect = (reason) => {
                this._handleLogOutput(source, { data: {}, source: source.name, _ip: ip_address }, moduleName, 'Disconnect').catch(e => { });
            };

            socket.on('error', (err) => {
                this._logThrottled('error', `${moduleName}:error:${id}:${err.message}`, `[NetworkListener] ${moduleName} error ${source.name}: ${err.message}`);
                reportDisconnect(err.message);
            });

            socket.on('timeout', () => {
                this._logThrottled('warn', `${moduleName}:timeout:${id}`, `[NetworkListener] ${moduleName} timeout ${source.name}, reconnecting...`);
                reportDisconnect('timeout');
                socket.destroy();
            });

            socket.on('close', () => {
                this._logThrottled('log', `${moduleName}:close:${id}`, `[NetworkListener] ${moduleName} disconnected ${source.name}, watchdog will restart listener`);
                reportDisconnect('close');
                this.activeListeners.delete(id);
                parser.reset();
            });
        };

        // Polling loop: kirim semua request tiap POLL_INTERVAL
        const POLL_INTERVAL = ParserModule.POLL_INTERVAL;
        const POLL_REQ_DELAY = ParserModule.POLL_REQ_DELAY;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        let pollTimer = null;

        const doPoll = async () => {
            if (lastReceivedTime > 0 && (Date.now() - lastReceivedTime < 25000)) {
                // If we received data in the last 25 seconds (sniffed from SCADA), skip active polling to avoid RS485 collision!
                return;
            }

            const s = socket;
            if (!s || s.destroyed) return;
            const requests = parser.getPollRequests();
            for (const req of requests) {
                if (!s || s.destroyed) break;
                try {
                    s.write(req.bytes);
                    await sleep(POLL_REQ_DELAY);
                } catch (e) {
                    console.warn(`[NetworkListener] ${moduleName} write error ${source.name}: ${e.message}`);
                }
            }
            console.log(`[NetworkListener] ${moduleName} poll sent for ${source.name}`);
        };

        const startPollLoop = () => {
            if (pollTimer) clearInterval(pollTimer);
            // Kirim langsung saat connect, lalu ulangi tiap POLL_INTERVAL
            doPoll();
            pollTimer = setInterval(doPoll, POLL_INTERVAL);
        };

        connect();

        // Simpan cleanup handle
        this._modbusTcpCleanup = this._modbusTcpCleanup || new Map();
        this._modbusTcpCleanup.set(id, () => {
            stopped = true;
            if (pollTimer) clearInterval(pollTimer);
            if (socket) socket.destroy();
        });

        console.log(`[NetworkListener] ${moduleName} listener started for ${source.name}`);
    }

    /**
     * Dedicated binary TCP listener untuk ILS GP / LLZ (Thales 421).
     * Raw TCP stream langsung forward ke parser tanpa framing SOH/STX/ETX.
     * Pola sama dengan startPm5560Listener tapi tanpa polling loop
     * (GP/LLZ menggunakan passive streaming).
     */
    startBinaryTcpListener(source) {
        const net = require('net');
        const { id, equipt_id, ip_address, tcp_port, parsing_id, name } = source;
        const port = parseInt(tcp_port) || ((parsing_id === 'ils_mophien_llz' || parsing_id === 'ils_mophien_gp') ? 38317 : 950);

        // Petakan custom_id ke file js yang benar
        let moduleName = this._getParserModule(parsing_id);

        const ParserModule = require('../parsers/' + moduleName);
        const parser = new ParserModule({ equipt_id });

        // Cek apakah parser support protokol trigger+heartbeat atau polling
        const hasTriggerProtocol = typeof parser.isHeartbeat === 'function' &&
            typeof parser.getHeartbeatReply === 'function';
        const hasPollRequests = typeof parser.getPollRequests === 'function';

        console.log(`[ILS-TCP] Persistent worker initialized for ${name} (${ip_address}:${port}), module=${moduleName}`);

        let socket = null;
        let stopped = false;
        let reconnectTimer = null;
        let pollTimer = null;

        const scheduleReconnect = () => {
            if (stopped || reconnectTimer) return;
            // Backoff jeda 3 - 5 detik sesuai requirement
            const delay = 3000 + Math.floor(Math.random() * 2000);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (!stopped) {
                    console.log(`[ILS-TCP] Attempting auto-reconnect for ${name} (${ip_address}:${port}) in backoff mode...`);
                    connect();
                }
            }, delay);
        };

        const connect = () => {
            if (stopped) return;
            if (socket) {
                try { socket.destroy(); } catch (e) { }
                socket = null;
            }

            socket = new net.Socket();
            // Aktifkan TCP keepalive agar koneksi tidak diputus oleh router/firewall/NAT di jaringan bandara
            socket.setKeepAlive(true, 10000);
            socket.setNoDelay(true);

            // Untuk streaming pasif (sniffing) seperti ils_mophien_llz / ils_mophien_gp, jangan gunakan socket timeout pendek
            // agar koneksi tetap standby mendengarkan stream tanpa diputus paksa.
            if (moduleName !== 'ils_mophien_llz' && moduleName !== 'ils_mophien_gp') {
                socket.setTimeout(60000);
            }

            socket.connect(port, ip_address, () => {
                console.log(`[ILS-TCP] Connected to ${name} (${ip_address}:${port})`);
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                this.activeListeners.add(id);
                this._binaryTcpSockets = this._binaryTcpSockets || new Map();
                this._binaryTcpSockets.set(id, socket);

                // Catatan: ils_mophien_llz & ils_mophien_gp murni pasif (sniffing), TIDAK mengirim trigger/write apapun ke perangkat.

                // Emit status Normal dan data awal saat terkoneksi agar equipment langsung aktif di dashboard
                try {
                    const initResult = typeof parser.parse === 'function' ? parser.parse(Buffer.alloc(0)) : null;
                    if (initResult && initResult.success) {
                        this._handleLogOutput(
                            source,
                            { ...initResult, source: name, _ip: ip_address },
                            moduleName,
                            'Normal'
                        ).catch(e => { });
                    }
                } catch (e) { }

                // Kirim trigger secara berkala HANYA jika bukan ils_mophien_llz / ils_mophien_gp (karena murni sniffing pasif)
                if (moduleName !== 'ils_mophien_llz' && moduleName !== 'ils_mophien_gp' && (hasTriggerProtocol || hasPollRequests)) {
                    const doPoll = () => {
                        let triggerReqs = [];
                        if (hasPollRequests) {
                            triggerReqs = parser.getPollRequests() || [];
                        } else if (hasTriggerProtocol && typeof parser.getHeartbeatReply === 'function') {
                            triggerReqs = [parser.getHeartbeatReply()];
                        }

                        for (const req of triggerReqs) {
                            try {
                                const bytes = req.bytes ? req.bytes : req;
                                socket.write(bytes);
                            } catch (e) {
                                console.warn(`[NetworkListener] TCP trigger write error ${name}: ${e.message}`);
                            }
                        }
                    };
                    doPoll();
                    pollTimer = setInterval(doPoll, 5000);
                }
            });

            if (!this._lastHeartbeatReply) this._lastHeartbeatReply = new Map();

            socket.on('data', async (chunk) => {
                if (moduleName === 'ils_mophien_llz') {
                    console.log(`[LLZ-TCP] Received ${chunk.length} bytes from ${name}: ${chunk.slice(0, 32).toString('hex')}...`);
                }

                // Alirkan chunk mentah langsung ke parser & handler log/WebSocket
                await this.handleIncomingData(source, chunk, parser);
            });

            const reportDisconnect = (reason) => {
                // Untuk ils_mophien_llz, pertahankan data terakhir saat reconnect sesaat agar tampilan tidak kosong
                const cached = this._lkgvCache ? this._lkgvCache.get(source.id) : null;
                const fallbackData = (moduleName === 'ils_mophien_llz' && cached) ? cached : {};
                this._handleLogOutput(source, { data: fallbackData, source: source.name, _ip: ip_address }, moduleName, 'Disconnect').catch(e => { });
            };

            socket.on('error', (err) => {
                console.warn(`[LLZ-TCP] Socket error for ${name} (${ip_address}:${port}): ${err.message}`);
                this._logThrottled('error', `ils:error:${id}:${err.message}`, `[LLZ-TCP] Error ${name}: ${err.message}`);
                reportDisconnect(err.message);
                if (socket) {
                    try { socket.destroy(); } catch (e) { }
                }
                scheduleReconnect();
            });

            socket.on('timeout', () => {
                this._logThrottled('warn', `ils:timeout:${id}`, `[LLZ-TCP] Timeout ${name} (${ip_address}:${port}), reconnecting...`);
                reportDisconnect('timeout');
                if (socket) {
                    try { socket.destroy(); } catch (e) { }
                }
                scheduleReconnect();
            });

            socket.on('close', () => {
                console.log(`[LLZ-TCP] Connection closed for ${name} (${ip_address}:${port}). Auto-reconnecting...`);
                reportDisconnect('close');
                if (pollTimer) clearInterval(pollTimer);
                this.activeListeners.delete(id);
                scheduleReconnect();
            });
        };

        connect();

        this._binaryTcpCleanup = this._binaryTcpCleanup || new Map();
        this._binaryTcpCleanup.set(id, () => {
            stopped = true;
            if (pollTimer) clearInterval(pollTimer);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (socket) socket.destroy();
        });

        console.log(`[NetworkListener] ILS persistent TCP worker active for ${name}`);
    }

    /**
     * Passive Sniffer untuk ILS Mophien LLZ Juanda.
     * Menggunakan tcpdump atau tshark pada interface eth3 untuk menyadap paket port mirror
     * tanpa pernah menghubunginya langsung (0% beban ke alat & tidak rebutan koneksi dengan PC Surabaya).
     */
    startIlsMophienSnifferListener(source) {
        const { spawn } = require('child_process');
        const fs = require('fs');
        const { id, equipt_id, ip_address, tcp_port, parsing_id, name } = source;
        const port = parseInt(tcp_port) || 38317;

        let moduleName = this._getParserModule(parsing_id);
        const ParserModule = require('../parsers/' + moduleName);
        const parser = new ParserModule({ equipt_id });

        const iface = source.network_interface || 'eth3';
        console.log(`[LLZ-SNIFFER] Initializing passive packet sniffer for ${name} on interface ${iface} (port ${port}, host ${ip_address})...`);

        let snifferProc = null;
        let isStopped = false;
        let restartTimer = null;

        const isWindows = process.platform === 'win32';
        const candidates = isWindows
            ? [
                'C:\\Program Files\\Wireshark\\tshark.exe',
                'C:\\Program Files (x86)\\Wireshark\\tshark.exe',
                'tshark'
            ]
            : [
                '/usr/sbin/tcpdump',
                '/usr/bin/tcpdump',
                'tcpdump',
                '/usr/bin/tshark',
                '/usr/local/bin/tshark',
                'tshark'
            ];

        let chosenTool = isWindows ? 'C:\\Program Files\\Wireshark\\tshark.exe' : 'tcpdump';
        let isTshark = isWindows;
        for (const c of candidates) {
            if (fs.existsSync(c)) {
                chosenTool = c;
                isTshark = c.toLowerCase().includes('tshark');
                break;
            }
        }

        // Di Windows, nama interface bisa diatur lewat konfigurasi data source:
        // misal: "5", "Ethernet 3", atau "eth3"
        const resolveInterface = async () => {
            if (!isWindows || !isTshark) {
                return source.network_interface || 'eth3';
            }
            // Jika user langsung memasukkan angka indeks (misal: "5") di konfigurasi
            if (source.network_interface && /^\d+$/.test(String(source.network_interface).trim())) {
                return String(source.network_interface).trim();
            }

            const targetIfaceName = String(source.network_interface || 'Ethernet 3').toLowerCase().trim();

            const { exec } = require('child_process');
            return new Promise((resolve) => {
                exec(`"${chosenTool}" -D`, { windowsHide: true }, (err, stdout) => {
                    if (err || !stdout) {
                        return resolve('5'); // Default langsung ke 5 (Ethernet 3)
                    }
                    console.log(`[LLZ-SNIFFER] Available capture interfaces:\n${stdout.trim()}`);
                    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
                    
                    // Prioritas 1: Cocokkan persis nama kartu jaringan yang diminta oleh user jika ada (misal: "ethernet 2", "ethernet 4", dsb)
                    if (targetIfaceName) {
                        for (const line of lines) {
                            const m = line.match(/^(\d+)\.\s*(.*)/);
                            if (m) {
                                const idx = m[1];
                                const desc = m[2].toLowerCase();
                                if (desc.includes(targetIfaceName)) {
                                    return resolve(idx);
                                }
                            }
                        }
                    }

                    // Prioritas 2: Cocokkan 'ethernet 3' (kabel default port mirror Surabaya)
                    for (const line of lines) {
                        const m = line.match(/^(\d+)\.\s*(.*)/);
                        if (m) {
                            const idx = m[1];
                            const desc = m[2].toLowerCase();
                            if (desc.includes('ethernet 3')) {
                                return resolve(idx);
                            }
                        }
                    }

                    // Prioritas 3: Cocokkan sembarang ethernet yang aktif
                    for (const line of lines) {
                        const m = line.match(/^(\d+)\.\s*(.*)/);
                        if (m) {
                            const idx = m[1];
                            const desc = m[2].toLowerCase();
                            if (desc.includes('ethernet')) {
                                return resolve(idx);
                            }
                        }
                    }

                    resolve('5'); // Fallback ke 5
                });
            });
        };

        const runSniffer = async () => {
            if (isStopped) return;

            const iface = await resolveInterface();
            console.log(`[LLZ-SNIFFER] Selected capture interface index: "${iface}"`);

            // Filter capture: tangkap port TCP (38317) dan spesifik IP perangkat agar LLZ (10.62.3.20) dan GP (10.62.3.30) tidak saling tertukar
            const capturePort = port || 38317;
            const captureFilter = ip_address ? `tcp port ${capturePort} and host ${ip_address}` : `tcp port ${capturePort}`;
            let args = [];

            if (isTshark) {
                args = [
                    '-i', String(iface),
                    '-f', captureFilter,
                    '-T', 'fields',
                    '-e', 'ip.src',
                    '-e', 'tcp.payload',
                    '-l'
                ];
            } else {
                args = [
                    '-i', String(iface),
                    '-nn',
                    '-s', '0',
                    '-U',
                    '-xx',
                    captureFilter
                ];
            }

            try {
                console.log(`[LLZ-SNIFFER] Spawning passive sniffer: ${chosenTool} ${args.join(' ')}`);
                snifferProc = spawn(chosenTool, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                });

                this.activeListeners.add(id);

                // Kirim event status Normal saat sniffer aktif
                try {
                    const initResult = typeof parser.parse === 'function' ? parser.parse(Buffer.alloc(0)) : null;
                    if (initResult && initResult.success) {
                        this._handleLogOutput(
                            source,
                            { ...initResult, source: name, _ip: ip_address },
                            moduleName,
                            'Normal'
                        ).catch(e => { });
                    }
                } catch (e) { }

                let tcpdumpHexBuf = '';

                snifferProc.stdout.on('data', async (data) => {
                    const text = data.toString();
                    if (!text) return;

                    if (isTshark) {
                        const lines = text.split('\n');
                        for (let line of lines) {
                            line = line.trim();
                            if (!line) continue;
                            const parts = line.split('\t');
                            let hexStr = '';
                            if (parts.length >= 2) {
                                const srcIp = parts[0].trim();
                                // Jika source IP terdeteksi, pastikan hanya memproses paket dari IP perangkat yang sesuai
                                if (ip_address && srcIp && srcIp !== ip_address) {
                                    continue;
                                }
                                hexStr = parts[1].trim();
                            } else {
                                hexStr = parts[0].trim();
                            }

                            const payloads = hexStr.split(',');
                            for (let payload of payloads) {
                                payload = payload.replace(/[:\s]/g, '');
                                if (payload.length >= 8 && payload.length % 2 === 0) {
                                    const chunk = Buffer.from(payload, 'hex');
                                    // Log jika paket data telemetry LLZ/GP tertangkap (throttled 15s)
                                    if (chunk.includes(0x01) && chunk.includes(0x02)) {
                                        this._logThrottled('log', `llz-sniffer:live-packet:${id}`, `[ILS-SNIFFER] Captured live packet (${chunk.length} bytes) for ${name} [${ip_address}] (streaming active)`, 15000);
                                    }
                                    await this.handleIncomingData(source, chunk, parser);
                                }
                            }
                        }
                    } else {
                        // tcpdump -xx output parser:
                        // Baris diawali "0x0000:  0011 2233 4455 ..."
                        // Pisahkan per packet header (baris yang dimulai tanpa spasi / IP ...)
                        const lines = text.split('\n');
                        for (const line of lines) {
                            if (/^\s+0x[0-9a-fA-F]+:/.test(line)) {
                                const hexOnly = line.replace(/^\s+0x[0-9a-fA-F]+:\s+/, '').replace(/\s+/g, '');
                                tcpdumpHexBuf += hexOnly;
                            } else if (line.includes('IP ') || line.includes('IP6 ')) {
                                // Selesai 1 paket sebelumnya
                                if (tcpdumpHexBuf.length > 108) {
                                    // Ethernet (14 bytes = 28 hex) + IP header (20 bytes = 40 hex) + TCP header (~20-32 bytes = 40-64 hex)
                                    // Cari signature framing ILS LLZ: 0x01 0x02 (STX)
                                    const fullPacketBuf = Buffer.from(tcpdumpHexBuf, 'hex');
                                    const stxIndex = fullPacketBuf.indexOf(Buffer.from([0x01, 0x02]));
                                    if (stxIndex >= 0 && stxIndex < fullPacketBuf.length) {
                                        const payloadChunk = fullPacketBuf.slice(stxIndex);
                                        await this.handleIncomingData(source, payloadChunk, parser);
                                    }
                                }
                                tcpdumpHexBuf = '';
                            }
                        }
                    }
                });

                snifferProc.stderr.on('data', (data) => {
                    const msg = data.toString().trim();
                    if (!msg) return;
                    if (msg.includes('Capturing on') || msg.includes('Packets captured') || msg.includes('listening on')) {
                        console.log(`[LLZ-SNIFFER] ${msg}`);
                        return;
                    }
                    console.warn(`[LLZ-SNIFFER stderr] ${msg}`);
                });

                snifferProc.on('error', (err) => {
                    console.warn(`[LLZ-SNIFFER] Sniffer spawn error (${err.message}).`);
                });

                snifferProc.on('close', (code) => {
                    if (!isStopped) {
                        console.log(`[LLZ-SNIFFER] Sniffer process exited with code ${code}. Restarting in 5s...`);
                        restartTimer = setTimeout(runSniffer, 5000);
                    }
                });

            } catch (err) {
                console.error(`[LLZ-SNIFFER] Execution error: ${err.message}. Fallback to TCP listener.`);
                this.startBinaryTcpListener(source);
            }
        };

        runSniffer();

        this._binaryTcpCleanup = this._binaryTcpCleanup || new Map();
        this._binaryTcpCleanup.set(id, () => {
            isStopped = true;
            if (restartTimer) clearTimeout(restartTimer);
            if (snifferProc) {
                try { snifferProc.kill(); } catch (e) { }
            }
        });
    }



    /**
     * Listener untuk sensor suhu/kelembaban via Modbus TCP FC03 port 502.
     * Pola sama dengan PM5560 — 1 koneksi TCP per sensor, polling FC03 tiap interval.
     */
    startTempHumidityListener(source) {
        const { id, equipt_id, ip_address, tcp_port, name, poll_interval, extra_config, location } = source;
        const pollSec = parseInt(poll_interval) || 60; // Default 60 detik
        const port = parseInt(tcp_port) || 502;

        let slaveId = 1;
        if (extra_config) {
            try {
                const config = typeof extra_config === 'string' ? JSON.parse(extra_config) : extra_config;
                if (config.modbus_slave_id) slaveId = parseInt(config.modbus_slave_id);
            } catch (e) {
                console.warn(`[TempHumidity] Invalid extra_config for ${name}`);
            }
        }

        const { pollTempHumidity } = require('../parsers/temp_humidity_modbus');

        this.activeListeners.add(id);
        console.log(`[TempHumidity] Listener started: ${name} (${ip_address}:${port}, Slave ID: ${slaveId}, Poll: ${pollSec}s)`);

        let isPolling = false;
        const doPoll = async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const result = await pollTempHumidity(ip_address, port, slaveId);
                const logStatus = result.status || 'Disconnect';

                await this._handleLogOutput(
                    source,
                    {
                        data: {
                            ...result.data,
                            location: location || name
                        },
                        source: name,
                        _ip: ip_address
                    },
                    'temp_humidity_modbus',
                    logStatus
                );
            } catch (err) {
                console.error(`[TempHumidity] Poll error ${name}:`, err.message);
                throw err;
            } finally {
                isPolling = false;
            }
        };

        if (!this._tempHumidityTimers) this._tempHumidityTimers = new Map();
        this._startCircuitBreakerPolling({
            id,
            name,
            pollSec,
            timersMap: this._tempHumidityTimers,
            doPoll
        });

        // Cleanup handle
        this._tempHumidityCleanup = this._tempHumidityCleanup || new Map();
        this._tempHumidityCleanup.set(id, () => {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (pollTimer) clearInterval(pollTimer);
            if (socket) socket.destroy();
        });

        console.log(`[TempHumidity] Listener started for ${name} (${ip_address})`);
    }

    /**
     * Listener untuk MARC/RSE binary protocol via Moxa NPort TCP.
     * Satu shared client per IP:port — re-used oleh semua equipment yang
     * terhubung ke Moxa yang sama.
     */

    // ─────────────────────────────────────────────────────────────────────────
    // SNMP SYSTEM MONITOR (Server / Workstation / Switch)
    // ─────────────────────────────────────────────────────────────────────────
    startSnmpSystemListener(source) {
        const { id, equipt_id, ip_address, name, community, poll_interval, snmp_port, snmp_version } = source;
        const pollSec = parseInt(poll_interval) || 60;
        const comm = community || 'public';
        const port = parseInt(snmp_port) || 161;
        const version = snmp_version || '2c';

        const parserFile = source.parsing_id === 'snmp_network_basic' ? 'snmp_network_basic' : 'snmp_system';
        const { pollSNMP } = require(`../parsers/${parserFile}`);

        this.activeListeners.add(id);
        console.log(`[SNMP System] Listener started: ${name} (${ip_address}:${port}, v${version})`);

        let isPolling = false;
        const doPoll = async () => {
            if (isPolling) return;
            isPolling = true;
            console.log(`[SNMP System] Polling ${name} (${ip_address}:${port}, v${version})...`);
            try {
                // Ambil alarm limits dari DB untuk alat ini, agar threshold tidak hardcode di parser
                let limitsMap = null;
                try {
                    const rawLimits = await this.equipmentService.db.getLimitationsByEquipment(equipt_id);
                    if (Array.isArray(rawLimits) && rawLimits.length > 0) {
                        // Ubah format array [{ parameter, warn_value, alarm_value }] ke { [parameter]: { warn_value, alarm_value } }
                        limitsMap = {};
                        for (const lim of rawLimits) {
                            limitsMap[lim.parameter] = { warn_value: lim.warn_value, alarm_value: lim.alarm_value };
                        }
                    }
                } catch (limErr) {
                    // Jika gagal ambil limits, gunakan default — tidak perlu crash
                }
                const result = await pollSNMP(ip_address, comm, { port, version, limits: limitsMap });
                const logLine = `[SNMP System] ${name}: status=${result.status} cpu=${result.data.cpu_usage} ram=${result.data.ram_usage_pct} disk=${result.data.disk_usage_pct} err=${result.error || 'none'}`;
                if (String(result.status || '').toLowerCase() === 'disconnect') {
                    this._logThrottled('log', `snmp-system:disconnect:${id}`, logLine);
                } else {
                    console.log(logLine);
                }
                await this._handleLogOutput(
                    source,
                    { data: result.data, source: name, _ip: ip_address },
                    source.parsing_id || 'snmp_system',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[SNMP System] Poll error ${name}:`, err.message);
                throw err;
            } finally {
                isPolling = false;
            }
        };

        if (!this._snmpSystemTimers) this._snmpSystemTimers = new Map();
        this._startCircuitBreakerPolling({
            id,
            name,
            pollSec,
            timersMap: this._snmpSystemTimers,
            doPoll
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UPS NETAGENT SNMP MONITOR
    // ─────────────────────────────────────────────────────────────────────────
    startUpsNetagentListener(source) {
        const { id, equipt_id, ip_address, name, community, poll_interval, snmp_port, snmp_version } = source;
        const pollSec = parseInt(poll_interval) || 10;
        const comm = community || 'public';
        const port = parseInt(snmp_port) || 161;
        const version = snmp_version || '2c';

        const { pollUPSNetagent } = require('../parsers/ups_netagent_snmp');

        this.activeListeners.add(id);
        console.log(`[UPS SNMP] Listener started: ${name} (${ip_address}:${port}, v${version})`);

        let isPolling = false;
        const doPoll = async () => {
            if (isPolling) {
                console.log(`[UPS SNMP] Skiping poll for ${name}, previous poll still running`);
                return;
            }
            isPolling = true;
            try {
                const result = await pollUPSNetagent(ip_address, comm, {
                    port,
                    version,
                    name: source.name,
                    equipment_name: source.equipment_name || source.name
                });
                await this._handleLogOutput(
                    source,
                    { data: result.data, source: name, _ip: ip_address },
                    'ups_netagent_snmp',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[UPS SNMP] Poll error ${name}:`, err.message);
                throw err;
            } finally {
                isPolling = false;
            }
        };

        if (!this._upsNetagentTimers) this._upsNetagentTimers = new Map();
        this._startCircuitBreakerPolling({
            id,
            name,
            pollSec,
            timersMap: this._upsNetagentTimers,
            doPoll
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PM5350 Modbus RTU-over-TCP Poller
    // ─────────────────────────────────────────────────────────────────────────
    startPm5350Listener(source) {
        const { id, equipt_id, ip_address, tcp_port, name, poll_interval, extra_config } = source;
        const pollSec = parseInt(poll_interval) || 60; // Default 60 detik
        const port = parseInt(tcp_port) || 26;

        let slaveId = 5;
        if (extra_config) {
            try {
                const config = typeof extra_config === 'string' ? JSON.parse(extra_config) : extra_config;
                if (config.modbus_slave_id) slaveId = parseInt(config.modbus_slave_id);
            } catch (e) {
                console.warn(`[PM5350] Invalid extra_config for ${name}`);
            }
        }

        const { pollPM5350 } = require('../parsers/pm5350_modbus');

        this.activeListeners.add(id);
        console.log(`[PM5350] Listener started: ${name} (${ip_address}:${port}, Slave ID: ${slaveId}, Poll: ${pollSec}s)`);

        let isPolling = false;
        const doPoll = async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const result = await pollPM5350(ip_address, port, slaveId);
                await this._handleLogOutput(
                    source,
                    { data: result.data, source: name, _ip: ip_address },
                    'pm5350_modbus',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[PM5350] Poll error ${name}:`, err.message);
                throw err;
            } finally {
                isPolling = false;
            }
        };

        if (!this._pm5350Timers) this._pm5350Timers = new Map();
        this._startCircuitBreakerPolling({
            id,
            name,
            pollSec,
            timersMap: this._pm5350Timers,
            doPoll
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Moxa ioLogik 4000 (Modbus TCP)
    // ─────────────────────────────────────────────────────────────────────────
    startIologikModbusListener(source) {
        const { id, name, ip_address, tcp_port, poll_interval, extra_config } = source;
        const pollSec = parseInt(poll_interval) || 30; // Gunakan setting interval, default 30s
        const port = parseInt(tcp_port) || 502;
        let slaveId = 1;
        let devicesConfig = null;

        if (extra_config) {
            try {
                const config = typeof extra_config === 'string' ? JSON.parse(extra_config) : extra_config;
                if (config.modbus_slave_id) slaveId = parseInt(config.modbus_slave_id);
                if (config.devices) devicesConfig = config.devices;
            } catch (e) { }
        }

        const { pollIoLogik } = require('../parsers/iologik_modbus');

        this.activeListeners.add(id);
        console.log(`[ioLogik] Listener started: ${name} (${ip_address}:${port}, Poll: ${pollSec}s)`);

        let isPolling = false;
        const doPoll = async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const result = await pollIoLogik(ip_address, port, slaveId, devicesConfig);
                if (result.error && result.data) {
                    result.data.error = result.error;
                }
                await this._handleLogOutput(
                    source,
                    { data: result.data, source: name, _ip: ip_address },
                    'iologik_modbus',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[ioLogik] Poll error ${name}:`, err.message);
                throw err;
            } finally {
                isPolling = false;
            }
        };

        if (!this._iologikTimers) this._iologikTimers = new Map();
        this._startCircuitBreakerPolling({
            id,
            name,
            pollSec,
            timersMap: this._iologikTimers,
            doPoll
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ASTERIX UDP MULTICAST (Radar CAT034 + ADS-B CAT021)
    // ─────────────────────────────────────────────────────────────────────────
    startAsterixListener(source, parserId) {
        const dgram = require('dgram');
        const { id, equipt_id, name, ip_address, udp_port,
            lat, lon, location, sac, sic,
            multicast_ip, multicast_port, timeout_ms } = source;

        const port = parseInt(udp_port) || (parserId === 'asterix_adsb' ? 50000 : 4001);
        const mcastIp = multicast_ip || ip_address;

        const ParserClass = require('../parsers/' + parserId);
        const parser = new ParserClass({
            equipt_id,
            name: location || name,
            lat: lat || 0,
            lon: lon || 0,
            sac: sac || 0,
            sic: sic || 0,
            multicast_ip: mcastIp,
            multicast_port: multicast_port || port,
            timeout_ms: timeout_ms || 5000,
        });

        if (!this._asterixSockets) this._asterixSockets = new Map();
        if (!this._asterixParsers) this._asterixParsers = new Map();
        if (!this._asterixTimers) this._asterixTimers = new Map();

        const socketKey = `asterix_udp_${mcastIp}_${port}`;
        if (!this._asterixParsers.has(socketKey)) this._asterixParsers.set(socketKey, new Map());
        this._asterixParsers.get(socketKey).set(id, { parser, source, parserId });

        if (!this._asterixSockets.has(socketKey)) {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            sock.on('message', async (msg, rinfo) => {
                const parsersOnSocket = this._asterixParsers.get(socketKey);
                if (!parsersOnSocket) return;
                for (const [srcId, entry] of parsersOnSocket) {
                    // Filter berdasarkan source IP jika ada, agar data tidak nyasar ke radar lain
                    // KECUALI jika IP tersebut adalah IP Multicast (dimulai dengan 224-239)
                    if (entry.source.ip_address && entry.source.ip_address !== rinfo.address) {
                        const firstOctet = parseInt(entry.source.ip_address.split('.')[0] || '0', 10);
                        const isMulticast = firstOctet >= 224 && firstOctet <= 239;
                        if (!isMulticast && entry.source.ip_address !== '0.0.0.0') {
                            continue;
                        }
                    }
                    const result = entry.parser.parse(msg);
                    if (!result) continue;
                    try {
                        await this._handleLogOutput(
                            entry.source,
                            { data: result.data, source: entry.source.name, _ip: rinfo.address },
                            entry.parserId,
                            result.status || 'Disconnect'
                        );
                    } catch (err) {
                        console.error(`[Asterix] saveToLogs error ${entry.source.name}:`, err.message);
                    }
                }
            });

            sock.on('error', err => console.error(`[Asterix] UDP error port ${port}:`, err.message));

            sock.bind(port, () => {
                try {
                    sock.addMembership(mcastIp);
                    console.log(`[Asterix] Joined multicast ${mcastIp}:${port} on default interface`);
                } catch (e) {
                    console.warn(`[Asterix] Multicast join failed on default interface ${mcastIp}:${port}: ${e.message}`);
                }

                // Attempt to bind to all active IPv4 interfaces
                const os = require('os');
                const interfaces = os.networkInterfaces();
                for (const name of Object.keys(interfaces)) {
                    for (const iface of interfaces[name]) {
                        if (iface.family === 'IPv4' && !iface.internal) {
                            try {
                                sock.addMembership(mcastIp, iface.address);
                                console.log(`[Asterix] Joined multicast ${mcastIp}:${port} on interface ${iface.address}`);
                            } catch (e) {
                                // Ignore failure on secondary interfaces
                            }
                        }
                    }
                }
            });

            this._asterixSockets.set(socketKey, sock);
        }

        this.activeListeners.add(id);

        const timeoutCheck = setInterval(async () => {
            const result = parser.checkTimeout();
            if (result) {
                try {
                    await this._handleLogOutput(
                        source,
                        { data: result.data, source: name, _ip: ip_address },
                        parserId,
                        'Disconnect'
                    );
                } catch (err) { }
            }
        }, 5000);

        this._asterixTimers.set(id, timeoutCheck);
        console.log(`[Asterix] Listener started: ${name} (${mcastIp}:${port} / ${parserId})`);
    }

    startMarcRseListener(source) {
        const { id, equipt_id, ip_address, tcp_port, marc_ports, poll_interval, name } = source;
        const port = parseInt(tcp_port) || 950;
        const ports = Array.isArray(marc_ports) ? marc_ports : [];
        const pollSec = parseInt(poll_interval) || 30;

        const VhfMarcRseParser = require('../parsers/vhf_marc_rse');
        const { getOrCreateClient } = VhfMarcRseParser._internal;

        // Pastikan shared client berjalan
        const client = getOrCreateClient(ip_address, port, pollSec);

        // Buat parser dengan marc_ports equipment ini
        const parser = new VhfMarcRseParser({
            equipt_id,
            host: ip_address,
            port: port,
            marc_ports: ports,
            poll_interval: pollSec,
        });

        this.activeListeners.add(id);

        // Poll parser setiap pollSec detik — 1 source = 1 radio = 1 log entry
        // source name = src.name (nama source config) → jadi key lastData di frontend
        const pollMs = pollSec * 1000;
        let isPolling = false;
        const pollTimer = setInterval(async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const result = parser.parse(null);
                if (!result.success || !result.data || !result.data.radios) return;

                const radios = result.data.radios;

                // Karena 1 source = 1 marc_port, ambil radio untuk port ini saja
                for (const [portStr, radioState] of Object.entries(radios)) {
                    const radioData = {
                        frequency_mhz: radioState.frequency_mhz,
                        mode: radioState.mode,
                        status: radioState.status,
                        supply_voltage: radioState.supply_voltage,
                        pa_temp_c: radioState.pa_temp_c,
                        fwd_power_w: radioState.fwd_power_w,
                        refl_power_w: radioState.refl_power_w,
                        modulation_pct: radioState.modulation_pct,
                        sensitivity_dbm: radioState.sensitivity_dbm,
                        squelch_dbm: radioState.squelch_dbm,
                        rx_supply_voltage: radioState.rx_supply_voltage,
                        radio_type: radioState.radio_type,
                        is_rx: radioState.is_rx,
                    };

                    const radioStatus = radioState.connected
                        ? (radioState.status === 'ALARM' ? 'Alarm' : 'Normal')
                        : 'Disconnect';

                    // source = name (nama source config = nama radio)
                    // ini yang jadi key di lastData frontend
                    await this._handleLogOutput(
                        source,
                        { data: radioData, source: name, _ip: ip_address },
                        'vhf_marc_rse',
                        radioStatus
                    );
                }
                console.log(`[NetworkListener] MARC RSE logged for ${name}`);
            } catch (err) {
                console.error(`[NetworkListener] MARC RSE poll error for ${name}:`, err.message);
            } finally {
                isPolling = false;
            }
        }, pollMs);

        this._marcPollTimers = this._marcPollTimers || new Map();
        this._marcPollTimers.set(id, pollTimer);

    }

    startMarcPaeListener(source) {
        const { id, equipt_id, ip_address, tcp_port, poll_interval, name, extra_config } = source;
        const port = parseInt(tcp_port) || 950;
        const pollSec = parseInt(poll_interval) || 30;

        let rseConfigs = [];
        if (typeof extra_config === 'string') {
            try {
                const parsed = JSON.parse(extra_config);
                if (parsed.rse_configs) rseConfigs = parsed.rse_configs;
            } catch (e) { }
        } else if (extra_config && extra_config.rse_configs) {
            rseConfigs = extra_config.rse_configs;
        }

        const MarcPaeParser = require('../parsers/marc_pae');
        const { getOrCreateClient } = MarcPaeParser._internal;

        // Pastikan shared client berjalan
        const client = getOrCreateClient(ip_address, port, pollSec);

        // Buat parser
        const parser = new MarcPaeParser({
            equipt_id,
            host: ip_address,
            port: port,
            rse_configs: rseConfigs,
            poll_interval: pollSec,
        });

        this.activeListeners.add(id);

        const pollMs = pollSec * 1000;
        let isPolling = false;
        const pollTimer = setInterval(async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const result = parser.parse(null);
                if (!result.success || !result.data || !result.data.rses) return;

                const rses = result.data.rses;

                for (const rse of rses) {
                    const rseId = rse.rse_id;
                    const radios = rse.radios;

                    for (const [portStr, radioState] of Object.entries(radios)) {
                        const radioData = {
                            frequency_mhz: radioState.frequency_mhz,
                            mode: radioState.mode,
                            status: radioState.status,
                            supply_voltage: radioState.supply_voltage,
                            pa_temp_c: radioState.pa_temp_c,
                            fwd_power_w: radioState.fwd_power_w,
                            refl_power_w: radioState.refl_power_w,
                            modulation_pct: radioState.modulation_pct,
                            sensitivity_dbm: radioState.sensitivity_dbm,
                            squelch_dbm: radioState.squelch_dbm,
                            rx_supply_voltage: radioState.rx_supply_voltage,
                            rse_id: rseId,
                            port: parseInt(portStr, 10),
                            name: radioState.name
                        };

                        const flatData = {
                            ...result.data,
                            radio: radioData,
                            marc_port: parseInt(portStr, 10),
                            rse_id: rseId
                        };
                        delete flatData.rses; // Clean up

                        // Simulate push
                        await this.handleIncomingData(source, Buffer.from([]), {
                            parse: () => ({
                                success: true,
                                data: flatData,
                                status: radioState.status === 'ALARM' ? 'Alarm' : 'Normal',
                                alarms: radioState.status === 'ALARM' ? ['Radio ALARM'] : [],
                                warnings: [],
                                timestamp: new Date().toISOString()
                            })
                        });
                    }
                }
            } catch (err) {
                console.error(`[NetworkListener] MARC PAE Error ${name}:`, err.message);
            } finally {
                isPolling = false;
            }
        }, pollMs);
        this._marcPaeTimers = this._marcPaeTimers || new Map();
        this._marcPaeTimers.set(id, pollTimer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DATAKOM D700 Poller
    // ─────────────────────────────────────────────────────────────────────────
    startDatakomListener(source) {
        const { id, equipt_id, ip_address, tcp_port, name, poll_interval } = source;
        const pollSec = parseInt(poll_interval) || 5;
        const port = parseInt(tcp_port) || 502;
        let slaveId = 1; // Default Datakom

        const { pollDatakomD700 } = require('../parsers/datakom_d700_modbus');

        this.activeListeners.add(id);
        console.log(`[Datakom D700] Listener started: ${name} (${ip_address}:${port}, Slave ID: ${slaveId})`);

        let isPolling = false;
        const doPoll = async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const result = await pollDatakomD700(ip_address, port, slaveId);
                const logLine = `[Datakom D700] ${name}: status=${result.status}`;

                if (String(result.status || '').toLowerCase() === 'disconnect') {
                    this._logThrottled('log', `datakom:disconnect:${id}`, logLine);
                }

                // LogData HARUS berisi semua metadata (success, status, alarms, dll)
                const logData = {
                    ...result,
                    source: name,
                    _ip: ip_address
                };

                await this._handleLogOutput(
                    source,
                    logData,
                    'datakom_d700_modbus',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[Datakom D700] Poll error ${name}:`, err.message);
            } finally {
                isPolling = false;
            }
        };

        const initialDelay = 1000 + Math.floor(Math.random() * 2000);
        setTimeout(() => {
            doPoll();
            const timer = setInterval(doPoll, pollSec * 1000);

            if (!this._datakomTimers) this._datakomTimers = new Map();
            this._datakomTimers.set(id, timer);
        }, initialDelay);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DSE7320 Poller
    // ─────────────────────────────────────────────────────────────────────────
    startDse7320Listener(source) {
        const { id, equipt_id, ip_address, tcp_port, name, poll_interval, extra_config } = source;
        const pollSec = parseInt(poll_interval) || 5;
        const port = parseInt(tcp_port) || 502;

        let slaveId = 10; // Default DSE7320 unit ID
        if (extra_config) {
            try {
                const config = typeof extra_config === 'string' ? JSON.parse(extra_config) : extra_config;
                if (config.modbus_slave_id) slaveId = parseInt(config.modbus_slave_id);
                // Dukung juga jika user menulis unit_id di config
                if (config.unit_id) slaveId = parseInt(config.unit_id);
            } catch (e) {
                console.warn(`[DSE7320] Invalid extra_config for ${name}`);
            }
        }

        const { pollDse7320 } = require('../parsers/dse7320_modbus');

        this.activeListeners.add(id);
        console.log(`[DSE7320] Listener started: ${name} (${ip_address}:${port}, Slave ID: ${slaveId})`);

        let isPolling = false;
        const doPoll = async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const result = await pollDse7320(ip_address, port, slaveId);
                const logLine = `[DSE7320] ${name}: status=${result.status}`;

                if (String(result.status || '').toLowerCase() === 'disconnect') {
                    this._logThrottled('log', `dse7320:disconnect:${id}`, logLine);
                }

                // LogData HARUS berisi semua metadata (success, status, alarms, dll)
                const logData = {
                    ...result,
                    source: name,
                    _ip: ip_address
                };

                await this._handleLogOutput(
                    source,
                    logData,
                    'dse7320_modbus',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[DSE7320] Poll error ${name}:`, err.message);
                throw err;
            } finally {
                isPolling = false;
            }
        };

        if (!this._dseTimers) this._dseTimers = new Map();
        this._startCircuitBreakerPolling({
            id,
            name,
            pollSec,
            timersMap: this._dseTimers,
            doPoll
        });
    }

    _getParserModule(parsing_id) {
        if (!parsing_id || !parsing_id.startsWith('custom_')) return parsing_id;
        try {
            const fs = require('fs');
            const path = require('path');
            const configs = JSON.parse(fs.readFileSync(path.join(__dirname, '../../db/equipment_parsing_config.json'), 'utf8'));
            const custom = configs.find(c => c.id === parsing_id);
            if (custom && custom.files) {
                const basename = path.basename(custom.files, '.js');
                // Auto-correct if user accidentally chose factory.js or base.js
                if (basename === 'factory' || basename === 'base' || !basename) {
                    const nameLower = (custom.name || '').toLowerCase();
                    if (nameLower.includes('vhf')) return 'vhf_t6tv';
                    if (nameLower.includes('glide') || nameLower.includes('gp')) return 'ils_gp_normac';
                    if (nameLower.includes('localizer') || nameLower.includes('llz')) return 'ils_llz_normac';
                }
                return basename;
            }
        } catch (e) {
            console.warn(`[NetworkListener] Error resolving custom parser ${parsing_id}:`, e.message);
        }
        return parsing_id;
    }

    async startHttpPullListener(source, parser) {
        const { id, name, ip_address, tcp_port, udp_port } = source;
        const port = tcp_port || udp_port || 80;

        this.activeListeners.add(id);
        console.log(`[HTTP Pull] Listener started: ${name} (${ip_address}:${port})`);

        let isPolling = false;

        // Use POLL_INTERVAL if available in parser config, otherwise default to 15 seconds
        let pollIntervalMs = (parser.parserConfig && parser.parserConfig.poll_interval)
            ? parseInt(parser.parserConfig.poll_interval)
            : 15000;
        if (pollIntervalMs < 1000) pollIntervalMs *= 1000;

        const doPoll = async () => {
            if (isPolling || !this.activeListeners.has(id)) return;
            isPolling = true;
            try {
                const result = await parser.fetchApiData(ip_address, port);
                if (String(result.status || '').toLowerCase() === 'error') {
                    this._logThrottled('log', `http-pull:error:${id}`, `[HTTP Pull] ${name}: Error ${result.error}`, 30000);
                }

                await this._handleLogOutput(
                    source,
                    { data: result.data, source: name, _ip: ip_address },
                    'universal_api',
                    result.status || (result.success ? 'Normal' : 'Disconnect')
                );
            } catch (err) {
                console.error(`[HTTP Pull] Poll error ${name}:`, err.message);
            } finally {
                isPolling = false;
            }
        };

        // Random jitter to prevent thundering herd
        const jitter = Math.floor(Math.random() * 5000);
        setTimeout(() => {
            doPoll();
            const timerId = setInterval(doPoll, pollIntervalMs);

            // Store timer if we need to clean it up later (optional)
            if (!this._httpTimers) this._httpTimers = new Map();
            if (this._httpTimers.has(id)) clearInterval(this._httpTimers.get(id));
            this._httpTimers.set(id, timerId);
        }, jitter);
    }

    async startListener(source) {
        const { id, equipt_id, ip_address, udp_port, tcp_port, parsing_id } = source;
        const port = parseInt(udp_port || tcp_port);
        const protocol = udp_port ? 'udp' : 'tcp';

        const moduleName = this._getParserModule(parsing_id);

        // T6TV uses SNMP — pull-based, no port needed
        if (moduleName === 'vhf_t6tv_snmp') {
            this.startT6tvSnmpListener(source);
            return;
        }

        // T6TV uses WebSocket
        if (moduleName === 'vhf_t6tv') {
            this.startT6tvListener(source);
            return;
        }

        // Modbus TCP parsers (PM5560, Datakom D700, Diris A20) — dedicated raw TCP handler
        if (moduleName === 'pm5560_modbus' || moduleName === 'diris_a20') {
            this.startModbusTcpListener(source, moduleName);
            return;
        }

        if (moduleName === 'datakom_d700_modbus') {
            this.startDatakomListener(source);
            return;
        }

        if (moduleName === 'dse7320_modbus') {
            this.startDse7320Listener(source);
            return;
        }

        // ILS Mophien LLZ & GP Juanda — Gunakan dedicated passive packet sniffer di interface mirror
        if (moduleName === 'ils_mophien_llz' || moduleName === 'ils_mophien_gp') {
            console.log(`[ILS-TRACE] Routing ${source.name} to startIlsMophienSnifferListener (Passive Sniffing on mirror interface)`);
            this.startIlsMophienSnifferListener(source);
            return;
        }

        // ILS GP / LLZ Normac / Thales — binary streaming TCP, bypass SOH/STX/ETX buffering
        if (moduleName === 'ils_gp_thales421' || moduleName === 'ils_llz_thales421' || moduleName === 'ils_gp_normac' || moduleName === 'ils_gp_normac7030' || moduleName === 'ils_llz_normac' || moduleName === 'ils_llz_normac7030' || moduleName === 'ils_mm_normac' || moduleName === 'ils_mm_normac7030') {
            console.log(`[LLZ-TRACE] Routing ${source.name} to startBinaryTcpListener`);
            this.startBinaryTcpListener(source);
            return;
        }

        // Temp/Humidity sensor — Modbus TCP FC03 port 502
        if (moduleName === 'temp_humidity_modbus') {
            this.startTempHumidityListener(source);
            return;
        }

        // MARC RSE — shared TCP client, binary SLIP protocol
        if (moduleName === 'vhf_marc_rse') {
            this.startMarcRseListener(source);
            return;
        }

        // MARC PAE
        if (moduleName === 'marc_pae') {
            this.startMarcPaeListener(source);
            return;
        }

        // SNMP System Monitor (Server/Workstation/Switch)
        if (moduleName === 'snmp_system' || moduleName === 'snmp_host_resources_01' || moduleName === 'snmp_network_basic') {
            this.startSnmpSystemListener(source);
            return;
        }

        // UPS SNMP Monitor
        if (moduleName === 'ups_netagent_snmp') {
            this.startUpsNetagentListener(source);
            return;
        }

        // PM5350 Modbus Monitor
        if (moduleName === 'pm5350_modbus') {
            this.startPm5350Listener(source);
            return;
        }

        // Moxa ioLogik 4000 Modbus
        if (moduleName === 'iologik_modbus') {
            this.startIologikModbusListener(source);
            return;
        }

        // ASTERIX Radar CAT034 (UDP multicast per site)
        if (moduleName === 'asterix_radar') {
            this.startAsterixListener(source, 'asterix_radar');
            return;
        }

        // ASTERIX ADS-B CAT021 (UDP multicast shared port 50000)
        if (parsing_id === 'asterix_adsb') {
            this.startAsterixListener(source, 'asterix_adsb');
            return;
        }

        if (isNaN(port)) {
            console.warn(`[NetworkListener] Invalid port for source ${id}: ${udp_port || tcp_port}`);
            return;
        }

        console.log(`[NetworkListener] Starting listener for ${source.name} on port ${port} (parser: ${parsing_id})...`);

        // 1. Create Parser (or reuse existing one to preserve _lastData across TCP drops)
        let parser = this.parsers.get(id);
        if (!parser && parsing_id) {
            let pConfig = { equipt_id, name: source.name || '' };
            if (source.extra_config) {
                pConfig.parser_config = typeof source.extra_config === 'string' ? JSON.parse(source.extra_config) : source.extra_config;
            }
            parser = ParserFactory.createParser(parsing_id, pConfig);
            if (parser) this.parsers.set(id, parser);
        }

        if (!parser) {
            console.warn(`[NetworkListener] No valid parser found for parsing_id: ${parsing_id}. Data will be logged as raw.`);
        }

        // --- HTTP PULL MODE ---
        if (parser && parser.isHttpPull) {
            this.startHttpPullListener(source, parser);
            return;
        }

        // 2. Bind Socket
        const onData = async (rawData) => {
            await this.handleIncomingData(source, rawData, parser);
        };

        // Generasi token — increment tiap reconnect agar loop lama berhenti
        this._pollGen = this._pollGen || {};
        this._pollGen[id] = (this._pollGen[id] || 0) + 1;
        const myGen = this._pollGen[id];

        if (!this._reconnectTimers) this._reconnectTimers = new Map();

        const scheduleReconnect = () => {
            if (protocol !== 'tcp') return;
            // Cegah duplikasi timer reconnect untuk sumber yang sama
            if (this._reconnectTimers.has(id)) return;

            // Pastikan listener dikeluarkan dari activeListeners agar polling loop lama berhenti
            this.activeListeners.delete(id);
            if (parser && typeof parser.reset === 'function') parser.reset();

            // Laporkan status Disconnect ke dashboard / database logs
            this._handleLogOutput(
                source,
                { data: {}, source: source.name, _ip: ip_address },
                parsing_id,
                'Disconnect'
            ).catch(() => { });

            // Jittered backoff (8 - 12 detik) agar tidak membebani CPU, network, maupun switch/Moxa
            const retryDelayMs = 8000 + Math.floor(Math.random() * 4000);
            this._logThrottled(
                'warn',
                `tcp:reconnect:${id}`,
                `[NetworkListener] TCP disconnected for ${source.name} (${id}), auto-reconnect scheduled in ${Math.round(retryDelayMs / 1000)}s...`,
                30000
            );

            const timer = setTimeout(async () => {
                this._reconnectTimers.delete(id);
                // Batalkan jika service sedang dihentikan / inisialisasi ulang atau sudah aktif
                if (this._isInitializing || this.activeListeners.has(id)) return;
                console.log(`[NetworkListener] Attempting auto-reconnect for ${source.name} (${ip_address}:${port})...`);
                try {
                    await this.startListener(source);
                } catch (e) {
                    console.error(`[NetworkListener] Reconnect error for ${source.name}:`, e.message);
                }
            }, retryDelayMs);

            this._reconnectTimers.set(id, timer);
        };

        const onError = (error) => {
            this._logThrottled(
                'error',
                `tcp:error:${id}:${error.message}`,
                `[NetworkListener] Error for source ${source.name} (${id}): ${error.message}`,
                15000
            );

            if (protocol === 'tcp') {
                scheduleReconnect();
            }
        };

        let success = false;

        // Mode TCP langsung untuk DME / DVOR
        if (protocol === 'udp') {
            success = connectionManager.connectUDP(id, ip_address || '0.0.0.0', port, onData, onError);
        } else {
            success = await connectionManager.connectTCP(id, ip_address || '0.0.0.0', port, onData, onError);
        }

        if (success) {
            // Berhasil tersambung — bersihkan pending reconnect timer jika ada
            if (this._reconnectTimers.has(id)) {
                clearTimeout(this._reconnectTimers.get(id));
                this._reconnectTimers.delete(id);
            }

            this.activeListeners.add(id);
            console.log(`[NetworkListener] Listener active for ${source.name} on port ${port}`);

            // Start ACTIVE polling loop for TCP parsers that support it (e.g. DVOR Maru 220)
            if (protocol === 'tcp' && parser && typeof parser.getPollRequests === 'function') {
                // Support both DVOR and DME parsers (both expose POLL_INTERVAL, POLL_REQ_DELAY)
                // Ambil POLL_INTERVAL dan POLL_REQ_DELAY dari modul parser
                // Fallback ke nilai default jika modul tidak punya konstanta tersebut
                let POLL_INTERVAL = 2000, POLL_REQ_DELAY = 150;
                try {
                    const parserModule = require('../parsers/' + parsing_id);
                    if (parserModule.POLL_INTERVAL) POLL_INTERVAL = parserModule.POLL_INTERVAL;
                    if (parserModule.POLL_REQ_DELAY) POLL_REQ_DELAY = parserModule.POLL_REQ_DELAY;
                } catch (e) { /* gunakan default */ }
                const sleep = ms => new Promise(r => setTimeout(r, ms));

                const pollLoop = async () => {
                    // Small initial delay to let TCP connection stabilize
                    await sleep(500);

                    // Kick-start: kirim satu siklus poll pertama tanpa peduli mode
                    // agar meter mulai kirim data dan parser bisa switch ke PASSIVE
                    {
                        const conn = connectionManager.connections.get(id);
                        if (conn && conn.socket && !conn.socket.destroyed) {
                            const requests = parser.getPollRequests();
                            for (const req of requests) {
                                const buf = req.bytes || req;
                                try { conn.socket.write(buf); await sleep(POLL_REQ_DELAY); } catch (e) { }
                            }
                            console.log(`[NetworkListener] Kick-start poll sent for ${source.name}`);
                        }
                    }

                    while (this.activeListeners.has(id) && this._pollGen[id] === myGen) {
                        // Only poll when parser is in ACTIVE mode
                        if (parser.getMode) {
                            if (typeof parser.checkTimeout === 'function') parser.checkTimeout();
                            if (parser.getMode() === 'ACTIVE') {
                                const conn = connectionManager.connections.get(id);
                                if (conn && conn.socket && !conn.socket.destroyed) {
                                    const requests = parser.getPollRequests();
                                    for (const req of requests) {
                                        const buf = req.bytes || req;
                                        try {
                                            conn.socket.write(buf);
                                            await sleep(POLL_REQ_DELAY);
                                        } catch (e) {
                                            console.warn(`[NetworkListener] Poll write error for ${source.name}: ${e.message}`);
                                        }
                                    }
                                    console.log(`[NetworkListener] ACTIVE poll cycle sent for ${source.name}`);
                                }
                            }
                        }
                        await sleep(POLL_INTERVAL);
                    }
                };
                pollLoop();
                console.log(`[NetworkListener] ACTIVE polling loop started for ${source.name}`);
            }
        } else {
            console.error(`[NetworkListener] Failed to start listener for ${source.name} on port ${port}`);
            if (protocol === 'tcp') {
                scheduleReconnect();
            }
        }
    }

    /**
     * Handle incoming raw data
     */
    async handleIncomingData(source, rawData, parser) {
        const { id, equipt_id, name } = source;
        if (RAW_DEBUG) {
            console.log(`[NetworkListener] Received data from ${name} (${rawData.length} bytes)`);
            console.log(`[NetworkListener] Raw[${name}]: ${rawData.slice(0, 200).toString("hex")}`);
        }

        try {
            let parsedResult = { success: false };
            let status = 'Normal';

            if (parser) {
                parsedResult = parser.parse(rawData);
            }

            if (this._isSplitCollectorMode()) {
                await this._enqueueRawEvent(source, rawData);

                if (!parsedResult.success) {
                    if (parsedResult.error && this._shouldLogParseWarning(id, parsedResult.error)) {
                        console.log(`[NetworkListener] Collector queued partial frame from ${name}: ${parsedResult.error}`);
                    }
                }
                return;
            }

            // Jangan overwrite log sukses dengan log gagal (misal buffer belum penuh / junk chunk)
            // Untuk binary streaming parsers (GP/LLZ/PM5560): hanya save jika parse sukses
            const hasExistingData = parser && typeof parser.getLastData === 'function'
                ? Object.keys(parser.getLastData()).length > 0
                : false;
            const transientParseErrors = new Set([
                'No valid GP frames',
                'No valid DME frames',
                'No valid LLZ frames',
                'Menunggu data'
            ]);

            if (!parsedResult.success) {
                // Parse gagal — skip log agar tidak menimpa data valid
                if (parsedResult.error && !transientParseErrors.has(parsedResult.error)) {
                    console.warn(`[NetworkListener] Skipping failed parse log for ${name}: ${parsedResult.error}`);
                } else if (parsedResult.error && this._shouldLogParseWarning(id, parsedResult.error)) {
                    console.log(`[NetworkListener] Waiting for complete frame from ${name}: ${parsedResult.error}`);
                }
                return;
            }

            // Save to logs
            const logData = {
                ...(parsedResult.success ? parsedResult : { success: false, data: { raw: rawData.toString('hex') }, error: 'Parsing failed or no parser' }),
                source: name, // Set the source name (e.g., "TX 1")
                _ip: source.ip_address || 'unknown' // For FileLogger
            };

            await this._handleLogOutput(
                source,
                logData,
                source.parsing_id || 'raw',
                parsedResult.status || 'Normal'
            );

            if (parsedResult.success) {
                const mode = parsedResult.data && parsedResult.data._mode ? parsedResult.data._mode : 'PASSIVE';
                this._logThrottled('log', `net-listener:success:${id}`, `[NetworkListener] Successfully parsed data for ${name}. Status: ${parsedResult.status} | Mode: ${mode}`, 15000);
                // Status is now handled by the watchdog consolidation in server.ts
                // await this.equipmentService.updateEquipmentStatus(equipt_id, parsedResult.status || 'Normal');
            } else {
                this._logThrottled('warn', `net-listener:fail:${id}`, `[NetworkListener] Parsing failed for ${name}: ${parsedResult.error}`, 30000);
            }

        } catch (error) {
            console.error(`[NetworkListener] Error processing data for ${name}:`, error.message);
        }
    }

    /**
     * Stop all listeners
     */
    stopAll() {
        console.log('[NetworkListener] Stopping all listeners...');
        for (const sourceId of this.activeListeners) {
            connectionManager.disconnect(sourceId);
        }
        this.activeListeners.clear();

        const timerMaps = [
            '_datakomTimers', '_dseTimers', '_iologikTimers', '_pm5350Timers',
            '_upsNetagentTimers', '_snmpSystemTimers', '_tempHumidityTimers',
            '_asterixTimers', '_marcRseTimers', '_vhfT6tvConnections', '_httpTimers',
            '_reconnectTimers'
        ];

        for (const mapName of timerMaps) {
            if (this[mapName]) {
                for (const [id, timer] of this[mapName]) {
                    clearInterval(timer);
                    // Also clear timeout if any (some might be timeouts)
                    clearTimeout(timer);
                }
                this[mapName].clear();
            }
        }

        const cleanupMaps = [
            '_modbusTcpCleanup', '_binaryTcpCleanup', '_tempHumidityCleanup'
        ];

        for (const mapName of cleanupMaps) {
            if (this[mapName]) {
                for (const [id, cleanupFn] of this[mapName]) {
                    try { cleanupFn(); } catch (e) { }
                }
                this[mapName].clear();
            }
        }

        // Stop SNMP-based T6TV collectors
        if (this._t6tvSnmpCollectors) {
            for (const [id, collector] of this._t6tvSnmpCollectors) {
                try { collector.stop(); } catch (e) { }
            }
            this._t6tvSnmpCollectors.clear();
        }

        // CLEAR PARSERS SO THEY ARE RE-INSTANTIATED WITH NEW CONFIG!
        if (this.parsers) {
            this.parsers.clear();
        }
    }
}

// Singleton instance
const networkListenerService = new NetworkListenerService();

module.exports = networkListenerService;
