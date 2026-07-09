const fs = require('fs');

const gpBuffer = Buffer.from('7e7e7e08c10003f102d0010000d304ceff3601000000003a005e04d7fe9a019c04ffff8e000d00ffff9304ffff15041901ffff0000ffff0000ffff04fed8fdffff0000ffff5402922da8070a0000008c000000000000008c00000000000000000000000004f202db', 'hex');

const llzBuffer = Buffer.from('7e7e7e08c10003000000000005002c0001f80100000001f80600b7ff8b01d504ffff00000000ffff0300ffff000001f8ffff0100ffff0100ffff000001f8ffff0100ffff5a0252d927280a0000000006c000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f93fffefffff73f93fffef0000000000000000000000d9882f49', 'hex');

function findMatches(buffer, targets, name) {
    console.log(`\n=== Analyzing ${name} ===`);
    for (const [key, target] of Object.entries(targets)) {
        let found = false;
        for (let i = 0; i < buffer.length - 1; i += 1) { // try every byte offset
            const valLE = buffer.readInt16LE(i);
            const valBE = buffer.readInt16BE(i);
            
            const checks = [
                { val: valLE, type: 'LE', scales: [1, 10, 100, 1000, 10000] },
                { val: valBE, type: 'BE', scales: [1, 10, 100, 1000, 10000] }
            ];

            for (const check of checks) {
                for (const scale of check.scales) {
                    const scaled = check.val / scale;
                    if (Math.abs(scaled - target) <= 0.1) {
                        console.log(`Match for ${key} (${target}) -> Offset: ${i} | Endian: ${check.type} | Raw: ${check.val} | Scale: ${scale} | Computed: ${scaled}`);
                        found = true;
                    }
                }
            }
        }
        if (!found) {
            console.log(`No match for ${key} (${target})`);
        }
    }
}

const gpTargets = {
    'CL DDM': -1.7,
    'CL SDM': 79.5,
    'CL RF': 3.13,
    'DS DDM': 0.0,
    'DS SDM': 71.0,
    'DS RF': 2.83,
    'NF DDM': -10.3,
    'NF SDM': 82.8,
    'NF RF': 2.95,
    'CLR DDM': 35.3,
    'CLR SDM': 78.6,
    'CLR RF': 2.97
};

findMatches(gpBuffer, gpTargets, 'GlidePath');
