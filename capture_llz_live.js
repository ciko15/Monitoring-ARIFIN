const net = require('net');
const fs = require('fs');
const path = require('path');

const HOST = '192.168.51.10'; // IP LLZ Thales
const PORT = 950;
const DURATION_SEC = 15;
const OUTPUT_FILE = path.join(__dirname, 'llz_raw_dump.json');

console.log(`=======================================================`);
console.log(`[+] CAPTURE RAW STREAM LLZ THALES 420/421 (${HOST}:${PORT})`);
console.log(`[+] Mengambil data ASLI / REAL dari alat saat aplikasi bawaan hidup...`);
console.log(`=======================================================`);

const client = new net.Socket();
const packets = [];
let totalBytes = 0;
let rawBuffer = Buffer.alloc(0);

// Catatan: saat aplikasi bawaan hidup, kita hanya SNIFFER (PASSIVE LISTENER)
// tanpa mengirim trigger agar tidak mengganggu komunikasi aplikasi bawaan
client.connect(PORT, HOST, () => {
    console.log(`[+] Terhubung ke ${HOST}:${PORT}`);
    console.log(`[+] Mendengarkan stream pasif (Passive Sniffing)...`);

    setTimeout(() => {
        console.log(`\n[+] Selesai capture. Menutup koneksi...`);
        client.destroy();
        analyzeCapturedData(rawBuffer, packets);
    }, DURATION_SEC * 1000);
});

client.on('data', (chunk) => {
    totalBytes += chunk.length;
    rawBuffer = Buffer.concat([rawBuffer, chunk]);
    process.stdout.write(`.`);

    packets.push({
        timestamp: new Date().toISOString(),
        length: chunk.length,
        hex: chunk.toString('hex')
    });
});

client.on('error', (err) => {
    console.error(`\n[!] Socket Error:`, err.message);
});

function analyzeCapturedData(buf, rawPackets) {
    console.log(`\n\n================ HASIL ANALISIS RAW DATA LLZ ================`);
    console.log(`Total Bytes Diterima : ${buf.length} bytes`);
    console.log(`Total Chunk Diterima : ${rawPackets.length} paket`);

    const frames = [];
    for (let i = 0; i <= buf.length - 4; i++) {
        if (buf[i] === 0x11 && buf[i + 1] === 0x8D) {
            const byte2 = buf[i + 2];
            const byte3 = buf[i + 3];
            const byte4 = i + 4 < buf.length ? buf[i + 4] : null;

            const frameCandidate = {
                pos: i,
                headerHex: buf.slice(i, i + 8).toString('hex').toUpperCase(),
                byte2_hex: byte2.toString(16).padStart(2, '0'),
                byte3_hex: byte3.toString(16).padStart(2, '0'),
                byte4_hex: byte4 !== null ? byte4.toString(16).padStart(2, '0') : '--',
            };

            if (i + 92 <= buf.length) {
                const subBuf = buf.slice(i, i + 92);
                frameCandidate.floats = {};
                for (let off = 4; off <= 88; off += 2) {
                    try {
                        const val = subBuf.readFloatLE(off);
                        if (isFinite(val) && Math.abs(val) < 20000 && Math.abs(val) > 0.00001) {
                            frameCandidate.floats[`off_${off}`] = parseFloat(val.toFixed(3));
                        }
                    } catch (e) {}
                }
            }
            frames.push(frameCandidate);
        }
    }

    console.log(`Jumlah Frame Sinkronisasi (0x118D) Ditemukan: ${frames.length}`);

    // Kelompokkan berdasarkan Byte[3] (Subtype) dan Byte[4] (Source)
    const groups = {};
    frames.forEach(f => {
        const key = `Subtype:0x${f.byte3_hex}_Byte4:0x${f.byte4_hex}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(f);
    });

    console.log(`\nVariasi Tipe Paket Frame yang Ditemukan:`);
    for (const [key, list] of Object.entries(groups)) {
        console.log(`\n>>> [${key}] (Muncul ${list.length} kali)`);
        console.log(`Sampel Header : ${list[0].headerHex}`);
        console.log(`Sampel Floats :`, JSON.stringify(list[0].floats));
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
        meta: { host: HOST, port: PORT, bytes: buf.length },
        groupsSample: groups
    }, null, 2));

    console.log(`\n[+] Log tersimpan di: ${OUTPUT_FILE}`);
    console.log(`=============================================================\n`);
}
