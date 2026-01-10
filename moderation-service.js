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
    this.userMessageCount = new Map(); 
    this.rateLimitWindow = 60 * 60 * 1000; 
    this.maxMessagesPerHour = 20; 
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


  checkRateLimit(userId, targetPhone) {
    const key = `${userId}:${targetPhone}`;
    const now = Date.now();

    if (!this.userMessageCount.has(key)) {
      this.userMessageCount.set(key, []);
    }

    const timestamps = this.userMessageCount.get(key);
  
    const validTimestamps = timestamps.filter(t => now - t < this.rateLimitWindow);
    this.userMessageCount.set(key, validTimestamps);

    if (validTimestamps.length >= this.maxMessagesPerHour) {
      return {
        allowed: false,
        reason: 'Limite de mensagens para este número atingido. Aguarde antes de enviar novamente.',
        category: 'rate_limit_exceeded',
        riskScore: 70
      };
    }

    return { allowed: true };
  }

  recordMessage(userId, targetPhone) {
    const key = `${userId}:${targetPhone}`;
    if (!this.userMessageCount.has(key)) {
      this.userMessageCount.set(key, []);
    }
    this.userMessageCount.get(key).push(Date.now());
  }


  detectSensitiveData(message) {
    const detections = [];

    const cpfRegex = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
    if (cpfRegex.test(message)) {
      detections.push({ type: 'CPF', category: 'sensitive_data_cpf' });
    }

   
    const rgRegex = /\b\d{1,2}\.?\d{3}\.?\d{3}-?[0-9xX]\b/g;
    if (rgRegex.test(message)) {
      detections.push({ type: 'RG', category: 'sensitive_data_rg' });
    }

   
    const phoneRegex = /\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}\b/g;
    if (phoneRegex.test(message)) {
      detections.push({ type: 'Telefone', category: 'sensitive_data_phone' });
    }

   
    const plateRegex = /\b[A-Z]{3}[\s-]?\d[A-Z0-9]\d{2}\b/gi;
    if (plateRegex.test(message)) {
      detections.push({ type: 'Placa', category: 'sensitive_data_plate' });
    }

   
    const cardRegex = /\b\d{4}[\s.-]?\d{4}[\s.-]?\d{4}[\s.-]?\d{4}\b/g;
    if (cardRegex.test(message)) {
      detections.push({ type: 'Cartão', category: 'sensitive_data_card' });
    }

   
    const addressPatterns = [
      /\brua\s+[\w\s]+,?\s*n?\.?\s*\d+/gi,
      /\bav\.?\s*(enida)?\s+[\w\s]+,?\s*n?\.?\s*\d+/gi,
      /\bcep[\s:]*\d{5}-?\d{3}\b/gi,
      /\b\d{5}-?\d{3}\b/g 
    ];
    for (const regex of addressPatterns) {
      if (regex.test(message)) {
        detections.push({ type: 'Endereço/CEP', category: 'sensitive_data_address' });
        break;
      }
    }


    const medicalTerms = [
      'hiv', 'aids', 'câncer', 'cancer', 'diabetes', 'depressão', 'depressao',
      'esquizofrenia', 'bipolar', 'ansiedade', 'psiquiátrico', 'psiquiatrico',
      'diagnóstico', 'diagnostico', 'exame de sangue', 'resultado do exame',
      'receita médica', 'receita medica', 'medicamento controlado'
    ];
    const lowerMessage = message.toLowerCase();
    for (const term of medicalTerms) {
      if (lowerMessage.includes(term)) {
        detections.push({ type: 'Dado Médico', category: 'sensitive_data_medical' });
        break;
      }
    }

    if (detections.length > 0) {
      return {
        allowed: false,
        reason: `Mensagem contém dados sensíveis (${detections.map(d => d.type).join(', ')}). Por segurança e conformidade com a LGPD, não é permitido enviar esses dados.`,
        category: detections[0].category,
        riskScore: 80,
        detectedTypes: detections.map(d => d.type)
      };
    }

    return { allowed: true };
  }


  detectBlackmail(message) {
    const lowerMessage = message.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');


    const blackmailPatterns = [
     
      /se\s+(voce|vc|tu)\s+nao\s+.{1,50}(vou|irei|farei)\s+(divulgar|contar|mostrar|postar|publicar|mandar|enviar|espalhar)/gi,
    
      /pag(ue|a)\s+(ou|senao|se\s*nao)/gi,
    
      /tenho\s+(fotos?|videos?|prints?|provas?)\s+(seus?|tuas?|de\s+voce)/gi,
    
      /vou\s+(divulgar|expor|mostrar|postar|publicar|mandar\s+para|enviar\s+para|espalhar)/gi,
   
      /se\s+(contar|falar|abrir\s+a\s+boca).{0,30}(vai\s+ver|vai\s+se\s+arrepender|voce\s+vai)/gi,
    
      /(conto|falo|mostro)\s+(pra|para)\s+(todo\s+mundo|todos|sua\s+(familia|mae|pai|namorad|marid|espos))/gi,
     
      /(nudes?|intim[oa]s?|pelad[oa]s?).{0,30}(divulgar|postar|mostrar|mandar)/gi,
     
      /(quer|quer\s+que\s+eu\s+nao|pra\s+eu\s+nao).{0,30}(dinheiro|pix|transf|pag)/gi,
    
      /sei\s+(onde|aonde)\s+(voce|vc|tu)\s+(mora|trabalha|estuda|fica)/gi
    ];

    for (const pattern of blackmailPatterns) {
      if (pattern.test(lowerMessage)) {
        return {
          allowed: false,
          reason: 'Mensagem identificada como possível chantagem ou extorsão. Este tipo de conteúdo é crime.',
          category: 'blackmail_extortion',
          riskScore: 100
        };
      }
    }

    
    const threatPatterns = [
      /voce\s+vai\s+(pagar|se\s+arrepender|ver\s+so)/gi,
      /vai\s+acontecer\s+(algo|alguma\s+coisa)\s+(ruim|com\s+voce)/gi,
      /eu\s+sei\s+(quem|onde|o\s+que)\s+voce/gi,
      /sua\s+(familia|mae|pai|filh[oa]).{0,20}(vai\s+sofrer|vai\s+pagar|vai\s+ver)/gi
    ];

    for (const pattern of threatPatterns) {
      if (pattern.test(lowerMessage)) {
        return {
          allowed: false,
          reason: 'Mensagem contém ameaça. Este tipo de conteúdo é crime.',
          category: 'threat',
          riskScore: 95
        };
      }
    }

    return { allowed: true };
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


  async validateMessage(message, options = {}) {
    const { userId = null, targetPhone = null } = options;

    
    const defaultResult = { allowed: true, reason: null, riskScore: 0, category: null };

    if (!this.isEnabled) {
      return defaultResult;
    }

    
    const blackmailCheck = this.detectBlackmail(message);
    if (!blackmailCheck.allowed) {
      return blackmailCheck;
    }

    
    const basicCheck = this.basicValidation(message);
    if (!basicCheck.allowed) {
      return basicCheck;
    }

    
    if (userId && targetPhone) {
      const rateLimitCheck = this.checkRateLimit(userId, targetPhone);
      if (!rateLimitCheck.allowed) {
        return rateLimitCheck;
      }
    }

 
    const sensitiveDataCheck = this.detectSensitiveData(message);
    if (!sensitiveDataCheck.allowed) {
      return sensitiveDataCheck;
    }

   
    const aiResult = await this.analyzeMessage(message);

    
    if (!aiResult.riskScore) {
      aiResult.riskScore = aiResult.allowed ? 0 : 60;
    }

    return aiResult;
  }

  
  async validateAndRecord(message, userId, targetPhone) {
    const result = await this.validateMessage(message, { userId, targetPhone });

   
    if (result.allowed && userId && targetPhone) {
      this.recordMessage(userId, targetPhone);
    }

    return result;
  }


  basicValidation(message) {
    const lowerMessage = message.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  
    const categories = {
     
      criminal: {
        words: [
          'matar', 'assassinar', 'estuprar', 'sequestrar',
          'bomba', 'terrorismo', 'pedofilia', 'pedofilo',
          'vou te pegar', 'vai morrer', 'te mato', 'vou matar',
          'trafico', 'cocaina', 'crack', 'heroina'
        ],
        category: 'criminal_threat',
        riskScore: 100,
        reason: 'Mensagem contém conteúdo criminoso ou ameaça grave'
      },
     
      violence: {
        words: [
          'bater', 'socar', 'espancar', 'surrar', 'arrebentar',
          'acabar com voce', 'quebrar a cara', 'dar um tiro'
        ],
        category: 'violence',
        riskScore: 85,
        reason: 'Mensagem contém incitação à violência'
      },
   
      hate_speech: {
        words: [
          'macaco', 'crioulo', 'negao', 'preto fedido', 'branquelo',
          'nazista', 'hitler', 'judeu imundo', 'volta pra senzala'
        ],
        category: 'hate_speech',
        riskScore: 80,
        reason: 'Mensagem contém discurso de ódio ou racismo'
      },
   
      homophobia: {
        words: [
          'viado', 'viadinho', 'viadao', 'veado', 'veadinho',
          'bicha', 'bichinha', 'bichona', 'sapatao', 'sapatona', 'traveco',
          'baitola', 'baitolao', 'baitolinha', 'boiola', 'boiolao', 'boiolinha'
        ],
        category: 'homophobia',
        riskScore: 75,
        reason: 'Mensagem contém conteúdo homofóbico'
      },
     
      severe_insult: {
        words: [
          'porra', 'caralho', 'cacete', 'merda', 'bosta',
          'puta', 'putaria', 'putinha', 'vagabunda', 'vadia', 'piranha',
          'fdp', 'filho da puta', 'filha da puta', 'fudido', 'foder', 'foda-se', 'fodase',
          'cu', 'cuzao', 'cuzinho', 'arrombado', 'arrombada',
          'buceta', 'xoxota', 'xereca', 'ppk', 'rola', 'pica', 'piroca',
          'punheta', 'punheteiro', 'puto', 'puta que pariu',
          'vsf', 'vai se fuder', 'tnc', 'tomar no cu', 'vtnc', 'vai tomar no cu', 'pqp'
        ],
        category: 'severe_insult',
        riskScore: 65,
        reason: 'Mensagem contém linguagem extremamente ofensiva'
      },
    
      personal_insult: {
        words: [
          'otario', 'otaria', 'idiota', 'imbecil', 'retardado', 'retardada',
          'babaca', 'besta', 'burro', 'burra', 'animal', 'jumento',
          'desgraca', 'desgraçado', 'desgraçada', 'maldito', 'maldita',
          'nojento', 'nojenta', 'lixo', 'escoria', 'verme',
          'vagabundo', 'safado', 'safada', 'canalha',
          'vaca', 'vaca velha', 'vacona', 'galinha', 'cachorra', 'cadela',
          'egua', 'jumenta', 'piranhuda', 'broxa', 'corno', 'cornudo', 'chifrudo',
          'baranga', 'mocreia', 'baleia'
        ],
        category: 'personal_insult',
        riskScore: 50,
        reason: 'Mensagem contém ofensa pessoal'
      },
    
      fraud: {
        words: [
          'pix agora', 'me passa', 'senha do banco', 'cartao de credito',
          'dados bancarios', 'numero do cartao', 'codigo de seguranca',
          'deposita', 'transfere urgente'
        ],
        category: 'fraud_attempt',
        riskScore: 70,
        reason: 'Mensagem contém possível tentativa de golpe ou fraude'
      }
    };

    for (const [catName, catData] of Object.entries(categories)) {
      for (const word of catData.words) {
        const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        if (regex.test(lowerMessage) || lowerMessage.includes(word)) {
          return {
            allowed: false,
            reason: catData.reason,
            category: catData.category,
            riskScore: catData.riskScore,
            matchedWord: word
          };
        }
      }
    }

    return { allowed: true, reason: null, riskScore: 0, category: null };
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
