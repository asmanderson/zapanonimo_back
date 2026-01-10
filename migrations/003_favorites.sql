-- ==========================================
-- FAVORITOS - CONTATOS SALVOS POR USUARIO
-- ==========================================
-- Execute este SQL no Supabase SQL Editor

CREATE TABLE IF NOT EXISTS favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Cada usuario so pode ter um favorito com o mesmo telefone
    UNIQUE(user_id, phone)
);

-- Indices para busca rapida
CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_phone ON favorites(phone);

-- Comentarios
COMMENT ON TABLE favorites IS 'Contatos favoritos salvos por cada usuario';
COMMENT ON COLUMN favorites.user_id IS 'ID do usuario dono do favorito';
COMMENT ON COLUMN favorites.name IS 'Nome do contato (ex: Joao)';
COMMENT ON COLUMN favorites.phone IS 'Numero do telefone (ex: 11999999999)';

-- RLS (Row Level Security) para garantir que usuario so veja seus favoritos
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;

-- Politica: usuario so pode ver seus proprios favoritos
CREATE POLICY favorites_user_isolation ON favorites
    FOR ALL
    USING (user_id = current_setting('app.current_user_id')::INTEGER);
