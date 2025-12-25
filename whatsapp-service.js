require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

class WhatsAppService {
  constructor() {
    this.client = null;
    this.qrCode = null;
    this.status = 'disconnected'; // disconnected | connecting | connected
    this.io = null;
    this.adminSockets = new Set();
    this.logs = [];
    this.stats = {
      successCount: 0,
      failureCount: 0,
      lastUsed: null
    };

    // Configurações de reconexão
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.baseReconnectDelay = 5000; // 5 segundos
    this.maxReconnectDelay = 300000; // 5 minutos
    this.reconnectTimeout = null;
    this.isInitializing = false;
    this.initTimeout = null;
    this.healthCheckInterval = null;
    this.lastHealthCheck = null;
  }

  setSocketIO(io) {
    this.io = io;
  }

  addLog(message) {
    const log = {
      timestamp: new Date().toISOString(),
      message
    };
    this.logs.push(log);
    // Manter apenas os últimos 100 logs
    if (this.logs.length > 100) {
      this.logs.shift();
    }
    // Emitir log para admins conectados
    this.emitToAdmins('whatsapp:log', log);
    console.log(`[WhatsApp] ${message}`);
  }

  emitToAdmins(event, data) {
    if (this.io) {
      this.adminSockets.forEach(socketId => {
        this.io.to(socketId).emit(event, data);
      });
    }
  }

  subscribeAdmin(socketId) {
    this.adminSockets.add(socketId);
    // Enviar estado atual para o novo admin
    if (this.io) {
      this.io.to(socketId).emit('whatsapp:status', {
        status: this.status,
        qrCode: this.qrCode
      });
      this.io.to(socketId).emit('whatsapp:logs', this.logs);
    }
  }

  unsubscribeAdmin(socketId) {
    this.adminSockets.delete(socketId);
  }

  // Calcular delay com exponential backoff
  getReconnectDelay() {
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    // Adicionar jitter (variação aleatória) para evitar thundering herd
    return delay + Math.random() * 1000;
  }

  // Agendar reconexão automática
  scheduleReconnect(reason = 'desconexão') {
    // Limpar timeout anterior se existir
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.addLog(`Máximo de tentativas de reconexão atingido (${this.maxReconnectAttempts}). Reconexão manual necessária.`);
      this.emitToAdmins('whatsapp:reconnect_failed', {
        reason: 'max_attempts',
        message: 'Número máximo de tentativas atingido. Por favor, reconecte manualmente.'
      });
      return;
    }

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;

    this.addLog(`Agendando reconexão automática em ${Math.round(delay / 1000)}s (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts}) - Motivo: ${reason}`);

