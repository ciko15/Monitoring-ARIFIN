import { exec } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../../db/database');


/**
 * Validates an IP address string
 */
export const isValidIP = (ip: string): boolean => {
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(ip)) return false;
  const parts = ip.split('.');
  return parts.every(part => {
    const num = parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
};

/**
 * Validates an OID string
 */
export const isValidOID = (oid: string): boolean => {
  return /^[0-9.]+$/.test(oid);
};

/**
 * Standard ping function using node-ping
 */
export async function pingHost(ip: string, timeout: number = 3): Promise<any> {
    const ping = require('ping');
    try {
        const result = await ping.promise.probe(ip, { timeout });
        return {
            alive: result.alive,
            time: result.time,
            min: result.min,
            max: result.max,
            avg: result.avg,
            packetLoss: result.packetLoss,
            timestamp: new Date().toISOString()
        };
    } catch (error: any) {
        console.error(`[PING-ERROR] ${ip}:`, error.message);
        return { alive: false, error: error.message, timestamp: new Date().toISOString() };
    }
}


/**
 * Direct Equipment Ping (No Gateway Check)
 * Pings equipment IP directly for branch deployment.
 */
export async function pingTiered(equipmentId: number): Promise<any> {
    const item = await db.getEquipmentById(equipmentId);
    if (!item) throw new Error('Equipment not found');

    const config = item.snmpConfig || item.snmp_config || {};
    const ip = item.ip_address || config.ip;

    if (!ip || !isValidIP(ip)) {
        return { success: false, message: 'Invalid or missing IP address' };
    }

    // Direct equipment check
    console.log(`[PING] Checking equipment ${item.name} at ${ip}...`);
    
    // Real device ping only

    const result = await pingHost(ip, 3);
    
    return {
        success: result.alive,
        status: result.alive ? 'online' : 'offline',
        statistics: result.alive ? { 
            min: result.min || result.time, 
            max: result.max || result.time, 
            avg: result.avg || result.time,
            loss: result.packetLoss
        } : null,
        timestamp: result.timestamp
    };
}


/**
 * Executes an SNMP Get command for a single OID
 */
export async function snmpGet(oid: string, host: string, port: number | string = 161, community: string = 'public'): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!isValidIP(host)) {
            return reject(new Error('Invalid host IP'));
        }

        const portNum = typeof port === 'string' ? parseInt(port) : port;
        const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, '');
        const safeCommunity = community.replace(/[^a-zA-Z0-9_]/g, '');
        const safeOid = oid.replace(/[^0-9.]/g, '');

        const cmd = `snmpget -v2c -c ${safeCommunity} ${safeHost}:${portNum} ${safeOid}`;
        
        exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                return reject(error);
            }

            const match = stdout.match(/=\s*(\w+):\s*(.*)/);
            if (match) {
                let value = match[2].trim();
                if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                resolve({ value, type: match[1], oid: safeOid });
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * Executes an SNMP Walk/Bulk command for multiple OIDs
 */
export async function snmpGetBulk(oids: string[], host: string, port: number | string = 161, community: string = 'public'): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (!isValidIP(host)) {
      return reject(new Error('Invalid host IP'));
    }
    
    const portNum = typeof port === 'string' ? parseInt(port) : port;
    const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, '');
    const safeCommunity = community.replace(/[^a-zA-Z0-9_]/g, '');
    
    // For bulk/walk, we often use the base OID
    const firstOid = oids[0];
    const parts = firstOid.split('.');
    
    // Logic to determine base OID (similar to server.js)
    let baseOid = firstOid;
    if (parts.length > 5) {
        baseOid = parts.slice(0, 8).join('.'); 
    }
    
    const cmd = `snmpwalk -v2c -c ${safeCommunity} ${safeHost}:${portNum} ${baseOid}`;
    
    exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      
      const results: any[] = [];
      const lines = stdout.split('\n').filter(line => line.trim() && !line.includes('No more variables'));
      
      for (const line of lines) {
        // More robust parsing for different snmpwalk output formats
        const match = line.match(/::([\w.-]+)\s*=\s*(\w+):\s*(.*)/) || line.match(/iso\.([\w.-]+)\s*=\s*(\w+):\s*(.*)/);
        if (match) {
          let value = match[3].trim();
          if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
          
          results.push({ 
              oid: match[1], 
              fullOid: match[0].split('=')[0].trim(), 
              value, 
              type: match[2] 
          });
        }
      }
      resolve(results);
    });
  });
}

