const db = require('../../db/database');
const { connect, normalizeSiteId, isEmsEnabled } = require('../connection/ems');
const {
    getLocalSiteId,
    publishThresholdResult,
    publishEquipmentSnapshotResponded,
    publishConfigurationSnapshotResponded,
    publishBranchHealthResponded,
    publishCollectorRefreshResult,
    buildEquipmentSnapshot,
    buildConfigurationSnapshot
} = require('./message_bus');

class CommandConsumer {
    constructor(options = {}) {
        this.equipmentService = options.equipmentService;
        this.templateService = options.templateService;
        this.state = options.state || {};
        this.serviceRole = options.serviceRole || process.env.SERVICE_ROLE || 'all';
        this.pipelineMode = options.pipelineMode || process.env.PIPELINE_MODE || 'inline';
        this.channel = null;
        this.siteId = null;
        this.isRunning = false;
        this._restartTimer = null;
        this._restartDelayMs = parseInt(process.env.EMS_RETRY_BACKOFF_MS || '', 10) || 30000;
        this._maxRestartDelayMs = parseInt(process.env.EMS_MAX_BACKOFF_MS || '', 10) || 300000;
    }

    async start() {
        if (this.isRunning) return;
        if (!isEmsEnabled()) {
            console.log('[CMD] EMS command consumer disabled');
            return;
        }
        this.isRunning = true;
        await this._initialize().catch(error => {
            console.error('[CMD] Failed to start consumer:', error.message);
            this._scheduleRestart();
        });
    }

    stop() {
        this.isRunning = false;
        if (this._restartTimer) clearTimeout(this._restartTimer);
        this._restartTimer = null;
        if (this.channel) {
            try {
                this.channel.close();
            } catch (_) {}
        }
        this.channel = null;
    }

    async _initialize() {
        this.siteId = await getLocalSiteId();
        const ch = await connect();
        this.channel = ch;
        await ch.prefetch(10);

        const queues = this._getQueues();
        for (const queue of queues) {
            await ch.assertQueue(queue, { durable: true });
            await ch.consume(queue, msg => this._onMessage(queue, msg), { noAck: false });
            console.log(`[CMD] Listening on ${queue}`);
        }
        this._restartDelayMs = parseInt(process.env.EMS_RETRY_BACKOFF_MS || '', 10) || 30000;
    }

    _getQueues() {
        return [
            'Q.COM',
            'Q.NAV',
            'Q.SUR',
            'Q.DAT',
            'Q.SUP'
        ];
    }

    _scheduleRestart() {
        if (!this.isRunning || this._restartTimer) return;
        const jitterMs = Math.floor(Math.random() * 5000);
        const delayMs = this._restartDelayMs + jitterMs;
        this._restartTimer = setTimeout(async () => {
            this._restartTimer = null;
            await this._initialize().catch(error => {
                console.error('[CMD] Consumer restart failed:', error.message);
                this._restartDelayMs = Math.min(this._restartDelayMs * 2, this._maxRestartDelayMs);
                this._scheduleRestart();
            });
        }, delayMs);
    }

    async _onMessage(queue, msg) {
        if (!msg) return;

        try {
            const envelope = JSON.parse(msg.content.toString('utf8'));
            const header = envelope.header || {};
            const body = envelope.body || {};
            const targetSiteId = normalizeSiteId(header.target_site_id || this.siteId);

            const isTelemetry = header.message_name === 'equipment.telemetry.received' || header.message_name === 'equipment.status.changed';
            if (!isTelemetry && targetSiteId !== this.siteId) {
                console.log(`[CMD] Ignored ${header.message_name || 'unknown'} for target ${targetSiteId}`);
                this.channel.ack(msg);
                return;
            }

            await this._dispatch(queue, header, body);
            this.channel.ack(msg);
        } catch (error) {
            console.error(`[CMD] Failed processing message from ${queue}:`, error.message);
            this.channel.ack(msg);
        }
    }

