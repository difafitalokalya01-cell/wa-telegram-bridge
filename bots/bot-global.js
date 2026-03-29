"use strict";
/**
 * FILE: bots/bot-global.js
 * FUNGSI: Kontrol global semua WA dari satu bot
 * DIGUNAKAN OLEH: index.js (webhook /webhook/global)
 * MENGGUNAKAN: core/database.js, handlers/notif-handler.js, wa-manager.js
 */

const fs     = require("fs");
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
function getToken()   { return getConfig().botGlobalToken; }
function getAdminId() { return getConfig().adminTelegramId; }

async function kirimTeks(teks) {
  await notif.kirimTeks(getToken(), getAdminId(), teks);
}

async function prosesPerintah(msg) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  if (teks === "/start") {
    const ws     = waManager?.getStatus() || {};
    const waList = Object.entries(ws).map(([id,s])=>`- ${id}: ${s.status==="connected"?"✅":"❌"} ${s.jid?.replace(/@.*/,"")||""}`).join("\n") || "Tidak ada";
    await kirimTeks(
      `<b>Bot Global aktif!</b>\n\n` +
      `<b>Status WA:</b>\n${waList}\n\n` +
      `<b>Perintah:</b>\n/status — Status semua WA\n` +
      `/assignpool [poolId] [waId] — Assign WA ke slot pool\n` +
      `/kosongkanpool [poolId] — Kosongkan slot pool\n` +
      `/daftarpool — Lihat semua slot pool`
    );
    return;
  }

  if (teks === "/status") {
    const ws     = waManager?.getStatus() || {};
    const daftar = Object.entries(ws).map(([id,s])=>`- ${id}: ${s.status==="connected"?"✅":"❌"} ${s.jid?.replace(/@.*/,"")||"—"}`).join("\n") || "Tidak ada WA terhubung";
    await kirimTeks(`<b>Status Semua WA</b>\n\n${daftar}`);
    return;
  }

  if (teks === "/daftarpool") {
    const cfg  = getConfig();
    const pool = cfg.botPool || [];
    if (!pool.length) { await kirimTeks("Belum ada bot pool."); return; }
    let out = `<b>📊 Daftar Bot Pool</b>\n\n`;
    for (const p of pool) {
      const slot = await db.getSlotByWaId(p.waId || "dummy_not_found");
      out += `<b>${p.nama}</b> (${p.id})\nWA: ${p.waId || "— kosong"}\n\n`;
    }
    await kirimTeks(out);
    return;
  }

  if (teks.startsWith("/assignpool ")) {
    const b = teks.replace("/assignpool ","").trim().split(" ");
    if (b.length!==2) { await kirimTeks("❌ Format: /assignpool [poolId] [waId]\nContoh: /assignpool pool_1 wa1"); return; }
    const poolId=b[0], waId=b[1];
    await db.updateSlot(poolId, { waId, status: "terisi" });
    const cfg = getConfig();
    const slot = cfg.botPool?.find((p)=>p.id===poolId);
    if (slot) slot.waId = waId;
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    await kirimTeks(`✅ Pool <b>${poolId}</b> diassign ke WA <b>${waId}</b>`);
    return;
  }

  if (teks.startsWith("/kosongkanpool ")) {
    const poolId = teks.replace("/kosongkanpool ","").trim();
    await db.updateSlot(poolId, { waId: null, status: "kosong" });
    const cfg = getConfig();
    const slot = cfg.botPool?.find((p)=>p.id===poolId);
    if (slot) delete slot.waId;
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    await kirimTeks(`✅ Pool <b>${poolId}</b> dikosongkan.`);
    return;
  }
}

// ── PATCH: Tambah fitur yang hilang dari versi lama ────────────
const _prosesLama = prosesPerintah;
async function prosesPerintahLengkap(msg) {
  await _prosesLama(msg);

  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  // /assign [waId] — auto-assign WA ke slot kosong
  if (teks.startsWith("/assign ")) {
    const waId = teks.replace("/assign ","").trim();
    if (!waId) { await kirimTeks("❌ Format: /assign [waId]\nContoh: /assign wa1"); return; }
    const wsStatus = waManager?.getStatus() || {};
    if (!wsStatus[waId]) { await kirimTeks(`❌ WA <b>${waId}</b> tidak ditemukan atau belum terhubung.`); return; }
    const slotAda = await db.getSlotByWaId(waId);
    if (slotAda) { await kirimTeks(`<b>${waId}</b> sudah di slot <b>${slotAda.pool_id}</b>.`); return; }
    const slotKosong = await db.getSlotKosong();
    if (!slotKosong) { await kirimTeks("❌ Tidak ada slot kosong. Tambah bot baru ke pool dulu."); return; }
    await db.updateSlot(slotKosong.pool_id, { waId, status: "terisi" });
    const cfg = getConfig();
    const slotCfg = cfg.botPool?.find((p) => p.id === slotKosong.pool_id);
    if (slotCfg) slotCfg.waId = waId;
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    await kirimTeks(`✅ <b>${waId}</b> berhasil di-assign ke <b>${slotCfg?.nama || slotKosong.pool_id}</b>!`);
    logger.info("Bot-Global", `${waId} di-assign ke ${slotKosong.pool_id}`);
    return;
  }

  // /reset [waId] — kosongkan slot berdasarkan waId
  if (teks.startsWith("/reset ")) {
    const waId = teks.replace("/reset ","").trim();
    const slot  = await db.getSlotByWaId(waId);
    if (!slot) { await kirimTeks(`❌ WA <b>${waId}</b> tidak ada di slot manapun.`); return; }
    await db.updateSlot(slot.pool_id, { waId: null, status: "kosong" });
    const cfg = getConfig();
    const slotCfg = cfg.botPool?.find((p) => p.id === slot.pool_id);
    if (slotCfg) delete slotCfg.waId;
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    await kirimTeks(`✅ Slot <b>${slot.pool_id}</b> dikosongkan dari <b>${waId}</b>.`);
    return;
  }

  // /statuswa — alias untuk /status
  if (teks === "/statuswa") {
    const ws     = waManager?.getStatus() || {};
    const daftar = Object.entries(ws).map(([id,s])=>
      `<b>${id}</b>\nKoneksi: ${s.status==="connected"?"✅ Terhubung":"❌ Terputus"}\nNomor: ${s.jid?.replace(/@.*/,"")||"—"}`
    ).join("\n\n") || "Tidak ada WA terhubung";
    await kirimTeks(`<b>Status Semua WA</b>\n\n${daftar}`);
    return;
  }

  // /daftarchat — ringkasan chat dari bot global
  if (teks === "/daftarchat") {
    const counts = await db.hitungKandidat();
    await kirimTeks(
      `<b>📊 Ringkasan Chat Global</b>\n\n` +
      `🔔 Perlu dibalas: <b>${counts.perlu_dibalas||0}</b>\n` +
      `⏳ Menunggu reply: <b>${counts.menunggu||0}</b>\n` +
      `🆕 Baru: <b>${counts.baru||0}</b>\n` +
      `✅ Selesai: <b>${counts.selesai||0}</b>\n` +
      `❌ Tidak aktif: <b>${counts.tidak_aktif||0}</b>`
    );
    return;
  }
}

module.exports = { prosesPerintah: prosesPerintahLengkap, setWaManager };
