const TelegramBot = require("node-telegram-bot-api")
const unzipper = require("unzipper")
const pty = require("node-pty")
const fs = require("fs")
const path = require("path")
const os = require("os")
const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const { EventEmitter } = require("events")
const multer = require("multer")
const { execFile, execSync, spawn } = require("child_process")
const crypto = require("crypto")
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3")
const tar = require("tar")

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
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))
app.use(express.static("public"))

const BUCKET_CONFIG = {
  endpoint: process.env.BUCKET_ENDPOINT || "https://t3.storageapi.dev",
  region: process.env.BUCKET_REGION || "auto",
  credentials: {
    accessKeyId: process.env.BUCKET_ACCESS_KEY_ID || "tid_fJEjO_LbZVrFtJEwWHkcSqT_IxIwYsahKIyqSlegejHUTbNNHB",
    secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY || "tsec_IjNC_oqgdq7-F9o067zq0C+h2INzkP8Ns-WbaU3vnu+gfUM49IbVMJHgaAeSG3GHNBml-L",
  },
  bucketName: process.env.BUCKET_NAME || "assembled-pannier-fd6o1qb"
}

console.log("✅ Storage Bucket configurado:", BUCKET_CONFIG.bucketName)

const s3Client = new S3Client({
  endpoint: BUCKET_CONFIG.endpoint,
  region: BUCKET_CONFIG.region,
  credentials: BUCKET_CONFIG.credentials,
  forcePathStyle: true
})

const BASE_PATH = path.resolve(process.cwd(), "instances")
console.log("📁 BASE_PATH:", BASE_PATH)

try {
  if (!fs.existsSync(BASE_PATH)) {
    fs.mkdirSync(BASE_PATH, { recursive: true, mode: 0o755 })
    console.log("✅ Pasta instances criada")
  } else {
    console.log("✅ Pasta instances já existe")
  }
  fs.accessSync(BASE_PATH, fs.constants.W_OK)
  console.log("✅ Permissão de escrita OK")
  const testFile = path.join(BASE_PATH, "test.txt")
  fs.writeFileSync(testFile, "test")
  fs.unlinkSync(testFile)
  console.log("✅ Teste de escrita OK")
} catch (err) {
  console.error("❌ Erro com pasta instances:", err)
}

const activeBots = {}
const userState = {}
const usedPorts = new Set()
const uploadTokens = {}
const webSessions = {}
const logBuffers = {}
const PORT_START = 4000

const LOG_CONFIG = {
  MAX_SIZE: 100 * 1024,
  BUFFER_TIME: 5000
}

function saveMeta(botId, chatId, name) {
  try {
    const botPath = path.join(BASE_PATH, botId)
    if (!fs.existsSync(botPath)) {
      fs.mkdirSync(botPath, { recursive: true, mode: 0o755 })
    }
    const mp = path.join(botPath, "meta.json")
    fs.writeFileSync(mp, JSON.stringify({
      owner: String(chatId),
      name,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      nodeModulesHash: null
    }))
    console.log(`✅ Meta salva para ${botId}`)
    return true
  } catch (err) {
    console.error(`❌ Erro ao salvar meta para ${botId}:`, err)
    return false
  }
}

function getMeta(botId) {
  try {
    const metaPath = path.join(BASE_PATH, botId, "meta.json")
    if (!fs.existsSync(metaPath)) return null
    return JSON.parse(fs.readFileSync(metaPath, "utf8"))
  } catch { return null }
}

function updateMetaAccess(botId) {
  const meta = getMeta(botId)
  if (meta) {
    meta.lastAccessed = Date.now()
    fs.writeFileSync(path.join(BASE_PATH, botId, "meta.json"), JSON.stringify(meta))
  }
}

function updateNodeModulesHash(botId, hash) {
  const meta = getMeta(botId)
  if (meta) {
    meta.nodeModulesHash = hash
    fs.writeFileSync(path.join(BASE_PATH, botId, "meta.json"), JSON.stringify(meta))
  }
}

function getOwner(botId) {
  const m = getMeta(botId)
  return m ? m.owner : null
}

function getUserBots(chatId) {
  if (!fs.existsSync(BASE_PATH)) return []
  return fs.readdirSync(BASE_PATH).filter(f => {
    if (f === "_uploads" || f === "_users" || f === ".git" || f === "node_modules") return false
    const fullPath = path.join(BASE_PATH, f)
    if (!fs.existsSync(fullPath)) return false
    try {
      if (!fs.statSync(fullPath).isDirectory()) return false
      return getOwner(f) === String(chatId)
    } catch { return false }
  })
}

function genWebSession(chatId) {
  const tok = crypto.randomBytes(24).toString("hex")
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
  let botId = null
  const mApi = rawUrl.match(/^\/files-api\/([^/]+)/)
  const mPage = rawUrl.match(/^\/(?:terminal|files)\/([^/?]+)/)
  if (mApi) botId = mApi[1]
  else if (mPage) botId = mPage[1]
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).send("Acesso negado. Abra o link pelo Telegram.")
  const owner = botId ? getOwner(botId) : null
  if (owner && owner !== chatId) return res.status(403).send("Este bot pertence a outro usuário.")
  if (botId) updateMetaAccess(botId)
  req.chatId = chatId
  req.botId = botId
  next()
}

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

function getStats(chatId = null) {
  let bots = []
  if (chatId) {
    bots = getUserBots(chatId)
  } else {
    bots = fs.existsSync(BASE_PATH)
      ? fs.readdirSync(BASE_PATH).filter(f => {
          if (f === "_uploads" || f === "_users" || f === ".git" || f === "node_modules") return false
          const fullPath = path.join(BASE_PATH, f)
          if (!fs.existsSync(fullPath)) return false
          try { return fs.statSync(fullPath).isDirectory() } catch { return false }
        })
      : []
  }
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
  let diskUsage = "N/A"
  try {
    const df = execSync("df -h / | tail -1").toString()
    const parts = df.split(/\s+/)
    diskUsage = `${parts[4]} (${parts[2]}/${parts[1]})`
  } catch {}
  console.log(`\n🚀 ARES HOST (STORAGE BUCKET)
📦 BOTS: ${s.total}
🟢 ONLINE: ${s.online}
🔴 OFFLINE: ${s.offline}
💾 RAM: ${s.ram}MB
⏱ UPTIME: ${s.uptime}
💿 DISCO: ${diskUsage}
☁️  BUCKET: ${BUCKET_CONFIG.bucketName}\n`)
}

function getPackageHash(packagePath) {
  try {
    const content = fs.readFileSync(packagePath, "utf8")
    return crypto.createHash("md5").update(content).digest("hex").substring(0, 12)
  } catch { return null }
}

async function checkNodeModulesInBucket(botId, packageHash) {
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `${botId}_${packageHash}.tar.gz`
    }))
    return true
  } catch (error) {
    if (error.name === "NotFound") return false
    console.error("Erro ao verificar bucket:", error)
    return false
  }
}

async function uploadNodeModulesToBucket(botId, nodeModulesPath, packageHash) {
  const tarballPath = path.join(os.tmpdir(), `${botId}_${packageHash}.tar.gz`)
  try {
    if (activeBots[botId]) writeLog(botId, path.dirname(nodeModulesPath), "📦 Compactando node_modules...\r\n")
    await tar.c({ gzip: true, file: tarballPath, cwd: path.dirname(nodeModulesPath) }, [path.basename(nodeModulesPath)])
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `${botId}_${packageHash}.tar.gz`,
      Body: fs.createReadStream(tarballPath),
      ContentType: "application/gzip"
    }))
    if (activeBots[botId]) writeLog(botId, path.dirname(nodeModulesPath), "✅ node_modules salvo no bucket\r\n")
    updateNodeModulesHash(botId, packageHash)
    return true
  } catch (error) {
    if (activeBots[botId]) writeLog(botId, path.dirname(nodeModulesPath), `❌ Erro ao enviar para bucket: ${error.message}\r\n`)
    return false
  } finally {
    try { fs.unlinkSync(tarballPath) } catch {}
  }
}

async function downloadNodeModulesFromBucket(botId, targetPath, packageHash) {
  const tarballPath = path.join(os.tmpdir(), `${botId}_${packageHash}.tar.gz`)
  try {
    if (activeBots[botId]) writeLog(botId, targetPath, "📥 Baixando node_modules do bucket...\r\n")
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `${botId}_${packageHash}.tar.gz`
    }))
    await new Promise((resolve, reject) => {
      response.Body.pipe(fs.createWriteStream(tarballPath)).on("finish", resolve).on("error", reject)
    })
    await tar.x({ file: tarballPath, cwd: targetPath, gzip: true })
    if (activeBots[botId]) writeLog(botId, targetPath, "✅ node_modules restaurado do bucket\r\n")
    return true
  } catch (error) {
    if (activeBots[botId]) writeLog(botId, targetPath, `❌ Erro ao baixar do bucket: ${error.message}\r\n`)
    return false
  } finally {
    try { fs.unlinkSync(tarballPath) } catch {}
  }
}

async function saveBotFilesToBucket(botId) {
  const botPath = path.join(BASE_PATH, botId)
  if (!fs.existsSync(botPath)) return false
  const tarballPath = path.join(os.tmpdir(), `files_${botId}.tar.gz`)
  try {
    const entries = fs.readdirSync(botPath).filter(f => f !== "node_modules" && f !== "terminal.log")
    if (entries.length === 0) return false
    await tar.c({ gzip: true, file: tarballPath, cwd: botPath }, entries)
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `files_${botId}.tar.gz`,
      Body: fs.createReadStream(tarballPath),
      ContentType: "application/gzip"
    }))
    console.log(`☁️  Arquivos do ${botId} salvos no bucket`)
    return true
  } catch (err) {
    console.error(`Erro ao salvar arquivos do ${botId}:`, err.message)
    return false
  } finally {
    try { fs.unlinkSync(tarballPath) } catch {}
  }
}

async function restoreBotFilesFromBucket(botId) {
  const botPath = path.join(BASE_PATH, botId)
  const tarballPath = path.join(os.tmpdir(), `files_${botId}.tar.gz`)
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `files_${botId}.tar.gz`
    }))
    if (!fs.existsSync(botPath)) fs.mkdirSync(botPath, { recursive: true, mode: 0o755 })
    await new Promise((resolve, reject) => {
      response.Body.pipe(fs.createWriteStream(tarballPath)).on("finish", resolve).on("error", reject)
    })
    await tar.x({ file: tarballPath, cwd: botPath, gzip: true })
    console.log(`✅ Arquivos do ${botId} restaurados do bucket`)
    return true
  } catch (err) {
    if (err.name !== "NoSuchKey" && err.name !== "NotFound") {
      console.error(`Erro ao restaurar ${botId}:`, err.message)
    }
    return false
  } finally {
    try { fs.unlinkSync(tarballPath) } catch {}
  }
}

