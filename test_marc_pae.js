const marc = require('./src/parsers/marc_pae.js')._internal;

// PENGATURAN TARGET
const HOST = '172.16.10.230'; // Ganti dengan IP Moxa
const PORT = 950;               // Port Moxa untuk PAE
const START_RSE = 1111;           // RSE ID Awal (contoh: 90)
const END_RSE = 1117;             // RSE ID Akhir (contoh: 97)

console.log(`\n======================================================`);
console.log(`📡 MARC PAE DISCOVERY TEST (Via Node.js)`);
console.log(`   Target : ${HOST}:${PORT}`);
console.log(`   RSE ID : ${START_RSE} sampai ${END_RSE}`);
console.log(`======================================================\n`);

console.log(`⏳ Sedang mencari... Mohon tunggu (sekitar ${(END_RSE - START_RSE + 1) * 8 * 150 / 1000 + 1} detik)\n`);

marc.discoverMarcRSEs(HOST, PORT, START_RSE, END_RSE, 1500)
    .then(result => {
        if (result.success) {
            if (result.data.length === 0) {
                console.log(`❌ Selesai. TIDAK ADA RADIO DITEMUKAN pada RSE ${START_RSE}-${END_RSE}.`);
                console.log(`   Saran: Pastikan IP/Port bisa diakses, atau MASTER_SRC di parser cocok dengan lokasi ini.`);
            } else {
                console.log(`✅ BERHASIL! Ditemukan RSE Aktif:`);
                console.log(JSON.stringify(result.data, null, 2));
            }
        } else {
            console.error(`❌ GAGAL: ${result.error}`);
        }
    })
    .catch(err => {
        console.error(`❌ Terjadi Kesalahan Eksekusi: ${err.message}`);
    });
