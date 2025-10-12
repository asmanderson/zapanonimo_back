FROM node:20-alpine

WORKDIR /app

# Copiar package.json e package-lock.json
COPY package*.json ./

# Instalar dependências
RUN npm ci --only=production

# Copiar o resto dos arquivos
COPY . .

# Expor a porta
EXPOSE 3000

# Variável de ambiente para produção
ENV NODE_ENV=production

# Comando para iniciar
CMD ["node", "server.js"]
