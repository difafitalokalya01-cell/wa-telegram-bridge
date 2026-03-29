/**
 * FILE: core/database.js
 * FUNGSI: Koneksi ke Postgres dan pengelolaan semua tabel
 *
 * DIGUNAKAN OLEH:
 * - handlers/pesan-handler.js  (baca/tulis data kandidat)
 * - handlers/media-handler.js  (tulis data kandidat)
 * - handlers/notif-handler.js  (baca data kandidat)
 * - bots/bot-bridge.js         (baca/tulis kandidat & riwayat)
 * - bots/bot-pool.js           (baca kandidat per slot)
 * - bots/bot-reminder.js       (baca kandidat belum dibalas)
 * - bots/bot-config.js         (baca/tulis config)
 * - bots/bot-wa.js             (baca/tulis akun WA)
 * - services/wa-manager.js     (baca/tulis kontak & blacklist)
 *
 * MENGGUNAKAN:
 * - pg (node-postgres) untuk koneksi Postgres
 * - logger.js untuk mencatat error
 *
 * TABEL YANG DIKELOLA:
 * ─────────────────────────────────────────────
 * kandidat       → data utama semua kandidat
 * riwayat_chat   → histori percakapan per kandidat
 * kontak         → mapping LID ke nomor WA asli
 * blacklist      → nomor yang diblokir
 * config         → konfigurasi runtime sistem
 * bot_pool       → status slot bot pool
 * wa_accounts    → daftar akun WA yang terdaftar
 * chat_counter   → penghitung untuk generate ID kandidat
 * ─────────────────────────────────────────────
 *
 * PERINGATAN:
 * File ini adalah satu-satunya yang boleh akses Postgres langsung.
 * File lain TIDAK BOLEH import pg atau query Postgres sendiri.
 * Semua operasi database harus lewat fungsi yang diekspor di sini.
 */

"use strict";

const { Pool } = require("pg");
const logger   = require("../logger");

// ===== KONEKSI POSTGRES =====
// DATABASE_URL diset otomatis oleh Railway dari service Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway.internal")
    ? false  // Internal Railway tidak butuh SSL
    : { rejectUnauthorized: false },
  max:            10,   // Maksimal 10 koneksi bersamaan
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  logger.error("Database", `Postgres pool error: ${err.message}`);
});

// ===== SAFE QUERY WRAPPER =====
// Semua fungsi database menggunakan wrapper ini
// Kalau DB disconnect, kembalikan fallback daripada crash
async function safeQuery(fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    logger.error("Database", `Query error: ${err.message}`);
    return fallback;
  }
}

// ===== SETUP SEMUA TABEL =====
/**
 * setupTabel()
 * Buat semua tabel kalau belum ada.
 * Aman dipanggil berkali-kali (IF NOT EXISTS).
 * Dipanggil saat startup dari index.js.
 *
 * DAMPAK PERUBAHAN: Mengubah schema tabel di sini
 * tidak otomatis mengubah tabel yang sudah ada di Postgres.
 * Gunakan ALTER TABLE secara manual kalau perlu mengubah schema.
 */
