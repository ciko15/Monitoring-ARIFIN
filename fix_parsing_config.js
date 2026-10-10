const fs = require('fs');
const file = 'db/equipment_parsing_config.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

data.forEach(item => {
    if (item.id === 'ote_dtr100' || item.id === 'ils_mm_normac') {
        delete item.fields;
        delete item.defaultPort;
        delete item.supportedTypes;
        
        if (item.id === 'ote_dtr100') {
            item.category = "Radio";
            item.files = "/src/parsers/ote_dtr100.js";
            item.createdAt = "2026-08-01T00:00:00.000Z";
        }
    }
});

fs.writeFileSync(file, JSON.stringify(data, null, 4));
console.log("Fixed equipment_parsing_config.json");
