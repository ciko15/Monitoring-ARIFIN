const { publishMessage, isEmsEnabled } = require('../connection/ems');
const fs = require('fs');
const path = require('path');

function getAirportConfig() {
    try {
        const configPath = path.join(__dirname, '../../db/airport_config.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (Array.isArray(data) && data.length > 0) return data[0];
            return data;
        }
    } catch (e) {
        console.error('[Heartbeat] Error reading airport config:', e.message);
    }
    return {};
}

function startHeartbeat() {
    if (!isEmsEnabled()) {
        console.log('[Heartbeat] EMS is disabled. Heartbeat will not be sent.');
        return;
    }

    console.log('[Heartbeat] Starting branch heartbeat service...');

    // Send heartbeat immediately, then every 60 seconds
    const sendHeartbeat = () => {
        try {
            const airportConfig = getAirportConfig();
            const siteId = process.env.SITE_ID || airportConfig.siteId || 'UNKNOWN_SITE';
            const airportCode = airportConfig.code || siteId;
            const now = new Date().toISOString();

            const payload = {
                site_id: siteId,
                airport_code: airportCode,
                status: "online",
                uptime_seconds: Math.floor(process.uptime()),
                timestamp: now
            };

            // publishMessage(messagePattern, messageName, payload, options)
            publishMessage('EVENT', 'branch.heartbeat.sent', payload, {
                requestType: 'branch.heartbeat.sent'
            });
            
        } catch (e) {
            console.error('[Heartbeat] Failed to send heartbeat:', e.message);
        }
    };

    setTimeout(sendHeartbeat, 5000); // 5s delay on startup to ensure EMS is connected
    setInterval(sendHeartbeat, 60000); // Every 60 seconds
}

module.exports = {
    startHeartbeat
};
