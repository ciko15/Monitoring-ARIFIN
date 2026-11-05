'use strict';

const path = require('path');
const networkListener = require('../src/services/network_listener');
const db = require('../db/database');

async function run() {
    console.log('=== BENCHMARK _handleLogOutput (BASELINE) ===');

    const source = {
        id: 9999001,
        equipt_id: '1779000000054', // ID yang ada di db/equipment_config.json
        name: 'Radar Test Baseline',
        ip_address: '192.168.1.100',
        parsing_id: 'asterix_radar'
    };

    const mockData = {
        data: {
            connectivity: 'Connected',
            radar_name: 'Sentani',
            sac: 32,
            sic: 163,
            radar_id: '032/163',
            last_cat034: new Date().toISOString(),
            msg_type: 'North Marker',
            time_of_day: '43200.00 s',
            sector_number: 12,
            antenna_rotation: '4.00 s',
            system_config: 'Normal',
            com_status: 'OK',
            psr_status: 'OK',
            ssr_status: 'OK',
            rdpc_status: 'OK'
        },
        source: 'Radar Test Baseline',
        _ip: '192.168.1.100'
    };

    // Warm up 100 calls
    console.log('Warming up 100 calls...');
    for (let i = 0; i < 100; i++) {
        await networkListener._handleLogOutput(source, JSON.parse(JSON.stringify(mockData)), 'asterix_radar', 'Normal');
    }

    const ITERATIONS = 5000;
    console.log(`Starting benchmark for ${ITERATIONS} iterations...`);

    const times = [];
    const tStartTotal = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
        // Deep copy mockData agar tiap panggilan fresh
        const payload = {
            data: { ...mockData.data, time_of_day: `${(43200 + i * 0.01).toFixed(2)} s` },
            source: mockData.source,
            _ip: mockData._ip
        };

        const tStart = performance.now();
        await networkListener._handleLogOutput(source, payload, 'asterix_radar', 'Normal');
        const tEnd = performance.now();
        times.push(tEnd - tStart);
    }

    const tEndTotal = performance.now();
    const totalTimeMs = tEndTotal - tStartTotal;
    const avgTimeMs = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTimeMs = Math.max(...times);
    const minTimeMs = Math.min(...times);

    // Median & P95
    times.sort((a, b) => a - b);
    const medianMs = times[Math.floor(times.length * 0.5)];
    const p95Ms = times[Math.floor(times.length * 0.95)];

    console.log('\n--- HASIL BENCHMARK BASELINE ---');
    console.log(`Total Iterasi : ${ITERATIONS}`);
    console.log(`Total Waktu   : ${totalTimeMs.toFixed(2)} ms`);
    console.log(`Rata-rata     : ${avgTimeMs.toFixed(3)} ms`);
    console.log(`Minimum       : ${minTimeMs.toFixed(3)} ms`);
    console.log(`Median        : ${medianMs.toFixed(3)} ms`);
    console.log(`P95           : ${p95Ms.toFixed(3)} ms`);
    console.log(`Maksimum      : ${maxTimeMs.toFixed(3)} ms`);
    console.log('--------------------------------\n');
}

run().catch(err => {
    console.error('Benchmark error:', err);
    process.exit(1);
});
