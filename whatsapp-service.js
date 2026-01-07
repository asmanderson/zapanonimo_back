require('dotenv').config();

const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { DatabaseSessionStore } = require('./session-store');
const { getWhatsAppStats, saveWhatsAppStats } = require('./database');
const { uploadAudio } = require('./supabase-store');

class WhatsAppService {
  constructor() {
    this.client = null;
    this.qrCode = null;
    this._status = 'disconnected'; 
    this.io = null;
    this.adminSockets = new Set();
    this.logs = [];
    this.stats = {
      successCount: 0,
      failureCount: 0,
      lastUsed: null,
      _lastUpdate: Date.now() 
    };
    this._statsLoaded = false;
    this._statsSaveTimeout = null;
    this._qrCodeDelayTimeout = null;
    this._showQrCode = false; 


    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.baseReconnectDelay = 5000;
    this.maxReconnectDelay = 300000;
    this.reconnectTimeout = null;
    this.isInitializing = false;
    this.initTimeout = null;
    this.healthCheckInterval = null;
    this.lastHealthCheck = null;


    this.lastStatusUpdate = 0;
    this.statusUpdateDebounce = 1000; 
    this.pendingStatusEmit = null;
  }


  get status() {
    return this._status;
  }

 
  set status(newStatus) {
    const validStatuses = ['disconnected', 'connecting', 'connected'];
    if (!validStatuses.includes(newStatus)) {
      this.addLog(`Status inválido ignorado: ${newStatus}`);
      return;
    }

  
    if (this._status === 'connected' && newStatus === 'connecting') {
      this.addLog(`Transição inválida de connected para connecting ignorada`);
      return;
    }

    const oldStatus = this._status;
    if (oldStatus !== newStatus) {
      this._status = newStatus;
      this.addLog(`Status alterado: ${oldStatus} -> ${newStatus}`);
    }
  }

  setSocketIO(io) {
    this.io = io;
  }

  
  async loadStats() {
    if (this._statsLoaded) return;

    try {
      const savedStats = await getWhatsAppStats();
      if (savedStats) {
        this.stats.successCount = savedStats.successCount || 0;
        this.stats.failureCount = savedStats.failureCount || 0;
        this.stats.lastUsed = savedStats.lastUsed || null;
        this.stats._lastUpdate = Date.now();
        this._statsLoaded = true;
        this.addLog(`Stats carregados do banco: ${this.stats.successCount} enviadas, ${this.stats.failureCount} falhas`);
      }
    } catch (error) {
      this.addLog(`Erro ao carregar stats do banco: ${error.message}`);
    }
  }


  saveStats(includeStatus = false) {
 
    if (this._statsSaveTimeout) {
      clearTimeout(this._statsSaveTimeout);
    }

 
    this._statsSaveTimeout = setTimeout(async () => {
      try {
        const status = includeStatus ? this._status : null;
        await saveWhatsAppStats(this.stats, status);
      } catch (error) {
        console.error(`[WhatsApp] Erro ao salvar stats no banco: ${error.message}`);
      }
    }, 5000); 
  }


  async saveStatusNow() {
    try {
      await saveWhatsAppStats(this.stats, this._status);
    } catch (error) {
      console.error(`[WhatsApp] Erro ao salvar status no banco: ${error.message}`);
    }
  }

  addLog(message) {
    const log = {
      timestamp: new Date().toISOString(),
      message
    };
    this.logs.push(log);

    if (this.logs.length > 100) {
      this.logs.shift();
    }
  
    this.emitToAdmins('whatsapp:log', log);
  }

  emitToAdmins(event, data) {
    if (!this.io) return;


    if (event === 'whatsapp:status') {
      const now = Date.now();

    
      if (this.pendingStatusEmit) {
        clearTimeout(this.pendingStatusEmit);
        this.pendingStatusEmit = null;
      }

    
      if (now - this.lastStatusUpdate >= this.statusUpdateDebounce) {
        this.lastStatusUpdate = now;
        this.adminSockets.forEach(socketId => {
          this.io.to(socketId).emit(event, data);
        });
      } else {
  
        this.pendingStatusEmit = setTimeout(() => {
          this.lastStatusUpdate = Date.now();
          this.adminSockets.forEach(socketId => {
            this.io.to(socketId).emit(event, data);
          });
          this.pendingStatusEmit = null;
        }, this.statusUpdateDebounce);
      }
    } else {

      this.adminSockets.forEach(socketId => {
        this.io.to(socketId).emit(event, data);
      });
    }
  }


