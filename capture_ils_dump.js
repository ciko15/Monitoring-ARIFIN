/**
 * Script Tangkap & Dump Hex Stream ILS Surabaya
 * Jalankan: node capture_ils_dump.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const outputFile = path.join(__dirname, 'ils_capture_dump.json');
const tsharkPaths = [
    'C:\\Program Files\\Wireshark\\tshark.exe',
    'C:\\Program Files (x86)\\Wireshark\\tshark.exe',
    'tshark'
];

let chosenTool = 'tshark';
for (const p of tsharkPaths) {
    if (fs.existsSync(p)) {
        chosenTool = p;
        break;
    }
}

console.log(`[CAPTURE] Using tool: ${chosenTool}`);
console.log(`[CAPTURE] Capturing TCP port 38317... Tekan Ctrl+C untuk berhenti kapan saja.`);

const args = [
    '-i', '5',
    '-f', 'tcp port 38317',
    '-T', 'fields',
    '-e', 'frame.time_relative',
    '-e', 'ip.src',
    '-e', 'ip.dst',
    '-e', 'tcp.payload',
    '-l'
];

const captured = [];
const proc = spawn(chosenTool, args, { stdio: ['ignore', 'pipe', 'inherit'] });

proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        const parts = line.split('\t');
        if (parts.length >= 4) {
            const time = parts[0];
            const src = parts[1];
            const dst = parts[2];
            const payload = parts[3].replace(/[:\s]/g, '');
            if (payload && payload.length > 8) {
                const item = {
                    time,
                    src,
                    dst,
                    bytes: payload.length / 2,
                    payloadHex: payload
                };
                captured.push(item);
                console.log(`[CAPTURED #${captured.length}] from ${src} -> ${dst} (${item.bytes} bytes): ${payload.slice(0, 48)}...`);

                // Tulis batch berkala
                if (captured.length % 5 === 0) {
                    fs.writeFileSync(outputFile, JSON.stringify(captured, null, 2));
                }

                if (captured.length >= 30) {
                    console.log(`\n[SUCCESS] Berhasil mengumpulkan ${captured.length} paket data.`);
                    console.log(`File tersimpan di: ${outputFile}`);
                    proc.kill();
                    process.exit(0);
                }
            }
        }
    }
});

proc.on('close', () => {
    fs.writeFileSync(outputFile, JSON.stringify(captured, null, 2));
    console.log(`[DONE] Total paket tersimpan: ${captured.length} di ${outputFile}`);
});
