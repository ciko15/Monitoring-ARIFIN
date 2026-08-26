const DEFAULT_FAIL_COUNT_TO_DISCONNECT = 3;
const DEFAULT_RECOVERY_COUNT_TO_NORMAL = 1;
const DEFAULT_DISCONNECT_REPEAT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LOG_THROTTLE_MS = 60 * 1000;

function parsePositiveInt(value, fallback) {
    const parsed = parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeStatus(status) {
    const value = String(status || 'Normal').trim();
    const lower = value.toLowerCase();

    if (lower === 'disconnected' || lower === 'disconnect' || lower === 'offline') {
        return 'Disconnect';
    }

    if (lower === 'alarm' || lower === 'alert' || lower === 'critical' || lower === 'fail') {
        return value === 'Alarm' ? 'Alarm' : 'Alert';
    }

    if (lower === 'warning' || lower === 'warn' || lower === 'stale') {
        return 'Warning';
    }

    return value || 'Normal';
}

function isDisconnectStatus(status) {
    return normalizeStatus(status) === 'Disconnect';
}

class SourceStatusGate {
    constructor(options = {}) {
        this.failCountToDisconnect = parsePositiveInt(
            options.failCountToDisconnect || process.env.FAIL_COUNT_TO_DISCONNECT,
            DEFAULT_FAIL_COUNT_TO_DISCONNECT
        );
        this.recoveryCountToNormal = parsePositiveInt(
            options.recoveryCountToNormal || process.env.RECOVERY_COUNT_TO_NORMAL,
            DEFAULT_RECOVERY_COUNT_TO_NORMAL
        );
        this.disconnectRepeatIntervalMs = parsePositiveInt(
            options.disconnectRepeatIntervalMs || process.env.DISCONNECT_REPEAT_INTERVAL_MS,
            DEFAULT_DISCONNECT_REPEAT_INTERVAL_MS
        );
        this.logThrottleMs = parsePositiveInt(
            options.logThrottleMs || process.env.LOG_THROTTLE_MS,
            DEFAULT_LOG_THROTTLE_MS
        );

        this.states = new Map();
        this.logTimestamps = new Map();
    }

    getSourceKey(source = {}, fallback = {}) {
        const sourceId = source.id || fallback.sourceId;
        if (sourceId !== undefined && sourceId !== null && sourceId !== '') {
            return `source:${sourceId}`;
        }

        const equipmentId = source.equipt_id || source.equipmentId || fallback.equipmentId || 'unknown-equipment';
        const sourceName = source.name || fallback.sourceName || fallback.connectionType || 'default';
        return `equipment:${equipmentId}:${sourceName}`;
    }

    shouldLog(key, throttleMs = this.logThrottleMs) {
        const now = Date.now();
        const lastLoggedAt = this.logTimestamps.get(key) || 0;

        if (now - lastLoggedAt < throttleMs) {
            return false;
        }

        this.logTimestamps.set(key, now);
        return true;
    }

    evaluate(source, status, options = {}) {
        const normalizedStatus = normalizeStatus(status);
        const key = this.getSourceKey(source, options);
        const now = options.now !== undefined ? options.now : Date.now();
        const confirmDisconnect = options.confirmDisconnect !== false;
        const disconnectRepeatIntervalMs = options.disconnectRepeatIntervalMs !== undefined
            ? options.disconnectRepeatIntervalMs
            : this.disconnectRepeatIntervalMs;

        let state = this.states.get(key);
        if (!state) {
            state = {
                sourceKey: key,
                status: null,
                failCount: 0,
                successCount: 0,
                lastStatusChangedAt: null,
                lastDisconnectSentAt: 0,
                lastTelemetrySentAt: 0,
                lastSuccessAt: null
            };
            this.states.set(key, state);
        }

        if (normalizedStatus === 'Disconnect') {
            state.failCount += 1;
            state.successCount = 0;

            const timeSinceLastSuccess = state.lastSuccessAt ? (now - state.lastSuccessAt) : 0;

            if (confirmDisconnect && state.status !== null && state.status !== 'Disconnect' && timeSinceLastSuccess < 120000) {
                return {
                    shouldEmit: false,
                    status: state.status || 'Warning',
                    reason: 'disconnect-not-confirmed',
                    state
                };
            }

            const wasDisconnect = state.status === 'Disconnect';
            if (!wasDisconnect) {
                state.status = 'Disconnect';
                state.lastStatusChangedAt = now;
                state.lastDisconnectSentAt = now;
                state.lastTelemetrySentAt = now;

                return {
                    shouldEmit: true,
                    status: 'Disconnect',
                    reason: 'disconnect-transition',
                    state
                };
            }

            if (now - state.lastDisconnectSentAt >= disconnectRepeatIntervalMs) {
                state.lastDisconnectSentAt = now;
                state.lastTelemetrySentAt = now;

                return {
                    shouldEmit: true,
                    status: 'Disconnect',
                    reason: 'disconnect-heartbeat',
                    state
                };
            }

            return {
                shouldEmit: false,
                status: 'Disconnect',
                reason: 'disconnect-throttled',
                state
            };
        }

        state.failCount = 0;
        state.successCount += 1;
        state.lastSuccessAt = now;

        if (state.status === 'Disconnect' && state.successCount < this.recoveryCountToNormal) {
            return {
                shouldEmit: false,
                status: state.status,
                reason: 'recovery-not-confirmed',
                state
            };
        }

        if (state.status !== normalizedStatus) {
            state.status = normalizedStatus;
            state.lastStatusChangedAt = now;
        }
        state.lastTelemetrySentAt = now;

        return {
            shouldEmit: true,
            status: normalizedStatus,
            reason: 'active-telemetry',
            state
        };
    }
}

module.exports = {
    SourceStatusGate,
    normalizeStatus,
    isDisconnectStatus
};
