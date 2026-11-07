const net = require('net');
const fs = require('fs');

const HOST = '192.168.51.10';
const PORT = 950;
const DURATION_SEC = 8;

console.log(`[+] MENGAMBIL SELURUH VARIASI FRAME DARI LLZ (${HOST}:${PORT})...`);

const client = new net.Socket();
let buf = Buffer.alloc(0);

client.connect(PORT, HOST, () => {
    console.log(`[+] Connected. Listening for ${DURATION_SEC}s...`);
    setTimeout(() => {
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
            const allInts = {};

            for (let off = 0; off <= 88; off += 2) {
                try {
                    const f = frame.readFloatLE(off);
                    if (isFinite(f) && Math.abs(f) < 20000 && Math.abs(f) > 0.0001) {
                        allFloats[`off_${off}`] = parseFloat(f.toFixed(4));
                    }
                } catch(e) {}

                try {
                    const u16 = frame.readUInt16LE(off);
                    if (u16 === 8000 || u16 === 2900 || u16 === 2100 || u16 === 1800 || u16 === 1200) {
                        allInts[`u16_off_${off}`] = u16;
                    }
                } catch(e) {}
            }

            frameTypes[typeKey].push({
                pos: i,
                header: frame.slice(0, 10).toString('hex').toUpperCase(),
                floats: allFloats,
                ints: allInts,
                rawHex: frame.slice(0, 92).toString('hex')
            });
        }
    }

    console.log(`\n=== TIPE FRAME YANG DITERIMA ===`);
    for (const [key, list] of Object.entries(frameTypes)) {
        console.log(`\n========================================`);
        console.log(`TIPE: ${key} (Jumlah: ${list.length})`);
        console.log(`Sampel Pos: ${list[0].pos}, Header: ${list[0].header}`);
        console.log(`Floats:`, JSON.stringify(list[0].floats, null, 2));
        if (Object.keys(list[0].ints).length > 0) {
            console.log(`Ints (8000 / Freq):`, JSON.stringify(list[0].ints, null, 2));
        }
        if (list.length > 1) {
            console.log(`Sampel #2 Floats:`, JSON.stringify(list[1].floats, null, 2));
        }
    }
}
