require('dotenv').config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

console.log('=== Teste de Moderação com Claude API ===\n');
console.log('API Key configurada:', ANTHROPIC_API_KEY ? `${ANTHROPIC_API_KEY.substring(0, 20)}...` : 'NÃO CONFIGURADA');

async function testAPI() {
  if (!ANTHROPIC_API_KEY) {
    console.log('\n❌ ERRO: API Key não configurada no .env');
    return;
  }

  console.log('\nTestando conexão com a API do Claude...\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: 'Responda apenas com "OK" se você está funcionando.'
          }
        ]
      })
    });

    console.log('Status da resposta:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('\n❌ ERRO na API:', errorText);
      return;
    }

    const data = await response.json();
    console.log('\n✅ API funcionando!');
    console.log('Resposta:', data.content[0].text);

    // Testar moderação
    console.log('\n--- Testando Moderação ---\n');

    const testMessages = [
      'Olá, tudo bem?',
      'Vai tomar no cu seu fdp',
      'Bom dia, como posso ajudar?'
    ];

    const { getModerationService } = require('./moderation-service');
    const moderationService = getModerationService();

    for (const msg of testMessages) {
      console.log(`Mensagem: "${msg}"`);
      const result = await moderationService.validateMessage(msg);
      console.log(`Resultado: ${result.allowed ? '✅ Permitida' : '❌ Bloqueada - ' + result.reason}`);
      console.log('---');
    }

  } catch (error) {
    console.log('\n❌ ERRO:', error.message);
  }
}

testAPI();
