const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const axios = require("axios");
const express = require("express");
const fs = require("fs");
const pino = require("pino");

// ===== KONFIGURASI =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8458582546:AAEajr73kZF8iISDDRnRxc2yNfgwBHeFeoI";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "5846121015";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// ===== EXPRESS UNTUK WEBHOOK TELEGRAM =====
const app = express();
app.use(express.json());

// ===== SIMPAN NOMOR TERAKHIR =====
let nomorTerakhir = null;
let daftarChat = {};
let sock = null;

// ===== KIRIM PESAN KE TELEGRAM =====
async function kirimKeTelegram(teks) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: teks,
        parse_mode: "HTML",
      }
    );
  } catch (err) {
    console.error("Gagal kirim ke Telegram:", err.message);
  }
}

// ===== KIRIM PESAN KE WHATSAPP =====
async function kirimKeWA(jid, pesan) {
  if (!sock) {
    throw new Error("WA belum terhubung");
  }
  await sock.sendMessage(jid, { text: pesan });
  console.log(`Berhasil kirim ke WA ${jid}: ${pesan}`);
}

// ===== KONEKSI KE WHATSAPP =====
async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true, // QR muncul di terminal/logs Railway
    browser: ["WA Bridge", "Chrome", "1.0.0"],
  });

  // Simpan credentials saat update
  sock.ev.on("creds.update", saveCreds);

  // Handle koneksi
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR Code muncul di logs Railway - scan sekarang!");
      await kirimKeTelegram("📱 <b>WA Bridge butuh scan QR!</b>\n\nBuka Railway logs dan scan QR yang muncul di sana.\n\nAtau buka: <code>https://wa-bridge-production.up.railway.app/qr</code>");
    }

    if (connection === "open") {
      console.log("✅ WhatsApp terhubung!");
      await kirimKeTelegram("✅ <b>WhatsApp berhasil terhubung!</b>\n\nBridge WA-Telegram aktif. Pesan WA akan diteruskan ke sini.\n\n<b>Perintah:</b>\n/balas [pesan] - Balas ke pengirim terakhir\n/ke [nomor] [pesan] - Kirim ke nomor tertentu\n/info - Lihat status");
    }

    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Koneksi WA terputus. Reconnect:", shouldReconnect);

      if (shouldReconnect) {
        setTimeout(connectWA, 5000);
      } else {
        await kirimKeTelegram("❌ WhatsApp logout! Perlu scan QR ulang.\n\nRestart service di Railway.");
      }
    }
  });

  // Handle pesan masuk
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        // Skip pesan dari diri sendiri
        if (msg.key.fromMe) continue;

        // Skip pesan grup (opsional, hapus baris ini kalau mau terima pesan grup)
        if (msg.key.remoteJid.endsWith("@g.us")) continue;

        const jid = msg.key.remoteJid;
        const pesan =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          "[Media/Sticker/File]";

        const namaPengirim = msg.pushName || jid.replace(/@.*/, "");

        // Simpan ke daftar
        daftarChat[jid] = namaPengirim;
        nomorTerakhir = jid;

        // Forward ke Telegram
        const teksKeTelegram =
          `📱 <b>WA dari ${namaPengirim}</b>\n` +
          `📞 <code>${jid.replace(/@.*/, "")}</code>\n\n` +
          `💬 ${pesan}\n\n` +
          `<i>Balas: /balas pesanmu\nKirim ke lain: /ke 628xxx pesanmu</i>`;

        await kirimKeTelegram(teksKeTelegram);
        console.log(`WA masuk dari ${namaPengirim}: ${pesan}`);
      } catch (err) {
        console.error("Error proses pesan:", err.message);
      }
    }
  });
}

// ===== WEBHOOK TELEGRAM =====
app.post("/webhook/telegram", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    if (!msg) return;
    const teks = msg.text || "";

    // /balas pesannya
    if (teks.startsWith("/balas ")) {
      const pesanBalas = teks.replace("/balas ", "").trim();

      if (!nomorTerakhir) {
        await kirimKeTelegram("❌ Belum ada pesan WA yang masuk.");
        return;
      }

      try {
        await kirimKeWA(nomorTerakhir, pesanBalas);
        const nama = daftarChat[nomorTerakhir] || nomorTerakhir;
        await kirimKeTelegram(`✅ Terkirim ke <b>${nama}</b>:\n${pesanBalas}`);
      } catch (e) {
        await kirimKeTelegram(`❌ Gagal kirim: ${e.message}`);
      }
    }

    // /ke 628xxx pesannya
    else if (teks.startsWith("/ke ")) {
      const bagian = teks.replace("/ke ", "").trim().split(" ");
      const nomor = bagian[0];
      const pesanBalas = bagian.slice(1).join(" ");

      if (!pesanBalas) {
        await kirimKeTelegram("❌ Format: /ke 628xxx pesanmu");
        return;
      }

      // Format JID
      const jid = nomor.includes("@") ? nomor : `${nomor}@s.whatsapp.net`;

      try {
        await kirimKeWA(jid, pesanBalas);
        await kirimKeTelegram(`✅ Terkirim ke ${nomor}:\n${pesanBalas}`);
      } catch (e) {
        await kirimKeTelegram(`❌ Gagal kirim: ${e.message}`);
      }
    }

    // /info
    else if (teks === "/info") {
      const daftarStr = Object.entries(daftarChat)
        .slice(-10)
        .map(([jid, nama]) => `• ${nama} (${jid.replace(/@.*/, "")})`)
        .join("\n") || "Belum ada";

      await kirimKeTelegram(
        `ℹ️ <b>WA Bridge Bot</b>\n\n` +
        `Status WA: ${sock ? "✅ Terhubung" : "❌ Tidak terhubung"}\n` +
        `Nomor terakhir: ${nomorTerakhir ? daftarChat[nomorTerakhir] : "belum ada"}\n\n` +
        `<b>10 chat terakhir:</b>\n${daftarStr}\n\n` +
        `<b>Perintah:</b>\n/balas [pesan]\n/ke [nomor] [pesan]\n/info`
      );
    }

    // /start
    else if (teks === "/start") {
      await kirimKeTelegram(
        `👋 <b>WA Bridge Bot aktif!</b>\n\n` +
        `Pesan WA masuk akan diteruskan ke sini.\n\n` +
        `<b>Perintah:</b>\n` +
        `/balas [pesan] - Balas ke pengirim terakhir\n` +
        `/ke [nomor] [pesan] - Kirim ke nomor tertentu\n` +
        `/info - Lihat status`
      );
    }
  } catch (err) {
    console.error("Error webhook Telegram:", err.message);
  }
});

app.get("/", (req, res) => res.send("WA-Telegram Bridge (Baileys) aktif! ✅"));

// ===== START =====
app.listen(PORT, async () => {
  console.log(`Server jalan di port ${PORT}`);

  // Set Telegram webhook
  if (WEBHOOK_URL) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        { url: `${WEBHOOK_URL}/webhook/telegram` }
      );
      console.log("Telegram webhook diset ke:", WEBHOOK_URL);
    } catch (err) {
      console.error("Gagal set webhook:", err.message);
    }
  }

  // Koneksi ke WA
  await connectWA();
});
