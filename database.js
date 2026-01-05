require('dotenv').config();

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Gera código de rastreamento único (ex: by7K2m)
function generateTrackingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // Sem caracteres ambíguos (0, O, 1, l, I)
  let code = 'by';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Extrai código de rastreamento de uma mensagem (se existir)
function extractTrackingCode(message) {
  // Procura por padrão "by" seguido de 4 caracteres alfanuméricos
  const match = message.match(/\bby([A-HJ-NP-Za-hj-np-z2-9]{4})\b/i);
  return match ? 'by' + match[1] : null;
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[Database] ERRO: SUPABASE_URL e SUPABASE_KEY devem estar configuradas no .env');
  throw new Error('Configuração do Supabase ausente. Verifique o arquivo .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('[Database] Conexão com Supabase inicializada');

// ==================== MAPEAMENTO LID -> NÚMERO ====================
// Cache em memória para mapeamento LID -> número de telefone
const lidToPhoneMap = new Map();

// Salva mapeamento LID -> número
function saveLidMapping(lid, phone) {
  const cleanLid = lid.replace('@lid', '').replace(/\D/g, '');
  const cleanPhone = phone.replace(/\D/g, '');
  lidToPhoneMap.set(cleanLid, cleanPhone);
  console.log(`[Database] Mapeamento salvo: LID ${cleanLid} -> Telefone ${cleanPhone}`);
}

// Busca número pelo LID
function getPhoneByLid(lid) {
  const cleanLid = lid.replace('@lid', '').replace(/\D/g, '');
  const phone = lidToPhoneMap.get(cleanLid);
  if (phone) {
    console.log(`[Database] Mapeamento encontrado: LID ${cleanLid} -> Telefone ${phone}`);
  }
  return phone || null;
}

// Busca a mensagem mais recente sem resposta (para mapeamento automático)
async function findRecentMessageWithoutReply(channel = 'whatsapp', maxMinutes = 30) {
  const cutoffTime = new Date();
  cutoffTime.setMinutes(cutoffTime.getMinutes() - maxMinutes);
  const cutoffISO = cutoffTime.toISOString();

  console.log(`[Database] Buscando mensagem recente sem resposta (últimos ${maxMinutes} min, canal: ${channel})`);

  const { data, error } = await supabase
    .from('messages')
    .select('*, users(id, email)')
    .eq('channel', channel)
    .eq('has_reply', false)
    .gte('created_at', cutoffISO)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error(`[Database] Erro ao buscar mensagem recente: ${error.message}`);
    return null;
  }

  if (data && data.length > 0) {
    console.log(`[Database] Mensagem recente encontrada: ID ${data[0].id}, telefone ${data[0].phone}, usuário ${data[0].user_id}`);
    return data[0];
  }

  console.log(`[Database] Nenhuma mensagem recente sem resposta encontrada`);
  return null;
}

// ==================== FIM MAPEAMENTO LID ====================

async function createUser(email, password) {
  const hashedPassword = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('users')
    .insert([
      {
        email,
        password: hashedPassword,
        whatsapp_credits: 5,
        sms_credits: 5,
        email_verified: false
      }
    ])
    .select()
    .single();

  if (error) throw error;
  return { id: data.id };
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

  // Gerar código de rastreamento se não foi fornecido
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

async function saveReply(userId, messageId, fromPhone, replyMessage, channel) {
  const { data, error } = await supabase
    .from('replies')
    .insert([{
      user_id: userId,
      message_id: messageId,
      from_phone: fromPhone,
      message: replyMessage,
      channel: channel
    }])
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from('messages')
    .update({ has_reply: true })
    .eq('id', messageId);

  return data;
}

// Busca mensagem pelo código de rastreamento (match exato)
async function findMessageByTrackingCode(trackingCode, channel = null) {
  console.log(`[Database] Buscando mensagem pelo código: ${trackingCode}`);

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

  if (error) {
    console.error(`[Database] Erro ao buscar por código: ${error.message}`);
    return null;
  }

  if (data && data.length > 0) {
    console.log(`[Database] Mensagem encontrada pelo código ${trackingCode}: ID ${data[0].id}, usuário ${data[0].user_id}`);
    return data[0];
  }

  console.log(`[Database] Nenhuma mensagem encontrada com código ${trackingCode}`);
  return null;
}

// Busca mensagem pelo telefone (fallback quando não há código)
async function findMessageByPhone(phone, channel = null) {
  const normalizedPhone = phone.replace(/\D/g, '');
  const last9Digits = normalizedPhone.slice(-9);
  const last8Digits = normalizedPhone.slice(-8);

  // Limite de 7 dias para associar respostas
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoISO = sevenDaysAgo.toISOString();

  console.log(`[Database] Buscando mensagem para telefone: ${phone} (normalizado: ${normalizedPhone}, últimos 9: ${last9Digits}, últimos 8: ${last8Digits}, canal: ${channel || 'qualquer'}, após: ${sevenDaysAgoISO})`);

  let query = supabase
    .from('messages')
    .select('*, users(id, email)')
    .gte('created_at', sevenDaysAgoISO)  // Apenas mensagens dos últimos 7 dias
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
    console.log(`[Database] Mensagem encontrada: ID ${data[0].id}, usuário ${data[0].user_id}, telefone armazenado: ${data[0].phone}`);
    return data[0];
  } else {
    console.log(`[Database] Nenhuma mensagem encontrada para ${normalizedPhone} nos últimos 7 dias`);
    return null;
  }
}

async function saveReplyFromWebhook(fromPhone, replyMessage, channel, isLid = false) {
  console.log(`[Database] Salvando resposta - de: ${fromPhone}, canal: ${channel}, isLid: ${isLid}`);

  let originalMessage = null;
  let phoneToSearch = fromPhone;

  // 1. Primeiro, tentar encontrar pelo código de rastreamento na resposta
  const trackingCode = extractTrackingCode(replyMessage);
  if (trackingCode) {
    console.log(`[Database] Código de rastreamento encontrado: ${trackingCode}`);
    originalMessage = await findMessageByTrackingCode(trackingCode, channel);
    if (originalMessage) {
      console.log(`[Database] Mensagem encontrada pelo código! Usuário: ${originalMessage.user_id}`);
      // Salvar mapeamento LID -> número para futuras mensagens
      if (isLid && originalMessage.phone) {
        saveLidMapping(fromPhone, originalMessage.phone);
      }
    }
  }

  // 2. Se é um LID, verificar se tem mapeamento salvo
  if (!originalMessage && isLid) {
    const mappedPhone = getPhoneByLid(fromPhone);
    if (mappedPhone) {
      console.log(`[Database] Usando número mapeado: ${mappedPhone}`);
      phoneToSearch = mappedPhone;
      originalMessage = await findMessageByPhone(phoneToSearch, channel);
    }
  }

  // 3. Se não encontrou, buscar pelo telefone (método tradicional)
  if (!originalMessage) {
    console.log(`[Database] Buscando pelo telefone: ${phoneToSearch}`);
    originalMessage = await findMessageByPhone(phoneToSearch, channel);
  }

  // 4. Se ainda não encontrou e é um LID, tentar buscar mensagem recente sem resposta
  if (!originalMessage && isLid) {
    console.log(`[Database] LID sem match - tentando encontrar mensagem recente sem resposta...`);
    originalMessage = await findRecentMessageWithoutReply(channel, 60); // últimos 60 minutos

    if (originalMessage) {
      console.log(`[Database] Mensagem recente encontrada! Criando mapeamento LID -> ${originalMessage.phone}`);
      // Salvar mapeamento para futuras mensagens
      saveLidMapping(fromPhone, originalMessage.phone);
    }
  }

  if (!originalMessage) {
    console.log(`[Database] Não foi possível salvar resposta - mensagem original não encontrada para ${fromPhone}`);
    return null;
  }

  const { data, error } = await supabase
    .from('replies')
    .insert([{
      user_id: originalMessage.user_id,
      message_id: originalMessage.id,
      from_phone: fromPhone,
      message: replyMessage,
      channel: channel
    }])
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

  console.log(`[Database] Resposta salva com sucesso - ID: ${data.id}, para usuário: ${originalMessage.user_id}`);

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

// ==================== WHATSAPP STATS PERSISTENCE ====================

async function getWhatsAppStats() {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'whatsapp_stats')
      .single();

    if (error) {
      // Se a tabela ou registro não existe, retorna valores default
      if (error.code === 'PGRST116' || error.code === '42P01') {
        console.log('[Database] WhatsApp stats não encontrado, usando valores default');
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

    // Salvar status apenas se fornecido
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
      // Se a tabela não existe, tentar criar
      if (error.code === '42P01') {
        console.log('[Database] Tabela system_settings não existe, stats não serão persistidos');
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

// ==================== FIM WHATSAPP STATS ====================

module.exports = {
  supabase,
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
  getPhoneByLid
};
