const TelegramBot=require("node-telegram-bot-api")
const unzipper=require("unzipper")
const pty=require("node-pty")
const fs=require("fs")
const path=require("path")
const os=require("os")
const express=require("express")
const http=require("http")
const socketIo=require("socket.io")
const https=require("https")
const {EventEmitter}=require("events")

EventEmitter.defaultMaxListeners=200

const TOKEN="8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM"
const PORT=process.env.PORT||3000
const DOMAIN=process.env.RAILWAY_STATIC_URL?`https://${process.env.RAILWAY_STATIC_URL}`:`http://localhost:${PORT}`

const bot=new TelegramBot(TOKEN,{polling:true})
const app=express()
const server=http.createServer(app)
const io=socketIo(server)

io.sockets.setMaxListeners(200)
app.use(express.json())

const BASE_PATH=path.resolve(process.cwd(),"instances")
if(!fs.existsSync(BASE_PATH))fs.mkdirSync(BASE_PATH,{recursive:true})

const activeBots={}
const userState={}
const usedPorts=new Set()
let PORT_START=4000

function generateBotId(){
return"bot_"+Date.now()+"_"+Math.floor(Math.random()*9999)
}

function getFreePort(){
for(let p=PORT_START;p<8000;p++){
if(!usedPorts.has(p)){
usedPorts.add(p)
return p
}}
return Math.floor(Math.random()*1000)+9000
}

function releasePort(port){
usedPorts.delete(port)
}

function aresBanner(){
process.stdout.write('\x1Bc')
const up=process.uptime().toFixed(0)
const ram=(process.memoryUsage().rss/1024/1024).toFixed(0)
console.log(`
🚀 ARES HOST
📦 BOTS DISCO: ${fs.readdirSync(BASE_PATH).length}
🟢 BOTS ONLINE: ${Object.keys(activeBots).length}
💾 RAM: ${ram}MB
⏱ UPTIME: ${up}s
`)
}

function writeLog(botId,instancePath,data){
const logPath=path.join(instancePath,"terminal.log")
if(!fs.existsSync(logPath))fs.writeFileSync(logPath,"")
fs.appendFileSync(logPath,data)
io.emit("log-"+botId,data.toString())
}

function detectStart(instancePath){

const pkg=path.join(instancePath,"package.json")

if(fs.existsSync(pkg)){
try{
const json=JSON.parse(fs.readFileSync(pkg,"utf8"))
if(json.scripts&&json.scripts.start){
return{cmd:os.platform()==="win32"?"npm.cmd":"npm",args:["start"]}
}
}catch(e){}
}

const files=fs.readdirSync(instancePath)

if(files.includes("index.js"))return{cmd:"node",args:["index.js"]}
if(files.includes("main.js"))return{cmd:"node",args:["main.js"]}
if(files.includes("bot.js"))return{cmd:"node",args:["bot.js"]}
if(files.includes("server.js"))return{cmd:"node",args:["server.js"]}
if(files.includes("app.js"))return{cmd:"node",args:["app.js"]}
if(files.includes("start.sh"))return{cmd:"bash",args:["start.sh"]}
if(files.includes("run.sh"))return{cmd:"bash",args:["run.sh"]}
if(files.includes("main.py"))return{cmd:"python",args:["main.py"]}
if(files.includes("bot.py"))return{cmd:"python",args:["bot.py"]}

if(fs.existsSync(path.join(instancePath,"src/index.js")))return{cmd:"node",args:["src/index.js"]}

return null
}

function spawnBot(botId,instancePath){

if(activeBots[botId])activeBots[botId].process.kill()

const botPort=getFreePort()

const env={
...process.env,
PORT:botPort.toString(),
NODE_ENV:"production",
FORCE_COLOR:"3",
TERM:"xterm-256color"
}

aresBanner()

const start=detectStart(instancePath)

if(!start){
writeLog(botId,instancePath,"❌ Nenhum start detectado\r\n")
return
}

if(fs.existsSync(path.join(instancePath,"package.json"))){

writeLog(botId,instancePath,"📦 Instalando dependências\r\n")

const install=pty.spawn(os.platform()==="win32"?"npm.cmd":"npm",["install","--production"],{
name:"xterm-color",
cols:80,
rows:40,
cwd:instancePath,
env:env
})

install.onData(d=>writeLog(botId,instancePath,d))

install.onExit(()=>{
runInstance(botId,instancePath,botPort,env,start)
})

}else{
runInstance(botId,instancePath,botPort,env,start)
}
}

