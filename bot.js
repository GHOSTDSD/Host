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
const OWNER_ID = process.env.OWNER_ID || ""
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
const uploadTokens = {}
const webSessions = {}
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
    if (f === "_uploads" || f === "_users") return false
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
  const bots = chatId ? getUserBots(chatId) : (fs.existsSync(BASE_PATH) ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users") : [])
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

const MAX_LOG_BYTES = 500 * 1024
function writeLog(botId, instancePath, data) {
  const logPath = path.join(instancePath, "terminal.log")
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
  const env = { ...process.env, PORT: botPort.toString(), NODE_ENV: "production", FORCE_COLOR: "3", TERM: "xterm-256color" }
  aresBanner()
  const start = detectStart(instancePath)
  if (!start) { writeLog(botId, instancePath, "❌ Nenhum start detectado\r\n"); return }
  if (fs.existsSync(path.join(instancePath, "package.json"))) {
    const nm = path.join(instancePath, "node_modules")
    if (fs.existsSync(nm)) { writeLog(botId, instancePath, "🧹 Limpando node_modules...\r\n"); fs.rmSync(nm, { recursive: true, force: true }) }
    writeLog(botId, instancePath, "📦 Instalando dependencias...\r\n")
    const install = pty.spawn(os.platform() === "win32" ? "npm.cmd" : "npm", ["install", "--production", "--prefer-offline"], { name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env })
    install.onData(d => writeLog(botId, instancePath, d))
    install.onExit(() => runInstance(botId, instancePath, botPort, env, start))
  } else {
    runInstance(botId, instancePath, botPort, env, start)
  }
}

function runInstance(botId, instancePath, botPort, env, start) {
  const child = pty.spawn(start.cmd, start.args, { name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env })
  activeBots[botId] = { process: child, port: botPort, path: instancePath }
  child.onData(d => writeLog(botId, instancePath, d))
  child.onExit(() => {
    releasePort(botPort)
    delete activeBots[botId]
    const nm = path.join(instancePath, "node_modules")
    if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true })
    aresBanner()
  })
  aresBanner()
}

io.on("connection", socket => {
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
  `*1. Uso permitido*\nApenas bots legítimos de WhatsApp são permitidos. Bots de spam, golpes ou conteúdo ilegal serão removidos sem aviso.\n\n` +
  `*2. Responsabilidade*\nVocê é totalmente responsável pelo conteúdo e comportamento do seu bot. O ARES HOST não se responsabiliza por danos causados por bots hospedados.\n\n` +
  `*3. Disponibilidade*\nO serviço pode passar por manutenções ou instabilidades. Não garantimos 100% de uptime.\n\n` +
  `*4. Dados*\nOs arquivos do seu bot ficam armazenados em nossos servidores. Mantenha backup dos seus arquivos importantes.\n\n` +
  `*5. Encerramento*\nReservamos o direito de encerrar bots que violem estes termos a qualquer momento.\n\n` +
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

const termoCheck = {}

// ─── Comandos Telegram ────────────────────────

bot.onText(/^\/meuid$/, msg => {
  bot.sendMessage(msg.chat.id,
    `🪪 *Seu Telegram ID:*\n\n\`${msg.chat.id}\`\n\n_Use este ID para configurar o OWNER\\_ID no Railway._`,
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
    `🚀 *ARES HOST*\n\n🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Novo Bot",          callback_data: "menu_new" }],
          [{ text: "🤖 Criar Bot WhatsApp", callback_data: "menu_create_wa" }],
          [{ text: "📂 Meus Bots",          callback_data: "menu_list" }],
          [{ text: "📊 Estatisticas",        callback_data: "menu_stats" }]
        ]
      }
    }
  )
})

// ─── Helpers de download ──────────────────────

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
      if (res.statusCode !== 200) { file.close(); return reject(new Error("HTTP " + res.statusCode)) }
      res.pipe(file)
      file.on("finish", () => { file.close(); resolve() })
      file.on("error", reject)
    }).on("error", reject)
  })
}

function flattenIfNeeded(instancePath) {
  const entries = fs.readdirSync(instancePath).filter(e => e !== "bot.zip")
  if (entries.length === 1) {
    const single = path.join(instancePath, entries[0])
    const stat = fs.statSync(single)
    if (stat.isDirectory()) {
      const subEntries = fs.readdirSync(single)
      for (const file of subEntries) fs.renameSync(path.join(single, file), path.join(instancePath, file))
      fs.rmdirSync(single)
    }
  }
}

function extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg) {
  fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: instancePath }))
    .on("close", () => {
      flattenIfNeeded(instancePath)
      const nm = path.join(instancePath, "node_modules")
      if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true })
      spawnBot(botId, instancePath)
      bot.editMessageText(
        `✅ *Bot criado com sucesso!*\n\n📦 Nome: *${name}*\n🆔 ID: \`${botId}\`\n🟢 Status: *Iniciando...*`,
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
      bot.editMessageText(`❌ Erro ao extrair: ${err.message}`, { chat_id: loadingMsg.chat.id, message_id: loadingMsg.message_id })
    })
}

// ─── Receber ZIP (upload direto) ──────────────

bot.on("document", async msg => {
  if (!msg.document.file_name.toLowerCase().endsWith(".zip")) {
    return bot.sendMessage(msg.chat.id, "⚠️ *Arquivo invalido!*\n\nEnvie um arquivo .zip com o codigo do bot.", { parse_mode: "Markdown" })
  }
  const fileSizeMB = (msg.document.file_size / 1024 / 1024).toFixed(1)
  if (msg.document.file_size > 20 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id,
      `❌ *Arquivo muito grande (${fileSizeMB}MB)*\n\nO Telegram tem limite de 20MB para upload.\n\nEnvie um *link direto* para o ZIP:\n• Google Drive (link publico)\n• GitHub Release\n• Qualquer URL direta para .zip`,
      { parse_mode: "Markdown" }
    )
  }
  userState[msg.chat.id] = { fileId: msg.document.file_id }
  bot.sendMessage(msg.chat.id, `✅ *ZIP recebido* (${fileSizeMB}MB)\n\nAgora envie um *nome* para o bot:\n(ex: meubot, vendas, suporte)`, { parse_mode: "Markdown" })
})

// ─── Receber nome ou link ─────────────────────

bot.on("message", async msg => {
  if (msg.document || msg.text?.startsWith("/")) return
  const chatId = msg.chat.id
  if (!hasAccepted(chatId)) {
    termoCheck[chatId] = false
    return sendTermos(chatId, false)
  }
  const state = userState[chatId]
  if (!state || (!state.fileId && !state.linkUrl)) {
    const text = msg.text?.trim() || ""
    const isLink = /^https?:\/\/.+\.zip(\?.*)?$/i.test(text) || /^https?:\/\//i.test(text)
    if (isLink) {
      userState[chatId] = { linkUrl: text }
      return bot.sendMessage(chatId, "🔗 *Link recebido!*\n\nAgora envie um *nome* para o bot:\n(ex: meubot, vendas, suporte)", { parse_mode: "Markdown" })
    }
    return
  }
  if (state.botName) return
  const name = msg.text.trim().replace(/\s+/g, "_").toLowerCase()
  const botId = generateBotId()
  const instancePath = path.join(BASE_PATH, botId)
  state.botName = name
  state.botId = botId
  if (fs.existsSync(instancePath)) return
  fs.mkdirSync(instancePath, { recursive: true })
  saveMeta(botId, chatId, name)
  const loadingMsg = await bot.sendMessage(chatId, `⏳ Criando bot *${name}*...\n\nBaixando e extraindo arquivos...`, { parse_mode: "Markdown" })
  const zipPath = path.join(instancePath, "bot.zip")
  try {
    if (state.linkUrl) {
      delete userState[chatId]
      await downloadFile(state.linkUrl, zipPath)
      extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)
      return
    }
    delete userState[chatId]
    const file = await bot.getFile(state.fileId)
    await downloadFile(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, zipPath)
    extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)
  } catch (err) {
    bot.editMessageText(`❌ Erro ao baixar: ${err.message}`, { chat_id: loadingMsg.chat.id, message_id: loadingMsg.message_id })
  }
})

// ─── Admin helpers ────────────────────────────

