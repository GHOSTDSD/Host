const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const { spawn, exec } = require("child_process");
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

const aresBanner = () => {
    console.clear();
    const ramUso = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
    console.log("\x1b[32m%s\x1b[0m", `
    █████╗ ██████╗ ███████╗███████╗
    ██╔══██╗██╔══██╗██╔════╝██╔════╝
    ███████║██████╔╝█████╗  ███████╗
    ██╔══██║██╔══██╗██╔══╝  ╚════██║
    ██║  ██║██║  ██║███████╗███████║
    ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝
    [ AUTO-NPM ATIVO | RAM: ${ramUso}MB ]
    `);
};

app.get('/terminal/:id', (req, res) => {
    const botId = req.params.id;
    res.send(`<html><head><title>${botId}</title><script src="/socket.io/socket.io.js"></script><style>body{background:#000;color:#0f0;font-family:monospace;padding:20px;}#log{white-space:pre-wrap;height:85vh;overflow-y:auto;border:1px solid #333;padding:10px;font-size:12px;}</style></head><body><div>BOT: <b>${botId}</b></div><div id="log">Iniciando instalação/execução...</div><script>const socket=io();const logDiv=document.getElementById('log');socket.on('log-${botId}',(data)=>{logDiv.innerText+=data;logDiv.scrollTop=logDiv.scrollHeight;});</script></body></html>`);
});

async function startInstance(chatId, fileId, botId) {
    const instancePath = path.resolve(BASE_PATH, botId);
    if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

    try {
        const fileInfo = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

        require('https').get(fileUrl, (res) => {
            res.pipe(unzipper.Extract({ path: instancePath })).on('close', async () => {
                
                io.emit(`log-${botId}`, "📦 Instalando dependências (npm install)...\n");
                
                // Roda o NPM Install primeiro
                exec('npm install --omit=dev', { cwd: instancePath }, (error, stdout, stderr) => {
                    if (error) io.emit(`log-${botId}`, `⚠️ Erro no npm install: ${error.message}\n`);
                    
                    io.emit(`log-${botId}`, "🚀 Iniciando via npm start...\n");

                    // Inicia via npm start
                    const child = spawn('npm', ['start'], {
                        cwd: instancePath,
                        stdio: 'pipe',
                        shell: true,
                        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=64' }
                    });

                    activeBots[botId] = { process: child };

                    child.stdout.on('data', (data) => io.emit(`log-${botId}`, data.toString()));
                    child.stderr.on('data', (data) => io.emit(`log-${botId}`, `\n[ERRO]: ${data.toString()}`));
                    child.on('exit', () => { delete activeBots[botId]; aresBanner(); });

                    bot.sendMessage(chatId, `✅ **${botId}** em processo de inicialização!\n🔗 [Terminal](${DOMAIN}/terminal/${botId})`, { parse_mode: 'Markdown' });
                });
            });
        });
    } catch (e) {
        bot.sendMessage(chatId, "❌ Falha: " + e.message);
    }
}

bot.on("document", async (msg) => {
    if (!msg.document.file_name.endsWith(".zip")) return;
    const name = msg.caption || `bot_${Date.now()}`;
    await startInstance(msg.chat.id, msg.document.file_id, name);
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Ares Nexus Online. Envie o ZIP.");
    aresBanner();
});

server.listen(PORT, '0.0.0.0', () => aresBanner());
