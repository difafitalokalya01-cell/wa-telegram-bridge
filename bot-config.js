const axios     = require("axios");
const logger    = require("./logger");
const queue     = require("./queue");
const waManager = require("./wa-manager");
const store     = require("./store");

function getToken()     { return store.getConfig().botConfigToken; }
function getAdminId()   { return store.getConfig().adminTelegramId; }
function getTelegramApi(){ return `https://api.telegram.org/bot${getToken()}`; }

async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${getTelegramApi()}/sendMessage`, {
      chat_id: getAdminId(), text: teks, parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Config", `Gagal kirim teks: ${err.message}`);
  }
}

async function prosesPerintah(msg) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);

  if (fromId !== String(getAdminId())) {
    await kirimTeks("Kamu tidak punya akses.");
    return;
  }

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
    return;
  }

  if (teks === "/blacklist") {
    const cfg  = store.getConfig();
    const list = cfg.blacklist || [];
    if (list.length === 0) { await kirimTeks("Blacklist kosong."); return; }
    await kirimTeks(`<b>Blacklist (${list.length}):</b>\n\n` + list.map((n) => `- <code>${n}</code>`).join("\n"));
    return;
  }

  if (teks.startsWith("/tambahblacklist ")) {
    const nomor = teks.replace("/tambahblacklist ", "").trim();
    if (!nomor) { await kirimTeks("❌ Masukkan nomor yang valid."); return; }
    const cfg   = store.getConfig();
    if (cfg.blacklist.includes(nomor)) { await kirimTeks(`${nomor} sudah ada di blacklist.`); return; }
    cfg.blacklist.push(nomor);
    await store.saveData(cfg);
    await kirimTeks(`<code>${nomor}</code> ditambahkan ke blacklist.`);
    logger.info("Bot-Config", `Blacklist tambah: ${nomor}`);
    return;
  }

  if (teks.startsWith("/hapusblacklist ")) {
    const nomor = teks.replace("/hapusblacklist ", "").trim();
    const cfg   = store.getConfig();
    const idx   = cfg.blacklist.indexOf(nomor);
    if (idx === -1) { await kirimTeks(`${nomor} tidak ada di blacklist.`); return; }
    cfg.blacklist.splice(idx, 1);
    await store.saveData(cfg);
    await kirimTeks(`<code>${nomor}</code> dihapus dari blacklist.`);
    return;
  }

  if (teks.startsWith("/setjedabaca ")) {
    const bagian = teks.replace("/setjedabaca ", "").trim().split(" ");
    if (bagian.length !== 3) { await kirimTeks("Format: /setjedabaca pendek|sedang|panjang min max\nContoh: /setjedabaca pendek 30 60"); return; }
    const tipe = bagian[0].toLowerCase();
    const min  = parseInt(bagian[1]);
    const max  = parseInt(bagian[2]);
    if (!["pendek", "sedang", "panjang"].includes(tipe) || isNaN(min) || isNaN(max) || min >= max) {
      await kirimTeks("Input tidak valid. Pastikan min < max dan tipe adalah pendek/sedang/panjang.");
      return;
    }
    const cfg    = store.getConfig();
    const keyMap = { pendek: "readDelayShort", sedang: "readDelayMedium", panjang: "readDelayLong" };
    cfg.queueSettings[keyMap[tipe]] = { min, max };
    await store.saveData(cfg);
    queue.updateSettings({ [keyMap[tipe]]: { min, max } });
    await kirimTeks(`Jeda baca <b>${tipe}</b> diset: ${min}-${max} detik.`);
    return;
  }

  if (teks.startsWith("/setjedapikir ")) {
    const bagian = teks.replace("/setjedapikir ", "").trim().split(" ");
    if (bagian.length !== 2) { await kirimTeks("Format: /setjedapikir min max\nContoh: /setjedapikir 120 300"); return; }
    const min = parseInt(bagian[0]);
    const max = parseInt(bagian[1]);
    if (isNaN(min) || isNaN(max) || min >= max) { await kirimTeks("Input tidak valid. Pastikan min < max."); return; }
    const cfg = store.getConfig();
    cfg.queueSettings.thinkDelayMin = min;
    cfg.queueSettings.thinkDelayMax = max;
    await store.saveData(cfg);
    queue.updateSettings({ thinkDelayMin: min, thinkDelayMax: max });
    await kirimTeks(`Jeda pikir diset: ${min}-${max} detik (${Math.floor(min/60)}-${Math.floor(max/60)} menit).`);
    return;
  }

  if (teks.startsWith("/setjedachat ")) {
    const bagian = teks.replace("/setjedachat ", "").trim().split(" ");
    if (bagian.length !== 2) { await kirimTeks("Format: /setjedachat min max\nContoh: /setjedachat 120 480"); return; }
    const min = parseInt(bagian[0]);
    const max = parseInt(bagian[1]);
    if (isNaN(min) || isNaN(max) || min >= max) { await kirimTeks("Input tidak valid. Pastikan min < max."); return; }
    const cfg = store.getConfig();
    cfg.queueSettings.switchChatDelayMin = min;
    cfg.queueSettings.switchChatDelayMax = max;
    await store.saveData(cfg);
    queue.updateSettings({ switchChatDelayMin: min, switchChatDelayMax: max });
    await kirimTeks(`Jeda pindah chat diset: ${min}-${max} detik.`);
    return;
  }

  if (teks.startsWith("/setjedaketik ")) {
    const nilai = teks.replace("/setjedaketik ", "").trim();
    if (!["lambat", "normal", "cepat"].includes(nilai)) { await kirimTeks("Pilihan: lambat, normal, cepat"); return; }
    const cfg = store.getConfig();
    cfg.queueSettings.typingSpeed = nilai;
    await store.saveData(cfg);
    queue.updateSettings({ typingSpeed: nilai });
    await kirimTeks(`Kecepatan mengetik diset ke <b>${nilai}</b>.`);
    return;
  }

  if (teks.startsWith("/setrandom ")) {
    const nilai = teks.replace("/setrandom ", "").trim();
    if (!["on", "off"].includes(nilai)) { await kirimTeks("Pilihan: on atau off"); return; }
    const cfg = store.getConfig();
    cfg.queueSettings.randomDelay = nilai === "on";
    await store.saveData(cfg);
    queue.updateSettings({ randomDelay: nilai === "on" });
    await kirimTeks(`Jeda random: <b>${nilai.toUpperCase()}</b>.`);
    return;
  }

  if (teks.startsWith("/setminjeda ")) {
    const nilai = parseInt(teks.replace("/setminjeda ", "").trim());
    if (isNaN(nilai) || nilai < 1) { await kirimTeks("Masukkan angka detik yang valid (minimal 1)."); return; }
    const cfg = store.getConfig();
    cfg.queueSettings.minDelay = nilai;
    await store.saveData(cfg);
    queue.updateSettings({ minDelay: nilai });
    await kirimTeks(`Minimum jeda ketik diset ke <b>${nilai} detik</b>.`);
    return;
  }

  if (teks.startsWith("/setmaxjeda ")) {
    const nilai = parseInt(teks.replace("/setmaxjeda ", "").trim());
    if (isNaN(nilai) || nilai < 1) { await kirimTeks("Masukkan angka detik yang valid."); return; }
    const cfg = store.getConfig();
    cfg.queueSettings.maxDelay = nilai;
    await store.saveData(cfg);
    queue.updateSettings({ maxDelay: nilai });
    await kirimTeks(`Maximum jeda ketik diset ke <b>${nilai} detik</b>.`);
    return;
  }

  if (teks.startsWith("/aktifkan ")) {
    const namaWa = teks.replace("/aktifkan ", "").trim();
    const cfg    = store.getConfig();
    cfg.activeAccounts[namaWa] = true;
    await store.saveData(cfg);
    await kirimTeks(`<b>${namaWa}</b> diaktifkan.`);
    return;
  }

  if (teks.startsWith("/nonaktifkan ")) {
    const namaWa = teks.replace("/nonaktifkan ", "").trim();
    const cfg    = store.getConfig();
    cfg.activeAccounts[namaWa] = false;
    await store.saveData(cfg);
    await kirimTeks(`<b>${namaWa}</b> dinonaktifkan.`);
    return;
  }

  if (teks === "/pengaturan") {
    const cfg = store.getConfig();
    const qs  = cfg.queueSettings;
    await kirimTeks(
      `<b>Pengaturan Saat Ini</b>\n\n` +
      `<b>Jeda Baca:</b>\n` +
      `- Pendek: ${qs.readDelayShort?.min || 30}-${qs.readDelayShort?.max || 60} detik\n` +
      `- Sedang: ${qs.readDelayMedium?.min || 60}-${qs.readDelayMedium?.max || 180} detik\n` +
      `- Panjang: ${qs.readDelayLong?.min || 180}-${qs.readDelayLong?.max || 420} detik\n\n` +
      `<b>Jeda Pikir:</b>\n` +
      `- Min: ${qs.thinkDelayMin || 120} detik\n` +
      `- Max: ${qs.thinkDelayMax || 300} detik\n\n` +
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
      (Object.entries(cfg.activeAccounts || {}).map(([id, aktif]) => `- ${id}: ${aktif ? "Aktif" : "Nonaktif"}`).join("\n") || "Tidak ada")
    );
    return;
  }

  if (teks === "/healthcheck") {
    const waStatus = waManager.getStatus();
    const qStatus  = queue.getStatus();
    const daftar   = Object.entries(waStatus)
      .map(([id, s]) => `- ${id}: ${s.status === "connected" ? "Terhubung ✅" : "Terputus ❌"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA";
    await kirimTeks(
      `<b>Health Check</b>\n\n` +
      `<b>WA Accounts:</b>\n${daftar}\n\n` +
      `<b>Antrian:</b>\n` +
      `- Pesan menunggu: ${qStatus.panjangAntrian}\n` +
      `- Sedang proses: ${qStatus.sedangProses ? "Ya" : "Tidak"}`
    );
    return;
  }
}

module.exports = { prosesPerintah, kirimTeks };
