const express    = require("express");
const logger     = require("./logger");
const store      = require("./store");
const waManager  = require("./wa-manager");
const queue      = require("./queue");
const botBridge  = require("./bot-bridge");
const botWa      = require("./bot-wa");
const botConfig  = require("./bot-config");
const botReminder= require("./bot-reminder");
const botGlobal  = require("./bot-global");
const botPool    = require("./bot-pool");
const axios      = require("axios");

const PORT        = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const app = express();
app.use(express.json());

const config = store.loadConfig();

// ===== GLOBAL ERROR HANDLER =====
process.on("unhandledRejection", async (reason) => {
  const pesan = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logger.error("Index", `Unhandled Rejection: ${pesan}`);
  try { await botBridge.kirimError(`<b>Unhandled Error</b>\n\n<code>${pesan.slice(0, 1000)}</code>`); } catch (e) {}
});

process.on("uncaughtException", async (err) => {
  logger.error("Index", `Uncaught Exception: ${err.stack || err.message}`);
  try { await botBridge.kirimError(`<b>Uncaught Exception</b>\n\n<code>${(err.stack || err.message).slice(0, 1000)}</code>`); } catch (e) {}
  setTimeout(() => process.exit(1), 3000);
});

// ===== SETUP CALLBACKS =====
botBridge.setupCallbacks();
botWa.setupQRCallback();
queue.updateSettings(config.queueSettings);

// ===== WEBHOOK BOT LAMA (config, reminder, wa) =====
app.post("/webhook/bridge", async (req, res) => {
  res.sendStatus(200);
  try { const msg = req.body?.message; if (msg) await botBridge.prosesPerintah(msg); }
  catch (err) { logger.error("Index", `Error webhook bridge: ${err.message}`); }
});

app.post("/webhook/wa", async (req, res) => {
  res.sendStatus(200);
  try { const msg = req.body?.message; if (msg) await botWa.prosesPerintah(msg); }
  catch (err) { logger.error("Index", `Error webhook wa: ${err.message}`); }
});

app.post("/webhook/config", async (req, res) => {
  res.sendStatus(200);
  try { const msg = req.body?.message; if (msg) await botConfig.prosesPerintah(msg); }
  catch (err) { logger.error("Index", `Error webhook config: ${err.message}`); }
});

app.post("/webhook/reminder", async (req, res) => {
  res.sendStatus(200);
  try { const msg = req.body?.message; if (msg) await botReminder.prosesPerintah(msg); }
  catch (err) { logger.error("Index", `Error webhook reminder: ${err.message}`); }
});

// ===== WEBHOOK BOT GLOBAL =====
app.post("/webhook/global", async (req, res) => {
  res.sendStatus(200);
  try { const msg = req.body?.message; if (msg) await botGlobal.prosesPerintah(msg); }
  catch (err) { logger.error("Index", `Error webhook global: ${err.message}`); }
});

// ===== WEBHOOK BOT POOL (dinamis per slot) =====
app.post("/webhook/pool/:poolId", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg    = req.body?.message;
    const poolId = req.params.poolId;
    if (msg && poolId) await botPool.prosesPerintahPool(msg, poolId);
  } catch (err) { logger.error("Index", `Error webhook pool: ${err.message}`); }
});

// ===== HEALTH CHECK =====
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wa:     waManager.getStatus(),
    queue:  queue.getStatus(),
    pool:   (store.getConfig().botPool || []).map((p) => ({
      id: p.id, nama: p.nama, status: p.status, waId: p.waId,
    })),
    uptime: process.uptime(),
  });
});

app.get("/", (req, res) => res.send("WA-Telegram Bridge aktif! ✅"));

process.on("SIGTERM", () => { logger.info("Index", "SIGTERM..."); process.exit(0); });
process.on("SIGINT",  () => { logger.info("Index", "SIGINT...");  process.exit(0); });

// ===== START =====
app.listen(PORT, async () => {
  logger.info("Index", `Server jalan di port ${PORT}`);

  if (!WEBHOOK_URL) {
    logger.warn("Index", "WEBHOOK_URL tidak diset — bot tidak akan menerima pesan dari Telegram!");
  } else {
    // Set webhook bot lama
    const botsLama = [
      { token: config.botBridgeToken || (config.botPool?.find(p => p.id === "pool_3")?.token), path: "bridge" },
      { token: config.botWaToken,       path: "wa"      },
      { token: config.botConfigToken,   path: "config"  },
      { token: config.botReminderToken, path: "reminder" },
      { token: config.botGlobalToken,   path: "global"  },
    ];

    for (const bot of botsLama) {
      if (!bot.token || bot.token.startsWith("GANTI")) continue;
      try {
        await axios.post(`https://api.telegram.org/bot${bot.token}/setWebhook`, {
          url: `${WEBHOOK_URL}/webhook/${bot.path}`,
        });
        logger.info("Index", `Webhook diset: ${bot.path}`);
      } catch (err) {
        logger.error("Index", `Gagal set webhook ${bot.path}: ${err.message}`);
      }
    }

    // Set webhook bot pool
    for (const slot of (config.botPool || [])) {
      if (!slot.token || slot.token.startsWith("GANTI")) continue;
      try {
        await botPool.setWebhookSlot(slot.token, WEBHOOK_URL, slot.id);
      } catch (err) {
        logger.error("Index", `Gagal set webhook pool ${slot.id}: ${err.message}`);
      }
    }
  }

  // Arsip chatlog lama
  try { botBridge.arsipChatLogLama(); } catch (e) {}

  // Reconnect semua WA — skip yang sudah logout permanen
  const accounts = config.waAccounts || {};
  for (const waId of Object.keys(accounts)) {
    if (config.activeAccounts?.[waId] === false) {
      logger.info("Index", `Skip ${waId} — dinonaktifkan`);
      continue;
    }
    logger.info("Index", `Reconnect ${waId}...`);
    try {
      await waManager.connectWA(waId);
    } catch (err) {
      logger.error("Index", `Gagal reconnect ${waId}: ${err.message}`);
    }
  }

  botReminder.mulaiPengingat();
  logger.info("Index", "Semua sistem aktif ✅");
});
