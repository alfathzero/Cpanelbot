const fs = require("fs");
const config = require("./config");
const DB_FILE = config.DB_FILE;

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return defaultDb();
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return migrateDb(raw);
  } catch { return defaultDb(); }
}

function defaultDb() {
  return {
    users: {},
    reseller_panels: {},
    started_users: {},
    vouchers: {},
    transactions: [],
    maintenance: { active: false, message: "Bot sedang dalam maintenance. Silakan coba lagi nanti." },
    audit_logs: [],
    daily_counts: {},
    last_daily_report: null,
    trial_enabled: true,
    referral_enabled: true,
    tickets: [],
    resource_alerts: [],
    auto_backup: { enabled: false, interval_hours: 6, last_run: null },
    points: {},
    templates: [],
    whitelist: { enabled: false, users: [] },
    scheduled_maintenance: { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." },
    friends: {},
    reviews: [],
    snapshots: {},
    uptime_history: {},
    bandwidth_history: {},
    resource_history: {},
    device_logs: {},
    down_counter: {},
    user_lang: {},
    user_theme: {},
    egg_presets: [],
    important_backups: {},
    rate_limits: {},
    miner_alerts: {},
    achievements: {},
    last_seen: {},
  };
}

function migrateDb(raw) {
  if (!raw.transactions)      raw.transactions = [];
  if (!raw.maintenance)       raw.maintenance = { active: false, message: "Bot sedang dalam maintenance." };
  if (!raw.audit_logs)        raw.audit_logs = [];
  if (!raw.daily_counts)      raw.daily_counts = {};
  if (!raw.last_daily_report) raw.last_daily_report = null;
  if (typeof raw.trial_enabled === "undefined")    raw.trial_enabled = true;
  if (typeof raw.referral_enabled === "undefined") raw.referral_enabled = true;
  if (!raw.tickets)           raw.tickets = [];
  if (!raw.resource_alerts)   raw.resource_alerts = [];
  if (!raw.auto_backup)       raw.auto_backup = { enabled: false, interval_hours: 6, last_run: null };
  if (!raw.started_users)     raw.started_users = {};
  if (!raw.points)            raw.points = {};
  if (!raw.templates)         raw.templates = [];
  if (!raw.whitelist)         raw.whitelist = { enabled: false, users: [] };
  if (!raw.scheduled_maintenance) raw.scheduled_maintenance = { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." };
  if (!raw.friends)            raw.friends = {};
  if (!raw.reviews)            raw.reviews = [];
  if (!raw.snapshots)          raw.snapshots = {};
  if (!raw.uptime_history)     raw.uptime_history = {};
  if (!raw.bandwidth_history)  raw.bandwidth_history = {};
  if (!raw.resource_history)   raw.resource_history = {};
  if (!raw.device_logs)        raw.device_logs = {};
  if (!raw.down_counter)       raw.down_counter = {};
  if (!raw.user_lang)          raw.user_lang = {};
  if (!raw.user_theme)         raw.user_theme = {};
  if (!raw.egg_presets)        raw.egg_presets = [];
  if (!raw.important_backups)  raw.important_backups = {};
  if (!raw.rate_limits)        raw.rate_limits = {};
  if (!raw.miner_alerts)       raw.miner_alerts = {};
  if (!raw.achievements)       raw.achievements = {};
  if (!raw.last_seen)          raw.last_seen = {};
  return raw;
}

// ─── New Feature Helpers ─────────────────────────────────────────────────────

// Friends
function addFriend(userId, friendId) {
  const d = loadDb();
  if (!d.friends[userId]) d.friends[userId] = [];
  if (!d.friends[userId].includes(String(friendId))) d.friends[userId].push(String(friendId));
  saveDb(d);
}
function removeFriend(userId, friendId) {
  const d = loadDb();
  if (d.friends[userId]) d.friends[userId] = d.friends[userId].filter(x => x !== String(friendId));
  saveDb(d);
}
function getFriends(userId) { return (loadDb().friends || {})[userId] || []; }
function isFriend(userId, friendId) { return getFriends(userId).includes(String(friendId)); }

// Reviews
function addReview(userId, serverId, rating, comment) {
  const d = loadDb();
  d.reviews = d.reviews || [];
  d.reviews = d.reviews.filter(r => !(r.userId === String(userId) && r.serverId === String(serverId)));
  d.reviews.push({ userId: String(userId), serverId: String(serverId), rating: Number(rating), comment: comment || "", timestamp: Date.now() });
  saveDb(d);
}
function getReviews(serverId) {
  const d = loadDb();
  return (d.reviews || []).filter(r => !serverId || r.serverId === String(serverId));
}
function getAverageRating(userId) {
  const d = loadDb();
  const userReviews = (d.reviews || []).filter(r => r.userId === String(userId));
  if (!userReviews.length) return null;
  return userReviews.reduce((a, b) => a + (b.rating || 0), 0) / userReviews.length;
}

// Snapshots
function saveSnapshot(serverId, name, data) {
  const d = loadDb();
  if (!d.snapshots[serverId]) d.snapshots[serverId] = [];
  d.snapshots[serverId].push({ id: genId(), name: name || `Snapshot ${new Date().toLocaleString("id-ID")}`, data, timestamp: Date.now() });
  if (d.snapshots[serverId].length > 5) d.snapshots[serverId].shift();
  saveDb(d);
}
function getSnapshots(serverId) { return (loadDb().snapshots || {})[serverId] || []; }
function getSnapshot(serverId, snapId) { return getSnapshots(serverId).find(s => s.id === snapId); }
function deleteSnapshot(serverId, snapId) {
  const d = loadDb();
  if (d.snapshots[serverId]) d.snapshots[serverId] = d.snapshots[serverId].filter(s => s.id !== snapId);
  saveDb(d);
}

// Uptime History
function logUptime(serverId, status) {
  const d = loadDb();
  if (!d.uptime_history[serverId]) d.uptime_history[serverId] = [];
  d.uptime_history[serverId].push({ t: Date.now(), s: status ? 1 : 0 });
  // Keep last 30 days max
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  d.uptime_history[serverId] = d.uptime_history[serverId].filter(e => e.t > cutoff).slice(-2000);
  saveDb(d);
}
function getUptimePercent(serverId, days = 30) {
  const hist = (loadDb().uptime_history || {})[serverId] || [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = hist.filter(e => e.t > cutoff);
  if (!recent.length) return null;
  const up = recent.filter(e => e.s === 1).length;
  return (up / recent.length) * 100;
}

// Bandwidth History
function logBandwidth(serverId, rx, tx) {
  const d = loadDb();
  if (!d.bandwidth_history[serverId]) d.bandwidth_history[serverId] = [];
  d.bandwidth_history[serverId].push({ t: Date.now(), rx: Number(rx) || 0, tx: Number(tx) || 0 });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  d.bandwidth_history[serverId] = d.bandwidth_history[serverId].filter(e => e.t > cutoff).slice(-500);
  saveDb(d);
}
function getBandwidthHistory(serverId) { return (loadDb().bandwidth_history || {})[serverId] || []; }

// Resource History (CPU/RAM/Disk per panel for graphs)
function logResource(serverId, cpu, ram, disk) {
  const d = loadDb();
  if (!d.resource_history[serverId]) d.resource_history[serverId] = [];
  d.resource_history[serverId].push({ t: Date.now(), cpu: Number(cpu) || 0, ram: Number(ram) || 0, disk: Number(disk) || 0 });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  d.resource_history[serverId] = d.resource_history[serverId].filter(e => e.t > cutoff).slice(-1000);
  saveDb(d);
}
function getResourceHistory(serverId) { return (loadDb().resource_history || {})[serverId] || []; }

// Top Resource Consumers
function getTopResourceConsumers(limit = 10) {
  const d = loadDb();
  const result = [];
  for (const sid of Object.keys(d.resource_history || {})) {
    const hist = d.resource_history[sid] || [];
    if (!hist.length) continue;
    const last = hist[hist.length - 1];
    result.push({ serverId: sid, cpu: last.cpu, ram: last.ram, disk: last.disk, total: last.cpu + last.ram });
  }
  return result.sort((a, b) => b.total - a.total).slice(0, limit);
}

// Device Logs
function logDevice(userId, info) {
  const d = loadDb();
  if (!d.device_logs[userId]) d.device_logs[userId] = { first_seen: Date.now(), language_code: info.language_code || "", username: info.username || "", chat_type: info.chat_type || "" };
  d.device_logs[userId].last_seen = Date.now();
  d.last_seen[userId] = Date.now();
  saveDb(d);
}
function getDeviceLog(userId) { return (loadDb().device_logs || {})[userId] || null; }

// Down counter (for auto-restart)
function incDownCounter(serverId) {
  const d = loadDb();
  d.down_counter[serverId] = (d.down_counter[serverId] || 0) + 1;
  saveDb(d);
  return d.down_counter[serverId];
}
function resetDownCounter(serverId) {
  const d = loadDb();
  delete d.down_counter[serverId];
  saveDb(d);
}

// User Language
function getUserLang(userId) { return (loadDb().user_lang || {})[userId] || "id"; }
function setUserLang(userId, lang) {
  const d = loadDb();
  d.user_lang[userId] = lang;
  saveDb(d);
}

// Egg Presets
function addEggPreset(preset) {
  const d = loadDb();
  d.egg_presets = d.egg_presets || [];
  d.egg_presets.push({ id: genId(), ...preset, createdAt: Date.now() });
  saveDb(d);
}
function getEggPresets() { return loadDb().egg_presets || []; }
function deleteEggPreset(id) {
  const d = loadDb();
  d.egg_presets = (d.egg_presets || []).filter(p => p.id !== id);
  saveDb(d);
}

// Important Backups
function markBackupImportant(userId, backupId, important) {
  const d = loadDb();
  if (!d.important_backups[userId]) d.important_backups[userId] = [];
  if (important && !d.important_backups[userId].includes(backupId)) d.important_backups[userId].push(backupId);
  if (!important) d.important_backups[userId] = d.important_backups[userId].filter(b => b !== backupId);
  saveDb(d);
}
function isBackupImportant(userId, backupId) { return ((loadDb().important_backups || {})[userId] || []).includes(backupId); }

// Rate Limit (in-memory cache + persistent for abuse history)
// In-memory rate limit cache (reset on restart — acceptable for rate limiting)
const _rateLimitCache = new Map();
function checkRateLimit(userId, maxPerMin = 10) {
  const key = String(userId);
  const now = Date.now();
  const win = 60 * 1000;
  const timestamps = (_rateLimitCache.get(key) || []).filter(t => now - t < win);
  if (timestamps.length >= maxPerMin) {
    _rateLimitCache.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  _rateLimitCache.set(key, timestamps);
  return true;
}

// Miner alerts
function recordMinerAlert(serverId, reason) {
const d = loadDb();
d.miner_alerts[serverId] = { t: Date.now(), reason };
saveDb(d);
}
function getMinerAlerts() { return loadDb().miner_alerts || {}; }
function clearMinerAlert(serverId) {
  const d = loadDb();
  delete d.miner_alerts[serverId];
  saveDb(d);
}

// Achievements
function awardAchievement(userId, badge) {
  const d = loadDb();
  if (!d.achievements[userId]) d.achievements[userId] = [];
  if (!d.achievements[userId].includes(badge)) {
    d.achievements[userId].push(badge);
    saveDb(d);
    return true;
  }
  return false;
}
function getAchievements(userId) { return (loadDb().achievements || {})[userId] || []; }

// User Theme (web dashboard)
function getUserTheme(userId) { return (loadDb().user_theme || {})[userId] || "dark"; }
function setUserTheme(userId, theme) {
  const d = loadDb();
  d.user_theme[userId] = theme;
  saveDb(d);
}

function saveDb(data) {
    const tmp = DB_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

// ─── Toggle Trial / Referral ──────────────────────────────────────────────────

function getTrialEnabled() {
  const db = loadDb();
  return typeof db.trial_enabled !== "undefined" ? db.trial_enabled : true;
}

function setTrialEnabled(enabled) {
  const db = loadDb();
  db.trial_enabled = !!enabled;
  saveDb(db);
}

function getReferralEnabled() {
  const db = loadDb();
  return typeof db.referral_enabled !== "undefined" ? db.referral_enabled : true;
}

function setReferralEnabled(enabled) {
  const db = loadDb();
  db.referral_enabled = !!enabled;
  saveDb(db);
}

// ─── Maintenance Mode ─────────────────────────────────────────────────────────

function getMaintenanceMode() { return loadDb().maintenance; }

function setMaintenanceMode(active, message) {
  const db = loadDb();
  db.maintenance = { active: !!active, message: message || "Bot sedang dalam maintenance. Silakan coba lagi nanti." };
  saveDb(db);
}

// ─── Auto Backup ──────────────────────────────────────────────────────────────

function getAutoBackup() {
  const db = loadDb();
  return db.auto_backup || { enabled: false, interval_hours: 6, last_run: null };
}

function setAutoBackup(settings) {
  const db = loadDb();
  db.auto_backup = Object.assign(
    { enabled: false, interval_hours: 6, last_run: null },
    db.auto_backup || {},
    settings
  );
  saveDb(db);
}

// ─── User ─────────────────────────────────────────────────────────────────────

function getUser(userId) {
  const db = loadDb();
  return db.users[String(userId)] || null;
}

function ensureUser(db, userId) {
  const uid = String(userId);
  if (!db.users[uid]) db.users[uid] = { role: "user", panel_count: 0 };
  return db.users[uid];
}

function setUserRole(userId, role) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.role = role;
  saveDb(db);
}

function getRole(userId) {
  const user = getUser(userId);
  return user ? user.role || "user" : "user";
}

function resetRole(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.role = "user";
  saveDb(db);
}

// ─── Blacklist ────────────────────────────────────────────────────────────────

function blacklistUser(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.blacklisted = true;
  saveDb(db);
}

function unblacklistUser(userId) {
  const db = loadDb();
  const uid = String(userId);
  if (db.users[uid]) { db.users[uid].blacklisted = false; saveDb(db); }
}

function isBlacklisted(userId) {
  const db = loadDb();
  return !!(db.users?.[String(userId)]?.blacklisted);
}

// ─── Panel Count ──────────────────────────────────────────────────────────────

function getPanelCount(userId) {
  const user = getUser(userId);
  return user ? user.panel_count || 0 : 0;
}

function incrementPanelCount(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.panel_count = (u.panel_count || 0) + 1;
  saveDb(db);
}

function decrementPanelCount(userId) {
  const db = loadDb();
  const uid = String(userId);
  if (db.users[uid] && db.users[uid].panel_count > 0) {
    db.users[uid].panel_count--;
    saveDb(db);
  }
}

// ─── Reseller Limit (count + expiry) ─────────────────────────────────────────
//
// Schema di user record:
// {
//   reseller_limit: {
//     count:       10,             // sisa slot panel
//     expire_date: "2026-06-15",   // null = tidak ada expiry
//     added_at:    "...",
//     added_by:    "..."
//   }
// }
//
// Cara pakai:
//   getResellerLimit(userId)                   → objek limit atau null
//   setResellerLimit(userId, count, expireDate, addedBy)  → set/update limit owner
//   checkResellerLimit(userId)                 → { ok, reason }
//   decrementResellerLimit(userId)             → kurangi count 1

function getResellerLimit(userId) {
  const u = getUser(userId);
  return u ? u.reseller_limit || null : null;
}

function setResellerLimit(userId, count, expireDate, addedBy) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.reseller_limit = {
    count:       Math.max(0, Number(count) || 0),
    expire_date: expireDate || null,  // ISO string atau null
    added_at:    new Date().toISOString(),
    added_by:    String(addedBy || ""),
  };
  saveDb(db);
}

function addResellerLimit(userId, extraCount, newExpireDate, addedBy) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  const existing = u.reseller_limit || { count: 0, expire_date: null };
  u.reseller_limit = {
    count:       Math.max(0, (existing.count || 0) + Math.max(0, Number(extraCount) || 0)),
    expire_date: newExpireDate !== undefined ? newExpireDate : existing.expire_date,
    added_at:    new Date().toISOString(),
    added_by:    String(addedBy || ""),
  };
  saveDb(db);
}

function checkResellerLimit(userId) {
  const lim = getResellerLimit(userId);
  if (!lim) return { ok: false, reason: "no_limit" };

  if (lim.expire_date) {
    const exp = new Date(lim.expire_date);
    if (isNaN(exp.getTime())) return { ok: false, reason: "invalid_date" };
    if (exp < new Date()) return { ok: false, reason: "expired", expDate: lim.expire_date };
  }

  if (lim.count <= 0) return { ok: false, reason: "no_count" };

  return { ok: true };
}

function decrementResellerLimit(userId) {
  const db = loadDb();
  const u = db.users[String(userId)];
  if (u && u.reseller_limit && u.reseller_limit.count > 0) {
    u.reseller_limit.count = Math.max(0, u.reseller_limit.count - 1);
    saveDb(db);
    return true;
  }
  return false;
}

// ─── Support Ticket ───────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function addTicket(userId, { subject, message }) {
  const db = loadDb();
  const id = genId();
  db.tickets.push({
    id,
    userId:     String(userId),
    subject:    subject || "Tanpa Judul",
    message,
    status:     "open",
    replies:    [],
    created_at: new Date().toISOString(),
    closed_at:  null,
  });
  if (db.tickets.length > 300) db.tickets = db.tickets.slice(-300);
  saveDb(db);
  return id;
}

function getTicketById(id) {
  return (loadDb().tickets || []).find(t => t.id === id) || null;
}

function getOpenTickets() {
  return (loadDb().tickets || []).filter(t => t.status === "open");
}

function getAllTickets(limit = 20) {
  const tickets = loadDb().tickets || [];
  return tickets.slice(-limit).reverse();
}

function getUserTickets(userId) {
  return (loadDb().tickets || []).filter(t => t.userId === String(userId)).reverse();
}

function addTicketReply(id, { fromId, message, isOwner }) {
  const db = loadDb();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return false;
  ticket.replies.push({
    fromId: String(fromId),
    message,
    isOwner: !!isOwner,
    at: new Date().toISOString(),
  });
  saveDb(db);
  return true;
}

function closeTicket(id) {
  const db = loadDb();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return false;
  ticket.status    = "closed";
  ticket.closed_at = new Date().toISOString();
  saveDb(db);
  return true;
}

// ─── Auto Renewal ─────────────────────────────────────────────────────────────

function getAutoRenewal(userId) {
  const u = getUser(userId);
  return u ? (typeof u.auto_renewal !== "undefined" ? u.auto_renewal : true) : true;
}

function setAutoRenewal(userId, enabled) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.auto_renewal = !!enabled;
  saveDb(db);
}

