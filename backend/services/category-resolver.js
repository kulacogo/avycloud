/* eslint-disable no-console */
'use strict';

/**
 * Category Resolver v2 — Strategy pattern that picks the best available
 * eBay category for a product. Strategies are tried in order until one
 * yields a confidence ≥ STRATEGY_ACCEPT_THRESHOLD (default 0.8).
 *
 * Strategy chain (highest precision first):
 *   1. Catalog GTIN     → eBay Catalog API voting on primaryCategory (any GTIN)
 *   2. Taxonomy         → get_category_suggestions(brand + name [+ key features])
 *   3. Local lookup     → identification.category breadcrumb -> findEbayCategory
 *                         + MarketplaceLookup.lookupEbay
 *   4. Gemini fallback  → resolveCategoryWithGemini (deterministic candidate list)
 *
 * Validation: results in BANNED_EBAY_CATEGORY_ROOTS are rejected. Soft roots
 * via needsEvidenceRoot() require additional product signals (brand + name +
 * matching keyword) before being accepted; otherwise we fall through.
 *
 * Returns:
 *   { categoryId, breadcrumb, source, confidence, alternatives?, log[] } | null
 */

const { isValidGtin } = require('../lib/gtin');
const {
  getCategorySuggestions,
  searchCatalogByGtin,
} = require('../lib/ebay-taxonomy-remote');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');
const {
  isBannedEbayBreadcrumb,
  needsEvidenceRoot,
} = require('../lib/ebay-category-governance');
const path = require('path');

const STRATEGY_ACCEPT_THRESHOLD = 0.8;
const GEMINI_DEFAULT_CONFIDENCE = 0.75;
const LOCAL_DEFAULT_CONFIDENCE = 0.9;

// Lazy-load the marketplace lookup (CSV is large; do it once per process).
let _lookup = null;
function getLookup() {
  if (_lookup) return _lookup;
  const ebayCsv = path.join(__dirname, '..', 'ebay', 'DE_New_Structure_(May2023).csv');
  const kauflandCsv = path.join(__dirname, '..', 'kaufland', 'category_tree_all_languages.csv');
  _lookup = new MarketplaceLookup({
    ebayCsvPath: ebayCsv,
    kauflandCsvPath: kauflandCsv,
    ebayPathColumn: 'category_path',
    kauflandPathColumn: 'category_path',
  });
  return _lookup;
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function pickPrimaryGtin(product) {
  const ids = product?.details?.identifiers || {};
  const candidates = [
    ids.ean,
    ids.gtin,
    ids.upc,
    product?.identification?.ean,
    product?.identification?.gtin,
    product?.identification?.upc,
  ];
  for (const raw of candidates) {
    const v = safeString(raw);
    if (v && isValidGtin(v)) return v;
  }
  return '';
}

function buildSuggestionQuery(product) {
  const id = product?.identification || {};
  const brand = safeString(id.brand);
  const name = safeString(id.name || id.title);
  const features = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.slice(0, 3).map(safeString).filter(Boolean)
    : [];

  const parts = [];
  if (brand && brand.toLowerCase() !== 'unknown' && brand.toLowerCase() !== 'unbekannt') {
    parts.push(brand);
  }
  if (name) parts.push(name);
  for (const f of features) {
    if (parts.join(' ').length + f.length + 1 > 180) break;
    parts.push(f);
  }
  return parts.join(' ').slice(0, 200).trim();
}

function isAcceptableBreadcrumb(breadcrumb, product) {
  if (!breadcrumb || typeof breadcrumb !== 'string') return false;
  if (!breadcrumb.includes('>')) return false; // require leaf path
  if (isBannedEbayBreadcrumb(breadcrumb)) return false;
  if (needsEvidenceRoot(breadcrumb)) {
    // Require at least one matching keyword between breadcrumb leaf and product text
    const text = [
      product?.identification?.name,
      product?.identification?.brand,
      product?.details?.short_description,
    ]
      .map(safeString)
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!text) return false;
    const leaf = breadcrumb.split('>').pop().trim().toLowerCase();
    const tokens = leaf.split(/\W+/).filter((t) => t.length >= 4);
    const match = tokens.some((t) => text.includes(t));
    if (!match) return false;
  }
  return true;
}

