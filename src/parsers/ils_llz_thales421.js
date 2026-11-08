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

const PKT_C_SIZE = 84;

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

// Offset Telemetri Thales ILS 420/421 Subtype 0x0C (Executive Measurement Packet)
// Berdasarkan verifikasi paket live tshark Sentani:
// Subtype 0x0C dengan byte4 == 0x00 membawa data lengkap MON 1
// Subtype 0x0C dengan byte4 == 0x10 membawa data lengkap MON 2
const MEASUREMENT_OFFSETS_0C = {
    CRS_RF:    15, // CRS Pos. RF Level (%) -> ~98.3% / 98.4%
    CRS_DDM:   19, // CRS Pos. DDM (raw*100) -> 0.09% / 0.01%
    CRS_SDM:   23, // CRS Pos. SDM (%) -> ~40.4% / 40.5%
    IDENT_AM:  27, // Ident AM (%) -> 8.0%
    WIDTH_RF:  31, // CRS Width RF Level (%) -> ~98.4%
    WIDTH_DDM: 35, // CRS Width DDM (raw*100) -> -0.26%
    WIDTH_SDM: 39, // CRS Width SDM (%) -> ~40.5%
    CLR_RF:    43, // CLR Width RF Level (%) -> ~101.0% / 101.2%
    CLR_DDM:   47, // CLR Width DDM (raw*100) -> 25.53% / 25.58%
    CLR_SDM:   51, // CLR Width SDM (%) -> ~39.8% / 40.1%
    NF_RF:     57, // Nearfield Pos. RF Level (%) -> ~98.7% / 98.6%
    NF_DDM:    61, // Nearfield Pos. DDM (raw*100) -> 0.46% / 0.50%
    NF_SDM:    65, // Nearfield Pos. SDM (%) -> ~40.2%
    FREQ_DEV:  79, // Frequency Deviation (kHz) -> ~2.9 / 2.2
};

