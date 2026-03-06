const express = require('express');
const router = express.Router();
const { firestore } = require('../lib/firestore');

function getTenantId(req) {
  return req.user?.tenantId || 'default';
}

/**
 * GET /api/invoices
 * List invoices for the current tenant.
 */
router.get('/invoices', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    let query = firestore.collection('invoices').where('tenantId', '==', tenantId);
    if (req.query.status) {
      query = query.where('status', '==', req.query.status);
    }
    query = query.orderBy('createdAt', 'desc').limit(parseInt(req.query.limit || '100', 10));
    const snap = await query.get();
    const invoices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: invoices });
  } catch (err) {
    console.error(`[GET /api/invoices] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/invoices
 * Create an invoice from an order.
 */
router.post('/invoices', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { orderId, customer, invoiceNumber, amountNet, amountGross, dueDate } = req.body;
    if (!orderId) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'orderId required' } });
    const data = {
      tenantId,
      orderId,
      customer: customer || null,
      invoiceNumber: invoiceNumber || `RE-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`,
      amountNet: amountNet || 0,
      amountGross: amountGross || 0,
      status: 'entwurf',
      date: new Date().toISOString().split('T')[0],
      dueDate: dueDate || null,
      createdAt: new Date().toISOString(),
      createdBy: req.user?.uid || null,
    };
    const ref = await firestore.collection('invoices').add(data);
    res.json({ ok: true, data: { id: ref.id, ...data } });
  } catch (err) {
    console.error(`[POST /api/invoices] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * PATCH /api/invoices/:id
 * Update invoice status.
 */
router.patch('/invoices/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const update = { updatedAt: new Date().toISOString() };
    if (status) update.status = status;
    await firestore.collection('invoices').doc(req.params.id).update(update);
    res.json({ ok: true, data: { id: req.params.id, ...update } });
  } catch (err) {
    console.error(`[PATCH /api/invoices/:id] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
