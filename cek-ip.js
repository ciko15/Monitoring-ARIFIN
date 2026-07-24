const net = require('net');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Cara penggunaan: node cek-ip.js <IP> <PORT>");
    console.log("Contoh: node cek-ip.js 62.17.8.112 38317");
    process.exit(1);
}

const TARGET_IP = args[0];
const TARGET_PORT = parseInt(args[1]);

console.log(`\n======================================================`);
console.log(`📡 MENCOBA TERHUBUNG (KOSONGAN TANPA TRIGGER)`);
console.log(`   Target IP   : ${TARGET_IP}`);
console.log(`   Target Port : ${TARGET_PORT}`);
console.log(`======================================================\n`);

const client = new net.Socket();
client.connect(TARGET_PORT, TARGET_IP, function() {
    console.log(`✅ BERHASIL: Terhubung ke ${TARGET_IP}:${TARGET_PORT}`);
    console.log(`⏳ Menunggu apabila perangkat mengirim data secara otomatis...\n`);
});

client.on('data', function(data) {
    console.log('\n--- 📥 MENERIMA DATA BARU ---');
    console.log(`Ukuran       : ${data.length} bytes`);
    
    // Cetak sebagai Hex
    let hexString = data.toString('hex').match(/.{1,2}/g).join(' ');
    console.log(`Hex Buffer   : ${hexString.toUpperCase()}`);
    
    // Cetak sebagai ASCII
    let asciiString = data.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
    console.log(`String ASCII : ${asciiString}`);
    console.log('-----------------------------');
});

client.on('close', function() {
    console.log('\n❌ KONEKSI DITUTUP oleh perangkat.');
});

client.on('error', function(err) {
    console.error(`\n⚠️ ERROR:`, err.message);
});
