const express = require('express');
const router = express.Router();
const { firestore } = require('../lib/firestore');
const { requirePermission } = require('../lib/rbac');
const { Storage } = require('@google-cloud/storage');

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

/**
 * GET /api/invoices/:invoiceId/download — Download invoice PDF from GCS
 */
router.get('/invoices/:invoiceId/download', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const invoiceId = String(req.params.invoiceId);
    const snap = await firestore.collection('invoices').doc(invoiceId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Invoice not found' } });
    }
    const invoice = snap.data();
    const pdfUrl = invoice.pdfUrl;
    if (!pdfUrl || !pdfUrl.startsWith('gs://')) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'No PDF available for this invoice' } });
    }
    // Parse gs:// URL: gs://bucket-name/path/to/file.pdf
    const gcsPath = pdfUrl.replace('gs://', '');
    const slashIdx = gcsPath.indexOf('/');
    const bucketName = gcsPath.substring(0, slashIdx);
    const filePath = gcsPath.substring(slashIdx + 1);

    const storage = new Storage();
    const [buffer] = await storage.bucket(bucketName).file(filePath).download();

    const fileName = invoice.invoiceNumber ? `Rechnung-${invoice.invoiceNumber}.pdf` : `invoice-${invoiceId}.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(buffer);
  } catch (err) {
    console.error(`[GET /api/invoices/${req.params.invoiceId}/download] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
