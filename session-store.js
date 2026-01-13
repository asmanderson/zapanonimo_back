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
    this.dataPath = options.dataPath || './.wwebjs_auth';
  }


  async sessionExists(options) {
    try {
      if (!supabase) {
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

      return !!data;
    } catch (error) {
      console.error('[SessionStore] Erro ao verificar sessão:', error.message);
      return false;
    }
  }


  async save(options) {
    try {
      if (!supabase) {
        console.error('[SessionStore] Supabase não configurado');
        return;
      }

      const { session } = options;

      // RemoteAuth passa 'RemoteAuth' como session, então usamos o dataPath configurado
      const sessionPath = (session && session !== 'RemoteAuth' && fs.existsSync(session))
        ? session
        : this.dataPath;

      if (!fs.existsSync(sessionPath)) {
        console.log('[SessionStore] Aguardando criação da pasta de sessão:', sessionPath);
        return;
      }


      const sessionData = await this.readSessionFolder(sessionPath);

      if (!sessionData || Object.keys(sessionData).length === 0) {
        console.error('[SessionStore] Nenhum dado de sessão para salvar');
        return;
      }

    
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
    } catch (error) {
      console.error('[SessionStore] Erro ao salvar sessão:', error.message);
      throw error;
    }
  }


  async extract(options) {
    try {
      if (!supabase) {
        return null;
      }

      const { path: extractPath } = options;

      const { data, error } = await supabase
        .from(this.tableName)
        .select('session_data')
        .eq('session_id', this.sessionId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return null;
        }
        console.error('[SessionStore] Erro ao buscar sessão:', error.message);
        return null;
      }

      if (!data || !data.session_data) {
        return null;
      }


      await this.writeSessionFolder(extractPath, data.session_data);

      return extractPath;
    } catch (error) {
      console.error('[SessionStore] Erro ao extrair sessão:', error.message);
      return null;
    }
  }


  async delete(options) {
    try {
      if (!supabase) return;

      const { error } = await supabase
        .from(this.tableName)
        .delete()
        .eq('session_id', this.sessionId);

      if (error) {
        console.error('[SessionStore] Erro ao remover sessão:', error.message);
      }
    } catch (error) {
      console.error('[SessionStore] Erro ao remover sessão:', error.message);
    }
  }


  async readSessionFolder(folderPath) {
    const result = {};

    try {
      const files = this.getAllFiles(folderPath);

      for (const filePath of files) {
        const relativePath = path.relative(folderPath, filePath);
        const content = fs.readFileSync(filePath);


        result[relativePath] = content.toString('base64');
      }

      return result;
    } catch (error) {
      console.error('[SessionStore] Erro ao ler pasta da sessão:', error.message);
      return {};
    }
  }


  async writeSessionFolder(folderPath, sessionData) {
    try {

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

    
      for (const [relativePath, base64Content] of Object.entries(sessionData)) {
        const fullPath = path.join(folderPath, relativePath);
        const dir = path.dirname(fullPath);

  
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

 
        const content = Buffer.from(base64Content, 'base64');
        fs.writeFileSync(fullPath, content);
      }
    } catch (error) {
      console.error('[SessionStore] Erro ao restaurar pasta da sessão:', error.message);
      throw error;
    }
  }


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