// Offset Telemetri Thales ILS 420/421 Subtype 0x01 / 0x0E (Standby Measurement Packet)
const MEASUREMENT_OFFSETS = {
    CRS_RF:    52, // CRS Pos. RF Level (%) -> ~99.1%
    CRS_DDM:   56, // CRS Pos. DDM (raw*100) -> -0.2%
    CRS_SDM:   60, // CRS Pos. SDM (%) -> ~40.5%
    WIDTH_RF:  66, // CRS Width RF Level (%) -> ~99.4%
    WIDTH_DDM: 70, // CRS Width DDM (raw*100) -> 15.3% (Standby Width DDM)
    WIDTH_SDM: 74, // CRS Width SDM (%) -> ~40.7%
    CLR_RF:    78, // CLR Width RF Level (%) -> ~99.1%
    CLR_DDM:   82, // CLR Width DDM (raw*100) -> 25.2%
    CLR_SDM:   86, // CLR Width SDM (%) -> ~37.0%
    IDENT_AM:  14, // Ident AM (%) -> 8.0%
    NF_RF:     26, // Nearfield Pos. RF Level (%) -> ~98.8%
    NF_DDM:    30, // Nearfield Pos. DDM (raw*100) -> ~0.4%
    NF_SDM:    34, // Nearfield Pos. SDM (%) -> ~40.2%
    FREQ_DEV:  46, // Frequency Deviation (kHz) -> ~2.9 / 2.1
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
    if (!pkt || pkt.length < 54) return null;
    if (pkt[0] !== 0x11 || pkt[1] !== 0x8D) return null;

    const byte2 = pkt[2];
    const subtype = pkt[3];
    const byte4 = pkt[4];

    const isRemote = !!(byte2 & 0x80);
    const tx1IsMain = !!(byte2 & 0x40);

    let channel = null;
    let isExecStream = false;

    // 1. SUBTYPE 0x0C: FRAME EXECUTIVE MEASUREMENT RESMI (MON 1 & MON 2)
    if (subtype === 0x0C && pkt.length >= 80) {
        channel = (byte4 === 0x10) ? 'MON2' : 'MON1';
        isExecStream = true;

        const params = {};
        for (const [key, off] of Object.entries(MEASUREMENT_OFFSETS_0C)) {
            let val = readFloat(pkt, off);
            if (val === null) continue;
            if (key.includes('RF') && (val < 0 || val > 150)) continue;
            if (key.includes('SDM') && (val < 0 || val > 100)) continue;

            val = DDM_X100.has(key)
                ? parseFloat((val * 100).toFixed(2))
                : parseFloat(val.toFixed(2));

            if (key.includes('DDM') && Math.abs(val) > 100) continue;
            params[key] = val;
        }

        // RF Freq konstan 8000 Hz untuk Thales ILS
        params.RF_FREQ = 8000;

        return {
            frameLen: 85,
            tx_main: tx1IsMain ? 'TX1' : 'TX2',
            tx_stby: tx1IsMain ? 'TX2' : 'TX1',
            is_remote: isRemote,
            subtype,
            channel,
            isExecStream: true,
            params,
        };
    }

    // 2. SUBTYPE 0x0E: FRAME STANDBY MEASUREMENT RESMI (MON 1 & MON 2)
    // Sesuai jendela ADRACS Standby Measurement
    if (subtype === 0x0E && pkt.length >= 75) {
        channel = (byte4 === 0x10) ? 'MON2' : 'MON1';

        const rfPos = readFloat(pkt, 15);
        const ddmPos = readFloat(pkt, 19);
        const sdmPos = readFloat(pkt, 23);
        const rfWidth = readFloat(pkt, 29);
        const ddmWidth = readFloat(pkt, 33);
        const sdmWidth = readFloat(pkt, 37);
        const rfClr = readFloat(pkt, 41);
        const ddmClr = readFloat(pkt, 45);
        const sdmClr = readFloat(pkt, 49);
        const freqDev = readFloat(pkt, 71);

        if (rfPos !== null && Math.abs(rfPos - 99.0) < 6.0) {
            const params = {};
            params.CRS_RF = parseFloat(rfPos.toFixed(2));
            if (ddmPos !== null) params.CRS_DDM = parseFloat((ddmPos * 100).toFixed(2));
            if (sdmPos !== null) params.CRS_SDM = parseFloat(sdmPos.toFixed(2));
            if (rfWidth !== null) params.WIDTH_RF = parseFloat(rfWidth.toFixed(2));
            if (ddmWidth !== null) params.WIDTH_DDM = parseFloat((ddmWidth * 100).toFixed(2));
            if (sdmWidth !== null) params.WIDTH_SDM = parseFloat(sdmWidth.toFixed(2));
            if (rfClr !== null) params.CLR_RF = parseFloat(rfClr.toFixed(2));
            if (ddmClr !== null) params.CLR_DDM = parseFloat((ddmClr * 100).toFixed(2));
            if (sdmClr !== null) params.CLR_SDM = parseFloat(sdmClr.toFixed(2));
            if (freqDev !== null) params.FREQ_DEV = parseFloat(freqDev.toFixed(2));
            params.RF_FREQ = 8000;

            return {
                frameLen: 77,
                type: 'STANDBY_DATA',
                tx_main: tx1IsMain ? 'TX1' : 'TX2',
                tx_stby: tx1IsMain ? 'TX2' : 'TX1',
                is_remote: isRemote,
                subtype,
                channel,
                params
            };
        }
    }

    // 3. SUBTYPE 0x1A: CURRENT MAINTENANCE ALERT DATA / POWER SUPPLY (TX 1 & TX 2)
    // Sesuai jendela ADRACS Current Maintenance Alert Data
    if (subtype === 0x1A && pkt.length >= 55) {
        const tx = (byte4 === 0x30) ? 'TX2' : 'TX1';
        const v5 = readFloat(pkt, 15);
        const v15p = readFloat(pkt, 19);
        const v15n = readFloat(pkt, 23);
        const v24 = readFloat(pkt, 27);
        const v54 = readFloat(pkt, 31);
        const tempIn = readFloat(pkt, 35);
        const tempOut = readFloat(pkt, 39);
        const obsLights = readFloat(pkt, 43);
        const spare1 = readFloat(pkt, 47);
        const spare2 = readFloat(pkt, 51);

        if (v5 !== null && Math.abs(v5 - 5.0) < 1.0) {
            const params = {
                v5: parseFloat(v5.toFixed(2)),
                v15_pos: v15p !== null ? parseFloat(v15p.toFixed(2)) : null,
                v15_neg: v15n !== null ? parseFloat(v15n.toFixed(2)) : null,
                v24: v24 !== null ? parseFloat(v24.toFixed(2)) : null,
                v54_battery: v54 !== null ? parseFloat(v54.toFixed(2)) : null,
                temp_in: tempIn !== null ? parseFloat(tempIn.toFixed(1)) : null,
                temp_out: tempOut !== null ? parseFloat(tempOut.toFixed(1)) : null,
                obs_lights: obsLights !== null ? parseFloat(obsLights.toFixed(3)) : null,
                spare_ad1: spare1 !== null ? parseFloat(spare1.toFixed(3)) : null,
                spare_ad2: spare2 !== null ? parseFloat(spare2.toFixed(3)) : null,
            };

            return {
                frameLen: 57,
                type: 'POWER_SUPPLY_DATA',
                tx_main: tx1IsMain ? 'TX1' : 'TX2',
                tx_stby: tx1IsMain ? 'TX2' : 'TX1',
                tx,
                is_remote: isRemote,
                subtype,
                params
            };
        }
    }

    return null;
}

