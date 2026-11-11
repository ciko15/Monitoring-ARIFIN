'use strict';

const snmp = require('snmp-native');
const { readAlcatelTemperature, readTemperatureSensors } = require('./snmp_sensor_utils');

const { computeSwitchAudit } = require('./switch_audit_engine');
const auditConfig = require('../config/switch_audit_config');

const OID = {
    sysDescr:    [1, 3, 6, 1, 2, 1, 1, 1, 0],
    sysObjectID: [1, 3, 6, 1, 2, 1, 1, 2, 0],
    sysContact:  [1, 3, 6, 1, 2, 1, 1, 4, 0],
    sysName:     [1, 3, 6, 1, 2, 1, 1, 5, 0],
    sysUpTime:   [1, 3, 6, 1, 2, 1, 1, 3, 0],
    sysLocation: [1, 3, 6, 1, 2, 1, 1, 6, 0],
    ifNumber:    [1, 3, 6, 1, 2, 1, 2, 1, 0],
    ifDescr:     [1, 3, 6, 1, 2, 1, 2, 2, 1, 2],
    ifName:      [1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1],
    ifAdminStatus:[1, 3, 6, 1, 2, 1, 2, 2, 1, 7],
    ifOperStatus:[1, 3, 6, 1, 2, 1, 2, 2, 1, 8],
    ifLastChange:[1, 3, 6, 1, 2, 1, 2, 2, 1, 9],
    ifInDiscards:[1, 3, 6, 1, 2, 1, 2, 2, 1, 13],
    ifInErrors:  [1, 3, 6, 1, 2, 1, 2, 2, 1, 14],
    ifOutDiscards:[1, 3, 6, 1, 2, 1, 2, 2, 1, 19],
    ifOutErrors: [1, 3, 6, 1, 2, 1, 2, 2, 1, 20],
    ifInOctets:  [1, 3, 6, 1, 2, 1, 2, 2, 1, 10],
    ifOutOctets: [1, 3, 6, 1, 2, 1, 2, 2, 1, 16],
    ifHCInOctets:[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 6],
    ifHCOutOctets:[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 10],
    ifHighSpeed: [1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 15],

    // CPU & Memory Storage
    hrProcessorLoad: [1, 3, 6, 1, 2, 1, 25, 3, 3, 1, 2],
    hrStorageType:   [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 2],
    hrStorageAlloc:  [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 4],
    hrStorageSize:   [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 5],
    hrStorageUsed:   [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 6],

    // Hardware Health (Alcatel & RFC ENTITY)
    alcatelPSU:   auditConfig.oids.alcatelPowerSupplyStatus,
    alcatelFan:   auditConfig.oids.alcatelFanStatus,
    alcatelStack: auditConfig.oids.alcatelStackStatus
};

const TYPE_RAM = '1.3.6.1.2.1.25.2.1.2';


function parseHardware(sysDescr) {
    const text = String(sysDescr || '');
    const match = text.match(/(OS\d+-[A-Z0-9-]+)/i);
    if (match) return match[1];
    const words = text.split(' ');
    return words.length >= 4 ? words[3] : '—';
}

function parseOperatingSystem(sysDescr) {
    const text = String(sysDescr || '');
    if (!text) return '—';
    const idx = text.indexOf('OS');
    return idx >= 0 ? text.substring(idx, Math.min(text.length, idx + 80)) : text.substring(0, 120);
}

function formatUptime(ticks) {
    const t = Math.floor(Number(ticks || 0) / 100);
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function normalizeSnmpVersion(version) {
    const value = String(version || '2c').toLowerCase().replace(/^v/, '');
    return value === '1' ? snmp.Versions.SNMPv1 : snmp.Versions.SNMPv2c;
}

function normalizeSnmpOptions(options = {}) {
    if (!options || typeof options !== 'object') return { port: 161, version: '2c' };
    return {
        port: parseInt(options.port, 10) || 161,
        version: options.version || '2c',
    };
}

function createSession(host, community, options = {}) {
    const snmpOptions = normalizeSnmpOptions(options);
    return new snmp.Session({
        host,
        community,
        port: snmpOptions.port,
        version: normalizeSnmpVersion(snmpOptions.version),
        timeouts: [4000, 4000, 4000],
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

function snmpWalkSafe(session, oid, timeoutMs = 4000) {
    return new Promise(resolve => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve([]);
            }
        }, timeoutMs);

        session.getSubtree({ oid, combinedTimeout: timeoutMs }, (err, vbs) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(!err && vbs ? vbs : []);
            }
        });
    });
}

