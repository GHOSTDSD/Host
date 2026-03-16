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
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3")
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

const bot = new TelegramBot(TOKEN, { polling: false })
const app = express()
const server = http.createServer(app)
const io = socketIo(server)

io.sockets.setMaxListeners(200)
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))
app.use(express.static("public"))

const BUCKET_ENDPOINT = process.env.BUCKET_ENDPOINT || "https://t3.storageapi.dev"

const BUCKETS = [1, 2, 3].map(i => ({
  bucketName: process.env[`BUCKET_${i}_NAME`],
  endpoint: BUCKET_ENDPOINT,
  region: "auto",
  credentials: {
    accessKeyId: process.env[`BUCKET_${i}_KEY`],
    secretAccessKey: process.env[`BUCKET_${i}_SECRET`],
  }
})).filter(b => b.bucketName && b.credentials.accessKeyId && b.credentials.secretAccessKey)

if (BUCKETS.length === 0) {
  console.error("❌ Nenhum bucket configurado! Defina BUCKET_1_NAME, BUCKET_1_KEY, BUCKET_1_SECRET no Railway.")
  process.exit(1)
}

const s3Clients = BUCKETS.map(b => ({
  ...b,
  client: new S3Client({ endpoint: b.endpoint, region: b.region, credentials: b.credentials, forcePathStyle: true })
}))

function getBucketForBot(botId) {
  let hash = 0
  for (let i = 0; i < botId.length; i++) hash = (hash * 31 + botId.charCodeAt(i)) >>> 0
  return s3Clients[hash % s3Clients.length]
}

console.log("✅ " + s3Clients.length + " buckets configurados (load balance por bot)")

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

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")

function genWebSession(chatId) {
  const payload = String(chatId) + ":" + Date.now()
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex").slice(0, 32)
  return Buffer.from(payload).toString("base64url") + "." + sig
}

function checkSession(req) {
  const tok = req.query.s
  if (!tok) return null
  try {
    const dot = tok.lastIndexOf(".")
    if (dot < 0) return null
    const b64 = tok.slice(0, dot)
    const sig = tok.slice(dot + 1)
    const payload = Buffer.from(b64, "base64url").toString()
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex").slice(0, 32)
    if (sig !== expected) return null
    const colon = payload.lastIndexOf(":")
    const chatId = payload.slice(0, colon)
    const ts = Number(payload.slice(colon + 1))
    if (Date.now() - ts > 7 * 24 * 60 * 60 * 1000) return null
    return chatId
  } catch { return null }
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
☁️  BUCKETS: ${s3Clients.map(b => b.bucketName).join(", ")}\n`)
}

function getPackageHash(packagePath) {
  try {
    const content = fs.readFileSync(packagePath, "utf8")
    return crypto.createHash("md5").update(content).digest("hex").substring(0, 12)
  } catch { return null }
}

async function checkNodeModulesInBucket(botId, packageHash) {
  try {
    const { client, bucketName } = getBucketForBot(botId)
    await client.send(new HeadObjectCommand({
      Bucket: bucketName,
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
    const { client: nmClient, bucketName: nmBucket } = getBucketForBot(botId)
    await nmClient.send(new PutObjectCommand({
      Bucket: nmBucket,
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
    const { client: dlClient, bucketName: dlBucket } = getBucketForBot(botId)
    const response = await dlClient.send(new GetObjectCommand({
      Bucket: dlBucket,
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
    const { client: saveClient, bucketName: saveBucket } = getBucketForBot(botId)
    await saveClient.send(new PutObjectCommand({
      Bucket: saveBucket,
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
    const { client: restoreClient, bucketName: restoreBucket } = getBucketForBot(botId)
    const response = await restoreClient.send(new GetObjectCommand({
      Bucket: restoreBucket,
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
    const allBots = []
    for (const { client, bucketName } of s3Clients) {
      try {
        const response = await client.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: "files_" }))
        const bots = (response.Contents || [])
          .map(o => o.Key.replace("files_", "").replace(".tar.gz", ""))
          .filter(Boolean)
        allBots.push(...bots)
      } catch (e) {
        console.error("Erro ao listar bucket " + bucketName + ":", e.message)
      }
    }
    return [...new Set(allBots)]
  } catch (err) {
    console.error("Erro ao listar bots nos buckets:", err.message)
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
  child.onExit(() => {
    releasePort(botPort)
    delete activeBots[botId]
    const nmPath = path.join(instancePath, "node_modules")
    if (fs.existsSync(nmPath)) {
      try { fs.rmSync(nmPath, { recursive: true, force: true }) } catch {}
    }
    aresBanner()
  })
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
  if (!fs.existsSync(USERS_PATH)) fs.mkdirSync(USERS_PATH, { recursive: true })
  const f = path.join(USERS_PATH, `${chatId}.json`)
  fs.writeFileSync(f, JSON.stringify({ accepted: true, at: Date.now() }))
}

// ─── SISTEMA DE ATIVAÇÃO ───────────────────────────────────────────
const ACTIVE_KEYS_FILE = path.join(BASE_PATH, "_users", "active_keys.json")
const ACTIVATED_FILE   = path.join(BASE_PATH, "_users", "activated.json")

function loadActiveKeys() {
  try {
    if (!fs.existsSync(ACTIVE_KEYS_FILE)) return {}
    return JSON.parse(fs.readFileSync(ACTIVE_KEYS_FILE, "utf8"))
  } catch { return {} }
}

function saveActiveKeys(data) {
  if (!fs.existsSync(path.dirname(ACTIVE_KEYS_FILE))) fs.mkdirSync(path.dirname(ACTIVE_KEYS_FILE), { recursive: true })
  fs.writeFileSync(ACTIVE_KEYS_FILE, JSON.stringify(data, null, 2))
}

function loadActivated() {
  try {
    if (!fs.existsSync(ACTIVATED_FILE)) return {}
    return JSON.parse(fs.readFileSync(ACTIVATED_FILE, "utf8"))
  } catch { return {} }
}

function saveActivated(data) {
  if (!fs.existsSync(path.dirname(ACTIVATED_FILE))) fs.mkdirSync(path.dirname(ACTIVATED_FILE), { recursive: true })
  fs.writeFileSync(ACTIVATED_FILE, JSON.stringify(data, null, 2))
}

function isActivated(chatId) {
  const activated = loadActivated()
  return !!activated[String(chatId)]
}

function activateUser(chatId, key, daysValid) {
  daysValid = daysValid || 30
  const activated = loadActivated()
  const expiresAt = Date.now() + daysValid * 24 * 60 * 60 * 1000
  activated[String(chatId)] = { key, at: Date.now(), expiresAt, daysValid }
  saveActivated(activated)
}

function getUserActivation(chatId) {
  const activated = loadActivated()
  return activated[String(chatId)] || null
}

function fmtExpiry(ts) {
  if (!ts) return "Sem expiração"
  const d = new Date(ts)
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" })
}

function daysLeft(ts) {
  if (!ts) return null
  const diff = Math.ceil((ts - Date.now()) / (1000 * 60 * 60 * 24))
  return diff
}

function generateKey(prefix) {
  prefix = prefix || "ARES"
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`
}
// ──────────────────────────────────────────────────────────────────

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

bot.onText(/^\/active$/, async msg => {
  const chatId = msg.chat.id
  if (isActivated(chatId)) {
    return bot.sendMessage(chatId,
      "✅ *Sua conta já está ativada!*\n\nVocê já tem acesso ao ARES HOST.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 Abrir ARES HOST", callback_data: "menu_home" }]]
        }
      }
    )
  }
  const activateUrl = `${DOMAIN}/activate?chatId=${chatId}`
  bot.sendMessage(chatId,
    "🔑 *Ativação do ARES HOST*\n\nClique no botão abaixo para inserir sua chave de ativação.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🔑 Inserir chave", web_app: { url: activateUrl } }]]
      }
    }
  )
})

bot.onText(/^\/genkey(?:\s+(.+))?$/, async msg => {
  const chatId = msg.chat.id
  if (OWNER_ID && String(chatId) !== String(OWNER_ID)) {
    return bot.sendMessage(chatId, "❌ Sem permissão.")
  }
  const args = (msg.text.split(" ").slice(1))
  const prefix = isNaN(args[0]) ? (args[0] || "ARES") : "ARES"
  const days = parseInt(args.find(a => !isNaN(a))) || 30
  const key = generateKey(prefix)
  const keys = loadActiveKeys()
  keys[key] = { createdAt: Date.now(), usedBy: null, prefix, daysValid: days }
  saveActiveKeys(keys)
  bot.sendMessage(chatId,
    `🔑 *Nova chave gerada:*\n\n\`${key}\`\n\n⏳ Validade: *${days} dias* após ativação\n\nEnvie essa chave para o usuário.`,
    { parse_mode: "Markdown" }
  )
})

bot.onText(/^\/listkeys$/, async msg => {
  const chatId = msg.chat.id
  if (OWNER_ID && String(chatId) !== String(OWNER_ID)) return
  const keys = loadActiveKeys()
  const activated = loadActivated()
  const total = Object.keys(keys).length
  const used = Object.values(keys).filter(k => k.usedBy).length
  const free = total - used
  const usersCount = Object.keys(activated).length
  if (total === 0) return bot.sendMessage(chatId, "📋 Nenhuma chave gerada ainda. Use /genkey para criar.")
  const lines = Object.entries(keys).slice(-20).map(([k, v]) => {
    return `${v.usedBy ? "✅" : "⬜"} \`${k}\`${v.usedBy ? " — usado" : ""}`
  }).join("\n")
  bot.sendMessage(chatId,
    `🔑 *Chaves de ativação*\n\nTotal: *${total}* | Usadas: *${used}* | Livres: *${free}*\nUsuários ativados: *${usersCount}*\n\n${lines}`,
    { parse_mode: "Markdown" }
  )
})

bot.onText(/^\/meuid$/, msg => {
  bot.sendMessage(msg.chat.id, `🪪 *Seu Telegram ID:*\n\n\`${msg.chat.id}\``, { parse_mode: "Markdown" })
})

bot.onText(/^\/(limpar|limpeza)$/, async msg => {
  const chatId = msg.chat.id
  if (OWNER_ID && String(chatId) !== String(OWNER_ID)) {
    return bot.sendMessage(chatId, "❌ Sem permissão.")
  }
  bot.sendMessage(chatId,
    "🗑️ *O que deseja limpar?*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧹 Disco local (node_modules + logs)", callback_data: "limpar_local:" + chatId }],
          [{ text: "💣 Tudo — disco + bucket (apaga todos os bots)", callback_data: "limpar_tudo:" + chatId }],
          [{ text: "❌ Cancelar", callback_data: "owner_limpar_cancel" }]
        ]
      }
    }
  )
})

bot.onText(/^\/reiniciar$/, async msg => {
  const chatId = msg.chat.id
  if (String(chatId) !== String(OWNER_ID)) {
    return bot.sendMessage(chatId, "❌ Sem permissão.")
  }
  bot.sendMessage(chatId, "🔄 Reiniciando processo...")
  setTimeout(() => process.exit(0), 1000)
})

bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id
  if (!hasAccepted(chatId)) {
    termoCheck[chatId] = false
    return sendTermos(chatId, false)
  }

  const s = getStats(chatId)
  const act = getUserActivation(chatId)
  const user = msg.from

  // Build name line
  const firstName = user.first_name || ""
  const lastName = user.last_name || ""
  const fullName = (firstName + " " + lastName).trim()
  const username = user.username ? `@${user.username}` : `ID: ${chatId}`

  // Build expiry line
  let expiryLine = ""
  if (act && act.expiresAt) {
    const left = daysLeft(act.expiresAt)
    if (left <= 0) {
      expiryLine = `⛔ Expirado em ${fmtExpiry(act.expiresAt)}`
    } else if (left <= 7) {
      expiryLine = `⚠️ Expira em *${left} dias* (${fmtExpiry(act.expiresAt)})`
    } else {
      expiryLine = `📅 Válido até *${fmtExpiry(act.expiresAt)}* (${left}d)`
    }
  }

  const caption =
    `*${fullName}*\n` +
    `${username}\n` +
    (expiryLine ? expiryLine + "\n" : "") +
    `\n` +
    `🤖 Bots: *${s.total}*  🟢 *${s.online}*  🔴 *${s.offline}*\n` +
    `💾 RAM: *${s.ram}MB*  ⏱ *${s.uptime}*`

  const keyboard = {
    inline_keyboard: [
      [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
      [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
      [{ text: "📊 Estatísticas", callback_data: "menu_stats" }],
    ]
  }

  // Try to get user profile photo
  try {
    const photos = await bot.getUserProfilePhotos(chatId, { limit: 1 })
    if (photos && photos.total_count > 0) {
      const fileId = photos.photos[0][photos.photos[0].length - 1].file_id
      return bot.sendPhoto(chatId, fileId, {
        caption,
        parse_mode: "Markdown",
        reply_markup: keyboard
      })
    }
  } catch (e) {}

  // Fallback sem foto
  bot.sendMessage(chatId,
    `🚀 *ARES HOST*\n\n` + caption,
    { parse_mode: "Markdown", reply_markup: keyboard }
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

  if (action === "limpar_local" || action === "owner_limpar_confirm") {
    if (OWNER_ID && String(chatId) !== String(OWNER_ID)) return
    bot.editMessageText("🧹 Parando bots e limpando disco...", { chat_id: chatId, message_id: msgId })
    try {
      const botIds = Object.keys(activeBots)
      let stopped = 0
      for (const bid of botIds) {
        try { activeBots[bid].process.kill(); delete activeBots[bid]; stopped++ } catch (e) {}
      }
      let nmCount = 0, logCount = 0, tmpCount = 0
      if (fs.existsSync(BASE_PATH)) {
        const entries = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users" && f !== ".git")
        for (const entry of entries) {
          const fullPath = path.join(BASE_PATH, entry)
          try {
            if (!fs.statSync(fullPath).isDirectory()) continue
            const nmPath = path.join(fullPath, "node_modules")
            const logPath = path.join(fullPath, "terminal.log")
            const botZip = path.join(fullPath, "bot.zip")
            if (fs.existsSync(nmPath)) { fs.rmSync(nmPath, { recursive: true, force: true }); nmCount++ }
            if (fs.existsSync(logPath)) { fs.unlinkSync(logPath); logCount++ }
            if (fs.existsSync(botZip)) { fs.unlinkSync(botZip); tmpCount++ }
          } catch (e) { console.error("Erro ao limpar", entry, e.message) }
        }
      }
      let restarted = 0
      for (const bid of botIds) {
        const instancePath = path.join(BASE_PATH, bid)
        if (fs.existsSync(instancePath)) {
          setTimeout(() => spawnBot(bid, instancePath), restarted * 2000)
          restarted++
        }
      }
      const diskAfter = getDiskPercent()
      const ramAfter = (process.memoryUsage().rss / 1024 / 1024).toFixed(0)
      return bot.editMessageText(
        `✅ *Disco limpo!*\n\n` +
        `🛑 Bots parados: *${stopped}*\n` +
        `📦 node\\_modules: *${nmCount}*\n` +
        `📋 Logs: *${logCount}*\n` +
        `♻️ Reiniciando: *${restarted}* bots\n\n` +
        `💿 Disco: *${diskAfter}%*  |  💾 RAM: *${ramAfter}MB*`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      )
    } catch (err) {
      return bot.editMessageText(`❌ Erro: ${err.message}`, { chat_id: chatId, message_id: msgId })
    }
  }

  if (action === "limpar_tudo") {
    if (OWNER_ID && String(chatId) !== String(OWNER_ID)) return
    // Confirmação extra antes de apagar tudo
    return bot.editMessageText(
      `💣 *ATENÇÃO — Ação irreversível!*\n\nIsso vai:\n• Parar todos os bots\n• Apagar todos os arquivos locais\n• Apagar todos os arquivos nos buckets\n\nTodos os bots serão *permanentemente deletados*. Tem certeza?`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💣 Sim, apagar TUDO", callback_data: "limpar_tudo_confirm:" + chatId }],
            [{ text: "❌ Cancelar", callback_data: "owner_limpar_cancel" }]
          ]
        }
      }
    )
  }

  if (action === "limpar_tudo_confirm") {
    if (OWNER_ID && String(chatId) !== String(OWNER_ID)) return
    bot.editMessageText("💣 Apagando tudo...", { chat_id: chatId, message_id: msgId })
    try {
      // 1. Parar todos os bots
      for (const bid of Object.keys(activeBots)) {
        try { activeBots[bid].process.kill(); delete activeBots[bid] } catch (e) {}
      }

      // 2. Apagar disco local inteiro mas preservar estrutura necessária
      if (fs.existsSync(BASE_PATH)) {
        fs.rmSync(BASE_PATH, { recursive: true, force: true })
      }
      fs.mkdirSync(BASE_PATH, { recursive: true, mode: 0o755 })
      fs.mkdirSync(path.join(BASE_PATH, "_users"), { recursive: true, mode: 0o755 })
      fs.mkdirSync(path.join(BASE_PATH, "_uploads"), { recursive: true, mode: 0o755 })

      // 3. Apagar tudo nos buckets
      let objDeleted = 0
      for (const { client, bucketName } of s3Clients) {
        try {
          let cont = true
          let token = undefined
          while (cont) {
            const listRes = await client.send(new ListObjectsV2Command({
              Bucket: bucketName,
              MaxKeys: 1000,
              ContinuationToken: token
            }))
            const objs = (listRes.Contents || []).map(o => ({ Key: o.Key }))
            if (objs.length > 0) {
              await client.send(new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: { Objects: objs, Quiet: true }
              }))
              objDeleted += objs.length
            }
            cont = listRes.IsTruncated
            token = listRes.NextContinuationToken
          }
        } catch (e) {
          console.error("Erro ao apagar bucket", bucketName, e.message)
        }
      }

      const diskAfter = getDiskPercent()
      const ramAfter = (process.memoryUsage().rss / 1024 / 1024).toFixed(0)
      return bot.editMessageText(
        `✅ *Tudo apagado!*\n\n` +
        `🗑️ Disco local: limpo\n` +
        `☁️ Objetos no bucket: *${objDeleted}* deletados\n\n` +
        `💿 Disco: *${diskAfter}%*  |  💾 RAM: *${ramAfter}MB*`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      )
    } catch (err) {
      return bot.editMessageText(`❌ Erro: ${err.message}`, { chat_id: chatId, message_id: msgId })
    }
  }

  if (action === "owner_limpar_cancel") {
    return bot.editMessageText("❌ Limpeza cancelada.", { chat_id: chatId, message_id: msgId })
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
            [{ text: "📊 Estatisticas", callback_data: "menu_stats" }],
          ]
        }
      }
    )
  }
  if (action === "menu_home") {
    const s = getStats(chatId)
    const act = getUserActivation(chatId)
    let expiryLine = ""
    if (act && act.expiresAt) {
      const left = daysLeft(act.expiresAt)
      if (left <= 0) expiryLine = `\n⛔ Acesso expirado`
      else if (left <= 7) expiryLine = `\n⚠️ Expira em *${left} dias*`
      else expiryLine = `\n📅 Válido até *${fmtExpiry(act.expiresAt)}*`
    }
    return bot.editMessageText(
      `🚀 *ARES HOST*${expiryLine}\n\n` +
      `🤖 Bots: *${s.total}*  🟢 *${s.online}*  🔴 *${s.offline}*\n` +
      `💾 RAM: *${s.ram}MB*  ⏱ *${s.uptime}*`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
            [{ text: "📂 Meus Bots", callback_data: "menu_list" }],
            [{ text: "📊 Estatísticas", callback_data: "menu_stats" }],
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
  if (false && action === "menu_market_disabled") {
    const sessionToken = genWebSession(chatId)
    const url = `${DOMAIN}/marketplace?s=${sessionToken}`
    return bot.editMessageText(
      `🛒 *Marketplace de Bases*\n\n` +
      `Explore bases de bots de WhatsApp prontas criadas pela comunidade ARES!\n\n` +
      `✅ Gratuito e open source\n` +
      `📦 Instale com 1 clique\n` +
      `🤝 Contribua publicando a sua base`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛒 Abrir Marketplace", url }],
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
  if (!fs.existsSync(botPath)) return res.status(404).send("Bot nao encontrado")
  try { fs.accessSync(botPath, fs.constants.R_OK | fs.constants.W_OK) } catch { return res.status(403).send("Sem permissao") }
  res.send(buildEditorHtml(botId, sessionToken, "/files-api/" + botId))
})

function buildEditorHtml(botId, sessionToken, API) {
  const B = JSON.stringify(botId)
  const T = JSON.stringify(sessionToken)
  const A = JSON.stringify(API)

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#111827">
<title>ARES \u2014 ${botId}</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0a0e17;--bg2:#111827;--bg3:#1a2234;--bg4:#1e2a3a;--bg5:#243044;
  --bd:#263046;--bd2:#334155;
  --tx:#e2e8f0;--tx2:#94a3b8;--tx3:#64748b;
  --green:#22d3a5;--green2:#16a37f;--green3:#0d6b52;
  --blue:#60a5fa;--orange:#f59e0b;--red:#f87171;--red2:#ef4444;--purple:#a78bfa;
  --top:48px;--bot:60px;--r:10px
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--tx);font-family:"Inter",sans-serif;font-size:14px;-webkit-font-smoothing:antialiased;touch-action:pan-x pan-y}

/* ─── TOPBAR ─── */
#topbar{
  height:var(--top);background:var(--bg2);border-bottom:1px solid var(--bd);
  display:flex;align-items:center;padding:0 10px;gap:6px;flex-shrink:0;z-index:30;
  padding-top:env(safe-area-inset-top,0);
}
.logo{color:var(--green);font-weight:800;font-size:15px;display:flex;align-items:center;gap:5px;letter-spacing:-.3px}
.logo-dot{width:7px;height:7px;background:var(--green);border-radius:50%;animation:pulse 2s infinite;box-shadow:0 0 6px var(--green)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.75)}}
.bot-chip{
  background:linear-gradient(135deg,var(--bg3),var(--bg4));
  border:1px solid var(--bd);border-radius:7px;padding:4px 9px;
  font-size:11px;color:var(--tx2);font-family:"JetBrains Mono",monospace;
  max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap
}
.sp{flex:1}
.tbtn{
  display:inline-flex;align-items:center;gap:4px;padding:7px 11px;border-radius:8px;
  cursor:pointer;font-size:12px;font-weight:600;border:1px solid var(--bd);
  background:var(--bg3);color:var(--tx);white-space:nowrap;font-family:"Inter",sans-serif;
  touch-action:manipulation;-webkit-user-select:none;user-select:none;transition:background .1s
}
.tbtn:active{background:var(--bg5)}
.tbtn.g{background:var(--green2);border-color:var(--green);color:#000}.tbtn.g:active{background:var(--green)}
.tbtn.r{border-color:var(--red2);color:var(--red)}.tbtn.r:active{background:rgba(248,113,113,.15)}
#si{width:6px;height:6px;border-radius:50%;background:var(--tx3);flex-shrink:0}
#si.ok{background:var(--green);box-shadow:0 0 4px var(--green)}
#si.err{background:var(--red)}
#si.loading{background:var(--orange);animation:pulse .8s infinite}
#status-wrap{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--tx3)}
#mbtn{
  background:none;border:none;color:var(--tx2);cursor:pointer;
  padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  touch-action:manipulation;min-width:38px;min-height:38px
}
#mbtn:active{background:var(--bg3);color:var(--tx)}

/* ─── LAYOUT ─── */
#layout{display:flex;height:calc(100vh - var(--top));position:relative;overflow:hidden}

/* ─── SIDEBAR ─── */
#side{
  width:280px;background:var(--bg2);
  display:flex;flex-direction:column;flex-shrink:0;
  transition:transform .28s cubic-bezier(.4,0,.2,1);
  z-index:20;position:fixed;top:var(--top);bottom:0;left:0;
  transform:translateX(-100%);
  box-shadow:6px 0 40px rgba(0,0,0,.7);
  border-right:1px solid var(--bd)
}
#side.open{transform:translateX(0)}
#side-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:19;backdrop-filter:blur(4px)}
#side-ov.on{display:block}

/* sidebar tabs */
#stabs{display:flex;border-bottom:1px solid var(--bd);flex-shrink:0;padding:0 4px;gap:2px;padding-top:4px}
.stab{
  flex:1;padding:9px 4px 8px;text-align:center;font-size:11px;font-weight:700;
  color:var(--tx3);cursor:pointer;border-radius:8px 8px 0 0;
  transition:all .15s;display:flex;align-items:center;justify-content:center;gap:4px;
  user-select:none;touch-action:manipulation;min-height:40px;
  border-bottom:2px solid transparent
}
.stab.on{color:var(--green);border-bottom-color:var(--green);background:rgba(34,211,165,.06)}
.stab:active:not(.on){background:var(--bg3);color:var(--tx2)}

.panel{display:none;flex-direction:column;flex:1;overflow:hidden}.panel.on{display:flex}
.ph{
  padding:10px 12px;border-bottom:1px solid var(--bd);
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
  background:var(--bg2)
}
.ptitle{font-size:10px;color:var(--tx3);text-transform:uppercase;letter-spacing:.08em;font-weight:800}
.pbtns{display:flex;gap:1px}
.ib{
  background:none;border:none;color:var(--tx3);cursor:pointer;
  padding:7px;border-radius:7px;line-height:1;display:flex;align-items:center;justify-content:center;
  touch-action:manipulation;min-width:34px;min-height:34px;transition:all .1s
}
.ib:active{background:var(--bg4);color:var(--green)}

/* ─── TREE ─── */
#tree{
  flex:1;overflow-y:auto;overflow-x:hidden;
  padding:6px 4px 80px;user-select:none;
  -webkit-overflow-scrolling:touch;
  scrollbar-width:thin;scrollbar-color:var(--bd) transparent
}
#tree::-webkit-scrollbar{width:3px}
#tree::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px}

.row{
  display:flex;align-items:center;padding:0 8px 0 0;
  cursor:pointer;border-radius:8px;margin:1px 4px;
  min-height:40px;gap:0;position:relative;transition:background .1s;touch-action:manipulation
}
.row:active{background:var(--bg4)}
.row.sel{background:rgba(34,211,165,.08)}
.row.sel::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:2.5px;background:var(--green);border-radius:2px}
.row-indent{display:flex;align-items:stretch;flex-shrink:0}
.row-guide{width:16px;flex-shrink:0;display:flex;justify-content:center;position:relative}
.row-guide::before{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--bd);opacity:.35}
.row .arr{width:20px;height:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--tx3)}
.row .arr svg{transition:transform .15s}
.row .arr.o svg{transform:rotate(90deg)}
.row .arr.h{opacity:0}
.row .lbl{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-family:"JetBrains Mono",monospace;color:var(--tx)}
.row .lbl.d{color:#93c5fd;font-weight:600}

/* desktop-only context buttons */
.rctx{display:none;position:absolute;right:4px;top:50%;transform:translateY(-50%);gap:1px;background:var(--bg4);border:1px solid var(--bd);border-radius:7px;padding:2px}
.cx{background:none;border:none;border-radius:5px;padding:5px 6px;cursor:pointer;color:var(--tx3);line-height:1;display:flex;align-items:center;transition:all .1s;min-width:28px;min-height:28px;justify-content:center}
.cx:active{color:var(--tx);background:var(--bg5)}

/* long-press context menu */
#ctx-menu{
  display:none;position:fixed;
  background:var(--bg2);border:1px solid var(--bd2);border-radius:14px;
  box-shadow:0 12px 48px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.4);
  z-index:9999;min-width:180px;overflow:hidden;padding:6px
}
#ctx-menu.on{display:block}
.ctx-item{
  display:flex;align-items:center;gap:10px;padding:11px 14px;
  font-size:14px;color:var(--tx);cursor:pointer;border-radius:8px;
  touch-action:manipulation;transition:background .1s
}
.ctx-item:active{background:var(--bg4)}
.ctx-item svg{color:var(--tx3);flex-shrink:0}
.ctx-item.danger{color:var(--red)}.ctx-item.danger svg{color:var(--red)}
.ctx-sep{height:1px;background:var(--bd);margin:4px 6px}

/* ─── PACKAGES ─── */
.pinput{
  width:100%;background:var(--bg3);border:1px solid var(--bd);border-radius:9px;
  padding:11px 14px;color:var(--tx);font-size:16px;outline:none;
  font-family:"Inter",sans-serif;-webkit-appearance:none;transition:border .15s
}
.pinput:focus{border-color:var(--green);background:var(--bg4)}
#pib{
  flex:1;padding:11px;border-radius:9px;
  background:var(--green2);border:1px solid var(--green);
  color:#000;font-weight:700;font-size:13px;cursor:pointer;touch-action:manipulation
}
#pib:active{background:var(--green)}
#pkg-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
#pkg-list::-webkit-scrollbar{width:3px}
#pkg-list::-webkit-scrollbar-thumb{background:var(--bd)}
.pr{display:flex;align-items:center;padding:11px 14px;border-bottom:1px solid var(--bd);gap:8px;font-size:13px}
.pr .pn{flex:1;font-family:"JetBrains Mono",monospace;color:var(--tx)}
.pr .pv{color:var(--tx3);font-size:11px}
.pr .pd{background:none;border:none;color:var(--tx3);cursor:pointer;padding:7px 8px;border-radius:7px;display:flex;align-items:center;min-width:34px;min-height:34px;justify-content:center;touch-action:manipulation}
.pr .pd:active{color:var(--red);background:rgba(248,113,113,.12)}
.pe{padding:24px;font-size:13px;color:var(--tx3);text-align:center;line-height:1.6}
#pkg-term{background:var(--bg);border-top:1px solid var(--bd);font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--green);overflow-y:auto;max-height:150px;display:none;-webkit-overflow-scrolling:touch}
#pkg-term.on{display:block}
#pkg-term pre{padding:10px 12px;white-space:pre-wrap;word-break:break-all;margin:0}
.sr-item{padding:11px 14px;cursor:pointer;border-bottom:1px solid var(--bd);touch-action:manipulation}
.sr-item:active{background:var(--bg3)}
.sr-f{font-size:10px;color:var(--tx3);font-family:"JetBrains Mono",monospace;margin-bottom:3px}
.sr-l{font-size:13px;color:var(--tx);font-family:"JetBrains Mono",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sr-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
#sr-list::-webkit-scrollbar{width:3px}

/* ─── EDITOR AREA ─── */
#right{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}

/* tabs */
#tabs-bar{
  background:var(--bg2);border-bottom:1px solid var(--bd);
  display:flex;overflow-x:auto;flex-shrink:0;min-height:40px;
  -webkit-overflow-scrolling:touch;scrollbar-width:none
}
#tabs-bar::-webkit-scrollbar{height:0}
.tab{
  display:flex;align-items:center;gap:5px;padding:0 14px;height:40px;
  border-right:1px solid var(--bd);cursor:pointer;font-size:12px;color:var(--tx3);
  white-space:nowrap;flex-shrink:0;position:relative;
  font-family:"JetBrains Mono",monospace;touch-action:manipulation;transition:background .1s
}
.tab:active{background:var(--bg3)}
.tab.on{color:var(--tx);background:var(--bg)}
.tab.on::after{content:"";position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--green)}
.tab .tx{font-size:11px;padding:3px 5px;border-radius:4px;color:var(--tx3);cursor:pointer;display:flex;align-items:center;min-width:22px;min-height:22px;justify-content:center}
.tab .tx:active{background:var(--bd);color:var(--tx)}
.tdot{width:6px;height:6px;background:var(--orange);border-radius:50%;flex-shrink:0}

/* findbar */
#findbar{display:none;background:var(--bg2);border-bottom:1px solid var(--bd);padding:7px 10px;align-items:center;gap:6px;flex-shrink:0}
#findbar.on{display:flex}
#find-in{background:var(--bg3);border:1px solid var(--bd);border-radius:8px;padding:8px 12px;color:var(--tx);font-size:15px;outline:none;flex:1;font-family:"JetBrains Mono",monospace;-webkit-appearance:none}
#find-in:focus{border-color:var(--green)}
.fbtn{background:var(--bg3);border:1px solid var(--bd);border-radius:7px;padding:7px 11px;color:var(--tx2);cursor:pointer;font-size:12px;display:flex;align-items:center;min-height:34px;touch-action:manipulation}
.fbtn:active{color:var(--green)}
#find-close{background:none;border:none;color:var(--tx3);cursor:pointer;display:flex;align-items:center;padding:7px;touch-action:manipulation}
#find-close:active{color:var(--tx)}

/* infobar */
#infobar{background:var(--bg);border-bottom:1px solid var(--bd);padding:0 12px;height:24px;display:flex;align-items:center;gap:12px;font-size:10px;color:var(--tx3);flex-shrink:0;font-family:"JetBrains Mono",monospace}
#infobar span{color:var(--tx2)}#cur-pos{margin-left:auto}

/* floating edit toolbar (mobile) */
#edit-toolbar{
  display:none;position:absolute;bottom:calc(var(--bot) + 4px);left:4px;right:4px;
  background:var(--bg2);border:1px solid var(--bd2);border-radius:12px;
  padding:6px 4px;z-index:15;
  flex-direction:row;align-items:center;gap:0;
  box-shadow:0 4px 24px rgba(0,0,0,.5);
  overflow-x:auto;scrollbar-width:none
}
#edit-toolbar::-webkit-scrollbar{height:0}
#edit-toolbar.on{display:flex}
.et-btn{
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  background:none;border:none;color:var(--tx2);cursor:pointer;
  padding:5px 10px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:.02em;
  touch-action:manipulation;min-width:44px;flex-shrink:0;transition:all .1s
}
.et-btn:active{background:var(--bg4);color:var(--green)}
.et-btn.wide{min-width:60px}
.et-sep{width:1px;height:28px;background:var(--bd);flex-shrink:0;margin:0 2px}

