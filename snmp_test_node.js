/**
 * snmp_test_node.js — Test SNMP pakai snmp-native (pure JS, no external tools)
 * Jalankan: node snmp_test_node.js
 * 
 * Taruh file ini di folder Monitoring-ARIFIN-main lalu jalankan.
 */

const snmp = require('snmp-native');

const COMMUNITY = 'public';
const TIMEOUT   = 3000;

const DEVICES = [
    { name: 'FDPS 1',   ip: '192.168.64.30' },
    { name: 'FDPS 2',   ip: '192.168.64.31' },
    { name: 'FDPS',     ip: '192.168.64.23' },
    { name: 'SDPS 1',   ip: '192.168.64.32' },
    { name: 'SDPS 2',   ip: '192.168.64.33' },
    { name: 'SDPS BYP', ip: '192.168.64.38' },
    { name: 'SNET 1',   ip: '192.168.64.34' },
    { name: 'SNET 2',   ip: '192.168.64.35' },
    { name: 'DREC 1',   ip: '192.168.64.36' },
    { name: 'DREC 2',   ip: '192.168.64.37' },
    { name: 'CMS 1',    ip: '192.168.64.40' },
    { name: 'CMS 2',    ip: '192.168.64.41' },
    { name: 'TMSS 1',   ip: '192.168.64.42' },
    { name: 'TMSS 2',   ip: '192.168.64.43' },
];

const OID_SYSNAME  = [1,3,6,1,2,1,1,5,0];
const OID_SYSDESCR = [1,3,6,1,2,1,1,1,0];
const OID_UPTIME   = [1,3,6,1,2,1,1,3,0];
const OID_CPU      = [1,3,6,1,2,1,25,3,3,1,2];
const OID_STORTYPE = [1,3,6,1,2,1,25,2,3,1,2];
const OID_STORSIZE = [1,3,6,1,2,1,25,2,3,1,5];
const OID_STORUSED = [1,3,6,1,2,1,25,2,3,1,6];
const OID_STORALLOC= [1,3,6,1,2,1,25,2,3,1,4];

function snmpGet(session, oid) {
    return new Promise(resolve => {
        session.get({ oid }, (err, vbs) => {
            if (err || !vbs || !vbs[0]) return resolve(null);
            resolve(vbs[0].value);
        });
    });
}

function snmpWalk(session, oid) {
    return new Promise(resolve => {
        session.getSubtree({ oid, combinedTimeout: 8000 }, (err, vbs) => {
            resolve(err || !vbs ? [] : vbs);
        });
    });
}

