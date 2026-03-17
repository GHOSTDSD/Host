# Usando a imagem oficial do Node.js 24 LTS (Alpine - mais leve)
FROM node:24-alpine

# Instalando o GIT e ferramentas essenciais para compilar módulos nativos
# Incluindo py3-setuptools que fornece o módulo 'distutils' necessário
RUN apk add --no-cache git python3 py3-setuptools make g++ unzip

# Criando o diretório do app
WORKDIR /app

# Copiando os arquivos de dependência primeiro (otimiza o cache do Docker)
COPY package*.json ./

# Instalando dependências
RUN npm install

# Copiando o resto do código
COPY . .

# Expondo a porta
EXPOSE 3000

# Comando para iniciar o Ares
CMD ["node", "bot.js"]
