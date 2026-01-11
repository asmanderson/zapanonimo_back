require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');

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
const onlineStats = {
  totalConnections: 0,
  authenticatedUsers: new Set(),
  visitors: 0,
  lastUpdate: new Date()
};

function getOnlineStats() {
  return {
    total: onlineStats.totalConnections,
    authenticated: onlineStats.authenticatedUsers.size,
    visitors: onlineStats.totalConnections - onlineStats.authenticatedUsers.size,
    lastUpdate: onlineStats.lastUpdate
  };
}

function broadcastOnlineStats() {
  const stats = getOnlineStats();
  io.emit('online:stats', stats);
}

io.on('connection', (socket) => {

  onlineStats.totalConnections++;
  onlineStats.lastUpdate = new Date();
  broadcastOnlineStats();

  socket.on('authenticate', (userId) => {
    if (userId) {
      const userIdStr = userId.toString();
      userSockets.set(userIdStr, socket.id);
      socket.userId = userIdStr;
      onlineStats.authenticatedUsers.add(userIdStr);
      onlineStats.lastUpdate = new Date();
      broadcastOnlineStats();

      socket.join(`user:${userIdStr}`);
    }
  });


  socket.on('admin:subscribe', () => {
    whatsappService.subscribeAdmin(socket.id);
    socket.isAdmin = true;

    socket.emit('online:stats', getOnlineStats());
  });

  socket.on('disconnect', () => {

    onlineStats.totalConnections = Math.max(0, onlineStats.totalConnections - 1);

    if (socket.userId) {
      userSockets.delete(socket.userId);
      onlineStats.authenticatedUsers.delete(socket.userId);
    }
    if (socket.isAdmin) {
      whatsappService.unsubscribeAdmin(socket.id);
    }

    onlineStats.lastUpdate = new Date();
    broadcastOnlineStats();
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
  getUserByCpf,
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
  createPasswordResetCodeByPhone,
  resetPasswordByPhone,
  logModerationEvent,
  deleteUserData,
  exportUserData,
  scheduleDataCleanup,
  getFavorites,
  addFavorite,
  deleteFavorite,
  isFavorite,
  supabase,
  getAnnouncement,
  saveAnnouncement,
  deleteAnnouncement,
  logAccess,
  getAccessStats,
  getRecentAccesses,
  blockUser,
  unblockUser,
  isBlocked,
  getBlockedByUser,
  getPendingBlockNotifications,
  markBlockAsNotified,
  createNotification,
  getUserNotifications,
  getUnreadNotificationsCount,
  markNotificationAsRead,
  markAllNotificationsAsRead
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
  sendPasswordResetEmail,
  sendContactEmail
} = require('./email-service');
const {
  createPixPayment,
  getPaymentStatus,
  parseWebhookData,
  isPaymentApproved,
  isPaymentPending
} = require('./mercadopago-payment');
const {
  createCheckoutSession,
  verifySession,
  isPaymentApproved: isStripePaymentApproved,
  constructWebhookEvent
} = require('./stripe-payment');
const { getWhatsAppService } = require('./whatsapp-service');

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


const cleanRoutes = ['admin', 'index', 'verify-email', 'reset-password', 'payment-success', 'payment-failure', 'payment-pending', 'payment-instructions', 'privacy', 'terms', 'fale-conosco'];

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
    const { email, password, name, cpf } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email e senha sao obrigatorios' });
    }

    if (!name || name.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Nome deve ter pelo menos 3 caracteres' });
    }

    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ success: false, error: 'CPF invalido' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Senha deve ter no minimo 6 caracteres' });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Email ja cadastrado' });
    }

    
    const existingCpf = await getUserByCpf(cpf);
    if (existingCpf) {
      return res.status(400).json({ success: false, error: 'CPF ja cadastrado' });
    }

    const result = await createUser(email, password, null, name.trim(), cpf);
    const verificationToken = await createVerificationToken(result.id);

    try {
      await sendVerificationEmail(email, verificationToken, name.trim());
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
    const { phone, password, name, cpf } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ success: false, error: 'Telefone e senha sao obrigatorios' });
    }

    if (!name || name.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Nome deve ter pelo menos 3 caracteres' });
    }

    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ success: false, error: 'CPF invalido' });
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

  
    const existingCpf = await getUserByCpf(cpf);
    if (existingCpf) {
      return res.status(400).json({ success: false, error: 'CPF ja cadastrado' });
    }

    const result = await createUser(null, password, normalizedPhone, name.trim(), cpf);


    const verificationCode = await createPhoneVerificationCode(result.id, normalizedPhone);


    const fullPhone = normalizedPhone.startsWith('55') ? '+' + normalizedPhone : '+55' + normalizedPhone;
    const firstName = name ? name.trim().split(' ')[0] : '';
    try {
      const verificationMessage = `🔐 *Código de Verificação Zap Anônimo*\n\nOlá${firstName ? ', ' + firstName : ''}!\n\nSeu código: *${verificationCode}*\n\n⏱️ Válido por 10 minutos.\n\n_Não compartilhe este código com ninguém._`;
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
        name: user.name || null,
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
    const firstName = user.name ? user.name.split(' ')[0] : '';
    try {
      const verificationMessage = `🔐 *Código de Verificação Zap Anônimo*\n\nOlá${firstName ? ', ' + firstName : ''}!\n\nSeu código: *${verificationCode}*\n\n⏱️ Válido por 10 minutos.\n\n_Não compartilhe este código com ninguém._`;
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
        name: user.name || null,
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
      await sendWelcomeEmail(user.email, user.name || '');
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
    await resendVerificationEmail(email, verificationToken, user.name || '');

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


app.post('/api/forgot-password-phone', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Telefone é obrigatório' });
    }

   
    const normalizedPhone = phone.replace(/\D/g, '');
    const fullPhone = normalizedPhone.startsWith('55') ? `+${normalizedPhone}` : `+55${normalizedPhone}`;

    const user = await getUserByPhone(fullPhone);
    if (!user) {
    
      return res.json({
        success: true,
        message: 'Se o telefone estiver cadastrado, você receberá um código via WhatsApp.'
      });
    }

    const verificationCode = await createPasswordResetCodeByPhone(user.id, fullPhone);
    const firstName = user.name ? user.name.split(' ')[0] : '';

    try {
      await whatsappService.sendMessage(
        fullPhone.replace('+', ''),
        `🔐 *Recuperação de Senha - Zap Anônimo*\n\nOlá${firstName ? ', ' + firstName : ''}!\n\nSeu código de recuperação é: *${verificationCode}*\n\n⏰ Este código expira em 10 minutos.\n\n⚠️ Se você não solicitou a recuperação de senha, ignore esta mensagem.`
      );
    } catch (whatsappError) {
      console.error('Erro ao enviar código via WhatsApp:', whatsappError);
      return res.status(500).json({ success: false, error: 'Erro ao enviar código via WhatsApp' });
    }

    res.json({
      success: true,
      message: 'Código de recuperação enviado para seu WhatsApp!',
      phone: fullPhone
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/reset-password-phone', async (req, res) => {
  try {
    const { phone, code, password } = req.body;

    if (!phone || !code || !password) {
      return res.status(400).json({ success: false, error: 'Telefone, código e senha são obrigatórios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Senha deve ter no mínimo 6 caracteres' });
    }

  
    const normalizedPhone = phone.replace(/\D/g, '');
    const fullPhone = normalizedPhone.startsWith('55') ? `+${normalizedPhone}` : `+55${normalizedPhone}`;

    await resetPasswordByPhone(fullPhone, code, password);

    res.json({
      success: true,
      message: 'Senha redefinida com sucesso!'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});


app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Todos os campos são obrigatórios'
      });
    }


    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Por favor, insira um email válido'
      });
    }

 
    if (message.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'A mensagem deve ter pelo menos 10 caracteres'
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        success: false,
        error: 'A mensagem não pode exceder 5000 caracteres'
      });
    }

 
    await sendContactEmail(name, email, subject, message);


    res.json({
      success: true,
      message: 'Mensagem enviada com sucesso! Responderemos em breve.'
    });
  } catch (error) {
    console.error('[Contact] Erro ao enviar mensagem de contato:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao enviar mensagem. Tente novamente mais tarde.'
    });
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


