const UniversalApiParser = require('./src/parsers/universal_api.js');
const fs = require('fs');

const authData = JSON.parse(fs.readFileSync('./db/equipment_otentication_config.json', 'utf8'));
const pm = authData.find(a => a.name === "Power Meter Gedung Radar");

const parser = new UniversalApiParser({ parser_config: JSON.parse(pm.extra_config) });

parser.fetchApiData("172.19.7.158", "1880").then(res => {
    console.log(JSON.stringify(res, null, 2));
}).catch(console.error);
