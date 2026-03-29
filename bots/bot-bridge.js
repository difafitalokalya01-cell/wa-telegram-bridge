"use strict";
/**
 * FILE: bots/bot-bridge.js
 * FUNGSI: Bot Telegram utama untuk HR
 * DIGUNAKAN OLEH: index.js (webhook /webhook/bridge)
 * MENGGUNAKAN: database.js, notif-handler.js, queue.js, wa-manager.js
 * DEPENDENCY MAP:
 *   Mengubah format perintah tidak mempengaruhi file lain
 *   Mengubah nama fungsi database.js AKAN mempengaruhi file ini
 */

const fs     = require("fs");
const axios  = require("axios");
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
function getToken() {
  const cfg = getConfig();
  return cfg.botBridgeToken || cfg.botPool?.find((p) => p.id === "pool_3")?.token || "";
}
function getChatId()  { return getConfig().telegramChatId; }
function getAdminId() { return getConfig().adminTelegramId; }
function getTelegramApi() { return `https://api.telegram.org/bot${getToken()}`; }

async function kirimTeks(teks) {
  await notif.kirimTeks(getToken(), getChatId(), teks);
}

function formatWaktu(ts) {
  const d = Date.now() - ts, m = Math.floor(d/60000), j = Math.floor(m/60), h = Math.floor(j/24);
  if (h > 0) return `${h} hari lalu`;
  if (j > 0) return `${j} jam lalu`;
  if (m > 0) return `${m} menit lalu`;
  return "baru saja";
}
function formatUrgensi(ts) {
  const m = Math.floor((Date.now()-ts)/60000);
  return m >= 60 ? "🚨" : m >= 30 ? "⚠️" : "";
}
function potong(t, max=60) { return !t ? "" : t.length <= max ? t : t.slice(0,max)+"..."; }

const STATUS_MAP = {
  baru:"🆕 Baru", perlu_dibalas:"🔔 Perlu dibalas",
  menunggu:"⏳ Menunggu reply", selesai:"✅ Selesai", tidak_aktif:"❌ Tidak aktif",
};
const PERINTAH_KHUSUS = [
  "ke","dc","daftarchat","lihat","riwayat","catat","selesai","antrian",
  "status","start","fixjid","kirim","assign","reset","pool","healthcheck",
  "pengaturan","blacklist","tambahblacklist","hapusblacklist","bersihkanantrian",
];