async function listBotsInBucket() {
  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET_CONFIG.bucketName,
      Prefix: "files_"
    }))
    return (response.Contents || [])
      .map(o => o.Key.replace("files_", "").replace(".tar.gz", ""))
      .filter(Boolean)
  } catch (err) {
    console.error("Erro ao listar bots no bucket:", err.message)
    return []
  }
}

async function restoreAllBotsFromBucket() {
  console.log("☁️  Verificando bots no bucket...")
  const botsInBucket = await listBotsInBucket()
  if (botsInBucket.length === 0) { console.log("📭 Nenhum bot no bucket"); return }
  console.log(`📦 ${botsInBucket.length} bot(s) encontrados no bucket`)
  for (const botId of botsInBucket) {
    const botPath = path.join(BASE_PATH, botId)
    if (!fs.existsSync(botPath) || !fs.existsSync(path.join(botPath, "meta.json"))) {
      console.log(`📥 Restaurando ${botId}...`)
      await restoreBotFilesFromBucket(botId)
    } else {
      console.log(`✅ ${botId} já existe localmente`)
    }
  }
}

setInterval(async () => {
  const bots = fs.existsSync(BASE_PATH)
    ? fs.readdirSync(BASE_PATH).filter(f => {
        if (f === "_uploads" || f === "_users" || f === ".git" || f === "node_modules") return false
        return fs.statSync(path.join(BASE_PATH, f)).isDirectory()
      })
    : []
  for (const botId of bots) await saveBotFilesToBucket(botId)
}, 10 * 60 * 1000)

function writeLog(botId, instancePath, data) {
  if (!logBuffers[botId]) {
    logBuffers[botId] = []
    const interval = setInterval(() => {
      if (logBuffers[botId] && logBuffers[botId].length > 0) {
        const logPath = path.join(instancePath, "terminal.log")
        const content = logBuffers[botId].join("")
        logBuffers[botId] = []
        try {
          fs.appendFileSync(logPath, content)
          if (fs.statSync(logPath).size > LOG_CONFIG.MAX_SIZE) {
            const oldContent = fs.readFileSync(logPath, "utf8")
            const lines = oldContent.split("\n").slice(-200).join("\n")
            fs.writeFileSync(logPath, lines)
          }
        } catch {}
        io.emit("log-" + botId, content)
      }
      if (!activeBots[botId] && (!logBuffers[botId] || logBuffers[botId].length === 0)) {
        clearInterval(interval)
        delete logBuffers[botId]
      }
    }, LOG_CONFIG.BUFFER_TIME)
  }
  logBuffers[botId].push(data)
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
  return null
}

function checkNativeModules(nodeModulesPath) {
  const nativeModules = ["sqlite3", "bcrypt", "sharp", "canvas", "grpc", "better-sqlite3", "utf-8-validate", "bufferutil"]
  for (const mod of nativeModules) {
    const modPath = path.join(nodeModulesPath, mod)
    if (fs.existsSync(modPath)) {
      const walk = (dir) => {
        const files = fs.readdirSync(dir)
        for (const file of files) {
          const full = path.join(dir, file)
          const stat = fs.statSync(full)
          if (stat.isDirectory()) { if (walk(full)) return true }
          else if (file.endsWith(".node")) return true
        }
        return false
      }
      if (walk(modPath)) return true
    }
  }
  return false
}

function rebuildNativeModules(instancePath) {
  return new Promise((resolve) => {
    const env = { ...process.env, npm_config_force: "true" }
    const rebuild = pty.spawn(
      os.platform() === "win32" ? "npm.cmd" : "npm",
      ["rebuild"],
      { name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env }
    )
    rebuild.onData(d => { const botId = path.basename(instancePath); writeLog(botId, instancePath, d) })
    rebuild.onExit(resolve)
  })
}

function runInstance(botId, instancePath, botPort, env, start) {
  const child = pty.spawn(start.cmd, start.args, {
    name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env
  })
  activeBots[botId] = { process: child, port: botPort, path: instancePath }
  child.onData(d => writeLog(botId, instancePath, d))
  child.onExit(() => { releasePort(botPort); delete activeBots[botId]; aresBanner() })
  aresBanner()
}

async function spawnBot(botId, instancePath) {
  if (activeBots[botId]) {
    try { activeBots[botId].process.kill() } catch {}
    delete activeBots[botId]
  }
  const botPort = getFreePort()
  const env = {
    ...process.env,
    PORT: botPort.toString(),
    NODE_ENV: "production",
    FORCE_COLOR: "3",
    TERM: "xterm-256color"
  }
  updateMetaAccess(botId)
  const start = detectStart(instancePath)
  if (!start) {
    writeLog(botId, instancePath, "❌ Nenhum start detectado\r\n")
    return
  }
  const nodeModulesPath = path.join(instancePath, "node_modules")
  if (fs.existsSync(nodeModulesPath)) {
    writeLog(botId, instancePath, "✅ Usando node_modules existente\r\n")
    runInstance(botId, instancePath, botPort, env, start)
    return
  }
  if (fs.existsSync(path.join(instancePath, "package.json"))) {
    const packagePath = path.join(instancePath, "package.json")
    const packageHash = getPackageHash(packagePath)
    if (packageHash) {
      const exists = await checkNodeModulesInBucket(botId, packageHash)
      if (exists) {
        writeLog(botId, instancePath, "📥 Baixando node_modules do bucket...\r\n")
        const downloaded = await downloadNodeModulesFromBucket(botId, instancePath, packageHash)
        if (downloaded && fs.existsSync(nodeModulesPath)) {
          if (checkNativeModules(nodeModulesPath)) {
            writeLog(botId, instancePath, "🔄 Recompilando módulos nativos...\r\n")
            await rebuildNativeModules(instancePath)
          }
          runInstance(botId, instancePath, botPort, env, start)
          return
        }
      }
    }
    writeLog(botId, instancePath, "📦 Instalando dependencias...\r\n")
    if (fs.existsSync(nodeModulesPath)) fs.rmSync(nodeModulesPath, { recursive: true, force: true })
    const install = pty.spawn(
      os.platform() === "win32" ? "npm.cmd" : "npm",
      ["install", "--production", "--no-audit", "--no-fund"],
      { name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env }
    )
    install.onData(d => writeLog(botId, instancePath, d))
    install.onExit(async () => {
      if (fs.existsSync(nodeModulesPath)) {
        if (checkNativeModules(nodeModulesPath)) {
          writeLog(botId, instancePath, "🔄 Recompilando módulos nativos...\r\n")
          await rebuildNativeModules(instancePath)
        }
        const packageHash = getPackageHash(path.join(instancePath, "package.json"))
        if (packageHash) {
          writeLog(botId, instancePath, "📤 Salvando node_modules no bucket...\r\n")
          await uploadNodeModulesToBucket(botId, nodeModulesPath, packageHash)
        }
      }
      runInstance(botId, instancePath, botPort, env, start)
    })
  } else {
    runInstance(botId, instancePath, botPort, env, start)
  }
}

io.on("connection", socket => {
  socket.on("request-history", ({ botId }) => {
    const logPath = path.join(BASE_PATH, botId, "terminal.log")
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf8")
      socket.emit("history-" + botId, content)
    }
  })
  socket.on("input", ({ botId, data }) => {
    if (activeBots[botId]) activeBots[botId].process.write(data)
  })
})

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

const TERMOS_TEXTO = `📋 *Termos de Uso — ARES HOST*

Antes de continuar, leia e aceite os termos abaixo:

*1. Uso permitido*
Apenas bots legítimos são permitidos.

*2. Responsabilidade*
Você é responsável pelo conteúdo do seu bot.

*3. Disponibilidade*
O serviço pode passar por manutenções.

*4. Dados*
Seus arquivos ficam armazenados em nossos servidores.

*5. Encerramento*
Reservamos o direito de encerrar bots que violem estes termos.

──────────────────────`

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

bot.onText(/^\/meuid$/, msg => {
  bot.sendMessage(msg.chat.id, `🪪 *Seu Telegram ID:*\n\n\`${msg.chat.id}\``, { parse_mode: "Markdown" })
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
    `🤖 Seus Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
    `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
          [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
          [{ text: "📊 Estatisticas", callback_data: "menu_stats" }]
        ]
      }
    }
  )
})

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? require("https") : require("http")
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
    .on("close", async () => {
      flattenIfNeeded(instancePath)
      const nm = path.join(instancePath, "node_modules")
      if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true })
      await saveBotFilesToBucket(botId)
      spawnBot(botId, instancePath)
      const sessionToken = genWebSession(loadingMsg.chat.id)
      const terminalUrl = `${DOMAIN}/terminal/${botId}?s=${sessionToken}`
      const filesUrl = `${DOMAIN}/files/${botId}?s=${sessionToken}`
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
              [{ text: "📟 Terminal", url: terminalUrl }],
              [{ text: "📁 Arquivos", url: filesUrl }],
              [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
            ]
          }
        }
      )
    })
    .on("error", err => {
      bot.editMessageText(`❌ Erro ao extrair: ${err.message}`, {
        chat_id: loadingMsg.chat.id,
        message_id: loadingMsg.message_id
      })
    })
}

bot.on("document", async msg => {
  const chatId = msg.chat.id
  if (!hasAccepted(chatId)) {
    termoCheck[chatId] = false
    return sendTermos(chatId, false)
  }
  if (!msg.document.file_name.toLowerCase().endsWith(".zip")) {
    return bot.sendMessage(chatId, "⚠️ *Arquivo invalido!*\n\nEnvie um arquivo .zip com o codigo do bot.", { parse_mode: "Markdown" })
  }
  const fileSizeMB = (msg.document.file_size / 1024 / 1024).toFixed(1)
  userState[chatId] = { fileId: msg.document.file_id }
  bot.sendMessage(chatId,
    `✅ *ZIP recebido* (${fileSizeMB}MB)\n\nAgora envie um *nome* para o bot:\n(ex: meubot, vendas, suporte)`,
    { parse_mode: "Markdown" }
  )
})

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
    if (/^https?:\/\//i.test(text)) {
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
  fs.mkdirSync(instancePath, { recursive: true, mode: 0o755 })
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
    bot.editMessageText(`❌ Erro ao baixar: ${err.message}`, {
      chat_id: loadingMsg.chat.id,
      message_id: loadingMsg.message_id
    })
  }
})