async function setupTabel() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Tabel chat_counter ──────────────────────────────────────
    // Menyimpan penghitung untuk generate ID kandidat (A, B, C...)
    // Hanya ada 1 row dengan id = 'main'
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_counter (
        id      TEXT PRIMARY KEY DEFAULT 'main',
        counter INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Pastikan row utama ada
    await client.query(`
      INSERT INTO chat_counter (id, counter)
      VALUES ('main', 0)
      ON CONFLICT (id) DO NOTHING
    `);

    // ── Tabel kandidat ──────────────────────────────────────────
    // Data utama semua kandidat/pelamar yang chat via WA
    await client.query(`
      CREATE TABLE IF NOT EXISTS kandidat (
        id                TEXT PRIMARY KEY,
        wa_id             TEXT NOT NULL,
        jid               TEXT NOT NULL,
        nama              TEXT NOT NULL DEFAULT '',
        status            TEXT NOT NULL DEFAULT 'baru',
        pesan_terakhir    TEXT DEFAULT '',
        panjang_pesan     INTEGER DEFAULT 0,
        catatan           TEXT DEFAULT '',
        waktu_pertama     BIGINT NOT NULL,
        waktu_pesan       BIGINT NOT NULL,
        waktu_balas       BIGINT DEFAULT 0,
        reminder_1        BOOLEAN DEFAULT FALSE,
        reminder_2        BOOLEAN DEFAULT FALSE,
        reminder_3        BOOLEAN DEFAULT FALSE,
        UNIQUE(wa_id, jid)
      )
    `);

    // Index untuk query yang sering dipakai
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kandidat_status
      ON kandidat(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kandidat_wa_id
      ON kandidat(wa_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kandidat_waktu_pesan
      ON kandidat(waktu_pesan)
    `);

    // ── Tabel riwayat_chat ──────────────────────────────────────
    // Histori semua percakapan per kandidat
    // Maks 50 entri per kandidat (dibersihkan otomatis)
    await client.query(`
      CREATE TABLE IF NOT EXISTS riwayat_chat (
        id            SERIAL PRIMARY KEY,
        kandidat_id   TEXT NOT NULL REFERENCES kandidat(id) ON DELETE CASCADE,
        pengirim      TEXT NOT NULL,
        pesan         TEXT NOT NULL DEFAULT '',
        waktu         TEXT NOT NULL,
        created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_riwayat_kandidat
      ON riwayat_chat(kandidat_id)
    `);

    // ── Tabel kontak ────────────────────────────────────────────
    // Mapping LID WhatsApp ke nomor asli
    // Dipakai oleh wa-manager untuk resolve LID
    await client.query(`
      CREATE TABLE IF NOT EXISTS kontak (
        wa_id     TEXT NOT NULL,
        jid_lid   TEXT NOT NULL,
        nomor     TEXT NOT NULL,
        PRIMARY KEY (wa_id, jid_lid)
      )
    `);

    // ── Tabel blacklist ─────────────────────────────────────────
    // Nomor WA yang diblokir dari sistem
    await client.query(`
      CREATE TABLE IF NOT EXISTS blacklist (
        nomor       TEXT PRIMARY KEY,
        alasan      TEXT DEFAULT '',
        waktu       BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);

    // ── Tabel config ────────────────────────────────────────────
    // Konfigurasi runtime yang bisa berubah tanpa restart
    // Key-value store sederhana
    await client.query(`
      CREATE TABLE IF NOT EXISTS config (
        key         TEXT PRIMARY KEY,
        value       JSONB NOT NULL,
        updated_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);

    // ── Tabel bot_pool ──────────────────────────────────────────
    // Status setiap slot bot pool (waId yang assigned, dll)
    // Token bot disimpan di config.json, bukan di sini
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_pool (
        pool_id     TEXT PRIMARY KEY,
        wa_id       TEXT DEFAULT NULL,
        status      TEXT NOT NULL DEFAULT 'kosong',
        updated_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);

    // ── Tabel wa_accounts ───────────────────────────────────────
    // Daftar akun WA yang terdaftar di sistem
    await client.query(`
      CREATE TABLE IF NOT EXISTS wa_accounts (
        wa_id       TEXT PRIMARY KEY,
        aktif       BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);

    await client.query("COMMIT");
    logger.info("Database", "Semua tabel siap ✅");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("Database", `Gagal setup tabel: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// ===== OPERASI CHAT COUNTER =====

/**
 * getAndIncrementCounter()
 * Ambil nilai counter sekarang lalu increment atomik.
 * Dipakai untuk generate ID kandidat baru.
 *
 * DIGUNAKAN OLEH: handlers/pesan-handler.js
 * DAMPAK PERUBAHAN: Mengubah ini akan mempengaruhi
 * cara ID kandidat dibuat
 */
async function getAndIncrementCounter() {
  return safeQuery(async () => {
      const result = await pool.query(`
        UPDATE chat_counter
        SET counter = counter + 1
        WHERE id = 'main'
        RETURNING counter - 1 AS nilai
      `);
      return result.rows[0].nilai;
  }, 0);
}

// ===== OPERASI KANDIDAT =====

/**
 * buatKandidat(data)
 * Buat entri kandidat baru di database.
 *
 * @param data.id           - ID huruf kandidat (A, B, C...)
 * @param data.waId         - ID akun WA
 * @param data.jid          - Nomor WA kandidat
 * @param data.nama         - Nama kandidat
 *
 * DIGUNAKAN OLEH: handlers/pesan-handler.js
 */
async function buatKandidat(data) {
  return safeQuery(async () => {
      const sekarang = Date.now();
      await pool.query(`
        INSERT INTO kandidat
          (id, wa_id, jid, nama, status, waktu_pertama, waktu_pesan)
        VALUES ($1, $2, $3, $4, 'baru', $5, $5)
        ON CONFLICT (wa_id, jid) DO NOTHING
      `, [data.id, data.waId, data.jid, data.nama, sekarang]);
  }, null);
}

/**
 * getKandidat(id)
 * Ambil data satu kandidat berdasarkan ID.
 *
 * @param id - ID huruf kandidat
 * @returns  - Object kandidat atau null
 *
 * DIGUNAKAN OLEH: bot-bridge.js, bot-pool.js, bot-reminder.js
 */
async function getKandidat(id) {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT * FROM kandidat WHERE id = $1",
        [id]
      );
      return result.rows[0] || null;
  }, null);
}

/**
 * getKandidatByJid(waId, jid)
 * Ambil data kandidat berdasarkan waId dan JID.
 * Dipakai untuk cek apakah kandidat sudah ada sebelum buat baru.
 *
 * DIGUNAKAN OLEH: handlers/pesan-handler.js
 */
async function getKandidatByJid(waId, jid) {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT * FROM kandidat WHERE wa_id = $1 AND jid = $2",
        [waId, jid]
      );
      return result.rows[0] || null;
  }, null);
}

/**
 * updateKandidat(id, data)
 * Update field tertentu dari kandidat.
 *
 * @param id   - ID kandidat
 * @param data - Object berisi field yang ingin diupdate
 *
 * DIGUNAKAN OLEH: Semua bot dan handler
 * DAMPAK PERUBAHAN: Mengubah ini mempengaruhi semua
 * operasi update kandidat di seluruh sistem
 */
async function updateKandidat(id, data) {
  const fields = [];
  const values = [];
  let   i      = 1;

  const mapping = {
    nama:          "nama",
    status:        "status",
    pesanTerakhir: "pesan_terakhir",
    panjangPesan:  "panjang_pesan",
    catatan:       "catatan",
    waktuPesan:    "waktu_pesan",
    waktuBalas:    "waktu_balas",
    reminder1:     "reminder_1",
    reminder2:     "reminder_2",
    reminder3:     "reminder_3",
    jid:           "jid",
  };

  for (const [key, col] of Object.entries(mapping)) {
    if (data[key] !== undefined) {
      fields.push(`${col} = $${i++}`);
      values.push(data[key]);
    }
  }

  if (fields.length === 0) return;
  values.push(id);

  await pool.query(
    `UPDATE kandidat SET ${fields.join(", ")} WHERE id = $${i}`,
    values
  );
}

/**
 * getDaftarKandidat(filter)
 * Ambil daftar kandidat dengan filter opsional.
 *
 * @param filter.status  - Filter berdasarkan status
 * @param filter.waId    - Filter berdasarkan akun WA
 * @param filter.limit   - Batas jumlah hasil (default 100)
 * @param filter.offset  - Offset untuk pagination
 *
 * DIGUNAKAN OLEH: bot-bridge.js, bot-pool.js
 */
async function getDaftarKandidat(filter = {}) {
  const conditions = [];
  const values     = [];
  let   i          = 1;

  if (filter.status) {
    conditions.push(`status = $${i++}`);
    values.push(filter.status);
  }
  if (filter.waId) {
    conditions.push(`wa_id = $${i++}`);
    values.push(filter.waId);
  }

  const where  = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit  = filter.limit  || 100;
  const offset = filter.offset || 0;

  values.push(limit, offset);

  const result = await pool.query(`
    SELECT * FROM kandidat
    ${where}
    ORDER BY waktu_pesan ASC
    LIMIT $${i++} OFFSET $${i++}
  `, values);

  return result.rows;
}

/**
 * hitungKandidat(filter)
 * Hitung jumlah kandidat per status.
 * Dipakai untuk ringkasan /dc
 *
 * DIGUNAKAN OLEH: bot-bridge.js
 */
async function hitungKandidat() {
  return safeQuery(async () => {
      const result = await pool.query(`
        SELECT status, COUNT(*) as jumlah
        FROM kandidat
        GROUP BY status
      `);
      const counts = {};
      for (const row of result.rows) {
        counts[row.status] = parseInt(row.jumlah);
      }
      return counts;
  }, {});
}

/**
 * cekDuplikatKandidat(waId, jid)
 * Cek apakah nomor ini sudah pernah chat di waId lain.
 *
 * DIGUNAKAN OLEH: handlers/pesan-handler.js
 */
async function cekDuplikatKandidat(waId, jid) {
  return safeQuery(async () => {
      const nomor  = jid.replace(/@.*/, "");
      const batas7Hari = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const result = await pool.query(`
        SELECT id, wa_id, nama, status, waktu_pesan
        FROM kandidat
        WHERE wa_id != $1
          AND jid LIKE $2
          AND NOT (status = 'selesai' AND waktu_pesan < $3)
        ORDER BY waktu_pesan DESC
        LIMIT 3
      `, [waId, `${nomor}%`, batas7Hari]);

      return result.rows;
  }, []);
}

/**
 * arsipKandidatLama()
 * Hapus kandidat berstatus 'selesai' yang sudah lebih dari 30 hari.
 * Dipanggil saat startup.
 *
 * DIGUNAKAN OLEH: index.js
 */
async function arsipKandidatLama() {
  return safeQuery(async () => {
      const batas = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const result = await pool.query(`
        DELETE FROM kandidat
        WHERE status = 'selesai' AND waktu_pesan < $1
        RETURNING id
      `, [batas]);
      if (result.rowCount > 0) {
        logger.info("Database", `${result.rowCount} kandidat lama diarsipkan`);
      }
  }, null);
}

// ===== OPERASI RIWAYAT CHAT =====

/**
 * tambahRiwayat(kandidatId, pengirim, pesan)
 * Tambah entri riwayat percakapan.
 * Otomatis hapus riwayat lama kalau sudah lebih dari 50 entri.
 *
 * DIGUNAKAN OLEH: handlers/pesan-handler.js, bot-bridge.js
 */
async function tambahRiwayat(kandidatId, pengirim, pesan) {
  return safeQuery(async () => {
      const waktu = new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit", month: "short",
        hour: "2-digit", minute: "2-digit",
      });

      // Potong pesan panjang
      const pesanPotong = pesan?.length > 100
        ? pesan.slice(0, 100) + "..."
        : (pesan || "");

      await pool.query(`
        INSERT INTO riwayat_chat (kandidat_id, pengirim, pesan, waktu, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [kandidatId, pengirim, pesanPotong, waktu, Date.now()]);

      // Hapus riwayat lama kalau sudah lebih dari 50 entri
      await pool.query(`
        DELETE FROM riwayat_chat
        WHERE kandidat_id = $1
          AND id NOT IN (
            SELECT id FROM riwayat_chat
            WHERE kandidat_id = $1
            ORDER BY created_at DESC
            LIMIT 50
          )
      `, [kandidatId]);
  }, null);
}

/**
 * getRiwayat(kandidatId, limit)
 * Ambil riwayat percakapan kandidat.
 *
 * @param kandidatId - ID kandidat
 * @param limit      - Jumlah entri (default 50)
 *
 * DIGUNAKAN OLEH: bot-bridge.js
 */
async function getRiwayat(kandidatId, limit = 50) {
  return safeQuery(async () => {
      const result = await pool.query(`
        SELECT * FROM riwayat_chat
        WHERE kandidat_id = $1
        ORDER BY created_at ASC
        LIMIT $2
      `, [kandidatId, limit]);
      return result.rows;
  }, []);
}

// ===== OPERASI KONTAK (LID MAPPING) =====

/**
 * simpanKontak(waId, jidLid, nomor)
 * Simpan mapping LID ke nomor WA asli.
 *
 * DIGUNAKAN OLEH: services/wa-manager.js
 * DAMPAK PERUBAHAN: Mengubah ini mempengaruhi
 * kemampuan resolve LID di wa-manager
 */
async function simpanKontak(waId, jidLid, nomor) {
  return safeQuery(async () => {
      await pool.query(`
        INSERT INTO kontak (wa_id, jid_lid, nomor)
        VALUES ($1, $2, $3)
        ON CONFLICT (wa_id, jid_lid) DO UPDATE SET nomor = $3
      `, [waId, jidLid, nomor]);
  }, null);
}

/**
 * getKontak(waId, jidLid)
 * Ambil nomor WA asli dari LID.
 *
 * DIGUNAKAN OLEH: services/wa-manager.js
 */
async function getKontak(waId, jidLid) {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT nomor FROM kontak WHERE wa_id = $1 AND jid_lid = $2",
        [waId, jidLid]
      );
      return result.rows[0]?.nomor || null;
  }, null);
}

