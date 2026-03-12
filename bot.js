const TelegramBot = require("node-telegram-bot-api");
const unzipper = require("unzipper");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const token = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM";
const bot = new TelegramBot(token, { polling: true });
const activeBots = {}; 

// Local de armazenamento: Na Railway, /tmp é melhor para permissões de escrita
const BASE_PATH = path.resolve(process.cwd(), 'instances');
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true });

const aresBanner = () => {
    console.clear();
    const ramLivre = (os.freemem() / 1024 / 1024).toFixed(0);
    const ramTotal = (os.totalmem() / 1024 / 1024).toFixed(0);
    console.log("\x1b[32m%s\x1b[0m", `
    █████╗ ██████╗ ███████╗███████╗
    ██╔══██╗██╔══██╗██╔════╝██╔════╝
    ███████║██████╔╝█████╗  ███████╗
    ██╔══██║██╔══██╗██╔══╝  ╚════██║
    ██║  ██║██║  ██║███████╗███████║
    ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝
    [ BOTS: ${Object.keys(activeBots).length} | RAM: ${ramTotal - ramLivre}/${ramTotal}MB ]
    `);
};

// Menu Principal
function mainMenu(chatId) {
    bot.sendMessage(chatId, "🚀 **ARES NEXUS - GESTÃO DE BOTS**\nEnvie o .zip para hospedar.", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 Listar Bots Ativos", callback_data: "list" }],
                [{ text: "📊 Status do Sistema", callback_data: "status" }]
            ]
        }
    });
}

async function startInstance(chatId, fileId, botId) {
    const instancePath = path.resolve(BASE_PATH, botId);
    if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

    require('https').get(fileUrl, (res) => {
        res.pipe(unzipper.Extract({ path: instancePath })).on('close', async () => {
            
            // Procura arquivo principal
            const files = fs.readdirSync(instancePath);
            const mainFile = files.find(f => ['index.js', 'main.js', 'bot.js'].includes(f));

            if (!mainFile) return bot.sendMessage(chatId, `❌ Erro: index.js não achado em ${botId}`);

            const fullMainPath = path.resolve(instancePath, mainFile);

            // MODO ALTA DENSIDADE: Limite de 64MB por bot
            const child = spawn('node', ['--max-old-space-size=64', fullMainPath], {
                cwd: instancePath,
                stdio: 'pipe',
                shell: true,
                env: { ...process.env, __DIRNAME: instancePath }
            });

            activeBots[botId] = { process: child };

            child.stdout.on('data', (data) => {
                const out = data.toString();
                process.stdout.write(`\x1b[36m[${botId}]\x1b[0m ${out}`);
                if (out.includes('QR')) bot.sendMessage(chatId, `⚠️ **QR CODE DISPONÍVEL** para ${botId}. Verifique o console.`);
            });

            child.stderr.on('data', (data) => console.error(`\x1b[31m[${botId}-ERR]\x1b[0m ${data}`));

            child.on('exit', () => delete activeBots[botId]);

            aresBanner();
            bot.sendMessage(chatId, `✅ Bot **${botId}** iniciado com sucesso.`);
        });
    });
}

// Eventos
bot.onText(/\/start/, (msg) => { aresBanner(); mainMenu(msg.chat.id); });

bot.on("callback_query", (query) => {
    const chatId = query.message.chat.id;
    if (query.data === "list") {
        const list = Object.keys(activeBots).map(id => `🔹 ${id}`).join('\n');
        bot.sendMessage(chatId, `🤖 **Bots Online:**\n${list || "Nenhum"}`);
    }
    if (query.data === "status") {
        const ramUso = (os.totalmem() - os.freemem()) / 1024 / 1024;
        bot.sendMessage(chatId, `📈 **SISTEMA:**\nRAM: ${ramUso.toFixed(0)}MB\nCPU: ${os.loadavg()[0].toFixed(2)}`);
    }
});

bot.on("document", async (msg) => {
    if (msg.document.file_name.endsWith(".zip")) {
        const name = msg.caption || `bot_${Date.now()}`;
        await startInstance(msg.chat.id, msg.document.file_id, name);
    }
});

aresBanner();
