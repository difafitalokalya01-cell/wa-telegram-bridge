const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino   = require("pino");
const fs     = require("fs");
const path   = require("path");
const logger = require("./logger");
const queue  = require("./queue");
const store  = require("./store");

const AUTH_DIR = "./auth_sessions";
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

const instances = {};

// ===== RETRY STATE per waId =====
const retryCount = {};
const MAX_RETRY  = 10;
const BASE_DELAY = 5000;    // 5 detik
const MAX_DELAY  = 600000;  // 10 menit

let onQR           = null;
let onPairingCode  = null;
let onConnected    = null;
let onDisconnected = null;
let onMessage      = null;
let onMedia        = null;
let onUnreadFound  = null;

function setCallbacks(callbacks) {
  if (callbacks.onQR)           onQR           = callbacks.onQR;
  if (callbacks.onPairingCode)  onPairingCode  = callbacks.onPairingCode;
  if (callbacks.onConnected)    onConnected    = callbacks.onConnected;
  if (callbacks.onDisconnected) onDisconnected = callbacks.onDisconnected;
  if (callbacks.onMessage)      onMessage      = callbacks.onMessage;
  if (callbacks.onMedia)        onMedia        = callbacks.onMedia;
  if (callbacks.onUnreadFound)  onUnreadFound  = callbacks.onUnreadFound;
}

// ===== NORMALISASI JID — satu tempat, konsisten =====
function normalizeJid(jid) {
  if (!jid) return jid;
  return jid.includes(":") ? jid.split(":")[0] + "@s.whatsapp.net" : jid;
}

// ===== CEK BLACKLIST =====
function isBlacklisted(jid) {
  const cfg   = store.getConfig();
  const nomor = jid.replace(/@.*/, "");
  return (cfg.blacklist || []).includes(nomor);
}

// ===== HITUNG DELAY BACKOFF =====
function getRetryDelay(waId) {
  const count = retryCount[waId] || 0;
  return Math.min(BASE_DELAY * Math.pow(2, count), MAX_DELAY);
}

async function setPresence(waId, jid, status) {
  const sock = instances[waId]?.sock;
  if (!sock) return;
  try {
    await sock.sendPresenceUpdate(status, jid);
  } catch (e) {
    logger.error("WA-Manager", `Gagal set presence: ${e.message}`);
  }
}

