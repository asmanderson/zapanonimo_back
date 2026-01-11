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

  const match = message.match(/by([A-HJ-NP-Za-hj-np-z2-9]{4})/i);
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


async function createUser(email, password, phone = null, name = null, cpf = null, acceptedTermsAt = null, termsVersion = null) {
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
  if (name) {
    userData.name = name;
  }
  if (cpf) {
    userData.cpf = cpf;
  }

  if (acceptedTermsAt) {
    userData.accepted_terms_at = acceptedTermsAt;
  }
  if (termsVersion) {
    userData.terms_version = termsVersion;
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

async function getUserByCpf(cpf) {
  const normalizedCpf = cpf.replace(/\D/g, '');

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('cpf', normalizedCpf)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function getUserByEmailOrPhone(identifier) {
 
  const isPhone = /^\+?\d{10,15}$/.test(identifier.replace(/\D/g, ''));

  if (isPhone) {
    return await getUserByPhone(identifier);
  } else {
    return await getUserByEmail(identifier);
  }
}


function generateVerificationCode() {

  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function createPhoneVerificationCode(userId, phone) {
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); 

 
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

  
  if (new Date(data.expires_at) < new Date()) {
    throw new Error('Código expirado. Solicite um novo código.');
  }

  
  if (data.attempts >= 5) {
    throw new Error('Muitas tentativas. Solicite um novo código.');
  }

  
  await supabase
    .from('phone_verifications')
    .update({ attempts: data.attempts + 1 })
    .eq('id', data.id);

  
  await supabase
    .from('phone_verifications')
    .update({ verified: true, verified_at: new Date().toISOString() })
    .eq('id', data.id);

 
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
    .select('id, email, phone, name, cpf, whatsapp_credits, sms_credits, email_verified, phone_verified, created_at, password')
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


async function createPasswordResetCodeByPhone(userId, phone) {
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); 


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

async function verifyPasswordResetCodeByPhone(phone, code) {
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

  if (new Date(data.expires_at) < new Date()) {
    throw new Error('Código expirado. Solicite um novo código.');
  }

  if (data.attempts >= 5) {
    throw new Error('Muitas tentativas. Solicite um novo código.');
  }

 
  await supabase
    .from('phone_verifications')
    .update({ attempts: data.attempts + 1 })
    .eq('id', data.id);

  return data.user_id;
}

async function resetPasswordByPhone(phone, code, newPassword) {
  const userId = await verifyPasswordResetCodeByPhone(phone, code);
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  const { error: updateError } = await supabase
    .from('users')
    .update({ password: hashedPassword })
    .eq('id', userId);

  if (updateError) throw updateError;


  await supabase
    .from('phone_verifications')
    .update({ verified: true, verified_at: new Date().toISOString() })
    .eq('phone', phone)
    .eq('code', code);

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


async function logModerationEvent(data) {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      user_id: data.userId || null,
      message_hash: data.message ? hashMessage(data.message) : null,
      action: data.action, 
      category: data.category || null,
      risk_score: data.riskScore || 0,
      ip_address: data.ipAddress || null,
      user_agent: data.userAgent || null,
      target_phone_hash: data.targetPhone ? hashMessage(data.targetPhone) : null,
      channel: data.channel || 'whatsapp',
    
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


async function saveToLegalRetention(userId) {
  try {
  
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      console.error('[LegalRetention] Usuário não encontrado:', userError?.message);
      return { success: false, error: 'Usuário não encontrado' };
    }


    const { data: messages } = await supabase
      .from('messages')
      .select('to_phone, content, sent_at, tracking_code, ip_address')
      .eq('user_id', userId)
      .order('sent_at', { ascending: false });

    const messagesSummary = (messages || []).map(msg => ({
      to_phone: msg.to_phone,
      content_hash: require('crypto').createHash('sha256').update(msg.content || '').digest('hex').substring(0, 16),
      content_preview: (msg.content || '').substring(0, 50) + '...', 
      sent_at: msg.sent_at,
      tracking_code: msg.tracking_code,
      ip_address: msg.ip_address
    }));

 
    const { data: transactions } = await supabase
      .from('transactions')
      .select('amount, type, status, payment_id, created_at')
      .eq('user_id', userId);

    const transactionsSummary = (transactions || []).map(t => ({
      amount: t.amount,
      type: t.type,
      status: t.status,
      payment_id: t.payment_id,
      date: t.created_at
    }));

    const totalSpent = (transactions || [])
      .filter(t => t.status === 'completed')
      .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

 
    const ipLogs = (messages || [])
      .filter(m => m.ip_address)
      .map(m => ({
        ip: m.ip_address,
        action: 'message_sent',
        timestamp: m.sent_at
      }));


    const { data: retention, error: retentionError } = await supabase
      .from('legal_retention')
      .insert({
        original_user_id: userId,
        name: user.name,
        cpf: user.cpf,
        email: user.email,
        phone: user.phone,
        account_created_at: user.created_at,
        messages_summary: messagesSummary,
        total_messages_sent: messages?.length || 0,
        ip_logs: ipLogs,
        transactions_summary: transactionsSummary,
        total_spent: totalSpent,
        deleted_by: 'user',
        retention_expires_at: new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString() 
      })
      .select()
      .single();

    if (retentionError) {
      console.error('[LegalRetention] Erro ao salvar:', retentionError.message);
      return { success: false, error: retentionError.message };
    }

 
    return { success: true, retentionId: retention.id };

  } catch (error) {
    console.error('[LegalRetention] Erro:', error.message);
    return { success: false, error: error.message };
  }
}


async function deleteUserData(userId, options = {}) {
  const { keepTransactionsForTax = true } = options;
  const results = {
    deleted: [],
    errors: [],
    anonymized: [],
    legalRetention: null
  };

  try {

    const retentionResult = await saveToLegalRetention(userId);

    if (retentionResult.success) {
      results.legalRetention = retentionResult.retentionId;

    } else {
      console.error(`[DeleteUser] AVISO: Falha ao salvar retenção legal: ${retentionResult.error}`);
 
      results.errors.push({ table: 'legal_retention', error: retentionResult.error });
    }


    const { error: repliesError } = await supabase
      .from('replies')
      .delete()
      .eq('user_id', userId);

    if (repliesError && repliesError.code !== 'PGRST116') {
      results.errors.push({ table: 'replies', error: repliesError.message });
    } else {
      results.deleted.push('replies');
    }

   
    const { error: messagesError } = await supabase
      .from('messages')
      .delete()
      .eq('user_id', userId);

    if (messagesError && messagesError.code !== 'PGRST116') {
      results.errors.push({ table: 'messages', error: messagesError.message });
    } else {
      results.deleted.push('messages');
    }

 
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

 
    const { error: emailVerifError } = await supabase
      .from('email_verifications')
      .delete()
      .eq('user_id', userId);

    if (!emailVerifError) results.deleted.push('email_verifications');

   
    const { error: phoneVerifError } = await supabase
      .from('phone_verifications')
      .delete()
      .eq('user_id', userId);

    if (!phoneVerifError) results.deleted.push('phone_verifications');

   
    const { error: passwordResetError } = await supabase
      .from('password_resets')
      .delete()
      .eq('user_id', userId);

    if (!passwordResetError) results.deleted.push('password_resets');

   
    const { error: modLogsError } = await supabase
      .from('moderation_logs')
      .delete()
      .eq('user_id', userId);

    if (!modLogsError) results.deleted.push('moderation_logs');

   
    const { error: favoritesError } = await supabase
      .from('favorites')
      .delete()
      .eq('user_id', userId);

    if (!favoritesError) results.deleted.push('favorites');

 
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


async function exportUserData(userId) {
  try {
    const exportData = {
      exportDate: new Date().toISOString(),
      format: 'LGPD_COMPLIANT_EXPORT',
      version: '1.0'
    };

   
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id, email, phone, whatsapp_credits, sms_credits, email_verified, phone_verified, created_at')
      .eq('id', userId)
      .single();

    if (userError) throw userError;
    exportData.user = userData;


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

  
    const { data: repliesData } = await supabase
      .from('replies')
      .select('id, message, channel, created_at, audio_url')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.replies = (repliesData || []).map(reply => ({
      ...reply,
      message: maskSensitiveData(reply.message)
    }));

    
    const { data: transactionsData } = await supabase
      .from('transactions')
      .select('id, type, credit_type, amount, credits_added, price, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.transactions = transactionsData || [];

    const { data: favoritesData } = await supabase
      .from('favorites')
      .select('id, phone, name, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.favorites = (favoritesData || []).map(fav => ({
      ...fav,
      phone: maskSensitiveData(fav.phone)
    }));


    exportData.metadata = {
      totalMessages: exportData.messages.length,
      totalReplies: exportData.replies.length,
      totalTransactions: exportData.transactions.length,
      totalFavorites: exportData.favorites.length,
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


async function cleanupExpiredData() {
  const results = {
    cleaned: [],
    errors: []
  };

  try {
    const now = new Date();


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

  
    const { error: tokenError } = await supabase
      .from('email_verifications')
      .delete()
      .lt('expires_at', now.toISOString());

    if (!tokenError) {
      results.cleaned.push({ table: 'email_verifications (expired)' });
    }


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


function scheduleDataCleanup() {

  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; 

  setInterval(async () => {

    await cleanupExpiredData();
  }, CLEANUP_INTERVAL);


  setTimeout(async () => {

    await cleanupExpiredData();
  }, 60 * 1000);
}


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



async function getAnnouncement() {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'announcement')
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (data && data.value) {
      const announcement = data.value;
   
      if (announcement.active) {
        if (announcement.expires_at && new Date(announcement.expires_at) < new Date()) {
          return null; 
        }
        return announcement;
      }
    }
    return null;
  } catch (error) {
    console.error('[Database] Erro ao buscar anúncio:', error.message);
    return null;
  }
}

async function saveAnnouncement(announcement) {
  try {
    const data = {
      ...announcement,
      updated_at: new Date().toISOString()
    };

    if (!data.created_at) {
      data.created_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('system_settings')
      .upsert({
        key: 'announcement',
        value: data,
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });

    if (error) throw error;
    return { success: true, announcement: data };
  } catch (error) {
    console.error('[Database] Erro ao salvar anúncio:', error.message);
    return { success: false, error: error.message };
  }
}

async function deleteAnnouncement() {
  try {
    const { error } = await supabase
      .from('system_settings')
      .update({
        value: { active: false },
        updated_at: new Date().toISOString()
      })
      .eq('key', 'announcement');

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Database] Erro ao deletar anúncio:', error.message);
    return { success: false, error: error.message };
  }
}



async function logAccess(data) {
  try {
    const { sessionId, userId, ipAddress, userAgent, page, referrer } = data;


    await supabase
      .from('access_logs')
      .insert({
        session_id: sessionId,
        user_id: userId || null,
        ip_address: ipAddress,
        user_agent: userAgent,
        page: page || 'home',
        referrer: referrer
      });


    const { data: existing } = await supabase
      .from('unique_visitors')
      .select('id, visit_count')
      .eq('session_id', sessionId)
      .single();

    if (existing) {
      await supabase
        .from('unique_visitors')
        .update({
          last_visit: new Date().toISOString(),
          visit_count: existing.visit_count + 1,
          user_id: userId || null
        })
        .eq('session_id', sessionId);
    } else {
      await supabase
        .from('unique_visitors')
        .insert({
          session_id: sessionId,
          user_id: userId || null
        });
    }

    return { success: true };
  } catch (error) {
    console.error('[Access] Erro ao registrar acesso:', error.message);
    return { success: false, error: error.message };
  }
}

async function getAccessStats(period = 'today') {
  try {
    let startDate;
    const now = new Date();

    switch (period) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      case 'all':
        startDate = new Date(0);
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

   
    const { count: totalPageviews } = await supabase
      .from('access_logs')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString());

  
    const { count: uniqueVisitors } = await supabase
      .from('unique_visitors')
      .select('*', { count: 'exact', head: true })
      .gte('first_visit', startDate.toISOString());

 
    const { count: loggedUsers } = await supabase
      .from('access_logs')
      .select('user_id', { count: 'exact', head: true })
      .not('user_id', 'is', null)
      .gte('created_at', startDate.toISOString());


    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const { data: dailyAccesses } = await supabase
      .from('access_logs')
      .select('created_at')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: true });

    const accessesByDay = {};
    (dailyAccesses || []).forEach(access => {
      const day = access.created_at.split('T')[0];
      accessesByDay[day] = (accessesByDay[day] || 0) + 1;
    });


    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const { data: onlineUsers } = await supabase
      .from('access_logs')
      .select('session_id, user_id')
      .gte('created_at', fiveMinutesAgo.toISOString());

    const uniqueOnline = new Set((onlineUsers || []).map(u => u.session_id)).size;

    return {
      success: true,
      stats: {
        period,
        totalPageviews: totalPageviews || 0,
        uniqueVisitors: uniqueVisitors || 0,
        loggedUsers: loggedUsers || 0,
        onlineNow: uniqueOnline,
        accessesByDay
      }
    };
  } catch (error) {
    console.error('[Access] Erro ao obter estatísticas:', error.message);
    return { success: false, error: error.message };
  }
}

async function getRecentAccesses(limit = 50) {
  try {
    const { data, error } = await supabase
      .from('access_logs')
      .select(`
        id,
        session_id,
        user_id,
        ip_address,
        user_agent,
        page,
        created_at,
        users (
          email,
          name,
          phone
        )
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return { success: true, accesses: data };
  } catch (error) {
    console.error('[Access] Erro ao obter acessos recentes:', error.message);
    return { success: false, error: error.message };
  }
}



async function blockUser(phone, userId) {
  try {
    const normalizedPhone = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('blocked_numbers')
      .insert({
        phone: normalizedPhone,
        user_id: userId,
        notified: false
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
   
        return { success: true, alreadyBlocked: true };
      }
      throw error;
    }

   
    return { success: true, data };
  } catch (error) {
    console.error('[Block] Erro ao bloquear:', error.message);
    return { success: false, error: error.message };
  }
}


async function getPendingBlockNotifications(userId) {
  try {
    const { data, error } = await supabase
      .from('blocked_numbers')
      .select('id, phone, blocked_at')
      .eq('user_id', userId)
      .eq('notified', false);

    if (error) throw error;

    return { success: true, blocks: data || [] };
  } catch (error) {
    console.error('[Block] Erro ao buscar notificações pendentes:', error.message);
    return { success: false, blocks: [] };
  }
}


async function markBlockAsNotified(blockId) {
  try {
    const { error } = await supabase
      .from('blocked_numbers')
      .update({ notified: true })
      .eq('id', blockId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('[Block] Erro ao marcar como notificado:', error.message);
    return { success: false, error: error.message };
  }
}

async function isBlocked(phone, userId) {
  try {
    const normalizedPhone = phone.replace(/\D/g, '');
    const last9Digits = normalizedPhone.slice(-9);
    const last8Digits = normalizedPhone.slice(-8);

 
    const { data, error } = await supabase
      .from('blocked_numbers')
      .select('id, phone')
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return false;
    }

   
    const isPhoneBlocked = data.some(blocked => {
      const blockedNormalized = blocked.phone.replace(/\D/g, '');
      const blockedLast9 = blockedNormalized.slice(-9);
      const blockedLast8 = blockedNormalized.slice(-8);

      return normalizedPhone === blockedNormalized ||
             last9Digits === blockedLast9 ||
             last8Digits === blockedLast8;
    });

    return isPhoneBlocked;
  } catch (error) {
    console.error('[Block] Erro ao verificar bloqueio:', error.message);
    return false;
  }
}

async function unblockUser(phone, userId) {
  try {
    const normalizedPhone = phone.replace(/\D/g, '');
    const last9Digits = normalizedPhone.slice(-9);


    const { data: blocks, error: findError } = await supabase
      .from('blocked_numbers')
      .select('id, phone')
      .eq('user_id', userId);

    if (findError) throw findError;

    if (!blocks || blocks.length === 0) {
      return { success: true, message: 'Nenhum bloqueio encontrado' };
    }

    const blockToRemove = blocks.find(blocked => {
      const blockedNormalized = blocked.phone.replace(/\D/g, '');
      const blockedLast9 = blockedNormalized.slice(-9);
      return normalizedPhone === blockedNormalized || last9Digits === blockedLast9;
    });

    if (!blockToRemove) {
      return { success: true, message: 'Bloqueio não encontrado para este número' };
    }

    const { error } = await supabase
      .from('blocked_numbers')
      .delete()
      .eq('id', blockToRemove.id);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('[Block] Erro ao desbloquear:', error.message);
    return { success: false, error: error.message };
  }
}

async function getBlockedByUser(userId) {
  try {
    const { data, error } = await supabase
      .from('blocked_numbers')
      .select('phone, blocked_at')
      .eq('user_id', userId)
      .order('blocked_at', { ascending: false });

    if (error) throw error;

    return { success: true, blocked: data || [] };
  } catch (error) {
    console.error('[Block] Erro ao obter bloqueios:', error.message);
    return { success: false, error: error.message };
  }
}


async function createNotification(userId, type, title, message, phone = null) {
  try {
    const { data, error } = await supabase
      .from('user_notifications')
      .insert({
        user_id: userId,
        type,
        title,
        message,
        phone,
        read: false
      })
      .select()
      .single();

    if (error) throw error;

    return { success: true, notification: data };
  } catch (error) {
    console.error('[Notification] Erro ao criar:', error.message);
    return { success: false, error: error.message };
  }
}

async function getUserNotifications(userId, limit = 50) {
  try {
    const { data, error } = await supabase
      .from('user_notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return { success: true, notifications: data || [] };
  } catch (error) {
    console.error('[Notification] Erro ao buscar:', error.message);
    return { success: false, notifications: [] };
  }
}

async function getUnreadNotificationsCount(userId) {
  try {
    const { count, error } = await supabase
      .from('user_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);

    if (error) throw error;

    return { success: true, count: count || 0 };
  } catch (error) {
    console.error('[Notification] Erro ao contar:', error.message);
    return { success: false, count: 0 };
  }
}

async function markNotificationAsRead(notificationId, userId) {
  try {
    const { error } = await supabase
      .from('user_notifications')
      .update({ read: true })
      .eq('id', notificationId)
      .eq('user_id', userId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('[Notification] Erro ao marcar como lida:', error.message);
    return { success: false, error: error.message };
  }
}

async function markAllNotificationsAsRead(userId) {
  try {
    const { error } = await supabase
      .from('user_notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('[Notification] Erro ao marcar todas como lidas:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  supabase,
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
 
  createPhoneVerificationCode,
  verifyPhoneCode,
  isPhoneVerified,

  createPasswordResetCodeByPhone,
  verifyPasswordResetCodeByPhone,
  resetPasswordByPhone,

  hashMessage,
  encryptMessage,
  decryptMessage,
  maskSensitiveData,
  logModerationEvent,
  saveToLegalRetention,
  deleteUserData,
  exportUserData,
  cleanupExpiredData,
  scheduleDataCleanup,
  RETENTION_POLICY,

  getFavorites,
  addFavorite,
  deleteFavorite,
  isFavorite,

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
};
