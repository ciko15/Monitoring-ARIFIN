const snmp = require('snmp-native');

const host = '192.168.64.241';
const community = 'alsatm2023';

console.log(`Starting SNMP scan on ${host} with community: ${community} (v1)...`);
const session_v1 = new snmp.Session({ host, port: 161, community, family: 'udp4', version: snmp.Versions.SNMPv1 });
session_v1.get({ oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] }, (err, vbs) => {
    if (err) {
        console.error('[ERROR v1]', err.message || err);
    } else {
        console.log('[SUCCESS v1] sysDescr:', vbs[0].value);
    }
    session_v1.close();
});

console.log(`Starting SNMP scan on ${host} with community: ${community} (v2c)...`);
const session_v2c = new snmp.Session({ host, port: 161, community, family: 'udp4', version: snmp.Versions.SNMPv2c });
session_v2c.get({ oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] }, (err, vbs) => {
    if (err) {
        console.error('[ERROR v2c]', err.message || err);
    } else {
        console.log('[SUCCESS v2c] sysDescr:', vbs[0].value);
    }
    session_v2c.close();
});
