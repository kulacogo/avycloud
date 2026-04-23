'use strict';

/**
 * identify-workers/category-worker.js
 *
 * Worker-Agent für Identify-V4: löst eBay-Kategorie (+ zugehörigen Aspects-
 * Katalog) für einen Produkt-Kontext auf. Arbeitet in zwei Pfaden:
 *
 *   1. PRIORITY-PATH (GTIN): Wenn der Kontext eine gültige GTIN/EAN führt,
 *      wird `lib/ebay-catalog.lookupByGtin` befragt. Bei Treffer übernehmen
 *      wir categoryId + aspects direkt (Source: 'auto:catalog', Confidence
 *      0.95).
 *
 *   2. FALLBACK-PATH: `services/category-resolver.resolveCategoryV2` — die
 *      bestehende 4-Strategien-Kaskade (catalog → suggestions → local →
 *      gemini) mit dynamic-confidence-scoring.
 *
 * Nach dem Ermitteln der categoryId wird der Aspects-Katalog nachgeladen —
 * bevorzugt via `services/atomic-tools.executors.executeGetRequiredAspects`,
 * mit direktem `lib/ebay-taxonomy.getCategoryAspectCatalog`-Fallback.
 *
 * Contract (streng):
 *
 *   async function runCategoryWorker(context) → {
 *     ok, domain: 'category',
 *     resolved: { categoryId?, categoryName?, breadcrumb?,
 *                 requiredAspects?, recommendedAspects?, aspectCatalog?,
 *                 categorySource? },
 *     confidence: { categoryId },
 *     sources: [...],
 *     retriesRequested: [],
 *     meta: { durationMs, tokensUsed, toolsCalled, geminiCalls, error? }
 *   }
 *
 * NEVER throw. Fehler → { ok: false, meta.error }.
 */

const DOMAIN = 'category';
const EBAY_MARKETPLACE = 'EBAY_DE';

function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function digitsOnly(value) {
  return safeString(value).replace(/\D/g, '');
}

function pickContextGtin(context) {
  const barcodes = context?.barcodes || {};
  const candidates = [
    barcodes.ean,
    barcodes.gtin,
    barcodes.upc,
    context?.product?.identification?.ean,
    context?.product?.identification?.gtin,
    context?.product?.details?.identifiers?.ean,
    context?.product?.details?.identifiers?.gtin,
  ];
  for (const raw of candidates) {
    const cleaned = digitsOnly(raw);
    if (cleaned && [8, 12, 13, 14].includes(cleaned.length)) return cleaned;
  }
  return '';
}

function isGtinValid(gtin) {
  try {
    // eslint-disable-next-line global-require
    const { isValidGtin } = require('../gtin');
    if (typeof isValidGtin === 'function') return Boolean(isValidGtin(gtin));
  } catch (err) {
    // noop — fall through to structural check
  }
  const d = digitsOnly(gtin);
  return Boolean(d) && [8, 12, 13, 14].includes(d.length);
}

function mapResolverSourceToCategorySource(source) {
  switch (source) {
    case 'catalog':
      return 'auto:catalog';
    case 'suggestions':
      return 'auto:suggestions';
    case 'local':
      return 'auto:local';
    case 'gemini':
      return 'auto:gemini';
    default:
      return source ? `auto:${source}` : 'auto:local';
  }
}

function normalizeAspectName(name) {
  return safeString(name);
}

/**
 * Load aspect catalog for a given categoryId. Prefers
 * `atomic-tools.executors.executeGetRequiredAspects` when available,
 * otherwise falls back to `ebay-taxonomy.getCategoryAspectCatalog`.
 */
