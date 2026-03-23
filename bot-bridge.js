const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const queue = require("./queue");
const waManager = require("./wa-manager");

const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
const TOKEN = config.botBridgeToken;
const CHAT_ID = config.telegramChatId;
const ADMIN_ID = config.adminTelegramId;

// Simpan daftar chat masuk { id: { waId, jid, nama, waktu } }
let chatLog = {};
let chatCounter = 0;

// Simpan pending unread confirmation { waId: [{ jid, name, unreadCount }] }
let pendingUnread = {};

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// ===== KIRIM TEKS KE TELEGRAM =====
async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: CHAT_ID,
      text: teks,
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim teks: ${err.message}`);
  }
}

// ===== KIRIM FOTO KE TELEGRAM =====
async function kirimFoto(buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("photo", buffer, { filename: "photo.jpg", contentType: "image/jpeg" });
    if (caption) form.append("caption", caption, { parse_mode: "HTML" });
    await axios.post(`${TELEGRAM_API}/sendPhoto`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim foto: ${err.message}`);
  }
}

// ===== KIRIM VIDEO KE TELEGRAM =====
async function kirimVideo(buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("video", buffer, { filename: "video.mp4", contentType: "video/mp4" });
    if (caption) form.append("caption", caption, { parse_mode: "HTML" });
    await axios.post(`${TELEGRAM_API}/sendVideo`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim video: ${err.message}`);
  }
}

// ===== KIRIM DOKUMEN KE TELEGRAM =====
async function kirimDokumen(buffer, filename, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("document", buffer, { filename });
    if (caption) form.append("caption", caption, { parse_mode: "HTML" });
    await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim dokumen: ${err.message}`);
  }
}

// ===== KIRIM NOTIFIKASI ERROR =====
async function kirimError(pesan) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: ADMIN_ID,
      text: `⚠️ <b>ERROR</b>\n\n${pesan}`,
      parse_mode: "HTML",
    });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim error notif: ${err.message}`);
  }
}

// ===== CALLBACK DARI WA MANAGER =====
function setupCallbacks() {
  waManager.setCallbacks({
    onMessage: async (waId, jid, nama, pesan) => {
      chatCounter++;
      const id = chatCounter;
      chatLog[id] = { waId, jid, nama, waktu: Date.now() };

      const teks =
        `📱 <b>[#${id}] ${waId}</b>\n` +
        `👤 <b>${nama}</b>\n` +
        `📞 <code>${jid.replace(/@.*/, "")}</code>\n\n` +
        `💬 ${pesan}\n\n` +
        `<i>Balas: /balas #${id} pesanmu</i>`;

      await kirimTeks(teks);
      logger.info("Bot-Bridge", `Pesan masuk #${id} dari ${nama} via ${waId}`);
    },

    onMedia: async (waId, jid, nama, buffer, ext, mediaType, caption) => {
      chatCounter++;
      const id = chatCounter;
      chatLog[id] = { waId, jid, nama, waktu: Date.now() };

      const info =
        `📱 <b>[#${id}] ${waId}</b>\n` +
        `👤 <b>${nama}</b>\n` +
        `📞 <code>${jid.replace(/@.*/, "")}</code>\n` +
        (caption ? `💬 ${caption}\n` : "") +
        `\n<i>Balas: /balas #${id} pesanmu</i>`;

      if (mediaType === "imageMessage") {
        await kirimFoto(buffer, info);
      } else if (mediaType === "videoMessage") {
        await kirimVideo(buffer, info);
      } else {
        await kirimDokumen(buffer, `file.${ext}`, info);
      }

      logger.info("Bot-Bridge", `Media masuk #${id} dari ${nama} via ${waId}`);
    },

    onConnected: async (waId, jid) => {
      await kirimTeks(
        `✅ <b>${waId} terhubung!</b>\n` +
        `📞 Nomor: <code>${jid.replace(/@.*/, "")}</code>`
      );
    },

    onDisconnected: async (waId, willReconnect) => {
      await kirimError(
        `<b>${waId} terputus!</b>\n` +
        `Reconnect otomatis: ${willReconnect ? "Ya" : "Tidak"}`
      );
    },

    onQR: async (waId, qrString) => {
      // QR ditangani oleh bot-wa.js
    },

    onUnreadFound: async (waId, unreadChats) => {
      pendingUnread[waId] = unreadChats;
      const total = unreadChats.reduce((sum, c) => sum + c.unreadCount, 0);
      const daftar = unreadChats
        .map((c) => `• ${c.name} (${c.unreadCount} pesan)`)
        .join("\n");

      await kirimTeks(
        `📬 <b>${waId} terhubung!</b>\n\n` +
        `Ada <b>${total} pesan belum dibaca</b> dari ${unreadChats.length} chat:\n\n` +
        `${daftar}\n\n` +
        `Ketik /teruskanunread ${waId} untuk meneruskan, atau abaikan.`
      );
    },
  });
}

