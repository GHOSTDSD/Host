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
   BOTS ATIVOS: ${Object.keys(activeBots).length} | RAM: ${ram}MB | UP: ${up}s`);
};

// HTML DO TERMINAL ÚNICO
app.get("/terminal/:botId", (req, res) => {
  const { botId } = req.params;
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>ARES | ${botId}</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body{background:#000;color:#0f0;font-family:monospace;margin:0;display:flex;flex-direction:column;height:100vh}
    header{background:#111;padding:15px;border-bottom:1px solid #333;font-size:12px;color:#888}
    #log{flex:1;overflow-y:auto;padding:20px;white-space:pre-wrap;line-height:1.4;font-size:13px}
  </style>
</head>
<body>
  <header>ID: ${botId} | STATUS: CONECTADO</header>
  <div id="log"></div>
  <script>
    const socket = io();
    socket.on('log-${botId}', d => { 
      const log = document.getElementById('log');
      log.innerText += d; 
      log.scrollTop = log.scrollHeight; 
    });
  </script>
</body></html>`);
});

function spawnBot(botId, instancePath) {
  const files = fs.readdirSync(instancePath);
  const main = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));
  
  // SOLUÇÃO DEFINITIVA EADDRINUSE: Porta aleatória para cada sub-bot
  const randomPort = Math.floor(Math.random() * (20000 - 10000) + 10000);
  const childEnv = { ...process.env, PORT: randomPort.toString() };

  const runner = (cmd, args) => {
    const child = spawn(cmd, args, { cwd: instancePath, shell: true, env: childEnv });
    activeBots[botId] = { process: child, port: randomPort };

    child.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    child.stderr.on("data", d => io.emit(`log-${botId}`, d.toString()));
    
    child.on("exit", () => {
      io.emit(`log-${botId}`, `\n[SISTEMA] Processo ${botId} finalizado.\n`);
      delete activeBots[botId];
      aresBanner();
    });
  };

  if (main) {
    io.emit(`log-${botId}`, `[ARES] Iniciando arquivo: ${main}\n`);
    runner("node", [main]);
  } else if (fs.existsSync(path.join(instancePath, "package.json"))) {
    io.emit(`log-${botId}`, "[ARES] Instalando dependências...\n");
    const inst = spawn("npm", ["install"], { cwd: instancePath, shell: true, env: childEnv });
    inst.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    inst.on("exit", () => runner("npm", ["start"]));
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🚀 *ARES HOST V2*\n\nEnvie o arquivo `.zip` do seu bot para hospedar.", { parse_mode: "Markdown" });
});

bot.on("document", async (msg) => {
  if (!msg.document.file_name.endsWith(".zip")) return;
  
  const botId = (msg.caption || `bot_${Date.now()}`).replace(/[^a-z0-9]/gi, "_");
  const p = path.resolve(BASE_PATH, botId);
  
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  const file = await bot.getFile(msg.document.file_id);
  
  require("https").get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, (res) => {
    res.pipe(unzipper.Extract({ path: p })).on("close", () => {
      spawnBot(botId, p);
      const link = `${DOMAIN}/terminal/${botId}`;
      bot.sendMessage(msg.chat.id, `✅ *Hospedado:* \`${botId}\`\n\n🔗 [ACESSAR TERMINAL](${link})`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Reiniciar", callback_data: `restart:${botId}:${p}` }],
            [{ text: "🛑 Parar", callback_data: `stop:${botId}` }]
          ]
        }
      });
    });
  });
});

bot.on("callback_query", (query) => {
  const [action, botId, instancePath] = query.data.split(":");

  if (action === "stop" && activeBots[botId]) {
    activeBots[botId].process.kill('SIGKILL');
    bot.answerCallbackQuery(query.id, { text: "Bot parado!" });
  } else if (action === "restart") {
    if (activeBots[botId]) activeBots[botId].process.kill('SIGKILL');
    bot.answerCallbackQuery(query.id, { text: "Reiniciando..." });
    // Delay de 2s para garantir que o SO liberou os recursos
    setTimeout(() => spawnBot(botId, instancePath), 2000);
  }
});

server.listen(PORT, "0.0.0.0", () => aresBanner());
