const snmp = require('snmp-native');
const fs = require('fs');

const host = process.argv[2] || '192.168.13.11';
const community = process.argv[3] || 'public';

const session = new snmp.Session({
    host,
    community,
    port: 161,
    timeouts: [5000, 5000]
});

console.log(`\n🕵️‍♂️ Menyapu Seluruh Data Private MIB dari UPS (${host})...`);
console.log('Mohon tunggu, ini bisa memakan waktu hingga 1 menit...');

let output = '';
let count = 0;

// OID 1.3.6.1.4.1 adalah cabang "Private Enterprise" di mana pabrikan UPS biasa menyembunyikan data spesifiknya
session.getSubtree({ oid: [1, 3, 6, 1, 4, 1] }, (err, varbinds) => {
    if (err) {
        console.error('❌ Gagal melakukan scanning:', err.message);
    } else {
        varbinds.forEach(vb => {
            let val = vb.value;
            if (Buffer.isBuffer(val)) val = val.toString('utf8').replace(/\0/g, '');
            output += `.${vb.oid.join('.')} = ${val}\n`;
            count++;
        });
        
        fs.writeFileSync('hasil_scan_private.txt', output);
        console.log(`✅ BERHASIL! Ditemukan ${count} OID rahasia.`);
        console.log(`Data telah disimpan ke dalam file: hasil_scan_private.txt`);
    }
    session.close();
});
