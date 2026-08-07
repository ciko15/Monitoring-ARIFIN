const snmp = require('snmp-native');

const host = '172.19.10.190';
const community = 'public';

console.log(`\n======================================================`);
console.log(`📡 SNMPWALK Datakom D-700`);
console.log(`   Target IP : ${host}`);
console.log(`   Community : ${community}`);
console.log(`======================================================\n`);

const session = new snmp.Session({ host: host, community: community, timeouts: [3000] });

console.log('⏳ Memulai walk pada OID root (.1.3.6.1.2.1)...');

session.getSubtree({ oid: [1, 3, 6, 1, 2, 1] }, function (error, varbinds) {
    if (error) {
        console.error('❌ Gagal melakukan snmpwalk (mungkin SNMP tidak aktif/salah community):', error.message || error);
    } else {
        console.log(`✅ BERHASIL! Ditemukan ${varbinds.length} OID.`);
        varbinds.slice(0, 20).forEach(vb => {
            const oidStr = vb.oid.join('.');
            let val = vb.value;
            if (Buffer.isBuffer(val)) { val = val.toString('hex'); }
            console.log(`OID: 1.${oidStr} = ${val}`);
        });
    }
    session.close();
});
