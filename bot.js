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

const BASE_PATH = path.resolve(process.cwd(), "instances");
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

const activeBots = {};
const userState = {};

function aresBanner() {
    process.stdout.write('\x1Bc');
    console.log(`\x1b[1;36m=========================================
🚀 ARES HOST - MODO INTERATIVO ATIVADO
=========================================\x1b[0m`);
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
        TERM: "xterm-256color",
        NODE_ENV: "production"
    };

    const files = fs.readdirSync(instancePath);
    let shellScript = files.find(f => f.endsWith(".sh") || f === "start.sh");
    let nodeMain = files.find(f => ["index.js", "main.js", "bot.js"].includes(f));

    let child;
    // O TRUQUE: Usamos 'script' para fingir um terminal real (TTY) no Linux
    // Isso permite que o input funcione mesmo sem node-pty
    if (shellScript) {
        if (os.platform() !== "win32") fs.chmodSync(path.join(instancePath, shellScript), "755");
        child = spawn("script", ["-q", "-e", "-c", `bash ./${shellScript}`, "/dev/null"], { cwd: instancePath, env, shell: true });
    } else if (nodeMain) {
        child = spawn("script", ["-q", "-e", "-c", `node ${nodeMain}`, "/dev/null"], { cwd: instancePath, env, shell: true });
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
            // Envia o dado exatamente como o terminal espera
            target.process.stdin.write(data);
        }
    });
});

app.get("/terminal/:botId", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.1.0/css/xterm.css" />
        <script src="https://cdn.jsdelivr.net/npm/xterm@5.1.0/lib/xterm.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.7.0/lib/xterm-addon-fit.js"></script>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            body { margin: 0; background: #000; height: 100vh; display: flex; flex-direction: column; }
            #header { background: #222; color: #0f0; padding: 12px; font-family: monospace; display: flex; justify-content: space-between; border-bottom: 2px solid #0f0; }
            #terminal { flex: 1; width: 100%; padding: 5px; }
            #mobile-input { position: fixed; bottom: -100px; }
        </style>
    </head>
    <body>
        <div id="header">
            <span>📟 ARES: ${req.params.botId}</span>
            <span id="status">🟢 CONECTADO</span>
        </div>
        <div id="terminal"></div>
        <input type="text" id="mobile-input">

        <script>
            const socket = io();
            const term = new Terminal({
                theme: { background: '#000', foreground: '#0f0', cursor: '#0f0' },
                cursorBlink: true,
                convertEol: true,
                fontSize: 14,
                fontFamily: 'monospace'
            });
            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(document.getElementById('terminal'));
            fitAddon.fit();
            term.focus();

            // Ao clicar no terminal, garante o foco
            document.addEventListener('click', () => term.focus());

            socket.on("log-${req.params.botId}", d => term.write(d));
            
            // Evento de digitação
            term.onData(data => {
                socket.emit("input", { botId: "${req.params.botId}", data });
            });

            window.addEventListener('resize', () => fitAddon.fit());
            fetch('/logs/${req.params.botId}').then(r => r.text()).then(t => {
                term.write(t);
                term.scrollToBottom();
            });
        </script>
    </body>
    </html>`);
});

app.get("/logs/:botId", (req, res) => {
    const p = path.join(BASE_PATH, req.params.botId, "terminal.log");
    if (fs.existsSync(p)) res.sendFile(p); else res.send("");
});

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, "🤖 *ARES HOST*", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "📂 Meus Bots", callback_data: "menu_list" }]] }
    });
});

bot.on("callback_query", async query => {
    const [action, id] = query.data.split(":");
    if (action === "menu_list") {
        const files = fs.readdirSync(BASE_PATH);
        const buttons = files.map(f => [{ text: (activeBots[f] ? "🟢 " : "🔴 ") + f, callback_data: `manage:${f}` }]);
        bot.editMessageText("📂 *Seus Bots:*", { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    } else if (action === "manage") {
        bot.editMessageText(`🛠️ **Bot:** \`${id}\``, {
            chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }], [{ text: activeBots[id] ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${activeBots[id] ? "stop" : "restart"}:${id}` }], [{ text: "⬅️ Voltar", callback_data: "menu_list" }]] }
        });
    } else if (action === "stop") {
        if (activeBots[id]) activeBots[id].process.kill("SIGKILL");
        bot.answerCallbackQuery(query.id, { text: "Bot parado!" });
    } else if (action === "restart") {
        spawnBot(id, path.join(BASE_PATH, id));
        bot.answerCallbackQuery(query.id, { text: "Iniciando..." });
    }
});

server.listen(PORT, () => aresBanner());
