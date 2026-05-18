const amqp = require('amqplib');

let connection = null;
let channel = null;

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

async function connect() {
    if (connection && channel) return channel;
    
    try {
        connection = await amqp.connect({
            protocol: 'amqp',
            hostname: '172.20.17.104',
            port: 5672,
            username: 'smart-toc-hq',
            password: 'smarthq123!',
            vhost: 'dev-smart'
        });
        
        channel = await connection.createChannel();
        console.log('✅ [EMS] Berhasil terhubung ke RabbitMQ menggunakan amqplib');
        
        // Assert queues to make sure they exist
        await channel.assertQueue(AirNavServiceQueue.TOC, { durable: true });
        for (const q of Object.values(EquipmentCategoryQueue)) {
            await channel.assertQueue(q, { durable: true });
        }
        
        return channel;
    } catch (error) {
        console.error('❌ [EMS] Gagal terhubung ke RabbitMQ:', error.message);
        throw error;
    }
}

function getQueueByCategory(category) {
    const queue = EquipmentCategoryQueue[category];
    if (!queue) {
        return EquipmentCategoryQueue.Support; // Default to Support if category not found
    }
    return queue;
}

async function publishByCategory(category, payload = {}, options = {}, callback) {
    try {
        const ch = await connect();
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
        
        ch.sendToQueue(
            queue,
            Buffer.from(JSON.stringify(message)),
            {
                persistent: true,
                contentType: 'application/json'
            }
        );
        
        console.log(`[EMS-DEBUG] Publish success to ${queue}`);
        if (typeof callback === 'function') callback('Message sent', null);
        return 'Message sent';
    } catch (error) {
        console.error(`[EMS-DEBUG] Publish failed:`, error.message);
        if (typeof callback === 'function') callback(null, error);
        throw error;
    }
}

async function produceInternalMessage(queue, metadata = {}, payload = {}, callback) {
    try {
        const ch = await connect();
        
        const message = {
            header: metadata,
            body: payload
        };
        
        ch.sendToQueue(
            queue,
            Buffer.from(JSON.stringify(message)),
            {
                persistent: true,
                contentType: 'application/json'
            }
        );
        
        console.log(`[EMS-DEBUG] Publish success to ${queue}`);
        if (typeof callback === 'function') callback('Message sent', null);
        return 'Message sent';
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
    publishByCategory,
    produceInternalMessage,
    getQueueByCategory,
    EquipmentCategoryQueue,
    AirNavServiceQueue,
    LogType
};