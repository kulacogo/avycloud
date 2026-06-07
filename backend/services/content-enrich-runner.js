'use strict';

/**
 * content-enrich-runner.js — per-product orchestration around the content
 * enricher, used by the `reenrich_content` bulk action.
 *
 * Responsibilities:
 *   - run enrichProductContent on a single product
 *   - bucket the outcome: ready | improved | needs_human
 *   - on apply: persist CONTENT ONLY via saveProductV2 (never warehouse fields)
 *     and stamp the ops.autoImprove indicator (reviewStatus 'pending_review')
 *
 * Dependencies are injectable via opts.deps for deterministic testing.
 */

function bucketOf(ready, changedFields) {
  if (ready) return 'ready';
  return changedFields.length ? 'improved' : 'needs_human';
}

async function applyEnrichmentToProduct(product, opts = {}) {
  const apply = Boolean(opts.apply);
  const deps = opts.deps || {};
  const enrich = deps.enrich || require('./content-enricher').enrichProductContent;
  const save = deps.save || require('../lib/product-store').saveProductV2;
  const now = deps.now || (() => new Date().toISOString());

  const r = await enrich(product, { maxIter: opts.maxIter, marketplace: opts.marketplace });
  const changedFields = Object.keys((r && r.changed) || {});
  const ready = Boolean(r && r.ready);
  const bucket = bucketOf(ready, changedFields);

  let applied = false;
  if (apply && changedFields.length) {
    const next = r.product;
    next.ops = next.ops || {};
    next.ops.autoImprove = {
      lastAppliedAt: now(),
      appliedChanges: changedFields,
      readyBefore: Boolean(r.scoreBefore && r.scoreBefore.ready),
      readyAfter: ready,
      reviewStatus: 'pending_review',
      reviewedBy: null,
      reviewedAt: null,
      source: 'bulk:reenrich_content',
    };
    next.ops.last_saved_source = 'content-enrich';
    next.ops.last_saved_iso = now();
    next.ops.data_quality = next.ops.data_quality || {};
    next.ops.data_quality.reenrich_content_v1 = {
      at_iso: now(),
      changed: changedFields,
      ready,
      remaining_issues: (r.remainingIssues || []).slice(0, 40),
    };

    // CONTENT ONLY: no allowWarehouseFields → inventory/storage/sku preserved by saveProductV2.
    await save(next, {
      source: 'content-enrich',
      skipStockEvent: true,
      overwriteTextFields: true,
      skipTitlePolicy: true,
      skipKeyFeaturesNormalize: true,
    });
    applied = true;
  }

  return {
    id: product && product.id,
    bucket,
    applied,
    ready,
    changedFields,
    remainingIssues: (r && r.remainingIssues) || [],
  };
}

module.exports = { applyEnrichmentToProduct, _internal: { bucketOf } };
