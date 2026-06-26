const buf = Buffer.alloc(4);
buf.writeFloatLE(99.1);
console.log(buf.toString('hex'));
