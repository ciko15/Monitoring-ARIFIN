'use strict';

const BaseParser = require('./base');

// Known poll frames derived from PCAP
const KNOWN_POLLS = {
    4:  Buffer.from('02020a3019061e0100010000043f4a', 'hex'),
    7:  Buffer.from('02020a3019061e0100010000075c7a', 'hex'),
    29: Buffer.from('02020a3019061e01000100001d27c9', 'hex'),
    45: Buffer.from('02020a3019061e01000100002d74ff', 'hex'),
    48: Buffer.from('02020a3019061e010001000030e83c', 'hex'),
    56: Buffer.from('02020a3019061e010001000038e0bd', 'hex'),
    104: Buffer.from('02020a3019061e01000100006815e7', 'hex')
};
const POLL_IDS = Object.keys(KNOWN_POLLS).map(Number);

class OteDtr100Parser extends BaseParser {
    constructor(config) {
        super(config);
        this.buffer = Buffer.alloc(0);
        this.lastReceiveTime = Date.now();
        this.mode = 'ACTIVE'; // Mulai dari active sampai ada passive data
        this.PASSIVE_TIMEOUT_MS = 5000;
        
        // Detect if this is TX or RX based on the configuration name
        const configName = String(config.name || '').toUpperCase();
        this.isTx = configName.includes('TX');
        this.isRx = configName.includes('RX') || !this.isTx; // Default to RX if not specified
        
        // Data buffer terakhir yang akan dikembalikan oleh parse()
        this.latestData = { _status: 'Normal' };
    }

    reset() {
        this.buffer = Buffer.alloc(0);
        this.lastReceiveTime = Date.now();
        this.mode = 'ACTIVE';
        this.latestData = { _status: 'Normal' };
    }

    getMode() {
        return this.mode;
    }

    checkTimeout() {
        if (this.mode === 'PASSIVE' && (Date.now() - this.lastReceiveTime > this.PASSIVE_TIMEOUT_MS)) {
            this.mode = 'ACTIVE';
        }
    }

    getPollRequests() {
        // Kembalikan array berisi semua frame buffer polling
        return POLL_IDS.map(id => KNOWN_POLLS[id]);
    }

    parse(rawData) {
        if (!rawData) {
            return { success: false, error: 'No data' };
        }

        this.lastReceiveTime = Date.now();
        if (this.mode === 'ACTIVE') {
            this.mode = 'PASSIVE';
        }

        this.buffer = Buffer.concat([this.buffer, rawData]);
        
        let framesParsed = 0;
        while (this.buffer.length > 0) {
            const stxIdx = this.buffer.indexOf(0x02);
            if (stxIdx === -1) {
                this.buffer = Buffer.alloc(0);
                break;
            }
            
            if (stxIdx > 0) {
                this.buffer = this.buffer.slice(stxIdx);
            }

            if (this.buffer.length < 3) break;

            const lenByte = this.buffer[2];
            const totalFrameSize = 1 + 1 + 1 + lenByte + 2;

            if (this.buffer.length < totalFrameSize) break; // Incomplete

            const frame = this.buffer.slice(0, totalFrameSize);
            this.buffer = this.buffer.slice(totalFrameSize);
            this.parseFrame(frame);
            framesParsed++;
        }

        if (framesParsed > 0) {
            return {
                success: true,
                status: this.latestData._status || 'Normal',
                data: {
                    ...this.latestData,
                    _mode: this.mode
                }
            };
        } else {
            return { success: false, error: 'Incomplete frame' };
        }
    }

    parseFrame(frame) {
        const len = frame[2];
        const payload = frame.slice(3, 3 + len);
        
        // 19 = Response byte (as seen in PCAP)
        if (payload.length >= 7 && payload[0] === 0x19) {
            const dataLen = payload[6];
            if (payload.length >= 7 + 3 + (dataLen - 3)) {
                const id = payload[9]; 
                
                if (payload[7] === 0x00 && payload[8] === 0x00) {
                    const dataBytes = payload.slice(10, 10 + (dataLen - 3));
                    this.mapParameter(id, dataBytes);
                }
            }
        }
    }

    mapParameter(id, dataBytes) {
        // Prepare different reading formats
        let valueLE = 0;
        let valueBE = 0;
        
        for (let i = 0; i < dataBytes.length; i++) {
            valueLE = (valueLE | (dataBytes[i] << (i * 8))) >>> 0;
            valueBE = ((valueBE << 8) | dataBytes[i]) >>> 0;
        }
        
        let hexStr = dataBytes.toString('hex').toUpperCase();

        switch (id) {
            case 4:
                // ID 4 is consistently 000004d4 in both TX and RX
                // Big Endian: 1236 -> 12.36V (Power Supply Voltage)
                this.latestData.supply_voltage_v = valueBE / 100.0;
                break;
            case 7:
                if (this.isTx) {
                    // Lower 16-bit = Forward Power, Upper 16-bit = Reverse Power
                    this.latestData.fwd_power_w = valueLE & 0xFFFF; 
                    this.latestData.refl_power_w = (valueLE >>> 16) & 0xFFFF;
                } else {
                    this.latestData.rx_power_dbm = (valueLE & 0xFFFF) - 111; 
                }
                break;
            case 29:
                this.latestData.frequency_mhz = valueLE / 1000.0;
                break;
            case 45:
                this.latestData.squelch_dbm = valueLE;
                break;
            case 48:
                this.latestData.sensitivity_dbm = valueLE;
                break;
            case 104:
                this.latestData.rssi_dbm = valueLE;
                break;
            default:
                // Hide unknown parameters from the UI by prefixing with underscore
                this.latestData[`_raw_id_${id}`] = valueLE;
                this.latestData[`_hex_id_${id}`] = hexStr;
                break;
        }
        this.latestData._status = 'Normal';
    }
}

// Ekspor kelas dan konstanta untuk timer Polling di NetworkListener
module.exports = OteDtr100Parser;
module.exports.POLL_INTERVAL = 3000; // Poll setiap 3 detik di mode ACTIVE
module.exports.POLL_REQ_DELAY = 100; // Jeda 100ms antar command ID
