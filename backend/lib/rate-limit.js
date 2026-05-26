const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Key by authenticated user when available, else by client IP.
// IPv6 must go through ipKeyGenerator (masks to a /56 block) — passing raw req.ip
// throws ERR_ERL_KEY_GEN_IPV6 in express-rate-limit v8, which collapsed every
// client into one bucket and 429'd the whole app (Incident 2026-05-25).
// req.ip is only the real client IP because index.js sets `trust proxy` (Cloud Run).
const rateLimitKey = (req) => req.user?.uid || ipKeyGenerator(req.ip, 56);

// CORS preflight is browser-automatic and carries no auth; a rate-limited OPTIONS
// aborts the real request and makes the SPA appear dead. Never count it.
const skipPreflight = (req) => req.method === 'OPTIONS';

// trust proxy is permissive on Cloud Run (variable hop count); we accept that for
// this authenticated internal tool, so silence the express-rate-limit warning.
const sharedValidate = { trustProxy: false };

const identifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 30, // Max 30 Requests pro User
  keyGenerator: rateLimitKey,
  skip: skipPreflight,
  validate: sharedValidate,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in 15 minutes.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  keyGenerator: rateLimitKey,
  skip: skipPreflight,
  validate: sharedValidate,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { identifyLimiter, generalLimiter, rateLimitKey, skipPreflight };
