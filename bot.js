const TelegramBot = require("node-telegram-bot-api")
const unzipper = require("unzipper")
const pty = require("node-pty")
const fs = require("fs")
const path = require("path")
const os = require("os")
const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const https = require("https")
const { EventEmitter } = require("events")

EventEmitter.defaultMaxListeners = 200

const TOKEN = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM"
const PORT = process.env.PORT || 3000
const DOMAIN = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://localhost:${PORT}`

const bot = new TelegramBot(TOKEN, { polling: true })
const app = express()
const server = http.createServer(app)
const io = socketIo(server)

io.sockets.setMaxListeners(200)
app.use(express.json())

const BASE_PATH = path.resolve(process.cwd(), "instances")
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true })

const activeBots = {}
const userState = {}
const usedPorts = new Set()
let PORT_START = 4000

function generateBotId() {
  return "bot_" + Date.now() + "_" + Math.floor(Math.random() * 9999)
}

function getFreePort() {
  for (let p = PORT_START; p < 8000; p++) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p)
      return p
    }
  }
  return Math.floor(Math.random() * 1000) + 9000
}

function releasePort(port) {
  usedPorts.delete(port)
}

function aresBanner() {
  process.stdout.write('\x1Bc')
  const up = process.uptime().toFixed(0)
  const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(0)
  console.log(`
🚀 ARES HOST
📦 BOTS DISCO: ${fs.readdirSync(BASE_PATH).length}
🟢 BOTS ONLINE: ${Object.keys(activeBots).length}
💾 RAM: ${ram}MB
⏱ UPTIME: ${up}s
`)
}

function writeLog(botId, instancePath, data) {
  const logPath = path.join(instancePath, "terminal.log")
  fs.appendFileSync(logPath, data)
  io.emit("log-" + botId, data.toString())
}

function detectStart(instancePath) {
  const pkg = path.join(instancePath, "package.json")
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(fs.readFileSync(pkg))
      if (json.scripts && json.scripts.start) {
        return { cmd: os.platform() === "win32" ? "npm.cmd" : "npm", args: ["start"] }
      }
    } catch {}
  }

  const files = fs.readdirSync(instancePath)
  if (files.includes("index.js")) return { cmd: "node", args: ["index.js"] }
  if (files.includes("main.js")) return { cmd: "node", args: ["main.js"] }
  if (files.includes("bot.js")) return { cmd: "node", args: ["bot.js"] }
  if (files.includes("server.js")) return { cmd: "node", args: ["server.js"] }
  if (files.includes("app.js")) return { cmd: "node", args: ["app.js"] }
  if (files.includes("start.sh")) return { cmd: "bash", args: ["start.sh"] }
  if (files.includes("run.sh")) return { cmd: "bash", args: ["run.sh"] }
  if (files.includes("main.py")) return { cmd: "python", args: ["main.py"] }
  if (files.includes("bot.py")) return { cmd: "python", args: ["bot.py"] }
  if (fs.existsSync(path.join(instancePath, "src/index.js"))) return { cmd: "node", args: ["src/index.js"] }
  return null
}

function spawnBot(botId, instancePath) {
  if (activeBots[botId]) activeBots[botId].process.kill()

  const botPort = getFreePort()
  const env = {
    ...process.env,
    PORT: botPort.toString(),
    NODE_ENV: "production",
    FORCE_COLOR: "3",
    TERM: "xterm-256color"
  }

  aresBanner()

  const start = detectStart(instancePath)
  if (!start) {
    writeLog(botId, instancePath, "❌ Nenhum start detectado\r\n")
    return
  }

  if (fs.existsSync(path.join(instancePath, "package.json"))) {
    writeLog(botId, instancePath, "📦 Instalando dependências\r\n")
    const install = pty.spawn(os.platform() === "win32" ? "npm.cmd" : "npm", ["install", "--production"], {
      name: "xterm-color",
      cols: 80,
      rows: 40,
      cwd: instancePath,
      env: env
    })
    install.onData(d => writeLog(botId, instancePath, d))
    install.onExit(() => {
      runInstance(botId, instancePath, botPort, env, start)
    })
  } else {
    runInstance(botId, instancePath, botPort, env, start)
  }
}

