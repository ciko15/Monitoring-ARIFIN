const BaseParser = require('./base');

/**
 * ILS Glide Path (GP) Parser — Normarc
 * 
 * Supports parsing of HDLC-framed (7E 7E 7E...) packets and binary stream.
 */

// Hex trigger from sniffing
const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]); // Adjust if Normarc needs a different trigger

class IlsGpNormacParser extends BaseParser {
    constructor(config) {
        super(config);
        
        // Buat buffer internal untuk menangani potongan-potongan TCP packet
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Polling mechanism support
     */
    getPollRequests() {
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

        // Deteksi HDLC Frame (dimulai dengan 7E 7E)
        const hdlcIndex = this.buffer.indexOf(Buffer.from([0x7E, 0x7E]));
        
        if (hdlcIndex !== -1) {
            // Kita menemukan frame HDLC
            if (this.buffer.length >= hdlcIndex + 104) {
                // Potong 104 byte paket
                const packet = this.buffer.subarray(hdlcIndex, hdlcIndex + 104);
                
                parsedResult.frame_type = 'HDLC_104';
                parsedResult.raw_hex = packet.toString('hex').toUpperCase();

                // TODO: Ekstrak parameter dari offset byte tertentu
                // Contoh: parsedResult.crs_ddm = this.extractField(packet, { byte_offset: 20, length: 4, type: 'float' });

                // Hapus paket yang sudah diproses dari buffer
                this.buffer = this.buffer.subarray(hdlcIndex + 104);
                
                return this.checkAlarms(parsedResult);
            }
        } 
        // Cek paket format kedua (dimulai dengan 01 1F 00 ...)
        else if (this.buffer.length >= 95) {
             // Potong 95 byte paket
             const packet = this.buffer.subarray(0, 95);
             parsedResult.frame_type = 'BINARY_95';
             parsedResult.raw_hex = packet.toString('hex').toUpperCase();

             // Hapus dari buffer
             this.buffer = this.buffer.subarray(95);

             return this.checkAlarms(parsedResult);
        }

        // Jika data belum lengkap, simpan di buffer dan tunggu data selanjutnya
        if (this.buffer.length > 2048) {
            // Cegah memory leak jika buffer terlalu besar dan tidak ada frame yang valid
            this.buffer = Buffer.alloc(0);
        }

        return null; // Return null jika frame belum utuh
    }
}

module.exports = IlsGpNormacParser;
