/**
 * Store para salvar sessão do WhatsApp diretamente no banco de dados Supabase
 * Mais simples e confiável que usar Supabase Storage
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[SessionStore] ERRO: SUPABASE_URL e SUPABASE_KEY devem estar configuradas no .env');
}

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

class DatabaseSessionStore {
  constructor(options = {}) {
    this.sessionId = options.sessionId || 'whatsapp-main';
    this.tableName = 'whatsapp_sessions';
  }

  /**
   * Verifica se existe sessão salva no banco
   */
  async sessionExists(options) {
    try {
      if (!supabase) {
        console.log('[SessionStore] Supabase não configurado');
        return false;
      }

      const { data, error } = await supabase
        .from(this.tableName)
        .select('id')
        .eq('session_id', this.sessionId)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('[SessionStore] Erro ao verificar sessão:', error.message);
        return false;
      }

      const exists = !!data;
      console.log(`[SessionStore] Sessão existe no banco: ${exists}`);
      return exists;
    } catch (error) {
      console.error('[SessionStore] Erro ao verificar sessão:', error.message);
      return false;
    }
  }

  /**
   * Salva a sessão no banco de dados
   * O RemoteAuth passa o caminho da pasta da sessão
   */
  async save(options) {
    try {
      if (!supabase) {
        console.error('[SessionStore] Supabase não configurado');
        return;
      }

      const { session } = options;

      console.log('[SessionStore] Salvando sessão no banco...');
      console.log('[SessionStore] Caminho da sessão:', session);

      if (!session || !fs.existsSync(session)) {
        console.error('[SessionStore] Caminho da sessão inválido:', session);
        return;
      }

      // Ler todos os arquivos da pasta de sessão e converter para base64
      const sessionData = await this.readSessionFolder(session);

      if (!sessionData || Object.keys(sessionData).length === 0) {
        console.error('[SessionStore] Nenhum dado de sessão para salvar');
        return;
      }

      // Salvar no banco usando upsert
      const { error } = await supabase
        .from(this.tableName)
        .upsert({
          session_id: this.sessionId,
          session_data: sessionData,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'session_id'
        });

      if (error) {
        console.error('[SessionStore] Erro ao salvar sessão:', error.message);
        throw error;
      }

      console.log(`[SessionStore] Sessão salva com sucesso! (${Object.keys(sessionData).length} arquivos)`);
    } catch (error) {
      console.error('[SessionStore] Erro ao salvar sessão:', error.message);
      throw error;
    }
  }

  /**
   * Extrai/restaura a sessão do banco de dados
   */
  async extract(options) {
    try {
      if (!supabase) {
        console.log('[SessionStore] Supabase não configurado');
        return null;
      }

      const { path: extractPath } = options;

      console.log('[SessionStore] Extraindo sessão do banco...');
      console.log('[SessionStore] Destino:', extractPath);

      const { data, error } = await supabase
        .from(this.tableName)
        .select('session_data')
        .eq('session_id', this.sessionId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          console.log('[SessionStore] Nenhuma sessão encontrada no banco');
          return null;
        }
        console.error('[SessionStore] Erro ao buscar sessão:', error.message);
        return null;
      }

      if (!data || !data.session_data) {
        console.log('[SessionStore] Dados da sessão vazios');
        return null;
      }

      // Restaurar arquivos da sessão
      await this.writeSessionFolder(extractPath, data.session_data);

      console.log(`[SessionStore] Sessão restaurada com sucesso! (${Object.keys(data.session_data).length} arquivos)`);
      return extractPath;
    } catch (error) {
      console.error('[SessionStore] Erro ao extrair sessão:', error.message);
      return null;
    }
  }

  /**
   * Remove a sessão do banco de dados
   */
  async delete(options) {
    try {
      if (!supabase) return;

      console.log('[SessionStore] Removendo sessão do banco...');

      const { error } = await supabase
        .from(this.tableName)
        .delete()
        .eq('session_id', this.sessionId);

      if (error) {
        console.error('[SessionStore] Erro ao remover sessão:', error.message);
      } else {
        console.log('[SessionStore] Sessão removida do banco!');
      }
    } catch (error) {
      console.error('[SessionStore] Erro ao remover sessão:', error.message);
    }
  }

  /**
   * Lê todos os arquivos de uma pasta e converte para objeto JSON
   */
  async readSessionFolder(folderPath) {
    const result = {};

    try {
      const files = this.getAllFiles(folderPath);

      for (const filePath of files) {
        const relativePath = path.relative(folderPath, filePath);
        const content = fs.readFileSync(filePath);

        // Converter para base64 para armazenar no JSON
        result[relativePath] = content.toString('base64');
      }

      return result;
    } catch (error) {
      console.error('[SessionStore] Erro ao ler pasta da sessão:', error.message);
      return {};
    }
  }

  /**
   * Restaura arquivos de um objeto JSON para uma pasta
   */
  async writeSessionFolder(folderPath, sessionData) {
    try {
      // Criar pasta se não existir
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      // Restaurar cada arquivo
      for (const [relativePath, base64Content] of Object.entries(sessionData)) {
        const fullPath = path.join(folderPath, relativePath);
        const dir = path.dirname(fullPath);

        // Criar subpastas se necessário
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Converter de base64 e salvar
        const content = Buffer.from(base64Content, 'base64');
        fs.writeFileSync(fullPath, content);
      }
    } catch (error) {
      console.error('[SessionStore] Erro ao restaurar pasta da sessão:', error.message);
      throw error;
    }
  }

  /**
   * Lista todos os arquivos recursivamente em uma pasta
   */
  getAllFiles(dirPath, arrayOfFiles = []) {
    try {
      const files = fs.readdirSync(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);

        if (fs.statSync(filePath).isDirectory()) {
          this.getAllFiles(filePath, arrayOfFiles);
        } else {
          arrayOfFiles.push(filePath);
        }
      }

      return arrayOfFiles;
    } catch (error) {
      return arrayOfFiles;
    }
  }
}

module.exports = { DatabaseSessionStore };