async function loadAspectCatalog(categoryId, counters) {
  if (!categoryId) return { ok: false, error: 'missing_category_id' };

  const id = String(categoryId);
  try {
    // eslint-disable-next-line global-require
    const atomic = require('../../services/atomic-tools');
    const executor = atomic?.executors?.executeGetRequiredAspects;
    if (typeof executor === 'function') {
      counters.toolsCalled += 1;
      const result = await executor({ categoryId: id, marketplace: EBAY_MARKETPLACE });
      if (result && result.ok && result.data) {
        const required = Array.isArray(result.data.required) ? result.data.required : [];
        const recommended = Array.isArray(result.data.recommended)
          ? result.data.recommended
          : [];
        const optional = Array.isArray(result.data.optional) ? result.data.optional : [];
        const all = Array.isArray(result.data.all) ? result.data.all : [];
        const aspects = Array.isArray(result.data.aspects) ? result.data.aspects : [];
        return {
          ok: true,
          via: 'atomic-tools',
          requiredAspects: required.map((n) => ({ name: normalizeAspectName(n) })).filter((x) => x.name),
          recommendedAspects: recommended
            .map((n) => ({ name: normalizeAspectName(n) }))
            .filter((x) => x.name),
          aspectCatalog: {
            categoryId: id,
            required,
            recommended,
            optional,
            all,
            aspects,
            hasCatalogEntry: Boolean(result.data.hasCatalogEntry),
          },
        };
      }
    }
  } catch (err) {
    // fall through to direct taxonomy fallback
  }

  try {
    // eslint-disable-next-line global-require
    const taxonomy = require('../ebay-taxonomy');
    if (typeof taxonomy?.getCategoryAspectCatalog === 'function') {
      const catalog = taxonomy.getCategoryAspectCatalog(id);
      if (catalog) {
        const required = Array.isArray(catalog.requiredAspects) ? catalog.requiredAspects : [];
        const recommended = Array.isArray(catalog.recommendedAspects)
          ? catalog.recommendedAspects
          : [];
        return {
          ok: true,
          via: 'ebay-taxonomy',
          requiredAspects: required.map((n) => ({ name: normalizeAspectName(n) })).filter((x) => x.name),
          recommendedAspects: recommended
            .map((n) => ({ name: normalizeAspectName(n) }))
            .filter((x) => x.name),
          aspectCatalog: {
            categoryId: id,
            required,
            recommended,
            optional: Array.isArray(catalog.optionalAspects) ? catalog.optionalAspects : [],
            all: Array.isArray(catalog.allAspects) ? catalog.allAspects : [],
            aspects: Array.isArray(catalog.aspects) ? catalog.aspects : [],
            hasCatalogEntry: Boolean(catalog.hasCatalogEntry),
          },
        };
      }
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  return { ok: false, error: 'no_aspect_catalog' };
}

/**
 * Priority-Path: eBay Catalog lookup via GTIN.
 */
async function tryGtinCatalog(gtin, counters, sources, fallbackQuery) {
  try {
    // eslint-disable-next-line global-require
    const ebayCatalog = require('../ebay-catalog');
    if (typeof ebayCatalog?.lookupByGtin !== 'function') return null;
    counters.toolsCalled += 1;
    const res = await ebayCatalog.lookupByGtin({ gtin, fallbackQuery });
    if (!res || !res.ok || !res.product) return null;
    const product = res.product;
    const categoryId = product.categoryId ? String(product.categoryId) : '';
    if (!categoryId) return null;
    sources.push({
      type: 'ebay_catalog',
      via: res.source || 'ebay_catalog',
      gtin,
      cached: Boolean(res.cached),
      categoryId,
      confidence: 0.95,
    });
    return {
      categoryId,
      categoryName: safeString(product.categoryName) || undefined,
      breadcrumb: safeString(product.categoryName) || undefined,
      gtinAspects: Array.isArray(product.aspects) ? product.aspects : [],
      confidence: 0.95,
      categorySource: 'auto:catalog',
    };
  } catch (err) {
    sources.push({ type: 'ebay_catalog', ok: false, error: err?.message || String(err) });
    return null;
  }
}

/**
 * Fallback-Path: `resolveCategoryV2`.
 */
async function tryResolverFallback(context, counters, sources) {
  try {
    // eslint-disable-next-line global-require
    const { resolveCategoryV2 } = require('../../services/category-resolver');
    if (typeof resolveCategoryV2 !== 'function') return null;
    counters.toolsCalled += 1;
    const product = context?.product || {};
    const result = await resolveCategoryV2(product, {
      tenantId: context?.tenantId,
      reason: 'identify-v4:category-worker',
    });
    if (!result || !result.categoryId) {
      sources.push({ type: 'category_resolver', ok: false, reason: 'no_match' });
      return null;
    }
    sources.push({
      type: 'category_resolver',
      via: result.source,
      categoryId: String(result.categoryId),
      breadcrumb: result.breadcrumb,
      confidence: Number(result.confidence) || 0,
    });
    return {
      categoryId: String(result.categoryId),
      breadcrumb: safeString(result.breadcrumb) || undefined,
      categoryName: safeString(result.breadcrumb)
        ? safeString(result.breadcrumb).split('>').pop().trim()
        : undefined,
      confidence: Number(result.confidence) || 0,
      categorySource: mapResolverSourceToCategorySource(result.source),
    };
  } catch (err) {
    sources.push({ type: 'category_resolver', ok: false, error: err?.message || String(err) });
    return null;
  }
}

function buildFailure({ startedAt, error, sources, counters }) {
  return {
    ok: false,
    domain: DOMAIN,
    resolved: {},
    confidence: { categoryId: 0 },
    sources: sources || [],
    retriesRequested: [],
    meta: {
      durationMs: Date.now() - startedAt,
      tokensUsed: 0,
      toolsCalled: counters ? counters.toolsCalled : 0,
      geminiCalls: counters ? counters.geminiCalls : 0,
      error: error || 'unknown_error',
    },
  };
}

/**
 * runCategoryWorker — Identify-V4 category-domain worker.
 *
 * @param {object} context
 * @param {object} [context.product]         Product-V2 shape
 * @param {object} [context.barcodes]        { ean?, gtin?, upc? }
 * @param {string} [context.tenantId]
 * @returns {Promise<object>}                Worker-Response (see contract).
 */
async function runCategoryWorker(context) {
  const startedAt = Date.now();
  const sources = [];
  const counters = { toolsCalled: 0, geminiCalls: 0 };

  if (!context || typeof context !== 'object') {
    return buildFailure({ startedAt, error: 'missing_context', sources, counters });
  }
  if (!context.product || typeof context.product !== 'object') {
    return buildFailure({ startedAt, error: 'missing_product', sources, counters });
  }

  let resolved = null;

  // Build a fallback keyword query (brand + name + model) so ebay-catalog
  // can fall back to keyword Browse when GTIN returns 0 matches.
  const ident = context.product.identification || {};
  const workerIdBrand = context.workerResults?.identity?.resolved?.brand;
  const fallbackQuery = [workerIdBrand || ident.brand, ident.name, context.identity?.model]
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 200);

  // --- Priority-Path: GTIN catalog lookup -----------------------------------
  const gtin = pickContextGtin(context);
  if (gtin && isGtinValid(gtin)) {
    const catalogHit = await tryGtinCatalog(gtin, counters, sources, fallbackQuery);
    if (catalogHit) resolved = catalogHit;
  } else if (fallbackQuery && fallbackQuery.length >= 3) {
    // No valid GTIN but have query → try catalog with query-only fallback
    const catalogHit = await tryGtinCatalog('', counters, sources, fallbackQuery);
    if (catalogHit) resolved = catalogHit;
  }

  // --- Fallback-Path: resolveCategoryV2 -------------------------------------
  if (!resolved) {
    const fallback = await tryResolverFallback(context, counters, sources);
    if (fallback) resolved = fallback;
  }

  if (!resolved || !resolved.categoryId) {
    return buildFailure({
      startedAt,
      error: 'category_not_resolved',
      sources,
      counters,
    });
  }

  // --- Aspect-catalog-load --------------------------------------------------
  let aspectsOk = false;
  let confidence = resolved.confidence;
  try {
    const aspectResult = await loadAspectCatalog(resolved.categoryId, counters);
    if (aspectResult && aspectResult.ok) {
      resolved.requiredAspects = aspectResult.requiredAspects;
      resolved.recommendedAspects = aspectResult.recommendedAspects;
      resolved.aspectCatalog = aspectResult.aspectCatalog;
      aspectsOk = true;
      sources.push({
        type: 'aspect_catalog',
        via: aspectResult.via,
        categoryId: resolved.categoryId,
        requiredCount: aspectResult.requiredAspects.length,
      });
    } else {
      sources.push({
        type: 'aspect_catalog',
        ok: false,
        categoryId: resolved.categoryId,
        error: aspectResult?.error || 'aspect_load_failed',
      });
      // Category resolved but no aspects → keep categoryId, lower confidence.
      confidence = Math.max(0, Number(confidence) - 0.1);
    }
  } catch (err) {
    sources.push({
      type: 'aspect_catalog',
      ok: false,
      categoryId: resolved.categoryId,
      error: err?.message || String(err),
    });
    confidence = Math.max(0, Number(confidence) - 0.1);
  }

  // If GTIN-catalog path yielded aspect hints but taxonomy failed, surface them.
  if (!aspectsOk && Array.isArray(resolved.gtinAspects) && resolved.gtinAspects.length) {
    resolved.requiredAspects = resolved.gtinAspects
      .map((a) => ({ name: safeString(a?.key || a?.name) }))
      .filter((x) => x.name);
  }
  delete resolved.gtinAspects;

  return {
    ok: true,
    domain: DOMAIN,
    resolved: {
      categoryId: resolved.categoryId,
      categoryName: resolved.categoryName,
      breadcrumb: resolved.breadcrumb,
      requiredAspects: resolved.requiredAspects,
      recommendedAspects: resolved.recommendedAspects,
      aspectCatalog: resolved.aspectCatalog,
      categorySource: resolved.categorySource,
    },
    confidence: { categoryId: Number(Number(confidence || 0).toFixed(4)) },
    sources,
    retriesRequested: [],
    meta: {
      durationMs: Date.now() - startedAt,
      tokensUsed: 0,
      toolsCalled: counters.toolsCalled,
      geminiCalls: counters.geminiCalls,
    },
  };
}

module.exports = {
  runCategoryWorker,
  // exposed for tests
  _internal: {
    pickContextGtin,
    isGtinValid,
    mapResolverSourceToCategorySource,
    loadAspectCatalog,
    tryGtinCatalog,
    tryResolverFallback,
    DOMAIN,
    EBAY_MARKETPLACE,
  },
};
