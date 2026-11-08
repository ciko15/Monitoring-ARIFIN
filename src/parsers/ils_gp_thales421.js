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

const PKT_C_SIZE = 80;

// Protokol Mandiri Thales 421 (Hasil Sniffing)
const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]); // ACK / trigger kita kirim
const HBEAT_RECV = Buffer.from([0x13, 0x00, 0xF8, 0x06]); // Heartbeat dari device
const HBEAT_REPLY = Buffer.from([0x13, 0x00, 0xF9, 0x06]); // Balasan heartbeat kita ke device

function isPktCSync(buf, i) {
    // Thales 421 GP Telemetry frame: 11 8D [Flag] 01
    // Subtype 0x01 berisi seluruh parameter float32 pengukuran sinyal ILS GP
    return i + 3 < buf.length &&
        buf[i] === 0x11 && buf[i + 1] === 0x8D && buf[i + 3] === 0x01;
}

// Pemetaan Telemetri Thales GP 421 berdasarkan referensi jendela ADRACS fisik:
// Jendela Executive Measurement:
// - CRS Pos. RF Level (~99.4%)
// - CRS Pos. DDM (-0.8%)
// - CRS Pos. SDM (~73.7%)
// - CRS Width RF Level (~97.3%)
// - CRS Width DDM (16.0%)
// - CRS Width SDM (~73.7%)
// - CLR Width RF Level (~110.4%)
// - CLR Width DDM (29.8%)
// - CLR Width SDM (~79.6%)
const EXEC_OFFSETS = {
    RF_POWER:    52, // CRS Pos. RF Level = 99.4 %
    DDM_COURSE:  56, // CRS Pos. DDM (raw*100) = -0.77 % -> -0.8%
    CARRIER_PWR: 60, // CRS Pos. SDM = 73.9 % -> 73.7%
    CSB_POWER:   68, // CRS Width RF Level = 97.2 % -> 97.3%
    DDM_CLR:     72, // CRS Width DDM (raw*100) = 16.06 % -> 16.0%
    SBO_POWER:   76, // CRS Width SDM = 73.9 % -> 73.7%
    CLR_POWER:   80, // CLR Width RF Level = 110.3 % -> 110.4%
    CLR_DDM:     84, // CLR Width DDM (raw*100) = 29.85 % -> 29.8%
    CLR_SDM:     88, // CLR Width SDM = 79.6 %
};

// Jendela Standby Measurement:
// - CRS CSB1 RF Level (~105.7% - 105.8%) -> offset 52
// - CRS CSB1 DDM (-12.4%) -> offset 56 (raw -0.124 * 100)
// - CRS CSB1 SDM (~79.9%) -> offset 60
// - CRS Width RF Level (~98.3% - 98.4%) -> offset 66
// - CRS Width DDM (19.2%) -> offset 70 (raw 0.192 * 100)
// - CRS Width SDM (~80.8%) -> offset 74
// - CLR Width RF Level (~99.9% - 100.4%) -> offset 78
// - CLR Width DDM (30.1% - 30.5%) -> offset 82 (raw 0.301 - 0.305 * 100)
// - CLR Width SDM (~77.1% - 77.5%) -> offset 86
const STBY_OFFSETS = {
    CSB1_RF:     52, // CRS CSB1 RF Level = 105.8 %
    CSB1_DDM:    56, // CRS CSB1 DDM (raw*100) = -12.4 %
    CSB1_SDM:    60, // CRS CSB1 SDM = 79.9 %
    WIDTH_RF:    66, // CRS Width RF Level = 98.3 %
    WIDTH_DDM:   70, // CRS Width DDM (raw*100) = 19.2 %
    WIDTH_SDM:   74, // CRS Width SDM = 80.9 %
    CLR_RF:      78, // CLR Width RF Level = 100.3 %
    CLR_DDM:     82, // CLR Width DDM (raw*100) = 30.46 %
    CLR_SDM:     86, // CLR Width SDM = 77.5 %
};

const DDM_X100 = new Set(['DDM_COURSE', 'DDM_CLR', 'CLR_DDM', 'CSB1_DDM', 'WIDTH_DDM', 'CLR_DDM']);

const PASSIVE_TIMEOUT = 4000;

function readFloat(buf, offset) {
    try {
        if (offset + 4 > buf.length) return null;
        const v = buf.readFloatLE(offset);
        return (isFinite(v) && Math.abs(v) < 1e6) ? v : null;
    } catch (e) { return null; }
}

