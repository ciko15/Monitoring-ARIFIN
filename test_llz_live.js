const net = require('net');
const Parser = require('./src/parsers/ils_llz_thales421.js');

const HOST = '192.168.51.10'; // IP Localizer
const PORT = 950;

console.log(`[TEST] Menghubungkan ke ${HOST}:${PORT}...`);

const client = new net.Socket();
const parser = new Parser({ name: 'Test LLZ' });

client.connect(PORT, HOST, () => {
    console.log('[TEST] Terhubung. Mengirimkan trigger awal...');
    // Parser menyediakan getPollRequests() untuk trigger awal jika ada
    const requests = parser.getPollRequests();
    if (requests && requests.length > 0) {
        requests.forEach(req => {
            console.log(`[TEST] Mengirim ${req.label}...`);
            client.write(req.bytes);
        });
    }
});

client.on('data', (data) => {
    // Manual raw frame debugging
    for (let i = 0; i < data.length - 20; i++) {
        if (data[i] === 0x11 && data[i+1] === 0x8D && data[i+3] === 0x0E) {
            console.log(`\n[RAW MON] Found Monitor Packet!`);
            console.log(`[RAW MON] Byte 4 (Hex): 0x${data[i+4].toString(16)}`);
            console.log(`[RAW MON] Byte 13(Hex): 0x${data[i+13].toString(16)}`);
            console.log(`[RAW MON] HEX: ${data.slice(i, i+30).toString('hex')}...`);
        }
    }

    // Balas heartbeat jika parser mendeteksi heartbeat
    if (parser.isHeartbeat(data)) {
        console.log('[TEST] Menerima Heartbeat, mengirim balasan...');
        client.write(parser.getHeartbeatReply());
    }

    // Parse data mentah yang masuk
    const result = parser.parse(data);
    
    // Tampilkan hasil parsing jika sukses (status tidak Waiting/Error)
    if (result && result.success) {
        console.log('\n--- HASIL DECODE (MON 1 & MON 2) ---');
        
        // Tampilkan System Status
        console.log(`TX MAIN   : ${result.data.tx_main_label}`);
        console.log(`TX STANDBY: ${result.data.tx_stby_label}`);
        console.log(`SUBTYPE   : ${result.data.subtype}`);
        
        console.log('\n--- PARAMETER MON 1 ---');
        Object.keys(result.data).filter(k => k.startsWith('M1_')).forEach(k => {
            console.log(`${k.padEnd(15)}: ${result.data[k]}`);
        });

        console.log('\n--- PARAMETER MON 2 ---');
        Object.keys(result.data).filter(k => k.startsWith('M2_')).forEach(k => {
            console.log(`${k.padEnd(15)}: ${result.data[k]}`);
        });
        
        console.log('------------------------------------\n');
    } else {
        // Tampilkan status error/waiting sesekali
        process.stdout.write('.'); 
    }
});

client.on('close', () => {
    console.log('\n[TEST] Koneksi terputus.');
});

client.on('error', (err) => {
    console.error(`\n[ERROR] ${err.message}`);
});

// Otomatis berhenti setelah 15 detik agar tidak membebani alat
setTimeout(() => {
    console.log('\n[TEST] Selesai (15 detik). Memutus koneksi...');
    client.destroy();
}, 15000);
