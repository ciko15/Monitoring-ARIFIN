/**
 * ASTERIX Parser
 * Aviation Surveillance Data Format
 * DOC 9926 - Asterix Specification
 */

const Buffer = require('buffer').Buffer;

/**
 * ASTERIX Category Definitions
 * Each category has a specific data item structure
 */
const CATEGORIES = {
  // Category 010 - Target Report
  10: {
    name: 'Target Report',
    items: {
      'I010': { name: 'Data Source Identifier', length: 2 },
      'I140': { name: 'Track Number', length: 1 },
      'I040': { name: 'Time of Track', length: 3 },
      'I020': { name: 'Position in WGS-84', length: 8 },
      'I042': { name: 'Position in Cartesian', length: 4 },
      'I200': { name: 'Track Velocity in Polar', length: 4 },
      'I202': { name: 'Track Velocity in Cartesian', length: 4 },
      'I060': { name: 'Track Acceleration', length: 2 },
      'I220': { name: 'Target Address', length: 3 },
      'I230': { name: 'Target Identification', length: 6 },
      'I245': { name: 'Target Identification (ACID)', length: 7 },
      'I250': { name: 'Mode-3/A Code', length: 2 },
      'I260': { name: 'Flight Level', length: 2 },
      'I270': { name: 'Comm Capability', length: 1 },
      'I280': { name: 'Special Purpose Code', length: 1 },
      'I290': { name: 'Status of Plot', length: 1 },
      'I500': { name: 'Mode S MB Data', length: 7 },
      'I510': { name: 'Mode S MB Data (Extended)', length: 13 },
      'I520': { name: 'Target Size & Orientation', length: 2 },
      'I550': { name: 'Presence', length: 1 },
      'I580': { name: 'Amplitude of Primary Plot', length: 1 },
      'I610': { name: 'Coordinates in Polar', length: 4 }
    }
  },
  // Category 021 - ADS-B
  21: {
    name: 'ADS-B',
    items: {
      'I021': { name: 'Data Source Identifier', length: 2 },
      'I140': { name: 'Target Identification', length: 2 },
      'I145': { name: 'Target Identification (8 chars)', length: 8 },
      'I040': { name: 'Time of Track', length: 3 },
      'I020': { name: 'Position in WGS-84', length: 10 },
      'I130': { name: 'Geometric Altitude', length: 2 },
      'I080': { name: 'Flight Level', length: 2 },
      'I230': { name: 'Ground Vector', length: 4 },
      'I110': { name: 'Track Angle', length: 1 },
      'I295': { name: 'Ground Speed', length: 2 },
      'I380': { name: 'Vertical Rate', length: 2 },
      'I460': { name: 'Link Technology', length: 1 },
      'I500': { name: 'Emitter Category', length: 1 },
      'I240': { name: 'Mode-3/A Code', length: 2 },
      'I550': { name: 'Quality Indicators', length: 4 },
      'I580': { name: 'Trajectory Intent', length: 14 },
      'I600': { name: 'Aircraft Operational Status', length: 2 }
    }
  }
};

/**
 * Parse ASTERIX data block
 * @param {Buffer} buffer - Raw ASTERIX data
 * @returns {Array} - Array of parsed targets
 */
function parseAsterix(buffer) {
  const results = [];
  let offset = 0;

  while (offset < buffer.length) {
    try {
      // Read FSPEC (Field Specification)
      const fspec = [];
      let fsByte = buffer[offset++];
      fspec.push(fsByte);

      // Check for extended FSPEC
      while (fsByte & 0x01) {
        if (offset >= buffer.length) break;
        fsByte = buffer[offset++];
        fspec.push(fsByte);
      }

      // Parse data items based on FSPEC
      const dataItems = parseFSPEC(fspec);
      const target = parseDataItems(buffer, offset, dataItems);
      
      if (target) {
        results.push(target);
      }

      // Move offset to next record
      offset = findNextRecord(offset, buffer, fspec);

    } catch (err) {
      console.error('[ASTERIX] Parse error:', err.message);
      offset++;
    }
  }

  return results;
}

