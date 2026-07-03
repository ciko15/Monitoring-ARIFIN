/**
 * snmp_system.js — Parser SNMP untuk Server, Workstation, Switch
 * AirNav Indonesia — WAJJ Sentani
 *
 * Library  : snmp-native (pure JS, works on Windows with Bun/Node)
 * Protocol : SNMP v2c UDP port 161
 * Data     : HOST-RESOURCES-MIB + System MIB
 *
 * Storage type OIDs (dari test FDPS1):
 *   1.3.6.1.2.1.25.2.1.1 = hrStorageOther
 *   1.3.6.1.2.1.25.2.1.2 = hrStorageRam        ← RAM
 *   1.3.6.1.2.1.25.2.1.3 = hrStorageVirtualMemory
 *   1.3.6.1.2.1.25.2.1.4 = hrStorageFixedDisk  ← Disk
 *
 * Threshold:
 * - CPU/DISK use used% (WARNING >= 80%, ALARM >= 95%)
 * - RAM use available% for health (WARNING <= 20%, ALARM <= 5%)
 */

'use strict';

const snmp = require('snmp-native');
const { readAlcatelTemperature, readTemperatureSensors, readUcdTemperatureSensors } = require('./snmp_sensor_utils');

const OID = {
    sysDescr:        [1,3,6,1,2,1,1,1,0],
    sysObjectID:     [1,3,6,1,2,1,1,2,0],
    sysContact:      [1,3,6,1,2,1,1,4,0],
    sysName:         [1,3,6,1,2,1,1,5,0],
    sysLocation:     [1,3,6,1,2,1,1,6,0],
    sysUpTime:       [1,3,6,1,2,1,1,3,0],
    hrProcessorLoad: [1,3,6,1,2,1,25,3,3,1,2],
    hrStorageType:   [1,3,6,1,2,1,25,2,3,1,2],
    hrStorageSize:   [1,3,6,1,2,1,25,2,3,1,5],
    hrStorageUsed:   [1,3,6,1,2,1,25,2,3,1,6],
    hrStorageAlloc:  [1,3,6,1,2,1,25,2,3,1,4],
    memTotalSwap:    [1,3,6,1,4,1,2021,4,3,0],
    memAvailSwap:    [1,3,6,1,4,1,2021,4,4,0],
    memTotalReal:    [1,3,6,1,4,1,2021,4,5,0],
    memAvailReal:    [1,3,6,1,4,1,2021,4,6,0],
    memShared:       [1,3,6,1,4,1,2021,4,13,0],
    memBuffer:       [1,3,6,1,4,1,2021,4,14,0],
    memCached:       [1,3,6,1,4,1,2021,4,15,0],
};

// Storage type OID suffixes — nilai persis dari snmp-native (dot-separated string)
const TYPE_RAM  = '1.3.6.1.2.1.25.2.1.2';  // Physical memory
const TYPE_VMEM = '1.3.6.1.2.1.25.2.1.3';  // Virtual memory
const TYPE_DISK = '1.3.6.1.2.1.25.2.1.4';  // Fixed disk / filesystem

const WARN_PCT  = 80;
const ALARM_PCT = 95;
const RAM_AVAIL_WARN_PCT  = 20;
const RAM_AVAIL_ALARM_PCT = 5;
const WARN_TEMP_C = 65;
const ALARM_TEMP_C = 75;

