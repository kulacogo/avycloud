/**
 * Auth routes — public authentication endpoints.
 *
 * Mounted at /api/auth in index.js.
 * These routes do NOT require authentication (they are allowlisted
 * in the global auth middleware).
 */
const router = require('express').Router();
const { requestPasswordReset } = require('../services/public-auth');

router.post('/password-reset', async (req, res) => {
  try {
    const email = req.body?.email;
    await requestPasswordReset({ email, ip: req.ip });
    // Always return success (anti-enumeration). Rate-limit is still enforced via 429.
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Password reset failed' } });
  }
});

module.exports = router;
