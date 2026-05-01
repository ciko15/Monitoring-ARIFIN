#!/usr/bin/env node

/**
 * SNMP UDP Simulator
 * Menyimulasikan SNMP agent menggunakan UDP (kompatibel dengan snmpwalk)
 */

const dgram = require('dgram');

// Konfigurasi
const SNMP_PORT = 16100;
const COMMUNITY_MOXA = 'moxa_ioThinx_4150';
const COMMUNITY_RADAR = 'radar_primary';
const COMMUNITY_PUBLIC = 'public';

// OID Base
const OID_BASE_MOXA = '1.3.6.1.4.1.50000';
const OID_BASE_RADAR = '1.3.6.1.4.1.99991';

// Generate random data
function generateMoxaResponse() {
  return {
    '1.1.0': 'ioThinx-PowerUnit-01',
    '1.2.0': 'FW-1.0.3',
    '1.3.0': '86400',
    '2.1.0': Math.floor(Math.random() * 5) + 1,
    '2.2.0': Math.floor(Math.random() * 50) + 20,
    '2.3.0': Math.floor(Math.random() * 20) + 5,
    '3.1.0': 1,
    '3.2.0': 220 + Math.floor(Math.random() * 10),
    '3.3.0': 50 + Math.floor(Math.random() * 50),
    '4.1.0': 220 + Math.floor(Math.random() * 10),
    '4.2.0': Math.floor(Math.random() * 10),
    '4.3.0': 1000 + Math.floor(Math.random() * 500),
    '5.1.1.0': 1,
    '5.1.2.0': 0,
    '5.1.3.0': 1,
    '5.1.4.0': 0,
    '6.1.0': Math.floor(Math.random() * 30),
    '6.2.0': Math.floor(Math.random() * 60) + 20,
    '6.3.0': 0
  };
}

function generateRadarResponse() {
  return {
    '1.1.0': 1,
    '1.2.0': 4,
    '1.3.0': 'Online',
    '2.1.0': Math.floor(Math.random() * 60) + 30,
    '2.2.0': Math.floor(Math.random() * 150) + 50,
    '2.3.0': Math.floor(Math.random() * 20) + 5,
    '2.4.0': Math.floor(Math.random() * 400) + 100,
    '3.1.0': Math.floor(Math.random() * 300) + 100,
    '3.2.0': Math.floor(Math.random() * 200) + 50,
    '3.3.0': Math.floor(Math.random() * 100) + 50,
    '4.1.0': Math.floor(Math.random() * 100) + 50,
    '4.2.0': 1,
    '4.3.0': Math.floor(Math.random() * 4000) + 1000,
    '5.1.0': -75 + Math.floor(Math.random() * 30),
    '5.2.0': 1,
    '5.3.0': Math.floor(Math.random() * 150) + 50,
    '6.1.0': Math.floor(Math.random() * 40) + 20,
    '6.2.0': 1,
    '6.3.0': Math.floor(Math.random() * 80) + 30,
    '7.1.0': 0,
    '7.2.0': 0,
    '7.3.0': 0
  };
}

// Parse SNMP request (SNMPv2c GET/BULK)
function parseSnmpRequest(buffer) {
  try {
    const str = buffer.toString('binary');
    
    // Check community string
    let community = null;
    if (str.includes(COMMUNITY_MOXA)) community = COMMUNITY_MOXA;
    else if (str.includes(COMMUNITY_RADAR)) community = COMMUNITY_RADAR;
    else if (str.includes(COMMUNITY_PUBLIC)) community = COMMUNITY_PUBLIC;
    
    // Determine OID base
    let responseFn = null;
    
    if (str.includes('50000') || str.includes(OID_BASE_MOXA)) {
      responseFn = generateMoxaResponse;
    } else if (str.includes('99991') || str.includes(OID_BASE_RADAR)) {
      responseFn = generateRadarResponse;
    } else {
      responseFn = generateMoxaResponse; // default
    }
    
    return { community, responseFn };
  } catch (e) {
    console.log('[SNMP] Parse error:', e.message);
    return null;
  }
}

// Build SNMP response (SNMPv2c)
function buildSnmpResponse(community, data) {
  const lines = [];
  
  for (const [oid, value] of Object.entries(data)) {
    let type = 'STRING';
    let formattedValue = String(value);
    
    if (typeof value === 'number') {
      type = 'INTEGER';
      formattedValue = String(value);
    }
    
    // Use enterprises.50000 or enterprises.99991 based on data
    const baseOid = JSON.stringify(data).includes('ioThinx') ? OID_BASE_MOXA : OID_BASE_RADAR;
    lines.push(`${baseOid}.${oid} = ${type}: ${formattedValue}`);
  }
  
  return lines.join('\n');
}

// Create UDP server
const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  console.log(`[SNMP] Received request from ${rinfo.address}:${rinfo.port}`);
  
  const parsed = parseSnmpRequest(msg);
  
  if (parsed && parsed.responseFn) {
    const responseData = parsed.responseFn();
    const response = buildSnmpResponse(parsed.community, responseData);
    
    console.log(`[SNMP] Sending response for ${parsed.community || 'unknown'}`);
    
    // Send response
    server.send(response, rinfo.port, rinfo.address, (err) => {
      if (err) console.error('[SNMP] Send error:', err);
    });
  }
});

server.on('error', (err) => {
  console.error('[SNMP] Server error:', err.message);
  server.close();
});

server.bind(SNMP_PORT, '127.0.0.1', () => {
  console.log('===========================================');
  console.log('🎯 SNMP UDP Simulator Running');
  console.log('===========================================');
  console.log(`📡 Listening on: 127.0.0.1:${SNMP_PORT} (UDP)`);
  console.log('');
  console.log('📋 Available SNMP endpoints:');
  console.log(`   - ${COMMUNITY_MOXA} @ 127.0.0.1:${SNMP_PORT}`);
  console.log(`   - ${COMMUNITY_RADAR} @ 127.0.0.1:${SNMP_PORT}`);
  console.log('');
  console.log('🧪 Test dengan:');
  console.log(`   snmpwalk -v2c -c ${COMMUNITY_MOXA} 127.0.0.1:${SNMP_PORT} 1.3.6.1.4.1.50000`);
  console.log(`   snmpwalk -v2c -c ${COMMUNITY_RADAR} 127.0.0.1:${SNMP_PORT} 1.3.6.1.4.1.99991`);
  console.log('===========================================\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down SNMP Simulator...');
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down SNMP Simulator...');
  server.close();
  process.exit(0);
});
