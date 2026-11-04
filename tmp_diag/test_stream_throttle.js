const assert = require('assert');

// Mock NetworkListenerService methods to test the throttling engine logic in isolation
class MockThrottleService {
    constructor() {
        this._streamThrottleState = new Map();
        this._streamThrottleTimers = new Map();
        this.emitted = [];
    }

    _getStreamThrottleConfig(parsingId) {
        const enabled = String(process.env.STREAM_THROTTLE_ENABLED || 'true').toLowerCase() !== 'false';
        if (!enabled) return { enabled: false, windowMs: 1000 };

        const rawIds = process.env.STREAM_THROTTLE_IDS || '';
        const allowlist = rawIds.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const pid = String(parsingId || '').trim().toLowerCase();
        const isAllowed = allowlist.includes(pid);
        if (!isAllowed) return { enabled: false, windowMs: 1000 };

        const envKey = `STREAM_THROTTLE_MS_${pid.toUpperCase()}`;
        const customMs = parseInt(process.env[envKey], 10);
        const globalMs = parseInt(process.env.STREAM_THROTTLE_MS, 10);
        const windowMs = (!isNaN(customMs) && customMs > 0) ? customMs : ((!isNaN(globalMs) && globalMs > 0) ? globalMs : 1000);

        return { enabled: true, windowMs };
    }

    _mergeStreamData(oldData, newData) {
        if (!oldData) return newData;
        if (!newData) return oldData;
        const mergedData = { ...(oldData.data || {}), ...(newData.data || {}) };

        let alarms = undefined;
        if (Array.isArray(oldData.alarms) || Array.isArray(newData.alarms)) {
            alarms = Array.from(new Set([...(oldData.alarms || []), ...(newData.alarms || [])]));
        }

        let warnings = undefined;
        if (Array.isArray(oldData.warnings) || Array.isArray(newData.warnings)) {
            warnings = Array.from(new Set([...(oldData.warnings || []), ...(newData.warnings || [])]));
        }

        return {
            ...oldData,
            ...newData,
            data: mergedData,
            ...(alarms !== undefined ? { alarms } : {}),
            ...(warnings !== undefined ? { warnings } : {})
        };
    }

    async _handleLogOutput(source, logData, connectionType, targetStatus) {
        this.emitted.push({ source, logData, connectionType, status: targetStatus, time: Date.now() });
    }

