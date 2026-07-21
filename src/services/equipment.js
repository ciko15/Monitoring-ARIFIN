/**
 * Equipment Service
 * Handles equipment data collection, parsing, and JSON database operations
 */

const ParserFactory = require('../parsers/factory');
const connectionManager = require('../connection/manager');
const { produceInternalMessage } = require('../connection/ems');
const {
    publishEquipmentTelemetry,
    publishEquipmentStatusChanged
} = require('./message_bus');
const { SourceStatusGate } = require('./source_status_gate');

class EquipmentService {
    constructor(db) {
        this.db = db;
        this.activeCollectors = new Map(); // equipment_id -> collector interval
        this.parsers = new Map(); // equipment_id -> parser instance
        this.statusGate = new SourceStatusGate();
    }

    _publishAsync(label, producer) {
        Promise.resolve()
            .then(producer)
            .catch(error => {
                const key = `ems-publish:${label}:${error.code || error.message}`;
                if (this.statusGate.shouldLog(key)) {
                    console.warn(`[EMS] ${label} publish skipped/failed: ${error.message}`);
                }
            });
    }

    /**
     * Get equipment with connection config and resolved template
     * @param {number} equipmentId - Equipment ID
     * @returns {Promise<Object|null>} Equipment data
     */
    async getEquipmentWithConfig(equipmentId) {
        try {
            const equipment = await this.db.getEquipmentById(equipmentId);
            if (!equipment || !equipment.isActive) return null;

            // Resolve Airport
            const airport = await this.db.getAirportById(equipment.airportId);
            equipment.airport = airport;

            // Resolve Components (IPs) - NEW
            equipment.components = await this.db.getOtenticationByEquipment(equipmentId);

            // Resolve Limitations - NEW
            equipment.limitations = await this.db.getLimitationsByEquipment(equipmentId);

            // Resolve Connection & Template
            if (equipment.templateId) {
                const config = await this.db.getParsingConfigById(equipment.templateId);
                if (config) {
                    equipment.template_name = config.name;
                    equipment.parser_file = config.files;
                }
            }


            // Legacy field mapping for compatibility
            equipment.host = equipment.ip || equipment.snmpIP || equipment.host || (equipment.components && equipment.components.length > 0 ? equipment.components[0].ip_address : null);
            equipment.port = equipment.port || 161;

            return equipment;
        } catch (error) {
            console.error('[EquipmentService] Error getting equipment:', error);
            return null;
        }
    }

    /**
     * Get all active equipment with connection config
     * @returns {Promise<Array>} Equipment list
     */
    async getAllActiveEquipment() {
        try {
            const equipmentResult = await this.db.getAllEquipment();
            
            // Defensif: Pastikan equipmentResult tidak null/undefined
            if (!equipmentResult) {
                console.warn('[EquipmentService] No result from getAllEquipment');
                return [];
            }

            // Ambil data array (handle paginated object atau array langsung)
            const equipmentList = equipmentResult.data || (Array.isArray(equipmentResult) ? equipmentResult : []);
            
            if (!Array.isArray(equipmentList)) {
                console.error('[EquipmentService] Equipment list is not an array:', typeof equipmentList);
                return [];
            }

            const activeList = equipmentList.filter(e => e.isActive);
            
            // Resolve config for each
            const resolvedList = [];
            for (const e of activeList) {
                const resolved = await this.getEquipmentWithConfig(e.id);
                if (resolved) resolvedList.push(resolved);
            }
            
            return resolvedList;
        } catch (error) {
            console.error('[EquipmentService] Error getting active equipment:', error);
            return [];
        }
    }

    /**
     * Get equipment templates
     * @param {string} equipmentType - Equipment type filter
     * @returns {Promise<Array>} Template list
     */
    async getTemplates(equipmentType = null) {
        try {
            const templates = await this.db.getAllParsingConfigs();
            if (equipmentType) {
                return templates.filter(t => t.category === equipmentType);
            }
            return templates;
        } catch (error) {
            console.error('[EquipmentService] Error getting templates:', error);
            return [];
        }
    }

