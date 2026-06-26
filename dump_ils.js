const net = require('net');
const fs = require('fs');

const IP = '192.168.51.10'; // Ganti jika IP Localizer beda
const PORT = 2001;          // Ganti jika port beda

console.log(`Connecting to ${IP}:${PORT}...`);
const client = new net.Socket();
client.connect(PORT, IP, () => {
    console.log('Connected! Listening for data (Please ensure ADRACS is open on the Monitor tab)...');
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
