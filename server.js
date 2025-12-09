require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const app = express();

// Configuração de CORS para permitir requisições do frontend
const allowedOrigins = [
  'https://zapanonimo.com',
  'https://www.zapanonimo.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const { authMiddleware, generateToken } = require('./auth');
const {
  createUser,
  getUserByEmail,
  getUserById,
  verifyPassword,
  addCredits,
  useCredit,
  getUserTransactions,
  getUserMessages,
  getUserReplies,
  saveReply,
  findMessageByPhone,
  saveReplyFromWebhook,
  createVerificationToken,
  verifyEmailToken,
  isEmailVerified,
  createPasswordResetToken,
  resetPassword
} = require('./database');
const {
  sendVerificationEmail,
  resendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail
} = require('./email-service');
const {
  createCheckoutSession,
  verifySession,
  isPaymentApproved,
  constructWebhookEvent
} = require('./stripe-payment');
const { getWhatsAppService } = require('./whatsapp-service');
const smsService = require('./sms-service');

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sua-chave-secreta-de-sessao',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true,
    sameSite: 'lax'
  }
}));

const whatsappService = getWhatsAppService();

app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email e senha são obrigatórios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Senha deve ter no mínimo 6 caracteres' });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Email já cadastrado' });
    }

    const result = await createUser(email, password);

    const verificationToken = await createVerificationToken(result.id);

    try {

      await sendVerificationEmail(email, verificationToken);
    } catch (emailError) {
      console.error('❌ Erro ao enviar email de verificação:', emailError);
      console.error('Stack:', emailError.stack);
    }

    res.json({
      success: true,
      userId: result.id,
      message: 'Conta criada! Verifique seu email para ativar a conta.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email e senha são obrigatórios' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Email ou senha incorretos' });
    }

    const isValid = await verifyPassword(password, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Email ou senha incorretos' });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        success: false,
        error: 'Email não verificado. Verifique sua caixa de entrada.',
        emailNotVerified: true
      });
    }

    const token = generateToken(user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        whatsapp_credits: user.whatsapp_credits,
        sms_credits: user.sms_credits
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test-email', async (req, res) => {
  try {
    const testEmail = req.query.email || 'teste@teste.com';
    const testToken = 'teste-token-123456';


    await sendVerificationEmail(testEmail, testToken);

    res.json({
      success: true,
      message: `Email de teste enviado para ${testEmail}`
    });
  } catch (error) {
    console.error('❌ Erro no teste de email:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.toString()
    });
  }
});

