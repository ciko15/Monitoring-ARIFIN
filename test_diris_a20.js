const DirisA20Parser = require('./src/parsers/diris_a20');

const parser = new DirisA20Parser({});

const rawHex = "01 03 40 00 85 85 2B 00 00 93 7E 00 00 92 C7 00 00 93 FA 00 00 55 74 00 00 54 DD 00 00 55 04 00 00 13 85 00 00 7A 80 00 00 7A F8 00 00 7D 00 00 00 2A 58 00 00 07 6D FF FF FC D7 00 00 08 12 FF FF FC 68 BB 8D";
const buffer = Buffer.from(rawHex.split(' ').map(h => parseInt(h, 16)));

// Simulate fragmented TCP delivery
console.log("Testing with fragmented delivery...");
let res1 = parser.parse(buffer.slice(0, 10));
console.log("Chunk 1:", res1.success, res1.status);

let res2 = parser.parse(buffer.slice(10, 40));
console.log("Chunk 2:", res2.success, res2.status);

let res3 = parser.parse(buffer.slice(40));
console.log("Chunk 3:", res3.success, res3.status);

if (res3.success) {
    console.log("\nDecoded Data:");
    console.log(JSON.stringify(res3.data, null, 2));
} else {
    console.error("Failed to parse.");
}
