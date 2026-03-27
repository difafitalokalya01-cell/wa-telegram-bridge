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

const instances  = {};
const retryCount = {};
// Store kontak manual per waId: { jid: { name, nomor } }
const contactStore = {};

const MAX_RETRY  = 10;
const BASE_DELAY = 5000;
const MAX_DELAY  = 600000;

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

// ===== NORMALISASI JID =====
function normalizeJid(jid) {
  if (!jid) return null;
  // Hapus device suffix: 628xxx:12@s.whatsapp.net → 628xxx@s.whatsapp.net
  if (jid.includes(":") && jid.includes("@")) {
    return jid.split(":")[0] + "@s.whatsapp.net";
  }
  return jid;
}

// ===== CEK APAKAH JID HARUS DIABAIKAN =====
function shouldIgnoreJid(jid) {
  if (!jid) return true;
  if (jid.endsWith("@g.us"))       return true; // Grup
  if (jid.endsWith("@broadcast"))  return true; // Broadcast/status
  if (jid.endsWith("@newsletter")) return true; // Newsletter
  if (jid === "status@broadcast")  return true; // Status WA
  if (jid.endsWith("@lid") && !jid.includes("@s.whatsapp.net")) return false; // LID tetap diproses
  return false;
}

// ===== SIMPAN KONTAK KE STORE MANUAL =====
function saveContact(waId, jid, name) {
  if (!contactStore[waId]) contactStore[waId] = {};
  if (jid && name) contactStore[waId][jid] = name;
}

