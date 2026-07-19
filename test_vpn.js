const { Connection } = require('rhea-promise');

async function testVPN() {
    console.log('Mencoba login dengan smart-toc-admin@dev-smart...');
    const conn = new Connection({
        host: '172.20.16.123',
        port: 5672,
        username: 'smart-toc-admin@dev-smart', // Coba pakai vpn dev-smart
        password: 'smart-toc-admin',
        transport: 'tcp',
        reconnect: false
    });

    try {
        await conn.open();
        console.log('✅ BERHASIL LOGIN!');
        await conn.close();
    } catch (e) {
        console.log('❌ GAGAL LOGIN:', e.message);
    }
}

testVPN();
