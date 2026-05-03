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

async function drainStockFailures({ tenantId, limit = 50 } = {}) {
  if (process.env.STOCK_FAILURE_DRAIN_ENABLED === 'false') {
    return { skipped: true, reason: 'STOCK_FAILURE_DRAIN_ENABLED=false' };
  }
  if (!tenantId) {
    throw new Error('drainStockFailures: tenantId required');
  }

  const { firestore } = require('../lib/firestore');
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');

  // Tenant-scoped, single where clause to avoid index requirements on first run.
  // Pending-Filter und attempts-Filter in Node.
  const snap = await firestore.collection('stock_operation_failures')
    .where('tenantId', '==', tenantId)
    .orderBy('createdAt', 'asc')
    .limit(limit * 4)
    .get();

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
      continue;
    }

    // Retry marketplaceSync-Failures.
    const retryResults = [];
    let anyHardError = false;
    for (const f of retryable) {
      try {
        const sku = String(f.sku || '').trim();
        if (!sku) {
          retryResults.push({ sku: null, ok: false, error: 'no-sku' });
          anyHardError = true;
          continue;
        }
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
        if (productSnap.empty) {
          retryResults.push({ sku, ok: false, error: 'product-not-found' });
          anyHardError = true;
          continue;
        }
        const pDoc = productSnap.docs[0];
        const product = { id: pDoc.id, ...pDoc.data() };
        const r = await syncStockWithRetry({ tenantId, product, reason: `drain:${doc.id}` });
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
      } else {
        results.stillFailing += 1;
      }
    }
  }

  return results;
}

module.exports = { drainStockFailures, MAX_ATTEMPTS };
