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
const { criarZipBot } = require("./botmaker") // ← NOVO

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
const wizardState = {} // ← NOVO: estado do wizard de criação de bot WPP

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

const termoCheck = {}

// ─── WIZARD: Criação de Bot WhatsApp ──────────────────────────

async function handleWizard(chatId, texto) {
  const w = wizardState[chatId]
  if (!w) return false
  const resposta = texto.trim()

  // Passo 1 — Número do dono
  if (w.step === "numero") {
    const num = resposta.replace(/\D/g, "")
    if (num.length < 10) {
      await bot.sendMessage(chatId,
        "❌ Número inválido. Precisa ter DDD + número, com código do país.\nEx: `5511999999999`",
        { parse_mode: "Markdown" }
      )
      return true
    }
    w.dados.ownerNumber = num
    w.step = "nome"
    await bot.sendMessage(chatId,
      "✅ Número salvo!\n\n*Passo 2/5 — Nome do bot*\n\nQual será o nome do seu bot?\nEx: `AtendenteVip`, `SuporteAuto`, `BotLoja`",
      { parse_mode: "Markdown" }
    )
    return true
  }

  // Passo 2 — Nome
  if (w.step === "nome") {
    if (resposta.length < 2) {
      await bot.sendMessage(chatId, "❌ Nome muito curto. Tente novamente.")
      return true
    }
    w.dados.botName = resposta
    w.step = "prefix"
    await bot.sendMessage(chatId,
      `✅ Nome: *${resposta}*\n\n*Passo 3/5 — Prefixo dos comandos*\n\nQual prefixo os comandos usarão?\nEx: \`!\` \`/\` \`.\` \`#\`\n\nRecomendado: \`!\``,
      { parse_mode: "Markdown" }
    )
    return true
  }

  // Passo 3 — Prefixo
  if (w.step === "prefix") {
    w.dados.prefix = resposta[0]
    w.step = "recursos"
    await bot.sendMessage(chatId,
      `✅ Prefixo: *${w.dados.prefix}*\n\n*Passo 4/5 — Recursos extras*\n\nEscolha os recursos que deseja ativar:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: `${w.dados.antiLink ? "✅" : "⬜"} Anti-link`,       callback_data: "wiz_toggle:antiLink" },
              { text: `${w.dados.bemVindo ? "✅" : "⬜"} Bem-vindo`,       callback_data: "wiz_toggle:bemVindo" },
            ],
            [{ text: `${w.dados.menuAuto ? "✅" : "⬜"} Menu automático`,  callback_data: "wiz_toggle:menuAuto" }],
            [{ text: "▶️ Continuar", callback_data: "wiz_step:respostas" }]
          ]
        }
      }
    )
    return true
  }

  // Passo 5 — Respostas automáticas
  if (w.step === "respostas_input") {
    if (resposta === "0" || resposta.toLowerCase() === "pronto") {
      return await finalizarWizard(chatId)
    }
    const partes = resposta.split("|")
    if (partes.length < 2) {
      await bot.sendMessage(chatId,
        "❌ Formato incorreto!\n\nUse: `gatilho | resposta`\nEx: `preco | Veja nosso catálogo! 📋`\n\nOu envie `0` para finalizar.",
        { parse_mode: "Markdown" }
      )
      return true
    }
    const gatilho  = partes[0].trim().toLowerCase()
    const respAuto = partes.slice(1).join("|").trim()
    w.dados.autoRespostas = w.dados.autoRespostas || []
    w.dados.autoRespostas.push({ gatilho, resposta: respAuto })
    const lista = w.dados.autoRespostas.map((r, i) => `${i+1}. *${r.gatilho}* → ${r.resposta}`).join("\n")
    await bot.sendMessage(chatId,
      `✅ Resposta adicionada!\n\n📋 *Lista atual:*\n${lista}\n\nEnvie outra ou \`0\` para finalizar e criar o bot.`,
      { parse_mode: "Markdown" }
    )
    return true
  }

  return false
}

