const express = require("express");
const fs = require("fs");
const axios = require("axios");
const logger = require("./logger");
const waManager = require("./wa-manager");
const queue = require("./queue");
const botBridge = require("./bot-bridge");
const botWa = require("./bot-wa");
const botConfig = require("./bot-config");

const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const app = express();
app.use(express.json());

botBridge.setupCallbacks();
botWa.setupQRCallback();
queue.updateSettings(config.queueSettings);

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

app.get("/health", (req, res) => {
  const waStatus = waManager.getStatus();
  const qStatus = queue.getStatus();
  res.json({
    status: "ok",
    wa: waStatus,
    queue: qStatus,
    uptime: process.uptime(),
  });
});

app.get("/", (req, res) => res.send("WA-Telegram Bridge aktif! ✅"));

process.on("SIGTERM", () => {
  logger.info("Index", "SIGTERM diterima, shutdown gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("Index", "SIGINT diterima, shutdown gracefully...");
  process.exit(0);
});

app.listen(PORT, async () => {
  logger.info("Index", `Server jalan di port ${PORT}`);

  if (WEBHOOK_URL) {
    const bots = [
      { token: config.botBridgeToken, path: "bridge" },
      { token: config.botWaToken, path: "wa" },
      { token: config.botConfigToken, path: "config" },
    ];

    for (const bot of bots) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${bot.token}/setWebhook`,
          { url: `${WEBHOOK_URL}/webhook/${bot.path}` }
        );
        logger.info("Index", `Webhook diset untuk bot ${bot.path}`);
      } catch (err) {
        logger.error("Index", `Gagal set webhook ${bot.path}: ${err.message}`);
      }
    }
  }

  const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
  const accounts = cfg.waAccounts || {};

  for (const waId of Object.keys(accounts)) {
    if (cfg.activeAccounts[waId] === false) continue;
    logger.info("Index", `Reconnect ${waId}...`);
    try {
      await waManager.connectWA(waId);
    } catch (err) {
      logger.error("Index", `Gagal reconnect ${waId}: ${err.message}`);
    }
  }
});