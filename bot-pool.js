const axios     = require("axios");
const logger    = require("./logger");
const store     = require("./store");
const waManager = require("./wa-manager");
const queue     = require("./queue");

// ===== KIRIM KE BOT POOL TERTENTU =====
async function kirimKeSlot(token, chatId, teks, parseMode = "HTML") {
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    chatId,
      text:       teks,
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Pool", `Gagal kirim ke slot: ${err.message}`);
  }
}

// ===== SET WEBHOOK UNTUK SLOT =====
async function setWebhookSlot(token, webhookUrl, path) {
  try {
    await axios.post(`https://api.telegram.org/bot${token}/setWebhook`, {
      url: `${webhookUrl}/webhook/pool/${path}`,
    });
    logger.info("Bot-Pool", `Webhook diset untuk pool ${path}`);
  } catch (err) {
    logger.error("Bot-Pool", `Gagal set webhook pool ${path}: ${err.message}`);
  }
}

// ===== CEK LID =====
function isLidJid(jid) {
  if (!jid) return false;
  const nomor = jid.replace(/@.*/, '');
  if (!/^[0-9]+$/.test(nomor)) return true;
  if (nomor.length > 14) return true;
  if (nomor.length < 7)  return true;
  return false;
}

// ===== NOTIF PESAN MASUK KE BOT POOL =====
async function notifPesanMasuk(slot, id, waId, nama, jid, pesan, isLid = false) {
  const adminId    = store.getConfig().adminTelegramId;
  const lidFlag    = isLid || isLidJid(jid);
  const nomorTampil= jid.replace(/@.*/, "");
  await kirimKeSlot(
    slot.token, adminId,
    `<b>[${id}] ${waId}</b>\n` +
    `👤 <b>${nama || "."}</b>\n` +
    `📞 <b>${nomorTampil}</b>\n\n` +
    `💬 ${pesan}\n\n` +
    (lidFlag
      ? `⚠️ <i>Nomor belum terdeteksi (WA Web/Business)</i>\n` +
        `<i>Fix: /fixjid ${id} 628xxx — lalu /${id} pesanmu</i>`
      : `<i>Balas: /${id} pesanmu</i>`)
  );
}

// ===== NOTIF MEDIA MASUK KE BOT POOL =====
async function notifMediaMasuk(slot, id, waId, nama, jid, caption, mediaType) {
  const adminId    = store.getConfig().adminTelegramId;
  const lidFlag    = isLidJid(jid);
  const nomorTampil= jid.replace(/@.*/, "");
  await kirimKeSlot(
    slot.token, adminId,
    `<b>[${id}] ${waId}</b>\n` +
    `👤 <b>${nama || "."}</b>\n` +
    `📞 <b>${nomorTampil}</b>\n` +
    `📎 [${mediaType.replace("Message", "")}]\n` +
    (caption ? `💬 ${caption}\n` : "") +
    `\n` +
    (lidFlag
      ? `⚠️ <i>Nomor belum terdeteksi (WA Web/Business)</i>\n` +
        `<i>Fix: /fixjid ${id} 628xxx — lalu /${id} pesanmu</i>`
      : `<i>Balas: /${id} pesanmu</i>`)
  );
}

