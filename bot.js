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
const { execFile } = require("child_process")

EventEmitter.defaultMaxListeners = 200

const TOKEN = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM"
const ADMIN_ID = process.env.ADMIN_ID || ""
// Dono do sistema — pode usar /updateWarn
const OWNER_ID = process.env.OWNER_ID || ""  // defina OWNER_ID no Railway
const OWNER_USERNAME = "Quemmemarcaegay"
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
const uploadTokens = {} // token -> { chatId }
const webSessions = {} // sessionToken -> chatId (24h)
const PORT_START = 4000

// ── Owner helpers
function saveMeta(botId, chatId, name) {
  const mp = path.join(BASE_PATH, botId, "meta.json")
  fs.writeFileSync(mp, JSON.stringify({ owner: String(chatId), name, createdAt: Date.now() }))
}
function getMeta(botId) {
  try { return JSON.parse(fs.readFileSync(path.join(BASE_PATH, botId, "meta.json"), "utf8")) } catch { return null }
}
function getOwner(botId) {
  const m = getMeta(botId); return m ? m.owner : null
}
function getUserBots(chatId) {
  if (!fs.existsSync(BASE_PATH)) return []
  return fs.readdirSync(BASE_PATH).filter(f => {
    if (f === "_uploads") return false
    return getOwner(f) === String(chatId)
  })
}
function genWebSession(chatId) {
  const tok = require("crypto").randomBytes(24).toString("hex")
  webSessions[tok] = { chatId: String(chatId), at: Date.now() }
  setTimeout(() => delete webSessions[tok], 24 * 60 * 60 * 1000)
  return tok
}
function checkSession(req) {
  const tok = req.query.s
  if (!tok) return null
  const s = webSessions[tok]
  return s ? s.chatId : null
}
function authBot(req, res, next) {
  const rawUrl = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/\/([^\/]+)\/?(?:\?|$)/)
  const botId = m ? m[1] : null
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).send("Acesso negado. Abra o link pelo Telegram.")
  const owner = botId ? getOwner(botId) : null
  if (owner && owner !== chatId) return res.status(403).send("Este bot pertence a outro usuário.")
  req.chatId = chatId
  req.botId  = botId
  next()
}

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

function getStats(chatId) {
  const bots = chatId ? getUserBots(chatId) : (fs.existsSync(BASE_PATH) ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads") : [])
  const total = bots.length
  const online = bots.filter(f => !!activeBots[f]).length
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

const MAX_LOG_BYTES = 500 * 1024 // 500KB por bot
function writeLog(botId, instancePath, data) {
  const logPath = path.join(instancePath, "terminal.log")
  // Trunca log se passar de 500KB — evita acumulo no volume
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
      const content = fs.readFileSync(logPath, "utf8")
      fs.writeFileSync(logPath, content.slice(-MAX_LOG_BYTES / 2))
    }
  } catch {}
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
    // Apaga node_modules antes — economiza espaco no volume
    const nm = path.join(instancePath, "node_modules")
    if (fs.existsSync(nm)) {
      writeLog(botId, instancePath, "🧹 Limpando node_modules...\r\n")
      fs.rmSync(nm, { recursive: true, force: true })
    }
    writeLog(botId, instancePath, "📦 Instalando dependencias...\r\n")
    const install = pty.spawn(
      os.platform() === "win32" ? "npm.cmd" : "npm",
      ["install", "--production", "--prefer-offline"],
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
    // Apaga node_modules ao parar — libera espaco no volume
    const nm = path.join(instancePath, "node_modules")
    if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true })
    aresBanner()
  })
  aresBanner()
}

io.on("connection", socket => {
  // Quando cliente pede histórico do terminal
  socket.on("request-history", ({ botId }) => {
    const logPath = path.join(BASE_PATH, botId, "terminal.log")
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath)
      socket.emit("history-" + botId, content.toString())
    }
  })

  socket.on("input", ({ botId, data }) => {
    if (activeBots[botId]) activeBots[botId].process.write(data)
  })
})


// ─── Termos de uso ────────────────────────────

const USERS_PATH = path.join(BASE_PATH, "_users")
if (!fs.existsSync(USERS_PATH)) fs.mkdirSync(USERS_PATH, { recursive: true })

function hasAccepted(chatId) {
  try {
    const f = path.join(USERS_PATH, `${chatId}.json`)
    return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).accepted === true
  } catch { return false }
}

function saveAccepted(chatId) {
  const f = path.join(USERS_PATH, `${chatId}.json`)
  fs.writeFileSync(f, JSON.stringify({ accepted: true, at: Date.now() }))
}

const TERMOS_TEXTO =
  `📋 *Termos de Uso — ARES HOST*\n\n` +
  `Antes de continuar, leia e aceite os termos abaixo:\n\n` +
  `*1. Uso permitido*\n` +
  `Apenas bots legítimos de WhatsApp são permitidos. Bots de spam, golpes ou conteúdo ilegal serão removidos sem aviso.\n\n` +
  `*2. Responsabilidade*\n` +
  `Você é totalmente responsável pelo conteúdo e comportamento do seu bot. O ARES HOST não se responsabiliza por danos causados por bots hospedados.\n\n` +
  `*3. Disponibilidade*\n` +
  `O serviço pode passar por manutenções ou instabilidades. Não garantimos 100% de uptime.\n\n` +
  `*4. Dados*\n` +
  `Os arquivos do seu bot ficam armazenados em nossos servidores. Mantenha backup dos seus arquivos importantes.\n\n` +
  `*5. Encerramento*\n` +
  `Reservamos o direito de encerrar bots que violem estes termos a qualquer momento.\n\n` +
  `──────────────────────`

function sendTermos(chatId, checked) {
  const icon = checked ? "✅" : "⬜"
  return bot.sendMessage(chatId, TERMOS_TEXTO, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: `${icon}  Li e aceito os termos de uso`, callback_data: `termo_check:${checked ? "0" : "1"}` }],
        [{ text: "✔️ Confirmar e Continuar", callback_data: "termo_confirmar" }]
      ]
    }
  })
}

function editTermos(chatId, msgId, checked) {
  const icon = checked ? "✅" : "⬜"
  return bot.editMessageReplyMarkup({
    inline_keyboard: [
      [{ text: `${icon}  Li e aceito os termos de uso`, callback_data: `termo_check:${checked ? "0" : "1"}` }],
      [{ text: "✔️ Confirmar e Continuar", callback_data: "termo_confirmar" }]
    ]
  }, { chat_id: chatId, message_id: msgId }).catch(() => {})
}

// Estado do checkbox por usuário (em memória)
const termoCheck = {}

// ─── /start ───────────────────────────────────

bot.onText(/^\/meuid$/, msg => {
  bot.sendMessage(msg.chat.id,
    `🪪 *Seu Telegram ID:*\n\n` +
    `\`${msg.chat.id}\`\n\n` +
    `_Use este ID para configurar o OWNER\\_ID no Railway._`,
    { parse_mode: "Markdown" }
  )
})

bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id

  if (!hasAccepted(chatId)) {
    termoCheck[chatId] = false
    return sendTermos(chatId, false)
  }

  const s = getStats(chatId)
  bot.sendMessage(chatId,
    `🚀 *ARES HOST*\n\n` +
    `🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
    `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
          [{ text: "🎨 Criar Bot Visual", callback_data: "menu_builder" }],
          [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
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
              [{ text: "📟 Abrir Terminal", url: `${DOMAIN}/terminal/${botId}?s=${genWebSession(loadingMsg.chat.id)}` }],
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

  // Bloqueia usuário que não aceitou os termos ainda
  if (!hasAccepted(chatId)) {
    termoCheck[chatId] = false
    return sendTermos(chatId, false)
  }

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
  saveMeta(botId, chatId, name)

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

// ─── Exportar / Importar instâncias ───────────

function isAdmin(chatId) {
  return !ADMIN_ID || String(chatId) === String(ADMIN_ID)
}


// ─── Helpers de usuários ──────────────────────

function getAllUsers() {
  if (!fs.existsSync(BASE_PATH)) return []
  const ids = new Set()
  fs.readdirSync(BASE_PATH).forEach(f => {
    const meta = getMeta(f)
    if (meta && meta.owner) ids.add(meta.owner)
  })
  return [...ids]
}

function isOwner(msg) {
  const chatId  = typeof msg === 'object' ? msg.chat.id : msg
  const username = typeof msg === 'object' && msg.from ? msg.from.username : null
  if (OWNER_ID && String(chatId) === String(OWNER_ID)) return true
  if (username && username.toLowerCase() === OWNER_USERNAME.toLowerCase()) return true
  return false
}

// ─── /updateWarn ─────────────────────────────
// Uso: /updateWarn Texto do aviso aqui

bot.onText(/^\/updateWarn (.+)/s, async msg => {
  const chatId = msg.chat.id

  if (!isOwner(msg)) {
    return bot.sendMessage(chatId,
      `❌ *Sem permissão.*\n\nEste comando é exclusivo do dono do sistema.`,
      { parse_mode: "Markdown" }
    )
  }

  const texto = msg.text.replace(/^\/updateWarn\s+/i, "").trim()
  if (!texto) {
    return bot.sendMessage(chatId,
      `⚠️ *Uso correto:*\n\n/updateWarn Seu texto aqui`,
      { parse_mode: "Markdown" }
    )
  }

  const users = getAllUsers()
  if (!users.length) {
    return bot.sendMessage(chatId, "📭 Nenhum usuário cadastrado ainda.")
  }

  const statusMsg = await bot.sendMessage(chatId,
    `📢 *Enviando aviso para ${users.length} usuário(s)...*`,
    { parse_mode: "Markdown" }
  )

  let enviados = 0
  let falhas = 0

  for (const uid of users) {
    try {
      await bot.sendMessage(uid,
        `📢 *Aviso do Sistema ARES HOST*\n\n${texto}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Aceito", callback_data: `warn_aceito:${Date.now()}` }
            ]]
          }
        }
      )
      enviados++
      // Pequeno delay pra não tomar flood do Telegram
      await new Promise(r => setTimeout(r, 100))
    } catch {
      falhas++
    }
  }

  bot.editMessageText(
    `✅ *Aviso enviado!*\n\n` +
    `👥 Usuários: *${users.length}*\n` +
    `📨 Enviados: *${enviados}*\n` +
    `❌ Falhas: *${falhas}*\n\n` +
    `📝 *Mensagem:*\n${texto}`,
    {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: "Markdown"
    }
  )
})

bot.onText(/^\/limpeza$/, async msg => {
  const chatId = msg.chat.id
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Sem permissão.")

  const bots = fs.existsSync(BASE_PATH)
    ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads")
    : []

  let freed = 0
  let totalMB = 0

  for (const botId of bots) {
    if (activeBots[botId]) continue // pula bots rodando
    const nm = path.join(BASE_PATH, botId, "node_modules")
    if (fs.existsSync(nm)) {
      try {
        // Calcula tamanho antes de apagar
        const { execSync } = require("child_process")
        try {
          const du = execSync(`du -sm ${nm}`).toString()
          totalMB += parseFloat(du.split("	")[0]) || 0
        } catch {}
        fs.rmSync(nm, { recursive: true, force: true })
        freed++
      } catch {}
    }
  }

  bot.sendMessage(chatId,
    `🧹 *Limpeza concluída!*\n\n` +
    `🗑️ node_modules removidos: *${freed}* bot(s)\n` +
    `💾 Espaço liberado: ~*${totalMB.toFixed(0)} MB*\n\n` +
    `_Bots em execução não foram afetados._`,
    { parse_mode: "Markdown" }
  )
})

bot.onText(/^\/exportar$/, async msg => {
  const chatId = msg.chat.id
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Sem permissão.")

  const bots = fs.existsSync(BASE_PATH)
    ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads")
    : []

  if (!bots.length) return bot.sendMessage(chatId, "📭 Nenhum bot para exportar.")

  const statusMsg = await bot.sendMessage(chatId,
    `⏳ Exportando *${bots.length}* bot(s)...`,
    { parse_mode: "Markdown" }
  )

  const zipPath = path.join(os.tmpdir(), `ares_backup_${Date.now()}.zip`)

  execFile("zip", ["-r", zipPath, "."], { cwd: BASE_PATH }, async (err) => {
    if (err) {
      return bot.editMessageText("❌ Erro ao criar backup: " + err.message, {
        chat_id: chatId, message_id: statusMsg.message_id
      })
    }

    const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)

    try {
      await bot.editMessageText(
        `✅ Backup gerado (${sizeMB} MB), enviando...`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      )
      await bot.sendDocument(chatId, zipPath, {
        caption:
          `📦 *ARES Backup*\n` +
          `🤖 ${bots.length} bot(s) exportados\n` +
          `💾 ${sizeMB} MB\n\n` +
          `Para restaurar na nova conta: use /importar e envie este arquivo.`,
        parse_mode: "Markdown"
      })
    } catch (e) {
      bot.sendMessage(chatId, "❌ Erro ao enviar arquivo: " + e.message)
    } finally {
      try { fs.unlinkSync(zipPath) } catch {}
    }
  })
})

// Aguarda ZIP de importação
const importPending = {}

bot.onText(/^\/importar$/, async msg => {
  const chatId = msg.chat.id
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Sem permissão.")
  importPending[chatId] = true
  bot.sendMessage(chatId,
    `📥 *Importar Backup*\n\n` +
    `Envie agora o arquivo .zip gerado pelo /exportar.\n\n` +
    `⚠️ Bots que já existem aqui *não* serão sobrescritos.`,
    { parse_mode: "Markdown" }
  )
})

// Handler de documento — verifica se é importação pendente
const _origDocHandler = []
bot.on("document", async msg => {
  const chatId = msg.chat.id
  if (!importPending[chatId]) return  // outros handlers cuidam do resto

  if (!msg.document.file_name.toLowerCase().endsWith(".zip")) {
    return bot.sendMessage(chatId, "❌ Envie um arquivo .zip gerado pelo /exportar.")
  }

  delete importPending[chatId]

  const statusMsg = await bot.sendMessage(chatId, "⏳ Processando backup...", { parse_mode: "Markdown" })

  const tmpZip = path.join(os.tmpdir(), `ares_import_${Date.now()}.zip`)
  const tmpDir = path.join(os.tmpdir(), `ares_import_${Date.now()}`)

  try {
    // Download do arquivo
    const fileInfo = await bot.getFile(msg.document.file_id)
    const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
    await downloadFile(fileUrl, tmpZip)

    // Extrai para pasta temp
    fs.mkdirSync(tmpDir, { recursive: true })
    await new Promise((resolve, reject) => {
      fs.createReadStream(tmpZip)
        .pipe(unzipper.Extract({ path: tmpDir }))
        .on("close", resolve)
        .on("error", reject)
    })

    // Copia bots que não existem ainda
    const entries = fs.readdirSync(tmpDir)
    let restored = 0, skipped = 0

    for (const name of entries) {
      if (name === "_uploads") continue
      const src  = path.join(tmpDir, name)
      const dest = path.join(BASE_PATH, name)
      if (!fs.statSync(src).isDirectory()) continue

      if (fs.existsSync(dest)) { skipped++; continue }

      // Copia pasta do bot
      fs.mkdirSync(dest, { recursive: true })
      const subEntries = fs.readdirSync(src)
      for (const f of subEntries) {
        execFile("cp", ["-r", path.join(src, f), dest])
      }
      restored++
    }

    await bot.editMessageText(
      `✅ *Importação concluída!*\n\n` +
      `📦 Restaurados: *${restored}* bot(s)\n` +
      `⏭️ Ignorados (já existiam): *${skipped}*\n\n` +
      `Iniciando bots restaurados...`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    )

    // Lança todos os bots que ainda não estão ativos
    const allBots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads")
    allBots.forEach((botId, i) => {
      if (!activeBots[botId]) {
        setTimeout(() => spawnBot(botId, path.join(BASE_PATH, botId)), i * 1500)
      }
    })

  } catch (e) {
    bot.editMessageText("❌ Erro na importação: " + e.message, {
      chat_id: chatId, message_id: statusMsg.message_id
    })
  } finally {
    try { fs.unlinkSync(tmpZip) } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
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

  // ── Aceite de aviso
  if (action === "warn_aceito") {
    // Só remove o botão e manda mensagem separada de confirmação — não mexe no texto original
    bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: msgId }
    ).catch(() => {})
    return bot.deleteMessage(chatId, msgId).catch(() => {})
  }

  // ── Termos: toggle checkbox
  if (action === "termo_check") {
    const nowChecked = id === "1"
    termoCheck[chatId] = nowChecked
    return editTermos(chatId, msgId, nowChecked)
  }

  // ── Termos: confirmar
  if (action === "termo_confirmar") {
    if (!termoCheck[chatId]) {
      return bot.answerCallbackQuery(query.id, {
        text: "⚠️ Marque a caixa de confirmação primeiro!",
        show_alert: true
      })
    }
    saveAccepted(chatId)
    delete termoCheck[chatId]
    bot.deleteMessage(chatId, msgId).catch(() => {})
    const s = getStats(chatId)
    return bot.sendMessage(chatId,
      `✅ *Termos aceitos! Bem-vindo ao ARES HOST.*\n\n` +
      `🚀 *ARES HOST*\n\n` +
      `🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
            [{ text: "🎨 Criar Bot Visual", callback_data: "menu_builder" }],
            [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
            [{ text: "📊 Estatisticas", callback_data: "menu_stats" }]
          ]
        }
      }
    )
  }

  // ── Home
  if (action === "menu_home") {
    const s = getStats(chatId)
    return bot.editMessageText(
      `🚀 *ARES HOST*\n\n` +
      `🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
            [{ text: "🎨 Criar Bot Visual", callback_data: "menu_builder" }],
            [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
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

  // ── Builder Visual
  if (action === "menu_builder") {
    const sess = genWebSession(chatId)
    const url  = `${DOMAIN}/builder?s=${sess}`
    return bot.editMessageText(
      `🎨 *ARES BUILDER - Criar Bot Visual*\n\n` +
      `Crie seu bot WhatsApp arrastando e soltando blocos, sem precisar escrever código.\n\n` +
      `📱 *Blocos disponíveis:*\n` +
      `• Mensagens automáticas\n` +
      `• Comandos personalizados\n` +
      `• Respostas com botões\n` +
      `• Listas interativas\n` +
      `• Menu com categorias\n` +
      `• E muito mais!\n\n` +
      `Clique no botão abaixo para abrir o editor:`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎨 Abrir ARES BUILDER", url }],
            [{ text: "⬅️ Voltar", callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  // ── Lista de Bots
  if (action === "menu_list") {
    const folders = getUserBots(chatId)
    const s = getStats(chatId)

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
    const s = getStats(chatId)
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
  if (["manage","stop","start","restart","delete_bot"].includes(action) && id) {
    if (getOwner(id) && getOwner(id) !== String(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: "❌ Esse bot não é seu!", show_alert: true })
    }
  }

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
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "📁 Arquivos / Editor", url: `${DOMAIN}/files/${id}?s=${genWebSession(chatId)}` }],
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
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
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
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
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
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
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

// ── ARES BUILDER ─────────────────────────────
app.get("/builder", (req, res) => {
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).send("Acesso negado. Abra pelo Telegram.")
  
  // HTML do builder visual
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ARES BUILDER - Criar Bot WhatsApp</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            height: 100vh;
            overflow: hidden;
        }

        #app {
            display: flex;
            height: 100vh;
        }

        /* Sidebar - Blocos disponíveis */
        #sidebar {
            width: 280px;
            background: #111;
            border-right: 1px solid #222;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .sidebar-header {
            padding: 20px;
            border-bottom: 1px solid #222;
        }

        .sidebar-header h2 {
            color: #0f0;
            font-size: 18px;
            margin-bottom: 5px;
        }

        .sidebar-header p {
            color: #666;
            font-size: 12px;
        }

        .blocks-panel {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
        }

        .block-category {
            margin-bottom: 20px;
        }

        .category-title {
            color: #888;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 10px;
        }

        .block-item {
            background: #1a1a1a;
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 8px;
            cursor: move;
            transition: all 0.2s;
            user-select: none;
        }

        .block-item:hover {
            border-color: #0f0;
            background: #1f1f1f;
            transform: translateX(5px);
        }

        .block-item.dragging {
            opacity: 0.5;
            transform: scale(0.95);
        }

        .block-icon {
            font-size: 20px;
            margin-bottom: 5px;
        }

        .block-name {
            font-weight: 600;
            font-size: 14px;
            margin-bottom: 3px;
        }

        .block-desc {
            font-size: 11px;
            color: #888;
        }

        /* Área principal - Canvas */
        #canvas-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            background: #0d0d0d;
        }

        .canvas-header {
            padding: 15px 20px;
            background: #111;
            border-bottom: 1px solid #222;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .bot-info {
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .bot-name-input {
            background: #1a1a1a;
            border: 1px solid #2a2a2a;
            border-radius: 6px;
            padding: 8px 12px;
            color: #fff;
            font-size: 14px;
            width: 200px;
        }

        .bot-name-input:focus {
            outline: none;
            border-color: #0f0;
        }

        .canvas-actions {
            display: flex;
            gap: 10px;
        }

        .btn {
            padding: 8px 16px;
            border-radius: 6px;
            border: none;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .btn:hover {
            opacity: 0.8;
        }

        .btn-primary {
            background: #0f0;
            color: #000;
        }

        .btn-secondary {
            background: #2a2a2a;
            color: #fff;
        }

        .btn-danger {
            background: #f44;
            color: #fff;
        }

        #canvas {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            background: #0d0d0d;
        }

        .flow-item {
            background: #1a1a1a;
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            margin-bottom: 15px;
            position: relative;
            transition: all 0.2s;
        }

        .flow-item:hover {
            border-color: #0f0;
            box-shadow: 0 0 20px rgba(0,255,0,0.1);
        }

        .flow-item.selected {
            border-color: #0f0;
            box-shadow: 0 0 30px rgba(0,255,0,0.2);
        }

        .flow-header {
            padding: 15px;
            cursor: move;
            background: #1f1f1f;
            border-radius: 8px 8px 0 0;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid #2a2a2a;
        }

        .flow-title {
            display: flex;
            align-items: center;
            gap: 10px;
            font-weight: 600;
        }

        .flow-actions {
            display: flex;
            gap: 5px;
        }

        .flow-action-btn {
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            padding: 5px;
            border-radius: 4px;
            font-size: 14px;
        }

        .flow-action-btn:hover {
            background: #333;
            color: #fff;
        }

        .flow-content {
            padding: 15px;
        }

        .config-field {
            margin-bottom: 12px;
        }

        .config-field label {
            display: block;
            font-size: 12px;
            color: #888;
            margin-bottom: 5px;
        }

        .config-field input,
        .config-field textarea,
        .config-field select {
            width: 100%;
            background: #2a2a2a;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 8px;
            color: #fff;
            font-size: 13px;
        }

        .config-field textarea {
            min-height: 80px;
            resize: vertical;
        }

        .config-field input:focus,
        .config-field textarea:focus,
        .config-field select:focus {
            outline: none;
            border-color: #0f0;
        }

        /* Loading overlay */
        #loading {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 9999;
        }

        #loading.show {
            display: flex;
        }

        .loading-content {
            background: #1a1a1a;
            padding: 30px;
            border-radius: 12px;
            text-align: center;
        }

        .spinner {
            border: 4px solid #333;
            border-top: 4px solid #0f0;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 15px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div id="app">
        <!-- Sidebar com blocos -->
        <div id="sidebar">
            <div class="sidebar-header">
                <h2>🎨 ARES BUILDER</h2>
                <p>Arraste os blocos para criar seu bot</p>
            </div>
            <div class="blocks-panel" id="blocks-panel">
                <!-- Mensagens -->
                <div class="block-category">
                    <div class="category-title">📨 Mensagens</div>
                    <div class="block-item" draggable="true" data-type="text" data-icon="💬" data-name="Texto Simples">
                        <div class="block-icon">💬</div>
                        <div class="block-name">Texto Simples</div>
                        <div class="block-desc">Envia uma mensagem de texto</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="image" data-icon="🖼️" data-name="Imagem">
                        <div class="block-icon">🖼️</div>
                        <div class="block-name">Imagem</div>
                        <div class="block-desc">Envia uma imagem com legenda</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="audio" data-icon="🎵" data-name="Áudio">
                        <div class="block-icon">🎵</div>
                        <div class="block-name">Áudio</div>
                        <div class="block-desc">Envia um áudio ou música</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="video" data-icon="🎥" data-name="Vídeo">
                        <div class="block-icon">🎥</div>
                        <div class="block-name">Vídeo</div>
                        <div class="block-desc">Envia um vídeo</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="document" data-icon="📎" data-name="Documento">
                        <div class="block-icon">📎</div>
                        <div class="block-name">Documento</div>
                        <div class="block-desc">Envia arquivo PDF, ZIP, etc</div>
                    </div>
                </div>

                <!-- Interatividade -->
                <div class="block-category">
                    <div class="category-title">🎮 Interatividade</div>
                    <div class="block-item" draggable="true" data-type="button" data-icon="🔘" data-name="Botões">
                        <div class="block-icon">🔘</div>
                        <div class="block-name">Botões</div>
                        <div class="block-desc">Botões interativos</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="list" data-icon="📋" data-name="Lista">
                        <div class="block-icon">📋</div>
                        <div class="block-name">Lista Interativa</div>
                        <div class="block-desc">Menu com categorias e itens</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="menu" data-icon="📑" data-name="Menu">
                        <div class="block-icon">📑</div>
                        <div class="block-name">Menu de Opções</div>
                        <div class="block-desc">Menu simples com números</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="poll" data-icon="📊" data-name="Enquete">
                        <div class="block-icon">📊</div>
                        <div class="block-name">Enquete</div>
                        <div class="block-desc">Votação com múltiplas opções</div>
                    </div>
                </div>

                <!-- Lógica -->
                <div class="block-category">
                    <div class="category-title">⚙️ Lógica</div>
                    <div class="block-item" draggable="true" data-type="condition" data-icon="🔄" data-name="Condição">
                        <div class="block-icon">🔄</div>
                        <div class="block-name">Condição</div>
                        <div class="block-desc">If/else baseado na resposta</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="variable" data-icon="📌" data-name="Variável">
                        <div class="block-icon">📌</div>
                        <div class="block-name">Variável</div>
                        <div class="block-desc">Salvar informações do usuário</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="delay" data-icon="⏰" data-name="Atraso">
                        <div class="block-icon">⏰</div>
                        <div class="block-name">Atraso</div>
                        <div class="block-desc">Esperar antes de continuar</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="api" data-icon="🌐" data-name="API">
                        <div class="block-icon">🌐</div>
                        <div class="block-name">Requisição API</div>
                        <div class="block-desc">Buscar dados externos</div>
                    </div>
                </div>

                <!-- Ações -->
                <div class="block-category">
                    <div class="category-title">🎯 Ações</div>
                    <div class="block-item" draggable="true" data-type="command" data-icon="⚡" data-name="Comando">
                        <div class="block-icon">⚡</div>
                        <div class="block-name">Comando</div>
                        <div class="block-desc">Resposta a comandos /start, /menu</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="group" data-icon="👥" data-name="Grupo">
                        <div class="block-icon">👥</div>
                        <div class="block-name">Ações em Grupo</div>
                        <div class="block-desc">Adicionar/remover de grupos</div>
                    </div>
                    <div class="block-item" draggable="true" data-type="schedule" data-icon="📅" data-name="Agendado">
                        <div class="block-icon">📅</div>
                        <div class="block-name">Mensagem Agendada</div>
                        <div class="block-desc">Enviar em horário específico</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Área principal -->
        <div id="canvas-area">
            <div class="canvas-header">
                <div class="bot-info">
                    <input type="text" class="bot-name-input" id="botName" placeholder="Nome do bot" value="meu_bot">
                </div>
                <div class="canvas-actions">
                    <button class="btn btn-secondary" onclick="clearCanvas()">🗑️ Limpar</button>
                    <button class="btn btn-primary" onclick="generateBot()">🚀 Gerar Bot</button>
                </div>
            </div>
            <div id="canvas" ondragover="allowDrop(event)" ondrop="drop(event)"></div>
        </div>
    </div>

    <!-- Loading -->
    <div id="loading">
        <div class="loading-content">
            <div class="spinner"></div>
            <p>Gerando seu bot...</p>
        </div>
    </div>

    <script>
        const blocks = []
        let selectedBlock = null
        let dragSource = null

        // Configurar drag dos blocos
        document.querySelectorAll('.block-item').forEach(block => {
            block.addEventListener('dragstart', handleDragStart)
            block.addEventListener('dragend', handleDragEnd)
        })

        function handleDragStart(e) {
            const type = e.target.dataset.type
            const icon = e.target.dataset.icon
            const name = e.target.dataset.name
            
            dragSource = {
                type,
                icon,
                name
            }
            
            e.target.classList.add('dragging')
            e.dataTransfer.setData('text/plain', JSON.stringify(dragSource))
        }

        function handleDragEnd(e) {
            e.target.classList.remove('dragging')
            dragSource = null
        }

        function allowDrop(e) {
            e.preventDefault()
        }

        function drop(e) {
            e.preventDefault()
            const data = e.dataTransfer.getData('text/plain')
            if (!data) return

            const source = JSON.parse(data)
            
            // Criar novo bloco
            const block = {
                id: Date.now() + Math.random().toString(36).substr(2, 9),
                type: source.type,
                icon: source.icon,
                name: source.name,
                config: getDefaultConfig(source.type),
                position: { y: blocks.length * 10 }
            }
            
            blocks.push(block)
            renderCanvas()
        }

        function getDefaultConfig(type) {
            const configs = {
                text: { 
                    message: 'Olá! Como posso ajudar?',
                    delay: 0
                },
                image: {
                    url: 'https://exemplo.com/imagem.jpg',
                    caption: 'Veja esta imagem!'
                },
                button: {
                    text: 'Escolha uma opção:',
                    buttons: ['Opção 1', 'Opção 2', 'Opção 3']
                },
                list: {
                    title: 'Menu',
                    text: 'Selecione uma opção:',
                    buttonText: 'Ver opções',
                    sections: [{
                        title: 'Categoria 1',
                        items: [
                            { id: '1', title: 'Item 1' },
                            { id: '2', title: 'Item 2' }
                        ]
                    }]
                },
                condition: {
                    variable: 'resposta',
                    operator: '==',
                    value: 'sim',
                    then: 'Continuar',
                    else: 'Finalizar'
                },
                command: {
                    command: 'start',
                    response: 'Bem-vindo ao bot!'
                },
                delay: {
                    seconds: 5
                },
                api: {
                    url: 'https://api.exemplo.com/data',
                    method: 'GET',
                    headers: {}
                },
                variable: {
                    name: 'nome',
                    value: '{{mensagem}}'
                }
            }
            
            return configs[type] || {}
        }

        function renderCanvas() {
            const canvas = document.getElementById('canvas')
            canvas.innerHTML = ''
            
            blocks.forEach((block, index) => {
                const blockEl = document.createElement('div')
                blockEl.className = 'flow-item' + (selectedBlock === block.id ? ' selected' : '')
                blockEl.id = 'block-' + block.id
                
                // Header
                const header = document.createElement('div')
                header.className = 'flow-header'
                header.innerHTML = \`
                    <div class="flow-title">
                        <span>\${block.icon}</span>
                        <span>\${block.name}</span>
                    </div>
                    <div class="flow-actions">
                        <button class="flow-action-btn" onclick="selectBlock('\${block.id}')">✏️</button>
                        <button class="flow-action-btn" onclick="duplicateBlock('\${block.id}')">📋</button>
                        <button class="flow-action-btn" onclick="deleteBlock('\${block.id}')">🗑️</button>
                    </div>
                \`
                
                // Content
                const content = document.createElement('div')
                content.className = 'flow-content'
                content.innerHTML = renderBlockConfig(block)
                
                blockEl.appendChild(header)
                blockEl.appendChild(content)
                canvas.appendChild(blockEl)
            })
        }

        function renderBlockConfig(block) {
            switch(block.type) {
                case 'text':
                    return \`
                        <div class="config-field">
                            <label>Mensagem:</label>
                            <textarea onchange="updateConfig('\${block.id}', 'message', this.value)">\${block.config.message}</textarea>
                        </div>
                        <div class="config-field">
                            <label>Delay (segundos):</label>
                            <input type="number" value="\${block.config.delay}" onchange="updateConfig('\${block.id}', 'delay', this.value)">
                        </div>
                    \`
                case 'button':
                    return \`
                        <div class="config-field">
                            <label>Texto:</label>
                            <input type="text" value="\${block.config.text}" onchange="updateConfig('\${block.id}', 'text', this.value)">
                        </div>
                        <div class="config-field">
                            <label>Botões (um por linha):</label>
                            <textarea onchange="updateConfig('\${block.id}', 'buttons', this.value.split('\\n'))">\${block.config.buttons.join('\\n')}</textarea>
                        </div>
                    \`
                case 'command':
                    return \`
                        <div class="config-field">
                            <label>Comando (sem /):</label>
                            <input type="text" value="\${block.config.command}" onchange="updateConfig('\${block.id}', 'command', this.value)">
                        </div>
                        <div class="config-field">
                            <label>Resposta:</label>
                            <textarea onchange="updateConfig('\${block.id}', 'response', this.value)">\${block.config.response}</textarea>
                        </div>
                    \`
                case 'delay':
                    return \`
                        <div class="config-field">
                            <label>Segundos:</label>
                            <input type="number" value="\${block.config.seconds}" onchange="updateConfig('\${block.id}', 'seconds', parseInt(this.value))">
                        </div>
                    \`
                case 'variable':
                    return \`
                        <div class="config-field">
                            <label>Nome da variável:</label>
                            <input type="text" value="\${block.config.name}" onchange="updateConfig('\${block.id}', 'name', this.value)">
                        </div>
                        <div class="config-field">
                            <label>Valor (use {{mensagem}}):</label>
                            <input type="text" value="\${block.config.value}" onchange="updateConfig('\${block.id}', 'value', this.value)">
                        </div>
                    \`
                default:
                    return '<p>Configurações básicas</p>'
            }
        }

        function updateConfig(blockId, key, value) {
            const block = blocks.find(b => b.id === blockId)
            if (block) {
                block.config[key] = value
            }
        }

        function selectBlock(blockId) {
            selectedBlock = blockId
            renderCanvas()
        }

        function duplicateBlock(blockId) {
            const original = blocks.find(b => b.id === blockId)
            if (original) {
                const copy = JSON.parse(JSON.stringify(original))
                copy.id = Date.now() + Math.random().toString(36).substr(2, 9)
                blocks.splice(blocks.indexOf(original) + 1, 0, copy)
                renderCanvas()
            }
        }

        function deleteBlock(blockId) {
            const index = blocks.findIndex(b => b.id === blockId)
            if (index > -1) {
                blocks.splice(index, 1)
                if (selectedBlock === blockId) selectedBlock = null
                renderCanvas()
            }
        }

        function clearCanvas() {
            if (confirm('Limpar todo o fluxo?')) {
                blocks.length = 0
                selectedBlock = null
                renderCanvas()
            }
        }

        async function generateBot() {
            const botName = document.getElementById('botName').value.trim()
            if (!botName) {
                alert('Digite um nome para o bot')
                return
            }

            if (blocks.length === 0) {
                alert('Adicione pelo menos um bloco ao fluxo')
                return
            }

            document.getElementById('loading').classList.add('show')

            try {
                // Gerar código do bot baseado nos blocos
                const code = generateBotCode(botName, blocks)
                
                // Criar arquivo ZIP com o código
                const zip = await createZip(code)
                
                // Enviar para o servidor
                const formData = new FormData()
                formData.append('file', zip, 'bot.zip')
                
                const response = await fetch('/builder-deploy?name=' + encodeURIComponent(botName) + '&s=${req.query.s}', {
                    method: 'POST',
                    body: formData
                })

                const result = await response.json()
                
                if (result.ok) {
                    alert('✅ Bot criado com sucesso!\n\nAcesse o terminal para ver o status.')
                    window.location.href = result.manageUrl
                } else {
                    alert('❌ Erro: ' + result.error)
                }
            } catch (err) {
                alert('❌ Erro ao gerar bot: ' + err.message)
            } finally {
                document.getElementById('loading').classList.remove('show')
            }
        }

        function generateBotCode(name, blocks) {
            // Gerar código JavaScript do bot baseado nos blocos
            let code = \`// Bot WhatsApp gerado pelo ARES BUILDER
// Nome: \${name}
// Data: \${new Date().toLocaleString()}

const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
})

client.on('qr', qr => {
    console.log('QR Code gerado! Escaneie com o WhatsApp')
    qrcode.generate(qr, { small: true })
})

client.on('ready', () => {
    console.log('✅ Bot \${name} está online!')
})

// Armazenar variáveis dos usuários
const userData = new Map()

\`

            // Adicionar handlers baseados nos blocos
            blocks.forEach(block => {
                switch(block.type) {
                    case 'text':
                        code += \`
// Mensagem automática
client.on('message', async message => {
    if (message.body.toLowerCase() === 'oi' || message.body.toLowerCase() === 'olá') {
        await message.reply('\${block.config.message}')
    }
})

\`
                        break
                    case 'button':
                        code += \`
// Botões interativos
client.on('message', async message => {
    if (message.body.toLowerCase() === 'menu') {
        const buttons = \${JSON.stringify(block.config.buttons)}
        let reply = '\${block.config.text}\\n\\n'
        buttons.forEach((btn, i) => {
            reply += \`\${i+1}. \${btn}\\n\`
        })
        await message.reply(reply)
    }
})

\`
                        break
                    case 'command':
                        if (block.config.command === 'start') {
                            code += \`
// Comando /start
client.on('message', async message => {
    if (message.body === '!start' || message.body === '/start') {
        await message.reply('\${block.config.response}')
    }
})

\`
                        }
                        break
                    case 'variable':
                        code += \`
// Salvar \${block.config.name}
client.on('message', async message => {
    const userId = message.from
    if (!userData.has(userId)) {
        userData.set(userId, {})
    }
    const userVars = userData.get(userId)
    userVars['\${block.config.name}'] = message.body
    userData.set(userId, userVars)
})

\`
                        break
                }
            })

            code += \`
// Iniciar o cliente
client.initialize()

console.log('🤖 Bot \${name} iniciado!')
\`

            return code
        }

        async function createZip(code) {
            // Criar estrutura de arquivos
            const files = {
                'index.js': code,
                'package.json': JSON.stringify({
                    name: 'whatsapp-bot',
                    version: '1.0.0',
                    description: 'Bot WhatsApp criado com ARES BUILDER',
                    main: 'index.js',
                    scripts: {
                        start: 'node index.js'
                    },
                    dependencies: {
                        'whatsapp-web.js': '^1.21.0',
                        'qrcode-terminal': '^0.12.0'
                    }
                }, null, 2)
            }

            // Usar JSZip para criar o ZIP
            const JSZip = window.JSZip
            const zip = new JSZip()
            
            Object.entries(files).forEach(([path, content]) => {
                zip.file(path, content)
            })

            return await zip.generateAsync({ type: 'blob' })
        }

        // Inicializar canvas vazio
        renderCanvas()
    </script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
</body>
</html>`)
})

// Deploy de bot criado pelo builder
const builderUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
app.post("/builder-deploy", builderUpload.single("file"), async (req, res) => {
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).json({ error: "Não autenticado" })
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo" })

  const name  = req.query.name || "builder-bot"
  const botId = "bot_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)
  const instancePath = path.join(BASE_PATH, botId)
  fs.mkdirSync(instancePath, { recursive: true })

  const zipPath = path.join(instancePath, "bot.zip")
  fs.writeFileSync(zipPath, req.file.buffer)

  await new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: instancePath }))
      .on("close", resolve)
      .on("error", reject)
  })

  await flattenIfNeeded(instancePath)
  saveMeta(botId, chatId, name)

  const sess = genWebSession(chatId)
  spawnBot(botId, instancePath)

  res.json({
    ok: true,
    botId,
    manageUrl: `${DOMAIN}/terminal/${botId}?s=${sess}`
  })

  // Avisa no Telegram
  bot.sendMessage(chatId,
    `🚀 *Bot hospedado pelo Builder!*\n\n` +
    `🤖 *Nome:* ${name}\n` +
    `🆔 *ID:* \`${botId}\`\n\n` +
    `Instalando dependências e iniciando...`,
    { parse_mode: "Markdown" }
  )
})

