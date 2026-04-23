const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const config = require("./config");
// Helper: emoji toggle (diambil dari config.TOGGLE_EMOJI, fallback ke 🟢/🔴)
const TON  = () => (config.TOGGLE_EMOJI || {}).ON  || `${tge("GREEN_DOT","🟢")}`;
const TOFF = () => (config.TOGGLE_EMOJI || {}).OFF || `${tge("RED_DOT","🔴")}`;

// Helper: premium animated emoji (tg-emoji) untuk TEKS PESAN (bukan tombol)
// Jika ID diisi di config.PREMIUM_EMOJI[key], tampilkan animated emoji via HTML.
// Jika kosong/tidak ada, fallback ke emoji Unicode biasa.
function tge(key, fallback = "") {
  const id = ((config.PREMIUM_EMOJI || {})[key] || "").trim();
  // Strip any HTML tags from fallback (prevents nested <tg-emoji> tags)
  const plain = String(fallback).replace(/<[^>]+>/g, "");
  if (!id || !/^\d{6,}$/.test(id)) return plain;
  const safe = plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<tg-emoji emoji-id="${id}">${safe || "·"}</tg-emoji>`;
}

// Helper: escape HTML untuk teks yang mengandung karakter khusus
function he2(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// Helper: buat parse mode pesan — pakai HTML jika ada PREMIUM_EMOJI yang diisi,
// pakai Markdown jika semua ID kosong (backward-compatible)
function pmode() {
  // Pesan-pesan sudah dikonversi ke HTML (dengan <b>, <tg-emoji>, dll)
  // sehingga selalu pakai HTML parse_mode.
  return "HTML";
}

// Helper: bold teks — otomatis sesuai parse_mode yang aktif
function bold(s) {
  return pmode() === "HTML" ? `<b>${he2(s)}</b>` : `*${s}*`;
}

// Helper: monospace teks
function mono(s) {
  return pmode() === "HTML" ? `<code>${he2(s)}</code>` : `\`${s}\``;
}

const db = require("./database");
const ptero = require("./pterodactyl");
const { startDashboard } = require("./dashboard");
const features = require("./features");

// ─── Multi-Server Helpers ─────────────────────────────────────────────────────
// Server 1 = panel utama; Server 2 = panel kedua (hanya owner secara default).
// Akses per role diatur via config.SERVER_ACCESS

// Daftar nomor server yang boleh dipakai oleh role tertentu.
function allowedServers(role) {
  const access = (config.SERVER_ACCESS || {});
  const list = Array.isArray(access[role]) ? access[role] : [1];
  // Pastikan unik dan minimal 1 entri
  const out = Array.from(new Set(list.map(n => Number(n)))).filter(n => n === 1 || n === 2);
  return out.length ? out : [1];
}

// Cek apakah role boleh memakai server tertentu
function canUseServer(role, serverNum) {
  return allowedServers(role).includes(Number(serverNum) || 1);
}

// Ambil server_num dari record panel (default 1 untuk panel lama)
function psn(panel) {
  return panel && panel.server_num ? Number(panel.server_num) : 1;
}

// Nama tampilan server
function serverLabel(n) {
  const num = Number(n) || 1;
  return ((config.SERVER_NAMES || {})[num]) || `Server ${num}`;
}

// URL panel untuk login sesuai server
function serverUrl(n) {
  return Number(n) === 2 ? (config.PANEL_URL2 || config.PANEL_URL) : config.PANEL_URL;
}

// Keyboard pemilih server untuk flow create panel
function serverPickerKeyboard(role, prefix = "pick_srv_") {
  const list = allowedServers(role);
  const rows = list.map(n => [Markup.button.callback(`🖥️ ${serverLabel(n)}`, `${prefix}${n}`)]);
  rows.push([Markup.button.callback("❌ Batal", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

// Cari nomor server dari serverId (untuk operasi by raw serverId)
// Cek record panel dulu; kalau tidak ada, fallback ke session (admin_srv) atau 1
function srvOf(serverId, sess = null) {
  try {
    const rec = db.getPanelByServerId(serverId);
    if (rec && rec.server_num) return Number(rec.server_num);
  } catch {}
  if (sess && sess.admin_srv) return Number(sess.admin_srv);
  return 1;
}

const bot = new Telegraf(config.BOT_TOKEN);
const BOT_START_TIME = Date.now();

// Cache status node untuk alert down
const nodeStatusCache = new Map();

// ─── Middleware: Maintenance Mode ─────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const maint = db.getMaintenanceMode();
  if (!maint.active) return next();
  const userId = ctx.from?.id;
  if (userId && isOwner(userId)) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("WRENCH","🔧")} ` + maint.message, { show_alert: true });
    return;
  }
  if (ctx.message) {
    return ctx.reply(`${tge("WRENCH","🔧")} <b>Maintenance</b>\n\n${maint.message}`, { parse_mode: "HTML" });
  }
});

// ─── Middleware: Whitelist Mode ────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (!db.getWhitelistMode()) return next();
  const userId = ctx.from?.id;
  if (!userId) return next();
  if (isOwner(userId) || db.isWhitelisted(userId)) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("LOCK","🔒")} Akses terbatas. Kamu belum di-whitelist.`, { show_alert: true });
    return;
  }
  if (ctx.message) {
    return ctx.reply(`${tge("LOCK","🔒")} <b>Mode Whitelist Aktif</b>\n\nBot ini hanya bisa digunakan oleh user yang telah diizinkan owner.\nHubungi owner untuk mendapatkan akses.`, { parse_mode: "HTML" });
  }
});

// ─── Middleware: Scheduled Maintenance ────────────────────────────────────────

bot.use(async (ctx, next) => {
  const sm = db.getScheduledMaintenance();
  if (!sm.enabled) return next();
  const userId = ctx.from?.id;
  if (userId && isOwner(userId)) return next();
  const now = new Date();
  const [sh, smin] = (sm.start || "00:00").split(":").map(Number);
    const [eh, em]   = (sm.end   || "00:00").split(":").map(Number);
    const curMin   = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + smin;
    const endMin   = eh * 60 + em;
    // Cek hari aktif (0=Minggu..6=Sabtu) — array kosong berarti setiap hari
    const smDays = Array.isArray(sm.days) ? sm.days : [];
    if (smDays.length > 0 && !smDays.includes(now.getDay())) return next();
    const inWindow = startMin < endMin
      ? curMin >= startMin && curMin < endMin
      : curMin >= startMin || curMin < endMin;
  if (!inWindow) return next();
  const msg = sm.message || "Bot sedang dalam pemeliharaan terjadwal. Silakan coba lagi nanti.";
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("WRENCH","🔧")} ${msg}`, { show_alert: true });
    return;
  }
  if (ctx.message) return ctx.reply(`${tge("WRENCH","🔧")} <b>Pemeliharaan Terjadwal</b>\n\n${msg}\n\n${tge("ALARM","⏰")} Waktu: ${sm.start} – ${sm.end}`, { parse_mode: "HTML" });
});

// ─── Middleware: Group Only ────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (!config.GROUP_ONLY || !config.GROUP_ID) return next();
  const chatId = ctx.chat?.id;
  const isAllowedGroup = String(chatId) === String(config.GROUP_ID);
  if (isAllowedGroup) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("PROHIBITED","🚫")} Bot hanya aktif di grup resmi!`, { show_alert: true });
    return;
  }
  if (ctx.message) {
    return ctx.reply(
      `${tge("PROHIBITED","🚫")} <b>Bot hanya aktif di grup resmi!</b>\n\nBot ini tidak dapat digunakan di chat pribadi atau grup lain.\nSilakan gunakan bot di grup yang sudah terdaftar.`,
      { parse_mode: "HTML" }
    );
  }
});

// ─── Logger ───────────────────────────────────────────────────────────────────

const logger = require("./logger");
const botLog = (level, tag, msg, err) => logger.log(level, tag, msg, err);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePassword(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let pass = "";
  for (let i = 0; i < len; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
}

function generateEmail(username) {
  const rand = Math.random().toString(36).slice(2, 7);
  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return `${clean}_${rand}@${config.EMAIL_DOMAIN}`;
}

function generateVoucherCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "PTERO-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function telegramName(from) {
  let name = from.first_name || "";
  if (from.last_name) name += ` ${from.last_name}`;
  if (from.username) name += ` (@${from.username})`;
  return name;
}

function isOwner(userId) {
  return config.OWNER_IDS.map(String).includes(String(userId)) || db.getRole(userId) === "owner";
}

function roleLabel(role) {
  return { owner: `${tge("CROWN","👑")} Owner`, premium: `${tge("DIAMOND","💎")} Premium`, reseller: `${tge("DIAMOND_ORANGE","🔶")} Reseller` }[role] || `${tge("USER","👤")} User Biasa`;
}

function he(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function planLabel(plan) {
  const ram  = plan.ram  === 0 ? "∞" : `${plan.ram} MB`;
  const disk = plan.disk === 0 ? "∞" : `${plan.disk} MB`;
  const cpu  = plan.cpu  === 0 ? "∞" : `${plan.cpu}%`;
  return `${tge("PACKAGE","📦")} ${plan.name}  •  RAM ${ram}  •  Disk ${disk}  •  CPU ${cpu}`;
}

function planSummary(plan) {
  return {
    ram:  plan.ram  === 0 ? "Unlimited ∞" : `${plan.ram} MB`,
    disk: plan.disk === 0 ? "Unlimited ∞" : `${plan.disk} MB`,
    cpu:  plan.cpu  === 0 ? "Unlimited ∞" : `${plan.cpu}%`,
  };
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}h ${h}j ${m}m ${s}d`;
  if (h > 0) return `${h}j ${m}m ${s}d`;
  return `${m}m ${s}d`;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576)    return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}


function getDiskUsage() {
  try {
    const out = execSync("df -BM / 2>/dev/null | tail -1").toString().trim();
    const parts = out.split(/\s+/);
    const total = parseInt(parts[1]) || 0;
    const used  = parseInt(parts[2]) || 0;
    const pct   = parts[4] || "?";
    return `${used} MB / ${total} MB (${pct})`;
  } catch { return "N/A"; }
}

function getCpuModel() {
  try { return os.cpus()[0]?.model?.trim() || "N/A"; }
  catch { return "N/A"; }
}

function getBotUptime() {
  return formatUptime(Math.floor((Date.now() - BOT_START_TIME) / 1000));
}

function getVpsStats() {
  const totalRam = os.totalmem();
  const freeRam  = os.freemem();
  const usedRam  = totalRam - freeRam;
  const ramPct   = ((usedRam / totalRam) * 100).toFixed(1);
  const load     = os.loadavg();
  const cpuCount = os.cpus().length;
  return {
    vpsUptime: formatUptime(os.uptime()),
    botUptime: getBotUptime(),
    ram: `${formatBytes(usedRam)} / ${formatBytes(totalRam)} (${ramPct}%)`,
    cpu: `${getCpuModel()} (${cpuCount} core) | Load: ${load[0].toFixed(2)}, ${load[1].toFixed(2)}, ${load[2].toFixed(2)}`,
    disk: getDiskUsage(),
    platform: `${os.platform()} ${os.arch()}`,
  };
}

function formatDate(iso) {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2,"0")}/${(d.getMonth()+1).toString().padStart(2,"0")}/${d.getFullYear()}`;
}

function daysLeft(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso) - new Date()) / (1000 * 60 * 60 * 24));
}

function hoursLeft(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso) - new Date()) / (1000 * 60 * 60));
}

function getPanelLimit(role) {
  const limits = config.PANEL_LIMITS || {};
  if (typeof limits[role] !== "undefined") return limits[role];
  if (role === "reseller") return config.RESELLER_LIMIT || 5;
  if (role === "premium" || role === "owner") return 9999;
  return 0;
}

function getDailyLimit(role) {
  const limits = config.DAILY_PANEL_LIMIT || {};
  return typeof limits[role] !== "undefined" ? limits[role] : 9999;
}


function needsPin(userId, action) {
  const required = config.PIN_REQUIRED_ACTIONS || [];
  if (!required.includes(action)) return false;
  return !!db.getPin(userId);
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

// ─── Menu halaman (slide navigation) ─────────────────────────────────────────

function getMenuPages(role) {
  const maint  = db.getMaintenanceMode();
  const stats  = db.getStats();
  const trialActive = config.TRIAL_HOURS > 0 && db.getTrialEnabled();

  const pages = [];

  // ── Hal. 1: Panel ──────────────────────────────────────────────────────────
  const p1 = [];
  p1.push([Markup.button.callback("💎 Buat Panel", "create_panel")]);
  if (["premium", "owner"].includes(role))
    p1.push([Markup.button.callback("👑 Buat Admin Panel", "create_admin_panel")]);
  if (trialActive && !["premium", "owner"].includes(role))
    p1.push([Markup.button.callback("✨ Trial Panel Gratis", "trial_panel")]);
  p1.push([
    Markup.button.callback("🗂️ Panel Saya", "my_panels"),
    Markup.button.callback("🎟️ Redeem Voucher", "redeem_voucher"),
  ]);
  if (["premium", "reseller", "owner"].includes(role)) {
    p1.push([
      Markup.button.callback("🚀 Upgrade Panel", "upgrade_menu"),
      Markup.button.callback("🧬 Clone Panel", "clone_menu"),
    ]);
  }
  pages.push({ label: `${tge("DIAMOND","💎")} Panel`, btns: p1 });

  // ── Hal. 2: Akun & Support ─────────────────────────────────────────────────
  const p2 = [];
  p2.push([
    Markup.button.callback("💌 Tiket Support", "ticket_menu"),
    Markup.button.callback("🤝 Referral", "referral_menu"),
  ]);
  p2.push([
    Markup.button.callback("🛡️ Keamanan", "security_menu"),
    Markup.button.callback("👤 Status Saya", "my_status"),
  ]);
  p2.push([Markup.button.callback("🧾 Riwayat Saya", "user_transactions")]);
  p2.push([Markup.button.callback("🏆 Poin Saya", "my_points"), Markup.button.callback("📐 Panel Template", "template_menu")]);
  p2.push([Markup.button.url(`💼 Developer — ${config.DEVELOPER_NAME}`, `https://t.me/${config.DEVELOPER_USERNAME}`)]);
  pages.push({ label: `${tge("SPARKLES","✨")} Akun & Support`, btns: p2 });

  // ── Hal. 3: Admin (owner saja) ─────────────────────────────────────────────
  if (role === "owner") {
    const p3 = [];
    p3.push([
      Markup.button.callback("🗑️ Hapus Server", "delete_server"),
      Markup.button.callback("⚙️ Kelola Server", "manage_server"),
    ]);
    p3.push([
      Markup.button.callback("📑 List Server", "list_servers"),
      Markup.button.callback("🌐 Cek Node", "check_nodes"),
    ]);
    p3.push([
      Markup.button.callback("👥 Kelola User", "manage_users"),
      Markup.button.callback("📈 Statistik", "stats"),
    ]);
    p3.push([
      Markup.button.callback(`💌 Tiket (${stats.openTickets || 0})`, "kelola_tkt"),
      Markup.button.callback("🏷️ Kelola Voucher", "voucher_menu"),
    ]);
    p3.push([
      Markup.button.callback("📣 Broadcast", "broadcast_msg"),
      Markup.button.callback(maint.active ? "✅ Matikan Maint." : "🛠️ Maintenance", "maintenance_toggle"),
    ]);
    p3.push([
      Markup.button.callback("📒 Audit Log", "view_audit"),
      Markup.button.callback("📰 Lap. Harian", "daily_report_now"),
    ]);
    p3.push([
      Markup.button.callback("🧾 Riwayat Semua", "view_transactions"),
      Markup.button.callback("💹 Cek Resource", "check_resource"),
    ]);
    p3.push([
      Markup.button.callback("🌍 Status VPS", "vps_status"),
    ]);
    p3.push([
      Markup.button.callback(db.getTrialEnabled()    ? `${TOFF()} Trial OFF`    : `${TON()} Trial ON`,    "toggle_trial"),
      Markup.button.callback(db.getReferralEnabled() ? `${TOFF()} Referral OFF` : `${TON()} Referral ON`, "toggle_referral"),
    ]);
    const abStatus = db.getAutoBackup();
    p3.push([
      Markup.button.callback(abStatus.enabled ? "💿 Auto Backup 🟢" : "💿 Auto Backup 🔴", "auto_backup_menu"),
    ]);
    p3.push([
      Markup.button.callback("🔐 Whitelist Mode", "whitelist_menu"),
      Markup.button.callback("📦 Export Data", "export_data_menu"),
    ]);
    p3.push([
      Markup.button.callback("🕒 Jadwal Maintenance", "scheduled_maint_menu"),
      Markup.button.callback("🔍 Cari Panel", "search_panel"),
    ]);
    p3.push([
      Markup.button.callback("📐 Kelola Template", "manage_templates"),
    ]);
    pages.push({ label: `${tge("CROWN","👑")} Admin`, btns: p3 });
  }

  return pages;
}

function mainMenuKeyboard(role, page = 0) {
  const pages = getMenuPages(role);
  const total = pages.length;
  const cur   = Math.max(0, Math.min(page, total - 1));
  const btns  = [...pages[cur].btns];

  // Baris navigasi slide
  if (total > 1) {
    const nav = [];
    if (cur > 0)
      nav.push(Markup.button.callback("◀️", `menu_pg_${cur - 1}`));
    nav.push(Markup.button.callback(`${pages[cur].label}  •  ${cur + 1}/${total}`, "menu_pg_info"));
    if (cur < total - 1)
      nav.push(Markup.button.callback("▶️", `menu_pg_${cur + 1}`));
    btns.push(nav);
  }

  return Markup.inlineKeyboard(btns);
}

function menuHeaderText(role, page) {
  const pages = getMenuPages(role);
  const total = pages.length;
  const cur   = Math.max(0, Math.min(page, total - 1));
  return `${tge("SPARKLES","✨")} <b>Menu Utama</b> — ${pages[cur].label}\n<i>Hal. ${cur + 1} dari ${total} · Geser dengan ${tge("ARROW_LEFT","◀️")} ${tge("ARROW_RIGHT","▶️")}</i>`;
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("✖️ Batal", "cancel")]]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_main")]]);
}

