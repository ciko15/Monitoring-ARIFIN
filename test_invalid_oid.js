const snmp = require('snmp-native');
const session = new snmp.Session({ host: '127.0.0.1', port: 161, community: 'public' });
session.get({ oid: [1,3,6,1,4,1,99999,9,9] }, (err, vbs) => {
    console.log("err:", err ? err.message : null);
    console.log("vbs:", vbs ? vbs[0] : null);
    session.close();
});
