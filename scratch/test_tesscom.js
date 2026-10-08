const snmp = require('snmp-native');

// Ganti dengan IP Address UPS Tesscom di Surabaya
const HOST = '127.0.0.1'; // <-- UBAH IP INI
const COMMUNITY = 'public'; // <-- UBAH JIKA COMMUNITY BUKAN PUBLIC
const VERSION = snmp.Versions.SNMPv2c; // Coba v1 jika gagal: snmp.Versions.SNMPv1

const session = new snmp.Session({ host: HOST, community: COMMUNITY, version: VERSION, timeouts: [5000, 5000, 5000] });

const OIDs = [
    { name: "System Description", oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] },
    { name: "System Name", oid: [1, 3, 6, 1, 2, 1, 1, 5, 0] },
    { name: "UPS Battery Status (RFC 1628)", oid: [1, 3, 6, 1, 2, 1, 33, 1, 2, 1, 0] },
    { name: "UPS Input Voltage R (RFC 1628)", oid: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 1] },
];

console.log(`Menguji koneksi SNMP ke UPS Tesscom (${HOST})...`);

const promises = OIDs.map(item => {
    return new Promise((resolve) => {
        session.get({ oid: item.oid }, (err, vbs) => {
            if (err) {
                resolve(`\u274C ${item.name}: Error - ${err.message}`);
            } else if (vbs && vbs.length > 0) {
                resolve(`\u2705 ${item.name}: ${vbs[0].value} (Type: ${vbs[0].type})`);
            } else {
                resolve(`\u2753 ${item.name}: No Data`);
            }
        });
    });
});

Promise.all(promises).then(results => {
    console.log('\n--- HASIL PENGECEKAN SNMP ---');
    results.forEach(res => console.log(res));
    console.log('-----------------------------\n');
    
    const failedRFC = results.some(r => r.includes('Error - NoSuchName') || r.includes('Error') && r.includes('RFC'));
    if (failedRFC) {
        console.log("KESIMPULAN: UPS ini kemungkinan TIDAK mendukung format RFC 1628 (UPS MIB standar).");
        console.log("Solusi: Kita perlu mencari file MIB khusus dari Tesscom dan membuat parser baru.");
    } else {
        console.log("KESIMPULAN: UPS mendukung RFC 1628. Gagalnya parser mungkin karena koneksi jaringan yang sering drop.");
    }
    
    session.close();
});
