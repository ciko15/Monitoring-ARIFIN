const ModbusRTU = require("modbus-serial");

const ip = process.argv[2] || "192.168.26.54";
const port = 502;
const client = new ModbusRTU();

// Atur timeout agar tidak menunggu terlalu lama jika port tertutup
client.setTimeout(3000);

console.log(`\n🔌 MENCOBA KONEKSI MODBUS TCP KE: ${ip}:${port}`);
console.log('========================================================');

async function scanModbus() {
    try {
        // Coba koneksi ke port Modbus TCP
        await client.connectTCP(ip, { port: port });
        console.log(`✅ BERHASIL TERHUBUNG ke ${ip} port ${port}!`);
        
        // Atur Modbus ID (biasanya UPS menggunakan ID 1)
        client.setID(1);
        console.log('📡 Mencoba membaca Holding Registers (Alamat 0 - 50)...');

        // Coba baca 50 register pertama
        const data = await client.readHoldingRegisters(0, 50);
        
        console.log('\n📊 HASIL PEMBACAAN REGISTER:');
        console.log(data.data);
        console.log('\n✅ Perangkat ini mendukung komunikasi Modbus!');
        
    } catch (e) {
        console.log('\n❌ GAGAL MEMBACA DATA MODBUS:');
        if (e.message.includes('Timed out')) {
            console.log('Alasan: Koneksi Timeout (Port 502 mungkin ditutup atau perangkat tidak mendukung Modbus TCP).');
        } else if (e.message.includes('ECONNREFUSED')) {
            console.log('Alasan: Koneksi Ditolak (Port 502 tertutup rapat di perangkat tersebut).');
        } else if (e.message.includes('GatewayPathUnavailable') || e.message.includes('TargetisFailed')) {
            console.log('Alasan: Port 502 terbuka, tapi Modbus ID salah atau sensor internal UPS tidak merespon.');
        } else {
            console.log('Alasan:', e.message);
        }
    } finally {
        client.close();
    }
}

scanModbus();
