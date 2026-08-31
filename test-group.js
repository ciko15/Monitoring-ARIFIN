const UniversalApiParser = require('./src/parsers/universal_api.js');
const parser = new UniversalApiParser({
  parser_config: {
    mappings: [
      { name: "tx1", json_path: "val1", divisor: 1, group: "Transmitter" },
      { name: "tx2", json_path: "val2", divisor: 1, group: "Transmitter" },
      { name: "status1", json_path: "val3", divisor: 1, group: "Status" },
      { name: "nogroup", json_path: "val4", divisor: 1 }
    ]
  }
});
const result = parser._parseJsonMapping({ val1: 10, val2: 20, val3: "OK", val4: "Hello" });
console.log(JSON.stringify(result, null, 2));
