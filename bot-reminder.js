const axios     = require("axios");
const logger    = require("./logger");
const store     = require("./store");
const { getChatLog, updateChatLog } = require("./bot-bridge");

function getToken()     { return store.getConfig().botReminderToken; }
function getAdminId()   { return store.getConfig().adminTelegramId; }
function getTelegramApi(){ return `https://api.telegram.org/bot${getToken()}`; }

function getReminderSettings() {
  const cfg = store.getConfig();
  return {
    reminder1: cfg.reminderSettings?.reminder1 || 30,
    reminder2: cfg.reminderSettings?.reminder2 || 60,
    reminder3: cfg.reminderSettings?.reminder3 || 120,
  };
}

async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${getTelegramApi()}/sendMessage`, {
      chat_id: getAdminId(), text: teks, parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Reminder", `Gagal kirim teks: ${err.message}`);
  }
}

async function cekPengingat() {
  try {
    const chatLog = getChatLog();
    const sekarang = Date.now();
    const rs = getReminderSettings();

    for (const [id, chat] of Object.entries(chatLog)) {
      if (chat.status !== "perlu_dibalas") continue;
      if (!chat.waktuPesan) continue;

      const selisihMenit = Math.floor((sekarang - chat.waktuPesan) / 60000);

      if (selisihMenit >= rs.reminder1 && selisihMenit < rs.reminder2 && !chat.reminder1Terkirim) {
        await kirimTeks(
          `⏰ <b>Pengingat 1 — Belum dibalas ${rs.reminder1} menit!</b>\n\n` +
          `<b>[${id}]</b> ${chat.nama}\n` +
          `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
          `📱 ${chat.waId}\n\n` +
          `💬 "${chat.pesanTerakhir?.slice(0, 60) || ""}"\n\n` +
          `Balas: /${id} pesanmu`
        );
        updateChatLog(id, { reminder1Terkirim: true });
        logger.info("Bot-Reminder", `Pengingat 1 terkirim untuk [${id}] ${chat.nama}`);

      } else if (selisihMenit >= rs.reminder2 && selisihMenit < rs.reminder3 && !chat.reminder2Terkirim) {
        await kirimTeks(
          `⚠️ <b>Pengingat 2 — Belum dibalas ${rs.reminder2} menit!</b>\n\n` +
          `<b>[${id}]</b> ${chat.nama}\n` +
          `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
          `📱 ${chat.waId}\n\n` +
          `💬 "${chat.pesanTerakhir?.slice(0, 60) || ""}"\n\n` +
          `Balas: /${id} pesanmu`
        );
        updateChatLog(id, { reminder2Terkirim: true });
        logger.info("Bot-Reminder", `Pengingat 2 terkirim untuk [${id}] ${chat.nama}`);

      } else if (selisihMenit >= rs.reminder3 && !chat.reminder3Terkirim) {
        await kirimTeks(
          `🚨 <b>URGENT — Belum dibalas ${rs.reminder3} menit!</b>\n\n` +
          `<b>[${id}]</b> ${chat.nama}\n` +
          `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
          `📱 ${chat.waId}\n\n` +
          `💬 "${chat.pesanTerakhir?.slice(0, 60) || ""}"\n\n` +
          `Balas: /${id} pesanmu`
        );
        updateChatLog(id, { reminder3Terkirim: true });
        logger.info("Bot-Reminder", `Pengingat 3 URGENT terkirim untuk [${id}] ${chat.nama}`);
      }
    }
  } catch (err) {
    logger.error("Bot-Reminder", `Error cek pengingat: ${err.message}`);
  }
}

function resetPengingat(id) {
  updateChatLog(id, {
    reminder1Terkirim: false,
    reminder2Terkirim: false,
    reminder3Terkirim: false,
  });
}

