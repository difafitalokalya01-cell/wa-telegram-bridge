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

// ===== GENERATE ID HURUF =====
function generateId(counter) {
  let id = "";
  let n = counter;
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

// ===== LOAD & SAVE CHATLOG =====
function loadChatLog() {
  try {
    if (fs.existsSync(CHATLOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHATLOG_FILE, "utf-8"));
      return {
        chatLog: data.chatLog || {},
        chatCounter: data.chatCounter || 0,
        jidToId: data.jidToId || {},
      };
    }
  } catch (e) {
    logger.error("Bot-Bridge", `Gagal load chatlog: ${e.message}`);
  }
  return { chatLog: {}, chatCounter: 0, jidToId: {} };
}

function saveChatLog() {
  try {
    fs.writeFileSync(CHATLOG_FILE, JSON.stringify({ chatLog, chatCounter, jidToId }, null, 2));
  } catch (e) {
    logger.error("Bot-Bridge", `Gagal save chatlog: ${e.message}`);
  }
}

let { chatLog, chatCounter, jidToId } = loadChatLog();
let pendingUnread = {};

// ===== DAPATKAN ATAU BUAT ID =====
function getOrCreateId(waId, jid, nama) {
  const key = `${waId}:${jid}`;
  if (jidToId[key]) {
    chatLog[jidToId[key]].nama = nama;
    return jidToId[key];
  }
  const id = generateId(chatCounter);
  chatCounter++;
  jidToId[key] = id;
  chatLog[id] = {
    waId,
    jid,
    nama,
    waktuPertama: Date.now(),
    waktuPesan: Date.now(),
    panjangPesan: 0,
    status: "baru",
    pesanTerakhir: "",
    riwayat: [],
  };
  return id;
}

// ===== FORMAT WAKTU =====
function formatWaktu(timestamp) {
  const selisih = Date.now() - timestamp;
  const menit = Math.floor(selisih / 60000);
  const jam = Math.floor(menit / 60);
  const hari = Math.floor(jam / 24);

  if (hari > 0) return `${hari} hari lalu`;
  if (jam > 0) return `${jam} jam lalu`;
  if (menit > 0) return `${menit} menit lalu`;
  return "baru saja";
}

// ===== FORMAT URGENSI =====
function formatUrgensi(timestamp) {
  const menit = Math.floor((Date.now() - timestamp) / 60000);
  if (menit >= 60) return "🚨";
  if (menit >= 30) return "⚠️";
  return "";
}

// ===== POTONG PESAN =====
function potongPesan(pesan, max = 60) {
  if (!pesan) return "";
  if (pesan.length <= max) return pesan;
  return pesan.slice(0, max) + "...";
}

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

// ===== TAMBAH RIWAYAT =====
function tambahRiwayat(id, pengirim, pesan) {
  if (!chatLog[id]) return;
  if (!chatLog[id].riwayat) chatLog[id].riwayat = [];

  const waktu = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  chatLog[id].riwayat.push({ pengirim, pesan: potongPesan(pesan, 100), waktu });

  // Simpan maksimal 50 riwayat terakhir
  if (chatLog[id].riwayat.length > 50) {
    chatLog[id].riwayat = chatLog[id].riwayat.slice(-50);
  }
}

