require('dotenv').config();

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');


const ENCRYPTION_KEY = process.env.MESSAGE_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';


const RETENTION_POLICY = {
  messages: 90,           
  transactions: 365,      
  logs_technical: 180,    
  logs_abuse: 730,        
  replies: 90             
};

function generateTrackingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = 'by';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}


function extractTrackingCode(message) {

  const match = message.match(/\bby([A-HJ-NP-Za-hj-np-z2-9]{4})\b/i);
  return match ? 'by' + match[1] : null;
}


function hashMessage(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

function encryptMessage(message) {
  try {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let encrypted = cipher.update(message, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return {
      encrypted: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag
    };
  } catch (error) {
    console.error('[Database] Erro ao criptografar mensagem:', error.message);
    return null;
  }
}

function decryptMessage(encryptedData) {
  try {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const authTag = Buffer.from(encryptedData.authTag, 'hex');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('[Database] Erro ao descriptografar mensagem:', error.message);
    return null;
  }
}

function maskSensitiveData(data) {
  if (!data) return data;


  data = data.replace(/\b(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})\b/g, '$1.***.***-**');

 
  data = data.replace(/\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/g, '(**) *****-****');

 
  data = data.replace(/([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g,
    (match, local, domain) => `${local.substring(0, 2)}***@${domain}`);

  return data;
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[Database] ERRO: SUPABASE_URL e SUPABASE_KEY devem estar configuradas no .env');
  throw new Error('Configuração do Supabase ausente. Verifique o arquivo .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const lidToPhoneMap = new Map();
let lidMappingsLoaded = false;

async function loadLidMappings() {
  if (lidMappingsLoaded) return;

  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'lid_mappings')
      .single();

    if (data && data.value) {
      const mappings = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      Object.entries(mappings).forEach(([lid, phone]) => {
        lidToPhoneMap.set(lid, phone);
      });
    }
    lidMappingsLoaded = true;
  } catch (error) {
    lidMappingsLoaded = true;
  }
}

let saveLidTimeout = null;
async function persistLidMappings() {
  if (saveLidTimeout) {
    clearTimeout(saveLidTimeout);
  }

  saveLidTimeout = setTimeout(async () => {
    try {
      const mappings = Object.fromEntries(lidToPhoneMap);
      await supabase
        .from('system_settings')
        .upsert({
          key: 'lid_mappings',
          value: mappings,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });
    } catch (error) {}
  }, 5000);
}


async function saveLidMapping(lid, phone) {
  const cleanLid = lid.replace('@lid', '').replace(/\D/g, '');
  const cleanPhone = phone.replace(/\D/g, '');
  lidToPhoneMap.set(cleanLid, cleanPhone);
  persistLidMappings();
}


async function getPhoneByLid(lid) {
  await loadLidMappings();
  const cleanLid = lid.replace('@lid', '').replace(/\D/g, '');
  return lidToPhoneMap.get(cleanLid) || null;
}


async function findRecentMessageWithoutReply(channel = 'whatsapp', maxMinutes = 30) {
  const cutoffTime = new Date();
  cutoffTime.setMinutes(cutoffTime.getMinutes() - maxMinutes);
  const cutoffISO = cutoffTime.toISOString();

  const { data, error } = await supabase
    .from('messages')
    .select('*, users(id, email)')
    .eq('channel', channel)
    .eq('has_reply', false)
    .gte('created_at', cutoffISO)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) return null;
  return data && data.length > 0 ? data[0] : null;
}


async function createUser(email, password, phone = null) {
  const hashedPassword = await bcrypt.hash(password, 10);

  const userData = {
    password: hashedPassword,
    whatsapp_credits: 5,
    sms_credits: 5,
    email_verified: false,
    phone_verified: false
  };


  if (email) {
    userData.email = email;
  }
  if (phone) {
    userData.phone = phone;
  }

  const { data, error } = await supabase
    .from('users')
    .insert([userData])
    .select()
    .single();

  if (error) throw error;
  return { id: data.id };
}

async function getUserByPhone(phone) {
  const normalizedPhone = phone.replace(/\D/g, '');

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', normalizedPhone)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function getUserByEmailOrPhone(identifier) {
  // Verificar se é telefone (só números) ou email
  const isPhone = /^\+?\d{10,15}$/.test(identifier.replace(/\D/g, ''));

  if (isPhone) {
    return await getUserByPhone(identifier);
  } else {
    return await getUserByEmail(identifier);
  }
}

// ==========================================
// VERIFICAÇÃO POR SMS
// ==========================================

function generateVerificationCode() {
  // Gerar código de 6 dígitos
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function createPhoneVerificationCode(userId, phone) {
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

  // Invalidar códigos anteriores para este telefone
  await supabase
    .from('phone_verifications')
    .update({ verified: true })
    .eq('phone', phone)
    .eq('verified', false);

  const { data, error } = await supabase
    .from('phone_verifications')
    .insert([{
      user_id: userId,
      phone: phone,
      code: code,
      expires_at: expiresAt.toISOString()
    }])
    .select()
    .single();

  if (error) throw error;
  return code;
}

async function verifyPhoneCode(phone, code) {
  const { data, error } = await supabase
    .from('phone_verifications')
    .select('*')
    .eq('phone', phone)
    .eq('code', code)
    .eq('verified', false)
    .single();

  if (error || !data) {
    throw new Error('Código inválido ou já utilizado');
  }

  // Verificar se não expirou
  if (new Date(data.expires_at) < new Date()) {
    throw new Error('Código expirado. Solicite um novo código.');
  }

  // Verificar tentativas (máximo 5)
  if (data.attempts >= 5) {
    throw new Error('Muitas tentativas. Solicite um novo código.');
  }

  // Incrementar tentativas
  await supabase
    .from('phone_verifications')
    .update({ attempts: data.attempts + 1 })
    .eq('id', data.id);

  // Marcar como verificado
  await supabase
    .from('phone_verifications')
    .update({ verified: true, verified_at: new Date().toISOString() })
    .eq('id', data.id);

  // Marcar telefone do usuário como verificado
  await supabase
    .from('users')
    .update({ phone_verified: true })
    .eq('id', data.user_id);

  return data.user_id;
}

async function isPhoneVerified(userId) {
  const user = await getUserById(userId);
  return user.phone_verified === true;
}

async function incrementPhoneVerificationAttempts(phone, code) {
  await supabase
    .from('phone_verifications')
    .update({ attempts: supabase.raw('attempts + 1') })
    .eq('phone', phone)
    .eq('code', code);
}

async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, whatsapp_credits, sms_credits, email_verified')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}

async function verifyPassword(password, hashedPassword) {
  return bcrypt.compare(password, hashedPassword);
}

async function addCredits(userId, creditsToAdd, price, creditType = 'whatsapp') {
  const creditColumn = creditType === 'whatsapp' ? 'whatsapp_credits' : 'sms_credits';

  const { data, error } = await supabase.rpc('add_credits_transaction', {
    p_user_id: userId,
    p_credits: creditsToAdd,
    p_price: price,
    p_credit_type: creditType
  });

  if (error) {
    const currentUser = await getUserById(userId);
    const currentCredits = creditType === 'whatsapp' ? currentUser.whatsapp_credits : currentUser.sms_credits;

    const { error: updateError } = await supabase
      .from('users')
      .update({ [creditColumn]: currentCredits + creditsToAdd })
      .eq('id', userId);

    if (updateError) throw updateError;

    const { error: transactionError } = await supabase
      .from('transactions')
      .insert([{
        user_id: userId,
        type: 'purchase',
        credit_type: creditType,
        amount: 1,
        credits_added: creditsToAdd,
        price: price
      }]);

    if (transactionError) throw transactionError;
  }

  return true;
}

async function useCredit(userId, phone, message, channel = 'whatsapp', trackingCode = null) {
  const creditColumn = channel === 'whatsapp' ? 'whatsapp_credits' : 'sms_credits';

  const user = await getUserById(userId);
  const credits = channel === 'whatsapp' ? user.whatsapp_credits : user.sms_credits;

  if (!user || credits < 1) {
    throw new Error(`Créditos de ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} insuficientes`);
  }


  const code = trackingCode || generateTrackingCode();

  const { data, error } = await supabase.rpc('use_credit_transaction', {
    p_user_id: userId,
    p_phone: phone,
    p_message: message,
    p_channel: channel,
    p_tracking_code: code
  });

  if (error) {
    const currentUser = await getUserById(userId);
    const currentCredits = channel === 'whatsapp' ? currentUser.whatsapp_credits : currentUser.sms_credits;

    const { error: updateError } = await supabase
      .from('users')
      .update({ [creditColumn]: currentCredits - 1 })
      .eq('id', userId);

    if (updateError) throw updateError;

    const { error: transactionError } = await supabase
      .from('transactions')
      .insert([{
        user_id: userId,
        type: 'usage',
        credit_type: channel,
        amount: 1,
        credits_added: -1
      }]);

    if (transactionError) throw transactionError;

    const { error: messageError } = await supabase
      .from('messages')
      .insert([{
        user_id: userId,
        phone: phone,
        message: message,
        channel: channel,
        tracking_code: code
      }]);

    if (messageError) throw messageError;
  }

  return { success: true, trackingCode: code };
}

async function getUserTransactions(userId, limit = 20) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function getUserMessages(userId, limit = 20) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function getUserReplies(userId, limit = 20) {
  const { data, error } = await supabase
    .from('replies')
    .select('*, messages(message)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error && error.code !== 'PGRST116' && !error.message.includes('does not exist')) {
    throw error;
  }

  const formattedReplies = (data || []).map(reply => ({
    ...reply,
    original_message: reply.messages?.message || null
  }));

  return formattedReplies;
}

async function saveReply(userId, messageId, fromPhone, replyMessage, channel, audioUrl = null) {
  const insertData = {
    user_id: userId,
    message_id: messageId,
    from_phone: fromPhone,
    message: replyMessage,
    channel: channel
  };


  if (audioUrl) {
    insertData.audio_url = audioUrl;
  }

  const { data, error } = await supabase
    .from('replies')
    .insert([insertData])
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from('messages')
    .update({ has_reply: true })
    .eq('id', messageId);

  return data;
}


async function findMessageByTrackingCode(trackingCode, channel = null) {
  let query = supabase
    .from('messages')
    .select('*, users(id, email)')
    .eq('tracking_code', trackingCode)
    .order('created_at', { ascending: false })
    .limit(1);

  if (channel) {
    query = query.eq('channel', channel);
  }

  const { data, error } = await query;
  if (error) return null;
  return data && data.length > 0 ? data[0] : null;
}


async function findMessageByPhone(phone, channel = null) {
  const normalizedPhone = phone.replace(/\D/g, '');
  const last9Digits = normalizedPhone.slice(-9);
  const last8Digits = normalizedPhone.slice(-8);


  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoISO = sevenDaysAgo.toISOString();

  let query = supabase
    .from('messages')
    .select('*, users(id, email)')
    .gte('created_at', sevenDaysAgoISO) 
    .order('created_at', { ascending: false })
    .limit(1);

  if (channel) {
    query = query.eq('channel', channel);
  }

  const { data, error } = await query.or(`phone.ilike.%${normalizedPhone}%,phone.ilike.%${last9Digits}%,phone.ilike.%${last8Digits}%`);

  if (error) {
    console.error(`[Database] Erro ao buscar mensagem: ${error.message}`);
    throw error;
  }

  if (data && data.length > 0) {
    return data[0];
  } else {
    return null;
  }
}

async function saveReplyFromWebhook(fromPhone, replyMessage, channel, isLid = false, audioUrl = null) {
  let originalMessage = null;
  let phoneToSearch = fromPhone;


  const trackingCode = extractTrackingCode(replyMessage);
  if (trackingCode) {
    originalMessage = await findMessageByTrackingCode(trackingCode, channel);
    if (originalMessage) {

      if (isLid && originalMessage.phone) {
        await saveLidMapping(fromPhone, originalMessage.phone);
      }
    }
  }

  if (!originalMessage && isLid) {
    const mappedPhone = await getPhoneByLid(fromPhone);
    if (mappedPhone) {
      phoneToSearch = mappedPhone;
      originalMessage = await findMessageByPhone(phoneToSearch, channel);
    }
  }


  if (!originalMessage) {
    originalMessage = await findMessageByPhone(phoneToSearch, channel);
  }


  if (!originalMessage && isLid) {
    originalMessage = await findRecentMessageWithoutReply(channel, 60); 

    if (originalMessage) {

      await saveLidMapping(fromPhone, originalMessage.phone);
    }
  }

  if (!originalMessage) {
    return null;
  }

  const insertData = {
    user_id: originalMessage.user_id,
    message_id: originalMessage.id,
    from_phone: fromPhone,
    message: replyMessage,
    channel: channel
  };

  
  if (audioUrl) {
    insertData.audio_url = audioUrl;
  }

  const { data, error } = await supabase
    .from('replies')
    .insert([insertData])
    .select()
    .single();

  if (error) {
    console.error(`[Database] Erro ao inserir resposta: ${error.message}`);
    throw error;
  }

  const { error: updateError } = await supabase
    .from('messages')
    .update({ has_reply: true })
    .eq('id', originalMessage.id);

  if (updateError) {
    console.error(`[Database] Erro ao atualizar has_reply: ${updateError.message}`);
  }

  return {
    reply: data,
    originalMessage: originalMessage,
    user: originalMessage.users
  };
}

async function createVerificationToken(userId) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('email_verifications')
    .insert([{
      user_id: userId,
      token: token,
      expires_at: expiresAt.toISOString()
    }])
    .select()
    .single();

  if (error) throw error;
  return token;
}

async function verifyEmailToken(token) {
  const { data, error } = await supabase
    .from('email_verifications')
    .select('*')
    .eq('token', token)
    .eq('verified', false)
    .single();

  if (error || !data) {
    throw new Error('Token inválido ou já utilizado');
  }

  if (new Date(data.expires_at) < new Date()) {
    throw new Error('Token expirado');
  }

  await supabase
    .from('email_verifications')
    .update({ verified: true, verified_at: new Date().toISOString() })
    .eq('id', data.id);

  await supabase
    .from('users')
    .update({ email_verified: true })
    .eq('id', data.user_id);

  return data.user_id;
}

async function isEmailVerified(userId) {
  const user = await getUserById(userId);
  return user.email_verified === true;
}

async function createPasswordResetToken(userId) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('password_resets')
    .insert([{
      user_id: userId,
      token: token,
      expires_at: expiresAt.toISOString()
    }])
    .select()
    .single();

  if (error) throw error;
  return token;
}

async function verifyPasswordResetToken(token) {
  const { data, error } = await supabase
    .from('password_resets')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (error || !data) {
    throw new Error('Token inválido ou já utilizado');
  }

  if (new Date(data.expires_at) < new Date()) {
    throw new Error('Token expirado. Solicite um novo link de recuperação.');
  }

  return data.user_id;
}

async function resetPassword(token, newPassword) {
  const userId = await verifyPasswordResetToken(token);
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  const { error: updateError } = await supabase
    .from('users')
    .update({ password: hashedPassword })
    .eq('id', userId);

  if (updateError) throw updateError;

  await supabase
    .from('password_resets')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('token', token);

  return true;
}

async function getWhatsAppStats() {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'whatsapp_stats')
      .single();

    if (error) {

      if (error.code === 'PGRST116' || error.code === '42P01') {
        return {
          successCount: 0,
          failureCount: 0,
          lastUsed: null,
          lastConnectedStatus: null,
          lastStatusUpdate: null
        };
      }
      throw error;
    }

    return data?.value || {
      successCount: 0,
      failureCount: 0,
      lastUsed: null,
      lastConnectedStatus: null,
      lastStatusUpdate: null
    };
  } catch (error) {
    console.error('[Database] Erro ao carregar WhatsApp stats:', error.message);
    return {
      successCount: 0,
      failureCount: 0,
      lastUsed: null,
      lastConnectedStatus: null,
      lastStatusUpdate: null
    };
  }
}

