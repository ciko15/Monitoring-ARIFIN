/**
 * ASTERIX Parser Module
 * Standard Exchange Format for Radar Information
 * 
 * Supports:
 * - CAT034: Radar Service Messages
 * - CAT048: Radar Target Reports
 * 
 * ASTERIX Format:
 * | LEN (1-2 bytes) | CAT (1 byte) | DATA (LEN-1 bytes) |
 */

class AsterixParser {
  constructor() {
    // ASTERIX Category definitions
    this.categories = {
      34: { name: 'Radar Service Messages', parse: this.parseCAT034.bind(this) },
      48: { name: 'Radar Target Reports', parse: this.parseCAT048.bind(this) }
    };
    
    // Common data item definitions for CAT048
    this.dataItems = {
      // I048/010 - Data Source Identifier
      '010': { name: 'Data Source Identifier', length: 2, parse: this.parseDataSourceIdentifier.bind(this) },
      // I048/020 - Track Number
      '020': { name: 'Track Number', length: 1, parse: this.parseTrackNumber.bind(this) },
      // I048/040 - Position in WGS-84
      '040': { name: 'Position in WGS-84', length: 8, parse: this.parsePosition.bind(this) },
      // I048/042 - Position in Cartesian Coordinates
      '042': { name: 'Position in Cartesian', length: 6, parse: this.parseCartesianPosition.bind(this) },
      // I048/070 - Mode 3/A Code
      '070': { name: 'Mode 3/A Code', length: 2, parse: this.parseMode3A.bind(this) },
      // I048/080 - Mode C Code
      '080': { name: 'Mode C Code', length: 2, parse: this.parseModeC.bind(this) },
      // I048/100 - Flight Level
      '100': { name: 'Flight Level', length: 2, parse: this.parseFlightLevel.bind(this) },
      // I048/140 - Aircraft Identification
      '140': { name: 'Aircraft Identification', length: 6, parse: this.parseAircraftID.bind(this) },
      // I048/160 - Mode S MB Data
      '160': { name: 'Mode S MB Data', length: 'variable', parse: this.parseModeS.bind(this) },
      // I048/170 - Track Status
      '170': { name: 'Track Status', length: 1, parse: this.parseTrackStatus.bind(this) },
      // I048/200 - Calculated Track Velocity in Cartesian Coordinates
      '200': { name: 'Track Velocity Cartesian', length: 4, parse: this.parseVelocityCartesian.bind(this) },
      // I048/210 - Calculated Track Velocity in Polar Coordinates
      '210': { name: 'Track Velocity Polar', length: 4, parse: this.parseVelocityPolar.bind(this) },
      // I048/220 - Calculated Acceleration
      '220': { name: 'Calculated Acceleration', length: 2, parse: this.parseAcceleration.bind(this) },
      // I048/230 - Target Address
      '230': { name: 'Target Address', length: 3, parse: this.parseTargetAddress.bind(this) },
      // I048/250 - Time of Day
      '250': { name: 'Time of Day', length: 3, parse: this.parseTimeOfDay.bind(this) },
      // I048/260 - Track Detection
      '260': { name: 'Track Detection', length: 2, parse: this.parseTrackDetection.bind(this) },
      // I048/270 - Service Identification
      '270': { name: 'Service Identification', length: 1, parse: this.parseServiceID.bind(this) },
      // I048/290 - Operational Mode
      '290': { name: 'Operational Mode', length: 1, parse: this.parseOperationalMode.bind(this) },
      // I048/300 - Range and Bearing from Radar
      '300': { name: 'Range and Bearing', length: 4, parse: this.parseRangeBearing.bind(this) }
    };
  }

  /**
   * Parse raw ASTERIX data
   * @param {Buffer} buffer - Raw UDP packet data
   * @returns {Object} Parsed ASTERIX records
   */
  parse(buffer) {
    const results = {
      records: [],
      errors: []
    };
    
    if (!buffer || buffer.length < 2) {
      results.errors.push('Invalid buffer length');
      return results;
    }
    
    let offset = 0;
    
    while (offset < buffer.length) {
      try {
        // Read length (1 or 2 bytes, most significant bit indicates format)
        let recordLen;
        const firstByte = buffer[offset];
        
        if (firstByte & 0x80) {
          // 15-bit length format
          recordLen = ((firstByte & 0x7F) << 8) | buffer[offset + 1];
          offset += 2;
        } else {
          // 8-bit length format
          recordLen = firstByte;
          offset += 1;
        }
        
        if (recordLen < 1 || offset + recordLen > buffer.length) {
          break;
        }
        
        // Read category
        const category = buffer[offset];
        offset += 1;
        
        // Get data (excluding category byte)
        const data = buffer.slice(offset, offset + recordLen - 1);
        
        if (this.categories[category]) {
          const parsed = this.categories[category].parse(data);
          parsed.category = category;
          parsed.categoryName = this.categories[category].name;
          results.records.push(parsed);
        } else {
          results.errors.push(`Unknown category: ${category}`);
        }
        
        offset += recordLen - 1;
        
      } catch (err) {
        results.errors.push(`Parse error at offset ${offset}: ${err.message}`);
        break;
      }
    }
    
    return results;
  }

