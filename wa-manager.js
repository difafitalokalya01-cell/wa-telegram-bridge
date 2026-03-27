const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  makeInMemoryStore,
  jidNormalizedUser,
  isJidBroadcast,
  isJidStatusBroadcast,
  isJidNewsletter,
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
  try {
    // Pakai fungsi bawaan Baileys untuk normalisasi
    const normalized = jidNormalizedUser(jid);
    return normalized || jid;
  } catch (e) {
    // Fallback manual
    if (jid.includes(":")) return jid.split(":")[0] + "@s.whatsapp.net";
    return jid;
  }
}

// ===== CEK APAKAH JID HARUS DIABAIKAN =====
function shouldIgnoreJid(jid) {
  if (!jid) return true;
  // Abaikan grup
  if (jid.endsWith("@g.us")) return true;
  // Abaikan broadcast/status WA
  if (isJidBroadcast(jid)) return true;
  if (isJidStatusBroadcast(jid)) return true;
  // Abaikan newsletter
  if (isJidNewsletter(jid)) return true;
  // Abaikan status@broadcast
  if (jid === "status@broadcast") return true;
  return false;
}

// ===== RESOLVE LID KE NOMOR ASLI =====
async function resolveLid(sock, jid) {
  if (!jid) return jid;
  const nomor = jid.replace(/@.*/, "");

  // Cek apakah ini LID — LID biasanya bukan format nomor internasional normal
  // Nomor normal: diawali kode negara (1-3 digit) + max 12 digit total
  // LID: biasanya 15 digit atau format aneh
  const isNormalNumber = /^[1-9]\d{6,14}$/.test(nomor) && nomor.length <= 15;

  // Kalau sudah format normal dan masuk akal, langsung return
  if (isNormalNumber && (
    nomor.startsWith("62") ||  // Indonesia
    nomor.startsWith("60") ||  // Malaysia
    nomor.startsWith("65") ||  // Singapura
    nomor.startsWith("1")  ||  // USA/Canada
    nomor.startsWith("44") ||  // UK
    nomor.startsWith("91")     // India
  )) {
    return jid;
  }

  // Coba resolve via store kontak Baileys
  try {
    const waStore = instances[Object.keys(instances).find(
      (k) => instances[k].sock === sock
    )]?.waStore;

    if (waStore) {
      // Cari di contacts store
      const contacts = waStore.contacts || {};
      for (const [contactJid, contact] of Object.entries(contacts)) {
        if (contact.lid === jid || contactJid === jid) {
          if (contact.id && contact.id !== jid) {
            const resolved = normalizeJid(contact.id);
            logger.info("WA-Manager", `LID resolved: ${jid} → ${resolved}`);
            return resolved;
          }
        }
      }
    }
  } catch (e) {
    logger.warn("WA-Manager", `Gagal resolve LID via store: ${e.message}`);
  }

  // Coba resolve via onWhatsApp
  try {
    const results = await sock.onWhatsApp(nomor);
    if (results?.[0]?.jid) {
      const resolved = normalizeJid(results[0].jid);
      logger.info("WA-Manager", `LID resolved via onWhatsApp: ${jid} → ${resolved}`);
      return resolved;
    }
  } catch (e) {
    logger.warn("WA-Manager", `Gagal resolve via onWhatsApp: ${e.message}`);
  }

  // Kembalikan JID asli kalau tidak bisa resolve
  logger.warn("WA-Manager", `Tidak bisa resolve JID: ${jid}, pakai apa adanya`);
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
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    m.reactionMessage?.text ||
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

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version }          = await fetchLatestBaileysVersion();

  // ===== BAILEYS IN-MEMORY STORE (untuk resolve LID & kontak) =====
  const waStore = makeInMemoryStore({
    logger: pino({ level: "silent" }),
  });

  // Load store dari file kalau ada
  const storeFile = path.join(AUTH_DIR, `${waId}_store.json`);
  try {
    if (fs.existsSync(storeFile)) waStore.fromJSON(JSON.parse(fs.readFileSync(storeFile, "utf-8")));
  } catch (e) {}

  // Simpan store berkala setiap 5 menit
  const storeInterval = setInterval(() => {
    try {
      fs.writeFileSync(storeFile, JSON.stringify(waStore.toJSON()), "utf-8");
    } catch (e) {}
  }, 5 * 60 * 1000);

  const sock = makeWASocket({
    version,
    auth:             state,
    logger:           pino({ level: "silent" }),
    browser:          [`WA-Bridge-${waId}`, "Chrome", "1.0.0"],
    printQRInTerminal:false,
    // Aktifkan getMessage untuk handle pesan terenkripsi
    getMessage: async (key) => {
      return { conversation: "" };
    },
  });

  // Bind store ke socket
  waStore.bind(sock.ev);

  instances[waId] = { sock, status: "connecting", jid: null, waStore, storeInterval };

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
      clearInterval(storeInterval);
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
        const jidNorm  = normalizeJid(remoteJid);
        const jidFinal = await resolveLid(sock, jidNorm);

        // Ambil nama dari berbagai sumber
        const pushName =
          msg.pushName ||
          waStore.contacts[remoteJid]?.name ||
          waStore.contacts[remoteJid]?.notify ||
          jidFinal.replace(/@.*/, "");

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
        const mediaTypes = ["imageMessage", "videoMessage", "documentMessage", "audioMessage", "stickerMessage"];
        const mediaType  = mediaTypes.find((t) => msg.message?.[t]);

        if (mediaType && mediaType !== "stickerMessage") {
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
            // Tetap kirim notif walaupun media gagal didownload
            if (onMessage) await onMessage(waId, jidFinal, pushName, `[${mediaType.replace("Message", "")} - gagal diunduh]`);
          }
        } else {
          // ===== PESAN TEKS (semua format) =====
          const pesan = ekstrakTeks(msg);

          // Skip kalau benar-benar tidak ada teks sama sekali
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
  const sock      = instances[waId]?.sock;
  const interval  = instances[waId]?.storeInterval;
  if (!sock) throw new Error(`${waId} tidak ditemukan`);
  if (interval) clearInterval(interval);
  await sock.logout();
  delete instances[waId];
  delete retryCount[waId];
  const authPath  = path.join(AUTH_DIR, waId);
  const storePath = path.join(AUTH_DIR, `${waId}_store.json`);
  if (fs.existsSync(authPath))  fs.rmSync(authPath, { recursive: true });
  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
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
