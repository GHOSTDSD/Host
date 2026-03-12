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

// Utilitários de sistema
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

// --- Funções de Execução ---

function spawnBot(botId, instancePath, chatId) {
  const files    = fs.readdirSync(instancePath);
  const mainFile = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f));
  const hasPkg   = fs.existsSync(path.join(instancePath, "package.json"));

  if (!mainFile && !hasPkg) return;

  activeBots[botId] = { startedAt: Date.now(), chatId, process: null };

  if (hasPkg) {
    io.emit(`log-${botId}`, `\n[ARES] package.json detetado. Instalando dependências...\n`);
    
    // NPM INSTALL com log em tempo real
    const install = spawn("npm", ["install", "--omit=dev"], {
      cwd: instancePath, stdio: "pipe", shell: true,
    });

    install.stdout.on("data", d => io.emit(`log-${botId}`, d.toString()));
    install.stderr.on("data", d => io.emit(`log-${botId}`, `[NPM-LOG] ${d.toString()}`));

    install.on("exit", (code) => {
      if (code !== 0) {
        io.emit(`log-${botId}`, `\n[ERRO] npm install falhou (Código ${code}).\n`);
        delete activeBots[botId];
        io.emit("bots-update");
        return;
      }
      
      io.emit(`log-${botId}`, `\n[ARES] Dependências OK. Iniciando processo...\n`);
      const child = spawn(mainFile ? "node" : "npm", [mainFile ? mainFile : "start"], {
        cwd: instancePath, stdio: "pipe", shell: true,
      });
      finalizeSpawn(child, botId);
    });
  } else {
    const child = spawn("node", [mainFile], { cwd: instancePath, stdio: "pipe", shell: true });
    finalizeSpawn(child, botId);
  }
}

function finalizeSpawn(child, botId) {
  activeBots[botId].process = child;
  child.stdout.on("data", d => {
    process.stdout.write(`[${botId}] ${d}`);
    io.emit(`log-${botId}`, d.toString());
  });
  child.stderr.on("data", d => io.emit(`log-${botId}`, `\nERRO: ${d.toString()}`));
  child.on("exit", (code) => {
    io.emit(`log-${botId}`, `\n[SISTEMA] Processo encerrado (Código ${code})\n`);
    delete activeBots[botId];
    io.emit("bots-update");
    aresBanner();
  });
  io.emit("bots-update");
  aresBanner();
}

// --- Endpoints API & Dashboard ---
// (Mantive a estrutura visual que você já usa no HTML)
app.get("/", (req, res) => res.send(require('./dashboard_html')(DOMAIN))); // Exemplo se mover o HTML para outro arquivo ou manter a string aqui
app.get("/api/stats", (req, res) => {
  res.json({
    bots: Object.keys(activeBots).length,
    ramUsed: ramUsed(),
    ramTotal: ramTotal(),
    cpus: os.cpus().length,
    uptime: process.uptime().toFixed(0)
  });
});

app.get("/api/bots", (req, res) => {
  res.json(Object.entries(activeBots).map(([id, info]) => ({
    id, online: true, uptime: fmtUp(Date.now() - info.startedAt)
  })));
});

// --- Comandos Telegram ---
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🔥 *ARES HOST v2*\n\nEnvie o seu \`.zip\` com o bot.\n\n[🖥 Dashboard](${DOMAIN})`, { parse_mode: "Markdown" });
});

bot.on("document", async (msg) => {
  const doc = msg.document;
  if (!doc.file_name.endsWith(".zip")) return;
  const botId = (msg.caption || `bot_${Date.now()}`).replace(/[^a-z0-9]/gi, "_");
  
  bot.sendMessage(msg.chat.id, `⏳ Iniciando \`${botId}\`...`);
  
  const fileInfo = await bot.getFile(doc.file_id);
  const p = path.resolve(BASE_PATH, botId);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });

  require("https").get(`https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`, (res) => {
    res.pipe(unzipper.Extract({ path: p })).on("close", () => {
      spawnBot(botId, p, msg.chat.id);
    });
  });
});

server.listen(PORT, "0.0.0.0", () => aresBanner());
