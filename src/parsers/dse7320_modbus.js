'use strict';

const ModbusRTU = require("modbus-serial");

/**
 * DSE7320 Modbus TCP Parser
 * Ditulis ulang menggunakan modbus-serial untuk menjaga satu koneksi terbuka (Keep-Alive)
 * Mencegah Modbus Gateway terkunci akibat connect/disconnect berulang kali secara cepat.
 */

const PARAMS = [
    { key: 'OilPressure', addr: 1024, scale: 1 },
    { key: 'CoolantTemp', addr: 1026, scale: 1 },
    { key: 'BatteryVoltage', addr: 1028, scale: 0.1 },
    { key: 'EngineSpeed', addr: 1030, scale: 1 },
    { key: 'GeneratorFreq', addr: 1032, scale: 0.1 },
    { key: 'GenVL1N', addr: 1034, scale: 1 },
    { key: 'GenVL2N', addr: 1036, scale: 1 },
    { key: 'GenVL3N', addr: 1038, scale: 1 },
    { key: 'MainsFreq', addr: 1058, scale: 0.1 },
    { key: 'MainsVL1N', addr: 1060, scale: 1 },
    { key: 'MainsVL2N', addr: 1062, scale: 1 },
    { key: 'MainsVL3N', addr: 1064, scale: 1 },
    { key: 'MainsCurrentL1', addr: 1076, scale: 0.1 },
    { key: 'MainsCurrentL2', addr: 1078, scale: 0.1 },
    { key: 'MainsCurrentL3', addr: 1080, scale: 0.1 },
    { key: 'EarthCurrent', addr: 1082, scale: 0.1 }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Mutex lock global per IP agar 2 request tidak tabrakan
const ipLocks = new Map();

async function pollDse7320(host, port = 502, slaveId = 10) {
    let parsedData = {};
    let hasValidData = false;
    const timeoutMs = 3000;

    // Tunggu jika ada proses poll Modbus lain yang sedang jalan di IP ini
    while (ipLocks.get(host)) {
        await sleep(100);
    }
    ipLocks.set(host, true);

    const client = new ModbusRTU();
    
    // Cegah Unhandled Rejection jika koneksi terputus
    client.on('error', (err) => {});

    try {
        client.setTimeout(timeoutMs);
        await client.connectTCP(host, { port: port });
        client.setID(slaveId);

        // Ambil data dalam 1 siklus koneksi!
        for (const p of PARAMS) {
            try {
                // Baca 2 Register (32-bit)
                const res = await client.readHoldingRegisters(p.addr, 2);
                if (res && res.data && res.data.length >= 2) {
                    const msw = res.data[0];
                    const lsw = res.data[1];
                    
                    // Filter "Unimplemented" values in DSE (usually 0xFFFF, 0x00FF, or 0x7FFFFFFF)
                    if (msw === 0xFFFF || msw === 0x00FF || (msw === 0x7FFF && lsw === 0xFFFF)) {
                        parsedData[p.key] = '-';
                    } else {
                        // Unsigned 32-bit
                        const raw = (msw * 65536) + lsw;
                        const val = raw * p.scale;
                        parsedData[p.key] = parseFloat(val.toFixed(2));
                        hasValidData = true;
                    }
                } else {
                    parsedData[p.key] = '-';
                }
            } catch (err) {
                // Biarkan lanjut ke parameter berikutnya jika satu sensor error
                parsedData[p.key] = '-';
            }
            // Jeda 50ms sangat kecil agar Modbus slave DSE tidak kewalahan
            await sleep(50);
        }
        
        client.close();
    } catch (e) {
        if (client.isOpen) client.close();
        console.error(`[DSE7320] Modbus error for ${host}: ${e.message}`);
    } finally {
        ipLocks.set(host, false);
    }

    if (!hasValidData) {
        return {
            success: false,
            status: 'Disconnect',
            error: 'No valid response from DSE7320',
            data: parsedData,
            alarms: [],
            warnings: [],
            timestamp: new Date().toISOString()
        };
    }

    // Tentukan Status Genset (OFFLINE / STANDBY / RUNNING)
    let deviceStatus = 'OFFLINE';
    const rpm = parseFloat(parsedData.EngineSpeed) || 0;
    const freq = parseFloat(parsedData.GeneratorFreq) || 0;
    const vol = parseFloat(parsedData.GenVL1N) || 0;

    const hasPower = (vol > 10) || (freq > 10);
    const isRunning = (rpm > 500) || hasPower;

    deviceStatus = isRunning ? 'RUNNING' : 'STANDBY';

    let alarms = [];
    let warnings = [];

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
}

module.exports = { pollDse7320 };
