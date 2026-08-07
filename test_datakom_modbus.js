const ModbusRTU = require('modbus-serial');
const client = new ModbusRTU();

// Konfigurasi Target Datakom D-700
const HOST = '172.19.10.190';
const PORT = 502;
const SLAVE_ID = 1; // Biasanya 1, 2, atau sesuaikan dengan setting alat

console.log(`\n======================================================`);
console.log(`🔌 MODBUS TCP TEST (Datakom D-700)`);
console.log(`   Target : ${HOST}:${PORT} | Slave ID: ${SLAVE_ID}`);
console.log(`======================================================\n`);

async function testModbus() {
    try {
        console.log(`⏳ Menghubungkan ke ${HOST}:${PORT}...`);
        
        // Atur timeout koneksi dan baca (dalam milidetik)
        client.setTimeout(3000);
        
        // Mulai koneksi TCP
        await client.connectTCP(HOST, { port: PORT });
        
        // Atur Slave ID
        client.setID(SLAVE_ID);
        
        console.log(`✅ BERHASIL terhubung!`);
        console.log(`⏳ Membaca parameter Holding Registers (FC 03)...`);

        // Contoh membaca register mulai dari address 0 sebanyak 10 register.
        // Anda bisa mengganti angka 0 dan 10 di bawah ini sesuai manual Modbus Datakom.
        const address = 0; 
        const length = 10;
        
        const data = await client.readHoldingRegisters(address, length);
        
        console.log(`✅ Data Diterima dari Address ${address}:`);
        console.log(data.data);
        
    } catch (e) {
        console.error('❌ Gagal melakukan test Modbus:', e.message);
    } finally {
        if (client.isOpen) {
            client.close();
            console.log('🔌 Koneksi ditutup.');
        }
    }
}

testModbus();
