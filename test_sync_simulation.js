/**
 * test_sync_simulation.js
 * Simulasi audit & pengujian panggilan API POST /api/sync/config
 * Menguji validasi header token, mapping payload limitation, dan smart merge.
 */
const http = require('http');

async function runTest() {
  console.log('=== TEST SIMULASI SINKRONISASI ALARM LIMIT ===\n');

  const testPayload = {
    configType: 'limitations',
    payload: [
      {
        id: 9999,
        name: 'Simulated Voltage Test',
        category: 'Support',
        sup_category: 'Power Meter',
        value_type: 'numeric',
        unit: 'V',
        min_warning_limit: '210.0',
        max_warning_limit: '235.0',
        min_alarm_limit: '200.0',
        max_alarm_limit: '240.0',
        wlv: '210.0',
        whv: '235.0',
        alv: '200.0',
        ahv: '240.0',
        is_active: true
      }
    ]
  };

  const postData = JSON.stringify(testPayload);

  // 1. Uji Invalid Token (Harus 403 Forbidden)
  console.log('1. Menguji request dengan Invalid Token...');
  const resForbidden = await makeRequest({
    hostname: '127.0.0.1',
    port: 3100,
    path: '/api/sync/config',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-token': 'WRONG-TOKEN',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
  console.log(`   -> Status: ${resForbidden.statusCode}, Body: ${resForbidden.body}`);

  // 2. Uji Valid Token (Harus 200 OK)
  console.log('\n2. Menguji request dengan Token Valid (ARIFIN-SYNC-2026)...');
  const resSuccess = await makeRequest({
    hostname: '127.0.0.1',
    port: 3100,
    path: '/api/sync/config',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-token': 'ARIFIN-SYNC-2026',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
  console.log(`   -> Status: ${resSuccess.statusCode}, Body: ${resSuccess.body}`);

  // 3. Verifikasi Isi File db/limitation_config.json
  const fs = require('fs');
  const path = require('path');
  const limitFile = path.join(__dirname, 'db/limitation_config.json');
  const content = JSON.parse(fs.readFileSync(limitFile, 'utf8'));
  const found = content.find(item => item.id === 9999);

  console.log('\n3. Verifikasi penulisan ke db/limitation_config.json:');
  if (found) {
    console.log('   ✓ BERHASIL: Item id 9999 ditemukan di limitation_config.json!');
    console.log(`   Detail: ${found.name} (Warn: ${found.wlv} - ${found.whv}, Alarm: ${found.alv} - ${found.ahv})`);
    
    // Cleanup data simulasi agar bersih kembali
    const cleaned = content.filter(item => item.id !== 9999);
    fs.writeFileSync(limitFile, JSON.stringify(cleaned, null, 2), 'utf8');
    console.log('   ✓ Cleanup: Item simulasi berhasil dibersihkan.');
  } else {
    console.log('   ✗ GAGAL: Item id 9999 tidak ditemukan.');
  }
}

function makeRequest(options, data) {
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ statusCode: 'CONN_ERR', body: err.message }));
    req.write(data);
    req.end();
  });
}

runTest();
