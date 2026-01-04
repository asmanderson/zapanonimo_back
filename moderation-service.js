require('dotenv').config();

// === CREDENCIAIS HARDCODED (não use .env para IA) ===
const AI_CONFIG = {
  claude: {
    apiKey: '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',
    model: 'claude-3-5-haiku-latest',
    enabled: true
  },
  gemini: {
    apiKey: 'AIzaSyDPPtcBOJsPEvROruae4RGt0UZLlVT-dq8',
    model: 'gemini-2.0-flash',
    enabled: true
  }
};

class ModerationService {
  constructor() {
    this.cache = new Map(); // Cache simples para evitar chamadas repetidas
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutos
  }

  // === CLAUDE CONFIG ===
  get claudeApiKey() {
    return AI_CONFIG.claude.apiKey;
  }

  get claudeModel() {
    return AI_CONFIG.claude.model;
  }

  get claudeEnabled() {
    return AI_CONFIG.claude.enabled && !!this.claudeApiKey;
  }

  // === GEMINI CONFIG ===
  get geminiApiKey() {
    return AI_CONFIG.gemini.apiKey;
  }

  get geminiModel() {
    return AI_CONFIG.gemini.model;
  }

  get geminiEnabled() {
    return AI_CONFIG.gemini.enabled && !!this.geminiApiKey;
  }

  // Getter para verificar se alguma IA está habilitada
  get isEnabled() {
    return this.claudeEnabled || this.geminiEnabled;
  }

  // Compatibilidade com código antigo
  get apiKey() {
    return this.claudeApiKey || this.geminiApiKey;
  }

  get model() {
    return this.claudeModel;
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

  // Prompt de moderação compartilhado
  getModerationPrompt(message) {
    return `Você é um moderador de conteúdo. Analise a mensagem abaixo e determine se ela deve ser BLOQUEADA ou PERMITIDA.

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

Seja criterioso mas não excessivamente restritivo. Mensagens ambíguas devem ser permitidas.`;
  }

  // Analisar com Claude
  async analyzeWithClaude(message) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.claudeApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.claudeModel,
        max_tokens: 256,
        messages: [{ role: 'user', content: this.getModerationPrompt(message) }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  // Analisar com Gemini
  async analyzeWithGemini(message) {
    const url = `https://generativelanguage.googleapis.com/v1/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: this.getModerationPrompt(message) }] }],
        generationConfig: { maxOutputTokens: 256 }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }

  // Parsear resultado JSON da IA
  parseAIResponse(content) {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error('[Moderation] Erro ao parsear resposta:', content);
    }
    return { allowed: true, reason: null };
  }

  async analyzeMessage(message) {
    // Verificar se alguma IA está configurada
    if (!this.claudeEnabled && !this.geminiEnabled) {
      console.log('[Moderation] Nenhuma IA configurada, permitindo mensagem');
      return { allowed: true, reason: null };
    }

    // Verificar cache primeiro
    const cached = this.checkCache(message);
    if (cached !== null) {
      console.log('[Moderation] Resultado do cache:', cached.allowed ? 'permitido' : 'bloqueado');
      return cached;
    }

    let result = null;
    let usedProvider = null;

    // Tentar Claude primeiro
    if (this.claudeEnabled) {
      try {
        console.log('[Moderation] Tentando Claude...');
        const content = await this.analyzeWithClaude(message);
        result = this.parseAIResponse(content);
        usedProvider = 'Claude';
      } catch (error) {
        console.error('[Moderation] Claude falhou:', error.message);
      }
    }

    // Se Claude falhou, tentar Gemini como fallback
    if (!result && this.geminiEnabled) {
      try {
        console.log('[Moderation] Tentando Gemini (fallback)...');
        const content = await this.analyzeWithGemini(message);
        result = this.parseAIResponse(content);
        usedProvider = 'Gemini';
      } catch (error) {
        console.error('[Moderation] Gemini falhou:', error.message);
      }
    }

    // Se ambos falharam, permitir (fail-open)
    if (!result) {
      console.log('[Moderation] Todas as IAs falharam, permitindo mensagem');
      return { allowed: true, reason: null };
    }

    // Salvar no cache
    this.saveCache(message, result);

    console.log(`[Moderation] Resultado via ${usedProvider}:`, result.allowed ? 'permitido' : `bloqueado (${result.reason})`);
    return result;
  }

  // Método principal para validar mensagem antes do envio
  async validateMessage(message) {
    // Se a moderação estiver desabilitada, permitir todas as mensagens
    if (!this.isEnabled) {
      console.log('[Moderation] Moderação desabilitada via CLAUDE_ENABLED');
      return { allowed: true, reason: null };
    }

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
    const lowerMessage = message.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // Remove acentos

    // Lista de palavrões e ofensas em português
    const badWords = [
      // Palavrões comuns
      'porra', 'caralho', 'cacete', 'merda', 'bosta', 'coco',
      'puta', 'putaria', 'putinha', 'vagabunda', 'vadia', 'piranha',
      'fdp', 'filho da puta', 'filha da puta', 'fudido', 'foder', 'foda-se', 'fodase',
      'cu', 'cuzao', 'cuzinho', 'arrombado', 'arrombada',
      'viado', 'veado', 'bicha', 'bichona', 'sapatao', 'traveco',
      'baitola', 'baitolao', 'baitolinha', 'boiola', 'boiolao',
      'buceta', 'xoxota', 'xereca', 'ppk', 'rola', 'pica', 'pau', 'piroca',
      'punheta', 'punheteiro', 'broxa', 'corno', 'cornudo', 'chifrudo',
      'otario', 'otaria', 'idiota', 'imbecil', 'retardado', 'retardada',
      'babaca', 'besta', 'burro', 'burra', 'animal', 'jumento',
      'desgraca', 'desgraçado', 'desgraçada', 'maldito', 'maldita',
      'nojento', 'nojenta', 'lixo', 'escoria', 'verme',
      'vagabundo', 'vagal', 'safado', 'safada', 'canalha',
      'puto', 'puta que pariu', 'vsf', 'vai se fuder', 'tnc', 'tomar no cu',
      'vtnc', 'vai tomar no cu', 'pqp',
      // Ofensas com animais
      'vaca', 'vaca velha', 'vacona', 'galinha', 'cachorra', 'cadela',
      'egua', 'jumenta', 'bezerra', 'piranhuda',
      // Ofensas de idade/aparência
      'velha', 'velho', 'coroa', 'acabada', 'acabado', 'feia', 'feio',
      'gorda', 'gordo', 'baleia', 'elefante', 'baranga', 'mocreia',
      // Ameaças e violência
      'matar', 'assassinar', 'estuprar', 'sequestrar', 'bater',
      'socar', 'espancar', 'surrar', 'arrebentar', 'acabar com voce',
      'bomba', 'terrorismo', 'pedofilia', 'pedofilo',
      'vou te pegar', 'vai morrer', 'te mato', 'vou matar',
      // Discriminação
      'macaco', 'crioulo', 'negao', 'preto fedido', 'branquelo',
      'nazista', 'hitler',
      // Golpes
      'pix agora', 'me passa', 'senha do banco', 'cartao de credito'
    ];

    for (const word of badWords) {
      // Verificar palavra exata ou como parte de palavra
      const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      if (regex.test(lowerMessage) || lowerMessage.includes(word)) {
        return {
          allowed: false,
          reason: 'Mensagem contém conteúdo inadequado ou ofensivo',
          category: 'inappropriate_content'
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
