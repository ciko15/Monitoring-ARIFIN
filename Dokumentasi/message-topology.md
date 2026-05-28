# Message Topology Monitoring ARIFIN

Dokumen ini menerapkan skema message yang praktis untuk integrasi cabang dan pusat di project ini.

## Site ID

Set environment variable berikut pada instance cabang:

```bash
SITE_ID=WAJJ
MESSAGE_SERVICE_NAME=MONITORING_ARIFIN_BRANCH
CENTRAL_SERVICE_NAME=EMS
TARGET_SERVICE_NAME=EMS
RABBITMQ_HOST=172.20.17.104
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=smart-toc-hq
RABBITMQ_PASSWORD=smarthq123!
RABBITMQ_VHOST=dev-smart
```

Jika `SITE_ID` tidak diisi, sistem akan memakai `UNKNOWN`.

Sebagai fallback lokal, aplikasi sekarang juga membaca:

- [db/branch_profile.json](/Users/vickra/Development/Monitoring-ARIFIN-main/db/branch_profile.json:1)
- [db/airport_config.json](/Users/vickra/Development/Monitoring-ARIFIN-main/db/airport_config.json:1)

Jadi untuk deployment cabang baru, Anda bisa mulai dari mengganti `branch_profile.json` dan `airport_config.json`, lalu lanjut menyesuaikan equipment dan data source.

## Prioritas Implementasi

Implementasi tahap awal yang sudah disiapkan di kode:

- `equipment.telemetry.received`
- `configuration.threshold.apply`
- `configuration.threshold.applied`
- `configuration.threshold.failed`
- `equipment.snapshot.requested`
- `equipment.snapshot.responded`

## Queue Mapping

| Message Pattern | Message Name | Queue |
| --- | --- | --- |
| `EVENT` | `equipment.telemetry.received` | `Q.COM` / `Q.NAV` / `Q.SUR` / `Q.DAT` / `Q.SUP` |
| `EVENT` | `equipment.status.changed` | `Q.COM` / `Q.NAV` / `Q.SUR` / `Q.DAT` / `Q.SUP` |
| `EVENT` | `configuration.threshold.applied` | `EVT.CONFIG.RESULT` |
| `EVENT` | `configuration.threshold.failed` | `EVT.CONFIG.RESULT` |
| `COMMAND` | `configuration.threshold.apply` | `CMD.CONFIG.<SITE_ID>` |
| `REQUEST` | `equipment.snapshot.requested` | `REQ.EQUIPMENT.<SITE_ID>` |
| `RESPONSE` | `equipment.snapshot.responded` | `RSP.EQUIPMENT` |

## Header Minimal

Semua message envelope baru memakai struktur:

```json
{
  "header": {
    "message_id": "uuid",
    "message_pattern": "EVENT|COMMAND|REQUEST|RESPONSE",
    "message_name": "equipment.telemetry.received",
    "producer_service": "MONITORING_ARIFIN_BRANCH",
    "producer_site_id": "WAJJ",
    "target_service": "MONITORING_ARIFIN_PUSAT",
    "target_site_id": "PUSAT",
    "occurred_at": "2026-05-29T00:00:00.000Z",
    "sent_at": "2026-05-29T00:00:00.000Z",
    "correlation_id": "uuid",
    "event_type": "telemetry",
    "domain": "equipment",
    "category": "Navigation",
    "category_code": "NAV",
    "equipment_id": 1001,
    "equipment_name": "DVOR Sentani",
    "source_name": "DVOR MAIN"
  },
  "body": {}
}
```

## Aturan Final Routing

- Event equipment ke EMS tetap memakai queue kategori:
  `Q.COM`, `Q.NAV`, `Q.SUR`, `Q.DAT`, `Q.SUP`
- Arti bisnis event dibaca dari header:
  `message_pattern`, `message_name`, `event_type`, `category_code`
- Command dari pusat ke cabang tetap memakai queue per-site:
  `CMD.CONFIG.<SITE_ID>`
- Request dari pusat ke cabang tetap memakai queue per-site:
  `REQ.EQUIPMENT.<SITE_ID>`
- Result dan response tetap memakai queue pusat:
  `EVT.CONFIG.RESULT`, `RSP.EQUIPMENT`

## Endpoint Uji Cepat

Endpoint berikut ditambahkan untuk tahap awal:

- `POST /api/messaging/threshold/apply`
- `POST /api/messaging/equipment-snapshot/request`

Contoh threshold command:

```json
{
  "equipmentId": 1001,
  "targetSiteId": "WAJJ",
  "requestedBy": "user_pusat",
  "applyLocally": true,
  "threshold": {
    "parameter_name": "RF_POWER",
    "warning_high": 90,
    "critical_high": 95
  }
}
```

Contoh snapshot request:

```json
{
  "equipmentId": 1001,
  "targetSiteId": "WAJJ",
  "requestedBy": "user_pusat",
  "respondInline": true
}
```

## Catatan

Dengan model ini:

- queue tetap mudah dipetakan per kategori alat
- header tidak ambigu saat audit atau tracing message
- EMS bisa mencari message berdasarkan queue, `message_name`, `equipment_id`, atau `correlation_id`
