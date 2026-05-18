# Issue: Implementasi Parsing Data SNMP System Resources (RAM, Storage, CPU)

## Latar Belakang
Aplikasi saat ini telah berhasil mengambil data alat dari jaringan. Namun, kita perlu mengembangkan kemampuan sistem untuk membaca data SNMP standar dari server atau perangkat jaringan (seperti kapasitas RAM, ROM/Storage, dan penggunaan CPU) menggunakan protokol SNMP. Data ini biasanya tersedia melalui standar `HOST-RESOURCES-MIB` atau ekstensi lainnya.

## Tujuan (Objective)
1. Menganalisis ketersediaan paket data SNMP pada sistem untuk melihat ketersediaan data kapasitas *System Resources*.
2. Membuat module parsing khusus (berbasis JavaScript) untuk membaca data SNMP tersebut dan menyimpannya di folder `/src/parsers/`.
3. Menambahkan perangkat (Equipment) baru (contoh: "Device 1", "Device 2") pada database untuk keperluan testing.
4. Mendaftarkan *data source* (Autentikasi) yang menghubungkan perangkat baru tersebut dengan parsing template yang baru dibuat.

---

## Langkah-Langkah Implementasi (Step-by-Step Guide)

Silakan ikuti instruksi di bawah ini secara sistematis.

### Tahap 1: Pengecekan Data SNMP Jaringan
Pertama-tama, pastikan apakah ada *traffic* SNMP atau data raw yang sudah ditangkap oleh `NetworkListener` yang mengandung OID untuk RAM atau Storage.
- **Tugas:** Cek file log di `data/YYYY-MM/DD/` atau analisis log dari service `NetworkListener`.
- **Indikator Keberhasilan:** Anda menemukan data JSON atau buffer yang menunjukkan respon SNMP (port 161/162) yang memberikan informasi sistem.
- *Catatan jika data asli tidak ada:* Jika saat ini tidak ada perangkat nyata yang mengirim SNMP, asumsikan kita sedang menerima data JSON hasil polling SNMP (biasanya mengandung struktur OID dan Value).

### Tahap 2: Membuat Parser SNMP Baru
Buat sebuah file parser baru di dalam folder `src/parsers/`. File ini akan bertugas mengekstrak nilai-nilai penting (Kapasitas RAM, Disk, CPU) dari raw data SNMP.

- **File Baru:** Buat file `src/parsers/snmp_host_resources.js`.
- **Struktur Parser:**
  Gunakan format standard CIKO Parser. Parser harus menerima raw data, dan mengembalikan object data yang rapi beserta statusnya. 
  *Draft Implementasi:*
  ```javascript
  const parse = (rawData) => {
    // 1. Validasi Input (Pastikan data valid, misalnya bukan buffer kosong)
    // 2. Dekode SNMP (Asumsikan rawData berupa JSON dari SNMP poller atau Buffer yang perlu di decode)
    // 3. Mapping OID ke Parameter:
    //    - Ekstrak total RAM
    //    - Ekstrak Used RAM
    //    - Ekstrak Kapasitas Disk / ROM
    // 4. Hitung persentase penggunaan (Used / Total * 100)
    // 5. Tentukan Status:
    //    - Normal: RAM < 80%, Disk < 85%
    //    - Warning: RAM > 80% atau Disk > 85%
    //    - Alarm: RAM > 95% atau Disk > 95%
    
    return {
      status: "Normal", // Atau Warning/Alarm
      data: {
        RAM_Total: { value: 16, unit: "GB", label: "Total RAM" },
        RAM_Used: { value: 8, unit: "GB", label: "Used RAM" },
        RAM_Usage_Percent: { value: 50, unit: "%", label: "RAM Usage" },
        Disk_Usage_Percent: { value: 65, unit: "%", label: "Disk Usage" }
      }
    };
  };
  
  module.exports = { parse };
  ```

### Tahap 3: Mendaftarkan Parsing Template
Agar sistem UI (Frontend) mengenali template parsing ini, tambahkan ke dalam database konfigurasi parsing.
- **File:** `db/equipment_parsing_config.json`
- **Tugas:** Tambahkan object baru ke dalam array JSON.
  ```json
  {
    "id": "snmp_host_resources_01",
    "name": "SNMP Host Resources",
    "description": "Parser untuk membaca kapasitas RAM, Disk, dan CPU via SNMP",
    "fileName": "snmp_host_resources.js",
    "category": "Data Processing"
  }
  ```

### Tahap 4: Menambahkan Perangkat (Equipment) Baru
Buat "dummy" perangkat (contoh: Server/Device 1 & 2) di dalam database equipment agar nantinya bisa dilihat pada Peta Dashboard dan menu Cabang.
- **File:** `db/equipment_config.json`
- **Tugas:** Tambahkan 2 perangkat baru ke dalam array JSON.
  *Contoh:*
  ```json
  [
    {
      "id": 2001,
      "code": "DEV-01",
      "name": "Device 1 - Server Utama",
      "category": "Data Processing",
      "status": "Normal",
      "merk": "HP ProLiant",
      "type": "DL380",
      "lat": -2.5768,
      "lng": 140.5163,
      "airportId": "SENTANI_ID",
      "isActive": true
    },
    {
      "id": 2002,
      "code": "DEV-02",
      "name": "Device 2 - Backup Server",
      "category": "Data Processing",
      "status": "Normal",
      "merk": "Dell PowerEdge",
      "type": "R740",
      "lat": -2.5768,
      "lng": 140.5163,
      "airportId": "SENTANI_ID",
      "isActive": true
    }
  ]
  ```

### Tahap 5: Menghubungkan Data Source (Authentications)
Hubungkan perangkat yang dibuat di Tahap 4 dengan Parsing Template yang dibuat di Tahap 3, serta asumsikan IP dan Port asal data SNMP tersebut dikirim.
- **File:** `db/equipment_otentication_config.json`
- **Tugas:** Tambahkan 2 koneksi data (satu per perangkat). Assign ID parsing template `snmp_host_resources_01` ke koneksi ini.
  *Contoh:*
  ```json
  [
    {
      "id": 3001,
      "equipt_id": "2001",
      "name": "SNMP Device 1",
      "ip_address": "192.168.1.100",
      "port": 162,
      "parsing_id": "snmp_host_resources_01"
    },
    {
      "id": 3002,
      "equipt_id": "2002",
      "name": "SNMP Device 2",
      "ip_address": "192.168.1.101",
      "port": 162,
      "parsing_id": "snmp_host_resources_01"
    }
  ]
  ```

---

## Verifikasi Akhir
Setelah semua tahap selesai, silakan nyalakan sistem (`./easy_start.sh` atau `npm start`) dan verifikasi poin berikut:
1. Akses halaman **Equipment** -> Pastikan Device 1 & Device 2 muncul.
2. Klik tombol detail mata pada "Device 1" -> Pastikan terlihat "Connected Data Sources" mengarah ke "SNMP Device 1" dengan protokol "SNMP Host Resources".
3. Kirim data *dummy* berupa SNMP packet (menggunakan tool simulasi atau simulator yang ada) ke IP lokal dan Port yang telah diatur, lalu pastikan badge status perangkat tersebut berubah dan nilai RAM/Disk muncul pada UI *Cabang Monitoring*.