function decodePktC(pkt) {
    if (!pkt || pkt.length < PKT_C_SIZE) return null;
    if (pkt[0] !== 0x11 || pkt[1] !== 0x8D) return null;

    const byte2 = pkt[2];
    const subtype = pkt[3];
    const byte4 = pkt[4];

    const isRemote = !!(byte2 & 0x80);
    const tx1IsMain = !!(byte2 & 0x40);

    // 1. Frame Subtype 0x0C membawa telemetri EXECUTIVE MEASUREMENT (CRS Pos, CRS Width, CLR Width, GP ANGLE)
    if (subtype === 0x0C) {
        const angle = readFloat(pkt, 66);
        const rfPos = readFloat(pkt, 15);
        const ddmPos = readFloat(pkt, 19);
        const sdmPos = readFloat(pkt, 23);
        const rfWidth = readFloat(pkt, 31);
        const ddmWidth = readFloat(pkt, 35);
        const sdmWidth = readFloat(pkt, 39);
        const rfClr = readFloat(pkt, 43);
        const ddmClr = readFloat(pkt, 47);
        const sdmClr = readFloat(pkt, 51);

        // Nearfield Pos (RF, DDM, SDM) dan CRS/CLR RF Frequency (Hz)
        const rfNf = readFloat(pkt, 57);
        const ddmNf = readFloat(pkt, 61);
        const sdmNf = readFloat(pkt, 65);
        let freqHz = null;
        try {
            if (pkt.length >= 71) {
                const f = pkt.readUInt16LE(69);
                if (f >= 7900 && f <= 8100) freqHz = f;
            }
        } catch (e) {}

        const params = {};
        if (rfPos !== null && rfPos > 50.0 && rfPos < 150.0) params.RF_POWER = parseFloat(rfPos.toFixed(2));
        if (ddmPos !== null) params.DDM_COURSE = parseFloat((ddmPos * 100).toFixed(2));
        if (sdmPos !== null) params.CARRIER_PWR = parseFloat(sdmPos.toFixed(2));
        if (angle !== null && angle >= 2.0 && angle <= 4.0) params.GP_ANGLE = parseFloat(angle.toFixed(3));
        if (rfWidth !== null) params.CSB_POWER = parseFloat(rfWidth.toFixed(2));
        if (ddmWidth !== null) params.DDM_CLR = parseFloat((ddmWidth * 100).toFixed(2));
        if (sdmWidth !== null) params.SBO_POWER = parseFloat(sdmWidth.toFixed(2));
        if (rfClr !== null) params.CLR_POWER = parseFloat(rfClr.toFixed(2));
        if (ddmClr !== null) params.CLR_DDM = parseFloat((ddmClr * 100).toFixed(2));
        if (sdmClr !== null) params.CLR_SDM = parseFloat(sdmClr.toFixed(2));

        if (rfNf !== null && rfNf > 50.0 && rfNf < 150.0) params.NF_RF = parseFloat(rfNf.toFixed(2));
        if (ddmNf !== null) params.NF_DDM = parseFloat((ddmNf * 100).toFixed(2));
        if (sdmNf !== null) params.NF_SDM = parseFloat(sdmNf.toFixed(2));
        params.FREQ_HZ = freqHz || 8000;

        if (Object.keys(params).length > 0) {
            return {
                type: 'EXECUTIVE_DATA',
                tx_main: tx1IsMain ? 'TX1' : 'TX2',
                tx_stby: tx1IsMain ? 'TX2' : 'TX1',
                channel: byte4 === 0x10 ? 'MON2' : 'MON1',
                is_remote: isRemote,
                params
            };
        }
        return null;
    }

    // 2. Frame Subtype 0x01 (Byte4 0x40): Membawa telemetri RF
    if (subtype === 0x01 && byte4 === 0x40) {
        const val52 = readFloat(pkt, 52);
        if (!val52) return null;

        // Bedakan paket STANDBY (val52 ~105.8%) vs EXECUTIVE (val52 ~99.4%)
        if (Math.abs(val52 - 105.8) < 6.0) {
            // PAKET STANDBY MEASUREMENT
            const params = {};
            for (const [key, off] of Object.entries(STBY_OFFSETS)) {
                let val = readFloat(pkt, off);
                if (val === null) continue;
                val = DDM_X100.has(key) ? parseFloat((val * 100).toFixed(2)) : parseFloat(val.toFixed(2));
                params[key] = val;
            }
            return {
                type: 'STANDBY_DATA',
                channel: 'MON1',
                tx_main: tx1IsMain ? 'TX1' : 'TX2',
                tx_stby: tx1IsMain ? 'TX2' : 'TX1',
                is_remote: isRemote,
                params
            };
        } else if (val52 >= 85.0 && val52 <= 102.0) {
            // PAKET EXECUTIVE MEASUREMENT (CRS Pos RF Level ~99.4%)
            const params = {};
            for (const [key, off] of Object.entries(EXEC_OFFSETS)) {
                let val = readFloat(pkt, off);
                if (val === null) continue;
                val = DDM_X100.has(key) ? parseFloat((val * 100).toFixed(2)) : parseFloat(val.toFixed(2));
                params[key] = val;
            }
            return {
                type: 'EXECUTIVE_DATA',
                channel: 'MON1',
                tx_main: tx1IsMain ? 'TX1' : 'TX2',
                tx_stby: tx1IsMain ? 'TX2' : 'TX1',
                is_remote: isRemote,
                params
            };
        }
    }

    // 3. Frame Subtype 0x0E (Byte4 0xA4): Membawa Executive Measurement dari alat
    if (subtype === 0x0E && byte4 === 0xA4) {
        const val80 = readFloat(pkt, 80);
        if (val80 !== null && val80 >= 80.0 && val80 <= 120.0) {
            const params = {
                RF_POWER: parseFloat(val80.toFixed(2))
            };
            const f84 = readFloat(pkt, 84);
            if (f84 !== null) params.DDM_COURSE = parseFloat((f84 * 100).toFixed(2));
            const f88 = readFloat(pkt, 88);
            if (f88 !== null) params.CARRIER_PWR = parseFloat(f88.toFixed(2));

            return {
                type: 'EXECUTIVE_DATA',
                channel: 'MON2',
                tx_main: tx1IsMain ? 'TX1' : 'TX2',
                tx_stby: tx1IsMain ? 'TX2' : 'TX1',
                is_remote: isRemote,
                params
            };
        }
    }

    return null;
}

