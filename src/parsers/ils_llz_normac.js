const BaseParser = require('./base');

/**
 * ILS Glide Path (GP) Parser — Normarc
 * 
 * Supports parsing of HDLC-framed (7E 7E 7E...) packets and binary stream.
 */

// Hex trigger from sniffing
const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]); // Adjust if Normarc needs a different trigger

class IlsLlzNormacParser extends BaseParser {
    constructor(config) {
        super(config);
        
        // Buat buffer internal untuk menangani potongan-potongan TCP packet
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Polling mechanism support
     */
    getPollRequests() {
        console.log(`[Normarc GP] getPollRequests called. Sending trigger: ${TRIGGER_SEND.toString('hex')}`);
        return [
            { name: 'GP_STATUS_REQ', bytes: TRIGGER_SEND }
        ];
    }

    isHeartbeat(chunk) {
        // Implement logic if device sends specific heartbeat packets
        // For now, return false to just parse everything
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

        // Tambahkan data baru ke internal buffer
        this.buffer = Buffer.concat([this.buffer, rawData]);
        console.log(`[Normarc GP] Menerima data: ${rawData.length} bytes -> ${rawData.toString('hex').toUpperCase()}`);

        const parsedResult = {
            raw_hex: '',
            status: 'Normal',
            frame_type: 'Unknown',
            // Default parameters (akan di-mapping manual nanti)
            crs_ddm: null,
            crs_sdm: null,
            clr_ddm: null,
            clr_sdm: null,
            rf_level: null
        };

        // Cari index Frame yang umum
        const hdlcIndex = this.buffer.indexOf(Buffer.from([0x7E, 0x7E, 0x7E]));
        const start01Index = this.buffer.indexOf(Buffer.from([0x01]));
        
        let validPacket = null;
        let startIndex = -1;
        let frameSize = 204; // Untuk LLZ Normarc, paket HDLC utamanya berukuran 204 bytes

        if (hdlcIndex !== -1 && this.buffer.length >= hdlcIndex + frameSize) {
            startIndex = hdlcIndex;
            validPacket = this.buffer.subarray(startIndex, startIndex + frameSize);
        } else if (start01Index !== -1 && this.buffer.length >= start01Index + 95) {
            startIndex = start01Index;
            frameSize = 95;
            validPacket = this.buffer.subarray(startIndex, startIndex + frameSize);
        }

        if (validPacket) {
            parsedResult.frame_type = `NORMARC_${frameSize}`;
            parsedResult.raw_hex = validPacket.toString('hex').toUpperCase();

            // Ekstrak parameter penting
            try {
                // Posisi offset disesuaikan dengan struktur payload 204 byte
                let offset = frameSize === 204 ? 40 : 24; 
                
                parsedResult.DDM_COURSE = null;
                parsedResult.SDM_COURSE = null;
                parsedResult.DDM_CLR = null;
                parsedResult.CLR_SDM = null;
                
                // RF Power
                parsedResult.RF_POWER = null;
                
                parsedResult.tx_main_label = '1 MAIN';
                parsedResult.tx_stby_label = '2 STBY';
                parsedResult.status_label = 'Normal';
                parsedResult.tx_data = 'Local';

            } catch (e) {
                console.error(`[Normarc Parser] Gagal mengekstrak offset:`, e.message);
            }

            // Hapus paket yang sudah diproses dari buffer
            this.buffer = this.buffer.subarray(startIndex + frameSize);
            
            console.log(`[Normarc] Raw Frame [${frameSize}]: ${parsedResult.raw_hex}`);
            const alarmResult = this.checkAlarms(parsedResult);
            return {
                success: true,
                data: parsedResult,
                status: alarmResult.status,
                alarms: alarmResult.alarms,
                warnings: alarmResult.warnings
            };
        }

        // Cegah memory leak jika buffer tidak berisi frame yang dikenali
        if (this.buffer.length > 2048) {
            this.buffer = Buffer.alloc(0);
        }

        return { success: false, error: 'Tunggu data lengkap...' };
    }
}

module.exports = IlsLlzNormacParser;