function appendLog(log, entry) {
  log.push({ at_iso: new Date().toISOString(), ...entry });
}

function buildResult({ categoryId, breadcrumb, source, confidence, alternatives, log }) {
  return {
    categoryId: String(categoryId),
    breadcrumb: safeString(breadcrumb),
    source,
    confidence: Number(confidence.toFixed(4)),
    alternatives: alternatives && alternatives.length ? alternatives : undefined,
    log,
  };
}

/**
 * Strategy 1 — Catalog GTIN voting.
 */
async function tryCatalogGtin(product, log) {
  const gtin = pickPrimaryGtin(product);
  if (!gtin) {
    appendLog(log, { strategy: 'catalog', skipped: 'no_gtin' });
    return null;
  }
  try {
    const result = await searchCatalogByGtin(gtin);
    if (!result || !result.categoryId) {
      appendLog(log, { strategy: 'catalog', gtin, hits: 0 });
      return null;
    }
    appendLog(log, {
      strategy: 'catalog',
      gtin,
      categoryId: result.categoryId,
      votes: result.votes,
      total: result.total,
      confidence: result.confidence,
    });
    if (!isAcceptableBreadcrumb(result.breadcrumb, product)) {
      // Try local lookup to enrich/replace breadcrumb if catalog returned only an ID
      const local = findEbayCategory(result.categoryId);
      if (local?.breadcrumb && isAcceptableBreadcrumb(local.breadcrumb, product)) {
        return {
          categoryId: result.categoryId,
          breadcrumb: local.breadcrumb,
          confidence: result.confidence,
        };
      }
      appendLog(log, { strategy: 'catalog', rejected: 'breadcrumb_unacceptable', breadcrumb: result.breadcrumb });
      return null;
    }
    return {
      categoryId: result.categoryId,
      breadcrumb: result.breadcrumb,
      confidence: result.confidence,
    };
  } catch (err) {
    appendLog(log, { strategy: 'catalog', error: err?.message || String(err) });
    return null;
  }
}

/**
 * Strategy 2 — Taxonomy suggestions.
 */
async function tryTaxonomySuggestions(product, log) {
  const query = buildSuggestionQuery(product);
  if (!query) {
    appendLog(log, { strategy: 'suggestions', skipped: 'no_query' });
    return null;
  }
  try {
    const suggestions = await getCategorySuggestions(query);
    if (!Array.isArray(suggestions) || !suggestions.length) {
      appendLog(log, { strategy: 'suggestions', query, hits: 0 });
      return null;
    }
    const top = suggestions[0];
    const alternatives = suggestions
      .slice(1, 4)
      .map((s) => ({ categoryId: s.categoryId, breadcrumb: s.breadcrumb, relevancy: s.relevancy }));
    appendLog(log, {
      strategy: 'suggestions',
      query,
      categoryId: top.categoryId,
      relevancy: top.relevancy,
      hits: suggestions.length,
    });
    if (!isAcceptableBreadcrumb(top.breadcrumb, product)) {
      // Try the next best one which is acceptable
      const next = suggestions.find((s) => isAcceptableBreadcrumb(s.breadcrumb, product));
      if (next) {
        return {
          categoryId: next.categoryId,
          breadcrumb: next.breadcrumb,
          confidence: Number(next.relevancy) || 0,
          alternatives,
        };
      }
      appendLog(log, { strategy: 'suggestions', rejected: 'no_acceptable_suggestion' });
      return null;
    }
    return {
      categoryId: top.categoryId,
      breadcrumb: top.breadcrumb,
      confidence: Number(top.relevancy) || 0,
      alternatives,
    };
  } catch (err) {
    appendLog(log, { strategy: 'suggestions', error: err?.message || String(err) });
    return null;
  }
}

/**
 * Strategy 3 — Local breadcrumb lookup.
 */
