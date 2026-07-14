const snmp = require('snmp-native');

const targetIP = process.argv[2] || '192.168.26.102';
const community = process.argv[3] || 'public'; // Coba ganti jika di Web UI bukan 'public'

console.log(`[+] Testing SNMP poll UPS to ${targetIP} with community '${community}'...`);

// Inisialisasi sesi SNMP (versi 2c, port standard 161)
const session = new snmp.Session({
    host: targetIP,
    community: community,
    port: 161,
    version: snmp.Versions.SNMPv2c,
    timeouts: [4000, 4000],
});

// Daftar OID umum (RFC 1628 UPS MIB & System MIB)
const OIDs = [
    { name: 'sysDescr', oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] },
    { name: 'sysName', oid: [1, 3, 6, 1, 2, 1, 1, 5, 0] },
    { name: 'upsBatteryStatus', oid: [1, 3, 6, 1, 2, 1, 33, 1, 2, 4, 0] }, // 2=normal, 3=low, 4=depleted
    { name: 'upsSecondsOnBattery', oid: [1, 3, 6, 1, 2, 1, 33, 1, 2, 5, 0] },
    { name: 'upsEstimatedMinutesRemaining', oid: [1, 3, 6, 1, 2, 1, 33, 1, 2, 3, 0] },
    { name: 'upsInputVoltage', oid: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 1] }, // Terkadang perlu .1 di belakang
    { name: 'upsOutputVoltage', oid: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 1] }  // Terkadang perlu .1 di belakang
];

console.log(`[!] Mengambil data parameter... tunggu sebentar...\n`);

const results = {};
let completed = 0;

OIDs.forEach(item => {
    session.get({ oid: item.oid }, (err, varbinds) => {
        completed++;

        if (err) {
            results[item.name] = `ERROR: ${err.message}`;
        } else if (varbinds && varbinds[0]) {
            results[item.name] = varbinds[0].value;
        } else {
            results[item.name] = 'NULL / Tidak didukung';
        }

        // Jika semua request sudah selesai
        if (completed === OIDs.length) {
            console.log("=== HASIL BACAAN UPS ===");
            console.log(JSON.stringify(results, null, 2));
            console.log("========================");
            session.close();
            process.exit(0);
        }
    });
});

// Timeout global jika UPS tidak merespon sama sekali
setTimeout(() => {
    console.log("[-] Timeout: Tidak ada respon dari UPS. Pastikan IP, kabel jaringan, dan Community String (SNMP) benar, serta layanan SNMP Enable.");
    session.close();
    process.exit(1);
}, 6000);
