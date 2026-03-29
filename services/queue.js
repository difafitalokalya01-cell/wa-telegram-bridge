/**
 * FILE: services/queue.js
 * FUNGSI: Antrian pengiriman pesan WA dengan delay manusiawi
 *
 * ARSITEKTUR:
 * Antrian disimpan di Redis (bukan file JSON seperti versi lama).
 * Data antrian aman dari restart Railway — tidak akan hilang.
 *
 * DIGUNAKAN OLEH:
 * - index.js (mulaiProsesAntrian saat startup)
 * - bots/bot-bridge.js (tambahKeAntrian, getStatus, bersihkanAntrian)
 * - bots/bot-pool.js (tambahKeAntrian)
 * - bots/bot-reminder.js (tambahKeAntrian)
 *
 * MENGGUNAKAN:
 * - core/cache.js    (Redis — simpan & ambil antrian)
 * - core/events.js   (emit pesan:terkirim, pesan:gagal)
 * - services/wa-manager.js (kirimPesan, setPresence)
 * - logger.js
 *
 * EVENT YANG DIPANCARKAN:
 * - pesan:terkirim → { waId, jid }
 * - pesan:gagal    → { waId, jid, error }
 *
 * SISTEM DELAY MANUSIAWI (4 lapisan):
 * Lapis 1: Jeda baca    — simulasi membaca pesan kandidat
 * Lapis 2: Jeda pikir   — simulasi berpikir sebelum balas
 * Lapis 3: Jeda pindah  — simulasi pindah antar chat
 * Lapis 4: Jeda ketik   — simulasi mengetik balasan
 *
 * PERINGATAN:
 * isProcessing adalah state lokal — reset saat restart.
 * Tapi antrian di Redis tetap ada, akan dilanjutkan otomatis.
 */

"use strict";

const cache     = require("../core/cache");
const events    = require("../core/events");
const logger    = require("../logger");

// ===== STATE LOKAL =====
// isProcessing hanya ada di memory — reset saat restart
// Tidak masalah karena mulaiProsesAntrian dipanggil saat startup
let isProcessing = false;

// Referensi ke wa-manager — di-inject saat startup
// Menghindari circular dependency kalau di-require langsung
let waManager = null;

// ===== PENGATURAN DEFAULT =====
// Bisa diubah via bot-config tanpa restart
let settings = {
  typingSpeed:         "normal",  // lambat | normal | cepat
  randomDelay:         true,
  minDelay:            3,         // detik
  maxDelay:            10,        // detik
  readDelayShort:      { min: 30,  max: 60  },  // pesan < 50 karakter
  readDelayMedium:     { min: 60,  max: 180 },  // pesan 50-200 karakter
  readDelayLong:       { min: 180, max: 420 },  // pesan > 200 karakter
  thinkDelayMin:       120,       // detik
  thinkDelayMax:       300,       // detik
  switchChatDelayMin:  120,       // detik
  switchChatDelayMax:  480,       // detik
};

