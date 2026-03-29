/**
 * FILE: services/wa-manager.js
 * FUNGSI: Mengelola semua koneksi WhatsApp dan memproses pesan masuk
 *
 * ARSITEKTUR:
 * File ini TIDAK import handler atau bot manapun.
 * Semua komunikasi keluar dilakukan via events.
 * Ini memutus circular dependency yang ada di versi lama.
 *
 * DIGUNAKAN OLEH:
 * - index.js (startup, connectWA, health check)
 * - bots/bot-wa.js (QR, pairing, disconnect)
 * - bots/bot-bridge.js (kirimPesan, cekNomorAktif)
 * - bots/bot-pool.js (kirimPesan, cekNomorAktif)
 *
 * MENGGUNAKAN:
 * - core/events.js   (emit semua event WA)
 * - core/database.js (simpan kontak, cek blacklist, update wa_accounts)
 * - core/cache.js    (deduplication pesan, retry count)
 * - logger.js        (logging)
 *
 * EVENT YANG DIPANCARKAN:
 * ─────────────────────────────────────────────────────────
 * wa:pesan_masuk      → { waId, jid, nama, pesan }
 * wa:media_masuk      → { waId, jid, nama, buffer, ext, mediaType, caption }
 * wa:terhubung        → { waId, jid }
 * wa:terputus         → { waId, willReconnect, maxRetryReached }
 * wa:unread_ditemukan → { waId, unreadChats }
 * wa:qr_diterima      → { waId, qr }
 * wa:pairing_code     → { waId, code, nomor, errMsg }
 * ─────────────────────────────────────────────────────────
 *
 * TIDAK ADA EVENT YANG DIDENGAR (listen) di file ini.
 * wa-manager hanya emit, tidak listen.
 *
 * PERINGATAN KRITIS:
 * - Jangan ubah nama event tanpa update CONTEXT.md dan semua listener
 * - Baileys harus tetap di versi 6.7.16 (CommonJS compatibility)
 * - AUTH_DIR harus ada di volume Railway agar session tidak hilang
 */

"use strict";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino     = require("pino");
const fs       = require("fs");
const path     = require("path");
const events   = require("../core/events");
const db       = require("../core/database");
const cache    = require("../core/cache");
const logger   = require("../logger");

// ===== KONSTANTA =====

// AUTH_DIR harus di dalam volume Railway agar persistent
// Volume di-mount di /data (sesuai railway.toml)
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth_sessions";
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const MAX_RETRY  = 10;
const BASE_DELAY = 5000;   // 5 detik
const MAX_DELAY  = 600000; // 10 menit

// ===== STATE =====
// instances: waId → { sock, status, jid }
// Hanya hidup selama process berjalan
// Koneksi WA perlu reconnect setelah restart — ini normal
const instances = {};

// ===== HELPER: GENERATE ID HURUF =====
/**
 * generateIdHuruf(counter)
 * Generate ID huruf dari angka counter.
 * 0→A, 1→B, ..., 25→Z, 26→AA, 27→AB, dst
 *
 * DIGUNAKAN OLEH: (tidak langsung — lewat database.js)
 */
