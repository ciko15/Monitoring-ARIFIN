const net = require('net');
const fs = require('fs');

const HOST = '192.168.51.10';
const PORT = 950;

console.log(`Dumping 2 full 0x0E frames and 2 full 0x01 frames...`);
const client = new net.Socket();
let buf = Buffer.alloc(0);

client.connect(PORT, HOST, () => {
    setTimeout(() => {
        client.destroy();
        processBuf(buf);
    }, 6000);
});

client.on('data', d => {
    buf = Buffer.concat([buf, d]);
});

function processBuf(b) {
    console.log(`Captured ${b.length} bytes.`);
    for (let i = 0; i <= b.length - 92; i++) {
        if (b[i] === 0x11 && b[i+1] === 0x8D) {
            const byte2 = b[i+2];
            const byte3 = b[i+3];
            const byte4 = b[i+4];
            console.log(`\n========================================`);
            console.log(`Frame at pos ${i}: Header=${b.slice(i, i+8).toString('hex').toUpperCase()}`);
            console.log(`Byte2=0x${byte2.toString(16)} (Flag), Subtype=0x${byte3.toString(16)}, Source=0x${byte4.toString(16)}`);
            
            const frame = b.slice(i, i + 92);
            for (let off = 0; off <= 88; off += 2) {
                try {
                    const f = frame.readFloatLE(off);
                    if (isFinite(f) && Math.abs(f) < 20000 && Math.abs(f) > 0.0001) {
                        console.log(`  Offset ${off}: ${f.toFixed(4)}`);
                    }
                } catch(e) {}
            }
        }
    }
}
