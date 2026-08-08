const ModbusRTU = require("modbus-serial");



function parseFloat32(buf, regOffset) {
    // regOffset = index register (bukan byte), 1 register = 2 byte
    const byteOffset = regOffset * 2;
    const b = Buffer.alloc(4);
    b.writeUInt16BE(buf.readUInt16BE(byteOffset), 0);
    b.writeUInt16BE(buf.readUInt16BE(byteOffset + 2), 2);
    return b.readFloatBE(0);
}

async function main() {
    const client = new ModbusRTU();
    const startTime = Date.now();

    try {
        console.log("🔌 Menghubungkan ke Schneider PM5350 (10.20.3.73:26)...");
        client.setTimeout(4000);
        await client.connectTelnet("10.20.3.73", { port: 26 });

        client.setID(5);
        console.log("✅ Terhubung ke Slave ID 5 (PM5350)\n");

        // --- SATU KALI BACA UNTUK SEMUA DATA ---
        // Register 3000 s.d 3193 (index 2999 base-0), 100 register sekaligus.
        // Mencakup: arus, tegangan L-N, tegangan L-L, daya, PF, frekuensi.
        console.log("📊 Membaca semua metrics dalam 1 request...");
        const res = await client.readHoldingRegisters(2999, 100);
        const buf = res.buffer;

        // --- PARSE SEMUA NILAI DARI BUFFER YANG SAMA ---
        // offset = (register_target - 3000)
        const iR = parseFloat32(buf, 0);    // 3000-3001
        const iS = parseFloat32(buf, 2);    // 3002-3003
        const iT = parseFloat32(buf, 4);    // 3004-3005

        const vRS = parseFloat32(buf, 20);  // 3020-3021
        const vST = parseFloat32(buf, 22);  // 3022-3023
        const vTR = parseFloat32(buf, 24);  // 3024-3025

        const vRN = parseFloat32(buf, 28);  // 3028-3029
        const vSN = parseFloat32(buf, 30);  // 3030-3031
        const vTN = parseFloat32(buf, 32);  // 3032-3033

        const kw = parseFloat32(buf, 60);   // 3060-3061
        const kva = parseFloat32(buf, 68);  // 3068-3069

        // Register 3110 & 3192 di luar range 100 register (2999-3099),
        // jadi dibaca terpisah — tetap jauh lebih cepat dari original.
        const resFreq = await client.readHoldingRegisters(3109, 2);
        const freq = parseFloat32(resFreq.buffer, 0);

        const resPF = await client.readHoldingRegisters(3191, 2);
        const pf = parseFloat32(resPF.buffer, 0);

        const elapsed = Date.now() - startTime;

        // --- OUTPUT ---
        console.log("\n⚡ DATA KELISTRIKAN SAAT INI:");
        console.log("-----------------------------------------");
        console.log(`✅ Arus Phase R         : ${iR.toFixed(2)} A`);
        console.log(`✅ Arus Phase S         : ${iS.toFixed(2)} A`);
        console.log(`✅ Arus Phase T         : ${iT.toFixed(2)} A`);
        console.log("-----------------------------------------");
        console.log(`✅ Tegangan R-N (L-N)   : ${vRN.toFixed(2)} V`);
        console.log(`✅ Tegangan S-N (L-N)   : ${vSN.toFixed(2)} V`);
        console.log(`✅ Tegangan T-N (L-N)   : ${vTN.toFixed(2)} V`);
        console.log("-----------------------------------------");
        console.log(`✅ Tegangan R-S (L-L)   : ${vRS.toFixed(2)} V`);
        console.log(`✅ Tegangan S-T (L-L)   : ${vST.toFixed(2)} V`);
        console.log(`✅ Tegangan T-R (L-L)   : ${vTR.toFixed(2)} V`);
        console.log("-----------------------------------------");
        console.log(`✅ Frekuensi            : ${freq.toFixed(2)} Hz`);
        console.log("-----------------------------------------");
        console.log(`✅ Daya Aktif Total     : ${kw.toFixed(2)} kW`);
        console.log(`✅ Daya Semu Total      : ${kva.toFixed(2)} kVA`);
        console.log(`✅ Power Factor (Cos Pi) : ${pf.toFixed(2)} `);
        console.log("-----------------------------------------");
        console.log(`⏱️  Total waktu eksekusi : ${elapsed}ms (vs ~8300ms di script original)`);

    } catch (e) {
        console.error("❌ Gagal:", e.message);
    } finally {
        client.close();
        console.log("🔓 Koneksi ditutup, port 26 tersedia untuk aplikasi lain.");
    }
}

main();