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
const multer = require("multer")

EventEmitter.defaultMaxListeners = 200

const TOKEN = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM"
const PORT = process.env.PORT || 3000
const DOMAIN = process.env.RAILWAY_STATIC_URL
  ? `https://${process.env.RAILWAY_STATIC_URL}`
  : `http://localhost:${PORT}`

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
const uploadTokens = {} // token -> chatId
const PORT_START = 4000

// ─── Utilitarios ──────────────────────────────

function generateBotId() {
  return "bot_" + Date.now() + "_" + Math.floor(Math.random() * 9999)
}

function getFreePort() {
  for (let p = PORT_START; p < 8000; p++) {
    if (!usedPorts.has(p)) { usedPorts.add(p); return p }
  }
  return Math.floor(Math.random() * 1000) + 9000
}

function releasePort(port) { usedPorts.delete(port) }

function getStats() {
  const total = fs.readdirSync(BASE_PATH).length
  const online = Object.keys(activeBots).length
  const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(0)
  const uptime = process.uptime()
  const h = Math.floor(uptime / 3600)
  const m = Math.floor((uptime % 3600) / 60)
  return { total, online, offline: total - online, ram, uptime: `${h}h ${m}m` }
}

function aresBanner() {
  process.stdout.write("\x1Bc")
  const s = getStats()
  console.log(`\n🚀 ARES HOST\n📦 BOTS DISCO: ${s.total}\n🟢 BOTS ONLINE: ${s.online}\n💾 RAM: ${s.ram}MB\n⏱ UPTIME: ${s.uptime}\n`)
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
      if (json.scripts && json.scripts.start)
        return { cmd: os.platform() === "win32" ? "npm.cmd" : "npm", args: ["start"] }
    } catch {}
  }
  const files = fs.readdirSync(instancePath)
  if (files.includes("index.js"))  return { cmd: "node",   args: ["index.js"] }
  if (files.includes("main.js"))   return { cmd: "node",   args: ["main.js"] }
  if (files.includes("bot.js"))    return { cmd: "node",   args: ["bot.js"] }
  if (files.includes("server.js")) return { cmd: "node",   args: ["server.js"] }
  if (files.includes("app.js"))    return { cmd: "node",   args: ["app.js"] }
  if (files.includes("start.sh"))  return { cmd: "bash",   args: ["start.sh"] }
  if (files.includes("run.sh"))    return { cmd: "bash",   args: ["run.sh"] }
  if (files.includes("main.py"))   return { cmd: "python", args: ["main.py"] }
  if (files.includes("bot.py"))    return { cmd: "python", args: ["bot.py"] }
  if (fs.existsSync(path.join(instancePath, "src/index.js")))
    return { cmd: "node", args: ["src/index.js"] }
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
    writeLog(botId, instancePath, "📦 Instalando dependencias...\r\n")
    const install = pty.spawn(
      os.platform() === "win32" ? "npm.cmd" : "npm",
      ["install", "--production"],
      { name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env }
    )
    install.onData(d => writeLog(botId, instancePath, d))
    install.onExit(() => runInstance(botId, instancePath, botPort, env, start))
  } else {
    runInstance(botId, instancePath, botPort, env, start)
  }
}

function runInstance(botId, instancePath, botPort, env, start) {
  const child = pty.spawn(start.cmd, start.args, {
    name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env
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
    if (activeBots[botId]) activeBots[botId].process.write(data)
  })
})

// ─── /start ───────────────────────────────────

bot.onText(/\/start/, msg => {
  const s = getStats()
  bot.sendMessage(msg.chat.id,
    `🚀 *ARES HOST*\n\n` +
    `🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
    `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Novo Bot",     callback_data: "menu_new" }],
          [{ text: "📂 Meus Bots",    callback_data: "menu_list" }],
          [{ text: "📊 Estatisticas", callback_data: "menu_stats" }]
        ]
      }
    }
  )
})

// ─── Helpers de download ─────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https")
    const client = isHttps ? require("https") : require("http")
    const file = fs.createWriteStream(dest)
    client.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        return reject(new Error("HTTP " + res.statusCode))
      }
      res.pipe(file)
      file.on("finish", () => { file.close(); resolve() })
      file.on("error", reject)
    }).on("error", reject)
  })
}

function extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg) {
  fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: instancePath }))
    .on("close", () => {
      // Remove node_modules se vier no ZIP
      const nm = path.join(instancePath, "node_modules")
      if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true })

      spawnBot(botId, instancePath)

      bot.editMessageText(
        `✅ *Bot criado com sucesso!*\n\n` +
        `📦 Nome: *${name}*\n` +
        `🆔 ID: \`${botId}\`\n` +
        `🟢 Status: *Iniciando...*`,
        {
          chat_id: loadingMsg.chat.id,
          message_id: loadingMsg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📟 Abrir Terminal", url: `${DOMAIN}/terminal/${botId}` }],
              [{ text: "📂 Meus Bots",      callback_data: "menu_list" }]
            ]
          }
        }
      )
    })
    .on("error", err => {
      bot.editMessageText(
        `❌ Erro ao extrair: ${err.message}`,
        { chat_id: loadingMsg.chat.id, message_id: loadingMsg.message_id }
      )
    })
}

// ─── Receber ZIP (upload direto) ──────────────

bot.on("document", async msg => {
  if (!msg.document.file_name.toLowerCase().endsWith(".zip")) {
    return bot.sendMessage(msg.chat.id,
      "⚠️ *Arquivo invalido!*\n\nEnvie um arquivo .zip com o codigo do bot.",
      { parse_mode: "Markdown" }
    )
  }

  // Avisa se arquivo for grande demais pro Telegram (limite 20MB)
  const fileSizeMB = (msg.document.file_size / 1024 / 1024).toFixed(1)
  if (msg.document.file_size > 20 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id,
      `❌ *Arquivo muito grande (${fileSizeMB}MB)*\n\n` +
      "O Telegram tem limite de 20MB para upload.\n\n" +
      "Envie um *link direto* para o ZIP:\n" +
      "• Google Drive (link publico)\n" +
      "• GitHub Release\n" +
      "• Qualquer URL direta para .zip",
      { parse_mode: "Markdown" }
    )
  }

  userState[msg.chat.id] = { fileId: msg.document.file_id }
  bot.sendMessage(msg.chat.id,
    `✅ *ZIP recebido* (${fileSizeMB}MB)\n\nAgora envie um *nome* para o bot:\n(ex: meubot, vendas, suporte)`,
    { parse_mode: "Markdown" }
  )
})

// ─── Receber nome ou link ──────────────────────

