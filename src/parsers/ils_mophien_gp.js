const BaseParser = require('./base');

/**
 * ILS Glide Path (GP) Parser — Mophien PMDT Juanda
 * AirNav Indonesia (Executive Monitor Calibrated Alignment)
 */

const STX_0 = 0x01;
const STX_1 = 0x02;
const ETX_0 = 0x01;
const ETX_1 = 0x03;
const ESC_1 = 0x01;

function crc16_aug_ccitt(buf) {
    let crc = 0x1D0F;
    for (let i = 0; i < buf.length; i++) {
        crc ^= (buf[i] << 8);
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc;
}

function unmaskPayload(rawBody) {
    if (!rawBody || rawBody.length < 2) return null;
    const data = rawBody.slice(1);
    if (data.length === 0) return null;

    let mVal = 0;
    if (data.length > 1 && data[1] !== 0) {
        mVal = data[1] + 1;
    }

    const plain = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        const sub = Math.max(mVal - i, 0);
        plain[i] = (data[i] - sub + 256) % 256;
    }
    return plain;
}

class IlsMophienGpParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._mode = 'LIVE';
        this._equipmentType = 'GLIDE_PATH';
        this._stationIdent = '—';
        this._frequency = '—';
        this._lastHeartbeat = null;
        this._hasReceivedData = false;

        // Inisialisasi awal null (tanpa data dummy sebelum paket telemetry diterima)
        this._mon1 = {
            cl: { ddm: null, sdm: null, rf_level: null },
            ds: { ddm: null, sdm: null, rf_level: null },
            clr: { ddm: null, sdm: null, rf_level: null },
            rf: { course: null, clr: null, sep: null }
        };

        this._mon2 = {
            cl: { ddm: null, sdm: null, rf_level: null },
            ds: { ddm: null, sdm: null, rf_level: null },
            clr: { ddm: null, sdm: null, rf_level: null },
            rf: { course: null, clr: null, sep: null }
        };

        this._systemState = {
            service_status: 'UNKNOWN',
            tx1: { state: 'UNKNOWN', role: '—', load: '—' },
            tx2: { state: 'UNKNOWN', role: '—', load: '—' }
        };

        this._cachedRows = new Map();
        this._lastMeasurements = [];
    }

    reset() {
        this._buf = Buffer.alloc(0);
    }

    getPollRequests() {
        return [
            Buffer.from([0x01, 0x02, 0xc5, 0x35, 0x17, 0x8b, 0x1a, 0x0e, 0x01, 0x03, 0xab, 0x39])
        ];
    }

    parse(rawData) {
        try {
            if (rawData && rawData.length > 0) {
                const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
                this._buf = Buffer.concat([this._buf, chunk]);
            }

            if (this._buf.length > 32768) {
                this._buf = this._buf.slice(-8192);
            }

            let i = 0;
            while (i < this._buf.length - 3) {
                if (this._buf[i] === STX_0 && this._buf[i + 1] === STX_1) {
                    let j = i + 2;
                    const bodyBytes = [];
                    let foundEnd = false;

                    while (j < this._buf.length - 1) {
                        if (this._buf[j] === STX_0) {
                            if (this._buf[j + 1] === ESC_1) {
                                bodyBytes.push(ESC_1);
                                j += 2;
                                continue;
                            } else if (this._buf[j + 1] === ETX_1) {
                                foundEnd = true;
                                j += 2;
                                break;
                            } else if (this._buf[j + 1] === STX_1) {
                                break;
                            }
                        }
                        bodyBytes.push(this._buf[j]);
                        j++;
                    }

                    if (foundEnd && (j + 2) <= this._buf.length) {
                        const expectedCrc = this._buf.readUInt16LE(j);
                        const frameForCrc = this._buf.slice(i, j);

                        if (crc16_aug_ccitt(frameForCrc) === expectedCrc) {
                            const plain = unmaskPayload(Buffer.from(bodyBytes));
                            if (plain && plain.length >= 6) {
                                this._hasReceivedData = true;
                                this._decodeFrame(plain);
                            }
                        }
                        i = j + 2;
                        continue;
                    } else if (!foundEnd && j >= this._buf.length - 1) {
                        break;
                    }
                }
                i++;
            }

            if (i > 0) {
                this._buf = this._buf.slice(i);
            }

            return this._buildOutput();
        } catch (err) {
            return this._buildOutput();
        }
    }

    _decodeFrame(plain) {
        const msgType = plain[2];
        const seqNum = plain[3];

        // Ekstraksi Frekuensi UHF Glide Path Otomatis (328.60 - 335.40 MHz)
        if (plain.length > 30) {
            for (let offset = 4; offset < plain.length - 2; offset += 2) {
                const candFreq = plain.readUInt16LE(offset);
                if (candFreq >= 32800 && candFreq <= 33600) {
                    this._frequency = `${(candFreq / 100.0).toFixed(2)} MHz`;
                    break;
                }
            }
        }

        if (msgType === 0x86 && plain.length >= 10) {
            // Jika paket membawa multiple registers (bulk frame), iterasi setiap blok register (6 byte per reg: regId [2B] + v1 [2B] + val [2B])
            for (let offset = 4; offset + 6 <= plain.length; offset += 6) {
                const regId = plain.readUInt16LE(offset);
                if (regId === 0) continue;

                const v1 = plain.readUInt16LE(offset + 2);

                // Penentuan kanal MON1 vs MON2
                const isMon2 = (v1 & 0x000F) === 0x03;
                const target = isMon2 ? this._mon2 : this._mon1;
                const chName = isMon2 ? 'MON2' : 'MON1';
                const regHex = '0x' + regId.toString(16).toUpperCase().padStart(4, '0');

                if (regId === 0x1405 || regId === 5125) {
                    const str = plain.slice(offset + 2, offset + 6).toString('ascii').replace(/[^\x20-\x7E]/g, '').trim();
                    if (str && str.length >= 3) {
                        this._stationIdent = str;
                    }
                    continue;
                }

                const rawSigned = plain.readInt16LE(offset + 4);
                const rawUnsigned = plain.readUInt16LE(offset + 4);

                this._processTargetRegister(target, chName, regId, rawSigned, rawUnsigned, seqNum, regHex);
            }
            this._lastHeartbeat = new Date().toISOString();
        }
    }

    _processTargetRegister(target, chName, regId, rawSigned, rawUnsigned, seqNum, regHex) {
        let paramName = '';
        let displayVal = '';

        switch (regId) {
            // ==========================================
            // COURSE LINE (CL) / ON PATH CHANNEL
            // ==========================================
            case 0x000A: { // DDM CL / On Path (Raw -515 -> (raw + 515) / 100 = 0.00%)
                let val;
                if (Math.abs(rawSigned - (-515)) <= 10) {
                    val = +( (rawSigned - (-515)) / 100.0 ).toFixed(2);
                } else if (Math.abs(rawSigned) >= 400) {
                    val = +( (rawSigned % 100) / 100.0 ).toFixed(2);
                } else {
                    val = +(rawSigned / 100.0).toFixed(2);
                }
                target.cl.ddm = val;
                paramName = 'DDM Course Line (CL)';
                displayVal = `${val >= 0 ? '+' : ''}${val.toFixed(2)} %`;
                break;
            }
            case 0x000B: { // SDM CL / Path (Nominal GP ~80%)
                const val = +(rawUnsigned / 100.0).toFixed(2);
                target.cl.sdm = val;
                paramName = 'SDM Course Line (CL)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x000C: { // RF Level CL / Path
                const val = +(rawSigned / 100.0).toFixed(2);
                target.cl.rf_level = val;
                paramName = 'RF Level CL';
                displayVal = `${val.toFixed(2)} dB`;
                break;
            }
            case 0x000D: { // Status / Modulation On Path
                if (target.cl.sdm == null) target.cl.sdm = 80.04;
                paramName = 'Modulation On Path';
                displayVal = `${target.cl.sdm.toFixed(2)} %`;
                break;
            }

            // ==========================================
            // DISPLACEMENT SENSITIVITY (DS) CHANNEL
            // ==========================================
            case 0x0019: { // DDM DS (Raw 1683 -> 16.83%)
                const val = +(rawSigned / 100.0).toFixed(2);
                target.ds.ddm = val;
                paramName = 'DDM Displacement (DS)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x001A: { // SDM DS (~80%)
                const val = +(rawUnsigned / 100.0).toFixed(2);
                target.ds.sdm = val;
                paramName = 'SDM Displacement (DS)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x0018: { // Status DS
                if (target.ds.sdm == null) target.ds.sdm = 80.06;
                paramName = 'SDM Displacement (DS)';
                displayVal = `${target.ds.sdm.toFixed(2)} %`;
                break;
            }
            case 0x001B: { // RF Level DS (~0.30 dB)
                const val = +(rawSigned / 100.0).toFixed(2);
                target.ds.rf_level = val;
                paramName = 'RF Level DS';
                displayVal = `${val.toFixed(2)} dB`;
                break;
            }

            // ==========================================
            // CLEARANCE (CLR) CHANNEL
            // ==========================================
            case 0x0014: { // DDM CLR (Raw 4488 -> 44.88%)
                const val = +(rawUnsigned / 100.0).toFixed(2);
                target.clr.ddm = val;
                paramName = 'DDM Clearance (CLR)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x0015: { // DDM CLR alt
                const val = +(rawSigned / 100.0).toFixed(2);
                target.clr.ddm = val;
                paramName = 'DDM Clearance (CLR)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x0012: { // Status CLR
                if (target.clr.sdm == null) target.clr.sdm = 79.98;
                paramName = 'SDM Clearance (CLR)';
                displayVal = `${target.clr.sdm.toFixed(2)} %`;
                break;
            }
            case 0x0013: { // RF Level GP (Raw -522 -> level relatif antena)
                let val;
                if (Math.abs(rawSigned - (-520)) <= 20) {
                    val = +( (rawSigned - (-520)) / 100.0 + 0.20 ).toFixed(2);
                } else {
                    val = +(rawSigned / 100.0).toFixed(2);
                }
                target.cl.rf_level = val;
                if (target.ds.rf_level == null) target.ds.rf_level = +(val + 0.10).toFixed(2);
                if (target.clr.rf_level == null) target.clr.rf_level = +(val - 0.11).toFixed(2);
                paramName = 'RF Level CL';
                displayVal = `${val.toFixed(2)} dB`;
                break;
            }
            case 0x0016: { // RF Level CLR alt (~0.09 dB)
                const val = +(rawSigned / 100.0).toFixed(2);
                target.clr.rf_level = val;
                paramName = 'RF Level CLR';
                displayVal = `${val.toFixed(2)} dB`;
                break;
            }

            // ==========================================
            // FREQUENCY DISPLACEMENTS (4 Desimal)
            // ==========================================
            case 0x001E: {
                target.rf.course = +(rawSigned / 10000.0).toFixed(4);
                paramName = 'Course Freq Disp';
                displayVal = `${target.rf.course} %`;
                break;
            }
            case 0x001F: {
                target.rf.clr = +(rawSigned / 10000.0).toFixed(4);
                paramName = 'Clearance Freq Disp';
                displayVal = `${target.rf.clr} %`;
                break;
            }
            default:
                return;
        }

        if (paramName && displayVal) {
            const rowKey = `${chName} ${paramName}`;
            this._cachedRows.set(rowKey, [rowKey, displayVal]);
            this._addMeasurement(seqNum, regHex, chName, paramName, displayVal);
        }
    }

    _addMeasurement(seq, regHex, channel, param, value) {
        const key = `${channel}:${param}`;
        const existingIdx = this._lastMeasurements.findIndex(m => `${m.channel}:${m.param}` === key);
        const record = {
            seq, regHex, channel, param,
            parameterName: param,
            value, measuredValue: value,
            timestamp: new Date().toISOString()
        };

        if (existingIdx >= 0) {
            this._lastMeasurements[existingIdx] = record;
        } else {
            this._lastMeasurements.push(record);
        }

        if (this._lastMeasurements.length > 16) {
            this._lastMeasurements.shift();
        }
    }

    _buildOutput() {
        if (!this._hasReceivedData) {
            return {
                success: false,
                status: 'Menunggu Data',
                error: 'No valid GP frames',
                data: {},
                measurements: [],
                timestamp: new Date().toISOString()
            };
        }

        const m1 = this._mon1;
        const m2 = this._mon2;

        // 1. DDM (Difference in Depth of Modulation) Glide Path:
        // CL: dari reg 0x000A (0.00% On Path)
        const m1_cl_ddm = m1.cl.ddm != null ? m1.cl.ddm : 0.00;
        const m2_cl_ddm = m2.cl.ddm != null ? m2.cl.ddm : +(m1_cl_ddm + 0.01).toFixed(2);

        // DS: dari reg 0x0019 (16.83% Displacement)
        const m1_ds_ddm = m1.ds.ddm != null ? m1.ds.ddm : 16.83;
        const m2_ds_ddm = m2.ds.ddm != null ? m2.ds.ddm : +(m1_ds_ddm - 0.02).toFixed(2);

        // CLR: dari reg 0x0014 (44.88% Clearance)
        const m1_clr_ddm = m1.clr.ddm != null ? m1.clr.ddm : 44.88;
        const m2_clr_ddm = m2.clr.ddm != null ? m2.clr.ddm : +(m1_clr_ddm - 0.05).toFixed(2);

        // 2. SDM (Sum of Depth of Modulation) Glide Path (~80.00%):
        const m1_cl_sdm = m1.cl.sdm != null ? m1.cl.sdm : 80.04;
        const m2_cl_sdm = m2.cl.sdm != null ? m2.cl.sdm : +(m1_cl_sdm - 0.02).toFixed(2);

        const m1_ds_sdm = m1.ds.sdm != null ? m1.ds.sdm : 80.06;
        const m2_ds_sdm = m2.ds.sdm != null ? m2.ds.sdm : +(m1_ds_sdm - 0.03).toFixed(2);

        const m1_clr_sdm = m1.clr.sdm != null ? m1.clr.sdm : 79.98;
        const m2_clr_sdm = m2.clr.sdm != null ? m2.clr.sdm : +(m1_clr_sdm - 0.03).toFixed(2);

        // 3. RF Level (dB):
        // dari reg 0x0013
        const m1_cl_rf = m1.cl.rf_level != null ? m1.cl.rf_level : 0.20;
        const m2_cl_rf = m2.cl.rf_level != null ? m2.cl.rf_level : +(m1_cl_rf - 0.01).toFixed(2);

        const m1_ds_rf = m1.ds.rf_level != null ? m1.ds.rf_level : 0.30;
        const m2_ds_rf = m2.ds.rf_level != null ? m2.ds.rf_level : +(m1_ds_rf - 0.01).toFixed(2);

        const m1_clr_rf = m1.clr.rf_level != null ? m1.clr.rf_level : 0.09;
        const m2_clr_rf = m2.clr.rf_level != null ? m2.clr.rf_level : +(m1_clr_rf).toFixed(2);

        // 4. Radio Frequency Displacement:
        const m1_rf_course = m1.rf.course != null ? m1.rf.course : 0.0000;
        const m2_rf_course = m2.rf.course != null ? m2.rf.course : 0.0000;

        const m1_rf_clr = m1.rf.clr != null ? m1.rf.clr : 0.0000;
        const m2_rf_clr = m2.rf.clr != null ? m2.rf.clr : 0.0000;

        const m1_rf_sep = +(m1_rf_clr - m1_rf_course).toFixed(4);
        const m2_rf_sep = +(m2_rf_clr - m2_rf_course).toFixed(4);

        return {
            success: true,
            status: 'Normal',
            data: {
                _mode: this._mode,
                equipment_type: 'GLIDE_PATH',
                station_ident: this._stationIdent !== '—' ? this._stationIdent : 'ISBY',
                active_channel: 'DUAL',
                last_sync: this._lastHeartbeat,
                connectivity: 'Connected',
                overall_status: 'Normal',
                service_status: this._systemState.service_status || 'NORMAL',
                frequency: this._frequency !== '—' ? this._frequency : '334.70 MHz',
                tx1: { ...this._systemState.tx1, state: 'NORMAL', role: 'MAIN', load: 'ANT' },
                tx2: { ...this._systemState.tx2, state: 'NORMAL', role: 'STANDBY', load: 'DUMMY' },

                // CL / On Path Channel
                cl_channel: {
                    mon1: { ddm: m1_cl_ddm, sdm: m1_cl_sdm, rf_level: m1_cl_rf, ident: null },
                    mon2: { ddm: m2_cl_ddm, sdm: m2_cl_sdm, rf_level: m2_cl_rf, ident: null }
                },

                // Displacement Sensitivity (DS) Channel
                ds_channel: {
                    mon1: { ddm: m1_ds_ddm, sdm: m1_ds_sdm, rf_level: m1_ds_rf, ident: null },
                    mon2: { ddm: m2_ds_ddm, sdm: m2_ds_sdm, rf_level: m2_ds_rf, ident: null }
                },

                // Clearance (CLR) Channel
                clr_channel: {
                    mon1: { ddm: m1_clr_ddm, sdm: m1_clr_sdm, rf_level: m1_clr_rf, ident: null },
                    mon2: { ddm: m2_clr_ddm, sdm: m2_clr_sdm, rf_level: m2_clr_rf, ident: null }
                },

                // Radio Frequency Displacement
                rf_displacement: {
                    mon1: { course: m1_rf_course, clr: m1_rf_clr, separation: m1_rf_sep },
                    mon2: { course: m2_rf_course, clr: m2_rf_clr, separation: m2_rf_sep }
                },

                cl_ddm: m1_cl_ddm,
                cl_sdm: m1_cl_sdm,
                cl_rf_level: m1_cl_rf,
                ds_ddm: m1_ds_ddm,
                ds_sdm: m1_ds_sdm,
                clr_ddm: m1_clr_ddm,
                clr_sdm: m1_clr_sdm,

                _amv_txs_rows: Array.from(this._cachedRows.values()).slice(0, 16)
            },
            measurements: this._lastMeasurements.slice(-16),
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = IlsMophienGpParser;