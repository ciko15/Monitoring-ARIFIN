#!/usr/bin/env node

/**
 * SNMP Electrical Parameter Simulator
 * Allows injection of custom electrical input parameters for testing
 * 
 * Usage: 
 *   node snmp-electrical-simulator.js
 *   
 * To change values, edit the CONFIG section below
 */

const dgram = require('dgram');

// ============================================
// CONFIGURATION - Edit these values as needed
// ============================================

const CONFIG = {
  // Server settings
  port: 16100,
  host: '127.0.0.1',
  
  // Community strings
  community: 'moxa_ioThinx_4150',
  
  // Device info
  deviceName: 'ioThinx-PowerUnit-01',
  firmware: 'FW-1.0.3',
  uptime: 86400,
  
  // === DIGITAL INPUTS (DI) ===
  digitalInput1: 1,  // 0=off, 1=on
  digitalInput2: 0,
  digitalInput3: 1,
  
  // === ANALOG INPUTS (AI) - Electrical Parameters ===
  // AI1: Voltage (V)
  analogInput1Enable: 1,
  analogInput1Value: 220,    // <-- CHANGE THIS: Voltage in Volts (e.g., 220, 230, 240)
  analogInput1Unit: 1,       // 1=V, 2=mV
  
  // AI2: Current (A)  
  analogInput2Enable: 1,
  analogInput2Value: 10,     // <-- CHANGE THIS: Current in Amps
  analogInput2Unit: 1,       // 1=A, 2=mA
  
  // AI3: Power (W)
  analogInput3Enable: 1,
  analogInput3Value: 2200,   // <-- CHANGE THIS: Power in Watts
  analogInput3Unit: 1,       // 1=W, 2=kW
  
  // === RELAY OUTPUTS (DO) ===
  relayOutput1Enable: 1,
  relayOutput1Status: 1,     // 0=off, 1=on
  relayOutput1Voltage: 220,  // <-- CHANGE THIS: Output voltage
  
  relayOutput2Enable: 1,
  relayOutput2Status: 0,
  relayOutput2Voltage: 0,
  
  // === POWER STATUS ===
  powerStatus: 1,            // 0=off, 1=on, 2=standby
  batteryStatus: 0,          // 0=normal, 1=low, 2=critical
  
  // === ENVIRONMENTAL ===
  temperature: 25,           // <-- CHANGE THIS: Temperature in Celsius
  humidity: 60,              // <-- CHANGE THIS: Humidity in %
  alarmStatus: 0             // 0=normal, 1=warning, 2=critical
};

// ============================================
// OID Base
// ============================================
const OID_BASE = '1.3.6.1.4.1.50000';

// Generate response based on CONFIG
function generateResponse() {
  return {
    // Device Info (OID 1.x)
    '1.1.0': CONFIG.deviceName,
    '1.2.0': CONFIG.firmware,
    '1.3.0': String(CONFIG.uptime),
    
    // Digital Inputs (OID 2.x)
    '2.1.0': CONFIG.digitalInput1,
    '2.2.0': CONFIG.digitalInput2,
    '2.3.0': CONFIG.digitalInput3,
    
    // Analog Input 1 - Voltage (OID 3.x)
    '3.1.0': CONFIG.analogInput1Enable,
    '3.2.0': CONFIG.analogInput1Value,
    '3.3.0': CONFIG.analogInput1Unit,
    
    // Analog Input 2 - Current (OID 4.x) - using 4.x for second AI
    '4.1.0': CONFIG.analogInput2Enable,
    '4.2.0': CONFIG.analogInput2Value,
    '4.3.0': CONFIG.analogInput2Unit,
    
    // Analog Input 3 - Power (OID 5.x)
    '5.1.0': CONFIG.analogInput3Enable,
    '5.2.0': CONFIG.analogInput3Value,
    '5.3.0': CONFIG.analogInput3Unit,
    
    // Relay Output 1 (OID 6.x)
    '6.1.0': CONFIG.relayOutput1Enable,
    '6.2.0': CONFIG.relayOutput1Status,
    '6.3.0': CONFIG.relayOutput1Voltage,
    
    // Relay Output 2 (OID 7.x)
    '7.1.0': CONFIG.relayOutput2Enable,
    '7.2.0': CONFIG.relayOutput2Status,
    '7.3.0': CONFIG.relayOutput2Voltage,
    
    // Power Status (OID 8.x)
    '8.1.0': CONFIG.powerStatus,
    '8.2.0': CONFIG.batteryStatus,
    
    // Environmental (OID 9.x)
    '9.1.0': CONFIG.temperature,
    '9.2.0': CONFIG.humidity,
    '9.3.0': CONFIG.alarmStatus
  };
}