async function finalizarWizard(chatId) {
  const w = wizardState[chatId]
  if (!w) return true

  // Respostas padrão se não adicionou nenhuma
  if (!w.dados.autoRespostas || !w.dados.autoRespostas.length) {
    w.dados.autoRespostas = [
      { gatilho: "oi",      resposta: "Olá! Como posso te ajudar? 😊" },
      { gatilho: "ola",     resposta: "Olá! 👋 Estou aqui para ajudar!" },
      { gatilho: "ajuda",   resposta: `Use *${w.dados.prefix}menu* para ver os comandos disponíveis.` },
      { gatilho: "horario", resposta: "Funcionamos de Segunda a Sexta, das 9h às 18h 🕘" },
    ]
  }

  delete wizardState[chatId]

  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Gerando seu bot WhatsApp...*\n\n` +
    `🤖 Nome: *${w.dados.botName}*\n` +
    `📱 Dono: \`${w.dados.ownerNumber}\`\n` +
    `⚙️ Prefixo: *${w.dados.prefix}*\n` +
    `📋 Respostas: *${w.dados.autoRespostas.length}*\n` +
    `🔗 Anti-link: ${w.dados.antiLink ? "✅" : "❌"}  |  👋 Bem-vindo: ${w.dados.bemVindo ? "✅" : "❌"}`,
    { parse_mode: "Markdown" }
  )

  try {
    const zipBuffer = await criarZipBot({
      prefix:        w.dados.prefix       || "!",
      ownerNumber:   w.dados.ownerNumber,
      botName:       w.dados.botName,
      autoRespostas: w.dados.autoRespostas,
      antiLink:      w.dados.antiLink     || false,
      bemVindo:      w.dados.bemVindo     || false,
      menuAuto:      w.dados.menuAuto     !== false,
    })

    const botId        = generateBotId()
    const name         = w.dados.botName.replace(/\s+/g, "_").toLowerCase()
    const instancePath = path.join(BASE_PATH, botId)
    fs.mkdirSync(instancePath, { recursive: true })
    saveMeta(botId, chatId, name)

    const zipPath = path.join(instancePath, "bot.zip")
    fs.writeFileSync(zipPath, zipBuffer)

    extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)

  } catch (err) {
    bot.editMessageText(
      `❌ Erro ao gerar bot: ${err.message}`,
      { chat_id: chatId, message_id: loadingMsg.message_id }
    )
  }

  return true
}

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
  const entries = fs.readdirSync(instancePath).filter(e => e !== "bot.zip")
  if (entries.length === 1) {
    const single = path.join(instancePath, entries[0])
    const stat = fs.statSync(single)
    if (stat.isDirectory()) {
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
      flattenIfNeeded(instancePath)
      const nm = path.join(instancePath, "node_modules")
      if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true })

      spawnBot(botId, instancePath)

      bot.editMessageText(
        `✅ *Bot criado com sucesso!*\n\n` +
        `📦 Nome: *${name}*\n` +
        `🆔 ID: \`${botId}\`\n` +
        `🟢 Status: *Iniciando...*\n\n` +
        `_Se for um bot WhatsApp gerado pelo ARES, escaneie o QR Code no terminal para conectar!_`,
        {
          chat_id: loadingMsg.chat.id,
          message_id: loadingMsg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📟 Abrir Terminal (QR Code aqui)", url: `${DOMAIN}/terminal/${botId}?s=${genWebSession(loadingMsg.chat.id)}` }],
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

  if (!hasAccepted(chatId)) {
    termoCheck[chatId] = false
    return sendTermos(chatId, false)
  }

  // ← NOVO: Processa o wizard de criação de bot WhatsApp
  if (await handleWizard(chatId, msg.text || "")) return

  const state = userState[chatId]

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
    bot.editMessageText(
      `❌ Erro ao baixar: ${err.message}`,
      { chat_id: loadingMsg.chat.id, message_id: loadingMsg.message_id }
    )
  }
})

