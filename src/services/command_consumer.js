const db = require('../../db/database');
const { exec } = require('child_process');
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
        this.connection = null;
        this.receivers = [];
        this.siteId = null;
        this.isRunning = false;
        this._restartTimer = null;
        this._restartDelayMs = parseInt(process.env.EMS_RETRY_BACKOFF_MS || '', 10) || 30000;
        this._maxRestartDelayMs = parseInt(process.env.EMS_MAX_BACKOFF_MS || '', 10) || 300000;
    }

    async start() {
        console.log('[CMD] Aplikasi Cabang (Branch) HANYA bertugas mem-publish pesan ke broker.');
        console.log('[CMD] Consumer EMS/Solace DINONAKTIFKAN secara permanen sesuai instruksi.');
        this.isRunning = false;
        return;
    }

    stop() {
        this.isRunning = false;
        if (this._restartTimer) clearTimeout(this._restartTimer);
        this._restartTimer = null;
        if (this.receivers) {
            for (const r of this.receivers) {
                try { r.close(); } catch (_) {}
            }
        }
        this.receivers = [];
        this.connection = null;
    }

    async _initialize() {
        this.siteId = await getLocalSiteId();
        this.connection = await connect();
        
        this.receivers = [];
        const queues = this._getQueues();
        
        for (const queue of queues) {
            const receiver = await this.connection.createReceiver({
                source: { address: queue },
                credit_window: 10
            });
            
            receiver.on('message', (context) => this._onMessage(queue, context));
            this.receivers.push(receiver);
            console.log(`[CMD] Listening on ${queue} via AMQP 1.0`);
        }
        this._restartDelayMs = parseInt(process.env.EMS_RETRY_BACKOFF_MS || '', 10) || 30000;
    }

    _getQueues() {
        // Cabang HANYA mendengarkan antrean perintah khusus (Command) dari pusat
        // dan tidak boleh menarik antrean global telemetri (Q.COM, Q.SUR, dll)
        return [
            `CMD.SYSTEM.${this.siteId}`,
            `CMD.CONFIG.${this.siteId}`
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

    async _onMessage(queue, context) {
        if (!context || !context.message) return;

        try {
            let payload = context.message.body;
            if (Buffer.isBuffer(payload)) {
                payload = payload.toString('utf8');
            }
            const envelope = typeof payload === 'string' ? JSON.parse(payload) : payload;
            
            const header = envelope.header || {};
            const body = envelope.body || {};
            const targetSiteId = normalizeSiteId(header.target_site_id || this.siteId);

            const isTelemetry = header.message_name === 'equipment.telemetry.received' || header.message_name === 'equipment.status.changed';
            if (!isTelemetry && targetSiteId !== this.siteId) {
                console.log(`[CMD] Ignored ${header.message_name || 'unknown'} for target ${targetSiteId}`);
                context.delivery.accept();
                return;
            }

            await this._dispatch(queue, header, body);
            context.delivery.accept();
        } catch (error) {
            console.error(`[CMD] Failed processing message from ${queue}:`, error.message);
            if (context.delivery) {
                context.delivery.accept(); // Accept anyway to avoid poison messages looping
            }
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
            case 'system.restart_pc':
                await this._handleRestartPC(header, body);
                return;
            case 'system.restart_app':
                await this._handleRestartApp(header, body);
                return;
            case 'configuration.equipment.upsert':
                await this._handleEquipmentUpsert(header, body);
                return;
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

    async _verifySecurityToken(header) {
        const token = header.security_token;
        const expectedToken = process.env.SYSTEM_COMMAND_TOKEN || 'default-secure-token-123';
        if (token !== expectedToken) {
            console.warn('[CMD] Security token mismatch. Command rejected.');
            throw new Error('Unauthorized');
        }
    }

    async _handleRestartPC(header, body) {
        console.log('[CMD] Received system.restart_pc command');
        await this._verifySecurityToken(header);
        
        let command = 'shutdown /r /t 0'; // Windows
        if (process.platform === 'darwin' || process.platform === 'linux') {
            command = 'sudo reboot';
        }
        
        console.log(`[CMD] Executing PC restart: ${command}`);
        exec(command, (error, stdout, stderr) => {
            if (error) console.error(`[CMD] Restart PC error: ${error.message}`);
        });
    }

    async _handleRestartApp(header, body) {
        console.log('[CMD] Received system.restart_app command');
        await this._verifySecurityToken(header);
        
        console.log('[CMD] Executing App restart via PM2');
        exec('pm2 restart all', (error, stdout, stderr) => {
            if (error) console.error(`[CMD] Restart App error: ${error.message}`);
        });
    }

    async _handleEquipmentUpsert(header, body) {
        console.log('[CMD] Received configuration.equipment.upsert command');
        try {
            const equipmentData = body;
            const existing = await db.getEquipmentById(equipmentData.id);
            if (existing) {
                await db.updateEquipment(equipmentData.id, equipmentData);
                console.log(`[CMD] Updated equipment ${equipmentData.id}`);
            } else {
                await db.createEquipment(equipmentData);
                console.log(`[CMD] Created equipment ${equipmentData.id}`);
            }
        } catch (err) {
            console.error('[CMD] Equipment upsert failed:', err.message);
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
