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

const BASE_PATH = path.resolve(process.cwd(), "instances");
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

const activeBots = {};

const aresBanner = () => {
  console.clear();
  const up = process.uptime().toFixed(0);
  const ram = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
  console.log("\x1b[31m%s\x1b[0m", `
  ┌───────────────────────────────────────────┐
  │   █████╗ ██████╗ ███████╗███████╗        │
  │  ██╔══██╗██╔══██╗██╔════╝██╔════╝        │
  │  ███████║██████╔╝█████╗  ███████╗        │
  │  ██╔══██║██╔══██╗██╔══╝  ╚════██║        │
  │  ██║  ██║██║  ██║███████╗███████║        │
  └───────────────────────────────────────────┘
   BOTS: ${Object.keys(activeBots).length} | RAM: ${ram}MB | UP: ${up}s`);
};

// TERMINAL INDIVIDUAL
app.get("/terminal/:botId", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>ARES | ${req.params.botId}</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body{background:#000;color:#0f0;font-family:monospace;margin:0;display:flex;flex-direction:column;height:100vh}
    header{background:#111;padding:15px;border-bottom:1px solid #333;font-size:12px}
    #log{flex:1;overflow-y:auto;padding:20px;white-space:pre-wrap;font-size:13px}
  </style>
</head>
<body>
  <header>BOT: ${req.params.botId} | STATUS: CONECTADO</header>
  <div id="log"></div>
  <script>
    const socket = io();
    const log = document.getElementById('log');
    socket.on('log-${req.params.botId}', d => { 
      log.innerText += d; 
      log.scrollTop = log.scrollHeight; 
    });
  </script>
</body></html>`);
});

app.get("/api/stats", (req, res) => res.json({
  bots: Object.keys(activeBots).length,
  ramUsed: ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0)
}));

function spawnBot(botId, instancePath) {
  const files = fs.readdirSync(instancePath);
  const main = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));
  
  // Resolve o erro EADDRINUSE dando uma porta aleatória pro bot filho
  const childEnv = { ...process.env, PORT: Math.floor(Math.random() * 5000) + 10000 };

  const start = (cmd, args) => {
    const child = spawn(cmd, args, { cwd: instancePath, shell: true, env: childEnv });
    activeBots[botId] = { process: child };

    child.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    child.stderr.on("data", d => io.emit(`log-${botId}`, d.toString()));
    
    child.on("exit", () => {
      io.emit(`log-${botId}`, "\n[ARES] Processo encerrado.\n");
      delete activeBots[botId];
      aresBanner();
    });
  };

  if (main) {
    io.emit(`log-${botId}`, `[ARES] Iniciando: ${main}\n`);
    start("node", [main]);
  } else if (fs.existsSync(path.join(instancePath, "package.json"))) {
    io.emit(`log-${botId}`, "[ARES] Instalando dependências...\n");
    const inst = spawn("npm", ["install"], { cwd: instancePath, shell: true, env: childEnv });
    inst.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    inst.on("exit", () => start("npm", ["start"]));
  }
}

bot.on("document", async (msg) => {
  if (!msg.document.file_name.endsWith(".zip")) return;
  const botId = (msg.caption || `bot_${Date.now()}`).replace(/[^a-z0-9]/gi, "_");
  const p = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  
  const file = await bot.getFile(msg.document.file_id);
  const link = `${DOMAIN}/terminal/${botId}`;

  require("https").get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, (res) => {
    res.pipe(unzipper.Extract({ path: p })).on("close", () => {
      spawnBot(botId, p);
      bot.sendMessage(msg.chat.id, `✅ *Bot:* \`${botId}\` ON\n\n🔗 [Ver Terminal](${link})`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 Reiniciar", callback_data: `restart:${botId}` },
            { text: "🛑 Parar", callback_data: `stop:${botId}` }
          ]]
        }
      });
    });
  });
});

bot.on("callback_query", (query) => {
  const [action, botId] = query.data.split(":");
  const p = path.resolve(BASE_PATH, botId);

  if (action === "stop" && activeBots[botId]) {
    activeBots[botId].process.kill('SIGKILL');
    bot.answerCallbackQuery(query.id, { text: "Parado!" });
  } else if (action === "restart") {
    if (activeBots[botId]) activeBots[botId].process.kill('SIGKILL');
    bot.answerCallbackQuery(query.id, { text: "Reiniciando..." });
    setTimeout(() => spawnBot(botId, p), 2000);
  }
});

server.listen(PORT, "0.0.0.0", () => aresBanner());
