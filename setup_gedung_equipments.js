const fs = require('fs');
const path = require('path');
const authFile = path.join(__dirname, 'db', 'equipment_otentication_config.json');
let authData = [];
try { authData = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) {}

// Remove previously added radar equipments if they exist
authData = authData.filter(item => !item.equipt_id.startsWith('radar_') && !item.equipt_id.startsWith('dvor_'));

const now = Date.now();
const commonUrlOptions = {
    poll_interval: 15,
    api_options: { method: "GET", headers: { Accept: "application/json" } }
};

const createEnvMapping = () => [
    { json_path: "status", name: "Status Online", divisor: 1, group: "Status" },
    { json_path: "telemetry.temperature.value", name: "Suhu Ruangan", divisor: 1, group: "Lingkungan" },
    { json_path: "telemetry.humidity.value", name: "Kelembapan", divisor: 1, group: "Lingkungan" }
];

const createPmMapping = () => [
    { json_path: "status", name: "Status Online", divisor: 1, group: "Status" },
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

const equipments = [
    // --- GEDUNG RADAR ---
    {
        id: now + 1, name: "Sensor Suhu", equipt_id: "radar_env_" + now,
        ip_address: "172.19.7.158", tcp_port: "1880", udp_port: null,
        parsing_id: "universal_api", protocol: "tcp",
        sup_category: "Gedung Radar", poll_interval: 15, latitude: "", longitude: "",
        extra_config: JSON.stringify({
            endpoint_url: "http://{ip}:{port}/radar?api_key=dse-denpasar-2026",
            ...commonUrlOptions, mappings: createEnvMapping()
        })
    },
    {
        id: now + 2, name: "Power Meter", equipt_id: "radar_pm_" + now,
        ip_address: "172.19.7.158", tcp_port: "1880", udp_port: null,
        parsing_id: "universal_api", protocol: "tcp",
        sup_category: "Gedung Radar", poll_interval: 15, latitude: "", longitude: "",
        extra_config: JSON.stringify({
            endpoint_url: "http://{ip}:{port}/radar?api_key=dse-denpasar-2026",
            ...commonUrlOptions, mappings: createPmMapping()
        })
    },
    // --- GEDUNG DVOR ---
    {
        id: now + 3, name: "Sensor Suhu", equipt_id: "dvor_env_" + now,
        ip_address: "172.19.7.158", tcp_port: "1880", udp_port: null,
        parsing_id: "universal_api", protocol: "tcp",
        sup_category: "Gedung DVOR", poll_interval: 15, latitude: "", longitude: "",
        extra_config: JSON.stringify({
            endpoint_url: "http://{ip}:{port}/dvor?api_key=dse-denpasar-2026",
            ...commonUrlOptions, mappings: createEnvMapping()
        })
    },
    {
        id: now + 4, name: "Power Meter", equipt_id: "dvor_pm_" + now,
        ip_address: "172.19.7.158", tcp_port: "1880", udp_port: null,
        parsing_id: "universal_api", protocol: "tcp",
        sup_category: "Gedung DVOR", poll_interval: 15, latitude: "", longitude: "",
        extra_config: JSON.stringify({
            endpoint_url: "http://{ip}:{port}/dvor?api_key=dse-denpasar-2026",
            ...commonUrlOptions, mappings: createPmMapping()
        })
    }
];

authData.push(...equipments);
fs.writeFileSync(authFile, JSON.stringify(authData, null, 2));
console.log("Setup 4 equipments successfully!");
