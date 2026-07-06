const net = require('net');

const IP = '192.168.127.99';
const PORT = 4001; // atau 950

const s = net.createConnection(PORT, IP, () => {
    console.log(`[CONNECTED] Terhubung ke ${IP}:${PORT}!`);
    console.log(`[POLL] Menembak SEMUA port 2 sampai 9...`);
    
    // Tembak command Settings (0xE9) ke port 2-9
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
    console.log(`[DATA] ${d.length} bytes:`, d.toString('hex'));
});
s.on('error', (e) => console.error('[ERROR]', e.message));
s.on('close', () => console.log('[CLOSED] Koneksi putus.'));
