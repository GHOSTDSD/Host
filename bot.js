
const TelegramBot  = require("node-telegram-bot-api");
const unzipper     = require("unzipper");
const { spawn }    = require("child_process");
const fs           = require("fs");
const path         = require("path");
const os           = require("os");
const express      = require("express");
const http         = require("http");
const socketIo     = require("socket.io");

const TOKEN   = process.env.BOT_TOKEN || "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM";
const PORT    = process.env.PORT || 3000;
const DOMAIN  = process.env.RAILWAY_STATIC_URL
  ? `https://${process.env.RAILWAY_STATIC_URL}`
  : `http://localhost:${PORT}`;

const bot    = new TelegramBot(TOKEN, { polling: true });
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server);

app.use(express.json());

const BASE_PATH = path.resolve(process.cwd(), "instances");
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

const activeBots = {};
const botLogs    = {};

process.on("uncaughtException", (err) => {
  if (err.message.includes("file is too big")) return;
  console.error("UNCAUGHT:", err.message);
});
bot.on("polling_error", (err) => {
  if (err.message.includes("file is too big")) return;
  console.error("POLLING:", err.message);
});

const ramUsed  = () => ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
const ramTotal = () => (os.totalmem() / 1024 / 1024).toFixed(0);
const fmtUp    = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
};

const aresBanner = () => {
  console.clear();
  const up = process.uptime().toFixed(0);
  console.log("\x1b[32m%s\x1b[0m", `
  ╔═══════════════════════════════════════════╗
  ║   █████╗ ██████╗ ███████╗███████╗        ║
  ║  ██╔══██╗██╔══██╗██╔════╝██╔════╝        ║
  ║  ███████║██████╔╝█████╗  ███████╗        ║
  ║  ██╔══██║██╔══██╗██╔══╝  ╚════██║        ║
  ║  ██║  ██║██║  ██║███████╗███████║        ║
  ║  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝  v2.0 ║
  ╠═══════════════════════════════════════════╣
  ║  🤖 BOTS  : ${String(Object.keys(activeBots).length).padEnd(4)}                           ║
  ║  🖥  RAM   : ${ramUsed()}/${ramTotal()} MB                    ║
  ║  ⏱  UPTIME: ${String(up).padEnd(6)}s                         ║
  ║  🌐 PAINEL : ${DOMAIN.slice(0,30).padEnd(30)} ║
  ╚═══════════════════════════════════════════╝`);
};

const DASHBOARD_HTML = () => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ARES HOST — Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap" rel="stylesheet"/>
<script src="/socket.io/socket.io.js"></script>
<style>
/* ── Reset & Vars ── */
:root{
  --g:#00ff88; --g2:#00cc66; --g3:rgba(0,255,136,0.08);
  --r:#ff4444; --y:#ffcc00; --b:#44aaff;
  --bg:#030803; --card:#080f08; --card2:#0b150b;
  --border:#162416; --border2:rgba(0,255,136,0.15);
  --text:#b8d8b8; --text2:rgba(184,216,184,0.5);
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow-x:hidden}
body{
  background:var(--bg); color:var(--text);
  font-family:'Share Tech Mono',monospace; min-height:100vh;
}
/* scanlines */
body::before{
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background:repeating-linear-gradient(
    0deg, transparent, transparent 2px,
    rgba(0,255,136,0.013) 2px, rgba(0,255,136,0.013) 4px
  );
}
/* vignette */
body::after{
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background:radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.6) 100%);
}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#030803}
::-webkit-scrollbar-thumb{background:#1e331e;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#2a4a2a}

/* ── Header ── */
header{
  display:flex; align-items:center; justify-content:space-between;
  padding:16px 32px; border-bottom:1px solid var(--border);
  background:linear-gradient(90deg,#030803,#091409,#030803);
  position:sticky; top:0; z-index:200;
  box-shadow:0 0 60px rgba(0,255,136,0.05), 0 1px 0 var(--border);
}
.logo{
  font-family:'Orbitron',sans-serif; font-size:1.5rem; font-weight:900;
  letter-spacing:5px; color:var(--g);
  text-shadow:0 0 30px rgba(0,255,136,0.5),0 0 60px rgba(0,255,136,0.2);
}
.logo span{color:#fff}
.logo sub{font-size:.5rem;letter-spacing:2px;color:var(--g2);vertical-align:baseline;margin-left:4px}
.header-right{display:flex;align-items:center;gap:12px}
.hpill{
  display:flex; align-items:center; gap:7px;
  background:rgba(0,255,136,0.05); border:1px solid var(--border);
  border-radius:4px; padding:6px 14px; font-size:.7rem; color:var(--g2);
}
.hpill .dot{
  width:7px;height:7px;border-radius:50%;
  background:var(--g);box-shadow:0 0 8px var(--g);
  animation:blink 1.6s ease-in-out infinite;
}
.hpill.warn .dot{background:var(--y);box-shadow:0 0 8px var(--y)}
.hpill.err  .dot{background:var(--r);box-shadow:0 0 8px var(--r)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.nav-btn{
  padding:7px 18px; border:1px solid var(--border); border-radius:4px;
  background:transparent; color:var(--g2); cursor:pointer;
  font-family:'Share Tech Mono',monospace; font-size:.7rem;
  letter-spacing:1px; text-decoration:none; transition:.2s;
}
.nav-btn:hover{border-color:var(--g);color:var(--g);background:rgba(0,255,136,0.05)}

/* ── Layout ── */
.container{max-width:1440px;margin:0 auto;padding:32px;position:relative;z-index:1}
.section-label{
  font-size:.6rem; letter-spacing:3px; color:rgba(0,255,136,0.35);
  text-transform:uppercase; margin-bottom:16px;
  display:flex; align-items:center; gap:10px;
}
.section-label::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--border),transparent)}

/* ── Stats Grid ── */
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:36px}
.scard{
  background:var(--card); border:1px solid var(--border); border-radius:6px;
  padding:20px 22px; position:relative; overflow:hidden; transition:.25s;
}
.scard:hover{border-color:rgba(0,255,136,0.2);box-shadow:0 0 24px rgba(0,255,136,0.05)}
.scard::before{
  content:''; position:absolute; top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--g),transparent);opacity:.3;
}
.scard .lbl{font-size:.6rem;letter-spacing:2px;color:var(--text2);text-transform:uppercase;margin-bottom:10px}
.scard .val{
  font-family:'Orbitron',sans-serif; font-size:2rem; font-weight:700;
  color:var(--g); text-shadow:0 0 20px rgba(0,255,136,0.35); line-height:1;
}
.scard .unit{font-size:.65rem;color:var(--text2);margin-top:5px}
.scard .bar{
  position:absolute; bottom:0; left:0;
  height:2px; background:linear-gradient(90deg,var(--g),var(--g2));
  transition:width 1s;
}