const phoneUpdateVerifications = new Map();


app.post('/api/user/send-phone-verification', authMiddleware, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Telefone é obrigatório' });
    }

    const normalizedPhone = phone.replace(/\D/g, '');

    if (normalizedPhone.length < 10 || normalizedPhone.length > 13) {
      return res.status(400).json({ success: false, error: 'Telefone inválido' });
    }

  
    const existingUser = await getUserByPhone(normalizedPhone);
    if (existingUser && existingUser.id !== req.userId) {
      return res.status(400).json({ success: false, error: 'Este telefone já está cadastrado por outro usuário' });
    }

  
    const code = Math.floor(100000 + Math.random() * 900000).toString();

   
    const key = `${req.userId}_${normalizedPhone}`;
    phoneUpdateVerifications.set(key, {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
      phone: normalizedPhone
    });

 
    const fullPhone = normalizedPhone.startsWith('55') ? '+' + normalizedPhone : '+55' + normalizedPhone;
    const user = await getUserById(req.userId);
    const firstName = user.name ? user.name.split(' ')[0] : '';

    const verificationMessage = `🔐 *Verificação de Telefone - Zap Anônimo*\n\nOlá${firstName ? ', ' + firstName : ''}!\n\nSeu código para adicionar este telefone à sua conta: *${code}*\n\n⏱️ Válido por 10 minutos.\n\n_Não compartilhe este código com ninguém._`;

    await whatsappService.sendMessage(fullPhone, verificationMessage);

    res.json({ success: true, message: 'Código enviado com sucesso' });
  } catch (error) {
    console.error('[PhoneVerification] Erro:', error);
    res.status(500).json({ success: false, error: error.message || 'Erro ao enviar código' });
  }
});