function runInstance(botId,instancePath,botPort,env,start){

const child=pty.spawn(start.cmd,start.args,{
name:"xterm-color",
cols:80,
rows:40,
cwd:instancePath,
env:env
})

activeBots[botId]={process:child,port:botPort,path:instancePath}

child.onData(d=>writeLog(botId,instancePath,d))

child.onExit(()=>{
releasePort(botPort)
delete activeBots[botId]
aresBanner()
})

aresBanner()
}

io.on("connection",socket=>{
socket.on("input",({botId,data})=>{
const target=activeBots[botId]
if(target)target.process.write(data)
})
})

bot.onText(/\/start/,msg=>{
bot.sendMessage(msg.chat.id,"🚀 ARES HOST\n\nEnvie um ZIP para criar um bot.")
})

bot.on("document",async msg=>{

if(!msg.document.file_name.toLowerCase().endsWith(".zip")){
bot.sendMessage(msg.chat.id,"Envie um arquivo ZIP")
return
}

userState[msg.chat.id]={fileId:msg.document.file_id}

bot.sendMessage(msg.chat.id,"Envie um nome para o bot")
})

bot.on("message",async msg=>{

if(msg.document||msg.text?.startsWith("/"))return

const state=userState[msg.chat.id]

if(state&&state.fileId&&!state.botName){

const name=msg.text.trim().replace(/\s+/g,"_").toLowerCase()
const botId=generateBotId()

const instancePath=path.join(BASE_PATH,botId)

state.botName=name
state.botId=botId

fs.mkdirSync(instancePath,{recursive:true})

const file=await bot.getFile(state.fileId)

const zipPath=path.join(instancePath,"bot.zip")
const fileStream=fs.createWriteStream(zipPath)

https.get(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`,res=>{

res.pipe(fileStream)

fileStream.on("finish",()=>{

fileStream.close()

fs.createReadStream(zipPath)
.pipe(unzipper.Extract({path:instancePath}))
.on("close",()=>{

spawnBot(botId,instancePath)

delete userState[msg.chat.id]

bot.sendMessage(msg.chat.id,`✅ Bot criado\n\n📦 Nome: ${name}\n🆔 ID: ${botId}`)

})

})

}).on("error",()=>{
bot.sendMessage(msg.chat.id,"Erro ao baixar ZIP")
})

}
})

app.get("/terminal/:botId",(req,res)=>{

res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit/lib/xterm-addon-fit.js"></script>
<script src="/socket.io/socket.io.js"></script>

<style>
body{margin:0;background:#000;height:100vh;display:flex;flex-direction:column}
#header{background:#111;color:#0f0;padding:8px;font-family:monospace}
#terminal{flex:1}
</style>

</head>

<body>

<div id="header">ARES TERMINAL</div>
<div id="terminal"></div>

<script>

const socket=io()

const term=new Terminal({
cursorBlink:true,
theme:{background:"#000",foreground:"#0f0"}
})

const fitAddon=new FitAddon.FitAddon()

term.loadAddon(fitAddon)

term.open(document.getElementById("terminal"))

fitAddon.fit()

window.addEventListener("resize",()=>fitAddon.fit())

const botId="${req.params.botId}"

socket.on("log-"+botId,data=>{
term.write(data)
})

term.onData(data=>{
socket.emit("input",{botId,data})
})

</script>

</body>
</html>
`)
})

app.get("/logs/:botId",(req,res)=>{
const p=path.join(BASE_PATH,req.params.botId,"terminal.log")
if(fs.existsSync(p))res.sendFile(p)
else res.send("")
})

process.on("uncaughtException",err=>{
if(err.code!=="EADDRINUSE")console.error(err)
})

server.listen(PORT,()=>aresBanner())
