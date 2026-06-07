'use strict';

// TDD for backend/services/content-enrich-runner.js
// applyEnrichmentToProduct runs the chat-based full enricher (injected), then on
// apply persists content-only via saveProductV2 + stamps ops.autoImprove.
// NEVER enables warehouse writes. Buckets: enriched | unchanged | error.

const { applyEnrichmentToProduct } = require('../../services/content-enrich-runner');

const now = () => '2026-06-08T00:00:00.000Z';

describe('applyEnrichmentToProduct (chat-based)', () => {
  it('dry-run never saves and reports changed fields + bucket', async () => {
    const enrich = async () => ({
      product: { id: 'p1', ops: {}, details: {} },
      changed: ['title', 'pricing'],
      confidence: 0.9,
      evidence: [{ url: 'https://x' }],
      model: 'gemini-3.1-pro-preview-customtools',
    });
    const save = vi.fn();

    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: false, deps: { enrich, save, now } });

    expect(save).not.toHaveBeenCalled();
    expect(res.applied).toBe(false);
    expect(res.bucket).toBe('enriched');
    expect(res.changedFields).toEqual(['title', 'pricing']);
    expect(res.confidence).toBe(0.9);
  });

  it('apply stamps ops.autoImprove (pending_review) and saves content-only, never warehouse', async () => {
    const enriched = { id: 'p1', ops: {}, details: { pricing: { lowest_price: { amount: 64.59 } } }, inventory: { quantity: 3 } };
    const enrich = async () => ({
      product: enriched,
      changed: ['title', 'pricing', 'gpsr'],
      confidence: 0.99,
      evidence: [{ url: 'https://a' }, { url: 'https://b' }],
      model: 'gemini-3.1-pro-preview-customtools',
    });
    const save = vi.fn(async () => ({ ok: true }));

    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: true, deps: { enrich, save, now } });

    expect(save).toHaveBeenCalledTimes(1);
    const [savedProduct, savedOpts] = save.mock.calls[0];
    expect(savedProduct.ops.autoImprove.reviewStatus).toBe('pending_review');
    expect(savedProduct.ops.autoImprove.appliedChanges).toEqual(['title', 'pricing', 'gpsr']);
    expect(savedProduct.ops.autoImprove.source).toBe('bulk:reenrich_content');
    expect(savedProduct.ops.autoImprove.evidenceCount).toBe(2);
    expect(savedProduct.ops.last_saved_source).toBe('content-enrich');
    expect(savedOpts.skipStockEvent).toBe(true);
    expect(savedOpts.skipTitlePolicy).toBe(true); // keep brand-first title, no re-coercion
    expect(savedOpts.allowWarehouseFields).toBeUndefined();
    expect(savedOpts.allowCategoryChange).toBeUndefined();
    expect(res.applied).toBe(true);
    expect(res.bucket).toBe('enriched');
  });

  it('apply with no changes does not save (bucket unchanged)', async () => {
    const enrich = async () => ({ product: { id: 'p1', ops: {} }, changed: [], confidence: 0.99, evidence: [] });
    const save = vi.fn();
    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: true, deps: { enrich, save, now } });
    expect(save).not.toHaveBeenCalled();
    expect(res.applied).toBe(false);
    expect(res.bucket).toBe('unchanged');
  });

  it('reports bucket error when the enricher returns an error and never saves', async () => {
    const enrich = async () => ({ product: { id: 'p1' }, changed: [], error: 'gemini down' });
    const save = vi.fn();
    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: true, deps: { enrich, save, now } });
    expect(res.bucket).toBe('error');
    expect(res.error).toMatch(/gemini down/);
    expect(save).not.toHaveBeenCalled();
  });
});
