const snmp = require('snmp-native');
const session = new snmp.Session({ host: '127.0.0.1', port: 161, community: 'public' });
session.getAll({ oids: [[1,3,6,1,2,1,1,1,0], [1,3,6,1,2,1,1,5,0]] }, (err, vbs) => {
    console.log("err:", err);
    console.log("vbs:", vbs);
    session.close();
});
