const BaseParser = require('./base');

/**
 * DVOR Maru 220 Parser v2 — ported from dvor_gui.py v2.0
 * (AirNav Indonesia · Sentani Airport WAJJ)
 *
 * Protocol : SOH+STX+TAG+data+ETX framed, TCP via Moxa NPort
 * Sections : N1 (MON1), N2 (MON2), G1 (TX1), G2 (TX2), LC (LCU)
 * Mode     : PASSIVE (streaming) + ACTIVE (polling fallback)
 *
 * ACTIVE polling requests sent when no data for >30s:
 *   LC query  : \x01\x02LC|SQ|*\x03EAAD
 *   N1 query  : \x01\x02N1|SQ|*\x034492
 *   N2 query  : \x01\x02N2|SQ|*\x038A72
 *   G1 query  : \x01\x02G1|SQ|*\x036F5E
 *   G2 query  : \x01\x02G2|SQ|*\x03A1BE
 */

const SOH = 0x01;
const STX = 0x02;
const ETX = 0x03;
const TAG_MAP = { 'LC':'LC', 'N1':'N1', 'N2':'N2', 'G1':'G1', 'G2':'G2' };

// Active polling request bytes
const POLL_REQUESTS = [
    { bytes: Buffer.from([0x01,0x02,0x4C,0x43,0x7C,0x53,0x51,0x7C,0x2A,0x03,0x45,0x41,0x41,0x44]), tag: 'LC'  },
    { bytes: Buffer.from([0x01,0x02,0x4E,0x31,0x7C,0x53,0x51,0x7C,0x2A,0x03,0x34,0x34,0x39,0x32]), tag: 'N1'  },
    { bytes: Buffer.from([0x01,0x02,0x4E,0x32,0x7C,0x53,0x51,0x7C,0x2A,0x03,0x38,0x41,0x37,0x32]), tag: 'N2'  },
    { bytes: Buffer.from([0x01,0x02,0x47,0x31,0x7C,0x53,0x51,0x7C,0x2A,0x03,0x36,0x46,0x35,0x45]), tag: 'G1'  },
    { bytes: Buffer.from([0x01,0x02,0x47,0x32,0x7C,0x53,0x51,0x7C,0x2A,0x03,0x41,0x31,0x42,0x45]), tag: 'G2'  },
];

const PASSIVE_TIMEOUT  = 30000; // ms — switch ke ACTIVE jika tidak ada data
const POLL_INTERVAL    = 2000;  // ms — interval polling ACTIVE
const POLL_REQ_DELAY   = 150;   // ms — jeda antar request

const LIMITS = {
    carrier_power: [80.0,  120.0],
    rf_input:      [-25.0, 0.0 ],
    azimuth:       [116.2, 118.2],
    fm_index:      [15.0,  17.0 ],
    am_30hz:       [28.0,  32.0 ],
    am_9960hz:     [25.0,  32.5 ],
    am_1020hz:     [6.0,   8.0  ],
};

function extractSections(buf) {
    const results = {};
    let i = 0;
    while (i < buf.length - 3) {
        if (buf[i] === SOH && buf[i+1] === STX) {
            const tagStr = buf.slice(i+2, i+4).toString('ascii');
            const tag = TAG_MAP[tagStr];
            if (tag) {
                const etxPos = buf.indexOf(ETX, i+4);
                if (etxPos > i+4) {
                    const seg = buf.slice(i+4, etxPos).toString('ascii');
                    const params = {};
                    const regex = /([A-Z]\d+)=([^|\x03\x01]+)/g;
                    let m;
                    while ((m = regex.exec(seg)) !== null) {
                        params[m[1]] = m[2].trim();
                    }
                    if (Object.keys(params).length > 0) results[tag] = params;
                    i = etxPos + 5;
                    continue;
                }
            }
        }
        i++;
    }
    return results;
}

function fi(p, k, div, dec = 1) {
    try {
        const v = parseInt(p[k], 10);
        if (isNaN(v)) return null;
        return Math.round((v / div) * Math.pow(10, dec)) / Math.pow(10, dec);
    } catch(e) { return null; }
}