function generateIdHuruf(counter) {
  let id = "";
  let n  = counter;
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n  = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

// ===== HELPER: NORMALISASI JID =====
/**
 * normalizeJid(jid)
 * Hapus device suffix dari JID.
 * Contoh: 628xxx:12@s.whatsapp.net → 628xxx@s.whatsapp.net
 *
 * DIGUNAKAN OLEH: Banyak fungsi di file ini
 * DAMPAK PERUBAHAN: Mempengaruhi cara semua JID diproses
 */
function normalizeJid(jid) {
  if (!jid) return null;
  if (jid.includes(":") && jid.includes("@")) {
    return jid.split(":")[0] + "@s.whatsapp.net";
  }
  return jid;
}

// ===== HELPER: CEK JID YANG HARUS DIABAIKAN =====
/**
 * shouldIgnoreJid(jid)
 * Cek apakah JID harus diabaikan (grup, broadcast, newsletter).
 *
 * DIGUNAKAN OLEH: handler messages.upsert
 */
function shouldIgnoreJid(jid) {
  if (!jid) return true;
  if (jid.endsWith("@g.us"))       return true; // Grup
  if (jid.endsWith("@broadcast"))  return true; // Broadcast/status
  if (jid.endsWith("@newsletter")) return true; // Newsletter
  if (jid === "status@broadcast")  return true; // Status WA
  return false;
}

// ===== HELPER: CEK APAKAH JID ADALAH LID =====
/**
 * isLidJid(jid)
 * LID adalah format JID khusus WA Web/Business
 * yang menyembunyikan nomor asli.
 *
 * DIGUNAKAN OLEH: connectWA (messages.upsert handler)
 */
function isLidJid(jid) {
  if (!jid) return false;
  const nomor = jid.replace(/@.*/, "");
  if (!/^[0-9]+$/.test(nomor)) return true;
  if (nomor.length > 14) return true;
  if (nomor.length < 7)  return true;
  return false;
}

// ===== HELPER: EKSTRAK TEKS DARI PESAN =====
/**
 * ekstrakTeks(msg)
 * Ekstrak teks dari berbagai format pesan Baileys.
 *
 * DIGUNAKAN OLEH: messages.upsert handler
 * DAMPAK PERUBAHAN: Mengubah ini mempengaruhi
 * semua pesan teks yang masuk
 */
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

// ===== HELPER: HITUNG DELAY RECONNECT =====
/**
 * getRetryDelay(retryCount)
 * Exponential backoff untuk reconnect.
 * Semakin banyak gagal, semakin lama tunggu.
 *
 * DIGUNAKAN OLEH: handler connection.update
 */
function getRetryDelay(retryCount) {
  return Math.min(BASE_DELAY * Math.pow(2, retryCount), MAX_DELAY);
}

// ===== RESOLVE LID KE NOMOR ASLI =====
/**
 * resolveLid(sock, waId, jid, pushName, msg)
 * Coba resolve LID ke nomor WA asli dengan 5 strategi berurutan.
 *
 * Strategi (dari paling cepat ke paling lambat):
 * 1. Cek database (hasil resolve sebelumnya)
 * 2. Ekstrak dari field pesan Baileys
 * 3. Fetch via getBusinessProfile
 * 4. Fetch via onWhatsApp
 * 5. Kembalikan JID asli kalau semua gagal
 *
 * DIGUNAKAN OLEH: messages.upsert handler
 * DAMPAK PERUBAHAN: Mengubah urutan strategi mempengaruhi
 * akurasi resolve LID untuk semua pesan masuk
 */
async function resolveLid(sock, waId, jid, pushName, msg) {
  if (!jid) return jid;
  const nomor = jid.replace(/@.*/, "");

  // Nomor normal max 14 digit, LID biasanya lebih panjang
  if (/^\d{7,14}$/.test(nomor)) return jid;

  // Strategi 1: Cek database
  const cached = await db.getKontak(waId, jid);
  if (cached) {
    const resolved = `${cached}@s.whatsapp.net`;
    logger.info("WA-Manager", `LID resolved via DB: ${jid} → ${resolved}`);
    return resolved;
  }

  // Strategi 2: Ekstrak dari field pesan Baileys
  if (msg) {
    const kandidatNomor = [
      msg.key?.participant,
      msg.participant,
      msg.verifiedBizName,
    ].filter(Boolean);

    for (const kandidat of kandidatNomor) {
      const n = kandidat.replace(/@.*/, "").replace(/[^0-9]/g, "");
      if (/^\d{7,15}$/.test(n)) {
        const resolved = `${n}@s.whatsapp.net`;
        await db.simpanKontak(waId, jid, n);
        logger.info("WA-Manager", `LID resolved via msg field: ${jid} → ${resolved}`);
        return resolved;
      }
    }
  }

  // Strategi 3: getBusinessProfile
  try {
    const profile = await sock.getBusinessProfile(jid);
    if (profile?.wid) {
      const resolved = normalizeJid(profile.wid);
      const n        = resolved.replace(/@.*/, "");
      if (/^\d{7,15}$/.test(n)) {
        await db.simpanKontak(waId, jid, n);
        logger.info("WA-Manager", `LID resolved via business profile: ${jid} → ${resolved}`);
        return resolved;
      }
    }
  } catch (e) {}

  // Strategi 4: onWhatsApp
  try {
    const results = await sock.onWhatsApp(nomor);
    if (results?.[0]?.jid) {
      const resolved = normalizeJid(results[0].jid);
      const n        = resolved.replace(/@.*/, "");
      await db.simpanKontak(waId, jid, n);
      logger.info("WA-Manager", `LID resolved via onWhatsApp: ${jid} → ${resolved}`);
      return resolved;
    }
  } catch (e) {}

  logger.warn("WA-Manager", `Tidak bisa resolve LID: ${jid} (pushName: ${pushName})`);
  return jid;
}

// ===== KONEKSI WA =====
/**
 * connectWA(waId, usePairingCode, nomorPonsel)
 * Buat koneksi baru ke WhatsApp untuk akun waId.
 * Setup semua event listener Baileys dan emit ke events.js.
 *
 * @param waId          - ID akun WA (contoh: "wa1")
 * @param usePairingCode - Pakai pairing code instead of QR
 * @param nomorPonsel   - Nomor HP untuk pairing code
 *
 * DIGUNAKAN OLEH: index.js (startup), bots/bot-wa.js (manual connect)
 * DAMPAK PERUBAHAN: Mengubah fungsi ini mempengaruhi
 * semua koneksi WA di seluruh sistem
 */
async function connectWA(waId, usePairingCode = false, nomorPonsel = null) {
  const authPath = path.join(AUTH_DIR, waId);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

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

  // ── Simpan credentials saat update ──────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ── Tangkap update kontak — simpan mapping LID ──────────────
  // Dijalankan saat WA sync kontak dari server
  sock.ev.on("contacts.update", async (updates) => {
    for (const update of updates) {
      if (!update.id) continue;
      const nomorId = update.id.replace(/@.*/, "");
      if (/^\d{7,15}$/.test(nomorId)) {
        if (update.lid) await db.simpanKontak(waId, update.lid, nomorId);
        await db.simpanKontak(waId, update.id, nomorId);
      }
    }
  });

  sock.ev.on("contacts.upsert", async (contacts) => {
    for (const contact of contacts) {
      if (!contact.id) continue;
      const nomorId = contact.id.replace(/@.*/, "");
      if (/^\d{7,15}$/.test(nomorId)) {
        if (contact.lid) await db.simpanKontak(waId, contact.lid, nomorId);
        await db.simpanKontak(waId, contact.id, nomorId);
      }
    }
  });

  sock.ev.on("chats.upsert", async (chats) => {
    for (const chat of chats) {
      if (!chat.id) continue;
      const nomorId = chat.id.replace(/@.*/, "");
      if (/^\d{7,15}$/.test(nomorId) && chat.id.endsWith("@s.whatsapp.net")) {
        if (chat.lid) await db.simpanKontak(waId, chat.lid, nomorId);
      }
    }
  });

  // ── Handler koneksi (QR, connected, disconnected) ────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code diterima
    if (qr && !usePairingCode) {
      logger.info("WA-Manager", `QR diterima untuk ${waId}`);
      events.emitSafe("wa:qr_diterima", { waId, qr });
    }

    // Berhasil terhubung
    if (connection === "open") {
      const jid              = normalizeJid(sock.user?.id || "");
      instances[waId].status = "connected";
      instances[waId].jid    = jid;
      await cache.resetRetryCount(waId);
      await db.setWaAktif(waId, true);
      logger.info("WA-Manager", `${waId} terhubung sebagai ${jid}`);
      events.emitSafe("wa:terhubung", { waId, jid });
    }

    // Koneksi terputus
    if (connection === "close") {
      const statusCode      = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut     = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = !isLoggedOut;

      instances[waId].status = "disconnected";
      logger.warn("WA-Manager", `${waId} terputus (code: ${statusCode})`);

      if (shouldReconnect) {
        const currentRetry = await cache.getRetryCount(waId);

        if (currentRetry >= MAX_RETRY) {
          // Sudah terlalu banyak gagal — berhenti reconnect
          logger.error("WA-Manager", `${waId} gagal reconnect ${MAX_RETRY}x — berhenti`);
          events.emitSafe("wa:terputus", { waId, willReconnect: false, maxRetryReached: true });
          delete instances[waId];
          return;
        }

        // Exponential backoff
        const delay = getRetryDelay(currentRetry);
        await cache.incrementRetryCount(waId);
        logger.info("WA-Manager", `${waId} reconnect dalam ${Math.round(delay / 1000)}s (ke-${currentRetry + 1}/${MAX_RETRY})`);
        events.emitSafe("wa:terputus", { waId, willReconnect: true, maxRetryReached: false });
        setTimeout(() => connectWA(waId), delay);

      } else {
        // Logout permanen — tandai nonaktif
        logger.info("WA-Manager", `${waId} logout permanen`);
        await db.setWaAktif(waId, false);
        events.emitSafe("wa:terputus", { waId, willReconnect: false, maxRetryReached: false });
        delete instances[waId];
        await cache.resetRetryCount(waId);
      }
    }
  });

  // ── History sync — tangkap pesan terlewat saat bot mati ─────
  sock.ev.on("messaging-history.set", async ({ chats, isLatest }) => {
    if (!isLatest) return;
    try {
      const unreadChats = chats.filter((c) => {
        if (!c.unreadCount || c.unreadCount <= 0) return false;
        if (shouldIgnoreJid(c.id)) return false;
        return true;
      });

      if (unreadChats.length === 0) return;

      logger.info("WA-Manager", `${waId}: ${unreadChats.length} chat unread saat reconnect`);

      const unreadDenganPesan = [];
      for (const chat of unreadChats) {
        const jid  = normalizeJid(chat.id);
        const nama = chat.name || chat.notify || jid.replace(/@.*/, "");
        const semuaPesan = [];

        try {
          const msgs = await sock.fetchMessages({
            id:    jid,
            count: Math.min(chat.unreadCount, 50),
          });
          if (msgs?.messages?.length > 0) {
            for (const msg of msgs.messages) {
              if (msg.key.fromMe) continue;
              const pesan = ekstrakTeks(msg);
              const mediaType = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"]
                .find((t) => msg.message?.[t]);
              if (pesan)          semuaPesan.push(pesan);
              else if (mediaType) semuaPesan.push(`[${mediaType.replace("Message", "")}]`);
            }
          }
        } catch (e) {}

        unreadDenganPesan.push({
          jid,
          nama,
          unreadCount:   chat.unreadCount,
          semuaPesan:    semuaPesan.length > 0 ? semuaPesan : null,
          pesanTerakhir: semuaPesan.length > 0 ? semuaPesan[semuaPesan.length - 1] : null,
        });
      }

      events.emitSafe("wa:unread_ditemukan", { waId, unreadChats: unreadDenganPesan });

    } catch (err) {
      logger.error("WA-Manager", `Gagal proses history sync: ${err.message}`);
    }
  });

  // ── Handler pesan masuk ──────────────────────────────────────
  // Ini adalah handler utama — semua pesan WA masuk diproses di sini
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        // Skip pesan dari diri sendiri
        if (msg.key.fromMe) continue;

        // ── Deduplication via Redis ──────────────────────────
        // Cegah pesan yang sama diproses 2x (bisa terjadi saat reconnect)
        const msgId = msg.key.id;
        if (msgId && await cache.isDuplicateMsg(waId, msgId)) {
          logger.info("WA-Manager", `Skip duplikat: ${msgId}`);
          continue;
        }

        const remoteJid = msg.key.remoteJid;

        // ── Abaikan grup, broadcast, newsletter ─────────────
        if (shouldIgnoreJid(remoteJid)) continue;

        // ── Abaikan pesan kosong ─────────────────────────────
        if (!msg.message) continue;

        // ── Abaikan tipe pesan sistem ────────────────────────
        const msgType = Object.keys(msg.message)[0];
        const ignoredTypes = [
          "protocolMessage",
          "senderKeyDistributionMessage",
          "messageContextInfo",
          "reactionMessage",
          "stickerMessage",
        ];
        if (ignoredTypes.includes(msgType)) continue;

        // ── Normalisasi & resolve JID ────────────────────────
        const jidNorm    = normalizeJid(remoteJid);
        const pushNameRaw = msg.pushName || "";
        const jidFinal   = await resolveLid(sock, waId, jidNorm, pushNameRaw, msg);

        // Simpan mapping kontak ke database
        const nomorFinal = jidFinal.replace(/@.*/, "");
        if (nomorFinal && /^\d{7,15}$/.test(nomorFinal)) {
          await db.simpanKontak(waId, remoteJid, nomorFinal);
        }

        const pushName = msg.pushName || nomorFinal;

        // ── Cek blacklist ────────────────────────────────────
        if (await db.cekBlacklist(nomorFinal)) {
          logger.info("WA-Manager", `Pesan dari ${jidFinal} diblokir (blacklist)`);
          continue;
        }

        // ── Auto read ────────────────────────────────────────
        try {
          await sock.readMessages([msg.key]);
        } catch (e) {
          logger.error("WA-Manager", `Gagal auto read: ${e.message}`);
        }

        // ── Deteksi tipe pesan ───────────────────────────────
        const mediaTypes = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"];
        const mediaType  = mediaTypes.find((t) => msg.message?.[t]);

        if (mediaType) {
          // ── Pesan media ──────────────────────────────────
          try {
            const buffer  = await downloadMediaMessage(msg, "buffer", {});
            const ext     = {
              imageMessage:    "jpg",
              videoMessage:    "mp4",
              documentMessage: msg.message.documentMessage?.fileName?.split(".").pop() || "bin",
              audioMessage:    "ogg",
            }[mediaType] || "bin";
            const caption = msg.message[mediaType]?.caption || "";

            // Emit event — diproses oleh handlers/media-handler.js
            events.emitSafe("wa:media_masuk", {
              waId,
              jid:      jidFinal,
              nama:     pushName,
              buffer,
              ext,
              mediaType,
              caption,
              isLid:    isLidJid(jidFinal),
            });

          } catch (err) {
            logger.error("WA-Manager", `Gagal download media dari ${jidFinal}: ${err.message}`);
            // Fallback: emit sebagai pesan teks dengan keterangan gagal
            events.emitSafe("wa:pesan_masuk", {
              waId,
              jid:   jidFinal,
              nama:  pushName,
              pesan: `[${mediaType.replace("Message", "")} - gagal diunduh]`,
              isLid: isLidJid(jidFinal),
            });
          }

        } else {
          // ── Pesan teks ───────────────────────────────────
          const pesan = ekstrakTeks(msg);
          if (!pesan) {
            logger.warn("WA-Manager", `Pesan dari ${jidFinal} tidak bisa diekstrak (type: ${msgType})`);
            continue;
          }

          // Emit event — diproses oleh handlers/pesan-handler.js
          events.emitSafe("wa:pesan_masuk", {
            waId,
            jid:   jidFinal,
            nama:  pushName,
            pesan,
            isLid: isLidJid(jidFinal),
          });
        }

      } catch (err) {
        logger.error("WA-Manager", `Error proses pesan: ${err.message}`);
      }
    }
  });

  // ── Pairing code (kalau pakai metode pairing, bukan QR) ─────
  if (usePairingCode && nomorPonsel && !sock.authState.creds.registered) {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const code = await sock.requestPairingCode(nomorPonsel);
      logger.info("WA-Manager", `Pairing code untuk ${waId}: ${code}`);
      events.emitSafe("wa:pairing_code", { waId, code, nomor: nomorPonsel });
    } catch (err) {
      logger.error("WA-Manager", `Gagal request pairing code ${waId}: ${err.message}`);
      events.emitSafe("wa:pairing_code", { waId, code: null, nomor: nomorPonsel, errMsg: err.message });
    }
  }

  return sock;
}

