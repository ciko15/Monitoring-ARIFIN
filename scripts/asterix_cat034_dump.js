/**
 * asterix_cat034_dump.js — Diagnostik Dump Raw ASTERIX CAT034
 * 
 * Jalankan: node scripts/asterix_cat034_dump.js [multicast_ip] [port] [jumlah_paket]
 * Contoh  : node scripts/asterix_cat034_dump.js 239.255.0.54 13842 30
 * Default : 239.255.0.54 port 13842, 30 paket
 */
'use strict';
const dgram = require('dgram');
const MCAST_IP = process.argv[2] || '239.255.0.54';
const PORT     = parseInt(process.argv[3] || '13842', 10);
const MAX_PKT  = parseInt(process.argv[4] || '30', 10);
let count034 = 0, count048 = 0, countOther = 0, positionsFound = 0;
console.log('\n=== ASTERIX CAT034 Diagnostic Dump ===');
console.log('Listening: udp4 multicast ' + MCAST_IP + ':' + PORT);
console.log('Will dump ' + MAX_PKT + ' CAT034 packets then exit.\n');
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('error', (err) => { console.error('[ERR] Socket error:', err.message); process.exit(1); });
sock.on('message', (msg, rinfo) => {
    if (!msg || msg.length < 3) return;
    const cat = msg[0];
    if (cat === 48) { count048++; return; }
    if (cat !== 34) { countOther++; return; }
    count034++;
    if (count034 > MAX_PKT) return;
    const len = (msg[1] << 8) | msg[2];
    const hex = Buffer.from(msg).toString('hex').toUpperCase().match(/.{1,2}/g).join(' ');
    console.log('\n── Paket #' + count034 + ' dari ' + rinfo.address + ':' + rinfo.port + ' ──');
    console.log('   CAT=' + cat + '  LEN=' + len + ' (actual=' + msg.length + ')');
    console.log('   RAW HEX: ' + hex);
    let offset = 3;
    const fspec = [];
    while (offset < msg.length) {
        const b = msg[offset++]; fspec.push(b);
        if ((b & 0x01) === 0) break;
    }
    const fspecHex = fspec.map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
    const items = [];
    const bitMap = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02];
    fspec.forEach((byte, byteIndex) => {
        for (let i = 0; i < 7; i++) { if (byte & bitMap[i]) items.push((byteIndex * 7) + i + 1); }
    });
    console.log('   FSPEC   : ' + fspecHex + ' → Items: [' + items.join(', ') + ']');
    console.log('   Has I034/120 (item 11): ' + (items.includes(11) ? 'YES ✓' : 'NO ✗'));
    const ITEM_NAMES = {
        1:'I034/010 Data Source ID',2:'I034/000 Message Type',3:'I034/030 Time of Day',
        4:'I034/020 Sector Number',5:'I034/041 Antenna Rotation',6:'I034/050 System Config',
        7:'I034/060 System Processing',8:'I034/070 Message Count',9:'I034/100 Polar Window',
        10:'I034/110 Data Filter',11:'I034/120 3D-Position (GPS)',12:'I034/090 Collimation'
    };
    for (const item of items) {
        if (offset >= msg.length) break;
        const name = ITEM_NAMES[item] || 'Unknown Item ' + item;
        if (item === 1) {
            const sac = msg[offset], sic = msg[offset+1];
            console.log('   [' + item + '] ' + name + ': SAC=' + sac + ' SIC=' + sic + ' key="' + sac + '/' + sic + '"');
            offset += 2;
        } else if (item === 2) {
            const types = {1:'North Marker',2:'Sector Marker',3:'Geographical Filter',4:'Jamming Strobe'};
            const v = msg[offset];
            console.log('   [' + item + '] ' + name + ': 0x' + v.toString(16).padStart(2,'0') + ' → ' + (types[v]||'Unknown'));
            offset += 1;
        } else if (item === 3) {
            const tod = (msg[offset]<<16)|(msg[offset+1]<<8)|msg[offset+2];
            console.log('   [' + item + '] ' + name + ': ' + (tod/128).toFixed(3) + 's');
            offset += 3;
        } else if (item === 4) {
            console.log('   [' + item + '] ' + name + ': sector=' + msg[offset] + ' (' + (msg[offset]*1.40625).toFixed(2) + 'deg)');
            offset += 1;
        } else if (item === 5) {
            const rot = ((msg[offset]<<8)|msg[offset+1]) / 128;
            console.log('   [' + item + '] ' + name + ': ' + rot.toFixed(3) + 's → ' + (60/rot).toFixed(2) + ' RPM');
            offset += 2;
        } else if (item === 6 || item === 7) {
            const bytes = []; let ext = true;
            while (ext && offset < msg.length) {
                const b = msg[offset++]; bytes.push(b.toString(16).padStart(2,'0').toUpperCase()); ext=(b&0x01)!==0;
            }
            console.log('   [' + item + '] ' + name + ': [' + bytes.join(' ') + ']');
        } else if (item === 8) {
            const rep = msg[offset++]; const data = [];
            for (let r = 0; r < rep && offset+1 < msg.length; r++) {
                data.push('0x'+((msg[offset]<<8)|msg[offset+1]).toString(16).padStart(4,'0')); offset+=2;
            }
            console.log('   [' + item + '] ' + name + ': REP=' + rep + ' [' + data.join(', ') + ']');
        } else if (item === 9) {
            const bytes = Array.from(msg.slice(offset,offset+8)).map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
            console.log('   [' + item + '] ' + name + ': [' + bytes + ']'); offset += 8;
        } else if (item === 10) {
            console.log('   [' + item + '] ' + name + ': 0x' + msg[offset].toString(16).padStart(2,'0').toUpperCase()); offset += 1;
        } else if (item === 11) {
            if (offset + 7 < msg.length) {
                let hgtRaw = (msg[offset]<<8)|msg[offset+1]; const hgt=(hgtRaw&0x8000)?hgtRaw-0x10000:hgtRaw;
                let latRaw = (msg[offset+2]<<16)|(msg[offset+3]<<8)|msg[offset+4]; if(latRaw&0x800000) latRaw-=0x1000000;
                let lonRaw = (msg[offset+5]<<16)|(msg[offset+6]<<8)|msg[offset+7]; if(lonRaw&0x800000) lonRaw-=0x1000000;
                const lat = (latRaw*180/Math.pow(2,23)).toFixed(5);
                const lon = (lonRaw*180/Math.pow(2,23)).toFixed(5);
                positionsFound++;
                const inBounds = lat>=-12&&lat<=7&&lon>=94&&lon<=142;
                console.log('   [' + item + '] ' + name + ': height=' + hgt + 'm lat=' + lat + ' lon=' + lon + (inBounds?' ✓ IN BOUNDS':' ✗ OUT OF BOUNDS!'));
                offset += 8;
            } else { console.log('   [' + item + '] ' + name + ': NOT ENOUGH DATA'); break; }
        } else if (item === 12) {
            console.log('   [' + item + '] ' + name + ': [' + Array.from(msg.slice(offset,offset+2)).map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ') + ']'); offset+=2;
        } else {
            console.log('   [' + item + '] UNKNOWN item=' + item); let ext=true;
            while(ext&&offset<msg.length){ext=(msg[offset]&0x01)!==0;offset++;}
        }
    }
    if (count034 >= MAX_PKT) {
        console.log('\n═══════════════════════ RINGKASAN ══════════════════════════');
        console.log('  CAT034: ' + count034 + '  CAT048: ' + count048 + '  Lainnya: ' + countOther);
        console.log('  I034/120 ditemukan: ' + positionsFound + '/' + count034 + ' paket');
        if (positionsFound === 0) {
            console.log('\n  ⚠  KESIMPULAN: Radar TIDAK mengirim I034/120 (posisi GPS).');
            console.log('     Gunakan SAC/SIC lookup tabel RADAR_STATIONS di asterix_radar.js.');
        } else {
            console.log('\n  ✓  KESIMPULAN: I034/120 tersedia! Koordinat dapat diambil dinamis.');
        }
        console.log('════════════════════════════════════════════════════════════\n');
        sock.close(); process.exit(0);
    }
});
sock.on('listening', () => {
    console.log('Socket bound to port ' + PORT);
    try { sock.addMembership(MCAST_IP); console.log('Joined multicast group ' + MCAST_IP + '\n'); }
    catch(e) { console.warn('[WARN] addMembership: ' + e.message + ' — trying anyway...\n'); }
});
sock.bind(PORT);
