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

const fs = require('fs');
const path = require('path');
const snmp = require('snmp-native');
const { readAlcatelTemperature, readTemperatureSensors, readUcdTemperatureSensors } = require('./snmp_sensor_utils');
const auditConfig = require('../config/server_audit_config');
const { computeServerAudit } = require('./server_audit_engine');

// Cache in-memory audit server & proses agar UI audit tidak pernah kosong/blank
const lastKnownAuditServerMap = new Map();

const OID = {
    sysDescr: [1, 3, 6, 1, 2, 1, 1, 1, 0],
    sysObjectID: [1, 3, 6, 1, 2, 1, 1, 2, 0],
    sysContact: [1, 3, 6, 1, 2, 1, 1, 4, 0],
    sysName: [1, 3, 6, 1, 2, 1, 1, 5, 0],
    sysLocation: [1, 3, 6, 1, 2, 1, 1, 6, 0],
    sysUpTime: [1, 3, 6, 1, 2, 1, 1, 3, 0],
    hrProcessorLoad: [1, 3, 6, 1, 2, 1, 25, 3, 3, 1, 2],
    hrStorageType: [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 2],
    hrStorageSize: [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 5],
    hrStorageUsed: [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 6],
    hrStorageAlloc: [1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 4],
    memTotalSwap: [1, 3, 6, 1, 4, 1, 2021, 4, 3, 0],
    memAvailSwap: [1, 3, 6, 1, 4, 1, 2021, 4, 4, 0],
    memTotalReal: [1, 3, 6, 1, 4, 1, 2021, 4, 5, 0],
    memAvailReal: [1, 3, 6, 1, 4, 1, 2021, 4, 6, 0],
    memShared: [1, 3, 6, 1, 4, 1, 2021, 4, 13, 0],
    memBuffer: [1, 3, 6, 1, 4, 1, 2021, 4, 14, 0],
    memCached: [1, 3, 6, 1, 4, 1, 2021, 4, 15, 0],
};

// Storage type OID suffixes — nilai persis dari snmp-native (dot-separated string)
const TYPE_RAM = '1.3.6.1.2.1.25.2.1.2';  // Physical memory
const TYPE_VMEM = '1.3.6.1.2.1.25.2.1.3';  // Virtual memory
const TYPE_DISK = '1.3.6.1.2.1.25.2.1.4';  // Fixed disk / filesystem

// Default threshold values — digunakan jika tidak ada konfigurasi alarm limit di database.
// Untuk mengubah batas ini, tambahkan parameter pada halaman Alarm Limit perangkat:
//   cpu_usage_warn, cpu_usage_alarm
//   ram_available_pct_warn, ram_available_pct_alarm
//   disk_usage_pct_warn, disk_usage_pct_alarm
//   temperature_warn, temperature_alarm
const DEFAULT_LIMITS = {
    // cpu_usage_warn:          80,
    // cpu_usage_alarm:         95,
    // ram_available_pct_warn:  20,
    // ram_available_pct_alarm: 5,
    // disk_usage_pct_warn:     80,
    // disk_usage_pct_alarm:    95,
    // temperature_warn:        65,
    // temperature_alarm:       75,
};

/**
 * Ambil nilai limit dari objek limits kustom (dari DB) dengan fallback ke DEFAULT_LIMITS.
 * @param {Object} limits - Objek limits dari DB, formatnya: { [param]: { warn_value, alarm_value } }
 * @param {string} param - Nama parameter (mis. 'cpu_usage')
 * @returns {{ warn: number, alarm: number }}
 */
function getLimit(limits, param) {
    const entry = limits && limits[param];
    if (!entry) return { warn: undefined, alarm: undefined };
    return {
        warn: entry.warn_value != null ? Number(entry.warn_value) : undefined,
        alarm: entry.alarm_value != null ? Number(entry.alarm_value) : undefined,
    };
}

