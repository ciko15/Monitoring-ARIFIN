const net = require('net');

function testIls(name, ip, port, triggerStr) {
    const client = new net.Socket();
    const trigger = Buffer.from(triggerStr, 'hex');
    
    console.log(`[${name}] Connecting to ${ip}:${port}...`);
    client.connect(port, ip, () => {
        console.log(`[${name}] Connected.`);
        console.log(`[${name}] Sending trigger: ${trigger.toString('hex')}`);
        client.write(trigger);
        
        setInterval(() => {
            console.log(`[${name}] Sending trigger...`);
            client.write(trigger);
        }, 3000);
    });

    client.on('data', (data) => {
        console.log(`\n[${name}] Received ${data.length} bytes:`);
        console.log(data.toString('hex'));
        // Try to parse some header
        if (data.length >= 4) {
             console.log(`[${name}] Header: ${data.slice(0, 4).toString('hex')}`);
        }
    });

    client.on('error', (err) => {
        console.error(`[${name}] Error:`, err.message);
    });

    setTimeout(() => {
        console.log(`[${name}] Timeout closing.`);
        client.destroy();
    }, 10000);
}

// LLZ
testIls('LLZ', '192.168.51.10', 950, '0B00F906');
// GP
testIls('GP', '192.168.50.160', 950, '0B00E906');
