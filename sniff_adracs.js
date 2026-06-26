const net = require('net');
const fs = require('fs');

// KONFIGURASI
const LISTEN_PORT = 950; // Port lokal yang akan dihubungi oleh ADRACS
const MOXA_IP = '192.168.51.10'; // IP Moxa LLZ
const MOXA_PORT = 950; // Port Moxa LLZ

console.log(`[Proxy] Menjalankan server di port ${LISTEN_PORT}...`);
console.log(`[Proxy] Silakan ubah IP di ADRACS menjadi 127.0.0.1 port ${LISTEN_PORT}`);

const server = net.createServer((adracsSocket) => {
    console.log(`\n[Proxy] ADRACS TERHUBUNG!`);
    
    // Hubungkan proxy ke Moxa NPort
    const moxaSocket = new net.Socket();
    moxaSocket.connect(MOXA_PORT, MOXA_IP, () => {
        console.log(`[Proxy] Terhubung ke Moxa ${MOXA_IP}:${MOXA_PORT}`);
    });

    // Teruskan data dari ADRACS ke Moxa (Ini yang mau kita intip!)
    adracsSocket.on('data', (data) => {
        const hex = data.toString('hex').match(/.{1,2}/g).join(' ');
        console.log(`[ADRACS -> MOXA] (${data.length} bytes): ${hex}`);
        fs.appendFileSync('adracs_trigger_dump.txt', `[ADRACS -> MOXA] ${hex}\n`);
        
        moxaSocket.write(data); // teruskan ke moxa
    });

    // Teruskan data dari Moxa ke ADRACS
    moxaSocket.on('data', (data) => {
        adracsSocket.write(data);
    });

    adracsSocket.on('error', () => {});
    moxaSocket.on('error', () => {});
    adracsSocket.on('close', () => console.log('[Proxy] ADRACS Terputus'));
});

server.listen(LISTEN_PORT, '0.0.0.0');
