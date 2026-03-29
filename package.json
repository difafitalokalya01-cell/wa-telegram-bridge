# PANDUAN DEPLOY ke Railway

## Environment Variables yang WAJIB diset di Railway

Buka wa-telegram-bridge → Variables → tambahkan semua ini:

```
DATABASE_URL        = postgresql://postgres:xxx@postgres.railway.internal:5432/railway
REDIS_URL           = redis://default:xxx@redis.railway.internal:6379
WEBHOOK_URL         = https://wa-telegram-bridge-production.up.railway.app
PORT                = 3000
AUTH_DIR            = /data/auth_sessions
DASHBOARD_PASSWORD  = password_pilihan_kamu (contoh: HRhimeya2024!)
JWT_SECRET          = string_random_panjang (contoh: buat di https://randomkeygen.com)
```

## Checklist sebelum deploy

### 1. Volume Mount di Railway
- Buka wa-telegram-bridge → Settings → Volumes
- Pastikan ada volume yang di-mount ke path: /data
- Kalau belum ada: klik "New Volume" → mount path: /data

### 2. config.json — pastikan token sudah terisi
Semua token bot Telegram harus sudah diisi (tidak ada yang masih GANTI_xxx)

### 3. Daftarkan akun WA di database
Setelah sistem pertama kali jalan, jalankan query ini di Postgres:
```sql
INSERT INTO wa_accounts (wa_id, aktif) VALUES ('wa1', true);
INSERT INTO wa_accounts (wa_id, aktif) VALUES ('wa2', true);
```

## Urutan deploy

1. Buat branch opsi-d di GitHub
2. Upload semua file ke branch opsi-d
3. Set semua environment variables di Railway
4. Set volume mount /data
5. Di Railway → wa-telegram-bridge → Settings → ubah branch ke opsi-d
6. Railway otomatis deploy
7. Cek log — pastikan "Semua sistem aktif ✅"
8. Buka: https://wa-telegram-bridge-production.up.railway.app/dashboard
9. Login dengan DASHBOARD_PASSWORD
10. Hubungkan WA: kirim /hubungkan wa1 ke bot WA di Telegram

## Akses Dashboard

URL: https://wa-telegram-bridge-production.up.railway.app/dashboard
Login: password yang kamu set di DASHBOARD_PASSWORD

## Troubleshooting

ERROR: DATABASE_URL not set
→ Tambahkan DATABASE_URL di environment variables

ERROR: connect ECONNREFUSED redis
→ Pastikan REDIS_URL sudah diset

Dashboard tidak bisa dibuka
→ Cek WEBHOOK_URL sudah benar
→ Cek log Railway tidak ada error startup

Auth session WA hilang setelah restart
→ Pastikan volume /data sudah di-mount
→ Pastikan AUTH_DIR=/data/auth_sessions sudah diset

Login dashboard gagal
→ Cek DASHBOARD_PASSWORD sudah diset di Railway Variables
→ Pastikan tidak ada spasi di awal/akhir password
