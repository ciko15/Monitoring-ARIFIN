const net = require('net');
const fs = require('fs');

const IP = '192.168.50.160'; // Ganti dengan IP GP
const PORT = 950;          

console.log(`Connecting to ${IP}:${PORT}...`);
const client = new net.Socket();
client.connect(PORT, IP, () => {
    console.log('Connected! Sending Kickstart packet for GP...');
    client.write(Buffer.from([0x01, 0x30, 0x30, 0x02, 0x45, 0x39, 0x03, 0x34, 0x35]));
});

client.on('data', (data) => {
    const hex = data.toString('hex');
    console.log(`Received ${data.length} bytes: ${hex}`);
    fs.appendFileSync('ils_dump.txt', `${new Date().toISOString()} | ${data.length} bytes | ${hex}\n`);
    
    // Auto close after getting a large packet (likely the Monitor packet)
    if (data.length > 50) {
        console.log('Got a large packet! Saved to ils_dump.txt');
        setTimeout(() => client.destroy(), 2000);
    }
});

client.on('error', (err) => console.error(err.message));
client.on('close', () => console.log('Connection closed.'));
