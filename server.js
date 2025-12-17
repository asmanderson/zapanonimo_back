require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

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

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Signature', 'X-Webhook-Secret']
};

app.use(cors(corsOptions));

const io = new Server(server, {
  cors: corsOptions
});

const userSockets = new Map();

io.on('connection', (socket) => {
  socket.on('authenticate', (userId) => {
    if (userId) {
      userSockets.set(userId.toString(), socket.id);
      socket.userId = userId.toString();
    }
  });

  // Admin subscribe para receber atualizações do WhatsApp
  socket.on('admin:subscribe', () => {
    whatsappService.subscribeAdmin(socket.id);
    socket.isAdmin = true;
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      userSockets.delete(socket.userId);
    }
    if (socket.isAdmin) {
      whatsappService.unsubscribeAdmin(socket.id);
    }
  });
});

function emitNewReply(userId, reply) {
  const socketId = userSockets.get(userId.toString());
  if (socketId) {
    io.to(socketId).emit('new-reply', reply);
  }
}

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

// Passar Socket.IO para o WhatsApp Service
whatsappService.setSocketIO(io);

// Inicializar WhatsApp automaticamente ao iniciar servidor
whatsappService.initialize();

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
    } catch (emailError) {}

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
    } catch (emailError) {}

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
    const { quantity, creditType } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ success: false, error: 'Quantidade inválida' });
    }

    if (!creditType || (creditType !== 'whatsapp' && creditType !== 'sms')) {
      return res.status(400).json({ success: false, error: 'Tipo de crédito inválido' });
    }

    const user = await getUserById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    const session = await createCheckoutSession(req.userId, quantity, user.email, creditType);

    res.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url
    });
  } catch (error) {
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

      await addCredits(userId, quantity, price, creditType);
    }

    res.json({
      success: true,
      paid: session.payment_status === 'paid',
      status: session.payment_status
    });
  } catch (error) {
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

app.get('/api/replies', authMiddleware, async (req, res) => {
  try {
    const replies = await getUserReplies(req.userId);
    res.json({ success: true, replies });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, replies: [] });
  }
});

app.post('/api/webhook/twilio/sms', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const {
      From: fromPhone,
      Body: message,
      To: toPhone,
      MessageSid: messageSid
    } = req.body;

    if (!fromPhone || !message) {
      return res.status(200).send('<Response></Response>');
    }

    const result = await saveReplyFromWebhook(fromPhone, message, 'sms');

    if (result) {
      emitNewReply(result.originalMessage.user_id, {
        ...result.reply,
        original_message: result.originalMessage.message
      });
    }

    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

  } catch (error) {
    res.status(200).send('<Response></Response>');
  }
});

app.post('/api/webhook/wasender/whatsapp', async (req, res) => {
  try {
    const webhookSecret = process.env.WASENDER_WEBHOOK_SECRET || '8f3e09312a522a821f1fc24dec0c9428';
    const receivedSecret = req.headers['x-webhook-signature'] ||
                          req.headers['x-webhook-secret'] ||
                          req.headers['authorization']?.replace('Bearer ', '') ||
                          req.body.secret ||
                          req.query.secret;

    if (receivedSecret && receivedSecret !== webhookSecret) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (req.body.event === 'webhook.test' || req.body.data?.test === true) {
      return res.status(200).json({ success: true, message: 'Webhook test received successfully' });
    }

    let fromPhone = null;
    let messageText = null;
    let messageType = null;

    let msg = null;
    if (req.body.data?.messages) {
      if (Array.isArray(req.body.data.messages)) {
        msg = req.body.data.messages[0];
      } else {
        msg = req.body.data.messages;
      }
    }

    if (msg) {
      if (msg.key?.fromMe === true) {
        return res.status(200).json({ success: true, message: 'Mensagem própria ignorada' });
      }

      fromPhone = msg.key?.cleanedSenderPn ||
                 msg.key?.senderPn?.replace(/@s\.whatsapp\.net$/, '') ||
                 msg.key?.remoteJid?.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').replace(/@lid$/, '');

      messageText = msg.messageBody ||
                   msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption ||
                   msg.message?.documentMessage?.caption ||
                   msg.message?.buttonsResponseMessage?.selectedDisplayText ||
                   msg.message?.listResponseMessage?.title;

      messageType = 'message';
    } else {
      const { from, phone, sender, message, body, text, type } = req.body;
      fromPhone = from || phone || sender || req.body.fromPhone;
      messageText = message || body || text || req.body.messageText;
      messageType = type;
    }

    if (!fromPhone || !messageText) {
      return res.status(200).json({ success: true, message: 'Dados incompletos' });
    }

    if (messageType && messageType !== 'message' && messageType !== 'text') {
      return res.status(200).json({ success: true, message: 'Tipo ignorado' });
    }

    const result = await saveReplyFromWebhook(fromPhone, messageText, 'whatsapp');

    if (result) {
      emitNewReply(result.originalMessage.user_id, {
        ...result.reply,
        original_message: result.originalMessage.message
      });
    }

    res.status(200).json({ success: true, message: 'Resposta processada' });

  } catch (error) {
    res.status(200).json({ success: false, error: error.message });
  }
});

