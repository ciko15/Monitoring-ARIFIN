const net = require('net');
const fs = require('fs');

const HOST = '192.168.51.10'; // IP dari Localizer sesuai comment di parser
const PORT = 950;             // Port Moxa
const OUTPUT_FILE = 'llz_raw_dump_adrcs_off.txt';

const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);
const HBEAT_RECV = Buffer.from([0x13, 0x00, 0xF8, 0x06]);
const HBEAT_REPLY = Buffer.from([0x13, 0x00, 0xF9, 0x06]);

console.log(`Menghubungkan ke ${HOST}:${PORT}...`);

const client = new net.Socket();
const stream = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });

stream.write(`\n--- Capture Started at ${new Date().toISOString()} ---\n`);

client.connect(PORT, HOST, () => {
    console.log('Terhubung. Mengirimkan trigger awal...');
    client.write(TRIGGER_SEND);
    stream.write(`[TX] ${TRIGGER_SEND.toString('hex')}\n`);
});

client.on('data', (data) => {
    console.log(`Menerima ${data.length} bytes`);
    stream.write(`[RX] ${data.toString('hex')}\n`);
    
    // Balas heartbeat jika ada
    if (data.length >= 4 && data.slice(0, 4).equals(HBEAT_RECV)) {
        console.log('Menerima heartbeat dari device. Mengirim balasan...');
        client.write(HBEAT_REPLY);
        stream.write(`[TX] ${HBEAT_REPLY.toString('hex')}\n`);
    }
});

client.on('close', () => {
    console.log('Koneksi terputus.');
    stream.write('--- Connection Closed ---\n');
});

client.on('error', (err) => {
    console.error(`Error: ${err.message}`);
    stream.write(`[ERROR] ${err.message}\n`);
});

// Berhenti otomatis setelah 15 detik
setTimeout(() => {
    console.log('Berhenti capture otomatis setelah 15 detik.');
    client.destroy();
    stream.end();
    console.log(`\nSilakan berikan isi dari file ${OUTPUT_FILE} kepada saya.`);
}, 15000);
