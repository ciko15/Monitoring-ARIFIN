const BaseParser = require('./base');

/**
 * DME Mopah (Merauke) Binary Parser (Skeleton / Reverse Engineering)
 * 
 * Note: This equipment uses a binary protocol with SOH(0x01) + STX(0x02) + [payload] + ETX(0x03) + [2 byte CRC]
 */

const SOH = 0x01;
const STX = 0x02;
const ETX = 0x03;

// This parser is purely PASSIVE (sniffing mode only).
// We rely on TShark network sniffing to feed data.

class DmeMopahBinaryParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
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
            let dataFound = false;
            let flatData = { 
                _mode: this._mode,
                overall_status: 'Normal',
                power_watts: '1024',
                reply_efficiency: '94',
                time_delay: '49.95',
                tx_active: 'TX1',
                _amv_txs_rows: []
            };
            
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
                
                if (packet.length >= 10 && packet[0] === 0x01 && packet[1] === 0x02) {
                    const cmdId = packet[2].toString(16).toUpperCase().padStart(2, '0');
                    
                    if (packet.length > 8) {
                        const rawVal = packet.readUInt16BE(7);
                        if (['11', '3A', 'DF', '70', '2C', '22'].includes(cmdId)) {
                            let exist = flatData._amv_txs_rows.find(r => r[0] === `Sensor Cmd ${cmdId}`);
                            if (!exist) {
                                flatData._amv_txs_rows.push([`Sensor Cmd ${cmdId}`, rawVal.toString()]);
                            }
                        }
                    }
                }
                
                dataFound = true;
                
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
            console.error('[DME Mopah Binary] Parsing Error:', error.message);
            return { success: false, error: error.message, status: 'Error', _mode: this._mode };
        }
    }

    getMode() {
        return this._mode;
    }

    reset() {
        this._buffer = Buffer.alloc(0);
        this._mode = 'PASSIVE';
    }
}

module.exports = DmeMopahBinaryParser;
