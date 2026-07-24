const { spawn } = require('child_process');

console.log("======================================================");
console.log("📡 DME MOPAH PASSIVE SNIFFER (MENGUPING JARINGAN)");
console.log("======================================================\n");
console.log("Pastikan aplikasi PMDT sedang terbuka dan terkoneksi ke DME.");
console.log("Menunggu data lewat...\n");

// Jalankan TShark secara background tanpa mengubah konfigurasi sistem
// Kita hanya menyadap paket TCP dari port 38317 (DME)
const tshark = spawn('C:\\Program Files\\Wireshark\\tshark.exe', [
    '-f', 'tcp src port 38317 and src host 62.17.8.116',
    '-T', 'fields',
    '-e', 'tcp.payload',
    '-l' // Line-buffered
]);

tshark.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (!output) return;

    // Output tshark berupa hex string (contoh: 0102010130...)
    // Kita pecah per baris (jika ada banyak)
    const lines = output.split('\n');
    
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        
        // Terkadang tshark memisahkan dengan koma jika ada multiple PDU
        const payloads = line.split(',');
        for (let hexStr of payloads) {
            // Ubah string hex "01021d39..." menjadi buffer
            // TShark terkadang mengembalikan format dengan titik dua "01:02:1d..."
            hexStr = hexStr.replace(/:/g, ''); 
            
            if (hexStr.length > 0 && hexStr.length % 2 === 0) {
                const buf = Buffer.from(hexStr, 'hex');
                
                console.log('\n--- 📥 MENANGKAP DATA DIAM-DIAM ---');
                console.log(`Ukuran       : ${buf.length} bytes`);
                
                // Cetak Hex
                const formattedHex = buf.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
                console.log(`Hex Buffer   : ${formattedHex}`);
                
                // Coba konversi angka tebakan (Misal Power dan Delay)
                // Ini hanya simulasi pencarian angka
                console.log('-----------------------------------');
            }
        }
    }
});

tshark.stderr.on('data', (data) => {
    const msg = data.toString();
    // Abaikan pesan peringatan standar tshark
    if (!msg.includes('Capturing on')) {
        // console.error(`[TShark Info]: ${msg.trim()}`);
    }
});

tshark.on('close', (code) => {
    console.log(`\n❌ Penyadap berhenti dengan kode ${code}`);
});

tshark.on('error', (err) => {
    console.error(`\n⚠️ ERROR Gagal menjalankan TShark:`, err.message);
    console.log("Pastikan Wireshark terinstal di C:\\Program Files\\Wireshark\\tshark.exe");
});