// ===== PROSES PERINTAH TELEGRAM =====
async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const fromId = String(msg.from?.id);

  // Proteksi admin
  if (fromId !== String(ADMIN_ID)) return;

  // /balas #id pesan
  if (teks.startsWith("/balas ")) {
    const match = teks.match(/^\/balas #(\d+) (.+)$/s);
    if (!match) {
      await kirimTeks("❌ Format: /balas #id pesanmu");
      return;
    }
    const id = parseInt(match[1]);
    const pesan = match[2].trim();
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat #${id} tidak ditemukan.`);
      return;
    }

    queue.tambahKeAntrian(chat.waId, chat.jid, pesan);
    await kirimTeks(`✅ Pesan ke <b>${chat.nama}</b> (#${id}) masuk antrian.`);
    logger.info("Bot-Bridge", `Balas #${id} ke ${chat.nama} masuk antrian`);
  }

  // /ke nomor pesan
  else if (teks.startsWith("/ke ")) {
    const bagian = teks.replace("/ke ", "").trim().split(" ");
    const nomor = bagian[0];
    const pesan = bagian.slice(1).join(" ");
    if (!nomor || !pesan) {
      await kirimTeks("❌ Format: /ke 628xxx pesanmu");
      return;
    }

    // Pakai WA pertama yang aktif
    const waIds = waManager.getAllIds();
    if (waIds.length === 0) {
      await kirimTeks("❌ Tidak ada WA yang terhubung.");
      return;
    }

    const jid = nomor.includes("@") ? nomor : `${nomor}@s.whatsapp.net`;
    queue.tambahKeAntrian(waIds[0], jid, pesan);
    await kirimTeks(`✅ Pesan ke ${nomor} masuk antrian.`);
  }

  // /teruskanunread waId
  else if (teks.startsWith("/teruskanunread ")) {
    const waId = teks.replace("/teruskanunread ", "").trim();
    const unreadChats = pendingUnread[waId];

    if (!unreadChats || unreadChats.length === 0) {
      await kirimTeks(`❌ Tidak ada unread pending untuk ${waId}.`);
      return;
    }

    await kirimTeks(`⏳ Meneruskan pesan unread dari ${waId}...`);

    for (const chat of unreadChats) {
      chatCounter++;
      const id = chatCounter;
      chatLog[id] = { waId, jid: chat.jid, nama: chat.name, waktu: Date.now() };

      await kirimTeks(
        `📬 <b>[#${id}] Unread - ${waId}</b>\n` +
        `👤 <b>${chat.name}</b>\n` +
        `📞 <code>${chat.jid.replace(/@.*/, "")}</code>\n` +
        `📨 ${chat.unreadCount} pesan belum dibaca\n\n` +
        `<i>Balas: /balas #${id} pesanmu</i>`
      );
    }

    delete pendingUnread[waId];
  }

  // /antrian
  else if (teks === "/antrian") {
    const status = queue.getStatus();
    await kirimTeks(
      `📋 <b>Status Antrian</b>\n\n` +
      `Pesan menunggu: ${status.panjangAntrian}\n` +
      `Sedang proses: ${status.sedangProses ? "Ya" : "Tidak"}`
    );
  }

  // /status
  else if (teks === "/status") {
    const waStatus = waManager.getStatus();
    const daftar = Object.entries(waStatus)
      .map(([id, s]) => `• ${id}: ${s.status === "connected" ? "✅" : "❌"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA terhubung";

    await kirimTeks(
      `ℹ️ <b>Status WA Bridge</b>\n\n` +
      `${daftar}\n\n` +
      `<b>Perintah:</b>\n` +
      `/balas #id pesan\n` +
      `/ke nomor pesan\n` +
      `/antrian\n` +
      `/status`
    );
  }
}

module.exports = { setupCallbacks, prosesPerintah, kirimTeks, kirimError };
