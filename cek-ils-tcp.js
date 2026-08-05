const net = require('net');

const args = process.argv.slice(2);
const TARGET_IP = args[0] || '172.19.7.181';
const TARGET_PORT = args[1] ? parseInt(args[1]) : 38317;

console.log(`\n======================================================`);
console.log(`📡 MENCOBA TERHUBUNG KE ILS NORMARC (GP / LLZ)`);
console.log(`   Target IP   : ${TARGET_IP}`);
console.log(`   Target Port : ${TARGET_PORT}`);
console.log(`======================================================\n`);

const client = new net.Socket();
let connectTimeout = setTimeout(() => {
    console.error(`⚠️ WAKTU HABIS: Tidak dapat terhubung ke ${TARGET_IP}:${TARGET_PORT} dalam 10 detik.`);
    client.destroy();
}, 10000);

client.connect(TARGET_PORT, TARGET_IP, function() {
    clearTimeout(connectTimeout);
    console.log(`✅ BERHASIL: Terhubung ke perangkat ${TARGET_IP}:${TARGET_PORT}`);
    console.log(`⏳ Mode PASSIVE AKTIF: Hanya mendengarkan aliran data tanpa mengirim perintah/trigger... (Aman & Tidak mengganggu)`);
});

client.on('data', function(data) {
    console.log('\n--- 📥 MENERIMA DATA BARU ---');
    console.log(`Ukuran       : ${data.length} bytes`);
    
    let hexString = data.toString('hex').match(/.{1,2}/g).join(' ');
    console.log(`Hex Buffer   : ${hexString.toUpperCase()}`);
    
    let asciiString = data.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
    console.log(`String ASCII : ${asciiString}`);
    console.log('-----------------------------');
});

client.on('error', (err) => {
    console.error('❌ KESALAHAN KONEKSI:', err.message);
});

client.on('close', () => {
    console.log('🔌 Koneksi ditutup oleh server.');
});
