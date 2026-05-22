/**
 * Stock-Failure-Drain — periodischer Retry von fehlgeschlagenen Marketplace-Syncs.
 *
 * Kontext: _onOrderShipped() in order-state-machine.js persistiert bei Phase-B-Failure
 * ein Dokument in `stock_operation_failures`. Ohne Drain bleibt diese Collection nur
 * "Write-Only" und erzeugt Oversell-Regressionen (Incident SKU-9871561937, 2026-04-23).
 *
 * Dieser Worker liest pro Tenant pending Failures und retried jede `step: 'marketplaceSync'`-
 * Position via syncStockWithRetry. Dabei wird die Channel-Logik (EndItem bei qty=0 eBay,
 * ONHOLD bei qty=0 Kaufland) vom bestehenden Dispatcher wiederverwendet — keine Duplikation.
 *
 * Sicherheits-Entscheidung: `step: 'decrement'` wird NICHT retried. Grund: ein erneutes
 * `decrementProductByIdOrSku` koennte bei partiellem Initial-Erfolg Items doppelt
 * dekrementieren. Solche Failures werden als `needs_manual` markiert und via Alerting
 * eskaliert (P4.3).
 *
 * Siehe CLAUDE.md Punkt 10 (Oversell-Verbot) und Plan P2.1.
 */

'use strict';

const MAX_ATTEMPTS = 5;

async function loadPendingFailureDocs({ firestore, tenantId, limit }) {
  try {
    return await firestore.collection('stock_operation_failures')
      .where('tenantId', '==', tenantId)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .limit(limit * 4)
      .get();
  } catch (err) {
    // Backward-compatible fallback for environments where the composite index
    // was not created yet.
    const msg = String(err?.message || '').toLowerCase();
    const isIndexIssue = msg.includes('index') || msg.includes('failed precondition');
    if (!isIndexIssue) throw err;
    console.warn('[stock-failure-drain] pending-index missing, falling back to tenant-only query');
    return firestore.collection('stock_operation_failures')
      .where('tenantId', '==', tenantId)
      .orderBy('createdAt', 'asc')
      .limit(limit * 4)
      .get();
  }
}

async function loadProductForFailure({ firestore, tenantId, failure }) {
  const sku = String(failure?.sku || '').trim();
  if (sku) {
    let productSnap = await firestore.collection('products_v2')
      .where('identification.sku', '==', sku)
      .where('tenantId', '==', tenantId)
      .limit(1)
      .get();
    if (productSnap.empty) {
      productSnap = await firestore.collection('products_v2')
        .where('details.identifiers.sku', '==', sku)
        .where('tenantId', '==', tenantId)
        .limit(1)
        .get();
    }
    if (!productSnap.empty) {
      const pDoc = productSnap.docs[0];
      return { product: { id: pDoc.id, ...pDoc.data() }, lookupError: null };
    }
  }

  const productId = String(failure?.productId || '').trim();
  if (!productId) {
    return { product: null, lookupError: sku ? 'product-not-found' : 'no-sku-and-no-productId' };
  }

  const productDoc = await firestore.collection('products_v2').doc(productId).get();
  if (!productDoc.exists) {
    return { product: null, lookupError: 'product-not-found' };
  }

  const productData = productDoc.data() || {};
  if (productData.tenantId && String(productData.tenantId) !== String(tenantId)) {
    return { product: null, lookupError: 'tenant-mismatch' };
  }
  return { product: { id: productDoc.id, ...productData }, lookupError: null };
}