    /**
     * Get sub categories
     */
    async getSubCategories(category) {
        return await this.db.getSupCategoriesByCategory(category);
    }

    /**
     * Create parser for equipment
     * @param {Object} equipment - Equipment with connection config
     * @returns {Object|null} Parser instance
     */
    createParser(equipment) {
        if (!equipment.connection_type && !equipment.protocol) {
            console.warn(`[EquipmentService] No connection type for equipment ${equipment.id}`);
            return null;
        }

        try {
            const config = {
                ...equipment,
                parser_config: equipment.parser_config || []
            };

            return ParserFactory.createParser(equipment.connection_type || equipment.protocol, config);
        } catch (error) {
            console.error(`[EquipmentService] Error creating parser:`, error);
            return null;
        }
    }

    /**
     * Collect data from single equipment
     */
    async collectFromEquipment(equipmentId) {
        const equipment = await this.getEquipmentWithConfig(equipmentId);
        
        if (!equipment) {
            return { success: false, error: 'Equipment not found or inactive' };
        }

        const host = equipment.ip || equipment.host;
        const port = equipment.port || 161;

        if (!host) {
            return { success: false, error: 'No IP/Host configured' };
        }

        try {
            // Gateway-First Authentication
            if (equipment.airport && equipment.airport.ipBranch && !equipment.bypassGateway) {
                const gwTest = await connectionManager.testConnection(equipment.airport.ipBranch, 80, 2000);
                if (!gwTest.success) {
                    await this.updateEquipmentStatus(equipmentId, 'Disconnect', `Gateway ${equipment.airport.ipBranch} unreachable`);
                    return { success: false, error: `Gateway unreachable`, tier: 'gateway' };
                }
            }

            // Test direct equipment connection (Ping/Port test)
            const connTest = await connectionManager.testConnection(host, port);
            
            if (!connTest.success) {
                await this.updateEquipmentStatus(equipmentId, 'Disconnect', connTest.message);
                return { success: false, error: connTest.message, connectionStatus: 'Disconnect' };
            }

            // Update status to connected
            await this.updateEquipmentStatus(equipmentId, 'Normal', null, 'Connected');

            // TODO: Actual SNMP polling would happen here using the resolved template
            
            return {
                success: true,
                connectionStatus: 'Connected',
                responseTime: connTest.responseTime,
                equipmentId
            };

        } catch (error) {
            console.error(`[EquipmentService] Collection error:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update equipment status and publish to EMS
     */
    async updateEquipmentStatus(equipmentId, status, error = null, connectionStatus = 'Disconnect') {
        try {
            await this.db.updateEquipmentStatus(equipmentId, status);
            
            const equipment = await this.db.getEquipmentById(equipmentId);
            if (equipment) {
                this._publishAsync('equipment.status.changed', () => publishEquipmentStatusChanged(
                    equipment,
                    status,
                    error,
                    { changedAt: new Date().toISOString() }
                ));
            }
        } catch (error) {
            console.error('[EquipmentService] Error updating status:', error);
        }
    }

    /**
     * Save parsed data to logs
     */
    async saveToLogs(equipmentId, parsedData, connectionType = 'system', status = 'Normal') {
        try {
            const equipment = await this.db.getEquipmentById(equipmentId);
            if (!equipment) {
                console.warn(`[EquipmentService] Skipping log save: equipment ${equipmentId} not found`);
                return;
            }

            const airport = equipment ? await this.db.getAirportById(equipment.airportId) : null;
            const equipName = equipment.name;
            const sourceName = parsedData.source || (parsedData._sources && parsedData._sources.length > 0 ? parsedData._sources[0].name : 'default');
            const gateDecision = this.statusGate.evaluate(
                {
                    id: `${equipmentId}:${sourceName}`,
                    equipt_id: equipmentId,
                    name: sourceName
                },
                status,
                {
                    confirmDisconnect: false,
                    connectionType
                }
            );

            if (!gateDecision.shouldEmit) {
                return;
            }

            const finalStatus = gateDecision.status;

            // --- GLOBAL TELEMETRY MERGER & DEBOUNCER ---
            if (!this.telemetryCache) {
                this.telemetryCache = new Map();
            }

            const cacheKey = `${equipmentId}:${sourceName}`;
            let cache = this.telemetryCache.get(cacheKey);
            if (!cache) {
                cache = {
                    mergedData: {},
                    timer: null,
                    lastPublishedString: null
                };
                this.telemetryCache.set(cacheKey, cache);
            }

            // Jika alat Disconnect/Kosong, bersihkan cache agar frontend tahu data benar-benar hilang
            if (finalStatus === 'Disconnect' || finalStatus === 'Error') {
                cache.mergedData = {};
            } else {
                // Merge data baru ke data lama (Saling Mengisi)
                cache.mergedData = { ...cache.mergedData, ...(parsedData.data || {}) };
            }

            // Reset timer (Tunggu 1 detik untuk mengumpulkan sisa potongan data)
            // BUGFIX: Gunakan Throttle (jangan reset timer jika sudah jalan) agar data yang mengalir deras tidak menahan timer selamanya!
            if (!cache.timer) {
                cache.timer = setTimeout(async () => {
                    cache.timer = null;

                    // 2. Database logging & Publish
                    const datalog = {
                        equipmentId,
                        equipment_name: equipName,
                        status: finalStatus,
                        data: { ...cache.mergedData },
                        source: sourceName,
                        connection_type: connectionType,
                        airport_name: airport ? airport.name : 'Unknown',
                        airport_city: airport ? airport.city : 'Unknown',
                        logged_at: new Date().toISOString()
                    };

                    await this.db.createEquipmentLog(datalog);
                    this._publishAsync('equipment.telemetry.received', () => publishEquipmentTelemetry(datalog, equipment));
                    
                }, 1000); // 1000ms throttle
            }
            
        } catch (error) {
            console.error('[EquipmentService] Error saving to logs:', error);
        }
    }

    /**
     * Send all equipment grouped by category to EMS
     */
    async sendEquipmentListToEms() {
        try {
            const equipmentResult = await this.db.getAllEquipment();
            const equipmentList = equipmentResult.data || (Array.isArray(equipmentResult) ? equipmentResult : []);
            
            const grouped = {
                Communication: [],
                Navigation: [],
                Surveillance: [],
                'Data Processing': [],
                Support: []
            };

            for (const item of equipmentList) {
                const cat = item.category || 'Support';
                const dataToPush = {
                    id: item.id,
                    name: item.name,
                    status: item.status,
                    airportId: item.airportId,
                    isActive: item.isActive
                };

                if (grouped[cat]) {
                    grouped[cat].push(dataToPush);
                } else {
                    if (!grouped['Support']) grouped['Support'] = [];
                    grouped['Support'].push(dataToPush);
                }
            }

            const { produceInternalMessage } = require('../connection/ems');
            
            // Send to Q.SUP queue
            await produceInternalMessage(
                'Q.SUP',
                { REQUEST_TYPE: 'EQUIPMENT_LIST' },
                grouped
            );
            
            console.log('[EquipmentService] Sent grouped equipment list to EMS');
            return { success: true, data: grouped };
        } catch (error) {
            console.error('[EquipmentService] Error sending equipment list to EMS:', error);
            return { success: false, error: error.message };
        }
    }

    // --- REUSE OLD HELPERS ---
    computeParsedChanges(previous = {}, current = {}) {
        const changes = {};
        const keys = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
        for (const key of keys) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) {
                changes[key] = { old: previous[key], new: current[key] };
            }
        }
        return changes;
    }

    startCollector(equipmentId, intervalMs = 60000) {
        this.stopCollector(equipmentId);
        const intervalId = setInterval(async () => {
            await this.collectFromEquipment(equipmentId);
        }, intervalMs);
        this.activeCollectors.set(equipmentId, intervalId);
    }

    stopCollector(equipmentId) {
        const intervalId = this.activeCollectors.get(equipmentId);
        if (intervalId) {
            clearInterval(intervalId);
            this.activeCollectors.delete(equipmentId);
        }
    }
}

module.exports = EquipmentService;
