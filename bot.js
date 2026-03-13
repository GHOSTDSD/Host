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
const { execFile, execSync } = require("child_process")
const crypto = require("crypto")

// ─── S3 Client ──────────────────────────────
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const tar = require("tar");

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

// ─── Configuração do Storage Bucket ──────────────────────────────
const BUCKET_CONFIG = {
  endpoint: process.env.BUCKET_ENDPOINT,
  region: process.env.BUCKET_REGION || "auto",
  credentials: {
    accessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
  },
  bucketName: process.env.BUCKET_NAME
};

// Verifica se as credenciais existem
if (!BUCKET_CONFIG.credentials.accessKeyId || !BUCKET_CONFIG.credentials.secretAccessKey) {
  console.error("❌ Credenciais do Storage Bucket não configuradas!");
  console.error("Adicione no Railway:");
  console.error("  BUCKET_ACCESS_KEY_ID");
  console.error("  BUCKET_SECRET_ACCESS_KEY");
  console.error("  BUCKET_ENDPOINT");
  console.error("  BUCKET_NAME");
  process.exit(1);
}

console.log("✅ Storage Bucket configurado com sucesso!");

const s3Client = new S3Client({
  endpoint: BUCKET_CONFIG.endpoint,
  region: BUCKET_CONFIG.region,
  credentials: BUCKET_CONFIG.credentials,
  forcePathStyle: true
});

const BASE_PATH = path.resolve(process.cwd(), "instances")
if (!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH, { recursive: true })

// Cache temporário (apenas para bots ativos)
const TEMP_CACHE_DIR = path.join(os.tmpdir(), "ares_temp_cache");
if (!fs.existsSync(TEMP_CACHE_DIR)) fs.mkdirSync(TEMP_CACHE_DIR, { recursive: true });

const activeBots = {}
const userState = {}
const usedPorts = new Set()
const uploadTokens = {}
const webSessions = {}
const logBuffers = {}
const PORT_START = 4000

// Configurações otimizadas
const LOG_CONFIG = {
  MAX_SIZE: 100 * 1024,
  BUFFER_TIME: 5000
}

// ─── Owner helpers
function saveMeta(botId, chatId, name) {
  const mp = path.join(BASE_PATH, botId, "meta.json")
  fs.writeFileSync(mp, JSON.stringify({ 
    owner: String(chatId), 
    name, 
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    nodeModulesHash: null
  }))
}

