"use strict";

const http    = require("http");
const url     = require("url");
const crypto  = require("crypto");
const db      = require("./database");
const config  = require("./config");

// ─── Session Store (in-memory) ────────────────────────────────────────────────
const sessions = new Map();
  const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 jam
  function makeToken() { return crypto.randomBytes(32).toString("hex"); }
  function getSession(token) {
    const sess = sessions.get(token);
    if (!sess) return null;
    if (Date.now() - sess.at > SESSION_TTL) { sessions.delete(token); return null; }
    return sess;
  }
  function createSession() { const t = makeToken(); const csrf = makeToken().slice(0, 32); sessions.set(t, { at: Date.now(), csrf }); return t; }
  function getCsrf(token) { const s = sessions.get(token); return s ? s.csrf : null; }
  function destroySession(token) { sessions.delete(token); }
  setInterval(() => {
    const now = Date.now();
    for (const [token, sess] of sessions.entries()) {
      if (now - sess.at > SESSION_TTL) sessions.delete(token);
    }
  }, 30 * 60 * 1000);
// Brute force protection
  const loginAttempts = new Map(); // ip -> { count, blockedUntil }
  function checkBruteForce(ip) {
    const entry = loginAttempts.get(ip);
    if (!entry) return true;
    if (entry.blockedUntil && Date.now() < entry.blockedUntil) return false;
    if (entry.count >= 5) {
      entry.blockedUntil = Date.now() + 15 * 60 * 1000; // blokir 15 menit
      return false;
    }
    return true;
  }
  function recordFailedLogin(ip) {
    const entry = loginAttempts.get(ip) || { count: 0 };
    entry.count++;
    loginAttempts.set(ip, entry);
  }
  function resetLoginAttempts(ip) { loginAttempts.delete(ip); }
function parseCookie(str = "") {
  return Object.fromEntries(str.split(";").map(s => s.trim().split("=")).filter(p => p.length === 2).map(([k, v]) => [k.trim(), decodeURIComponent(v.trim())]));
}

