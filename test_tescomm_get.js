const snmp = require('snmp-native');

const ip = "192.168.26.54";
const community = "public";

const session = new snmp.Session({ 
    host: ip, 
    community: community, 
    version: 0, // 0 = SNMP v1
    timeouts: [5000, 5000] // Coba 2 kali, masing-masing 5 detik
});

console.log(`\n⏳ Sedang mencoba SNMP v1 (GET tunggal) ke ${ip}...`);

// Kita HANYA meminta 1 data spesifik (sysDescr), bukan seluruh pohon (subtree).
// Meminta subtree sering membuat UPS lemot/hang karena CPU-nya tidak kuat.
session.get({ oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] }, (err, varbinds) => {
    if (err) {
        console.error('❌ Gagal:', err.message);
    } else {
        console.log('✅ BERHASIL MENDAPATKAN RESPON SNMP v1!');
        console.log(`- sysDescr: ${varbinds[0].value}`);
    }
    session.close();
});
