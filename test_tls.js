const { Connection } = require('rhea-promise');

async function testTLS() {
    console.log('Testing AMQP 1.0 over TLS (amqps)...');
    const conn = new Connection({
        host: '172.20.16.123',
        port: 5672, // sometimes TLS is on 5672, usually 5671
        username: 'smart-toc-hq',
        password: 'smarthq123!',
        transport: 'tls',
        rejectUnauthorized: false
    });

    try {
        await conn.open();
        console.log('SUCCESS TLS!');
        await conn.close();
    } catch (e) {
        console.log('TLS failed:', e.message);
    }
}
testTLS();
