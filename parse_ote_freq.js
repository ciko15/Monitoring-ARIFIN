const { spawn } = require('child_process');
const tcpdump = spawn('tcpdump', ['-r', 'Sample pcap/ote neww.pcap', '-x', '-n', 'src host 192.168.127.55']);
let currentPacketHex = '';
tcpdump.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        if (line.match(/^\d{2}:\d{2}:\d{2}\./)) {
            processPacket(currentPacketHex);
            currentPacketHex = '';
        } else if (line.match(/^\s+0x[0-9a-fA-F]+:\s+(.*)/)) {
            currentPacketHex += line.match(/^\s+0x[0-9a-fA-F]+:\s+(.*)/)[1].replace(/ /g, '');
        }
    }
});
tcpdump.stdout.on('end', () => processPacket(currentPacketHex));

let streamBuffer = Buffer.alloc(0);
function processPacket(hexStr) {
    if (!hexStr || hexStr.length < 40) return;
    try {
        const pktBuffer = Buffer.from(hexStr, 'hex');
        const ipHeaderLen = (pktBuffer[0] & 0x0F) * 4;
        const tcpHeaderLen = (pktBuffer[ipHeaderLen + 12] >> 4) * 4;
        const payload = pktBuffer.slice(ipHeaderLen + tcpHeaderLen);
        streamBuffer = Buffer.concat([streamBuffer, payload]);
        
        while (streamBuffer.length > 0) {
            const stxIdx = streamBuffer.indexOf(0x02);
            if (stxIdx === -1) { streamBuffer = Buffer.alloc(0); break; }
            if (stxIdx > 0) streamBuffer = streamBuffer.slice(stxIdx);
            if (streamBuffer.length < 3) break;
            const len = streamBuffer[2];
            if (streamBuffer.length < 3 + len + 2) break;
            const frame = streamBuffer.slice(0, 3 + len + 2);
            streamBuffer = streamBuffer.slice(3 + len + 2);
            
            const frameHex = frame.toString('hex');
            if (frameHex.includes('1ce2') || frameHex.includes('e21c') || frameHex.includes('01ce2c') || frameHex.includes('2ce201') || frameHex.includes('b0be0d07') || frameHex.includes('070dbeb0') || frameHex.includes('7639') || frameHex.includes('3976')) {
                console.log(`Found freq in frame: ${frameHex}`);
            }
            if (frameHex.includes('1183') || frameHex.includes('8311') || frameHex.includes('1830') || frameHex.includes('3018')) {
                console.log(`Found string freq in frame: ${frameHex}`);
            }
        }
    } catch(e) {}
}
