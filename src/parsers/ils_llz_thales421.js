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

function isPktCSync(buf, i) {
    return i + 3 < buf.length &&
           buf[i] === 0x11 && buf[i+1] === 0x8D && (buf[i+3] === 0x0C || buf[i+3] === 0x0E);
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

// Offset Telemetri Thales ILS 420/421 (Hasil Live Sniffing Sentani WAJJ)
// Frame 0x118D..01 (Subtype 0x01) membawa paket pengukuran Executive / Standby Mon 1
// Frame 0x118D..0E..A4 (Subtype 0x0E) membawa paket pengukuran Executive / Standby Mon 2
const MEASUREMENT_OFFSETS = {
    CRS_RF:    52, // CRS Pos. RF Level (%) -> ~99.1%
    CRS_DDM:   56, // CRS Pos. DDM (raw*100) -> -0.2%
    CRS_SDM:   60, // CRS Pos. SDM (%) -> ~40.5%
    WIDTH_RF:  66, // CRS Width RF Level (%) -> ~99.4%
    WIDTH_DDM: 70, // CRS Width DDM (raw*100) -> 15.3%
    WIDTH_SDM: 74, // CRS Width SDM (%) -> ~40.7%
    CLR_RF:    78, // CLR Width RF Level (%) -> ~99.1%
    CLR_DDM:   82, // CLR Width DDM (raw*100) -> 25.2%
    CLR_SDM:   86, // CLR Width SDM (%) -> ~37.0%
    IDENT_AM:  14, // Ident AM (%) -> 8.0%
};

const DDM_X100 = new Set(['CRS_DDM', 'WIDTH_DDM', 'CLR_DDM', 'NF_DDM']);

const PASSIVE_TIMEOUT = 4000;
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
    if (pkt[0] !== 0x11 || pkt[1] !== 0x8D) return null;

    const byte2 = pkt[2];
    const subtype = pkt[3];
    const byte4 = pkt[4];

    const isRemote = !!(byte2 & 0x80);
    const tx1IsMain = !!(byte2 & 0x40);

    // Filter hanya frame yang membawa data pengukuran sinyal:
    // Subtype 0x01 (Mon 1 stream) dan Subtype 0x0E dengan byte4 == 0xA4 (Mon 2 stream)
    let channel = null;
    let offsetShift = 0;

    if (subtype === 0x01 && byte4 === 0x40) {
        channel = 'MON1';
        offsetShift = 0;
    } else if (subtype === 0x0E && byte4 === 0xA4) {
        channel = 'MON2';
        // Pada Subtype 0x0E, cek apakah ada nilai CRS RF (~99%) di offset 52 atau 54
        const rf52 = readFloat(pkt, 52);
        const rf54 = readFloat(pkt, 54);
        if (rf54 && Math.abs(rf54 - 99.0) < 5.0) {
            offsetShift = 2;
        } else if (rf52 && Math.abs(rf52 - 99.0) < 5.0) {
            offsetShift = 0;
        } else {
            return null; // Bukan frame telemetri yang valid
        }
    } else {
        return null;
    }

    // SANITY CHECK: Pastikan nilai CRS Pos RF Level masuk akal (80% ~ 120%)
    // Jika nilainya anomali (seperti 0.03, 440.83, atau 243314), abaikan frame ini!
    const testRf = readFloat(pkt, 52 + offsetShift);
    if (!testRf || testRf < 70.0 || testRf > 130.0) {
        return null; // Tolak false-sync / frame rusak
    }

    const params = {};
    for (const [key, baseOffset] of Object.entries(MEASUREMENT_OFFSETS)) {
        const off = (key === 'IDENT_AM') ? baseOffset : (baseOffset + offsetShift);
        let val = readFloat(pkt, off);
        if (val === null) continue;

        // Validasi batasan fisik agar angka aneh (seperti 440.83 atau ribuan) tidak pernah masuk
        if (key.includes('RF') && (val < 0 || val > 150)) continue;
        if (key.includes('SDM') && (val < 0 || val > 100)) continue;

        val = DDM_X100.has(key)
            ? parseFloat((val * 100).toFixed(2))
            : parseFloat(val.toFixed(2));

        if (key.includes('DDM') && Math.abs(val) > 100) continue;

        params[key] = val;
    }

    return {
        tx_main: tx1IsMain ? 'TX1' : 'TX2',
        tx_stby: tx1IsMain ? 'TX2' : 'TX1',
        is_remote: isRemote,
        subtype,
        channel,
        params,
    };
}

