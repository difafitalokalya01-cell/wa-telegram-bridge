"use strict";
/**
 * FILE: logger.js
 * FUNGSI: Logging ke console dan file dengan auto-rotation
 *
 * DIGUNAKAN OLEH: Semua file di sistem ini
 * MENGGUNAKAN: Node.js built-in fs, path
 *
 * ROTASI LOG:
 * - Log disimpan per hari: logs/YYYY-MM-DD.log
 * - File lama (lebih dari 7 hari) dihapus otomatis saat startup
 * - Maksimal ukuran per file: tidak dibatasi (per hari sudah cukup)
 */

const fs   = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) {
  try { fs.mkdirSync(logDir, { recursive: true }); } catch(e) {}
}

// Hapus log lama (lebih dari 7 hari) saat startup
function bersihkanLogLama() {
  try {
    const batas    = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const files    = fs.readdirSync(logDir);
    let terhapus   = 0;
    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      const filePath = path.join(logDir, file);
      const stat     = fs.statSync(filePath);
      if (stat.mtimeMs < batas) {
        fs.unlinkSync(filePath);
        terhapus++;
      }
    }
    if (terhapus > 0) console.log(`[Logger] ${terhapus} file log lama dihapus`);
  } catch(e) {}
}
bersihkanLogLama();

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logDir, `${date}.log`);
}

function log(level, source, message) {
  const time = new Date().toISOString();
  const line = `[${time}] [${level.toUpperCase()}] [${source}] ${message}\n`;
  console.log(line.trim());
  try {
    fs.appendFileSync(getLogFile(), line);
  } catch(e) {
    console.error(`[LOGGER ERROR] Gagal tulis log: ${e.message}`);
  }
}

module.exports = {
  info:  (source, msg) => log("info",  source, msg),
  warn:  (source, msg) => log("warn",  source, msg),
  error: (source, msg) => log("error", source, msg),
};
