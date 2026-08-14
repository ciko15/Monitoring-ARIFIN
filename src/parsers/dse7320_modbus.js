'use strict';

const net = require('net');

/**
 * DSE7320 Modbus TCP Parser
 * Membaca data instrumentasi dari DSE7320 secara aman agar tidak
 * mengganggu operasional (memberi jeda antar pembacaan).
 * 
 * Format Data: 32-bit (2 Register) untuk setiap nilai.
 */

const PARAMS = [
    { key: 'OilPressure', addr: 1024, scale: 1 },
    { key: 'CoolantTemp', addr: 1026, scale: 1 },
    { key: 'BatteryVoltage', addr: 1028, scale: 0.1 },
    { key: 'EngineSpeed', addr: 1030, scale: 1 },
    { key: 'GeneratorFreq', addr: 1032, scale: 0.1 },
    { key: 'GenVL1N', addr: 1034, scale: 1 }, // Changed scale to 1 based on scan
    { key: 'GenVL2N', addr: 1036, scale: 1 }, // Changed scale to 1 based on scan
    { key: 'GenVL3N', addr: 1038, scale: 1 }, // Changed scale to 1 based on scan
    { key: 'MainsFreq', addr: 1058, scale: 0.1 },
    { key: 'MainsVL1N', addr: 1060, scale: 1 },
    { key: 'MainsVL2N', addr: 1062, scale: 1 },
    { key: 'MainsVL3N', addr: 1064, scale: 1 },
    { key: 'MainsCurrentL1', addr: 1076, scale: 0.1 },
    { key: 'MainsCurrentL2', addr: 1078, scale: 0.1 },
    { key: 'MainsCurrentL3', addr: 1080, scale: 0.1 },
    { key: 'EarthCurrent', addr: 1082, scale: 0.1 }
];

let globalTid = 0;

function readModbusRegister32(host, port, unitId, address, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        globalTid++;
        if (globalTid > 65535) globalTid = 1;

        const tidHi = (globalTid >> 8) & 0xFF;
        const tidLo = globalTid & 0xFF;
        const addrHi = (address >> 8) & 0xFF;
        const addrLo = address & 0xFF;

        // Modbus TCP Request (FC 03, Quantity 2 registers for 32-bit)
        const req = Buffer.from([
            tidHi, tidLo,   // Transaction ID
            0x00, 0x00,     // Protocol ID (0 = Modbus)
            0x00, 0x06,     // Length (6 bytes follow)
            unitId,         // Unit ID
            0x03,           // Function Code
            addrHi, addrLo, // Start Address
            0x00, 0x02      // Quantity (2 registers = 4 bytes)
        ]);

        const client = new net.Socket();
        let resolved = false;

        const cleanup = () => {
            if (!client.destroyed) client.destroy();
        };

        const timeoutTimer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanup();
                resolve(null);
            }
        }, timeoutMs);

        client.connect(port, host, () => {
            client.write(req);
        });

        client.on('data', (data) => {
            if (resolved) return;
            
            // Frame minimal Modbus TCP FC03 response untuk 2 reg adalah 11 bytes
            if (data.length >= 9) {
                // Cek Exception
                if (data[7] === (0x03 + 0x80)) {
                    resolved = true;
                    clearTimeout(timeoutTimer);
                    cleanup();
                    resolve(null);
                    return;
                }

                // Ambil nilai 32-bit
                const byteCount = data[8];
                if (byteCount >= 4 && data.length >= 13) {
                    const msw = data.readUInt16BE(9);
                    const lsw = data.readUInt16BE(11);
                    
                    // Filter "Unimplemented" values in DSE (usually 0xFFFF, 0x00FF, or 0x7FFFFFFF for sensors not fitted)
                    if (msw === 0xFFFF || msw === 0x00FF || (msw === 0x7FFF && lsw === 0xFFFF)) {
                        resolved = true;
                        clearTimeout(timeoutTimer);
                        cleanup();
                        resolve(null);
                        return;
                    }

                    const val = (msw * 65536) + lsw;
                    
                    resolved = true;
                    clearTimeout(timeoutTimer);
                    cleanup();
                    resolve(val);
                    return;
                }
            }
        });

        client.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeoutTimer);
                cleanup();
                resolve(null);
            }
        });

        client.on('close', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeoutTimer);
                cleanup();
                resolve(null);
            }
        });
    });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pollDse7320(host, port = 502, slaveId = 10) {
    let parsedData = {};
    let hasValidData = false;

    // Baca data secara sequensial dan hati-hati untuk DSE controller
    for (const p of PARAMS) {
        const raw = await readModbusRegister32(host, port, slaveId, p.addr, 2000);
        if (raw !== null) {
            let val = raw * p.scale;
            // DSE sometimes returns signed for sensors? No, wait, if pressure or temp is negative.
            // But we keep it unsigned for now since it's standard 32-bit uint.
            // Format to 1 or 2 decimal places to be neat
            parsedData[p.key] = parseFloat(val.toFixed(2));
            hasValidData = true;
        } else {
            parsedData[p.key] = '-';
        }
        await sleep(50); // Jeda kecil agar tidak spam DSE
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