// ─── Resource Alerts ──────────────────────────────────────────────────────────

function addResourceAlert(userId, serverId, alertType) {
  const db = loadDb();
  if (!db.resource_alerts) db.resource_alerts = [];
  const key = `${serverId}_${alertType}`;
  const existing = db.resource_alerts.find(a => a.key === key);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.last_at = new Date().toISOString();
    saveDb(db);
    return existing.count;
  }
  db.resource_alerts.push({
    key,
    userId: String(userId),
    serverId: String(serverId),
    alertType,
    count: 1,
    first_at: new Date().toISOString(),
    last_at:  new Date().toISOString(),
  });
  if (db.resource_alerts.length > 200) db.resource_alerts = db.resource_alerts.slice(-200);
  saveDb(db);
  return 1;
}

function clearResourceAlert(serverId, alertType) {
  const db = loadDb();
  const key = `${serverId}_${alertType}`;
  db.resource_alerts = (db.resource_alerts || []).filter(a => a.key !== key);
  saveDb(db);
}

function getResourceAlertCount(serverId, alertType) {
  const db = loadDb();
  const key = `${serverId}_${alertType}`;
  const found = (db.resource_alerts || []).find(a => a.key === key);
  return found ? found.count : 0;
}

// ─── Trial Panel ──────────────────────────────────────────────────────────────

