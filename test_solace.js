const ems = require('./src/connection/ems.js');

async function testConnection() {
    console.log('⏳ Mengetes koneksi ke Solace (EMS)...');
    try {
        // Coba membuka koneksi
        await ems.connect();
        console.log('✅ Koneksi berhasil! Berhasil terhubung ke broker Message Solace.');
        
        // Coba mengirim pesan sederhana ke Queue (kategori Support yang default mengirim ke Q.SUP)
        console.log('⏳ Mencoba mengirim pesan pengujian...');
        const result = await ems.publishByCategory('Support', { 
            test_type: 'ping',
            message: 'Pesan pengujian untuk memverifikasi koneksi aplikasi ke Solace broker.',
            timestamp: new Date().toISOString()
        });
        
        console.log('✅ Pesan berhasil dikirim!');
        console.log('Detail pengiriman:', JSON.stringify(result, null, 2));
        
        console.log('\nSelesai. Semua beroperasi dengan baik.');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Gagal terhubung atau mengirim pesan. Detail Error:');
        console.error(error.message);
        process.exit(1);
    }
}

testConnection();
