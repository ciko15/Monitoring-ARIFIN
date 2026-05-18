/**
 * Equipment Service
 * Handles equipment data collection, parsing, and JSON database operations
 */

const ParserFactory = require('../parsers/factory');
const connectionManager = require('../connection/manager');
const { produceInternalMessage, AirNavServiceQueue } = require('../connection/ems');

class EquipmentService {
    constructor(db) {
        this.db = db;
        this.activeCollectors = new Map(); // equipment_id -> collector interval
        this.parsers = new Map(); // equipment_id -> parser instance
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

            // Fetch latest data logs - NEW
            const logsResult = await this.db.getEquipmentLogs({ equipmentId, limit: 20 });
            if (logsResult && logsResult.data && logsResult.data.length > 0) {
                // Build lastData as { [source_name]: data } — satu entry per source, ambil yang terbaru
                // Frontend (enhancements.js) mengakses eq.lastData[src.name]
                const lastDataMap = {};
                let latestUpdate = null;
                for (const log of logsResult.data) {
                    const srcName = log.source || 'default';
                    if (!lastDataMap[srcName]) {
                        lastDataMap[srcName] = {
                            ...log.data,
                            _logged_at:  log.logged_at,
                            _status:     log.status,
                            _parsing_id: log.connection_type,
                        };
                        if (!latestUpdate || log.logged_at > latestUpdate) {
                            latestUpdate = log.logged_at;
                        }
                    }
                }
                equipment.lastData  = lastDataMap;
                equipment.lastUpdate = latestUpdate;
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
            
            // Beritahu EMS agar UI terupdate meskipun alat sedang mati
            const equipment = await this.db.getEquipmentById(equipmentId);
            if (equipment) {
                const { publishByCategory } = require('../connection/ems');
                const category = equipment.category || 'Support';
                
                await publishByCategory(
                    category,
                    {
                        equipmentId,
                        equipment_name: equipment.name,
                        status: status,
                        message: error || (status === 'Normal' ? 'Connection healthy' : 'Device unreachable'),
                        logged_at: new Date().toISOString(),
                        source: 'WATCHDOG'
                    },
                    { requestType: 'STATUS_UPDATE' }
                ).catch(e => console.warn('[EMS] Failed to publish status update:', e.message));
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
            const airport = equipment ? await this.db.getAirportById(equipment.airportId) : null;
            const equipName = equipment ? equipment.name : 'Unknown';

            // 1. JSON-line file logging (data/YYYY-MM/DD/...)
            try {
                const fileLogger = require('../utils/fileLogger');
                await fileLogger.log(equipName, equipmentId, {
                    ...parsedData,
                    source: connectionType,
                    status,
                    _ip: parsedData._ip || (equipment ? equipment.ip || equipment.host : 'unknown')
                });
            } catch (err) {
                console.error('[EquipmentService] File logging error:', err);
            }

            // 2. Database logging (in-memory/JSON store)
            const datalog = {
                equipmentId,
                equipment_name: equipName,
                status,
                data: parsedData.data || {},
                source: parsedData.source || (parsedData._sources && parsedData._sources.length > 0 ? parsedData._sources[0].name : 'default'),
                connection_type: connectionType,
                airport_name: airport ? airport.name : 'Unknown',
                airport_city: airport ? airport.city : 'Unknown',
                logged_at: new Date().toISOString()
            };
            await this.db.createEquipmentLog(datalog);

            const { publishByCategory } = require('../connection/ems');
            const category = equipment ? equipment.category : 'Support';

            await publishByCategory(
                category,
                datalog,
                { requestType: 'SERVICE_LOG' }
            ).catch(e => console.warn('[EMS] Failed to publish log to category queue:', e.message));
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

            const { produceInternalMessage, AirNavServiceQueue } = require('../connection/ems');
            
            // Send to TOC queue as requested/default
            await produceInternalMessage(
                AirNavServiceQueue.TOC,
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
