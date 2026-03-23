const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const logger = require("./logger");
const queue = require("./queue");
const waManager = require("./wa-manager");

const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
const TOKEN = config.botBridgeToken;
const CHAT_ID = config.telegramChatId;
const ADMIN_ID = config.adminTelegramId;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const CHATLOG_FILE = "./auth_sessions/chatlog.json";

// ===== LOAD & SAVE CHATLOG =====
function loadChatLog() {
  try {
    if (fs.existsSync(CHATLOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHATLOG_FILE, "utf-8"));
      return { chatLog: data.chatLog || {}, chatCounter: data.chatCounter || 0 };
    }
  } catch (e) {
    logger.error("Bot-Bridge", `Gagal load chatlog: ${e.message}`);
  }
  return { chatLog: {}, chatCounter: 0 };
}

function saveChatLog() {
  try {
    fs.writeFileSync(CHATLOG_FILE, JSON.stringify({ chatLog, chatCounter }, null, 2));
  } catch (e) {
    logger.error("Bot-Bridge", `Gagal save chatlog: ${e.message}`);
  }
}

let { chatLog, chatCounter } = loadChatLog();
let pendingUnread = {};

// ===== KIRIM TEKS =====
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

// ===== KIRIM FOTO =====
async function kirimFoto(buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("photo", buffer, { filename: "photo.jpg", contentType: "image/jpeg" });
    if (caption) form.append("caption", caption);
    await axios.post(`${TELEGRAM_API}/sendPhoto`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim foto: ${err.message}`);
  }
}

// ===== KIRIM VIDEO =====
async function kirimVideo(buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("video", buffer, { filename: "video.mp4", contentType: "video/mp4" });
    if (caption) form.append("caption", caption);
    await axios.post(`${TELEGRAM_API}/sendVideo`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim video: ${err.message}`);
  }
}

// ===== KIRIM DOKUMEN =====
async function kirimDokumen(buffer, filename, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("document", buffer, { filename });
    if (caption) form.append("caption", caption);
    await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim dokumen: ${err.message}`);
  }
}

// ===== KIRIM ERROR =====
async function kirimError(pesan) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: ADMIN_ID,
      text: `<b>ERROR</b>\n\n${pesan}`,
      parse_mode: "HTML",
    });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim error: ${err.message}`);
  }
}

// ===== SETUP CALLBACKS =====
function setupCallbacks() {
  waManager.setCallbacks({
    onMessage: async (waId, jid, nama, pesan) => {
      chatCounter++;
      const id = chatCounter;
      chatLog[id] = { waId, jid, nama, waktu: Date.now(), panjangPesan: pesan.length };
      saveChatLog();

      await kirimTeks(
        `<b>[#${id}] ${waId}</b>\n` +
        `<b>${nama}</b>\n` +
        `<code>${jid.replace(/@.*/, "")}</code>\n\n` +
        `${pesan}\n\n` +
        `<i>Balas: /${id} pesanmu</i>`
      );
      logger.info("Bot-Bridge", `Pesan masuk #${id} dari ${nama} via ${waId}`);
    },

    onMedia: async (waId, jid, nama, buffer, ext, mediaType, caption) => {
      chatCounter++;
      const id = chatCounter;
      chatLog[id] = { waId, jid, nama, waktu: Date.now(), panjangPesan: caption.length };
      saveChatLog();

      const info =
        `[#${id}] ${waId}\n` +
        `${nama}\n` +
        `${jid.replace(/@.*/, "")}\n` +
        (caption ? `${caption}\n` : "") +
        `\nBalas: /${id} pesanmu`;

      if (mediaType === "imageMessage") {
        await kirimFoto(buffer, info);
      } else if (mediaType === "videoMessage") {
        await kirimVideo(buffer, info);
      } else {
        await kirimDokumen(buffer, `file.${ext}`, info);
      }

      logger.info("Bot-Bridge", `Media masuk #${id} dari ${nama} via ${waId}`);
    },

    onUnreadFound: async (waId, unreadChats) => {
      pendingUnread[waId] = unreadChats;
      const total = unreadChats.reduce((sum, c) => sum + c.unreadCount, 0);
      const daftar = unreadChats
        .map((c) => `- ${c.name} (${c.unreadCount} pesan)`)
        .join("\n");

      await kirimTeks(
        `<b>${waId} terhubung!</b>\n\n` +
        `Ada <b>${total} pesan belum dibaca</b> dari ${unreadChats.length} chat:\n\n` +
        `${daftar}\n\n` +
        `Ketik /teruskanunread ${waId} untuk meneruskan, atau abaikan.`
      );
    },
  });
}

