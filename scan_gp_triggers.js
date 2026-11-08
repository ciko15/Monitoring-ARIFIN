/**
 * scan_gp_triggers.js
 * Menguji berbagai variasi byte trigger untuk Thales ILS 422 GlidePath di Sentani (192.168.50.160:950)
 */

const net = require('net');

const HOST = '192.168.50.160';
const PORT = 950;

// Kandidat trigger Thales GlidePath 422:
const CANDIDATES = [
    { label: '0B 00 F9 06 (LLZ Trigger)', bytes: Buffer.from([0x0B, 0x00, 0xF9, 0x06]) },
    { label: '0B 00 E9 06 (GP Alternate)', bytes: Buffer.from([0x0B, 0x00, 0xE9, 0x06]) },
    { label: '13 00 F9 06 (Heartbeat Ack)', bytes: Buffer.from([0x13, 0x00, 0xF9, 0x06]) },
    { label: '0C 00 F9 06 (Poll Subtype 0C)', bytes: Buffer.from([0x0C, 0x00, 0xF9, 0x06]) },
    { label: '01 00 F9 06 (Poll Subtype 01)', bytes: Buffer.from([0x01, 0x00, 0xF9, 0x06]) },
    { label: '11 8D 40 0C (Direct Header 0C)', bytes: Buffer.from([0x11, 0x8D, 0x40, 0x0C]) },
    { label: '11 8D 40 01 (Direct Header 01)', bytes: Buffer.from([0x11, 0x8D, 0x40, 0x01]) },
    { label: '56 00 F9 06 (Sync Data Req)', bytes: Buffer.from([0x56, 0x00, 0xF9, 0x06]) },
];

let idx = 0;

function testNext() {
    if (idx >= CANDIDATES.length) {
        console.log('\n[!] Selesai menguji seluruh trigger. Jika semua 0 bytes, maka Real COM Mode Moxa GP memang memblokir koneksi TCP kedua saat ADRACS aktif.');
        process.exit(0);
    }

    const item = CANDIDATES[idx];
    console.log(`\n[+] [${idx + 1}/${CANDIDATES.length}] Mencoba: ${item.label} ...`);

    const client = new net.Socket();
    client.setTimeout(3000);

    let received = false;

    client.connect(PORT, HOST, () => {
        client.write(item.bytes);
    });

    client.on('data', (d) => {
        received = true;
        console.log(`   [BINGO!] BERHASIL MEMANCING RESPON DARI GP!`);
        console.log(`   Panjang respon : ${d.length} bytes`);
        console.log(`   Hex sample     : ${d.slice(0, 32).toString('hex')}`);
        client.destroy();
        console.log(`\n>>> TRIGGER YANG COCOK UNTUK THALES 422 GP ADALAH: ${item.label} <<<`);
        process.exit(0);
    });

    client.on('timeout', () => {
        console.log(`   [-] Tidak ada respon dalam 3 detik.`);
        client.destroy();
        idx++;
        testNext();
    });

    client.on('error', (err) => {
        console.log(`   [-] Error: ${err.message}`);
        client.destroy();
        idx++;
        testNext();
    });
}

testNext();
