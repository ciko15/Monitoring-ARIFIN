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

const PACKET_SIZE  = 96;
const SYNC_DATA    = Buffer.from([0x56, 0x00, 0xF9, 0x06]);
const SYNC_HBEAT   = Buffer.from([0x1B, 0x00, 0xF9, 0x06]);
const SYNC_ACK     = Buffer.from([0x13, 0x00, 0xF9, 0x06]);

const PARAM_OFFSETS = {
    CRS_RF:    26,
    CRS_DDM:   30,
    CRS_SDM:   34,
    IDENT_AM:  38,
    WIDTH_RF:  42,
    WIDTH_DDM: 46,
    WIDTH_SDM: 50,
    CLR_RF:    54,
    CLR_DDM:   58,
    CLR_SDM:   62,
    NF_RF:     68,
    NF_DDM:    72,
    NF_SDM:    76,
    FREQ_DEV:  84,
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

function decodePacket(pkt) {
    if (!pkt || pkt.length < PACKET_SIZE) return null;
    if (!pkt.slice(0, 4).equals(SYNC_DATA)) return null;

    const subtype   = pkt[12];
    const txFlag    = pkt[13];
    const tx1IsMain = !!(txFlag & 0x40);
    const isMonitor = (subtype === 0x8D);
    
    // Asumsi: Jika flag 0x00 maka MON1, lainnya MON2
    const prefix = isMonitor ? ((txFlag === 0x00) ? 'M1_' : 'M2_') : '';

    const params = {};
    for (const [key, offset] of Object.entries(PARAM_OFFSETS)) {
        const val = readFloat(pkt, offset);
        if (val !== null) params[prefix + key] = parseFloat(val.toFixed(4));
    }

    return {
        tx_main:  tx1IsMain ? 'TX1' : 'TX2',
        tx_stby:  tx1IsMain ? 'TX2' : 'TX1',
        subtype,
        tx_flag:  txFlag,
        is_monitor: isMonitor,
        params,
    };
}

function extractFrames(buf) {
    const results = [];
    let i = 0;
    while (i <= buf.length - PACKET_SIZE) {
        // Skip heartbeat and ACK packets
        if (buf.slice(i, i+4).equals(SYNC_HBEAT) || buf.slice(i, i+4).equals(SYNC_ACK)) {
            i += 4;
            continue;
        }
        if (buf.slice(i, i+4).equals(SYNC_DATA)) {
            const dec = decodePacket(buf.slice(i, i + PACKET_SIZE));
            if (dec) {
                // Hanya simpan data Monitor
                if (dec.is_monitor) {
                    results.push({ pos: i, decoded: dec });
                }
                i += PACKET_SIZE;
                continue;
            }
        }
        i++;
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
                const pos = this._buf.lastIndexOf(SYNC_DATA);
                this._buf = pos > 0 ? this._buf.slice(pos) : Buffer.alloc(0);
            }

            const now = Date.now();
            if (now - this._lastDataTime > PASSIVE_TIMEOUT && this._mode === 'PASSIVE') {
                this._mode = 'ACTIVE';
            }

            const frames = extractFrames(this._buf);
            if (frames.length === 0) {
                return { success: false, error: 'No valid LLZ frames', status: 'Waiting',
                         _mode: this._mode,
                         data: this._lastDecoded ? this._buildOutput(this._lastDecoded, true).data : null };
            }

            // Merge frames params
            if (!this._accumulatedParams) this._accumulatedParams = {};
            for (const f of frames) {
                Object.assign(this._accumulatedParams, f.decoded.params);
            }

            const latest = frames[frames.length - 1];
            this._lastDecoded = latest.decoded;
            // Gunakan gabungan params MON1 & MON2
            this._lastDecoded.params = { ...this._accumulatedParams };
            this._lastDataTime = now;
            if (this._mode === 'ACTIVE') this._mode = 'PASSIVE';
            this._buf = this._buf.slice(latest.pos + PACKET_SIZE);

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

    getPollRequests() { return []; }
    getMode()         { return this._mode; }
    getLastData()     { return this._lastDecoded ? this._lastDecoded.params : {}; }
    reset()           { this._buf = Buffer.alloc(0); }
}

module.exports = IlsLlzThales421Parser;
module.exports.PARAM_OFFSETS = PARAM_OFFSETS;
module.exports.LIMITS        = LIMITS;
module.exports.PARAM_LABELS  = PARAM_LABELS;
module.exports.SYNC_DATA     = SYNC_DATA;