// Build SNMP response string
function buildSnmpResponse(data) {
  const lines = [];
  
  for (const [oid, value] of Object.entries(data)) {
    let type = 'STRING';
    let formattedValue = String(value);
    
    if (typeof value === 'number') {
      type = 'INTEGER';
      formattedValue = String(value);
    }
    
    lines.push(`${OID_BASE}.${oid} = ${type}: ${formattedValue}`);
  }
  
  return lines.join('\n');
}

// Parse SNMP request
function parseSnmpRequest(buffer) {
  try {
    const str = buffer.toString('binary');
    return str.includes(CONFIG.community);
  } catch (e) {
    return false;
  }
}

// Create UDP server
const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  console.log(`[SNMP] Request from ${rinfo.address}:${rinfo.port}`);
  
  if (parseSnmpRequest(msg)) {
    const responseData = generateResponse();
    const response = buildSnmpResponse(responseData);
    
    console.log(`[SNMP] Sending response with electrical params:`);
    console.log(`   Voltage: ${CONFIG.analogInput1Value}V`);
    console.log(`   Current: ${CONFIG.analogInput2Value}A`);
    console.log(`   Power: ${CONFIG.analogInput3Value}W`);
    console.log(`   Temperature: ${CONFIG.temperature}°C`);
    
    server.send(response, rinfo.port, rinfo.address, (err) => {
      if (err) console.error('[SNMP] Send error:', err);
    });
  }
});

server.on('error', (err) => {
  console.error('[SNMP] Server error:', err.message);
  server.close();
});

server.bind(CONFIG.port, CONFIG.host, () => {
  console.log('===========================================');
  console.log('⚡ SNMP Electrical Parameter Simulator');
  console.log('===========================================');
  console.log(`📡 Listening on: ${CONFIG.host}:${CONFIG.port} (UDP)`);
  console.log('');
  console.log('📋 Current Configuration:');
  console.log(`   Device: ${CONFIG.deviceName}`);
  console.log(`   ─────────────────────────────`);
  console.log(`   ⚡ Voltage (AI1): ${CONFIG.analogInput1Value}V`);
  console.log(`   🔌 Current (AI2): ${CONFIG.analogInput2Value}A`);
  console.log(`   💡 Power (AI3): ${CONFIG.analogInput3Value}W`);
  console.log(`   🌡️  Temperature: ${CONFIG.temperature}°C`);
  console.log(`   💧 Humidity: ${CONFIG.humidity}%`);
  console.log(`   🔋 Power Status: ${CONFIG.powerStatus === 1 ? 'ON' : 'OFF'}`);
  console.log(`   ⚠️  Alarm: ${CONFIG.alarmStatus === 0 ? 'Normal' : CONFIG.alarmStatus === 1 ? 'Warning' : 'Critical'}`);
  console.log('');
  console.log('🧪 Test with:');
  console.log(`   snmpwalk -v2c -c ${CONFIG.community} ${CONFIG.host}:${CONFIG.port} ${OID_BASE}`);
  console.log('');
  console.log('💡 To change values, edit CONFIG in this file');
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
