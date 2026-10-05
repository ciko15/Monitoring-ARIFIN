const fs = require('fs');
const path = require('path');
const authFile = path.join(__dirname, 'db', 'equipment_otentication_config.json');
const uiFile = path.join(__dirname, 'db', 'equipment_config.json');

let authData = [];
let uiData = [];
try { authData = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) {}
try { uiData = JSON.parse(fs.readFileSync(uiFile, 'utf8')); } catch (e) {}

// Remove all previous combos or radar/dvor attempts
authData = authData.filter(item => !item.equipt_id.includes('radar') && !item.equipt_id.includes('dvor'));
uiData = uiData.filter(item => !item.id.toString().includes('radar') && !item.id.toString().includes('dvor'));

const now = Date.now();
const commonUrlOptions = {
    poll_interval: 15,
    api_options: { method: "GET", headers: { Accept: "application/json" } }
};

const createEnvMapping = () => [
    { json_path: "status", name: "Status Online", divisor: 1, group: "General" },
    { json_path: "ip_address", name: "IP Address", divisor: 1, group: "General" },
    { json_path: "updated_at", name: "Terakhir Update", divisor: 1, group: "General" },
    { json_path: "telemetry.temperature.value", name: "Suhu Ruangan", divisor: 1, group: "Lingkungan" },
    { json_path: "telemetry.humidity.value", name: "Kelembapan", divisor: 1, group: "Lingkungan" }
];

const createPmMapping = () => [
    { json_path: "status", name: "Status Online", divisor: 1, group: "General" },
    { json_path: "ip_address", name: "IP Address", divisor: 1, group: "General" },
    { json_path: "updated_at", name: "Terakhir Update", divisor: 1, group: "General" },
    { json_path: "telemetry.voltage.value", name: "Tegangan L-N (V)", divisor: 1, group: "Tegangan" },
    { json_path: "telemetry.avg_voltage_today.value", name: "Rata-rata Tegangan (V)", divisor: 1, group: "Tegangan" },
    { json_path: "telemetry.current_3phase.L1.value", name: "Arus L1 (A)", divisor: 1, group: "Arus" },
    { json_path: "telemetry.current_3phase.L2.value", name: "Arus L2 (A)", divisor: 1, group: "Arus" },
    { json_path: "telemetry.current_3phase.L3.value", name: "Arus L3 (A)", divisor: 1, group: "Arus" },
    { json_path: "telemetry.current_3phase.neutral.value", name: "Arus Netral (A)", divisor: 1, group: "Arus" },
    { json_path: "telemetry.power_3phase.total.value", name: "Total Daya Aktif (kW)", divisor: 1, group: "Daya" },
    { json_path: "telemetry.power_factor_3phase.total.value", name: "Power Factor Total", divisor: 1, group: "Daya" },
    { json_path: "telemetry.energy.value", name: "Total Energi (kWh)", divisor: 1, group: "Energi" }
];

const configs = [
    { prefix: 'radar_env', name: 'Sensor Suhu Gedung Radar', cat: 'Support', supCat: 'Gedung Radar', url: 'http://{ip}:{port}/radar?api_key=dse-denpasar-2026', map: createEnvMapping() },
    { prefix: 'radar_pm', name: 'Power Meter Gedung Radar', cat: 'Support', supCat: 'Gedung Radar', url: 'http://{ip}:{port}/radar?api_key=dse-denpasar-2026', map: createPmMapping() },
    { prefix: 'dvor_env', name: 'Sensor Suhu Gedung DVOR', cat: 'Support', supCat: 'Gedung DVOR', url: 'http://{ip}:{port}/dvor?api_key=dse-denpasar-2026', map: createEnvMapping() },
    { prefix: 'dvor_pm', name: 'Power Meter Gedung DVOR', cat: 'Support', supCat: 'Gedung DVOR', url: 'http://{ip}:{port}/dvor?api_key=dse-denpasar-2026', map: createPmMapping() }
];

let idCounter = now;
for (const c of configs) {
    const dsId = idCounter++;
    const eqId = c.prefix + "_" + dsId;
    
    // 1. Add to Auth (Data Source)
    authData.push({
        id: dsId, name: c.name, equipt_id: eqId,
        ip_address: "172.19.7.158", tcp_port: "1880", udp_port: null,
        parsing_id: "universal_api", protocol: "tcp",
        sup_category: c.supCat, poll_interval: 15, latitude: "", longitude: "",
        extra_config: JSON.stringify({
            endpoint_url: c.url,
            ...commonUrlOptions, mappings: c.map
        })
    });

    // 2. Add to UI (Equipment)
    uiData.push({
        id: eqId,
        name: c.name,
        category: c.cat,
        parsing_id: "universal_api",
        mappings: c.map,
        dashboardConfig: { layout: "list", showGraph: true },
        dataSources: [
            { id: dsId, name: c.name, ip: "172.19.7.158", port: "1880", parser: "universal_api", enabled: true }
        ],
        sup_category: c.supCat,
        merk: "", type: "", status: "Normal", airportId: 1, lat: null, lng: null, description: "Auto added", isActive: true, branchId: 1
    });
}

fs.writeFileSync(authFile, JSON.stringify(authData, null, 2));
fs.writeFileSync(uiFile, JSON.stringify(uiData, null, 2));
console.log("Separated equipments built successfully!");
