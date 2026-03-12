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
    console.log(`\x1b[1;36m🚀 ARES HOST ATIVO | PORTA: ${PORT}\x1b[0m`);
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
    
    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        writeLog(botId, instancePath, `\x1b[1;34m[SISTEMA] Verificando dependências...\x1b[0m\r\n`);
        const install = spawn(os.platform() === 'win32' ? 'npm.cmd' : 'npm', ['install', '--production'], { cwd: instancePath, shell: true, env });
        
        install.stdout.on("data", d => writeLog(botId, instancePath, d));
        install.stderr.on("data", d => writeLog(botId, instancePath, d));
        
        install.on("close", () => runInstance(botId, instancePath, botPort, env));
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
    // stdio: ['pipe', 'pipe', 'pipe'] é fundamental para o stdin funcionar
    const opt = { cwd: instancePath, shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] };

    if (shellScript) {
        if (os.platform() !== "win32") fs.chmodSync(path.join(instancePath, shellScript), "755");
        // Forçamos o shell a ser interativo
        child = spawn(os.platform() === 'win32' ? shellScript : 'bash', ['-i', shellScript], opt);
    } else if (nodeMain) {
        child = spawn("node", [nodeMain], opt);
    }

    if (child) {
        activeBots[botId] = { process: child, port: botPort };
        child.stdout.on("data", d => writeLog(botId, instancePath, d));
        child.stderr.on("data", d => writeLog(botId, instancePath, d));
        child.on("exit", () => {
            releasePort(botPort);
            delete activeBots[botId];
        });
    }
}

io.on("connection", (socket) => {
    socket.on("input", ({ botId, data }) => {
        const target = activeBots[botId];
        if (target && target.process.stdin.writable) {
            // MUITO IMPORTANTE: O bot espera \n (Enter), mas o xterm envia \r
            const formattedData = data.replace(/\r/g, "\n");
            target.process.stdin.write(formattedData);
        }
    });
});

// ... (Resto do código do bot Telegram e Express igual ao anterior)

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, "🤖 *ARES HOST*", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🚀 Novo Bot", callback_data: "menu_new" }], [{ text: "📂 Meus Bots", callback_data: "menu_list" }]] }
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
        https.get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, res => {
            const zipPath = path.join(instancePath, "bot.zip");
            const fileStream = fs.createWriteStream(zipPath);
            res.pipe(fileStream);
            fileStream.on("finish", () => {
                fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: instancePath })).on("close", () => {
                    spawnBot(name, instancePath);
                    delete userState[msg.chat.id];
                    bot.sendMessage(msg.chat.id, `✅ **${name}** iniciado!`);
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
        bot.editMessageText(`🛠️ **Bot:** \`${id}\``, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📟 Terminal Interativo", url: `${DOMAIN}/terminal/${id}` }],
                    [{ text: activeBots[id] ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${activeBots[id] ? "stop" : "restart"}:${id}` }],
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
            #header { background: #1a1a1a; color: #0f0; padding: 10px; font-family: monospace; font-size: 14px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; }
            #terminal-container { flex: 1; width: 100%; background: #000; padding: 5px; }
        </style>
    </head>
    <body>
        <div id="header"><span>🚀 ARES: ${req.params.botId}</span><span id="status">● CONECTADO</span></div>
        <div id="terminal-container"></div>
        <script>
            const socket = io();
            const botId = "${req.params.botId}";
            const term = new Terminal({
                theme: { background: '#000', foreground: '#0f0' },
                cursorBlink: true,
                convertEol: true,
                fontFamily: 'monospace'
            });
            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(document.getElementById('terminal-container'));
            fitAddon.fit();
            term.focus();

            socket.on("log-" + botId, data => term.write(data));
            
            // Captura o teclado e envia pro socket
            term.onData(data => {
                socket.emit("input", { botId, data });
            });

            window.addEventListener('resize', () => fitAddon.fit());
            fetch('/logs/' + botId).then(r => r.text()).then(t => term.write(t));
        </script>
    </body>
    </html>`);
});

app.get("/logs/:botId", (req, res) => {
    const p = path.join(BASE_PATH, req.params.botId, "terminal.log");
    if (fs.existsSync(p)) res.sendFile(p);
    else res.send("");
});

server.listen(PORT, () => aresBanner());
