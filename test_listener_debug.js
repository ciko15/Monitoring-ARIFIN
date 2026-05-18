/**
 * test_listener_debug.js — Debug network_listener routing
 * bun test_listener_debug.js
 */

// 1. Cek apakah method ada
const NetworkListener = require('./src/services/network_listener');
console.log('=== NetworkListener methods ===');
const proto = NetworkListener.prototype || Object.getPrototypeOf(new NetworkListener());
const methods = Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor');
console.log('Methods:', methods.join(', '));
console.log('Has startSnmpSystemListener:', methods.includes('startSnmpSystemListener'));
console.log('Has startAsterixListener   :', methods.includes('startAsterixListener'));
console.log('Has startTempHumidityListener:', methods.includes('startTempHumidityListener'));
console.log('Has startMarcRseListener   :', methods.includes('startMarcRseListener'));

// 2. Cek auth config untuk snmp_system sources
const auth = require('./db/equipment_otentication_config.json');
const snmpSources = auth.filter(a => a.parsing_id === 'snmp_system');
console.log(`\n=== SNMP sources in auth config: ${snmpSources.length} ===`);
snmpSources.slice(0, 3).forEach(s => 
    console.log(`  id=${s.id} name=${s.name} ip=${s.ip_address} parsing_id=${s.parsing_id}`)
);

// 3. Cek apakah network_listener dipakai di startup
const fs = require('fs');
const serverContent = fs.readFileSync('./src/server.ts', 'utf8');
const listenerMentions = serverContent.match(/network_listener|NetworkListener|startListener/g) || [];
console.log(`\n=== server.ts mentions of NetworkListener: ${listenerMentions.length} ===`);

// 4. Cek bagaimana listeners distart
const listenerLines = serverContent.split('\n')
    .map((l, i) => ({ n: i+1, l }))
    .filter(({l}) => l.includes('startListener') || l.includes('NetworkListener') || l.includes('network_listener'));
listenerLines.forEach(({n, l}) => console.log(`  L${n}: ${l.trim()}`));

// 5. Langsung test pollSNMP
console.log('\n=== Direct pollSNMP test ===');
const { pollSNMP } = require('./src/parsers/snmp_system');
console.log('pollSNMP type:', typeof pollSNMP);
