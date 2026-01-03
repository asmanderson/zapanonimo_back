require('dotenv').config();

const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[Database] ERRO: SUPABASE_URL e SUPABASE_KEY devem estar configuradas no .env');
  throw new Error('Configuração do Supabase ausente. Verifique o arquivo .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('[Database] Conexão com Supabase inicializada');

async function createUser(email, password) {
  const hashedPassword = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('users')
    .insert([
      {
        email,
        password: hashedPassword,
        whatsapp_credits: 1,
        sms_credits: 1,
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

async function useCredit(userId, phone, message, channel = 'whatsapp') {
  const creditColumn = channel === 'whatsapp' ? 'whatsapp_credits' : 'sms_credits';

  const user = await getUserById(userId);
  const credits = channel === 'whatsapp' ? user.whatsapp_credits : user.sms_credits;

  if (!user || credits < 1) {
    throw new Error(`Créditos de ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} insuficientes`);
  }

  const { data, error } = await supabase.rpc('use_credit_transaction', {
    p_user_id: userId,
    p_phone: phone,
    p_message: message,
    p_channel: channel
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
        channel: channel
      }]);

    if (messageError) throw messageError;
  }

  return true;
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

async function findMessageByPhone(phone, channel = null) {
  const normalizedPhone = phone.replace(/\D/g, '');
  const last9Digits = normalizedPhone.slice(-9);
  const last8Digits = normalizedPhone.slice(-8);

  let query = supabase
    .from('messages')
    .select('*, users(id, email)')
    .order('created_at', { ascending: false })
    .limit(1);

  if (channel) {
    query = query.eq('channel', channel);
  }

  const { data, error } = await query.or(`phone.ilike.%${normalizedPhone}%,phone.ilike.%${last9Digits}%,phone.ilike.%${last8Digits}%`);

  if (error) throw error;

  return data && data.length > 0 ? data[0] : null;
}

async function saveReplyFromWebhook(fromPhone, replyMessage, channel) {
  const originalMessage = await findMessageByPhone(fromPhone, channel);

  if (!originalMessage) {
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

  if (error) throw error;

  await supabase
    .from('messages')
    .update({ has_reply: true })
    .eq('id', originalMessage.id);

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
  saveReplyFromWebhook,
  createVerificationToken,
  verifyEmailToken,
  isEmailVerified,
  createPasswordResetToken,
  verifyPasswordResetToken,
  resetPassword
};
