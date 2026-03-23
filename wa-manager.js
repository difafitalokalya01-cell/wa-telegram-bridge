const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const queue = require("./queue");

const AUTH_DIR = "./auth_sessions";
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

// Simpan semua instance WA yang aktif
const instances = {};

// Callback yang akan diisi oleh bot-bridge, bot-wa, dll
let onQR = null;
let onConnected = null;
let onDisconnected = null;
let onMessage = null;
let onMedia = null;
let onUnreadFound = null;

function setCallbacks(callbacks) {
  if (callbacks.onQR) onQR = callbacks.onQR;
  if (callbacks.onConnected) onConnected = callbacks.onConnected;
  if (callbacks.onDisconnected) onDisconnected = callbacks.onDisconnected;
  if (callbacks.onMessage) onMessage = callbacks.onMessage;
  if (callbacks.onMedia) onMedia = callbacks.onMedia;
  if (callbacks.onUnreadFound) onUnreadFound = callbacks.onUnreadFound;
}

async function connectWA(waId) {
  const authPath = path.join(AUTH_DIR, waId);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: [`WA-Bridge-${waId}`, "Chrome", "1.0.0"],
  });

  instances[waId] = { sock, status: "connecting", jid: null };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("WA-Manager", `QR diterima untuk ${waId}`);
      if (onQR) await onQR(waId, qr);
    }

    if (connection === "open") {
      const jid = sock.user?.id || "";
      instances[waId].status = "connected";
      instances[waId].jid = jid;
      logger.info("WA-Manager", `${waId} terhubung sebagai ${jid}`);
      if (onConnected) await onConnected(waId, jid);

      // Scan unread chat setelah terhubung
      setTimeout(() => scanUnread(waId), 5000);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      instances[waId].status = "disconnected";
      logger.warn("WA-Manager", `${waId} terputus. Reconnect: ${shouldReconnect}`);
      if (onDisconnected) await onDisconnected(waId, shouldReconnect);

      if (shouldReconnect) {
        logger.info("WA-Manager", `Mencoba reconnect ${waId} dalam 5 detik...`);
        setTimeout(() => connectWA(waId), 5000);
      } else {
        delete instances[waId];
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid.endsWith("@g.us")) continue;

        const jid = msg.key.remoteJid;
        const pushName = msg.pushName || jid.replace(/@.*/, "");

        // Cek apakah pesan mengandung media
        const mediaTypes = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"];
        const mediaType = mediaTypes.find((t) => msg.message?.[t]);

        if (mediaType) {
          // Proses media
          try {
            const buffer = await downloadMediaMessage(msg, "buffer", {});
            const ext = {
              imageMessage: "jpg",
              videoMessage: "mp4",
              documentMessage: msg.message.documentMessage?.fileName?.split(".").pop() || "bin",
              audioMessage: "ogg",
            }[mediaType];

            const caption = msg.message[mediaType]?.caption || "";

            if (onMedia) {
              await onMedia(waId, jid, pushName, buffer, ext, mediaType, caption);
            }
          } catch (err) {
            logger.error("WA-Manager", `Gagal download media dari ${jid}: ${err.message}`);
          }
        } else {
          // Proses teks biasa
          const pesan =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "[Pesan tidak dikenali]";

          if (onMessage) {
            await onMessage(waId, jid, pushName, pesan);
          }
        }
      } catch (err) {
        logger.error("WA-Manager", `Error proses pesan: ${err.message}`);
      }
    }
  });

  // Set fungsi kirim ke queue
  queue.setSendFunction(kirimPesan);

  return sock;
}

async function scanUnread(waId) {
  try {
    const sock = instances[waId]?.sock;
    if (!sock) return;

    // Ambil semua chat
    const chats = await sock.groupFetchAllParticipating();
    // Filter private chat unread (bukan grup)
    // Baileys menyimpan unread count di store, kita ambil dari chat store
    const store = sock.store || null;
    if (!store) return;

    const unreadChats = [];
    for (const [jid, chat] of Object.entries(store.chats.all() || {})) {
      if (jid.endsWith("@g.us")) continue;
      if (chat.unreadCount > 0) {
        unreadChats.push({ jid, unreadCount: chat.unreadCount, name: chat.name || jid.replace(/@.*/, "") });
      }
    }

    if (unreadChats.length > 0 && onUnreadFound) {
      await onUnreadFound(waId, unreadChats);
    }
  } catch (err) {
    logger.error("WA-Manager", `Gagal scan unread ${waId}: ${err.message}`);
  }
}

async function kirimPesan(waId, jid, pesan, media = null) {
  const sock = instances[waId]?.sock;
  if (!sock) throw new Error(`${waId} tidak terhubung`);

  if (media) {
    await sock.sendMessage(jid, media);
  } else {
    await sock.sendMessage(jid, { text: pesan });
  }
}

async function disconnectWA(waId) {
  const sock = instances[waId]?.sock;
  if (!sock) throw new Error(`${waId} tidak ditemukan`);

  await sock.logout();
  delete instances[waId];

  // Hapus session
  const authPath = path.join(AUTH_DIR, waId);
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { recursive: true });
  }

  logger.info("WA-Manager", `${waId} berhasil dihapus`);
}

function getStatus() {
  const result = {};
  for (const [waId, instance] of Object.entries(instances)) {
    result[waId] = {
      status: instance.status,
      jid: instance.jid,
    };
  }
  return result;
}

function getInstance(waId) {
  return instances[waId] || null;
}

function getAllIds() {
  return Object.keys(instances);
}

module.exports = {
  connectWA,
  disconnectWA,
  kirimPesan,
  getStatus,
  getInstance,
  getAllIds,
  setCallbacks,
};
