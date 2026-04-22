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
 * Dynamic confidence (CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE=true, default on):
 *   Every strategy produces a confidence score via a strategy-specific
 *   compute*Confidence() helper instead of using hard-coded constants.
 *   Each helper returns a breakdown (base, boosts, penalties) for telemetry.
 *
 * Returns:
 *   { categoryId, breadcrumb, source, confidence,
 *     confidenceBreakdown, keywordMatch, alternatives?, log[] } | null
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

// Dynamic confidence feature flag. Default ON. Set to 'false' to fall back
// to the legacy hard-coded confidences (LOCAL_DEFAULT_CONFIDENCE etc.).
function isDynamicConfidenceEnabled() {
  const raw = process.env.CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE;
  if (raw == null || raw === '') return true;
  return String(raw).toLowerCase() !== 'false';
}

// Minimal stopword list used by the keyword-overlap helper. Intentionally
// small — we only want to strip very generic noise words in DE/EN so that
// domain vocabulary still drives the match.
const KEYWORD_STOPWORDS = new Set([
  // German
  'und', 'oder', 'für', 'fur', 'mit', 'von', 'der', 'die', 'das', 'den', 'dem',
  'ein', 'eine', 'einen', 'zum', 'zur', 'im', 'am', 'bei', 'aus', 'nach',
  // English
  'the', 'and', 'or', 'for', 'with', 'from', 'to', 'of', 'a', 'an', 'in', 'on',
  'at', 'by',
]);

function tokenizeForMatch(text) {
  if (text == null) return [];
  const lower = String(text).toLowerCase();
  const raw = lower.split(/[^\p{L}\p{N}]+/u);
  const tokens = [];
  for (const tok of raw) {
    if (!tok) continue;
    if (tok.length < 2) continue;
    if (KEYWORD_STOPWORDS.has(tok)) continue;
    tokens.push(tok);
  }
  return tokens;
}

/**
 * Returns true if two tokens can be considered equivalent. Exact match or
 * prefix relationship (handles simple singular/plural variations like
 * "powerbank" ↔ "powerbanks", "kopfhörer" ↔ "kopfhörern") when both tokens
 * are at least 4 characters long.
 */
