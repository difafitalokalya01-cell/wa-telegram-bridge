"use strict";
/**
 * FILE: api/kandidat.js
 * FUNGSI: REST API endpoints untuk manajemen kandidat
 *
 * DIGUNAKAN OLEH: index.js (route /api/kandidat/*)
 * MENGGUNAKAN: core/database.js, services/queue.js, services/wa-manager.js
 *
 * ENDPOINTS:
 * GET  /api/kandidat              → daftar kandidat (filter, pagination)
 * GET  /api/kandidat/:id          → detail + riwayat kandidat
 * POST /api/kandidat/:id/balas    → balas pesan kandidat
 * POST /api/kandidat/:id/selesai  → tandai selesai
 * POST /api/kandidat/:id/catat    → tambah catatan
 * POST /api/kandidat/:id/fixjid   → perbaiki nomor WA
 * GET  /api/stats                 → statistik ringkasan
 */

const db        = require("../core/database");
const queue     = require("../services/queue");
const logger    = require("../logger");

let waManager = null;
function setWaManager(wm) { waManager = wm; }

// GET /api/kandidat
async function getDaftarKandidat(req, res) {
  try {
    const { status, waId, page = 1, limit = 30 } = req.query;
    const offset  = (parseInt(page) - 1) * parseInt(limit);
    const filter  = {};
    if (status) filter.status = status;
    if (waId)   filter.waId   = waId;
    filter.limit  = parseInt(limit);
    filter.offset = offset;

    const daftar = await db.getDaftarKandidat(filter);
    const counts = await db.hitungKandidat();

    res.json({ daftar, counts, page: parseInt(page), limit: parseInt(limit) });
  } catch(err) {
    logger.error("API-Kandidat", `getDaftar error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/kandidat/:id
async function getDetailKandidat(req, res) {
  try {
    const id       = req.params.id.toUpperCase();
    const kandidat = await db.getKandidat(id);
    if (!kandidat) return res.status(404).json({ error: "Kandidat tidak ditemukan" });

    const riwayat = await db.getRiwayat(id, 50);
    res.json({ ...kandidat, riwayat });
  } catch(err) {
    logger.error("API-Kandidat", `getDetail error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/kandidat/:id/balas
async function balasKandidat(req, res) {
  try {
    const id       = req.params.id.toUpperCase();
    const { pesan } = req.body;
    if (!pesan?.trim()) return res.status(400).json({ error: "Pesan tidak boleh kosong" });

    const kandidat = await db.getKandidat(id);
    if (!kandidat) return res.status(404).json({ error: "Kandidat tidak ditemukan" });

    // Cek nomor aktif
    const aktif = await waManager?.cekNomorAktif(kandidat.wa_id, kandidat.jid);
    if (!aktif) {
      await db.updateKandidat(id, { status: "tidak_aktif" });
      return res.status(400).json({ error: "Nomor tidak terdaftar di WhatsApp", status: "tidak_aktif" });
    }

    await queue.tambahKeAntrian(kandidat.wa_id, kandidat.jid, pesan.trim(), null, kandidat.panjang_pesan || 0);
    await db.tambahRiwayat(id, "HR", pesan.trim());
    await db.updateKandidat(id, { status: "menunggu", waktuBalas: Date.now() });

    logger.info("API-Kandidat", `Balas [${id}] ${kandidat.nama} masuk antrian`);
    res.json({ success: true, message: "Pesan masuk antrian" });
  } catch(err) {
    logger.error("API-Kandidat", `balas error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/kandidat/:id/selesai
async function selesaikanKandidat(req, res) {
  try {
    const id       = req.params.id.toUpperCase();
    const kandidat = await db.getKandidat(id);
    if (!kandidat) return res.status(404).json({ error: "Kandidat tidak ditemukan" });
    await db.updateKandidat(id, { status: "selesai" });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/kandidat/:id/catat
async function catatKandidat(req, res) {
  try {
    const id       = req.params.id.toUpperCase();
    const { catatan } = req.body;
    const kandidat = await db.getKandidat(id);
    if (!kandidat) return res.status(404).json({ error: "Kandidat tidak ditemukan" });
    await db.updateKandidat(id, { catatan: catatan || "" });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/kandidat/:id/fixjid
async function fixJidKandidat(req, res) {
  try {
    const id        = req.params.id.toUpperCase();
    const { nomor } = req.body;
    if (!nomor) return res.status(400).json({ error: "Nomor required" });
    const nomorBersih = nomor.replace(/[^0-9]/g, "");
    const kandidat    = await db.getKandidat(id);
    if (!kandidat) return res.status(404).json({ error: "Kandidat tidak ditemukan" });
    await db.updateKandidat(id, { jid: `${nomorBersih}@s.whatsapp.net` });
    res.json({ success: true, jidBaru: `${nomorBersih}@s.whatsapp.net` });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/stats
async function getStats(req, res) {
  try {
    const counts  = await db.hitungKandidat();
    const status  = waManager?.getStatus() || {};
    const antrian = await queue.getStatus();
    res.json({ counts, wa: status, antrian });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getDaftarKandidat,
  getDetailKandidat,
  balasKandidat,
  selesaikanKandidat,
  catatKandidat,
  fixJidKandidat,
  getStats,
  setWaManager,
};

// POST /api/kirim — kirim ke nomor baru
async function kirimKeNomorBaru(req, res) {
  try {
    const { nomor, pesan } = req.body;
    if (!nomor || !pesan) return res.status(400).json({ error: "Nomor dan pesan wajib diisi" });
    const nomorBersih = nomor.replace(/[^0-9]/g,"");
    const waIds = waManager?.getAllIds() || [];
    if (!waIds.length) return res.status(400).json({ error: "Tidak ada WA terhubung" });
    const jid = `${nomorBersih}@s.whatsapp.net`;
    await queue.tambahKeAntrian(waIds[0], jid, pesan.trim(), null, 0);
    logger.info("API-Kandidat", `Kirim ke nomor baru ${nomorBersih}`);
    res.json({ success: true, message: "Pesan masuk antrian" });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/wa/status
async function getWaStatus(req, res) {
  try {
    const status = waManager?.getStatus() || {};
    res.json(status);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/wa/qr/:waId — request QR untuk waId
async function requestQR(req, res) {
  try {
    const { waId } = req.params;
    await require("../core/database").setWaAktif(waId, true);
    await waManager?.connectWA(waId, false);
    res.json({ success: true, message: `QR sedang di-generate untuk ${waId}. Cek notif Telegram atau WebSocket.` });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/antrian
async function getAntrian(req, res) {
  try {
    const status = await queue.getStatus();
    res.json(status);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/blacklist
async function getBlacklist(req, res) {
  try {
    const daftar = await require("../core/database").getDaftarBlacklist();
    res.json(daftar);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/blacklist
async function tambahBlacklist(req, res) {
  try {
    const { nomor, alasan } = req.body;
    if (!nomor) return res.status(400).json({ error: "Nomor wajib diisi" });
    await require("../core/database").tambahBlacklist(nomor.replace(/[^0-9]/g,""), alasan||"");
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/blacklist/:nomor
async function hapusBlacklist(req, res) {
  try {
    await require("../core/database").hapusBlacklist(req.params.nomor);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/wa/accounts
async function getWaAccounts(req, res) {
  try {
    const accounts = await require("../core/database").getWaAccounts();
    res.json(accounts);
  } catch(err) { res.status(500).json({ error: err.message }); }
}

// POST /api/wa/daftar
async function daftarWA(req, res) {
  try {
    const { waId } = req.body;
    if (!waId) return res.status(400).json({ error: "waId wajib diisi" });
    await require("../core/database").setWaAktif(waId, true);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
}

// POST /api/wa/putus/:waId
async function putuskanWA(req, res) {
  try {
    const { waId } = req.params;
    await waManager?.disconnectWA(waId);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
}

// GET /api/settings/reminder
async function getReminderSettings(req, res) {
  try {
    const fs  = require("fs");
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    res.json(cfg.reminderSettings || { reminder1: 30, reminder2: 60, reminder3: 120 });
  } catch(err) { res.status(500).json({ error: err.message }); }
}

// POST /api/settings/reminder
async function setReminderSettings(req, res) {
  try {
    const { reminder1, reminder2, reminder3 } = req.body;
    if (!reminder1 || !reminder2 || !reminder3) return res.status(400).json({ error: "Semua field wajib diisi" });
    const fs  = require("fs");
    const cfg = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    cfg.reminderSettings = { reminder1, reminder2, reminder3 };
    fs.writeFileSync("./config.json", JSON.stringify(cfg, null, 2));
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
}

// POST /api/wa/sync-unread/:waId — force sync pesan unread dari WA
async function syncUnreadWA(req, res) {
  try {
    const { waId } = req.params;
    const instance = waManager?.getInstance(waId);
    if (!instance?.sock) return res.status(400).json({ error: `${waId} tidak terhubung` });

    const sock = instance.sock;
    let total  = 0;

    // Ambil semua chat dari WA
    const chats = await sock.groupFetchAllParticipating().catch(() => null);

    // Alternatif: fetch via loadMessages per kandidat yang ada
    const kandidats = await db.getDaftarKandidat({ waId, limit: 200 });

    for (const kandidat of kandidats) {
      try {
        const msgs = await sock.fetchMessages({ id: kandidat.jid, count: 50 });
        if (!msgs?.messages?.length) continue;

        for (const msg of msgs.messages.reverse()) {
          if (!msg.message) continue;
          const msgType = Object.keys(msg.message)[0];
          if (["protocolMessage","senderKeyDistributionMessage","reactionMessage"].includes(msgType)) continue;

          const m = msg.message;
          const teks =
            m.conversation || m.extendedTextMessage?.text ||
            m.imageMessage?.caption || m.videoMessage?.caption ||
            (m.imageMessage ? "[foto]" : null) ||
            (m.videoMessage ? "[video]" : null) ||
            (m.audioMessage ? "[audio]" : null) || null;

          if (!teks) continue;

          const pengirim = msg.key.fromMe ? "HR" : (msg.pushName || kandidat.nama || "Kandidat");
          const ts = msg.messageTimestamp
            ? (typeof msg.messageTimestamp === "object"
                ? msg.messageTimestamp.low * 1000
                : msg.messageTimestamp * 1000)
            : Date.now();

          const waktu = new Date(ts).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta", day: "2-digit", month: "short",
            hour: "2-digit", minute: "2-digit",
          });

          await db.pool.query(`
            INSERT INTO riwayat_chat (kandidat_id, pengirim, pesan, waktu, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
          `, [kandidat.id, pengirim, teks.slice(0, 200), waktu, ts]);
          total++;
        }
      } catch(e) { continue; }
    }

    res.json({ success: true, total, message: `${total} pesan disinkronkan dari ${kandidats.length} kandidat` });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getDaftarKandidat, getDetailKandidat, balasKandidat,
  selesaikanKandidat, catatKandidat, fixJidKandidat, getStats,
  kirimKeNomorBaru, getWaStatus, requestQR, getAntrian,
  getBlacklist, tambahBlacklist, hapusBlacklist,
  getWaAccounts, daftarWA, putuskanWA,
  getReminderSettings, setReminderSettings,
  syncChatKandidat, syncUnreadWA,
  setWaManager,
};

// POST /api/kandidat/:id/sync — fetch riwayat dari WA
async function syncChatKandidat(req, res) {
  try {
    const id       = req.params.id.toUpperCase();
    const kandidat = await db.getKandidat(id);
    if (!kandidat) return res.status(404).json({ error: "Kandidat tidak ditemukan" });

    const instance = waManager?.getInstance(kandidat.wa_id);
    if (!instance?.sock) return res.status(400).json({ error: `${kandidat.wa_id} tidak terhubung` });

    const sock   = instance.sock;
    const jid    = kandidat.jid;
    let   jumlah = 0;

    try {
      // Fetch pesan dari WA — maksimal 50 pesan terakhir
      const msgs = await sock.fetchMessages({ id: jid, count: 50 });

      if (msgs?.messages?.length > 0) {
        // Proses dari yang paling lama ke paling baru
        const sorted = msgs.messages.reverse();

        for (const msg of sorted) {
          // Skip pesan sistem
          if (!msg.message) continue;
          const msgType = Object.keys(msg.message)[0];
          if (["protocolMessage","senderKeyDistributionMessage","reactionMessage"].includes(msgType)) continue;

          // Ekstrak teks
          const m = msg.message;
          const teks =
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.imageMessage?.caption ||
            m.videoMessage?.caption ||
            m.documentMessage?.caption ||
            (m.imageMessage ? "[foto]" : null) ||
            (m.videoMessage ? "[video]" : null) ||
            (m.documentMessage ? "[dokumen]" : null) ||
            (m.audioMessage ? "[audio]" : null) ||
            null;

          if (!teks) continue;

          // Tentukan pengirim
          const pengirim = msg.key.fromMe ? "HR" : (msg.pushName || kandidat.nama || "Kandidat");

          // Format waktu dari timestamp pesan
          const ts = msg.messageTimestamp
            ? (typeof msg.messageTimestamp === "object"
                ? msg.messageTimestamp.low * 1000
                : msg.messageTimestamp * 1000)
            : Date.now();

          const waktu = new Date(ts).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            day: "2-digit", month: "short",
            hour: "2-digit", minute: "2-digit",
          });

          // Simpan ke riwayat — pakai created_at dari timestamp asli
          await db.pool.query(`
            INSERT INTO riwayat_chat (kandidat_id, pengirim, pesan, waktu, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
          `, [id, pengirim, teks.slice(0, 200), waktu, ts]);

          jumlah++;
        }
      }
    } catch (fetchErr) {
      // fetchMessages mungkin tidak tersedia di semua versi Baileys
      logger.warn("API-Kandidat", `fetchMessages gagal untuk ${jid}: ${fetchErr.message}`);
      return res.status(400).json({
        error: "Sync tidak tersedia — Baileys tidak support fetchMessages untuk koneksi ini",
        detail: fetchErr.message
      });
    }

    logger.info("API-Kandidat", `Sync [${id}] ${kandidat.nama}: ${jumlah} pesan disimpan`);
    res.json({ success: true, jumlah, message: `${jumlah} pesan berhasil disinkronkan` });

  } catch(err) {
    logger.error("API-Kandidat", `sync error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

