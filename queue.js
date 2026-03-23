const logger = require("./logger");
const fs = require("fs");
const QUEUE_FILE = "./queue_backup.json";

let queue = [];
let isProcessing = false;
let sendFunction = null;
let settings = { typingSpeed: "normal", randomDelay: true, minDelay: 3, maxDelay: 10 };

// Load antrian dari backup kalau ada
if (fs.existsSync(QUEUE_FILE)) {
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    logger.info("Queue", `Loaded ${queue.length} pesan dari backup`);
  } catch (e) {
    queue = [];
  }
}

function saveBackup() {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function hitungJeda(teks) {
  const speeds = { lambat: 30, normal: 50, cepat: 80 };
  const cps = speeds[settings.typingSpeed] || 50;
  let jeda = (teks.length / cps) * 1000;

  if (settings.randomDelay) {
    const extra = (Math.random() * (settings.maxDelay - settings.minDelay) + settings.minDelay) * 1000;
    jeda += extra;
  }

  return Math.max(jeda, settings.minDelay * 1000);
}

async function prosesAntrian() {
  if (isProcessing || queue.length === 0 || !sendFunction) return;
  isProcessing = true;

  while (queue.length > 0) {
    const item = queue[0];
    const jeda = hitungJeda(item.pesan);

    logger.info("Queue", `Menunggu ${Math.round(jeda / 1000)}s sebelum kirim ke ${item.jid}`);
    await new Promise((r) => setTimeout(r, jeda));

    try {
      await sendFunction(item.waId, item.jid, item.pesan, item.media);
      logger.info("Queue", `Terkirim ke ${item.jid}`);
    } catch (err) {
      logger.error("Queue", `Gagal kirim ke ${item.jid}: ${err.message}`);
    }

    queue.shift();
    saveBackup();
  }

  isProcessing = false;
}

function tambahKeAntrian(waId, jid, pesan, media = null) {
  queue.push({ waId, jid, pesan, media, waktu: Date.now() });
  saveBackup();
  prosesAntrian();
}

function setSendFunction(fn) {
  sendFunction = fn;
}

function updateSettings(newSettings) {
  settings = { ...settings, ...newSettings };
}

function getStatus() {
  return { panjangAntrian: queue.length, sedangProses: isProcessing };
}

module.exports = { tambahKeAntrian, setSendFunction, updateSettings, getStatus };
