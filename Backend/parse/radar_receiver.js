/**
 * RADAR Receiver Module
 * Listens to multicast UDP for ASTERIX radar data
 * 
 * Supports 5 Papua Radar Stations:
 * - Sentani: 225.30.210.1:4001
 * - Biak: 230.52.53.3:21053
 * - Merauke: 230.52.53.5:21055
 * - Sorong: 230.52.53.4:21054
 * - Timika: 230.52.53.2:21052
 */

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const AsterixParser = require('./asterix_parser');

class RadarReceiver {
  constructor(options = {}) {
    this.parser = new AsterixParser();
    this.servers = new Map();
    this.dataDir = options.dataDir || path.join(__dirname, '../../../data');
    this.onData = options.onData || null;
    this.onError = options.onError || null;
    this.onStatusChange = options.onStatusChange || null;
    
    // Default radar stations configuration
    this.stations = options.stations || [
      { id: 1, name: 'Sentani', ip: '225.30.210.1', port: 4001, lat: -2.599, lng: 140.528, airportId: 1 },
      { id: 2, name: 'Biak', ip: '230.52.53.3', port: 21053, lat: -1.187, lng: 136.112, airportId: 11 },
      { id: 3, name: 'Merauke', ip: '230.52.53.5', port: 21055, lat: -8.513, lng: 140.411, airportId: 52 },
      { id: 4, name: 'Sorong', ip: '230.52.53.4', port: 21054, lat: -0.891, lng: 131.288, airportId: 51 },
      { id: 5, name: 'Timika', ip: '230.52.53.2', port: 21052, lat: -4.528, lng: 136.887, airportId: 13 }
    ];
    
    // Status tracking
    this.status = new Map();
    this.lastUpdate = new Map();
    this.targetCount = new Map();
    
    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Start receiving radar data for a specific station
   * @param {Object} station - Station configuration
   */
  startStation(station) {
    const key = `${station.ip}:${station.port}`;
    
    if (this.servers.has(key)) {
      console.log(`[RADAR] Already listening on ${key}`);
      return;
    }
    
    const server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    server.on('error', (err) => {
      console.error(`[RADAR] Socket error for ${station.name}:`, err.message);
      if (this.onError) this.onError(station, err);
      server.close();
    });
    
    server.on('message', (msg, rinfo) => {
      this.processMessage(station, msg, rinfo);
    });
    
    server.on('listening', () => {
      const address = server.address();
      console.log(`[RADAR] Listening on ${address.address}:${address.port} for ${station.name}`);
      
      // Join multicast group
      try {
        server.addMembership(station.ip);
        server.setMulticastTTL(128);
      } catch (err) {
        console.warn(`[RADAR] Could not join multicast group ${station.ip}:`, err.message);
      }
      
      this.updateStatus(station, 'connected');
    });
    
    server.on('close', () => {
      console.log(`[RADAR] Socket closed for ${station.name}`);
      this.updateStatus(station, 'disconnected');
    });
    
    // Bind to the multicast port
    server.bind(station.port);
    
    this.servers.set(key, { server, station });
    this.status.set(station.id, 'initializing');
    this.targetCount.set(station.id, 0);
  }

  /**
   * Start all configured stations
   */
  startAll() {
    console.log('[RADAR] Starting radar receivers...');
    for (const station of this.stations) {
      this.startStation(station);
    }
  }

  /**
   * Stop a specific station
   * @param {Object} station - Station configuration
   */
  stopStation(station) {
    const key = `${station.ip}:${station.port}`;
    const entry = this.servers.get(key);
    
    if (entry) {
      try {
        entry.server.dropMembership(station.ip);
      } catch (err) {
        // Ignore
      }
      entry.server.close();
      this.servers.delete(key);
      this.updateStatus(station, 'stopped');
    }
  }

  /**
   * Stop all stations
   */
  stopAll() {
    console.log('[RADAR] Stopping all radar receivers...');
    for (const station of this.stations) {
      this.stopStation(station);
    }
  }

  /**
   * Process incoming ASTERIX message
   * @param {Object} station - Station configuration
   * @param {Buffer} msg - Raw UDP message
   * @param {Object} rinfo - Remote info
   */
  processMessage(station, msg, rinfo) {
    try {
      const parsed = this.parser.parse(msg);
      
      if (parsed.records && parsed.records.length > 0) {
        for (const record of parsed.records) {
          if (record.type === 'CAT048' && record.targetNumber) {
            this.handleRadarTarget(station, record, msg);
          } else if (record.type === 'CAT034') {
            this.handleRadarServiceMessage(station, record, msg);
          }
        }
        
        // Update last receive time
        this.lastUpdate.set(station.id, new Date());
        
        // Count targets
        const targetCount = parsed.records.filter(r => r.type === 'CAT048').length;
        if (targetCount > 0) {
          this.targetCount.set(station.id, targetCount);
          this.updateStatus(station, 'receiving');
        }
      }
      
    } catch (err) {
      console.error(`[RADAR] Parse error for ${station.name}:`, err.message);
    }
  }

  /**
   * Handle radar target data
   * @param {Object} station - Station
   * @param {Object} target - Parsed target data
   * @param {Buffer} raw - Raw message
   */
  handleRadarTarget(station, target, raw) {
    const targetData = {
      stationId: station.id,
      stationName: station.name,
      timestamp: new Date().toISOString(),
      sac: target.sac,
      sic: target.sic,
      targetNumber: target.targetNumber,
      mode3A: target.mode3A,
      flightLevel: target.flightLevel,
      latitude: target.latitude,
      longitude: target.longitude,
      callsign: target.callsign,
      targetAddress: target.targetAddress,
      timeOfDay: target.timeOfDay
    };
    
    // Callback
    if (this.onData) {
      this.onData('radar', station, targetData);
    }
    
    // Save to JSON file
    this.saveToJson(station, 'radar_targets', targetData);
  }

  /**
   * Handle radar service messages
   * @param {Object} station - Station
   * @param {Object} msg - Parsed message
   * @param {Buffer} raw - Raw message
   */
  handleRadarServiceMessage(station, msg, raw) {
    const serviceData = {
      stationId: station.id,
      stationName: station.name,
      timestamp: new Date().toISOString(),
      type: 'CAT034',
      messages: msg.messages
    };
    
    // Callback
    if (this.onData) {
      this.onData('service', station, serviceData);
    }
  }

  /**
   * Update station status
   * @param {Object} station - Station
   * @param {String} newStatus - New status
   */
  updateStatus(station, newStatus) {
    const oldStatus = this.status.get(station.id);
    this.status.set(station.id, newStatus);
    
    if (oldStatus !== newStatus && this.onStatusChange) {
      this.onStatusChange(station, oldStatus, newStatus);
    }
  }

  /**
   * Save data to JSON file
   * @param {Object} station - Station
   * @param {String} type - Data type
   * @param {Object} data - Data to save
   */
  saveToJson(station, type, data) {
    try {
      const filePath = path.join(this.dataDir, `radar_${station.name.toLowerCase()}_${type}.json`);
      let existing = [];
      
      // Read existing data
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          existing = JSON.parse(content);
          if (!Array.isArray(existing)) existing = [];
        } catch (e) {
          existing = [];
        }
      }
      
      // Add new data
      existing.push(data);
      
      // Keep only last 1000 records
      if (existing.length > 1000) {
        existing = existing.slice(-1000);
      }
      
      // Write to file
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
      
    } catch (err) {
      console.error(`[RADAR] Error saving to JSON:`, err.message);
    }
  }

  /**
   * Get status for all stations
   */
  getStatus() {
    const statusList = [];
    for (const station of this.stations) {
      const status = this.status.get(station.id) || 'unknown';
      const lastUpdate = this.lastUpdate.get(station.id);
      const targetCount = this.targetCount.get(station.id) || 0;
      
      statusList.push({
        id: station.id,
        name: station.name,
        ip: station.ip,
        port: station.port,
        lat: station.lat,
        lng: station.lng,
        status,
        lastUpdate: lastUpdate ? lastUpdate.toISOString() : null,
        targetCount
      });
    }
    return statusList;
  }

  /**
   * Get current targets for a station
   * @param {Number} stationId - Station ID
   */
  getTargets(stationId) {
    const station = this.stations.find(s => s.id === stationId);
    if (!station) return [];
    
    const filePath = path.join(this.dataDir, `radar_${station.name.toLowerCase()}_radar_targets.json`);
    
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const targets = JSON.parse(content);
        
        // Get only recent targets (last 60 seconds)
        const cutoff = Date.now() - 60000;
        return targets.filter(t => new Date(t.timestamp).getTime() > cutoff);
      } catch (e) {
        return [];
      }
    }
    
    return [];
  }

  /**
   * Manually fetch/parse ASTERIX data from a station
   * @param {Number} stationId - Station ID
   */
  async fetchData(stationId) {
    const station = this.stations.find(s => s.id === stationId);
    if (!station) {
      throw new Error('Station not found');
    }
    
    // If already receiving, return current data
    if (this.status.get(station.id) === 'receiving') {
      return {
        station,
        targets: this.getTargets(stationId),
        status: 'receiving'
      };
    }
    
    // Return last known state
    return {
      station,
      targets: this.getTargets(stationId),
      status: this.status.get(station.id) || 'disconnected'
    };
  }
}

module.exports = RadarReceiver;

