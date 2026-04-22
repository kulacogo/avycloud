'use strict';

const { runSeoWorker, DOMAIN } = require('../../../lib/identify-workers/seo-worker');

describe('seo-worker', () => {
  it('DOMAIN is "seo"', () => {
    expect(DOMAIN).toBe('seo');
  });

  it('ok:false when product missing', async () => {
    const r = await runSeoWorker({});
    expect(r.ok).toBe(false);
    expect(r.domain).toBe('seo');
    expect(r.meta.error).toBe('product_missing');
  });

  it('produces title + description from basic hints', async () => {
    const r = await runSeoWorker({
      product: {
        identification: { brand: 'Sony', name: 'Kopfhörer', condition: 'Neu' },
      },
      workerResults: {
        identity: { resolved: { brand: 'Sony', model: 'WH-1000XM5' } },
      },
      identity: { productType: 'Kopfhörer', color: 'Schwarz' },
    });
    expect(r.ok).toBe(true);
    expect(r.resolved.title_ebay).toMatch(/Sony/i);
    expect(r.resolved.title_ebay.length).toBeLessThanOrEqual(80);
    expect(r.resolved.description_ebay).toContain('<');
  });

  it('kaufland title can be longer than ebay (up to 150)', async () => {
    const r = await runSeoWorker({
      product: { identification: { brand: 'Sony', name: 'Test' } },
      identity: {
        productType: 'Premium Wireless Bluetooth Active Noise Cancelling Kopfhörer',
      },
      workerResults: { identity: { resolved: { brand: 'Sony', model: 'WH-1000XM5' } } },
    });
    expect(r.resolved.title_kaufland.length).toBeLessThanOrEqual(150);
    expect(r.resolved.title_ebay.length).toBeLessThanOrEqual(80);
  });

  it('mobile_snippet is plain text without HTML tags', async () => {
    const r = await runSeoWorker({
      product: { identification: { brand: 'Sony', name: 'Test' } },
    });
    expect(r.resolved.mobile_snippet).not.toMatch(/<[^>]+>/);
    expect(r.resolved.mobile_snippet.length).toBeLessThanOrEqual(800);
  });

  it('returns unified shape', async () => {
    const r = await runSeoWorker({
      product: { identification: { brand: 'Sony' } },
    });
    expect(r).toHaveProperty('ok');
    expect(r).toHaveProperty('domain', 'seo');
    expect(r).toHaveProperty('resolved');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('sources');
    expect(r).toHaveProperty('meta');
    expect(r.resolved.seo_score).toHaveProperty('overall');
  });

  it('never throws on malformed context', async () => {
    const r = await runSeoWorker({ product: null });
    expect(r.ok).toBe(false);
    expect(r.meta.error).toBeDefined();
  });
});
