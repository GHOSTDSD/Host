const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const token = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM";
const bot = new TelegramBot(token, { polling: true });

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const activeBots = {};
const botLogs = {};
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.RAILWAY_STATIC_URL
  ? `https://${process.env.RAILWAY_STATIC_URL}`
  : `http://localhost:${PORT}`;

const BASE_PATH = path.resolve(process.cwd(), "instances");
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

process.on("uncaughtException", (err) => {
  if (err.message.includes("file is too big")) return;
  console.error("ERRO:", err.message);
});
bot.on("polling_error", (err) => {
  if (err.message.includes("file is too big")) return;
});

// â”€â”€â”€ ASCII Banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const aresBanner = () => {
  console.clear();
  const ramUso = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
  const ramTotal = (os.totalmem() / 1024 / 1024).toFixed(0);
  const uptime = process.uptime().toFixed(0);
  console.log(
    "\x1b[32m%s\x1b[0m",
    `
  â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
  â•‘   â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•— â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•— â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—    â•‘
  â•‘  â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—â–ˆâ–ˆâ•”â•â•â•â•â•â–ˆâ–ˆâ•”â•â•â•â•â•   â•‘
  â•‘  â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•‘â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•”â•â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—  â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—   â•‘
  â•‘  â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•‘â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—â–ˆâ–ˆâ•”â•â•â•  â•šâ•â•â•â•â–ˆâ–ˆâ•‘   â•‘
  â•‘  â–ˆâ–ˆâ•‘  â–ˆâ–ˆâ•‘â–ˆâ–ˆâ•‘  â–ˆâ–ˆâ•‘â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•‘   â•‘
  â•‘  â•šâ•â•  â•šâ•â•â•šâ•â•  â•šâ•â•â•šâ•â•â•â•â•â•â•â•šâ•â•â•â•â•â•â•  â•‘
  â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
  â•‘  ðŸ¤– BOTS: ${String(Object.keys(activeBots).length).padEnd(4)} â”‚ ðŸ–¥  RAM: ${ramUso}/${ramTotal}MB â”‚ â± ${uptime}s  â•‘
  â•‘  ðŸŒ Dashboard: ${DOMAIN.padEnd(22)} â•‘
  â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`
  );
};

