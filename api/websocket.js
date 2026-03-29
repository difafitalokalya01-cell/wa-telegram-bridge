"use strict";
/**
 * FILE: api/websocket.js
 * FUNGSI: WebSocket server untuk realtime update ke dashboard
 *
 * DIGUNAKAN OLEH: index.js (setup saat startup)
 * MENGGUNAKAN: core/events.js, api/middleware.js
 *
 * EVENT YANG DITERUSKAN KE DASHBOARD:
 * - kandidat:dibuat      → notif kandidat baru
 * - kandidat:diupdate    → update status kandidat
 * - kandidat:media_masuk → notif media baru
 * - wa:terhubung         → status WA online
 * - wa:terputus          → status WA offline
 * - pesan:terkirim       → konfirmasi pesan terkirim
 *
 * PROTOKOL:
 * Client kirim: { type: "auth", token: "JWT_TOKEN" }
 * Server balas: { type: "auth_ok" } atau { type: "auth_fail" }
 * Server push:  { type: "event", event: "nama_event", data: {...} }
 * Server ping:  { type: "ping" } — client harus balas { type: "pong" }
 */

const { WebSocketServer } = require("ws");
const events   = require("../core/events");
const { verifyToken } = require("./middleware");
const logger   = require("../logger");

// Semua client yang terkoneksi dan sudah auth
const clients  = new Set();

/**
 * setupWebSocket(server)
 * Inisialisasi WebSocket server dari HTTP server yang sudah ada.
 * Dipanggil dari index.js setelah app.listen.
 *
 * DIGUNAKAN OLEH: index.js
 */
function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let authed = false;
    logger.info("WebSocket", `Client baru terhubung dari ${req.socket.remoteAddress}`);

    // Timeout auth — kalau tidak auth dalam 10 detik, tutup koneksi
    const authTimeout = setTimeout(() => {
      if (!authed) {
        ws.send(JSON.stringify({ type: "auth_fail", reason: "Timeout" }));
        ws.close();
      }
    }, 10000);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "auth") {
          const payload = verifyToken(msg.token);
          if (!payload) {
            ws.send(JSON.stringify({ type: "auth_fail", reason: "Invalid token" }));
            ws.close();
            return;
          }
          authed = true;
          clearTimeout(authTimeout);
          clients.add(ws);
          ws.send(JSON.stringify({ type: "auth_ok" }));
          logger.info("WebSocket", "Client berhasil auth");
        }

        if (msg.type === "pong") {
          // Terima pong dari client — koneksi masih hidup
        }

      } catch(err) {
        logger.error("WebSocket", `Error parse message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      clearTimeout(authTimeout);
      logger.info("WebSocket", "Client terputus");
    });

    ws.on("error", (err) => {
      logger.error("WebSocket", `Client error: ${err.message}`);
      clients.delete(ws);
    });
  });

  // Ping semua client setiap 30 detik untuk cek koneksi masih hidup
  setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      } else {
        clients.delete(ws);
      }
    }
  }, 30000);

  // ── Forward semua event ke dashboard ──────────────────────
  const eventsToPush = [
    "kandidat:dibuat",
    "kandidat:diupdate",
    "kandidat:media_masuk",
    "kandidat:unread_ringkasan",
    "wa:terhubung",
    "wa:terputus",
    "wa:qr_diterima",
    "pesan:terkirim",
    "pesan:gagal",
  ];

  for (const eventName of eventsToPush) {
    events.on(eventName, (data) => {
      broadcast(eventName, data);
    });
  }

  logger.info("WebSocket", "WebSocket server aktif di /ws ✅");
  return wss;
}

/**
 * broadcast(event, data)
 * Kirim data ke semua client yang terkoneksi dan sudah auth.
 */
function broadcast(event, data) {
  const msg = JSON.stringify({
    type:  "event",
    event,
    data:  sanitizeData(data),
    ts:    Date.now(),
  });

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch(e) { clients.delete(ws); }
    }
  }
}

/**
 * sanitizeData(data)
 * Hapus buffer/binary data sebelum dikirim ke client
 * agar tidak crash saat JSON.stringify
 */
function sanitizeData(data) {
  if (!data) return data;
  const clean = { ...data };
  if (clean.buffer) delete clean.buffer; // Hapus buffer media
  return clean;
}

function getClientCount() { return clients.size; }

module.exports = { setupWebSocket, broadcast, getClientCount };