/* editor & welcome */
#editor-wrap{flex:1;overflow:hidden;position:relative}
#welcome{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:0;color:var(--tx3);padding:24px;text-align:center;
  background:radial-gradient(ellipse at 50% 0%,rgba(34,211,165,.04) 0%,transparent 60%)
}
.wlogo{opacity:.08;margin-bottom:16px}
.wtitle{font-size:20px;color:var(--tx);font-weight:700;margin-bottom:6px;letter-spacing:-.4px}
.wsub{font-size:13px;line-height:1.7;max-width:260px;color:var(--tx3);margin-bottom:24px}

/* quick action cards (welcome mobile) */
#wactions{display:flex;flex-direction:column;gap:10px;width:100%;max-width:300px}
.wact{
  display:flex;align-items:center;gap:12px;padding:14px 16px;
  background:var(--bg2);border:1px solid var(--bd);border-radius:12px;
  cursor:pointer;touch-action:manipulation;transition:all .1s;text-align:left
}
.wact:active{background:var(--bg3);border-color:var(--bd2)}
.wact-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.wact-icon.g{background:rgba(34,211,165,.12);color:var(--green)}
.wact-icon.b{background:rgba(96,165,250,.12);color:var(--blue)}
.wact-icon.o{background:rgba(245,158,11,.12);color:var(--orange)}
.wact-text{flex:1}
.wact-title{font-size:13px;font-weight:600;color:var(--tx);margin-bottom:2px}
.wact-desc{font-size:11px;color:var(--tx3)}
.wkeys{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-bottom:20px}
.wk{background:var(--bg3);border:1px solid var(--bd);border-radius:6px;padding:5px 10px;font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:4px}
.wk kbd{background:var(--bg4);border:1px solid var(--bd2);border-radius:3px;padding:0 4px;font-family:"JetBrains Mono",monospace;font-size:10px}

/* status bar */
#statusbar{height:22px;background:#0a0e17;border-top:1px solid var(--bd);display:flex;align-items:center;padding:0 12px;gap:10px;font-size:10px;color:var(--tx3);flex-shrink:0;font-family:"JetBrains Mono",monospace}
#statusbar .si{display:flex;align-items:center;gap:4px}#statusbar .si span{color:var(--tx2)}.ssep{width:1px;height:10px;background:var(--bd)}

/* ─── MOBILE BOTTOM BAR ─── */
#mob-bar{
  display:none;height:var(--bot);
  background:var(--bg2);border-top:1px solid var(--bd);
  flex-shrink:0;align-items:stretch;
  padding-bottom:env(safe-area-inset-bottom,0);
  position:relative;z-index:10
}
.mob-btn{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
  border:none;background:none;color:var(--tx3);cursor:pointer;
  font-size:9px;font-weight:700;letter-spacing:.03em;
  touch-action:manipulation;padding:4px 2px;
  -webkit-user-select:none;user-select:none;transition:color .1s;
  border-top:2px solid transparent
}
.mob-btn:active{color:var(--green)}
.mob-btn.active{color:var(--green);border-top-color:var(--green)}
.mob-sep{width:1px;background:var(--bd);margin:10px 0;flex-shrink:0}

