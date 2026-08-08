const net = require('net');
const marc = require('./src/parsers/marc_pae.js')._internal;

const HOST = '172.16.10.230'; // IP Moxa yang baru Anda ubah
const PORT = 950;

console.log(`\n======================================================`);
console.log(`🕵️‍♂️ MARC PAE SNIFFER (PENYADAP JARINGAN)`);
console.log(`   Target : ${HOST}:${PORT}`);
console.log(`======================================================\n`);
console.log(`⏳ Menghubungkan ke ${HOST}:${PORT} (Mode diam/mendengarkan)...`);

const sock = new net.Socket();
const extractor = new marc.FrameExtractor();

sock.connect(PORT, HOST, () => {
    console.log(`✅ BERHASIL terhubung ke port jaringan!`);
    console.log(`Menunggu ada lalu lintas data dari aplikasi asli atau RSE (tekan Ctrl+C untuk berhenti)...\n`);
});

sock.on('data', (chunk) => {
    console.log(`[RAW DATA IN] ${chunk.length} bytes`);

    const frames = extractor.feed(chunk);
    for (const frame of frames) {
        const decoded = marc.decodeFrame(frame);
        if (decoded) {
            console.log(`✅ [PAKET DITEMUKAN!]`);
            console.log(`   => RSE ID / Dest : ${decoded.dest}`);
            console.log(`   => Master Address: ${decoded.src} (Hex: 0x${decoded.src.toString(16).padStart(4, '0')})`);
            console.log(`   => Payload Length: ${decoded.payload.length} bytes`);
            console.log(`------------------------------------------------------`);
        }
    }
});

sock.on('error', (err) => {
    console.error(`🚨 Error: ${err.message}`);
});

sock.on('close', () => {
    console.log(`🔌 Koneksi terputus.`);
});
