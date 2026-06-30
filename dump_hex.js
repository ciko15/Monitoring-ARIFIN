const net = require('net');
const client = new net.Socket();

const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);

client.connect(950, '192.168.51.10', () => {
    console.log('[+] Connected to 192.168.51.10:950');
    console.log('[+] Mengirim Trigger Request...');
    client.write(TRIGGER_SEND);
});

client.on('data', (data) => {
    console.log('\n--- RAW HEX DUMP ---');
    console.log(data.toString('hex'));
    console.log('--------------------\n');
    client.destroy(); 
});

client.on('error', (err) => {
    console.error('Connection error:', err.message);
});

setTimeout(() => {
    client.destroy();
}, 5000);
