const snmp = require('snmp-native');

const host = '172.16.10.86';
const community = 'public';

// Kita paksa menggunakan SNMP v1 (beberapa UPS lawas sering error jika di-scan pakai v2c/GetBulk)
const session = new snmp.Session({ 
    host: host, 
    community: community, 
    version: snmp.versions.v1, // FORCE V1
    timeouts: [5000] 
});

console.log('⏳ Mengambil data spesifik UPS (SNMP v1)...');

// OID yang umum untuk NetAgent & RFC1628
const oids = [
    [1, 3, 6, 1, 4, 1, 935, 1, 1, 1, 2, 2, 1, 0], // NetAgent Input Voltage
    [1, 3, 6, 1, 4, 1, 935, 1, 1, 1, 2, 1, 1, 0], // NetAgent Battery Capacity
    [1, 3, 6, 1, 2, 1, 33, 1, 2, 5, 0],           // RFC1628 Battery Voltage
    [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 1]      // RFC1628 Input Voltage R
];

session.getAll({ oids: oids }, function (error, varbinds) {
    if (error) {
        console.error('❌ Error mengambil OID:', error.message || error);
    } else {
        console.log('✅ Hasil:');
        varbinds.forEach(vb => {
            const oidStr = vb.oid.join('.');
            let val = vb.value;
            if (Buffer.isBuffer(val)) { val = val.toString('utf8'); }
            console.log(`1.${oidStr} = ${val} (${vb.type})`);
        });
    }
    
    // Coba scan direktori 1.3.6.1.4.1.935 (NetAgent)
    console.log('\n⏳ Melakukan SNMP Walk di subtree 1.3.6.1.4.1.935 ...');
    session.getSubtree({ oid: [1, 3, 6, 1, 4, 1, 935] }, function(err, vbs) {
        if (err) {
            console.log('❌ Subtree scan error:', err.message || err);
        } else {
            console.log(`Ditemukan ${vbs.length} OID NetAgent.`);
            vbs.slice(0, 10).forEach(vb => {
                const oidStr = vb.oid.join('.');
                console.log(`1.${oidStr} = ${vb.value}`);
            });
        }
        session.close();
    });
});