/* ─── MODALS ─── */
.ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:999;align-items:flex-end;justify-content:center;backdrop-filter:blur(6px)}
.ov.on{display:flex}
@media(min-width:600px){.ov{align-items:center}}
.mbox{
  background:linear-gradient(to bottom,var(--bg3),var(--bg2));
  border:1px solid var(--bd2);border-radius:20px 20px 0 0;
  padding:20px 20px calc(20px + env(safe-area-inset-bottom,0));
  width:100%;max-width:480px;box-shadow:0 -8px 40px rgba(0,0,0,.5)
}
@media(min-width:600px){.mbox{border-radius:16px;padding-bottom:20px}}
.mbox-handle{width:40px;height:4px;background:var(--bd2);border-radius:2px;margin:0 auto 18px}
.mbox h3{margin-bottom:16px;font-size:17px;font-weight:700;color:var(--tx)}
.mbox-in{
  width:100%;background:var(--bg);border:1.5px solid var(--bd);color:var(--tx);
  padding:13px 15px;border-radius:11px;font-size:16px;outline:none;
  font-family:"JetBrains Mono",monospace;margin-bottom:14px;
  -webkit-appearance:none;transition:border .15s
}
.mbox-in:focus{border-color:var(--green);background:var(--bg4)}
.mbts{display:flex;gap:10px;margin-top:6px}
.mbts button{flex:1;padding:14px;border-radius:11px;cursor:pointer;font-size:15px;font-weight:700;border:1px solid var(--bd);touch-action:manipulation}
.mok{background:var(--green2);border-color:var(--green);color:#000}.mok:active{background:var(--green)}
.mcancel{background:var(--bg3);color:var(--tx2);border-color:var(--bd)}.mcancel:active{background:var(--bg4)}
.dz{border:2px dashed var(--bd);border-radius:12px;padding:28px 20px;text-align:center;margin-bottom:14px;cursor:pointer;transition:all .2s;font-size:14px;color:var(--tx3);touch-action:manipulation}
.dz:active,.dz.over{border-color:var(--green);background:rgba(34,211,165,.06);color:var(--green)}

/* toast */
.toast{
  position:fixed;bottom:calc(var(--bot) + 16px);left:50%;
  transform:translateX(-50%) translateY(10px);
  background:var(--bg2);border:1px solid var(--bd2);
  padding:10px 18px;border-radius:11px;font-size:13px;font-weight:500;
  z-index:9999;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:90vw;text-align:center
}
.toast.on{opacity:1;transform:translateX(-50%)}
.toast.ok{border-color:var(--green);color:var(--green);background:rgba(10,14,23,.95)}
.toast.err{border-color:var(--red);color:var(--red);background:rgba(10,14,23,.95)}
.toast.info{border-color:var(--blue);color:var(--blue)}

/* ─── DESKTOP (≥768px) ─── */
@media(min-width:768px){
  :root{--top:44px;--bot:0px}
  #side{position:relative;top:auto;bottom:auto;left:auto;transform:none!important;box-shadow:none;width:240px;border-right:1px solid var(--bd)}
  #side-ov{display:none!important}
  #mbtn{display:none!important}
  #mob-bar{display:none!important}
  #edit-toolbar{display:none!important}
  .row{min-height:28px}.row .arr{height:28px}.row .lbl{font-size:12px}
  .stab{min-height:34px;padding:7px 4px 6px}
  .tbtn span{display:inline}
  .bot-chip{max-width:180px}
  .tab{height:34px;font-size:11px}.tab .tx{opacity:0}.tab:hover .tx,.tab.on .tx{opacity:1}
  .tab:hover{background:var(--bg3)}
  .row:hover{background:var(--bg3)}.row:hover .rctx{display:flex}
  .rctx{display:none}
  .toast{bottom:28px}
  .pr{padding:6px 10px;font-size:12px}.pr .pd{padding:3px 6px}
  .stab:hover:not(.on){color:var(--tx2)}
  #wactions{flex-direction:row;flex-wrap:wrap;justify-content:center;gap:8px;max-width:400px}
  .wact{flex-direction:column;align-items:center;text-align:center;padding:16px 12px;flex:1;min-width:110px;max-width:130px}
  .wact-icon{margin-bottom:6px}
  .wact-text{text-align:center}
  #infobar{display:flex!important}
  #statusbar{display:flex!important}
}

/* ─── MOBILE (<768px) ─── */
@media(max-width:767px){
  #mob-bar{display:flex}
  #mbtn{display:flex}
  .tbtn span{display:none}
  .bot-chip{max-width:80px}
  #statusbar{display:none}
  #infobar{display:none!important}
  .tab .tx{opacity:1}
  .wkeys{display:none}
  #right{position:relative}
}
</style>
</head>
<body>
<div id="topbar">
  <button id="mbtn" onclick="toggleSide()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
  <div class="logo"><div class="logo-dot"></div>ARES</div>
  <div class="bot-chip" title="${botId}">${botId}</div>
  <div class="sp"></div>
  <div id="status-wrap"><div id="si"></div><span id="st"></span></div>
  <span id="unsaved" style="display:none;font-size:10px;color:var(--orange);margin:0 4px">&#9679;</span>
  <button class="tbtn" id="btn-ren" style="display:none" onclick="doRename()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>Renomear</span></button>
  <button class="tbtn r" id="btn-del" style="display:none" onclick="doDel()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg><span>Excluir</span></button>
  <button class="tbtn g" id="btn-save" style="display:none" onclick="doSave()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2 2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Salvar</button>
</div>
<div id="layout">
  <div id="side-ov" onclick="closeSide()"></div>
  <div id="side">
    <div id="stabs">
      <div class="stab on" id="stab-files" onclick="showPanel('files')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>Arquivos</div>
      <div class="stab" id="stab-packages" onclick="showPanel('packages')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Libs</div>
      <div class="stab" id="stab-search" onclick="showPanel('search')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Busca</div>
    </div>
    <div class="panel on" id="panel-files">
      <div class="ph">
        <span class="ptitle">Explorer</span>
        <div class="pbtns">
          <button class="ib" title="Upload de arquivo" onclick="openUploadModal()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polyline points="10 10 7 7 4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="7" y1="7" x2="7" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2 10A5 5 0 1 1 12 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg></button>
          <button class="ib" title="Novo arquivo" onclick="doNewFile()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8 2H3.5A1.5 1.5 0 0 0 2 3.5v7A1.5 1.5 0 0 0 3.5 12h7A1.5 1.5 0 0 0 12 10.5V6L8 2Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 2v4h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="7" y1="9" x2="7" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="7.5" x2="8.5" y2="7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
          <button class="ib" title="Nova pasta" onclick="doNewFolder()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.5 3C1.5 2.17 2.17 1.5 3 1.5H5.8l1 1.5H11C11.83 3 12.5 3.67 12.5 4.5v6C12.5 11.33 11.83 12 11 12H3C2.17 12 1.5 11.33 1.5 10.5V3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><line x1="7" y1="6" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.2" y1="7.75" x2="8.8" y2="7.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
          <button class="ib" title="Atualizar árvore" onclick="loadTree()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M13 2.5v4h-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 11.5v-4h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.34 5.5A5 5 0 0 1 11.66 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M11.66 8.5A5 5 0 0 1 2.34 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg></button>
        </div>
      </div>
      <div id="tree"><div style="padding:12px;font-size:12px;color:var(--tx3)">Carregando...</div></div>
      <input type="file" id="upload-input" multiple style="display:none">
    </div>
    <div class="panel" id="panel-packages">
      <div class="ph"><span class="ptitle">Pacotes npm</span></div>
      <div style="padding:8px;border-bottom:1px solid var(--bd)"><input class="pinput" id="pkg-in" type="text" placeholder="axios, lodash, dotenv..." spellcheck="false"></div>
      <div style="display:flex;gap:6px;padding:8px">
        <button id="pib" onclick="installPkg()"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="display:inline;vertical-align:middle;margin-right:4px"><path d="M6.5 1.5v7M4 6l2.5 2.5L9 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M1.5 10.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>Instalar</button>
        <button class="tbtn" style="font-size:11px;padding:5px 8px" onclick="installPkg('dev')">Dev</button>
      </div>
      <div id="pkg-list"><div class="pe">Carregando...</div></div>
      <div id="pkg-term"><pre id="pkg-out"></pre></div>
    </div>
    <div class="panel" id="panel-search">
      <div class="ph"><span class="ptitle">Buscar nos Arquivos</span></div>
      <div style="padding:8px;border-bottom:1px solid var(--bd)"><input class="pinput" id="search-in" type="text" placeholder="Buscar em todos os arquivos..." spellcheck="false"></div>
      <div id="sr-list"><div class="pe">Digite para buscar...</div></div>
    </div>
  </div>
  <div id="right">
    <div id="tabs-bar"></div>
    <div id="findbar">
      <input id="find-in" type="text" placeholder="Buscar..." spellcheck="false" autocorrect="off" autocapitalize="off">
      <button class="fbtn" onclick="findPrev()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg></button>
      <button class="fbtn" onclick="findNext()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button>
      <button class="fbtn" onclick="findReplace()" style="display:none" id="fb-replace">Troca</button>
      <button id="find-close" onclick="closeFindBar()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div id="infobar" style="display:none"><div id="ib-lang">&mdash;</div><div class="ssep"></div><div id="ib-size">&mdash;</div><div class="ssep"></div><div>UTF-8</div><div id="cur-pos">Ln 1, Col 1</div></div>
    <div id="editor-wrap" style="display:none"></div>
    <div id="welcome">
      <svg class="wlogo" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=".8"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      <div class="wtitle">ARES Editor</div>
      <div class="wsub">Selecione um arquivo no explorador ou crie um novo para começar</div>
      <div class="wkeys"><div class="wk"><kbd>Ctrl+S</kbd> Salvar</div><div class="wk"><kbd>Ctrl+F</kbd> Buscar</div><div class="wk"><kbd>Ctrl+Z</kbd> Desfazer</div></div>
      <div id="wactions">
        <div class="wact" onclick="doNewFile()">
          <div class="wact-icon g"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg></div>
          <div class="wact-text"><div class="wact-title">Novo arquivo</div><div class="wact-desc">Criar do zero</div></div>
        </div>
        <div class="wact" onclick="mobShowFiles()">
          <div class="wact-icon b"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
          <div class="wact-text"><div class="wact-title">Explorador</div><div class="wact-desc">Ver arquivos</div></div>
        </div>
        <div class="wact" onclick="openUploadModal()">
          <div class="wact-icon o"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg></div>
          <div class="wact-text"><div class="wact-title">Upload</div><div class="wact-desc">Enviar arquivo</div></div>
        </div>
      </div>
    </div>
    <!-- Floating edit toolbar for mobile -->
    <div id="edit-toolbar">
      <button class="et-btn" onclick="insertSnippet('  ')" title="Tab"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/><line x1="6" y1="12" x2="15" y2="12"/></svg>Tab</button>
      <div class="et-sep"></div>
      <button class="et-btn" onclick="insertSnippet('{}')" title="{}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2"/><path d="M15 4h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/></svg>{}</button>
      <button class="et-btn" onclick="insertSnippet('[]')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="7 7 3 12 7 17"/><polyline points="17 7 21 12 17 17"/></svg>[]</button>
      <button class="et-btn" onclick="insertSnippet('()')">( )</button>
      <button class="et-btn" onclick="insertSnippet('\"\"')">" "</button>
      <button class="et-btn" onclick="insertSnippet('\`\`')">\` \`</button>
      <div class="et-sep"></div>
      <button class="et-btn" onclick="edUndo()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>Undo</button>
      <button class="et-btn" onclick="edRedo()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>Redo</button>
      <div class="et-sep"></div>
      <button class="et-btn" onclick="edMoveLine(-1)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>Cima</button>
      <button class="et-btn" onclick="edMoveLine(1)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>Baixo</button>
      <div class="et-sep"></div>
      <button class="et-btn" onclick="doSave()" style="color:var(--green)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Salvar</button>
    </div>
    <div id="statusbar"><div class="si"><svg width="6" height="6" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#22d3a5"/></svg><span id="sb-text">Pronto</span></div><div class="ssep"></div><div class="si">Tab: <span>2 esp</span></div></div>
  </div>
</div>

<!-- Mobile bottom toolbar -->
<div id="mob-bar">
  <button class="mob-btn" id="mob-files" onclick="mobShowFiles()">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    Arquivos
  </button>
  <div class="mob-sep"></div>
  <button class="mob-btn" id="mob-save" onclick="doSave()" style="display:none">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    Salvar
  </button>
  <button class="mob-btn" id="mob-search-btn" onclick="mobToggleFind()" style="display:none">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    Buscar
  </button>
  <div class="mob-sep" id="mob-sep2" style="display:none"></div>
  <button class="mob-btn" id="mob-newfile" onclick="doNewFile()">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
    Novo
  </button>
  <div class="mob-sep"></div>
  <button class="mob-btn" id="mob-pkg" onclick="mobShowPkg()">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
    Libs
  </button>
</div>

<!-- Long-press context menu -->
<div id="ctx-menu">
  <div class="ctx-item" id="ctx-open"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Abrir</div>
  <div class="ctx-item" id="ctx-ren"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Renomear</div>
  <div class="ctx-item" id="ctx-dup"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Duplicar</div>
  <div class="ctx-item" id="ctx-dl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item danger" id="ctx-del"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg> Excluir</div>
</div>

<div class="toast" id="toast"></div>
<div class="ov" id="modal"><div class="mbox"><div class="mbox-handle"></div><h3 id="modal-title">Nome</h3><input class="mbox-in" id="modal-in" type="text" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="off"><div class="mbts"><button class="mcancel" onclick="closeModal()">Cancelar</button><button class="mok" onclick="confirmModal()">OK</button></div></div></div>
<div class="ov" id="modal-upload">
  <div class="mbox">
    <div class="mbox-handle"></div>
    <h3>Upload de Arquivos</h3>
    <div class="dz" id="dz"><svg width="32" height="32" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:0 auto 10px;opacity:.4"><polyline points="18 18 14 14 10 18" stroke-linecap="round" stroke-linejoin="round"/><line x1="14" y1="14" x2="14" y2="23" stroke-linecap="round"/><path d="M23.5 22A5.5 5.5 0 1 0 8 18" stroke-linecap="round" fill="none"/></svg>Toque para selecionar arquivos<input type="file" id="upl2" multiple style="display:none"></div>
    <div id="upl-prog" style="font-size:13px;color:var(--tx3);min-height:20px;text-align:center"></div>
    <div class="mbts" style="margin-top:14px"><button class="mcancel" onclick="closeUploadModal()">Fechar</button></div>
  </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket = io();
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<script>
var BOT_ID = ${B};
var TOK = ${T};
var API = ${A};
var ed = null;
var curFile = null;
var openDirs = new Set();
var treeData = [];
var tabs = [];
var models = {};
var dirty = {};
var modalCb = null;
var ctxTarget = null;
var longPressTimer = null;
var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function mobShowFiles() {
  showPanel('files');
  toggleSide();
  document.getElementById('mob-files').classList.add('active');
  document.getElementById('mob-pkg').classList.remove('active');
}

function mobShowPkg() {
  showPanel('packages');
  toggleSide();
  document.getElementById('mob-pkg').classList.add('active');
  document.getElementById('mob-files').classList.remove('active');
}

function mobToggleFind() {
  var fb = document.getElementById('findbar');
  if (fb.classList.contains('on')) {
    closeFindBar();
  } else {
    openFindBar();
  }
}

function updateMobBar() {
  var hasFile = !!curFile;
  var saveBtn = document.getElementById('mob-save');
  var searchBtn = document.getElementById('mob-search-btn');
  var sep2 = document.getElementById('mob-sep2');
  if (saveBtn) { saveBtn.style.display = hasFile ? 'flex' : 'none'; }
  if (searchBtn) { searchBtn.style.display = hasFile ? 'flex' : 'none'; }
  if (sep2) { sep2.style.display = hasFile ? 'block' : 'none'; }
}

function showCtxMenu(p, isDir, x, y) {
  ctxTarget = { p: p, isDir: isDir };
  var menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-open').style.display = isDir ? 'none' : 'flex';
  document.getElementById('ctx-dup').style.display = isDir ? 'none' : 'flex';
  document.getElementById('ctx-dl').style.display = isDir ? 'none' : 'flex';
  menu.classList.add('on');
  var mw = 180, mh = 220;
  var cx = Math.min(x, window.innerWidth - mw - 8);
  var cy = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = cx + 'px';
  menu.style.top = cy + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('on');
  ctxTarget = null;
}

function insertSnippet(s) {
  if (!ed) return;
  var sel = ed.getSelection();
  if (sel && !sel.isEmpty()) {
    var txt = ed.getModel().getValueInRange(sel);
    ed.executeEdits('', [{ range: sel, text: s[0] + txt + s[s.length-1] }]);
  } else {
    var pos = ed.getPosition();
    ed.executeEdits('', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: s }]);
    if (s.length === 2) ed.setPosition({ lineNumber: pos.lineNumber, column: pos.column + 1 });
  }
  ed.focus();
}
function edUndo() { if (ed) { ed.trigger('kb','undo',null); ed.focus(); } }
function edRedo() { if (ed) { ed.trigger('kb','redo',null); ed.focus(); } }
function edMoveLine(dir) {
  if (!ed) return;
  ed.trigger('kb', dir < 0 ? 'editor.action.moveLinesUpAction' : 'editor.action.moveLinesDownAction', null);
  ed.focus();
}
function showEditToolbar() { if (isMobile && curFile) document.getElementById('edit-toolbar').classList.add('on'); }
function hideEditToolbar() { document.getElementById('edit-toolbar').classList.remove('on'); }
if (isMobile && window.visualViewport) {
  var lastVH = window.visualViewport.height;
  window.visualViewport.addEventListener('resize', function() {
    var h = window.visualViewport.height;
    if (h < lastVH - 80) showEditToolbar();
    else hideEditToolbar();
    lastVH = h;
  });
}

function au(a, e) {
  return API + a + '?s=' + TOK + (e ? '&' + e : '');
}

function setStatus(t, c) {
  var si = document.getElementById('si');
  var st = document.getElementById('st');
  var sb = document.getElementById('sb-text');
  si.className = c || '';
  st.textContent = t;
  if (sb) sb.textContent = t;
}

function toggleSide() {
  document.getElementById('side').classList.toggle('open');
  document.getElementById('side-ov').classList.toggle('on');
}

function closeSide() {
  document.getElementById('side').classList.remove('open');
  document.getElementById('side-ov').classList.remove('on');
}

function showPanel(n) {
  ['files', 'packages', 'search'].forEach(function(p) {
    document.getElementById('panel-' + p).classList.toggle('on', p === n);
    document.getElementById('stab-' + p).classList.toggle('on', p === n);
  });
  if (n === 'packages') loadPkgs();
}

function xExt(n) {
  return n.includes('.') ? n.split('.').pop().toLowerCase() : '';
}

function getLang(n) {
  var m = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    json: 'json', py: 'python', md: 'markdown', sh: 'shell', bash: 'shell', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', yml: 'yaml', yaml: 'yaml', txt: 'plaintext', xml: 'xml', sql: 'sql',
    php: 'php', rb: 'ruby', go: 'go', rs: 'rust', cpp: 'cpp', c: 'c', h: 'c', java: 'java',
    dockerfile: 'dockerfile', env: 'plaintext', gitignore: 'plaintext'
  };
  return m[xExt(n)] || 'plaintext';
}

function fmtSz(b) {
  if (b > 1048576) return (b / 1048576).toFixed(2) + 'MB';
  if (b > 1024) return (b / 1024).toFixed(1) + 'KB';
  return b + 'B';
}

function hEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toast(m, t) {
  var el = document.getElementById('toast');
  el.textContent = m;
  el.className = 'toast on ' + (t || '');
  clearTimeout(el._t);
  el._t = setTimeout(function() { el.className = 'toast'; }, 3000);
}

function fileIcon(n) {
  var e = xExt(n);
  var ico = {
    js:  '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#f7df1e"/><text x="2.5" y="11.5" font-size="8" font-family="monospace" font-weight="bold" fill="#000">JS</text></svg>',
    mjs: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#f7df1e"/><text x="2.5" y="11.5" font-size="8" font-family="monospace" font-weight="bold" fill="#000">JS</text></svg>',
    cjs: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#f7df1e"/><text x="2.5" y="11.5" font-size="8" font-family="monospace" font-weight="bold" fill="#000">JS</text></svg>',
    ts:  '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#3178c6"/><text x="1.5" y="11.5" font-size="8" font-family="monospace" font-weight="bold" fill="#fff">TS</text></svg>',
    tsx: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#3178c6"/><text x="0.5" y="11.5" font-size="7.5" font-family="monospace" font-weight="bold" fill="#fff">TSX</text></svg>',
    jsx: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#61dafb"/><text x="0.5" y="11.5" font-size="7.5" font-family="monospace" font-weight="bold" fill="#000">JSX</text></svg>',
    json:'<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a2234" stroke="#f59e0b" stroke-width=".8"/><text x="1" y="9.5" font-size="6.5" font-family="monospace" font-weight="bold" fill="#f59e0b">{}</text></svg>',
    py:  '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#306998"/><text x="2" y="11.5" font-size="8" font-family="monospace" font-weight="bold" fill="#ffd43b">PY</text></svg>',
    html:'<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a0a00" stroke="#e44d26" stroke-width=".8"/><text x=".5" y="9.5" font-size="6" font-family="monospace" font-weight="bold" fill="#e44d26">HTML</text></svg>',
    htm: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a0a00" stroke="#e44d26" stroke-width=".8"/><text x=".5" y="9.5" font-size="6" font-family="monospace" font-weight="bold" fill="#e44d26">HTML</text></svg>',
    css: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2965f1"/><text x="1" y="11.5" font-size="8" font-family="monospace" font-weight="bold" fill="#fff">CSS</text></svg>',
    scss:'<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#c6538c"/><text x=".5" y="11.5" font-size="7.5" font-family="monospace" font-weight="bold" fill="#fff">SCS</text></svg>',
    md:  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a2234" stroke="#94a3b8" stroke-width=".8"/><text x="1" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#94a3b8">MD</text></svg>',
    env: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#0a1a0a" stroke="#22d3a5" stroke-width=".8"/><path d="M3 5h7M3 8h5" stroke="#22d3a5" stroke-width="1.2" stroke-linecap="round"/></svg>',
    sh:  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a1230" stroke="#a78bfa" stroke-width=".8"/><text x="1.5" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#a78bfa">SH</text></svg>',
    bash:'<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a1230" stroke="#a78bfa" stroke-width=".8"/><text x="1.5" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#a78bfa">SH</text></svg>',
    yml: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#0d1525" stroke="#60a5fa" stroke-width=".8"/><text x="1" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#60a5fa">YML</text></svg>',
    yaml:'<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#0d1525" stroke="#60a5fa" stroke-width=".8"/><text x="1" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#60a5fa">YML</text></svg>',
    sql: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#0d1a1a" stroke="#2dd4bf" stroke-width=".8"/><text x=".5" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#2dd4bf">SQL</text></svg>',
    txt: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a2234" stroke="#64748b" stroke-width=".8"/><path d="M3 4.5h7M3 6.5h7M3 8.5h4.5" stroke="#64748b" stroke-width="1" stroke-linecap="round"/></svg>',
    xml: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a0e0a" stroke="#fb923c" stroke-width=".8"/><text x=".5" y="9.5" font-size="6.5" font-family="monospace" font-weight="bold" fill="#fb923c">XML</text></svg>',
    go:  '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#00add8"/><text x="2" y="11.5" font-size="8" font-family="monospace" font-weight="bold" fill="#fff">GO</text></svg>',
    rs:  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a0800" stroke="#f97316" stroke-width=".8"/><text x="1.5" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#f97316">RS</text></svg>',
    php: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a1230" stroke="#8b5cf6" stroke-width=".8"/><text x=".5" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#8b5cf6">PHP</text></svg>',
    rb:  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a0008" stroke="#ef4444" stroke-width=".8"/><text x="1.5" y="9.5" font-size="7" font-family="monospace" font-weight="bold" fill="#ef4444">RB</text></svg>',
    java:'<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#0d0e1a" stroke="#f59e0b" stroke-width=".8"/><text x=".5" y="9.5" font-size="6.5" font-family="monospace" font-weight="bold" fill="#f59e0b">JAV</text></svg>',
  };
  return ico[e] || '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect width="13" height="13" rx="2.5" fill="#1a2234" stroke="#334155" stroke-width=".8"/><path d="M4 3.5h3.5L9.5 5.5V9.5H4V3.5Z" stroke="#64748b" stroke-width=".8" fill="none"/><path d="M7.5 3.5V5.5H9.5" stroke="#64748b" stroke-width=".8" fill="none"/></svg>';
}

function folderIcon(o) {
  return o
    ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 3.5C1 2.67 1.67 2 2.5 2H5.3l1 1.5H11.5C12.33 3.5 13 4.17 13 5v5.5C13 11.33 12.33 12 11.5 12h-9C1.67 12 1 11.33 1 10.5V3.5Z" fill="#1e3a5f" stroke="#3b82f6" stroke-width=".7"/><path d="M1 6h12" stroke="#3b82f6" stroke-width=".6" opacity=".5"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 3.5C1 2.67 1.67 2 2.5 2H5.3l1 1.5H11.5C12.33 3.5 13 4.17 13 5v5.5C13 11.33 12.33 12 11.5 12h-9C1.67 12 1 11.33 1 10.5V3.5Z" fill="#152233" stroke="#4b6a8a" stroke-width=".7"/></svg>';
}

function arrowIcon() {
  return '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function iconAdd() { return '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><line x1="5.5" y1="1" x2="5.5" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="5.5" x2="10" y2="5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
function iconTrash() { return '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 3h8M4 3V2h3v1M2.5 3l.5 6h5l.5-6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function iconDownload() { return '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1v6M3 5l2.5 2.5L8 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M1.5 9h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'; }
function iconCopy() { return '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 7.5H2a.5.5 0 0 1-.5-.5V2A.5.5 0 0 1 2 1.5h5a.5.5 0 0 1 .5.5v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'; }
function iconEdit() { return '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M7.5 1.5l2 2L4 9H2V7L7.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }

function buildRows(items, depth, parentGuides) {
  var h = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var isLast = i === items.length - 1;
    var hp = hEsc(it.path);
    var hn = hEsc(it.name);

    var indentHtml = '';
    for (var g = 0; g < depth; g++) {
      var showGuide = parentGuides[g];
      indentHtml += '<span class="row-guide"' + (showGuide ? '' : ' style="opacity:0"') + '></span>';
    }

    if (it.type === 'dir') {
      var o = openDirs.has(it.path);
      h += '<div class="row" data-act="dir" data-p="' + hp + '">';
      h += '<div class="row-indent">' + indentHtml + '</div>';
      h += '<span class="arr ' + (o ? 'o' : '') + '">' + arrowIcon() + '</span>';
      h += folderIcon(o);
      h += '<span class="lbl d" style="margin-left:5px">' + hn + '</span>';
      h += '<div class="rctx">';
      h += '<button class="cx" data-act="nfi" data-p="' + hp + '" title="Novo arquivo">' + iconAdd() + '</button>';
      h += '<button class="cx" data-act="delf" data-p="' + hp + '" title="Excluir pasta">' + iconTrash() + '</button>';
      h += '</div></div>';
      if (o && it.children && it.children.length) {
        var childGuides = parentGuides.concat(!isLast);
        h += buildRows(it.children, depth + 1, childGuides);
      }
    } else {
      var sel = curFile === it.path ? ' sel' : '';
      h += '<div class="row' + sel + '" data-act="open" data-p="' + hp + '">';
      h += '<div class="row-indent">' + indentHtml + '</div>';
      h += '<span class="arr h">' + arrowIcon() + '</span>';
      h += '<span style="flex-shrink:0;display:flex;align-items:center">' + fileIcon(it.name) + '</span>';
      h += '<span class="lbl" style="margin-left:5px">' + hn + '</span>';
      h += '<div class="rctx">';
      h += '<button class="cx" data-act="dl"   data-p="' + hp + '" title="Download">' + iconDownload() + '</button>';
      h += '<button class="cx" data-act="dup"  data-p="' + hp + '" title="Duplicar">' + iconCopy() + '</button>';
      h += '<button class="cx" data-act="qren" data-p="' + hp + '" title="Renomear">' + iconEdit() + '</button>';
      h += '<button class="cx" data-act="del1" data-p="' + hp + '" title="Excluir">' + iconTrash() + '</button>';
      h += '</div></div>';
    }
  }
  return h;
}

function renderTree() {
  var el = document.getElementById('tree');
  if (!treeData.length) {
    el.innerHTML = '<div style="padding:14px 12px;font-size:11px;color:var(--tx3);text-align:center"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:0 auto 6px;opacity:.3"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>Pasta vazia</div>';
    return;
  }
  var dirs = treeData.filter(function(x) { return x.type === 'dir'; });
  var files = treeData.filter(function(x) { return x.type === 'file'; });
  var html = '';
  if (dirs.length) {
    html += buildRows(dirs, 0, []);
  }
  if (files.length) {
    if (dirs.length) html += '<div style="height:1px;background:var(--bd);margin:4px 8px;opacity:.4"></div>';
    html += buildRows(files, 0, []);
  }
  el.innerHTML = html;
}

function toggleDir(p) {
  openDirs.has(p) ? openDirs.delete(p) : openDirs.add(p);
  renderTree();
}

async function loadTree() {
  var el = document.getElementById('tree');
  el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--tx3)">Carregando...</div>';
  try {
    var r = await fetch(au('/tree'));
    if (!r.ok) {
      el.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--red)">HTTP ' + r.status + ': ' + hEsc((await r.text()).substring(0, 100)) + '</div>';
      return;
    }
    treeData = await r.json();
    renderTree();
  } catch (e) {
    el.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--red)">' + hEsc(e.message) + '</div>';
  }
}

function renderTabs() {
  var el = document.getElementById('tabs-bar');
  el.innerHTML = tabs.map(function(t) {
    var name = t.split('/').pop();
    var on = t === curFile ? ' on' : '';
    var right = dirty[t] ? '<span class="tdot"></span>' : '<span class="tx" data-tc="' + hEsc(t) + '">✕</span>';
    return '<div class="tab' + on + '" data-to="' + hEsc(t) + '" title="' + hEsc(t) + '">' + fileIcon(name) + hEsc(name) + right + '</div>';
  }).join('');
}

function switchTo(p) {
  if (p !== curFile) openFile(p);
}

function closeTab(p) {
  if (dirty[p] && !confirm('Fechar sem salvar?')) return;
  tabs = tabs.filter(function(x) { return x !== p; });
  if (models[p]) {
    models[p].dispose();
    delete models[p];
  }
  delete dirty[p];
  if (curFile === p) {
    tabs.length ? openFile(tabs[tabs.length - 1]) : clearEditor();
  }
  renderTabs();
}

function clearEditor() {
  curFile = null;
  if (ed) ed.setValue('');
  document.getElementById('editor-wrap').style.display = 'none';
  document.getElementById('welcome').style.display = 'flex';
  document.getElementById('infobar').style.display = 'none';
  document.getElementById('unsaved').style.display = 'none';
  ['btn-save', 'btn-del', 'btn-ren'].forEach(function(id) {
    document.getElementById(id).style.display = 'none';
  });
  updateMobBar();
  renderTree();
}

async function openFile(p) {
  if (!ed) {
    setTimeout(function() { openFile(p); }, 150);
    return;
  }
  if (!models[p]) {
    try {
      setStatus('Abrindo...', 'loading');
      var r = await fetch(au('/read', 'path=' + encodeURIComponent(p)));
      if (!r.ok) {
        toast('Erro ao abrir (' + r.status + ')', 'err');
        setStatus('Erro', 'err');
        return;
      }
      var content = await r.text();
      models[p] = monaco.editor.createModel(content, getLang(p));
      dirty[p] = false;
      if (tabs.indexOf(p) === -1) tabs.push(p);
      models[p].onDidChangeContent(function() {
        dirty[p] = true;
        if (curFile === p) document.getElementById('unsaved').style.display = 'inline';
        renderTabs();
      });
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
      setStatus('Erro', 'err');
      return;
    }
  }
  curFile = p;
  ed.setModel(models[p]);
  document.getElementById('editor-wrap').style.display = 'block';
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('infobar').style.display = 'flex';
  updateInfo();
  ['btn-save', 'btn-del', 'btn-ren'].forEach(function(id) {
    document.getElementById(id).style.display = 'inline-flex';
  });
  document.getElementById('unsaved').style.display = dirty[p] ? 'inline' : 'none';
  updateMobBar();
  renderTree();
  renderTabs();
  closeSide();
  ed.focus();
  setStatus('Pronto', 'ok');
}

function updateInfo() {
  if (!curFile || !ed) return;
  document.getElementById('ib-lang').textContent = getLang(curFile.split('/').pop());
  document.getElementById('ib-size').textContent = fmtSz(new Blob([ed.getValue()]).size);
  var pos = ed.getPosition();
  if (pos) document.getElementById('cur-pos').textContent = 'Ln ' + pos.lineNumber + ', Col ' + pos.column;
}

async function doSave() {
  if (!curFile || !ed) return;
  setStatus('Salvando...', 'loading');
  try {
    var r = await fetch(au('/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: curFile, content: ed.getValue() })
    });
    if (r.ok) {
      dirty[curFile] = false;
      document.getElementById('unsaved').style.display = 'none';
      renderTabs();
      toast('Salvo!', 'ok');
      setStatus('Salvo', 'ok');
      setTimeout(function() { setStatus('Pronto', 'ok'); }, 2000);
    } else {
      toast('Erro ao salvar: ' + await r.text(), 'err');
      setStatus('Erro', 'err');
    }
  } catch (e) {
    toast('Erro: ' + e.message, 'err');
    setStatus('Erro', 'err');
  }
}

async function doDel() {
  if (!curFile || !confirm('Excluir "' + curFile + '"?')) return;
  var r = await fetch(au('/delete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: curFile })
  });
  if (r.ok) {
    toast('Excluido', 'ok');
    closeTab(curFile);
    loadTree();
  } else {
    toast('Erro: ' + await r.text(), 'err');
  }
}

async function delFolder(p) {
  if (!confirm('Excluir pasta "' + p + '" e todo o conteudo?')) return;
  var r = await fetch(au('/delete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p })
  });
  if (r.ok) {
    toast('Pasta excluida', 'ok');
    loadTree();
  } else {
    toast('Erro: ' + await r.text(), 'err');
  }
}

async function doRename() {
  if (!curFile) return;
  var parts = curFile.split('/');
  var nn = prompt('Novo nome:', parts[parts.length - 1]);
  if (!nn || nn === parts[parts.length - 1]) return;
  await renFile(curFile, parts.slice(0, -1).concat(nn).join('/'));
}

async function qRename(p) {
  var parts = p.split('/');
  var nn = prompt('Novo nome:', parts[parts.length - 1]);
  if (!nn || nn === parts[parts.length - 1]) return;
  await renFile(p, parts.slice(0, -1).concat(nn).join('/'));
}

async function renFile(from, to) {
  var r = await fetch(au('/rename'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: from, to: to })
  });
  if (r.ok) {
    var ti = tabs.indexOf(from);
    if (ti > -1) tabs[ti] = to;
    if (models[from]) {
      models[to] = models[from];
      delete models[from];
    }
    if (dirty[from] !== undefined) {
      dirty[to] = dirty[from];
      delete dirty[from];
    }
    if (curFile === from) curFile = to;
    await loadTree();
    if (curFile === to) openFile(to);
    toast('Renomeado', 'ok');
  } else {
    toast('Erro: ' + await r.text(), 'err');
  }
}

async function dupFile(p) {
  var parts = p.split('/');
  var name = parts[parts.length - 1];
  var di = name.lastIndexOf('.');
  var nn = di > 0 ? name.slice(0, di) + '_copy' + name.slice(di) : name + '_copy';
  var np = parts.slice(0, -1).concat(nn).join('/');
  var rr = await fetch(au('/read', 'path=' + encodeURIComponent(p)));
  if (!rr.ok) return;
  var rw = await fetch(au('/write'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: np, content: await rr.text() })
  });
  if (rw.ok) {
    await loadTree();
    toast('Duplicado', 'ok');
  } else {
    toast('Erro', 'err');
  }
}

function dlFile(p) {
  var a = document.createElement('a');
  a.href = au('/download', 'path=' + encodeURIComponent(p));
  a.download = p.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function doNewFile() {
  var folder = curFile ? curFile.split('/').slice(0, -1).join('/') : '';
  openModal('Novo arquivo', 'nome.js', async function(fn) {
    var fp = folder ? folder + '/' + fn : fn;
    var r = await fetch(au('/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fp, content: getTpl(fn) })
    });
    if (r.ok) {
      await loadTree();
      openFile(fp);
      toast('Criado', 'ok');
    } else {
      toast('Erro: ' + await r.text(), 'err');
    }
  });
}

function doNewFileIn(folder) {
  openModal('Novo arquivo em /' + folder, 'nome.js', async function(fn) {
    var fp = folder + '/' + fn;
    var r = await fetch(au('/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fp, content: getTpl(fn) })
    });
    if (r.ok) {
      await loadTree();
      openFile(fp);
      toast('Criado', 'ok');
    } else {
      toast('Erro: ' + await r.text(), 'err');
    }
  });
}

function doNewFolder() {
  var folder = curFile ? curFile.split('/').slice(0, -1).join('/') : '';
  openModal('Nova pasta', 'minha-pasta', async function(fn) {
    var fp = folder ? folder + '/' + fn : fn;
    var r = await fetch(au('/mkdir'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fp })
    });
    if (r.ok) {
      await loadTree();
      openDirs.add(fp);
      renderTree();
      toast('Pasta criada', 'ok');
    } else {
      toast('Erro: ' + await r.text(), 'err');
    }
  });
}

function getTpl(n) {
  var e = xExt(n);
  if (e === 'js') return '\\n\\n';
  if (e === 'json') return '{\\n  \\n}\\n';
  if (e === 'html') return '<!DOCTYPE html>\\n<html>\\n<head>\\n  <meta charset="UTF-8">\\n  <title></title>\\n</head>\\n<body>\\n  \\n</body>\\n</html>';
  if (e === 'md') return '# ' + n.replace('.md', '') + '\\n\\n';
  if (e === 'py') return '\\n\\n';
  if (e === 'css') return '\\n\\n';
  if (e === 'env') return '\\n\\n';
  return '';
}

function openUploadModal() {
  document.getElementById('modal-upload').classList.add('on');
}

function closeUploadModal() {
  document.getElementById('modal-upload').classList.remove('on');
}

async function uploadFiles(files) {
  var prog = document.getElementById('upl-prog');
  var ok = 0;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    prog.textContent = 'Enviando ' + f.name + '...';
    var folder = curFile ? curFile.split('/').slice(0, -1).join('/') : '';
    var fp = folder ? folder + '/' + f.name : f.name;
    var content = await f.text().catch(function() { return null; });
    if (content === null) {
      prog.textContent = 'Erro: ' + f.name + ' (binario)';
      continue;
    }
    var r = await fetch(au('/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fp, content: content })
    });
    if (r.ok) ok++;
  }
  prog.textContent = ok + '/' + files.length + ' enviado(s)';
  await loadTree();
}

async function loadPkgs() {
  var el = document.getElementById('pkg-list');
  el.innerHTML = '<div class="pe">Carregando...</div>';
  try {
    var r = await fetch(au('/package-json'));
    if (!r.ok) {
      el.innerHTML = '<div class="pe">Sem package.json</div>';
      return;
    }
    var pkg = await r.json();
    var deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    var devs = new Set(Object.keys(pkg.devDependencies || {}));
    var keys = Object.keys(deps);
    if (!keys.length) {
      el.innerHTML = '<div class="pe">Sem dependencias</div>';
      return;
    }
    el.innerHTML = keys.map(function(name) {
      var db = devs.has(name) ? '<span style="color:var(--purple);font-size:9px;margin-left:4px">dev</span>' : '';
      return '<div class="pr"><span class="pn">' + hEsc(name) + db + '</span><span class="pv">' + hEsc(deps[name]) + '</span><button class="pd" data-del="' + hEsc(name) + '" title="Desinstalar">✕</button></div>';
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="pe">Erro: ' + hEsc(e.message) + '</div>';
  }
}

async function installPkg(type) {
  var ni = document.getElementById('pkg-in');
  var name = ni.value.trim();
  if (!name) return toast('Digite o nome do pacote', 'err');
  await runNpm(['install', '--save' + (type === 'dev' ? '-dev' : ''), '--no-audit', '--no-fund', name], 'Instalando ' + name + '...');
  ni.value = '';
  await loadPkgs();
}

async function uninstallPkg(name) {
  if (!confirm('Desinstalar ' + name + '?')) return;
  await runNpm(['uninstall', name], 'Removendo ' + name + '...');
  await loadPkgs();
}

async function runNpm(args, label) {
  var term = document.getElementById('pkg-term');
  var out = document.getElementById('pkg-out');
  term.classList.add('on');
  out.textContent = label + '\\n';
  setStatus(label, 'loading');
  try {
    var r = await fetch(au('/npm-run'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: args })
    });
    if (!r.ok) {
      out.textContent += '\\nErro: ' + await r.text();
      setStatus('Erro', 'err');
      return;
    }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    while (true) {
      var x = await reader.read();
      if (x.done) break;
      out.textContent += dec.decode(x.value);
      term.scrollTop = term.scrollHeight;
    }
    out.textContent += '\\nConcluido!';
    term.scrollTop = term.scrollHeight;
    setStatus('Pronto', 'ok');
    toast(label, 'ok');
  } catch (e) {
    out.textContent += '\\nErro: ' + e.message;
    setStatus('Erro', 'err');
    toast('Erro: ' + e.message, 'err');
  }
}

async function doSearch(q) {
  var el = document.getElementById('sr-list');
  try {
    var r = await fetch(au('/search', 'q=' + encodeURIComponent(q)));
    if (!r.ok) {
      el.innerHTML = '<div class="pe">Erro na busca</div>';
      return;
    }
    var res = await r.json();
    if (!res.length) {
      el.innerHTML = '<div class="pe">Nenhum resultado</div>';
      return;
    }
    el.innerHTML = res.slice(0, 50).map(function(it) {
      return '<div class="sr-item" data-sr="' + hEsc(it.file) + '"><div class="sr-f">' + hEsc(it.file) + ':' + it.line + '</div><div class="sr-l">' + hEsc(it.preview) + '</div></div>';
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="pe">Erro: ' + hEsc(e.message) + '</div>';
  }
}

function openFindBar() {
  document.getElementById('findbar').classList.add('on');
  document.getElementById('find-in').focus();
  document.getElementById('find-in').select();
}

function closeFindBar() {
  document.getElementById('findbar').classList.remove('on');
  if (ed) ed.focus();
}

function findNext() {
  if (ed) ed.getAction('editor.action.nextMatchFindAction').run();
}

function findPrev() {
  if (ed) ed.getAction('editor.action.previousMatchFindAction').run();
}

function findReplace() {
  if (ed) ed.getAction('editor.action.startFindReplaceAction').run();
}

function openModal(title, ph, cb) {
  modalCb = cb;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-in').value = '';
  document.getElementById('modal-in').placeholder = ph;
  document.getElementById('modal').classList.add('on');
  setTimeout(function() { document.getElementById('modal-in').focus(); }, 80);
}

function closeModal() {
  document.getElementById('modal').classList.remove('on');
  modalCb = null;
}

function confirmModal() {
  var v = document.getElementById('modal-in').value.trim();
  if (!v) return;
  var cb = modalCb;
  closeModal();
  if (cb) cb(v);
}

function initMonaco() {
  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
  require(['vs/editor/editor.main'], function() {
    monaco.editor.defineTheme('ares', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '4a5568', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'f472b6' },
        { token: 'string', foreground: '86efac' },
        { token: 'number', foreground: 'fb923c' },
        { token: 'type', foreground: '60a5fa' },
        { token: 'function', foreground: 'a78bfa' }
      ],
      colors: {
        'editor.background': '#0a0e17',
        'editor.foreground': '#e2e8f0',
        'editor.lineHighlightBackground': '#111827',
        'editorLineNumber.foreground': '#334155',
        'editorLineNumber.activeForeground': '#94a3b8',
        'editor.selectionBackground': '#1e40af55',
        'editorCursor.foreground': '#22d3a5',
        'editorWidget.background': '#111827',
        'editorWidget.border': '#263046',
        'input.background': '#0a0e17',
        'input.foreground': '#e2e8f0',
        'scrollbarSlider.background': '#26304699'
      }
    });
    ed = monaco.editor.create(document.getElementById('editor-wrap'), {
      theme: 'ares',
      fontSize: isMobile ? 15 : 14,
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontLigatures: !isMobile,
      minimap: { enabled: !isMobile, renderCharacters: false, scale: 1 },
      scrollBeyondLastLine: false,
      wordWrap: isMobile ? 'on' : 'off',
      padding: { top: 10 },
      lineNumbers: isMobile ? 'off' : 'on',
      renderLineHighlight: 'all',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: !isMobile, indentation: !isMobile },
      formatOnPaste: true,
      tabSize: 2,
      scrollbar: {
        verticalScrollbarSize: isMobile ? 2 : 6,
        horizontalScrollbarSize: isMobile ? 2 : 6,
        alwaysConsumeMouseWheel: false
      },
      suggest: { showKeywords: true, showSnippets: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      contextmenu: !isMobile,
      acceptSuggestionOnEnter: 'on',
      folding: !isMobile,
      overviewRulerLanes: isMobile ? 0 : 3,
      hideCursorInOverviewRuler: isMobile,
    });
    ed.onDidChangeCursorPosition(function() { updateInfo(); });
    ed.onDidChangeModelContent(function() { updateInfo(); });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, doSave);
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, openFindBar);
    loadTree();
    setStatus('Pronto', 'ok');
  });
}

document.addEventListener('DOMContentLoaded', function() {
  socket.on('connect', function() { setStatus('Conectado', 'ok'); });
  socket.on('disconnect', function() { setStatus('Desconectado', 'err'); });

  document.addEventListener('click', function(e) {
    if (!document.getElementById('ctx-menu').contains(e.target)) hideCtxMenu();
  });

  document.getElementById('ctx-open').addEventListener('click', function() { if (ctxTarget) openFile(ctxTarget.p); hideCtxMenu(); });
  document.getElementById('ctx-ren').addEventListener('click', function() { if (ctxTarget) { if (ctxTarget.isDir) { var parts=ctxTarget.p.split('/'); var nn=prompt('Novo nome:',parts[parts.length-1]); if(nn&&nn!==parts[parts.length-1]) renFile(ctxTarget.p, parts.slice(0,-1).concat(nn).join('/')); } else qRename(ctxTarget.p); } hideCtxMenu(); });
  document.getElementById('ctx-dup').addEventListener('click', function() { if (ctxTarget) dupFile(ctxTarget.p); hideCtxMenu(); });
  document.getElementById('ctx-dl').addEventListener('click', function() { if (ctxTarget) dlFile(ctxTarget.p); hideCtxMenu(); });
  document.getElementById('ctx-del').addEventListener('click', function() {
    if (!ctxTarget) return;
    var p = ctxTarget.p, isDir = ctxTarget.isDir;
    hideCtxMenu();
    if (!confirm('Excluir "' + p + '"?')) return;
    fetch(au('/delete'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:p}) })
      .then(function(r) { if(r.ok){ toast('Excluído','ok'); if(!isDir&&curFile===p) closeTab(p); loadTree(); } else r.text().then(function(t){toast('Erro: '+t,'err');}); });
  });

  document.getElementById('tree').addEventListener('touchstart', function(e) {
    var row = e.target.closest('.row');
    if (!row) return;
    var p = row.dataset.p;
    var isDir = row.dataset.act === 'dir';
    if (!p) return;
    var touch = e.touches[0];
    longPressTimer = setTimeout(function() {
      longPressTimer = null;
      if (navigator.vibrate) navigator.vibrate(30);
      showCtxMenu(p, isDir, touch.clientX, touch.clientY);
    }, 500);
  }, { passive: true });

  document.getElementById('tree').addEventListener('touchend', function() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { passive: true });

  document.getElementById('tree').addEventListener('touchmove', function() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { passive: true });

  document.getElementById('tree').addEventListener('click', function(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    e.stopPropagation();
    var a = b.dataset.act;
    var p = b.dataset.p;
    if (a === 'dir') toggleDir(p);
    else if (a === 'open') openFile(p);
    else if (a === 'dl') dlFile(p);
    else if (a === 'dup') dupFile(p);
    else if (a === 'qren') qRename(p);
    else if (a === 'nfi') doNewFileIn(p);
    else if (a === 'delf') delFolder(p);
    else if (a === 'del1') {
      if (!confirm('Excluir "' + p + '"?')) return;
      fetch(au('/delete'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })
        .then(function(r) { if (r.ok) { toast('Excluído', 'ok'); if (curFile === p) closeTab(p); loadTree(); } else r.text().then(function(t) { toast('Erro: ' + t, 'err'); }); });
    }
  });

  document.getElementById('tabs-bar').addEventListener('click', function(e) {
    var c = e.target.closest('[data-tc]');
    if (c) {
      e.stopPropagation();
      closeTab(c.dataset.tc);
      return;
    }
    var o = e.target.closest('[data-to]');
    if (o) switchTo(o.dataset.to);
  });

  document.getElementById('pkg-list').addEventListener('click', function(e) {
    var b = e.target.closest('[data-del]');
    if (b) uninstallPkg(b.dataset.del);
  });

  document.getElementById('sr-list').addEventListener('click', function(e) {
    var b = e.target.closest('[data-sr]');
    if (b) openFile(b.dataset.sr);
  });

  document.getElementById('find-in').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.shiftKey ? findPrev() : findNext();
    }
    if (e.key === 'Escape') closeFindBar();
  });

  document.getElementById('modal-in').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') confirmModal();
    if (e.key === 'Escape') closeModal();
  });

  document.getElementById('modal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });

  document.getElementById('modal-upload').addEventListener('click', function(e) {
    if (e.target === this) closeUploadModal();
  });

  document.getElementById('pkg-in').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') installPkg();
  });

  var srT = null;
  document.getElementById('search-in').addEventListener('input', function() {
    clearTimeout(srT);
    var q = this.value.trim();
    var el = document.getElementById('sr-list');
    if (!q) {
      el.innerHTML = '<div class="pe">Digite para buscar...</div>';
      return;
    }
    el.innerHTML = '<div class="pe">Buscando...</div>';
    srT = setTimeout(function() { doSearch(q); }, 300);
  });

  document.getElementById('upload-input').addEventListener('change', function(e) {
    uploadFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  document.getElementById('upl2').addEventListener('change', function(e) {
    uploadFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  document.getElementById('dz').addEventListener('click', function(e) {
    if (e.target === this || e.target.tagName !== 'INPUT') document.getElementById('upl2').click();
  });

  document.getElementById('dz').addEventListener('dragover', function(e) {
    e.preventDefault();
    this.classList.add('over');
  });

  document.getElementById('dz').addEventListener('dragleave', function() {
    this.classList.remove('over');
  });

  document.getElementById('dz').addEventListener('drop', async function(e) {
    e.preventDefault();
    this.classList.remove('over');
    await uploadFiles(Array.from(e.dataTransfer.files));
  });

  initMonaco();
});
</script>
</body>
</html>`;
}

