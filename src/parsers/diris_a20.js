const BaseParser = require('./base');

const LABELS = [
    { Name: "const_id", Unit: "", Scale: 1 },
    { Name: "VLL_RS", Unit: "V", Scale: 100 },
    { Name: "VLL_ST", Unit: "V", Scale: 100 },
    { Name: "VLL_TR", Unit: "V", Scale: 100 },
    { Name: "VLN_R", Unit: "V", Scale: 100 },
    { Name: "VLN_S", Unit: "V", Scale: 100 },
    { Name: "VLN_T", Unit: "V", Scale: 100 },
    { Name: "Freq", Unit: "Hz", Scale: 100 },
    { Name: "ArusR", Unit: "A", Scale: 1000 },
    { Name: "ArusS", Unit: "A", Scale: 1000 },
    { Name: "ArusT", Unit: "A", Scale: 1000 },
    { Name: "reg11", Unit: "", Scale: 100 },
    { Name: "reg12", Unit: "", Scale: 100 },
    { Name: "reg13", Unit: "", Scale: 100 },
    { Name: "reg14", Unit: "", Scale: 100 },
    { Name: "PF", Unit: "", Scale: 1000 }
];

function getModbusCRC16(buffer) {
    let crc = 0xFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc ^= buffer[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 0x0001) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc = crc >> 1;
            }
        }
    }
    return Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF]);
}

class DirisA20Parser extends BaseParser {
    constructor(config) {
        super(config);
        this._buf = Buffer.alloc(0);
        this._lastDecoded = null;
    }

    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            // Prevent buffer from growing too large (e.g. if noise on the line)
            if (this._buf.length > 8192) {
                this._buf = this._buf.slice(this._buf.length - 1024); // Keep last 1KB
            }

            let found = false;
            let decodedParams = null;

            // Search for pattern: [addr] [03] [40] [64 bytes of data] [CRC_Lo] [CRC_Hi] -> 69 bytes total
            while (this._buf.length >= 69) {
                let syncIdx = -1;
                for (let i = 0; i <= this._buf.length - 69; i++) {
                    if (this._buf[i + 1] === 0x03 && this._buf[i + 2] === 0x40) {
                        syncIdx = i;
                        break;
                    }
                }

                if (syncIdx === -1) {
                    // No sync pattern found in the whole buffer up to length-69
                    // Keep the last 68 bytes just in case they are the start of a frame
                    this._buf = this._buf.slice(this._buf.length - 68);
                    break;
                }

                // We found a candidate at syncIdx
                const frame = this._buf.slice(syncIdx, syncIdx + 69);
                const body = frame.slice(0, 67); // everything up to CRC
                const crcRecv = frame.slice(67, 69);
                const crcCalc = getModbusCRC16(body);

                if (crcRecv[0] === crcCalc[0] && crcRecv[1] === crcCalc[1]) {
                    // CRC is valid
                    found = true;
                    decodedParams = this._decodePayload(frame.slice(3, 67));
                    // Consume buffer up to end of this frame
                    this._buf = this._buf.slice(syncIdx + 69);
                } else {
                    // Invalid CRC, skip this candidate's sync byte so we don't loop infinitely
                    this._buf = this._buf.slice(syncIdx + 1);
                }
            }

            if (found && decodedParams) {
                this._lastDecoded = decodedParams;
                return this._buildOutput(decodedParams, false);
            } else {
                return { 
                    success: false, 
                    error: 'Waiting for valid Diris A20 Modbus frame',
                    status: 'Waiting',
                    data: this._lastDecoded ? this._buildOutput(this._lastDecoded, true).data : null
                };
            }
        } catch (err) {
            return {
                success: false,
                error: err.message,
                status: 'Error',
                timestamp: new Date().toISOString()
            };
        }
    }

    _decodePayload(payload) {
        const out = {};
        for (let i = 0; i < payload.length; i += 4) {
            if (i + 4 <= payload.length) {
                // Get INT32 BE
                const val = payload.readInt32BE(i);
                const label = LABELS[i / 4];
                if (label) {
                    out[label.Name] = Number((val / label.Scale).toFixed(3));
                }
            }
        }
        return out;
    }

    _buildOutput(params, isStale) {
        return {
            success: true,
            data: {
                _stale: isStale,
                ...params
            },
            status: 'Normal',
            alarms: [],
            warnings: [],
            triggeredParams: [],
            timestamp: new Date().toISOString()
        };
    }

    reset() {
        this._buf = Buffer.alloc(0);
    }

    getPollRequests() {
        // Read 32 registers starting from 0xC552 (50514). Slave ID = 1.
        return [{
            key: 'main',
            bytes: Buffer.from([0x01, 0x03, 0xC5, 0x52, 0x00, 0x20, 0xD9, 0x0F])
        }];
    }
}

module.exports = DirisA20Parser;
module.exports.POLL_INTERVAL = 15000;
module.exports.POLL_REQ_DELAY = 200;
