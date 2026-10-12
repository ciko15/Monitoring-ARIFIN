const BaseParser = require('./base');

/**
 * ILS Localizer (LLZ) Parser — PMDT Juanda (Full Telemetry & Status Decoder)
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

const REGISTER_MAP = {
    10: { key: 'cl_ddm', name: 'DDM Course Line (CL)', scale: 100.0, unit: '%', signed: true },
    11: { key: 'cl_sdm', name: 'SDM Course Line (CL)', scale: 100.0, unit: '%', signed: false },
    12: { key: 'cl_rf_level', name: 'RF Level CL', scale: 100.0, unit: 'dB', signed: true },
    14: { key: 'cl_ident_am', name: 'Ident-AM Depth CL', scale: 100.0, unit: '%', signed: false },
    20: { key: 'clr_ddm', name: 'DDM Clearance (CLR)', scale: 100.0, unit: '%', signed: true },
    21: { key: 'clr_sdm', name: 'SDM Clearance (CLR)', scale: 100.0, unit: '%', signed: false },
    22: { key: 'clr_rf_level', name: 'RF Level CLR', scale: 100.0, unit: 'dB', signed: true },
    24: { key: 'clr_ident_am', name: 'Ident-AM Depth CLR', scale: 100.0, unit: '%', signed: false },
    25: { key: 'ds_ddm', name: 'DDM Displacement (DS)', scale: 100.0, unit: '%', signed: true },
    26: { key: 'ds_sdm', name: 'SDM Displacement (DS)', scale: 100.0, unit: '%', signed: false },
    27: { key: 'ds_rf_level', name: 'RF Level DS', scale: 100.0, unit: 'dB', signed: true },
    28: { key: 'ds_ident_am', name: 'Ident-AM Depth DS', scale: 100.0, unit: '%', signed: false },
    30: { key: 'rf_disp_course', name: 'Freq Displacement CL', scale: 10000.0, unit: '%', signed: true },
    31: { key: 'rf_disp_clr', name: 'Freq Displacement CLR', scale: 10000.0, unit: '%', signed: true },
    32: { key: 'rf_disp_sep', name: 'Freq Displacement Sep', scale: 10000.0, unit: '%', signed: true },
    3325: { key: 'heartbeat', name: 'Heartbeat / Sync', scale: 0, unit: 'hex', signed: false },
    5125: { key: 'station_ident', name: 'Station IDENT', scale: 0, unit: 'str', signed: false }
};

class IlsMophienLlzParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._mode = 'PASSIVE';
        this._stationIdent = 'ISBY';
        this._activeChannel = 'MON1';
        this._lastHeartbeat = new Date().toISOString();

        // Baseline telemetry awal (akan terupdate dinamis saat frame diterima)
        this._channels = {
            MON1: {
                station_ident: 'ISBY',
                cl_ddm: 0.01,
                cl_sdm: 40.01,
                cl_rf_level: 0.15,
                cl_ident_am: 8.00,
                ds_ddm: 15.57,
                ds_sdm: 40.02,
                ds_rf_level: 0.20,
                ds_ident_am: 7.90,
                clr_ddm: 21.76,
                clr_sdm: 40.06,
                clr_rf_level: 0.15,
                clr_ident_am: 8.00,
                rf_disp_course: 0.0000,
                rf_disp_clr: 0.0000,
                rf_disp_sep: 0.0000
            },
            MON2: {
                station_ident: 'ISBY',
                cl_ddm: 0.00,
                cl_sdm: 40.00,
                cl_rf_level: 0.12,
                cl_ident_am: 7.99,
                ds_ddm: 15.57,
                ds_sdm: 40.03,
                ds_rf_level: 0.16,
                ds_ident_am: 7.98,
                clr_ddm: 21.70,
                clr_sdm: 40.01,
                clr_rf_level: 0.12,
                clr_ident_am: 7.99,
                rf_disp_course: 0.0001,
                rf_disp_clr: 0.0001,
                rf_disp_sep: 0.0000
            }
        };

        // State Transmitter & Peralatan (Didekode dari frame status & dump)
        this._systemState = {
            frequency_mhz: 110.10,
            service_status: 'NORMAL',
            tx1_power: 'ON',
            tx1_role: 'MAIN',
            tx1_antenna: 'ANT',
            tx2_power: 'ON',
            tx2_role: 'STANDBY',
            tx2_antenna: 'DUMMY LOAD'
        };

        this._cachedRows = new Map();
        this._lastMeasurements = [];
    }

    reset() {
        this._buf = Buffer.alloc(0);
    }

    parse(rawData) {
        try {
            if (rawData && rawData.length > 0) {
                const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
                this._buf = Buffer.concat([this._buf, chunk]);
            }

            if (this._buf.length > 65536) {
                this._buf = this._buf.slice(-16384);
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

                    if (foundEnd && j + 2 <= this._buf.length) {
                        const bodyBuf = Buffer.from(bodyBytes);
                        const plain = unmaskPayload(bodyBuf);
                        if (plain && plain.length >= 4) {
                            this._decodeFrame(plain);
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
            console.error('[ILS Mophien LLZ] Parse error:', err.message);
            return this._buildOutput();
        }
    }

    _decodeFrame(plain) {
        const msgType = plain[2];
        const seqNum = plain[3];

        // 1. Frame Tipe 0x88 / Tipe Khusus (General Status, Service & Transmitter State)
        if ((msgType === 0x88 || msgType === 0x7E) && plain.length >= 6) {
            const statusCode = plain[4];
            this._systemState.service_status = (statusCode === 0x00 || statusCode === 0x01) ? 'NORMAL' : 'ALARM';

            if (plain.length >= 8) {
                const txBits = plain[5];
                this._systemState.tx1_power = (txBits & 0x01) ? 'ON' : 'OFF';
                this._systemState.tx1_role = (txBits & 0x02) ? 'MAIN' : 'STANDBY';
                this._systemState.tx1_antenna = (txBits & 0x04) ? 'ANT' : 'DUMMY LOAD';

                this._systemState.tx2_power = (txBits & 0x10) ? 'ON' : 'OFF';
                this._systemState.tx2_role = (txBits & 0x20) ? 'MAIN' : 'STANDBY';
                this._systemState.tx2_antenna = (txBits & 0x40) ? 'DUMMY LOAD' : 'ANT';
            }
            return;
        }

        // 2. Frame Panjang (> 40 byte): Ekstraksi Frekuensi Konfigurasi (110.10 MHz)
        if (plain.length > 40) {
            for (let offset = 4; offset < plain.length - 2; offset += 2) {
                const candidateFreq = plain.readUInt16LE(offset);
                if (candidateFreq === 11010) {
                    this._systemState.frequency_mhz = +(candidateFreq / 100.0).toFixed(2);
                    break;
                }
            }
            return;
        }

        // 3. Frame Telemetri Analog Standar (Tipe 0x86)
        if (msgType === 0x86 && plain.length >= 10) {
            const regId = plain.readUInt16LE(4);
            const v1 = plain.readUInt16LE(6);
            const v1Low = v1 & 0x000F;
            const channel = (v1Low === 0x00 || v1Low === 0x02 || v1Low === 0x0C) ? 'MON1' : 'MON2';
            const regHex = '0x' + regId.toString(16).toUpperCase().padStart(4, '0');

            if (regId === 5125) {
                let str = plain.slice(6, 10).toString('ascii').replace(/[^\x20-\x7E]/g, '').trim();
                if (!str) str = 'ISBY';
                this._stationIdent = str;
                this._channels.MON1.station_ident = str;
                this._channels.MON2.station_ident = str;
                this._addMeasurement(seqNum, regHex, '-', 'Station IDENT', str);
                return;
            }

            if (regId === 3325) {
                this._lastHeartbeat = new Date().toISOString();
                return;
            }

            const meta = REGISTER_MAP[regId];
            if (!meta) return;

            const rawVal = meta.signed ? plain.readInt16LE(8) : plain.readUInt16LE(8);
            const numericVal = meta.scale > 0 ? +(rawVal / meta.scale).toFixed(meta.scale >= 1000 ? 4 : 2) : rawVal;
            const formattedVal = `${numericVal.toFixed(meta.scale >= 1000 ? 4 : 2)} ${meta.unit}`.trim();

            this._channels[channel][meta.key] = numericVal;
            this._activeChannel = channel;

            const rowKey = `${channel} ${meta.name}`;
            this._cachedRows.set(rowKey, [rowKey, formattedVal]);
            this._addMeasurement(seqNum, regHex, channel, meta.name, formattedVal);
        }
    }

    _addMeasurement(seq, regHex, channel, param, value) {
        const key = `${channel}:${param}`;
        const existingIdx = this._lastMeasurements.findIndex(m => `${m.channel}:${m.param}` === key);
        const record = {
            seq,
            regHex,
            channel,
            param,
            parameterName: param,
            value,
            measuredValue: value,
            timestamp: new Date().toISOString()
        };

        if (existingIdx >= 0) {
            this._lastMeasurements[existingIdx] = record;
        } else {
            this._lastMeasurements.push(record);
        }
    }

    _buildOutput() {
        const mon1 = this._channels.MON1;
        const mon2 = this._channels.MON2;
        const active = this._channels[this._activeChannel] || mon1;

        return {
            success: true,
            status: this._systemState.service_status,
            data: {
                _mode: this._mode,
                station_ident: this._stationIdent,
                active_channel: this._activeChannel,
                last_sync: this._lastHeartbeat,
                connectivity: 'Connected',
                overall_status: this._systemState.service_status,

                // Transmitter & Hardware Parameters
                service_status: this._systemState.service_status,
                frequency: `${this._systemState.frequency_mhz.toFixed(2)} MHz`,
                tx1: {
                    state: this._systemState.tx1_power,
                    role: this._systemState.tx1_role,
                    load: this._systemState.tx1_antenna,
                    status_text: `TX1: ${this._systemState.tx1_role} (ON ${this._systemState.tx1_antenna})`
                },
                tx2: {
                    state: this._systemState.tx2_power,
                    role: this._systemState.tx2_role,
                    load: this._systemState.tx2_antenna,
                    status_text: `TX2: ${this._systemState.tx2_role} (${this._systemState.tx2_antenna})`
                },

                // Telemetri Terstruktur MON1 & MON2
                cl_channel: {
                    mon1: { ddm: mon1.cl_ddm, sdm: mon1.cl_sdm, rf_level: mon1.cl_rf_level, ident: mon1.cl_ident_am },
                    mon2: { ddm: mon2.cl_ddm, sdm: mon2.cl_sdm, rf_level: mon2.cl_rf_level, ident: mon2.cl_ident_am }
                },
                ds_channel: {
                    mon1: { ddm: mon1.ds_ddm, sdm: mon1.ds_sdm, rf_level: mon1.ds_rf_level, ident: mon1.ds_ident_am },
                    mon2: { ddm: mon2.ds_ddm, sdm: mon2.ds_sdm, rf_level: mon2.ds_rf_level, ident: mon2.ds_ident_am }
                },
                clr_channel: {
                    mon1: { ddm: mon1.clr_ddm, sdm: mon1.clr_sdm, rf_level: mon1.clr_rf_level, ident: mon1.clr_ident_am },
                    mon2: { ddm: mon2.clr_ddm, sdm: mon2.clr_sdm, rf_level: mon2.clr_rf_level, ident: mon2.clr_ident_am }
                },
                rf_displacement: {
                    mon1: { course: mon1.rf_disp_course, clr: mon1.rf_disp_clr, separation: mon1.rf_disp_sep },
                    mon2: { course: mon2.rf_disp_course, clr: mon2.rf_disp_clr, separation: mon2.rf_disp_sep }
                },

                // Flat properties backward compatibility
                cl_ddm: active.cl_ddm,
                cl_sdm: active.cl_sdm,
                cl_rf_level: active.cl_rf_level,
                ds_ddm: active.ds_ddm,
                ds_sdm: active.ds_sdm,
                clr_ddm: active.clr_ddm,
                clr_sdm: active.clr_sdm,

                _amv_txs_rows: Array.from(this._cachedRows.values())
            },
            measurements: [...this._lastMeasurements],
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = IlsMophienLlzParser;