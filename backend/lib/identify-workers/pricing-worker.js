'use strict';

/**
 * pricing-worker.js — Identify-V4 Worker for sweet-spot pricing.
 *
 * Ruft parallel 3-4 Pricing-Quellen auf (eBay SOLD, Amazon, Idealo, optional
 * enrichPriceParallel), blendet sie über sweet-spot-pricer und liefert einen
 * fee-aware + psychologisch-gerundeten Preis.
 *
 * Rein deterministisch nach dem Fetch — kein Gemini-Call.
 */

const atomicTools = require('../../services/atomic-tools');
const {
  computeSweetSpotPrice,
  applyFeeAwareness,
} = require('../sweet-spot-pricer');

const DOMAIN = 'pricing';
const EXECUTOR_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.ATOMIC_TOOLS_TIMEOUT_MS || '15000', 10)
);

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

function pickGtin(context) {
  const b = context.barcodes || {};
  return safeString(
    b.ean ||
      b.gtin ||
      b.upc ||
      context.workerResults?.identity?.resolved?.gtin ||
      context.workerResults?.identity?.resolved?.ean ||
      ''
  );
}

function pickQueryHint(context) {
  const product = context.product || {};
  const ident = product.identification || {};
  const brand = safeString(ident.brand);
  const name = safeString(ident.name);
  const model = safeString(context.identity?.model || ident.sku);
  return [brand, name, model].filter(Boolean).join(' ').slice(0, 200);
}

