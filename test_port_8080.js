const { Connection } = require('rhea-promise');

async function testConnection8080() {
    console.log('Mencoba koneksi AMQP 1.0 ke Solace (172.20.16.123) pada port 8080...');
    const conn = new Connection({
        host: '172.20.16.123',
        port: 8080,
        username: 'smart-toc-hq',
        password: 'smarthq123!',
        transport: 'tcp', // bisa jadi tcp, atau ws (websocket)
        reconnect: false
    });

    try {
        await conn.open();
        console.log('✅ BERHASIL: Solace menerima koneksi AMQP 1.0 di port 8080 (TCP)!');
        await conn.close();
    } catch (error) {
        console.log(`❌ GAGAL: Tidak dapat terhubung ke AMQP 1.0 di port 8080.`);
        console.log(`   Error: ${error.message}`);
    }
}

testConnection8080();
