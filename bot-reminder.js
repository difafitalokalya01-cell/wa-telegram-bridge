const axios = require("axios");
const fs = require("fs");
const logger = require("./logger");
const { getChatLog, updateChatLog } = require("./bot-bridge");

const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
const TOKEN = config.botReminderToken;
const ADMIN_ID = config.adminTelegramId;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// Setting pengingat (dalam menit)
let reminderSettings = {
  reminder1: config.reminderSettings?.reminder1 || 30,
  reminder2: config.reminderSettings?.reminder2 || 60,
  reminder3: config.reminderSettings?.reminder3 || 120,
};

async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: ADMIN_ID,
      text: teks,
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Reminder", `Gagal kirim teks: ${err.message}`);
  }
}

// ===== CEK PENGINGAT =====
async function cekPengingat() {
  try {
    const chatLog = getChatLog();
    const sekarang = Date.now();

    for (const [id, chat] of Object.entries(chatLog)) {
      // Hanya cek yang perlu dibalas
      if (chat.status !== "perlu_dibalas") continue;
      if (!chat.waktuPesan) continue;

      const selisihMenit = Math.floor((sekarang - chat.waktuPesan) / 60000);

      // Pengingat 1 — 30 menit
      if (
        selisihMenit >= reminderSettings.reminder1 &&
        selisihMenit < reminderSettings.reminder2 &&
        !chat.reminder1Terkirim
      ) {
        await kirimTeks(
          `⏰ <b>Pengingat 1 — Belum dibalas ${reminderSettings.reminder1} menit!</b>\n\n` +
          `<b>[${id}]</b> ${chat.nama}\n` +
          `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
          `📱 ${chat.waId}\n\n` +
          `💬 "${chat.pesanTerakhir?.slice(0, 60) || ""}"\n\n` +
          `Balas: /${id} pesanmu`
        );
        updateChatLog(id, { reminder1Terkirim: true });
        logger.info("Bot-Reminder", `Pengingat 1 terkirim untuk [${id}] ${chat.nama}`);
      }

      // Pengingat 2 — 1 jam
      else if (
        selisihMenit >= reminderSettings.reminder2 &&
        selisihMenit < reminderSettings.reminder3 &&
        !chat.reminder2Terkirim
      ) {
        await kirimTeks(
          `⚠️ <b>Pengingat 2 — Belum dibalas ${reminderSettings.reminder2} menit!</b>\n\n` +
          `<b>[${id}]</b> ${chat.nama}\n` +
          `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
          `📱 ${chat.waId}\n\n` +
          `💬 "${chat.pesanTerakhir?.slice(0, 60) || ""}"\n\n` +
          `Balas: /${id} pesanmu`
        );
        updateChatLog(id, { reminder2Terkirim: true });
        logger.info("Bot-Reminder", `Pengingat 2 terkirim untuk [${id}] ${chat.nama}`);
      }

      // Pengingat 3 — 2 jam (urgent)
      else if (
        selisihMenit >= reminderSettings.reminder3 &&
        !chat.reminder3Terkirim
      ) {
        await kirimTeks(
          `🚨 <b>URGENT — Belum dibalas ${reminderSettings.reminder3} menit!</b>\n\n` +
          `<b>[${id}]</b> ${chat.nama}\n` +
          `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
          `📱 ${chat.waId}\n\n` +
          `💬 "${chat.pesanTerakhir?.slice(0, 60) || ""}"\n\n` +
          `Balas: /${id} pesanmu`
        );
        updateChatLog(id, { reminder3Terkirim: true });
        logger.info("Bot-Reminder", `Pengingat 3 (URGENT) terkirim untuk [${id}] ${chat.nama}`);
      }
    }
  } catch (err) {
    logger.error("Bot-Reminder", `Error cek pengingat: ${err.message}`);
  }
}

// ===== RESET PENGINGAT SAAT SUDAH DIBALAS =====
function resetPengingat(id) {
  updateChatLog(id, {
    reminder1Terkirim: false,
    reminder2Terkirim: false,
    reminder3Terkirim: false,
  });
}

// ===== PROSES PERINTAH =====
async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const fromId = String(msg.from?.id);

  if (fromId !== String(ADMIN_ID)) return;

  if (teks === "/start") {
    await kirimTeks(
      `<b>Bot Pengingat HR aktif!</b>\n\n` +
      `Saya akan mengingatkan kamu kalau ada kandidat yang belum dibalas.\n\n` +
      `<b>Pengaturan saat ini:</b>\n` +
      `⏰ Pengingat 1: ${reminderSettings.reminder1} menit\n` +
      `⚠️ Pengingat 2: ${reminderSettings.reminder2} menit\n` +
      `🚨 Pengingat 3: ${reminderSettings.reminder3} menit\n\n` +
      `<b>Perintah:</b>\n` +
      `/setreminder 30 60 120 - Ubah waktu pengingat\n` +
      `/ceksekarang - Cek pengingat sekarang`
    );
  }

  // /setreminder 30 60 120
  else if (teks.startsWith("/setreminder ")) {
    const bagian = teks.replace("/setreminder ", "").trim().split(" ");
    if (bagian.length !== 3) {
      await kirimTeks("❌ Format: /setreminder menit1 menit2 menit3\nContoh: /setreminder 30 60 120");
      return;
    }

    const r1 = parseInt(bagian[0]);
    const r2 = parseInt(bagian[1]);
    const r3 = parseInt(bagian[2]);

    if (isNaN(r1) || isNaN(r2) || isNaN(r3) || r1 >= r2 || r2 >= r3) {
      await kirimTeks("❌ Pastikan menit1 < menit2 < menit3.");
      return;
    }

    reminderSettings = { reminder1: r1, reminder2: r2, reminder3: r3 };

    // Simpan ke config
    const cfg = global.loadConfig();
    cfg.reminderSettings = reminderSettings;
    global.saveData(cfg);

    await kirimTeks(
      `✅ Pengingat diupdate:\n` +
      `⏰ Pengingat 1: ${r1} menit\n` +
      `⚠️ Pengingat 2: ${r2} menit\n` +
      `🚨 Pengingat 3: ${r3} menit`
    );
  }

  // /ceksekarang
  else if (teks === "/ceksekarang") {
    await kirimTeks("⏳ Mengecek pengingat sekarang...");
    await cekPengingat();
    await kirimTeks("✅ Pengecekan selesai.");
  }
}

// ===== MULAI INTERVAL =====
function mulaiPengingat() {
  // Cek setiap 5 menit
  setInterval(cekPengingat, 5 * 60 * 1000);
  logger.info("Bot-Reminder", "Sistem pengingat aktif, cek setiap 5 menit");
}

module.exports = { prosesPerintah, kirimTeks, mulaiPengingat, resetPengingat };