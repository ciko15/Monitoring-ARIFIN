const BaseParser = require('./base');

/**
 * ILS GlidePath Parser — Thales 421
 * AirNav Indonesia · Sentani Airport (WAJJ)
 *
 * Source  : IP 192.168.50.160  Port 950  (Moxa NPort TCP)
 * Protocol: Binary stream, PKT_C = 92 bytes
 *
 * Sync: byte[0]=0x11, byte[1]=0x8D, byte[3]=0x0C  (byte[2] varies)
 * byte[2]:  bit7=Remote mode, bit6=TX1 MAIN flag
 *   0x40 = Local/TX1 MAIN
 *   0x80 = Remote/TX2 MAIN
 *   0xC0 = Remote/TX1 MAIN
 *
 * byte[4]: 0x00=TX1 data, 0x10=TX2 data
 *
 * Parameters float32 LE:
 *   off=15 RF_POWER    CRS Pos. RF Level   %
 *   off=19 DDM_COURSE  CRS Pos. DDM        raw×100=%
 *   off=23 CARRIER_PWR CRS Pos. SDM        %
 *   off=31 CSB_POWER   CRS Width RF Level  %
 *   off=35 DDM_CLR     CRS Width DDM       raw×100=%
 *   off=39 SBO_POWER   CRS Width SDM       %
 *   off=43 CLR_POWER   CLR Width RF Level  %
 *   off=47 CLR_DDM     CLR Width DDM       raw×100=%
 *   off=51 CLR_SDM     CLR Width SDM       %
 *   off=57 RF_OUT      Nearfield Pos. RF   %
 *   off=61 DDM_MON     Nearfield Pos. DDM  raw×100=%
 *   off=65 MON_POWER   Monitor Power       %
 *   off=66 GP_ANGLE    GP Angle            °  (~3.041 RWY24 WAJJ)
 */

const PKT_C_SIZE = 92;

// Protokol Mandiri Thales 421 untuk GP (Menggunakan E9/E8, berbeda dengan LLZ yang F9/F8)
const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xE9, 0x06]); // Request Data (Executive Measurement)
const HBEAT_RECV   = Buffer.from([0x13, 0x00, 0xE8, 0x06]); // Heartbeat idle dari device
const HBEAT_REPLY  = Buffer.from([0x13, 0x00, 0xE9, 0x06]); // Balasan heartbeat kita ke device

function isPktCSync(buf, i) {
    return i + 3 < buf.length &&
           buf[i] === 0x11 && buf[i+1] === 0x8D &&
           (buf[i+3] === 0x0C || buf[i+3] === 0x0E);
}

const OFFSETS = {
    CRS_POS_RF: 43,
    CRS_POS_DDM: 47,
    CRS_POS_SDM: 51,
    CRS_WID_RF: 55,
    CRS_WID_DDM: 59,
    CRS_WID_SDM: 63,
    CLR_WID_RF: 67,
    CLR_WID_DDM: 71,
    CLR_WID_SDM: 75,
    NF_POS_RF: 79,
    NF_POS_DDM: 83
};

const DDM_X100 = new Set(['DDM_COURSE', 'DDM_CLR', 'CLR_DDM', 'DDM_MON']);

const LIMITS = {
    GP_ANGLE:    [2.75,  3.25 ],
    RF_POWER:    [90.0,  110.0],
    CSB_POWER:   [85.0,  110.0],
    CLR_POWER:   [85.0,  120.0],
    RF_OUT:      [70.0,  125.0],
    CARRIER_PWR: [65.0,  82.0 ],
    SBO_POWER:   [65.0,  82.0 ],
    CLR_SDM:     [65.0,  82.0 ],
    MON_POWER:   [65.0,  90.0 ],
    DDM_COURSE:  [-4.0,  4.0  ],
    DDM_CLR:     [10.0,  22.0 ],
    CLR_DDM:     [20.0,  35.0 ],
    DDM_MON:     [-4.0,  4.0  ],
};

