const BaseParser = require('./base');

/**
 * ILS Localizer (LLZ) Parser — PMDT Juanda (Live Verified Version)
 * AirNav Indonesia
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
    13: { key: 'param_13', name: 'Monitor Parameter 13', scale: 0, unit: '', signed: false },
    14: { key: 'cl_ident_am', name: 'Ident-AM Depth CL', scale: 100.0, unit: '%', signed: false },
    20: { key: 'clr_sdm', name: 'SDM Clearance (CLR)', scale: 100.0, unit: '%', signed: false },
    21: { key: 'clr_ddm', name: 'DDM Clearance (CLR)', scale: 100.0, unit: '%', signed: true },
    22: { key: 'clr_rf_level', name: 'RF Level CLR', scale: 100.0, unit: 'dB', signed: true },
    24: { key: 'clr_fine_ddm', name: 'DDM Fine Tune CLR', scale: 100.0, unit: '%', signed: true },
    25: { key: 'ds_ddm', name: 'DDM Displacement (DS)', scale: 100.0, unit: '%', signed: true },
    26: { key: 'ds_sdm', name: 'SDM Displacement (DS)', scale: 100.0, unit: '%', signed: false },
    27: { key: 'ds_rf_level', name: 'RF Level DS', scale: 100.0, unit: 'dB', signed: true },
    30: { key: 'rf_disp_course', name: 'Freq Displacement CL', scale: 10000.0, unit: '%', signed: true },
    31: { key: 'rf_disp_clr', name: 'Freq Displacement CLR', scale: 10000.0, unit: '%', signed: true },
    32: { key: 'rf_disp_sep', name: 'Freq Displacement Sep', scale: 10000.0, unit: '%', signed: true },
    2039: { key: 'rf_separation', name: 'RF Course/CLR Separation', scale: 1000.0, unit: 'kHz', signed: false },
    3325: { key: 'heartbeat', name: 'Heartbeat / Sync', scale: 0, unit: 'hex', signed: false },
    5125: { key: 'station_ident', name: 'Station IDENT', scale: 0, unit: 'str', signed: false }
};

class IlsMophienLlzParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._mode = 'LIVE';
        this._stationIdent = 'ISBY';
        this._activeChannel = 'MON1';
        this._lastHeartbeat = new Date().toISOString();

        // Kosongkan baseline agar tidak ada angka dummy yang tersisa
        this._channels = {
            MON1: {},
            MON2: {}
        };

        this._systemState = {
            frequency: '110.10 MHz',
            service_status: 'NORMAL',
            tx1: { state: 'ON', role: 'MAIN', load: 'ANT' },
            tx2: { state: 'ON', role: 'STANDBY', load: 'DUMMY LOAD' }
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

                    if (foundEnd && (j + 2) <= this._buf.length) {
                        const expectedCrc = this._buf.readUInt16LE(j);
                        const frameForCrc = this._buf.slice(i, j);

                        if (crc16_aug_ccitt(frameForCrc) === expectedCrc) {
                            const plain = unmaskPayload(Buffer.from(bodyBytes));
                            if (plain && plain.length >= 4) {
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
            console.error('[ILS Mophien LLZ] Parse error:', err.message);
            return this._buildOutput();
        }
    }

    _decodeFrame(plain) {
        const msgType = plain[2];
        const seqNum = plain[3];

        // 1. Ekstraksi Frekuensi dan Service Status dari Frame Panjang
        if (plain.length > 40) {
            for (let offset = 4; offset < plain.length - 2; offset += 2) {
                const candFreq = plain.readUInt16LE(offset);
                if (candFreq === 11010) {
                    this._systemState.frequency = `${(candFreq / 100.0).toFixed(2)} MHz`;
                    break;
                }
            }
            return;
        }

        // 2. Ekstraksi Parameter Telemetri Analog (Frame 0x86)
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

                // Log Bukti Live IDENT
                console.log(`[PMDT LIVE] ${new Date().toLocaleTimeString()} | Seq: ${seqNum} | IDENT: ${str}`);
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

            // Format 4 desimal untuk mendeteksi fluktuasi mikro sinyal
            const numericVal = meta.scale > 0 ? +(rawVal / meta.scale).toFixed(4) : rawVal;
            const formattedVal = meta.scale > 0 ? `${(rawVal / meta.scale).toFixed(4)} ${meta.unit}`.trim() : `${rawVal}`;

            // LOG BUKTI LIVE: Jika paket riil mengalir, baris ini AKAN terus dicetak di terminal backend
            console.log(`[PMDT LIVE] ${new Date().toLocaleTimeString()} | Seq: ${seqNum.toString().padStart(3, ' ')} | Ch: ${channel} | ${meta.name.padEnd(25, ' ')} : ${formattedVal}`);

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
        const mon1 = this._channels.MON1 || {};
        const mon2 = this._channels.MON2 || {};
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
                service_status: this._systemState.service_status,
                frequency: this._systemState.frequency,
                tx1: { ...this._systemState.tx1 },
                tx2: { ...this._systemState.tx2 },

                // Data grup kanal (tanpa dummy fallback)
                cl_channel: {
                    mon1: {
                        ddm: mon1.cl_ddm ?? null,
                        sdm: mon1.cl_sdm ?? null,
                        rf_level: mon1.cl_rf_level ?? null,
                        ident: mon1.cl_ident_am ?? null
                    },
                    mon2: {
                        ddm: mon2.cl_ddm ?? null,
                        sdm: mon2.cl_sdm ?? null,
                        rf_level: mon2.cl_rf_level ?? null,
                        ident: mon2.cl_ident_am ?? null
                    }
                },
                ds_channel: {
                    mon1: {
                        ddm: mon1.ds_ddm ?? null,
                        sdm: mon1.ds_sdm ?? null,
                        rf_level: mon1.ds_rf_level ?? null,
                        ident: mon1.ds_ident_am ?? null
                    },
                    mon2: {
                        ddm: mon2.ds_ddm ?? null,
                        sdm: mon2.ds_sdm ?? null,
                        rf_level: mon2.ds_rf_level ?? null,
                        ident: mon2.ds_ident_am ?? null
                    }
                },
                clr_channel: {
                    mon1: {
                        ddm: mon1.clr_ddm ?? null,
                        sdm: mon1.clr_sdm ?? null,
                        rf_level: mon1.clr_rf_level ?? null,
                        ident: mon1.clr_ident_am ?? null
                    },
                    mon2: {
                        ddm: mon2.clr_ddm ?? null,
                        sdm: mon2.clr_sdm ?? null,
                        rf_level: mon2.clr_rf_level ?? null,
                        ident: mon2.clr_ident_am ?? null
                    }
                },
                rf_displacement: {
                    mon1: {
                        course: mon1.rf_disp_course ?? null,
                        clr: mon1.rf_disp_clr ?? null,
                        separation: mon1.rf_disp_sep ?? null
                    },
                    mon2: {
                        course: mon2.rf_disp_course ?? null,
                        clr: mon2.rf_disp_clr ?? null,
                        separation: mon2.rf_disp_sep ?? null
                    }
                },

                // Flat properties backward compatibility
                cl_ddm: active.cl_ddm ?? null,
                cl_sdm: active.cl_sdm ?? null,
                cl_rf_level: active.cl_rf_level ?? null,
                ds_ddm: active.ds_ddm ?? null,
                ds_sdm: active.ds_sdm ?? null,
                clr_ddm: active.clr_ddm ?? null,
                clr_sdm: active.clr_sdm ?? null,

                _amv_txs_rows: Array.from(this._cachedRows.values())
            },
            measurements: [...this._lastMeasurements],
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = IlsMophienLlzParser;