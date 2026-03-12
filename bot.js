const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const https = require("https");
const { EventEmitter } = require("events");
const pty = require("node-pty");

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
let PORT_START = 4000;

function getFreePort() {
    for (let p = PORT_START; p < 8000; p++) {
        if (!usedPorts.has(p)) {
            usedPorts.add(p);
            return p;
        }
    }
    return Math.floor(Math.random() * 1000) + 9000;
}

function releasePort(port) {
    usedPorts.delete(port);
}

function aresBanner() {
    process.stdout.write('\x1Bc');
    const up = process.uptime().toFixed(0);
    const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    console.log(`
    \x1b[1;36m=========================================
    🚀 ARES HOST - GESTÃO DE INSTÂNCIAS
    =========================================
    \x1b[1;33m📦 BOTS NO DISCO: ${fs.readdirSync(BASE_PATH).length}
    🟢 BOTS EM EXECUÇÃO: ${Object.keys(activeBots).length}
    📟 RAM: ${ram} MB | UPTIME: ${up}s
    =========================================\x1b[0m
    `);
}

function writeLog(botId, instancePath, data) {
    const logPath = path.join(instancePath, "terminal.log");
    fs.appendFileSync(logPath, data);
    io.emit(`log-${botId}`, data.toString());
}

function spawnBot(botId, instancePath) {
    if (activeBots[botId]) activeBots[botId].process.kill("SIGKILL");
    const botPort = getFreePort();
    const env = { 
        ...process.env, 
        PORT: botPort.toString(),
        NODE_ENV: "production",
        FORCE_COLOR: "3",
        TERM: "xterm-256color"
    };
    aresBanner();
    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        writeLog(botId, instancePath, `\x1b[1;34m[SISTEMA] Preparando ambiente...\x1b[0m\r\n`);
        const { spawn } = require("child_process");
        const install = spawn(os.platform() === 'win32' ? 'npm.cmd' : 'npm', ['install', '--production'], { cwd: instancePath, shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
        install.stdout.on("data", d => writeLog(botId, instancePath, d));
        install.stderr.on("data", d => writeLog(botId, instancePath, d));
        install.on("close", (code) => {
            if (code === 0) runInstance(botId, instancePath, botPort, env);
            else {
                writeLog(botId, instancePath, `\x1b[1;31m[ERRO] Falha na instalação\x1b[0m\r\n`);
                releasePort(botPort);
            }
        });
    } else {
        runInstance(botId, instancePath, botPort, env);
    }
}

function runInstance(botId, instancePath, botPort, env) {
    const files = fs.readdirSync(instancePath);
    let nodeMain = files.find(f => ["index.js", "main.js", "bot.js", "start.js", "app.js"].includes(f));
    if (!nodeMain && fs.existsSync(path.join(instancePath, "src/index.js"))) nodeMain = "src/index.js";
    if (!nodeMain) return;
    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    const child = pty.spawn('node', [nodeMain], {
        name: 'xterm-color',
        cwd: instancePath,
        env,
        cols: 80,
        rows: 30
    });
    activeBots[botId] = { process: child, port: botPort, path: instancePath };
    child.onData(data => writeLog(botId, instancePath, data));
    child.onExit(() => {
        releasePort(botPort);
        delete activeBots[botId];
        aresBanner();
    });
    aresBanner();
}

io.on("connection", (socket) => {
    socket.on("input", ({ botId, data }) => {
        const target = activeBots[botId];
        if (target && target.process) {
            let cmd = data === "\r" ? "\n" : data;
            target.process.write(cmd);
        }
    });
});

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, "🤖 *ARES HOST*", {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 Novo Bot", callback_data: "menu_new" }],
                [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
            ]
        }
    });
});

bot.on("document", async msg => {
    if (!msg.document.file_name.toLowerCase().endsWith(".zip")) return;
    userState[msg.chat.id] = { fileId: msg.document.file_id };
    bot.sendMessage(msg.chat.id, "📝 Nome do bot:");
});

