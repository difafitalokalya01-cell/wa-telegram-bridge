"use strict";
/**
 * FILE: bots/bot-config.js
 * FUNGSI: Konfigurasi sistem via Telegram (blacklist, queue settings, bot pool)
 * DIGUNAKAN OLEH: index.js (webhook /webhook/config)
 * MENGGUNAKAN: core/database.js, handlers/notif-handler.js, services/queue.js
 */

const fs     = require("fs");
const db     = require("../core/database");
const notif  = require("../handlers/notif-handler");
const queue  = require("../services/queue");
const logger = require("../logger");

let _config = null;
function getConfig() {
  if (!_config) {
    try {
      _config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    } catch(e) {
      logger.error("Config", `Gagal baca config.json: ${e.message}`);
      _config = {};
    }
  }
  return _config;
}
function getToken()   { return getConfig().botConfigToken; }
function getAdminId() { return getConfig().adminTelegramId; }

async function kirimTeks(teks) {
  await notif.kirimTeks(getToken(), getAdminId(), teks);
}

async function prosesPerintah(msg) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  if (teks === "/start") {
    await kirimTeks(
      `<b>Bot Config aktif!</b>\n\n` +
      `<b>Blacklist:</b>\n/blacklist — Daftar blacklist\n` +
      `/tambahblacklist [nomor] — Tambah ke blacklist\n` +
      `/hapusblacklist [nomor] — Hapus dari blacklist\n\n` +
      `<b>Antrian:</b>\n/pengaturanantrian — Lihat pengaturan\n` +
      `/setatrian lambat|normal|cepat — Ubah kecepatan ketik\n\n` +
      `<b>Pool:</b>\n/pool — Status bot pool`
    );
    return;
  }

  if (teks === "/blacklist") {
    const daftar = await db.getDaftarBlacklist();
    if (!daftar.length) { await kirimTeks("Blacklist kosong."); return; }
    const out = daftar.map((b)=>`• <code>${b.nomor}</code>${b.alasan?` — ${b.alasan}`:""}`).join("\n");
    await kirimTeks(`<b>📋 Blacklist (${daftar.length})</b>\n\n${out}`);
    return;
  }

  if (teks.startsWith("/tambahblacklist ")) {
    const b = teks.replace("/tambahblacklist ","").trim().split(" ");
    const nomor=b[0].replace(/[^0-9]/g,""), alasan=b.slice(1).join(" ")||"";
    if (!nomor) { await kirimTeks("❌ Format: /tambahblacklist [nomor] [alasan opsional]"); return; }
    await db.tambahBlacklist(nomor, alasan);
    await kirimTeks(`✅ <code>${nomor}</code> ditambahkan ke blacklist.`);
    return;
  }

  if (teks.startsWith("/hapusblacklist ")) {
    const nomor = teks.replace("/hapusblacklist ","").trim().replace(/[^0-9]/g,"");
    if (!nomor) { await kirimTeks("❌ Format: /hapusblacklist [nomor]"); return; }
    await db.hapusBlacklist(nomor);
    await kirimTeks(`✅ <code>${nomor}</code> dihapus dari blacklist.`);
    return;
  }

  if (teks === "/pool") {
    const cfg = getConfig();
    const pool = cfg.botPool || [];
    if (!pool.length) { await kirimTeks("Belum ada bot pool dikonfigurasi."); return; }
    let out = `<b>📊 Status Bot Pool</b>\n\n`;
    for (const p of pool) {
      out+=`<b>${p.nama}</b> (${p.id})\nToken: ${p.token?"✅":"❌"}\n\n`;
    }
    await kirimTeks(out);
    return;
  }

  if (teks === "/pengaturanantrian") {
    await kirimTeks(
      `<b>Pengaturan Antrian</b>\n\n` +
      `Gunakan /setatrian untuk mengubah kecepatan ketik:\n` +
      `/setatrian lambat — ~30 karakter/detik\n` +
      `/setatrian normal — ~50 karakter/detik\n` +
      `/setatrian cepat  — ~80 karakter/detik`
    );
    return;
  }

  if (teks.startsWith("/setatrian ")) {
    const kecepatan = teks.replace("/setatrian ","").trim().toLowerCase();
    if (!["lambat","normal","cepat"].includes(kecepatan)) {
      await kirimTeks("❌ Pilihan: lambat | normal | cepat");
      return;
    }
    queue.updateSettings({ typingSpeed: kecepatan });
    await kirimTeks(`✅ Kecepatan ketik diubah ke: <b>${kecepatan}</b>`);
    return;
  }
}

