// Let's decode the hex around offset 338 and around offset 40
// At offset 338: Preceding 32 bytes hex: fa06f0063892010000118d400e1000001f986d48000000003333c64299bb16bb
// Look at that: 00 11 8d 40 0e 10 00 00
// Notice 11 8d 40 0e 10 !
// Where is 11 in that 32-byte string?
// fa 06 f0 06 38 92 01 00 (8 bytes)
// 00 11 8d 40 0e 10 00 00 (8 bytes) -> 11 8D is at byte 9!
// Then 16 bytes more: 1f 98 6d 48 00 00 00 00 33 33 c6 42 99 bb 16 bb (16 bytes)
// Then at offset 338 is 40.40!
// Distance from 11 8D to 338 = 16 + 7 = 23 bytes!

const hex338 = "fa06f0063892010000118d400e1000001f986d48000000003333c64299bb16bb";
const buf = Buffer.from(hex338, 'hex');
console.log("Length:", buf.length);
const idx118d = buf.indexOf(Buffer.from([0x11, 0x8d]));
console.log("11 8D at index:", idx118d);
console.log("Header from 11 8D:", buf.slice(idx118d, idx118d + 8).toString('hex'));
console.log("Byte 2 (Flag):", buf[idx118d + 2].toString(16));
console.log("Byte 3 (Subtype):", buf[idx118d + 3].toString(16));
console.log("Byte 4 (Source):", buf[idx118d + 4].toString(16));

// Floats in this preceding slice:
for (let i = idx118d; i <= buf.length - 4; i += 2) {
    try {
        const val = buf.readFloatLE(i);
        if (isFinite(val) && Math.abs(val) < 20000 && Math.abs(val) > 0.0001) {
            console.log(`Relative to 11 8D: off ${i - idx118d} = ${val.toFixed(3)}`);
        }
    } catch(e) {}
}
