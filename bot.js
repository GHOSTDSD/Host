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

if(!fs.existsSync(BASE)) fs.mkdirSync(BASE)

const runningBots = {}

let PORT_BASE = 4000
const ports = new Set()

function getPort(){
while(ports.has(PORT_BASE)){
PORT_BASE++
}
ports.add(PORT_BASE)
return PORT_BASE
}

function freePort(p){
ports.delete(p)
}

function terminalHTML(id){
return `
<html>
<head>
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

function installModule(module,dir,id){

return new Promise(resolve=>{

const p=spawn("npm",["install",module],{
cwd:dir,
shell:true
})

p.stdout.on("data",d=>{
io.emit(`log-${id}`,d.toString())
})

p.on("exit",()=>resolve())

})

}

function startBot(id,dir){

const port=getPort()

const env={
...process.env,
PORT:port
}

function run(){

const files=fs.readdirSync(dir)

let main=files.find(f=>["index.js","bot.js","main.js","start.js"].includes(f))

if(!main && fs.existsSync(path.join(dir,"src/index.js"))){
main="src/index.js"
}

const proc=spawn("node",[main],{
cwd:dir,
shell:true,
env
})

runningBots[id]={proc,port}

proc.stdout.on("data",d=>{
io.emit(`log-${id}`,d.toString())
})

proc.stderr.on("data",async d=>{

const text=d.toString()

io.emit(`log-${id}`,text)

if(text.includes("Cannot find module")){

const module=text.split("Cannot find module '")[1].split("'")[0]

io.emit(`log-${id}`,`Instalando módulo ${module}\n`)

await installModule(module,dir,id)

run()

}

})

proc.on("exit",()=>{

freePort(port)

setTimeout(()=>{
run()
},5000)

})

}

run()

}

bot.onText(/\/start/,msg=>{
bot.sendMessage(msg.chat.id,"Envie o ZIP do bot")
})

bot.on("document",async msg=>{

if(!msg.document.file_name.endsWith(".zip")){
bot.sendMessage(msg.chat.id,"Envie um .zip")
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
Terminal: http://localhost:${PORT}/terminal/${id}`)

})

})

})

})

server.listen(PORT)
