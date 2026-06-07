'use strict';

// TDD for backend/services/content-enricher.js
// The content-enricher lifts an EXISTING product's datasheet content up to the
// eBay-ready standard, in-place, WITHOUT ever touching inventory / sku / storage.
// All external building blocks are injected via opts.deps so these tests are
// deterministic and offline.

const { enrichProductContent, _internal } = require('../../services/content-enricher');

// Integration guard: the REAL default dependencies must all resolve to callable
// functions. (Caught a missing getPriceStatus export that injected unit tests hid.)
describe('content-enricher default deps resolve to real functions', () => {
  const getDep = _internal.buildDepResolver({});
  for (const name of [
    'evaluateEbayReady',
    'getPriceStatus',
    'computeSweetSpotPrice',
    'buildEbayTitle',
    'coerceTitleToPolicy',
    'buildEbayDescription',
    'enforceAspectCap',
    'getRequiredAspects',
  ]) {
    it(`${name} resolves to a function`, () => {
      expect(typeof getDep(name)).toBe('function');
    });
  }
});

function baseProduct(overrides = {}) {
  return {
    id: 'p1',
    identification: {
      sku: 'SKU-1',
      name: 'BrandX Seitenmarkise 300x160 cm Anthrazit Sichtschutz Balkon Windschutz',
      brand: 'BrandX',
      category: 'Garten & Terrasse > Sonnenschutz > Markisen',
      barcodes: [],
    },
    inventory: { quantity: 7 },
    storage: { zone: 'A' },
    storageBins: [{ bin: 'X1', qty: 7 }],
    details: {
      categoryId: '180992',
      short_description: 'x'.repeat(400),
      key_features: ['a', 'b', 'c', 'd', 'e'],
      attributes: [{ key: 'Marke', value: 'BrandX', value_type: 'string' }],
      pricing: {
        sellPrice: 99.9,
        lowest_price: { amount: 99.9, currency: 'EUR', sources: [{ url: 'https://example.de/x' }] },
      },
      gpsr: {},
    },
    ops: {},
    ...overrides,
  };
}

describe('enrichProductContent — safety + gap-awareness', () => {
  it('returns a ready product unchanged and never mutates inventory / sku / storage', async () => {
    const product = baseProduct();
    const deps = {
      evaluateEbayReady: () => ({ ok: true, issues: [], snapshot: {}, missingRequiredAspects: [] }),
      getPriceStatus: () => ({ ok: true, amount: 99.9, hasEvidence: true, sourceCount: 1 }),
    };

    const res = await enrichProductContent(product, { deps, maxIter: 3 });

    expect(res.ready).toBe(true);
    expect(res.changed).toEqual({});
    // protected fields identical in output
    expect(res.product.inventory).toEqual({ quantity: 7 });
    expect(res.product.identification.sku).toBe('SKU-1');
    expect(res.product.storage).toEqual({ zone: 'A' });
    expect(res.product.storageBins).toEqual([{ bin: 'X1', qty: 7 }]);
    // input object not mutated (pure)
    expect(product.details.pricing.sellPrice).toBe(99.9);
  });
});

// Shared realistic price-gate used by the price tests (mirrors getPriceStatus).
function priceStatusOf(p) {
  const lp = p && p.details && p.details.pricing && p.details.pricing.lowest_price;
  const amount = lp && lp.amount;
  const hasEvidence = Boolean(lp && Array.isArray(lp.sources) && lp.sources.some((s) => s && s.url));
  const ok = Boolean(lp) && Number.isFinite(amount) && amount >= 1 && hasEvidence;
  return { ok, amount: Number.isFinite(amount) ? amount : null, hasEvidence, sourceCount: (lp && lp.sources && lp.sources.length) || 0 };
}

