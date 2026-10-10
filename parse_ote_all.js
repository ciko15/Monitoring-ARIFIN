const { spawn } = require('child_process');

const tcpdump = spawn('tcpdump', ['-r', 'Sample pcap/ote neww.pcap', '-x', '-n', 'src host 192.168.127.55']);

let currentPacketHex = '';
const foundFrames = new Set();

tcpdump.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        if (line.match(/^\d{2}:\d{2}:\d{2}\./)) {
            processPacket(currentPacketHex);
            currentPacketHex = '';
        } else if (line.match(/^\s+0x[0-9a-fA-F]+:\s+(.*)/)) {
            const hexPart = line.match(/^\s+0x[0-9a-fA-F]+:\s+(.*)/)[1];
            currentPacketHex += hexPart.replace(/ /g, '');
        }
    }
});

tcpdump.stdout.on('end', () => {
    processPacket(currentPacketHex);
    console.log("Extraction complete. Found Responses (payloads starting with STX 02 02):");
    const arr = Array.from(foundFrames);
    for (let i = 0; i < Math.min(arr.length, 50); i++) {
        console.log(arr[i]);
    }
});

function processPacket(hexStr) {
    if (!hexStr || hexStr.length < 40) return;
    let pktBuffer;
    try { pktBuffer = Buffer.from(hexStr, 'hex'); } catch (e) { return; }
    if (pktBuffer.length < 20) return;
    const ipHeaderLen = (pktBuffer[0] & 0x0F) * 4;
    if (pktBuffer.length < ipHeaderLen + 20) return;
    const tcpHeaderLen = (pktBuffer[ipHeaderLen + 12] >> 4) * 4;
    const payloadOffset = ipHeaderLen + tcpHeaderLen;
    if (payloadOffset >= pktBuffer.length) return;
    
    const payload = pktBuffer.slice(payloadOffset);
    parseOteStream(payload);
}

let streamBuffer = Buffer.alloc(0);
function parseOteStream(rawData) {
    streamBuffer = Buffer.concat([streamBuffer, rawData]);
    while (streamBuffer.length > 0) {
        const stxIdx = streamBuffer.indexOf(0x02);
        if (stxIdx === -1) { streamBuffer = Buffer.alloc(0); break; }
        if (stxIdx > 0) { streamBuffer = streamBuffer.slice(stxIdx); }
        if (streamBuffer.length < 3) break;
        const lenByte = streamBuffer[2];
        const totalFrameSize = 1 + 1 + 1 + lenByte + 2;
        if (streamBuffer.length < totalFrameSize) break;
        const frame = streamBuffer.slice(0, totalFrameSize);
        streamBuffer = streamBuffer.slice(totalFrameSize);
        foundFrames.add(frame.toString('hex'));
    }
}
