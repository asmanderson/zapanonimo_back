require('dotenv').config();

const stripeKey = process.env.STRIPE_SECRET_KEY;

if (!stripeKey) {
  console.error('❌ ERRO: STRIPE_SECRET_KEY não encontrada no .env');
  throw new Error('STRIPE_SECRET_KEY não configurada');
}

const stripe = require('stripe')(stripeKey);

function calculatePrice(quantity, creditType = 'whatsapp') {
  const pricePerCredit = creditType === 'sms' ? 1.00 : 2.00;
  const basePrice = quantity * pricePerCredit;

  if (quantity >= 100) {
    return basePrice * 0.70; 
  } else if (quantity >= 50) {
    return basePrice * 0.80; 
  } else if (quantity >= 25) {
    return basePrice * 0.90; 
  } else if (quantity >= 5) {
    return basePrice * 0.95; 
  }

  return basePrice;
}

async function createCheckoutSession(userId, quantity, userEmail, creditType = 'whatsapp') {

  const price = calculatePrice(quantity, creditType);

  const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://zapanonimo.fly.dev';

  const productName = creditType === 'whatsapp'
    ? `${quantity} Crédito(s) WhatsApp`
    : `${quantity} Crédito(s) SMS`;

  const productDescription = creditType === 'whatsapp'
    ? `Compra de ${quantity} crédito(s) para envio no WhatsApp`
    : `Compra de ${quantity} crédito(s) para envio de SMS`;


  try {

    const sessionData = {
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: productName,
              description: productDescription,
            },
            unit_amount: Math.round(price * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${baseUrl}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/`,
      customer_email: userEmail,
      metadata: {
        userId: userId.toString(),
        quantity: quantity.toString(),
        creditType: creditType,
      },
    };


    const session = await stripe.checkout.sessions.create(sessionData);

    return session;
  } catch (error) {
    console.error('❌ ERRO ao criar sessão de checkout:');
    console.error('Tipo:', error.type);
    console.error('Mensagem:', error.message);
    console.error('Stack:', error.stack);
    console.error('Raw Error:', error.raw);
    throw error;
  }
}

async function verifySession(sessionId) {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return session;
  } catch (error) {
    console.error('Erro ao verificar sessão:', error);
    throw error;
  }
}

function isPaymentApproved(session) {
  return session.payment_status === 'paid';
}

function constructWebhookEvent(payload, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('⚠️ Webhook secret não configurado - pulando verificação de assinatura');
    return JSON.parse(payload);
  }

  try {
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (error) {
    console.error('Erro ao validar webhook:', error);
    throw error;
  }
}

module.exports = {
  createCheckoutSession,
  verifySession,
  isPaymentApproved,
  constructWebhookEvent,
  calculatePrice,
};
