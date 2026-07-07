const net = require('net');
const client = new net.Socket();

const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);

const targetIp = process.argv[2] || '192.168.50.160';
const targetPort = parseInt(process.argv[3]) || 950;

client.connect(targetPort, targetIp, () => {
    console.log(`[+] Connected to ${targetIp}:${targetPort}`);
    console.log('[+] Mengirim Trigger Request...');
    client.write(TRIGGER_SEND);
});

client.on('data', (data) => {
    console.log('\n--- RAW HEX DUMP ---');
    console.log('Length:', data.length, 'bytes');
    console.log(data.toString('hex'));
    console.log('--------------------\n');
});

client.on('error', (err) => {
    console.error('Connection error:', err.message);
});

setTimeout(() => {
    console.log('[+] Timeout reached, closing connection.');
    client.destroy();
}, 10000);
