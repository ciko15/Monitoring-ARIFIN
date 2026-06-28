# Issue: Stabilitas Pipeline Monitoring Saat Alat Flapping, EMS Down, dan Startup Lambat

## Latar Belakang

Aplikasi Monitoring ARIFIN memiliki 3 proses utama:

1. `collector`: mengambil data dari alat melalui TCP, UDP, WebSocket, SNMP, multicast, dan protokol khusus.
2. `processor`: memproses queue, parsing data, menyimpan log lokal, dan mengirim telemetry/status.
3. `web`: menampilkan dashboard, API, command consumer, dan data monitoring.

Masalah yang terjadi:

- PM2 menunjukkan proses masih `online`, tetapi data alat sering menjadi `Disconnect`.
- Beberapa alat memang sering lost connection atau flapping. Ini wajar dalam kondisi lapangan.
- Saat banyak alat lost connection, aplikasi terasa berat atau seperti stuck.
- Saat aplikasi baru dinyalakan, dashboard lama menampilkan data.
- EMS/RabbitMQ tidak selalu reachable, tetapi aplikasi lokal tetap harus berjalan normal.

Tujuan issue ini adalah merancang perbaikan agar aplikasi tetap ringan, responsif, dan benar secara status monitoring walaupun sebagian alat sering putus.

## Kondisi Saat Ini

### Temuan Audit

- `collector` sering menghasilkan status `Disconnect` karena alat tidak menjawab, misalnya:
  - SNMP: `No SNMP response`
  - TCP Modbus/PM5560: `ECONNREFUSED`
  - T6TV WebSocket: `failed to connect`
  - Temp/Humidity: `timeout`
  - ILS GP/LLZ: `timeout`
  - MARC/RSE: `socket timeout`
- `processor` tetap hidup walaupun error, karena error diproses/catch dan aplikasi tidak selalu exit.
- Queue `data/raw-queue/pending` dapat terisi banyak event `Disconnect`.
- EMS/RabbitMQ error seperti `connect ECONNREFUSED 172.20.17.104:5672` terjadi berulang.
- Watchdog menandai source/equipment `Disconnect` jika data tidak segar.
- Database/UI menampilkan placeholder `-` dan status `Disconnect` jika tidak ada log baru.

### Kenapa PM2 Online Tetapi Aplikasi Terlihat Bermasalah

PM2 hanya memastikan proses OS masih berjalan. PM2 `online` tidak berarti:

- alat berhasil dibaca,
- parser berhasil menghasilkan data valid,
- queue kosong,
- EMS berhasil dikirim,
- dashboard sudah menerima data terbaru.

Karena itu perlu health check aplikasi, bukan hanya status PM2.

## Sasaran Perbaikan

1. Aplikasi tetap ringan walaupun banyak alat lost connection.
2. Status `Disconnect` tetap cepat terdeteksi dan tetap dikirim.
3. Jika alat terus `Disconnect`, pengiriman ulang dibatasi setiap 15-30 menit.
4. Jika alat kembali `Normal`, status langsung berubah dan langsung dikirim.
5. Data lokal dan dashboard tidak boleh tergantung EMS/RabbitMQ.
6. Queue tidak boleh dipenuhi event berulang yang tidak membawa perubahan status.
7. Startup aplikasi harus cepat menampilkan dashboard dan last known data.
8. Log tidak boleh membengkak karena error/reconnect yang sama terus-menerus.

## Prinsip Desain Status

### Bedakan Deteksi Status dan Pengiriman Ulang Status

Status boleh berubah cepat. Yang dibatasi adalah pengiriman/log berulang untuk status yang sama.

Contoh alur ideal:

```text
10:00 alat Normal
10:01 gagal poll pertama
10:02 gagal poll kedua
10:03 gagal poll ketiga -> status Disconnect, kirim event Disconnect pertama
10:04 masih Disconnect -> jangan kirim ulang
10:05 masih Disconnect -> jangan kirim ulang
10:18 masih Disconnect -> kirim ulang heartbeat Disconnect
10:19 alat berhasil dibaca -> status Normal, kirim event Normal/Reconnected langsung
```

### Rekomendasi Default

