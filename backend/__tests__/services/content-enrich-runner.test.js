'use strict';

// TDD for backend/services/content-enrich-runner.js
// applyEnrichmentToProduct: per-product orchestration used by the bulk action.
//  - dry-run (apply:false): never saves, just reports the proposed result
//  - apply:true: saves CONTENT ONLY via injected save, stamps the
//    ops.autoImprove indicator, and NEVER enables warehouse writes
//  - buckets each product: ready | improved | needs_human

const { applyEnrichmentToProduct } = require('../../services/content-enrich-runner');

const now = () => '2026-06-07T00:00:00.000Z';

describe('applyEnrichmentToProduct', () => {
  it('dry-run never saves and reports the proposed changes + bucket', async () => {
    const enrich = async () => ({
      product: { id: 'p1', ops: {}, details: {} },
      changed: { price: { after: 99.95 } },
      ready: true,
      scoreBefore: { ready: false },
      scoreAfter: { ready: true },
      remainingIssues: [],
    });
    const save = vi.fn();

    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: false, deps: { enrich, save, now } });

    expect(save).not.toHaveBeenCalled();
    expect(res.applied).toBe(false);
    expect(res.bucket).toBe('ready');
    expect(res.changedFields).toEqual(['price']);
    expect(res.ready).toBe(true);
  });

  it('apply stamps ops.autoImprove (pending_review) and saves content-only, never warehouse', async () => {
    const product = { id: 'p1', ops: {}, details: {}, inventory: { quantity: 5 } };
    const enriched = { id: 'p1', ops: {}, details: { pricing: { sellPrice: 99.95 } }, inventory: { quantity: 5 } };
    const enrich = async () => ({
      product: enriched,
      changed: { price: { after: 99.95 }, title: { after: 'Better Title' } },
      ready: true,
      scoreBefore: { ready: false },
      scoreAfter: { ready: true },
      remainingIssues: [],
    });
    const save = vi.fn(async () => ({ ok: true }));

    const res = await applyEnrichmentToProduct(product, { apply: true, deps: { enrich, save, now } });

    expect(save).toHaveBeenCalledTimes(1);
    const [savedProduct, savedOpts] = save.mock.calls[0];

    // indicator stamped
    expect(savedProduct.ops.autoImprove.reviewStatus).toBe('pending_review');
    expect(savedProduct.ops.autoImprove.appliedChanges).toEqual(['price', 'title']);
    expect(savedProduct.ops.autoImprove.source).toBe('bulk:reenrich_content');
    expect(savedProduct.ops.autoImprove.lastAppliedAt).toBe('2026-06-07T00:00:00.000Z');
    expect(savedProduct.ops.last_saved_source).toBe('content-enrich');

    // safe save options
    expect(savedOpts.skipStockEvent).toBe(true);
    expect(savedOpts.allowWarehouseFields).toBeUndefined(); // MUST never enable warehouse writes

    expect(res.applied).toBe(true);
    expect(res.bucket).toBe('ready');
  });

  it('apply with no changes does not save (nothing to write)', async () => {
    const enrich = async () => ({
      product: { id: 'p1', ops: {} },
      changed: {},
      ready: true,
      scoreBefore: { ready: true },
      scoreAfter: { ready: true },
      remainingIssues: [],
    });
    const save = vi.fn();

    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: true, deps: { enrich, save, now } });

    expect(save).not.toHaveBeenCalled();
    expect(res.applied).toBe(false);
    expect(res.bucket).toBe('ready');
  });

  it('buckets not-ready-with-no-changes as needs_human and surfaces remaining issues', async () => {
    const enrich = async () => ({
      product: { id: 'p1' },
      changed: {},
      ready: false,
      scoreBefore: { ready: false },
      scoreAfter: { ready: false },
      remainingIssues: ['price_missing'],
    });
    const save = vi.fn();

    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: true, deps: { enrich, save, now } });

    expect(res.bucket).toBe('needs_human');
    expect(res.remainingIssues).toContain('price_missing');
    expect(save).not.toHaveBeenCalled();
  });

  it('buckets not-ready-but-improved as improved', async () => {
    const enrich = async () => ({
      product: { id: 'p1', ops: {} },
      changed: { title: { after: 'X' } },
      ready: false,
      scoreBefore: { ready: false },
      scoreAfter: { ready: false },
      remainingIssues: ['price_missing'],
    });
    const save = vi.fn(async () => ({}));

    const res = await applyEnrichmentToProduct({ id: 'p1' }, { apply: true, deps: { enrich, save, now } });

    expect(res.bucket).toBe('improved');
    expect(res.applied).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
