const axios = require("axios");
const fs = require("fs");
const logger = require("./logger");
const queue = require("./queue");
const waManager = require("./wa-manager");

const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
const TOKEN = config.botConfigToken;
const ADMIN_ID = config.adminTelegramId;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: ADMIN_ID,
      text: teks,
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Config", `Gagal kirim teks: ${err.message}`);
  }
}

function simpanConfig(cfg) {
  fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
}

async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const fromId = String(msg.from?.id);

  if (fromId !== String(ADMIN_ID)) {
    await kirimTeks("⛔ Kamu tidak punya akses.");
    return;
  }

  // /start
  if (teks === "/start") {
    await kirimTeks(
      `⚙️ <b>Bot Konfigurasi</b>\n\n` +
      `<b>Blacklist:</b>\n` +
      `/blacklist - Lihat daftar blacklist\n` +
      `/tambahblacklist 628xxx - Tambah nomor\n` +
      `/hapusblacklist 628xxx - Hapus nomor\n\n` +
      `<b>Antrian & Jeda:</b>\n` +
      `/setjeda lambat|normal|cepat - Kecepatan ketik\n` +
      `/setrandom on|off - Jeda random\n` +
      `/setminjeda detik - Minimum jeda\n` +
      `/setmaxjeda detik - Maximum jeda\n\n` +
      `<b>Akun WA:</b>\n` +
      `/aktifkan namaWA - Aktifkan akun\n` +
      `/nonaktifkan namaWA - Nonaktifkan akun\n\n` +
      `<b>Info:</b>\n` +
      `/pengaturan - Lihat semua pengaturan\n` +
      `/healthcheck - Cek status sistem`
    );
  }

  // /blacklist
  else if (teks === "/blacklist") {
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    const list = cfg.blacklist || [];
    if (list.length === 0) {
      await kirimTeks("📋 Blacklist kosong.");
      return;
    }
    await kirimTeks(`📋 <b>Blacklist (${list.length}):</b>\n\n` + list.map((n) => `• <code>${n}</code>`).join("\n"));
  }

  // /tambahblacklist 628xxx
  else if (teks.startsWith("/tambahblacklist ")) {
    const nomor = teks.replace("/tambahblacklist ", "").trim();
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    if (cfg.blacklist.includes(nomor)) {
      await kirimTeks(`❌ ${nomor} sudah ada di blacklist.`);
      return;
    }
    cfg.blacklist.push(nomor);
    simpanConfig(cfg);
    await kirimTeks(`✅ <code>${nomor}</code> ditambahkan ke blacklist.`);
    logger.info("Bot-Config", `Blacklist tambah: ${nomor}`);
  }

  // /hapusblacklist 628xxx
  else if (teks.startsWith("/hapusblacklist ")) {
    const nomor = teks.replace("/hapusblacklist ", "").trim();
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    const idx = cfg.blacklist.indexOf(nomor);
    if (idx === -1) {
      await kirimTeks(`❌ ${nomor} tidak ada di blacklist.`);
      return;
    }
    cfg.blacklist.splice(idx, 1);
    simpanConfig(cfg);
    await kirimTeks(`✅ <code>${nomor}</code> dihapus dari blacklist.`);
    logger.info("Bot-Config", `Blacklist hapus: ${nomor}`);
  }

  // /setjeda lambat|normal|cepat
  else if (teks.startsWith("/setjeda ")) {
    const nilai = teks.replace("/setjeda ", "").trim();
    if (!["lambat", "normal", "cepat"].includes(nilai)) {
      await kirimTeks("❌ Pilihan: lambat, normal, cepat");
      return;
    }
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    cfg.queueSettings.typingSpeed = nilai;
    simpanConfig(cfg);
    queue.updateSettings({ typingSpeed: nilai });
    await kirimTeks(`✅ Kecepatan mengetik diset ke <b>${nilai}</b>.`);
  }

  // /setrandom on|off
  else if (teks.startsWith("/setrandom ")) {
    const nilai = teks.replace("/setrandom ", "").trim();
    if (!["on", "off"].includes(nilai)) {
      await kirimTeks("❌ Pilihan: on atau off");
      return;
    }
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    cfg.queueSettings.randomDelay = nilai === "on";
    simpanConfig(cfg);
    queue.updateSettings({ randomDelay: nilai === "on" });
    await kirimTeks(`✅ Jeda random: <b>${nilai.toUpperCase()}</b>.`);
  }

  // /setminjeda detik
  else if (teks.startsWith("/setminjeda ")) {
    const nilai = parseInt(teks.replace("/setminjeda ", "").trim());
    if (isNaN(nilai) || nilai < 1) {
      await kirimTeks("❌ Masukkan angka detik yang valid (minimal 1).");
      return;
    }
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    cfg.queueSettings.minDelay = nilai;
    simpanConfig(cfg);
    queue.updateSettings({ minDelay: nilai });
    await kirimTeks(`✅ Minimum jeda diset ke <b>${nilai} detik</b>.`);
  }

  // /setmaxjeda detik
  else if (teks.startsWith("/setmaxjeda ")) {
    const nilai = parseInt(teks.replace("/setmaxjeda ", "").trim());
    if (isNaN(nilai) || nilai < 1) {
      await kirimTeks("❌ Masukkan angka detik yang valid.");
      return;
    }
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    cfg.queueSettings.maxDelay = nilai;
    simpanConfig(cfg);
    queue.updateSettings({ maxDelay: nilai });
    await kirimTeks(`✅ Maximum jeda diset ke <b>${nilai} detik</b>.`);
  }

  // /aktifkan namaWA
  else if (teks.startsWith("/aktifkan ")) {
    const namaWa = teks.replace("/aktifkan ", "").trim();
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    cfg.activeAccounts[namaWa] = true;
    simpanConfig(cfg);
    await kirimTeks(`✅ <b>${namaWa}</b> diaktifkan.`);
  }

  // /nonaktifkan namaWA
  else if (teks.startsWith("/nonaktifkan ")) {
    const namaWa = teks.replace("/nonaktifkan ", "").trim();
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    cfg.activeAccounts[namaWa] = false;
    simpanConfig(cfg);
    await kirimTeks(`✅ <b>${namaWa}</b> dinonaktifkan.`);
  }

  // /pengaturan
  else if (teks === "/pengaturan") {
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    const qs = cfg.queueSettings;
    await kirimTeks(
      `⚙️ <b>Pengaturan Saat Ini</b>\n\n` +
      `<b>Antrian:</b>\n` +
      `• Kecepatan: ${qs.typingSpeed}\n` +
      `• Jeda random: ${qs.randomDelay ? "ON" : "OFF"}\n` +
      `• Min jeda: ${qs.minDelay} detik\n` +
      `• Max jeda: ${qs.maxDelay} detik\n\n` +
      `<b>Blacklist:</b> ${cfg.blacklist.length} nomor\n\n` +
      `<b>Akun WA:</b>\n` +
      Object.entries(cfg.activeAccounts)
        .map(([id, aktif]) => `• ${id}: ${aktif ? "✅ Aktif" : "❌ Nonaktif"}`)
        .join("\n") || "Tidak ada"
    );
  }

  // /healthcheck
  else if (teks === "/healthcheck") {
    const waStatus = waManager.getStatus();
    const qStatus = queue.getStatus();
    const daftar = Object.entries(waStatus)
      .map(([id, s]) => `• ${id}: ${s.status === "connected" ? "✅" : "❌"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA";

    await kirimTeks(
      `🏥 <b>Health Check</b>\n\n` +
      `<b>WA Accounts:</b>\n${daftar}\n\n` +
      `<b>Antrian:</b>\n` +
      `• Pesan menunggu: ${qStatus.panjangAntrian}\n` +
      `• Sedang proses: ${qStatus.sedangProses ? "Ya" : "Tidak"}`
    );
  }
}

module.exports = { prosesPerintah, kirimTeks };
