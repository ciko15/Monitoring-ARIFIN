const fs = require('fs');

// A function to try mapping a 16-bit integer to a float
function testValue(buffer, offset, name, targetValue, tolerance = 0.5) {
  if (offset + 2 > buffer.length) return false;
  const valLE = buffer.readInt16LE(offset);
  const valBE = buffer.readInt16BE(offset);
  const uvalLE = buffer.readUInt16LE(offset);

  const scales = [1, 10, 100, 1000, 10000];
  let bestMatch = null;
  
  for (const scale of scales) {
    if (Math.abs(valLE / scale - targetValue) <= tolerance) {
      console.log(`[+] Match for ${name}: Offset ${offset} (LE) -> Raw: ${valLE}, Scale: ${scale}, Result: ${valLE/scale} (Target: ${targetValue})`);
    }
  }
}

const gpBuffer = Buffer.from('7e7e7e08c10003f102d0010000d304ceff3601000000003a005e04d7fe9a019c04ffff8e000d00ffff9304ffff15041901ffff0000ffff0000ffff04fed8fdffff0000ffff5402922da8070a0000008c000000000000008c00000000000000000000000004f202db', 'hex');

console.log('--- GP 104-byte Payload Analysis ---');
for (let i = 0; i < gpBuffer.length - 1; i++) {
  const valLE = gpBuffer.readInt16LE(i);
  console.log(`Offset ${i}: ${valLE} ( /10 = ${valLE/10}, /100 = ${valLE/100} )`);
}

