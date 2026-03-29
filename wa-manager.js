/**
 * FILE: handlers/pesan-handler.js
 * FUNGSI: Memproses semua pesan teks masuk dari WhatsApp
 *
 * ARSITEKTUR:
 * Listen event "wa:pesan_masuk" dari wa-manager.
 * Simpan/update data kandidat di Postgres.
 * Emit event "kandidat:dibuat" atau "kandidat:diupdate"
 * yang kemudian didengar oleh notif-handler.
 *
 * DIGUNAKAN OLEH:
 * - index.js (registerHandlers dipanggil saat startup)
 *
 * MENGGUNAKAN:
 * - core/events.js    (listen & emit)
 * - core/database.js  (operasi kandidat & riwayat)
 * - services/wa-manager.js (generateIdHuruf, normalizeJid)
 * - logger.js
 *
 * EVENT YANG DIDENGAR:
 * - wa:pesan_masuk → { waId, jid, nama, pesan, isLid }
 *
 * EVENT YANG DIPANCARKAN:
 * - kandidat:dibuat   → { id, waId, jid, nama, pesan, isLid, nomorDariPesan, duplikat }
 * - kandidat:diupdate → { id, waId, jid, nama, pesan, isLid, nomorDariPesan, duplikat }
 *
 * PERINGATAN:
 * Semua operasi di sini harus async-safe.
 * Error di sini tidak boleh crash process utama.
 */

"use strict";

const events     = require("../core/events");
const db         = require("../core/database");
const { generateIdHuruf } = require("../services/wa-manager");
const logger     = require("../logger");

// ===== EKSTRAK NOMOR WA DARI ISI PESAN =====
/**
 * ekstrakNomorDariPesan(pesan)
 * Cari nomor WA yang disebut kandidat di dalam pesannya.
 * Berguna untuk kandidat yang kirim CV dengan nomor berbeda.
 *
 * Mendukung berbagai format label nomor Indonesia:
 * "No WA: 08xxx", "Nomor HP: 628xxx", "Telepon: 08xxx", dst
 *
 * DIGUNAKAN OLEH: handler wa:pesan_masuk
 * DAMPAK PERUBAHAN: Mengubah patterns mempengaruhi
 * deteksi nomor dari semua pesan masuk
 */
function ekstrakNomorDariPesan(pesan) {
  if (!pesan) return null;

  const patterns = [
    /No[\s.]?WhatsApp\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /No[\s.]?WA\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Nomor[\s.]?WA\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Nomor[\s.]?WhatsApp\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /No[\s.]?HP\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Nomor[\s.]?HP\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Nomor[\s.]?Telepon\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Telepon\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Telp\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Phone\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Handphone\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /HP\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Kontak\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
    /Contact\s*[:：]\s*([0-9+\-\s()]{8,20})/i,
  ];

  for (const pattern of patterns) {
    const match = pesan.match(pattern);
    if (match) {
      let nomor = match[1].replace(/[\s\-()]/g, "").replace(/^\+/, "");
      if (nomor.startsWith("0")) nomor = "62" + nomor.slice(1);
      if (/^\d{10,15}$/.test(nomor)) return nomor;
    }
  }
  return null;
}

// ===== REGISTER HANDLER =====
/**
 * registerHandlers()
 * Daftarkan semua listener event untuk handler ini.
 * Dipanggil sekali saat startup dari index.js.
 *
 * DIGUNAKAN OLEH: index.js
 * PERINGATAN: Jangan panggil lebih dari sekali —
 * akan menyebabkan listener duplikat
 */
function registerHandlers() {

  // ── Listen: pesan teks masuk dari WA ──────────────────────
  events.on("wa:pesan_masuk", async ({ waId, jid, nama, pesan, isLid }) => {
    try {
      // Cek apakah kandidat sudah ada di database
      let kandidat = await db.getKandidatByJid(waId, jid);
      let isKandidatBaru = false;

      if (!kandidat) {
        // Kandidat baru — generate ID dan buat entri
        const counter = await db.getAndIncrementCounter();
        const id      = generateIdHuruf(counter);

        await db.buatKandidat({ id, waId, jid, nama });
        isKandidatBaru = true;

        // Ambil data yang baru dibuat
        kandidat = await db.getKandidatByJid(waId, jid);
        logger.info("Pesan-Handler", `Kandidat baru [${id}] ${nama} via ${waId}`);
      }

      const id = kandidat.id;

      // Update data kandidat
      await db.updateKandidat(id, {
        nama,
        status:        "perlu_dibalas",
        pesanTerakhir: pesan,
        panjangPesan:  pesan.length,
        waktuPesan:    Date.now(),
        reminder1:     false,
        reminder2:     false,
        reminder3:     false,
      });

      // Tambah ke riwayat percakapan
      await db.tambahRiwayat(id, nama, pesan);

      // Cek nomor dari isi pesan (kalau ada)
      const nomorDariPesan = ekstrakNomorDariPesan(pesan);

      // Cek duplikat kandidat di waId lain
      const duplikat = await db.cekDuplikatKandidat(waId, jid);

      // Emit event sesuai apakah kandidat baru atau lama
      const eventData = {
        id,
        waId,
        jid,
        nama,
        pesan,
        isLid:          isLid || false,
        nomorDariPesan: nomorDariPesan || null,
        duplikat:       duplikat || [],
        panjangPesan:   pesan.length,
      };

      if (isKandidatBaru) {
        events.emitSafe("kandidat:dibuat", eventData);
      } else {
        events.emitSafe("kandidat:diupdate", eventData);
      }

    } catch (err) {
      logger.error("Pesan-Handler", `Error proses pesan masuk: ${err.message}`);
    }
  });

  // ── Listen: pesan terkirim — update status kandidat ────────
  // Saat HR berhasil balas, update status jadi "menunggu"
  events.on("pesan:terkirim", async ({ waId, jid }) => {
    try {
      const kandidat = await db.getKandidatByJid(waId, jid);
      if (!kandidat) return;
      await db.updateKandidat(kandidat.id, {
        status:     "menunggu",
        waktuBalas: Date.now(),
      });
    } catch (err) {
      logger.error("Pesan-Handler", `Error update status terkirim: ${err.message}`);
    }
  });

  // ── Listen: pesan gagal — update status kandidat ───────────
  events.on("pesan:gagal", async ({ waId, jid, error }) => {
    try {
      if (error === "NOMOR_TIDAK_AKTIF") {
        const kandidat = await db.getKandidatByJid(waId, jid);
        if (!kandidat) return;
        await db.updateKandidat(kandidat.id, { status: "tidak_aktif" });
        logger.info("Pesan-Handler", `Kandidat ${kandidat.id} ditandai tidak aktif`);
      }
    } catch (err) {
      logger.error("Pesan-Handler", `Error update status gagal: ${err.message}`);
    }
  });

  logger.info("Pesan-Handler", "Handler terdaftar ✅");
}

module.exports = { registerHandlers };
