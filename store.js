const fs = require("fs");
const logger = require("./logger");

const CONFIG_FILE = "./config.json";
const DATA_FILE   = "./auth_sessions/data.json";

// ===== IN-MEMORY STATE =====
let _config = null;
let _data   = null;

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
      _config.waAccounts      = data.waAccounts      || {};
      _config.activeAccounts  = data.activeAccounts  || {};
      _config.blacklist       = data.blacklist        || _config.blacklist || [];
      _config.queueSettings   = data.queueSettings   || _config.queueSettings;
      _config.reminderSettings= data.reminderSettings|| _config.reminderSettings;
      _config.botPool         = data.botPool          || {};
    } catch (e) {
      logger.error("Store", `Gagal baca data.json: ${e.message}`);
    }
  }

  return _config;
}

// ===== GET CONFIG (pakai cache, tidak baca file lagi) =====
function getConfig() {
  if (!_config) loadConfig();
  return _config;
}

// ===== SAVE DATA (bagian yang berubah-ubah saat runtime) =====
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
    botPool:          c.botPool           || {},
  };

  await _writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// ===== HELPERS UPDATE PARSIAL =====
async function updateBlacklist(list) {
  const cfg = getConfig();
  cfg.blacklist = list;
  await saveData(cfg);
}

async function updateQueueSettings(settings) {
  const cfg = getConfig();
  cfg.queueSettings = { ...cfg.queueSettings, ...settings };
  await saveData(cfg);
}

async function updateReminderSettings(settings) {
  const cfg = getConfig();
  cfg.reminderSettings = { ...cfg.reminderSettings, ...settings };
  await saveData(cfg);
}

async function updateWaAccounts(waAccounts, activeAccounts) {
  const cfg = getConfig();
  if (waAccounts)     cfg.waAccounts     = waAccounts;
  if (activeAccounts) cfg.activeAccounts = activeAccounts;
  await saveData(cfg);
}

module.exports = {
  loadConfig,
  getConfig,
  saveData,
  updateBlacklist,
  updateQueueSettings,
  updateReminderSettings,
  updateWaAccounts,
};
