const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./data/equipment_logs.json'));
const eq1 = data.find(l => l.equipmentId == 1 || l.parsing_id === 'ils_llz_thales421' || l.parsing_id === 'dvor_maru_220');
console.log(JSON.stringify(eq1, null, 2));