// ===== KIRIM PESAN =====
/**
 * kirimPesan(waId, jid, pesan, media)
 * Kirim pesan teks atau media ke nomor WA tertentu.
 *
 * @param waId  - ID akun WA pengirim
 * @param jid   - Nomor WA tujuan
 * @param pesan - Teks pesan (untuk pesan teks)
 * @param media - Object media (untuk pesan media)
 *
 * DIGUNAKAN OLEH: services/queue.js
 * DAMPAK PERUBAHAN: Mengubah ini mempengaruhi
 * semua pengiriman pesan di sistem
 */
async function kirimPesan(waId, jid, pesan, media = null) {
  const sock      = instances[waId]?.sock;
  if (!sock) throw new Error(`${waId} tidak terhubung`);
  const jidNormal = normalizeJid(jid);

  // Cek nomor aktif sebelum kirim (hanya untuk pesan teks)
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

// ===== CEK NOMOR AKTIF =====
/**
 * cekNomorAktif(waId, jid)
 * Cek apakah nomor WA terdaftar dan aktif.
 *
 * @returns boolean
 *
 * DIGUNAKAN OLEH: bots/bot-bridge.js, bots/bot-pool.js
 */
async function cekNomorAktif(waId, jid) {
  const sock = instances[waId]?.sock;
  if (!sock) return false;
  try {
    const jidNormal = normalizeJid(jid);
    const [result]  = await sock.onWhatsApp(jidNormal.replace("@s.whatsapp.net", ""));
    return result?.exists || false;
  } catch {
    return false;
  }
}

// ===== SET PRESENCE =====
/**
 * setPresence(waId, jid, status)
 * Set status kehadiran (online, typing, paused).
 *
 * @param status - "available" | "composing" | "paused"
 *
 * DIGUNAKAN OLEH: services/queue.js
 */
async function setPresence(waId, jid, status) {
  const sock = instances[waId]?.sock;
  if (!sock) return;
  try {
    await sock.sendPresenceUpdate(status, jid);
  } catch (e) {
    logger.error("WA-Manager", `Gagal set presence: ${e.message}`);
  }
}

// ===== DISCONNECT WA =====
/**
 * disconnectWA(waId)
 * Logout dan hapus semua data akun WA tertentu.
 *
 * DIGUNAKAN OLEH: bots/bot-wa.js
 * PERINGATAN: Ini permanen — session WA akan terhapus
 */
async function disconnectWA(waId) {
  const sock = instances[waId]?.sock;
  if (!sock) throw new Error(`${waId} tidak ditemukan`);

  await sock.logout();
  delete instances[waId];
  await cache.resetRetryCount(waId);
  await db.setWaAktif(waId, false);

  // Hapus file auth session
  const authPath = path.join(AUTH_DIR, waId);
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true });

  logger.info("WA-Manager", `${waId} berhasil di-logout`);
}

// ===== STATUS & INFO =====

/**
 * getStatus()
 * Ambil status semua koneksi WA yang aktif.
 *
 * DIGUNAKAN OLEH: index.js (health check), bots/bot-wa.js
 */
function getStatus() {
  const result = {};
  for (const [waId, instance] of Object.entries(instances)) {
    result[waId] = { status: instance.status, jid: instance.jid };
  }
  return result;
}

/**
 * getInstance(waId)
 * Ambil instance sock Baileys untuk waId tertentu.
 *
 * DIGUNAKAN OLEH: (internal, kalau perlu akses langsung)
 */
function getInstance(waId) {
  return instances[waId] || null;
}

/**
 * getAllIds()
 * Ambil semua waId yang sedang terhubung.
 *
 * DIGUNAKAN OLEH: bots/bot-bridge.js (/ke nomor pesan)
 */
function getAllIds() {
  return Object.keys(instances);
}

module.exports = {
  connectWA,
  disconnectWA,
  kirimPesan,
  cekNomorAktif,
  setPresence,
  getStatus,
  getInstance,
  getAllIds,
  normalizeJid,
  isLidJid,
  generateIdHuruf,
};
