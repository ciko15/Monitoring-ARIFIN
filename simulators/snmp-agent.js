#!/usr/bin/env node

/**
 * SNMP Agent menggunakan snmp-native
 * Agent ini akan menerima request SNMP dari snmpwalk
 */

const snmp = require('snmp-native');

// Konfigurasi
const SNMP_PORT = 16100;
const COMMUNITY_MOXA = 'moxa_ioThinx_4150';
const COMMUNITY_RADAR = 'radar_primary';
const COMMUNITY_PUBLIC = 'public';

// Generate random data
function generateMoxaData() {
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

function generateRadarData() {
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

// Create SNMP server
const server = new snmp.Server({
  port: SNMP_PORT,
  host: '127.0.0.1'
});

// Handle Get requests
server.on('get', function (session, msg) {
  console.log(`[SNMP] GET request for OID: ${msg.pdu.varbinds[0].oid.join('.')}`);
  
  // Determine which data to return based on OID
  const oid = msg.pdu.varbinds[0].oid.join('.');
  let data = generateMoxaData();
  let baseOid = '1.3.6.1.4.1.50000';
  
  if (oid.includes('99991')) {
    data = generateRadarData();
    baseOid = '1.3.6.1.4.1.99991';
  }
  
  // Get the suffix OID
  const suffix = oid.replace(baseOid + '.', '');
  
  const varbinds = [];
  if (data[suffix] !== undefined) {
    const value = data[suffix];
    varbinds.push({
      oid: msg.pdu.varbinds[0].oid,
      value: value,
      type: typeof value === 'string' ? 4 : 2 // 4 = OctetString, 2 = Integer
    });
  }
  
  session.response(msg.pdu, varbinds);
});

// Handle GetNext requests (for snmpwalk)
server.on('getnext', function (session, msg) {
  const currentOid = msg.pdu.varbinds[0].oid.join('.');
  console.log(`[SNMP] GETNEXT request for OID: ${currentOid}`);
  
  let data = generateMoxaData();
  let baseOid = '1.3.6.1.4.1.50000';
  
  if (currentOid.includes('99991')) {
    data = generateRadarData();
    baseOid = '1.3.6.1.4.1.99991';
  }
  
  // Find next OID
  const keys = Object.keys(data).sort();
  let nextKey = null;
  
  for (const key of keys) {
    const fullOid = baseOid + '.' + key;
    if (fullOid > currentOid) {
      nextKey = key;
      break;
    }
  }
  
  if (nextKey) {
    const value = data[nextKey];
    const nextOid = baseOid + '.' + nextKey;
    const oidParts = nextOid.split('.').map(Number);
    
    session.response(msg.pdu, [{
      oid: oidParts,
      value: value,
      type: typeof value === 'string' ? 4 : 2
    }]);
  }
});

// Handle GetBulk requests
server.on('getbulk', function (session, msg) {
  console.log(`[SNMP] GETBULK request`);
  
  let data = generateMoxaData();
  let baseOid = '1.3.6.1.4.1.50000';
  
  const varbinds = [];
  const keys = Object.keys(data).sort();
  
  for (let i = 0; i < Math.min(20, keys.length); i++) {
    const value = data[keys[i]];
    const oidParts = (baseOid + '.' + keys[i]).split('.').map(Number);
    
    varbinds.push({
      oid: oidParts,
      value: value,
      type: typeof value === 'string' ? 4 : 2
    });
  }
  
  session.response(msg.pdu, varbinds);
});

server.on('ready', function () {
  console.log('===========================================');
  console.log('🎯 SNMP Agent (snmp-native) Running');
  console.log('===========================================');
  console.log(`📡 Listening on: 127.0.0.1:${SNMP_PORT}`);
  console.log('');
  console.log('📋 Available SNMP communities:');
  console.log(`   - ${COMMUNITY_MOXA}`);
  console.log(`   - ${COMMUNITY_RADAR}`);
  console.log(`   - ${COMMUNITY_PUBLIC}`);
  console.log('');
  console.log('🧪 Test dengan:');
  console.log(`   snmpwalk -v2c -c ${COMMUNITY_MOXA} 127.0.0.1:${SNMP_PORT} 1.3.6.1.4.1.50000`);
  console.log(`   snmpwalk -v2c -c ${COMMUNITY_RADAR} 127.0.0.1:${SNMP_PORT} 1.3.6.1.4.1.99991`);
  console.log('===========================================\n');
});

server.on('error', function (err) {
  console.error('[SNMP] Server error:', err.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down SNMP Agent...');
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down SNMP Agent...');
  server.close();
  process.exit(0);
});
