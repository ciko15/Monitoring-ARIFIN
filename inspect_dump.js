const fs = require('fs');
const path = require('path');

const DUMP_PATH = 'C:\\Monitoring-ARIFIN-main\\gp_raw_dump.json';
const LOCAL_DUMP = path.join(__dirname, 'gp_raw_dump.json');

const targetPath = fs.existsSync(DUMP_PATH) ? DUMP_PATH : (fs.existsSync(LOCAL_DUMP) ? LOCAL_DUMP : null);

if (!targetPath) {
    console.log('[!] File gp_raw_dump.json tidak ditemukan.');
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
console.log(`Analyzing ${data.frames.length} frames from ${targetPath}...`);

data.frames.forEach((f, idx) => {
    console.log(`Frame #${idx+1}: Subtype=0x${f.byte3_hex}, Source=0x${f.byte4_hex}, Floats:`, JSON.stringify(f.floats));
});
