"use strict";
/**
 * FILE: bots/bot-pool.js
 * FUNGSI: Perintah HR per slot WA (multi-bot pool)
 * DIGUNAKAN OLEH: index.js (webhook /webhook/pool/:poolId)
 * MENGGUNAKAN: database.js, notif-handler.js, queue.js, wa-manager.js
 * DEPENDENCY MAP:
 *   Setiap slot pool punya token bot sendiri
 *   Mengubah nama fungsi database.js AKAN mempengaruhi file ini
 */

const fs     = require("fs");
const db     = require("../core/database");
const notif  = require("../handlers/notif-handler");
const queue  = require("../services/queue");
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
function getAdminId() { return getConfig().adminTelegramId; }

async function kirimKeSlot(token, chatId, teks) {
  await notif.kirimTeks(token, chatId, teks);
}

const STATUS_MAP = {
  baru:"🆕 Baru", perlu_dibalas:"🔔 Perlu dibalas",
  menunggu:"⏳ Menunggu reply", selesai:"✅ Selesai", tidak_aktif:"❌ Tidak aktif",
};
const PERINTAH_KHUSUS = ["dc","lihat","selesai","status","antrian","start","fixjid","bersihkanantrian"];

async function prosesPerintahPool(msg, poolId) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  const cfg    = getConfig();
  const adminId= String(getAdminId());
  if (fromId !== adminId) return;

  const slotConfig = cfg.botPool?.find((p) => p.id === poolId);
  if (!slotConfig) return;

  // Cari slot di database
  const slot = await db.getSlotByWaId(slotConfig.waId || "");
  const token = slotConfig.token;
  if (!token) return;

  async function kirim(teks) { await kirimKeSlot(token, adminId, teks); }

  if (teks === "/start") {
    await kirim(
      `<b>${slotConfig.nama} aktif!</b>\n📱 WA: <b>${slotConfig.waId || "Belum ada WA"}</b>\n\n` +
      `<b>Perintah:</b>\n/[id] pesan — Balas kandidat\n/dc — Daftar chat\n` +
      `/lihat [id] — Detail kandidat\n/selesai [id] — Tandai selesai\n` +
      `/status — Status WA\n/antrian — Status antrian`
    );
    return;
  }

  if (teks === "/status") {
    const ws = waManager?.getStatus() || {};
    const s  = slotConfig.waId ? ws[slotConfig.waId] : null;
    await kirim(
      `<b>Status ${slotConfig.nama}</b>\n\nWA: ${slotConfig.waId||"Belum ada"}\n` +
      `Koneksi: ${s?(s.status==="connected"?"✅ Terhubung":"❌ Terputus"):"—"}\n` +
      `Nomor: ${s?.jid?.replace(/@.*/,"") || "—"}`
    );
    return;
  }

  if (teks === "/antrian") {
    const s = await queue.getStatus();
    await kirim(`<b>Status Antrian</b>\n\nMenunggu: ${s.panjangAntrian}\nProses: ${s.sedangProses?"Ya":"Tidak"}\n\n<i>Bersihkan: /bersihkanantrian</i>`);
    return;
  }

  if (teks === "/bersihkanantrian") {
    const j = await queue.bersihkanAntrian();
    await kirim(`✅ Antrian dibersihkan — ${j} pesan dihapus.`);
    return;
  }

  if (teks === "/dc") {
    if (!slotConfig.waId) { await kirim("Belum ada WA yang terhubung ke slot ini."); return; }
    const daftar = await db.getDaftarKandidat({ waId: slotConfig.waId, limit: 20 });
    if (!daftar.length) { await kirim("Belum ada chat untuk WA ini."); return; }
    const perlu    = daftar.filter((c) => c.status === "perlu_dibalas");
    const menunggu = daftar.filter((c) => c.status === "menunggu");
    let out = `<b>📊 Chat ${slotConfig.nama}</b>\n\n🔔 Perlu dibalas: <b>${perlu.length}</b>\n⏳ Menunggu: <b>${menunggu.length}</b>\nTotal: ${daftar.length}\n\n`;
    for (const c of perlu.slice(0,5)) out+=`<b>[${c.id}]</b> ${c.nama} — ${c.jid?.replace(/@.*/,"")}\n`;
    await kirim(out);
    return;
  }

  if (teks.startsWith("/lihat ")) {
    const id = teks.replace("/lihat ","").trim().toUpperCase();
    const k  = await db.getKandidat(id);
    if (!k || k.wa_id !== slotConfig.waId) { await kirim(`❌ Chat [${id}] tidak ditemukan.`); return; }
    await kirim(`<b>👤 [${id}] ${k.nama}</b>\n📞 ${k.jid?.replace(/@.*/,"")}\nStatus: ${STATUS_MAP[k.status]||k.status}\n\n💬 "${k.pesan_terakhir?.slice(0,100)||""}"`);
    return;
  }

  if (teks.startsWith("/fixjid ")) {
    const b = teks.replace("/fixjid ","").trim().split(" ");
    if (b.length!==2) { await kirim("❌ Format: /fixjid [id] [nomor]"); return; }
    const id=b[0].toUpperCase(), nomorBaru=b[1].trim().replace(/[^0-9]/g,"");
    const k=await db.getKandidat(id);
    if (!k) { await kirim(`❌ Chat [${id}] tidak ditemukan.`); return; }
    const jidLama=k.jid;
    await db.updateKandidat(id,{jid:`${nomorBaru}@s.whatsapp.net`});
    await kirim(`✅ JID [${id}] ${k.nama} diperbaiki!\n\nLama: <code>${jidLama.replace(/@.*/,"")}</code>\nBaru: <code>${nomorBaru}</code>\n\nCoba balas lagi: /${id} pesanmu`);
    return;
  }

  if (teks.startsWith("/selesai ")) {
    const id=teks.replace("/selesai ","").trim().toUpperCase();
    const k=await db.getKandidat(id);
    if (!k || k.wa_id!==slotConfig.waId) { await kirim(`❌ Chat [${id}] tidak ditemukan.`); return; }
    await db.updateKandidat(id,{status:"selesai"});
    await kirim(`✅ [${id}] ${k.nama} ditandai selesai.`);
    return;
  }

  // Balas: /[id] pesanmu
  const matchBalas=teks.match(/^\/([A-Za-z]+)\s+(.+)$/s);
  if (matchBalas) {
    const idRaw=matchBalas[1].toLowerCase(), idUpper=matchBalas[1].toUpperCase(), pesan=matchBalas[2].trim();
    if (PERINTAH_KHUSUS.includes(idRaw)) return;
    const k=await db.getKandidat(idUpper);
    if (!k || k.wa_id!==slotConfig.waId) { await kirim(`❌ Chat [${idUpper}] tidak ditemukan di ${slotConfig.nama}.`); return; }
    const aktif=await waManager?.cekNomorAktif(k.wa_id,k.jid);
    if (!aktif) {
      await db.updateKandidat(idUpper,{status:"tidak_aktif"});
      await kirim(`❌ Nomor ${k.jid.replace(/@.*/,"")} tidak aktif di WhatsApp.`);
      return;
    }
    await queue.tambahKeAntrian(k.wa_id,k.jid,pesan,null,k.panjang_pesan||0);
    await db.updateKandidat(idUpper,{status:"menunggu",waktuBalas:Date.now()});
    await kirim(`✅ Pesan ke <b>${k.nama}</b> [${idUpper}] masuk antrian.`);
    logger.info("Bot-Pool",`Balas [${idUpper}] via ${slotConfig.nama}`);
  }
}

module.exports = { prosesPerintahPool, setWaManager };