// ===== LOAD & SIMPAN CONTACT STORE KE FILE =====
function loadContactStore(waId) {
  const file = path.join(AUTH_DIR, `${waId}_contacts.json`);
  try {
    if (fs.existsSync(file)) {
      contactStore[waId] = JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch (e) {}
}

function persistContactStore(waId) {
  const file = path.join(AUTH_DIR, `${waId}_contacts.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(contactStore[waId] || {}), "utf-8");
  } catch (e) {}
}

// ===== RESOLVE LID KE NOMOR ASLI =====
async function resolveLid(sock, waId, jid, pushName) {
  if (!jid) return jid;
  const nomor = jid.replace(/@.*/, "");

  // Cek apakah sudah nomor normal (7-15 digit)
  if (/^\d{7,15}$/.test(nomor)) return jid;

  // 1. Cek contact store
  if (contactStore[waId]?.[jid]) {
    const resolved = `${contactStore[waId][jid]}@s.whatsapp.net`;
    logger.info("WA-Manager", `LID resolved via store: ${jid} → ${resolved}`);
    return resolved;
  }

  // 2. Cek chatlog — cari entry waId + nama sama
  try {
    const { getChatLog } = require("./bot-bridge");
    const chatLog = getChatLog();
    for (const entry of Object.values(chatLog)) {
      if (entry.waId !== waId) continue;
      const nomorEntry = entry.jid?.replace(/@.*/, "");
      if (!nomorEntry || !/^\d{7,15}$/.test(nomorEntry)) continue;
      if (pushName && entry.nama && entry.nama.toLowerCase() === pushName.toLowerCase()) {
        const resolved = `${nomorEntry}@s.whatsapp.net`;
        saveContact(waId, jid, nomorEntry);
        logger.info("WA-Manager", `LID resolved via chatlog: ${jid} → ${resolved}`);
        return resolved;
      }
    }
  } catch (e) {}

  // 3. Coba via onWhatsApp
  try {
    const results = await sock.onWhatsApp(nomor);
    if (results?.[0]?.jid) {
      const resolved = normalizeJid(results[0].jid);
      const nomorResolved = resolved.replace(/@.*/, "");
      saveContact(waId, jid, nomorResolved);
      logger.info("WA-Manager", `LID resolved via onWhatsApp: ${jid} → ${resolved}`);
      return resolved;
    }
  } catch (e) {}

  logger.warn("WA-Manager", `Tidak bisa resolve JID: ${jid}`);
  return jid;
}

// ===== EKSTRAK TEKS DARI SEMUA FORMAT PESAN =====
function ekstrakTeks(msg) {
  const m = msg.message;
  if (!m) return null;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.audioMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    null
  );
}

// ===== CEK BLACKLIST =====
function isBlacklisted(jid) {
  const cfg   = store.getConfig();
  const nomor = jid.replace(/@.*/, "");
  return (cfg.blacklist || []).includes(nomor);
}

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

  loadContactStore(waId);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:              state,
    logger:            pino({ level: "silent" }),
    browser:           [`WA-Bridge-${waId}`, "Chrome", "1.0.0"],
    printQRInTerminal: false,
    getMessage: async () => ({ conversation: "" }),
  });

  instances[waId] = { sock, status: "connecting", jid: null };

  // Simpan contact store setiap 5 menit
  const contactInterval = setInterval(() => persistContactStore(waId), 5 * 60 * 1000);
  instances[waId].contactInterval = contactInterval;

  queue.setPresenceFunction(setPresence);
  queue.setSendFunction(kirimPesan);

  sock.ev.on("creds.update", saveCreds);

  // ===== TANGKAP UPDATE KONTAK =====
  sock.ev.on("contacts.update", (updates) => {
    for (const update of updates) {
      if (update.id && (update.notify || update.name)) {
        const nomor = normalizeJid(update.id)?.replace(/@.*/, "");
        if (nomor) saveContact(waId, update.id, nomor);
      }
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id && (contact.notify || contact.name)) {
        const nomor = normalizeJid(contact.id)?.replace(/@.*/, "");
        if (nomor) saveContact(waId, contact.id, nomor);
      }
    }
  });

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
      clearInterval(contactInterval);
      persistContactStore(waId);
      logger.warn("WA-Manager", `${waId} terputus (code: ${statusCode})`);

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
      const unreadChats = chats.filter((c) => c.unreadCount > 0 && !shouldIgnoreJid(c.id));
      if (unreadChats.length > 0 && onUnreadFound) {
        logger.info("WA-Manager", `${waId}: ${unreadChats.length} unread dari history sync`);
        await onUnreadFound(waId, unreadChats.map((c) => ({
          jid:         normalizeJid(c.id),
          unreadCount: c.unreadCount,
          name:        c.name || c.notify || c.id.replace(/@.*/, ""),
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

        const remoteJid = msg.key.remoteJid;

        // ===== ABAIKAN STORY, STATUS, BROADCAST, GRUP =====
        if (shouldIgnoreJid(remoteJid)) continue;

        // ===== ABAIKAN PESAN KOSONG =====
        if (!msg.message) continue;

        // ===== ABAIKAN TIPE PESAN SISTEM =====
        const msgType = Object.keys(msg.message)[0];
        const ignoredTypes = [
          "protocolMessage",
          "senderKeyDistributionMessage",
          "messageContextInfo",
          "reactionMessage",
        ];
        if (ignoredTypes.includes(msgType)) continue;

        // ===== NORMALISASI & RESOLVE JID =====
        const jidNorm    = normalizeJid(remoteJid);
        const pushNameRaw = msg.pushName || "";
        const jidFinal   = await resolveLid(sock, waId, jidNorm, pushNameRaw);

        // Simpan mapping kontak
        const nomorFinal = jidFinal.replace(/@.*/, "");
        if (nomorFinal && /^\d{7,15}$/.test(nomorFinal)) {
          saveContact(waId, remoteJid, nomorFinal);
        }

        const pushName = msg.pushName || nomorFinal;

        // ===== CEK BLACKLIST =====
        if (isBlacklisted(jidFinal)) {
          logger.info("WA-Manager", `Pesan dari ${jidFinal} diblokir (blacklist)`);
          continue;
        }

        // ===== AUTO READ =====
        try {
          await sock.readMessages([msg.key]);
        } catch (e) {
          logger.error("WA-Manager", `Gagal auto read: ${e.message}`);
        }

        // ===== DETEKSI TIPE PESAN =====
        const mediaTypes = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"];
        const mediaType  = mediaTypes.find((t) => msg.message?.[t]);

        if (mediaType) {
          // ===== PESAN MEDIA =====
          try {
            const buffer  = await downloadMediaMessage(msg, "buffer", {});
            const ext     = {
              imageMessage:    "jpg",
              videoMessage:    "mp4",
              documentMessage: msg.message.documentMessage?.fileName?.split(".").pop() || "bin",
              audioMessage:    "ogg",
            }[mediaType] || "bin";
            const caption = msg.message[mediaType]?.caption || "";
            if (onMedia) await onMedia(waId, jidFinal, pushName, buffer, ext, mediaType, caption);
          } catch (err) {
            logger.error("WA-Manager", `Gagal download media dari ${jidFinal}: ${err.message}`);
            if (onMessage) await onMessage(waId, jidFinal, pushName, `[${mediaType.replace("Message", "")} - gagal diunduh]`);
          }
        } else {
          // ===== PESAN TEKS =====
          const pesan = ekstrakTeks(msg);
          if (!pesan) {
            logger.warn("WA-Manager", `Pesan dari ${jidFinal} tidak bisa diekstrak (type: ${msgType})`);
            continue;
          }
          if (onMessage) await onMessage(waId, jidFinal, pushName, pesan);
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
  const sock     = instances[waId]?.sock;
  const interval = instances[waId]?.contactInterval;
  if (!sock) throw new Error(`${waId} tidak ditemukan`);
  if (interval) clearInterval(interval);
  persistContactStore(waId);
  await sock.logout();
  delete instances[waId];
  delete retryCount[waId];
  delete contactStore[waId];
  const authPath    = path.join(AUTH_DIR, waId);
  const contactPath = path.join(AUTH_DIR, `${waId}_contacts.json`);
  if (fs.existsSync(authPath))    fs.rmSync(authPath, { recursive: true });
  if (fs.existsSync(contactPath)) fs.unlinkSync(contactPath);
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
