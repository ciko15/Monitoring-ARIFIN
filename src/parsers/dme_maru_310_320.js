const BaseParser = require('./base');

/**
 * DME Maru 310/320 Parser — ported from dme_monitor.py v2.0
 * AirNav Indonesia · Sentani Airport (WAJJ)
 *
 * Protocol : SOH + ASCII_HEX(header) + STX + ASCII_HEX(payload) + ETX
 * Header   : starts with 0x01 0x02, byte[2]=unit, byte[6:8]=length (0x7A)
 * Payload  : 122 bytes binary, decoded with w16() offset map
 * Units    : 2 = TXP1, 3 = TXP2
 * IP       : 192.168.168.42  Port: 950 (TCP)
 */

// ── Active polling requests (from Wireshark capture MARU 320 → Moxa DME) ──────
const POLL_REQUESTS = [
    Buffer.from('\x01' + '01020302' + '0100000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020402' + '0100000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020502' + '0100000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020100' + '0100000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020420' + '0100000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020520' + '0100000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020280' + '01FF000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020380' + '01FF000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
    Buffer.from('\x01' + '01020202' + '0100000000000000000000000000000000000000' + '\x02' + '1D0F' + '\x03'),
];

const PASSIVE_TIMEOUT = 30000; // ms
const POLL_INTERVAL   = 2000;  // ms
const POLL_REQ_DELAY  = 150;   // ms

const LIMITS = {
    sys_delay:  [49.5,  50.5],
    dur_a:      [3.0,   3.8],
    dur_b:      [3.0,   3.8],
    rise_a:     [1.5,   2.5],
    rise_b:     [1.5,   2.5],
    decay_a:    [1.5,   2.5],
    decay_b:    [1.5,   2.5],
    spacing:    [11.5,  12.5],
    reply_eff:  [70,    100],
    pair_rate:  [700,   1400],
    fwd_power:  [800,   1200],
};

// ── w16: read big-endian uint16 from buffer ──────────────────────────────────
function w16(data, offset) {
    try {
        if (offset + 2 > data.length) return null;
        return data.readUInt16BE(offset);
    } catch(e) { return null; }
}

// ── decode_7a: decode 122-byte DME payload ───────────────────────────────────
function decode7a(data) {
    if (data.length < 0x7A) return null;
    const r = {};

    // MON1 parameters
    r.m1_sys_delay = w16(data, 0x00) / 100.0;
    r.m1_rise_a    = w16(data, 0x02) / 100.0;
    r.m1_rise_b    = w16(data, 0x04) / 100.0;
    r.m1_decay_a   = w16(data, 0x06) / 100.0;
    r.m1_decay_b   = w16(data, 0x08) / 100.0;
    r.m1_dur_a     = w16(data, 0x0A) / 100.0;
    r.m1_dur_b     = w16(data, 0x0C) / 100.0;
    r.m1_spacing   = w16(data, 0x0E) / 100.0;
    r.m1_reply_eff = w16(data, 0x10);
    r.m1_pair_rate = w16(data, 0x12);
    r.m1_fwd_power = w16(data, 0x16) / 10.0;

    // MON2 parameters
    r.m2_sys_delay = w16(data, 0x20) / 100.0;
    r.m2_rise_a    = w16(data, 0x22) / 100.0;
    r.m2_rise_b    = w16(data, 0x24) / 100.0;
    r.m2_decay_a   = w16(data, 0x26) / 100.0;
    r.m2_decay_b   = w16(data, 0x28) / 100.0;
    r.m2_dur_a     = w16(data, 0x2A) / 100.0;
    r.m2_dur_b     = w16(data, 0x2C) / 100.0;
    r.m2_spacing   = w16(data, 0x2E) / 100.0;
    r.m2_reply_eff = w16(data, 0x30);
    r.m2_pair_rate = w16(data, 0x32);
    r.m2_fwd_power = w16(data, 0x36) / 10.0;

    // IDENT
    try {
        r.ident = data.slice(0x5E, 0x61).toString('ascii').replace(/\x00/g, '').trim();
    } catch(e) { r.ident = '---'; }

    // Active/Standby: byte[0x5B]=0x20 → TXP1 ACTIVE, byte[0x67]=unit(1 or 2)
    if (data.length > 0x67) {
        const activeTxp = data[0x5B] === 0x20 ? 1 : 2;
        const unitNum   = data[0x67]; // 0x01=TXP1, 0x02=TXP2
        r.txp_active = (unitNum === activeTxp);
    } else {
        r.txp_active = null;
    }

    return r;
}

// ── parseFrames: extract frames from TCP stream buffer ───────────────────────
function parseFrames(buf) {
    const results = [];
    let i = 0;
    const SOH = 0x01, STX = 0x02, ETX = 0x03;

    while (i < buf.length - 3) {
        if (buf[i] !== SOH) { i++; continue; }

        const stxPos = buf.indexOf(STX, i + 1);
        if (stxPos < 0) break;

        const etxPos = buf.indexOf(ETX, stxPos + 1);
        if (etxPos < 0) break;

        try {
            const hdrHex = buf.slice(i + 1, stxPos).toString('ascii').trim();
            const payHex = buf.slice(stxPos + 1, etxPos).toString('ascii').trim();
            const hdr = Buffer.from(hdrHex, 'hex');
            const pay = Buffer.from(payHex, 'hex');

            // Validate header: starts 01 02, length bytes [6:8] = 0x7A
            if (hdr.length >= 8 && hdr[0] === 0x01 && hdr[1] === 0x02) {
                const unit   = hdr[2];
                const length = hdr.readUInt16BE(6);
                if (length === 0x7A && pay.length >= 0x7A) {
                    const decoded = decode7a(pay.slice(0, 0x7A));
                    if (decoded) {
                        decoded.unit = unit;
                        results.push(decoded);
                    }
                }
            }
        } catch(e) { /* skip malformed frame */ }

        i = etxPos + 1;
    }
    return results;
}

function hasPartialFrame(buf) {
    const sohPos = buf.lastIndexOf(0x01);
    if (sohPos < 0) return false;

    const stxPos = buf.indexOf(0x02, sohPos + 1);
    if (stxPos < 0) return true;

    const etxPos = buf.indexOf(0x03, stxPos + 1);
    return etxPos < 0;
}

// ── checkAlarms ──────────────────────────────────────────────────────────────
function checkAlarms(d, isActive) {
    const alarms = [];
    const checks = [
        ['m1_reply_eff', 'reply_eff'],
        ['m2_reply_eff', 'reply_eff'],
    ];
    if (isActive !== false) {
        checks.push(['m1_fwd_power', 'fwd_power']);
        checks.push(['m2_fwd_power', 'fwd_power']);
    }
    for (const [field, limitKey] of checks) {
        const v = d[field];
        const lim = LIMITS[limitKey];
        if (v !== null && v !== undefined && lim && (v < lim[0] || v > lim[1])) {
            alarms.push(`${field}=${v} out of range [${lim[0]}-${lim[1]}]`);
        }
    }
    return alarms;
}

// ── Parser class ─────────────────────────────────────────────────────────────
class DmeMaru310320Parser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._lastDataTime = Date.now(); // Start PASSIVE, switch to ACTIVE after 30s if no data
        this._mode = 'PASSIVE';
        this._buf  = Buffer.alloc(0);
        this._lastData = {}; // unit(2|3) → decoded frame
    }

    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            // Safety trim
            if (this._buf.length > 131072) {
                const lastSoh = this._buf.lastIndexOf(0x01);
                this._buf = lastSoh > 0 ? this._buf.slice(lastSoh) : Buffer.alloc(0);
            }

            // Mode check
            const now = Date.now();
            if (now - this._lastDataTime > PASSIVE_TIMEOUT && this._mode === 'PASSIVE') {
                this._mode = 'ACTIVE';
                console.log('[DME Maru 310/320] No data for 30s — switching to ACTIVE polling mode');
            }

            const frames = parseFrames(this._buf);

            if (frames.length === 0) {
                return {
                    success: false,
                    error: hasPartialFrame(this._buf) ? 'Menunggu data' : 'No valid DME frames',
                    status: 'Waiting',
                    _mode: this._mode
                };
            }

            // Update last data per unit
            this._lastDataTime = now;
            if (this._mode === 'ACTIVE') {
                this._mode = 'PASSIVE';
                console.log('[DME Maru 310/320] Data received — switching back to PASSIVE mode');
            }

            // Trim buffer past last ETX
            const lastEtx = this._buf.lastIndexOf(0x03);
            if (lastEtx >= 0) this._buf = this._buf.slice(lastEtx + 1);

            for (const f of frames) {
                if (f.unit === 2 || f.unit === 3) {
                    this._lastData[f.unit] = f;
                }
            }

            const d2 = this._lastData[2] || {};
            const d3 = this._lastData[3] || {};

            // Determine active TXP
            let txpActive = null;
            if (d2.txp_active === true) txpActive = 'TXP1';
            else if (d3.txp_active === true) txpActive = 'TXP2';

            const alarms2 = checkAlarms(d2, d2.txp_active);
            const alarms3 = checkAlarms(d3, d3.txp_active);
            const allAlarms = [...alarms2.map(a => `TXP1 ${a}`), ...alarms3.map(a => `TXP2 ${a}`)];

            // Flatten for dashboard
            const flat = {
                _mode: this._mode,
                txp_active: txpActive,
                ident: d2.ident || d3.ident || '---',

                // TXP1 (unit 2) MON1
                txp1_m1_sys_delay:  d2.m1_sys_delay,
                txp1_m1_reply_eff:  d2.m1_reply_eff,
                txp1_m1_pair_rate:  d2.m1_pair_rate,
                txp1_m1_fwd_power:  d2.m1_fwd_power,
                txp1_m1_dur_a:      d2.m1_dur_a,
                txp1_m1_dur_b:      d2.m1_dur_b,
                txp1_m1_rise_a:     d2.m1_rise_a,
                txp1_m1_decay_a:    d2.m1_decay_a,
                txp1_m1_spacing:    d2.m1_spacing,
                // TXP1 MON2
                txp1_m2_sys_delay:  d2.m2_sys_delay,
                txp1_m2_reply_eff:  d2.m2_reply_eff,
                txp1_m2_pair_rate:  d2.m2_pair_rate,
                txp1_m2_fwd_power:  d2.m2_fwd_power,
                txp1_active:        d2.txp_active,

                // TXP2 (unit 3) MON1
                txp2_m1_sys_delay:  d3.m1_sys_delay,
                txp2_m1_reply_eff:  d3.m1_reply_eff,
                txp2_m1_pair_rate:  d3.m1_pair_rate,
                txp2_m1_fwd_power:  d3.m1_fwd_power,
                txp2_m1_dur_a:      d3.m1_dur_a,
                txp2_m1_dur_b:      d3.m1_dur_b,
                txp2_m1_rise_a:     d3.m1_rise_a,
                txp2_m1_decay_a:    d3.m1_decay_a,
                txp2_m1_spacing:    d3.m1_spacing,
                // TXP2 MON2
                txp2_m2_sys_delay:  d3.m2_sys_delay,
                txp2_m2_reply_eff:  d3.m2_reply_eff,
                txp2_m2_pair_rate:  d3.m2_pair_rate,
                txp2_m2_fwd_power:  d3.m2_fwd_power,
                txp2_active:        d3.txp_active,
            };

            let currentStatus = 'Normal';
            if (!d2.ident && !d3.ident) {
                currentStatus = 'Disconnect';
            } else if (allAlarms.length > 0) {
                currentStatus = 'Alarm';
            }

            return {
                success: true,
                data: flat,
                status: currentStatus,
                alarms: allAlarms,
                warnings: [],
                triggeredParams: allAlarms,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error(`[DME Maru 310/320] Parse error: ${error.message}`);
            return { success: false, error: error.message, status: 'Error', timestamp: new Date().toISOString() };
        }
    }

    getPollRequests() { return POLL_REQUESTS; }
    getMode()         { return this._mode; }
    getLastData()     { return this._lastData; }

    checkTimeout() {
        if (this._mode === 'PASSIVE' && Date.now() - this._lastDataTime > PASSIVE_TIMEOUT) {
            this._mode = 'ACTIVE';
            console.log('[DME Maru 310/320] Deadlock broken: No data for 30s — switching to ACTIVE polling mode');
        }
    }
}

module.exports = DmeMaru310320Parser;
module.exports.POLL_REQUESTS   = POLL_REQUESTS;
module.exports.PASSIVE_TIMEOUT = PASSIVE_TIMEOUT;
module.exports.POLL_INTERVAL   = POLL_INTERVAL;
module.exports.POLL_REQ_DELAY  = POLL_REQ_DELAY;