function statusFromPct(pct, limits, param) {
    const { warn, alarm } = getLimit(limits, param);
    if (alarm !== undefined && pct >= alarm) return 'Alarm';
    if (warn !== undefined && pct >= warn) return 'Warning';
    return 'Normal';
}
function statusFromAvailablePct(pct, limits) {
    const entry = limits && limits['ram_available_pct'];
    if (!entry) return 'Normal';
    const warnLim = entry.warn_value != null ? Number(entry.warn_value) : undefined;
    const alarmLim = entry.alarm_value != null ? Number(entry.alarm_value) : undefined;
    if (alarmLim !== undefined && pct <= alarmLim) return 'Alarm';
    if (warnLim !== undefined && pct <= warnLim) return 'Warning';
    return 'Normal';
}
function statusFromTemperature(tempC, sysObjectID, sysDescr, limits) {
    const entry = limits && limits['temperature'];
    if (!entry) return 'Normal';
    const warnLimit = entry.warn_value != null ? Number(entry.warn_value) : undefined;
    const alarmLimit = entry.alarm_value != null ? Number(entry.alarm_value) : undefined;

    if (alarmLimit !== undefined && tempC >= alarmLimit) return 'Alarm';
    if (warnLimit !== undefined && tempC >= warnLimit) return 'Warning';
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
        timeouts: [3000, 4000, 5000],
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
function snmpWalk(session, oid) {
    return new Promise(resolve => {
        session.getSubtree({ oid, combinedTimeout: 12000 }, (err, vbs) => {
            resolve(!err && vbs ? vbs : []);
        });
    });
}

function snmpWalkSafe(session, oid, timeoutMs = 4000, maxRows = 500) {
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
                if (err || !vbs) return resolve([]);
                resolve(vbs.slice(0, maxRows));
            }
        });
    });
}

function toIndexMap(vbs) {
    const map = {};
    for (const vb of vbs) {
        if (!vb || !vb.oid) continue;
        const idx = vb.oid[vb.oid.length - 1];
        map[idx] = vb.value;
    }
    return map;
}

function loadWatchlistForHost(host, discoveredProcesses = []) {
    try {
        const filePath = path.resolve(process.cwd(), 'db/server_watchlist_config.json');
        let parsed = {};
        if (fs.existsSync(filePath)) {
            try {
                parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                parsed = {};
            }
        }

        // 1. Cek format Object Key: { "172.20.8.68": { apps: [...] } }
        if (host && parsed[host] && Array.isArray(parsed[host].apps)) {
            return parsed[host].apps;
        }

        // 2. Cek format Array: { "watchlist": [ { "device": "172.20.8.68", "apps": [...] } ] }
        if (Array.isArray(parsed.watchlist)) {
            const found = parsed.watchlist.find(w => w.device === host);
            if (found && Array.isArray(found.apps)) {
                return found.apps;
            }
        }

        // 3. AUTO-DISCOVERY PERANGKAT BARU:
        // Jika host belum punya watchlist dan ada proses nyata yang berhasil ditarik lewat SNMP
        if (host && Array.isArray(discoveredProcesses) && discoveredProcesses.length > 0) {
            const ignoreList = new Set(auditConfig.systemProcessIgnoreList.map(s => s.toLowerCase()));
            const candidateApps = [];
            const seenNames = new Set();

            for (const p of discoveredProcesses) {
                const name = String(p.name || '').trim();
                const nameLower = name.toLowerCase();
                if (!name || seenNames.has(nameLower)) continue;
                if (ignoreList.has(nameLower)) continue;
                if (nameLower.startsWith('kworker') || nameLower.startsWith('rcu_') || nameLower.startsWith('scsi_')) continue;
                if (p.type === 'operatingSystem' || p.type === 'deviceDriver') continue;

                // Kandidat aplikasi / service yang berjalan nyata
                seenNames.add(nameLower);
                candidateApps.push({
                    name: name.charAt(0).toUpperCase() + name.slice(1),
                    match: {
                        type: 'process',
                        name: name
                    },
                    expectedCount: 1,
                    severity: 'critical'
                });

                if (candidateApps.length >= 10) break; // Ambil hingga 10 service utama pertama
            }

            if (candidateApps.length > 0) {
                // Simpan otomatis ke server_watchlist_config.json
                parsed[host] = {
                    device: host,
                    description: `Auto-discovered Watchlist untuk ${host}`,
                    updated_at: new Date().toISOString(),
                    apps: candidateApps
                };

                try {
                    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
                    console.log(`[SERVER AUDIT] Auto-discovery watchlist created for host ${host} (${candidateApps.length} apps)`);
                } catch (writeErr) {
                    console.warn(`[SERVER AUDIT] Failed to save auto-discovered watchlist:`, writeErr.message);
                }

                return candidateApps;
            }
        }
    } catch (e) {
        // fallback
    }
    return [];
}

