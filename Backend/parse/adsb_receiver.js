/**
 * ADS-B Receiver Module
 * Listens to multicast UDP for ADS-B aircraft data
 * 
 * Source: 239.71.40.2:50000
 * 
 * Papua Coverage:
 * - Sentani, Biak, Merauke, Sorong, Timika
 * - Nabire, Senggeh, Elelim, Dekai, Oksibil
 * - Wamena, Kaimana, Manokwari
 */

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

class AdsbReceiver {
  constructor(options = {}) {
    this.server = null;
    this.ip = options.ip || '239.71.40.2';
    this.port = options.port || 50000;
    this.dataDir = options.dataDir || path.join(__dirname, '../../../data');
    this.onData = options.onData || null;
    this.onError = options.onError || null;
    this.onStatusChange = options.onStatusChange || null;
    
    // Station coverage map (for SAC/SIC codes)
    this.stations = options.stations || {
      // SAC code (typically 0xFF for various)
      // Map to station names based on location ranges
    };
    
    // Aircraft tracking
    this.aircraft = new Map();
    this.lastUpdate = null;
    this.status = 'stopped';
    
    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Start receiving ADS-B data
   */
  start() {
    if (this.server) {
      console.log(`[ADS-B] Already listening on ${this.ip}:${this.port}`);
      return;
    }
    
    this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    this.server.on('error', (err) => {
      console.error('[ADS-B] Socket error:', err.message);
      if (this.onError) this.onError(err);
      this.server.close();
    });
    
    this.server.on('message', (msg, rinfo) => {
      this.processMessage(msg, rinfo);
    });
    
    this.server.on('listening', () => {
      const address = this.server.address();
      console.log(`[ADS-B] Listening on ${address.address}:${address.port}`);
      
      // Join multicast group
      try {
        this.server.addMembership(this.ip);
        this.server.setMulticastTTL(128);
      } catch (err) {
        console.warn(`[ADS-B] Could not join multicast group:`, err.message);
      }
      
      this.updateStatus('connected');
    });
    
    this.server.on('close', () => {
      console.log('[ADS-B] Socket closed');
      this.updateStatus('disconnected');
    });
    
    // Bind to the multicast port
    this.server.bind(this.port);
  }

  /**
   * Stop receiving ADS-B data
   */
  stop() {
    if (this.server) {
      try {
        this.server.dropMembership(this.ip);
      } catch (err) {
        // Ignore
      }
      this.server.close();
      this.server = null;
      this.updateStatus('stopped');
    }
  }

  /**
   * Process incoming ADS-B message
   * @param {Buffer} msg - Raw UDP message
   * @param {Object} rinfo - Remote info
   */
  processMessage(msg, rinfo) {
    try {
      // Try to parse as different ADS-B formats
      // Most common: Mode-S Beast format, raw ICAO24, or raw binary
      
      const parsed = this.parseAdsbMessage(msg, rinfo);
      
      if (parsed && parsed.icao24) {
        this.handleAircraft(parsed);
        this.lastUpdate = new Date();
        this.updateStatus('receiving');
      }
      
    } catch (err) {
      // Silent fail for parse errors - ADS-B can have malformed packets
    }
  }

  /**
   * Parse ADS-B message
   * Supports multiple formats:
   * - Raw binary ICAO24 + position
   * - Mode-S Beast format
   * - Plain text/cooked format
   * 
   * @param {Buffer} msg - Raw message
   * @param {Object} rinfo - Remote info
   * @returns {Object} Parsed aircraft data
   */
  parseAdsbMessage(msg, rinfo) {
    // Try to detect format and parse
    
    // Format 1: Beast binary format (starts with 0x1A or similar)
    if (msg.length >= 2 && msg[0] === 0x1A) {
      return this.parseBeastFormat(msg);
    }
    
    // Format 2: Raw ICAO24 in hex (length 6 or more hex chars)
    if (msg.length >= 6) {
      const hexStr = msg.toString('hex').toUpperCase();
      
      // Check if it's a valid ICAO24 (24-bit address)
      if (/^[0-9A-F]{6}$/.test(hexStr.substring(0, 6))) {
        return {
          icao24: hexStr.substring(0, 6),
          raw: hexStr,
          format: 'icao24_raw'
        };
      }
    }
    
    // Format 3: UTF-8 text/cooked format
    // Example: "3c6a8c,144.025,50000,352.25,87,247,0,-1.23,5.67,2014-04-21-13.55.34"
    try {
      const text = msg.toString('utf8').trim();
      if (text.includes(',') && text.length > 10) {
        return this.parseTextFormat(text);
      }
    } catch (e) {
      // Not text format
    }
    
    // Format 4: Try raw binary position decoding
    return this.parseBinaryFormat(msg);
  }

  /**
   * Parse Mode-S Beast format
   * @param {Buffer} msg - Beast format message
   * @returns {Object} Parsed data
   */
  parseBeastFormat(msg) {
    // Beast format: 1A [type] [length] [data] [checksum]
    if (msg.length < 5) return null;
    
    const msgType = msg[1];
    const msgLength = msg[2];
    
    // Type 0x01 = DF17/18 (ADS-B)
    // Type 0x02 = DF4/5 (Mode A/C)
    // Type 0x03 = DF20/21 (Mode S)
    
    if (msgType === 0x01 && msg.length >= 4 + msgLength) {
      const data = msg.slice(3, 3 + msgLength);
      return this.decodeAdsbMessage(data);
    }
    
    return null;
  }

  /**
   * Parse text/cooked format
   * Example: "icao24,lat,lon,alt,track,gs,vs,callsign"
   * @param {String} text - Text message
   * @returns {Object} Parsed data
   */
  parseTextFormat(text) {
    const parts = text.split(',');
    if (parts.length < 2) return null;
    
    // Try to identify format
    // Common: "HEX,call,lat,lon,alt,..."
    const hexPart = parts[0].trim();
    
    if (/^[0-9A-F]{6}$/i.test(hexPart)) {
      const result = {
        icao24: hexPart.toUpperCase(),
        format: 'text'
      };
      
      // Parse optional fields
      if (parts[1]) result.callsign = parts[1].trim();
      if (parts[2]) result.latitude = parseFloat(parts[2]);
      if (parts[3]) result.longitude = parseFloat(parts[3]);
      if (parts[4]) result.altitude = parseInt(parts[4]);
      if (parts[5]) result.track = parseFloat(parts[5]);
      if (parts[6]) result.groundSpeed = parseInt(parts[6]);
      if (parts[7]) result.verticalRate = parseInt(parts[7]);
      
      return result;
    }
    
    return null;
  }

  /**
   * Parse binary format for position data
   * @param {Buffer} msg - Binary message
   * @returns {Object} Parsed data
   */
  parseBinaryFormat(msg) {
    // Try to decode raw Mode-S/ADS-B message
    // ADS-B messages are typically 112-bit (14 bytes)
    if (msg.length >= 14) {
      // Get first 7 bytes
      const bytes = [];
      for (let i = 0; i < Math.min(msg.length, 14); i++) {
        bytes.push(msg[i]);
      }
      
      // Extract DF (Downlink Format) from first 5 bits
      const df = (bytes[0] >> 3) & 0x1F;
      
      // DF17 = ADS-B
      // DF18 = TIS-B
      if (df === 17 || df === 18) {
        return this.decodeAdsbMessage(Buffer.from(bytes));
      }
    }
    
    return null;
  }

  /**
   * Decode ADS-B message from raw Mode-S data
   * @param {Buffer} data - 7-byte message data
   * @returns {Object} Decoded ADS-B data
   */
  decodeAdsbMessage(data) {
    if (data.length < 7) return null;
    
    // Get Capability field (bits 32-37)
    const capability = (data[4] >> 2) & 0x1F;
    
    // Get ICAO24 address (bytes 1-3)
    const icao24 = data.slice(1, 4).toString('hex').toUpperCase();
    
    // Get message type (first 5 bits of byte 4)
    const msgType = ((data[3] << 2) | (data[4] >> 6)) & 0x1F;
    
    // Get ME (Message Element) bytes 5-11
    const me = data.slice(5, 11);
    
    // Parse based on type
    // Type 0-4: Identification
    // Type 5-8: Position
    // Type 9-18: Velocity
    // Type 19: Acceleration
    // Type 20-22: Status
    
    const result = {
      icao24,
      format: 'adsb',
      type: msgType
    };
    
    if (msgType >= 1 && msgType <= 4) {
      // Aircraft identification
      const callsign = this.decodeCallsign(me);
      if (callsign) result.callsign = callsign;
      
    } else if (msgType >= 5 && msgType <= 8) {
      // Airborne position
      const position = this.decodePosition(me, data[4] & 0x01 === 1);
      if (position) {
        result.latitude = position.lat;
        result.longitude = position.lng;
        result.altitude = position.alt;
        result.quality = position.quality;
      }
      
    } else if (msgType >= 9 && msgType <= 18) {
      // Velocity
      const velocity = this.decodeVelocity(me);
      if (velocity) {
        result.groundSpeed = velocity.gs;
        result.track = velocity.track;
        result.verticalRate = velocity.vr;
      }
    }
    
    return result;
  }

  /**
   * Decode aircraft callsign from ME bytes
   * @param {Buffer} me - Message element bytes
   * @returns {String} Callsign
   */
  decodeCallsign(me) {
    if (me.length < 6) return null;
    
    let callsign = '';
    // Characters are 6-bit CAII encoded
    for (let i = 0; i < 6; i++) {
      const charCode = ((me[i] >> 2) & 0x3F);
      // Map to ASCII
      if (charCode >= 1 && charCode <= 26) {
        callsign += String.fromCharCode(64 + charCode);
      } else if (charCode >= 32 && charCode <= 63) {
        callsign += String.fromCharCode(32 + charCode - 32);
      }
    }
    
    return callsign.trim();
  }

  /**
   * Decode position from ME bytes
   * @param {Buffer} me - Message element
   * @param {Boolean} isOdd - Odd/even CPR format
   * @returns {Object} Position data
   */
  decodePosition(me, isOdd) {
    if (me.length < 7) return null;
    
    // Compact Position Reporting (CPR)
    const alt = ((me[0] << 4) | ((me[1] >> 4) & 0x0F)) * 25 - 1000;
    
    // Raw CPR coordinates
    const cprLat = ((me[1] & 0x0F) << 15) | (me[2] << 7) | (me[3] >> 1);
    const cprLon = ((me[3] & 0x01) << 16) | (me[4] << 8) | me[5];
    
    // Simple approximation - in real implementation would need CPR decoding
    // with reference position
    return {
      lat: null, // Would need reference for CPR
      lng: null,
      alt: alt,
      quality: 0
    };
  }

  /**
   * Decode velocity from ME bytes
   * @param {Buffer} me - Message element
   * @returns {Object} Velocity data
   */
  decodeVelocity(me) {
    if (me.length < 5) return null;
    
    // Sub-type tells us what fields are present
    const subType = me[0] & 0x07;
    
    if (subType >= 1 && subType <= 2) {
      // Ground speed
      const gs = ((me[2] << 5) | (me[3] >> 3)) - 1;
      const track = (((me[3] & 0x07) << 5) | (me[4] >> 3)) - 1;
      
      return {
        gs: gs * (subType === 1 ? 1 : 0.125), // knots or m/s
        track: track * 360 / 128,
        vr: null
      };
    }
    
    return null;
  }

  /**
   * Handle aircraft data
   * @param {Object} aircraft - Parsed aircraft data
   */
  handleAircraft(aircraft) {
    const icao24 = aircraft.icao24;
    
    // Get existing or create new
    let existing = this.aircraft.get(icao24);
    if (!existing) {
      existing = {
        icao24,
        firstSeen: new Date().toISOString(),
        positionCount: 0,
        velocityCount: 0
      };
    }
    
    // Update data
    existing.lastSeen = new Date().toISOString();
    existing.lastUpdate = new Date().toISOString();
    
    // Merge new data
    if (aircraft.callsign) existing.callsign = aircraft.callsign;
    if (aircraft.latitude !== null && aircraft.latitude !== undefined) {
      existing.latitude = aircraft.latitude;
      existing.longitude = aircraft.longitude;
      existing.altitude = aircraft.altitude;
      existing.positionCount++;
    }
    if (aircraft.groundSpeed !== null && aircraft.groundSpeed !== undefined) {
      existing.groundSpeed = aircraft.groundSpeed;
      existing.track = aircraft.track;
      existing.verticalRate = aircraft.verticalRate;
      existing.velocityCount++;
    }
    
    // Store
    this.aircraft.set(icao24, existing);
    
    // Callback
    if (this.onData) {
      this.onData('adsb', existing);
    }
    
    // Save to JSON
    this.saveToJson(existing);
  }

  /**
   * Save aircraft data to JSON file
   * @param {Object} aircraft - Aircraft data
   */
  saveToJson(aircraft) {
    try {
      const filePath = path.join(this.dataDir, 'adsb_aircraft.json');
      let existing = [];
      
      // Read existing
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          existing = JSON.parse(content);
          if (!Array.isArray(existing)) existing = [];
        } catch (e) {
          existing = [];
        }
      }
      
      // Update or add
      const idx = existing.findIndex(a => a.icao24 === aircraft.icao24);
      if (idx >= 0) {
        existing[idx] = aircraft;
      } else {
        existing.push(aircraft);
      }
      
      // Keep only last 500 aircraft
      if (existing.length > 500) {
        existing = existing.slice(-500);
      }
      
      // Write
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
      
    } catch (err) {
      console.error('[ADS-B] Error saving to JSON:', err.message);
    }
  }

  /**
   * Update status
   * @param {String} newStatus - New status
   */
  updateStatus(newStatus) {
    if (this.status !== newStatus) {
      const oldStatus = this.status;
      this.status = newStatus;
      
      if (this.onStatusChange) {
        this.onStatusChange(oldStatus, newStatus);
      }
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      ip: this.ip,
      port: this.port,
      status: this.status,
      lastUpdate: this.lastUpdate ? this.lastUpdate.toISOString() : null,
      aircraftCount: this.aircraft.size,
      aircraft: Array.from(this.aircraft.values())
    };
  }

  /**
   * Get all current aircraft
   */
  getAircraft() {
    return Array.from(this.aircraft.values());
  }

  /**
   * Get aircraft by ICAO24
   * @param {String} icao24 - ICAO24 address
   */
  getAircraftByIcao(icao24) {
    return this.aircraft.get(icao24.toUpperCase());
  }

  /**
   * Clean up stale aircraft (not seen in 5 minutes)
   */
  cleanupStale() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const toRemove = [];
    
    for (const [icao24, ac] of this.aircraft) {
      const lastSeen = new Date(ac.lastSeen).getTime();
      if (lastSeen < cutoff) {
        toRemove.push(icao24);
      }
    }
    
    for (const icao24 of toRemove) {
      this.aircraft.delete(icao24);
    }
    
    if (toRemove.length > 0) {
      console.log(`[ADS-B] Cleaned up ${toRemove.length} stale aircraft`);
    }
  }
}

module.exports = AdsbReceiver;