function hasUsedTrial(userId) {
  const u = getUser(userId);
  return !!(u && u.trial_used);
}

function markTrialUsed(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.trial_used = true;
  u.trial_at = new Date().toISOString();
  saveDb(db);
}

// ─── Rate Limit Harian ────────────────────────────────────────────────────────

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

function getDailyCount(userId) {
  const db = loadDb();
  const key = `${String(userId)}:${getTodayKey()}`;
  return (db.daily_counts || {})[key] || 0;
}

function incrementDailyCount(userId) {
  const db = loadDb();
  if (!db.daily_counts) db.daily_counts = {};
  const key = `${String(userId)}:${getTodayKey()}`;
  db.daily_counts[key] = (db.daily_counts[key] || 0) + 1;
  const today = getTodayKey();
  for (const k of Object.keys(db.daily_counts)) {
    const sep = k.lastIndexOf(":");
    if (sep === -1 || k.slice(sep + 1) !== today) delete db.daily_counts[k];
  }
  saveDb(db);
}
// ─── 2FA PIN ──────────────────────────────────────────────────────────────────

function setPin(userId, pin) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.pin = pin;
  saveDb(db);
}

function getPin(userId) {
  const u = getUser(userId);
  return u ? u.pin || null : null;
}

function clearPin(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  delete u.pin;
  saveDb(db);
}

