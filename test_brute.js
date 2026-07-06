const net = require('net');
const HOST = '192.168.51.10';
const PORT = 950;

// Daftar kemungkinan "kata sandi" untuk meminta data
const triggers = [
    '0100F906', '0200F906', '0300F906', '0400F906',
    '0500F906', '0600F906', '0700F906', '0800F906',
    '0900F906', '0A00F906', '0B00F906', '0C00F906',
    '1000F906', '1200F906', '1400F906', '1500F906',
    '1A00F906', '1C00F906', '1D00F906', '1E00F906',
    '1F00F906', '2000F906', '3000F906', '4000F906',
    '5000F906', '5500F906', '6000F906', '7000F906',
    '8000F906', '9000F906', 'A000F906', 'F000F906'
];

let idx = 0;
const client = new net.Socket();

// Pastikan ADRACS DALAM KEADAAN MATI SEBELUM MENJALANKAN INI
console.log('Pastikan ADRACS sedang DIMATIKAN ya!');
console.log('Mencari kata sandi (Request Packet) ke ' + HOST + '...\n');

client.connect(PORT, HOST, () => {
    console.log('Connected! Memulai pencarian...');
    sendNextTrigger();
});

function sendNextTrigger() {
    if (idx >= triggers.length) {
        console.log('\nSelesai mencoba semua!');
        client.destroy();
        return;
    }
    const hexStr = triggers[idx];
    console.log('\n---> Mengirim paket: ' + hexStr);
    client.write(Buffer.from(hexStr, 'hex'));
    idx++;
    
    // Tunggu 1 detik untuk melihat balasan, lalu coba paket berikutnya
    setTimeout(sendNextTrigger, 1000);
}

client.on('data', (chunk) => {
    const hex = chunk.toString('hex').toUpperCase();
    if (hex.includes('5600F906')) {
        console.log('✅ BINGO! ALAT MENGIRIM DATA (5600F906)!');
        console.log('Kata sandi yang benar adalah: ' + triggers[idx - 1]);
        client.destroy();
    } else {
        console.log('     Balasan (' + chunk.length + ' bytes): ' + hex.substring(0, 50) + '...');
    }
});

client.on('error', (err) => { console.log('Error: ' + err.message); });
