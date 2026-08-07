/**
 * vhf_marc_rse.js — Parser & Client untuk MARC/RSE Binary Protocol
 * Ported dari marc_client.py + marc_state.py (PyQt6 app)
 *
 * Protocol : TCP ke Moxa NPort port 950
 * Framing  : SLIP (0xC0 delimiter)
 * CRC      : CRC-16/CCITT (init=0x0000, poly=0x1021)
 * Polling  : Aktif — kirim T6 command, decode reply
 *
 * Satu instance MarcRseClient dipakai BERSAMA oleh semua equipment
 * yang terhubung ke Moxa yang sama (shared connection by IP:port).
 */

'use strict';

const net  = require('net');
const BaseParser = require('./base');

// ── SLIP constants ────────────────────────────────────────────────────────────
const SLIP_END     = 0xC0;
const SLIP_ESC     = 0xDB;
const SLIP_ESC_END = 0xDC;
const SLIP_ESC_ESC = 0xDD;

// ── Protocol constants ────────────────────────────────────────────────────────
const VER_BYTE  = 0x30;
const SRC_H     = 0x10;
const SRC_L     = 0x00;
const T6_PREFIX = 0x53;

// Commands
const CMD_SETTINGS1 = 0xEB;
const CMD_SETTINGS2 = 0xE9;
const CMD_TX_BITE   = 0xEF;
const CMD_RX_BITE   = 0xED;

const RPL_SETTINGS1 = 0xEA;
const RPL_SETTINGS2 = 0xE8;
const RPL_TX_BITE   = 0xEE;
const RPL_RX_BITE   = 0xEC;

// RX ports
const RX_PORTS = new Set([2, 3]);
const ALL_PORTS = [2, 3, 4, 5, 6, 7, 8, 9];

// ── CRC-16/CCITT (init=0x0000, poly=0x1021) ──────────────────────────────────

