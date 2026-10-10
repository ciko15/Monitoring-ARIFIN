const BaseParser = require('./base');

/**
 * ILS Glide Path (GP) Parser — Normarc
 *
 * Hasil analisa live log dan PCAP GP.pcap:
 * - GP device mengirim stream data berisi 7E 7E 7E markers sebagai frame boundaries
 * - Address byte bervariasi: 0x08, 0x16, 0x22, dll tergantung segment query
 * - Data frame di-embed di antara dua 7E 7E 7E headers
 *
 * Format frame (dari LLZ raw frame yang menangkap GP): 7E7E7E 08 C1 00 03F4 01A6 0083...
 * [0-2] = 7E 7E 7E (header)
 * [3]   = address byte
 * [4-5] = C1 00 (status/length)
 * [6-7] = Mon1 RF Level (UInt16 BE, /10 = %)  -> 0x03F4 = 1012/10 = 101.2%
 * [8-9] = Mon1 DDM (UInt16 BE, /10)           -> 0x01A6 = 422/10 = 42.2
 * [10-11] = Mon2 RF Level                     -> 0x0083 = 131/10 = 13.1%
 * [12-13] = Mon2 DDM                          -> 0x0020 = 32/10 = 3.2
 * [14-15] = SDM                               -> 0x0326 = 806/10 = 80.6
 */

// Trigger polling ke GP — dari PCAP: 7E 7E 7E 22 04 00 (address 0x22)
const TRIGGER_SEND = Buffer.from([0x7E, 0x7E, 0x7E, 0x22, 0x04, 0x00, 0x98, 0x8E, 0xE4, 0xA0]);

class IlsGpNormacParser extends BaseParser {
    constructor(config) {
        super(config);
        this.buffer = Buffer.alloc(0);
    }

    getPollRequests() {
        console.log(`[Normarc GP] getPollRequests called. Sending: ${TRIGGER_SEND.toString('hex')}`);
        return [{ name: 'GP_STATUS_REQ', bytes: TRIGGER_SEND }];
    }

    isHeartbeat(chunk) { return false; }
    getHeartbeatReply() { return Buffer.alloc(0); }

    parse(rawData) {
        if (!Buffer.isBuffer(rawData)) return null;

        this.buffer = Buffer.concat([this.buffer, rawData]);
        console.log(`[Normarc GP] Menerima data: ${rawData.length} bytes -> ${rawData.toString('hex').toUpperCase()}`);

        const parsedResult = {
            raw_hex: '', status: 'Normal', frame_type: 'Unknown',
            tx_main_label: '1 MAIN', tx_stby_label: '2 STBY',
            tx_data: 'Local', status_label: 'Normal',
            crs_pos_rf_level: null, crs_pos_ddm: null, crs_pos_sdm: null,
            crs_width_rf_level: null, crs_width_ddm: null, crs_width_sdm: null,
            clr_width_rf_level: null, clr_width_ddm: null, clr_width_sdm: null,
            nearfield_pos_rf: null, nearfield_pos_ddm: null,
            monitor_power: null, gp_angle: null
        };

        const header = Buffer.from([0x7E, 0x7E, 0x7E]);

        // Cari header 7E 7E 7E pertama
        let hdlcIndex = this.buffer.indexOf(header);

        if (hdlcIndex === -1) {
            // Tidak ada header sama sekali, buang data garbage
            if (this.buffer.length > 512) {
                console.log(`[Normarc GP] Tidak ada header 7E7E7E dalam ${this.buffer.length} bytes, membuang garbage...`);
                this.buffer = Buffer.alloc(0);
            }
            return { success: false, error: 'Tunggu data lengkap...' };
        }

        // Buang semua data sebelum header pertama (ini adalah sisa frame lama / garbage)
        if (hdlcIndex > 0) {
            console.log(`[Normarc GP] Membuang ${hdlcIndex} bytes garbage sebelum header 7E7E7E`);
            this.buffer = this.buffer.subarray(hdlcIndex);
        }

        // Cari header BERIKUTNYA (menandai akhir frame saat ini)
        const nextHdlcIndex = this.buffer.indexOf(header, 3);

        if (nextHdlcIndex === -1) {
            // Hanya ada satu header, tunggu lebih banyak data
            // Batasi buffer agar tidak terlalu besar
            if (this.buffer.length > 4096) {
                console.warn(`[Normarc GP] Buffer ${this.buffer.length} bytes tanpa frame lengkap, reset...`);
                this.buffer = Buffer.alloc(0);
            }
            return { success: false, error: 'Tunggu data lengkap...' };
        }

        // Ekstrak frame yang lengkap (dari 7E7E7E pertama sampai sebelum 7E7E7E berikutnya)
        const frameSize = nextHdlcIndex;
        const validPacket = this.buffer.subarray(0, frameSize);

        // Konsumsi frame ini dari buffer, sisakan mulai dari header berikutnya
        this.buffer = this.buffer.subarray(nextHdlcIndex);

        if (validPacket.length < 6) {
            return { success: false, error: 'Frame terlalu pendek...' };
        }

        parsedResult.frame_type = `GP_${frameSize}`;
        parsedResult.raw_hex = validPacket.toString('hex').toUpperCase();

        try {
            // Byte [4] = C1 (status flags)
            const statusByte = validPacket[4] || 0;
            const isTx2Main = (statusByte & 0x80) !== 0; // bit7 = TX2 main
            parsedResult.tx_main_label = isTx2Main ? '2 MAIN' : '1 MAIN';
            parsedResult.tx_stby_label = isTx2Main ? '1 STBY' : '2 STBY';

            // Data monitoring mulai dari offset 6 (setelah 7E7E7E + addr + 2 status bytes)
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

            // SDM / GP Angle jika frame cukup panjang
            if (validPacket.length >= 16) {
                const sdm = validPacket.readUInt16BE(14);
                if (sdm > 0 && sdm < 10000)
                    parsedResult.crs_pos_sdm = parseFloat((sdm / 10.0).toFixed(1));
            }
            if (validPacket.length >= 20) {
                const rawAngle = validPacket.readUInt16BE(18);
                if (rawAngle > 100 && rawAngle < 500)
                    parsedResult.gp_angle = parseFloat((rawAngle / 100.0).toFixed(2));
            }

        } catch (e) {
            console.error(`[Normarc GP] Gagal ekstrak data:`, e.message);
        }

        console.log(`[Normarc GP] Raw Frame [${frameSize}]: ${parsedResult.raw_hex.substring(0, 80)}...`);
        const alarmResult = this.checkAlarms(parsedResult);
        return {
            success: true,
            data: parsedResult,
            status: alarmResult.status,
            alarms: alarmResult.alarms,
            warnings: alarmResult.warnings
        };
    }
}

module.exports = IlsGpNormacParser;
