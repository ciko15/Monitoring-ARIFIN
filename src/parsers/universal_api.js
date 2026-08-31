const BaseParser = require('./base');

class UniversalApiParser extends BaseParser {
    constructor(config) {
        super(config);
        this.isHttpPull = true; // Mark as HTTP pull parser for network_listener
        this.parserConfig = config.parser_config || {};
        this.mappings = this.parserConfig.mappings || [];
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
                const arrayName = arrayMatch[1];
                const index = parseInt(arrayMatch[2], 10);
                if (current[arrayName] && Array.isArray(current[arrayName])) {
                    current = current[arrayName][index];
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
     * Parse JSON data based on mappings
     * @param {Object} dataObj - Parsed JSON object
     * @returns {Object} Extracted data
     */
    _parseJsonMapping(dataObj) {
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

        return parsed;
    }

    /**
     * Fetch data from API
     * @param {string} ip - Equipment IP
     * @param {number} port - Equipment port
     * @returns {Promise<Object>} Result object
     */
    async fetchApiData(ip, port) {
        try {
            const endpointTemplate = this.parserConfig.endpoint_url || `http://{ip}:{port}/api/data`;
            const method = (this.parserConfig.api_options && this.parserConfig.api_options.method) || 'GET';
            const headers = (this.parserConfig.api_options && this.parserConfig.api_options.headers) || {
                'Accept': 'application/json'
            };

            // Dynamic endpoint resolution
            const url = endpointTemplate
                .replace(/{ip}/g, ip)
                .replace(/{port}/g, port);

            const response = await fetch(url, {
                method,
                headers,
                signal: AbortSignal.timeout(10000) // 10s timeout
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
            }

            const rawJson = await response.json();
            
            // Map values
            const parsedData = this._parseJsonMapping(rawJson);
            
            // Check alarms
            const alarmResult = this.checkAlarms(parsedData);

            return {
                success: true,
                data: parsedData,
                status: alarmResult.status || 'Normal',
                alarms: alarmResult.alarms || [],
                warnings: alarmResult.warnings || [],
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

    parse(rawData) {
        // If data is already an object (passed from network_listener HTTP Pull loop)
        if (typeof rawData === 'object' && rawData !== null && !Buffer.isBuffer(rawData)) {
            if (rawData.data !== undefined) {
                return {
                    success: true,
                    data: rawData.data,
                    status: 'Normal',
                    alarms: [],
                    warnings: [],
                    timestamp: new Date().toISOString()
                };
            }
        }

        // Fallback if called directly with raw data (string/buffer) instead of fetchApiData
        try {
            const strData = Buffer.isBuffer(rawData) ? rawData.toString() : rawData;
            const dataObj = JSON.parse(strData);
            const parsedData = this._parseJsonMapping(dataObj);
            const alarmResult = this.checkAlarms(parsedData);

            return {
                success: true,
                data: parsedData,
                status: alarmResult.status || 'Normal',
                alarms: alarmResult.alarms || [],
                warnings: alarmResult.warnings || [],
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
}

module.exports = UniversalApiParser;