/* ── Bots Section ── */
.bots-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.bots-title{font-size:.6rem;letter-spacing:3px;color:rgba(0,255,136,.35);text-transform:uppercase;display:flex;align-items:center;gap:10px}
.bots-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--border),transparent);width:200px}
.sort-bar{display:flex;gap:8px}
.sort-btn{
  padding:5px 12px;border:1px solid var(--border);border-radius:3px;
  background:transparent;color:var(--text2);cursor:pointer;
  font-family:'Share Tech Mono',monospace;font-size:.6rem;letter-spacing:1px;
  transition:.2s;
}
.sort-btn.active,.sort-btn:hover{border-color:var(--g2);color:var(--g2);background:rgba(0,255,136,0.04)}

/* ── Bots Grid ── */
#bots-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}
.bot-card{
  background:var(--card); border:1px solid var(--border); border-radius:8px;
  overflow:hidden; transition:.25s; display:flex; flex-direction:column;
  animation:cardIn .3s ease-out;
}
@keyframes cardIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.bot-card:hover{border-color:rgba(0,255,136,.2);transform:translateY(-2px);box-shadow:0 10px 40px rgba(0,255,136,0.06)}
.bot-card.offline{opacity:.5}
.bot-card.offline:hover{transform:none;box-shadow:none}

/* card top stripe */
.bot-card::before{
  content:''; display:block; height:2px;
  background:linear-gradient(90deg,var(--g),var(--g2),transparent);
  opacity:.5;
}
.bot-card.offline::before{background:linear-gradient(90deg,var(--r),transparent);opacity:.3}

.bot-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 18px; border-bottom:1px solid var(--border);
}
.bot-name-row{display:flex;align-items:center;gap:10px}
.status-dot{
  width:9px;height:9px;border-radius:50%;flex-shrink:0;
  background:var(--g);box-shadow:0 0 10px var(--g);
  animation:blink 1.6s ease-in-out infinite;
}
.status-dot.off{background:var(--r);box-shadow:0 0 8px var(--r);animation:none}
.bot-name{font-family:'Orbitron',sans-serif;font-size:.78rem;font-weight:700;color:#fff;letter-spacing:1px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{
  font-size:.58rem;padding:3px 9px;border-radius:3px;letter-spacing:1.5px;
  font-weight:700;
}
.badge.on{background:rgba(0,255,136,.1);color:var(--g);border:1px solid rgba(0,255,136,.2)}
.badge.off{background:rgba(255,68,68,.1);color:#ff8888;border:1px solid rgba(255,68,68,.2)}

.bot-meta{
  display:grid;grid-template-columns:1fr 1fr;gap:0;
  border-bottom:1px solid var(--border);
}
.meta-cell{
  padding:10px 18px;font-size:.62rem;color:var(--text2);
  border-right:1px solid var(--border);border-bottom:1px solid var(--border);
}
.meta-cell:nth-child(even){border-right:none}
.meta-cell:nth-last-child(-n+2){border-bottom:none}
.meta-cell .key{color:rgba(0,255,136,.35);letter-spacing:1px;margin-bottom:2px;font-size:.55rem}
.meta-cell .val{color:var(--g2)}

/* mini log */
.bot-log{
  background:#020602;padding:10px 16px;
  height:72px;overflow:hidden;position:relative;
  font-size:.6rem;line-height:1.6;color:rgba(0,255,136,.55);
  flex:1;
}
.bot-log::after{
  content:'';position:absolute;bottom:0;left:0;right:0;height:28px;
  background:linear-gradient(transparent,#020602);
}

/* actions */
.bot-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-top:1px solid var(--border)}
.act-btn{
  padding:11px 6px;background:var(--card);color:var(--text2);
  border:none;cursor:pointer;font-family:'Share Tech Mono',monospace;
  font-size:.6rem;letter-spacing:.5px;transition:.2s;
  display:flex;align-items:center;justify-content:center;gap:5px;
  border-right:1px solid var(--border);text-decoration:none;
}
.act-btn:last-child{border-right:none}
.act-btn:hover{background:rgba(0,255,136,0.07);color:var(--g)}
.act-btn.r:hover{background:rgba(255,204,0,0.06);color:var(--y)}
.act-btn.d:hover{background:rgba(255,68,68,0.07);color:var(--r)}
.act-btn:disabled{opacity:.3;cursor:not-allowed}

/* ── Empty ── */
.empty{
  grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:80px 40px;border:1px dashed var(--border);border-radius:8px;gap:12px;
}
.empty .ico{font-size:3rem;opacity:.25}
.empty p{color:var(--text2);font-size:.75rem;text-align:center;line-height:1.9;max-width:400px}
.empty code{color:var(--g2);background:rgba(0,255,136,.06);padding:2px 8px;border-radius:3px}

/* ── Log Modal ── */
#modal{
  display:none;position:fixed;inset:0;z-index:500;
  background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);
  align-items:center;justify-content:center;
}
#modal.open{display:flex}
.modal-box{
  width:min(900px,95vw);height:80vh;
  background:#030803;border:1px solid var(--g);border-radius:8px;
  display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 0 80px rgba(0,255,136,.15);
  animation:cardIn .2s ease-out;
}
.modal-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 20px;border-bottom:1px solid var(--border);background:#050a05;
  flex-shrink:0;
}
.modal-title{font-family:'Orbitron',sans-serif;font-size:.75rem;color:var(--g);letter-spacing:2px}
.modal-toolbar{display:flex;gap:6px}
.m-btn{
  padding:5px 14px;border:1px solid var(--border);border-radius:3px;
  background:transparent;color:var(--text2);cursor:pointer;
  font-family:'Share Tech Mono',monospace;font-size:.62rem;transition:.2s;
}
.m-btn:hover{border-color:var(--g);color:var(--g);background:rgba(0,255,136,.05)}
.m-btn.close:hover{border-color:var(--r);color:var(--r);background:rgba(255,68,68,.05)}
#modal-log{
  flex:1;overflow-y:auto;padding:14px 18px;
  font-size:.68rem;line-height:1.7;white-space:pre-wrap;
  word-break:break-all;color:rgba(0,255,136,.75);
  background:#020602;
}
.modal-foot{
  padding:8px 18px;border-top:1px solid var(--border);
  background:#050a05;font-size:.6rem;color:var(--text2);
  display:flex;justify-content:space-between;flex-shrink:0;
}