function fs(p, k) { return p[k] !== undefined ? p[k] : null; }

function decodeAll(sections) {
    const r = {};

    // MON1 (N1)
    const n1 = sections['N1'] || {};
    if (Object.keys(n1).length > 0) {
        const txSel = fs(n1, 'S20');
        r.tx_active = (txSel !== null && /^-?\d+$/.test(txSel.trim()))
            ? parseInt(txSel, 10) : null;
        r.mon1 = {
            carrier_power: fi(n1,'S1',  10),
            rf_input:      fi(n1,'S2',  10),
            azimuth:       fi(n1,'S3',  10),
            carrier_freq:  fi(n1,'S4',  10000, 4),
            usb_freq:      fi(n1,'S5',  10000, 4),
            lsb_freq:      fi(n1,'S6',  10000, 4),
            am_30hz:       fi(n1,'S10', 10),
            am_9960hz:     fi(n1,'S11', 10),
            am_1020hz:     fi(n1,'S12', 10),
            fm_index:      fi(n1,'S13', 10),
            ident:         fs(n1,'S14'),
            tsg_30hz:      fi(n1,'S15', 10),
            tsg_azimuth:   fi(n1,'S18', 10),
        };
    }

    // MON2 (N2)
    const n2 = sections['N2'] || {};
    if (Object.keys(n2).length > 0) {
        r.mon2 = {
            carrier_power: fi(n2,'S1',  10),
            rf_input:      fi(n2,'S2',  10),
            azimuth:       fi(n2,'S3',  10),
            carrier_freq:  fi(n2,'S4',  10000, 4),
            usb_freq:      fi(n2,'S5',  10000, 4),
            lsb_freq:      fi(n2,'S6',  10000, 4),
            am_30hz:       fi(n2,'S10', 10),
            am_9960hz:     fi(n2,'S11', 10),
            am_1020hz:     fi(n2,'S12', 10),
            fm_index:      fi(n2,'S13', 10),
            ident:         fs(n2,'S14'),
        };
    }

    // TX1 (G1) & TX2 (G2)
    for (const [tagKey, resKey] of [['G1','tx1'],['G2','tx2']]) {
        const g = sections[tagKey] || {};
        if (Object.keys(g).length > 0) {
            r[resKey] = {
                carrier_power: fi(g,'V2',  10),
                usb_sin:       fi(g,'V3',  100),
                usb_cos:       fi(g,'V4',  100),
                lsb_sin:       fi(g,'V5',  100),
                lsb_cos:       fi(g,'V6',  100),
                az_offset:     fi(g,'V7',  10),
                am_30hz:       fi(g,'V8',  10),
                am_1020hz:     fi(g,'V9',  10),
                phase_offset:  fi(g,'V28', 10),
                cpa_temp:      fi(g,'S6',  10),
                msg_temp:      fi(g,'S1',  10),
                ident:         fs(g,'V15'),
            };
        }
    }

    // LCU (LC) — v2 mapping: S25=dc_28v, S26=dc_5v, S27=dc_7v, S28=dc_15v, S47=ac_28v
    const lc = sections['LC'] || {};
    if (Object.keys(lc).length > 0) {
        r.lcu = {
            dc_5v:     fi(lc,'S26', 10),
            dc_7v:     fi(lc,'S27', 10),
            dc_15v:    fi(lc,'S28', 10),
            dc_28v:    fi(lc,'S25', 10),
            ac_28v:    fi(lc,'S47', 10),
            msg1_comm: fs(lc,'B9'),
            msg2_comm: fs(lc,'B10'),
            mon1_comm: fs(lc,'B11'),
            mon2_comm: fs(lc,'B12'),
            battery1:  fs(lc,'B20'),
            battery2:  fs(lc,'B21'),
            acdc1:     fs(lc,'B22'),
            acdc2:     fs(lc,'B23'),
        };
    }

    return r;
}

function checkAlarms(data) {
    const alarms = [];
    for (const monKey of ['mon1', 'mon2']) {
        const mon = data[monKey] || {};
        for (const [field, [lo, hi]] of Object.entries(LIMITS)) {
            const v = mon[field];
            if (v !== null && v !== undefined && (v < lo || v > hi)) {
                alarms.push(`${monKey.toUpperCase()} ${field}=${v} out of range [${lo}-${hi}]`);
            }
        }
    }
    return alarms;
}

