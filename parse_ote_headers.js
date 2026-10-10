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
tcpdump.stdout.on('end', () => {
    processPacket(currentPacketHex);
    console.log("Headers found:", Array.from(headers));
});

let streamBuffer = Buffer.alloc(0);
const headers = new Set();
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
            
            headers.add(frame[3].toString(16)); // payload[0]
        }
    } catch(e) {}
}
