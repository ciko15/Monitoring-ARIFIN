const net = require('net');
const TARGET_IP = process.argv[2] || '192.168.51.10';
const TARGET_PORT = parseInt(process.argv[3]) || 950;

let currentByte = 0x00;
let client = new net.Socket();
let timeoutTimer = null;

function sendNextTrigger() {
    if (currentByte > 0xFF) {
        console.log('[!] Selesai mencari. Tidak ada trigger yang cocok.');
        client.destroy();
        process.exit(0);
    }

    const trigger = Buffer.from([currentByte, 0x00, 0xF9, 0x06]);
    const hexStr = trigger.toString('hex').toUpperCase();
    console.log(`\n[*] Mencoba trigger: ${hexStr}`);
    
    client.write(trigger);
    
    timeoutTimer = setTimeout(() => {
        console.log(`    [-] Tidak ada respon paket DATA F0 06 dalam 1.5 detik.`);
        currentByte++;
        sendNextTrigger();
    }, 1500);
}

console.log('Pastikan ADRACS MATI sebelum menjalankan ini!');
console.log(`Menghubungkan ke ${TARGET_IP}:${TARGET_PORT}...`);

client.connect(TARGET_PORT, TARGET_IP, () => {
    console.log('[+] Berhasil terhubung! Memulai brute-force trigger...');
    sendNextTrigger();
});

client.on('data', (data) => {
    // Cek apakah ada F0 06 di dalam data (header paket data ILS Thales)
    let found = false;
    for (let i = 0; i <= data.length - 2; i++) {
        if (data[i] === 0xF0 && data[i+1] === 0x06) {
            found = true;
            break;
        }
    }
    
    if (found) {
        console.log(`    [+++] BINGO! Trigger berhasil memancing paket DATA F0 06 (panjang: ${data.length} bytes)!`);
        console.log(`    [DATA] ${data.toString('hex')}`);
        clearTimeout(timeoutTimer);
        client.destroy();
        process.exit(0);
    } else {
        console.log(`    [?] Menerima balasan tapi bukan F0 06 (panjang: ${data.length}): ${data.toString('hex')}`);
    }
});

client.on('error', (err) => {
    console.log(`[x] Connection Error: ${err.message}`);
    clearTimeout(timeoutTimer);
    client.destroy();
});
