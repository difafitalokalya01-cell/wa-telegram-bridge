/**
 * FILE: core/cache.js
 * FUNGSI: Koneksi ke Redis dan semua operasi cache/state
 *
 * DIGUNAKAN OLEH:
 * - services/wa-manager.js  (deduplication pesan, retry count, contact store)
 * - services/queue.js       (antrian pesan, last jid per waId)
 * - handlers/pesan-handler.js (cek duplikat sebelum proses)
 *
 * MENGGUNAKAN:
 * - ioredis untuk koneksi Redis
 * - logger.js untuk mencatat error
 *
 * DATA YANG DIKELOLA DI REDIS:
 * ─────────────────────────────────────────────────────
 * dedup:{waId}:{msgId}     → TTL 5 menit  — cegah pesan diproses 2x
 * retry:{waId}             → TTL 1 jam    — jumlah retry reconnect WA
 * last_jid:{waId}          → TTL 24 jam   — JID terakhir yang dibalas (untuk delay pindah chat)
 * queue                    → Redis List   — antrian pesan yang akan dikirim
 * ─────────────────────────────────────────────────────
 *
 * KEUNTUNGAN vs memory biasa:
 * - Data tetap ada meski Railway restart
 * - TTL otomatis — tidak perlu cleanup manual
 * - Thread-safe — tidak ada race condition
 *
 * PERINGATAN:
 * File ini adalah satu-satunya yang boleh akses Redis langsung.
 * File lain TIDAK BOLEH import ioredis sendiri.
 * Semua operasi Redis harus lewat fungsi yang diekspor di sini.
 */

"use strict";

const Redis  = require("ioredis");
const logger = require("../logger");

// ===== KONEKSI REDIS =====
// REDIS_URL diset otomatis oleh Railway dari service Redis
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
  reconnectOnError(err) {
    return err.message.includes("READONLY");
  },
});

redis.on("connect", () => {
  logger.info("Cache", "Redis terhubung ✅");
});

redis.on("error", (err) => {
  logger.error("Cache", `Redis error: ${err.message}`);
});


redis.on("reconnecting", () => {
  logger.warn("Cache", "Redis reconnecting...");
});

// ===== SAFE REDIS WRAPPER =====
// Kalau Redis disconnect, kembalikan fallback daripada crash
async function safeRedis(fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    logger.error("Cache", `Redis error: ${err.message}`);
    return fallback;
  }
}

// ===== DEDUPLICATION PESAN =====

/**
 * isDuplicateMsg(waId, msgId)
 * Cek apakah pesan sudah pernah diproses sebelumnya.
 * Kalau belum, tandai sebagai sudah diproses (TTL 5 menit).
 *
 * @param waId  - ID akun WA
 * @param msgId - ID unik pesan dari WhatsApp
 * @returns     - true kalau duplikat, false kalau baru
 *
 * DIGUNAKAN OLEH: services/wa-manager.js
 * DAMPAK PERUBAHAN: Mengubah TTL akan mempengaruhi
 * window waktu deteksi duplikat
 */
async function isDuplicateMsg(waId, msgId) {
  return safeRedis(async () => {
      const key    = `dedup:${waId}:${msgId}`;
      const result = await redis.set(key, "1", "EX", 300, "NX"); // TTL 5 menit
      // NX = set hanya kalau key belum ada
      // result = "OK" kalau baru set (bukan duplikat)
      // result = null kalau key sudah ada (duplikat)
      return result === null;
  }, false);
}

// ===== RETRY COUNT =====

/**
 * getRetryCount(waId)
 * Ambil jumlah retry reconnect untuk waId.
 *
 * DIGUNAKAN OLEH: services/wa-manager.js
 */
async function getRetryCount(waId) {
  return safeRedis(async () => {
      const val = await redis.get(`retry:${waId}`);
      return val ? parseInt(val) : 0;
  }, 0);
}

/**
 * incrementRetryCount(waId)
 * Tambah 1 ke retry count. TTL 1 jam.
 *
 * DIGUNAKAN OLEH: services/wa-manager.js
 */
