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
const PORT = process.env.PORT || 8080;

async function kirimKeTelegram(teks) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: teks, parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Gagal kirim ke Telegram:", err.message);
  }
}

function bersihkanNomor(jid) {
  return jid.replace(/@.*/, "");
}

async function kirimKeWA(nomor, pesan) {
  const nomorBersih = bersihkanNomor(nomor);
  const response = await axios.post(
    `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    {
      number: nomorBersih,
      options: { delay: 1000 },
      textMessage: { text: pesan },
    },
    { headers: { apikey: EVOLUTION_API_KEY } }
  );
  console.log(`Berhasil kirim ke WA ${nomorBersih}: ${pesan}`);
  return nomorBersih;
}

let daftarChat = {};
let nomorTerakhir = null;

app.post("/webhook/wa", async (req, res) => {
  res.sendStatus(200);
  try {
    const data = req.body;
    if (data.event !== "messages.upsert") return;
    if (data.data?.key?.fromMe) return;

    const pesan =
      data.data?.message?.conversation ||
      data.data?.message?.extendedTextMessage?.text ||
      "[Media/Sticker/File]";

    const jid = data.data?.key?.remoteJid || "";
    const nomor = bersihkanNomor(jid);
    const namaPengirim = data.data?.pushName || nomor;

    daftarChat[nomor] = namaPengirim;
    nomorTerakhir = nomor;

    const teksKeTelegram =
      `📱 <b>WA dari ${namaPengirim}</b>\n📞 ${nomor}\n\n💬 ${pesan}\n\n` +
      `<i>Balas: /balas pesanmu\nKirim ke lain: /ke 628xxx pesanmu</i>`;

    await kirimKeTelegram(teksKeTelegram);
    console.log(`WA masuk dari ${namaPengirim} (${nomor}): ${pesan}`);
  } catch (err) {
    console.error("Error webhook WA:", err.message);
  }
});

app.post("/webhook/telegram", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (!msg) return;
    const teks = msg.text || "";

    if (teks.startsWith("/balas ")) {
      const pesanBalas = teks.replace("/balas ", "").trim();
      if (!nomorTerakhir) {
        await kirimKeTelegram("❌ Belum ada pesan WA yang masuk.");
        return;
      }
      try {
        await kirimKeWA(nomorTerakhir, pesanBalas);
        const nama = daftarChat[nomorTerakhir] || nomorTerakhir;
        await kirimKeTelegram(`✅ Terkirim ke <b>${nama}</b> (${nomorTerakhir}):\n${pesanBalas}`);
      } catch (e) {
        await kirimKeTelegram(`❌ Gagal kirim. Error: ${e.response?.data?.message || e.message}`);
      }
    }

    else if (teks.startsWith("/ke ")) {
      const bagian = teks.replace("/ke ", "").trim().split(" ");
      const nomor = bagian[0];
      const pesanBalas = bagian.slice(1).join(" ");
      if (!pesanBalas) {
        await kirimKeTelegram("❌ Format: /ke 628xxx pesanmu");
        return;
      }
      try {
        await kirimKeWA(nomor, pesanBalas);
        await kirimKeTelegram(`✅ Terkirim ke ${nomor}:\n${pesanBalas}`);
      } catch (e) {
        await kirimKeTelegram(`❌ Gagal kirim. Error: ${e.response?.data?.message || e.message}`);
      }
    }

    else if (teks === "/info") {
      const daftarStr = Object.entries(daftarChat)
        .map(([n, nama]) => `• ${nama} (${n})`).join("\n") || "Belum ada";
      await kirimKeTelegram(
        `ℹ️ <b>WA Bridge Bot</b>\n\nNomor terakhir: ${nomorTerakhir || "belum ada"}\n\n` +
        `<b>Daftar chat:</b>\n${daftarStr}\n\n` +
        `<b>Perintah:</b>\n/balas [pesan]\n/ke [nomor] [pesan]\n/info`
      );
    }

    else if (teks === "/start") {
      await kirimKeTelegram(
        `👋 <b>WA Bridge Bot aktif!</b>\n\n` +
        `Pesan WA masuk akan diteruskan ke sini.\n\n` +
        `<b>Perintah:</b>\n/balas [pesan] - Balas ke pengirim terakhir\n` +
        `/ke [nomor] [pesan] - Kirim ke nomor tertentu\n/info - Lihat status`
      );
    }
  } catch (err) {
    console.error("Error webhook Telegram:", err.message);
  }
});

app.get("/", (req, res) => res.send("WA-Telegram Bridge aktif! ✅"));

app.listen(PORT, async () => {
  console.log(`Bridge WA-Telegram jalan di port ${PORT}`);
  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        { url: `${webhookUrl}/webhook/telegram` }
      );
      console.log("Telegram webhook diset ke:", webhookUrl);
    }
  } catch (err) {
    console.error("Gagal set webhook:", err.message);
  }
});
