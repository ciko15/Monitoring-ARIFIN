'use strict';

const ModbusRTU = require("modbus-serial");

/**
 * TempHumidity Modbus Parser
 * Membaca sensor Suhu & Kelembapan via RTU-over-TCP / Modbus TCP.
 * Mendukung konfigurasi Slave ID dari extra_config.
 */

const WARN_TEMP  = 30.0;
const ALARM_TEMP = 35.0;

async function pollTempHumidity(host, port = 502, slaveId = 1, timeoutMs = 4000) {
    const client = new ModbusRTU();
    try {
        client.setTimeout(timeoutMs); 
        await client.connectTelnet(host, { port: port });
        
        client.setID(slaveId);

        // test-humidity berhasil membaca FC04 (Input Registers) di alamat 1-2
        const res = await client.readInputRegisters(1, 2);
        
        const tempC = (res.data[0] / 10.0);
        const humiP = (res.data[1] / 10.0);
        
        client.close();

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
    }
}

module.exports = { pollTempHumidity };
