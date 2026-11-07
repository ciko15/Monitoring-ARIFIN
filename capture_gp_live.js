const net = require('net');
const fs = require('fs');
const path = require('path');

const HOST = '192.168.50.160';
const PORT = 950;
const DURATION_SEC = 15; // Ambil data selama 15 detik
const OUTPUT_FILE = path.join(__dirname, 'gp_raw_dump.json');

console.log(`=======================================================`);
console.log(`[+] CAPTURE RAW STREAM GP THALES 421 (${HOST}:${PORT})`);
console.log(`[+] Mengambil data ASLI / REAL dari alat selama ${DURATION_SEC} detik...`);
console.log(`=======================================================`);

const client = new net.Socket();
const packets = [];
let totalBytes = 0;
let rawBuffer = Buffer.alloc(0);

// Protokol trigger Thales 421
const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);

client.connect(PORT, HOST, () => {
    console.log(`[+] Terhubung ke ${HOST}:${PORT}`);
    console.log(`[+] Mengirim trigger poll...`);
    client.write(TRIGGER_SEND);

    // Kirim trigger setiap 3 detik agar aliran data tetap hidup jika ADRACS pasif
    const triggerInterval = setInterval(() => {
        try {
            client.write(TRIGGER_SEND);
        } catch (e) {}
    }, 3000);

    setTimeout(() => {
        clearInterval(triggerInterval);
        console.log(`\n[+] Selesai capture. Menutup koneksi...`);
        client.destroy();

        // Analisis frame yang terkumpul
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
    console.log(`\n\n================ HASIL ANALISIS RAW DATA ================`);
    console.log(`Total Bytes Diterima : ${buf.length} bytes`);
    console.log(`Total Chunk Diterima : ${rawPackets.length} paket`);

    // Cari semua paket yang berawalan sync Thales: 11 8D ?? (0C atau 0E)
    const frames = [];
    for (let i = 0; i <= buf.length - 4; i++) {
        if (buf[i] === 0x11 && buf[i + 1] === 0x8D) {
            const byte2 = buf[i + 2];
            const byte3 = buf[i + 3];
            const byte4 = i + 4 < buf.length ? buf[i + 4] : null;
            
            // Simpan posisi dan kandidat frame
            const frameCandidate = {
                pos: i,
                headerHex: buf.slice(i, i + 8).toString('hex').toUpperCase(),
                byte0_hex: buf[i].toString(16).padStart(2, '0'),
                byte1_hex: buf[i + 1].toString(16).padStart(2, '0'),
                byte2_hex: byte2.toString(16).padStart(2, '0'),
                byte3_hex: byte3.toString(16).padStart(2, '0'),
                byte4_hex: byte4 !== null ? byte4.toString(16).padStart(2, '0') : '--',
                rawSlice: buf.slice(i, Math.min(i + 92, buf.length)).toString('hex')
            };

            // Baca nilai float32 LE pada beberapa offset penting
            if (i + 92 <= buf.length) {
                const subBuf = buf.slice(i, i + 92);
                frameCandidate.floats = {};
                for (let off = 4; off <= 88; off += 4) {
                    try {
                        const val = subBuf.readFloatLE(off);
                        if (isFinite(val) && Math.abs(val) < 100000 && Math.abs(val) > 0.0001) {
                            frameCandidate.floats[`off_${off}`] = parseFloat(val.toFixed(4));
                        }
                    } catch (e) {}
                }
            }

            frames.push(frameCandidate);
        }
    }

    console.log(`Jumlah Frame Sinkronisasi (0x118D) Ditemukan: ${frames.length}`);

    // Tampilkan beberapa frame unik pertama
    frames.slice(0, 5).forEach((f, idx) => {
        console.log(`\n--- FRAME #${idx + 1} (Offset ${f.pos}) ---`);
        console.log(`Header (8 bytes) : ${f.headerHex}`);
        console.log(`Byte[2] (Flag)   : 0x${f.byte2_hex} (${(parseInt(f.byte2_hex, 16) & 0x40) ? 'TX1 MAIN' : 'TX2 MAIN'})`);
        console.log(`Byte[3] (Subtype): 0x${f.byte3_hex}`);
        console.log(`Byte[4] (Source) : 0x${f.byte4_hex}`);
        console.log(`Float32 Valid    :`, JSON.stringify(f.floats));
    });

    // Simpan ke file untuk diperiksa secara detail
    const outputData = {
        meta: {
            host: HOST,
            port: PORT,
            capturedAt: new Date().toISOString(),
            totalBytes: buf.length,
            framesCount: frames.length
        },
        frames: frames.slice(0, 30), // 30 frame sampel
        rawStreamHexSample: buf.slice(0, 2048).toString('hex')
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    console.log(`\n[+] Log lengkap disimpan ke: ${OUTPUT_FILE}`);
    console.log(`=========================================================\n`);
}
