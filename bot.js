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
header{padding:15px;border-bottom:1px solid #142014;display:flex;justify-content:space-between;background:#030803;font-weight:bold}
#log{flex:1;overflow-y:auto;padding:20px;white-space:pre-wrap;font-size:13px;color:rgba(0,255,136,0.9);line-height:1.5}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-thumb{background:#142014}
</style>
</head>
<body>
<header><div>ARES HOST - LIVE TERMINAL</div><div id="stats">CARREGANDO...</div></header>
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
  activeBots[botId] = { process: child, startedAt: Date.now() };
  child.stdout.on("data", d => {
    const t = `[${botId}] ${d}`;
    process.stdout.write(t);
    io.emit("global-log", t);
  });
  child.stderr.on("data", d => io.emit("global-log", `[${botId}-ERRO] ${d}`));
  child.on("exit", () => {
    delete activeBots[botId];
    aresBanner();
  });
  aresBanner();
}

function spawnBot(botId, instancePath) {
  const files = fs.readdirSync(instancePath);
  const main = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));
  
  if (main) {
    setupChild(spawn("node", ["--max-old-space-size=128", main], { cwd: instancePath, shell: true }), botId);
  } else if (fs.existsSync(path.join(instancePath, "package.json"))) {
    io.emit("global-log", `[${botId}] JS não encontrado, tentando npm start...\\n`);
    const inst = spawn("npm", ["install", "--omit=dev"], { cwd: instancePath, shell: true });
    inst.on("exit", () => setupChild(spawn("npm", ["start"], { cwd: instancePath, shell: true }), botId));
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "✨ *ARES HOST ATIVO*\n\nEnvie o arquivo `.zip` do seu bot para hospedar.", { parse_mode: "Markdown" });
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
      const opts = {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Reiniciar", callback_data: `restart:${botId}` }, { text: "🛑 Parar", callback_data: `stop:${botId}` }],
            [{ text: "📊 Status", callback_data: `status:${botId}` }, { text: "🗑 Deletar", callback_data: `delete:${botId}` }]
          ]
        }
      };
      bot.sendMessage(msg.chat.id, `✅ *Bot:* \`${botId}\` iniciado com sucesso!`, opts);
    });
  });
});

bot.on("callback_query", (query) => {
  const [action, botId] = query.data.split(":");
  const p = path.resolve(BASE_PATH, botId);

  if (action === "stop") {
    if (activeBots[botId]) {
      activeBots[botId].process.kill();
      bot.answerCallbackQuery(query.id, { text: "Bot parado!" });
    }
  } else if (action === "restart") {
    if (activeBots[botId]) activeBots[botId].process.kill();
    setTimeout(() => spawnBot(botId, p), 1000);
    bot.answerCallbackQuery(query.id, { text: "Reiniciando..." });
  } else if (action === "status") {
    const isOnline = activeBots[botId] ? "ON" : "OFF";
    bot.answerCallbackQuery(query.id, { text: `Bot: ${botId} | Status: ${isOnline}`, show_alert: true });
  } else if (action === "delete") {
    if (activeBots[botId]) activeBots[botId].process.kill();
    fs.rmSync(p, { recursive: true, force: true });
    bot.answerCallbackQuery(query.id, { text: "Instância deletada!" });
  }
});

server.listen(PORT, () => aresBanner());
