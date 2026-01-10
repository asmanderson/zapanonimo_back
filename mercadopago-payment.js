require('dotenv').config();

const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

const accessToken = process.env.MP_ACCESS_TOKEN;

if (!accessToken) {
  throw new Error('MP_ACCESS_TOKEN não configurada');
}

const client = new MercadoPagoConfig({
  accessToken: accessToken,
  options: { timeout: 5000 }
});

const payment = new Payment(client);
const preference = new Preference(client);

// Calcula preco (R$ 1,00 por mensagem, sem desconto - promocao dobra na entrega)
function calculatePrice(quantity) {
  return quantity * 1.00;
}

// Criar pagamento PIX
async function createPixPayment(userId, quantity, userEmail) {
  const price = calculatePrice(quantity);
  const description = `${quantity} Crédito(s) WhatsApp - Zap Anônimo`;

  const paymentData = {
    transaction_amount: price,
    description: description,
    payment_method_id: 'pix',
    payer: {
      email: userEmail || 'cliente@zapanonimo.com'
    },
    metadata: {
      user_id: userId.toString(),
      quantity: quantity.toString(),
      credit_type: 'whatsapp'
    }
  };

  try {
    const result = await payment.create({ body: paymentData });

    return {
      success: true,
      paymentId: result.id,
      status: result.status,
      qrCode: result.point_of_interaction?.transaction_data?.qr_code,
      qrCodeBase64: result.point_of_interaction?.transaction_data?.qr_code_base64,
      ticketUrl: result.point_of_interaction?.transaction_data?.ticket_url,
      expirationDate: result.date_of_expiration
    };
  } catch (error) {
    console.error('[MercadoPago] Erro ao criar PIX:', error);
    throw new Error('Erro ao gerar PIX: ' + (error.message || 'Erro desconhecido'));
  }
}

// Criar preferencia para checkout (cartao de credito/debito)
async function createCardPreference(userId, quantity, userEmail) {
  const price = calculatePrice(quantity);
  const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://zapanonimo.com';

  const preferenceData = {
    items: [
      {
        id: `credits_${quantity}`,
        title: `${quantity} Crédito(s) WhatsApp`,
        description: `Compra de ${quantity} crédito(s) para envio no WhatsApp`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: price
      }
    ],
    payer: {
      email: userEmail || undefined
    },
    back_urls: {
      success: `${baseUrl}/payment-success.html`,
      failure: `${baseUrl}/`,
      pending: `${baseUrl}/payment-pending.html`
    },
    auto_return: 'approved',
    external_reference: JSON.stringify({
      userId: userId.toString(),
      quantity: quantity.toString(),
      creditType: 'whatsapp'
    }),
    notification_url: `${baseUrl}/api/mercadopago/webhook`,
    statement_descriptor: 'ZAPANONIMO',
    payment_methods: {
      excluded_payment_types: [
        { id: 'ticket' } // Exclui boleto (demora muito)
      ],
      installments: 12
    }
  };

  try {
    const result = await preference.create({ body: preferenceData });

    return {
      success: true,
      preferenceId: result.id,
      initPoint: result.init_point, // URL para redirecionar (producao)
      sandboxInitPoint: result.sandbox_init_point // URL para teste
    };
  } catch (error) {
    console.error('[MercadoPago] Erro ao criar preferencia:', error);
    throw new Error('Erro ao criar pagamento: ' + (error.message || 'Erro desconhecido'));
  }
}

// Verificar status do pagamento
async function getPaymentStatus(paymentId) {
  try {
    const result = await payment.get({ id: paymentId });

    return {
      success: true,
      id: result.id,
      status: result.status,
      statusDetail: result.status_detail,
      metadata: result.metadata,
      externalReference: result.external_reference
    };
  } catch (error) {
    console.error('[MercadoPago] Erro ao verificar pagamento:', error);
    throw new Error('Erro ao verificar pagamento');
  }
}

// Processar webhook do Mercado Pago
function parseWebhookData(body) {
  // Webhook pode vir em diferentes formatos
  if (body.type === 'payment' && body.data?.id) {
    return {
      type: 'payment',
      paymentId: body.data.id
    };
  }

  if (body.action === 'payment.created' || body.action === 'payment.updated') {
    return {
      type: 'payment',
      paymentId: body.data?.id
    };
  }

  return null;
}

// Verificar se pagamento foi aprovado
function isPaymentApproved(status) {
  return status === 'approved';
}

// Verificar se pagamento esta pendente (PIX aguardando)
function isPaymentPending(status) {
  return status === 'pending' || status === 'in_process';
}

module.exports = {
  createPixPayment,
  createCardPreference,
  getPaymentStatus,
  parseWebhookData,
  isPaymentApproved,
  isPaymentPending,
  calculatePrice
};
