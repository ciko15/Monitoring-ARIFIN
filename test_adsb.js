const dgram = require('dgram');

const MULTICAST_IP = '239.71.40.2';
const PORT = 50000;

const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });

client.on('listening', function () {
    const address = client.address();
    console.log(`[+] Mendengarkan UDP pada port ${address.port}`);
    try {
        client.addMembership(MULTICAST_IP);
        console.log(`[+] Berhasil bergabung ke Multicast Group ${MULTICAST_IP}`);
    } catch (e) {
        console.log(`[!] Peringatan: Gagal join multicast ${MULTICAST_IP}. Error: ${e.message}`);
    }
});

client.on('message', function (message, remote) {
    // ASTERIX frame basic validation
    if (message.length < 3) return; 

    const cat = message[0];
    const length = (message[1] << 8) | message[2];
    
    // Kita filter hanya CAT 021 (ADS-B)
    if (cat === 21) {
        // SAC & SIC berada di byte ke-4 dan ke-5
        const sac = message.length > 3 ? message[3] : -1;
        const sic = message.length > 4 ? message[4] : -1;
        
        console.log(`[${new Date().toLocaleTimeString()}] TERIMA CAT 21 dari IP: ${remote.address}:${remote.port} -> SAC: ${sac}, SIC: ${sic} | Total Bytes: ${message.length}`);
    }
});

client.bind(PORT);

console.log('[!] Menunggu data ADS-B (ASTERIX CAT 21) masuk... Tekan Ctrl+C untuk berhenti.');
