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
        DEBUG_COLORS: "true",
        TERM: "xterm-256color"
    };
    
    aresBanner();

    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        writeLog(botId, instancePath, `\x1b[1;34m[SISTEMA] Instalando dependências...\x1b[0m\r\n`);
        const install = spawn(os.platform() === 'win32' ? 'npm.cmd' : 'npm', ['install', '--production'], { cwd: instancePath, shell: true, env });
        
        install.stdout.on("data", d => writeLog(botId, instancePath, d));
        install.stderr.on("data", d => writeLog(botId, instancePath, d));
        
        install.on("close", (code) => {
            if (code === 0) runInstance(botId, instancePath, botPort, env);
            else {
                writeLog(botId, instancePath, `\x1b[1;31m[ERRO] NPM falhou: ${code}\x1b[0m\r\n`);
                releasePort(botPort);
            }
        });
    } else {
        runInstance(botId, instancePath, botPort, env);
    }
}

function runInstance(botId, instancePath, botPort, env) {
    const files = fs.readdirSync(instancePath);
    let shellScript = files.find(f => f.endsWith(".sh") || f.endsWith(".bat") || f.endsWith(".bah") || f === "start.sh");
    let nodeMain = files.find(f => ["index.js", "main.js", "bot.js", "start.js", "app.js"].includes(f));
    if (!nodeMain && fs.existsSync(path.join(instancePath, "src/index.js"))) nodeMain = "src/index.js";

    let child;
    if (shellScript) {
        if (os.platform() !== "win32") fs.chmodSync(path.join(instancePath, shellScript), "755");
        child = spawn(os.platform() === 'win32' ? shellScript : `./${shellScript}`, [], { cwd: instancePath, shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } else if (nodeMain) {
        child = spawn("node", [nodeMain], { cwd: instancePath, shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    }

    if (child) {
        activeBots[botId] = { process: child, port: botPort, path: instancePath };

        child.stdout.on("data", d => writeLog(botId, instancePath, d));
        child.stderr.on("data", d => writeLog(botId, instancePath, d));

        child.on("exit", () => {
            releasePort(botPort);
            delete activeBots[botId];
            aresBanner();
        });
        aresBanner();
    } else {
        writeLog(botId, instancePath, "\x1b[1;31m[ERRO] Script não encontrado.\x1b[0m\r\n");
        releasePort(botPort);
    }
}

io.on("connection", (socket) => {
    socket.on("input", ({ botId, data }) => {
        if (activeBots[botId] && activeBots[botId].process.stdin.writable) {
            activeBots[botId].process.stdin.write(data);
        }
    });
});

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, "🤖 *ARES HOST*\nO que deseja fazer?", {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 Hospedar Novo Bot", callback_data: "menu_new" }],
                [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
            ]
        }
    });
});

bot.on("document", async msg => {
    if (!msg.document.file_name.toLowerCase().endsWith(".zip")) return bot.sendMessage(msg.chat.id, "❌ Envie um arquivo .ZIP");
    userState[msg.chat.id] = { fileId: msg.document.file_id };
    bot.sendMessage(msg.chat.id, "📝 Escolha um nome exclusivo para o bot:");
});

bot.on("message", async msg => {
    if (msg.document || msg.text?.startsWith("/")) return;
    const state = userState[msg.chat.id];
    if (state && state.fileId && !state.botName) {
        const name = msg.text.trim().replace(/\s+/g, "_").toLowerCase();
        const instancePath = path.join(BASE_PATH, name);
        if (fs.existsSync(instancePath)) return bot.sendMessage(msg.chat.id, "❌ Esse nome já existe.");
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
    }
    else if (action === "manage") {
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
    }
    else if (action === "stop" && activeBots[id]) activeBots[id].process.kill("SIGKILL");
    else if (action === "restart") spawnBot(id, path.join(BASE_PATH, id));
});

app.get("/terminal/:botId", (req, res) => {
    res.send(`
    <html>
    <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.1.0/css/xterm.css" />
        <script src="https://cdn.jsdelivr.net/npm/xterm@5.1.0/lib/xterm.js"></script>
        <script src="/socket.io/socket.io.js"></script>
    </head>
    <body style="background:#000;margin:0;overflow:hidden;">
        <div id="terminal" style="height:100vh;"></div>
        <script>
            const term = new Terminal({ theme: { background: '#000' }, cursorBlink: true, convertEol: true, fontFamily: 'monospace' });
            const socket = io();
            const botId = "${req.params.botId}";
            term.open(document.getElementById('terminal'));
            socket.on("log-" + botId, data => term.write(data));
            term.onData(data => socket.emit("input", { botId, data }));
            fetch('/logs/' + botId).then(r => r.text()).then(t => term.write(t));
        </script>
    </body>
    </html>`);
});

app.get("/logs/:botId", (req, res) => {
    const p = path.join(BASE_PATH, req.params.botId, "terminal.log");
    if (fs.existsSync(p)) res.sendFile(p);
    else res.send("Nenhum log disponível.");
});

process.on('uncaughtException', (err) => { if (err.code !== 'EADDRINUSE') console.error(err) });
server.listen(PORT, () => aresBanner());
