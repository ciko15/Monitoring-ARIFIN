const BaseParser = require('./base');

/**
 * ILS Middle Marker (MM) Parser — Normarc
 * 
 * Supports parsing of HDLC-framed (7E 7E 7E...) packets and binary stream.
 * Deduced from PCAP analysis on port 950.
 */

// Hex trigger from sniffing PCAP
const TRIGGER_SEND = Buffer.from([0x7E, 0x7E, 0x7E, 0x01, 0x04, 0x00, 0x21, 0x76, 0xEF, 0x9A]);

class IlsMmNormacParser extends BaseParser {
    constructor(config) {
        super(config);
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Polling mechanism support
     */
    getPollRequests() {
        console.log(`[Normarc MM] getPollRequests called. Sending trigger: ${TRIGGER_SEND.toString('hex')}`);
        return [
            { name: 'MM_STATUS_REQ', bytes: TRIGGER_SEND }
        ];
    }

    isHeartbeat(chunk) {
        return false;
    }

    getHeartbeatReply() {
        return Buffer.alloc(0);
    }

    /**
     * Parse raw incoming data stream
     * @param {Buffer} rawData 
     */
    parse(rawData) {
        if (!Buffer.isBuffer(rawData)) return null;

        this.buffer = Buffer.concat([this.buffer, rawData]);
        console.log(`[Normarc MM] Menerima data: ${rawData.length} bytes -> ${rawData.toString('hex').toUpperCase()}`);

        const parsedResult = {
            raw_hex: '',
            status: 'Normal',
            frame_type: 'Unknown',
            // Default parameters (dapat disesuaikan nanti dengan tabel register)
            RF_POWER: null,
            tx_main_label: '1 MAIN',
            tx_stby_label: '2 STBY',
            status_label: 'Normal',
            tx_data: 'Local'
        };

        const hdlcIndex = this.buffer.indexOf(Buffer.from([0x7E, 0x7E, 0x7E]));
        
        let validPacket = null;
        let startIndex = -1;
        let frameSize = 44; // Berdasarkan analisa pcap, MM mengembalikan frame sebesar 44 bytes

        if (hdlcIndex !== -1 && this.buffer.length >= hdlcIndex + frameSize) {
            startIndex = hdlcIndex;
            validPacket = this.buffer.subarray(startIndex, startIndex + frameSize);
        }

        if (validPacket) {
            parsedResult.frame_type = `NORMARC_MM_${frameSize}`;
            parsedResult.raw_hex = validPacket.toString('hex').toUpperCase();

            // Ekstrak parameter penting berdasarkan struktur paket (Little Endian)
            try {
                // Berdasarkan analisa hex NM7050:
                // MON 1
                parsedResult.mon1_mod_depth = validPacket.readUInt16LE(5) / 10.0;
                parsedResult.mon1_keying = validPacket.readUInt16LE(7) === 1 ? 'On' : 'Off';
                parsedResult.mon1_rf_level = validPacket.readUInt16LE(12) / 1000.0;
                
                // MON 2
                parsedResult.mon2_mod_depth = validPacket.readUInt16LE(22) / 10.0;
                parsedResult.mon2_keying = validPacket.readUInt16LE(24) === 1 ? 'On' : 'Off';
                parsedResult.mon2_rf_level = validPacket.readUInt16LE(29) / 1000.0;

                // TX Status (asumsi sementara bit 1 pada byte 1)
                const txStatusByte = validPacket[1]; // 0x26
                const isTx2Main = (txStatusByte & 0x02) !== 0; 
                parsedResult.tx_main_label = isTx2Main ? '2 MAIN' : '1 MAIN';
                parsedResult.tx_stby_label = isTx2Main ? '1 STBY' : '2 STBY';
            } catch (e) {
                console.error(`[Normarc MM Parser] Gagal mengekstrak offset:`, e.message);
            }

            this.buffer = this.buffer.subarray(startIndex + frameSize);
            
            console.log(`[Normarc MM] Raw Frame [${frameSize}]: ${parsedResult.raw_hex}`);
            const alarmResult = this.checkAlarms(parsedResult);
            return {
                success: true,
                data: parsedResult,
                status: alarmResult.status,
                alarms: alarmResult.alarms,
                warnings: alarmResult.warnings
            };
        }

        if (this.buffer.length > 2048) {
            this.buffer = Buffer.alloc(0);
        }

        return { success: false, error: 'Tunggu data lengkap...' };
    }
}

module.exports = IlsMmNormacParser;