function runInstance(botId, instancePath, botPort, env, start) {
  const child = pty.spawn(start.cmd, start.args, {
    name: "xterm-color",
    cols: 80,
    rows: 40,
    cwd: instancePath,
    env: env
  })

  activeBots[botId] = { process: child, port: botPort, path: instancePath }
  child.onData(d => writeLog(botId, instancePath, d))
  child.onExit(() => {
    releasePort(botPort)
    delete activeBots[botId]
    aresBanner()
  })

  aresBanner()
}

io.on("connection", socket => {
  socket.on("input", ({ botId, data }) => {
    const target = activeBots[botId]
    if (target) target.process.write(data)
  })
})

// ─────────────────────────────────────────────
//  MENUS TELEGRAM
// ─────────────────────────────────────────────

function getStats() {
  const total = fs.readdirSync(BASE_PATH).length
  const online = Object.keys(activeBots).length
  const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(0)
  const uptime = process.uptime()
  const h = Math.floor(uptime / 3600)
  const m = Math.floor((uptime % 3600) / 60)
  return { total, online, offline: total - online, ram, uptime: `${h}h ${m}m` }
}

bot.onText(/\/start/, msg => {
  const s = getStats()
  bot.sendMessage(msg.chat.id,
    `╔══════════════════╗\n` +
    `║    🚀  *ARES HOST*    ║\n` +
    `╚══════════════════╝\n\n` +
    `📊 *Painel de Controle*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `🤖 Bots Totais: *${s.total}*\n` +
    `🟢 Online: *${s.online}*   🔴 Offline: *${s.offline}*\n` +
    `💾 RAM: *${s.ram}MB*   ⏱ Uptime: *${s.uptime}*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `_Selecione uma opção abaixo:_`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕  Novo Bot", callback_data: "menu_new" }],
          [{ text: "📂  Meus Bots", callback_data: "menu_list" }],
          [{ text: "📊  Estatísticas", callback_data: "menu_stats" }]
        ]
      }
    }
  )
})

bot.on("document", async msg => {
  if (!msg.document.file_name.toLowerCase().endsWith(".zip")) {
    return bot.sendMessage(msg.chat.id,
      `⚠️ *Arquivo inválido*\n\nEnvie um arquivo *.zip* com o código do seu bot.`,
      { parse_mode: "Markdown" }
    )
  }
  userState[msg.chat.id] = { fileId: msg.document.file_id }
  bot.sendMessage(msg.chat.id,
    `✅ *ZIP recebido com sucesso!*\n\n` +
    `📝 Agora envie um *nome* para identificar o seu bot:\n` +
    `_Ex: meu_bot, assistente, vendas..._`,
    { parse_mode: "Markdown" }
  )
})

