const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const pty = require("node-pty");
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
    io.emit(`log-${botId}`, data);
}

function spawnBot(botId, instancePath) {
    if (activeBots[botId]) activeBots[botId].process.kill();

    const botPort = getFreePort();
    const env = { 
        ...process.env, 
        PORT: botPort.toString(),
        NODE_ENV: "production",
        COLORTERM: "truecolor",
        TERM: "xterm-256color"
    };
    
    aresBanner();

    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        writeLog(botId, instancePath, `\x1b[1;34m[SISTEMA] Instalando dependências...\x1b[0m\r\n`);
        
        const install = pty.spawn(os.platform() === 'win32' ? 'npm.cmd' : 'npm', ['install', '--production'], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: instancePath,
            env: env
        });

        install.onData(data => writeLog(botId, instancePath, data));
        install.onExit(({ exitCode }) => {
            if (exitCode === 0) runInstance(botId, instancePath, botPort, env);
            else {
                writeLog(botId, instancePath, `\x1b[1;31m[ERRO] NPM falhou com código ${exitCode}\x1b[0m\r\n`);
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

    let shell = os.platform() === 'win32' ? 'cmd.exe' : 'bash';
    let args = [];

    if (shellScript) {
        if (os.platform() !== "win32") fs.chmodSync(path.join(instancePath, shellScript), "755");
        args = [os.platform() === 'win32' ? '/c' : '-c', os.platform() === 'win32' ? shellScript : `./${shellScript}`];
    } else if (nodeMain) {
        args = [os.platform() === 'win32' ? '/c' : '-c', `node ${nodeMain}`];
    }

    if (args.length > 0) {
        const child = pty.spawn(shell, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: instancePath,
            env: env
        });

        activeBots[botId] = { process: child, port: botPort, path: instancePath };

        child.onData(data => writeLog(botId, instancePath, data));
        child.onExit(() => {
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
        if (activeBots[botId]) activeBots[botId].process.write(data);
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
    else if (action === "stop" && activeBots[id]) activeBots[id].process.kill();
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
            const term = new Terminal({ theme: { background: '#000' }, cursorBlink: true, convertEol: true });
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

server.listen(PORT, () => aresBanner());
