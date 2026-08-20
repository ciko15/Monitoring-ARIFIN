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

const RAW_DEBUG = String(process.env.RAW_DEBUG || 'false').toLowerCase() === 'true';

class NetworkListenerService {
    constructor() {
        this.equipmentService = new EquipmentService(db);
        this.activeListeners = new Set(); // source_id -> true
        this.parsers = new Map(); // source_id -> parser instance
        this._parseWarningTimestamps = new Map();
        this.statusGate = new SourceStatusGate();
        this.pipelineMode = process.env.PIPELINE_MODE || 'inline';
        this.serviceRole = process.env.SERVICE_ROLE || 'all';
        this.rawEventQueue = new RawEventQueue();

        // Auto-reload listeners when auth config changes
        const fs = require('fs');
        const path = require('path');
        const authPath = path.join(__dirname, '../../db/equipment_otentication_config.json');

        let debounceTimer = null;
        fs.watchFile(authPath, { interval: 3000 }, (curr, prev) => {
            if (curr.mtime > prev.mtime) {
                console.log('[NetworkListener] Config file changed! Auto-reloading listeners...');
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    this.initialize().catch(e => console.error('[NetworkListener] Error auto-reloading:', e));
                }, 2000);
            }
        });
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

    async _handleLogOutput(source, parsedData, connectionType, status) {
        const decision = this.statusGate.evaluate(source, status, {
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

        const finalStatus = decision.status;

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
        console.log('[NetworkListener] Initializing listeners...');
        this.stopAll();

        try {
            // Fetch all equipment sources (authentications)
            const sources = await db.getAllOtentication();
            console.log(`[NetworkListener] Found ${sources.length} total sources`);

            // Parsers yang tidak butuh port (SNMP pakai UDP 161 internal)
            const PORTLESS_PARSERS = ['snmp_system', 'snmp_host_resources_01', 'snmp_network_basic', 'ups_netagent_snmp', 'vhf_t6tv_snmp', 'vhf_t6tv'];
            const startBatchSize = parseInt(process.env.COLLECTOR_START_BATCH_SIZE || '') || 10;
            const startBatchDelayMs = parseInt(process.env.COLLECTOR_START_BATCH_DELAY_MS || '') || 3000;
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            let startedCount = 0;

            for (const source of sources) {
                // Start jika punya port ATAU parsing_id yang tidak butuh port
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
        let reconnectTimer = null;
        let stopped = false;

        const connect = () => {
            if (stopped) return;
            socket = new net.Socket();
            socket.setTimeout(15000);

            socket.connect(port, ip_address, () => {
                console.log(`[NetworkListener] PM5560 TCP connected: ${source.name} (${ip_address}:${port})`);
                this.activeListeners.add(id);
                this._pm5560Sockets = this._pm5560Sockets || new Map();
                this._pm5560Sockets.set(id, socket);
                startPollLoop();
            });

            // Forward chunk langsung ke parser — tanpa buffering tambahan
            socket.on('data', async (chunk) => {
                await this.handleIncomingData(source, chunk, parser);
            });

            socket.on('error', (err) => {
                this._logThrottled('error', `${moduleName}:error:${id}:${err.message}`, `[NetworkListener] ${moduleName} error ${source.name}: ${err.message}`);
            });

            socket.on('timeout', () => {
                this._logThrottled('warn', `${moduleName}:timeout:${id}`, `[NetworkListener] ${moduleName} timeout ${source.name}, reconnecting...`);
                socket.destroy();
            });

            socket.on('close', () => {
                this._logThrottled('log', `${moduleName}:close:${id}`, `[NetworkListener] ${moduleName} disconnected ${source.name}, retry in 15s`);
                this.activeListeners.delete(id);
                parser.reset();
                if (!stopped) reconnectTimer = setTimeout(connect, 15000);
            });
        };

        // Polling loop: kirim semua request tiap POLL_INTERVAL
        const POLL_INTERVAL = ParserModule.POLL_INTERVAL;
        const POLL_REQ_DELAY = ParserModule.POLL_REQ_DELAY;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        let pollTimer = null;

        const doPoll = async () => {
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
            if (reconnectTimer) clearTimeout(reconnectTimer);
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
        const port = parseInt(tcp_port) || 950;

        // Petakan custom_id ke file js yang benar
        let moduleName = this._getParserModule(parsing_id);

        const ParserModule = require('../parsers/' + moduleName);
        const parser = new ParserModule({ equipt_id });

        // Cek apakah parser support protokol trigger+heartbeat (Thales 421)
        const hasTriggerProtocol = typeof parser.isHeartbeat === 'function' &&
            typeof parser.getHeartbeatReply === 'function';

        console.log(`[LLZ-TRACE] startBinaryTcpListener called for ${name} (${ip_address}:${port}), hasTriggerProtocol=${hasTriggerProtocol}`);

        let socket = null;
        let reconnectTimer = null;
        let stopped = false;

        const connect = () => {
            if (stopped) return;
            socket = new net.Socket();
            socket.setTimeout(60000); // 60s — heartbeat akan menjaga koneksi tetap hidup

            let pollTimer = null;

            socket.connect(port, ip_address, () => {
                console.log(`[NetworkListener] ILS binary TCP connected: ${name} (${ip_address}:${port})`);
                this.activeListeners.add(id);
                this._binaryTcpSockets = this._binaryTcpSockets || new Map();
                this._binaryTcpSockets.set(id, socket);

                // Kirim trigger secara berkala agar aliran data tidak terputus walau direbut ADRACS
                if (hasTriggerProtocol) {
                    const doPoll = () => {
                        const triggerReqs = parser.getPollRequests();
                        for (const req of triggerReqs) {
                            try {
                                socket.write(req.bytes);
                            } catch (e) {
                                console.warn(`[NetworkListener] ILS trigger write error ${name}: ${e.message}`);
                            }
                        }
                    };
                    doPoll();
                    pollTimer = setInterval(doPoll, 5000); // Paksa minta data tiap 5 detik
                }
            });

            if (!this._lastHeartbeatReply) this._lastHeartbeatReply = new Map();

            socket.on('data', async (chunk) => {
                // Balas heartbeat dari device agar stream tetap hidup tanpa RCMS (max 1x per 5 detik untuk mencegah ping-pong storm)
                if (hasTriggerProtocol && parser.isHeartbeat(chunk)) {
                    const lastReply = this._lastHeartbeatReply.get(id) || 0;
                    if (Date.now() - lastReply > 5000) {
                        try {
                            socket.write(parser.getHeartbeatReply());
                            this._lastHeartbeatReply.set(id, Date.now());
                        } catch (e) {
                            console.warn(`[NetworkListener] ILS heartbeat reply error ${name}: ${e.message}`);
                        }
                    }
                }
                await this.handleIncomingData(source, chunk, parser);
            });

            socket.on('error', (err) => {
                this._logThrottled('error', `ils:error:${id}:${err.message}`, `[NetworkListener] ILS binary TCP error ${name}: ${err.message}`);
            });

            socket.on('timeout', () => {
                this._logThrottled('warn', `ils:timeout:${id}`, `[NetworkListener] ILS binary TCP timeout ${name}, reconnecting...`);
                socket.destroy();
            });

            socket.on('close', () => {
                this._logThrottled('log', `ils:close:${id}`, `[NetworkListener] ILS binary TCP disconnected ${name}, retry in 15s`);
                if (pollTimer) clearInterval(pollTimer);
                this.activeListeners.delete(id);
                if (typeof parser.reset === 'function') parser.reset();
                if (!stopped) reconnectTimer = setTimeout(connect, 15000);
            });
        };

        connect();

        this._binaryTcpCleanup = this._binaryTcpCleanup || new Map();
        this._binaryTcpCleanup.set(id, () => {
            stopped = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (socket) socket.destroy();
        });

        console.log(`[NetworkListener] ILS binary TCP listener started for ${name}`);
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

        const doPoll = async () => {
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
            }
        };

        const initialDelay = 1000 + Math.floor(Math.random() * 5000);
        setTimeout(() => {
            doPoll();
            const timer = setInterval(doPoll, pollSec * 1000);

            if (!this._tempHumidityTimers) this._tempHumidityTimers = new Map();
            this._tempHumidityTimers.set(id, timer);
        }, initialDelay);

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

        const doPoll = async () => {
            console.log(`[SNMP System] Polling ${name} (${ip_address}:${port}, v${version})...`);
            try {
                const result = await pollSNMP(ip_address, comm, { port, version });
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
            }
        };

        // Add random jitter (0 to 15 seconds) to prevent 'Thundering Herd'
        // di mana puluhan server ditembak SNMP secara bersamaan yang membuat
        // UDP packet terbuang (drop) oleh switch/buffer.
        const jitterMs = Math.floor(Math.random() * 15000);
        const initialDelay = 2000 + jitterMs;

        setTimeout(() => {
            doPoll();
            const timer = setInterval(doPoll, pollSec * 1000);

            if (!this._snmpSystemTimers) this._snmpSystemTimers = new Map();
            this._snmpSystemTimers.set(id, timer);
        }, initialDelay);
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

        const doPoll = async () => {
            try {
                const result = await pollUPSNetagent(ip_address, comm, { port, version });
                await this._handleLogOutput(
                    source,
                    { data: result.data, source: name, _ip: ip_address },
                    'ups_netagent_snmp',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[UPS SNMP] Poll error ${name}:`, err.message);
            }
        };

        const initialDelay = 1000 + Math.floor(Math.random() * 5000);
        setTimeout(() => {
            doPoll();
            const timer = setInterval(doPoll, pollSec * 1000);

            if (!this._upsNetagentTimers) this._upsNetagentTimers = new Map();
            this._upsNetagentTimers.set(id, timer);
        }, initialDelay);
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

        const doPoll = async () => {
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
            }
        };

        const initialDelay = 1000 + Math.floor(Math.random() * 5000);
        setTimeout(() => {
            doPoll();
            const timer = setInterval(doPoll, pollSec * 1000);

            if (!this._pm5350Timers) this._pm5350Timers = new Map();
            this._pm5350Timers.set(id, timer);
        }, initialDelay);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Moxa ioLogik 4000 (Modbus TCP)
    // ─────────────────────────────────────────────────────────────────────────
    startIologikModbusListener(source) {
        const { id, name, ip_address, tcp_port, extra_config } = source;
        const pollSec = 5;
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
        console.log(`[ioLogik] Listener started: ${name} (${ip_address}:${port})`);

        const doPoll = async () => {
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
            }
        };

        const initialDelay = 1000 + Math.floor(Math.random() * 2000);
        setTimeout(() => {
            doPoll();
            const timer = setInterval(doPoll, pollSec * 1000);
            if (!this._iologikTimers) this._iologikTimers = new Map();
            this._iologikTimers.set(id, timer);
        }, initialDelay);
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
        const pollTimer = setInterval(async () => {
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
        const pollTimer = setInterval(async () => {
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

        const doPoll = async () => {
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

        const doPoll = async () => {
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
            }
        };

        const initialDelay = 1000 + Math.floor(Math.random() * 2000);
        setTimeout(() => {
            doPoll();
            const timer = setInterval(doPoll, pollSec * 1000);

            if (!this._dseTimers) this._dseTimers = new Map();
            this._dseTimers.set(id, timer);
        }, initialDelay);
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

    async startListener(source) {
        const { id, equipt_id, ip_address, udp_port, tcp_port, parsing_id } = source;
        const port = parseInt(udp_port || tcp_port);
        const protocol = udp_port ? 'udp' : 'tcp';

        const moduleName = this._getParserModule(parsing_id);

        // T6TV uses SNMP — pull-based, no port needed
        if (moduleName === 'vhf_t6tv' || moduleName === 'vhf_t6tv_snmp') {
            this.startT6tvSnmpListener(source);
            return;
        }

        // Modbus TCP parsers (PM5560, Datakom D700) — dedicated raw TCP handler
        if (moduleName === 'pm5560_modbus') {
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

        // ILS GP / LLZ — binary streaming TCP, bypass SOH/STX/ETX buffering
        if (moduleName === 'ils_gp_thales421' || moduleName === 'ils_llz_thales421' || moduleName === 'ils_gp_normac' || moduleName === 'ils_gp_normac7030' || moduleName === 'ils_llz_normac' || moduleName === 'ils_llz_normac7030' || moduleName === 'diris_a20') {
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
            parser = ParserFactory.createParser(parsing_id, { equipt_id });
            if (parser) this.parsers.set(id, parser);
        }

        if (!parser) {
            console.warn(`[NetworkListener] No valid parser found for parsing_id: ${parsing_id}. Data will be logged as raw.`);
        }

        // 2. Bind Socket
        const onData = async (rawData) => {
            await this.handleIncomingData(source, rawData, parser);
        };

        if (this._datakomTimers) {
            for (const [id, timer] of this._datakomTimers) {
                clearInterval(timer);
            }
            this._datakomTimers.clear();
        }

        // Generasi token — increment tiap reconnect agar loop lama berhenti
        this._pollGen = this._pollGen || {};
        this._pollGen[id] = (this._pollGen[id] || 0) + 1;
        const myGen = this._pollGen[id];

        const onError = (error) => {
            console.error(`[NetworkListener] Error for source ${source.name} (${id}):`, error.message);

            // Auto-reconnect for TCP after 10s
            if (protocol === 'tcp') {
                // Hapus dari activeListeners agar loop generasi ini berhenti
                this.activeListeners.delete(id);
                setTimeout(() => {
                    console.log(`[NetworkListener] Reconnecting TCP for ${source.name}...`);
                    if (parser && typeof parser.reset === 'function') parser.reset();
                    this.startListener(source);
                }, 10000);
            }
        };

        let success = false;

        // Mode TCP langsung untuk DME
        if (protocol === 'udp') {
            success = connectionManager.connectUDP(id, ip_address || '0.0.0.0', port, onData, onError);
        } else {
            success = await connectionManager.connectTCP(id, ip_address || '0.0.0.0', port, onData, onError);
        }

        if (success) {
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
                console.log(`[NetworkListener] Successfully parsed data for ${name}. Status: ${parsedResult.status} | Mode: ${mode}`);
                // Status is now handled by the watchdog consolidation in server.ts
                // await this.equipmentService.updateEquipmentStatus(equipt_id, parsedResult.status || 'Normal');
            } else {
                console.warn(`[NetworkListener] Parsing failed for ${name}: ${parsedResult.error}`);
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
            '_asterixTimers', '_marcRseTimers', '_vhfT6tvConnections'
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

        // Stop SNMP-based T6TV collectors
        if (this._t6tvSnmpCollectors) {
            for (const [id, collector] of this._t6tvSnmpCollectors) {
                try { collector.stop(); } catch (e) { }
            }
            this._t6tvSnmpCollectors.clear();
        }
    }
}

// Singleton instance
const networkListenerService = new NetworkListenerService();

module.exports = networkListenerService;