async function prosesPerintah(msg) {
  const teks   = msg.text    || "";
  const caption= msg.caption || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  // Kirim media dari Telegram ke WA
  if (msg.photo || msg.video || msg.document) {
    const match = caption.trim().match(/^\/?([A-Za-z]+)/);
    if (!match) { await kirimTeks("❌ Tambahkan caption ID chat.\nContoh: /A"); return; }
    const id  = match[1].toUpperCase();
    const kandidat = await db.getKandidat(id);
    if (!kandidat) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    try {
      let fileId, mediaType, fileName;
      if (msg.photo)         { fileId=msg.photo[msg.photo.length-1].file_id; mediaType="image"; }
      else if (msg.video)    { fileId=msg.video.file_id; mediaType="video"; }
      else if (msg.document) { fileId=msg.document.file_id; fileName=msg.document.file_name||"file"; mediaType="document"; }
      const fileInfoRes = await axios.get(`${getTelegramApi()}/getFile?file_id=${fileId}`);
      const fileUrl = `https://api.telegram.org/file/bot${getToken()}/${fileInfoRes.data.result.file_path}`;
      const buffer  = Buffer.from((await axios.get(fileUrl,{responseType:"arraybuffer"})).data);
      const pesanTeks = caption.trim().replace(/^\/?[A-Za-z]+\s*/,"").trim();
      let pesanWA;
      if (mediaType==="image")      pesanWA={image:buffer,caption:pesanTeks};
      else if (mediaType==="video") pesanWA={video:buffer,caption:pesanTeks};
      else                          pesanWA={document:buffer,fileName,caption:pesanTeks};
      await queue.tambahKeAntrian(kandidat.wa_id, kandidat.jid, pesanTeks, pesanWA, kandidat.panjang_pesan||0);
      await db.tambahRiwayat(id,"HR",`[Media] ${pesanTeks}`);
      await db.updateKandidat(id,{status:"menunggu"});
      await kirimTeks(`✅ Media ke <b>${kandidat.nama}</b> [${id}] masuk antrian.`);
    } catch(err) { await kirimTeks(`❌ Gagal proses media: ${err.message}`); }
    return;
  }

  if (teks === "/start") {
    await kirimTeks(
      `<b>WA Bridge Bot aktif!</b>\n\n` +
      `<b>Balas kandidat:</b>\n/[id] pesan — Balas kandidat\n/ke nomor pesan — Kirim ke nomor baru\n\n` +
      `<b>Manajemen kandidat:</b>\n/dc — Ringkasan\n/dc [filter] — perlu|menunggu|baru|selesai|semua\n` +
      `/lihat [id] — Detail\n/riwayat [id] — Riwayat\n/catat [id] catatan — Tambah catatan\n` +
      `/selesai [id] — Tandai selesai\n/fixjid [id] [nomor] — Perbaiki nomor\n\n` +
      `<b>Sistem:</b>\n/antrian — Status antrian\n/status — Status WA`
    );
    return;
  }

  if (teks === "/status") {
    const ws = waManager?.getStatus() || {};
    const daftar = Object.entries(ws).map(([id,s])=>`- ${id}: ${s.status==="connected"?"✅":"❌"} ${s.jid?.replace(/@.*/,"") || ""}`).join("\n") || "Tidak ada WA terhubung";
    await kirimTeks(`<b>Status WA Bridge</b>\n\n${daftar}`);
    return;
  }

  if (teks === "/antrian") {
    const s = await queue.getStatus();
    await kirimTeks(`<b>Status Antrian</b>\n\nPesan menunggu: ${s.panjangAntrian}\nSedang proses: ${s.sedangProses?"Ya":"Tidak"}\n\n<i>Bersihkan: /bersihkanantrian</i>`);
    return;
  }

  if (teks === "/bersihkanantrian") {
    const j = await queue.bersihkanAntrian();
    await kirimTeks(`✅ Antrian dibersihkan — ${j} pesan dihapus.`);
    return;
  }

  if (teks.startsWith("/ke ")) {
    const b = teks.replace("/ke ","").trim().split(" ");
    const nomor=b[0], pesan=b.slice(1).join(" ");
    if (!nomor||!pesan) { await kirimTeks("❌ Format: /ke 628xxx pesanmu"); return; }
    const waIds = waManager?.getAllIds() || [];
    if (waIds.length===0) { await kirimTeks("❌ Tidak ada WA yang terhubung."); return; }
    const jid = nomor.includes("@") ? nomor : `${nomor}@s.whatsapp.net`;
    await queue.tambahKeAntrian(waIds[0], jid, pesan, null, 0);
    await kirimTeks(`✅ Pesan ke ${nomor} masuk antrian.`);
    return;
  }

  if (teks === "/dc" || teks === "/daftarchat") {
    const counts = await db.hitungKandidat();
    await kirimTeks(
      `<b>📊 Ringkasan Chat</b>\n\n` +
      `🔔 Perlu dibalas: <b>${counts.perlu_dibalas||0}</b>\n` +
      `⏳ Menunggu reply: <b>${counts.menunggu||0}</b>\n` +
      `🆕 Baru: <b>${counts.baru||0}</b>\n` +
      `✅ Selesai: <b>${counts.selesai||0}</b>\n` +
      `❌ Tidak aktif: <b>${counts.tidak_aktif||0}</b>\n\n` +
      `<b>Filter:</b>\n/dc perlu — perlu dibalas\n/dc menunggu\n/dc baru\n/dc selesai\n/dc semua`
    );
    return;
  }

  if (teks.startsWith("/dc ")) {
    const b=teks.replace("/dc ","").trim().split(" ");
    const filter=b[0].toLowerCase(), halaman=parseInt(b[1])||1;
    const filterMap={perlu:"perlu_dibalas",menunggu:"menunggu",baru:"baru",selesai:"selesai"};
    const perHalaman=10, offset=(halaman-1)*perHalaman;
    let daftar, judul;
    if (filter==="semua") { daftar=await db.getDaftarKandidat({limit:perHalaman,offset}); judul="📋 Semua Kandidat"; }
    else if (filterMap[filter]) { daftar=await db.getDaftarKandidat({status:filterMap[filter],limit:perHalaman,offset}); judul=STATUS_MAP[filterMap[filter]]; }
    else { daftar=await db.getDaftarKandidat({waId:filter,limit:perHalaman,offset}); judul=`📱 ${filter.toUpperCase()}`; }
    if (!daftar.length) { await kirimTeks(`Tidak ada kandidat dengan filter <b>${filter}</b>.`); return; }
    let out=`<b>${judul}</b>\n\n`;
    for (const c of daftar) {
      const u=c.status==="perlu_dibalas"?formatUrgensi(c.waktu_pesan):"";
      out+=`${u} <b>[${c.id}]</b> ${c.nama} — ${c.wa_id} — ${formatWaktu(c.waktu_pesan)}\n📞 ${c.jid?.replace(/@.*/,"")}\n${potong(c.pesan_terakhir)?`💬 "${potong(c.pesan_terakhir)}"\n`:""}\n`;
    }
    if (daftar.length===perHalaman) out+=`\n/dc ${filter} ${halaman+1} — halaman berikutnya`;
    await kirimTeks(out);
    return;
  }

  if (teks.startsWith("/lihat ")) {
    const id=teks.replace("/lihat ","").trim().toUpperCase();
    const k=await db.getKandidat(id);
    if (!k) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    const riwayat=await db.getRiwayat(id,5);
    let out=`<b>👤 [${id}] ${k.nama}</b>\n📞 ${k.jid?.replace(/@.*/,"")}\n📱 ${k.wa_id}\n📅 Pertama: ${new Date(k.waktu_pertama).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})}\n🕐 Terakhir: ${formatWaktu(k.waktu_pesan)}\nStatus: ${STATUS_MAP[k.status]||k.status}\n\n`;
    if (k.catatan) out+=`📝 <b>Catatan:</b>\n${k.catatan}\n\n`;
    if (riwayat.length) { out+=`<b>📋 Riwayat terakhir:</b>\n`; for (const r of riwayat) out+=`${r.waktu} — <b>${r.pengirim}:</b> ${r.pesan}\n`; out+=`\n/riwayat ${id} — lihat semua`; }
    await kirimTeks(out);
    return;
  }

  if (teks.startsWith("/riwayat ")) {
    const id=teks.replace("/riwayat ","").trim().toUpperCase();
    const riwayat=await db.getRiwayat(id);
    if (!riwayat.length) { await kirimTeks(`❌ Tidak ada riwayat untuk [${id}].`); return; }
    const k=await db.getKandidat(id);
    let out=`<b>📋 Riwayat [${id}] ${k?.nama||""}</b>\n\n`;
    for (const r of riwayat) out+=`${r.waktu} — <b>${r.pengirim}:</b> ${r.pesan}\n`;
    await kirimTeks(out);
    return;
  }

  if (teks.startsWith("/catat ")) {
    const spasi=teks.indexOf(" ",7);
    if (spasi===-1) { await kirimTeks("❌ Format: /catat [id] catatan kamu"); return; }
    const id=teks.slice(7,spasi).toUpperCase(), catatan=teks.slice(spasi+1).trim();
    const k=await db.getKandidat(id);
    if (!k) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    await db.updateKandidat(id,{catatan});
    await kirimTeks(`✅ Catatan untuk <b>[${id}] ${k.nama}</b> disimpan.`);
    return;
  }

  if (teks.startsWith("/fixjid ")) {
    const b=teks.replace("/fixjid ","").trim().split(" ");
    if (b.length!==2) { await kirimTeks("❌ Format: /fixjid [id] [nomor]\nContoh: /fixjid H 6287877164531"); return; }
    const id=b[0].toUpperCase(), nomorBaru=b[1].trim().replace(/[^0-9]/g,"");
    const k=await db.getKandidat(id);
    if (!k) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    const jidLama=k.jid;
    await db.updateKandidat(id,{jid:`${nomorBaru}@s.whatsapp.net`});
    await kirimTeks(`✅ JID [${id}] ${k.nama} diperbaiki!\n\nLama: <code>${jidLama.replace(/@.*/,"")}</code>\nBaru: <code>${nomorBaru}</code>`);
    return;
  }

  if (teks.startsWith("/selesai ")) {
    const id=teks.replace("/selesai ","").trim().toUpperCase();
    const k=await db.getKandidat(id);
    if (!k) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    await db.updateKandidat(id,{status:"selesai"});
    await kirimTeks(`✅ [${id}] ${k.nama} ditandai selesai.`);
    return;
  }

  // Balas: /[id] pesanmu
  const matchBalas=teks.match(/^\/([A-Za-z]+)\s+(.+)$/s);
  if (matchBalas) {
    const idRaw=matchBalas[1].toLowerCase(), idUpper=matchBalas[1].toUpperCase(), pesan=matchBalas[2].trim();
    if (PERINTAH_KHUSUS.includes(idRaw)) return;
    const k=await db.getKandidat(idUpper);
    if (!k) { await kirimTeks(`❌ Chat [${idUpper}] tidak ditemukan.`); return; }
    const aktif=await waManager?.cekNomorAktif(k.wa_id,k.jid);
    if (!aktif) {
      await db.updateKandidat(idUpper,{status:"tidak_aktif"});
      await kirimTeks(`❌ <b>[${idUpper}] ${k.nama}</b>\n📞 ${k.jid.replace(/@.*/,"")}\n\nNomor tidak terdaftar di WhatsApp.\nStatus ditandai tidak aktif.`);
      return;
    }
    await queue.tambahKeAntrian(k.wa_id,k.jid,pesan,null,k.panjang_pesan||0);
    await db.tambahRiwayat(idUpper,"HR",pesan);
    await db.updateKandidat(idUpper,{status:"menunggu",waktuBalas:Date.now()});
    await kirimTeks(`✅ Pesan ke <b>${k.nama}</b> [${idUpper}] masuk antrian.`);
    logger.info("Bot-Bridge",`Balas [${idUpper}] ke ${k.nama} masuk antrian`);
  }
}

module.exports = { prosesPerintah, setWaManager };