/* ── Toast ── */
#toast{
  position:fixed;bottom:28px;right:28px;z-index:999;
  background:rgba(3,8,3,.96);border:1px solid var(--g);
  color:var(--g);padding:12px 22px;border-radius:6px;
  font-size:.72rem;opacity:0;transform:translateY(8px);
  transition:.25s;pointer-events:none;
  box-shadow:0 0 30px rgba(0,255,136,.15);max-width:280px;
}
#toast.show{opacity:1;transform:translateY(0)}
#toast.err{border-color:var(--r);color:var(--r);box-shadow:0 0 30px rgba(255,68,68,.15)}

/* ── Responsive ── */
@media(max-width:900px){
  .stats-row{grid-template-columns:1fr 1fr}
  header{padding:12px 16px}
  .container{padding:16px}
  .logo{font-size:1.2rem}
}
@media(max-width:520px){
  .stats-row{grid-template-columns:1fr}
  #bots-grid{grid-template-columns:1fr}
  .header-right .hpill{display:none}
}
</style>
</head>
<body>

<!-- ── Header ── -->
<header>
  <div class="logo">ARES<span>HOST</span><sub>v2</sub></div>
  <div class="header-right">
    <div class="hpill"><div class="dot"></div><span id="h-bots">0</span>&nbsp;bots</div>
    <div class="hpill"><span>RAM&nbsp;</span><span id="h-ram">…</span><span>MB</span></div>
    <button class="nav-btn" onclick="refresh()">⟳ Refresh</button>
    <a class="nav-btn" href="/" style="text-decoration:none">🖥 Painel</a>
  </div>
</header>

<!-- ── Main ── -->
<div class="container">

  <!-- Stats -->
  <div class="section-label">Métricas do Sistema</div>
  <div class="stats-row">
    <div class="scard">
      <div class="lbl">Bots Online</div>
      <div class="val" id="s-bots">0</div>
      <div class="unit">instâncias ativas</div>
      <div class="bar" id="bar-bots" style="width:0%"></div>
    </div>
    <div class="scard">
      <div class="lbl">RAM Usada</div>
      <div class="val" id="s-ram">—</div>
      <div class="unit" id="s-ram-u">de — MB</div>
      <div class="bar" id="bar-ram" style="width:0%"></div>
    </div>
    <div class="scard">
      <div class="lbl">CPU Cores</div>
      <div class="val" id="s-cpu">—</div>
      <div class="unit" id="s-plat">—</div>
    </div>
    <div class="scard">
      <div class="lbl">Uptime</div>
      <div class="val" id="s-up" style="font-size:1.4rem">0s</div>
      <div class="unit">servidor rodando</div>
    </div>
  </div>

  <!-- Bots -->
  <div class="bots-header">
    <div class="bots-title">Instâncias de Bots</div>
    <div class="sort-bar">
      <button class="sort-btn active" onclick="setSortFilter('all',this)">Todos</button>
      <button class="sort-btn" onclick="setSortFilter('online',this)">Online</button>
      <button class="sort-btn" onclick="setSortFilter('offline',this)">Offline</button>
    </div>
  </div>
  <div id="bots-grid">
    <div class="empty">
      <div class="ico">🤖</div>
      <p>Nenhum bot ativo.<br/>Envie um <code>.zip</code> pelo Telegram<br/>para iniciar uma instância.</p>
    </div>
  </div>
</div>

<!-- ── Log Modal ── -->
<div id="modal">
  <div class="modal-box">
    <div class="modal-head">
      <div class="modal-title" id="modal-title">TERMINAL</div>
      <div class="modal-toolbar">
        <button class="m-btn" onclick="clearModal()">🗑 Limpar</button>
        <button class="m-btn" onclick="copyModal()">📋 Copiar</button>
        <button class="m-btn" id="modal-scroll-btn" onclick="toggleAutoScroll()">⇣ Auto</button>
        <a class="m-btn" id="modal-ext-link" href="#" target="_blank">↗ Terminal</a>
        <button class="m-btn close" onclick="closeModal()">✕ Fechar</button>
      </div>
    </div>
    <div id="modal-log">Aguardando logs...</div>
    <div class="modal-foot">
      <span id="modal-bot-id">—</span>
      <span id="modal-lines">0 linhas</span>
      <span id="modal-ts">—</span>
    </div>
  </div>
</div>

<!-- ── Toast ── -->
<div id="toast"></div>

<script>
const socket = io();
const logs   = {};
const startTs = Date.now();
let sortFilter = 'all';
let modalBot   = null;
let autoScroll = true;
let modalLines = 0;

function toast(msg, type='ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type === 'err' ? 'err show' : 'show';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', 2800);
}

