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

  initialize() {
    if (this.client) {
      this.addLog('Cliente já existe, destruindo antes de reinicializar...');
      this.client.destroy().catch(() => {});
    }

    this.status = 'connecting';
    this.qrCode = null;
    this.emitToAdmins('whatsapp:status', { status: this.status, qrCode: null });
    this.addLog('Inicializando cliente WhatsApp...');

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
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
      this.addLog('WhatsApp conectado e pronto!');
      this.emitToAdmins('whatsapp:status', { status: 'connected', qrCode: null });
    });

    // Evento: Desconectado
    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.qrCode = null;
      this.addLog(`Desconectado: ${reason}`);
      this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
    });

    // Evento: Falha na autenticação
    this.client.on('auth_failure', (msg) => {
      this.status = 'disconnected';
      this.addLog(`Falha na autenticação: ${msg}`);
      this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
    });

    // Evento: Mensagem recebida (para respostas)
    this.client.on('message', async (msg) => {
      // Emitir para processamento de respostas
      if (this.io) {
        this.io.emit('whatsapp:incoming_message', {
          from: msg.from.replace('@c.us', ''),
          body: msg.body,
          timestamp: msg.timestamp
        });
      }
      this.addLog(`Mensagem recebida de ${msg.from}`);
    });

    // Inicializar cliente
    this.client.initialize().catch(err => {
      this.status = 'disconnected';
      this.addLog(`Erro ao inicializar: ${err.message}`);
      this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
    });
  }

  async sendMessage(phone, message) {
    if (this.status !== 'connected') {
      throw new Error('WhatsApp não está conectado. Acesse o painel admin para conectar.');
    }

    // Formatar número: remover caracteres não numéricos e adicionar @c.us
    const cleanPhone = phone.replace(/\D/g, '');
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
    if (this.client) {
      this.addLog('Desconectando WhatsApp...');
      try {
        await this.client.destroy();
        this.status = 'disconnected';
        this.qrCode = null;
        this.client = null;
        this.addLog('WhatsApp desconectado com sucesso');
        this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
      } catch (err) {
        this.addLog(`Erro ao desconectar: ${err.message}`);
      }
    }
  }

  async reconnect() {
    this.addLog('Reconectando WhatsApp...');
    await this.disconnect();
    // Aguardar um pouco antes de reconectar
    await new Promise(resolve => setTimeout(resolve, 2000));
    this.initialize();
  }

  async logout() {
    if (this.client) {
      this.addLog('Fazendo logout do WhatsApp...');
      try {
        await this.client.logout();
        this.status = 'disconnected';
        this.qrCode = null;
        this.addLog('Logout realizado - será necessário escanear QR Code novamente');
        this.emitToAdmins('whatsapp:status', { status: 'disconnected', qrCode: null });
      } catch (err) {
        this.addLog(`Erro no logout: ${err.message}`);
      }
    }
  }

  getStatus() {
    return {
      status: this.status,
      qrCode: this.qrCode,
      stats: this.stats,
      logs: this.logs.slice(-20) // Últimos 20 logs
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
