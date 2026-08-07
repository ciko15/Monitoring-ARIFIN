const fs = require('fs');
const file = 'db/equipment_parsing_config.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

// Only add if not exists
if (!data.find(x => x.id === 'diris_a20')) {
  data.push({
    id: "diris_a20",
    name: "DIRIS A20 Power Meter",
    description: "Parser Modbus RTU TCP pasif untuk DIRIS A20",
    category: "Support",
    files: "/src/parsers/diris_a20.js",
    createdAt: "2026-08-07T00:00:00.000Z"
  });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
