const net = require('net');
const fs = require('fs');
const path = require('path');

const HOST = '192.168.51.10';
const PORT = 950;
const DURATION_SEC = 10;
const OUTPUT_FILE = path.join(__dirname, 'llz_scan_all.json');

console.log(`[+] SCANNING ALL HEADERS & SYNC PATTERNS ON ${HOST}:${PORT}...`);

const client = new net.Socket();
let rawBuf = Buffer.alloc(0);

client.connect(PORT, HOST, () => {
    console.log(`[+] Connected. Listening for 10 seconds...`);
    setTimeout(() => {
        client.destroy();
        analyze(rawBuf);
    }, DURATION_SEC * 1000);
});

client.on('data', (d) => {
    rawBuf = Buffer.concat([rawBuf, d]);
    process.stdout.write('.');
});

function analyze(buf) {
    console.log(`\n\nTotal bytes: ${buf.length}`);

    // Cek apakah ada sync 56 00 F9 06
    let sync56 = [];
    for (let i = 0; i <= buf.length - 4; i++) {
        if (buf[i] === 0x56 && buf[i+1] === 0x00 && buf[i+2] === 0xF9 && buf[i+3] === 0x06) {
            sync56.push(i);
        }
    }
    console.log(`Pola 56 00 F9 06 ditemukan: ${sync56.length} kali`);

    // Cari pola 99.7 (float32: 99.7, 99.8, 40.4, 102.7, 98.8, 103.1, dll)
    // 99.7f = CD CC C6 42
    // 99.8f = 66 66 C7 42
    // 40.4f = 9A 99 21 42
    // 102.7f = CD CC CD 42
    // 98.9f = CD CC C5 42
    const targetFloats = [
        { name: '99.7 (CRS RF Level)', val: 99.7 },
        { name: '99.8 (CRS RF Level Mon2)', val: 99.8 },
        { name: '40.4 (CRS Pos SDM)', val: 40.4 },
        { name: '40.6 (Width SDM)', val: 40.6 },
        { name: '102.7 (CLR RF Level)', val: 102.7 },
        { name: '103.1 (CLR RF Level Mon2)', val: 103.1 },
        { name: '98.9 (Standby CRS RF)', val: 98.9 },
        { name: '99.1 (Standby CRS RF Mon2)', val: 99.1 },
    ];

    console.log(`\nMencari posisi float spesifik dari layar ADRACS:`);
    targetFloats.forEach(target => {
        let found = [];
        for (let i = 0; i <= buf.length - 4; i++) {
            const f = buf.readFloatLE(i);
            if (Math.abs(f - target.val) < 0.05) {
                found.push({
                    offset: i,
                    val: f.toFixed(2),
                    precedingHeader: buf.slice(Math.max(0, i - 32), i).toString('hex')
                });
            }
        }
        console.log(`- ${target.name}: Ditemukan ${found.length} kali.`);
        if (found.length > 0) {
            console.log(`  Offset pertama di ${found[0].offset}, nilai=${found[0].val}`);
            console.log(`  Preceding 32 bytes hex: ${found[0].precedingHeader}`);
        }
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ bytes: buf.length, sampleHex: buf.slice(0, 4096).toString('hex') }, null, 2));
    console.log(`\n[+] Dump selesai.`);
}