describe('enrichProductContent — price fill', () => {
  function pricelessProduct() {
    const p = baseProduct();
    p.details.pricing = { lowest_price: { amount: 0, currency: 'EUR', sources: [] }, price_confidence: 0 };
    return p;
  }

  // price is the only gap → readiness derives from the price gate
  const priceOnlyDeps = {
    evaluateEbayReady: (p) => {
      const price = priceStatusOf(p);
      return { ok: price.ok, issues: price.ok ? [] : ['price_missing'], snapshot: {}, missingRequiredAspects: [] };
    },
    getPriceStatus: priceStatusOf,
    executors: {
      executeSearchEbaySold: async () => ({
        ok: true,
        source: 'search_ebay_sold',
        data: { items: [{ price: 95, url: 'https://ebay.de/itm/1' }, { price: 99, url: 'https://ebay.de/itm/2' }], signals: {} },
        confidence: 0.8,
      }),
      executeSearchAmazonProduct: async () => ({
        ok: true,
        source: 'search_amazon_product',
        data: { result: { price: 109, url: 'https://amazon.de/x' } },
        confidence: 0.6,
      }),
      executeSearchIdealo: async () => ({ ok: false, error: { code: 'X' } }),
    },
    computeSweetSpotPrice: ({ soldItems }) => ({
      ok: true,
      price_suggested: 99.95,
      price_min: 95,
      price_max: 109,
      confidence: 0.8,
      reasons: ['sold_active_agreement'],
      data_points: { sold: (soldItems || []).length, active: 0, amazon: 1 },
    }),
  };

  it('computes a sellPrice from comps, writes lowest_price with evidence, and flips to ready', async () => {
    const product = pricelessProduct();

    const res = await enrichProductContent(product, { deps: priceOnlyDeps, maxIter: 4 });

    expect(res.product.details.pricing.sellPrice).toBe(99.95);
    expect(res.product.details.pricing.lowest_price.amount).toBe(95);
    expect(res.product.details.pricing.lowest_price.currency).toBe('EUR');
    expect(res.product.details.pricing.lowest_price.sources.some((s) => s.url)).toBe(true);
    expect(res.changed.price).toBeTruthy();
    expect(res.ready).toBe(true);
    // protected fields untouched
    expect(res.product.inventory).toEqual({ quantity: 7 });
    expect(res.product.identification.sku).toBe('SKU-1');
  });

  it('does not invent a price when there are no comps (stays not-ready, no sellPrice)', async () => {
    const product = pricelessProduct();
    const noComps = {
      ...priceOnlyDeps,
      executors: {
        executeSearchEbaySold: async () => ({ ok: true, data: { items: [], signals: {} }, confidence: 0.3 }),
        executeSearchAmazonProduct: async () => ({ ok: false, error: { code: 'X' } }),
        executeSearchIdealo: async () => ({ ok: false, error: { code: 'X' } }),
      },
      computeSweetSpotPrice: () => ({ ok: false, price_suggested: null, confidence: 0, reasons: ['no_price_signals'] }),
    };

    const res = await enrichProductContent(product, { deps: noComps, maxIter: 4 });

    expect(res.product.details.pricing.sellPrice).toBeUndefined();
    expect(res.ready).toBe(false);
    expect(res.changed.price).toBeFalsy();
    expect(res.remainingIssues).toContain('price_missing');
  });
});

describe('enrichProductContent — title fill (policy)', () => {
  it('replaces a policy-failing title with the coerced one when it reduces title issues', async () => {
    const product = baseProduct();
    product.identification.name = 'Anthrazit Sichtschutz Markise XXL grosse Ausführung';
    const coerced = 'BelleMax Seitenmarkise Anthrazit 300x160 cm Sichtschutz Balkon Windschutz';
    const deps = {
      evaluateEbayReady: (p) => {
        const name = (p.identification && p.identification.name) || '';
        const ok = name.startsWith('BelleMax Seitenmarkise');
        return {
          ok,
          issues: ok ? [] : ['priority_a_missing_in_title', 'priority_a_not_in_first_60'],
          snapshot: { title_len: name.length },
          missingRequiredAspects: [],
        };
      },
      getPriceStatus: () => ({ ok: true, amount: 99.9, hasEvidence: true, sourceCount: 1 }),
      coerceTitleToPolicy: () => coerced,
    };

    const res = await enrichProductContent(product, { deps, maxIter: 4, titleRewrite: true });

    expect(res.product.identification.name).toBe(coerced);
    expect(res.changed.title).toBeTruthy();
    expect(res.ready).toBe(true);
    expect(res.product.inventory).toEqual({ quantity: 7 });
    expect(res.product.identification.sku).toBe('SKU-1');
  });

  it('keeps the existing title when coercion does not reduce title issues', async () => {
    const product = baseProduct();
    const original = product.identification.name;
    const deps = {
      evaluateEbayReady: () => ({ ok: false, issues: ['priority_a_missing_in_title'], snapshot: {}, missingRequiredAspects: [] }),
      getPriceStatus: () => ({ ok: true, amount: 99.9, hasEvidence: true, sourceCount: 1 }),
      coerceTitleToPolicy: (p, t) => t, // no change → no improvement
    };

    const res = await enrichProductContent(product, { deps, maxIter: 2, titleRewrite: true });

    expect(res.product.identification.name).toBe(original);
    expect(res.changed.title).toBeFalsy();
  });

  it('leaves the title UNTOUCHED by default (titleRewrite off) — brand-drop incident guard', async () => {
    const product = baseProduct();
    const original = product.identification.name;
    const deps = {
      evaluateEbayReady: (p) => {
        const name = (p.identification && p.identification.name) || '';
        const ok = name.startsWith('ZZZ'); // never ready on title
        return { ok, issues: ok ? [] : ['priority_a_missing_in_title'], snapshot: {}, missingRequiredAspects: [] };
      },
      getPriceStatus: () => ({ ok: true, amount: 99.9, hasEvidence: true, sourceCount: 1 }),
      coerceTitleToPolicy: () => 'TITEL OHNE MARKE',
    };

    const res = await enrichProductContent(product, { deps, maxIter: 2 }); // no titleRewrite

    expect(res.product.identification.name).toBe(original);
    expect(res.changed.title).toBeFalsy();
  });
});

