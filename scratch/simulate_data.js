/**
 * Simulation Script for Issue #19
 * Sends raw UDP packets to ports configured in CIKO
 */

const udp = require('dgram');

const dataSources = [
    { name: 'DVOR Sentani (TX 1)', port: 4001, data: '\x01\x02N1S1=120|S2=300|S3=450|S4=150|UTC_Time={{TIME}}\x03\x01\x02G1S11=50|S12=150|S13=480|S20=1\x03' },
    { name: 'Localizer (Source)', port: 5001, data: '\x01\x02N1S1=110|S2=310|S3=440|S4=160|UTC_Time={{TIME}}\x03\x01\x02G1S11=49|S12=149|S13=479|S20=1\x03' },
    { name: 'TX 1 (Multi)', port: 6001, data: '\x01\x02G1S11=50|S12=150|S13=480|S20=1|UTC_Time={{TIME}}\x03' },
    { name: 'TX 2 (Multi)', port: 6002, data: '\x01\x02G1S11=50|S12=150|S13=480|S20=0|UTC_Time={{TIME}}\x03' },
    { name: 'SNMP Mimic Node 147', port: 6005, data: '{"ram_total": 64, "ram_used": 32, "disk_usage": 45, "cpu_usage": 20}' },
    { name: 'SNMP Mimic Node 47', port: 6006, data: '{"ram_total": 16, "ram_used": 15, "disk_usage": 96, "cpu_usage": 88}' }
];

const FREQUENCY_MS = 60000; // 1 minute

async function runSimulation() {
    const now = new Date();
    const isoTime = now.toISOString();
    console.log(`[${now.toLocaleTimeString()}] --- Starting Simulation Cycle ---`);
    
    for (const source of dataSources) {
        const client = udp.createSocket('udp4');
        const payload = source.data.replace('{{TIME}}', isoTime);
        const message = Buffer.from(payload, 'binary');
        
        client.send(message, source.port, 'localhost', (err) => {
            if (err) {
                console.error(`Error sending to ${source.name}:`, err.message);
            } else {
                console.log(`Successfully sent to ${source.name} (Port ${source.port}) with UTC_Time: ${isoTime}`);
            }
            client.close();
        });
        
        // Wait a bit between sends
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

console.log(`🚀 Continuous Simulation started (Every ${FREQUENCY_MS/1000}s)`);
console.log('Including UTC_Time in all payloads.\n');

// Initial run
runSimulation();
// Periodic runs
setInterval(runSimulation, FREQUENCY_MS);
