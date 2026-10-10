const { spawn } = require('child_process');

const tcpdump = spawn('tcpdump', ['-r', 'Sample pcap/ote neww.pcap', '-x', '-n', 'src host 192.168.127.55']);

let buffer = Buffer.alloc(0);
let currentPacketHex = '';
const foundIds = new Map();

tcpdump.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        if (line.match(/^\d{2}:\d{2}:\d{2}\./)) {
            // New packet
            processPacket(currentPacketHex);
            currentPacketHex = '';
        } else if (line.match(/^\s+0x[0-9a-fA-F]+:\s+(.*)/)) {
            // Hex data line
            const hexPart = line.match(/^\s+0x[0-9a-fA-F]+:\s+(.*)/)[1];
            currentPacketHex += hexPart.replace(/ /g, '');
        }
    }
});

tcpdump.stdout.on('end', () => {
    processPacket(currentPacketHex);
    console.log("Extraction complete. Found IDs:");
    const sortedIds = Array.from(foundIds.keys()).sort((a, b) => a - b);
    for (const id of sortedIds) {
        const entry = foundIds.get(id);
        console.log(`ID ${id}: ${entry.hex} (Count: ${entry.count}) -> Decoded BE: ${entry.be}, LE: ${entry.le}`);
    }
});

function processPacket(hexStr) {
    if (!hexStr || hexStr.length < 40) return; // Skip empty or too short (IP/TCP header)
    
    // Convert hex string to buffer
    let pktBuffer;
    try {
        pktBuffer = Buffer.from(hexStr, 'hex');
    } catch (e) { return; }
    
    // Skip IPv4 header (usually 20 bytes) + TCP header (usually 20-32 bytes)
    // Actually, tcpdump -x includes IP header.
    // IP header length is (pktBuffer[0] & 0x0F) * 4
    if (pktBuffer.length < 20) return;
    const ipHeaderLen = (pktBuffer[0] & 0x0F) * 4;
    
    if (pktBuffer.length < ipHeaderLen + 20) return;
    const tcpHeaderLen = (pktBuffer[ipHeaderLen + 12] >> 4) * 4;
    
    const payloadOffset = ipHeaderLen + tcpHeaderLen;
    if (payloadOffset >= pktBuffer.length) return; // No payload
    
    const payload = pktBuffer.slice(payloadOffset);
    parseOteStream(payload);
}

let streamBuffer = Buffer.alloc(0);
function parseOteStream(rawData) {
    streamBuffer = Buffer.concat([streamBuffer, rawData]);
    
    while (streamBuffer.length > 0) {
        const stxIdx = streamBuffer.indexOf(0x02);
        if (stxIdx === -1) {
            streamBuffer = Buffer.alloc(0);
            break;
        }
        if (stxIdx > 0) {
            streamBuffer = streamBuffer.slice(stxIdx);
        }
        
        if (streamBuffer.length < 3) break;
        const lenByte = streamBuffer[2];
        const totalFrameSize = 1 + 1 + 1 + lenByte + 2;
        
        if (streamBuffer.length < totalFrameSize) break;
        
        const frame = streamBuffer.slice(0, totalFrameSize);
        streamBuffer = streamBuffer.slice(totalFrameSize);
        
        parseOteFrame(frame);
    }
}

function parseOteFrame(frame) {
    const len = frame[2];
    const payload = frame.slice(3, 3 + len);
    
    if (payload.length >= 7 && payload[0] === 0x19) {
        const dataLen = payload[6];
        if (payload.length >= 7 + 3 + (dataLen - 3)) {
            const id = payload[9];
            if (payload[7] === 0x00 && payload[8] === 0x00) {
                const dataBytes = payload.slice(10, 10 + (dataLen - 3));
                
                let valueLE = 0;
                let valueBE = 0;
                for (let i = 0; i < dataBytes.length; i++) {
                    valueLE = (valueLE | (dataBytes[i] << (i * 8))) >>> 0;
                    valueBE = ((valueBE << 8) | dataBytes[i]) >>> 0;
                }
                
                if (!foundIds.has(id)) {
                    foundIds.set(id, { count: 1, hex: dataBytes.toString('hex'), be: valueBE, le: valueLE });
                } else {
                    const entry = foundIds.get(id);
                    entry.count++;
                    entry.hex = dataBytes.toString('hex');
                    entry.be = valueBE;
                    entry.le = valueLE;
                }
            }
        }
    }
}
