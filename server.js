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
  'https://zapanonimo.fly.dev',
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
      const userIdStr = userId.toString();
      userSockets.set(userIdStr, socket.id);
      socket.userId = userIdStr;

      socket.join(`user:${userIdStr}`);
    }
  });


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
  const userIdStr = userId.toString();
 
  io.to(`user:${userIdStr}`).emit('new-reply', reply);
}

const { authMiddleware, generateToken } = require('./auth');
const {
  createUser,
  getUserByEmail,
  getUserByPhone,
  getUserByEmailOrPhone,
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
  resetPassword,
  generateTrackingCode,
  createPhoneVerificationCode,
  verifyPhoneCode,
  isPhoneVerified,
  logModerationEvent,
  deleteUserData,
  exportUserData,
  scheduleDataCleanup,
  getFavorites,
  addFavorite,
  deleteFavorite,
  isFavorite
} = require('./database');


function getClientInfo(req) {
  return {
    ipAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] ||
               req.socket?.remoteAddress ||
               req.ip ||
               'unknown',
    userAgent: req.headers['user-agent'] || 'unknown'
  };
}
const {
  sendVerificationEmail,
  resendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail
} = require('./email-service');
const {
  createPixPayment,
  createCardPreference,
  getPaymentStatus,
  parseWebhookData,
  isPaymentApproved,
  isPaymentPending
} = require('./mercadopago-payment');
const { getWhatsAppService } = require('./whatsapp-service');
const smsService = require('./sms-service');
const { getModerationService } = require('./moderation-service');


app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sua-chave-secreta-de-sessao',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

const whatsappService = getWhatsAppService();
const moderationService = getModerationService();


whatsappService.setSocketIO(io);


whatsappService.loadStats().then(() => {

  whatsappService.initialize();
}).catch(err => {
  console.error('[Server] Erro ao carregar stats:', err);
  whatsappService.initialize();
});


const frontendPath = path.join(__dirname, './frontend');


const cleanRoutes = ['admin', 'index', 'verify-email', 'reset-password', 'payment-success', 'payment-failure', 'payment-pending', 'payment-instructions', 'privacy', 'terms'];

cleanRoutes.forEach(route => {
  app.get(`/${route}`, (req, res) => {
    res.sendFile(path.join(frontendPath, `${route}.html`));
  });
});


app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});


app.use(express.static(frontendPath));


app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email e senha sao obrigatorios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Senha deve ter no minimo 6 caracteres' });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Email ja cadastrado' });
    }

    const result = await createUser(email, password, null);
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


app.post('/api/register-phone', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ success: false, error: 'Telefone e senha sao obrigatorios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Senha deve ter no minimo 6 caracteres' });
    }

   
    const normalizedPhone = phone.replace(/\D/g, '');

 
    if (normalizedPhone.length < 10 || normalizedPhone.length > 13) {
      return res.status(400).json({ success: false, error: 'Telefone invalido. Use formato: 11999999999' });
    }

    const existingUser = await getUserByPhone(normalizedPhone);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Telefone ja cadastrado' });
    }

  
    const result = await createUser(null, password, normalizedPhone);

   
    const verificationCode = await createPhoneVerificationCode(result.id, normalizedPhone);

   
    const fullPhone = normalizedPhone.startsWith('55') ? '+' + normalizedPhone : '+55' + normalizedPhone;
    try {
      const verificationMessage = `🔐 *Código de Verificação Zap Anônimo*\n\nSeu código: *${verificationCode}*\n\n⏱️ Válido por 10 minutos.\n\n_Não compartilhe este código com ninguém._`;
      await whatsappService.sendMessage(fullPhone, verificationMessage);
    } catch (whatsappError) {
      console.error('[Register] Erro ao enviar WhatsApp:', whatsappError);
      return res.status(500).json({ success: false, error: 'Erro ao enviar codigo por WhatsApp. Tente novamente.' });
    }

    res.json({
      success: true,
      userId: result.id,
      phone: normalizedPhone,
      message: 'Codigo enviado! Verifique seu WhatsApp para ativar a conta.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/verify-phone', async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ success: false, error: 'Telefone e codigo sao obrigatorios' });
    }

    const normalizedPhone = phone.replace(/\D/g, '');
    const userId = await verifyPhoneCode(normalizedPhone, code);

 
    const user = await getUserById(userId);
    const token = generateToken(user.id);

    res.json({
      success: true,
      message: 'Telefone verificado com sucesso!',
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        whatsapp_credits: user.whatsapp_credits,
        sms_credits: user.sms_credits
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});


