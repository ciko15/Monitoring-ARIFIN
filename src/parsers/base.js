/**
 * Base Parser Class
 * Abstract base class for all protocol parsers (RCMS, ASTERIX, SNMP, etc.)
 */

class BaseParser {
    constructor(config) {
        this.config = config;
        this.parserConfig = config.parser_config || {};
        this.mappings = this.parserConfig.mappings || [];
        this.alarmRules = this.parserConfig.alarm_rules || [];
        this.thresholdOverrides = config.threshold_overrides || {};
    }

    /**
     * Parse raw data - must be implemented by subclasses
     * @param {Buffer|string} rawData - Raw data from equipment
     * @returns {Object} Parsed data with status
     */
    parse(rawData) {
        throw new Error('parse() must be implemented by subclass');
    }

    /**
     * Extract field value from raw data based on mapping
     * @param {Buffer} data - Raw data buffer
     * @param {Object} mapping - Mapping configuration
     * @returns {*} Extracted value
     */
    extractField(data, mapping) {
        const { byte_offset, length, type, divisor } = mapping;
        
        if (!data || byte_offset === undefined) return null;

        try {
            let value;
            switch (type) {
                case 'uint16':
                    value = data.readUInt16BE(byte_offset);
                    break;
                case 'int16':
                    value = data.readInt16BE(byte_offset);
                    break;
                case 'uint8':
                    value = data.readUInt8(byte_offset);
                    break;
                case 'int8':
                    value = data.readInt8(byte_offset);
                    break;
                case 'float':
                    value = data.readFloatBE(byte_offset);
                    break;
                case 'ascii':
                case 'string':
                    value = data.toString('ascii', byte_offset, byte_offset + length).trim();
                    break;
                case 'hex':
                    value = data.slice(byte_offset, byte_offset + length).toString('hex').toUpperCase();
                    break;
                default:
                    value = null;
            }

            // Apply divisor if specified
            if (divisor && value !== null && !isNaN(value)) {
                value = parseFloat((value / divisor).toFixed(2));
            }

            return value;
        } catch (error) {
            console.error(`[Parser] Error extracting field: ${error.message}`);
            return null;
        }
    }

    /**
     * Check alarm rules against parsed data
     * @param {Object} parsedData - Parsed data object
     * @returns {Object} Alarms and warnings
     */
    checkAlarms(parsedData) {
        const alarms = [];
        const warnings = [];
        const triggeredParams = {};

        for (const rule of this.alarmRules) {
            const value = parsedData[rule.parameter];
            if (value === undefined || value === null) continue;

            let triggered = false;
            switch (rule.operator) {
                case 'lt':
                    triggered = value < rule.value;
                    break;
                case 'gt':
                    triggered = value > rule.value;
                    break;
                case 'eq':
                    triggered = value === rule.value;
                    break;
                case 'ne':
                    triggered = value !== rule.value;
                    break;
                case 'lte':
                    triggered = value <= rule.value;
                    break;
                case 'gte':
                    triggered = value >= rule.value;
                    break;
            }

            if (triggered) {
                const alarmInfo = {
                    parameter: rule.parameter,
                    value: value,
                    threshold: rule.value,
                    operator: rule.operator,
                    message: rule.message || `${rule.parameter} ${rule.operator} ${rule.value}`
                };

                if (rule.severity === 'alarm') {
                    alarms.push(alarmInfo);
                } else {
                    warnings.push(alarmInfo);
                }

                triggeredParams[rule.parameter] = rule.severity;
            }
        }

        return {
            alarms,
            warnings,
            triggeredParams,
            status: alarms.length > 0 ? 'Alarm' : 
                    warnings.length > 0 ? 'Warning' : 'Normal'
        };
    }

    /**
     * Get status based on alarms and warnings
     * @param {Array} alarms - Array of alarms
     * @param {Array} warnings - Array of warnings
     * @returns {string} Status string
     */
    getStatus(alarms, warnings) {
        if (alarms && alarms.length > 0) return 'Alarm';
        if (warnings && warnings.length > 0) return 'Warning';
        return 'Normal';
    }

    /**
     * Apply threshold overrides
     * @param {Object} parsedData - Parsed data
     * @returns {Object} Data with overrides applied
     */
    applyThresholdOverrides(parsedData) {
        const result = { ...parsedData };
        
        for (const [key, override] of Object.entries(this.thresholdOverrides)) {
            if (result[key] !== undefined) {
                result[`${key}_original`] = result[key];
                if (override.min !== undefined) {
                    result[key] = Math.max(result[key], override.min);
                }
                if (override.max !== undefined) {
                    result[key] = Math.min(result[key], override.max);
                }
            }
        }
        
        return result;
    }
}

module.exports = BaseParser;
