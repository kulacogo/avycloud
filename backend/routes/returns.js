const express = require('express');
const router = express.Router();
const { firestore } = require('../lib/firestore');

function getTenantId(req) {
  return req.user?.tenantId || 'default';
}

/**
 * GET /api/returns
 * List returns for the current tenant.
 */
router.get('/returns', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    let query = firestore.collection('returns').where('tenantId', '==', tenantId);
    if (req.query.status) {
      query = query.where('status', '==', req.query.status);
    }
    query = query.orderBy('createdAt', 'desc').limit(parseInt(req.query.limit || '100', 10));
    const snap = await query.get();
    const returns = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: returns });
  } catch (err) {
    console.error(`[GET /api/returns] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/returns
 * Create a new return.
 */
router.post('/returns', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { orderId, customer, product, reason, refundAmount } = req.body;
    if (!orderId) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'orderId required' } });
    const data = {
      tenantId,
      orderId,
      customer: customer || null,
      product: product || null,
      reason: reason || 'meinungsaenderung',
      refundAmount: refundAmount || 0,
      status: 'neu',
      createdAt: new Date().toISOString(),
      createdBy: req.user?.uid || null,
    };
    const ref = await firestore.collection('returns').add(data);
    res.json({ ok: true, data: { id: ref.id, ...data } });
  } catch (err) {
    console.error(`[POST /api/returns] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * PATCH /api/returns/:id
 * Update return status (erstatten, ablehnen, etc.)
 */
router.patch('/returns/:id', async (req, res) => {
  try {
    const { status, refundAmount } = req.body;
    const update = { updatedAt: new Date().toISOString() };
    if (status) update.status = status;
    if (refundAmount !== undefined) update.refundAmount = refundAmount;
    await firestore.collection('returns').doc(req.params.id).update(update);
    res.json({ ok: true, data: { id: req.params.id, ...update } });
  } catch (err) {
    console.error(`[PATCH /api/returns/:id] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
