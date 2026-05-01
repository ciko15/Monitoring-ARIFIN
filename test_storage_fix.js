/**
 * test_storage_fix.js — Test fix langsung tanpa require parser
 * bun test_storage_fix.js
 */

const snmp = require('snmp-native');

const HOST      = '192.168.64.30';
const COMMUNITY = 'public';

// Konstanta yang sama dengan parser v7
const TYPE_RAM  = '1.3.6.1.2.1.25.2.1.2';
const TYPE_DISK = '1.3.6.1.2.1.25.2.1.4';

function snmpWalk(session, oid) {
    return new Promise(resolve => {
        session.getSubtree({ oid, combinedTimeout: 12000 }, (err, vbs) => {
            resolve(!err && vbs ? vbs : []);
        });
    });
}

async function main() {
    const session = new snmp.Session({ host: HOST, community: COMMUNITY, timeouts: [4000, 4000] });

    const [typeVbs, sizeVbs, usedVbs, allocVbs] = await Promise.all([
        snmpWalk(session, [1,3,6,1,2,1,25,2,3,1,2]),
        snmpWalk(session, [1,3,6,1,2,1,25,2,3,1,5]),
        snmpWalk(session, [1,3,6,1,2,1,25,2,3,1,6]),
        snmpWalk(session, [1,3,6,1,2,1,25,2,3,1,4]),
    ]);

    const toMap = vbs => { const m = {}; for (const v of vbs) m[v.oid[v.oid.length-1]] = v.value; return m; };
    const tm = toMap(typeVbs), sm = toMap(sizeVbs), um = toMap(usedVbs), am = toMap(allocVbs);

    let ram_total_mb = 0, ram_used_mb = 0;
    let disk_total_gb = null, disk_used_gb = null;

    for (const idx of Object.keys(tm)) {
        const typeStr = String(tm[idx] || '');
        const alloc   = parseInt(am[idx]) || 1024;
        const total   = (parseInt(sm[idx]) || 0) * alloc;
        const used    = (parseInt(um[idx]) || 0) * alloc;

        console.log(`idx=${idx} type="${typeStr}" isRAM=${typeStr===TYPE_RAM} isDisk=${typeStr===TYPE_DISK} total=${(total/1024/1024).toFixed(0)}MB`);

        if (typeStr === TYPE_RAM) {
            ram_total_mb += total / (1024 * 1024);
            ram_used_mb  += used  / (1024 * 1024);
        } else if (typeStr === TYPE_DISK) {
            const gb = total / (1024 * 1024 * 1024);
            if (gb > 1.0 && gb > (disk_total_gb || 0)) {
                disk_total_gb = gb;
                disk_used_gb  = used / (1024 * 1024 * 1024);
            }
        }
    }

    console.log('\n=== RESULT ===');
    console.log(`RAM Total : ${ram_total_mb.toFixed(0)} MB`);
    console.log(`RAM Used  : ${ram_used_mb.toFixed(0)} MB`);
    console.log(`RAM Pct   : ${ram_total_mb > 0 ? (ram_used_mb/ram_total_mb*100).toFixed(1) : '—'}%`);
    console.log(`Disk Total: ${disk_total_gb !== null ? disk_total_gb.toFixed(1) : '—'} GB`);
    console.log(`Disk Used : ${disk_used_gb  !== null ? disk_used_gb.toFixed(1)  : '—'} GB`);
    console.log(`Disk Pct  : ${disk_total_gb !== null ? (disk_used_gb/disk_total_gb*100).toFixed(1) : '—'}%`);

    session.close();
}

main().catch(console.error);
