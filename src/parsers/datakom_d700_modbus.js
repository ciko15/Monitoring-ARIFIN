'use strict';

const ModbusRTU = require("modbus-serial");

/**
 * Datakom D700 Modbus TCP Parser
 * Membaca 8 Holding Registers secara berurutan.
 * 
 * Karena Datakom D700 seringkali merespons dengan nilai padding (0xAAAA) 
 * jika dibaca menggunakan metode bulk (Quantity > 1), parser ini menggunakan
 * library modbus-serial untuk membaca 1 register per request.
 */

const PARAMS = [
    { key: 'Voltage', addr: 0, scale: 10 },
    { key: 'Current', addr: 1, scale: 10 },
    { key: 'Frequency', addr: 2, scale: 100 },
    { key: 'Power', addr: 3, scale: 10 },
    { key: 'PowerFactor', addr: 4, scale: 1000 },
    { key: 'Energy', addr: 5, scale: 10 },
    { key: 'Load', addr: 6, scale: 10 },
    { key: 'Alarm', addr: 7, scale: 1 }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pollDatakomD700(host, port = 502, slaveId = 1, timeoutMs = 4000) {
    const client = new ModbusRTU();
    try {
        client.setTimeout(timeoutMs);
        
        // Coba koneksi TCP biasa ke Genset Datakom
        await client.connectTCP(host, { port: port });
        client.setID(slaveId);

        let parsedData = {};

        // Loop untuk membaca 1 register setiap kalinya (mirip script PowerShell)
        for (const p of PARAMS) {
            try {
                const res = await client.readHoldingRegisters(p.addr, 1);
                parsedData[p.key] = res.data[0] / p.scale;
            } catch (err) {
                console.error(`[Datakom] Gagal membaca register ${p.key}:`, err.message);
                parsedData[p.key] = 0; // fallback nilai
            }
            // Beri jeda kecil agar kontroler Datakom tidak kewalahan
            await sleep(50);
        }

        client.close();

        // Tentukan Status Genset (OFFLINE / STANDBY / RUNNING)
        let deviceStatus = 'OFFLINE';
        const hasPower = (parsedData.Voltage > 0) || (parsedData.Frequency > 0);
        const hasLoad = (parsedData.Load > 0) || (parsedData.Power > 0);

        if (hasPower) {
            deviceStatus = hasLoad ? 'RUNNING' : 'STANDBY';
        }

        let alarms = [];
        let warnings = [];

        if (parsedData.Alarm > 0) {
            alarms.push(`Genset Alarm Code: ${parsedData.Alarm}`);
        }

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
        try { client.close(); } catch(e) {}
        return {
            success: false,
            status: 'Disconnect',
            error: err.message,
            data: {
                Voltage: 0, Current: 0, Frequency: 0, Power: 0,
                PowerFactor: 0, Energy: 0, Load: 0, Alarm: 0
            },
            alarms: [],
            warnings: [],
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = { pollDatakomD700 };
