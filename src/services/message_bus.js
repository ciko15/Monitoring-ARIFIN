const db = require('../../db/database');
const { publishMessage, publishCategorizedEvent, normalizeSiteId } = require('../connection/ems');

async function getBranchProfile() {
    try {
        return await db.readBranchProfile();
    } catch (_) {
        return {};
    }
}

async function getLocalSiteId() {
    const profile = await getBranchProfile();
    return normalizeSiteId(process.env.SITE_ID || process.env.AIRPORT_SITE_ID || profile.siteId || profile.airportCode || 'UNKNOWN');
}

async function getBranchServiceName() {
    const profile = await getBranchProfile();
    return process.env.MESSAGE_SERVICE_NAME || profile.services?.producer || 'MONITORING_ARIFIN_BRANCH';
}

async function getCentralServiceName() {
    const profile = await getBranchProfile();
    return process.env.CENTRAL_SERVICE_NAME || process.env.TARGET_SERVICE_NAME || profile.services?.target || 'EMS';
}

async function publishEquipmentTelemetry(datalog, equipment = {}, options = {}) {
    const payload = {
        equipment_id: datalog.equipmentId,
        equipment_name: datalog.equipment_name,
        category: equipment.category || null,
        airport_id: equipment.airportId || null,
        airport_name: datalog.airport_name || null,
        source: datalog.source,
        connection_type: datalog.connection_type,
        status: datalog.status,
        logged_at: datalog.logged_at,
        data: datalog.data || {}
    };

    return publishCategorizedEvent(
        equipment.category || 'Support',
        'equipment.telemetry.received',
        payload,
        {
            producerService: options.producerService || await getBranchServiceName(),
            producerSiteId: options.producerSiteId || await getLocalSiteId(),
            targetService: options.targetService || await getCentralServiceName(),
            targetSiteId: options.targetSiteId || 'PUSAT',
            occurredAt: datalog.logged_at,
            correlationId: options.correlationId,
            eventType: 'telemetry',
            domain: 'equipment',
            equipmentId: datalog.equipmentId,
            equipmentName: datalog.equipment_name,
            sourceName: datalog.source
        }
    );
}

async function publishEquipmentStatusChanged(equipment = {}, status, error = null, options = {}) {
    return publishCategorizedEvent(
        equipment.category || 'Support',
        'equipment.status.changed',
        {
            equipment_id: equipment.id,
            equipment_name: equipment.name,
            category: equipment.category || null,
            airport_id: equipment.airportId || null,
            status,
            message: error || null,
            changed_at: options.changedAt || new Date().toISOString()
        },
        {
            producerService: options.producerService || await getBranchServiceName(),
            producerSiteId: options.producerSiteId || await getLocalSiteId(),
            targetService: options.targetService || await getCentralServiceName(),
            targetSiteId: options.targetSiteId || 'PUSAT',
            occurredAt: options.changedAt,
            correlationId: options.correlationId,
            eventType: 'status',
            domain: 'equipment',
            equipmentId: equipment.id,
            equipmentName: equipment.name
        }
    );
}

async function publishThresholdApplyCommand(command = {}) {
    const targetSiteId = command.targetSiteId || await getLocalSiteId();

    return publishMessage(
        'COMMAND',
        'configuration.threshold.apply',
        {
            equipment_id: command.equipmentId,
            threshold: command.threshold || {},
            requested_by: command.requestedBy || 'api',
            notes: command.notes || null
        },
        {
            producerService: command.producerService || await getCentralServiceName(),
            producerSiteId: command.producerSiteId || 'PUSAT',
            targetService: command.targetService || await getBranchServiceName(),
            targetSiteId,
            correlationId: command.correlationId
        }
    );
}

async function publishThresholdResult(messageName, result = {}) {
    return publishMessage(
        'EVENT',
        messageName,
        {
            equipment_id: result.equipmentId,
            threshold_id: result.thresholdId || null,
            threshold: result.threshold || null,
            result: result.result || 'processed',
            reason: result.reason || null,
            processed_at: result.processedAt || new Date().toISOString()
        },
        {
            producerService: result.producerService || await getBranchServiceName(),
            producerSiteId: result.producerSiteId || await getLocalSiteId(),
            targetService: result.targetService || await getCentralServiceName(),
            targetSiteId: result.targetSiteId || 'PUSAT',
            occurredAt: result.processedAt,
            correlationId: result.correlationId
        }
    );
}

async function publishEquipmentSnapshotRequested(request = {}) {
    const targetSiteId = request.targetSiteId || await getLocalSiteId();

    return publishMessage(
        'REQUEST',
        'equipment.snapshot.requested',
        {
            equipment_id: request.equipmentId,
            source_name: request.sourceName || null,
            requested_by: request.requestedBy || 'api'
        },
        {
            producerService: request.producerService || await getCentralServiceName(),
            producerSiteId: request.producerSiteId || 'PUSAT',
            targetService: request.targetService || await getBranchServiceName(),
            targetSiteId,
            correlationId: request.correlationId
        }
    );
}

