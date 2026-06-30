#!/usr/bin/env node
'use strict';

const net = require('net');
const snmp = require('snmp-native');

const DEFAULT_HOSTS = [
  '192.168.210.130',
  '192.168.210.131',
  '192.168.210.132',
  '192.168.210.133',
  '192.168.210.134',
  '192.168.210.135',
  '192.168.100.151',
];

const DEFAULT_GET_OIDS = [
  ['sysDescr', '1.3.6.1.2.1.1.1.0'],
  ['sysObjectID', '1.3.6.1.2.1.1.2.0'],
  ['sysUpTime', '1.3.6.1.2.1.1.3.0'],
  ['sysContact', '1.3.6.1.2.1.1.4.0'],
  ['sysName', '1.3.6.1.2.1.1.5.0'],
  ['sysLocation', '1.3.6.1.2.1.1.6.0'],
];

function usage() {
  console.log(`Usage:
  node tools/check-pae-snmp.js [options]

Options:
  --hosts <ip1,ip2>        Target IPs. Default: configured PAE/MOXA IPs.
  --community <text>       SNMP community. Default: public.
  --version <1|2c>         SNMP version. Default: 2c.
  --port <number>          SNMP UDP port. Default: 161.
  --timeout <ms>           Per request timeout. Default: 3000.
  --tcp-ports <p1,p2>      TCP ports to test. Default: 8010,950.
  --no-tcp                 Skip TCP port tests.
  --walk                   Run SNMP walk after basic GET tests.
  --oid <oid>              Walk root OID. Default: 1.3.6.1.
  --limit <number>         Max walk rows printed per host. Default: 80.
  --help                   Show this help.

Examples:
  node tools/check-pae-snmp.js --hosts 192.168.210.130 --community public
  node tools/check-pae-snmp.js --hosts 192.168.210.130 --community PAE123 --walk --oid 1.3.6.1.4.1
`);
}

function parseArgs(argv) {
  const opts = {
    hosts: DEFAULT_HOSTS,
    community: 'public',
    version: '2c',
    port: 161,
    timeout: 3000,
    tcpPorts: [8010, 950],
    tcp: true,
    walk: false,
    oid: '1.3.6.1',
    limit: 80,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--hosts') {
      opts.hosts = splitList(next());
    } else if (arg === '--community') {
      opts.community = String(next() || 'public');
    } else if (arg === '--version') {
      opts.version = String(next() || '2c');
    } else if (arg === '--port') {
      opts.port = parseNumber(next(), 161);
    } else if (arg === '--timeout') {
      opts.timeout = parseNumber(next(), 3000);
    } else if (arg === '--tcp-ports') {
      opts.tcpPorts = splitList(next()).map((value) => parseNumber(value, 0)).filter(Boolean);
    } else if (arg === '--no-tcp') {
      opts.tcp = false;
    } else if (arg === '--walk') {
      opts.walk = true;
    } else if (arg === '--oid') {
      opts.oid = String(next() || '1.3.6.1');
    } else if (arg === '--limit') {
      opts.limit = parseNumber(next(), 80);
    } else if (!arg.startsWith('--')) {
      opts.hosts = splitList(arg);
    }
  }

  return opts;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOid(oid) {
  const clean = String(oid || '').replace(/^\./, '').trim();
  if (!/^\d+(?:\.\d+)*$/.test(clean)) {
    throw new Error(`Invalid OID: ${oid}`);
  }
  return clean.split('.').map(Number);
}

function versionValue(version) {
  if (String(version) === '1') return snmp.Versions.SNMPv1;
  return snmp.Versions.SNMPv2c;
}