// ─── Route helpers ────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise(res => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => {
      try { res(Object.fromEntries(new URLSearchParams(d))); }
      catch { res({}); }
    });
  });
}
function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "X-Frame-Options": "DENY" });
  res.end(body);
}
function sendJSON(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function redirect(res, loc) {
  res.writeHead(302, { Location: loc });
  res.end();
}
function he(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ─── Theme System ─────────────────────────────────────────────────────────────
const THEMES = {
  dark:    { bg: "#0f172a", panel: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "rgba(255,255,255,.1)", accent: "#6366f1", accent2: "#ec4899", accent3: "#10b981", name: "🌙 Dark" },
  light:   { bg: "#f8fafc", panel: "#ffffff", text: "#0f172a", muted: "#475569", border: "rgba(0,0,0,.08)", accent: "#4f46e5", accent2: "#db2777", accent3: "#059669", name: "☀️ Light" },
  neon:    { bg: "#0a0a0f", panel: "#13131f", text: "#e4e4ff", muted: "#9999cc", border: "rgba(0,255,255,.15)", accent: "#00ffff", accent2: "#ff00ff", accent3: "#39ff14", name: "💚 Neon" },
  sunset:  { bg: "#1a0f1f", panel: "#2a1530", text: "#fef3c7", muted: "#fbbf24", border: "rgba(251,191,36,.15)", accent: "#fb923c", accent2: "#f43f5e", accent3: "#facc15", name: "🌅 Sunset" },
  ocean:   { bg: "#001827", panel: "#003049", text: "#caf0f8", muted: "#90e0ef", border: "rgba(144,224,239,.15)", accent: "#00b4d8", accent2: "#0077b6", accent3: "#48cae4", name: "🌊 Ocean" },
  forest:  { bg: "#0d1f12", panel: "#1a3026", text: "#d4f1d4", muted: "#86efac", border: "rgba(134,239,172,.15)", accent: "#22c55e", accent2: "#84cc16", accent3: "#14b8a6", name: "🌲 Forest" },
  candy:   { bg: "#fff0f5", panel: "#ffe4ec", text: "#831843", muted: "#be185d", border: "rgba(190,24,93,.15)", accent: "#ec4899", accent2: "#a855f7", accent3: "#f97316", name: "🍭 Candy" },
};
function getTheme(cookies) { return THEMES[cookies?.db_theme] || THEMES.dark; }
function themeCss(t) {
    const bc = config.DASHBOARD_BUTTON_COLORS || {};
    const primary  = bc.primary  || t.accent;
    const success  = bc.success  || "#22c55e";
    const danger   = bc.danger   || "#ef4444";
    const warning  = bc.warning  || "#f59e0b";
    const info     = bc.info     || t.accent2;
    return `:root{--bg:${t.bg};--panel:${t.panel};--text:${t.text};--muted:${t.muted};--border:${t.border};--accent:${t.accent};--accent2:${t.accent2};--accent3:${t.accent3};
    --btn-primary:${primary};--btn-success:${success};--btn-danger:${danger};--btn-warning:${warning};--btn-info:${info};}
  body{background:var(--bg);color:var(--text);}
  .bg-panel{background:var(--panel);}
  .text-muted{color:var(--muted);}
  .border-themed{border-color:var(--border);}
  .text-accent{color:var(--accent);}
  .bg-accent{background:var(--accent);}
  .bg-accent2{background:var(--accent2);}
  .bg-accent3{background:var(--accent3);}
  .gradient-accent{background:linear-gradient(135deg,var(--accent) 0%,var(--accent2) 100%);}
  .glow{box-shadow:0 0 20px var(--accent);}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:1rem;backdrop-filter:blur(10px);}
  .btn-accent,.btn-primary{background:linear-gradient(135deg,var(--btn-primary),var(--accent2));color:#fff;padding:.5rem 1rem;border-radius:.5rem;font-weight:600;transition:transform .15s,box-shadow .15s;display:inline-flex;align-items:center;gap:.25rem;}
  .btn-accent:hover,.btn-primary:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.35);}
  .btn-success{background:linear-gradient(135deg,var(--btn-success),#16a34a);color:#fff;padding:.5rem 1rem;border-radius:.5rem;font-weight:600;transition:transform .15s,box-shadow .15s;display:inline-flex;align-items:center;gap:.25rem;}
  .btn-success:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(34,197,94,.35);}
  .btn-danger{background:linear-gradient(135deg,var(--btn-danger),#b91c1c);color:#fff;padding:.5rem 1rem;border-radius:.5rem;font-weight:600;transition:transform .15s,box-shadow .15s;display:inline-flex;align-items:center;gap:.25rem;}
  .btn-danger:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(239,68,68,.35);}
  .btn-warning{background:linear-gradient(135deg,var(--btn-warning),#d97706);color:#fff;padding:.5rem 1rem;border-radius:.5rem;font-weight:600;transition:transform .15s,box-shadow .15s;display:inline-flex;align-items:center;gap:.25rem;}
  .btn-warning:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(245,158,11,.35);}
  .btn-info{background:linear-gradient(135deg,var(--btn-info),var(--accent));color:#fff;padding:.5rem 1rem;border-radius:.5rem;font-weight:600;transition:transform .15s,box-shadow .15s;display:inline-flex;align-items:center;gap:.25rem;}
  .btn-info:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(56,189,248,.35);}
  .btn-sm{padding:.3rem .75rem;font-size:.8rem;}
  .badge-on{background:rgba(34,197,94,.2);color:#86efac;padding:.2rem .6rem;border-radius:.5rem;font-size:.75rem;font-weight:600;}
  .badge-off{background:rgba(239,68,68,.2);color:#fca5a5;padding:.2rem .6rem;border-radius:.5rem;font-size:.75rem;font-weight:600;}
  table tr:hover{background:var(--border);}
  input,select,textarea{background:var(--panel);color:var(--text);border:1px solid var(--border);}
  .theme-pill{display:inline-block;padding:.25rem .75rem;border-radius:9999px;font-size:.75rem;background:var(--accent);color:#fff;}`;
  }
function navHtml(theme, current = "/") {
  const items = [
    { href: "/dashboard", label: "📊 Dashboard", k: "/" },
    { href: "/audit",     label: "📜 Audit Logs", k: "/audit" },
    { href: "/topusage",  label: "🔥 Top Usage", k: "/topusage" },
    { href: "/users",     label: "👥 Users", k: "/users" },
    { href: "/uptime",    label: "📈 Uptime", k: "/uptime" },
  ];
  const themePicker = Object.entries(THEMES).map(([k, v]) => `<a href="/theme?set=${k}" class="px-2 py-1 rounded text-xs hover:opacity-80" style="background:${v.accent};color:#fff" title="${v.name}">${v.name.split(" ")[0]}</a>`).join(" ");
  return `<nav class="card mb-6 p-4 flex flex-wrap gap-3 items-center justify-between">
    <div class="flex flex-wrap gap-2">${items.map(i => `<a href="${i.href}" class="px-3 py-1.5 rounded-lg text-sm ${current === i.k ? "bg-accent text-white" : "hover:bg-themed text-muted"}">${i.label}</a>`).join("")}</div>
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-xs text-muted">Tema:</span>${themePicker}
      <a href="/logout" class="px-3 py-1.5 rounded-lg text-sm bg-accent2 text-white">🚪 Logout</a>
    </div>
  </nav>`;
}
function pageShell(title, body, theme, current = "/") {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${he(title)}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>${themeCss(theme)}</style>
</head><body class="min-h-screen p-4 md:p-6"><div class="max-w-7xl mx-auto">${navHtml(theme, current)}${body}</div></body></html>`;
}

// ─── HTML Pages ────────────────────────────────────────────────────────────────

function loginPage(err = "") {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Login — ${he(config.BOT_NAME || "CpanelBot")}</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { background: #0f0f1a; }
  .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.1); }
  @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
  .float { animation: float 4s ease-in-out infinite; }
  input:-webkit-autofill { -webkit-box-shadow: 0 0 0 30px #1e1e2e inset !important; -webkit-text-fill-color: #e2e8f0 !important; }
</style>
</head>
<body class="min-h-screen flex items-center justify-center relative overflow-hidden">
  <!-- Gradient orbs -->
  <div class="absolute top-[-20%] left-[-10%] w-96 h-96 rounded-full" style="background:radial-gradient(circle,rgba(99,102,241,0.3) 0%,transparent 70%);filter:blur(40px)"></div>
  <div class="absolute bottom-[-20%] right-[-10%] w-96 h-96 rounded-full" style="background:radial-gradient(circle,rgba(236,72,153,0.3) 0%,transparent 70%);filter:blur(40px)"></div>

  <div class="relative z-10 w-full max-w-md px-4">
    <div class="glass rounded-2xl p-8 shadow-2xl">
      <!-- Logo -->
      <div class="flex justify-center mb-6">
        <div class="float w-16 h-16 rounded-2xl flex items-center justify-center text-3xl" style="background:linear-gradient(135deg,#6366f1,#ec4899)">
          🤖
        </div>
      </div>

      <h1 class="text-center text-2xl font-bold text-white mb-1">${he(config.BOT_NAME || "CpanelBot")}</h1>
      <p class="text-center text-slate-400 text-sm mb-8">Dashboard Admin</p>

      ${err ? `<div class="mb-4 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#f87171"><span>⚠️</span>${he(err)}</div>` : ""}

      <form method="POST" action="/login">
        <div class="mb-4">
          <label class="block text-sm font-medium text-slate-400 mb-2">Password</label>
          <input type="password" name="password" autofocus
            class="w-full px-4 py-3 rounded-xl text-white text-sm outline-none transition-all"
            style="background:#1e1e2e;border:1px solid rgba(255,255,255,0.1)"
            onfocus="this.style.borderColor='rgba(99,102,241,0.7)'"
            onblur="this.style.borderColor='rgba(255,255,255,0.1)'"
            placeholder="Masukkan password dashboard">
        </div>
        <button type="submit"
          class="w-full py-3 rounded-xl font-semibold text-white transition-all hover:opacity-90 active:scale-95"
          style="background:linear-gradient(135deg,${(config.DASHBOARD_BUTTON_COLORS||{}).login||'#6366f1'},${(config.DASHBOARD_BUTTON_COLORS||{}).login2||'#ec4899'})">
          🔐 Masuk Dashboard
        </button>
      </form>

      <p class="text-center text-slate-600 text-xs mt-6">Password diatur di <code class="text-slate-500">config.js</code></p>
    </div>
  </div>
</body>
</html>`;
}

function dashboardPage() {
  const stats = db.getStats();
  const panels = db.getAllPanels();
  const users  = db.listAllUsers();
  const vouchers = db.getAllVouchers();
  const transactions = db.getAllTransactions(100);

  const activeP    = panels.filter(p => !p.suspended && !p.expired).length;
  const suspendedP = panels.filter(p => p.suspended).length;
  const expiredP   = panels.filter(p => p.expired && !p.suspended).length;
  const totalU     = Object.keys(users).length;
  const ownerU     = Object.values(users).filter(u => u.role === "owner").length;
  const premiumU   = Object.values(users).filter(u => u.role === "premium").length;
  const resellerU  = Object.values(users).filter(u => u.role === "reseller").length;
  const normalU    = totalU - ownerU - premiumU - resellerU;
  const blkU       = Object.values(users).filter(u => u.blacklisted).length;
  const activeV    = vouchers.filter(v => !v.deleted).length;

  const totalPoints = Object.keys(users).reduce((sum, uid) => sum + (db.getPoints(uid) || 0), 0);

  // Chart data
  const panelChartData = JSON.stringify([activeP, suspendedP, expiredP]);
  const userChartData  = JSON.stringify([ownerU, premiumU, resellerU, normalU]);

  // Build user rows
  const userRows = Object.entries(users).slice(0, 200).map(([uid, u]) => {
    const uPanels = panels.filter(p => String(p.userId) === String(uid));
    const pts = db.getPoints(uid) || 0;
    const roleColor = {owner:"indigo",premium:"yellow",reseller:"emerald",user:"slate"}[u.role] || "slate";
    return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
      <td class="px-4 py-3 text-slate-300 text-sm font-mono">${he(uid)}</td>
      <td class="px-4 py-3 text-slate-300 text-sm">${he(u.display_name || u.first_name || "—")}</td>
      <td class="px-4 py-3"><span class="px-2 py-1 rounded-lg text-xs font-semibold bg-${roleColor}-500/20 text-${roleColor}-300">${he(u.role || "user")}</span></td>
      <td class="px-4 py-3 text-slate-300 text-sm">${uPanels.length}</td>
      <td class="px-4 py-3 text-slate-300 text-sm">⭐ ${pts}</td>
      <td class="px-4 py-3">${u.blacklisted ? '<span class="px-2 py-1 rounded-lg text-xs font-semibold bg-red-500/20 text-red-300">🚫 Blacklist</span>' : '<span class="px-2 py-1 rounded-lg text-xs font-semibold bg-green-500/20 text-green-300">✅ Aktif</span>'}</td>
    </tr>`;
  }).join("");

  // Build panel rows
  const panelRows = panels.slice(0, 200).map(p => {
    const status = p.suspended ? "🔒 Suspended" : p.expired ? "🔴 Expired" : "🟢 Aktif";
    const statusColor = p.suspended ? "yellow" : p.expired ? "red" : "green";
    const exp = p.expire_date ? new Date(p.expire_date).toLocaleDateString("id-ID") : "—";
    return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
      <td class="px-4 py-3 text-slate-300 text-sm font-mono">${he(p.server_identifier || p.server_id || "—")}</td>
      <td class="px-4 py-3 text-slate-300 text-sm">${he(p.name || "—")}</td>
      <td class="px-4 py-3 text-slate-400 text-sm font-mono">${he(p.userId)}</td>
      <td class="px-4 py-3 text-slate-300 text-sm">${he(p.plan_name || "—")}</td>
      <td class="px-4 py-3 text-slate-400 text-sm">${exp}</td>
      <td class="px-4 py-3"><span class="px-2 py-1 rounded-lg text-xs font-semibold bg-${statusColor}-500/20 text-${statusColor}-300">${status}</span></td>
    </tr>`;
  }).join("");

  // Build transaction rows
  const txRows = transactions.slice(0, 100).map(t => {
    const at = t.at ? new Date(t.at).toLocaleString("id-ID") : "—";
    return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
      <td class="px-4 py-3 text-slate-400 text-xs">${at}</td>
      <td class="px-4 py-3 text-slate-300 text-sm font-mono">${he(t.userId || "—")}</td>
      <td class="px-4 py-3 text-slate-300 text-sm">${he(t.type || "—")}</td>
      <td class="px-4 py-3 text-slate-400 text-sm">${he(t.detail || "—")}</td>
    </tr>`;
  }).join("");

  // Build voucher rows
  const voucherRows = vouchers.map(v => {
    const typeColor = {days:"blue",discount:"purple",role:"emerald"}[v.type] || "slate";
    const usedPct = v.max_uses > 0 ? Math.round((v.uses / v.max_uses) * 100) : 0;
    return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
      <td class="px-4 py-3 text-white text-sm font-mono font-semibold">${he(v.code)}</td>
      <td class="px-4 py-3"><span class="px-2 py-1 rounded-lg text-xs font-semibold bg-${typeColor}-500/20 text-${typeColor}-300">${he(v.type)}</span></td>
      <td class="px-4 py-3 text-slate-300 text-sm">${v.type === "days" ? `${v.days} hari` : v.type === "discount" ? `${v.discount}%` : v.role || "—"}</td>
      <td class="px-4 py-3 text-slate-400 text-sm">${v.uses || 0} / ${v.max_uses || "∞"}</td>
      <td class="px-4 py-3">
        ${v.max_uses > 0 ? `<div class="w-full bg-white/10 rounded-full h-1.5"><div class="h-1.5 rounded-full bg-indigo-500" style="width:${usedPct}%"></div></div>` : '<span class="text-slate-600 text-xs">unlimited</span>'}
      </td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — ${he(config.BOT_NAME || "CpanelBot")}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; }
  body { background: #0f0f1a; font-family: 'Segoe UI', system-ui, sans-serif; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
  .glass { background: rgba(255,255,255,0.04); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); }
  .glass-hover:hover { background: rgba(255,255,255,0.07); }
  .stat-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); transition: transform .2s, box-shadow .2s; }
  .stat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
  @keyframes fadeIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }
  .fade-in { animation: fadeIn .4s ease-out both; }
  .tab-btn.active { background: rgba(99,102,241,0.2); color: #a5b4fc; border-color: rgba(99,102,241,0.5); }
  .sidebar-item.active { background: rgba(99,102,241,0.15); border-right: 2px solid #6366f1; }
  @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:.5} }
  .live-dot { animation: pulse-dot 2s infinite; }
</style>
</head>
<body class="text-white min-h-screen">

<!-- Layout -->
<div class="flex min-h-screen">

  <!-- Sidebar -->
  <aside class="w-60 flex-shrink-0 border-r border-white/5" style="background:#13131f">
    <div class="p-5 border-b border-white/5">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0" style="background:linear-gradient(135deg,#6366f1,#ec4899)">🤖</div>
        <div class="min-w-0">
          <div class="font-bold text-sm truncate">${he(config.BOT_NAME || "CpanelBot")}</div>
          <div class="text-xs text-slate-500">Admin Dashboard</div>
        </div>
      </div>
    </div>

    <nav class="p-3 space-y-1">
      <a href="#overview" onclick="showTab('overview')" id="nav-overview" class="sidebar-item active flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:text-white cursor-pointer transition-all">
        <span>📊</span> Overview
      </a>
      <a href="#users" onclick="showTab('users')" id="nav-users" class="sidebar-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:text-white cursor-pointer transition-all">
        <span>👥</span> Users <span class="ml-auto text-xs bg-white/10 px-2 py-0.5 rounded-full">${totalU}</span>
      </a>
      <a href="#panels" onclick="showTab('panels')" id="nav-panels" class="sidebar-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:text-white cursor-pointer transition-all">
        <span>🖥️</span> Panels <span class="ml-auto text-xs bg-white/10 px-2 py-0.5 rounded-full">${panels.length}</span>
      </a>
      <a href="#vouchers" onclick="showTab('vouchers')" id="nav-vouchers" class="sidebar-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:text-white cursor-pointer transition-all">
        <span>🎟️</span> Vouchers <span class="ml-auto text-xs bg-white/10 px-2 py-0.5 rounded-full">${vouchers.length}</span>
      </a>
      <a href="#transactions" onclick="showTab('transactions')" id="nav-transactions" class="sidebar-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:text-white cursor-pointer transition-all">
        <span>📜</span> Transaksi
      </a>
    </nav>

    <div class="absolute bottom-0 left-0 w-60 p-3 border-t border-white/5" style="background:#13131f">
      <div class="mb-2 px-3 py-2 rounded-lg text-xs text-slate-500 flex items-center gap-2">
        <span class="live-dot w-2 h-2 rounded-full bg-green-400 flex-shrink-0"></span>
        Bot berjalan
      </div>
      <a href="/logout" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-red-400 hover:bg-red-500/10 cursor-pointer transition-all">
        <span>🚪</span> Logout
      </a>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="flex-1 overflow-auto p-6" style="background:#0f0f1a">

    <!-- Header -->
    <div class="flex items-center justify-between mb-8 fade-in">
      <div>
        <h1 class="text-2xl font-bold">Dashboard</h1>
        <p class="text-slate-500 text-sm mt-0.5">Pantau semua aktivitas bot secara real-time</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs text-slate-500" id="last-refresh">Dimuat: ${new Date().toLocaleTimeString("id-ID")}</span>
        <button onclick="location.reload()" class="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white transition-all glass glass-hover">
          🔄 Refresh
        </button>
      </div>
    </div>

    <!-- ── OVERVIEW TAB ── -->
    <div id="tab-overview">

      <!-- Stat Cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div class="stat-card rounded-2xl p-5 fade-in" style="animation-delay:.05s">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style="background:rgba(99,102,241,0.2)">👥</div>
            <span class="text-xs text-slate-500">Total</span>
          </div>
          <div class="text-3xl font-bold text-white">${totalU}</div>
          <div class="text-sm text-slate-400 mt-1">Total Users</div>
          <div class="text-xs text-red-400 mt-1">🚫 ${blkU} diblacklist</div>
        </div>

        <div class="stat-card rounded-2xl p-5 fade-in" style="animation-delay:.1s">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style="background:rgba(34,197,94,0.2)">🟢</div>
            <span class="text-xs text-slate-500">Aktif</span>
          </div>
          <div class="text-3xl font-bold text-green-400">${activeP}</div>
          <div class="text-sm text-slate-400 mt-1">Panel Aktif</div>
          <div class="text-xs text-slate-500 mt-1">dari ${panels.length} total panel</div>
        </div>

        <div class="stat-card rounded-2xl p-5 fade-in" style="animation-delay:.15s">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style="background:rgba(234,179,8,0.2)">🔒</div>
            <span class="text-xs text-slate-500">Suspended</span>
          </div>
          <div class="text-3xl font-bold text-yellow-400">${suspendedP}</div>
          <div class="text-sm text-slate-400 mt-1">Panel Suspended</div>
          <div class="text-xs text-red-400 mt-1">🔴 ${expiredP} expired</div>
        </div>

        <div class="stat-card rounded-2xl p-5 fade-in" style="animation-delay:.2s">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style="background:rgba(236,72,153,0.2)">⭐</div>
            <span class="text-xs text-slate-500">Poin</span>
          </div>
          <div class="text-3xl font-bold text-pink-400">${totalPoints}</div>
          <div class="text-sm text-slate-400 mt-1">Total Poin User</div>
          <div class="text-xs text-slate-500 mt-1">🎟️ ${activeV} voucher aktif</div>
        </div>
      </div>

      <!-- Charts row -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">

        <!-- Panel status chart -->
        <div class="glass rounded-2xl p-5 fade-in" style="animation-delay:.25s">
          <div class="text-sm font-semibold text-slate-300 mb-4">📊 Status Panel</div>
          <div class="relative h-48">
            <canvas id="panelChart"></canvas>
          </div>
          <div class="flex flex-wrap gap-2 mt-4 justify-center">
            <span class="flex items-center gap-1.5 text-xs text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-green-400 inline-block"></span>Aktif (${activeP})</span>
            <span class="flex items-center gap-1.5 text-xs text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-yellow-400 inline-block"></span>Suspended (${suspendedP})</span>
            <span class="flex items-center gap-1.5 text-xs text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-red-400 inline-block"></span>Expired (${expiredP})</span>
          </div>
        </div>

        <!-- User role chart -->
        <div class="glass rounded-2xl p-5 fade-in" style="animation-delay:.3s">
          <div class="text-sm font-semibold text-slate-300 mb-4">🎭 Distribusi Role</div>
          <div class="relative h-48">
            <canvas id="userChart"></canvas>
          </div>
          <div class="flex flex-wrap gap-2 mt-4 justify-center">
            <span class="flex items-center gap-1.5 text-xs text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-indigo-400 inline-block"></span>Owner (${ownerU})</span>
            <span class="flex items-center gap-1.5 text-xs text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-yellow-400 inline-block"></span>Premium (${premiumU})</span>
            <span class="flex items-center gap-1.5 text-xs text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block"></span>Reseller (${resellerU})</span>
            <span class="flex items-center gap-1.5 text-xs text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-slate-400 inline-block"></span>User (${normalU})</span>
          </div>
        </div>

        <!-- Quick stats -->
        <div class="glass rounded-2xl p-5 fade-in" style="animation-delay:.35s">
          <div class="text-sm font-semibold text-slate-300 mb-4">⚡ Info Sistem</div>
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Bot Name</span>
              <span class="text-xs text-slate-300 font-medium">${he(config.BOT_NAME || "—")}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Panel URL</span>
              <a href="${he(config.PANEL_URL || "#")}" target="_blank" class="text-xs text-indigo-400 hover:underline truncate max-w-28">${he((config.PANEL_URL || "").replace("https://","").replace("http://",""))}</a>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Trial</span>
              <span class="text-xs px-2 py-0.5 rounded-full ${db.getTrialEnabled() ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}">${db.getTrialEnabled() ? "🟢 ON" : "🔴 OFF"}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Referral</span>
              <span class="text-xs px-2 py-0.5 rounded-full ${db.getReferralEnabled() ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}">${db.getReferralEnabled() ? "🟢 ON" : "🔴 OFF"}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Maintenance</span>
              <span class="text-xs px-2 py-0.5 rounded-full ${db.getMaintenanceMode() ? "bg-red-500/20 text-red-300" : "bg-green-500/20 text-green-300"}">${db.getMaintenanceMode() ? "🔴 Aktif" : "🟢 Normal"}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Whitelist</span>
              <span class="text-xs px-2 py-0.5 rounded-full ${db.getWhitelistMode() ? "bg-yellow-500/20 text-yellow-300" : "bg-green-500/20 text-green-300"}">${db.getWhitelistMode() ? "🔒 ON" : "🟢 OFF"}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Auto Delete</span>
              <span class="text-xs text-slate-300">${config.AUTO_DELETE_DAYS || 0} hari</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">Voucher aktif</span>
              <span class="text-xs text-slate-300">${activeV} kode</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Recent Transactions -->
      <div class="glass rounded-2xl fade-in" style="animation-delay:.4s">
        <div class="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <div class="text-sm font-semibold text-slate-300">📜 Transaksi Terbaru</div>
          <a href="#transactions" onclick="showTab('transactions')" class="text-xs text-indigo-400 hover:underline">Lihat semua</a>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr class="border-b border-white/5">
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Waktu</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">User ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Tipe</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Detail</th>
            </tr></thead>
            <tbody>${transactions.slice(0, 8).map(t => {
              const at = t.at ? new Date(t.at).toLocaleString("id-ID") : "—";
              return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td class="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">${he(at)}</td>
                <td class="px-4 py-3 text-slate-300 text-sm font-mono">${he(t.userId || "—")}</td>
                <td class="px-4 py-3 text-slate-300 text-sm">${he(t.type || "—")}</td>
                <td class="px-4 py-3 text-slate-400 text-sm">${he(t.detail || "—")}</td>
              </tr>`;
            }).join("")}</tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── USERS TAB ── -->
    <div id="tab-users" class="hidden">
      <div class="glass rounded-2xl">
        <div class="px-5 py-4 border-b border-white/5 flex items-center justify-between flex-wrap gap-3">
          <div class="text-sm font-semibold text-slate-300">👥 Semua User (${totalU})</div>
          <input id="userSearch" type="search" placeholder="Cari ID / nama..." oninput="filterTable('userSearch','userTable')"
            class="px-3 py-1.5 rounded-xl text-sm text-white outline-none w-48"
            style="background:#1e1e2e;border:1px solid rgba(255,255,255,0.1)">
        </div>
        <div class="overflow-x-auto">
          <table class="w-full" id="userTable">
            <thead><tr class="border-b border-white/5">
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Nama</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Role</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Panel</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Poin</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Status</th>
            </tr></thead>
            <tbody>${userRows || '<tr><td colspan="6" class="text-center py-8 text-slate-500">Belum ada user</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── PANELS TAB ── -->
    <div id="tab-panels" class="hidden">
      <div class="glass rounded-2xl">
        <div class="px-5 py-4 border-b border-white/5 flex items-center justify-between flex-wrap gap-3">
          <div class="text-sm font-semibold text-slate-300">🖥️ Semua Panel (${panels.length})</div>
          <div class="flex items-center gap-2">
            <input id="panelSearch" type="search" placeholder="Cari nama / ID..." oninput="filterTable('panelSearch','panelTable')"
              class="px-3 py-1.5 rounded-xl text-sm text-white outline-none w-48"
              style="background:#1e1e2e;border:1px solid rgba(255,255,255,0.1)">
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full" id="panelTable">
            <thead><tr class="border-b border-white/5">
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Identifier</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Nama</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">User ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Plan</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Expired</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Status</th>
            </tr></thead>
            <tbody>${panelRows || '<tr><td colspan="6" class="text-center py-8 text-slate-500">Belum ada panel</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── VOUCHERS TAB ── -->
    <div id="tab-vouchers" class="hidden">
      <div class="glass rounded-2xl">
        <div class="px-5 py-4 border-b border-white/5">
          <div class="text-sm font-semibold text-slate-300">🎟️ Semua Voucher (${vouchers.length})</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr class="border-b border-white/5">
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Kode</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Tipe</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Nilai</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Pemakaian</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Progress</th>
            </tr></thead>
            <tbody>${voucherRows || '<tr><td colspan="5" class="text-center py-8 text-slate-500">Belum ada voucher</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── TRANSACTIONS TAB ── -->
    <div id="tab-transactions" class="hidden">
      <div class="glass rounded-2xl">
        <div class="px-5 py-4 border-b border-white/5 flex items-center justify-between flex-wrap gap-3">
          <div class="text-sm font-semibold text-slate-300">📜 Riwayat Transaksi (100 terbaru)</div>
          <input id="txSearch" type="search" placeholder="Cari..." oninput="filterTable('txSearch','txTable')"
            class="px-3 py-1.5 rounded-xl text-sm text-white outline-none w-48"
            style="background:#1e1e2e;border:1px solid rgba(255,255,255,0.1)">
        </div>
        <div class="overflow-x-auto">
          <table class="w-full" id="txTable">
            <thead><tr class="border-b border-white/5">
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Waktu</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">User ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Tipe</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Detail</th>
            </tr></thead>
            <tbody>${txRows || '<tr><td colspan="4" class="text-center py-8 text-slate-500">Belum ada transaksi</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>

  </main>
</div>

<script>
// ── Charts ────────────────────────────────────────────────────────────────────
const chartDefaults = {
  plugins: { legend: { display: false } },
  cutout: "70%",
};

new Chart(document.getElementById("panelChart"), {
  type: "doughnut",
  data: {
    labels: ["Aktif", "Suspended", "Expired"],
    datasets: [{
      data: ${panelChartData},
      backgroundColor: ["rgba(34,197,94,0.8)", "rgba(234,179,8,0.8)", "rgba(239,68,68,0.8)"],
      borderColor: "transparent",
      hoverOffset: 4,
    }]
  },
  options: { ...chartDefaults, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.label + ": " + ctx.raw } } } }
});

new Chart(document.getElementById("userChart"), {
  type: "doughnut",
  data: {
    labels: ["Owner", "Premium", "Reseller", "User"],
    datasets: [{
      data: ${userChartData},
      backgroundColor: ["rgba(99,102,241,0.8)", "rgba(234,179,8,0.8)", "rgba(52,211,153,0.8)", "rgba(148,163,184,0.8)"],
      borderColor: "transparent",
      hoverOffset: 4,
    }]
  },
  options: { ...chartDefaults, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.label + ": " + ctx.raw } } } }
});

