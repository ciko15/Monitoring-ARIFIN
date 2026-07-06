const net = require('net');

const IP = '192.168.127.99';
const PORTS_TO_TEST = [950, 4001, 4002, 4003, 4004];
let scanned = 0;

console.log(`[SCANNER] Mencari port Moxa yang terbuka di ${IP}...`);

for (const port of PORTS_TO_TEST) {
    const s = net.createConnection(port, IP);
    s.setTimeout(3000); // Timeout 3 detik
    
    s.on('connect', () => {
        console.log(`\n✅ [PORT ${port}] TERBUKA! Mengirim pancingan MARC RSE ke port 2-9...`);
        
        for (let p = 2; p <= 9; p++) {
            const payload = Buffer.from([0x53, p, 0xE9]);
            let crc = 0x0000;
            const frameCrc = Buffer.from([0x00, 0x5A, 0x10, 0x00, p, ...payload]);
            for (const b of frameCrc) {
                crc ^= (b << 8);
                for (let i = 0; i < 8; i++) {
                    if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
                    else crc = (crc << 1) & 0xFFFF;
                }
            }
            const frame = Buffer.from([0x30, ...frameCrc, (crc >> 8) & 0xFF, crc & 0xFF]);
            const out = [];
            for (const b of frame) {
                if (b === 0xC0) { out.push(0xDB, 0xDC); }
                else if (b === 0xDB) { out.push(0xDB, 0xDD); }
                else { out.push(b); }
            }
            s.write(Buffer.from([0xC0, ...out, 0xC0]));
        }
    });

    s.on('data', (d) => {
        console.log(`📩 [PORT ${port}] MEMBALAS (${d.length} bytes):`, d.toString('hex'));
    });
    
    s.on('error', (e) => {
        // console.log(`[PORT ${port}] Tertutup (${e.message})`);
        checkDone();
    });
    s.on('timeout', () => {
        s.destroy();
        checkDone();
    });
    s.on('close', () => {
        checkDone();
    });
}

function checkDone() {
    scanned++;
    if (scanned >= PORTS_TO_TEST.length) {
        // Semua port sudah di-scan
    }
}
