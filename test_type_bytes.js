/**
 * test_type_bytes.js — Debug exact bytes dari hrStorageType value
 * bun test_type_bytes.js
 */

const snmp = require('snmp-native');

async function main() {
    const session = new snmp.Session({
        host: '192.168.64.30',
        community: 'public',
        timeouts: [4000],
    });

    await new Promise(resolve => {
        session.getSubtree({ oid: [1,3,6,1,2,1,25,2,3,1,2], combinedTimeout: 8000 }, (err, vbs) => {
            if (err || !vbs) { console.log('Error:', err); return resolve(); }

            const v = vbs[0]; // idx=1, Physical memory
            console.log('=== VarBind for idx=1 (Physical memory) ===');
            console.log('oid      :', v.oid);
            console.log('type     :', v.type);
            console.log('value    :', v.value);
            console.log('valueRaw :', v.valueRaw);
            console.log('valueHex :', v.valueHex);
            console.log('typeof   :', typeof v.value);

            // Check if value is array (OID type)
            if (Array.isArray(v.value)) {
                console.log('\nValue is ARRAY:', v.value);
                console.log('As string    :', v.value.join('.'));
                console.log('Match RAM    :', v.value.join('.') === '1.3.6.1.2.1.25.2.1.2');
            } else {
                const s = String(v.value);
                console.log('\nValue as string:', JSON.stringify(s));
                console.log('Char codes:', [...s].map(c => c.charCodeAt(0)));
                console.log('Match RAM :', s === '1.3.6.1.2.1.25.2.1.2');
                
                // Try different comparisons
                console.log('\nTrimmed   :', s.trim() === '1.3.6.1.2.1.25.2.1.2');
                console.log('Last part :', s.split('.').pop() === '2');
                console.log('Ends .2   :', s.endsWith('.2'));
                console.log('Ends .1.2 :', s.endsWith('.1.2'));
            }
            resolve();
        });
    });

    session.close();
}

main().catch(console.error);
