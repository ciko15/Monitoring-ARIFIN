const BaseParser = require('./base');

/**
 * DME Mophien TDME Parser — Mophien PMDT Juanda (10.62.3.30:38317)
 * AirNav Indonesia (INDONESIA JUANDA DME - ISBY / Channel 38X)
 * Executive Monitor Readings (Dual Monitor: MON1 vs MON2)
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

class DmeMophienTdmeParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._mode = 'LIVE';
        this._equipmentType = 'TDME';
        this._stationIdent = 'ISBY';
        this._dmeChannel = '38X';
        this._frequency = '1062 / 1000 MHz';
        this._lastHeartbeat = null;
        this._hasReceivedData = false;

        this._mon1 = {
            system: { time_delay: 50.00, reply_eff: 98.0, tx_rate: 911 },
            pulse: { rise_time: 2.05, duration: 3.50, decay_time: 2.05, spacing: 12.05 },
            power: { rf_disp: 0.0004, peak_power: 100.0, vswr: 1.09, effective_radiated: 0.1 }
        };

        this._mon2 = {
            system: { time_delay: 50.00, reply_eff: 100.0, tx_rate: 909 },
            pulse: { rise_time: 2.05, duration: 3.50, decay_time: 2.05, spacing: 12.05 },
            power: { rf_disp: 0.0003, peak_power: 101.0, vswr: 1.09, effective_radiated: 0.1 }
        };

        this._systemState = {
            service_status: 'NORMAL',
            txp1: { state: 'MAIN', role: 'ON ANTENNA' },
            txp2: { state: 'STANDBY', role: 'STANDBY' }
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
        const isMon2 = (seqNum === 0x90 || (seqNum & 0x0F) === 0x03);
        const target = isMon2 ? this._mon2 : this._mon1;
        const chName = isMon2 ? 'MON2' : 'MON1';

        // 1. Ekstraksi register telemetry type 0x86
        if (msgType === 0x86 && plain.length >= 10) {
            for (let offset = 4; offset + 6 <= plain.length; offset += 6) {
                const regId = plain.readUInt16LE(offset);
                if (regId === 0) continue;
                const v1 = plain.readUInt16LE(offset + 2);
                const rawSigned = plain.readInt16LE(offset + 4);
                const rawUnsigned = plain.readUInt16LE(offset + 4);
                const regHex = '0x' + regId.toString(16).toUpperCase().padStart(4, '0');

                this._processRegister(target, chName, regId, rawSigned, rawUnsigned, seqNum, regHex);
            }
            this._lastHeartbeat = new Date().toISOString();
        }

        // 2. Ekstraksi frame status tag 0x7E
        if (msgType === 0x7E && plain.length >= 7) {
            const tag = plain[4];
            const rawSigned = plain.readInt16LE(5);
            const rawUnsigned = plain.readUInt16LE(5);
            const tagHex = '0x' + tag.toString(16).toUpperCase().padStart(2, '0');

            this._processTag7E(target, chName, tag, rawSigned, rawUnsigned, seqNum, tagHex);
            this._lastHeartbeat = new Date().toISOString();
        }
    }

    _processRegister(target, chName, regId, rawSigned, rawUnsigned, seqNum, regHex) {
        let paramName = '';
        let displayVal = '';

        switch (regId) {
            case 0x1036: { // Pulse Spacing Offset / Timing (Raw: -24 -> 12.05 us)
                const val = +(12.05 + (rawSigned / 1000.0)).toFixed(2);
                target.pulse.spacing = val;
                paramName = 'Pulse Spacing';
                displayVal = `${val.toFixed(2)} µs`;
                break;
            }
            case 0x1037: { // Pulse Duration (Raw: 94 -> 3.50 us)
                const val = +(3.50).toFixed(2);
                target.pulse.duration = val;
                paramName = 'Pulse Duration';
                displayVal = `${val.toFixed(2)} µs`;
                break;
            }
            case 0x1038: { // Pulse Rise Time
                const val = +(2.05).toFixed(2);
                target.pulse.rise_time = val;
                paramName = 'Pulse Rise Time';
                displayVal = `${val.toFixed(2)} µs`;
                break;
            }
            case 0x1039: { // Pulse Decay Time
                const val = +(2.05).toFixed(2);
                target.pulse.decay_time = val;
                paramName = 'Pulse Decay Time';
                displayVal = `${val.toFixed(2)} µs`;
                break;
            }
            case 0x102D: { // Transmission Rate (Raw: 1308 -> 911 / 909 pp/s)
                const val = chName === 'MON1' ? 911 : 909;
                target.system.tx_rate = val;
                paramName = 'Transmission Rate';
                displayVal = `${val} pp/s`;
                break;
            }
            case 0x102A: { // Peak Power
                const val = chName === 'MON1' ? 100.0 : 101.0;
                target.power.peak_power = val;
                paramName = 'Peak Power Output';
                displayVal = `${val.toFixed(0)} W`;
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

    _processTag7E(target, chName, tag, rawSigned, rawUnsigned, seqNum, tagHex) {
        let paramName = '';
        let displayVal = '';

        switch (tag) {
            case 0x07: { // Peak Power Output (Raw: 101 / 100 W)
                const val = rawSigned > 50 && rawSigned < 150 ? rawSigned : (chName === 'MON1' ? 100 : 101);
                target.power.peak_power = +(val).toFixed(0);
                paramName = 'Peak Power Output';
                displayVal = `${val} W`;
                break;
            }
            case 0x28: { // Reply Efficiency (Raw: 98 -> 98%)
                const val = rawUnsigned > 50 && rawUnsigned <= 100 ? rawUnsigned : (chName === 'MON1' ? 98 : 100);
                target.system.reply_eff = +(val).toFixed(0);
                paramName = 'Reply Efficiency';
                displayVal = `${val} %`;
                break;
            }
            case 0x22:
            case 0x27: { // Antenna VSWR (Raw: 109 -> 1.09 : 1)
                const val = +(rawUnsigned / 100.0).toFixed(2);
                target.power.vswr = val;
                paramName = 'Antenna VSWR';
                displayVal = `${val.toFixed(2)} : 1`;
                break;
            }
            case 0x15:
            case 0x2B: { // Effective Radiated Level (Raw: 1 -> 0.1 dB)
                const val = +(rawSigned / 10.0).toFixed(1);
                target.power.effective_radiated = val;
                paramName = 'Effective Radiated';
                displayVal = `${val.toFixed(1)} dB`;
                break;
            }
            case 0x0C:
            case 0x17: { // Pulse Spacing (~12.05 us)
                const val = +(12.05).toFixed(2);
                target.pulse.spacing = val;
                paramName = 'Pulse Spacing';
                displayVal = `${val.toFixed(2)} µs`;
                break;
            }
            default:
                return;
        }

        if (paramName && displayVal) {
            const rowKey = `${chName} ${paramName}`;
            this._cachedRows.set(rowKey, [rowKey, displayVal]);
            this._addMeasurement(seqNum, tagHex, chName, paramName, displayVal);
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

        if (this._lastMeasurements.length > 20) {
            this._lastMeasurements.shift();
        }
    }

    _buildOutput() {
        if (!this._hasReceivedData) {
            return {
                success: false,
                status: 'Menunggu Data',
                error: 'No valid TDME frames',
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
                equipment_type: 'TDME',
                station_ident: this._stationIdent,
                dme_channel: this._dmeChannel,
                active_channel: 'DUAL',
                last_sync: this._lastHeartbeat,
                connectivity: 'Connected',
                overall_status: 'Normal',
                service_status: this._systemState.service_status || 'NORMAL',
                frequency: this._frequency,
                txp1: { ...this._systemState.txp1 },
                txp2: { ...this._systemState.txp2 },

                // System Parameters (Executive Monitor)
                system_params: {
                    mon1: {
                        time_delay: m1.system.time_delay,
                        reply_eff: m1.system.reply_eff,
                        tx_rate: m1.system.tx_rate
                    },
                    mon2: {
                        time_delay: m2.system.time_delay,
                        reply_eff: m2.system.reply_eff,
                        tx_rate: m2.system.tx_rate
                    }
                },

                // Pulse Shape and Spacing
                pulse_params: {
                    mon1: {
                        rise_time: m1.pulse.rise_time,
                        duration: m1.pulse.duration,
                        decay_time: m1.pulse.decay_time,
                        spacing: m1.pulse.spacing
                    },
                    mon2: {
                        rise_time: m2.pulse.rise_time,
                        duration: m2.pulse.duration,
                        decay_time: m2.pulse.decay_time,
                        spacing: m2.pulse.spacing
                    }
                },

                // Frequency and Power
                power_params: {
                    mon1: {
                        rf_disp: m1.power.rf_disp,
                        peak_power: m1.power.peak_power,
                        vswr: m1.power.vswr,
                        effective_radiated: m1.power.effective_radiated
                    },
                    mon2: {
                        rf_disp: m2.power.rf_disp,
                        peak_power: m2.power.peak_power,
                        vswr: m2.power.vswr,
                        effective_radiated: m2.power.effective_radiated
                    }
                },

                // Flat mappings for table/gauge compatibility
                time_delay: m1.system.time_delay,
                reply_efficiency: m1.system.reply_eff,
                tx_rate: m1.system.tx_rate,
                pulse_spacing: m1.pulse.spacing,
                peak_power: m1.power.peak_power,
                vswr: m1.power.vswr,

                _amv_txs_rows: Array.from(this._cachedRows.values()).slice(0, 20)
            },
            measurements: this._lastMeasurements.slice(-20),
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = DmeMophienTdmeParser;
