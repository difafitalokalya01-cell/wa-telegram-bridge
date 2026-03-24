const express = require("express");
const fs = require("fs");
const axios = require("axios");
const logger = require("./logger");
const waManager = require("./wa-manager");
const queue = require("./queue");
const botBridge = require("./bot-bridge");
const botWa = require("./bot-wa");
const botConfig = require("./bot-config");
const botReminder = require("./bot-reminder");

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const app = express();
app.use(express.json());

// ===== CONFIG MANAGEMENT =====
const CONFIG_FILE = "./config.json";
const DATA_FILE = "./auth_sessions/data.json";

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      config.waAccounts = data.waAccounts || {};
      config.activeAccounts = data.activeAccounts || {};
      config.blacklist = data.blacklist || config.blacklist || [];
      config.queueSettings = data.queueSettings || config.queueSettings;
      config.reminderSettings = data.reminderSettings || config.reminderSettings;
    } catch (e) {
      logger.error("Index", `Gagal load data.json: ${e.message}`);
    }
  }
  return config;
}

function saveData(config) {
  try {
    const data = {
      waAccounts: config.waAccounts || {},
      activeAccounts: config.activeAccounts || {},
      blacklist: config.blacklist || [],
      queueSettings: config.queueSettings,
      reminderSettings: config.reminderSettings,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error("Index", `Gagal save data.json: ${e.message}`);
  }
}

global.loadConfig = loadConfig;
global.saveData = saveData;

const config = loadConfig();

const app2 = express();
app.use(express.json());

botBridge.setupCallbacks();
botWa.setupQRCallback();
queue.updateSettings(config.queueSettings);

// ===== WEBHOOK BOT BRIDGE =====
app.post("/webhook/bridge", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botBridge.prosesPerintah(msg);
  } catch (err) {
    logger.error("Index", `Error webhook bridge: ${err.message}`);
  }
});

// ===== WEBHOOK BOT WA =====
app.post("/webhook/wa", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botWa.prosesPerintah(msg);
  } catch (err) {
    logger.error("Index", `Error webhook wa: ${err.message}`);
  }
});

// ===== WEBHOOK BOT CONFIG =====
app.post("/webhook/config", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botConfig.prosesPerintah(msg);
  } catch (err) {
    logger.error("Index", `Error webhook config: ${err.message}`);
  }
});

// ===== WEBHOOK BOT REMINDER =====
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
      { token: config.botReminderToken, path: "reminder" },
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