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
    while (usedPorts.has(PORT_START)) {
        PORT_START++
    }
    usedPorts.add(PORT_START)
    return PORT_START
}

function releasePort(port) {
    usedPorts.delete(port)
}

function aresBanner() {
    console.clear()
    const up = process.uptime().toFixed(0)
    const ram = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0)
    process.stdout.write(`\x1Bc`)
    console.log(`
    ARES HOST
    
    BOTS ATIVOS: ${Object.keys(activeBots).length}
    RAM EM USO: ${ram} MB
    UPTIME: ${up}s
    `)
}

function getTerminalHTML(botId) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
    <title>Terminal ${botId}</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
    body{background:#000;color:#0f0;font-family:monospace;margin:0}
    #log{height:100vh;overflow:auto;padding:20px;white-space:pre-wrap}
    </style>
    </head>
    <body>
    <div id="log"></div>
    <script>
    const socket = io()
    const log = document.getElementById("log")
    socket.on("log-${botId}",d=>{
    log.innerText += d
    log.scrollTop = log.scrollHeight
    })
    </script>
    </body>
    </html>
    `
}

app.get("/terminal/:botId", (req, res) => {
    res.send(getTerminalHTML(req.params.botId))
})

function spawnBot(botId, instancePath) {
    const botPort = getFreePort()
    const env = { 
        ...process.env, 
        PORT: botPort.toString(), 
        PORT0: botPort.toString(), 
        PORT1: botPort.toString() 
    }
    
    aresBanner()

    if (fs.existsSync(path.join(instancePath, "package.json"))) {
        io.emit(`log-${botId}`, `[ARES] Porta designada: ${botPort}\n`)
        io.emit(`log-${botId}`, "[ARES] Instalando dependencias...\n")
        const install = spawn("npm", ["install"], { cwd: instancePath, shell: true, env })

        install.on("close", (code) => {
            if (code === 0) {
                io.emit(`log-${botId}`, "[ARES] Instalacao concluida.\n")
                runNode(botId, instancePath, botPort, env)
            } else {
                io.emit(`log-${botId}`, "[ARES] Erro no npm install.\n")
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
        activeBots[botId] = { process: child, port: botPort }

        child.stdout.on("data", d => {
            io.emit(`log-${botId}`, d.toString())
        })

        child.stderr.on("data", d => {
            io.emit(`log-${botId}`, d.toString())
        })

        child.on("exit", () => {
            releasePort(botPort)
            delete activeBots[botId]
            aresBanner()
        })
        
        aresBanner()
    } else {
        io.emit(`log-${botId}`, "[ARES] Arquivo principal nao encontrado.\n")
        releasePort(botPort)
    }
}

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, "ARES BOT HOST\n\nEnvie o arquivo ZIP do seu bot")
})

bot.on("document", async msg => {
    if (!msg.document.file_name.toLowerCase().endsWith(".zip")) {
        bot.sendMessage(msg.chat.id, "Envie apenas .zip")
        return
    }

    const botId = `bot_${Date.now()}`
    const instancePath = path.join(BASE_PATH, botId)
    fs.mkdirSync(instancePath, { recursive: true })

    bot.sendMessage(msg.chat.id, "Baixando e extraindo...")

    const file = await bot.getFile(msg.document.file_id)
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
    const zipPath = path.join(instancePath, "bot.zip")
    const fileStream = fs.createWriteStream(zipPath)

    https.get(url, response => {
        response.pipe(fileStream)
        fileStream.on("finish", () => {
            fileStream.close()
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: instancePath }))
                .on("close", () => {
                    spawnBot(botId, instancePath)
                    const termLink = `${DOMAIN}/terminal/${botId}`
                    bot.sendMessage(msg.chat.id, `Bot criado: ${botId}`, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "Terminal", url: termLink }],
                                [
                                    { text: "Reiniciar", callback_data: `restart:${botId}:${instancePath}` },
                                    { text: "Parar", callback_data: `stop:${botId}` }
                                ]
                            ]
                        }
                    })
                })
        })
    })
})

bot.on("callback_query", query => {
    const [action, botId, instancePath] = query.data.split(":")
    if (action === "stop" && activeBots[botId]) {
        activeBots[botId].process.kill("SIGKILL")
        bot.answerCallbackQuery(query.id, { text: "Bot parado" })
    } else if (action === "restart") {
        if (activeBots[botId]) {
            activeBots[botId].process.kill("SIGKILL")
            releasePort(activeBots[botId].port)
            delete activeBots[botId]
        }
        bot.answerCallbackQuery(query.id, { text: "Reiniciando..." })
        setTimeout(() => spawnBot(botId, instancePath), 2000)
    }
})

server.listen(PORT, () => aresBanner())
