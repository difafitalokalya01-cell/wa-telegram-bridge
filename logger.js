# CONTEXT.md
# Dokumentasi Sistem wa-telegram-bridge
# Dibaca oleh bot deployment setiap kali memproses instruksi

---

## GAMBARAN SISTEM

wa-telegram-bridge adalah sistem jembatan antara WhatsApp dan Telegram
untuk keperluan rekrutmen di Himeya Agency dan Fashion Me.

**Stack teknologi:**
- Runtime: Node.js 20
- Database: PostgreSQL (Railway)
- Cache & Queue: Redis (Railway)
- Deploy: Railway (auto-deploy dari GitHub main branch)
- WA Library: @whiskeysockets/baileys v6.7.16 (CommonJS)
- Arsitektur: Event-driven, tidak ada circular dependency

---

## STRUKTUR FILE DAN TANGGUNG JAWAB

### Core (fondasi sistem, jangan ubah sembarangan)

| File | Fungsi | Dependency |
|------|--------|------------|
| `core/events.js` | Event emitter pusat — jantung komunikasi antar komponen | Tidak ada |
| `core/database.js` | Semua operasi Postgres — satu-satunya yang boleh query DB | pg, logger |
| `core/cache.js` | Semua operasi Redis — satu-satunya yang boleh akses Redis | ioredis, logger |
| `logger.js` | Logging ke file dan console | Tidak ada |

### Services (logika bisnis utama)

| File | Fungsi | Emit Event | Listen Event |
|------|--------|------------|--------------|
| `services/wa-manager.js` | Koneksi WA, kirim/terima pesan, resolve LID | wa:pesan_masuk, wa:media_masuk, wa:terhubung, wa:terputus, wa:qr_diterima, wa:pairing_code, wa:unread_ditemukan | - |
| `services/queue.js` | Antrian kirim pesan dengan delay manusiawi | pesan:terkirim, pesan:gagal | pesan:masuk_antrian |
| `services/reminder.js` | Cek kandidat belum dibalas setiap 5 menit | - | kandidat:diupdate |

### Handlers (proses event dari WA)

| File | Fungsi | Emit Event | Listen Event |
|------|--------|------------|--------------|
| `handlers/pesan-handler.js` | Proses pesan teks masuk dari WA | kandidat:dibuat, kandidat:diupdate | wa:pesan_masuk |
| `handlers/media-handler.js` | Proses media masuk dari WA | kandidat:diupdate | wa:media_masuk |
| `handlers/notif-handler.js` | Kirim notifikasi ke Telegram yang tepat | - | kandidat:dibuat, kandidat:diupdate |

### Bots (perintah HR via Telegram)

| File | Fungsi | Bot Telegram |
|------|--------|--------------|
| `bots/bot-bridge.js` | Perintah HR utama (/dc, /lihat, /A pesan, dll) | Bot Bridge (pool_3) |
| `bots/bot-pool.js` | Perintah per slot WA | Bot Pool (pool_1, pool_2, dst) |
| `bots/bot-wa.js` | Manajemen koneksi WA (QR, pairing) | Bot WA |
| `bots/bot-config.js` | Konfigurasi sistem via Telegram | Bot Config |
| `bots/bot-global.js` | Kontrol global semua WA | Bot Global |
| `bots/bot-reminder.js` | Bot pengingat kandidat belum dibalas | Bot Reminder |

---

## ALUR EVENT (tidak ada import langsung antar komponen)

```
WhatsApp kirim pesan
        ↓
wa-manager emit("wa:pesan_masuk", { waId, jid, nama, pesan })
        ↓
pesan-handler listen → simpan ke Postgres → emit("kandidat:dibuat")
        ↓
notif-handler listen → tentukan bot → kirim notif ke Telegram
```

```
HR ketik /A pesanmu di Telegram
        ↓
bot-bridge terima → cek kandidat di Postgres
        ↓
emit("pesan:masuk_antrian", { waId, jid, pesan })
        ↓
queue listen → delay manusiawi → kirim via wa-manager
        ↓
emit("pesan:terkirim") → update status kandidat
```

---

## DATABASE SCHEMA

### Tabel kandidat
```sql
id              TEXT PRIMARY KEY        -- ID huruf: A, B, C...
wa_id           TEXT                    -- akun WA yang menerima (wa1, wa2, dst)
jid             TEXT                    -- nomor WA: 628xxx@s.whatsapp.net
nama            TEXT                    -- nama dari WhatsApp
status          TEXT                    -- baru/perlu_dibalas/menunggu/selesai/tidak_aktif
pesan_terakhir  TEXT                    -- isi pesan terakhir
panjang_pesan   INTEGER                 -- untuk hitung delay manusiawi
catatan         TEXT                    -- catatan HR
waktu_pertama   BIGINT                  -- timestamp pertama chat
waktu_pesan     BIGINT                  -- timestamp pesan terakhir
waktu_balas     BIGINT                  -- timestamp terakhir dibalas
reminder_1      BOOLEAN                 -- sudah kirim reminder 30 menit?
reminder_2      BOOLEAN                 -- sudah kirim reminder 60 menit?
reminder_3      BOOLEAN                 -- sudah kirim reminder 120 menit?
```

