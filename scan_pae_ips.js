const marc = require('./src/parsers/marc_pae.js')._internal;

async function scan() {
    const ips = ['172.19.7.196', '172.19.7.197'];
    const ports = [8500, 950]; // Common PAE ports
    const startRSE = 1;
    const endRSE = 20;

    for (const ip of ips) {
        for (const port of ports) {
            console.log(`\nScanning ${ip}:${port} for RSE ID ${startRSE}-${endRSE}...`);
            try {
                const result = await marc.discoverMarcRSEs(ip, port, startRSE, endRSE, 1000);
                if (result.success && result.data.length > 0) {
                    console.log(`✅ FOUND at ${ip}:${port} ->`, result.data);
                } else {
                    console.log(`❌ No RSE found or connection refused at ${ip}:${port}`);
                }
            } catch (err) {
                console.log(`Error at ${ip}:${port} - ${err.message}`);
            }
        }
    }
    console.log("Done");
    process.exit(0);
}

scan();