function isAdmin(chatId) { return !ADMIN_ID || String(chatId) === String(ADMIN_ID) }
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
  const chatId  = typeof msg === "object" ? msg.chat.id : msg
  const username = typeof msg === "object" && msg.from ? msg.from.username : null
  if (OWNER_ID && String(chatId) === String(OWNER_ID)) return true
  if (username && username.toLowerCase() === OWNER_USERNAME.toLowerCase()) return true
  return false
}

// ─── /updateWarn ─────────────────────────────

bot.onText(/^\/updateWarn (.+)/s, async msg => {
  const chatId = msg.chat.id
  if (!isOwner(msg)) return bot.sendMessage(chatId, `❌ *Sem permissão.*\n\nEste comando é exclusivo do dono do sistema.`, { parse_mode: "Markdown" })
  const texto = msg.text.replace(/^\/updateWarn\s+/i, "").trim()
  if (!texto) return bot.sendMessage(chatId, `⚠️ *Uso correto:*\n\n/updateWarn Seu texto aqui`, { parse_mode: "Markdown" })
  const users = getAllUsers()
  if (!users.length) return bot.sendMessage(chatId, "📭 Nenhum usuário cadastrado ainda.")
  const statusMsg = await bot.sendMessage(chatId, `📢 *Enviando aviso para ${users.length} usuário(s)...*`, { parse_mode: "Markdown" })
  let enviados = 0, falhas = 0
  for (const uid of users) {
    try {
      await bot.sendMessage(uid, `📢 *Aviso do Sistema ARES HOST*\n\n${texto}`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "✅ Aceito", callback_data: `warn_aceito:${Date.now()}` }]] }
      })
      enviados++
      await new Promise(r => setTimeout(r, 100))
    } catch { falhas++ }
  }
  bot.editMessageText(
    `✅ *Aviso enviado!*\n\n👥 Usuários: *${users.length}*\n📨 Enviados: *${enviados}*\n❌ Falhas: *${falhas}*\n\n📝 *Mensagem:*\n${texto}`,
    { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
  )
})

bot.onText(/^\/limpeza$/, async msg => {
  const chatId = msg.chat.id
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Sem permissão.")
  const bots = fs.existsSync(BASE_PATH) ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users") : []
  let freed = 0, totalMB = 0
  for (const botId of bots) {
    if (activeBots[botId]) continue
    const nm = path.join(BASE_PATH, botId, "node_modules")
    if (fs.existsSync(nm)) {
      try {
        const { execSync } = require("child_process")
        try { const du = execSync(`du -sm ${nm}`).toString(); totalMB += parseFloat(du.split("\t")[0]) || 0 } catch {}
        fs.rmSync(nm, { recursive: true, force: true }); freed++
      } catch {}
    }
  }
  bot.sendMessage(chatId, `🧹 *Limpeza concluída!*\n\n🗑️ node_modules removidos: *${freed}* bot(s)\n💾 Espaço liberado: ~*${totalMB.toFixed(0)} MB*\n\n_Bots em execução não foram afetados._`, { parse_mode: "Markdown" })
})

bot.onText(/^\/exportar$/, async msg => {
  const chatId = msg.chat.id
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Sem permissão.")
  const bots = fs.existsSync(BASE_PATH) ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users") : []
  if (!bots.length) return bot.sendMessage(chatId, "📭 Nenhum bot para exportar.")
  const statusMsg = await bot.sendMessage(chatId, `⏳ Exportando *${bots.length}* bot(s)...`, { parse_mode: "Markdown" })
  const zipPath = path.join(os.tmpdir(), `ares_backup_${Date.now()}.zip`)
  execFile("zip", ["-r", zipPath, "."], { cwd: BASE_PATH }, async (err) => {
    if (err) return bot.editMessageText("❌ Erro ao criar backup: " + err.message, { chat_id: chatId, message_id: statusMsg.message_id })
    const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)
    try {
      await bot.editMessageText(`✅ Backup gerado (${sizeMB} MB), enviando...`, { chat_id: chatId, message_id: statusMsg.message_id })
      await bot.sendDocument(chatId, zipPath, { caption: `📦 *ARES Backup*\n🤖 ${bots.length} bot(s) exportados\n💾 ${sizeMB} MB\n\nPara restaurar: use /importar e envie este arquivo.`, parse_mode: "Markdown" })
    } catch (e) { bot.sendMessage(chatId, "❌ Erro ao enviar arquivo: " + e.message) }
    finally { try { fs.unlinkSync(zipPath) } catch {} }
  })
})

const importPending = {}
bot.onText(/^\/importar$/, async msg => {
  const chatId = msg.chat.id
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Sem permissão.")
  importPending[chatId] = true
  bot.sendMessage(chatId, `📥 *Importar Backup*\n\nEnvie agora o arquivo .zip gerado pelo /exportar.\n\n⚠️ Bots que já existem aqui *não* serão sobrescritos.`, { parse_mode: "Markdown" })
})

