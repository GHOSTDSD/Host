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

// Banner Visual
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

// HTML do Terminal Individual (Corrigido)
const getTerminalHTML = (botId) => `
<!DOCTYPE html>
<html>
<head>
  <title>ARES | ${botId}</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body{background:#000;color:#0f0;font-family:monospace;margin:0;display:flex;flex-direction:column;height:100vh}
    header{background:#0a0a0a;padding:15px;border-bottom:1px solid #111;display:flex;justify-content:space-between;font-size:12px}
    #log{flex:1;overflow-y:auto;padding:20px;white-space:pre-wrap;line-height:1.4;font-size:13px}
  </style>
</head>
<body>
  <header><div>● TERMINAL: ${botId}</div><div id="status">CONECTADO</div></header>
  <div id="log"></div>
  <script>
    const socket = io();
    const log = document.getElementById('log');
    socket.on('log-${botId}', d => { 
      log.innerText += d; 
      log.scrollTop = log.scrollHeight; 
    });
  </script>
</body></html>`;

app.get("/terminal/:botId", (req, res) => res.send(getTerminalHTML(req.params.botId)));
app.get("/api/stats", (req, res) => res.json({
  bots: Object.keys(activeBots).length,
  ramUsed: ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0)
}));

function spawnBot(botId, instancePath) {
  const files = fs.readdirSync(instancePath);
  const main = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));
  
  // Resolve EADDRINUSE matando a PORT pros filhos
  const env = { ...process.env, PORT: "" }; 

  const handleProcess = (child) => {
    activeBots[botId] = { process: child };
    child.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    child.stderr.on("data", d => io.emit(`log-${botId}`, d.toString()));
    child.on("exit", () => {
      delete activeBots[botId];
      aresBanner();
    });
  };

  if (main) {
    io.emit(`log-${botId}`, `[SISTEMA] Iniciando via node ${main}...\n`);
    handleProcess(spawn("node", [main], { cwd: instancePath, shell: true, env }));
  } else if (fs.existsSync(path.join(instancePath, "package.json"))) {
    io.emit(`log-${botId}`, `[SISTEMA] Instalando dependências...\n`);
    const inst = spawn("npm", ["install"], { cwd: instancePath, shell: true, env });
    inst.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    inst.on("exit", () => {
      io.emit(`log-${botId}`, `[SISTEMA] Iniciando via npm start...\n`);
      handleProcess(spawn("npm", ["start"], { cwd: instancePath, shell: true, env }));
    });
  }
}

// MENU /START (Corrigido)
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🚀 *ARES HOSTING SYSTEM V2*\n\nStatus: *Operacional*\n\nEnvie o arquivo \`.zip\` do seu bot.\nO terminal será gerado individualmente para cada envio.`, { parse_mode: "Markdown" });
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
            [{ text: "🖥 Ver Terminal", url: termLink }],
            [{ text: "🔄 Reiniciar", callback_data: `restart:${botId}:${p}` }, { text: "🛑 Parar", callback_data: `stop:${botId}` }]
          ]
        }
      };
      bot.sendMessage(msg.chat.id, `✅ *Bot:* \`${botId}\` criado!\nAcompanhe a instalação no terminal acima.`, menu);
    });
  });
});

bot.on("callback_query", (query) => {
  const [action, botId, instancePath] = query.data.split(":");

  if (action === "stop" && activeBots[botId]) {
    activeBots[botId].process.kill('SIGKILL');
    bot.answerCallbackQuery(query.id, { text: "Parado com sucesso!" });
  } else if (action === "restart") {
    if (activeBots[botId]) activeBots[botId].process.kill('SIGKILL');
    bot.answerCallbackQuery(query.id, { text: "Reiniciando instância..." });
    setTimeout(() => spawnBot(botId, instancePath), 2000);
  } else {
    bot.answerCallbackQuery(query.id);
  }
});

server.listen(PORT, () => aresBanner());