function fmtUp(ms) {
  const s = Math.floor(ms/1000);
  if (s < 60)   return s+'s';
  if (s < 3600) return Math.floor(s/60)+'m '+s%60+'s';
  return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
}

async function refreshStats() {
  try {
    const d = await (await fetch('/api/stats')).json();
    document.getElementById('h-bots').textContent = d.bots;
    document.getElementById('h-ram').textContent  = d.ramUsed;
    document.getElementById('s-bots').textContent = d.bots;
    document.getElementById('s-ram').textContent  = d.ramUsed;
    document.getElementById('s-ram-u').textContent = 'de '+d.ramTotal+' MB';
    document.getElementById('s-cpu').textContent  = d.cpus;
    document.getElementById('s-plat').textContent = d.platform;
    document.getElementById('s-up').textContent   = fmtUp(Date.now()-startTs);
    const ramPct = Math.round(d.ramUsed/d.ramTotal*100);
    document.getElementById('bar-ram').style.width = ramPct+'%';
    document.getElementById('bar-bots').style.width = Math.min(d.bots*10,100)+'%';
  } catch(e){}
}

async function refreshBots() {
  try {
    const bots = await (await fetch('/api/bots')).json();
    renderBots(bots);
  } catch(e){}
}

function setSortFilter(f, btn) {
  sortFilter = f;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  refreshBots();
}

