/**
 * FILE: handlers/notif-handler.js
 * FUNGSI: Mengirim notifikasi ke Telegram yang tepat
 *         berdasarkan event kandidat
 *
 * ARSITEKTUR:
 * Listen semua event kandidat dari pesan-handler & media-handler.
 * Tentukan bot Telegram mana yang harus kirim notif
 * (bot pool yang sesuai atau bot bridge sebagai fallback).
 * Kirim notifikasi dengan format yang lengkap.
 *
 * DIGUNAKAN OLEH:
 * - index.js (registerHandlers dipanggil saat startup)
 *
 * MENGGUNAKAN:
 * - core/events.js    (listen event)
 * - core/database.js  (getSlotByWaId, getConfig)
 * - logger.js
 * - axios, form-data  (kirim ke Telegram API)
 *
 * EVENT YANG DIDENGAR:
 * - kandidat:dibuat          → kirim notif pesan baru
 * - kandidat:diupdate        → kirim notif pesan baru
 * - kandidat:media_masuk     → kirim notif media
 * - kandidat:unread_ringkasan → kirim ringkasan pesan terlewat
 * - wa:terhubung             → notif WA connect
 * - wa:terputus              → notif WA disconnect
 *
 * TIDAK EMIT EVENT APAPUN.
 *
 * PERINGATAN:
 * Token bot dibaca dari config.json — tidak dari database.
 * Kalau token berubah, perlu restart service.
 *
 * DEPENDENCY MAP TELEGRAM API:
 * sendMessage  → semua notif teks
 * sendPhoto    → media foto
 * sendVideo    → media video
 * sendDocument → media dokumen
 * sendAudio    → media audio
 */

"use strict";

const axios    = require("axios");
const FormData = require("form-data");
const fs       = require("fs");
const events   = require("../core/events");
const db       = require("../core/database");
const logger   = require("../logger");

// ===== BACA CONFIG =====
// Token dan chat ID dari config.json — statis
// Tidak perlu akses database untuk ini
let _config = null;

function getConfig() {
  if (!_config) {
    try {
      _config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    } catch (e) {
      logger.error("Notif-Handler", `Gagal baca config.json: ${e.message}`);
      _config = {};
    }
  }
  return _config;
}

function getAdminId() { return getConfig().adminTelegramId; }

// ===== KIRIM KE TELEGRAM =====

/**
 * kirimTeks(token, chatId, teks)
 * Kirim pesan teks ke chat Telegram tertentu.
 *
 * DIGUNAKAN OLEH: Semua fungsi notif di file ini
 * DAMPAK PERUBAHAN: Mengubah ini mempengaruhi semua notif teks
 */
async function kirimTeks(token, chatId, teks, parseMode = "HTML") {
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    chatId,
      text:       teks,
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Notif-Handler", `Gagal kirim teks: ${err.message}`);
  }
}

/**
 * kirimFoto(token, chatId, buffer, caption)
 * Kirim foto ke chat Telegram.
 */
async function kirimFoto(token, chatId, buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", buffer, { filename: "photo.jpg", contentType: "image/jpeg" });
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    await axios.post(
      `https://api.telegram.org/bot${token}/sendPhoto`,
      form,
      { headers: form.getHeaders() }
    );
  } catch (err) {
    logger.error("Notif-Handler", `Gagal kirim foto: ${err.message}`);
  }
}

/**
 * kirimVideo(token, chatId, buffer, caption)
 * Kirim video ke chat Telegram.
 */
async function kirimVideo(token, chatId, buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("video", buffer, { filename: "video.mp4", contentType: "video/mp4" });
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    await axios.post(
      `https://api.telegram.org/bot${token}/sendVideo`,
      form,
      { headers: form.getHeaders() }
    );
  } catch (err) {
    logger.error("Notif-Handler", `Gagal kirim video: ${err.message}`);
  }
}

/**
 * kirimDokumen(token, chatId, buffer, filename, caption)
 * Kirim dokumen ke chat Telegram.
 */
async function kirimDokumen(token, chatId, buffer, filename, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("document", buffer, { filename: filename || "file" });
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    await axios.post(
      `https://api.telegram.org/bot${token}/sendDocument`,
      form,
      { headers: form.getHeaders() }
    );
  } catch (err) {
    logger.error("Notif-Handler", `Gagal kirim dokumen: ${err.message}`);
  }
}

