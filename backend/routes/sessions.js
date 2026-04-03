/**
 * Session tracking routes (authenticated users).
 *
 * POST /api/sessions          — create session on login
 * POST /api/sessions/:id/heartbeat — keep session alive
 * POST /api/sessions/:id/end  — end session on logout
 */

const { Router } = require('express');
const { requireAuth } = require('../lib/auth');
const { createSession, heartbeat, endSession } = require('../services/user-sessions');

const router = Router();

// All session routes require authentication.
router.use(requireAuth);

// --- Create Session ---
router.post('/', async (req, res) => {
  try {
    const { clientInfo } = req.body || {};
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
    const userAgent = req.headers['user-agent'] || '';
    const authProvider = req.user?.claims?.firebase?.sign_in_provider || 'unknown';

    const sessionId = await createSession({
      userId: req.user.uid,
      userEmail: req.user.email,
      tenantId: 'default',
      ip,
      userAgent,
      authProvider,
      clientInfo: clientInfo || {},
    });

    res.json({ ok: true, sessionId });
  } catch (err) {
    console.error(`[POST /api/sessions] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// --- Heartbeat ---
router.post('/:id/heartbeat', async (req, res) => {
  try {
    await heartbeat({
      sessionId: req.params.id,
      tenantId: 'default',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[POST /api/sessions/:id/heartbeat] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// --- End Session ---
router.post('/:id/end', async (req, res) => {
  try {
    await endSession({
      sessionId: req.params.id,
      tenantId: 'default',
      userId: req.user.uid,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[POST /api/sessions/:id/end] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
