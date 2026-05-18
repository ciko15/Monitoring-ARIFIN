const BaseParser = require('./base');

/**
 * PM5560 Modbus Parser — AirNav WAJJ
 * Schneider Electric PowerLogic PM5560
 *
 * Response format aktual dari meter (bukan MBAP murni):
 *   [UNIT=01][FC=03][BC=04][FLOAT 4 bytes BE][TID_HI=00][TID_LO][00][00][00][07]
 *   = 13 bytes per parameter
 *
 * TID_LO di byte[8] dipakai untuk mapping ke parameter (tidak bergantung urutan).
 * Request dikirim identik dengan pm_monitor.py: MBAP header + addr langsung (tanpa -1).
 */

const PARAMS = [
    { key: 'VL12', addr: 3019, tid: 1  },
    { key: 'VL23', addr: 3021, tid: 2  },
    { key: 'VL31', addr: 3023, tid: 3  },
    { key: 'VL1N', addr: 3027, tid: 4  },
    { key: 'VL2N', addr: 3029, tid: 5  },
    { key: 'VL3N', addr: 3031, tid: 6  },
    { key: 'IL1',  addr: 2999, tid: 7  },
    { key: 'IL2',  addr: 3001, tid: 8  },
    { key: 'IL3',  addr: 3003, tid: 9  },
    { key: 'KW',   addr: 3059, tid: 10 },
    { key: 'KVAR', addr: 3067, tid: 11 },
    { key: 'KVA',  addr: 3075, tid: 12 },
    { key: 'PF',   addr: 3083, tid: 13 },
    { key: 'HZ',   addr: 3109, tid: 14 },
    { key: 'KWH',  addr: 3203, tid: 15 },
];

// TID → key lookup
const TID_MAP = {};
PARAMS.forEach(p => { TID_MAP[p.tid] = p.key; });

const SANITY = {
    VL1N: [100, 300], VL2N: [100, 300], VL3N: [100, 300],
    VL12: [150, 500], VL23: [150, 500], VL31: [150, 500],
    IL1: [-3000, 3000], IL2: [-3000, 3000], IL3: [-3000, 3000],
    KW: [-1e6, 1e6], KVAR: [-1e6, 1e6], KVA: [0, 1e6],
    PF: [-1.5, 1.5], HZ: [45, 65], KWH: [0, 1e9],
};

const POLL_INTERVAL  = 60000; // 60s — sama dengan REFRESH_SEC di pm_monitor.py
const POLL_REQ_DELAY = 200;
const DEFAULT_SLAVE  = 1;

// Build request identik dengan pm_monitor.py
function buildFC03(tid, slave, addr) {
    return Buffer.from([
        (tid >> 8) & 0xFF, tid & 0xFF,
        0x00, 0x00,
        0x00, 0x06,
        slave & 0xFF,
        0x03,
        (addr >> 8) & 0xFF, addr & 0xFF,
        0x00, 0x02,
    ]);
}

function buildPollRequests(slave = DEFAULT_SLAVE) {
    return PARAMS.map(p => ({
        key: p.key, tid: p.tid,
        bytes: buildFC03(p.tid, slave, p.addr),
    }));
}

const POLL_REQUESTS_DEFAULT = buildPollRequests(DEFAULT_SLAVE);

function sanity(key, val) {
    if (!isFinite(val)) return null;
    const [lo, hi] = SANITY[key] || [-Infinity, Infinity];
    return lo < val && val < hi ? val : null;
}

function checkAlarms(d) {
    const a = [];
    const fn = (v, dec) => (v != null && typeof v === 'number') ? v.toFixed(dec) : '—';
    
    if (d.VL1N != null && typeof d.VL1N === 'number' && !(200 <= d.VL1N && d.VL1N <= 240)) a.push(`Van=${d.VL1N.toFixed(1)}V`);
    if (d.VL2N != null && typeof d.VL2N === 'number' && !(200 <= d.VL2N && d.VL2N <= 240)) a.push(`Vbn=${d.VL2N.toFixed(1)}V`);
    if (d.VL3N != null && typeof d.VL3N === 'number' && !(200 <= d.VL3N && d.VL3N <= 240)) a.push(`Vcn=${d.VL3N.toFixed(1)}V`);
    if (d.HZ   != null && typeof d.HZ   === 'number' && !(49.5 <= d.HZ && d.HZ <= 50.5))  a.push(`Hz=${d.HZ.toFixed(2)}`);
    if (d.PF   != null && typeof d.PF   === 'number' && Math.abs(d.PF) < 0.8)              a.push(`PF=${d.PF.toFixed(3)}`);
    return a;
}