// â”€â”€â”€ Main Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ARES HOST â€” Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap" rel="stylesheet"/>
<script src="/socket.io/socket.io.js"></script>
<style>
  :root {
    --g: #00ff88;
    --g2: #00cc66;
    --r: #ff4444;
    --y: #ffcc00;
    --bg: #050a05;
    --card: #0a120a;
    --border: #1a2e1a;
    --text: #c8e6c8;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Share Tech Mono', monospace;
    min-height: 100vh;
    overflow-x: hidden;
  }
  body::before {
    content:'';
    position:fixed; inset:0;
    background: repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,255,136,0.015) 2px,rgba(0,255,136,0.015) 4px);
    pointer-events:none; z-index:0;
  }

  /* â”€â”€ Header â”€â”€ */
  header {
    display:flex; align-items:center; justify-content:space-between;
    padding: 18px 32px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(90deg,#050a05,#0d1f0d,#050a05);
    position: sticky; top:0; z-index:100;
    box-shadow: 0 0 40px rgba(0,255,136,0.08);
  }
  .logo {
    font-family:'Orbitron',sans-serif;
    font-size:1.6rem; font-weight:900;
    color: var(--g);
    text-shadow: 0 0 20px rgba(0,255,136,0.6);
    letter-spacing:4px;
  }
  .logo span { color:#fff; }
  .header-stats {
    display:flex; gap:24px; align-items:center;
  }
  .stat-pill {
    background: rgba(0,255,136,0.06);
    border: 1px solid var(--border);
    border-radius:4px;
    padding:6px 14px;
    font-size:.75rem;
    color: var(--g2);
    display:flex; align-items:center; gap:6px;
  }
  .stat-pill .dot {
    width:7px; height:7px; border-radius:50%;
    background: var(--g);
    box-shadow: 0 0 8px var(--g);
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse {
    0%,100%{opacity:1;transform:scale(1)}
    50%{opacity:.4;transform:scale(.8)}
  }
  .nav-link {
    color: var(--g2); text-decoration:none;
    border: 1px solid var(--border);
    padding:6px 16px; border-radius:4px;
    font-size:.75rem; transition:.2s;
  }
  .nav-link:hover { border-color:var(--g); color:var(--g); background:rgba(0,255,136,0.05); }

  /* â”€â”€ Layout â”€â”€ */
  main { padding:32px; position:relative; z-index:1; max-width:1400px; margin:0 auto; }

  /* â”€â”€ Section Title â”€â”€ */
  .section-title {
    font-family:'Orbitron',sans-serif;
    font-size:.65rem; letter-spacing:3px;
    color: rgba(0,255,136,0.4);
    text-transform:uppercase;
    margin-bottom:16px;
    display:flex; align-items:center; gap:12px;
  }
  .section-title::after {
    content:''; flex:1; height:1px;
    background: linear-gradient(90deg,var(--border),transparent);
  }

  /* â”€â”€ Stats Row â”€â”€ */
  .stats-grid {
    display:grid; grid-template-columns:repeat(4,1fr); gap:16px;
    margin-bottom:36px;
  }
  .stat-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius:6px;
    padding:20px;
    position:relative; overflow:hidden;
    transition:.3s;
  }
  .stat-card:hover { border-color:var(--g); box-shadow:0 0 20px rgba(0,255,136,0.06); }
  .stat-card::before {
    content:''; position:absolute;
    top:0; left:0; right:0; height:2px;
    background: linear-gradient(90deg,transparent,var(--g),transparent);
    opacity:.4;
  }
  .stat-card .label {
    font-size:.65rem; letter-spacing:2px;
    color:rgba(0,255,136,0.4); text-transform:uppercase; margin-bottom:8px;
  }
  .stat-card .value {
    font-family:'Orbitron',sans-serif;
    font-size:1.8rem; font-weight:700; color:var(--g);
    text-shadow:0 0 20px rgba(0,255,136,0.4);
  }
  .stat-card .sub { font-size:.7rem; color:rgba(200,230,200,.4); margin-top:4px; }

  /* â”€â”€ Bots Grid â”€â”€ */
  #bots-grid {
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(340px,1fr));
    gap:20px;
  }
  .bot-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius:8px;
    overflow:hidden;
    transition:.3s;
    position:relative;
  }
  .bot-card:hover { border-color:rgba(0,255,136,.3); transform:translateY(-2px); box-shadow:0 8px 32px rgba(0,255,136,0.06); }
  .bot-card.offline { opacity:.55; }

  .bot-header {
    display:flex; align-items:center; justify-content:space-between;
    padding:16px 18px;
    border-bottom:1px solid var(--border);
    background: linear-gradient(90deg,rgba(0,255,136,0.04),transparent);
  }
  .bot-name-wrap { display:flex; align-items:center; gap:10px; }
  .bot-status-dot {
    width:9px; height:9px; border-radius:50%;
    background:var(--g); box-shadow:0 0 10px var(--g);
    animation:pulse 1.5s infinite;
    flex-shrink:0;
  }
  .bot-status-dot.offline { background:var(--r); box-shadow:0 0 10px var(--r); animation:none; }
  .bot-name {
    font-family:'Orbitron',sans-serif;
    font-size:.8rem; font-weight:700; color:#fff;
    letter-spacing:1px;
  }
  .bot-badge {
    font-size:.6rem; padding:3px 8px; border-radius:3px;
    background:rgba(0,255,136,0.1); color:var(--g2);
    border:1px solid rgba(0,255,136,0.2);
    letter-spacing:1px;
  }
  .bot-badge.offline { background:rgba(255,68,68,.1); color:#ff8888; border-color:rgba(255,68,68,.2); }

  .bot-meta {
    padding:12px 18px;
    display:grid; grid-template-columns:1fr 1fr; gap:8px;
    border-bottom:1px solid var(--border);
  }
  .meta-item { font-size:.65rem; color:rgba(200,230,200,.5); }
  .meta-item span { color:var(--g2); }

  /* Mini terminal preview */
  .bot-log-preview {
    background:#020602; padding:10px 18px; height:80px;
    overflow:hidden; position:relative;
    font-size:.65rem; line-height:1.5; color:rgba(0,255,136,.6);
  }
  .bot-log-preview::after {
    content:''; position:absolute; bottom:0; left:0; right:0; height:30px;
    background:linear-gradient(transparent,#020602);
  }

  /* Actions */
  .bot-actions {
    display:grid; grid-template-columns:repeat(3,1fr); gap:1px;
    background:var(--border);
    border-top:1px solid var(--border);
  }
  .btn-action {
    padding:10px 8px;
    background:var(--card); color:rgba(200,230,200,.7);
    border:none; cursor:pointer; font-family:'Share Tech Mono',monospace;
    font-size:.65rem; letter-spacing:1px;
    display:flex; align-items:center; justify-content:center; gap:5px;
    transition:.2s;
    text-decoration:none;
  }
  .btn-action:hover { background:rgba(0,255,136,0.06); color:var(--g); }
  .btn-action.danger:hover { background:rgba(255,68,68,0.08); color:var(--r); }
  .btn-action.warn:hover { background:rgba(255,204,0,0.08); color:var(--y); }

  /* â”€â”€ Empty State â”€â”€ */
  .empty-state {
    grid-column:1/-1;
    text-align:center; padding:80px 40px;
    border:1px dashed var(--border); border-radius:8px;
  }
  .empty-state .icon { font-size:3rem; margin-bottom:16px; opacity:.3; }
  .empty-state p { color:rgba(200,230,200,.3); font-size:.8rem; line-height:1.8; }

  /* â”€â”€ Toast â”€â”€ */
  #toast {
    position:fixed; bottom:30px; right:30px;
    background: rgba(0,20,0,.95); border:1px solid var(--g);
    color:var(--g); padding:12px 20px; border-radius:6px;
    font-size:.75rem; z-index:999; opacity:0; transition:.3s;
    pointer-events:none; box-shadow:0 0 30px rgba(0,255,136,0.2);
  }
  #toast.show { opacity:1; }

  @media(max-width:768px){
    .stats-grid{grid-template-columns:1fr 1fr}
    header{padding:14px 16px}
    main{padding:16px}
  }
</style>
</head>
<body>

<header>
  <div class="logo">ARES<span>HOST</span></div>
  <div class="header-stats">
    <div class="stat-pill"><div class="dot"></div><span id="h-bots">0</span> bots ativos</div>
    <div class="stat-pill">RAM: <span id="h-ram">â€¦</span></div>
    <a href="/" class="nav-link">âŸ³ Atualizar</a>
  </div>
</header>

<main>
  <div class="section-title">MÃ©tricas do Sistema</div>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="label">Bots Online</div>
      <div class="value" id="s-online">0</div>
      <div class="sub">instÃ¢ncias ativas</div>
    </div>
    <div class="stat-card">
      <div class="label">RAM Usada</div>
      <div class="value" id="s-ram">â€”</div>
      <div class="sub" id="s-ram-sub">de â€” MB</div>
    </div>
    <div class="stat-card">
      <div class="label">CPU Cores</div>
      <div class="value" id="s-cpu">â€”</div>
      <div class="sub" id="s-plat">plataforma</div>
    </div>
    <div class="stat-card">
      <div class="label">Uptime</div>
      <div class="value" id="s-uptime">0s</div>
      <div class="sub">servidor ativo</div>
    </div>
  </div>

  <div class="section-title">InstÃ¢ncias de Bots</div>
  <div id="bots-grid">
    <div class="empty-state">
      <div class="icon">ðŸ¤–</div>
      <p>Nenhum bot ativo ainda.<br/>Envie um arquivo .zip pelo Telegram para iniciar uma instÃ¢ncia.</p>
    </div>
  </div>
</main>

<div id="toast"></div>

<script>
const socket = io();
const logs = {};
let startTime = Date.now();

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function fmt(ms) {
  const s = Math.floor(ms/1000);
  if(s<60) return s+'s';
  if(s<3600) return Math.floor(s/60)+'m '+s%60+'s';
  return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
}

async function refreshStats() {
  const r = await fetch('/api/stats');
  const d = await r.json();
  document.getElementById('h-bots').textContent = d.bots;
  document.getElementById('s-online').textContent = d.bots;
  document.getElementById('h-ram').textContent = d.ramUsed+'MB';
  document.getElementById('s-ram').textContent = d.ramUsed;
  document.getElementById('s-ram-sub').textContent = 'de '+d.ramTotal+' MB';
  document.getElementById('s-cpu').textContent = d.cpus;
  document.getElementById('s-plat').textContent = d.platform;
  document.getElementById('s-uptime').textContent = fmt(Date.now()-startTime);
}

async function refreshBots() {
  const r = await fetch('/api/bots');
  const bots = await r.json();
  const grid = document.getElementById('bots-grid');

  if(bots.length === 0) {
    grid.innerHTML = \`<div class="empty-state"><div class="icon">ðŸ¤–</div><p>Nenhum bot ativo ainda.<br/>Envie um arquivo .zip pelo Telegram para iniciar uma instÃ¢ncia.</p></div>\`;
    return;
  }

  // update or create cards
  const existing = new Set([...grid.querySelectorAll('.bot-card')].map(c=>c.dataset.id));
  const current = new Set(bots.map(b=>b.id));

  // remove offline cards that are no longer needed
  existing.forEach(id => {
    if(!current.has(id)) {
      const card = grid.querySelector(\`[data-id="\${id}"]\`);
      if(card) card.remove();
    }
  });

  bots.forEach(bot => {
    let card = grid.querySelector(\`[data-id="\${bot.id}"]\`);
    if(!card) {
      card = document.createElement('div');
      card.className = 'bot-card';
      card.dataset.id = bot.id;
      grid.appendChild(card);
      // subscribe to logs
      if(!logs[bot.id]) logs[bot.id] = [];
      socket.on('log-'+bot.id, (data) => {
        logs[bot.id] = [...(logs[bot.id]||[]), data].slice(-200);
        const preview = card.querySelector('.bot-log-preview');
        if(preview) preview.textContent = logs[bot.id].join('');
      });
    }
    const online = bot.online;
    card.className = 'bot-card'+(online?'':' offline');
    card.innerHTML = \`
      <div class="bot-header">
        <div class="bot-name-wrap">
          <div class="bot-status-dot\${online?'':' offline'}"></div>
          <div class="bot-name">\${bot.id}</div>
        </div>
        <span class="bot-badge\${online?'':' offline'}">\${online?'ONLINE':'OFFLINE'}</span>
      </div>
      <div class="bot-meta">
        <div class="meta-item">PID <span>\${bot.pid||'â€”'}</span></div>
        <div class="meta-item">STATUS <span>\${online?'running':'stopped'}</span></div>
        <div class="meta-item">UPTIME <span>\${bot.uptime||'â€”'}</span></div>
        <div class="meta-item">PATH <span title="\${bot.path}">/â€¦/\${bot.id.slice(0,8)}</span></div>
      </div>
      <div class="bot-log-preview">\${(logs[bot.id]||[]).join('')||'> aguardando logs...'}</div>
      <div class="bot-actions">
        <a class="btn-action" href="/terminal/\${bot.id}" target="_blank">ðŸ“Ÿ Terminal</a>
        <button class="btn-action warn" onclick="restartBot('\${bot.id}')">ðŸ”„ Restart</button>
        <button class="btn-action danger" onclick="stopBot('\${bot.id}')">â¹ Parar</button>
      </div>
    \`;
  });
}

async function stopBot(id) {
  if(!confirm('Parar o bot '+id+'?')) return;
  await fetch('/api/bots/'+encodeURIComponent(id)+'/stop', {method:'POST'});
  toast('â¹ Bot '+id+' parado.');
  setTimeout(refreshBots,500);
}

async function restartBot(id) {
  await fetch('/api/bots/'+encodeURIComponent(id)+'/restart', {method:'POST'});
  toast('ðŸ”„ Reiniciando '+id+'...');
  setTimeout(refreshBots,1500);
}

// Live updates
socket.on('bots-update', () => { refreshBots(); refreshStats(); });

setInterval(refreshStats, 5000);
setInterval(refreshBots, 8000);
refreshStats(); refreshBots();
</script>
</body>
</html>`);
});