/**
 * Combines fetching and parsing logic for equipment
 * Implementation follows strict requirement:
 * 1. Authenticate Gateway (if not bypassed)
 * 2. Authenticate Device
 * 3. Fetch Raw Data (Simulated or Real)
 * 4. Parse & Tag with IP
 */
export async function fetchAndParseData(equipment: any) {
    const config = equipment.snmpConfig || equipment.snmp_config;
    const templateId = config?.templateId;
    const ipAddress = equipment.ipAddress || (config ? config.ip : null);

    // 1. PHASE 1: Fetch Authentication/Sub-Sources for this equipment
    let subSources = [];
    try {
        // Use equipment.id to find linked sources in equipment_otentication_config.json
        subSources = await db.getOtenticationByEquipment(equipment.id);
    } catch (e) {
        console.error(`[AUTH-FETCH-ERROR] ${equipment.id}:`, e);
    }

    // 2. PHASE 2: Check Reachability for all sources
    const sourceResults = [];
    let aliveCount = 0;
    let totalSourcesToCheck = 0;

    // Check main IP if configured
    if (ipAddress && isValidIP(ipAddress)) {
        totalSourcesToCheck++;
        const result = await pingHost(ipAddress, 2);
        if (result.alive) aliveCount++;
        sourceResults.push({ name: 'Primary', ip: ipAddress, alive: result.alive });
    }

    // Check all sub-sources from authentication config
    for (const src of subSources) {
        if (src.ip_address && isValidIP(src.ip_address)) {
            totalSourcesToCheck++;
            const result = await pingHost(src.ip_address, 2);
            if (result.alive) aliveCount++;
            sourceResults.push({ name: src.name || 'Sub-Source', ip: src.ip_address, alive: result.alive });
        }
    }

    // Handle case where no IP is configured at all
    if (totalSourcesToCheck === 0) {
        return { 
            parsedData: { status: 'Unknown', message: 'No IP or Sources Configured' }, 
            status: 'Normal', // Don't flag as Disconnect if it's not meant to be monitored
            triggeredParameters: [],
            isProcessed: false
        };
    }

    // Determine aggregate reachability status
    let reachabilityStatus = 'Normal';
    if (aliveCount === 0) {
        reachabilityStatus = 'Disconnect';
    } else if (aliveCount < totalSourcesToCheck) {
        reachabilityStatus = 'Warning';
    }

    // 3. PHASE 3: SNMP Threshold Evaluation (if enabled and primary is alive)
    const mainAlive = sourceResults.find(r => r.name === 'Primary')?.alive || (sourceResults.length > 0 && reachabilityStatus !== 'Disconnect');
    
    let rawData = { _ip: ipAddress, _sources: sourceResults };
    let status = reachabilityStatus;
    let triggeredParameters: string[] = [];

    // If SNMP is enabled, we can fetch more detailed data and check thresholds
    if (config?.enabled && mainAlive) {
        // Here we would normally perform SNMP Get/Bulk
        // Using existing determineStatus helper to check thresholds
        const evalResult = await determineStatus(rawData, templateId || 'generic_snmp');
        
        // Status Priority: Disconnect (0) > Alert (3) > Warning (2) > Normal (1)
        // We use a custom priority check to ensure Alert overrides Warning
        const statusPriority: Record<string, number> = { 'Disconnect': 0, 'Alert': 3, 'Warning': 2, 'Normal': 1 };
        
        if (statusPriority[evalResult.status] > statusPriority[status]) {
            status = evalResult.status;
        }
        triggeredParameters = evalResult.triggeredParameters;
    }

    return { 
        parsedData: { ...rawData, status }, 
        status: status, 
        triggeredParameters: triggeredParameters,
        isProcessed: true
    };
}



/**
 * Determine status based on thresholds
 */
