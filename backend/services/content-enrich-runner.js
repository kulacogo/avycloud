'use strict';

/**
 * content-enrich-runner.js — per-product orchestration for the `reenrich_content`
 * bulk action. Uses the chat pipeline (enrichViaChatV3) to enrich the FULL
 * datasheet (title, price, gpsr, attributes, description, weight) with research,
 * then persists CONTENT ONLY via saveProductV2 and stamps the ops.autoImprove
 * indicator. Never touches inventory/sku/storage; never changes category; never
 * publishes. Dependencies injectable via opts.deps for deterministic tests.
 */

function bucketOf(errored, changedCount) {
  if (errored) return 'error';
  return changedCount ? 'enriched' : 'unchanged';
}

async function applyEnrichmentToProduct(product, opts = {}) {
  const apply = Boolean(opts.apply);
  const deps = opts.deps || {};
  const enrich = deps.enrich || require('./chat-enricher').enrichViaChatV3;
  const save = deps.save || require('../lib/product-store').saveProductV2;
  const now = deps.now || (() => new Date().toISOString());

  const r = await enrich(product, { tenantId: opts.tenantId || null, nowIso: now });
  const changedFields = Array.isArray(r && r.changed) ? r.changed : [];
  const errored = Boolean(r && r.error);
  const bucket = bucketOf(errored, changedFields.length);

  let applied = false;
  if (apply && !errored && changedFields.length) {
    const next = r.product;
    next.ops = next.ops || {};
    next.ops.autoImprove = {
      lastAppliedAt: now(),
      appliedChanges: changedFields,
      confidence: r.confidence ?? null,
      model: r.model || null,
      evidenceCount: Array.isArray(r.evidence) ? r.evidence.length : 0,
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
      confidence: r.confidence ?? null,
      model: r.model || null,
    };

    // CONTENT ONLY. skipTitlePolicy: keep our brand-first title (no re-coercion).
    // No allowCategoryChange / allowWarehouseFields → category + inventory protected.
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
    changedFields,
    confidence: r ? r.confidence ?? null : null,
    evidenceCount: Array.isArray(r && r.evidence) ? r.evidence.length : 0,
    model: (r && r.model) || null,
    error: (r && r.error) || null,
  };
}

module.exports = { applyEnrichmentToProduct, _internal: { bucketOf } };
