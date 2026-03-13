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
      if (e.name === "node_modules" || e.name === ".git") continue
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

function editorHtml(botId) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ARES — ${botId}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/editor/editor.main.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;--text:#e6edf3;--text2:#8b949e;--green:#3fb950;--blue:#58a6ff;--orange:#d29922;--red:#f85149;--purple:#bc8cff}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden;font-size:13px}
#topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 16px;height:48px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.logo{font-weight:700;font-size:14px;color:var(--green);white-space:nowrap}
.bot-chip{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-size:12px;color:var(--text2);font-family:monospace}
.sep{color:var(--border)}
.spacer{flex:1}
.tb-btn{display:flex;align-items:center;gap:5px;padding:5px 12px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;background:var(--bg3);color:var(--text);transition:all .15s;white-space:nowrap}
.tb-btn:hover{border-color:var(--text2)}
.tb-btn.primary{background:var(--green);border-color:var(--green);color:#000}
.tb-btn.primary:hover{opacity:.9}
.tb-btn.danger{border-color:var(--red);color:var(--red)}
.tb-btn.danger:hover{background:rgba(248,81,73,.1)}
#main{display:flex;flex:1;overflow:hidden}
#sidebar{width:260px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
#sidebar-top{padding:10px 12px 6px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
#sidebar-top .stitle{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text2)}
.icon-btns{display:flex;gap:4px}
.icon-btn{background:none;border:none;color:var(--text2);cursor:pointer;padding:3px 5px;border-radius:4px;font-size:14px;line-height:1;transition:all .15s}
.icon-btn:hover{background:var(--bg3);color:var(--text)}
#tree-scroll{flex:1;overflow-y:auto;padding:4px 0}
#tree-scroll::-webkit-scrollbar{width:4px}
#tree-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.ti{display:flex;align-items:center;padding:3px 0;cursor:pointer;user-select:none;border-radius:4px}
.ti:hover{background:rgba(255,255,255,.04)}
.ti.active{background:rgba(56,189,248,.08)}
.ti.active .ti-name{color:var(--blue)}
.ti-indent{flex-shrink:0}
.ti-arrow{width:16px;flex-shrink:0;color:var(--text2);font-size:10px;text-align:center;transition:transform .15s}
.ti-arrow.open{transform:rotate(90deg)}
.ti-arrow.leaf{opacity:0;pointer-events:none}
.ti-icon{margin-right:5px;font-size:13px;flex-shrink:0}
.ti-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.ti-name.dir{color:var(--blue)}
#editor-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
#tabs-bar{background:var(--bg2);border-bottom:1px solid var(--border);display:flex;overflow-x:auto;flex-shrink:0;height:36px}
#tabs-bar::-webkit-scrollbar{height:3px}
#tabs-bar::-webkit-scrollbar-thumb{background:var(--border)}
.tab{display:flex;align-items:center;gap:6px;padding:0 12px;height:36px;border-right:1px solid var(--border);cursor:pointer;white-space:nowrap;font-size:12px;color:var(--text2);flex-shrink:0;position:relative;transition:background .1s}
.tab:hover{background:var(--bg3);color:var(--text)}
.tab.active{color:var(--text);background:var(--bg)}
.tab.active::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:var(--blue)}
.tab .tab-close{opacity:.4;font-size:11px;padding:1px 3px;border-radius:3px;line-height:1}
.tab .tab-close:hover{opacity:1;background:var(--bg3)}
.tab .tab-dot{width:7px;height:7px;background:var(--orange);border-radius:50%}
#breadcrumb{background:var(--bg);border-bottom:1px solid var(--border);padding:4px 16px;font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px;flex-shrink:0;min-height:28px;font-family:monospace}
#breadcrumb span{color:var(--text)}
#breadcrumb .bc-sep{color:var(--border)}
#editor{flex:1;overflow:hidden}
#welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--text2);padding:40px}
#welcome .big{font-size:56px;opacity:.4}
#welcome h2{font-size:18px;color:var(--text);font-weight:400}
#welcome p{font-size:13px;text-align:center;max-width:320px;line-height:1.6}
#welcome kbd{background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-family:monospace;font-size:11px;color:var(--text)}
#statusbar{background:#1f2328;border-top:1px solid var(--border);height:22px;display:flex;align-items:center;padding:0 14px;gap:16px;font-size:11px;color:var(--text2);flex-shrink:0}
#statusbar .sb-item.green{color:var(--green)}
#statusbar .sb-item.orange{color:var(--orange)}
.overlay{display:none;position:fixed;inset:0;background:rgba(1,4,9,.7);z-index:1000;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.overlay.show{display:flex}
.modal{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:24px;width:380px;max-width:90vw;box-shadow:0 16px 48px rgba(1,4,9,.5)}
.modal h3{margin-bottom:16px;font-size:15px;font-weight:600}
.modal label{display:block;font-size:12px;color:var(--text2);margin-bottom:6px}
.modal input{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:13px;outline:none;font-family:monospace;transition:border .15s}
.modal input:focus{border-color:var(--blue)}
.modal-btns{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
.modal-btns button{padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;border:1px solid var(--border)}
.mbtn-ok{background:var(--green);border-color:var(--green);color:#000}
.mbtn-cancel{background:var(--bg3);color:var(--text2)}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:10px 20px;border-radius:8px;font-size:13px;z-index:9999;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;white-space:nowrap}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:var(--green);color:var(--green)}
.toast.err{border-color:var(--red);color:var(--red)}
.ctx-menu{display:none;position:fixed;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:4px;z-index:500;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.ctx-menu.show{display:block}
.ctx-item{padding:6px 12px;cursor:pointer;border-radius:4px;font-size:13px;display:flex;align-items:center;gap:8px}
.ctx-item:hover{background:var(--bg3)}
.ctx-item.danger{color:var(--red)}
.ctx-sep{height:1px;background:var(--border);margin:3px 0}
@media(max-width:700px){#sidebar{width:200px}.tb-btn span{display:none}}
</style>
</head>
<body>
<div id="topbar">
  <span class="logo">⚡ ARES HOST</span>
  <span class="sep">/</span>
  <span class="bot-chip">${botId}</span>
  <div class="spacer"></div>
  <span id="unsaved-label" style="display:none;font-size:11px;color:var(--orange);margin-right:4px">● não salvo</span>
  <button class="tb-btn" id="btn-rename" onclick="renameFile()" style="display:none">✏️ <span>Renomear</span></button>
  <button class="tb-btn danger" id="btn-delete" onclick="deleteFile()" style="display:none">🗑️ <span>Excluir</span></button>
  <button class="tb-btn primary" id="btn-save" onclick="saveFile()" style="display:none">💾 <span>Salvar</span></button>
</div>
<div id="main">
  <div id="sidebar">
    <div id="sidebar-top">
      <span class="stitle">Explorador</span>
      <div class="icon-btns">
        <button class="icon-btn" onclick="newFile()" title="Novo arquivo">📄</button>
        <button class="icon-btn" onclick="newFolder()" title="Nova pasta">📁</button>
        <button class="icon-btn" onclick="loadTree()" title="Atualizar">🔄</button>
      </div>
    </div>
    <div id="tree-scroll"><div id="tree"></div></div>
  </div>
  <div id="editor-wrap">
    <div id="tabs-bar"></div>
    <div id="breadcrumb">Selecione um arquivo</div>
    <div id="editor"></div>
    <div id="welcome">
      <div class="big">⚡</div>
      <h2>ARES Editor</h2>
      <p>Selecione um arquivo na árvore para editar.<br>Use <kbd>Ctrl+S</kbd> para salvar.</p>
    </div>
  </div>
</div>
<div id="statusbar">
  <span class="sb-item" id="sb-lang">—</span>
  <span class="sb-item" id="sb-lines">—</span>
  <span class="sb-item green" id="sb-status">✓ pronto</span>
</div>
<div class="toast" id="toast"></div>
<div class="overlay" id="modal-overlay">
  <div class="modal">
    <h3 id="modal-title">Novo Arquivo</h3>
    <label id="modal-label">Nome</label>
    <input id="modal-input" type="text" autocomplete="off" spellcheck="false"/>
    <div class="modal-btns">
      <button class="mbtn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="mbtn-ok" onclick="modalConfirm()">Confirmar</button>
    </div>
  </div>
</div>
<div class="ctx-menu" id="ctx-menu">
  <div class="ctx-item" onclick="ctxRename()">✏️ Renomear</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item danger" onclick="ctxDelete()">🗑️ Excluir</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<script>
require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}})
require(['vs/editor/editor.main'], function() {
const BOT_ID="${botId}"
const API="/files-api/"+BOT_ID
let editor=null,currentFile=null,isDirty=false,modalAction=null,ctxTarget=null
let tabs=[],models={}

editor=monaco.editor.create(document.getElementById("editor"),{
  value:"",language:"javascript",theme:"vs-dark",fontSize:14,
  automaticLayout:true,minimap:{enabled:window.innerWidth>900},
  scrollBeyondLastLine:false,wordWrap:"on",padding:{top:12},
  renderLineHighlight:"all",smoothScrolling:true
})
monaco.editor.defineTheme("ares-dark",{base:"vs-dark",inherit:true,rules:[
  {token:"comment",foreground:"8b949e",fontStyle:"italic"},
  {token:"keyword",foreground:"ff7b72"},
  {token:"string",foreground:"a5d6ff"},
  {token:"number",foreground:"79c0ff"},
  {token:"function",foreground:"d2a8ff"},
],colors:{"editor.background":"#0d1117","editor.foreground":"#e6edf3",
  "editor.lineHighlightBackground":"#161b22","editorLineNumber.foreground":"#3d444d",
  "editorLineNumber.activeForeground":"#e6edf3","editor.selectionBackground":"#264f78",
  "editorCursor.foreground":"#58a6ff","editorIndentGuide.background1":"#21262d"}})
monaco.editor.setTheme("ares-dark")
document.getElementById("editor").style.display="none"
editor.onDidChangeModelContent(()=>setDirty(true))
editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,saveFile)

function getExt(n){const p=n.split(".");return p.length>1?p[p.length-1].toLowerCase():""}
function getLang(f){const m={js:"javascript",ts:"typescript",jsx:"javascript",tsx:"typescript",json:"json",py:"python",md:"markdown",sh:"shell",bash:"shell",html:"html",css:"css",scss:"scss",yml:"yaml",yaml:"yaml",txt:"plaintext",env:"plaintext",sql:"sql",xml:"xml",php:"php",rb:"ruby",go:"go",rs:"rust",java:"java",cpp:"cpp",c:"c",h:"c",cs:"csharp"};return m[getExt(f)]||"plaintext"}
function fileIcon(n){const m={js:"🟨",ts:"🔷",jsx:"🟨",tsx:"🔷",json:"🟧",py:"🐍",md:"📝",html:"🌐",css:"🎨",scss:"🎨",sh:"⚙️",env:"🔑",yml:"📋",yaml:"📋",sql:"🗄️",png:"🖼️",jpg:"🖼️",jpeg:"🖼️",gif:"🖼️",svg:"🖼️",zip:"📦",lock:"🔒"};return m[getExt(n)]||"📄"}
function escHtml(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

function setDirty(v){
  isDirty=v
  document.getElementById("unsaved-label").style.display=v?"inline":"none"
  const tab=tabs.find(t=>t.path===currentFile)
  if(tab){tab.dirty=v;renderTabs()}
}

let openDirs=new Set(),treeData=[]

function buildTreeHTML(items,depth){
  let h=""
  for(const item of items){
    const indent=depth*14
    if(item.type==="dir"){
      const isOpen=openDirs.has(item.path)
      h+=\`<div class="ti" onclick="toggleDir('\${escHtml(item.path)}')" oncontextmenu="showCtx(event,'\${escHtml(item.path)}',true)">
        <div class="ti-indent" style="width:\${indent}px"></div>
        <span class="ti-arrow \${isOpen?"open":""}">▶</span>
        <span class="ti-icon">\${isOpen?"📂":"📁"}</span>
        <span class="ti-name dir">\${escHtml(item.name)}</span>
      </div>\`
      if(isOpen&&item.children.length)h+=\`<div>\${buildTreeHTML(item.children,depth+1)}</div>\`
    }else{
      const active=currentFile===item.path?" active":""
      h+=\`<div class="ti tree-file\${active}" onclick="openFile('\${escHtml(item.path)}')" oncontextmenu="showCtx(event,'\${escHtml(item.path)}',false)">
        <div class="ti-indent" style="width:\${indent+16}px"></div>
        <span class="ti-arrow leaf">▶</span>
        <span class="ti-icon">\${fileIcon(item.name)}</span>
        <span class="ti-name">\${escHtml(item.name)}</span>
      </div>\`
    }
  }
  return h
}
function toggleDir(p){openDirs.has(p)?openDirs.delete(p):openDirs.add(p);renderTree()}
async function loadTree(){
  try {
    const r=await fetch(API+"/tree")
    if(!r.ok){document.getElementById("tree").innerHTML='<div style="color:var(--red);padding:10px;font-size:12px">Erro '+r.status+': '+r.statusText+'</div>';return}
    treeData=await r.json()
    if(!treeData.length)document.getElementById("tree").innerHTML='<div style="color:var(--text2);padding:10px;font-size:12px">Pasta vazia</div>'
    else renderTree()
  } catch(e) {
    document.getElementById("tree").innerHTML='<div style="color:var(--red);padding:10px;font-size:12px">Erro: '+e.message+'</div>'
  }
}
function renderTree(){document.getElementById("tree").innerHTML=buildTreeHTML(treeData,0)}

function renderTabs(){
  const bar=document.getElementById("tabs-bar")
  if(!tabs.length){bar.innerHTML="";return}
  bar.innerHTML=tabs.map(t=>{
    const name=t.path.split("/").pop()
    const active=t.path===currentFile?" active":""
    const indicator=t.dirty?\`<span class="tab-dot"></span>\`:\`<span class="tab-close" onclick="closeTab(event,'\${escHtml(t.path)}')">✕</span>\`
    return \`<div class="tab\${active}" onclick="switchTab('\${escHtml(t.path)}')" title="\${escHtml(t.path)}">\${escHtml(fileIcon(name))} \${escHtml(name)}\${indicator}</div>\`
  }).join("")
}

function switchTab(p){if(p!==currentFile)openFile(p)}

function closeTab(e,p){
  e.stopPropagation()
  const tab=tabs.find(t=>t.path===p)
  if(tab&&tab.dirty&&!confirm("Fechar sem salvar?"))return
  tabs=tabs.filter(t=>t.path!==p)
  if(models[p]){models[p].dispose();delete models[p]}
  if(currentFile===p){
    if(tabs.length)openFile(tabs[tabs.length-1].path)
    else{
      currentFile=null;isDirty=false;editor.setValue("")
      document.getElementById("editor").style.display="none"
      document.getElementById("welcome").style.display="flex"
      ;["btn-save","btn-delete","btn-rename"].forEach(id=>document.getElementById(id).style.display="none")
      document.getElementById("unsaved-label").style.display="none"
      document.getElementById("breadcrumb").textContent="Selecione um arquivo"
      document.getElementById("sb-lang").textContent="—"
    }
  }
  renderTabs()
}

async function openFile(p){
  if(!models[p]){
    const r=await fetch(API+"/read?path="+encodeURIComponent(p))
    if(!r.ok){toast("Erro ao abrir arquivo","err");return}
    const text=await r.text()
    models[p]=monaco.editor.createModel(text,getLang(p))
    tabs.push({path:p,dirty:false})
  }
  currentFile=p;isDirty=false
  editor.setModel(models[p])
  document.getElementById("editor").style.display="block"
  document.getElementById("welcome").style.display="none"
  ;["btn-save","btn-delete","btn-rename"].forEach(id=>document.getElementById(id).style.display="inline-flex")
  const parts=p.split("/")
  document.getElementById("breadcrumb").innerHTML=parts.map((x,i)=>i<parts.length-1?\`<span>\${escHtml(x)}</span><span class="bc-sep"> / </span>\`:\`<span>\${escHtml(x)}</span>\`).join("")
  document.getElementById("sb-lang").textContent=getLang(p)
  document.getElementById("sb-lines").textContent=editor.getModel().getLineCount()+" linhas"
  setDirty(false)
  renderTree();renderTabs();editor.focus()
}

async function saveFile(){
  if(!currentFile)return
  document.getElementById("sb-status").textContent="💾 salvando..."
  const r=await fetch(API+"/write",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:currentFile,content:editor.getValue()})})
  if(r.ok){setDirty(false);document.getElementById("sb-status").textContent="✓ salvo";toast("✅ Salvo!","ok")}
  else{document.getElementById("sb-status").textContent="✗ erro";toast("❌ Erro ao salvar","err")}
}

async function deleteFile(){
  if(!currentFile||!confirm(\`Excluir "\${currentFile}"?\`))return
  const r=await fetch(API+"/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:currentFile})})
  if(r.ok){toast("🗑️ Excluído!","ok");closeTab({stopPropagation:()=>{}},currentFile);await loadTree()}
  else toast("❌ Erro","err")
}

function newFile(){
  const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
  openModal("Novo Arquivo","arquivo.js","Nome do arquivo:",async name=>{
    const p=folder?folder+"/"+name:name
    const r=await fetch(API+"/write",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p,content:""})})
    if(r.ok){await loadTree();openFile(p);toast("✅ Criado!","ok")}else toast("❌ Erro","err")
  })
}

function newFolder(){
  openModal("Nova Pasta","pasta","Nome da pasta:",async name=>{
    const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
    const p=folder?folder+"/"+name:name
    const r=await fetch(API+"/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})})
    if(r.ok){await loadTree();toast("✅ Pasta criada!","ok")}else toast("❌ Erro","err")
  })
}

function renameFile(){
  if(!currentFile)return
  const parts=currentFile.split("/")
  openModal("Renomear",parts[parts.length-1],"Novo nome:",async newName=>{
    const newPath=[...parts.slice(0,-1),newName].join("/")
    const r=await fetch(API+"/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:currentFile,to:newPath})})
    if(r.ok){
      const tab=tabs.find(t=>t.path===currentFile)
      if(tab)tab.path=newPath
      if(models[currentFile]){models[newPath]=models[currentFile];delete models[currentFile]}
      currentFile=newPath
      await loadTree();openFile(newPath);toast("✅ Renomeado!","ok")
    }else toast("❌ Erro","err")
  })
}

function showCtx(e,p,isDir){
  e.preventDefault();e.stopPropagation()
  ctxTarget={path:p,isDir}
  const m=document.getElementById("ctx-menu")
  m.style.left=e.clientX+"px";m.style.top=e.clientY+"px";m.classList.add("show")
}
function ctxRename(){
  closeCtx();if(!ctxTarget)return
  const parts=ctxTarget.path.split("/")
  openModal("Renomear",parts[parts.length-1],"Novo nome:",async newName=>{
    const newPath=[...parts.slice(0,-1),newName].join("/")
    const r=await fetch(API+"/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:ctxTarget.path,to:newPath})})
    if(r.ok){if(currentFile===ctxTarget.path){const tab=tabs.find(t=>t.path===currentFile);if(tab)tab.path=newPath;if(models[currentFile]){models[newPath]=models[currentFile];delete models[currentFile]}currentFile=newPath}await loadTree();toast("✅ Renomeado!","ok")}else toast("❌ Erro","err")
  })
}
function ctxDelete(){
  closeCtx();if(!ctxTarget)return
  if(!confirm(\`Excluir "\${ctxTarget.path}"?\`))return
  fetch(API+"/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:ctxTarget.path})})
    .then(r=>{if(r.ok){if(!ctxTarget.isDir)closeTab({stopPropagation:()=>{}},ctxTarget.path);loadTree();toast("🗑️ Excluído!","ok")}else toast("❌ Erro","err")})
}
function closeCtx(){document.getElementById("ctx-menu").classList.remove("show")}
document.addEventListener("click",closeCtx)

function openModal(title,placeholder,label,cb){
  modalAction=cb
  document.getElementById("modal-title").textContent=title
  document.getElementById("modal-label").textContent=label
  document.getElementById("modal-input").value=""
  document.getElementById("modal-input").placeholder=placeholder
  document.getElementById("modal-overlay").classList.add("show")
  setTimeout(()=>document.getElementById("modal-input").focus(),50)
}
function closeModal(){document.getElementById("modal-overlay").classList.remove("show");modalAction=null}
function modalConfirm(){const v=document.getElementById("modal-input").value.trim();if(!v)return;closeModal();if(modalAction)modalAction(v)}
document.getElementById("modal-input").addEventListener("keydown",e=>{if(e.key==="Enter")modalConfirm();if(e.key==="Escape")closeModal()})
document.getElementById("modal-overlay").addEventListener("click",e=>{if(e.target===document.getElementById("modal-overlay"))closeModal()})

function toast(msg,type){const t=document.getElementById("toast");t.textContent=msg;t.className="toast show "+(type||"");clearTimeout(t._t);t._t=setTimeout(()=>t.className="toast",2500)}

loadTree()
}) // fim require
</script>
</body>
</html>`
}

// Rota editor — sem wildcards, sem :param (contorna bug Express 5 + path-to-regexp)
app.use("/files", (req, res, next) => {
  const rawPath = req.originalUrl.split("?")[0].replace(/^\/files/, "")
  const m = rawPath.match(/^\/([^/]+)\/?$/)
  if (!m) return next()
  const botId = m[1]
  const botPath = path.join(BASE_PATH, botId)
  if (!fs.existsSync(botPath)) return res.status(404).send("<h2>Bot não encontrado</h2>")
  res.send(editorHtml(botId))
})

// API de arquivos — também sem :param
app.use("/files-api", (req, res, next) => {
  const rawPath = req.originalUrl.split("?")[0].replace(/^\/files-api/, "")
  const m = rawPath.match(/^\/([^/]+)(\/[^?/]*)/)
  if (!m) return next()
  const botId = m[1]
  const action = m[2]
  const botPath = path.join(BASE_PATH, botId)

  if (action === "/tree") {
    if (!fs.existsSync(botPath)) return res.status(404).json([])
    return res.json(walkDir(botPath, ""))
  }

  if (action === "/read") {
    const fp = path.normalize(path.join(botPath, req.query.path || ""))
    if (!fp.startsWith(botPath)) return res.status(403).send("Proibido")
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return res.status(404).send("Não encontrado")
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    return res.send(fs.readFileSync(fp, "utf8"))
  }

  // POST actions — precisam de body parseado
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
