const snmp = require('snmp-native');

const targetIP = process.argv[2] || '192.168.26.102';
const community = process.argv[3] || 'public'; 

console.log(`[+] Testing SNMP poll to GENSET at ${targetIP} with community '${community}'...`);

// Inisialisasi sesi SNMP (versi 2c)
const session = new snmp.Session({
    host: targetIP,
    community: community,
    port: 161,
    version: snmp.Versions.SNMPv2c,
    timeouts: [2000, 2000, 2000], // Retry 3 kali
});

// sysDescr (OID standar untuk mendeteksi apakah SNMP merespon)
const oid_sysDescr = [1, 3, 6, 1, 2, 1, 1, 1, 0];

session.get({ oid: oid_sysDescr }, (err, varbinds) => {
    if (err) {
        console.log(`\n[-] GAGAL: Tidak ada respon SNMP (atau versi/community salah).`);
        console.log(`Detail Error: ${err.message}`);
        console.log(`\nSaran:`);
        console.log(`1. Pastikan layanan SNMP Enable di Genset.`);
        console.log(`2. Pastikan Community String di Genset adalah '${community}' (mungkin perlu dicoba 'private' atau yang lain).`);
        console.log(`3. Jika Genset pakai SNMPv1, kita perlu ubah versi di script ini.`);
    } else if (varbinds && varbinds[0]) {
        console.log(`\n[+] BERHASIL: SNMP merespon!`);
        console.log(`sysDescr Genset: ${varbinds[0].value}`);
        console.log(`\nSekarang kita tahu SNMP aktif. Langkah selanjutnya adalah mencari tabel OID khusus Genset merek ini.`);
    } else {
        console.log(`\n[?] Respon diterima tapi kosong.`);
    }

    session.close();
    process.exit(0);
});