app.post('/api/resend-phone-code', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Telefone e obrigatorio' });
    }

    const normalizedPhone = phone.replace(/\D/g, '');
    const user = await getUserByPhone(normalizedPhone);

    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuario nao encontrado' });
    }

    if (user.phone_verified) {
      return res.status(400).json({ success: false, error: 'Telefone ja verificado' });
    }

   
    const verificationCode = await createPhoneVerificationCode(user.id, normalizedPhone);

   
    const fullPhone = normalizedPhone.startsWith('55') ? '+' + normalizedPhone : '+55' + normalizedPhone;
    try {
      const verificationMessage = `🔐 *Código de Verificação Zap Anônimo*\n\nSeu código: *${verificationCode}*\n\n⏱️ Válido por 10 minutos.\n\n_Não compartilhe este código com ninguém._`;
      await whatsappService.sendMessage(fullPhone, verificationMessage);
    } catch (whatsappError) {
      return res.status(500).json({ success: false, error: 'Erro ao enviar codigo por WhatsApp' });
    }

    res.json({
      success: true,
      message: 'Codigo reenviado! Verifique seu WhatsApp.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    const identifier = email || phone;

    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'Email/telefone e senha sao obrigatorios' });
    }

 
    let user;
    if (phone) {
      const normalizedPhone = phone.replace(/\D/g, '');
      user = await getUserByPhone(normalizedPhone);
    } else {
      user = await getUserByEmail(email);
    }

    if (!user) {
      return res.status(401).json({ success: false, error: 'Credenciais incorretas' });
    }

    const isValid = await verifyPassword(password, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Credenciais incorretas' });
    }

   
    const isEmailUser = user.email && !user.phone;
    const isPhoneUser = user.phone && !user.email;
    const hasBoth = user.email && user.phone;

    if (isEmailUser && !user.email_verified) {
      return res.status(403).json({
        success: false,
        error: 'Email nao verificado. Verifique sua caixa de entrada.',
        emailNotVerified: true
      });
    }

    if (isPhoneUser && !user.phone_verified) {
      return res.status(403).json({
        success: false,
        error: 'Telefone nao verificado. Verifique seu WhatsApp.',
        phoneNotVerified: true,
        phone: user.phone
      });
    }

    if (hasBoth && !user.email_verified && !user.phone_verified) {
      return res.status(403).json({
        success: false,
        error: 'Conta nao verificada.',
        emailNotVerified: !user.email_verified,
        phoneNotVerified: !user.phone_verified
      });
    }

    const token = generateToken(user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email || null,
        phone: user.phone || null,
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



app.get('/api/favorites', authMiddleware, async (req, res) => {
  try {
    const favorites = await getFavorites(req.userId);
    res.json({ success: true, favorites });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/favorites', authMiddleware, async (req, res) => {
  try {
    const { name, phone } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
    }

    if (!phone || phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ success: false, error: 'Telefone inválido' });
    }

    const result = await addFavorite(req.userId, name, phone);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/favorites/:id', authMiddleware, async (req, res) => {
  try {
    const favoriteId = parseInt(req.params.id);

    if (!favoriteId) {
      return res.status(400).json({ success: false, error: 'ID inválido' });
    }

    const result = await deleteFavorite(req.userId, favoriteId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/favorites/check/:phone', authMiddleware, async (req, res) => {
  try {
    const isPhoneFavorite = await isFavorite(req.userId, req.params.phone);
    res.json({ success: true, isFavorite: isPhoneFavorite });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== MERCADO PAGO - PAGAMENTOS ==========

// Criar pagamento PIX
app.post('/api/create-pix', authMiddleware, async (req, res) => {
  try {
    const { quantity } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ success: false, error: 'Quantidade inválida' });
    }

    const user = await getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    const userEmail = user.email || `user${user.id}@zapanonimo.com`;
    const result = await createPixPayment(req.userId, quantity, userEmail);

    res.json({
      success: true,
      paymentId: result.paymentId,
      qrCode: result.qrCode,
      qrCodeBase64: result.qrCodeBase64,
      ticketUrl: result.ticketUrl,
      expirationDate: result.expirationDate
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Erro ao gerar PIX: ' + error.message
    });
  }
});

// Criar pagamento com cartao (redireciona para Mercado Pago)
app.post('/api/create-card-payment', authMiddleware, async (req, res) => {
  try {
    const { quantity } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ success: false, error: 'Quantidade inválida' });
    }

    const user = await getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    const userEmail = user.email || null;
    const result = await createCardPreference(req.userId, quantity, userEmail);

    res.json({
      success: true,
      preferenceId: result.preferenceId,
      checkoutUrl: result.initPoint
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Erro ao criar pagamento: ' + error.message
    });
  }
});

