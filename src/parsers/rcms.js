/**
 * RCMS Protocol Parser
 * Parses RCMS (Remote Control and Monitoring System) data from DME/DVOR equipment
 * Supports hex ASCII format commonly used in aviation navigation equipment
 */

const BaseParser = require('./base');

class RcmsParser extends BaseParser {
    constructor(config) {
        super(config);
        this.frameHeader = this.parserConfig.frame_header || { soh: '01', stx: '02', etx: '03' };
        this.format = this.parserConfig.format || 'binary'; // binary or hex_ascii
    }

    /**
     * Parse RCMS data
     * @param {Buffer|string} rawData - Raw data from equipment
     * @returns {Object} Parsed data with status
     */
    parse(rawData) {
        try {
            let dataBuffer;
            
            // Convert to buffer if string
            if (typeof rawData === 'string') {
                // Remove whitespace and newlines
                const cleanData = rawData.replace(/[\s\n\r]/g, '');
                
                // If it's hex string, convert to buffer
                if (/^[0-9A-Fa-f]+$/.test(cleanData)) {
                    dataBuffer = Buffer.from(cleanData, 'hex');
                } else {
                    dataBuffer = Buffer.from(rawData);
                }
            } else if (Buffer.isBuffer(rawData)) {
                dataBuffer = rawData;
            } else {
                throw new Error('Invalid raw data type');
            }

            // Parse based on format
            let parsed = {};
            
            if (this.format === 'hex_ascii') {
                parsed = this.parseHexAscii(dataBuffer);
            } else {
                parsed = this.parseBinary(dataBuffer);
            }

            // Check alarms
            const alarmResult = this.checkAlarms(parsed);
            
            // Apply threshold overrides
            const finalData = this.applyThresholdOverrides(parsed);

            return {
                success: true,
                data: finalData,
                status: alarmResult.status,
                alarms: alarmResult.alarms,
                warnings: alarmResult.warnings,
                triggeredParams: alarmResult.triggeredParams,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error(`[RCMS Parser] Parse error: ${error.message}`);
            return {
                success: false,
                error: error.message,
                status: 'Error',
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * Parse hex ASCII format (commonly used in RCMS)
     * @param {Buffer} dataBuffer - Raw data buffer
     * @returns {Object} Parsed data
     */
    parseHexAscii(dataBuffer) {
        const parsed = {};
        const dataStr = dataBuffer.toString('ascii');
        
        // Try to extract parameters based on known patterns
        // RCMS typically sends data in format like: PARAM=VALUE;
        
        // For binary format with byte offsets
        for (const mapping of this.mappings) {
            const value = this.extractField(dataBuffer, mapping);
            if (value !== null) {
                parsed[mapping.name] = value;
                
                // Add label if available
                if (mapping.label) {
                    parsed[`${mapping.name}_label`] = mapping.label;
                }
                
                // Add unit if available
                if (mapping.unit) {
                    parsed[`${mapping.name}_unit`] = mapping.unit;
                }
            }
        }

        return parsed;
    }

    /**
     * Parse binary format
     * @param {Buffer} dataBuffer - Raw data buffer
     * @returns {Object} Parsed data
     */
    parseBinary(dataBuffer) {
        const parsed = {};

        // Extract fields based on mappings
        for (const mapping of this.mappings) {
            const value = this.extractField(dataBuffer, mapping);
            if (value !== null) {
                parsed[mapping.name] = value;
                
                // Add unit if available
                if (mapping.unit) {
                    parsed[`${mapping.name}_unit`] = mapping.unit;
                }
            }
        }

        return parsed;
    }

    /**
     * Parse tag-based format (used by some DVOR equipment)
     * @param {Buffer|string} rawData - Raw data
     * @returns {Object} Parsed data
     */
    parseTagFormat(rawData) {
        const parsed = {};
        const tagMappings = this.parserConfig.tag_mappings || {};
        
        // Data comes as: TAG=VALUE;TAG=VALUE;
        const dataStr = typeof rawData === 'string' ? rawData : rawData.toString('ascii');
        const pairs = dataStr.split(';').filter(p => p.trim());
        
        for (const pair of pairs) {
            const [tag, ...valueParts] = pair.split('=');
            if (!tag || valueParts.length === 0) continue;
            
            const value = valueParts.join('=').trim();
            
            // Find mapping for this tag
            for (const [tagGroup, config] of Object.entries(tagMappings)) {
                const params = config.params || {};
                
                for (const [paramKey, paramConfig] of Object.entries(params)) {
                    if (tag === paramKey) {
                        // Parse value based on type
                        let numValue = parseFloat(value);
                        if (!isNaN(numValue) && paramConfig.divisor) {
                            numValue = parseFloat((numValue / paramConfig.divisor).toFixed(2));
                        }
                        
                        parsed[paramConfig.name] = isNaN(numValue) ? value : numValue;
                        
                        if (paramConfig.unit) {
                            parsed[`${paramConfig.name}_unit`] = paramConfig.unit;
                        }
                    }
                }
            }
        }

        return parsed;
    }

    /**
     * Test parser with sample data
     * @param {Buffer|string} sampleData - Sample data to test
     * @returns {Object} Test result
     */
    test(sampleData) {
        return this.parse(sampleData);
    }
}

module.exports = RcmsParser;
