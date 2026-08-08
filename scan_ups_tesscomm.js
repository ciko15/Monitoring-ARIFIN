const snmp = require('snmp-native');

const host = '172.16.10.86';
const community = 'public';

const session = new snmp.Session({ host: host, community: community, timeouts: [5000] });

console.log('⏳ Scanning UPS OIDs on 172.16.10.86 (Tesscomm)...');

// Kita scan beberapa prefix yang sering dipakai UPS
// 1.3.6.1.2.1.33 = Standard UPS MIB (RFC 1628)
// 1.3.6.1.2.1.1 = System (untuk melihat nama alat)
// 1.3.6.1.4.1 = Private Enterprises (mencari OID spesifik pabrik)
const prefixes = [
    [1, 3, 6, 1, 2, 1, 1],
    [1, 3, 6, 1, 2, 1, 33],
    [1, 3, 6, 1, 4, 1]
];

let currentIndex = 0;

function scanNext() {
    if (currentIndex >= prefixes.length) {
        session.close();
        return;
    }
    const currentPrefix = prefixes[currentIndex];
    console.log(`\n\n--- Scanning Prefix: 1.${currentPrefix.join('.')} ---`);
    
    session.getSubtree({ oid: currentPrefix }, function (error, varbinds) {
        if (error) {
            console.log(`❌ Timeout / Error di prefix 1.${currentPrefix.join('.')}`);
        } else {
            console.log(`Ditemukan ${varbinds.length} OID.`);
            // Print up to 100 values to avoid terminal flood
            varbinds.slice(0, 50).forEach(vb => {
                const oidStr = vb.oid.join('.');
                let val = vb.value;
                if (Buffer.isBuffer(val)) {
                    const str = val.toString('utf8');
                    if (/^[\x20-\x7E]+$/.test(str)) { val = str; } 
                    else { val = `[Buffer hex: ${val.toString('hex')}]`; }
                }
                console.log(`1.${oidStr} = ${val}`);
            });
            if (varbinds.length > 50) console.log(`... dan ${varbinds.length - 50} data lainnya.`);
        }
        currentIndex++;
        scanNext();
    });
}

scanNext();