```text
FAIL_COUNT_TO_DISCONNECT = 3
RECOVERY_COUNT_TO_NORMAL = 1
DISCONNECT_REPEAT_INTERVAL_MS = 15 * 60 * 1000
MAX_DISCONNECT_REPEAT_INTERVAL_MS = 30 * 60 * 1000
STALE_THRESHOLD_MS = 2x sampai 3x poll interval
```

Catatan:

- `RECOVERY_COUNT_TO_NORMAL = 1` dipilih agar monitoring cepat pulih ketika alat kembali menjawab.
- Untuk alat yang sangat flapping, recovery dapat dibuat 2 kali sukses berturut-turut per tipe alat.
- `Disconnect` pertama harus tetap dikirim cepat setelah threshold gagal terpenuhi.

## Perilaku Status yang Diinginkan

### Source Tunggal

| Kondisi | Status | Kirim/log |
| --- | --- | --- |
| Poll sukses | `Normal` atau status parser | Langsung, jika status/data berubah |
| Gagal 1-2 kali | Pertahankan status sebelumnya atau `Warning` | Tidak wajib kirim |
| Gagal >= 3 kali | `Disconnect` | Kirim langsung sekali |
| Masih `Disconnect` | `Disconnect` | Kirim ulang hanya setiap 15-30 menit |
| Kembali sukses | `Normal/Reconnected` | Kirim langsung |

### Equipment dengan Banyak Source

| Kondisi Source | Status Equipment |
| --- | --- |
| Semua source normal | `Normal` |
| Sebagian source disconnect | `Warning` |
| Semua source disconnect | `Disconnect` |
| Ada source alarm/critical | `Alert` |
| Source kembali normal sebagian | Langsung turun dari `Disconnect` ke `Warning` |
| Semua source kembali normal | Langsung `Normal` |

## Kemungkinan Penyebab Aplikasi Lambat atau Stuck

### 1. Queue Dipenuhi Event Disconnect Berulang

Jika alat mati/down lama, collector bisa terus membuat event `Disconnect`. Processor akan terus memproses status yang sama.

Risiko:

- CPU dan disk meningkat.
- Queue lambat habis.
- Data penting tertunda oleh event berulang.
- Startup makin berat karena queue lama ikut diproses.

Solusi:

- Simpan state terakhir per source.
- Enqueue hanya jika status berubah.
- Jika status tetap `Disconnect`, enqueue heartbeat hanya setiap 15-30 menit.
- Batasi ukuran queue.
- Drop event lama yang sudah tidak relevan.

### 2. EMS/RabbitMQ Menghambat Alur Lokal

Saat EMS tidak reachable, publish gagal berulang. Aplikasi lokal seharusnya tetap jalan.

Risiko:

- Processor menunggu koneksi EMS.
- Banyak error log.
- Startup dan command consumer retry terus.

Solusi:

- Jadikan EMS non-blocking terhadap log lokal.
- Urutan wajib: save lokal dulu, update dashboard, lalu publish EMS background.
- Jika EMS gagal, gunakan retry backoff.
- Tambahkan opsi `EMS_ENABLED=false` untuk environment yang tidak butuh kirim EMS.
- Jangan retry setiap 5 detik selamanya; gunakan backoff 30 detik, 1 menit, 5 menit.

### 3. Reconnect Loop Terlalu Agresif

Saat alat down, banyak connector melakukan reconnect cepat.

Risiko:

- CPU tinggi.
- Log membesar.
- Socket terus dibuat/destroy.
- Startup berat karena semua source mencoba konek bersamaan.

Solusi:

- Gunakan exponential backoff per source.
- Tambahkan jitter agar semua source tidak retry bersamaan.
- Reset backoff ketika alat berhasil connect.
- Batasi log error yang sama per source.

### 4. Polling Semua Source Bersamaan Saat Startup

Saat aplikasi menyala, semua listener/poller langsung aktif.

Risiko:

- Startup lambat.
- Banyak timeout bersamaan.
- Dashboard menunggu proses background yang berat.

Solusi:

- Web/dashboard harus siap dulu.
- Load last known data dari cache/log lokal.
- Start collector bertahap per batch.
- Tambahkan jitter pada initial poll.
- Jangan blocking API/dashboard pada proses scan alat.

### 5. Watchdog Terlalu Sederhana

Watchdog saat ini dapat menandai `Disconnect` berdasarkan freshness data.