// ===== HELPER: RANDOM ANTARA =====
function randomAntara(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// ===== HELPER: HITUNG DELAY =====

/**
 * hitungJedaBaca(panjangPesanMasuk)
 * Hitung jeda "membaca" berdasarkan panjang pesan kandidat.
 * Semakin panjang pesannya, semakin lama HR "membaca".
 */
function hitungJedaBaca(panjangPesanMasuk) {
  let range;
  if (panjangPesanMasuk < 50)        range = settings.readDelayShort;
  else if (panjangPesanMasuk <= 200) range = settings.readDelayMedium;
  else                               range = settings.readDelayLong;
  return randomAntara(range.min, range.max) * 1000;
}

/**
 * hitungJedaPikir()
 * Hitung jeda "berpikir" sebelum mulai mengetik.
 */
function hitungJedaPikir() {
  return randomAntara(settings.thinkDelayMin, settings.thinkDelayMax) * 1000;
}

/**
 * hitungJedaPindahChat()
 * Hitung jeda saat pindah ke chat yang berbeda.
 */
function hitungJedaPindahChat() {
  return randomAntara(settings.switchChatDelayMin, settings.switchChatDelayMax) * 1000;
}

/**
 * hitungJedaKetik(teks)
 * Hitung jeda "mengetik" berdasarkan panjang dan kecepatan ketik.
 */
function hitungJedaKetik(teks) {
  const speeds = { lambat: 30, normal: 50, cepat: 80 };
  const cps    = speeds[settings.typingSpeed] || 50;
  let jeda     = (teks.length / cps) * 1000;
  if (settings.randomDelay) {
    jeda += randomAntara(settings.minDelay, settings.maxDelay) * 1000;
  }
  return Math.max(jeda, settings.minDelay * 1000);
}

// ===== HELPER: TUNGGU =====
/**
 * tunggu(ms, label)
 * Pause eksekusi selama ms milidetik dengan logging.
 */
async function tunggu(ms, label) {
  const detik = Math.round(ms / 1000);
  const menit = Math.floor(detik / 60);
  const sisa  = detik % 60;
  const label_waktu = menit > 0 ? `${menit}m ${sisa}s` : `${sisa}s`;
  logger.info("Queue", `${label}: ${label_waktu}`);
  await new Promise((r) => setTimeout(r, ms));
}

// ===== PROSES ANTRIAN =====
/**
 * prosesAntrian()
 * Loop utama yang memproses item antrian satu per satu.
 * Berhenti otomatis kalau antrian kosong.
 *
 * DIGUNAKAN OLEH: tambahKeAntrian, mulaiProsesAntrian
 * DAMPAK PERUBAHAN: Mengubah ini mempengaruhi
 * semua pengiriman pesan di sistem
 */
async function prosesAntrian() {
  if (isProcessing || !waManager) return;
  isProcessing = true;

  try {
    while (true) {
      // Ambil item paling depan dari Redis
      const item = await cache.ambilDariAntrian();
      if (!item) break; // Antrian kosong — berhenti

      // Buang item yang sudah lebih dari 10 menit (kadaluarsa)
      if (item.waktu && Date.now() - item.waktu > 10 * 60 * 1000) {
        logger.warn("Queue", `Item kadaluarsa dibuang: ${item.jid}`);
        continue;
      }

      // ── Lapis 3: Jeda pindah chat ────────────────────────
      // Cek apakah chat berbeda dari sebelumnya
      const lastJid = await cache.getLastJid(item.waId);
      if (lastJid && lastJid !== item.jid) {
        const jedaPindah = hitungJedaPindahChat();
        await tunggu(jedaPindah, `Jeda pindah chat ${item.waId}`);
      }

      // ── Lapis 1: Jeda baca ───────────────────────────────
      const panjang = item.panjangPesanMasuk || 0;
      if (panjang > 0) {
        const jedaBaca = hitungJedaBaca(panjang);
        await tunggu(jedaBaca, `Jeda baca pesan dari ${item.jid}`);
      }

      // ── Lapis 2: Jeda pikir ──────────────────────────────
      const jedaPikir = hitungJedaPikir();
      await tunggu(jedaPikir, `Jeda pikir sebelum balas ${item.jid}`);

      // ── Status online ────────────────────────────────────
      try {
        await waManager.setPresence(item.waId, item.jid, "available");
        await tunggu(1000, "Online sebentar");
      } catch (e) {
        logger.error("Queue", `Gagal set online: ${e.message}`);
      }

      // ── Lapis 4: Jeda ketik ──────────────────────────────
      const pesanTeks = item.pesan || "";
      const jedaKetik = hitungJedaKetik(pesanTeks);

      try {
        await waManager.setPresence(item.waId, item.jid, "composing");
        await tunggu(jedaKetik, `Typing ke ${item.jid}`);
        await waManager.setPresence(item.waId, item.jid, "paused");
      } catch (e) {
        logger.error("Queue", `Gagal set typing: ${e.message}`);
        await tunggu(jedaKetik, `Jeda ketik ke ${item.jid}`);
      }

      // ── Kirim pesan ──────────────────────────────────────
      try {
        await waManager.kirimPesan(item.waId, item.jid, item.pesan, item.media || null);
        await cache.setLastJid(item.waId, item.jid);
        logger.info("Queue", `Terkirim ke ${item.jid} via ${item.waId}`);
        events.emitSafe("pesan:terkirim", { waId: item.waId, jid: item.jid });
      } catch (err) {
        logger.error("Queue", `Gagal kirim ke ${item.jid}: ${err.message}`);
        events.emitSafe("pesan:gagal", {
          waId:  item.waId,
          jid:   item.jid,
          error: err.message,
        });
      }
    }
  } finally {
    isProcessing = false;
  }
}

// ===== PUBLIC API =====

/**
 * tambahKeAntrian(waId, jid, pesan, media, panjangPesanMasuk)
 * Tambahkan pesan ke antrian Redis dan mulai proses kalau belum jalan.
 *
 * @param waId             - ID akun WA pengirim
 * @param jid              - Nomor WA tujuan
 * @param pesan            - Teks pesan
 * @param media            - Object media (opsional)
 * @param panjangPesanMasuk - Panjang pesan dari kandidat (untuk hitung delay baca)
 *
 * DIGUNAKAN OLEH: bot-bridge.js, bot-pool.js, bot-reminder.js
 */
async function tambahKeAntrian(waId, jid, pesan, media = null, panjangPesanMasuk = 0) {
  await cache.tambahKeAntrian({
    waId, jid, pesan, media, panjangPesanMasuk,
    waktu: Date.now(),
  });

  // Mulai proses kalau belum jalan
  if (!isProcessing) prosesAntrian().catch((err) => {
    logger.error("Queue", `Error proses antrian: ${err.message}`);
    isProcessing = false;
  });
}

/**
 * mulaiProsesAntrian()
 * Dipanggil saat startup untuk melanjutkan antrian yang tersisa.
 * Antrian di Redis tetap ada meski Railway restart.
 *
 * DIGUNAKAN OLEH: index.js
 */
async function mulaiProsesAntrian() {
  const panjang = await cache.panjangAntrian();
  if (panjang > 0) {
    logger.info("Queue", `${panjang} pesan tersisa di antrian — melanjutkan...`);
    prosesAntrian().catch((err) => {
      logger.error("Queue", `Error proses antrian startup: ${err.message}`);
      isProcessing = false;
    });
  }
}

/**
 * bersihkanAntrian()
 * Kosongkan semua antrian.
 *
 * DIGUNAKAN OLEH: bot-bridge.js, bot-pool.js
 */
async function bersihkanAntrian() {
  return await cache.bersihkanAntrian();
}

/**
 * getStatus()
 * Ambil status antrian saat ini.
 *
 * DIGUNAKAN OLEH: bot-bridge.js, bot-pool.js
 */
async function getStatus() {
  const panjang = await cache.panjangAntrian();
  return {
    panjangAntrian: panjang,
    sedangProses:   isProcessing,
  };
}

/**
 * updateSettings(newSettings)
 * Update pengaturan delay tanpa restart.
 *
 * DIGUNAKAN OLEH: bot-config.js
 */
function updateSettings(newSettings) {
  settings = { ...settings, ...newSettings };
}

/**
 * setWaManager(wm)
 * Inject referensi wa-manager.
 * Dipanggil dari index.js saat startup.
 * Menghindari circular dependency.
 *
 * DIGUNAKAN OLEH: index.js
 */
function setWaManager(wm) {
  waManager = wm;
}

module.exports = {
  tambahKeAntrian,
  mulaiProsesAntrian,
  bersihkanAntrian,
  getStatus,
  updateSettings,
  setWaManager,
};
