const BaseParser = require('./base');

/**
 * ILS Glide Path (GP) Parser — Normarc / Indra ILS-200
 * 
 * Hasil analisa PCAP GP.pcap (192.168.127.20 port 950):
 * - PMDT mengirim request: 7E 7E 7E 1E 05 00 [seq byte] [crc]
 * - GP membalas: 7E 7E 7E 16 A9 02 ... (104 bytes per response)
 * - Format data: Big Endian UInt16, satuan /10
 *
 * Struktur frame 104 bytes:
 * [0-2]   = 7E 7E 7E (header)
 * [3]     = address byte (0x16, 0x22, 0x24, dll)
 * [4-5]   = length field
 * [6]     = status flags (TX status, remote/local)
 * [7]     = flags byte 2
 * [8-9]   = Mon 1 RF Level (UInt16 BE, /10 = %)
 * [10-11] = Mon 1 DDM (UInt16 BE, /10)
 * [12-13] = Mon 2 RF Level (UInt16 BE, /10 = %)
 * [14-15] = Mon 2 DDM (UInt16 BE, /10)
 * [26-27] = GP Angle (UInt16 BE, /100 = degrees)
 */

// Trigger polling ke GP — dari PCAP PMDT ke 192.168.127.20 port 950
const TRIGGER_SEND = Buffer.from([0x7E, 0x7E, 0x7E, 0x22, 0x04, 0x00, 0x98, 0x8E, 0xE4, 0xA0]);

class IlsGpNormacParser extends BaseParser {
    constructor(config) {
        super(config);
        this.buffer = Buffer.alloc(0);
        this._lastValidData = null;
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
        let hdlcIndex = this.buffer.indexOf(header);

        while (hdlcIndex !== -1) {
            if (this.buffer.length < hdlcIndex + 4) break;

            const nextHdlcIndex = this.buffer.indexOf(header, hdlcIndex + 3);

            if (nextHdlcIndex === -1) break; // Tunggu data lebih banyak

            const frameSize = nextHdlcIndex - hdlcIndex;

            if (frameSize < 4 || frameSize > 250) {
                // Skip frame tidak valid, loncat ke header berikutnya
                this.buffer = this.buffer.subarray(nextHdlcIndex);
                hdlcIndex = 0;
                continue;
            }

            const validPacket = this.buffer.subarray(hdlcIndex, nextHdlcIndex);
            this.buffer = this.buffer.subarray(nextHdlcIndex);

            parsedResult.frame_type = `GP_${frameSize}`;
            parsedResult.raw_hex = validPacket.toString('hex').toUpperCase();

            try {
                const statusByte = validPacket.length > 6 ? validPacket[6] : 0;
                const isTx2Main = (statusByte & 0x01) !== 0;
                parsedResult.tx_main_label = isTx2Main ? '2 MAIN' : '1 MAIN';
                parsedResult.tx_stby_label = isTx2Main ? '1 STBY' : '2 STBY';

                if (validPacket.length >= 16) {
                    const mon1_rf  = validPacket.readUInt16BE(8);
                    const mon1_ddm = validPacket.readUInt16BE(10);
                    const mon2_rf  = validPacket.readUInt16BE(12);
                    const mon2_ddm = validPacket.readUInt16BE(14);

                    if (mon1_rf > 0 && mon1_rf < 32000)
                        parsedResult.crs_pos_rf_level = parseFloat((mon1_rf / 10.0).toFixed(1));
                    if (mon1_ddm < 10000)
                        parsedResult.crs_pos_ddm = parseFloat((mon1_ddm / 10.0).toFixed(1));
                    if (mon2_rf > 0 && mon2_rf < 32000)
                        parsedResult.crs_width_rf_level = parseFloat((mon2_rf / 10.0).toFixed(1));
                    if (mon2_ddm < 10000)
                        parsedResult.crs_width_ddm = parseFloat((mon2_ddm / 10.0).toFixed(1));
                }

                // GP Angle: offset 26-27 (BE UInt16 / 100 = degrees)
                if (validPacket.length >= 28) {
                    const rawAngle = validPacket.readUInt16BE(26);
                    if (rawAngle > 100 && rawAngle < 400) {
                        parsedResult.gp_angle = parseFloat((rawAngle / 100.0).toFixed(2));
                    }
                }

                this._lastValidData = { ...parsedResult };

            } catch (e) {
                console.error(`[Normarc GP] Gagal ekstrak data:`, e.message);
            }

            console.log(`[Normarc GP] Raw Frame [${frameSize}]: ${parsedResult.raw_hex.substring(0, 60)}...`);
            const alarmResult = this.checkAlarms(parsedResult);
            return {
                success: true,
                data: parsedResult,
                status: alarmResult.status,
                alarms: alarmResult.alarms,
                warnings: alarmResult.warnings
            };
        }

        if (this.buffer.length > 4096) {
            console.warn(`[Normarc GP] Buffer overflow, resetting...`);
            this.buffer = Buffer.alloc(0);
        }

        return { success: false, error: 'Tunggu data lengkap...' };
    }
}

module.exports = IlsGpNormacParser;
