const amqp = require('amqplib');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

let connection = null;
let channel = null;
const assertedQueues = new Set();

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

const branchProfile = readBranchProfileSync();
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

    try {
        connection = await amqp.connect(RabbitConfig);
        channel = await connection.createChannel();
        console.log('✅ [EMS] Berhasil terhubung ke RabbitMQ menggunakan amqplib');

        connection.on('error', error => {
            console.error('❌ [EMS] RabbitMQ connection error:', error.message);
            connection = null;
            channel = null;
            assertedQueues.clear();
        });

        connection.on('close', () => {
            console.warn('⚠️ [EMS] RabbitMQ connection closed');
            connection = null;
            channel = null;
            assertedQueues.clear();
        });

        return channel;
    } catch (error) {
        console.error('❌ [EMS] Gagal terhubung ke RabbitMQ:', error.message);
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
    const targetSiteId = normalizeSiteId(options.targetSiteId);
    const producerSiteId = normalizeSiteId(options.producerSiteId);
    const targetService = options.targetService || process.env.TARGET_SERVICE_NAME || process.env.CENTRAL_SERVICE_NAME || branchServices.target || 'EMS';
    const producerService = options.producerService || process.env.MESSAGE_SERVICE_NAME || branchServices.producer || 'MONITORING_ARIFIN_BRANCH';
    const occurredAt = options.occurredAt || new Date().toISOString();
    const sentAt = new Date().toISOString();

    return {
        header: {
            message_id: options.messageId || randomUUID(),
            message_pattern: messagePattern,
            message_name: messageName,
            producer_service: producerService,
            producer_site_id: producerSiteId,
            target_service: targetService,
            target_site_id: targetSiteId,
            occurred_at: occurredAt,
            sent_at: sentAt,
            correlation_id: options.correlationId || randomUUID(),
            ...options.header
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
    const ch = await connect();
    await assertQueue(queue);

    ch.sendToQueue(
        queue,
        Buffer.from(JSON.stringify(message)),
        {
            persistent: true,
            contentType: 'application/json'
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

        console.log(`[EMS-DEBUG] Publish success to ${queue} (${messageName})`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        console.error(`[EMS-DEBUG] Publish failed (${messageName}):`, error.message);
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

async function publishCategorizedEvent(category, messageName, payload = {}, options = {}, callback) {
    try {
        const normalizedCategory = EquipmentCategoryQueue[category] ? category : 'Support';
        const queue = getQueueByCategory(normalizedCategory);
        const categoryCode = getCategoryCode(normalizedCategory);
        const envelope = buildMessageEnvelope(
            'EVENT',
            messageName,
            payload,
            {
                ...options,
                header: {
                    event_type: options.eventType || 'telemetry',
                    domain: options.domain || 'equipment',
                    category: normalizedCategory,
                    category_code: categoryCode,
                    equipment_id: options.equipmentId || payload.equipment_id || null,
                    equipment_name: options.equipmentName || payload.equipment_name || null,
                    source_name: options.sourceName || payload.source || payload.source_name || null,
                    ...options.header
                }
            }
        );

        const result = await sendToQueue(queue, envelope);
        console.log(`[EMS-DEBUG] Publish categorized event to ${queue} (${messageName})`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        console.error(`[EMS-DEBUG] Categorized event failed (${messageName}):`, error.message);
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

async function publishByCategory(category, payload = {}, options = {}, callback) {
    try {
        const queue = getQueueByCategory(category);
        const metadata = {
            REQUEST_TYPE: options.requestType || 'EQUIPMENT_MONITORING',
            CATEGORY: category,
            SOURCE_SERVICE: 'MONITORING_ARIFIN',
            ...options.metadata,
        };

        const message = {
            header: metadata,
            body: payload
        };

        const result = await sendToQueue(queue, message);
        console.log(`[EMS-DEBUG] Publish success to ${queue}`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        console.error('[EMS-DEBUG] Publish failed:', error.message);
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

async function produceInternalMessage(queue, metadata = {}, payload = {}, callback) {
    try {
        const message = {
            header: metadata,
            body: payload
        };

        const result = await sendToQueue(queue, message);
        console.log(`[EMS-DEBUG] Publish success to ${queue}`);
        if (typeof callback === 'function') callback(result, null);
        return result;
    } catch (error) {
        console.error(`[EMS-DEBUG] Publish failed to ${queue}:`, error.message);
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
    EquipmentCategoryQueue,
    EquipmentCategoryCode,
    AirNavServiceQueue,
    MessagingTopology,
    LogType
};
