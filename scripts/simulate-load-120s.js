/**
 * scripts/simulate-load-120s.js
 * 
 * Pengujian Akhir 2 & 3:
 * Simulasi beban gabungan radar + ADS-B (~53 paket/detik) selama 120 detik.
 * Mendukung opsi:
 *   --throttle=on  (STREAM_THROTTLE_ENABLED=true)
 *   --throttle=off (STREAM_THROTTLE_ENABLED=false)
 * 
 * Mengukur:
 * - Total paket masuk vs panggilan _handleLogOutput keluar
 * - Output per menit per sumber
 * - Event loop lag maksimum
 * - RSS awal dan akhir
 */

const listener = require('../src/services/network_listener.js');

async function runSimulation(throttleEnabled) {
    console.log(`\n======================================================`);
    console.log(`STARTING 120s LOAD SIMULATION (throttle=${throttleEnabled ? 'ENABLED' : 'DISABLED'})`);
    console.log(`======================================================`);

    process.env.STREAM_THROTTLE_ENABLED = throttleEnabled ? 'true' : 'false';
    process.env.STREAM_THROTTLE_MS = '1000';

    const sourceRadar = {
        id: 'sim_radar_source',
        name: 'Sentani Asterix Radar',
        equipt_id: '1779000000053',
        parsing_id: 'asterix_radar'
    };

    const sourceAdsb = {
        id: 'sim_adsb_source',
        name: 'Sentani Asterix ADS-B',
        equipt_id: '1779000000053',
        parsing_id: 'asterix_adsb'
    };

    let radarCalls = 0;
    let adsbCalls = 0;
    let totalInRadar = 0;
    let totalInAdsb = 0;

    // Pasang spy pada _handleLogOutput asli
    const originalHandleLogOutput = listener._handleLogOutput.bind(listener);
    listener._handleLogOutput = async (source, parsedData, connectionType, initialStatus) => {
        if (source && source.id === 'sim_radar_source') radarCalls++;
        if (source && source.id === 'sim_adsb_source') adsbCalls++;
        return await originalHandleLogOutput(source, parsedData, connectionType, initialStatus);
    };

    // Monitor Event Loop Delay / Lag
    let maxLagMs = 0;
    let lastCheck = Date.now();
    const lagInterval = setInterval(() => {
        const now = Date.now();
        const lag = Math.max(0, now - lastCheck - 100);
        lastCheck = now;
        if (lag > maxLagMs) maxLagMs = lag;
    }, 100);

    const memInitial = process.memoryUsage();
    const rssInitialMb = (memInitial.rss / (1024 * 1024)).toFixed(2);

    const startTime = Date.now();
    const durationMs = 120000; // 120 detik

    // Radar ~48 pkts/s -> 1 paket per ~20.8ms
    // ADS-B ~5 pkts/s -> 1 paket per ~200ms
    const radarTimer = setInterval(() => {
        totalInRadar++;
        const logData = {
            timestamp: new Date().toISOString(),
            data: {
                seq: totalInRadar,
                sector_number: (totalInRadar % 32),
                antenna_rotation: 15,
                system_config: 'Normal',
                radar_status: 'operational',
                connectivity: 'Connected'
            }
        };
        listener._emitStreamThrottled(sourceRadar, logData, 'udp', 'Normal');
    }, 21);

    const adsbTimer = setInterval(() => {
        totalInAdsb++;
        const logData = {
            timestamp: new Date().toISOString(),
            data: {
                seq: totalInAdsb,
                station: 'Sentani ADS-B',
                sac: 10,
                sic: 20,
                connectivity: 'Connected'
            }
        };
        listener._emitStreamThrottled(sourceAdsb, logData, 'udp', 'Normal');
    }, 200);

    // Tunggu sampai 120 detik
    await new Promise(resolve => setTimeout(resolve, durationMs));

    clearInterval(radarTimer);
    clearInterval(adsbTimer);
    clearInterval(lagInterval);

    // Jeda 1.5 detik untuk menunggu sisa trailing flush jika ada
    await new Promise(r => setTimeout(r, 1500));

    const memFinal = process.memoryUsage();
    const rssFinalMb = (memFinal.rss / (1024 * 1024)).toFixed(2);
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n--- HASIL SIMULASI (${elapsedSec} detik) ---`);
    console.log(`Radar Emitted        : ${totalInRadar} (${(totalInRadar / 2).toFixed(0)}/min)`);
    console.log(`Radar Handled        : ${radarCalls} (${(radarCalls / 2).toFixed(1)}/min)`);
    console.log(`ADS-B Emitted        : ${totalInAdsb} (${(totalInAdsb / 2).toFixed(0)}/min)`);
    console.log(`ADS-B Handled        : ${adsbCalls} (${(adsbCalls / 2).toFixed(1)}/min)`);
    console.log(`Max Event Loop Lag   : ${maxLagMs} ms`);
    console.log(`RSS Memory           : ${rssInitialMb} MB -> ${rssFinalMb} MB`);
    console.log(`-------------------------------------------\n`);

    return {
        throttleEnabled,
        totalInRadar,
        radarCalls,
        totalInAdsb,
        adsbCalls,
        maxLagMs,
        rssInitialMb,
        rssFinalMb
    };
}

async function main() {
    const isThrottleOff = process.argv.includes('--throttle=off');
    await runSimulation(!isThrottleOff);
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
