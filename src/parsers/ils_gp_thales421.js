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

// Parameter pengukuran Thales GP 421
const MEASUREMENT_OFFSETS = {
    RF_POWER:    52, // CRS Pos. RF Level = ~99.5 %
    DDM_COURSE:  56, // CRS Pos. DDM (raw*100) = ~ -0.8 %
    CARRIER_PWR: 60, // CRS Pos. SDM / CARRIER = ~73.9 %
    CSB_POWER:   68, // CRS Width RF / CSB = ~97.3 %
    DDM_CLR:     72, // CRS Width DDM (raw*100) = ~16.0 %
    SBO_POWER:   76, // CRS Width SDM / SBO = ~73.8 %
    CLR_POWER:   80, // CLR Width RF Level = ~110.5 %
    CLR_DDM:     84, // CLR Width DDM (raw*100) = ~29.8 %
    CLR_SDM:     88, // CLR Width SDM = ~79.4 %
    GP_ANGLE:    8,  // GP Angle = ~3.0° / 4.408
};

const DDM_X100 = new Set(['DDM_COURSE', 'DDM_CLR', 'CLR_DDM', 'DDM_MON']);

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

    // Filter subtype telemetri GP: Subtype 0x01 atau 0x0E
    if (subtype !== 0x01 && subtype !== 0x0E) return null;

    const isRemote = !!(byte2 & 0x80);
    const tx1IsMain = !!(byte2 & 0x40);

    // Channel mapping: byte4 0x40 / 0x00 / 0x01 / 0xA4
    let channel = 'MON1';
    let offsetShift = 0;
    if (subtype === 0x01) {
        channel = 'MON1';
        offsetShift = 0;
    } else if (subtype === 0x0E) {
        channel = 'MON2';
        const rf52 = readFloat(pkt, 52);
        const rf54 = readFloat(pkt, 54);
        if (rf54 && Math.abs(rf54 - 99.0) < 5.0) offsetShift = 2;
        else if (rf52 && Math.abs(rf52 - 99.0) < 5.0) offsetShift = 0;
    }

    // SANITY CHECK: Pastikan nilai CRS Pos RF Level masuk akal (80% ~ 130%)
    // Mengabaikan frame transisi / frame kosong (seperti yang menghasilkan nilai -26214.5 atau 0)
    const testRf = readFloat(pkt, 52 + offsetShift);
    if (!testRf || testRf < 70.0 || testRf > 130.0) {
        return null;
    }

    const params = {};
    for (const [key, baseOffset] of Object.entries(MEASUREMENT_OFFSETS)) {
        const off = baseOffset + offsetShift;
        let val = readFloat(pkt, off);
        if (val === null) continue;

        // Validasi batasan fisik agar nilai sampah / transisi tidak tembus
        if (key.includes('RF') || key.includes('POWER')) {
            if (val < 0 || val > 150) continue;
        }
        if (key.includes('SDM') || key.includes('CARRIER') || key.includes('SBO')) {
            if (val < 0 || val > 100) continue;
        }

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
        channel,
        subtype,
        params
    };
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
                if (this._buf.length > 1024) {
                    this._buf = this._buf.slice(this._buf.length - 512);
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
                this._isRemote = dec.is_remote;

                // Glitch filter: verifikasi bila ada parameter drop ke 0 sesaat
                const validParams = {};
                for (const [k, v] of Object.entries(dec.params)) {
                    if (v !== null && v !== undefined && !isNaN(v)) {
                        if (k.includes('DDM') || k.includes('DEV') || k.includes('ANGLE')) {
                            validParams[k] = v;
                            continue;
                        }

                        if (v === 0) {
                            this._zeroCounts = this._zeroCounts || {};
                            const zeroKey = `${dec.channel}_${k}`;
                            this._zeroCounts[zeroKey] = (this._zeroCounts[zeroKey] || 0) + 1;
                            if (this._zeroCounts[zeroKey] >= 3) {
                                validParams[k] = 0;
                            }
                        } else {
                            if (this._zeroCounts) {
                                delete this._zeroCounts[`${dec.channel}_${k}`];
                            }
                            validParams[k] = v;
                        }
                    }
                }

                if (dec.channel === 'MON1') {
                    this._execMon1 = { ...(this._execMon1 || {}), ...validParams };
                    this._stbyMon1 = { ...(this._stbyMon1 || {}), ...validParams };
                } else if (dec.channel === 'MON2') {
                    this._execMon2 = { ...(this._execMon2 || {}), ...validParams };
                    this._stbyMon2 = { ...(this._stbyMon2 || {}), ...validParams };
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

                // EXECUTIVE MEASUREMENT MON 1 (Murni dari alat)
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

                // EXECUTIVE MEASUREMENT MON 2 (Murni dari alat)
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

                // STANDBY MEASUREMENT MON 1 (Murni dari alat)
                stby_mon1_rf: stby1.RF_POWER,
                stby_mon1_ddm: stby1.DDM_COURSE,
                stby_mon1_sdm: stby1.CARRIER_PWR,
                stby_mon1_angle: stby1.GP_ANGLE,
                stby_mon1_width_rf: stby1.CSB_POWER,
                stby_mon1_width_ddm: stby1.DDM_CLR,
                stby_mon1_width_sdm: stby1.SBO_POWER,
                stby_mon1_clr_rf: stby1.CLR_POWER,
                stby_mon1_clr_ddm: stby1.CLR_DDM,
                stby_mon1_clr_sdm: stby1.CLR_SDM,

                // STANDBY MEASUREMENT MON 2 (Murni dari alat)
                stby_mon2_rf: stby2.RF_POWER,
                stby_mon2_ddm: stby2.DDM_COURSE,
                stby_mon2_sdm: stby2.CARRIER_PWR,
                stby_mon2_angle: stby2.GP_ANGLE,
                stby_mon2_width_rf: stby2.CSB_POWER,
                stby_mon2_width_ddm: stby2.DDM_CLR,
                stby_mon2_width_sdm: stby2.SBO_POWER,
                stby_mon2_clr_rf: stby2.CLR_POWER,
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

    getHeartbeatReply() { return TRIGGER_SEND; }

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
module.exports.MEASUREMENT_OFFSETS = MEASUREMENT_OFFSETS;
module.exports.OFFSETS = MEASUREMENT_OFFSETS;