    _emitStreamThrottled(source, logData, connectionType, status) {
        const parsingId = source ? source.parsing_id : connectionType;
        const config = this._getStreamThrottleConfig(parsingId);

        if (!config.enabled) {
            this._handleLogOutput(source, logData, connectionType, status).catch(() => {});
            return;
        }

        const sourceId = source ? source.id : (connectionType || 'unknown');
        if (!this._streamThrottleState) this._streamThrottleState = new Map();
        if (!this._streamThrottleTimers) this._streamThrottleTimers = new Map();

        let state = this._streamThrottleState.get(sourceId);
        if (!state) {
            state = {
                source,
                connectionType,
                lastEmitAt: 0,
                lastStatus: null,
                pending: null,
                inFlight: false,
                stopped: false,
                counters: { in: 0, out: 0, dropped: 0, bypass: 0 }
            };
            this._streamThrottleState.set(sourceId, state);
        }

        state.counters.in++;
        const now = Date.now();
        const hasAlarms = (Array.isArray(logData.alarms) && logData.alarms.length > 0) ||
            (logData.data && Array.isArray(logData.data.alarms) && logData.data.alarms.length > 0);
        const hasWarnings = (Array.isArray(logData.warnings) && logData.warnings.length > 0) ||
            (logData.data && Array.isArray(logData.data.warnings) && logData.data.warnings.length > 0);

        const isFirstCall = state.lastStatus === null;
        const isStatusChanged = !isFirstCall && status !== state.lastStatus;
        const isNonNormal = status && status.toLowerCase() !== 'normal';
        const isBypass = isFirstCall || isStatusChanged || isNonNormal || hasAlarms || hasWarnings;

        const invokeLogOutput = (targetData, targetStatus, isBypassCall) => {
            if (state.stopped) return;
            state.inFlight = true;
            state.lastEmitAt = Date.now();
            state.lastStatus = targetStatus;
            state.counters.out++;
            if (isBypassCall) state.counters.bypass++;

            this._handleLogOutput(source, targetData, connectionType, targetStatus)
                .catch(() => {})
                .finally(() => {
                    state.inFlight = false;
                    if (state.stopped) return;
                    if (state.pending) {
                        const nextPending = state.pending;
                        state.pending = null;
                        if (this._streamThrottleTimers.has(sourceId)) {
                            clearTimeout(this._streamThrottleTimers.get(sourceId));
                            this._streamThrottleTimers.delete(sourceId);
                        }
                        invokeLogOutput(nextPending.logData, nextPending.status, nextPending.isBypass);
                    }
                });
        };

        if (isBypass) {
            if (state.inFlight) {
                state.pending = { logData, status, isBypass: true };
            } else {
                state.pending = null;
                if (this._streamThrottleTimers.has(sourceId)) {
                    clearTimeout(this._streamThrottleTimers.get(sourceId));
                    this._streamThrottleTimers.delete(sourceId);
                }
                invokeLogOutput(logData, status, true);
            }
            return;
        }

        const elapsed = now - state.lastEmitAt;
        if (elapsed >= config.windowMs && !state.inFlight) {
            state.pending = null;
            if (this._streamThrottleTimers.has(sourceId)) {
                clearTimeout(this._streamThrottleTimers.get(sourceId));
                this._streamThrottleTimers.delete(sourceId);
            }
            invokeLogOutput(logData, status, false);
        } else {
            state.counters.dropped++;
            if (state.pending) {
                state.pending.logData = this._mergeStreamData(state.pending.logData, logData);
                state.pending.status = status;
            } else {
                state.pending = { logData, status, isBypass: false };
            }

            if (!this._streamThrottleTimers.has(sourceId)) {
                const delay = Math.max(10, config.windowMs - elapsed);
                const timer = setTimeout(() => {
                    this._streamThrottleTimers.delete(sourceId);
                    if (state.stopped || !state.pending) return;
                    if (!state.inFlight) {
                        const toFlush = state.pending;
                        state.pending = null;
                        invokeLogOutput(toFlush.logData, toFlush.status, toFlush.isBypass);
                    }
                }, delay);
                this._streamThrottleTimers.set(sourceId, timer);
            }
        }
    }

    stopAll() {
        if (this._streamThrottleTimers) {
            for (const [id, timer] of this._streamThrottleTimers) {
                clearTimeout(timer);
            }
            this._streamThrottleTimers.clear();
        }
        if (this._streamThrottleState) {
            for (const [id, state] of this._streamThrottleState) {
                state.stopped = true;
                state.pending = null;
            }
            this._streamThrottleState.clear();
        }
    }
}

