const snmp = require('snmp-native');

const session = new snmp.Session({ host: '192.168.26.54', community: 'public', port: 161 });

const oid = [1, 3, 6, 1, 2, 1, 33, 1, 4, 4, 1];

session.getSubtree({ oid: oid }, (err, vbs) => {
    if (err) {
        console.error('Error:', err);
    } else {
        vbs.forEach(vb => {
            console.log(vb.oid.join('.') + ' = ' + vb.value + ' (Type: ' + vb.type + ')');
        });
    }
    session.close();
});
