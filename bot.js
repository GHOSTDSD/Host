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
    =========================================
    🚀 ARES HOST - GESTÃO DE INSTÂNCIAS
    =========================================
    📦 BOTS NO DISCO: ${fs.readdirSync(BASE_PATH).length}
    🟢 BOTS EM EXECUÇÃO: ${Object.keys(activeBots).length}
    📟 RAM: ${ram} MB | UPTIME: ${up}s
    =========================================
    `);
}

function writeLog(botId, instancePath, data) {
    const logPath = path.join(instancePath, "terminal.log");
    fs.appendFileSync(logPath, data);
    io.emit(`log-${botId}`, data);
}

function spawnBot(botId, instancePath) {
    if (activeBots[botId]) activeBots[botId].process.kill("SIGKILL");

    const botPort = getFreePort();
    const env = { 
        ...process.env, 
        PORT: botPort.toString(),
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=300" 
    };
    
    aresBanner();

    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        writeLog(botId, instancePath, `[SISTEMA] Instalando dependências...\n`);
        const install = spawn("npm", ["install", "--production", "--no-audit"], { cwd: instancePath, shell: true, env });
        
        install.stdout.on("data", d => writeLog(botId, instancePath, d.toString()));
        install.on("close", (code) => {
            if (code === 0) runInstance(botId, instancePath, botPort, env);
            else {
                writeLog(botId, instancePath, `[ERRO] NPM falhou: ${code}\n`);
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
        const cmd = os.platform() === "win32" ? shellScript : `./${shellScript}`;
        child = spawn(cmd, [], { cwd: instancePath, shell: true, env });
    } else if (nodeMain) {
        child = spawn("node", [nodeMain], { cwd: instancePath, shell: true, env });
    }

    if (child) {
        activeBots[botId] = { process: child, port: botPort, path: instancePath };

        child.stdout.on("data", d => writeLog(botId, instancePath, d.toString()));
        child.stderr.on("data", d => writeLog(botId, instancePath, `[ERRO] ${d.toString()}`));

        child.on("exit", () => {
            releasePort(botPort);
            delete activeBots[botId];
            aresBanner();
        });
        aresBanner();
    } else {
        writeLog(botId, instancePath, "[ERRO] Nenhum script de inicialização (.sh, .js, .bat) encontrado.\n");
        releasePort(botPort);
    }
}

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
                    bot.sendMessage(msg.chat.id, `✅ **${name}** criado! Use o menu para gerenciar.`);
                });
            });
        });
    }
});

bot.on("callback_query", async query => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const [action, id] = data.split(":");

    if (action === "menu_new") bot.sendMessage(chatId, "📤 Envie o ZIP.");
    
    else if (action === "menu_list") {
        const folders = fs.readdirSync(BASE_PATH);
        const buttons = folders.map(f => [{ text: `${activeBots[f] ? "🟢" : "🔴"} ${f}`, callback_data: `manage:${f}` }]);
        bot.editMessageText("📂 *Seus Bots:*", { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    }

    else if (action === "manage") {
        const isRunning = activeBots[id];
        bot.editMessageText(`🛠️ **Bot:** \`${id}\``, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }],
                    [{ text: isRunning ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${isRunning ? "stop" : "restart"}:${id}` }],
                    [{ text: "🧹 Limpar Logs", callback_data: `clearlog:${id}` }],
                    [{ text: "🗑️ Deletar", callback_data: `delete:${id}` }],
                    [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
                ]
            }
        });
    }

    else if (action === "clearlog") {
        const logP = path.join(BASE_PATH, id, "terminal.log");
        if (fs.existsSync(logP)) fs.writeFileSync(logP, `[INFO] Logs limpos em ${new Date().toLocaleString()}\n`);
        bot.answerCallbackQuery(query.id, { text: "Logs limpos!" });
    }

    else if (action === "stop") {
        if (activeBots[id]) activeBots[id].process.kill("SIGKILL");
        bot.answerCallbackQuery(query.id, { text: "Parado" });
    }

    else if (action === "restart") {
        spawnBot(id, path.join(BASE_PATH, id));
        bot.answerCallbackQuery(query.id, { text: "Reiniciando" });
    }

    else if (action === "delete") {
        if (activeBots[id]) activeBots[id].process.kill("SIGKILL");
        fs.rmSync(path.join(BASE_PATH, id), { recursive: true, force: true });
        bot.sendMessage(chatId, `🗑️ Bot **${id}** removido.`);
    }
});

app.get("/terminal/:botId", (req, res) => {
    res.send(`
    <html><body style="background:#000;color:#0f0;font-family:monospace;padding:20px;line-height:1.5;">
    <div style="position:sticky;top:0;background:#111;padding:10px;border-bottom:1px solid #333;">Terminal: ${req.params.botId}</div>
    <pre id="l"></pre>
    <script src="/socket.io/socket.io.js"></script>
    <script>
    const socket = io();
    const l = document.getElementById("l");
    function load(){ fetch('/logs/${req.params.botId}').then(r=>r.text()).then(t=>l.innerText=t); }
    load();
    socket.on("log-${req.params.botId}", d=>{l.innerText+=d;window.scrollTo(0,document.body.scrollHeight);});
    </script></body></html>`);
});

app.get("/logs/:botId", (req, res) => {
    const p = path.join(BASE_PATH, req.params.botId, "terminal.log");
    if (fs.existsSync(p)) res.sendFile(p);
    else res.send("Nenhum log disponível.");
});

process.on('uncaughtException', (err) => { if (err.code !== 'EADDRINUSE') console.error(err) });
server.listen(PORT, () => aresBanner());
