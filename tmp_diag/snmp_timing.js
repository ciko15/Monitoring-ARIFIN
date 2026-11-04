const snmp = require('snmp-native');
const comm = process.env.COMM || 'public';
const hosts = process.argv.slice(2);
const O = s => s.split('.').map(Number);
const now = () => Date.now();
const getAll = (s, oids) => new Promise(r => { const a = now();
  s.getAll({ oids: oids.map(O) }, (e, v) => r({ ms: now() - a, n: v ? v.length : 0, err: e && e.message })); });
const walk = (s, oid) => new Promise(r => { const a = now();
  s.getSubtree({ oid: O(oid), combinedTimeout: 5000 }, (e, v) => r({ ms: now() - a, n: v ? v.length : 0, err: e && e.message })); });
(async () => {
  for (let round = 1; round <= 3; round++) {
    for (const h of hosts) {
      const s = new snmp.Session({ host: h, community: comm, timeouts: [1500, 2500] });
      const out = {};
      out.sysUpTime = await getAll(s, ['1.3.6.1.2.1.1.3.0']);
      out.sysName   = await getAll(s, ['1.3.6.1.2.1.1.5.0']);
      out.cpuWalk   = await walk(s, '1.3.6.1.2.1.25.3.3.1.2');
      out.storType  = await walk(s, '1.3.6.1.2.1.25.2.3.1.2');
      out.storSize  = await walk(s, '1.3.6.1.2.1.25.2.3.1.5');
      out.storUsed  = await walk(s, '1.3.6.1.2.1.25.2.3.1.6');
      s.close();
      console.log(`round ${round} ${h}`, JSON.stringify(out));
    }
  }
  process.exit(0);
})();
