const snmp = require('snmp-native');

const host = process.argv[2] || '192.168.13.11';
const community = process.argv[3] || 'public';

const OID = {
    sysDescr: [1, 3, 6, 1, 2, 1, 1, 1, 0],
    sysName: [1, 3, 6, 1, 2, 1, 1, 5, 0],
    upsBatteryStatus: [1, 3, 6, 1, 2, 1, 33, 1, 2, 1, 0],
    upsEstimatedMinutesRemaining: [1, 3, 6, 1, 2, 1, 33, 1, 2, 3, 0],
    upsEstimatedChargeRemaining: [1, 3, 6, 1, 2, 1, 33, 1, 2, 4, 0],
    upsBatteryVoltage: [1, 3, 6, 1, 2, 1, 33, 1, 2, 5, 0],
    upsInputVoltageR: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 1],
    upsInputVoltageS: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 2],
    upsInputVoltageT: [1, 3, 6, 1, 2, 1, 33, 1, 3, 3, 1, 3, 3],
    upsOutputVoltageR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 1],
    upsOutputVoltageS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 2],
    upsOutputVoltageT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 2, 3],
    upsOutputCurrentR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 3, 1],
    upsOutputCurrentS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 3, 2],
    upsOutputCurrentT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 3, 3],
    upsOutputPowerR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 4, 1],
    upsOutputPowerS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 4, 2],
    upsOutputPowerT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 4, 3],
    upsOutputPercentLoadR: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 5, 1],
    upsOutputPercentLoadS: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 5, 2],
    upsOutputPercentLoadT: [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1, 5, 3]
};

const session = new snmp.Session({
    host,
    community,
    port: 161,
    timeouts: [5000, 5000]
});

console.log(`\n🕵️‍♂️ MENGAMBIL DATA RAW SNMP DARI UPS (${host})...`);
console.log('========================================================');

const oidsToFetch = Object.values(OID);
const keys = Object.keys(OID);

session.getAll({ oids: oidsToFetch }, (err, vbs) => {
    if (err || !vbs) {
        console.error('❌ Gagal menghubungi UPS:', err ? err.message : 'Timeout');
        session.close();
        return;
    }

    let hasData = false;
    keys.forEach((key, index) => {
        const oidStr = oidsToFetch[index].join('.');
        const match = vbs.find(vb => vb.oid.join('.') === oidStr);
        
        let value = (match && match.type !== 128 && match.type !== 129) ? match.value : 'NULL / NOT SUPPORTED';
        
        // Cek jika tipe datanya buffer (untuk tulisan)
        if (Buffer.isBuffer(value)) {
            value = value.toString('utf8');
        }

        console.log(`- ${key.padEnd(28)} : ${value}`);
        if (value !== 'NULL / NOT SUPPORTED') hasData = true;
    });

    console.log('========================================================');
    if (!hasData) {
        console.log('⚠️ PERINGATAN: UPS menolak semua request. Pastikan versi SNMP dan Community benar.');
    } else {
        console.log('✅ SELESAI!');
    }
    
    session.close();
});
