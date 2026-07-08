/**
 * Parser Factory
 * Creates appropriate parser instances based on connection type
 */

const RcmsParser = require('./rcms');
const DvorMaru220Parser = require('./dvor_maru_220');
const DmeMaru310320Parser = require('./dme_maru_310_320');
const AsterixParser = require('./asterix_parser');
const SnmpHostResourcesParser = require('./snmp_host_resources');
const VhfT6tvParser = require('./vhf_t6tv');
const Pm5560ModbusParser = require('./pm5560_modbus');
const VhfMarcRseParser = require('./vhf_marc_rse');
const TempHumidityParser = require('./temp_humidity_modbus');
const IlsGpThales421Parser = require('./ils_gp_thales421');
const IlsLlzThales421Parser = require('./ils_llz_thales421');
const IlsGpNormacParser = require('./ils_gp_normac');

class ParserFactory {
    /**
     * Create parser instance based on connection type
     * @param {string} connectionType - Type of connection (rcms, asterix, snmp, json)
     * @param {Object} config - Parser configuration from database
     * @returns {BaseParser|null} Parser instance or null if type not supported
     */
    static createParser(connectionType, config) {
        // --- Custom Parser ID Resolution ---
        let moduleName = connectionType?.toLowerCase();
        if (moduleName && moduleName.startsWith('custom_')) {
            try {
                const fs = require('fs');
                const path = require('path');
                const configs = JSON.parse(fs.readFileSync(path.join(__dirname, '../../db/equipment_parsing_config.json'), 'utf8'));
                const custom = configs.find(c => c.id === moduleName);
                if (custom && custom.files) {
                    const basename = path.basename(custom.files, '.js');
                    if (basename === 'factory' || basename === 'base' || !basename) {
                        const nameLower = (custom.name || '').toLowerCase();
                        if (nameLower.includes('vhf')) moduleName = 'vhf_t6tv';
                        else if (nameLower.includes('glide') || nameLower.includes('gp')) moduleName = 'ils_gp_normac';
                        else if (nameLower.includes('localizer') || nameLower.includes('llz')) moduleName = 'ils_llz_normac';
                    } else {
                        moduleName = basename;
                    }
                }
            } catch(e) {
                console.warn(`[ParserFactory] Error resolving custom parser ${moduleName}:`, e.message);
            }
        }

        // --- SECURE DYNAMIC LOADING LOGIC ---
        // If a specific parser file is defined, try to load it safely from the same directory
        const parserFile = config.parser_file || config.files;
        if (parserFile && !moduleName.startsWith('custom_')) {
            try {
                const path = require('path');
                // Security: Prevent path traversal by only taking the basename
                const safeFileName = path.basename(parserFile);
                
                // Only allow .js files
                if (!safeFileName.endsWith('.js')) {
                    throw new Error('Only .js parser files are allowed');
                }

                const absolutePath = path.resolve(__dirname, safeFileName);
                
                // Verify file exists before requiring
                const fs = require('fs');
                if (fs.existsSync(absolutePath)) {
                    const DynamicParser = require(absolutePath);
                    console.log(`[ParserFactory] Securely loaded parser: ${safeFileName}`);
                    return new DynamicParser(config);
                } else {
                    console.warn(`[ParserFactory] Dynamic parser file not found: ${safeFileName}`);
                }
            } catch (err) {
                console.error(`[ParserFactory] Failed to load dynamic parser safely:`, err.message);
                // Fallback to static switch
            }
        }

        // --- STATIC FALLBACK ---
        switch (moduleName) {
            case 'rcms':
                return new RcmsParser(config);
            
            case 'vhf_t6tv':
                return new VhfT6tvParser(config);

            case 'dvor_maru_220':
                return new DvorMaru220Parser(config);
                
            case 'dme_maru_310_320':
                return new DmeMaru310320Parser(config);
            
            case 'asterix':
                return new AsterixParser(config);
            
            case 'snmp':
                console.warn('[ParserFactory] SNMP uses SNMP service, not parser');
                return null;
            
            case 'snmp_host_resources_01':
                return SnmpHostResourcesParser;
            
            case 'temp_humidity_modbus':
                return new TempHumidityParser(config);

            case 'vhf_marc_rse':
                return new VhfMarcRseParser(config);

            case 'pm5560_modbus':
                return new Pm5560ModbusParser(config);

            case 'ils_gp_thales421':
                return new IlsGpThales421Parser(config);

            case 'ils_llz_thales421':
                return new IlsLlzThales421Parser(config);

            case 'ils_gp_normac':
            case 'ils_gp_normac7030':
            case 'custom_1783483057654':
                return new IlsGpNormacParser(config);

            case 'json':
                return new JsonParser(config);
            
            case 'tcp':
            case 'udp':
                return new RcmsParser(config);
            
            default:
                console.warn(`[ParserFactory] Unknown connection type: ${connectionType}`);
                return null;
        }
    }

