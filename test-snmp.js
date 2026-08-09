const snmp = require('snmp-native');

const host = '172.19.7.146';
const community = 'public';

console.log(`Mengetes koneksi SNMP ke ${host} (community: ${community})...`);

const session = new snmp.Session({ host: host, community: community, timeouts: [2000, 2000] });

// Get sysDescr (1.3.6.1.2.1.1.1.0)
session.get({ oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] }, function (error, varbinds) {
    if (error) {
        console.error("Gagal terkoneksi / Timeout:", error.message);
    } else {
        console.log("Koneksi BERHASIL! Perangkat merespons:");
        varbinds.forEach(function (vb) {
            console.log(vb.oid.join('.') + ' = ' + vb.value + ' (' + vb.type + ')');
        });
    }
    session.close();
    process.exit(0);
});
