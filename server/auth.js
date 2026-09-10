// Хэширование паролей на встроенном crypto.scrypt (без bcrypt/native modules).
const crypto = require('crypto');

const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, KEYLEN);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, KEYLEN);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (storedBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

// Middleware: требует активную сессию для всех API кроме /api/auth/*
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'not_authenticated' });
}

// Middleware для страниц (не-API): редиректит на login.html
function requirePageAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login.html');
}

module.exports = { hashPassword, verifyPassword, requireAuth, requirePageAuth };
