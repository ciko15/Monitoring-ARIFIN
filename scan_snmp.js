const { pollSNMPRaw } = require('./src/parsers/snmp_network_basic');

async function test() {
    const host = '192.168.64.241';
    const community = 'alsatm2023';
    
    console.log(`Running full pollSNMP with v1...`);
    try {
        const res1 = await pollSNMPRaw(host, community, { port: 161, version: '1' });
        console.log('[v1 Result]', JSON.stringify(res1).substring(0, 500) + '...');
    } catch (e) {
        console.error('[v1 Error]', e.message);
    }

    console.log(`\nRunning full pollSNMP with v2c...`);
    try {
        const res2 = await pollSNMPRaw(host, community, { port: 161, version: '2c' });
        console.log('[v2c Result]', JSON.stringify(res2).substring(0, 500) + '...');
    } catch (e) {
        console.error('[v2c Error]', e.message);
    }
}

test();