app.post('/api/webhook/whatsapp', async (req, res) => {
  try {
    let fromPhone, messageText;

    if (req.body.data?.messages && req.body.data.messages.length > 0) {
      const msg = req.body.data.messages[0];

      if (msg.key?.fromMe === true) {
        return res.status(200).json({ success: true, message: 'Mensagem própria ignorada' });
      }

      fromPhone = msg.key?.remoteJid;
      messageText = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption;
    } else if (req.body.entry && req.body.entry[0]?.changes) {
      const change = req.body.entry[0].changes[0];
      if (change.value?.messages) {
        const msg = change.value.messages[0];
        fromPhone = msg.from;
        messageText = msg.text?.body || msg.body;
      }
    } else {
      fromPhone = req.body.from || req.body.phone || req.body.sender || req.body.remoteJid;
      messageText = req.body.message || req.body.body || req.body.text || req.body.content;
    }

    if (!fromPhone || !messageText) {
      return res.status(200).json({ success: true });
    }

    fromPhone = fromPhone.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');

    const result = await saveReplyFromWebhook(fromPhone, messageText, 'whatsapp');

    if (result) {
      emitNewReply(result.originalMessage.user_id, {
        ...result.reply,
        original_message: result.originalMessage.message
      });
    }

    res.status(200).json({ success: true });

  } catch (error) {
    res.status(200).json({ success: false });
  }
});

app.get('/api/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'zapanonimo_webhook_token';

  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(challenge);
  } else {
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
    const result = await whatsappService.sendMessage(phone, message);

    res.json({
      success: true,
      data: result.data,
      tokenUsed: result.tokenUsed,
      attempts: result.attempts,
      note: 'Teste realizado SEM debitar crédito'
    });
  } catch (error) {
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
    const result = await smsService.sendSMS(phone, message);

    res.json({
      success: true,
      data: result,
      note: 'Teste realizado SEM debitar crédito'
    });
  } catch (error) {
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

// ==================== ROTAS ADMIN ====================

// Credenciais admin do .env
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// Middleware para verificar sessão admin
const adminAuthMiddleware = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    next();
  } else {
    res.status(401).json({ success: false, error: 'Não autorizado' });
  }
};

// Login admin
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    res.json({ success: true, message: 'Login realizado com sucesso' });
  } else {
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
  }
});

// Logout admin
app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true, message: 'Logout realizado' });
});

// Verificar se está logado como admin
app.get('/api/admin/check', (req, res) => {
  res.json({
    success: true,
    isAdmin: req.session && req.session.isAdmin === true
  });
});

// Status do WhatsApp
app.get('/api/admin/whatsapp/status', adminAuthMiddleware, (req, res) => {
  try {
    const status = whatsappService.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reconectar WhatsApp
app.post('/api/admin/whatsapp/reconnect', adminAuthMiddleware, async (req, res) => {
  try {
    await whatsappService.reconnect();
    res.json({ success: true, message: 'Reconectando WhatsApp...' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Desconectar WhatsApp
app.post('/api/admin/whatsapp/disconnect', adminAuthMiddleware, async (req, res) => {
  try {
    await whatsappService.disconnect();
    res.json({ success: true, message: 'WhatsApp desconectado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Logout do WhatsApp (remove sessão salva)
app.post('/api/admin/whatsapp/logout', adminAuthMiddleware, async (req, res) => {
  try {
    await whatsappService.logout();
    res.json({ success: true, message: 'Logout do WhatsApp realizado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== FIM ROTAS ADMIN ====================

const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

server.listen(PORT, HOST, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
});
