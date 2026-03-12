const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const token = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM";
const bot = new TelegramBot(token, { polling: true });
const activeBots = {}; 

const aresBanner = () => {
    console.clear();
    const ramLivre = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const ramTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    
    console.log("\x1b[32m%s\x1b[0m", `
    █████╗ ██████╗ ███████╗███████╗
    ██╔══██╗██╔══██╗██╔════╝██╔════╝
    ███████║██████╔╝█████╗  ███████╗
    ██╔══██║██╔══██╗██╔══╝  ╚════██║
    ██║  ██║██║  ██║███████╗███████║
    ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝
    [ BOTS ATIVOS: ${Object.keys(activeBots).length} | RAM LIVRE: ${ramLivre}GB / ${ramTotal}GB ]
    `);
};

// Menu Interativo
function sendMenu(chatId) {
    const ramUso = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
    bot.sendMessage(chatId, `📊 **MONITOR NEXUS**\n\n🧠 RAM em uso: ${ramUso}MB\n🤖 Bots rodando: ${Object.keys(activeBots).length}\n\nO que deseja fazer?`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📤 Subir Novo Bot (.zip)", callback_data: "upload" }],
                [{ text: "📋 Ver Terminais Ativos", callback_data: "list" }],
                [{ text: "💀 Matar Todos os Bots", callback_data: "kill_all" }]
            ]
        }
    });
}

async function startInstance(chatId, fileId, botId) {
    const instancePath = path.resolve(__dirname, 'instances', botId);
    if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

    // Download e Extração
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

    require('https').get(fileUrl, (res) => {
        res.pipe(unzipper.Extract({ path: instancePath })).on('close', () => {
            
            // Procura o arquivo .js principal
            const files = fs.readdirSync(instancePath);
            const mainFile = files.find(f => ['index.js', 'main.js', 'bot.js', 'start.js'].includes(f));

            if (!mainFile) return bot.sendMessage(chatId, "❌ Erro: index.js não encontrado.");

            // EXECUÇÃO COM LIMITE DE MEMÓRIA (Modo 50MB)
            // --max-old-space-size=64 força o Node a não passar de 64MB por bot
            const child = spawn('node', ['--max-old-space-size=64', mainFile], {
                cwd: instancePath,
                stdio: 'pipe',
                shell: true
            });

            activeBots[botId] = { process: child, startTime: Date.now() };

            child.stdout.on('data', (data) => {
                const out = data.toString();
                if (out.includes('QR')) console.log(`\x1b[33m[QR CODE - ${botId}]\x1b[0m`);
                // Envia para o console do host com prefixo
                process.stdout.write(`\x1b[36m[${botId}]\x1b[0m ${out}`);
            });

            child.on('exit', () => {
                delete activeBots[botId];
                aresBanner();
            });

            aresBanner();
            bot.sendMessage(chatId, `🚀 **${botId}** Ligado!\n\nUse /status para monitorar.`);
        });
    });
}

// Handlers de comando
bot.onText(/\/start/, (msg) => { aresBanner(); sendMenu(msg.chat.id); });
bot.onText(/\/status/, (msg) => sendMenu(msg.chat.id));

bot.on("callback_query", (query) => {
    if (query.data === "list") {
        const bots = Object.keys(activeBots).map(id => `• ${id}`).join('\n');
        bot.sendMessage(query.message.chat.id, `🤖 **Bots Online:**\n${bots || "Nenhum"}`);
    }
    if (query.data === "upload") bot.sendMessage(query.message.chat.id, "Envie o ZIP e digite o nome na legenda.");
});

bot.on("document", async (msg) => {
    if (msg.document.file_name.endsWith(".zip")) {
        const name = msg.caption || `bot_${Math.floor(Math.random() * 999)}`;
        await startInstance(msg.chat.id, msg.document.file_id, name);
    }
});

aresBanner();