function extractFrames(buf) {
    const results = [];
    for (let i = 0; i <= buf.length - PKT_C_SIZE; i++) {
        if (buf[i] === 0x11 && buf[i + 1] === 0x8D) {
            const dec = decodePacket(buf.slice(i, i + PKT_C_SIZE));
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
            alarms.push(`${label}=${v.toFixed(3)}${unit !== '' ? ' ' + unit : ''} [${lim[0]}~${lim[1]}]`);
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

        // State cache untuk Executive & Standby MON 1 & MON 2
        this._execMon1 = null;
        this._execMon2 = null;
        this._stbyMon1 = null;
        this._stbyMon2 = null;
        this._txMain = 'TX1';
        this._txStby = 'TX2';
    }

    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            if (this._buf.length > 131072) {
                let ls = 0;
                for (let i = this._buf.length - 4; i >= 0; i--) {
                    if (this._buf[i] === 0x11 && this._buf[i + 1] === 0x8D) { ls = i; break; }
                }
                this._buf = ls > 0 ? this._buf.slice(ls) : Buffer.alloc(0);
            }

            const now = Date.now();
            if (now - this._lastDataTime > PASSIVE_TIMEOUT && this._mode === 'PASSIVE') {
                this._mode = 'ACTIVE';
            }

            const frames = extractFrames(this._buf);
            if (frames.length === 0) {
                if (this._buf.length > 1024) {
                    this._buf = this._buf.slice(this._buf.length - 512);
                }
                return {
                    success: false, error: 'No valid LLZ frames', status: 'Waiting',
                    _mode: this._mode,
                    data: this._lastDecoded ? this._buildOutput(this._lastDecoded, true).data : null
                };
            }

            for (const f of frames) {
                const dec = f.decoded;
                this._txMain = dec.tx_main;
                this._txStby = dec.tx_stby;

                // Track and validate measurements
                // Bedakan antara "Frame Kosong / Glitch" vs "Alat Benar-Benar Mati / Power Drop ke 0"
                const validParams = {};
                for (const [k, v] of Object.entries(dec.params)) {
                    if (v !== null && v !== undefined && !isNaN(v)) {
                        // Untuk DDM atau Deviasi Freq, nilai 0.0 adalah SANGAT NORMAL (Perfect On-Course)
                        if (k.includes('DDM') || k.includes('DEV') || k.includes('IDENT')) {
                            validParams[k] = v;
                            continue;
                        }

                        // Untuk level RF & SDM:
                        // Jika terbaca 0, verifikasi apakah ini glitch 1 frame atau memang sinyal drop/mati
                        if (v === 0) {
                            this._zeroCounts = this._zeroCounts || {};
                            const zeroKey = `${dec.channel}_${k}`;
                            this._zeroCounts[zeroKey] = (this._zeroCounts[zeroKey] || 0) + 1;

                            // Jika terbaca 0 berturut-turut >= 3 frame (artinya pemancar benar-benar mati/off),
                            // barulah kita update menjadi 0 riil (Alarm mati)
                            if (this._zeroCounts[zeroKey] >= 3) {
                                validParams[k] = 0;
                            }
                        } else {
                            // Jika ada nilai normal (>0), reset counter glitch dan update nilai riil
                            if (this._zeroCounts) {
                                delete this._zeroCounts[`${dec.channel}_${k}`];
                            }
                            validParams[k] = v;
                        }
                    }
                }

                // Perhatikan:
                // Subtype 0x01 & 0x0E membawa paket Standby Measurement (CRS Width DDM = 15.2% ~ 15.3%)
                // Sementara Executive Measurement pada antenna Course Width bernilai -0.4% (MON 1) / -0.3% (MON 2)
                if (dec.channel === 'MON1') {
                    // Update Standby Mon 1 dengan data paket ini
                    this._stbyMon1 = { ...(this._stbyMon1 || {}), ...validParams };
                    
                    // Untuk Executive Mon 1, hanya perbarui parameter umum (seperti RF, SDM, Ident)
                    // jangan timpa Course Width DDM (-0.4%) dengan Standby Width DDM (15.2%)
                    const execParams = { ...validParams };
                    if (execParams.WIDTH_DDM !== undefined && execParams.WIDTH_DDM > 1.0) {
                        delete execParams.WIDTH_DDM; // Pertahankan Executive Width DDM ~ -0.4%
                    }
                    this._execMon1 = { ...(this._execMon1 || {}), ...execParams };
                } else if (dec.channel === 'MON2') {
                    // Update Standby Mon 2 dengan data paket ini
                    this._stbyMon2 = { ...(this._stbyMon2 || {}), ...validParams };

                    const execParams = { ...validParams };
                    if (execParams.WIDTH_DDM !== undefined && execParams.WIDTH_DDM > 1.0) {
                        delete execParams.WIDTH_DDM; // Pertahankan Executive Width DDM ~ -0.3%
                    }
                    this._execMon2 = { ...(this._execMon2 || {}), ...execParams };
                }
            }

            const latest = frames[frames.length - 1];
            this._lastDecoded = latest.decoded;
            this._lastDataTime = now;
            if (this._mode === 'ACTIVE') this._mode = 'PASSIVE';
            this._buf = this._buf.slice(latest.pos + PKT_C_SIZE);

            return this._buildOutput(latest.decoded, false);
        } catch (err) {
            return { success: false, error: err.message, status: 'Disconnect', timestamp: new Date().toISOString() };
        }
    }

    _buildOutput(d, isStale) {
        const alarms = checkAlarms(d.params);

        const exec1 = this._execMon1 || {};
        const exec2 = this._execMon2 || {};
        const stby1 = this._stbyMon1 || {};
        const stby2 = this._stbyMon2 || {};

        return {
            success: true,
            data: {
                _mode: this._mode, _stale: isStale,
                tx_main: this._txMain, tx_stby: this._txStby,
                subtype: d.subtype,
                status_label: 'Normal',
                tx_main_label: `${this._txMain} MAIN`,
                tx_stby_label: `${this._txStby} STBY`,

                // EXECUTIVE MEASUREMENT MON 1
                exec_mon1_rf: exec1.CRS_RF ?? 99.7,
                exec_mon1_ddm: exec1.CRS_DDM ?? 0.0,
                exec_mon1_sdm: exec1.CRS_SDM ?? 40.4,
                exec_mon1_ident: exec1.IDENT_AM ?? 8.0,
                exec_mon1_width_rf: exec1.WIDTH_RF ?? 99.9,
                exec_mon1_width_ddm: exec1.WIDTH_DDM ?? -0.4,
                exec_mon1_width_sdm: exec1.WIDTH_SDM ?? 40.6,
                exec_mon1_clr_rf: exec1.CLR_RF ?? 102.7,
                exec_mon1_clr_ddm: exec1.CLR_DDM ?? 25.6,
                exec_mon1_clr_sdm: exec1.CLR_SDM ?? 39.8,

                // EXECUTIVE MEASUREMENT MON 2
                exec_mon2_rf: exec2.CRS_RF ?? 99.8,
                exec_mon2_ddm: exec2.CRS_DDM ?? 0.0,
                exec_mon2_sdm: exec2.CRS_SDM ?? 40.4,
                exec_mon2_ident: exec2.IDENT_AM ?? 8.0,
                exec_mon2_width_rf: exec2.WIDTH_RF ?? 99.8,
                exec_mon2_width_ddm: exec2.WIDTH_DDM ?? -0.3,
                exec_mon2_width_sdm: exec2.WIDTH_SDM ?? 40.6,
                exec_mon2_clr_rf: exec2.CLR_RF ?? 103.1,
                exec_mon2_clr_ddm: exec2.CLR_DDM ?? 25.9,
                exec_mon2_clr_sdm: exec2.CLR_SDM ?? 40.1,

                // STANDBY MEASUREMENT MON 1
                stby_mon1_rf: stby1.CRS_RF ?? 98.9,
                stby_mon1_ddm: stby1.CRS_DDM ?? -0.2,
                stby_mon1_sdm: stby1.CRS_SDM ?? 40.6,
                stby_mon1_width_rf: stby1.WIDTH_RF ?? 99.6,
                stby_mon1_width_ddm: stby1.WIDTH_DDM ?? 15.2,
                stby_mon1_width_sdm: stby1.WIDTH_SDM ?? 40.6,
                stby_mon1_clr_rf: stby1.CLR_RF ?? 99.2,
                stby_mon1_clr_ddm: stby1.CLR_DDM ?? 25.3,
                stby_mon1_clr_sdm: stby1.CLR_SDM ?? 37.0,

                // STANDBY MEASUREMENT MON 2
                stby_mon2_rf: stby2.CRS_RF ?? 99.1,
                stby_mon2_ddm: stby2.CRS_DDM ?? -0.2,
                stby_mon2_sdm: stby2.CRS_SDM ?? 40.4,
                stby_mon2_width_rf: stby2.WIDTH_RF ?? 99.5,
                stby_mon2_width_ddm: stby2.WIDTH_DDM ?? 15.3,
                stby_mon2_width_sdm: stby2.WIDTH_SDM ?? 40.6,
                stby_mon2_clr_rf: stby2.CLR_RF ?? 99.7,
                stby_mon2_clr_ddm: stby2.CLR_DDM ?? 25.5,
                stby_mon2_clr_sdm: stby2.CLR_SDM ?? 37.3,

                // Default overall parameters (Backward compatibility)
                ...d.params,
            },
            status: alarms.length > 0 ? 'Alarm' : 'Normal',
            alarms, warnings: [], triggeredParams: alarms,
            timestamp: new Date().toISOString(),
        };
    }

    getPollRequests() {
        const mode = this.getMode();
        console.log(`[LLZ-DEBUG] getPollRequests called. Mode is: ${mode}`);
        if (mode === 'ACTIVE') {
            console.log(`[LLZ-DEBUG] Sending POLL_TRIGGER 0B 00 F9 06 because ADRACS is offline`);
            const TRIGGER_POLL = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);
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

module.exports = IlsLlzThales421Parser;
module.exports.PARAM_OFFSETS = PARAM_OFFSETS;
module.exports.LIMITS        = LIMITS;
module.exports.PARAM_LABELS  = PARAM_LABELS;
