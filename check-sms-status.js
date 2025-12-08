require('dotenv').config();
const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// Use o SID da mensagem anterior
const messageSid = process.argv[2] || 'SMcf955270c5acecfd3a63a1583a510388';

async function checkStatus() {
    try {
        console.log('📱 Verificando status da mensagem:', messageSid);
        console.log('');

        const message = await client.messages(messageSid).fetch();

        console.log('Status:', message.status);
        console.log('Para:', message.to);
        console.log('De:', message.from);
        console.log('Corpo:', message.body);
        console.log('Data de envio:', message.dateSent);
        console.log('Data de atualização:', message.dateUpdated);
        console.log('Preço:', message.price, message.priceUnit);
        console.log('');

        if (message.errorCode) {
            console.error('❌ Código de erro:', message.errorCode);
            console.error('❌ Mensagem de erro:', message.errorMessage);
        }

        // Explicar os status possíveis
        console.log('📊 Significado dos status:');
        console.log('- queued: Na fila para envio');
        console.log('- sending: Sendo enviado');
        console.log('- sent: Enviado para a operadora');
        console.log('- delivered: Entregue ao destinatário ✅');
        console.log('- undelivered: Não entregue ❌');
        console.log('- failed: Falhou ❌');

    } catch (error) {
        console.error('❌ Erro:', error.message);
    }
}

checkStatus();
