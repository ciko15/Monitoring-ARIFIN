const net = require('net');
const http = require('http');
const { exec } = require('child_process');

const IP = '192.168.127.99';

console.log(`===========================================`);
console.log(` MENDETEKSI JENIS ALAT VHF PAE (${IP})`);
console.log(`===========================================\n`);

// 1. PING TEST
exec(`ping -n 1 -w 2000 ${IP}`, (err, stdout) => {
    if (err || stdout.includes('unreachable') || stdout.includes('Request timed out')) {
        console.log(`❌ [PING] GAGAL: PC Anda tidak bisa mem-ping IP ${IP}. Pastikan kabel jaringan dan IP Address benar!`);
    } else {
        console.log(`✅ [PING] SUKSES: Alat ${IP} terhubung ke jaringan.`);
        
        // 2. HTTP TEST (T6TV)
        console.log(`\n⏳ Mengecek Port 80 (T6TV WebSocket)...`);
        http.get(`http://${IP}`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (data.toLowerCase().includes('park air') || data.toLowerCase().includes('t6')) {
                    console.log(`✅ [PORT 80] TERDETEKSI T6TV: Ini adalah web server Park Air T6.`);
                    console.log(`   -> KESIMPULAN: Gunakan Template 'VHF T6TV (WebSocket)' dan TCP Port '80'.`);
                } else if (res.statusCode === 401) {
                    console.log(`✅ [PORT 80] TERDETEKSI HTTP 401: Alat meminta Username/Password!`);
                    console.log(`   -> KESIMPULAN: Gunakan Template 'VHF T6TV (WebSocket)' dan TCP Port '80'.`);
                } else {
                    console.log(`⚠️ [PORT 80] Halaman Web ditemukan, tapi bukan Park Air T6.`);
                }
            });
        }).on('error', () => {
            console.log(`❌ [PORT 80] Gagal: Port 80 tertutup.`);
        });

        // 3. TCP TEST (MARC RSE)
        console.log(`⏳ Mengecek Port 950 (MARC RSE)...`);
        const s950 = net.createConnection(950, IP, () => {
            console.log(`✅ [PORT 950] TERDETEKSI MARC RSE: Port 950 terbuka! Mengirim sinyal pancingan...`);
            // Kirim paket SLIP (C0 ... C0)
            s950.write(Buffer.from([0xC0, 0x30, 0x00, 0x5A, 0x10, 0x00, 0x53, 0x02, 0xE9, 0xC0]));
        });
        s950.on('data', (d) => {
            console.log(`   -> [PORT 950] Alat membalas dengan kode HEX: ${d.toString('hex')}`);
            console.log(`   -> KESIMPULAN: Gunakan Template 'VHF MARC RSE' dan TCP Port '950'.`);
            s950.destroy();
        });
        s950.on('error', () => {
            console.log(`❌ [PORT 950] Gagal: Port 950 tertutup.`);
        });
    }
});
