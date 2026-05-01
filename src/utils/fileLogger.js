const fs = require('fs');
const path = require('path');
const os = require('os');

class FileLogger {
    constructor(baseDir = 'data') {
        this.baseDir = path.resolve(baseDir);
        this.ensureDir(this.baseDir);
    }

    /**
     * Ensure directory exists
     */
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Get log file path for equipment
     * Format: data/{YYYY-MM}/{DD}/{equip_name}.log
     */
    getLogFilePath(equipmentName, equipmentId) {
        const now = new Date();
        
        const yearFull = now.getFullYear();
        const monthNum = now.getMonth() + 1;
        const dayNum = now.getDate();
        
        const yearMonth = `${yearFull}-${monthNum.toString().padStart(2, '0')}`; // YYYY-MM
        const day = dayNum.toString().padStart(2, '0'); // DD
        
        // Sanitize equipment name
        const safeName = equipmentName
            .toLowerCase()
            .replace(/[^a-z0-9\s_-]/gi, '_')
            .replace(/\s+/g, '_')
            .substring(0, 50);
        
        // Removed dateStamp from filename as requested (it's already in the folder path)
        const fileName = `${safeName}.log`;
        
        const dirPath = path.join(this.baseDir, yearMonth, day);
        this.ensureDir(dirPath);
        
        return path.join(dirPath, fileName);
    }

    /**
     * Log data as JSON line
     */
    async log(equipmentName, equipmentId, inputData) {
        try {
            const logPath = this.getLogFilePath(equipmentName, equipmentId);
            
            // Extract metadata from inputData
            const _ip = inputData._ip || (inputData.data && inputData.data._ip) || 'unknown';
            const status = inputData.status || (inputData.data && inputData.data.status) || 'Normal';
            const triggered = inputData._triggered || (inputData.data && inputData.data._triggered) || [];
            
            // Prepare the 'data' part - flattening if parsedData was nested
            let actualData = {};
            if (inputData.data && typeof inputData.data === 'object') {
                if (inputData.data.data && typeof inputData.data.data === 'object') {
                    actualData = { ...inputData.data.data, ...inputData.data };
                    delete actualData.data;
                } else {
                    actualData = { ...inputData.data };
                }
            } else {
                const { _ip: i, status: s, _triggered: t, ...rest } = inputData;
                actualData = rest;
            }

            actualData._ip = _ip;
            actualData.status = status;
            if (!actualData.triggeredParameters) {
                actualData.triggeredParameters = triggered;
            }

            const logEntry = {
                timestamp: new Date().toISOString(),
                equipmentId,
                equipmentName,
                ip: _ip,
                status: status,
                data: actualData,
                triggered: triggered
            };
            
            const logLine = `${JSON.stringify(logEntry)}${os.EOL}`;
            
            // Using appendFileSync for atomic and reliable appending
            fs.appendFileSync(logPath, logLine, 'utf8');
            
            console.log('[FILELOG] Appended to ' + path.relative(process.cwd(), logPath));
            return true;
        } catch (error) {
            console.error('[FILELOG] Error:', error.message);
            return false;
        }
    }

    /**
     * Get latest log file for equipment
     */
    getLatestLogFile(equipmentName, equipmentId) {
        const logPath = this.getLogFilePath(equipmentName, equipmentId);
        return fs.existsSync(logPath) ? logPath : null;
    }

    /**
     * List log files for equipment (last 24h)
     */
    listRecentLogs(equipmentName) {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24*60*60*1000);
        
        const yearMonth = now.toISOString().slice(0, 7).replace(/-/g, '-');
        const yesterdayDay = yesterday.toISOString().slice(8, 10);
        
        const dirs = [
            path.join(this.baseDir, yearMonth, yesterdayDay),
            path.join(this.baseDir, yearMonth, now.toISOString().slice(8, 10))
        ];
        