  /**
   * Parse CAT034 - Radar Service Messages
   * @param {Buffer} data - Data portion
   * @returns {Object} Parsed data
   */
  parseCAT034(data) {
    const result = {
      type: 'CAT034',
      messages: []
    };
    
    // Simplified parsing - extract what we can
    let offset = 0;
    
    while (offset < data.length) {
      try {
        // Read record length
        if (offset >= data.length) break;
        
        const msgLen = data[offset];
        offset += 1;
        
        if (msgLen === 0 || offset + msgLen > data.length) break;
        
        const msgData = data.slice(offset, offset + msgLen);
        
        // Try to extract message type from first byte
        const msgType = msgData[0];
        
        result.messages.push({
          type: msgType,
          raw: msgData.toString('hex')
        });
        
        offset += msgLen;
        
      } catch (err) {
        break;
      }
    }
    
    return result;
  }

  /**
   * Parse CAT048 - Radar Target Reports
   * @param {Buffer} data - Data portion
   * @returns {Object} Parsed data
   */
  parseCAT048(data) {
    const result = {
      type: 'CAT048',
      targets: [],
      sac: null,
      sic: null
    };
    
    let offset = 0;
    
    // Parse through FX (Field Extension) indicators
    // FSPEC (Field Specification) - bitmask indicating present fields
    const fspec = [];
    while (offset < data.length) {
      const byte = data[offset];
      fspec.push(byte);
      offset += 1;
      if (!(byte & 0x01)) break; // Last FSPEC byte has LSB = 0
    }
    
    // Track which data items are present
    const presentItems = this.getPresentItems(fspec);
    
    // Parse data items in order
    for (const item of presentItems) {
      if (offset >= data.length) break;
      
      const parser = this.dataItems[item];
      if (parser) {
        try {
          const parsed = parser(data, offset);
          if (parsed) {
            offset += parsed.length;
            
            // Store SAC/SIC at top level
            if (item === '010') {
              result.sac = parsed.sac;
              result.sic = parsed.sic;
            }
            
            result.targets.push({
              item: item,
              name: parser.name,
              value: parsed.value,
              raw: parsed.raw
            });
          }
        } catch (err) {
          break;
        }
      }
    }
    
    // Flatten to more useful format
    return this.flattenCAT048(result);
  }

  /**
   * Get list of present data items from FSPEC
   * @param {Array} fspec - Field specification bytes
   * @returns {Array} List of item codes
   */
  getPresentItems(fspec) {
    const items = [];
    const itemOrder = ['010', '020', '040', '042', '070', '080', '100', '140', '160', '170', 
                       '200', '210', '220', '230', '250', '260', '270', '290', '300'];
    
    let bitIndex = 0;
    let byteIndex = 0;
    
    for (const code of itemOrder) {
      if (byteIndex >= fspec.length) break;
      
      const byte = fspec[byteIndex];
      const bit = (byte >> (6 - (bitIndex % 8))) & 0x01;
      
      if (bit) {
        items.push(code);
      }
      
      bitIndex++;
      if (bitIndex % 8 === 0) byteIndex++;
    }
    
    return items;
  }

  /**
   * Flatten CAT048 to more useful format
   * @param {Object} parsed - Raw parsed data
   * @returns {Object} Flattened data
   */
  flattenCAT048(parsed) {
    const result = {
      type: 'CAT048',
      sac: parsed.sac,
      sic: parsed.sic,
      targetNumber: null,
      mode3A: null,
      flightLevel: null,
      latitude: null,
      longitude: null,
      callsign: null,
      targetAddress: null,
      timeOfDay: null
    };
    
    for (const target of parsed.targets) {
      switch (target.item) {
        case '020':
          result.targetNumber = target.value;
          break;
        case '040':
          result.latitude = target.value.lat;
          result.longitude = target.value.lng;
          break;
        case '070':
          result.mode3A = target.value;
          break;
        case '100':
          result.flightLevel = target.value;
          break;
        case '140':
          result.callsign = target.value;
          break;
        case '230':
          result.targetAddress = target.value;
          break;
        case '250':
          result.timeOfDay = target.value;
          break;
      }
    }
    
    return result;
  }

