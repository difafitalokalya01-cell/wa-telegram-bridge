"use strict";
/**
 * FILE: index.js
 * FUNGSI: Entry point utama — startup, webhook, dan orchestration
 *
 * URUTAN STARTUP:
 * 1. Koneksi database (Postgres)
 * 2. Setup tabel kalau belum ada
 * 3. Koneksi cache (Redis)
 * 4. Register semua event handlers
 * 5. Inject wa-manager ke semua bot dan queue
 * 6. Setup Express webhook
 * 7. Start server
 * 8. Set webhook Telegram
 * 9. Reconnect semua WA yang aktif
 * 10. Mulai sistem pengingat
 * 11. Arsip kandidat lama
 *
 * DIGUNAKAN OLEH: Railway (start command: node index.js)
 * MENGGUNAKAN: Semua file di core/, services/, handlers/, bots/
 *
 * DEPENDENCY MAP:
 * Mengubah urutan startup bisa menyebabkan komponen
 * tidak siap saat dibutuhkan — hati-hati dengan urutan di bawah
 */

const express = require("express");
const axios   = require("axios");
const path    = require("path");
const logger  = require("./logger");

// ── API & Dashboard ────────────────────────────────────────────
const middleware  = require("./api/middleware");
const apiKandidat = require("./api/kandidat");
const wsServer    = require("./api/websocket");

// ── Core ───────────────────────────────────────────────────────
const db     = require("./core/database");
const cache  = require("./core/cache");
const events = require("./core/events");

// ── Services ───────────────────────────────────────────────────
const waManager = require("./services/wa-manager");
const queue     = require("./services/queue");

// ── Handlers ──────────────────────────────────────────────────
const pesanHandler = require("./handlers/pesan-handler");
const mediaHandler = require("./handlers/media-handler");
const notifHandler = require("./handlers/notif-handler");

// ── Bots ──────────────────────────────────────────────────────
const botBridge  = require("./bots/bot-bridge");
const botWa      = require("./bots/bot-wa");
const botConfig  = require("./bots/bot-config");
const botReminder= require("./bots/bot-reminder");
const botGlobal  = require("./bots/bot-global");
const botPool    = require("./bots/bot-pool");

// ── Config ────────────────────────────────────────────────────
const fs          = require("fs");
const PORT        = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

let _config = null;
function getConfig() {
  if (!_config) _config = JSON.parse(fs.readFileSync("./config.json","utf-8"));
  return _config;
}

// ══════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// Tangkap semua error yang tidak tertangani agar tidak crash
// ══════════════════════════════════════════════════════════════
process.on("unhandledRejection", async (reason) => {
  const pesan = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logger.error("Index", `Unhandled Rejection: ${pesan}`);
  try { await notifHandler.kirimError(`<b>Unhandled Error</b>\n\n<code>${pesan.slice(0,1000)}</code>`); } catch(e) {}
});

process.on("uncaughtException", async (err) => {
  logger.error("Index", `Uncaught Exception: ${err.stack || err.message}`);
  try { await notifHandler.kirimError(`<b>Uncaught Exception</b>\n\n<code>${(err.stack||err.message).slice(0,1000)}</code>`); } catch(e) {}
  setTimeout(() => process.exit(1), 3000);
});

// ══════════════════════════════════════════════════════════════
// EXPRESS APP
// ══════════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

// ── Static dashboard files ─────────────────────────────────────
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));
app.get("/dashboard", (req, res) => res.redirect("/dashboard/login.html"));

// ── Login endpoint (tidak butuh auth) ─────────────────────────
app.post("/api/login", middleware.rateLimit, middleware.handleLogin);

// ── API endpoints (butuh auth) ────────────────────────────────
app.get ("/api/kandidat",         middleware.authRequired, apiKandidat.getDaftarKandidat);
app.get ("/api/kandidat/:id",     middleware.authRequired, apiKandidat.getDetailKandidat);
app.post("/api/kandidat/:id/balas",   middleware.authRequired, apiKandidat.balasKandidat);
app.post("/api/kandidat/:id/selesai", middleware.authRequired, apiKandidat.selesaikanKandidat);
app.post("/api/kandidat/:id/catat",   middleware.authRequired, apiKandidat.catatKandidat);
app.post("/api/kandidat/:id/fixjid",  middleware.authRequired, apiKandidat.fixJidKandidat);
app.get ("/api/stats",            middleware.authRequired, apiKandidat.getStats);
app.post("/api/kirim",            middleware.authRequired, apiKandidat.kirimKeNomorBaru);
app.get ("/api/wa/status",        middleware.authRequired, apiKandidat.getWaStatus);
app.post("/api/wa/qr/:waId",      middleware.authRequired, apiKandidat.requestQR);
app.get ("/api/antrian",          middleware.authRequired, apiKandidat.getAntrian);
app.get ("/api/blacklist",        middleware.authRequired, apiKandidat.getBlacklist);
app.post("/api/blacklist",        middleware.authRequired, apiKandidat.tambahBlacklist);
app.delete("/api/blacklist/:nomor", middleware.authRequired, apiKandidat.hapusBlacklist);

