/**
 * FILE: handlers/media-handler.js
 * FUNGSI: Memproses semua pesan media masuk dari WhatsApp
 *        (foto, video, dokumen, audio)
 *
 * ARSITEKTUR:
 * Listen event "wa:media_masuk" dari wa-manager.
 * Update data kandidat di Postgres.
 * Emit event "kandidat:media_masuk" yang didengar notif-handler.
 *
 * DIGUNAKAN OLEH:
 * - index.js (registerHandlers dipanggil saat startup)
 *
 * MENGGUNAKAN:
 * - core/events.js   (listen & emit)
 * - core/database.js (operasi kandidat & riwayat)
 * - services/wa-manager.js (generateIdHuruf)
 * - logger.js
 *
 * EVENT YANG DIDENGAR:
 * - wa:media_masuk → { waId, jid, nama, buffer, ext, mediaType, caption, isLid }
 *
 * EVENT YANG DIPANCARKAN:
 * - kandidat:media_masuk → { id, waId, jid, nama, buffer, ext,
 *                            mediaType, caption, isLid, duplikat }
 *
 * PERINGATAN:
 * Buffer media bisa besar (foto, video).
 * Jangan simpan buffer ke database — hanya pass lewat event ke notif-handler.
 */

"use strict";

const events   = require("../core/events");
const db       = require("../core/database");
const { generateIdHuruf } = require("../services/wa-manager");
const logger   = require("../logger");

// ===== REGISTER HANDLER =====
/**
 * registerHandlers()
 * Daftarkan semua listener event untuk handler media.
 * Dipanggil sekali saat startup dari index.js.
 *
 * DIGUNAKAN OLEH: index.js
 */
function registerHandlers() {

  // ── Listen: media masuk dari WA ────────────────────────────
  events.on("wa:media_masuk", async ({
    waId, jid, nama, buffer, ext, mediaType, caption, isLid
  }) => {
    try {
      // Cek apakah kandidat sudah ada
      let kandidat      = await db.getKandidatByJid(waId, jid);
      let isKandidatBaru = false;

      if (!kandidat) {
        // Kandidat baru via media (langsung kirim foto/video)
        const counter = await db.getAndIncrementCounter();
        const id      = generateIdHuruf(counter);
        await db.buatKandidat({ id, waId, jid, nama });
        isKandidatBaru = true;
        kandidat       = await db.getKandidatByJid(waId, jid);
        logger.info("Media-Handler", `Kandidat baru [${id}] via media ${mediaType}`);
      }

      const id           = kandidat.id;
      const labelMedia   = caption || `[${mediaType.replace("Message", "")}]`;

      // Update data kandidat
      await db.updateKandidat(id, {
        nama,
        status:        "perlu_dibalas",
        pesanTerakhir: labelMedia,
        panjangPesan:  caption?.length || 0,
        waktuPesan:    Date.now(),
        reminder1:     false,
        reminder2:     false,
        reminder3:     false,
      });

      // Tambah ke riwayat
      await db.tambahRiwayat(id, nama, labelMedia);

      // Cek duplikat
      const duplikat = await db.cekDuplikatKandidat(waId, jid);

      // Emit event ke notif-handler untuk kirim ke Telegram
      events.emitSafe("kandidat:media_masuk", {
        id,
        waId,
        jid,
        nama,
        buffer,
        ext,
        mediaType,
        caption:        caption || "",
        isLid:          isLid || false,
        duplikat:       duplikat || [],
        isKandidatBaru,
      });

    } catch (err) {
      logger.error("Media-Handler", `Error proses media masuk: ${err.message}`);
    }
  });

  // ── Listen: unread ditemukan saat reconnect ─────────────────
  // Tangkap pesan yang terlewat saat bot mati/restart
  events.on("wa:unread_ditemukan", async ({ waId, unreadChats }) => {
    try {
      for (const chat of unreadChats) {
        const { jid, nama, unreadCount, semuaPesan, pesanTerakhir } = chat;

        // Buat atau update kandidat
        let kandidat = await db.getKandidatByJid(waId, jid);
        if (!kandidat) {
          const counter = await db.getAndIncrementCounter();
          const id      = generateIdHuruf(counter);
          await db.buatKandidat({ id, waId, jid, nama: nama || jid.replace(/@.*/, "") });
          kandidat      = await db.getKandidatByJid(waId, jid);
        }

        const id = kandidat.id;

        // Hanya update status kalau belum "menunggu" atau "perlu_dibalas"
        const statusSekarang = kandidat.status;
        if (!["menunggu", "perlu_dibalas"].includes(statusSekarang)) {
          await db.updateKandidat(id, { status: "perlu_dibalas" });
        }

        // Update kandidat dengan pesan terakhir
        if (pesanTerakhir) {
          await db.updateKandidat(id, {
            pesanTerakhir,
            waktuPesan: Date.now(),
            reminder1:  false,
            reminder2:  false,
            reminder3:  false,
          });
        }

        // Simpan SEMUA pesan unread ke riwayat, bukan hanya pesan terakhir
        if (semuaPesan && semuaPesan.length > 0) {
          for (const pesan of semuaPesan) {
            await db.tambahRiwayat(id, nama || "Kandidat", pesan);
          }
        } else if (pesanTerakhir) {
          // Fallback kalau semuaPesan tidak ada
          await db.tambahRiwayat(id, nama || "Kandidat", pesanTerakhir);
        }
      }

      // Emit ke notif-handler untuk kirim ringkasan ke Telegram
      events.emitSafe("kandidat:unread_ringkasan", { waId, unreadChats });

    } catch (err) {
      logger.error("Media-Handler", `Error proses unread: ${err.message}`);
    }
  });

  logger.info("Media-Handler", "Handler terdaftar ✅");
}

module.exports = { registerHandlers };