// ── PATCH: Tambah perintah yang hilang dari versi lama ─────────
const _prosesPerintahLama = prosesPerintah;
async function prosesPerintahLengkap(msg) {
  // Jalankan handler lama dulu
  await _prosesPerintahLama(msg);

  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  // /pengaturan — lihat semua pengaturan delay
  if (teks === "/pengaturan") {
    const cfg = getConfig();
    const qs  = cfg.queueSettings || {};
    await kirimTeks(
      `<b>⚙️ Pengaturan Sistem</b>\n\n` +
      `<b>Delay Antrian:</b>\n` +
      `Kecepatan ketik: <b>${qs.typingSpeed || "normal"}</b>\n` +
      `Random delay: <b>${qs.randomDelay ? "On" : "Off"}</b>\n` +
      `Min jeda: <b>${qs.minDelay || 3}s</b>\n` +
      `Max jeda: <b>${qs.maxDelay || 10}s</b>\n\n` +
      `<b>Jeda Baca:</b>\n` +
      `Pendek (<50 kar): ${qs.readDelayShort?.min||30}–${qs.readDelayShort?.max||60}s\n` +
      `Sedang (50-200):  ${qs.readDelayMedium?.min||60}–${qs.readDelayMedium?.max||180}s\n` +
      `Panjang (>200):   ${qs.readDelayLong?.min||180}–${qs.readDelayLong?.max||420}s\n\n` +
      `<b>Jeda Pikir:</b> ${qs.thinkDelayMin||120}–${qs.thinkDelayMax||300}s\n` +
      `<b>Jeda Pindah Chat:</b> ${qs.switchChatDelayMin||120}–${qs.switchChatDelayMax||480}s\n\n` +
      `<b>Ubah pengaturan:</b>\n` +
      `/setjedabaca [min] [max] [min2] [max2] [min3] [max3]\n` +
      `/setjedapikir [min] [max]\n` +
      `/setjedachat [min] [max]\n` +
      `/setrandom on|off\n` +
      `/setminjeda [detik]\n` +
      `/setmaxjeda [detik]`
    );
    return;
  }

  // /healthcheck — cek status sistem
  if (teks === "/healthcheck") {
    try {
      const [dbOk, cacheOk] = await Promise.allSettled([
        require("../core/database").ping(),
        require("../core/cache").ping(),
      ]);
      await kirimTeks(
        `<b>🏥 Health Check</b>\n\n` +
        `Database: ${dbOk.status==="fulfilled" && dbOk.value ? "✅ OK" : "❌ Error"}\n` +
        `Cache: ${cacheOk.status==="fulfilled" && cacheOk.value ? "✅ OK" : "❌ Error"}\n` +
        `Uptime: ${Math.floor(process.uptime()/60)} menit`
      );
    } catch(err) {
      await kirimTeks(`❌ Health check gagal: ${err.message}`);
    }
    return;
  }

  // /setjedabaca min max min2 max2 min3 max3
  if (teks.startsWith("/setjedabaca ")) {
    const b = teks.replace("/setjedabaca ","").trim().split(" ").map(Number);
    if (b.length !== 6 || b.some(isNaN)) { await kirimTeks("❌ Format: /setjedabaca min1 max1 min2 max2 min3 max3\nContoh: /setjedabaca 30 60 60 180 180 420"); return; }
    const cfg = getConfig();
    cfg.queueSettings = { ...cfg.queueSettings, readDelayShort:{min:b[0],max:b[1]}, readDelayMedium:{min:b[2],max:b[3]}, readDelayLong:{min:b[4],max:b[5]} };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    require("../services/queue").updateSettings(cfg.queueSettings);
    await kirimTeks(`✅ Jeda baca diupdate:\nPendek: ${b[0]}–${b[1]}s\nSedang: ${b[2]}–${b[3]}s\nPanjang: ${b[4]}–${b[5]}s`);
    return;
  }

  // /setjedapikir min max
  if (teks.startsWith("/setjedapikir ")) {
    const b = teks.replace("/setjedapikir ","").trim().split(" ").map(Number);
    if (b.length!==2 || b.some(isNaN)) { await kirimTeks("❌ Format: /setjedapikir min max\nContoh: /setjedapikir 120 300"); return; }
    const cfg = getConfig();
    cfg.queueSettings = { ...cfg.queueSettings, thinkDelayMin:b[0], thinkDelayMax:b[1] };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    require("../services/queue").updateSettings(cfg.queueSettings);
    await kirimTeks(`✅ Jeda pikir: ${b[0]}–${b[1]}s`);
    return;
  }

  // /setjedachat min max
  if (teks.startsWith("/setjedachat ")) {
    const b = teks.replace("/setjedachat ","").trim().split(" ").map(Number);
    if (b.length!==2 || b.some(isNaN)) { await kirimTeks("❌ Format: /setjedachat min max\nContoh: /setjedachat 120 480"); return; }
    const cfg = getConfig();
    cfg.queueSettings = { ...cfg.queueSettings, switchChatDelayMin:b[0], switchChatDelayMax:b[1] };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    require("../services/queue").updateSettings(cfg.queueSettings);
    await kirimTeks(`✅ Jeda pindah chat: ${b[0]}–${b[1]}s`);
    return;
  }

  // /setrandom on|off
  if (teks.startsWith("/setrandom ")) {
    const nilai = teks.replace("/setrandom ","").trim().toLowerCase();
    if (!["on","off"].includes(nilai)) { await kirimTeks("❌ Format: /setrandom on|off"); return; }
    const cfg = getConfig();
    cfg.queueSettings = { ...cfg.queueSettings, randomDelay: nilai==="on" };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    require("../services/queue").updateSettings(cfg.queueSettings);
    await kirimTeks(`✅ Random delay: <b>${nilai.toUpperCase()}</b>`);
    return;
  }

  // /setminjeda detik
  if (teks.startsWith("/setminjeda ")) {
    const val = parseInt(teks.replace("/setminjeda ","").trim());
    if (isNaN(val)) { await kirimTeks("❌ Format: /setminjeda [detik]\nContoh: /setminjeda 3"); return; }
    const cfg = getConfig();
    cfg.queueSettings = { ...cfg.queueSettings, minDelay: val };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    require("../services/queue").updateSettings(cfg.queueSettings);
    await kirimTeks(`✅ Min jeda: <b>${val}s</b>`);
    return;
  }

  // /setmaxjeda detik
  if (teks.startsWith("/setmaxjeda ")) {
    const val = parseInt(teks.replace("/setmaxjeda ","").trim());
    if (isNaN(val)) { await kirimTeks("❌ Format: /setmaxjeda [detik]\nContoh: /setmaxjeda 10"); return; }
    const cfg = getConfig();
    cfg.queueSettings = { ...cfg.queueSettings, maxDelay: val };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    require("../services/queue").updateSettings(cfg.queueSettings);
    await kirimTeks(`✅ Max jeda: <b>${val}s</b>`);
    return;
  }

  // /aktifkan waId
  if (teks.startsWith("/aktifkan ")) {
    const waId = teks.replace("/aktifkan ","").trim();
    await require("../core/database").setWaAktif(waId, true);
    await kirimTeks(`✅ <b>${waId}</b> diaktifkan.`);
    return;
  }

  // /nonaktifkan waId
  if (teks.startsWith("/nonaktifkan ")) {
    const waId = teks.replace("/nonaktifkan ","").trim();
    await require("../core/database").setWaAktif(waId, false);
    await kirimTeks(`✅ <b>${waId}</b> dinonaktifkan.`);
    return;
  }
}

// Override export
module.exports = { prosesPerintah: prosesPerintahLengkap };