async function connectWA(waId, usePairingCode = false, nomorPonsel = null) {
  const authPath = path.join(AUTH_DIR, waId);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: [`WA-Bridge-${waId}`, "Chrome", "1.0.0"],
    printQRInTerminal: false,
  });

  instances[waId] = { sock, status: "connecting", jid: null };

  queue.setPresenceFunction(setPresence);
  queue.setSendFunction(kirimPesan);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      logger.info("WA-Manager", `QR diterima untuk ${waId}`);
      if (onQR) await onQR(waId, qr);
    }

    if (connection === "open") {
      const jid              = normalizeJid(sock.user?.id || "");
      instances[waId].status = "connected";
      instances[waId].jid    = jid;
      retryCount[waId]       = 0;
      logger.info("WA-Manager", `${waId} terhubung sebagai ${jid}`);
      if (onConnected) await onConnected(waId, jid);
    }

    if (connection === "close") {
      const statusCode      = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut     = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = !isLoggedOut;

      instances[waId].status = "disconnected";
      logger.warn("WA-Manager", `${waId} terputus (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

      if (onDisconnected) await onDisconnected(waId, shouldReconnect);

      if (shouldReconnect) {
        const currentRetry = retryCount[waId] || 0;

        if (currentRetry >= MAX_RETRY) {
          logger.error("WA-Manager", `${waId} gagal reconnect ${MAX_RETRY}x — berhenti.`);
          if (onDisconnected) await onDisconnected(waId, false, true);
          delete instances[waId];
          return;
        }

        const delay = getRetryDelay(waId);
        retryCount[waId] = currentRetry + 1;
        logger.info("WA-Manager", `${waId} reconnect dalam ${Math.round(delay/1000)}s (ke-${currentRetry + 1}/${MAX_RETRY})`);
        setTimeout(() => connectWA(waId), delay);
      } else {
        delete instances[waId];
        delete retryCount[waId];
      }
    }
  });

  // ===== HISTORY SYNC =====
  sock.ev.on("messaging-history.set", async ({ chats, isLatest }) => {
    if (!isLatest) return;
    try {
      const unreadChats = chats.filter((c) => c.unreadCount > 0 && !c.id.endsWith("@g.us"));
      if (unreadChats.length > 0 && onUnreadFound) {
        logger.info("WA-Manager", `${waId}: ${unreadChats.length} unread dari history sync`);
        await onUnreadFound(waId, unreadChats.map((c) => ({
          jid:         normalizeJid(c.id),
          unreadCount: c.unreadCount,
          name:        c.name || c.id.replace(/@.*/, ""),
        })));
      }
    } catch (err) {
      logger.error("WA-Manager", `Gagal proses history sync: ${err.message}`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid.endsWith("@g.us")) continue;

        const jid      = normalizeJid(msg.key.remoteJid);
        const pushName = msg.pushName || jid.replace(/@.*/, "");

        // ===== CEK BLACKLIST =====
        if (isBlacklisted(jid)) {
          logger.info("WA-Manager", `Pesan dari ${jid} diblokir (blacklist)`);
          continue;
        }

        // ===== AUTO READ =====
        try {
          await sock.readMessages([msg.key]);
        } catch (e) {
          logger.error("WA-Manager", `Gagal auto read: ${e.message}`);
        }

        const mediaTypes = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"];
        const mediaType  = mediaTypes.find((t) => msg.message?.[t]);

        if (mediaType) {
          try {
            const buffer  = await downloadMediaMessage(msg, "buffer", {});
            const ext     = {
              imageMessage:    "jpg",
              videoMessage:    "mp4",
              documentMessage: msg.message.documentMessage?.fileName?.split(".").pop() || "bin",
              audioMessage:    "ogg",
            }[mediaType];
            const caption = msg.message[mediaType]?.caption || "";
            if (onMedia) await onMedia(waId, jid, pushName, buffer, ext, mediaType, caption);
          } catch (err) {
            logger.error("WA-Manager", `Gagal download media dari ${jid}: ${err.message}`);
          }
        } else {
          const pesan =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "[Pesan tidak dikenali]";
          if (onMessage) await onMessage(waId, jid, pushName, pesan);
        }
      } catch (err) {
        logger.error("WA-Manager", `Error proses pesan: ${err.message}`);
      }
    }
  });

  if (usePairingCode && nomorPonsel && !sock.authState.creds.registered) {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const code = await sock.requestPairingCode(nomorPonsel);
      logger.info("WA-Manager", `Pairing code untuk ${waId}: ${code}`);
      if (onPairingCode) await onPairingCode(waId, code, nomorPonsel);
    } catch (err) {
      logger.error("WA-Manager", `Gagal request pairing code ${waId}: ${err.message}`);
      if (onPairingCode) await onPairingCode(waId, null, nomorPonsel, err.message);
    }
  }

  return sock;
}

async function kirimPesan(waId, jid, pesan, media = null) {
  const sock      = instances[waId]?.sock;
  if (!sock) throw new Error(`${waId} tidak terhubung`);
  const jidNormal = normalizeJid(jid);

  if (!media) {
    try {
      const [result] = await sock.onWhatsApp(jidNormal.replace("@s.whatsapp.net", ""));
      if (!result?.exists) throw new Error("NOMOR_TIDAK_AKTIF");
    } catch (err) {
      if (err.message === "NOMOR_TIDAK_AKTIF") throw err;
    }
  }

  if (media) {
    await sock.sendMessage(jidNormal, media);
  } else {
    await sock.sendMessage(jidNormal, { text: pesan });
  }
}

async function cekNomorAktif(waId, jid) {
  const sock = instances[waId]?.sock;
  if (!sock) return false;
  try {
    const jidNormal = normalizeJid(jid);
    const [result]  = await sock.onWhatsApp(jidNormal.replace("@s.whatsapp.net", ""));
    return result?.exists || false;
  } catch (err) {
    return false;
  }
}

async function disconnectWA(waId) {
  const sock = instances[waId]?.sock;
  if (!sock) throw new Error(`${waId} tidak ditemukan`);
  await sock.logout();
  delete instances[waId];
  delete retryCount[waId];
  const authPath = path.join(AUTH_DIR, waId);
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true });
  logger.info("WA-Manager", `${waId} berhasil dihapus`);
}

function getStatus() {
  const result = {};
  for (const [waId, instance] of Object.entries(instances)) {
    result[waId] = { status: instance.status, jid: instance.jid };
  }
  return result;
}

function getInstance(waId) { return instances[waId] || null; }
function getAllIds()        { return Object.keys(instances); }

module.exports = {
  connectWA, disconnectWA, kirimPesan, cekNomorAktif,
  setPresence, getStatus, getInstance, getAllIds,
  setCallbacks, normalizeJid,
};
