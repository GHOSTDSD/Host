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
const DOMAIN  = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://localhost:${PORT}`;

const bot    = new TelegramBot(TOKEN, { polling: true });
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server);

app.use(express.json());

const BASE_PATH = path.resolve(process.cwd(), "instances");
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

const activeBots = {};

process.on("uncaughtException", (err) => {
  if (err.message.includes("file is too big")) return;
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

const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ARES HOST — Terminal</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@700&display=swap" rel="stylesheet"/>
<script src="/socket.io/socket.io.js"></script>
<style>
:root{--g:#00ff88;--g2:#00cc66;--r:#ff4444;--bg:#020602;--border:#142014}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:#9ec89e;font-family:'Share Tech Mono',monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{display:flex;align-items:center;justify-content:space-between;padding:15px 25px;border-bottom:1px solid var(--border);background:#030803}
.logo{font-family:'Orbitron',sans-serif;color:var(--g);letter-spacing:3px;font-size:1.2rem}
.status-bar{display:flex;gap:20px;font-size:0.8rem}
#log{flex:1;overflow-y:auto;padding:20px;font-size:0.85rem;line-height:1.6;white-space:pre-wrap;word-break:break-all;background:#010501;color:rgba(0,255,136,0.8)}
.toolbar{display:flex;background:#030803;border-top:1px solid var(--border);padding:10px}
button{background:transparent;border:1px solid var(--border);color:var(--g2);padding:8px 15px;cursor:pointer;font-family:inherit;margin-right:10px;transition:0.3s}
button:hover{background:rgba(0,255,136,0.1);border-color:var(--g)}
</style>
</head>
<body>
<header>
  <div class="logo">ARES HOST</div>
  <div class="status-bar">
    <span id="stat-mem">RAM: --</span>
    <span id="stat-bots">BOTS: --</span>
  </div>
</header>
<div id="log">Aguardando conexão com o servidor...</div>
<div class="toolbar">
  <button onclick="location.reload()">🔄 Refresh</button>
  <button onclick="document.getElementById('log').innerHTML=''">🗑 Limpar</button>
</div>
<script>
const socket = io();
const logEl = document.getElementById('log');
socket.on('connect', () => { logEl.innerHTML += '\\n[SISTEMA] Conectado ao Terminal Principal.\\n'; });
socket.on('global-log', data => {
  logEl.innerHTML += data;
  logEl.scrollTop = logEl.scrollHeight;
});
setInterval(async () => {
  const res = await fetch('/api/stats');
  const d = await res.json();
  document.getElementById('stat-mem').textContent = 'RAM: ' + d.ramUsed + '/' + d.ramTotal + 'MB';
  document.getElementById('stat-bots').textContent = 'BOTS: ' + d.bots;
}, 3000);
</script>
</body>
</html>`;

app.get("/", (req, res) => res.send(TERMINAL_HTML));

app.get("/api/stats", (req, res) => {
  res.json({
    bots: Object.keys(activeBots).length,
    ramUsed: ramUsed(),
    ramTotal: ramTotal(),
    uptime: process.uptime().toFixed(0)
  });
});

function spawnBot(botId, instancePath, chatId) {
  const files = fs.readdirSync(instancePath);
  const mainFile = files.find(f => ["index.js", "main.js", "bot.js", "start.js"].includes(f));
  const hasPkg = fs.existsSync(path.join(instancePath, "package.json"));

  let child;

  if (mainFile) {
    child = spawn("node", ["--max-old-space-size=128", mainFile], { cwd: instancePath, stdio: "pipe", shell: true });
  } else if (hasPkg) {
    const install = spawn("npm", ["install", "--omit=dev"], { cwd: instancePath, stdio: "pipe", shell: true });
    install.on("exit", () => {
      const startChild = spawn("npm", ["start"], { cwd: instancePath, stdio: "pipe", shell: true });
      setupChild(startChild, botId);
    });
    return;
  } else {
    return;
  }

  setupChild(child, botId);
}

function setupChild(child, botId) {
  activeBots[botId] = { process: child, startedAt: Date.now() };
  
  child.stdout.on("data", (data) => {
    const txt = `[${botId}] ${data.toString()}`;
    process.stdout.write(txt);
    io.emit("global-log", txt);
  });

  child.stderr.on("data", (data) => {
    io.emit("global-log", `\n[${botId}-ERRO] ${data.toString()}`);
  });

  child.on("exit", () => {
    delete activeBots[botId];
    aresBanner();
  });

  aresBanner();
}

async function startInstance(chatId, fileId, botId) {
  const instancePath = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

    require("https").get(fileUrl, (res) => {
      res.pipe(unzipper.Extract({ path: instancePath })).on("close", () => {
        spawnBot(botId, instancePath, chatId);
        bot.sendMessage(chatId, `✅ Bot \`${botId}\` iniciado!`, { parse_mode: "Markdown" });
      });
    });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Erro: ${e.message}`);
  }
}

bot.on("document", async (msg) => {
  const doc = msg.document;
  if (!doc.file_name.endsWith(".zip")) return;
  const botId = (msg.caption || `bot_${Date.now()}`).replace(/[^a-zA-Z0-9]/g, "_");
  await startInstance(msg.chat.id, doc.file_id, botId);
});

server.listen(PORT, "0.0.0.0", () => aresBanner());