// ─── Referral System ──────────────────────────────────────────────────────────

function getReferralCode(userId) {
  const u = getUser(userId);
  if (u && u.referral_code) return u.referral_code;
  const code = `REF${String(userId).slice(-6)}${Math.random().toString(36).slice(2,5).toUpperCase()}`;
  const db = loadDb();
  const user = ensureUser(db, userId);
  user.referral_code = code;
  saveDb(db);
  return code;
}

function getUserByReferralCode(code) {
  const db = loadDb();
  for (const [uid, u] of Object.entries(db.users || {})) {
    if (u.referral_code === code) return uid;
  }
  return null;
}

function applyReferral(newUserId, referrerId) {
  const db = loadDb();
  const uid = String(newUserId);
  const refId = String(referrerId);
  const u = ensureUser(db, uid);
  if (u.referred_by) return false;
  u.referred_by = refId;
  const ref = ensureUser(db, refId);
  if (!ref.referrals) ref.referrals = [];
  ref.referrals.push({ userId: uid, at: new Date().toISOString(), bonus_claimed: false });
  saveDb(db);
  return true;
}

function claimReferralBonus(referrerId) {
  const db = loadDb();
  const ref = ensureUser(db, referrerId);
  if (!ref.referrals) return 0;
  let count = 0;
  for (const r of ref.referrals) {
    if (!r.bonus_claimed) { r.bonus_claimed = true; count++; }
  }
  if (count > 0) {
    ref.referral_bonus_days = (ref.referral_bonus_days || 0) + count * (config.REFERRAL_BONUS_DAYS || 3);
    saveDb(db);
  }
  return count * (config.REFERRAL_BONUS_DAYS || 3);
}

