const net = require('net');

const args = process.argv.slice(2);
const TARGET_IP = args[0] || '62.17.8.116';
const TARGET_PORT = args[1] ? parseInt(args[1]) : 38317;
const LOCAL_PORT = 38317; // Port proxy lokal

const proxyServer = net.createServer(function (clientApp) {
    console.log(`\n[Proxy] Aplikasi bawaan terhubung ke Proxy! (${clientApp.remoteAddress})`);

    // Begitu aplikasi bawaan konek ke kita, kita buat koneksi ke DVOR asli
    const dvorDevice = new net.Socket();
    dvorDevice.connect(TARGET_PORT, TARGET_IP, function () {
        console.log(`[Proxy] Terhubung ke DVOR asli di ${TARGET_IP}:${TARGET_PORT}`);
    });

    // 1. MENGUPING DATA DARI APLIKASI KE DVOR (Trigger)
    clientApp.on('data', function (data) {
        // console.log('\n[-> APLIKASI -> DVOR]');
        // console.log('Data (Hex):', data.toString('hex').toUpperCase());
        
        // Meneruskan data ke DVOR asli
        dvorDevice.write(data);
    });

    // 2. MENGUPING DATA DARI DVOR KE APLIKASI (Data Telemetri Parameter)
    dvorDevice.on('data', function (data) {
        console.log('\n[📥 DATA MASUK DARI DVOR]');
        console.log('Ukuran    :', data.length, 'bytes');
        
        let hexString = data.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
        console.log('Hex Buffer:', hexString);

        // ========================================================
        // DI SINI ADALAH TEMPAT KITA MELAKUKAN PARSING (MENGUPING)
        // Kita bisa mengolah data mentah ini dan mengirimkannya
        // ke RabbitMQ / EMS / Database Monitoring ARIFIN!
        // ========================================================
        
        // Meneruskan data kembali ke Aplikasi Bawaan agar aplikasi tidak error
        clientApp.write(data);
    });

    clientApp.on('close', function () {
        console.log('\n[Proxy] Aplikasi bawaan diputus.');
        dvorDevice.destroy();
    });

    clientApp.on('error', function (err) {
        console.log('\n[Proxy] Aplikasi bawaan error:', err.message);
        dvorDevice.destroy();
    });

    dvorDevice.on('close', function () {
        console.log('\n[Proxy] Koneksi ke DVOR asli diputus.');
        clientApp.destroy();
    });

    dvorDevice.on('error', function (err) {
        console.log('\n[Proxy] Koneksi DVOR error:', err.message);
        clientApp.destroy();
    });
});

proxyServer.listen(LOCAL_PORT, () => {
    console.log(`\n======================================================`);
    console.log(`📡 SCRIPT TCP PROXY (SADAP DATA DVOR) AKTIF`);
    console.log(`   Menunggu koneksi dari aplikasi bawaan di Port : ${LOCAL_PORT}`);
    console.log(`   Akan diteruskan ke DVOR asli                  : ${TARGET_IP}:${TARGET_PORT}`);
    console.log(`======================================================\n`);
    console.log(`LANGKAH SELANJUTNYA:`);
    console.log(`1. Buka aplikasi bawaan DVOR.`);
    console.log(`2. Ubah konfigurasi "Target IP" di aplikasi tersebut menjadi '127.0.0.1' atau 'localhost'.`);
    console.log(`3. Biarkan Port tetap ${TARGET_PORT}.`);
    console.log(`4. Klik Connect di aplikasi bawaan.\n`);
});