bot.on("callback_query", async query => {
  const chatId = query.message.chat.id
  const msgId = query.message.message_id
  const data = query.data
  const colonIdx = data.indexOf(":")
  const action = colonIdx === -1 ? data : data.slice(0, colonIdx)
  const id = colonIdx === -1 ? null : data.slice(colonIdx + 1)
  bot.answerCallbackQuery(query.id)

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
      `✅ *Termos aceitos! Bem-vindo ao ARES HOST.*\n\n` +
      `🚀 *ARES HOST*\n\n` +
      `🤖 Seus Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
            [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
            [{ text: "📊 Estatisticas", callback_data: "menu_stats" }]
          ]
        }
      }
    )
  }
  if (action === "menu_home") {
    const s = getStats(chatId)
    return bot.editMessageText(
      `🚀 *ARES HOST*\n\n` +
      `🤖 Seus Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
            [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
            [{ text: "📊 Estatisticas", callback_data: "menu_stats" }]
          ]
        }
      }
    )
  }
  if (action === "menu_new") {
    return bot.editMessageText(
      "➕ *Novo Bot*\n\n" +
      "Escolha como criar seu bot:\n\n" +
      "📎 Envie um arquivo .zip (ate 20MB)\n" +
      "🔗 Envie um link publico do ZIP\n" +
      "🌐 Use a pagina de upload (sem limite)\n" +
      "🆕 Crie um bot do zero com editor",
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Upload via Web", callback_data: "gen_upload" }],
            [{ text: "🆕 Criar do Zero", callback_data: "create_from_scratch" }],
            [{ text: "⬅️ Voltar", callback_data: "menu_home" }]
          ]
        }
      }
    )
  }
  if (action === "gen_upload") {
    const token = crypto.randomBytes(16).toString("hex")
    uploadTokens[token] = { chatId, createdAt: Date.now() }
    setTimeout(() => { delete uploadTokens[token] }, 15 * 60 * 1000)
    const uploadUrl = `${DOMAIN}/upload/${token}`
    return bot.editMessageText(
      `🌐 *Link de Upload Gerado*\n\n` +
      `Acesse a pagina abaixo, escolha o .zip e o nome do bot:\n\n` +
      `⏳ Expira em *15 minutos*`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Abrir pagina de upload", url: uploadUrl }],
            [{ text: "⬅️ Voltar", callback_data: "menu_new" }]
          ]
        }
      }
    )
  }
  if (action === "create_from_scratch") {
    try {
      console.log("🆕 Criando bot do zero para:", chatId)
      const botId = generateBotId()
      const instancePath = path.join(BASE_PATH, botId)
      console.log("📁 Criando pasta:", instancePath)
      fs.mkdirSync(instancePath, { recursive: true, mode: 0o755 })
      const packageJson = {
        name: "meu-bot",
        version: "1.0.0",
        description: "Bot criado do zero",
        main: "index.js",
        scripts: { start: "node index.js" },
        dependencies: {}
      }
      fs.writeFileSync(path.join(instancePath, "package.json"), JSON.stringify(packageJson, null, 2))
      console.log("✅ package.json criado")
      const indexJs = `console.log("🤖 Bot iniciado com sucesso!");

const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot está rodando!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(\`🚀 Servidor rodando na porta \${PORT}\`);
});

process.on('uncaughtException', (err) => {
  console.error('Erro não tratado:', err);
});`
      fs.writeFileSync(path.join(instancePath, "index.js"), indexJs)
      console.log("✅ index.js criado")
      fs.writeFileSync(path.join(instancePath, "README.md"), "# Meu Bot\n\nBot criado do zero no ARES HOST.")
      console.log("✅ README.md criado")
      saveMeta(botId, chatId, "meu-bot")
      console.log("✅ Meta salva")
      await saveBotFilesToBucket(botId)
      const sessionToken = genWebSession(chatId)
      const editorUrl = `${DOMAIN}/files/${botId}?s=${sessionToken}`
      const terminalUrl = `${DOMAIN}/terminal/${botId}?s=${sessionToken}`
      console.log("✅ Bot criado com sucesso:", botId)
      return bot.editMessageText(
        `✅ *Bot criado do zero!*\n\n` +
        `🆔 ID: \`${botId}\`\n` +
        `📁 Estrutura básica criada:\n` +
        `• package.json\n` +
        `• index.js\n` +
        `• README.md\n\n` +
        `Agora edite os arquivos e depois inicie o bot.`,
        {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📁 Abrir Editor", url: editorUrl }],
              [{ text: "📟 Abrir Terminal", url: terminalUrl }],
              [{ text: "▶️ Iniciar Bot", callback_data: `start:${botId}` }],
              [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
            ]
          }
        }
      )
    } catch (err) {
      console.error("❌ Erro ao criar bot do zero:", err)
      return bot.editMessageText(
        `❌ *Erro ao criar bot:*\n\n${err.message}`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      )
    }
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
              [{ text: "⬅️ Voltar", callback_data: "menu_home" }]
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
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
      }
    )
  }
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
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Atualizar", callback_data: "menu_stats" }],
            [{ text: "⬅️ Voltar", callback_data: "menu_home" }]
          ]
        }
      }
    )
  }
  if (["manage", "stop", "start", "restart"].includes(action) && id) {
    if (getOwner(id) && getOwner(id) !== String(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: "❌ Esse bot não é seu!", show_alert: true })
    }
  }
  if (action === "manage" && id) {
    updateMetaAccess(id)
    const isRunning = !!activeBots[id]
    const logPath = path.join(BASE_PATH, id, "terminal.log")
    const logSize = fs.existsSync(logPath) ? (fs.statSync(logPath).size / 1024).toFixed(1) + " KB" : "0 KB"
    const sessionToken = genWebSession(chatId)
    const terminalUrl = `${DOMAIN}/terminal/${id}?s=${sessionToken}`
    const filesUrl = `${DOMAIN}/files/${id}?s=${sessionToken}`
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\n` +
      `ID: \`${id}\`\n` +
      `Status: ${isRunning ? "🟢 Online" : "🔴 Offline"}\n` +
      `Log: ${logSize}`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: terminalUrl }],
            [{ text: "📁 Arquivos", url: filesUrl }],
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
  if (action === "stop" && id) {
    if (activeBots[id]) {
      activeBots[id].process.kill()
      delete activeBots[id]
    }
    const sessionToken = genWebSession(chatId)
    const terminalUrl = `${DOMAIN}/terminal/${id}?s=${sessionToken}`
    const filesUrl = `${DOMAIN}/files/${id}?s=${sessionToken}`
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🔴 Offline`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: terminalUrl }],
            [{ text: "📁 Arquivos", url: filesUrl }],
            [{ text: "▶️ Iniciar", callback_data: `start:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
  if (action === "start" && id) {
    spawnBot(id, path.join(BASE_PATH, id))
    const sessionToken = genWebSession(chatId)
    const terminalUrl = `${DOMAIN}/terminal/${id}?s=${sessionToken}`
    const filesUrl = `${DOMAIN}/files/${id}?s=${sessionToken}`
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Iniciando...`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: terminalUrl }],
            [{ text: "📁 Arquivos", url: filesUrl }],
            [{ text: "🛑 Parar", callback_data: `stop:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
  if (action === "restart" && id) {
    spawnBot(id, path.join(BASE_PATH, id))
    const sessionToken = genWebSession(chatId)
    const terminalUrl = `${DOMAIN}/terminal/${id}?s=${sessionToken}`
    const filesUrl = `${DOMAIN}/files/${id}?s=${sessionToken}`
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Reiniciando...`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: terminalUrl }],
            [{ text: "📁 Arquivos", url: filesUrl }],
            [{ text: "🛑 Parar", callback_data: `stop:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
})

app.get("/terminal/:botId", authBot, (req, res) => {
  const botId = req.params.botId
  const sessionToken = req.query.s
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ARES Terminal - ${botId}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body { margin: 0; padding: 0; background: #000; color: #0f0; font-family: monospace; }
    #terminal { height: 100vh; width: 100vw; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script>
    const socket = io();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'monospace',
      theme: { background: '#000', foreground: '#0f0' },
      scrollback: 10000
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());
    const botId = '${botId}';
    socket.on('connect', () => {
      term.clear();
      socket.emit('request-history', { botId });
    });
    socket.on('history-' + botId, (data) => {
      term.write(data);
    });
    socket.on('log-' + botId, (data) => {
      term.write(data);
    });
    term.onData(data => {
      socket.emit('input', { botId, data });
    });
  </script>
</body>
</html>`)
})

app.get("/upload/:token", (req, res) => {
  const info = uploadTokens[req.params.token]
  if (!info) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>ARES HOST</title>
      <style>body{background:#0a0a0a;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{text-align:center;padding:40px;border:1px solid #333;border-radius:12px}
      h2{color:#f44;margin:0 0 10px}</style></head>
      <body><div class="box"><h2>❌ Link inválido ou expirado</h2><p>Gere um novo link pelo Telegram.</p></div></body>
      </html>
    `)
  }
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ARES HOST — Upload</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: 'Segoe UI', monospace; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #111; border: 1px solid #222; border-radius: 16px; padding: 36px; width: 100%; max-width: 480px; box-shadow: 0 0 40px rgba(0,255,100,0.05); }
    .logo { color: #0f0; font-size: 22px; font-weight: bold; margin-bottom: 6px; }
    .sub { color: #555; font-size: 13px; margin-bottom: 28px; }
    .drop { border: 2px dashed #2a2a2a; border-radius: 12px; padding: 40px 20px; text-align: center; cursor: pointer; transition: all .2s; position: relative; }
    .drop:hover, .drop.over { border-color: #0f0; background: #0a1a0a; }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .drop-icon { font-size: 36px; margin-bottom: 10px; }
    .drop-text { color: #555; font-size: 14px; }
    .drop-text span { color: #0f0; }
    .file-info { margin-top: 16px; background: #1a1a1a; border-radius: 8px; padding: 12px 16px; display: none; align-items: center; gap: 10px; }
    .file-info.show { display: flex; }
    .file-name { flex: 1; font-size: 13px; color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-size { color: #555; font-size: 12px; white-space: nowrap; }
    label { display: block; margin-top: 20px; margin-bottom: 6px; font-size: 13px; color: #888; }
    input[type=text] { width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 14px; color: #fff; font-size: 14px; outline: none; transition: border .2s; }
    input[type=text]:focus { border-color: #0f0; }
    .btn { margin-top: 22px; width: 100%; background: #0f0; color: #000; border: none; border-radius: 8px; padding: 13px; font-size: 15px; font-weight: bold; cursor: pointer; transition: opacity .2s; }
    .btn:hover { opacity: .85; }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .progress { margin-top: 16px; display: none; }
    .progress.show { display: block; }
    .bar-bg { background: #1a1a1a; border-radius: 99px; height: 6px; overflow: hidden; }
    .bar { height: 100%; background: #0f0; width: 0%; transition: width .3s; border-radius: 99px; }
    .status { margin-top: 10px; font-size: 13px; color: #555; text-align: center; }
    .status.ok { color: #0f0; }
    .status.err { color: #f44; }
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
    function formatSize(b) {
      if (b > 1024*1024) return (b/1024/1024).toFixed(1) + " MB"
      return (b/1024).toFixed(0) + " KB"
    }
    function checkReady() {
      btn.disabled = !(fileInput.files[0] && botNameInput.value.trim().length > 0)
    }
    fileInput.addEventListener("change", () => {
      const f = fileInput.files[0]
      if (!f) return
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
      if (!f || !f.name.endsWith(".zip")) return alert("Apenas arquivos .zip!")
      const dt = new DataTransfer()
      dt.items.add(f)
      fileInput.files = dt.files
      fileInput.dispatchEvent(new Event("change"))
    })
    function doUpload() {
      const f = fileInput.files[0]
      const name = botNameInput.value.trim().replace(/\\s+/g, "_").toLowerCase()
      if (!f || !name) return
      btn.disabled = true
      const prog = document.getElementById("progress")
      const bar = document.getElementById("bar")
      const status = document.getElementById("status")
      prog.classList.add("show")
      const fd = new FormData()
      fd.append("file", f)
      fd.append("name", name)
      const xhr = new XMLHttpRequest()
      xhr.open("POST", "/upload/" + token)
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          const pct = Math.round(e.loaded / e.total * 100)
          bar.style.width = pct + "%"
          status.textContent = "Enviando... " + pct + "%"
        }
      }
      xhr.onload = () => {
        if (xhr.status === 200) {
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
      if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath, { recursive: true, mode: 0o755 })
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
  fs.mkdirSync(instancePath, { recursive: true, mode: 0o755 })
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

function walkDir(dir, base) {
  const result = []
  try {
    if (!fs.existsSync(dir)) return result
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "bot.zip" || e.name === "meta.json") continue
      const rel = base ? base + "/" + e.name : e.name
      if (e.isDirectory()) {
        result.push({ type: "dir", name: e.name, path: rel, children: walkDir(path.join(dir, e.name), rel) })
      } else {
        result.push({ type: "file", name: e.name, path: rel })
      }
    }
  } catch (e) {
    console.error("Erro ao ler diretório:", e)
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

app.get("/files/:botId", authBot, (req, res) => {
  const botId = req.params.botId
  const sessionToken = req.query.s
  const botPath = path.join(BASE_PATH, botId)
  if (!fs.existsSync(botPath)) {
    return res.status(404).send("Bot não encontrado")
  }
  try {
    fs.accessSync(botPath, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    return res.status(403).send("Sem permissão de acesso à pasta do bot")
  }
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ARES Editor — ${botId}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --bg:#0a0e17;--bg2:#111827;--bg3:#1a2234;--bg4:#1e2a3a;
      --bd:#263046;--bd2:#334155;
      --tx:#e2e8f0;--tx2:#94a3b8;--tx3:#64748b;
      --green:#22d3a5;--green2:#16a37f;
      --blue:#60a5fa;--blue2:#3b82f6;
      --orange:#f59e0b;--red:#f87171;--red2:#ef4444;
      --purple:#a78bfa;--cyan:#67e8f9;
    }
    html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--tx);font-family:'Inter',sans-serif;font-size:14px;}
    #topbar{height:44px;background:var(--bg2);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 12px;gap:8px;flex-shrink:0;position:relative;z-index:10;}
    .logo{color:var(--green);font-weight:700;font-size:14px;letter-spacing:-.3px;display:flex;align-items:center;gap:6px;}
    .logo-dot{width:8px;height:8px;background:var(--green);border-radius:50%;animation:pulse 2s infinite;}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.5;transform:scale(.8);}}
    .bot-chip{background:var(--bg3);border:1px solid var(--bd);border-radius:6px;padding:3px 8px;font-size:11px;color:var(--tx2);font-family:'JetBrains Mono',monospace;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .sp{flex:1;}
    #status-bar-top{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--tx3);}
    #status-indicator{width:6px;height:6px;border-radius:50%;background:var(--tx3);}
    #status-indicator.ok{background:var(--green);}
    #status-indicator.err{background:var(--red);}
    #status-indicator.loading{background:var(--orange);animation:pulse .8s infinite;}
    .tbtn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;border:1px solid var(--bd);background:var(--bg3);color:var(--tx);transition:all .15s;white-space:nowrap;font-family:'Inter',sans-serif;}
    .tbtn:hover{background:var(--bg4);border-color:var(--bd2);}
    .tbtn.g{background:var(--green2);border-color:var(--green);color:#000;}
    .tbtn.g:hover{background:var(--green);}
    .tbtn.r{border-color:var(--red2);color:var(--red);}
    .tbtn.r:hover{background:rgba(248,113,113,.1);}
    #btn-menu{background:none;border:none;color:var(--tx2);font-size:20px;cursor:pointer;padding:4px;line-height:1;display:none;}
    #layout{display:flex;flex:1;overflow:hidden;height:calc(100vh - 44px);}
    #side{width:240px;background:var(--bg2);border-right:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0;transition:transform .25s;z-index:5;}
    #side-tabs{display:flex;border-bottom:1px solid var(--bd);flex-shrink:0;}
    .stab{flex:1;padding:8px 4px;text-align:center;font-size:11px;font-weight:600;color:var(--tx3);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;}
    .stab.on{color:var(--green);border-color:var(--green);}
    .stab:hover:not(.on){color:var(--tx2);}
    #panel-files,#panel-packages,#panel-search{display:none;flex-direction:column;flex:1;overflow:hidden;}
    #panel-files.on,#panel-packages.on,#panel-search.on{display:flex;}
    #side-header{padding:8px 10px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
    .s-title{font-size:10px;color:var(--tx3);text-transform:uppercase;letter-spacing:.06em;font-weight:700;}
    .s-actions{display:flex;gap:2px;}
    .ibtn{background:none;border:none;color:var(--tx2);cursor:pointer;padding:5px;border-radius:5px;font-size:14px;line-height:1;transition:all .15s;}
    .ibtn:hover{background:var(--bg3);color:var(--tx);}
    #tree{flex:1;overflow-y:auto;padding:4px 0;}
    #tree::-webkit-scrollbar,#pkg-list::-webkit-scrollbar{width:3px;}
    #tree::-webkit-scrollbar-thumb,#pkg-list::-webkit-scrollbar-thumb{background:var(--bd);}
    .row{display:flex;align-items:center;padding:5px 8px;cursor:pointer;border-radius:4px;margin:1px 4px;min-height:30px;gap:4px;position:relative;}
    .row:hover{background:var(--bg3);}
    .row.sel{background:rgba(34,211,165,.1);border-left:2px solid var(--green);}
    .row .ico{font-size:13px;width:16px;text-align:center;flex-shrink:0;}
    .row .lbl{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-family:'JetBrains Mono',monospace;}
    .row .lbl.d{color:var(--blue);}
    .row .arr{font-size:8px;color:var(--tx3);width:10px;transition:transform .15s;flex-shrink:0;}
    .row .arr.o{transform:rotate(90deg);}
    .row .arr.h{opacity:0;}
    .row-ctx{display:none;position:absolute;right:4px;top:50%;transform:translateY(-50%);gap:2px;}
    .row:hover .row-ctx{display:flex;}
    .ctx-btn{background:var(--bg2);border:1px solid var(--bd);border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;color:var(--tx2);line-height:1;}
    .ctx-btn:hover{color:var(--tx);background:var(--bg4);}
    #side-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:4;}
    #pkg-search-wrap{padding:8px;border-bottom:1px solid var(--bd);}
    .pkg-input{width:100%;background:var(--bg3);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;color:var(--tx);font-size:12px;outline:none;font-family:'Inter',sans-serif;}
    .pkg-input:focus{border-color:var(--green);}
    #pkg-install-btn{flex:1;padding:7px;border-radius:6px;background:var(--green2);border:1px solid var(--green);color:#000;font-weight:700;font-size:12px;cursor:pointer;transition:all .15s;}
    #pkg-install-btn:hover{background:var(--green);}
    #pkg-list{flex:1;overflow-y:auto;padding:4px 0;}
    .pkg-row{display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid var(--bd);gap:8px;font-size:12px;}
    .pkg-row .pname{flex:1;font-family:'JetBrains Mono',monospace;color:var(--tx);}
    .pkg-row .pver{color:var(--tx3);font-size:10px;}
    .pkg-row .pdel{background:none;border:none;color:var(--tx3);cursor:pointer;font-size:12px;padding:2px 5px;border-radius:3px;}
    .pkg-row .pdel:hover{color:var(--red);background:rgba(248,113,113,.1);}
    .pkg-empty{padding:16px;font-size:12px;color:var(--tx3);text-align:center;}
    #search-wrap{padding:8px;border-bottom:1px solid var(--bd);}
    #search-results{flex:1;overflow-y:auto;padding:4px 0;}
    .sr-item{padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--bd);}
    .sr-item:hover{background:var(--bg3);}
    .sr-file{font-size:10px;color:var(--tx3);font-family:'JetBrains Mono',monospace;}
    .sr-line{font-size:12px;color:var(--tx);margin-top:2px;font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #right{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}
    #tabs{background:var(--bg2);border-bottom:1px solid var(--bd);display:flex;overflow-x:auto;flex-shrink:0;min-height:34px;}
    #tabs::-webkit-scrollbar{height:0;}
    .tab{display:flex;align-items:center;gap:5px;padding:0 12px;height:34px;border-right:1px solid var(--bd);cursor:pointer;font-size:11px;color:var(--tx2);white-space:nowrap;flex-shrink:0;position:relative;font-family:'JetBrains Mono',monospace;transition:background .15s;}
    .tab:hover{background:var(--bg3);}
    .tab.on{color:var(--tx);background:var(--bg);}
    .tab.on::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--green);}
    .tab .x{opacity:0;font-size:10px;padding:2px 3px;border-radius:2px;color:var(--tx3);transition:.1s;}
    .tab:hover .x,.tab.on .x{opacity:1;}
    .tab .x:hover{background:var(--bd);color:var(--tx);}
    .tab .dot{width:6px;height:6px;background:var(--orange);border-radius:50%;flex-shrink:0;}
    #infobar{background:var(--bg);border-bottom:1px solid var(--bd);padding:0 12px;height:26px;display:flex;align-items:center;gap:16px;font-size:10px;color:var(--tx3);flex-shrink:0;font-family:'JetBrains Mono',monospace;}
    #infobar span{color:var(--tx2);}
    #cursor-pos{margin-left:auto;}
    #editor{flex:1;overflow:hidden;position:relative;}
    #welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--tx3);padding:40px;text-align:center;}
    .welcome-logo{font-size:64px;opacity:.15;}
    .welcome-title{font-size:18px;color:var(--tx2);font-weight:500;}
    .welcome-sub{font-size:13px;line-height:1.7;max-width:300px;}
    .welcome-keys{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px;}
    .wk{background:var(--bg3);border:1px solid var(--bd);border-radius:6px;padding:5px 10px;font-size:11px;color:var(--tx2);}
    .wk kbd{background:var(--bg4);border:1px solid var(--bd2);border-radius:3px;padding:0 4px;font-family:'JetBrains Mono',monospace;font-size:10px;}
    #statusbar{height:24px;background:#0d1525;border-top:1px solid var(--bd);display:flex;align-items:center;padding:0 10px;gap:12px;font-size:10px;color:var(--tx3);flex-shrink:0;font-family:'JetBrains Mono',monospace;}
    #statusbar .s-item{display:flex;align-items:center;gap:4px;}
    #statusbar .s-item span{color:var(--tx2);}
    .s-sep{width:1px;height:12px;background:var(--bd);}
    .ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999;align-items:flex-end;justify-content:center;backdrop-filter:blur(2px);}
    .ov.on{display:flex;}
    @media(min-width:600px){.ov{align-items:center;}}
    .box{background:var(--bg2);border:1px solid var(--bd);border-radius:14px 14px 0 0;padding:24px;width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,.5);}
    @media(min-width:600px){.box{border-radius:12px;}}
    .box h3{margin-bottom:14px;font-size:15px;font-weight:600;}
    .box input,.box textarea{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--tx);padding:10px 12px;border-radius:8px;font-size:14px;outline:none;font-family:'JetBrains Mono',monospace;margin-bottom:10px;}
    .box input:focus,.box textarea:focus{border-color:var(--green);}
    .box .bts{display:flex;gap:8px;margin-top:4px;}
    .box .bts button{flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;border:1px solid var(--bd);}
    .ok-btn{background:var(--green2);border-color:var(--green);color:#000;}
    .ok-btn:hover{background:var(--green);}
    .cancel-btn{background:var(--bg3);color:var(--tx2);}
    .cancel-btn:hover{background:var(--bg4);}
    .toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%) translateY(10px);background:var(--bg2);border:1px solid var(--bd);padding:10px 18px;border-radius:8px;font-size:12px;z-index:9999;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:90vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.4);}
    .toast.on{opacity:1;transform:translateX(-50%);}
    .toast.ok{border-color:var(--green);color:var(--green);}
    .toast.err{border-color:var(--red);color:var(--red);}
    .toast.info{border-color:var(--blue);color:var(--blue);}
    #pkg-terminal{background:var(--bg);border-top:1px solid var(--bd);font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--green);overflow-y:auto;max-height:160px;display:none;}
    #pkg-terminal.on{display:block;}
    #pkg-terminal pre{padding:8px 10px;white-space:pre-wrap;word-break:break-all;}
    .drop-zone{border:2px dashed var(--bd);border-radius:8px;padding:20px;text-align:center;margin-bottom:12px;cursor:pointer;transition:all .2s;font-size:12px;color:var(--tx3);}
    .drop-zone.over,.drop-zone:hover{border-color:var(--green);background:rgba(34,211,165,.05);color:var(--green);}
    #find-bar{display:none;background:var(--bg2);border-bottom:1px solid var(--bd);padding:6px 10px;align-items:center;gap:8px;flex-shrink:0;}
    #find-bar.on{display:flex;}
    #find-in{background:var(--bg3);border:1px solid var(--bd);border-radius:5px;padding:4px 8px;color:var(--tx);font-size:12px;outline:none;width:200px;font-family:'JetBrains Mono',monospace;}
    #find-in:focus{border-color:var(--green);}
    #find-count{font-size:11px;color:var(--tx3);}
    .find-btn{background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:3px 8px;color:var(--tx2);cursor:pointer;font-size:11px;}
    .find-btn:hover{color:var(--tx);background:var(--bg4);}
    #find-close{background:none;border:none;color:var(--tx3);cursor:pointer;font-size:14px;margin-left:auto;}
    #find-close:hover{color:var(--tx);}
    @media(max-width:700px){
      #side{position:fixed;top:44px;left:0;bottom:0;width:82vw;max-width:280px;transform:translateX(-100%);box-shadow:4px 0 24px rgba(0,0,0,.5);}
      #side.open{transform:translateX(0);}
      #side-overlay.on{display:block;}
      #btn-menu{display:block;}
      .bot-chip{max-width:90px;}
      .tbtn span{display:none;}
    }
  </style>
</head>
<body>
  <div id="topbar">
    <button id="btn-menu" onclick="toggleSide()">☰</button>
    <div class="logo"><div class="logo-dot"></div>ARES</div>
    <div class="bot-chip" title="${botId}">${botId}</div>
    <div class="sp"></div>
    <div id="status-bar-top">
      <div id="status-indicator"></div>
      <span id="status-text"></span>
    </div>
    <div id="unsaved" style="display:none;font-size:10px;color:var(--orange);margin:0 4px;">●</div>
    <button class="tbtn" id="btn-ren" onclick="doRename()" style="display:none">✏️ <span>Renomear</span></button>
    <button class="tbtn r" id="btn-del" onclick="doDel()" style="display:none">🗑️ <span>Excluir</span></button>
    <button class="tbtn g" id="btn-save" onclick="doSave()" style="display:none">💾 Salvar</button>
  </div>
  <div id="layout">
    <div id="side-overlay" onclick="closeSide()"></div>
    <div id="side">
      <div id="side-tabs">
        <div class="stab on" onclick="showPanel('files')" id="stab-files">📁 Arquivos</div>
        <div class="stab" onclick="showPanel('packages')" id="stab-packages">📦 Libs</div>
        <div class="stab" onclick="showPanel('search')" id="stab-search">🔍 Busca</div>
      </div>
      <div id="panel-files" class="on">
        <div id="side-header">
          <span class="s-title">Explorer</span>
          <div class="s-actions">
            <button class="ibtn" title="Upload de arquivo" onclick="triggerUpload()">⬆️</button>
            <button class="ibtn" title="Novo arquivo" onclick="doNewFile()">📄</button>
            <button class="ibtn" title="Nova pasta" onclick="doNewFolder()">📁</button>
            <button class="ibtn" title="Atualizar" onclick="refreshTree()">↺</button>
          </div>
        </div>
        <div id="tree"><div style="padding:12px;font-size:12px;color:var(--tx3)">Carregando...</div></div>
        <input type="file" id="upload-input" multiple style="display:none" onchange="handleFileUpload(event)">
      </div>
      <div id="panel-packages">
        <div id="side-header">
          <span class="s-title">Gerenciar Pacotes npm</span>
        </div>
        <div id="pkg-search-wrap">
          <input class="pkg-input" id="pkg-name-input" type="text" placeholder="ex: axios, lodash, dotenv..." spellcheck="false">
        </div>
        <div style="display:flex;gap:6px;padding:0 8px 8px;">
          <button id="pkg-install-btn" onclick="installPackage()">⬇️ Instalar</button>
          <button class="tbtn" style="font-size:11px;padding:5px 8px;" onclick="installPackage('dev')">Dev</button>
        </div>
        <div id="pkg-list"><div class="pkg-empty">Carregando pacotes...</div></div>
        <div id="pkg-terminal"><pre id="pkg-output"></pre></div>
      </div>
      <div id="panel-search">
        <div id="side-header">
          <span class="s-title">Buscar nos Arquivos</span>
        </div>
        <div id="search-wrap">
          <input class="pkg-input" id="global-search-input" type="text" placeholder="Buscar em todos os arquivos..." spellcheck="false">
        </div>
        <div id="search-results"><div class="pkg-empty">Digite para buscar...</div></div>
      </div>
    </div>
    <div id="right">
      <div id="tabs"></div>
      <div id="find-bar">
        <input id="find-in" type="text" placeholder="Buscar no arquivo..." spellcheck="false">
        <span id="find-count"></span>
        <button class="find-btn" onclick="findPrev()">↑</button>
        <button class="find-btn" onclick="findNext()">↓</button>
        <button class="find-btn" onclick="findReplace()">Replace</button>
        <button id="find-close" onclick="closeFindBar()">✕</button>
      </div>
      <div id="infobar" style="display:none">
        <div class="s-item" id="ib-lang">—</div>
        <div class="s-sep"></div>
        <div class="s-item" id="ib-size">—</div>
        <div class="s-sep"></div>
        <div class="s-item" id="ib-enc">UTF-8</div>
        <div id="cursor-pos" class="s-item">Ln 1, Col 1</div>
      </div>
      <div id="editor" style="display:none"></div>
      <div id="welcome">
        <div class="welcome-logo">⚡</div>
        <div class="welcome-title">ARES Editor</div>
        <div class="welcome-sub">Selecione um arquivo para editar ou crie um novo</div>
        <div class="welcome-keys">
          <div class="wk"><kbd>Ctrl+S</kbd> Salvar</div>
          <div class="wk"><kbd>Ctrl+F</kbd> Buscar</div>
          <div class="wk"><kbd>Ctrl+Z</kbd> Desfazer</div>
          <div class="wk"><kbd>Alt+Shift+F</kbd> Formatar</div>
        </div>
      </div>
      <div id="statusbar">
        <div class="s-item"><div id="sb-dot" style="width:6px;height:6px;border-radius:50%;background:var(--green)"></div><span id="sb-text">Pronto</span></div>
        <div class="s-sep"></div>
        <div class="s-item">Tab: <span>2 espaços</span></div>
      </div>
    </div>
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
  <div class="ov" id="modal2">
    <div class="box">
      <h3>Upload de Arquivos</h3>
      <div class="drop-zone" id="drop-zone2" onclick="document.getElementById('upload-input2').click()">
        📂 Arraste arquivos aqui ou clique para selecionar
        <input type="file" id="upload-input2" multiple style="display:none" onchange="handleFileUpload2(event)">
      </div>
      <div id="upload-progress" style="font-size:12px;color:var(--tx3);min-height:20px;"></div>
      <div class="bts" style="margin-top:12px;">
        <button class="cancel-btn" onclick="closeModal2()">Fechar</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}})
    const BOT_ID="${botId}"
    const TOKEN="${sessionToken}"
    const API="/files-api/"+BOT_ID
    const socket=io()
    function apiUrl(action,extra){return API+action+"?s="+TOKEN+(extra?"&"+extra:"")}
    let ed=null,currentFile=null,isDirty=false,openDirs=new Set(),treeData=[]
    let tabs=[],models={},modelDirty={},modalCb=null
    function setStatus(text,type){
      const ind=document.getElementById("status-indicator")
      const tx=document.getElementById("status-text")
      const sb=document.getElementById("sb-text")
      ind.className=type||""
      tx.textContent=text
      if(sb)sb.textContent=text
    }
    function toggleSide(){document.getElementById("side").classList.toggle("open");document.getElementById("side-overlay").classList.toggle("on")}
    function closeSide(){document.getElementById("side").classList.remove("open");document.getElementById("side-overlay").classList.remove("on")}
    function showPanel(name){
      ["files","packages","search"].forEach(p=>{
        document.getElementById("panel-"+p).classList.toggle("on",p===name)
        document.getElementById("stab-"+p).classList.toggle("on",p===name)
      })
      if(name==="packages")loadPackages()
    }
    function ext(n){return n.includes(".")?n.split(".").pop().toLowerCase():""}
    function langIcon(n){
      const m={js:"🟨",mjs:"🟨",cjs:"🟨",ts:"🔷",tsx:"🔷",jsx:"🟦",json:"🟧",py:"🐍",md:"📝",html:"🌐",htm:"🌐",css:"🎨",scss:"🎨",sh:"⚙️",bash:"⚙️",env:"🔑",yml:"📋",yaml:"📋",txt:"📄",xml:"📋",sql:"🗄️",php:"🐘",rb:"💎",go:"🐹",rs:"🦀",cpp:"⚡",c:"⚡",h:"⚡",java:"☕",dockerfile:"🐳",gitignore:"📋",lock:"🔒",log:"📋"}
      return m[ext(n)]||"📄"
    }
    function getLang(n){
      const m={js:"javascript",mjs:"javascript",cjs:"javascript",ts:"typescript",tsx:"typescript",jsx:"javascript",json:"json",py:"python",md:"markdown",sh:"shell",bash:"shell",html:"html",htm:"html",css:"css",scss:"scss",yml:"yaml",yaml:"yaml",txt:"plaintext",xml:"xml",sql:"sql",php:"php",rb:"ruby",go:"go",rs:"rust",cpp:"cpp",c:"c",h:"c",java:"java",dockerfile:"dockerfile",env:"plaintext",gitignore:"plaintext"}
      return m[ext(n)]||"plaintext"
    }
    function fmtSize(b){
      if(b>1024*1024)return(b/1024/1024).toFixed(2)+"MB"
      if(b>1024)return(b/1024).toFixed(1)+"KB"
      return b+"B"
    }
    function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
    function buildRows(items,depth){
      let h=""
      for(const item of items){
        const pad=6+depth*14
        if(item.type==="dir"){
          const open=openDirs.has(item.path)
          h+='<div class="row" style="padding-left:'+pad+'px" onclick="toggleDir(\''+esc(item.path)+'\')">'
          h+='<span class="arr '+(open?"o":"")+'">▶</span>'
          h+='<span class="ico">'+(open?"📂":"📁")+'</span>'
          h+='<span class="lbl d">'+esc(item.name)+'</span>'
          h+='<div class="row-ctx"><button class="ctx-btn" onclick="event.stopPropagation();doNewFileIn(\''+esc(item.path)+'\')">+f</button><button class="ctx-btn" onclick="event.stopPropagation();deleteFolder(\''+esc(item.path)+'\')">🗑</button></div>'
          h+='</div>'
          if(open&&item.children)h+=buildRows(item.children,depth+1)
        }else{
          const isCurrent=currentFile===item.path
          h+='<div class="row'+(isCurrent?" sel":"")+'" style="padding-left:'+(pad+12)+'px" onclick="openFile(\''+esc(item.path)+'\')">'
          h+='<span class="arr h">▶</span>'
          h+='<span class="ico">'+langIcon(item.name)+'</span>'
          h+='<span class="lbl">'+esc(item.name)+'</span>'
          h+='<div class="row-ctx">'
          h+='<button class="ctx-btn" onclick="event.stopPropagation();downloadFile(\''+esc(item.path)+'\')">⬇</button>'
          h+='<button class="ctx-btn" onclick="event.stopPropagation();duplicateFile(\''+esc(item.path)+'\')">⎘</button>'
          h+='<button class="ctx-btn" onclick="event.stopPropagation();quickRename(\''+esc(item.path)+'\')">✏</button>'
          h+='</div></div>'
        }
      }
      return h
    }
    function renderTree(){
      const el=document.getElementById("tree")
      el.innerHTML=treeData.length?buildRows(treeData,0):'<div style="padding:12px;font-size:12px;color:var(--tx3)">Pasta vazia</div>'
    }
    function toggleDir(p){openDirs.has(p)?openDirs.delete(p):openDirs.add(p);renderTree()}
    async function loadTree(){
      try{
        const r=await fetch(apiUrl("/tree"))
        if(!r.ok)throw new Error(await r.text())
        treeData=await r.json()
        renderTree()
      }catch(e){document.getElementById("tree").innerHTML='<div style="padding:12px;font-size:12px;color:var(--red)">Erro: '+e.message+'</div>'}
    }
    function refreshTree(){loadTree()}
    function renderTabs(){
      const el=document.getElementById("tabs")
      el.innerHTML=tabs.map(t=>{
        const name=t.path.split("/").pop()
        const on=t.path===currentFile?" on":""
        const dirty=modelDirty[t.path]
        const ind=dirty?'<span class="dot"></span>':'<span class="x" onclick="closeTab(event,\''+esc(t.path)+'\')">✕</span>'
        return '<div class="tab'+on+'" onclick="switchTo(\''+esc(t.path)+'\')" title="'+esc(t.path)+'">'+langIcon(name)+esc(name)+ind+'</div>'
      }).join("")
    }
    function switchTo(p){if(p!==currentFile)openFile(p)}
    function closeTab(e,p){
      e.stopPropagation()
      if(modelDirty[p]&&!confirm("Fechar sem salvar?"))return
      tabs=tabs.filter(x=>x.path!==p)
      if(models[p]){models[p].dispose();delete models[p]}
      delete modelDirty[p]
      if(currentFile===p){tabs.length?openFile(tabs[tabs.length-1].path):clearEditor()}
      renderTabs()
    }
    function clearEditor(){
      currentFile=null;isDirty=false
      if(ed)ed.setValue("")
      document.getElementById("editor").style.display="none"
      document.getElementById("welcome").style.display="flex"
      document.getElementById("infobar").style.display="none"
      document.getElementById("unsaved").style.display="none"
      ;["btn-save","btn-del","btn-ren"].forEach(id=>{document.getElementById(id).style.display="none"})
      renderTree()
    }
    async function openFile(p){
      if(!ed)return
      if(!models[p]){
        try{
          setStatus("Abrindo...","loading")
          const r=await fetch(apiUrl("/read","path="+encodeURIComponent(p)))
          if(!r.ok){toast("Erro ao abrir: "+await r.text(),"err");setStatus("Erro","err");return}
          const content=await r.text()
          models[p]=monaco.editor.createModel(content,getLang(p))
          modelDirty[p]=false
          if(!tabs.find(t=>t.path===p))tabs.push({path:p})
          models[p].onDidChangeContent(()=>{modelDirty[p]=true;if(currentFile===p)document.getElementById("unsaved").style.display="inline";renderTabs()})
        }catch(e){toast("Erro ao carregar","err");setStatus("Erro","err");return}
      }
      currentFile=p
      ed.setModel(models[p])
      document.getElementById("editor").style.display="block"
      document.getElementById("welcome").style.display="none"
      document.getElementById("infobar").style.display="flex"
      updateInfoBar()
      ;["btn-save","btn-del","btn-ren"].forEach(id=>{document.getElementById(id).style.display="inline-flex"})
      document.getElementById("unsaved").style.display=modelDirty[p]?"inline":"none"
      renderTree();renderTabs();closeSide();ed.focus()
      setStatus("Pronto","ok")
    }
    function updateInfoBar(){
      if(!currentFile||!ed)return
      const content=ed.getValue()
      document.getElementById("ib-lang").textContent=getLang(currentFile.split("/").pop())
      document.getElementById("ib-size").textContent=fmtSize(new Blob([content]).size)
      const pos=ed.getPosition()
      if(pos)document.getElementById("cursor-pos").textContent="Ln "+pos.lineNumber+", Col "+pos.column
    }
    async function doSave(){
      if(!currentFile||!ed)return
      setStatus("Salvando...","loading")
      try{
        const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:currentFile,content:ed.getValue()})})
        if(r.ok){modelDirty[currentFile]=false;document.getElementById("unsaved").style.display="none";renderTabs();toast("✅ Salvo!","ok");setStatus("Salvo","ok");setTimeout(()=>setStatus("Pronto","ok"),2000)}
        else{toast("Erro ao salvar: "+await r.text(),"err");setStatus("Erro","err")}
      }catch(e){toast("Erro: "+e.message,"err");setStatus("Erro","err")}
    }
    async function doDel(){
      if(!currentFile||!confirm('Excluir "'+currentFile+'"?'))return
      try{
        const r=await fetch(apiUrl("/delete"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:currentFile})})
        if(r.ok){toast("🗑️ Excluído!","ok");closeTab({stopPropagation:()=>{}},currentFile);loadTree()}
        else toast("Erro ao excluir: "+await r.text(),"err")
      }catch(e){toast("Erro ao excluir","err")}
    }
    async function deleteFolder(p){
      if(!confirm('Excluir pasta "'+p+'" e todo o conteúdo?'))return
      try{
        const r=await fetch(apiUrl("/delete"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})})
        if(r.ok){toast("🗑️ Pasta excluída!","ok");loadTree()}
        else toast("Erro: "+await r.text(),"err")
      }catch(e){toast("Erro","err")}
    }
    async function doRename(){
      if(!currentFile)return
      const parts=currentFile.split("/")
      const oldName=parts[parts.length-1]
      const newName=prompt("Novo nome:",oldName)
      if(!newName||newName===oldName)return
      await renameFile(currentFile,[...parts.slice(0,-1),newName].join("/"))
    }
    async function quickRename(p){
      const parts=p.split("/")
      const oldName=parts[parts.length-1]
      const newName=prompt("Novo nome:",oldName)
      if(!newName||newName===oldName)return
      await renameFile(p,[...parts.slice(0,-1),newName].join("/"))
    }
    async function renameFile(from,to){
      try{
        const r=await fetch(apiUrl("/rename"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from,to})})
        if(r.ok){
          const t=tabs.find(x=>x.path===from)
          if(t)t.path=to
          if(models[from]){models[to]=models[from];delete models[from]}
          if(modelDirty[from]!==undefined){modelDirty[to]=modelDirty[from];delete modelDirty[from]}
          if(currentFile===from)currentFile=to
          await loadTree();if(currentFile===to)openFile(to);toast("✅ Renomeado!","ok")
        }else toast("Erro ao renomear: "+await r.text(),"err")
      }catch(e){toast("Erro ao renomear","err")}
    }
    async function duplicateFile(p){
      const parts=p.split("/")
      const name=parts[parts.length-1]
      const dotIdx=name.lastIndexOf(".")
      const newName=dotIdx>0?name.slice(0,dotIdx)+"_copy"+name.slice(dotIdx):name+"_copy"
      const newPath=[...parts.slice(0,-1),newName].join("/")
      try{
        const rr=await fetch(apiUrl("/read","path="+encodeURIComponent(p)))
        if(!rr.ok)return
        const content=await rr.text()
        const rw=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:newPath,content})})
        if(rw.ok){await loadTree();toast("⎘ Duplicado!","ok")}
        else toast("Erro ao duplicar","err")
      }catch(e){toast("Erro ao duplicar","err")}
    }
    function downloadFile(p){
      const a=document.createElement("a")
      a.href=apiUrl("/download","path="+encodeURIComponent(p))
      a.download=p.split("/").pop()
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
    function triggerUpload(){document.getElementById("modal2").classList.add("on")}
    function closeModal2(){document.getElementById("modal2").classList.remove("on")}
    async function handleFileUpload(e){
      const files=Array.from(e.target.files)
      for(const f of files){
        const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
        const filePath=folder?folder+"/"+f.name:f.name
        const content=await f.text().catch(()=>null)
        if(content===null){toast("Binário não suportado: "+f.name,"err");continue}
        const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:filePath,content})})
        if(r.ok)toast("✅ "+f.name+" enviado","ok")
        else toast("Erro ao enviar "+f.name,"err")
      }
      await loadTree()
      e.target.value=""
    }
    async function handleFileUpload2(e){
      const files=Array.from(e.target.files)
      const prog=document.getElementById("upload-progress")
      prog.textContent="Enviando..."
      let ok=0
      for(const f of files){
        prog.textContent="Enviando "+f.name+"..."
        const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
        const filePath=folder?folder+"/"+f.name:f.name
        const content=await f.text().catch(()=>null)
        if(content===null){prog.textContent="Erro: "+f.name+" (binário não suportado)";continue}
        const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:filePath,content})})
        if(r.ok)ok++
      }
      prog.textContent="✅ "+ok+"/"+files.length+" arquivo(s) enviado(s)"
      await loadTree()
      e.target.value=""
    }
    const dz2=document.getElementById("drop-zone2")
    if(dz2){
      dz2.addEventListener("dragover",e=>{e.preventDefault();dz2.classList.add("over")})
      dz2.addEventListener("dragleave",()=>dz2.classList.remove("over"))
      dz2.addEventListener("drop",async e=>{
        e.preventDefault();dz2.classList.remove("over")
        const files=Array.from(e.dataTransfer.files)
        const prog=document.getElementById("upload-progress")
        prog.textContent="Enviando "+files.length+" arquivo(s)..."
        let ok=0
        for(const f of files){
          const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
          const filePath=folder?folder+"/"+f.name:f.name
          const content=await f.text().catch(()=>null)
          if(content===null)continue
          const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:filePath,content})})
          if(r.ok)ok++
        }
        prog.textContent="✅ "+ok+"/"+files.length+" enviado(s)"
        await loadTree()
      })
    }
    function doNewFile(){
      const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
      openModal("Novo arquivo","nome.js",async(fileName)=>{
        const filePath=folder?folder+"/"+fileName:fileName
        const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:filePath,content:getFileTemplate(fileName)})})
        if(r.ok){await loadTree();openFile(filePath);toast("✅ Criado!","ok")}
        else toast("Erro: "+await r.text(),"err")
      })
    }
    function doNewFileIn(folder){
      openModal("Novo arquivo em /"+folder,"nome.js",async(fileName)=>{
        const filePath=folder+"/"+fileName
        const r=await fetch(apiUrl("/write"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:filePath,content:getFileTemplate(fileName)})})
        if(r.ok){await loadTree();openFile(filePath);toast("✅ Criado!","ok")}
        else toast("Erro: "+await r.text(),"err")
      })
    }
    function getFileTemplate(name){
      const e=ext(name)
      if(e==="js")return "// "+name+"\n\n"
      if(e==="json")return "{\n  \n}\n"
      if(e==="html")return "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"UTF-8\">\n  <title></title>\n</head>\n<body>\n  \n</body>\n</html>"
      if(e==="md")return "# "+name.replace(".md","")+"\n\n"
      if(e==="py")return "# "+name+"\n\n"
      if(e==="css")return "/* "+name+" */\n\n"
      if(e==="env")return "# Environment variables\n\n"
      return ""
    }
    function doNewFolder(){
      const folder=currentFile?currentFile.split("/").slice(0,-1).join("/"):""
      openModal("Nova pasta","nova-pasta",async(folderName)=>{
        const folderPath=folder?folder+"/"+folderName:folderName
        const r=await fetch(apiUrl("/mkdir"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:folderPath})})
        if(r.ok){await loadTree();toast("✅ Pasta criada!","ok")}
        else toast("Erro: "+await r.text(),"err")
      })
    }
    async function loadPackages(){
      const el=document.getElementById("pkg-list")
      el.innerHTML='<div class="pkg-empty">Carregando...</div>'
      try{
        const r=await fetch(apiUrl("/package-json"))
        if(!r.ok){el.innerHTML='<div class="pkg-empty">Sem package.json</div>';return}
        const pkg=await r.json()
        const deps={...pkg.dependencies||{},...pkg.devDependencies||{}}
        const devDeps=new Set(Object.keys(pkg.devDependencies||{}))
        if(Object.keys(deps).length===0){el.innerHTML='<div class="pkg-empty">Sem dependências instaladas</div>';return}
        el.innerHTML=Object.entries(deps).map(([name,ver])=>
          '<div class="pkg-row"><span class="pname">'+esc(name)+(devDeps.has(name)?'<span style="color:var(--purple);font-size:9px;margin-left:4px;">dev</span>':'')+'</span><span class="pver">'+esc(ver)+'</span><button class="pdel" onclick="uninstallPackage(\''+esc(name)+'\')">✕</button></div>'
        ).join("")
      }catch(e){el.innerHTML='<div class="pkg-empty">Erro: '+e.message+'</div>'}
    }
    async function installPackage(type){
      const nameInput=document.getElementById("pkg-name-input")
      const pkgName=nameInput.value.trim()
      if(!pkgName)return toast("Digite o nome do pacote","err")
      const isdev=type==="dev"
      await runNpmCommand(["install","--save"+(isdev?"-dev":""),"--no-audit","--no-fund",pkgName],"Instalando "+pkgName+"...")
      nameInput.value=""
      await loadPackages()
    }
    async function uninstallPackage(name){
      if(!confirm("Desinstalar "+name+"?"))return
      await runNpmCommand(["uninstall",name],"Removendo "+name+"...")
      await loadPackages()
    }
    async function runNpmCommand(args,label){
      const terminal=document.getElementById("pkg-terminal")
      const output=document.getElementById("pkg-output")
      terminal.classList.add("on")
      output.textContent=label+"\n"
      setStatus(label,"loading")
      try{
        const r=await fetch(apiUrl("/npm-run"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({args})})
        if(!r.ok){output.textContent+="\n❌ Erro: "+await r.text();setStatus("Erro","err");return}
        const reader=r.body.getReader()
        const decoder=new TextDecoder()
        while(true){
          const{done,value}=await reader.read()
          if(done)break
          output.textContent+=decoder.decode(value)
          terminal.scrollTop=terminal.scrollHeight
        }
        output.textContent+="\n✅ Concluído!"
        terminal.scrollTop=terminal.scrollHeight
        setStatus("Pronto","ok")
        toast("✅ "+label,"ok")
      }catch(e){output.textContent+="\n❌ "+e.message;setStatus("Erro","err");toast("Erro: "+e.message,"err")}
    }
    let searchTimeout=null
    document.getElementById("global-search-input").addEventListener("input",function(){
      clearTimeout(searchTimeout)
      const q=this.value.trim()
      const el=document.getElementById("search-results")
      if(!q){el.innerHTML='<div class="pkg-empty">Digite para buscar...</div>';return}
      el.innerHTML='<div class="pkg-empty">Buscando...</div>'
      searchTimeout=setTimeout(()=>doGlobalSearch(q),300)
    })
    async function doGlobalSearch(q){
      const el=document.getElementById("search-results")
      try{
        const r=await fetch(apiUrl("/search","q="+encodeURIComponent(q)))
        if(!r.ok){el.innerHTML='<div class="pkg-empty">Erro na busca</div>';return}
        const results=await r.json()
        if(!results.length){el.innerHTML='<div class="pkg-empty">Nenhum resultado</div>';return}
        el.innerHTML=results.slice(0,50).map(item=>
          '<div class="sr-item" onclick="openFile(\''+esc(item.file)+'\')"><div class="sr-file">'+esc(item.file)+":"+item.line+'</div><div class="sr-line">'+esc(item.preview)+'</div></div>'
        ).join("")
      }catch(e){el.innerHTML='<div class="pkg-empty">Erro: '+e.message+'</div>'}
    }
    function openFindBar(){
      const bar=document.getElementById("find-bar")
      bar.classList.add("on")
      document.getElementById("find-in").focus()
      document.getElementById("find-in").select()
    }
    function closeFindBar(){document.getElementById("find-bar").classList.remove("on");if(ed)ed.focus()}
    function findNext(){if(!ed)return;ed.getAction("editor.action.nextMatchFindAction").run()}
    function findPrev(){if(!ed)return;ed.getAction("editor.action.previousMatchFindAction").run()}
    function findReplace(){if(!ed)return;ed.getAction("editor.action.startFindReplaceAction").run()}
    document.getElementById("find-in").addEventListener("keydown",e=>{
      if(e.key==="Enter"){e.shiftKey?findPrev():findNext()}
      if(e.key==="Escape")closeFindBar()
    })
    function openModal(title,placeholder,cb){
      modalCb=cb
      document.getElementById("modal-title").textContent=title
      document.getElementById("modal-in").value=""
      document.getElementById("modal-in").placeholder=placeholder
      document.getElementById("modal").classList.add("on")
      setTimeout(()=>document.getElementById("modal-in").focus(),100)
    }
    function closeModal(){document.getElementById("modal").classList.remove("on");modalCb=null}
    function confirmModal(){
      const v=document.getElementById("modal-in").value.trim()
      if(!v)return
      closeModal()
      if(modalCb)modalCb(v)
    }
    document.getElementById("modal-in").addEventListener("keydown",e=>{
      if(e.key==="Enter")confirmModal()
      if(e.key==="Escape")closeModal()
    })
    document.getElementById("modal").addEventListener("click",e=>{if(e.target===document.getElementById("modal"))closeModal()})
    document.getElementById("modal2").addEventListener("click",e=>{if(e.target===document.getElementById("modal2"))closeModal2()})
    function toast(msg,type){
      const el=document.getElementById("toast")
      el.textContent=msg;el.className="toast on "+(type||"")
      clearTimeout(el._t);el._t=setTimeout(()=>el.className="toast",3000)
    }
    require(["vs/editor/editor.main"],function(){
      monaco.editor.defineTheme("ares",{
        base:"vs-dark",inherit:true,
        rules:[
          {token:"comment",foreground:"64748b",fontStyle:"italic"},
          {token:"keyword",foreground:"f472b6"},
          {token:"string",foreground:"86efac"},
          {token:"number",foreground:"fb923c"},
          {token:"type",foreground:"60a5fa"},
          {token:"function",foreground:"a78bfa"},
        ],
        colors:{
          "editor.background":"#0a0e17",
          "editor.foreground":"#e2e8f0",
          "editor.lineHighlightBackground":"#111827",
          "editorLineNumber.foreground":"#334155",
          "editorLineNumber.activeForeground":"#94a3b8",
          "editor.selectionBackground":"#1e40af55",
          "editorCursor.foreground":"#22d3a5",
          "editorWidget.background":"#111827",
          "editorWidget.border":"#263046",
          "input.background":"#0a0e17",
          "input.foreground":"#e2e8f0",
          "scrollbarSlider.background":"#26304699",
        }
      })
      ed=monaco.editor.create(document.getElementById("editor"),{
        theme:"ares",fontSize:14,automaticLayout:true,
        fontFamily:"'JetBrains Mono', monospace",
        fontLigatures:true,
        minimap:{enabled:true,renderCharacters:false,scale:1},
        scrollBeyondLastLine:false,wordWrap:"off",
        padding:{top:12},lineNumbers:"on",
        renderLineHighlight:"all",
        smoothScrolling:true,
        cursorBlinking:"smooth",
        bracketPairColorization:{enabled:true},
        guides:{bracketPairs:true,indentation:true},
        formatOnPaste:true,
        tabSize:2,
        scrollbar:{verticalScrollbarSize:6,horizontalScrollbarSize:6},
        suggest:{showKeywords:true,showSnippets:true}
      })
      ed.onDidChangeCursorPosition(()=>updateInfoBar())
      ed.onDidChangeModelContent(()=>updateInfoBar())
      ed.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,doSave)
      ed.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyF,openFindBar)
      loadTree()
      setStatus("Pronto","ok")
    })
    document.getElementById("pkg-name-input").addEventListener("keydown",e=>{if(e.key==="Enter")installPackage()})
    socket.on("connect",()=>setStatus("Conectado","ok"))
    socket.on("disconnect",()=>setStatus("Desconectado","err"))
  </script>
