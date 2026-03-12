const TelegramBot = require("node-telegram-bot-api")
const unzipper = require("unzipper")
const { spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")
const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const https = require("https")

const TOKEN = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM"
const PORT = process.env.PORT || 3000
const DOMAIN = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://localhost:${PORT}`

const bot = new TelegramBot(TOKEN, { polling: true })
const app = express()
const server = http.createServer(app)
const io = socketIo(server)

app.use(express.json())

const BASE_PATH = path.resolve(process.cwd(), "instances")
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true })

const activeBots = {}
let PORT_START = 4000
const usedPorts = new Set()

function getFreePort() {
    while (usedPorts.has(PORT_START)) PORT_START++
    usedPorts.add(PORT_START)
    return PORT_START
}

function releasePort(port) {
    usedPorts.delete(port)
}

function aresBanner() {
    process.stdout.write('\x1Bc')
    const up = process.uptime().toFixed(0)
    const ram = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0)
    console.log(`
    =========================================
    🚀 ARES HOST - TERMINAL PERSISTENTE
    =========================================
    📦 INSTÂNCIAS: ${fs.readdirSync(BASE_PATH).length}
    🟢 ONLINE: ${Object.keys(activeBots).length}
    📟 RAM: ${ram} MB | UPTIME: ${up}s
    =========================================
    `)
}

