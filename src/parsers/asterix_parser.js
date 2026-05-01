const BaseParser = require('./base');
const asterix = require('./asterix');

class AsterixParser extends BaseParser {
    /**
     * Parse ASTERIX data
     * @param {Buffer|string} rawData - Raw ASTERIX data
     * @returns {Object} Parsed data
     */
    parse(rawData) {
        try {
            const buf = typeof rawData === 'string' ? Buffer.from(rawData, 'binary') : rawData;
            
            // asterix.js has parseRecord which handles CAT, LEN, etc.
            const record = asterix.parseRecord(buf);
            
            if (!record) {
                // Try parseAsterix which returns an array
                const records = asterix.parseAsterix(buf);
                if (records && records.length > 0) {
                    return {
                        success: true,
                        data: records[0], // For monitoring, we usually care about the latest/primary record
                        status: 'Normal',
                        timestamp: new Date().toISOString(),
                        count: records.length
                    };
                }
                throw new Error("No valid ASTERIX records found");
            }

            // Fitur BaseParser for the record data
            const alarmResult = this.checkAlarms(record.data);
            const finalData = this.applyThresholdOverrides(record.data);

            return {
                success: true,
                data: finalData,
                status: alarmResult.status,
                alarms: alarmResult.alarms,
                warnings: alarmResult.warnings,
                triggeredParams: alarmResult.triggeredParams,
                metadata: {
                    category: record.category,
                    categoryName: record.categoryName,
                    length: record.length
                },
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

module.exports = AsterixParser;