app.post('/api/user/verify-phone-update', authMiddleware, async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ success: false, error: 'Telefone e código são obrigatórios' });
    }

    const normalizedPhone = phone.replace(/\D/g, '');
    const key = `${req.userId}_${normalizedPhone}`;

    const verification = phoneUpdateVerifications.get(key);

    if (!verification) {
      return res.status(400).json({ success: false, error: 'Código não encontrado. Solicite um novo código.' });
    }

    if (Date.now() > verification.expiresAt) {
      phoneUpdateVerifications.delete(key);
      return res.status(400).json({ success: false, error: 'Código expirado. Solicite um novo código.' });
    }

    if (verification.code !== code) {
      return res.status(400).json({ success: false, error: 'Código inválido' });
    }

   
    verification.verified = true;
    phoneUpdateVerifications.set(key, verification);

    res.json({ success: true, message: 'Código verificado com sucesso' });
  } catch (error) {
    console.error('[PhoneVerification] Erro:', error);
    res.status(500).json({ success: false, error: error.message || 'Erro ao verificar código' });
  }
});


app.get('/api/user/block-notifications', authMiddleware, async (req, res) => {
  try {
    const result = await getPendingBlockNotifications(req.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/user/block-notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const blockId = parseInt(req.params.id);
    const result = await markBlockAsNotified(blockId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/user/notifications', authMiddleware, async (req, res) => {
  try {
    const result = await getUserNotifications(req.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/user/notifications/unread-count', authMiddleware, async (req, res) => {
  try {
    const result = await getUnreadNotificationsCount(req.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/user/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const notificationId = parseInt(req.params.id);
    const result = await markNotificationAsRead(notificationId, req.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/user/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    const result = await markAllNotificationsAsRead(req.userId);
    res.json(result);
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
    const session = await createCheckoutSession(req.userId, quantity, userEmail);

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


const processedPayments = new Set();

app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
  

    const webhookData = parseWebhookData(req.body);

    if (webhookData && webhookData.type === 'payment') {
      const paymentId = webhookData.paymentId;

      if (processedPayments.has(paymentId)) {

        return res.json({ received: true });
      }

      const paymentInfo = await getPaymentStatus(paymentId);

      if (isPaymentApproved(paymentInfo.status)) {
        const metadata = paymentInfo.metadata || {};
        let userId, quantity, creditType;

  
        if (metadata.user_id) {
          userId = parseInt(metadata.user_id);
          quantity = parseInt(metadata.quantity);
          creditType = metadata.credit_type || 'whatsapp';
        }
    
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
    
          const bonusQuantity = quantity * 2;
          const price = quantity; 
          await addCredits(userId, bonusQuantity, price, creditType);

          processedPayments.add(paymentId);
          setTimeout(() => processedPayments.delete(paymentId), 60 * 60 * 1000);

   
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('[MercadoPago Webhook] Erro:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});


const processedStripeSessions = new Set();

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = constructWebhookEvent(req.body, sig);



    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const sessionId = session.id;

      if (processedStripeSessions.has(sessionId)) {
 
        return res.json({ received: true });
      }

      if (isStripePaymentApproved(session)) {
        const metadata = session.metadata || {};
        const userId = parseInt(metadata.userId);
        const quantity = parseInt(metadata.quantity);
        const creditType = metadata.creditType || 'whatsapp';

        if (userId && quantity) {
    
          const bonusQuantity = quantity * 2;
          const price = quantity;
          await addCredits(userId, bonusQuantity, price, creditType);

          processedStripeSessions.add(sessionId);
          setTimeout(() => processedStripeSessions.delete(sessionId), 60 * 60 * 1000);

      
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('[Stripe Webhook] Erro:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});


app.get('/api/verify-stripe-session/:sessionId', authMiddleware, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const session = await verifySession(sessionId);

    if (isStripePaymentApproved(session) && !processedStripeSessions.has(sessionId)) {
      const metadata = session.metadata || {};

      if (metadata.userId && parseInt(metadata.userId) === req.userId) {
        const quantity = parseInt(metadata.quantity);
        const creditType = metadata.creditType || 'whatsapp';


        const bonusQuantity = quantity * 2;
        const price = quantity;
        await addCredits(req.userId, bonusQuantity, price, creditType);

        processedStripeSessions.add(sessionId);
        setTimeout(() => processedStripeSessions.delete(sessionId), 60 * 60 * 1000);
      }
    }

    res.json({
      success: true,
      status: session.payment_status,
      paid: isStripePaymentApproved(session)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/verify-payment/:paymentId', authMiddleware, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentInfo = await getPaymentStatus(paymentId);

  
    if (isPaymentApproved(paymentInfo.status) && !processedPayments.has(paymentId)) {
      const metadata = paymentInfo.metadata || {};

      if (metadata.user_id && parseInt(metadata.user_id) === req.userId) {
        const quantity = parseInt(metadata.quantity);
        const creditType = metadata.credit_type || 'whatsapp';

     
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

  
    const msgLower = messageText.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (msgLower === 'bloquear' || msgLower === 'desbloquear') {
      const lastMessage = await findMessageByPhone(fromPhone, 'whatsapp');

      if (lastMessage) {
        if (msgLower === 'bloquear') {
          await blockUser(fromPhone, lastMessage.user_id);
          await whatsappService.sendMessage(fromPhone, '✅ Você bloqueou este remetente.\n\nVocê não receberá mais mensagens anônimas desta pessoa.\n\nPara desbloquear, envie: *desbloquear*');
        } else {
          await unblockUser(fromPhone, lastMessage.user_id);
          await whatsappService.sendMessage(fromPhone, '✅ Remetente desbloqueado.\n\nVocê voltará a receber mensagens anônimas desta pessoa.');
        }
      }
      return res.status(200).json({ success: true, message: 'Comando processado' });
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

  
    const msgLower = messageText.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (msgLower === 'bloquear' || msgLower === 'desbloquear') {
      const lastMessage = await findMessageByPhone(fromPhone, 'whatsapp');

      if (lastMessage) {
        if (msgLower === 'bloquear') {
          await blockUser(fromPhone, lastMessage.user_id);
          await whatsappService.sendMessage(fromPhone, '✅ Você bloqueou este remetente.\n\nVocê não receberá mais mensagens anônimas desta pessoa.\n\nPara desbloquear, envie: *desbloquear*');
        } else {
          await unblockUser(fromPhone, lastMessage.user_id);
          await whatsappService.sendMessage(fromPhone, '✅ Remetente desbloqueado.\n\nVocê voltará a receber mensagens anônimas desta pessoa.');
        }
      }
      return res.status(200).json({ success: true });
    }

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
  
    const blocked = await isBlocked(phone, req.userId);
    if (blocked) {
      return res.status(403).json({
        success: false,
        error: 'Este número bloqueou você. Não é possível enviar mensagens.',
        blocked: true
      });
    }

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
    const messageWithCode = `*Mensagem Anônima*

Você recebeu uma mensagem anônima.
Responda aqui se desejar.

*Mensagem:*
${message}


Para bloquear, envie: *bloquear*
ᶜᵒᵈ ${trackingCode}`;


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
  const userId = req.userId;

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
   
    const blocked = await isBlocked(phone, userId);
    if (blocked) {
      return res.status(403).json({
        success: false,
        error: 'Este número bloqueou você. Não é possível enviar mensagens.',
        blocked: true
      });
    }

    const userBefore = await getUserById(userId);
    if (userBefore.whatsapp_credits < 1) {
      return res.status(402).json({
        success: false,
        error: 'Créditos de WhatsApp insuficientes',
        needsPayment: true
      });
    }


    const processId = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;


    res.json({
      success: true,
      processing: true,
      processId: processId,
      message: 'Áudio em análise. Você será notificado quando o envio for concluído.'
    });


    (async () => {
      try {

      
        const moderation = await moderationService.moderateAudio(audioBase64, audioMimetype, userId, phone);

     
        await logModerationEvent({
          userId: userId,
          message: moderation.transcription || '[Áudio sem transcrição]',
          action: moderation.allowed ? 'allowed' : 'blocked',
          category: moderation.category || 'audio',
          riskScore: moderation.riskScore || 0,
          targetPhone: phone,
          channel: 'whatsapp',
          detectedTypes: moderation.detectedTypes || [],
          matchedWord: moderation.matchedWord || null
        });

        if (!moderation.allowed) {
      
          io.to(`user:${userId}`).emit('audio-moderation-result', {
            processId: processId,
            success: false,
            blocked: true,
            reason: moderation.reason || 'Conteúdo inadequado detectado no áudio',
            category: moderation.category
          });
          return;
        }

  
        const trackingCode = generateTrackingCode();
        const messageContent = caption ? `*Mensagem:*\n${caption}` : '*Áudio anexo*';
        const captionWithCode = `*Mensagem Anônima*

Você recebeu uma mensagem anônima.
Responda aqui se desejar.

${messageContent}


Para bloquear, envie: *bloquear*
ᶜᵒᵈ ${trackingCode}`;

        const result = await whatsappService.sendAudio(phone, audioBase64, audioMimetype, captionWithCode);

  
        await useCredit(userId, phone, '[Mensagem de áudio]', 'whatsapp', trackingCode);

        const user = await getUserById(userId);

     
        io.to(`user:${userId}`).emit('audio-moderation-result', {
          processId: processId,
          success: true,
          blocked: false,
          data: result.data,
          whatsapp_credits: user.whatsapp_credits,
          trackingCode: trackingCode,
          message: 'Áudio enviado com sucesso!'
        });

      } catch (error) {
        console.error(`[Audio] Erro no processamento ${processId}:`, error.message);
   
        io.to(`user:${userId}`).emit('audio-moderation-result', {
          processId: processId,
          success: false,
          error: error.message
        });
      }
    })();

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


app.get('/api/admin/online-users', adminAuthMiddleware, (req, res) => {
  res.json({
    success: true,
    ...getOnlineStats()
  });
});


app.get('/api/admin/announcement', adminAuthMiddleware, async (req, res) => {
  try {
    const announcement = await getAnnouncement();
    res.json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/announcement', adminAuthMiddleware, async (req, res) => {
  try {
    const { title, message, type, scheduled_at, expires_at } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, error: 'Título e mensagem são obrigatórios' });
    }

    const announcement = {
      title,
      message,
      type: type || 'announcement', 
      active: true,
      scheduled_at: scheduled_at || null,
      expires_at: expires_at || null,
      created_at: new Date().toISOString()
    };

    const result = await saveAnnouncement(announcement);

    if (result.success) {

      io.emit('announcement:new', result.announcement);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/announcement', adminAuthMiddleware, async (req, res) => {
  try {
    const result = await deleteAnnouncement();

    if (result.success) {
     
      io.emit('announcement:removed');
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/announcement', async (req, res) => {
  try {
    const announcement = await getAnnouncement();
    res.json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/track/access', async (req, res) => {
  try {
    const { sessionId, page } = req.body;
    const clientInfo = getClientInfo(req);

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId é obrigatório' });
    }


    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-dev');
        userId = decoded.userId;
      } catch (e) {
   
      }
    }

    await logAccess({
      sessionId,
      userId,
      ipAddress: clientInfo.ipAddress,
      userAgent: clientInfo.userAgent,
      page: page || 'home',
      referrer: req.headers.referer || req.headers.referrer
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[Track] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/admin/stats/access', adminAuthMiddleware, async (req, res) => {
  try {
    const period = req.query.period || 'today';
    const stats = await getAccessStats(period);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/admin/stats/accesses', adminAuthMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await getRecentAccesses(limit);
    res.json(result);
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


app.get('/api/admin/legal-retention', adminAuthMiddleware, async (req, res) => {
  try {
    const { cpf, email, phone, userId } = req.query;

    let query = supabase.from('legal_retention').select('*');

  
    if (cpf) {
      query = query.eq('cpf', cpf.replace(/\D/g, ''));
    }
    if (email) {
      query = query.ilike('email', `%${email}%`);
    }
    if (phone) {
      query = query.ilike('phone', `%${phone.replace(/\D/g, '')}%`);
    }
    if (userId) {
      query = query.eq('original_user_id', userId);
    }

    const { data, error } = await query.order('account_deleted_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      count: data?.length || 0,
      data: data || [],
      notice: 'Estes dados são mantidos conforme Marco Civil da Internet (Lei 12.965/2014) e LGPD. Acesso restrito a ordens judiciais.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/admin/legal-retention/:id', adminAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('legal_retention')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'Registro não encontrado' });
    }

    res.json({
      success: true,
      data,
      notice: 'Dados mantidos para fins legais. Acesso deve ser registrado.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/admin/legal-retention/:id/hold', adminAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, error: 'Motivo é obrigatório para retenção legal' });
    }

    const { data, error } = await supabase
      .from('legal_retention')
      .update({
        legal_hold: true,
        legal_hold_reason: reason,
        legal_hold_set_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

  

    res.json({
      success: true,
      message: 'Retenção legal ativada. Dados não serão excluídos automaticamente.',
      data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.delete('/api/admin/legal-retention/:id/hold', adminAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('legal_retention')
      .update({
        legal_hold: false,
        legal_hold_reason: null,
        legal_hold_set_at: null
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;



    res.json({
      success: true,
      message: 'Retenção legal removida. Dados serão excluídos após expiração.',
      data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/admin/legal-retention/stats', adminAuthMiddleware, async (req, res) => {
  try {
    const { count: totalCount } = await supabase
      .from('legal_retention')
      .select('*', { count: 'exact', head: true });

    const { count: holdCount } = await supabase
      .from('legal_retention')
      .select('*', { count: 'exact', head: true })
      .eq('legal_hold', true);

    const { count: expiringCount } = await supabase
      .from('legal_retention')
      .select('*', { count: 'exact', head: true })
      .lt('retention_expires_at', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())
      .eq('legal_hold', false);

    res.json({
      success: true,
      stats: {
        total: totalCount || 0,
        onLegalHold: holdCount || 0,
        expiringIn30Days: expiringCount || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/user/data', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

   
    const { count: messagesCount } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    const { count: repliesCount } = await supabase
      .from('replies')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    const { count: transactionsCount } = await supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    res.json({
      success: true,
      data: {
        profile: {
          id: user.id,
          email: user.email || null,
          phone: user.phone || null,
          name: user.name || null,
          cpf: user.cpf || null,
          email_verified: user.email_verified,
          phone_verified: user.phone_verified,
          created_at: user.created_at
        },
        credits: {
          whatsapp: user.whatsapp_credits,
          sms: user.sms_credits
        },
        statistics: {
          totalMessages: messagesCount || 0,
          totalReplies: repliesCount || 0,
          totalTransactions: transactionsCount || 0
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.put('/api/user/data', authMiddleware, async (req, res) => {
  try {
    const { name, cpf, email, phone, currentPassword, newPassword } = req.body;
    const user = await getUserById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    const updates = {};

 
    if (name && name.trim().length >= 3) {
   
      if (!user.name) {
        updates.name = name.trim();
      }
    }

   
    if (cpf && !user.cpf) {
      const normalizedCpf = cpf.replace(/\D/g, '');
      if (normalizedCpf.length !== 11) {
        return res.status(400).json({ success: false, error: 'CPF inválido' });
      }

      const existingUser = await getUserByCpf(normalizedCpf);
      if (existingUser && existingUser.id !== req.userId) {
        return res.status(400).json({ success: false, error: 'Este CPF já está cadastrado' });
      }
      updates.cpf = normalizedCpf;
    }


    if (email && !user.email) {
      const normalizedEmail = email.trim().toLowerCase();
     
      const existingEmail = await getUserByEmail(normalizedEmail);
      if (existingEmail && existingEmail.id !== req.userId) {
        return res.status(400).json({ success: false, error: 'Este email já está cadastrado' });
      }
      updates.email = normalizedEmail;
      updates.email_verified = false; 
    }

  
    if (phone && !user.phone) {
      const normalizedPhone = phone.replace(/\D/g, '');


      const existingPhone = await getUserByPhone(normalizedPhone);
      if (existingPhone && existingPhone.id !== req.userId) {
        return res.status(400).json({ success: false, error: 'Este telefone já está cadastrado' });
      }


      const key = `${req.userId}_${normalizedPhone}`;
      const verification = phoneUpdateVerifications.get(key);

      if (!verification || !verification.verified) {
        return res.status(400).json({ success: false, error: 'Telefone não verificado. Por favor, verifique o código enviado.' });
      }

     
      phoneUpdateVerifications.delete(key);

      updates.phone = normalizedPhone.startsWith('55') ? '+' + normalizedPhone : '+55' + normalizedPhone;
      updates.phone_verified = true; 
    }

   
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, error: 'Senha atual é obrigatória para alterar a senha' });
      }

      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        return res.status(400).json({ success: false, error: 'Senha atual incorreta' });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Nova senha deve ter no mínimo 6 caracteres' });
      }

      updates.password = await bcrypt.hash(newPassword, 10);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum dado para atualizar' });
    }

    const { error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.userId);

    if (error) throw error;


    if (updates.email) {
      try {
        const { createVerificationToken } = require('./database');
        const { sendVerificationEmail } = require('./email-service');
        const verificationToken = await createVerificationToken(req.userId);
        const userName = updates.name || user.name || '';
        await sendVerificationEmail(updates.email, verificationToken, userName);
      } catch (emailError) {
        console.error('Erro ao enviar email de verificação:', emailError);
      }
    }


    const updatedUser = await getUserById(req.userId);

    res.json({
      success: true,
      message: 'Dados atualizados com sucesso',
      updated: Object.keys(updates).filter(k => k !== 'password'),
      profile: {
        name: updatedUser.name,
        cpf: updatedUser.cpf,
        email: updatedUser.email,
        phone: updatedUser.phone
      }
    });
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
    const { confirmEmail, confirmPhone, password } = req.body;
    const user = await getUserById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }


    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'Por favor, informe sua senha para confirmar a exclusão'
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(400).json({
        success: false,
        error: 'Senha incorreta'
      });
    }


    let confirmationValid = false;

  
    if (confirmEmail && user.email) {
      if (confirmEmail.toLowerCase() === user.email.toLowerCase()) {
        confirmationValid = true;
      } else {
        return res.status(400).json({
          success: false,
          error: 'O email informado não corresponde ao email da sua conta'
        });
      }
    }

  
    if (confirmPhone && user.phone) {
      const normalizedConfirmPhone = confirmPhone.replace(/\D/g, '');
      const normalizedUserPhone = user.phone.replace(/\D/g, '');
  
      const userPhoneWithoutCountry = normalizedUserPhone.replace(/^55/, '');
      if (normalizedConfirmPhone === userPhoneWithoutCountry || normalizedConfirmPhone === normalizedUserPhone) {
        confirmationValid = true;
      } else {
        return res.status(400).json({
          success: false,
          error: 'O telefone informado não corresponde ao telefone da sua conta'
        });
      }
    }


    if (!confirmationValid) {
      return res.status(400).json({
        success: false,
        error: 'Por favor, confirme seu email ou telefone para excluir a conta'
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
