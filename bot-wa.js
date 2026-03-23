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

// Simpan state penambahan WA { waId, step }
let pendingTambah = null;

// ===== KIRIM TEKS =====
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

// ===== KIRIM QR KE TELEGRAM =====
async function kirimQR(waId, qrString) {
  try {
    const qrBuffer = await QRCode.toBuffer(qrString, { width: 400 });
    const form = new FormData();
    form.append("chat_id", ADMIN_ID);
    form.append("photo", qrBuffer, { filename: "qr.png", contentType: "image/png" });
    form.append(
      "caption",
      `📱 <b>QR Code untuk ${waId}</b>\n\n` +
      `Scan dari WhatsApp kamu:\n` +
      `WA → Titik Tiga → Perangkat Tertaut → Tautkan Perangkat\n\n` +
      `<i>QR berlaku beberapa detik, akan diperbarui otomatis jika expired.</i>`,
      { parse_mode: "HTML" }
    );

    await axios.post(`${TELEGRAM_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
    });

    logger.info("Bot-WA", `QR dikirim ke Telegram untuk ${waId}`);
  } catch (err) {
    logger.error("Bot-WA", `Gagal kirim QR: ${err.message}`);
  }
}

// ===== SETUP CALLBACK QR DARI WA MANAGER =====
function setupQRCallback() {
  waManager.setCallbacks({
    onQR: async (waId, qrString) => {
      await kirimQR(waId, qrString);
    },
  });
}

// ===== PROSES PERINTAH TELEGRAM =====
async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const fromId = String(msg.from?.id);

  // Proteksi admin
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
      `/daftarwa - Lihat semua akun WA\n`
    );
  }

  // /tambahwa
  else if (teks === "/tambahwa") {
    await kirimTeks(
      `➕ <b>Tambah WA Baru</b>\n\n` +
      `Ketik nama untuk akun WA ini.\n` +
      `Contoh: <code>WA-1</code> atau <code>WA-Bisnis</code>`
    );
    pendingTambah = { step: "namaWa" };
  }

  // Proses input nama WA setelah /tambahwa
  else if (pendingTambah?.step === "namaWa") {
    const namaWa = teks.trim().replace(/[^a-zA-Z0-9-_]/g, "");

    if (!namaWa) {
      await kirimTeks("❌ Nama tidak valid. Gunakan huruf, angka, strip, atau underscore saja.");
      return;
    }

    const existing = waManager.getStatus();
    if (existing[namaWa]) {
      await kirimTeks(`❌ <b>${namaWa}</b> sudah ada. Gunakan nama lain.`);
      pendingTambah = null;
      return;
    }

    pendingTambah = null;

    await kirimTeks(
      `⏳ Menghubungkan <b>${namaWa}</b>...\n\n` +
      `QR code akan dikirim sebentar lagi.`
    );

    try {
      await waManager.connectWA(namaWa);

      // Simpan ke config
      const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
      cfg.waAccounts[namaWa] = { addedAt: new Date().toISOString() };
      cfg.activeAccounts[namaWa] = true;
      fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));

      logger.info("Bot-WA", `${namaWa} mulai proses koneksi`);
    } catch (err) {
      await kirimTeks(`❌ Gagal menghubungkan ${namaWa}: ${err.message}`);
      logger.error("Bot-WA", `Gagal connect ${namaWa}: ${err.message}`);
    }
  }

  // /hapuswa
  else if (teks === "/hapuswa") {
    const status = waManager.getStatus();
    const daftar = Object.keys(status);

    if (daftar.length === 0) {
      await kirimTeks("❌ Tidak ada akun WA yang terhubung.");
      return;
    }

    const listTeks = daftar
      .map((id, i) => `${i + 1}. ${id} — ${status[id].status === "connected" ? "✅" : "❌"}`)
      .join("\n");

    await kirimTeks(
      `🗑️ <b>Hapus Akun WA</b>\n\n` +
      `Daftar akun:\n${listTeks}\n\n` +
      `Ketik: <code>/konfirmhapus namaWA</code>\n` +
      `Contoh: <code>/konfirmhapus WA-1</code>`
    );
  }

  // /konfirmhapus namaWA
  else if (teks.startsWith("/konfirmhapus ")) {
    const namaWa = teks.replace("/konfirmhapus ", "").trim();

    try {
      await waManager.disconnectWA(namaWa);

      // Hapus dari config
      const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
      delete cfg.waAccounts[namaWa];
      delete cfg.activeAccounts[namaWa];
      fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));

      await kirimTeks(`✅ <b>${namaWa}</b> berhasil dihapus.`);
      logger.info("Bot-WA", `${namaWa} berhasil dihapus`);
    } catch (err) {
      await kirimTeks(`❌ Gagal hapus ${namaWa}: ${err.message}`);
      logger.error("Bot-WA", `Gagal hapus ${namaWa}: ${err.message}`);
    }
  }

  // /daftarwa
  else if (teks === "/daftarwa") {
    const status = waManager.getStatus();
    const daftar = Object.entries(status);

    if (daftar.length === 0) {
      await kirimTeks("📋 Belum ada akun WA yang terhubung.");
      return;
    }

    const listTeks = daftar
      .map(
        ([id, s]) =>
          `• <b>${id}</b>\n` +
          `  Status: ${s.status === "connected" ? "✅ Terhubung" : "❌ Terputus"}\n` +
          `  Nomor: <code>${s.jid?.replace(/@.*/, "") || "-"}</code>`
      )
      .join("\n\n");

    await kirimTeks(`📋 <b>Daftar Akun WA</b>\n\n${listTeks}`);
  }
}

module.exports = { prosesPerintah, kirimTeks, setupQRCallback };
