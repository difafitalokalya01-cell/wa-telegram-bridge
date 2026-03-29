"use strict";
/**
 * FILE: bots/bot-wa.js
 * FUNGSI: Manajemen koneksi WA via Telegram (QR, pairing, disconnect)
 * DIGUNAKAN OLEH: index.js (webhook /webhook/wa, setupWaCallbacks)
 * MENGGUNAKAN: core/events.js, core/database.js, handlers/notif-handler.js
 * DEPENDENCY MAP:
 *   Listen event wa:qr_diterima dan wa:pairing_code dari wa-manager
 *   Mengubah format QR tidak mempengaruhi file lain
 */

const fs     = require("fs");
const qrcode = require("qrcode");
const events = require("../core/events");
const db     = require("../core/database");
const notif  = require("../handlers/notif-handler");
const logger = require("../logger");

let waManager = null;
function setWaManager(wm) { waManager = wm; }

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
function getToken()   { return getConfig().botWaToken; }
function getAdminId() { return getConfig().adminTelegramId; }

async function kirimTeks(teks) {
  await notif.kirimTeks(getToken(), getAdminId(), teks);
}

// Setup listener QR dan pairing code dari wa-manager
function setupCallbacks() {
  events.on("wa:qr_diterima", async ({ waId, qr }) => {
    try {
      const qrBuffer = await qrcode.toBuffer(qr, { type: "png", width: 300 });
      await notif.kirimFoto(getToken(), getAdminId(), qrBuffer, `📱 QR Code untuk <b>${waId}</b>\nScan dengan WhatsApp dalam 60 detik`);
      logger.info("Bot-WA", `QR dikirim untuk ${waId}`);
    } catch (err) {
      await kirimTeks(`❌ Gagal generate QR untuk ${waId}: ${err.message}`);
    }
  });

  events.on("wa:pairing_code", async ({ waId, code, nomor, errMsg }) => {
    if (errMsg) {
      await kirimTeks(`❌ Gagal dapat pairing code untuk ${waId}: ${errMsg}`);
    } else {
      await kirimTeks(`🔑 <b>Pairing Code untuk ${waId}</b>\n\nNomor: <code>${nomor}</code>\nKode: <code>${code}</code>\n\nMasukkan kode ini di WhatsApp → Perangkat Tertaut → Tautkan Perangkat`);
    }
  });

  logger.info("Bot-WA", "Callbacks terdaftar ✅");
}

async function prosesPerintah(msg) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  if (teks === "/start") {
    const ws = waManager?.getStatus() || {};
    const waList = Object.entries(ws).map(([id,s])=>`- ${id}: ${s.status==="connected"?"✅":"❌"} ${s.jid?.replace(/@.*/,"")||""}`).join("\n") || "Tidak ada";
    await kirimTeks(
      `<b>Bot WA Management aktif!</b>\n\n` +
      `<b>Status WA:</b>\n${waList}\n\n` +
      `<b>Perintah:</b>\n/hubungkan [waId] — Hubungkan WA baru via QR\n` +
      `/pairing [waId] [nomor] — Hubungkan via pairing code\n` +
      `/putuskan [waId] — Putuskan WA\n/status — Status semua WA`
    );
    return;
  }

  if (teks === "/status") {
    const ws = waManager?.getStatus() || {};
    const daftar = Object.entries(ws).map(([id,s])=>`- ${id}: ${s.status==="connected"?"✅ Terhubung":"❌ Terputus"} | ${s.jid?.replace(/@.*/,"")||"—"}`).join("\n") || "Tidak ada WA terhubung";
    await kirimTeks(`<b>Status WA</b>\n\n${daftar}`);
    return;
  }

  if (teks.startsWith("/hubungkan ")) {
    const waId = teks.replace("/hubungkan ","").trim();
    if (!waId) { await kirimTeks("❌ Format: /hubungkan [waId]\nContoh: /hubungkan wa1"); return; }
    await kirimTeks(`⏳ Menghubungkan ${waId}... QR akan dikirim sebentar.`);
    try {
      await db.setWaAktif(waId, true);
      await waManager?.connectWA(waId, false);
    } catch (err) {
      await kirimTeks(`❌ Gagal hubungkan ${waId}: ${err.message}`);
    }
    return;
  }

  if (teks.startsWith("/pairing ")) {
    const b = teks.replace("/pairing ","").trim().split(" ");
    if (b.length!==2) { await kirimTeks("❌ Format: /pairing [waId] [nomor]\nContoh: /pairing wa1 6281234567890"); return; }
    const waId=b[0], nomor=b[1].replace(/[^0-9]/g,"");
    await kirimTeks(`⏳ Meminta pairing code untuk ${waId} (${nomor})...`);
    try {
      await db.setWaAktif(waId, true);
      await waManager?.connectWA(waId, true, nomor);
    } catch (err) {
      await kirimTeks(`❌ Gagal: ${err.message}`);
    }
    return;
  }

  if (teks.startsWith("/putuskan ")) {
    const waId = teks.replace("/putuskan ","").trim();
    if (!waId) { await kirimTeks("❌ Format: /putuskan [waId]"); return; }
    try {
      await waManager?.disconnectWA(waId);
      await kirimTeks(`✅ ${waId} berhasil diputuskan.`);
    } catch (err) {
      await kirimTeks(`❌ Gagal putuskan ${waId}: ${err.message}`);
    }
    return;
  }
}

module.exports = { prosesPerintah, setupCallbacks, setWaManager };