const PARAM_LABELS = {
    RF_POWER:    ['CRS Pos. RF Level',  '%'],
    DDM_COURSE:  ['CRS Pos. DDM',       '%'],
    CARRIER_PWR: ['CRS Pos. SDM',       '%'],
    CSB_POWER:   ['CRS Width RF Level', '%'],
    DDM_CLR:     ['CRS Width DDM',      '%'],
    SBO_POWER:   ['CRS Width SDM',      '%'],
    CLR_POWER:   ['CLR Width RF Level', '%'],
    CLR_DDM:     ['CLR Width DDM',      '%'],
    CLR_SDM:     ['CLR Width SDM',      '%'],
    RF_OUT:      ['Nearfield Pos. RF',  '%'],
    DDM_MON:     ['Nearfield Pos. DDM', '%'],
    MON_POWER:   ['Monitor Power',      '%'],
    GP_ANGLE:    ['GP Angle',           '°'],
};

const PASSIVE_TIMEOUT = 30000;
const POLL_INTERVAL   = 2000;
const POLL_REQ_DELAY  = 150;

function readFloat(buf, offset) {
    try {
        if (offset + 4 > buf.length) return null;
        const v = buf.readFloatLE(offset);
        return (isFinite(v) && Math.abs(v) < 1e6) ? v : null;
    } catch (e) { return null; }
}

function decodePktC(pkt) {
    if (!pkt || pkt.length < PKT_C_SIZE) return null;

    const subtype = pkt[3] === 0x0C ? 'Transmitter' : 'Monitor';
    const params = {};
    
    // Hanya ekstrak nilai RF dari paket Monitor (0x0E) agar tidak tertimpa angka 0 dari paket TX
    if (subtype === 'Monitor') {
        for (const [key, offset] of Object.entries(OFFSETS)) {
            let val = readFloat(pkt, offset);
            if (val === null) continue;
            val = DDM_X100.has(key)
                ? parseFloat((val * 100).toFixed(3))
                : parseFloat(val.toFixed(3));
            params[key] = val;
        }
    }
    const txData = (pkt[4] === 0x10 || pkt[4] === 0xAC) ? 'TX2' : 'TX1';
    
    const byte2 = pkt[2];
    const isRemote = !!(byte2 & 0x80);
    const tx1IsMain = !!(byte2 & 0x40);

    return {
        subtype,
        tx_data: txData,
        tx_main: tx1IsMain ? 'TX 1' : 'TX 2',
        tx_stby: tx1IsMain ? 'TX 2' : 'TX 1',
        is_remote: isRemote,
        params,
    };
}

function extractFrames(buf) {
    const results = [];
    for (let i = 0; i <= buf.length - PKT_C_SIZE; i++) {
        if (isPktCSync(buf, i)) {
            const dec = decodePktC(buf.slice(i, i + PKT_C_SIZE));
            if (dec) {
                results.push({ pos: i, decoded: dec });
                i += PKT_C_SIZE - 1; 
            }
        }
    }
    return results;
}

function hasPartialFrame(buf) {
    for (let i = 0; i < buf.length; i++) {
        if (isPktCSync(buf, i)) {
            return i + PKT_C_SIZE > buf.length;
        }
    }
    return buf.length > 0 && buf.length < PKT_C_SIZE;
}

function checkAlarms(params) {
    const alarms = [];
    for (const [key, lim] of Object.entries(LIMITS)) {
        const v = params[key];
        if (v == null) continue;
        if (v < lim[0] || v > lim[1]) {
            const [label, unit] = PARAM_LABELS[key] || [key, ''];
            alarms.push(`${label}=${v.toFixed(3)}${unit} [${lim[0]}~${lim[1]}]`);
        }
    }
    return alarms;
}

