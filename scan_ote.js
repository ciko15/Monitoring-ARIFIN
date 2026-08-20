const ModbusRTU = require("modbus-serial");

const IP_TARGET = "10.20.3.73";
const PORT = 502;
const SLAVE_ID = 1;

// Rentang alamat register yang paling umum digunakan pabrikan
const RANGES_TO_SCAN = [
    { start: 0, end: 100 },
    { start: 1000, end: 1100 },
    { start: 4000, end: 4100 },
    { start: 7000, end: 7100 },
    { start: 40000, end: 40100 }
];

async function scanModbus() {
    console.log(`=================================================`);
    console.log(`🔍 MEMULAI PEMINDAIAN MODBUS PADA ${IP_TARGET}`);
    console.log(`=================================================\n`);
    
    const client = new ModbusRTU();
    
    try {
        await client.connectTCP(IP_TARGET, { port: PORT });
        client.setID(SLAVE_ID);
        client.setTimeout(1000); // 1 detik timeout per request
        console.log("✅ Berhasil terhubung ke Port 502.\n");
        
        let foundData = false;

        for (const range of RANGES_TO_SCAN) {
            console.log(`Memindai rentang alamat ${range.start} - ${range.end}...`);
            // Kita scan per blok 10 register agar tidak memberatkan alat
            for (let i = range.start; i <= range.end; i += 10) {
                try {
                    const res = await client.readHoldingRegisters(i, 10);
                    console.log(`   [!] DATA DITEMUKAN di Register ${i} - ${i+9} :`, res.data);
                    foundData = true;
                } catch (e) {
                    // Abaikan error "Illegal data address" (artinya kosong)
                    // Cetak titik agar tahu proses sedang berjalan
                    process.stdout.write(".");
                }
            }
            console.log("\n");
        }

        if (!foundData) {
            console.log("❌ Tidak ada data yang ditemukan di rentang umum.");
            console.log("Alat mungkin menggunakan Slave ID lain (seperti 255) atau register sangat spesifik.");
        } else {
            console.log("🎉 PEMINDAIAN SELESAI. Silakan catat register yang mengeluarkan angka di atas!");
        }

    } catch (err) {
        console.error("❌ Gagal terhubung ke Modbus:", err.message);
    } finally {
        client.close();
    }
}

scanModbus();
