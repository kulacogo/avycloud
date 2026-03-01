const rateLimit = require('express-rate-limit');

const identifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 30, // Max 30 Requests pro User
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in 15 minutes.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { identifyLimiter, generalLimiter };