function renderBots(bots) {
  let filtered = bots;
  if (sortFilter === 'online')  filtered = bots.filter(b => b.online);
  if (sortFilter === 'offline') filtered = bots.filter(b => !b.online);

  const grid = document.getElementById('bots-grid');

  if (filtered.length === 0) {
    grid.innerHTML = \`<div class="empty">
      <div class="ico">🤖</div>
      <p>Nenhum bot \${sortFilter !== 'all' ? sortFilter : 'ativo'}.<br/>
      Envie um <code>.zip</code> pelo Telegram para iniciar uma instância.</p>
    </div>\`;
    return;
  }

  bots.forEach(bot => {
    if (!logs[bot.id]) {
      logs[bot.id] = [];
      socket.on('log-'+bot.id, data => {
        logs[bot.id] = [...logs[bot.id], data].slice(-500);

        const prev = document.querySelector(\`.bot-card[data-id="\${bot.id}"] .bot-log\`);
        if (prev) prev.textContent = logs[bot.id].slice(-20).join('');

        if (modalBot === bot.id) appendModalLog(data);
      });
    }
  });

  grid.innerHTML = filtered.map(bot => {
    const on = bot.online;
    const preview = (logs[bot.id]||[]).slice(-15).join('') || '> aguardando logs...';
    return \`
<div class="bot-card\${on?'':' offline'}" data-id="\${bot.id}">
  <div ="bot-head">
    <div class="bot-name-row">
      <div class="status-dot\${on?'':' off'}"></div>
      <div class="bot-name" title="\${bot.id}">\${bot.id}</div>
    </div>
    <span class="badge \${on?'on':'off'}">\${on?'ONLINE':'OFFLINE'}</span>
  </div>
  <div class="bot-meta">
    <div class="meta-cell"><div class="key">PID</div><div class="val">\${bot.pid||'—'}</div></div>
    <div class="meta-cell"><div class="key">STATUS</div><div class="val">\${on?'running':'stopped'}</div></div>
    <div class="meta-cell"><div class="key">UPTIME</div><div class="val">\${bot.uptime||'—'}</div></div>
    <div class="meta-cell"><div class="key">CHAT ID</div><div class="val">\${bot.chatId||'—'}</div></div>
  </div>
  <div class="bot-log">\${escHtml(preview)}</div>
  <div class="bot-actions">
    <button class="act-btn" onclick="openModal('\${bot.id}')">📟 Logs</button>
    <a class="act-btn" href="/terminal/\${bot.id}" target="_blank">↗ Terminal</a>
    <button class="act-btn r" onclick="restartBot('\${bot.id}')">🔄 Restart</button>
    <button class="act-btn d" onclick="stopBot('\${bot.id}')">\${on?'⏹ Parar':'🗑 Remover'}</button>
  </div>
</div>\`;
  }).join('');
}

function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function stopBot(id) {
  if (!confirm('Parar o bot "'+id+'"?')) return;
  const r = await fetch('/api/bots/'+encodeURIComponent(id)+'/stop', {method:'POST'});
  if (r.ok) { toast('⏹ '+id+' parado.'); setTimeout(refresh,600); }
  else toast('Erro ao parar.','err');
}

async function restartBot(id) {
  toast('🔄 Reiniciando '+id+'...');
  const r = await fetch('/api/bots/'+encodeURIComponent(id)+'/restart', {method:'POST'});
  if (r.ok) setTimeout(refresh,1500);
  else toast('Erro ao reiniciar.','err');
}

function openModal(id) {
  modalBot = id; modalLines = 0; autoScroll = true;
  document.getElementById('modal-title').textContent = 'LOGS — '+id;
  document.getElementById('modal-bot-id').textContent = id;
  document.getElementById('modal-ext-link').href = '/terminal/'+id;
  const logEl = document.getElementById('modal-log');
  const content = (logs[id]||[]).join('');
  logEl.innerHTML = escHtml(content) || 'Aguardando logs...';
  modalLines = content.split('\\n').length;
  updateModalFoot();
  document.getElementById('modal').classList.add('open');
  if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

function appendModalLog(data) {
  if (modalBot === null) return;
  const logEl = document.getElementById('modal-log');
  logEl.innerHTML += escHtml(data);
  modalLines += data.split('\\n').length;
  updateModalFoot();
  if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

function updateModalFoot() {
  document.getElementById('modal-lines').textContent = modalLines+' linhas';
  document.getElementById('modal-ts').textContent = new Date().toLocaleTimeString();
}

function closeModal() { document.getElementById('modal').classList.remove('open'); modalBot=null; }
function clearModal()  { document.getElementById('modal-log').innerHTML=''; modalLines=0; updateModalFoot(); }
function copyModal()   { navigator.clipboard.writeText(document.getElementById('modal-log').innerText); toast('📋 Copiado!'); }
function toggleAutoScroll() {
  autoScroll = !autoScroll;
  document.getElementById('modal-scroll-btn').style.color = autoScroll ? 'var(--g)' : '';
  toast(autoScroll ? '⇣ Auto-scroll ativo' : '⇣ Auto-scroll pausado');
}

document.getElementById('modal').addEventListener('click', e => { if(e.target.id==='modal') closeModal(); });

socket.on('bots-update', () => { refreshBots(); refreshStats(); });

function refresh() { refreshStats(); refreshBots(); }
setInterval(refreshStats, 5000);
setInterval(refreshBots,  10000);
setInterval(() => {
  const el = document.getElementById('s-up');
  if (el) el.textContent = fmtUp(Date.now()-startTs);
}, 1000);
refresh();
</script>
</body>
</html>`;

const TERMINAL_HTML = (botId) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Terminal — ${botId}</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@700&display=swap" rel="stylesheet"/>
<script src="/socket.io/socket.io.js"></script>
<style>
:root{--g:#00ff88;--g2:#00cc66;--r:#ff4444;--y:#ffcc00;--bg:#020602;--border:#142014}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:#9ec89e;font-family:'Share Tech Mono',monospace;display:flex;flex-direction:column}
body::before{content:'';position:fixed;inset:0;pointer-events:none;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,255,136,.01) 2px,rgba(0,255,136,.01) 4px)}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:#020602}
::-webkit-scrollbar-thumb{background:#1a2e1a;border-radius:3px}
header{
  display:flex;align-items:center;justify-content:space-between;
  padding:11px 20px;border-bottom:1px solid var(--border);background:#030803;flex-shrink:0;
  box-shadow:0 1px 0 #0a180a;
}
.t-logo{font-family:'Orbitron',sans-serif;font-size:.7rem;color:var(--g);letter-spacing:3px;text-shadow:0 0 14px rgba(0,255,136,.45)}
.t-meta{display:flex;align-items:center;gap:14px;font-size:.65rem;color:rgba(158,200,158,.6)}
.t-dot{width:7px;height:7px;border-radius:50%;background:var(--g);box-shadow:0 0 8px var(--g);animation:blink 1.6s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
.t-dot.off{background:var(--r);box-shadow:0 0 8px var(--r);animation:none}
.t-badge{padding:3px 10px;background:rgba(0,255,136,.07);border:1px solid rgba(0,255,136,.18);border-radius:3px;color:var(--g);font-size:.62rem;letter-spacing:1px}
.t-badge.off{background:rgba(255,68,68,.07);border-color:rgba(255,68,68,.18);color:#ff8888}
.toolbar{
  display:flex;align-items:stretch;border-bottom:1px solid var(--border);flex-shrink:0;
  background:#030803;overflow-x:auto;
}
.tb{
  padding:9px 18px;background:transparent;color:rgba(158,200,158,.55);
  border:none;border-right:1px solid var(--border);cursor:pointer;
  font-family:'Share Tech Mono',monospace;font-size:.62rem;letter-spacing:.8px;
  transition:.18s;white-space:nowrap;
}
.tb:hover{background:rgba(0,255,136,.06);color:var(--g)}
.tb.d:hover{background:rgba(255,68,68,.07);color:var(--r)}
.tb.w:hover{background:rgba(255,204,0,.06);color:var(--y)}
.tb.active{color:var(--g);background:rgba(0,255,136,.04)}
#log{
  flex:1;overflow-y:auto;padding:14px 18px;
  font-size:.69rem;line-height:1.65;white-space:pre-wrap;word-break:break-all;
  color:rgba(0,255,136,.72);background:#010501;
}
#log .err-line{color:rgba(255,100,100,.8)}
#log .warn-line{color:rgba(255,204,0,.75)}
#log .info-line{color:rgba(0,200,255,.7)}
footer{
  padding:7px 18px;border-top:1px solid var(--border);background:#030803;flex-shrink:0;
  display:flex;justify-content:space-between;align-items:center;
  font-size:.58rem;color:rgba(158,200,158,.35);
}
#f-lines{color:rgba(0,255,136,.5)}
</style>
</head>
<body>
<header>
  <div class="t-logo">ARES — TERMINAL</div>
  <div class="t-meta">
    <div class="t-dot" id="dot"></div>
    <span>${botId}</span>
    <span class="t-badge" id="tbadge">CONECTANDO</span>
  </div>
</header>
<div class="toolbar">
  <button class="tb active" id="btn-scroll" onclick="toggleScroll()">⇣ Auto-scroll</button>
  <button class="tb" onclick="clearLog()">🗑 Limpar</button>
  <button class="tb" onclick="copyLog()">📋 Copiar</button>
  <button class="tb" onclick="exportLog()">💾 Exportar</button>
  <button class="tb" onclick="toggleWrap()">⟷ Wrap</button>
  <button class="tb w" onclick="restartBot()">🔄 Restart</button>
  <button class="tb d" onclick="stopBot()">⏹ Parar Bot</button>
  <a class="tb" href="/" style="margin-left:auto;text-decoration:none">← Dashboard</a>
</div>
<div id="log"></div>
<footer>
  <span>BOT: ${botId}</span>
  <span id="f-lines">0 linhas</span>
  <span id="f-ts">—</span>
</footer>

<script>
const socket = io();
const logEl  = document.getElementById('log');
let lines = 0, autoScroll = true, wrapped = true;
let buffer = '';

function colorize(txt) {
  return txt
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/(ERRO|ERROR|FATAL|error|Error)/g, '<span class="err-line">$1</span>')
    .replace(/(WARN|WARNING|warn|Warning)/g,    '<span class="warn-line">$1</span>')
    .replace(/(INFO|info|✓|✔|started|running|online)/gi, '<span class="info-line">$1</span>');
}

socket.on('log-${botId}', data => {
  buffer += data;
  logEl.innerHTML += colorize(data);
  lines += data.split('\\n').length;
  document.getElementById('f-lines').textContent = lines + ' linhas';
  document.getElementById('f-ts').textContent = new Date().toLocaleTimeString();
  document.getElementById('tbadge').textContent = 'ATIVO';
  document.getElementById('tbadge').className = 't-badge';
  document.getElementById('dot').className = 't-dot';
  if (autoScroll) logEl.scrollTop = logEl.scrollHeight;

  if (logEl.childNodes.length > 5000) {
    logEl.removeChild(logEl.firstChild);
  }
});

function toggleScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('btn-scroll');
  btn.className = 'tb'+(autoScroll?' active':'');
}
function clearLog()  { logEl.innerHTML=''; buffer=''; lines=0; document.getElementById('f-lines').textContent='0 linhas'; }
function copyLog()   { navigator.clipboard.writeText(buffer); }
function exportLog() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buffer],{type:'text/plain'}));
  a.download = '${botId}-'+Date.now()+'.log';
  a.click();
}
function toggleWrap() {
  wrapped = !wrapped;
  logEl.style.whiteSpace = wrapped ? 'pre-wrap' : 'pre';
}
async function stopBot() {
  if (!confirm('Parar o bot ${botId}?')) return;
  await fetch('/api/bots/${botId}/stop',{method:'POST'});
  document.getElementById('tbadge').textContent = 'PARADO';
  document.getElementById('tbadge').className = 't-badge off';
  document.getElementById('dot').className = 't-dot off';
}
async function restartBot() {
  await fetch('/api/bots/${botId}/restart',{method:'POST'});
  logEl.innerHTML += colorize('\\n[sistema] Reiniciando...\\n');
}
</script>
</body>
</html>`;

app.get("/",                (req, res) => res.send(DASHBOARD_HTML()));
app.get("/terminal/:id",    (req, res) => res.send(TERMINAL_HTML(req.params.id)));

app.get("/api/stats", (req, res) => {
  res.json({
    bots:     Object.keys(activeBots).length,
    ramUsed:  ramUsed(),
    ramTotal: ramTotal(),
    cpus:     os.cpus().length,
    platform: os.platform(),
    uptime:   process.uptime().toFixed(0),
  });
});

app.get("/api/bots", (req, res) => {
  res.json(
    Object.entries(activeBots).map(([id, info]) => ({
      id,
      online:  true,
      pid:     info.process?.pid || null,
      chatId:  info.chatId || null,
      uptime:  info.startedAt ? fmtUp(Date.now() - info.startedAt) : "—",
      path:    path.resolve(BASE_PATH, id),
    }))
  );
});

app.post("/api/bots/:id/stop", (req, res) => {
  const id = req.params.id;
  if (!activeBots[id]) return res.status(404).json({ error: "not found" });
  activeBots[id].process?.kill("SIGTERM");
  delete activeBots[id];
  io.emit("bots-update");
  aresBanner();
  res.json({ ok: true });
});

app.post("/api/bots/:id/restart", (req, res) => {
  const id = req.params.id;
  const instancePath = path.resolve(BASE_PATH, id);
  if (!fs.existsSync(instancePath)) return res.status(404).json({ error: "path not found" });
  if (activeBots[id]) activeBots[id].process?.kill("SIGTERM");
  res.json({ ok: true, message: "restarting" });
  setTimeout(() => spawnBot(id, instancePath, activeBots[id]?.chatId || null), 800);
});

function spawnBot(botId, instancePath, chatId) {
  const files    = fs.readdirSync(instancePath);
  const mainFile = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));

  const hasPkg = fs.existsSync(path.join(instancePath, "package.json"));
  if (!mainFile && !hasPkg) return;

  let child;
  let launchMode;

  if (mainFile) {
    launchMode = `node ${mainFile}`;
    child = spawn("node", ["--max-old-space-size=64", mainFile], {
      cwd: instancePath, stdio: "pipe", shell: true,
    });
  } else {

    launchMode = "npm start";
    io.emit(`log-${botId}`, `[ares] Nenhum .js encontrado, tentando npm start...\n`);

    const install = spawn("npm", ["install", "--omit=dev"], {
      cwd: instancePath, stdio: "pipe", shell: true,
    });

    install.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    install.stderr.on("data", d => io.emit(`log-${botId}`, d.toString()));

    install.on("exit", (code) => {
      if (code !== 0) {
        io.emit(`log-${botId}`, `\n[ares] npm install falhou (código ${code})\n`);
        delete activeBots[botId];
        io.emit("bots-update");
        aresBanner();
        return;
      }
      io.emit(`log-${botId}`, `[ares] Dependências instaladas, iniciando...\n`);
      const startChild = spawn("npm", ["start"], {
        cwd: instancePath, stdio: "pipe", shell: true,
      });
      activeBots[botId].process = startChild;
      activeBots[botId].pid     = startChild.pid;
      startChild.stdout.on("data", d => { const t=d.toString(); process.stdout.write(`[${botId}] ${t}`); io.emit(`log-${botId}`, t); });
      startChild.stderr.on("data", d => io.emit(`log-${botId}`, `\nERRO: ${d.toString()}`));
      startChild.on("exit", (c) => {
        io.emit(`log-${botId}`, `\n[sistema] Processo encerrado (código ${c})\n`);
        delete activeBots[botId];
        io.emit("bots-update");
        aresBanner();
      });
      io.emit("bots-update");
    });

    activeBots[botId] = { process: install, startedAt: Date.now(), chatId, launchMode };
    io.emit("bots-update");
    aresBanner();
    return;
  }

  activeBots[botId] = { process: child, startedAt: Date.now(), chatId, launchMode };

  child.stdout.on("data", (data) => {
    const txt = data.toString();
    process.stdout.write(`[${botId}] ${txt}`);
    io.emit(`log-${botId}`, txt);
  });

  child.stderr.on("data", (data) => {
    io.emit(`log-${botId}`, `\nERRO: ${data.toString()}`);
  });

  child.on("exit", (code) => {
    io.emit(`log-${botId}`, `\n[sistema] Processo encerrado (código ${code})\n`);
    delete activeBots[botId];
    io.emit("bots-update");
    aresBanner();
  });

  io.emit("bots-update");
  aresBanner();
}

async function startInstance(chatId, fileId, botId) {
  const instancePath = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

    require("https").get(fileUrl, (res) => {
      res.pipe(unzipper.Extract({ path: instancePath })).on("close", () => {
        const files    = fs.readdirSync(instancePath);
        const mainFile = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));

        const hasPkg = fs.existsSync(path.join(instancePath, "package.json"));

        if (!mainFile && !hasPkg) {
          return bot.sendMessage(chatId,
            "❌ *Nenhum arquivo de entrada encontrado!*\n\n" +
            "O `.zip` deve conter:\n" +
            "• `index.js` / `main.js` / `bot.js` / `start.js`\n" +
            "• _ou_ um `package.json` com script `start`",
            { parse_mode: "Markdown" }
          );
        }

        const launchInfo = mainFile ? `\`${mainFile}\`` : "`npm start` (via package.json)";

        spawnBot(botId, instancePath, chatId);

        const termUrl  = `${DOMAIN}/terminal/${botId}`;
        const dashUrl  = `${DOMAIN}`;

        bot.sendMessage(chatId,
          `✅ *Bot iniciado com sucesso!*\n\n` +
          `🤖 *Nome:* \`${botId}\`\n` +
          `📁 *Entrada:* ${launchInfo}\n` +
          `📟 *Terminal:* ${termUrl}\n` +
          `🖥 *Dashboard:* ${dashUrl}`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📟 Terminal",  url: termUrl },
                  { text: "🖥 Dashboard", url: dashUrl },
                ],
                [
                  { text: "🔄 Restart",  callback_data: `restart:${botId}` },
                  { text: "⏹ Parar",     callback_data: `stop:${botId}`    },
                  { text: "📊 Status",   callback_data: `status:${botId}`  },
                ],
              ],
            },
          }
        );
      });
    }).on("error", (e) => {
      bot.sendMessage(chatId, `❌ Erro no download: \`${e.message}\``, { parse_mode: "Markdown" });
    });

  } catch (e) {
    bot.sendMessage(chatId, `❌ Erro: \`${e.message}\``, { parse_mode: "Markdown" });
  }
}

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "usuário";
  bot.sendMessage(msg.chat.id,
    `🔥 *ARES HOST v2* — Online!\n\n` +
    `Olá, *${name}*! Bem-vindo ao painel.\n\n` +
    `📦 *Para hospedar um bot:*\n` +
    `Envie um arquivo *.zip* com o nome do bot na *legenda*.\n\n` +
    `*Comandos disponíveis:*\n` +
    `\`/list\`   — Listar bots ativos\n` +
    `\`/stop <nome>\`   — Parar um bot\n` +
    `\`/restart <nome>\` — Reiniciar um bot\n` +
    `\`/status\` — Status do servidor\n` +
    `\`/dashboard\` — Link do painel web\n` +
    `\`/help\` — Ajuda completa`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🖥 Abrir Dashboard", url: DOMAIN }],
          [
            { text: "📋 Listar Bots",  callback_data: "cmd:list"   },
            { text: "📊 Status",       callback_data: "cmd:status" },
          ],
        ],
      },
    }
  );
  aresBanner();
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *ARES HOST — Ajuda*\n\n` +
    `*Como hospedar um bot:*\n` +
    `1. Compacte o código do bot em um \`.zip\`\n` +
    `2. Envie o arquivo aqui com o nome do bot na legenda\n` +
    `3. O bot será iniciado automaticamente\n\n` +
    `*Requisitos do .zip:*\n` +
    `• Deve conter \`index.js\`, \`main.js\`, \`bot.js\` ou \`start.js\`\n` +
    `• Tamanho máximo: 20MB\n` +
    `• As dependências serão procuradas na pasta do bot\n\n` +
    `*Comandos:*\n` +
    `\`/list\` — Ver todos os bots\n` +
    `\`/stop nome\` — Parar bot\n` +
    `\`/restart nome\` — Reiniciar bot\n` +
    `\`/status\` — Status do servidor\n` +
    `\`/dashboard\` — Painel web`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/list/, (msg) => {
  const ids = Object.keys(activeBots);
  if (ids.length === 0) {
    return bot.sendMessage(msg.chat.id,
      "📭 *Nenhum bot ativo no momento.*\n\nEnvie um `.zip` para iniciar um bot.",
      { parse_mode: "Markdown" }
    );
  }
  const lines = ids.map((id, i) => {
    const b  = activeBots[id];
    const up = b.startedAt ? fmtUp(Date.now() - b.startedAt) : "—";
    return `${i+1}. \`${id}\` — ⏱ ${up}`;
  }).join("\n");

  const keyboard = ids.map(id => [
    { text: `📟 ${id}`,  url: `${DOMAIN}/terminal/${id}` },
    { text: "🔄",        callback_data: `restart:${id}`  },
    { text: "⏹",        callback_data: `stop:${id}`     },
    { text: "📊",        callback_data: `status:${id}`   },
  ]);
  keyboard.push([{ text: "🖥 Dashboard Completo", url: DOMAIN }]);

  bot.sendMessage(msg.chat.id,
    `🤖 *Bots Ativos (${ids.length}):*\n\n${lines}`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }
  );
});

