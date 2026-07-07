const express = require('express');
const router = express.Router();
const { firestore } = require('../lib/firestore');
const { emitSyncEvent } = require('../services/sync-event-bus');
const { requirePermission } = require('../lib/rbac');

function getTenantId(req) {
  return req.user?.tenantId || 'default';
}

function getActor(req) {
  return { uid: req.user?.uid || 'system', email: req.user?.email || 'api' };
}

/**
 * GET /api/returns
 * List returns for the current tenant.
 */
router.get('/returns', requirePermission('returns', 'read'), async (req, res) => {
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
 * GET /api/returns/reasons
 * List available return reason categories.
 */
router.get('/returns/reasons', requirePermission('returns', 'read'), (req, res) => {
  const { RETURN_REASONS } = require('../services/returns-engine');
  const reasons = Object.entries(RETURN_REASONS).map(([key, val]) => ({
    key,
    label: val.label,
    refundDefault: val.refundDefault,
  }));
  res.json({ ok: true, data: reasons });
});

/**
 * POST /api/returns
 * Create a new return manually.
 */
router.post('/returns', requirePermission('returns', 'process'), async (req, res) => {
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
      status: 'eingegangen',
      createdAt: new Date().toISOString(),
      createdBy: req.user?.uid || null,
    };
    const ref = await firestore.collection('returns').add(data);

    // Event-driven sync: new return → sync with marketplaces
    emitSyncEvent('return:created', {
      entityId: ref.id, tenantId, source: 'api:manual-return',
    });

    res.json({ ok: true, data: { id: ref.id, ...data } });
  } catch (err) {
    console.error(`[POST /api/returns] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/returns/sync — Sync returns from all marketplaces.
 * MUST be before /:id routes to avoid Express matching "sync" as :id.
 */
router.post('/returns/sync', requirePermission('returns', 'process'), async (req, res) => {
  try {
    const { syncAllReturns } = require('../services/returns-engine');
    const result = await syncAllReturns({
      tenantId: getTenantId(req),
      lookbackDays: parseInt(req.query.days || '30', 10),
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/returns/sync] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/returns/bulk-action
 * Body: { returnIds: string[], action: 'refund' | 'close', note?: string }
 * Response: { ok: true, data: { total, success, results: [{returnId, ok, error?}] } }
 */
router.post('/returns/bulk-action', requirePermission('returns', 'process'), async (req, res) => {
  try {
    const { returnIds, action, note } = req.body;

    if (!Array.isArray(returnIds) || returnIds.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'returnIds must be a non-empty array' } });
    }
    if (returnIds.length > 50) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Max 50 returns per bulk action' } });
    }
    if (!['refund', 'close'].includes(action)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'action must be "refund" or "close"' } });
    }

    const tenantId = getTenantId(req);
    const actor = getActor(req);
    const { issueMarketplaceRefund, transitionReturn } = require('../services/returns-engine');

    const results = [];
    for (const returnId of returnIds) {
      try {
        if (action === 'refund') {
          // BUGFIX (2026-07): issueMarketplaceRefund WIRFT NICHT bei API-Fehler —
          // es liefert { ok:false, error } (vgl. Einzel-Route unten mit
          // `if (!result.ok) return res.status(400)`). Ein fehlgeschlagener Refund
          // darf NICHT als { ok:true } gemeldet werden, sonst hält der Operator
          // die Erstattung für erledigt.
          const refundResult = await issueMarketplaceRefund({ returnId, tenantId, actor });
          if (!refundResult || refundResult.ok !== true) {
            results.push({ returnId, ok: false, error: (refundResult && refundResult.error) || 'Refund failed' });
            continue;
          }
        } else {
          await transitionReturn({ returnId, toStatus: 'abgeschlossen', actor, note: note || 'Bulk-Aktion: Retoure abgeschlossen' });
        }
        results.push({ returnId, ok: true });
        emitSyncEvent('return:status_changed', { entityId: returnId, tenantId });
      } catch (err) {
        results.push({ returnId, ok: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.ok).length;
    res.json({ ok: true, data: { total: returnIds.length, success: successCount, results } });
  } catch (err) {
    console.error(`[POST /api/returns/bulk-action] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * PATCH /api/returns/:id
 * Update return fields (reason, notes, etc.)
 */
router.patch('/returns/:id', requirePermission('returns', 'process'), async (req, res) => {
  try {
    const { status, refundAmount, reason, note } = req.body;
    const update = { updatedAt: new Date().toISOString() };
    if (reason) update.reason = reason;
    if (note) update.note = note;
    if (refundAmount !== undefined) update.refundAmount = refundAmount;

    // Use workflow engine for status transitions
    if (status) {
      const { transitionReturn } = require('../services/returns-engine');
      // refundAmount/reason MIT durchreichen: vorher wurden im selben Request
      // mitgeschickte Feld-Änderungen still verworfen (early return unten),
      // z. B. korrigierter Erstattungsbetrag + Statuswechsel in einem Save.
      const result = await transitionReturn({
        returnId: req.params.id,
        toStatus: status,
        actor: getActor(req),
        note: note || '',
        ...(refundAmount !== undefined ? { refundAmount } : {}),
      });

      // Übrige Feld-Änderungen (reason), die transitionReturn nicht kennt,
      // zusätzlich persistieren statt verwerfen.
      if (reason) {
        await firestore.collection('returns').doc(req.params.id).update({
          reason,
          updatedAt: new Date().toISOString(),
        });
      }

      // Event-driven sync: return status changed → stock + marketplace sync
      emitSyncEvent('return:status_changed', {
        entityId: req.params.id, tenantId: getTenantId(req),
        toStatus: status, source: 'api:return-transition',
      });

      return res.json({ ok: true, data: { ...result, ...(reason ? { reason } : {}) } });
    }

    await firestore.collection('returns').doc(req.params.id).update(update);
    res.json({ ok: true, data: { id: req.params.id, ...update } });
  } catch (err) {
    console.error(`[PATCH /api/returns/:id] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/returns/:id/process — Inspect item and decide refund.
 * Body: { itemCondition: 'a_ware'|'b_ware'|'c_ware', refundType: 'full'|'partial'|'none', refundAmount?, note? }
 */
router.post('/returns/:id/process', requirePermission('returns', 'process'), async (req, res) => {
  try {
    const { itemCondition, refundType, refundAmount, note } = req.body;
    if (!itemCondition) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'itemCondition required' } });
    if (!refundType) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'refundType required' } });

    const { processReturn } = require('../services/returns-engine');
    const result = await processReturn({
      returnId: req.params.id,
      tenantId: getTenantId(req),
      itemCondition,
      refundType,
      refundAmount,
      note,
      actor: getActor(req),
    });

    // Event-driven sync: return processed → stock restock + marketplace sync
    emitSyncEvent('return:status_changed', {
      entityId: req.params.id, tenantId: getTenantId(req),
      toStatus: result.status, source: 'api:return-process',
    });

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/returns/:id/process] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/returns/:id/refund — Issue refund via marketplace API.
 */
router.post('/returns/:id/refund', requirePermission('returns', 'refund'), async (req, res) => {
  try {
    const { issueMarketplaceRefund } = require('../services/returns-engine');
    const result = await issueMarketplaceRefund({
      returnId: req.params.id,
      tenantId: getTenantId(req),
      actor: getActor(req),
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: { code: 'REFUND_FAILED', message: result.error } });
    }

    // Event-driven sync: refund issued → sync with marketplace
    emitSyncEvent('return:status_changed', {
      entityId: req.params.id, tenantId: getTenantId(req),
      toStatus: 'refunded', source: 'api:refund',
    });

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/returns/:id/refund] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/returns/:id/close — Close a return (terminal state).
 */
router.post('/returns/:id/close', requirePermission('returns', 'process'), async (req, res) => {
  try {
    const { transitionReturn } = require('../services/returns-engine');
    const result = await transitionReturn({
      returnId: req.params.id,
      toStatus: 'abgeschlossen',
      actor: getActor(req),
      note: req.body.note || 'Retoure abgeschlossen',
    });

    // Event-driven sync
    emitSyncEvent('return:status_changed', {
      entityId: req.params.id, tenantId: getTenantId(req),
      toStatus: 'abgeschlossen', source: 'api:return-close',
    });

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/returns/:id/close] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/returns/:id/events — Get return event history.
 */
router.get('/returns/:id/events', requirePermission('returns', 'read'), async (req, res) => {
  try {
    const snap = await firestore.collection('return_events')
      .where('returnId', '==', req.params.id)
      .orderBy('timestamp', 'asc')
      .get();
    const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: events });
  } catch (err) {
    console.error(`[GET /api/returns/:id/events] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
