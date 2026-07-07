const net = require('net');
const TARGET_IP = process.argv[2] || '192.168.51.10';
const TARGET_PORT = parseInt(process.argv[3]) || 950;

let currentByte = 0x00;
let client = null;
let timeoutTimer = null;

function testNext() {
    if (currentByte > 0xFF) {
        console.log('[!] Selesai mencari.');
        process.exit(0);
    }

    const trigger = Buffer.from([currentByte, 0x00, 0xF9, 0x06]);
    const hexStr = trigger.toString('hex').toUpperCase();
    console.log(`\n[*] Mencoba trigger: ${hexStr}`);

    client = new net.Socket();
    
    client.connect(TARGET_PORT, TARGET_IP, () => {
        client.write(trigger);
        
        timeoutTimer = setTimeout(() => {
            console.log(`    [-] Tidak ada respon 5600F906 dalam 1.5 detik.`);
            client.destroy();
            currentByte++;
            testNext();
        }, 1500);
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
            console.log(`    [+++] BINGO! Trigger ${hexStr} berhasil memancing paket DATA F0 06 (panjang: ${data.length} bytes)!`);
            console.log(`    [DATA] ${data.toString('hex')}`);
            clearTimeout(timeoutTimer);
            client.destroy();
            process.exit(0); // Berhenti karena sudah ketemu
        } else {
            console.log(`    [?] Menerima balasan tapi bukan F0 06 (panjang: ${data.length}): ${data.toString('hex')}`);
        }
    });

    client.on('error', (err) => {
        console.log(`    [x] Error: ${err.message}`);
        clearTimeout(timeoutTimer);
        client.destroy();
        currentByte++;
        testNext();
    });
}

console.log('Pastikan ADRACS MATI sebelum menjalankan ini!');
testNext();