// ===== OPERASI BLACKLIST =====

/**
 * cekBlacklist(nomor)
 * Cek apakah nomor ada di blacklist.
 *
 * DIGUNAKAN OLEH: services/wa-manager.js
 */
async function cekBlacklist(nomor) {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT nomor FROM blacklist WHERE nomor = $1",
        [nomor]
      );
      return result.rows.length > 0;
  }, false);
}

/**
 * tambahBlacklist(nomor, alasan)
 * Tambahkan nomor ke blacklist.
 *
 * DIGUNAKAN OLEH: bots/bot-config.js
 */
async function tambahBlacklist(nomor, alasan = "") {
  return safeQuery(async () => {
      await pool.query(`
        INSERT INTO blacklist (nomor, alasan, waktu)
        VALUES ($1, $2, $3)
        ON CONFLICT (nomor) DO NOTHING
      `, [nomor, alasan, Date.now()]);
  }, null);
}

/**
 * hapusBlacklist(nomor)
 * Hapus nomor dari blacklist.
 *
 * DIGUNAKAN OLEH: bots/bot-config.js
 */
async function hapusBlacklist(nomor) {
  return safeQuery(async () => {
      await pool.query("DELETE FROM blacklist WHERE nomor = $1", [nomor]);
  }, null);
}

