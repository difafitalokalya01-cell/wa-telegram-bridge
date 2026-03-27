const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) {
  try { fs.mkdirSync(logDir); } catch (e) {}
}

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
  } catch (e) {
    // Kalau disk penuh atau folder tidak bisa ditulis, tetap jalan — jangan crash
    console.error(`[LOGGER ERROR] Gagal tulis log ke file: ${e.message}`);
  }
}

module.exports = {
  info:  (source, msg) => log("info",  source, msg),
  warn:  (source, msg) => log("warn",  source, msg),
  error: (source, msg) => log("error", source, msg),
};