function getReferralBonus(userId) {
  const u = getUser(userId);
  return u ? u.referral_bonus_days || 0 : 0;
}

function consumeReferralBonus(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  const bonus = u.referral_bonus_days || 0;
  u.referral_bonus_days = 0;
  saveDb(db);
  return bonus;
}

function getReferralStats(userId) {
  const u = getUser(userId);
  if (!u) return { code: getReferralCode(userId), referrals: [], bonus: 0 };
  const code = getReferralCode(userId);
  return {
    code,
    referrals: u.referrals || [],
    bonus: u.referral_bonus_days || 0,
    referred_by: u.referred_by || null,
  };
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

function addAuditLog(entry) {
  const db = loadDb();
  if (!db.audit_logs) db.audit_logs = [];
  db.audit_logs.unshift({ ...entry, at: new Date().toISOString() });
  if (db.audit_logs.length > 300) db.audit_logs = db.audit_logs.slice(0, 300);
  saveDb(db);
}

function getAuditLogs(limit = 20) {
  return (loadDb().audit_logs || []).slice(0, limit);
}

// ─── Daily Report ─────────────────────────────────────────────────────────────

function getLastDailyReport() { return loadDb().last_daily_report; }

function setLastDailyReport(dateStr) {
  const db = loadDb();
  db.last_daily_report = dateStr;
  saveDb(db);
}

// ─── Panel Records ────────────────────────────────────────────────────────────

function addPanelRecord(userId, panelData, expireHours = null) {
  const db = loadDb();
  const uid = String(userId);
  if (!db.reseller_panels) db.reseller_panels = {};
  if (!db.reseller_panels[uid]) db.reseller_panels[uid] = [];
  const ms = expireHours
    ? expireHours * 60 * 60 * 1000
    : config.PANEL_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
  const record = {
    ...panelData,
    created_at:  new Date().toISOString(),
    expire_date: new Date(Date.now() + ms).toISOString(),
    expired:     false,
    suspended:   false,
    suspended_at: null,
    auto_renewal: true,
  };
  db.reseller_panels[uid].push(record);
  saveDb(db);
}

function getUserPanels(userId) {
  const db = loadDb();
  return (db.reseller_panels || {})[String(userId)] || [];
}

function listAllUsers() { return loadDb().users || {}; }

function getPanelByServerId(serverId) {
  const db = loadDb();
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    const p = panels.find(p => String(p.server_id) === String(serverId));
    if (p) return { ...p, ownerUserId: uid };
  }
  return null;
}

