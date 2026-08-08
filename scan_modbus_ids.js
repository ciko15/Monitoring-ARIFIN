const ModbusRTU = require('modbus-serial');
const client = new ModbusRTU();

// --- PENGATURAN ---
const HOST = '192.168.100.151'; // Ganti dengan IP Moxa / Alat
const PORT = 502;             // Ganti dengan Port Moxa (502, 4001, 4002, dst)
const MIN_ID = 1;             // Mulai pencarian dari ID ini
const MAX_ID = 10;            // Batas pencarian ID (Bisa dinaikkan jika perlu)
// ------------------

console.log(`\n======================================================`);
console.log(`🔍 MODBUS SLAVE ID SCANNER`);
console.log(`   Target : ${HOST}:${PORT}`);
console.log(`   Scanning ID : ${MIN_ID} sampai ${MAX_ID}`);
console.log(`======================================================\n`);

async function scanModbus() {
    try {
        console.log(`⏳ Menghubungkan ke ${HOST}:${PORT}...`);

        client.setTimeout(2000); // Waktu tunggu per request 2 detik
        await client.connectTCP(HOST, { port: PORT });

        console.log(`✅ BERHASIL terhubung ke port jaringan! Mulai mencari ID perangkat...\n`);

        for (let id = MIN_ID; id <= MAX_ID; id++) {
            client.setID(id);
            process.stdout.write(`Mengecek ID ${id}... `);

            try {
                // Kita coba baca Holding Register alamat 0 (hanya 1 register)
                // Sebagian besar perangkat akan merespons ini jika ID-nya benar.
                const data = await client.readHoldingRegisters(0, 1);
                console.log(`✅ DITEMUKAN! Perangkat merespons (Data: ${data.data})`);
            } catch (err) {
                if (err.message.includes('Timed out')) {
                    console.log(`❌ Timeout (Tidak ada perangkat)`);
                } else if (err.message.includes('Gateway')) {
                    console.log(`❌ Gateway Exception (Moxa tidak bisa menjangkau alat)`);
                } else {
                    // Beberapa alat mungkin menolak membaca alamat 0 dengan error 'Illegal Data Address'
                    // Tetapi error ini BUKTI bahwa alat dengan ID tersebut ADA!
                    console.log(`✅ DITEMUKAN! (Alat menolak alamat 0, tapi memberikan respons: ${err.message})`);
                }
            }
        }
    } catch (e) {
        console.error('\n🚨 Gagal melakukan koneksi jaringan utama:', e.message);
        console.log('Pastikan IP dan Port sudah benar, dan PC Anda bisa mengakses jaringan tersebut.');
    } finally {
        if (client.isOpen) {
            client.close();
            console.log('\n🔌 Selesai. Koneksi ditutup.');
        }
    }
}

scanModbus();