function tryLocalLookup(product, log) {
  const breadcrumb = safeString(product?.identification?.category);
  if (!breadcrumb || !breadcrumb.includes('>')) {
    appendLog(log, { strategy: 'local', skipped: 'no_breadcrumb' });
    return null;
  }
  try {
    const lookup = getLookup();
    let id = lookup.lookupEbay(breadcrumb);
    let cat = id ? findEbayCategory(id) : null;
    if (!cat) {
      cat = findEbayCategory(breadcrumb);
      id = cat?.id ? String(cat.id) : '';
    }
    if (!cat || !id) {
      appendLog(log, { strategy: 'local', breadcrumb, hits: 0 });
      return null;
    }
    const fullBreadcrumb = safeString(cat.breadcrumb) || breadcrumb;
    if (!isAcceptableBreadcrumb(fullBreadcrumb, product)) {
      appendLog(log, { strategy: 'local', rejected: 'breadcrumb_unacceptable', breadcrumb: fullBreadcrumb });
      return null;
    }
    appendLog(log, { strategy: 'local', categoryId: id, breadcrumb: fullBreadcrumb });
    return {
      categoryId: String(id),
      breadcrumb: fullBreadcrumb,
      confidence: LOCAL_DEFAULT_CONFIDENCE,
    };
  } catch (err) {
    appendLog(log, { strategy: 'local', error: err?.message || String(err) });
    return null;
  }
}

/**
 * Strategy 4 — Gemini fallback (lazy-required to avoid circular deps).
 */
async function tryGeminiFallback(product, log) {
  try {
    // eslint-disable-next-line global-require
    const { resolveCategoryWithGemini } = require('./enrichment');
    const g = await resolveCategoryWithGemini(product, 'ebay');
    if (!g?.id) {
      appendLog(log, { strategy: 'gemini', hits: 0 });
      return null;
    }
    const breadcrumb = safeString(g.path) || safeString(findEbayCategory(g.id)?.breadcrumb);
    if (!isAcceptableBreadcrumb(breadcrumb, product)) {
      appendLog(log, { strategy: 'gemini', rejected: 'breadcrumb_unacceptable', breadcrumb });
      return null;
    }
    appendLog(log, { strategy: 'gemini', categoryId: g.id, breadcrumb });
    return {
      categoryId: String(g.id),
      breadcrumb,
      confidence: GEMINI_DEFAULT_CONFIDENCE,
    };
  } catch (err) {
    appendLog(log, { strategy: 'gemini', error: err?.message || String(err) });
    return null;
  }
}

/**
 * Resolve the best eBay category for a product.
 *
 * @param {object} product
 * @param {{ reason?: string, threshold?: number }} [options]
 * @returns {Promise<{ categoryId: string, breadcrumb: string, source: 'catalog'|'suggestions'|'local'|'gemini', confidence: number, alternatives?: Array, log: Array } | null>}
 */
async function resolveCategoryV2(product, options = {}) {
  const log = [];
  const reason = safeString(options.reason || 'auto');
  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : STRATEGY_ACCEPT_THRESHOLD;

  appendLog(log, { event: 'start', reason, threshold });

  const strategies = [
    { name: 'catalog', fn: () => tryCatalogGtin(product, log) },
    { name: 'suggestions', fn: () => tryTaxonomySuggestions(product, log) },
    { name: 'local', fn: () => Promise.resolve(tryLocalLookup(product, log)) },
    { name: 'gemini', fn: () => tryGeminiFallback(product, log) },
  ];

  let best = null;
  for (const strat of strategies) {
    let result;
    try {
      result = await strat.fn();
    } catch (err) {
      appendLog(log, { strategy: strat.name, error: err?.message || String(err) });
      result = null;
    }
    if (!result) continue;

    const candidate = buildResult({
      categoryId: result.categoryId,
      breadcrumb: result.breadcrumb,
      source: strat.name,
      confidence: result.confidence,
      alternatives: result.alternatives,
      log,
    });
    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
    if (candidate.confidence >= threshold) {
      appendLog(log, { event: 'accepted', source: strat.name, confidence: candidate.confidence });
      return candidate;
    }
  }

  if (best) {
    appendLog(log, { event: 'best_below_threshold', source: best.source, confidence: best.confidence });
    return best;
  }

  appendLog(log, { event: 'no_match' });
  return null;
}

module.exports = {
  resolveCategoryV2,
  STRATEGY_ACCEPT_THRESHOLD,
  // exposed for tests
  _internal: {
    pickPrimaryGtin,
    buildSuggestionQuery,
    isAcceptableBreadcrumb,
  },
};
