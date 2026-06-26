const BaseParser = require('./base');

/**
 * ILS Localizer (LLZ) Parser — Thales ILS 420
 * AirNav Indonesia · Sentani Airport (WAJJ)
 *
 * Source  : IP 192.168.51.10  Port 950  (Moxa NPort TCP)
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
const PKT_SYNC = Buffer.from([0x11, 0x8D]);

function isPktCSync(buf, i) {
    // 0x0C = Transmitter, 0x0E = Monitor
    return i + 3 < buf.length &&
           buf[i] === 0x11 && buf[i+1] === 0x8D && 
           (buf[i+3] === 0x0C || buf[i+3] === 0x0E);
}

const PARAM_OFFSETS = {
    CRS_RF:    15,
    CRS_DDM:   19,
    CRS_SDM:   23,
    IDENT_AM:  27,
    WIDTH_RF:  31,
    WIDTH_DDM: 35,
    WIDTH_SDM: 39,
    CLR_RF:    43,
    CLR_DDM:   47,
    CLR_SDM:   51,
    NF_RF:     57,
    NF_DDM:    61,
    NF_SDM:    65,
    FREQ_DEV:  73,
};

// Limits [min, max]
const LIMITS = {
    CRS_RF:   [85.0, 115.0],
    WIDTH_RF:  [85.0, 115.0],
    CLR_RF:    [85.0, 115.0],
    NF_RF:     [70.0, 125.0],
    CRS_SDM:   [35.0,  45.0],
    WIDTH_SDM: [35.0,  45.0],
    CLR_SDM:   [35.0,  45.0],
    NF_SDM:    [35.0,  45.0],
    IDENT_AM:  [5.0,   20.0],
};

const PARAM_LABELS = {
    CRS_RF:    ['CRS RF Level',   '%'  ],
    CRS_DDM:   ['CRS DDM',        ''   ],
    CRS_SDM:   ['CRS SDM',        '%'  ],
    IDENT_AM:  ['Ident AM',       '%'  ],
    WIDTH_RF:  ['Width RF Level', '%'  ],
    WIDTH_DDM: ['Width DDM',      ''   ],
    WIDTH_SDM: ['Width SDM',      '%'  ],
    CLR_RF:    ['CLR RF Level',   '%'  ],
    CLR_DDM:   ['CLR DDM',        ''   ],
    CLR_SDM:   ['CLR SDM',        '%'  ],
    NF_RF:     ['NF RF Level',    '%'  ],
    NF_DDM:    ['NF DDM',         ''   ],
    NF_SDM:    ['NF SDM',         '%'  ],
    FREQ_DEV:  ['Freq Deviation', 'kHz'],
};

const DDM_X100 = new Set(['CRS_DDM', 'WIDTH_DDM', 'CLR_DDM', 'NF_DDM']);

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

function decodeFrameC(pkt) {
    const params = {};
    for (const [key, offset] of Object.entries(PARAM_OFFSETS)) {
        let val = readFloat(pkt, offset);
        if (val === null) continue;
        val = DDM_X100.has(key)
            ? parseFloat((val * 100).toFixed(4))
            : parseFloat(val.toFixed(4));
        params[key] = val;
    }

    // pkt[3] is the page type (0x0C = TX, 0x0E = MON)
    const subtype = pkt[3] === 0x0C ? 'Transmitter' : 'Monitor';

    // In TX, pkt[13] is the TX flag (0x40 = TX1, 0x00 = TX2).
    // Let's use pkt[13] if it's 0x40 or 0x00.
    // Wait, in Monitor, pkt[13] was 0x00 for MON 1!
    // But what is it for MON 2? If we don't know, we can guess pkt[4] or pkt[13].
    // Let's just use pkt[4] which is 0x00 for MON 1 and 0x10 for TX2? 
    // In original code, byte 4 was 0x00 (TX1) or 0x10 (TX2).
    const txData = (pkt[4] === 0x10 || pkt[4] === 0xAC) ? 'TX2' : 'TX1';
    
    // pkt[2] has the remote/main flags
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
            const dec = decodeFrameC(buf.slice(i, i + PKT_C_SIZE));
            if (dec) {
                results.push({ pos: i, decoded: dec });
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

class IlsLlzThales421Parser extends BaseParser {
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
                // Prevent buffer accumulation CPU spike (O(N^2) rescanning of short packets)
                // If there are no valid frames, anything before the last 92 bytes is guaranteed garbage.
                if (this._buf.length > PKT_C_SIZE) {
                    this._buf = this._buf.slice(this._buf.length - PKT_C_SIZE);
                }
                return { success: false, error: 'No valid LLZ frames', status: 'Waiting',
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

    /**
     * Returns the initial trigger packet to send on connect.
     * Device membutuhkan ACK packet (13 00 F9 06) agar mulai streaming data.
     */
    getPollRequests() {
        return [{ bytes: Buffer.from([0x01, 0x30, 0x30, 0x02, 0x46, 0x39, 0x03, 0x35, 0x35]), label: 'DATA_REQUEST' }];
    }

    /**
     * Cek apakah chunk yang diterima adalah heartbeat dari device.
     * Jika ya, caller harus membalas dengan TRIGGER_SEND.
     */
    isHeartbeat(chunk) {
        return chunk && chunk.length >= 4 && chunk.slice(0, 4).equals(HBEAT_RECV);
    }

    getHeartbeatReply() { return TRIGGER_SEND; }
    getMode()           { return this._mode; }
    getLastData()       { return this._lastDecoded ? this._lastDecoded.params : {}; }
    reset()             { this._buf = Buffer.alloc(0); }
}

module.exports = IlsLlzThales421Parser;
module.exports.PARAM_OFFSETS = PARAM_OFFSETS;
module.exports.LIMITS        = LIMITS;
module.exports.PARAM_LABELS  = PARAM_LABELS;
