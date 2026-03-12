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

const BASE_PATH = path.resolve(process.cwd(), 'instances');
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

const aresBanner = () => {
    console.clear();
    console.log("\x1b[32m%s\x1b[0m", `
    █████╗ ██████╗ ███████╗███████╗
    ██╔══██╗██╔══██╗██╔════╝██╔════╝
    ███████║██████╔╝█████╗  ███████╗
    ██╔══██║██╔══██╗██╔══╝  ╚════██║
    ██║  ██║██║  ██║███████╗███████║
    ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝
    [ TERMINAL WEB ATIVO NA PORTA ${PORT} ]
    `);
};

// --- ROTA DO TERMINAL WEB ---
app.get('/terminal/:id', (req, res) => {
    const botId = req.params.id;
    res.send(`
        <html>
        <head>
            <title>Terminal: ${botId}</title>
            <script src="/socket.io/socket.io.js"></script>
            <style>
                body { background: #000; color: #0f0; font-family: monospace; padding: 20px; }
                #log { white-space: pre-wrap; height: 80vh; overflow-y: auto; border: 1px solid #333; padding: 10px; }
                .status { color: #888; margin-bottom: 10px; }
            </style>
        </head>
        <body>
            <div class="status">Instância: <b>${botId}</b> | Status: Conectado</div>
            <div id="log">Aguardando logs...</div>
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

    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

    require('https').get(fileUrl, (res) => {
        res.pipe(unzipper.Extract({ path: instancePath })).on('close', async () => {
            const files = fs.readdirSync(instancePath);
            const mainFile = files.find(f => ['index.js', 'main.js', 'bot.js'].includes(f));
            if (!mainFile) return bot.sendMessage(chatId, `❌ Erro: index.js não achado.`);

            const child = spawn('node', ['--max-old-space-size=64', mainFile], {
                cwd: instancePath,
                stdio: 'pipe',
                shell: true
            });

            activeBots[botId] = { process: child };

            // Envia logs para o Terminal Web via Socket.io
            child.stdout.on('data', (data) => {
                io.emit(`log-${botId}`, data.toString());
            });

            child.stderr.on('data', (data) => {
                io.emit(`log-${botId}`, `\nERROR: ${data.toString()}`);
            });

            child.on('exit', () => delete activeBots[botId]);

            const url = `https://seudominio.railway.app/terminal/${botId}`; // Ajuste para sua URL da Railway
            bot.sendMessage(chatId, `🚀 Bot **${botId}** ativo!\n\n💻 Terminal Web:\n${url}`);
        });
    });
}

// Menu e Eventos
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Mande o .zip com o nome do bot na legenda.");
});

bot.on("document", async (msg) => {
    if (msg.document.file_name.endsWith(".zip")) {
        const name = msg.caption || `bot_${Date.now()}`;
        await startInstance(msg.chat.id, msg.document.file_id, name);
    }
});

server.listen(PORT, () => aresBanner());
