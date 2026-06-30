const net = require('net');
const client = new net.Socket();

client.connect(950, '192.168.51.10', () => {
    console.log('[+] Connected to 192.168.51.10:950');
});

client.on('data', (data) => {
    console.log('\n--- RAW HEX DUMP ---');
    console.log(data.toString('hex'));
    console.log('--------------------\n');
    client.destroy(); // Langsung putus setelah dapat 1 chunk
});

client.on('error', (err) => {
    console.error('Connection error:', err.message);
});

setTimeout(() => {
    client.destroy();
}, 5000);
