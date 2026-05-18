/**
 * Network Listener Service
 * Manages persistent UDP/TCP listeners for equipment data sources
 */

const ParserFactory = require('../parsers/factory');
const connectionManager = require('../connection/manager');
const db = require('../../db/database');
const EquipmentService = require('./equipment');

class NetworkListenerService {
    constructor() {
        this.equipmentService = new EquipmentService(db);
        this.activeListeners = new Set(); // source_id -> true
        this._parseWarningTimestamps = new Map();
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

    /**
     * Initialize listeners for all active equipment sources
     */
    async initialize() {
        console.log('[NetworkListener] Initializing listeners...');
        
        try {
            // Fetch all equipment sources (authentications)
            const sources = await db.getAllOtentication();
            console.log(`[NetworkListener] Found ${sources.length} total sources`);

            // Parsers yang tidak butuh port (SNMP pakai UDP 161 internal)
            const PORTLESS_PARSERS = ['snmp_system', 'snmp_host_resources_01'];

            for (const source of sources) {
                // Start jika punya port ATAU parsing_id yang tidak butuh port
                if (source.udp_port || source.tcp_port || PORTLESS_PARSERS.includes(source.parsing_id)) {
                    console.log(`[NetworkListener] Starting listener for ${source.name} (${source.parsing_id})`);
                    this.startListener(source); // Tidak di-await agar berjalan paralel dan tidak memblock loop
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
        const extra    = extra_config ? (typeof extra_config === 'string' ? JSON.parse(extra_config) : extra_config) : {};
        const port     = parseInt(tcp_port) || 80;
        const wsPath   = extra.ws_path  || '/ws';
        const username = extra.username || 'admin';
        const password = extra.password || 'admin';
        const pollMs   = (extra.interval || 5) * 1000;

        console.log(`[NetworkListener] Starting T6TV WS for ${source.name} at ${ip_address}:${port}${wsPath}`);

        const T6tvConnector = require('../connection/t6tv_connector');
        const VhfT6tvParser = require('../parsers/vhf_t6tv');
        const parser = new VhfT6tvParser({ equipt_id });

        const onData = async (rawData) => {
            await this.handleIncomingData(source, rawData, parser);
        };
        const onError = (err) => {
            console.error(`[NetworkListener] T6TV error for ${source.name}:`, err.message || err);
        };

        const connector = new T6tvConnector(id, ip_address, port, username, password, wsPath, pollMs, onData, onError);
        connector.start();
        this.activeListeners.add(id);
        this._t6tvConnectors = this._t6tvConnectors || new Map();
        this._t6tvConnectors.set(id, connector);
        console.log(`[NetworkListener] T6TV listener active for ${source.name}`);
    }

    /**
     * Dedicated TCP listener untuk PM5560 Modbus RTU-over-TCP.
     * Menggunakan net.Socket langsung (bypass connectionManager yang punya
     * DVOR/DME SOH/STX/ETX buffering), langsung forward tiap chunk ke parser.
     */
    startPm5560Listener(source) {
        const net = require('net');
        const { id, equipt_id, ip_address, tcp_port } = source;
        const port = parseInt(tcp_port) || 502;

        const Pm5560ModbusParser = require('../parsers/pm5560_modbus');
        const parser = new Pm5560ModbusParser({ equipt_id });

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
                console.error(`[NetworkListener] PM5560 error ${source.name}: ${err.message}`);
            });

            socket.on('timeout', () => {
                console.warn(`[NetworkListener] PM5560 timeout ${source.name}, reconnecting...`);
                socket.destroy();
            });

            socket.on('close', () => {
                console.log(`[NetworkListener] PM5560 disconnected ${source.name}, retry in 15s`);
                this.activeListeners.delete(id);
                parser.reset();
                if (!stopped) reconnectTimer = setTimeout(connect, 15000);
            });
        };

        // Polling loop: kirim semua FC03 request tiap POLL_INTERVAL
        const Pm5560Module = require('../parsers/pm5560_modbus');
        const POLL_INTERVAL  = Pm5560Module.POLL_INTERVAL;
        const POLL_REQ_DELAY = Pm5560Module.POLL_REQ_DELAY;
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
                    console.warn(`[NetworkListener] PM5560 write error ${source.name}: ${e.message}`);
                }
            }
            console.log(`[NetworkListener] PM5560 poll sent for ${source.name}`);
        };

        const startPollLoop = () => {
            if (pollTimer) clearInterval(pollTimer);
            // Kirim langsung saat connect, lalu ulangi tiap POLL_INTERVAL
            doPoll();
            pollTimer = setInterval(doPoll, POLL_INTERVAL);
        };

        connect();

        // Simpan cleanup handle
        this._pm5560Cleanup = this._pm5560Cleanup || new Map();
        this._pm5560Cleanup.set(id, () => {
            stopped = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (pollTimer) clearInterval(pollTimer);
            if (socket) socket.destroy();
        });

        console.log(`[NetworkListener] PM5560 listener started for ${source.name}`);
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

        const ParserModule = require('../parsers/' + parsing_id);
        const parser = new ParserModule({ equipt_id });

        let socket = null;
        let reconnectTimer = null;
        let stopped = false;

        const connect = () => {
            if (stopped) return;
            socket = new net.Socket();
            socket.setTimeout(60000); // 60s — passive stream, heartbeat keeps it alive

            socket.connect(port, ip_address, () => {
                console.log(`[NetworkListener] ILS binary TCP connected: ${name} (${ip_address}:${port})`);
                this.activeListeners.add(id);
                this._binaryTcpSockets = this._binaryTcpSockets || new Map();
                this._binaryTcpSockets.set(id, socket);
            });

            // Forward every chunk directly to parser — no buffering or framing
            socket.on('data', async (chunk) => {
                await this.handleIncomingData(source, chunk, parser);
            });

            socket.on('error', (err) => {
                console.error(`[NetworkListener] ILS binary TCP error ${name}: ${err.message}`);
            });

            socket.on('timeout', () => {
                console.warn(`[NetworkListener] ILS binary TCP timeout ${name}, reconnecting...`);
                socket.destroy();
            });

            socket.on('close', () => {
                console.log(`[NetworkListener] ILS binary TCP disconnected ${name}, retry in 15s`);
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
        const net = require('net');
        const { id, equipt_id, ip_address, tcp_port, name, location } = source;
        const port = parseInt(tcp_port) || 502;

        const TempHumidityParser = require('../parsers/temp_humidity_modbus');
        const POLL_INTERVAL  = TempHumidityParser.POLL_INTERVAL;
        const parser = new TempHumidityParser({ equipt_id, location: location || name });

        let socket = null;
        let pollTimer = null;
        let reconnectTimer = null;
        let stopped = false;
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        const doPoll = async () => {
            const s = socket;
            if (!s || s.destroyed) return;
            const req = parser.getPollRequest();
            try {
                s.write(req.bytes);
            } catch (e) {
                console.warn(`[TempHumidity] Write error ${name}: ${e.message}`);
            }
        };

        const connect = () => {
            if (stopped) return;
            socket = new net.Socket();
            socket.setTimeout(15000);

            socket.connect(port, ip_address, () => {
                console.log(`[TempHumidity] Connected: ${name} (${ip_address}:${port})`);
                this.activeListeners.add(id);
                // Kirim langsung saat connect, lalu ulangi tiap POLL_INTERVAL
                doPoll();
                pollTimer = setInterval(doPoll, POLL_INTERVAL);
            });

            socket.on('data', async (chunk) => {
                const result = parser.parse(chunk);
                if (!result) return;
                const logStatus = result.status || 'Normal';
                await this.equipmentService.saveToLogs(
                    equipt_id,
                    {
                        data: {
                            ...result.data,
                            // Tambah location info di data
                            location: location || name,
                        },
                        source: name,
                        _ip: ip_address,
                    },
                    'temp_humidity_modbus',
                    logStatus
                );
                console.log(`[TempHumidity] ${name}: ${result.data.temperature_c}°C ${result.data.humidity_pct}% [${logStatus}]`);
            });

            socket.on('error', (err) => {
                console.error(`[TempHumidity] Error ${name}: ${err.message}`);
            });

            socket.on('timeout', () => {
                console.warn(`[TempHumidity] Timeout ${name}, reconnecting...`);
                socket.destroy();
            });

            socket.on('close', () => {
                console.log(`[TempHumidity] Disconnected ${name}, retry in 15s`);
                this.activeListeners.delete(id);
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                parser.reset();
                if (!stopped) reconnectTimer = setTimeout(connect, 15000);
            });
        };

        connect();

        // Cleanup handle
        this._tempHumidityCleanup = this._tempHumidityCleanup || new Map();
        this._tempHumidityCleanup.set(id, () => {
            stopped = true;
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
        const { id, equipt_id, ip_address, name, community, poll_interval } = source;
        const pollSec = parseInt(poll_interval) || 60;
        const comm    = community || 'public';

        const parserFile = 'snmp_system';
        const { pollSNMP } = require(`../parsers/${parserFile}`);

        this.activeListeners.add(id);
        console.log(`[SNMP System] Listener started: ${name} (${ip_address})`);

        const doPoll = async () => {
            console.log(`[SNMP System] Polling ${name} (${ip_address})...`);
            try {
                const result = await pollSNMP(ip_address, comm);
                console.log(`[SNMP System] ${name}: status=${result.status} cpu=${result.data.cpu_usage} ram=${result.data.ram_usage_pct} disk=${result.data.disk_usage_pct} err=${result.error||'none'}`);
                await this.equipmentService.saveToLogs(
                    equipt_id,
                    { data: result.data, source: name, _ip: ip_address },
                    source.parsing_id || 'snmp_system',
                    result.status || 'Disconnect'
                );
            } catch (err) {
                console.error(`[SNMP System] Poll error ${name}:`, err.message);
            }
        };

        setTimeout(doPoll, 2000);
        const timer = setInterval(doPoll, pollSec * 1000);

        if (!this._snmpSystemTimers) this._snmpSystemTimers = new Map();
        this._snmpSystemTimers.set(id, timer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ASTERIX UDP MULTICAST (Radar CAT034 + ADS-B CAT021)
    // ─────────────────────────────────────────────────────────────────────────
    startAsterixListener(source, parserId) {
        const dgram = require('dgram');
        const { id, equipt_id, name, ip_address, udp_port,
                lat, lon, location, sac, sic,
                multicast_ip, multicast_port, timeout_ms } = source;

        const port    = parseInt(udp_port) || (parserId === 'asterix_adsb' ? 50000 : 4001);
        const mcastIp = multicast_ip || ip_address;

        const ParserClass = require('../parsers/' + parserId);
        const parser = new ParserClass({
            equipt_id,
            name:           location || name,
            lat:            lat   || 0,
            lon:            lon   || 0,
            sac:            sac   || 0,
            sic:            sic   || 0,
            multicast_ip:   mcastIp,
            multicast_port: multicast_port || port,
            timeout_ms:     timeout_ms || 5000,
        });

        if (!this._asterixSockets)  this._asterixSockets  = new Map();
        if (!this._asterixParsers)  this._asterixParsers  = new Map();
        if (!this._asterixTimers)   this._asterixTimers   = new Map();

        if (!this._asterixParsers.has(port)) this._asterixParsers.set(port, new Map());
        this._asterixParsers.get(port).set(id, { parser, source, parserId });

        const socketKey = `asterix_udp_${port}`;
        if (!this._asterixSockets.has(socketKey)) {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            sock.on('message', async (msg, rinfo) => {
                const parsersOnPort = this._asterixParsers.get(port);
                if (!parsersOnPort) return;
                for (const [srcId, entry] of parsersOnPort) {
                    const result = entry.parser.parse(msg);
                    if (!result) continue;
                    try {
                        await this.equipmentService.saveToLogs(
                            entry.source.equipt_id,
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
                    console.log(`[Asterix] Joined multicast ${mcastIp}:${port}`);
                } catch (e) {
                    console.warn(`[Asterix] Multicast join failed ${mcastIp}:${port}: ${e.message}`);
                }
            });

            this._asterixSockets.set(socketKey, sock);
        }

        this.activeListeners.add(id);

        const timeoutCheck = setInterval(async () => {
            const result = parser.checkTimeout();
            if (result) {
                try {
                    await this.equipmentService.saveToLogs(
                        equipt_id,
                        { data: result.data, source: name, _ip: ip_address },
                        parserId,
                        'Disconnect'
                    );
                } catch (err) {}
            }
        }, 5000);

        this._asterixTimers.set(id, timeoutCheck);
        console.log(`[Asterix] Listener started: ${name} (${mcastIp}:${port} / ${parserId})`);
    }

    startMarcRseListener(source) {
        const { id, equipt_id, ip_address, tcp_port, marc_ports, poll_interval, name } = source;
        const port    = parseInt(tcp_port) || 950;
        const ports   = Array.isArray(marc_ports) ? marc_ports : [];
        const pollSec = parseInt(poll_interval) || 30;

        const VhfMarcRseParser = require('../parsers/vhf_marc_rse');
        const { getOrCreateClient } = VhfMarcRseParser._internal;

        // Pastikan shared client berjalan
        const client = getOrCreateClient(ip_address, port, pollSec);

        // Buat parser dengan marc_ports equipment ini
        const parser = new VhfMarcRseParser({
            equipt_id,
            host:          ip_address,
            port:          port,
            marc_ports:    ports,
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
                        frequency_mhz:      radioState.frequency_mhz,
                        mode:               radioState.mode,
                        status:             radioState.status,
                        supply_voltage:     radioState.supply_voltage,
                        pa_temp_c:          radioState.pa_temp_c,
                        fwd_power_w:        radioState.fwd_power_w,
                        refl_power_w:       radioState.refl_power_w,
                        modulation_pct:     radioState.modulation_pct,
                        sensitivity_dbm:    radioState.sensitivity_dbm,
                        squelch_dbm:        radioState.squelch_dbm,
                        rx_supply_voltage:  radioState.rx_supply_voltage,
                        radio_type:         radioState.radio_type,
                        is_rx:              radioState.is_rx,
                    };

                    const radioStatus = radioState.connected
                        ? (radioState.status === 'ALARM' ? 'Alarm' : 'Normal')
                        : 'Disconnect';

                    // source = name (nama source config = nama radio)
                    // ini yang jadi key di lastData frontend
                    await this.equipmentService.saveToLogs(
                        equipt_id,
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

        console.log(`[NetworkListener] MARC RSE listener started for ${name} (ports: ${ports.join(',')})`);
    }

    async startListener(source) {
        const { id, equipt_id, ip_address, udp_port, tcp_port, parsing_id } = source;
        const port = parseInt(udp_port || tcp_port);
        const protocol = udp_port ? 'udp' : 'tcp';

        // T6TV uses WebSocket — route to dedicated handler
        if (parsing_id === 'vhf_t6tv') {
            await this.startT6tvListener(source);
            return;
        }

        // PM5560 Modbus — dedicated raw TCP handler (bypass DVOR/DME buffering)
        if (parsing_id === 'pm5560_modbus') {
            this.startPm5560Listener(source);
            return;
        }

        // ILS GP / LLZ — binary streaming TCP, bypass SOH/STX/ETX buffering
        if (parsing_id === 'ils_gp_thales421' || parsing_id === 'ils_llz_thales421') {
            this.startBinaryTcpListener(source);
            return;
        }

        // Temp/Humidity sensor — Modbus TCP FC03 port 502
        if (parsing_id === 'temp_humidity_modbus') {
            this.startTempHumidityListener(source);
            return;
        }

        // MARC RSE — shared TCP client, binary SLIP protocol
        if (parsing_id === 'vhf_marc_rse') {
            this.startMarcRseListener(source);
            return;
        }

        // SNMP System Monitor (Server/Workstation/Switch)
        if (parsing_id === 'snmp_system' || parsing_id === 'snmp_host_resources_01') {
            this.startSnmpSystemListener(source);
            return;
        }

        // ASTERIX Radar CAT034 (UDP multicast per site)
        if (parsing_id === 'asterix_radar') {
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

        console.log(`[NetworkListener] Starting ${protocol.toUpperCase()} listener for ${source.name} on port ${port}...`);

        // 1. Create Parser
        let parser = null;
        if (parsing_id) {
            parser = ParserFactory.createParser(parsing_id, { equipt_id });
        }

        if (!parser) {
            console.warn(`[NetworkListener] No valid parser found for parsing_id: ${parsing_id}. Data will be logged as raw.`);
        }

        // 2. Bind Socket
        const onData = async (rawData) => {
            await this.handleIncomingData(source, rawData, parser);
        };

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
        if (protocol === 'udp') {
            success = connectionManager.connectUDP(id, ip_address || '0.0.0.0', port, onData, onError);
        } else {
            success = await connectionManager.connectTCP(id, ip_address || '0.0.0.0', port, onData, onError);
        }

        if (success) {
            this.activeListeners.add(id);
            console.log(`[NetworkListener] ${protocol.toUpperCase()} listener active for ${source.name} on port ${port}`);

            // Start ACTIVE polling loop for TCP parsers that support it (e.g. DVOR Maru 220)
            if (protocol === 'tcp' && parser && typeof parser.getPollRequests === 'function') {
                // Support both DVOR and DME parsers (both expose POLL_INTERVAL, POLL_REQ_DELAY)
                // Ambil POLL_INTERVAL dan POLL_REQ_DELAY dari modul parser
                // Fallback ke nilai default jika modul tidak punya konstanta tersebut
                let POLL_INTERVAL = 2000, POLL_REQ_DELAY = 150;
                try {
                    const parserModule = require('../parsers/' + parsing_id);
                    if (parserModule.POLL_INTERVAL)  POLL_INTERVAL  = parserModule.POLL_INTERVAL;
                    if (parserModule.POLL_REQ_DELAY) POLL_REQ_DELAY = parserModule.POLL_REQ_DELAY;
                } catch(e) { /* gunakan default */ }
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
                                try { conn.socket.write(req.bytes); await sleep(POLL_REQ_DELAY); } catch(e) {}
                            }
                            console.log(`[NetworkListener] Kick-start poll sent for ${source.name}`);
                        }
                    }

                    while (this.activeListeners.has(id) && this._pollGen[id] === myGen) {
                        // Only poll when parser is in ACTIVE mode
                        if (parser.getMode && parser.getMode() === 'ACTIVE') {
                            const conn = connectionManager.connections.get(id);
                            if (conn && conn.socket && !conn.socket.destroyed) {
                                const requests = parser.getPollRequests();
                                for (const req of requests) {
                                    try {
                                        conn.socket.write(req.bytes);
                                        await sleep(POLL_REQ_DELAY);
                                    } catch(e) {
                                        console.warn(`[NetworkListener] Poll write error for ${source.name}: ${e.message}`);
                                    }
                                }
                                console.log(`[NetworkListener] ACTIVE poll cycle sent for ${source.name}`);
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
        console.log(`[NetworkListener] Received data from ${name} (${rawData.length} bytes)`);
        // Debug: log first 80 hex chars to help diagnose protocol
        console.log(`[NetworkListener] Raw[${name}]: ${rawData.slice(0,40).toString("hex")}`);

        try {
            let parsedResult = { success: false };
            let status = 'Normal';

            if (parser) {
                parsedResult = parser.parse(rawData);
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
            
            await this.equipmentService.saveToLogs(
                equipt_id, 
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
    }
}

// Singleton instance
const networkListenerService = new NetworkListenerService();

module.exports = networkListenerService;