class IlsGpThales421Parser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._lastDataTime = Date.now();
        this._mode = 'PASSIVE';
        this._lastDecoded = null;
    }

    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            if (this._buf.length > 131072) {
                let ls = -1;
                for (let i = this._buf.length - 4; i >= 0; i--) {
                    if (isPktCSync(this._buf, i)) { ls = i; break; }
                }
                this._buf = ls > 0 ? this._buf.slice(ls) : Buffer.alloc(0);
            }

            const now = Date.now();
            if (now - this._lastDataTime > PASSIVE_TIMEOUT && this._mode === 'PASSIVE') {
                this._mode = 'ACTIVE';
            }

            const frames = extractFrames(this._buf);
            if (frames.length === 0) {
                // Prevent buffer accumulation CPU spike
                if (this._buf.length > 1024) {
                    this._buf = this._buf.slice(this._buf.length - 512);
                }
                const waitingError = hasPartialFrame(this._buf) ? 'Menunggu data' : 'No valid GP frames';
                return { success: false, error: waitingError, status: 'Waiting',
                         _mode: this._mode,
                         data: this._lastDecoded ? this._buildOutput(this._lastDecoded, true).data : null };
            }

            // Gabungkan state dari semua frame di chunk ini (supaya data RF dari Monitor tidak hilang)
            this._lastDecoded = this._lastDecoded || { params: {} };
            let lastPos = 0;
            
            for (const frame of frames) {
                const d = frame.decoded;
                this._lastDecoded.tx_main = d.tx_main;
                this._lastDecoded.tx_stby = d.tx_stby;
                this._lastDecoded.is_remote = d.is_remote;
                this._lastDecoded.tx_data = d.tx_data;
                this._lastDecoded.subtype = d.subtype;
                
                if (d.subtype === 'Monitor') {
                    Object.assign(this._lastDecoded.params, d.params);
                }
                lastPos = frame.pos;
            }

            this._lastDataTime = now;
            if (this._mode === 'ACTIVE') this._mode = 'PASSIVE';
            this._buf = this._buf.slice(lastPos + PKT_C_SIZE);

            return this._buildOutput(this._lastDecoded, false);
        } catch (err) {
            return { success: false, error: err.message, status: 'Error', timestamp: new Date().toISOString() };
        }
    }

    _buildOutput(d, isStale) {
        const alarms = checkAlarms(d.params);
        return {
            success: true,
            data: {
                _mode: this._mode, _stale: isStale,
                tx_main: d.tx_main, tx_stby: d.tx_stby,
                is_remote: d.is_remote, tx_data: d.tx_data,
                status_label:  d.is_remote ? 'Remote Maintenance' : 'Normal',
                tx_main_label: `${d.tx_main} MAIN`,
                tx_stby_label: `${d.tx_stby} STBY`,
                ...d.params,
            },
            status: alarms.length > 0 ? 'Alarm' : 'Normal',
            alarms, warnings: [], triggeredParams: alarms,
            timestamp: new Date().toISOString(),
        };
    }

    getPollRequests() {
        return [{ bytes: TRIGGER_SEND, label: 'DATA_REQUEST' }];
    }
    
    isHeartbeat(buf) {
        if (buf.length < 4) return false;
        // GP often sends 1B 00 E9 06 or 13 00 E8 06 as heartbeat/ACK
        const b0 = buf[0];
        const b2 = buf[2];
        return (b0 === 0x13 || b0 === 0x1B) && buf[1] === 0x00 &&
               (b2 === 0xE8 || b2 === 0xE9) && buf[3] === 0x06;
    }
    
    getHeartbeatReply() {
        return TRIGGER_SEND;
    }

    getMode()         { return this._mode; }
    getLastData()     { return this._lastDecoded ? this._lastDecoded.params : {}; }
    reset()           { this._buf = Buffer.alloc(0); }
}

module.exports = IlsGpThales421Parser;
module.exports.OFFSETS      = OFFSETS;
module.exports.LIMITS       = LIMITS;
module.exports.PARAM_LABELS = PARAM_LABELS;
