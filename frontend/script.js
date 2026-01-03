const form = document.getElementById('whatsappForm');
const submitBtn = document.getElementById('submitBtn');
const responseMessage = document.getElementById('responseMessage');

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const phone = document.getElementById('phone').value.trim();
    const message = document.getElementById('message').value.trim();

    if (!phone || !message) {
        showMessage('Por favor, preencha todos os campos', 'error');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';
    responseMessage.style.display = 'none';

    try {
        const response = await fetch('/send-whatsapp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ phone, message })
        });

        const data = await response.json();

        if (data.success) {
            showMessage('Mensagem enviada com sucesso! ✓', 'success');
            form.reset();
        } else {
            showMessage(`Erro ao enviar: ${data.error || 'Erro desconhecido'}`, 'error');
        }
    } catch (error) {
        showMessage(`Erro de conexão: ${error.message}`, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Enviar Mensagem';
    }
});

function showMessage(text, type) {
    responseMessage.textContent = text;
    responseMessage.className = `message ${type}`;
    responseMessage.style.display = 'block';

    if (type === 'success') {
        setTimeout(() => {
            responseMessage.style.display = 'none';
        }, 5000);
    }
}
