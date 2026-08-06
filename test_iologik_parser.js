const { pollIoLogik } = require('./src/parsers/iologik_modbus');

async function test() {
    console.log("Testing ioLogik Parser...");
    const res = await pollIoLogik('10.20.3.73', 502, 1);
    console.log(JSON.stringify(res, null, 2));
}

test();
