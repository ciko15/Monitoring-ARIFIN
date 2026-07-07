const net = require('net');
const TARGET_IP = process.argv[2] || '192.168.51.10';
const TARGET_PORT = 950;

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
        // Cek apakah ada 56 00 F9 06 di dalam data
        let found = false;
        for (let i = 0; i <= data.length - 4; i++) {
            if (data[i] === 0x56 && data[i+1] === 0x00 && data[i+2] === 0xF9 && data[i+3] === 0x06) {
                found = true;
                break;
            }
        }
        
        if (found) {
            console.log(`    [+++] BINGO! Trigger ${hexStr} berhasil memancing paket 56 00 F9 06!`);
            clearTimeout(timeoutTimer);
            client.destroy();
            process.exit(0); // Berhenti karena sudah ketemu
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