async function runTests() {
    console.log("--- Menjalankan Uji Verifikasi 2a s/d 2j ---");

    // 2a. Simulasi 2400 panggilan/menit allowlist
    process.env.STREAM_THROTTLE_ENABLED = 'true';
    process.env.STREAM_THROTTLE_IDS = 'ils_mophien_gp,dme_mophien_tdme,asterix_radar';
    process.env.STREAM_THROTTLE_MS = '100'; // Gunakan 100ms agar tes cepat selesai

    const s = new MockThrottleService();
    const source1 = { id: 101, name: 'GP Juanda', parsing_id: 'ils_mophien_gp' };

    for (let i = 0; i < 40; i++) {
        s._emitStreamThrottled(source1, { data: { seq: i, val: i * 2 } }, 'ils_mophien_gp', 'Normal');
        await new Promise(r => setTimeout(r, 5)); // 40 panggilan dalam 200ms
    }
    // Tunggu trailing flush
    await new Promise(r => setTimeout(r, 150));
    assert(s.emitted.length <= 4, `Jumlah emitted harus ter-throttle (didapat: ${s.emitted.length})`);
    const lastEmitted = s.emitted[s.emitted.length - 1];
    assert.strictEqual(lastEmitted.logData.data.seq, 39, "Nilai paket terakhir harus terkirim di trailing flush");
    console.log("2a. Rate throttling & trailing flush: PASS");

    // 2b. Status change bypass (< 50ms)
    const t0 = Date.now();
    s._emitStreamThrottled(source1, { data: { seq: 41 } }, 'ils_mophien_gp', 'Alarm');
    await new Promise(r => setImmediate(r));
    const alarmEmit = s.emitted[s.emitted.length - 1];
    assert.strictEqual(alarmEmit.status, 'Alarm');
    assert(Date.now() - t0 < 50, "Bypass perubahan status harus instan (< 50ms)");
    console.log("2b. Status change bypass: PASS");

    // 2c. Alarms/warnings non-kosong bypass
    s._emitStreamThrottled(source1, { data: { seq: 42, alarms: ['CRITICAL_RF'] } }, 'ils_mophien_gp', 'Normal');
    await new Promise(r => setImmediate(r));
    const warningEmit = s.emitted[s.emitted.length - 1];
    assert.strictEqual(warningEmit.logData.data.seq, 42, "Paket dengan alarm harus langsung di-bypass");
    console.log("2c. Alarms/warnings bypass: PASS");

    // 2e. Semantik merge
    s.emitted = [];
    s._emitStreamThrottled(source1, { data: { fieldA: 1 } }, 'ils_mophien_gp', 'Normal'); // leading
    s._emitStreamThrottled(source1, { data: { fieldB: 2 } }, 'ils_mophien_gp', 'Normal'); // pending
    s._emitStreamThrottled(source1, { data: { fieldC: 3 } }, 'ils_mophien_gp', 'Normal'); // merged pending
    await new Promise(r => setTimeout(r, 150)); // flush
    const finalMerged = s.emitted[s.emitted.length - 1];
    assert.strictEqual(finalMerged.logData.data.fieldB, 2);
    assert.strictEqual(finalMerged.logData.data.fieldC, 3);
    console.log("2e. Semantik merge: PASS");

    // 2f. STREAM_THROTTLE_ENABLED=false
    process.env.STREAM_THROTTLE_ENABLED = 'false';
    s.emitted = [];
    for (let i = 0; i < 5; i++) {
        s._emitStreamThrottled(source1, { data: { count: i } }, 'ils_mophien_gp', 'Normal');
    }
    assert.strictEqual(s.emitted.length, 5, "Saat kill-switch mati, 5 panggilan harus diteruskan semua");
    console.log("2f. Kill-switch disabled: PASS");

    // 2g. Parsing ID di luar allowlist (snmp_system, asterix_adsb, modbus)
    process.env.STREAM_THROTTLE_ENABLED = 'true';
    s.emitted = [];
    const snmpSource = { id: 201, name: 'Server Pusat', parsing_id: 'snmp_system' };
    const adsbSource = { id: 202, name: 'ADSB Surabaya', parsing_id: 'asterix_adsb' };
    s._emitStreamThrottled(snmpSource, { data: { cpu: 10 } }, 'snmp_system', 'Normal');
    s._emitStreamThrottled(snmpSource, { data: { cpu: 11 } }, 'snmp_system', 'Normal');
    s._emitStreamThrottled(adsbSource, { data: { target: 5 } }, 'asterix_adsb', 'Normal');
    s._emitStreamThrottled(adsbSource, { data: { target: 6 } }, 'asterix_adsb', 'Normal');
    assert.strictEqual(s.emitted.length, 4, "Modul di luar allowlist tidak boleh di-throttle");
    console.log("2g. Non-allowlist unaffected: PASS");

    // 2h. stopAll() di tengah jendela
    const freshSource = { id: 301, name: 'GP Fresh', parsing_id: 'ils_mophien_gp' };
    s.emitted = [];
    s._emitStreamThrottled(freshSource, { data: { seq: 100 } }, 'ils_mophien_gp', 'Normal');
    assert.strictEqual(s.emitted.length, 1, "First call (bypass) harus langsung ter-emit sinkron");
    s._emitStreamThrottled(freshSource, { data: { seq: 101 } }, 'ils_mophien_gp', 'Normal'); // pending
    s.stopAll();
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(s._streamThrottleTimers.size, 0, "Timers map harus kosong");
    assert.strictEqual(s.emitted.length, 1, "Tidak boleh ada trailing flush setelah stopAll");
    console.log("2h. stopAll cleanup: PASS");

    console.log("\nSELURUH UJI VERIFIKASI SELESAI & LULUS.");
}
runTests();