bot.on("message", async msg => {
  if (msg.document || msg.text?.startsWith("/")) return

  const chatId = msg.chat.id
  const state = userState[chatId]

  // Sem estado ativo: verificar se é um link de ZIP
  if (!state || (!state.fileId && !state.linkUrl)) {
    const text = msg.text?.trim() || ""
    const isLink = /^https?:\/\/.+\.zip(\?.*)?$/i.test(text) || /^https?:\/\//i.test(text)
    if (isLink) {
      userState[chatId] = { linkUrl: text }
      return bot.sendMessage(chatId,
        "🔗 *Link recebido!*\n\nAgora envie um *nome* para o bot:\n(ex: meubot, vendas, suporte)",
        { parse_mode: "Markdown" }
      )
    }
    return
  }

  // Já tem estado mas ainda sem nome
  if (state.botName) return

  const name = msg.text.trim().replace(/\s+/g, "_").toLowerCase()
  const botId = generateBotId()
  const instancePath = path.join(BASE_PATH, botId)

  state.botName = name
  state.botId = botId

  if (fs.existsSync(instancePath)) return
  fs.mkdirSync(instancePath, { recursive: true })

  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ Criando bot *${name}*...\n\nBaixando e extraindo arquivos...`,
    { parse_mode: "Markdown" }
  )

  const zipPath = path.join(instancePath, "bot.zip")

  try {
    // Download via link direto
    if (state.linkUrl) {
      delete userState[chatId]
      await downloadFile(state.linkUrl, zipPath)
      extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)
      return
    }

    // Download via Telegram
    delete userState[chatId]
    const file = await bot.getFile(state.fileId)
    await downloadFile(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, zipPath)
    extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)

  } catch (err) {
    bot.editMessageText(
      `❌ Erro ao baixar: ${err.message}`,
      { chat_id: loadingMsg.chat.id, message_id: loadingMsg.message_id }
    )
  }
})

// ─── Callback queries ─────────────────────────

bot.on("callback_query", async query => {
  const chatId = query.message.chat.id
  const msgId  = query.message.message_id
  const data   = query.data
  const colonIdx = data.indexOf(":")
  const action = colonIdx === -1 ? data : data.slice(0, colonIdx)
  const id     = colonIdx === -1 ? null  : data.slice(colonIdx + 1)

  bot.answerCallbackQuery(query.id)

  // ── Home
  if (action === "menu_home") {
    const s = getStats()
    return bot.editMessageText(
      `🚀 *ARES HOST*\n\n` +
      `🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot",     callback_data: "menu_new" }],
            [{ text: "📂 Meus Bots",    callback_data: "menu_list" }],
            [{ text: "📊 Estatisticas", callback_data: "menu_stats" }]
          ]
        }
      }
    )
  }

  // ── Novo Bot
  if (action === "menu_new") {
    return bot.editMessageText(
      "➕ *Novo Bot*\n\n" +
      "Escolha como enviar o arquivo .zip:\n\n" +
      "📎 Envie direto aqui (ate 20MB)\n" +
      "🔗 Envie um link publico do ZIP\n" +
      "🌐 Use a pagina de upload (sem limite)",
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Gerar link de upload", callback_data: "gen_upload" }],
            [{ text: "⬅️ Voltar", callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  // ── Lista de Bots
  if (action === "menu_list") {
    const folders = fs.readdirSync(BASE_PATH)
    const s = getStats()

    if (folders.length === 0) {
      return bot.editMessageText(
        "📂 *Meus Bots*\n\nNenhum bot hospedado ainda.\nUse Novo Bot para fazer upload!",
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
              [{ text: "⬅️ Voltar",   callback_data: "menu_home" }]
            ]
          }
        }
      )
    }

    const buttons = folders.map(f => [{
      text: `${activeBots[f] ? "🟢" : "🔴"} ${f}`,
      callback_data: `manage:${f}`
    }])
    buttons.push([{ text: "⬅️ Voltar", callback_data: "menu_home" }])

    return bot.editMessageText(
      `📂 *Meus Bots*\n\n🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*  |  Total: *${s.total}*\n\nEscolha um bot:`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
      }
    )
  }

  // ── Estatisticas
  if (action === "menu_stats") {
    const s = getStats()
    return bot.editMessageText(
      `📊 *Estatisticas*\n\n` +
      `🤖 Total: *${s.total}*\n` +
      `🟢 Online: *${s.online}*\n` +
      `🔴 Offline: *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*\n` +
      `⏱ Uptime: *${s.uptime}*`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Atualizar", callback_data: "menu_stats" }],
            [{ text: "⬅️ Voltar",    callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  // ── Gerenciar bot
  if (action === "manage") {
    const isRunning = !!activeBots[id]
    const logPath = path.join(BASE_PATH, id, "terminal.log")
    const logSize = fs.existsSync(logPath)
      ? (fs.statSync(logPath).size / 1024).toFixed(1) + " KB"
      : "0 KB"

    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\n` +
      `ID: \`${id}\`\n` +
      `Status: ${isRunning ? "🟢 Online" : "🔴 Offline"}\n` +
      `Log: ${logSize}`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }],
            [
              { text: isRunning ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${isRunning ? "stop" : "start"}:${id}` },
              { text: "🔄 Reiniciar", callback_data: `restart:${id}` }
            ],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }

  // ── Gerar link de upload
  if (action === "gen_upload") {
    const token = require("crypto").randomBytes(16).toString("hex")
    uploadTokens[token] = { chatId, createdAt: Date.now() }

    // Expira o token em 15 minutos
    setTimeout(() => { delete uploadTokens[token] }, 15 * 60 * 1000)

    const uploadUrl = `${DOMAIN}/upload/${token}`
    return bot.editMessageText(
      `🌐 *Link de Upload Gerado*\n\n` +
      `Acesse a pagina abaixo, escolha o .zip e o nome do bot:\n\n` +
      `⏳ Expira em *15 minutos*`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Abrir pagina de upload", url: uploadUrl }],
            [{ text: "⬅️ Voltar", callback_data: "menu_new" }]
          ]
        }
      }
    )
  }

  // ── Parar bot
  if (action === "stop") {
    if (activeBots[id]) activeBots[id].process.kill()
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🔴 Offline`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }],
            [
              { text: "▶️ Iniciar",   callback_data: `start:${id}` },
              { text: "🔄 Reiniciar", callback_data: `restart:${id}` }
            ],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }

  // ── Iniciar bot
  if (action === "start") {
    spawnBot(id, path.join(BASE_PATH, id))
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Iniciando...`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }],
            [
              { text: "🛑 Parar",     callback_data: `stop:${id}` },
              { text: "🔄 Reiniciar", callback_data: `restart:${id}` }
            ],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }

  // ── Reiniciar bot
  if (action === "restart") {
    spawnBot(id, path.join(BASE_PATH, id))
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Reiniciando...`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}` }],
            [
              { text: "🛑 Parar",     callback_data: `stop:${id}` },
              { text: "🔄 Reiniciar", callback_data: `restart:${id}` }
            ],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
})

// ─── Rotas web ────────────────────────────────

app.get("/terminal/:botId", (req, res) => {
  res.send(`<!DOCTYPE html>
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
<div id="header"><span>🚀 ARES TERMINAL</span><button onclick="location.reload()">🔄</button></div>
<div id="terminal"></div>
<script>
const socket = io()
const term = new Terminal({cursorBlink:true,fontSize:14,theme:{background:"#000",foreground:"#0f0"}})
const fitAddon = new FitAddon.FitAddon()
term.loadAddon(fitAddon)
term.open(document.getElementById("terminal"))
fitAddon.fit()
window.addEventListener("resize",()=>fitAddon.fit())
const botId="${req.params.botId}"
socket.on("log-"+botId,data=>term.write(data))
term.onData(data=>socket.emit("input",{botId,data}))
</script>
</body>
</html>`)
})

// ─── Upload via Web ──────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const token = req.params.token
    const info = uploadTokens[token]
    if (!info) return cb(new Error("Token invalido ou expirado"))
    const tmpPath = path.join(BASE_PATH, "_uploads")
    if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath, { recursive: true })
    cb(null, tmpPath)
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}_bot.zip`)
})

