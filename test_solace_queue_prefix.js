const { Connection } = require('rhea-promise');

async function testSolacePrefix() {
    console.log('⏳ Mengetes koneksi ke Solace (EMS) dengan prefix queue://...');
    const conn = new Connection({
        host: '172.20.16.123',
        port: 5672,
        username: 'dce-wajj',
        password: 'dce-wajj',
        transport: 'tcp',
        reconnect: false
    });

    try {
        await conn.open();
        console.log('✅ Koneksi berhasil!');

        const queueName = 'queue://Q.SUP'; // Coba pakai prefix queue://
        const sender = await conn.createSender({
            target: { address: queueName }
        });

        const msg = {
            durable: true,
            body: JSON.stringify({ test: 'direct_to_queue', time: new Date().toISOString() })
        };

        sender.send(msg);
        console.log(`✅ Pesan durable berhasil dikirim ke ${queueName}!`);
        
        setTimeout(() => {
            conn.close();
        }, 1000);
    } catch (e) {
        console.error('❌ Gagal terhubung atau mengirim:', e.message);
    }
}

testSolacePrefix();
