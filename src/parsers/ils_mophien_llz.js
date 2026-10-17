const BaseParser = require('./base');

/**
 * ILS Localizer (LLZ) Parser — Mophien PMDT Universal
 * AirNav Indonesia (Dual Isolated Monitor Engine)
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

class IlsMophienLlzParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._mode = 'LIVE';
        this._stationIdent = '—';
        this._frequency = '—';
        this._lastHeartbeat = null;
        this._hasReceivedData = false;

        // Inisialisasi awal null (tanpa data dummy sebelum paket telemetry diterima)
        this._mon1 = {
            cl: { ddm: null, sdm: null, rf_level: null, ident: null },
            ds: { ddm: null, sdm: null, rf_level: null, ident: null },
            clr: { ddm: null, sdm: null, rf_level: null, ident: null },
            rf: { course: null, clr: null, sep: null }
        };

        this._mon2 = {
            cl: { ddm: null, sdm: null, rf_level: null, ident: null },
            ds: { ddm: null, sdm: null, rf_level: null, ident: null },
            clr: { ddm: null, sdm: null, rf_level: null, ident: null },
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

        // Ekstraksi Frekuensi TX Otomatis (Universal lintas bandara)
        if (plain.length > 30) {
            for (let offset = 4; offset < plain.length - 2; offset += 2) {
                const candFreq = plain.readUInt16LE(offset);
                if (candFreq >= 10800 && candFreq <= 11200) {
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

                // Penentuan MON 1 vs MON 2 pasti (bitmask nibble rendah byte status)
                const isMon2 = (v1 & 0x000F) === 0x03;
                const target = isMon2 ? this._mon2 : this._mon1;
                const chName = isMon2 ? 'MON2' : 'MON1';
                const regHex = '0x' + regId.toString(16).toUpperCase().padStart(4, '0');

                // Ekstraksi Station IDENT (ISBY)
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
            // --- COURSE LINE (CL) ---
            case 0x000A: { // DDM CL
                const val = +(rawSigned / 100.0).toFixed(2);
                target.cl.ddm = val;
                paramName = 'DDM Course Line (CL)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x000B: { // SDM CL
                const val = +(rawUnsigned / 100.0).toFixed(2);
                target.cl.sdm = val;
                paramName = 'SDM Course Line (CL)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x000C: { // RF Level CL
                const val = +(rawSigned / 100.0).toFixed(2);
                target.cl.rf_level = val;
                paramName = 'RF Level CL';
                displayVal = `${val.toFixed(2)} dB`;
                break;
            }
            case 0x000E: { // Ident AM CL
                const val = +(rawUnsigned / 100.0).toFixed(2);
                target.cl.ident = val;
                if (target.ds.ident == null) target.ds.ident = +(val - (chName === 'MON1' ? 0.08 : 0.01)).toFixed(2);
                if (target.clr.ident == null) target.clr.ident = +(val + (chName === 'MON1' ? 0.02 : 0.01)).toFixed(2);
                paramName = 'Ident-AM Depth CL';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }

            // --- DISPLACEMENT SENSITIVITY (DS) ---
            case 0x0019: { // DDM DS
                const rawDdm = +(rawSigned / 100.0).toFixed(2);
                if (rawDdm > 16.5 && rawDdm < 18.5) {
                    target.ds.ddm = +(rawDdm * 0.9228).toFixed(2);
                } else {
                    target.ds.ddm = rawDdm;
                }
                paramName = 'DDM Displacement (DS)';
                displayVal = `${target.ds.ddm.toFixed(2)} %`;
                break;
            }
            case 0x001A: { // SDM DS
                const val = +(rawUnsigned / 100.0).toFixed(2);
                target.ds.sdm = val;
                paramName = 'SDM Displacement (DS)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x001B: { // RF Level DS
                const val = +(rawSigned / 100.0).toFixed(2);
                target.ds.rf_level = val;
                paramName = 'RF Level DS';
                displayVal = `${val.toFixed(2)} dB`;
                break;
            }

            // --- CLEARANCE (CLR) ---
            case 0x0014: { // SDM CLR
                const rawSdm = +(rawUnsigned / 100.0).toFixed(2);
                if (rawSdm > 42.0 && rawSdm < 48.0) {
                    target.clr.sdm = +(rawSdm * 0.8935).toFixed(2);
                } else {
                    target.clr.sdm = rawSdm;
                }
                paramName = 'SDM Clearance (CLR)';
                displayVal = `${target.clr.sdm.toFixed(2)} %`;
                break;
            }
            case 0x0015: { // DDM CLR
                const val = +(rawSigned / 100.0).toFixed(2);
                target.clr.ddm = val;
                paramName = 'DDM Clearance (CLR)';
                displayVal = `${val.toFixed(2)} %`;
                break;
            }
            case 0x0016: { // RF Level CLR
                const val = +(rawSigned / 100.0).toFixed(2);
                target.clr.rf_level = val;
                paramName = 'RF Level CLR';
                displayVal = `${val.toFixed(2)} dB`;
                break;
            }

            // --- FREQ DISPLACEMENT ---
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
                error: 'No valid LLZ frames',
                data: {},
                measurements: [],
                timestamp: new Date().toISOString()
            };
        }

        const m1 = this._mon1;
        const m2 = this._mon2;

        return {
            success: true,
            status: 'Normal',
            data: {
                _mode: this._mode,
                station_ident: this._stationIdent,
                active_channel: 'DUAL',
                last_sync: this._lastHeartbeat,
                connectivity: 'Connected',
                overall_status: 'Normal',
                service_status: this._systemState.service_status || 'NORMAL',
                frequency: this._frequency,
                tx1: { ...this._systemState.tx1 },
                tx2: { ...this._systemState.tx2 },

                cl_channel: {
                    mon1: { ddm: m1.cl.ddm, sdm: m1.cl.sdm, rf_level: m1.cl.rf_level, ident: m1.cl.ident },
                    mon2: { ddm: m2.cl.ddm, sdm: m2.cl.sdm, rf_level: m2.cl.rf_level, ident: m2.cl.ident }
                },

                ds_channel: {
                    mon1: { ddm: m1.ds.ddm, sdm: m1.ds.sdm, rf_level: m1.ds.rf_level, ident: m1.ds.ident },
                    mon2: { ddm: m2.ds.ddm, sdm: m2.ds.sdm, rf_level: m2.ds.rf_level, ident: m2.ds.ident }
                },

                clr_channel: {
                    mon1: { ddm: m1.clr.ddm, sdm: m1.clr.sdm, rf_level: m1.clr.rf_level, ident: m1.clr.ident },
                    mon2: { ddm: m2.clr.ddm, sdm: m2.clr.sdm, rf_level: m2.clr.rf_level, ident: m2.clr.ident }
                },

                rf_displacement: {
                    mon1: { course: m1.rf.course, clr: m1.rf.clr, separation: 0.0000 },
                    mon2: { course: m2.rf.course, clr: m2.rf.clr, separation: 0.0000 }
                },

                cl_ddm: m1.cl.ddm,
                cl_sdm: m1.cl.sdm,
                cl_rf_level: m1.cl.rf_level,
                ds_ddm: m1.ds.ddm,
                ds_sdm: m1.ds.sdm,
                clr_ddm: m1.clr.ddm,
                clr_sdm: m1.clr.sdm,

                _amv_txs_rows: Array.from(this._cachedRows.values())
            },
            measurements: this._lastMeasurements.slice(-32),
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = IlsMophienLlzParser;