async function saveWhatsAppStats(stats, status = null) {
  try {
    const value = {
      successCount: stats.successCount || 0,
      failureCount: stats.failureCount || 0,
      lastUsed: stats.lastUsed
    };


    if (status !== null) {
      value.lastConnectedStatus = status;
      value.lastStatusUpdate = new Date().toISOString();
    }

    const { error } = await supabase
      .from('system_settings')
      .upsert({
        key: 'whatsapp_stats',
        value: value,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'key'
      });

    if (error) {

      if (error.code === '42P01') {
        return false;
      }
      throw error;
    }

    return true;
  } catch (error) {
    console.error('[Database] Erro ao salvar WhatsApp stats:', error.message);
    return false;
  }
}

// ==========================================
// LOGGING DE MODERAÇÃO (CONFORMIDADE JURÍDICA)
// ==========================================

async function logModerationEvent(data) {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      user_id: data.userId || null,
      message_hash: data.message ? hashMessage(data.message) : null,
      action: data.action, // 'blocked' | 'allowed'
      category: data.category || null,
      risk_score: data.riskScore || 0,
      ip_address: data.ipAddress || null,
      user_agent: data.userAgent || null,
      target_phone_hash: data.targetPhone ? hashMessage(data.targetPhone) : null,
      channel: data.channel || 'whatsapp',
      // NÃO guardar o conteúdo da mensagem, apenas o hash
      metadata: {
        detected_types: data.detectedTypes || [],
        matched_rule: data.matchedWord || null
      }
    };

    const { error } = await supabase
      .from('moderation_logs')
      .insert([logEntry]);

    if (error && error.code !== '42P01') {
      console.error('[Database] Erro ao salvar log de moderação:', error.message);
    }

    return true;
  } catch (error) {
    console.error('[Database] Erro ao criar log de moderação:', error.message);
    return false;
  }
}