bot.on("message", async msg => {
    if (msg.document || msg.text?.startsWith("/")) return;
    const state = userState[msg.chat.id];
    if (state && state.fileId && !state.botName) {
        const name = msg.text.trim().replace(/\s+/g, "_").toLowerCase();
        const instancePath = path.join(BASE_PATH, name);
        if (fs.existsSync(instancePath)) return;
        state.botName = name;
        fs.mkdirSync(instancePath, { recursive: true });
        const file = await bot.getFile(state.fileId);
        const zipPath = path.join(instancePath, "bot.zip");
        const fileStream = fs.createWriteStream(zipPath);
        https.get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, res => {
            res.pipe(fileStream);
            fileStream.on("finish", () => {
                fileStream.close();
                fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: instancePath })).on("close", () => {
                    spawnBot(name, instancePath);
                    delete userState[msg.chat.id];
                    bot.sendMessage(msg.chat.id, `✅ **${name}** criado!`);
                });
            });
        });
    }
});

bot.on("callback_query", async query => {
    const [action, id] = query.data.split(":");
    if (action === "menu_new") bot.sendMessage(query.message.chat.id, "📤 Envie o ZIP.");
    else if (action === "menu_list") {
        const buttons = fs.readdirSync(BASE_PATH).map(f => [{ text: `${activeBots[f] ? "🟢" : "🔴"} ${f}`, callback_data: `manage:${f}` }]);
        bot.editMessageText("📂 *Seus Bots:*", { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    } else if (action === "manage") {
        const isRunning = activeBots[id];
        bot.editMessageText(`🛠️ **Bot:** \`${id}\``, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📟 Terminal Interativo", url: `${DOMAIN}/terminal/${id}` }],
                    [{ text: isRunning ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${isRunning ? "stop" : "restart"}:${id}` }],
                    [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
                ]
            }
        });
    } else if (action === "stop" && activeBots[id]) activeBots[id].process.kill();
    else if (action === "restart") spawnBot(id, path.join(BASE_PATH, id));
});

app.get("/terminal/:botId", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.1.0/css/xterm.css" />
        <script src="https://cdn.jsdelivr.net/npm/xterm@5.1.0/lib/xterm.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.7.0/lib/xterm-addon-fit.js"></script>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            body { margin: 0; background: #000; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
            #header { background: #1a1a1a; color: #0f0; padding: 10px; font-family: monospace; font-size: 14px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
            #terminal-container { flex: 1; width: 100%; overflow: hidden; background: #000; }
            .xterm-viewport { overflow-y: auto !important; }
        </style>
    </head>
    <body>
        <div id="header">
            <span>🚀 ARES: ${req.params.botId}</span>
            <div style="display: flex; gap: 10px;">
                <button onclick="location.reload()" style="background: #333; color: #fff; border: 1px solid #555; padding: 2px 8px; cursor: pointer;">Recarregar</button>
                <span id="status" style="color: #0f0;">● CONECTADO</span>
            </div>
        </div>
        <div id="terminal-container"></div>
        <script>
            const socket = io();
            const botId = "${req.params.botId}";
            const term = new Terminal({
                theme: { background: '#000', foreground: '#0f0', cursor: '#0f0' },
                cursorBlink: true,
                convertEol: true,
                fontSize: 14,
                fontFamily: 'monospace',
                rows: 40
            });
            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(document.getElementById('terminal-container'));
            setTimeout(() => {
                fitAddon.fit();
                term.focus();
            }, 500);
            socket.on("log-" + botId, data => {
                term.write(data);
            });
            term.onData(data => {
                if (data === '\r') data = '\n';
                socket.emit("input", { botId, data });
            });
            window.addEventListener('resize', () => fitAddon.fit());
            fetch('/logs/' + botId).then(r => r.text()).then(t => {
                term.write(t);
                term.scrollToBottom();
            });
            socket.on('disconnect', () => {
                document.getElementById('status').innerText = '○ DESCONECTADO';
                document.getElementById('status').style.color = '#f00';
            });
        </script>
    </body>
    </html>`);
});

app.get("/logs/:botId", (req, res) => {
    const p = path.join(BASE_PATH, req.params.botId, "terminal.log");
    if (fs.existsSync(p)) res.sendFile(p);
    else res.send("");
});

process.on('uncaughtException', (err) => { if (err.code !== 'EADDRINUSE') console.error(err) });
server.listen(PORT, () => aresBanner());
