const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== KONFIGURASI =====
const TELEGRAM_BOT_TOKEN = "8458582546:AAEajr73kZF8iISDDRnRxc2yNfgwBHeFeoI";
const TELEGRAM_CHAT_ID = "5846121015";
const EVOLUTION_API_URL = "https://evolution-api-production-2c80.up.railway.app";
const EVOLUTION_API_KEY = "minha-chave-secreta";
const EVOLUTION_INSTANCE = "wa-cloud";
const PORT = process.env.PORT || 3000;

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
async function kirimKeWA(nomor, pesan) {
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        number: nomor,
        textMessage: { text: pesan },
      },
      {
        headers: { apikey: EVOLUTION_API_KEY },
      }
    );
  } catch (err) {
    console.error("Gagal kirim ke WA:", err.message);
  }
}

// ===== SIMPAN NOMOR TERAKHIR YANG CHAT =====
// Supaya bisa balas ke nomor yang benar
let nomorTerakhir = null;

// ===== WEBHOOK DARI EVOLUTION API (WA masuk) =====
app.post("/webhook/wa", async (req, res) => {
  res.sendStatus(200);

  try {
    const data = req.body;

    // Hanya proses pesan masuk (bukan pesan yang kita kirim)
    if (data.event !== "messages.upsert") return;
    if (data.data?.key?.fromMe) return;

    const pesan = data.data?.message?.conversation
      || data.data?.message?.extendedTextMessage?.text
      || "[Media/Sticker]";

    const dari = data.data?.key?.remoteJid?.replace("@s.whatsapp.net", "");
    const namaPengirim = data.data?.pushName || dari;

    // Simpan nomor terakhir
    nomorTerakhir = dari;

    // Forward ke Telegram
    const teksKeTelegram = `📱 <b>WA dari ${namaPengirim}</b> (${dari}):\n\n${pesan}\n\n<i>Balas dengan format: /balas pesanmu</i>`;
    await kirimKeTelegram(teksKeTelegram);

    console.log(`WA masuk dari ${namaPengirim}: ${pesan}`);
  } catch (err) {
    console.error("Error webhook WA:", err.message);
  }
});

// ===== WEBHOOK DARI TELEGRAM (balasan dari lo) =====
app.post("/webhook/telegram", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    if (!msg) return;

    const teks = msg.text || "";

    // Format balas: /balas pesannya
    if (teks.startsWith("/balas ")) {
      const pesanBalas = teks.replace("/balas ", "");

      if (!nomorTerakhir) {
        await kirimKeTelegram("❌ Belum ada pesan WA yang masuk untuk dibalas.");
        return;
      }

      await kirimKeWA(nomorTerakhir, pesanBalas);
      await kirimKeTelegram(`✅ Pesan terkirim ke WA (${nomorTerakhir}): ${pesanBalas}`);
      console.log(`Balas ke WA ${nomorTerakhir}: ${pesanBalas}`);
    }

    // Format balas ke nomor tertentu: /ke 628xxx pesannya
    else if (teks.startsWith("/ke ")) {
      const bagian = teks.replace("/ke ", "").split(" ");
      const nomor = bagian[0];
      const pesanBalas = bagian.slice(1).join(" ");

      await kirimKeWA(nomor, pesanBalas);
      await kirimKeTelegram(`✅ Pesan terkirim ke WA (${nomor}): ${pesanBalas}`);
      console.log(`Kirim ke WA ${nomor}: ${pesanBalas}`);
    }

    // Info perintah
    else if (teks === "/info") {
      const info = `ℹ️ <b>WA Bridge Bot</b>\n\nNomor terakhir chat: ${nomorTerakhir || "belum ada"}\n\n<b>Perintah:</b>\n/balas [pesan] - Balas ke nomor terakhir\n/ke [nomor] [pesan] - Kirim ke nomor tertentu\n/info - Lihat info`;
      await kirimKeTelegram(info);
    }
  } catch (err) {
    console.error("Error webhook Telegram:", err.message);
  }
});

// ===== START SERVER =====
app.listen(PORT, async () => {
  console.log(`Bridge WA-Telegram jalan di port ${PORT}`);

  // Set Telegram webhook
  try {
    // URL ini akan diisi setelah deploy ke Railway
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        { url: `${webhookUrl}/webhook/telegram` }
      );
      console.log("Telegram webhook berhasil diset ke:", webhookUrl);
    } else {
      console.log("WEBHOOK_URL belum diset, Telegram webhook belum aktif");
    }
  } catch (err) {
    console.error("Gagal set Telegram webhook:", err.message);
  }
});
