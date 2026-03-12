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

const aresBanner = () => {
  console.clear();
  const up = process.uptime().toFixed(0);
  const ram = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
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
  ║  🖥  RAM   : ${ram} MB                           ║
  ║  ⏱  UPTIME: ${String(up).padEnd(6)}s                         ║
  ║  🌐 PAINEL : ${DOMAIN.slice(0,30).padEnd(30)} ║
  ╚═══════════════════════════════════════════╝`);
};

const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<title>ARES TERMINAL</title>
<script src="/socket.io/socket.io.js"></script>
<style>
body{background:#020602;color:#00ff88;font-family:monospace;margin:0;overflow:hidden;display:flex;flex-direction:column;height:100vh}
header{padding:10px;border-bottom:1px solid #142014;display:flex;justify-content:space-between;background:#030803}
#log{flex:1;overflow-y:auto;padding:15px;white-space:pre-wrap;font-size:13px;color:rgba(0,255,136,0.9)}
</style>
</head>
<body>
<header><div>ARES HOST - TERMINAL</div><div id="stats">CONECTANDO...</div></header>
<div id="log"></div>
<script>
const socket = io();
const log = document.getElementById('log');
socket.on('global-log', d => { log.innerText += d; log.scrollTop = log.scrollHeight; });
setInterval(async () => {
  const r = await fetch('/api/stats');
  const d = await r.json();
  document.getElementById('stats').innerText = 'BOTS: '+d.bots+' | RAM: '+d.ramUsed+'MB';
}, 2000);
</script>
</body></html>`;

app.get("/", (req, res) => res.send(TERMINAL_HTML));
app.get("/api/stats", (req, res) => res.json({
  bots: Object.keys(activeBots).length,
  ramUsed: ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0)
}));

function setupChild(child, botId) {
  activeBots[botId] = { process: child };
  child.stdout.on("data", d => {
    const t = `[${botId}] ${d}`;
    process.stdout.write(t);
    io.emit("global-log", t);
  });
  child.on("exit", () => {
    delete activeBots[botId];
    aresBanner();
  });
  aresBanner();
}

function spawnBot(botId, instancePath) {
  const files = fs.readdirSync(instancePath);
  const main = files.find(f => ["index.js","main.js","bot.js"].includes(f));
  if (main) {
    setupChild(spawn("node", [main], { cwd: instancePath, shell: true }), botId);
  } else if (fs.existsSync(path.join(instancePath, "package.json"))) {
    const inst = spawn("npm", ["install"], { cwd: instancePath, shell: true });
    inst.on("exit", () => setupChild(spawn("npm", ["start"], { cwd: instancePath, shell: true }), botId));
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🤖 *ARES HOST ATIVO*\n\nEnvie um arquivo `.zip` com seu bot.\nSe não houver `index.js`, tentarei `npm start`.", { parse_mode: "Markdown" });
});

bot.on("document", async (msg) => {
  if (!msg.document.file_name.endsWith(".zip")) return;
  const botId = (msg.caption || `bot_${Date.now()}`).replace(/[^a-z0-9]/gi, "_");
  const p = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(p)) fs.mkdirSync(p);
  
  const file = await bot.getFile(msg.document.file_id);
  require("https").get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, (res) => {
    res.pipe(unzipper.Extract({ path: p })).on("close", () => {
      spawnBot(botId, p);
      bot.sendMessage(msg.chat.id, `✅ Bot \`${botId}\` online!`, { parse_mode: "Markdown" });
    });
  });
});

server.listen(PORT, () => aresBanner());
