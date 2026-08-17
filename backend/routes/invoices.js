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
router.get('/invoices', requirePermission('invoices', 'read'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    let query = firestore.collection('invoices').where('tenantId', '==', tenantId);
    if (req.query.status) {
      query = query.where('status', '==', req.query.status);
    }
    query = query.orderBy('createdAt', 'desc').limit(parseInt(req.query.limit || '2000', 10));
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
router.post('/invoices', requirePermission('invoices', 'write'), async (req, res) => {
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
router.patch('/invoices/:id', requirePermission('invoices', 'write'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { status } = req.body;
    if (!status) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'status required' } });

    // Verify invoice belongs to tenant before updating
    const docRef = firestore.collection('invoices').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rechnung nicht gefunden' } });
    const docData = doc.data() || {};
    if (docData.tenantId && docData.tenantId !== tenantId) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Zugriff verweigert' } });
    }

    const update = { status, updatedAt: new Date().toISOString() };
    // BUG-073: Backfill tenantId on legacy invoices that lack it
    if (!docData.tenantId && tenantId) {
      update.tenantId = tenantId;
    }
    await docRef.update(update);
    res.json({ ok: true, data: { id: req.params.id, ...update } });
  } catch (err) {
    console.error(`[PATCH /api/invoices/:id] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/invoices/import-sevdesk
 * One-time (idempotent) import of all existing SevDesk invoices into Firestore.
 * Matches invoices to orders by gross amount (±€1 tolerance).
 */
router.post('/invoices/import-sevdesk', requirePermission('invoices', 'write'), async (req, res) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    const { importFromSevDesk } = require('../services/invoice-engine');
    const result = await importFromSevDesk({ tenantId });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/invoices/import-sevdesk] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/invoices/bulk-generate
 * Generate invoices for all shipped orders that don't have one yet.
 * Batches in groups of 5 to avoid hammering GCS/SevDesk.
 */
router.post('/invoices/bulk-generate', requirePermission('invoices', 'write'), async (req, res) => {
  try {
    // STANDARDMAESSIG AUS (Betreiber-Anweisung 2026-08-17, B2C): dieser
    // Endpunkt praegt in EINEM Aufruf eine Rechnung fuer JEDEN versendeten
    // Auftrag ohne Rechnung — genau der Mechanismus hinter den 467 faelligen
    // Rechnungen. Er haengt an keiner Schaltflaeche in der Oberflaeche.
    // Einzelne Rechnungen laufen ueber POST /api/orders/:orderId/invoice
    // (Knopf "Rechnung erstellen" im Auftrag), der bleibt immer erreichbar.
    const { autoInvoiceEnabled } = require('../lib/auto-invoice-gate');
    if (!autoInvoiceEnabled()) {
      return res.status(409).json({
        ok: false,
        error: {
          code: 'AUTO_INVOICE_DISABLED',
          message: 'Massen-Rechnungserstellung ist abgeschaltet (B2C). Einzelne Rechnungen über den Knopf „Rechnung erstellen" im Auftrag erzeugen.',
        },
      });
    }
    const tenantId = req.user?.tenantId || 'default';
    const { generateInvoice, exportToSevDesk } = require('../services/invoice-engine');

    // Query orders in terminal/shipped states that have no invoice yet
    const eligibleStatuses = ['shipped', 'delivered', 'completed'];
    let allOrders = [];
    for (const status of eligibleStatuses) {
      const snap = await firestore
        .collection('orders')
        .where('tenantId', '==', tenantId)
        .where('omsStatus', '==', status)
        .get();
      for (const doc of snap.docs) {
        const d = doc.data();
        if (!d.invoiceId) {
          allOrders.push({ id: doc.id, ...d });
        }
      }
    }

    // Remove duplicates (shouldn't happen, but safety)
    const seen = new Set();
    allOrders = allOrders.filter((o) => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    });

    const results = { generated: 0, skipped: 0, errors: [] };
    const actor = req.user ? { uid: req.user.uid, email: req.user.email } : null;
    const BATCH = 5;

    for (let i = 0; i < allOrders.length; i += BATCH) {
      const batch = allOrders.slice(i, i + BATCH);
      await Promise.all(batch.map(async (order) => {
        try {
          const inv = await generateInvoice({ orderId: order.id, tenantId, actor });
          results.generated++;
          // Fire-and-forget SevDesk export
          if (inv.invoiceId) {
            exportToSevDesk({ invoiceId: inv.invoiceId })
              .catch((err) => console.warn(`[bulk-generate] SevDesk export failed for ${order.id}: ${err.message}`));
          }
        } catch (err) {
          console.warn(`[bulk-generate] invoice failed for ${order.id}: ${err.message}`);
          results.errors.push({ orderId: order.id, error: err.message });
          results.skipped++;
        }
      }));
    }

    res.json({ ok: true, data: results });
  } catch (err) {
    console.error(`[POST /api/invoices/bulk-generate] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/invoices/:invoiceId/download — Download invoice PDF from GCS
 */
router.get('/invoices/:invoiceId/download', requirePermission('invoices', 'read'), async (req, res) => {
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
