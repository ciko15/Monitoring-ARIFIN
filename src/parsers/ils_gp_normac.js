const BaseParser = require('./base');

/**
 * ILS Glide Path (GP) Parser — Normarc
 * 
 * Supports parsing of HDLC-framed (7E 7E 7E...) packets and binary stream.
 * Struktur sama dengan LLZ: fixed 44-byte frame setelah header 7E 7E 7E.
 * 
 * Dari log live BIAK: GP mengirim frame dengan address byte 0x08
 * Dari PCAP GP.pcap: GP di 192.168.127.20 menggunakan trigger 7E 7E 7E 22 04 00
 */

// Hex trigger from sniffing PCAP GP — address byte 0x22
const TRIGGER_SEND = Buffer.from([0x7E, 0x7E, 0x7E, 0x22, 0x04, 0x00, 0x98, 0x8E, 0xE4, 0xA0]);

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
            // Field names HARUS sesuai dengan templates_config.json: ils_gp_normac
            tx_main_label: '1 MAIN',
            tx_stby_label: '2 STBY',
            tx_data: 'Local',
            status_label: 'Normal',
            // Parameter monitoring GP (nama field sesuai template)
            rf_level: null,         // CRS Pos. RF Level
            crs_ddm: null,          // CRS Pos. DDM
            crs_sdm: null,          // CRS Pos. SDM
            crs_width_rf: null,     // CRS Width RF Level
            crs_width_ddm: null,    // CRS Width DDM
            crs_width_sdm: null,    // CRS Width SDM
            clr_rf: null,           // CLR Width RF Level
            clr_ddm: null,          // CLR Width DDM
            clr_sdm: null,          // CLR Width SDM
            nearfield_pos_rf: null, // Nearfield Pos. RF
            nearfield_pos_ddm: null,// Nearfield Pos. DDM
            monitor_power: null,    // Monitor Power
            gp_angle: null          // GP Angle
        };

        // Header NM7000 GP status frame diawali 7E 7E 7E. Byte ke-4 adalah address yang bisa berbeda (08, 16, 22 dll).
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
            parsedResult.frame_type = `NORMARC_GP_${frameSize}`;
            parsedResult.raw_hex = validPacket.toString('hex').toUpperCase();

            // Ekstrak parameter penting (Big Endian, sama seperti Indra GP format)
            try {
                // Byte [4] = C1 (status byte) — bit7 = TX2 main
                const statusByte = validPacket[4];
                const isTx2Main = (statusByte & 0x80) !== 0;
                parsedResult.tx_main_label = isTx2Main ? '2 MAIN' : '1 MAIN';
                parsedResult.tx_stby_label = isTx2Main ? '1 STBY' : '2 STBY';
                parsedResult.status_label = 'Normal';
                parsedResult.tx_data = 'Local';

                // Data monitoring GP mulai offset 6 (BE UInt16, /10)
                // Dari log live: 7E7E7E 08 C1 00 03F4 01A6 0083 0020 0326 00C8...
                // offset 6-7 = 03F4 = 1012 -> 101.2 (CRS RF Level %)
                // offset 8-9 = 01A6 = 422  -> 42.2  (CRS DDM)
                // offset 10-11 = 0083 = 131 -> 13.1  (CRS Width RF)
                // offset 12-13 = 0020 = 32  -> 3.2   (CRS Width DDM)
                // offset 14-15 = 0326 = 806 -> 80.6  (CRS SDM)
                // offset 16-17 = 00C8 = 200 -> 20.0  (GP Angle x100 = 2.0 deg? or another param)
                if (validPacket.length >= 14) {
                    const mon1_rf  = validPacket.readUInt16BE(6);
                    const mon1_ddm = validPacket.readUInt16BE(8);
                    const mon2_rf  = validPacket.readUInt16BE(10);
                    const mon2_ddm = validPacket.readUInt16BE(12);

                    if (mon1_rf > 0 && mon1_rf < 30000)
                        parsedResult.crs_pos_rf_level = parseFloat((mon1_rf / 10.0).toFixed(1));
                    if (mon1_ddm < 10000)
                        parsedResult.crs_pos_ddm = parseFloat((mon1_ddm / 10.0).toFixed(1));
                    if (mon2_rf > 0 && mon2_rf < 30000)
                        parsedResult.crs_width_rf_level = parseFloat((mon2_rf / 10.0).toFixed(1));
                    if (mon2_ddm < 10000)
                        parsedResult.crs_width_ddm = parseFloat((mon2_ddm / 10.0).toFixed(1));
                }

                if (validPacket.length >= 18) {
                    const sdm = validPacket.readUInt16BE(14);
                    if (sdm > 0 && sdm < 10000)
                        parsedResult.crs_pos_sdm = parseFloat((sdm / 10.0).toFixed(1));

                    const rawAngle = validPacket.readUInt16BE(16);
                    if (rawAngle > 100 && rawAngle < 500)
                        parsedResult.gp_angle = parseFloat((rawAngle / 100.0).toFixed(2));
                }

            } catch (e) {
                console.error(`[Normarc GP Parser] Gagal mengekstrak offset:`, e.message);
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
