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
 * Threshold: WARNING >= 80%, ALARM >= 95%
 */

'use strict';

const snmp = require('snmp-native');

const OID = {
    sysDescr:        [1,3,6,1,2,1,1,1,0],
    sysName:         [1,3,6,1,2,1,1,5,0],
    sysUpTime:       [1,3,6,1,2,1,1,3,0],
    hrProcessorLoad: [1,3,6,1,2,1,25,3,3,1,2],
    hrStorageType:   [1,3,6,1,2,1,25,2,3,1,2],
    hrStorageSize:   [1,3,6,1,2,1,25,2,3,1,5],
    hrStorageUsed:   [1,3,6,1,2,1,25,2,3,1,6],
    hrStorageAlloc:  [1,3,6,1,2,1,25,2,3,1,4],
};

// Storage type OID suffixes — nilai persis dari snmp-native (dot-separated string)
const TYPE_RAM  = '1.3.6.1.2.1.25.2.1.2';  // Physical memory
const TYPE_VMEM = '1.3.6.1.2.1.25.2.1.3';  // Virtual memory
const TYPE_DISK = '1.3.6.1.2.1.25.2.1.4';  // Fixed disk / filesystem

const WARN_PCT  = 80;
const ALARM_PCT = 95;

function statusFromPct(pct) {
    if (pct >= ALARM_PCT) return 'Alarm';
    if (pct >= WARN_PCT)  return 'Warning';
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

function createSession(host, community) {
    return new snmp.Session({ host, community, timeouts: [4000, 4000] });
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

async function pollSNMP(host, community = 'public') {
    const session = createSession(host, community);
    try {
        // System info
        const [sysName, sysDescr, sysUpRaw] = await Promise.all([
            snmpGet(session, OID.sysName),
            snmpGet(session, OID.sysDescr),
            snmpGet(session, OID.sysUpTime),
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
        const disk_pct = (disk_total_gb && disk_total_gb > 0)
            ? (disk_used_gb / disk_total_gb * 100) : null;

        const s_cpu  = cpu_pct  !== null ? statusFromPct(cpu_pct)  : 'Normal';
        const s_ram  = ram_pct  !== null ? statusFromPct(ram_pct)  : 'Normal';
        const s_disk = disk_pct !== null ? statusFromPct(disk_pct) : 'Normal';
        const status = worstStatus(s_cpu, s_ram, s_disk);

        session.close();
        return {
            success: true,
            status,
            data: {
                connectivity:   'Connected',
                sys_name:       String(sysName  || '—'),
                sys_descr:      String(sysDescr || '—').substring(0, 80),
                sys_uptime:     sysUpRaw !== null ? formatUptime(sysUpRaw) : '—',
                cpu_usage:      cpu_pct  !== null ? cpu_pct.toFixed(1)           : '—',
                ram_total_mb:   ram_total_final  !== null ? ram_total_final.toFixed(0)  : '—',
                ram_used_mb:    ram_used_final   !== null ? ram_used_final.toFixed(0)   : '—',
                ram_usage_pct:  ram_pct          !== null ? ram_pct.toFixed(1)          : '—',
                disk_total_gb:  disk_total_gb    !== null ? disk_total_gb.toFixed(1)    : '—',
                disk_used_gb:   disk_used_gb     !== null ? disk_used_gb.toFixed(1)     : '—',
                disk_usage_pct: disk_pct         !== null ? disk_pct.toFixed(1)         : '—',
            },
            alarms:          status === 'Alarm'   ? ['Resource usage critical'] : [],
            warnings:        status === 'Warning' ? ['Resource usage high']     : [],
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
                sys_name: '—', sys_descr: '—', sys_uptime: '—',
                cpu_usage: '—',
                ram_total_mb: '—', ram_used_mb: '—', ram_usage_pct: '—',
                disk_total_gb: '—', disk_used_gb: '—', disk_usage_pct: '—',
            },
            timestamp: new Date().toISOString(),
        };
    }
}

// Wrapper dengan hard timeout — mencegah hang di Bun runtime
async function pollSNMPWithTimeout(host, community = 'public', timeoutMs = 20000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({
                success: false,
                status: 'Disconnect',
                error:  'Poll timeout (>20s)',
                data: {
                    connectivity: 'Disconnected',
                    sys_name: '—', sys_descr: '—', sys_uptime: '—',
                    cpu_usage: '—',
                    ram_total_mb: '—', ram_used_mb: '—', ram_usage_pct: '—',
                    disk_total_gb: '—', disk_used_gb: '—', disk_usage_pct: '—',
                },
                timestamp: new Date().toISOString(),
            });
        }, timeoutMs);

        pollSNMP(host, community).then(result => {
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
                    sys_name: '—', sys_descr: '—', sys_uptime: '—',
                    cpu_usage: '—',
                    ram_total_mb: '—', ram_used_mb: '—', ram_usage_pct: '—',
                    disk_total_gb: '—', disk_used_gb: '—', disk_usage_pct: '—',
                },
                timestamp: new Date().toISOString(),
            });
        });
    });
}

module.exports = { pollSNMP: pollSNMPWithTimeout, pollSNMPRaw: pollSNMP };