app.use("/files-api", authBot, (req, res, next) => {
  const rawUrl = req.originalUrl.split("?")[0]
  const m = rawUrl.match(/^\/files-api\/([^/]+)(\/[^?/]*)/)
  if (!m) return next()
  const botId = req.botId || m[1]
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
    const body = req.body || {}
    const fp = safe(body.path)
    if (!fp) return res.status(400).send("Caminho inválido. Recebido: " + JSON.stringify(body))
    try {
      const dir = path.dirname(fp)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      }
      fs.writeFileSync(fp, body.content !== undefined ? body.content : "", "utf8")
      saveBotFilesToBucket(botId).catch(() => {})
      return res.send("ok")
    } catch (err) {
      return res.status(500).send("Erro ao escrever: " + err.message)
    }
  }

  if (action === "/delete") {
    const body = req.body || {}
    const fp = safe(body.path)
    if (!fp) return res.status(400).send("Caminho inválido")
    if (!fs.existsSync(fp)) return res.status(404).send("Não encontrado")
    try {
      fs.statSync(fp).isDirectory() ? fs.rmSync(fp, { recursive: true, force: true }) : fs.unlinkSync(fp)
      saveBotFilesToBucket(botId).catch(() => {})
      return res.send("ok")
    } catch (err) { return res.status(500).send("Erro ao deletar: " + err.message) }
  }

  if (action === "/mkdir") {
    const body = req.body || {}
    const dp = safe(body.path)
    if (!dp) return res.status(400).send("Caminho inválido")
    try {
      fs.mkdirSync(dp, { recursive: true, mode: 0o755 })
      saveBotFilesToBucket(botId).catch(() => {})
      return res.send("ok")
    } catch (err) { return res.status(500).send("Erro ao criar pasta: " + err.message) }
  }

  if (action === "/rename") {
    const body = req.body || {}
    const from = safe(body.from)
    const to = safe(body.to)
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
    const body = req.body || {}
    const { args } = body
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

// ─────────────────────────────────────────────
//  MARKETPLACE DE BASES DE BOTS — COMUNIDADE
// ─────────────────────────────────────────────

const MARKET_KEY = "marketplace_bases.json"

async function getMarketData() {
  try {
    const { client, bucketName } = s3Clients[0]
    const res = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: MARKET_KEY }))
    const chunks = []
    for await (const chunk of res.Body) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch { return { bases: [] } }
}

