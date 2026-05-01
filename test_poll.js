/**
 * test_poll.js — Test pollSNMP langsung dari parser
 * Taruh di folder Monitoring-ARIFIN-main, jalankan: bun test_poll.js
 */

const { pollSNMP } = require('./src/parsers/snmp_system');

async function main() {
    console.log('Testing pollSNMP for FDPS 1 (192.168.64.30)...\n');
    
    const startTime = Date.now();
    const result = await pollSNMP('192.168.64.30', 'public');
    const elapsed = Date.now() - startTime;
    
    console.log(`Elapsed: ${elapsed}ms`);
    console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
