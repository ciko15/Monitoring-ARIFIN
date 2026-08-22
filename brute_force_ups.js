const ping = require('ping');
const snmp = require('snmp-native');

const ip = "192.168.26.54";
const communities = ["public", "private", "Tescomm", "admin", "123456"];
const versions = [0, 1]; // 0 = v1, 1 = v2c

console.log(`\n🔍 MENGANALISA KONEKSI KE UPS TESSCOMM (${ip})...`);
console.log('========================================================');

async function testPing() {
    console.log('1\uFE0F\u20E3  TEST PING (Konektivitas Jaringan)...');
    const res = await ping.promise.probe(ip, { timeout: 2 });
    if (res.alive) {
        console.log(`   \u2705 BERHASIL! Perangkat hidup dan membalas Ping dalam ${res.time} ms.\n`);
        testSNMP();
    } else {
        console.log('   \u274C GAGAL PING! Perangkat mati, kabel putus, atau beda jaringan (routing belum dibuka).');
        console.log('   (Pesan: Timeout. Pastikan IP 192.168.26.54 benar-benar bisa diping dari PC Biak ini!)');
    }
}

function testSNMP() {
    console.log('2\uFE0F\u20E3  BRUTE-FORCE SNMP (Mencari celah versi & password)...');
    let attempts = [];

    versions.forEach(v => {
        communities.forEach(comm => {
            attempts.push({ version: v, community: comm });
        });
    });

    let index = 0;
    
    function tryNext() {
        if (index >= attempts.length) {
            console.log('\n\u274C KESIMPULAN: Semua tes SNMP ditolak oleh perangkat!');
            console.log('Kemungkinan: Port 161 (UDP) diblokir firewall, atau IP ini bukan kartu SNMP.');
            return;
        }

        const current = attempts[index];
        const vName = current.version === 0 ? 'v1 ' : 'v2c';
        process.stdout.write(`   \u23F3 Mencoba SNMP ${vName} dengan password "${current.community}"... `);

        const session = new snmp.Session({
            host: ip,
            community: current.community,
            version: current.version,
            timeouts: [1500] // Cepat saja
        });

        session.get({ oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] }, (err, varbinds) => {
            if (!err) {
                console.log('\u2705 BERHASIL TEMBUS!');
                console.log(`\n\uD83C\uDF89 BINGO! Pengaturan yang benar adalah:`);
                console.log(`   - Versi SNMP: ${vName}`);
                console.log(`   - Password (Community): ${current.community}`);
                console.log(`   - Perangkat: ${varbinds[0].value}\n`);
                session.close();
                return; // Stop pencarian
            }
            
            console.log('\u274C Gagal');
            session.close();
            index++;
            tryNext();
        });
    }

    tryNext();
}

testPing();
