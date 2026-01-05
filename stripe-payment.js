require('dotenv').config();

const stripeKey = process.env.STRIPE_SECRET_KEY;

if (!stripeKey) {
  throw new Error('STRIPE_SECRET_KEY não configurada');
}

const stripe = require('stripe')(stripeKey);

function calculatePrice(quantity, creditType = 'whatsapp') {
  const pricePerCredit = 1.00;
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
  const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://zapanonimo.com';

  const productName = creditType === 'whatsapp'
    ? `${quantity} Crédito(s) WhatsApp`
    : `${quantity} Crédito(s) SMS`;

  const productDescription = creditType === 'whatsapp'
    ? `Compra de ${quantity} crédito(s) para envio no WhatsApp`
    : `Compra de ${quantity} crédito(s) para envio de SMS`;

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
}

async function verifySession(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  return session;
}

function isPaymentApproved(session) {
  return session.payment_status === 'paid';
}

function constructWebhookEvent(payload, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return JSON.parse(payload);
  }

  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}

module.exports = {
  createCheckoutSession,
  verifySession,
  isPaymentApproved,
  constructWebhookEvent,
  calculatePrice,
};
