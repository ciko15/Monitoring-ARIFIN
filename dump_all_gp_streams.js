const net = require('net');

const HOST = '192.168.50.160';
const PORT = 950;
const DURATION_SEC = 8;

console.log(`[+] MENGAMBIL SELURUH VARIASI FRAME DARI GP (${HOST}:${PORT})...`);

const client = new net.Socket();
let buf = Buffer.alloc(0);

// Kirim trigger 0B 00 F9 06 jika ADRACS mati
const TRIGGER_SEND = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);

client.connect(PORT, HOST, () => {
    console.log(`[+] Connected. Listening for ${DURATION_SEC}s...`);
    client.write(TRIGGER_SEND);
    const pollInterval = setInterval(() => {
        try { client.write(TRIGGER_SEND); } catch (e) {}
    }, 2000);

    setTimeout(() => {
        clearInterval(pollInterval);
        client.destroy();
        analyze(buf);
    }, DURATION_SEC * 1000);
});

client.on('data', d => {
    buf = Buffer.concat([buf, d]);
    process.stdout.write('.');
});

client.on('error', e => console.error('Socket error:', e.message));

function analyze(b) {
    console.log(`\nCaptured ${b.length} bytes.`);
    const frameTypes = {};

    for (let i = 0; i <= b.length - 92; i++) {
        if (b[i] === 0x11 && b[i+1] === 0x8D) {
            const byte2 = b[i+2];
            const subtype = b[i+3];
            const byte4 = b[i+4];
            const typeKey = `Subtype_0x${subtype.toString(16).padStart(2,'0')}_Byte4_0x${byte4.toString(16).padStart(2,'0')}`;

            if (!frameTypes[typeKey]) {
                frameTypes[typeKey] = [];
            }

            const frame = b.slice(i, i + 92);
            const allFloats = {};

            for (let off = 0; off <= 88; off += 2) {
                try {
                    const f = frame.readFloatLE(off);
                    if (isFinite(f) && Math.abs(f) < 20000 && Math.abs(f) > 0.0001) {
                        allFloats[`off_${off}`] = parseFloat(f.toFixed(4));
                    }
                } catch(e) {}
            }

            frameTypes[typeKey].push({
                pos: i,
                header: frame.slice(0, 10).toString('hex').toUpperCase(),
                byte2_flag: `0x${byte2.toString(16).padStart(2, '0')} (${(byte2 & 0x40) ? 'TX1' : 'TX2'})`,
                floats: allFloats,
                rawHex: frame.slice(0, 92).toString('hex')
            });
        }
    }

    console.log(`\n=== TIPE FRAME GP YANG DITERIMA ===`);
    for (const [key, list] of Object.entries(frameTypes)) {
        console.log(`\n========================================`);
        console.log(`TIPE: ${key} (Jumlah: ${list.length})`);
        console.log(`Sampel Pos: ${list[0].pos}, Header: ${list[0].header}, Flag: ${list[0].byte2_flag}`);
        console.log(`Floats:`, JSON.stringify(list[0].floats, null, 2));
        if (list.length > 1) {
            console.log(`Sampel #2 Floats:`, JSON.stringify(list[1].floats, null, 2));
        }
    }
}
