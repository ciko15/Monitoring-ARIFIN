const amqp = require('amqplib');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

let connection = null;
let channel = null;
const assertedQueues = new Set();
let nextConnectAttemptAt = 0;
let currentBackoffMs = 0;
const logTimestamps = new Map();

function parsePositiveInt(value, fallback) {
    const parsed = parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEmsEnabled() {
    return String(process.env.EMS_ENABLED || 'true').toLowerCase() !== 'false';
}

const EMS_PUBLISH_TIMEOUT_MS = parsePositiveInt(process.env.EMS_PUBLISH_TIMEOUT_MS, 2000);
const EMS_RETRY_BACKOFF_MS = parsePositiveInt(process.env.EMS_RETRY_BACKOFF_MS, 30000);
const EMS_MAX_BACKOFF_MS = parsePositiveInt(process.env.EMS_MAX_BACKOFF_MS, 300000);
const EMS_LOG_THROTTLE_MS = parsePositiveInt(process.env.LOG_THROTTLE_MS, 60000);

function makeEmsError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function shouldLog(key, throttleMs = EMS_LOG_THROTTLE_MS) {
    const now = Date.now();
    const lastLoggedAt = logTimestamps.get(key) || 0;
    if (now - lastLoggedAt < throttleMs) return false;
    logTimestamps.set(key, now);
    return true;
}

function isExpectedEmsError(error) {
    return error && (error.code === 'EMS_DISABLED' || error.code === 'EMS_BACKOFF');
}

function logPublishResult(result, successMessage) {
    if (result && result.skipped) {
        if (shouldLog(`publish-skipped:${result.reason}:${result.queue}`)) {
            console.log(`[EMS-DEBUG] Publish skipped to ${result.queue}: ${result.reason}`);
        }
        return;
    }

    console.log(successMessage);
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(makeEmsError('EMS_TIMEOUT', `${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function readBranchProfileSync() {
    try {
        const profilePath = path.resolve(process.cwd(), 'db', 'branch_profile.json');
        if (!fs.existsSync(profilePath)) return {};
        return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (error) {
        console.warn('[EMS] Failed to read branch_profile.json:', error.message);
        return {};
    }
}

function readAirportConfigSync() {
    try {
        const configPath = path.resolve(process.cwd(), 'db', 'airport_config.json');
        if (!fs.existsSync(configPath)) return {};
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        console.warn('[EMS] Failed to read airport_config.json:', error.message);
        return {};
    }
}

const branchProfile = readBranchProfileSync();
const airportConfig = readAirportConfigSync();
const DEFAULT_SOURCE_SERVICE = airportConfig.siteId || airportConfig.code || 'UNKNOWN';

const branchRabbit = branchProfile.rabbitmq || {};
const branchServices = branchProfile.services || {};

const RabbitConfig = {
    protocol: process.env.RABBITMQ_PROTOCOL || branchRabbit.protocol || 'amqp',
    hostname: process.env.RABBITMQ_HOST || branchRabbit.host || '172.20.17.104',
    port: parseInt(process.env.RABBITMQ_PORT || branchRabbit.port || '5672', 10),
    username: process.env.RABBITMQ_USERNAME || branchRabbit.username || 'smart-toc-hq',
    password: process.env.RABBITMQ_PASSWORD || branchRabbit.password || 'smarthq123!',
    vhost: process.env.RABBITMQ_VHOST || branchRabbit.vhost || 'dev-smart'
};

const AirNavServiceQueue = {
    TOC: 'Q.TOC',
    TEST: 'Q.TEST',
    GOLOG: 'Q.GOLOG'
};

const EquipmentCategoryQueue = {
    Communication: 'Q.COM',
    Navigation: 'Q.NAV',
    Surveillance: 'Q.SUR',
    'Data Processing': 'Q.DAT',
    Support: 'Q.SUP',
};

const EquipmentCategoryCode = {
    Communication: 'COM',
    Navigation: 'NAV',
    Surveillance: 'SUR',
    'Data Processing': 'DAT',
    Support: 'SUP',
};

const MessagingTopology = {
    EVENT: {
        'equipment.telemetry.received': 'EVT.EQUIPMENT.TELEMETRY',
        'equipment.status.changed': 'EVT.EQUIPMENT.STATUS',
        'equipment.alarm.raised': 'EVT.EQUIPMENT.ALARM',
        'equipment.alarm.cleared': 'EVT.EQUIPMENT.ALARM',
        'equipment.source.disconnected': 'EVT.EQUIPMENT.STATUS',
        'equipment.source.reconnected': 'EVT.EQUIPMENT.STATUS',
        'configuration.threshold.applied': 'EVT.CONFIG.RESULT',
        'configuration.threshold.rejected': 'EVT.CONFIG.RESULT',
        'configuration.threshold.failed': 'EVT.CONFIG.RESULT',
        'collector.refresh.completed': 'EVT.COLLECTOR.RESULT',
        'collector.refresh.failed': 'EVT.COLLECTOR.RESULT',
        'branch.heartbeat.sent': 'EVT.BRANCH.HEARTBEAT'
    },
    COMMAND: {
        'configuration.threshold.apply': targetSiteId => `CMD.CONFIG.${targetSiteId}`,
        'configuration.source.enable': targetSiteId => `CMD.CONFIG.${targetSiteId}`,
        'configuration.source.disable': targetSiteId => `CMD.CONFIG.${targetSiteId}`,
        'collector.refresh_source': targetSiteId => `CMD.COLLECTOR.${targetSiteId}`,
        'collector.reload_config': targetSiteId => `CMD.COLLECTOR.${targetSiteId}`,
        'system.sync_clock_check': targetSiteId => `CMD.SYSTEM.${targetSiteId}`
    },
    REQUEST: {
        'equipment.snapshot.requested': targetSiteId => `REQ.EQUIPMENT.${targetSiteId}`,
        'configuration.snapshot.requested': targetSiteId => `REQ.CONFIG.${targetSiteId}`,
        'branch.health.requested': targetSiteId => `REQ.BRANCH.${targetSiteId}`
    },
    RESPONSE: {
        'equipment.snapshot.responded': 'RSP.EQUIPMENT',
        'configuration.snapshot.responded': 'RSP.CONFIG',
        'branch.health.responded': 'RSP.BRANCH'
    }
};

async function connect() {
    if (connection && channel) return channel;
    if (!isEmsEnabled()) {
        throw makeEmsError('EMS_DISABLED', 'EMS publishing disabled');
    }

    const now = Date.now();
    if (nextConnectAttemptAt && now < nextConnectAttemptAt) {
        throw makeEmsError('EMS_BACKOFF', `RabbitMQ reconnect backoff active for ${Math.ceil((nextConnectAttemptAt - now) / 1000)}s`);
    }

    try {
        connection = await withTimeout(amqp.connect(RabbitConfig), EMS_PUBLISH_TIMEOUT_MS, 'RabbitMQ connect');
        channel = await withTimeout(connection.createChannel(), EMS_PUBLISH_TIMEOUT_MS, 'RabbitMQ channel');
        currentBackoffMs = 0;
        nextConnectAttemptAt = 0;
        console.log('✅ [EMS] Berhasil terhubung ke RabbitMQ menggunakan amqplib');

        connection.on('error', error => {
            if (shouldLog(`connection-error:${error.message}`)) {
                console.error('❌ [EMS] RabbitMQ connection error:', error.message);
            }
            connection = null;
            channel = null;
            assertedQueues.clear();
        });

        connection.on('close', () => {
            if (shouldLog('connection-closed')) {
                console.warn('⚠️ [EMS] RabbitMQ connection closed');
            }
            connection = null;
            channel = null;
            assertedQueues.clear();
        });

        return channel;
    } catch (error) {
        currentBackoffMs = currentBackoffMs
            ? Math.min(currentBackoffMs * 2, EMS_MAX_BACKOFF_MS)
            : EMS_RETRY_BACKOFF_MS;
        nextConnectAttemptAt = Date.now() + currentBackoffMs;

        if (shouldLog(`connect-failed:${error.code || error.message}`)) {
            console.error(`❌ [EMS] Gagal terhubung ke RabbitMQ: ${error.message}. Retry in ${Math.round(currentBackoffMs / 1000)}s`);
        }
        throw error;
    }
}

async function assertQueue(queue) {
    if (!queue) {
        throw new Error('Queue name is required');
    }

    if (assertedQueues.has(queue)) {
        return;
    }

    const ch = await connect();
    await ch.assertQueue(queue, { durable: true });
    assertedQueues.add(queue);
}

function getQueueByCategory(category) {
    const queue = EquipmentCategoryQueue[category];
    if (!queue) {
        return EquipmentCategoryQueue.Support;
    }
    return queue;
}

function getCategoryCode(category) {
    return EquipmentCategoryCode[category] || EquipmentCategoryCode.Support;
}

function normalizeSiteId(siteId) {
    return String(siteId || process.env.SITE_ID || process.env.AIRPORT_SITE_ID || branchProfile.siteId || branchProfile.airportCode || 'UNKNOWN')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '_');
}

function buildMessageEnvelope(messagePattern, messageName, payload = {}, options = {}) {
    return {
        header: {
            REQUEST_TYPE: options.requestType || messageName,
            SOURCE_SERVICE: process.env.SOURCE_SERVICE || DEFAULT_SOURCE_SERVICE,
            TIMESTAMP: new Date().toISOString()
        },
        body: payload
    };
}

function resolveQueue(messagePattern, messageName, targetSiteId) {
    const domain = MessagingTopology[messagePattern];
    if (!domain) {
        throw new Error(`Unsupported message pattern: ${messagePattern}`);
    }

    const resolver = domain[messageName];
    if (!resolver) {
        throw new Error(`Unsupported message name for ${messagePattern}: ${messageName}`);
    }

    return typeof resolver === 'function'
        ? resolver(normalizeSiteId(targetSiteId))
        : resolver;
}

async function sendToQueue(queue, message) {
    if (!isEmsEnabled()) {
        return {
            skipped: true,
            reason: 'EMS_DISABLED',
            queue,
            message
        };
    }

    const ch = await connect();
    await assertQueue(queue);

    const requestType = message?.header?.REQUEST_TYPE || message?.header?.message_name || 'UNKNOWN';
    const sourceService = process.env.SOURCE_SERVICE || DEFAULT_SOURCE_SERVICE;
    const timestamp = message?.header?.TIMESTAMP || message?.header?.sent_at || new Date().toISOString();

    ch.sendToQueue(
        queue,
        Buffer.from(JSON.stringify(message)),
        {
            persistent: true,
            contentType: 'application/json',
            headers: {
                REQUEST_TYPE: requestType,
                SOURCE_SERVICE: sourceService,
                TIMESTAMP: timestamp
            }
        }
    );

    return {
        queue,
        message
    };
}

async function publishMessage(messagePattern, messageName, payload = {}, options = {}, callback) {
    try {
        const queue = resolveQueue(messagePattern, messageName, options.targetSiteId);
        const envelope = buildMessageEnvelope(messagePattern, messageName, payload, options);
        const result = await sendToQueue(queue, envelope);

        logPublishResult(result, `[EMS-DEBUG] Publish success to ${queue} (${messageName})`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        if (!isExpectedEmsError(error) && shouldLog(`publish-failed:${messageName}:${error.code || error.message}`)) {
            console.error(`[EMS-DEBUG] Publish failed (${messageName}):`, error.message);
        }
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

async function publishCategorizedEvent(category, messageName, payload = {}, options = {}, callback) {
    try {
        const normalizedCategory = EquipmentCategoryQueue[category] ? category : 'Support';
        const queue = getQueueByCategory(normalizedCategory);
        
        const envelope = buildMessageEnvelope('EVENT', messageName, payload, options);

        const result = await sendToQueue(queue, envelope);
        logPublishResult(result, `[EMS-DEBUG] Publish categorized event to ${queue} (${messageName})`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        if (!isExpectedEmsError(error) && shouldLog(`categorized-failed:${messageName}:${error.code || error.message}`)) {
            console.error(`[EMS-DEBUG] Categorized event failed (${messageName}):`, error.message);
        }
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

async function publishByCategory(category, payload = {}, options = {}, callback) {
    try {
        const queue = getQueueByCategory(category);
        const message = {
            header: {
                REQUEST_TYPE: options.requestType || 'EQUIPMENT_MONITORING',
                SOURCE_SERVICE: process.env.SOURCE_SERVICE || DEFAULT_SOURCE_SERVICE,
                TIMESTAMP: new Date().toISOString()
            },
            body: payload
        };

        const result = await sendToQueue(queue, message);
        logPublishResult(result, `[EMS-DEBUG] Publish success to ${queue}`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        if (!isExpectedEmsError(error) && shouldLog(`publish-by-category:${category}:${error.code || error.message}`)) {
            console.error('[EMS-DEBUG] Publish failed:', error.message);
        }
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

async function produceInternalMessage(queue, metadata = {}, payload = {}, callback) {
    try {
        const message = {
            header: {
                REQUEST_TYPE: metadata.REQUEST_TYPE || metadata.message_name || 'UNKNOWN',
                SOURCE_SERVICE: process.env.SOURCE_SERVICE || DEFAULT_SOURCE_SERVICE,
                TIMESTAMP: new Date().toISOString()
            },
            body: payload
        };

        const result = await sendToQueue(queue, message);
        logPublishResult(result, `[EMS-DEBUG] Publish success to ${queue}`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        if (!isExpectedEmsError(error) && shouldLog(`produce:${queue}:${error.code || error.message}`)) {
            console.error(`[EMS-DEBUG] Publish failed to ${queue}:`, error.message);
        }
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

const LogType = {
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR'
};

module.exports = {
    connect,
    publishMessage,
    publishCategorizedEvent,
    publishByCategory,
    produceInternalMessage,
    resolveQueue,
    buildMessageEnvelope,
    getQueueByCategory,
    getCategoryCode,
    normalizeSiteId,
    isEmsEnabled,
    EquipmentCategoryQueue,
    EquipmentCategoryCode,
    AirNavServiceQueue,
    MessagingTopology,
    LogType
};