Risiko:

- Data valid yang hanya telat sedikit dianggap disconnect.
- Source yang tidak punya log baru langsung dianggap disconnect.
- Equipment multi-source mudah menjadi flapping.

Solusi:

- Watchdog memakai state machine per source.
- Gunakan fail count dan recovery count.
- Gunakan `last_good_data` agar parameter tidak langsung menjadi `-`.
- Bedakan `Stale`, `Warning`, dan `Disconnect`.

### 6. Log Terlalu Banyak

Log reconnect, timeout, raw data, dan EMS error bisa sangat besar.

Risiko:

- Disk penuh.
- Tail/log PM2 berat.
- Startup lambat jika aplikasi membaca history besar.

Solusi:

- Matikan raw dump hex di production.
- Throttle log error yang sama.
- Aktifkan PM2 log rotate.
- Pisahkan log penting, debug, dan telemetry.
- Jangan log polling sukses terlalu sering.

### 7. Baca History/JSON Terlalu Berat

Dashboard dapat membaca `equipment_logs.json` dan scan history file.

Risiko:

- Startup lambat.
- API stats lambat.
- Banyak file log membuat scan berat.

Solusi:

- Simpan cache latest state per source dalam file kecil, misalnya `data/state/latest_sources.json`.
- Dashboard baca latest state, bukan scan semua history.
- History hanya dibaca saat user membuka halaman history.
- Batasi jumlah log di `equipment_logs.json`.

## Rancangan State Machine Per Source

Setiap source perlu menyimpan state ringan:

```json
{
  "sourceId": "1777800010030",
  "equipmentId": "1777800000001",
  "status": "Disconnect",
  "lastStatus": "Normal",
  "failCount": 3,
  "successCount": 0,
  "lastSuccessAt": "2026-06-28T10:00:00.000Z",
  "lastStatusChangedAt": "2026-06-28T10:03:00.000Z",
  "lastDisconnectSentAt": "2026-06-28T10:03:00.000Z",
  "lastTelemetrySentAt": "2026-06-28T10:03:00.000Z",
  "lastGoodData": {}
}
```

### Aturan Update State

Jika poll/parse sukses:

- `failCount = 0`
- `successCount += 1`
- update `lastSuccessAt`
- update `lastGoodData`
- jika status sebelumnya `Disconnect`, langsung kirim `Normal/Reconnected`

Jika poll/parse gagal:

- `failCount += 1`
- jika `failCount < FAIL_COUNT_TO_DISCONNECT`, jangan langsung `Disconnect`
- jika `failCount >= FAIL_COUNT_TO_DISCONNECT`, status menjadi `Disconnect`
- jika baru berubah ke `Disconnect`, kirim langsung
- jika sudah `Disconnect`, kirim ulang hanya jika melewati interval 15-30 menit

## Rancangan Queue

### Event yang Boleh Masuk Queue

- Status berubah.
- Data telemetry valid dan berbeda/baru.
- Disconnect heartbeat periodik 15-30 menit.
- Recovery dari `Disconnect` ke `Normal`.

### Event yang Tidak Perlu Masuk Queue

- Disconnect yang sama setiap poll.
- Timeout yang sama tanpa perubahan status.
- Data placeholder `-` yang sama berulang.
- Publish EMS retry yang tidak mengubah state lokal.

## Rancangan EMS Non-Blocking

Perilaku yang diinginkan:

1. Simpan file log lokal.
2. Simpan latest state lokal.
3. Update dashboard/API.
4. Publish EMS secara async/background.
5. Jika EMS gagal, jangan gagalkan proses lokal.

Opsi implementasi:

- `EMS_ENABLED=true/false`
- `EMS_PUBLISH_TIMEOUT_MS=2000`
- `EMS_RETRY_BACKOFF_MS=30000`
- `EMS_MAX_BACKOFF_MS=300000`
- outbox dengan batas maksimum, misalnya 1000 event
- drop/merge event lama untuk source yang sama jika status belum berubah

## Rancangan Startup Ringan

Urutan startup ideal:

1. Start web server.
2. Load latest state/cache.
3. Dashboard bisa tampil.
4. Start processor queue.
5. Start collector secara bertahap.
6. Start EMS/command consumer background.
7. Jalankan watchdog setelah grace period.