async function withTimeout(promise, ms, label) {
  let timer;
  // Suppress orphan rejection from the source promise when timeout wins the
  // race — prevents UnhandledPromiseRejection cascades and the downstream
  // "RangeError: Maximum call stack size exceeded" in PromiseRejectCallback.
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  try {
    return await Promise.race([
      guarded,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tryRequireEnrichPrice() {
  try {
    // eslint-disable-next-line global-require
    return require('../price-enrichment');
  } catch {
    return null;
  }
}

async function runPricingWorker(context = {}) {
  const started = Date.now();
  const meta = {
    durationMs: 0,
    toolsCalled: [],
    geminiCalls: 0,
    error: null,
  };
  const sources = [];

  try {
    if (!context.product || typeof context.product !== 'object') {
      meta.durationMs = Date.now() - started;
      meta.error = 'product_missing';
      return {
        ok: false,
        domain: DOMAIN,
        resolved: {},
        confidence: {},
        sources,
        retriesRequested: [],
        meta,
      };
    }

    const gtin = pickGtin(context);
    const query = pickQueryHint(context);
    const categoryId = context.workerResults?.category?.resolved?.categoryId;
    const condition =
      context.product.identification?.condition ||
      context.identity?.condition ||
      'NEW';

    const executors = atomicTools.buildToolExecutorMap();

    const [soldRes, amazonRes, idealoRes, enrichRes] = await Promise.allSettled([
      executors.search_ebay_sold
        ? withTimeout(
            executors.search_ebay_sold({ gtin, query, categoryId, limit: 20 }),
            EXECUTOR_TIMEOUT_MS,
            'ebay_sold'
          )
        : Promise.resolve(null),
      executors.search_amazon_product
        ? withTimeout(
            executors.search_amazon_product({ gtin, query, region: 'DE' }),
            EXECUTOR_TIMEOUT_MS,
            'amazon'
          )
        : Promise.resolve(null),
      executors.search_idealo
        ? withTimeout(
            executors.search_idealo({ gtin, query, limit: 10 }),
            EXECUTOR_TIMEOUT_MS,
            'idealo'
          )
        : Promise.resolve(null),
      (async () => {
        const lib = tryRequireEnrichPrice();
        if (!lib || typeof lib.enrichPriceParallel !== 'function') return null;
        try {
          return await withTimeout(
            lib.enrichPriceParallel(context.product),
            EXECUTOR_TIMEOUT_MS,
            'enrich'
          );
        } catch {
          return null;
        }
      })(),
    ]);

    const soldVal = soldRes.status === 'fulfilled' ? soldRes.value : null;
    const amazonVal = amazonRes.status === 'fulfilled' ? amazonRes.value : null;
    const idealoVal = idealoRes.status === 'fulfilled' ? idealoRes.value : null;
    const enrichVal = enrichRes.status === 'fulfilled' ? enrichRes.value : null;

    const soldItems =
      soldVal?.ok && Array.isArray(soldVal.data?.items) ? soldVal.data.items : [];
    if (soldItems.length) {
      meta.toolsCalled.push('search_ebay_sold');
      sources.push({ type: 'ebay_sold', data: { count: soldItems.length }, weight: 0.6 });
    }

    let amazonPrice = null;
    if (amazonVal?.ok && amazonVal.data) {
      const p =
        amazonVal.data.price ||
        amazonVal.data.result?.price ||
        amazonVal.data.result?.extracted_price;
      if (typeof p === 'number' && Number.isFinite(p)) amazonPrice = p;
      else if (typeof p === 'string') {
        const n = Number.parseFloat(p.replace(',', '.'));
        if (Number.isFinite(n)) amazonPrice = n;
      }
      if (amazonPrice != null) {
        meta.toolsCalled.push('search_amazon_product');
        sources.push({ type: 'amazon', data: { price: amazonPrice }, weight: 0.15 });
      }
    }

    const idealoOffers =
      idealoVal?.ok && Array.isArray(idealoVal.data?.offers) ? idealoVal.data.offers : [];
    if (idealoOffers.length) {
      meta.toolsCalled.push('search_idealo');
      sources.push({
        type: 'idealo',
        data: { count: idealoOffers.length },
        weight: 0.1,
      });
    }

    const activeListings = [];
    if (enrichVal) {
      const enrichSources = Array.isArray(enrichVal.sources) ? enrichVal.sources : [];
      for (const s of enrichSources) {
        const p = typeof s.price === 'number' ? s.price : null;
        if (p != null) activeListings.push({ price: p });
      }
      if (enrichVal.amount && typeof enrichVal.amount === 'number') {
        activeListings.push({ price: enrichVal.amount });
      }
    }
    for (const o of idealoOffers) {
      if (typeof o.price === 'number') activeListings.push({ price: o.price });
    }

    const result = computeSweetSpotPrice({
      soldItems,
      activeListings,
      amazonPrice,
      marketplace: 'EBAY_DE',
      condition,
    });

    // Dedupe sources (for UI display)
    const uiSources = [];
    const seenUrls = new Set();
    if (enrichVal?.sources) {
      for (const s of enrichVal.sources) {
        if (s.url && !seenUrls.has(s.url)) {
          seenUrls.add(s.url);
          uiSources.push({
            name: s.name || s.url,
            url: s.url,
            price: s.price,
            checked_at: s.checked_at || new Date().toISOString(),
          });
          if (uiSources.length >= 10) break;
        }
      }
    }
    for (const o of idealoOffers) {
      if (o.link && !seenUrls.has(o.link) && uiSources.length < 10) {
        seenUrls.add(o.link);
        uiSources.push({
          name: o.source || 'idealo',
          url: o.link,
          price: o.price,
          checked_at: new Date().toISOString(),
        });
      }
    }

    meta.durationMs = Date.now() - started;

    const feeBreakdown =
      result.ok && result.price_suggested
        ? applyFeeAwareness(result.price_suggested, { marketplace: 'EBAY_DE' })
        : applyFeeAwareness(null, { marketplace: 'EBAY_DE' });

    return {
      ok: result.ok,
      domain: DOMAIN,
      resolved: {
        price_suggested: result.price_suggested,
        price_min: result.price_min,
        price_max: result.price_max,
        currency: 'EUR',
        fee_breakdown: feeBreakdown,
        sources: uiSources,
        data_points: result.data_points,
        psychological_applied: result.psychological_applied,
        reasons: result.reasons,
      },
      confidence: { price: result.confidence },
      sources,
      retriesRequested: [],
      meta,
    };
  } catch (err) {
    meta.durationMs = Date.now() - started;
    meta.error = err.message || String(err);
    return {
      ok: false,
      domain: DOMAIN,
      resolved: {},
      confidence: {},
      sources,
      retriesRequested: [],
      meta,
    };
  }
}

module.exports = { runPricingWorker, DOMAIN };