// â”€â”€â”€ Terminal Page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/terminal/:id", (req, res) => {
  const botId = req.params.id;
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<title>Terminal — ${botId}</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@700&display=swap" rel="stylesheet"/>
<script src="/socket.io/socket.io.js"></script>
<style>
  :root{--g:#00ff88;--r:#ff4444;--bg:#030803;--border:#152015}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:#aed6ae;font-family:'Share Tech Mono',monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
  body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,255,136,.012) 2px,rgba(0,255,136,.012) 4px);pointer-events:none}
  header{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--border);background:#050a05;flex-shrink:0}
  .t-logo{font-family:'Orbitron',sans-serif;font-size:.75rem;color:var(--g);letter-spacing:3px;text-shadow:0 0 15px rgba(0,255,136,.5)}
  .t-info{display:flex;gap:16px;align-items:center;font-size:.7rem}
  .t-badge{padding:4px 10px;background:rgba(0,255,136,.08);border:1px solid rgba(0,255,136,.2);border-radius:3px;color:var(--g)}
  .t-dot{width:7px;height:7px;border-radius:50%;background:var(--g);box-shadow:0 0 8px var(--g);animation:p 1.5s infinite}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
  .toolbar{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border);flex-shrink:0}
  .tb-btn{padding:8px 20px;background:#050a05;color:rgba(174,214,174,.6);border:none;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.65rem;letter-spacing:1px;transition:.2s}
  .tb-btn:hover{background:rgba(0,255,136,.06);color:var(--g)}
  .tb-btn.danger:hover{background:rgba(255,68,68,.08);color:var(--r)}
  #log{flex:1;overflow-y:auto;padding:16px 20px;font-size:.72rem;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:rgba(0,255,136,.8)}
  #log::-webkit-scrollbar{width:6px}
  #log::-webkit-scrollbar-track{background:#030803}
  #log::-webkit-scrollbar-thumb{background:#1a2e1a;border-radius:3px}
  footer{padding:8px 20px;border-top:1px solid var(--border);background:#050a05;font-size:.6rem;color:rgba(0,255,136,.3);flex-shrink:0;display:flex;justify-content:space-between}
  #line-count{color:rgba(0,255,136,.5)}
</style>
</head>
<body>
<header>
  <div class="t-logo">ARES — TERMINAL</div>
  <div class="t-info">
    <div class="t-dot"></div>
    <span>${botId}</span>
    <span class="t-badge" id="status">CONECTANDO</span>
  </div>
</header>
<div class="toolbar">
  <button class="tb-btn" onclick="clearLog()">🗑 Limpar</button>
  <button class="tb-btn" onclick="copyLog()">📋 Copiar</button>
  <button class="tb-btn" onclick="autoScroll=!autoScroll">⇣ Auto-scroll</button>
  <button class="tb-btn danger" onclick="stopBot()">⏹ Parar Bot</button>
  <button class="tb-btn" onclick="restartBot()">🔄 Restart</button>
  <button class="tb-btn" onclick="window.close()">✕ Fechar</button>
</div>
<div id="log">Conectando ao bot <b>${botId}</b>...\n\n</div>
<footer>
  <span>BOT: ${botId}</span>
  <span id="line-count">0 linhas</span>
  <span id="ts">—</span>
</footer>
<script>
const socket = io();
const logDiv = document.getElementById('log');
let lines = 0, autoScroll = true;
socket.on('log-${botId}', data => {
  logDiv.innerHTML += data.replace(/</g,'&lt;');
  lines += data.split('\\n').length;
  document.getElementById('line-count').textContent = lines+' linhas';
  document.getElementById('ts').textContent = new Date().toLocaleTimeString();
  document.getElementById('status').textContent = 'ATIVO';
  if(autoScroll) logDiv.scrollTop = logDiv.scrollHeight;
});
function clearLog(){logDiv.innerHTML='';lines=0;}
function copyLog(){navigator.clipboard.writeText(logDiv.innerText);}
async function stopBot(){if(!confirm('Parar ${botId}?'))return;await fetch('/api/bots/${botId}/stop',{method:'POST'});document.getElementById('status').textContent='PARADO';}
async function restartBot(){await fetch('/api/bots/${botId}/restart',{method:'POST'});}
</script>
</body>
</html>`);
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const ramUsed = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
  const ramTotal = (os.totalmem() / 1024 / 1024).toFixed(0);
  res.json({
    bots: Object.keys(activeBots).length,
    ramUsed,
    ramTotal,
    cpus: os.cpus().length,
    platform: os.platform(),
    uptime: process.uptime().toFixed(0),
  });
});

app.get("/api/bots", (req, res) => {
  const list = Object.entries(activeBots).map(([id, info]) => ({
    id,
    online: true,
    pid: info.process?.pid || null,
    path: path.resolve(BASE_PATH, id),
    uptime: info.startedAt
      ? Math.floor((Date.now() - info.startedAt) / 1000) + "s"
      : "—",
  }));
  res.json(list);
});

app.post("/api/bots/:id/stop", (req, res) => {
  const id = req.params.id;
  if (activeBots[id]) {
    activeBots[id].process?.kill("SIGTERM");
    delete activeBots[id];
    io.emit("bots-update");
    aresBanner();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "not found" });
  }
});

app.post("/api/bots/:id/restart", async (req, res) => {
  const id = req.params.id;
  const instancePath = path.resolve(BASE_PATH, id);
  if (!fs.existsSync(instancePath))
    return res.status(404).json({ error: "path not found" });
  if (activeBots[id]) activeBots[id].process?.kill("SIGTERM");
  setTimeout(() => {
    const files = fs.readdirSync(instancePath);
    const mainFile = files.find((f) =>
      ["index.js", "main.js", "bot.js", "start.js"].includes(f)
    );
    if (!mainFile) return res.status(400).json({ error: "no main file" });
    const child = spawn("node", ["--max-old-space-size=64", mainFile], {
      cwd: instancePath,
      stdio: "pipe",
      shell: true,
    });
    activeBots[id] = { process: child, startedAt: Date.now() };
    child.stdout.on("data", (data) => {
      io.emit(`log-${id}`, data.toString());
    });
    child.stderr.on("data", (data) => {
      io.emit(`log-${id}`, `\nERRO: ${data.toString()}`);
    });
    child.on("exit", () => {
      delete activeBots[id];
      io.emit("bots-update");
      aresBanner();
    });
    io.emit("bots-update");
    aresBanner();
    res.json({ ok: true });
  }, 800);
});

// ─── Start Instance ───────────────────────────────────────────────────────────
async function startInstance(chatId, fileId, botId) {
  const instancePath = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(instancePath))
    fs.mkdirSync(instancePath, { recursive: true });

  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

    require("https").get(fileUrl, (res) => {
      res
        .pipe(unzipper.Extract({ path: instancePath }))
        .on("close", async () => {
          const files = fs.readdirSync(instancePath);
          const mainFile = files.find((f) =>
            ["index.js", "main.js", "bot.js", "start.js"].includes(f)
          );
          if (!mainFile)
            return bot.sendMessage(
              chatId,
              "❌ Arquivo principal (.js) não encontrado no .zip"
            );

          const child = spawn(
            "node",
            ["--max-old-space-size=64", mainFile],
            { cwd: instancePath, stdio: "pipe", shell: true }
          );

          activeBots[botId] = { process: child, startedAt: Date.now() };

          child.stdout.on("data", (data) => {
            const out = data.toString();
            process.stdout.write(`[${botId}] ${out}`);
            io.emit(`log-${botId}`, out);
          });
          child.stderr.on("data", (data) => {
            io.emit(`log-${botId}`, `\nERRO: ${data.toString()}`);
          });
          child.on("exit", () => {
            delete activeBots[botId];
            io.emit("bots-update");
            aresBanner();
          });

          io.emit("bots-update");
          const termUrl = `${DOMAIN}/terminal/${botId}`;
          const dashUrl = `${DOMAIN}`;

          await bot.sendMessage(
            chatId,
            `✅ *Bot Iniciado com Sucesso!*\n\n` +
              `🤖 *Nome:* \`${botId}\`\n` +
              `📟 *Terminal:* ${termUrl}\n` +
              `🖥 *Dashboard:* ${dashUrl}\n\n` +
              `_Use os botões abaixo para controlar o bot:_`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "📟 Abrir Terminal", url: termUrl },
                    { text: "🖥 Dashboard", url: dashUrl },
                  ],
                  [
                    { text: "🔄 Restart", callback_data: `restart:${botId}` },
                    { text: "⏹ Parar", callback_data: `stop:${botId}` },
                    { text: "📊 Status", callback_data: `status:${botId}` },
                  ],
                ],
              },
            }
          );
          aresBanner();
        });
    });
  } catch (e) {
    bot.sendMessage(chatId, `❌ *Erro no download:*\n\`${e.message}\``, {
      parse_mode: "Markdown",
    });
  }
}