function tokensEquivalent(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Ratio of unique tokens from `text` (the product-describing text — typically
 * brand + name) that have an equivalent token in `breadcrumb`. Matching is
 * tolerant to simple singular/plural variants (prefix relationship ≥ 4 chars).
 * Range [0, 1]; returns 0 when the product text is empty (no signal to score
 * against).
 *
 * @param {string} text product-describing text (e.g. name, brand+name, …)
 * @param {string} breadcrumb category breadcrumb ("A > B > C")
 * @returns {number}
 */
function computeKeywordMatch(text, breadcrumb) {
  const productTokens = tokenizeForMatch(text);
  if (!productTokens.length) return 0;
  const crumbTokens = tokenizeForMatch(breadcrumb);
  if (!crumbTokens.length) return 0;
  const uniqueProduct = Array.from(new Set(productTokens));
  let common = 0;
  for (const pt of uniqueProduct) {
    if (crumbTokens.some((ct) => tokensEquivalent(pt, ct))) common += 1;
  }
  return common / uniqueProduct.length;
}

function clamp(value, min, max) {
  const v = Number(value);
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function buildProductText(product) {
  const id = product?.identification || {};
  const parts = [
    safeString(id.name || id.title),
    safeString(product?.details?.short_description),
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Remove brand tokens from text for keyword-match purposes. Brand words can
 * appear coincidentally in unrelated categories (e.g. brand "Anker" in the
 * sailing category "Bootsport > Anker & Festmacher"), which would otherwise
 * cause a false-positive keyword match.
 */
function stripBrandFromText(text, brand) {
  const b = safeString(brand).toLowerCase();
  if (!b || b.length < 2 || b === 'unknown' || b === 'unbekannt') return text;
  const re = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  return String(text || '').replace(re, ' ');
}

function buildKeywordMatchText(product) {
  const id = product?.identification || {};
  const text = buildProductText(product);
  return stripBrandFromText(text, id.brand);
}

function brandOrMpnAppearsIn(product, breadcrumb) {
  const id = product?.identification || {};
  const crumb = String(breadcrumb || '').toLowerCase();
  if (!crumb) return false;
  const candidates = [
    safeString(id.brand),
    safeString(id.mpn),
    safeString(product?.details?.identifiers?.mpn),
  ]
    .map((v) => v && v.toLowerCase().trim())
    .filter((v) => v && v !== 'unknown' && v !== 'unbekannt' && v.length >= 2);
  return candidates.some((v) => crumb.includes(v));
}

function breadcrumbLevel(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'string') return 0;
  return breadcrumb.split('>').map((s) => s.trim()).filter(Boolean).length;
}

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

/**
 * Stricter banned/too-generic breadcrumb check used by the dynamic confidence
 * pipeline. Builds on isBannedEbayBreadcrumb() and additionally rejects:
 *   - breadcrumbs without any ">" separator (single-level)
 *   - leaves that literally read "Sonstige"/"Sonstiges"/"Andere" when
 *     alternatives were available (caller signals via `hasAlternatives`)
 *   - breadcrumbs with ≤2 levels unless the caller flags it as a direct
 *     GTIN match (rare: we trust catalog voting for level-2 paths)
 *
 * @param {string} breadcrumb
 * @param {{ hasAlternatives?: boolean, gtinExactMatch?: boolean }} [opts]
 * @returns {boolean}
 */
function isBannedOrTooGenericBreadcrumb(breadcrumb, opts = {}) {
  if (!breadcrumb || typeof breadcrumb !== 'string') return true;
  if (isBannedEbayBreadcrumb(breadcrumb)) return true;
  if (!breadcrumb.includes('>')) return true;
  const levels = breadcrumbLevel(breadcrumb);
  if (levels < 2) return true;
  const leaf = breadcrumb.split('>').pop().trim().toLowerCase();
  if (opts.hasAlternatives && /^(sonstige|sonstiges|andere|other|misc)$/i.test(leaf)) {
    return true;
  }
  if (levels <= 2 && !opts.gtinExactMatch) {
    return true;
  }
  return false;
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

function buildResult({
  categoryId,
  breadcrumb,
  source,
  confidence,
  alternatives,
  log,
  confidenceBreakdown,
  keywordMatch,
}) {
  return {
    categoryId: String(categoryId),
    breadcrumb: safeString(breadcrumb),
    source,
    confidence: Number(confidence.toFixed(4)),
    alternatives: alternatives && alternatives.length ? alternatives : undefined,
    confidenceBreakdown: confidenceBreakdown || undefined,
    keywordMatch: typeof keywordMatch === 'number' ? Number(keywordMatch.toFixed(4)) : undefined,
    log,
  };
}

function buildBreakdown(base, boosts, penalties, final) {
  return {
    base: Number(base.toFixed(4)),
    boosts: boosts || {},
    penalties: penalties || {},
    final: Number(final.toFixed(4)),
  };
}

/**
 * Strategy 1 confidence: Catalog GTIN voting.
 * Base 0.9 (GTIN-direct is strong); +0.05 if votes≥3; -0.10 if keyword-match<0.3.
 * Cap [0.5, 0.98].
 */
function computeCatalogConfidence(catalogResult, product) {
  const base = 0.9;
  const boosts = {};
  const penalties = {};
  const votes = Number(catalogResult?.votes) || 0;
  if (votes >= 3) boosts.strong_vote_count = 0.05;

  const productText = buildKeywordMatchText(product);
  const km = computeKeywordMatch(productText, catalogResult?.breadcrumb);
  if (km < 0.3) penalties.low_keyword_match = -0.1;

  let final = base;
  for (const v of Object.values(boosts)) final += v;
  for (const v of Object.values(penalties)) final += v;
  final = clamp(final, 0.5, 0.98);
  return { confidence: final, breakdown: buildBreakdown(base, boosts, penalties, final), keywordMatch: km };
}

/**
 * Strategy 2 confidence: Taxonomy suggestions.
 * Base = eBay relevancy (clamped). +0.10 brand/mpn in breadcrumb. -0.15 banned.
 * Cap [0.4, 0.92].
 */
function computeSuggestionConfidence(suggestion, product) {
  const rel = Number(suggestion?.relevancy);
  const base = clamp(Number.isFinite(rel) ? rel : 0, 0, 1);
  const boosts = {};
  const penalties = {};

  if (brandOrMpnAppearsIn(product, suggestion?.breadcrumb)) {
    boosts.brand_or_mpn_in_breadcrumb = 0.1;
  }
  if (isBannedOrTooGenericBreadcrumb(suggestion?.breadcrumb, {
    hasAlternatives: Boolean(suggestion?._hasAlternatives),
    gtinExactMatch: false,
  })) {
    penalties.banned_breadcrumb = -0.15;
  }

  const productText = buildKeywordMatchText(product);
  const km = computeKeywordMatch(productText, suggestion?.breadcrumb);

  let final = base;
  for (const v of Object.values(boosts)) final += v;
  for (const v of Object.values(penalties)) final += v;
  final = clamp(final, 0.4, 0.92);
  return { confidence: final, breakdown: buildBreakdown(base, boosts, penalties, final), keywordMatch: km };
}

/**
 * Strategy 3 confidence: Local breadcrumb lookup.
 * Base 0.6 (no GTIN evidence, only text match).
 *  +0.15 if leaf token-overlap(name) ≥ 30%
 *  +0.10 if brand in breadcrumb
 *  -0.20 if banned/too-generic
 * Cap [0.3, 0.85].
 */
function computeLocalLookupConfidence(breadcrumb, product) {
  const base = 0.6;
  const boosts = {};
  const penalties = {};

  const name = stripBrandFromText(
    safeString(product?.identification?.name || product?.identification?.title),
    product?.identification?.brand,
  );
  const leaf = String(breadcrumb || '').split('>').pop();
  const leafMatch = computeKeywordMatch(name, leaf);
  if (leafMatch >= 0.3) boosts.leaf_keyword_match = 0.15;

  if (brandOrMpnAppearsIn(product, breadcrumb)) {
    boosts.brand_in_breadcrumb = 0.1;
  }

  if (isBannedOrTooGenericBreadcrumb(breadcrumb, { hasAlternatives: false, gtinExactMatch: false })) {
    penalties.banned_breadcrumb = -0.2;
  }

  const productText = buildKeywordMatchText(product);
  const km = computeKeywordMatch(productText, breadcrumb);

  let final = base;
  for (const v of Object.values(boosts)) final += v;
  for (const v of Object.values(penalties)) final += v;
  final = clamp(final, 0.3, 0.85);
  return { confidence: final, breakdown: buildBreakdown(base, boosts, penalties, final), keywordMatch: km };
}

/**
 * Strategy 4 confidence: Gemini fallback.
 * Base 0.55 (LLM-only). Current resolveCategoryWithGemini returns a single
 * pick, so we do NOT apply the multi-candidate boost — base 0.55 already
 * reflects this. +0.10 keyword-match ≥ 0.3. Cap [0.3, 0.8].
 */
function computeGeminiConfidence(breadcrumb, product, ctx = {}) {
  const base = 0.55;
  const boosts = {};
  const penalties = {};

  const productText = buildKeywordMatchText(product);
  const km = computeKeywordMatch(productText, breadcrumb);
  if (km >= 0.3) boosts.keyword_match = 0.1;

  if (ctx.hadAlternatives && ctx.pickedTop) {
    boosts.top_of_multiple = 0.15;
  }

  let final = base;
  for (const v of Object.values(boosts)) final += v;
  for (const v of Object.values(penalties)) final += v;
  final = clamp(final, 0.3, 0.8);
  return { confidence: final, breakdown: buildBreakdown(base, boosts, penalties, final), keywordMatch: km };
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

    let breadcrumb = result.breadcrumb;
    if (!isAcceptableBreadcrumb(breadcrumb, product)) {
      // Try local lookup to enrich/replace breadcrumb if catalog returned only an ID
      const local = findEbayCategory(result.categoryId);
      if (local?.breadcrumb && isAcceptableBreadcrumb(local.breadcrumb, product)) {
        breadcrumb = local.breadcrumb;
      } else {
        appendLog(log, { strategy: 'catalog', rejected: 'breadcrumb_unacceptable', breadcrumb: result.breadcrumb });
        return null;
      }
    }

    if (isDynamicConfidenceEnabled()) {
      const scored = computeCatalogConfidence({ ...result, breadcrumb }, product);
      return {
        categoryId: result.categoryId,
        breadcrumb,
        confidence: scored.confidence,
        confidenceBreakdown: scored.breakdown,
        keywordMatch: scored.keywordMatch,
      };
    }
    return {
      categoryId: result.categoryId,
      breadcrumb,
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

    const hasAlternatives = suggestions.length > 1;
    const pickAcceptable = (s) => ({ ...s, _hasAlternatives: hasAlternatives });

    if (!isAcceptableBreadcrumb(top.breadcrumb, product)) {
      // Try the next best one which is acceptable
      const next = suggestions.find((s) => isAcceptableBreadcrumb(s.breadcrumb, product));
      if (next) {
        const tagged = pickAcceptable(next);
        if (isDynamicConfidenceEnabled()) {
          const scored = computeSuggestionConfidence(tagged, product);
          return {
            categoryId: next.categoryId,
            breadcrumb: next.breadcrumb,
            confidence: scored.confidence,
            confidenceBreakdown: scored.breakdown,
            keywordMatch: scored.keywordMatch,
            alternatives,
          };
        }
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

    const tagged = pickAcceptable(top);
    if (isDynamicConfidenceEnabled()) {
      const scored = computeSuggestionConfidence(tagged, product);
      return {
        categoryId: top.categoryId,
        breadcrumb: top.breadcrumb,
        confidence: scored.confidence,
        confidenceBreakdown: scored.breakdown,
        keywordMatch: scored.keywordMatch,
        alternatives,
      };
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

    if (isDynamicConfidenceEnabled()) {
      const scored = computeLocalLookupConfidence(fullBreadcrumb, product);
      return {
        categoryId: String(id),
        breadcrumb: fullBreadcrumb,
        confidence: scored.confidence,
        confidenceBreakdown: scored.breakdown,
        keywordMatch: scored.keywordMatch,
      };
    }
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

    if (isDynamicConfidenceEnabled()) {
      const scored = computeGeminiConfidence(breadcrumb, product, {
        hadAlternatives: Array.isArray(g.alternatives) && g.alternatives.length > 0,
        pickedTop: true,
      });
      return {
        categoryId: String(g.id),
        breadcrumb,
        confidence: scored.confidence,
        confidenceBreakdown: scored.breakdown,
        keywordMatch: scored.keywordMatch,
      };
    }
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
 * @returns {Promise<{ categoryId: string, breadcrumb: string, source: 'catalog'|'suggestions'|'local'|'gemini', confidence: number, confidenceBreakdown?: object, keywordMatch?: number, alternatives?: Array, log: Array } | null>}
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
      confidenceBreakdown: result.confidenceBreakdown,
      keywordMatch: result.keywordMatch,
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
  computeKeywordMatch,
  computeCatalogConfidence,
  computeSuggestionConfidence,
  computeLocalLookupConfidence,
  computeGeminiConfidence,
  isBannedOrTooGenericBreadcrumb,
  // exposed for tests
  _internal: {
    pickPrimaryGtin,
    buildSuggestionQuery,
    isAcceptableBreadcrumb,
    isDynamicConfidenceEnabled,
  },
};
