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

// Banner no console do servidor
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

// HTML do Terminal com Filtro por Bot
app.get("/terminal/:botId", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>ARES | TERMINAL ${req.params.botId}</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body{background:#000;color:#0f0;font-family:monospace;margin:0;display:flex;flex-direction:column;height:100vh}
    header{background:#111;padding:15px;border-bottom:1px solid #333;display:flex;justify-content:space-between}
    #log{flex:1;overflow-y:auto;padding:20px;white-space:pre-wrap;font-size:13px;color:#0f0}
    .err{color:#f44}.sys{color:#888}
  </style>
</head>
<body>
  <header><div>● BOT: ${req.params.botId}</div><div id="status">CONECTADO</div></header>
  <div id="log"></div>
  <script>
    const socket = io();
    const log = document.getElementById('log');
    socket.on('log-${req.params.botId}', d => { 
      log.innerHTML += d; 
      log.scrollTop = log.scrollHeight; 
    });
  </script>
</body></html>`);
});

app.get("/api/stats", (req, res) => res.json({
  bots: Object.keys(activeBots).length,
  ramUsed: ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0)
}));

function setupChild(child, botId) {
  activeBots[botId] = { process: child };
  
  child.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
  child.stderr.on("data", d => io.emit(`log-${botId}`, `<span class="err">${d.toString()}</span>`));
  
  child.on("exit", () => {
    io.emit(`log-${botId}`, `\n<span class="sys">[SISTEMA] Bot desligado.</span>\n`);
    delete activeBots[botId];
    aresBanner();
  });
  aresBanner();
}

function spawnBot(botId, instancePath) {
  const files = fs.readdirSync(instancePath);
  const main = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));
  
  // IMPORTANTE: Removemos a PORT para evitar o erro EADDRINUSE
  const env = { ...process.env };
  delete env.PORT; 

  if (main) {
    io.emit(`log-${botId}`, `<span class="sys">[ARES] Iniciando ${main}...</span>\n`);
    setupChild(spawn("node", [main], { cwd: instancePath, shell: true, env }), botId);
  } else if (fs.existsSync(path.join(instancePath, "package.json"))) {
    io.emit(`log-${botId}`, `<span class="sys">[ARES] Instalando dependências...</span>\n`);
    const inst = spawn("npm", ["install"], { cwd: instancePath, shell: true, env });
    
    inst.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    inst.on("exit", () => {
      setupChild(spawn("npm", ["start"], { cwd: instancePath, shell: true, env }), botId);
    });
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🚀 *ARES HOST*\n\nEnvie seu bot em \`.zip\`\nCada bot terá seu próprio link de terminal.`);
});

bot.on("document", async (msg) => {
  if (!msg.document.file_name.endsWith(".zip")) return;
  const botId = (msg.caption || `bot_${Date.now()}`).replace(/[^a-z0-9]/gi, "_");
  const p = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  
  const file = await bot.getFile(msg.document.file_id);
  const termLink = `${DOMAIN}/terminal/${botId}`;

  require("https").get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, (res) => {
    res.pipe(unzipper.Extract({ path: p })).on("close", () => {
      spawnBot(botId, p);
      const menu = {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🖥 Ver Terminal deste Bot", url: termLink }],
            [{ text: "🔄 Restart", callback_data: `restart:${botId}` }, { text: "🛑 Parar", callback_data: `stop:${botId}` }]
          ]
        }
      };
      bot.sendMessage(msg.chat.id, `✅ *Bot:* \`${botId}\` iniciado!\nClique no botão abaixo para ver o terminal exclusivo dele.`, menu);
    });
  });
});

bot.on("callback_query", (query) => {
  const [action, botId] = query.data.split(":");
  const p = path.resolve(BASE_PATH, botId);

  if (action === "stop" && activeBots[botId]) {
    activeBots[botId].process.kill();
  } else if (action === "restart") {
    if (activeBots[botId]) activeBots[botId].process.kill();
    setTimeout(() => spawnBot(botId, p), 1500);
  }
  bot.answerCallbackQuery(query.id);
});

server.listen(PORT, () => aresBanner());