</body>
</html>`)
})

app.use("/files-api", authBot, (req, res, next) => {
  const rawUrl = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/^\/files-api\/([^/]+)(\/[^?/]*)/)
  if (!m) return next()
  const botId = m[1]
  const action = m[2]
  const botPath = path.join(BASE_PATH, botId)

  if (!fs.existsSync(botPath)) {
    try { fs.mkdirSync(botPath, { recursive: true, mode: 0o755 }) } catch (err) {
      return res.status(500).send("Erro ao criar pasta do bot: " + err.message)
    }
  }

  const safe = (p) => {
    if (!p) return null
    const resolved = path.resolve(botPath, p)
    if (resolved !== botPath && !resolved.startsWith(botPath + path.sep)) return null
    return resolved
  }

  if (action === "/tree") return res.json(walkDir(botPath, ""))

  if (action === "/read") {
    const fp = safe(req.query.path)
    if (!fp) return res.status(400).send("Caminho inválido")
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return res.status(404).send("Arquivo não encontrado")
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    return res.send(fs.readFileSync(fp, "utf8"))
  }

  if (action === "/download") {
    const fp = safe(req.query.path)
    if (!fp) return res.status(400).send("Caminho inválido")
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return res.status(404).send("Arquivo não encontrado")
    const filename = path.basename(fp)
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    return res.send(fs.readFileSync(fp))
  }

  if (action === "/write") {
    const fp = safe(req.body && req.body.path)
    if (!fp) return res.status(400).send("Caminho inválido. Recebido: " + JSON.stringify(req.body))
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o755 })
      fs.writeFileSync(fp, (req.body && req.body.content) || "")
      saveBotFilesToBucket(botId).catch(() => {})
      return res.send("ok")
    } catch (err) { return res.status(500).send("Erro ao escrever: " + err.message) }
  }

  if (action === "/delete") {
    const fp = safe(req.body && req.body.path)
    if (!fp) return res.status(400).send("Caminho inválido")
    if (!fs.existsSync(fp)) return res.status(404).send("Não encontrado")
    try {
      fs.statSync(fp).isDirectory() ? fs.rmSync(fp, { recursive: true, force: true }) : fs.unlinkSync(fp)
      saveBotFilesToBucket(botId).catch(() => {})
      return res.send("ok")
    } catch (err) { return res.status(500).send("Erro ao deletar: " + err.message) }
  }

  if (action === "/mkdir") {
    const dp = safe(req.body && req.body.path)
    if (!dp) return res.status(400).send("Caminho inválido")
    try {
      fs.mkdirSync(dp, { recursive: true, mode: 0o755 })
      saveBotFilesToBucket(botId).catch(() => {})
      return res.send("ok")
    } catch (err) { return res.status(500).send("Erro ao criar pasta: " + err.message) }
  }

  if (action === "/rename") {
    const from = safe(req.body && req.body.from)
    const to = safe(req.body && req.body.to)
    if (!from || !to) return res.status(400).send("Caminhos inválidos")
    if (!fs.existsSync(from)) return res.status(404).send("Arquivo origem não encontrado")
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 })
      fs.renameSync(from, to)
      saveBotFilesToBucket(botId).catch(() => {})
      return res.send("ok")
    } catch (err) { return res.status(500).send("Erro ao renomear: " + err.message) }
  }

  if (action === "/package-json") {
    const pkgPath = path.join(botPath, "package.json")
    if (!fs.existsSync(pkgPath)) return res.status(404).send("Sem package.json")
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
      return res.json(pkg)
    } catch (err) { return res.status(500).send("Erro ao ler package.json: " + err.message) }
  }

  if (action === "/npm-run") {
    const { args } = req.body || {}
    if (!args || !Array.isArray(args)) return res.status(400).send("Args inválidos")
    const allowedCommands = ["install", "uninstall", "update", "outdated", "list", "audit"]
    if (!allowedCommands.includes(args[0])) return res.status(403).send("Comando npm não permitido")
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.setHeader("Transfer-Encoding", "chunked")
    res.setHeader("X-Content-Type-Options", "nosniff")
    const npmCmd = os.platform() === "win32" ? "npm.cmd" : "npm"
    const child = spawn(npmCmd, [...args, "--no-color"], { cwd: botPath, env: { ...process.env, FORCE_COLOR: "0" } })
    child.stdout.on("data", d => res.write(d.toString()))
    child.stderr.on("data", d => res.write(d.toString()))
    child.on("close", (code) => {
      if (code !== 0) res.write(`\nProcesso encerrado com código ${code}`)
      saveBotFilesToBucket(botId).catch(() => {})
      res.end()
    })
    child.on("error", err => { res.write("\nErro: " + err.message); res.end() })
    return
  }

  if (action === "/search") {
    const q = req.query.q
    if (!q || q.length < 2) return res.json([])
    const results = []
    const searchInDir = (dir, baseRel) => {
      if (!fs.existsSync(dir)) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "terminal.log" || e.name === "meta.json" || e.name === "bot.zip") continue
        const fullPath = path.join(dir, e.name)
        const rel = baseRel ? baseRel + "/" + e.name : e.name
        if (e.isDirectory()) {
          searchInDir(fullPath, rel)
        } else {
          const textExts = ["js","mjs","cjs","ts","tsx","jsx","json","py","md","html","htm","css","scss","sh","bash","env","yml","yaml","txt","xml","sql","php","rb","go","rs","cpp","c","h","java","dockerfile","gitignore","lock"]
          if (!textExts.includes(e.name.split(".").pop().toLowerCase()) && !e.name.includes(".")) continue
          try {
            const content = fs.readFileSync(fullPath, "utf8")
            const lines = content.split("\n")
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(q.toLowerCase())) {
                results.push({ file: rel, line: i + 1, preview: lines[i].trim().substring(0, 120) })
                if (results.length >= 100) return
              }
            }
          } catch {}
        }
      }
    }
    searchInDir(botPath, "")
    return res.json(results)
  }

  next()
})

function cleanupOldLogs() {
  console.log("🧹 Iniciando limpeza de logs antigos...")
  if (!fs.existsSync(BASE_PATH)) return
  const bots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users")
  const now = Date.now()
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
  let logsRemovidos = 0
  let espacoLiberado = 0
  for (const botId of bots) {
    const logPath = path.join(BASE_PATH, botId, "terminal.log")
    if (fs.existsSync(logPath)) {
      try {
        const stats = fs.statSync(logPath)
        const idade = now - stats.mtimeMs
        if (idade > TWENTY_FOUR_HOURS) {
          const tamanho = stats.size / 1024
          espacoLiberado += tamanho
          if (activeBots[botId]) {
            fs.writeFileSync(logPath, `--- Log limpo em ${new Date().toISOString()} ---\n`)
          } else {
            fs.unlinkSync(logPath)
          }
          logsRemovidos++
        }
      } catch (err) {
        console.error(`Erro ao processar log de ${botId}:`, err.message)
      }
    }
  }
  console.log(`✅ Limpeza concluída: ${logsRemovidos} logs processados, ${espacoLiberado.toFixed(2)} KB liberados`)
  if (ADMIN_ID && logsRemovidos > 0) {
    bot.sendMessage(ADMIN_ID,
      `🧹 *Limpeza Automática de Logs*\n\n` +
      `📊 Logs processados: *${logsRemovidos}*\n` +
      `💾 Espaço liberado: *${espacoLiberado.toFixed(2)} KB*`,
      { parse_mode: "Markdown" }
    ).catch(() => {})
  }
}

setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000)
setTimeout(cleanupOldLogs, 5 * 60 * 1000)

process.on("uncaughtException", err => {
  if (err.code !== "EADDRINUSE") console.error("Erro não tratado:", err)
})

process.on("SIGTERM", async () => {
  console.log("📥 SIGTERM recebido, salvando bots no bucket...")
  const bots = fs.existsSync(BASE_PATH)
    ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users" && f !== ".git" && f !== "node_modules")
    : []
  for (const botId of bots) await saveBotFilesToBucket(botId)
  console.log("✅ Bots salvos. Encerrando.")
  process.exit(0)
})

process.on("SIGINT", async () => {
  console.log("📥 SIGINT recebido, salvando bots no bucket...")
  const bots = fs.existsSync(BASE_PATH)
    ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users" && f !== ".git" && f !== "node_modules")
    : []
  for (const botId of bots) await saveBotFilesToBucket(botId)
  process.exit(0)
})

server.listen(PORT, async () => {
  aresBanner()
  await restoreAllBotsFromBucket()
  if (fs.existsSync(BASE_PATH)) {
    const bots = fs.readdirSync(BASE_PATH).filter(f => {
      if (f === "_uploads" || f === "_users" || f === ".git" || f === "node_modules") return false
      return fs.existsSync(path.join(BASE_PATH, f)) && fs.statSync(path.join(BASE_PATH, f)).isDirectory()
    })
    if (bots.length > 0) {
      console.log(`\n♻️  Restaurando ${bots.length} bot(s)...\n`)
      bots.forEach((botId, i) => {
        setTimeout(() => {
          const instancePath = path.join(BASE_PATH, botId)
          if (fs.existsSync(instancePath)) {
            console.log(`  ▶ Iniciando: ${botId}`)
            spawnBot(botId, instancePath)
          }
        }, i * 2000)
      })
    }
  }
})