function getTerminalHTML(botId) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
    <title>ARES - ${botId}</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
    body{background:#0a0a0a;color:#fff;font-family:monospace;margin:0;display:flex;flex-direction:column;height:100vh}
    #header{background:#1a1a1a;padding:10px;font-size:12px;border-bottom:1px solid #333;color:#888}
    #log{flex:1;overflow:auto;padding:15px;white-space:pre-wrap;font-size:13px;line-height:1.5}
    .green{color:#00ff41} .yellow{color:#ffea00} .red{color:#ff3131} .blue{color:#00d4ff} .gray{color:#888}
    </style>
    </head>
    <body>
    <div id="header">CONSOLE PERSISTENTE | ID: ${botId}</div>
    <div id="log"></div>
    <script>
    const socket = io();
    const logDiv = document.getElementById("log");
    
    function formatLog(d) {
        const span = document.createElement("span");
        if(d.includes("[ERRO]")) span.className = "red";
        else if(d.includes("[AVISO]")) span.className = "yellow";
        else if(d.includes("[SUCESSO]")) span.className = "green";
        else if(d.includes("[INFO]")) span.className = "blue";
        else if(d.includes(">>>")) span.className = "gray";
        span.innerText = d;
        logDiv.appendChild(span);
        logDiv.scrollTop = logDiv.scrollHeight;
    }

    fetch('/logs/${botId}')
        .then(res => res.text())
        .then(data => {
            data.split('\\n').forEach(line => { if(line) formatLog(line + '\\n') });
        });

    socket.on("log-${botId}", d => formatLog(d));
    </script>
    </body>
    </html>
    `
}

app.get("/terminal/:botId", (req, res) => res.send(getTerminalHTML(req.params.botId)))

app.get("/logs/:botId", (req, res) => {
    const logPath = path.join(BASE_PATH, req.params.botId, "terminal.log")
    if (fs.existsSync(logPath)) {
        res.sendFile(logPath)
    } else {
        res.send("[INFO] Aguardando logs...")
    }
})

function writeLog(botId, instancePath, data) {
    const logPath = path.join(instancePath, "terminal.log")
    fs.appendFileSync(logPath, data)
    io.emit(`log-${botId}`, data)
}

function spawnBot(botId, instancePath) {
    const botPort = getFreePort()
    const env = { ...process.env, PORT: botPort.toString() }
    
    aresBanner()

    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        writeLog(botId, instancePath, `[INFO] Porta designada: ${botPort}\n`)
        writeLog(botId, instancePath, "[INFO] Instalando dependências...\n")
        
        const install = spawn("npm", ["install"], { cwd: instancePath, shell: true, env })

        install.stdout.on("data", d => writeLog(botId, instancePath, d.toString()))
        install.on("close", (code) => {
            if (code === 0) {
                writeLog(botId, instancePath, "[SUCESSO] Dependências instaladas.\n")
                runNode(botId, instancePath, botPort, env)
            } else {
                writeLog(botId, instancePath, "[ERRO] Falha no NPM Install.\n")
            }
        })
    } else {
        runNode(botId, instancePath, botPort, env)
    }
}

function runNode(botId, instancePath, botPort, env) {
    const files = fs.readdirSync(instancePath)
    let main = files.find(f => ["index.js", "main.js", "bot.js", "start.js"].includes(f))
    if (!main && fs.existsSync(path.join(instancePath, "src/index.js"))) main = "src/index.js"

    if (main) {
        const child = spawn("node", [main], { cwd: instancePath, shell: true, env })
        activeBots[botId] = { process: child, port: botPort, path: instancePath }

        child.stdout.on("data", d => writeLog(botId, instancePath, d.toString()))
        child.stderr.on("data", d => {
            const err = d.toString()
            if (!err.includes("EADDRINUSE")) writeLog(botId, instancePath, `[ERRO] ${err}`)
        })

        child.on("exit", () => {
            releasePort(botPort)
            delete activeBots[botId]
            aresBanner()
        })
        aresBanner()
    }
}

bot.onText(/\/start/, msg => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 Hospedar Novo Bot", callback_data: "menu_new" }],
                [{ text: "📂 Minhas Instâncias", callback_data: "menu_list" }]
            ]
        }
    }
    bot.sendMessage(msg.chat.id, "🤖 *ARES HOST*\nSelecione uma opção:", { parse_mode: "Markdown", ...opts })
})

bot.on("callback_query", async query => {
    const data = query.data
    const chatId = query.message.chat.id

    if (data === "menu_new") {
        bot.sendMessage(chatId, "📤 Envie o arquivo `.ZIP`.")
    } 

    else if (data === "menu_list") {
        const folders = fs.readdirSync(BASE_PATH)
        if (folders.length === 0) return bot.sendMessage(chatId, "Nenhum bot.")

        const buttons = folders.map(f => [{ text: `${activeBots[f] ? "🟢" : "🔴"} ${f}`, callback_data: `manage:${f}` }])
        buttons.push([{ text: "⬅️ Voltar", callback_data: "menu_back" }])
        bot.editMessageText("📂 *Seus Bots:*", { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } })
    }

    else if (data.startsWith("manage:")) {
        const id = data.split(":")[1]
        const isRunning = activeBots[id]
        const subButtons = [
            [{ text: "📟 Abrir Terminal", url: `${DOMAIN}/terminal/${id}` }],
            [{ text: isRunning ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${isRunning ? "stop" : "restart"}:${id}:${path.join(BASE_PATH, id)}` }],
            [{ text: "🗑️ Deletar Bot", callback_data: `delete:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
        ]
        bot.editMessageText(`🛠️ *Bot:* \`${id}\`\nStatus: ${isRunning ? "Online" : "Offline"}`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: subButtons } })
    }

    else if (data.startsWith("stop:")) {
        const id = data.split(":")[1]
        if (activeBots[id]) activeBots[id].process.kill("SIGKILL")
        bot.answerCallbackQuery(query.id, { text: "Parado!" })
    }

    else if (data.startsWith("restart:")) {
        const [_, id, ipath] = data.split(":")
        spawnBot(id, ipath)
        bot.answerCallbackQuery(query.id, { text: "Iniciando..." })
    }

    else if (data.startsWith("delete:")) {
        const id = data.split(":")[1]
        if (activeBots[id]) activeBots[id].process.kill("SIGKILL")
        fs.rmSync(path.join(BASE_PATH, id), { recursive: true, force: true })
        bot.answerCallbackQuery(query.id, { text: "Apagado!" })
        bot.sendMessage(chatId, `🗑️ ${id} removido.`)
    }

    else if (data === "menu_back") {
        bot.editMessageText("🤖 *ARES HOST*", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "🚀 Novo Bot", callback_data: "menu_new" }], [{ text: "📂 Meus Bots", callback_data: "menu_list" }]] } })
    }
})

bot.on("document", async msg => {
    if (!msg.document.file_name.toLowerCase().endsWith(".zip")) return
    const botId = `bot_${Date.now()}`
    const instancePath = path.join(BASE_PATH, botId)
    fs.mkdirSync(instancePath, { recursive: true })
    const file = await bot.getFile(msg.document.file_id)
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
    const zipPath = path.join(instancePath, "bot.zip")
    https.get(url, res => {
        const fsStream = fs.createWriteStream(zipPath)
        res.pipe(fsStream)
        fsStream.on("finish", () => {
            fsStream.close()
            fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: instancePath })).on("close", () => {
                spawnBot(botId, instancePath)
                bot.sendMessage(msg.chat.id, `✅ Hospedado: \`${botId}\``, { parse_mode: "Markdown" })
            })
        })
    })
})

process.on('uncaughtException', (err) => { if (err.code !== 'EADDRINUSE') console.error(err) })
server.listen(PORT, () => aresBanner())
