const UniversalApiParser = require('../src/parsers/universal_api.js');
const config = require('../db/equipment_otentication_config.json').find(x => x.equipt_id === 'wrrr_1791110337833');
const extraConfig = JSON.parse(config.extra_config);
const parser = new UniversalApiParser({ equipt_id: 'wrrr_1791110337833', parser_config: extraConfig });

const rawJson = {"status":"online","facility":"RADAR","ip_address":"172.19.7.159:26","updated_at":"2026-10-04T09:28:24.670Z","telemetry":{"temperature":{"parameter":"Suhu Ruangan","value":19.4,"unit":"°C","source":"Unit 1 (Input Register 1)"},"humidity":{"parameter":"Kelembapan Ruangan","value":51.7,"unit":"%RH","source":"Unit 1 (Input Register 2)"},"voltage":{"parameter":"Tegangan Listrik","value":229.23,"unit":"Volt","source":"Unit 5 Power Meter (Holding Register 3035-3036)"},"current_3phase":{"parameter":"Arus Listrik 3 Phase","L1":{"value":22.02,"unit":"A"},"L2":{"value":17.11,"unit":"A"},"L3":{"value":9.23,"unit":"A"},"neutral":{"value":34.44,"unit":"A"},"source":"Unit 5 Power Meter (Holding Register 2999-3006)"},"power_3phase":{"parameter":"Daya Aktif 3 Phase","L1":{"value":4.71,"unit":"kW"},"L2":{"value":0.72,"unit":"kW"},"L3":{"value":1.45,"unit":"kW"},"total":{"value":6.89,"unit":"kW"},"source":"Unit 5 Power Meter (Holding Register 3053-3060)"},"energy":{"parameter":"Total Energi Aktif","value":12456.78,"unit":"kWh","source":"Unit 5 Power Meter (Holding Register 3109-3110)"}}};

const parsed = parser._parseJsonMapping(rawJson);
console.log(JSON.stringify(parsed, null, 2));

// Test network request
parser.fetchApiData('172.19.7.158', 1880).then(res => {
    console.log("Fetch Result:", JSON.stringify(res, null, 2));
});
