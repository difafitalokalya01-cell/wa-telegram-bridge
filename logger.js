const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logDir, `${date}.log`);
}

function log(level, source, message) {
  const time = new Date().toISOString();
  const line = `[${time}] [${level.toUpperCase()}] [${source}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(getLogFile(), line);
}

module.exports = {
  info: (source, msg) => log("info", source, msg),
  warn: (source, msg) => log("warn", source, msg),
  error: (source, msg) => log("error", source, msg),
};
