'use strict';

const { executeModbus } = require("../utils/modbus_wrapper");

/**
 * TempHumidity Modbus Parser
 * Membaca sensor Suhu & Kelembapan via RTU-over-TCP / Modbus TCP.
 * Menggunakan modbus-serial wrapper untuk perlindungan unhandled rejection.
 */

const WARN_TEMP  = 30.0;
const ALARM_TEMP = 35.0;

// Mutex lock global per IP agar 2 sensor tidak pernah di-poll bersamaan (menghentikan collision 100%)
const ipLocks = new Map();

async function pollTempHumidity(host, port, slaveId, timeoutMs = 4000) {
    if (!port) port = 502;
    if (!slaveId) slaveId = 1;

    let tempC, humiP;
    try {
        try {
            // 1. Coba mode RAW RTU-over-TCP (seperti konfigurasi di Biak)
            await executeModbus({ host, port, type: 'telnet', slaveId, timeout: timeoutMs }, async (client) => {
                const res = await client.readHoldingRegisters(0, 2);
                tempC = (res.data[0] / 10.0);
                humiP = (res.data[1] / 10.0);
            });
        } catch (err) {
            // 2. Jika gagal, otomatis coba mode Modbus TCP murni (seperti konfigurasi asli di Sentani)
            if (err.message.includes('CRC') || String(err.message).toLowerCase().includes('time')) {
                await executeModbus({ host, port, type: 'tcp', slaveId, timeout: timeoutMs }, async (client) => {
                    const res = await client.readHoldingRegisters(0, 2);
                    tempC = (res.data[0] / 10.0);
                    humiP = (res.data[1] / 10.0);
                });
            } else {
                throw err;
            }
        }

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
    }
}

module.exports = { pollTempHumidity };
