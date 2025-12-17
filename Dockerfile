# Usar imagem com suporte a Puppeteer/Chrome
FROM node:20-slim

# Instalar dependências do Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libnss3 \
    libnspr4 \
    libglib2.0-0 \
    dbus \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser

# Configurar Puppeteer para usar Chromium instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiar package.json e package-lock.json
COPY package*.json ./

# Instalar dependências
RUN npm ci --only=production

# Copiar o resto dos arquivos
COPY . .

# Criar pasta para sessão do WhatsApp com permissões
RUN mkdir -p .wwebjs_auth && chmod -R 777 .wwebjs_auth

# Ajustar permissões
RUN chown -R pptruser:pptruser /app

# Usar usuário não-root
USER pptruser

# Expor a porta
EXPOSE 3000

# Variável de ambiente para produção
ENV NODE_ENV=production

# Comando para iniciar
CMD ["node", "server.js"]
