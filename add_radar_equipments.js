const fs = require('fs');
const path = require('path');
const authFile = path.join(__dirname, 'db', 'equipment_otentication_config.json');
let authData = [];
try { authData = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) {}

const now = Date.now();

// 1. Sensor Suhu & Kelembapan
const envConfig = {
  id: now + 1,
  name: "Sensor Suhu & Kelembaban Radar",
  equipt_id: "radar_env_" + now,
  ip_address: "172.19.7.158",
  tcp_port: "1880",
  udp_port: null,
  parsing_id: "universal_api",
  protocol: "tcp",
  sup_category: "Support",
  poll_interval: 15,
  latitude: "",
  longitude: "",
  extra_config: JSON.stringify({
    endpoint_url: "http://{ip}:{port}/radar?api_key=dse-denpasar-2026",
    poll_interval: 15,
    api_options: { method: "GET", headers: { Accept: "application/json" } },
    mappings: [
      { json_path: "status", name: "Status Online", divisor: 1, group: "Status" },
      { json_path: "telemetry.temperature.value", name: "Suhu Ruangan", divisor: 1, group: "Lingkungan" },
      { json_path: "telemetry.humidity.value", name: "Kelembapan", divisor: 1, group: "Lingkungan" }
    ]
  })
};

// 2. Power Meter
const pmConfig = {
  id: now + 2,
  name: "Power Meter Radar",
  equipt_id: "radar_pm_" + now,
  ip_address: "172.19.7.158",
  tcp_port: "1880",
  udp_port: null,
  parsing_id: "universal_api",
  protocol: "tcp",
  sup_category: "Support",
  poll_interval: 15,
  latitude: "",
  longitude: "",
  extra_config: JSON.stringify({
    endpoint_url: "http://{ip}:{port}/radar?api_key=dse-denpasar-2026",
    poll_interval: 15,
    api_options: { method: "GET", headers: { Accept: "application/json" } },
    mappings: [
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
    ]
  })
};

authData.push(envConfig);
authData.push(pmConfig);

fs.writeFileSync(authFile, JSON.stringify(authData, null, 2));
console.log("Ditambahkan 2 alat baru untuk Radar!");