// ==========================================
// FUNÇÕES LGPD - DIREITOS DO TITULAR
// ==========================================

// LGPD Art. 18 - Direito à exclusão de dados
async function deleteUserData(userId, options = {}) {
  const { keepTransactionsForTax = true } = options;
  const results = {
    deleted: [],
    errors: [],
    anonymized: []
  };

  try {
    // 1. Deletar respostas
    const { error: repliesError } = await supabase
      .from('replies')
      .delete()
      .eq('user_id', userId);

    if (repliesError && repliesError.code !== 'PGRST116') {
      results.errors.push({ table: 'replies', error: repliesError.message });
    } else {
      results.deleted.push('replies');
    }

    // 2. Deletar mensagens
    const { error: messagesError } = await supabase
      .from('messages')
      .delete()
      .eq('user_id', userId);

    if (messagesError && messagesError.code !== 'PGRST116') {
      results.errors.push({ table: 'messages', error: messagesError.message });
    } else {
      results.deleted.push('messages');
    }

    // 3. Anonimizar transações (manter para fins fiscais/legais)
    if (keepTransactionsForTax) {
      const { error: transactionsError } = await supabase
        .from('transactions')
        .update({ user_id: null, anonymized_at: new Date().toISOString() })
        .eq('user_id', userId);

      if (transactionsError && transactionsError.code !== 'PGRST116') {
        results.errors.push({ table: 'transactions', error: transactionsError.message });
      } else {
        results.anonymized.push('transactions');
      }
    } else {
      const { error: transactionsError } = await supabase
        .from('transactions')
        .delete()
        .eq('user_id', userId);

      if (!transactionsError) results.deleted.push('transactions');
    }

    // 4. Deletar verificações de email
    const { error: emailVerifError } = await supabase
      .from('email_verifications')
      .delete()
      .eq('user_id', userId);

    if (!emailVerifError) results.deleted.push('email_verifications');

    // 5. Deletar tokens de reset de senha
    const { error: passwordResetError } = await supabase
      .from('password_resets')
      .delete()
      .eq('user_id', userId);

    if (!passwordResetError) results.deleted.push('password_resets');

    // 6. Deletar logs de moderação
    const { error: modLogsError } = await supabase
      .from('moderation_logs')
      .delete()
      .eq('user_id', userId);

    if (!modLogsError) results.deleted.push('moderation_logs');

    // 7. Por último, deletar o usuário
    const { error: userError } = await supabase
      .from('users')
      .delete()
      .eq('id', userId);

    if (userError) {
      results.errors.push({ table: 'users', error: userError.message });
    } else {
      results.deleted.push('users');
    }

    return {
      success: results.errors.length === 0,
      ...results
    };
  } catch (error) {
    console.error('[Database] Erro ao deletar dados do usuário:', error.message);
    return {
      success: false,
      deleted: results.deleted,
      errors: [...results.errors, { general: error.message }],
      anonymized: results.anonymized
    };
  }
}

