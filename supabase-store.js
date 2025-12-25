/**
 * Store customizado para salvar sessão do WhatsApp no Supabase Storage
 * Usado com RemoteAuth do whatsapp-web.js
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');

const supabaseUrl = process.env.SUPABASE_URL || 'https://lvjtbzonstvklytiltnm.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const BUCKET_NAME = 'whatsapp-sessions';
const SESSION_FILE = 'session.zip';

class SupabaseStore {
  constructor(options = {}) {
    this.sessionId = options.sessionId || 'default';
    this.tempDir = options.tempDir || './.wwebjs_temp';
    this.bucketName = BUCKET_NAME;

    // Criar diretório temporário se não existir
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Verifica se o bucket existe, se não, cria
   */
  async ensureBucket() {
    try {
      const { data: buckets } = await supabase.storage.listBuckets();
      const bucketExists = buckets?.some(b => b.name === this.bucketName);

      if (!bucketExists) {
        const { error } = await supabase.storage.createBucket(this.bucketName, {
          public: false
        });
        if (error && !error.message.includes('already exists')) {
          console.error('Erro ao criar bucket:', error);
        }
      }
    } catch (error) {
      console.error('Erro ao verificar/criar bucket:', error);
    }
  }

  /**
   * Verifica se existe sessão salva
   */
  async sessionExists(options) {
    try {
      await this.ensureBucket();

      const filePath = `${this.sessionId}/${SESSION_FILE}`;
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .list(this.sessionId);

      if (error) {
        console.log('Erro ao verificar sessão:', error.message);
        return false;
      }

      const exists = data?.some(file => file.name === SESSION_FILE);
      console.log(`[SupabaseStore] Sessão existe: ${exists}`);
      return exists;
    } catch (error) {
      console.error('Erro ao verificar sessão:', error);
      return false;
    }
  }

  /**
   * Salva a sessão no Supabase Storage
   */
  async save(options) {
    const { session } = options;

    try {
      await this.ensureBucket();

      console.log('[SupabaseStore] Salvando sessão no Supabase...');

      // Criar arquivo zip da sessão
      const zipPath = path.join(this.tempDir, `${this.sessionId}_session.zip`);

      await this.zipSession(session, zipPath);

      // Fazer upload para o Supabase
      const fileBuffer = fs.readFileSync(zipPath);
      const filePath = `${this.sessionId}/${SESSION_FILE}`;

      const { error } = await supabase.storage
        .from(this.bucketName)
        .upload(filePath, fileBuffer, {
          contentType: 'application/zip',
          upsert: true
        });

      if (error) {
        throw error;
      }

      // Limpar arquivo temporário
      fs.unlinkSync(zipPath);

      console.log('[SupabaseStore] Sessão salva com sucesso!');
    } catch (error) {
      console.error('[SupabaseStore] Erro ao salvar sessão:', error);
      throw error;
    }
  }

  /**
   * Extrai a sessão do Supabase Storage
   */
  async extract(options) {
    try {
      await this.ensureBucket();

      console.log('[SupabaseStore] Extraindo sessão do Supabase...');

      const filePath = `${this.sessionId}/${SESSION_FILE}`;

      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .download(filePath);

      if (error) {
        console.log('[SupabaseStore] Nenhuma sessão encontrada');
        return null;
      }

      // Salvar arquivo zip temporariamente
      const zipPath = path.join(this.tempDir, `${this.sessionId}_download.zip`);
      const buffer = Buffer.from(await data.arrayBuffer());
      fs.writeFileSync(zipPath, buffer);

      // Extrair sessão
      const sessionData = await this.unzipSession(zipPath, options.path);

      // Limpar arquivo temporário
      fs.unlinkSync(zipPath);

      console.log('[SupabaseStore] Sessão extraída com sucesso!');
      return sessionData;
    } catch (error) {
      console.error('[SupabaseStore] Erro ao extrair sessão:', error);
      return null;
    }
  }

  /**
   * Remove a sessão do Supabase Storage
   */
  async delete(options) {
    try {
      console.log('[SupabaseStore] Removendo sessão do Supabase...');

      const filePath = `${this.sessionId}/${SESSION_FILE}`;

      const { error } = await supabase.storage
        .from(this.bucketName)
        .remove([filePath]);

      if (error) {
        console.error('[SupabaseStore] Erro ao remover sessão:', error);
      } else {
        console.log('[SupabaseStore] Sessão removida com sucesso!');
      }
    } catch (error) {
      console.error('[SupabaseStore] Erro ao remover sessão:', error);
    }
  }

  /**
   * Compacta a pasta de sessão em um arquivo zip
   */
  zipSession(sessionPath, zipPath) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve());
      archive.on('error', (err) => reject(err));

      archive.pipe(output);

      if (fs.existsSync(sessionPath)) {
        archive.directory(sessionPath, false);
      }

      archive.finalize();
    });
  }

  /**
   * Extrai o arquivo zip para a pasta de sessão
   */
  unzipSession(zipPath, extractPath) {
    return new Promise((resolve, reject) => {
      // Criar diretório de destino se não existir
      if (!fs.existsSync(extractPath)) {
        fs.mkdirSync(extractPath, { recursive: true });
      }

      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: extractPath }))
        .on('close', () => resolve(extractPath))
        .on('error', (err) => reject(err));
    });
  }
}

module.exports = { SupabaseStore };
