const ModbusRTU = require("modbus-serial");

// Konfigurasi IP dan Port (Silakan ubah port di sini)
const HOST = "172.19.7.160";
const PORT = 8899; // <--- Ubah port sesuai keinginan Anda
const SLAVE_ID = 1;

async function testHumidity() {
    const client = new ModbusRTU();
    try {
        console.log(`🔌 Menghubungkan ke Sensor Suhu & Kelembapan (${HOST}:${PORT})...`);
        client.setTimeout(3000); 
        await client.connectTelnet(HOST, { port: PORT });
        
        client.setID(SLAVE_ID); 
        console.log(`✅ Terhubung ke Slave ID ${SLAVE_ID}\n`);

        console.log("🌡️  MEMBACA DATA SENSOR SUHU & KELEMBAPAN");
        console.log("-----------------------------------------");
        
        // Membaca Input Register alamat 1 dan 2
        const res = await client.readInputRegisters(1, 2);
        
        // Asumsi data perlu dibagi 10 (misal raw 231 = 23.1)
        const suhu = (res.data[0] / 10).toFixed(1);
        const humidity = (res.data[1] / 10).toFixed(1);
        
        console.log(`✅ Suhu Ruangan       : ${suhu} °C`);
        console.log(`✅ Kelembapan         : ${humidity} %`);
        console.log("-----------------------------------------");

    } catch (e) {
        console.error("❌ Gagal:", e.message);
    } finally {
        client.close();
    }
}

testHumidity();
