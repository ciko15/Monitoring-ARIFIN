/**
 * scripts/test-throttle.js
 * Test Tahap 1d: Simulasikan 100 paket/detik selama 5 detik untuk 1 sumber asterix_radar.
 * _handleLogOutput harus dipanggil <= 6 kali (1 per detik), dan paket yang
 * diproses adalah paket terbaru pada window itu.
 */
import listener from '../src/services/network_listener.js';

async function run() {
    console.log('[TEST] Starting Throttle Simulation Test (Tahap 1d)...');
    
    // Pastikan env throttle default berlaku (tanpa STREAM_THROTTLE_IDS)
    delete process.env.STREAM_THROTTLE_IDS;
    process.env.STREAM_THROTTLE_ENABLED = 'true';
    process.env.STREAM_THROTTLE_MS = '1000';

    const source = {
        id: 'test_radar_source',
        name: 'Test Asterix Radar',
        parsing_id: 'asterix_radar'
    };

    let callCount = 0;
    const handledPackets = [];

    // Mock _handleLogOutput
    listener._handleLogOutput = async (src, logData, connectionType, status) => {
        callCount++;
        handledPackets.push({
            callIndex: callCount,
            time: Date.now(),
            seq: logData.data ? logData.data.seq : null,
            status
        });
        // Simulasi kerja async minimal (1ms)
        await new Promise(r => setTimeout(r, 1));
    };

    const startTime = Date.now();
    const durationMs = 5000;
    const intervalMs = 10; // 100 paket/detik -> 1 paket per 10ms
    let seq = 0;

    await new Promise((resolve) => {
        const interval = setInterval(() => {
            seq++;
            const now = Date.now();
            const logData = {
                timestamp: new Date().toISOString(),
                data: {
                    seq: seq,
                    channel_a_state: 'Normal',
                    channel_b_state: 'Normal',
                    radar_status: 'operational'
                }
            };

            listener._emitStreamThrottled(source, logData, 'udp', 'Normal');

            if (now - startTime >= durationMs) {
                clearInterval(interval);
                resolve();
            }
        }, intervalMs);
    });

    // Tunggu sedikit agar trailing flush selesai jika ada timer aktif
    await new Promise(r => setTimeout(r, 1200));

    console.log(`[TEST] Total packets emitted: ${seq}`);
    console.log(`[TEST] _handleLogOutput call count: ${callCount}`);
    console.log('[TEST] Handled packets summary:');
    handledPackets.forEach(p => {
        console.log(`  Call #${p.callIndex}: seq=${p.seq} status=${p.status} at +${p.time - startTime}ms`);
    });

    // Validasi 1: callCount harus <= 6 (1 leading + trailing per windowMs)
    if (callCount > 6) {
        console.error(`[FAIL] Call count was ${callCount}, expected <= 6!`);
        process.exit(1);
    }
    if (callCount < 4) {
        console.error(`[FAIL] Call count was ${callCount}, expected >= 4!`);
        process.exit(1);
    }

    // Validasi 2: Paket terakhir yang diproses harus mencakup paket mendekati seq akhir
    const lastPacket = handledPackets[handledPackets.length - 1];
    if (lastPacket.seq < seq - 15) {
        console.error(`[FAIL] Last processed seq was ${lastPacket.seq}, expected close to ${seq}!`);
        process.exit(1);
    }

    console.log(`[PASS] Throttle test passed successfully! Calls: ${callCount} <= 6, last seq: ${lastPacket.seq}/${seq}`);
    process.exit(0);
}

run().catch(err => {
    console.error('[ERROR]', err);
    process.exit(1);
});