function toIndexMap(vbs) {
    const map = {};
    for (const vb of vbs) {
        const idx = vb.oid[vb.oid.length - 1];
        map[idx] = vb.value;
    }
    return map;
}

function parseCounter(value) {
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number.parseInt(String(value || '0'), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeInterfaceName(name) {
    const text = String(name || '').trim();
    if (!text) return text;

    const portMatch = text.match(/(\d+\/\d+(?:\/\d+)?(?:\.\d+)?)/);
    if (portMatch) return portMatch[1];

    return text
        .replace(/^Alcatel-Lucent Enterprise\s+/i, '')
        .replace(/^Alcatel\s+/i, '')
        .replace(/^Enterprise\s+/i, '')
        .trim();
}

function summarizeInterfaceNames(interfaces) {
    if (!interfaces || interfaces.length === 0) return '—';
    const names = interfaces.map((iface) => normalizeInterfaceName(iface.name));
    return names.join(', ');
}

function pickInterfaceName(idx, descrMap, ifNameMap) {
    const descr = String(descrMap[idx] || '').trim();
    if (descr) return descr;

    const ifName = String(ifNameMap[idx] || '').trim();
    if (ifName) return ifName;

    return `if${idx}`;
}

function buildInterfaceIndexes(...maps) {
    const indexes = new Set();
    for (const map of maps) {
        for (const idx of Object.keys(map || {})) {
            indexes.add(idx);
        }
    }
    return Array.from(indexes).sort((a, b) => Number(a) - Number(b));
}

function operStatusText(code) {
    const map = {
        1: 'up',
        2: 'down',
        3: 'testing',
        4: 'unknown',
        5: 'dormant',
        6: 'notPresent',
        7: 'lowerLayerDown',
    };
    return map[Number(code)] || String(code || 'unknown');
}

async function readSwitchTemperature(session, sysObjectID) {
    const sysObjectIdText = Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '');
    const isAlcatelSwitch = sysObjectIdText.startsWith('1.3.6.1.4.1.6486.');

    if (isAlcatelSwitch) {
        const alcatelTemp = await readAlcatelTemperature(session, snmpWalkSafe, snmpGet);
        if (alcatelTemp.hottest) return alcatelTemp;
    }

    return readTemperatureSensors(session, snmpWalkSafe);
}

const lastKnownSnmpData = new Map();

async function pollSNMP(host, community = 'public', options = {}) {
    const session = createSession(host, community, options);
    try {
        const isV1 = String(options.version || '2c').toLowerCase().replace(/^v/, '') === '1';

        // 1. Ambil System MIB sekaligus dalam 1 batch paket UDP
        const sysOids = [
            OID.sysName, OID.sysDescr, OID.sysObjectID,
            OID.sysContact, OID.sysUpTime, OID.sysLocation, OID.ifNumber
        ];
        const [sysName, sysDescr, sysObjectID, sysContact, sysUpTime, sysLocation, ifNumber] = await snmpGetAll(session, sysOids);

        if (sysName === null && sysDescr === null) {
            throw new Error('No SNMP response');
        }

        const sysObjectIdText = Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '');
        const isAlcatelSwitch = sysObjectIdText.startsWith('1.3.6.1.4.1.6486.');

        // 2. Ambil tabel interface dan metrik dalam batch teratur
        // PENTING: Jangan menjalankan 22 walk sekaligus dalam 1 Promise.all karena socket UDP switch
        // akan mengalami buffer overrun / packet drop, yang mengakibatkan tabel interface kosong (hilang).
        // Kita bagi menjadi 4 batch kecil yang cepat dan stabil.

        // Batch A: Identitas & Status Interface (4 walks)
        const [ifDescrVbs, ifNameVbs, ifAdminVbs, ifOperVbs] = await Promise.all([
            snmpWalkSafe(session, OID.ifDescr, 4000),
            snmpWalkSafe(session, OID.ifName, 4000),
            snmpWalkSafe(session, OID.ifAdminStatus, 3500),
            snmpWalkSafe(session, OID.ifOperStatus, 3500)
        ]);

        // Batch B: Trafik Octets & Speed (5 walks)
        const [ifInOctVbs, ifOutOctVbs, ifHCInOctVbs, ifHCOutOctVbs, ifHighSpeedVbs] = await Promise.all([
            snmpWalkSafe(session, OID.ifInOctets, 3500),
            snmpWalkSafe(session, OID.ifOutOctets, 3500),
            isV1 ? Promise.resolve([]) : snmpWalkSafe(session, OID.ifHCInOctets, 3000),
            isV1 ? Promise.resolve([]) : snmpWalkSafe(session, OID.ifHCOutOctets, 3000),
            snmpWalkSafe(session, OID.ifHighSpeed, 3000)
        ]);

        // Batch C: Discards, Errors, LastChange (5 walks)
        const [ifLastChangeVbs, ifInDiscVbs, ifInErrVbs, ifOutDiscVbs, ifOutErrVbs] = await Promise.all([
            snmpWalkSafe(session, OID.ifLastChange, 3000),
            snmpWalkSafe(session, OID.ifInDiscards, 3000),
            snmpWalkSafe(session, OID.ifInErrors, 3000),
            snmpWalkSafe(session, OID.ifOutDiscards, 3000),
            snmpWalkSafe(session, OID.ifOutErrors, 3000)
        ]);

        // Batch D: CPU, RAM Storage, Hardware Health (PSU, Fan, Stack)
        const [
            cpuVbs,
            storageTypeVbs,
            storageAllocVbs,
            storageSizeVbs,
            storageUsedVbs,
            psuVbs,
            fanVbs,
            stackVbs
        ] = await Promise.all([
            snmpWalkSafe(session, OID.hrProcessorLoad, 3000),
            snmpWalkSafe(session, OID.hrStorageType, 3000),
            snmpWalkSafe(session, OID.hrStorageAlloc, 3000),
            snmpWalkSafe(session, OID.hrStorageSize, 3000),
            snmpWalkSafe(session, OID.hrStorageUsed, 3000),
            isAlcatelSwitch ? snmpWalkSafe(session, OID.alcatelPSU, 3000) : Promise.resolve([]),
            isAlcatelSwitch ? snmpWalkSafe(session, OID.alcatelFan, 3000) : Promise.resolve([]),
            isAlcatelSwitch ? snmpWalkSafe(session, OID.alcatelStack, 3000) : Promise.resolve([])
        ]);

        const descrMap = toIndexMap(ifDescrVbs);
        const ifNameMap = toIndexMap(ifNameVbs);
        const adminMap = toIndexMap(ifAdminVbs);
        const operMap = toIndexMap(ifOperVbs);
        const lastChangeMap = toIndexMap(ifLastChangeVbs);
        const inDiscMap = toIndexMap(ifInDiscVbs);
        const inErrMap = toIndexMap(ifInErrVbs);
        const outDiscMap = toIndexMap(ifOutDiscVbs);
        const outErrMap = toIndexMap(ifOutErrVbs);
        const inOctMap = toIndexMap(ifInOctVbs);
        const outOctMap = toIndexMap(ifOutOctVbs);
        const hcInMap = toIndexMap(ifHCInOctVbs);
        const hcOutMap = toIndexMap(ifHCOutOctVbs);
        const speedMap = toIndexMap(ifHighSpeedVbs);

        const interfaceIndexes = buildInterfaceIndexes(descrMap, ifNameMap, operMap, adminMap, inOctMap, outOctMap, hcInMap, hcOutMap);

        const interfaces = interfaceIndexes.map((idx) => {
            const rawName = pickInterfaceName(idx, descrMap, ifNameMap);
            const name = normalizeInterfaceName(rawName);
            const adminStatus = adminMap[idx] !== undefined ? Number(adminMap[idx]) : 1;
            const operStatus = operMap[idx] !== undefined ? Number(operMap[idx]) : 2;
            const status = operStatusText(operStatus);
            const inOctets = parseCounter(hcInMap[idx] ?? inOctMap[idx]);
            const outOctets = parseCounter(hcOutMap[idx] ?? outOctMap[idx]);
            const speedMbps = speedMap[idx] !== undefined ? Number(speedMap[idx]) : 0;

            return {
                index: idx,
                rawName,
                name,
                adminStatus,
                operStatus,
                status,
                lastChange: parseCounter(lastChangeMap[idx]),
                inDiscards: parseCounter(inDiscMap[idx]),
                inErrors: parseCounter(inErrMap[idx]),
                outDiscards: parseCounter(outDiscMap[idx]),
                outErrors: parseCounter(outErrMap[idx]),
                speedMbps,
                inOctets,
                outOctets,
                totalOctets: inOctets + outOctets,
            };
        });

        const activeInterfaces = interfaces.filter((iface) => iface.status === 'up');
        const downInterfaces = interfaces.filter((iface) => iface.status !== 'up' && iface.status !== 'unknown');
        const busiest = interfaces
            .filter((iface) => iface.totalOctets > 0)
            .sort((a, b) => b.totalOctets - a.totalOctets)[0] || null;

        // 3. Baca Suhu & Sensor
        const tempInfo = await readSwitchTemperature(session, sysObjectID);
        const temperatureSensors = tempInfo.sensors.map((sensor) => ({
            name: sensor.name,
            value_c: sensor.value_c.toFixed(1),
            status: sensor.status,
        }));

        // 4. Kalkulasi CPU Load
        let cpuUsage = null;
        if (cpuVbs && cpuVbs.length > 0) {
            const loads = cpuVbs.map(v => Number(v.value)).filter(v => Number.isFinite(v));
            if (loads.length > 0) {
                cpuUsage = Math.round(loads.reduce((a, b) => a + b, 0) / loads.length);
            }
        }

        // 5. Kalkulasi RAM Storage (tipe RAM 1.3.6.1.2.1.25.2.1.2)
        let ramUsagePct = null;
        let ramTotalMb = 0;
        let ramUsedMb = 0;
        const sTypeMap = toIndexMap(storageTypeVbs);
        const sAllocMap = toIndexMap(storageAllocVbs);
        const sSizeMap = toIndexMap(storageSizeVbs);
        const sUsedMap = toIndexMap(storageUsedVbs);

        for (const sIdx of Object.keys(sTypeMap)) {
            const typeStr = Array.isArray(sTypeMap[sIdx]) ? sTypeMap[sIdx].join('.') : String(sTypeMap[sIdx] || '');
            if (typeStr === TYPE_RAM || typeStr.endsWith('.1.2') || typeStr.includes('storageRam')) {
                const alloc = Number(sAllocMap[sIdx]) || 1024;
                const size = Number(sSizeMap[sIdx]) || 0;
                const used = Number(sUsedMap[sIdx]) || 0;
                const totalBytes = size * alloc;
                const usedBytes = used * alloc;
                ramTotalMb += totalBytes / (1024 * 1024);
                ramUsedMb += usedBytes / (1024 * 1024);
            }
        }
        if (ramTotalMb > 0) {
            ramUsagePct = Math.round((ramUsedMb / ramTotalMb) * 1000) / 10;
        }

        // 6. Evaluasi Hardware Health (PSU, Fan, Stack)
        let psuFault = false;
        const psuList = [];
        if (psuVbs && psuVbs.length > 0) {
            for (const vb of psuVbs) {
                const val = Number(vb.value);
                const isFault = val === 2 || val === 4; // fault or notPresent
                if (isFault) psuFault = true;
                psuList.push({ index: vb.oid[vb.oid.length - 1], status: val === 1 ? 'ok' : 'fault', code: val });
            }
        }

        let fanFault = false;
        const fanList = [];
        if (fanVbs && fanVbs.length > 0) {
            for (const vb of fanVbs) {
                const val = Number(vb.value);
                const isFault = val === 2 || val === 4;
                if (isFault) fanFault = true;
                fanList.push({ index: vb.oid[vb.oid.length - 1], status: val === 1 ? 'ok' : 'fault', code: val });
            }
        }

        const hardwareHealth = {
            psuFault,
            fanFault,
            stackFault: false,
            psuList,
            fanList
        };

        // 7. Hitung Audit Realtime via switch_audit_engine (Pure Function & In-Memory Map)
        const auditPayload = {
            sysUpTimeTicks: sysUpTime,
            interfaces,
            cpuUsage,
            ramUsagePct,
            temperatureC: tempInfo.hottest ? tempInfo.hottest.value_c : null,
            hardwareHealth,
            connectivity: 'Connected'
        };
        const auditResult = computeSwitchAudit(host, auditPayload);

        let finalStatus = 'Normal';
        if (auditResult.health_score === 'Kritis') {
            finalStatus = 'Alarm';
        } else if (auditResult.health_score === 'Peringatan') {
            finalStatus = 'Warning';
        }

        // Kustom Limit DB jika ada
        const limits = options.limits || {};
        const tempLimit = limits['temperature'];
        if (tempLimit && tempInfo.hottest) {
            const tempC = tempInfo.hottest.value_c;
            if (tempLimit.alarm_value != null && tempC >= Number(tempLimit.alarm_value)) {
                finalStatus = 'Alarm';
            } else if (tempLimit.warn_value != null && tempC >= Number(tempLimit.warn_value)) {
                if (finalStatus !== 'Alarm') finalStatus = 'Warning';
            }
        }

        const responseData = {
            connectivity: 'Connected',
            resolved_ip: host,
            sys_name: String(sysName || '—'),
            sys_descr: String(sysDescr || '—').substring(0, 120),
            hardware: parseHardware(sysDescr),
            operating_system: parseOperatingSystem(sysDescr),
            sys_object_id: Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '—'),
            sys_contact: String(sysContact || '—'),
            sys_uptime: sysUpTime !== null ? formatUptime(sysUpTime) : '—',
            sys_uptime_ticks: sysUpTime,
            sys_location: String(sysLocation || '—'),
            interface_count: ifNumber !== null ? String(ifNumber) : '—',
            active_interface_count: String(activeInterfaces.length),
            down_interface_count: String(downInterfaces.length),
            active_interfaces_summary: summarizeInterfaceNames(activeInterfaces),
            down_interfaces_summary: summarizeInterfaceNames(downInterfaces),
            active_interfaces: activeInterfaces.map((iface) => ({
                index: String(iface.index),
                name: iface.name,
                status: iface.status,
                in_octets: String(iface.inOctets),
                out_octets: String(iface.outOctets),
            })),
            down_interfaces: downInterfaces.map((iface) => ({
                index: String(iface.index),
                name: iface.name,
                status: iface.status,
                in_octets: String(iface.inOctets),
                out_octets: String(iface.outOctets),
            })),
            processor_count: '1',
            top_interface_name: busiest ? busiest.name : '—',
            top_interface_status: busiest ? busiest.status : '—',
            top_interface_in_octets: busiest ? String(busiest.inOctets) : '—',
            top_interface_out_octets: busiest ? String(busiest.outOctets) : '—',
            temperature_c: tempInfo.hottest ? tempInfo.hottest.value_c.toFixed(1) : '—',
            temperature_sensor_name: tempInfo.hottest ? tempInfo.hottest.name : '—',
            temperature_sensor_count: String(temperatureSensors.length),
            temperature_sensors: temperatureSensors,
            cpu_usage: cpuUsage !== null ? `${cpuUsage}` : '—',
            ram_usage_pct: ramUsagePct !== null ? `${ramUsagePct}` : '—',
            disk_usage_pct: '—',
            // Data Audit Switch Terpadu
            health_score: auditResult.health_score,
            audit_switch: auditResult
        };

        if (activeInterfaces.length > 0 || interfaces.length > 0) {
            lastKnownSnmpData.set(host, responseData);
        }

        return {
            success: true,
            status: finalStatus,
            data: responseData,
            alarms: finalStatus === 'Alarm' ? ['Health Score Kritis / Alarm Terdeteksi'] : [],
            warnings: finalStatus === 'Warning' ? ['Health Score Peringatan Terdeteksi'] : [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        const prev = lastKnownSnmpData.get(host);
        const fallbackData = prev ? {
            ...prev,
            connectivity: 'Disconnected'
        } : {
            connectivity: 'Disconnected',
            resolved_ip: host,
            sys_name: '—',
            sys_descr: '—',
            hardware: '—',
            operating_system: '—',
            sys_object_id: '—',
            sys_contact: '—',
            sys_uptime: '—',
            sys_location: '—',
            interface_count: '—',
            active_interface_count: '—',
            down_interface_count: '—',
            active_interfaces_summary: '—',
            down_interfaces_summary: '—',
            active_interfaces: [],
            down_interfaces: [],
            processor_count: '—',
            top_interface_name: '—',
            top_interface_status: '—',
            top_interface_in_octets: '—',
            top_interface_out_octets: '—',
            temperature_c: '—',
            temperature_sensor_name: '—',
            temperature_sensor_count: '—',
            temperature_sensors: [],
            cpu_usage: '—',
            ram_usage_pct: '—',
            disk_usage_pct: '—',
        };

        return {
            success: false,
            status: 'Disconnect',
            error: err.message,
            data: fallbackData,
            timestamp: new Date().toISOString(),
        };
    } finally {
        try { session.close(); } catch {}
    }
}

async function pollSNMPWithTimeout(host, community = 'public', options = {}, timeoutMs = 60000) {
    if (typeof options === 'number') {
        timeoutMs = options;
        options = {};
    }

    const snmpOptions = normalizeSnmpOptions(options);
    const effectiveTimeoutMs = Number(options && options.timeoutMs) || timeoutMs;

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            const prev = lastKnownSnmpData.get(host);
            const fallbackData = prev ? { ...prev, connectivity: 'Disconnected' } : {
                connectivity: 'Disconnected',
                resolved_ip: host,
                sys_name: '—', sys_descr: '—', hardware: '—', operating_system: '—', sys_object_id: '—',
                sys_contact: '—', sys_uptime: '—', sys_location: '—', interface_count: '—',
                active_interface_count: '—', down_interface_count: '—',
                active_interfaces_summary: '—', down_interfaces_summary: '—',
                active_interfaces: [], down_interfaces: [], processor_count: '—',
                top_interface_name: '—', top_interface_status: '—', top_interface_in_octets: '—',
                top_interface_out_octets: '—', temperature_c: '—', temperature_sensor_name: '—',
                temperature_sensor_count: '—', temperature_sensors: [], cpu_usage: '—',
                ram_usage_pct: '—', disk_usage_pct: '—',
            };

            resolve({
                success: false,
                status: 'Disconnect',
                error: `SNMP timeout (>${Math.round(effectiveTimeoutMs / 1000)}s)`,
                data: fallbackData,
                timestamp: new Date().toISOString(),
            });
        }, effectiveTimeoutMs);

        pollSNMP(host, community, snmpOptions)
            .then((result) => {
                clearTimeout(timer);
                if (result.success && result.data) {
                    // Update cache jika memiliki data antarmuka valid
                    if (Array.isArray(result.data.active_interfaces) && (result.data.active_interfaces.length > 0 || result.data.interface_count > 0)) {
                        lastKnownSnmpData.set(host, result.data);
                    }
                }
                resolve(result);
            })
            .catch((err) => {
                clearTimeout(timer);
                const prev = lastKnownSnmpData.get(host);
                const fallbackData = prev ? {
                    ...prev,
                    connectivity: 'Disconnected',
                    _status: 'Warning'
                } : {
                    connectivity: 'Disconnected',
                    resolved_ip: host,
                    sys_name: '—', sys_descr: '—', hardware: '—', operating_system: '—', sys_object_id: '—',
                    sys_contact: '—', sys_uptime: '—', sys_location: '—', interface_count: '—',
                    active_interface_count: '—', down_interface_count: '—',
                    active_interfaces_summary: '—', down_interfaces_summary: '—',
                    active_interfaces: [], down_interfaces: [], processor_count: '—',
                    top_interface_name: '—', top_interface_status: '—', top_interface_in_octets: '—',
                    top_interface_out_octets: '—', temperature_c: '—', temperature_sensor_name: '—',
                    temperature_sensor_count: '—', temperature_sensors: [], cpu_usage: '—',
                    ram_usage_pct: '—', disk_usage_pct: '—',
                };

                resolve({
                    success: false,
                    status: 'Disconnect',
                    error: err.message,
                    data: fallbackData,
                    timestamp: new Date().toISOString(),
                });
            });
    });
}

module.exports = { pollSNMP: pollSNMPWithTimeout, pollSNMPRaw: pollSNMP };
