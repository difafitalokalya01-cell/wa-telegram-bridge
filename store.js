const fs     = require("fs");
const logger = require("./logger");

const CONFIG_FILE = "./config.json";
const DATA_FILE   = "./auth_sessions/data.json";

let _config = null;

// ===== WRITE QUEUE — anti race condition =====
let _isSaving = false;
const _saveQueue = [];

function _flushQueue() {
  if (_isSaving || _saveQueue.length === 0) return;
  _isSaving = true;
  const { file, content, resolve, reject } = _saveQueue.shift();
  try {
    fs.writeFileSync(file, content, "utf-8");
    resolve();
  } catch (e) {
    logger.error("Store", `Gagal tulis ${file}: ${e.message}`);
    reject(e);
  } finally {
    _isSaving = false;
    if (_saveQueue.length > 0) setImmediate(_flushQueue);
  }
}

function _writeFile(file, content) {
  return new Promise((resolve, reject) => {
    _saveQueue.push({ file, content, resolve, reject });
    _flushQueue();
  });
}

// ===== LOAD CONFIG =====
function loadConfig() {
  try {
    _config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch (e) {
    logger.error("Store", `Gagal baca config.json: ${e.message}`);
    _config = {};
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      _config.waAccounts       = data.waAccounts       || {};
      _config.activeAccounts   = data.activeAccounts   || {};
      _config.blacklist        = data.blacklist         || _config.blacklist        || [];
      _config.queueSettings    = data.queueSettings    || _config.queueSettings;
      _config.reminderSettings = data.reminderSettings || _config.reminderSettings;
      // Merge botPool dari data.json (status & waId bisa berubah runtime)
      if (data.botPool && Array.isArray(data.botPool)) {
        _config.botPool = _config.botPool.map((p) => {
          const saved = data.botPool.find((d) => d.id === p.id);
          return saved ? { ...p, waId: saved.waId, status: saved.status } : p;
        });
      }
    } catch (e) {
      logger.error("Store", `Gagal baca data.json: ${e.message}`);
    }
  }

  // Pastikan field wajib ada
  if (!_config.waAccounts)     _config.waAccounts     = {};
  if (!_config.activeAccounts) _config.activeAccounts = {};
  if (!_config.blacklist)      _config.blacklist       = [];
  if (!Array.isArray(_config.botPool)) _config.botPool = [];

  return _config;
}

function getConfig() {
  if (!_config) loadConfig();
  return _config;
}

// ===== SAVE DATA =====
async function saveData(cfg) {
  const c = cfg || _config;
  if (!c) return;
  _config = c;

  const data = {
    waAccounts:       c.waAccounts       || {},
    activeAccounts:   c.activeAccounts   || {},
    blacklist:        c.blacklist         || [],
    queueSettings:    c.queueSettings,
    reminderSettings: c.reminderSettings,
    // Simpan hanya waId & status dari botPool (token tetap di config.json)
    botPool: (c.botPool || []).map((p) => ({
      id:     p.id,
      waId:   p.waId   || null,
      status: p.status || "kosong",
    })),
  };

  await _writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// ===== POOL BOT HELPERS =====

// Cari slot kosong
function getSlotKosong() {
  const cfg = getConfig();
  return (cfg.botPool || []).find((p) => p.status === "kosong") || null;
}

// Cari slot berdasarkan waId
function getSlotByWaId(waId) {
  const cfg = getConfig();
  return (cfg.botPool || []).find((p) => p.waId === waId) || null;
}

// Assign waId ke slot
async function assignSlot(poolId, waId) {
  const cfg  = getConfig();
  const slot = cfg.botPool.find((p) => p.id === poolId);
  if (!slot) return false;
  slot.waId   = waId;
  slot.status = "terisi";
  await saveData(cfg);
  return true;
}

// Kosongkan slot
async function kosongkanSlot(poolId) {
  const cfg  = getConfig();
  const slot = cfg.botPool.find((p) => p.id === poolId);
  if (!slot) return false;
  slot.waId   = null;
  slot.status = "kosong";
  await saveData(cfg);
  return true;
}

module.exports = {
  loadConfig,
  getConfig,
  saveData,
  getSlotKosong,
  getSlotByWaId,
  assignSlot,
  kosongkanSlot,
};
