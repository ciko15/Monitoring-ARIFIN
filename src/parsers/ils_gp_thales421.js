const BaseParser = require('./base');

/**
 * ILS GlidePath (GP) Parser — Thales ILS 421
 * AirNav Indonesia · Sentani Airport (WAJJ)
 *
 * Source  : IP 192.168.50.160  Port 950  (Moxa NPort TCP)
 * Protocol: Binary stream, DATA packet = 96 bytes
 *
 * Sync markers:
 *   SYNC_DATA  = 56 00 F9 06  (96-byte data packet)
 *   SYNC_HBEAT = 1B 00 F9 06  (heartbeat — skip)
 *   SYNC_ACK   = 13 00 F9 06  (ACK — skip)
 *
 * Packet structure (96 bytes):
 *   byte  0- 3: SYNC_DATA  = 56 00 F9 06
 *   byte  4- 7: F0 06 [seq] 92  — sequence counter
 *   byte  8-11: 01 00 00 11     — fixed header
 *   byte    12: subtype (0x0D or 0x8D)
 *   byte    13: TX flag (0x40=TX1 MAIN, 0x00=TX2 MAIN)
 *   byte 14-25: metadata
 *   byte 26-95: PAYLOAD  float32 LE
 *
 * Parameters (float32 LE, offset from packet start):
 *   off=26  CRS_RF      CRS RF Level         %
 *   off=30  CRS_DDM     CRS DDM              (raw, scale TBC)
 *   off=34  CRS_SDM     CRS SDM              %
 *   off=38  IDENT_AM    Ident AM             %
 *   off=42  WIDTH_RF    Width RF Level       %
 *   off=46  WIDTH_DDM   Width DDM            (raw, scale TBC)
 *   off=50  WIDTH_SDM   Width SDM            %
 *   off=54  CLR_RF      CLR RF Level         %
 *   off=58  CLR_DDM     CLR DDM              (raw, scale TBC)
 *   off=62  CLR_SDM     CLR SDM              %
 *   off=68  NF_RF       Near Field RF Level  %
 *   off=72  NF_DDM      Near Field DDM       (raw, scale TBC)
 *   off=76  NF_SDM      Near Field SDM       %
 *   off=84  FREQ_DEV    Freq Deviation       kHz
 */

const PKT_C_SIZE = 92;

// Protokol Mandiri Thales 421 (Hasil Sniffing)
const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]); // ACK / trigger kita kirim
const HBEAT_RECV   = Buffer.from([0x13, 0x00, 0xF8, 0x06]); // Heartbeat dari device
const HBEAT_REPLY  = Buffer.from([0x13, 0x00, 0xF9, 0x06]); // Balasan heartbeat kita ke device

function isPktCSync(buf, i) {
    return i + 3 < buf.length &&
           buf[i] === 0x11 && buf[i+1] === 0x8D && buf[i+3] === 0x0C;
}

const PARAM_OFFSETS = {
    RF_POWER:    15,
    DDM_COURSE:  19,
    CARRIER_PWR: 23,
    CSB_POWER:   31,
    DDM_CLR:     35,
    SBO_POWER:   39,
    CLR_POWER:   43,
    CLR_DDM:     47,
    CLR_SDM:     51,
    RF_OUT:      57,
    DDM_MON:     61,
    MON_POWER:   65,
    GP_ANGLE:    66,
};

// Limits [min, max]
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

const DDM_X100 = new Set(['DDM_COURSE', 'DDM_CLR', 'CLR_DDM', 'DDM_MON']);

const PASSIVE_TIMEOUT = 4000; // 4 detik, jika tidak ada data dari ADRACS, kita ambil alih
const POLL_INTERVAL   = 2000;
const POLL_REQ_DELAY  = 150;

function readFloat(buf, offset) {
    try {
        if (offset + 4 > buf.length) return null;
        const v = buf.readFloatLE(offset);
        return (isFinite(v) && Math.abs(v) < 1e6) ? v : null;
    } catch (e) { return null; }
}

