# Usando a imagem oficial do Node.js
FROM node:20

# Instalando o GIT e ferramentas essenciais
RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*

# Criando o diretório do app
WORKDIR /app

# Copiando os arquivos do Ares
COPY package*.json ./
RUN npm install

COPY . .

# Expondo a porta
EXPOSE 3000

# Comando para iniciar o Ares
CMD ["node", "index.js"]