bot.onText(/\/status/, (msg) => {
  const ids = Object.keys(activeBots);
  const up  = process.uptime().toFixed(0);
  bot.sendMessage(msg.chat.id,
    `📊 *Status do Servidor*\n\n` +
    `🤖 Bots ativos: *${ids.length}*\n` +
    `🖥 RAM: *${ramUsed()} / ${ramTotal()} MB*\n` +
    `⏱ Uptime: *${up}s*\n` +
    `🔧 CPUs: *${os.cpus().length}*\n` +
    `💻 OS: *${os.platform()} ${os.release()}*\n` +
    `🌐 Painel: ${DOMAIN}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🖥 Abrir Dashboard", url: DOMAIN }],
          [{ text: "📋 Ver Bots", callback_data: "cmd:list" }],
        ],
      },
    }
  );
});

bot.onText(/\/dashboard/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🖥 *Dashboard Ares Host*\n\n${DOMAIN}`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Painel", url: DOMAIN }]] },
    }
  );
});

bot.onText(/\/stop (.+)/, (msg, match) => {
  const id = match[1].trim();
  if (!activeBots[id]) {
    return bot.sendMessage(msg.chat.id, `❌ Bot \`${id}\` não encontrado.`, { parse_mode: "Markdown" });
  }
  activeBots[id].process?.kill("SIGTERM");
  delete activeBots[id];
  io.emit("bots-update");
  aresBanner();
  bot.sendMessage(msg.chat.id, `⏹ Bot \`${id}\` parado com sucesso.`, { parse_mode: "Markdown" });
});