async function drainStockFailures({ tenantId, limit = 50 } = {}) {
  if (process.env.STOCK_FAILURE_DRAIN_ENABLED === 'false') {
    return { skipped: true, reason: 'STOCK_FAILURE_DRAIN_ENABLED=false' };
  }
  if (!tenantId) {
    throw new Error('drainStockFailures: tenantId required');
  }

  const { firestore } = require('../lib/firestore');
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');

  // Prefer status-filtered query to avoid starvation by old resolved docs.
  // Falls back automatically if index is not ready yet.
  const snap = await loadPendingFailureDocs({ firestore, tenantId, limit });

  const results = { total: 0, resolved: 0, stillFailing: 0, abandoned: 0, skipped: 0, needsManual: 0 };

  for (const doc of snap.docs) {
    if (results.total >= limit) break;
    const data = doc.data() || {};
    if (data.status !== 'pending') continue;
    const attempts = Number(data.attempts || 0);
    if (attempts >= MAX_ATTEMPTS) continue;
    results.total += 1;

    const failuresArr = Array.isArray(data.failures) ? data.failures : [];
    const retryable = failuresArr.filter((f) => f && f.step === 'marketplaceSync');
    const manual = failuresArr.filter((f) => f && f.step === 'decrement');

    // Wenn nur decrement-Failures, als needs_manual markieren und nicht retryn.
    if (retryable.length === 0 && manual.length > 0) {
      await doc.ref.update({
        status: 'needs_manual',
        reason: 'decrement-failures-require-manual-intervention',
        updatedAt: new Date().toISOString(),
      });
      results.needsManual += 1;
      console.warn(`[stock-failure-drain] ${doc.id} needs_manual: ${manual.length} decrement failure(s)`);
      // HARDEN-Wave-2 (2026-05-22): Operator-Alert über best-effort Slack.
      await _emitTerminalAlert({
        tenantId,
        failureDocId: doc.id,
        terminalStatus: 'needs_manual',
        reason: `${manual.length} decrement failure(s) — manual intervention required`,
        failures: manual.slice(0, 3),
      });
      continue;
    }

    // Retry marketplaceSync failures once per affected product key.
    const dedupedRetryable = [];
    const seenRetryKeys = new Set();
    for (const failure of retryable) {
      const key = String(failure?.productId || failure?.sku || '').trim();
      const retryKey = key || `raw:${JSON.stringify(failure || {})}`;
      if (seenRetryKeys.has(retryKey)) continue;
      seenRetryKeys.add(retryKey);
      dedupedRetryable.push(failure);
    }

    const retryResults = [];
    let anyHardError = false;
    for (const f of dedupedRetryable) {
      try {
        const { product, lookupError } = await loadProductForFailure({ firestore, tenantId, failure: f });
        const sku = String(f?.sku || product?.identification?.sku || product?.details?.identifiers?.sku || '').trim() || null;
        if (!product) {
          retryResults.push({ sku, ok: false, error: lookupError || 'product-not-found' });
          anyHardError = true;
          continue;
        }
        const r = await syncStockWithRetry({
          tenantId,
          product,
          reason: `drain:${doc.id}`,
          skipPersistentFailureQueue: true,
        });
        const channelErrors = Array.isArray(r?.results)
          ? r.results.filter((c) => c && (c.status === 'error' || c.status === 'failed'))
          : [];
        if (channelErrors.length > 0) {
          retryResults.push({ sku, ok: false, error: `channels-failed:${channelErrors.map((c) => c.channel).join(',')}` });
          anyHardError = true;
        } else {
          retryResults.push({ sku, ok: true });
        }
      } catch (err) {
        retryResults.push({ sku: f?.sku || null, ok: false, error: err.message });
        anyHardError = true;
      }
    }

    const nextAttempts = attempts + 1;
    if (!anyHardError) {
      await doc.ref.update({
        status: manual.length > 0 ? 'needs_manual' : 'resolved',
        resolvedAt: new Date().toISOString(),
        attempts: nextAttempts,
        drainResults: retryResults,
      });
      if (manual.length > 0) {
        results.needsManual += 1;
      } else {
        results.resolved += 1;
      }
      console.log(`[stock-failure-drain] ${doc.id} resolved after attempt ${nextAttempts} (${retryable.length} marketplaceSync)`);
    } else {
      const nextStatus = nextAttempts >= MAX_ATTEMPTS ? 'abandoned' : 'pending';
      await doc.ref.update({
        status: nextStatus,
        attempts: nextAttempts,
        lastAttemptAt: new Date().toISOString(),
        drainResults: retryResults,
      });
      if (nextStatus === 'abandoned') {
        results.abandoned += 1;
        console.error(`[stock-failure-drain] ABANDONED after ${MAX_ATTEMPTS} attempts: ${doc.id} — ${JSON.stringify(retryResults)}`);
        // HARDEN-Wave-2 (2026-05-22): Operator-Alert über best-effort Slack.
        await _emitTerminalAlert({
          tenantId,
          failureDocId: doc.id,
          terminalStatus: 'abandoned',
          reason: `After ${MAX_ATTEMPTS} attempts, marketplaceSync still failing`,
          failures: (retryResults || []).slice(0, 3),
        });
      } else {
        results.stillFailing += 1;
      }
    }
  }

  return results;
}

// ───────────────────────────────────────────────────────────────────────────
// Best-effort Terminal-State Alerting (Slack-Webhook).
// HARDEN-Wave-2 (2026-05-22): Drain markiert Failures als `abandoned` oder
// `needs_manual` — vorher passierte da NICHTS außer einem console.error.
// Jetzt: zusätzlich ein Slack-POST an SLACK_ALERTS_URL (wenn gesetzt) und
// ein structured Firestore-Eintrag in `stock_failure_alerts` (queryable).
// Fire-and-forget — NIE blocking, NIE failing.
// ───────────────────────────────────────────────────────────────────────────

async function _emitTerminalAlert({ tenantId, failureDocId, terminalStatus, reason, failures }) {
  try {
    const summary = `🚨 [stock-drain] ${terminalStatus.toUpperCase()} — tenant=${tenantId} doc=${failureDocId}\n${reason}`;
    const detail = (failures || []).map((f) => {
      if (!f) return null;
      return `  • ${f.step || 'unknown'}: sku=${f.sku || f.productKey || '?'} error=${(f.error || f.message || '').toString().slice(0, 200)}`;
    }).filter(Boolean).join('\n');
    const text = detail ? `${summary}\n${detail}` : summary;

    // Best-effort Slack post
    const slackUrl = process.env.SLACK_ALERTS_URL;
    if (slackUrl) {
      // node 20 has global fetch; never await result
      Promise.resolve()
        .then(() => fetch(slackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        }))
        .catch((err) => console.warn(`[stock-failure-drain] slack alert failed: ${err.message}`));
    }

    // Audit-trail in Firestore (queryable für Ops-Dashboard)
    try {
      const { firestore } = require('../lib/firestore');
      await firestore.collection('stock_failure_alerts').add({
        tenantId: tenantId || 'default',
        failureDocId,
        terminalStatus,
        reason,
        failures: failures || [],
        text,
        createdAt: new Date().toISOString(),
      });
    } catch (writeErr) {
      console.warn(`[stock-failure-drain] alert audit write failed: ${writeErr.message}`);
    }
  } catch (err) {
    // Alerting must NEVER break the drain loop.
    console.warn(`[stock-failure-drain] _emitTerminalAlert failed: ${err.message}`);
  }
}

module.exports = { drainStockFailures, MAX_ATTEMPTS };
