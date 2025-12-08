const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-muito-segura-aqui-mude-em-producao';

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Token não fornecido' });
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
  }

  req.userId = decoded.userId;
  next();
}

module.exports = {
  generateToken,
  verifyToken,
  authMiddleware
};