app.get("/terminal/:botId", authBot, (req, res) => {
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
const term = new Terminal({cursorBlink:true,fontSize:14,theme:{background:"#000",foreground:"#0f0"},scrollback:10000})
const fitAddon = new FitAddon.FitAddon()
term.loadAddon(fitAddon)
term.open(document.getElementById("terminal"))
fitAddon.fit()
window.addEventListener("resize",()=>fitAddon.fit())
const botId="${req.params.botId}"

// Ao conectar (ou reconectar), pede o histórico completo
socket.on("connect",()=>{
  term.clear()
  socket.emit("request-history",{botId})
})

// Recebe histórico completo (replay do log)
socket.on("history-"+botId,data=>{
  term.write(data)
})

// Recebe logs novos em tempo real
socket.on("log-"+botId,data=>term.write(data))

// Envia input do teclado pro processo
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
  saveMeta(botId, chatId, name)

  const zipPath = path.join(instancePath, "bot.zip")
  fs.renameSync(req.file.path, zipPath)

  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ Criando bot *${name}*...\n\nArquivo recebido via web, extraindo...`,
    { parse_mode: "Markdown" }
  )

  extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)
  res.send("ok")
})

app.get("/logs/:botId", authBot, (req, res) => {
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
app.use("/files", authBot, (req, res, next) => {
  const rawUrl = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/^\/files\/([^/]+)\/?$/)
  if (!m) return next()
  const botId = m[1]
  const token = req.query.s || ""
  const botPath = path.join(BASE_PATH, botId)
  if (!fs.existsSync(botPath)) return res.status(404).send("Bot não encontrado")

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>ARES Editor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--bd:#30363d;--tx:#e6edf3;--tx2:#8b949e;--green:#3fb950;--blue:#58a6ff;--orange:#d29922;--red:#f85149}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#bar{background:var(--bg2);border-bottom:1px solid var(--bd);height:48px;display:flex;align-items:center;padding:0 10px;gap:8px;flex-shrink:0}
.logo{color:var(--green);font-weight:700;font-size:15px}
.chip{background:var(--bg3);border:1px solid var(--bd);border-radius:12px;padding:2px 9px;font-size:11px;color:var(--tx2);font-family:monospace;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bar .sp{flex:1}
.tbtn{padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;border:1px solid var(--bd);background:var(--bg3);color:var(--tx);white-space:nowrap;display:none;align-items:center;gap:4px}
.tbtn:active{opacity:.7}
.tbtn.g{background:#238636;border-color:#238636;color:#fff}
.tbtn.r{border-color:var(--red);color:var(--red)}
#btn-menu{background:none;border:none;color:var(--tx2);font-size:22px;padding:4px 6px;cursor:pointer;line-height:1;display:none}
#layout{display:flex;flex:1;overflow:hidden;height:calc(100vh - 48px - 22px)}
#side{width:260px;background:var(--bg2);border-right:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0;transition:transform .25s;z-index:5}
#side-top{padding:8px 10px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
#side-top .stit{font-size:11px;color:var(--tx2);text-transform:uppercase;letter-spacing:.05em;font-weight:700}
#side-top .sbtns{display:flex;gap:2px}
.ibtn{background:none;border:none;color:var(--tx2);cursor:pointer;padding:5px 7px;border-radius:5px;font-size:15px;line-height:1}
.ibtn:active{background:var(--bg3);color:var(--tx)}
#tree{flex:1;overflow-y:auto;padding:4px 0;-webkit-overflow-scrolling:touch}
#tree::-webkit-scrollbar{width:3px}
#tree::-webkit-scrollbar-thumb{background:var(--bd)}
.row{display:flex;align-items:center;padding:6px;cursor:pointer;border-radius:5px;margin:1px 4px;min-height:36px}
.row:active{background:var(--bg3)}
.row.sel{background:#1f3a5f}
.row .ico{margin-right:6px;font-size:14px;width:18px;text-align:center;flex-shrink:0}
.row .lbl{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.row .lbl.d{color:var(--blue)}
.row .arr{font-size:9px;color:var(--tx2);margin-right:4px;width:10px;transition:transform .15s;flex-shrink:0}
.row .arr.o{transform:rotate(90deg)}
.row .arr.h{opacity:0}
#side-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:4}
#right{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#tabs{background:var(--bg2);border-bottom:1px solid var(--bd);display:flex;overflow-x:auto;flex-shrink:0;min-height:36px}
#tabs::-webkit-scrollbar{height:0}
.tab{display:flex;align-items:center;gap:5px;padding:0 10px;height:36px;border-right:1px solid var(--bd);cursor:pointer;font-size:12px;color:var(--tx2);white-space:nowrap;flex-shrink:0;position:relative}
.tab.on{color:var(--tx);background:var(--bg)}
.tab.on::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--blue)}
.tab .x{opacity:0;font-size:11px;padding:2px 4px;border-radius:3px;line-height:1}
.tab:hover .x,.tab.on .x{opacity:.5}
.tab .x:hover{opacity:1!important;background:var(--bd)}
.tab .dot{width:7px;height:7px;background:var(--orange);border-radius:50%}
#breadcrumb{background:var(--bg);border-bottom:1px solid var(--bd);padding:4px 12px;font-size:11px;color:var(--tx2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#editor{flex:1;overflow:hidden}
#welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--tx2);padding:20px;text-align:center}
#welcome .big{font-size:52px;opacity:.25}
#welcome h2{font-size:16px;color:var(--tx);font-weight:400}
#welcome p{font-size:13px;line-height:1.6;max-width:260px}
#welcome kbd{background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:1px 5px;font-family:monospace;font-size:11px}
#sbar{background:#1f2328;border-top:1px solid var(--bd);height:22px;display:flex;align-items:center;padding:0 12px;gap:14px;font-size:11px;color:var(--tx2);flex-shrink:0}
.s-ok{color:var(--green)}.s-warn{color:var(--orange)}
.ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:999;align-items:flex-end;justify-content:center}
.ov.on{display:flex}
@media(min-width:600px){.ov{align-items:center}}
.box{background:var(--bg2);border:1px solid var(--bd);border-radius:14px 14px 0 0;padding:22px;width:100%;max-width:460px}
@media(min-width:600px){.box{border-radius:12px}}
.box h3{margin-bottom:14px;font-size:15px}
.box input{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--tx);padding:10px 12px;border-radius:8px;font-size:15px;outline:none;font-family:monospace}
.box input:focus{border-color:var(--blue)}
.box .bts{display:flex;gap:8px;margin-top:14px}
.box .bts button{flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;border:1px solid var(--bd)}
.ok-btn{background:var(--green);border-color:var(--green);color:#000}
.cancel-btn{background:var(--bg3);color:var(--tx2)}
.ctx{display:none;position:fixed;background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:4px;z-index:888;min-width:160px;box-shadow:0 8px 28px rgba(0,0,0,.5)}
.ctx.on{display:block}
.ctx-item{padding:9px 14px;cursor:pointer;border-radius:6px;font-size:14px;display:flex;align-items:center;gap:8px}
.ctx-item:active{background:var(--bg3)}
.ctx-item.danger{color:var(--red)}
.ctx-hr{height:1px;background:var(--bd);margin:3px 0}
.toast{position:fixed;bottom:34px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--bg2);border:1px solid var(--bd);padding:10px 20px;border-radius:10px;font-size:13px;z-index:9999;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:90vw;text-align:center}
.toast.on{opacity:1;transform:translateX(-50%)}
.toast.ok{border-color:var(--green);color:var(--green)}
.toast.err{border-color:var(--red);color:var(--red)}
@media(max-width:700px){
  #side{position:fixed;top:48px;left:0;bottom:22px;width:82vw;max-width:300px;transform:translateX(-100%);box-shadow:4px 0 24px rgba(0,0,0,.5)}
  #side.open{transform:translateX(0)}
  #side-overlay.on{display:block}
  #btn-menu{display:block}
  .chip{max-width:90px}
  .tbtn span{display:none}
}
</style>
</head>
<body>
<div id="bar">
  <button id="btn-menu" onclick="toggleSide()">☰</button>
  <span class="logo">⚡</span>
  <span class="chip" title="${botId}">${botId}</span>
  <div class="sp"></div>
  <span id="unsaved" style="display:none;font-size:11px;color:var(--orange);margin-right:2px">●</span>
  <button class="tbtn" id="btn-ren" onclick="doRename()">✏️ <span>Renomear</span></button>
  <button class="tbtn r" id="btn-del" onclick="doDel()">🗑️ <span>Excluir</span></button>
  <button class="tbtn g" id="btn-save" onclick="doSave()">💾 Salvar</button>
</div>
<div id="layout">
  <div id="side-overlay" onclick="closeSide()"></div>
  <div id="side">
    <div id="side-top">
      <span class="stit">Arquivos</span>
      <div class="sbtns">
        <button class="ibtn" title="Novo arquivo" onclick="doNewFile()">📄</button>
        <button class="ibtn" title="Nova pasta" onclick="doNewFolder()">📁</button>
        <button class="ibtn" title="Atualizar" onclick="refreshTree()">↺</button>
      </div>
    </div>
    <div id="tree"><div style="padding:12px;font-size:12px;color:var(--tx2)">Carregando...</div></div>
  </div>
  <div id="right">
    <div id="tabs"></div>
    <div id="breadcrumb">—</div>
    <div id="editor"></div>
    <div id="welcome">
      <div class="big">📂</div>
      <h2>ARES Editor</h2>
      <p>Selecione um arquivo para editar<br><kbd>Ctrl+S</kbd> salva</p>
    </div>
  </div>
</div>
<div id="sbar">
  <span id="sb-lang">—</span>
  <span id="sb-lines">—</span>
  <span id="sb-status" class="s-ok">✓ pronto</span>
</div>
<div class="ov" id="modal">
  <div class="box">
    <h3 id="modal-title">Nome</h3>
    <input id="modal-in" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
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
const BOT_ID="${botId}", TOKEN="${token}", API="/files-api/"+BOT_ID
function apiUrl(action,extra){return API+action+"?s="+TOKEN+(extra?"&"+extra:"")}

let ed=null,currentFile=null,isDirty=false,openDirs=new Set(),treeData=[],tabs=[],models={},modalCb=null,ctxTarget=null

function toggleSide(){document.getElementById("side").classList.toggle("open");document.getElementById("side-overlay").classList.toggle("on")}
function closeSide(){document.getElementById("side").classList.remove("open");document.getElementById("side-overlay").classList.remove("on")}

require(["vs/editor/editor.main"],function(){
  monaco.editor.defineTheme("ares",{base:"vs-dark",inherit:true,
    rules:[{token:"comment",foreground:"8b949e",fontStyle:"italic"},{token:"keyword",foreground:"ff7b72"},{token:"string",foreground:"a5d6ff"},{token:"number",foreground:"79c0ff"}],
    colors:{"editor.background":"#0d1117","editor.foreground":"#e6edf3","editor.lineHighlightBackground":"#161b22","editorLineNumber.foreground":"#484f58","editorLineNumber.activeForeground":"#e6edf3","editor.selectionBackground":"#264f78","editorCursor.foreground":"#58a6ff"}
  })
  ed=monaco.editor.create(document.getElementById("editor"),{theme:"ares",fontSize:14,automaticLayout:true,minimap:{enabled:false},scrollBeyondLastLine:false,wordWrap:"on",padding:{top:10}})
  ed.onDidChangeModelContent(()=>markDirty())
  ed.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,doSave)
  document.getElementById("editor").style.display="none"
  loadTree()
})

function ext(n){return n.includes(".")?n.split(".").pop().toLowerCase():""}
function langIcon(n){const m={js:"🟨",ts:"🔷",jsx:"🟨",tsx:"🔷",json:"🟧",py:"🐍",md:"📝",html:"🌐",css:"🎨",sh:"⚙️",env:"🔑",yml:"📋",yaml:"📋",sql:"🗄️",png:"🖼️",jpg:"🖼️",jpeg:"🖼️",svg:"🖼️",zip:"📦",lock:"🔒"};return m[ext(n)]||"📄"}
function getLang(n){const m={js:"javascript",ts:"typescript",jsx:"javascript",tsx:"typescript",json:"json",py:"python",md:"markdown",sh:"shell",bash:"shell",html:"html",css:"css",scss:"css",yml:"yaml",yaml:"yaml",sql:"sql",xml:"xml",php:"php",rb:"ruby",go:"go",rs:"rust",java:"java",cpp:"cpp",c:"c",h:"c",cs:"csharp",txt:"plaintext",env:"plaintext"};return m[ext(n)]||"plaintext"}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}

function buildRows(items,depth){
  return items.map(item=>{
    const pad=8+depth*14
    if(item.type==="dir"){
      const open=openDirs.has(item.path)
      return \`<div class="row" style="padding-left:\${pad}px" onclick="toggleDir('\${esc(item.path)}')" oncontextmenu="showCtx(event,'\${esc(item.path)}',true)"><span class="arr \${open?"o":""}">▶</span><span class="ico">\${open?"📂":"📁"}</span><span class="lbl d">\${esc(item.name)}</span></div>\`+(open?buildRows(item.children,depth+1):"")
    }
    return \`<div class="row\${currentFile===item.path?" sel":""}" style="padding-left:\${pad+14}px" onclick="openFile('\${esc(item.path)}')" oncontextmenu="showCtx(event,'\${esc(item.path)}',false)"><span class="arr h">▶</span><span class="ico">\${langIcon(item.name)}</span><span class="lbl">\${esc(item.name)}</span></div>\`
  }).join("")
}

function renderTree(){document.getElementById("tree").innerHTML=treeData.length?buildRows(treeData,0):'<div style="padding:12px;font-size:12px;color:var(--tx2)">Pasta vazia</div>'}
function toggleDir(p){openDirs.has(p)?openDirs.delete(p):openDirs.add(p);renderTree()}

async function loadTree(){
  try{
    const r=await fetch(apiUrl("/tree"))
    if(!r.ok){document.getElementById("tree").innerHTML=\`<div style="padding:12px;font-size:12px;color:var(--red)">Erro \${r.status}: acesso negado</div>\`;return}
    treeData=await r.json();renderTree()
  }catch(e){document.getElementById("tree").innerHTML=\`<div style="padding:12px;font-size:12px;color:var(--red)">\${e.message}</div>\`}
}
function refreshTree(){loadTree()}

function renderTabs(){
  document.getElementById("tabs").innerHTML=tabs.map(t=>{
    const name=t.path.split("/").pop(),on=t.path===currentFile?" on":""
    const ind=t.dirty?\`<span class="dot"></span>\`:\`<span class="x" onclick="closeTab(event,'\${esc(t.path)}')">✕</span>\`
    return \`<div class="tab\${on}" onclick="switchTo('\${esc(t.path)}')" title="\${esc(t.path)}">\${langIcon(name)} \${esc(name)}\${ind}</div>\`
  }).join("")
}
function switchTo(p){if(p!==currentFile)openFile(p)}
function closeTab(e,p){
  e.stopPropagation()
  const t=tabs.find(x=>x.path===p)
  if(t&&t.dirty&&!confirm("Fechar sem salvar?"))return
  tabs=tabs.filter(x=>x.path!==p)
  if(models[p]){models[p].dispose();delete models[p]}
  if(currentFile===p){tabs.length?openFile(tabs[tabs.length-1].path):clearEditor()}
  renderTabs()
}
function clearEditor(){
  currentFile=null;isDirty=false
  if(ed)ed.setValue("")
  document.getElementById("editor").style.display="none"
  document.getElementById("welcome").style.display="flex"
  document.getElementById("breadcrumb").textContent="—"
  document.getElementById("sb-lang").textContent="—"
  document.getElementById("unsaved").style.display="none"
  ;["btn-save","btn-del","btn-ren"].forEach(id=>document.getElementById(id).style.display="none")
  renderTree()
}

async function openFile(p){
  if(!ed)return
  if(!models[p]){
    const r=await fetch(apiUrl("/read","path="+encodeURIComponent(p)))
    if(!r.ok){toast("Erro ao abrir: "+r.status,"err");return}
    models[p]=monaco.editor.createModel(await r.text(),getLang(p))
    if(!tabs.find(t=>t.path===p))tabs.push({path:p,dirty:false})
  }
  currentFile=p;isDirty=false
  ed.setModel(models[p])
  document.getElementById("editor").style.display="block"
  document.getElementById("welcome").style.display="none"
  document.getElementById("breadcrumb").textContent=p
  document.getElementById("sb-lang").textContent=getLang(p)
  document.getElementById("sb-lines").textContent=ed.getModel().getLineCount()+" linhas"
  ;["btn-save","btn-del","btn-ren"].forEach(id=>{document.getElementById(id).style.display="inline-flex"})
  markDirty(false);renderTree();renderTabs();closeSide();ed.focus()
}

function markDirty(v){
  if(v===false){isDirty=false;document.getElementById("unsaved").style.display="none";const t=tabs.find(x=>x.path===currentFile);if(t)t.dirty=false}
  else if(!isDirty){isDirty=true;document.getElementById("unsaved").style.display="inline";const t=tabs.find(x=>x.path===currentFile);if(t)t.dirty=true}
  renderTabs()
}

async function doSave(){
  if(!currentFile||!ed)return
  const sb=document.getElementById("sb-status");sb.textContent="💾...";sb.className="s-warn"
  try{
    const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:currentFile,content:ed.getValue()})})
    if(r.ok){markDirty(false);sb.textContent="✓ salvo";sb.className="s-ok";toast("✅ Salvo!","ok")}
    else throw new Error(r.status)
  }catch(e){sb.textContent="✗ erro";toast("Erro: "+e.message,"err")}
}

async function doDel(){
  if(!currentFile||!confirm('Excluir "'+currentFile+'"?'))return
  const r=await fetch(apiUrl("/delete"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:currentFile})})
  if(r.ok){toast("🗑️ Excluído!","ok");closeTab({stopPropagation:()=>{}},currentFile);loadTree()}
  else toast("Erro "+r.status,"err")
}

async function doRename(){
  if(!currentFile)return
  const parts=currentFile.split("/")
  openModal("Renomear",parts[parts.length-1],async newName=>{
    const newPath=[...parts.slice(0,-1),newName].join("/")
    const r=await fetch(apiUrl("/rename"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:currentFile,to:newPath})})
    if(r.ok){const t=tabs.find(x=>x.path===currentFile);if(t)t.path=newPath;if(models[currentFile]){models[newPath]=models[currentFile];delete models[currentFile]}currentFile=newPath;await loadTree();openFile(newPath);toast("✅ Renomeado!","ok")}
    else toast("Erro ao renomear","err")
  })
}

function doNewFile(){
  const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
  openModal("Novo arquivo","index.js",async name=>{
    const p=folder?folder+"/"+name:name
    const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p,content:""})})
    if(r.ok){await loadTree();openFile(p);toast("✅ Criado!","ok")}else toast("Erro ao criar","err")
  })
}
function doNewFolder(){
  openModal("Nova pasta","pasta",async name=>{
    const r=await fetch(apiUrl("/mkdir"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:name})})
    if(r.ok){await loadTree();toast("✅ Pasta criada!","ok")}else toast("Erro","err")
  })
}

function showCtx(e,p,isDir){
  e.preventDefault();e.stopPropagation();ctxTarget={path:p,isDir}
  const el=document.getElementById("ctx")
  el.style.left=Math.min(e.clientX,window.innerWidth-170)+"px"
  el.style.top=Math.min(e.clientY,window.innerHeight-100)+"px"
  el.classList.add("on")
}
function closeCtx(){document.getElementById("ctx").classList.remove("on")}
document.addEventListener("click",closeCtx)

function ctxDoRename(){
  closeCtx();if(!ctxTarget)return
  const parts=ctxTarget.path.split("/")
  openModal("Renomear",parts[parts.length-1],async newName=>{
    const newPath=[...parts.slice(0,-1),newName].join("/")
    const r=await fetch(apiUrl("/rename"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:ctxTarget.path,to:newPath})})
    if(r.ok){if(currentFile===ctxTarget.path){const t=tabs.find(x=>x.path===currentFile);if(t)t.path=newPath;if(models[currentFile]){models[newPath]=models[currentFile];delete models[currentFile]}currentFile=newPath}await loadTree();renderTabs();toast("✅ Renomeado!","ok")}
    else toast("Erro ao renomear","err")
  })
}
function ctxDoDel(){
  closeCtx();if(!ctxTarget)return
  if(!confirm('Excluir "'+ctxTarget.path+'"?'))return
  fetch(apiUrl("/delete"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:ctxTarget.path})})
    .then(r=>{if(r.ok){if(!ctxTarget.isDir)closeTab({stopPropagation:()=>{}},ctxTarget.path);loadTree();toast("🗑️ Excluído!","ok")}else toast("Erro","err")})
}

function openModal(title,placeholder,cb){
  modalCb=cb
  document.getElementById("modal-title").textContent=title
  document.getElementById("modal-in").value=""
  document.getElementById("modal-in").placeholder=placeholder
  document.getElementById("modal").classList.add("on")
  setTimeout(()=>document.getElementById("modal-in").focus(),100)
}
function closeModal(){document.getElementById("modal").classList.remove("on");modalCb=null}
function confirmModal(){const v=document.getElementById("modal-in").value.trim();if(!v)return;closeModal();if(modalCb)modalCb(v)}
document.getElementById("modal-in").addEventListener("keydown",e=>{if(e.key==="Enter")confirmModal();if(e.key==="Escape")closeModal()})
document.getElementById("modal").addEventListener("click",e=>{if(e.target===document.getElementById("modal"))closeModal()})

function toast(msg,type){const el=document.getElementById("toast");el.textContent=msg;el.className="toast on "+(type||"");clearTimeout(el._t);el._t=setTimeout(()=>el.className="toast",2500)}
</script>
</body>
</html>`)
})

// ── API de Arquivos
app.use("/files-api", authBot, (req, res, next) => {
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

server.listen(PORT, () => {
  aresBanner()

  // ── Auto-restart: relança todos os bots salvos no disco
  if (fs.existsSync(BASE_PATH)) {
    const bots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads")
    if (bots.length > 0) {
      console.log(`\n♻️  Restaurando ${bots.length} bot(s)...\n`)
      bots.forEach((botId, i) => {
        const instancePath = path.join(BASE_PATH, botId)
        const meta = getMeta(botId)
        const name = meta ? meta.name : botId
        // Pequeno delay escalonado pra não sobrecarregar na subida
        setTimeout(() => {
          console.log(`  ▶ Iniciando: ${name} (${botId})`)
          spawnBot(botId, instancePath)
        }, i * 1500)
      })
    }
  }
})