// ===== SETUP CALLBACKS =====
function setupCallbacks() {
  waManager.setCallbacks({
    onMessage: async (waId, jid, nama, pesan) => {
      const id = getOrCreateId(waId, jid, nama);
      chatLog[id].panjangPesan = pesan.length;
      chatLog[id].status = "perlu_dibalas";
      chatLog[id].waktuPesan = Date.now();
      chatLog[id].pesanTerakhir = pesan;
      tambahRiwayat(id, nama, pesan);
      saveChatLog();

      await kirimTeks(
        `<b>[${id}] ${waId}</b>\n` +
        `👤 <b>${nama}</b>\n` +
        `📞 <b>${jid.replace(/@.*/, "")}</b>\n\n` +
        `💬 ${pesan}\n\n` +
        `<i>Balas: /${id} pesanmu</i>`
      );
      logger.info("Bot-Bridge", `Pesan masuk [${id}] dari ${nama} via ${waId}`);
    },

    onMedia: async (waId, jid, nama, buffer, ext, mediaType, caption) => {
      const id = getOrCreateId(waId, jid, nama);
      chatLog[id].panjangPesan = caption.length;
      chatLog[id].status = "perlu_dibalas";
      chatLog[id].waktuPesan = Date.now();
      chatLog[id].pesanTerakhir = caption || `[${mediaType.replace("Message", "")}]`;
      tambahRiwayat(id, nama, caption || `[${mediaType.replace("Message", "")}]`);
      saveChatLog();

      const info =
        `[${id}] ${waId}\n` +
        `👤 ${nama}\n` +
        `📞 ${jid.replace(/@.*/, "")}\n` +
        (caption ? `💬 ${caption}\n` : "") +
        `\nBalas: /${id} pesanmu`;

      if (mediaType === "imageMessage") {
        await kirimFoto(buffer, info);
      } else if (mediaType === "videoMessage") {
        await kirimVideo(buffer, info);
      } else {
        await kirimDokumen(buffer, `file.${ext}`, info);
      }

      logger.info("Bot-Bridge", `Media masuk [${id}] dari ${nama} via ${waId}`);
    },

    onUnreadFound: async (waId, unreadChats) => {
      const total = unreadChats.reduce((sum, c) => sum + c.unreadCount, 0);
      logger.info("Bot-Bridge", `${waId}: meneruskan ${unreadChats.length} unread otomatis`);

      await kirimTeks(
        `<b>${waId} terhubung!</b>\n\n` +
        `Meneruskan <b>${total} pesan belum dibaca</b> dari ${unreadChats.length} chat...`
      );

      for (const chat of unreadChats) {
        const id = getOrCreateId(waId, chat.jid, chat.name);
        chatLog[id].status = "perlu_dibalas";
        chatLog[id].waktuPesan = Date.now();
        saveChatLog();

        await kirimTeks(
          `<b>[${id}] Unread - ${waId}</b>\n` +
          `👤 <b>${chat.name}</b>\n` +
          `📞 <b>${chat.jid.replace(/@.*/, "")}</b>\n` +
          `📨 ${chat.unreadCount} pesan belum dibaca\n\n` +
          `<i>Balas: /${id} pesanmu</i>`
        );

        const jeda = Math.floor(Math.random() * 2000) + 3000;
        await new Promise((r) => setTimeout(r, jeda));
      }
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
    const match = targetCaption.match(/^\/?\s*([A-Za-z]+)/);

    if (!match) {
      await kirimTeks("❌ Tambahkan caption ID chat.\nContoh: /A");
      return;
    }

    const id = match[1].toUpperCase();
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`);
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

      const fileInfoRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfoRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
      const fileRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(fileRes.data);

      const pesanTeks = targetCaption.replace(/^\/?\s*[A-Za-z]+\s*/, "").trim();

      let pesanWA;
      if (mediaType === "image") {
        pesanWA = { image: buffer, caption: pesanTeks || "" };
      } else if (mediaType === "video") {
        pesanWA = { video: buffer, caption: pesanTeks || "" };
      } else {
        pesanWA = { document: buffer, fileName, caption: pesanTeks || "" };
      }

      queue.tambahKeAntrian(chat.waId, chat.jid, pesanTeks, pesanWA, chat.panjangPesan || 0);
      tambahRiwayat(id, "HR", `[Media] ${pesanTeks}`);
      chatLog[id].status = "menunggu";
      saveChatLog();
      await kirimTeks(`✅ Media ke <b>${chat.nama}</b> [${id}] masuk antrian.`);
    } catch (err) {
      await kirimTeks(`❌ Gagal proses media: ${err.message}`);
    }
    return;
  }

// ===== BALAS: /A pesanmu =====
// Pastikan bukan perintah khusus
const perintahKhusus = ["ke", "dc", "daftarchat", "lihat", "riwayat", "catat", "selesai", "antrian", "status", "start", "teruskanunread", "fixjid"];
const idBalas = teks.match(/^\/([A-Za-z]+)\s+/)?.[1]?.toLowerCase();

if (idBalas && !perintahKhusus.includes(idBalas) && teks.match(/^\/[A-Za-z]+\s+/)) {
    const spasi = teks.indexOf(" ");
    const id = teks.slice(1, spasi).toUpperCase();
    const pesan = teks.slice(spasi + 1).trim();
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`);
      return;
    }

    const aktif = await waManager.cekNomorAktif(chat.waId, chat.jid);
    if (!aktif) {
      chatLog[id].status = "tidak_aktif";
      saveChatLog();
      await kirimTeks(
        `❌ <b>[${id}] ${chat.nama}</b>\n` +
        `📞 ${chat.jid.replace(/@.*/, "")}\n\n` +
        `Nomor tidak terdaftar di WhatsApp.\n` +
        `Status ditandai tidak aktif.`
      );
      return;
    }

    queue.tambahKeAntrian(chat.waId, chat.jid, pesan, null, chat.panjangPesan || 0);
    tambahRiwayat(id, "HR", pesan);
    chatLog[id].status = "menunggu";
    chatLog[id].waktuBalas = Date.now();
    saveChatLog();
    await kirimTeks(`✅ Pesan ke <b>${chat.nama}</b> [${id}] masuk antrian.`);
    logger.info("Bot-Bridge", `Balas [${id}] ke ${chat.nama} masuk antrian`);
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
    queue.tambahKeAntrian(waIds[0], jid, pesan, null, 0);
    await kirimTeks(`✅ Pesan ke ${nomor} masuk antrian.`);
  }

  // /dc — daftarchat ringkasan
  else if (teks === "/dc" || teks === "/daftarchat") {
    const semua = Object.entries(chatLog);
    const perluDibalas = semua.filter(([, c]) => c.status === "perlu_dibalas");
    const menunggu = semua.filter(([, c]) => c.status === "menunggu");
    const baru = semua.filter(([, c]) => c.status === "baru");
    const selesai = semua.filter(([, c]) => c.status === "selesai");
    const tidakAktif = semua.filter(([, c]) => c.status === "tidak_aktif");

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
  }

  // /dc perlu | menunggu | baru | selesai | semua | WA-1
  else if (teks.startsWith("/dc ")) {
    const filter = teks.replace("/dc ", "").trim().toLowerCase();
    let daftar = Object.entries(chatLog);
    let judul = "";

    if (filter === "perlu") {
      daftar = daftar.filter(([, c]) => c.status === "perlu_dibalas");
      judul = "🔔 Perlu Dibalas";
      // Urutkan dari yang paling lama
      daftar.sort((a, b) => a[1].waktuPesan - b[1].waktuPesan);
    } else if (filter === "menunggu") {
      daftar = daftar.filter(([, c]) => c.status === "menunggu");
      judul = "⏳ Menunggu Reply";
    } else if (filter === "baru") {
      daftar = daftar.filter(([, c]) => c.status === "baru");
      judul = "🆕 Baru";
    } else if (filter === "selesai") {
      daftar = daftar.filter(([, c]) => c.status === "selesai");
      judul = "✅ Selesai";
    } else if (filter === "semua") {
      judul = "📋 Semua Kandidat";
    } else {
      // Filter per WA
      daftar = daftar.filter(([, c]) => c.waId?.toLowerCase() === filter);
      judul = `📱 ${filter.toUpperCase()}`;
    }

    if (daftar.length === 0) {
      await kirimTeks(`Tidak ada kandidat dengan filter <b>${filter}</b>.`);
      return;
    }

    // Tampilkan per halaman 10
    const perHalaman = 10;
    const totalHalaman = Math.ceil(daftar.length / perHalaman);
    const halaman1 = daftar.slice(0, perHalaman);

    let teksOut = `<b>${judul} (${daftar.length})</b>\n\n`;

    for (const [id, c] of halaman1) {
      const urgensi = c.status === "perlu_dibalas" ? formatUrgensi(c.waktuPesan) : "";
      const waktu = formatWaktu(c.waktuPesan);
      const potongan = potongPesan(c.pesanTerakhir);

      teksOut +=
        `${urgensi} <b>[${id}]</b> ${c.nama} — ${c.waId} — ${waktu}\n` +
        `📞 ${c.jid?.replace(/@.*/, "")}\n` +
        (potongan ? `💬 "${potongan}"\n` : "") +
        `\n`;
    }

    if (totalHalaman > 1) {
      teksOut += `\nHalaman 1/${totalHalaman}\n/dc ${filter} 2 — halaman berikutnya`;
    }

    await kirimTeks(teksOut);
  }

  // /dc filter halaman (pagination)
  else if (teks.match(/^\/dc \S+ \d+$/)) {
    const bagian = teks.replace("/dc ", "").trim().split(" ");
    const filter = bagian[0].toLowerCase();
    const halaman = parseInt(bagian[1]) || 1;

    let daftar = Object.entries(chatLog);

    if (filter === "perlu") {
      daftar = daftar.filter(([, c]) => c.status === "perlu_dibalas");
      daftar.sort((a, b) => a[1].waktuPesan - b[1].waktuPesan);
    } else if (filter === "menunggu") {
      daftar = daftar.filter(([, c]) => c.status === "menunggu");
    } else if (filter === "baru") {
      daftar = daftar.filter(([, c]) => c.status === "baru");
    } else if (filter === "selesai") {
      daftar = daftar.filter(([, c]) => c.status === "selesai");
    } else {
      daftar = daftar.filter(([, c]) => c.waId?.toLowerCase() === filter);
    }

    const perHalaman = 10;
    const totalHalaman = Math.ceil(daftar.length / perHalaman);
    const start = (halaman - 1) * perHalaman;
    const halamanIni = daftar.slice(start, start + perHalaman);

    if (halamanIni.length === 0) {
      await kirimTeks(`Halaman ${halaman} tidak ditemukan.`);
      return;
    }

    let teksOut = `<b>Halaman ${halaman}/${totalHalaman}</b>\n\n`;

    for (const [id, c] of halamanIni) {
      const urgensi = c.status === "perlu_dibalas" ? formatUrgensi(c.waktuPesan) : "";
      const waktu = formatWaktu(c.waktuPesan);
      const potongan = potongPesan(c.pesanTerakhir);

      teksOut +=
        `${urgensi} <b>[${id}]</b> ${c.nama} — ${c.waId} — ${waktu}\n` +
        `📞 ${c.jid?.replace(/@.*/, "")}\n` +
        (potongan ? `💬 "${potongan}"\n` : "") +
        `\n`;
    }

    if (halaman < totalHalaman) {
      teksOut += `\n/dc ${filter} ${halaman + 1} — halaman berikutnya`;
    }

    await kirimTeks(teksOut);
  }

  // /lihat A — lihat detail + riwayat kandidat
  else if (teks.startsWith("/lihat ")) {
    const id = teks.replace("/lihat ", "").trim().toUpperCase();
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`);
      return;
    }

    const statusMap = {
      baru: "🆕 Baru",
      perlu_dibalas: "🔔 Perlu dibalas",
      menunggu: "⏳ Menunggu reply",
      selesai: "✅ Selesai",
      tidak_aktif: "❌ Tidak aktif",
    };

    let teksOut =
      `<b>👤 [${id}] ${chat.nama}</b>\n` +
      `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
      `📱 ${chat.waId}\n` +
      `📅 Pertama: ${new Date(chat.waktuPertama).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
      `🕐 Terakhir: ${formatWaktu(chat.waktuPesan)}\n` +
      `Status: ${statusMap[chat.status] || chat.status}\n\n`;

    if (chat.catatan) {
      teksOut += `📝 <b>Catatan:</b>\n${chat.catatan}\n\n`;
    }

    if (chat.riwayat && chat.riwayat.length > 0) {
      teksOut += `<b>📋 Riwayat (${chat.riwayat.length} pesan):</b>\n`;
      const riwayatTerakhir = chat.riwayat.slice(-5);
      for (const r of riwayatTerakhir) {
        teksOut += `${r.waktu} — <b>${r.pengirim}:</b> ${r.pesan}\n`;
      }
      if (chat.riwayat.length > 5) {
        teksOut += `\n/riwayat ${id} — lihat semua riwayat`;
      }
    }

    await kirimTeks(teksOut);
  }

  // /riwayat A — lihat semua riwayat
  else if (teks.startsWith("/riwayat ")) {
    const id = teks.replace("/riwayat ", "").trim().toUpperCase();
    const chat = chatLog[id];

    if (!chat || !chat.riwayat || chat.riwayat.length === 0) {
      await kirimTeks(`❌ Tidak ada riwayat untuk [${id}].`);
      return;
    }

    let teksOut = `<b>📋 Riwayat [${id}] ${chat.nama}</b>\n\n`;
    for (const r of chat.riwayat) {
      teksOut += `${r.waktu} — <b>${r.pengirim}:</b> ${r.pesan}\n`;
    }

    await kirimTeks(teksOut);
  }

  // /catat A catatan
  else if (teks.startsWith("/catat ")) {
    const spasi = teks.indexOf(" ", 7);
    if (spasi === -1) {
      await kirimTeks("❌ Format: /catat [id] catatan kamu");
      return;
    }
    const id = teks.slice(7, spasi).toUpperCase();
    const catatan = teks.slice(spasi + 1).trim();
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`);
      return;
    }

    chatLog[id].catatan = catatan;
    saveChatLog();
    await kirimTeks(`✅ Catatan untuk <b>[${id}] ${chat.nama}</b> disimpan.`);
  }

