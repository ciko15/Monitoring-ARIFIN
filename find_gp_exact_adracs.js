const net = require('net');

const HOST = '192.168.50.160';
const PORT = 950;
const DURATION_SEC = 10;

console.log(`[+] CAPTURING GP FIXED 92-BYTE PACKETS AND COMPARING TO ADRACS...`);

const client = new net.Socket();
let buf = Buffer.alloc(0);
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
        inspect(buf);
    }, DURATION_SEC * 1000);
});

client.on('data', d => {
    buf = Buffer.concat([buf, d]);
    process.stdout.write('.');
});

function inspect(b) {
    console.log(`\nCaptured ${b.length} bytes.`);

    const samples = {};

    for (let i = 0; i <= b.length - 92; i++) {
        if (b[i] === 0x11 && b[i+1] === 0x8D) {
            const byte2 = b[i+2];
            const subtype = b[i+3];
            const byte4 = b[i+4];
            const key = `Subtype_0x${subtype.toString(16)}_Byte4_0x${byte4.toString(16)}`;

            const frame = b.slice(i, i + 92);
            const floats = {};
            const u16s = {};

            for (let off = 0; off <= 88; off += 2) {
                try {
                    const f = frame.readFloatLE(off);
                    if (isFinite(f) && Math.abs(f) < 20000 && Math.abs(f) > 0.0001) {
                        floats[`off_${off}`] = parseFloat(f.toFixed(4));
                    }
                } catch(e) {}
                try {
                    const u = frame.readUInt16LE(off);
                    if (u >= 7990 && u <= 8010) {
                        u16s[`u16_${off}`] = u;
                    }
                } catch(e) {}
            }

            if (!samples[key]) samples[key] = [];
            // Simpan yang memiliki float menarik
            if (Object.keys(floats).length > 2) {
                samples[key].push({
                    pos: i,
                    byte2: `0x${byte2.toString(16)}`,
                    floats,
                    u16s
                });
            }
        }
    }

    console.log('\n================ HASIL ANALISIS FRAME MENARIK ================');
    for (const [k, list] of Object.entries(samples)) {
        console.log(`\n>>> TIPE: ${k} (Total sampel valid: ${list.length})`);
        list.slice(0, 3).forEach((item, idx) => {
            console.log(`  [Sampel #${idx+1} di pos ${item.pos}, byte2=${item.byte2}]`);
            console.log(`  Floats:`, JSON.stringify(item.floats));
            if (Object.keys(item.u16s).length > 0) console.log(`  UInt16:`, JSON.stringify(item.u16s));
        });
    }
}
