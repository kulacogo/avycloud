const express = require('express');
const router = express.Router();
const { firestore } = require('../lib/firestore');
const { requirePermission } = require('../lib/rbac');

// --- Helper: resolve tenantId from request (future MT-ready) ---
function getTenantId(req) {
  return req.user?.tenantId || 'default';
}

/**
 * HARDEN-Wave-6 (2026-05-22): tenant-scoped delete guard.
 * Vorher: `DELETE /api/settings/api-keys/:id` und `…/webhooks/:id` löschten
 * das Doc by-ID, ohne zu prüfen ob es dem aufrufenden Tenant gehört. Klassische
 * IDOR-Schwäche. Jetzt: load doc → assert tenantId match → delete.
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function safeDeleteTenantScoped({ collection, docId, tenantId }) {
  const ref = firestore.collection(collection).doc(String(docId || ''));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: 'not_found' };
  }
  const data = snap.data() || {};
  const docTenant = String(data.tenantId || '').trim();
  if (!docTenant) {
    // Legacy docs without tenantId: only allow delete if requester is admin
    // (defense-in-depth — kein Tenant-Match möglich, also restrictive).
    return { ok: false, status: 403, error: 'forbidden_legacy_doc_no_tenant' };
  }
  if (docTenant !== tenantId) {
    return { ok: false, status: 403, error: 'forbidden_tenant_mismatch' };
  }
  await ref.delete();
  return { ok: true };
}

// ─── COMPANY SETTINGS ─────────────────────────────────────────

/**
 * GET /api/settings/company
 * Load company settings for the current tenant.
 */
router.get('/settings/company', requirePermission('settings', 'company.read'), async (req, res) => {
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
router.put('/settings/company', requirePermission('settings', 'company.write'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const allowedFields = [
      'firmenname', 'rechtsform', 'ustIdNr', 'steuernummer',
      'strasse', 'plz', 'ort', 'land',
      'email', 'telefon', 'website',
      'iban', 'bic', 'bank', 'inhaber', 'logoUrl',
      // GmbH-Pflichtangaben (§35a GmbHG)
      'handelsregister', 'amtsgericht', 'geschaeftsfuehrer',
    ];
    const data = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        data[key] = req.body[key];
      }
    }

    // Logo upload: a base64 data URL → upload to tenant-scoped GCS path and
    // store the resulting public URL in logoUrl. (Previously the frontend never
    // persisted the picked logo, so company_settings.logoUrl stayed empty and
    // invoices showed only the text fallback.)
    if (req.body.logoBase64) {
      const { uploadLogoImage } = require('../lib/storage');
      const up = await uploadLogoImage(req.body.logoBase64, tenantId);
      data.logoUrl = up.url;
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

router.get('/settings/api-keys', requirePermission('settings', 'read'), async (req, res) => {
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

router.post('/settings/api-keys', requirePermission('settings', 'write'), async (req, res) => {
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

router.delete('/settings/api-keys/:id', requirePermission('settings', 'delete'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const result = await safeDeleteTenantScoped({
      collection: 'api_keys',
      docId: req.params.id,
      tenantId,
    });
    if (!result.ok) {
      return res.status(result.status || 500).json({ ok: false, error: { code: result.error?.toUpperCase() || 'INTERNAL', message: result.error || 'failed' } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(`[DELETE /api/settings/api-keys] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ─── WEBHOOKS ────────────────────────────────────────────────

router.get('/settings/webhooks', requirePermission('settings', 'read'), async (req, res) => {
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

router.post('/settings/webhooks', requirePermission('settings', 'write'), async (req, res) => {
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

router.delete('/settings/webhooks/:id', requirePermission('settings', 'delete'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const result = await safeDeleteTenantScoped({
      collection: 'webhooks',
      docId: req.params.id,
      tenantId,
    });
    if (!result.ok) {
      return res.status(result.status || 500).json({ ok: false, error: { code: result.error?.toUpperCase() || 'INTERNAL', message: result.error || 'failed' } });
    }
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