// LGPD Art. 18 - Direito à portabilidade (exportação de dados)
async function exportUserData(userId) {
  try {
    const exportData = {
      exportDate: new Date().toISOString(),
      format: 'LGPD_COMPLIANT_EXPORT',
      version: '1.0'
    };

    // 1. Dados do usuário (sem senha)
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id, email, whatsapp_credits, sms_credits, email_verified, created_at')
      .eq('id', userId)
      .single();

    if (userError) throw userError;
    exportData.user = userData;

    // 2. Mensagens enviadas (com dados mascarados)
    const { data: messagesData } = await supabase
      .from('messages')
      .select('id, phone, message, channel, tracking_code, created_at, has_reply')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.messages = (messagesData || []).map(msg => ({
      ...msg,
      phone: maskSensitiveData(msg.phone),
      message: maskSensitiveData(msg.message)
    }));

    // 3. Respostas recebidas
    const { data: repliesData } = await supabase
      .from('replies')
      .select('id, message, channel, created_at, audio_url')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.replies = (repliesData || []).map(reply => ({
      ...reply,
      message: maskSensitiveData(reply.message)
    }));

    // 4. Histórico de transações
    const { data: transactionsData } = await supabase
      .from('transactions')
      .select('id, type, credit_type, amount, credits_added, price, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.transactions = transactionsData || [];

    // 5. Metadados
    exportData.metadata = {
      totalMessages: exportData.messages.length,
      totalReplies: exportData.replies.length,
      totalTransactions: exportData.transactions.length,
      dataRetentionPolicy: RETENTION_POLICY
    };

    return {
      success: true,
      data: exportData
    };
  } catch (error) {
    console.error('[Database] Erro ao exportar dados do usuário:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==========================================
// POLÍTICA DE RETENÇÃO - LIMPEZA AUTOMÁTICA
// ==========================================

async function cleanupExpiredData() {
  const results = {
    cleaned: [],
    errors: []
  };

  try {
    const now = new Date();

    // 1. Limpar mensagens antigas
    const messagesExpiry = new Date(now);
    messagesExpiry.setDate(messagesExpiry.getDate() - RETENTION_POLICY.messages);

    const { error: messagesError, count: messagesCount } = await supabase
      .from('messages')
      .delete()
      .lt('created_at', messagesExpiry.toISOString())
      .select('count');

    if (!messagesError) {
      results.cleaned.push({ table: 'messages', count: messagesCount });
    } else {
      results.errors.push({ table: 'messages', error: messagesError.message });
    }

    // 2. Limpar respostas antigas
    const repliesExpiry = new Date(now);
    repliesExpiry.setDate(repliesExpiry.getDate() - RETENTION_POLICY.replies);

    const { error: repliesError, count: repliesCount } = await supabase
      .from('replies')
      .delete()
      .lt('created_at', repliesExpiry.toISOString())
      .select('count');

    if (!repliesError) {
      results.cleaned.push({ table: 'replies', count: repliesCount });
    } else {
      results.errors.push({ table: 'replies', error: repliesError.message });
    }

    // 3. Limpar logs de moderação antigos (não-abuso)
    const logsExpiry = new Date(now);
    logsExpiry.setDate(logsExpiry.getDate() - RETENTION_POLICY.logs_technical);

    const { error: logsError } = await supabase
      .from('moderation_logs')
      .delete()
      .lt('timestamp', logsExpiry.toISOString())
      .not('category', 'in', '(criminal_threat,blackmail_extortion,threat,hate_speech)');

    if (!logsError) {
      results.cleaned.push({ table: 'moderation_logs (technical)' });
    }

    // 4. Limpar tokens de verificação de email expirados
    const { error: tokenError } = await supabase
      .from('email_verifications')
      .delete()
      .lt('expires_at', now.toISOString());

    if (!tokenError) {
      results.cleaned.push({ table: 'email_verifications (expired)' });
    }

    // 5. Limpar tokens de reset de senha expirados
    const { error: resetError } = await supabase
      .from('password_resets')
      .delete()
      .lt('expires_at', now.toISOString());

    if (!resetError) {
      results.cleaned.push({ table: 'password_resets (expired)' });
    }

    return results;
  } catch (error) {
    console.error('[Database] Erro na limpeza de dados:', error.message);
    return { ...results, errors: [...results.errors, { general: error.message }] };
  }
}

// Função para uso com cron job (executar diariamente)
function scheduleDataCleanup() {
  // Executar limpeza diariamente às 3h da manhã
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 horas

  setInterval(async () => {

    await cleanupExpiredData();
  }, CLEANUP_INTERVAL);

  // Executar uma vez na inicialização (após 1 minuto)
  setTimeout(async () => {

    await cleanupExpiredData();
  }, 60 * 1000);
}

// ==========================================
// FAVORITOS
// ==========================================

async function getFavorites(userId) {
  try {
    const { data, error } = await supabase
      .from('favorites')
      .select('id, name, phone, created_at')
      .eq('user_id', userId)
      .order('name', { ascending: true });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('[Database] Erro ao buscar favoritos:', error.message);
    return [];
  }
}

async function addFavorite(userId, name, phone) {
  try {
    // Limpar telefone (só números)
    const cleanPhone = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('favorites')
      .insert({
        user_id: userId,
        name: name.trim(),
        phone: cleanPhone
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return { success: false, error: 'Este número já está nos favoritos' };
      }
      throw error;
    }

    return { success: true, favorite: data };
  } catch (error) {
    console.error('[Database] Erro ao adicionar favorito:', error.message);
    return { success: false, error: error.message };
  }
}

async function deleteFavorite(userId, favoriteId) {
  try {
    const { error } = await supabase
      .from('favorites')
      .delete()
      .eq('id', favoriteId)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Database] Erro ao deletar favorito:', error.message);
    return { success: false, error: error.message };
  }
}

async function isFavorite(userId, phone) {
  try {
    const cleanPhone = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('favorites')
      .select('id')
      .eq('user_id', userId)
      .eq('phone', cleanPhone)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return !!data;
  } catch (error) {
    console.error('[Database] Erro ao verificar favorito:', error.message);
    return false;
  }
}

module.exports = {
  supabase,
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
  findMessageByTrackingCode,
  findRecentMessageWithoutReply,
  saveReplyFromWebhook,
  createVerificationToken,
  verifyEmailToken,
  isEmailVerified,
  createPasswordResetToken,
  verifyPasswordResetToken,
  resetPassword,
  getWhatsAppStats,
  saveWhatsAppStats,
  generateTrackingCode,
  extractTrackingCode,
  saveLidMapping,
  getPhoneByLid,
  loadLidMappings,
  // Funções de verificação por SMS
  createPhoneVerificationCode,
  verifyPhoneCode,
  isPhoneVerified,
  // Novas funções de segurança e LGPD
  hashMessage,
  encryptMessage,
  decryptMessage,
  maskSensitiveData,
  logModerationEvent,
  deleteUserData,
  exportUserData,
  cleanupExpiredData,
  scheduleDataCleanup,
  RETENTION_POLICY,
  // Favoritos
  getFavorites,
  addFavorite,
  deleteFavorite,
  isFavorite
};
