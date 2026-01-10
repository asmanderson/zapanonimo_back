-- ==========================================
-- CADASTRO POR TELEFONE OU EMAIL
-- ==========================================
-- Execute este SQL no Supabase SQL Editor

-- Adicionar campo phone na tabela users
ALTER TABLE users
ADD COLUMN IF NOT EXISTS phone VARCHAR(20) UNIQUE;

-- Adicionar campo phone_verified
ALTER TABLE users
ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;

-- Criar índice para busca por telefone
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- Tornar email opcional (pode ser null se tiver telefone)
ALTER TABLE users
ALTER COLUMN email DROP NOT NULL;

-- Adicionar constraint: deve ter email OU telefone
ALTER TABLE users
ADD CONSTRAINT users_email_or_phone_required
CHECK (email IS NOT NULL OR phone IS NOT NULL);

-- ==========================================
-- TABELA DE VERIFICAÇÃO POR SMS
-- ==========================================

CREATE TABLE IF NOT EXISTS phone_verifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    phone VARCHAR(20) NOT NULL,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para busca rápida
CREATE INDEX IF NOT EXISTS idx_phone_verifications_phone ON phone_verifications(phone);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_code ON phone_verifications(code);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_user_id ON phone_verifications(user_id);

-- Limpar códigos expirados automaticamente
CREATE INDEX IF NOT EXISTS idx_phone_verifications_expires ON phone_verifications(expires_at);

-- ==========================================
-- COMENTÁRIOS
-- ==========================================

COMMENT ON COLUMN users.phone IS 'Número de telefone do usuário (formato: +5511999999999)';
COMMENT ON COLUMN users.phone_verified IS 'Se o telefone foi verificado via SMS';
COMMENT ON TABLE phone_verifications IS 'Códigos de verificação enviados por SMS';
COMMENT ON COLUMN phone_verifications.attempts IS 'Número de tentativas de verificação (máximo 5)';
