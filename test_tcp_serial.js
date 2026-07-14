const net = require('net');

const targetIP = process.argv[2] || '192.168.127.99';
const targetPort = parseInt(process.argv[3] || '5001', 10);

console.log(`[+] Mencoba koneksi TCP ke ${targetIP} Port ${targetPort}...`);
console.log(`[!] Tekan Ctrl+C untuk berhenti.\n`);

const client = new net.Socket();
let dataCount = 0;

client.connect(targetPort, targetIP, () => {
    console.log(`[+] BERHASIL TERHUBUNG ke ${targetIP}:${targetPort}`);
    console.log(`[!] Menunggu data serial masuk...\n`);
});

client.on('data', (data) => {
    dataCount++;
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1); // HH:mm:ss.SSS
    
    // Konversi ke format HEX
    const hexString = data.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
    
    // Konversi ke format ASCII (karakter yang tidak bisa diprint diganti '.')
    const asciiString = data.toString('ascii').replace(/[^\x20-\x7E]/g, '.');

    console.log(`[${timestamp}] Data #${dataCount} (${data.length} bytes):`);
    console.log(`  HEX   : ${hexString}`);
    console.log(`  ASCII : ${asciiString}`);
    console.log(`--------------------------------------------------`);
});

client.on('error', (err) => {
    console.log(`\n[-] ERROR: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
        console.log(`    -> Port ${targetPort} tertutup. Pastikan settingan Port TCP di Moxa sudah benar.`);
    } else if (err.code === 'ETIMEDOUT') {
        console.log(`    -> Timeout. Pastikan IP ${targetIP} bisa di-ping dan kabel jaringan tersambung.`);
    }
});

client.on('close', () => {
    console.log(`\n[-] Koneksi ditutup oleh server/perangkat.`);
});