function nestsKeyboard(nests) {
  const rows = [];
  for (let i = 0; i < nests.length; i += 2) {
    const row = [Markup.button.callback(`🗂️ ${nests[i].attributes.name}`, `nest_${nests[i].attributes.id}`)];
    if (nests[i + 1]) row.push(Markup.button.callback(`🗂️ ${nests[i+1].attributes.name}`, `nest_${nests[i+1].attributes.id}`));
    rows.push(row);
  }
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function eggsKeyboard(eggs, role) {
  const whitelist = (config.EGG_WHITELIST || {})[role] || null;
  const filtered = whitelist ? eggs.filter(e => whitelist.includes(e.attributes.id)) : eggs;
  const rows = [];
  for (let i = 0; i < filtered.length; i += 2) {
    const row = [Markup.button.callback(`🥚 ${filtered[i].attributes.name}`, `egg_${filtered[i].attributes.id}`)];
    if (filtered[i + 1]) row.push(Markup.button.callback(`🥚 ${filtered[i+1].attributes.name}`, `egg_${filtered[i+1].attributes.id}`));
    rows.push(row);
  }
  if (!rows.length) rows.push([Markup.button.callback("❌ Tidak ada egg tersedia", "cancel")]);
  rows.push([Markup.button.callback("◀️ Kembali ke Nest", "back_to_nest")]);
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function plansKeyboard() {
  const rows = [];
  config.RESOURCE_PLANS.forEach((plan, i) => {
    rows.push([Markup.button.callback(planLabel(plan), `plan_${i}`)]);
  });
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function autoBackupKeyboard(ab) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(ab.enabled ? `${TOFF()} Nonaktifkan Auto Backup` : `${TON()} Aktifkan Auto Backup`, "toggle_auto_backup")],
    [Markup.button.callback(`🕒 Set Interval (${ab.interval_hours} jam)`, "set_backup_interval")],
    [Markup.button.callback("⚡ Jalankan Backup Sekarang", "run_backup_now")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function manageUsersKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔶 Set Reseller", "set_reseller"), Markup.button.callback("💎 Set Premium", "set_premium")],
    [Markup.button.callback("👑 Set Owner", "set_owner"), Markup.button.callback("🔄 Reset Role", "reset_role")],
    [Markup.button.callback("⛔ Blacklist", "blacklist_user"), Markup.button.callback("✅ Unblacklist", "unblacklist_user")],
    [Markup.button.callback("🔍 Cari User", "search_user"), Markup.button.callback("📑 Daftar User", "list_users")],
    [Markup.button.callback("📦 Set Limit Reseller", "set_reseller_limit")],
    [Markup.button.callback("📈 Statistik User", "user_stats_lookup"), Markup.button.callback("⚡ Bulk Aksi Panel", "bulk_action_pick")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function bulkActionKeyboard(targetId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚫 Suspend Semua Panel", `bulk_sus_${targetId}`)],
    [Markup.button.callback("🔓 Unsuspend Semua Panel", `bulk_uns_${targetId}`)],
    [Markup.button.callback("🗑️ Hapus Semua Panel", `bulk_del_${targetId}`)],
    [Markup.button.callback("✖️ Batal", "cancel")],
  ]);
}

function manageServerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚫 Suspend Server", "suspend_server")],
    [Markup.button.callback("🔓 Unsuspend Server", "unsuspend_server")],
    [Markup.button.callback("♻️ Reinstall Server", "reinstall_server")],
    [Markup.button.callback("📅 Perpanjang Panel", "extend_panel_input")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function voucherMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎟️ Voucher Role", "create_voucher"), Markup.button.callback("🏷️ Voucher Diskon %", "create_discount_voucher")],
    [Markup.button.callback("📅 Voucher Hari +", "create_day_voucher"), Markup.button.callback("📑 List Voucher", "list_vouchers")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function voucherRoleKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔶 Reseller", "vr_reseller"), Markup.button.callback("💎 Premium", "vr_premium")],
    [Markup.button.callback("👑 Owner", "vr_owner")],
    [Markup.button.callback("✖️ Batal", "cancel")],
  ]);
}

function myPanelsKeyboard(panels) {
  const rows = panels.map((p) => {
    const shortName = (p.name || "N/A").slice(0, 22);
    const isExpired = p.expired || (daysLeft(p.expire_date) !== null && daysLeft(p.expire_date) <= 0);
    const icon = isExpired ? `${tge("RED_DOT","🔴")}` : p.suspended ? `${tge("LOCK","🔒")}` : `${tge("GREEN_DOT","🟢")}`;
    return [Markup.button.callback(`${icon} ${shortName}`, `mng_panel_${p.server_id}`)];
  });
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

function panelManageKeyboard(panel, ownerView = false) {
  const sid = panel.server_id;
  const identifier = panel.server_identifier;
  const rows = [];
  rows.push([
    Markup.button.callback("▶️ Start", `pwr_start_${sid}`),
    Markup.button.callback("⏹️ Stop", `pwr_stop_${sid}`),
    Markup.button.callback("♻️ Restart", `pwr_rst_${sid}`),
  ]);
  rows.push([
    Markup.button.callback("🔑 Reset PW", `rst_pw_${sid}`),
    Markup.button.callback("📝 Rename", `ren_srv_${sid}`),
  ]);
  rows.push([
    Markup.button.callback("📈 Status Server", `srv_res_${sid}`),
    Markup.button.callback("🪪 Detail Panel", `dtl_srv_${sid}`),
  ]);
  if (identifier) {
    rows.push([
      Markup.button.callback("💿 Backup Server", `bkp_srv_${sid}`),
      Markup.button.callback("📑 List Backup", `lst_bkp_${sid}`),
    ]);
    rows.push([Markup.button.callback("🕒 Jadwal (Cron)", `schedules_${sid}`)]);
  }
  rows.push([
    Markup.button.callback("🚀 Upgrade Resource", `upg_sel_${sid}`),
    Markup.button.callback("🧬 Clone Panel", `cln_sel_${sid}`),
  ]);
  if (ownerView) {
    rows.push([
      Markup.button.callback("📅 Perpanjang (Admin)", `ext_pan_${sid}`),
      Markup.button.callback("↪️ Transfer Panel", `trn_pan_${sid}`),
    ]);
  }
  rows.push([Markup.button.callback("◀️ Kembali", "my_panels")]);
  return Markup.inlineKeyboard(rows);
}

function extendSelfPickKeyboard(panels) {
  const rows = panels.map(p => {
    const shortName = (p.name || "N/A").slice(0, 24);
    const dl = daysLeft(p.expire_date);
    const expStr = dl !== null ? ` (sisa ${dl}h)` : "";
    return [Markup.button.callback(`🗓️ ${shortName}${expStr}`, `extend_self_${p.server_id}`)];
  });
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

// ─── Keyboard: All Servers (Owner) ────────────────────────────────────────────

const SRV_PER_PAGE = 5;

function srvStatusIcon(a) {
  if (a.suspended || a.status === "suspended") return `${tge("LOCK","🔒")}`;
  if (a.status === "installing")               return `${tge("GEAR","⚙️")}`;
  if (a.status === "install_failed")           return `${tge("ERROR","❌")}`;
  return `${tge("GREEN_DOT","🟢")}`;
}

function allServersKeyboard(servers, filter = "all", page = 0) {
  let filtered;
  if (filter === "act")  filtered = servers.filter(sv => !sv.attributes.suspended && !sv.attributes.status);
  else if (filter === "sus") filtered = servers.filter(sv => sv.attributes.suspended || sv.attributes.status === "suspended");
  else filtered = servers;

  const total      = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / SRV_PER_PAGE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const slice = filtered.slice(page * SRV_PER_PAGE, (page + 1) * SRV_PER_PAGE);

  const rows = [];

  // Filter tab row
  rows.push([
    Markup.button.callback(filter === "all" ? "▶ Semua"    : "Semua",    "srv_f_all_0"),
    Markup.button.callback(filter === "act" ? "▶ Aktif"    : "Aktif",    "srv_f_act_0"),
    Markup.button.callback(filter === "sus" ? "▶ Suspended": "Suspended","srv_f_sus_0"),
  ]);

  // Server list
  for (const sv of slice) {
    const a    = sv.attributes;
    const icon = srvStatusIcon(a);
    const name = (a.name || "?").slice(0, 28);
    rows.push([Markup.button.callback(`${icon} ${name} [${a.id}]`, `srv_m_${a.id}`)]);
  }

  // Pagination
  const navRow = [];
  if (page > 0)              navRow.push(Markup.button.callback("◀ Prev", `srv_f_${filter}_${page - 1}`));
  navRow.push(Markup.button.callback(`${page + 1}/${totalPages} | ${total} server`, "srv_noop"));
  if (page < totalPages - 1) navRow.push(Markup.button.callback("Next ▶", `srv_f_${filter}_${page + 1}`));
  rows.push(navRow);

  rows.push([
    Markup.button.callback("♻️ Refresh", `srv_f_${filter}_${page}`),
    Markup.button.callback("◀️ Kembali", "back_main"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function serverMgrKeyboard(a, filter = "all", page = 0) {
  const susp = a.suspended;
  return Markup.inlineKeyboard([
    susp
      ? [Markup.button.callback("🔓 Unsuspend", `srv_do_uns_${a.id}`)]
      : [Markup.button.callback("🚫 Suspend",   `srv_do_sus_${a.id}`)],
    [
      Markup.button.callback("♻️ Reinstall", `srv_do_rei_${a.id}`),
      Markup.button.callback("🗑️ Hapus",     `srv_do_del_${a.id}`),
    ],
    [Markup.button.callback(`◀️ Kembali ke List`, `srv_f_${filter}_${page}`)],
  ]);
}

function securityMenuKeyboard(hasPin) {
  return Markup.inlineKeyboard([
    hasPin
      ? [Markup.button.callback("♻️ Ubah PIN", "change_pin"), Markup.button.callback("🗑️ Hapus PIN", "clear_pin")]
      : [Markup.button.callback("🛡️ Set PIN (2FA)", "set_pin")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function referralMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Klaim Bonus Referral", "claim_referral")],
    [Markup.button.callback("🏆 Leaderboard Referral", "referral_leaderboard")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}


function nodeSelectKeyboard(nodes) {
  const rows = nodes.map((n, i) => [
    Markup.button.callback(`🖥️ ${n.attributes.name}`, `node_${n.attributes.location_id || n.attributes.id}`),
  ]);
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function vpsStatusKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("♻️ Refresh", "vps_refresh")],
    [Markup.button.callback("👑 Owner Menu", "back_main")],
  ]);
}

function referralMenuKeyboardFull() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Klaim Bonus Referral", "claim_referral")],
    [Markup.button.callback("🏆 Leaderboard Referral", "referral_leaderboard")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function templatesKeyboard(templates) {
  const rows = templates.map(t => [
    Markup.button.callback(`📋 ${t.name}`, `use_tpl_${t.name.slice(0,20)}`),
  ]);
  rows.push([Markup.button.callback("✨ Buat Dari Awal", "create_panel_fresh")]);
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function manageTemplatesKeyboard(templates) {
  const rows = templates.map(t => [
    Markup.button.callback(`🗑️ Hapus: ${t.name}`, `del_tpl_${t.name.slice(0,20)}`),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

function whitelistMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Tambah ke Whitelist", "wl_add"), Markup.button.callback("➖ Hapus dari Whitelist", "wl_remove")],
    [Markup.button.callback("📑 Daftar Whitelist", "wl_list")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function pointsMenuKeyboard(pts, rate) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💱 Tukar ${rate} Poin → 1 Hari Panel`, "points_exchange")],
    [Markup.button.callback("🏆 Leaderboard Poin", "points_leaderboard")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function scheduledMaintKeyboard(sm) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(sm.enabled ? `${TOFF()} Nonaktifkan Jadwal` : `${TON()} Aktifkan Jadwal`, "schm_toggle")],
    [Markup.button.callback(`🕒 Set Waktu (${sm.start}–${sm.end})`, "schm_set_time")],
    [Markup.button.callback(`📝 Set Pesan`, "schm_set_msg")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function exportDataKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👥 Export User (CSV)", "export_users")],
    [Markup.button.callback("💎 Export Panel (CSV)", "export_panels")],
    [Markup.button.callback("🧾 Export Transaksi (CSV)", "export_transactions")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

// ── Helper: progress bar ASCII ─────────────────────────────────────
function buildProgressBar(pct, width = 10) {
  const filled = Math.min(width, Math.round((pct / 100) * width));
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

// ── Helper: format detik ke "Xh Yj Zm" ────────────────────────────
function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}h`);
  parts.push(`${h}j`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

// ── Helper: sample CPU usage 1 detik ──────────────────────────────
function getCpuUsagePct() {
  return new Promise(resolve => {
    const s1 = os.cpus();
    setTimeout(() => {
      const s2 = os.cpus();
      let idle = 0, total = 0;
      for (let i = 0; i < s1.length; i++) {
        const t1 = s1[i].times, t2 = s2[i].times;
        const di = t2.idle - t1.idle;
        const dt = Object.values(t2).reduce((a, b) => a + b, 0) -
                   Object.values(t1).reduce((a, b) => a + b, 0);
        idle  += di;
        total += dt;
      }
      resolve(total > 0 ? ((1 - idle / total) * 100) : 0);
    }, 800);
  });
}

// ── Helper: format bytes ke GB ─────────────────────────────────────
function bytesToGB(b) { return (b / 1073741824).toFixed(2); }

// ── Builder: teks STATUS VPS lengkap ──────────────────────────────
async function buildVpsText() {
  const hostname = os.hostname();
  const platform = os.platform();
  const arch     = os.arch();
  const kernel   = os.release();

  let ip = "N/A";
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) { ip = iface.address; break; }
    }
    if (ip !== "N/A") break;
  }

  const totalRam = os.totalmem();
  const freeRam  = os.freemem();
  const usedRam  = totalRam - freeRam;
  const ramPct   = (usedRam / totalRam * 100).toFixed(1);

  let diskTotal = 0, diskUsed = 0, diskFree = 0, diskPct = "0.0";
  try {
    const dfLines = execSync("df -k / --output=size,used,avail 2>/dev/null", { encoding: "utf8" }).trim().split("\n");
    const [sz, us, av] = dfLines[1].trim().split(/\s+/).map(Number);
    diskTotal = sz * 1024;
    diskUsed  = us * 1024;
    diskFree  = av * 1024;
    diskPct   = (diskUsed / diskTotal * 100).toFixed(1);
  } catch {}

  const cpus     = os.cpus();
  const cpuModel = (cpus[0]?.model || "Unknown").trim().replace(/\s+/g, " ");
  const cpuCores = cpus.length;
  const cpuSpeed = cpus[0]?.speed || 0;
  const cpuUsage = await getCpuUsagePct();
  const cpuPct   = cpuUsage.toFixed(1);

  const [l1, l5, l15] = os.loadavg();

  const sysUptime = formatUptime(os.uptime());
  const botUptime = formatUptime(process.uptime());

  const mem    = process.memoryUsage();
  const rss    = (mem.rss / 1048576).toFixed(1);
  const heap   = (mem.heapUsed / 1048576).toFixed(1);
  const nodeVer = process.version;

  const ts = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const ramBar  = buildProgressBar(parseFloat(ramPct));
  const diskBar = buildProgressBar(parseFloat(diskPct));
  const cpuBar  = buildProgressBar(parseFloat(cpuPct));

  return (
    `${tge("DESKTOP","🖥️")} <b>STATUS VPS</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${tge("BLUE_DOT","🔵")} <b>SYSTEM INFO</b>\n` +
    `├ Hostname: \`${hostname}\`\n` +
    `├ Platform: ${platform}\n` +
    `├ Arch: ${arch}\n` +
    `├ Kernel: ${kernel}\n` +
    `└ IP: ${ip}\n\n` +
    `${tge("FLOPPY","💾")} <b>MEMORY (RAM)</b>\n` +
    `├ Total: ${bytesToGB(totalRam)} GB\n` +
    `├ Used: ${bytesToGB(usedRam)} GB (${ramPct}%)\n` +
    `├ Free: ${bytesToGB(freeRam)} GB\n` +
    `└ \`${ramBar}\` ${ramPct}%\n\n` +
    `${tge("DISK","💿")} <b>DISK USAGE</b>\n` +
    `├ Total: ${bytesToGB(diskTotal)} GB\n` +
    `├ Used: ${bytesToGB(diskUsed)} GB (${diskPct}%)\n` +
    `├ Free: ${bytesToGB(diskFree)} GB\n` +
    `└ \`${diskBar}\` ${diskPct}%\n\n` +
    `${tge("LIGHTNING","⚡")} <b>CPU</b>\n` +
    `├ Model: ${cpuModel.slice(0, 35)}\n` +
    `├ Core: ${cpuCores}\n` +
    `├ Speed: ${cpuSpeed} MHz\n` +
    `├ Usage: ${cpuPct}%\n` +
    `└ \`${cpuBar}\` ${cpuPct}%\n\n` +
    `${tge("CHART_UP","📈")} <b>LOAD AVERAGE</b>\n` +
    `├ 1 min: ${l1.toFixed(2)}\n` +
    `├ 5 min: ${l5.toFixed(2)}\n` +
    `└ 15 min: ${l15.toFixed(2)}\n\n` +
    `${tge("CLOCK","⏱️")} <b>UPTIME</b>\n` +
    `├ System: ${sysUptime}\n` +
    `└ Bot: ${botUptime}\n\n` +
    `${tge("BOT","🤖")} <b>BOT PROCESS</b>\n` +
    `├ RSS: ${rss} MB\n` +
    `├ Heap: ${heap} MB\n` +
    `└ Node: ${nodeVer}\n\n` +
    `${tge("CLOCK_FACE","🕐")} ${ts} WIB`
  );
}

function upgradeSelectKeyboard(panels) {
  const active = panels.filter(p => !p.expired && !p.suspended);
  if (!active.length) return Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_main")]]);
  const rows = active.map(p => [
    Markup.button.callback(`🖥️ ${(p.name || "N/A").slice(0, 25)} [${p.plan_name || "?"}]`, `upg_sel_${p.server_id}`),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

function upgradePlanKeyboard() {
  const rows = config.RESOURCE_PLANS.map((plan, i) => {
    const ps = planSummary(plan);
    return [Markup.button.callback(`📦 ${plan.name}  RAM:${ps.ram} CPU:${ps.cpu}`, `upg_plan_${i}`)];
  });
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function cloneSelectKeyboard(panels) {
  const active = panels.filter(p => !p.expired && !p.suspended);
  if (!active.length) return Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_main")]]);
  const rows = active.map(p => [
    Markup.button.callback(`📋 ${(p.name || "N/A").slice(0, 28)}`, `cln_sel_${p.server_id}`),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

function ticketListKeyboard(tickets, isOwnerView) {
  const rows = tickets.slice(0, 10).map(t => [
    Markup.button.callback(
      `${t.status === "open" ? "🟢" : "🔒"} [${t.id.slice(-4)}] ${(t.subject || "").slice(0, 28)}`,
      isOwnerView ? `otkt_${t.id.slice(-8)}` : `tkt_view_${t.id.slice(-8)}`
    ),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = new Map();
function getState(userId) {
  if (!state.has(userId)) state.set(userId, {});
  return state.get(userId);
}
function clearState(userId) { state.delete(userId); }

async function safeEdit(ctx, text, opts = {}) {
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  const chatId = msg && msg.chat && msg.chat.id;
  const msgId  = msg && msg.message_id;
  try {
    return await ctx.telegram.editMessageText(chatId, msgId, undefined, text, opts);
  } catch (e) {
    const desc = e.description || "";
    if (desc.includes("no text in the message") || desc.includes("there is no text")) {
      try {
        return await ctx.telegram.editMessageCaption(chatId, msgId, undefined, text, opts);
      } catch (_) { return ctx.reply(text, opts); }
    }
    return ctx.reply(text, opts);
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const uname  = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "?";
  logger.sys("START", `User:${userId}(${uname}) /start`);
  if (isOwner(userId) && db.getRole(userId) !== "owner") db.setUserRole(userId, "owner");

  // Cek apakah user baru (belum pernah /start)
  const isNewUser = !db.hasStarted(userId);
  db.registerStartedUser(userId, ctx.from);
  clearState(userId);
  const role = db.getRole(userId);

  // Notif grup saat user baru pertama kali /start
  if (isNewUser && config.NEW_USER_NOTIFY_GROUP && config.GROUP_ID) {
    try {
      const nama = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
      await bot.telegram.sendMessage(config.GROUP_ID,
        `${tge("WAVE","👋")} <b>User Baru Bergabung!</b>\n\n${tge("USER","👤")} Nama: *${nama}*\n${tge("NAME_BADGE","📛")} Username: @${ctx.from.username || "NoUsername"}\n${tge("ID_CARD","🆔")} ID: \`${userId}\`\n${tge("MASK","🎭")} Role: ${roleLabel(role)}\n\n_Selamat datang di ${config.BOT_NAME}!_`,
        { parse_mode: "HTML" }
      );
    } catch {}
  }

  // Poin harian login (1x per hari)
  const todayKey = db.getTodayKey();
  const pointLoginKey = `login_${userId}:${todayKey}`;
  const dailyDb = db.loadDb();
  if (!dailyDb.daily_counts) dailyDb.daily_counts = {};
  if (!dailyDb.daily_counts[pointLoginKey]) {
    dailyDb.daily_counts[pointLoginKey] = 1;
    db.saveDb(dailyDb);
    const loginPts = (config.POINT_REWARDS || {}).daily_login || 1;
    if (loginPts > 0) db.addPoints(userId, loginPts);
  }

  // Proses referral dari parameter /start
  const startParam = ctx.startPayload;
  if (startParam && startParam.startsWith("ref_") && db.getReferralEnabled()) {
    const refCode = startParam.slice(4);
    const referrerId = db.getUserByReferralCode(refCode);
    if (referrerId && String(referrerId) !== String(userId)) {
      const applied = db.applyReferral(userId, referrerId);
      if (applied) {
        try {
          await bot.telegram.sendMessage(referrerId,
            `${tge("PARTY","🎉")} <b>Referral Berhasil!</b>\n\nUser baru bergabung menggunakan kode referral kamu!\nKlaim bonus di menu ${tge("USERS","👥")} Referral setelah mereka buat panel pertama.`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }
    }
  }

  const totalUsers = db.getAllStartedUsers().length;
  const v = getVpsStats();
  const userName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  // ── Jam WIB (UTC+7) ──
  const nowWIB = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day:     "2-digit",
    month:   "long",
    year:    "numeric",
    hour:    "2-digit",
    minute:  "2-digit",
    second:  "2-digit",
    hour12:  false,
  });

  // ── Info reseller limit ──
  let resellerLimitHtml = "";
  if (role === "reseller") {
    const lim = db.getResellerLimit(userId);
    if (lim) {
      const exp = lim.expire_date ? new Date(lim.expire_date) : null;
      const expired = exp && exp < new Date();
      resellerLimitHtml = `\n${tge("PACKAGE","📦")} Limit Panel: <b>${lim.count} slot</b> ${expired ? `${tge("RED_DOT","🔴")} Kadaluarsa` : exp ? `(exp: ${he(formatDate(lim.expire_date))})` : "(Selamanya)"}`;
    } else {
      resellerLimitHtml = `\n${tge("PACKAGE","📦")} Limit Panel: <b>Belum diset</b> (hubungi owner)`;
    }
  }

  // Pilih pesan selamat datang sesuai role
  const roleWelcome = (config.WELCOME_BY_ROLE || {})[role] || "";
  const greetText   = roleWelcome || config.WELCOME_GREETING || "Selamat datang di bot panel!";

  const welcomeText =
    `${tge("BOT","🤖")} <b>${he(config.BOT_NAME)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${tge("WAVE","👋")} <b>Halo, ${he(ctx.from.first_name)}!</b>\n` +
    `<i>${he(greetText)}</i>\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("PIN","📌")} <b>Info Akun Kamu:</b>\n` +
    `<blockquote>` +
      `${tge("USER","👤")} Username: <code>${he(userName)}</code>\n` +
      `${tge("ID_CARD","🆔")} User ID: <code>${ctx.from.id}</code>\n` +
      `${tge("MASK","🎭")} Role: ${he(roleLabel(role))}` +
      resellerLimitHtml +
    `</blockquote>\n\n` +
    `${tge("CHART","📊")} <b>Statistik Bot:</b>\n` +
    `<blockquote>` +
      `${tge("USERS","👥")} Total User: <code>${totalUsers}</code>\n` +
      `${tge("CLOCK","⏱️")} Runtime Bot: <code>${he(v.botUptime)}</code>\n` +
      `${tge("LAPTOP","💻")} Type Modul: <code>JavaScript</code>` +
    `</blockquote>\n\n` +
    `${tge("DESKTOP","🖥️")} <b>Info VPS:</b>\n` +
    `<blockquote>` +
      `${tge("HOURGLASS","⏳")} Uptime VPS: <code>${he(v.vpsUptime)}</code>\n` +
      `${tge("GEAR","⚙️")} CPU: <code>${he(v.cpu)}</code>\n` +
      `${tge("DISK","💿")} Disk: <code>${he(v.disk)}</code>` +
    `</blockquote>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("CLOCK","🕐")} <b>${he(nowWIB)} WIB</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("SPARKLES","✨")} <b>Pilih menu di bawah:</b>`;

  const opts = { parse_mode: "HTML", ...mainMenuKeyboard(role) };

  if (config.BANNER_FILE_ID && config.BANNER_TYPE !== "none") {
    try {
      if (config.BANNER_TYPE === "photo")
        return await ctx.replyWithPhoto(config.BANNER_FILE_ID, { caption: welcomeText, parse_mode: "HTML", ...mainMenuKeyboard(role) });
      if (config.BANNER_TYPE === "video")
        return await ctx.replyWithVideo(config.BANNER_FILE_ID, { caption: welcomeText, parse_mode: "HTML", ...mainMenuKeyboard(role) });
      if (config.BANNER_TYPE === "animation")
        return await ctx.replyWithAnimation(config.BANNER_FILE_ID, { caption: welcomeText, parse_mode: "HTML", ...mainMenuKeyboard(role) });
    } catch (err) { botLog("WARN", "BANNER", "Gagal kirim banner", err); }
  }
  ctx.reply(welcomeText, opts);
});

// ─── /getfileid ───────────────────────────────────────────────────────────────

bot.command("getfileid", (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  const s = getState(ctx.from.id);
  s.step = "waiting_banner_media";
  ctx.reply(`${tge("PAPERCLIP","📎")} Kirim <b>foto</b> atau <b>video</b> ke bot ini untuk dapatkan File ID.`, { parse_mode: "HTML", ...cancelKeyboard() });
});

bot.on(message("photo"), async (ctx) => {
  const userId = ctx.from.id;
  const role = db.getRole(userId);
  const s = getState(userId);
  const photo = ctx.message.photo;
  const fileId = photo[photo.length - 1].file_id;

  // ── Banner Media ──────────────────────────────────────────────────
  if (!isOwner(userId)) return;
  if (s.step !== "waiting_banner_media") return;
  clearState(userId);
  ctx.reply(`${tge("SUCCESS","✅")} File ID Foto:\n<code>BANNER_TYPE: "photo"</code>\n\`BANNER_FILE_ID: "${fileId}"\``, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
});

bot.on(message("video"), (ctx) => {
  const userId = ctx.from.id;
  if (!isOwner(userId)) return;
  const s = getState(userId);
  if (s.step !== "waiting_banner_media") return;
  clearState(userId);
  const fileId = ctx.message.video.file_id;
  ctx.reply(`${tge("SUCCESS","✅")} File ID Video:\n<code>BANNER_TYPE: "video"</code>\n\`BANNER_FILE_ID: "${fileId}"\``, { parse_mode: "HTML", ...mainMenuKeyboard(db.getRole(userId)) });
});

bot.on(message("animation"), (ctx) => {
  const userId = ctx.from.id;
  if (!isOwner(userId)) return;
  const s = getState(userId);
  if (s.step !== "waiting_banner_media") return;
  clearState(userId);
  const fileId = ctx.message.animation.file_id;
  ctx.reply(`${tge("SUCCESS","✅")} File ID GIF:\n<code>BANNER_TYPE: "animation"</code>\n\`BANNER_FILE_ID: "${fileId}"\``, { parse_mode: "HTML", ...mainMenuKeyboard(db.getRole(userId)) });
});

// ─── /credit ──────────────────────────────────────────────────────────────────

bot.command("credit", (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /credit`);
  ctx.reply(
    `${tge("MAN","👨")}‍${tge("LAPTOP","💻")} <b>Credit & Info Script</b>\n\n${tge("BOT","🤖")} Nama Bot: *${config.BOT_NAME}*\n${tge("USER","👤")} Developer: *${config.DEVELOPER_NAME}*\n${tge("PHONE","📱")} Kontak: @${config.DEVELOPER_USERNAME}\n\n${config.CREDIT_TEXT}`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url(`💼 Hubungi Developer`, `https://t.me/${config.DEVELOPER_USERNAME}`)],
        [Markup.button.callback("◀️ Kembali", "back_main")],
      ]),
    }
  );
});

// ─── /info ────────────────────────────────────────────────────────────────────

bot.command("info", (ctx) => {
  const userId     = ctx.from.id;
  logger.sys("CMD", `User:${userId} /info`);
  const role       = db.getRole(userId);
  const count      = db.getPanelCount(userId);
  const sudahStart = db.hasStarted(userId);
  const blacklisted= db.isBlacklisted(userId);
  const dailyCount = db.getDailyCount(userId);
  const dailyLimit = getDailyLimit(role);

  const nama     = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  const username = ctx.from.username ? `@${ctx.from.username}` : "Tidak ada";

  // Hirarki role: owner > premium > reseller > user
  const roleRank = { owner: 4, premium: 3, reseller: 2, user: 1 };
  const myRank   = roleRank[role] || 1;
  const ck = (r) => myRank >= roleRank[r] ? `${tge("SUCCESS","✅")}` : `${tge("ERROR","❌")}`;

  let text =
    `${tge("LIST","📋")} <b>INFO AKUN</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${tge("ID_CARD","🆔")} ID: "${userId}"\n` +
    `${tge("USER","👤")} Username: "${username}"\n` +
    `${tge("MEMO","📝")} Nama: "${nama}"\n`;

  if (blacklisted) text += `${tge("PROHIBITED","🚫")} Status: <b>"DIBLACKLIST"</b>\n`;

  text +=
    `\n` +
    `- Public Owner? ${ck("owner")}\n` +
    `- Public Premium? ${ck("premium")}\n` +
    `- Public Reseller? ${ck("reseller")}\n` +
    `- Public User? ${ck("user")}\n`;

  // Info tambahan panel
  text += `\n${tge("DESKTOP","🖥️")} Panel Dibuat: "${count}"`;
  if (dailyLimit < 9999) {
    text += `\n${tge("CALENDAR","📅")} Buat Hari Ini: "${dailyCount}/${dailyLimit}"`;
  }
  if (role === "reseller") {
    const limObj = db.getResellerLimit(userId);
    if (limObj) {
      const exp       = limObj.expire_date ? new Date(limObj.expire_date) : null;
      const isExpired = exp && exp < new Date();
      const expStr    = isExpired ? `Kadaluarsa ${tge("RED_DOT","🔴")}` : exp ? `Exp: ${formatDate(limObj.expire_date)}` : "Selamanya";
      text += `\n${tge("PACKAGE","📦")} Limit Panel: "${limObj.count} slot (${expStr})"`;
    } else {
      text += `\n${tge("PACKAGE","📦")} Limit Panel: "Belum diset — hubungi owner"`;
    }
  }

  const botStatus = sudahStart
    ? `\n\n${tge("SUCCESS","✅")} "${nama}" sudah start bot! silahkan create.`
    : `\n\n${tge("ERROR","❌")} "${nama}" belum start bot!`;
  text += botStatus;

  ctx.reply(text, { parse_mode: "HTML" });
});

// ─── /mypanels ────────────────────────────────────────────────────────────────

bot.command("mypanels", (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /mypanels`);
  const panels = db.getUserPanels(userId);
  if (!panels.length) return ctx.reply(`${tge("EMPTY_BOX","📭")} Kamu belum memiliki panel.`, backKeyboard());
  let text = `${tge("LIST","📋")} *Daftar Panel Kamu (${panels.length}):*\n\n`;
  panels.forEach((p, i) => {
    const tipe    = p.panel_type === "admin" ? `${tge("CROWN","👑")} Admin` : `${tge("DESKTOP","🖥️")} Biasa`;
    const _psn    = Number(p.server_num) === 2 ? 2 : 1;
    const srvTag  = `[${serverLabel(_psn)}]`;
    const dl      = daysLeft(p.expire_date);
    const expStr  = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl <= 3 ? `${tge("YELLOW_DOT","🟡")} Sisa ${dl} hari` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : "";
    const status  = p.expired ? `${tge("SKULL","💀")} Expired` : p.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
    text +=
      `*${i+1}. ${p.name || "N/A"}* ${srvTag}\n` +
      `   ${tge("ID_CARD","🆔")} Server ID: \`${p.server_id || "N/A"}\`\n` +
      `   ${tge("MASK","🎭")} Tipe: ${tipe}\n` +
      `   ${tge("EGG","🥚")} Egg: ${p.egg || "N/A"}\n` +
      `   ${tge("PACKAGE","📦")} Paket: ${p.plan_name || "N/A"}\n` +
      `   ${tge("CALENDAR","📅")} Dibuat: ${formatDate(p.created_at)}\n` +
      `   ${tge("ALARM","⏰")} Expired: ${formatDate(p.expire_date)} ${expStr}\n` +
      `   ${tge("BRIGHT","🔆")} Status: ${status}\n\n`;
  });
  ctx.reply(text, { parse_mode: "HTML", ...myPanelsKeyboard(panels) });
});

// ─── /ping ────────────────────────────────────────────────────────────────────

bot.command("ping", (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /ping`);
  const v = getVpsStats();
  ctx.reply(
    `${tge("PINGPONG","🏓")} <b>Pong!</b>\n\n━━━━ ${tge("BOT","🤖")} Bot ━━━━\n${tge("CLOCK","⏱️")} Bot Runtime: \`${v.botUptime}\`\n\n━━━━ ${tge("DESKTOP","🖥️")} VPS ━━━━\n${tge("CLOCK","⏱️")} VPS Uptime: \`${v.vpsUptime}\`\n${tge("FLOPPY","💾")} RAM: \`${v.ram}\`\n${tge("GEAR","⚙️")} CPU: \`${v.cpu}\`\n${tge("DISK","💿")} Disk: \`${v.disk}\`\n${tge("DESKTOP","🖥️")} OS: \`${v.platform}\``,
    { parse_mode: "HTML", ...backKeyboard() }
  );
});


// ─── /stats ───────────────────────────────────────────────────────────────────

bot.command("stats", (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /stats`);
  if (!isOwner(ctx.from.id)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
  sendStats(ctx);
});

// ─── /nodes ───────────────────────────────────────────────────────────────────

bot.command("nodes", async (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /nodes`);
  if (!isOwner(ctx.from.id)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
  await sendNodes(ctx);
});

// ─── /redeem ──────────────────────────────────────────────────────────────────

bot.command("redeem", (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(" ").slice(1);
  logger.sys("CMD", `User:${userId} /redeem${args[0] ? " " + args[0] : ""}`);
  if (args.length > 0) return redeemCode(ctx, userId, args[0].toUpperCase());
  const s = getState(userId);
  s.step = "redeem_code";
  ctx.reply(`${tge("ADMISSION","🎟️")} Masukkan <b>kode voucher</b> kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
});

// ─── /referral ────────────────────────────────────────────────────────────────

bot.command("referral", (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /referral`);
  if (!db.getReferralEnabled()) return ctx.reply(`${tge("ERROR","❌")} Fitur referral sedang <b>tidak aktif</b>.`, { parse_mode: "HTML" });
  showReferralMenu(ctx, ctx.from.id);
});

// ─── Callback Query Handler ───────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  const data   = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const uname  = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "?";
  // Log semua tombol kecuali navigasi menu biasa
  const isNav = data === "menu_pg_info" || data.startsWith("menu_pg_");
  if (!isNav) logger.action("BTN", `User:${userId}(${uname}) → "${data}"`);
  try {
    const role = db.getRole(userId);
    await ctx.answerCbQuery();

  // ── Back / Cancel ──────────────────────────────────────────────────
  if (data === "back_main" || data === "cancel" || data === "main_menu") {
    clearState(userId);
    return safeEdit(ctx, menuHeaderText(role, 0), { parse_mode: "HTML", ...mainMenuKeyboard(role, 0) });
  }

  if (data.startsWith("menu_pg_")) {
    const pg = parseInt(data.replace("menu_pg_", "")) || 0;
    return safeEdit(ctx, menuHeaderText(role, pg), { parse_mode: "HTML", ...mainMenuKeyboard(role, pg) });
  }

  if (data === "menu_pg_info") {
    return ctx.answerCbQuery(`Gunakan ${tge("ARROW_LEFT","◀️")} ${tge("ARROW_RIGHT","▶️")} untuk pindah halaman`, { show_alert: false });
  }

  // ── Back to Nest ───────────────────────────────────────────────────
  if (data === "back_to_nest") {
    const s = getState(userId);
    s.step = "nest";
    const nests = await ptero.getNests(s.server_num || 1);
    if (!nests.length) return safeEdit(ctx, `${tge("ERROR","❌")} Tidak ada Nest tersedia.`, backKeyboard());
    s.nests = nests;
    return safeEdit(ctx, `${tge("CARD_INDEX","🗂️")} <b>Pilih Nest</b>\n\nPilih kategori server:`, { parse_mode: "HTML", ...nestsKeyboard(nests) });
  }

  // ── My Status ─────────────────────────────────────────────────────
  if (data === "my_status") {
    const count = db.getPanelCount(userId);
    const panels = db.getUserPanels(userId);
    const referral = db.getReferralStats(userId);
    const hasPin = !!db.getPin(userId);
    const trialUsed = db.hasUsedTrial(userId);

    let text = `${tge("LIST","📋")} <b>Status Akun</b>\n\n${tge("ID_CARD","🆔")} ID: \`${userId}\`\n${tge("MASK","🎭")} Role: ${roleLabel(role)}\n${tge("DESKTOP","🖥️")} Panel Dibuat: *${count}*`;
    if (role === "reseller") {
      const limObj = db.getResellerLimit(userId);
      if (limObj) {
        const exp = limObj.expire_date ? new Date(limObj.expire_date) : null;
        const isExpired = exp && exp < new Date();
        text += `\n${tge("PACKAGE","📦")} Limit: *${limObj.count} slot* ${isExpired ? `${tge("RED_DOT","🔴")} Kadaluarsa` : exp ? `(exp: ${formatDate(limObj.expire_date)})` : "(Selamanya)"}`;
      } else {
        text += `\n${tge("PACKAGE","📦")} Limit: <b>Belum diset</b> (hubungi owner)`;
      }
    }
    text += `\n${tge("LOCK_KEY","🔐")} PIN 2FA: ${hasPin ? `${tge("SUCCESS","✅")} Aktif` : `${tge("ERROR","❌")} Belum set`}`;
    text += `\n${tge("GIFT","🎁")} Trial Panel: ${trialUsed ? `${tge("SUCCESS","✅")} Sudah dipakai` : `${tge("GREEN_DOT","🟢")} Tersedia`}`;
    text += `\n\n${tge("USERS","👥")} <b>Referral:</b>\nKode: \`${referral.code}\`\nDiajak: *${referral.referrals.length}* orang\nBonus: *${referral.bonus} hari*`;

    if (panels.length) {
      text += `\n\n${tge("OPEN_FOLDER","📂")} <b>Panel Aktif:</b>\n`;
      panels.filter(p => !p.expired && !p.suspended).slice(0, 5).forEach((p) => {
        const dl = daysLeft(p.expire_date);
        text += `• ${p.name || "N/A"} — ${dl !== null && dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl !== null && dl <= 3 ? `${tge("YELLOW_DOT","🟡")} ${dl}hr` : `${tge("GREEN_DOT","🟢")} ${dl}hr`}\n`;
      });
    }
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── My Panels (callback) ───────────────────────────────────────────
  if (data === "my_panels") {
    const panels = db.getUserPanels(userId);
    if (!panels.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Kamu belum memiliki panel.`, backKeyboard());
    let text = `${tge("LIST","📋")} *Daftar Panel Kamu (${panels.length}):*\n\n`;
    panels.forEach((p, i) => {
      const tipe    = p.panel_type === "admin" ? `${tge("CROWN","👑")} Admin` : `${tge("DESKTOP","🖥️")} Biasa`;
      const dl      = daysLeft(p.expire_date);
      const expStr  = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl <= 3 ? `${tge("YELLOW_DOT","🟡")} Sisa ${dl} hari` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : "";
      const status  = p.expired ? `${tge("SKULL","💀")} Expired` : p.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
      text +=
        `*${i+1}. ${p.name || "N/A"}*\n` +
        `   ${tge("ID_CARD","🆔")} Server ID: \`${p.server_id || "N/A"}\`\n` +
        `   ${tge("MASK","🎭")} Tipe: ${tipe}\n` +
        `   ${tge("EGG","🥚")} Egg: ${p.egg || "N/A"}\n` +
        `   ${tge("PACKAGE","📦")} Paket: ${p.plan_name || "N/A"}\n` +
        `   ${tge("CALENDAR","📅")} Dibuat: ${formatDate(p.created_at)}\n` +
        `   ${tge("ALARM","⏰")} Expired: ${formatDate(p.expire_date)} ${expStr}\n` +
        `   ${tge("BRIGHT","🔆")} Status: ${status}\n\n`;
    });
    text += `_Pilih panel di bawah untuk kelola:_`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...myPanelsKeyboard(panels) });
  }

  // ── Manage Panel (individual) ──────────────────────────────────────
  if (data.startsWith("mng_panel_")) {
    const serverId = data.slice(10);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    if (!panel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    const dl = daysLeft(panel.expire_date);
    const expStr = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl <= 3 ? `${tge("YELLOW_DOT","🟡")} Sisa ${dl} hari` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : "";
    const status = panel.expired ? `${tge("SKULL","💀")} Expired` : panel.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
    const text =
      `${tge("WRENCH","🔧")} <b>Kelola Panel</b>\n\n` +
      `${tge("NAME_BADGE","📛")} Nama: *${panel.name || "N/A"}*\n` +
      `${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n` +
      `${tge("PACKAGE","📦")} Paket: ${panel.plan_name || "N/A"}\n` +
      `${tge("CALENDAR","📅")} Expired: ${formatDate(panel.expire_date)} ${expStr}\n` +
      `${tge("BRIGHT","🔆")} Status: ${status}\n\n` +
      `Pilih aksi:`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...panelManageKeyboard(panel, isOwner(userId)) });
  }

  // ── Power Control ──────────────────────────────────────────────────
  if (data.startsWith("pwr_start_") || data.startsWith("pwr_stop_") || data.startsWith("pwr_rst_")) {
    const action = data.startsWith("pwr_start_") ? "start" : data.startsWith("pwr_stop_") ? "stop" : "restart";
    const serverId = data.startsWith("pwr_start_") ? data.slice(10) : data.startsWith("pwr_stop_") ? data.slice(9) : data.slice(8);

    // PIN Check
    if (needsPin(userId, "power")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = data;
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }

    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan. Panel ini dibuat sebelum fitur power control tersedia.`, backKeyboard());

    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengirim sinyal *${action}*...`, { parse_mode: "HTML" });
    const ok = await ptero.sendPowerAction(identifier, action, psn(panel));
    const icons = { start: `${tge("ARROW_RIGHT","▶️")}`, stop: `${tge("STOP","⏹️")}`, restart: `${tge("REFRESH","🔄")}` };
    db.addAuditLog({ actorId: userId, action: `Power ${action}`, target: serverId });
    return ctx.reply(
      ok ? `${icons[action] || `${tge("LIGHTNING","⚡")}`} Server berhasil dikirim sinyal *${action}*.` : `${tge("ERROR","❌")} Gagal mengirim sinyal *${action}*.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Reset Password Panel ───────────────────────────────────────────
  if (data.startsWith("rst_pw_")) {
    const serverId = data.slice(7);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    if (!panel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());

    if (needsPin(userId, "reset_pw")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = data;
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }

    const s = getState(userId);
    s.step = "reset_pw_new";
    s.reset_pw_server_id = serverId;
    return safeEdit(ctx, `${tge("KEY","🔑")} <b>Reset Password Panel</b>\n\nPanel: *${panel.name}*\n\nMasukkan <b>password baru</b> (min. 8 karakter):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Rename Server ──────────────────────────────────────────────────
  if (data.startsWith("ren_srv_")) {
    const serverId = data.slice(8);
    const s = getState(userId);
    s.step = "rename_srv_new";
    s.rename_srv_id = serverId;
    return safeEdit(ctx, `${tge("PENCIL","✏️")} <b>Rename Server</b>\n\nMasukkan <b>nama baru</b> untuk server \`${serverId}\`:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Server Resources ───────────────────────────────────────────────
  if (data.startsWith("srv_res_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil status server...`, { parse_mode: "HTML" });
    const res = await ptero.getServerResources(identifier, psn(panel));
    if (!res) return ctx.reply(`${tge("ERROR","❌")} Gagal mengambil status server.`, backKeyboard());
    const st = res.current_state || "unknown";
    const rss = res.resources || {};
    const cpuPct  = (rss.cpu_absolute || 0).toFixed(1);
    const ramUsed = formatBytes(rss.memory_bytes || 0);
    const diskUsed = formatBytes(rss.disk_bytes || 0);
    const netRx   = formatBytes(rss.network_rx_bytes || 0);
    const netTx   = formatBytes(rss.network_tx_bytes || 0);
    const uptime  = rss.uptime ? formatUptime(Math.floor(rss.uptime / 1000)) : "N/A";
    return ctx.reply(
      `${tge("CHART","📊")} <b>Status Server</b>\n\n${tge("NAME_BADGE","📛")} Panel: \`${panel.name}\`\n${tge("REFRESH","🔄")} State: *${st.toUpperCase()}*\n\n` +
      `${tge("GEAR","⚙️")} CPU: *${cpuPct}%*\n${tge("FLOPPY","💾")} RAM: *${ramUsed}*\n${tge("DISK","💿")} Disk: *${diskUsed}*\n` +
      `${tge("GLOBE","🌐")} Net ↓: ${netRx}  |  ↑: ${netTx}\n${tge("CLOCK","⏱️")} Uptime: *${uptime}*`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Detail Panel ───────────────────────────────────────────────────
  if (data.startsWith("dtl_srv_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    if (!panel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil detail panel...`);
    const srv = await ptero.getServerDetails(serverId, psn(panel));
    if (!srv) return ctx.reply(`${tge("ERROR","❌")} Gagal mengambil detail dari panel.`, backKeyboard());
    const allocs = srv.relationships?.allocations?.data || [];
    const alloc  = allocs[0]?.attributes;
    const ip     = alloc ? `${alloc.ip_alias || alloc.ip}:${alloc.port}` : "N/A";
    const egg    = srv.relationships?.egg?.attributes;
    const nest   = srv.relationships?.nest?.attributes;
    const dl     = daysLeft(panel.expire_date);
    const expStr = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : `${tge("INFINITY","♾️")} Tidak ada`;
    const status = panel.expired ? `${tge("SKULL","💀")} Expired` : panel.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
    const text =
      `${tge("LIST","📋")} <b>Detail Panel</b>\n\n` +
      `${tge("NAME_BADGE","📛")} Nama: \`${srv.name}\`\n` +
      `${tge("ID_CARD","🆔")} Server ID: \`${srv.id}\`\n` +
      `${tge("KEY","🔑")} Identifier: \`${srv.identifier || "N/A"}\`\n` +
      `${tge("GLOBE","🌐")} IP:Port: \`${ip}\`\n\n` +
      `${tge("CARD_INDEX","🗂️")} Nest: *${nest?.name || "N/A"}*\n` +
      `${tge("EGG","🥚")} Egg: *${egg?.name || "N/A"}*\n\n` +
      `${tge("GEAR","⚙️")} CPU: *${srv.limits?.cpu || 0}%*\n` +
      `${tge("FLOPPY","💾")} RAM: *${srv.limits?.memory || 0} MB*\n` +
      `${tge("DISK","💿")} Disk: *${srv.limits?.disk || 0} MB*\n` +
      `${tge("FLOPPY","💾")} Backup Slot: *${srv.feature_limits?.backups || 0}*\n\n` +
      `${tge("CALENDAR","📅")} Expired: ${formatDate(panel.expire_date)} ${expStr}\n` +
      `${tge("BRIGHT","🔆")} Status: ${status}`;
    return ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Perpanjang Panel Mandiri (diblokir – hanya owner) ──────────────
  if (data.startsWith("extend_self_pick_") || (data.startsWith("extend_self_") && !data.startsWith("extend_self_pick_"))) {
    return safeEdit(ctx,
      `${tge("LOCK","🔒")} <b>Perpanjang Panel</b>\n\nPerpanjangan panel hanya bisa dilakukan oleh <b>Owner Bot</b>.\n\n${tge("CALENDAR","📅")} Jika kamu sudah redeem voucher hari, saldo harimu sudah tersimpan — hubungi owner untuk proses perpanjangannya.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Transfer Panel (owner) ─────────────────────────────────────────
  if (data.startsWith("trn_pan_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const serverId = data.slice(8);
    const s = getState(userId);
    s.step = "transfer_pan_uid";
    s.transfer_server_id = serverId;
    return safeEdit(ctx,
      `${tge("REFRESH","🔄")} <b>Transfer Panel</b>\n\n${tge("ID_CARD","🆔")} Server ID: \`${serverId}\`\n\nMasukkan <b>Telegram User ID</b> tujuan transfer:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  // ── Backup Server ──────────────────────────────────────────────────
  if (data.startsWith("bkp_srv_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());

    if (needsPin(userId, "backup")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = data;
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }

    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat backup server...`, { parse_mode: "HTML" });
    const backup = await ptero.createBackup(identifier, psn(panel));
    db.addAuditLog({ actorId: userId, action: "Backup Server", target: serverId });
    if (!backup) return ctx.reply(`${tge("ERROR","❌")} Gagal membuat backup. Pastikan server punya slot backup.`, backKeyboard());
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Backup Dimulai!</b>\n\n${tge("FLOPPY","💾")} Nama: \`${backup.name}\`\n${tge("ID_CARD","🆔")} UUID: \`${backup.uuid}\`\n${tge("CALENDAR","📅")} Dibuat: ${formatDate(backup.created_at || new Date().toISOString())}\n\nBackup berjalan di background. Cek list backup untuk status.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── List Backup ────────────────────────────────────────────────────
  if (data.startsWith("lst_bkp_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil daftar backup...`, { parse_mode: "HTML" });
    const backups = await ptero.getBackups(identifier, psn(panel));
    if (!backups.length) return ctx.reply(`${tge("EMPTY_BOX","📭")} Belum ada backup untuk server ini.`, backKeyboard());
    let text = `${tge("FLOPPY","💾")} <b>Daftar Backup</b>\n\n${tge("NAME_BADGE","📛")} Panel: \`${panel.name}\`\n\n`;
    backups.forEach((b, i) => {
      const attr = b.attributes;
      const status = attr.completed_at ? `${tge("SUCCESS","✅")} Selesai` : `${tge("HOURGLASS","⏳")} Proses`;
      const size = attr.bytes ? formatBytes(attr.bytes) : "N/A";
      text += `*${i+1}. ${attr.name}*\n   Status: ${status}  •  Size: ${size}\n   ${tge("CALENDAR","📅")} ${formatDate(attr.created_at)}\n\n`;
    });
    return ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Schedules / Cron ───────────────────────────────────────────────
  if (data.startsWith("schedules_")) {
    const serverId = data.slice(10);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil jadwal...`, { parse_mode: "HTML" });
    const schedules = await ptero.getSchedules(identifier, psn(panel));
    let text = `${tge("ALARM","⏰")} <b>Jadwal Server</b>\n\n${tge("NAME_BADGE","📛")} Panel: \`${panel.name}\`\n`;
    if (schedules.length) {
      schedules.forEach((sc, i) => {
        const a = sc.attributes;
        text += `\n*${i+1}. ${a.name}*\n   ${tge("ALARM","⏰")} Cron: \`${a.cron_minute} ${a.cron_hour} ${a.cron_day_of_month} ${a.cron_month} ${a.cron_day_of_week}\`\n   Status: ${a.is_active ? `${tge("SUCCESS","✅")} Aktif` : `${tge("PAUSE","⏸️")} Nonaktif`}\n`;
      });
    } else {
      text += `\n\n${tge("EMPTY_BOX","📭")} Belum ada jadwal.`;
    }

    const s = getState(userId);
    s.schedule_server_id = serverId;

    const rows = [];
    schedules.forEach((sc) => {
      rows.push([Markup.button.callback(`🗑️ Hapus: ${sc.attributes.name.slice(0,20)}`, `del_sched_${serverId}_${sc.attributes.id}`)]);
    });
    rows.push([Markup.button.callback("✨ Buat Jadwal Baru", `new_sched_${serverId}`)]);
    rows.push([Markup.button.callback("◀️ Kembali", "my_panels")]);
    return safeEdit(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
  }

  if (data.startsWith("del_sched_")) {
    const parts = data.slice(10).split("_");
    const serverId = parts[0];
    const scheduleId = parts[1];
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Identifier tidak ditemukan.`, backKeyboard());
    const ok = await ptero.deleteSchedule(identifier, scheduleId, psn(panel));
    db.addAuditLog({ actorId: userId, action: "Hapus Jadwal", target: serverId, detail: `scheduleId: ${scheduleId}` });
    return safeEdit(ctx, ok ? `${tge("SUCCESS","✅")} Jadwal berhasil dihapus.` : `${tge("ERROR","❌")} Gagal menghapus jadwal.`, backKeyboard());
  }

  if (data.startsWith("new_sched_")) {
    const serverId = data.slice(10);
    const s = getState(userId);
    s.step = "sched_name";
    s.sched_server_id = serverId;
    return safeEdit(ctx,
      `${tge("PLUS","➕")} <b>Buat Jadwal Baru</b>\n\nMasukkan <b>nama jadwal</b>:\n_(contoh: Auto Restart)_`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  // ── Extend Panel ──────────────────────────────────────────────────
  if (data.startsWith("ext_pan_")) {
    const serverId = data.slice(8);
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "extend_days";
    s.extend_server_id = serverId;
    return safeEdit(ctx, `${tge("SPIRAL_CAL","🗓️")} <b>Perpanjang Panel</b>\n\nServer ID: \`${serverId}\`\n\nMasukkan <b>jumlah hari</b> perpanjangan:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Extend Panel (owner input) ─────────────────────────────────────
  if (data === "extend_panel_input") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "extend_server_id";
    return safeEdit(ctx, `${tge("SPIRAL_CAL","🗓️")} Masukkan <b>Server ID</b> yang ingin diperpanjang:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Create Panel ──────────────────────────────────────────────────
  if (data === "create_panel" || data === "create_admin_panel") {
    const panelLimit = getPanelLimit(role);
    const panelCount = db.getPanelCount(userId);
    const dailyLimit = getDailyLimit(role);
    const dailyCount = db.getDailyCount(userId);

    if (panelLimit === 0) return safeEdit(ctx, `${tge("ERROR","❌")} Role kamu belum punya akses buat panel.\n${tge("ADMISSION","🎟️")} Redeem voucher untuk upgrade role!`, { parse_mode: "HTML", ...backKeyboard() });
    if (panelCount >= panelLimit && panelLimit !== 9999) return safeEdit(ctx, `${tge("ERROR","❌")} Kamu sudah mencapai batas *${panelLimit} panel*.\n\nHubungi owner untuk perpanjang atau hapus panel.`, { parse_mode: "HTML", ...backKeyboard() });
    if (dailyLimit < 9999 && dailyCount >= dailyLimit) return safeEdit(ctx, `${tge("ERROR","❌")} Kamu sudah membuat *${dailyCount}* panel hari ini.\nBatas harian: *${dailyLimit}* panel.\n\nCoba lagi besok!`, { parse_mode: "HTML", ...backKeyboard() });

    if (data === "create_admin_panel" && !["premium", "owner"].includes(role))
      return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Premium & Owner yang bisa buat Admin Panel.`, backKeyboard());

    if (role === "reseller") {
      const limCheck = db.checkResellerLimit(userId);
      if (!limCheck.ok) {
        const msgs = {
          no_limit:     `${tge("ERROR","❌")} Kamu belum memiliki limit panel.\n\nHubungi owner untuk mendapatkan limit.`,
          expired:      `${tge("ERROR","❌")} Limit panel kamu sudah <b>kadaluarsa</b> (${formatDate(limCheck.expDate)}).\n\nHubungi owner untuk perpanjang.`,
          no_count:     `${tge("ERROR","❌")} Limit panel kamu <b>habis</b> (0 slot tersisa).\n\nHubungi owner untuk tambah limit.`,
          invalid_date: `${tge("ERROR","❌")} Tanggal limit tidak valid. Hubungi owner.`,
        };
        return safeEdit(ctx, msgs[limCheck.reason] || `${tge("ERROR","❌")} Limit reseller tidak valid.`, { parse_mode: "HTML", ...backKeyboard() });
      }
    }

    const s = getState(userId);
    s.panel_type = data === "create_admin_panel" ? "admin" : "biasa";
    // Simpan info pesan prompt agar bisa dihapus setelah panel selesai dibuat
    const promptMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    if (promptMsg) {
      s.prompt_msg_id  = promptMsg.message_id;
      s.prompt_chat_id = promptMsg.chat.id;
    }
    // Multi-server: kalau role punya akses lebih dari 1 server, minta pilih dulu
    const allowed = allowedServers(role);
    if (allowed.length > 1) {
      s.step = "pick_server";
      const labels = allowed.map(n => `• <b>${he2(serverLabel(n))}</b>`).join("\n");
      return safeEdit(
        ctx,
        `${tge("DESKTOP","🖥️")} <b>Pilih Server Panel</b>\n\n${tge("MASK","🎭")} Tipe: <b>${s.panel_type === "admin" ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`}</b>\n\nTersedia:\n${labels}\n\nPilih server tempat panel akan dibuat:`,
        { parse_mode: "HTML", ...serverPickerKeyboard(role, "pick_srv_") }
      );
    }
    // Hanya 1 server diizinkan → langsung pakai itu
    s.server_num = allowed[0] || 1;
    s.step = "username";
    return safeEdit(ctx, `${tge("DESKTOP","🖥️")} <b>Buat Panel Baru</b>\n\n${tge("MASK","🎭")} Tipe: <b>${s.panel_type === "admin" ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`}</b>\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(s.server_num))}</b>\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan (huruf kecil, angka, underscore):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Pilih Server saat buat panel ──────────────────────────────────
  if (data.startsWith("pick_srv_")) {
    const num = parseInt(data.slice("pick_srv_".length));
    if (![1, 2].includes(num)) return safeEdit(ctx, `${tge("ERROR","❌")} Server tidak valid.`, backKeyboard());
    if (!canUseServer(role, num)) {
      return safeEdit(ctx, `${tge("LOCK","🔒")} Role <b>${he2(role)}</b> tidak punya akses ke <b>${he2(serverLabel(num))}</b>.`, { parse_mode: "HTML", ...backKeyboard() });
    }
    const s = getState(userId);
    s.server_num = num;
    s.step = "username";
    return safeEdit(ctx, `${tge("SUCCESS","✅")} Server dipilih: <b>${he2(serverLabel(num))}</b>\n\n${tge("MASK","🎭")} Tipe: <b>${s.panel_type === "admin" ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`}</b>\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan (huruf kecil, angka, underscore):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Trial Panel ───────────────────────────────────────────────────
  if (data === "trial_panel") {
    if (config.TRIAL_HOURS <= 0 || !db.getTrialEnabled()) return safeEdit(ctx, `${tge("ERROR","❌")} Fitur trial sedang <b>tidak aktif</b>.\n\nHubungi owner jika ada pertanyaan.`, { parse_mode: "HTML", ...backKeyboard() });
    if (db.hasUsedTrial(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Kamu sudah pernah menggunakan trial panel.\n\nTrial hanya bisa digunakan <b>1 kali</b> per akun.`, { parse_mode: "HTML", ...backKeyboard() });

    const s = getState(userId);
    s.step = "trial_username";
    return safeEdit(ctx,
      `${tge("GIFT","🎁")} <b>Trial Panel Gratis</b>\n\n${tge("ALARM","⏰")} Durasi: *${config.TRIAL_HOURS} Jam*\n${tge("PACKAGE","📦")} Paket: *${config.TRIAL_PLAN.name}* (RAM ${config.TRIAL_PLAN.ram}MB, Disk ${config.TRIAL_PLAN.disk}MB, CPU ${config.TRIAL_PLAN.cpu}%)\n\n${tge("WARNING","⚠️")} Trial hanya sekali per akun!\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  // ── Referral Menu ─────────────────────────────────────────────────
  if (data === "referral_menu") {
    if (!db.getReferralEnabled()) {
      return safeEdit(ctx, `${tge("ERROR","❌")} Fitur referral sedang <b>tidak aktif</b>.\n\nHubungi owner jika ada pertanyaan.`, { parse_mode: "HTML", ...backKeyboard() });
    }
    await showReferralMenuCb(ctx, userId);
    return;
  }

  if (data === "toggle_referral") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const currentState = db.getReferralEnabled();
    db.setReferralEnabled(!currentState);
    db.addAuditLog({ actorId: userId, action: `Referral System ${!currentState ? "Diaktifkan" : "Dinonaktifkan"}` });
    const newState = db.getReferralEnabled();
    const _ton = tge("TOGGLE_ON","🟢"); const _toff = tge("TOGGLE_OFF","🔴");
    const _ok = tge("SUCCESS","✅"); const _no = tge("ERROR","❌");
    return safeEdit(ctx,
      `${newState ? _ton : _toff} <b>Fitur Referral ${newState ? "Diaktifkan!" : "Dinonaktifkan!"}</b>\n\n` +
      `${newState
        ? `${_ok} User sekarang bisa menggunakan sistem referral dan mendapat bonus.`
        : `${_no} User tidak bisa menggunakan referral sampai diaktifkan lagi.`}\n\n` +
      `<i>Ubah kapan saja lewat menu utama.</i>`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  if (data === "claim_referral") {
    if (!db.getReferralEnabled()) return safeEdit(ctx, `${tge("ERROR","❌")} Fitur referral sedang <b>tidak aktif</b>.`, { parse_mode: "HTML", ...backKeyboard() });
    const stats = db.getReferralStats(userId);
    const unclaimed = stats.referrals.filter(r => !r.bonus_claimed);
    if (!unclaimed.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada bonus referral yang bisa diklaim saat ini.\n\nBonus bisa diklaim setelah referral kamu membuat panel pertamanya.`, { parse_mode: "HTML", ...backKeyboard() });
    const bonusDays = db.claimReferralBonus(userId);
    return safeEdit(ctx,
      `${tge("SUCCESS","✅")} <b>Bonus Referral Diklaim!</b>\n\n${tge("GIFT","🎁")} Kamu dapat *+${bonusDays} hari* yang akan ditambah ke panel berikutnya!\n\n_Bonus digunakan otomatis saat kamu buat panel._`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Security Menu ─────────────────────────────────────────────────
  if (data === "security_menu") {
    const hasPin = !!db.getPin(userId);
    const pinActions = (config.PIN_REQUIRED_ACTIONS || []).join(", ");
    return safeEdit(ctx,
      `${tge("LOCK_KEY","🔐")} <b>Keamanan Akun</b>\n\nPIN 2FA: ${hasPin ? `${tge("SUCCESS","✅")} <b>Aktif</b>` : `${tge("ERROR","❌")} <b>Belum diset</b>`}\n\nPIN digunakan untuk memverifikasi aksi sensitif:\n_${pinActions}_\n\nAtur PIN di bawah:`,
      { parse_mode: "HTML", ...securityMenuKeyboard(hasPin) }
    );
  }

  if (data === "set_pin" || data === "change_pin") {
    const s = getState(userId);
    s.step = "set_pin_code";
    return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Set PIN</b>\n\nMasukkan PIN baru (4-6 digit angka):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "clear_pin") {
    db.clearPin(userId);
    db.addAuditLog({ actorId: userId, action: "Hapus PIN 2FA" });
    return safeEdit(ctx, `${tge("SUCCESS","✅")} PIN berhasil dihapus.`, backKeyboard());
  }

  // ── Audit Log ──────────────────────────────────────────────────────
  if (data === "view_audit") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const logs = db.getAuditLogs(20);
    if (!logs.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada audit log.`, backKeyboard());
    let text = `${tge("LIST","📋")} <b>Audit Log (20 terakhir):</b>\n\n`;
    logs.forEach((l) => {
      text += `• [${formatDate(l.at)}] \`${l.actorId}\` → *${l.action}*`;
      if (l.target) text += ` — \`${l.target}\``;
      if (l.detail) text += ` (${l.detail})`;
      text += "\n";
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Daily Report Now ───────────────────────────────────────────────
  if (data === "daily_report_now") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat laporan...`, { parse_mode: "HTML" });
    const reportText = buildDailyReportText();
    return ctx.reply(reportText, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Riwayat Transaksi (owner) ──────────────────────────────────────
  if (data === "view_transactions") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const txs = db.getAllTransactions(20);
    if (!txs.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada transaksi.`, backKeyboard());
    let text = `${tge("SCROLL","📜")} <b>Riwayat Transaksi (20 terakhir):</b>\n\n`;
    txs.forEach((t) => {
      text += `• [${formatDate(t.at)}] \`${t.userId}\` → *${t.type}* — ${t.name || t.detail || ""}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Riwayat Transaksi (user sendiri) ──────────────────────────────
  if (data === "user_transactions") {
    const txs = db.getUserTransactions(userId, 10);
    if (!txs.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada riwayat panel kamu.`, backKeyboard());
    let text = `${tge("SCROLL","📜")} *Riwayat Panel Kamu (${txs.length} terakhir):*\n\n`;
    txs.forEach((t) => {
      text += `• [${formatDate(t.at)}] *${t.type}* — ${t.name || t.detail || ""}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Broadcast ─────────────────────────────────────────────────────
  if (data === "broadcast_msg") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "broadcast_text";
    return safeEdit(ctx, `${tge("LOUDSPEAKER","📢")} <b>Broadcast Pesan</b>\n\nMasukkan pesan yang ingin dikirim ke semua user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Toggle Trial Panel ────────────────────────────────────────────
  if (data === "toggle_trial") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const currentState = db.getTrialEnabled();
    db.setTrialEnabled(!currentState);
    db.addAuditLog({ actorId: userId, action: `Trial Panel ${!currentState ? "Diaktifkan" : "Dinonaktifkan"}` });
    const newState = db.getTrialEnabled();
    const _ton = tge("TOGGLE_ON", `${tge("GREEN_DOT","🟢")}`); const _toff = tge("TOGGLE_OFF", `${tge("RED_DOT","🔴")}`);
    const _ok = tge("SUCCESS", `${tge("SUCCESS","✅")}`); const _no = tge("ERROR", `${tge("ERROR","❌")}`);
    return safeEdit(ctx,
      `${newState ? _ton : _toff} <b>Fitur Trial Panel ${newState ? "Diaktifkan!" : "Dinonaktifkan!"}</b>\n\n` +
      `${newState
        ? `${_ok} User sekarang bisa menggunakan trial panel gratis.`
        : `${_no} User tidak bisa menggunakan trial panel sampai diaktifkan lagi.`}\n\n` +
      `<i>Ubah kapan saja lewat menu utama.</i>`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Auto Backup Menu ──────────────────────────────────────────────
  if (data === "auto_backup_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const ab = db.getAutoBackup();
    const lastRun = ab.last_run ? formatDate(ab.last_run) : "Belum pernah";
    return safeEdit(ctx,
      `${tge("FLOPPY","💾")} <b>Auto Backup Bot</b>\n\n` +
      `Status: *${ab.enabled ? `${tge("GREEN_DOT","🟢")} Aktif` : `${tge("RED_DOT","🔴")} Nonaktif`}*\n` +
      `${tge("CLOCK","⏱️")} Interval: *${ab.interval_hours} jam sekali*\n` +
      `${tge("CLOCK_FACE","🕐")} Terakhir berjalan: *${lastRun}*\n\n` +
      `${tge("PACKAGE","📦")} Backup berisi: semua script bot + file database\n` +
      `${tge("OUTBOX","📤")} File dikirim otomatis ke private chat semua owner.`,
      { parse_mode: "HTML", ...autoBackupKeyboard(ab) }
    );
  }

  if (data === "toggle_auto_backup") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const ab = db.getAutoBackup();
    db.setAutoBackup({ enabled: !ab.enabled });
    const newAb = db.getAutoBackup();
    db.addAuditLog({ actorId: userId, action: `Auto Backup ${newAb.enabled ? "Diaktifkan" : "Dinonaktifkan"}` });
    const lastRun = newAb.last_run ? formatDate(newAb.last_run) : "Belum pernah";
    const _ton = tge("TOGGLE_ON","🟢"); const _toff = tge("TOGGLE_OFF","🔴");
    return safeEdit(ctx,
      `${tge("FLOPPY","💾")} <b>Auto Backup Bot</b>\n\n` +
      `Status: <b>${newAb.enabled ? `${_ton} Aktif` : `${_toff} Nonaktif`}</b>\n` +
      `${tge("CLOCK","⏱️")} Interval: <b>${he2(String(newAb.interval_hours))} jam sekali</b>\n` +
      `${tge("CLOCK_FACE","🕐")} Terakhir berjalan: <b>${he2(lastRun)}</b>\n\n` +
      `${tge("PACKAGE","📦")} Backup berisi: semua script bot + file database\n` +
      `${tge("OUTBOX","📤")} File dikirim otomatis ke private chat semua owner.`,
      { parse_mode: "HTML", ...autoBackupKeyboard(newAb) }
    );
  }

  if (data === "set_backup_interval") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "auto_backup_interval";
    return safeEdit(ctx,
      `${tge("CLOCK","⏱️")} <b>Set Interval Auto Backup</b>\n\n` +
      `Masukkan interval backup dalam <b>jam</b> (angka 1–168):\n\n` +
      `Contoh: <code>6</code> = backup setiap 6 jam\nContoh: <code>24</code> = backup setiap hari`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (data === "run_backup_now") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat backup bot...</b>\n\nMengemas script & database, harap tunggu.`, { parse_mode: "HTML" });
    const result = await runAutoBackup(true);
    if (result.success) {
      return ctx.reply(
        `${tge("SUCCESS","✅")} <b>Backup Bot Selesai!</b>\n\n` +
        `${tge("FOLDER","📁")} File: \`${result.filename}\`\n` +
        `${tge("RULER","📏")} Ukuran: *${result.sizeKB} KB*\n` +
        `${tge("OUTBOX","📤")} Terkirim ke: *${result.sentCount}* owner\n\n` +
        `_File backup sudah dikirim ke private chat owner._`,
        { parse_mode: "HTML", ...mainMenuKeyboard(role) }
      );
    } else {
      return ctx.reply(
        `${tge("ERROR","❌")} <b>Backup Gagal!</b>\n\n\`${result.error || "Error tidak diketahui"}\``,
        { parse_mode: "HTML", ...mainMenuKeyboard(role) }
      );
    }
  }

  // ── Maintenance Toggle ─────────────────────────────────────────────
  if (data === "maintenance_toggle") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const maint = db.getMaintenanceMode();
    if (maint.active) {
      db.setMaintenanceMode(false);
      db.addAuditLog({ actorId: userId, action: "Matikan Maintenance" });
      return safeEdit(ctx, `${tge("SUCCESS","✅")} <b>Maintenance Mode dimatikan.</b>\n\nBot kembali normal.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
    }
    const s = getState(userId);
    s.step = "maintenance_msg";
    return safeEdit(ctx, `${tge("WRENCH","🔧")} Masukkan <b>pesan maintenance</b> yang akan ditampilkan ke user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Check Nodes ───────────────────────────────────────────────────
  if (data === "check_nodes") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengecek status node...`, { parse_mode: "HTML" });
    return sendNodesEdit(ctx);
  }

  // ── Stats ─────────────────────────────────────────────────────────
  if (data === "stats") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return sendStatsEdit(ctx);
  }

  // ── Manage Server ──────────────────────────────────────────────────
  if (data === "manage_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("WRENCH","🔧")} <b>Kelola Server</b>\nPilih aksi:`, { parse_mode: "HTML", ...manageServerKeyboard() });
  }

  if (data === "suspend_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "suspend_id";
    return safeEdit(ctx, `${tge("LOCK","🔒")} Masukkan <b>ID server</b> yang ingin di-suspend:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "unsuspend_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "unsuspend_id";
    return safeEdit(ctx, `${tge("UNLOCK","🔓")} Masukkan <b>ID server</b> yang ingin di-unsuspend:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "reinstall_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "reinstall_id";
    return safeEdit(ctx, `${tge("REFRESH","🔄")} Masukkan <b>ID server</b> yang ingin di-reinstall:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Delete Server ─────────────────────────────────────────────────
  if (data === "delete_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    if (needsPin(userId, "delete")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = "delete_server_flow";
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    const s = getState(userId); s.step = "delete_id";
    return safeEdit(ctx, `${tge("TRASH","🗑️")} Masukkan <b>ID server</b> yang ingin dihapus:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── List Servers (Owner) ──────────────────────────────────────────
  if (data === "list_servers") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Mengambil daftar semua server...</b>`, { parse_mode: "HTML" });
    const sAdm = getState(userId);
    const servers = await ptero.listServers(sAdm.admin_srv || 1);
    if (!servers.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada server di panel.`, backKeyboard());
    const s = getState(userId);
    s.srv_list = servers;
    s.srv_filter = "all";
    s.srv_page   = 0;
    const aktif = servers.filter(sv => !sv.attributes.suspended && !sv.attributes.status).length;
    const susp  = servers.filter(sv => sv.attributes.suspended).length;
    const inst  = servers.filter(sv => sv.attributes.status === "installing").length;
    const text  =
      `${tge("DESKTOP","🖥️")} <b>Semua Server Pterodactyl</b>\n\n` +
      `${tge("CHART","📊")} Total: *${servers.length}* server\n` +
      `${tge("GREEN_DOT","🟢")} Aktif: *${aktif}*  •  ${tge("LOCK","🔒")} Suspended: *${susp}*  •  ${tge("GEAR","⚙️")} Installing: *${inst}*\n\n` +
      `_Klik server untuk kelola (suspend/unsuspend/reinstall/hapus)_`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...allServersKeyboard(servers, "all", 0) });
  }

  // ── Filter + Pagination Server List ───────────────────────────────
  if (data.startsWith("srv_f_")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const parts  = data.split("_"); // ["srv","f","<filter>","<page>"]
    const filter = parts[2] || "all";
    const page   = parseInt(parts[3]) || 0;
    const s = getState(userId);
    // Refresh list jika belum ada
    if (!s.srv_list || !s.srv_list.length) {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil daftar server...`, { parse_mode: "HTML" });
      s.srv_list = await ptero.listServers(s.admin_srv || 1);
    }
    s.srv_filter = filter;
    s.srv_page   = page;
    const servers = s.srv_list;
    if (!servers.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada server.`, backKeyboard());
    const aktif = servers.filter(sv => !sv.attributes.suspended && !sv.attributes.status).length;
    const susp  = servers.filter(sv => sv.attributes.suspended).length;
    const inst  = servers.filter(sv => sv.attributes.status === "installing").length;
    const filterLabel = { all: "Semua", act: "Aktif", sus: "Suspended" }[filter] || "Semua";
    const text =
      `${tge("DESKTOP","🖥️")} <b>Semua Server Pterodactyl</b> — ${filterLabel}\n\n` +
      `${tge("CHART","📊")} Total: *${servers.length}* server\n` +
      `${tge("GREEN_DOT","🟢")} Aktif: *${aktif}*  •  ${tge("LOCK","🔒")} Suspended: *${susp}*  •  ${tge("GEAR","⚙️")} Installing: *${inst}*\n\n` +
      `_Klik server untuk kelola_`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...allServersKeyboard(servers, filter, page) });
  }

  // ── Noop (info pagination) ─────────────────────────────────────────
  if (data === "srv_noop") return ctx.answerCbQuery();

  // ── Kelola 1 Server (Owner) ────────────────────────────────────────
  if (data.startsWith("srv_m_")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const serverId = data.slice(6);
    const s = getState(userId);
    const filter = s.srv_filter || "all";
    const page   = s.srv_page   || 0;
    const sv = await ptero.getServerDetails(serverId, srvOf(serverId, s));
    if (!sv) return safeEdit(ctx, `${tge("ERROR","❌")} Server tidak ditemukan.`, backKeyboard());
    const a    = sv;
    const icon = srvStatusIcon(a);
    const susp = a.suspended ? `${tge("LOCK","🔒")} Suspended` : (a.status || `${tge("GREEN_DOT","🟢")} Aktif`);
    // Cari owner di db
    const dbRecord = db.getPanelByServerId(a.id);
    const ownerLine = dbRecord
      ? `${tge("USER","👤")} Pemilik (Bot): \`${dbRecord.ownerUserId}\`\n`
      : `${tge("USER","👤")} Pterodactyl User ID: \`${a.user}\`\n`;
    const alloc   = (a.relationships?.allocations?.data || [])[0]?.attributes;
    const ipStr   = alloc ? `${alloc.ip}:${alloc.port}` : "N/A";
    const text =
      `${tge("DESKTOP","🖥️")} <b>Detail Server</b>\n\n` +
      `${tge("NAME_BADGE","📛")} Nama: \`${a.name}\`\n` +
      `${tge("ID_CARD","🆔")} Server ID: \`${a.id}\`\n` +
      `${tge("KEY","🔑")} Identifier: \`${a.identifier}\`\n` +
      `${tge("GLOBE","🌐")} IP:Port: \`${ipStr}\`\n` +
      ownerLine +
      `${tge("CHART","📊")} Status: ${icon} ${susp}\n` +
      `${tge("FLOPPY","💾")} RAM: ${a.limits?.memory || 0} MB  •  ${tge("DISK","💿")} Disk: ${a.limits?.disk || 0} MB  •  ${tge("GEAR","⚙️")} CPU: ${a.limits?.cpu || 0}%\n` +
      `${tge("BRAIN","🧠")} OOM Killer: ${a.limits?.oom_killer ? `${tge("SUCCESS","✅")} Aktif` : `${tge("ERROR","❌")} Nonaktif`}\n\n` +
      `_Pilih aksi di bawah:_`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...serverMgrKeyboard(a, filter, page) });
  }

  // ── Aksi pada 1 Server (Owner) ────────────────────────────────────
  if (data.startsWith("srv_do_")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const parts    = data.split("_"); // ["srv","do","<act>","<id>"]
    const act      = parts[2];
    const serverId = parts[3];
    const s        = getState(userId);
    const filter   = s.srv_filter || "all";
    const page     = s.srv_page   || 0;

    logger.action("SRV_MGR", `Owner:${userId} aksi="${act}" serverId=${serverId}`);

    const backBtn = Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali ke List", `srv_f_${filter}_${page}`)]]);

    if (act === "sus") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Menyuspend server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.suspendServer(serverId, srvOf(serverId, s));
      if (ok) {
        const rec = db.getPanelByServerId(serverId);
        if (rec) db.markPanelSuspended(rec.ownerUserId, serverId, true);
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil disuspend oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil <b>di-suspend!</b>`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal suspend server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    if (act === "uns") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Meng-unsuspend server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.unsuspendServer(serverId, srvOf(serverId, s));
      if (ok) {
        const rec = db.getPanelByServerId(serverId);
        if (rec) db.markPanelSuspended(rec.ownerUserId, serverId, false);
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil di-unsuspend oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil <b>di-unsuspend!</b>`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal unsuspend server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    if (act === "rei") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Reinstall server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.reinstallServer(serverId, srvOf(serverId, s));
      if (ok) {
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil di-reinstall oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil <b>di-reinstall!</b>\n\n_Tunggu beberapa menit hingga proses selesai._`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal reinstall server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    if (act === "del") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Menghapus server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.deleteServer(serverId, srvOf(serverId, s));
      if (ok) {
        const rec = db.getPanelByServerId(serverId);
        if (rec) db.deletePanelRecord(rec.ownerUserId, serverId);
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil dihapus oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("TRASH","🗑️")} Server \`${serverId}\` berhasil <b>dihapus!</b>`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal hapus server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    return ctx.answerCbQuery(`${tge("QUESTION","❓")} Aksi tidak dikenal.`);
  }

  // ── Manage Users ──────────────────────────────────────────────────
  if (data === "manage_users") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("USER","👤")} <b>Kelola User</b>\nPilih aksi:`, { parse_mode: "HTML", ...manageUsersKeyboard() });
  }

  if (["set_reseller","set_premium","set_owner","reset_role","blacklist_user","unblacklist_user","search_user"].includes(data)) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const stepMap = {
      set_reseller: "set_role", set_premium: "set_role", set_owner: "set_role",
      reset_role: "reset_role_id", blacklist_user: "blacklist_id",
      unblacklist_user: "unblacklist_id", search_user: "search_user_id",
    };
    const roleMap = { set_reseller: "reseller", set_premium: "premium", set_owner: "owner" };
    const promptMap = {
      set_role:       (s) => `Masukkan <b>Telegram ID</b> user untuk diberi role *${s.set_role}*:`,
      reset_role_id:  () => `Masukkan <b>Telegram ID</b> user yang ingin direset rolenya:`,
      blacklist_id:   () => `Masukkan <b>Telegram ID</b> user yang ingin di-blacklist:`,
      unblacklist_id: () => `Masukkan <b>Telegram ID</b> user yang ingin di-unblacklist:`,
      search_user_id: () => `Masukkan <b>Telegram ID</b> user yang ingin dicari:`,
    };
    const s = getState(userId);
    const step = stepMap[data];
    s.step = step;
    if (roleMap[data]) s.set_role = roleMap[data];
    return safeEdit(ctx, promptMap[step](s), { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "list_users") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const users = db.listAllUsers();
    const entries = Object.entries(users);
    if (!entries.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada user terdaftar.`, backKeyboard());
    let text = `${tge("USERS","👥")} <b>Daftar User:</b>\n\n`;
    entries.slice(0, 30).forEach(([uid, udata]) => {
      const bl = udata.blacklisted ? ` ${tge("PROHIBITED","🚫")}` : "";
      const lim = udata.reseller_limit ? ` ${tge("PACKAGE","📦")}${udata.reseller_limit.count}` : "";
      text += `• ID: \`${uid}\` — ${roleLabel(udata.role || "user")}${bl}${lim} — Panel: ${udata.panel_count || 0}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (data === "set_reseller_limit") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "set_limit_id";
    return safeEdit(ctx, `${tge("PACKAGE","📦")} Masukkan <b>Telegram ID</b> reseller yang ingin diset limitnya:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Statistik User (Owner) ─────────────────────────────────────────
  if (data === "user_stats_lookup") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "user_stats_id";
    return safeEdit(ctx, `${tge("CHART","📊")} Masukkan <b>Telegram ID</b> user yang ingin dilihat statistiknya:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Bulk Aksi Panel (Owner) ────────────────────────────────────────
  if (data === "bulk_action_pick") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "bulk_action_id";
    return safeEdit(ctx, `${tge("LIGHTNING","⚡")} <b>Bulk Aksi Panel</b>\n\nMasukkan <b>Telegram ID</b> user yang panelnya ingin dikelola secara bulk:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data.startsWith("bulk_sus_") || data.startsWith("bulk_uns_") || data.startsWith("bulk_del_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const actType = data.startsWith("bulk_sus_") ? "sus" : data.startsWith("bulk_uns_") ? "uns" : "del";
    const targetId = data.slice(actType === "sus" ? 9 : actType === "uns" ? 9 : 9);
    const panels = db.getUserPanels(targetId);
    if (!panels.length) return safeEdit(ctx, `${tge("ERROR","❌")} User \`${targetId}\` tidak punya panel.`, { parse_mode: "HTML", ...backKeyboard() });

    let done = 0;
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Memproses ${panels.length} panel...`, { parse_mode: "HTML" });

    for (const panel of panels) {
      try {
        if (actType === "sus") {
          const ok = await ptero.suspendServer(panel.server_id, psn(panel));
          if (ok) { db.markPanelSuspended(targetId, panel.server_id, true); done++; }
        } else if (actType === "uns") {
          const ok = await ptero.unsuspendServer(panel.server_id, psn(panel));
          if (ok) { db.markPanelSuspended(targetId, panel.server_id, false); done++; }
        } else {
          const ok = await ptero.deleteServer(panel.server_id, psn(panel));
          if (ok) { db.deletePanelRecord(targetId, panel.server_id); db.decrementPanelCount(targetId); done++; }
        }
      } catch {}
    }

    const actionWord = actType === "sus" ? "disuspend" : actType === "uns" ? "diunsuspend" : "dihapus";
    db.addAuditLog({ actorId: userId, action: `Bulk ${actType.toUpperCase()} Panel`, target: String(targetId), detail: `${done}/${panels.length} panel` });
    try {
      const userMsg = actType === "del"
        ? `${tge("TRASH","🗑️")} <b>Semua panel kamu telah dihapus oleh owner.</b>`
        : actType === "sus"
        ? `${tge("LOCK","🔒")} <b>Semua panel kamu telah disuspend oleh owner.</b>`
        : `${tge("UNLOCK","🔓")} <b>Semua panel kamu telah diunsuspend oleh owner.</b>`;
      await bot.telegram.sendMessage(targetId, userMsg, { parse_mode: "HTML" });
    } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} <b>Bulk Action Selesai!</b>\n\n${tge("USER","👤")} User: \`${targetId}\`\n${tge("LIGHTNING","⚡")} Aksi: *${actionWord}*\n${tge("SUCCESS","✅")} Berhasil: *${done}/${panels.length}* panel`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Voucher Menu ──────────────────────────────────────────────────
  if (data === "voucher_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("ADMISSION","🎟️")} <b>Kelola Voucher</b>\nPilih tipe voucher:`, { parse_mode: "HTML", ...voucherMenuKeyboard() });
  }

  if (data === "create_voucher") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("ADMISSION","🎟️")} Pilih role yang akan diberikan voucher:`, { parse_mode: "HTML", ...voucherRoleKeyboard() });
  }

  if (data === "create_discount_voucher") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "discount_pct";
    return safeEdit(ctx, `${tge("LABEL","🏷️")} <b>Voucher Diskon %</b>\n\nMasukkan besar diskon (1-100):\n_(contoh: 50 = diskon 50%)_`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "create_day_voucher") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "day_voucher_count";
    return safeEdit(ctx, `${tge("CALENDAR","📅")} <b>Voucher Hari Tambah</b>\n\nMasukkan jumlah hari yang ditambahkan:\n_(contoh: 30 = perpanjang 30 hari)_`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data.startsWith("vr_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const vRole = data.slice(3);
    const code = generateVoucherCode();
    db.createVoucher(code, vRole, userId);
    db.addAuditLog({ actorId: userId, action: "Buat Voucher Role", detail: `${vRole} | ${code}` });
    const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("STAR","⭐")}`, owner: `${tge("CROWN","👑")}` }[vRole] || `${tge("USER","👤")}`;
    return safeEdit(ctx,
      `${tge("SUCCESS","✅")} <b>Voucher Dibuat!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${emoji} Role: *${vRole}*\n\n/redeem ${code}`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  if (data === "list_vouchers") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const vouchers = db.getAllVouchers();
    const entries = Object.entries(vouchers);
    if (!entries.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada voucher.`, backKeyboard());
    let text = `${tge("ADMISSION","🎟️")} <b>Daftar Voucher:</b>\n\n`;
    entries.slice(0, 20).forEach(([code, v]) => {
      let typeLabel = "";
      if (v.type === "discount") typeLabel = `${tge("LABEL","🏷️")} Diskon ${v.discount}%`;
      else if (v.type === "days") typeLabel = `${tge("CALENDAR","📅")} +${v.days} Hari`;
      else { const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("STAR","⭐")}`, owner: `${tge("CROWN","👑")}` }[v.role] || `${tge("USER","👤")}`; typeLabel = `${emoji} ${v.role}`; }
      const status = v.used ? `${tge("SUCCESS","✅")} \`${v.used_by}\`` : `${tge("YELLOW_DOT","🟡")} Belum dipakai`;
      text += `• \`${code}\` — ${typeLabel} — ${status}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Redeem Voucher ────────────────────────────────────────────────
  if (data === "redeem_voucher") {
    const s = getState(userId);
    s.step = "redeem_code";
    return safeEdit(ctx, `${tge("ADMISSION","🎟️")} Masukkan <b>kode voucher</b> kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Plan Selection → Auto Create ──────────────────────────────────
  if (data.startsWith("plan_")) {
    const planIndex = parseInt(data.slice(5));
    const plan = config.RESOURCE_PLANS[planIndex];
    if (!plan) return safeEdit(ctx, `${tge("ERROR","❌")} Paket tidak ditemukan.`, cancelKeyboard());
    const s = getState(userId);
    s.plan_name = plan.name; s.ram = plan.ram; s.disk = plan.disk; s.cpu = plan.cpu;
    s.step = null;

    // Multi-node: tampilkan pilihan node jika diaktifkan
    if (config.MULTI_NODE_ENABLED) {
      const nodes = await ptero.getNodes(s.server_num || 1);
      if (nodes.length > 1) {
        s.step = "node_select";
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Paket *${plan.name}* dipilih.\n\n${tge("DESKTOP","🖥️")} <b>Pilih Node/Lokasi Server:</b>`, { parse_mode: "HTML", ...nodeSelectKeyboard(nodes) });
      }
    }
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat panel...</b>\n\nHarap tunggu, jangan tutup chat.`, { parse_mode: "HTML" });
    await executeCreatePanel(ctx, userId, role, s);
    return;
  }

  // ── Node Selection ────────────────────────────────────────────────
  if (data.startsWith("node_")) {
    const locationId = parseInt(data.slice(5));
    const s = getState(userId);
    if (!s.plan_name) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang dari menu.`, backKeyboard());
    s.location_id = locationId;
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat panel di node terpilih...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
    await executeCreatePanel(ctx, userId, role, s);
    return;
  }

  // ── Upgrade Resource ──────────────────────────────────────────────
  if (data === "upgrade_menu") {
    const myPanels = db.getUserPanels(userId);
    if (!myPanels.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Kamu belum punya panel.`, backKeyboard());
    return safeEdit(ctx, `${tge("ARROW_UP","⬆️")} <b>Upgrade Resource</b>\n\nPilih panel yang ingin di-upgrade:`, { parse_mode: "HTML", ...upgradeSelectKeyboard(myPanels) });
  }

  if (data.startsWith("upg_sel_")) {
    const upgServerId = data.slice(8);
    const myPanelsForUpg = db.getUserPanels(userId);
    const upgPanel = myPanelsForUpg.find(p => String(p.server_id) === upgServerId);
    if (!upgPanel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    if (upgPanel.expired || upgPanel.suspended) return safeEdit(ctx, `${tge("ERROR","❌")} Panel expired/suspended tidak bisa di-upgrade.`, backKeyboard());
    const s = getState(userId);
    s.step = "upg_plan";
    s.upgrade_server_id = upgServerId;
    return safeEdit(ctx,
      `${tge("ARROW_UP","⬆️")} <b>Upgrade Panel</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${upgPanel.name}\`\n${tge("PACKAGE","📦")} Paket saat ini: *${upgPanel.plan_name || "N/A"}*\n\nPilih paket baru:`,
      { parse_mode: "HTML", ...upgradePlanKeyboard() }
    );
  }

  if (data.startsWith("upg_plan_")) {
    const upgPlanIdx = parseInt(data.slice(9));
    const upgPlan = config.RESOURCE_PLANS[upgPlanIdx];
    const sUpg = getState(userId);
    if (!upgPlan || !sUpg.upgrade_server_id) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir.`, backKeyboard());
    const upgServerId2 = sUpg.upgrade_server_id;

    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Mengupgrade resource...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
    const upgOk = await ptero.updateServerBuild(upgServerId2, { memory: upgPlan.ram, disk: upgPlan.disk, cpu: upgPlan.cpu }, srvOf(upgServerId2, sUpg));
    clearState(userId);
    if (!upgOk) return ctx.reply(`${tge("ERROR","❌")} Gagal upgrade resource. Pastikan ID server valid.`, backKeyboard());
    db.updatePanelPlan(userId, upgServerId2, upgPlan.name);
    db.addAuditLog({ actorId: userId, action: "Upgrade Panel", target: upgServerId2, detail: upgPlan.name });
    const upgPs = planSummary(upgPlan);
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Panel Berhasil Di-upgrade!</b>\n\n${tge("ID_CARD","🆔")} Server ID: \`${upgServerId2}\`\n${tge("PACKAGE","📦")} Paket baru: *${upgPlan.name}*\n${tge("FLOPPY","💾")} RAM: ${upgPs.ram}\n${tge("DISK","💿")} Disk: ${upgPs.disk}\n${tge("GEAR","⚙️")} CPU: ${upgPs.cpu}`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Clone Panel ───────────────────────────────────────────────────
  if (data === "clone_menu") {
    const myPanelsCln = db.getUserPanels(userId);
    if (!myPanelsCln.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Kamu belum punya panel.`, backKeyboard());
    return safeEdit(ctx, `${tge("LIST","📋")} <b>Clone Panel</b>\n\nPilih panel yang ingin di-clone:`, { parse_mode: "HTML", ...cloneSelectKeyboard(myPanelsCln) });
  }

  if (data.startsWith("cln_sel_")) {
    const clnServerId = data.slice(8);
    const myPanelsCln2 = db.getUserPanels(userId);
    const clnPanel = myPanelsCln2.find(p => String(p.server_id) === clnServerId);
    if (!clnPanel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    const sClone = getState(userId);
    sClone.step = "clone_username";
    sClone.clone_source   = clnPanel;
    sClone.panel_type     = clnPanel.panel_type || "user";
    sClone.nest_name      = clnPanel.nest;
    sClone.egg_name       = clnPanel.egg;
    sClone.plan_name      = clnPanel.plan_name;
    const clnPlanObj = config.RESOURCE_PLANS.find(p => p.name === clnPanel.plan_name) || config.RESOURCE_PLANS[0];
    sClone.ram = clnPlanObj.ram; sClone.disk = clnPlanObj.disk; sClone.cpu = clnPlanObj.cpu;
    return safeEdit(ctx,
      `${tge("LIST","📋")} <b>Clone Panel</b>\n\n${tge("NAME_BADGE","📛")} Sumber: \`${clnPanel.name}\`\n${tge("PACKAGE","📦")} Paket: *${clnPanel.plan_name}*\n${tge("EGG","🥚")} Egg: ${clnPanel.egg}\n\nMasukkan <b>username baru</b> untuk panel clone:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  // ── Tiket Support ─────────────────────────────────────────────────
  if (data === "ticket_menu") {
    const myTickets = db.getUserTickets(userId);
    const openTktCount = myTickets.filter(t => t.status === "open").length;
    const tktRows = [];
    tktRows.push([Markup.button.callback("✍️ Buat Tiket Baru", "tkt_new")]);
    if (myTickets.length) tktRows.push([Markup.button.callback("📑 Lihat Tiket Saya", "tkt_list")]);
    tktRows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
    return safeEdit(ctx,
      `${tge("TICKET","🎫")} <b>Tiket Support</b>\n\n${openTktCount > 0 ? `${tge("GREEN_DOT","🟢")} Tiket terbuka: *${openTktCount}*` : `${tge("EMPTY_BOX","📭")} Tidak ada tiket terbuka.`}\n\nBuat tiket baru untuk minta bantuan owner:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(tktRows) }
    );
  }

  if (data === "tkt_new") {
    const sTkt = getState(userId);
    sTkt.step = "tkt_subject";
    return safeEdit(ctx, `${tge("TICKET","🎫")} <b>Buat Tiket Baru</b>\n\nMasukkan <b>judul/subjek</b> tiket kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "tkt_list") {
    const myTktList = db.getUserTickets(userId);
    if (!myTktList.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada tiket.`, backKeyboard());
    return safeEdit(ctx, `${tge("LIST","📋")} <b>Tiket Kamu:</b>`, { parse_mode: "HTML", ...ticketListKeyboard(myTktList, false) });
  }

  if (data.startsWith("tkt_view_")) {
    const tktShortId = data.slice(9);
    const myTkts = db.getUserTickets(userId);
    const viewTicket = myTkts.find(t => t.id.endsWith(tktShortId));
    if (!viewTicket) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
    let tktText = `${tge("TICKET","🎫")} *Tiket #${viewTicket.id.slice(-6)}*\n\n`;
    tktText += `${tge("PIN","📌")} Subjek: *${viewTicket.subject}*\n`;
    tktText += `${tge("BRIGHT","🔆")} Status: ${viewTicket.status === "open" ? `${tge("GREEN_DOT","🟢")} Terbuka` : `${tge("LOCK","🔒")} Ditutup`}\n\n`;
    tktText += `${tge("MEMO","📝")} <b>Pesan:</b>\n${viewTicket.message}\n`;
    if (viewTicket.replies && viewTicket.replies.length) {
      tktText += `\n${tge("SPEECH","💬")} <b>Balasan:</b>\n`;
      viewTicket.replies.slice(-5).forEach(r => {
        tktText += `${r.isOwner ? `${tge("CROWN","👑")} Owner` : `${tge("USER","👤")} Kamu`}: ${r.message}\n`;
      });
    }
    const tktBtns = [];
    if (viewTicket.status === "open") tktBtns.push([Markup.button.callback("💬 Balas", `tkt_rep_${tktShortId}`)]);
    tktBtns.push([Markup.button.callback("◀️ Kembali", "tkt_list")]);
    return safeEdit(ctx, tktText, { parse_mode: "HTML", ...Markup.inlineKeyboard(tktBtns) });
  }

  if (data.startsWith("tkt_rep_")) {
    const tktRepId = data.slice(8);
    const sTktRep = getState(userId);
    sTktRep.step = "tkt_reply";
    sTktRep.reply_ticket_id = tktRepId;
    return safeEdit(ctx, `${tge("SPEECH","💬")} Ketik balasan kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Kelola Tiket (Owner) ──────────────────────────────────────────
  if (data === "kelola_tkt") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const openTkts = db.getOpenTickets();
    if (!openTkts.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada tiket terbuka.`, { parse_mode: "HTML", ...backKeyboard() });
    return safeEdit(ctx, `${tge("TICKET","🎫")} *Tiket Terbuka (${openTkts.length}):*`, { parse_mode: "HTML", ...ticketListKeyboard(openTkts, true) });
  }

  if (data.startsWith("otkt_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const otktShortId = data.slice(5);
    if (otktShortId.startsWith("rep_") || otktShortId.startsWith("cls_")) {
      if (otktShortId.startsWith("rep_")) {
        const repId = otktShortId.slice(4);
        const sOtkt = getState(userId);
        sOtkt.step = "otkt_reply";
        sOtkt.reply_ticket_id = repId;
        return safeEdit(ctx, `${tge("SPEECH","💬")} Ketik balasan untuk user:`, { parse_mode: "HTML", ...cancelKeyboard() });
      }
      if (otktShortId.startsWith("cls_")) {
        const clsId = otktShortId.slice(4);
        const allTkts = db.getAllTickets(50);
        const clsTkt = allTkts.find(t => t.id.endsWith(clsId));
        if (!clsTkt) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
        db.closeTicket(clsTkt.id);
        try {
          await bot.telegram.sendMessage(clsTkt.userId,
            `${tge("LOCK","🔒")} *Tiket #${clsTkt.id.slice(-6)} Ditutup*\n\nSubjek: ${clsTkt.subject}\nTiket kamu telah ditutup oleh owner.`,
            { parse_mode: "HTML" }
          );
        } catch {}
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Tiket #${clsTkt.id.slice(-6)} ditutup.`, { parse_mode: "HTML", ...backKeyboard() });
      }
    }
    const allTkts2 = db.getAllTickets(50);
    const viewOTkt = allTkts2.find(t => t.id.endsWith(otktShortId));
    if (!viewOTkt) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
    let otktText = `${tge("TICKET","🎫")} *Tiket #${viewOTkt.id.slice(-6)}*\n\n`;
    otktText += `${tge("USER","👤")} User: \`${viewOTkt.userId}\`\n${tge("PIN","📌")} Subjek: *${viewOTkt.subject}*\n${tge("BRIGHT","🔆")} Status: ${viewOTkt.status === "open" ? `${tge("GREEN_DOT","🟢")} Terbuka` : `${tge("LOCK","🔒")} Ditutup`}\n\n`;
    otktText += `${tge("MEMO","📝")} <b>Pesan:</b>\n${viewOTkt.message}`;
    if (viewOTkt.replies && viewOTkt.replies.length) {
      otktText += `\n\n${tge("SPEECH","💬")} <b>Balasan:</b>\n`;
      viewOTkt.replies.slice(-5).forEach(r => {
        otktText += `${r.isOwner ? `${tge("CROWN","👑")} Owner` : `${tge("USER","👤")} User`}: ${r.message}\n`;
      });
    }
    const otktBtns = [];
    if (viewOTkt.status === "open") {
      otktBtns.push([
        Markup.button.callback("💬 Balas", `otkt_rep_${otktShortId}`),
        Markup.button.callback("🔐 Tutup", `otkt_cls_${otktShortId}`),
      ]);
    }
    otktBtns.push([Markup.button.callback("◀️ Kembali", "kelola_tkt")]);
    return safeEdit(ctx, otktText, { parse_mode: "HTML", ...Markup.inlineKeyboard(otktBtns) });
  }

  if (data.startsWith("otkt_rep_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const repId2 = data.slice(9);
    const sOtkt2 = getState(userId);
    sOtkt2.step = "otkt_reply";
    sOtkt2.reply_ticket_id = repId2;
    return safeEdit(ctx, `${tge("SPEECH","💬")} Ketik balasan untuk user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data.startsWith("otkt_cls_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const clsId2 = data.slice(9);
    const allTkts3 = db.getAllTickets(50);
    const clsTkt2 = allTkts3.find(t => t.id.endsWith(clsId2));
    if (!clsTkt2) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
    db.closeTicket(clsTkt2.id);
    try {
      await bot.telegram.sendMessage(clsTkt2.userId,
        `${tge("LOCK","🔒")} *Tiket #${clsTkt2.id.slice(-6)} Ditutup*\n\nSubjek: ${clsTkt2.subject}\nTiket kamu telah ditutup oleh owner.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return safeEdit(ctx, `${tge("SUCCESS","✅")} Tiket ditutup.`, { parse_mode: "HTML", ...backKeyboard() });
  }


  // ── Cek Resource Manual (Owner) ───────────────────────────────────
  if (data === "check_resource") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("SEARCH","🔍")} <b>Mengecek resource semua panel aktif...</b>`, { parse_mode: "HTML" });

    const allPanels = db.getAllPanels(); // returns [{ ...panelFields, userId }]
    const active = allPanels.filter(p => p.server_identifier && !p.expired && !p.suspended);

    if (!active.length) {
      return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada panel aktif yang bisa dicek.`, { parse_mode: "HTML", ...backKeyboard() });
    }

    const cpuLimit   = config.RESOURCE_CPU_LIMIT     || 0;
    const ramLimitMB = config.RESOURCE_RAM_LIMIT_MB  || 0;
    const diskLimitMB= config.RESOURCE_DISK_LIMIT_MB || 0;

    let lines = [];
    let overCount = 0;
    for (const panel of active) {
      try {
        const stats = await ptero.getServerResources(panel.server_identifier, psn(panel));
        if (!stats) { lines.push(`${tge("WARNING","⚠️")} \`${panel.name || panel.server_id}\` — gagal ambil data`); continue; }
        const rss = stats.resources || {};
        const cpuPct   = rss.cpu_absolute || 0;
        const ramMB    = Math.round((rss.memory_bytes || 0) / 1024 / 1024);
        const diskMB   = Math.round((rss.disk_bytes   || 0) / 1024 / 1024);
        const cpuOver  = cpuLimit   > 0 && cpuPct  >= cpuLimit;
        const ramOver  = ramLimitMB > 0 && ramMB   >= ramLimitMB;
        const diskOver = diskLimitMB> 0 && diskMB  >= diskLimitMB;
        const isOver   = cpuOver || ramOver || diskOver;
        if (isOver) overCount++;
        const icon = isOver ? `${tge("RED_DOT","🔴")}` : (stats.current_state === "running" ? `${tge("GREEN_DOT","🟢")}` : `${tge("YELLOW_DOT","🟡")}`);
        lines.push(
          `${icon} *${(panel.name || "N/A").slice(0, 20)}* (\`${panel.userId}\`)\n` +
          `  ${tge("GEAR","⚙️")} CPU: ${cpuPct.toFixed(1)}%${cpuOver ? ` ${tge("RED_DOT","🔴")}` : ""}  ${tge("FLOPPY","💾")} RAM: ${ramMB}MB${ramOver ? ` ${tge("RED_DOT","🔴")}` : ""}  ${tge("DISK","💿")} Disk: ${diskMB}MB${diskOver ? ` ${tge("RED_DOT","🔴")}` : ""}`
        );
      } catch {
        lines.push(`${tge("WARNING","⚠️")} \`${panel.name || panel.server_id}\` — error`);
      }
    }

    const chunks = [];
    let chunk = `${tge("CHART","📊")} *Ringkasan Resource Panel (${active.length} aktif, ${overCount} over-limit)*\n\n`;
    for (const line of lines) {
      if ((chunk + line + "\n").length > 3800) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += line + "\n\n";
    }
    chunks.push(chunk);

    for (let i = 0; i < chunks.length; i++) {
      if (i === chunks.length - 1) {
        await ctx.reply(chunks[i], { parse_mode: "HTML", ...backKeyboard() });
      } else {
        await ctx.reply(chunks[i], { parse_mode: "HTML" });
      }
    }

    // Kirim notifikasi ke semua owner + grup jika ada panel yang melebihi batas
    if (overCount > 0) {
      const notifMsg =
        `${tge("WARNING","⚠️")} <b>Laporan Over-Resource (Cek Manual)</b>\n\n` +
        `${tge("CHART","📊")} Ditemukan <b>${overCount} panel</b> melebihi batas resource dari total ${active.length} panel aktif.\n\n` +
        `${tge("GEAR","⚙️")} Batas: CPU ${cpuLimit}% | RAM ${ramLimitMB} MB | Disk ${diskLimitMB} MB\n` +
        `${tge("CLOCK_FACE","🕐")} ${new Date().toLocaleString("id-ID")}`;

      if (config.GROUP_ID) {
        try { await bot.telegram.sendMessage(config.GROUP_ID, notifMsg, { parse_mode: "HTML" }); } catch {}
      }
      const ownerSet = new Set([
        ...config.OWNER_IDS.map(String),
        ...Object.entries(db.listAllUsers()).filter(([, u]) => u.role === "owner").map(([uid]) => uid),
      ]);
      for (const ownerId of ownerSet) {
        if (String(ownerId) === String(userId)) continue; // sudah dapat laporan lengkap di atas
        try { await bot.telegram.sendMessage(ownerId, notifMsg, { parse_mode: "HTML" }); } catch {}
      }
    }
    return;
  }

  // ── Status VPS (Owner) ────────────────────────────────────────────
  if (data === "vps_status" || data === "vps_refresh") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Mengambil data VPS...</b>`, { parse_mode: "HTML" });
    try {
      const text = await buildVpsText();
      await safeEdit(ctx, text, { parse_mode: "HTML", ...vpsStatusKeyboard() });
    } catch (e) {
      await safeEdit(ctx, `${tge("ERROR","❌")} Gagal ambil info VPS: ${e.message}`, backKeyboard());
    }
    return;
  }

  // ── Leaderboard Referral ──────────────────────────────────────────
  if (data === "referral_leaderboard") {
    const lb = db.getReferralLeaderboard(10);
    if (!lb.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada data referral.`, backKeyboard());
    let text = `${tge("TROPHY","🏆")} <b>Leaderboard Referral Top 10</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    lb.forEach((e, i) => {
      const medal = i === 0 ? `${tge("MEDAL_GOLD","🥇")}` : i === 1 ? `${tge("MEDAL_SILVER","🥈")}` : i === 2 ? `${tge("MEDAL_BRONZE","🥉")}` : `${i+1}.`;
      text += `${medal} ID \`${e.userId}\` — *${e.count} referral*\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Poin Saya ─────────────────────────────────────────────────────
  if (data === "my_points") {
    const pts     = db.getPoints(userId);
    const rate    = config.POINT_EXCHANGE_RATE || 50;
    const rewards = config.POINT_REWARDS || {};
    const text =
      `${tge("GAMEPAD","🎮")} <b>Poin Saya</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${tge("STAR","⭐")} Poin Kamu: *${pts} poin*\n` +
      `${tge("REFRESH","🔄")} Nilai Tukar: *${rate} poin = 1 hari panel*\n` +
      `${tge("BULB","💡")} Bisa ditukar: *${Math.floor(pts / rate)} hari*\n\n` +
      `${tge("PIN","📌")} <b>Cara Mendapat Poin:</b>\n` +
      `• Buat panel: +${rewards.create_panel || 5} poin\n` +
      `• Perpanjang panel: +${rewards.extend_panel || 2} poin\n` +
      `• Referral berhasil: +${rewards.referral || 15} poin\n` +
      `• Redeem voucher: +${rewards.redeem_voucher || 3} poin\n` +
      `• Login harian: +${rewards.daily_login || 1} poin`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...pointsMenuKeyboard(pts, rate) });
  }

  if (data === "points_exchange") {
    const rate = config.POINT_EXCHANGE_RATE || 50;
    const pts  = db.getPoints(userId);
    if (pts < rate) {
      return safeEdit(ctx, `${tge("ERROR","❌")} Poin tidak cukup!\n\nKamu punya *${pts} poin*, butuh *${rate} poin* untuk 1 hari.\nTerus aktif untuk kumpulkan poin!`, { parse_mode: "HTML", ...backKeyboard() });
    }
    const panels = db.getUserPanels(userId).filter(p => !p.expired && !p.suspended);
    if (!panels.length) return safeEdit(ctx, `${tge("ERROR","❌")} Tidak ada panel aktif untuk diperpanjang.`, backKeyboard());
    const ok = db.spendPoints(userId, rate);
    if (!ok) return safeEdit(ctx, `${tge("ERROR","❌")} Gagal tukar poin.`, backKeyboard());
    // Tambah ke pending days
    const cur = db.getPendingDays(userId);
    db.setPendingDays(userId, cur + 1);
    db.addTransaction(userId, { type: "Tukar Poin", detail: `${rate} poin → +1 hari pending` });
    db.addAuditLog({ actorId: userId, action: "Tukar Poin", detail: `${rate} poin → 1 hari pending` });
    return safeEdit(ctx, `${tge("SUCCESS","✅")} <b>Berhasil Tukar Poin!</b>\n\n${tge("GAMEPAD","🎮")} ${rate} poin dikurangi\n${tge("CALENDAR","📅")} +1 hari ditambah ke Pending Days\n${tge("STAR","⭐")} Sisa poin: *${pts - rate}*\n\nGunakan menu Perpanjang Panel untuk pakai hari bonus.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (data === "points_leaderboard") {
    const lb = db.getPointsLeaderboard(10);
    if (!lb.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada data poin.`, backKeyboard());
    let text = `${tge("TROPHY","🏆")} <b>Leaderboard Poin Top 10</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    lb.forEach((e, i) => {
      const medal = i === 0 ? `${tge("MEDAL_GOLD","🥇")}` : i === 1 ? `${tge("MEDAL_SILVER","🥈")}` : i === 2 ? `${tge("MEDAL_BRONZE","🥉")}` : `${i+1}.`;
      text += `${medal} ID \`${e.userId}\` — *${e.points} poin*\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Template Panel ────────────────────────────────────────────────
  if (data === "template_menu") {
    const templates = db.getTemplates();
    if (!templates.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada template panel.\n\nOwner bisa tambah template melalui menu Admin → Kelola Template.`, backKeyboard());
    let text = `${tge("LIST","📋")} <b>Template Panel</b>\nPilih template untuk mulai buat panel dengan konfigurasi preset:\n\n`;
    templates.forEach((t, i) => {
      text += `*${i+1}. ${t.name}*\n   ${tge("EGG","🥚")} Egg: ${t.egg_name || "?"} | ${tge("PACKAGE","📦")} Plan: ${t.plan_name || "?"}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...templatesKeyboard(templates) });
  }

  if (data.startsWith("use_tpl_")) {
    const tplName = data.slice(8);
    const templates = db.getTemplates();
    const tpl = templates.find(t => t.name.slice(0,20) === tplName);
    if (!tpl) return safeEdit(ctx, `${tge("ERROR","❌")} Template tidak ditemukan.`, backKeyboard());
    const s = getState(userId);
    s.template      = tpl;
    s.nest_id       = tpl.nest_id;
    s.egg_id        = tpl.egg_id;
    s.plan          = config.RESOURCE_PLANS[tpl.plan_index] || config.RESOURCE_PLANS[0];
    s.step          = "panel_username";
    s.panel_type    = tpl.panel_type || "normal";
    s.isTemplate    = true;
    return safeEdit(ctx,
      `${tge("LIST","📋")} *Template: ${tpl.name}*\n\n${tge("EGG","🥚")} Egg: ${tpl.egg_name || "?"}\n${tge("PACKAGE","📦")} Plan: ${tpl.plan_name || "?"}\n\nMasukkan <b>username</b> untuk panel baru kamu:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (data === "create_panel_fresh") {
    clearState(userId);
    // Trigger ulang create_panel flow manual
    ctx.callbackQuery.data = "create_panel";
    return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: "create_panel" } });
  }

  // ── Simpan Template setelah buat panel ───────────────────────────
  if (data.startsWith("save_tpl_") && !data.startsWith("save_tpl_name")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const s2 = getState(userId);
    if (!s2.pending_tpl_payload) return safeEdit(ctx, `${tge("ERROR","❌")} Data template tidak ditemukan. Coba buat panel lagi.`, backKeyboard());
    s2.step = "save_tpl_name_input";
    return safeEdit(ctx, `${tge("FLOPPY","💾")} <b>Simpan sebagai Template</b>\n\nMasukkan nama untuk template ini:\n(contoh: "Minecraft 4GB", "NodeJS Small")`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Kelola Template (Owner) ───────────────────────────────────────
  if (data === "manage_templates") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const templates = db.getTemplates();
    let text = `${tge("LIST","📋")} <b>Kelola Template Panel</b>\n\nTotal template: *${templates.length}*\n\n`;
    if (templates.length) {
      templates.forEach((t, i) => {
        text += `*${i+1}. ${t.name}*\n   ${tge("EGG","🥚")} ${t.egg_name || "?"} | ${tge("PACKAGE","📦")} ${t.plan_name || "?"}\n`;
      });
    } else {
      text += "_Belum ada template. Buat panel dulu lalu simpan sebagai template._";
    }
    const kb = templates.length
      ? manageTemplatesKeyboard(templates)
      : backKeyboard();
    return safeEdit(ctx, text, { parse_mode: "HTML", ...kb });
  }

  if (data.startsWith("del_tpl_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const tplName = data.slice(8);
    const templates = db.getTemplates();
    const tpl = templates.find(t => t.name.slice(0,20) === tplName);
    if (!tpl) return safeEdit(ctx, `${tge("ERROR","❌")} Template tidak ditemukan.`, backKeyboard());
    db.deleteTemplate(tpl.name);
    db.addAuditLog({ actorId: userId, action: "Hapus Template", detail: tpl.name });
    return safeEdit(ctx, `${tge("SUCCESS","✅")} Template *${tpl.name}* berhasil dihapus.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Whitelist Mode (Owner) ────────────────────────────────────────
  if (data === "whitelist_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const wlEnabled = db.getWhitelistMode();
    const users = db.getWhitelistUsers();
    return safeEdit(ctx,
      `${tge("LOCK","🔒")} <b>Whitelist Mode</b>\n\nStatus: ${wlEnabled ? `${tge("GREEN_DOT","🟢")} <b>AKTIF</b>` : `${tge("RED_DOT","🔴")} <b>NONAKTIF</b>`}\nUser di-whitelist: *${users.length}*\n\n${wlEnabled ? `${tge("WARNING","⚠️")} Hanya user yang di-whitelist yang bisa pakai bot.` : `${tge("INFO","ℹ️")} Semua user bisa pakai bot (whitelist off).`}`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [Markup.button.callback(wlEnabled ? `${TOFF()} Nonaktifkan Whitelist` : `${TON()} Aktifkan Whitelist`, "wl_toggle")],
        [Markup.button.callback("➕ Tambah ke Whitelist", "wl_add"), Markup.button.callback("➖ Hapus dari Whitelist", "wl_remove")],
        [Markup.button.callback("📑 Daftar Whitelist", "wl_list")],
        [Markup.button.callback("◀️ Kembali", "back_main")],
      ]) }
    );
  }

  if (data === "wl_toggle") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const cur = db.getWhitelistMode();
    db.setWhitelistMode(!cur);
    db.addAuditLog({ actorId: userId, action: `Whitelist Mode ${!cur ? "ON" : "OFF"}` });
    const _ton = tge("TOGGLE_ON","🟢"); const _toff = tge("TOGGLE_OFF","🔴");
    const _ok = tge("SUCCESS","✅");
    return safeEdit(ctx,
      `${_ok} Whitelist Mode sekarang: ${!cur ? `${_ton} <b>AKTIF</b>` : `${_toff} <b>NONAKTIF</b>`}`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  if (data === "wl_add") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "wl_add_id";
    return safeEdit(ctx, `${tge("PLUS","➕")} Masukkan <b>Telegram ID</b> user yang ingin ditambah ke whitelist:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "wl_remove") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "wl_remove_id";
    return safeEdit(ctx, `${tge("MINUS","➖")} Masukkan <b>Telegram ID</b> user yang ingin dihapus dari whitelist:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "wl_list") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const users = db.getWhitelistUsers();
    if (!users.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Whitelist kosong.`, backKeyboard());
    const text = `${tge("LIST","📋")} *Daftar Whitelist (${users.length} user)*\n\n` + users.map((u, i) => `${i+1}. \`${u}\``).join("\n");
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Export Data (Owner) ───────────────────────────────────────────
  if (data === "export_data_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("OUTBOX","📤")} <b>Export Data</b>\nPilih data yang ingin diekspor:`, { parse_mode: "HTML", ...exportDataKeyboard() });
  }

  if (data === "export_users") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat file CSV...`, { parse_mode: "HTML" });
    const users = db.listAllUsers();
    let csv = "UserID,Role,PanelCount,Points,Blacklisted,ReferralCount\n";
    for (const [uid, u] of Object.entries(users)) {
      csv += `${uid},${u.role || "user"},${u.panel_count || 0},${db.getPoints(uid)},${u.blacklisted ? "Ya" : "Tidak"},${(u.referrals || []).length}\n`;
    }
    const fpath = path.join(os.tmpdir(), `users_export_${Date.now()}.csv`);
    fs.writeFileSync(fpath, csv);
    try {
      await ctx.telegram.sendDocument(userId, { source: fs.createReadStream(fpath), filename: `users_${new Date().toISOString().slice(0,10)}.csv` }, { caption: `${tge("USERS","👥")} Export User\nTotal: ${Object.keys(users).length} user` });
    } finally { try { fs.unlinkSync(fpath); } catch {} }
    return ctx.reply(`${tge("SUCCESS","✅")} File export sudah dikirim!`, backKeyboard());
  }

  if (data === "export_panels") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat file CSV...`, { parse_mode: "HTML" });
    const panels = db.getAllPanels();
    let csv = "UserID,ServerID,Identifier,Name,PlanName,Egg,Status,ExpireDate,CreatedAt\n";
    for (const p of panels) {
      const status = p.suspended ? "Suspended" : p.expired ? "Expired" : "Active";
      csv += `${p.userId},${p.server_id || ""},${p.server_identifier || ""},${(p.name || "").replace(/,/g, ";")},${p.plan_name || ""},${p.egg || ""},${status},${p.expire_date || ""},${p.created_at || ""}\n`;
    }
    const fpath = path.join(os.tmpdir(), `panels_export_${Date.now()}.csv`);
    fs.writeFileSync(fpath, csv);
    try {
      await ctx.telegram.sendDocument(userId, { source: fs.createReadStream(fpath), filename: `panels_${new Date().toISOString().slice(0,10)}.csv` }, { caption: `${tge("DESKTOP","🖥️")} Export Panel\nTotal: ${panels.length} panel` });
    } finally { try { fs.unlinkSync(fpath); } catch {} }
    return ctx.reply(`${tge("SUCCESS","✅")} File export sudah dikirim!`, backKeyboard());
  }

  if (data === "export_transactions") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat file CSV...`, { parse_mode: "HTML" });
    const txs = db.getAllTransactions(500);
    let csv = "UserID,Tipe,Detail,Waktu\n";
    for (const t of txs) {
      csv += `${t.userId},"${(t.type || "").replace(/"/g, "'")}","${(t.detail || "").replace(/"/g, "'")}",${t.at || ""}\n`;
    }
    const fpath = path.join(os.tmpdir(), `transactions_export_${Date.now()}.csv`);
    fs.writeFileSync(fpath, csv);
    try {
      await ctx.telegram.sendDocument(userId, { source: fs.createReadStream(fpath), filename: `transactions_${new Date().toISOString().slice(0,10)}.csv` }, { caption: `${tge("SCROLL","📜")} Export Transaksi\nTotal: ${txs.length} transaksi` });
    } finally { try { fs.unlinkSync(fpath); } catch {} }
    return ctx.reply(`${tge("SUCCESS","✅")} File export sudah dikirim!`, backKeyboard());
  }

  // ── Jadwal Maintenance (Owner) ────────────────────────────────────
  if (data === "scheduled_maint_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const sm = db.getScheduledMaintenance();
    return safeEdit(ctx,
      `${tge("ALARM","⏰")} <b>Jadwal Maintenance Otomatis</b>\n\nStatus: ${sm.enabled ? `${tge("GREEN_DOT","🟢")} <b>AKTIF</b>` : `${tge("RED_DOT","🔴")} <b>NONAKTIF</b>`}\nWaktu: *${sm.start} – ${sm.end}* WIB\nHari: ${sm.days && sm.days.length ? sm.days.join(", ") : "Setiap hari"}\n\nPesan:\n_"${sm.message}"_`,
      { parse_mode: "HTML", ...scheduledMaintKeyboard(sm) }
    );
  }

  if (data === "schm_toggle") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const sm = db.getScheduledMaintenance();
    db.setScheduledMaintenance({ enabled: !sm.enabled });
    db.addAuditLog({ actorId: userId, action: `Jadwal Maintenance ${!sm.enabled ? "ON" : "OFF"}` });
    const _ton = tge("TOGGLE_ON","🟢"); const _toff = tge("TOGGLE_OFF","🔴");
    const _ok = tge("SUCCESS","✅");
    return safeEdit(ctx,
      `${_ok} Jadwal Maintenance: ${!sm.enabled ? `${_ton} <b>AKTIF</b>` : `${_toff} <b>NONAKTIF</b>`}`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  if (data === "schm_set_time") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "schm_time_input";
    return safeEdit(ctx, `${tge("ALARM","⏰")} Masukkan waktu mulai dan selesai maintenance dalam format:\n\n<code>HH:MM-HH:MM</code>\n\nContoh: <code>02:00-04:00</code>`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "schm_set_msg") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "schm_msg_input";
    return safeEdit(ctx, `${tge("SPEECH","💬")} Masukkan pesan yang akan ditampilkan saat maintenance terjadwal aktif:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Cari Panel (Owner) ────────────────────────────────────────────
  if (data === "search_panel") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "search_panel_query";
    return safeEdit(ctx, `${tge("SEARCH","🔎")} <b>Cari Panel</b>\n\nMasukkan nama panel, Server ID, atau Telegram ID user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Nest Selection ────────────────────────────────────────────────
  if (data.startsWith("nest_")) {
    const nestId = parseInt(data.slice(5));
    const s = getState(userId);
    if (!s.username) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang dari menu.`, backKeyboard());
    const nest = (s.nests || []).find(n => n.attributes.id === nestId);
    if (!nest) return safeEdit(ctx, `${tge("ERROR","❌")} Nest tidak ditemukan.`, cancelKeyboard());
    s.nest_id = nestId;
    s.nest_name = nest.attributes.name;
    s.step = "egg";
    const eggs = await ptero.getEggs(nestId, s.server_num || 1);
    if (!eggs.length) return safeEdit(ctx, `${tge("ERROR","❌")} Tidak ada Egg di Nest ini.`, cancelKeyboard());
    s.eggs = eggs;
    return safeEdit(ctx, `${tge("EGG","🥚")} <b>Pilih Egg</b>\n\nNest: *${s.nest_name}*\nPilih jenis server:`, { parse_mode: "HTML", ...eggsKeyboard(eggs, role) });
  }

  // ── Egg Selection ─────────────────────────────────────────────────
  // ── Konfirmasi buat panel dari Template ──────────────────────────
  if (data === "do_create_panel") {
    const s = getState(userId);
    if (!s.username || !s.egg_id) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang.`, backKeyboard());
    s.plan_name = s.plan?.name || (config.RESOURCE_PLANS[s.plan_index] || config.RESOURCE_PLANS[0]).name;
    s.ram  = s.plan?.ram  || (config.RESOURCE_PLANS[0]).ram;
    s.disk = s.plan?.disk || (config.RESOURCE_PLANS[0]).disk;
    s.cpu  = s.plan?.cpu  || (config.RESOURCE_PLANS[0]).cpu;
    s.environment = s.env || {};
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat panel dari template...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
    await executeCreatePanel(ctx, userId, role, s, false);
    return;
  }

  if (data.startsWith("egg_")) {
    const eggId = parseInt(data.slice(4));
    const s = getState(userId);
    if (!s.username) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang dari menu.`, backKeyboard());
    const egg = (s.eggs || []).find(e => e.attributes.id === eggId);
    if (!egg) return safeEdit(ctx, `${tge("ERROR","❌")} Egg tidak ditemukan.`, cancelKeyboard());
    s.egg_id = eggId;
    s.egg_name = egg.attributes.name;
    s.docker_image = egg.attributes.docker_image;
    s.startup = egg.attributes.startup;
    s.environment = buildEnvFromEgg(egg);
    s.step = "plan";

    if (s.is_trial) {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat trial panel...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
      await executeCreatePanel(ctx, userId, role, s, true);
      return;
    }

    return safeEdit(ctx, `${tge("SUCCESS","✅")} Egg dipilih: *${s.egg_name}*\n\n${tge("PACKAGE","📦")} <b>Pilih Paket Resource:</b>`, { parse_mode: "HTML", ...plansKeyboard() });
  }
  } catch (err) {
    botLog("ERROR", "CALLBACK", `User:${userId} | Action:${data}`, err);
    try { await ctx.reply(`${tge("ERROR","❌")} Terjadi kesalahan internal. Silakan coba lagi atau hubungi owner.`); } catch {}
  }
});

// ─── Eksekusi Buat Panel ──────────────────────────────────────────────────────

async function executeCreatePanel(ctx, userId, role, s, isTrial = false) {
  const isAdmin = s.panel_type === "admin";
  logger.event("CREATE_PANEL", `User:${userId} role=${role} egg="${s.egg_name}" plan="${s.plan_name}" trial=${isTrial} admin=${isAdmin}`);
  const _srv = s.server_num || (allowedServers(db.getRole(userId))[0] || 1);
  let pteroUser = await ptero.getUserByEmail(s.email, _srv);
  if (!pteroUser) {
    pteroUser = await ptero.createUser({
      username: s.username, email: s.email,
      firstName: s.username, lastName: "User",
      password: s.password, isAdmin,
    }, _srv);
  } else if (isAdmin) {
    await ptero.updateUserToAdmin(pteroUser.id, true, _srv);
  }

  if (!pteroUser) {
    clearState(userId);
    return ctx.reply(`${tge("ERROR","❌")} Gagal membuat akun di panel.`, mainMenuKeyboard(role));
  }

  const locations = await ptero.getLocations(_srv);
  if (!locations.length) {
    clearState(userId);
    return ctx.reply(`${tge("ERROR","❌")} Tidak ada lokasi tersedia di panel.`, mainMenuKeyboard(role));
  }
  const locationId = s.location_id || locations[0].attributes.id;

  const server = await ptero.createServer({
    name: `Panel-${s.username}`,
    userId: pteroUser.id, eggId: s.egg_id,
    dockerImage: s.docker_image, startup: s.startup,
    environment: s.environment,
    ram: s.ram, disk: s.disk, cpu: s.cpu, locationId,
  }, _srv);

  if (!server) {
    clearState(userId);
    return ctx.reply(`${tge("ERROR","❌")} Gagal membuat server. Cek node, location, dan egg di panel.`, mainMenuKeyboard(role));
  }

  db.incrementPanelCount(userId);
  db.incrementDailyCount(userId);
  if (role === "reseller") {
    db.decrementResellerLimit(userId);
  }

  // Bonus hari referral
  const bonusDays = db.getReferralBonus(userId);
  const expireDays = config.PANEL_EXPIRE_DAYS + (bonusDays > 0 && !isTrial ? bonusDays : 0);
  if (bonusDays > 0 && !isTrial) db.consumeReferralBonus(userId);

  db.addPanelRecord(userId, {
    name: server.name, server_id: server.id,
    server_identifier: server.identifier,
    username: s.username, email: s.email,
    panel_type: s.panel_type, plan_name: s.plan_name,
    nest: s.nest_name, egg: s.egg_name, is_trial: isTrial,
    server_num: _srv,
  }, isTrial ? config.TRIAL_HOURS : expireDays * 24);

  // Update description server di Pterodactyl dengan tanggal masa aktif
  const savedPanel = db.getUserPanels(userId).find(p => String(p.server_id) === String(server.id));
  if (savedPanel) {
    const expStr = formatDate(savedPanel.expire_date);
    const typeStr = isTrial ? "Trial" : (s.plan_name || "Standard");
    ptero.updateServerDescription(server.id, `Aktif hingga: ${expStr} | Paket: ${typeStr}`, _srv).catch(() => {});
  }

  if (isTrial) db.markTrialUsed(userId);

  db.addTransaction(userId, {
    type: isTrial ? "Trial Panel" : "Buat Panel",
    detail: `${server.name} | ID:${server.id} | ${s.plan_name}`,
  });

  db.addAuditLog({ actorId: userId, action: isTrial ? "Trial Panel" : "Buat Panel", target: String(server.id), detail: s.plan_name });

  // Reward poin buat panel
  if (!isTrial) {
    const pts = (config.POINT_REWARDS || {}).create_panel || 5;
    if (pts > 0) db.addPoints(userId, pts);
  }

  const panelTypeLabel = isAdmin ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`;
  const ps = planSummary({ ram: s.ram, disk: s.disk, cpu: s.cpu });

  let expDateStr;
  if (isTrial) {
    expDateStr = formatDate(new Date(Date.now() + config.TRIAL_HOURS * 60 * 60 * 1000).toISOString());
  } else {
    expDateStr = formatDate(new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000).toISOString());
  }

  // ── Kirim data lengkap ke PRIVATE CHAT user terlebih dahulu ──────────────
  const privateMsg =
    `${tge("SUCCESS","✅")} <b>Panel Berhasil Dibuat!</b>\n\n` +
    (isTrial ? `${tge("ALARM","⏰")} *TRIAL PANEL — ${config.TRIAL_HOURS} JAM*\n\n` : "") +
    `${tge("MASK","🎭")} Tipe: ${panelTypeLabel}\n` +
    `${tge("ID_CARD","🆔")} Server ID: \`${server.id}\`\n` +
    `${tge("NAME_BADGE","📛")} Nama Server: \`${server.name}\`\n` +
    `${tge("PACKAGE","📦")} Paket: *${s.plan_name}*\n` +
    `${tge("CARD_INDEX","🗂️")} Nest: \`${s.nest_name}\`\n` +
    `${tge("EGG","🥚")} Egg: \`${s.egg_name}\`\n` +
    `${tge("FLOPPY","💾")} RAM: ${ps.ram}  •  ${tge("DISK","💿")} Disk: ${ps.disk}  •  ${tge("GEAR","⚙️")} CPU: ${ps.cpu}\n` +
    `${tge("BRAIN","🧠")} OOM Killer: <b>Aktif</b> ${tge("SUCCESS","✅")}\n` +
    `${tge("CALENDAR","📅")} Expired: *${expDateStr}*` +
    (!isTrial && bonusDays > 0 ? ` _(+${bonusDays} hari bonus referral!)_` : "") + `\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `${tge("GLOBE","🌐")} <b>Login Panel:</b>\n` +
    `URL: ${serverUrl(_srv)}\n` +
    `${tge("DESKTOP","🖥️")} Server: <b>${he2(serverLabel(_srv))}</b>\n` +
    `${tge("EMAIL","📧")} Email: \`${s.email}\`\n` +
    `${tge("KEY","🔑")} Password: \`${s.password}\`\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `${tge("WARNING","⚠️")} Simpan info ini! Password tidak bisa dilihat lagi.`;

  let sentToPrivate = false;
  try {
    await bot.telegram.sendMessage(userId, privateMsg, { parse_mode: "HTML" });
    sentToPrivate = true;
  } catch (err) {
    botLog("WARN", "NOTIFY", `Gagal kirim pesan ke user ${userId}`, err);
  }

  // ── Notifikasi ke semua Owner (private, dengan kredensial lengkap) ────────
  notifyOwners({ creatorId: userId, creatorFrom: ctx.from, server, panelTypeLabel, s })
    .catch(err => botLog("WARN", "NOTIFY_OWNERS", "Gagal kirim notif ke owners", err));

  // ── Notifikasi ke Grup (tanpa kredensial, hanya info panel) ──────────────
  notifyGroup({ creatorFrom: ctx.from, server, panelTypeLabel, s })
    .catch(err => botLog("WARN", "NOTIFY_GROUP", "Gagal kirim notif ke grup", err));

  // Simpan info pesan prompt sebelum clearState agar bisa dihapus
  const promptMsgId  = s.prompt_msg_id;
  const promptChatId = s.prompt_chat_id;

  clearState(userId);

  // Hapus pesan "Masukkan username" yang masih muncul di chat setelah selesai
  if (promptMsgId && promptChatId) {
    try { await ctx.telegram.deleteMessage(promptChatId, promptMsgId); } catch {}
  }

  // ── Pesan ringkas di chat saat ini ────────────────────────────────────────
  let successNote;
  if (sentToPrivate) {
    successNote = `${tge("LOCK","🔒")} <b>Detail login & kredensial sudah dikirim ke private chat kamu.</b>\n_Buka chat langsung dengan bot untuk melihatnya._`;
  } else {
    const me = await bot.telegram.getMe().catch(() => ({ username: "" }));
    successNote = `${tge("WARNING","⚠️")} <b>Gagal kirim ke private chat!</b>\n${tge("POINT_RIGHT","👉")} Kamu perlu start bot dulu di private: [Klik di sini](https://t.me/${me.username})\nLalu ulangi perintah ini atau hubungi owner.`;
  }

  // Info template tersimpan untuk tombol "Simpan Template" (khusus owner)
  const tplPayload = isOwner(userId)
    ? JSON.stringify({ nest_id: s.nest_id, egg_id: s.egg_id, egg_name: s.egg_name, nest_name: s.nest_name, plan_name: s.plan_name, plan_index: config.RESOURCE_PLANS.findIndex(p => p.name === s.plan_name), panel_type: s.panel_type || "normal" })
    : null;

  logger.event("PANEL_CREATED", `Panel "${server.name}" (ID:${server.id}) berhasil dibuat untuk userId:${userId} expired:${expDateStr} OOM=enabled`);

  const finishKb = isOwner(userId)
    ? Markup.inlineKeyboard([
        [Markup.button.callback("💿 Simpan sebagai Template", `save_tpl_${Buffer.from(tplPayload).toString("base64").slice(0,48)}`)],
        [Markup.button.callback("🏠 Menu Utama", "back_main")],
      ])
    : mainMenuKeyboard(role);

  if (isOwner(userId)) {
    // Simpan payload ke state sementara untuk callback save_tpl
    const ns = getState(userId);
    ns.pending_tpl_payload = tplPayload;
    ns.pending_tpl_server  = server.name;
  }

  return ctx.reply(
    `${tge("SUCCESS","✅")} <b>Panel berhasil dibuat!</b>\n\n` +
    `${tge("NAME_BADGE","📛")} Server: \`${server.name}\`\n` +
    `${tge("MASK","🎭")} Tipe: ${panelTypeLabel}\n` +
    `${tge("PACKAGE","📦")} Paket: *${s.plan_name}*\n` +
    `${tge("CALENDAR","📅")} Expired: *${expDateStr}*\n` +
    `${tge("BRAIN","🧠")} OOM Killer: <b>Aktif</b> ${tge("SUCCESS","✅")}\n\n` +
    successNote,
    { parse_mode: "HTML", disable_web_page_preview: true, ...finishKb }
  );
}

// ─── Build Environment dari Egg ───────────────────────────────────────────────

function buildEnvFromEgg(egg) {
  const env = {};
  const variables = egg.attributes?.relationships?.variables?.data || [];
  variables.forEach((v) => {
    const attr = v.attributes;
    env[attr.env_variable] = attr.default_value || "";
  });
  return env;
}

// ─── Helpers: Stats & Nodes ───────────────────────────────────────────────────

function buildStatsText() {
  const s = db.getStats();
  const v = getVpsStats();
  return (
    `${tge("CHART","📊")} <b>Statistik Bot</b>\n\n` +
    `${tge("USERS","👥")} Total User Start: *${s.started}*\n` +
    `${tge("DIAMOND_ORANGE","🔶")} Reseller: *${s.resellers}*\n` +
    `${tge("STAR","⭐")} Premium: *${s.premiums}*\n` +
    `${tge("CROWN","👑")} Owner: *${s.owners}*\n` +
    `${tge("PROHIBITED","🚫")} Blacklisted: *${s.blacklisted}*\n\n` +
    `${tge("DESKTOP","🖥️")} Total Panel: *${s.totalPanels}*\n` +
    `  ${tge("SUCCESS","✅")} Aktif: *${s.activePanels}*  |  ${tge("LOCK","🔒")} Suspended: *${s.suspendedPanels}*  |  ${tge("SKULL","💀")} Expired: *${s.expiredPanels}*\n` +
    `${tge("ADMISSION","🎟️")} Voucher Total: *${s.voucherTotal}* | Terpakai: *${s.voucherUsed}*\n` +
    `${tge("SCROLL","📜")} Transaksi: *${s.transactions}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("BOT","🤖")} <b>Runtime Bot:</b> \`${v.botUptime}\`\n\n` +
    `${tge("DESKTOP","🖥️")} <b>Info VPS:</b>\n` +
    `${tge("CLOCK","⏱️")} Uptime: \`${v.vpsUptime}\`\n` +
    `${tge("FLOPPY","💾")} RAM: \`${v.ram}\`\n` +
    `${tge("GEAR","⚙️")} CPU: \`${v.cpu}\`\n` +
    `${tge("DISK","💿")} Disk: \`${v.disk}\`\n` +
    `${tge("DESKTOP","🖥️")} OS: \`${v.platform}\``
  );
}

function buildDailyReportText() {
  const s = db.getStats();
  const today = new Date().toLocaleDateString("id-ID", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return (
    `${tge("CHART","📊")} <b>Laporan Harian Bot</b>\n${tge("CALENDAR","📅")} ${today}\n\n` +
    `${tge("USERS","👥")} Total User: *${s.started}*\n` +
    `${tge("DIAMOND_ORANGE","🔶")} Reseller: *${s.resellers}*  •  ${tge("STAR","⭐")} Premium: *${s.premiums}*  •  ${tge("CROWN","👑")} Owner: *${s.owners}*\n\n` +
    `${tge("DESKTOP","🖥️")} Total Panel: *${s.totalPanels}*\n` +
    `  ${tge("SUCCESS","✅")} Aktif: *${s.activePanels}*\n` +
    `  ${tge("LOCK","🔒")} Suspended: *${s.suspendedPanels}*\n` +
    `  ${tge("SKULL","💀")} Expired: *${s.expiredPanels}*\n\n` +
    `${tge("ADMISSION","🎟️")} Voucher: ${s.voucherTotal} total (${s.voucherUsed} terpakai)\n` +
    `${tge("SCROLL","📜")} Total Transaksi: ${s.transactions}\n\n` +
    `_Laporan otomatis dikirim setiap pukul ${config.DAILY_REPORT_HOUR}.00_`
  );
}

function sendStats(ctx) { ctx.reply(buildStatsText(), { parse_mode: "HTML", ...backKeyboard() }); }
async function sendStatsEdit(ctx) { return safeEdit(ctx, buildStatsText(), { parse_mode: "HTML", ...backKeyboard() }); }

async function buildNodesText() {
  const targets = config.PTLA2 && config.PTLC2 ? [1, 2] : [1];
  let text = "";
  let total = 0;
  for (const sn of targets) {
    const nodes = await ptero.getNodes(sn);
    text += `${tge("GLOBE","🌐")} <b>${he2(serverLabel(sn))}</b> (${nodes.length} node)\n`;
    if (!nodes.length) { text += `_kosong_\n\n`; continue; }
    for (const n of nodes) {
      const a = n.attributes;
      const ns = await ptero.getNodeStatus(a, sn);
      const status = ns.online ? `${tge("GREEN_DOT","🟢")} Hidup` : `${tge("RED_DOT","🔴")} Mati`;
      const ramUsed = a.allocated_resources?.memory || 0;
      const diskUsed = a.allocated_resources?.disk || 0;
      text += `*${a.name}*\n  Status: ${status}\n  ${tge("FLOPPY","💾")} RAM: ${ramUsed}MB / ${a.memory}MB\n  ${tge("DISK","💿")} Disk: ${diskUsed}MB / ${a.disk}MB\n\n`;
    }
    total += nodes.length;
  }
  if (!total) return `${tge("EMPTY_BOX","📭")} Tidak ada node terdaftar di panel.`;
  return `${tge("DESKTOP","🖥️")} <b>Daftar Node (${total} total):</b>\n\n` + text;
}

async function sendNodes(ctx) {
  const text = await buildNodesText();
  ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() });
}

async function sendNodesEdit(ctx) {
  const text = await buildNodesText();
  return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
}

// ─── Helper: Referral Menu ────────────────────────────────────────────────────

async function showReferralMenu(ctx, userId) {
  if (!db.getReferralEnabled()) return ctx.reply(`${tge("ERROR","❌")} Fitur referral sedang <b>tidak aktif</b>.`, { parse_mode: "HTML" });
  const stats = db.getReferralStats(userId);
  const unclaimed = stats.referrals.filter(r => !r.bonus_claimed).length;
  const botUsername = (await bot.telegram.getMe()).username;
  const link = `https://t.me/${botUsername}?start=ref_${stats.code}`;
  const text =
    `${tge("USERS","👥")} <b>Referral System</b>\n\n` +
    `${tge("LINK","🔗")} Kode kamu: \`${stats.code}\`\n` +
    `${tge("GLOBE","🌐")} Link referral:\n${link}\n\n` +
    `${tge("USER","👤")} Total referral: *${stats.referrals.length}* orang\n` +
    `${tge("GIFT","🎁")} Bonus bisa diklaim: *${unclaimed}* (${unclaimed * (config.REFERRAL_BONUS_DAYS || 3)} hari)\n` +
    `${tge("MONEY","💰")} Bonus tersimpan: *${stats.bonus} hari*\n\n` +
    `_Setiap referral yang membuat panel pertamanya akan memberikan +${config.REFERRAL_BONUS_DAYS || 3} hari ke akun kamu!_`;
  ctx.reply(text, { parse_mode: "HTML", ...referralMenuKeyboard() });
}

async function showReferralMenuCb(ctx, userId) {
  if (!db.getReferralEnabled()) return safeEdit(ctx, `${tge("ERROR","❌")} Fitur referral sedang <b>tidak aktif</b>.\n\nHubungi owner jika ada pertanyaan.`, { parse_mode: "HTML", ...backKeyboard() });
  const stats = db.getReferralStats(userId);
  const unclaimed = stats.referrals.filter(r => !r.bonus_claimed).length;
  const botUsername = (await bot.telegram.getMe()).username;
  const link = `https://t.me/${botUsername}?start=ref_${stats.code}`;
  const text =
    `${tge("USERS","👥")} <b>Referral System</b>\n\n` +
    `${tge("LINK","🔗")} Kode kamu: \`${stats.code}\`\n` +
    `${tge("GLOBE","🌐")} Link referral:\n${link}\n\n` +
    `${tge("USER","👤")} Total referral: *${stats.referrals.length}* orang\n` +
    `${tge("GIFT","🎁")} Bonus bisa diklaim: *${unclaimed}* (${unclaimed * (config.REFERRAL_BONUS_DAYS || 3)} hari)\n` +
    `${tge("MONEY","💰")} Bonus tersimpan: *${stats.bonus} hari*\n\n` +
    `_Setiap referral yang membuat panel pertamanya akan memberikan +${config.REFERRAL_BONUS_DAYS || 3} hari ke akun kamu!_`;
  return safeEdit(ctx, text, { parse_mode: "HTML", ...referralMenuKeyboard() });
}

// ─── Helper: Redeem Code ──────────────────────────────────────────────────────

async function redeemCode(ctx, userId, code) {
  const role = db.getRole(userId);
  const voucher = db.getVoucher(code);
  logger.action("REDEEM", `User:${userId} mencoba redeem kode "${code}"`);
  if (!voucher) {
    logger.warn("REDEEM", `Kode "${code}" tidak ditemukan`);
    return ctx.reply(`${tge("ERROR","❌")} Kode voucher tidak ditemukan.`, mainMenuKeyboard(role));
  }
  if (voucher.used) {
    logger.warn("REDEEM", `Kode "${code}" sudah dipakai sebelumnya`);
    return ctx.reply(`${tge("ERROR","❌")} Kode voucher sudah dipakai.`, mainMenuKeyboard(role));
  }

  db.useVoucher(code, userId);
  clearState(userId);

  if (voucher.type === "discount") {
    // Simpan diskon untuk panel berikutnya
    const s = getState(userId);
    s.discount_pct = voucher.discount;
    logger.action("REDEEM", `User:${userId} sukses redeem voucher DISKON kode="${code}" (${voucher.discount}%)`);
    db.addAuditLog({ actorId: userId, action: "Redeem Voucher Diskon", detail: `${code} | ${voucher.discount}%` });
    const rdPts = (config.POINT_REWARDS || {}).redeem_voucher || 3;
    if (rdPts > 0) db.addPoints(userId, rdPts);
    const newRole = db.getRole(userId);
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Voucher Diskon Berhasil Diaktifkan!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("LABEL","🏷️")} Diskon: *${voucher.discount}%*\n\n_Diskon berlaku untuk pembuatan panel berikutnya!_`,
      { parse_mode: "HTML", ...mainMenuKeyboard(newRole) }
    );
  }

  if (voucher.type === "days") {
    const currentDays = db.getPendingDays(userId);
    db.setPendingDays(userId, currentDays + voucher.days);
    logger.action("REDEEM", `User:${userId} sukses redeem voucher HARI kode="${code}" (+${voucher.days} hari)`);
    db.addAuditLog({ actorId: userId, action: "Redeem Voucher Hari", detail: `${code} | +${voucher.days} hari` });
    const rdPtsH = (config.POINT_REWARDS || {}).redeem_voucher || 3;
    if (rdPtsH > 0) db.addPoints(userId, rdPtsH);

    // Notifikasi ke semua owner agar segera memproses perpanjangan
    const fromName = telegramName(ctx.from);
    const ownerSet = new Set([
      ...config.OWNER_IDS.map(String),
      ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
    ]);
    for (const ownerId of ownerSet) {
      try {
        await bot.telegram.sendMessage(ownerId,
          `${tge("CALENDAR","📅")} <b>Voucher Hari Diredeem!</b>\n\n` +
          `${tge("USER","👤")} User: ${he(fromName)} (\`${userId}\`)\n` +
          `${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n` +
          `${tge("CALENDAR","📅")} Hari bonus: *+${voucher.days} hari*\n` +
          `${tge("CALENDAR","📅")} Total pending days: *${currentDays + voucher.days} hari*\n\n` +
          `Gunakan menu <b>Perpanjang Panel</b> di owner panel untuk menerapkan perpanjangan.`,
          { parse_mode: "HTML" }
        );
      } catch {}
    }

    const totalDays = currentDays + voucher.days;
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Voucher Hari Berhasil Diaktifkan!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("CALENDAR","📅")} Bonus: *+${voucher.days} hari*\n${tge("CALENDAR","📅")} Total tersimpan: *${totalDays} hari*\n\n${tge("HOURGLASS","⏳")} Owner bot akan segera memproses perpanjangan panelmu.\n_Hubungi owner jika belum diproses dalam 1x24 jam._`,
      { parse_mode: "HTML", ...mainMenuKeyboard(db.getRole(userId)) }
    );
  }

  // Default: role voucher
  db.setUserRole(userId, voucher.role);
  const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("STAR","⭐")}`, owner: `${tge("CROWN","👑")}` }[voucher.role] || `${tge("USER","👤")}`;
  logger.action("REDEEM", `User:${userId} sukses redeem voucher ROLE kode="${code}" → role="${voucher.role}"`);
  db.addAuditLog({ actorId: userId, action: "Redeem Voucher Role", detail: `${code} | ${voucher.role}` });
  const rdPtsR = (config.POINT_REWARDS || {}).redeem_voucher || 3;
  if (rdPtsR > 0) db.addPoints(userId, rdPtsR);
  const newRole = db.getRole(userId);
  return ctx.reply(
    `${tge("SUCCESS","✅")} <b>Voucher berhasil di-redeem!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${emoji} Role baru: *${voucher.role}*`,
    { parse_mode: "HTML", ...mainMenuKeyboard(newRole) }
  );
}

// ─── Message Handler ──────────────────────────────────────────────────────────

bot.on(message("text"), async (ctx) => {
  const userId = ctx.from.id;
  const uname  = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "?";
  const text   = ctx.message?.text?.trim() || "";
  try {
    const role = db.getRole(userId);
    const s    = getState(userId);

    if (!s.step) return;

    logger.step("INPUT", `User:${userId}(${uname}) step="${s.step}" input="${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);


  // ── Verifikasi PIN ────────────────────────────────────────────────
  if (s.step === "verify_pin") {
    const storedPin = db.getPin(userId);
    if (text !== storedPin) {
      return ctx.reply(`${tge("ERROR","❌")} PIN salah. Coba lagi.`, cancelKeyboard());
    }
    const originalAction = s.pin_action;
    s.step = null;
    s.pin_action = null;

    // Lanjutkan aksi setelah verifikasi PIN berhasil
    if (originalAction === "delete_server_flow") {
      s.step = "delete_id";
      return ctx.reply(`${tge("SUCCESS","✅")} PIN terverifikasi.\n\n${tge("TRASH","🗑️")} Masukkan <b>ID server</b> yang ingin dihapus:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    // Untuk aksi lain (power, reset_pw, backup), ulangi callback
    return ctx.reply(`${tge("SUCCESS","✅")} PIN terverifikasi! Tekan tombol aksi lagi untuk melanjutkan.`, backKeyboard());
  }

  // ── Set PIN ───────────────────────────────────────────────────────
  if (s.step === "set_pin_code") {
    if (!/^\d{4,6}$/.test(text)) return ctx.reply(`${tge("ERROR","❌")} PIN harus 4-6 digit angka.`, cancelKeyboard());
    db.setPin(userId, text);
    db.addAuditLog({ actorId: userId, action: "Set PIN 2FA" });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} PIN berhasil diset!\n${tge("LOCK_KEY","🔐")} PIN kamu: \`${text}\`\n\n_Jangan bagikan PIN ke siapapun!_`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Schedule Cron ─────────────────────────────────────────────────
  if (s.step === "sched_name") {
    s.sched_name = text;
    s.step = "sched_cron";
    return ctx.reply(
      `${tge("CALENDAR","📅")} *Buat Jadwal: ${text}*\n\nMasukkan ekspresi cron dalam format:\n<code>menit jam hari-bulan bulan hari-minggu</code>\n\n_Contoh:_\n• <code>0 0 * * *</code> = setiap tengah malam\n• <code>0 */6 * * *</code> = setiap 6 jam\n• <code>30 8 * * 1</code> = Senin jam 08:30`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (s.step === "sched_cron") {
    const parts = text.split(/\s+/);
    if (parts.length !== 5) return ctx.reply(`${tge("ERROR","❌")} Format cron harus 5 bagian. Contoh: <code>0 0 * * *</code>`, { parse_mode: "HTML", ...cancelKeyboard() });
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const serverId = s.sched_server_id;
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Identifier tidak ditemukan.`, backKeyboard()); }

    await ctx.reply(`${tge("HOURGLASS","⏳")} Membuat jadwal...`);
    const result = await ptero.createSchedule(identifier, {
      name: s.sched_name, minute, hour, dayOfWeek, dayOfMonth, month, isActive: true,
    }, psn(panel));
    db.addAuditLog({ actorId: userId, action: "Buat Jadwal Cron", target: serverId, detail: `${s.sched_name} | ${text}` });
    clearState(userId);
    if (!result) return ctx.reply(`${tge("ERROR","❌")} Gagal membuat jadwal. Periksa format cron.`, mainMenuKeyboard(role));
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Jadwal Berhasil Dibuat!</b>\n\n${tge("NAME_BADGE","📛")} Nama: *${result.name}*\n${tge("ALARM","⏰")} Cron: \`${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}\`\n${tge("SUCCESS","✅")} Status: Aktif`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Set Role ──────────────────────────────────────────────────────
  if (s.step === "set_role") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.setUserRole(targetId, s.set_role);
    db.addAuditLog({ actorId: userId, action: `Set Role ${s.set_role}`, target: String(targetId) });
    const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("STAR","⭐")}`, owner: `${tge("CROWN","👑")}` }[s.set_role] || `${tge("USER","👤")}`;
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil diberi role ${emoji} *${s.set_role}*.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Reset Role ────────────────────────────────────────────────────
  if (s.step === "reset_role_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.resetRole(targetId);
    db.addAuditLog({ actorId: userId, action: "Reset Role", target: String(targetId) });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} Role user \`${targetId}\` direset ke <b>User Biasa</b>.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Blacklist / Unblacklist ───────────────────────────────────────
  if (s.step === "blacklist_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.blacklistUser(targetId);
    db.addAuditLog({ actorId: userId, action: "Blacklist User", target: String(targetId) });
    clearState(userId);
    return ctx.reply(`${tge("PROHIBITED","🚫")} User \`${targetId}\` berhasil di-blacklist.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  if (s.step === "unblacklist_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.unblacklistUser(targetId);
    db.addAuditLog({ actorId: userId, action: "Unblacklist User", target: String(targetId) });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil di-unblacklist.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Search User ───────────────────────────────────────────────────
  if (s.step === "search_user_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    const targetRole = db.getRole(targetId);
    const targetCount = db.getPanelCount(targetId);
    const targetPanels = db.getUserPanels(targetId);
    const pin = db.getPin(targetId);
    let info = `${tge("SEARCH","🔎")} *Info User \`${targetId}\`*\n\n${tge("BOT","🤖")} Start Bot: ${db.hasStarted(targetId) ? `${tge("SUCCESS","✅")}` : `${tge("ERROR","❌")}`}\n${tge("MASK","🎭")} Role: ${roleLabel(targetRole)}\n${tge("PROHIBITED","🚫")} Blacklist: ${db.isBlacklisted(targetId) ? "Ya" : "Tidak"}\n${tge("DESKTOP","🖥️")} Total Panel: ${targetCount}\n${tge("LOCK_KEY","🔐")} PIN: ${pin ? `${tge("SUCCESS","✅")} Set` : `${tge("ERROR","❌")} Tidak`}`;
    if (targetRole === "reseller") {
      const limObj = db.getResellerLimit(targetId);
      if (limObj) {
        const exp = limObj.expire_date ? new Date(limObj.expire_date) : null;
        const isExpired = exp && exp < new Date();
        info += `\n${tge("PACKAGE","📦")} Limit: ${limObj.count} slot ${isExpired ? `${tge("RED_DOT","🔴")} Kadaluarsa` : exp ? `(exp: ${formatDate(limObj.expire_date)})` : "(Selamanya)"}`;
      } else {
        info += `\n${tge("PACKAGE","📦")} Limit: Belum diset`;
      }
    }
    if (targetPanels.length) {
      info += `\n\n${tge("LIST","📋")} <b>Panel:</b>\n`;
      targetPanels.forEach((p) => {
        const dl = daysLeft(p.expire_date);
        info += `• \`${p.server_id}\` — ${p.name || "N/A"}${dl !== null ? (dl <= 0 ? ` ${tge("RED_DOT","🔴")}` : ` ${tge("GREEN_DOT","🟢")}${dl}hr`) : ""}\n`;
      });
    }
    return ctx.reply(info, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Statistik User (step) ─────────────────────────────────────────
  if (s.step === "user_stats_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid (harus angka).`, cancelKeyboard());
    clearState(userId);
    const u = db.getUser(targetId);
    if (!u) return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` belum terdaftar di bot.`, { parse_mode: "HTML", ...backKeyboard() });
    const panels = db.getUserPanels(targetId);
    const active    = panels.filter(p => !p.expired && !p.suspended && daysLeft(p.expire_date) > 0).length;
    const suspended = panels.filter(p => p.suspended).length;
    const expired   = panels.filter(p => p.expired || (daysLeft(p.expire_date) !== null && daysLeft(p.expire_date) <= 0)).length;
    const pending   = db.getPendingDays(targetId);
    const refStats  = db.getReferralStats(targetId);
    const lim       = db.getResellerLimit(targetId);
    const limText   = lim
      ? `${tge("PACKAGE","📦")} ${lim.count} slot | ${tge("ALARM","⏰")} ${lim.expire_date ? formatDate(lim.expire_date) : "Selamanya"}`
      : "—";
    const txs = db.getUserTransactions(targetId, 5);
    let txText = txs.length ? txs.map(t => `• ${t.type}: ${t.detail}`).join("\n") : "— belum ada —";
    const pts = db.getPoints(targetId);
    const info =
      `${tge("CHART","📊")} <b>Statistik User</b>\n\n` +
      `${tge("USER","👤")} ID: \`${targetId}\`\n` +
      `${tge("MASK","🎭")} Role: ${roleLabel(u.role)}\n` +
      `${tge("PROHIBITED","🚫")} Blacklisted: ${u.blacklisted ? "Ya" : "Tidak"}\n` +
      `${tge("STAR","⭐")} Poin: *${pts}*\n\n` +
      `━━━━ ${tge("DESKTOP","🖥️")} Panel ━━━━\n` +
      `${tge("PACKAGE","📦")} Total: *${panels.length}* panel\n` +
      `${tge("GREEN_DOT","🟢")} Aktif: *${active}* | ${tge("LOCK","🔒")} Suspended: *${suspended}* | ${tge("RED_DOT","🔴")} Expired: *${expired}*\n` +
      `${tge("CALENDAR","📅")} Pending days: *${pending} hari*\n\n` +
      `━━━━ ${tge("PACKAGE","📦")} Reseller Limit ━━━━\n${limText}\n\n` +
      `━━━━ ${tge("USERS","👥")} Referral ━━━━\n` +
      `${tge("LINK","🔗")} Kode: \`${refStats.code}\`\n` +
      `${tge("USER","👤")} Total referral: *${refStats.referrals.length}*\n` +
      `${tge("GIFT","🎁")} Bonus tersimpan: *${refStats.bonus} hari*\n\n` +
      `━━━━ ${tge("SCROLL","📜")} 5 Transaksi Terakhir ━━━━\n${txText}`;
    return ctx.reply(info, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Simpan Nama Template ─────────────────────────────────────────
  if (s.step === "save_tpl_name_input") {
    if (!isOwner(userId)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
    const tplName = text.trim().slice(0, 40);
    if (!tplName) return ctx.reply(`${tge("ERROR","❌")} Nama template tidak boleh kosong.`);
    const payload = s.pending_tpl_payload;
    if (!payload) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Data template hilang.`, backKeyboard()); }
    let cfg;
    try { cfg = JSON.parse(payload); } catch { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Data template tidak valid.`, backKeyboard()); }
    clearState(userId);
    db.saveTemplate(tplName, cfg);
    db.addAuditLog({ actorId: userId, action: "Simpan Template", detail: tplName });
    return ctx.reply(`${tge("SUCCESS","✅")} Template *${he(tplName)}* berhasil disimpan!\n\nTemplate bisa dipilih saat user buat panel baru melalui menu Template.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Whitelist Add/Remove ───────────────────────────────────────────
  if (s.step === "wl_add_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid (harus angka).`, cancelKeyboard());
    clearState(userId);
    db.addToWhitelist(targetId);
    db.addAuditLog({ actorId: userId, action: "Whitelist Add", detail: `User ${targetId}` });
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil ditambah ke whitelist.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (s.step === "wl_remove_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid (harus angka).`, cancelKeyboard());
    clearState(userId);
    db.removeFromWhitelist(targetId);
    db.addAuditLog({ actorId: userId, action: "Whitelist Remove", detail: `User ${targetId}` });
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil dihapus dari whitelist.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Jadwal Maintenance Input ────────────────────────────────────────
  if (s.step === "schm_time_input") {
    const m = text.trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) return ctx.reply(`${tge("ERROR","❌")} Format salah. Gunakan: <code>HH:MM-HH:MM</code>\nContoh: <code>02:00-04:00</code>`, { parse_mode: "HTML", ...cancelKeyboard() });
    clearState(userId);
    db.setScheduledMaintenance({ start: m[1], end: m[2] });
    db.addAuditLog({ actorId: userId, action: "Set Jadwal Maintenance", detail: `${m[1]}–${m[2]}` });
    return ctx.reply(`${tge("SUCCESS","✅")} Waktu maintenance diset: *${m[1]} – ${m[2]}*`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (s.step === "schm_msg_input") {
    clearState(userId);
    db.setScheduledMaintenance({ message: text.trim() });
    db.addAuditLog({ actorId: userId, action: "Set Pesan Maintenance" });
    return ctx.reply(`${tge("SUCCESS","✅")} Pesan maintenance diperbarui.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Cari Panel ────────────────────────────────────────────────────
  if (s.step === "search_panel_query") {
    if (!isOwner(userId)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
    clearState(userId);
    const query = text.trim().toLowerCase();
    const allPanels = db.getAllPanels();
    const results = allPanels.filter(p =>
      String(p.userId) === query ||
      String(p.server_id) === query ||
      (p.server_identifier || "").toLowerCase().includes(query) ||
      (p.name || "").toLowerCase().includes(query)
    ).slice(0, 10);
    if (!results.length) return ctx.reply(`${tge("SEARCH","🔍")} Tidak ditemukan panel dengan kata kunci: *${he(text.trim())}*`, { parse_mode: "HTML", ...backKeyboard() });
    let out = `${tge("SEARCH","🔎")} *Hasil Pencarian: "${he(text.trim())}"*\nDitemukan: *${results.length}* panel\n\n`;
    for (const p of results) {
      const status = p.suspended ? `${tge("LOCK","🔒")} Suspended` : p.expired ? `${tge("RED_DOT","🔴")} Expired` : `${tge("GREEN_DOT","🟢")} Aktif`;
      const sisa   = daysLeft(p.expire_date);
      out += `${tge("PACKAGE","📦")} *${he(p.name || "?")}*\n`;
      out += `   ${tge("USER","👤")} Owner: \`${p.userId}\`\n`;
      out += `   ${tge("ID_CARD","🆔")} Server: \`${p.server_identifier || p.server_id || "?"}\`\n`;
      out += `   ${tge("CHART","📊")} Status: ${status}\n`;
      out += `   ${tge("HOURGLASS","⏳")} Sisa: ${sisa !== null ? `${sisa} hari` : "—"}\n\n`;
    }
    return ctx.reply(out, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Bulk Aksi Panel (step) ─────────────────────────────────────────
  if (s.step === "bulk_action_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid.`, cancelKeyboard());
    const u = db.getUser(targetId);
    if (!u) return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` belum terdaftar di bot.`, { parse_mode: "HTML", ...cancelKeyboard() });
    const panels = db.getUserPanels(targetId);
    clearState(userId);
    if (!panels.length) return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` tidak punya panel.`, { parse_mode: "HTML", ...backKeyboard() });
    return ctx.reply(
      `${tge("LIGHTNING","⚡")} <b>Bulk Aksi Panel</b>\n\n${tge("USER","👤")} User: \`${targetId}\`\n${tge("MASK","🎭")} Role: ${roleLabel(u.role)}\n${tge("PACKAGE","📦")} Total panel: *${panels.length}*\n\nPilih aksi yang ingin dilakukan ke <b>semua panel</b> user ini:`,
      { parse_mode: "HTML", ...bulkActionKeyboard(targetId) }
    );
  }

  // ── Set Reseller Limit ────────────────────────────────────────────
  if (s.step === "set_limit_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    const targetRole = db.getRole(targetId);
    if (targetRole !== "reseller") return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` bukan reseller.`, { parse_mode: "HTML", ...cancelKeyboard() });
    s.limit_target_id = targetId;
    s.step = "set_limit_count";
    return ctx.reply(`${tge("PACKAGE","📦")} Masukkan <b>jumlah slot</b> limit panel untuk reseller \`${targetId}\`:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "set_limit_count") {
    const count = parseInt(text);
    if (isNaN(count) || count < 0) return ctx.reply(`${tge("ERROR","❌")} Jumlah tidak valid (harus angka ≥ 0).`, cancelKeyboard());
    s.limit_count = count;
    s.step = "set_limit_expire";
    return ctx.reply(
      `${tge("CALENDAR","📅")} Masukkan <b>tanggal kadaluarsa</b> limit (format: YYYY-MM-DD)\nAtau ketik <b>tidak</b> jika tanpa batas waktu:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (s.step === "set_limit_expire") {
    const targetId = s.limit_target_id;
    const count = s.limit_count;
    let expireDate = null;
    if (text.toLowerCase() !== "tidak") {
      const d = new Date(text);
      if (isNaN(d.getTime())) return ctx.reply(`${tge("ERROR","❌")} Format tanggal tidak valid. Gunakan YYYY-MM-DD atau ketik 'tidak':`, cancelKeyboard());
      expireDate = d.toISOString();
    }
    db.setResellerLimit(targetId, count, expireDate, userId);
    db.addAuditLog({ actorId: userId, action: "Set Limit Reseller", target: String(targetId), detail: `${count} slot | exp: ${expireDate ? expireDate.slice(0,10) : "Selamanya"}` });
    clearState(userId);
    try {
      await bot.telegram.sendMessage(targetId,
        `${tge("PACKAGE","📦")} <b>Limit Panel Diupdate!</b>\n\n${tge("SUCCESS","✅")} Slot baru: *${count}*\n${tge("ALARM","⏰")} Berlaku: ${expireDate ? formatDate(expireDate) : "Selamanya"}\n\nKamu sudah bisa membuat panel sesuai limit.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(
      `${tge("SUCCESS","✅")} Limit reseller \`${targetId}\` diset:\n${tge("PACKAGE","📦")} Slot: *${count}*\n${tge("ALARM","⏰")} Exp: ${expireDate ? formatDate(expireDate) : "Selamanya"}`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Discount Voucher ──────────────────────────────────────────────
  if (s.step === "discount_pct") {
    const pct = parseInt(text);
    if (isNaN(pct) || pct < 1 || pct > 100) return ctx.reply(`${tge("ERROR","❌")} Masukkan angka 1-100.`, cancelKeyboard());
    const code = generateVoucherCode();
    db.createVoucher("discount", { discount: pct, code, maxUses: 1 });
    db.addAuditLog({ actorId: userId, action: "Buat Voucher Diskon", detail: `${code} | ${pct}%` });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} <b>Voucher Diskon Dibuat!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("LABEL","🏷️")} Diskon: *${pct}%*\n\n/redeem ${code}`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Day Voucher ───────────────────────────────────────────────────
  if (s.step === "day_voucher_count") {
    const days = parseInt(text);
    if (isNaN(days) || days < 1) return ctx.reply(`${tge("ERROR","❌")} Jumlah hari tidak valid.`, cancelKeyboard());
    const code = generateVoucherCode();
    db.createVoucher("days", { days, code, maxUses: 1 });
    db.addAuditLog({ actorId: userId, action: "Buat Voucher Hari", detail: `${code} | +${days} hari` });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} <b>Voucher Hari Dibuat!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("CALENDAR","📅")} Bonus: *+${days} hari*\n\n/redeem ${code}`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Redeem Code ───────────────────────────────────────────────────
  if (s.step === "redeem_code") {
    clearState(userId);
    return redeemCode(ctx, userId, text.toUpperCase());
  }

  // ── Delete Server ─────────────────────────────────────────────────
  if (s.step === "delete_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, mainMenuKeyboard(role));
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Menghapus server \`${serverId}\`...`, { parse_mode: "HTML" });
    const ok = await ptero.deleteServer(serverId, srvOf(serverId, s));
    if (ok) {
      const found = db.getPanelByServerId(serverId);
      if (found) db.deletePanelRecord(found.ownerUserId, serverId);
      db.addAuditLog({ actorId: userId, action: "Hapus Server", target: String(serverId) });
    }
    return ctx.reply(ok ? `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil dihapus.` : `${tge("ERROR","❌")} Gagal menghapus server \`${serverId}\`.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Suspend / Unsuspend / Reinstall ───────────────────────────────
  if (s.step === "suspend_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Suspend server \`${serverId}\`...`, { parse_mode: "HTML" });
    const ok = await ptero.suspendServer(serverId, srvOf(serverId, s));
    if (ok) db.addAuditLog({ actorId: userId, action: "Suspend Server", target: String(serverId) });
    return ctx.reply(ok ? `${tge("LOCK","🔒")} Server \`${serverId}\` disuspend.` : `${tge("ERROR","❌")} Gagal suspend.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  if (s.step === "unsuspend_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Unsuspend server \`${serverId}\`...`, { parse_mode: "HTML" });
    const ok = await ptero.unsuspendServer(serverId, srvOf(serverId, s));
    if (ok) db.addAuditLog({ actorId: userId, action: "Unsuspend Server", target: String(serverId) });
    return ctx.reply(ok ? `${tge("UNLOCK","🔓")} Server \`${serverId}\` di-unsuspend.` : `${tge("ERROR","❌")} Gagal unsuspend.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  if (s.step === "reinstall_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Reinstall server \`${serverId}\`...`, { parse_mode: "HTML" });
    const ok = await ptero.reinstallServer(serverId, srvOf(serverId, s));
    if (ok) db.addAuditLog({ actorId: userId, action: "Reinstall Server", target: String(serverId) });
    return ctx.reply(ok ? `${tge("REFRESH","🔄")} Server \`${serverId}\` di-reinstall.` : `${tge("ERROR","❌")} Gagal reinstall.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Reset Password Panel ──────────────────────────────────────────
  if (s.step === "reset_pw_new") {
    if (text.length < 8) return ctx.reply(`${tge("ERROR","❌")} Password minimal 8 karakter.`, cancelKeyboard());
    const serverId = s.reset_pw_server_id;
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Mereset password...`);
    const _ns = srvOf(serverId, s);
    const srv = await ptero.getServer(serverId, _ns);
    if (!srv) return ctx.reply(`${tge("ERROR","❌")} Server tidak ditemukan.`, mainMenuKeyboard(role));
    const ok = await ptero.resetUserPassword(srv.user, text, _ns);
    if (ok) db.addAuditLog({ actorId: userId, action: "Reset Password Panel", target: String(serverId) });
    return ctx.reply(
      ok ? `${tge("SUCCESS","✅")} Password panel berhasil direset!\n${tge("KEY","🔑")} Password baru: \`${text}\`\n\n${tge("WARNING","⚠️")} Simpan password ini!` : `${tge("ERROR","❌")} Gagal reset password.`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Rename Server ─────────────────────────────────────────────────
  if (s.step === "rename_srv_new") {
    if (text.length < 2) return ctx.reply(`${tge("ERROR","❌")} Nama minimal 2 karakter.`, cancelKeyboard());
    const serverId = s.rename_srv_id;
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Mengganti nama server...`);
    const ok = await ptero.renameServer(serverId, text, srvOf(serverId, s));
    if (ok) {
      const found = db.getPanelByServerId(serverId);
      if (found) db.updatePanelName(found.ownerUserId, serverId, text);
      db.addAuditLog({ actorId: userId, action: "Rename Server", target: String(serverId), detail: text });
    }
    return ctx.reply(
      ok ? `${tge("SUCCESS","✅")} Server berhasil diganti nama menjadi *${text}*.` : `${tge("ERROR","❌")} Gagal mengganti nama server.`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Extend Panel ──────────────────────────────────────────────────
  if (s.step === "extend_server_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    s.extend_server_id = serverId;
    s.step = "extend_days";
    return ctx.reply(`${tge("SPIRAL_CAL","🗓️")} Server ID: \`${serverId}\`\n\nMasukkan <b>jumlah hari</b> perpanjangan:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "extend_days") {
    const days = parseInt(text);
    if (isNaN(days) || days < 1) return ctx.reply(`${tge("ERROR","❌")} Jumlah hari tidak valid.`, cancelKeyboard());
    const serverId = s.extend_server_id;
    const found = db.getPanelByServerId(serverId);
    if (!found) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Server tidak ditemukan di database.`, mainMenuKeyboard(role)); }
    db.extendPanel(found.ownerUserId, serverId, days);
    db.addAuditLog({ actorId: userId, action: "Perpanjang Panel", target: String(serverId), detail: `+${days} hari` });
    // Reward poin ke owner panel yang diperpanjang
    const exPts = (config.POINT_REWARDS || {}).extend_panel || 2;
    if (exPts > 0) db.addPoints(found.ownerUserId, exPts);
    clearState(userId);
    const newPanel = db.getUserPanels(found.ownerUserId).find(p => String(p.server_id) === String(serverId));
    const newExpDate = newPanel ? formatDate(newPanel.expire_date) : "N/A";
    // Sync description baru ke Pterodactyl
    ptero.updateServerDescription(serverId, `Aktif hingga: ${newExpDate} | Paket: ${newPanel?.plan_name || "Standard"}`, srvOf(serverId, s)).catch(() => {});
    try {
      await bot.telegram.sendMessage(found.ownerUserId,
        `${tge("SPIRAL_CAL","🗓️")} <b>Panel Kamu Diperpanjang!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${newPanel?.name || serverId}\`\n${tge("CALENDAR","📅")} Expired baru: *${newExpDate}*\n${tge("PLUS","➕")} Diperpanjang: *${days} hari*`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} Panel \`${serverId}\` diperpanjang *${days} hari*.\n${tge("CALENDAR","📅")} Expired baru: *${newExpDate}*`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Transfer Panel (owner input user ID tujuan) ───────────────────
  if (s.step === "transfer_pan_uid") {
    if (!isOwner(userId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`, backKeyboard()); }
    const toUserId = text.trim();
    if (!/^\d+$/.test(toUserId)) return ctx.reply(`${tge("ERROR","❌")} Format User ID tidak valid. Masukkan angka Telegram ID.`, cancelKeyboard());
    const serverId = s.transfer_server_id;
    const found = db.getPanelByServerId(serverId);
    if (!found) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Panel tidak ditemukan di database.`, mainMenuKeyboard(role)); }
    const fromUserId = found.ownerUserId;
    if (String(toUserId) === String(fromUserId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} User tujuan sama dengan pemilik saat ini.`, mainMenuKeyboard(role)); }
    const toUser = db.getUser(toUserId);
    if (!toUser) return ctx.reply(`${tge("ERROR","❌")} User ID \`${toUserId}\` belum terdaftar di bot.`, { parse_mode: "HTML", ...cancelKeyboard() });
    const _ts = srvOf(serverId, s);
    const srv = await ptero.getServer(serverId, _ts);
    const panelRec = db.getUserPanels(fromUserId).find(p => String(p.server_id) === String(serverId));
    if (toUser.ptero_id) {
      await ptero.changeServerUser(serverId, toUser.ptero_id, _ts);
    }
    const transferred = db.transferPanel(fromUserId, toUserId, serverId);
    if (!transferred) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Gagal memindahkan data panel.`, mainMenuKeyboard(role)); }
    db.addAuditLog({ actorId: userId, action: "Transfer Panel", target: String(serverId), detail: `${fromUserId} → ${toUserId}` });
    clearState(userId);
    try {
      await bot.telegram.sendMessage(fromUserId,
        `${tge("REFRESH","🔄")} <b>Panel Kamu Dipindahkan!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panelRec?.name || serverId}\`\n${tge("ID_CARD","🆔")} ID: \`${serverId}\`\n\nPanel telah ditransfer ke pengguna lain oleh owner.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    try {
      await bot.telegram.sendMessage(toUserId,
        `${tge("GIFT","🎁")} <b>Panel Baru Diterima!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panelRec?.name || serverId}\`\n${tge("ID_CARD","🆔")} ID: \`${serverId}\`\n${tge("CALENDAR","📅")} Expired: *${formatDate(panelRec?.expire_date || "")}*\n\nPanel telah ditransfer ke akun kamu oleh owner.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Panel Berhasil Ditransfer!</b>\n\n${tge("ID_CARD","🆔")} Server: \`${serverId}\`\n${tge("USER","👤")} Dari: \`${fromUserId}\`\n${tge("USER","👤")} Ke: \`${toUserId}\``,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Auto Backup Interval Input ────────────────────────────────────
  if (s.step === "auto_backup_interval") {
    if (!isOwner(userId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`, backKeyboard()); }
    const hours = parseInt(text.trim());
    if (isNaN(hours) || hours < 1 || hours > 168) {
      return ctx.reply(`${tge("ERROR","❌")} Interval tidak valid. Masukkan angka antara *1–168* jam.`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    clearState(userId);
    db.setAutoBackup({ interval_hours: hours });
    const ab = db.getAutoBackup();
    db.addAuditLog({ actorId: userId, action: "Set Auto Backup Interval", detail: `${hours} jam` });
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Interval Auto Backup Diperbarui!</b>\n\n${tge("CLOCK","⏱️")} Backup akan berjalan setiap *${hours} jam* sekali.`,
      { parse_mode: "HTML", ...autoBackupKeyboard(ab) }
    );
  }

  // ── Broadcast ─────────────────────────────────────────────────────
  if (s.step === "broadcast_text") {
    const broadcastMsg = text;
    clearState(userId);
    const users = db.getAllStartedUsers();
    await ctx.reply(`${tge("LOUDSPEAKER","📢")} Broadcast ke *${users.length}* user...`, { parse_mode: "HTML" });
    let sent = 0, failed = 0;
    for (const uid of users) {
      try {
        await bot.telegram.sendMessage(uid, `${tge("LOUDSPEAKER","📢")} <b>Pesan dari Admin</b>\n\n${broadcastMsg}`, { parse_mode: "HTML" });
        sent++;
        await new Promise(r => setTimeout(r, 50));
      } catch { failed++; }
    }
    db.addAuditLog({ actorId: userId, action: "Broadcast", detail: `${sent} terkirim, ${failed} gagal` });
    return ctx.reply(`${tge("SUCCESS","✅")} Broadcast selesai!\n${tge("ENVELOPE","✉️")} Terkirim: *${sent}*\n${tge("ERROR","❌")} Gagal: *${failed}*`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Maintenance Message ───────────────────────────────────────────
  if (s.step === "maintenance_msg") {
    const msg = text;
    clearState(userId);
    db.setMaintenanceMode(true, msg);
    db.addAuditLog({ actorId: userId, action: "Aktifkan Maintenance", detail: msg });
    return ctx.reply(`${tge("WRENCH","🔧")} <b>Maintenance Mode Diaktifkan!</b>\n\nPesan: "${msg}"`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Clone Panel Username ───────────────────────────────────────────
  if (s.step === "clone_username") {
    const cloneUsername = text.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (cloneUsername.length < 3) return ctx.reply(`${tge("ERROR","❌")} Username minimal 3 karakter (huruf kecil, angka, underscore).`, cancelKeyboard());
    s.username = cloneUsername;
    s.email = generateEmail(cloneUsername);
    s.password = generatePassword();

    await ctx.reply(`${tge("HOURGLASS","⏳")} <b>Meng-clone panel...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
    await executeCreatePanel(ctx, userId, role, s);
    clearState(userId);
    return;
  }

  // ── Tiket Subject ─────────────────────────────────────────────────
  if (s.step === "tkt_subject") {
    if (text.length < 5) return ctx.reply(`${tge("ERROR","❌")} Subjek terlalu pendek (minimal 5 karakter).`, cancelKeyboard());
    s.tkt_subject = text;
    s.step = "tkt_message";
    return ctx.reply(`${tge("TICKET","🎫")} *Tiket: ${text}*\n\nTulis <b>detail masalah/pertanyaan</b> kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "tkt_message") {
    if (text.length < 10) return ctx.reply(`${tge("ERROR","❌")} Pesan terlalu pendek (minimal 10 karakter).`, cancelKeyboard());
    const tktId = db.addTicket(userId, { subject: s.tkt_subject, message: text });
    clearState(userId);
    notifyOwners2(`${tge("TICKET","🎫")} <b>Tiket Baru!</b>\n\n${tge("USER","👤")} User: \`${userId}\`\n${tge("PIN","📌")} Subjek: *${s.tkt_subject || text.slice(0,30)}*\n${tge("MEMO","📝")} Pesan: ${text.slice(0,100)}${text.length > 100 ? "..." : ""}`);
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Tiket Berhasil Dibuat!</b>\n\n${tge("TICKET","🎫")} ID: \`${tktId.slice(-6)}\`\n${tge("PIN","📌")} Subjek: *${s.tkt_subject || "-"}*\n\nOwner akan membalas secepatnya.`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Tiket Reply (User) ────────────────────────────────────────────
  if (s.step === "tkt_reply") {
    const repTicketId = s.reply_ticket_id;
    const myTkts2 = db.getUserTickets(userId);
    const repTkt = myTkts2.find(t => t.id.endsWith(repTicketId));
    if (!repTkt || repTkt.status !== "open") {
      clearState(userId);
      return ctx.reply(`${tge("ERROR","❌")} Tiket tidak ditemukan atau sudah ditutup.`, backKeyboard());
    }
    db.addTicketReply(repTkt.id, { fromId: userId, message: text, isOwner: false });
    clearState(userId);
    notifyOwners2(`${tge("SPEECH","💬")} *Balasan Tiket #${repTkt.id.slice(-6)}*\n\n${tge("USER","👤")} User: \`${userId}\`\n${tge("PIN","📌")} Subjek: ${repTkt.subject}\n${tge("MEMO","📝")} Balasan: ${text.slice(0,100)}`);
    return ctx.reply(`${tge("SUCCESS","✅")} Balasan terkirim!\n\nOwner akan merespons secepatnya.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Tiket Reply (Owner) ───────────────────────────────────────────
  if (s.step === "otkt_reply") {
    if (!isOwner(userId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`, backKeyboard()); }
    const repTicketId2 = s.reply_ticket_id;
    const allTkts4 = db.getAllTickets(50);
    const repTkt2 = allTkts4.find(t => t.id.endsWith(repTicketId2));
    if (!repTkt2) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard()); }
    db.addTicketReply(repTkt2.id, { fromId: userId, message: text, isOwner: true });
    clearState(userId);
    try {
      await bot.telegram.sendMessage(repTkt2.userId,
        `${tge("SPEECH","💬")} *Balasan Owner — Tiket #${repTkt2.id.slice(-6)}*\n\n${tge("PIN","📌")} Subjek: ${repTkt2.subject}\n\n${tge("CROWN","👑")} Owner: ${text}`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} Balasan terkirim ke user \`${repTkt2.userId}\`.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }


  // ── Panel Creation — Username Step ────────────────────────────────
  // ── Template-based panel: hanya input username lalu langsung konfirmasi ──
  if (s.step === "panel_username") {
    s.username = text.toLowerCase().replace(/\s+/g, "_");
    s.email    = generateEmail(s.username);
    s.password = generatePassword();
    try {
      await bot.telegram.sendMessage(userId,
        `${tge("LOCK_KEY","🔐")} <b>Info Akun Panel Kamu</b>\n\n${tge("USER","👤")} Username: \`${s.username}\`\n${tge("EMAIL","📧")} Email: \`${s.email}\`\n${tge("KEY","🔑")} Password: \`${s.password}\`\n\n_Simpan sebelum panel selesai dibuat!_`,
        { parse_mode: "HTML" }
      );
    } catch (_) {}
    // Fetch egg dari pterodactyl untuk ambil docker_image, startup, env
    let eggData;
    try {
      const eggs = await ptero.getEggs(s.nest_id, s.server_num || 1);
      eggData = eggs.find(e => String(e.attributes?.id || e.id) === String(s.egg_id));
    } catch (_) {}
    if (eggData) {
      s.docker_image = eggData.attributes?.docker_image || eggData.docker_image || "";
      s.startup      = eggData.attributes?.startup || eggData.startup || "";
      s.environment  = buildEnvFromEgg(eggData);
    } else {
      s.environment = {};
    }
    // Fallback nest_name dari template
    s.nest_name = s.template?.nest_name || s.nest_name || String(s.nest_id);
    const plan = s.plan || config.RESOURCE_PLANS[0];
    s.plan_name = plan.name;
    s.ram = plan.ram; s.disk = plan.disk; s.cpu = plan.cpu;
    s.step = "confirm_panel";
    return ctx.reply(
      `${tge("SUCCESS","✅")} Username *${s.username}* diterima!\n\n` +
      `${tge("LIST","📋")} *Konfigurasi Panel (Template: ${s.template?.name || "?"})*\n` +
      `${tge("EGG","🥚")} Egg: ${s.egg_name || "?"}\n` +
      `${tge("PACKAGE","📦")} Plan: ${plan.name}\n` +
      `${tge("FLOPPY","💾")} RAM: ${plan.ram}MB | ${tge("DISK","💿")} Disk: ${plan.disk}MB | ${tge("GEAR","⚙️")} CPU: ${plan.cpu}%\n\n` +
      `Konfirmasi buat panel?`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Buat Panel", "do_create_panel")],
        [Markup.button.callback("✖️ Batal", "cancel")],
      ]) }
    );
  }

  if (s.step === "username" || s.step === "trial_username") {
    const isTrial = s.step === "trial_username";
    s.username = text.toLowerCase().replace(/\s+/g, "_");
    s.email    = generateEmail(s.username);
    s.password = generatePassword();
    s.step     = "nest";

    if (isTrial) {
      s.plan_name = config.TRIAL_PLAN.name;
      s.ram = config.TRIAL_PLAN.ram;
      s.disk = config.TRIAL_PLAN.disk;
      s.cpu = config.TRIAL_PLAN.cpu;
      s.panel_type = "biasa";
      s.is_trial = true;
    }

    // Kirim info akun ke PRIVATE CHAT saja
    try {
      await bot.telegram.sendMessage(userId,
        `${tge("LOCK_KEY","🔐")} <b>Info Akun Panel Kamu</b>\n\n` +
        `${tge("USER","👤")} Username: \`${s.username}\`\n` +
        `${tge("EMAIL","📧")} Email: \`${s.email}\`\n` +
        `${tge("KEY","🔑")} Password: \`${s.password}\`\n\n` +
        `_Simpan sebelum panel selesai dibuat!_`,
        { parse_mode: "HTML" }
      );
    } catch (_) {}

    // Ack singkat di grup
    await ctx.reply(`${tge("SUCCESS","✅")} Username *${s.username}* diterima!\n\n${tge("HOURGLASS","⏳")} Mengambil daftar Nest...`, { parse_mode: "HTML" });

    if (isTrial) {
      // Langsung ke pemilihan nest
      const nests = await ptero.getNests(s.server_num || 1);
      if (!nests.length) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Tidak ada Nest tersedia.`, mainMenuKeyboard(role)); }
      s.nests = nests;
      return ctx.reply(`${tge("CARD_INDEX","🗂️")} <b>Pilih Nest</b>\n\nPilih kategori server:`, { parse_mode: "HTML", ...nestsKeyboard(nests) });
    }

    const nests = await ptero.getNests(s.server_num || 1);
    if (!nests.length) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Tidak ada Nest tersedia.`, mainMenuKeyboard(role)); }
    s.nests = nests;
    return ctx.reply(`${tge("CARD_INDEX","🗂️")} <b>Pilih Nest</b>\n\nPilih kategori server:`, { parse_mode: "HTML", ...nestsKeyboard(nests) });
  }

  } catch (err) {
    botLog("ERROR", "TEXT_HANDLER", `User:${userId} | Input:"${text.slice(0, 60)}"`, err);
    try { await ctx.reply(`${tge("ERROR","❌")} Terjadi kesalahan internal. Silakan coba lagi atau hubungi owner.`); } catch {}
  }
});

// ─── Notification Helpers ─────────────────────────────────────────────────────

async function notifyOwners2(message) {
  const allOwners = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);
  for (const ownerId of allOwners) {
    try { await bot.telegram.sendMessage(ownerId, message, { parse_mode: "HTML" }); } catch {}
  }
}

async function notifyOwners({ creatorId, creatorFrom, server, panelTypeLabel, s }) {
  const _sn = s.server_num || 1;
  const creatorDisplayName = telegramName(creatorFrom);
  const isAdminPanel = s.panel_type === "admin";
  const ps = planSummary({ ram: s.ram, disk: s.disk, cpu: s.cpu });
  const headerLine = isAdminPanel ? `${tge("SIREN","🚨")} <b>PERINGATAN: ADMIN PANEL DIBUAT!</b>` : `${tge("BELL","🔔")} <b>Notifikasi Panel Baru</b>`;

  const ownerMsg =
    `${headerLine}\n\n━━━━ ${tge("USER","👤")} Pembuat Panel ━━━━\n${tge("ID_BADGE","🪪")} Nama: *${creatorDisplayName}*\n${tge("ID_CARD","🆔")} ID: \`${creatorId}\`\n\n` +
    `━━━━ ${tge("DESKTOP","🖥️")} Info Panel ━━━━\n${tge("MASK","🎭")} Tipe: ${panelTypeLabel}${s.is_trial ? " (Trial)" : ""}\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(_sn))}</b>\n${tge("ID_CARD","🆔")} Server ID: \`${server.id}\`\n${tge("NAME_BADGE","📛")} Nama: \`${server.name}\`\n` +
    `${tge("USER","👤")} Username: \`${s.username}\`\n${tge("EMAIL","📧")} Email: \`${s.email}\`\n${tge("CARD_INDEX","🗂️")} Nest: \`${s.nest_name}\`\n${tge("EGG","🥚")} Egg: \`${s.egg_name}\`\n` +
    `${tge("PACKAGE","📦")} Paket: *${s.plan_name}*\n${tge("FLOPPY","💾")} RAM: ${ps.ram}  •  ${tge("DISK","💿")} Disk: ${ps.disk}  •  ${tge("GEAR","⚙️")} CPU: ${ps.cpu}\n` +
    `${tge("BRAIN","🧠")} OOM Killer: <b>Aktif</b> ${tge("SUCCESS","✅")}\n\n` +
    `━━━━ ${tge("LOCK_KEY","🔐")} Kredensial ━━━━\n${tge("LINK","🔗")} URL: ${serverUrl(_sn)}\n${tge("KEY","🔑")} Password: \`${s.password}\`` +
    (isAdminPanel ? `\n\n${tge("WARNING","⚠️")} <b>Akun ini memiliki hak ADMIN di panel!</b>` : "");

  const allOwners = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);

  for (const ownerId of allOwners) {
    try { await bot.telegram.sendMessage(ownerId, ownerMsg, { parse_mode: "HTML" }); }
    catch (err) { botLog("WARN", "NOTIFY", `Gagal kirim ke owner ${ownerId}`, err); }
  }
}

async function notifyGroup({ creatorFrom, server, panelTypeLabel, s }) {
  if (!config.GROUP_ID) return;
  const _sn = s.server_num || 1;
  const creatorDisplayName = telegramName(creatorFrom);
  const isAdminPanel = s.panel_type === "admin";
  const ps = planSummary({ ram: s.ram, disk: s.disk, cpu: s.cpu });
  const expDate = formatDate(new Date(Date.now() + config.PANEL_EXPIRE_DAYS * 24*60*60*1000).toISOString());
  const headerLine = isAdminPanel ? `${tge("SIREN","🚨")} <b>ADMIN PANEL BARU DIBUAT!</b>` : `${tge("LOUDSPEAKER","📢")} <b>Panel Baru Dibuat!</b>`;

  const groupMsg =
    `${headerLine}${s.is_trial ? " (Trial)" : ""}\n\n━━━━ ${tge("USER","👤")} Pembuat ━━━━\n${tge("ID_BADGE","🪪")} Nama: *${creatorDisplayName}*\n${tge("ID_CARD","🆔")} ID: \`${creatorFrom.id}\`\n\n` +
    `━━━━ ${tge("DESKTOP","🖥️")} Info Panel ━━━━\n${tge("MASK","🎭")} Tipe: ${panelTypeLabel}\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(_sn))}</b>\n${tge("ID_CARD","🆔")} Server ID: \`${server.id}\`\n${tge("NAME_BADGE","📛")} Nama Server: \`${server.name}\`\n` +
    `${tge("CARD_INDEX","🗂️")} Nest: \`${s.nest_name}\`\n${tge("EGG","🥚")} Egg: \`${s.egg_name}\`\n` +
    `${tge("PACKAGE","📦")} Paket: *${s.plan_name}*\n${tge("FLOPPY","💾")} RAM: ${ps.ram}  •  ${tge("DISK","💿")} Disk: ${ps.disk}  •  ${tge("GEAR","⚙️")} CPU: ${ps.cpu}\n` +
    `${tge("CALENDAR","📅")} Expired: *${s.is_trial ? formatDate(new Date(Date.now() + config.TRIAL_HOURS*3600*1000).toISOString()) : expDate}*` +
    (isAdminPanel ? `\n\n${tge("WARNING","⚠️")} <b>Akun ini punya hak ADMIN! Owner segera cek!</b>` : "");

  try { await bot.telegram.sendMessage(config.GROUP_ID, groupMsg, { parse_mode: "HTML" }); }
  catch (err) { botLog("WARN", "NOTIFY", "Gagal kirim ke grup", err); }
}

// ─── Server Down Detection ────────────────────────────────────────────────────

const serverStateCache = {}; // { serverId: "running"|"offline"|"starting"|... }

async function checkServerDown() {
  const allPanels = db.getAllPanels(); // [{ ...panelFields, userId }] — flat format
  if (!allPanels.length) return;

  const ownerSet = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);

  for (const panel of allPanels) {
    const identifier = panel.server_identifier || panel.identifier;
    if (!identifier) continue;
    const sid = String(panel.server_id);
    let stats;
    try {
      stats = await ptero.getServerResources(identifier, psn(panel));
    } catch { continue; }

    const currentState = stats?.current_state ?? null;
    if (!currentState) continue;

    const prevState = serverStateCache[sid];
    serverStateCache[sid] = currentState;

    // Hanya kirim notif ketika transisi dari berjalan → offline
    const wasRunning = prevState === "running" || prevState === "starting";
    const isOffline  = currentState === "offline" || currentState === "stopping";

    if (wasRunning && isOffline) {
      logger.warn("SERVER_DOWN", `Server ${sid} ("${panel.name}") userId:${panel.userId} – offline!`);

      const msg =
        `${tge("RED_DOT","🔴")} <b>Server Down Terdeteksi!</b>\n\n` +
        `${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n` +
        `${tge("ID_CARD","🆔")} ID: \`${sid}\`\n` +
        `${tge("CHART","📊")} Status: *${currentState}*\n` +
        `${tge("CLOCK_FACE","🕐")} Waktu: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB\n\n` +
        `Cek kondisi server dan restart jika diperlukan.`;

      // Notif ke pemilik panel
      try { await bot.telegram.sendMessage(panel.userId, msg, { parse_mode: "HTML" }); } catch {}
      // Notif ke grup log
      if (config.LOG_GROUP_ID) {
        try { await bot.telegram.sendMessage(config.LOG_GROUP_ID, msg, { parse_mode: "HTML" }); } catch {}
      }
      // Notif ke semua owner
      for (const ownerId of ownerSet) {
        try { await bot.telegram.sendMessage(ownerId, msg, { parse_mode: "HTML" }); } catch {}
      }
    }
  }
}

// ─── Sistem Expired Panel + Auto Delete ──────────────────────────────────────

async function checkExpiredPanels() {
  logger.sys("EXPIRE_CHECK", "Menjalankan pengecekan panel expired...");

  // H-7, H-3, H-1 warning
  const ownerSetExp = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);
  for (const daysAhead of [7, 3, 1]) {
    const expiringSoon = db.getExpiringPanels(daysAhead);
    for (const { userId, panel } of expiringSoon) {
      const dl = daysLeft(panel.expire_date);
      if (dl === daysAhead) {
        logger.warn("EXPIRE_WARN", `Panel ${panel.server_id} ("${panel.name}") userId:${userId} – sisa ${dl} hari`);
        // Kirim ke user
        try {
          const urgency = dl === 1 ? `${tge("RED_DOT","🔴")} SEGERA` : dl === 3 ? `${tge("ORANGE_DOT","🟠")} Penting` : `${tge("YELLOW_DOT","🟡")} Info`;
          await bot.telegram.sendMessage(userId,
            `${urgency} <b>Panel Akan Expired!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("CALENDAR","📅")} Expired dalam: *${dl} hari* (${formatDate(panel.expire_date)})\n\n` +
            `Redeem <b>Voucher Hari</b> dan hubungi owner untuk perpanjangan.\n_Jangan tunggu sampai expired!_`,
            { parse_mode: "HTML" }
          );
        } catch {}
        // Notifikasi ke owner (khusus H-3 dan H-1 saja)
        if (dl <= 3) {
          for (const ownerId of ownerSetExp) {
            try {
              await bot.telegram.sendMessage(ownerId,
                `${tge("ALARM","⏰")} *Panel User Akan Expired (H-${dl})*\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("USER","👤")} User ID: \`${userId}\`\n${tge("CALENDAR","📅")} Expired: *${formatDate(panel.expire_date)}*\n\nCek apakah user sudah punya pending days untuk diperpanjang.`,
                { parse_mode: "HTML" }
              );
            } catch {}
          }
        }
      }
    }
  }

  // Suspend yang expired
  const expired = db.getExpiringPanels(0);
  for (const { userId, panel } of expired) {
    const dl = daysLeft(panel.expire_date);
    if (dl <= 0) {
      const ok = await ptero.suspendServer(panel.server_id, psn(panel));
      if (ok) {
        db.markPanelSuspended(userId, panel.server_id, true);
        logger.event("EXPIRE", `Panel ${panel.server_id} ("${panel.name}") milik userId:${userId} disuspend karena expired`);
        try {
          await bot.telegram.sendMessage(userId,
            `${tge("LOCK","🔒")} <b>Panel Anda Telah Di-suspend!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("CALENDAR","📅")} Expired: ${formatDate(panel.expire_date)}\n\nHubungi owner untuk perpanjang atau hapus panel.`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }
    }
  }

  // Reminder ke owner: panel expired belum dihapus (di atas AUTO_DELETE/2 hari)
  const reminderThreshold = Math.max(1, Math.floor((config.AUTO_DELETE_DAYS || 7) / 2));
  const oldSuspended = db.getSuspendedExpiredPanels(reminderThreshold);
  for (const { userId: panelOwner, panel } of oldSuspended) {
    // Cek sudah ada tracking reminder (gunakan daily flag)
    const db2 = db.loadDb();
    const flagKey = `expire_reminder_${panel.server_id}_${db.getTodayKey()}`;
    if (db2.daily_counts && db2.daily_counts[flagKey]) continue;
    if (!db2.daily_counts) db2.daily_counts = {};
    db2.daily_counts[flagKey] = 1;
    db.saveDb(db2);
    const suspendedAt = panel.expire_date;
    for (const ownerId of ownerSetExp) {
      try {
        await bot.telegram.sendMessage(ownerId,
          `${tge("WARNING","⚠️")} <b>Panel Expired Belum Dihapus</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name || panel.server_id}\`\n${tge("USER","👤")} User ID: \`${panelOwner}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("CALENDAR","📅")} Expired: ${formatDate(suspendedAt)}\n\nPanel ini sudah suspended cukup lama. Pertimbangkan untuk hapus manual jika user tidak merespons.`,
          { parse_mode: "HTML" }
        );
      } catch {}
    }
  }

  // Auto-delete panel yang sudah lama suspended
  if (config.AUTO_DELETE_DAYS > 0) {
    const toDelete = db.getSuspendedExpiredPanels(config.AUTO_DELETE_DAYS);
    for (const { userId, panel } of toDelete) {
      const ok = await ptero.deleteServer(panel.server_id, psn(panel));
      if (ok) {
        db.deletePanelRecord(userId, panel.server_id);
        logger.event("AUTO-DELETE", `Panel ${panel.server_id} ("${panel.name}") milik userId:${userId} dihapus otomatis setelah ${config.AUTO_DELETE_DAYS} hari suspended`);
        try {
          await bot.telegram.sendMessage(userId,
            `${tge("TRASH","🗑️")} <b>Panel Anda Telah Dihapus Otomatis!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n\nPanel dihapus karena sudah *${config.AUTO_DELETE_DAYS} hari* dalam kondisi suspended/expired.`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }
    }
  }
}

// ─── Node Down Alert ──────────────────────────────────────────────────────────

async function checkNodeStatus() {
  if (!config.NODE_CHECK_INTERVAL_MINUTES || config.NODE_CHECK_INTERVAL_MINUTES <= 0) return;
  logger.sys("NODE_CHECK", "Mengecek status semua node...");
  try {
    const targets = config.PTLA2 && config.PTLC2 ? [1, 2] : [1];
    for (const sn of targets) {
    const nodes = await ptero.getNodes(sn);
    for (const n of nodes) {
      const a = n.attributes;
      const ns = await ptero.getNodeStatus(a, sn);
      const prevStatus = nodeStatusCache.get(`${sn}:${a.id}`);

      if (typeof prevStatus !== "undefined" && prevStatus !== ns.online) {
        // Status berubah!
        const alertMsg = ns.online
          ? `${tge("SUCCESS","✅")} <b>Node Kembali Online!</b>\n\n${tge("DESKTOP","🖥️")} Node: *${a.name}*\n${tge("ID_CARD","🆔")} ID: \`${a.id}\`\n\n_Node sudah bisa digunakan kembali._`
          : `${tge("SIREN","🚨")} <b>Node Down Terdeteksi!</b>\n\n${tge("DESKTOP","🖥️")} Node: *${a.name}*\n${tge("ID_CARD","🆔")} ID: \`${a.id}\`\n\n${tge("WARNING","⚠️")} Server yang berjalan di node ini mungkin tidak bisa diakses!`;

        // Alert ke grup dan semua owner
        if (config.GROUP_ID) {
          try { await bot.telegram.sendMessage(config.GROUP_ID, alertMsg, { parse_mode: "HTML" }); } catch {}
        }
        const allOwners = new Set([
          ...config.OWNER_IDS.map(String),
          ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
        ]);
        for (const ownerId of allOwners) {
          try { await bot.telegram.sendMessage(ownerId, alertMsg, { parse_mode: "HTML" }); } catch {}
        }
        if (ns.online) {
          logger.sys("NODE_ALERT", `Node "${a.name}" (ID:${a.id}) kembali ONLINE`);
        } else {
          logger.error("NODE_ALERT", `Node "${a.name}" (ID:${a.id}) DOWN – server mungkin tidak bisa diakses`);
        }
      }
      nodeStatusCache.set(`${sn}:${a.id}`, ns.online);
    }
    }
  } catch (err) {
    botLog("ERROR", "NODE_CHECK", "Error saat cek status node", err);
  }
}

// ─── Daily Report ─────────────────────────────────────────────────────────────

async function checkDailyReport() {
  const reportHour = config.DAILY_REPORT_HOUR || 7;
  const now = new Date();
  if (now.getHours() !== reportHour) return;

  const today = now.toDateString();
  const lastReport = db.getLastDailyReport();
  if (lastReport === today) return; // Sudah kirim hari ini

  db.setLastDailyReport(today);
  const reportText = buildDailyReportText();

  if (config.GROUP_ID) {
    try { await bot.telegram.sendMessage(config.GROUP_ID, reportText, { parse_mode: "HTML" }); } catch {}
  }
  const allOwners = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);
  for (const ownerId of allOwners) {
    try { await bot.telegram.sendMessage(ownerId, reportText, { parse_mode: "HTML" }); } catch {}
  }
  console.log("[REPORT] Laporan harian dikirim.");
}

// ─── Over Resource Monitor ────────────────────────────────────────────────────

async function checkOverResource(manualTrigger = false, triggerUserId = null) {
  if (!config.OVER_RESOURCE_ACTION || config.OVER_RESOURCE_ACTION === "none") return;

  // Batas absolut dari config
  const cpuLimit  = config.RESOURCE_CPU_LIMIT     || 0;  // persen
  const ramLimitB = (config.RESOURCE_RAM_LIMIT_MB  || 0) * 1024 * 1024;  // bytes
  const diskLimitB= (config.RESOURCE_DISK_LIMIT_MB || 0) * 1024 * 1024;  // bytes

  // Helper: kirim notifikasi ke grup dan semua owner
  async function notifyGroupAndOwners(text, parseMode = "Markdown") {
    if (config.GROUP_ID) {
      try { await bot.telegram.sendMessage(config.GROUP_ID, text, { parse_mode: parseMode }); } catch {}
    }
    const ownerSet = new Set([
      ...config.OWNER_IDS.map(String),
      ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
    ]);
    for (const ownerId of ownerSet) {
      try { await bot.telegram.sendMessage(ownerId, text, { parse_mode: parseMode }); } catch {}
    }
  }

  try {
    const allPanels = db.getAllPanels ? db.getAllPanels() : [];
    const activePanels = allPanels.filter(p => p.server_identifier && !p.expired && !p.suspended);
    for (const panel of activePanels) {
      if (!panel.server_identifier) continue;
      const stats = await ptero.getServerResources(panel.server_identifier, psn(panel));
      if (!stats) continue;

      const rss = stats.resources || {};
      const cpuPct   = rss.cpu_absolute || 0;
      const ramBytes = rss.memory_bytes || 0;
      const diskBytes= rss.disk_bytes   || 0;
      const ramMB    = Math.round(ramBytes  / 1024 / 1024);
      const diskMB   = Math.round(diskBytes / 1024 / 1024);

      // Cek batas absolut
      const cpuOver  = cpuLimit   > 0 && cpuPct   >= cpuLimit;
      const ramOver  = ramLimitB  > 0 && ramBytes >= ramLimitB;
      const diskOver = diskLimitB > 0 && diskBytes >= diskLimitB;
      const isOver   = cpuOver || ramOver || diskOver;

      if (!isOver) {
        db.clearResourceAlert(String(panel.server_id), "over_resource");
        continue;
      }

      const alertCount = db.addResourceAlert(panel.userId, String(panel.server_id), "over_resource");

      // Baris status resource untuk pesan (tampilkan nilai aktual + batas)
      const _warn  = tge("WARNING","⚠️");
      const _alert = tge("ALERT","🚨");
      const _fire  = tge("FIRE","🔥");
      const resourceLine =
        `${tge("GEAR","⚙️")} CPU:  ${cpuPct.toFixed(1)}% / batas ${cpuLimit}% ${cpuOver   ? tge("ERROR","🔴") : tge("SUCCESS","✅")}\n` +
        `${tge("FLOPPY","💾")} RAM:  ${ramMB} MB / batas ${config.RESOURCE_RAM_LIMIT_MB || "∞"} MB ${ramOver  ? tge("ERROR","🔴") : tge("SUCCESS","✅")}\n` +
        `${tge("DISK","💿")} Disk: ${diskMB} MB / batas ${config.RESOURCE_DISK_LIMIT_MB || "∞"} MB ${diskOver ? tge("ERROR","🔴") : tge("SUCCESS","✅")}`;

      // Mode manual (trigger dari owner)
      if (manualTrigger && triggerUserId) {
        try {
          await bot.telegram.sendMessage(triggerUserId,
            `${_warn} <b>Over-Resource Alert</b>\n\n` +
            `${tge("DESKTOP","🖥️")} Server: <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
            `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>\n` +
            `${tge("USER","👤")} User: <code>${he2(String(panel.userId))}</code>\n\n` +
            resourceLine + `\n\n${_alert} Alert ke-${alertCount}`,
            { parse_mode: "HTML" }
          );
        } catch {}
        continue;
      }

      // Mode otomatis — peringatan (alert 1, 2)
      if (alertCount < 3) {
        const actionWord = config.OVER_RESOURCE_ACTION === "delete" ? "dihapus" : "disuspend";
        const warnMsg =
          `${_warn} <b>Over-Resource Alert!</b>\n\n` +
          `${tge("DESKTOP","🖥️")} Server: <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
          `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>\n` +
          `${tge("USER","👤")} User: <code>${he2(String(panel.userId))}</code>\n\n` +
          resourceLine + `\n\n` +
          `${_alert} Peringatan ${alertCount}/3 — server akan <b>${actionWord}</b> jika terus melebihi batas.`;

        await notifyGroupAndOwners(warnMsg, "HTML");
        try {
          await bot.telegram.sendMessage(panel.userId,
            `${_warn} <b>Peringatan Resource!</b>\n\n` +
            `${tge("DESKTOP","🖥️")} Server <code>${he2(panel.name || String(panel.server_id))}</code> kamu melebihi batas resource!\n\n` +
            resourceLine + `\n\n` +
            `Kurangi penggunaan atau server akan <b>${actionWord}</b> (peringatan ${alertCount}/3).`,
            { parse_mode: "HTML" }
          );
        } catch {}
        continue;
      }

      // Tindakan setelah 3 alert
      if (config.OVER_RESOURCE_ACTION === "suspend") {
        await ptero.suspendServer(panel.server_id, psn(panel));
        db.markPanelSuspended(panel.userId, panel.server_id, true);
        db.addAuditLog({ actorId: "SYSTEM", action: "Auto Suspend (Over Resource)", target: String(panel.server_id) });

        const suspMsg =
          `${tge("LOCK","🔒")} <b>Server Auto-Suspend — Over Resource!</b>\n\n` +
          `${tge("DESKTOP","🖥️")} Server: <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
          `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>\n` +
          `${tge("USER","👤")} User: <code>${he2(String(panel.userId))}</code>\n\n` +
          resourceLine;
        await notifyGroupAndOwners(suspMsg, "HTML");
        try {
          await bot.telegram.sendMessage(panel.userId,
            `${tge("LOCK","🔒")} <b>Server Disuspend — Over Resource!</b>\n\n` +
            `${tge("DESKTOP","🖥️")} Server <code>${he2(panel.name || String(panel.server_id))}</code> disuspend otomatis karena resource melebihi batas.\n\n` +
            resourceLine + `\n\nHubungi owner untuk unsuspend.`,
            { parse_mode: "HTML" }
          );
        } catch {}

      } else if (config.OVER_RESOURCE_ACTION === "delete") {
        await ptero.deleteServer(panel.server_id, psn(panel));
        db.deletePanelRecord(panel.userId, panel.server_id);
        db.decrementPanelCount(panel.userId);
        db.addAuditLog({ actorId: "SYSTEM", action: "Auto Delete (Over Resource)", target: String(panel.server_id) });

        const delMsg =
          `${tge("TRASH","🗑️")} <b>Server Auto-Delete — Over Resource!</b>\n\n` +
          `${tge("DESKTOP","🖥️")} Server: <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
          `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>\n` +
          `${tge("USER","👤")} User: <code>${he2(String(panel.userId))}</code>\n\n` +
          resourceLine;
        await notifyGroupAndOwners(delMsg, "HTML");
        try {
          await bot.telegram.sendMessage(panel.userId,
            `${tge("TRASH","🗑️")} <b>Server Dihapus — Over Resource!</b>\n\n` +
            `${tge("DESKTOP","🖥️")} Server <code>${he2(panel.name || String(panel.server_id))}</code> dihapus otomatis karena resource melebihi batas.\n\n` +
            resourceLine + `\n\nHubungi owner untuk info lebih lanjut.`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }
      db.clearResourceAlert(String(panel.server_id), "over_resource");
    }
  } catch (err) {
    botLog("ERROR", "RESOURCE_CHECK", "Error saat cek resource server", err);
  }
}

// ─── Auto Backup ──────────────────────────────────────────────────────────────

async function runAutoBackup(isManual = false) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupName = `bot-backup-${timestamp}.tar.gz`;
  const backupPath = path.join(os.tmpdir(), backupName);
  const botDir = path.resolve(__dirname);

  try {
    // Buat tar.gz dari seluruh folder bot (kecuali node_modules & .git)
    execSync(
      `tar -czf "${backupPath}" --exclude="node_modules" --exclude=".git" --exclude="*.tar.gz" -C "${path.dirname(botDir)}" "${path.basename(botDir)}"`,
      { stdio: "pipe" }
    );

    const fileSizeKB = Math.round(fs.statSync(backupPath).size / 1024);
    const caption =
      `${tge("FLOPPY","💾")} *${isManual ? "Manual" : "Auto"} Backup Bot*\n\n` +
      `${tge("PACKAGE","📦")} Isi: script + database bot\n` +
      `${tge("FOLDER","📁")} File: \`${backupName}\`\n` +
      `${tge("RULER","📏")} Ukuran: *${fileSizeKB} KB*\n` +
      `${tge("CLOCK_FACE","🕐")} Waktu: *${formatDate(new Date().toISOString())}*`;

    // Kirim ke semua owner sebagai dokumen
    const allOwners = new Set([
      ...config.OWNER_IDS.map(String),
      ...Object.entries(db.listAllUsers()).filter(([, u]) => u.role === "owner").map(([uid]) => uid),
    ]);

    let sentCount = 0;
    for (const ownerId of allOwners) {
      try {
        await bot.telegram.sendDocument(
          ownerId,
          { source: fs.createReadStream(backupPath), filename: backupName },
          { caption, parse_mode: "HTML" }
        );
        sentCount++;
      } catch (err) {
        botLog("WARN", "AUTO_BACKUP", `Gagal kirim backup ke owner ${ownerId}`, err);
      }
    }

    // Hapus file temp setelah dikirim
    try { fs.unlinkSync(backupPath); } catch {}

    db.setAutoBackup({ last_run: new Date().toISOString() });
    db.addAuditLog({
      actorId: "SYSTEM",
      action: isManual ? "Manual Backup Bot" : "Auto Backup Bot",
      detail: `${backupName} (${fileSizeKB} KB) → ${sentCount} owner`,
    });

    console.log(`[AUTO BACKUP] ${tge("SUCCESS","✅")} ${backupName} (${fileSizeKB} KB) terkirim ke ${sentCount} owner`);
    return { success: true, filename: backupName, sizeKB: fileSizeKB, sentCount };

  } catch (err) {
    botLog("ERROR", "AUTO_BACKUP", "Proses backup bot gagal", err);
    try { fs.unlinkSync(backupPath); } catch {}
    db.addAuditLog({ actorId: "SYSTEM", action: "Auto Backup Bot GAGAL", detail: err.message });
    return { success: false, error: err.message };
  }
}

async function checkAutoBackup() {
  try {
    const ab = db.getAutoBackup();
    if (!ab.enabled) return;
    const intervalMs = ab.interval_hours * 60 * 60 * 1000;
    const lastRun = ab.last_run ? new Date(ab.last_run).getTime() : 0;
    if (Date.now() - lastRun < intervalMs) return;
    botLog("INFO", "AUTO_BACKUP", `Memulai backup otomatis (interval: ${ab.interval_hours}j)...`);
    await runAutoBackup(false);
  } catch (err) {
    botLog("ERROR", "AUTO_BACKUP", "Error saat jadwal auto backup", err);
  }
}

// ─── Global Error Handlers ────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  const userId = ctx?.from?.id ?? "?";
  const action = ctx?.callbackQuery?.data ?? ctx?.message?.text?.slice(0, 40) ?? "?";
  botLog("ERROR", "BOT.CATCH", `User:${userId} | Ctx:${action}`, err);
});

process.on("uncaughtException", (err) => {
  botLog("ERROR", "UNCAUGHT_EXCEPTION", "Exception tidak tertangkap!", err);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  botLog("ERROR", "UNHANDLED_REJECTION", "Promise rejection tidak tertangkap!", err);
});

// ─── Apply New Features (anti-spam, monitoring, friends, snapshot, etc.) ────
features.applyAll(bot, db, ptero, logger, config);

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch().then(() => {
  logger.sys("LAUNCH", `${tge("SUCCESS","✅")} Bot "${config.BOT_NAME}" berhasil dijalankan!`);
  logger.info("LAUNCH", `Expire check setiap ${config.EXPIRE_CHECK_HOURS} jam | Node check setiap ${config.NODE_CHECK_INTERVAL_MINUTES} menit`);

  // Pengecekan expired panel
  checkExpiredPanels();
  setInterval(checkExpiredPanels, config.EXPIRE_CHECK_HOURS * 60 * 60 * 1000);

  // Node monitoring
  if (config.NODE_CHECK_INTERVAL_MINUTES > 0) {
    setTimeout(checkNodeStatus, 60 * 1000);
    setInterval(checkNodeStatus, config.NODE_CHECK_INTERVAL_MINUTES * 60 * 1000);
  }

  // Over-resource monitoring
  if (config.RESOURCE_CHECK_INTERVAL_MINUTES > 0 && config.OVER_RESOURCE_ACTION && config.OVER_RESOURCE_ACTION !== "none") {
    logger.info("LAUNCH", `Resource check aktif: setiap ${config.RESOURCE_CHECK_INTERVAL_MINUTES} menit, aksi="${config.OVER_RESOURCE_ACTION}"`);
    setTimeout(checkOverResource, 2 * 60 * 1000); // cek pertama 2 menit setelah bot start
    setInterval(checkOverResource, config.RESOURCE_CHECK_INTERVAL_MINUTES * 60 * 1000);
  }

  // Server down detection
  if (config.SERVER_DOWN_CHECK_INTERVAL_MINUTES > 0) {
    logger.info("LAUNCH", `Server down check aktif: setiap ${config.SERVER_DOWN_CHECK_INTERVAL_MINUTES} menit`);
    setTimeout(checkServerDown, 2 * 60 * 1000); // mulai setelah 2 menit (beri waktu warm-up)
    setInterval(checkServerDown, config.SERVER_DOWN_CHECK_INTERVAL_MINUTES * 60 * 1000);
  }

  // Daily report — cek setiap jam
  setInterval(checkDailyReport, 60 * 60 * 1000);
  checkDailyReport();

  // Auto Backup — polling setiap 5 menit
  setInterval(checkAutoBackup, 5 * 60 * 1000);

  // ── Dashboard Web ──────────────────────────────────────────────────
  startDashboard();
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
