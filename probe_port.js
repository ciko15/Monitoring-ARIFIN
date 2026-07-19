const net = require('net');

function probeProtocol(name, headerBuf) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        
        client.setTimeout(3000);
        
        client.connect(5672, '172.20.16.123', () => {
            console.log(`[${name}] Connected to TCP, sending header...`);
            client.write(headerBuf);
        });
        
        client.on('data', (data) => {
            console.log(`[${name}] Received data:`, data.toString('hex'));
            client.destroy();
            resolve();
        });
        
        client.on('error', (err) => {
            console.log(`[${name}] Error:`, err.message);
            resolve();
        });
        
        client.on('close', () => {
            console.log(`[${name}] Connection closed`);
            resolve();
        });
        
        client.on('timeout', () => {
            console.log(`[${name}] Timeout waiting for response`);
            client.destroy();
            resolve();
        });
    });
}

async function run() {
    // AMQP 0-9-1 header: 'AMQP' 1 1 0 9
    const amqp091 = Buffer.from([0x41, 0x4D, 0x51, 0x50, 0x01, 0x01, 0x00, 0x09]);
    await probeProtocol('AMQP 0-9-1', amqp091);
    
    // AMQP 1.0 header: 'AMQP' 0 1 0 0
    const amqp10 = Buffer.from([0x41, 0x4D, 0x51, 0x50, 0x00, 0x01, 0x00, 0x00]);
    await probeProtocol('AMQP 1.0', amqp10);
    
    // HTTP
    const http = Buffer.from('GET / HTTP/1.1\r\nHost: 172.20.16.123\r\n\r\n');
    await probeProtocol('HTTP', http);
}

run();
