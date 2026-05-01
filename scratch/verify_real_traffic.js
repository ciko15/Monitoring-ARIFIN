const sniffer = require('../src/network/sniffer');
const monitor = require('../src/network/monitor');

// IPs discovered in Network Monitoring
const TARGET_IPS = ['169.254.5.147', '169.254.8.47'];

async function verifyTraffic() {
    console.log('--- Real Traffic Verification ---');
    console.log(`Monitoring targets: ${TARGET_IPS.join(', ')}`);
    console.log('Starting sniffer for 30 seconds...');

    try {
        // Start sniffer on default interface
        await sniffer.start();
        
        console.log(`Capture mode: ${sniffer.captureMode}`);
        
        // Wait for 30 seconds
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        const packets = sniffer.getPackets();
        const targetPackets = packets.filter(p => 
            TARGET_IPS.includes(p.source) || TARGET_IPS.includes(p.destination)
        );

        console.log(`\nResults:`);
        console.log(`Total packets captured: ${packets.length}`);
        console.log(`Packets from/to targets: ${targetPackets.length}`);

        if (targetPackets.length > 0) {
            console.log('\nSample Activity:');
            targetPackets.slice(0, 10).forEach(p => {
                console.log(`[${new Date(p.time * 1000).toLocaleTimeString()}] ${p.source} -> ${p.destination} (${p.protocol}) ${p.info}`);
            });
            
            // Analyze unique ports/protocols
            const protocols = [...new Set(targetPackets.map(p => p.protocol))];
            console.log(`\nDetected Protocols: ${protocols.join(', ')}`);
        } else {
            console.log('\nNo real-time traffic detected from these IPs in the last 30 seconds.');
            console.log('Possibilities:');
            console.log('1. Devices are silent/idle');
            console.log('2. Devices are sending on a different interface');
            console.log('3. Firewall/Permissions blocking capture');
        }

        sniffer.stop();
        process.exit(0);
    } catch (error) {
        console.error('Error during verification:', error);
        sniffer.stop();
        process.exit(1);
    }
}

verifyTraffic();
