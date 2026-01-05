require('dotenv').config();
const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

const messageSid = process.argv[2] || 'SMcf955270c5acecfd3a63a1583a510388';

async function checkStatus() {
    try {

        const message = await client.messages(messageSid).fetch();


        if (message.errorCode) {
            console.error('❌ Código de erro:', message.errorCode);
            console.error('❌ Mensagem de erro:', message.errorMessage);
        }


    } catch (error) {
        console.error('❌ Erro:', error.message);
    }
}

checkStatus();
