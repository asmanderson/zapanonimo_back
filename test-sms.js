require('dotenv').config();
const smsService = require('./sms-service');

async function testSMS() {
    console.log('🧪 Iniciando teste de SMS...\n');

    // 1. Verificar saldo
    try {
        console.log('📊 Verificando saldo do Twilio...');
        const balance = await smsService.checkBalance();
        console.log('✅ Saldo:', balance);
        console.log('');
    } catch (error) {
        console.error('❌ Erro ao verificar saldo:', error.message);
        console.log('');
    }

    // 2. Testar envio de SMS
    const testPhone = process.argv[2] || '+5585991964253'; // Usar número da linha de comando ou padrão
    const testMessage = process.argv[3] || 'Teste de SMS do Zap Anônimo';

    try {
        console.log('📱 Testando envio de SMS...');
        console.log('Para:', testPhone);
        console.log('Mensagem:', testMessage);
        console.log('');

        const result = await smsService.sendSMS(testPhone, testMessage);

        console.log('✅ SMS enviado com sucesso!');
        console.log('Detalhes:', result);
    } catch (error) {
        console.error('❌ Erro ao enviar SMS:', error.message);
        if (error.code) {
            console.error('Código do erro:', error.code);
        }
        if (error.moreInfo) {
            console.error('Mais informações:', error.moreInfo);
        }
    }
}

testSMS();
