const net = require('net');

const targetIp = process.argv[2];

if (!targetIp) {
    console.log('Cara penggunaan: bun .\\scan_port.js <IP_ADDRESS>');
    console.log('Contoh: bun .\\scan_port.js 192.168.127.20');
    process.exit(1);
}

// Daftar port yang sering digunakan oleh peralatan Navigasi, Moxa, dan Modbus
const commonPorts = [
    21, 22, 23, 80, 443,      // Basic (FTP, SSH, Telnet, HTTP, HTTPS)
    502,                      // Modbus TCP
    950,                      // Thales 421
    4001, 4002, 4003, 4004,   // Moxa NPort series (Real COM)
    5000, 5001, 5002,         // Moxa / Serial converters
    10001, 10002, 10003,      // Lantronix / Moxa TCP Server
    1001, 1002, 1003          // Alternative Moxa
];

console.log(`[*] Memulai pemindaian port untuk IP: ${targetIp}`);
console.log(`[*] Mencari di ${commonPorts.length} port umum...`);
console.log('--------------------------------------------------');

let checked = 0;
let openPorts = [];

function checkDone() {
    checked++;
    if (checked === commonPorts.length) {
        console.log('--------------------------------------------------');
        console.log('[*] Pemindaian Selesai.');
        if (openPorts.length > 0) {
            console.log(`[+] Ditemukan ${openPorts.length} port yang TERBUKA:`);
            console.log(`    -> ${openPorts.join(', ')}`);
            console.log('\nSaran: Coba gunakan port tersebut di dump_hex.js');
            console.log(`Contoh: bun .\\dump_hex.js ${targetIp} ${openPorts[0]}`);
        } else {
            console.log('[-] Tidak ada port TCP yang terbuka dari daftar.');
            console.log('    (Mungkin menggunakan UDP seperti SNMP/161, atau port custom lain).');
        }
        process.exit(0);
    }
}

commonPorts.forEach(port => {
    const socket = new net.Socket();
    socket.setTimeout(2000); // Tunggu 2 detik max tiap port

    socket.connect(port, targetIp, () => {
        console.log(`    [+++] PORT TERBUKA: ${port}`);
        openPorts.push(port);
        socket.destroy();
        checkDone();
    });

    socket.on('error', (err) => {
        // Abaikan ECONNREFUSED karena itu berarti port tertutup
        socket.destroy();
        checkDone();
    });

    socket.on('timeout', () => {
        socket.destroy();
        checkDone();
    });
});