function statusFromPct(pct) {
    if (pct >= ALARM_PCT) return 'Alarm';
    if (pct >= WARN_PCT)  return 'Warning';
    return 'Normal';
}
function statusFromAvailablePct(pct) {
    if (pct <= RAM_AVAIL_ALARM_PCT) return 'Alarm';
    if (pct <= RAM_AVAIL_WARN_PCT)  return 'Warning';
    return 'Normal';
}
function statusFromTemperature(tempC, sysObjectID, sysDescr) {
    const sysObjectIdText = Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '');
    const descr = String(sysDescr || '').toLowerCase();
    
    // Identifikasi apakah perangkat adalah Switch
    const isSwitch = sysObjectIdText.startsWith('1.3.6.1.4.1.6486.') || // Alcatel
                     sysObjectIdText.startsWith('1.3.6.1.4.1.9.') || // Cisco
                     sysObjectIdText.startsWith('1.3.6.1.4.1.14823.') || // Aruba
                     sysObjectIdText.startsWith('1.3.6.1.4.1.2011.') || // Huawei
                     sysObjectIdText.startsWith('1.3.6.1.4.1.4881.') || // Ruijie
                     descr.includes('switch');

    const warnLimit = isSwitch ? 65 : WARN_TEMP_C;
    const alarmLimit = isSwitch ? 75 : ALARM_TEMP_C;

    if (tempC >= alarmLimit) return 'Alarm';
    if (tempC >= warnLimit) return 'Warning';
    return 'Normal';
}
function worstStatus(...s) {
    const p = { Alarm: 3, Warning: 2, Normal: 1, Disconnect: 0 };
    return s.reduce((a, b) => p[a] >= p[b] ? a : b, 'Normal');
}
function formatUptime(ticks) {
    const t = Math.floor(ticks / 100);
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function parseHardware(sysDescr) {
    const text = String(sysDescr || '');
    const match = text.match(/(x86_64|amd64|arm64|aarch64|i386|i686)/i);
    return match ? match[1] : '—';
}

function parseOperatingSystem(sysDescr) {
    const text = String(sysDescr || '');
    if (!text) return '—';
    const linuxMatch = text.match(/Linux\s+([^\s]+)\s+/);
    if (linuxMatch) return `Linux ${linuxMatch[1]}`;
    return text.substring(0, 120);
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
function snmpWalk(session, oid) {
    return new Promise(resolve => {
        session.getSubtree({ oid, combinedTimeout: 12000 }, (err, vbs) => {
            resolve(!err && vbs ? vbs : []);
        });
    });
}

async function readDeviceTemperature(session, sysObjectID) {
    const sysObjectIdText = Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '');
    const isAlcatelDevice = sysObjectIdText.startsWith('1.3.6.1.4.1.6486.');

    if (isAlcatelDevice) {
        const alcatelTemp = await readAlcatelTemperature(session, snmpWalk, snmpGet);
        if (alcatelTemp.hottest) return alcatelTemp;
    }

    const genericSensors = await readTemperatureSensors(session, snmpWalk);
    if (genericSensors.hottest) return genericSensors;

    const ucdSensors = await readUcdTemperatureSensors(session, snmpWalk);
    if (ucdSensors.hottest) return ucdSensors;

    return genericSensors;
}

async function pollSNMP(host, community = 'public', options = {}) {
    const session = createSession(host, community, options);
    try {
        // System info
        const [sysName, sysDescr, sysObjectID, sysContact, sysLocation, sysUpRaw, memTotalSwapKb, memAvailSwapKb, memTotalRealKb, memAvailRealKb, memSharedKb, memBufferKb, memCachedKb] = await Promise.all([
            snmpGet(session, OID.sysName),
            snmpGet(session, OID.sysDescr),
            snmpGet(session, OID.sysObjectID),
            snmpGet(session, OID.sysContact),
            snmpGet(session, OID.sysLocation),
            snmpGet(session, OID.sysUpTime),
            snmpGet(session, OID.memTotalSwap),
            snmpGet(session, OID.memAvailSwap),
            snmpGet(session, OID.memTotalReal),
            snmpGet(session, OID.memAvailReal),
            snmpGet(session, OID.memShared),
            snmpGet(session, OID.memBuffer),
            snmpGet(session, OID.memCached),
        ]);

        if (sysName === null && sysDescr === null) {
            throw new Error('No SNMP response');
        }

        // CPU average
        const cpuVbs = await snmpWalk(session, OID.hrProcessorLoad);
        let cpu_pct = null;
        if (cpuVbs.length > 0) {
            const vals = cpuVbs.map(v => parseFloat(v.value)).filter(v => !isNaN(v));
            if (vals.length) cpu_pct = vals.reduce((a, b) => a + b, 0) / vals.length;
        }

        // Storage walks
        const [typeVbs, sizeVbs, usedVbs, allocVbs] = await Promise.all([
            snmpWalk(session, OID.hrStorageType),
            snmpWalk(session, OID.hrStorageSize),
            snmpWalk(session, OID.hrStorageUsed),
            snmpWalk(session, OID.hrStorageAlloc),
        ]);

        // Build index maps
        // NOTE: hrStorageType value dikembalikan snmp-native sebagai Array OID
        // e.g. [1,3,6,1,2,1,25,2,1,2] — harus di-join('.') untuk compare
        const toMap = vbs => {
            const m = {};
            for (const v of vbs) m[v.oid[v.oid.length - 1]] = v.value;
            return m;
        };
        const oidToStr = v => Array.isArray(v) ? v.join('.') : String(v || '');

        const tm = toMap(typeVbs), sm = toMap(sizeVbs);
        const um = toMap(usedVbs), am = toMap(allocVbs);

        // RAM — sum all hrStorageRam entries
        let ram_total_mb = 0, ram_used_mb = 0, ram_entries = 0;
        // Disk — largest hrStorageFixedDisk entry
        let disk_total_gb = null, disk_used_gb = null;

        for (const idx of Object.keys(tm)) {
            const typeStr  = oidToStr(tm[idx]);  // Array → "1.3.6.1.2.1.25.2.1.x"
            const alloc    = parseInt(am[idx]) || 1024;
            const total    = (parseInt(sm[idx]) || 0) * alloc;
            const used     = (parseInt(um[idx]) || 0) * alloc;

            if (typeStr === TYPE_RAM) {
                ram_total_mb += total / (1024 * 1024);
                ram_used_mb  += used  / (1024 * 1024);
                ram_entries++;
            } else if (typeStr === TYPE_DISK) {
                // Ambil disk terbesar (skip filesystem virtual kecil)
                const totalGb = total / (1024 * 1024 * 1024);
                if (totalGb > 1.0 && totalGb > (disk_total_gb || 0)) {
                    disk_total_gb = totalGb;
                    disk_used_gb  = used / (1024 * 1024 * 1024);
                }
            }
        }

        // RAM: sum semua entry TYPE_RAM (biasanya hanya 1 entry = Physical memory)
        const ram_total_final = ram_total_mb > 0 ? ram_total_mb : null;
        const ram_used_final  = ram_used_mb  > 0 ? ram_used_mb  : null;

        const ram_pct  = (ram_total_final && ram_total_final > 0)
            ? (ram_used_final / ram_total_final * 100) : null;
        const ram_available_mb = (ram_total_final !== null && ram_used_final !== null)
            ? Math.max(0, ram_total_final - ram_used_final) : null;
        const ram_available_pct = (ram_total_final && ram_total_final > 0 && ram_available_mb !== null)
            ? (ram_available_mb / ram_total_final * 100) : null;
        const disk_pct = (disk_total_gb && disk_total_gb > 0)
            ? (disk_used_gb / disk_total_gb * 100) : null;

        const memTotalSwapMb = memTotalSwapKb !== null ? Number(memTotalSwapKb) / 1024 : null;
        const memAvailSwapMb = memAvailSwapKb !== null ? Number(memAvailSwapKb) / 1024 : null;
        const memUsedSwapMb = (memTotalSwapMb !== null && memAvailSwapMb !== null) ? Math.max(0, memTotalSwapMb - memAvailSwapMb) : null;
        const memSwapPct = (memTotalSwapMb && memTotalSwapMb > 0 && memUsedSwapMb !== null) ? (memUsedSwapMb / memTotalSwapMb * 100) : null;

        const memTotalRealMbRaw = memTotalRealKb !== null ? Number(memTotalRealKb) / 1024 : null;
        const memAvailRealMbRaw = memAvailRealKb !== null ? Number(memAvailRealKb) / 1024 : null;
        const memUsedRealMbRaw = (memTotalRealMbRaw !== null && memAvailRealMbRaw !== null) ? Math.max(0, memTotalRealMbRaw - memAvailRealMbRaw) : null;
        const memRealPctRaw = (memTotalRealMbRaw && memTotalRealMbRaw > 0 && memUsedRealMbRaw !== null) ? (memUsedRealMbRaw / memTotalRealMbRaw * 100) : null;

        const processor_count = cpuVbs.length > 0 ? String(cpuVbs.length) : '—';
        const tempInfo = await readDeviceTemperature(session, sysObjectID);
        const temperatureSensors = tempInfo.sensors.map((sensor) => ({
            name: sensor.name,
            value_c: sensor.value_c.toFixed(1),
            status: sensor.status,
        }));

        const s_cpu  = cpu_pct  !== null ? statusFromPct(cpu_pct)  : 'Normal';
        const s_ram  = ram_available_pct !== null ? statusFromAvailablePct(ram_available_pct) : 'Normal';
        const s_disk = disk_pct !== null ? statusFromPct(disk_pct) : 'Normal';
        const s_temp = tempInfo.hottest !== null
            ? statusFromTemperature(tempInfo.hottest.value_c, sysObjectID, sysDescr)
            : 'Normal';
        const status = worstStatus(s_cpu, s_ram, s_disk, s_temp);

        session.close();
        return {
            success: true,
            status,
            data: {
                connectivity:   'Connected',
                resolved_ip:    host,
                sys_name:       String(sysName  || '—'),
                sys_descr:      String(sysDescr || '—').substring(0, 80),
                hardware:       parseHardware(sysDescr),
                operating_system: parseOperatingSystem(sysDescr),
                sys_object_id:  Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '—'),
                sys_contact:    String(sysContact || '—'),
                sys_location:   String(sysLocation || '—'),
                sys_uptime:     sysUpRaw !== null ? formatUptime(sysUpRaw) : '—',
                processor_count,
                cpu_usage:      cpu_pct  !== null ? cpu_pct.toFixed(1)           : '—',
                ram_total_mb:   ram_total_final  !== null ? ram_total_final.toFixed(0)  : '—',
                ram_used_mb:    ram_used_final   !== null ? ram_used_final.toFixed(0)   : '—',
                ram_usage_pct:  ram_pct          !== null ? ram_pct.toFixed(1)          : '—',
                ram_available_mb:  ram_available_mb  !== null ? ram_available_mb.toFixed(0)  : '—',
                ram_available_pct: ram_available_pct !== null ? ram_available_pct.toFixed(1) : '—',
                physical_memory_total_mb: memTotalRealMbRaw !== null ? memTotalRealMbRaw.toFixed(0) : '—',
                physical_memory_used_mb: memUsedRealMbRaw !== null ? memUsedRealMbRaw.toFixed(0) : '—',
                physical_memory_usage_pct: memRealPctRaw !== null ? memRealPctRaw.toFixed(1) : '—',
                virtual_memory_total_mb: memTotalSwapMb !== null ? memTotalSwapMb.toFixed(0) : '—',
                virtual_memory_used_mb: memUsedSwapMb !== null ? memUsedSwapMb.toFixed(0) : '—',
                virtual_memory_usage_pct: memSwapPct !== null ? memSwapPct.toFixed(1) : '—',
                memory_buffers_mb: memBufferKb !== null ? (Number(memBufferKb) / 1024).toFixed(1) : '—',
                cached_memory_mb: memCachedKb !== null ? (Number(memCachedKb) / 1024).toFixed(1) : '—',
                shared_memory_mb: memSharedKb !== null ? (Number(memSharedKb) / 1024).toFixed(1) : '—',
                swap_total_mb: memTotalSwapMb !== null ? memTotalSwapMb.toFixed(0) : '—',
                swap_used_mb: memUsedSwapMb !== null ? memUsedSwapMb.toFixed(0) : '—',
                swap_usage_pct: memSwapPct !== null ? memSwapPct.toFixed(1) : '—',
                disk_total_gb:  disk_total_gb    !== null ? disk_total_gb.toFixed(1)    : '—',
                disk_used_gb:   disk_used_gb     !== null ? disk_used_gb.toFixed(1)     : '—',
                disk_usage_pct: disk_pct         !== null ? disk_pct.toFixed(1)         : '—',
                temperature_c: tempInfo.hottest ? tempInfo.hottest.value_c.toFixed(1) : '—',
                temperature_sensor_name: tempInfo.hottest ? tempInfo.hottest.name : '—',
                temperature_sensor_count: String(temperatureSensors.length),
                temperature_sensors: temperatureSensors,
            },
            alarms:          status === 'Alarm'   ? ['Resource usage critical or temperature high'] : [],
            warnings:        status === 'Warning' ? ['Resource usage high or temperature elevated']     : [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };

    } catch (err) {
        try { session.close(); } catch(e) {}
        return {
            success: false,
            status: 'Disconnect',
            error:  err.message,
            data: {
                connectivity: 'Disconnected',
                resolved_ip: host,
                sys_name: '—', sys_descr: '—', sys_uptime: '—',
                hardware: '—', operating_system: '—', sys_object_id: '—', sys_contact: '—', sys_location: '—',
                processor_count: '—',
                cpu_usage: '—',
                ram_total_mb: '—', ram_used_mb: '—', ram_usage_pct: '—',
                ram_available_mb: '—', ram_available_pct: '—',
                physical_memory_total_mb: '—', physical_memory_used_mb: '—', physical_memory_usage_pct: '—',
                virtual_memory_total_mb: '—', virtual_memory_used_mb: '—', virtual_memory_usage_pct: '—',
                memory_buffers_mb: '—', cached_memory_mb: '—', shared_memory_mb: '—',
                swap_total_mb: '—', swap_used_mb: '—', swap_usage_pct: '—',
                disk_total_gb: '—', disk_used_gb: '—', disk_usage_pct: '—',
                temperature_c: '—', temperature_sensor_name: '—', temperature_sensor_count: '—', temperature_sensors: [],
            },
            timestamp: new Date().toISOString(),
        };
    }
}

// Wrapper dengan hard timeout — mencegah hang di Bun runtime
async function pollSNMPWithTimeout(host, community = 'public', options = {}, timeoutMs = 20000) {
    if (typeof options === 'number') {
        timeoutMs = options;
        options = {};
    }

    const snmpOptions = normalizeSnmpOptions(options);
    const effectiveTimeoutMs = Number(options && options.timeoutMs) || timeoutMs;

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({
                success: false,
                status: 'Disconnect',
                error:  `Poll timeout (>${Math.round(effectiveTimeoutMs / 1000)}s)`,
                data: {
                    connectivity: 'Disconnected',
                    resolved_ip: host,
                    sys_name: '—', sys_descr: '—', sys_uptime: '—',
                    hardware: '—', operating_system: '—', sys_object_id: '—', sys_contact: '—', sys_location: '—',
                    processor_count: '—',
                    cpu_usage: '—',
                    ram_total_mb: '—', ram_used_mb: '—', ram_usage_pct: '—',
                    ram_available_mb: '—', ram_available_pct: '—',
                    physical_memory_total_mb: '—', physical_memory_used_mb: '—', physical_memory_usage_pct: '—',
                    virtual_memory_total_mb: '—', virtual_memory_used_mb: '—', virtual_memory_usage_pct: '—',
                    memory_buffers_mb: '—', cached_memory_mb: '—', shared_memory_mb: '—',
                    swap_total_mb: '—', swap_used_mb: '—', swap_usage_pct: '—',
                    disk_total_gb: '—', disk_used_gb: '—', disk_usage_pct: '—',
                    temperature_c: '—', temperature_sensor_name: '—', temperature_sensor_count: '—', temperature_sensors: [],
                },
                timestamp: new Date().toISOString(),
            });
        }, effectiveTimeoutMs);

        pollSNMP(host, community, snmpOptions).then(result => {
            clearTimeout(timer);
            resolve(result);
        }).catch(err => {
            clearTimeout(timer);
            resolve({
                success: false,
                status: 'Disconnect',
                error:  err.message,
                data: {
                    connectivity: 'Disconnected',
                    resolved_ip: host,
                    sys_name: '—', sys_descr: '—', sys_uptime: '—',
                    hardware: '—', operating_system: '—', sys_object_id: '—', sys_contact: '—', sys_location: '—',
                    processor_count: '—',
                    cpu_usage: '—',
                    ram_total_mb: '—', ram_used_mb: '—', ram_usage_pct: '—',
                    ram_available_mb: '—', ram_available_pct: '—',
                    physical_memory_total_mb: '—', physical_memory_used_mb: '—', physical_memory_usage_pct: '—',
                    virtual_memory_total_mb: '—', virtual_memory_used_mb: '—', virtual_memory_usage_pct: '—',
                    memory_buffers_mb: '—', cached_memory_mb: '—', shared_memory_mb: '—',
                    swap_total_mb: '—', swap_used_mb: '—', swap_usage_pct: '—',
                    disk_total_gb: '—', disk_used_gb: '—', disk_usage_pct: '—',
                    temperature_c: '—', temperature_sensor_name: '—', temperature_sensor_count: '—', temperature_sensors: [],
                },
                timestamp: new Date().toISOString(),
            });
        });
    });
}

module.exports = { pollSNMP: pollSNMPWithTimeout, pollSNMPRaw: pollSNMP };