class DvorMaru220Parser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        // Active polling state
        this._lastDataTime = Date.now();
        this._mode = 'PASSIVE'; // 'PASSIVE' | 'ACTIVE'
        this._passiveBuf = Buffer.alloc(0);
    }

    /**
     * Main parse entry — called by NetworkListener on each TCP data chunk.
     * Handles both PASSIVE (streaming) and ACTIVE (polling) modes.
     */
    parse(rawData) {
        try {
            const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

            // Update passive buffer
            this._passiveBuf = Buffer.concat([this._passiveBuf, buf]);
            if (this._passiveBuf.length > 65536) {
                this._passiveBuf = this._passiveBuf.slice(-32768);
            }

            // Check mode: switch to ACTIVE if no valid data for PASSIVE_TIMEOUT
            const now = Date.now();
            if (now - this._lastDataTime > PASSIVE_TIMEOUT && this._mode === 'PASSIVE') {
                this._mode = 'ACTIVE';
                console.log('[DVOR Maru 220] No data for 30s — switching to ACTIVE polling mode');
            }

            // Try to parse current buffer
            const sections = extractSections(this._passiveBuf);

            if (Object.keys(sections).length < 2) {
                // Not enough sections yet
                return { success: false, error: 'Waiting for complete packet', status: 'Waiting', _mode: this._mode };
            }

            // Good data — update timestamp and mode
            this._lastDataTime = now;
            if (this._mode === 'ACTIVE' && Object.keys(sections).length >= 4) {
                this._mode = 'PASSIVE';
                console.log('[DVOR Maru 220] MARU active — switching back to PASSIVE mode');
            }

            // Trim buffer past last ETX
            const lastEtx = this._passiveBuf.lastIndexOf(ETX);
            if (lastEtx >= 0) this._passiveBuf = this._passiveBuf.slice(lastEtx + 5);

            const decoded = decodeAll(sections);
            const alarms  = checkAlarms(decoded);

            // Flatten for dashboard
            const flat = { _mode: this._mode };
            if (decoded.mon1) {
                Object.entries(decoded.mon1).forEach(([k,v]) => { flat[`mon1_${k}`] = v; });
            }
            if (decoded.mon2) {
                Object.entries(decoded.mon2).forEach(([k,v]) => { flat[`mon2_${k}`] = v; });
            }
            if (decoded.tx1) {
                Object.entries(decoded.tx1).forEach(([k,v]) => { flat[`tx1_${k}`] = v; });
            }
            if (decoded.tx2) {
                Object.entries(decoded.tx2).forEach(([k,v]) => { flat[`tx2_${k}`] = v; });
            }
            if (decoded.lcu) {
                Object.entries(decoded.lcu).forEach(([k,v]) => { flat[`lcu_${k}`] = v; });
            }
            flat.tx_active = decoded.tx_active;

            this._lastData = flat; // simpan untuk getLastData()
            return {
                success: true,
                data: flat,
                status: alarms.length > 0 ? 'Alarm' : 'Normal',
                alarms,
                warnings: [],
                triggeredParams: alarms,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error(`[DVOR Maru 220] Parse error: ${error.message}`);
            return { success: false, error: error.message, status: 'Error', timestamp: new Date().toISOString() };
        }
    }

    /**
     * Returns polling request bytes for ACTIVE mode.
     * Called by NetworkListener when mode is ACTIVE.
     */
    getPollRequests() { return POLL_REQUESTS; }
    getMode()         { return this._mode; }
    getLastData()     { return this._lastData || {}; }
}

module.exports = DvorMaru220Parser;
module.exports.POLL_REQUESTS   = POLL_REQUESTS;
module.exports.PASSIVE_TIMEOUT = PASSIVE_TIMEOUT;
module.exports.POLL_INTERVAL   = POLL_INTERVAL;
module.exports.POLL_REQ_DELAY  = POLL_REQ_DELAY;
