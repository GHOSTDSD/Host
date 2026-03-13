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

function flattenIfNeeded(instancePath) {
  // Verifica se todos os conteúdos estão dentro de uma única subpasta
  const entries = fs.readdirSync(instancePath).filter(e => e !== "bot.zip")
  if (entries.length === 1) {
    const single = path.join(instancePath, entries[0])
    const stat = fs.statSync(single)
    if (stat.isDirectory()) {
      // Move tudo da subpasta para instancePath
      const subEntries = fs.readdirSync(single)
      for (const file of subEntries) {
        fs.renameSync(path.join(single, file), path.join(instancePath, file))
      }
      fs.rmdirSync(single)
    }
  }
}

function extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg) {
  fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: instancePath }))
    .on("close", () => {
      // Flatten se o ZIP tiver uma pasta raiz (ex: bot.zip/pasta/arquivos)
      flattenIfNeeded(instancePath)

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
            [{ text: "📁 Arquivos / Editor", url: `${DOMAIN}/files/${id}` }],
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

app.post("/upload/:token", (req, res, next) => {
  const token = req.params.token
  const info = uploadTokens[token]
  if (!info) return res.status(403).send("Token invalido ou expirado")
  next()
}, multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tmpPath = path.join(BASE_PATH, "_uploads")
      if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath, { recursive: true })
      cb(null, tmpPath)
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_bot.zip`)
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".zip"))
      return cb(new Error("Apenas .zip sao permitidos"))
    cb(null, true)
  }
}).single("file"), async (req, res) => {
  const token = req.params.token
  const info = uploadTokens[token]
  if (!req.file) return res.status(400).send("Nenhum arquivo recebido")

  const chatId = info.chatId
  const name = (req.body.name || "bot").replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 40)
  const botId = generateBotId()
  const instancePath = path.join(BASE_PATH, botId)

  delete uploadTokens[token]
  fs.mkdirSync(instancePath, { recursive: true })

  const zipPath = path.join(instancePath, "bot.zip")
  fs.renameSync(req.file.path, zipPath)

  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ Criando bot *${name}*...\n\nArquivo recebido via web, extraindo...`,
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

// ─── Editor de Arquivos ──────────────────────

function walkDir(dir, base) {
  const result = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "bot.zip") continue
      const rel = base ? base + "/" + e.name : e.name
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        result.push({ type: "dir", name: e.name, path: rel, children: walkDir(full, rel) })
      } else {
        result.push({ type: "file", name: e.name, path: rel })
      }
    }
  } catch(e) {}
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