function getMeta(botId) {
  try { 
    return JSON.parse(fs.readFileSync(path.join(BASE_PATH, botId, "meta.json"), "utf8")) 
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
  const m = getMeta(botId); return m ? m.owner : null
}

function getUserBots(chatId) {
  if (!fs.existsSync(BASE_PATH)) return []
  return fs.readdirSync(BASE_PATH).filter(f => {
    if (f === "_uploads") return false
    const owner = getOwner(f)
    return owner === String(chatId)
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
  const m = rawUrl.match(/\/([^\/]+)\/?(?:\?|$)/)
  const botId = m ? m[1] : null
  const chatId = checkSession(req)
  if (!chatId) return res.status(401).send("Acesso negado. Abra o link pelo Telegram.")
  const owner = botId ? getOwner(botId) : null
  if (owner && owner !== chatId) return res.status(403).send("Este bot pertence a outro usuário.")
  
  if (botId) updateMetaAccess(botId)
  
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

function getStats(chatId = null) {
  let bots = []
  if (chatId) {
    bots = getUserBots(chatId)
  } else {
    bots = fs.existsSync(BASE_PATH) 
      ? fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads") 
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
    const df = execSync('df -h / | tail -1').toString()
    const parts = df.split(/\s+/)
    diskUsage = `${parts[4]} (${parts[2]}/${parts[1]})`
  } catch {}
  
  console.log(`\n🚀 ARES HOST (STORAGE BUCKET)
📦 BOTS DISCO: ${s.total}
🟢 BOTS ONLINE: ${s.online}
💾 RAM: ${s.ram}MB
⏱ UPTIME: ${s.uptime}
💿 DISCO: ${diskUsage}
☁️  BUCKET: Configurado\n`)
}

// ─── Funções do Storage Bucket ─────────────────────────────────

function getPackageHash(packagePath) {
  try {
    const content = fs.readFileSync(packagePath, 'utf8')
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 12)
  } catch {
    return null
  }
}

async function checkNodeModulesInBucket(botId, packageHash) {
  try {
    const command = new HeadObjectCommand({
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `${botId}_${packageHash}.tar.gz`
    });
    await s3Client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NotFound') {
      return false;
    }
    console.error("Erro ao verificar bucket:", error);
    return false;
  }
}

async function uploadNodeModulesToBucket(botId, nodeModulesPath, packageHash) {
  const tarballPath = path.join(os.tmpdir(), `${botId}_${packageHash}.tar.gz`);
  
  try {
    writeLog(botId, path.dirname(nodeModulesPath), "📦 Compactando node_modules...\r\n");
    
    await tar.c(
      {
        gzip: true,
        file: tarballPath,
        cwd: path.dirname(nodeModulesPath),
      },
      [path.basename(nodeModulesPath)]
    );
    
    const fileStream = fs.createReadStream(tarballPath);
    const uploadParams = {
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `${botId}_${packageHash}.tar.gz`,
      Body: fileStream,
      ContentType: 'application/gzip',
    };
    
    await s3Client.send(new PutObjectCommand(uploadParams));
    writeLog(botId, path.dirname(nodeModulesPath), "✅ node_modules salvo no bucket\r\n");
    
    updateNodeModulesHash(botId, packageHash);
    return true;
  } catch (error) {
    writeLog(botId, path.dirname(nodeModulesPath), `❌ Erro ao enviar para bucket: ${error.message}\r\n`);
    return false;
  } finally {
    try { fs.unlinkSync(tarballPath); } catch {}
  }
}

async function downloadNodeModulesFromBucket(botId, targetPath, packageHash) {
  const tarballPath = path.join(os.tmpdir(), `${botId}_${packageHash}.tar.gz`);
  
  try {
    writeLog(botId, targetPath, "📥 Baixando node_modules do bucket...\r\n");
    
    const getParams = {
      Bucket: BUCKET_CONFIG.bucketName,
      Key: `${botId}_${packageHash}.tar.gz`,
    };
    
    const response = await s3Client.send(new GetObjectCommand(getParams));
    
    const writeStream = fs.createWriteStream(tarballPath);
    await new Promise((resolve, reject) => {
      response.Body.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });
    
    await tar.x({
      file: tarballPath,
      cwd: targetPath,
      gzip: true,
    });
    
    writeLog(botId, targetPath, "✅ node_modules restaurado do bucket\r\n");
    return true;
  } catch (error) {
    writeLog(botId, targetPath, `❌ Erro ao baixar do bucket: ${error.message}\r\n`);
    return false;
  } finally {
    try { fs.unlinkSync(tarballPath); } catch {}
  }
}

// ─── Logs otimizados ─────────────────────────

function writeLog(botId, instancePath, data) {
  if (!logBuffers[botId]) {
    logBuffers[botId] = []
    
    const interval = setInterval(() => {
      if (logBuffers[botId] && logBuffers[botId].length > 0) {
        const logPath = path.join(instancePath, "terminal.log")
        const content = logBuffers[botId].join('')
        logBuffers[botId] = []
        
        try {
          if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_CONFIG.MAX_SIZE) {
            const oldContent = fs.readFileSync(logPath, "utf8")
            const lines = oldContent.split('\n').slice(-100).join('\n')
            fs.writeFileSync(logPath, lines + content)
          } else {
            fs.appendFileSync(logPath, content)
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
  const nativeModules = ['sqlite3', 'bcrypt', 'sharp', 'canvas', 'grpc', 'better-sqlite3']
  
  for (const mod of nativeModules) {
    const modPath = path.join(nodeModulesPath, mod)
    if (fs.existsSync(modPath)) {
      const files = fs.readdirSync(modPath, { recursive: true })
      for (const file of files) {
        if (file.endsWith('.node')) return true
      }
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
    rebuild.onData(d => writeLog(path.basename(instancePath), instancePath, d))
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
    
    // Remove node_modules quando o bot para (libera espaço)
    const nm = path.join(instancePath, 'node_modules')
    if (fs.existsSync(nm)) {
      fs.rmSync(nm, { recursive: true, force: true })
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

  aresBanner()
  updateMetaAccess(botId)

  const start = detectStart(instancePath)
  if (!start) {
    writeLog(botId, instancePath, "❌ Nenhum start detectado\r\n")
    return
  }

  const nodeModulesPath = path.join(instancePath, 'node_modules')
  
  // Se já existe node_modules local, usa direto
  if (fs.existsSync(nodeModulesPath)) {
    writeLog(botId, instancePath, "✅ Usando node_modules existente\r\n")
    runInstance(botId, instancePath, botPort, env, start)
    return
  }

  // Verifica se tem package.json
  if (fs.existsSync(path.join(instancePath, "package.json"))) {
    const packagePath = path.join(instancePath, "package.json");
    const packageHash = getPackageHash(packagePath);
    
    // Tenta baixar do bucket
    const exists = await checkNodeModulesInBucket(botId, packageHash);
    
    if (exists) {
      const downloaded = await downloadNodeModulesFromBucket(botId, instancePath, packageHash);
      
      if (downloaded && fs.existsSync(nodeModulesPath)) {
        const needsRebuild = checkNativeModules(nodeModulesPath);
        if (needsRebuild) {
          writeLog(botId, instancePath, "🔄 Recompilando módulos nativos...\r\n");
          await rebuildNativeModules(instancePath);
        }
        runInstance(botId, instancePath, botPort, env, start);
        return;
      }
    }
    
    // Se não existe no bucket, instala
    writeLog(botId, instancePath, "📦 Instalando dependencias (primeira vez)...\r\n");
    
    if (fs.existsSync(nodeModulesPath)) {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    }
    
    const install = pty.spawn(
      os.platform() === "win32" ? "npm.cmd" : "npm",
      ["install", "--production", "--no-audit", "--no-fund"],
      { name: "xterm-color", cols: 80, rows: 40, cwd: instancePath, env }
    );
    
    install.onData(d => writeLog(botId, instancePath, d));
    
    install.onExit(async () => {
      if (fs.existsSync(nodeModulesPath)) {
        const needsRebuild = checkNativeModules(nodeModulesPath);
        if (needsRebuild) {
          writeLog(botId, instancePath, "🔄 Recompilando módulos nativos...\r\n");
          await rebuildNativeModules(instancePath);
        }
        
        writeLog(botId, instancePath, "📤 Salvando node_modules no bucket...\r\n");
        await uploadNodeModulesToBucket(botId, nodeModulesPath, packageHash);
      }
      
      runInstance(botId, instancePath, botPort, env, start);
    });
  } else {
    runInstance(botId, instancePath, botPort, env, start);
  }
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

const TERMOS_TEXTO = `📋 *Termos de Uso — ARES HOST*\n\nAntes de continuar, leia e aceite os termos abaixo...`

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

const termoCheck = {}

// ─── Comandos ─────────────────────────────────

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
    `🚀 *ARES HOST (Storage Bucket)*\n\n` +
    `🤖 Seus Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n` +
    `💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*\n` +
    `☁️ Armazenamento: Bucket (ilimitado)`,
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

// ─── Download e Upload ────────────────────────

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

function extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg) {
  fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: instancePath }))
    .on("close", () => {
      const nm = path.join(instancePath, "node_modules")
      if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true })
      spawnBot(botId, instancePath)
      bot.editMessageText(
        `✅ *Bot criado com sucesso!*\n\n📦 Nome: *${name}*\n🆔 ID: \`${botId}\`\n🟢 Status: *Iniciando...*\n☁️ node_modules será armazenado no bucket`,
        {
          chat_id: loadingMsg.chat.id,
          message_id: loadingMsg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📟 Abrir Terminal", url: `${DOMAIN}/terminal/${botId}?s=${genWebSession(loadingMsg.chat.id)}` }],
              [{ text: "📂 Meus Bots", callback_data: "menu_list" }]
            ]
          }
        }
      )
    })
    .on("error", err => {
      bot.editMessageText(`❌ Erro ao extrair: ${err.message}`, { chat_id: loadingMsg.chat.id, message_id: loadingMsg.message_id })
    })
}

// Handlers de documento e mensagem (mantidos iguais ao original)
bot.on("document", async msg => {
  const chatId = msg.chat.id
  if (!hasAccepted(chatId)) {
    termoCheck[chatId] = false
    return sendTermos(chatId, false)
  }
  if (!msg.document.file_name.toLowerCase().endsWith(".zip")) {
    return bot.sendMessage(chatId, "⚠️ *Arquivo invalido!*\n\nEnvie um arquivo .zip com o codigo do bot.", { parse_mode: "Markdown" })
  }
  userState[chatId] = { fileId: msg.document.file_id }
  bot.sendMessage(chatId, `✅ *ZIP recebido*\n\nAgora envie um *nome* para o bot:`, { parse_mode: "Markdown" })
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
      return bot.sendMessage(chatId, "🔗 *Link recebido!*\n\nAgora envie um *nome* para o bot:", { parse_mode: "Markdown" })
    }
    return
  }
  if (state.botName) return
  const name = msg.text.trim().replace(/\s+/g, "_").toLowerCase()
  const botId = generateBotId()
  const instancePath = path.join(BASE_PATH, botId)
  state.botName = name
  state.botId = botId
  fs.mkdirSync(instancePath, { recursive: true })
  saveMeta(botId, chatId, name)
  const loadingMsg = await bot.sendMessage(chatId, `⏳ Criando bot *${name}*...`, { parse_mode: "Markdown" })
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

// Callback queries (resumido por espaço, mas você mantém o original completo)
bot.on("callback_query", async query => {
  const chatId = query.message.chat.id
  const msgId = query.message.message_id
  const data = query.data
  const colonIdx = data.indexOf(":")
  const action = colonIdx === -1 ? data : data.slice(0, colonIdx)
  const id = colonIdx === -1 ? null : data.slice(colonIdx + 1)
  bot.answerCallbackQuery(query.id)

  // Menu principal
  if (action === "menu_home") {
    const s = getStats(chatId)
    return bot.editMessageText(
      `🚀 *ARES HOST*\n\n🤖 Seus Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*\n💾 RAM: *${s.ram}MB*  |  ⏱ Uptime: *${s.uptime}*`,
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
      "➕ *Novo Bot*\n\nEscolha como enviar o arquivo .zip:\n\n📎 Envie direto aqui (ate 20MB)\n🔗 Envie um link publico do ZIP\n🌐 Use a pagina de upload",
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌐 Gerar link de upload", callback_data: "gen_upload" }],
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
    return bot.editMessageText(
      `🌐 *Link de Upload Gerado*\n\nAcesse a pagina abaixo:\n\n⏳ Expira em *15 minutos*`,
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
  
  if (action === "menu_list") {
    const folders = getUserBots(chatId)
    const s = getStats(chatId)
    if (folders.length === 0) {
      return bot.editMessageText(
        "📂 *Meus Bots*\n\nNenhum bot hospedado ainda.",
        {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "➕ Novo Bot", callback_data: "menu_new" }], [{ text: "⬅️ Voltar", callback_data: "menu_home" }]] }
        }
      )
    }
    const buttons = folders.map(f => [{ text: `${activeBots[f] ? "🟢" : "🔴"} ${f}`, callback_data: `manage:${f}` }])
    buttons.push([{ text: "⬅️ Voltar", callback_data: "menu_home" }])
    return bot.editMessageText(
      `📂 *Meus Bots*\n\n🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*  |  Total: *${s.total}*`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
    )
  }
  
  if (action === "manage" && id) {
    if (getOwner(id) !== String(chatId)) return
    updateMetaAccess(id)
    const isRunning = !!activeBots[id]
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: ${isRunning ? "🟢 Online" : "🔴 Offline"}`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "📁 Arquivos", url: `${DOMAIN}/files/${id}?s=${genWebSession(chatId)}` }],
            [{ text: isRunning ? "🛑 Parar" : "▶️ Iniciar", callback_data: `${isRunning ? "stop" : "start"}:${id}` }],
            [{ text: "🔄 Reiniciar", callback_data: `restart:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
  
  if (action === "stop" && id) {
    if (activeBots[id]) activeBots[id].process.kill()
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🔴 Offline`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "▶️ Iniciar", callback_data: `start:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
  
  if (action === "start" && id) {
    spawnBot(id, path.join(BASE_PATH, id))
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Iniciando...`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "🛑 Parar", callback_data: `stop:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
  
  if (action === "restart" && id) {
    spawnBot(id, path.join(BASE_PATH, id))
    return bot.editMessageText(
      `🛠 *Gerenciar Bot*\n\nID: \`${id}\`\nStatus: 🟢 Reiniciando...`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📟 Terminal", url: `${DOMAIN}/terminal/${id}?s=${genWebSession(chatId)}` }],
            [{ text: "🛑 Parar", callback_data: `stop:${id}` }],
            [{ text: "⬅️ Voltar", callback_data: "menu_list" }]
          ]
        }
      }
    )
  }
  
  // Termos
  if (action === "termo_check") {
    termoCheck[chatId] = id === "1"
    const icon = termoCheck[chatId] ? "✅" : "⬜"
    return bot.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: `${icon}  Li e aceito os termos de uso`, callback_data: `termo_check:${termoCheck[chatId] ? "0" : "1"}` }],
        [{ text: "✔️ Confirmar e Continuar", callback_data: "termo_confirmar" }]
      ]
    }, { chat_id: chatId, message_id: msgId })
  }
  
  if (action === "termo_confirmar") {
    if (!termoCheck[chatId]) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Marque a caixa primeiro!", show_alert: true })
    }
    saveAccepted(chatId)
    delete termoCheck[chatId]
    bot.deleteMessage(chatId, msgId).catch(() => {})
    const s = getStats(chatId)
    return bot.sendMessage(chatId,
      `✅ *Termos aceitos!*\n\n🚀 *ARES HOST*\n\n🤖 Seus Bots: *${s.total}*  |  🟢 Online: *${s.online}*  |  🔴 Off: *${s.offline}*`,
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
})

