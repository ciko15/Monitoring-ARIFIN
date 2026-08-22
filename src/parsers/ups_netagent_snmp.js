/**
 * ups_netagent_snmp.js - Parser SNMP untuk UPS dengan NetAgent Card (RFC 1628 UPS MIB)
 */

'use strict';

const snmp = require('snmp-native');

// OID standar RFC 1628 (UPS MIB)
const OID = {
    sysDescr: [1, 3, 6, 1, 2, 1, 1, 1, 0],
    sysName: [1, 3, 6, 1, 2, 1, 1, 5, 0],
    
    // Status
    upsBatteryStatus: [1, 3, 6, 1, 2, 1, 33, 1, 2, 1, 0], // 1=unknown, 2=normal, 3=low, 4=depleted
    upsEstimatedMinutesRemaining: [1, 3, 6, 1, 2, 1, 33, 1, 2, 3, 0], // Backup time tersisa (menit)
    upsEstimatedChargeRemaining: [1, 3, 6, 1, 2, 1, 33, 1, 2, 4, 0], // Kapasitas baterai %
    upsBatteryVoltage: [1, 3, 6, 1, 2, 1, 33, 1, 2, 5, 0], // Tegangan baterai (0.1 Volt DC, kadang butuh /10)
    
    // Input (3 Phase)
    upsInputVoltageR: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 1],
    upsInputVoltageS: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 2],
    upsInputVoltageT: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 3],
    
    // Output (3 Phase)
    upsOutputVoltageR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 1],
    upsOutputVoltageS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 2],
    upsOutputVoltageT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 3],
    
    upsOutputCurrentR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 3, 1],
    upsOutputCurrentS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 3, 2],
    upsOutputCurrentT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 3, 3],
    
    upsOutputPowerR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 4, 1],
    upsOutputPowerS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 4, 2],
    upsOutputPowerT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 4, 3],
    
    upsOutputPercentLoadR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 5, 1],
    upsOutputPercentLoadS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 5, 2],
    upsOutputPercentLoadT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 5, 3],
    
    upsBatteryTemp: [1, 3, 6, 1, 2, 1, 33, 1, 2, 7, 0], // Suhu Baterai
};

function normalizeSnmpOptions(options = {}) {
    if (!options || typeof options !== 'object') return { port: 161, version: '2c' };
    return {
        port: parseInt(options.port, 10) || 161,
        version: options.version || '2c',
    };
}

function normalizeSnmpVersion(version) {
    const value = String(version || '2c').toLowerCase().replace(/^v/, '');
    return value === '1' ? snmp.Versions.SNMPv1 : snmp.Versions.SNMPv2c;
}

function createSession(host, community, options = {}) {
    const snmpOptions = normalizeSnmpOptions(options);
    return new snmp.Session({
        host,
        community,
        port: snmpOptions.port,
        version: normalizeSnmpVersion(snmpOptions.version),
        timeouts: [5000, 5000, 5000], // Increased timeouts and retries for WAN/VSAT stability
    });
}

function snmpGet(session, oid) {
    return new Promise(resolve => {
        session.get({ oid }, (err, vbs) => {
            resolve((!err && vbs && vbs[0]) ? vbs[0].value : null);
        });
    });
}
function snmpGetAll(session, oids) {
    return new Promise(resolve => {
        session.getAll({ oids }, (err, vbs) => {
            if (err || !vbs) return resolve(oids.map(() => null));
            const result = oids.map(oid => {
                const oidStr = oid.join('.');
                const match = vbs.find(vb => vb.oid.join('.') === oidStr);
                return match && match.type !== 128 && match.type !== 129 ? match.value : null;
            });
            resolve(result);
        });
    });
}

async function snmpGetAllChunked(session, oids, chunkSize = 5) {
    const results = [];
    for (let i = 0; i < oids.length; i += chunkSize) {
        const chunk = oids.slice(i, i + chunkSize);
        let chunkResults = await snmpGetAll(session, chunk);
        
        // JIKA GAGAL (karena SNMPv1 noSuchName pada salah satu OID di dalam chunk),
        // fallback ke individual GET agar OID yang valid tetap terbaca (misal UPS 1-Phase tidak punya Phase S & T)
        if (chunkResults.every(r => r === null)) {
            chunkResults = [];
            for (const oid of chunk) {
                chunkResults.push(await snmpGet(session, oid));
            }
        }
        
        results.push(...chunkResults);
    }
    return results;
}

