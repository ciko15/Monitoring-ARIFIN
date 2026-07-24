const net = require('net');

// Konfigurasi IP dan Port berdasarkan temuan Wireshark
// Anda bisa mengubah ini saat pengujian di lapangan
const args = process.argv.slice(2);
const TARGET_IP = args[0] || '62.17.8.116';
const TARGET_PORT = args[1] ? parseInt(args[1]) : 38317;

console.log(`\n======================================================`);
console.log(`📡 MENCOBA TERHUBUNG KE DVOR DME`);
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
    console.log(`⏳ Menunggu data masuk...\n`);
    
    // Jika perangkat membutuhkan trigger/pertanyaan agar membalas,
    // kita bisa uncomment dan ubah isi buffer di bawah ini:
    // const triggerCommand = Buffer.from([0x01, 0x02, 0x03]);
    // console.log(`-> Mengirim trigger command:`, triggerCommand.toString('hex'));
    // client.write(triggerCommand);
});

client.on('data', function(data) {
    console.log('\n--- 📥 MENERIMA DATA BARU ---');
    console.log(`Ukuran       : ${data.length} bytes`);
    
    // Format HEX (Sangat berguna untuk referensi protokol proprietary)
    let hexString = data.toString('hex').match(/.{1,2}/g).join(' ');
    console.log(`Hex Buffer   : ${hexString.toUpperCase()}`);
    
    // Format ASCII (Barangkali ada pesan teks murni)
    // Menghilangkan karakter-karakter aneh (non-printable) agar tampilan rapi
    let asciiString = data.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
    console.log(`String ASCII : ${asciiString}`);
    console.log('-----------------------------');

    // CONTOH METODE PARSING (Jika panjang paket sesuai dengan Wireshark, misalnya 17 bytes)
    /*
    if (data.length === 17) {
        // Contoh cara membaca nilai byte per byte:
        const byte1 = data.readUInt8(0);
        const commandType = data.readUInt8(4);
        console.log(`> [Parsing] Byte 1: 0x${byte1.toString(16)} | Command: 0x${commandType.toString(16)}`);
    }
    */
});

client.on('close', function(hasError) {
    clearTimeout(connectTimeout);
    if (!hasError) {
        console.log('\n❌ KONEKSI DITUTUP oleh perangkat DVOR.');
    }
});

client.on('error', function(err) {
    clearTimeout(connectTimeout);
    console.error(`\n⚠️ ERROR KONEKSI:`, err.message);
    if (err.code === 'ECONNREFUSED') {
        console.log(`-> Tips: Port ${TARGET_PORT} sedang ditutup oleh perangkat. Cobalah ganti port (misal: 3817) atau cek IP.`);
    }
});
