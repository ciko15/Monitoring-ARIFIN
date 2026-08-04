const ModbusRTU = require("modbus-serial");

async function scanRegisters(client, type, startAddress, length) {
    try {
        let res;
        if (type === 'holding') {
            res = await client.readHoldingRegisters(startAddress, length);
        } else {
            res = await client.readInputRegisters(startAddress, length);
        }
        
        console.log(`[+] Sukses membaca ${type} registers dari alamat ${startAddress} s/d ${startAddress + length - 1}`);
        
        let foundData = false;
        for (let i = 0; i < length; i++) {
            const val = res.data[i];
            if (val !== 0) { 
                console.log(`    -> Address ${startAddress + i}: ${val} (Hex: 0x${val.toString(16).toUpperCase().padStart(4, '0')})`);
                foundData = true;
            }
        }
        return true;
    } catch (e) {
        // Exception 2 artinya alamat tidak ada, abaikan pesan error agar layar bersih
        if (e.message.includes("Exception 2") || e.message.includes("Illegal data address")) {
            return false; 
        }
        console.log(`[-] Gagal membaca ${type} dari alamat ${startAddress} : ${e.message}`);
        return false;
    }
}

async function sweepAddresses(client) {
    // Berbagai merk UPS (APC, Socomec, Liebert, Eaton, Delta) punya offset memori masing-masing
    const commonOffsets = [
        0, 1, 100, 200, 256, 1000, 1024, 2560, 4096, 5000, 8192, 12288, 20000, 30000, 40000
    ];

    console.log("Menyapu area memori yang umum dipakai UPS...");
    
    for (let offset of commonOffsets) {
        // Kita baca 10 register saja agar tidak error karena melebihi batas (out of bounds)
        await scanRegisters(client, 'holding', offset, 10);
        await scanRegisters(client, 'input', offset, 10);
    }
}

async function main() {
    const client = new ModbusRTU();
    const HOST = "172.19.7.142";
    const PORT = 502;   
    const SLAVE_ID = 1; 

    try {
        console.log(`🔌 Menghubungkan ke UPS (${HOST}:${PORT})...`);
        client.setTimeout(3000);
        await client.connectTCP(HOST, { port: PORT });
        
        client.setID(SLAVE_ID);
        console.log(`✅ Terhubung ke UPS (Slave ID ${SLAVE_ID})!\n`);
        console.log("🔍 MEMULAI SCANNING PINTAR (SMART SCAN)...\n");

        await sweepAddresses(client);

    } catch (e) {
        console.error("\n❌ Koneksi / Proses Gagal:", e.message);
    } finally {
        client.close();
        console.log("\n🔓 Selesai. Koneksi ditutup.");
    }
}

main();
