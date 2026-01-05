require('dotenv').config();

const AI_CONFIG = {
  claude: {
    apiKey: process.env.CLAUDE_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-3-5-haiku-latest',
    enabled: process.env.CLAUDE_ENABLED === 'true'
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    enabled: process.env.GEMINI_ENABLED === 'true'
  }
};

class ModerationService {
  constructor() {
    this.cache = new Map(); 
    this.cacheTimeout = 5 * 60 * 1000; 
  }


  get claudeApiKey() {
    return AI_CONFIG.claude.apiKey;
  }

  get claudeModel() {
    return AI_CONFIG.claude.model;
  }

  get claudeEnabled() {
    return AI_CONFIG.claude.enabled && !!this.claudeApiKey;
  }


  get geminiApiKey() {
    return AI_CONFIG.gemini.apiKey;
  }

  get geminiModel() {
    return AI_CONFIG.gemini.model;
  }

  get geminiEnabled() {
    return AI_CONFIG.gemini.enabled && !!this.geminiApiKey;
  }


  get isEnabled() {
    return this.claudeEnabled || this.geminiEnabled;
  }


  get apiKey() {
    return this.claudeApiKey || this.geminiApiKey;
  }

  get model() {
    return this.claudeModel;
  }

  
  hashMessage(message) {
    let hash = 0;
    for (let i = 0; i < message.length; i++) {
      const char = message.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }


  checkCache(message) {
    const hash = this.hashMessage(message);
    const cached = this.cache.get(hash);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.result;
    }

    return null;
  }

 
  saveCache(message, result) {
    const hash = this.hashMessage(message);
    this.cache.set(hash, {
      result,
      timestamp: Date.now()
    });

  
    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }


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

    if (!this.claudeEnabled && !this.geminiEnabled) {
      return { allowed: true, reason: null };
    }


    const cached = this.checkCache(message);
    if (cached !== null) {
      return cached;
    }

    let result = null;
    let usedProvider = null;

  
    if (this.claudeEnabled) {
      try {
        const content = await this.analyzeWithClaude(message);
        result = this.parseAIResponse(content);
        usedProvider = 'Claude';
      } catch (error) {
        console.error('[Moderation] Claude falhou:', error.message);
      }
    }

 
    if (!result && this.geminiEnabled) {
      try {
        const content = await this.analyzeWithGemini(message);
        result = this.parseAIResponse(content);
        usedProvider = 'Gemini';
      } catch (error) {
        console.error('[Moderation] Gemini falhou:', error.message);
      }
    }


    if (!result) {
      return { allowed: true, reason: null };
    }


    this.saveCache(message, result);

    return result;
  }


  async validateMessage(message) {

    if (!this.isEnabled) {
      return { allowed: true, reason: null };
    }

  
    const basicCheck = this.basicValidation(message);
    if (!basicCheck.allowed) {
      return basicCheck;
    }


    return await this.analyzeMessage(message);
  }


  basicValidation(message) {
    const lowerMessage = message.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); 


    const badWords = [
  
      'porra', 'caralho', 'cacete', 'merda', 'bosta', 'coco',
      'puta', 'putaria', 'putinha', 'vagabunda', 'vadia', 'piranha',
      'fdp', 'filho da puta', 'filha da puta', 'fudido', 'foder', 'foda-se', 'fodase',
      'cu', 'cuzao', 'cuzinho', 'arrombado', 'arrombada',
      'viado', 'viadinho', 'viadao', 'veado', 'veadinho', 'bicha', 'bichinha', 'bichona', 'sapatao', 'sapatona', 'traveco',
      'baitola', 'baitolao', 'baitolinha', 'boiola', 'boiolao', 'boiolinha',
      'buceta', 'xoxota', 'xereca', 'ppk', 'rola', 'pica', 'pau', 'piroca',
      'punheta', 'punheteiro', 'broxa', 'corno', 'cornudo', 'chifrudo',
      'otario', 'otaria', 'idiota', 'imbecil', 'retardado', 'retardada',
      'babaca', 'besta', 'burro', 'burra', 'animal', 'jumento',
      'desgraca', 'desgraçado', 'desgraçada', 'maldito', 'maldita',
      'nojento', 'nojenta', 'lixo', 'escoria', 'verme',
      'vagabundo', 'vagal', 'safado', 'safada', 'canalha',
      'puto', 'puta que pariu', 'vsf', 'vai se fuder', 'tnc', 'tomar no cu',
      'vtnc', 'vai tomar no cu', 'pqp',

      'vaca', 'vaca velha', 'vacona', 'galinha', 'cachorra', 'cadela',
      'egua', 'jumenta', 'bezerra', 'piranhuda',
  
      'velha', 'velho', 'coroa', 'acabada', 'acabado', 'feia', 'feio',
      'gorda', 'gordo', 'baleia', 'elefante', 'baranga', 'mocreia',
 
      'matar', 'assassinar', 'estuprar', 'sequestrar', 'bater',
      'socar', 'espancar', 'surrar', 'arrebentar', 'acabar com voce',
      'bomba', 'terrorismo', 'pedofilia', 'pedofilo',
      'vou te pegar', 'vai morrer', 'te mato', 'vou matar',
     
      'macaco', 'crioulo', 'negao', 'preto fedido', 'branquelo',
      'nazista', 'hitler',
    
      'pix agora', 'me passa', 'senha do banco', 'cartao de credito'
    ];

    for (const word of badWords) {
    
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