/**
 * getDaftarBlacklist()
 * Ambil semua nomor yang diblacklist.
 *
 * DIGUNAKAN OLEH: bots/bot-config.js
 */
async function getDaftarBlacklist() {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT * FROM blacklist ORDER BY waktu DESC"
      );
      return result.rows;
  }, []);
}

// ===== OPERASI CONFIG =====

/**
 * getConfig(key)
 * Ambil nilai config berdasarkan key.
 *
 * DIGUNAKAN OLEH: Semua bot
 */
async function getConfig(key) {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT value FROM config WHERE key = $1",
        [key]
      );
      return result.rows[0]?.value ?? null;
  }, null);
}

/**
 * setConfig(key, value)
 * Set nilai config. Upsert — buat baru atau update.
 *
 * DIGUNAKAN OLEH: bots/bot-config.js, bots/bot-wa.js
 */
async function setConfig(key, value) {
  return safeQuery(async () => {
      await pool.query(`
        INSERT INTO config (key, value, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE
        SET value = $2, updated_at = $3
      `, [key, JSON.stringify(value), Date.now()]);
  }, null);
}

// ===== OPERASI BOT POOL =====

/**
 * getSlotByWaId(waId)
 * Cari slot pool yang menggunakan waId tertentu.
 *
 * DIGUNAKAN OLEH: handlers/pesan-handler.js, handlers/notif-handler.js
 */