// ===== PROSES PERINTAH DARI BOT POOL =====
async function prosesPerintahPool(msg, poolId) {
  const teks    = msg.text || "";
  const fromId  = String(msg.from?.id);
  const cfg     = store.getConfig();
  const adminId = String(cfg.adminTelegramId);

  if (fromId !== adminId) return;

  const slot = cfg.botPool.find((p) => p.id === poolId);
  if (!slot) return;

  const { getChatLog, updateChatLog } = require("./bot-bridge");
  const chatLog = getChatLog();

  // Filter chatlog hanya milik WA di slot ini
  const chatLogSlot = Object.entries(chatLog)
    .filter(([, c]) => c.waId === slot.waId);

  // ===== /start =====
  if (teks === "/start") {
    await kirimKeSlot(slot.token, adminId,
      `<b>${slot.nama} aktif!</b>\n` +
      `📱 WA: <b>${slot.waId || "Belum ada WA"}</b>\n\n` +
      `<b>Perintah:</b>\n` +
      `/[id] pesan - Balas kandidat\n` +
      `/dc - Daftar chat\n` +
      `/lihat [id] - Detail kandidat\n` +
      `/selesai [id] - Tandai selesai\n` +
      `/status - Status WA\n` +
      `/antrian - Status antrian`
    );
    return;
  }

  // ===== /status =====
  if (teks === "/status") {
    const waStatus = waManager.getStatus();
    const s        = slot.waId ? waStatus[slot.waId] : null;
    await kirimKeSlot(slot.token, adminId,
      `<b>Status ${slot.nama}</b>\n\n` +
      `WA: ${slot.waId || "Belum ada"}\n` +
      `Koneksi: ${s ? (s.status === "connected" ? "✅ Terhubung" : "❌ Terputus") : "—"}\n` +
      `Nomor: ${s?.jid?.replace(/@.*/, "") || "—"}`
    );
    return;
  }

  // ===== /antrian =====
  if (teks === "/antrian") {
    const qs = queue.getStatus();
    await kirimKeSlot(slot.token, adminId,
      `<b>Status Antrian</b>\n\n` +
      `Menunggu: ${qs.panjangAntrian}\n` +
      `Proses: ${qs.sedangProses ? "Ya" : "Tidak"}`
    );
    return;
  }

  // ===== /dc =====
  if (teks === "/dc") {
    if (chatLogSlot.length === 0) {
      await kirimKeSlot(slot.token, adminId, "Belum ada chat untuk WA ini.");
      return;
    }
    const perlu    = chatLogSlot.filter(([, c]) => c.status === "perlu_dibalas");
    const menunggu = chatLogSlot.filter(([, c]) => c.status === "menunggu");
    await kirimKeSlot(slot.token, adminId,
      `<b>📊 Chat ${slot.nama}</b>\n\n` +
      `🔔 Perlu dibalas: <b>${perlu.length}</b>\n` +
      `⏳ Menunggu: <b>${menunggu.length}</b>\n` +
      `Total: ${chatLogSlot.length}\n\n` +
      perlu.slice(0, 5).map(([id, c]) =>
        `<b>[${id}]</b> ${c.nama} — ${c.jid?.replace(/@.*/, "")}`
      ).join("\n")
    );
    return;
  }

  // ===== /lihat A =====
  if (teks.startsWith("/lihat ")) {
    const id   = teks.replace("/lihat ", "").trim().toUpperCase();
    const chat = chatLog[id];
    if (!chat || chat.waId !== slot.waId) {
      await kirimKeSlot(slot.token, adminId, `❌ Chat [${id}] tidak ditemukan.`);
      return;
    }
    await kirimKeSlot(slot.token, adminId,
      `<b>👤 [${id}] ${chat.nama}</b>\n` +
      `📞 ${chat.jid?.replace(/@.*/, "")}\n` +
      `Status: ${chat.status}\n\n` +
      `💬 "${chat.pesanTerakhir?.slice(0, 100) || ""}"`
    );
    return;
  }

  // ===== /fixjid A 628xxx =====
  if (teks.startsWith("/fixjid ")) {
    const bagian = teks.replace("/fixjid ", "").trim().split(" ");
    if (bagian.length !== 2) {
      await kirimKeSlot(slot.token, adminId, "❌ Format: /fixjid [id] [nomor]\nContoh: /fixjid K 6282390544157");
      return;
    }
    const id       = bagian[0].toUpperCase();
    const nomorBaru= bagian[1].trim().replace(/[^0-9]/g, "");
    const { getChatLog, updateChatLog: updateCL } = require("./bot-bridge");
    const cl       = getChatLog();
    const chat     = cl[id];

    if (!chat) {
      await kirimKeSlot(slot.token, adminId, `❌ Chat [${id}] tidak ditemukan.`);
      return;
    }

    const jidLama = chat.jid;
    const jidBaru = `${nomorBaru}@s.whatsapp.net`;
    updateCL(id, { jid: jidBaru, status: "perlu_dibalas" });
    await kirimKeSlot(slot.token, adminId,
      `✅ JID [${id}] ${chat.nama} diperbaiki!\n\n` +
      `Lama: <code>${jidLama.replace(/@.*/, "")}</code>\n` +
      `Baru: <code>${nomorBaru}</code>\n\n` +
      `Coba balas lagi: /${id} pesanmu`
    );
    return;
  }

  // ===== /selesai A =====
  if (teks.startsWith("/selesai ")) {
    const id   = teks.replace("/selesai ", "").trim().toUpperCase();
    const chat = chatLog[id];
    if (!chat || chat.waId !== slot.waId) {
      await kirimKeSlot(slot.token, adminId, `❌ Chat [${id}] tidak ditemukan.`);
      return;
    }
    updateChatLog(id, { status: "selesai" });
    await kirimKeSlot(slot.token, adminId, `✅ [${id}] ${chat.nama} ditandai selesai.`);
    return;
  }

  // ===== BALAS: /A pesanmu =====
  const matchBalas = teks.match(/^\/([A-Za-z]+)\s+(.+)$/s);
  if (matchBalas) {
    const perintahKhusus = ["dc", "lihat", "selesai", "status", "antrian", "start", "fixjid"];
    const idRaw   = matchBalas[1].toLowerCase();
    const idUpper = matchBalas[1].toUpperCase();
    const pesan   = matchBalas[2].trim();

    if (perintahKhusus.includes(idRaw)) return;

    const chat = chatLog[idUpper];
    if (!chat || chat.waId !== slot.waId) {
      await kirimKeSlot(slot.token, adminId, `❌ Chat [${idUpper}] tidak ditemukan di ${slot.nama}.`);
      return;
    }

    const aktif = await waManager.cekNomorAktif(chat.waId, chat.jid);
    if (!aktif) {
      updateChatLog(idUpper, { status: "tidak_aktif" });
      await kirimKeSlot(slot.token, adminId,
        `❌ Nomor ${chat.jid.replace(/@.*/, "")} tidak aktif di WhatsApp.`
      );
      return;
    }

    queue.tambahKeAntrian(chat.waId, chat.jid, pesan, null, chat.panjangPesan || 0);
    updateChatLog(idUpper, { status: "menunggu", waktuBalas: Date.now() });
    await kirimKeSlot(slot.token, adminId,
      `✅ Pesan ke <b>${chat.nama}</b> [${idUpper}] masuk antrian.`
    );
    logger.info("Bot-Pool", `Balas [${idUpper}] via ${slot.nama}`);
  }
}

module.exports = {
  kirimKeSlot,
  setWebhookSlot,
  notifPesanMasuk,
  notifMediaMasuk,
  prosesPerintahPool,
};