  emitStatusUpdate(overrideStatus = null, overrideQrCode = undefined) {
    const statusData = {
      status: overrideStatus !== null ? overrideStatus : this._status,
      qrCode: overrideQrCode !== undefined ? overrideQrCode : this.qrCode,
      stats: { ...this.stats },
      _timestamp: Date.now() 
    };
    this.emitToAdmins('whatsapp:status', statusData);
  }

  subscribeAdmin(socketId) {
    this.adminSockets.add(socketId);

    if (this.io) {
      this.io.to(socketId).emit('whatsapp:logs', this.logs);
    }
  }

  unsubscribeAdmin(socketId) {
    this.adminSockets.delete(socketId);
  }


  getReconnectDelay() {
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
 
    return delay + Math.random() * 1000;
  }


  scheduleReconnect(reason = 'desconexão') {
 
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


  cancelScheduledReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
      this.addLog('Reconexão agendada cancelada');
    }
  }

  resetReconnectAttempts() {
    this.reconnectAttempts = 0;
  }


  startHealthCheck() {

    this.stopHealthCheck();

 
    this.healthCheckFailures = 0;
    const maxHealthCheckFailures = 3; 

   
    this.healthCheckInterval = setInterval(async () => {
    
      if (this._status === 'connected' && this.client && !this.isInitializing) {
        try {
     
          const state = await Promise.race([
            this.client.getState(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Health check timeout')), 45000)
            )
          ]);

          this.lastHealthCheck = new Date();

          if (state === 'CONNECTED') {
       
            this.healthCheckFailures = 0;
          } else {
            this.healthCheckFailures++;
            this.addLog(`Health check: estado inesperado (${state}) - falha ${this.healthCheckFailures}/${maxHealthCheckFailures}`);

            if (this.healthCheckFailures >= maxHealthCheckFailures) {
              this._status = 'disconnected';
              this.qrCode = null;
              this.emitStatusUpdate();
              this.scheduleReconnect('estado inválido persistente');
              this.healthCheckFailures = 0;
            }
          }
        } catch (error) {
          this.healthCheckFailures++;
          this.addLog(`Health check falhou: ${error.message} - falha ${this.healthCheckFailures}/${maxHealthCheckFailures}`);

       
          if (this.healthCheckFailures >= maxHealthCheckFailures) {
            this._status = 'disconnected';
            this.qrCode = null;
            this.emitStatusUpdate();
            this.scheduleReconnect('health check falhou repetidamente');
            this.healthCheckFailures = 0;
          }
        }
      }
    }, 120000); 
  }


  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

 
  cleanup() {
    this.cancelScheduledReconnect();
    this.stopHealthCheck();
    if (this.initTimeout) {
      clearTimeout(this.initTimeout);
      this.initTimeout = null;
    }
    if (this._qrCodeDelayTimeout) {
      clearTimeout(this._qrCodeDelayTimeout);
      this._qrCodeDelayTimeout = null;
    }
    if (this._statsSaveTimeout) {
      clearTimeout(this._statsSaveTimeout);
      this._statsSaveTimeout = null;
    }
  }

  async initialize() {

    if (this.isInitializing) {
      this.addLog('Inicialização já em andamento, ignorando chamada duplicada');
      return;
    }
    this.isInitializing = true;
    this.cleanup(); 

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
    this._showQrCode = false; 
    this.emitStatusUpdate();
    this.addLog('Inicializando cliente WhatsApp...');

    if (this._qrCodeDelayTimeout) {
      clearTimeout(this._qrCodeDelayTimeout);
    }
    this._qrCodeDelayTimeout = setTimeout(() => {
      if (this._status !== 'connected') {
        this._showQrCode = true;
        this.addLog('QR Code habilitado para exibição');
 
        if (this.qrCode) {
          this.emitToAdmins('whatsapp:qr', this.qrCode);
          this.emitStatusUpdate('connecting');
        }
      }
    }, 8000); 


    const INIT_TIMEOUT = 300000;
    this.initTimeout = setTimeout(() => {
      if (this.status === 'connecting') {
        this.addLog('Timeout na inicialização - tempo limite de 5 minutos excedido');
        this.isInitializing = false;
        this.status = 'disconnected';
        this.qrCode = null;
        this.emitStatusUpdate();
        if (this.client) {
          this.client.destroy().catch(() => {});
          this.client = null;
        }
        this.scheduleReconnect('timeout na inicialização');
      }
    }, INIT_TIMEOUT);

  
    const isDocker = process.env.NODE_ENV === 'production' || process.env.PUPPETEER_EXECUTABLE_PATH;

    const puppeteerConfig = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',

        ...(isDocker ? [
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--single-process'
        ] : [])
      ]
    };

  
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      this.addLog(`Usando Chromium: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }

   
    const store = new DatabaseSessionStore({ sessionId: 'whatsapp-main' });

    this.client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000, 
        dataPath: './.wwebjs_auth'
      }),
      puppeteer: puppeteerConfig
    });

   
    this.client.on('qr', async (qr) => {
      this.addLog('QR Code gerado');
      try {
        this.qrCode = await qrcode.toDataURL(qr);
   
        if (this._showQrCode) {
          this.addLog('Exibindo QR Code - escaneie com seu WhatsApp');
          this.emitToAdmins('whatsapp:qr', this.qrCode);
          this.emitStatusUpdate('connecting');
        } else {
          this.addLog('QR Code armazenado (aguardando delay para exibir)');
        }
      } catch (err) {
        this.addLog(`Erro ao gerar QR Code: ${err.message}`);
      }
    });

  
    this.client.on('authenticated', () => {
      this.addLog('Autenticado com sucesso!');
      this.qrCode = null;
      this._showQrCode = false; 
 
      if (this._qrCodeDelayTimeout) {
        clearTimeout(this._qrCodeDelayTimeout);
        this._qrCodeDelayTimeout = null;
      }
    });


    this.client.on('remote_session_saved', () => {
      this.addLog('Sessão salva no Supabase com sucesso!');
    });


    this.client.on('ready', () => {
      this.status = 'connected';
      this.qrCode = null;
      this.isInitializing = false;
      this._showQrCode = false;

     
      if (this.initTimeout) {
        clearTimeout(this.initTimeout);
        this.initTimeout = null;
      }


      if (this._qrCodeDelayTimeout) {
        clearTimeout(this._qrCodeDelayTimeout);
        this._qrCodeDelayTimeout = null;
      }

    
      this.resetReconnectAttempts();

    
      this.startHealthCheck();

      this.addLog('WhatsApp conectado e pronto!');
      this.emitStatusUpdate();

      
      this.saveStatusNow();
    });

  
    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.qrCode = null;
      this.isInitializing = false;
      this._showQrCode = false;
      this.client = null;

   
      if (this._qrCodeDelayTimeout) {
        clearTimeout(this._qrCodeDelayTimeout);
        this._qrCodeDelayTimeout = null;
      }

     
      this.stopHealthCheck();

      this.addLog(`Desconectado: ${reason}`);
      this.emitStatusUpdate();

     
      this.saveStatusNow();

 
      if (reason !== 'LOGOUT') {
        this.scheduleReconnect(reason);
      }
    });

   
    this.client.on('auth_failure', (msg) => {
      this.status = 'disconnected';
      this.qrCode = null;
      this.isInitializing = false;
      this.addLog(`Falha na autenticação: ${msg}`);
      this.emitStatusUpdate();

   
      this.scheduleReconnect('falha na autenticação');
    });

  
    this.client.on('message', async (msg) => {
      try {

        if (msg.from.includes('@g.us') || msg.fromMe) {
          return;
        }

        let messageText = msg.body || '';
        let audioUrl = null;
        let fromPhone = null;
        const originalFrom = msg.from;

        this.addLog(`Recebido de: ${originalFrom}`);

        // Verificar se é mensagem de áudio
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media && (media.mimetype.startsWith('audio/') || media.mimetype === 'audio/ogg; codecs=opus')) {
              this.addLog(`Áudio recebido: ${media.mimetype}`);

              // Upload para Supabase Storage
              const uploadResult = await uploadAudio(media.data, media.mimetype, 'replies');
              if (uploadResult.success) {
                audioUrl = uploadResult.url;
                this.addLog(`Áudio salvo: ${audioUrl}`);

                // Se não tem texto, usar placeholder
                if (!messageText) {
                  messageText = '[Mensagem de áudio]';
                }
              } else {
                this.addLog(`Erro ao salvar áudio: ${uploadResult.error}`);
              }
            }
          } catch (mediaError) {
            this.addLog(`Erro ao processar mídia: ${mediaError.message}`);
          }
        }

   
        if (originalFrom.includes('@lid')) {
          this.addLog(`LID detectado, tentando obter número real...`);

 
          try {
            const contact = await msg.getContact();
            if (contact) {
    
              if (contact.number) {
                fromPhone = contact.number;
                this.addLog(`Número via contact.number: ${fromPhone}`);
              } else if (contact.id?.user && !contact.id.user.includes('@')) {
                fromPhone = contact.id.user;
                this.addLog(`Número via contact.id.user: ${fromPhone}`);
              } else if (contact.id?._serialized) {
                const serialized = contact.id._serialized;
                if (!serialized.includes('@lid')) {
                  fromPhone = serialized.replace('@c.us', '').replace('@s.whatsapp.net', '');
                  this.addLog(`Número via contact.id._serialized: ${fromPhone}`);
                }
              }
            }
          } catch (e) {
            this.addLog(`Erro getContact: ${e.message}`);
          }

    
          if (!fromPhone) {
            try {
              const chat = await msg.getChat();
              if (chat) {
                if (chat.id?.user && !chat.id.user.includes('@')) {
                  fromPhone = chat.id.user;
                  this.addLog(`Número via chat.id.user: ${fromPhone}`);
                } else if (chat.id?._serialized && !chat.id._serialized.includes('@lid')) {
                  fromPhone = chat.id._serialized.replace('@c.us', '').replace('@s.whatsapp.net', '');
                  this.addLog(`Número via chat.id._serialized: ${fromPhone}`);
                }
              }
            } catch (e) {
              this.addLog(`Erro getChat: ${e.message}`);
            }
          }

        
          if (!fromPhone && msg.hasQuotedMsg) {
            try {
              const quotedMsg = await msg.getQuotedMessage();
              if (quotedMsg && quotedMsg.to) {
                fromPhone = quotedMsg.to.replace('@c.us', '').replace('@s.whatsapp.net', '');
                this.addLog(`Número via quotedMsg.to: ${fromPhone}`);
              }
            } catch (e) {
              this.addLog(`Erro getQuotedMessage: ${e.message}`);
            }
          }

    
          if (!fromPhone) {
            fromPhone = originalFrom.replace('@lid', '');
            this.addLog(`Usando LID como fallback: ${fromPhone}`);
          }
        } else {
        
          fromPhone = originalFrom.replace('@c.us', '').replace('@s.whatsapp.net', '');
        }

    
        const isLid = originalFrom.includes('@lid');

        this.addLog(`Mensagem de ${fromPhone} (isLid: ${isLid}): ${messageText.substring(0, 50)}...`);

     
        const { saveReplyFromWebhook } = require('./database');

        this.addLog(`Chamando saveReplyFromWebhook com isLid=${isLid}, audioUrl=${audioUrl ? 'sim' : 'não'}...`);
        const result = await saveReplyFromWebhook(fromPhone, messageText, 'whatsapp', isLid, audioUrl);

        if (result && this.io) {

          const userId = result.originalMessage.user_id.toString();
          this.io.to(`user:${userId}`).emit('new-reply', {
            ...result.reply,
            original_message: result.originalMessage.message,
            audio_url: audioUrl
          });
          this.addLog(`✅ Resposta salva e notificada para usuário ${userId}${audioUrl ? ' (com áudio)' : ''}`);
        } else if (result) {
          this.addLog(`✅ Resposta salva para usuário ${result.originalMessage.user_id}, mas Socket.IO não disponível`);
        } else {
          this.addLog(`❌ Nenhuma mensagem original encontrada para ${fromPhone} (isLid: ${isLid})`);
        }
      } catch (error) {
        this.addLog(`Erro ao processar mensagem: ${error.message}`);
        console.error('[WhatsApp] Erro ao processar mensagem recebida:', error);
      }
    });


    this.client.initialize().catch(err => {
      this.status = 'disconnected';
      this.qrCode = null;
      this.isInitializing = false;

    
      if (this.initTimeout) {
        clearTimeout(this.initTimeout);
        this.initTimeout = null;
      }

      this.addLog(`Erro ao inicializar: ${err.message}`);
      this.emitStatusUpdate();

    
      this.scheduleReconnect(`erro: ${err.message}`);
    });
  }

 
  async isClientReady() {
    if (!this.client) return false;
    if (this._status !== 'connected') return false;

    try {
   
      const state = await this.client.getState();
      return state === 'CONNECTED';
    } catch (error) {
      return false;
    }
  }

 
  async waitForClientReady(maxWaitMs = 10000) {
    const startTime = Date.now();
    const checkInterval = 500; 

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isClientReady()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    return false;
  }

  async sendMessage(phone, message) {
   
    if (!this.client) {
      throw new Error('Sistema temporariamente offline. Tente novamente em alguns minutos.');
    }

    
    if (this._status === 'disconnected') {
      throw new Error('WhatsApp desconectado. Aguarde a reconexão automática ou entre em contato com o suporte.');
    }

    
    let cleanPhone = phone.replace(/\D/g, '');

    
    if (cleanPhone.length === 11 || cleanPhone.length === 10) {
      cleanPhone = '55' + cleanPhone;
    }

  
    if (cleanPhone.length < 12 || cleanPhone.length > 13) {
      throw new Error(`Número inválido: ${cleanPhone}. Use formato: 5511999999999`);
    }

 
    const maxRetries = 3;
    const retryDelay = 2000; 
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {

        if (attempt > 1) {
          this.addLog(`Tentativa ${attempt}/${maxRetries} - aguardando cliente ficar pronto...`);
          await this.waitForClientReady(5000);
        }

  
        const numberId = await this.client.getNumberId(cleanPhone);

        if (!numberId) {
          throw new Error(`O número ${cleanPhone} não está registrado no WhatsApp`);
        }

     
        const chatId = numberId._serialized;
        this.addLog(`Enviando para ${chatId}`);

        const result = await this.client.sendMessage(chatId, message);
        this.stats.successCount++;
        this.stats.lastUsed = new Date();
        this.stats._lastUpdate = Date.now();
        this.addLog(`Mensagem enviada para ${cleanPhone}${attempt > 1 ? ` (tentativa ${attempt})` : ''}`);

      
        this.emitToAdmins('whatsapp:stats', { ...this.stats });

       
        this.saveStats();

        return {
          success: true,
          data: { messageId: result.id._serialized },
          tokenUsed: 1,
          attempts: attempt
        };
      } catch (error) {
        lastError = error;

  
        const isRetryableError =
          error.message.includes('WidFactory') ||
          error.message.includes('Evaluation failed') ||
          error.message.includes('not ready') ||
          error.message.includes('Protocol error') ||
          error.message.includes('Target closed') ||
          error.message.includes('Session closed');

        if (isRetryableError && attempt < maxRetries) {
          this.addLog(`Erro recuperável na tentativa ${attempt}: ${error.message}. Aguardando ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }

     
        break;
      }
    }

  
    this.stats.failureCount++;
    this.stats._lastUpdate = Date.now();
    this.addLog(`Erro ao enviar para ${cleanPhone} após ${maxRetries} tentativas: ${lastError.message}`);

    
    this.emitToAdmins('whatsapp:stats', { ...this.stats });

    
    this.saveStats();

    throw new Error(`Falha ao enviar mensagem: ${lastError.message}`);
  }

  /**
   * Envia um áudio via WhatsApp
   * @param {string} phone - Número de telefone
   * @param {string} audioBase64 - Dados do áudio em base64
   * @param {string} mimetype - Tipo MIME do áudio
   * @param {string} caption - Legenda opcional
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async sendAudio(phone, audioBase64, mimetype, caption = '') {
    if (!this.client) {
      throw new Error('Sistema temporariamente offline. Tente novamente em alguns minutos.');
    }

    if (this._status === 'disconnected') {
      throw new Error('WhatsApp desconectado. Aguarde a reconexão automática ou entre em contato com o suporte.');
    }

    // Limpar número de telefone
    let cleanPhone = phone.replace(/\D/g, '');

    if (cleanPhone.length === 11 || cleanPhone.length === 10) {
      cleanPhone = '55' + cleanPhone;
    }

    if (cleanPhone.length < 12 || cleanPhone.length > 13) {
      throw new Error(`Número inválido: ${cleanPhone}. Use formato: 5511999999999`);
    }

    const maxRetries = 3;
    const retryDelay = 2000;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          this.addLog(`Tentativa ${attempt}/${maxRetries} (áudio) - aguardando cliente ficar pronto...`);
          await this.waitForClientReady(5000);
        }

        const numberId = await this.client.getNumberId(cleanPhone);

        if (!numberId) {
          throw new Error(`O número ${cleanPhone} não está registrado no WhatsApp`);
        }

        const chatId = numberId._serialized;
        this.addLog(`Enviando áudio para ${chatId}`);

        // Criar objeto de mídia
        const media = new MessageMedia(mimetype, audioBase64, 'audio.ogg');

        // Enviar como mensagem de voz (PTT - Push To Talk)
        const result = await this.client.sendMessage(chatId, media, {
          sendAudioAsVoice: true,
          caption: caption || undefined
        });

        this.stats.successCount++;
        this.stats.lastUsed = new Date();
        this.stats._lastUpdate = Date.now();
        this.addLog(`Áudio enviado para ${cleanPhone}${attempt > 1 ? ` (tentativa ${attempt})` : ''}`);

        this.emitToAdmins('whatsapp:stats', { ...this.stats });
        this.saveStats();

        return {
          success: true,
          data: { messageId: result.id._serialized },
          tokenUsed: 1,
          attempts: attempt
        };
      } catch (error) {
        lastError = error;

        const isRetryableError =
          error.message.includes('WidFactory') ||
          error.message.includes('Evaluation failed') ||
          error.message.includes('not ready') ||
          error.message.includes('Protocol error') ||
          error.message.includes('Target closed') ||
          error.message.includes('Session closed');

        if (isRetryableError && attempt < maxRetries) {
          this.addLog(`Erro recuperável na tentativa ${attempt} (áudio): ${error.message}. Aguardando ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }

        break;
      }
    }

    this.stats.failureCount++;
    this.stats._lastUpdate = Date.now();
    this.addLog(`Erro ao enviar áudio para ${cleanPhone} após ${maxRetries} tentativas: ${lastError.message}`);

    this.emitToAdmins('whatsapp:stats', { ...this.stats });
    this.saveStats();

    throw new Error(`Falha ao enviar áudio: ${lastError.message}`);
  }

  async disconnect() {
 
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
        this.emitStatusUpdate();
      } catch (err) {
        this.addLog(`Erro ao desconectar: ${err.message}`);
    
        this.status = 'disconnected';
        this.qrCode = null;
        this.client = null;
        this.isInitializing = false;
        this.emitStatusUpdate();
      }
    }
  }

  async reconnect() {
    this.addLog('Reconectando WhatsApp manualmente...');


    this.resetReconnectAttempts();

    await this.disconnect();

    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.initialize();
  }

  async logout() {

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
        this.emitStatusUpdate();
      } catch (err) {
        this.addLog(`Erro no logout: ${err.message}`);
    
        this.status = 'disconnected';
        this.qrCode = null;
        this.client = null;
        this.isInitializing = false;
        this.emitStatusUpdate();
      }
    }
  }

 
  async getStatusAsync() {
   
    let stats = this.stats;
    let effectiveStatus = this._status;
    let effectiveQrCode = this.qrCode;

    try {
      const dbStats = await getWhatsAppStats();
      if (dbStats) {
        stats = {
          successCount: dbStats.successCount || 0,
          failureCount: dbStats.failureCount || 0,
          lastUsed: dbStats.lastUsed || null,
          _lastUpdate: Date.now()
        };
       
        this.stats = stats;


        if (this._status === 'connecting' && !this._showQrCode) {

          if (dbStats.lastConnectedStatus === 'connected') {
       
            const lastUpdate = dbStats.lastStatusUpdate ? new Date(dbStats.lastStatusUpdate) : null;
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

            if (lastUpdate && lastUpdate > oneHourAgo) {
   
              effectiveQrCode = null;
              this.addLog('Aguardando restauração de sessão (última conexão recente)');
            }
          }
        }

        if (this._status === 'connecting' && !this._showQrCode) {
          effectiveQrCode = null;
        }
      }
    } catch (error) {
      console.error('[WhatsApp] Erro ao buscar stats do banco:', error.message);
    }

    return {
      status: effectiveStatus,
      qrCode: effectiveQrCode,
      stats: { ...stats },
      logs: this.logs.slice(-20),
      _timestamp: Date.now(),
      reconnect: {
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
        isScheduled: !!this.reconnectTimeout,
        lastHealthCheck: this.lastHealthCheck,
        healthCheckFailures: this.healthCheckFailures || 0
      }
    };
  }


  getStatus() {
    return {
      status: this._status,
      qrCode: this.qrCode,
      stats: { ...this.stats },
      logs: this.logs.slice(-20),
      _timestamp: Date.now(),
      reconnect: {
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
        isScheduled: !!this.reconnectTimeout,
        lastHealthCheck: this.lastHealthCheck,
        healthCheckFailures: this.healthCheckFailures || 0
      }
    };
  }

  getStats() {
    return [{
      tokenNumber: 1,
      tokenPreview: 'whatsapp-web.js',
      available: this._status === 'connected',
      successCount: this.stats.successCount,
      failureCount: this.stats.failureCount,
      lastUsed: this.stats.lastUsed
    }];
  }

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
