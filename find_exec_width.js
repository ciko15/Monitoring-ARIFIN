const net = require('net');

const HOST = '192.168.51.10';
const PORT = 950;

console.log(`[+] MENCARI FRAME EXECUTIVE DENGAN COURSE WIDTH (-0.4% / -0.004)...`);

const client = new net.Socket();
let buf = Buffer.alloc(0);

client.connect(PORT, HOST, () => {
    setTimeout(() => {
        client.destroy();
        analyze(buf);
    }, 10000);
});

client.on('data', d => {
    buf = Buffer.concat([buf, d]);
});

function analyze(b) {
    console.log(`Captured ${b.length} bytes.`);
    let execCandidates = [];

    // Cari float antara -0.005 sampai -0.002 (-0.5% sampai -0.2%)
    for (let i = 0; i <= b.length - 4; i++) {
        try {
            const f = b.readFloatLE(i);
            // DDM Course Width Executive di ADRACS adalah -0.4% (raw = -0.004) atau -0.3% (raw = -0.003)
            if (f < -0.001 && f > -0.01) {
                // Cari sync 11 8D terdekat ke belakang
                let syncPos = -1;
                for (let k = i; k >= Math.max(0, i - 92); k--) {
                    if (b[k] === 0x11 && b[k+1] === 0x8D) {
                        syncPos = k;
                        break;
                    }
                }
                execCandidates.push({
                    pos: i,
                    valPercent: (f * 100).toFixed(2),
                    relOffset: syncPos >= 0 ? (i - syncPos) : -1,
                    headerHex: syncPos >= 0 ? b.slice(syncPos, syncPos + 8).toString('hex').toUpperCase() : '--'
                });
            }
        } catch (e) {}
    }

    console.log(`\nKandidat Nilai DDM Width Executive (-0.4% / -0.3%) Ditemukan: ${execCandidates.length}`);
    execCandidates.slice(0, 10).forEach((c, idx) => {
        console.log(`[#${idx+1}] Nilai: ${c.valPercent}% pada Offset Relatif ${c.relOffset} dari Header: ${c.headerHex}`);
    });
}
