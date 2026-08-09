'use strict';

const net = require('net');

/**
 * Datakom D700 Modbus TCP Parser
 * Meniru EXACTLY script PowerShell:
 * 1. Buka TCP koneksi baru.
 * 2. Kirim 1 frame request Modbus (Function 03, Quantity 1).
 * 3. Terima response, ekstrak nilai.
 * 4. Tutup TCP koneksi.
 * (Diulang untuk setiap parameter).
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

function readModbusRegister(host, port, unitId, address, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        globalTid++;
        if (globalTid > 65535) globalTid = 1;

        const tidHi = (globalTid >> 8) & 0xFF;
        const tidLo = globalTid & 0xFF;
        const addrHi = (address >> 8) & 0xFF;
        const addrLo = address & 0xFF;

        // Modbus TCP Request (FC 03, Quantity 1)
        const req = Buffer.from([
            tidHi, tidLo,   // Transaction ID
            0x00, 0x00,     // Protocol ID (0 = Modbus)
            0x00, 0x06,     // Length (6 bytes follow)
            unitId,         // Unit ID
            0x03,           // Function Code
            addrHi, addrLo, // Start Address
            0x00, 0x01      // Quantity
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
            console.log(`[Datakom] Connected to ${host}:${port}, sending request for addr ${address}`);
            client.write(req);
        });

        client.on('data', (data) => {
            if (resolved) return;
            console.log(`[Datakom] RCV addr ${address}:`, data.toString('hex'));
            
            // Frame minimal Modbus TCP FC03 response adalah 9 bytes
            if (data.length >= 9) {
                // Cek Exception
                if (data[7] === (0x03 + 0x80)) {
                    console.warn(`[Datakom] Exception response for addr ${address}: 0x${data[8].toString(16)}`);
                    resolved = true;
                    clearTimeout(timeoutTimer);
                    cleanup();
                    resolve(null);
                    return;
                }

                // Ambil nilai 16-bit
                const byteCount = data[8];
                if (byteCount >= 2 && data.length >= 11) {
                    const val = data.readUInt16BE(9);
                    
                    // Filter garbage values (seperti 0xAAAA atau 0xFFFF)
                    // karena PowerShell berhasil dapat nilai asli (17.00V)
                    // Jika alat return 0xAAAA, kita anggap null agar tidak tertampil aneh
                    if (val === 0xAAAA || val === 0xFFFF) {
                        resolved = true;
                        clearTimeout(timeoutTimer);
                        cleanup();
                        resolve(null);
                        return;
                    }

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
                console.warn(`[Datakom] TCP Error for addr ${address}:`, err.message);
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

async function pollDatakomD700(host, port = 502, slaveId = 1) {
    let parsedData = {};
    let hasValidData = false;

    // Loop membaca 1 per 1 (buka tutup koneksi TCP) persis seperti PowerShell
    for (const p of PARAMS) {
        const raw = await readModbusRegister(host, port, slaveId, p.addr, 2000);
        if (raw !== null) {
            parsedData[p.key] = raw / p.scale;
            hasValidData = true;
        } else {
            parsedData[p.key] = '-'; // fallback nilai jika alat tidak membalas
        }
        await sleep(50); // Jeda kecil antar koneksi
    }

    if (!hasValidData) {
        console.warn(`[Datakom D700] All registers returned null. Device might be offline or rejecting connections.`);
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

    console.log(`[Datakom D700] Poll success: Voltage=${parsedData.Voltage}, Current=${parsedData.Current}`);

    // Tentukan Status Genset (OFFLINE / STANDBY / RUNNING)
    let deviceStatus = 'OFFLINE';
    const vol = parseFloat(parsedData.Voltage) || 0;
    const freq = parseFloat(parsedData.Frequency) || 0;
    const load = parseFloat(parsedData.Load) || 0;
    const pwr = parseFloat(parsedData.Power) || 0;

    const hasPower = (vol > 0) || (freq > 0);
    const hasLoad = (load > 0) || (pwr > 0);

    if (hasPower) {
        deviceStatus = hasLoad ? 'RUNNING' : 'STANDBY';
    }

    let alarms = [];
    let warnings = [];

    if (parsedData.Alarm !== '-' && parsedData.Alarm > 0) {
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
}

module.exports = { pollDatakomD700 };
