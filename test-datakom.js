const { pollDatakomD700 } = require('./src/parsers/datakom_d700_modbus');

async function test() {
    console.log('Testing Datakom D700 polling...');
    const result = await pollDatakomD700('172.16.10.90', 502, 1);
    console.log(JSON.stringify(result, null, 2));
}

test();
