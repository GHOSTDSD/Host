# Usando a versão específica do Node.js 24.13.1
FROM node:24.13.1

# Instalando o GIT e ferramentas essenciais
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Criando o diretório do app
WORKDIR /app

# Copiando os arquivos de dependências
COPY package*.json ./

# Instalando dependências
RUN npm install

# Copiando o código fonte
COPY . .

# Criando diretórios necessários
RUN mkdir -p instances && chmod 755 instances

# Expondo a porta
EXPOSE 3000

# Comando para iniciar o Ares com informações de versão
CMD ["sh", "-c", "\
    echo '🚀 ARES HOST - Inicializando...' && \
    echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' && \
    echo '📌 Node.js version:' && \
    node --version && \
    echo '📦 NPM version:' && \
    npm --version && \
    echo '💻 Sistema:' && \
    uname -a && \
    echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' && \
    echo '▶️  Iniciando servidor...' && \
    node bot.js \
"]
