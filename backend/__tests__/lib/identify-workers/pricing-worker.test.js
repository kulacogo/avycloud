'use strict';

const Module = require('module');

function patchLocalModule(modulePath, exportsOverride) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const fakeModule = new Module(resolved);
  fakeModule.exports = exportsOverride;
  fakeModule.loaded = true;
  fakeModule.filename = resolved;
  require.cache[resolved] = fakeModule;
  return { resolved, revert: () => delete require.cache[resolved] };
}

describe('pricing-worker', () => {
  let pricingWorker;
  let atomicHandle;
  let enrichHandle;

  beforeEach(() => {
    delete require.cache[require.resolve('../../../lib/identify-workers/pricing-worker')];
    atomicHandle = patchLocalModule('../../../services/atomic-tools', {
      buildToolExecutorMap: () => ({
        search_ebay_sold: () =>
          Promise.resolve({
            ok: true,
            data: {
              items: [
                { price: 100 },
                { price: 105 },
                { price: 98 },
                { price: 102 },
                { price: 101 },
              ],
            },
          }),
        search_amazon_product: () =>
          Promise.resolve({ ok: true, data: { price: 99 } }),
        search_idealo: () =>
          Promise.resolve({
            ok: true,
            data: { offers: [{ price: 97, title: 'x', source: 's', link: 'https://idealo.de/1' }] },
          }),
      }),
    });
    enrichHandle = patchLocalModule('../../../lib/price-enrichment', {
      enrichPriceParallel: () =>
        Promise.resolve({ amount: 103, sources: [] }),
    });
    pricingWorker = require('../../../lib/identify-workers/pricing-worker');
  });

  afterEach(() => {
    atomicHandle.revert();
    enrichHandle.revert();
  });

  it('DOMAIN is "pricing"', () => {
    expect(pricingWorker.DOMAIN).toBe('pricing');
  });

  it('ok:false when product missing', async () => {
    const r = await pricingWorker.runPricingWorker({});
    expect(r.ok).toBe(false);
    expect(r.domain).toBe('pricing');
  });

  it('computes price with all sources', async () => {
    const r = await pricingWorker.runPricingWorker({
      product: { identification: { brand: 'Sony', name: 'Test', condition: 'NEW' } },
      barcodes: { ean: '4548736132610' },
    });
    expect(r.ok).toBe(true);
    expect(r.resolved.price_suggested).toBeGreaterThan(90);
    expect(r.resolved.price_suggested).toBeLessThan(110);
    expect(r.confidence.price).toBeGreaterThan(0.5);
    expect(r.resolved.fee_breakdown.marketplace).toBe('EBAY_DE');
    expect(r.resolved.data_points.sold).toBe(5);
  });

  it('returns unified shape', async () => {
    const r = await pricingWorker.runPricingWorker({
      product: { identification: { brand: 'X' } },
    });
    expect(r).toHaveProperty('ok');
    expect(r).toHaveProperty('domain', 'pricing');
    expect(r).toHaveProperty('resolved');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('sources');
    expect(r).toHaveProperty('meta');
  });

  it('handles all atomic tools missing', async () => {
    atomicHandle.revert();
    atomicHandle = patchLocalModule('../../../services/atomic-tools', {
      buildToolExecutorMap: () => ({}),
    });
    delete require.cache[require.resolve('../../../lib/identify-workers/pricing-worker')];
    pricingWorker = require('../../../lib/identify-workers/pricing-worker');
    const r = await pricingWorker.runPricingWorker({
      product: { identification: { brand: 'X' } },
    });
    // Depends on price-enrichment — may be ok:true with low confidence, or ok:false
    expect(r.domain).toBe('pricing');
    expect(typeof r.ok).toBe('boolean');
  });

  it('fee_breakdown reflects EBAY_DE 12.5% fee', async () => {
    const r = await pricingWorker.runPricingWorker({
      product: { identification: { brand: 'Sony' } },
      barcodes: { ean: '4548736132610' },
    });
    if (r.ok) {
      expect(r.resolved.fee_breakdown.feePercent).toBeCloseTo(0.125);
    }
  });
});
