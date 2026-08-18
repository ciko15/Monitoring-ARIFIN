const Parser = require('./src/parsers/pm5560_modbus.js');
const p = new Parser();
p._last = {
    KW: 16.230,
    KVA: 16.388,
    PF: 1.010
};
console.log(p.parse(Buffer.from([])));