// ─── Exportar / Importar ───────────────────────

function isAdmin(chatId) {
  return !ADMIN_ID || String(chatId) === String(ADMIN_ID)
}

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

bot.onText(/^\/updateWarn (.+)/s, async msg => {
  const chatId = msg.chat.id
  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, `❌ *Sem permissão.*`, { parse_mode: "Markdown" })
  }
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
  const bots = fs.existsSync(BASE_PATH) ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads") : []
  let freed = 0, totalMB = 0
  for (const botId of bots) {
    if (activeBots[botId]) continue
    const nm = path.join(BASE_PATH, botId, "node_modules")
    if (fs.existsSync(nm)) {
      try {
        const { execSync } = require("child_process")
        try { const du = execSync(`du -sm ${nm}`).toString(); totalMB += parseFloat(du.split("	")[0]) || 0 } catch {}
        fs.rmSync(nm, { recursive: true, force: true }); freed++
      } catch {}
    }
  }
  bot.sendMessage(chatId,
    `🧹 *Limpeza concluída!*\n\n🗑️ node_modules removidos: *${freed}* bot(s)\n💾 Espaço liberado: ~*${totalMB.toFixed(0)} MB*\n\n_Bots em execução não foram afetados._`,
    { parse_mode: "Markdown" }
  )
})

