const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const token = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM";
const bot = new TelegramBot(token, { polling: true });

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const activeBots = {}; 
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://localhost:${PORT}`;

const BASE_PATH = path.resolve(process.cwd(), 'instances');
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

process.on('uncaughtException', (err) => {
    if (err.message.includes('file is too big')) return;
    console.error('ERRO:', err.message);
});

bot.on('polling_error', (err) => {
    if (err.message.includes('file is too big')) return;
});

const aresBanner = () => {
    console.clear();
    const ramUso = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
    const ramTotal = (os.totalmem() / 1024 / 1024).toFixed(0);
    console.log("\x1b[32m%s\x1b[0m", `
    █████╗ ██████╗ ███████╗███████╗
    ██╔══██╗██╔══██╗██╔════╝██╔════╝
    ███████║██████╔╝█████╗  ███████╗
    ██╔══██║██╔══██╗██╔══╝  ╚════██║
    ██║  ██║██║  ██║███████╗███████║
    ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝
    [ BOTS: ${Object.keys(activeBots).length} | RAM: ${ramUso}/${ramTotal}MB ]
    `);
};

app.get('/terminal/:id', (req, res) => {
    const botId = req.params.id;
    res.send(`
        <html>
        <head>
            <title>Terminal: ${botId}</title>
            <script src="/socket.io/socket.io.js"></script>
            <style>
                body { background: #000; color: #0f0; font-family: monospace; padding: 20px; }
                #log { white-space: pre-wrap; height: 85vh; overflow-y: auto; border: 1px solid #333; padding: 10px; font-size: 12px; }
                .status { color: #888; margin-bottom: 10px; display: flex; justify-content: space-between; }
                b { color: #fff; }
            </style>
        </head>
        <body>
            <div class="status"><span>BOT: <b>${botId}</b></span><span>ESTADO: <b>ATIVO</b></span></div>
            <div id="log">Iniciando recepção de logs...</div>
            <script>
                const socket = io();
                const logDiv = document.getElementById('log');
                socket.on('log-${botId}', (data) => {
                    logDiv.innerText += data;
                    logDiv.scrollTop = logDiv.scrollHeight;
                });
            </script>
        </body>
        </html>
    `);
});

async function startInstance(chatId, fileId, botId) {
    const instancePath = path.resolve(BASE_PATH, botId);
    if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

    try {
        const fileInfo = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

        require('https').get(fileUrl, (res) => {
            res.pipe(unzipper.Extract({ path: instancePath })).on('close', async () => {
                const files = fs.readdirSync(instancePath);
                const mainFile = files.find(f => ['index.js', 'main.js', 'bot.js', 'start.js'].includes(f));
                
                if (!mainFile) return bot.sendMessage(chatId, "❌ Erro: Arquivo principal (.js) não encontrado.");

                const child = spawn('node', ['--max-old-space-size=64', mainFile], {
                    cwd: instancePath,
                    stdio: 'pipe',
                    shell: true
                });

                activeBots[botId] = { process: child };

                child.stdout.on('data', (data) => {
                    const out = data.toString();
                    process.stdout.write(`[${botId}] ${out}`);
                    io.emit(`log-${botId}`, out);
                });

                child.stderr.on('data', (data) => {
                    io.emit(`log-${botId}`, `\nERRO: ${data.toString()}`);
                });

                child.on('exit', () => {
                    delete activeBots[botId];
                    aresBanner();
                });

                const url = `${DOMAIN}/terminal/${botId}`;
                bot.sendMessage(chatId, `🚀 **${botId}** ONLINE!\n\n💻 Terminal Web:\n${url}`);
                aresBanner();
            });
        });
    } catch (e) {
        bot.sendMessage(chatId, "ERRO NO DOWNLOAD: " + e.message);
    }
}

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Ares Host Ativo. Mande o .zip com o nome do bot na legenda.");
    aresBanner();
});

bot.on("document", async (msg) => {
    if (!msg.document.file_name.endsWith(".zip")) return;
    if (msg.document.file_size > 20 * 1024 * 1024) {
        return bot.sendMessage(msg.chat.id, "❌ Arquivo muito grande! Max 20MB.");
    }
    const name = msg.caption || `bot_${Date.now()}`;
    await startInstance(msg.chat.id, msg.document.file_id, name);
});

server.listen(PORT, '0.0.0.0', () => aresBanner());