// Página do editor
app.use("/files", (req, res, next) => {
  const rawUrl = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/^\/files\/([^/]+)\/?$/)
  if (!m) return next()
  const botId = m[1]
  const botPath = path.join(BASE_PATH, botId)
  if (!fs.existsSync(botPath)) return res.status(404).send("Bot não encontrado")

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARES Editor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
#bar{background:#161b22;border-bottom:1px solid #30363d;padding:0 12px;height:44px;display:flex;align-items:center;gap:8px;flex-shrink:0}
#bar .logo{color:#3fb950;font-weight:bold;font-size:14px}
#bar .chip{background:#21262d;border:1px solid #30363d;border-radius:12px;padding:2px 10px;font-size:11px;color:#8b949e}
#bar .sp{flex:1}
.btn{padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;border:1px solid #30363d;background:#21262d;color:#e6edf3;display:none}
.btn:hover{border-color:#8b949e}
.btn.green{background:#238636;border-color:#238636;color:#fff;display:none}
.btn.green:hover{background:#2ea043}
.btn.red{border-color:#da3633;color:#f85149;display:none}
.btn.red:hover{background:rgba(248,81,73,.1)}
#wrap{display:flex;flex:1;overflow:hidden}
#side{width:250px;background:#161b22;border-right:1px solid #30363d;display:flex;flex-direction:column;flex-shrink:0}
#side-top{padding:8px 10px;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between}
#side-top span{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;font-weight:700}
#side-top div{display:flex;gap:4px}
.ibtn{background:none;border:none;color:#8b949e;cursor:pointer;padding:3px 6px;border-radius:4px;font-size:13px}
.ibtn:hover{background:#21262d;color:#e6edf3}
#tree{flex:1;overflow-y:auto;padding:4px 0;user-select:none}
#tree::-webkit-scrollbar{width:4px}
#tree::-webkit-scrollbar-thumb{background:#30363d}
.row{display:flex;align-items:center;padding:3px 6px;cursor:pointer;border-radius:4px;margin:0 3px}
.row:hover{background:#21262d}
.row.sel{background:#1f3a5f}
.row .ico{margin-right:5px;font-size:12px;width:16px;text-align:center;flex-shrink:0}
.row .lbl{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.row .lbl.d{color:#79c0ff}
.row .arr{font-size:9px;color:#8b949e;margin-right:3px;width:10px;transition:transform .15s;flex-shrink:0}
.row .arr.o{transform:rotate(90deg)}
.row .arr.h{opacity:0}
#right{flex:1;display:flex;flex-direction:column;overflow:hidden}
#tabs{background:#161b22;border-bottom:1px solid #30363d;display:flex;overflow-x:auto;min-height:35px;flex-shrink:0}
#tabs::-webkit-scrollbar{height:3px}
#tabs::-webkit-scrollbar-thumb{background:#30363d}
.tab{display:flex;align-items:center;gap:5px;padding:0 12px;height:35px;border-right:1px solid #30363d;cursor:pointer;font-size:12px;color:#8b949e;white-space:nowrap;flex-shrink:0;position:relative}
.tab:hover{background:#21262d;color:#e6edf3}
.tab.on{color:#e6edf3;background:#0d1117}
.tab.on::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:#58a6ff}
.tab .x{opacity:0;font-size:10px;padding:1px 3px;border-radius:3px}
.tab:hover .x{opacity:.6}
.tab .x:hover{opacity:1;background:#30363d}
.tab .dot{width:6px;height:6px;background:#d29922;border-radius:50%}
#breadcrumb{background:#0d1117;border-bottom:1px solid #30363d;padding:4px 14px;font-size:11px;color:#8b949e;flex-shrink:0}
#editor{flex:1;overflow:hidden}
#welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#8b949e}
#welcome .big{font-size:48px;opacity:.3}
#welcome p{font-size:13px}
#sbar{background:#1f2328;border-top:1px solid #30363d;height:22px;display:flex;align-items:center;padding:0 12px;gap:14px;font-size:11px;color:#8b949e;flex-shrink:0}
.sbar-ok{color:#3fb950}
.sbar-warn{color:#d29922}
/* modal */
.ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999;align-items:center;justify-content:center}
.ov.on{display:flex}
.box{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:22px;width:340px}
.box h3{margin-bottom:14px;font-size:14px;color:#e6edf3}
.box input{width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:7px 10px;border-radius:6px;font-size:13px;outline:none;font-family:monospace}
.box input:focus{border-color:#58a6ff}
.box .bts{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}
.box .bts button{padding:5px 14px;border-radius:6px;cursor:pointer;font-size:13px;border:1px solid #30363d}
.ok-btn{background:#238636;border-color:#238636;color:#fff}
.cancel-btn{background:#21262d;color:#8b949e}
/* toast */
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(6px);background:#161b22;border:1px solid #30363d;padding:9px 18px;border-radius:8px;font-size:13px;z-index:9999;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap}
.toast.on{opacity:1;transform:translateX(-50%)}
.toast.ok{border-color:#3fb950;color:#3fb950}
.toast.err{border-color:#f85149;color:#f85149}
/* ctx menu */
.ctx{display:none;position:fixed;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:4px;z-index:888;min-width:150px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.ctx.on{display:block}
.ctx-item{padding:6px 12px;cursor:pointer;border-radius:4px;font-size:13px;display:flex;align-items:center;gap:7px}
.ctx-item:hover{background:#21262d}
.ctx-item.danger{color:#f85149}
.ctx-hr{height:1px;background:#30363d;margin:3px 0}
</style>
</head>
<body>
<div id="bar">
  <span class="logo">⚡ ARES</span>
  <span style="color:#30363d">/</span>
  <span class="chip">${botId}</span>
  <div id="sp" class="sp"></div>
  <span id="unsaved" style="display:none;font-size:11px;color:#d29922">● não salvo</span>
  <button class="btn" id="btn-ren" onclick="doRename()">✏️ Renomear</button>
  <button class="btn red" id="btn-del" onclick="doDel()">🗑️ Excluir</button>
  <button class="btn green" id="btn-save" onclick="doSave()">💾 Salvar</button>
</div>
<div id="wrap">
  <div id="side">
    <div id="side-top">
      <span>Explorador</span>
      <div>
        <button class="ibtn" title="Novo arquivo" onclick="doNewFile()">📄+</button>
        <button class="ibtn" title="Nova pasta" onclick="doNewFolder()">📁+</button>
        <button class="ibtn" title="Atualizar" onclick="refreshTree()">↺</button>
      </div>
    </div>
    <div id="tree"></div>
  </div>
  <div id="right">
    <div id="tabs"></div>
    <div id="breadcrumb">—</div>
    <div id="editor"></div>
    <div id="welcome"><div class="big">📂</div><p>Selecione um arquivo para editar</p></div>
  </div>
</div>
<div id="sbar">
  <span id="sb-lang">—</span>
  <span id="sb-lines">—</span>
  <span id="sb-status" class="sbar-ok">✓ pronto</span>
</div>

<div class="ov" id="modal">
  <div class="box">
    <h3 id="modal-title">Nome</h3>
    <input id="modal-in" type="text" autocomplete="off" spellcheck="false"/>
    <div class="bts">
      <button class="cancel-btn" onclick="closeModal()">Cancelar</button>
      <button class="ok-btn" onclick="confirmModal()">OK</button>
    </div>
  </div>
</div>

<div class="ctx" id="ctx">
  <div class="ctx-item" onclick="ctxDoRename()">✏️ Renomear</div>
  <div class="ctx-hr"></div>
  <div class="ctx-item danger" onclick="ctxDoDel()">🗑️ Excluir</div>
</div>

<div class="toast" id="toast"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<script>
require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}})

const BOT_ID = "${botId}"
const API    = "/files-api/" + BOT_ID

// ── State
let monacoEditor = null
let currentFile  = null
let isDirty      = false
let openDirs     = new Set()
let treeData     = []
let tabs         = []   // [{path, dirty}]
let models       = {}   // path -> monaco ITextModel
let modalCb      = null
let ctxTarget    = null

// ── Init Monaco
require(["vs/editor/editor.main"], function() {
  monaco.editor.defineTheme("ares", {
    base:"vs-dark", inherit:true,
    rules:[
      {token:"comment",foreground:"8b949e",fontStyle:"italic"},
      {token:"keyword",foreground:"ff7b72"},
      {token:"string",foreground:"a5d6ff"},
      {token:"number",foreground:"79c0ff"},
      {token:"type.identifier",foreground:"ffa657"},
    ],
    colors:{
      "editor.background":"#0d1117",
      "editor.foreground":"#e6edf3",
      "editor.lineHighlightBackground":"#161b22",
      "editorLineNumber.foreground":"#484f58",
      "editorLineNumber.activeForeground":"#e6edf3",
      "editor.selectionBackground":"#264f78",
      "editorCursor.foreground":"#58a6ff",
    }
  })

  monacoEditor = monaco.editor.create(document.getElementById("editor"), {
    theme:"ares", fontSize:14, automaticLayout:true,
    minimap:{enabled:false}, scrollBeyondLastLine:false,
    wordWrap:"on", padding:{top:10}
  })

  monacoEditor.onDidChangeModelContent(() => markDirty())
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, doSave)

  document.getElementById("editor").style.display = "none"
  loadTree()
})

// ── Tree
function langIcon(name) {
  const ext = name.split(".").pop().toLowerCase()
  const m = {js:"🟨",ts:"🔷",jsx:"🟨",tsx:"🔷",json:"🟧",py:"🐍",
    md:"📝",html:"🌐",css:"🎨",sh:"⚙️",env:"🔑",yml:"📋",yaml:"📋",
    sql:"🗄️",png:"🖼️",jpg:"🖼️",jpeg:"🖼️",gif:"🖼️",svg:"🖼️",
    zip:"📦",lock:"🔒",gitignore:"👁️",txt:"📄"}
  return m[ext] || "📄"
}

function getLang(name) {
  const ext = name.split(".").pop().toLowerCase()
  const m = {js:"javascript",ts:"typescript",jsx:"javascript",tsx:"typescript",
    json:"json",py:"python",md:"markdown",sh:"shell",bash:"shell",
    html:"html",css:"css",scss:"css",yml:"yaml",yaml:"yaml",
    sql:"sql",xml:"xml",php:"php",rb:"ruby",go:"go",rs:"rust",
    java:"java",cpp:"cpp",c:"c",h:"c",cs:"csharp",txt:"plaintext",env:"plaintext"}
  return m[ext] || "plaintext"
}

function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") }

function renderTree() {
  document.getElementById("tree").innerHTML = buildRows(treeData, 0)
}

function buildRows(items, depth) {
  let h = ""
  for (const item of items) {
    const pad = depth * 14
    if (item.type === "dir") {
      const open = openDirs.has(item.path)
      h += \`<div class="row" style="padding-left:\${8+pad}px"
          onclick="toggleDir('\${esc(item.path)}')"
          oncontextmenu="showCtx(event,'\${esc(item.path)}',true)">
        <span class="arr \${open?"o":""}"">▶</span>
        <span class="ico">\${open?"📂":"📁"}</span>
        <span class="lbl d">\${esc(item.name)}</span>
      </div>\`
      if (open) h += buildRows(item.children, depth+1)
    } else {
      const sel = currentFile === item.path ? " sel" : ""
      h += \`<div class="row\${sel}" style="padding-left:\${8+pad+14}px"
          onclick="openFile('\${esc(item.path)}')"
          oncontextmenu="showCtx(event,'\${esc(item.path)}',false)">
        <span class="arr h">▶</span>
        <span class="ico">\${langIcon(item.name)}</span>
        <span class="lbl">\${esc(item.name)}</span>
      </div>\`
    }
  }
  return h
}

function toggleDir(p) {
  openDirs.has(p) ? openDirs.delete(p) : openDirs.add(p)
  renderTree()
}

async function loadTree() {
  try {
    const r = await fetch(API + "/tree")
    if (!r.ok) { showTreeErr("HTTP " + r.status); return }
    treeData = await r.json()
    if (!treeData.length) {
      document.getElementById("tree").innerHTML = '<div style="padding:12px;font-size:12px;color:#8b949e">Pasta vazia</div>'
    } else {
      renderTree()
    }
  } catch(e) {
    showTreeErr(e.message)
  }
}

function showTreeErr(msg) {
  document.getElementById("tree").innerHTML = \`<div style="padding:12px;font-size:12px;color:#f85149">Erro: \${msg}</div>\`
}

async function refreshTree() { await loadTree() }

// ── Tabs
function renderTabs() {
  const el = document.getElementById("tabs")
  el.innerHTML = tabs.map(t => {
    const name = t.path.split("/").pop()
    const on   = t.path === currentFile ? " on" : ""
    const ind  = t.dirty
      ? \`<span class="dot"></span>\`
      : \`<span class="x" onclick="closeTab(event,'\${esc(t.path)}')">✕</span>\`
    return \`<div class="tab\${on}" onclick="switchTo('\${esc(t.path)}')" title="\${esc(t.path)}">
      \${langIcon(name)} \${esc(name)}\${ind}
    </div>\`
  }).join("")
}

function switchTo(p) { if (p !== currentFile) openFile(p) }

function closeTab(e, p) {
  e.stopPropagation()
  const t = tabs.find(x => x.path === p)
  if (t && t.dirty && !confirm("Fechar sem salvar?")) return
  tabs = tabs.filter(x => x.path !== p)
  if (models[p]) { models[p].dispose(); delete models[p] }
  if (currentFile === p) {
    if (tabs.length) openFile(tabs[tabs.length-1].path)
    else clearEditor()
  }
  renderTabs()
}

function clearEditor() {
  currentFile = null; isDirty = false
  if (monacoEditor) monacoEditor.setValue("")
  document.getElementById("editor").style.display  = "none"
  document.getElementById("welcome").style.display = "flex"
  document.getElementById("breadcrumb").textContent = "—"
  document.getElementById("sb-lang").textContent    = "—"
  document.getElementById("unsaved").style.display  = "none"
  document.getElementById("btn-save").style.display = "none"
  document.getElementById("btn-del").style.display  = "none"
  document.getElementById("btn-ren").style.display  = "none"
  renderTree()
}

// ── Open file
async function openFile(p) {
  if (!monacoEditor) return

  if (!models[p]) {
    const r = await fetch(API + "/read?path=" + encodeURIComponent(p))
    if (!r.ok) { toast("Erro ao abrir: " + r.status, "err"); return }
    const text = await r.text()
    models[p] = monaco.editor.createModel(text, getLang(p))
    if (!tabs.find(t => t.path === p)) tabs.push({path:p, dirty:false})
  }

  currentFile = p
  isDirty = false
  monacoEditor.setModel(models[p])
  document.getElementById("editor").style.display  = "block"
  document.getElementById("welcome").style.display = "none"
  document.getElementById("breadcrumb").textContent = p
  document.getElementById("sb-lang").textContent    = getLang(p)
  document.getElementById("sb-lines").textContent   = monacoEditor.getModel().getLineCount() + " linhas"
  document.getElementById("btn-save").style.display = "block"
  document.getElementById("btn-del").style.display  = "block"
  document.getElementById("btn-ren").style.display  = "block"
  markDirty(false)
  renderTree()
  renderTabs()
  monacoEditor.focus()
}

// ── Dirty
function markDirty(v) {
  if (v === false) {
    isDirty = false
    document.getElementById("unsaved").style.display = "none"
    const t = tabs.find(x => x.path === currentFile)
    if (t) t.dirty = false
  } else if (!isDirty) {
    isDirty = true
    document.getElementById("unsaved").style.display = "inline"
    const t = tabs.find(x => x.path === currentFile)
    if (t) t.dirty = true
  }
  renderTabs()
}

// ── Save
async function doSave() {
  if (!currentFile || !monacoEditor) return
  document.getElementById("sb-status").textContent = "💾 salvando..."
  document.getElementById("sb-status").className = "sbar-warn"
  try {
    const r = await fetch(API + "/write", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({path: currentFile, content: monacoEditor.getValue()})
    })
    if (r.ok) {
      markDirty(false)
      document.getElementById("sb-status").textContent = "✓ salvo"
      document.getElementById("sb-status").className = "sbar-ok"
      toast("✅ Salvo!", "ok")
    } else throw new Error("HTTP " + r.status)
  } catch(e) {
    document.getElementById("sb-status").textContent = "✗ erro"
    toast("Erro ao salvar: " + e.message, "err")
  }
}

// ── Delete
async function doDel() {
  if (!currentFile || !confirm('Excluir "' + currentFile + '"?')) return
  try {
    const r = await fetch(API + "/delete", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({path: currentFile})
    })
    if (r.ok) { toast("🗑️ Excluído!", "ok"); closeTab({stopPropagation:()=>{}}, currentFile); await loadTree() }
    else throw new Error("HTTP " + r.status)
  } catch(e) { toast("Erro: " + e.message, "err") }
}

// ── Rename
async function doRename() {
  if (!currentFile) return
  const parts = currentFile.split("/")
  openModal("Renomear arquivo", parts[parts.length-1], async newName => {
    const newPath = [...parts.slice(0,-1), newName].join("/")
    const r = await fetch(API + "/rename", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({from: currentFile, to: newPath})
    })
    if (r.ok) {
      const t = tabs.find(x => x.path === currentFile)
      if (t) t.path = newPath
      if (models[currentFile]) { models[newPath] = models[currentFile]; delete models[currentFile] }
      currentFile = newPath
      await loadTree(); await openFile(newPath); toast("✅ Renomeado!", "ok")
    } else toast("Erro ao renomear", "err")
  })
}

// ── New
function doNewFile() {
  const folder = currentFile ? currentFile.split("/").slice(0,-1).join("/") : ""
  openModal("Novo arquivo", "index.js", async name => {
    const p = folder ? folder + "/" + name : name
    const r = await fetch(API + "/write", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({path:p, content:""})
    })
    if (r.ok) { await loadTree(); openFile(p); toast("✅ Arquivo criado!", "ok") }
    else toast("Erro ao criar arquivo", "err")
  })
}

function doNewFolder() {
  openModal("Nova pasta", "minha-pasta", async name => {
    const r = await fetch(API + "/mkdir", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({path: name})
    })
    if (r.ok) { await loadTree(); toast("✅ Pasta criada!", "ok") }
    else toast("Erro ao criar pasta", "err")
  })
}

// ── Context menu
function showCtx(e, p, isDir) {
  e.preventDefault(); e.stopPropagation()
  ctxTarget = {path:p, isDir}
  const el = document.getElementById("ctx")
  el.style.left = e.clientX + "px"
  el.style.top  = e.clientY + "px"
  el.classList.add("on")
}
function closeCtx() { document.getElementById("ctx").classList.remove("on") }
document.addEventListener("click", closeCtx)

function ctxDoRename() {
  closeCtx(); if (!ctxTarget) return
  const parts = ctxTarget.path.split("/")
  openModal("Renomear", parts[parts.length-1], async newName => {
    const newPath = [...parts.slice(0,-1), newName].join("/")
    const r = await fetch(API + "/rename", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({from: ctxTarget.path, to: newPath})
    })
    if (r.ok) {
      if (currentFile === ctxTarget.path) {
        const t = tabs.find(x => x.path === currentFile)
        if (t) t.path = newPath
        if (models[currentFile]) { models[newPath]=models[currentFile]; delete models[currentFile] }
        currentFile = newPath
      }
      await loadTree(); renderTabs(); toast("✅ Renomeado!", "ok")
    } else toast("Erro ao renomear", "err")
  })
}

function ctxDoDel() {
  closeCtx(); if (!ctxTarget) return
  if (!confirm('Excluir "' + ctxTarget.path + '"?')) return
  fetch(API + "/delete", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({path: ctxTarget.path})
  }).then(r => {
    if (r.ok) {
      if (!ctxTarget.isDir) closeTab({stopPropagation:()=>{}}, ctxTarget.path)
      loadTree(); toast("🗑️ Excluído!", "ok")
    } else toast("Erro ao excluir", "err")
  })
}

// ── Modal
function openModal(title, placeholder, cb) {
  modalCb = cb
  document.getElementById("modal-title").textContent = title
  document.getElementById("modal-in").value       = ""
  document.getElementById("modal-in").placeholder = placeholder
  document.getElementById("modal").classList.add("on")
  setTimeout(() => document.getElementById("modal-in").focus(), 50)
}
function closeModal() { document.getElementById("modal").classList.remove("on"); modalCb = null }
function confirmModal() {
  const v = document.getElementById("modal-in").value.trim()
  if (!v) return
  closeModal()
  if (modalCb) modalCb(v)
}
document.getElementById("modal-in").addEventListener("keydown", e => {
  if (e.key === "Enter")  confirmModal()
  if (e.key === "Escape") closeModal()
})
document.getElementById("modal").addEventListener("click", e => {
  if (e.target === document.getElementById("modal")) closeModal()
})

// ── Toast
function toast(msg, type) {
  const el = document.getElementById("toast")
  el.textContent = msg
  el.className = "toast on " + (type||"")
  clearTimeout(el._t)
  el._t = setTimeout(() => el.className = "toast", 2500)
}
</script>
</body>
</html>`)
})

// ── API de Arquivos
app.use("/files-api", (req, res, next) => {
  const rawUrl  = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/^\/files-api\/([^/]+)(\/[^?/]*)/)
  if (!m) return next()
  const botId  = m[1]
  const action = m[2]
  const botPath = path.join(BASE_PATH, botId)

  if (action === "/tree") {
    if (!fs.existsSync(botPath)) return res.status(404).json([])
    return res.json(walkDir(botPath, ""))
  }

  if (action === "/read") {
    const fp = path.normalize(path.join(botPath, req.query.path || ""))
    if (!fp.startsWith(botPath + path.sep) && fp !== botPath) return res.status(403).send("Proibido")
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return res.status(404).send("Não encontrado")
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    return res.send(fs.readFileSync(fp, "utf8"))
  }

  express.json()(req, res, () => {
    if (action === "/write") {
      const fp = path.normalize(path.join(botPath, req.body.path || ""))
      if (!fp.startsWith(botPath)) return res.status(403).send("Proibido")
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, req.body.content || "")
      return res.send("ok")
    }
    if (action === "/delete") {
      const fp = path.normalize(path.join(botPath, req.body.path || ""))
      if (!fp.startsWith(botPath)) return res.status(403).send("Proibido")
      if (!fs.existsSync(fp)) return res.status(404).send("Não encontrado")
      if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true, force: true })
      else fs.unlinkSync(fp)
      return res.send("ok")
    }
    if (action === "/mkdir") {
      const dp = path.normalize(path.join(botPath, req.body.path || ""))
      if (!dp.startsWith(botPath)) return res.status(403).send("Proibido")
      fs.mkdirSync(dp, { recursive: true })
      return res.send("ok")
    }
    if (action === "/rename") {
      const from = path.normalize(path.join(botPath, req.body.from || ""))
      const to   = path.normalize(path.join(botPath, req.body.to   || ""))
      if (!from.startsWith(botPath) || !to.startsWith(botPath)) return res.status(403).send("Proibido")
      if (!fs.existsSync(from)) return res.status(404).send("Não encontrado")
      fs.renameSync(from, to)
      return res.send("ok")
    }
    next()
  })
})

process.on("uncaughtException", err => {
  if (err.code !== "EADDRINUSE") console.error(err)
})

server.listen(PORT, () => aresBanner())