async function testDevice(dev) {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  ${dev.name} (${dev.ip})`);
    console.log('─'.repeat(55));

    const session = new snmp.Session({
        host: dev.ip,
        community: COMMUNITY,
        timeouts: [TIMEOUT],
    });

    try {
        const sysName = await snmpGet(session, OID_SYSNAME);
        if (sysName === null) {
            console.log('  ✗ No SNMP response (timeout/unreachable/wrong community)');
            session.close();
            return { name: dev.name, ip: dev.ip, ok: false };
        }

        const [sysDescr, uptime] = await Promise.all([
            snmpGet(session, OID_SYSDESCR),
            snmpGet(session, OID_UPTIME),
        ]);

        console.log(`  ✓ sysName  : ${sysName}`);
        console.log(`    sysDescr : ${String(sysDescr || '—').substring(0, 60)}`);
        console.log(`    uptime   : ${uptime ? Math.floor(uptime/100) + 's' : '—'}`);

        // CPU
        const cpuVbs = await snmpWalk(session, OID_CPU);
        if (cpuVbs.length > 0) {
            const vals = cpuVbs.map(v => parseFloat(v.value)).filter(v => !isNaN(v));
            const avg  = vals.reduce((a, b) => a + b, 0) / vals.length;
            console.log(`    CPU      : ${vals.length} core(s), avg ${avg.toFixed(1)}%  [${vals.join(', ')}]`);
        } else {
            console.log(`    CPU      : hrProcessorLoad — tidak tersedia`);
        }

        // Storage
        const [typeVbs, sizeVbs, usedVbs, allocVbs] = await Promise.all([
            snmpWalk(session, OID_STORTYPE),
            snmpWalk(session, OID_STORSIZE),
            snmpWalk(session, OID_STORUSED),
            snmpWalk(session, OID_STORALLOC),
        ]);

        if (typeVbs.length > 0) {
            const toMap = vbs => { const m = {}; for (const v of vbs) m[v.oid[v.oid.length-1]] = v.value; return m; };
            const tm = toMap(typeVbs), sm = toMap(sizeVbs), um = toMap(usedVbs), am = toMap(allocVbs);

            console.log(`    Storage  : ${typeVbs.length} entries`);
            for (const idx of Object.keys(tm).slice(0, 8)) {
                const t     = String(tm[idx] || '');
                const alloc = parseInt(am[idx]) || 1024;
                const total = (parseInt(sm[idx]) || 0) * alloc;
                const used  = (parseInt(um[idx]) || 0) * alloc;
                const pct   = total > 0 ? (used / total * 100).toFixed(0) : '0';
                const typeShort = t.split('.').pop();
                const totalMb = (total / 1024 / 1024).toFixed(0);
                const usedMb  = (used  / 1024 / 1024).toFixed(0);
                console.log(`      idx=${idx} type=${typeShort} ${totalMb}MB / ${usedMb}MB used (${pct}%)`);
            }
        } else {
            console.log(`    Storage  : hrStorageTable — tidak tersedia`);
        }

        session.close();
        return { name: dev.name, ip: dev.ip, ok: true, sysName };

    } catch (err) {
        console.log(`  ✗ Error: ${err.message}`);
        try { session.close(); } catch(e) {}
        return { name: dev.name, ip: dev.ip, ok: false };
    }
}

async function main() {
    console.log('\n' + '='.repeat(55));
    console.log('  SNMP TEST — snmp-native (pure JS, no CLI tools)');
    console.log(`  Community: ${COMMUNITY}`);
    console.log('='.repeat(55));

    // Quick scan dulu — test sysName saja semua device paralel
    console.log('\n  QUICK SCAN (parallel, timeout 3s each)...\n');
    const scanResults = await Promise.all(DEVICES.map(async dev => {
        const session = new snmp.Session({
            host: dev.ip,
            community: COMMUNITY,
            timeouts: [TIMEOUT],
        });
        try {
            const val = await snmpGet(session, OID_SYSNAME);
            session.close();
            return { ...dev, ok: val !== null, sysName: val };
        } catch(e) {
            try { session.close(); } catch(x) {}
            return { ...dev, ok: false };
        }
    }));

    for (const r of scanResults) {
        const mark = r.ok ? '✓' : '✗';
        const info = r.ok ? r.sysName : 'no response';
        console.log(`  ${mark} ${r.name.padEnd(12)} ${r.ip}  →  ${info}`);
    }

    const alive = scanResults.filter(r => r.ok);
    console.log(`\n  ${alive.length}/${DEVICES.length} devices respond SNMP\n`);

    if (alive.length === 0) {
        console.log('  Tidak ada device yang respond SNMP.');
        console.log('  Kemungkinan:');
        console.log('    1. Server ini tidak di jaringan 192.168.64.x');
        console.log('    2. Community string bukan "public"');
        console.log('    3. SNMP agent belum aktif di device');
        console.log('    4. Firewall UDP 161 terblokir');
        return;
    }

    // Detail test — device pertama yang respond
    console.log(`  DETAIL TEST: ${alive[0].name} (${alive[0].ip})`);
    await testDevice(alive[0]);

    if (alive.length > 1) {
        console.log(`\n  (Tambah ${alive.length - 1} device lain yang respond — test satu sudah cukup)`);
    }

    console.log('\n' + '='.repeat(55));
    console.log('  SELESAI');
    console.log('='.repeat(55) + '\n');
}

main().catch(console.error);