/**
 * kirimAudio(token, chatId, buffer)
 * Kirim audio ke chat Telegram.
 */
async function kirimAudio(token, chatId, buffer) {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("audio", buffer, { filename: "audio.ogg", contentType: "audio/ogg" });
    await axios.post(
      `https://api.telegram.org/bot${token}/sendAudio`,
      form,
      { headers: form.getHeaders() }
    );
  } catch (err) {
    logger.error("Notif-Handler", `Gagal kirim audio: ${err.message}`);
  }
}

/**
 * kirimError(pesan)
 * Kirim notif error ke admin via bot bridge.
 * Selalu pakai token bridge sebagai fallback.
 *
 * DIGUNAKAN OLEH: index.js (global error handler)
 */
async function kirimError(pesan) {
  const cfg   = getConfig();
  const token = cfg.botBridgeToken || cfg.botPool?.find((p) => p.id === "pool_3")?.token;
  const admin = getAdminId();
  if (!token || !admin) return;
  await kirimTeks(token, admin, `<b>ERROR</b>\n\n${pesan}`);
}

// ===== TENTUKAN TOKEN & CHAT ID =====

/**
 * getTokenDanChatId(waId)
 * Tentukan token bot dan chat ID yang harus dipakai
 * berdasarkan waId. Cek slot pool dulu, fallback ke bridge.
 *
 * DIGUNAKAN OLEH: Semua fungsi notif
 * DAMPAK PERUBAHAN: Mengubah ini mempengaruhi
 * routing notif ke bot yang tepat
 */
async function getTokenDanChatId(waId) {
  const cfg    = getConfig();
  const adminId = getAdminId();

  // Cek apakah waId ini punya slot pool
  // slot dari DB punya kolom: pool_id, wa_id, status
  const slot = await db.getSlotByWaId(waId);
  if (slot?.pool_id) {
    // Cari token dari config.json berdasarkan pool_id
    const poolConfig = cfg.botPool?.find((p) => p.id === slot.pool_id);
    if (poolConfig?.token) {
      return { token: poolConfig.token, chatId: adminId, slotNama: poolConfig.nama };
    }
  }

  // Fallback ke bot bridge (pool_3 atau botBridgeToken)
  const bridgeToken = cfg.botBridgeToken || cfg.botPool?.find((p) => p.id === "pool_3")?.token;
  const bridgeChatId = cfg.telegramChatId || adminId;
  return { token: bridgeToken, chatId: bridgeChatId, slotNama: null };
}

// ===== FORMAT HELPER =====

/**
 * formatWaktu(timestamp)
 * Format timestamp jadi teks relatif ("5 menit lalu", dst).
 */
function formatWaktu(timestamp) {
  const selisih = Date.now() - timestamp;
  const menit   = Math.floor(selisih / 60000);
  const jam     = Math.floor(menit / 60);
  const hari    = Math.floor(jam / 24);
  if (hari > 0)  return `${hari} hari lalu`;
  if (jam > 0)   return `${jam} jam lalu`;
  if (menit > 0) return `${menit} menit lalu`;
  return "baru saja";
}

/**
 * formatDuplikat(duplikat)
 * Format info duplikat kandidat untuk ditampilkan di notif.
 */
function formatDuplikat(duplikat) {
  if (!duplikat || duplikat.length === 0) return "";
  const d           = duplikat[0];
  const statusMap   = {
    baru: "Baru", perlu_dibalas: "Perlu dibalas",
    menunggu: "Menunggu reply", selesai: "Selesai", tidak_aktif: "Tidak aktif",
  };
  const waktuLabel  = formatWaktu(d.waktu_pesan || d.waktu);
  let info =
    `\n⚠️ <b>Kandidat ini sudah pernah chat!</b>\n` +
    `📋 Tercatat di: <b>[${d.id}]</b> via ${d.wa_id} — ${waktuLabel}\n` +
    `Status: ${statusMap[d.status] || d.status} | /lihat ${d.id}`;
  if (duplikat.length > 1) info += `\n(+${duplikat.length - 1} chat lain)`;
  return info;
}

/**
 * formatLid(id, isLid, nomorDariPesan)
 * Format info LID untuk ditampilkan di notif.
 */
