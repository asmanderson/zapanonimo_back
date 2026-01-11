const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

transporter.verify(function(error, success) {
  if (error) {
    console.error('[Email] Erro ao verificar transporter SMTP:', error.message);
  }
});

async function sendVerificationEmail(email, verificationToken, name = '') {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const verificationUrl = `${baseUrl}/verify-email?token=${verificationToken}`;
  const displayName = name ? name.split(' ')[0] : ''; // Pega o primeiro nome

  const mailOptions = {
    from: `"Zap Anônimo" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verifique seu email - Zap Anônimo',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 10px;
            padding: 30px;
            border: 1px solid #ddd;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
          }
          .header h1 {
            color: #25D366;
            margin: 0;
          }
          .content {
            background-color: white;
            padding: 20px;
            border-radius: 5px;
          }
          .button {
            display: inline-block;
            padding: 15px 30px;
            background-color: #25D366;
            color: white !important;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            margin: 20px 0;
          }
          .button:hover {
            background-color: #128C7E;
          }
          .footer {
            margin-top: 30px;
            text-align: center;
            font-size: 12px;
            color: #666;
          }
          .warning {
            background-color: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 5px;
            padding: 10px;
            margin-top: 20px;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📱 Zap Anônimo</h1>
          </div>

          <div class="content">
            <h2>Bem-vindo${displayName ? ', ' + displayName : ''}!</h2>
            <p>Obrigado por se cadastrar no Zap Anônimo.</p>
            <p>Para ativar sua conta e começar a enviar mensagens, você precisa verificar seu endereço de email.</p>

            <center>
              <a href="${verificationUrl}" class="button">Verificar Email</a>
            </center>

            <p>Ou copie e cole o link abaixo no seu navegador:</p>
            <p style="word-break: break-all; background-color: #f5f5f5; padding: 10px; border-radius: 5px;">
              ${verificationUrl}
            </p>

            <div class="warning">
              ⚠️ <strong>Importante:</strong> Este link expira em 24 horas. Se você não verificar seu email neste período, precisará solicitar um novo link.
            </div>
          </div>

          <div class="footer">
            <p>Se você não criou uma conta no Zap Anônimo, ignore este email.</p>
            <p>&copy; ${new Date().getFullYear()} Zap Anônimo. Todos os direitos reservados.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  return { success: true, messageId: info.messageId };
}

async function resendVerificationEmail(email, verificationToken, name = '') {
  return sendVerificationEmail(email, verificationToken, name);
}

async function sendWelcomeEmail(email, name = '') {
  const displayName = name ? name.split(' ')[0] : ''; // Pega o primeiro nome

  const mailOptions = {
    from: `"Zap Anônimo" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Conta verificada com sucesso! - Zap Anônimo',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 10px;
            padding: 30px;
            border: 1px solid #ddd;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
          }
          .header h1 {
            color: #25D366;
            margin: 0;
          }
          .success-icon {
            font-size: 64px;
            text-align: center;
            margin: 20px 0;
          }
          .content {
            background-color: white;
            padding: 20px;
            border-radius: 5px;
          }
          .features {
            margin: 20px 0;
          }
          .feature-item {
            padding: 10px;
            margin: 10px 0;
            background-color: #f5f5f5;
            border-radius: 5px;
          }
          .footer {
            margin-top: 30px;
            text-align: center;
            font-size: 12px;
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📱 Zap Anônimo</h1>
          </div>

          <div class="success-icon">✅</div>

          <div class="content">
            <h2 style="text-align: center; color: #25D366;">Email Verificado com Sucesso!</h2>
            <p>Parabéns${displayName ? ', ' + displayName : ''}! Sua conta foi ativada e você já pode começar a usar o Zap Anônimo.</p>

            <div class="features">
              <h3>O que você pode fazer agora:</h3>
              <div class="feature-item">
                📤 <strong>Enviar mensagens:</strong> Envie mensagens para seus contatos via WhatsApp
              </div>
              <div class="feature-item">
                💰 <strong>Gerenciar créditos:</strong> Compre créditos para enviar mais mensagens
              </div>
              <div class="feature-item">
                📊 <strong>Acompanhar histórico:</strong> Veja todas as suas mensagens e transações
              </div>
            </div>

            <p style="text-align: center; margin-top: 30px;">
              <strong>Você recebeu 5 créditos grátis para começar!</strong>
            </p>
          </div>

          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Zap Anônimo. Todos os direitos reservados.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  return { success: true, messageId: info.messageId };
}

async function sendPasswordResetEmail(email, resetToken) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

  const mailOptions = {
    from: `"Zap Anônimo" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Recuperação de Senha - Zap Anônimo',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 10px;
            padding: 30px;
            border: 1px solid #ddd;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
          }
          .header h1 {
            color: #4f46e5;
            margin: 0;
          }
          .content {
            background-color: white;
            padding: 20px;
            border-radius: 5px;
          }
          .button {
            display: inline-block;
            padding: 15px 30px;
            background-color: #4f46e5;
            color: white !important;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            margin: 20px 0;
          }
          .button:hover {
            background-color: #4338ca;
          }
          .footer {
            margin-top: 30px;
            text-align: center;
            font-size: 12px;
            color: #666;
          }
          .warning {
            background-color: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 5px;
            padding: 10px;
            margin-top: 20px;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔒 Zap Anônimo</h1>
          </div>

          <div class="content">
            <h2>Recuperação de Senha</h2>
            <p>Você solicitou a recuperação de senha da sua conta no Zap Anônimo.</p>
            <p>Clique no botão abaixo para redefinir sua senha:</p>

            <center>
              <a href="${resetUrl}" class="button">Redefinir Senha</a>
            </center>

            <p>Ou copie e cole o link abaixo no seu navegador:</p>
            <p style="word-break: break-all; background-color: #f5f5f5; padding: 10px; border-radius: 5px;">
              ${resetUrl}
            </p>

            <div class="warning">
              ⚠️ <strong>Importante:</strong> Este link expira em 1 hora. Se você não solicitou a recuperação de senha, ignore este email e sua senha permanecerá inalterada.
            </div>
          </div>

          <div class="footer">
            <p>Se você não solicitou a recuperação de senha, pode ignorar este email com segurança.</p>
            <p>&copy; ${new Date().getFullYear()} Zap Anônimo. Todos os direitos reservados.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  return { success: true, messageId: info.messageId };
}

async function sendContactEmail(name, email, subject, message) {
  const subjectLabels = {
    'duvida': 'Dúvida sobre o serviço',
    'pagamento': 'Problemas com pagamento',
    'creditos': 'Créditos não recebidos',
    'mensagem': 'Problema ao enviar mensagem',
    'conta': 'Problemas com minha conta',
    'sugestao': 'Sugestão de melhoria',
    'parceria': 'Proposta de parceria',
    'outro': 'Outro assunto'
  };

  const subjectLabel = subjectLabels[subject] || subject;

  const mailOptions = {
    from: `"Zap Anônimo - Contato" <${process.env.EMAIL_USER}>`,
    to: process.env.CONTACT_EMAIL || process.env.EMAIL_USER,
    replyTo: email,
    subject: `[Fale Conosco] ${subjectLabel}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 10px;
            padding: 30px;
            border: 1px solid #ddd;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #4f46e5;
          }
          .header h1 {
            color: #4f46e5;
            margin: 0;
            font-size: 24px;
          }
          .content {
            background-color: white;
            padding: 25px;
            border-radius: 8px;
            border: 1px solid #e2e8f0;
          }
          .field {
            margin-bottom: 20px;
          }
          .field-label {
            font-weight: bold;
            color: #4f46e5;
            font-size: 14px;
            text-transform: uppercase;
            margin-bottom: 5px;
          }
          .field-value {
            background-color: #f8fafc;
            padding: 12px;
            border-radius: 5px;
            border-left: 3px solid #4f46e5;
          }
          .message-box {
            background-color: #f8fafc;
            padding: 15px;
            border-radius: 5px;
            border-left: 3px solid #4f46e5;
            white-space: pre-wrap;
            word-wrap: break-word;
          }
          .footer {
            margin-top: 30px;
            text-align: center;
            font-size: 12px;
            color: #666;
          }
          .timestamp {
            background-color: #fef3c7;
            padding: 10px;
            border-radius: 5px;
            text-align: center;
            margin-top: 20px;
            font-size: 13px;
            color: #92400e;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Nova Mensagem de Contato</h1>
          </div>

          <div class="content">
            <div class="field">
              <div class="field-label">Nome</div>
              <div class="field-value">${name}</div>
            </div>

            <div class="field">
              <div class="field-label">E-mail</div>
              <div class="field-value"><a href="mailto:${email}">${email}</a></div>
            </div>

            <div class="field">
              <div class="field-label">Assunto</div>
              <div class="field-value">${subjectLabel}</div>
            </div>

            <div class="field">
              <div class="field-label">Mensagem</div>
              <div class="message-box">${message.replace(/\n/g, '<br>')}</div>
            </div>

            <div class="timestamp">
              Recebido em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
            </div>
          </div>

          <div class="footer">
            <p>Esta mensagem foi enviada através do formulário de contato do Zap Anônimo.</p>
            <p>Para responder, basta clicar em "Responder" - o email do usuário está configurado como Reply-To.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  return { success: true, messageId: info.messageId };
}

module.exports = {
  sendVerificationEmail,
  resendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendContactEmail
};
