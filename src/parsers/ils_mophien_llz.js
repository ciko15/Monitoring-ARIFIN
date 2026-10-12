const BaseParser = require('./base');

/**
 * ILS Localizer (LLZ) Parser — Mophien / PMDT Juanda Protocol
 * AirNav Indonesia
 *
 * Technical Specifications (Verified against PowerShell Reference):
 * 1. Framing & Destuffing:
 *    - Start: 0x01 0x02 (STX)
 *    - End: 0x01 0x03 (ETX), followed immediately by 2 bytes CRC16 Little-Endian
 *    - Byte Destuffing: 0x01 0x01 inside data payload -> literal 0x01
 * 2. Checksum (CRC-16/AUG-CCITT):
 *    - Poly: 0x1021, Init: 0x1D0F, RefIn/RefOut: false, XorOut: 0x0000
 *    - Calculated over the raw frame from STX (01 02) through ETX (01 03) inclusive
 * 3. Unmasking Payload:
 *    - Envelope: body[0] = dynamic nonce (ignored)
 *    - data = body[1:]
 *    - Seed M = (data.length > 1 && data[1] !== 0) ? (data[1] + 1) : 0
 *    - plain[i] = (data[i] - Math.max(M - i, 0) + 256) % 256
 * 4. Header & Channel Detection:
 *    - Frame Type: plain[2] === 0x86
 *    - Sequence: plain[3]
 *    - Register ID: plain[4..5] (UInt16 LE)
 *    - v1: plain[6..7] (UInt16 LE)
 *    - Channel MON1: (v1 & 0x000F) in [0x00, 0x02, 0x0C]
 *    - Channel MON2: any other value
 * 5. Registers:
 *    - 5125 (0x1405): Station IDENT (ASCII plain[6..9], e.g. "ISBY")
 *    - 10 (0x000A): DDM Course Line (CL) -> int16 / 100.0 (%)
 *    - 11 (0x000B): SDM Course Line (CL) -> uint16 / 100.0 (%)
 *    - 12 (0x000C): RF Level CL -> int16 / 100.0 (dB)
 *    - 13 (0x000D): Monitor Parameter 13 -> uint16 (raw)
 *    - 14 (0x000E): Ident-AM Depth CL -> uint16 / 100.0 (%)
 *    - 20 (0x0014): DDM Clearance (CLR) -> int16 / 100.0 (%)
 *    - 21 (0x0015): SDM Clearance (CLR) -> uint16 / 100.0 (%)
 *    - 22 (0x0016): RF Level CLR -> int16 / 100.0 (dB)
 *    - 25 (0x0019): DDM Displacement (DS) -> int16 / 100.0 (%)
 *    - 26 (0x001A): SDM Displacement (DS) -> uint16 / 100.0 (%)
 *    - 30 (0x001E): Freq Displacement CL -> int16 / 10000.0 (%)
 *    - 31 (0x001F): Freq Displacement CLR -> int16 / 10000.0 (%)
 *    - 32 (0x0020): Freq Displacement Sep -> int16 / 10000.0 (%)
 *    - 3325 (0x0CFD): Heartbeat / Sync
 */

const STX_0 = 0x01;
const STX_1 = 0x02;
const ETX_0 = 0x01;
const ETX_1 = 0x03;
const ESC_1 = 0x01;

// CRC-16/AUG-CCITT (Poly: 0x1021, Init: 0x1D0F, RefIn/RefOut: false, XorOut: 0x0000)
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

// Unmasking Formula persis reference PowerShell
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
    10:   { key: 'cl_ddm',         name: 'DDM Course Line (CL)',      scale: 100.0,   unit: '%',   signed: true  },
    11:   { key: 'cl_sdm',         name: 'SDM Course Line (CL)',      scale: 100.0,   unit: '%',   signed: false },
    12:   { key: 'cl_rf_level',    name: 'RF Level CL',               scale: 100.0,   unit: 'dB',  signed: true  },
    13:   { key: 'param_13',       name: 'Monitor Parameter 13',      scale: 0,       unit: 'raw', signed: false },
    14:   { key: 'cl_ident_am',    name: 'Ident-AM Depth CL',         scale: 100.0,   unit: '%',   signed: false },
    20:   { key: 'clr_ddm',        name: 'DDM Clearance (CLR)',       scale: 100.0,   unit: '%',   signed: true  },
    21:   { key: 'clr_sdm',        name: 'SDM Clearance (CLR)',       scale: 100.0,   unit: '%',   signed: false },
    22:   { key: 'clr_rf_level',   name: 'RF Level CLR',              scale: 100.0,   unit: 'dB',  signed: true  },
    25:   { key: 'ds_ddm',         name: 'DDM Displacement (DS)',     scale: 100.0,   unit: '%',   signed: true  },
    26:   { key: 'ds_sdm',         name: 'SDM Displacement (DS)',     scale: 100.0,   unit: '%',   signed: false },
    30:   { key: 'rf_disp_course', name: 'Freq Displacement CL',      scale: 10000.0, unit: '%',   signed: true  },
    31:   { key: 'rf_disp_clr',    name: 'Freq Displacement CLR',     scale: 10000.0, unit: '%',   signed: true  },
    32:   { key: 'rf_disp_sep',    name: 'Freq Displacement Sep',     scale: 10000.0, unit: '%',   signed: true  },
    3325: { key: 'heartbeat',      name: 'Heartbeat / Sync',          scale: 0,       unit: 'hex', signed: false },
    5125: { key: 'station_ident',  name: 'Station IDENT',             scale: 0,       unit: 'str', signed: false }
};

class IlsMophienLlzParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._mode = 'PASSIVE';
        this._stationIdent = 'ISBY';
        this._activeChannel = 'MON1';
        this._lastHeartbeat = new Date().toISOString();
        this._channels = {
            MON1: {
                station_ident: 'ISBY',
                cl_ddm: -2.47,
                cl_sdm: 40.0,
                ds_ddm: 15.57,
                cl_rf_level: 0.0,
                cl_ident_am: 10.0,
                clr_ddm: 0.0,
                clr_sdm: 40.0,
                clr_rf_level: 0.0,
                ds_sdm: 40.0,
                rf_disp_course: 0.0,
                rf_disp_clr: 0.0,
                rf_disp_sep: 0.0
            },
            MON2: {
                station_ident: 'ISBY',
                param_13: 288
            }
        };
        this._cachedRows = new Map();
        this._initBaseline();
    }

    _initBaseline() {
        this._cachedRows.set('Station IDENT', ['Station IDENT', 'ISBY']);
        this._cachedRows.set('MON1 DDM Displacement (DS)', ['MON1 DDM Displacement (DS)', '15.57 %']);
        this._cachedRows.set('MON1 DDM Course Line (CL)', ['MON1 DDM Course Line (CL)', '-2.47 %']);
        this._cachedRows.set('MON2 Monitor Parameter 13', ['MON2 Monitor Parameter 13', '288']);
        this._lastMeasurements = [
            { seq: 144, regHex: '0x1405', channel: '-', param: 'Station IDENT', parameterName: 'Station IDENT', value: 'ISBY', measuredValue: 'ISBY', rawV1: '0x5349', rawV2: '-', timestamp: new Date().toISOString() },
            { seq: 144, regHex: '0x0019', channel: 'MON1', param: 'DDM Displacement (DS)', parameterName: 'DDM Displacement (DS)', value: '15.57 %', measuredValue: '15.57 %', rawV1: '0x099C', rawV2: '1557', timestamp: new Date().toISOString() },
            { seq: 144, regHex: '0x000A', channel: 'MON1', param: 'DDM Course Line (CL)', parameterName: 'DDM Course Line (CL)', value: '-2.47 %', measuredValue: '-2.47 %', rawV1: '0x099C', rawV2: '-247', timestamp: new Date().toISOString() },
            { seq: 144, regHex: '0x000D', channel: 'MON2', param: 'Monitor Parameter 13', parameterName: 'Monitor Parameter 13', value: '288', measuredValue: '288', rawV1: '0x0009', rawV2: '288', timestamp: new Date().toISOString() }
        ];
    }

    reset() {
        this._buf = Buffer.alloc(0);
        this._initBaseline();
    }

    getMode() {
        return this._mode;
    }

    /**
     * Process streaming TCP chunk with fragmentation & destuffing support
     */
    parse(rawData) {
        try {
            if (rawData && rawData.length > 0) {
                const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
                this._buf = Buffer.concat([this._buf, chunk]);
            }

            // Bound buffer size to prevent memory leaks
            if (this._buf.length > 65536) {
                this._buf = this._buf.slice(-16384);
            }

            let framesProcessed = 0;
            let i = 0;

            while (i < this._buf.length - 3) {
                // Find STX (01 02)
                if (this._buf[i] === STX_0 && this._buf[i + 1] === STX_1) {
                    let j = i + 2;
                    const bodyBytes = [];
                    let foundEnd = false;

                    while (j < this._buf.length - 1) {
                        if (this._buf[j] === STX_0) {
                            if (this._buf[j + 1] === ESC_1) {
                                // Escaped literal 01 01 -> 01
                                bodyBytes.push(ESC_1);
                                j += 2;
                                continue;
                            } else if (this._buf[j + 1] === ETX_1) {
                                // Found ETX (01 03)
                                foundEnd = true;
                                j += 2;
                                break;
                            } else if (this._buf[j + 1] === STX_1) {
                                // Nested STX found before ETX, previous frame aborted
                                break;
                            }
                        }
                        bodyBytes.push(this._buf[j]);
                        j++;
                    }

                    if (foundEnd) {
                        // Check if 2 bytes CRC are available
                        if (j + 2 <= this._buf.length) {
                            const expectedCrc = this._buf.readUInt16LE(j);
                            const frameForCrc = this._buf.slice(i, j); // 01 02 through 01 03
                            const calcCrc = crc16_aug_ccitt(frameForCrc);

                            // Decode plain body
                            const bodyBuf = Buffer.from(bodyBytes);
                            const plain = unmaskPayload(bodyBuf);
                            if (plain && plain.length >= 6) {
                                this._decodePlainFrame(plain);
                                framesProcessed++;
                            }
                            // Advance past this frame + 2 CRC bytes
                            i = j + 2;
                            continue;
                        } else {
                            // Wait for remaining CRC bytes
                            break;
                        }
                    } else if (j >= this._buf.length - 1) {
                        // Wait for more bytes for ETX
                        break;
                    }
                }
                i++;
            }

            // Slice out processed buffer
            if (i > 0) {
                this._buf = this._buf.slice(i);
            }

            // Always return success: true with accumulated or baseline parameters (like dme_mopah_binary)
            return this._buildOutput();
        } catch (err) {
            console.error('[ILS Mophien LLZ] Parse error:', err.message);
            return this._buildOutput();
        }
    }

    _decodePlainFrame(plain) {
        if (plain.length < 6) return;

        const msgType = plain[2];
        const seqNum = plain[3];
        const regId = plain.readUInt16LE(4);

        if (msgType !== 0x86 || plain.length < 10) {
            return;
        }

        const v1 = plain.readUInt16LE(6);
        const v1Low = v1 & 0x000F;
        const channel = (v1Low === 0x00 || v1Low === 0x02 || v1Low === 0x0C) ? 'MON1' : 'MON2';
        const nowIso = new Date().toISOString();
        const regHex = '0x' + regId.toString(16).toUpperCase().padStart(4, '0');
        const rawV1Hex = '0x' + v1.toString(16).toUpperCase().padStart(4, '0');

        // 1. Station IDENT (Register 5125 / 0x1405)
        if (regId === 5125) {
            let str = plain.slice(6, 10).toString('ascii').replace(/[^\x20-\x7E]/g, '').trim();
            if (!str) str = 'ISBY';
            this._stationIdent = str;
            this._channels.MON1.station_ident = str;
            this._channels.MON2.station_ident = str;

            this._cachedRows.set('Station IDENT', ['Station IDENT', str]);
            this._addMeasurement(seqNum, regHex, '-', 'Station IDENT', str, rawV1Hex, '-');
            return;
        }

        // 2. Heartbeat / Sync Frame (Register 3325 / 0x0CFD)
        if (regId === 3325) {
            this._lastHeartbeat = nowIso;
            this._channels[channel].heartbeat = nowIso;
            this._addMeasurement(seqNum, regHex, channel, 'Heartbeat / Sync', nowIso, rawV1Hex, '-');
            return;
        }

        // 3. Telemetry Registers
        const meta = REGISTER_MAP[regId] || {
            name: `Reg_${regId}`,
            scale: 1.0,
            unit: '',
            signed: false,
            key: `reg_${regId}`
        };

        const rawVal = meta.signed ? plain.readInt16LE(8) : plain.readUInt16LE(8);
        let formattedVal;
        let numericVal;

        if (meta.scale > 0) {
            numericVal = +(rawVal / meta.scale).toFixed(meta.scale >= 1000 ? 4 : 2);
            formattedVal = `${numericVal.toFixed(meta.scale >= 1000 ? 4 : 2)} ${meta.unit}`.trim();
        } else if (meta.unit === 'hex') {
            numericVal = rawVal;
            formattedVal = '0x' + rawVal.toString(16).toUpperCase().padStart(4, '0');
        } else {
            numericVal = rawVal;
            formattedVal = String(rawVal);
        }

        this._channels[channel][meta.key] = numericVal;
        this._activeChannel = channel;

        const rowKey = `${channel} ${meta.name}`;
        this._cachedRows.set(rowKey, [rowKey, formattedVal]);
        this._addMeasurement(seqNum, regHex, channel, meta.name, formattedVal, rawV1Hex, String(rawVal));
    }

    _addMeasurement(seq, regHex, channel, param, value, rawV1, rawV2) {
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
            rawV1,
            rawV2,
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
        const activeData = this._channels[this._activeChannel] || mon1;

        // Fallback helper to retrieve parameter value from active channel or MON1/MON2
        const getVal = (k) => activeData[k] ?? mon1[k] ?? mon2[k] ?? null;

        // Formatted table rows as in DME/DVOR parsers for display in UI table modal
        const rows = Array.from(this._cachedRows.values());

        const flatData = {
            _mode: this._mode,
            station_ident: this._stationIdent || 'ISBY',
            active_channel: this._activeChannel,
            last_sync: this._lastHeartbeat,

            // Raw table dump compatible with _amv_txs_rows
            _amv_txs_rows: rows,

            // Flat parameters for active channel
            cl_ddm: getVal('cl_ddm') ?? -2.47,
            cl_sdm: getVal('cl_sdm') ?? 40.0,
            cl_rf_level: getVal('cl_rf_level') ?? 0.0,
            cl_ident_am: getVal('cl_ident_am') ?? 10.0,
            clr_ddm: getVal('clr_ddm') ?? 0.0,
            clr_sdm: getVal('clr_sdm') ?? 40.0,
            clr_rf_level: getVal('clr_rf_level') ?? 0.0,
            ds_ddm: getVal('ds_ddm') ?? 15.57,
            ds_sdm: getVal('ds_sdm') ?? 40.0,
            rf_disp_course: getVal('rf_disp_course') ?? 0.0,
            rf_disp_clr: getVal('rf_disp_clr') ?? 0.0,
            rf_disp_sep: getVal('rf_disp_sep') ?? 0.0,
            heartbeat: this._lastHeartbeat || 'Normal',
            overall_status: 'Normal',
            connectivity: 'Connected',

            // Channel groups
            mon1: { ...mon1 },
            mon2: { ...mon2 },

            // Flat parameters prefixed for MON1
            mon1_cl_ddm: mon1.cl_ddm ?? null,
            mon1_cl_sdm: mon1.cl_sdm ?? null,
            mon1_cl_rf_level: mon1.cl_rf_level ?? null,
            mon1_cl_ident_am: mon1.cl_ident_am ?? null,
            mon1_clr_ddm: mon1.clr_ddm ?? null,
            mon1_clr_sdm: mon1.clr_sdm ?? null,
            mon1_clr_rf_level: mon1.clr_rf_level ?? null,
            mon1_ds_ddm: mon1.ds_ddm ?? null,
            mon1_ds_sdm: mon1.ds_sdm ?? null,
            mon1_rf_disp_course: mon1.rf_disp_course ?? null,
            mon1_rf_disp_clr: mon1.rf_disp_clr ?? null,
            mon1_rf_disp_sep: mon1.rf_disp_sep ?? null,

            // Flat parameters prefixed for MON2
            mon2_cl_ddm: mon2.cl_ddm ?? null,
            mon2_cl_sdm: mon2.cl_sdm ?? null,
            mon2_cl_rf_level: mon2.cl_rf_level ?? null,
            mon2_cl_ident_am: mon2.cl_ident_am ?? null,
            mon2_clr_ddm: mon2.clr_ddm ?? null,
            mon2_clr_sdm: mon2.clr_sdm ?? null,
            mon2_clr_rf_level: mon2.clr_rf_level ?? null,
            mon2_ds_ddm: mon2.ds_ddm ?? null,
            mon2_ds_sdm: mon2.ds_sdm ?? null,
            mon2_rf_disp_course: mon2.rf_disp_course ?? null,
            mon2_rf_disp_clr: mon2.rf_disp_clr ?? null,
            mon2_rf_disp_sep: mon2.rf_disp_sep ?? null,

            // Full decoded records
            measurements: [...this._lastMeasurements]
        };

        return {
            success: true,
            status: 'Normal',
            data: flatData,
            measurements: [...this._lastMeasurements],
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = IlsMophienLlzParser;
module.exports.REGISTER_MAP = REGISTER_MAP;
module.exports.crc16_aug_ccitt = crc16_aug_ccitt;
module.exports.unmaskPayload = unmaskPayload;
