const BaseParser = require('./base');

/**
 * ILS Glide Path (GP) Parser — Normarc
 * 
 * Supports parsing of HDLC-framed (7E 7E 7E...) packets and binary stream.
 */

// Hex trigger from sniffing PCAP (sama dengan MM dan LLZ)
const TRIGGER_SEND = Buffer.from([0x7E, 0x7E, 0x7E, 0x01, 0x04, 0x00, 0x21, 0x76, 0xEF, 0x9A]);

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
        console.log(`[Normarc GP Parser] Menerima data dari alat: ${rawData.length} bytes -> ${rawData.toString('hex').toUpperCase()}`);

        const parsedResult = {
            raw_hex: '',
            status: 'Normal',
            frame_type: 'Unknown',
            // Parameter lengkap sesuai tampilan enhancement (default null sementara)
            crs_pos_rf_level: null,
            crs_pos_ddm: null,
            crs_pos_sdm: null,
            crs_width_rf_level: null,
            crs_width_ddm: null,
            crs_width_sdm: null,
            clr_width_rf_level: null,
            clr_width_ddm: null,
            clr_width_sdm: null,
            nearfield_pos_rf: null,
            nearfield_pos_ddm: null,
            monitor_power: null,
            gp_angle: null
        };

        // Header NM7000 LLZ/GP status frame diawali 7E 7E 7E. Byte ke-4 adalah address yang bisa berbeda (89, 81, 8A dll).
        const header = Buffer.from([0x7E, 0x7E, 0x7E]);
        const hdlcIndex = this.buffer.indexOf(header);
        
        let validPacket = null;
        let startIndex = -1;
        let frameSize = 44; 

        if (hdlcIndex !== -1 && this.buffer.length >= hdlcIndex + frameSize) {
            startIndex = hdlcIndex;
            validPacket = this.buffer.subarray(startIndex, startIndex + frameSize);
        }

        if (validPacket) {
            parsedResult.frame_type = `NORMARC_${frameSize}`;
            parsedResult.raw_hex = validPacket.toString('hex').toUpperCase();

            // Ekstrak parameter penting
            try {
                // Sesuai koneksi MM (Little Endian), dummy values for now
                parsedResult.csb_forward_power = validPacket.readUInt16LE(8) / 10.0;
                parsedResult.csb_reverse_power = validPacket.readUInt16LE(10) / 10.0;
                
                parsedResult.crs_pos_rf_level = parsedResult.csb_forward_power;
                parsedResult.crs_pos_ddm = null;
                parsedResult.crs_pos_sdm = null;
                parsedResult.crs_width_rf_level = null;
                parsedResult.crs_width_ddm = null;
                parsedResult.crs_width_sdm = null;
                parsedResult.clr_width_rf_level = null;
                parsedResult.clr_width_ddm = null;
                parsedResult.clr_width_sdm = null;
                parsedResult.nearfield_pos_rf = null;
                parsedResult.nearfield_pos_ddm = null;
                parsedResult.monitor_power = null;
                parsedResult.gp_angle = null;
                
                // TX Status
                const txStatusByte = validPacket[4]; // 0x26 atau lainnya
                const isTx2Main = (txStatusByte & 0x01) !== 0; 
                parsedResult.tx_main_label = isTx2Main ? '2 MAIN' : '1 MAIN';
                parsedResult.tx_stby_label = isTx2Main ? '1 STBY' : '2 STBY';
                parsedResult.status_label = 'Normal';
                parsedResult.tx_data = 'Local';

            } catch (e) {
                console.error(`[Normarc Parser] Gagal mengekstrak offset:`, e.message);
            }

            // Hapus paket yang sudah diproses dari buffer
            this.buffer = this.buffer.subarray(startIndex + frameSize);
            
            console.log(`[Normarc GP] Raw Frame [${frameSize}]: ${parsedResult.raw_hex}`);
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

module.exports = IlsGpNormacParser;