async function readDeviceTemperature(session, sysObjectID, sysDescr) {
    const sysObjectIdText = Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '');
    const descr = String(sysDescr || '').toLowerCase();
    const isAlcatelDevice = sysObjectIdText.startsWith('1.3.6.1.4.1.6486.');
    const isLinux = sysObjectIdText.startsWith('1.3.6.1.4.1.8072.') || sysObjectIdText.startsWith('1.3.6.1.4.1.2021.') || descr.includes('linux');

    if (isAlcatelDevice) {
        const alcatelTemp = await readAlcatelTemperature(session, snmpWalk, snmpGet);
        if (alcatelTemp.hottest) return alcatelTemp;
    }

    if (isLinux) {
        const ucdSensors = await readUcdTemperatureSensors(session, snmpWalk);
        if (ucdSensors.hottest) return ucdSensors;
    } else {
        const genericSensors = await readTemperatureSensors(session, snmpWalk);
        if (genericSensors.hottest) return genericSensors;

        const ucdSensors = await readUcdTemperatureSensors(session, snmpWalk);
        if (ucdSensors.hottest) return ucdSensors;
    }

    return { sensors: [], hottest: null };
}

async function pollSNMP(host, community = 'public', options = {}) {
    // limits: objek dari DB alarm limit, format { [param_name]: { warn_value, alarm_value } }
    // Diteruskan dari network_listener.js saat memanggil pollSNMP.
    const limits = options.limits || null;
    const session = createSession(host, community, options);
    try {
        // Memecah menjadi dua batch agar paket UDP tidak terlalu besar dan di-drop oleh network switch
        const oids1 = [OID.sysName, OID.sysDescr, OID.sysObjectID, OID.sysContact, OID.sysLocation, OID.sysUpTime];
        const oids2 = [OID.memTotalSwap, OID.memAvailSwap, OID.memTotalReal, OID.memAvailReal, OID.memShared, OID.memBuffer, OID.memCached];

        const [
            [sysName, sysDescr, sysObjectID, sysContact, sysLocation, sysUpRaw],
            [memTotalSwapKb, memAvailSwapKb, memTotalRealKb, memAvailRealKb, memSharedKb, memBufferKb, memCachedKb],
            cpuVbs
        ] = await Promise.all([
            snmpGetAll(session, oids1),
            snmpGetAll(session, oids2),
            snmpWalk(session, OID.hrProcessorLoad)
        ]);

        if (sysName === null && sysDescr === null) {
            throw new Error('No SNMP response');
        }

        // CPU average
        let cpu_pct = null;
        if (cpuVbs.length > 0) {
            const vals = cpuVbs.map(v => parseFloat(v.value)).filter(v => !isNaN(v));
            if (vals.length) cpu_pct = vals.reduce((a, b) => a + b, 0) / vals.length;
        }

        const walkOids = [OID.hrStorageType, OID.hrStorageSize, OID.hrStorageUsed, OID.hrStorageAlloc];
        const [typeVbs, sizeVbs, usedVbs, allocVbs] = await Promise.all(
            walkOids.map(oid => snmpWalk(session, oid))
        );

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
            const typeStr = oidToStr(tm[idx]);  // Array → "1.3.6.1.2.1.25.2.1.x"
            const alloc = parseInt(am[idx]) || 1024;
            const total = (parseInt(sm[idx]) || 0) * alloc;
            const used = (parseInt(um[idx]) || 0) * alloc;

            if (typeStr === TYPE_RAM) {
                ram_total_mb += total / (1024 * 1024);
                ram_used_mb += used / (1024 * 1024);
                ram_entries++;
            } else if (typeStr === TYPE_DISK) {
                // Ambil disk terbesar (skip filesystem virtual kecil)
                const totalGb = total / (1024 * 1024 * 1024);
                if (totalGb > 1.0 && totalGb > (disk_total_gb || 0)) {
                    disk_total_gb = totalGb;
                    disk_used_gb = used / (1024 * 1024 * 1024);
                }
            }
        }

        // RAM: sum semua entry TYPE_RAM (biasanya hanya 1 entry = Physical memory)
        const ram_total_final = ram_total_mb > 0 ? ram_total_mb : null;
        const ram_used_final = ram_used_mb > 0 ? ram_used_mb : null;

        const ram_pct = (ram_total_final && ram_total_final > 0)
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
        const tempInfo = await readDeviceTemperature(session, sysObjectID, sysDescr);
        const temperatureSensors = tempInfo.sensors.map((sensor) => ({
            name: sensor.name,
            value_c: sensor.value_c.toFixed(1),
            status: sensor.status,
        }));

        const s_cpu = cpu_pct !== null ? statusFromPct(cpu_pct, limits, 'cpu_usage') : 'Normal';
        const s_ram = ram_available_pct !== null ? statusFromAvailablePct(ram_available_pct, limits) : 'Normal';
        const s_disk = disk_pct !== null ? statusFromPct(disk_pct, limits, 'disk_usage_pct') : 'Normal';
        const s_temp = tempInfo.hottest !== null
            ? statusFromTemperature(tempInfo.hottest.value_c, sysObjectID, sysDescr, limits)
            : 'Normal';
        const status = worstStatus(s_cpu, s_ram, s_disk, s_temp);

        function buildStructuredSystemData(raw) {
            return {
                // Backward-compatibility: Root-level flat properties
                ...raw,

                // Nested categories per request
                'SISTEM': {
                    connectivity: raw.connectivity,
                    sys_name: raw.sys_name,
                    sys_descr: raw.sys_descr,
                    hardware: raw.hardware,
                    operating_system: raw.operating_system,
                    sys_uptime: raw.sys_uptime,
                    sys_contact: raw.sys_contact,
                    sys_location: raw.sys_location
                },
                'CPU': {
                    cpu_usage: raw.cpu_usage,
                    processor_count: raw.processor_count
                },
                'TEMPERATURE': {
                    temperature_c: raw.temperature_c,
                    temperature_sensor_name: raw.temperature_sensor_name,
                    temperature_sensor_count: raw.temperature_sensor_count
                },
                'MEMORY (RAM)': {
                    ram_total_mb: raw.ram_total_mb,
                    ram_used_mb: raw.ram_used_mb,
                    ram_available_mb: raw.ram_available_mb,
                    ram_usage_pct: raw.ram_usage_pct,
                    ram_available_pct: raw.ram_available_pct
                },
                'MEMORY (PHYSICAL / VIRTUAL / SWAP)': {
                    physical_memory_total_mb: raw.physical_memory_total_mb,
                    physical_memory_usage_pct: raw.physical_memory_usage_pct,
                    virtual_memory_total_mb: raw.virtual_memory_total_mb,
                    virtual_memory_usage_pct: raw.virtual_memory_usage_pct,
                    swap_total_mb: raw.swap_total_mb,
                    swap_used_mb: raw.swap_used_mb,
                    memory_buffers_mb: raw.memory_buffers_mb,
                    cached_memory_mb: raw.cached_memory_mb,
                    shared_memory_mb: raw.shared_memory_mb
                },
                'DISK': {
                    disk_total_gb: raw.disk_total_gb,
                    disk_used_gb: raw.disk_used_gb,
                    disk_usage_pct: raw.disk_usage_pct
                }
            };
        }

        const rawData = {
            connectivity: 'Connected',
            resolved_ip: host,
            sys_name: String(sysName || '—'),
            sys_descr: String(sysDescr || '—').substring(0, 80),
            hardware: parseHardware(sysDescr),
            operating_system: parseOperatingSystem(sysDescr),
            sys_object_id: Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '—'),
            sys_contact: String(sysContact || '—'),
            sys_location: String(sysLocation || '—'),
            sys_uptime: sysUpRaw !== null ? formatUptime(sysUpRaw) : '—',
            processor_count,
            cpu_usage: cpu_pct !== null ? cpu_pct.toFixed(1) : '—',
            ram_total_mb: ram_total_final !== null ? ram_total_final.toFixed(0) : '—',
            ram_used_mb: ram_used_final !== null ? ram_used_final.toFixed(0) : '—',
            ram_usage_pct: ram_pct !== null ? ram_pct.toFixed(1) : '—',
            ram_available_mb: ram_available_mb !== null ? ram_available_mb.toFixed(0) : '—',
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
            disk_total_gb: disk_total_gb !== null ? disk_total_gb.toFixed(1) : '—',
            disk_used_gb: disk_used_gb !== null ? disk_used_gb.toFixed(1) : '—',
            disk_usage_pct: disk_pct !== null ? disk_pct.toFixed(1) : '—',
            temperature_c: tempInfo.hottest ? tempInfo.hottest.value_c.toFixed(1) : '—',
            temperature_sensor_name: tempInfo.hottest ? tempInfo.hottest.name : '—',
            temperature_sensor_count: String(temperatureSensors.length),
            temperature_sensors: temperatureSensors,
        };

        // ── BAGIAN AUDIT APLIKASI SERVER / PC ─────────────────────────────────
        // Berjalan aman untuk mengambil proses & service dengan session terdedikasi
        let auditServerResult = null;
        let auditSession = null;
        try {
            const auditOids = auditConfig.oids;
            const snmpOpts = normalizeSnmpOptions(options);
            // Gunakan session terpisah agar walk subtree tidak bersaing paket UDP dengan polling telemetri
            auditSession = new snmp.Session({
                host,
                community,
                port: snmpOpts.port,
                version: normalizeSnmpVersion(snmpOpts.version),
                timeouts: [3000, 5000, 7000],
            });

            const [
                runIndexVbs, runNameVbs, runPathVbs, runParamVbs, runTypeVbs, runStatusVbs,
                perfCpuVbs, perfMemVbs,
                svcNameVbs, svcOpStateVbs,
                prNameVbs, prMinVbs, prMaxVbs, prCountVbs, prErrFlagVbs, prErrMsgVbs
            ] = await Promise.all([
                snmpWalkSafe(auditSession, auditOids.hrSWRunIndex, 12000, 500),
                snmpWalkSafe(auditSession, auditOids.hrSWRunName, 12000, 500),
                snmpWalkSafe(auditSession, auditOids.hrSWRunPath, 12000, 500),
                snmpWalkSafe(auditSession, auditOids.hrSWRunParameters, 8000, 500),
                snmpWalkSafe(auditSession, auditOids.hrSWRunType, 8000, 500),
                snmpWalkSafe(auditSession, auditOids.hrSWRunStatus, 8000, 500),
                snmpWalkSafe(auditSession, auditOids.hrSWRunPerfCPU, 8000, 500),
                snmpWalkSafe(auditSession, auditOids.hrSWRunPerfMem, 8000, 500),
                snmpWalkSafe(auditSession, auditOids.svSvcName, 4000, 200),
                snmpWalkSafe(auditSession, auditOids.svSvcOperatingState, 4000, 200),
                snmpWalkSafe(auditSession, auditOids.prNames, 3000, 100),
                snmpWalkSafe(auditSession, auditOids.prMin, 3000, 100),
                snmpWalkSafe(auditSession, auditOids.prMax, 3000, 100),
                snmpWalkSafe(auditSession, auditOids.prCount, 3000, 100),
                snmpWalkSafe(auditSession, auditOids.prErrorFlag, 3000, 100),
                snmpWalkSafe(auditSession, auditOids.prErrMessage, 3000, 100)
            ]);

            // Mapping hrSWRunEntry
            const runNameMap = toIndexMap(runNameVbs);
            const runPathMap = toIndexMap(runPathVbs);
            const runParamMap = toIndexMap(runParamVbs);
            const runTypeMap = toIndexMap(runTypeVbs);
            const runStatusMap = toIndexMap(runStatusVbs);
            const perfCpuMap = toIndexMap(perfCpuVbs);
            const perfMemMap = toIndexMap(perfMemVbs);

            // Tipe hrSWRunType: 1=unknown, 2=operatingSystem, 3=deviceDriver, 4=application
            const swTypeLabel = (t) => {
                const code = Number(t);
                if (code === 4) return 'application';
                if (code === 2) return 'operatingSystem';
                if (code === 3) return 'deviceDriver';
                return 'unknown';
            };

            // Status hrSWRunStatus: 1=running, 2=runnable, 3=notRunnable, 4=invalid
            const swStatusLabel = (s) => {
                const code = Number(s);
                if (code === 1) return 'running';
                if (code === 2) return 'runnable';
                if (code === 3) return 'notRunnable';
                if (code === 4) return 'invalid';
                return 'unknown';
            };

            const procIndexes = Object.keys(runNameMap);
            const processes = procIndexes.map(idx => {
                const pid = Number(idx);
                const name = String(runNameMap[idx] || '').trim();
                const pathStr = runPathMap[idx] ? String(runPathMap[idx]).trim() : '';
                const paramStr = runParamMap[idx] ? String(runParamMap[idx]).trim() : '';
                const type = swTypeLabel(runTypeMap[idx]);
                const procStatus = swStatusLabel(runStatusMap[idx]);
                const cpuTicks = perfCpuMap[idx] !== undefined ? Number(perfCpuMap[idx]) : 0;
                const memKb = perfMemMap[idx] !== undefined ? Number(perfMemMap[idx]) : 0;

                return {
                    pid,
                    name,
                    path: pathStr,
                    parameters: paramStr,
                    type,
                    status: procStatus,
                    cpu: cpuTicks,
                    memory: memKb
                };
            });

            // Mapping svSvcEntry (Windows Services)
            const svcNameMap = toIndexMap(svcNameVbs);
            const svcOpStateMap = toIndexMap(svcOpStateVbs);
            const svcIndexes = Object.keys(svcNameMap);
            const services = svcIndexes.map(idx => {
                const sName = String(svcNameMap[idx] || '').trim();
                const opVal = Number(svcOpStateMap[idx]);
                let sState = 'unknown';
                if (opVal === 1) sState = 'active';
                else if (opVal === 2) sState = 'continue-pending';
                else if (opVal === 3) sState = 'pause-pending';
                else if (opVal === 4) sState = 'paused';

                return {
                    name: sName,
                    state: sState
                };
            });

            // Mapping Linux prTable
            const prNameMap = toIndexMap(prNameVbs);
            const prMinMap = toIndexMap(prMinVbs);
            const prMaxMap = toIndexMap(prMaxVbs);
            const prCountMap = toIndexMap(prCountVbs);
            const prErrFlagMap = toIndexMap(prErrFlagVbs);
            const prErrMsgMap = toIndexMap(prErrMsgVbs);
            const ucdProcs = Object.keys(prNameMap).map(idx => ({
                name: String(prNameMap[idx] || ''),
                min: Number(prMinMap[idx] || 0),
                max: Number(prMaxMap[idx] || 0),
                count: Number(prCountMap[idx] || 0),
                errorFlag: Number(prErrFlagMap[idx] || 0),
                errorMessage: String(prErrMsgMap[idx] || '')
            }));

            // Ambil watchlist konfigurasi perangkat (mendukung auto-discovery jika host belum terdaftar)
            const watchlist = loadWatchlistForHost(host, processes);

            // Hitung hasil audit via engine
            auditServerResult = await computeServerAudit(host, {
                processes,
                services,
                ucdProcs,
                systemMetrics: {
                    cpu_usage: rawData.cpu_usage,
                    ram_usage_pct: rawData.ram_usage_pct,
                    disk_usage_pct: rawData.disk_usage_pct,
                    sys_uptime: rawData.sys_uptime
                },
                watchlist
            });
        } catch (auditErr) {
            console.warn(`[SNMP SYSTEM] Server Audit error for ${host}:`, auditErr.message);
        }

        // Gabungkan audit_server dan health_score ke dalam rawData (dengan proteksi cache persisten)
        if (auditServerResult && Array.isArray(auditServerResult.processes) && auditServerResult.processes.length > 0) {
            lastKnownAuditServerMap.set(host, auditServerResult);
            rawData.audit_server = auditServerResult;
            rawData.health_score = auditServerResult.health_score ? auditServerResult.health_score.level : 'Normal';
        } else if (lastKnownAuditServerMap.has(host)) {
            // Gunakan snapshot proses sebelumnya agar antarmuka tidak blank saat interval refresh
            const cachedAudit = lastKnownAuditServerMap.get(host);
            rawData.audit_server = cachedAudit;
            rawData.health_score = cachedAudit.health_score ? cachedAudit.health_score.level : 'Normal';
        } else if (auditServerResult) {
            rawData.audit_server = auditServerResult;
            rawData.health_score = auditServerResult.health_score ? auditServerResult.health_score.level : 'Normal';
        }

        try { if (auditSession) auditSession.close(); } catch (e) {}
        session.close();
        return {
            success: true,
            status,
            data: buildStructuredSystemData(rawData),
            alarms: status === 'Alarm' ? ['Resource usage critical or temperature high'] : [],
            warnings: status === 'Warning' ? ['Resource usage high or temperature elevated'] : [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };

    } catch (err) {
        try { session.close(); } catch (e) { }
        const fallbackRaw = {
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
        };
        const structuredFallback = {
            ...fallbackRaw,
            'SISTEM': {
                connectivity: fallbackRaw.connectivity, sys_name: fallbackRaw.sys_name,
                sys_descr: fallbackRaw.sys_descr, hardware: fallbackRaw.hardware,
                operating_system: fallbackRaw.operating_system, sys_uptime: fallbackRaw.sys_uptime,
                sys_contact: fallbackRaw.sys_contact, sys_location: fallbackRaw.sys_location
            },
            'CPU': { cpu_usage: fallbackRaw.cpu_usage, processor_count: fallbackRaw.processor_count },
            'TEMPERATURE': {
                temperature_c: fallbackRaw.temperature_c,
                temperature_sensor_name: fallbackRaw.temperature_sensor_name,
                temperature_sensor_count: fallbackRaw.temperature_sensor_count
            },
            'MEMORY (RAM)': {
                ram_total_mb: fallbackRaw.ram_total_mb, ram_used_mb: fallbackRaw.ram_used_mb,
                ram_available_mb: fallbackRaw.ram_available_mb, ram_usage_pct: fallbackRaw.ram_usage_pct,
                ram_available_pct: fallbackRaw.ram_available_pct
            },
            'MEMORY (PHYSICAL / VIRTUAL / SWAP)': {
                physical_memory_total_mb: fallbackRaw.physical_memory_total_mb,
                physical_memory_usage_pct: fallbackRaw.physical_memory_usage_pct,
                virtual_memory_total_mb: fallbackRaw.virtual_memory_total_mb,
                virtual_memory_usage_pct: fallbackRaw.virtual_memory_usage_pct,
                swap_total_mb: fallbackRaw.swap_total_mb, swap_used_mb: fallbackRaw.swap_used_mb,
                memory_buffers_mb: fallbackRaw.memory_buffers_mb, cached_memory_mb: fallbackRaw.cached_memory_mb,
                shared_memory_mb: fallbackRaw.shared_memory_mb
            },
            'DISK': {
                disk_total_gb: fallbackRaw.disk_total_gb, disk_used_gb: fallbackRaw.disk_used_gb,
                disk_usage_pct: fallbackRaw.disk_usage_pct
            }
        };

        if (lastKnownAuditServerMap.has(host)) {
            structuredFallback.audit_server = lastKnownAuditServerMap.get(host);
        }

        return {
            success: false,
            status: 'Disconnect',
            error: err.message,
            data: structuredFallback,
            timestamp: new Date().toISOString(),
        };
    }
}

