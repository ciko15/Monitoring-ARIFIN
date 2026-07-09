const net = require('net');

const CONFIG = {
    LLZ: { ip: '192.168.127.20', port: 4001, name: 'Localizer (LLZ)' },
    GP: { ip: '192.168.127.30', port: 4001, name: 'GlidePath (GP)' }
};

// Trigger command commonly used for Normarc 7000 series (RMM polling)
// Byte 0x0B = Start, 0x00 = Addr, 0xF9 = Command, 0x06 = Checksum
const POLL_TRIGGER = Buffer.from([0x0b, 0x00, 0xf9, 0x06]);

function startDiagnostic(device) {
    console.log(`\n[${device.name}] Memulai percobaan koneksi ke ${device.ip}:${device.port}...`);
    
    const client = new net.Socket();
    let isConnected = false;

    // Timeout untuk koneksi awal
    client.setTimeout(5000);

    client.connect(device.port, device.ip, () => {
        isConnected = true;
        console.log(`[${device.name}] ✅ TERHUBUNG ke ${device.ip}:${device.port}`);
        
        // Kirim trigger pertama
        console.log(`[${device.name}] Mengirim trigger polling (Hex: 0b00f906)...`);
        client.write(POLL_TRIGGER);

        // Polling berulang setiap 5 detik
        setInterval(() => {
            if (isConnected) {
                console.log(`[${device.name}] Mengirim ulang trigger polling...`);
                client.write(POLL_TRIGGER);
            }
        }, 5000);
    });

    client.on('data', (data) => {
        const hexString = data.toString('hex').toUpperCase();
        console.log(`\n[${device.name}] 📥 DATA DITERIMA (${data.length} bytes):`);
        console.log(`>> RAW HEX: ${hexString}`);
        
        // Jika data panjang (kemungkinan berisi parameter), kita siap mem-parsingnya nanti
        if (data.length > 5) {
            console.log(`[${device.name}] 🔎 Data berpotensi valid untuk diparsing. Mohon copy RAW HEX di atas dan kirimkan ke saya.`);
        } else {
            console.log(`[${device.name}] ⚠️ Data terlalu pendek, mungkin ini hanya balasan acknowledgement.`);
        }
    });

    client.on('timeout', () => {
        console.log(`[${device.name}] ❌ TIMEOUT: Tidak ada respons dari ${device.ip}:${device.port} (Pastikan IP, Port, dan jaringan Moxa terhubung).`);
        client.destroy();
    });

    client.on('error', (err) => {
        console.log(`[${device.name}] ❌ ERROR: ${err.message}`);
    });

    client.on('close', () => {
        isConnected = false;
        console.log(`[${device.name}] 🔌 Koneksi terputus.`);
    });
}

// Mulai pengecekan untuk LLZ dan GP
console.log('======================================================');
console.log('  ALAT DIAGNOSTIK KONEKSI NORMAC LLZ & GP (TIMIKA)    ');
console.log('======================================================');
startDiagnostic(CONFIG.LLZ);
setTimeout(() => startDiagnostic(CONFIG.GP), 2000); // Beri jeda 2 detik sebelum mengetes GP
