require('dotenv').config();
const smsService = require('./sms-service');
async function testSMS() {

    try {
   
        const balance = await smsService.checkBalance();


    } catch (error) {
        console.error('❌ Erro ao verificar saldo:', error.message);

    }

    const testPhone = process.argv[2] || '+5585991964253'; 
    const testMessage = process.argv[3] || 'Teste de SMS do Zap Anônimo';

    try {


        const result = await smsService.sendSMS(testPhone, testMessage);

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