// Wrapper dengan hard timeout — mencegah hang di Bun runtime
async function pollSNMPWithTimeout(host, community = 'public', options = {}, timeoutMs = 60000) {
    if (typeof options === 'number') {
        timeoutMs = options;
        options = {};
    }

    const snmpOptions = normalizeSnmpOptions(options);
    const effectiveTimeoutMs = Number(options && options.timeoutMs) || timeoutMs;

    return new Promise((resolve) => {
        // JITTER DELAY: Tunda eksekusi secara acak antara 0 hingga 2500 milidetik (2.5 detik)
        // Ini sangat krusial dan aman untuk mencegah UDP Flooding (Thundering Herd) 
        // ketika puluhan PC di-poll secara serentak di milidetik yang sama.
        const jitterMs = Math.floor(Math.random() * 2500);

        setTimeout(() => {
            const timeoutFallbackRaw = {
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
            };
            const timeoutStructuredFallback = {
                ...timeoutFallbackRaw,
                'SISTEM': {
                    connectivity: timeoutFallbackRaw.connectivity, sys_name: timeoutFallbackRaw.sys_name,
                    sys_descr: timeoutFallbackRaw.sys_descr, hardware: timeoutFallbackRaw.hardware,
                    operating_system: timeoutFallbackRaw.operating_system, sys_uptime: timeoutFallbackRaw.sys_uptime,
                    sys_contact: timeoutFallbackRaw.sys_contact, sys_location: timeoutFallbackRaw.sys_location
                },
                'CPU': { cpu_usage: timeoutFallbackRaw.cpu_usage, processor_count: timeoutFallbackRaw.processor_count },
                'TEMPERATURE': {
                    temperature_c: timeoutFallbackRaw.temperature_c,
                    temperature_sensor_name: timeoutFallbackRaw.temperature_sensor_name,
                    temperature_sensor_count: timeoutFallbackRaw.temperature_sensor_count
                },
                'MEMORY (RAM)': {
                    ram_total_mb: timeoutFallbackRaw.ram_total_mb, ram_used_mb: timeoutFallbackRaw.ram_used_mb,
                    ram_available_mb: timeoutFallbackRaw.ram_available_mb, ram_usage_pct: timeoutFallbackRaw.ram_usage_pct,
                    ram_available_pct: timeoutFallbackRaw.ram_available_pct
                },
                'MEMORY (PHYSICAL / VIRTUAL / SWAP)': {
                    physical_memory_total_mb: timeoutFallbackRaw.physical_memory_total_mb,
                    physical_memory_usage_pct: timeoutFallbackRaw.physical_memory_usage_pct,
                    virtual_memory_total_mb: timeoutFallbackRaw.virtual_memory_total_mb,
                    virtual_memory_usage_pct: timeoutFallbackRaw.virtual_memory_usage_pct,
                    swap_total_mb: timeoutFallbackRaw.swap_total_mb, swap_used_mb: timeoutFallbackRaw.swap_used_mb,
                    memory_buffers_mb: timeoutFallbackRaw.memory_buffers_mb, cached_memory_mb: timeoutFallbackRaw.cached_memory_mb,
                    shared_memory_mb: timeoutFallbackRaw.shared_memory_mb
                },
                'DISK': {
                    disk_total_gb: timeoutFallbackRaw.disk_total_gb, disk_used_gb: timeoutFallbackRaw.disk_used_gb,
                    disk_usage_pct: timeoutFallbackRaw.disk_usage_pct
                }
            };

            const timer = setTimeout(() => {
                resolve({
                    success: false,
                    status: 'Disconnect',
                    error: `Poll timeout (>${Math.round(effectiveTimeoutMs / 1000)}s)`,
                    data: timeoutStructuredFallback,
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
                    error: err.message,
                    data: timeoutStructuredFallback,
                    timestamp: new Date().toISOString(),
                });
            });
        }, jitterMs); // Akhir dari blok Jitter Delay
    });
}

module.exports = { pollSNMP: pollSNMPWithTimeout, pollSNMPRaw: pollSNMP };
