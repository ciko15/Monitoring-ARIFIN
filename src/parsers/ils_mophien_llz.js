const BaseParser = require('./base');

/**
 * ILS Localizer (LLZ) Parser — Mophien / PMDT Juanda Protocol
 * AirNav Indonesia
 *
 * Technical Specifications:
 * 1. Framing & Destuffing:
 *    - STX: 0x01 0x02
 *    - ETX: 0x01 0x03, followed by 2 bytes CRC16 Little-Endian
 *    - Destuffing: 0x01 0x01 in payload is replaced with literal 0x01
 * 2. Checksum (CRC-16/AUG-CCITT):
 *    - Poly: 0x1021, Init: 0x1D0F, RefIn/RefOut: false, XorOut: 0x0000
 *    - Calculated over bytes 0x01 0x02 to 0x01 0x03 inclusive
 * 3. Unmasking Payload:
 *    - body[0] = dynamic nonce (ignored for unmasking)
 *    - data = body[1:]
 *    - Seed M = (data[1] === 0) ? 0 : data[1] + 1
 *    - plain[i] = (data[i] - Math.max(M - i, 0)) & 0xFF
 *    - Validation: plain[1] must equal 0x00
 * 4. Header & Channel Detection:
 *    - Header: [0x30, 0x00, Type, Seq, Reg_U16_LE, v1_U16_LE, v2_U16_or_I16_LE]
 *    - Type 0x86: Main telemetry payload
 *    - Channel MON1: (v1 & 0x000F) is 0x00, 0x02, or 0x0C (e.g. 2460, 2466)
 *    - Channel MON2: any other value (e.g. 2467, 2468)
 * 5. Register IDs:
 *    - 5125 (0x1405): Station IDENT (ASCII "ISBY")
 *    - 10 (0x000A): DDM Course Line (CL) -> int16(v2) / 100.0 (%)
 *    - 11 (0x000B): SDM Course Line (CL) -> uint16(v2) / 100.0 (%)
 *    - 12 (0x000C): RF Level CL -> int16(v2) / 100.0 (dB)
 *    - 14 (0x000E): Ident-AM Depth CL -> uint16(v2) / 100.0 (%)
 *    - 20 (0x0014): DDM Clearance (CLR) -> int16(v2) / 100.0 (%)
 *    - 21 (0x0015): SDM Clearance (CLR) -> uint16(v2) / 100.0 (%)
 *    - 22 (0x0016): RF Level CLR -> int16(v2) / 100.0 (dB)
 *    - 25 (0x0019): DDM Displacement (DS) -> int16(v2) / 100.0 (%)
 *    - 26 (0x001A): SDM Displacement (DS) -> uint16(v2) / 100.0 (%)
 *    - 30 (0x001E): RF Displacement Course -> int16(v2) / 10000.0 (%)
 *    - 31 (0x001F): RF Displacement Clearance -> int16(v2) / 10000.0 (%)
 *    - 32 (0x0020): RF Displacement Separation -> int16(v2) / 10000.0 (%)
 *    - 3325 (0x0CFD): Heartbeat/Sync Frame
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

// Destuff 01 01 -> 01
function destuffPayload(stuffedBuf) {
    const out = [];
    let i = 0;
    while (i < stuffedBuf.length) {
        if (stuffedBuf[i] === ESC_1 && i + 1 < stuffedBuf.length && stuffedBuf[i + 1] === ESC_1) {
            out.push(ESC_1);
            i += 2;
        } else {
            out.push(stuffedBuf[i]);
            i++;
        }
    }
    return Buffer.from(out);
}

// Unmasking Formula
function unmaskPayload(body) {
    if (!body || body.length < 2) return null;
    const data = body.slice(1); // skip body[0] nonce
    const mSeed = data[1] === 0 ? 0 : data[1] + 1;
    const plain = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        const sub = Math.max(mSeed - i, 0);
        plain[i] = (data[i] - sub) & 0xFF;
    }
    if (plain[1] !== 0x00) {
        return null; // invalid unmasked data
    }
    return plain;
}

const REGISTER_MAP = {
    10:   { key: 'cl_ddm',         name: 'DDM Course Line (CL)',             unit: '%',  signed: true,  scale: 100.0   },
    11:   { key: 'cl_sdm',         name: 'SDM Course Line (CL)',             unit: '%',  signed: false, scale: 100.0   },
    12:   { key: 'cl_rf_level',    name: 'RF Level CL',                      unit: 'dB', signed: true,  scale: 100.0   },
    14:   { key: 'cl_ident_am',    name: 'Ident-AM Depth CL',                unit: '%',  signed: false, scale: 100.0   },
    20:   { key: 'clr_ddm',        name: 'DDM Clearance (CLR)',              unit: '%',  signed: true,  scale: 100.0   },
    21:   { key: 'clr_sdm',        name: 'SDM Clearance (CLR)',              unit: '%',  signed: false, scale: 100.0   },
    22:   { key: 'clr_rf_level',   name: 'RF Level CLR',                     unit: 'dB', signed: true,  scale: 100.0   },
    25:   { key: 'ds_ddm',         name: 'DDM Displacement (DS)',            unit: '%',  signed: true,  scale: 100.0   },
    26:   { key: 'ds_sdm',         name: 'SDM Displacement (DS)',            unit: '%',  signed: false, scale: 100.0   },
    30:   { key: 'rfd_course',     name: 'RF Displacement Course',           unit: '%',  signed: true,  scale: 10000.0 },
    31:   { key: 'rfd_clearance',  name: 'RF Displacement Clearance',        unit: '%',  signed: true,  scale: 10000.0 },
    32:   { key: 'rfd_separation', name: 'RF Displacement Separation',       unit: '%',  signed: true,  scale: 10000.0 },
    3325: { key: 'heartbeat',      name: 'Heartbeat / Sync Frame',           unit: '',   signed: false, scale: 1.0     },
    5125: { key: 'station_ident',  name: 'Station IDENT',                    unit: '',   isString: true                }
};

class IlsMophienLlzParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._mode = 'ACTIVE';
        this._stationIdent = 'ISBY';
        this._activeChannel = 'MON1';
        this._lastHeartbeat = null;
        this._channels = {
            MON1: {},
            MON2: {}
        };
        this._lastMeasurements = [];
    }

    reset() {
        this._buf = Buffer.alloc(0);
    }

    getMode() {
        return this._mode;
    }

    /**
     * Process streaming TCP chunk with fragmentation support
     */
    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            // Keep buffer bound to prevent memory leak
            if (this._buf.length > 65536) {
                this._buf = this._buf.slice(-16384);
            }

            let framesProcessed = 0;

            while (this._buf.length >= 6) {
                // Find STX (01 02)
                let stxIdx = -1;
                for (let i = 0; i < this._buf.length - 1; i++) {
                    if (this._buf[i] === STX_0 && this._buf[i + 1] === STX_1) {
                        stxIdx = i;
                        break;
                    }
                }

                if (stxIdx === -1) {
                    // No STX found, retain last byte if it might be 0x01
                    const keepLast = this._buf[this._buf.length - 1] === STX_0 ? 1 : 0;
                    this._buf = keepLast ? this._buf.slice(-1) : Buffer.alloc(0);
                    break;
                }

                if (stxIdx > 0) {
                    this._buf = this._buf.slice(stxIdx);
                    stxIdx = 0;
                }

                // Look for ETX (01 03), respecting byte-stuffing 01 01
                let etxIdx = -1;
                let cursor = 2; // after 01 02
                let nextStx = -1;

                while (cursor < this._buf.length - 1) {
                    if (this._buf[cursor] === STX_0) {
                        if (this._buf[cursor + 1] === ESC_1) {
                            // Escaped 01 01 literal -> skip
                            cursor += 2;
                            continue;
                        } else if (this._buf[cursor + 1] === ETX_1) {
                            // Found ETX (01 03)
                            etxIdx = cursor;
                            break;
                        } else if (this._buf[cursor + 1] === STX_1) {
                            // Encountered new STX before ETX -> previous was fragmented/invalid
                            nextStx = cursor;
                            break;
                        }
                    }
                    cursor++;
                }

                if (nextStx !== -1) {
                    // Resync to next STX
                    this._buf = this._buf.slice(nextStx);
                    continue;
                }

                if (etxIdx === -1) {
                    // Incomplete frame, wait for more data from TCP stream
                    break;
                }

                // Need 2 more bytes for CRC LE
                const totalFrameLen = etxIdx + 2 + 2; // 01 02 ... 01 03 [CRC_LO] [CRC_HI]
                if (this._buf.length < totalFrameLen) {
                    // Wait for remaining CRC bytes
                    break;
                }

                const rawFrame = this._buf.slice(0, totalFrameLen);
                const rawCrcTarget = rawFrame.slice(0, etxIdx + 2); // 01 02 through 01 03
                const expectedCrc = rawFrame.readUInt16LE(etxIdx + 2);

                // Extract stuffed body
                const stuffedBody = rawFrame.slice(2, etxIdx);
                const destuffedBody = destuffPayload(stuffedBody);

                // CRC Verification (check raw frame, or fallback destuffed frame)
                const calcCrcRaw = crc16_aug_ccitt(rawCrcTarget);
                let crcValid = (calcCrcRaw === expectedCrc);

                if (!crcValid) {
                    const destuffedWithDelims = Buffer.concat([
                        Buffer.from([STX_0, STX_1]),
                        destuffedBody,
                        Buffer.from([ETX_0, ETX_1])
                    ]);
                    const calcCrcDestuffed = crc16_aug_ccitt(destuffedWithDelims);
                    if (calcCrcDestuffed === expectedCrc) {
                        crcValid = true;
                    }
                }

                // Advance buffer past this frame regardless
                this._buf = this._buf.slice(totalFrameLen);

                // Proceed with payload decoding
                if (destuffedBody.length >= 2) {
                    const plain = unmaskPayload(destuffedBody);
                    if (plain && plain.length >= 10) {
                        this._decodePlainFrame(plain);
                        framesProcessed++;
                    }
                }
            }

            if (framesProcessed === 0) {
                return {
                    success: false,
                    error: 'Menunggu data frame ILS Mophien lengkap (buffer ' + this._buf.length + ' bytes)'
                };
            }

            return this._buildOutput();
        } catch (err) {
            console.error('[ILS Mophien LLZ] Parse error:', err.message);
            return {
                success: false,
                error: err.message,
                status: 'Disconnect',
                timestamp: new Date().toISOString()
            };
        }
    }

    _decodePlainFrame(plain) {
        const frameType = plain[2];
        const registerId = plain.readUInt16LE(4);
        const v1 = plain.readUInt16LE(6);
        const v2_u16 = plain.readUInt16LE(8);
        const v2_i16 = plain.readInt16LE(8);

        // Channel Detection based on v1 flags
        const v1Low = v1 & 0x000F;
        const channel = (v1Low === 0x00 || v1Low === 0x02 || v1Low === 0x0C) ? 'MON1' : 'MON2';
        this._activeChannel = channel;

        const regDef = REGISTER_MAP[registerId];
        const nowIso = new Date().toISOString();

        if (registerId === 3325) {
            // Heartbeat / Sync
            this._lastHeartbeat = nowIso;
            this._channels[channel].heartbeat = nowIso;
            return;
        }

        if (registerId === 5125) {
            // Station IDENT ASCII string
            let str = '';
            if (plain.length >= 10) {
                const asciiCandidates = [
                    plain.slice(6, 10).toString('ascii'),
                    plain.slice(8, 12).toString('ascii'),
                    plain.slice(6, plain.length).toString('ascii')
                ];
                for (const cand of asciiCandidates) {
                    const cleaned = cand.replace(/[^A-Za-z0-9]/g, '').trim();
                    if (cleaned.length >= 3) {
                        str = cleaned;
                        break;
                    }
                }
            }
            if (!str) str = 'ISBY';
            this._stationIdent = str;
            this._channels[channel].station_ident = str;
            this._addMeasurement(nowIso, channel, 'Station IDENT', str, '');
            return;
        }

        if (regDef) {
            let measuredValue;
            if (regDef.signed) {
                measuredValue = +(v2_i16 / regDef.scale).toFixed(regDef.scale >= 1000 ? 4 : 2);
            } else {
                measuredValue = +(v2_u16 / regDef.scale).toFixed(regDef.scale >= 1000 ? 4 : 2);
            }

            this._channels[channel][regDef.key] = measuredValue;
            this._addMeasurement(nowIso, channel, regDef.name, measuredValue, regDef.unit);
        }
    }

    _addMeasurement(timestamp, channel, parameterName, measuredValue, unit) {
        // Maintain latest measurement entry for parameter & channel
        const existingIdx = this._lastMeasurements.findIndex(
            m => m.channel === channel && m.parameterName === parameterName
        );
        const record = {
            timestamp,
            channel,
            parameterName,
            measuredValue,
            unit
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

        const flatData = {
            _mode: this._mode,
            station_ident: this._stationIdent || 'ISBY',
            active_channel: this._activeChannel,
            last_sync: this._lastHeartbeat,

            // Channel groups
            mon1: { ...mon1 },
            mon2: { ...mon2 },

            // Flat parameters for active channel
            cl_ddm: activeData.cl_ddm ?? null,
            cl_sdm: activeData.cl_sdm ?? null,
            cl_rf_level: activeData.cl_rf_level ?? null,
            cl_ident_am: activeData.cl_ident_am ?? null,
            clr_ddm: activeData.clr_ddm ?? null,
            clr_sdm: activeData.clr_sdm ?? null,
            clr_rf_level: activeData.clr_rf_level ?? null,
            ds_ddm: activeData.ds_ddm ?? null,
            ds_sdm: activeData.ds_sdm ?? null,
            rfd_course: activeData.rfd_course ?? null,
            rfd_clearance: activeData.rfd_clearance ?? null,
            rfd_separation: activeData.rfd_separation ?? null,

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
            mon1_rfd_course: mon1.rfd_course ?? null,
            mon1_rfd_clearance: mon1.rfd_clearance ?? null,
            mon1_rfd_separation: mon1.rfd_separation ?? null,

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
            mon2_rfd_course: mon2.rfd_course ?? null,
            mon2_rfd_clearance: mon2.rfd_clearance ?? null,
            mon2_rfd_separation: mon2.rfd_separation ?? null,

            // Grouped Telemetry array as requested in spec
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
module.exports.destuffPayload = destuffPayload;
module.exports.unmaskPayload = unmaskPayload;