// ─── Telegram Commands ────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "usuário";
  bot.sendMessage(
    msg.chat.id,
    `🔥 *ARES HOST* — Painel de Controle\n\n` +
      `Olá, *${name}*! Bem-vindo ao sistema.\n\n` +
      `📦 Envie um arquivo *.zip* com o nome do bot na legenda para hospedar.\n\n` +
      `*Comandos disponíveis:*\n` +
      `/start — Início\n` +
      `/list — Listar bots ativos\n` +
      `/stop <nome> — Parar um bot\n` +
      `/restart <nome> — Reiniciar um bot\n` +
      `/status — Ver status do sistema\n` +
      `/dashboard — Link do painel web`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🖥 Abrir Dashboard", url: `${DOMAIN}` }],
          [
            { text: "📋 Listar Bots", callback_data: "cmd:list" },
            { text: "📊 Status", callback_data: "cmd:status" },
          ],
        ],
      },
    }
  );
  aresBanner();
});

bot.onText(/\/list/, (msg) => {
  const ids = Object.keys(activeBots);
  if (ids.length === 0) {
    return bot.sendMessage(msg.chat.id, "📭 Nenhum bot ativo no momento.");
  }
  const txt =
    `🤖 *Bots Ativos (${ids.length}):*\n\n` +
    ids.map((id) => `• \`${id}\``).join("\n");

  const keyboard = ids.map((id) => [
    { text: `📟 ${id}`, url: `${DOMAIN}/terminal/${id}` },
    { text: "🔄", callback_data: `restart:${id}` },
    { text: "⏹", callback_data: `stop:${id}` },
  ]);
  keyboard.push([{ text: "🖥 Dashboard Completo", url: DOMAIN }]);

  bot.sendMessage(msg.chat.id, txt, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
});

bot.onText(/\/status/, (msg) => {
  const ramUso = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
  const ramTotal = (os.totalmem() / 1024 / 1024).toFixed(0);
  const uptime = process.uptime().toFixed(0);
  const ids = Object.keys(activeBots);

  bot.sendMessage(
    msg.chat.id,
    `📊 *Status do Sistema*\n\n` +
      `🤖 Bots ativos: *${ids.length}*\n` +
      `🖥 RAM: *${ramUso}/${ramTotal} MB*\n` +
      `⏱ Uptime: *${uptime}s*\n` +
      `🔧 CPUs: *${os.cpus().length}*\n` +
      `💻 OS: *${os.platform()}*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🖥 Dashboard", url: DOMAIN }]],
      },
    }
  );
});

bot.onText(/\/dashboard/, (msg) => {
  bot.sendMessage(msg.chat.id, `🖥 *Dashboard Ares Host*\n\n${DOMAIN}`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "🚀 Abrir Painel", url: DOMAIN }]],
    },
  });
});

bot.onText(/\/stop (.+)/, (msg, match) => {
  const id = match[1].trim();
  if (!activeBots[id])
    return bot.sendMessage(msg.chat.id, `❌ Bot \`${id}\` não encontrado.`, {
      parse_mode: "Markdown",
    });
  activeBots[id].process?.kill("SIGTERM");
  delete activeBots[id];
  io.emit("bots-update");
  aresBanner();
  bot.sendMessage(msg.chat.id, `⏹ Bot \`${id}\` parado com sucesso.`, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/restart (.+)/, async (msg, match) => {
  const id = match[1].trim();
  const instancePath = path.resolve(BASE_PATH, id);
  if (!fs.existsSync(instancePath))
    return bot.sendMessage(msg.chat.id, `❌ Bot \`${id}\` não encontrado.`, {
      parse_mode: "Markdown",
    });
  if (activeBots[id]) activeBots[id].process?.kill("SIGTERM");
  setTimeout(() => {
    const files = fs.readdirSync(instancePath);
    const mainFile = files.find((f) =>
      ["index.js", "main.js", "bot.js", "start.js"].includes(f)
    );
    if (!mainFile) return;
    const child = spawn("node", ["--max-old-space-size=64", mainFile], {
      cwd: instancePath,
      stdio: "pipe",
      shell: true,
    });
    activeBots[id] = { process: child, startedAt: Date.now() };
    child.stdout.on("data", (data) => io.emit(`log-${id}`, data.toString()));
    child.stderr.on("data", (data) =>
      io.emit(`log-${id}`, `\nERRO: ${data.toString()}`)
    );
    child.on("exit", () => {
      delete activeBots[id];
      io.emit("bots-update");
      aresBanner();
    });
    io.emit("bots-update");
    aresBanner();
  }, 800);
  bot.sendMessage(msg.chat.id, `🔄 Bot \`${id}\` reiniciando...`, {
    parse_mode: "Markdown",
  });
});

// ─── Inline Button Callbacks ──────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  if (data === "cmd:list") {
    bot.answerCallbackQuery(query.id);
    return bot.emit("text", {
      ...query.message,
      text: "/list",
      chat: { id: chatId },
    });
  }
  if (data === "cmd:status") {
    bot.answerCallbackQuery(query.id);
    const ramUso = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
    const ramTotal = (os.totalmem() / 1024 / 1024).toFixed(0);
    return bot.sendMessage(
      chatId,
      `📊 RAM: *${ramUso}/${ramTotal}MB* | Bots: *${Object.keys(activeBots).length}*`,
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
          [{ text: "🔄 Reiniciar", callback_data: `restart:${botId}` }],
        ],
      },
      { chat_id: chatId, message_id: msgId }
    );
  }

  if (action === "restart") {
    const instancePath = path.resolve(BASE_PATH, botId);
    if (activeBots[botId]) activeBots[botId].process?.kill("SIGTERM");
    bot.answerCallbackQuery(query.id, { text: `🔄 Reiniciando ${botId}...` });
    setTimeout(() => {
      if (!fs.existsSync(instancePath)) return;
      const files = fs.readdirSync(instancePath);
      const mainFile = files.find((f) =>
        ["index.js", "main.js", "bot.js", "start.js"].includes(f)
      );
      if (!mainFile) return;
      const child = spawn("node", ["--max-old-space-size=64", mainFile], {
        cwd: instancePath,
        stdio: "pipe",
        shell: true,
      });
      activeBots[botId] = { process: child, startedAt: Date.now() };
      child.stdout.on("data", (d) => io.emit(`log-${botId}`, d.toString()));
      child.stderr.on("data", (d) =>
        io.emit(`log-${botId}`, `\nERRO: ${d.toString()}`)
      );
      child.on("exit", () => {
        delete activeBots[botId];
        io.emit("bots-update");
        aresBanner();
      });
      io.emit("bots-update");
      aresBanner();
    }, 800);
  }

  if (action === "status") {
    const b = activeBots[botId];
    const uptime = b?.startedAt
      ? Math.floor((Date.now() - b.startedAt) / 1000) + "s"
      : "—";
    bot.answerCallbackQuery(query.id, {
      text: `🤖 ${botId} | Online | Uptime: ${uptime}`,
      show_alert: true,
    });
  }
});

// ─── File Upload Handler ──────────────────────────────────────────────────────
bot.on("document", async (msg) => {
  if (!msg.document.file_name.endsWith(".zip")) return;
  if (msg.document.file_size > 20 * 1024 * 1024) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ Arquivo muito grande! Máximo permitido: *20MB*",
      { parse_mode: "Markdown" }
    );
  }
  const name = msg.caption
    ? msg.caption.replace(/[^a-zA-Z0-9_\-]/g, "_")
    : `bot_${Date.now()}`;

  bot.sendMessage(msg.chat.id, `⏳ Iniciando \`${name}\`...`, {
    parse_mode: "Markdown",
  });
  await startInstance(msg.chat.id, msg.document.file_id, name);
});

server.listen(PORT, "0.0.0.0", () => aresBanner());