async function getSlotByWaId(waId) {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT * FROM bot_pool WHERE wa_id = $1",
        [waId]
      );
      return result.rows[0] || null;
  }, null);
}

/**
 * updateSlot(poolId, data)
 * Update status slot pool.
 *
 * DIGUNAKAN OLEH: bots/bot-global.js, bots/bot-wa.js
 */
async function updateSlot(poolId, data) {
  return safeQuery(async () => {
      await pool.query(`
        INSERT INTO bot_pool (pool_id, wa_id, status, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (pool_id) DO UPDATE
        SET wa_id = $2, status = $3, updated_at = $4
      `, [poolId, data.waId || null, data.status || "kosong", Date.now()]);
  }, null);
}

/**
 * getSlotKosong()
 * Cari slot pool yang masih kosong.
 *
 * DIGUNAKAN OLEH: bots/bot-wa.js
 */
async function getSlotKosong() {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT * FROM bot_pool WHERE status = 'kosong' LIMIT 1"
      );
      return result.rows[0] || null;
  }, null);
}

// ===== OPERASI WA ACCOUNTS =====

/**
 * getWaAccounts()
 * Ambil semua akun WA yang terdaftar.
 *
 * DIGUNAKAN OLEH: index.js, services/wa-manager.js
 */
async function getWaAccounts() {
  return safeQuery(async () => {
      const result = await pool.query(
        "SELECT * FROM wa_accounts ORDER BY created_at ASC"
      );
      return result.rows;
  }, []);
}

