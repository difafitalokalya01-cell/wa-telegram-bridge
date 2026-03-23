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
  const data = {
    waAccounts: cfg.waAccounts || {},
    activeAccounts: cfg.activeAccounts || {},
    blacklist: cfg.blacklist || [],
    queueSettings: cfg.queueSettings,
  };
  fs.writeFileSync("./auth_sessions/data.json", JSON.stringify(data, null, 2));
}

async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const fromId = String(msg.from?.id);

  if (fromId !== String(ADMIN_ID)) {
    await kirimTeks("Kamu tidak punya akses.");
    return;
  }

  // /start
  if (teks === "/start") {
    await kirimTeks(
      `<b>Bot Konfigurasi</b>\n\n` +
      `<b>Blacklist:</b>\n` +
      `/blacklist - Lihat daftar\n` +
      `/tambahblacklist 628xxx - Tambah nomor\n` +
      `/hapusblacklist 628xxx - Hapus nomor\n\n` +
      `<b>Jeda Baca (detik):</b>\n` +
      `/setjedabaca pendek 30 60\n` +
      `/setjedabaca sedang 60 180\n` +
      `/setjedabaca panjang 180 420\n\n` +
      `<b>Jeda Pikir (detik):</b>\n` +
      `/setjedapikir 30 600\n\n` +
      `<b>Jeda Pindah Chat (detik):</b>\n` +
      `/setjedachat 120 480\n\n` +
      `<b>Jeda Ketik:</b>\n` +
      `/setjedaketik lambat|normal|cepat\n` +
      `/setrandom on|off\n` +
      `/setminjeda detik\n` +
      `/setmaxjeda detik\n\n` +
      `<b>Akun WA:</b>\n` +
      `/aktifkan namaWA\n` +
      `/nonaktifkan namaWA\n\n` +
      `<b>Info:</b>\n` +
      `/pengaturan - Lihat semua pengaturan\n` +
      `/healthcheck - Cek status sistem`
    );
  }

  // /blacklist
  else if (teks === "/blacklist") {
    const cfg = global.loadConfig();
    const list = cfg.blacklist || [];
    if (list.length === 0) {
      await kirimTeks("Blacklist kosong.");
      return;
    }
    await kirimTeks(`<b>Blacklist (${list.length}):</b>\n\n` + list.map((n) => `- <code>${n}</code>`).join("\n"));
  }

  // /tambahblacklist 628xxx
  else if (teks.startsWith("/tambahblacklist ")) {
    const nomor = teks.replace("/tambahblacklist ", "").trim();
    const cfg = global.loadConfig();
    if (cfg.blacklist.includes(nomor)) {
      await kirimTeks(`${nomor} sudah ada di blacklist.`);
      return;
    }
    cfg.blacklist.push(nomor);
    simpanConfig(cfg);
    await kirimTeks(`<code>${nomor}</code> ditambahkan ke blacklist.`);
    logger.info("Bot-Config", `Blacklist tambah: ${nomor}`);
  }

  // /hapusblacklist 628xxx
  else if (teks.startsWith("/hapusblacklist ")) {
    const nomor = teks.replace("/hapusblacklist ", "").trim();
    const cfg = global.loadConfig();
    const idx = cfg.blacklist.indexOf(nomor);
    if (idx === -1) {
      await kirimTeks(`${nomor} tidak ada di blacklist.`);
      return;
    }
    cfg.blacklist.splice(idx, 1);
    simpanConfig(cfg);
    await kirimTeks(`<code>${nomor}</code> dihapus dari blacklist.`);
  }

  // /setjedabaca pendek|sedang|panjang min max
  else if (teks.startsWith("/setjedabaca ")) {
    const bagian = teks.replace("/setjedabaca ", "").trim().split(" ");
    if (bagian.length !== 3) {
      await kirimTeks("Format: /setjedabaca pendek|sedang|panjang min max\nContoh: /setjedabaca pendek 30 60");
      return;
    }
    const tipe = bagian[0].toLowerCase();
    const min = parseInt(bagian[1]);
    const max = parseInt(bagian[2]);

    if (!["pendek", "sedang", "panjang"].includes(tipe) || isNaN(min) || isNaN(max) || min >= max) {
      await kirimTeks("Input tidak valid. Pastikan min < max dan tipe adalah pendek/sedang/panjang.");
      return;
    }

    const cfg = global.loadConfig();
    if (!cfg.queueSettings.readDelay) cfg.queueSettings.readDelay = {};
    cfg.queueSettings.readDelay[tipe] = { min, max };
    simpanConfig(cfg);

    const keyMap = { pendek: "readDelayShort", sedang: "readDelayMedium", panjang: "readDelayLong" };
    queue.updateSettings({ [keyMap[tipe]]: { min, max } });

    await kirimTeks(`Jeda baca <b>${tipe}</b> diset: ${min}-${max} detik.`);
    logger.info("Bot-Config", `Jeda baca ${tipe}: ${min}-${max}s`);
  }

  // /setjedapikir min max
  else if (teks.startsWith("/setjedapikir ")) {
    const bagian = teks.replace("/setjedapikir ", "").trim().split(" ");
    if (bagian.length !== 2) {
      await kirimTeks("Format: /setjedapikir min max\nContoh: /setjedapikir 120 300");
      return;
    }
    const min = parseInt(bagian[0]);
    const max = parseInt(bagian[1]);

    if (isNaN(min) || isNaN(max) || min >= max) {
      await kirimTeks("Input tidak valid. Pastikan min < max.");
      return;
    }

    const cfg = global.loadConfig();
    cfg.queueSettings.thinkDelayMin = min;
    cfg.queueSettings.thinkDelayMax = max;
    simpanConfig(cfg);
    queue.updateSettings({ thinkDelayMin: min, thinkDelayMax: max });

    await kirimTeks(`Jeda pikir diset: ${min}-${max} detik (${Math.floor(min/60)}-${Math.floor(max/60)} menit).`);
    logger.info("Bot-Config", `Jeda pikir: ${min}-${max}s`);
  }

  // /setjedachat min max
  else if (teks.startsWith("/setjedachat ")) {
    const bagian = teks.replace("/setjedachat ", "").trim().split(" ");
    if (bagian.length !== 2) {
      await kirimTeks("Format: /setjedachat min max\nContoh: /setjedachat 120 480");
      return;
    }
    const min = parseInt(bagian[0]);
    const max = parseInt(bagian[1]);

    if (isNaN(min) || isNaN(max) || min >= max) {
      await kirimTeks("Input tidak valid. Pastikan min < max.");
      return;
    }

    const cfg = global.loadConfig();
    cfg.queueSettings.switchChatDelayMin = min;
    cfg.queueSettings.switchChatDelayMax = max;
    simpanConfig(cfg);
    queue.updateSettings({ switchChatDelayMin: min, switchChatDelayMax: max });

    await kirimTeks(`Jeda pindah chat diset: ${min}-${max} detik (${Math.floor(min/60)}-${Math.floor(max/60)} menit).`);
    logger.info("Bot-Config", `Jeda pindah chat: ${min}-${max}s`);
  }

  // /setjedaketik lambat|normal|cepat
  else if (teks.startsWith("/setjedaketik ")) {
    const nilai = teks.replace("/setjedaketik ", "").trim();
    if (!["lambat", "normal", "cepat"].includes(nilai)) {
      await kirimTeks("Pilihan: lambat, normal, cepat");
      return;
    }
    const cfg = global.loadConfig();
    cfg.queueSettings.typingSpeed = nilai;
    simpanConfig(cfg);
    queue.updateSettings({ typingSpeed: nilai });
    await kirimTeks(`Kecepatan mengetik diset ke <b>${nilai}</b>.`);
  }

  // /setrandom on|off
  else if (teks.startsWith("/setrandom ")) {
    const nilai = teks.replace("/setrandom ", "").trim();
    if (!["on", "off"].includes(nilai)) {
      await kirimTeks("Pilihan: on atau off");
      return;
    }
    const cfg = global.loadConfig();
    cfg.queueSettings.randomDelay = nilai === "on";
    simpanConfig(cfg);
    queue.updateSettings({ randomDelay: nilai === "on" });
    await kirimTeks(`Jeda random: <b>${nilai.toUpperCase()}</b>.`);
  }

  // /setminjeda detik
  else if (teks.startsWith("/setminjeda ")) {
    const nilai = parseInt(teks.replace("/setminjeda ", "").trim());
    if (isNaN(nilai) || nilai < 1) {
      await kirimTeks("Masukkan angka detik yang valid (minimal 1).");
      return;
    }
    const cfg = global.loadConfig();
    cfg.queueSettings.minDelay = nilai;
    simpanConfig(cfg);
    queue.updateSettings({ minDelay: nilai });
    await kirimTeks(`Minimum jeda ketik diset ke <b>${nilai} detik</b>.`);
  }

  // /setmaxjeda detik
  else if (teks.startsWith("/setmaxjeda ")) {
    const nilai = parseInt(teks.replace("/setmaxjeda ", "").trim());
    if (isNaN(nilai) || nilai < 1) {
      await kirimTeks("Masukkan angka detik yang valid.");
      return;
    }
    const cfg = global.loadConfig();
    cfg.queueSettings.maxDelay = nilai;
    simpanConfig(cfg);
    queue.updateSettings({ maxDelay: nilai });
    await kirimTeks(`Maximum jeda ketik diset ke <b>${nilai} detik</b>.`);
  }

  // /aktifkan namaWA
  else if (teks.startsWith("/aktifkan ")) {
    const namaWa = teks.replace("/aktifkan ", "").trim();
    const cfg = global.loadConfig();
    cfg.activeAccounts[namaWa] = true;
    simpanConfig(cfg);
    await kirimTeks(`<b>${namaWa}</b> diaktifkan.`);
  }

  // /nonaktifkan namaWA
  else if (teks.startsWith("/nonaktifkan ")) {
    const namaWa = teks.replace("/nonaktifkan ", "").trim();
    const cfg = global.loadConfig();
    cfg.activeAccounts[namaWa] = false;
    simpanConfig(cfg);
    await kirimTeks(`<b>${namaWa}</b> dinonaktifkan.`);
  }

  // /pengaturan
  else if (teks === "/pengaturan") {
    const cfg = global.loadConfig();
    const qs = cfg.queueSettings;
    const rd = qs.readDelay || {};

    await kirimTeks(
      `<b>Pengaturan Saat Ini</b>\n\n` +
      `<b>Jeda Baca:</b>\n` +
      `- Pendek: ${qs.readDelayShort?.min || rd.pendek?.min || 30}-${qs.readDelayShort?.max || rd.pendek?.max || 60} detik\n` +
      `- Sedang: ${qs.readDelayMedium?.min || rd.sedang?.min || 60}-${qs.readDelayMedium?.max || rd.sedang?.max || 180} detik\n` +
      `- Panjang: ${qs.readDelayLong?.min || rd.panjang?.min || 180}-${qs.readDelayLong?.max || rd.panjang?.max || 420} detik\n\n` +
      `<b>Jeda Pikir:</b>\n` +
      `- Min: ${qs.thinkDelayMin || 120} detik (${Math.floor((qs.thinkDelayMin || 120)/60)} menit)\n` +
      `- Max: ${qs.thinkDelayMax || 300} detik (${Math.floor((qs.thinkDelayMax || 300)/60)} menit)\n\n` +
      `<b>Jeda Pindah Chat:</b>\n` +
      `- Min: ${qs.switchChatDelayMin || 120} detik\n` +
      `- Max: ${qs.switchChatDelayMax || 480} detik\n\n` +
      `<b>Jeda Ketik:</b>\n` +
      `- Kecepatan: ${qs.typingSpeed || "normal"}\n` +
      `- Random: ${qs.randomDelay ? "ON" : "OFF"}\n` +
      `- Min: ${qs.minDelay || 3} detik\n` +
      `- Max: ${qs.maxDelay || 10} detik\n\n` +
      `<b>Blacklist:</b> ${(cfg.blacklist || []).length} nomor\n\n` +
      `<b>Akun WA:</b>\n` +
      Object.entries(cfg.activeAccounts || {})
        .map(([id, aktif]) => `- ${id}: ${aktif ? "Aktif" : "Nonaktif"}`)
        .join("\n") || "Tidak ada"
    );
  }

  // /healthcheck
  else if (teks === "/healthcheck") {
    const waStatus = waManager.getStatus();
    const qStatus = queue.getStatus();
    const daftar = Object.entries(waStatus)
      .map(([id, s]) => `- ${id}: ${s.status === "connected" ? "Terhubung" : "Terputus"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA";

    await kirimTeks(
      `<b>Health Check</b>\n\n` +
      `<b>WA Accounts:</b>\n${daftar}\n\n` +
      `<b>Antrian:</b>\n` +
      `- Pesan menunggu: ${qStatus.panjangAntrian}\n` +
      `- Sedang proses: ${qStatus.sedangProses ? "Ya" : "Tidak"}`
    );
  }
}

module.exports = { prosesPerintah, kirimTeks };