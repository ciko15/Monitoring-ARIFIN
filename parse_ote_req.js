const { spawn } = require('child_process');

// Now listen to packets sent TO the TX (dst host 192.168.127.55)
const tcpdump = spawn('tcpdump', ['-r', 'Sample pcap/ote neww.pcap', '-x', '-n', 'dst host 192.168.127.55']);

let currentPacketHex = '';
const foundReqs = new Map();

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
    console.log("Extraction complete. Found Requests:");
    const sortedIds = Array.from(foundReqs.keys()).sort((a, b) => a - b);
    for (const id of sortedIds) {
        console.log(`ID ${id}: Frame Hex: ${foundReqs.get(id)}`);
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
        parseOteReqFrame(frame);
    }
}

function parseOteReqFrame(frame) {
    const len = frame[2];
    const payload = frame.slice(3, 3 + len);
    
    // Requests from client usually start with 0x30
    if (payload.length >= 7 && payload[0] === 0x30) {
        const dataLen = payload[6]; // length of data segment
        if (payload.length >= 7 + 3) {
            const id = payload[9];
            if (!foundReqs.has(id)) {
                foundReqs.set(id, frame.toString('hex'));
            }
        }
    }
}
