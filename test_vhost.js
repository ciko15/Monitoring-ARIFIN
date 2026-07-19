const amqp = require('amqplib');

async function testVhost(vhostVal) {
    const opts = {
        protocol: 'amqp',
        hostname: '172.20.16.123',
        port: 5672,
        username: 'smart-toc-hq',
        password: 'smarthq123!'
    };
    if (vhostVal !== undefined) {
        opts.vhost = vhostVal;
    }
    
    console.log(`Testing with vhost: ${vhostVal === undefined ? 'OMITTED' : "'" + vhostVal + "'"}`);
    try {
        const conn = await amqp.connect(opts);
        console.log(`✅ SUCCESS with vhost: ${vhostVal}`);
        await conn.close();
        return true;
    } catch (e) {
        console.log(`❌ FAILED with vhost: ${vhostVal} - ${e.message}`);
        return false;
    }
}

async function run() {
    await testVhost('/');
    await testVhost('');
    await testVhost('default');
    await testVhost(undefined);
    
    // Test connection string
    try {
        const conn = await amqp.connect('amqp://smart-toc-hq:smarthq123!@172.20.16.123:5672');
        console.log(`✅ SUCCESS with connection string (no vhost)`);
        await conn.close();
    } catch (e) {
        console.log(`❌ FAILED with connection string - ${e.message}`);
    }
}

run();
