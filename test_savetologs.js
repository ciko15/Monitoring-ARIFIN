const UniversalApiParser = require('./src/parsers/universal_api.js');
const db = require('./src/services/database.js');
const EquipmentService = require('./src/services/equipment.js');
const fs = require('fs');

async function test() {
    const eqService = new EquipmentService(db);
    const authData = JSON.parse(fs.readFileSync('./db/equipment_otentication_config.json', 'utf8'));
    const pm = authData.find(a => a.name === "Power Meter Gedung Radar");

    const parser = new UniversalApiParser({ parser_config: JSON.parse(pm.extra_config) });
    const res = await parser.fetchApiData("172.19.7.158", "1880");
    
    console.log("Fetch success:", res.success);
    
    const dataToSave = { ...res.data, source: pm.name, source_id: pm.id, source_name: pm.name };
    await eqService.saveToLogs(pm.equipt_id, dataToSave, 'universal_api', 'Normal');
    
    console.log("Saved to logs!");
}

test().catch(console.error);
