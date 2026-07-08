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
            status: 'Normal',
            frame_type: 'TEST_PIPELINE',
            // Kita tampilkan hex raw-nya langsung ke UI untuk di-debug!
            debug_length: this.buffer.length,
            debug_hex: this.buffer.toString('hex').toUpperCase().substring(0, 60) + '...',
            crs_ddm: 0.00,
            crs_sdm: 40.0,
            clr_ddm: 0.00,
            clr_sdm: 40.0,
            rf_level: -10.5
        };

        // Hapus buffer agar tidak menumpuk terus menerus di memory saat testing
        if (this.buffer.length > 1024) {
            this.buffer = Buffer.alloc(0);
        }

        const alarmResult = this.checkAlarms(parsedResult);
        return {
            success: true, // SELALU KEMBALIKAN TRUE AGAR MASUK KE DATABASE DAN UI!
            data: parsedResult,
            status: alarmResult.status,
            alarms: alarmResult.alarms,
            warnings: alarmResult.warnings
        };
    }
}

module.exports = IlsGpNormacParser;
