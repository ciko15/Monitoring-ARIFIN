const { SerialPort } = require('serialport');

// Ambil argumen dari command line (default COM1)
const targetPort = process.argv[2] || 'COM1';
const baudRate = parseInt(process.argv[3] || '38400', 10);

console.log(`[+] Mencoba koneksi Serial ke Port ${targetPort} dengan BaudRate ${baudRate}...`);
console.log(`[!] Tekan Ctrl+C untuk berhenti.\n`);

const port = new SerialPort({
    path: targetPort,
    baudRate: baudRate,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    autoOpen: false // Kita buka manual untuk error handling
});

let dataCount = 0;

port.open(function (err) {
    if (err) {
        return console.log('\n[-] ERROR saat membuka port: ', err.message);
    }
    console.log(`[+] BERHASIL TERHUBUNG ke ${targetPort}`);
    console.log(`[!] Menunggu data serial masuk...\n`);
});

port.on('data', function (data) {
    dataCount++;
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    
    const hexString = data.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
    const asciiString = data.toString('ascii').replace(/[^\x20-\x7E]/g, '.');

    console.log(`[${timestamp}] Data #${dataCount} (${data.length} bytes):`);
    console.log(`  HEX   : ${hexString}`);
    console.log(`  ASCII : ${asciiString}`);
    console.log(`--------------------------------------------------`);
});

port.on('error', function(err) {
    console.log(`\n[-] ERROR SERIAL: ${err.message}`);
});