    this.reconnectTimeout = setTimeout(async () => {
      this.addLog(`Iniciando tentativa de reconexão ${this.reconnectAttempts}...`);
      await this.initialize();
    }, delay);
  }

  // Cancelar reconexão agendada
  cancelScheduledReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
      this.addLog('Reconexão agendada cancelada');
    }
  }

  // Resetar contador de tentativas
  resetReconnectAttempts() {
    this.reconnectAttempts = 0;
  }

  // Iniciar health check periódico
  startHealthCheck() {
    // Limpar intervalo anterior se existir
    this.stopHealthCheck();

    // Verificar a cada 30 segundos
    this.healthCheckInterval = setInterval(async () => {
      if (this.status === 'connected' && this.client) {
        try {
          // Verificar se o cliente ainda está responsivo
          const state = await Promise.race([
            this.client.getState(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Health check timeout')), 10000)
            )
          ]);

          this.lastHealthCheck = new Date();

          if (state !== 'CONNECTED') {
            this.addLog(`Health check: estado inesperado (${state})`);
            this.status = 'disconnected';
            this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
            this.scheduleReconnect('estado inválido detectado');
          }
        } catch (error) {
          this.addLog(`Health check falhou: ${error.message}`);
          this.status = 'disconnected';
          this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
          this.scheduleReconnect('health check falhou');
        }
      }
    }, 30000);
  }

  // Parar health check
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // Limpar todos os timeouts e intervalos
  cleanup() {
    this.cancelScheduledReconnect();
    this.stopHealthCheck();
    if (this.initTimeout) {
      clearTimeout(this.initTimeout);
      this.initTimeout = null;
    }
  }

  async initialize() {
    // Evitar múltiplas inicializações simultâneas
    if (this.isInitializing) {
      this.addLog('Inicialização já em andamento, ignorando chamada duplicada');
      return;
    }
    this.isInitializing = true;
    this.cleanup(); // Limpar timeouts anteriores

    if (this.client) {
      this.addLog('Cliente já existe, destruindo antes de reinicializar...');
      try {
        await this.client.destroy();
      } catch (err) {
        this.addLog(`Aviso ao destruir cliente anterior: ${err.message}`);
      }
      this.client = null;
    }

    this.status = 'connecting';
    this.qrCode = null;
    this.emitToAdmins('whatsapp:status', { status: this.status, qrCode: null });
    this.addLog('Inicializando cliente WhatsApp...');

    // Timeout de 2 minutos para inicialização
    const INIT_TIMEOUT = 120000;
    this.initTimeout = setTimeout(() => {
      if (this.status === 'connecting') {
        this.addLog('Timeout na inicialização - tempo limite de 2 minutos excedido');
        this.isInitializing = false;
        this.status = 'disconnected';
        this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
        if (this.client) {
          this.client.destroy().catch(() => {});
          this.client = null;
        }
        this.scheduleReconnect('timeout na inicialização');
      }
    }, INIT_TIMEOUT);

    // Configuração do Puppeteer
    const puppeteerConfig = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update'
      ],
      timeout: 60000
    };

    // Usar Chromium do sistema em produção (Fly.io/Docker)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      this.addLog(`Usando Chromium: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
      }),
      puppeteer: puppeteerConfig
    });

    // Evento: QR Code gerado
    this.client.on('qr', async (qr) => {
      this.addLog('QR Code gerado - escaneie com seu WhatsApp');
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.emitToAdmins('whatsapp:qr', this.qrCode);
        this.emitToAdmins('whatsapp:status', { status: 'connecting', qrCode: this.qrCode });
      } catch (err) {
        this.addLog(`Erro ao gerar QR Code: ${err.message}`);
      }
    });

    // Evento: Autenticado
    this.client.on('authenticated', () => {
      this.addLog('Autenticado com sucesso!');
      this.qrCode = null;
    });

    // Evento: Pronto para usar
    this.client.on('ready', () => {
      this.status = 'connected';
      this.qrCode = null;
      this.isInitializing = false;

      // Limpar timeout de inicialização
      if (this.initTimeout) {
        clearTimeout(this.initTimeout);
        this.initTimeout = null;
      }

      // Resetar tentativas de reconexão após sucesso
      this.resetReconnectAttempts();

      // Iniciar health check
      this.startHealthCheck();

      this.addLog('WhatsApp conectado e pronto!');
      this.emitToAdmins('whatsapp:status', { status: 'connected', qrCode: null });
    });

    // Evento: Desconectado
    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.qrCode = null;
      this.isInitializing = false;
      this.client = null;

      // Parar health check
      this.stopHealthCheck();

      this.addLog(`Desconectado: ${reason}`);
      this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });

      // Agendar reconexão automática (exceto logout manual)
      if (reason !== 'LOGOUT') {
        this.scheduleReconnect(reason);
      }
    });

    // Evento: Falha na autenticação
    this.client.on('auth_failure', (msg) => {
      this.status = 'disconnected';
      this.isInitializing = false;
      this.addLog(`Falha na autenticação: ${msg}`);
      this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });

      // Agendar reconexão (pode precisar escanear QR novamente)
      this.scheduleReconnect('falha na autenticação');
    });

    // Evento: Mensagem recebida (para respostas)
    this.client.on('message', async (msg) => {
      try {
        // Ignorar mensagens de grupo e mensagens próprias
        if (msg.from.includes('@g.us') || msg.fromMe) {
          return;
        }

        const fromPhone = msg.from.replace('@c.us', '').replace('@s.whatsapp.net', '');
        const messageText = msg.body;

        this.addLog(`Mensagem recebida de ${fromPhone}: ${messageText.substring(0, 50)}...`);

        // Salvar resposta no banco de dados
        const { saveReplyFromWebhook } = require('./database');
        const result = await saveReplyFromWebhook(fromPhone, messageText, 'whatsapp');

        if (result && this.io) {
          // Emitir notificação em tempo real para o usuário
          this.io.emit('new-reply', {
            ...result.reply,
            original_message: result.originalMessage.message
          });
          this.addLog(`Resposta salva para usuário ${result.originalMessage.user_id}`);
        }
      } catch (error) {
        this.addLog(`Erro ao processar mensagem: ${error.message}`);
      }
    });

    // Inicializar cliente
    this.client.initialize().catch(err => {
      this.status = 'disconnected';
      this.isInitializing = false;

      // Limpar timeout de inicialização
      if (this.initTimeout) {
        clearTimeout(this.initTimeout);
        this.initTimeout = null;
      }

      this.addLog(`Erro ao inicializar: ${err.message}`);
      this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });

      // Agendar reconexão automática
      this.scheduleReconnect(`erro: ${err.message}`);
    });
  }

  async sendMessage(phone, message) {
    if (this.status !== 'connected') {
      throw new Error('WhatsApp não está conectado. Acesse o painel admin para conectar.');
    }

    // Formatar número: remover caracteres não numéricos
    let cleanPhone = phone.replace(/\D/g, '');

    // Garantir que tem código do país (Brasil = 55)
    if (cleanPhone.length === 11 || cleanPhone.length === 10) {
      cleanPhone = '55' + cleanPhone;
    }

    // Validar formato
    if (cleanPhone.length < 12 || cleanPhone.length > 13) {
      throw new Error(`Número inválido: ${cleanPhone}. Use formato: 5511999999999`);
    }

    const chatId = `${cleanPhone}@c.us`;

    try {
      const result = await this.client.sendMessage(chatId, message);
      this.stats.successCount++;
      this.stats.lastUsed = new Date();
      this.addLog(`Mensagem enviada para ${cleanPhone}`);

      return {
        success: true,
        data: { messageId: result.id._serialized },
        tokenUsed: 1,
        attempts: 1
      };
    } catch (error) {
      this.stats.failureCount++;
      this.addLog(`Erro ao enviar para ${cleanPhone}: ${error.message}`);
      throw new Error(`Falha ao enviar mensagem: ${error.message}`);
    }
  }

  async disconnect() {
    // Limpar todos os timeouts e intervalos
    this.cleanup();

    if (this.client) {
      this.addLog('Desconectando WhatsApp...');
      try {
        await this.client.destroy();
        this.status = 'disconnected';
        this.qrCode = null;
        this.client = null;
        this.isInitializing = false;
        this.addLog('WhatsApp desconectado com sucesso');
        this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
      } catch (err) {
        this.addLog(`Erro ao desconectar: ${err.message}`);
        // Forçar reset do estado mesmo com erro
        this.status = 'disconnected';
        this.client = null;
        this.isInitializing = false;
      }
    }
  }

  async reconnect() {
    this.addLog('Reconectando WhatsApp manualmente...');

    // Resetar tentativas ao reconectar manualmente
    this.resetReconnectAttempts();

    await this.disconnect();
    // Aguardar um pouco antes de reconectar
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.initialize();
  }

  async logout() {
    // Cancelar reconexão automática pois é logout intencional
    this.cancelScheduledReconnect();
    this.resetReconnectAttempts();
    this.stopHealthCheck();

    if (this.client) {
      this.addLog('Fazendo logout do WhatsApp...');
      try {
        await this.client.logout();
        this.status = 'disconnected';
        this.qrCode = null;
        this.client = null;
        this.isInitializing = false;
        this.addLog('Logout realizado - será necessário escanear QR Code novamente');
        this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
      } catch (err) {
        this.addLog(`Erro no logout: ${err.message}`);
        // Forçar reset do estado mesmo com erro
        this.status = 'disconnected';
        this.client = null;
        this.isInitializing = false;
      }
    }
  }

  getStatus() {
    return {
      status: this.status,
      qrCode: this.qrCode,
      stats: this.stats,
      logs: this.logs.slice(-20), // Últimos 20 logs
      reconnect: {
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
        isScheduled: !!this.reconnectTimeout,
        lastHealthCheck: this.lastHealthCheck
      }
    };
  }

  getStats() {
    return [{
      tokenNumber: 1,
      tokenPreview: 'whatsapp-web.js',
      available: this.status === 'connected',
      successCount: this.stats.successCount,
      failureCount: this.stats.failureCount,
      lastUsed: this.stats.lastUsed
    }];
  }

  // Método de compatibilidade com código antigo
  async testAllTokens(testPhone, testMessage) {
    try {
      const result = await this.sendMessage(testPhone, testMessage);
      return [{
        tokenNumber: 1,
        status: 'OK',
        response: result
      }];
    } catch (error) {
      return [{
        tokenNumber: 1,
        status: 'ERRO',
        error: error.message
      }];
    }
  }
}

let instance = null;

function getWhatsAppService() {
  if (!instance) {
    instance = new WhatsAppService();
  }
  return instance;
}

module.exports = {
  getWhatsAppService,
  WhatsAppService
};
