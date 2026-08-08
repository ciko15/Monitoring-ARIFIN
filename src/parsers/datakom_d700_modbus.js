const BaseParser = require('./base');

/**
 * Datakom D700 Modbus TCP Parser
 * Membaca 8 Holding Registers dari alamat 0.
 *
 * Mapping Register:
 * 0: Voltage (Scale 10)
 * 1: Current (Scale 10)
 * 2: Frequency (Scale 100)
 * 3: Power (Scale 10)
 * 4: PowerFactor (Scale 1000)
 * 5: Energy (Scale 10)
 * 6: Load (Scale 10)
 * 7: Alarm (Scale 1)
 */

const DEFAULT_SLAVE = 1;
const POLL_INTERVAL  = 60000;
const POLL_REQ_DELAY = 200;

const PARAMS = [
    { key: 'Voltage', addr: 0 },
    { key: 'Current', addr: 1 },
    { key: 'Frequency', addr: 2 },
    { key: 'Power', addr: 3 },
    { key: 'PowerFactor', addr: 4 },
    { key: 'Energy', addr: 5 },
    { key: 'Load', addr: 6 },
    { key: 'Alarm', addr: 7 }
];

// Modbus TCP Request bulk (FC 03, Address 0, Quantity 8)
function buildPollRequests(slave = DEFAULT_SLAVE) {
    return [{
        key: 'DATAKOM_ALL',
        tid: 1,
        bytes: Buffer.from([
            (1 >> 8) & 0xFF, 1 & 0xFF, // Transaction ID
            0x00, 0x00,                // Protocol ID
            0x00, 0x06,                // Length
            slave & 0xFF,              // Unit ID
            0x03,                      // Function Code
            0x00, 0x00,                // Start Address (0)
            0x00, 0x08                 // Quantity (8)
        ])
    }];
}

const POLL_REQUESTS_DEFAULT = buildPollRequests(DEFAULT_SLAVE);


class DatakomD700ModbusParser extends BaseParser {
    constructor(opts = {}) {
        super(opts);
        this._buf = Buffer.alloc(0);
        this._last = {};
        this._slave = opts.slave || DEFAULT_SLAVE;
        
        // Polling request array (digunakan oleh connection manager)
        this._pollRequests = buildPollRequests(this._slave);
    }

    reset() {
        this._buf = Buffer.alloc(0);
    }

    parse(rawData) {
        try {
            const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
            this._buf = Buffer.concat([this._buf, chunk]);

            // Batasi buffer max 4KB
            if (this._buf.length > 4096) {
                this._buf = this._buf.slice(-4096);
            }

            let parsedData = null;
            let alarms = [];
            let warnings = [];

            // Frame Modbus FC03 Response untuk 8 register (16 bytes data):
            // [TID_HI][TID_LO] [00][00] [00][13(LEN)] [UNIT] [03] [10(ByteCount)] [Val1_HI][Val1_LO] ...
            // Total panjang = 9 (header + fc + bc) + 16 (data) = 25 bytes
            let i = 0;
            while (i <= this._buf.length - 25) {
                const prot = this._buf.readUInt16BE(i + 2);
                const len = this._buf.readUInt16BE(i + 4);
                const unit = this._buf[i + 6];
                const fc = this._buf[i + 7];
                const bc = this._buf[i + 8];

                // Verifikasi signature frame modbus
                if (prot !== 0 || fc !== 0x03 || bc !== 16 || len !== 19) {
                    i++;
                    continue;
                }

                // Ekstrak data 8 register
                const r0 = this._buf.readUInt16BE(i + 9);
                const r1 = this._buf.readUInt16BE(i + 11);
                const r2 = this._buf.readUInt16BE(i + 13);
                const r3 = this._buf.readUInt16BE(i + 15);
                const r4 = this._buf.readUInt16BE(i + 17);
                const r5 = this._buf.readUInt16BE(i + 19);
                const r6 = this._buf.readUInt16BE(i + 21);
                const r7 = this._buf.readUInt16BE(i + 23);

                this._last = {
                    Voltage: r0 / 10,
                    Current: r1 / 10,
                    Frequency: r2 / 100,
                    Power: r3 / 10,
                    PowerFactor: r4 / 1000,
                    Energy: r5 / 10,
                    Load: r6 / 10,
                    Alarm: r7
                };

                parsedData = { ...this._last };
                i += 25; // Maju 1 frame utuh
            }

            // Hapus buffer yang sudah diproses
            this._buf = this._buf.slice(i);

            if (!parsedData) {
                return { success: false, error: 'Menunggu data Modbus utuh', status: 'Waiting' };
            }

            // Tentukan Status Genset (OFFLINE / STANDBY / RUNNING)
            let deviceStatus = 'OFFLINE';
            const hasPower = (parsedData.Voltage > 0) || (parsedData.Frequency > 0);
            const hasLoad = (parsedData.Load > 0) || (parsedData.Power > 0);

            if (hasPower) {
                deviceStatus = hasLoad ? 'RUNNING' : 'STANDBY';
            }

            // Tentukan Alarms
            if (parsedData.Alarm > 0) {
                alarms.push(`Genset Alarm Code: ${parsedData.Alarm}`);
            }

            // Anda juga bisa mengecek checkAlarms(parsedData) dari BaseParser jika ada rule config di DB
            const ruleCheck = super.checkAlarms(parsedData);
            alarms = alarms.concat(ruleCheck.alarms.map(a => a.message));
            warnings = warnings.concat(ruleCheck.warnings.map(w => w.message));

            const finalStatus = alarms.length > 0 ? 'Alarm' : deviceStatus;

            return {
                success: true,
                status: finalStatus,
                deviceStatus: deviceStatus,
                data: parsedData,
                alarms: alarms,
                warnings: warnings,
                timestamp: new Date().toISOString()
            };

        } catch (err) {
            console.error('[DATAKOM-D700] Parse error:', err.message);
            return { success: false, error: err.message, status: 'Error' };
        }
    }

    getPollRequests() {
        return this._pollRequests;
    }
}

module.exports = DatakomD700ModbusParser;
module.exports.POLL_REQUESTS     = POLL_REQUESTS_DEFAULT;
module.exports.POLL_INTERVAL     = POLL_INTERVAL;
module.exports.POLL_REQ_DELAY    = POLL_REQ_DELAY;
module.exports.PARAMS            = PARAMS;
module.exports.buildPollRequests = buildPollRequests;
