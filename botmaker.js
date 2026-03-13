/**
 * ARES BOTMAKER
 * Gera um bot WhatsApp pronto para hospedar com base nas configurações do usuário.
 * Usa Baileys (biblioteca leve, sem precisar de API paga).
 */

const fs   = require("fs")
const path = require("path")
const os   = require("os")
const { execSync } = require("child_process")
const archiver = require("archiver")

/**
 * Gera o código-fonte do bot WhatsApp baseado nas opções do usuário.
 * @param {Object} opts
 * @param {string} opts.prefix        - Prefixo dos comandos (ex: "!")
 * @param {string} opts.ownerNumber   - Número do dono (ex: "5511999999999")
 * @param {string} opts.botName       - Nome do bot
 * @param {Array}  opts.autoRespostas - [ { gatilho: "oi", resposta: "Olá!" } ]
 * @param {boolean} opts.antiLink     - Ativa anti-link?
 * @param {boolean} opts.bemVindo     - Ativa mensagem de bem-vindo?
 * @param {boolean} opts.menuAuto     - Ativa menu automático?
 * @returns {string} Código JS do index.js do bot
 */
function gerarCodigoBot(opts) {
  const { prefix, ownerNumber, botName, autoRespostas, antiLink, bemVindo, menuAuto } = opts

  const autoRespostasCode = autoRespostas.map(({ gatilho, resposta }) => {
    const g = gatilho.toLowerCase().trim()
    const r = resposta.replace(/`/g, "\\`")
    return `  if (texto === "${g}" || texto === "${prefix}${g}") {\n    await sock.sendMessage(from, { text: \`${r}\` })\n    return\n  }`
  }).join("\n\n")

  const menuItems = autoRespostas.map(a => `• ${prefix}${a.gatilho.toLowerCase()} — ${a.resposta.substring(0, 30)}${a.resposta.length > 30 ? "..." : ""}`).join("\n")

  return `// Bot WhatsApp — Gerado pelo ARES HOST
// Nome: ${botName}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const pino = require("pino")
const fs = require("fs")

const PREFIX    = "${prefix}"
const OWNER     = "${ownerNumber}@s.whatsapp.net"
const BOT_NAME  = "${botName}"

const store = makeInMemoryStore({ logger: pino({ level: "silent" }) })

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["${botName}", "Safari", "1.0.0"],
  })

  store.bind(sock.ev)

  sock.ev.on("creds.update", saveCreds)

  // ── Conexão
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\\n📱 Escaneie o QR Code acima com seu WhatsApp!\\n")
    }
    if (connection === "close") {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log("Conexão fechada:", lastDisconnect?.error?.message)
      if (shouldReconnect) {
        console.log("Reconectando...")
        startBot()
      } else {
        console.log("Desconectado permanentemente. Delete a pasta 'auth' e reinicie.")
      }
    } else if (connection === "open") {
      console.log("✅ Bot conectado! " + BOT_NAME + " está online.")
    }
  })

${bemVindo ? `
  // ── Bem-vindo ao entrar no grupo
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action !== "add") return
    for (const p of participants) {
      const num = p.split("@")[0]
      try {
        await sock.sendMessage(id, {
          text: \`👋 Bem-vindo(a) ao grupo, @\${num}! Seja muito bem-vindo(a)! 🎉\`,
          mentions: [p]
        })
      } catch {}
    }
  })
` : ""}

${antiLink ? `
  // ── Anti-link
  const LINK_REGEX = /(https?:\\/\\/)|(www\\.)|(\\.com|\\.net|\\.org|\\.br|\\.io)|(t\\.me\\/|wa\\.me\\/)/gi
  async function verificarLink(sock, msg, from, texto) {
    if (!LINK_REGEX.test(texto)) return false
    const sender = msg.key.participant || msg.key.remoteJid
    if (sender === OWNER) return false
    try {
      await sock.sendMessage(from, { delete: msg.key })
      await sock.sendMessage(from, { text: \`⚠️ @\${sender.split("@")[0]} links não são permitidos neste grupo!\`, mentions: [sender] })
    } catch {}
    return true
  }
` : ""}

  // ── Mensagens
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return

    for (const msg of messages) {
      if (!msg.message) continue
      if (msg.key.fromMe) continue

      const from   = msg.key.remoteJid
      const sender = msg.key.participant || from
      const isOwner = sender === OWNER || from === OWNER

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || ""

      const texto = body.trim().toLowerCase()
      if (!texto) continue

${antiLink ? `
      // Anti-link nos grupos
      if (from.endsWith("@g.us")) {
        if (await verificarLink(sock, msg, from, body)) continue
      }
` : ""}

${menuAuto ? `
      // Menu automático
      if (texto === \`\${PREFIX}menu\` || texto === \`\${PREFIX}help\` || texto === \`\${PREFIX}ajuda\`) {
        await sock.sendMessage(from, {
          text: \`╔══════════════════╗
║  🤖 *\${BOT_NAME}*  ║
╚══════════════════╝

*Comandos disponíveis:*

${menuItems}

• \${PREFIX}ping — verificar se bot está online

_Bot gerado pelo ARES HOST_\`
        })
        continue
      }
` : ""}

      // Ping
      if (texto === \`\${PREFIX}ping\`) {
        const inicio = Date.now()
        const m = await sock.sendMessage(from, { text: "🏓 Calculando..." })
        const ms = Date.now() - inicio
        await sock.sendMessage(from, { text: \`🏓 *Pong!* \${ms}ms\`, edit: m.key })
        continue
      }

      // ── Respostas automáticas personalizadas
${autoRespostasCode}

    }
  })
}

startBot().catch(console.error)
`
}

/**
 * Gera o package.json do bot.
 */
function gerarPackageJson(botName) {
  return JSON.stringify({
    name: botName.toLowerCase().replace(/\s+/g, "-"),
    version: "1.0.0",
    description: `Bot WhatsApp gerado pelo ARES HOST`,
    main: "index.js",
    scripts: {
      start: "node index.js"
    },
    dependencies: {
      "@whiskeysockets/baileys": "^6.7.9",
      "@hapi/boom": "^10.0.1",
      "pino": "^8.21.0"
    }
  }, null, 2)
}

/**
 * Gera o README do bot.
 */
function gerarReadme(botName, ownerNumber, prefix) {
  return `# 🤖 ${botName}

Bot WhatsApp gerado automaticamente pelo **ARES HOST**.

## Como usar

1. Ao iniciar, um **QR Code** aparecerá no terminal
2. Abra o WhatsApp → Configurações → Aparelhos conectados
3. Escaneie o QR Code
4. Pronto! O bot está online ✅

## Informações

- **Prefixo de comandos:** \`${prefix}\`
- **Número do dono:** \`${ownerNumber}\`

## Comandos

- \`${prefix}menu\` — Ver todos os comandos
- \`${prefix}ping\` — Testar se o bot está online

---
_Gerado pelo ARES HOST_
`
}

/**
 * Cria o ZIP do bot em memória e retorna o buffer.
 * @param {Object} opts - Opções do bot (mesmas do gerarCodigoBot)
 * @returns {Promise<Buffer>} Buffer do ZIP
 */
function criarZipBot(opts) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const archive = archiver("zip", { zlib: { level: 9 } })

    archive.on("data", chunk => chunks.push(chunk))
    archive.on("end", () => resolve(Buffer.concat(chunks)))
    archive.on("error", reject)

    // Adiciona arquivos ao ZIP
    archive.append(gerarCodigoBot(opts),        { name: "index.js" })
    archive.append(gerarPackageJson(opts.botName), { name: "package.json" })
    archive.append(gerarReadme(opts.botName, opts.ownerNumber, opts.prefix), { name: "README.md" })
    archive.append("auth/\n", { name: ".gitkeep" }) // placeholder para pasta auth

    archive.finalize()
  })
}

module.exports = { criarZipBot }
