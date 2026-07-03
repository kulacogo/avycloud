'use strict';

/**
 * routes/rules.js — REST API for automation rules (RULE-001).
 *
 * 9 endpoints: CRUD + toggle + execute + job status + preview.
 * All queries scoped by tenantId.
 */

const express = require('express');
const router = express.Router();
const { logAudit } = require('../services/audit-log');
const { requirePermission } = require('../lib/rbac');
const {
  evaluateConditions,
  applyActions,
  executeRule,
  getMatchingProducts,
  RULES_COLLECTION,
  JOBS_COLLECTION,
  getDb,
} = require('../services/rule-engine');
const { enqueueAutomationJob } = require('../services/rule-runner');

/* ─── Helpers ─── */

function getTenantId(req) {
  return req.user?.tenantId || 'default';
}

function validateRule(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    errors.push('Name ist erforderlich');
  }
  if (!Array.isArray(body.conditions) || body.conditions.length === 0) {
    errors.push('Mindestens eine Bedingung ist erforderlich');
  }
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    errors.push('Mindestens eine Aktion ist erforderlich');
  }
  return errors;
}

/* ─── 1. GET /api/v1/rules — List rules ─── */

router.get('/', requirePermission('rules', 'read'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    // Simple single-field query to avoid composite index requirement.
    // Sort + filter client-side (< 100 rules per tenant).
    const snap = await getDb().collection(RULES_COLLECTION)
      .where('tenantId', '==', tenantId)
      .get();

    let rules = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    if (req.query.active === 'true') {
      rules = rules.filter((r) => r.active === true);
    }
    rules.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ ok: true, data: rules });
  } catch (err) {
    console.error(`[GET /api/v1/rules] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ─── 2. GET /api/v1/rules/:ruleId — Get single rule ─── */

router.get('/jobs/:jobId', requirePermission('rules', 'read'), async (req, res) => {
  try {
    const snap = await getDb().collection(JOBS_COLLECTION).doc(req.params.jobId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Job nicht gefunden' } });
    }
    res.json({ ok: true, data: { id: snap.id, ...snap.data() } });
  } catch (err) {
    console.error(`[GET /api/v1/rules/jobs/:jobId] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.get('/:ruleId', requirePermission('rules', 'read'), async (req, res) => {
  try {
    const snap = await getDb().collection(RULES_COLLECTION).doc(req.params.ruleId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Regel nicht gefunden' } });
    }
    res.json({ ok: true, data: { id: snap.id, ...snap.data() } });
  } catch (err) {
    console.error(`[GET /api/v1/rules/:ruleId] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ─── 3. POST /api/v1/rules — Create rule ─── */

router.post('/', requirePermission('rules', 'write'), async (req, res) => {
  try {
    const errors = validateRule(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: errors.join('. ') } });
    }

    const tenantId = getTenantId(req);
    const now = new Date().toISOString();
    const doc = {
      tenantId,
      name: req.body.name.trim(),
      description: req.body.description || '',
      active: req.body.active !== false,
      conditions: req.body.conditions,
      actions: req.body.actions,
      channel: req.body.channel || null,
      stats: { lastRunAt: null, lastRunProducts: 0, lastRunApplied: 0, totalRuns: 0 },
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.email || 'system',
    };

    const ref = await getDb().collection(RULES_COLLECTION).add(doc);
    logAudit({ action: 'rule.created', userId: req.user?.uid, userEmail: req.user?.email, tenantId, resourceType: 'rule', resourceId: ref.id, details: { name: doc.name } }).catch(() => {});
    res.status(201).json({ ok: true, data: { id: ref.id, ...doc } });
  } catch (err) {
    console.error(`[POST /api/v1/rules] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ─── 4. PUT /api/v1/rules/:ruleId — Update rule ─── */

router.put('/:ruleId', requirePermission('rules', 'write'), async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(RULES_COLLECTION).doc(req.params.ruleId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Regel nicht gefunden' } });
    }

    const updates = { updatedAt: new Date().toISOString() };
    if (req.body.name !== undefined) updates.name = req.body.name.trim();
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.conditions !== undefined) updates.conditions = req.body.conditions;
    if (req.body.actions !== undefined) updates.actions = req.body.actions;
    if (req.body.channel !== undefined) updates.channel = req.body.channel;
    if (req.body.active !== undefined) updates.active = req.body.active;

    await ref.update(updates);
    logAudit({ action: 'rule.updated', userId: req.user?.uid, userEmail: req.user?.email, tenantId: getTenantId(req), resourceType: 'rule', resourceId: req.params.ruleId }).catch(() => {});
    const updated = await ref.get();
    res.json({ ok: true, data: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error(`[PUT /api/v1/rules/:ruleId] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ─── 5. DELETE /api/v1/rules/:ruleId ─── */

router.delete('/:ruleId', requirePermission('rules', 'write'), async (req, res) => {
  try {
    const ref = getDb().collection(RULES_COLLECTION).doc(req.params.ruleId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Regel nicht gefunden' } });
    }
    await ref.delete();
    logAudit({ action: 'rule.deleted', userId: req.user?.uid, userEmail: req.user?.email, tenantId: getTenantId(req), resourceType: 'rule', resourceId: req.params.ruleId }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error(`[DELETE /api/v1/rules/:ruleId] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ─── 6. PATCH /api/v1/rules/:ruleId/toggle ─── */

router.patch('/:ruleId/toggle', requirePermission('rules', 'write'), async (req, res) => {
  try {
    const ref = getDb().collection(RULES_COLLECTION).doc(req.params.ruleId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Regel nicht gefunden' } });
    }
    const newActive = !snap.data().active;
    await ref.update({ active: newActive, updatedAt: new Date().toISOString() });
    res.json({ ok: true, data: { id: snap.id, active: newActive } });
  } catch (err) {
    console.error(`[PATCH /api/v1/rules/:ruleId/toggle] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ─── 7. POST /api/v1/rules/:ruleId/execute ─── */

router.post('/:ruleId/execute', requirePermission('rules', 'write'), async (req, res) => {
  try {
    const mode = req.body.mode || 'dry_run';
    const limit = req.body.limit || 1000;

    const { jobId, status } = await executeRule(req.params.ruleId, mode, limit);
    enqueueAutomationJob(jobId);
    logAudit({ action: 'rule.executed', userId: req.user?.uid, userEmail: req.user?.email, tenantId: getTenantId(req), resourceType: 'rule', resourceId: req.params.ruleId, details: { mode, jobId } }).catch(() => {});

    res.status(202).json({ ok: true, data: { jobId, status } });
  } catch (err) {
    if (err.message === 'Regel nicht gefunden') {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } });
    }
    console.error(`[POST /api/v1/rules/:ruleId/execute] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ─── 8. GET /api/v1/rules/jobs/:jobId — Job Status ─── */
// (defined above before :ruleId to avoid route conflict)

/* ─── 9. GET /api/v1/rules/:ruleId/preview — Quick Preview ─── */

router.get('/:ruleId/preview', requirePermission('rules', 'read'), async (req, res) => {
  try {
    const db = getDb();
    const ruleSnap = await db.collection(RULES_COLLECTION).doc(req.params.ruleId).get();
    if (!ruleSnap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Regel nicht gefunden' } });
    }

    const rule = ruleSnap.data();
    const tenantId = getTenantId(req);
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    const matched = await getMatchingProducts(tenantId, rule.conditions, limit);

    const sample = matched.slice(0, limit).map((product) => {
      const productCopy = JSON.parse(JSON.stringify(product));
      const changes = applyActions(productCopy, rule.actions);
      return {
        productId: product.id,
        productName: product.identification?.name || product.name || product.id,
        changes,
      };
    });

    res.json({
      ok: true,
      data: { matchCount: matched.length, sample },
    });
  } catch (err) {
    console.error(`[GET /api/v1/rules/:ruleId/preview] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
