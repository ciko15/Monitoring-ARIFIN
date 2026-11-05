/**
 * scripts/test-limit-equivalence.js
 * 
 * Pengujian Kesetaraan Tahap 2f (wajib):
 * 1. Simpan fungsi lama sebagai referensi di file tes.
 * 2. Untuk minimal 2.000 kombinasi acak (limit dari db/limitation_config.json x key dari data parser nyata/tiruan),
 *    hasil isMatch lama == baru.
 * 3. Bandingkan statusToEvaluate akhir lama vs baru untuk 1.000 paket. Harus 100% sama.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database.js');
const thresholdEvaluator = require('../src/utils/thresholdEvaluator.js');
const { limitMatchesKey, ALIAS_MAP } = require('../src/services/network_listener.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. FUNGSI LAMA (REFERENSI PERSIS SEPERTI SEBELUM TAHAP 2)
// ─────────────────────────────────────────────────────────────────────────────
function oldLimitMatch(lim, key) {
    const aliasMap = ALIAS_MAP;
    const lName = String(lim.name || lim.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const lSource = String(lim.source || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const dKey = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const strippedKey = dKey.replace(/^(mon1|mon2|tx1|tx2|lcu)/, '');

    let isMatch = (lName === dKey || lSource === dKey || lName === strippedKey || lSource === strippedKey);
    if (!isMatch) {
        for (const [canon, aliases] of Object.entries(aliasMap)) {
            const allVariants = [canon, ...aliases];
            const candMatches = allVariants.some(a => a === lName || (a.length >= 4 && lName.length >= 4 && (lName.includes(a) || a.includes(lName))));
            const keyMatches = allVariants.some(a => a === dKey || a === strippedKey || (a.length >= 4 && dKey.length >= 4 && (dKey.includes(a) || a.includes(dKey))) || (a.length >= 4 && strippedKey.length >= 4 && (strippedKey.includes(a) || a.includes(strippedKey))));
            if (candMatches && keyMatches) {
                isMatch = true;
                break;
            }
        }
    }
    if (!isMatch && lim.match_mode !== 'exact' && lName.length >= 4) {
        isMatch = (dKey.length >= 4 && (dKey.includes(lName) || lName.includes(dKey))) || (strippedKey.length >= 4 && (strippedKey.includes(lName) || lName.includes(strippedKey)));
    }
    return isMatch;
}

function oldEvaluateStatus(limits, flatParams) {
    let statusToEvaluate = 'Normal';
    for (const lim of limits) {
        if (lim.is_active === false || lim.is_active === 'false' || lim.is_active === 0 || lim.is_active === '0') continue;
        const lName = String(lim.name || lim.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const lSource = String(lim.source || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        for (const [key, rawVal] of Object.entries(flatParams)) {
            if (rawVal === undefined || rawVal === null) continue;
            const isMatch = oldLimitMatch(lim, key);
            if (isMatch) {
                const evalStatus = thresholdEvaluator.checkThreshold(rawVal, lim);
                if (evalStatus === 'Alert' || evalStatus === 'Alarm' || evalStatus === 'Warning') {
                    statusToEvaluate = 'Warning';
                    break;
                }
            }
        }
        if (statusToEvaluate === 'Warning') break;
    }
    return statusToEvaluate;
}

function newEvaluateStatus(limits, flatParams) {
    let statusToEvaluate = 'Normal';
    const flatEntries = Object.entries(flatParams);
    const flatLen = flatEntries.length;

    for (let i = 0; i < limits.length; i++) {
        const lim = limits[i];
        const isActive = !(lim.is_active === false || lim.is_active === 'false' || lim.is_active === 0 || lim.is_active === '0');
        if (!isActive) continue;
        const lName = String(lim.name || lim.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const lSource = String(lim.source || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        for (let j = 0; j < flatLen; j++) {
            const [key, rawVal] = flatEntries[j];
            if (rawVal === undefined || rawVal === null) continue;

            if (limitMatchesKey(lim, lName, lSource, key)) {
                const evalStatus = thresholdEvaluator.checkThreshold(rawVal, lim);
                if (evalStatus === 'Alert' || evalStatus === 'Alarm' || evalStatus === 'Warning') {
                    statusToEvaluate = 'Warning';
                    break;
                }
            }
        }
        if (statusToEvaluate === 'Warning') {
            break;
        }
    }
    return statusToEvaluate;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RUN EQUIVALENCE TESTS
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
    console.log('[TEST 2f] Starting Equivalence Tests (Tahap 2f)...');

    const limitsPath = path.join(__dirname, '../db/limitation_config.json');
    const limits = JSON.parse(fs.readFileSync(limitsPath, 'utf8'));
    console.log(`[TEST 2f] Loaded ${limits.length} limits from db/limitation_config.json`);

    // Kumpulan key nyata dari parser & tiruan
    const candidateKeys = [
        'suhu', 'temperature', 'temperature_c', 'temp', 'ambient temp', 'cpatemp', 'msgtemp',
        'kelembaban', 'humidity', 'humidity_pct', 'humi', 'kelembapan',
        'tegangan', 'voltage', 'volt', 'vln', 'vll', 'van voltage', 'vab', 'vbc', 'vca',
        'arus', 'current', 'ampere', 'amp', 'ia', 'ib', 'ic',
        'daya', 'power', 'watt', 'kw', 'fwd power', 'refl power', 'carrier power',
        'frekuensi', 'frequency', 'freq',
        'totalinterface', 'interfacecount', 'totalinterfaces',
        'interfaceup', 'activeinterfacecount', 'activeinterfaces',
        'interfacedown', 'downinterfacecount', 'downinterfaces',
        'cpuusage', 'cpu', 'processorload', 'cpu usage',
        'ramusage', 'ramusagepct', 'memoryusage', 'memoryusagepct',
        'ramavailable', 'ramavailablepct', 'memoryavailable',
        'diskusage', 'diskusagepct', 'storageusage',
        'crsrf', 'crs_rf', 'rf_power', 'rfpower',
        'crsddm', 'crs_ddm', 'ddm_course',
        'crssdm', 'crs_sdm', 'carrier_pwr',
        'identam', 'ident', 'ident_am',
        'widthrf', 'width_rf', 'csb_power',
        'widthddm', 'width_ddm', 'ddm_clr',
        'widthsdm', 'width_sdm', 'sbo_power',
        'clrrf', 'clr_rf', 'clr_power',
        'clrddm', 'clr_ddm',
        'clrsdm', 'clr_sdm',
        'nfrf', 'nf_rf', 'rf_out',
        'nfddm', 'nf_ddm', 'ddm_mon',
        'nfsdm', 'nf_sdm', 'mon_power',
        'freqdev', 'freq_dev', 'frequency deviation',
        'gpangle', 'gp_angle', 'glidepathangle',
        'carrierpower', 'carrierpwr',
        'rfinput', 'azimuth', 'systemdelay', 'pulserefficiency', 'pulsespacing', 'forwardpower', 'reflectedpower',
        'mon1_carrier_power', 'mon2_carrier_power', 'tx1_cpa_temp', 'tx2_cpa_temp', 'lcu_dc_5v',
        'txp1_m1_fwd_power', 'txp2_m1_reply_eff',
        'VL1N', 'VL12', 'IL1', 'KW', 'HZ', 'PF',
        'random_param_1', 'unmatched_key_abc', 'unknown_field_123'
    ];

    // Tes 1: 5.000 kombinasi acak limit x key (syarat minimal 2.000)
    console.log('[TEST 2f] Testing 5,000 random (limit x key) combinations for isMatch equivalence...');
    let matchCheckCount = 0;
    let matchMismatchCount = 0;

    for (let i = 0; i < 5000; i++) {
        const lim = limits[Math.floor(Math.random() * limits.length)];
        const key = candidateKeys[Math.floor(Math.random() * candidateKeys.length)];

        const lName = String(lim.name || lim.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const lSource = String(lim.source || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        const oldRes = oldLimitMatch(lim, key);
        const newRes = limitMatchesKey(lim, lName, lSource, key);

        matchCheckCount++;
        if (oldRes !== newRes) {
            console.error(`[FAIL] Mismatch at combination #${i}: key="${key}", lim.name="${lim.name}", lim.source="${lim.source}", match_mode="${lim.match_mode}" -> old=${oldRes}, new=${newRes}`);
            matchMismatchCount++;
            break;
        }
    }

    if (matchMismatchCount > 0) {
        console.error(`[FAIL] isMatch equivalence test failed with ${matchMismatchCount} mismatches!`);
        process.exit(1);
    }
    console.log(`[PASS] isMatch equivalence: ${matchCheckCount}/5000 combinations 100% IDENTICAL!`);

    // Tes 2: 1.000 paket simulasi membandingkan statusToEvaluate akhir lama vs baru
    console.log('[TEST 2f] Testing 1,000 packet statusToEvaluate evaluations...');
    let statusCheckCount = 0;
    let statusMismatchCount = 0;

    for (let p = 0; p < 1000; p++) {
        // Buat packet dummy dengan 5-15 parameter acak
        const flatParams = {};
        const paramCount = 5 + Math.floor(Math.random() * 10);
        for (let k = 0; k < paramCount; k++) {
            const key = candidateKeys[Math.floor(Math.random() * candidateKeys.length)];
            // Nilai acak (angka atau status string)
            const isNumeric = Math.random() > 0.3;
            flatParams[key] = isNumeric ? Math.floor(Math.random() * 120) : (Math.random() > 0.5 ? 'Normal' : 'Alarm');
        }

        const oldStatus = oldEvaluateStatus(limits, flatParams);
        const newStatus = newEvaluateStatus(limits, flatParams);

        statusCheckCount++;
        if (oldStatus !== newStatus) {
            console.error(`[FAIL] Packet #${p} statusToEvaluate mismatch: old="${oldStatus}", new="${newStatus}"`);
            console.error('Packet params:', flatParams);
            statusMismatchCount++;
            break;
        }
    }

    if (statusMismatchCount > 0) {
        console.error(`[FAIL] statusToEvaluate equivalence test failed with ${statusMismatchCount} mismatches!`);
        process.exit(1);
    }
    console.log(`[PASS] statusToEvaluate equivalence: ${statusCheckCount}/1000 packets 100% IDENTICAL!`);
    console.log('[ALL PASS] Tahap 2f Equivalence Testing Completed Successfully.');
    process.exit(0);
}

run().catch(err => {
    console.error('[ERROR]', err);
    process.exit(1);
});