async function buildEquipmentSnapshot(equipmentId) {
    const equipment = await db.getEquipmentById(equipmentId);
    if (!equipment) return null;

    const airport = await db.getAirportById(equipment.airportId);
    const sources = await db.getOtenticationByEquipment(equipmentId);
    const thresholds = await db.getThresholdsByEquipment(equipmentId);
    const recentLogs = await db.getEquipmentLogs({ equipmentId, limit: 20 });

    return {
        snapshot_at: new Date().toISOString(),
        equipment: {
            id: equipment.id,
            code: equipment.code || null,
            name: equipment.name,
            category: equipment.category || null,
            status: equipment.status || null,
            airport_id: equipment.airportId || null,
            airport_name: airport?.name || null,
            is_active: equipment.isActive
        },
        sources: sources.map(source => ({
            id: source.id,
            name: source.name,
            ip_address: source.ip_address || null,
            tcp_port: source.tcp_port || null,
            udp_port: source.udp_port || null,
            parsing_id: source.parsing_id || null,
            latest_data: equipment.lastData?.[source.name] || null
        })),
        thresholds,
        recent_logs: recentLogs.data || []
    };
}

async function buildConfigurationSnapshot() {
    const [branchProfile, airport, equipmentResult, sources, parsers, limitations] = await Promise.all([
        db.readBranchProfile(),
        db.readAirportConfig(),
        db.getAllEquipment({ limit: 10000, isActive: 'all' }),
        db.getAllOtentication(),
        db.getAllParsingConfigs(),
        db.getAllLimitations()
    ]);

    return {
        snapshot_at: new Date().toISOString(),
        branch_profile: branchProfile,
        airport,
        equipment: equipmentResult.data || equipmentResult || [],
        sources,
        parsers,
        limitations
    };
}

async function publishEquipmentSnapshotResponded(response = {}) {
    return publishMessage(
        'RESPONSE',
        'equipment.snapshot.responded',
        {
            equipment_id: response.equipmentId,
            snapshot: response.snapshot
        },
        {
            producerService: response.producerService || await getBranchServiceName(),
            producerSiteId: response.producerSiteId || await getLocalSiteId(),
            targetService: response.targetService || await getCentralServiceName(),
            targetSiteId: response.targetSiteId || 'PUSAT',
            occurredAt: response.snapshot?.snapshot_at,
            correlationId: response.correlationId
        }
    );
}

async function publishConfigurationSnapshotResponded(response = {}) {
    return publishMessage(
        'RESPONSE',
        'configuration.snapshot.responded',
        {
            snapshot: response.snapshot
        },
        {
            producerService: response.producerService || await getBranchServiceName(),
            producerSiteId: response.producerSiteId || await getLocalSiteId(),
            targetService: response.targetService || await getCentralServiceName(),
            targetSiteId: response.targetSiteId || 'PUSAT',
            occurredAt: response.snapshot?.snapshot_at,
            correlationId: response.correlationId
        }
    );
}

async function publishBranchHealthResponded(response = {}) {
    return publishMessage(
        'RESPONSE',
        'branch.health.responded',
        {
            health: response.health
        },
        {
            producerService: response.producerService || await getBranchServiceName(),
            producerSiteId: response.producerSiteId || await getLocalSiteId(),
            targetService: response.targetService || await getCentralServiceName(),
            targetSiteId: response.targetSiteId || 'PUSAT',
            occurredAt: response.health?.responded_at,
            correlationId: response.correlationId
        }
    );
}

async function publishCollectorRefreshResult(success, result = {}) {
    return publishMessage(
        'EVENT',
        success ? 'collector.refresh.completed' : 'collector.refresh.failed',
        {
            equipment_id: result.equipmentId || null,
            source_id: result.sourceId || null,
            source_name: result.sourceName || null,
            result: result.result || (success ? 'completed' : 'failed'),
            reason: result.reason || null,
            processed_at: result.processedAt || new Date().toISOString()
        },
        {
            producerService: result.producerService || await getBranchServiceName(),
            producerSiteId: result.producerSiteId || await getLocalSiteId(),
            targetService: result.targetService || await getCentralServiceName(),
            targetSiteId: result.targetSiteId || 'PUSAT',
            occurredAt: result.processedAt,
            correlationId: result.correlationId
        }
    );
}

module.exports = {
    getLocalSiteId,
    publishEquipmentTelemetry,
    publishEquipmentStatusChanged,
    publishThresholdApplyCommand,
    publishThresholdResult,
    publishEquipmentSnapshotRequested,
    publishEquipmentSnapshotResponded,
    publishConfigurationSnapshotResponded,
    publishBranchHealthResponded,
    publishCollectorRefreshResult,
    buildEquipmentSnapshot,
    buildConfigurationSnapshot
};
