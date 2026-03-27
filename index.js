const express   = require("express");
const logger    = require("./logger");
const store     = require("./store");
const waManager = require("./wa-manager");
const queue     = require("./queue");
const botBridge = require("./bot-bridge");
const botWa     = require("./bot-wa");
const botConfig = require("./bot-config");
const botReminder= require("./bot-reminder");
const axios     = require("axios");

const PORT        = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const app = express();
app.use(express.json());

// ===== LOAD CONFIG =====
const config = store.loadConfig();

// ===== GLOBAL ERROR HANDLER — bot tidak crash diam-diam =====
process.on("unhandledRejection", async (reason) => {
  const pesan = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logger.error("Index", `Unhandled Rejection: ${pesan}`);
  try {
    await botBridge.kirimError(`<b>Unhandled Error</b>\n\n<code>${pesan.slice(0, 1000)}</code>`);
  } catch (e) {}
});

process.on("uncaughtException", async (err) => {
  logger.error("Index", `Uncaught Exception: ${err.stack || err.message}`);
  try {
    await botBridge.kirimError(`<b>Uncaught Exception — Bot mungkin tidak stabil</b>\n\n<code>${(err.stack || err.message).slice(0, 1000)}</code>`);
  } catch (e) {}
  // Beri waktu kirim notif sebelum exit
  setTimeout(() => process.exit(1), 3000);
});

// ===== SETUP CALLBACKS — urutan penting: bridge dulu, baru wa =====
botBridge.setupCallbacks();
botWa.setupQRCallback();
queue.updateSettings(config.queueSettings);

// ===== WEBHOOK ROUTES =====
app.post("/webhook/bridge", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botBridge.prosesPerintah(msg);
  } catch (err) {
    logger.error("Index", `Error webhook bridge: ${err.message}`);
  }
});

app.post("/webhook/wa", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botWa.prosesPerintah(msg);
  } catch (err) {
    logger.error("Index", `Error webhook wa: ${err.message}`);
  }
});

app.post("/webhook/config", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botConfig.prosesPerintah(msg);
  } catch (err) {
    logger.error("Index", `Error webhook config: ${err.message}`);
  }
});

app.post("/webhook/reminder", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botReminder.prosesPerintah(msg);
  } catch (err) {
    logger.error("Index", `Error webhook reminder: ${err.message}`);
  }
});

// ===== HEALTH CHECK =====
app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    wa:      waManager.getStatus(),
    queue:   queue.getStatus(),
    uptime:  process.uptime(),
  });
});

app.get("/", (req, res) => res.send("WA-Telegram Bridge aktif! ✅"));

// ===== GRACEFUL SHUTDOWN =====
process.on("SIGTERM", () => { logger.info("Index", "SIGTERM diterima, shutdown..."); process.exit(0); });
process.on("SIGINT",  () => { logger.info("Index", "SIGINT diterima, shutdown...");  process.exit(0); });

// ===== START =====
app.listen(PORT, async () => {
  logger.info("Index", `Server jalan di port ${PORT}`);

  // Warning kalau WEBHOOK_URL tidak diset
  if (!WEBHOOK_URL) {
    logger.warn("Index", "WEBHOOK_URL tidak diset — bot tidak akan menerima pesan dari Telegram! Set env variable WEBHOOK_URL=https://domain-kamu.com");
  } else {
    const bots = [
      { token: config.botBridgeToken,  path: "bridge"  },
      { token: config.botWaToken,      path: "wa"      },
      { token: config.botConfigToken,  path: "config"  },
      { token: config.botReminderToken,path: "reminder" },
    ];

    for (const bot of bots) {
      try {
        await axios.post(`https://api.telegram.org/bot${bot.token}/setWebhook`, {
          url: `${WEBHOOK_URL}/webhook/${bot.path}`,
        });
        logger.info("Index", `Webhook diset untuk bot ${bot.path}`);
      } catch (err) {
        logger.error("Index", `Gagal set webhook ${bot.path}: ${err.message}`);
      }
    }
  }

  // Arsip chatlog lama saat start
  try {
    botBridge.arsipChatLogLama();
  } catch (e) {
    logger.error("Index", `Gagal arsip chatlog: ${e.message}`);
  }

  // Reconnect semua WA
  const accounts = config.waAccounts || {};
  for (const waId of Object.keys(accounts)) {
    if (config.activeAccounts[waId] === false) continue;
    logger.info("Index", `Reconnect ${waId}...`);
    try {
      await waManager.connectWA(waId);
    } catch (err) {
      logger.error("Index", `Gagal reconnect ${waId}: ${err.message}`);
    }
  }

  // Mulai sistem pengingat
  botReminder.mulaiPengingat();
});
