const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://lvjtbzonstvklytiltnm.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2anRiem9uc3R2a2x5dGlsdG5tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTcxMzIwNCwiZXhwIjoyMDc1Mjg5MjA0fQ.eLjJwgEPvXw4wHpRZhRsT02kq8-GF1lxFQTSyls6gBM';

const supabase = createClient(supabaseUrl, supabaseKey);

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
    console.warn('RPC add_credits_transaction não encontrada, executando manualmente');

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
    console.warn('RPC use_credit_transaction não encontrada, executando manualmente');

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
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

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
  createVerificationToken,
  verifyEmailToken,
  isEmailVerified,
  createPasswordResetToken,
  verifyPasswordResetToken,
  resetPassword
};