bot.onText(/\/restart (.+)/, (msg, match) => {
  const id           = match[1].trim();
  const instancePath = path.resolve(BASE_PATH, id);
  if (!fs.existsSync(instancePath)) {
    return bot.sendMessage(msg.chat.id, `❌ Bot \`${id}\` não encontrado.`, { parse_mode: "Markdown" });
  }
  if (activeBots[id]) activeBots[id].process?.kill("SIGTERM");
  bot.sendMessage(msg.chat.id, `🔄 Reiniciando \`${id}\`...`, { parse_mode: "Markdown" });
  setTimeout(() => spawnBot(id, instancePath, msg.chat.id), 800);
});

bot.on("callback_query", async (query) => {
  const { data, message } = query;
  const chatId = message.chat.id;
  const msgId  = message.message_id;

  if (data === "cmd:list") {
    bot.answerCallbackQuery(query.id);

    const ids = Object.keys(activeBots);
    if (ids.length === 0) {
      return bot.sendMessage(chatId, "📭 Nenhum bot ativo.");
    }
    const lines = ids.map((id, i) => {
      const b  = activeBots[id];
      const up = b.startedAt ? fmtUp(Date.now() - b.startedAt) : "—";
      return `${i+1}. \`${id}\` — ⏱ ${up}`;
    }).join("\n");
    const keyboard = ids.map(id => [
      { text: `📟 ${id}`, url: `${DOMAIN}/terminal/${id}` },
      { text: "🔄", callback_data: `restart:${id}` },
      { text: "⏹", callback_data: `stop:${id}` },
    ]);
    keyboard.push([{ text: "🖥 Dashboard", url: DOMAIN }]);
    return bot.sendMessage(chatId,
      `🤖 *Bots Ativos (${ids.length}):*\n\n${lines}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }
    );
  }

  if (data === "cmd:status") {
    bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId,
      `📊 RAM: *${ramUsed()}/${ramTotal()}MB* | Bots: *${Object.keys(activeBots).length}* | Uptime: *${process.uptime().toFixed(0)}s*`,
      { parse_mode: "Markdown" }
    );
  }

  const [action, botId] = data.split(":");
  if (!botId) return bot.answerCallbackQuery(query.id);

  if (action === "stop") {
    if (activeBots[botId]) {
      activeBots[botId].process?.kill("SIGTERM");
      delete activeBots[botId];
      io.emit("bots-update");
      aresBanner();
    }
    bot.answerCallbackQuery(query.id, { text: `⏹ ${botId} parado!` });

    bot.editMessageReplyMarkup(
      {
        inline_keyboard: [
          [
            { text: "📟 Terminal",  url: `${DOMAIN}/terminal/${botId}` },
            { text: "🖥 Dashboard", url: DOMAIN },
          ],
          [{ text: "🔄 Reiniciar", callback_data: `restart:${botId}` }],
        ],
      },
      { chat_id: chatId, message_id: msgId }
    ).catch(() => {});
    return;
  }

  if (action === "restart") {
    const instancePath = path.resolve(BASE_PATH, botId);
    if (!fs.existsSync(instancePath)) {
      return bot.answerCallbackQuery(query.id, { text: "❌ Pasta não encontrada." });
    }
    if (activeBots[botId]) activeBots[botId].process?.kill("SIGTERM");
    bot.answerCallbackQuery(query.id, { text: `🔄 Reiniciando ${botId}...` });
    setTimeout(() => spawnBot(botId, instancePath, chatId), 800);
    return;
  }

  if (action === "status") {
    const b  = activeBots[botId];
    const up = b?.startedAt ? fmtUp(Date.now() - b.startedAt) : "offline";
    const pid = b?.process?.pid || "—";
    bot.answerCallbackQuery(query.id, {
      text: `🤖 ${botId}\n⏱ Uptime: ${up}\n🔢 PID: ${pid}`,
      show_alert: true,
    });
    return;
  }

  bot.answerCallbackQuery(query.id);
});

bot.on("document", async (msg) => {
  const doc = msg.document;
  if (!doc.file_name.endsWith(".zip")) return;

  if (doc.file_size > 20 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id,
      "❌ *Arquivo muito grande!*\nMáximo permitido: *20 MB*",
      { parse_mode: "Markdown" }
    );
  }

  const rawName = msg.caption || `bot_${Date.now()}`;
  const botId   = rawName.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 40);

  if (activeBots[botId]) {
    return bot.sendMessage(msg.chat.id,
      `⚠️ Já existe um bot com o nome \`${botId}\` rodando.\nPare-o antes ou use outro nome.`,
      { parse_mode: "Markdown" }
    );
  }

  bot.sendMessage(msg.chat.id,
    `⏳ *Recebendo e iniciando \`${botId}\`...*`,
    { parse_mode: "Markdown" }
  );

  await startInstance(msg.chat.id, doc.file_id, botId);
});

server.listen(PORT, "0.0.0.0", () => aresBanner());
