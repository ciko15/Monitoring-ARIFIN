const dgram = require('dgram');

const TARGET_IP = '172.19.7.181';
const TARGET_PORT = 161; // Port standar SNMP
const SNMP_COMMUNITY = 'public'; // Password default SNMP yang paling umum

console.log(`\n======================================================`);
console.log(`📡 UJI COBA SNMP KE ILS NORMARC`);
console.log(`   Target IP   : ${TARGET_IP}`);
console.log(`   Target Port : UDP ${TARGET_PORT}`);
console.log(`======================================================\n`);

const client = dgram.createSocket('udp4');

// Timeout 5 detik
const timeout = setTimeout(() => {
    console.log(`❌ WAKTU HABIS: Tidak ada balasan SNMP dari ${TARGET_IP}. Alat mungkin tidak mengaktifkan SNMP atau community-nya bukan '${SNMP_COMMUNITY}'.`);
    client.close();
}, 5000);

client.on('message', (msg, rinfo) => {
    clearTimeout(timeout);
    console.log(`✅ BERHASIL MENDAPAT BALASAN SNMP!`);
    console.log(`   Dari: ${rinfo.address}:${rinfo.port}`);
    console.log(`   Ukuran data: ${msg.length} bytes\n`);
    console.log(`Alat ini mendukung SNMP! Kita bisa memonitornya dengan aman tanpa mengganggu PMDT.`);
    client.close();
});

// Paket SNMP GetRequest standar untuk OID 1.3.6.1.2.1.1.1.0 (SysDescr)
// Ini adalah pertanyaan "Siapa namamu?" dalam bahasa SNMP
const buildSnmpPacket = (community) => {
    const commBuf = Buffer.from(community, 'ascii');
    
    // Header ASN.1 sederhana (hanya untuk pengujian cepat)
    const packet = Buffer.concat([
        Buffer.from([0x30, 0x29 + commBuf.length]), // Sequence + Total Length
        Buffer.from([0x02, 0x01, 0x01]), // Version (v2c)
        Buffer.from([0x04, commBuf.length]), commBuf, // Community String
        Buffer.from([0xA0, 0x1C]), // GetRequest PDU
        Buffer.from([0x02, 0x04, 0x00, 0x00, 0x00, 0x01]), // Request ID
        Buffer.from([0x02, 0x01, 0x00]), // Error Status
        Buffer.from([0x02, 0x01, 0x00]), // Error Index
        Buffer.from([0x30, 0x0E]), // VarBindList
        Buffer.from([0x30, 0x0C]), // VarBind
        Buffer.from([0x06, 0x08, 0x2B, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]), // OID 1.3.6.1.2.1.1.1.0 (SysDescr)
        Buffer.from([0x05, 0x00]) // Null value
    ]);
    return packet;
};

const packet = buildSnmpPacket(SNMP_COMMUNITY);
console.log(`⏳ Mengirim pertanyaan SNMP (sysDescr) menggunakan community '${SNMP_COMMUNITY}'...`);
client.send(packet, 0, packet.length, TARGET_PORT, TARGET_IP, (err) => {
    if (err) {
        console.error(`❌ Gagal mengirim paket UDP:`, err);
        client.close();
    }
});
