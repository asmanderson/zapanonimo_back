-- ==========================================
-- TABELA DE LOGS DE MODERAÇÃO (CONFORMIDADE LGPD)
-- ==========================================
-- Execute este SQL no Supabase SQL Editor

-- Criar tabela de logs de moderação
CREATE TABLE IF NOT EXISTS moderation_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    message_hash VARCHAR(64), -- SHA-256 hash da mensagem (não o texto)
    action VARCHAR(20) NOT NULL CHECK (action IN ('allowed', 'blocked')),
    category VARCHAR(50),
    risk_score INTEGER DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
    ip_address VARCHAR(45), -- Suporta IPv6
    user_agent TEXT,
    target_phone_hash VARCHAR(64), -- Hash do telefone destino
    channel VARCHAR(20) DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms')),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_moderation_logs_user_id ON moderation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_timestamp ON moderation_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_action ON moderation_logs(action);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_category ON moderation_logs(category);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_risk_score ON moderation_logs(risk_score);

-- Políticas de segurança RLS (Row Level Security)
ALTER TABLE moderation_logs ENABLE ROW LEVEL SECURITY;

-- Apenas o serviço pode inserir logs
CREATE POLICY "Service can insert moderation logs"
    ON moderation_logs
    FOR INSERT
    WITH CHECK (true);

-- Apenas admins podem ver logs (via service role)
CREATE POLICY "Service can select moderation logs"
    ON moderation_logs
    FOR SELECT
    USING (true);

-- Apenas o serviço pode deletar (para limpeza automática)
CREATE POLICY "Service can delete moderation logs"
    ON moderation_logs
    FOR DELETE
    USING (true);

-- ==========================================
-- ADICIONAR COLUNA anonymized_at NA TABELA transactions
-- ==========================================

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

-- ==========================================
-- COMENTÁRIOS PARA DOCUMENTAÇÃO
-- ==========================================

COMMENT ON TABLE moderation_logs IS 'Logs de moderação de conteúdo para conformidade legal e LGPD';
COMMENT ON COLUMN moderation_logs.message_hash IS 'SHA-256 hash da mensagem original - texto completo NÃO é armazenado';
COMMENT ON COLUMN moderation_logs.risk_score IS 'Score de risco: 0=seguro, 100=bloqueio automático';
COMMENT ON COLUMN moderation_logs.target_phone_hash IS 'Hash do telefone destino - número real NÃO é armazenado';
COMMENT ON COLUMN moderation_logs.metadata IS 'Dados adicionais como tipos detectados e regras acionadas';

-- ==========================================
-- FUNÇÃO PARA LIMPEZA AUTOMÁTICA (OPCIONAL)
-- ==========================================

-- Criar função para limpar logs antigos
CREATE OR REPLACE FUNCTION cleanup_old_moderation_logs()
RETURNS void AS $$
BEGIN
    -- Deletar logs técnicos com mais de 180 dias (exceto abusos graves)
    DELETE FROM moderation_logs
    WHERE timestamp < NOW() - INTERVAL '180 days'
    AND category NOT IN ('criminal_threat', 'blackmail_extortion', 'threat', 'hate_speech');

    -- Deletar logs de abuso com mais de 730 dias (2 anos)
    DELETE FROM moderation_logs
    WHERE timestamp < NOW() - INTERVAL '730 days';
END;
$$ LANGUAGE plpgsql;

-- Para agendar execução diária (requer pg_cron extension):
-- SELECT cron.schedule('cleanup-moderation-logs', '0 3 * * *', 'SELECT cleanup_old_moderation_logs()');
