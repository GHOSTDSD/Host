const TelegramBot = require("node-telegram-bot-api")
const unzipper = require("unzipper")
const { spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const https = require("https")

const TOKEN = "8588565134:AAFez1RxFHhsUm1j7-spZxh4gCfiKxuqoeM"
const PORT = process.env.PORT || 3000

const bot = new TelegramBot(TOKEN,{polling:true})

const app = express()
const server = http.createServer(app)
const io = socketIo(server)

const BASE = path.resolve("instances")

if(!fs.existsSync(BASE)){
fs.mkdirSync(BASE)
}

const bots = {}

let portBase = 4000
const usedPorts = new Set()

function getPort(){
while(usedPorts.has(portBase)){
portBase++
}
usedPorts.add(portBase)
return portBase
}

function freePort(p){
usedPorts.delete(p)
}

function terminalHTML(id){
return `
<html>
<head>
<title>Terminal ${id}</title>
<script src="/socket.io/socket.io.js"></script>
<style>
body{background:#000;color:#0f0;font-family:monospace}
#log{white-space:pre-wrap}
</style>
</head>
<body>
<div id="log"></div>
<script>
const socket=io()
const log=document.getElementById("log")
socket.on("log-${id}",d=>{
log.innerText+=d
window.scrollTo(0,document.body.scrollHeight)
})
</script>
</body>
</html>
`
}

app.get("/terminal/:id",(req,res)=>{
res.send(terminalHTML(req.params.id))
})

function startBot(id,dir){

const files = fs.readdirSync(dir)

let main = files.find(f=>["index.js","main.js","bot.js","start.js"].includes(f))

if(!main && fs.existsSync(path.join(dir,"src/index.js"))){
main="src/index.js"
}

if(!main){
io.emit(`log-${id}`,"Arquivo principal não encontrado\n")
return
}

const port = getPort()

const env = {
...process.env,
PORT:port
}

const logFile = path.join(dir,"terminal.log")

function run(){

const install = spawn("npm",["install"],{
cwd:dir,
shell:true,
env
})

install.stdout.on("data",d=>{
fs.appendFileSync(logFile,d.toString())
io.emit(`log-${id}`,d.toString())
})

install.stderr.on("data",d=>{
fs.appendFileSync(logFile,d.toString())
io.emit(`log-${id}`,d.toString())
})

install.on("exit",()=>{

const proc = spawn("node",[main],{
cwd:dir,
shell:true,
env
})

bots[id]={proc,port}

proc.stdout.on("data",d=>{
fs.appendFileSync(logFile,d.toString())
io.emit(`log-${id}`,d.toString())
})

proc.stderr.on("data",d=>{
fs.appendFileSync(logFile,d.toString())
io.emit(`log-${id}`,d.toString())
})

proc.on("exit",()=>{

freePort(port)

setTimeout(()=>{
run()
},5000)

})

})

}

run()

}

bot.onText(/\/start/,msg=>{

bot.sendMessage(msg.chat.id,
`ARES BOT HOST

Envie o ZIP do bot`
)

})

bot.on("document",async msg=>{

if(!msg.document.file_name.endsWith(".zip")){
bot.sendMessage(msg.chat.id,"Envie um arquivo .zip")
return
}

const id="bot_"+Date.now()

const dir=path.join(BASE,id)

fs.mkdirSync(dir)

const file=await bot.getFile(msg.document.file_id)

const url=`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`

const zip=path.join(dir,"bot.zip")

const stream=fs.createWriteStream(zip)

https.get(url,res=>{

res.pipe(stream)

stream.on("finish",()=>{

stream.close()

fs.createReadStream(zip)
.pipe(unzipper.Extract({path:dir}))
.on("close",()=>{

startBot(id,dir)

bot.sendMessage(msg.chat.id,
`Bot iniciado

ID: ${id}

Terminal:
http://localhost:${PORT}/terminal/${id}`
)

})

})

})

})

server.listen(PORT,()=>{
console.log("ARES HOST ONLINE")
})