// Webhook do Mercado Pago
const processedPayments = new Set();

app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
    console.log('[MercadoPago Webhook] Recebido:', JSON.stringify(req.body));

    const webhookData = parseWebhookData(req.body);

    if (webhookData && webhookData.type === 'payment') {
      const paymentId = webhookData.paymentId;

      if (processedPayments.has(paymentId)) {
        console.log('[MercadoPago Webhook] Pagamento ja processado:', paymentId);
        return res.json({ received: true });
      }

      const paymentInfo = await getPaymentStatus(paymentId);

      if (isPaymentApproved(paymentInfo.status)) {
        const metadata = paymentInfo.metadata || {};
        let userId, quantity, creditType;

        // Tentar pegar do metadata (PIX)
        if (metadata.user_id) {
          userId = parseInt(metadata.user_id);
          quantity = parseInt(metadata.quantity);
          creditType = metadata.credit_type || 'whatsapp';
        }
        // Tentar pegar do external_reference (Cartao)
        else if (paymentInfo.externalReference) {
          try {
            const extRef = JSON.parse(paymentInfo.externalReference);
            userId = parseInt(extRef.userId);
            quantity = parseInt(extRef.quantity);
            creditType = extRef.creditType || 'whatsapp';
          } catch (e) {
            console.error('[MercadoPago Webhook] Erro ao parsear external_reference:', e);
          }
        }

        if (userId && quantity) {
          // Promocao: ganhe em dobro!
          const bonusQuantity = quantity * 2;
          const price = quantity; // R$ 1,00 por unidade
          await addCredits(userId, bonusQuantity, price, creditType);

          processedPayments.add(paymentId);
          setTimeout(() => processedPayments.delete(paymentId), 60 * 60 * 1000);

          console.log(`[MercadoPago Webhook] Creditos adicionados: ${bonusQuantity} para usuario ${userId}`);
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('[MercadoPago Webhook] Erro:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// Verificar status do pagamento PIX
app.get('/api/verify-payment/:paymentId', authMiddleware, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentInfo = await getPaymentStatus(paymentId);

    // Se pagamento aprovado e ainda nao processado, adicionar creditos
    if (isPaymentApproved(paymentInfo.status) && !processedPayments.has(paymentId)) {
      const metadata = paymentInfo.metadata || {};

      if (metadata.user_id && parseInt(metadata.user_id) === req.userId) {
        const quantity = parseInt(metadata.quantity);
        const creditType = metadata.credit_type || 'whatsapp';

        // Promocao: ganhe em dobro!
        const bonusQuantity = quantity * 2;
        const price = quantity;
        await addCredits(req.userId, bonusQuantity, price, creditType);

        processedPayments.add(paymentId);
        setTimeout(() => processedPayments.delete(paymentId), 60 * 60 * 1000);
      }
    }

    res.json({
      success: true,
      status: paymentInfo.status,
      paid: isPaymentApproved(paymentInfo.status),
      pending: isPaymentPending(paymentInfo.status)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== FIM MERCADO PAGO ==========

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
    console.error('[Webhook Twilio] Erro ao processar:', error);
    res.status(200).send('<Response></Response>');
  }
});

app.post('/api/webhook/wasender/whatsapp', async (req, res) => {
  try {
    const webhookSecret = process.env.WASENDER_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.warn('[Webhook] WASENDER_WEBHOOK_SECRET não configurado - webhook desprotegido');
    }
    const receivedSecret = req.headers['x-webhook-signature'] ||
                          req.headers['x-webhook-secret'] ||
                          req.headers['authorization']?.replace('Bearer ', '') ||
                          req.body.secret ||
                          req.query.secret;


    if (webhookSecret && receivedSecret && receivedSecret !== webhookSecret) {
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
    console.error('[Webhook WASender] Erro ao processar:', error);
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
    console.error('[Webhook WhatsApp] Erro ao processar:', error);
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
  const clientInfo = getClientInfo(req);

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Telefone e mensagem são obrigatórios' });
  }

  try {
   
    const userBefore = await getUserById(req.userId);
    if (userBefore.whatsapp_credits < 1) {
      return res.status(402).json({
        success: false,
        error: 'Créditos de WhatsApp insuficientes',
        needsPayment: true
      });
    }

    
    const moderation = await moderationService.validateAndRecord(message, req.userId, phone);

   
    await logModerationEvent({
      userId: req.userId,
      message: message,
      action: moderation.allowed ? 'allowed' : 'blocked',
      category: moderation.category,
      riskScore: moderation.riskScore || 0,
      ipAddress: clientInfo.ipAddress,
      userAgent: clientInfo.userAgent,
      targetPhone: phone,
      channel: 'whatsapp',
      detectedTypes: moderation.detectedTypes || [],
      matchedWord: moderation.matchedWord || null
    });

    if (!moderation.allowed) {
      return res.status(400).json({
        success: false,
        error: 'Mensagem bloqueada por conteúdo inadequado',
        moderationReason: moderation.reason,
        moderationCategory: moderation.category
      });
    }

   
    const trackingCode = generateTrackingCode();
    const messageWithCode = `${message}\n\n[Cód: ${trackingCode}]`;

   
    const result = await whatsappService.sendMessage(phone, messageWithCode);


    await useCredit(req.userId, phone, message, 'whatsapp', trackingCode);

    const user = await getUserById(req.userId);

    res.json({
      success: true,
      data: result.data,
      whatsapp_credits: user.whatsapp_credits,
      sms_credits: user.sms_credits,
      tokenUsed: result.tokenUsed,
      attempts: result.attempts,
      trackingCode: trackingCode
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


app.post('/api/send-whatsapp-audio', authMiddleware, async (req, res) => {
  const { phone, audioBase64, mimetype, caption } = req.body;

  if (!phone || !audioBase64) {
    return res.status(400).json({ success: false, error: 'Telefone e áudio são obrigatórios' });
  }


  const allowedMimetypes = [
    'audio/ogg',
    'audio/ogg; codecs=opus',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/wav',
    'audio/webm',
    'audio/webm; codecs=opus'
  ];

  const audioMimetype = mimetype || 'audio/ogg';
  if (!allowedMimetypes.some(m => audioMimetype.startsWith(m.split(';')[0]))) {
    return res.status(400).json({ success: false, error: 'Tipo de áudio não suportado' });
  }

 
  const estimatedSize = (audioBase64.length * 3) / 4;
  if (estimatedSize > 16 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'Arquivo muito grande. Máximo: 16MB' });
  }

  try {
 
    const userBefore = await getUserById(req.userId);
    if (userBefore.whatsapp_credits < 1) {
      return res.status(402).json({
        success: false,
        error: 'Créditos de WhatsApp insuficientes',
        needsPayment: true
      });
    }

   
    const trackingCode = generateTrackingCode();
    const captionWithCode = caption ? `${caption}\n\n[Cód: ${trackingCode}]` : `[Cód: ${trackingCode}]`;

   
    const result = await whatsappService.sendAudio(phone, audioBase64, audioMimetype, captionWithCode);

   
    await useCredit(req.userId, phone, '[Mensagem de áudio]', 'whatsapp', trackingCode);

    const user = await getUserById(req.userId);

    res.json({
      success: true,
      data: result.data,
      whatsapp_credits: user.whatsapp_credits,
      sms_credits: user.sms_credits,
      tokenUsed: result.tokenUsed,
      attempts: result.attempts,
      trackingCode: trackingCode
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

app.get('/api/whatsapp/available', authMiddleware, async (req, res) => {
  try {
    
    const hasClient = whatsappService.client !== null;
    const statusConnected = whatsappService.status === 'connected';


    const isAvailable = statusConnected || hasClient;

    res.json({
      success: true,
      available: isAvailable,
      status: whatsappService.status,
      hasClient: hasClient
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
  const clientInfo = getClientInfo(req);

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Telefone e mensagem são obrigatórios' });
  }

  try {
  
    const moderation = await moderationService.validateAndRecord(message, req.userId, phone);

   
    await logModerationEvent({
      userId: req.userId,
      message: message,
      action: moderation.allowed ? 'allowed' : 'blocked',
      category: moderation.category,
      riskScore: moderation.riskScore || 0,
      ipAddress: clientInfo.ipAddress,
      userAgent: clientInfo.userAgent,
      targetPhone: phone,
      channel: 'sms',
      detectedTypes: moderation.detectedTypes || [],
      matchedWord: moderation.matchedWord || null
    });

    if (!moderation.allowed) {
      return res.status(400).json({
        success: false,
        error: 'Mensagem bloqueada por conteúdo inadequado',
        moderationReason: moderation.reason,
        moderationCategory: moderation.category
      });
    }

    const trackingCode = generateTrackingCode();
    const messageWithCode = `${message}\n\n[Cód: ${trackingCode}]`;

    await useCredit(req.userId, phone, message, 'sms', trackingCode);

    const result = await smsService.sendSMS(phone, messageWithCode);

    const user = await getUserById(req.userId);

    res.json({
      success: true,
      data: result,
      whatsapp_credits: user.whatsapp_credits,
      sms_credits: user.sms_credits,
      trackingCode: trackingCode
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

    const moderation = await moderationService.validateMessage(message);
    if (!moderation.allowed) {
      return res.status(400).json({
        success: false,
        error: 'Mensagem bloqueada por conteúdo inadequado',
        moderationReason: moderation.reason,
        moderationCategory: moderation.category
      });
    }

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


const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) {
  console.error('[Admin] AVISO: ADMIN_PASS não configurado no .env');
}
const jwt = require('jsonwebtoken');
const ADMIN_JWT_SECRET = process.env.JWT_SECRET || 'admin-secret-key';


const adminAuthMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token não fornecido' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (decoded.isAdmin) {
      next();
    } else {
      res.status(401).json({ success: false, error: 'Não autorizado' });
    }
  } catch (error) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
};


app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ isAdmin: true }, ADMIN_JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, message: 'Login realizado com sucesso' });
  } else {
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
  }
});


app.post('/api/admin/logout', (req, res) => {
  res.json({ success: true, message: 'Logout realizado' });
});


app.get('/api/admin/check', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.json({ success: true, isAdmin: false });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    res.json({ success: true, isAdmin: decoded.isAdmin === true });
  } catch (error) {
    res.json({ success: true, isAdmin: false });
  }
});


app.get('/api/admin/whatsapp/status', adminAuthMiddleware, async (req, res) => {
  try {
    const status = await whatsappService.getStatusAsync();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/admin/whatsapp/reconnect', adminAuthMiddleware, async (req, res) => {
  try {
    await whatsappService.reconnect();
    res.json({ success: true, message: 'Reconectando WhatsApp...' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/admin/whatsapp/disconnect', adminAuthMiddleware, async (req, res) => {
  try {
    await whatsappService.disconnect();
    res.json({ success: true, message: 'WhatsApp desconectado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/admin/whatsapp/logout', adminAuthMiddleware, async (req, res) => {
  try {
    await whatsappService.logout();
    res.json({ success: true, message: 'Logout do WhatsApp realizado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



app.get('/api/user/export-data', authMiddleware, async (req, res) => {
  try {
    const result = await exportUserData(req.userId);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: 'Erro ao exportar dados: ' + result.error
      });
    }

  
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="meus-dados-${Date.now()}.json"`);
    res.json(result.data);

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.delete('/api/user/delete-account', authMiddleware, async (req, res) => {
  try {
    const { confirmEmail } = req.body;
    const user = await getUserById(req.userId);

 
    if (!confirmEmail || confirmEmail !== user.email) {
      return res.status(400).json({
        success: false,
        error: 'Por favor, confirme seu email para excluir a conta'
      });
    }

    const result = await deleteUserData(req.userId, {
      keepTransactionsForTax: true 
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: 'Erro ao excluir dados',
        details: result.errors
      });
    }

    res.json({
      success: true,
      message: 'Conta excluída com sucesso. Seus dados foram removidos conforme a LGPD.',
      deleted: result.deleted,
      anonymized: result.anonymized
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/privacy/retention-policy', (req, res) => {
  const { RETENTION_POLICY } = require('./database');
  res.json({
    success: true,
    policy: {
      messages: `${RETENTION_POLICY.messages} dias`,
      replies: `${RETENTION_POLICY.replies} dias`,
      transactions: `${RETENTION_POLICY.transactions} dias (anonimizado após exclusão de conta)`,
      logs_technical: `${RETENTION_POLICY.logs_technical} dias`,
      logs_abuse: `${RETENTION_POLICY.logs_abuse} dias (crimes e abusos são mantidos por mais tempo)`
    },
    legalNotice: 'As mensagens não exibem a identidade do remetente ao destinatário. A plataforma mantém registros técnicos conforme a lei e pode fornecê-los mediante ordem judicial.'
  });
});



const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';


scheduleDataCleanup();

server.listen(PORT, HOST, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  console.log(`[Server] Servidor rodando em ${baseUrl}`);
  console.log('[Server] Limpeza automática de dados LGPD ativada');
});
