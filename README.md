# CIKO - Monitoring ARIFIN (Advanced Real-time Interface)

Sistem monitoring peralatan navigasi dan komunikasi penerbangan secara real-time dengan dukungan multi-protokol (UDP, TCP, SNMP, Modbus) dan visualisasi geografis.

## 🚀 Cara Menjalankan Aplikasi

### Persyaratan Sistem
- **Bun Runtime** (Direkomendasikan) atau **Node.js v18+**
- **Sistem Operasi**: Linux, macOS, atau Windows
- **Port Default**: 3100

### Instalasi & Menjalankan (Development)
```bash
# 1. Install dependensi
npm install

# 2. Jalankan aplikasi (Development mode)
npm run dev
```

### Jalankan di Produksi (PM2)
Sangat disarankan menggunakan PM2 agar aplikasi otomatis berjalan kembali jika server restart atau aplikasi crash.
```bash
# 1. Setup PM2 (Sekali saja)
npm run pm2:setup

# 2. Jalankan dan simpan konfigurasi
npm run pm2:start
npm run pm2:save
```

### Jalankan di Produksi (Windows)
Gunakan konfigurasi khusus Windows agar PM2 memanggil Bun dengan benar.
```bash
npm run pm2:start:windows
npm run pm2:save
```

#### Setup Auto-Start di Windows
Untuk membuat aplikasi otomatis start saat Windows boot/login:

1. **Jalankan sebagai Administrator**:
   - Klik kanan `setup_task_scheduler.bat`
   - Pilih "Run as administrator"

2. **Atau manual dengan PowerShell (as Admin)**:
   ```powershell
   # Buat scheduled task
   $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c cd /d "C:\Users\CNSA SENTANI\Downloads\Monitoring-ARIFIN-main" && npx pm2 resurrect'
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
   Register-ScheduledTask -TaskName 'MonitoringARIFIN_PM2' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
   ```

3. **Verifikasi**:
   - Buka Task Scheduler (search "Task Scheduler")
   - Cari task "MonitoringARIFIN_PM2"
   - Task akan berjalan saat user login dan restore PM2 processes

---

## 🔒 Sistem Keamanan & User Management

### Login & Autentikasi
Sistem menggunakan **Hashed Passwords** (keamanan tinggi) dan **Session-based Token**.
- **Admin Default**: `admin` / `admin`
- **Session Timeout**: Otomatis logout jika token tidak valid.

### Level Pengguna (Roles)
1. **Admin**: Akses penuh ke seluruh menu (Konfigurasi, User Management, Network Tools).
2. **Teknisi**: Akses ke Dashboard, History Logs, dan Network Tools. Tidak dapat menghapus konfigurasi alat.
3. **User**: Hanya akses Monitoring Dashboard (Read-only).

---

## 📋 SOP Penggunaan per Menu

### 1. Monitoring Dashboard (Peta & List)
- **Tujuan**: Memantau status kesehatan seluruh peralatan secara visual.
- **Indikator Status**:
    - 🟢 **Normal**: Semua parameter dalam ambang batas aman.
    - 🟡 **Warning**: Satu atau lebih parameter melewati batas peringatan.
    - 🔴 **Alarm/Fail**: Parameter kritis melewati batas bahaya.
    - ⚪ **Disconnect**: Server tidak menerima data dari alat (Timeout > 4 menit).
- **Aksi**: Klik ikon alat di peta atau daftar untuk melihat panel detail parameter real-time.

### 2. History Logs
- **Tujuan**: Melakukan audit data historis peralatan.
- **Penggunaan**: Pilih alat dari dropdown, pilih rentang waktu, lalu klik filter.
- **Penyimpanan**: Sistem melakukan **Auto-Cleanup** setiap jam **00:00 UTC**. Data log yang lebih tua dari **2 hari** akan dihapus otomatis untuk menjaga performa server.

### 3. Configuration (Master Data)
- **Bandara**: Mengatur lokasi pusat monitoring.
- **Equipment**: Menambah unit alat. Setiap alat harus memiliki koordinat di peta.
- **Data Source**: Menghubungkan alat ke sensor/IP tertentu. 
    - Gunakan fitur **"Pick from Map"** untuk menentukan lokasi spesifik sensor.
    - Secara default, lokasi sensor akan mengikuti lokasi alat induk.
- **Limitation**: Mengatur nilai ambang batas (Threshold). Nilai ini yang menentukan kapan alat berubah status menjadi Warning atau Alarm.
- **Parsing**: Mengelola skrip pembaca data. Mendukung penambahan parser baru secara dinamis dengan mengunggah file skrip ke folder `src/parsers/`.

### 4. Network Tools (Analisis Jaringan)
- **Interface Stats**: Memantau penggunaan bandwidth pada network interface server.
- **Packet Sniffer**: Menangkap trafik masuk untuk melihat isi data mentah (raw data) yang dikirim alat. Sangat berguna untuk troubleshooting parser yang salah.
- **TCP Analyzer**: Mengetes konektivitas ke IP & Port tertentu dan memvalidasi "Sync Marker" data untuk memastikan integritas data dari peralatan.

---

## 🛠️ Pemeliharaan (Maintenance)

- **Logs**: File log PM2 tersimpan di folder `./logs/`.
- **Database**: Menggunakan file JSON di folder `./db/`. Lakukan backup rutin pada folder ini.
- **Update Parser**: Jika ada alat tipe baru, tambahkan parser di `src/parsers/` dan daftarkan di menu Configuration > Parsing.

---
*CIKO Monitoring System - Developed for High Availability & Real-time Reliability.*