bot.onText(/^\/exportar$/, async msg => {
  const chatId = msg.chat.id
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Sem permissão.")
  const bots = fs.existsSync(BASE_PATH) ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads") : []
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
  bot.sendMessage(chatId, `📥 *Importar Backup*\n\nEnvie o arquivo .zip gerado pelo /exportar.\n\n⚠️ Bots que já existem *não* serão sobrescritos.`, { parse_mode: "Markdown" })
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
      if (name === "_uploads") continue
      const src = path.join(tmpDir, name), dest = path.join(BASE_PATH, name)
      if (!fs.statSync(src).isDirectory()) continue
      if (fs.existsSync(dest)) { skipped++; continue }
      fs.mkdirSync(dest, { recursive: true })
      for (const f of fs.readdirSync(src)) execFile("cp", ["-r", path.join(src, f), dest])
      restored++
    }
    await bot.editMessageText(
      `✅ *Importação concluída!*\n\n📦 Restaurados: *${restored}* bot(s)\n⏭️ Ignorados: *${skipped}*\n\nIniciando bots restaurados...`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    )
    const allBots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads")
    allBots.forEach((botId, i) => { if (!activeBots[botId]) setTimeout(() => spawnBot(botId, path.join(BASE_PATH, botId)), i * 1500) })
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

  // ── Aceite de aviso
  if (action === "warn_aceito") {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
    return bot.deleteMessage(chatId, msgId).catch(() => {})
  }

  // ── Termos
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
            [{ text: "➕ Novo Bot",     callback_data: "menu_new" }],
            [{ text: "📂 Meus Bots",    callback_data: "menu_list" }],
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
      `🚀 *ARES HOST*\n\n🤖 Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
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

  // ── NOVO: Iniciar wizard de criação de bot WhatsApp
  if (action === "menu_criar_wpp") {
    wizardState[chatId] = { step: "numero", dados: { menuAuto: true } }
    return bot.editMessageText(
      `🤖 *Criar Bot WhatsApp*\n\n` +
      `Vou te guiar em *5 passos* para criar seu bot gratuitamente!\n\n` +
      `*Passo 1/5 — Número do dono*\n\n` +
      `Digite seu número com código do país e DDD:\n` +
      `Ex: \`5511999999999\`\n\n` +
      `_Este número terá permissões de dono no bot._`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "menu_new" }]]
        }
      }
    )
  }

  // ── NOVO: Toggle de recursos do wizard
  if (action === "wiz_toggle") {
    const w = wizardState[chatId]
    if (!w) return
    w.dados[id] = !w.dados[id]
    return bot.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: `${w.dados.antiLink ? "✅" : "⬜"} Anti-link`,       callback_data: "wiz_toggle:antiLink" },
          { text: `${w.dados.bemVindo ? "✅" : "⬜"} Bem-vindo`,       callback_data: "wiz_toggle:bemVindo" },
        ],
        [{ text: `${w.dados.menuAuto ? "✅" : "⬜"} Menu automático`,  callback_data: "wiz_toggle:menuAuto" }],
        [{ text: "▶️ Continuar", callback_data: "wiz_step:respostas" }]
      ]
    }, { chat_id: chatId, message_id: msgId })
  }

  // ── NOVO: Avançar etapa do wizard
  if (action === "wiz_step") {
    const w = wizardState[chatId]
    if (!w) return

    if (id === "respostas") {
      w.step = "respostas_input"
      return bot.editMessageText(
        `*Passo 5/5 — Respostas Automáticas*\n\n` +
        `Ensine o bot a responder automaticamente!\n\n` +
        `📝 *Formato:* \`gatilho | resposta\`\n\n` +
        `*Exemplos:*\n` +
        `\`preco | Nossos preços: R$50 básico, R$100 premium 💰\`\n` +
        `\`horario | Seg a Sex, das 9h às 18h 🕘\`\n` +
        `\`pix | Nossa chave PIX: empresa@email.com 💳\`\n` +
        `\`cardapio | Acesse nosso cardápio: site.com.br/cardapio 🍽️\`\n\n` +
        `Envie uma resposta por vez. Digite \`0\` quando terminar.\n` +
        `_(Ou clique em "Usar padrão" para pular esta etapa)_`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "⚡ Usar respostas padrão", callback_data: "wiz_step:finalizar" }
            ]]
          }
        }
      )
    }

    if (id === "finalizar") {
      return await finalizarWizard(chatId)
    }
  }

  // ── Novo Bot (com opção de criar WPP)
  if (action === "menu_new") {
    return bot.editMessageText(
      "➕ *Novo Bot*\n\n" +
      "Escolha como criar seu bot:\n\n" +
      "🤖 *Criar Bot WhatsApp* — wizard guiado, sem código!\n" +
      "📎 *Enviar ZIP* — upload do seu código (até 20MB)\n" +
      "🔗 *Link direto* — envie a URL do ZIP aqui\n" +
      "🌐 *Upload web* — sem limite de tamanho",
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🤖 Criar Bot WhatsApp",    callback_data: "menu_criar_wpp" }],
            [{ text: "🌐 Gerar link de upload",   callback_data: "gen_upload" }],
            [{ text: "⚡ Criar com Builder Visual", callback_data: "menu_builder" }],
            [{ text: "⬅️ Voltar",                callback_data: "menu_home" }]
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
      `⚡ *ARES BUILDER*\n\nCrie seu bot WhatsApp visualmente arrastando blocos, sem escrever código.\n\nClique no botão abaixo para abrir o editor:`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚡ Abrir ARES BUILDER", url }],
            [{ text: "⬅️ Voltar", callback_data: "menu_new" }]
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
        "📂 *Meus Bots*\n\nNenhum bot hospedado ainda.\nUse Novo Bot para criar ou fazer upload!",
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
      text: `${activeBots[f] ? "🟢" : "🔴"} ${getMeta(f)?.name || f}`,
      callback_data: `manage:${f}`
    }])
    buttons.push([{ text: "⬅️ Voltar", callback_data: "menu_home" }])
    return bot.editMessageText(
      `📂 *Meus Bots*\n\n🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*  |  Total: *${s.total}*\n\nEscolha um bot:`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
    )
  }

  // ── Estatisticas
  if (action === "menu_stats") {
    const s = getStats(chatId)
    return bot.editMessageText(
      `📊 *Estatisticas*\n\n🤖 Total: *${s.total}*\n🟢 Online: *${s.online}*\n🔴 Offline: *${s.offline}*\n💾 RAM: *${s.ram}MB*\n⏱ Uptime: *${s.uptime}*`,
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
    const logSize = fs.existsSync(logPath) ? (fs.statSync(logPath).size / 1024).toFixed(1) + " KB" : "0 KB"
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nNome: *${getMeta(id)?.name || id}*\nStatus: ${isRunning ? "🟢 Online" : "🔴 Offline"}\nLog: ${logSize}`,
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
    setTimeout(() => { delete uploadTokens[token] }, 15 * 60 * 1000)
    const uploadUrl = `${DOMAIN}/upload/${token}`
    return bot.editMessageText(
      `🌐 *Link de Upload Gerado*\n\nAcesse a pagina abaixo, escolha o .zip e o nome do bot:\n\n⏳ Expira em *15 minutos*`,
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
            [{ text: "▶️ Iniciar", callback_data: `start:${id}` }, { text: "🔄 Reiniciar", callback_data: `restart:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
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
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "🛑 Parar", callback_data: `stop:${id}` }, { text: "🔄 Reiniciar", callback_data: `restart:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
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
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "🛑 Parar", callback_data: `stop:${id}` }, { text: "🔄 Reiniciar", callback_data: `restart:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
})

