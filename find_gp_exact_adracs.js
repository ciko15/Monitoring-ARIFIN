const net = require('net');

const HOST = '192.168.50.160';
const PORT = 950;
const DURATION_SEC = 10;

console.log(`[+] SCANNING DEEP GP FRAMES (UP TO 160 BYTES) FOR EXACT ADRACS MATCH...`);

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
        scanAll(buf);
    }, DURATION_SEC * 1000);
});

client.on('data', d => {
    buf = Buffer.concat([buf, d]);
    process.stdout.write('.');
});

function scanAll(b) {
    console.log(`\nCaptured ${b.length} bytes.`);

    // Target values to find:
    // Nearfield RF: ~108.9
    // Nearfield DDM: ~0.6 (or raw ~0.006)
    // Nearfield SDM: ~82.0
    // Freq: 8000
    // Standby CRS CSB1 RF: ~105.7
    // Standby CRS CSB1 DDM: -12.4 (or raw -0.124)
    // Standby CRS CSB1 SDM: ~79.9
    // Standby CRS Width RF: ~98.4
    // Standby CRS Width DDM: 19.2 (or raw 0.192)
    // Standby CRS Width SDM: ~80.8
    // Standby CLR Width RF: ~100.2
    // Standby CLR Width DDM: 30.5 (or raw 0.305)
    // Standby CLR Width SDM: ~77.5

    for (let i = 0; i <= b.length - 30; i++) {
        if (b[i] === 0x11 && b[i+1] === 0x8D) {
            const subtype = b[i+3];
            const byte4 = b[i+4];
            const nextSync = b.indexOf(Buffer.from([0x11, 0x8D]), i + 2);
            const frameLen = nextSync !== -1 ? nextSync - i : Math.min(140, b.length - i);
            const frame = b.slice(i, i + frameLen);

            const foundFloats = {};
            const foundU16 = {};

            for (let off = 0; off <= frameLen - 4; off += 2) {
                try {
                    const f = frame.readFloatLE(off);
                    if (isFinite(f) && Math.abs(f) < 20000 && Math.abs(f) > 0.0001) {
                        foundFloats[`off_${off}`] = parseFloat(f.toFixed(4));
                    }
                } catch(e) {}
                try {
                    const u16 = frame.readUInt16LE(off);
                    if (u16 === 8000 || u16 === 8001) {
                        foundU16[`u16_off_${off}`] = u16;
                    }
                } catch(e) {}
            }

            // Cek apakah mengandung nilai spesifik
            const floatVals = Object.values(foundFloats);
            const hasNearfield = floatVals.some(v => Math.abs(v - 108.9) < 2.0 || Math.abs(v - 82.0) < 2.0);
            const hasStandbyCsb1 = floatVals.some(v => Math.abs(v - 105.7) < 2.0 || Math.abs(v + 12.4) < 2.0 || Math.abs(v + 0.124) < 0.02);
            const hasFreq8000 = Object.keys(foundU16).length > 0 || floatVals.some(v => Math.abs(v - 8000) < 5.0);

            if (hasNearfield || hasStandbyCsb1 || hasFreq8000 || subtype === 0x01 || subtype === 0x0E || subtype === 0x0C) {
                console.log(`\n---------------------------------------------------------`);
                console.log(`FRAME at ${i} | Subtype: 0x${subtype.toString(16)} | Byte4: 0x${byte4.toString(16)} | Len: ${frameLen}`);
                console.log(`Nearfield Match: ${hasNearfield} | Standby CSB1 Match: ${hasStandbyCsb1} | Freq 8000 Match: ${hasFreq8000}`);
                console.log(`Floats:`, JSON.stringify(foundFloats));
                if (Object.keys(foundU16).length > 0) console.log(`UInt16:`, JSON.stringify(foundU16));
            }
        }
    }
}