async function pollUPSNetagent(host, community = 'public', options = {}) {
    const session = createSession(host, community, options);
    
    try {
        // Menggunakan getAll dengan chunking agar UDP packet size tidak terlalu besar (mencegah packet drop di WAN/VSAT)
        const oidsToFetch = [
            OID.sysDescr, OID.sysName, OID.upsBatteryStatus, OID.upsEstimatedMinutesRemaining,
            OID.upsEstimatedChargeRemaining, OID.upsBatteryVoltage, OID.upsBatteryTemp,
            OID.upsInputVoltageR, OID.upsInputVoltageS, OID.upsInputVoltageT,
            OID.upsOutputVoltageR, OID.upsOutputVoltageS, OID.upsOutputVoltageT,
            OID.upsOutputCurrentR, OID.upsOutputCurrentS, OID.upsOutputCurrentT,
            OID.upsOutputPowerR, OID.upsOutputPowerS, OID.upsOutputPowerT,
            OID.upsOutputPercentLoadR, OID.upsOutputPercentLoadS, OID.upsOutputPercentLoadT
        ];
        const [
            sysDescr, sysName,
            batteryStatusRaw, minutesRemaining, chargeRemaining, batteryVoltageRaw, batteryTemp,
            inputVoltageR, inputVoltageS, inputVoltageT,
            outputVoltageR, outputVoltageS, outputVoltageT,
            outputCurrentRawR, outputCurrentRawS, outputCurrentRawT,
            outputPowerR, outputPowerS, outputPowerT,
            outputPercentLoadR, outputPercentLoadS, outputPercentLoadT
        ] = await snmpGetAllChunked(session, oidsToFetch, 5); // Ambil per 5 OID

        if (sysDescr === null && inputVoltageR === null && outputVoltageR === null) {
            throw new Error('No SNMP response from UPS');
        }

        // Logic Status Evaluasi
        let status = 'Normal';
        const alarms = [];
        const warnings = [];
        const triggeredParams = [];

        // Evaluasi Baterai
        if (chargeRemaining !== null) {
            if (chargeRemaining < 30) {
                status = 'Alarm';
                alarms.push('Kapasitas Baterai Sangat Rendah (<30%)');
                triggeredParams.push('battery_capacity');
            } else if (chargeRemaining <= 50) {
                if (status !== 'Alarm') status = 'Warning';
                warnings.push('Kapasitas Baterai Menengah (<=50%)');
                triggeredParams.push('battery_capacity');
            }
        }
        
        if (batteryStatusRaw === 3 || batteryStatusRaw === 4) { // Low atau Depleted
            status = 'Alarm';
            alarms.push('Status Baterai Lemah/Kosong (Low/Depleted)');
            triggeredParams.push('battery_status');
        }

        // Evaluasi Input Tegangan (asumsi mati lampu jika input < 150V)
        const avgInputVoltage = (inputVoltageR !== null) ? inputVoltageR : 0; // Deteksi drop di Phase R
        if (inputVoltageR !== null && inputVoltageR < 150) {
            status = 'Alarm';
            alarms.push('Listrik Input Mati / Drop (On Battery)');
            triggeredParams.push('input_voltage_r');
        }

        // Evaluasi Load Beban
        const maxLoad = Math.max(outputPercentLoadR || 0, outputPercentLoadS || 0, outputPercentLoadT || 0);
        if (maxLoad > 90) {
            status = 'Alarm';
            alarms.push('Beban UPS Overload (>90%)');
            triggeredParams.push('output_load_percent');
        } else if (maxLoad > 80) {
            if (status !== 'Alarm') status = 'Warning';
            warnings.push('Beban UPS Tinggi (>80%)');
            triggeredParams.push('output_load_percent');
        }

        // Map status baterai ke teks string
        let batteryStatusStr = 'Unknown';
        if (batteryStatusRaw === 2) batteryStatusStr = 'Normal';
        else if (batteryStatusRaw === 3) batteryStatusStr = 'Low';
        else if (batteryStatusRaw === 4) batteryStatusStr = 'Depleted';

        // Kalkulasi Total Power Factor (Mendukung Vektor 3-Phase)
        let totalRealPower = 0;
        let arithmeticApparentPower = 0;
        let totalReactivePower = 0;
        let activePhases = 0;

        // Deteksi apakah ini UPS Piller yang sensor arusnya rusak (10x lebih kecil dari aslinya)
        const isPiller = String(sysDescr || '').toLowerCase().includes('piller');

        // Ekstrak KVA dari sysDescr (contoh: "UPS 30 KVA" -> 30) untuk rumus gaib
        let upsKVA = 0;
        const kvaMatch = String(sysDescr || '').match(/(\d+)\s*kva/i);
        if (kvaMatch) upsKVA = Number(kvaMatch[1]);

        const fixSensor = (v, aRaw, wRaw, loadPct) => {
            let a = Number(aRaw);
            let w = Number(wRaw);
            const volts = Number(v);
            const load = Number(loadPct);
            
            // Normalisasi Ampere
            if (isPiller) {
                a = a * 10; // Piller lapor 0.8, aslinya 8.0 A
            } else {
                a = a / 10; // Standar RFC 1628: 150 = 15.0 A
            }
            
            // MAGIC FORMULA: Jika Amps & Watts mati (0) tapi Load % menyala, kita tebak nilainya
            if (a === 0 && w === 0 && load > 0 && upsKVA > 0) {
                const capacityPerPhaseVA = (upsKVA * 1000) / 3; // Misal 30kVA -> 10,000 VA per fasa
                const apparentVA = (load / 100) * capacityPerPhaseVA;
                if (volts > 0) {
                    a = apparentVA / volts; // V * A = VA -> A = VA / V
                }
                w = apparentVA * 0.9; // Asumsi Power Factor UPS standar = 0.9
            }
            
            return { a, w };
        };

        const phaseR = fixSensor(outputVoltageR, outputCurrentRawR, outputPowerR, outputPercentLoadR);
        const phaseS = fixSensor(outputVoltageS, outputCurrentRawS, outputPowerS, outputPercentLoadS);
        const phaseT = fixSensor(outputVoltageT, outputCurrentRawT, outputPowerT, outputPercentLoadT);

        const addPower = (v, a, w) => {
            if (v !== null) {
                const volts = Number(v);
                if (volts > 0 && a > 0) {
                    const apparentVA = volts * a; // Daya Semu per fasa (S)
                    
                    totalRealPower += w;
                    arithmeticApparentPower += apparentVA;
                    
                    // Hitung Daya Reaktif (Q) per fasa: Q = \u221A(S\u00B2 - P\u00B2)
                    const reactiveVAR = Math.sqrt(Math.max(0, (apparentVA * apparentVA) - (w * w)));
                    totalReactivePower += reactiveVAR;
                    
                    activePhases++;
                }
            }
        };

        addPower(outputVoltageR, phaseR.a, phaseR.w);
        addPower(outputVoltageS, phaseS.a, phaseS.w);
        addPower(outputVoltageT, phaseT.a, phaseT.w);

        let totalPF = '—';
        let finalApparentPower = 0;

        if (arithmeticApparentPower > 0) {
            let calcPF = 0;
            
            if (activePhases <= 1) {
                // RUMUS 1-PHASE (Skalar)
                finalApparentPower = arithmeticApparentPower;
                calcPF = totalRealPower / finalApparentPower;
            } else {
                // RUMUS 3-PHASE (Vektor Pythagoras dari gambar: S = \u221A(P\u00B2 + Q\u00B2))
                finalApparentPower = Math.sqrt(Math.pow(totalRealPower, 2) + Math.pow(totalReactivePower, 2));
                
                if (finalApparentPower > 0) {
                    calcPF = totalRealPower / finalApparentPower; // Cos \u03C6 = P / S
                }
            }

            if (calcPF > 1) calcPF = 1; // Maksimal PF adalah 1
            if (calcPF < 0) calcPF = 0;
            totalPF = Number(calcPF.toFixed(2));
        }

        session.close();

        return {
            success: true,
            status,
            data: {
                connectivity: 'Connected',
                sys_descr: String(sysDescr || '—'),
                sys_name: String(sysName || '—').trim(),
                
                battery_status: batteryStatusStr,
                battery_capacity_pct: chargeRemaining !== null ? String(chargeRemaining) : '—',
                battery_minutes_remaining: minutesRemaining !== null ? String(minutesRemaining) : '—',
                battery_voltage: batteryVoltageRaw !== null ? String(batteryVoltageRaw / 10) : '—', // biasanya satuan 0.1v
                battery_temp_c: batteryTemp !== null ? String(batteryTemp) : '—',
                
                input_voltage_r: inputVoltageR !== null ? String(inputVoltageR) : '—',
                input_voltage_s: inputVoltageS !== null ? String(inputVoltageS) : '—',
                input_voltage_t: inputVoltageT !== null ? String(inputVoltageT) : '—',
                
                output_voltage_r: outputVoltageR !== null ? String(outputVoltageR) : '—',
                output_voltage_s: outputVoltageS !== null ? String(outputVoltageS) : '—',
                output_voltage_t: outputVoltageT !== null ? String(outputVoltageT) : '—',
                
                output_current_r: outputCurrentRawR !== null ? String(phaseR.a.toFixed(1)) : '—',
                output_current_s: outputCurrentRawS !== null ? String(phaseS.a.toFixed(1)) : '—',
                output_current_t: outputCurrentRawT !== null ? String(phaseT.a.toFixed(1)) : '—',
                
                output_load_pct_r: outputPercentLoadR !== null ? String(outputPercentLoadR) : '—',
                output_load_pct_s: outputPercentLoadS !== null ? String(outputPercentLoadS) : '—',
                output_load_pct_t: outputPercentLoadT !== null ? String(outputPercentLoadT) : '—',

                output_power_r: outputPowerR !== null ? String(Math.round(phaseR.w)) : '—',
                output_power_s: outputPowerS !== null ? String(Math.round(phaseS.w)) : '—',
                output_power_t: outputPowerT !== null ? String(Math.round(phaseT.w)) : '—',
                
                debug_apparent_power: String(finalApparentPower),
                debug_real_power: String(totalRealPower),
                debug_calc_pf: (finalApparentPower > 0) ? String(totalRealPower / finalApparentPower) : '—',

                power_factor: totalPF !== '—' ? String(totalPF) : '—',
                
                // Compatibility untuk Frontend yg mungkin cuma pakai 1 parameter general
                input_voltage: inputVoltageR !== null ? String(inputVoltageR) : '—',
                output_voltage: outputVoltageR !== null ? String(outputVoltageR) : '—',
                output_current_ampere: outputCurrentRawR !== null ? String(phaseR.a.toFixed(1)) : '—',
                output_load_pct: outputPercentLoadR !== null ? String(outputPercentLoadR) : '—'
            },
            alarms,
            warnings,
            triggeredParams,
            timestamp: new Date().toISOString(),
        };

    } catch (err) {
        try { session.close(); } catch(e) {}
        return {
            success: false,
            status: 'Disconnect',
            error: err.message,
            data: {
                connectivity: 'Disconnected',
                sys_descr: '—',
                sys_name: '—',
                battery_status: '—',
                battery_capacity_pct: '—',
                battery_minutes_remaining: '—',
                battery_voltage: '—',
                input_voltage: '—',
                output_voltage: '—',
                output_current_ampere: '—',
                output_load_pct: '—'
            },
            alarms: [],
            warnings: [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };
    }
}

// Wrapper dengan timeout untuk mencegah hang
async function pollUPSNetagentWithTimeout(host, community = 'public', options = {}, timeoutMs = 40000) {
    if (typeof options === 'number') {
        timeoutMs = options;
        options = {};
    }

    const effectiveTimeoutMs = Number(options && options.timeoutMs) || timeoutMs;

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({
                success: false,
                status: 'Disconnect',
                error: `Poll timeout (>${Math.round(effectiveTimeoutMs / 1000)}s)`,
                data: {
                    connectivity: 'Disconnected',
                    sys_descr: '—',
                    sys_name: '—',
                    battery_status: '—',
                    battery_capacity_pct: '—',
                    battery_minutes_remaining: '—',
                    battery_voltage: '—',
                    input_voltage: '—',
                    output_voltage: '—',
                    output_current_ampere: '—',
                    output_load_pct: '—'
                },
                alarms: [],
                warnings: [],
                triggeredParams: [],
                timestamp: new Date().toISOString(),
            });
        }, effectiveTimeoutMs);

        pollUPSNetagent(host, community, options).then(result => {
            clearTimeout(timer);
            resolve(result);
        }).catch(err => {
            clearTimeout(timer);
            resolve({
                success: false,
                status: 'Disconnect',
                error: err.message,
                data: {
                    connectivity: 'Disconnected',
                    sys_descr: '—',
                    sys_name: '—',
                    battery_status: '—',
                    battery_capacity_pct: '—',
                    battery_minutes_remaining: '—',
                    battery_voltage: '—',
                    input_voltage: '—',
                    output_voltage: '—',
                    output_current_ampere: '—',
                    output_load_pct: '—'
                },
                alarms: [],
                warnings: [],
                triggeredParams: [],
                timestamp: new Date().toISOString(),
            });
        });
    });
}

module.exports = { pollUPSNetagent: pollUPSNetagentWithTimeout };