// ─── Rotas web ────────────────────────────────

app.get("/builder", (req, res) => {
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).send("Acesso negado. Abra pelo Telegram.")
  const builderPath = path.join(__dirname, "builder.html")
  if (!fs.existsSync(builderPath)) return res.status(404).send("builder.html não encontrado")
  res.send(fs.readFileSync(builderPath, "utf8"))
})

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
    fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: instancePath })).on("close", resolve).on("error", reject)
  })
  await flattenIfNeeded(instancePath)
  saveMeta(botId, chatId, name)
  const sess = genWebSession(chatId)
  spawnBot(botId, instancePath)
  res.json({ ok: true, botId, manageUrl: `${DOMAIN}/terminal/${botId}?s=${sess}` })
  bot.sendMessage(chatId, `🚀 *Bot hospedado pelo Builder!*\n\n🤖 *Nome:* ${name}\n🆔 *ID:* \`${botId}\`\n\nInstalando dependências e iniciando...`, { parse_mode: "Markdown" })
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
socket.on("connect",()=>{term.clear();socket.emit("request-history",{botId})})
socket.on("history-"+botId,data=>{term.write(data)})
socket.on("log-"+botId,data=>term.write(data))
term.onData(data=>socket.emit("input",{botId,data}))
</script>
</body>
</html>`)
})

// ─── Upload via Web ──────────────────────────

app.get("/upload/:token", (req, res) => {
  const info = uploadTokens[req.params.token]
  if (!info) return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ARES HOST</title><style>body{background:#0a0a0a;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{text-align:center;padding:40px;border:1px solid #333;border-radius:12px}h2{color:#f44;margin:0 0 10px}</style></head><body><div class="box"><h2>❌ Link inválido ou expirado</h2><p>Gere um novo link pelo Telegram.</p></div></body></html>`)
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ARES HOST — Upload</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#111;border:1px solid #222;border-radius:16px;padding:36px;width:100%;max-width:480px;box-shadow:0 0 40px rgba(0,255,100,0.05)}.logo{color:#0f0;font-size:22px;font-weight:bold;margin-bottom:6px}.sub{color:#555;font-size:13px;margin-bottom:28px}.drop{border:2px dashed #2a2a2a;border-radius:12px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .2s;position:relative}.drop:hover,.drop.over{border-color:#0f0;background:#0a1a0a}.drop input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}.drop-icon{font-size:36px;margin-bottom:10px}.drop-text{color:#555;font-size:14px}.drop-text span{color:#0f0}.file-info{margin-top:16px;background:#1a1a1a;border-radius:8px;padding:12px 16px;display:none;align-items:center;gap:10px}.file-info.show{display:flex}.file-name{flex:1;font-size:13px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-size{color:#555;font-size:12px;white-space:nowrap}label{display:block;margin-top:20px;margin-bottom:6px;font-size:13px;color:#888}input[type=text]{width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;color:#fff;font-size:14px;outline:none;transition:border .2s}input[type=text]:focus{border-color:#0f0}.btn{margin-top:22px;width:100%;background:#0f0;color:#000;border:none;border-radius:8px;padding:13px;font-size:15px;font-weight:bold;cursor:pointer;transition:opacity .2s}.btn:hover{opacity:.85}.btn:disabled{opacity:.4;cursor:not-allowed}.progress{margin-top:16px;display:none}.progress.show{display:block}.bar-bg{background:#1a1a1a;border-radius:99px;height:6px;overflow:hidden}.bar{height:100%;background:#0f0;width:0%;transition:width .3s;border-radius:99px}.status{margin-top:10px;font-size:13px;color:#555;text-align:center}.status.ok{color:#0f0}.status.err{color:#f44}</style>
</head>
<body>
<div class="card">
  <div class="logo">🚀 ARES HOST</div>
  <div class="sub">Upload de Bot — cole ou arraste o .zip</div>
  <div class="drop" id="drop"><input type="file" id="fileInput" accept=".zip"><div class="drop-icon">📦</div><div class="drop-text">Arraste o <span>.zip</span> aqui ou clique</div></div>
  <div class="file-info" id="fileInfo"><span>📄</span><span class="file-name" id="fileName"></span><span class="file-size" id="fileSize"></span></div>
  <label>Nome do bot</label>
  <input type="text" id="botName" placeholder="ex: meubot, vendas, suporte" maxlength="40">
  <button class="btn" id="btn" disabled onclick="doUpload()">Enviar Bot</button>
  <div class="progress" id="progress"><div class="bar-bg"><div class="bar" id="bar"></div></div><div class="status" id="status">Enviando...</div></div>