function deletePanelRecord(userId, serverId) {
  const db = loadDb();
  const uid = String(userId);
  if (!db.reseller_panels?.[uid]) return false;
  const before = db.reseller_panels[uid].length;
  db.reseller_panels[uid] = db.reseller_panels[uid].filter(p => String(p.server_id) !== String(serverId));
  if (db.reseller_panels[uid].length !== before) { saveDb(db); return true; }
  return false;
}

function transferPanel(fromUserId, toUserId, serverId) {
  const db = loadDb();
  const from = String(fromUserId);
  const to   = String(toUserId);
  const idx  = (db.reseller_panels?.[from] || []).findIndex(p => String(p.server_id) === String(serverId));
  if (idx === -1) return false;
  const [panel] = db.reseller_panels[from].splice(idx, 1);
  if (!db.reseller_panels[to]) db.reseller_panels[to] = [];
  panel.userId = to;
  db.reseller_panels[to].push(panel);
  saveDb(db);
  return true;
}

function markPanelExpired(userId, serverId) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.expired = true;
  saveDb(db);
  return true;
}

function markPanelSuspended(userId, serverId, suspended) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.suspended    = !!suspended;
  p.suspended_at = suspended ? new Date().toISOString() : null;
  saveDb(db);
  return true;
}

function extendPanel(userId, serverId, extraDays) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  const current = p.expire_date ? new Date(p.expire_date) : new Date();
  const base = current < new Date() ? new Date() : current;
  p.expire_date = new Date(base.getTime() + extraDays * 24 * 60 * 60 * 1000).toISOString();
  p.expired     = false;
  saveDb(db);
  return true;
}

function updatePanelPlan(userId, serverId, planName) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.plan_name = planName;
  saveDb(db);
  return true;
}

function updatePanelName(userId, serverId, name) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.name = name;
  saveDb(db);
  return true;
}

function getAllPanels() {
  const db = loadDb();
  const result = [];
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    for (const p of panels) {
      result.push({ ...p, userId: uid });
    }
  }
  return result;
}

function getExpiringPanels(daysAhead) {
  const result = [];
  const db = loadDb();
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    for (const p of panels) {
      if (!p.expire_date) continue;
      const dl = Math.ceil((new Date(p.expire_date) - new Date()) / (1000 * 60 * 60 * 24));
      const match = daysAhead === 0 ? dl <= 0 : (dl > 0 && dl <= daysAhead);
      if (match) result.push({ userId: uid, panel: p });
    }
  }
  return result;
}

function getSuspendedExpiredPanels(afterDays) {
  const result = [];
  const db = loadDb();
  const cutoff = new Date(Date.now() - afterDays * 24 * 60 * 60 * 1000);
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    for (const p of panels) {
      if (!p.suspended) continue;
      const suspAt = p.suspended_at ? new Date(p.suspended_at) : null;
      if (suspAt && suspAt < cutoff) result.push({ userId: uid, panel: p });
    }
  }
  return result;
}

// ─── Pending Days (Voucher Hari tersimpan di DB agar tidak hilang) ────────────

function getPendingDays(userId) {
  const u = getUser(userId);
  return u ? (u.pending_days || 0) : 0;
}

function setPendingDays(userId, days) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.pending_days = Math.max(0, Number(days) || 0);
  saveDb(db);
}

function clearPendingDays(userId) {
  const db = loadDb();
  const u = db.users?.[String(userId)];
  if (u) { u.pending_days = 0; saveDb(db); }
}

// ─── Transactions ─────────────────────────────────────────────────────────────

function addTransaction(userId, { type, detail }) {
  const db = loadDb();
  if (!db.transactions) db.transactions = [];
  db.transactions.unshift({
    userId: String(userId),
    type,
    detail,
    at: new Date().toISOString(),
  });
  if (db.transactions.length > 1000) db.transactions = db.transactions.slice(0, 1000);
  saveDb(db);
}

function getUserTransactions(userId, limit = 10) {
  const txs = loadDb().transactions || [];
  return txs.filter(t => t.userId === String(userId)).slice(0, limit);
}

function getAllTransactions(limit = 50) {
  return (loadDb().transactions || []).slice(0, limit);
}

// ─── Started Users ────────────────────────────────────────────────────────────