function decodePacket(pkt) {
    if (!pkt || pkt.length < PKT_C_SIZE) return null;
    if (!isPktCSync(pkt, 0)) return null;

    const byte2     = pkt[2];
    const isRemote  = !!(byte2 & 0x80);
    const tx1IsMain = !!(byte2 & 0x40);
    
    // 0x00 = TX1, 0x10 = TX2
    // Jika nilainya selain itu (misal 0x01/0x02 untuk Monitor), maka abaikan paket ini
    if (pkt[4] !== 0x00 && pkt[4] !== 0x10) return null;
    
    // Validation removed because our own triggers don't always match this signature
    
    const txData    = pkt[4] === 0x10 ? 'TX2' : 'TX1';

    const params = {};
    for (const [key, offset] of Object.entries(PARAM_OFFSETS)) {
        let val = readFloat(pkt, offset);
        if (val === null) continue;
        val = DDM_X100.has(key)
            ? parseFloat((val * 100).toFixed(4))
            : parseFloat(val.toFixed(4));
        params[key] = val;
    }

    return {
        tx_main:  tx1IsMain ? 'TX1' : 'TX2',
        tx_stby:  tx1IsMain ? 'TX2' : 'TX1',
        tx_data:  txData,
        is_remote: isRemote,
        subtype:  pkt[1], // 0x8D
        tx_flag:  byte2,
        params,
    };
}

function extractFrames(buf) {
    const results = [];
    for (let i = 0; i <= buf.length - PKT_C_SIZE; i++) {
        if (isPktCSync(buf, i)) {
            const dec = decodePacket(buf.slice(i, i + PKT_C_SIZE));
            if (dec) {
                // Hanya ambil data dari TX yang sedang MAIN (aktif), abaikan STBY
                if (dec.tx_data === dec.tx_main) {
                    results.push({ pos: i, decoded: dec });
                }
                i += PKT_C_SIZE - 1;
            }
        }
    }
    return results;
}

function checkAlarms(params) {
    const alarms = [];
    for (const [key, lim] of Object.entries(LIMITS)) {
        const v = params[key];
        if (v == null) continue;
        if (v < lim[0] || v > lim[1]) {
            const [label, unit] = PARAM_LABELS[key] || [key, ''];
            alarms.push(`${label}=${v.toFixed(3)}${unit !== '' ? ' '+unit : ''} [${lim[0]}~${lim[1]}]`);
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
                let ls = 0;
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
                return { success: false, error: 'No valid GP frames', status: 'Waiting',
                         _mode: this._mode,
                         data: this._lastDecoded ? this._buildOutput(this._lastDecoded, true).data : null };
            }

            const latest = frames[frames.length - 1];
            this._lastDecoded = latest.decoded;
            this._lastDataTime = now;
            if (this._mode === 'ACTIVE') this._mode = 'PASSIVE';
            this._buf = this._buf.slice(latest.pos + PKT_C_SIZE);

            return this._buildOutput(latest.decoded, false);
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
                subtype: d.subtype,
                status_label:  'Normal',
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
        const mode = this.getMode();
        console.log(`[GP-DEBUG] getPollRequests called. Mode is: ${mode}`);
        if (mode === 'ACTIVE') {
            console.log(`[GP-DEBUG] Sending POLL_TRIGGER 00 00 F9 06 because ADRACS is offline`);
            const TRIGGER_POLL = Buffer.from([0x00, 0x00, 0xF9, 0x06]);
            return [{ bytes: TRIGGER_POLL, label: 'POLL_TRIGGER' }];
        }
        return [];
    }

    /**
     * Cek apakah chunk yang diterima adalah heartbeat dari device.
     * Jika ya, caller harus membalas dengan TRIGGER_SEND.
     */
    isHeartbeat(chunk) {
        return chunk && chunk.length >= 4 && chunk.slice(0, 4).equals(HBEAT_RECV);
    }

    getHeartbeatReply() { return TRIGGER_SEND; }
    getMode() {
        if (Date.now() - this._lastDataTime > PASSIVE_TIMEOUT && this._mode === 'PASSIVE') {
            this._mode = 'ACTIVE';
        }
        return this._mode;
    }
    getLastData()       { return this._lastDecoded ? this._lastDecoded.params : {}; }
    reset()             { this._buf = Buffer.alloc(0); }
}

module.exports = IlsGpThales421Parser;
module.exports.PARAM_OFFSETS = PARAM_OFFSETS;
module.exports.LIMITS        = LIMITS;
module.exports.PARAM_LABELS  = PARAM_LABELS;