Grace period startup:

```text
STARTUP_WATCHDOG_GRACE_MS = 2 sampai 5 menit
```

Selama grace period, jangan ubah semua alat menjadi `Disconnect` hanya karena collector belum selesai initial poll.

## Parameter Konfigurasi yang Disarankan

```env
FAIL_COUNT_TO_DISCONNECT=3
RECOVERY_COUNT_TO_NORMAL=1
DISCONNECT_REPEAT_INTERVAL_MS=900000
MAX_DISCONNECT_REPEAT_INTERVAL_MS=1800000
STARTUP_WATCHDOG_GRACE_MS=180000
EMS_ENABLED=true
EMS_PUBLISH_TIMEOUT_MS=2000
EMS_RETRY_BACKOFF_MS=30000
EMS_MAX_BACKOFF_MS=300000
QUEUE_MAX_PENDING=5000
QUEUE_TTL_MS=1800000
LOG_THROTTLE_MS=60000
RAW_DEBUG=false
COLLECTOR_START_BATCH_SIZE=10
COLLECTOR_START_BATCH_DELAY_MS=3000
```

## Area Kode yang Perlu Ditinjau

- `src/services/network_listener.js`
  - enqueue raw/parsed event
  - reconnect loop
  - log raw data
  - SNMP/PM5560/T6TV/ILS/TempHumidity behavior

- `src/services/queued_data_processor.js`
  - release queue on error
  - handling repeated disconnect
  - batch size and retry behavior

- `src/services/raw_event_queue.js`
  - max pending limit
  - TTL cleanup
  - failed queue behavior

- `src/services/equipment.js`
  - `saveToLogs`
  - local save vs EMS publish
  - `updateEquipmentStatus`

- `src/connection/ems.js`
  - RabbitMQ connect retry
  - publish timeout
  - connection close/error handling

- `src/services/command_consumer.js`
  - reconnect backoff
  - disable/optional EMS consumer

- `db/database.js`
  - latest data aggregation
  - default status source
  - history scan
  - last known good data

- `src/server.ts`
  - watchdog interval
  - startup ordering
  - service initialization

## Acceptance Criteria

1. Jika alat lost connection pertama kali, status `Disconnect` tetap dikirim cepat setelah threshold gagal terpenuhi.
2. Jika alat tetap `Disconnect`, event/log/publish tidak spam setiap poll.
3. Jika alat kembali `Normal`, status langsung berubah dan langsung dikirim.
4. Jika EMS/RabbitMQ down, dashboard lokal tetap cepat dan log lokal tetap tersimpan.
5. Queue tidak terus bertambah hanya karena event `Disconnect` yang sama.
6. Startup dashboard tidak menunggu semua alat selesai timeout.
7. Log PM2 tidak membesar cepat karena error yang sama berulang.
8. Multi-source equipment tidak langsung `Disconnect` jika hanya sebagian source putus.
9. Data terakhir yang valid tetap ditampilkan dengan indikator status/stale, tidak langsung hilang menjadi `-`.
10. Health aplikasi dapat membedakan:
    - PM2 process online
    - collector healthy
    - processor queue healthy
    - EMS connected/disconnected
    - jumlah pending queue
    - jumlah source disconnect

## Prioritas Implementasi

### Prioritas 1

- EMS non-blocking.
- Disconnect throttling 15-30 menit.
- Recovery `Normal` langsung.
- Jangan enqueue disconnect yang sama terus-menerus.

### Prioritas 2

- State machine per source.
- Last known good data.
- Startup grace period.
- Reconnect backoff dan log throttling.

### Prioritas 3

- Latest state cache.
- Health endpoint detail.
- PM2 log rotate.
- Queue max pending dan compaction.

## Catatan Keputusan Diskusi

- Mode offline/web-only tidak menjadi fokus karena PC Windows target tetap terhubung ke alat.
- Kondisi alat lost connection dianggap wajar, sehingga aplikasi harus tahan terhadap flapping.
- `Disconnect` tetap harus dikirim, tetapi pengiriman ulang saat status tidak berubah harus dibatasi.
- Recovery ke `Normal` harus langsung.
- Fokus utama bukan mematikan proses, tetapi membuat pipeline tahan beban dan tidak stuck.