function registerStartedUser(userId, from) {
  const db = loadDb();
  if (!db.started_users) db.started_users = {};
  db.started_users[String(userId)] = {
    first_name: from.first_name,
    last_name:  from.last_name,
    username:   from.username,
    at:         new Date().toISOString(),
  };
  saveDb(db);
}

function hasStarted(userId) {
  return !!(loadDb().started_users?.[String(userId)]);
}

function getAllStartedUsers() {
  const db = loadDb();
  return Object.keys(db.started_users || {});
}

// ─── Voucher System ───────────────────────────────────────────────────────────

function genVoucherCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "PTERO-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createVoucher(type, { role, discount, days, maxUses, code }) {
  const db = loadDb();
  if (!db.vouchers) db.vouchers = {};
  const vCode = code || genVoucherCode();
  db.vouchers[vCode] = {
    type,
    role:     role || null,
    discount: discount || null,
    days:     days || null,
    maxUses:  maxUses || 1,
    uses:     0,
    usedBy:   [],
    created_at: new Date().toISOString(),
  };
  saveDb(db);
  return vCode;
}

function getVoucher(code) {
  return (loadDb().vouchers || {})[code] || null;
}

function useVoucher(code, userId) {
  const db = loadDb();
  const v = (db.vouchers || {})[code];
  if (!v) return { ok: false, reason: "not_found" };
  if (v.usedBy.includes(String(userId))) return { ok: false, reason: "already_used" };
  if (v.uses >= v.maxUses) return { ok: false, reason: "exhausted" };
  v.uses++;
  v.usedBy.push(String(userId));
  saveDb(db);
  return { ok: true, voucher: v };
}

function getAllVouchers() {
  return loadDb().vouchers || {};
}

