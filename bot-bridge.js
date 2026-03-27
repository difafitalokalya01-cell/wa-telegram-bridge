const axios     = require("axios");
const FormData  = require("form-data");
const fs        = require("fs");
const logger    = require("./logger");
const queue     = require("./queue");
const waManager = require("./wa-manager");
const store     = require("./store");

const CHATLOG_FILE = "./auth_sessions/chatlog.json";

// ===== TOKEN & CHAT ID dibaca dari store (bukan hardcode dari file) =====
function getToken()  { return store.getConfig().botBridgeToken; }
function getChatId() { return store.getConfig().telegramChatId; }
function getAdminId(){ return store.getConfig().adminTelegramId; }
function getTelegramApi() { return `https://api.telegram.org/bot${getToken()}`; }

// ===== GENERATE ID HURUF =====
function generateId(counter) {
  let id = "";
  let n  = counter;
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n  = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

// ===== WRITE QUEUE untuk chatlog — anti race condition =====
let _chatlogSaving = false;
const _chatlogQueue = [];

function _flushChatlog() {
  if (_chatlogSaving || _chatlogQueue.length === 0) return;
  _chatlogSaving = true;
  const resolve = _chatlogQueue.shift();
  try {
    fs.writeFileSync(CHATLOG_FILE, JSON.stringify({ chatLog, chatCounter, jidToId }, null, 2));
  } catch (e) {
    logger.error("Bot-Bridge", `Gagal tulis chatlog: ${e.message}`);
  } finally {
    _chatlogSaving = false;
    resolve();
    if (_chatlogQueue.length > 0) setImmediate(_flushChatlog);
  }
}

function saveChatLog() {
  return new Promise((resolve) => {
    _chatlogQueue.push(resolve);
    _flushChatlog();
  });
}

// ===== LOAD CHATLOG =====
function loadChatLog() {
  try {
    if (fs.existsSync(CHATLOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHATLOG_FILE, "utf-8"));
      return {
        chatLog:     data.chatLog     || {},
        chatCounter: data.chatCounter || 0,
        jidToId:     data.jidToId     || {},
      };
    }
  } catch (e) {
    logger.error("Bot-Bridge", `Gagal load chatlog: ${e.message}`);
  }
  return { chatLog: {}, chatCounter: 0, jidToId: {} };
}

let { chatLog, chatCounter, jidToId } = loadChatLog();

// ===== DAPATKAN ATAU BUAT ID =====
function getOrCreateId(waId, jid, nama) {
  const key = `${waId}:${jid}`;
  if (jidToId[key]) {
    chatLog[jidToId[key]].nama = nama;
    return jidToId[key];
  }
  const id      = generateId(chatCounter);
  chatCounter++;
  jidToId[key]  = id;
  chatLog[id]   = {
    waId, jid, nama,
    waktuPertama: Date.now(),
    waktuPesan:   Date.now(),
    panjangPesan: 0,
    status:       "baru",
    pesanTerakhir:"",
    riwayat:      [],
    reminder1Terkirim: false,
    reminder2Terkirim: false,
    reminder3Terkirim: false,
  };
  return id;
}

// ===== FORMAT WAKTU =====
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

function formatUrgensi(timestamp) {
  const menit = Math.floor((Date.now() - timestamp) / 60000);
  if (menit >= 60) return "🚨";
  if (menit >= 30) return "⚠️";
  return "";
}

function potongPesan(pesan, max = 60) {
  if (!pesan) return "";
  return pesan.length <= max ? pesan : pesan.slice(0, max) + "...";
}

// ===== KIRIM KE TELEGRAM =====
async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${getTelegramApi()}/sendMessage`, {
      chat_id:    getChatId(),
      text:       teks,
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim teks: ${err.message}`);
  }
}