</div>
<script>
const token="${req.params.token}"
const fileInput=document.getElementById("fileInput"),drop=document.getElementById("drop"),btn=document.getElementById("btn"),botNameInput=document.getElementById("botName")
function formatSize(b){return b>1024*1024?(b/1024/1024).toFixed(1)+" MB":(b/1024).toFixed(0)+" KB"}
function checkReady(){btn.disabled=!(fileInput.files[0]&&botNameInput.value.trim().length>0)}
fileInput.addEventListener("change",()=>{const f=fileInput.files[0];if(!f)return;document.getElementById("fileName").textContent=f.name;document.getElementById("fileSize").textContent=formatSize(f.size);document.getElementById("fileInfo").classList.add("show");checkReady()})
botNameInput.addEventListener("input",checkReady)
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("over")})
drop.addEventListener("dragleave",()=>drop.classList.remove("over"))
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("over");const f=e.dataTransfer.files[0];if(!f||!f.name.endsWith(".zip"))return alert("Apenas .zip!");const dt=new DataTransfer();dt.items.add(f);fileInput.files=dt.files;fileInput.dispatchEvent(new Event("change"))})
function doUpload(){const f=fileInput.files[0],name=botNameInput.value.trim().replace(/\s+/g,"_").toLowerCase();if(!f||!name)return;btn.disabled=true;const prog=document.getElementById("progress"),bar=document.getElementById("bar"),status=document.getElementById("status");prog.classList.add("show");const fd=new FormData();fd.append("file",f);fd.append("name",name);const xhr=new XMLHttpRequest();xhr.open("POST","/upload/"+token);xhr.upload.onprogress=e=>{if(e.lengthComputable){const pct=Math.round(e.loaded/e.total*100);bar.style.width=pct+"%";status.textContent="Enviando... "+pct+"%"}};xhr.onload=()=>{if(xhr.status===200){bar.style.width="100%";status.textContent="✅ Bot enviado! Verifique o Telegram.";status.className="status ok"}else{status.textContent="❌ Erro: "+xhr.responseText;status.className="status err";btn.disabled=false}};xhr.onerror=()=>{status.textContent="❌ Erro de conexão.";status.className="status err";btn.disabled=false};xhr.send(fd)}
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
      const rel = base ? base + "/" + e.name : e.name
      const full = path.join(dir, e.name)
      if (e.isDirectory()) result.push({ type: "dir", name: e.name, path: rel, children: walkDir(full, rel) })
      else result.push({ type: "file", name: e.name, path: rel })
    }
  } catch(e) {}
  return result.sort((a, b) => { if (a.type !== b.type) return a.type === "dir" ? -1 : 1; return a.name.localeCompare(b.name) })
}

