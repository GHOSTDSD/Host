const TelegramBot = require("node-telegram-bot-api")
const unzipper = require("unzipper")
const { spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")
const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const https = require("https")

const TOKEN = process.env.BOT_TOKEN || "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM"
const PORT = process.env.PORT || 3000
const DOMAIN = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://localhost:${PORT}`

const bot = new TelegramBot(TOKEN,{ polling:true })
const app = express()
const server = http.createServer(app)
const io = socketIo(server)

app.use(express.json())

const BASE_PATH = path.resolve(process.cwd(),"instances")
if(!fs.existsSync(BASE_PATH)) fs.mkdirSync(BASE_PATH,{ recursive:true })

const activeBots = {}

const aresBanner = () => {

console.clear()

const up = process.uptime().toFixed(0)
const ram = ((os.totalmem()-os.freemem())/1024/1024).toFixed(0)

console.log(`
┌───────────────────────────────────────────┐
│ ARES HOSTING SYSTEM                       │
├───────────────────────────────────────────┤
│ BOTS   : ${Object.keys(activeBots).length}
│ RAM    : ${ram} MB
│ UPTIME : ${up}s
└───────────────────────────────────────────┘
`)

}

const getTerminalHTML = (botId) => `
<!DOCTYPE html>
<html>
<head>
<title>ARES | ${botId}</title>
<script src="/socket.io/socket.io.js"></script>
<style>
body{background:#000;color:#0f0;font-family:monospace;margin:0;display:flex;flex-direction:column;height:100vh}
header{background:#0a0a0a;padding:15px;border-bottom:1px solid #111;display:flex;justify-content:space-between;font-size:12px}
#log{flex:1;overflow-y:auto;padding:20px;white-space:pre-wrap;line-height:1.4;font-size:13px}
</style>
</head>
<body>
<header><div>TERMINAL ${botId}</div></header>
<div id="log"></div>
<script>
const socket = io()
const log = document.getElementById("log")
socket.on("log-${botId}",d=>{
log.innerText += d
log.scrollTop = log.scrollHeight
})
</script>
</body>
</html>
`

app.get("/terminal/:botId",(req,res)=>res.send(getTerminalHTML(req.params.botId)))

function spawnBot(botId,instancePath){

const files = fs.readdirSync(instancePath)
const main = files.find(f => ["index.js","main.js","bot.js","start.js"].includes(f))

const env = {...process.env}
delete env.PORT
delete env.PORT0
delete env.PORT1
delete env.PORT2

const handleProcess = (child)=>{

activeBots[botId] = { process:child }

const logFile = path.join(instancePath,"terminal.log")

child.stdout.on("data",d=>{
fs.appendFileSync(logFile,d.toString())
io.emit(`log-${botId}`,d.toString())
})

child.stderr.on("data",d=>{
fs.appendFileSync(logFile,d.toString())
io.emit(`log-${botId}`,d.toString())
})

child.on("exit",()=>{
delete activeBots[botId]
aresBanner()
})

}

if(main){

io.emit(`log-${botId}`,`[SISTEMA] Iniciando ${main}\n`)

handleProcess(
spawn("node",[main],{
cwd:instancePath,
shell:true,
env
})
)

}

else if(fs.existsSync(path.join(instancePath,"package.json"))){

io.emit(`log-${botId}`,"[SISTEMA] Instalando dependências\n")

const inst = spawn("npm",["install"],{
cwd:instancePath,
shell:true,
env
})

inst.stdout.on("data",d=>io.emit(`log-${botId}`,d.toString()))

inst.on("exit",()=>{

io.emit(`log-${botId}`,"[SISTEMA] Iniciando npm start\n")

handleProcess(
spawn("npm",["start"],{
cwd:instancePath,
shell:true,
env
})
)

})

}

}

bot.onText(/\/start/,msg=>{

bot.sendMessage(msg.chat.id,
`ARES HOSTING

Envie o arquivo ZIP do seu bot`
)

})

bot.on("document",async msg=>{

if(!msg.document.file_name.toLowerCase().endsWith(".zip")){
bot.sendMessage(msg.chat.id,"Envie apenas .zip")
return
}

const botId = `bot_${Date.now()}`
const instancePath = path.join(BASE_PATH,botId)

fs.mkdirSync(instancePath,{recursive:true})

bot.sendMessage(msg.chat.id,"Baixando arquivo")

const file = await bot.getFile(msg.document.file_id)

const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`

const zipPath = path.join(instancePath,"bot.zip")

const fileStream = fs.createWriteStream(zipPath)

https.get(url,response=>{

response.pipe(fileStream)

fileStream.on("finish",()=>{

fileStream.close()

bot.sendMessage(msg.chat.id,"Extraindo bot")

fs.createReadStream(zipPath)
.pipe(unzipper.Extract({path:instancePath}))
.on("close",()=>{

bot.sendMessage(msg.chat.id,"Iniciando bot")

spawnBot(botId,instancePath)

const termLink = `${DOMAIN}/terminal/${botId}`

bot.sendMessage(msg.chat.id,
`Bot criado

ID: ${botId}`,
{
reply_markup:{
inline_keyboard:[
[{text:"Terminal",url:termLink}],
[
{text:"Reiniciar",callback_data:`restart:${botId}:${instancePath}`},
{text:"Parar",callback_data:`stop:${botId}`}
]
]
}
})

})

})

})

})

bot.on("callback_query",query=>{

const [action,botId,instancePath] = query.data.split(":")

if(action === "stop" && activeBots[botId]){

activeBots[botId].process.kill("SIGKILL")

delete activeBots[botId]

bot.answerCallbackQuery(query.id,{text:"Bot parado"})

}

else if(action === "restart"){

if(activeBots[botId]){

activeBots[botId].process.kill("SIGKILL")

delete activeBots[botId]

}

bot.answerCallbackQuery(query.id,{text:"Reiniciando..."})

setTimeout(()=>{
spawnBot(botId,instancePath)
},3000)

}

else{

bot.answerCallbackQuery(query.id)

}

})

server.listen(PORT,()=>aresBanner())
