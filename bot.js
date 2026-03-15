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

const bot = new TelegramBot(TOKEN, { polling: false })
const app = express()
const server = http.createServer(app)
const io = socketIo(server)

io.sockets.setMaxListeners(200)
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))
app.use(express.static("public"))

const BUCKETS = [
  {
    bucketName: "assembled-pannier-fd6o1qb",
    endpoint: "https://t3.storageapi.dev",
    region: "auto",
    credentials: {
      accessKeyId: "tid_fJEjO_LbZVrFtJEwWHkcSqT_IxIwYsahKIyqSlegejHUTbNNHB",
      secretAccessKey: "tsec_IjNC_oqgdq7-F9o067zq0C+h2INzkP8Ns-WbaU3vnu+gfUM49IbVMJHgaAeSG3GHNBml-L",
    }
  },
  {
    bucketName: "arranged-folder-su125mhv0",
    endpoint: "https://t3.storageapi.dev",
    region: "auto",
    credentials: {
      accessKeyId: "tid_dEBpaNfQwNQwXKIMrDhMkPyYMIFNdjyiwUczkkEsVWHuenafsu",
      secretAccessKey: "tsec_BzBVUGlcoPVfCI3_KqmRYQJR071fx2RY9Nzepvdz8mHxCzlOpvZb26gfrVhdurAeJDSi_Q",
    }
  },
  {
    bucketName: "practical-lunchbox-q6wejg",
    endpoint: "https://t3.storageapi.dev",
    region: "auto",
    credentials: {
      accessKeyId: "tid_g_lyTcQlTTXwyPBLXrrvOaVTVTUJzwxaOzNrVvaesOBlfttSEO",
      secretAccessKey: "tsec_VC92A93_brFk+9gUOPmEg8Q3e6bG2AWiY_vMfEqBJl84jee-l_2RMboQXTzqj2E5EYDuqN",
    }
  },
  {
    bucketName: "reserved-pail-1dm-clece3t",
    endpoint: "https://t3.storageapi.dev",
    region: "auto",
    credentials: {
      accessKeyId: "tid_huPrSUpYYNCWKTGaLxdPQWCrvxPbnudxZEDDWpnmspUXRvEonP",
      secretAccessKey: "tsec_2ra4rKw72iBQ+PIewNBnzZmyhUoFWAu7nSG-ataRyuzmAkkm6xTKClyCWERD0+W1vuz+xR",
    }
  }
]

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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ARES \u2014 ${botId}</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0e17;--bg2:#111827;--bg3:#1a2234;--bg4:#1e2a3a;--bd:#263046;--bd2:#334155;--tx:#e2e8f0;--tx2:#94a3b8;--tx3:#64748b;--green:#22d3a5;--green2:#16a37f;--blue:#60a5fa;--orange:#f59e0b;--red:#f87171;--red2:#ef4444;--purple:#a78bfa}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--tx);font-family:"Inter",sans-serif;font-size:14px}
#topbar{height:44px;background:var(--bg2);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 12px;gap:8px;flex-shrink:0;z-index:10}
.logo{color:var(--green);font-weight:700;font-size:14px;display:flex;align-items:center;gap:6px}
.logo-dot{width:8px;height:8px;background:var(--green);border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
.bot-chip{background:var(--bg3);border:1px solid var(--bd);border-radius:6px;padding:3px 9px;font-size:11px;color:var(--tx2);font-family:"JetBrains Mono",monospace;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp{flex:1}
.tbtn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;border:1px solid var(--bd);background:var(--bg3);color:var(--tx);transition:all .15s;white-space:nowrap;font-family:"Inter",sans-serif}
.tbtn:hover{background:var(--bg4)}.tbtn.g{background:var(--green2);border-color:var(--green);color:#000}.tbtn.g:hover{background:var(--green)}.tbtn.r{border-color:var(--red2);color:var(--red)}.tbtn.r:hover{background:rgba(248,113,113,.1)}
#si{width:6px;height:6px;border-radius:50%;background:var(--tx3)}#si.ok{background:var(--green)}#si.err{background:var(--red)}#si.loading{background:var(--orange);animation:pulse .8s infinite}
#status-wrap{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--tx3)}
#layout{display:flex;height:calc(100vh - 44px)}
#side{width:240px;background:var(--bg2);border-right:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0;transition:transform .25s;z-index:5}
#stabs{display:flex;border-bottom:1px solid var(--bd);flex-shrink:0}
.stab{flex:1;padding:8px 2px;text-align:center;font-size:11px;font-weight:600;color:var(--tx3);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:4px;user-select:none}
.stab.on{color:var(--green);border-color:var(--green)}.stab:hover:not(.on){color:var(--tx2)}
.panel{display:none;flex-direction:column;flex:1;overflow:hidden}.panel.on{display:flex}
.ph{padding:8px 10px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.ptitle{font-size:10px;color:var(--tx3);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.pbtns{display:flex;gap:2px}
.ib{background:none;border:none;color:var(--tx2);cursor:pointer;padding:5px;border-radius:5px;line-height:1;transition:all .15s;display:flex;align-items:center}.ib:hover{background:var(--bg3);color:var(--tx)}
#tree{flex:1;overflow-y:auto;padding:4px 0;user-select:none}#tree::-webkit-scrollbar{width:3px}#tree::-webkit-scrollbar-thumb{background:var(--bd)}
.row{display:flex;align-items:center;padding:5px 8px;cursor:pointer;border-radius:4px;margin:1px 4px;min-height:30px;gap:4px;position:relative}
.row:hover{background:var(--bg3)}.row.sel{background:rgba(34,211,165,.08);border-left:2px solid var(--green)}
.row .lbl{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-family:"JetBrains Mono",monospace}.row .lbl.d{color:var(--blue)}
.row .arr{font-size:8px;color:var(--tx3);width:10px;transition:transform .15s;flex-shrink:0}.row .arr.o{transform:rotate(90deg)}.row .arr.h{opacity:0}
.rctx{display:none;position:absolute;right:4px;top:50%;transform:translateY(-50%);gap:2px}.row:hover .rctx{display:flex}
.cx{background:var(--bg2);border:1px solid var(--bd);border-radius:3px;padding:2px 4px;cursor:pointer;color:var(--tx2);line-height:1;display:flex;align-items:center}.cx:hover{color:var(--tx);background:var(--bg4)}
#side-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:4}
.pinput{width:100%;background:var(--bg3);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;color:var(--tx);font-size:12px;outline:none;font-family:"Inter",sans-serif}.pinput:focus{border-color:var(--green)}
#pib{flex:1;padding:7px;border-radius:6px;background:var(--green2);border:1px solid var(--green);color:#000;font-weight:700;font-size:12px;cursor:pointer}#pib:hover{background:var(--green)}
#pkg-list{flex:1;overflow-y:auto}#pkg-list::-webkit-scrollbar{width:3px}#pkg-list::-webkit-scrollbar-thumb{background:var(--bd)}
.pr{display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid var(--bd);gap:6px;font-size:12px}
.pr .pn{flex:1;font-family:"JetBrains Mono",monospace;color:var(--tx)}.pr .pv{color:var(--tx3);font-size:10px}
.pr .pd{background:none;border:none;color:var(--tx3);cursor:pointer;padding:2px 5px;border-radius:3px;display:flex;align-items:center}.pr .pd:hover{color:var(--red);background:rgba(248,113,113,.1)}
.pe{padding:16px;font-size:12px;color:var(--tx3);text-align:center}
#pkg-term{background:var(--bg);border-top:1px solid var(--bd);font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--green);overflow-y:auto;max-height:160px;display:none}#pkg-term.on{display:block}
#pkg-term pre{padding:8px 10px;white-space:pre-wrap;word-break:break-all;margin:0}
.sr-item{padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--bd)}.sr-item:hover{background:var(--bg3)}
.sr-f{font-size:10px;color:var(--tx3);font-family:"JetBrains Mono",monospace}
.sr-l{font-size:12px;color:var(--tx);margin-top:2px;font-family:"JetBrains Mono",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sr-list{flex:1;overflow-y:auto}#sr-list::-webkit-scrollbar{width:3px}#sr-list::-webkit-scrollbar-thumb{background:var(--bd)}
#right{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#tabs-bar{background:var(--bg2);border-bottom:1px solid var(--bd);display:flex;overflow-x:auto;flex-shrink:0;min-height:34px}#tabs-bar::-webkit-scrollbar{height:0}
.tab{display:flex;align-items:center;gap:5px;padding:0 12px;height:34px;border-right:1px solid var(--bd);cursor:pointer;font-size:11px;color:var(--tx2);white-space:nowrap;flex-shrink:0;position:relative;font-family:"JetBrains Mono",monospace;transition:background .15s}
.tab:hover{background:var(--bg3)}.tab.on{color:var(--tx);background:var(--bg)}.tab.on::after{content:"";position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--green)}
.tab .tx{opacity:0;font-size:10px;padding:2px 3px;border-radius:2px;color:var(--tx3);transition:.1s;cursor:pointer;display:flex;align-items:center}.tab:hover .tx,.tab.on .tx{opacity:1}.tab .tx:hover{background:var(--bd);color:var(--tx)}
.tdot{width:6px;height:6px;background:var(--orange);border-radius:50%;flex-shrink:0}
#findbar{display:none;background:var(--bg2);border-bottom:1px solid var(--bd);padding:6px 10px;align-items:center;gap:8px;flex-shrink:0}#findbar.on{display:flex}
#find-in{background:var(--bg3);border:1px solid var(--bd);border-radius:5px;padding:4px 9px;color:var(--tx);font-size:12px;outline:none;width:180px;font-family:"JetBrains Mono",monospace}#find-in:focus{border-color:var(--green)}
.fbtn{background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:3px 8px;color:var(--tx2);cursor:pointer;font-size:11px;display:flex;align-items:center}.fbtn:hover{color:var(--tx)}
#find-close{background:none;border:none;color:var(--tx3);cursor:pointer;margin-left:auto;display:flex;align-items:center}#find-close:hover{color:var(--tx)}
#infobar{background:var(--bg);border-bottom:1px solid var(--bd);padding:0 12px;height:26px;display:flex;align-items:center;gap:16px;font-size:10px;color:var(--tx3);flex-shrink:0;font-family:"JetBrains Mono",monospace}#infobar span{color:var(--tx2)}#cur-pos{margin-left:auto}
#editor-wrap{flex:1;overflow:hidden}
#welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--tx3);padding:40px;text-align:center}
.wlogo{font-size:56px;opacity:.12}.wtitle{font-size:17px;color:var(--tx2);font-weight:500}.wsub{font-size:12px;line-height:1.7;max-width:280px}
.wkeys{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:4px}
.wk{background:var(--bg3);border:1px solid var(--bd);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:4px}
.wk kbd{background:var(--bg4);border:1px solid var(--bd2);border-radius:3px;padding:0 4px;font-family:"JetBrains Mono",monospace;font-size:10px}
#statusbar{height:24px;background:#0d1525;border-top:1px solid var(--bd);display:flex;align-items:center;padding:0 10px;gap:12px;font-size:10px;color:var(--tx3);flex-shrink:0;font-family:"JetBrains Mono",monospace}
#statusbar .si{display:flex;align-items:center;gap:4px}#statusbar .si span{color:var(--tx2)}.ssep{width:1px;height:12px;background:var(--bd)}
.ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:999;align-items:flex-end;justify-content:center;backdrop-filter:blur(3px)}.ov.on{display:flex}
@media(min-width:600px){.ov{align-items:center}}
.mbox{background:var(--bg2);border:1px solid var(--bd);border-radius:14px 14px 0 0;padding:24px;width:100%;max-width:460px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
@media(min-width:600px){.mbox{border-radius:12px}}
.mbox h3{margin-bottom:14px;font-size:15px;font-weight:600}
.mbox-in{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--tx);padding:10px 12px;border-radius:8px;font-size:14px;outline:none;font-family:"JetBrains Mono",monospace;margin-bottom:10px}.mbox-in:focus{border-color:var(--green)}
.mbts{display:flex;gap:8px;margin-top:4px}.mbts button{flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;border:1px solid var(--bd)}
.mok{background:var(--green2);border-color:var(--green);color:#000}.mok:hover{background:var(--green)}.mcancel{background:var(--bg3);color:var(--tx2)}.mcancel:hover{background:var(--bg4)}
.dz{border:2px dashed var(--bd);border-radius:8px;padding:20px;text-align:center;margin-bottom:12px;cursor:pointer;transition:all .2s;font-size:12px;color:var(--tx3)}.dz:hover,.dz.over{border-color:var(--green);background:rgba(34,211,165,.05);color:var(--green)}
.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(10px);background:var(--bg2);border:1px solid var(--bd);padding:9px 16px;border-radius:8px;font-size:12px;z-index:9999;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:90vw;text-align:center}
.toast.on{opacity:1;transform:translateX(-50%)}.toast.ok{border-color:var(--green);color:var(--green)}.toast.err{border-color:var(--red);color:var(--red)}.toast.info{border-color:var(--blue);color:var(--blue)}
#mbtn{background:none;border:none;color:var(--tx2);font-size:20px;cursor:pointer;padding:4px;line-height:1;display:none}
@media(max-width:700px){#side{position:fixed;top:44px;left:0;bottom:0;width:82vw;max-width:280px;transform:translateX(-100%);box-shadow:4px 0 24px rgba(0,0,0,.5)}#side.open{transform:translateX(0)}#side-ov.on{display:block}#mbtn{display:block}.bot-chip{max-width:90px}.tbtn span{display:none}}
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
          <button class="ib" title="Upload" onclick="openUploadModal()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg></button>
          <button class="ib" title="Novo arquivo" onclick="doNewFile()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg></button>
          <button class="ib" title="Nova pasta" onclick="doNewFolder()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg></button>
          <button class="ib" title="Atualizar" onclick="loadTree()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
        </div>
      </div>
      <div id="tree"><div style="padding:12px;font-size:12px;color:var(--tx3)">Carregando...</div></div>
      <input type="file" id="upload-input" multiple style="display:none">
    </div>
    <div class="panel" id="panel-packages">
      <div class="ph"><span class="ptitle">Pacotes npm</span></div>
      <div style="padding:8px;border-bottom:1px solid var(--bd)"><input class="pinput" id="pkg-in" type="text" placeholder="axios, lodash, dotenv..." spellcheck="false"></div>
      <div style="display:flex;gap:6px;padding:8px">
        <button id="pib" onclick="installPkg()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline;vertical-align:middle;margin-right:4px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Instalar</button>
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
      <input id="find-in" type="text" placeholder="Buscar..." spellcheck="false">
      <button class="fbtn" onclick="findPrev()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg></button>
      <button class="fbtn" onclick="findNext()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button>
      <button class="fbtn" onclick="findReplace()">Replace</button>
      <button id="find-close" onclick="closeFindBar()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div id="infobar" style="display:none"><div id="ib-lang">&mdash;</div><div class="ssep"></div><div id="ib-size">&mdash;</div><div class="ssep"></div><div>UTF-8</div><div id="cur-pos">Ln 1, Col 1</div></div>
    <div id="editor-wrap" style="display:none"></div>
    <div id="welcome">
      <svg class="wlogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      <div class="wtitle">ARES Editor</div>
      <div class="wsub">Selecione um arquivo para editar ou crie um novo</div>
      <div class="wkeys"><div class="wk"><kbd>Ctrl+S</kbd> Salvar</div><div class="wk"><kbd>Ctrl+F</kbd> Buscar</div><div class="wk"><kbd>Ctrl+Z</kbd> Desfazer</div></div>
    </div>
    <div id="statusbar"><div class="si"><svg width="6" height="6" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#22d3a5"/></svg><span id="sb-text">Pronto</span></div><div class="ssep"></div><div class="si">Tab: <span>2 esp</span></div></div>
  </div>
</div>
<div class="ov" id="modal"><div class="mbox"><h3 id="modal-title">Nome</h3><input class="mbox-in" id="modal-in" type="text" autocomplete="off" spellcheck="false"><div class="mbts"><button class="mcancel" onclick="closeModal()">Cancelar</button><button class="mok" onclick="confirmModal()">OK</button></div></div></div>
<div class="ov" id="modal-upload">
  <div class="mbox">
    <h3>Upload de Arquivos</h3>
    <div class="dz" id="dz"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 8px;display:block;opacity:.5"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>Arraste arquivos ou clique para selecionar<input type="file" id="upl2" multiple style="display:none"></div>
    <div id="upl-prog" style="font-size:12px;color:var(--tx3);min-height:18px"></div>
    <div class="mbts" style="margin-top:12px"><button class="mcancel" onclick="closeUploadModal()">Fechar</button></div>
  </div>
</div>
<div class="toast" id="toast"></div>
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
  var icons = {
    js: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#f7df1e"/><text x="3" y="12" font-size="9" font-family="monospace" font-weight="bold" fill="#000">JS</text></svg>',
    ts: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#3178c6"/><text x="2" y="12" font-size="9" font-family="monospace" font-weight="bold" fill="#fff">TS</text></svg>',
    jsx: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#61dafb"/><text x="2" y="12" font-size="8" font-family="monospace" font-weight="bold" fill="#000">JSX</text></svg>',
    tsx: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#3178c6"/><text x="2" y="12" font-size="8" font-family="monospace" font-weight="bold" fill="#fff">TSX</text></svg>',
    json: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    py: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#306998"/><text x="2" y="12" font-size="9" font-family="monospace" font-weight="bold" fill="#ffd43b">PY</text></svg>',
    html: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e44d26" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    css: '<svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#2965f1"/><text x="1" y="12" font-size="8" font-family="monospace" font-weight="bold" fill="#fff">CSS</text></svg>',
    md: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    env: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22d3a5" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    sh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    yml: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
  };
  return icons[e] || '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

function folderIcon(o) {
  return o
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
}

function buildRows(items, depth) {
  var h = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var pad = 6 + depth * 14;
    var hp = hEsc(it.path);
    var hn = hEsc(it.name);
    if (it.type === 'dir') {
      var o = openDirs.has(it.path);
      h += '<div class="row" data-act="dir" data-p="' + hp + '" style="padding-left:' + pad + 'px">';
      h += '<span class="arr ' + (o ? 'o' : '') + '">▶</span>';
      h += folderIcon(o);
      h += '<span class="lbl d">' + hn + '</span>';
      h += '<div class="rctx">';
      h += '<button class="cx" data-act="nfi" data-p="' + hp + '" title="Novo arquivo">➕</button>';
      h += '<button class="cx" data-act="delf" data-p="' + hp + '" title="Excluir pasta">🗑️</button>';
      h += '</div></div>';
      if (o && it.children) h += buildRows(it.children, depth + 1);
    } else {
      var sel = curFile === it.path ? ' sel' : '';
      h += '<div class="row' + sel + '" data-act="open" data-p="' + hp + '" style="padding-left:' + (pad + 12) + 'px">';
      h += '<span class="arr h">▶</span>';
      h += fileIcon(it.name);
      h += '<span class="lbl">' + hn + '</span>';
      h += '<div class="rctx">';
      h += '<button class="cx" data-act="dl" data-p="' + hp + '" title="Download">📥</button>';
      h += '<button class="cx" data-act="dup" data-p="' + hp + '" title="Duplicar">📄</button>';
      h += '<button class="cx" data-act="qren" data-p="' + hp + '" title="Renomear">✏️</button>';
      h += '</div></div>';
    }
  }
  return h;
}

function renderTree() {
  var el = document.getElementById('tree');
  el.innerHTML = treeData.length ? buildRows(treeData, 0) : '<div style="padding:12px;font-size:12px;color:var(--tx3)">Pasta vazia</div>';
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
  closeModal();
  if (modalCb) modalCb(v);
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
      fontSize: 14,
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontLigatures: true,
      minimap: { enabled: true, renderCharacters: false, scale: 1 },
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      padding: { top: 12 },
      lineNumbers: 'on',
      renderLineHighlight: 'all',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      formatOnPaste: true,
      tabSize: 2,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      suggest: { showKeywords: true, showSnippets: true }
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
  bot.startPolling({ restart: true }).catch(() => {})
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