### Tabel riwayat_chat
```sql
id              SERIAL PRIMARY KEY
kandidat_id     TEXT REFERENCES kandidat(id)
pengirim        TEXT                    -- nama pengirim atau "HR"
pesan           TEXT                    -- isi pesan (max 100 karakter)
waktu           TEXT                    -- format: "01 Jan, 09:30"
created_at      BIGINT
```

### Tabel kontak
```sql
wa_id           TEXT
jid_lid         TEXT                    -- LID WhatsApp (nomor panjang)
nomor           TEXT                    -- nomor WA asli
PRIMARY KEY (wa_id, jid_lid)
```

### Tabel blacklist
```sql
nomor           TEXT PRIMARY KEY
alasan          TEXT
waktu           BIGINT
```

### Tabel config
```sql
key             TEXT PRIMARY KEY
value           JSONB
updated_at      BIGINT
```

### Tabel bot_pool
```sql
pool_id         TEXT PRIMARY KEY        -- pool_1, pool_2, pool_3
wa_id           TEXT                    -- waId yang diassign
status          TEXT                    -- kosong/terisi
updated_at      BIGINT
```

### Tabel wa_accounts
```sql
wa_id           TEXT PRIMARY KEY        -- wa1, wa2, dst
aktif           BOOLEAN
created_at      BIGINT
```

---

## REDIS KEYS

| Key Pattern | TTL | Isi | Dipakai oleh |
|-------------|-----|-----|--------------|
| `dedup:{waId}:{msgId}` | 5 menit | "1" | wa-manager (cegah pesan double) |
| `retry:{waId}` | 1 jam | jumlah retry | wa-manager (reconnect) |
| `last_jid:{waId}` | 24 jam | JID string | queue (delay pindah chat) |
| `queue` | - | Redis List of JSON | queue service |

---

## CONFIG.JSON (token dan ID — tidak berubah saat runtime)

```json
{
  "botBridgeToken": "token bot bridge",
  "botWaToken": "token bot WA management",
  "botConfigToken": "token bot config",
  "botReminderToken": "token bot reminder",
  "botGlobalToken": "token bot global",
  "telegramChatId": "ID chat Telegram HR",
  "adminTelegramId": "ID admin Telegram",
  "botPool": [
    { "id": "pool_1", "token": "...", "nama": "Wa Bot 1" },
    { "id": "pool_2", "token": "...", "nama": "Wa Bot 2" },
    { "id": "pool_3", "token": "...", "nama": "Wa Bot 3" }
  ],
  "queueSettings": { ... },
  "reminderSettings": { "reminder1": 30, "reminder2": 60, "reminder3": 120 }
}
```

---

## ENVIRONMENT VARIABLES (Railway)

```
DATABASE_URL   → postgresql://postgres:xxx@postgres.railway.internal:5432/railway
REDIS_URL      → redis://default:xxx@redis.railway.internal:6379
WEBHOOK_URL    → https://wa-telegram-bridge-production.up.railway.app
PORT           → 3000
```

---

## ATURAN PENTING UNTUK BOT DEPLOYMENT

### BOLEH diubah dengan instruksi sederhana:
- Isi pesan notifikasi ke Telegram
- Waktu delay di queue
- Waktu reminder (reminder1, reminder2, reminder3)
- Format tampilan /dc, /lihat, /riwayat
- Penambahan perintah baru di bot manapun
- Logika filter kandidat

### HATI-HATI saat mengubah (konfirmasi dulu):
- `core/database.js` — perubahan schema butuh ALTER TABLE manual
- `services/wa-manager.js` — langsung mempengaruhi koneksi WA live
- `services/queue.js` — mempengaruhi pengiriman semua pesan

### JANGAN ubah tanpa diskusi mendalam:
- `core/events.js` — perubahan nama event akan breaking change di semua file
- `core/cache.js` — perubahan key pattern Redis mempengaruhi semua state
- Schema tabel Postgres yang sudah ada data

### FILE YANG SALING TERHUBUNG (dependency map):
```
Mengubah core/events.js   → semua file terpengaruh
Mengubah core/database.js → semua handler dan bot terpengaruh
Mengubah core/cache.js    → wa-manager, queue terpengaruh
Mengubah wa-manager.js    → semua handler terpengaruh (via events)
Mengubah pesan-handler.js → notif-handler terpengaruh (via events)
```

---

## STATUS PEMBANGUNAN

- [x] Fase 1: Setup database dan cache (core/)
- [ ] Fase 2: Migrasi wa-manager ke event-driven
- [ ] Fase 3: Bangun handlers
- [ ] Fase 4: Migrasi semua bot
- [ ] Fase 5: Migrasi queue ke Redis
- [ ] Fase 6: Testing & deploy

*Terakhir diupdate: 2026-03-29*
