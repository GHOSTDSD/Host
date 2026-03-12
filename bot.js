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
const userState = {}
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
    🚀 ARES HOST - GERENCIADOR DE NOMES
    =========================================
    📦 INSTÂNCIAS: ${fs.readdirSync(BASE_PATH).length}
    🟢 ONLINE: ${Object.keys(activeBots).length}
    📟 RAM: ${ram} MB | UPTIME: ${up}s
    =========================================
    `)
}

function writeLog(botId, instancePath, data) {
    const logPath = path.join(instancePath, "terminal.log")
    fs.appendFileSync(logPath, data)
    io.emit(`log-${botId}`, data)
}

function spawnBot(botId, instancePath) {
    const botPort = getFreePort()
    const env = { ...process.env, PORT: botPort.toString(), NODE_OPTIONS: "--max-old-space-size=400" }
    
    aresBanner()

    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        writeLog(botId, instancePath, `[INFO] Porta: ${botPort} | Instalando...\n`)
        const install = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: instancePath, shell: true, env })

        install.stdout.on("data", d => writeLog(botId, instancePath, d.toString()))
        install.on("close", (code) => {
            if (code === 0) {
                writeLog(botId, instancePath, "[SUCESSO] Pronto para iniciar.\n")
                runNode(botId, instancePath, botPort, env)
            } else {
                writeLog(botId, instancePath, "[ERRO] Falha na instalação.\n")
                releasePort(botPort)
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
        child.stderr.on("data", d => writeLog(botId, instancePath, `[ERRO] ${d.toString()}`))
        child.on("exit", () => {
            releasePort(botPort)
            delete activeBots[botId]
            aresBanner()
        })
        aresBanner()
    }
}

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, "🤖 *ARES HOST*\nEscolha uma opção:", {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 Hospedar Novo Bot", callback_data: "menu_new" }],
                [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
            ]
        }
    })
})

bot.on("document", async msg => {
    if (!msg.document.file_name.toLowerCase().endsWith(".zip")) return
    userState[msg.chat.id] = { fileId: msg.document.file_id }
    bot.sendMessage(msg.chat.id, "📝 Qual será o **nome** deste bot? (Sem espaços)")
})

bot.on("message", async msg => {
    if (msg.document || msg.text?.startsWith("/")) return
    const state = userState[msg.chat.id]
    
    if (state && state.fileId && !state.botName) {
        const name = msg.text.trim().replace(/\s+/g, "_").toLowerCase()
        const instancePath = path.join(BASE_PATH, name)

        if (fs.existsSync(instancePath)) {
            return bot.sendMessage(msg.chat.id, `❌ O nome **${name}** já existe. Escolha outro:`)
        }

        state.botName = name
        fs.mkdirSync(instancePath, { recursive: true })
        bot.sendMessage(msg.chat.id, `⚙️ Criando **${name}**...`)

        const file = await bot.getFile(state.fileId)
        const zipPath = path.join(instancePath, "bot.zip")
        const fileStream = fs.createWriteStream(zipPath)

        https.get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, res => {
            res.pipe(fileStream)
            fileStream.on("finish", () => {
                fileStream.close()
                fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: instancePath })).on("close", () => {
                    spawnBot(name, instancePath)
                    delete userState[msg.chat.id]
                    bot.sendMessage(msg.chat.id, `✅ **${name}** hospedado com sucesso!`, { parse_mode: "Markdown" })
                })
            })
        })
    }
})

bot.on("callback_query", async query => {
    const data = query.data
    const chatId = query.message.chat.id

    if (data === "menu_new") bot.sendMessage(chatId, "📤 Envie o arquivo `.ZIP` do bot.")
    
    else if (data === "menu_list") {
        const folders = fs.readdirSync(BASE_PATH)
        if (folders.length === 0) return bot.sendMessage(chatId, "Vazio.")
        const buttons = folders.map(f => [{ text: `${activeBots[f] ? "🟢" : "🔴"} ${f}`, callback_data: `manage:${f}` }])
        bot.editMessageText("📂 *Seus Bots:*", { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } })
    }

    else if (data.startsWith("manage:")) {
        const id = data.split(":")[1]
        const isRunning = activeBots[id]
        bot.editMessageText(`🛠️ **Bot:** \`${id}\``, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }],
                    [{ text: isRunning ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${isRunning ? "stop" : "restart"}:${id}:${path.join(BASE_PATH, id)}` }],
                    [{ text: "🗑️ Deletar", callback_data: `delete:${id}` }],
                    [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
                ]
            }
        })
    }

    else if (data.startsWith("stop:")) {
        const id = data.split(":")[1]
        if (activeBots[id]) activeBots[id].process.kill("SIGKILL")
        bot.answerCallbackQuery(query.id, { text: "Parado" })
    }

    else if (data.startsWith("restart:")) {
        const [_, id, ipath] = data.split(":")
        spawnBot(id, ipath)
        bot.answerCallbackQuery(query.id, { text: "Iniciando" })
    }

    else if (data.startsWith("delete:")) {
        const id = data.split(":")[1]
        if (activeBots[id]) activeBots[id].process.kill("SIGKILL")
        fs.rmSync(path.join(BASE_PATH, id), { recursive: true, force: true })
        bot.sendMessage(chatId, `🗑️ **${id}** deletado.`)
    }
})

app.get("/terminal/:botId", (req, res) => {
    res.send(`
    <html><body style="background:#000;color:#0f0;font-family:monospace;padding:20px;">
    <h3>Terminal: ${req.params.botId}</h3><div id="l"></div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
    const socket = io();
    const l = document.getElementById("l");
    fetch('/logs/${req.params.botId}').then(r=>r.text()).then(t=>l.innerText=t);
    socket.on("log-${req.params.botId}", d=>{l.innerText+=d;window.scrollTo(0,document.body.scrollHeight);});
    </script></body></html>`)
})

app.get("/logs/:botId", (req, res) => {
    const p = path.join(BASE_PATH, req.params.botId, "terminal.log")
    if (fs.existsSync(p)) res.sendFile(p)
    else res.send("Sem logs.")
})

process.on('uncaughtException', (err) => { if (err.code !== 'EADDRINUSE') console.error(err) })
server.listen(PORT, () => aresBanner())
