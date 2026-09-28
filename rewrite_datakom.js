const fs = require('fs');

const content = `'use strict';

const net = require('net');

/**
 * Datakom D700 Modbus TCP Parser
 * DIOPTIMASI: 
 * Sebelumnya membuka 8 TCP Socket secara beruntun (menyebabkan alat HANG/Crash).
 * Sekarang HANYA 1 TCP Socket dan meminta 8 Register SEKALIGUS (Single FC03).
 * Sangat ringan untuk alat.
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

let globalTid = 0;

function readAllModbusRegisters(host, port, unitId, timeoutMs = 3000) {
    return new Promise((resolve) => {
        globalTid++;
        if (globalTid > 65535) globalTid = 1;

        const tidHi = (globalTid >> 8) & 0xFF;
        const tidLo = globalTid & 0xFF;
        
        // Request FC03, Address 0, Quantity 8
        const req = Buffer.from([
            tidHi, tidLo,   // Transaction ID
            0x00, 0x00,     // Protocol ID
            0x00, 0x06,     // Length (6 bytes follow)
            unitId,         // Unit ID
            0x03,           // Function Code
            0x00, 0x00,     // Start Address (0)
            0x00, 0x08      // Quantity (8 registers = 16 bytes of data)
        ]);

        const client = new net.Socket();
        let resolved = false;

        const cleanup = () => {
            if (!client.destroyed) client.destroy();
        };

        const timeoutTimer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                console.warn(\`[Datakom] Modbus timeout \${host}:\${port}\`);
                cleanup();
                resolve(null);
            }
        }, timeoutMs);

        client.connect(port, host, () => {
            client.write(req);
        });

        client.on('data', (data) => {
            if (resolved) return;
            
            // Expected Response length = 9 bytes header + 16 bytes data = 25 bytes
            if (data.length >= 9) {
                if (data[7] === (0x03 + 0x80)) {
                    console.warn(\`[Datakom] Exception response: 0x\${data[8].toString(16)}\`);
                    resolved = true;
                    clearTimeout(timeoutTimer);
                    cleanup();
                    resolve(null);
                    return;
                }

                const byteCount = data[8];
                if (byteCount === 16 && data.length >= 25) {
                    const registers = [];
                    for(let i=0; i<8; i++) {
                        const val = data.readUInt16BE(9 + (i * 2));
                        registers.push(val);
                    }
                    resolved = true;
                    clearTimeout(timeoutTimer);
                    cleanup();
                    resolve(registers);
                }
            }
        });

        client.on('error', (err) => {
            if (!resolved) {
                console.warn(\`[Datakom] TCP Error \${host}:\${port} ->\`, err.message);
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

async function pollDatakomD700(host, port = 502, slaveId = 1) {
    let parsedData = {};
    let hasValidData = false;

    // Ambil sekaligus 8 parameter dalam 1 tembakan request!
    const registers = await readAllModbusRegisters(host, port, slaveId, 3000);

    if (registers !== null) {
        hasValidData = true;
        for (let i = 0; i < PARAMS.length; i++) {
            const p = PARAMS[i];
            const raw = registers[i];
            if (raw === 0xAAAA || raw === 0xFFFF) {
                parsedData[p.key] = '-';
            } else {
                parsedData[p.key] = raw / p.scale;
            }
        }
    } else {
        for (const p of PARAMS) {
            parsedData[p.key] = '-';
        }
    }

    if (!hasValidData) {
        return {
            success: false,
            status: 'Disconnect',
            error: 'No valid response from Datakom',
            data: parsedData,
            alarms: [],
            warnings: [],
            timestamp: new Date().toISOString()
        };
    }

    let deviceStatus = 'OFFLINE';
    const vol = parseFloat(parsedData.Voltage) || 0;
    const freq = parseFloat(parsedData.Frequency) || 0;
    const load = parseFloat(parsedData.Load) || 0;
    const pwr = parseFloat(parsedData.Power) || 0;

    const hasPower = (vol > 0) || (freq > 0);
    const hasLoad = (load > 0) || (pwr > 0);

    if (hasPower) {
        deviceStatus = hasLoad ? 'RUNNING' : 'STANDBY';
    } else {
        deviceStatus = 'STOPPED';
    }

    parsedData.engine_status = deviceStatus;

    let alarms = [];
    let warnings = [];

    if (parsedData.Alarm !== '-' && parsedData.Alarm > 0) {
        alarms.push(\`Genset Alarm Code: \${parsedData.Alarm}\`);
    }

    const finalStatus = alarms.length > 0 ? 'Alarm' : 'Normal';

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

module.exports = { pollDatakomD700 };
`;

fs.writeFileSync('src/parsers/datakom_d700_modbus.js', content);
console.log('Datakom optimized.');
