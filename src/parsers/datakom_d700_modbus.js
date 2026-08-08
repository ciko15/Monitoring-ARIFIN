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

// Modbus TCP Request (FC 03, Quantity 1 per parameter)
// Karena Datakom D700 sepertinya mengembalikan nilai aneh/garbage (0xAAAA, 0xFFFF)
// jika dibaca secara bulk 8 register sekaligus.
function buildPollRequests(slave = DEFAULT_SLAVE) {
    const requests = [];
    PARAMS.forEach((p, idx) => {
        const tid = idx + 1; // TID mulai dari 1 sampai 8
        requests.push({
            key: p.key,
            tid: tid,
            bytes: Buffer.from([
                (tid >> 8) & 0xFF, tid & 0xFF, // Transaction ID
                0x00, 0x00,                    // Protocol ID
                0x00, 0x06,                    // Length
                slave & 0xFF,                  // Unit ID
                0x03,                          // Function Code
                (p.addr >> 8) & 0xFF, p.addr & 0xFF, // Start Address
                0x00, 0x01                     // Quantity (1)
            ])
        });
    });
    return requests;
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

            // Frame Modbus FC03 Response untuk 1 register (2 bytes data):
            // [TID_HI][TID_LO] [00][00] [00][05(LEN)] [UNIT] [03] [02(ByteCount)] [Val_HI][Val_LO]
            // Total panjang = 9 (header + fc + bc) + 2 (data) = 11 bytes
            let i = 0;
            while (i <= this._buf.length - 11) {
                const tid = this._buf.readUInt16BE(i);
                const prot = this._buf.readUInt16BE(i + 2);
                const len = this._buf.readUInt16BE(i + 4);
                const unit = this._buf[i + 6];
                const fc = this._buf[i + 7];
                const bc = this._buf[i + 8];

                // Verifikasi signature frame modbus tunggal
                if (prot !== 0 || fc !== 0x03 || bc !== 2 || len !== 5) {
                    i++;
                    continue;
                }

                // Ekstrak data 1 register (16-bit)
                const val = this._buf.readUInt16BE(i + 9);
                
                // Cek TID untuk mencocokkan parameter
                // TID = index + 1
                const pIdx = tid - 1;
                if (pIdx >= 0 && pIdx < PARAMS.length) {
                    const paramName = PARAMS[pIdx].key;
                    // Scale:
                    let scale = 1;
                    if (paramName === 'Voltage' || paramName === 'Current' || paramName === 'Power' || paramName === 'Energy' || paramName === 'Load') scale = 10;
                    else if (paramName === 'Frequency') scale = 100;
                    else if (paramName === 'PowerFactor') scale = 1000;
                    
                    this._last[paramName] = val / scale;
                }

                parsedData = { ...this._last };
                i += 11; // Maju 1 frame utuh
            }

            // Hapus buffer yang sudah diproses
            this._buf = this._buf.slice(i);

            // Validasi apakah kita sudah punya setidaknya Voltage (sebagai tanda data mulai masuk)
            if (!this._last.Voltage && this._last.Voltage !== 0) {
                return { success: false, error: 'Menunggu data Modbus', status: 'Waiting' };
            }

            // Pastikan data yang kosong diisi 0 agar UI tidak undefined
            parsedData = Object.assign({
                Voltage: 0, Current: 0, Frequency: 0, Power: 0, 
                PowerFactor: 0, Energy: 0, Load: 0, Alarm: 0
            }, this._last);

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