bot.on("document", async msg => {
  const chatId = msg.chat.id
  if (!importPending[chatId]) return
  if (!msg.document.file_name.toLowerCase().endsWith(".zip")) return bot.sendMessage(chatId, "❌ Envie um arquivo .zip gerado pelo /exportar.")
  delete importPending[chatId]
  const statusMsg = await bot.sendMessage(chatId, "⏳ Processando backup...", { parse_mode: "Markdown" })
  const tmpZip = path.join(os.tmpdir(), `ares_import_${Date.now()}.zip`)
  const tmpDir = path.join(os.tmpdir(), `ares_import_${Date.now()}`)
  try {
    const fileInfo = await bot.getFile(msg.document.file_id)
    await downloadFile(`https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`, tmpZip)
    fs.mkdirSync(tmpDir, { recursive: true })
    await new Promise((resolve, reject) => {
      fs.createReadStream(tmpZip).pipe(unzipper.Extract({ path: tmpDir })).on("close", resolve).on("error", reject)
    })
    const entries = fs.readdirSync(tmpDir)
    let restored = 0, skipped = 0
    for (const name of entries) {
      if (name === "_uploads" || name === "_users") continue
      const src  = path.join(tmpDir, name)
      const dest = path.join(BASE_PATH, name)
      if (!fs.statSync(src).isDirectory()) continue
      if (fs.existsSync(dest)) { skipped++; continue }
      fs.mkdirSync(dest, { recursive: true })
      const subEntries = fs.readdirSync(src)
      for (const f of subEntries) execFile("cp", ["-r", path.join(src, f), dest])
      restored++
    }
    await bot.editMessageText(
      `✅ *Importação concluída!*\n\n📦 Restaurados: *${restored}* bot(s)\n⏭️ Ignorados (já existiam): *${skipped}*\n\nIniciando bots restaurados...`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    )
    const allBots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users")
    allBots.forEach((botId, i) => {
      if (!activeBots[botId]) setTimeout(() => spawnBot(botId, path.join(BASE_PATH, botId)), i * 1500)
    })
  } catch (e) {
    bot.editMessageText("❌ Erro na importação: " + e.message, { chat_id: chatId, message_id: statusMsg.message_id })
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

  if (action === "warn_aceito") {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
    return bot.deleteMessage(chatId, msgId).catch(() => {})
  }

  if (action === "termo_check") {
    const nowChecked = id === "1"
    termoCheck[chatId] = nowChecked
    return editTermos(chatId, msgId, nowChecked)
  }

  if (action === "termo_confirmar") {
    if (!termoCheck[chatId]) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Marque a caixa de confirmação primeiro!", show_alert: true })
    }
    saveAccepted(chatId)
    delete termoCheck[chatId]
    bot.deleteMessage(chatId, msgId).catch(() => {})
    const s = getStats(chatId)
    return bot.sendMessage(chatId,
      `✅ *Termos aceitos! Bem-vindo ao ARES HOST.*\n\n🚀 *ARES HOST*\n\n🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot",          callback_data: "menu_new" }],
            [{ text: "🤖 Criar Bot WhatsApp", callback_data: "menu_create_wa" }],
            [{ text: "📂 Meus Bots",          callback_data: "menu_list" }],
            [{ text: "📊 Estatisticas",        callback_data: "menu_stats" }]
          ]
        }
      }
    )
  }

  if (action === "menu_home") {
    const s = getStats(chatId)
    return bot.editMessageText(
      `🚀 *ARES HOST*\n\n🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot",          callback_data: "menu_new" }],
            [{ text: "🤖 Criar Bot WhatsApp", callback_data: "menu_create_wa" }],
            [{ text: "📂 Meus Bots",          callback_data: "menu_list" }],
            [{ text: "📊 Estatisticas",        callback_data: "menu_stats" }]
          ]
        }
      }
    )
  }

  // ── 🤖 Criar Bot WhatsApp
  if (action === "menu_create_wa") {
    const sess = genWebSession(chatId)
    const url  = `${DOMAIN}/create-bot?s=${sess}`
    return bot.editMessageText(
      `🤖 *Criar Bot WhatsApp*\n\n` +
      `Crie seu bot de forma visual, sem escrever código.\n\n` +
      `No editor você pode:\n` +
      `• Editar o código gerado direto no navegador\n` +
      `• Configurar respostas automáticas\n` +
      `• Fazer deploy com um clique\n\n` +
      `Clique no botão abaixo para abrir o editor:`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🤖 Abrir Editor de Bot", url }],
            [{ text: "⬅️ Voltar", callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  if (action === "menu_new") {
    return bot.editMessageText(
      "➕ *Novo Bot*\n\nEscolha como enviar o arquivo .zip:\n\n📎 Envie direto aqui (ate 20MB)\n🔗 Envie um link publico do ZIP\n🌐 Use a pagina de upload (sem limite)",
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Gerar link de upload",    callback_data: "gen_upload" }],
            [{ text: "🤖 Criar Bot WhatsApp",       callback_data: "menu_create_wa" }],
            [{ text: "⬅️ Voltar",                   callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  if (action === "menu_list") {
    const folders = getUserBots(chatId)
    const s = getStats(chatId)
    if (folders.length === 0) {
      return bot.editMessageText(
        "📂 *Meus Bots*\n\nNenhum bot hospedado ainda.\nUse Novo Bot para fazer upload!",
        {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
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
      text: `${activeBots[f] ? "🟢" : "🔴"} ${getMeta(f)?.name || f}`,
      callback_data: `manage:${f}`
    }])
    buttons.push([{ text: "⬅️ Voltar", callback_data: "menu_home" }])
    return bot.editMessageText(
      `📂 *Meus Bots*\n\n🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*  |  Total: *${s.total}*\n\nEscolha um bot:`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
    )
  }

  if (action === "menu_stats") {
    const s = getStats(chatId)
    return bot.editMessageText(
      `📊 *Estatisticas*\n\n🤖 Total: *${s.total}*\n🟢 Online: *${s.online}*\n🔴 Offline: *${s.offline}*\n💾 RAM: *${s.ram}MB*\n⏱ Uptime: *${s.uptime}*`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Atualizar", callback_data: "menu_stats" }],
            [{ text: "⬅️ Voltar",    callback_data: "menu_home" }]
          ]
        }
      }
    )
  }

  if (["manage","stop","start","restart","delete_bot"].includes(action) && id) {
    if (getOwner(id) && getOwner(id) !== String(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: "❌ Esse bot não é seu!", show_alert: true })
    }
  }

  if (action === "manage") {
    const isRunning = !!activeBots[id]
    const logPath = path.join(BASE_PATH, id, "terminal.log")
    const logSize = fs.existsSync(logPath) ? (fs.statSync(logPath).size / 1024).toFixed(1) + " KB" : "0 KB"
    const sess = genWebSession(chatId)
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: ${isRunning ? "🟢 Online" : "🔴 Offline"}\nLog: ${logSize}`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal",           url: `${DOMAIN}/terminal/${id}?s=${sess}` }],
            [{ text: "📁 Arquivos / Editor",  url: `${DOMAIN}/files/${id}?s=${sess}` }],
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

  if (action === "gen_upload") {
    const token = require("crypto").randomBytes(16).toString("hex")
    uploadTokens[token] = { chatId, createdAt: Date.now() }
    setTimeout(() => { delete uploadTokens[token] }, 15 * 60 * 1000)
    return bot.editMessageText(
      `🌐 *Link de Upload Gerado*\n\nAcesse a pagina abaixo, escolha o .zip e o nome do bot:\n\n⏳ Expira em *15 minutos*`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Abrir pagina de upload", url: `${DOMAIN}/upload/${token}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_new" }]
          ]
        }
      }
    )
  }

  if (action === "stop") {
    if (activeBots[id]) activeBots[id].process.kill()
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🔴 Offline`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal",   url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "▶️ Iniciar",    callback_data: `start:${id}` }, { text: "🔄 Reiniciar", callback_data: `restart:${id}` }],
            [{ text: "⬅️ Voltar",     callback_data: "menu_list" }]
          ]
        }
      }
    )
  }

  if (action === "start") {
    spawnBot(id, path.join(BASE_PATH, id))
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Iniciando...`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal",   url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "🛑 Parar",       callback_data: `stop:${id}` }, { text: "🔄 Reiniciar", callback_data: `restart:${id}` }],
            [{ text: "⬅️ Voltar",     callback_data: "menu_list" }]
          ]
        }
      }
    )
  }

  if (action === "restart") {
    spawnBot(id, path.join(BASE_PATH, id))
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Reiniciando...`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal",   url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "🛑 Parar",       callback_data: `stop:${id}` }, { text: "🔄 Reiniciar", callback_data: `restart:${id}` }],
            [{ text: "⬅️ Voltar",     callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
})

// ═══════════════════════════════════════════════════════════════
// ─── ROTA: CRIAR BOT WHATSAPP (/create-bot) ──────────────────
// ═══════════════════════════════════════════════════════════════

app.get("/create-bot", (req, res) => {
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).send("Acesso negado. Abra pelo Telegram.")

  const sess = req.query.s

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>ARES — Criar Bot WhatsApp</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#080c10;--bg2:#0d1319;--bg3:#121a22;--bg4:#18222e;
  --bd:#1e2d3d;--bd2:#2a3d52;
  --tx:#e2eaf3;--tx2:#7a9ab8;--tx3:#3a5a78;
  --green:#00e676;--green2:#00c853;
  --blue:#40c4ff;--bluedim:rgba(64,196,255,.1);
  --orange:#ffab40;--red:#ff5252;
  --mono:'JetBrains Mono',monospace;
  --sans:'Syne',sans-serif;
}
html,body{height:100%;background:var(--bg);color:var(--tx);font-family:var(--sans);overflow:hidden}

/* ── TOPBAR ── */
#topbar{
  height:52px;background:var(--bg2);border-bottom:1px solid var(--bd);
  display:flex;align-items:center;padding:0 16px;gap:12px;z-index:20;flex-shrink:0;
}
.logo{font-size:17px;font-weight:800;color:var(--green);letter-spacing:-.02em}
.logo-sub{font-size:11px;color:var(--tx3);font-weight:400}
.sp{flex:1}
.tbtn{
  display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;
  font-size:12px;font-weight:700;cursor:pointer;border:1px solid var(--bd);
  background:var(--bg3);color:var(--tx2);font-family:var(--sans);
  transition:all .15s;white-space:nowrap;
}
.tbtn:hover{color:var(--tx);border-color:var(--bd2)}
.tbtn.green{background:var(--green);border-color:var(--green);color:#000;font-size:13px;padding:8px 18px}
.tbtn.green:hover{background:var(--green2)}
.tbtn.green:disabled{opacity:.4;cursor:not-allowed}

/* ── LAYOUT ── */
#layout{display:flex;height:calc(100vh - 52px)}

/* ── SIDEBAR ESQUERDA — Config ── */
#config-panel{
  width:280px;background:var(--bg2);border-right:1px solid var(--bd);
  display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0;
}
#config-panel::-webkit-scrollbar{width:3px}
#config-panel::-webkit-scrollbar-thumb{background:var(--bd)}
.panel-section{border-bottom:1px solid var(--bd);padding:14px 16px}
.panel-section:last-child{border-bottom:none}
.psec-title{font-size:10px;font-weight:700;color:var(--tx3);letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px}
.field{margin-bottom:10px}
.field:last-child{margin-bottom:0}
.field label{display:block;font-size:11px;color:var(--tx2);font-weight:600;margin-bottom:4px}
.field input,.field textarea,.field select{
  width:100%;background:var(--bg);border:1px solid var(--bd);border-radius:7px;
  padding:8px 10px;color:var(--tx);font-size:12px;font-family:var(--mono);
  outline:none;transition:border .15s;resize:vertical;
}
.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--blue)}
.field textarea{min-height:70px;max-height:200px}
.field select{cursor:pointer}
.hint{font-size:10px;color:var(--tx3);margin-top:3px;line-height:1.4}
.add-resp-btn{
  width:100%;padding:8px;border-radius:7px;border:1px dashed var(--bd2);
  background:transparent;color:var(--tx3);font-size:12px;font-family:var(--sans);
  cursor:pointer;transition:all .15s;margin-top:6px;
}
.add-resp-btn:hover{border-color:var(--green);color:var(--green)}

/* ── EDITOR CENTRAL ── */
#editor-wrap{
  flex:1;display:flex;flex-direction:column;min-width:0;
  background:var(--bg);
}
#editor-tabs{
  display:flex;background:var(--bg2);border-bottom:1px solid var(--bd);
  height:38px;align-items:stretch;flex-shrink:0;
}
.etab{
  display:flex;align-items:center;gap:6px;padding:0 16px;
  font-size:12px;color:var(--tx3);cursor:pointer;border-right:1px solid var(--bd);
  transition:all .15s;font-weight:600;
}
.etab:hover{color:var(--tx2)}
.etab.on{color:var(--tx);background:var(--bg);position:relative}
.etab.on::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--green)}
#code-editor{flex:1;overflow:hidden;position:relative}
#monaco-editor{position:absolute;inset:0}

/* ── SIDEBAR DIREITA — Comandos ── */
#cmds-panel{
  width:260px;background:var(--bg2);border-left:1px solid var(--bd);
  display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0;
}
#cmds-panel::-webkit-scrollbar{width:3px}
#cmds-panel::-webkit-scrollbar-thumb{background:var(--bd)}
.cmd-item{
  padding:12px 14px;border-bottom:1px solid var(--bd);cursor:pointer;
  transition:background .12s;
}
.cmd-item:hover{background:var(--bg3)}
.cmd-item.active{background:var(--bluedim);border-left:3px solid var(--blue)}
.cmd-top{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.cmd-badge{
  font-size:10px;font-weight:700;font-family:var(--mono);
  padding:2px 7px;border-radius:4px;border:1px solid;
}
.badge-msg{color:var(--green);border-color:var(--green);background:rgba(0,230,118,.08)}
.badge-cmd{color:var(--blue);border-color:var(--blue);background:var(--bluedim)}
.badge-media{color:var(--orange);border-color:var(--orange);background:rgba(255,171,64,.08)}
.cmd-name{font-size:13px;font-weight:700;color:var(--tx);font-family:var(--mono)}
.cmd-desc{font-size:11px;color:var(--tx3);line-height:1.4}
.cmd-del{
  margin-left:auto;width:22px;height:22px;border:none;background:transparent;
  color:var(--tx3);cursor:pointer;border-radius:5px;font-size:13px;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
}
.cmd-del:hover{background:rgba(255,82,82,.15);color:var(--red)}
.add-cmd-btn{
  margin:10px;padding:10px;border-radius:8px;border:1px dashed var(--bd2);
  background:transparent;color:var(--tx3);font-size:12px;font-family:var(--sans);
  cursor:pointer;transition:all .15s;font-weight:600;
}
.add-cmd-btn:hover{border-color:var(--green);color:var(--green)}
.no-cmds{padding:20px 14px;text-align:center;color:var(--tx3);font-size:12px}

/* ── STATUS BAR ── */
#sbar{
  position:fixed;bottom:0;left:0;right:0;height:22px;
  background:#0a1520;border-top:1px solid var(--bd);
  display:flex;align-items:center;padding:0 12px;gap:14px;
  font-size:11px;color:var(--tx3);z-index:100;font-family:var(--mono);
}
.s-green{color:var(--green)}.s-blue{color:var(--blue)}

/* ── MODAL ── */
.modal-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999;align-items:center;justify-content:center}
.modal-ov.on{display:flex}
.modal-box{background:var(--bg2);border:1px solid var(--bd);border-radius:14px;padding:24px;width:100%;max-width:420px;margin:16px}
.modal-box h3{font-size:15px;font-weight:700;margin-bottom:16px}
.modal-field{margin-bottom:12px}
.modal-field label{display:block;font-size:11px;color:var(--tx2);font-weight:600;margin-bottom:4px}
.modal-field input,.modal-field select,.modal-field textarea{
  width:100%;background:var(--bg);border:1px solid var(--bd);border-radius:7px;
  padding:9px 11px;color:var(--tx);font-size:13px;font-family:var(--mono);
  outline:none;transition:border .15s;resize:vertical;
}
.modal-field input:focus,.modal-field select:focus,.modal-field textarea:focus{border-color:var(--blue)}
.modal-field textarea{min-height:80px}
.modal-btns{display:flex;gap:8px;margin-top:16px}
.modal-btns button{flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;border:1px solid var(--bd);font-family:var(--sans)}
.mbtn-ok{background:var(--green);border-color:var(--green);color:#000}
.mbtn-cancel{background:var(--bg3);color:var(--tx2)}

/* ── TOAST ── */
.toast{
  position:fixed;bottom:32px;left:50%;transform:translateX(-50%) translateY(6px);
  background:var(--bg2);border:1px solid var(--bd);padding:10px 20px;
  border-radius:10px;font-size:13px;z-index:9999;opacity:0;
  transition:.2s;pointer-events:none;white-space:nowrap;
}
.toast.on{opacity:1;transform:translateX(-50%)}
.toast.ok{border-color:var(--green);color:var(--green)}
.toast.err{border-color:var(--red);color:var(--red)}

/* mobile */
@media(max-width:800px){
  #config-panel{display:none}
  #cmds-panel{width:200px}
}
@media(max-width:600px){
  #cmds-panel{display:none}
}
</style>
</head>
<body>

<div id="topbar">
  <span class="logo">⚡ ARES</span>
  <span class="logo-sub">Editor de Bot WhatsApp</span>
  <div class="sp"></div>
  <button class="tbtn" onclick="syncConfigToCode()">🔄 Sync Config</button>
  <button class="tbtn green" id="deploy-btn" onclick="doDeploy()">🚀 Deploy Bot</button>
</div>

<div id="layout">

  <!-- ── PAINEL ESQUERDO: configurações ── -->
  <div id="config-panel">

    <div class="panel-section">
      <div class="psec-title">📦 Configuração Geral</div>
      <div class="field">
        <label>Nome do Bot</label>
        <input id="cfg-name" type="text" placeholder="meu-bot" value="meu-bot-wa" oninput="scheduleSyncToCode()">
      </div>
      <div class="field">
        <label>Prefixo de Comandos</label>
        <input id="cfg-prefix" type="text" placeholder="!" value="!" maxlength="5" oninput="scheduleSyncToCode()">
        <div class="hint">Ex: ! → !menu, !ping</div>
      </div>
      <div class="field">
        <label>Mensagem de Boas-vindas</label>
        <textarea id="cfg-welcome" placeholder="Olá! Como posso ajudar?" oninput="scheduleSyncToCode()">Olá! Eu sou um bot WhatsApp criado com ARES HOST. 🤖</textarea>
      </div>
    </div>

    <div class="panel-section">
      <div class="psec-title">⚙️ Comportamento</div>
      <div class="field">
        <label>Responder apenas grupos</label>
        <select id="cfg-grouponly" onchange="scheduleSyncToCode()">
          <option value="false">Não (grupos e privado)</option>
          <option value="true">Sim (apenas grupos)</option>
        </select>
      </div>
      <div class="field">
        <label>Anti-spam (segundos entre msgs)</label>
        <input id="cfg-cooldown" type="number" min="0" max="60" value="3" oninput="scheduleSyncToCode()">
        <div class="hint">0 = desativado</div>
      </div>
    </div>

    <div class="panel-section">
      <div class="psec-title">🎨 Respostas Automáticas</div>
      <div id="auto-responses-list"></div>
      <button class="add-resp-btn" onclick="openAddResponse()">+ Adicionar resposta</button>
    </div>

  </div>

  <!-- ── EDITOR CENTRAL ── -->
  <div id="editor-wrap">
    <div id="editor-tabs">
      <div class="etab on" onclick="switchTab('code')" id="tab-code">📄 index.js</div>
      <div class="etab" onclick="switchTab('pkg')" id="tab-pkg">📦 package.json</div>
    </div>
    <div id="code-editor">
      <div id="monaco-editor"></div>
    </div>
  </div>

  <!-- ── PAINEL DIREITO: comandos ── -->
  <div id="cmds-panel">
    <div class="panel-section" style="padding:12px 14px">
      <div class="psec-title">🤖 Comandos</div>
    </div>
    <div id="cmds-list"><div class="no-cmds">Nenhum comando ainda.</div></div>
    <button class="add-cmd-btn" onclick="openAddCmd()">+ Adicionar Comando</button>
  </div>

</div>

<div id="sbar">
  <span class="s-green">● ARES Editor</span>
  <span id="sb-lang" class="s-blue">javascript</span>
  <span id="sb-lines">0 linhas</span>
  <span id="sb-status">pronto</span>
</div>

<!-- Modal Adicionar Comando -->
<div class="modal-ov" id="modal-cmd">
  <div class="modal-box">
    <h3>➕ Novo Comando</h3>
    <div class="modal-field">
      <label>Tipo</label>
      <select id="mc-type" onchange="updateModalType()">
        <option value="cmd">Comando (!ping)</option>
        <option value="msg">Palavra-chave (mensagem)</option>
        <option value="media">Mídia recebida</option>
      </select>
    </div>
    <div class="modal-field" id="mc-trigger-wrap">
      <label id="mc-trigger-label">Comando (sem prefixo)</label>
      <input id="mc-trigger" type="text" placeholder="ping">
    </div>
    <div class="modal-field">
      <label>Resposta do Bot</label>
      <textarea id="mc-response" placeholder="Pong! 🏓"></textarea>
    </div>
    <div class="modal-field">
      <label>Descrição (opcional)</label>
      <input id="mc-desc" type="text" placeholder="Testa se o bot está online">
    </div>
    <div class="modal-btns">
      <button class="mbtn-cancel" onclick="closeModal('modal-cmd')">Cancelar</button>
      <button class="mbtn-ok" onclick="confirmAddCmd()">Adicionar</button>
    </div>
  </div>
</div>

<!-- Modal Adicionar Resposta Automática -->
<div class="modal-ov" id="modal-resp">
  <div class="modal-box">
    <h3>💬 Resposta Automática</h3>
    <div class="modal-field">
      <label>Quando a mensagem contiver...</label>
      <input id="mr-trigger" type="text" placeholder="olá, oi, hey">
      <div class="hint" style="margin-top:4px">Separe múltiplas palavras com vírgula</div>
    </div>
    <div class="modal-field">
      <label>O bot responde...</label>
      <textarea id="mr-response" placeholder="Olá! 👋 Como posso ajudar?"></textarea>
    </div>
    <div class="modal-btns">
      <button class="mbtn-cancel" onclick="closeModal('modal-resp')">Cancelar</button>
      <button class="mbtn-ok" onclick="confirmAddResponse()">Adicionar</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<script>
const SESSION = "${sess}"
const API_DEPLOY = "/create-bot-deploy"

// ── Estado ─────────────────────────────────────
let monacoEditor = null
let pkgEditor    = null
let currentTab   = "code"
let syncTimer    = null
let commands     = []     // [{type, trigger, response, desc}]
let autoResps    = []     // [{trigger, response}]
let editingCmdIdx  = -1

// ── Monaco setup ──────────────────────────────
require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs" } })

require(["vs/editor/editor.main"], function() {
  monaco.editor.defineTheme("ares", {
    base: "vs-dark", inherit: true,
    rules: [
      { token: "comment",   foreground: "5a7a9a", fontStyle: "italic" },
      { token: "keyword",   foreground: "ff7b72" },
      { token: "string",    foreground: "a5d6ff" },
      { token: "number",    foreground: "79c0ff" },
      { token: "identifier",foreground: "e2eaf3" },
    ],
    colors: {
      "editor.background":             "#080c10",
      "editor.foreground":             "#e2eaf3",
      "editor.lineHighlightBackground":"#0d1319",
      "editorLineNumber.foreground":   "#2a4a68",
      "editorLineNumber.activeForeground": "#40c4ff",
      "editor.selectionBackground":    "#1a3a5a",
      "editorCursor.foreground":       "#00e676",
      "editorIndentGuide.background":  "#1a2a3a",
    }
  })

  monacoEditor = monaco.editor.create(document.getElementById("monaco-editor"), {
    value: generateCode(),
    language: "javascript",
    theme: "ares",
    fontSize: 13,
    fontFamily: "JetBrains Mono, monospace",
    fontLigatures: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "on",
    padding: { top: 12 },
    lineNumbers: "on",
  })

  pkgEditor = monaco.editor.create(document.createElement("div"), {
    value: generatePackageJson(),
    language: "json",
    theme: "ares",
    fontSize: 13,
    fontFamily: "JetBrains Mono, monospace",
    automaticLayout: true,
    minimap: { enabled: false },
    padding: { top: 12 },
  })

  monacoEditor.onDidChangeModelContent(() => {
    const lines = monacoEditor.getModel().getLineCount()
    document.getElementById("sb-lines").textContent = lines + " linhas"
  })

  updateLineCount()
})

// ── Tabs ──────────────────────────────────────
function switchTab(tab) {
  if (!monacoEditor || !pkgEditor) return
  currentTab = tab
  document.querySelectorAll(".etab").forEach(e => e.classList.remove("on"))
  document.getElementById("tab-" + tab).classList.add("on")

  const wrap = document.getElementById("monaco-editor")
  if (tab === "code") {
    wrap.replaceChildren()
    monacoEditor.getDomNode() && wrap.appendChild(monacoEditor.getDomNode().parentElement || monacoEditor.getDomNode())
    monacoEditor.layout()
    document.getElementById("sb-lang").textContent = "javascript"
    updateLineCount()
  } else {
    wrap.replaceChildren()
    pkgEditor.getDomNode() && wrap.appendChild(pkgEditor.getDomNode().parentElement || pkgEditor.getDomNode())
    pkgEditor.layout()
    document.getElementById("sb-lang").textContent = "json"
  }
}

// ── Comandos ──────────────────────────────────
function renderCmds() {
  const list = document.getElementById("cmds-list")
  if (!commands.length) { list.innerHTML = '<div class="no-cmds">Nenhum comando.<br>Clique em + para adicionar.</div>'; return }
  list.innerHTML = commands.map((c, i) => {
    const badge = c.type === "cmd" ? "badge-cmd" : c.type === "msg" ? "badge-msg" : "badge-media"
    const label = c.type === "cmd" ? "CMD" : c.type === "msg" ? "MSG" : "MÍDIA"
    const name  = c.type === "media" ? "(qualquer mídia)" : c.trigger
    return \`<div class="cmd-item \${editingCmdIdx===i?'active':''}" onclick="selectCmd(\${i})">
      <div class="cmd-top">
        <span class="cmd-badge \${badge}">\${label}</span>
        <span class="cmd-name">\${esc(name)}</span>
        <button class="cmd-del" onclick="delCmd(event,\${i})">✕</button>
      </div>
      <div class="cmd-desc">\${esc(c.desc||c.response).slice(0,60)}\${(c.desc||c.response).length>60?"…":""}</div>
    </div>\`
  }).join("")
}

function selectCmd(i) { editingCmdIdx = i; renderCmds() }
function delCmd(e, i) {
  e.stopPropagation()
  commands.splice(i, 1)
  if (editingCmdIdx >= commands.length) editingCmdIdx = -1
  renderCmds(); syncConfigToCode()
}

function openAddCmd() {
  document.getElementById("mc-type").value    = "cmd"
  document.getElementById("mc-trigger").value = ""
  document.getElementById("mc-response").value= ""
  document.getElementById("mc-desc").value    = ""
  updateModalType()
  openModal("modal-cmd")
}
function updateModalType() {
  const t = document.getElementById("mc-type").value
  const wrap = document.getElementById("mc-trigger-wrap")
  if (t === "media") { wrap.style.display = "none" } else {
    wrap.style.display = ""
    document.getElementById("mc-trigger-label").textContent = t === "cmd" ? "Comando (sem prefixo)" : "Palavra-chave"
    document.getElementById("mc-trigger").placeholder = t === "cmd" ? "ping" : "oi, olá, hey"
  }
}
function confirmAddCmd() {
  const type     = document.getElementById("mc-type").value
  const trigger  = document.getElementById("mc-trigger").value.trim()
  const response = document.getElementById("mc-response").value.trim()
  const desc     = document.getElementById("mc-desc").value.trim()
  if (!response) return toast("Preencha a resposta!","err")
  if (type !== "media" && !trigger) return toast("Preencha o gatilho!","err")
  commands.push({ type, trigger, response, desc })
  closeModal("modal-cmd"); renderCmds(); syncConfigToCode()
  toast("✅ Comando adicionado!")
}

// ── Respostas automáticas ─────────────────────
function renderAutoResponses() {
  const list = document.getElementById("auto-responses-list")
  if (!autoResps.length) { list.innerHTML = ""; return }
  list.innerHTML = autoResps.map((r, i) => \`
    <div style="background:var(--bg3);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
        <span style="color:var(--green);font-family:var(--mono);font-weight:700">\${esc(r.trigger)}</span>
        <button onclick="delAutoResp(\${i})" style="margin-left:auto;background:transparent;border:none;color:var(--tx3);cursor:pointer;font-size:12px">✕</button>
      </div>
      <span style="color:var(--tx3)">\${esc(r.response).slice(0,50)}\${r.response.length>50?"…":""}</span>
    </div>
  \`).join("")
}

function openAddResponse() {
  document.getElementById("mr-trigger").value  = ""
  document.getElementById("mr-response").value = ""
  openModal("modal-resp")
}
function confirmAddResponse() {
  const trigger  = document.getElementById("mr-trigger").value.trim()
  const response = document.getElementById("mr-response").value.trim()
  if (!trigger || !response) return toast("Preencha todos os campos!","err")
  autoResps.push({ trigger, response })
  closeModal("modal-resp"); renderAutoResponses(); syncConfigToCode()
  toast("✅ Resposta adicionada!")
}
function delAutoResp(i) { autoResps.splice(i, 1); renderAutoResponses(); syncConfigToCode() }

// ── Geradores de código ───────────────────────
function cfg() {
  return {
    name:      document.getElementById("cfg-name")?.value     || "meu-bot-wa",
    prefix:    document.getElementById("cfg-prefix")?.value   || "!",
    welcome:   document.getElementById("cfg-welcome")?.value  || "",
    grouponly: document.getElementById("cfg-grouponly")?.value === "true",
    cooldown:  parseInt(document.getElementById("cfg-cooldown")?.value) || 0,
  }
}

function generateCode() {
  const c = cfg()
  const prefix = c.prefix.replace(/'/g, "\\'")
  const welcome = c.welcome.replace(/\`/g, "\\`")

  // Gera handlers de comandos
  const cmdHandlers = commands.map(cmd => {
    const resp = cmd.response.replace(/\`/g, "\\`")
    if (cmd.type === "cmd") {
      const trigger = cmd.trigger.replace(/'/g, "\\'").toLowerCase()
      return \`    if (command === '\${trigger}') {
      await sock.sendMessage(remoteJid, { text: \\\`\${resp}\\\` })
      return
    }\`
    }
    if (cmd.type === "msg") {
      const keywords = cmd.trigger.split(",").map(k => k.trim().toLowerCase()).filter(Boolean)
      const cond = keywords.map(k => \`lowerText.includes('\${k.replace(/'/g, "\\'")}')\`).join(" || ")
      return \`    if (\${cond}) {
      await sock.sendMessage(remoteJid, { text: \\\`\${resp}\\\` })
      return
    }\`
    }
    if (cmd.type === "media") {
      return \`    // Qualquer mídia recebida
    if (msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage) {
      await sock.sendMessage(remoteJid, { text: \\\`\${resp}\\\` })
      return
    }\`
    }
    return ""
  }).join("\\n\\n")

  // Gera respostas automáticas
  const autoRespHandlers = autoResps.map(r => {
    const keywords = r.trigger.split(",").map(k => k.trim().toLowerCase()).filter(Boolean)
    const cond = keywords.map(k => \`lowerText.includes('\${k.replace(/'/g, "\\'")}')\`).join(" || ")
    const resp = r.response.replace(/\`/g, "\\`")
    return \`    if (\${cond}) {
      await sock.sendMessage(remoteJid, { text: \\\`\${resp}\\\` })
      return
    }\`
  }).join("\\n\\n")

  const cooldownBlock = c.cooldown > 0 ? \`
  // Anti-spam
  const spamKey = remoteJid + sender
  const now = Date.now()
  if (cooldowns.has(spamKey) && now - cooldowns.get(spamKey) < \${c.cooldown * 1000}) return
  cooldowns.set(spamKey, now)
\` : ""

  const groupOnlyBlock = c.grouponly ? \`
  // Apenas grupos
  if (!remoteJid.endsWith('@g.us')) return
\` : ""

  return \`// ═══════════════════════════════════════════════
// Bot: \${c.name}
// Gerado por ARES HOST — https://areshost.app
// ═══════════════════════════════════════════════

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const P = require('pino')
const fs = require('fs')

const PREFIX = '\${prefix}'
const BOT_NAME = '\${c.name}'
const cooldowns = new Map()

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\\n📱 Escaneie o QR Code acima com o WhatsApp!\\n')
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true
      console.log('\\n🔴 Conexão fechada. Reconectando:', shouldReconnect)
      if (shouldReconnect) setTimeout(connectToWhatsApp, 3000)
    } else if (connection === 'open') {
      console.log('\\n✅ ' + BOT_NAME + ' conectado ao WhatsApp!\\n')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message) continue
      if (msg.key.fromMe) continue

      const remoteJid = msg.key.remoteJid
      const sender    = msg.key.participant || remoteJid
      const body      = msg.message?.conversation
                     || msg.message?.extendedTextMessage?.text
                     || ''
      const lowerText = body.toLowerCase().trim()
\${groupOnlyBlock}\${cooldownBlock}
      // ── Comandos com prefixo
      if (body.startsWith(PREFIX)) {
        const args    = body.slice(PREFIX.length).trim().split(/\\s+/)
        const command = args.shift().toLowerCase()

        // Comando padrão: menu
        if (command === 'menu' || command === 'help' || command === 'ajuda') {
          const menuText = [
            '*🤖 ' + BOT_NAME + ' — Menu*',
            '',
\${commands.filter(c=>c.type==="cmd").map(c=>\`            '  *\${prefix}\${c.trigger}* — \${c.desc||c.response.slice(0,30)}',\`).join("\\n") || "            '  Nenhum comando cadastrado ainda.',"}
            '',
            '_Powered by ARES HOST_ 🚀'
          ].join('\\n')
          await sock.sendMessage(remoteJid, { text: menuText })
          continue
        }

\${cmdHandlers || "        // Adicione seus comandos acima"}

        // Comando não encontrado
        await sock.sendMessage(remoteJid, { text: \\\`❓ Comando desconhecido. Digite *\${prefix}menu* para ver os comandos.\\\` })
        continue
      }

      // ── Respostas automáticas por palavra-chave
\${autoRespHandlers || "      // Adicione suas respostas automáticas acima"}

\${c.welcome ? \`      // Mensagem de qualquer texto sem comando
      // (Descomente para responder qualquer mensagem)
      // await sock.sendMessage(remoteJid, { text: \\\`\${welcome}\\\` })
\` : ""}
    }
  })

  return sock
}

connectToWhatsApp().catch(err => {
  console.error('❌ Erro fatal:', err)
  process.exit(1)
})
\`
}

function generatePackageJson() {
  const name = (document.getElementById("cfg-name")?.value || "meu-bot-wa")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-")
  return JSON.stringify({
    name,
    version: "1.0.0",
    description: "Bot WhatsApp gerado pelo ARES HOST",
    main: "index.js",
    scripts: { start: "node index.js" },
    dependencies: {
      "@whiskeysockets/baileys": "^6.7.0",
      "@hapi/boom": "^10.0.1",
      "pino": "^8.15.0"
    }
  }, null, 2)
}

// ── Sync: config → code ───────────────────────
function scheduleSyncToCode() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(syncConfigToCode, 600)
}

function syncConfigToCode() {
  if (!monacoEditor || !pkgEditor) return
  const pos = monacoEditor.getPosition()
  monacoEditor.setValue(generateCode())
  pkgEditor.setValue(generatePackageJson())
  if (pos) monacoEditor.setPosition(pos)
  updateLineCount()
}

function updateLineCount() {
  if (!monacoEditor) return
  const lines = monacoEditor.getModel()?.getLineCount() || 0
  document.getElementById("sb-lines").textContent = lines + " linhas"
}

// ── Modals ────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add("on") }
function closeModal(id) { document.getElementById(id).classList.remove("on") }
document.addEventListener("click", e => {
  ["modal-cmd","modal-resp"].forEach(id => {
    const ov = document.getElementById(id)
    if (e.target === ov) ov.classList.remove("on")
  })
})

// ── Deploy ────────────────────────────────────
async function doDeploy() {
  const btn = document.getElementById("deploy-btn")
  if (btn.disabled) return

  const name  = document.getElementById("cfg-name").value.trim() || "meu-bot-wa"
  const code  = monacoEditor ? monacoEditor.getValue() : generateCode()
  const pkg   = pkgEditor   ? pkgEditor.getValue()   : generatePackageJson()

  if (!code.trim()) return toast("❌ Código vazio!","err")

  btn.disabled = true
  btn.textContent = "⏳ Enviando..."
  document.getElementById("sb-status").textContent = "enviando..."

  try {
    const res = await fetch(API_DEPLOY + "?s=" + SESSION, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code, pkg })
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || "Erro desconhecido")

    document.getElementById("sb-status").textContent = "✅ deployado!"
    toast("🚀 Bot criado com sucesso! Verifique o Telegram.","ok")
    btn.textContent = "✅ Deployado!"
    setTimeout(() => {
      if (data.terminalUrl) window.open(data.terminalUrl, "_blank")
    }, 1200)
  } catch(e) {
    toast("❌ " + e.message, "err")
    document.getElementById("sb-status").textContent = "erro: " + e.message
    btn.disabled = false
    btn.textContent = "🚀 Deploy Bot"
  }
}

// ── Helpers ───────────────────────────────────
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") }
function toast(msg, type) {
  const el = document.getElementById("toast")
  el.textContent = msg
  el.className = "toast on " + (type||"ok")
  clearTimeout(el._t)
  el._t = setTimeout(() => el.className = "toast", 2800)
}

// ── Init ──────────────────────────────────────
renderCmds()
renderAutoResponses()
</script>
</body>
</html>`)
})

// ─── Deploy de bot criado pelo editor ─────────

app.post("/create-bot-deploy", express.json(), async (req, res) => {
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).json({ error: "Não autenticado" })

  const { name, code, pkg } = req.body
  if (!code) return res.status(400).json({ error: "Código vazio" })

  const safeName = (name || "meu-bot-wa").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40)
  const botId    = generateBotId()
  const instancePath = path.join(BASE_PATH, botId)
  fs.mkdirSync(instancePath, { recursive: true })

  // Salva index.js
  fs.writeFileSync(path.join(instancePath, "index.js"), code, "utf8")

  // Salva package.json
  let pkgObj
  try { pkgObj = JSON.parse(pkg) } catch { pkgObj = { name: safeName, version: "1.0.0", main: "index.js", scripts: { start: "node index.js" }, dependencies: { "@whiskeysockets/baileys": "^6.7.0", "@hapi/boom": "^10.0.1", "pino": "^8.15.0" } } }
  fs.writeFileSync(path.join(instancePath, "package.json"), JSON.stringify(pkgObj, null, 2), "utf8")

  saveMeta(botId, chatId, safeName)
  spawnBot(botId, instancePath)

  const sess = genWebSession(chatId)
  const terminalUrl = `${DOMAIN}/terminal/${botId}?s=${sess}`
  const filesUrl    = `${DOMAIN}/files/${botId}?s=${sess}`

  // Avisa no Telegram
  bot.sendMessage(chatId,
    `🚀 *Bot WhatsApp criado!*\n\n` +
    `🤖 *Nome:* ${safeName}\n` +
    `🆔 *ID:* \`${botId}\`\n\n` +
    `📱 Após abrir o terminal, escaneie o QR Code com o WhatsApp para conectar seu bot.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📟 Abrir Terminal (QR Code aqui)", url: terminalUrl }],
          [{ text: "📁 Editar Arquivos", url: filesUrl }],
          [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
        ]
      }
    }
  )

  res.json({ ok: true, botId, terminalUrl, filesUrl })
})

// ═══════════════════════════════════════════════════════════════
// ─── ROTAS EXISTENTES ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

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
socket.on("connect",()=>{ term.clear(); socket.emit("request-history",{botId}) })
socket.on("history-"+botId,data=>{ term.write(data) })
socket.on("log-"+botId,data=>term.write(data))
term.onData(data=>socket.emit("input",{botId,data}))
</script>
</body>
</html>`)
})

// ─── Upload via Web ──────────────────────────

app.get("/upload/:token", (req, res) => {
  const info = uploadTokens[req.params.token]
  if (!info) return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ARES HOST</title>
    <style>body{background:#0a0a0a;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{text-align:center;padding:40px;border:1px solid #333;border-radius:12px}h2{color:#f44;margin:0 0 10px}</style></head>
    <body><div class="box"><h2>❌ Link inválido ou expirado</h2><p>Gere um novo link pelo Telegram.</p></div></body></html>`)

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ARES HOST — Upload</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#111;border:1px solid #222;border-radius:16px;padding:36px;width:100%;max-width:480px;box-shadow:0 0 40px rgba(0,255,100,0.05)}
.logo{color:#0f0;font-size:22px;font-weight:bold;margin-bottom:6px}.sub{color:#555;font-size:13px;margin-bottom:28px}
.drop{border:2px dashed #2a2a2a;border-radius:12px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .2s;position:relative}
.drop:hover,.drop.over{border-color:#0f0;background:#0a1a0a}
.drop input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.drop-icon{font-size:36px;margin-bottom:10px}.drop-text{color:#555;font-size:14px}.drop-text span{color:#0f0}
.file-info{margin-top:16px;background:#1a1a1a;border-radius:8px;padding:12px 16px;display:none;align-items:center;gap:10px}
.file-info.show{display:flex}.file-name{flex:1;font-size:13px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-size{color:#555;font-size:12px;white-space:nowrap}
label{display:block;margin-top:20px;margin-bottom:6px;font-size:13px;color:#888}
input[type=text]{width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;color:#fff;font-size:14px;outline:none;transition:border .2s}
input[type=text]:focus{border-color:#0f0}
.btn{margin-top:22px;width:100%;background:#0f0;color:#000;border:none;border-radius:8px;padding:13px;font-size:15px;font-weight:bold;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}.btn:disabled{opacity:.4;cursor:not-allowed}
.progress{margin-top:16px;display:none}.progress.show{display:block}
.bar-bg{background:#1a1a1a;border-radius:99px;height:6px;overflow:hidden}
.bar{height:100%;background:#0f0;width:0%;transition:width .3s;border-radius:99px}
.status{margin-top:10px;font-size:13px;color:#555;text-align:center}.status.ok{color:#0f0}.status.err{color:#f44}
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
    <span>📄</span><span class="file-name" id="fileName"></span><span class="file-size" id="fileSize"></span>
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
const token="${req.params.token}"
const fileInput=document.getElementById("fileInput")
const drop=document.getElementById("drop")
const btn=document.getElementById("btn")
const botNameInput=document.getElementById("botName")
function formatSize(b){if(b>1024*1024)return(b/1024/1024).toFixed(1)+" MB";return(b/1024).toFixed(0)+" KB"}
function checkReady(){btn.disabled=!(fileInput.files[0]&&botNameInput.value.trim().length>0)}
fileInput.addEventListener("change",()=>{const f=fileInput.files[0];if(!f)return;document.getElementById("fileName").textContent=f.name;document.getElementById("fileSize").textContent=formatSize(f.size);document.getElementById("fileInfo").classList.add("show");checkReady()})
botNameInput.addEventListener("input",checkReady)
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("over")})
drop.addEventListener("dragleave",()=>drop.classList.remove("over"))
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("over");const f=e.dataTransfer.files[0];if(!f||!f.name.endsWith(".zip"))return alert("Apenas arquivos .zip!");const dt=new DataTransfer();dt.items.add(f);fileInput.files=dt.files;fileInput.dispatchEvent(new Event("change"))})
function doUpload(){
  const f=fileInput.files[0];const name=botNameInput.value.trim().replace(/\s+/g,"_").toLowerCase();if(!f||!name)return
  btn.disabled=true;const prog=document.getElementById("progress");const bar=document.getElementById("bar");const status=document.getElementById("status");prog.classList.add("show")
  const fd=new FormData();fd.append("file",f);fd.append("name",name)
  const xhr=new XMLHttpRequest();xhr.open("POST","/upload/"+token)
  xhr.upload.onprogress=e=>{if(e.lengthComputable){const pct=Math.round(e.loaded/e.total*100);bar.style.width=pct+"%";status.textContent="Enviando... "+pct+"%"}}
  xhr.onload=()=>{if(xhr.status===200){bar.style.width="100%";status.textContent="✅ Bot enviado! Verifique o Telegram.";status.className="status ok"}else{status.textContent="❌ Erro: "+xhr.responseText;status.className="status err";btn.disabled=false}}
  xhr.onerror=()=>{status.textContent="❌ Erro de conexão.";status.className="status err";btn.disabled=false}
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
    if (!file.originalname.toLowerCase().endsWith(".zip")) return cb(new Error("Apenas .zip sao permitidos"))
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
  const loadingMsg = await bot.sendMessage(chatId, `⏳ Criando bot *${name}*...\n\nArquivo recebido via web, extraindo...`, { parse_mode: "Markdown" })
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
      const rel  = base ? base + "/" + e.name : e.name
      const full = path.join(dir, e.name)
      if (e.isDirectory()) result.push({ type: "dir", name: e.name, path: rel, children: walkDir(full, rel) })
      else result.push({ type: "file", name: e.name, path: rel })
    }
  } catch {}
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

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
.tbtn:active{opacity:.7}.tbtn.g{background:#238636;border-color:#238636;color:#fff}.tbtn.r{border-color:var(--red);color:var(--red)}
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
.row:active{background:var(--bg3)}.row.sel{background:#1f3a5f}
.row .ico{margin-right:6px;font-size:14px;width:18px;text-align:center;flex-shrink:0}
.row .lbl{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.row .lbl.d{color:var(--blue)}.row .arr{font-size:9px;color:var(--tx2);margin-right:4px;width:10px;transition:transform .15s;flex-shrink:0}
.row .arr.o{transform:rotate(90deg)}.row .arr.h{opacity:0}
#side-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:4}
#right{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#tabs{background:var(--bg2);border-bottom:1px solid var(--bd);display:flex;overflow-x:auto;flex-shrink:0;min-height:36px}
#tabs::-webkit-scrollbar{height:0}
.tab{display:flex;align-items:center;gap:5px;padding:0 10px;height:36px;border-right:1px solid var(--bd);cursor:pointer;font-size:12px;color:var(--tx2);white-space:nowrap;flex-shrink:0;position:relative}
.tab.on{color:var(--tx);background:var(--bg)}.tab.on::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--blue)}
.tab .x{opacity:0;font-size:11px;padding:2px 4px;border-radius:3px;line-height:1}
.tab:hover .x,.tab.on .x{opacity:.5}.tab .x:hover{opacity:1!important;background:var(--bd)}.tab .dot{width:7px;height:7px;background:var(--orange);border-radius:50%}
#breadcrumb{background:var(--bg);border-bottom:1px solid var(--bd);padding:4px 12px;font-size:11px;color:var(--tx2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#editor{flex:1;overflow:hidden}
#welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--tx2);padding:20px;text-align:center}
#welcome .big{font-size:52px;opacity:.25}#welcome h2{font-size:16px;color:var(--tx);font-weight:400}#welcome p{font-size:13px;line-height:1.6;max-width:260px}#welcome kbd{background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:1px 5px;font-family:monospace;font-size:11px}
#sbar{background:#1f2328;border-top:1px solid var(--bd);height:22px;display:flex;align-items:center;padding:0 12px;gap:14px;font-size:11px;color:var(--tx2);flex-shrink:0}
.s-ok{color:var(--green)}.s-warn{color:var(--orange)}
.ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:999;align-items:flex-end;justify-content:center}
.ov.on{display:flex}@media(min-width:600px){.ov{align-items:center}}
.box{background:var(--bg2);border:1px solid var(--bd);border-radius:14px 14px 0 0;padding:22px;width:100%;max-width:460px}
@media(min-width:600px){.box{border-radius:12px}}
.box h3{margin-bottom:14px;font-size:15px}
.box input{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--tx);padding:10px 12px;border-radius:8px;font-size:15px;outline:none;font-family:monospace}
.box input:focus{border-color:var(--blue)}
.box .bts{display:flex;gap:8px;margin-top:14px}
.box .bts button{flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;border:1px solid var(--bd)}
.ok-btn{background:var(--green);border-color:var(--green);color:#000}.cancel-btn{background:var(--bg3);color:var(--tx2)}
.ctx{display:none;position:fixed;background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:4px;z-index:888;min-width:160px;box-shadow:0 8px 28px rgba(0,0,0,.5)}
.ctx.on{display:block}
.ctx-item{padding:9px 14px;cursor:pointer;border-radius:6px;font-size:14px;display:flex;align-items:center;gap:8px}
.ctx-item:active{background:var(--bg3)}.ctx-item.danger{color:var(--red)}.ctx-hr{height:1px;background:var(--bd);margin:3px 0}
.toast{position:fixed;bottom:34px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--bg2);border:1px solid var(--bd);padding:10px 20px;border-radius:10px;font-size:13px;z-index:9999;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:90vw;text-align:center}
.toast.on{opacity:1;transform:translateX(-50%)}.toast.ok{border-color:var(--green);color:var(--green)}.toast.err{border-color:var(--red);color:var(--red)}
@media(max-width:700px){
  #side{position:fixed;top:48px;left:0;bottom:22px;width:82vw;max-width:300px;transform:translateX(-100%);box-shadow:4px 0 24px rgba(0,0,0,.5)}
  #side.open{transform:translateX(0)}#side-overlay.on{display:block}#btn-menu{display:block}.chip{max-width:90px}.tbtn span{display:none}
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
  try{const r=await fetch(apiUrl("/tree"));if(!r.ok){document.getElementById("tree").innerHTML=\`<div style="padding:12px;font-size:12px;color:var(--red)">Erro \${r.status}</div>\`;return}treeData=await r.json();renderTree()}
  catch(e){document.getElementById("tree").innerHTML=\`<div style="padding:12px;font-size:12px;color:var(--red)">\${e.message}</div>\`}
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
  e.stopPropagation();const t=tabs.find(x=>x.path===p)
  if(t&&t.dirty&&!confirm("Fechar sem salvar?"))return
  tabs=tabs.filter(x=>x.path!==p);if(models[p]){models[p].dispose();delete models[p]}
  if(currentFile===p){tabs.length?openFile(tabs[tabs.length-1].path):clearEditor()}
  renderTabs()
}
function clearEditor(){
  currentFile=null;isDirty=false;if(ed)ed.setValue("")
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
  currentFile=p;isDirty=false;ed.setModel(models[p])
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
  modalCb=cb;document.getElementById("modal-title").textContent=title
  document.getElementById("modal-in").value="";document.getElementById("modal-in").placeholder=placeholder
  document.getElementById("modal").classList.add("on");setTimeout(()=>document.getElementById("modal-in").focus(),100)
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

// ─── Init ────────────────────────────────────

process.on("uncaughtException", err => {
  if (err.code !== "EADDRINUSE") console.error(err)
})

server.listen(PORT, () => {
  aresBanner()
  if (fs.existsSync(BASE_PATH)) {
    const bots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users")
    if (bots.length > 0) {
      console.log(`\n♻️  Restaurando ${bots.length} bot(s)...\n`)
      bots.forEach((botId, i) => {
        const instancePath = path.join(BASE_PATH, botId)
        const meta = getMeta(botId)
        const name = meta ? meta.name : botId
        setTimeout(() => {
          console.log(`  ▶ Iniciando: ${name} (${botId})`)
          spawnBot(botId, instancePath)
        }, i * 1500)
      })
    }
  }
})
