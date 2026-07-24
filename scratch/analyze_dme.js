const fs = require('fs');

const hexDump = `01021137068394068c01010103ab65
01023a3706839404e20001033cae0102df370683940a060501032ca9010270370683940b8c020103f6b801022c370683940fcc0601035e8201022237068394087b02010342a001029d370683940d520101010320240102813706839413510101010321f601027737068394118e01010103b6ec0102453706839415c902010336ce0102a43706839417e2000103e20d010267370683941ad306010384e301023537068394169b02010336670102b53908819634247e0e46010330ca010220370683941bea0201036b240102743908819637647d0e460103e4e201026a37068394196701010103390c01028837068394180301010103f51e01026e360582938601010103a6f801021b380780953403cf0601039bdd010223370683942fe2000103effb010225370683942e00010101031a5a
01023d35178b1a0e0103fc6a
01023337068394256f01010103544101023237068394246f01010103bddc0102de370683942b64010101038d610102dd370683942a6401010103d75c01026f370683942989010101031f5e01026b37068394288901010103f84a01024c370683840c19030103a9c20102113a098e5705434f4646450103181001027b37068354217c0001037542`;

const targets = {
    power1: { val: 1035, float: 1035.0, str: "1035" },
    power2: { val: 1031, float: 1031.0, str: "1031" },
    delay: { val: 4995, float: 49.95, str: "49.95" },
    eff1: { val: 91, float: 91.0, str: "91" },
    eff2: { val: 90, float: 90.0, str: "90" }
};

const buf = Buffer.from(hexDump.replace(/\s+/g, ''), 'hex');
console.log("Total bytes:", buf.length);

for (let i = 0; i < buf.length; i++) {
    // Try int8
    const v8 = buf.readUInt8(i);
    // Try int16 LE
    const v16LE = i <= buf.length - 2 ? buf.readUInt16LE(i) : null;
    const v16BE = i <= buf.length - 2 ? buf.readUInt16BE(i) : null;
    const f32LE = i <= buf.length - 4 ? buf.readFloatLE(i) : null;
    
    if (v16LE === 1035 || v16BE === 1035) console.log(`Found Power1 (1035) at offset ${i} (Int16)`);
    if (v16LE === 1031 || v16BE === 1031) console.log(`Found Power2 (1031) at offset ${i} (Int16)`);
    if (v16LE === 4995 || v16BE === 4995) console.log(`Found Delay (4995) at offset ${i} (Int16)`);
    if (Math.abs(f32LE - 49.95) < 0.01) console.log(`Found Delay Float (49.95) at offset ${i}`);
    
    if (v8 === 91) console.log(`Found Eff1 (91) at offset ${i}`);
    if (v8 === 90) console.log(`Found Eff2 (90) at offset ${i}`);
}

// Since the payload has 01 02 ... 01 03 frames
const frames = hexDump.match(/0102.*?0103.{4}/g) || [];
console.log(`Found ${frames.length} frames`);
frames.forEach(f => {
    const b = Buffer.from(f, 'hex');
    let msg = `Frame length ${b.length} (Cmd: ${b.slice(3,5).toString('hex')}): `;
    for (let i = 0; i < b.length; i++) {
        const v = b.readUInt8(i);
        if (v === 91 || v === 90) msg += `Found Eff at ${i}, `;
        if (i <= b.length - 2 && (b.readUInt16LE(i) === 1035 || b.readUInt16LE(i) === 1031)) msg += `Found Power at ${i}, `;
        if (i <= b.length - 2 && (b.readUInt16LE(i) === 4995)) msg += `Found Delay at ${i}, `;
    }
    if (msg.includes('Found')) console.log(msg);
});