// ── Tab navigation ────────────────────────────────────────────────────────────
function showTab(name) {
  ["overview","users","panels","vouchers","transactions"].forEach(t => {
    document.getElementById("tab-" + t).classList.toggle("hidden", t !== name);
    const nav = document.getElementById("nav-" + t);
    if (nav) nav.classList.toggle("active", t === name);
  });
}

// ── Table search ──────────────────────────────────────────────────────────────
function filterTable(inputId, tableId) {
  const q = document.getElementById(inputId).value.toLowerCase();
  const rows = document.querySelectorAll("#" + tableId + " tbody tr");
  rows.forEach(r => r.style.display = r.textContent.toLowerCase().includes(q) ? "" : "none");
}

// ── Auto refresh countdown ────────────────────────────────────────────────────
let countdown = 60;
setInterval(() => {
  countdown--;
  if (countdown <= 0) location.reload();
  const el = document.getElementById("last-refresh");
  if (el) el.textContent = "Auto refresh dalam " + countdown + "s";
}, 1000);

// Handle hash navigation
if (location.hash) showTab(location.hash.slice(1));
</script>
</body>
</html>`;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
function startDashboard() {
  // Auto-detect port: SERVER_PORT (Pterodactyl) → PORT (generic) → config → disabled
  const port = parseInt(process.env.SERVER_PORT || process.env.PORT || config.DASHBOARD_PORT || "0");
  const pass = config.DASHBOARD_PASSWORD || "admin123";

  if (!port || port < 1) {
    console.log("[Dashboard] Dinonaktifkan. Set DASHBOARD_PORT di config.js untuk aktifkan.");
    return;
  }

  const server = http.createServer(async (req, res) => {
    const parsed  = url.parse(req.url, true);
    const path_   = parsed.pathname;
    const cookies = parseCookie(req.headers.cookie || "");
    const token   = cookies["db_session"] || "";
    const authed  = !!getSession(token);

    // ── Static routes ──────────────────────────────────────────────
    if (path_ === "/logout") {
      destroySession(token);
      res.writeHead(302, { Location: "/", "Set-Cookie": "db_session=; Max-Age=0; Path=/" });
      return res.end();
    }

    // ── Login ──────────────────────────────────────────────────────
    if (path_ === "/login" && req.method === "POST") {
        const ip = req.socket?.remoteAddress || "unknown";
        if (!checkBruteForce(ip)) {
          return send(res, 429, loginPage("⏳ Terlalu banyak percobaan login. Coba lagi dalam 15 menit."));
        }
        const body = await parseBody(req);
        if (body.password === pass) {
          resetLoginAttempts(ip);
          const tok = createSession();
          res.writeHead(302, {
            Location: "/",
            "Set-Cookie": `db_session=${tok}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
          });
          return res.end();
        }
        recordFailedLogin(ip);
        return send(res, 401, loginPage("❌ Password salah!"));
      }

    if (path_ === "/login") return send(res, 200, loginPage());

    // ── Auth gate ──────────────────────────────────────────────────
    if (!authed) return send(res, 200, loginPage());

    // ── API endpoints ──────────────────────────────────────────────
    if (path_ === "/api/stats") {
      const panels = db.getAllPanels();
      const users  = db.listAllUsers();
      return sendJSON(res, {
        totalUsers:    Object.keys(users).length,
        activePanel:   panels.filter(p => !p.suspended && !p.expired).length,
        suspendedPanel:panels.filter(p => p.suspended).length,
        expiredPanel:  panels.filter(p => p.expired && !p.suspended).length,
        totalPanel:    panels.length,
        vouchers:      db.getAllVouchers().length,
        maintenance:   db.getMaintenanceMode(),
        trial:         db.getTrialEnabled(),
        referral:      db.getReferralEnabled(),
      });
    }

    // ── Theme toggle ──────────────────────────────────────────────
    if (path_ === "/theme") {
      const newTheme = parsed.query.set || "dark";
      if (THEMES[newTheme]) {
        res.writeHead(302, {
          Location: req.headers.referer || "/dashboard",
          "Set-Cookie": `db_theme=${newTheme}; Path=/; Max-Age=2592000; SameSite=Lax`,
        });
        return res.end();
      }
      return redirect(res, "/dashboard");
    }

    // ── Dashboard ──────────────────────────────────────────────────
    if (path_ === "/" || path_ === "/dashboard") {
      return send(res, 200, dashboardPage());
    }

    // ── Audit Log Explorer ────────────────────────────────────────
    if (path_ === "/audit") {
      const theme = getTheme(cookies);
      const filter = (parsed.query.q || "").toLowerCase();
      const logs = (db.getAuditLogs(500) || []).filter(l => !filter || JSON.stringify(l).toLowerCase().includes(filter));
      const rows = logs.map(l => `<tr class="border-b border-themed">
        <td class="px-3 py-2 text-xs text-muted">${he(new Date(l.timestamp || l.t || Date.now()).toLocaleString("id-ID"))}</td>
        <td class="px-3 py-2 text-sm"><span class="theme-pill">${he(l.actorId)}</span></td>
        <td class="px-3 py-2 text-sm font-semibold">${he(l.action)}</td>
        <td class="px-3 py-2 text-xs font-mono">${he(l.target || "-")}</td>
        <td class="px-3 py-2 text-xs text-muted">${he(JSON.stringify(l.meta || {}))}</td>
      </tr>`).join("");
      const body = `<div class="card p-6">
        <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h1 class="text-2xl font-bold">📜 Audit Log Explorer</h1>
          <form class="flex gap-2"><input name="q" value="${he(filter)}" placeholder="Cari..." class="px-3 py-2 rounded-lg"/><button class="btn-primary btn-sm">🔍 Filter</button>
          <a href="/audit/export" class="btn-success btn-sm">📥 Export CSV</a></form>
        </div>
        <p class="text-muted text-sm mb-4">Total: ${logs.length} entri</p>
        <div class="overflow-x-auto">
          <table class="w-full"><thead><tr class="border-b-2 border-themed"><th class="px-3 py-2 text-left text-xs">Waktu</th><th class="px-3 py-2 text-left text-xs">Actor</th><th class="px-3 py-2 text-left text-xs">Aksi</th><th class="px-3 py-2 text-left text-xs">Target</th><th class="px-3 py-2 text-left text-xs">Meta</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="text-center py-8 text-muted">Tidak ada log.</td></tr>'}</tbody></table>
        </div>
      </div>`;
      return send(res, 200, pageShell("Audit Logs", body, theme, "/audit"));
    }

    if (path_ === "/audit/export") {
      const logs = db.getAuditLogs(5000) || [];
      const csv = "timestamp,actorId,action,target,meta\n" + logs.map(l => `"${new Date(l.timestamp||Date.now()).toISOString()}","${l.actorId}","${l.action}","${l.target||""}","${JSON.stringify(l.meta||{}).replace(/"/g,'""')}"`).join("\n");
      res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename=audit-${Date.now()}.csv` });
      return res.end(csv);
    }

    // ── Top Usage Page ────────────────────────────────────────────
    if (path_ === "/topusage") {
      const theme = getTheme(cookies);
      const top = db.getTopResourceConsumers(20);
      const rows = top.map((p, i) => {
        const panel = db.getPanelByServerId(p.serverId);
        const name = panel?.username || panel?.serverName || p.serverId.substring(0, 12);
        const colors = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e"];
        const c = colors[i % colors.length];
        return `<tr class="border-b border-themed">
          <td class="px-3 py-3"><div class="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold" style="background:${c}">${i+1}</div></td>
          <td class="px-3 py-3"><div class="font-bold">${he(name)}</div><div class="text-xs text-muted font-mono">${he(p.serverId)}</div></td>
          <td class="px-3 py-3"><div class="flex items-center gap-2"><div class="flex-1 bg-themed rounded-full h-3 overflow-hidden" style="background:rgba(255,255,255,.1)"><div style="background:linear-gradient(90deg,#10b981,#f59e0b,#ef4444);width:${Math.min(100,p.cpu)}%;height:100%"></div></div><span class="text-sm w-12">${p.cpu.toFixed(0)}%</span></div></td>
          <td class="px-3 py-3"><div class="flex items-center gap-2"><div class="flex-1 bg-themed rounded-full h-3 overflow-hidden" style="background:rgba(255,255,255,.1)"><div style="background:linear-gradient(90deg,#3b82f6,#8b5cf6,#ec4899);width:${Math.min(100,p.ram)}%;height:100%"></div></div><span class="text-sm w-12">${p.ram.toFixed(0)}%</span></div></td>
          <td class="px-3 py-3"><div class="flex items-center gap-2"><div class="flex-1 bg-themed rounded-full h-3 overflow-hidden" style="background:rgba(255,255,255,.1)"><div style="background:linear-gradient(90deg,#06b6d4,#10b981);width:${Math.min(100,p.disk)}%;height:100%"></div></div><span class="text-sm w-12">${p.disk.toFixed(0)}%</span></div></td>
          <td class="px-3 py-3"><a href="/server?id=${p.serverId}" class="btn-info btn-sm">📈 Detail</a></td>
        </tr>`;
      }).join("");
      const body = `<div class="card p-6">
        <h1 class="text-2xl font-bold mb-2">🔥 Top Resource Consumer</h1>
        <p class="text-muted text-sm mb-6">Server dengan penggunaan resource tertinggi (real-time)</p>
        <div class="overflow-x-auto"><table class="w-full">
          <thead><tr class="border-b-2 border-themed"><th class="px-3 py-2 text-left text-xs">#</th><th class="px-3 py-2 text-left text-xs">Server</th><th class="px-3 py-2 text-left text-xs">🔥 CPU</th><th class="px-3 py-2 text-left text-xs">🧠 RAM</th><th class="px-3 py-2 text-left text-xs">💾 Disk</th><th class="px-3 py-2 text-left text-xs">Aksi</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="text-center py-8 text-muted">Belum ada data resource (monitoring belum jalan).</td></tr>'}</tbody>
        </table></div>
      </div>`;
      return send(res, 200, pageShell("Top Usage", body, theme, "/topusage"));
    }

    // ── Uptime Page ───────────────────────────────────────────────
    if (path_ === "/uptime") {
      const theme = getTheme(cookies);
      const panels = db.getAllPanels();
      const rows = panels.map(p => {
        const up = db.getUptimePercent(p.serverId, 30);
        const upStr = up !== null ? `${up.toFixed(1)}%` : "—";
        const c = up === null ? "#64748b" : up >= 99 ? "#10b981" : up >= 95 ? "#f59e0b" : "#ef4444";
        const name = p.username || p.serverName || p.serverId.substring(0, 12);
        return `<tr class="border-b border-themed">
          <td class="px-3 py-2 font-semibold">${he(name)}</td>
          <td class="px-3 py-2 font-mono text-xs">${he(p.serverId)}</td>
          <td class="px-3 py-2 font-mono text-xs">${he(p.userId)}</td>
          <td class="px-3 py-2"><div class="flex items-center gap-2"><div class="w-3 h-3 rounded-full" style="background:${c}"></div><span class="font-bold" style="color:${c}">${upStr}</span></div></td>
          <td class="px-3 py-2"><a href="/server?id=${p.serverId}" class="text-accent underline text-xs">Lihat Graph →</a></td>
        </tr>`;
      }).join("");
      const body = `<div class="card p-6">
        <h1 class="text-2xl font-bold mb-2">📈 Uptime Tracker (30 Hari)</h1>
        <p class="text-muted text-sm mb-6"><span class="inline-block w-3 h-3 rounded-full bg-green-500 mr-1"></span>≥99% &nbsp; <span class="inline-block w-3 h-3 rounded-full bg-yellow-500 mr-1"></span>95-98% &nbsp; <span class="inline-block w-3 h-3 rounded-full bg-red-500 mr-1"></span>&lt;95%</p>
        <div class="overflow-x-auto"><table class="w-full">
          <thead><tr class="border-b-2 border-themed"><th class="px-3 py-2 text-left text-xs">Panel</th><th class="px-3 py-2 text-left text-xs">Server ID</th><th class="px-3 py-2 text-left text-xs">User ID</th><th class="px-3 py-2 text-left text-xs">Uptime</th><th class="px-3 py-2 text-left text-xs"></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="text-center py-8 text-muted">Belum ada panel.</td></tr>'}</tbody>
        </table></div>
      </div>`;
      return send(res, 200, pageShell("Uptime", body, theme, "/uptime"));
    }

    // ── Users Page (with impersonation) ────────────────────────────
    if (path_ === "/users") {
      const theme = getTheme(cookies);
      const users = db.listAllUsers();
      const rows = Object.entries(users).map(([uid, u]) => {
        const role = u.role || "user";
        const panels = (db.getUserPanels(uid) || []).length;
        const points = db.getPoints(uid);
        const dev = db.getDeviceLog(uid);
        const ach = db.getAchievements(uid).length;
        const roleColors = { owner: "#f43f5e", premium: "#fbbf24", reseller: "#8b5cf6", user: "#64748b" };
        return `<tr class="border-b border-themed">
          <td class="px-3 py-2 font-mono text-xs">${he(uid)}</td>
          <td class="px-3 py-2"><span class="px-2 py-1 rounded-full text-xs text-white" style="background:${roleColors[role]||"#64748b"}">${role}</span></td>
          <td class="px-3 py-2 text-center">${panels}</td>
          <td class="px-3 py-2 text-center">${points}</td>
          <td class="px-3 py-2 text-center">${ach} 🏆</td>
          <td class="px-3 py-2 text-xs text-muted">${dev?.username ? "@"+he(dev.username) : "-"}</td>
          <td class="px-3 py-2"><a href="/viewuser?id=${uid}" class="btn-info btn-sm">👁 View</a></td>
        </tr>`;
      }).join("");
      const body = `<div class="card p-6">
        <h1 class="text-2xl font-bold mb-2">👥 Users Management</h1>
        <p class="text-muted text-sm mb-6">Total: ${Object.keys(users).length} user terdaftar</p>
        <div class="overflow-x-auto"><table class="w-full">
          <thead><tr class="border-b-2 border-themed"><th class="px-3 py-2 text-left text-xs">User ID</th><th class="px-3 py-2 text-left text-xs">Role</th><th class="px-3 py-2 text-center text-xs">Panel</th><th class="px-3 py-2 text-center text-xs">⭐ Poin</th><th class="px-3 py-2 text-center text-xs">🏆</th><th class="px-3 py-2 text-left text-xs">Username</th><th class="px-3 py-2 text-left text-xs"></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="text-center py-8 text-muted">Belum ada user.</td></tr>'}</tbody>
        </table></div>
      </div>`;
      return send(res, 200, pageShell("Users", body, theme, "/users"));
    }

    // ── User Impersonation View (#34) ──────────────────────────────
    if (path_ === "/viewuser") {
      const theme = getTheme(cookies);
      const uid = parsed.query.id;
      if (!uid) return redirect(res, "/users");
      const u = db.getUser(uid) || {};
      const role = db.getRole(uid);
      const panels = db.getUserPanels(uid) || [];
      const points = db.getPoints(uid);
      const dev = db.getDeviceLog(uid);
      const ach = db.getAchievements(uid);
      const friends = db.getFriends(uid);
      const txns = db.getUserTransactions(uid) || [];
      const tickets = db.getUserTickets(uid) || [];

      const panelRows = panels.map(p => `<tr class="border-b border-themed">
        <td class="px-3 py-2 font-semibold">${he(p.username || p.serverName || "-")}</td>
        <td class="px-3 py-2 font-mono text-xs">${he(p.serverId)}</td>
        <td class="px-3 py-2 text-xs">${he(p.expireDate || "-")}</td>
        <td class="px-3 py-2"><span class="theme-pill" style="background:${p.suspended?"#ef4444":p.expired?"#f59e0b":"#10b981"}">${p.suspended?"Suspended":p.expired?"Expired":"Aktif"}</span></td>
        <td class="px-3 py-2"><a href="/server?id=${p.serverId}" class="text-accent underline text-xs">Graph →</a></td>
      </tr>`).join("") || `<tr><td colspan="5" class="text-center py-4 text-muted">Belum ada panel.</td></tr>`;

      const body = `<div class="space-y-6">
        <div class="card p-6 gradient-accent text-white">
          <h1 class="text-2xl font-bold mb-2">👤 View as User</h1>
          <p class="opacity-90">Impersonation read-only — owner melihat sudut pandang user</p>
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <div class="card p-5">
            <h2 class="font-bold mb-3">📋 Profil</h2>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between"><span class="text-muted">User ID:</span><span class="font-mono">${he(uid)}</span></div>
              <div class="flex justify-between"><span class="text-muted">Role:</span><span class="theme-pill">${he(role)}</span></div>
              <div class="flex justify-between"><span class="text-muted">⭐ Poin:</span><span class="font-bold text-accent">${points}</span></div>
              <div class="flex justify-between"><span class="text-muted">🏠 Total Panel:</span><span class="font-bold">${panels.length}</span></div>
              <div class="flex justify-between"><span class="text-muted">🤝 Teman:</span><span>${friends.length}</span></div>
              <div class="flex justify-between"><span class="text-muted">🏆 Achievement:</span><span>${ach.length}</span></div>
            </div>
          </div>
          <div class="card p-5">
            <h2 class="font-bold mb-3">📱 Device Info</h2>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between"><span class="text-muted">Username:</span><span>@${he(dev?.username || "-")}</span></div>
              <div class="flex justify-between"><span class="text-muted">Bahasa:</span><span>${he(dev?.language_code || "-")}</span></div>
              <div class="flex justify-between"><span class="text-muted">Tipe Chat:</span><span>${he(dev?.chat_type || "-")}</span></div>
              <div class="flex justify-between"><span class="text-muted">First Seen:</span><span class="text-xs">${dev?.first_seen ? new Date(dev.first_seen).toLocaleString("id-ID") : "-"}</span></div>
              <div class="flex justify-between"><span class="text-muted">Last Seen:</span><span class="text-xs">${dev?.last_seen ? new Date(dev.last_seen).toLocaleString("id-ID") : "-"}</span></div>
              <div class="flex justify-between"><span class="text-muted">💳 Transaksi:</span><span>${txns.length}</span></div>
              <div class="flex justify-between"><span class="text-muted">🎫 Tiket:</span><span>${tickets.length}</span></div>
            </div>
          </div>
        </div>
        <div class="card p-5">
          <h2 class="font-bold mb-3">🏆 Achievements</h2>
          <div class="flex flex-wrap gap-2">${ach.length ? ach.map(a => `<span class="theme-pill">${he(a)}</span>`).join("") : '<span class="text-muted text-sm">Belum ada achievement.</span>'}</div>
        </div>
        <div class="card p-5">
          <h2 class="font-bold mb-3">🏠 Daftar Panel</h2>
          <div class="overflow-x-auto"><table class="w-full">
            <thead><tr class="border-b-2 border-themed"><th class="px-3 py-2 text-left text-xs">Nama</th><th class="px-3 py-2 text-left text-xs">Server ID</th><th class="px-3 py-2 text-left text-xs">Expire</th><th class="px-3 py-2 text-left text-xs">Status</th><th class="px-3 py-2 text-left text-xs"></th></tr></thead>
            <tbody>${panelRows}</tbody>
          </table></div>
        </div>
        <a href="/users" class="inline-block btn-accent">← Kembali ke Users</a>
      </div>`;
      return send(res, 200, pageShell(`User ${uid}`, body, theme, "/users"));
    }

    // ── Server Graph Page (#35) ───────────────────────────────────
    if (path_ === "/server") {
      const theme = getTheme(cookies);
      const sid = parsed.query.id;
      if (!sid) return redirect(res, "/dashboard");
      const panel = db.getPanelByServerId(sid);
      const hist = db.getResourceHistory(sid);
      const bw = db.getBandwidthHistory(sid);
      const up = db.getUptimePercent(sid, 30);
      const reviews = db.getReviews(sid);

      const labels = JSON.stringify(hist.map(h => new Date(h.t).toLocaleString("id-ID", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })));
      const cpuData = JSON.stringify(hist.map(h => h.cpu.toFixed(1)));
      const ramData = JSON.stringify(hist.map(h => h.ram.toFixed(1)));
      const diskData = JSON.stringify(hist.map(h => h.disk.toFixed(1)));
      const bwLabels = JSON.stringify(bw.map(b => new Date(b.t).toLocaleString("id-ID", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })));
      const rxData = JSON.stringify(bw.map(b => (b.rx / 1048576).toFixed(2)));
      const txData = JSON.stringify(bw.map(b => (b.tx / 1048576).toFixed(2)));

      const reviewHtml = reviews.length
        ? reviews.map(r => `<div class="card p-3 mb-2"><div class="flex items-center gap-2 mb-1"><span class="text-yellow-400">${"⭐".repeat(r.rating)}</span><span class="text-xs text-muted">${he(r.userId)}</span></div><div class="text-sm">${he(r.comment || "(tanpa komentar)")}</div></div>`).join("")
        : '<p class="text-muted text-sm">Belum ada review.</p>';

      const body = `<div class="space-y-6">
        <div class="card p-6 gradient-accent text-white">
          <h1 class="text-2xl font-bold mb-1">📈 Server Detail</h1>
          <p class="opacity-90 font-mono text-sm">${he(sid)}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <span class="theme-pill">${he(panel?.username || "Unknown")}</span>
            ${up !== null ? `<span class="theme-pill" style="background:${up>=99?"#10b981":up>=95?"#f59e0b":"#ef4444"}">📊 Uptime: ${up.toFixed(1)}%</span>` : ""}
            <span class="theme-pill" style="background:${panel?.suspended?"#ef4444":panel?.expired?"#f59e0b":"#10b981"}">${panel?.suspended?"Suspended":panel?.expired?"Expired":"Aktif"}</span>
          </div>
        </div>
        <div class="card p-5">
          <h2 class="font-bold mb-3">📊 Resource Usage (7 Hari)</h2>
          <canvas id="resChart" height="100"></canvas>
        </div>
        <div class="card p-5">
          <h2 class="font-bold mb-3">🌐 Bandwidth (7 Hari)</h2>
          <canvas id="bwChart" height="100"></canvas>
        </div>
        <div class="card p-5">
          <h2 class="font-bold mb-3">⭐ User Reviews (${reviews.length})</h2>
          ${reviewHtml}
        </div>
        <a href="/dashboard" class="inline-block btn-accent">← Kembali</a>
        <script>
          new Chart(document.getElementById("resChart"), {
            type: "line",
            data: { labels: ${labels}, datasets: [
              { label: "🔥 CPU %", data: ${cpuData}, borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,.2)", tension: .3, fill: true },
              { label: "🧠 RAM %", data: ${ramData}, borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.2)", tension: .3, fill: true },
              { label: "💾 Disk %", data: ${diskData}, borderColor: "#10b981", backgroundColor: "rgba(16,185,129,.2)", tension: .3, fill: true },
            ] },
            options: { responsive: true, plugins: { legend: { labels: { color: "${theme.text}" }}}, scales: { x: { ticks: { color: "${theme.muted}" }}, y: { ticks: { color: "${theme.muted}" }, beginAtZero: true }}}
          });
          new Chart(document.getElementById("bwChart"), {
            type: "bar",
            data: { labels: ${bwLabels}, datasets: [
              { label: "📥 RX (MB)", data: ${rxData}, backgroundColor: "${theme.accent}" },
              { label: "📤 TX (MB)", data: ${txData}, backgroundColor: "${theme.accent2}" },
            ] },
            options: { responsive: true, plugins: { legend: { labels: { color: "${theme.text}" }}}, scales: { x: { ticks: { color: "${theme.muted}" }}, y: { ticks: { color: "${theme.muted}" }, beginAtZero: true }}}
          });
        </script>
      </div>`;
      return send(res, 200, pageShell(`Server ${sid}`, body, theme, "/"));
    }

    return send(res, 404, "<h1>404 Not Found</h1>", "text/html");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[Dashboard] ✅ Berjalan di port ${port}`);
    console.log(`[Dashboard] 🌐 Akses: http://IP-SERVER-KAMU:${port}`);
    console.log(`[Dashboard] 🔐 Password: ${pass}`);
    if (process.env.SERVER_PORT) {
      console.log(`[Dashboard] 📌 Menggunakan SERVER_PORT dari Pterodactyl: ${port}`);
    }
  });

  server.on("error", err => {
    if (err.code === "EADDRINUSE") {
      console.error(`[Dashboard] ❌ Port ${port} sudah dipakai proses lain! Ganti DASHBOARD_PORT di config.js.`);
    } else if (err.code === "EACCES") {
      console.error(`[Dashboard] ❌ Tidak punya izin pakai port ${port}. Gunakan port > 1024.`);
    } else {
      console.error(`[Dashboard] ❌ Error: ${err.message}`);
    }
  });
}

module.exports = { startDashboard };