// ─── Rotas Web ────────────────────────────────

app.get("/terminal/:botId", authBot, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit/lib/xterm-addon-fit.js"></script>
<script src="/socket.io/socket.io.js"></script>
<style>body{margin:0;background:#000;display:flex;flex-direction:column;height:100vh}#header{background:#111;color:#0f0;padding:10px;font-family:monospace}#terminal{flex:1}</style>
</head>
<body>
<div id="header">🚀 ARES TERMINAL</div>
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
socket.on("connect",()=>{term.clear();socket.emit("request-history",{botId})})
socket.on("history-"+botId,data=>term.write(data))
socket.on("log-"+botId,data=>term.write(data))
term.onData(data=>socket.emit("input",{botId,data}))
</script>
</body>
</html>`)
})

app.get("/upload/:token", (req, res) => {
  const info = uploadTokens[req.params.token]
  if (!info) return res.status(403).send("Link inválido ou expirado")
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Upload</title>
<style>body{background:#0a0a0a;color:#fff;font-family:monospace;display:flex;justify-content:center;padding:20px}.card{background:#111;border-radius:16px;padding:36px;max-width:480px}</style>
</head>
<body>
<div class="card">
<h2>📦 Upload do Bot</h2>
<input type="file" id="file" accept=".zip">
<input type="text" id="name" placeholder="Nome do bot">
<button onclick="upload()">Enviar</button>
<div id="status"></div>
</div>
<script>
const token="${req.params.token}"
async function upload(){
  const file=document.getElementById('file').files[0]
  const name=document.getElementById('name').value.trim().replace(/\\s+/g,'_').toLowerCase()
  if(!file||!name) return alert('Preencha tudo')
  const fd=new FormData(); fd.append('file',file); fd.append('name',name)
  const res=await fetch('/upload/'+token,{method:'POST',body:fd})
  document.getElementById('status').innerText=res.ok?'✅ Enviado!':'❌ Erro'
}
</script>
</body>
</html>`)
})

