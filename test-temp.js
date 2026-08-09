const { pollTempHumidity } = require('./src/parsers/temp_humidity_modbus');

async function test() {
    console.log("Polling ID 1...");
    const res1 = await pollTempHumidity('192.168.0.26', 8899, 1);
    console.log("Result 1:", res1.data);

    console.log("Polling ID 2...");
    const res2 = await pollTempHumidity('192.168.0.26', 8899, 2);
    console.log("Result 2:", res2.data);
    
    process.exit(0);
}

test();