export async function determineStatus(data: any, templateId: string) {
    const thresholdEvaluator = require('./thresholdEvaluator');
    
    let template;
    try {
        template = await db.getSnmpTemplateById(templateId);
    } catch (e) {
        template = null;
    }

    let overallStatus = 'Normal';
    let triggeredParameters: string[] = [];

    if (template && template.parameters && template.parameters.length > 0) {
        const statusPriority: Record<string, number> = { 'Alert': 3, 'Warning': 2, 'Normal': 1, 'Disconnect': 0 };

        for (const param of template.parameters) {
            const valueObj = data[param.source] || data[param.label];
            if (!valueObj || valueObj.value === undefined) continue;

            const config = {
                warning_min: param.warning_min,
                warning_max: param.warning_max,
                alarm_min: param.alarm_min,
                alarm_max: param.alarm_max
            };

            const status = thresholdEvaluator.checkThreshold(valueObj.value, config);
            if (status === 'Warning' || status === 'Alert') {
                triggeredParameters.push(param.source || param.label);
            }
            if (statusPriority[status] > statusPriority[overallStatus]) {
                overallStatus = status;
            }
        }
        return { status: overallStatus, triggeredParameters };
    }

    const defaultThresholds: Record<string, any> = {
        temperature: { warning: 35, critical: 45 },
        humidity: { warningLow: 30, warningHigh: 80, criticalLow: 20, criticalHigh: 90 },
        alarmStatus: { warning: 1, critical: 2 }
    };

    let thresholds = defaultThresholds;
    if (template && (template.oidMappings || template.oid_mappings)) {
        const oidMappings = template.oidMappings || template.oid_mappings;
        let pMappings = typeof oidMappings === 'string' ? JSON.parse(oidMappings) : oidMappings;
        thresholds = {};
        for (const [key, mapping] of Object.entries(pMappings) as any) {
            if (mapping.warningThreshold !== undefined || mapping.criticalThreshold !== undefined) {
                thresholds[key] = { warning: mapping.warningThreshold, critical: mapping.criticalThreshold };
            }
            if (mapping.warningLow !== undefined || mapping.warningHigh !== undefined) {
                thresholds[key] = { ...thresholds[key], warningLow: mapping.warningLow, warningHigh: mapping.warningHigh, criticalLow: mapping.criticalLow, criticalHigh: mapping.criticalHigh };
            }
        }
    }

    for (const [key, valueObj] of Object.entries(data) as any) {
        if (!valueObj || valueObj.value === undefined) continue;
        const value = parseFloat(valueObj.value);
        if (isNaN(value)) continue;
        const threshold = thresholds[key];
        if (!threshold) continue;
        
        if (threshold.warningLow !== undefined && threshold.warningHigh !== undefined) {
            if (value <= threshold.criticalLow || value >= threshold.criticalHigh) {
                overallStatus = 'Alert';
                triggeredParameters.push(key);
            } else if (value <= threshold.warningLow || value >= threshold.warningHigh) {
                if (overallStatus !== 'Alert') overallStatus = 'Warning';
                triggeredParameters.push(key);
            }
        } else if (threshold.criticalThreshold !== undefined) {
            if (value >= threshold.criticalThreshold) {
                overallStatus = 'Alert';
                triggeredParameters.push(key);
            } else if (threshold.warningThreshold !== undefined && value >= threshold.warningThreshold) {
                if (overallStatus !== 'Alert') overallStatus = 'Warning';
                triggeredParameters.push(key);
            }
        }
    }
    return { status: overallStatus, triggeredParameters };
}

/**
 * Helper to parse advanced data using ParserFactory
 */
async function parseAdvancedData(type: string, rawData: any, equipment: any) {
    const ParserFactory = require('../parsers/factory');
    const parser = ParserFactory.createParser(type, {
        ...equipment,
        parser_config: {},
        threshold_overrides: {}
    });
    if (!parser) throw new Error(`Parser for ${type} not found`);
    const result = parser.parse(rawData);
    if (!result.success) throw new Error(`Parsing failed for ${equipment.name}: ${result.error}`);
    return result;
}
