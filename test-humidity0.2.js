const ModbusRTU = require("modbus-serial");

// Konfigurasi IP dan Port
const HOST = "192.168.0.26";
const PORT = 8899; 
const SLAVE_ID = 1;

function parseFloat32(buf, regOffset) {
    const byteOffset = regOffset * 2;
    if (byteOffset + 4 > buf.length) return 0;
    const b = Buffer.alloc(4);
    b.writeUInt16BE(buf.readUInt16BE(byteOffset), 0);
    b.writeUInt16BE(buf.readUInt16BE(byteOffset + 2), 2);
    return b.readFloatBE(0);
}

async function main() {
    const client = new ModbusRTU();
    const startTime = Date.now();

    try {
        console.log(`🔌 Menghubungkan ke Sensor Suhu & Kelembapan (${HOST}:${PORT})...`);
        client.setTimeout(4000); 
        await client.connectTelnet(HOST, { port: PORT });
        
        client.setID(SLAVE_ID); 
        console.log(`✅ Terhubung ke Slave ID ${SLAVE_ID}\n`);

        console.log("📊 Membaca banyak register sekaligus (Versi 0.2)...");
        
        // Kita baca 10 register sekaligus dari alamat 0 untuk melihat isi data mentahnya
        // (Bisa FC04/Input Register atau FC03/Holding Register. Kita coba FC04 dulu seperti sebelumnya)
        const res = await client.readInputRegisters(0, 10);
        const buf = res.buffer;

        // Parse sebagai INT16 (dibagi 10)
        const val0 = res.data[0];
        const val1 = res.data[1];
        const val2 = res.data[2];
        const val3 = res.data[3];

        // Parse sebagai Float32 (menggunakan 2 register)
        const float0 = parseFloat32(buf, 0); // dari register 0 & 1
        const float2 = parseFloat32(buf, 2); // dari register 2 & 3

        const elapsed = Date.now() - startTime;

        console.log("\n🌡️  HASIL ANALISA DATA SENSOR");
        console.log("-----------------------------------------");
        console.log("A. Analisa sebagai Integer (dibagi 10):");
        console.log(`   Register 0 : ${val0}  -> ${(val0 / 10).toFixed(1)}`);
        console.log(`   Register 1 : ${val1}  -> ${(val1 / 10).toFixed(1)} (Suhu dari script sebelumnya)`);
        console.log(`   Register 2 : ${val2}  -> ${(val2 / 10).toFixed(1)} (Kelembapan yang error)`);
        console.log(`   Register 3 : ${val3}  -> ${(val3 / 10).toFixed(1)}`);
        
        console.log("\nB. Analisa sebagai Float32 (2 Register digabung):");
        console.log(`   Register 0-1 : ${float0.toFixed(2)}`);
        console.log(`   Register 2-3 : ${float2.toFixed(2)}`);
        console.log("-----------------------------------------");
        console.log(`⏱️  Total waktu eksekusi : ${elapsed}ms`);

    } catch (e) {
        console.error("❌ Gagal:", e.message);
    } finally {
        client.close();
        console.log("🔓 Koneksi ditutup.");
    }
}

main();