function formatLid(id, isLid, nomorDariPesan) {
  if (!isLid) return `<i>Balas: /${id} pesanmu</i>`;
  const fixNomor = nomorDariPesan || "628xxx";
  return (
    `⚠️ <i>Nomor belum terdeteksi (WA Web/Business)</i>\n` +
    `<i>Fix: /fixjid ${id} ${fixNomor} — lalu /${id} pesanmu</i>`
  );
}

// ===== REGISTER HANDLER =====
/**
 * registerHandlers()
 * Daftarkan semua listener event notifikasi.
 * Dipanggil sekali saat startup dari index.js.
 *
 * DIGUNAKAN OLEH: index.js
 */
function registerHandlers() {

  // ── Listen: kandidat baru atau pesan masuk ──────────────────
  events.on("kandidat:dibuat", async (data) => {
    await kirimNotifPesan(data);
  });

  events.on("kandidat:diupdate", async (data) => {
    await kirimNotifPesan(data);
  });

  // ── Listen: media masuk ─────────────────────────────────────
  events.on("kandidat:media_masuk", async (data) => {
    await kirimNotifMedia(data);
  });

  // ── Listen: unread ringkasan ────────────────────────────────
  events.on("kandidat:unread_ringkasan", async ({ waId, unreadChats }) => {
    await kirimNotifUnread(waId, unreadChats);
  });

  // ── Listen: WA terhubung ────────────────────────────────────
  events.on("wa:terhubung", async ({ waId, jid }) => {
    logger.info("Notif-Handler", `${waId} terhubung — notif dikirim`);
    const { token, chatId } = await getTokenDanChatId(waId);
    if (!token) return;
    const nomor = jid?.replace(/@.*/, "") || waId;
    await kirimTeks(token, chatId,
      `✅ <b>${waId} terhubung!</b>\nNomor: <code>${nomor}</code>`
    );
  });

  // ── Listen: WA terputus ─────────────────────────────────────
  events.on("wa:terputus", async ({ waId, willReconnect, maxRetryReached }) => {
    if (maxRetryReached) {
      await kirimError(
        `<b>${waId} gagal reconnect setelah 10x percobaan!</b>\n\n` +
        `Bot berhenti mencoba. Silakan hubungkan ulang via bot WA.`
      );
    }
  });

  logger.info("Notif-Handler", "Handler terdaftar ✅");
}

// ===== KIRIM NOTIF PESAN =====
/**
 * kirimNotifPesan(data)
 * Kirim notifikasi pesan teks masuk ke Telegram.
 *
 * Format notif:
 * [ID] waId
 * 👤 Nama
 * 📞 Nomor
 * 💬 Pesan
 * (info LID kalau ada)
 * (info duplikat kalau ada)
 */
async function kirimNotifPesan({ id, waId, jid, nama, pesan, isLid, nomorDariPesan, duplikat }) {
  try {
    const { token, chatId } = await getTokenDanChatId(waId);
    if (!token || !chatId) {
      logger.error("Notif-Handler", `Token atau chatId tidak ditemukan untuk ${waId}`);
      return;
    }

    const nomorTampil = jid.replace(/@.*/, "");
    const duplikatInfo = formatDuplikat(duplikat);
    const lidInfo      = formatLid(id, isLid, nomorDariPesan);

    const dashUrl = process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL}/dashboard/app.html#${id}` : null;
    await kirimTeks(token, chatId,
      `<b>[${id}] ${waId}</b>\n` +
      `👤 <b>${nama}</b>\n` +
      `📞 <b>${nomorTampil}</b>\n\n` +
      `💬 ${pesan}\n\n` +
      (dashUrl ? `<a href="${dashUrl}">👉 Buka Dashboard</a>\n\n` : "") +
      lidInfo +
      duplikatInfo
    );

    logger.info("Notif-Handler", `Notif pesan [${id}] terkirim ke Telegram`);
  } catch (err) {
    logger.error("Notif-Handler", `Error kirim notif pesan: ${err.message}`);
  }
}

// ===== KIRIM NOTIF MEDIA =====
/**
 * kirimNotifMedia(data)
 * Kirim notifikasi media masuk ke Telegram.
 * Kirim media aktual (foto/video/dokumen/audio) + caption info.
 */
