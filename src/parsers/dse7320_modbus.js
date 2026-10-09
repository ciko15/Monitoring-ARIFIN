'use strict';

const { executeModbus } = require("../utils/modbus_wrapper");

/**
 * DSE7320 Modbus TCP Parser (via DSE890 gateway, port 502)
 *
 * Peta register mengikuti format DSE "GenComm":
 *   - 16-bit : tekanan oli, suhu, tegangan aki, RPM, frekuensi
 *   - 32-bit : tegangan dan arus (2 register berurutan, MSW dulu)
 *
 * STATUS VERIFIKASI (dari pembacaan langsung ke perangkat):
 *   [V] terverifikasi : 1024, 1025, 1029, 1059, 1060-1065, 1066-1071
 *   [?] belum         : 1030-1037 (genset sedang mati, nilainya selalu 0),
 *                       1076-1082 (alamat arus dari parser lama, belum dicek)
 *
 * Kode khusus DSE (sensor tidak terpasang / error) tidak ditampilkan sebagai angka:
 *   u16 : nilai >= 0xFFF0        -> '-'   (contoh 0xFFFF pada tekanan oli)
 *   s16 : 0x7FF0..0x7FFF         -> '-'   (contoh 0x7FFC = 32764 pada suhu)
 *   u32 : register atas >= 0x7FF0 -> '-'
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// type: 'u16' | 's16' | 'u32'
const PARAMS = [
    { key: 'OilPressure', addr: 1024, type: 'u16', scale: 1 },  // [V] kPa
    { key: 'CoolantTemp', addr: 1025, type: 's16', scale: 1 },  // [V] derajat C
    { key: 'BatteryVoltage', addr: 1029, type: 'u16', scale: 0.1 },  // [V] V
    { key: 'EngineSpeed', addr: 1030, type: 'u16', scale: 1 },  // [?] RPM
    { key: 'GeneratorFreq', addr: 1031, type: 'u16', scale: 0.1 },  // [?] Hz
    { key: 'GenVL1N', addr: 1032, type: 'u32', scale: 0.1 },  // [?] V
    { key: 'GenVL2N', addr: 1034, type: 'u32', scale: 0.1 },  // [?] V
    { key: 'GenVL3N', addr: 1036, type: 'u32', scale: 0.1 },  // [?] V
    { key: 'MainsFreq', addr: 1059, type: 'u16', scale: 0.1 },  // [V] Hz
    { key: 'MainsVL1N', addr: 1060, type: 'u32', scale: 0.1 },  // [V] V
    { key: 'MainsVL2N', addr: 1062, type: 'u32', scale: 0.1 },  // [V] V
    { key: 'MainsVL3N', addr: 1064, type: 'u32', scale: 0.1 },  // [V] V
    { key: 'MainsCurrentL1', addr: 1076, type: 'u32', scale: 0.1 },  // [?] A (alamat dari parser lama)
    { key: 'MainsCurrentL2', addr: 1078, type: 'u32', scale: 0.1 },  // [?] A
    { key: 'MainsCurrentL3', addr: 1080, type: 'u32', scale: 0.1 },  // [?] A
    { key: 'EarthCurrent', addr: 1082, type: 'u32', scale: 0.1 }   // [?] A
];

const MAX_CONSECUTIVE_LINK_ERRORS = 2;   // putus/time-out beruntun -> hentikan poll
const INTER_READ_DELAY_MS = 100;         // gateway DSE890 lambat (~0,5 detik per permintaan)

/** Ubah isi register menjadi angka berskala, atau null bila kode khusus/tidak terpasang. */
function decode(p, words) {
    if (p.type === 'u32') {
        const msw = words[0];
        const lsw = words[1];
        if (msw >= 0x7FF0) return null;
        return round((msw * 65536 + lsw) * p.scale);
    }
    const v = words[0];
    if (p.type === 's16') {
        if (v >= 0x7FF0 && v <= 0x7FFF) return null;
        const signed = v >= 0x8000 ? v - 0x10000 : v;
        return round(signed * p.scale);
    }
    // u16
    if (v >= 0xFFF0) return null;
    return round(v * p.scale);
}

function round(x) {
    return parseFloat(x.toFixed(2));
}

/** Error balasan Modbus dari perangkat (alamat tidak ada, dll). Bukan putusnya koneksi. */
function isModbusException(err) {
    if (!err) return false;
    if (err.modbusCode !== undefined) return true;
    return /illegal|exception|slave device|gateway/i.test(String(err.message || ''));
}

async function pollDse7320(host, port = 502, slaveId = 10) {
    const parsedData = {};
    let hasValidData = false;
    let lastError = null;
    let linkErrors = 0;
    const timeoutMs = 4000;

    await executeModbus({ host, port, type: 'tcp', slaveId, timeout: timeoutMs }, async (client) => {
        // Semua parameter dibaca dalam satu koneksi, satu per satu (urut, tidak paralel)
        for (const p of PARAMS) {
            const count = p.type === 'u32' ? 2 : 1;
            try {
                const res = await client.readHoldingRegisters(p.addr, count);
                if (res && res.data && res.data.length >= count) {
                    const val = decode(p, res.data);
                    if (val === null) {
                        parsedData[p.key] = '-';
                    } else {
                        parsedData[p.key] = val;
                        hasValidData = true;
                    }
                } else {
                    parsedData[p.key] = '-';
                }
                linkErrors = 0;
            } catch (err) {
                parsedData[p.key] = '-';
                lastError = err && err.message ? err.message : String(err);
                if (isModbusException(err)) {
                    // Perangkat menjawab tetapi menolak alamat ini: lanjut ke parameter berikutnya
                    linkErrors = 0;
                } else {
                    linkErrors += 1;
                    if (linkErrors >= MAX_CONSECUTIVE_LINK_ERRORS) {
                        // Koneksi bermasalah: jangan buang waktu menunggu sisa parameter
                        for (const rest of PARAMS) {
                            if (!(rest.key in parsedData)) parsedData[rest.key] = '-';
                        }
                        break;
                    }
                }
            }
            await sleep(INTER_READ_DELAY_MS);
        }
    });

    if (!hasValidData) {
        return {
            success: false,
            status: 'Disconnect',
            error: lastError
                ? 'No valid response from DSE7320: ' + lastError
                : 'No valid response from DSE7320',
            data: parsedData,
            alarms: [],
            warnings: [],
            timestamp: new Date().toISOString()
        };
    }

    // Status genset: RUNNING / STANDBY / STOPPED
    const rpm = parseFloat(parsedData.EngineSpeed) || 0;
    const freq = parseFloat(parsedData.GeneratorFreq) || 0;
    const vol = parseFloat(parsedData.GenVL1N) || 0;

    const hasPower = (vol > 10) || (freq > 10);
    const isRunning = (rpm > 500) || hasPower;

    let deviceStatus = isRunning ? 'RUNNING' : 'STANDBY';
    if (!isRunning && vol < 10 && freq < 10 && rpm < 10) {
        deviceStatus = 'STOPPED';
    }
    parsedData.engine_status = deviceStatus;

    const alarms = [];
    const warnings = [];
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

module.exports = { pollDse7320 };
