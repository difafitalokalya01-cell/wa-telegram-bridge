const axios     = require("axios");
const logger    = require("./logger");
const store     = require("./store");
const waManager = require("./wa-manager");
const queue     = require("./queue");
const botPool   = require("./bot-pool");

function getToken()     { return store.getConfig().botGlobalToken; }
function getAdminId()   { return store.getConfig().adminTelegramId; }
function getTelegramApi(){ return `https://api.telegram.org/bot${getToken()}`; }

async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${getTelegramApi()}/sendMessage`, {
      chat_id: getAdminId(), text: teks, parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-Global", `Gagal kirim teks: ${err.message}`);
  }
}

async function prosesPerintah(msg) {
  const teks   = msg.text || "";
  const fromId = String(msg.from?.id);
  const cfg    = store.getConfig();

  if (fromId !== String(getAdminId())) return;

  // ===== /start =====
  if (teks === "/start") {
    await kirimTeks(
      `<b>WA Global Panel</b>\n\n` +
      `<b>Pool Bot:</b>\n` +
      `/pool - Lihat status semua slot\n` +
      `/assign namaWA - Assign WA ke slot kosong\n` +
      `/reset namaWA - Kosongkan slot WA\n\n` +
      `<b>Monitor:</b>\n` +
      `/statuswa - Status semua WA\n` +
      `/daftarchat - Semua chat aktif\n` +
      `/antrian - Status antrian global\n\n` +
      `<b>Kirim Pesan:</b>\n` +
      `/kirim namaWA 628xxx pesanmu\n\n` +
      `<b>Sistem:</b>\n` +
      `/healthcheck - Cek semua sistem`
    );
    return;
  }

  // ===== /pool — status semua slot =====
  if (teks === "/pool") {
    const pool = cfg.botPool || [];
    if (pool.length === 0) { await kirimTeks("Belum ada bot di pool."); return; }

    let out = `<b>Status Pool Bot</b>\n\n`;
    for (const p of pool) {
      const waStatus = p.waId ? waManager.getStatus()[p.waId] : null;
      const koneksi  = waStatus
        ? (waStatus.status === "connected" ? "✅ Terhubung" : "❌ Terputus")
        : "—";
      out +=
        `<b>${p.nama}</b> (${p.username})\n` +
        `Status: ${p.status === "terisi" ? "🟢 Terisi" : "⚪ Kosong"}\n` +
        `WA: ${p.waId || "—"}\n` +
        `Koneksi: ${koneksi}\n\n`;
    }
    out += `Slot kosong: ${pool.filter((p) => p.status === "kosong").length}/${pool.length}`;
    await kirimTeks(out);
    return;
  }

  // ===== /assign namaWA — assign WA ke slot kosong =====
  if (teks.startsWith("/assign ")) {
    const namaWa = teks.replace("/assign ", "").trim();
    if (!namaWa) { await kirimTeks("❌ Format: /assign namaWA\nContoh: /assign WA-1"); return; }

    const waStatus = waManager.getStatus();
    if (!waStatus[namaWa]) {
      await kirimTeks(`❌ WA <b>${namaWa}</b> tidak ditemukan atau belum terhubung.`);
      return;
    }

    // Cek apakah sudah punya slot
    const slotExisting = store.getSlotByWaId(namaWa);
    if (slotExisting) {
      await kirimTeks(`<b>${namaWa}</b> sudah di slot <b>${slotExisting.nama}</b>.`);
      return;
    }

    const slot = store.getSlotKosong();
    if (!slot) {
      await kirimTeks("❌ Tidak ada slot kosong. Tambah bot baru ke pool dulu.");
      return;
    }

    await store.assignSlot(slot.id, namaWa);
    await kirimTeks(
      `✅ <b>${namaWa}</b> berhasil di-assign ke <b>${slot.nama}</b>!\n\n` +
      `Notif pesan masuk dari ${namaWa} akan dikirim ke ${slot.username}.`
    );
    logger.info("Bot-Global", `${namaWa} di-assign ke ${slot.nama}`);
    return;
  }

  // ===== /reset namaWA — kosongkan slot =====
  if (teks.startsWith("/reset ")) {
    const namaWa = teks.replace("/reset ", "").trim();
    const slot   = store.getSlotByWaId(namaWa);
    if (!slot) {
      await kirimTeks(`❌ <b>${namaWa}</b> tidak ditemukan di pool.`);
      return;
    }
    await store.kosongkanSlot(slot.id);
    await kirimTeks(`✅ Slot <b>${slot.nama}</b> dikosongkan. WA <b>${namaWa}</b> dilepas.`);
    logger.info("Bot-Global", `Slot ${slot.nama} dikosongkan dari ${namaWa}`);
    return;
  }

  // ===== /statuswa — semua WA =====
  if (teks === "/statuswa") {
    const waStatus = waManager.getStatus();
    const daftar   = Object.entries(waStatus);
    if (daftar.length === 0) { await kirimTeks("Tidak ada WA terhubung."); return; }

    let out = `<b>Status Semua WA</b>\n\n`;
    for (const [id, s] of daftar) {
      const slot = store.getSlotByWaId(id);
      out +=
        `<b>${id}</b>\n` +
        `Koneksi: ${s.status === "connected" ? "✅ Terhubung" : "❌ Terputus"}\n` +
        `Nomor: <code>${s.jid?.replace(/@.*/, "") || "—"}</code>\n` +
        `Slot: ${slot ? slot.nama : "Belum di-assign"}\n\n`;
    }
    await kirimTeks(out);
    return;
  }

  // ===== /daftarchat — semua chat aktif =====
  if (teks === "/daftarchat") {
    const { getChatLog } = require("./bot-bridge");
    const chatLog  = getChatLog();
    const perlu    = Object.entries(chatLog).filter(([, c]) => c.status === "perlu_dibalas");
    const menunggu = Object.entries(chatLog).filter(([, c]) => c.status === "menunggu");

    let out =
      `<b>📊 Ringkasan Global</b>\n\n` +
      `🔔 Perlu dibalas: <b>${perlu.length}</b>\n` +
      `⏳ Menunggu: <b>${menunggu.length}</b>\n` +
      `Total chat: ${Object.keys(chatLog).length}\n\n`;

    if (perlu.length > 0) {
      out += `<b>Yang perlu dibalas:</b>\n`;
      for (const [id, c] of perlu.slice(0, 10)) {
        const slot = store.getSlotByWaId(c.waId);
        out += `[${id}] ${c.nama} — ${slot?.nama || c.waId}\n`;
      }
      if (perlu.length > 10) out += `...dan ${perlu.length - 10} lainnya`;
    }
    await kirimTeks(out);
    return;
  }

  // ===== /antrian =====
  if (teks === "/antrian") {
    const qs = queue.getStatus();
    await kirimTeks(
      `<b>Status Antrian Global</b>\n\n` +
      `Pesan menunggu: ${qs.panjangAntrian}\n` +
      `Sedang proses: ${qs.sedangProses ? "Ya" : "Tidak"}`
    );
    return;
  }

  // ===== /kirim namaWA 628xxx pesanmu =====
  if (teks.startsWith("/kirim ")) {
    const bagian = teks.replace("/kirim ", "").trim().split(" ");
    if (bagian.length < 3) {
      await kirimTeks("❌ Format: /kirim namaWA 628xxx pesanmu\nContoh: /kirim hpijooobisnis 628123456789 Halo!");
      return;
    }
    const namaWa = bagian[0];
    const nomor  = bagian[1];
    const pesan  = bagian.slice(2).join(" ");
    const jid    = `${nomor}@s.whatsapp.net`;

    const waStatus = waManager.getStatus();
    if (!waStatus[namaWa] || waStatus[namaWa].status !== "connected") {
      await kirimTeks(`❌ WA <b>${namaWa}</b> tidak terhubung.`);
      return;
    }

    queue.tambahKeAntrian(namaWa, jid, pesan, null, 0);
    await kirimTeks(`✅ Pesan ke <code>${nomor}</code> via <b>${namaWa}</b> masuk antrian.`);
    return;
  }

  // ===== /healthcheck =====
  if (teks === "/healthcheck") {
    const waStatus = waManager.getStatus();
    const qs       = queue.getStatus();
    const pool     = cfg.botPool || [];
    const terhubung= Object.values(waStatus).filter((s) => s.status === "connected").length;

    await kirimTeks(
      `<b>Health Check Global</b>\n\n` +
      `<b>WA:</b> ${terhubung}/${Object.keys(waStatus).length} terhubung\n` +
      `<b>Pool:</b> ${pool.filter((p) => p.status === "terisi").length}/${pool.length} slot terisi\n` +
      `<b>Antrian:</b> ${qs.panjangAntrian} pesan\n` +
      `<b>Uptime:</b> ${Math.floor(process.uptime() / 60)} menit`
    );
    return;
  }
}

module.exports = { prosesPerintah, kirimTeks };