// ── WA Management API ──────────────────────────────────────────
app.post("/api/kandidat/:id/sync", middleware.authRequired, apiKandidat.syncChatKandidat);
app.post("/api/wa/sync-unread/:waId", middleware.authRequired, apiKandidat.syncUnreadWA);
app.get ("/api/wa/accounts",      middleware.authRequired, apiKandidat.getWaAccounts);
app.post("/api/wa/daftar",        middleware.authRequired, apiKandidat.daftarWA);
app.post("/api/wa/putus/:waId",   middleware.authRequired, apiKandidat.putuskanWA);

// ── Settings API ───────────────────────────────────────────────
app.get ("/api/settings/reminder",middleware.authRequired, apiKandidat.getReminderSettings);
app.post("/api/settings/reminder",middleware.authRequired, apiKandidat.setReminderSettings);

// ── Webhook bot bridge ─────────────────────────────────────────
app.post("/webhook/bridge", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botBridge.prosesPerintah(msg);
  } catch(err) { logger.error("Index", `Error webhook bridge: ${err.message}`); }
});

// ── Webhook bot wa ─────────────────────────────────────────────
app.post("/webhook/wa", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botWa.prosesPerintah(msg);
  } catch(err) { logger.error("Index", `Error webhook wa: ${err.message}`); }
});

// ── Webhook bot config ─────────────────────────────────────────
app.post("/webhook/config", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botConfig.prosesPerintah(msg);
  } catch(err) { logger.error("Index", `Error webhook config: ${err.message}`); }
});

// ── Webhook bot reminder ───────────────────────────────────────
app.post("/webhook/reminder", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botReminder.prosesPerintah(msg);
  } catch(err) { logger.error("Index", `Error webhook reminder: ${err.message}`); }
});

// ── Webhook bot global ─────────────────────────────────────────
app.post("/webhook/global", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg) await botGlobal.prosesPerintah(msg);
  } catch(err) { logger.error("Index", `Error webhook global: ${err.message}`); }
});

// ── Webhook bot pool (dinamis per slot) ───────────────────────
app.post("/webhook/pool/:poolId", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg    = req.body?.message;
    const poolId = req.params.poolId;
    if (msg && poolId) await botPool.prosesPerintahPool(msg, poolId);
  } catch(err) { logger.error("Index", `Error webhook pool: ${err.message}`); }
});

