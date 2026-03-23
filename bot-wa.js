const axios = require("axios");
const FormData = require("form-data");
const QRCode = require("qrcode");
const fs = require("fs");
const logger = require("./logger");
const waManager = require("./wa-manager");

const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
const TOKEN = config.botWaToken;
const ADMIN_ID = config.adminTelegramId;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// State per user { step, namaWa, metode }
let pendingTambah = null;

async function kirimTeks(teks, parseMode = "HTML") {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: ADMIN_ID,
      text: teks,
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error("Bot-WA", `Gagal kirim teks: ${err.message}`);
  }
}

async function kirimQR(waId, qrString) {
  try {
    const qrBuffer = await QRCode.toBuffer(qrString, { width: 400 });
    const form = new FormData();
    form.append("chat_id", ADMIN_ID);
    form.append("photo", qrBuffer, { filename: "qr.png", contentType: "image/png" });
    form.append("caption", `QR Code untuk ${waId}\n\nScan dari WhatsApp:\nWA → Titik Tiga → Perangkat Tertaut → Tautkan Perangkat\n\nQR berlaku beberapa detik, akan diperbarui otomatis jika expired.`);
    await axios.post(`${TELEGRAM_API}/sendPhoto`, form, { headers: form.getHeaders() });
    logger.info("Bot-WA", `QR dikirim untuk ${waId}`);
  } catch (err) {
    logger.error("Bot-WA", `Gagal kirim QR: ${err.message}`);
  }
}

function setupQRCallback() {
  waManager.setCallbacks({
    onQR: async (waId, qrString) => {
      await kirimQR(waId, qrString);
    },
    onPairingCode: async (waId, code, nomor, errMsg = null) => {
      if (errMsg) {
        await kirimTeks(
          `❌ Gagal generate kode pairing untuk ${waId}\n\nError: ${errMsg}\n\nPastikan nomor sudah terdaftar di WhatsApp.`
        );
        return;
      }
      await kirimTeks(
        `🔢 <b>Kode Pairing untuk ${waId}</b>\n\n` +
        `Nomor: <code>${nomor}</code>\n\n` +
        `Kode kamu:\n<code>${code}</code>\n\n` +
        `Masukkan kode ini di WhatsApp:\n` +
        `<b>WA → Perangkat Tertaut → Tautkan dengan nomor telepon</b>\n\n` +
        `Kode berlaku beberapa menit.`
      );
    },
  });
}

async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const fromId = String(msg.from?.id);

  if (fromId !== String(ADMIN_ID)) {
    await kirimTeks("⛔ Kamu tidak punya akses.");
    return;
  }

  // /start
  if (teks === "/start") {
    await kirimTeks(
      `👋 <b>Bot Manajemen WA</b>\n\n` +
      `<b>Perintah:</b>\n` +
      `/tambahwa - Tambah akun WA baru\n` +
      `/hapuswa - Hapus akun WA\n` +
      `/daftarwa - Lihat semua akun WA\n` +
      `/batal - Batalkan proses yang sedang berjalan`
    );
  }

  // /batal
  else if (teks === "/batal") {
    if (!pendingTambah) {
      await kirimTeks("Tidak ada proses yang sedang berjalan.");
      return;
    }
    pendingTambah = null;
    await kirimTeks("✅ Proses dibatalkan.");
  }

  // /tambahwa
  else if (teks === "/tambahwa") {
    await kirimTeks(
      `➕ <b>Tambah WA Baru</b>\n\n` +
      `Ketik nama untuk akun WA ini.\n` +
      `Contoh: <code>WA-1</code> atau <code>WA-Bisnis</code>\n\n` +
      `Ketik /batal untuk membatalkan.`
    );
    pendingTambah = { step: "namaWa" };
  }

  // Step: input nama WA
  else if (pendingTambah?.step === "namaWa") {
    const namaWa = teks.trim().replace(/[^a-zA-Z0-9-_]/g, "");

    if (!namaWa) {
      await kirimTeks("❌ Nama tidak valid. Gunakan huruf, angka, strip, atau underscor