class Pm5560ModbusParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf  = Buffer.alloc(0);
        this._last = {};          // key → nilai valid terakhir
        this._mode = 'ACTIVE';
        this._slave = opts.slave || DEFAULT_SLAVE;
        this._pollRequests = buildPollRequests(this._slave);
    }

    reset() {
        this._buf = Buffer.alloc(0);
    }

    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            if (this._buf.length > 65536) this._buf = this._buf.slice(-4096);

            // Scan buffer: cari frame [01][03][04][4-byte float][00][TID][00][00][00][07]
            // Minimal 13 bytes per frame, tapi kita hanya butuh 9 bytes untuk decode
            let i = 0;
            while (i <= this._buf.length - 9) {
                const unit = this._buf[i];
                const fc   = this._buf[i + 1];
                const bc   = this._buf[i + 2];

                if (unit !== 0x01 || fc !== 0x03 || bc !== 0x04) {
                    i++;
                    continue;
                }

                // Ambil float dan TID
                const val = this._buf.readFloatBE(i + 3);
                const tid = (this._buf[i + 7] << 8) | this._buf[i + 8]; // bytes 7-8 = TID
                const key = TID_MAP[tid];

                if (key) {
                    const v = sanity(key, val);
                    if (v !== null) this._last[key] = v;
                }

                // Maju 13 bytes (konsumsi 1 frame penuh)
                i += 13;
            }

            // Buang buffer yang sudah diproses
            this._buf = this._buf.slice(i);

            if (Object.keys(this._last).length === 0) {
                return { success: false, error: 'Menunggu data', status: 'Waiting', _mode: this._mode };
            }

            const d = this._last;
            const vlnV = [d.VL1N, d.VL2N, d.VL3N].filter(v => v != null);
            const vllV = [d.VL12, d.VL23, d.VL31].filter(v => v != null);
            const VLN_avg = vlnV.length ? vlnV.reduce((a, b) => a + b) / vlnV.length : null;
            const VLL_avg = vllV.length ? vllV.reduce((a, b) => a + b) / vllV.length : null;

            const alarms = checkAlarms(d);

            return {
                success: true,
                status: alarms.length ? 'Alarm' : 'Normal',
                data: {
                    _mode: this._mode,
                    VL1N: d.VL1N  != null ? +d.VL1N.toFixed(1)  : null,
                    VL2N: d.VL2N  != null ? +d.VL2N.toFixed(1)  : null,
                    VL3N: d.VL3N  != null ? +d.VL3N.toFixed(1)  : null,
                    VL12: d.VL12  != null ? +d.VL12.toFixed(1)  : null,
                    VL23: d.VL23  != null ? +d.VL23.toFixed(1)  : null,
                    VL31: d.VL31  != null ? +d.VL31.toFixed(1)  : null,
                    VLN_avg: VLN_avg != null ? +VLN_avg.toFixed(1) : null,
                    VLL_avg: VLL_avg != null ? +VLL_avg.toFixed(1) : null,
                    IL1:  d.IL1   != null ? +d.IL1.toFixed(2)   : null,
                    IL2:  d.IL2   != null ? +d.IL2.toFixed(2)   : null,
                    IL3:  d.IL3   != null ? +d.IL3.toFixed(2)   : null,
                    KW:   d.KW    != null ? +d.KW.toFixed(3)    : null,
                    KVAR: d.KVAR  != null ? +d.KVAR.toFixed(3)  : null,
                    KVA:  d.KVA   != null ? +d.KVA.toFixed(3)   : null,
                    PF:   d.PF    != null ? +d.PF.toFixed(3)    : null,
                    HZ:   d.HZ    != null ? +d.HZ.toFixed(2)    : null,
                    KWH:  d.KWH   != null ? +d.KWH.toFixed(1)   : null,
                    alarmDetail: alarms,
                },
                alarms, warnings: [], triggeredParams: alarms,
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            console.error('[PM5560] Parse error:', err.message);
            return { success: false, error: err.message, status: 'Error' };
        }
    }

    getPollRequests() { return this._pollRequests; }
    getMode()         { return this._mode; }
}

module.exports = Pm5560ModbusParser;
module.exports.POLL_REQUESTS     = POLL_REQUESTS_DEFAULT;
module.exports.POLL_INTERVAL     = POLL_INTERVAL;
module.exports.POLL_REQ_DELAY    = POLL_REQ_DELAY;
module.exports.PARAMS            = PARAMS;
module.exports.buildPollRequests = buildPollRequests;