async function kirimFoto(buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", getChatId());
    form.append("photo", buffer, { filename: "photo.jpg", contentType: "image/jpeg" });
    if (caption) form.append("caption", caption);
    await axios.post(`${getTelegramApi()}/sendPhoto`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim foto: ${err.message}`);
  }
}

async function kirimVideo(buffer, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", getChatId());
    form.append("video", buffer, { filename: "video.mp4", contentType: "video/mp4" });
    if (caption) form.append("caption", caption);
    await axios.post(`${getTelegramApi()}/sendVideo`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim video: ${err.message}`);
  }
}

async function kirimDokumen(buffer, filename, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", getChatId());
    form.append("document", buffer, { filename });
    if (caption) form.append("caption", caption);
    await axios.post(`${getTelegramApi()}/sendDocument`, form, { headers: form.getHeaders() });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim dokumen: ${err.message}`);
  }
}

async function kirimError(pesan) {
  try {
    await axios.post(`${getTelegramApi()}/sendMessage`, {
      chat_id:    getAdminId(),
      text:       `<b>ERROR</b>\n\n${pesan}`,
      parse_mode: "HTML",
    });
  } catch (err) {
    logger.error("Bot-Bridge", `Gagal kirim error: ${err.message}`);
  }
}

// ===== TAMBAH RIWAYAT =====
function tambahRiwayat(id, pengirim, pesan) {
  if (!chatLog[id]) return;
  if (!chatLog[id].riwayat) chatLog[id].riwayat = [];
  const waktu = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
  chatLog[id].riwayat.push({ pengirim, pesan: potongPesan(pesan, 100), waktu });
  if (chatLog[id].riwayat.length > 50) {
    chatLog[id].riwayat = chatLog[id].riwayat.slice(-50);
  }
}

// ===== ARSIP CHATLOG LAMA (selesai > 30 hari) =====
function arsipChatLogLama() {
  const BATAS    = 30 * 24 * 60 * 60 * 1000;
  const sekarang = Date.now();
  const arsip    = {};
  const hapus    = [];

  for (const [id, c] of Object.entries(chatLog)) {
    if (c.status === "selesai" && (sekarang - c.waktuPesan) > BATAS) {
      arsip[id] = c;
      hapus.push(id);
    }
  }

  if (hapus.length === 0) return;

  const arsipFile = `./auth_sessions/chatlog_arsip_${new Date().toISOString().slice(0,10)}.json`;
  try {
    let existing = {};
    if (fs.existsSync(arsipFile)) existing = JSON.parse(fs.readFileSync(arsipFile, "utf-8"));
    fs.writeFileSync(arsipFile, JSON.stringify({ ...existing, ...arsip }, null, 2));
  } catch (e) {
    logger.error("Bot-Bridge", `Gagal tulis arsip: ${e.message}`);
    return;
  }

  for (const id of hapus) {
    delete jidToId[`${chatLog[id].waId}:${chatLog[id].jid}`];
    delete chatLog[id];
  }

  saveChatLog();
  logger.info("Bot-Bridge", `${hapus.length} chat lama diarsipkan`);
}

// ===== SETUP CALLBACKS — semua dalam satu tempat =====
function setupCallbacks() {
  waManager.setCallbacks({
    onQR: async (waId, qrString) => {
      // Diteruskan ke bot-wa via index.js — tidak perlu dihandle di sini
    },

    onPairingCode: async (waId, code, nomor, errMsg = null) => {
      // Diteruskan ke bot-wa via index.js
    },

    onConnected: async (waId, jid) => {
      // Notif dari bot-wa
    },

    onDisconnected: async (waId, willReconnect, maxRetryReached = false) => {
      if (maxRetryReached) {
        await kirimError(
          `<b>${waId} gagal reconnect setelah 10x percobaan!</b>\n\n` +
          `Bot berhenti mencoba. Silakan hubungkan ulang via bot WA.`
        );
      }
    },

    onMessage: async (waId, jid, nama, pesan) => {
      const id = getOrCreateId(waId, jid, nama);
      chatLog[id].panjangPesan = pesan.length;
      chatLog[id].status       = "perlu_dibalas";
      chatLog[id].waktuPesan   = Date.now();
      chatLog[id].pesanTerakhir= pesan;
      chatLog[id].reminder1Terkirim = false;
      chatLog[id].reminder2Terkirim = false;
      chatLog[id].reminder3Terkirim = false;
      tambahRiwayat(id, nama, pesan);
      await saveChatLog();

      // Kirim ke slot pool jika ada, fallback ke bot bridge lama
      const store = require("./store");
      const slot  = store.getSlotByWaId(waId);
      if (slot) {
        const botPool = require("./bot-pool");
        await botPool.notifPesanMasuk(slot, id, waId, nama, jid, pesan);
      } else {
        const nomorHR = waManager.getInstance(waId)?.jid?.replace(/:.*@.*/, "") || waId;
        await kirimTeks(
          `<b>[${id}] ${waId}</b>\n` +
          `📱 Diterima: <code>${nomorHR}</code>\n` +
          `👤 <b>${nama}</b>\n` +
          `📞 <b>${jid.replace(/@.*/, "")}</b>\n\n` +
          `💬 ${pesan}\n\n` +
          `<i>Balas: /${id} pesanmu</i>`
        );
      }
      logger.info("Bot-Bridge", `Pesan masuk [${id}] dari ${nama} via ${waId}`);
    },

    onMedia: async (waId, jid, nama, buffer, ext, mediaType, caption) => {
      const id = getOrCreateId(waId, jid, nama);
      chatLog[id].panjangPesan  = caption.length;
      chatLog[id].status        = "perlu_dibalas";
      chatLog[id].waktuPesan    = Date.now();
      chatLog[id].pesanTerakhir = caption || `[${mediaType.replace("Message", "")}]`;
      chatLog[id].reminder1Terkirim = false;
      chatLog[id].reminder2Terkirim = false;
      chatLog[id].reminder3Terkirim = false;
      tambahRiwayat(id, nama, caption || `[${mediaType.replace("Message", "")}]`);
      await saveChatLog();

      // Kirim ke slot pool jika ada, fallback ke bot bridge lama
      const store = require("./store");
      const slot  = store.getSlotByWaId(waId);
      if (slot) {
        const botPool = require("./bot-pool");
        await botPool.notifMediaMasuk(slot, id, waId, nama, jid, caption, mediaType);
      } else {
        const info =
          `[${id}] ${waId}\n` +
          `👤 ${nama}\n` +
          `📞 ${jid.replace(/@.*/, "")}\n` +
          (caption ? `💬 ${caption}\n` : "") +
          `\nBalas: /${id} pesanmu`;
        if (mediaType === "imageMessage")       await kirimFoto(buffer, info);
        else if (mediaType === "videoMessage")  await kirimVideo(buffer, info);
        else                                    await kirimDokumen(buffer, `file.${ext}`, info);
      }
      logger.info("Bot-Bridge", `Media masuk [${id}] dari ${nama} via ${waId}`);
    },

    onUnreadFound: async (waId, unreadChats) => {
      const total = unreadChats.reduce((sum, c) => sum + c.unreadCount, 0);
      await kirimTeks(
        `<b>${waId} terhubung!</b>\n\n` +
        `Meneruskan <b>${total} pesan belum dibaca</b> dari ${unreadChats.length} chat...`
      );

      for (const chat of unreadChats) {
        const id = getOrCreateId(waId, chat.jid, chat.name);
        chatLog[id].status     = "perlu_dibalas";
        chatLog[id].waktuPesan = Date.now();
        await saveChatLog();

        await kirimTeks(
          `<b>[${id}] Unread - ${waId}</b>\n` +
          `👤 <b>${chat.name}</b>\n` +
          `📞 <b>${chat.jid.replace(/@.*/, "")}</b>\n` +
          `📨 ${chat.unreadCount} pesan belum dibaca\n\n` +
          `<i>Balas: /${id} pesanmu</i>`
        );
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2000) + 3000));
      }
    },
  });
}

// ===== SETUP CALLBACKS UNTUK BOT-WA (QR, connected, dll) =====
// Dipanggil dari bot-wa.js — merge ke callbacks yang sudah ada
function setupWaCallbacks(callbacks) {
  waManager.setCallbacks(callbacks);
}

// ===== PROSES PERINTAH =====
async function prosesPerintah(msg) {
  const teks    = msg.text    || "";
  const caption = msg.caption || "";
  const fromId  = String(msg.from?.id);

  if (fromId !== String(getAdminId())) return;

  // ===== KIRIM MEDIA DARI TELEGRAM KE WA =====
  if (msg.photo || msg.video || msg.document) {
    const targetCaption = caption.trim();
    const match         = targetCaption.match(/^\/?([A-Za-z]+)/);

    if (!match) { await kirimTeks("❌ Tambahkan caption ID chat.\nContoh: /A"); return; }

    const id   = match[1].toUpperCase();
    const chat = chatLog[id];
    if (!chat) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }

    try {
      let fileId, mediaType, fileName;
      if (msg.photo)    { fileId = msg.photo[msg.photo.length - 1].file_id; mediaType = "image"; }
      else if (msg.video)    { fileId = msg.video.file_id; mediaType = "video"; }
      else if (msg.document) { fileId = msg.document.file_id; fileName = msg.document.file_name || "file"; mediaType = "document"; }

      const fileInfoRes = await axios.get(`${getTelegramApi()}/getFile?file_id=${fileId}`);
      const filePath    = fileInfoRes.data.result.file_path;
      const fileUrl     = `https://api.telegram.org/file/bot${getToken()}/${filePath}`;
      const fileRes     = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const buffer      = Buffer.from(fileRes.data);
      const pesanTeks   = targetCaption.replace(/^\/?[A-Za-z]+\s*/, "").trim();

      let pesanWA;
      if (mediaType === "image")       pesanWA = { image: buffer, caption: pesanTeks };
      else if (mediaType === "video")  pesanWA = { video: buffer, caption: pesanTeks };
      else                             pesanWA = { document: buffer, fileName, caption: pesanTeks };

      queue.tambahKeAntrian(chat.waId, chat.jid, pesanTeks, pesanWA, chat.panjangPesan || 0);
      tambahRiwayat(id, "HR", `[Media] ${pesanTeks}`);
      chatLog[id].status = "menunggu";
      await saveChatLog();
      await kirimTeks(`✅ Media ke <b>${chat.nama}</b> [${id}] masuk antrian.`);
    } catch (err) {
      await kirimTeks(`❌ Gagal proses media: ${err.message}`);
    }
    return;
  }

  // ===== DAFTAR PERINTAH KHUSUS — cek dulu sebelum proses ID balas =====
  const perintahKhusus = ["ke", "dc", "daftarchat", "lihat", "riwayat", "catat", "selesai", "antrian", "status", "start", "fixjid", "kirim", "assign", "reset", "pool", "healthcheck", "pengaturan", "blacklist", "tambahblacklist", "hapusblacklist"];

  // ===== /start =====
  if (teks === "/start") {
    await kirimTeks(
      `<b>WA Bridge Bot aktif!</b>\n\n` +
      `<b>Balas:</b>\n` +
      `/[id] pesan - Balas kandidat\n` +
      `/ke nomor pesan - Kirim ke nomor baru\n\n` +
      `<b>Kandidat:</b>\n` +
      `/dc - Ringkasan semua chat\n` +
      `/lihat [id] - Detail + riwayat\n` +
      `/catat [id] catatan - Tambah catatan\n` +
      `/selesai [id] - Tandai selesai\n\n` +
      `<b>Info:</b>\n` +
      `/antrian - Status antrian\n` +
      `/status - Status WA\n\n` +
      `<b>Kirim media:</b>\n` +
      `Kirim foto/video dengan caption /[id]`
    );
    return;
  }

  // ===== /status =====
  if (teks === "/status") {
    const waStatus = waManager.getStatus();
    const daftar   = Object.entries(waStatus)
      .map(([id, s]) => `- ${id}: ${s.status === "connected" ? "✅" : "❌"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA terhubung";
    await kirimTeks(`<b>Status WA Bridge</b>\n\n${daftar}`);
    return;
  }

  // ===== /antrian =====
  if (teks === "/antrian") {
    const status = queue.getStatus();
    await kirimTeks(
      `<b>Status Antrian</b>\n\n` +
      `Pesan menunggu: ${status.panjangAntrian}\n` +
      `Sedang proses: ${status.sedangProses ? "Ya" : "Tidak"}`
    );
    return;
  }

  // ===== /ke nomor pesan =====
  if (teks.startsWith("/ke ")) {
    const bagian = teks.replace("/ke ", "").trim().split(" ");
    const nomor  = bagian[0];
    const pesan  = bagian.slice(1).join(" ");
    if (!nomor || !pesan) { await kirimTeks("❌ Format: /ke 628xxx pesanmu"); return; }
    const waIds = waManager.getAllIds();
    if (waIds.length === 0) { await kirimTeks("❌ Tidak ada WA yang terhubung."); return; }
    const jid = nomor.includes("@") ? nomor : `${nomor}@s.whatsapp.net`;
    queue.tambahKeAntrian(waIds[0], jid, pesan, null, 0);
    await kirimTeks(`✅ Pesan ke ${nomor} masuk antrian.`);
    return;
  }

  // ===== /dc =====
  if (teks === "/dc" || teks === "/daftarchat") {
    const semua        = Object.entries(chatLog);
    const perluDibalas = semua.filter(([, c]) => c.status === "perlu_dibalas");
    const menunggu     = semua.filter(([, c]) => c.status === "menunggu");
    const baru         = semua.filter(([, c]) => c.status === "baru");
    const selesai      = semua.filter(([, c]) => c.status === "selesai");
    const tidakAktif   = semua.filter(([, c]) => c.status === "tidak_aktif");
    await kirimTeks(
      `<b>📊 Ringkasan Chat</b>\n\n` +
      `🔔 Perlu dibalas: <b>${perluDibalas.length}</b>\n` +
      `⏳ Menunggu reply: <b>${menunggu.length}</b>\n` +
      `🆕 Baru: <b>${baru.length}</b>\n` +
      `✅ Selesai: <b>${selesai.length}</b>\n` +
      `❌ Tidak aktif: <b>${tidakAktif.length}</b>\n\n` +
      `<b>Filter:</b>\n` +
      `/dc perlu — perlu dibalas\n` +
      `/dc menunggu — menunggu reply\n` +
      `/dc baru — baru masuk\n` +
      `/dc selesai — sudah selesai\n` +
      `/dc semua — semua kandidat\n` +
      `/dc [namaWA] — per akun WA`
    );
    return;
  }

  // ===== /dc filter (+ pagination) =====
  if (teks.startsWith("/dc ")) {
    const bagian  = teks.replace("/dc ", "").trim().split(" ");
    const filter  = bagian[0].toLowerCase();
    const halaman = parseInt(bagian[1]) || 1;

    let daftar = Object.entries(chatLog);
    let judul  = "";

    if (filter === "perlu") {
      daftar = daftar.filter(([, c]) => c.status === "perlu_dibalas");
      daftar.sort((a, b) => a[1].waktuPesan - b[1].waktuPesan);
      judul = "🔔 Perlu Dibalas";
    } else if (filter === "menunggu") {
      daftar = daftar.filter(([, c]) => c.status === "menunggu");
      judul  = "⏳ Menunggu Reply";
    } else if (filter === "baru") {
      daftar = daftar.filter(([, c]) => c.status === "baru");
      judul  = "🆕 Baru";
    } else if (filter === "selesai") {
      daftar = daftar.filter(([, c]) => c.status === "selesai");
      judul  = "✅ Selesai";
    } else if (filter === "semua") {
      judul  = "📋 Semua Kandidat";
    } else {
      daftar = daftar.filter(([, c]) => c.waId?.toLowerCase() === filter);
      judul  = `📱 ${filter.toUpperCase()}`;
    }

    if (daftar.length === 0) { await kirimTeks(`Tidak ada kandidat dengan filter <b>${filter}</b>.`); return; }

    const perHalaman   = 10;
    const totalHalaman = Math.ceil(daftar.length / perHalaman);
    const start        = (halaman - 1) * perHalaman;
    const halamanIni   = daftar.slice(start, start + perHalaman);

    if (halamanIni.length === 0) { await kirimTeks(`Halaman ${halaman} tidak ditemukan.`); return; }

    let teksOut = halaman === 1
      ? `<b>${judul} (${daftar.length})</b>\n\n`
      : `<b>Halaman ${halaman}/${totalHalaman}</b>\n\n`;

    for (const [id, c] of halamanIni) {
      const urgensi  = c.status === "perlu_dibalas" ? formatUrgensi(c.waktuPesan) : "";
      const potongan = potongPesan(c.pesanTerakhir);
      teksOut +=
        `${urgensi} <b>[${id}]</b> ${c.nama} — ${c.waId} — ${formatWaktu(c.waktuPesan)}\n` +
        `📞 ${c.jid?.replace(/@.*/, "")}\n` +
        (potongan ? `💬 "${potongan}"\n` : "") + `\n`;
    }

    if (halaman < totalHalaman) teksOut += `\n/dc ${filter} ${halaman + 1} — halaman berikutnya`;

    await kirimTeks(teksOut);
    return;
  }

  // ===== /lihat A =====
  if (teks.startsWith("/lihat ")) {
    const id   = teks.replace("/lihat ", "").trim().toUpperCase();
    const chat = chatLog[id];
    if (!chat) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }

    const statusMap = {
      baru: "🆕 Baru", perlu_dibalas: "🔔 Perlu dibalas",
      menunggu: "⏳ Menunggu reply", selesai: "✅ Selesai", tidak_aktif: "❌ Tidak aktif",
    };

    let teksOut =
      `<b>👤 [${id}] ${chat.nama}</b>\n` +
      `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
      `📱 ${chat.waId}\n` +
      `📅 Pertama: ${new Date(chat.waktuPertama).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
      `🕐 Terakhir: ${formatWaktu(chat.waktuPesan)}\n` +
      `Status: ${statusMap[chat.status] || chat.status}\n\n`;

    if (chat.catatan) teksOut += `📝 <b>Catatan:</b>\n${chat.catatan}\n\n`;

    if (chat.riwayat?.length > 0) {
      teksOut += `<b>📋 Riwayat (${chat.riwayat.length} pesan):</b>\n`;
      for (const r of chat.riwayat.slice(-5)) {
        teksOut += `${r.waktu} — <b>${r.pengirim}:</b> ${r.pesan}\n`;
      }
      if (chat.riwayat.length > 5) teksOut += `\n/riwayat ${id} — lihat semua riwayat`;
    }

    await kirimTeks(teksOut);
    return;
  }

  // ===== /riwayat A =====
  if (teks.startsWith("/riwayat ")) {
    const id   = teks.replace("/riwayat ", "").trim().toUpperCase();
    const chat = chatLog[id];
    if (!chat?.riwayat?.length) { await kirimTeks(`❌ Tidak ada riwayat untuk [${id}].`); return; }

    let teksOut = `<b>📋 Riwayat [${id}] ${chat.nama}</b>\n\n`;
    for (const r of chat.riwayat) teksOut += `${r.waktu} — <b>${r.pengirim}:</b> ${r.pesan}\n`;
    await kirimTeks(teksOut);
    return;
  }

  // ===== /catat A catatan =====
  if (teks.startsWith("/catat ")) {
    const spasi = teks.indexOf(" ", 7);
    if (spasi === -1) { await kirimTeks("❌ Format: /catat [id] catatan kamu"); return; }
    const id      = teks.slice(7, spasi).toUpperCase();
    const catatan = teks.slice(spasi + 1).trim();
    if (!chatLog[id]) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    chatLog[id].catatan = catatan;
    await saveChatLog();
    await kirimTeks(`✅ Catatan untuk <b>[${id}] ${chatLog[id].nama}</b> disimpan.`);
    return;
  }

  // ===== /fixjid A 628xxx =====
  if (teks.startsWith("/fixjid ")) {
    const bagian = teks.replace("/fixjid ", "").trim().split(" ");
    if (bagian.length !== 2) { await kirimTeks("❌ Format: /fixjid [id] [nomor]\nContoh: /fixjid H 6287877164531"); return; }
    const id       = bagian[0].toUpperCase();
    const nomorBaru= bagian[1].trim().replace(/[^0-9]/g, "");
    const chat     = chatLog[id];
    if (!chat) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }

    const jidLama  = chat.jid;
    const jidBaru  = `${nomorBaru}@s.whatsapp.net`;
    delete jidToId[`${chat.waId}:${jidLama}`];
    jidToId[`${chat.waId}:${jidBaru}`] = id;
    chatLog[id].jid = jidBaru;
    await saveChatLog();
    await kirimTeks(
      `✅ JID [${id}] ${chat.nama} diperbaiki!\n\n` +
      `Lama: <code>${jidLama.replace(/@.*/, "")}</code>\n` +
      `Baru: <code>${nomorBaru}</code>`
    );
    return;
  }

  // ===== /selesai A =====
  if (teks.startsWith("/selesai ")) {
    const id = teks.replace("/selesai ", "").trim().toUpperCase();
    if (!chatLog[id]) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    chatLog[id].status = "selesai";
    await saveChatLog();
    await kirimTeks(`✅ [${id}] ${chatLog[id].nama} ditandai selesai.`);
    return;
  }

  // ===== BALAS: /A pesanmu — harus dicek paling akhir =====
  const matchBalas = teks.match(/^\/([A-Za-z]+)\s+(.+)$/s);
  if (matchBalas) {
    const idRaw  = matchBalas[1].toLowerCase();
    const idUpper= matchBalas[1].toUpperCase();
    const pesan  = matchBalas[2].trim();

    // Pastikan bukan perintah khusus
    if (perintahKhusus.includes(idRaw)) return;

    const chat = chatLog[idUpper];
    if (!chat) { await kirimTeks(`❌ Chat [${idUpper}] tidak ditemukan.`); return; }

    const aktif = await waManager.cekNomorAktif(chat.waId, chat.jid);
    if (!aktif) {
      chatLog[idUpper].status = "tidak_aktif";
      await saveChatLog();
      await kirimTeks(
        `❌ <b>[${idUpper}] ${chat.nama}</b>\n` +
        `📞 ${chat.jid.replace(/@.*/, "")}\n\n` +
        `Nomor tidak terdaftar di WhatsApp.\n` +
        `Status ditandai tidak aktif.`
      );
      return;
    }

    queue.tambahKeAntrian(chat.waId, chat.jid, pesan, null, chat.panjangPesan || 0);
    tambahRiwayat(idUpper, "HR", pesan);
    chatLog[idUpper].status     = "menunggu";
    chatLog[idUpper].waktuBalas = Date.now();
    await saveChatLog();
    await kirimTeks(`✅ Pesan ke <b>${chat.nama}</b> [${idUpper}] masuk antrian.`);
    logger.info("Bot-Bridge", `Balas [${idUpper}] ke ${chat.nama} masuk antrian`);
  }
}

// ===== EXPORT untuk bot-reminder =====
function getChatLog()       { return chatLog; }
function updateChatLog(id, data) {
  if (!chatLog[id]) return;
  chatLog[id] = { ...chatLog[id], ...data };
  saveChatLog();
}

module.exports = {
  setupCallbacks,
  setupWaCallbacks,
  prosesPerintah,
  kirimTeks,
  kirimError,
  getChatLog,
  updateChatLog,
  arsipChatLogLama,
};