bot.on("message", async msg => {
  if (msg.document || msg.text?.startsWith("/")) return

  const state = userState[msg.chat.id]
  if (state && state.fileId && !state.botName) {
    const name = msg.text.trim().replace(/\s+/g, "_").toLowerCase()
    const botId = generateBotId()
    const instancePath = path.join(BASE_PATH, botId)

    state.botName = name
    state.botId = botId

    if (fs.existsSync(instancePath)) return

    fs.mkdirSync(instancePath, { recursive: true })

    const loadingMsg = await bot.sendMessage(msg.chat.id,
      `⏳ *Criando bot* \`${name}\`...\n\n_Fazendo download e extraindo arquivos..._`,
      { parse_mode: "Markdown" }
    )

    const file = await bot.getFile(state.fileId)
    const zipPath = path.join(instancePath, "bot.zip")
    const fileStream = fs.createWriteStream(zipPath)

    https.get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, res => {
      res.pipe(fileStream)
      fileStream.on("finish", () => {
        fileStream.close()
        fs.createReadStream(zipPath)
          .pipe(unzipper.Extract({ path: instancePath }))
          .on("close", () => {
            spawnBot(botId, instancePath)
            delete userState[msg.chat.id]

            bot.editMessageText(
              `✅ *Bot criado com sucesso!*\n\n` +
              `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
              `📦 Nome: *${name}*\n` +
              `🆔 ID: \`${botId}\`\n` +
              `🟢 Status: *Online*\n` +
              `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
              `_Use /start para gerenciar seus bots._`,
              {
                chat_id: loadingMsg.chat.id,
                message_id: loadingMsg.message_id,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "📟  Abrir Terminal", url: `${DOMAIN}/terminal/${botId}` }],
                    [{ text: "📂  Meus Bots", callback_data: "menu_list" }]
                  ]
                }
              }
            )
          })
      })
    })
  }
})

bot.on("callback_query", async query => {
  const chatId = query.message.chat.id
  const msgId = query.message.message_id
  const [action, id] = query.data.split(":")

  // ── Menu: Novo Bot
  if (action === "menu_new") {
    userState[chatId] = { waitingZip: true }
    bot.editMessageText(
      `➕ *Novo Bot*\n\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `📤 Envie o arquivo *.zip* com o código do seu bot.\n\n` +
      `📌 *Formatos suportados:*\n` +
      `• Node.js (index.js, package.json)\n` +
      `• Python (main.py, bot.py)\n` +
      `• Shell Script (start.sh)\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `_Aguardando envio do ZIP..._`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️  Voltar", callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  // ── Menu: Lista de Bots
  else if (action === "menu_list") {
    const folders = fs.readdirSync(BASE_PATH)

    if (folders.length === 0) {
      return bot.editMessageText(
        `📂 *Meus Bots*\n\n` +
        `_Você ainda não possui nenhum bot hospedado._\n\n` +
        `Use *➕ Novo Bot* para fazer o upload do seu primeiro bot!`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "➕  Novo Bot", callback_data: "menu_new" }],
              [{ text: "⬅️  Voltar", callback_data: "menu_home" }]
            ]
          }
        }
      )
    }

    const buttons = folders.map(f => [{
      text: `${activeBots[f] ? "🟢" : "🔴"}  ${f}`,
      callback_data: `manage:${f}`
    }])

    buttons.push([{ text: "⬅️  Voltar", callback_data: "menu_home" }])

    const s = getStats()
    bot.editMessageText(
      `📂 *Meus Bots*\n\n` +
      `🟢 Online: *${s.online}*   🔴 Offline: *${s.offline}*   📦 Total: *${s.total}*\n\n` +
      `_Selecione um bot para gerenciá-lo:_`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
      }
    )
  }

  // ── Menu: Estatísticas
  else if (action === "menu_stats") {
    const s = getStats()
    bot.editMessageText(
      `📊 *Estatísticas do Servidor*\n\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `🤖 Bots Totais: *${s.total}*\n` +
      `🟢 Online: *${s.online}*\n` +
      `🔴 Offline: *${s.offline}*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `💾 RAM Usada: *${s.ram}MB*\n` +
      `⏱ Uptime: *${s.uptime}*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄  Atualizar", callback_data: "menu_stats" }],
            [{ text: "⬅️  Voltar", callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  // ── Menu: Home (voltar)
  else if (action === "menu_home") {
    const s = getStats()
    bot.editMessageText(
      `╔══════════════════╗\n` +
      `║    🚀  *ARES HOST*    ║\n` +
      `╚══════════════════╝\n\n` +
      `📊 *Painel de Controle*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `🤖 Bots Totais: *${s.total}*\n` +
      `🟢 Online: *${s.online}*   🔴 Offline: *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*   ⏱ Uptime: *${s.uptime}*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `_Selecione uma opção abaixo:_`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕  Novo Bot", callback_data: "menu_new" }],
            [{ text: "📂  Meus Bots", callback_data: "menu_list" }],
            [{ text: "📊  Estatísticas", callback_data: "menu_stats" }]
          ]
        }
      }
    )
  }

  // ── Menu: Gerenciar Bot
  else if (action === "manage") {
    const isRunning = !!activeBots[id]
    const botPath = path.join(BASE_PATH, id)
    const logPath = path.join(botPath, "terminal.log")
    const logSize = fs.existsSync(logPath)
      ? (fs.statSync(logPath).size / 1024).toFixed(1) + " KB"
      : "0 KB"

    bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `🆔 ID: \`${id}\`\n` +
      `${isRunning ? "🟢 Status: *Online*" : "🔴 Status: *Offline*"}\n` +
      `📋 Log: *${logSize}*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟  Abrir Terminal", url: `${DOMAIN}/terminal/${id}` }],
            [
              { text: isRunning ? "🛑  Parar" : "▶️  Iniciar", callback_data: `${isRunning ? "stop" : "restart"}:${id}` },
              { text: "🔄  Reiniciar", callback_data: `restart:${id}` }
            ],
            [{ text: "⬅️  Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }

  // ── Parar Bot
  else if (action === "stop" && activeBots[id]) {
    activeBots[id].process.kill()
    bot.answerCallbackQuery(query.id, { text: `🛑 Bot parado com sucesso!`, show_alert: false })

    setTimeout(() => {
      bot.editMessageText(
        `🛠 *Gerenciar Bot*\n\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `🆔 ID: \`${id}\`\n` +
        `🔴 Status: *Offline*\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📟  Abrir Terminal", url: `${DOMAIN}/terminal/${id}` }],
              [
                { text: "▶️  Iniciar", callback_data: `restart:${id}` },
                { text: "🔄  Reiniciar", callback_data: `restart:${id}` }
              ],
              [{ text: "⬅️  Voltar", callback_data: "menu_list" }]
            ]
          }
        }
      )
    }, 800)
  }

  // ── Iniciar/Reiniciar Bot
  else if (action === "restart") {
    spawnBot(id, path.join(BASE_PATH, id))
    bot.answerCallbackQuery(query.id, { text: `▶️ Bot iniciado!`, show_alert: false })

    setTimeout(() => {
      bot.editMessageText(
        `🛠 *Gerenciar Bot*\n\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `🆔 ID: \`${id}\`\n` +
        `🟢 Status: *Online*\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📟  Abrir Terminal", url: `${DOMAIN}/terminal/${id}` }],
              [
                { text: "🛑  Parar", callback_data: `stop:${id}` },
                { text: "🔄  Reiniciar", callback_data: `restart:${id}` }
              ],
              [{ text: "⬅️  Voltar", callback_data: "menu_list" }]
            ]
          }
        }
      )
    }, 800)
  }

  bot.answerCallbackQuery(query.id)
})

// ─────────────────────────────────────────────
//  ROTAS WEB
// ─────────────────────────────────────────────

app.get("/terminal/:botId", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit/lib/xterm-addon-fit.js"></script>
<script src="/socket.io/socket.io.js"></script>
<style>
body{margin:0;background:#000;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#header{background:#111;color:#0f0;padding:10px;font-family:monospace;display:flex;justify-content:space-between;align-items:center;font-size:14px}
#terminal{flex:1}
button{background:#222;color:#fff;border:none;padding:5px 10px;cursor:pointer}
@media(max-width:600px){#header{font-size:12px;padding:6px}}
</style>
</head>
<body>
<div id="header">
<span>🚀 ARES TERMINAL</span>
<button onclick="location.reload()">🔄</button>
</div>
<div id="terminal"></div>
<script>
const socket = io()
const term = new Terminal({cursorBlink:true,fontSize:14,theme:{background:"#000",foreground:"#0f0"}})
const fitAddon = new FitAddon.FitAddon()
term.loadAddon(fitAddon)
term.open(document.getElementById("terminal"))
fitAddon.fit()
window.addEventListener("resize",()=>fitAddon.fit())
const botId = "${req.params.botId}"
socket.on("log-"+botId,data=>term.write(data))
term.onData(data=>socket.emit("input",{botId,data}))
</script>
</body>
</html>
`)
})

app.get("/logs/:botId", (req, res) => {
  const p = path.join(BASE_PATH, req.params.botId, "terminal.log")
  if (fs.existsSync(p)) res.sendFile(p)
  else res.send("")
})

process.on("uncaughtException", err => {
  if (err.code !== "EADDRINUSE") console.error(err)
})

server.listen(PORT, () => aresBanner())