// /fixjid A 628xxx
  else if (teks.startsWith("/fixjid ")) {
    const bagian = teks.replace("/fixjid ", "").trim().split(" ");
    if (bagian.length !== 2) {
      await kirimTeks("❌ Format: /fixjid [id] [nomor]\nContoh: /fixjid H 6287877164531");
      return;
    }

    const id = bagian[0].toUpperCase();
    const nomorBaru = bagian[1].trim().replace(/[^0-9]/g, "");
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`);
      return;
    }

    const jidLama = chat.jid;
    const jidBaru = `${nomorBaru}@s.whatsapp.net`;

    const keyLama = `${chat.waId}:${jidLama}`;
    const keyBaru = `${chat.waId}:${jidBaru}`;
    delete jidToId[keyLama];
    jidToId[keyBaru] = id;

    chatLog[id].jid = jidBaru;
    saveChatLog();

    await kirimTeks(
      `✅ JID [${id}] ${chat.nama} diperbaiki!\n\n` +
      `Lama: <code>${jidLama.replace(/@.*/, "")}</code>\n` +
      `Baru: <code>${nomorBaru}</code>`
    );
    logger.info("Bot-Bridge", `Fix JID [${id}]: ${jidLama} → ${jidBaru}`);
  }

  // /selesai A
  else if (teks.startsWith("/selesai ")) {
    const id = teks.replace("/selesai ", "").trim().toUpperCase();
    if (!chatLog[id]) {
      await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`);
      return;
    }
    chatLog[id].status = "selesai";
    saveChatLog();
    await kirimTeks(`✅ [${id}] ${chatLog[id].nama} ditandai selesai.`);
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
      .map(([id, s]) => `- ${id}: ${s.status === "connected" ? "✅" : "❌"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA terhubung";

    await kirimTeks(
      `<b>Status WA Bridge</b>\n\n` +
      `${daftar}\n\n` +
      `<b>Perintah:</b>\n` +
      `/[id] pesan - Balas kandidat\n` +
      `/ke nomor pesan - Kirim ke nomor baru\n` +
      `/dc - Ringkasan chat\n` +
      `/lihat [id] - Detail kandidat\n` +
      `/catat [id] catatan - Tambah catatan\n` +
      `/selesai [id] - Tandai selesai\n` +
      `/antrian - Status antrian\n` +
      `/status - Status WA`
    );
  }

  // /start
  else if (teks === "/start") {
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
  }
}

// Export chatLog untuk diakses bot-reminder
function getChatLog() {
  return chatLog;
}

function updateChatLog(id, data) {
  if (chatLog[id]) {
    chatLog[id] = { ...chatLog[id], ...data };
    saveChatLog();
  }
}

module.exports = { setupCallbacks, prosesPerintah, kirimTeks, kirimError, getChatLog, updateChatLog };