async function prosesPerintah(msg) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  if (teks === "/start") {
    const rs = getReminderSettings();
    await kirimTeks(
      `<b>Bot Pengingat aktif!</b>\n\n` +
      `Saya akan mengingatkan kamu kalau ada kandidat yang belum dibalas.\n\n` +
      `<b>Pengaturan saat ini:</b>\n` +
      `⏰ Pengingat 1: ${rs.reminder1} menit\n` +
      `⚠️ Pengingat 2: ${rs.reminder2} menit\n` +
      `🚨 Pengingat 3: ${rs.reminder3} menit\n\n` +
      `<b>Perintah:</b>\n` +
      `/setreminder 30 60 120 - Ubah waktu pengingat\n` +
      `/ceksekarang - Cek pengingat sekarang\n\n` +
      `<b>Balas langsung dari sini:</b>\n` +
      `/[id] pesan - Balas kandidat\n` +
      `/lihat [id] - Detail kandidat`
    );
    return;
  }

  if (teks.startsWith("/setreminder ")) {
    const bagian = teks.replace("/setreminder ", "").trim().split(" ");
    if (bagian.length !== 3) { await kirimTeks("❌ Format: /setreminder menit1 menit2 menit3\nContoh: /setreminder 30 60 120"); return; }
    const r1 = parseInt(bagian[0]);
    const r2 = parseInt(bagian[1]);
    const r3 = parseInt(bagian[2]);
    if (isNaN(r1) || isNaN(r2) || isNaN(r3) || r1 >= r2 || r2 >= r3) {
      await kirimTeks("❌ Pastikan menit1 < menit2 < menit3.");
      return;
    }
    const cfg = store.getConfig();
    cfg.reminderSettings = { reminder1: r1, reminder2: r2, reminder3: r3 };
    await store.saveData(cfg);
    await kirimTeks(
      `✅ Pengingat diupdate:\n` +
      `⏰ Pengingat 1: ${r1} menit\n` +
      `⚠️ Pengingat 2: ${r2} menit\n` +
      `🚨 Pengingat 3: ${r3} menit`
    );
    return;
  }

  if (teks === "/ceksekarang") {
    await kirimTeks("⏳ Mengecek pengingat sekarang...");
    await cekPengingat();
    await kirimTeks("✅ Pengecekan selesai.");
    return;
  }

  // ===== /lihat A — lihat detail kandidat =====
  if (teks.startsWith("/lihat ")) {
    const { getChatLog } = require("./bot-bridge");
    const id   = teks.replace("/lihat ", "").trim().toUpperCase();
    const chat = getChatLog()[id];
    if (!chat) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    const statusMap = {
      baru: "🆕 Baru", perlu_dibalas: "🔔 Perlu dibalas",
      menunggu: "⏳ Menunggu reply", selesai: "✅ Selesai", tidak_aktif: "❌ Tidak aktif",
    };
    await kirimTeks(
      `<b>👤 [${id}] ${chat.nama}</b>\n` +
      `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
      `📱 ${chat.waId}\n` +
      `Status: ${statusMap[chat.status] || chat.status}\n\n` +
      `💬 "${chat.pesanTerakhir?.slice(0, 100) || ""}"\n\n` +
      `Balas: /${id} pesanmu`
    );
    return;
  }

  // ===== BALAS: /A pesanmu =====
  const matchBalas = teks.match(/^\/([A-Za-z]+)\s+(.+)$/s);
  if (matchBalas) {
    const perintahKhusus = ["setreminder", "ceksekarang", "start", "lihat"];
    const idRaw   = matchBalas[1].toLowerCase();
    const idUpper = matchBalas[1].toUpperCase();
    const pesan   = matchBalas[2].trim();

    if (perintahKhusus.includes(idRaw)) return;

    const { getChatLog, updateChatLog } = require("./bot-bridge");
    const chatLog = getChatLog();
    const chat    = chatLog[idUpper];

    if (!chat) { await kirimTeks(`❌ Chat [${idUpper}] tidak ditemukan.`); return; }

    const waManager = require("./wa-manager");
    const queue     = require("./queue");

    const aktif = await waManager.cekNomorAktif(chat.waId, chat.jid);
    if (!aktif) {
      updateChatLog(idUpper, { status: "tidak_aktif" });
      await kirimTeks(
        `❌ Nomor ${chat.jid.replace(/@.*/, "")} tidak aktif di WhatsApp.`
      );
      return;
    }

    queue.tambahKeAntrian(chat.waId, chat.jid, pesan, null, chat.panjangPesan || 0);
    updateChatLog(idUpper, { status: "menunggu", waktuBalas: Date.now() });
    // Reset reminder karena sudah dibalas
    updateChatLog(idUpper, {
      reminder1Terkirim: false,
      reminder2Terkirim: false,
      reminder3Terkirim: false,
    });
    await kirimTeks(`✅ Pesan ke <b>${chat.nama}</b> [${idUpper}] masuk antrian.`);

    // Notif ke bot slot agar tidak membingungkan
    try {
      const slot = store.getSlotByWaId(chat.waId);
      if (slot) {
        const { kirimKeSlot } = require("./bot-pool");
        await kirimKeSlot(
          slot.token,
          store.getConfig().adminTelegramId,
          `📤 <b>[${idUpper}] ${chat.nama}</b> dibalas via Bot Pengingat\n` +
          `💬 "${pesan.slice(0, 80)}${pesan.length > 80 ? "..." : ""}"`
        );
      }
    } catch (e) {}
  }
}

function mulaiPengingat() {
  setInterval(cekPengingat, 5 * 60 * 1000);
  logger.info("Bot-Reminder", "Sistem pengingat aktif, cek setiap 5 menit");
}

module.exports = { prosesPerintah, kirimTeks, mulaiPengingat, resetPengingat };
