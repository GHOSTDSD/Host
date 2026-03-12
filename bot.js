const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const https = require("https");
const { EventEmitter } = require("events");

EventEmitter.defaultMaxListeners = 200;

const TOKEN = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM";
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://localhost:${PORT}`;

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

io.sockets.setMaxListeners(200);
app.use(express.json());

const BASE_PATH = path.resolve(process.cwd(), "instances");
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

const activeBots = {};
const userState = {};
const usedPorts = new Set();

function aresBanner() {
    process.stdout.write('\x1Bc');
    console.log(`\x1b[1;36m🚀 ARES HOST OPERACIONAL\x1b[0m`);
}

function writeLog(botId, instancePath, data) {
    const logPath = path.join(instancePath, "terminal.log");
    fs.appendFileSync(logPath, data);
    io.emit(`log-${botId}`, data.toString());
}

function spawnBot(botId, instancePath) {
    if (activeBots[botId]) activeBots[botId].process.kill("SIGKILL");

    const env = { 
        ...process.env, 
        FORCE_COLOR: "3",
        TERM: "xterm-256color"
    };

    writeLog(botId, instancePath, `\x1b[1;34m[SISTEMA] Iniciando processo...\x1b[0m\r\n`);
    
    const files = fs.readdirSync(instancePath);
    let shellScript = files.find(f => f.endsWith(".sh") || f.endsWith(".bat") || f === "start.sh");
    let nodeMain = files.find(f => ["index.js", "main.js", "bot.js"].includes(f));

    let child;
    const opt = { cwd: instancePath, shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] };

    if (shellScript) {
        if (os.platform() !== "win32") fs.chmodSync(path.join(instancePath, shellScript), "755");
        child = spawn(os.platform() === 'win32' ? shellScript : `./${shellScript}`, [], opt);
    } else if (nodeMain) {
        child = spawn("node", [nodeMain], opt);
    }

    if (child) {
        activeBots[botId] = { process: child };
        child.stdout.on("data", d => writeLog(botId, instancePath, d));
        child.stderr.on("data", d => writeLog(botId, instancePath, d));
        child.on("exit", () => delete activeBots[botId]);
    }
}

io.on("connection", (socket) => {
    socket.on("input", ({ botId, data }) => {
        const target = activeBots[botId];
        if (target && target.process.stdin.writable) {
            // Converte o Enter do navegador (\r) para o Enter que o Bot entende (\n)
            const cmd = data.replace(/\r/g, "\n");
            target.process.stdin.write(cmd);
        }
    });
});

// --- ROTAS DO TERMINAL ---
app.get("/terminal/:botId", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.1.0/css/xterm.css" />
        <script src="https://cdn.jsdelivr.net/npm/xterm@5.1.0/lib/xterm.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.7.0/lib/xterm-addon-fit.js"></script>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            body { margin: 0; background: #000; height: 100vh; display: flex; flex-direction: column; }
            #header { background: #1a1a1a; color: #0f0; padding: 10px; font-family: monospace; border-bottom: 1px solid #333; }
            #terminal { flex: 1; width: 100%; }
        </style>
    </head>
    <body>
        <div id="header">📟 TERMINAL: ${req.params.botId}</div>
        <div id="terminal"></div>
        <script>
            const socket = io();
            const term = new Terminal({ theme: { background: '#000' }, cursorBlink: true, convertEol: true });
            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(document.getElementById('terminal'));
            fitAddon.fit();
            term.focus();

            socket.on("log-${req.params.botId}", d => term.write(d));
            term.onData(data => socket.emit("input", { botId: "${req.params.botId}", data }));
            
            fetch('/logs/${req.params.botId}').then(r => r.text()).then(t => term.write(t));
        </script>
    </body>
    </html>`);
});

app.get("/logs/:botId", (req, res) => {
    const p = path.join(BASE_PATH, req.params.botId, "terminal.log");
    res.send(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : "");
});

// --- COMANDOS TELEGRAM ---
bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, "🤖 *ARES HOST*", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "📂 Meus Bots", callback_data: "menu_list" }]] }
    });
});

bot.on("callback_query", query => {
    const [action, id] = query.data.split(":");
    if (action === "menu_list") {
        const bots = fs.readdirSync(BASE_PATH).map(f => [{ text: f, callback_data: `manage:${f}` }]);
        bot.editMessageText("Escolha o bot:", { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: bots } });
    } else if (action === "manage") {
        bot.editMessageText(`Bot: ${id}`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }], [{ text: "▶️ Iniciar", callback_data: `restart:${id}` }]] }
        });
    } else if (action === "restart") spawnBot(id, path.join(BASE_PATH, id));
});

server.listen(PORT, () => aresBanner());