// ===== PROSES PERINTAH =====
async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const caption = msg.caption || "";
  const fromId = String(msg.from?.id);

  if (fromId !== String(ADMIN_ID)) return;

  // ===== KIRIM MEDIA DARI TELEGRAM KE WA =====
  if (msg.photo || msg.video || msg.document) {
    const targetCaption = caption.trim();
    const match = targetCaption.match(/^\/?#?(\d+)/);

    if (!match) {
      await kirimTeks("❌ Tambahkan caption nomor chat.\nContoh: kirim foto dengan caption <code>/3</code>");
      return;
    }

    const id = parseInt(match[1]);
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat #${id} tidak ditemukan.`);
      return;
    }

    try {
      let fileId, mediaType, fileName;

      if (msg.photo) {
        fileId = msg.photo[msg.photo.length - 1].file_id;
        mediaType = "image";
      } else if (msg.video) {
        fileId = msg.video.file_id;
        mediaType = "video";
      } else if (msg.document) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name || "file";
        mediaType = "document";
      }

      // Download file dari Telegram
      const fileInfoRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfoRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
      const fileRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(fileRes.data);

      // Teks tambahan setelah nomor id
      const pesanTeks = targetCaption.replace(/^\/?#?\d+\s*/, "").trim();

      let pesanWA;
      if (mediaType === "image") {
        pesanWA = { image: buffer, caption: pesanTeks || "" };
      } else if (mediaType === "video") {
        pesanWA = { video: buffer, caption: pesanTeks || "" };
      } else {
        pesanWA = { document: buffer, fileName, caption: pesanTeks || "" };
      }

      queue.tambahKeAntrian(chat.waId, chat.jid, pesanTeks, pesanWA);
      await kirimTeks(`✅ Media ke <b>${chat.nama}</b> (#${id}) masuk antrian.`);
      logger.info("Bot-Bridge", `Media dari Telegram ke #${id} masuk antrian`);
    } catch (err) {
      await kirimTeks(`❌ Gagal proses media: ${err.message}`);
      logger.error("Bot-Bridge", `Gagal proses media: ${err.message}`);
    }
    return;
  }

  // ===== BALAS TEKS: /1 pesanmu atau /#1 pesanmu =====
  if (teks.match(/^\/#?\d+/)) {
    const spasi = teks.indexOf(" ");
    if (spasi === -1) {
      await kirimTeks("❌ Format: /1 pesanmu");
      return;
    }
    const idStr = teks.slice(1, spasi).replace("#", "");
    const id = parseInt(idStr);
    const pesan = teks.slice(spasi + 1).trim();
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat #${id} tidak ditemukan.`);
      return;
    }

    queue.tambahKeAntrian(chat.waId, chat.jid, pesan, null, pesan.length);
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
      saveChatLog();

      await kirimTeks(
        `<b>[#${id}] Unread - ${waId}</b>\n` +
        `<b>${chat.name}</b>\n` +
        `<code>${chat.jid.replace(/@.*/, "")}</code>\n` +
        `${chat.unreadCount} pesan belum dibaca\n\n` +
        `<i>Balas: /${id} pesanmu</i>`
      );
    }

    delete pendingUnread[waId];
  }

  // /antrian
  else if (teks === "/antrian") {
    const status = queue.getStatus();
    await kirimTeks(
      `<b>Status Antrian</b>\n\n` +
      `Pesan menunggu: ${status.panjangAntrian}\n` +
      `Sedang proses: ${status.sedangProses ? "Ya" : "Tidak"}`
    );
  }

  // /status
  else if (teks === "/status") {
    const waStatus = waManager.getStatus();
    const daftar = Object.entries(waStatus)
      .map(([id, s]) => `- ${id}: ${s.status === "connected" ? "Terhubung" : "Terputus"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA terhubung";

    await kirimTeks(
      `<b>Status WA Bridge</b>\n\n` +
      `${daftar}\n\n` +
      `<b>Perintah:</b>\n` +
      `/id pesan - Balas teks\n` +
      `/ke nomor pesan - Kirim ke nomor baru\n` +
      `/antrian - Status antrian\n` +
      `/status - Status WA\n\n` +
      `<b>Kirim media:</b>\n` +
      `Kirim foto/video/dokumen dengan caption /id`
    );
  }

  // /start
  else if (teks === "/start") {
    await kirimTeks(
      `<b>WA Bridge Bot aktif!</b>\n\n` +
      `<b>Perintah:</b>\n` +
      `/id pesan - Balas teks\n` +
      `/ke nomor pesan - Kirim ke nomor baru\n` +
      `/antrian - Status antrian\n` +
      `/status - Status WA\n\n` +
      `<b>Kirim media:</b>\n` +
      `Kirim foto/video/dokumen dengan caption /id`
    );
  }
}

module.exports = { setupCallbacks, prosesPerintah, kirimTeks, kirimError };