function formatValue(value) {
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (Array.isArray(value)) return value.join('.');
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function createSession(host, opts) {
  return new snmp.Session({
    host,
    port: opts.port,
    community: opts.community,
    version: versionValue(opts.version),
    timeouts: [opts.timeout, opts.timeout],
  });
}

function closeSessionLater(session) {
  setTimeout(() => {
    try {
      session.close();
    } catch {}
  }, 20);
}

function snmpGet(host, oid, opts) {
  return new Promise((resolve) => {
    const session = createSession(host, opts);
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, error: 'Timeout' }), opts.timeout + 1500);

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeSessionLater(session);
      resolve(result);
    }

    try {
      session.get({ oid: parseOid(oid) }, (err, vbs) => {
        if (err) return finish({ ok: false, error: err.message || String(err) });
        const vb = vbs && vbs[0];
        if (!vb) return finish({ ok: false, error: 'No data' });
        finish({
          ok: true,
          oid: Array.isArray(vb.oid) ? vb.oid.join('.') : oid,
          type: String(vb.type || ''),
          value: formatValue(vb.value),
        });
      });
    } catch (err) {
      finish({ ok: false, error: err.message || String(err) });
    }
  });
}

function snmpWalk(host, oid, opts) {
  return new Promise((resolve) => {
    const session = createSession(host, opts);
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, error: 'Timeout', rows: [] }), opts.timeout * 4);

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeSessionLater(session);
      resolve(result);
    }

    try {
      session.getSubtree({ oid: parseOid(oid), combinedTimeout: opts.timeout * 4 }, (err, vbs) => {
        if (err) return finish({ ok: false, error: err.message || String(err), rows: [] });
        const rows = (vbs || []).map((vb) => ({
          oid: Array.isArray(vb.oid) ? vb.oid.join('.') : '',
          type: String(vb.type || ''),
          value: formatValue(vb.value),
        }));
        finish({ ok: true, rows });
      });
    } catch (err) {
      finish({ ok: false, error: err.message || String(err), rows: [] });
    }
  });
}

function tcpTest(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const timer = setTimeout(() => finish('TIMEOUT'), timeoutMs);

    function finish(status) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    }

    socket.once('connect', () => finish('OPEN'));
    socket.once('error', (err) => finish(err.code || err.message || 'ERROR'));
    socket.connect(port, host);
  });
}

async function inspectHost(host, opts) {
  console.log(`\n=== ${host} ===`);

  if (opts.tcp && opts.tcpPorts.length > 0) {
    for (const port of opts.tcpPorts) {
      const result = await tcpTest(host, port, opts.timeout);
      console.log(`TCP ${port}: ${result}`);
    }
  }

  console.log(`SNMP v${opts.version} community="${opts.community}" UDP ${opts.port}:`);
  let okCount = 0;
  for (const [name, oid] of DEFAULT_GET_OIDS) {
    const result = await snmpGet(host, oid, opts);
    if (result.ok) {
      okCount++;
      console.log(`  OK   ${name} (${result.oid}) = ${result.value}`);
    } else {
      console.log(`  FAIL ${name} (${oid}) = ${result.error}`);
    }
  }

  if (opts.walk) {
    console.log(`SNMP WALK ${opts.oid}:`);
    const result = await snmpWalk(host, opts.oid, opts);
    if (!result.ok) {
      console.log(`  FAIL ${result.error}`);
    } else if (result.rows.length === 0) {
      console.log('  No rows returned.');
    } else {
      const rows = result.rows.slice(0, opts.limit);
      for (const row of rows) {
        console.log(`  ${row.oid} = ${row.value}`);
      }
      if (result.rows.length > rows.length) {
        console.log(`  ... ${result.rows.length - rows.length} more rows not printed. Increase --limit if needed.`);
      }
    }
  }

  if (okCount === 0) {
    console.log('Summary: no basic SNMP response. Check community, SNMP enable setting, VLAN/firewall, or UDP/161 access.');
  } else {
    console.log('Summary: SNMP responds. Use --walk --oid 1.3.6.1.4.1 to collect vendor OIDs for mapping.');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.hosts.length) {
    throw new Error('No hosts specified.');
  }

  console.log('PAE/MOXA SNMP connectivity check');
  console.log(`Targets: ${opts.hosts.join(', ')}`);
  console.log(`Started: ${new Date().toISOString()}`);

  for (const host of opts.hosts) {
    await inspectHost(host, opts);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  process.exit(1);
});
