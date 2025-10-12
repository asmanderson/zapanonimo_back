require('dotenv').config();
const twilio = require('twilio');

class SMSService {
    constructor() {
        this.accountSid = process.env.TWILIO_ACCOUNT_SID;
        this.authToken = process.env.TWILIO_AUTH_TOKEN;
        this.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
        this.twilioNumber = process.env.TWILIO_PHONE_NUMBER;

        if (this.accountSid && this.authToken) {
            this.client = twilio(this.accountSid, this.authToken);
            console.log('✅ Twilio SMS configurado');
        } else {
            console.log('⚠️  Twilio credentials not configured');
        }
    }

    async sendSMS(to, message) {
        if (!this.client) {
            throw new Error('Twilio não está configurado. Adicione as credenciais no arquivo .env');
        }

        try {
            const phoneNumber = this.formatPhoneNumber(to);

            const messageConfig = {
                body: message,
                to: phoneNumber
            };

            if (this.messagingServiceSid) {
                messageConfig.messagingServiceSid = this.messagingServiceSid;
            } else if (this.twilioNumber) {
                messageConfig.from = this.twilioNumber;
            } else {
                throw new Error('Configure TWILIO_MESSAGING_SERVICE_SID ou TWILIO_PHONE_NUMBER no .env');
            }

            const result = await this.client.messages.create(messageConfig);

            return {
                success: true,
                messageId: result.sid,
                status: result.status,
                to: phoneNumber,
                price: result.price,
                priceUnit: result.priceUnit
            };
        } catch (error) {
            console.error('Erro ao enviar SMS:', error);
            throw new Error(`Falha ao enviar SMS: ${error.message}`);
        }
    }

    async sendBulkSMS(phoneNumbers, message) {
        const results = [];
        const errors = [];

        for (const phone of phoneNumbers) {
            try {
                const result = await this.sendSMS(phone, message);
                results.push(result);
            } catch (error) {
                errors.push({
                    phone,
                    error: error.message
                });
            }
        }

        return {
            success: results.length,
            failed: errors.length,
            results,
            errors
        };
    }

    formatPhoneNumber(phone) {

        let cleaned = phone.replace(/\D/g, '');

        if (!phone.startsWith('+')) {
            if (cleaned.length === 11 || cleaned.length === 10) {
                cleaned = '55' + cleaned;
            }
            cleaned = '+' + cleaned;
        }

        return cleaned;
    }

    async checkBalance() {
        if (!this.client) {
            throw new Error('Twilio não está configurado');
        }

        try {
            const account = await this.client.api.accounts(this.accountSid).fetch();
            return {
                balance: account.balance,
                currency: 'USD'
            };
        } catch (error) {
            console.error('Erro ao verificar saldo:', error);
            throw error;
        }
    }
}

module.exports = new SMSService();
