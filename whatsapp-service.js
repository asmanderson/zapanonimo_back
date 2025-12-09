require('dotenv').config();

const API_URL = 'https://wasenderapi.com/api/send-message';

class WhatsAppService {
  constructor() {
    this.tokens = this.loadTokens();
    this.currentTokenIndex = 0;
    this.tokenStats = new Map(); 

    this.tokens.forEach((token, index) => {
      this.tokenStats.set(index, {
        successCount: 0,
        failureCount: 0,
        lastUsed: null,
        isAvailable: true
      });
    });
  }

  loadTokens() {
    const tokens = [];
    let index = 1;

    while (process.env[`WHATSAPP_API_KEY_${index}`]) {
      tokens.push(process.env[`WHATSAPP_API_KEY_${index}`]);
      index++;
    }

    if (tokens.length === 0 && process.env.WHATSAPP_API_KEY) {
      tokens.push(process.env.WHATSAPP_API_KEY);
    }

    if (tokens.length === 0) {
      throw new Error('Nenhum token do WhatsApp configurado no .env');
    }

    return tokens;
  }


  getNextToken() {
    const startIndex = this.currentTokenIndex;

    do {
      const stats = this.tokenStats.get(this.currentTokenIndex);

      if (stats.isAvailable) {
        const token = this.tokens[this.currentTokenIndex];
        const tokenIndex = this.currentTokenIndex;

        this.currentTokenIndex = (this.currentTokenIndex + 1) % this.tokens.length;

        return { token, index: tokenIndex };
      }

      this.currentTokenIndex = (this.currentTokenIndex + 1) % this.tokens.length;

    } while (this.currentTokenIndex !== startIndex);

    this.tokenStats.forEach(stats => stats.isAvailable = true);

    const token = this.tokens[this.currentTokenIndex];
    const tokenIndex = this.currentTokenIndex;
    this.currentTokenIndex = (this.currentTokenIndex + 1) % this.tokens.length;

    return { token, index: tokenIndex };
  }


  markTokenAsUnavailable(tokenIndex) {
    const stats = this.tokenStats.get(tokenIndex);
    if (stats) {
      stats.isAvailable = false;
      stats.failureCount++;
    }
  }


  markTokenSuccess(tokenIndex) {
    const stats = this.tokenStats.get(tokenIndex);
    if (stats) {
      stats.successCount++;
      stats.lastUsed = new Date();
      stats.isAvailable = true;
    }
  }


  async sendMessage(phone, message, maxRetries = null) {
    const retriesToUse = maxRetries !== null ? maxRetries : this.tokens.length;
    let lastError = null;
    let attemptedTokens = [];

    for (let attempt = 0; attempt < retriesToUse; attempt++) {
      const { token, index } = this.getNextToken();
      attemptedTokens.push(index + 1);

      try {

        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            to: phone,
            text: message
          })
        });

        const data = await response.json();

        const isSuccess = response.ok &&
                         data &&
                         data.success === true;

        if (isSuccess) {
          this.markTokenSuccess(index);

          return {
            success: true,
            data,
            tokenUsed: index + 1,
            attempts: attempt + 1
          };
        } else {
          const errorMsg = data.message || data.error || 'Erro desconhecido';
          this.markTokenAsUnavailable(index);
          lastError = data;
        }

      } catch (error) {
        this.markTokenAsUnavailable(index);
        lastError = error;
      }
    }

    throw new Error(
      `Falha ao enviar mensagem após ${retriesToUse} tentativa(s). ` +
      `Tokens testados: ${attemptedTokens.join(', ')}. ` +
      `Último erro: ${lastError?.message || JSON.stringify(lastError)}`
    );
  }

  getStats() {
    const stats = [];
    this.tokens.forEach((token, index) => {
      const tokenStats = this.tokenStats.get(index);
      stats.push({
        tokenNumber: index + 1,
        tokenPreview: `${token.substring(0, 10)}...`,
        available: tokenStats.isAvailable,
        successCount: tokenStats.successCount,
        failureCount: tokenStats.failureCount,
        lastUsed: tokenStats.lastUsed
      });
    });
    return stats;
  }


  async testAllTokens(testPhone, testMessage) {

    const results = [];

    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];

      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            to: testPhone,
            text: testMessage
          })
        });

        const data = await response.json();

        results.push({
          tokenNumber: i + 1,
          status: response.ok ? 'OK' : 'ERRO',
          statusCode: response.status,
          response: data
        });


      } catch (error) {
        results.push({
          tokenNumber: i + 1,
          status: 'ERRO',
          error: error.message
        });
      }
    }

    return results;
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