/**
 * setWaAktif(waId, aktif)
 * Aktifkan atau nonaktifkan akun WA.
 *
 * DIGUNAKAN OLEH: services/wa-manager.js (saat logout permanen)
 */
async function setWaAktif(waId, aktif) {
  return safeQuery(async () => {
      await pool.query(`
        INSERT INTO wa_accounts (wa_id, aktif)
        VALUES ($1, $2)
        ON CONFLICT (wa_id) DO UPDATE SET aktif = $2
      `, [waId, aktif]);
  }, null);
}

// ===== HEALTH CHECK =====

/**
 * ping()
 * Cek apakah koneksi database masih hidup.
 *
 * DIGUNAKAN OLEH: index.js (health check endpoint)
 */
async function ping() {
  return safeQuery(async () => {
      await pool.query("SELECT 1");
      return true;
  }, false);
}

// Export pool untuk dipakai langsung kalau perlu
module.exports = {
  pool,
  // Setup
  setupTabel,
  ping,

  // Counter
  getAndIncrementCounter,

  // Kandidat
  buatKandidat,
  getKandidat,
  getKandidatByJid,
  updateKandidat,
  getDaftarKandidat,
  hitungKandidat,
  cekDuplikatKandidat,
  arsipKandidatLama,

  // Riwayat
  tambahRiwayat,
  getRiwayat,

  // Kontak
  simpanKontak,
  getKontak,

  // Blacklist
  cekBlacklist,
  tambahBlacklist,
  hapusBlacklist,
  getDaftarBlacklist,

  // Config
  getConfig,
  setConfig,

  // Bot Pool
  getSlotByWaId,
  updateSlot,
  getSlotKosong,

  // WA Accounts
  getWaAccounts,
  setWaAktif,
};
