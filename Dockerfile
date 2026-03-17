# Usando Node.js 24 LTS (Alpine - mais leve)
FROM node:24-alpine

# Instalando dependências do sistema necessárias para compilar módulos nativos
# Incluindo py3-setuptools para resolver o erro 'distutils'
RUN apk add --no-cache \
    git \
    python3 \
    py3-setuptools \
    make \
    g++ \
    unzip \
    && rm -rf /var/cache/apk/*

# Criando diretório da aplicação
WORKDIR /app

# Copiando arquivos de dependência primeiro (otimiza cache do Docker)
COPY package*.json ./

# Instalando dependências do Node.js
RUN npm ci --only=production || npm install

# Copiando o código fonte
COPY . .

# Expondo a porta
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["node", "bot.js"]
