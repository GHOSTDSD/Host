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
  console.log("\x1b[31m%s\x1b[0m", `
  ┌───────────────────────────────────────────┐
  │   █████╗ ██████╗ ███████╗███████╗        │
  │  ██╔══██╗██╔══██╗██╔════╝██╔════╝        │
  │  ███████║██████╔╝█████╗  ███████╗        │
  │  ██╔══██║██╔══██╗██╔══╝  ╚════██║        │
  │  ██║  ██║██║  ██║███████╗███████║        │
  │  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝  v2.0 │
  ├───────────────────────────────────────────┤
  │  🤖 BOTS  : ${String(Object.keys(activeBots).length).padEnd(4)}                           │
  │  🖥  RAM   : ${ram} MB                           │
  │  ⏱  UPTIME: ${String(up).padEnd(6)}s                         │
  └───────────────────────────────────────────┘`);
};

const TERMINAL_HTML = `<!DOCTYPE html>
<html>
<head>
<title>ARES | TERMINAL</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  body{background:#000;color:#0f0;font-family:'Courier New',monospace;margin:0;display:flex;flex-direction:column;height:100vh}
  header{background:#0a0a0a;padding:15px;border-bottom:2px solid #111;display:flex;justify-content:space-between;font-size:12px}
  #log{flex:1;overflow-y:auto;padding:20px;white-space:pre-wrap;line-height:1.4;font-size:13px}
  .system{color: #555}
  .install{color: #0088ff}
</style>
</head>
<body>
<header><div>● ARES_SYSTEM_TERMINAL</div><div id="stats">RAM: -- | BOTS: --</div></header>
<div id="log"></div>
<script>
  const socket = io();
  const log = document.getElementById('log');
  socket.on('global-log', d => { 
    log.innerHTML += d; 
    log.scrollTop = log.scrollHeight; 
  });
  setInterval(async () => {
    const r = await fetch('/api/stats');
    const d = await r.json();
    document.getElementById('stats').innerText = 'RAM: '+d.ramUsed+'MB | BOTS: '+d.bots;
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
  child.stdout.on("data", d => io.emit("global-log", `[${botId}] ${d}`));
  child.stderr.on("data", d => io.emit("global-log", `<span style="color:red">[${botId}-ERR] ${d}</span>`));
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
    io.emit("global-log", `<span class="system">[SYSTEM] Iniciando via node ${main}...</span>\n`);
    setupChild(spawn("node", [main], { cwd: instancePath, shell: true }), botId);
  } else if (fs.existsSync(path.join(instancePath, "package.json"))) {
    io.emit("global-log", `<span class="install">[INSTALL] package.json detectado. Iniciando NPM INSTALL...</span>\n`);
    
    const inst = spawn("npm", ["install"], { cwd: instancePath, shell: true });

    inst.stdout.on("data", d => {
      const output = d.toString();
      process.stdout.write(output); 
      io.emit("global-log", `<span class="install">[NPM] ${output}</span>`);
    });

    inst.stderr.on("data", d => {
      io.emit("global-log", `<span style="color:orange">[NPM-WARN] ${d}</span>`);
    });

    inst.on("exit", (code) => {
      if (code === 0) {
        io.emit("global-log", `<span class="system">[SYSTEM] Instalação concluída com sucesso! Rodando npm start...</span>\n`);
        setupChild(spawn("npm", ["start"], { cwd: instancePath, shell: true }), botId);
      } else {
        io.emit("global-log", `<span style="color:red">[ERRO] O npm install falhou com código ${code}</span>\n`);
      }
    });
  }
}

bot.onText(/\/start/, (msg) => {
  const menu = {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🌐 Ver Terminal Online", url: DOMAIN }],
        [{ text: "🛠 Suporte", url: "https://t.me/Vexor" }]
      ]
    }
  };
  bot.sendMessage(msg.chat.id, `🔴 *ARES HOSTING SYSTEM*\n\nStatus: *Operacional*\n\nEnvie o arquivo \`.zip\` do seu bot.\nO sistema irá extrair e instalar as dependências automaticamente.`, menu);
});

bot.on("document", async (msg) => {
  if (!msg.document.file_name.endsWith(".zip")) return;
  const botId = (msg.caption || `bot_${Date.now()}`).replace(/[^a-z0-9]/gi, "_");
  const p = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  
  const file = await bot.getFile(msg.document.file_id);
  io.emit("global-log", `<span class="system">[SYSTEM] Extraindo: ${botId}...</span>\n`);

  require("https").get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, (res) => {
    res.pipe(unzipper.Extract({ path: p })).on("close", () => {
      spawnBot(botId, p);
      const menu = {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Reiniciar", callback_data: `restart:${botId}` }, { text: "🛑 Parar", callback_data: `stop:${botId}` }],
            [{ text: "🗑 Deletar Instância", callback_data: `delete:${botId}` }]
          ]
        }
      };
      bot.sendMessage(msg.chat.id, `📦 *Instância:* \`${botId}\` criada!\nInstalando dependências... acompanhe no terminal.`, menu);
    });
  });
});

bot.on("callback_query", (query) => {
  const [action, botId] = query.data.split(":");
  const p = path.resolve(BASE_PATH, botId);

  if (action === "stop" && activeBots[botId]) {
    activeBots[botId].process.kill();
    bot.answerCallbackQuery(query.id, { text: "Bot parado." });
  } else if (action === "restart") {
    if (activeBots[botId]) activeBots[botId].process.kill();
    setTimeout(() => spawnBot(botId, p), 1000);
    bot.answerCallbackQuery(query.id, { text: "Reiniciando..." });
  } else if (action === "delete") {
    if (activeBots[botId]) activeBots[botId].process.kill();
    fs.rmSync(p, { recursive: true, force: true });
    bot.answerCallbackQuery(query.id, { text: "Instância deletada." });
  }
});

server.listen(PORT, () => aresBanner());