function deleteVoucher(code) {
  const db = loadDb();
  if (!db.vouchers?.[code]) return false;
  delete db.vouchers[code];
  saveDb(db);
  return true;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function getStats() {
  const db = loadDb();
  const now = new Date();

  // ── User counts ────────────────────────────────────────────────────
  const users    = db.users || {};
  const userList = Object.values(users);
  const started  = Object.keys(db.started_users || {}).length;
  const resellers = userList.filter(u => u.role === "reseller").length;
  const premiums  = userList.filter(u => u.role === "premium").length;
  const owners    = userList.filter(u => u.role === "owner").length;

  // ── Panel counts ───────────────────────────────────────────────────
  let totalPanels = 0, activePanels = 0, suspendedPanels = 0, expiredPanels = 0;
  for (const panels of Object.values(db.reseller_panels || {})) {
    for (const p of panels) {
      totalPanels++;
      if (p.suspended) { suspendedPanels++; continue; }
      if (p.expired || (p.expire_date && new Date(p.expire_date) < now)) { expiredPanels++; continue; }
      activePanels++;
    }
  }

  // ── Voucher counts ─────────────────────────────────────────────────
  const vouchers     = Object.values(db.vouchers || {});
  const voucherTotal = vouchers.length;
  const voucherUsed  = vouchers.filter(v => v.uses > 0).length;

  // ── Transaction count ──────────────────────────────────────────────
  const transactions = (db.transactions || []).length;

  // ── Tickets ────────────────────────────────────────────────────────
  const openTickets  = (db.tickets || []).filter(t => t.status === "open").length;

  return {
    started, resellers, premiums, owners,
    totalPanels, activePanels, suspendedPanels, expiredPanels,
    voucherTotal, voucherUsed,
    transactions,
    openTickets,
    totalUsers: Object.keys(users).length,
  };
}

// ─── Points / Reward System ───────────────────────────────────────────────────

function getPoints(userId) {
  const db = loadDb();
  return (db.points || {})[String(userId)] || 0;
}

function addPoints(userId, pts) {
  if (!pts || pts <= 0) return;
  const db = loadDb();
  if (!db.points) db.points = {};
  db.points[String(userId)] = (db.points[String(userId)] || 0) + pts;
  saveDb(db);
}

function spendPoints(userId, pts) {
  const db = loadDb();
  if (!db.points) db.points = {};
  const current = db.points[String(userId)] || 0;
  if (current < pts) return false;
  db.points[String(userId)] = current - pts;
  saveDb(db);
  return true;
}

function getPointsLeaderboard(limit = 10) {
  const db = loadDb();
  return Object.entries(db.points || {})
    .map(([uid, pts]) => ({ userId: uid, points: pts }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

// ─── Panel Templates ──────────────────────────────────────────────────────────

function saveTemplate(name, cfg) {
  const db = loadDb();
  if (!db.templates) db.templates = [];
  const idx = db.templates.findIndex(t => t.name === name);
  if (idx !== -1) db.templates[idx] = { name, ...cfg, updated_at: new Date().toISOString() };
  else db.templates.push({ name, ...cfg, created_at: new Date().toISOString() });
  saveDb(db);
}

function getTemplates() {
  return loadDb().templates || [];
}

function deleteTemplate(name) {
  const db = loadDb();
  const before = (db.templates || []).length;
  db.templates = (db.templates || []).filter(t => t.name !== name);
  if (db.templates.length !== before) { saveDb(db); return true; }
  return false;
}

// ─── Whitelist System ─────────────────────────────────────────────────────────

function getWhitelistMode() {
  return !!(loadDb().whitelist?.enabled);
}

function setWhitelistMode(enabled) {
  const db = loadDb();
  if (!db.whitelist) db.whitelist = { enabled: false, users: [] };
  db.whitelist.enabled = !!enabled;
  saveDb(db);
}

function isWhitelisted(userId) {
  const db = loadDb();
  return (db.whitelist?.users || []).includes(String(userId));
}

function addToWhitelist(userId) {
  const db = loadDb();
  if (!db.whitelist) db.whitelist = { enabled: false, users: [] };
  const uid = String(userId);
  if (!db.whitelist.users.includes(uid)) { db.whitelist.users.push(uid); saveDb(db); return true; }
  return false;
}

function removeFromWhitelist(userId) {
  const db = loadDb();
  if (!db.whitelist) return false;
  const before = db.whitelist.users.length;
  db.whitelist.users = db.whitelist.users.filter(u => u !== String(userId));
  if (db.whitelist.users.length !== before) { saveDb(db); return true; }
  return false;
}

function getWhitelistUsers() {
  return loadDb().whitelist?.users || [];
}

// ─── Scheduled Maintenance ────────────────────────────────────────────────────

function getScheduledMaintenance() {
  const db = loadDb();
  return db.scheduled_maintenance || { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." };
}

function setScheduledMaintenance(settings) {
  const db = loadDb();
  db.scheduled_maintenance = Object.assign(
    { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." },
    db.scheduled_maintenance || {},
    settings
  );
  saveDb(db);
}

// ─── Referral Leaderboard ─────────────────────────────────────────────────────

function getReferralLeaderboard(limit = 10) {
  const db = loadDb();
  return Object.entries(db.users || {})
    .map(([uid, u]) => ({
      userId: uid,
      code:   u.referral_code || "",
      count:  (u.referrals || []).length,
    }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

module.exports = {
  loadDb, saveDb,
  getTrialEnabled, setTrialEnabled,
  getReferralEnabled, setReferralEnabled,
  getMaintenanceMode, setMaintenanceMode,
  getAutoBackup, setAutoBackup,
  getUser, ensureUser, setUserRole, getRole, resetRole,
  blacklistUser, unblacklistUser, isBlacklisted,
  getPanelCount, incrementPanelCount, decrementPanelCount,
  getResellerLimit, setResellerLimit, addResellerLimit, checkResellerLimit, decrementResellerLimit,
  addTicket, getTicketById, getOpenTickets, getAllTickets, getUserTickets,
  addTicketReply, closeTicket,
  getAutoRenewal, setAutoRenewal,
  addResourceAlert, clearResourceAlert, getResourceAlertCount,
  hasUsedTrial, markTrialUsed,
  getTodayKey, getDailyCount, incrementDailyCount,
  setPin, getPin, clearPin,
  getReferralCode, getUserByReferralCode, applyReferral,
  claimReferralBonus, getReferralBonus, consumeReferralBonus, getReferralStats,
  addAuditLog, getAuditLogs,
  getLastDailyReport, setLastDailyReport,
  addPanelRecord, getUserPanels, listAllUsers,
  getPanelByServerId, deletePanelRecord, markPanelExpired, markPanelSuspended, extendPanel, transferPanel, updatePanelPlan,
  updatePanelName, getAllPanels, getExpiringPanels, getSuspendedExpiredPanels,
  getPendingDays, setPendingDays, clearPendingDays,
  addTransaction, getUserTransactions, getAllTransactions,
  registerStartedUser, hasStarted, getAllStartedUsers,
  createVoucher, getVoucher, useVoucher, getAllVouchers, deleteVoucher,
  getStats, genId,
  getPoints, addPoints, spendPoints, getPointsLeaderboard,
  saveTemplate, getTemplates, deleteTemplate,
  getWhitelistMode, setWhitelistMode, isWhitelisted, addToWhitelist, removeFromWhitelist, getWhitelistUsers,
  getScheduledMaintenance, setScheduledMaintenance,
  getReferralLeaderboard,
  // New features
  addFriend, removeFriend, getFriends, isFriend,
  addReview, getReviews, getAverageRating,
  saveSnapshot, getSnapshots, getSnapshot, deleteSnapshot,
  logUptime, getUptimePercent,
  logBandwidth, getBandwidthHistory,
  logResource, getResourceHistory, getTopResourceConsumers,
  logDevice, getDeviceLog,
  incDownCounter, resetDownCounter,
  getUserLang, setUserLang,
  addEggPreset, getEggPresets, deleteEggPreset,
  markBackupImportant, isBackupImportant,
  checkRateLimit,
  recordMinerAlert, getMinerAlerts, clearMinerAlert,
  awardAchievement, getAchievements,
  getUserTheme, setUserTheme,
};
