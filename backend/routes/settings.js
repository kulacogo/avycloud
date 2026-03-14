const express = require('express');
const router = express.Router();
const { firestore } = require('../lib/firestore');

// --- Helper: resolve tenantId from request (future MT-ready) ---
function getTenantId(req) {
  return req.user?.tenantId || 'default';
}

// ─── COMPANY SETTINGS ─────────────────────────────────────────

/**
 * GET /api/settings/company
 * Load company settings for the current tenant.
 */
router.get('/settings/company', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const doc = await firestore.collection('company_settings').doc(tenantId).get();
    const data = doc.exists ? doc.data() : {};
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[GET /api/settings/company] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * PUT /api/settings/company
 * Save/update company settings for the current tenant.
 */
router.put('/settings/company', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const allowedFields = [
      'firmenname', 'rechtsform', 'ustIdNr', 'steuernummer',
      'strasse', 'plz', 'ort', 'land',
      'email', 'telefon', 'website',
      'iban', 'bic', 'bank',
    ];
    const data = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        data[key] = req.body[key];
      }
    }
    data.tenantId = tenantId;
    data.updatedAt = new Date().toISOString();
    data.updatedBy = req.user?.uid || null;

    await firestore.collection('company_settings').doc(tenantId).set(data, { merge: true });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[PUT /api/settings/company] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ─── PROFILE SETTINGS ─────────────────────────────────────────

/**
 * GET /api/settings/profile
 * Load profile settings for the authenticated user.
 */
router.get('/settings/profile', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }
    const tenantId = getTenantId(req);
    const doc = await firestore.collection('user_profiles').doc(uid).get();
    const data = doc.exists ? doc.data() : {};
    // Include auth info
    data.email = req.user?.email || data.email || null;
    data.displayName = req.user?.name || data.displayName || null;
    data.tenantId = tenantId;
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[GET /api/settings/profile] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * PUT /api/settings/profile
 * Update profile settings for the authenticated user.
 */
router.put('/settings/profile', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }
    const tenantId = getTenantId(req);
    const allowedFields = ['vorname', 'nachname', 'notifications', 'theme', 'printing'];
    const data = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        data[key] = req.body[key];
      }
    }
    data.tenantId = tenantId;
    data.updatedAt = new Date().toISOString();

    await firestore.collection('user_profiles').doc(uid).set(data, { merge: true });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[PUT /api/settings/profile] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ─── API KEYS ────────────────────────────────────────────────

const crypto = require('crypto');

router.get('/settings/api-keys', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const snap = await firestore.collection('api_keys')
      .where('tenantId', '==', tenantId)
      .orderBy('createdAt', 'desc')
      .get();
    const keys = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: keys });
  } catch (err) {
    console.error(`[GET /api/settings/api-keys] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.post('/settings/api-keys', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const name = req.body.name || 'Unnamed Key';
    const key = `avyc_${crypto.randomBytes(24).toString('hex')}`;
    const data = {
      tenantId,
      name,
      key,
      createdAt: new Date().toISOString(),
      createdBy: req.user?.uid || null,
      lastAccess: null,
    };
    const ref = await firestore.collection('api_keys').add(data);
    res.json({ ok: true, data: { id: ref.id, ...data } });
  } catch (err) {
    console.error(`[POST /api/settings/api-keys] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.delete('/settings/api-keys/:id', async (req, res) => {
  try {
    await firestore.collection('api_keys').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error(`[DELETE /api/settings/api-keys] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ─── WEBHOOKS ────────────────────────────────────────────────

router.get('/settings/webhooks', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const snap = await firestore.collection('webhooks')
      .where('tenantId', '==', tenantId)
      .get();
    const hooks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: hooks });
  } catch (err) {
    console.error(`[GET /api/settings/webhooks] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.post('/settings/webhooks', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { url, events, active } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'URL required' } });
    const secret = crypto.randomBytes(32).toString('hex');
    const data = {
      tenantId,
      url,
      events: events || [],
      active: active !== false,
      secret,
      createdAt: new Date().toISOString(),
      createdBy: req.user?.uid || null,
    };
    const ref = await firestore.collection('webhooks').add(data);
    res.json({ ok: true, data: { id: ref.id, ...data } });
  } catch (err) {
    console.error(`[POST /api/settings/webhooks] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.delete('/settings/webhooks/:id', async (req, res) => {
  try {
    await firestore.collection('webhooks').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error(`[DELETE /api/settings/webhooks] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ─── BILLING USAGE ───────────────────────────────────────────

router.get('/settings/billing/usage', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    // Count products
    const productsSnap = await firestore.collection('products_v2').count().get();
    const productCount = productsSnap.data().count || 0;
    // Count integrations (from integrations status — simplified count)
    const integrationCount = 5; // eBay, Kaufland, SendCloud, SevDesk, DHL — all active
    // Count orders this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    // Simple order count — may be approximate
    const ordersSnap = await firestore.collection('orders')
      .where('createdAt', '>=', monthStart)
      .count()
      .get();
    const orderCount = ordersSnap.data().count || 0;

    res.json({
      ok: true,
      data: {
        tenantId,
        products: { current: productCount, max: 5000 },
        orders: { current: orderCount, max: 2000 },
        integrations: { current: integrationCount, max: 10 },
      },
    });
  } catch (err) {
    console.error(`[GET /api/settings/billing/usage] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
