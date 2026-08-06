const snmp = require('snmp-native');

const host = '192.168.100.1';
const community = 'SURABAYA';

console.log(`\n======================================================`);
console.log(`📡 SNMPWALK (snmp-native)`);
console.log(`   Target IP : ${host}`);
console.log(`   Community : ${community}`);
console.log(`======================================================\n`);

const session = new snmp.Session({ host: host, community: community, timeouts: [5000] });

console.log('⏳ Memulai walk pada OID root (.1.3.6.1.2.1)...');

session.getSubtree({ oid: [1, 3, 6, 1, 2, 1] }, function (error, varbinds) {
    if (error) {
        console.error('❌ Gagal melakukan snmpwalk:', error.message || error);
    } else {
        console.log(`✅ BERHASIL! Ditemukan ${varbinds.length} OID.`);
        console.log('Menampilkan 20 data pertama sebagai contoh:');

        varbinds.slice(0, 20).forEach(vb => {
            const oidStr = vb.oid.join('.');
            let val = vb.value;
            if (Buffer.isBuffer(val)) {
                // Coba konversi ke string jika isinya teks yang bisa dibaca
                const str = val.toString('utf8');
                // Pengecekan kasar apakah string tersebut printable ASCII
                if (/^[\x20-\x7E]+$/.test(str)) {
                    val = str;
                } else {
                    val = `[Buffer ${val.toString('hex')}]`;
                }
            }
            console.log(`OID: 1.${oidStr} = ${val} (${vb.type})`);
        });

        if (varbinds.length > 20) {
            console.log(`\n... dan ${varbinds.length - 20} data lainnya.`);
        }
    }
    session.close();
});
