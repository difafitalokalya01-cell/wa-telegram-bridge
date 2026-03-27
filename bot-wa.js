const axios     = require("axios");
const FormData  = require("form-data");
const QRCode    = require("qrcode");
const logger    = require("./logger");
const waManager = require("./wa-manager");
const store     = require("./store");
const botBridge = require("./bot-bridge");

function getToken()     { return store.getConfig().botWaToken; }
function getAdminId()   { return store.getConfig().adminTelegramId; }
function getTelegramApi(){ return `https://api.telegram.org/bot${getToken()}`; }

let pendingTambah = null;

async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${getTelegramApi()}/sendMessage`, {
      chat_id: getAdminId(), text: teks, parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-WA", `Gagal kirim teks: ${err.message}`);
  }
}

async function kirimQR(waId, qrString) {
  try {
    const qrBuffer = await QRCode.toBuffer(qrString, { width: 400 });
    const form     = new FormData();
    form.append("chat_id", getAdminId());
    form.append("photo", qrBuffer, { filename: "qr.png", contentType: "image/png" });
    form.append("caption",
      `QR Code untuk ${waId}\n\nScan dari WhatsApp:\nWA -> Titik Tiga -> Perangkat Tertaut -> Tautkan Perangkat\n\nQR berlaku beberapa detik, akan diperbarui otomatis jika expired.`
    );
    await axios.post(`${getTelegramApi()}/sendPhoto`, form, { headers: form.getHeaders() });
    logger.info("Bot-WA", `QR dikirim untuk ${waId}`);
  } catch (err) {
    logger.error("Bot-WA", `Gagal kirim QR: ${err.message}`);
  }
}

// ===== SETUP CALLBACK QR & CONNECTED — merge ke callbacks yang sudah diset bot-bridge =====
function setupQRCallback() {
  botBridge.setupWaCallbacks({
    onQR: async (waId, qrString) => {
      await kirimQR(waId, qrString);
    },
    onPairingCode: async (waId, code, nomor, errMsg = null) => {
      if (errMsg) {
        await kirimTeks(`Gagal generate kode pairing untuk ${waId}\n\nError: ${errMsg}\n\nPastikan nomor sudah terdaftar di WhatsApp.`);
        return;
      }
      await kirimTeks(
        `<b>Kode Pairing untuk ${waId}</b>\n\n` +
        `Nomor: <code>${nomor}</code>\n\n` +
        `Kode kamu:\n<code>${code}</code>\n\n` +
        `Masukkan kode ini di WhatsApp:\n` +
        `<b>WA -> Perangkat Tertaut -> Tautkan dengan nomor telepon</b>\n\n` +
        `Kode berlaku beberapa menit.`
      );
    },
    onConnected: async (waId, jid) => {
      const slot = store.getSlotByWaId(waId);
      await kirimTeks(
        `<b>${waId} terhubung!</b>\n` +
        `Nomor: <code>${jid.replace(/@.*/, "")}</code>\n` +
        `Slot: ${slot ? `${slot.nama} (${slot.username})` : "Belum di-assign ke slot"}`
      );
    },
    onDisconnected: async (waId, willReconnect, maxRetryReached = false) => {
      if (maxRetryReached) return;
      const slot = store.getSlotByWaId(waId);
      await kirimTeks(
        `<b>${waId} terputus!</b>\n` +
        `Nomor: ${waId}\n` +
        `Slot: ${slot ? `${slot.nama} (${slot.username})` : "Belum di-assign"}\n` +
        `Reconnect otomatis: ${willReconnect ? "Ya" : "Tidak"}`
      );
    },
  });
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
      `<b>Bot Manajemen WA</b>\n\n` +
      `<b>Perintah:</b>\n` +
      `/tambahwa - Tambah akun WA baru\n` +
      `/hapuswa - Hapus akun WA\n` +
      `/daftarwa - Lihat semua akun WA\n` +
      `/batal - Batalkan proses yang sedang berjalan`
    );
    return;
  }

  if (teks === "/batal") {
    if (!pendingTambah) { await kirimTeks("Tidak ada proses yang sedang berjalan."); return; }
    pendingTambah = null;
    await kirimTeks("Proses dibatalkan.");
    return;
  }

  if (teks === "/tambahwa") {
    await kirimTeks(
      `<b>Tambah WA Baru</b>\n\n` +
      `Ketik nama untuk akun WA ini.\n` +
      `Contoh: <code>WA-1</code> atau <code>WA-Bisnis</code>\n\n` +
      `Ketik /batal untuk membatalkan.`
    );
    pendingTambah = { step: "namaWa" };
    return;
  }

  if (pendingTambah?.step === "namaWa") {
    const namaWa = teks.trim().replace(/[^a-zA-Z0-9-_]/g, "");
    if (!namaWa) { await kirimTeks("Nama tidak valid. Gunakan huruf, angka, strip, atau underscore saja."); return; }

    const existing = waManager.getStatus();
    if (existing[namaWa]) {
      await kirimTeks(`<b>${namaWa}</b> sudah ada. Gunakan nama lain.`);
      pendingTambah = null;
      return;
    }

    pendingTambah = { step: "pilihMetode", namaWa };
    await kirimTeks(
      `<b>Pilih metode pairing untuk ${namaWa}:</b>\n\n` +
      `1. Ketik <code>qr</code> - Scan QR Code\n` +
      `2. Ketik <code>nomor</code> - Pairing dengan nomor ponsel\n\n` +
      `Ketik /batal untuk membatalkan.`
    );
    return;
  }

  if (pendingTambah?.step === "pilihMetode") {
    const pilihan = teks.trim().toLowerCase();
    if (!["qr", "nomor"].includes(pilihan)) { await kirimTeks("Ketik <code>qr</code> atau <code>nomor</code>."); return; }

    if (pilihan === "qr") {
      await mulaiKoneksi(pendingTambah.namaWa, false, null);
      pendingTambah = null;
    } else {
      pendingTambah = { step: "inputNomor", namaWa: pendingTambah.namaWa };
      await kirimTeks(
        `Ketik nomor WhatsApp dengan format internasional:\n\n` +
        `Contoh: <code>628123456789</code>\n\n` +
        `Ketik /batal untuk membatalkan.`
      );
    }
    return;
  }

  if (pendingTambah?.step === "inputNomor") {
    const nomor = teks.trim().replace(/[^0-9]/g, "");
    if (!nomor || nomor.length < 10) { await kirimTeks("Nomor tidak valid. Pastikan format benar, contoh: <code>628123456789</code>"); return; }
    const namaWa  = pendingTambah.namaWa;
    pendingTambah = null;
    await mulaiKoneksi(namaWa, true, nomor);
    return;
  }

  if (teks === "/hapuswa") {
    const status = waManager.getStatus();
    const daftar = Object.keys(status);
    if (daftar.length === 0) { await kirimTeks("Tidak ada akun WA yang terhubung."); return; }
    const listTeks = daftar
      .map((id, i) => `${i + 1}. ${id} - ${status[id].status === "connected" ? "Terhubung" : "Terputus"}`)
      .join("\n");
    await kirimTeks(
      `<b>Hapus Akun WA</b>\n\n` +
      `Daftar akun:\n${listTeks}\n\n` +
      `Ketik: <code>/konfirmhapus namaWA</code>\n` +
      `Contoh: <code>/konfirmhapus WA-1</code>`
    );
    return;
  }

  if (teks.startsWith("/konfirmhapus ")) {
    const namaWa = teks.replace("/konfirmhapus ", "").trim();
    try {
      await waManager.disconnectWA(namaWa);
      const cfg = store.getConfig();
      delete cfg.waAccounts[namaWa];
      delete cfg.activeAccounts[namaWa];
      await store.saveData(cfg);
      await kirimTeks(`<b>${namaWa}</b> berhasil dihapus.`);
      logger.info("Bot-WA", `${namaWa} berhasil dihapus`);
    } catch (err) {
      await kirimTeks(`Gagal hapus ${namaWa}: ${err.message}`);
    }
    return;
  }

  if (teks === "/daftarwa") {
    const status = waManager.getStatus();
    const daftar = Object.entries(status);
    if (daftar.length === 0) { await kirimTeks("Belum ada akun WA yang terhubung."); return; }
    const listTeks = daftar
      .map(([id, s]) =>
        `<b>${id}</b>\n` +
        `Status: ${s.status === "connected" ? "Terhubung" : "Terputus"}\n` +
        `Nomor: <code>${s.jid?.replace(/@.*/, "") || "-"}</code>`
      ).join("\n\n");
    await kirimTeks(`<b>Daftar Akun WA</b>\n\n${listTeks}`);
    return;
  }
}

async function mulaiKoneksi(namaWa, usePairingCode, nomor) {
  await kirimTeks(
    `Menghubungkan <b>${namaWa}</b>...\n\n` +
    (usePairingCode ? `Kode pairing akan dikirim sebentar lagi.` : `QR code akan dikirim sebentar lagi.`)
  );
  try {
    await waManager.connectWA(namaWa, usePairingCode, nomor);
    const cfg = store.getConfig();
    cfg.waAccounts[namaWa]     = { addedAt: new Date().toISOString() };
    cfg.activeAccounts[namaWa] = true;
    await store.saveData(cfg);
    logger.info("Bot-WA", `${namaWa} mulai proses koneksi`);
  } catch (err) {
    await kirimTeks(`Gagal menghubungkan ${namaWa}: ${err.message}`);
    logger.error("Bot-WA", `Gagal connect ${namaWa}: ${err.message}`);
  }
}

module.exports = { prosesPerintah, kirimTeks, setupQRCallback };
