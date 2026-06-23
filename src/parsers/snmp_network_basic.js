'use strict';

const snmp = require('snmp-native');
const { readAlcatelTemperature, readTemperatureSensors } = require('./snmp_sensor_utils');

const OID = {
    sysDescr:   [1, 3, 6, 1, 2, 1, 1, 1, 0],
    sysObjectID:[1, 3, 6, 1, 2, 1, 1, 2, 0],
    sysContact: [1, 3, 6, 1, 2, 1, 1, 4, 0],
    sysName:    [1, 3, 6, 1, 2, 1, 1, 5, 0],
    sysUpTime:  [1, 3, 6, 1, 2, 1, 1, 3, 0],
    sysLocation:[1, 3, 6, 1, 2, 1, 1, 6, 0],
    ifNumber:   [1, 3, 6, 1, 2, 1, 2, 1, 0],
    ifDescr:    [1, 3, 6, 1, 2, 1, 2, 2, 1, 2],
    ifName:     [1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1],
    ifOperStatus:[1, 3, 6, 1, 2, 1, 2, 2, 1, 8],
    ifInOctets: [1, 3, 6, 1, 2, 1, 2, 2, 1, 10],
    ifOutOctets:[1, 3, 6, 1, 2, 1, 2, 2, 1, 16],
    ifHCInOctets:[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 6],
    ifHCOutOctets:[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 10],
};

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

function createSession(host, community) {
    return new snmp.Session({ host, community, timeouts: [4000, 4000, 4000] });
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

function summarizeInterfaceNames(interfaces, limit = 8) {
    if (!interfaces || interfaces.length === 0) return '—';
    const names = interfaces.slice(0, limit).map((iface) => normalizeInterfaceName(iface.name));
    const suffix = interfaces.length > limit ? ` +${interfaces.length - limit} lainnya` : '';
    return names.join(', ') + suffix;
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
        const alcatelTemp = await readAlcatelTemperature(session, snmpWalk, snmpGet);
        if (alcatelTemp.hottest) return alcatelTemp;
    }

    return readTemperatureSensors(session, snmpWalk);
}

async function pollSNMP(host, community = 'public') {
    const session = createSession(host, community);
    try {
        const [sysName, sysDescr, sysObjectID, sysContact, sysUpTime, sysLocation, ifNumber, ifDescrVbs, ifNameVbs, ifOperStatusVbs, ifInOctetsVbs, ifOutOctetsVbs, ifHCInOctetsVbs, ifHCOutOctetsVbs] = await Promise.all([
            snmpGet(session, OID.sysName),
            snmpGet(session, OID.sysDescr),
            snmpGet(session, OID.sysObjectID),
            snmpGet(session, OID.sysContact),
            snmpGet(session, OID.sysUpTime),
            snmpGet(session, OID.sysLocation),
            snmpGet(session, OID.ifNumber),
            snmpWalk(session, OID.ifDescr),
            snmpWalk(session, OID.ifName),
            snmpWalk(session, OID.ifOperStatus),
            snmpWalk(session, OID.ifInOctets),
            snmpWalk(session, OID.ifOutOctets),
            snmpWalk(session, OID.ifHCInOctets),
            snmpWalk(session, OID.ifHCOutOctets),
        ]);

        if (sysName === null && sysDescr === null) {
            throw new Error('No SNMP response');
        }

        const descrMap = toIndexMap(ifDescrVbs);
        const ifNameMap = toIndexMap(ifNameVbs);
        const statusMap = toIndexMap(ifOperStatusVbs);
        const inMap = toIndexMap(ifInOctetsVbs);
        const outMap = toIndexMap(ifOutOctetsVbs);
        const hcInMap = toIndexMap(ifHCInOctetsVbs);
        const hcOutMap = toIndexMap(ifHCOutOctetsVbs);
        const interfaceIndexes = buildInterfaceIndexes(descrMap, ifNameMap, statusMap, inMap, outMap, hcInMap, hcOutMap);

        const interfaces = interfaceIndexes.map((idx) => {
            const name = normalizeInterfaceName(pickInterfaceName(idx, descrMap, ifNameMap));
            const status = operStatusText(statusMap[idx]);
            const inOctets = parseCounter(hcInMap[idx] ?? inMap[idx]);
            const outOctets = parseCounter(hcOutMap[idx] ?? outMap[idx]);
            return {
                index: idx,
                name,
                status,
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
        const tempInfo = await readSwitchTemperature(session, sysObjectID);
        const temperatureSensors = tempInfo.sensors.map((sensor) => ({
            name: sensor.name,
            value_c: sensor.value_c.toFixed(1),
            status: sensor.status,
        }));

        return {
            success: true,
            status: 'Normal',
            data: {
                connectivity: 'Connected',
                resolved_ip: host,
                sys_name: String(sysName || '—'),
                sys_descr: String(sysDescr || '—').substring(0, 120),
                hardware: parseHardware(sysDescr),
                operating_system: parseOperatingSystem(sysDescr),
                sys_object_id: Array.isArray(sysObjectID) ? sysObjectID.join('.') : String(sysObjectID || '—'),
                sys_contact: String(sysContact || '—'),
                sys_uptime: sysUpTime !== null ? formatUptime(sysUpTime) : '—',
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
                cpu_usage: '—',
                ram_usage_pct: '—',
                disk_usage_pct: '—',
            },
            alarms: [],
            warnings: [],
            triggeredParams: [],
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        return {
            success: false,
            status: 'Disconnect',
            error: err.message,
            data: {
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
            },
            timestamp: new Date().toISOString(),
        };
    } finally {
        try { session.close(); } catch {}
    }
}

async function pollSNMPWithTimeout(host, community = 'public', timeoutMs = 15000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({
                success: false,
                status: 'Disconnect',
                error: 'SNMP timeout',
                data: {
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
                },
                timestamp: new Date().toISOString(),
            });
        }, timeoutMs);

        pollSNMP(host, community)
            .then((result) => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch((err) => {
                clearTimeout(timer);
                resolve({
                    success: false,
                    status: 'Disconnect',
                    error: err.message,
                    data: {
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
                    },
                    timestamp: new Date().toISOString(),
                });
            });
    });
}

module.exports = { pollSNMP: pollSNMPWithTimeout, pollSNMPRaw: pollSNMP };