const upload = multer({
  storage,
  limits: { fileSize: 512 * 1024 * 1024 }, // 512MB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".zip"))
      return cb(new Error("Apenas arquivos .zip sao permitidos"))
    cb(null, true)
  }
})

app.get("/upload/:token", (req, res) => {
  const info = uploadTokens[req.params.token]
  if (!info) return res.status(403).send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>ARES HOST</title>
    <style>body{background:#0a0a0a;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{text-align:center;padding:40px;border:1px solid #333;border-radius:12px}
    h2{color:#f44;margin:0 0 10px}</style></head>
    <body><div class="box"><h2>❌ Link inválido ou expirado</h2><p>Gere um novo link pelo Telegram.</p></div></body></html>
  `)

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ARES HOST — Upload</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#111;border:1px solid #222;border-radius:16px;padding:36px;width:100%;max-width:480px;box-shadow:0 0 40px rgba(0,255,100,0.05)}
.logo{color:#0f0;font-size:22px;font-weight:bold;margin-bottom:6px}
.sub{color:#555;font-size:13px;margin-bottom:28px}
.drop{border:2px dashed #2a2a2a;border-radius:12px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .2s;position:relative}
.drop:hover,.drop.over{border-color:#0f0;background:#0a1a0a}
.drop input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.drop-icon{font-size:36px;margin-bottom:10px}
.drop-text{color:#555;font-size:14px}
.drop-text span{color:#0f0}
.file-info{margin-top:16px;background:#1a1a1a;border-radius:8px;padding:12px 16px;display:none;align-items:center;gap:10px}
.file-info.show{display:flex}
.file-name{flex:1;font-size:13px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-size{color:#555;font-size:12px;white-space:nowrap}
label{display:block;margin-top:20px;margin-bottom:6px;font-size:13px;color:#888}
input[type=text]{width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;color:#fff;font-size:14px;outline:none;transition:border .2s}
input[type=text]:focus{border-color:#0f0}
.btn{margin-top:22px;width:100%;background:#0f0;color:#000;border:none;border-radius:8px;padding:13px;font-size:15px;font-weight:bold;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn:disabled{opacity:.4;cursor:not-allowed}
.progress{margin-top:16px;display:none}
.progress.show{display:block}
.bar-bg{background:#1a1a1a;border-radius:99px;height:6px;overflow:hidden}
.bar{height:100%;background:#0f0;width:0%;transition:width .3s;border-radius:99px}
.status{margin-top:10px;font-size:13px;color:#555;text-align:center}
.status.ok{color:#0f0}
.status.err{color:#f44}
</style>
</head>
<body>
<div class="card">
  <div class="logo">🚀 ARES HOST</div>
  <div class="sub">Upload de Bot — cole ou arraste o .zip</div>

  <div class="drop" id="drop">
    <input type="file" id="fileInput" accept=".zip">
    <div class="drop-icon">📦</div>
    <div class="drop-text">Arraste o <span>.zip</span> aqui ou clique para selecionar</div>
  </div>

  <div class="file-info" id="fileInfo">
    <span>📄</span>
    <span class="file-name" id="fileName"></span>
    <span class="file-size" id="fileSize"></span>
  </div>

  <label>Nome do bot</label>
  <input type="text" id="botName" placeholder="ex: meubot, vendas, suporte" maxlength="40">

  <button class="btn" id="btn" disabled onclick="doUpload()">Enviar Bot</button>

  <div class="progress" id="progress">
    <div class="bar-bg"><div class="bar" id="bar"></div></div>
    <div class="status" id="status">Enviando...</div>
  </div>
</div>

<script>
const token = "${req.params.token}"
const fileInput = document.getElementById("fileInput")
const drop = document.getElementById("drop")
const btn = document.getElementById("btn")
const botNameInput = document.getElementById("botName")

function formatSize(b){
  if(b>1024*1024) return (b/1024/1024).toFixed(1)+" MB"
  return (b/1024).toFixed(0)+" KB"
}

function checkReady(){
  btn.disabled = !(fileInput.files[0] && botNameInput.value.trim().length > 0)
}

fileInput.addEventListener("change", () => {
  const f = fileInput.files[0]
  if(!f) return
  document.getElementById("fileName").textContent = f.name
  document.getElementById("fileSize").textContent = formatSize(f.size)
  document.getElementById("fileInfo").classList.add("show")
  checkReady()
})

botNameInput.addEventListener("input", checkReady)

drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over") })
drop.addEventListener("dragleave", () => drop.classList.remove("over"))
drop.addEventListener("drop", e => {
  e.preventDefault()
  drop.classList.remove("over")
  const f = e.dataTransfer.files[0]
  if(!f || !f.name.endsWith(".zip")) return alert("Apenas arquivos .zip!")
  const dt = new DataTransfer()
  dt.items.add(f)
  fileInput.files = dt.files
  fileInput.dispatchEvent(new Event("change"))
})

function doUpload(){
  const f = fileInput.files[0]
  const name = botNameInput.value.trim().replace(/\s+/g,"_").toLowerCase()
  if(!f || !name) return

  btn.disabled = true
  const prog = document.getElementById("progress")
  const bar = document.getElementById("bar")
  const status = document.getElementById("status")
  prog.classList.add("show")

  const fd = new FormData()
  fd.append("file", f)
  fd.append("name", name)

  const xhr = new XMLHttpRequest()
  xhr.open("POST", "/upload/"+token)

  xhr.upload.onprogress = e => {
    if(e.lengthComputable){
      const pct = Math.round(e.loaded/e.total*100)
      bar.style.width = pct+"%"
      status.textContent = "Enviando... "+pct+"%"
    }
  }

  xhr.onload = () => {
    if(xhr.status === 200){
      bar.style.width = "100%"
      status.textContent = "✅ Bot enviado com sucesso! Verifique o Telegram."
      status.className = "status ok"
    } else {
      status.textContent = "❌ Erro: " + xhr.responseText
      status.className = "status err"
      btn.disabled = false
    }
  }

  xhr.onerror = () => {
    status.textContent = "❌ Erro de conexão."
    status.className = "status err"
    btn.disabled = false
  }

  xhr.send(fd)
}
</script>
</body>
</html>`)
})

app.post("/upload/:token", upload.single("file"), async (req, res) => {
  const token = req.params.token
  const info = uploadTokens[token]

  if (!info) return res.status(403).send("Token invalido ou expirado")
  if (!req.file) return res.status(400).send("Nenhum arquivo recebido")

  const chatId = info.chatId
  const name = (req.body.name || "bot").replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 40)
  const botId = generateBotId()
  const instancePath = path.join(BASE_PATH, botId)

  // Invalida o token imediatamente
  delete uploadTokens[token]

  fs.mkdirSync(instancePath, { recursive: true })

  const zipPath = path.join(instancePath, "bot.zip")
  fs.renameSync(req.file.path, zipPath)

  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ Criando bot *${name}*...

Arquivo recebido via web, extraindo...`,
    { parse_mode: "Markdown" }
  )

  extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)

  res.send("ok")
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
