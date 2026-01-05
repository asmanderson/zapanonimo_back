require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[SupabaseStore] ERRO: SUPABASE_URL e SUPABASE_KEY devem estar configuradas no .env');
}

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const BUCKET_NAME = 'whatsapp-sessions';
const SESSION_FILE = 'session.zip';

class SupabaseStore {
  constructor(options = {}) {
    this.sessionId = options.sessionId || 'default';
    this.tempDir = options.tempDir || './.wwebjs_temp';
    this.bucketName = BUCKET_NAME;

 
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }


  async ensureBucket() {
    if (!supabase) {
      console.error('[SupabaseStore] Cliente Supabase não inicializado');
      return;
    }

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


  async sessionExists(options) {
    try {
      await this.ensureBucket();

      const filePath = `${this.sessionId}/${SESSION_FILE}`;
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .list(this.sessionId);

      if (error) {

        return false;
      }

      const exists = data?.some(file => file.name === SESSION_FILE);
      return exists;
    } catch (error) {
      console.error('Erro ao verificar sessão:', error);
      return false;
    }
  }


  async save(options) {
    const { session } = options;

    try {
      await this.ensureBucket();

  
      const zipPath = path.join(this.tempDir, `${this.sessionId}_session.zip`);

      await this.zipSession(session, zipPath);

 
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

    
      fs.unlinkSync(zipPath);

    } catch (error) {
      console.error('[SupabaseStore] Erro ao salvar sessão:', error);
      throw error;
    }
  }

  async extract(options) {
    const zipPath = path.join(this.tempDir, `${this.sessionId}_download.zip`);

    try {
      await this.ensureBucket();


      const filePath = `${this.sessionId}/${SESSION_FILE}`;

      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .download(filePath);

      if (error) {
        return null;
      }

      if (!data) {
        return null;
      }

      if (fs.existsSync(zipPath)) {
        const stats = fs.statSync(zipPath);
        if (stats.isDirectory()) {
          fs.rmSync(zipPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(zipPath);
        }
      }

 
      const buffer = Buffer.from(await data.arrayBuffer());

  
      if (buffer.length < 100) {
        await this.delete({});
        return null;
      }

      fs.writeFileSync(zipPath, buffer);


      if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
        console.error('[SupabaseStore] Falha ao salvar arquivo zip temporário');
        return null;
      }


      if (options.path && fs.existsSync(options.path)) {
        fs.rmSync(options.path, { recursive: true, force: true });
      }

  
      const sessionData = await this.unzipSession(zipPath, options.path);

   
      if (fs.existsSync(zipPath) && fs.statSync(zipPath).isFile()) {
        fs.unlinkSync(zipPath);
      }

      return sessionData;
    } catch (error) {
      console.error('[SupabaseStore] Erro ao extrair sessão:', error.message);


      try {
        if (fs.existsSync(zipPath)) {
          const stats = fs.statSync(zipPath);
          if (stats.isDirectory()) {
            fs.rmSync(zipPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(zipPath);
          }
        }
      } catch (cleanupError) {
        console.error('[SupabaseStore] Erro ao limpar arquivo temporário:', cleanupError.message);
      }

      return null;
    }
  }


  async delete(options) {
    try {
      const filePath = `${this.sessionId}/${SESSION_FILE}`;

      const { error } = await supabase.storage
        .from(this.bucketName)
        .remove([filePath]);

      if (error) {
        console.error('[SupabaseStore] Erro ao remover sessão:', error);
      }
    } catch (error) {
      console.error('[SupabaseStore] Erro ao remover sessão:', error);
    }
  }


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


  unzipSession(zipPath, extractPath) {
    return new Promise((resolve, reject) => {
      try {

        if (!fs.existsSync(zipPath)) {
          return reject(new Error(`Arquivo zip não encontrado: ${zipPath}`));
        }

        const zipStats = fs.statSync(zipPath);
        if (!zipStats.isFile()) {
          return reject(new Error(`O caminho não é um arquivo: ${zipPath}`));
        }


        if (fs.existsSync(extractPath)) {
          const extractStats = fs.statSync(extractPath);
          if (extractStats.isDirectory()) {
 
            fs.rmSync(extractPath, { recursive: true, force: true });
          }
        }


        fs.mkdirSync(extractPath, { recursive: true });

        const readStream = fs.createReadStream(zipPath);

        readStream.on('error', (err) => {
          console.error('[SupabaseStore] Erro ao ler arquivo zip:', err);
          reject(err);
        });

        readStream
          .pipe(unzipper.Extract({ path: extractPath }))
          .on('close', () => resolve(extractPath))
          .on('error', (err) => {
            console.error('[SupabaseStore] Erro ao extrair zip:', err);
            reject(err);
          });
      } catch (err) {
        console.error('[SupabaseStore] Erro em unzipSession:', err);
        reject(err);
      }
    });
  }
}

module.exports = { SupabaseStore };
