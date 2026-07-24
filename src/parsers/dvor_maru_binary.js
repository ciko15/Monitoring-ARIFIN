const BaseParser = require('./base');

/**
 * DVOR Maru Binary Parser (Skeleton / Reverse Engineering)
 * Location: Merauke
 * 
 * Note: This equipment uses a binary protocol with SOH(0x01) + STX(0x02) + [7 byte payload] + ETX(0x03) + [2 byte CRC]
 */

const SOH = 0x01;
const STX = 0x02;
const ETX = 0x03;

// Active polling request bytes based on Wireshark captures
const POLL_REQUESTS = [
    // Trigger 1 (e.g., Request Page A)
    { bytes: Buffer.from([0x01, 0x02, 0xC5, 0x35, 0x17, 0x8B, 0x1A, 0x0E, 0x01, 0x03, 0xAB, 0x39]), tag: 'PAGE_A' },
    // Trigger 2 (e.g., Request Page B)
    { bytes: Buffer.from([0x01, 0x02, 0xA6, 0x35, 0x17, 0x8B, 0x1A, 0x0E, 0x01, 0x03, 0x66, 0x7C]), tag: 'PAGE_B' },
];

const PASSIVE_TIMEOUT  = 30000;
const POLL_INTERVAL    = 2000;
const POLL_REQ_DELAY   = 200;

class DvorMaruBinaryParser extends BaseParser {
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
                console.log('[DVOR Maru Binary] No data for 30s — switching to ACTIVE polling mode');
            }

            // --- Packet Extraction Logic (Skeleton) ---
            let dataFound = false;
            let flatData = { _mode: this._mode };
            
            // Mencari pola SOH(0x01) ... ETX(0x03) + 2 Bytes Checksum
            while (this._buffer.length >= 12) { // Minimal ukuran paket
                const startIdx = this._buffer.indexOf(SOH);
                if (startIdx === -1) {
                    this._buffer = Buffer.alloc(0); // Buang jika tidak ada awalan
                    break;
                }
                
                // Buang sampah di depan SOH
                if (startIdx > 0) {
                    this._buffer = this._buffer.slice(startIdx);
                }

                const etxIdx = this._buffer.indexOf(ETX);
                if (etxIdx === -1) {
                    // Paket belum lengkap, tunggu chunk berikutnya
                    break;
                }

                // Kita butuh 2 byte lagi setelah ETX untuk Checksum
                if (this._buffer.length < etxIdx + 3) {
                    break; // Tunggu sisa checksum
                }

                const packetLength = etxIdx + 3;
                const packet = this._buffer.slice(0, packetLength);
                
                // ==========================================
                // TODO: Lakukan Parsing di sini
                // ==========================================
                console.log(`\n[DVOR Maru Binary] Ditemukan Paket (Len=${packet.length}):`, packet.toString('hex').toUpperCase());
                
                if (packet.length === 17) {
                    console.log('-> Ini kemungkinan balasan status/ACK (17 bytes)');
                    flatData.last_ack_hex = packet.toString('hex');
                } else if (packet.length > 100) {
                    console.log(`-> Ini kemungkinan data parameter (${packet.length} bytes)`);
                    
                    // Contoh Extract Data (Ini hanya simulasi, harus dicocokkan dengan manual!)
                    // flatData.rf_power = packet.readUInt16BE(10) / 100;
                    // flatData.azimuth  = packet.readUInt16BE(12) / 100;
                }
                
                // ==========================================

                dataFound = true;
                this._lastDataTime = now;
                
                // Switch kembali ke mode pasif jika mendapat data
                if (this._mode === 'ACTIVE') {
                    this._mode = 'PASSIVE';
                    console.log('[DVOR Maru Binary] Data diterima — switching back to PASSIVE mode');
                }

                // Majukan buffer
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
            console.error(`[DVOR Maru Binary] Parse error: ${error.message}`);
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

module.exports = DvorMaruBinaryParser;
module.exports.POLL_REQUESTS  = POLL_REQUESTS;
module.exports.POLL_INTERVAL  = POLL_INTERVAL;
module.exports.POLL_REQ_DELAY = POLL_REQ_DELAY;
