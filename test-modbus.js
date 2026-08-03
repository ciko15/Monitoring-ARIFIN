const ModbusRTU = require("modbus-serial");

// Jeda antar request untuk mencegah tabrakan di converter
const DELAY = 500; 
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    const client = new ModbusRTU();
    try {
        console.log("🔌 Menghubungkan ke Schneider PM5350 (172.19.7.160:26)...");
        client.setTimeout(4000); 
        await client.connectTelnet("172.19.7.160", { port: 26 });
        
        client.setID(5);
        console.log("✅ Terhubung ke Slave ID 5 (PM5350)\n");

        console.log("⚡ DATA KELISTRIKAN SAAT INI:");
        console.log("-----------------------------------------");

        async function readFloat32(addr) {
            await sleep(DELAY);
            const res = await client.readHoldingRegisters(addr - 1, 2);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt16BE(res.buffer.readUInt16BE(0), 0);
            buffer.writeUInt16BE(res.buffer.readUInt16BE(2), 2);
            return buffer.readFloatBE(0);
        }

        // --- BACA ARUS ---
        const iR = await readFloat32(3000);
        const iS = await readFloat32(3002);
        const iT = await readFloat32(3004);
        console.log(`✅ Arus Phase R         : ${iR.toFixed(2)} A`);
        console.log(`✅ Arus Phase S         : ${iS.toFixed(2)} A`);
        console.log(`✅ Arus Phase T         : ${iT.toFixed(2)} A`);
        console.log("-----------------------------------------");

        // --- BACA TEGANGAN L-N ---
        const vRN = await readFloat32(3028);
        const vSN = await readFloat32(3030);
        const vTN = await readFloat32(3032);
        console.log(`✅ Tegangan R-N (L-N)   : ${vRN.toFixed(2)} V`);
        console.log(`✅ Tegangan S-N (L-N)   : ${vSN.toFixed(2)} V`);
        console.log(`✅ Tegangan T-N (L-N)   : ${vTN.toFixed(2)} V`);
        console.log("-----------------------------------------");

        // --- BACA TEGANGAN L-L ---
        const vRS = await readFloat32(3020);
        const vST = await readFloat32(3022);
        const vTR = await readFloat32(3024);
        console.log(`✅ Tegangan R-S (L-L)   : ${vRS.toFixed(2)} V`);
        console.log(`✅ Tegangan S-T (L-L)   : ${vST.toFixed(2)} V`);
        console.log(`✅ Tegangan T-R (L-L)   : ${vTR.toFixed(2)} V`);
        console.log("-----------------------------------------");

        // --- BACA FREKUENSI ---
        const freq = await readFloat32(3110);
        console.log(`✅ Frekuensi            : ${freq.toFixed(2)} Hz`);
        console.log("-----------------------------------------");

        // --- BACA DAYA ---
        const kw = await readFloat32(3060);
        const kva = await readFloat32(3068);
        const pf = await readFloat32(3192);
        console.log(`✅ Daya Aktif Total     : ${kw.toFixed(2)} kW`);
        console.log(`✅ Daya Semu Total      : ${kva.toFixed(2)} kVA`);
        console.log(`✅ Power Factor (Cos Pi) : ${pf.toFixed(2)} `);
        console.log("-----------------------------------------");

    } catch (e) {
        console.error("❌ Gagal:", e.message);
    } finally {
        client.close();
    }
}

main();
