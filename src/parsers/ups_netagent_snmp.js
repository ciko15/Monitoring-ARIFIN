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
    
    // Input
    upsInputVoltage: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 1], // Tegangan input (Phase 1)
    
    // Output
    upsOutputVoltage: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 1], // Tegangan output (Phase 1)
    upsOutputCurrent: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 3, 1], // Arus output (0.1 Ampere, kadang butuh /10)
    upsOutputPercentLoad: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 5, 1], // Persentase beban %
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
        timeouts: [4000, 4000],
    });
}

function snmpGet(session, oid) {
    return new Promise(resolve => {
        session.get({ oid }, (err, vbs) => {
            resolve((!err && vbs && vbs[0]) ? vbs[0].value : null);
        });
    });
}

async function pollUPSNetagent(host, community = 'public', options = {}) {
    const session = createSession(host, community, options);
    
    try {
        const [
            sysDescr, sysName,
            batteryStatusRaw, 
            minutesRemaining, chargeRemaining, 
            batteryVoltageRaw,
            inputVoltage,
            outputVoltage, outputCurrentRaw, outputPercentLoad
        ] = await Promise.all([
            snmpGet(session, OID.sysDescr),
            snmpGet(session, OID.sysName),
            snmpGet(session, OID.upsBatteryStatus),
            snmpGet(session, OID.upsEstimatedMinutesRemaining),
            snmpGet(session, OID.upsEstimatedChargeRemaining),
            snmpGet(session, OID.upsBatteryVoltage),
            snmpGet(session, OID.upsInputVoltage),
            snmpGet(session, OID.upsOutputVoltage),
            snmpGet(session, OID.upsOutputCurrent),
            snmpGet(session, OID.upsOutputPercentLoad)
        ]);

        if (sysDescr === null && inputVoltage === null && outputVoltage === null) {
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
        if (inputVoltage !== null && inputVoltage < 150) {
            status = 'Alarm';
            alarms.push('Listrik Input Mati / Drop (On Battery)');
            triggeredParams.push('input_voltage');
        }

        // Evaluasi Load Beban
        if (outputPercentLoad !== null) {
            if (outputPercentLoad > 90) {
                status = 'Alarm';
                alarms.push('Beban UPS Overload (>90%)');
                triggeredParams.push('output_load_percent');
            } else if (outputPercentLoad > 80) {
                if (status !== 'Alarm') status = 'Warning';
                warnings.push('Beban UPS Tinggi (>80%)');
                triggeredParams.push('output_load_percent');
            }
        }

        // Map status baterai ke teks string
        let batteryStatusStr = 'Unknown';
        if (batteryStatusRaw === 2) batteryStatusStr = 'Normal';
        else if (batteryStatusRaw === 3) batteryStatusStr = 'Low';
        else if (batteryStatusRaw === 4) batteryStatusStr = 'Depleted';

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
                
                input_voltage: inputVoltage !== null ? String(inputVoltage) : '—',
                
                output_voltage: outputVoltage !== null ? String(outputVoltage) : '—',
                output_current_ampere: outputCurrentRaw !== null ? String(outputCurrentRaw / 10) : '—', // biasanya satuan 0.1A
                output_load_pct: outputPercentLoad !== null ? String(outputPercentLoad) : '—'
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
async function pollUPSNetagentWithTimeout(host, community = 'public', options = {}, timeoutMs = 20000) {
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