        const files = [];
        for (const dir of dirs) {
            if (fs.existsSync(dir)) {
                const dirFiles = fs.readdirSync(dir)
                    .filter(f => f.includes(equipmentName.toLowerCase().replace(/[^a-z0-9]/g, '_')))
                    .map(f => path.join(dir, f))
                    .sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());
                files.push(...dirFiles);
            }
        }
        
        return files.slice(0, 10); // Last 10 files
    }

    /**
     * Get all log entries across all files with pagination
     * Sorts by timestamp descending
     */
    async getHistoryLogs(options = {}) {
        const { page = 1, limit = 50, search = '', startDate = null, endDate = null } = options;
        const allEntries = [];
        
        try {
            // 1. Get all YYYY-MM folders, sorted descending
            if (!fs.existsSync(this.baseDir)) return { data: [], total: 0 };
            
            const monthFolders = (await fs.promises.readdir(this.baseDir))
                .filter(f => /^\d{4}-\d{2}$/.test(f))
                .sort((a, b) => b.localeCompare(a));
            
            for (const month of monthFolders) {
                const monthPath = path.join(this.baseDir, month);
                const dayFolders = (await fs.promises.readdir(monthPath))
                    .filter(f => /^\d{2}$/.test(f))
                    .sort((a, b) => b.localeCompare(a));
                
                for (const day of dayFolders) {
                    const dayPath = path.join(monthPath, day);
                    const files = (await fs.promises.readdir(dayPath))
                        .filter(f => f.endsWith('.log'))
                        .sort((a, b) => b.localeCompare(a));
                    
                    for (const file of files) {
                        const filePath = path.join(dayPath, file);
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        const lines = content.split(os.EOL).filter(l => l.trim());
                        
                        // Process lines in reverse to get newest first
                        for (let i = lines.length - 1; i >= 0; i--) {
                            try {
                                const entry = JSON.parse(lines[i]);
                                
                                // Apply filters
                                if (search && !entry.equipmentName?.toLowerCase().includes(search.toLowerCase()) && 
                                    !entry.status?.toLowerCase().includes(search.toLowerCase())) {
                                    continue;
                                }
                                
                                if (startDate && new Date(entry.timestamp) < new Date(startDate)) continue;
                                if (endDate && new Date(entry.timestamp) > new Date(endDate)) continue;
                                
                                allEntries.push(entry);
                                
                                // If we have enough entries for the current page and more, we can potentially stop
                                if (allEntries.length >= page * limit + 200) break;
                            } catch (e) { /* ignore malformed lines */ }
                        }
                        if (allEntries.length >= page * limit + 200) break;
                    }
                    if (allEntries.length >= page * limit + 200) break;
                }
                if (allEntries.length >= page * limit + 200) break;
            }
            
            // 2. Final sort
            allEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            // 3. Paginate
            const total = allEntries.length;
            const start = (page - 1) * limit;
            const data = allEntries.slice(start, start + limit);
            
            return { data, total };
        } catch (error) {
            console.error('[FILELOG] getHistoryLogs error:', error.message);
            return { data: [], total: 0 };
        }
    }

    /**
     * Get aggregated chart data across all log files for specific equipment
     * Supports: 60m, 24h, 7d, 30d, 1y
     */
    async getAggregatedChartData(equipmentName, equipmentId, timeframe = '24h') {
        const now = new Date();
        let startTime;
        let bucketMs; // Size of each aggregation bucket
        let formatKey; // Function to generate bucket key

        switch (timeframe) {
            case '60m':
                startTime = new Date(now.getTime() - 60 * 60 * 1000);
                bucketMs = 60 * 1000; // 1 minute
                formatKey = (date) => new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
                break;
            case '24h':
                startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                bucketMs = 60 * 60 * 1000; // 1 hour
                formatKey = (date) => new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
                break;
            case '7d':
                startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                bucketMs = 24 * 60 * 60 * 1000; // 1 day
                formatKey = (date) => date.toISOString().split('T')[0] + 'T00:00:00.000Z';
                break;
            case '30d':
                startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                bucketMs = 24 * 60 * 60 * 1000; // 1 day
                formatKey = (date) => date.toISOString().split('T')[0] + 'T00:00:00.000Z';
                break;
            case '1y':
                startTime = new Date(now.getFullYear() - 1, now.getMonth(), 1);
                bucketMs = 30 * 24 * 60 * 60 * 1000; // Rough month
                formatKey = (date) => `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-01T00:00:00.000Z`;
                break;
            default:
                startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                bucketMs = 60 * 60 * 1000;
                formatKey = (date) => new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
        }

        const buckets = new Map();
        const safeName = equipmentName.toLowerCase().replace(/[^a-z0-9\s_-]/gi, '_').replace(/\s+/g, '_').substring(0, 50);
        const fileName = `${safeName}.log`;

        try {
            if (!fs.existsSync(this.baseDir)) return [];

            const monthFolders = (await fs.promises.readdir(this.baseDir))
                .filter(f => /^\d{4}-\d{2}$/.test(f))
                .sort();

            for (const month of monthFolders) {
                const monthPath = path.join(this.baseDir, month);
                const dayFolders = (await fs.promises.readdir(monthPath))
                    .filter(f => /^\d{2}$/.test(f))
                    .sort();

                for (const day of dayFolders) {
                    const dateStr = `${month}-${day}`;
                    if (new Date(dateStr) < new Date(startTime.toISOString().split('T')[0])) continue;

                    const dayPath = path.join(monthPath, day);
                    const filePath = path.join(dayPath, fileName);

                    if (fs.existsSync(filePath)) {
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        const lines = content.split(os.EOL).filter(l => l.trim());

                        for (const line of lines) {
                            try {
                                const entry = JSON.parse(line);
                                const entryTime = new Date(entry.timestamp);

                                if (entryTime < startTime) continue;

                                const key = formatKey(entryTime);
                                if (!buckets.has(key)) buckets.set(key, { sources: {} });

                                const bucket = buckets.get(key);
                                const sourceIp = entry.ip || 'unknown';
                                
                                if (!bucket.sources[sourceIp]) {
                                    bucket.sources[sourceIp] = { count: 0, values: {} };
                                }
                                
                                const sourceBucket = bucket.sources[sourceIp];
                                sourceBucket.count++;

                                // Process numeric fields in data recursively or flattened
                                const flatData = entry.data || {};
                                for (const field in flatData) {
                                    const val = flatData[field];
                                    if (typeof val === 'number') {
                                        sourceBucket.values[field] = (sourceBucket.values[field] || 0) + val;
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                }
            }

            // Average the values per source
            const result = [];
            for (const [timestamp, bucket] of buckets.entries()) {
                const sources = {};
                for (const sourceIp in bucket.sources) {
                    const sBucket = bucket.sources[sourceIp];
                    const sData = {};
                    for (const field in sBucket.values) {
                        sData[field] = Number((sBucket.values[field] / sBucket.count).toFixed(2));
                    }
                    sources[sourceIp] = sData;
                }
                result.push({ timestamp, sources });
            }

            return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        } catch (error) {
            console.error('[FILELOG] getAggregatedChartData error:', error.message);
            return [];
        }
    }

    /**
     * Cleanup folders older than 3 months
     */
    async cleanupOldLogs() {
        console.log('[FILELOG] Starting automated cleanup...');
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth(); // 0-11
        
        // Calculate the threshold (3 months ago)
        const thresholdDate = new Date(year, month - 3, 1);
        const thresholdStr = thresholdDate.toISOString().slice(0, 7); // YYYY-MM
        
        try {
            if (!fs.existsSync(this.baseDir)) return;
            
            const monthFolders = fs.readdirSync(this.baseDir)
                .filter(f => /^\d{4}-\d{2}$/.test(f));
            
            let deletedCount = 0;
            for (const folder of monthFolders) {
                if (folder < thresholdStr) {
                    const fullPath = path.join(this.baseDir, folder);
                    console.log(`[FILELOG] Deleting old log directory: ${folder}`);
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    deletedCount++;
                }
            }
            
            console.log(`[FILELOG] Cleanup complete. Deleted ${deletedCount} folders.`);
            return deletedCount;
        } catch (error) {
            console.error('[FILELOG] cleanupOldLogs error:', error.message);
            return 0;
        }
    }
}

module.exports = new FileLogger();