async function incrementRetryCount(waId) {
  return safeRedis(async () => {
      const key = `retry:${waId}`;
      await redis.incr(key);
      await redis.expire(key, 3600); // TTL 1 jam
  }, null);
}

/**
 * resetRetryCount(waId)
 * Reset retry count ke 0 (setelah berhasil connect).
 *
 * DIGUNAKAN OLEH: services/wa-manager.js
 */
async function resetRetryCount(waId) {
  return safeRedis(async () => {
      await redis.del(`retry:${waId}`);
  }, null);
}

// ===== LAST JID (untuk delay pindah chat) =====

/**
 * getLastJid(waId)
 * Ambil JID terakhir yang dibalas untuk waId tertentu.
 * Dipakai untuk hitung apakah perlu delay pindah chat.
 *
 * DIGUNAKAN OLEH: services/queue.js
 */
async function getLastJid(waId) {
  return safeRedis(async () => {
      return await redis.get(`last_jid:${waId}`);
  }, null);
}

/**
 * setLastJid(waId, jid)
 * Simpan JID terakhir yang dibalas. TTL 24 jam.
 *
 * DIGUNAKAN OLEH: services/queue.js
 */
async function setLastJid(waId, jid) {
  return safeRedis(async () => {
      await redis.set(`last_jid:${waId}`, jid, "EX", 86400); // TTL 24 jam
  }, null);
}

// ===== ANTRIAN PESAN =====
// Menggunakan Redis List sebagai queue FIFO
// Key: "queue" — satu antrian global untuk semua WA

/**
 * tambahKeAntrian(item)
 * Tambahkan item ke ujung antrian (RPUSH).
 *
 * @param item - Object { waId, jid, pesan, media, panjangPesanMasuk, waktu }
 *
 * DIGUNAKAN OLEH: bots/bot-bridge.js, bots/bot-pool.js
 * DAMPAK PERUBAHAN: Mengubah format item akan mempengaruhi
 * cara queue.js memproses antrian
 */
async function tambahKeAntrian(item) {
  return safeRedis(async () => {
      await redis.rpush("queue", JSON.stringify({
        ...item,
        waktu: item.waktu || Date.now(),
      }));
  }, null);
}

/**
 * ambilDariAntrian()
 * Ambil item paling depan dari antrian (LPOP).
 * Returns null kalau antrian kosong.
 *
 * DIGUNAKAN OLEH: services/queue.js
 */
async function ambilDariAntrian() {
  return safeRedis(async () => {
      const raw = await redis.lpop("queue");
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
  }, null);
}

/**
 * panjangAntrian()
 * Hitung jumlah item di antrian.
 *
 * DIGUNAKAN OLEH: services/queue.js, bots/bot-bridge.js
 */
async function panjangAntrian() {
  return safeRedis(async () => {
      return await redis.llen("queue");
  }, 0);
}

/**
 * bersihkanAntrian()
 * Hapus semua item dari antrian.
 *
 * DIGUNAKAN OLEH: bots/bot-bridge.js
 */
async function bersihkanAntrian() {
  return safeRedis(async () => {
      const jumlah = await redis.llen("queue");
      await redis.del("queue");
      return jumlah;
  }, 0);
}

// ===== HEALTH CHECK =====

/**
 * ping()
 * Cek apakah koneksi Redis masih hidup.
 *
 * DIGUNAKAN OLEH: index.js (health check endpoint)
 */
async function ping() {
  return safeRedis(async () => {
      await redis.ping();
      return true;
  }, false);
}

/**
 * getRedisClient()
 * Expose raw Redis client untuk kebutuhan khusus.
 * Gunakan dengan hati-hati.
 *
 * DIGUNAKAN OLEH: (hanya kalau benar-benar perlu)
 */
function getRedisClient() {
  return redis;
}

module.exports = {
  // Deduplication
  isDuplicateMsg,

  // Retry count
  getRetryCount,
  incrementRetryCount,
  resetRetryCount,

  // Last JID
  getLastJid,
  setLastJid,

  // Antrian
  tambahKeAntrian,
  ambilDariAntrian,
  panjangAntrian,
  bersihkanAntrian,

  // Utils
  ping,
  getRedisClient,
};