// ── Health check ───────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    const [dbOk, cacheOk] = await Promise.allSettled([db.ping(), cache.ping()]);
    res.json({
      status:   "ok",
      database: dbOk.status === "fulfilled" ? "ok" : "error",
      cache:    cacheOk.status === "fulfilled" ? "ok" : "error",
      wa:       waManager.getStatus(),
      queue:    await queue.getStatus(),
      uptime:   process.uptime(),
    });
  } catch(err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/", (req, res) => res.send("WA-Telegram Bridge v2 aktif! ✅"));

// ── Graceful shutdown ──────────────────────────────────────────
process.on("SIGTERM", () => { logger.info("Index","SIGTERM..."); process.exit(0); });
process.on("SIGINT",  () => { logger.info("Index","SIGINT...");  process.exit(0); });

// ══════════════════════════════════════════════════════════════
// SET WEBHOOK TELEGRAM
// ══════════════════════════════════════════════════════════════
async function setWebhookTelegram() {
  if (!WEBHOOK_URL) {
    logger.warn("Index","WEBHOOK_URL tidak diset — bot tidak akan menerima pesan!");
    return;
  }

  const cfg = getConfig();

  // Bot lama (bridge, wa, config, reminder, global)
  const botsLama = [
    { token: cfg.botBridgeToken || cfg.botPool?.find(p=>p.id==="pool_3")?.token, path: "bridge" },
    { token: cfg.botWaToken,      path: "wa"       },
    { token: cfg.botConfigToken,  path: "config"   },
    { token: cfg.botReminderToken,path: "reminder" },
    { token: cfg.botGlobalToken,  path: "global"   },
  ];

  for (const bot of botsLama) {
    if (!bot.token || bot.token.startsWith("GANTI")) continue;
    try {
      await axios.post(`https://api.telegram.org/bot${bot.token}/setWebhook`, {
        url: `${WEBHOOK_URL}/webhook/${bot.path}`,
      });
      logger.info("Index", `Webhook diset: ${bot.path}`);
    } catch(err) {
      logger.error("Index", `Gagal set webhook ${bot.path}: ${err.message}`);
    }
  }

  // Bot pool (dinamis per slot)
  for (const slot of (cfg.botPool || [])) {
    if (!slot.token || slot.token.startsWith("GANTI")) continue;
    try {
      await axios.post(`https://api.telegram.org/bot${slot.token}/setWebhook`, {
        url: `${WEBHOOK_URL}/webhook/pool/${slot.id}`,
      });
      logger.info("Index", `Webhook pool diset: ${slot.id}`);
    } catch(err) {
      logger.error("Index", `Gagal set webhook pool ${slot.id}: ${err.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// STARTUP UTAMA
// ══════════════════════════════════════════════════════════════
const httpServer = app.listen(PORT, async () => {
  logger.info("Index", `Server jalan di port ${PORT}`);

  try {
    // ── 1. Setup database ──────────────────────────────────
    logger.info("Index", "Setup database...");
    await db.setupTabel();

    // ── 2. Test koneksi Redis ──────────────────────────────
    logger.info("Index", "Test koneksi Redis...");
    await cache.ping();
    logger.info("Index", "Redis terhubung ✅");

    // ── 3. Register semua event handlers ──────────────────
    // URUTAN PENTING: handlers harus didaftarkan sebelum
    // wa-manager mulai emit events
    logger.info("Index", "Register handlers...");
    pesanHandler.registerHandlers();
    mediaHandler.registerHandlers();
    notifHandler.registerHandlers();

    // ── 4. Inject wa-manager ke semua komponen ─────────────
    // Dilakukan lewat setter untuk hindari circular dependency
    logger.info("Index", "Inject dependencies...");
    queue.setWaManager(waManager);
    apiKandidat.setWaManager(waManager);
    botBridge.setWaManager(waManager);
    botWa.setWaManager(waManager);
    botReminder.setWaManager(waManager);
    botGlobal.setWaManager(waManager);
    botPool.setWaManager(waManager);

    // ── 5. Setup callbacks QR dan pairing dari bot-wa ──────
    botWa.setupCallbacks();

    // ── 6. Set webhook Telegram ────────────────────────────
    logger.info("Index", "Set webhook Telegram...");
    await setWebhookTelegram();

    // ── 7. Reconnect semua WA yang aktif ───────────────────
    logger.info("Index", "Reconnect akun WA...");
    const accounts = await db.getWaAccounts();
    for (const akun of accounts) {
      if (!akun.aktif) {
        logger.info("Index", `Skip ${akun.wa_id} — dinonaktifkan`);
        continue;
      }
      logger.info("Index", `Reconnect ${akun.wa_id}...`);
      try {
        await waManager.connectWA(akun.wa_id);
      } catch(err) {
        logger.error("Index", `Gagal reconnect ${akun.wa_id}: ${err.message}`);
      }
    }

    // ── 8. Lanjutkan antrian yang tersisa di Redis ─────────
    logger.info("Index", "Cek antrian tersisa...");
    await queue.mulaiProsesAntrian();

    // ── 9. Mulai sistem pengingat ──────────────────────────
    botReminder.mulaiPengingat();

    // ── 10. Arsip kandidat lama (selesai > 30 hari) ────────
    try { await db.arsipKandidatLama(); } catch(e) {}

    // ── Setup WebSocket server ────────────────────────────
    wsServer.setupWebSocket(httpServer);

    logger.info("Index", "Semua sistem aktif ✅");
    logger.info("Index", `Dashboard: ${WEBHOOK_URL}/dashboard`);

  } catch(err) {
    logger.error("Index", `Error startup: ${err.message}`);
    process.exit(1);
  }
});