app.get('/api/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const userId = await verifyEmailToken(token);
    const user = await getUserById(userId);

    try {
      await sendWelcomeEmail(user.email);
    } catch (emailError) {
      console.error('Erro ao enviar email de boas-vindas:', emailError);
    }

    res.json({
      success: true,
      message: 'Email verificado com sucesso! Você já pode fazer login.'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email é obrigatório' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    if (user.email_verified) {
      return res.status(400).json({ success: false, error: 'Email já verificado' });
    }


    const verificationToken = await createVerificationToken(user.id);


    await resendVerificationEmail(email, verificationToken);

    res.json({
      success: true,
      message: 'Email de verificação reenviado! Verifique sua caixa de entrada.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email é obrigatório' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.json({
        success: true,
        message: 'Se o email existir, você receberá um link de recuperação.'
      });
    }

    const resetToken = await createPasswordResetToken(user.id);

    try {
      await sendPasswordResetEmail(email, resetToken);
    } catch (emailError) {
      console.error('❌ Erro ao enviar email de recuperação:', emailError);
      return res.status(500).json({ success: false, error: 'Erro ao enviar email de recuperação' });
    }

    res.json({
      success: true,
      message: 'Link de recuperação enviado! Verifique seu email.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, error: 'Token e senha são obrigatórios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Senha deve ter no mínimo 6 caracteres' });
    }

    await resetPassword(token, password);

    res.json({
      success: true,
      message: 'Senha redefinida com sucesso!'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});


app.get('/api/user/credits', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    res.json({
      success: true,
      whatsapp_credits: user.whatsapp_credits,
      sms_credits: user.sms_credits
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/create-payment', authMiddleware, async (req, res) => {
  try {
    console.log('📝 Requisição de pagamento recebida:', req.body);
    console.log('👤 User ID:', req.userId);

    const { quantity, creditType } = req.body;

    if (!quantity || quantity < 1) {
      console.error('❌ Quantidade inválida:', quantity);
      return res.status(400).json({ success: false, error: 'Quantidade inválida' });
    }

    if (!creditType || (creditType !== 'whatsapp' && creditType !== 'sms')) {
      console.error('❌ Tipo de crédito inválido:', creditType);
      return res.status(400).json({ success: false, error: 'Tipo de crédito inválido' });
    }

    console.log('🔍 Buscando usuário...');
    const user = await getUserById(req.userId);

    if (!user) {
      console.error('❌ Usuário não encontrado:', req.userId);
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    console.log('✅ Usuário encontrado:', user.email);
    console.log('💳 Criando sessão Stripe...');

    const session = await createCheckoutSession(req.userId, quantity, user.email, creditType);

    console.log('✅ Sessão criada com sucesso:', session.id);

    res.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url
    });
  } catch (error) {
    console.error('❌ ERRO COMPLETO ao criar pagamento:');
    console.error('Mensagem:', error.message);
    console.error('Stack:', error.stack);
    console.error('Detalhes:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao criar pagamento: ' + error.message
    });
  }
});


app.post('/api/stripe/webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];

  try {
    const event = constructWebhookEvent(req.body, signature);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      if (isPaymentApproved(session)) {
        const userId = parseInt(session.metadata.userId);
        const quantity = parseInt(session.metadata.quantity);
        const price = session.amount_total / 100;
        const creditType = session.metadata.creditType || 'whatsapp';

        await addCredits(userId, quantity, price, creditType);

      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.get('/api/verify-payment/:sessionId', authMiddleware, async (req, res) => {
  try {
    const session = await verifySession(req.params.sessionId);


    if (session.payment_status === 'paid' && session.metadata.userId) {
      const userId = parseInt(session.metadata.userId);
      const quantity = parseInt(session.metadata.quantity);
      const price = session.amount_total / 100;
      const creditType = session.metadata.creditType || 'whatsapp';

      const user = await getUserById(userId);

      await addCredits(userId, quantity, price, creditType);

    }

    res.json({
      success: true,
      paid: session.payment_status === 'paid',
      status: session.payment_status
    });
  } catch (error) {
    console.error('Erro ao verificar pagamento:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const transactions = await getUserTransactions(req.userId);
    res.json({ success: true, transactions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const messages = await getUserMessages(req.userId);
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Buscar respostas recebidas
app.get('/api/replies', authMiddleware, async (req, res) => {
  try {
    const replies = await getUserReplies(req.userId);
    res.json({ success: true, replies });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, replies: [] });
  }
});

// ============================================
// WEBHOOKS PARA RECEBER RESPOSTAS
// ============================================

// Webhook do Twilio para receber respostas de SMS
// Configure no Twilio: https://seu-dominio.com/api/webhook/twilio/sms
app.post('/api/webhook/twilio/sms', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    console.log('📥 Webhook Twilio SMS recebido:', req.body);

    const {
      From: fromPhone,    // Número que enviou a resposta
      Body: message,      // Conteúdo da mensagem
      To: toPhone,        // Número Twilio que recebeu
      MessageSid: messageSid
    } = req.body;

    if (!fromPhone || !message) {
      console.log('⚠️ Webhook Twilio: dados incompletos');
      return res.status(200).send('<Response></Response>');
    }

    console.log(`📱 SMS recebido de ${fromPhone}: ${message}`);

    // Salvar a resposta no banco
    const result = await saveReplyFromWebhook(fromPhone, message, 'sms');

    if (result) {
      console.log(`✅ Resposta SMS salva para usuário ${result.user?.email || result.originalMessage?.user_id}`);
    } else {
      console.log(`⚠️ Nenhuma mensagem original encontrada para ${fromPhone}`);
    }

    // Resposta vazia para o Twilio (não enviar SMS de volta)
    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

  } catch (error) {
    console.error('❌ Erro no webhook Twilio SMS:', error);
    res.status(200).send('<Response></Response>');
  }
});

// Webhook do WaSenderAPI para receber respostas de WhatsApp
// Configure no WaSenderAPI: https://seu-dominio.com/api/webhook/wasender/whatsapp
app.post('/api/webhook/wasender/whatsapp', async (req, res) => {
  try {
    // Validar Webhook Secret (WaSenderAPI usa X-Webhook-Signature)
    const webhookSecret = process.env.WASENDER_WEBHOOK_SECRET || '8f3e09312a522a821f1fc24dec0c9428';
    const receivedSecret = req.headers['x-webhook-signature'] ||
                          req.headers['x-webhook-secret'] ||
                          req.headers['authorization']?.replace('Bearer ', '') ||
                          req.body.secret ||
                          req.query.secret;

    // Log para debug
    console.log('🔐 Webhook headers:', {
      'x-webhook-signature': req.headers['x-webhook-signature'],
      'x-webhook-secret': req.headers['x-webhook-secret'],
      'authorization': req.headers['authorization']
    });

    if (receivedSecret && receivedSecret !== webhookSecret) {
      console.log('❌ Webhook WaSenderAPI: Secret inválido', { received: receivedSecret, expected: webhookSecret });
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    console.log('📥 Webhook WaSenderAPI recebido:', JSON.stringify(req.body, null, 2));

    // Responder ao teste de webhook do WaSenderAPI
    if (req.body.event === 'webhook.test' || req.body.data?.test === true) {
      console.log('✅ Teste de webhook WaSenderAPI recebido com sucesso');
      return res.status(200).json({ success: true, message: 'Webhook test received successfully' });
    }

    // WaSenderAPI envia dados no formato:
    // { data: { messages: [{ key: { remoteJid: "..." }, message: { conversation: "..." } }] } }
    let fromPhone = null;
    let messageText = null;
    let messageType = null;

    // Formato oficial do WaSenderAPI (messages.upsert / messages.received)
    if (req.body.data?.messages && req.body.data.messages.length > 0) {
      const msg = req.body.data.messages[0];

      // Ignorar mensagens enviadas por nós (fromMe: true)
      if (msg.key?.fromMe === true) {
        console.log('⚠️ Ignorando mensagem enviada por nós');
        return res.status(200).json({ success: true, message: 'Mensagem própria ignorada' });
      }

      // Extrair telefone do remoteJid (remove @s.whatsapp.net ou @c.us)
      fromPhone = msg.key?.remoteJid?.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');

      // Extrair texto da mensagem (pode estar em diferentes campos)
      messageText = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption ||
                   msg.message?.documentMessage?.caption ||
                   msg.message?.buttonsResponseMessage?.selectedDisplayText ||
                   msg.message?.listResponseMessage?.title;

      messageType = 'message';
    }
    // Formato alternativo (campos diretos no body)
    else {
      const { from, phone, sender, message, body, text, type } = req.body;
      fromPhone = from || phone || sender || req.body.fromPhone;
      messageText = message || body || text || req.body.messageText;
      messageType = type;
    }

    if (!fromPhone || !messageText) {
      console.log('⚠️ Webhook WaSenderAPI: dados incompletos', { fromPhone, messageText });
      return res.status(200).json({ success: true, message: 'Dados incompletos' });
    }

    // Ignorar mensagens de status/notificação
    if (messageType && messageType !== 'message' && messageType !== 'text') {
      console.log(`⚠️ Ignorando mensagem do tipo: ${messageType}`);
      return res.status(200).json({ success: true, message: 'Tipo ignorado' });
    }

    console.log(`📱 WhatsApp recebido de ${fromPhone}: ${messageText}`);

    // Salvar a resposta no banco
    const result = await saveReplyFromWebhook(fromPhone, messageText, 'whatsapp');

    if (result) {
      console.log(`✅ Resposta WhatsApp salva para usuário ${result.user?.email || result.originalMessage?.user_id}`);
    } else {
      console.log(`⚠️ Nenhuma mensagem original encontrada para ${fromPhone}`);
    }

    res.status(200).json({ success: true, message: 'Resposta processada' });

  } catch (error) {
    console.error('❌ Erro no webhook WaSenderAPI:', error);
    res.status(200).json({ success: false, error: error.message });
  }
});

// Webhook genérico para outros provedores de WhatsApp
// Pode ser usado para Meta/Facebook Business API, Baileys, WaSenderAPI, etc.
app.post('/api/webhook/whatsapp', async (req, res) => {
  try {
    console.log('📥 Webhook WhatsApp genérico recebido:', JSON.stringify(req.body, null, 2));

    // Tentar extrair dados de diferentes formatos
    let fromPhone, messageText;

    // Formato WaSenderAPI (messages.upsert / messages.received)
    if (req.body.data?.messages && req.body.data.messages.length > 0) {
      const msg = req.body.data.messages[0];

      // Ignorar mensagens enviadas por nós
      if (msg.key?.fromMe === true) {
        console.log('⚠️ Ignorando mensagem enviada por nós');
        return res.status(200).json({ success: true, message: 'Mensagem própria ignorada' });
      }

      fromPhone = msg.key?.remoteJid;
      messageText = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption;
    }
    // Formato Meta/Facebook Business API
    else if (req.body.entry && req.body.entry[0]?.changes) {
      const change = req.body.entry[0].changes[0];
      if (change.value?.messages) {
        const msg = change.value.messages[0];
        fromPhone = msg.from;
        messageText = msg.text?.body || msg.body;
      }
    }
    // Formato genérico
    else {
      fromPhone = req.body.from || req.body.phone || req.body.sender || req.body.remoteJid;
      messageText = req.body.message || req.body.body || req.body.text || req.body.content;
    }

    if (!fromPhone || !messageText) {
      console.log('⚠️ Webhook WhatsApp: dados incompletos');
      return res.status(200).json({ success: true });
    }

    // Limpar número de telefone
    fromPhone = fromPhone.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');

    console.log(`📱 WhatsApp recebido de ${fromPhone}: ${messageText}`);

    const result = await saveReplyFromWebhook(fromPhone, messageText, 'whatsapp');

    if (result) {
      console.log(`✅ Resposta salva para usuário ${result.user?.email || result.originalMessage?.user_id}`);
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Erro no webhook WhatsApp:', error);
    res.status(200).json({ success: false });
  }
});

// Verificação do webhook (necessário para Meta/Facebook)
app.get('/api/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'zapanonimo_webhook_token';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('✅ Webhook verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Falha na verificação do webhook');
    res.sendStatus(403);
  }
});



app.post('/api/send-whatsapp', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Telefone e mensagem são obrigatórios' });
  }

  try {
    await useCredit(req.userId, phone, message, 'whatsapp');

    const result = await whatsappService.sendMessage(phone, message);

    const user = await getUserById(req.userId);

    res.json({
      success: true,
      data: result.data,
      whatsapp_credits: user.whatsapp_credits,
      sms_credits: user.sms_credits,
      tokenUsed: result.tokenUsed,
      attempts: result.attempts
    });

  } catch (error) {
    if (error.message.includes('Créditos') && error.message.includes('insuficientes')) {
      res.status(402).json({
        success: false,
        error: error.message,
        needsPayment: true
      });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});


app.post('/api/test-whatsapp', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Telefone e mensagem são obrigatórios' });
  }

  try {
    console.log('🧪 Testando envio para:', phone);
    console.log('📝 Mensagem:', message);

    const result = await whatsappService.sendMessage(phone, message);

    console.log('✅ Teste concluído com sucesso');

    res.json({
      success: true,
      data: result.data,
      tokenUsed: result.tokenUsed,
      attempts: result.attempts,
      note: 'Teste realizado SEM debitar crédito'
    });
  } catch (error) {
    console.error('❌ Erro no teste:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/whatsapp/stats', authMiddleware, async (req, res) => {
  try {
    const stats = whatsappService.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/whatsapp/test-all', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Telefone e mensagem são obrigatórios' });
  }

  try {
    const results = await whatsappService.testAllTokens(phone, message);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/send-sms', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Telefone e mensagem são obrigatórios' });
  }

  try {
    await useCredit(req.userId, phone, message, 'sms');

    const result = await smsService.sendSMS(phone, message);

    const user = await getUserById(req.userId);

    res.json({
      success: true,
      data: result,
      whatsapp_credits: user.whatsapp_credits,
      sms_credits: user.sms_credits
    });

  } catch (error) {
    if (error.message.includes('Créditos') && error.message.includes('insuficientes')) {
      res.status(402).json({
        success: false,
        error: error.message,
        needsPayment: true
      });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

app.post('/api/send-bulk-sms', authMiddleware, async (req, res) => {
  const { phoneNumbers, message } = req.body;

  if (!phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ success: false, error: 'Lista de telefones inválida' });
  }

  if (!message) {
    return res.status(400).json({ success: false, error: 'Mensagem é obrigatória' });
  }

  try {

    const user = await getUserById(req.userId);
    if (user.sms_credits < phoneNumbers.length) {
      return res.status(402).json({
        success: false,
        error: `Créditos de SMS insuficientes. Você tem ${user.sms_credits} créditos mas precisa de ${phoneNumbers.length}`,
        needsPayment: true
      });
    }

    const result = await smsService.sendBulkSMS(phoneNumbers, message);

    for (let i = 0; i < result.success; i++) {
      await useCredit(req.userId, phoneNumbers[i], message, 'sms');
    }

    const updatedUser = await getUserById(req.userId);

    res.json({
      success: true,
      data: result,
      whatsapp_credits: updatedUser.whatsapp_credits,
      sms_credits: updatedUser.sms_credits
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/test-sms', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Telefone e mensagem são obrigatórios' });
  }

  try {
    console.log('🧪 Testando envio de SMS para:', phone);
    console.log('📝 Mensagem:', message);

    const result = await smsService.sendSMS(phone, message);

    console.log('✅ SMS de teste enviado com sucesso');

    res.json({
      success: true,
      data: result,
      note: 'Teste realizado SEM debitar crédito'
    });
  } catch (error) {
    console.error('❌ Erro no teste de SMS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/sms/balance', authMiddleware, async (req, res) => {
  try {
    const balance = await smsService.checkBalance();
    res.json({ success: true, balance });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remover servir arquivos estáticos - agora é só API
// app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

app.listen(PORT, HOST, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  console.log(`🚀 Servidor rodando em ${baseUrl}`);
  console.log(`📊 Banco de dados: Supabase`);
  console.log(`✅ Novos usuários recebem 1 crédito grátis`);
  console.log(`📧 Email configurado: ${process.env.EMAIL_USER ? 'Sim ✓' : 'Não ✗'}`);
});
