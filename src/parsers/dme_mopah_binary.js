const BaseParser = require('./base');

/**
 * DME Mopah (Merauke) Binary Parser (Skeleton / Reverse Engineering)
 * 
 * Note: This equipment uses a binary protocol with SOH(0x01) + STX(0x02) + [payload] + ETX(0x03) + [2 byte CRC]
 */

const SOH = 0x01;
const STX = 0x02;
const ETX = 0x03;

// Active polling request bytes based on Wireshark captures (DME Trigger - 17 bytes)
const POLL_REQUESTS = [
    { bytes: Buffer.from([0x01, 0x02, 0x1D, 0x39, 0x08, 0x8F, 0x06, 0x09, 0xE4, 0x1D, 0x4F, 0x01, 0x01, 0x01, 0x03, 0xF0, 0x2B]), tag: 'PAGE_A' }
];

const PASSIVE_TIMEOUT  = 30000;
const POLL_INTERVAL    = 2000;
const POLL_REQ_DELAY   = 200;

class DmeMopahBinaryParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._lastDataTime = Date.now();
        this._mode = 'PASSIVE';
        this._buffer = Buffer.alloc(0);
    }

    parse(rawData) {
        try {
            const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buffer = Buffer.concat([this._buffer, buf]);

            // Keep buffer size manageable
            if (this._buffer.length > 65536) {
                this._buffer = this._buffer.slice(-32768);
            }

            const now = Date.now();
            if (now - this._lastDataTime > PASSIVE_TIMEOUT && this._mode === 'PASSIVE') {
                this._mode = 'ACTIVE';
                console.log('[DME Mopah Binary] No data for 30s — switching to ACTIVE polling mode');
            }

            let dataFound = false;
            let flatData = { _mode: this._mode };
            
            // Mencari pola SOH(0x01) ... ETX(0x03) + 2 Bytes Checksum
            while (this._buffer.length >= 12) { 
                const startIdx = this._buffer.indexOf(SOH);
                if (startIdx === -1) {
                    this._buffer = Buffer.alloc(0); 
                    break;
                }
                
                if (startIdx > 0) {
                    this._buffer = this._buffer.slice(startIdx);
                }

                const etxIdx = this._buffer.indexOf(ETX);
                if (etxIdx === -1) {
                    break; // Tunggu chunk berikutnya
                }

                if (this._buffer.length < etxIdx + 3) {
                    break; // Tunggu sisa checksum
                }

                const packetLength = etxIdx + 3;
                const packet = this._buffer.slice(0, packetLength);
                
                // ==========================================
                // REVERSE ENGINEERING (MOPAH DME)
                // ==========================================
                let hexStr = packet.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
                console.log(`\n[DME Mopah Binary] Packet (Len=${packet.length}):`, hexStr);
                
                // Coba tebak beberapa ID yang sering muncul di Wireshark
                const cmdId = packet.length >= 4 ? packet.toString('hex', 2, 3) : '';
                
                // Ini hanya skeleton. Kita bisa tambahkan logika:
                // if (cmdId === 'e3') { flatData.some_param = packet.readUInt16BE(4); }
                
                dataFound = true;
                this._lastDataTime = now;
                
                if (this._mode === 'ACTIVE') {
                    this._mode = 'PASSIVE';
                }

                this._buffer = this._buffer.slice(packetLength);
            }

            if (!dataFound) {
                return { success: false, error: 'Waiting for complete binary packet', status: 'Waiting', _mode: this._mode };
            }

            return {
                success: true,
                data: flatData,
                status: 'Normal'
            };

        } catch (error) {
            console.error(`[DME Mopah Binary] Parse error: ${error.message}`);
            return { success: false, error: error.message, status: 'Error', _mode: this._mode };
        }
    }

    getMode() { return this._mode; }
    getPollRequests() { return POLL_REQUESTS; }
    reset() {
        this._buffer = Buffer.alloc(0);
        this._mode = 'ACTIVE';
        this._lastDataTime = 0;
    }
}

module.exports = DmeMopahBinaryParser;
module.exports.POLL_REQUESTS  = POLL_REQUESTS;
module.exports.POLL_INTERVAL  = POLL_INTERVAL;
module.exports.POLL_REQ_DELAY = POLL_REQ_DELAY;