async function saveMarketData(data) {
  try {
    const { client, bucketName } = s3Clients[0]
    await client.send(new PutObjectCommand({
      Bucket: bucketName, Key: MARKET_KEY,
      Body: JSON.stringify(data),
      ContentType: "application/json"
    }))
    return true
  } catch { return false }
}

// Página Web App de ativação
app.get("/activate", (req, res) => {
  const chatId = req.query.chatId || ""
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Ativar conta</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:var(--tg-theme-bg-color,#111318);
  --bg2:var(--tg-theme-secondary-bg-color,#1a1e28);
  --tx:var(--tg-theme-text-color,#dde2ec);
  --t2:var(--tg-theme-hint-color,#6b7a94);
  --accent:var(--tg-theme-button-color,#4d8ef5);
  --accent-tx:var(--tg-theme-button-text-color,#fff);
  --bd:#2a3040;--r:12px
}
html,body{height:100%;background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;-webkit-font-smoothing:antialiased}
.wrap{min-height:100vh;display:flex;flex-direction:column;padding:24px 20px calc(24px + env(safe-area-inset-bottom,0))}
.header{margin-bottom:28px}
.icon{width:56px;height:56px;border-radius:16px;background:rgba(77,142,245,.15);display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.icon svg{color:var(--accent)}
h1{font-size:22px;font-weight:700;color:var(--tx);letter-spacing:-.4px;margin-bottom:6px}
.sub{font-size:14px;color:var(--t2);line-height:1.6}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;font-weight:600;color:var(--t2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
.field input{
  width:100%;background:var(--bg2);border:1.5px solid var(--bd);border-radius:var(--r);
  padding:14px 16px;color:var(--tx);font-size:17px;outline:none;
  font-family:"SF Mono",monospace;letter-spacing:.05em;-webkit-appearance:none;
  transition:border .15s;text-transform:uppercase
}
.field input:focus{border-color:var(--accent)}
.field input::placeholder{color:var(--t2);letter-spacing:0;font-family:-apple-system,sans-serif;text-transform:none;font-size:15px}
.hint{font-size:12px;color:var(--t2);margin-top:6px;line-height:1.5}
.btn{
  width:100%;padding:15px;background:var(--accent);border:none;border-radius:var(--r);
  color:var(--accent-tx);font-size:16px;font-weight:600;cursor:pointer;
  touch-action:manipulation;font-family:inherit;margin-top:4px;transition:opacity .15s
}
.btn:active{opacity:.82}
.btn:disabled{opacity:.45;cursor:not-allowed}
.status{display:none;padding:14px;border-radius:var(--r);font-size:14px;font-weight:500;margin-bottom:16px;text-align:center}
.status.err{background:rgba(240,80,80,.12);border:1px solid rgba(240,80,80,.3);color:#e05050;display:block}
.status.ok{background:rgba(52,209,122,.12);border:1px solid rgba(52,209,122,.3);color:#34d17a;display:block}
.already{text-align:center;padding:40px 0}
.already svg{margin:0 auto 16px;display:block;color:#34d17a}
.already h2{font-size:20px;font-weight:700;margin-bottom:8px}
.already p{font-size:14px;color:var(--t2)}
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <div id="form-view">
    <div class="header">
      <div class="icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h1>Ativar conta</h1>
      <p class="sub">Insira sua chave de ativação para acessar o ARES HOST.</p>
    </div>
    <div id="status" class="status"></div>
    <div class="field">
      <label>Chave de ativação</label>
      <input id="key-input" type="text" placeholder="ARES-XXXX-XXXX" maxlength="20" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="hint">A chave foi enviada pelo administrador. Formato: XXXX-XXXX-XXXX</div>
    </div>
    <button class="btn" id="btn-activate" onclick="activate()">Ativar</button>
  </div>
  <div id="ok-view" style="display:none" class="already">
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/></svg>
    <h2>Conta ativada!</h2>
    <p>Você já pode usar o ARES HOST.</p>
  </div>
</div>
<script>
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.MainButton.hide();
}

var chatId = "${chatId}";

// Check if already activated
fetch('/activate-api/check?chatId=' + chatId)
  .then(function(r){ return r.json(); })
  .then(function(d){
    if (d.activated) showOk();
  }).catch(function(){});

var inp = document.getElementById('key-input');
inp.addEventListener('input', function(){
  // auto-format: insert dashes
  var v = this.value.replace(/[^A-Z0-9]/gi,'').toUpperCase();
  if (v.length > 4 && v[4] !== '-') v = v.slice(0,4)+'-'+v.slice(4);
  if (v.length > 9 && v[9] !== '-') v = v.slice(0,9)+'-'+v.slice(9);
  this.value = v.slice(0,14);
});
inp.addEventListener('keydown', function(e){ if(e.key==='Enter') activate(); });

function showOk() {
  document.getElementById('form-view').style.display = 'none';
  document.getElementById('ok-view').style.display = 'block';
  if (tg) setTimeout(function(){ tg.close(); }, 2000);
}

async function activate() {
  var key = inp.value.trim().toUpperCase();
  if (!key || key.length < 14) {
    setStatus('Chave inválida. Verifique e tente novamente.', 'err');
    return;
  }
  var btn = document.getElementById('btn-activate');
  btn.disabled = true; btn.textContent = 'Verificando...';
  setStatus('', '');
  try {
    var r = await fetch('/activate-api/activate', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: key, chatId: chatId })
    });
    var d = await r.json();
    if (d.ok) {
      showOk();
    } else {
      setStatus(d.error || 'Chave inválida ou já utilizada.', 'err');
      btn.disabled = false; btn.textContent = 'Ativar';
    }
  } catch(e) {
    setStatus('Erro de conexão. Tente novamente.', 'err');
    btn.disabled = false; btn.textContent = 'Ativar';
  }
}

function setStatus(msg, type) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (type ? ' '+type : '');
}
</script>
</body>
</html>`)
})

// API: checar se está ativado
app.get("/activate-api/check", (req, res) => {
  const chatId = req.query.chatId
  if (!chatId) return res.json({ activated: false })
  res.json({ activated: isActivated(chatId) })
})

// API: ativar com chave
app.post("/activate-api/activate", async (req, res) => {
  const { key, chatId } = req.body
  if (!key || !chatId) return res.status(400).json({ error: "Dados inválidos" })
  if (isActivated(chatId)) return res.json({ ok: true, already: true })
  const inputKey = key.trim().toUpperCase()
  const keys = loadActiveKeys()
  if (!keys[inputKey]) return res.json({ ok: false, error: "Chave não encontrada" })
  if (keys[inputKey].usedBy) return res.json({ ok: false, error: "Chave já utilizada" })
  keys[inputKey].usedBy = String(chatId)
  keys[inputKey].usedAt = Date.now()
  saveActiveKeys(keys)
  activateUser(chatId, inputKey, keys[inputKey].daysValid || 30)
  saveAccepted(chatId)
  // Notificar o usuário via bot
  try {
    const s = getStats(chatId)
    bot.sendMessage(chatId,
      `✅ *Conta ativada!*\n\nBem-vindo ao ARES HOST.\n\n🤖 Seus bots: *${s.total}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Novo Bot", callback_data: "menu_new" }],
            [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
          ]
        }
      }
    )
  } catch (e) {}
  res.json({ ok: true })
})


/* MARKETPLACE DESATIVADO
app.get("/marketplace", (req, res) => {
  res.status(503).send("<html><head><meta charset=UTF-8><title>ARES</title><style>body{background:#0f1117;color:#6b7a94;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><div style=font-size:20px;font-weight:700;color:#dde2ec;margin-bottom:8px>Marketplace</div><div>Em breve</div></div></body></html>")
})

// API: upload de zip para marketplace
app.post("/marketplace-api/upload-zip", multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".zip")) return cb(new Error("Apenas .zip"))
    cb(null, true)
  }
}).single("file"), async (req, res) => {
  const tok = req.query.s
  const chatId = checkSession({ query: { s: tok } })
  if (!chatId) return res.status(401).json({ error: "Não autenticado" })
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo" })
  try {
    const key = `market_zips/${Date.now()}_${Math.floor(Math.random()*9999)}.zip`
    const { client, bucketName } = s3Clients[0]
    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: req.file.buffer,
      ContentType: "application/zip",
      ContentDisposition: `attachment; filename="${req.file.originalname}"`
    }))
    // Build public URL
    const endpoint = s3Clients[0].endpoint.replace(/\/$/, "")
    const url = `${endpoint}/${bucketName}/${key}`
    res.json({ ok: true, url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* === MARKETPLACE DESATIVADO ===
// API: verificar se é dono + se curtiu
app.get("/marketplace-api/check-owner/:id", async (req, res) => {
  const tok = req.query.s
  const chatId = checkSession({ query: { s: tok } })
  if (!chatId) return res.json({ isOwner: false, liked: false })
  const data = await getMarketData()
  const base = data.bases.find(b => b.id === req.params.id)
  if (!base) return res.json({ isOwner: false, liked: false })
  const isOwner = base.authorId === String(chatId) || String(chatId) === String(OWNER_ID)
  const liked = Array.isArray(base.likes) && base.likes.includes(String(chatId))
  res.json({ isOwner, liked })
})

// API: listar bases
app.get("/marketplace-api/list", async (req, res) => {
  const data = await getMarketData()
  res.json(data.bases || [])
})

// API: publicar base (requer sessão)
app.post("/marketplace-api/publish", async (req, res) => {
  const tok = req.query.s
  const chatId = checkSession({ query: { s: tok } })
  if (!chatId) return res.status(401).json({ error: "Não autenticado" })

  const { name, description, category, tags, zipUrl, preview, author } = req.body
  if (!name || !description || !zipUrl) return res.status(400).json({ error: "Campos obrigatórios: name, description, zipUrl" })

  const data = await getMarketData()
  const id = "base_" + Date.now() + "_" + Math.floor(Math.random() * 9999)
  const base = {
    id, name, description, category: category || "geral",
    tags: Array.isArray(tags) ? tags.slice(0, 5) : [],
    zipUrl, preview: preview || "",
    author: author || "Anônimo",
    authorId: chatId,
    createdAt: Date.now(),
    downloads: 0,
    likes: [],
    approved: true
  }
  data.bases.unshift(base)
  if (data.bases.length > 200) data.bases = data.bases.slice(0, 200)
  await saveMarketData(data)
  res.json({ ok: true, id })
})

// API: curtir base
app.post("/marketplace-api/like/:id", async (req, res) => {
  const tok = req.query.s
  const chatId = checkSession({ query: { s: tok } })
  if (!chatId) return res.status(401).json({ error: "Não autenticado" })

  const data = await getMarketData()
  const base = data.bases.find(b => b.id === req.params.id)
  if (!base) return res.status(404).json({ error: "Base não encontrada" })
  if (!Array.isArray(base.likes)) base.likes = []
  const idx = base.likes.indexOf(String(chatId))
  if (idx > -1) base.likes.splice(idx, 1)
  else base.likes.push(String(chatId))
  await saveMarketData(data)
  res.json({ ok: true, likes: base.likes.length, liked: idx === -1 })
})

// API: incrementar download
app.post("/marketplace-api/download/:id", async (req, res) => {
  const data = await getMarketData()
  const base = data.bases.find(b => b.id === req.params.id)
  if (base) { base.downloads = (base.downloads || 0) + 1; await saveMarketData(data) }
  res.json({ ok: true })
})

// API: deletar (só o dono ou OWNER_ID)
app.delete("/marketplace-api/delete/:id", async (req, res) => {
  const tok = req.query.s
  const chatId = checkSession({ query: { s: tok } })
  if (!chatId) return res.status(401).json({ error: "Não autenticado" })
  const data = await getMarketData()
  const idx = data.bases.findIndex(b => b.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: "Não encontrada" })
  const base = data.bases[idx]
  if (base.authorId !== chatId && String(chatId) !== String(OWNER_ID)) return res.status(403).json({ error: "Sem permissão" })
  data.bases.splice(idx, 1)
  await saveMarketData(data)
  res.json({ ok: true })
})

// Callback do Telegram para abrir marketplace
/* bot.onText(/^\/marketplace$/, msg => {
  const chatId = msg.chat.id
  const sessionToken = genWebSession(chatId)
  const url = `${DOMAIN}/marketplace?s=${sessionToken}`
  bot.sendMessage(chatId,
    `🛒 *Marketplace de Bases*\n\nExplore e compartilhe bases de bots de WhatsApp da comunidade ARES!\n\n✅ Gratuito\n📦 Instale direto no seu bot\n🤝 Contribua com a comunidade`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🛒 Abrir Marketplace", url }]] }
    }
  )
})
*/
function buildMarketplaceHtml(sessionToken) {
  const T = JSON.stringify(sessionToken || "")
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0f1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Marketplace — ARES</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{min-height:100%;background:#0f1117;color:#dde2ec;font-family:Inter,sans-serif;font-size:14px;-webkit-font-smoothing:antialiased;overflow-x:hidden}

/* NAV */
nav{position:sticky;top:0;z-index:40;background:rgba(15,17,23,.93);backdrop-filter:blur(12px);border-bottom:1px solid #1e2430;display:flex;align-items:center;height:52px;padding:0 16px;gap:10px;padding-top:env(safe-area-inset-top,0)}
.logo{font-size:14px;font-weight:700;color:#dde2ec;letter-spacing:-.3px;text-decoration:none;display:flex;align-items:center;gap:7px;flex-shrink:0}
.logo-dot{width:6px;height:6px;border-radius:50%;background:#4d8ef5}
.sp{flex:1}
#sinput{background:#181c27;border:1px solid #1e2430;border-radius:8px;padding:7px 12px;color:#dde2ec;font-size:13px;outline:none;width:180px;font-family:Inter,sans-serif;-webkit-appearance:none}
#sinput:focus{border-color:#4d8ef5}
#btn-pub{padding:7px 14px;background:#4d8ef5;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;font-family:Inter,sans-serif;touch-action:manipulation}
#btn-pub:active{opacity:.82}

/* NOTICE */
#notice{background:#1a2035;border-bottom:1px solid #263050;padding:9px 16px;font-size:13px;color:#7a9ad4;display:none}
#notice.on{display:block}

/* PAGE */
.wrap{max-width:720px;margin:0 auto;padding:24px 16px 80px}

/* HEADER */
.ph{margin-bottom:28px}
.ph-label{font-size:11px;font-weight:600;color:#4d8ef5;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.ph-title{font-size:24px;font-weight:700;color:#dde2ec;letter-spacing:-.4px;line-height:1.2;margin-bottom:8px}
.ph-sub{font-size:14px;color:#6b7a94;line-height:1.6;margin-bottom:18px}
.ph-stats{display:flex;gap:20px}
.phs{display:flex;flex-direction:column;gap:1px}
.phs-n{font-size:18px;font-weight:700;color:#dde2ec;letter-spacing:-.3px}
.phs-l{font-size:11px;color:#44526a;font-weight:500;text-transform:uppercase;letter-spacing:.05em}

/* FILTERS */
.fbar{display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:16px;border-bottom:1px solid #1e2430;margin-bottom:0}
.fbar::-webkit-scrollbar{display:none}
.fc{padding:5px 12px;border-radius:99px;border:1px solid #1e2430;background:none;color:#6b7a94;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;touch-action:manipulation;flex-shrink:0;font-family:Inter,sans-serif}
.fc.on{background:rgba(77,142,245,.12);border-color:#4d8ef5;color:#4d8ef5;font-weight:600}
.fbar-sep{width:1px;height:16px;background:#1e2430;flex-shrink:0;margin:0 2px}
.fsort{padding:5px 12px;border-radius:99px;border:1px solid transparent;background:none;color:#44526a;font-size:12px;cursor:pointer;white-space:nowrap;touch-action:manipulation;flex-shrink:0;font-family:Inter,sans-serif}
.fsort.on{color:#6b7a94;border-color:#1e2430}
.fcount{margin-left:auto;font-size:12px;color:#44526a;flex-shrink:0;padding-left:8px;white-space:nowrap}
.fcount b{color:#6b7a94;font-weight:600}

/* LIST */
#loading{padding:48px;text-align:center;color:#44526a;font-size:13px}
#empty{display:none;padding:48px;text-align:center;color:#44526a}
#empty strong{display:block;color:#6b7a94;font-size:14px;margin-bottom:6px}
#list{display:flex;flex-direction:column}

/* ITEM */
.item{display:flex;align-items:flex-start;gap:13px;padding:16px 0;border-bottom:1px solid #1a1f2b;cursor:pointer;touch-action:manipulation}
.item:first-child{border-top:1px solid #1a1f2b}
.item:active{opacity:.75}
.item-ico{width:40px;height:40px;border-radius:9px;background:#181c27;border:1px solid #1e2430;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#6b7a94;flex-shrink:0;letter-spacing:-.5px}
.item-body{flex:1;min-width:0}
.item-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:3px}
.item-name{font-size:14px;font-weight:600;color:#dde2ec;letter-spacing:-.1px;line-height:1.3}
.item-cat{font-size:10px;font-weight:600;color:#44526a;text-transform:uppercase;letter-spacing:.04em;background:#181c27;border:1px solid #1e2430;border-radius:4px;padding:1px 6px;white-space:nowrap;flex-shrink:0}
.item-desc{font-size:13px;color:#6b7a94;line-height:1.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px}
.item-foot{display:flex;align-items:center;gap:10px}
.item-by{font-size:11px;color:#44526a}
.item-stats{display:flex;gap:8px;margin-left:auto}
.istat{font-size:11px;color:#44526a}

/* MODAL OVERLAY */
.ov{display:none;position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.7);backdrop-filter:blur(5px);align-items:flex-end;justify-content:center}
.ov.on{display:flex}
@media(min-width:600px){.ov{align-items:center}}

/* SHEET */
.sh{background:#161921;border:1px solid #1e2430;border-radius:16px 16px 0 0;width:100%;max-width:500px;max-height:92vh;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom,0)}
@media(min-width:600px){.sh{border-radius:12px;max-height:85vh;padding-bottom:0}}
.sh-pip{width:28px;height:3px;background:#2a3040;border-radius:2px;margin:10px auto 0;flex-shrink:0}
.sh-top{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid #1e2430;flex-shrink:0;position:sticky;top:0;background:#161921;z-index:2}
.sh-top h2{font-size:15px;font-weight:700;color:#dde2ec;letter-spacing:-.2px}
.sh-x{background:none;border:none;color:#44526a;cursor:pointer;padding:4px;border-radius:6px;display:flex;align-items:center;touch-action:manipulation;font-family:Inter,sans-serif}
.sh-x:active{background:#1e2430;color:#dde2ec}
.sh-body{padding:18px;display:flex;flex-direction:column;gap:14px}
.sh-foot{padding:12px 18px;border-top:1px solid #1e2430;display:flex;gap:8px;flex-shrink:0}

/* FIELDS */
.fl{display:flex;flex-direction:column;gap:5px}
.fl label{font-size:12px;font-weight:600;color:#8a95a8}
.fl input,.fl textarea,.fl select{background:#181c27;border:1px solid #1e2430;color:#dde2ec;border-radius:8px;padding:10px 12px;font-size:15px;outline:none;-webkit-appearance:none;width:100%;font-family:Inter,sans-serif;transition:border .12s}
.fl input:focus,.fl textarea:focus,.fl select:focus{border-color:#4d8ef5;background:#1a1f2c}
.fl textarea{resize:vertical;min-height:72px;line-height:1.55}
.fl select option{background:#181c27}
.fl-hint{font-size:11px;color:#44526a;line-height:1.5}
.fl-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.or-line{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;color:#44526a;text-transform:uppercase;letter-spacing:.07em}
.or-line::before,.or-line::after{content:"";flex:1;height:1px;background:#1e2430}

/* UPLOAD */
.upz{border:1.5px dashed #1e2430;border-radius:8px;padding:18px;text-align:center;cursor:pointer;position:relative;touch-action:manipulation;transition:all .12s}
.upz:hover,.upz.over{border-color:#4d8ef5;background:rgba(77,142,245,.06)}
.upz input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
.upz-t{font-size:13px;font-weight:600;color:#8a95a8;margin-bottom:3px}
.upz-s{font-size:12px;color:#44526a}
.up-prog{height:2px;background:#1e2430;border-radius:2px;overflow:hidden;margin-top:10px;display:none}
.up-prog.on{display:block}
.up-bar{height:100%;background:#4d8ef5;width:0%;transition:width .15s;border-radius:2px}
.up-st{font-size:11px;margin-top:5px;color:#44526a}

/* BUTTONS */
.btn{padding:11px 16px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:none;font-family:Inter,sans-serif;touch-action:manipulation}
.btn:active{opacity:.82}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.p{background:#4d8ef5;color:#fff;flex:1}
.btn.g{background:none;border:1px solid #1e2430;color:#8a95a8}
.btn.d{background:rgba(240,80,80,.08);border:1px solid rgba(240,80,80,.25);color:#e05050}
.btn-lk{padding:10px 13px;background:none;border:1px solid #1e2430;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:5px;font-size:13px;font-weight:600;color:#6b7a94;font-family:Inter,sans-serif;touch-action:manipulation}
.btn-lk.on{background:rgba(240,80,80,.08);border-color:rgba(240,80,80,.3);color:#e05050}
.btn-lk:active{opacity:.8}

/* DETAIL */
.dt-head{padding:18px;border-bottom:1px solid #1e2430;flex-shrink:0}
.dt-row{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.dt-ico{width:44px;height:44px;border-radius:9px;background:#181c27;border:1px solid #1e2430;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#6b7a94;flex-shrink:0;letter-spacing:-.5px}
.dt-name{font-size:17px;font-weight:700;color:#dde2ec;letter-spacing:-.3px;margin-bottom:4px}
.dt-meta{font-size:12px;color:#44526a;display:flex;flex-wrap:wrap;gap:8px}
.dt-stats{display:flex;border:1px solid #1e2430;border-radius:8px;overflow:hidden}
.dst{flex:1;padding:10px 8px;text-align:center;border-right:1px solid #1e2430}
.dst:last-child{border-right:none}
.dst-n{font-size:15px;font-weight:700;color:#dde2ec;letter-spacing:-.2px}
.dst-l{font-size:10px;color:#44526a;text-transform:uppercase;letter-spacing:.05em;margin-top:1px}
.dt-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
.dt-dl{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:11px 14px;background:#4d8ef5;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;font-family:Inter,sans-serif;touch-action:manipulation}
.dt-dl:active{opacity:.82}

/* INSTALL */
.inst{background:#181c27;border:1px solid #1e2430;border-radius:8px;overflow:hidden;margin-top:4px}
.inst-h{padding:9px 14px;font-size:11px;font-weight:700;color:#44526a;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid #1e2430}
.ist{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid #1e2430;font-size:13px;color:#6b7a94;line-height:1.55}
.ist:last-child{border-bottom:none}
.ist-n{width:18px;height:18px;border-radius:50%;background:rgba(77,142,245,.1);border:1px solid rgba(77,142,245,.25);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#4d8ef5;flex-shrink:0;margin-top:2px}

/* TOAST */
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%) translateY(8px);background:#161921;border:1px solid #2a3040;padding:9px 16px;border-radius:9px;font-size:13px;font-weight:500;z-index:9999;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:90vw;color:#dde2ec}
.toast.on{opacity:1;transform:translateX(-50%)}
.toast.ok{border-color:#3ab96a;color:#3ab96a}
.toast.err{border-color:#e05050;color:#e05050}

@media(max-width:480px){
  #sinput{width:120px}
  .fl-row{grid-template-columns:1fr}
  .ph-stats{gap:16px}
}
</style>
</head>
<body>

<nav>
  <a href="/marketplace" class="logo"><div class="logo-dot"></div>ARES Marketplace</a>
  <div class="sp"></div>
  <input id="sinput" type="search" placeholder="Buscar..." autocomplete="off" spellcheck="false">
  <button id="btn-pub" onclick="openPub()">Publicar</button>
</nav>

<div id="notice">Abra pelo link do Telegram para curtir e publicar bases.</div>

<div class="wrap">
  <div class="ph">
    <div class="ph-label">Comunidade</div>
    <h1 class="ph-title">Bases de bots de WhatsApp</h1>
    <p class="ph-sub">Bases prontas criadas pela comunidade. Instale com um clique no ARES HOST.</p>
    <div class="ph-stats">
      <div class="phs"><div class="phs-n" id="st-t">—</div><div class="phs-l">Bases</div></div>
      <div class="phs"><div class="phs-n" id="st-d">—</div><div class="phs-l">Downloads</div></div>
      <div class="phs"><div class="phs-n" id="st-a">—</div><div class="phs-l">Autores</div></div>
    </div>
  </div>

  <div class="fbar">
    <button class="fc on" data-cat="all">Todos</button>
    <button class="fc" data-cat="atendimento">Atendimento</button>
    <button class="fc" data-cat="vendas">Vendas</button>
    <button class="fc" data-cat="delivery">Delivery</button>
    <button class="fc" data-cat="agendamento">Agendamento</button>
    <button class="fc" data-cat="suporte">Suporte</button>
    <button class="fc" data-cat="financeiro">Financeiro</button>
    <button class="fc" data-cat="geral">Geral</button>
    <div class="fbar-sep"></div>
    <button class="fsort on" data-sort="new">Recente</button>
    <button class="fsort" data-sort="likes">Curtidas</button>
    <button class="fsort" data-sort="dl">Downloads</button>
    <span class="fcount"><b id="cnt">0</b> bases</span>
  </div>

  <div id="loading">Carregando...</div>
  <div id="empty"><strong>Nenhuma base encontrada</strong>Tente outro filtro.</div>
  <div id="list"></div>
</div>

<!-- Publish modal -->
<div class="ov" id="pub-ov">
  <div class="sh">
    <div class="sh-pip"></div>
    <div class="sh-top">
      <h2>Publicar base</h2>
      <button class="sh-x" onclick="closePub()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="sh-body">
      <div class="fl"><label>Nome</label><input id="p-name" type="text" placeholder="Ex: Bot de vendas com cardápio" maxlength="60" autocorrect="off"></div>
      <div class="fl"><label>Descrição</label><textarea id="p-desc" placeholder="O que o bot faz? Quais funcionalidades tem?" maxlength="400"></textarea></div>
      <div class="fl-row">
        <div class="fl"><label>Categoria</label>
          <select id="p-cat">
            <option value="geral">Geral</option>
            <option value="atendimento">Atendimento</option>
            <option value="vendas">Vendas</option>
            <option value="delivery">Delivery</option>
            <option value="agendamento">Agendamento</option>
            <option value="suporte">Suporte</option>
            <option value="financeiro">Financeiro</option>
          </select>
        </div>
        <div class="fl"><label>Seu nome</label><input id="p-author" type="text" placeholder="Apelido" maxlength="30" autocorrect="off" autocapitalize="off"></div>
      </div>
      <div class="fl">
        <label>Arquivo .zip</label>
        <div class="upz" id="upz">
          <input type="file" id="p-file" accept=".zip">
          <div class="upz-t" id="upz-t">Selecionar .zip</div>
          <div class="upz-s" id="upz-s">Clique ou arraste aqui</div>
          <div class="up-prog" id="up-prog"><div class="up-bar" id="up-bar"></div></div>
          <div class="up-st" id="up-st"></div>
        </div>
        <div class="or-line">ou</div>
        <input id="p-link" type="url" placeholder="Link público do .zip (GitHub, Drive...)" autocorrect="off" autocapitalize="off">
        <span class="fl-hint">Envie o arquivo diretamente ou cole um link público</span>
      </div>
      <div class="fl"><label>Tags (vírgula)</label><input id="p-tags" type="text" placeholder="nodejs, menu, pagamento..." maxlength="100" autocorrect="off"></div>
    </div>
    <div class="sh-foot">
      <button class="btn g" onclick="closePub()">Cancelar</button>
      <button class="btn p" id="p-btn" onclick="submitPub()">Publicar</button>
    </div>
  </div>
</div>

<!-- Detail modal -->
<div class="ov" id="det-ov">
  <div class="sh">
    <div class="sh-pip"></div>
    <div class="sh-top">
      <h2 id="d-title-head">Detalhes</h2>
      <button class="sh-x" onclick="closeDet()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="dt-head">
      <div class="dt-row">
        <div class="dt-ico" id="d-ico">—</div>
        <div>
          <div class="dt-name" id="d-name"></div>
          <div class="dt-meta" id="d-meta"></div>
        </div>
      </div>
      <div class="dt-stats">
        <div class="dst"><div class="dst-n" id="d-lk">0</div><div class="dst-l">Curtidas</div></div>
        <div class="dst"><div class="dst-n" id="d-dl">0</div><div class="dst-l">Downloads</div></div>
        <div class="dst"><div class="dst-n" id="d-age">—</div><div class="dst-l">Dias</div></div>
      </div>
      <div class="dt-actions">
        <a class="dt-dl" id="d-zip" href="#" target="_blank" rel="noopener" onclick="trackDl()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Baixar .zip
        </a>
        <button class="btn-lk" id="d-lkbtn" onclick="toggleLike()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span id="d-lk2">0</span>
        </button>
        <button class="btn d" id="d-del" style="display:none;padding:10px 12px" onclick="deleteCur()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
    <div class="sh-body">
      <p id="d-desc" style="font-size:14px;color:#6b7a94;line-height:1.7"></p>
      <div id="d-tags" style="display:flex;flex-wrap:wrap;gap:5px"></div>
      <div class="inst">
        <div class="inst-h">Como instalar</div>
        <div class="ist"><div class="ist-n">1</div><span>Clique em <b>Baixar .zip</b> e copie o link</span></div>
        <div class="ist"><div class="ist-n">2</div><span>No Telegram, vá em <b>Novo Bot</b> e cole o link</span></div>
        <div class="ist"><div class="ist-n">3</div><span>Dê um nome — o ARES instala e inicia automaticamente</span></div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var TOK = ${T};
var bases = [], cat = 'all', srt = 'new', q = '', cur = null, uploadedUrl = null;

if (!TOK) document.getElementById('notice').classList.add('on');

function toast(m, t) {
  var el = document.getElementById('toast');
  el.textContent = m;
  el.className = 'toast on' + (t ? ' '+t : '');
  clearTimeout(el._t);
  el._t = setTimeout(function(){ el.className = 'toast'; }, 3000);
}
function xe(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fn(n){ n=n||0; return n>=1000?(n/1000).toFixed(1)+'k':String(n); }
function days(ts){ return Math.max(0,Math.floor((Date.now()-ts)/86400000)); }
function ini(n){ return (n||'?').slice(0,2).toUpperCase(); }
function catN(c){ return {atendimento:'Atendimento',vendas:'Vendas',delivery:'Delivery',agendamento:'Agendamento',suporte:'Suporte',financeiro:'Financeiro',geral:'Geral'}[c]||'Geral'; }
function fmtD(ts){ return new Date(ts).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'}); }

function mkItem(b) {
  var el = document.createElement('div');
  el.className = 'item';
  el.addEventListener('click', function(){ openDet(b.id); });
  el.innerHTML =
    '<div class="item-ico">'+xe(ini(b.name))+'</div>'+
    '<div class="item-body">'+
      '<div class="item-top">'+
        '<div class="item-name">'+xe(b.name)+'</div>'+
        '<span class="item-cat">'+xe(catN(b.category))+'</span>'+
      '</div>'+
      '<div class="item-desc">'+xe(b.description)+'</div>'+
      '<div class="item-foot">'+
        '<span class="item-by">por '+xe(b.author||'Anônimo')+'</span>'+
        '<div class="item-stats">'+
          '<span class="istat">'+fn((b.likes||[]).length)+' curtidas</span>'+
          '<span class="istat">'+fn(b.downloads||0)+' dl</span>'+
          '<span class="istat">'+days(b.createdAt)+'d</span>'+
        '</div>'+
      '</div>'+
    '</div>';
  return el;
}

function filtered() {
  var l = bases.slice();
  if (cat !== 'all') l = l.filter(function(b){ return b.category===cat; });
  if (q) { var qq=q.toLowerCase(); l=l.filter(function(b){ return (b.name+' '+b.description+' '+b.author+' '+(b.tags||[]).join(' ')).toLowerCase().includes(qq); }); }
  if (srt==='likes') l.sort(function(a,b){ return (b.likes||[]).length-(a.likes||[]).length; });
  else if (srt==='dl') l.sort(function(a,b){ return (b.downloads||0)-(a.downloads||0); });
  else l.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
  return l;
}

function render() {
  var l = filtered();
  document.getElementById('cnt').textContent = l.length;
  var list = document.getElementById('list');
  var empty = document.getElementById('empty');
  list.innerHTML = '';
  if (!l.length) { empty.style.display='block'; return; }
  empty.style.display = 'none';
  var f = document.createDocumentFragment();
  l.forEach(function(b){ f.appendChild(mkItem(b)); });
  list.appendChild(f);
}

function updStats() {
  document.getElementById('st-t').textContent = fn(bases.length);
  document.getElementById('st-d').textContent = fn(bases.reduce(function(s,b){ return s+(b.downloads||0); }, 0));
  document.getElementById('st-a').textContent = fn(new Set(bases.map(function(b){ return b.authorId; })).size);
}

async function load() {
  try {
    var r = await fetch('/marketplace-api/list');
    bases = await r.json();
    document.getElementById('loading').style.display = 'none';
    updStats(); render();
  } catch(e) { document.getElementById('loading').textContent = 'Erro ao carregar.'; }
}

// PUBLISH
function openPub() {
  if (!TOK) { toast('Abra pelo Telegram para publicar', 'err'); return; }
  uploadedUrl = null;
  document.getElementById('upz-t').textContent = 'Selecionar .zip';
  document.getElementById('upz-s').textContent = 'Clique ou arraste aqui';
  document.getElementById('up-st').textContent = '';
  document.getElementById('up-prog').classList.remove('on');
  document.getElementById('up-bar').style.width = '0%';
  document.getElementById('p-file').value = '';
  document.getElementById('pub-ov').classList.add('on');
}
function closePub() { document.getElementById('pub-ov').classList.remove('on'); }

var upzEl = document.getElementById('upz');
var fEl = document.getElementById('p-file');
upzEl.addEventListener('dragover', function(e){ e.preventDefault(); upzEl.classList.add('over'); });
upzEl.addEventListener('dragleave', function(){ upzEl.classList.remove('over'); });
upzEl.addEventListener('drop', function(e){ e.preventDefault(); upzEl.classList.remove('over'); var f=e.dataTransfer.files[0]; if(f) handleF(f); });
fEl.addEventListener('change', function(){ if(fEl.files[0]) handleF(fEl.files[0]); });

function handleF(file) {
  if (!file.name.toLowerCase().endsWith('.zip')) { toast('Apenas .zip', 'err'); return; }
  document.getElementById('upz-t').textContent = file.name;
  document.getElementById('upz-s').textContent = (file.size/1024/1024).toFixed(1)+' MB';
  doUp(file);
}

function doUp(file) {
  var prog=document.getElementById('up-prog'), bar=document.getElementById('up-bar'), st=document.getElementById('up-st');
  prog.classList.add('on'); bar.style.width='0%'; st.textContent='Enviando...'; st.style.color='#44526a';
  var fd=new FormData(); fd.append('file', file);
  var xhr=new XMLHttpRequest();
  xhr.open('POST', '/marketplace-api/upload-zip?s='+TOK);
  xhr.upload.onprogress=function(e){ if(e.lengthComputable) bar.style.width=Math.round(e.loaded/e.total*100)+'%'; };
  xhr.onload=function(){
    if(xhr.status===200){ var d=JSON.parse(xhr.responseText); uploadedUrl=d.url; bar.style.width='100%'; st.textContent='Pronto'; st.style.color='#3ab96a'; }
    else { st.textContent='Erro no upload'; st.style.color='#e05050'; }
  };
  xhr.onerror=function(){ st.textContent='Erro de conexão'; st.style.color='#e05050'; };
  xhr.send(fd);
}

async function submitPub() {
  var name=document.getElementById('p-name').value.trim();
  var desc=document.getElementById('p-desc').value.trim();
  var link=document.getElementById('p-link').value.trim();
  var zipUrl=uploadedUrl||link;
  var pcat=document.getElementById('p-cat').value;
  var author=document.getElementById('p-author').value.trim()||'Anônimo';
  var tags=document.getElementById('p-tags').value.trim().split(',').map(function(t){return t.trim();}).filter(Boolean).slice(0,5);
  if (!name){toast('Informe o nome','err');return;}
  if (!desc){toast('Informe a descrição','err');return;}
  if (!zipUrl){toast('Envie o .zip ou cole o link','err');return;}
  if (link&&!link.startsWith('http')){toast('Link inválido','err');return;}
  var btn=document.getElementById('p-btn');
  btn.textContent='Publicando...'; btn.disabled=true;
  try {
    var r=await fetch('/marketplace-api/publish?s='+TOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,description:desc,category:pcat,tags:tags,zipUrl:zipUrl,author:author})});
    var d=await r.json();
    if(d.ok){ toast('Publicado!','ok'); closePub(); ['p-name','p-desc','p-link','p-tags'].forEach(function(id){document.getElementById(id).value='';}); uploadedUrl=null; await load(); }
    else toast(d.error||'Erro','err');
  } catch(e){ toast('Erro','err'); }
  btn.textContent='Publicar'; btn.disabled=false;
}

// DETAIL
function openDet(id) {
  var b=bases.find(function(x){return x.id===id;}); if(!b) return;
  cur=b;
  document.getElementById('d-title-head').textContent = b.name;
  document.getElementById('d-ico').textContent = ini(b.name);
  document.getElementById('d-name').textContent = b.name;
  document.getElementById('d-meta').innerHTML = '<span>'+xe(b.author||'Anônimo')+'</span><span>'+fmtD(b.createdAt)+'</span><span>'+xe(catN(b.category))+'</span>';
  document.getElementById('d-lk').textContent = (b.likes||[]).length;
  document.getElementById('d-dl').textContent = b.downloads||0;
  document.getElementById('d-age').textContent = days(b.createdAt);
  document.getElementById('d-desc').textContent = b.description;
  document.getElementById('d-zip').href = b.zipUrl;
  document.getElementById('d-lk2').textContent = (b.likes||[]).length;
  document.getElementById('d-lkbtn').className = 'btn-lk';
  document.getElementById('d-del').style.display = 'none';
  document.getElementById('d-tags').innerHTML = (b.tags||[]).map(function(t){return '<span class="tag">'+xe(t)+'</span>';}).join('');
  document.getElementById('det-ov').classList.add('on');
  if (TOK) checkOwn(b);
}
function closeDet() { document.getElementById('det-ov').classList.remove('on'); cur=null; }

async function checkOwn(b) {
  try {
    var r=await fetch('/marketplace-api/check-owner/'+b.id+'?s='+TOK);
    var d=await r.json();
    if(d.isOwner) document.getElementById('d-del').style.display='flex';
    if(d.liked) document.getElementById('d-lkbtn').classList.add('on');
  } catch(e){}
}

function trackDl() {
  if(!cur) return;
  fetch('/marketplace-api/download/'+cur.id,{method:'POST'}).then(function(){
    cur.downloads=(cur.downloads||0)+1;
    document.getElementById('d-dl').textContent=cur.downloads;
    var b=bases.find(function(x){return x.id===cur.id;}); if(b) b.downloads=cur.downloads;
  });
}

async function toggleLike() {
  if(!TOK){toast('Abra pelo Telegram para curtir','err');return;}
  if(!cur) return;
  try {
    var r=await fetch('/marketplace-api/like/'+cur.id+'?s='+TOK,{method:'POST'});
    var d=await r.json();
    if(d.ok){
      document.getElementById('d-lk').textContent=d.likes;
      document.getElementById('d-lk2').textContent=d.likes;
      document.getElementById('d-lkbtn').className='btn-lk'+(d.liked?' on':'');
      var b=bases.find(function(x){return x.id===cur.id;}); if(b) b.likes=Array(d.likes).fill('x');
      render();
    }
  } catch(e){toast('Erro','err');}
}

async function deleteCur() {
  if(!cur||!confirm('Excluir "'+cur.name+'"?')) return;
  try {
    var r=await fetch('/marketplace-api/delete/'+cur.id+'?s='+TOK,{method:'DELETE'});
    var d=await r.json();
    if(d.ok){ toast('Excluído','ok'); bases=bases.filter(function(b){return b.id!==cur.id;}); closeDet(); updStats(); render(); }
    else toast(d.error||'Sem permissão','err');
  } catch(e){toast('Erro','err');}
}

// EVENTS
document.querySelectorAll('.fc').forEach(function(b){ b.addEventListener('click',function(){ document.querySelectorAll('.fc').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); cat=b.dataset.cat; render(); }); });
document.querySelectorAll('.fsort').forEach(function(b){ b.addEventListener('click',function(){ document.querySelectorAll('.fsort').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); srt=b.dataset.sort; render(); }); });
var sT; document.getElementById('sinput').addEventListener('input',function(){ clearTimeout(sT); var v=this.value.trim(); sT=setTimeout(function(){q=v;render();},250); });
document.getElementById('pub-ov').addEventListener('click',function(e){if(e.target===this)closePub();});
document.getElementById('det-ov').addEventListener('click',function(e){if(e.target===this)closeDet();});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closePub();closeDet();}});

load();
</script>
</body>
</html>`
}




function getDiskPercent() {

try {
  const df = execSync("df / | tail -1").toString()
  const parts = df.split(/\s+/)
  return parseInt(parts[4].replace("%", ""))
  } catch { return 0 }
}

function cleanupOldLogs() {
  console.log("🧹 Iniciando limpeza de logs...")
  if (!fs.existsSync(BASE_PATH)) return
  const bots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads" && f !== "_users")
  const now = Date.now()
  const diskPct = getDiskPercent()
  const MAX_AGE = diskPct >= 85 ? 1 * 60 * 60 * 1000 : diskPct >= 75 ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  let logsRemovidos = 0
  let espacoLiberado = 0
  let nmRemovidos = 0
  for (const botId of bots) {
    const logPath = path.join(BASE_PATH, botId, "terminal.log")
    if (fs.existsSync(logPath)) {
      try {
        const stats = fs.statSync(logPath)
        const idade = now - stats.mtimeMs
        if (idade > MAX_AGE || stats.size > 500 * 1024) {
          espacoLiberado += stats.size / 1024
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
    const nmPath = path.join(BASE_PATH, botId, "node_modules")
    if (fs.existsSync(nmPath) && !activeBots[botId]) {
      try {
        const nmSize = execSync(`du -sk "${nmPath}" 2>/dev/null || echo "0"`).toString().split("\t")[0]
        espacoLiberado += parseInt(nmSize) || 0
        fs.rmSync(nmPath, { recursive: true, force: true })
        nmRemovidos++
      } catch {}
    }
  }
  console.log(`✅ Limpeza: ${logsRemovidos} logs, ${nmRemovidos} node_modules, ${(espacoLiberado/1024).toFixed(1)} MB liberados`)
}

function checkDiskAlert() {
  const pct = getDiskPercent()
  const alertId = OWNER_ID || ADMIN_ID
  if (!alertId) return
  if (pct >= 90) {
    bot.sendMessage(alertId,
      `🚨 *DISCO CRÍTICO: ${pct}%*\n\nO servidor está quase sem espaço! Use /limpar para liberar espaço local.`,
      { parse_mode: "Markdown" }
    ).catch(() => {})
  } else if (pct >= 80) {
    bot.sendMessage(alertId,
      `⚠️ *Disco em ${pct}%*\n\nFique atento ao espaço em disco.`,
      { parse_mode: "Markdown" }
    ).catch(() => {})
  }
}

setInterval(cleanupOldLogs, 2 * 60 * 60 * 1000)
setTimeout(cleanupOldLogs, 2 * 60 * 1000)
setInterval(checkDiskAlert, 30 * 60 * 1000)
setTimeout(checkDiskAlert, 10 * 60 * 1000)

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
  const diskPctInit = getDiskPercent()
  console.log(`💿 DISCO NO STARTUP: ${diskPctInit}%`)
  aresBanner()
  bot.startPolling({ restart: true, interval: 2000 }).catch(() => {})
  bot.on("polling_error", (err) => {
    if (err.code === "ETELEGRAM" && err.message.includes("409")) return
    console.error("polling_error:", err.message)
  })
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
