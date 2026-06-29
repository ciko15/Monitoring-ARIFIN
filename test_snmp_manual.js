const { pollSNMP } = require('./src/parsers/snmp_system.js');

const targetIP = process.argv[2] || '192.168.64.10';
const community = process.argv[3] || 'public';

console.log(`[+] Testing SNMP poll to ${targetIP} with community '${community}'...`);

pollSNMP(targetIP, community, 10000)
    .then(result => {
        console.log('\n[RESULT]', JSON.stringify(result, null, 2));
        process.exit(0);
    })
    .catch(err => {
        console.error('\n[ERROR]', err);
        process.exit(1);
    });
