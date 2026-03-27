const logger = require("./logger");
const fs = require("fs");
const QUEUE_FILE = "./auth_sessions/queue_backup.json";

let queue = [];
let isProcessing = false;
let sendFunction = null;
let presenceFunction = null;

// Simpan jid terakhir yang dibalas per waId
let lastJid = {};

let settings = {
  typingSpeed: "normal",
  randomDelay: true,
  minDelay: 3,
  maxDelay: 10,
  // Jeda baca (detik)
  readDelayShort: { min: 30, max: 60 },      // <50 karakter
  readDelayMedium: { min: 60, max: 180 },    // 50-200 karakter
  readDelayLong: { min: 180, max: 420 },     // >200 karakter
  // Jeda pikir (detik)
  thinkDelayMin: 120,
  thinkDelayMax: 300,
  // Jeda pindah chat (detik)
  switchChatDelayMin: 120,
  switchChatDelayMax: 480,
};

// Load antrian dari backup
// Hanya load pesan yang tidak lebih dari 10 menit — pesan lama dibuang
if (fs.existsSync(QUEUE_FILE)) {
  try {
    const raw      = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    const batasWaktu = Date.now() - 10 * 60 * 1000; // 10 menit
    queue = raw.filter((item) => item.waktu && item.waktu > batasWaktu);
    const dibuang = raw.length - queue.length;
    logger.info("Queue", `Loaded ${queue.length} pesan dari backup (${dibuang} pesan lama dibuang)`);
  } catch (e) {
    queue = [];
  }
}

function saveBackup() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    logger.error("Queue", `Gagal save backup: ${e.message}`);
  }
}

function randomAntara(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// Hitung jeda baca berdasarkan panjang pesan MASUK dari kandidat
function hitungJedaBaca(panjangPesanMasuk) {
  let range;
  if (panjangPesanMasuk < 50) {
    range = settings.readDelayShort;
  } else if (panjangPesanMasuk <= 200) {
    range = settings.readDelayMedium;
  } else {
    range = settings.readDelayLong;
  }
  return randomAntara(range.min, range.max) * 1000;
}

// Hitung jeda pikir
function hitungJedaPikir() {
  return randomAntara(settings.thinkDelayMin, settings.thinkDelayMax) * 1000;
}

// Hitung jeda pindah chat
function hitungJedaPindahChat() {
  return randomAntara(settings.switchChatDelayMin, settings.switchChatDelayMax) * 1000;
}

// Hitung jeda ketik berdasarkan panjang pesan KELUAR
function hitungJedaKetik(teks) {
  const speeds = { lambat: 30, normal: 50, cepat: 80 };
  const cps = speeds[settings.typingSpeed] || 50;
  let jeda = (teks.length / cps) * 1000;

  if (settings.randomDelay) {
    const extra = randomAntara(settings.minDelay, settings.maxDelay) * 1000;
    jeda += extra;
  }

  return Math.max(jeda, settings.minDelay * 1000);
}

async function tunggu(ms, label) {
  const detik = Math.round(ms / 1000);
  const menit = Math.floor(detik / 60);
  const sisa = detik % 60;
  const labelWaktu = menit > 0 ? `${menit}m ${sisa}s` : `${sisa}s`;
  logger.info("Queue", `${label}: ${labelWaktu}`);
  await new Promise((r) => setTimeout(r, ms));
}

async function prosesAntrian() {
  if (isProcessing || queue.length === 0 || !sendFunction) return;
  isProcessing = true;

  while (queue.length > 0) {
    const item = queue[0];

    // ===== LAPIS 3: Jeda pindah chat =====
    const waLastJid = lastJid[item.waId];
    if (waLastJid && waLastJid !== item.jid) {
      const jedaPindah = hitungJedaPindahChat();
      await tunggu(jedaPindah, `Jeda pindah chat ${item.waId}`);
    }

    // ===== LAPIS 1: Jeda baca =====
    const panjangPesanMasuk = item.panjangPesanMasuk || 0;
    if (panjangPesanMasuk > 0) {
      const jedaBaca = hitungJedaBaca(panjangPesanMasuk);
      await tunggu(jedaBaca, `Jeda baca pesan dari ${item.jid}`);
    }

    // ===== LAPIS 2: Jeda pikir =====
    const jedaPikir = hitungJedaPikir();
    await tunggu(jedaPikir, `Jeda pikir sebelum balas ${item.jid}`);

    // ===== STATUS ONLINE =====
    if (presenceFunction) {
      try {
        await presenceFunction(item.waId, item.jid, "available");
        await tunggu(1000, "Online sebentar");
      } catch (e) {
        logger.error("Queue", `Gagal set online: ${e.message}`);
      }
    }

    // ===== LAPIS 4: Typing indicator =====
    const pesanTeks = item.pesan || "";
    const jedaKetik = hitungJedaKetik(pesanTeks);

    if (presenceFunction) {
      try {
        await presenceFunction(item.waId, item.jid, "composing");
        await tunggu(jedaKetik, `Typing ke ${item.jid}`);
        await presenceFunction(item.waId, item.jid, "paused");
      } catch (e) {
        logger.error("Queue", `Gagal set typing: ${e.message}`);
      }
    } else {
      await tunggu(jedaKetik, `Jeda ketik ke ${item.jid}`);
    }

    // ===== KIRIM PESAN =====
    try {
      await sendFunction(item.waId, item.jid, item.pesan, item.media);
      lastJid[item.waId] = item.jid;
      logger.info("Queue", `Terkirim ke ${item.jid} via ${item.waId}`);
    } catch (err) {
      logger.error("Queue", `Gagal kirim ke ${item.jid}: ${err.message}`);
    }

    queue.shift();
    saveBackup();
  }

  isProcessing = false;
}

function tambahKeAntrian(waId, jid, pesan, media = null, panjangPesanMasuk = 0) {
  queue.push({ waId, jid, pesan, media, panjangPesanMasuk, waktu: Date.now() });
  saveBackup();
  prosesAntrian();
}

function setSendFunction(fn) {
  sendFunction = fn;
}

function setPresenceFunction(fn) {
  presenceFunction = fn;
}

function updateSettings(newSettings) {
  settings = { ...settings, ...newSettings };
}

function getStatus() {
  return {
    panjangAntrian: queue.length,
    sedangProses: isProcessing,
    lastJid,
  };
}

module.exports = {
  tambahKeAntrian,
  setSendFunction,
  setPresenceFunction,
  updateSettings,
  getStatus,
};