    async _dispatch(queue, header, body) {
        const messageName = header.message_name || header.REQUEST_TYPE;
        const correlationId = header.correlation_id;
        const targetSiteId = header.target_site_id || this.siteId;

        if (messageName && (messageName === 'equipment.telemetry.received' || messageName === 'equipment.status.changed')) {
            if (body && (body.equipment_id || body.equipmentId)) {
                await db.createEquipmentLog({
                    equipmentId: body.equipment_id || body.equipmentId,
                    equipment_name: body.equipment_name || 'Unknown',
                    status: body.status,
                    data: body.data || body.telemetry || {},
                    source: body.source || 'RabbitMQ',
                    connection_type: body.connection_type || 'Unknown',
                    airport_name: body.airport_name || 'Unknown',
                    logged_at: body.logged_at || new Date().toISOString()
                });
            }
            return;
        }

        if (messageName && (messageName.includes('telemetry') || messageName.includes('status'))) {
            return;
        }

        switch (messageName) {
            case 'configuration.threshold.apply':
                await this._handleThresholdApply(body, correlationId, targetSiteId);
                return;
            case 'collector.refresh_source':
                await this._handleRefreshSource(body, correlationId, targetSiteId);
                return;
            case 'collector.reload_config':
                await this._handleReloadConfig(correlationId, targetSiteId);
                return;
            case 'system.sync_clock_check':
            case 'branch.health.requested':
                await this._handleBranchHealth(correlationId, targetSiteId);
                return;
            case 'equipment.snapshot.requested':
                await this._handleEquipmentSnapshot(body, correlationId, targetSiteId);
                return;
            case 'configuration.snapshot.requested':
                await this._handleConfigurationSnapshot(correlationId, targetSiteId);
                return;
            default:
                console.warn(`[CMD] Unsupported message ${messageName} from ${queue}`);
        }
    }

    async _handleThresholdApply(body, correlationId, targetSiteId) {
        const equipmentId = parseInt(body.equipment_id, 10);
        const threshold = body.threshold || {};

        try {
            let result;
            if (threshold.id) {
                result = await db.updateThreshold(threshold.id, threshold);
            } else {
                result = await db.createThreshold({
                    ...threshold,
                    equipment_id: equipmentId
                });
            }

            await publishThresholdResult('configuration.threshold.applied', {
                equipmentId,
                thresholdId: result?.id,
                threshold: result,
                result: threshold.id ? 'updated' : 'created',
                correlationId,
                targetSiteId
            });
        } catch (error) {
            await publishThresholdResult('configuration.threshold.failed', {
                equipmentId,
                threshold,
                result: 'apply_failed',
                reason: error.message,
                correlationId,
                targetSiteId
            });
        }
    }

    async _handleRefreshSource(body, correlationId, targetSiteId) {
        const equipmentId = parseInt(body.equipment_id, 10);

        try {
            const result = await this.equipmentService.collectFromEquipment(equipmentId);
            await publishCollectorRefreshResult(Boolean(result?.success), {
                equipmentId,
                result: result?.success ? 'refreshed' : 'refresh_failed',
                reason: result?.success ? null : (result?.error || 'Refresh failed'),
                correlationId,
                targetSiteId
            });
        } catch (error) {
            await publishCollectorRefreshResult(false, {
                equipmentId,
                result: 'refresh_failed',
                reason: error.message,
                correlationId,
                targetSiteId
            });
        }
    }

    async _handleReloadConfig(correlationId, targetSiteId) {
        try {
            if (this.templateService && this.state) {
                this.state.snmpTemplatesCache = await this.templateService.getAllTemplates();
            }
            await db.syncOtenticationSupCategory();

            await publishCollectorRefreshResult(true, {
                result: 'config_reloaded',
                correlationId,
                targetSiteId
            });
        } catch (error) {
            await publishCollectorRefreshResult(false, {
                result: 'config_reload_failed',
                reason: error.message,
                correlationId,
                targetSiteId
            });
        }
    }

    async _handleEquipmentSnapshot(body, correlationId, targetSiteId) {
        const equipmentId = parseInt(body.equipment_id, 10);
        const snapshot = await buildEquipmentSnapshot(equipmentId);

        if (!snapshot) {
            console.warn(`[CMD] Equipment snapshot not found for equipment ${equipmentId}`);
            return;
        }

        await publishEquipmentSnapshotResponded({
            equipmentId,
            snapshot,
            correlationId,
            targetSiteId
        });
    }

    async _handleConfigurationSnapshot(correlationId, targetSiteId) {
        const snapshot = await buildConfigurationSnapshot();
        await publishConfigurationSnapshotResponded({
            snapshot,
            correlationId,
            targetSiteId
        });
    }

    async _handleBranchHealth(correlationId, targetSiteId) {
        const [branchProfile, airport] = await Promise.all([
            db.readBranchProfile(),
            db.readAirportConfig()
        ]);

        const health = {
            site_id: this.siteId,
            service_role: this.serviceRole,
            pipeline_mode: this.pipelineMode,
            status: 'ok',
            uptime_seconds: Math.round(process.uptime()),
            memory: process.memoryUsage(),
            branch_profile: branchProfile,
            airport: {
                id: airport.id,
                code: airport.code || airport.siteId || null,
                name: airport.name,
                ipBranch: airport.ipBranch
            },
            responded_at: new Date().toISOString()
        };

        await publishBranchHealthResponded({
            health,
            correlationId,
            targetSiteId
        });
    }
}

module.exports = CommandConsumer;
