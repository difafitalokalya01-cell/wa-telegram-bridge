"use strict";
/**
 * FILE: bots/bot-reminder.js
 * FUNGSI: Bot pengingat kandidat yang belum dibalas
 * DIGUNAKAN OLEH: index.js (mulaiPengingat, webhook /webhook/reminder)
 * MENGGUNAKAN: database.js, notif-handler.js, queue.js, wa-manager.js
 * DEPENDENCY MAP:
 *   Mengubah waktu reminder tidak mempengaruhi file lain
 *   Cek pengingat dijalankan setiap 5 menit via setInterval
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
function getToken()    { return getConfig().botReminderToken; }
function getAdminId()  { return getConfig().adminTelegramId; }

async function kirimTeks(teks) {
  await notif.kirimTeks(getToken(), getAdminId(), teks);
}

async function getReminderSettings() {
  const cfg = getConfig();
  return {
    reminder1: cfg.reminderSettings?.reminder1 || 30,
    reminder2: cfg.reminderSettings?.reminder2 || 60,
    reminder3: cfg.reminderSettings?.reminder3 || 120,
  };
}

// ── Cek dan kirim pengingat ────────────────────────────────────
async function cekPengingat() {
  try {
    const rs        = await getReminderSettings();
    const sekarang  = Date.now();
    const kandidats = await db.getDaftarKandidat({ status: "perlu_dibalas", limit: 200 });

    for (const k of kandidats) {
      if (!k.waktu_pesan) continue;
      const selisihMenit = Math.floor((sekarang - k.waktu_pesan) / 60000);
      const id = k.id;

      if (selisihMenit >= rs.reminder1 && selisihMenit < rs.reminder2 && !k.reminder_1) {
        await kirimTeks(
          `⏰ <b>Pengingat 1 — Belum dibalas ${rs.reminder1} menit!</b>\n\n` +
          `<b>[${id}]</b> ${k.nama}\n📞 ${k.jid?.replace(/@.*/,"")}\n📱 ${k.wa_id}\n\n` +
          `💬 "${k.pesan_terakhir?.slice(0,60)||""}"\n\nBalas: /${id} pesanmu`
        );
        await db.updateKandidat(id, { reminder1: true });
        logger.info("Bot-Reminder", `Pengingat 1 terkirim untuk [${id}] ${k.nama}`);

      } else if (selisihMenit >= rs.reminder2 && selisihMenit < rs.reminder3 && !k.reminder_2) {
        await kirimTeks(
          `⚠️ <b>Pengingat 2 — Belum dibalas ${rs.reminder2} menit!</b>\n\n` +
          `<b>[${id}]</b> ${k.nama}\n📞 ${k.jid?.replace(/@.*/,"")}\n📱 ${k.wa_id}\n\n` +
          `💬 "${k.pesan_terakhir?.slice(0,60)||""}"\n\nBalas: /${id} pesanmu`
        );
        await db.updateKandidat(id, { reminder2: true });
        logger.info("Bot-Reminder", `Pengingat 2 terkirim untuk [${id}] ${k.nama}`);

      } else if (selisihMenit >= rs.reminder3 && !k.reminder_3) {
        await kirimTeks(
          `🚨 <b>URGENT — Belum dibalas ${rs.reminder3} menit!</b>\n\n` +
          `<b>[${id}]</b> ${k.nama}\n📞 ${k.jid?.replace(/@.*/,"")}\n📱 ${k.wa_id}\n\n` +
          `💬 "${k.pesan_terakhir?.slice(0,60)||""}"\n\nBalas: /${id} pesanmu`
        );
        await db.updateKandidat(id, { reminder3: true });
        logger.info("Bot-Reminder", `Pengingat 3 URGENT terkirim untuk [${id}] ${k.nama}`);
      }
    }
  } catch (err) {
    logger.error("Bot-Reminder", `Error cek pengingat: ${err.message}`);
  }
}

// ── Proses perintah dari bot reminder ─────────────────────────
async function prosesPerintah(msg) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  if (fromId !== String(getAdminId())) return;

  if (teks === "/start") {
    const rs = await getReminderSettings();
    await kirimTeks(
      `<b>Bot Pengingat aktif!</b>\n\n` +
      `<b>Pengaturan saat ini:</b>\n⏰ Pengingat 1: ${rs.reminder1} menit\n` +
      `⚠️ Pengingat 2: ${rs.reminder2} menit\n🚨 Pengingat 3: ${rs.reminder3} menit\n\n` +
      `<b>Perintah:</b>\n/setreminder 30 60 120 — Ubah waktu\n` +
      `/ceksekarang — Cek pengingat sekarang\n/[id] pesan — Balas kandidat\n/lihat [id] — Detail`
    );
    return;
  }

  if (teks.startsWith("/setreminder ")) {
    const b=teks.replace("/setreminder ","").trim().split(" ");
    if (b.length!==3) { await kirimTeks("❌ Format: /setreminder menit1 menit2 menit3\nContoh: /setreminder 30 60 120"); return; }
    const r1=parseInt(b[0]), r2=parseInt(b[1]), r3=parseInt(b[2]);
    if (isNaN(r1)||isNaN(r2)||isNaN(r3)||r1>=r2||r2>=r3) { await kirimTeks("❌ Pastikan menit1 < menit2 < menit3."); return; }
    const cfg = getConfig();
    cfg.reminderSettings = { reminder1:r1, reminder2:r2, reminder3:r3 };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    _config = cfg;
    await kirimTeks(`✅ Pengingat diupdate:\n⏰ Pengingat 1: ${r1} menit\n⚠️ Pengingat 2: ${r2} menit\n🚨 Pengingat 3: ${r3} menit`);
    return;
  }

  if (teks === "/ceksekarang") {
    await kirimTeks("⏳ Mengecek pengingat sekarang...");
    await cekPengingat();
    await kirimTeks("✅ Pengecekan selesai.");
    return;
  }

  if (teks.startsWith("/lihat ")) {
    const id=teks.replace("/lihat ","").trim().toUpperCase();
    const k=await db.getKandidat(id);
    if (!k) { await kirimTeks(`❌ Chat [${id}] tidak ditemukan.`); return; }
    await kirimTeks(`<b>👤 [${id}] ${k.nama}</b>\n📞 ${k.jid?.replace(/@.*/,"")}\n📱 ${k.wa_id}\nStatus: ${k.status}\n\n💬 "${k.pesan_terakhir?.slice(0,100)||""}"\n\nBalas: /${id} pesanmu`);
    return;
  }

  // Balas: /[id] pesanmu
  const matchBalas=teks.match(/^\/([A-Za-z]+)\s+(.+)$/s);
  if (matchBalas) {
    const perintahKhusus=["setreminder","ceksekarang","start","lihat"];
    const idRaw=matchBalas[1].toLowerCase(), idUpper=matchBalas[1].toUpperCase(), pesan=matchBalas[2].trim();
    if (perintahKhusus.includes(idRaw)) return;
    const k=await db.getKandidat(idUpper);
    if (!k) { await kirimTeks(`❌ Chat [${idUpper}] tidak ditemukan.`); return; }
    const aktif=await waManager?.cekNomorAktif(k.wa_id,k.jid);
    if (!aktif) {
      await db.updateKandidat(idUpper,{status:"tidak_aktif"});
      await kirimTeks(`❌ Nomor ${k.jid.replace(/@.*/,"")} tidak aktif di WhatsApp.`);
      return;
    }
    await queue.tambahKeAntrian(k.wa_id,k.jid,pesan,null,k.panjang_pesan||0);
    await db.updateKandidat(idUpper,{status:"menunggu",waktuBalas:Date.now(),reminder1:false,reminder2:false,reminder3:false});
    await kirimTeks(`✅ Pesan ke <b>${k.nama}</b> [${idUpper}] masuk antrian.`);
  }
}

function mulaiPengingat() {
  setInterval(cekPengingat, 5 * 60 * 1000);
  logger.info("Bot-Reminder", "Sistem pengingat aktif, cek setiap 5 menit");
}

module.exports = { prosesPerintah, mulaiPengingat, setWaManager };