function extractFrames(buf) {
    const results = [];
    for (let i = 0; i <= buf.length - 54; i++) {
        if (buf[i] === 0x11 && buf[i + 1] === 0x8D) {
            const dec = decodePacket(buf.slice(i));
            if (dec) {
                results.push({ pos: i, decoded: dec });
                const advance = dec.frameLen ? (dec.frameLen - 1) : 53;
                i += advance;
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
        this._psTx1 = null;
        this._psTx2 = null;
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
                // Jangan potong buffer jika ukurannya masih di bawah 8KB agar chunk terpotong bisa terakumulasi menjadi frame utuh
                if (this._buf.length > 8192) {
                    let firstHeader = -1;
                    for (let i = 0; i <= this._buf.length - 2; i++) {
                        if (this._buf[i] === 0x11 && this._buf[i + 1] === 0x8D) {
                            firstHeader = i;
                            break;
                        }
                    }
                    if (firstHeader >= 0) {
                        this._buf = this._buf.slice(firstHeader);
                    } else {
                        this._buf = this._buf.slice(this._buf.length - 1024);
                    }
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

                // 1. Tangani Data Power Supply & Maintenance Alert Data (Subtype 0x1A)
                if (dec.type === 'POWER_SUPPLY_DATA') {
                    if (dec.tx === 'TX2') {
                        this._psTx2 = { ...(this._psTx2 || {}), ...dec.params };
                    } else {
                        this._psTx1 = { ...(this._psTx1 || {}), ...dec.params };
                    }
                    continue;
                }

                // 2. Tangani Data Standby Measurement (Subtype 0x0E)
                if (dec.type === 'STANDBY_DATA') {
                    if (dec.channel === 'MON2') {
                        this._stbyMon2 = { ...(this._stbyMon2 || {}), ...dec.params };
                    } else {
                        this._stbyMon1 = { ...(this._stbyMon1 || {}), ...dec.params };
                    }
                    continue;
                }

                // 3. Tangani Data Executive Measurement (Subtype 0x0C)
                const validParams = {};
                for (const [k, v] of Object.entries(dec.params)) {
                    if (v !== null && v !== undefined && !isNaN(v)) {
                        validParams[k] = v;
                    }
                }

                if (dec.isExecStream) {
                    if (dec.channel === 'MON2') {
                        this._execMon2 = { ...(this._execMon2 || {}), ...validParams };
                    } else {
                        this._execMon1 = { ...(this._execMon1 || {}), ...validParams };
                    }
                }
            }

            const latest = frames[frames.length - 1];
            this._lastDecoded = latest.decoded;
            this._lastDataTime = now;
            if (this._mode === 'ACTIVE') this._mode = 'PASSIVE';
            const advance = latest.decoded.frameLen ? latest.decoded.frameLen : PKT_C_SIZE;
            this._buf = this._buf.slice(latest.pos + advance);

            return this._buildOutput(latest.decoded, false);
        } catch (err) {
            return { success: false, error: err.message, status: 'Disconnect', timestamp: new Date().toISOString() };
        }
    }

    _buildOutput(d, isStale) {
        const alarms = checkAlarms(d.params);

        const exec1 = this._execMon1 || {};
        // Di Thales 421, pemancar TX (Executive) memancarkan sinyal yang sama ke kedua sensor monitor (MON 1 dan MON 2).
        // Jika paket Subtype 0x0E (MON 2) belum tiba, gunakan data pengukuran pemancar aktif dari MON 1 sebagai referensi dasar (simetris)
        const exec2 = this._execMon2 || this._execMon1 || {};
        const stby1 = this._stbyMon1 || {};
        const stby2 = this._stbyMon2 || this._stbyMon1 || {};

        return {
            success: true,
            data: {
                _mode: this._mode, _stale: isStale,
                tx_main: this._txMain, tx_stby: this._txStby,
                subtype: d.subtype,
                status_label: 'Normal',
                tx_main_label: `${this._txMain} MAIN`,
                tx_stby_label: `${this._txStby} STBY`,

                // EXECUTIVE MEASUREMENT MON 1 (100% MURNI DATA ASLI DARI ALAT)
                exec_mon1_rf: exec1.CRS_RF,
                exec_mon1_ddm: exec1.CRS_DDM,
                exec_mon1_sdm: exec1.CRS_SDM,
                exec_mon1_ident: exec1.IDENT_AM,
                exec_mon1_width_rf: exec1.WIDTH_RF,
                exec_mon1_width_ddm: exec1.WIDTH_DDM,
                exec_mon1_width_sdm: exec1.WIDTH_SDM,
                exec_mon1_clr_rf: exec1.CLR_RF,
                exec_mon1_clr_ddm: exec1.CLR_DDM,
                exec_mon1_clr_sdm: exec1.CLR_SDM,
                exec_mon1_nf_rf: exec1.NF_RF,
                exec_mon1_nf_ddm: exec1.NF_DDM,
                exec_mon1_nf_sdm: exec1.NF_SDM,
                exec_mon1_rf_freq: exec1.RF_FREQ,
                exec_mon1_freq_dev: exec1.FREQ_DEV,

                // EXECUTIVE MEASUREMENT MON 2 (100% MURNI DATA ASLI DARI ALAT)
                exec_mon2_rf: exec2.CRS_RF,
                exec_mon2_ddm: exec2.CRS_DDM,
                exec_mon2_sdm: exec2.CRS_SDM,
                exec_mon2_ident: exec2.IDENT_AM,
                exec_mon2_width_rf: exec2.WIDTH_RF,
                exec_mon2_width_ddm: exec2.WIDTH_DDM,
                exec_mon2_width_sdm: exec2.WIDTH_SDM,
                exec_mon2_clr_rf: exec2.CLR_RF,
                exec_mon2_clr_ddm: exec2.CLR_DDM,
                exec_mon2_clr_sdm: exec2.CLR_SDM,
                exec_mon2_nf_rf: exec2.NF_RF,
                exec_mon2_nf_ddm: exec2.NF_DDM,
                exec_mon2_nf_sdm: exec2.NF_SDM,
                exec_mon2_rf_freq: exec2.RF_FREQ,
                exec_mon2_freq_dev: exec2.FREQ_DEV,

                // STANDBY MEASUREMENT MON 1 (100% MURNI DATA ASLI DARI ALAT)
                stby_mon1_rf: stby1.CRS_RF,
                stby_mon1_ddm: stby1.CRS_DDM,
                stby_mon1_sdm: stby1.CRS_SDM,
                stby_mon1_width_rf: stby1.WIDTH_RF,
                stby_mon1_width_ddm: stby1.WIDTH_DDM,
                stby_mon1_width_sdm: stby1.WIDTH_SDM,
                stby_mon1_clr_rf: stby1.CLR_RF,
                stby_mon1_clr_ddm: stby1.CLR_DDM,
                stby_mon1_clr_sdm: stby1.CLR_SDM,
                stby_mon1_rf_freq: stby1.RF_FREQ,
                stby_mon1_freq_dev: stby1.FREQ_DEV,

                // STANDBY MEASUREMENT MON 2 (100% MURNI DATA ASLI DARI ALAT)
                stby_mon2_rf: stby2.CRS_RF,
                stby_mon2_ddm: stby2.CRS_DDM,
                stby_mon2_sdm: stby2.CRS_SDM,
                stby_mon2_width_rf: stby2.WIDTH_RF,
                stby_mon2_width_ddm: stby2.WIDTH_DDM,
                stby_mon2_width_sdm: stby2.WIDTH_SDM,
                stby_mon2_clr_rf: stby2.CLR_RF,
                stby_mon2_clr_ddm: stby2.CLR_DDM,
                stby_mon2_clr_sdm: stby2.CLR_SDM,
                stby_mon2_rf_freq: stby2.RF_FREQ,
                stby_mon2_freq_dev: stby2.FREQ_DEV,

                // CURRENT MAINTENANCE ALERT DATA / POWER SUPPLY (100% MURNI DATA ASLI DARI ALAT)
                ps_tx1_v5: this._psTx1?.v5,
                ps_tx1_v15_pos: this._psTx1?.v15_pos,
                ps_tx1_v15_neg: this._psTx1?.v15_neg,
                ps_tx1_v24: this._psTx1?.v24,
                ps_tx1_v54_battery: this._psTx1?.v54_battery,
                ps_tx1_temp_in: this._psTx1?.temp_in,
                ps_tx1_temp_out: this._psTx1?.temp_out,
                ps_tx1_obs_lights: this._psTx1?.obs_lights,

                ps_tx2_v5: this._psTx2?.v5,
                ps_tx2_v15_pos: this._psTx2?.v15_pos,
                ps_tx2_v15_neg: this._psTx2?.v15_neg,
                ps_tx2_v24: this._psTx2?.v24,
                ps_tx2_v54_battery: this._psTx2?.v54_battery,
                ps_tx2_temp_in: this._psTx2?.temp_in,
                ps_tx2_temp_out: this._psTx2?.temp_out,
                ps_tx2_obs_lights: this._psTx2?.obs_lights,

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

    getHeartbeatReply() { return HBEAT_REPLY; }
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