function extractFrames(buf) {
    const results = [];
    for (let i = 0; i <= buf.length - PKT_C_SIZE; i++) {
        if (buf[i] === 0x11 && buf[i + 1] === 0x8D) {
            const dec = decodePktC(buf.slice(i, i + PKT_C_SIZE));
            if (dec) {
                results.push({ pos: i, decoded: dec });
                i += PKT_C_SIZE - 1;
            }
        }
    }
    return results;
}

class IlsGpThales421Parser extends BaseParser {
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
        this._isRemote = false;
    }

    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            if (this._buf.length > 131072) {
                let ls = -1;
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
                    success: false, error: 'No valid GP frames', status: 'Waiting',
                    _mode: this._mode,
                    data: this._lastDecoded ? this._buildOutput(this._lastDecoded, true).data : null
                };
            }

            for (const f of frames) {
                const dec = f.decoded;
                this._txMain = dec.tx_main;
                this._txStby = dec.tx_stby;
                if (dec.is_remote !== undefined) this._isRemote = dec.is_remote;



                if (dec.type === 'EXECUTIVE_DATA') {
                    if (dec.channel === 'MON2') {
                        this._execMon2 = { ...(this._execMon2 || {}), ...dec.params };
                        if (!this._execMon1) this._execMon1 = { ...dec.params };
                    } else {
                        this._execMon1 = { ...(this._execMon1 || {}), ...dec.params };
                        if (!this._execMon2) this._execMon2 = { ...dec.params };
                    }
                } else if (dec.type === 'STANDBY_DATA') {
                    if (dec.channel === 'MON2') {
                        this._stbyMon2 = { ...(this._stbyMon2 || {}), ...dec.params };
                        if (!this._stbyMon1) this._stbyMon1 = { ...dec.params };
                    } else {
                        this._stbyMon1 = { ...(this._stbyMon1 || {}), ...dec.params };
                        if (!this._stbyMon2) this._stbyMon2 = { ...dec.params };
                    }
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
        const exec1 = this._execMon1 || {};
        const exec2 = this._execMon2 || {};
        const stby1 = this._stbyMon1 || {};
        const stby2 = this._stbyMon2 || {};

        return {
            success: true,
            data: {
                _mode: this._mode, _stale: isStale,
                tx_main: this._txMain, tx_stby: this._txStby,
                is_remote: this._isRemote,
                status_label: this._isRemote ? 'Remote Maintenance' : 'Normal',
                tx_main_label: `${this._txMain} MAIN`,
                tx_stby_label: `${this._txStby} STBY`,

                // EXECUTIVE MEASUREMENT MON 1 (Persis jendela ADRACS Executive)
                exec_mon1_rf: exec1.RF_POWER,
                exec_mon1_ddm: exec1.DDM_COURSE,
                exec_mon1_sdm: exec1.CARRIER_PWR,
                exec_mon1_angle: exec1.GP_ANGLE,
                exec_mon1_width_rf: exec1.CSB_POWER,
                exec_mon1_width_ddm: exec1.DDM_CLR,
                exec_mon1_width_sdm: exec1.SBO_POWER,
                exec_mon1_clr_rf: exec1.CLR_POWER,
                exec_mon1_clr_ddm: exec1.CLR_DDM,
                exec_mon1_clr_sdm: exec1.CLR_SDM,
                exec_mon1_nf_rf: exec1.NF_RF,
                exec_mon1_nf_ddm: exec1.NF_DDM,
                exec_mon1_nf_sdm: exec1.NF_SDM,
                exec_mon1_freq: exec1.FREQ_HZ,

                // EXECUTIVE MEASUREMENT MON 2 (Persis jendela ADRACS Executive)
                exec_mon2_rf: exec2.RF_POWER,
                exec_mon2_ddm: exec2.DDM_COURSE,
                exec_mon2_sdm: exec2.CARRIER_PWR,
                exec_mon2_angle: exec2.GP_ANGLE,
                exec_mon2_width_rf: exec2.CSB_POWER,
                exec_mon2_width_ddm: exec2.DDM_CLR,
                exec_mon2_width_sdm: exec2.SBO_POWER,
                exec_mon2_clr_rf: exec2.CLR_POWER,
                exec_mon2_clr_ddm: exec2.CLR_DDM,
                exec_mon2_clr_sdm: exec2.CLR_SDM,
                exec_mon2_nf_rf: exec2.NF_RF,
                exec_mon2_nf_ddm: exec2.NF_DDM,
                exec_mon2_nf_sdm: exec2.NF_SDM,
                exec_mon2_freq: exec2.FREQ_HZ,

                // STANDBY MEASUREMENT MON 1 (Persis jendela ADRACS Standby)
                stby_mon1_csb1_rf: stby1.CSB1_RF,
                stby_mon1_csb1_ddm: stby1.CSB1_DDM,
                stby_mon1_csb1_sdm: stby1.CSB1_SDM,
                stby_mon1_width_rf: stby1.WIDTH_RF,
                stby_mon1_width_ddm: stby1.WIDTH_DDM,
                stby_mon1_width_sdm: stby1.WIDTH_SDM,
                stby_mon1_clr_rf: stby1.CLR_RF,
                stby_mon1_clr_ddm: stby1.CLR_DDM,
                stby_mon1_clr_sdm: stby1.CLR_SDM,

                // STANDBY MEASUREMENT MON 2 (Persis jendela ADRACS Standby)
                stby_mon2_csb1_rf: stby2.CSB1_RF,
                stby_mon2_csb1_ddm: stby2.CSB1_DDM,
                stby_mon2_csb1_sdm: stby2.CSB1_SDM,
                stby_mon2_width_rf: stby2.WIDTH_RF,
                stby_mon2_width_ddm: stby2.WIDTH_DDM,
                stby_mon2_width_sdm: stby2.WIDTH_SDM,
                stby_mon2_clr_rf: stby2.CLR_RF,
                stby_mon2_clr_ddm: stby2.CLR_DDM,
                stby_mon2_clr_sdm: stby2.CLR_SDM,

                // Backward compatibility
                ...d.params,
            },
            status: 'Normal',
            alarms: [], warnings: [], triggeredParams: [],
            timestamp: new Date().toISOString(),
        };
    }

    getPollRequests() {
        const mode = this.getMode();
        console.log(`[GP-DEBUG] getPollRequests called. Mode is: ${mode}`);
        if (mode === 'ACTIVE') {
            console.log(`[GP-DEBUG] Sending POLL_TRIGGER 0B 00 F9 06 because ADRACS is offline`);
            const TRIGGER_POLL = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);
            return [{ bytes: TRIGGER_POLL, label: 'POLL_TRIGGER' }];
        }
        return [];
    }

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

    getLastData() { return this._lastDecoded ? this._lastDecoded.params : {}; }
    reset() { this._buf = Buffer.alloc(0); }
}

module.exports = IlsGpThales421Parser;
module.exports.EXEC_OFFSETS = EXEC_OFFSETS;
module.exports.STBY_OFFSETS = STBY_OFFSETS;
module.exports.OFFSETS = EXEC_OFFSETS;
