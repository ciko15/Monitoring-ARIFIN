/**
 * test_thales_probe.js
 * Tool diagnostik mandiri untuk Thales 421 LLZ & GP di Sentani
 *
 * Cara pakai:
 *   node test_thales_probe.js <HOST> <PORT> [DURATION_SEC]
 * Contoh:
 *   node test_thales_probe.js 192.168.51.10 950 15
 *   node test_thales_probe.js 192.168.50.160 950 15
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const HOST = process.argv[2] || '192.168.51.10';
const PORT = parseInt(process.argv[3], 10) || 950;
const DURATION_SEC = parseInt(process.argv[4], 10) || 15;

const TRIGGER_POLL = Buffer.from([0x0B, 0x00, 0xF9, 0x06]);
const HBEAT_REPLY  = Buffer.from([0x13, 0x00, 0xF9, 0x06]);
const HBEAT_RECV   = Buffer.from([0x13, 0x00, 0xF8, 0x06]);

console.log(`=======================================================`);
console.log(`THALES 421 PROBE TOOL`);
console.log(`Target     : ${HOST}:${PORT}`);
console.log(`Duration   : ${DURATION_SEC} detik`);
console.log(`=======================================================`);

const client = new net.Socket();
client.setKeepAlive(true, 5000);
client.setNoDelay(true);

let totalBytes = 0;
let chunksReceived = 0;
let framesFound = [];
let rawDump = [];
let triggerCount = 0;
let pollTimer = null;

const startTime = Date.now();

client.connect(PORT, HOST, () => {
    console.log(`[+] [CONNECT SUCCESS] Berhasil tersambung ke ${HOST}:${PORT}`);
    
    // Kirim trigger pertama
    console.log(`[+] Mengirim trigger POLL_TRIGGER (0B 00 F9 06)...`);
    client.write(TRIGGER_POLL);
    triggerCount++;

    // Polling setiap 3 detik
    pollTimer = setInterval(() => {
        console.log(`[+] Mengirim trigger POLL_TRIGGER berkala #${++triggerCount}...`);
        client.write(TRIGGER_POLL);
    }, 3000);
});

client.on('data', (chunk) => {
    chunksReceived++;
    totalBytes += chunk.length;
    rawDump.push(chunk);

    const hexSample = chunk.slice(0, 32).toString('hex');
    console.log(`[RX] Chunk #${chunksReceived} | ${chunk.length} bytes | Hex: ${hexSample}...`);

    // Deteksi Heartbeat
    if (chunk.length >= 4 && chunk.slice(0, 4).equals(HBEAT_RECV)) {
        console.log(`   --> [HEARTBEAT RECV] Menerima Heartbeat 13 00 F8 06! Membalas 13 00 F9 06...`);
        client.write(HBEAT_REPLY);
    }

    // Deteksi frame 11 8D .. 01 / 0E
    for (let i = 0; i <= chunk.length - 4; i++) {
        if (chunk[i] === 0x11 && chunk[i+1] === 0x8D) {
            const subtype = chunk[i+3];
            const hexSubtype = subtype ? subtype.toString(16).padStart(2, '0') : '??';
            console.log(`   --> [FRAME DETECTED] Menemukan header 11 8D pada byte #${i}, Subtype: 0x${hexSubtype}`);
            framesFound.push({
                offset: i,
                header: chunk.slice(i, Math.min(i + 16, chunk.length)).toString('hex'),
                fullHex: chunk.slice(i, Math.min(i + 96, chunk.length)).toString('hex')
            });
        }
        if (chunk[i] === 0x56 && chunk[i+1] === 0x00 && chunk[i+2] === 0xF9 && chunk[i+3] === 0x06) {
            console.log(`   --> [SYNC 56 DETECTED] Menemukan sync marker 56 00 F9 06 pada byte #${i}`);
        }
    }
});

client.on('error', (err) => {
    console.error(`[-] [SOCKET ERROR] ${err.message}`);
});

client.on('close', () => {
    console.log(`[*] [SOCKET CLOSED] Koneksi ditutup oleh remote host.`);
});

setTimeout(() => {
    if (pollTimer) clearInterval(pollTimer);
    client.destroy();

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n================== HASIL PROBE (${elapsed}s) ==================`);
    console.log(`Total Bytes Diterima  : ${totalBytes} bytes`);
    console.log(`Total Chunks          : ${chunksReceived}`);
    console.log(`Trigger Terkirim      : ${triggerCount}`);
    console.log(`Frame 11 8D Ditemukan : ${framesFound.length}`);

    if (totalBytes > 0) {
        const dumpFileName = `thales_probe_${HOST.replace(/\./g, '_')}_${Date.now()}.bin`;
        const dumpPath = path.join(__dirname, dumpFileName);
        const fullBuf = Buffer.concat(rawDump);
        fs.writeFileSync(dumpPath, fullBuf);
        console.log(`[+] Raw dump disimpan di: ${dumpPath}`);

        if (framesFound.length > 0) {
            console.log(`\nContoh Frame Pertama (Hex):`);
            console.log(framesFound[0].fullHex);
        }
    } else {
        console.log(`[!] CATATAN KRITIS: 0 byte diterima.`);
        console.log(`    Koneksi TCP tersambung tapi tidak ada satupun byte balasan dari port 950.`);
        console.log(`    Ini adalah indikator kuat Moxa membatasi 1 sesi eksklusif yang sedang dipegang ADRACS.`);
    }
    console.log(`===============================================================\n`);
    process.exit(0);
}, DURATION_SEC * 1000);
