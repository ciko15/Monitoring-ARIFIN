const net = require('net');
const client = new net.Socket();
client.setTimeout(15000);

let acc = Buffer.alloc(0);

client.connect(502, '172.16.10.91', () => {
    console.log('Connected to 172.16.10.91:502');
});

client.on('data', (data) => {
    console.log('Received chunk of length:', data.length);
    acc = Buffer.concat([acc, data]);
    console.log('Total accumulated:', acc.length);
    console.log('Raw hex:', acc.toString('hex'));
    if (acc.length >= 69) {
        client.destroy();
    }
});

client.on('timeout', () => {
    console.log('Timeout');
    client.destroy();
});

client.on('error', (err) => {
    console.error('Error:', err.message);
});