function crc16(data) {
    let crc = 0x0000;
    for (const b of data) {
        crc ^= (b << 8);
        for (let i = 0; i < 8; i++) {
            if (crc & 0x8000) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc;
}

// ── SLIP encoding/decoding ────────────────────────────────────────────────────

function slipEncode(data) {
    const out = [];
    for (const b of data) {
        if (b === SLIP_END) {
            out.push(SLIP_ESC, SLIP_ESC_END);
        } else if (b === SLIP_ESC) {
            out.push(SLIP_ESC, SLIP_ESC_ESC);
        } else {
            out.push(b);
        }
    }
    return Buffer.from(out);
}

function slipDecode(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
        if (data[i] === SLIP_ESC && i + 1 < data.length) {
            if (data[i + 1] === SLIP_ESC_END) {
                out.push(SLIP_END);
                i += 2;
                continue;
            } else if (data[i + 1] === SLIP_ESC_ESC) {
                out.push(SLIP_ESC);
                i += 2;
                continue;
            }
        }
        out.push(data[i]);
        i++;
    }
    return Buffer.from(out);
}

// ── Packet builder ────────────────────────────────────────────────────────────

class PacketBuilder {
    constructor() {
        this._seq = 0;
    }

    _nextSeq() {
        this._seq = (this._seq + 1) & 0xFF;
        return this._seq;
    }

    build(destId, payload) {
        const seq = this._nextSeq();
        const destH = (destId >> 8) & 0xFF;
        const destL = destId & 0xFF;
        const frameCrc = Buffer.from([destH, destL, SRC_H, SRC_L, seq, ...payload]);
        const crc = crc16(frameCrc);
        const frame = Buffer.from([VER_BYTE, ...frameCrc, (crc >> 8) & 0xFF, crc & 0xFF]);
        const encoded = slipEncode(frame);
        return Buffer.from([SLIP_END, ...encoded, SLIP_END]);
    }

    buildT6Cmd(destId, port, command) {
        return this.build(destId, Buffer.from([T6_PREFIX, port, command]));
    }
}

// ── Frame extractor dari TCP stream ──────────────────────────────────────────

class FrameExtractor {
    constructor() {
        this._buf = [];
        this._inFrame = false;
    }

    feed(data) {
        const frames = [];
        for (const b of data) {
            if (b === SLIP_END) {
                if (this._inFrame && this._buf.length > 0) {
                    frames.push(slipDecode(Buffer.from(this._buf)));
                }
                this._buf = [];
                this._inFrame = true;
            } else if (this._inFrame) {
                this._buf.push(b);
            }
        }
        return frames;
    }
}

// ── Frame decoder ─────────────────────────────────────────────────────────────

function decodeFrame(frame) {
    if (frame.length < 8) return null;
    if (frame[0] !== VER_BYTE) return null;

    const dataCrc = frame.slice(1, -2);
    const expected = (frame[frame.length - 2] << 8) | frame[frame.length - 1];
    const actual   = crc16(dataCrc);
    if (actual !== expected) return null;

    return {
        dest:    (frame[1] << 8) | frame[2],
        src:     (frame[3] << 8) | frame[4],
        seq:     frame[5],
        payload: frame.slice(6, -2),
    };
}

// ── Radio state ───────────────────────────────────────────────────────────────

function makeRadioState(rseId, port, name, radioType, isRx) {
    return {
        rse_id:     rseId,
        port,
        name,
        radio_type: radioType,
        is_rx:      isRx,
        connected:  false,
        last_seen:  null,
        // Settings 1
        frequency_mhz: '—',
        mode:          '—',
        // TX BITE
        supply_voltage: '—',
        pa_temp_c:      '—',
        fwd_power_w:    '—',
        refl_power_w:   '—',
        modulation_pct: '—',
        // RX BITE
        rx_supply_voltage: '—',
        sensitivity_dbm:   '—',
        // Settings 2
        squelch_dbm: '—',
        // Overall
        status: '—',
    };
}

// Default radio mapping — RSE 90 WAJJ Sentani
const MARC_RADIO_DEFAULTS = [
    { port: 2, name: 'VHF ADC SEC RX',    radioType: 'T6R',    isRx: true  },
    { port: 3, name: 'VHF ADC SEC RX_2',  radioType: 'T6R',    isRx: true  },
    { port: 4, name: 'VHF ER TX 1',       radioType: 'T6T100', isRx: false },
    { port: 5, name: 'VHF ER TX 2',       radioType: 'T6T',    isRx: false },
    { port: 6, name: 'VHF APP TMA TX',    radioType: 'T6T100', isRx: false },
    { port: 7, name: 'VHF APP TMA TX_2',  radioType: 'T6T100', isRx: false },
    { port: 8, name: 'VHF ADC TX',        radioType: 'T6T',    isRx: false },
    { port: 9, name: 'VHF ADC TX_2',      radioType: 'T6T',    isRx: false },
];

// ── T6 reply decoder ──────────────────────────────────────────────────────────

function decodeT6Reply(payload, srcId, states) {
    if (payload.length < 3) return false;
    if (payload[0] !== T6_PREFIX) return false;

    const port = payload[1];
    const cmd  = payload[2];
    const stateKey = `${srcId}:${port}`;
    if (!states[stateKey]) return false;

    const state = states[stateKey];
    state.last_seen = Date.now();
    state.connected = true;
    const data = payload.slice(3);

    if (cmd === RPL_SETTINGS1 && data.length >= 8) {
        // Frequency: BCD encoded bytes 0-2
        const bcd = `${data[0].toString(16).padStart(2,'0')}${data[1].toString(16).padStart(2,'0')}${data[2].toString(16).padStart(2,'0')}`;
        const freqMhz = `${bcd.slice(0,3)}.${bcd.slice(3,6)}`;
        const freqVal = parseFloat(freqMhz);
        if (freqVal >= 100.0 && freqVal <= 200.0) {
            state.frequency_mhz = freqMhz;
        }
        state.status = 'READY';
        return true;
    }

    if (cmd === RPL_TX_BITE && data.length >= 9) {
        // [0] = status flags: 0x20=on-air/main, 0x40=standby
        const statusByte = data[0];
        if (statusByte === 0x20) {
            state.status = 'READY';
            state.mode   = 'Main';
        } else if (statusByte === 0x40) {
            state.status = 'READY';
            state.mode   = 'Standby';
        } else {
            state.status = 'READY';
        }
        // [4] = supply voltage (integer V)
        state.supply_voltage = String(data[4]);
        // [5] = PA temp (signed)
        let paTemp = data[5];
        if (paTemp > 127) paTemp -= 256;
        state.pa_temp_c = String(paTemp);
        // [6] = fwd power W
        state.fwd_power_w  = String(data[6]);
        // [7] = refl power W
        state.refl_power_w = String(data[7]);
        // [8] = modulation %
        state.modulation_pct = String(data[8]);
        return true;
    }

    if (cmd === RPL_RX_BITE && data.length >= 6) {
        // [0] = status flags (0x40=normal)
        state.status = 'READY';
        state.mode   = 'Main';
        // [2] = supply voltage (integer V)
        state.rx_supply_voltage = String(data[2]);
        // [5] = sensitivity raw — formula: -(raw - 43)
        if (data.length > 5 && data[5] > 0) {
            const sensDbm = data[5] - 43;
            state.sensitivity_dbm = `-${sensDbm}`;
        }
        return true;
    }

    if (cmd === RPL_SETTINGS2 && data.length >= 9) {
        // [8] = squelch (signed int8) — RX only
        if (state.is_rx) {
            let squelchRaw = data[8];
            if (squelchRaw > 127) squelchRaw -= 256;
            state.squelch_dbm = String(squelchRaw);
        }
        return true;
    }

    return false;
}

// ── Shared MARC TCP Client ────────────────────────────────────────────────────
// Satu instance per IP:port — di-share antar equipment

class MarcRseClient {
    /**
     * @param {string} host  - Moxa IP
     * @param {number} port  - Moxa TCP port (default 950)
     * @param {number} pollInterval - Detik antar poll cycle (default 30)
     */
    constructor(host, port = 950, pollInterval = 30) {
        this.host         = host;
        this.port         = port;
        this.pollInterval = pollInterval;

        this._socket    = null;
        this._running   = false;
        this._connected = false;
        this._builder   = new PacketBuilder();
        this._extractor = new FrameExtractor();
        this._pollTimer = null;
        this._reconnectTimer = null;

        // Dynamic radio states, keyed by "rseId:port"
        this.states = {};

        // Callbacks
        this.onDataUpdated = null;  // (port) => void
        this.onConnected   = null;  // () => void
        this.onDisconnected= null;  // () => void
        this.onError       = null;  // (msg) => void
    }

    get isConnected() { return this._connected; }

    start() {
        if (this._running) return;
        this._running = true;
        this._connect();
    }

    stop() {
        this._running = false;
        clearTimeout(this._reconnectTimer);
        clearTimeout(this._pollTimer);
        this._close();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _connect() {
        if (!this._running) return;

        const sock = new net.Socket();
        sock.setTimeout(10000);

        sock.connect(this.port, this.host, () => {
            console.log(`[MARC] Connected to ${this.host}:${this.port}`);
            this._socket    = sock;
            this._connected = true;
            sock.setTimeout(0);

            if (this.onConnected) this.onConnected();

            // Drain initial data, lalu mulai poll
            setTimeout(() => {
                try { sock.read(); } catch(e) {}
                this._schedulePoll(0);
            }, 500);
        });

        sock.on('data', (chunk) => {
            const frames = this._extractor.feed(chunk);
            for (const frame of frames) {
                const decoded = decodeFrame(frame);
                if (decoded && decoded.payload && decoded.payload.length > 1) {
                    const srcId = decoded.src;
                    const updated = decodeT6Reply(decoded.payload, srcId, this.states);
                    if (updated) {
                        const port = decoded.payload[1];
                        if (this.onDataUpdated) this.onDataUpdated(`${srcId}:${port}`);
                    }
                }
            }
        });

        sock.on('error', (err) => {
            console.error(`[MARC] Socket error: ${err.message}`);
            if (this.onError) this.onError(err.message);
        });

        sock.on('timeout', () => {
            console.warn(`[MARC] Socket timeout`);
            sock.destroy();
        });

        sock.on('close', () => {
            const wasConnected = this._connected;
            this._connected = false;
            this._socket    = null;
            clearTimeout(this._pollTimer);

            if (wasConnected && this.onDisconnected) this.onDisconnected();

            // Mark all radios stale
            for (const state of Object.values(this.states)) {
                if (state.connected) {
                    state.connected = false;
                    state.status    = 'NO DATA';
                }
            }

            if (this._running) {
                console.log('[MARC] Reconnecting in 5s...');
                this._reconnectTimer = setTimeout(() => this._connect(), 5000);
            }
        });
    }

    _close() {
        this._connected = false;
        if (this._socket) {
            try { this._socket.destroy(); } catch(e) {}
            this._socket = null;
        }
    }

    _send(data) {
        if (this._socket && this._connected) {
            try { this._socket.write(data); } catch(e) {}
        }
    }

    _schedulePoll(delayMs) {
        clearTimeout(this._pollTimer);
        this._pollTimer = setTimeout(() => this._doPoll(), delayMs);
    }

    async _doPoll() {
        if (!this._running || !this._connected) return;

        // Kirim T6 commands per port dengan delay antar port
        // RSE tidak bisa handle burst — perlu jeda 150ms per port
        const PORT_DELAY_MS = 150;

        for (const stateKey of Object.keys(this.states)) {
            if (!this._running || !this._connected) break;
            
            const state = this.states[stateKey];
            const rseId = state.rse_id;
            const port = state.port;

            // Settings 1
            this._send(this._builder.buildT6Cmd(rseId, port, CMD_SETTINGS1));
            await this._delay(PORT_DELAY_MS);

            if (!this._connected) break;

            // BITE (RX atau TX)
            const biteCmd = state.is_rx ? CMD_RX_BITE : CMD_TX_BITE;
            this._send(this._builder.buildT6Cmd(rseId, port, biteCmd));
            await this._delay(PORT_DELAY_MS);

            // Settings 2 untuk RX (berisi squelch)
            if (state.is_rx && this._connected) {
                this._send(this._builder.buildT6Cmd(rseId, port, CMD_SETTINGS2));
                await this._delay(PORT_DELAY_MS);
            }
        }

        // Tandai radio stale jika tidak ada data > 3× poll interval
        const staleThreshold = this.pollInterval * 3 * 1000;
        for (const state of Object.values(this.states)) {
            if (state.last_seen && (Date.now() - state.last_seen) > staleThreshold) {
                if (state.connected) {
                    state.connected = false;
                    state.status    = 'NO DATA';
                    if (this.onDataUpdated) this.onDataUpdated(state.port);
                }
            }
        }

        // Schedule poll berikutnya (setelah seluruh cycle selesai)
        this._schedulePoll(this.pollInterval * 1000);
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    registerTarget(rseId, port, name, isRx) {
        const key = `${rseId}:${port}`;
        if (!this.states[key]) {
            this.states[key] = makeRadioState(rseId, port, name, isRx ? 'T6R' : 'T6T', isRx);
        }
    }

    /**
     * Ambil snapshot state untuk rse:port tertentu
     */
    getStateSnapshot(rseId, port) {
        const key = `${rseId}:${port}`;
        const s = this.states[key];
        if (!s) return null;
        return { ...s };
    }
}

// ── Shared client registry (keyed by "host:port") ────────────────────────────

const _sharedClients = new Map();

function getOrCreateClient(host, tcpPort, pollInterval) {
    const key = `${host}:${tcpPort}`;
    if (!_sharedClients.has(key)) {
        const client = new MarcRseClient(host, tcpPort, pollInterval);
        client.start();
        _sharedClients.set(key, client);
        console.log(`[MARC] Created shared client for ${key}`);
    }
    return _sharedClients.get(key);
}

// ── Parser class ──────────────────────────────────────────────────────────────

/**
 * MarcPaeParser
 *
 * Dipanggil oleh collector untuk setiap equipment.
 * Setiap equipment memiliki `rse_configs` (array of { rse_id, ports }).
 * Semua equipment yang pakai Moxa yang sama berbagi satu MarcRseClient.
 *
 * parse() di sini dipanggil secara periodik oleh collector (bukan event-driven).
 * Parser membaca snapshot state terkini dari shared client.
 */
class MarcPaeParser extends BaseParser {
    /**
     * opts.host         - Moxa IP
     * opts.port         - Moxa TCP port (default 950)
     * opts.rse_configs  - Array config, e.g. [{ rse_id: 90, ports: [2, 3] }]
     * opts.poll_interval- Detik antar poll (default 30)
     */
    constructor(opts = {}) {
        super(opts);
        this._host        = opts.host        || opts.ip  || '192.168.100.151';
        this._tcpPort     = opts.port        || 950;
        this._rseConfigs  = opts.rse_configs || [];
        this._pollInterval= opts.poll_interval || 30;

        // Pastikan shared client sudah berjalan
        this._client = getOrCreateClient(this._host, this._tcpPort, this._pollInterval);

        // Register target radios to the client
        for (const rse of this._rseConfigs) {
            const rseId = rse.rse_id;
            for (const port of (rse.ports || [])) {
                const isRx = (port === 2 || port === 3); // simple heuristic
                this._client.registerTarget(rseId, port, `RSE ${rseId} Port ${port}`, isRx);
            }
        }
    }

    /**
     * parse() dipanggil oleh collector/network_listener.
     * rawData diabaikan — data diambil langsung dari shared client state.
     */
    parse(_rawData) {
        try {
            if (!this._client.isConnected) {
                return {
                    success: false,
                    error:   'MARC client not connected',
                    status:  'Disconnect',
                    timestamp: new Date().toISOString(),
                };
            }

            if (this._rseConfigs.length === 0) {
                return {
                    success: false,
                    error:   'No rse_configs configured',
                    status:  'Error',
                    timestamp: new Date().toISOString(),
                };
            }

            // Kumpulkan snapshot per radio
            const rses = [];
            let anyConnected = false;
            let anyAlarm     = false;

            for (const rse of this._rseConfigs) {
                const rseId = rse.rse_id;
                const radios = {};
                for (const port of (rse.ports || [])) {
                    const snap = this._client.getStateSnapshot(rseId, port);
                    if (!snap) continue;
                    radios[port] = snap;
                    if (snap.connected) anyConnected = true;
                    if (snap.status === 'ALARM') anyAlarm = true;
                }
                rses.push({
                    rse_id: rseId,
                    radios
                });
            }

            if (!anyConnected) {
                return {
                    success: false,
                    error:   'No radio data received',
                    status:  'Disconnect',
                    data:    { rses },
                    timestamp: new Date().toISOString(),
                };
            }

            // Status equipment = worst dari semua radio-nya
            const status = anyAlarm ? 'Alarm' : 'Normal';

            // Flat summary (ambil dari radio pertama yang connected untuk nilai utama)
            let firstConnected = null;
            for (const rse of rses) {
                for (const p of Object.values(rse.radios)) {
                    if (p && p.connected) {
                        firstConnected = p;
                        break;
                    }
                }
                if (firstConnected) break;
            }

            const flat = {
                // Summary radio pertama
                frequency_mhz:  firstConnected ? firstConnected.frequency_mhz : '—',
                mode:            firstConnected ? firstConnected.mode          : '—',
                status_text:     firstConnected ? firstConnected.status        : '—',

                // Semua RSE dan radionya
                rses,

                // Metadata
                marc_host:    this._host,
                marc_tcp_port: this._tcpPort,
            };

            return {
                success: true,
                data:    flat,
                status,
                alarms:  anyAlarm ? ['Radio status ALARM'] : [],
                warnings: [],
                triggeredParams: [],
                timestamp: new Date().toISOString(),
            };

        } catch (err) {
            console.error(`[MARC PAE] Parse error: ${err.message}`);
            return {
                success: false,
                error:   err.message,
                status:  'Error',
                timestamp: new Date().toISOString(),
            };
        }
    }
}

module.exports = MarcPaeParser;

// ── Discovery function ────────────────────────────────────────────────────────

async function discoverMarcRSEs(host, port, startRse, endRse, timeoutMs = 1500) {
    const net = require('net');
    return new Promise((resolve) => {
        const sock = new net.Socket();
        const builder = new PacketBuilder();
        const extractor = new FrameExtractor();
        
        const results = [];
        let currentRse = startRse;
        let currentPort = 2; // Test ports 2-9
        
        let discoveryTimer = null;
        let isResolved = false;

        function finish() {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(discoveryTimer);
            sock.destroy();
            console.log(`[MARC DISCOVERY] Finished. Found:`, JSON.stringify(results));
            resolve({ success: true, data: results });
        }

        sock.setTimeout(timeoutMs * 2);

        sock.connect(port, host, () => {
            console.log(`[MARC DISCOVERY] Connected to ${host}:${port}, scanning ${startRse}-${endRse}`);
            sock.setTimeout(0);
            
            // Start scanning loop
            nextProbe();
        });

        async function nextProbe() {
            if (isResolved) return;
            
            if (currentRse > endRse) {
                // Wait a bit for the last responses to arrive before destroying socket
                discoveryTimer = setTimeout(() => {
                    finish();
                }, 1000);
                return;
            }

            if (currentPort > 9) {
                currentPort = 2;
                currentRse++;
                nextProbe();
                return;
            }

            // Probe RSE + port with Settings1
            const cmd = builder.buildT6Cmd(currentRse, currentPort, CMD_SETTINGS1);
            try {
                sock.write(cmd);
            } catch (e) {}

            // Wait a short time for response
            discoveryTimer = setTimeout(() => {
                currentPort++;
                nextProbe();
            }, 150);
        }

        sock.on('data', (chunk) => {
            const frames = extractor.feed(chunk);
            for (const frame of frames) {
                const decoded = decodeFrame(frame);
                if (decoded && decoded.payload && decoded.payload.length >= 3) {
                    if (decoded.payload[0] === T6_PREFIX) {
                        const rseId = decoded.src;
                        const rxPort = decoded.payload[1];
                        
                        console.log(`[MARC DISCOVERY] Received reply from RSE ${rseId} Port ${rxPort}`);
                        let rseObj = results.find(r => r.rse_id === rseId);
                        if (!rseObj) {
                            rseObj = { rse_id: rseId, ports: [] };
                            results.push(rseObj);
                        }
                        if (!rseObj.ports.includes(rxPort)) {
                            rseObj.ports.push(rxPort);
                        }
                    }
                }
            }
        });

        sock.on('error', (err) => {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(discoveryTimer);
                resolve({ success: false, error: err.message });
            }
        });

        sock.on('timeout', () => {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(discoveryTimer);
                sock.destroy();
                resolve({ success: false, error: 'Connection timeout' });
            }
        });
    });
}

// Export internal utilities untuk testing
module.exports._internal = {
    crc16, slipEncode, slipDecode, decodeFrame,
    decodeT6Reply, PacketBuilder, FrameExtractor,
    MarcRseClient, getOrCreateClient, discoverMarcRSEs
};
