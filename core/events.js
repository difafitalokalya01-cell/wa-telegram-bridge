/**
 * FILE: core/events.js
 * FUNGSI: Event emitter terpusat untuk seluruh sistem
 *
 * ARSITEKTUR:
 * File ini adalah "jantung" komunikasi antar komponen.
 * Tidak ada file yang import file lain secara langsung untuk logika bisnis.
 * Semua komunikasi lewat events di sini — menghilangkan circular dependency.
 *
 * DIGUNAKAN OLEH: Semua file di sistem ini
 * MENGGUNAKAN: Node.js built-in EventEmitter
 *
 * CARA PAKAI:
 *   const events = require("./core/events");
 *   events.emit("wa:pesan_masuk", { waId, jid, nama, pesan });
 *   events.on("wa:pesan_masuk", (data) => { ... });
 *
 * DAFTAR EVENTS:
 * ─────────────────────────────────────────────────
 * WA EVENTS (dipancarkan oleh: services/wa-manager.js)
 *   wa:pesan_masuk       → { waId, jid, nama, pesan }
 *   wa:media_masuk       → { waId, jid, nama, buffer, ext, mediaType, caption }
 *   wa:terhubung         → { waId, jid }
 *   wa:terputus          → { waId, willReconnect, maxRetryReached }
 *   wa:unread_ditemukan  → { waId, unreadChats }
 *   wa:qr_diterima       → { waId, qr }
 *   wa:pairing_code      → { waId, code, nomor, errMsg }
 *
 * KANDIDAT EVENTS (dipancarkan oleh: handlers/pesan-handler.js)
 *   kandidat:dibuat      → { id, waId, jid, nama }
 *   kandidat:diupdate    → { id, field, value }
 *   kandidat:selesai     → { id, nama }
 *
 * PESAN EVENTS (dipancarkan oleh: services/queue.js)
 *   pesan:masuk_antrian  → { waId, jid, pesan }
 *   pesan:terkirim       → { waId, jid }
 *   pesan:gagal          → { waId, jid, error }
 * ─────────────────────────────────────────────────
 *
 * PERINGATAN:
 * Jangan emit event di dalam listener event yang sama —
 * bisa menyebabkan infinite loop.
 * Gunakan setImmediate() kalau perlu emit dari dalam listener.
 */

"use strict";

const EventEmitter = require("events");

class BridgeEvents extends EventEmitter {
  constructor() {
    super();
    // Naikkan batas listener agar tidak ada warning
    // (banyak komponen listen ke event yang sama)
    this.setMaxListeners(50);
  }

  /**
   * emit dengan logging otomatis untuk debugging
   * Override emit standar agar semua event tercatat
   *
   * DAMPAK PERUBAHAN: Mengubah ini akan mempengaruhi
   * semua event di seluruh sistem
   */
  emitSafe(event, data) {
    try {
      this.emit(event, data);
    } catch (err) {
      console.error(`[Events] Error saat emit "${event}":`, err.message);
    }
  }
}

// Singleton — satu instance untuk seluruh aplikasi
const events = new BridgeEvents();

module.exports = events;