async function kirimNotifMedia({
  id, waId, jid, nama, buffer, ext, mediaType, caption, isLid, duplikat
}) {
  try {
    const { token, chatId } = await getTokenDanChatId(waId);
    if (!token || !chatId) return;

    const nomorTampil  = jid.replace(/@.*/, "");
    const duplikatInfo = formatDuplikat(duplikat);
    const lidInfo      = formatLid(id, isLid, null);

    const infoTeks =
      `<b>[${id}] ${waId}</b>\n` +
      `👤 <b>${nama}</b>\n` +
      `📞 <b>${nomorTampil}</b>\n` +
      (caption ? `💬 ${caption}\n` : "") +
      `\n` +
      lidInfo +
      duplikatInfo;

    if (buffer) {
      if (mediaType === "imageMessage") {
        await kirimFoto(token, chatId, buffer, infoTeks);
      } else if (mediaType === "videoMessage") {
        await kirimVideo(token, chatId, buffer, infoTeks);
      } else if (mediaType === "audioMessage") {
        await kirimAudio(token, chatId, buffer);
        await kirimTeks(token, chatId, infoTeks);
      } else {
        await kirimDokumen(token, chatId, buffer, `file.${ext || "bin"}`, infoTeks);
      }
    } else {
      await kirimTeks(token, chatId, infoTeks);
    }

    logger.info("Notif-Handler", `Notif media [${id}] terkirim ke Telegram`);
  } catch (err) {
    logger.error("Notif-Handler", `Error kirim notif media: ${err.message}`);
  }
}

// ===== KIRIM NOTIF UNREAD =====
/**
 * kirimNotifUnread(waId, unreadChats)
 * Kirim ringkasan pesan terlewat saat bot reconnect.
 */
async function kirimNotifUnread(waId, unreadChats) {
  try {
    const { token, chatId } = await getTokenDanChatId(waId);
    if (!token || !chatId) return;

    const total = unreadChats.reduce((sum, c) => sum + c.unreadCount, 0);

    // Kirim ringkasan dulu
    await kirimTeks(token, chatId,
      `⚡ <b>${waId} reconnect!</b>\n\n` +
      `Ada <b>${total} pesan terlewat</b> dari ${unreadChats.length} kontak:\n` +
      unreadChats.slice(0, 5).map((c) =>
        `• ${c.nama || c.jid.replace(/@.*/, "")} (${c.unreadCount} pesan)`
      ).join("\n") +
      (unreadChats.length > 5 ? `\n...dan ${unreadChats.length - 5} kontak lain` : "")
    );

    // Kirim detail per kontak dengan jeda
    for (const chat of unreadChats) {
      const kandidat    = await db.getKandidatByJid(waId, chat.jid);
      const id          = kandidat?.id || "?";
      const nomorTampil = chat.jid.replace(/@.*/, "");

      let pesanInfo = "";
      if (chat.semuaPesan?.length > 0) {
        const daftarPesan = chat.semuaPesan
          .slice(-10)
          .map((p, i) => `${i + 1}. "${p.slice(0, 80)}${p.length > 80 ? "..." : ""}"`)
          .join("\n");
        pesanInfo = `📨 <b>${chat.unreadCount} pesan terlewat:</b>\n${daftarPesan}`;
      } else {
        pesanInfo = `📨 <b>${chat.unreadCount} pesan terlewat</b>\n<i>(isi pesan tidak dapat diambil)</i>`;
      }

      await kirimTeks(token, chatId,
        `<b>[${id}] Terlewat - ${waId}</b>\n` +
        `👤 <b>${chat.nama || nomorTampil}</b>\n` +
        `📞 <b>${nomorTampil}</b>\n\n` +
        `${pesanInfo}\n\n` +
        (id !== "?" ? `<i>Balas: /${id} pesanmu</i>` : "")
      );

      // Jeda 5 detik antar notif agar tidak kena rate limit Telegram
      await new Promise((r) => setTimeout(r, 5000));
    }

  } catch (err) {
    logger.error("Notif-Handler", `Error kirim notif unread: ${err.message}`);
  }
}

module.exports = {
  registerHandlers,
  kirimTeks,
  kirimError,
  kirimFoto,
  kirimVideo,
  kirimDokumen,
  kirimAudio,
  getTokenDanChatId,
  formatWaktu,
  formatDuplikat,
  formatLid,
};