  // ========== Individual Data Item Parsers ==========

  parseDataSourceIdentifier(data, offset) {
    if (offset + 2 > data.length) return null;
    
    const sac = data[offset];
    const sic = data[offset + 1];
    
    return {
      sac,
      sic,
      value: { sac, sic },
      length: 2,
      raw: data.slice(offset, offset + 2).toString('hex')
    };
  }

  parseTrackNumber(data, offset) {
    if (offset + 1 > data.length) return null;
    
    const trackNum = data[offset];
    
    return {
      trackNumber: trackNum,
      value: trackNum,
      length: 1,
      raw: data.slice(offset, offset + 1).toString('hex')
    };
  }

  parsePosition(data, offset) {
    if (offset + 8 > data.length) return null;
    
    // Latitude: 32-bit signed integer, 0.000005477 rad per LSB (≈0.314m)
    // Longitude: 32-bit signed integer, 0.000005477 rad per LSB
    const latRaw = data.readInt32BE(offset);
    const lngRaw = data.readInt32BE(offset + 4);
    
    const lat = latRaw * 0.000005477 * (180 / Math.PI);
    const lng = lngRaw * 0.000005477 * (180 / Math.PI);
    
    return {
      lat: Math.round(lat * 100000) / 100000,
      lng: Math.round(lng * 100000) / 100000,
      value: { lat, lng },
      length: 8,
      raw: data.slice(offset, offset + 8).toString('hex')
    };
  }

  parseCartesianPosition(data, offset) {
    if (offset + 6 > data.length) return null;
    
    // X: 16-bit, 0.5m per LSB
    // Y: 16-bit, 0.5m per LSB
    // Z: 16-bit, 0.5m per LSB
    const x = data.readInt16BE(offset) * 0.5;
    const y = data.readInt16BE(offset + 2) * 0.5;
    const z = data.readInt16BE(offset + 4) * 0.5;
    
    return {
      x, y, z,
      value: { x, y, z },
      length: 6,
      raw: data.slice(offset, offset + 6).toString('hex')
    };
  }

  parseMode3A(data, offset) {
    if (offset + 2 > data.length) return null;
    
    const byte1 = data[offset];
    const byte2 = data[offset + 1];
    
    // Mode 3/A is in bits 12-23 of 16-bit field
    // But commonly transmitted as two bytes with A1-A4 in second byte
    const code = ((byte1 & 0x0F) << 8) | byte2;
    
    // Format as octal string (e.g., "2345")
    const a4 = (code >> 9) & 0x07;
    const a2 = (code >> 6) & 0x07;
    const a1 = (code >> 3) & 0x07;
    const a0 = code & 0x07;
    
    const octal = `${a4}${a2}${a1}${a0}`;
    
    return {
      code: code,
      octal: octal,
      value: octal,
      length: 2,
      raw: data.slice(offset, offset + 2).toString('hex')
    };
  }

  parseModeC(data, offset) {
    if (offset + 2 > data.length) return null;
    
    // Mode C is 16-bit signed integer, 25ft per LSB
    const code = data.readInt16BE(offset);
    const altitude = code * 25; // feet
    
    return {
      code: code,
      altitude: altitude,
      altitudeFeet: altitude,
      altitudeFeet: Math.round(altitude / 100) * 100, // rounded to nearest 100ft
      value: altitude,
      length: 2,
      raw: data.slice(offset, offset + 2).toString('hex')
    };
  }

  parseFlightLevel(data, offset) {
    if (offset + 2 > data.length) return null;
    
    // Flight Level is 14-bit, 25ft per LSB, offset 1000
    const raw = (data[offset] << 8) | data[offset + 1];
    const fl = (raw & 0x3FFF) * 0.25; // 1/4 = 0.25
    
    return {
      flightLevel: fl,
      value: fl,
      length: 2,
      raw: data.slice(offset, offset + 2).toString('hex')
    };
  }

  parseAircraftID(data, offset) {
    if (offset + 6 > data.length) return null;
    
    // 6 characters, each 6 bits (ASCII subset)
    let callsign = '';
    for (let i = 0; i < 6; i++) {
      const char = data[offset + i];
      if (char >= 32 && char <= 126) {
        callsign += String.fromCharCode(char);
      }
    }
    callsign = callsign.trim();
    
    return {
      callsign: callsign,
      value: callsign,
      length: 6,
      raw: data.slice(offset, offset + 6).toString('hex')
    };
  }

