'use strict';

const ModbusRTU = require("modbus-serial");

/**
 * TempHumidity Modbus Parser
 * Membaca sensor Suhu & Kelembapan via RTU-over-TCP / Modbus TCP.
 * Mendukung konfigurasi Slave ID dari extra_config.
 */

const WARN_TEMP  = 30.0;
const ALARM_TEMP = 35.0;

// Mutex lock global per IP agar 2 sensor tidak pernah di-poll bersamaan (menghentikan collision 100%)
const ipLocks = new Map();

async function pollTempHumidity(host, port, slaveId, timeoutMs = 4000) {
    // Validasi nilai default jika tidak ada parameter yang di-passing
    if (!port) port = 502;
    if (!slaveId) slaveId = 1;

    // Delay acak / terstruktur berdasarkan ID untuk mencegah tabrakan data (Collision) 
    // jika 2 sensor di-poll di milidetik yang sama pada 1 IP Modbus Gateway.
    // Tunggu sampai IP ini sedang tidak di-poll oleh sensor lain (Antrian)
    while (ipLocks.get(host)) {
        await new Promise(r => setTimeout(r, 100));
    }
    // Kunci IP ini
    ipLocks.set(host, true);

    const client = new ModbusRTU();
    
    // Cegah Unhandled Rejection dari library modbus-serial jika koneksi terputus (ECONNREFUSED)
    client.on('error', (err) => {
        // Error akan ditangkap oleh try-catch di bawah, 
        // tapi listener ini mencegah NodeJS crash (Unhandled Rejection)
    });

    try {
        client.setTimeout(timeoutMs); 
        // connectTelnet lebih stabil untuk USR-TCP232 (Raw TCP ke RTU)
        await client.connectTelnet(host, { port: port });
        
        client.setID(slaveId);

        // Dari hasil analisa dan screenshot Modbus Poll:
        // Function = 03 (Holding Registers)
        // Register 0 = Suhu (misal 252 -> 25.2 °C)
        // Register 1 = Kelembapan (misal 352 -> 35.2 %)
        const res = await client.readHoldingRegisters(0, 2);
        
        const tempC = (res.data[0] / 10.0);
        const humiP = (res.data[1] / 10.0);
        
        client.close();

        // --- PROTEKSI & VALIDASI DATA (SANITY CHECK) ---
        // Jika terjadi tabrakan data di kabel RS485, angka yang didapat akan ngawur.
        // Kita cegah angka ngawur tersebut masuk ke database/UI.
        if (tempC < -50 || tempC > 150) {
            throw new Error(`Data Suhu tidak masuk akal (${tempC}°C). Kemungkinan tabrakan data (Collision).`);
        }
        if (humiP < 0 || humiP > 100) {
            throw new Error(`Data Kelembapan tidak masuk akal (${humiP}%). Kemungkinan tabrakan data (Collision).`);
        }

        let status = 'Normal';
        const alarms = [];
        const warnings = [];

        if (tempC >= ALARM_TEMP) {
            status = 'Alarm';
            alarms.push(`Suhu Ruangan Tinggi (${tempC.toFixed(1)}°C)`);
        } else if (tempC >= WARN_TEMP) {
            status = 'Warning';
            warnings.push(`Suhu Ruangan Hangat (${tempC.toFixed(1)}°C)`);
        }

        return {
            success: true,
            status,
            data: {
                connectivity: 'Connected',
                temperature_c: tempC.toFixed(1),
                humidity_pct: humiP.toFixed(1),
            },
            alarms,
            warnings,
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };

    } catch (err) {
        try { client.close(); } catch(e) {}
        return {
            success: false,
            status: 'Disconnect',
            error: err.message,
            data: {
                connectivity: 'Disconnected',
                temperature_c: null,
                humidity_pct: null,
            },
            alarms: [],
            warnings: [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };
    } finally {
        // Selalu buka kunci IP saat selesai (berhasil ataupun error)
        ipLocks.set(host, false);
    }
}

module.exports = { pollTempHumidity };