/**
 * Parse FSPEC to determine which data items are present
 */
function parseFSPEC(fspec) {
  const items = [];
  
  // Bit mapping for standard FSPEC
  const bitMap = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02];
  
  fspec.forEach((byte, byteIndex) => {
    for (let i = 0; i < 7; i++) {
      if (byte & bitMap[i]) {
        // Construct item indicator (FSPEC byte index + bit position)
        const indicator = (byteIndex * 7) + i;
        items.push(indicator);
      }
    }
  });

  return items;
}

/**
 * Parse data items based on FSPEC indicators
 */
function parseDataItems(buffer, offset, dataItems) {
  const target = {
    category: null,
    timestamp: new Date().toISOString(),
    icao24: null,
    callsign: null,
    latitude: null,
    longitude: null,
    altitude: null,
    groundSpeed: null,
    trackAngle: null,
    verticalRate: null,
    rawData: {}
  };

  try {
    // Read category
    if (buffer.length >= offset + 1) {
      target.category = buffer[offset];
    }

    // Parse position data
    // I020 - Position in WGS-84 (Lat/Lon)
    // Format: 4 bytes latitude (scaled), 4 bytes longitude (scaled)
    if (buffer.length >= offset + 8) {
      const latRaw = buffer.readInt32BE(offset);
      const lonRaw = buffer.readInt32BE(offset + 4);
      
      // Scale factor: 2^31 / 180 degrees
      target.latitude = latRaw / (Math.pow(2, 31) / 180);
      target.longitude = lonRaw / (Math.pow(2, 31) / 180);
      
      target.rawData.position = {
        lat: target.latitude,
        lon: target.longitude
      };
    }

    // Parse altitude (I080 or I130)
    if (buffer.length >= offset + 10) {
      const altRaw = buffer.readUInt16BE(offset + 8);
      // Altitude is in 25ft increments, bit 14 = sign
      const sign = altRaw & 0x4000 ? -1 : 1;
      target.altitude = ((altRaw & 0x3FFF) * 25 * sign);
    }

  } catch (err) {
    console.error('[ASTERIX] Data items parse error:', err.message);
  }

  return target;
}

/**
 * Find next record offset
 */
function findNextRecordOffset(buffer, startOffset) {
  let offset = startOffset;
  
  // Simple approach: look for next category byte
  // In real implementation, would parse length from record
  
  return offset + 100; // Default skip
}

/**
 * Extract ICAO24 address from ADS-B data
 */
function extractIcao24(buffer, offset) {
  if (buffer.length < offset + 3) return null;
  
  const icao = buffer.slice(offset, offset + 3);
  return icao.toString('hex').toUpperCase();
}

/**
 * Extract callsign from ADS-B data
 */
function extractCallsign(buffer, offset) {
  if (buffer.length < offset + 6) return null;
  
  const callsign = buffer.slice(offset, offset + 6);
  // Callsign is typically left-padded with spaces
  return callsign.toString('ascii').trim().replace(/\s+$/, '');
}

/**
 * Decode altitude with QA (Quality Alert) bits
 */
function decodeAltitude(altitudeWord) {
  if (altitudeWord === undefined || altitudeWord === null) return null;
  
  // Check for invalid altitude
  if (altitudeWord === 0) return null;
  
  // Bit 14 = Q-bit (25ft vs 100ft)
  const qBit = (altitudeWord >> 13) & 0x01;
  const increment = qBit ? 25 : 100;
  
  // Remove Q-bit and sign bit, then multiply
  const value = (altitudeWord & 0x1FFF) * increment;
  
  return value;
}

/**
 * Convert ground speed from polar to magnitude
 */
function groundSpeedToMagnitude(gsHi, gsLo) {
  const gs = ((gsHi & 0xFF) << 8) | (gsLo & 0xFF);
  return gs * 0.5; // Scale factor for knots
}

/**
 * Check if data is valid ASTERIX
 */
