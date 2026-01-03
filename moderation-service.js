require('dotenv').config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

class ModerationService {
  constructor() {
    this.apiKey = ANTHROPIC_API_KEY;
    this.cache = new Map(); // Cache simples para evitar chamadas repetidas
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutos
  }

  // Gerar hash simples para cache
  hashMessage(message) {
    let hash = 0;
    for (let i = 0; i < message.length; i++) {
      const char = message.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  // Verificar cache
  checkCache(message) {
    const hash = this.hashMessage(message);
    const cached = this.cache.get(hash);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.result;
    }

    return null;
  }

  // Salvar no cache
  saveCache(message, result) {
    const hash = this.hashMessage(message);
    this.cache.set(hash, {
      result,
      timestamp: Date.now()
    });

    // Limpar cache antigo (manter no máximo 1000 entradas)
    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  async analyzeMessage(message) {
    // Verificar se a API key está configurada
    if (!this.apiKey) {
      console.log('[Moderation] API key não configurada, permitindo mensagem');
      return { allowed: true, reason: null };
    }

    // Verificar cache primeiro
    const cached = this.checkCache(message);
    if (cached !== null) {
      console.log('[Moderation] Resultado do cache:', cached.allowed ? 'permitido' : 'bloqueado');
      return cached;
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 256,
          messages: [
            {
              role: 'user',
              content: `Você é um moderador de conteúdo. Analise a mensagem abaixo e determine se ela deve ser BLOQUEADA ou PERMITIDA.

BLOQUEAR mensagens que contenham:
- Palavrões ou linguagem obscena
- Ofensas, xingamentos ou insultos diretos
- Ameaças ou coação
- Conteúdo ilícito (drogas, armas, etc.)
- Assédio ou bullying
- Discurso de ódio
- Golpes ou fraudes
- Conteúdo sexual explícito
- Incitação à violência

PERMITIR mensagens que sejam:
- Comunicação normal e respeitosa
- Brincadeiras leves sem ofensas
- Informações neutras
- Pedidos educados

Mensagem para análise:
"""
${message}
"""

Responda APENAS com um JSON no formato:
{"allowed": true/false, "reason": "motivo se bloqueado ou null se permitido", "category": "categoria da violação ou null"}

Seja criterioso mas não excessivamente restritivo. Mensagens ambíguas devem ser permitidas.`
            }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Moderation] Erro na API:', response.status, errorText);
        // Em caso de erro na API, permite a mensagem (fail-open)
        return { allowed: true, reason: null };
      }

      const data = await response.json();
      const content = data.content[0].text;

      // Extrair JSON da resposta
      let result;
      try {
        // Tentar encontrar JSON na resposta
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          // Se não encontrar JSON, assumir permitido
          result = { allowed: true, reason: null };
        }
      } catch (parseError) {
        console.error('[Moderation] Erro ao parsear resposta:', content);
        result = { allowed: true, reason: null };
      }

      // Salvar no cache
      this.saveCache(message, result);

      console.log('[Moderation] Resultado:', result.allowed ? 'permitido' : `bloqueado (${result.reason})`);
      return result;

    } catch (error) {
      console.error('[Moderation] Erro:', error.message);
      // Em caso de erro, permite a mensagem (fail-open)
      return { allowed: true, reason: null };
    }
  }

  // Método principal para validar mensagem antes do envio
  async validateMessage(message) {
    // Verificações básicas primeiro (mais rápidas)
    const basicCheck = this.basicValidation(message);
    if (!basicCheck.allowed) {
      return basicCheck;
    }

    // Análise com IA
    return await this.analyzeMessage(message);
  }

  // Validação básica local (sem API)
  basicValidation(message) {
    // Lista de palavras obviamente proibidas (casos extremos)
    const extremeWords = [
      'matar', 'assassinar', 'estuprar', 'sequestrar',
      'bomba', 'terrorismo', 'pedofilia'
    ];

    const lowerMessage = message.toLowerCase();

    for (const word of extremeWords) {
      if (lowerMessage.includes(word)) {
        return {
          allowed: false,
          reason: 'Conteúdo potencialmente perigoso detectado',
          category: 'dangerous_content'
        };
      }
    }

    return { allowed: true, reason: null };
  }
}

// Singleton
let instance = null;

function getModerationService() {
  if (!instance) {
    instance = new ModerationService();
  }
  return instance;
}

module.exports = {
  getModerationService,
  ModerationService
};