app.use("/files", authBot, (req, res, next) => {
  const rawUrl = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/^\/files\/([^/]+)\/?$/)
  if (!m) return next()
  const botId = m[1]
  const token = req.query.s || ""
  const botPath = path.join(BASE_PATH, botId)
  if (!fs.existsSync(botPath)) return res.status(404).send("Bot não encontrado")
  // (HTML do editor omitido para brevidade — igual ao original)
  res.send(`<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px;text-align:center"><h2>📁 Editor de Arquivos</h2><p>Abrindo editor para: ${botId}</p></body></html>`)
})

app.use("/files-api", authBot, (req, res, next) => {
  const rawUrl  = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/^\/files-api\/([^/]+)(\/[^?/]*)/)
  if (!m) return next()
  const botId  = m[1], action = m[2]
  const botPath = path.join(BASE_PATH, botId)
  if (action === "/tree") { if (!fs.existsSync(botPath)) return res.status(404).json([]); return res.json(walkDir(botPath, "")) }
  if (action === "/read") {
    const fp = path.normalize(path.join(botPath, req.query.path || ""))
    if (!fp.startsWith(botPath + path.sep) && fp !== botPath) return res.status(403).send("Proibido")
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return res.status(404).send("Não encontrado")
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    return res.send(fs.readFileSync(fp, "utf8"))
  }
  express.json()(req, res, () => {
    if (action === "/write") { const fp = path.normalize(path.join(botPath, req.body.path || "")); if (!fp.startsWith(botPath)) return res.status(403).send("Proibido"); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, req.body.content || ""); return res.send("ok") }
    if (action === "/delete") { const fp = path.normalize(path.join(botPath, req.body.path || "")); if (!fp.startsWith(botPath)) return res.status(403).send("Proibido"); if (!fs.existsSync(fp)) return res.status(404).send("Não encontrado"); if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true, force: true }); else fs.unlinkSync(fp); return res.send("ok") }
    if (action === "/mkdir") { const dp = path.normalize(path.join(botPath, req.body.path || "")); if (!dp.startsWith(botPath)) return res.status(403).send("Proibido"); fs.mkdirSync(dp, { recursive: true }); return res.send("ok") }
    if (action === "/rename") { const from = path.normalize(path.join(botPath, req.body.from || "")), to = path.normalize(path.join(botPath, req.body.to || "")); if (!from.startsWith(botPath) || !to.startsWith(botPath)) return res.status(403).send("Proibido"); if (!fs.existsSync(from)) return res.status(404).send("Não encontrado"); fs.renameSync(from, to); return res.send("ok") }
    next()
  })
})

process.on("uncaughtException", err => { if (err.code !== "EADDRINUSE") console.error(err) })

server.listen(PORT, () => {
  aresBanner()
  if (fs.existsSync(BASE_PATH)) {
    const bots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads")
    if (bots.length > 0) {
      console.log(`\n♻️  Restaurando ${bots.length} bot(s)...\n`)
      bots.forEach((botId, i) => {
        const instancePath = path.join(BASE_PATH, botId)
        const meta = getMeta(botId)
        setTimeout(() => { console.log(`  ▶ Iniciando: ${meta?.name || botId}`); spawnBot(botId, instancePath) }, i * 1500)
      })
    }
  }
})