app.post("/upload/:token", (req, res, next) => {
  if (!uploadTokens[req.params.token]) return res.status(403).send("Token invalido")
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
      return cb(new Error("Apenas .zip"))
    cb(null, true)
  }
}).single("file"), async (req, res) => {
  const token = req.params.token
  const info = uploadTokens[token]
  const name = (req.body.name || "bot").replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 40)
  const botId = generateBotId()
  const instancePath = path.join(BASE_PATH, botId)
  delete uploadTokens[token]
  fs.mkdirSync(instancePath, { recursive: true })
  saveMeta(botId, info.chatId, name)
  const zipPath = path.join(instancePath, "bot.zip")
  fs.renameSync(req.file.path, zipPath)
  const loadingMsg = await bot.sendMessage(info.chatId, `⏳ Criando bot *${name}*...`, { parse_mode: "Markdown" })
  extractAndSpawn(botId, instancePath, zipPath, name, loadingMsg)
  res.send("ok")
})

// ─── Editor de Arquivos (simplificado) ──────
app.use("/files", authBot, (req, res, next) => {
  const m = req.originalUrl.match(/^\/files\/([^/]+)\/?$/)
  if (!m) return next()
  const botId = m[1]
  res.send(`<!DOCTYPE html><html><body>Editor de arquivos para ${botId}</body></html>`)
})

// ─── Inicialização ────────────────────────────

process.on("uncaughtException", err => {
  if (err.code !== "EADDRINUSE") console.error(err)
})

server.listen(PORT, () => {
  aresBanner()
  if (fs.existsSync(BASE_PATH)) {
    const bots = fs.readdirSync(BASE_PATH).filter(f => f !== "_uploads")
    bots.forEach((botId, i) => {
      setTimeout(() => spawnBot(botId, path.join(BASE_PATH, botId)), i * 2000)
    })
  }
})
