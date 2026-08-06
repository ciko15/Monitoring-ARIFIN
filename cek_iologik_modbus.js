const ModbusRTU = require("modbus-serial");

const args = process.argv.slice(2);
const TARGET_IP = args[0] || '10.20.3.73';
const TARGET_PORT = args[1] ? parseInt(args[1]) : 502; // Default Modbus TCP
const SLAVE_ID = 1; // ioLogik biasanya 1

const client = new ModbusRTU();

console.log(`\n======================================================`);
console.log(`📡 MODBUS SCANNER: Moxa ioLogik 4000`);
console.log(`   Target IP   : ${TARGET_IP}`);
console.log(`   Target Port : ${TARGET_PORT}`);
console.log(`======================================================\n`);

async function scanIoLogik() {
    try {
        console.log(`⏳ Menghubungkan ke ${TARGET_IP}:${TARGET_PORT}...`);
        client.setTimeout(3000);
        await client.connectTCP(TARGET_IP, { port: TARGET_PORT });
        client.setID(SLAVE_ID);
        console.log(`✅ BERHASIL Terhubung!`);

        // Mencari batas maksimal Digital Input (DI)
        let maxDI = 0;
        let diData = [];
        for (let i = 8; i <= 64; i += 8) {
            try {
                const res = await client.readDiscreteInputs(0, i);
                maxDI = i;
                diData = res.data;
            } catch (e) {
                break; // Stop jika timeout atau illegal address
            }
        }
        console.log(`\n▶️ Maksimal Digital Inputs (DI) yang bisa dibaca: ${maxDI} Pin (${maxDI/8} Slot)`);
        
        // Mencari batas maksimal Digital Output (DO)
        let maxDO = 0;
        let doData = [];
        for (let i = 8; i <= 64; i += 8) {
            try {
                const res = await client.readCoils(0, i);
                maxDO = i;
                doData = res.data;
            } catch (e) {
                break;
            }
        }
        console.log(`▶️ Maksimal Digital Outputs (DO) yang bisa dibaca: ${maxDO} Pin (${maxDO/8} Slot)`);

        console.log(`\n======================================================`);
        console.log(`🔌 PEMETAAN SLOT`);
        console.log(`======================================================`);
        
        let totalBits = [];
        // Print DI slots
        for(let s = 0; s < maxDI / 8; s++) {
            const chunk = diData.slice(s*8, (s+1)*8).map(v => v ? 1 : 0);
            totalBits = totalBits.concat(chunk);
            console.log(`[Slot ${s+1} - DI] (Bits ${s*8}-${s*8+7}) :`, chunk.join(' '));
        }

        // Print DO slots (lanjutkan index slot)
        const startingSlotDO = (maxDI / 8) + 1;
        for(let s = 0; s < maxDO / 8; s++) {
            const chunk = doData.slice(s*8, (s+1)*8).map(v => v ? 1 : 0);
            totalBits = totalBits.concat(chunk);
            console.log(`[Slot ${startingSlotDO + s} - DO] (Coils ${s*8}-${s*8+7}) :`, chunk.join(' '));
        }

        console.log(`\nTotal bit tergabung (DI + DO) = ${totalBits.length} bit`);
        if (totalBits.length >= 48) {
            console.log(`\n✅ Cukup untuk 48 bit konfigurasi (6 Slot)!`);
        }

    } catch (e) {
        console.error(`\n🚨 KESALAHAN KONEKSI:`, e.message);
    } finally {
        console.log(`\n🔌 Menutup koneksi...`);
        client.close();
    }
}

scanIoLogik();
