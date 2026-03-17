# Usando a imagem oficial do Node.js 25 (latest)
FROM node:25-alpine

# Instalando o GIT e ferramentas essenciais (versão Alpine)
RUN apk add --no-cache git python3 make g++ unzip

# Criando o diretório do app
WORKDIR /app

# Copiando os arquivos do Ares
COPY package*.json ./

# Instalando dependências
RUN npm install -g npm@latest && npm install

COPY . .

# Expondo a porta
EXPOSE 3000

# Comando para iniciar o Ares
CMD ["node", "bot.js"]