  parseModeS(data, offset) {
    // Variable length - skip for now
    return null;
  }

  parseTrackStatus(data, offset) {
    if (offset + 1 > data.length) return null;
    
    const status = data[offset];
    
    return {
      status: status,
      value: {
        currentlyNotUpdated: (status & 0x01) !== 0,
        coasting: (status & 0x02) !== 0,
        trackInhibited: (status & 0x04) !== 0,
        trackMerged: (status & 0x08) !== 0
      },
      length: 1,
      raw: data.slice(offset, offset + 1).toString('hex')
    };
  }

  parseVelocityCartesian(data, offset) {
    if (offset + 4 > data.length) return null;
    
    // Vx: 16-bit, 0.25m/s per LSB
    // Vy: 16-bit, 0.25m/s per LSB
    const vx = data.readInt16BE(offset) * 0.25;
    const vy = data.readInt16BE(offset + 2) * 0.25;
    
    return {
      vx: vx,
      vy: vy,
      value: { vx, vy },
      length: 4,
      raw: data.slice(offset, offset + 4).toString('hex')
    };
  }

  parseVelocityPolar(data, offset) {
    if (offset + 4 > data.length) return null;
    
    // Ground speed: 16-bit, 0.25m/s per LSB
    // Heading: 360/65536 deg per LSB (0.0055 deg)
    const gs = data.readUInt16BE(offset) * 0.25;
    const hdg = (data.readUInt16BE(offset + 2) * 360) / 65536;
    
    return {
      groundSpeed: gs,
      heading: hdg,
      value: { groundSpeed: gs, heading: hdg },
      length: 4,
      raw: data.slice(offset, offset + 4).toString('hex')
    };
  }

  parseAcceleration(data, offset) {
    if (offset + 2 > data.length) return null;
    
    // Ax: 8-bit, 0.25m/s² per LSB
    // Ay: 8-bit, 0.25m/s² per LSB
    const ax = data.readInt8(offset) * 0.25;
    const ay = data.readInt8(offset + 1) * 0.25;
    
    return {
      ax: ax,
      ay: ay,
      value: { ax, ay },
      length: 2,
      raw: data.slice(offset, offset + 2).toString('hex')
    };
  }

  parseTargetAddress(data, offset) {
    if (offset + 3 > data.length) return null;
    
    const addr = data.slice(offset, offset + 3).toString('hex').toUpperCase();
    
    return {
      address: addr,
      value: addr,
      length: 3,
      raw: data.slice(offset, offset + 3).toString('hex')
    };
  }

  parseTimeOfDay(data, offset) {
    if (offset + 3 > data.length) return null;
    
    // Time in seconds since midnight, 1/128s per LSB
    const time = data.readUInt32BE(offset - 1) & 0xFFFFFF; // 24-bit
    const seconds = time / 128;
    
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    return {
      time: time,
      formatted: `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`,
      value: time,
      length: 3,
      raw: data.slice(offset, offset + 3).toString('hex')
    };
  }

  parseTrackDetection(data, offset) {
    if (offset + 2 > data.length) return null;
    
    return {
      value: data.slice(offset, offset + 2).toString('hex'),
      length: 2,
      raw: data.slice(offset, offset + 2).toString('hex')
    };
  }

  parseServiceID(data, offset) {
    if (offset + 1 > data.length) return null;
    
    const service = data[offset];
    
    return {
      service: service,
      value: service,
      length: 1,
      raw: data.slice(offset, offset + 1).toString('hex')
    };
  }

  parseOperationalMode(data, offset) {
    if (offset + 1 > data.length) return null;
    
    const mode = data[offset];
    
    return {
      mode: mode,
      value: {
        rdpc: (mode & 0x01) !== 0,
        rdpcv: (mode & 0x02) !== 0
      },
      length: 1,
      raw: data.slice(offset, offset + 1).toString('hex')
    };
  }

  parseRangeBearing(data, offset) {
    if (offset + 4 > data.length) return null;
    
    // Range: 16-bit, 0.5NM per LSB
    // Bearing: 16-bit, 360/65536 deg per LSB
    const range = data.readUInt16BE(offset) * 0.5;
    const bearing = (data.readUInt16BE(offset + 2) * 360) / 65536;
    
    return {
      range: range,
      bearing: bearing,
      value: { range, bearing },
      length: 4,
      raw: data.slice(offset, offset + 4).toString('hex')
    };
  }
}

// Export for Node.js
module.exports = AsterixParser;

