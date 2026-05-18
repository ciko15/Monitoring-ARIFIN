#!/usr/bin/env node

/**
 * Simple SNMP Simulator
 * Menjalankan SNMP agent sederhana untuk testing
 * Menggunakan snmpjs atau net-snmp yang sudah terinstall
 */

const { exec } = require('child_process');
const net = require('net');

// Konfigurasi
const SNMP_PORT = 16100;
const COMMUNITY_MOXA = 'moxa_ioThinx_4150';
const COMMUNITY_RADAR = 'radar_primary';
const COMMUNITY_PUBLIC = 'public';

// OID mappings untuk simulasi
const OID_BASE_MOXA = '1.3.6.1.4.1.50000';
const OID_BASE_RADAR = '1.3.6.1.4.1.99991';

// Generate response data
function generateMoxaResponse() {
  return {
    '1.1.0': 'ioThinx-PowerUnit-01',
    '1.2.0': 'FW-1.0.3',
    '1.3.0': '86400',
    '2.1.0': Math.floor(Math.random() * 5) + 1,  // 1-5
    '2.2.0': Math.floor(Math.random() * 50) + 20, // 20-70
    '2.3.0': Math.floor(Math.random() * 20) + 5,  // 5-25
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
    '6.1.0': 0,
    '6.2.0': 0,
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

function generateGenericResponse() {
  return {
    '1.1.0': 'Generic-Device-01',
    '1.2.0': 'v1.0.0',
    '2.1.0': Math.floor(Math.random() * 100),
    '2.2.0': Math.floor(Math.random() * 50),
    '3.1.0': 1,
    '3.2.0': 220
  };
}

// Parse SNMP request (very simplified)
function parseSnmpRequest(buffer) {
  try {
    const str = buffer.toString();
    
    // Check community string
    let community = null;
    if (str.includes(COMMUNITY_MOXA)) community = COMMUNITY_MOXA;
    else if (str.includes(COMMUNITY_RADAR)) community = COMMUNITY_RADAR;
    else if (str.includes(COMMUNITY_PUBLIC)) community = COMMUNITY_PUBLIC;
    
    // Determine OID base
    let oidBase = null;
    let responseFn = null;
    
    if (str.includes(OID_BASE_MOXA) || str.includes('50000')) {
      oidBase = OID_BASE_MOXA;
      responseFn = generateMoxaResponse;
    } else if (str.includes(OID_BASE_RADAR) || str.includes('99991')) {
      oidBase = OID_BASE_RADAR;
      responseFn = generateRadarResponse;
    } else {
      oidBase = '1.3.6.1.2.1';
      responseFn = generateGenericResponse;
    }
    
    return { community, oidBase, responseFn };
  } catch (e) {
    return null;
  }
}

// Build SNMP response (simplified ASN.1)
function buildSnmpResponse(community, oidBase, data) {
  const lines = [];
  
  for (const [oid, value] of Object.entries(data)) {
    const fullOid = `${oidBase}.${oid}`;
    let type = 'STRING';
    let formattedValue = String(value);
    
    if (typeof value === 'number') {
      type = 'INTEGER';
      formattedValue = String(value);
    }
    
    lines.push(`SNMPv2-SMI::enterprises.${fullOid} = ${type}: ${formattedValue}`);
  }
  
  return lines.join('\n');
}

// Create TCP server to simulate SNMP
const server = net.createServer((socket) => {
  console.log(`[SNMP] Connection from ${socket.remoteAddress}:${socket.remotePort}`);
  
  let buffer = '';
  
  socket.on('data', (data) => {
    buffer += data.toString();
    
    // Parse and generate response
    const parsed = parseSnmpRequest(buffer);
    
    if (parsed && parsed.responseFn) {
      const responseData = parsed.responseFn();
      const response = buildSnmpResponse(parsed.community, parsed.oidBase, responseData);
      
      console.log(`[SNMP] Responding to ${parsed.community || 'unknown'} on ${parsed.oidBase}`);
      
      socket.write(response + '\n');
    }
  });
  
  socket.on('error', (err) => {
    console.error('[SNMP] Socket error:', err.message);
  });
  
  socket.on('close', () => {
    console.log('[SNMP] Connection closed');
  });
});

server.listen(SNMP_PORT, '127.0.0.1', () => {
  console.log('===========================================');
  console.log('🎯 SNMP Simulator Running');
  console.log('===========================================');
  console.log(`📡 Listening on: 127.0.0.1:${SNMP_PORT}`);
  console.log('');
  console.log('📋 Available SNMP endpoints:');
  console.log(`   - ${COMMUNITY_MOXA} @ 127.0.0.1:${SNMP_PORT}`);
  console.log(`   - ${COMMUNITY_RADAR} @ 127.0.0.1:${SNMP_PORT}`);
  console.log(`   - ${COMMUNITY_PUBLIC} @ 127.0.0.1:161`);
  console.log('');
  console.log('🧪 Test dengan:');
  console.log(`   snmpwalk -v2c -c ${COMMUNITY_MOXA} 127.0.0.1:${SNMP_PORT} 1.3.6.1.4.1.50000`);
  console.log(`   snmpwalk -v2c -c ${COMMUNITY_RADAR} 127.0.0.1:${SNMP_PORT} 1.3.6.1.4.1.99991`);
  console.log('===========================================\n');
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
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