    /**
     * Get available parser types
     * @returns {Array} List of supported parser types
     */
    static getSupportedTypes() {
        return [
            'rcms',
            'asterix',
            'snmp',
            'json',
            'tcp',
            'udp',
            'dvor_maru_220',
            'dme_maru_310_320',
            'pm5560_modbus',
            'temp_humidity_modbus',
            'ils_gp_thales421',
            'ils_llz_thales421',
            'ils_gp_normac',
            'ils_gp_normac7030',
            'custom_1783483057654',
            'vhf_t6tv',
            'vhf_marc_rse'
        ];
    }
}

/**
 * Simple JSON Parser for API-based equipment
 */
class JsonParser {
    constructor(config) {
        this.config = config;
        this.parserConfig = config.parser_config || {};
        this.mappings = this.parserConfig.mappings || [];
        this.alarmRules = this.parserConfig.alarm_rules || [];
    }

    /**
     * Parse JSON data
     * @param {string|Object} rawData - Raw JSON data
     * @returns {Object} Parsed data
     */
    parse(rawData) {
        try {
            let dataObj;
            
            if (typeof rawData === 'string') {
                const trimmed = rawData.trim();

                // Try parsing raw string as JSON
                try {
                    dataObj = JSON.parse(trimmed);
                } catch (err) {
                    // If data includes extra text around JSON (logs, headers), try to extract the JSON substring
                    const jsonMatch = trimmed.match(/(\{[\s\S]*\})/);
                    if (jsonMatch) {
                        dataObj = JSON.parse(jsonMatch[1]);
                    } else {
                        throw err;
                    }
                }
            } else if (typeof rawData === 'object' && rawData !== null) {
                dataObj = rawData;
            } else {
                throw new Error('Invalid JSON data');
            }

            // Extract fields based on mappings
            const parsed = {};
            
            for (const mapping of this.mappings) {
                const value = this.getNestedValue(dataObj, mapping.json_path || mapping.name);
                if (value !== undefined && value !== null) {
                    let finalValue = value;
                    
                    // Apply divisor if specified
                    if (mapping.divisor && !isNaN(value)) {
                        finalValue = parseFloat((value / mapping.divisor).toFixed(2));
                    }
                    
                    parsed[mapping.name] = finalValue;
                    
                    if (mapping.unit) {
                        parsed[`${mapping.name}_unit`] = mapping.unit;
                    }
                }
            }

            // If no mappings, use all data
            if (this.mappings.length === 0) {
                Object.assign(parsed, dataObj);
            }

            // Check alarms
            const alarmResult = this.checkAlarms(parsed);

            return {
                success: true,
                data: parsed,
                status: alarmResult.status,
                alarms: alarmResult.alarms,
                warnings: alarmResult.warnings,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                status: 'Error',
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * Get nested value from object using dot notation
     * @param {Object} obj - Source object
     * @param {string} path - Dot notation path
     * @returns {*} Value at path
     */
    getNestedValue(obj, path) {
        if (!path) return undefined;

        const parts = path.split('.');
        let current = obj;

        for (const part of parts) {
            if (current === undefined || current === null) return current;

            // Support basic array indexing syntax like `items[0].value`
            const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
            if (arrayMatch) {
                const key = arrayMatch[1];
                const index = parseInt(arrayMatch[2], 10);
                current = current[key];
                if (Array.isArray(current)) {
                    current = current[index];
                } else {
                    return undefined;
                }
            } else {
                current = current[part];
            }
        }

        return current;
    }

    /**
     * Check alarm rules
     * @param {Object} parsedData - Parsed data
     * @returns {Object} Alarm result
     */
    checkAlarms(parsedData) {
        const alarms = [];
        const warnings = [];

        for (const rule of this.alarmRules) {
            const value = parsedData[rule.parameter];
            if (value === undefined) continue;

            let triggered = false;
            switch (rule.operator) {
                case 'lt': triggered = value < rule.value; break;
                case 'gt': triggered = value > rule.value; break;
                case 'eq': triggered = value === rule.value; break;
                case 'ne': triggered = value !== rule.value; break;
            }

            if (triggered) {
                const info = {
                    parameter: rule.parameter,
                    value,
                    threshold: rule.value,
                    message: rule.message
                };
                
                if (rule.severity === 'alarm') {
                    alarms.push(info);
                } else {
                    warnings.push(info);
                }
            }
        }

        return {
            alarms,
            warnings,
            status: alarms.length > 0 ? 'Alarm' : warnings.length > 0 ? 'Warning' : 'Normal'
        };
    }
}

module.exports = ParserFactory;