describe('enrichProductContent — description fill', () => {
  it('builds an HTML description when short_description is too short', async () => {
    const product = baseProduct();
    product.details.short_description = 'Kurze Beschreibung.'; // < 260
    const html = '<section class="hero"><p>' + 'Detaillierte Beschreibung. '.repeat(20) + '</p></section>';
    const deps = {
      evaluateEbayReady: (p) => {
        const d = ((p.details && (p.details.short_description || p.details.description)) || '');
        const ok = d.length >= 260;
        return { ok, issues: ok ? [] : ['description_too_short'], snapshot: { desc_len: d.length }, missingRequiredAspects: [] };
      },
      getPriceStatus: () => ({ ok: true, amount: 99.9, hasEvidence: true, sourceCount: 1 }),
      buildEbayDescription: () => ({ html, length: html.length }),
    };

    const res = await enrichProductContent(product, { deps, maxIter: 4 });

    expect(res.product.details.short_description).toBe(html);
    expect(res.product.details.short_description.length).toBeGreaterThanOrEqual(260);
    expect(res.changed.description).toBeTruthy();
    expect(res.ready).toBe(true);
  });
});

describe('enrichProductContent — required-aspect fill (no hallucination)', () => {
  it('fills a missing required aspect from deterministic sources (category leaf -> Produktart)', async () => {
    const product = baseProduct();
    product.identification.category = 'Garten & Terrasse > Sonnenschutz > Markisen';
    product.details.attributes = { Marke: 'BrandX' }; // object form, missing Produktart
    const deps = {
      evaluateEbayReady: (p) => {
        const a = p.details && p.details.attributes;
        const has = a && typeof a === 'object' && !Array.isArray(a) && a.Produktart;
        const ok = Boolean(has);
        return {
          ok,
          issues: ok ? [] : ['missing_required_aspects: Produktart'],
          snapshot: {},
          missingRequiredAspects: ok ? [] : ['Produktart'],
        };
      },
      getPriceStatus: () => ({ ok: true, amount: 99.9, hasEvidence: true, sourceCount: 1 }),
    };

    const res = await enrichProductContent(product, { deps, maxIter: 4 });

    expect(res.product.details.attributes.Produktart).toBe('Markisen');
    expect(res.product.details.attributes.Marke).toBe('BrandX'); // existing kept
    expect(res.changed.aspects).toBeTruthy();
    expect(res.ready).toBe(true);
  });

  it('leaves a non-derivable required aspect missing (no hallucination)', async () => {
    const product = baseProduct();
    product.details.attributes = { Marke: 'BrandX' };
    const deps = {
      evaluateEbayReady: (p) => {
        const a = p.details && p.details.attributes;
        const has = a && a.Wassersäule;
        return {
          ok: Boolean(has),
          issues: has ? [] : ['missing_required_aspects: Wassersäule'],
          snapshot: {},
          missingRequiredAspects: has ? [] : ['Wassersäule'],
        };
      },
      getPriceStatus: () => ({ ok: true, amount: 99.9, hasEvidence: true, sourceCount: 1 }),
    };

    const res = await enrichProductContent(product, { deps, maxIter: 4 });

    expect(res.product.details.attributes.Wassersäule).toBeUndefined();
    expect(res.ready).toBe(false);
    expect(res.changed.aspects).toBeFalsy();
  });
});