function isValidAsterix(buffer) {
  if (!buffer || buffer.length < 3) return false;
  
  // Check for valid LSB/MSB
  const len = buffer.readUInt16BE(1);
  return len > 0 && len <= buffer.length;
}

/**
 * Parse single ASTERIX record
 */
function parseRecord(buffer) {
  if (!isValidAsterix(buffer)) {
    return null;
  }

  const length = buffer.readUInt16BE(1);
  const category = buffer[0];

  if (!CATEGORIES[category]) {
    console.warn(`[ASTERIX] Unknown category: ${category}`);
    return null;
  }

  const record = {
    category: category,
    categoryName: CATEGORIES[category].name,
    length: length,
    timestamp: new Date().toISOString(),
    data: {}
  };

  // Parse based on category
  let offset = 3; // Skip CAT, LEN

  if (category === 10) {
    record.data = parseCategory010(buffer, offset);
  } else if (category === 21) {
    record.data = parseCategory021(buffer, offset);
  }

  return record;
}

/**
 * Parse Category 010 - Target Report
 */
function parseCategory010(buffer, offset) {
  const data = {};
  
  // I010 - Data Source Identifier (2 bytes)
  if (buffer.length >= offset + 2) {
    const sac = buffer[offset];
    const sic = buffer[offset + 1];
    data.source = { sac, sic };
  }

  // I040 - Time of Track (3 bytes)
  if (buffer.length >= offset + 5) {
    const timeRaw = buffer.readUIntBE(offset + 2, 3);
    data.time = timeRaw / 128; // 1/128 second resolution
  }

  // I020 - Position WGS-84
  if (buffer.length >= offset + 13) {
    const lat = buffer.readInt32BE(offset + 5) / (Math.pow(2, 31) / 180);
    const lon = buffer.readInt32BE(offset + 9) / (Math.pow(2, 31) / 180);
    data.position = { lat, lon };
  }

  // I060 - Track Velocity in Polar
  if (buffer.length >= offset + 17) {
    const groundSpeed = buffer.readUInt16BE(offset + 13) * 0.22; // knots
    const trackAngle = buffer.readUInt16BE(offset + 15) * 0.0055; // degrees
    data.velocity = { groundSpeed, trackAngle };
  }

  return data;
}

/**
 * Parse Category 021 - ADS-B
 */
function parseCategory021(buffer, offset) {
  const data = {};
  
  // I021 - Data Source Identifier
  if (buffer.length >= offset + 2) {
    const sac = buffer[offset];
    const sic = buffer[offset + 1];
    data.source = { sac, sic };
  }

  // I145 - Target Identification (8 chars)
  if (buffer.length >= offset + 10) {
    data.callsign = buffer.slice(offset + 2, offset + 9).toString('ascii').trim();
  }

  // I020 - Position in WGS-84
  if (buffer.length >= offset + 20) {
    const lat = buffer.readInt32BE(offset + 10) / (Math.pow(2, 31) / 180);
    const lon = buffer.readInt32BE(offset + 14) / (Math.pow(2, 31) / 180);
    const alt = buffer.readUInt16BE(offset + 18);
    data.position = { lat, lon, altitude: decodeAltitude(alt) };
  }

  // I295 - Ground Speed
  if (buffer.length >= offset + 22) {
    const gs = buffer.readUInt16BE(offset + 20);
    data.groundSpeed = gs * 0.5; // knots
  }

  // I110 - Track Angle
  if (buffer.length >= offset + 23) {
    data.trackAngle = buffer[offset + 22] * 360 / 256;
  }

  // I380 - Vertical Rate
  if (buffer.length >= offset + 25) {
    const vr = buffer.readInt16BE(offset + 23);
    data.verticalRate = vr * 6.25; // feet/min
  }

  return data;
}

module.exports = {
  parseAsterix,
  parseRecord,
  CATEGORIES,
  extractIcao24,
  extractCallsign,
  decodeAltitude,
  isValidAsterix
};
