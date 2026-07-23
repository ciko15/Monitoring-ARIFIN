const snmp = require('snmp-native');

const session = new snmp.Session({ host: '62.17.8.115', port: 161, community: 'public' });

console.log("Mencoba mengambil System Name dari DVOR (62.17.8.115)...");

// OID standar untuk sysName (1.3.6.1.2.1.1.5.0)
session.get({ oid: [1, 3, 6, 1, 2, 1, 1, 5, 0] }, function (error, varbinds) {
    if (error) {
        console.error("Gagal terhubung ke SNMP:", error.message || error);
    } else {
        console.log("✅ BERHASIL! SNMP aktif pada DVOR.");
        console.log("System Name (sysName):", varbinds[0].value);
    }
    session.close();
});
