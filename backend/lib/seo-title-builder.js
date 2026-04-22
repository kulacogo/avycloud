'use strict';

/**
 * seo-title-builder.js
 *
 * Schema-based eBay + Kaufland title builder. Produces mobile-optimized,
 * keyword-rich product titles with competitor-keyword mining.
 *
 * Design principles:
 *   - Mobile-First: the most important keywords MUST be in the first 65 chars
 *     (eBay's mobile grid-view cuts there).
 *   - Schema: [Brand] [Product-Type] [Model] [Differentiator] [Key-Specs] [Condition]
 *   - Competitor Keywords: mine the top-12 tokens from competitor titles in
 *     the same category and inject the top-3 that are not yet in the title.
 *   - Marketplace-specific caps: eBay 80 chars, Kaufland 150 chars.
 *   - Reuses `coerceTitleToPolicy()` from title-policy.js as a final sanitizer.
 *
 * Pure function (no I/O). Caller provides competitor keywords (already mined).
 */

const { coerceTitleToPolicy } = require('./title-policy');

const EBAY_TITLE_MAX = 80;
const KAUFLAND_TITLE_MAX = 150;
const MOBILE_FIRST_WINDOW = 65;

const EBAY_TITLE_SCHEMA = Object.freeze([
  'brand',
  'productType',
  'model',
  'differentiator',
  'keySpec',
  'condition',
]);

// Tokens that should never appear in titles
const TITLE_BAD_PREFIXES = Object.freeze([
  /^\s*neu[:\s]/i,
  /^\s*top[:\s]/i,
  /^\s*angebot[:\s]/i,
  /^\s*premium[:\s]/i,
  /^\s*original[:\s]/i,
  /^\s*rabatt[:\s]/i,
]);

// Stopwords for Jaccard-keyword-overlap scoring
const STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'oder', 'mit', 'ohne', 'für', 'fuer', 'neu',
  'new', 'original', 'top', 'super', 'premium', 'sale', 'angebot', 'the',
  'and', 'or', 'with', 'without', 'for', 'in', 'on', 'of', 'a', 'an', 'to',
  'von', 'zu', 'bei', 'aus', 'ab', 'auf', 'des', 'den', 'dem',
]);

function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function nonStopTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length >= 2);
}

function pickBestKeywords(competitorKeywords = [], existingText = '', limit = 3) {
  if (!Array.isArray(competitorKeywords)) return [];
  const existingTokens = new Set(nonStopTokens(existingText));

  const candidates = competitorKeywords
    .map((kw) => {
      if (typeof kw === 'string') return { token: kw.toLowerCase(), weight: 1 };
      if (kw && typeof kw === 'object') {
        return {
          token: String(kw.token || kw.word || '').toLowerCase(),
          weight: Number(kw.coverage || kw.weight || kw.count || 1),
        };
      }
      return null;
    })
    .filter((c) => c && c.token && !STOPWORDS.has(c.token) && c.token.length >= 2)
    .filter((c) => !existingTokens.has(c.token))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((c) => c.token);

  return candidates;
}

function capitalizeFirstLetter(token) {
  if (!token) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function pruneDoubleSpaces(str) {
  return String(str).replace(/\s+/g, ' ').trim();
}

function stripBadPrefixes(title) {
  let out = title;
  for (const pattern of TITLE_BAD_PREFIXES) {
    out = out.replace(pattern, '').trim();
  }
  return out;
}

/**
 * Joins the schema parts into a single title candidate.
 * Drops empty parts, separates with single spaces, no trailing punctuation.
 */
function composeFromSchema(parts) {
  const ordered = [];
  for (const field of EBAY_TITLE_SCHEMA) {
    const val = safeString(parts[field]);
    if (val) ordered.push(val);
  }
  return pruneDoubleSpaces(ordered.join(' '));
}

/**
 * Truncates the title to maxLen, preserving word boundaries where possible.
 * Never cuts mid-word unless that would produce an empty string.
 */
function safeTruncate(title, maxLen) {
  const str = pruneDoubleSpaces(title);
  if (str.length <= maxLen) return str;
  const cut = str.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= maxLen * 0.7) {
    return cut.slice(0, lastSpace).replace(/[\s,;:.-]+$/, '');
  }
  return cut.replace(/[\s,;:.-]+$/, '');
}

/**
 * buildEbayTitle(parts, options)
 *
 * parts: {
 *   brand, productType, model, differentiator, keySpec, condition,
 *   competitorKeywords?  (Array of string | {token, coverage})
 * }
 *
 * options: {
 *   marketplace?: 'EBAY_DE' | 'KAUFLAND_DE'
 *   maxLen?: number (overrides marketplace default)
 *   mobileFirstWindow?: number (default 65)
 *   injectCompetitorKeywords?: boolean (default true)
 *   inferTitleCategory?: string (passed through to coerceTitleToPolicy)
 * }
 *
 * Returns:
 * {
 *   title: string,
 *   mobilePreview: string,           // first N chars
 *   chars: number,
 *   injectedKeywords: string[],
 *   warnings: string[],
 *   score: { overall, mobileCoverage, keywordMatch, readability }
 * }
 */
function buildEbayTitle(parts = {}, options = {}) {
  const {
    marketplace = 'EBAY_DE',
    maxLen = marketplace === 'KAUFLAND_DE' ? KAUFLAND_TITLE_MAX : EBAY_TITLE_MAX,
    mobileFirstWindow = MOBILE_FIRST_WINDOW,
    injectCompetitorKeywords = true,
    inferTitleCategory = '',
  } = options;

  const warnings = [];

  const schema = {
    brand: safeString(parts.brand),
    productType: safeString(parts.productType),
    model: safeString(parts.model),
    differentiator: safeString(parts.differentiator),
    keySpec: safeString(parts.keySpec),
    condition: safeString(parts.condition),
  };

  if (!schema.brand) warnings.push('missing_brand');
  if (!schema.model && !schema.productType) warnings.push('missing_model_and_product_type');

  let composed = composeFromSchema(schema);
  composed = stripBadPrefixes(composed);

  const injected = [];
  if (injectCompetitorKeywords && Array.isArray(parts.competitorKeywords)) {
    const available = maxLen - composed.length - 1;
    if (available > 10) {
      const kws = pickBestKeywords(parts.competitorKeywords, composed, 3);
      for (const kw of kws) {
        const pretty = capitalizeFirstLetter(kw);
        const candidate = pruneDoubleSpaces(`${composed} ${pretty}`);
        if (candidate.length <= maxLen) {
          composed = candidate;
          injected.push(pretty);
        }
      }
    }
  }

  let title = safeTruncate(composed, maxLen);

  // coerceTitleToPolicy(product, proposedTitle, options): product may be null,
  // forcePolicy defaults to false → passthrough mode with light sanitization
  // (emoji/markdown/sku-noise strip + truncate). Ideal for seo-title-builder.
  try {
    const coerced = coerceTitleToPolicy(null, title, { maxLen, forcePolicy: false });
    if (typeof coerced === 'string' && coerced.trim()) {
      title = coerced;
    }
  } catch (err) {
    warnings.push(`coerceTitleToPolicy_failed: ${err.message}`);
  }

  title = pruneDoubleSpaces(title).slice(0, maxLen);

  const mobilePreview = title.slice(0, mobileFirstWindow);

  const score = scoreTitleQuality(title, {
    brand: schema.brand,
    productType: schema.productType,
    model: schema.model,
    competitorKeywords: parts.competitorKeywords || [],
    mobileFirstWindow,
  });

  return {
    title,
    mobilePreview,
    chars: title.length,
    injectedKeywords: injected,
    warnings,
    score,
  };
}

/**
 * scoreTitleQuality(title, context) → {overall, mobileCoverage, keywordMatch, readability}
 */
function scoreTitleQuality(title, context = {}) {
  const { brand = '', productType = '', model = '', competitorKeywords = [], mobileFirstWindow = MOBILE_FIRST_WINDOW } = context;

  if (!title) {
    return { overall: 0, mobileCoverage: 0, keywordMatch: 0, readability: 0 };
  }

  const lower = title.toLowerCase();
  const firstWindow = lower.slice(0, mobileFirstWindow);

  // 1. Mobile coverage: ist brand + (model|productType) im First-Window?
  let mobileCoverage = 0;
  if (brand && firstWindow.includes(brand.toLowerCase())) mobileCoverage += 0.5;
  if (model && firstWindow.includes(model.toLowerCase())) mobileCoverage += 0.5;
  else if (productType && firstWindow.includes(productType.toLowerCase())) mobileCoverage += 0.3;
  mobileCoverage = Math.min(mobileCoverage, 1);

  // 2. Keyword match: Jaccard overlap mit Top-Competitor-Keywords
  const titleTokens = new Set(nonStopTokens(title));
  const compTokenList = (competitorKeywords || []).map((kw) => {
    if (typeof kw === 'string') return kw.toLowerCase();
    if (kw && typeof kw === 'object') return String(kw.token || kw.word || '').toLowerCase();
    return '';
  }).filter(Boolean).slice(0, 12);
  const compTokens = new Set(compTokenList);

  let keywordMatch = 0;
  if (compTokens.size > 0) {
    let hits = 0;
    for (const t of compTokens) if (titleTokens.has(t)) hits += 1;
    keywordMatch = hits / compTokens.size;
  }

  // 3. Readability: keine all-caps runs > 3 tokens, keine doppelten spaces,
  //    Länge sinnvoll (>20 && <=80 für eBay)
  let readability = 1;
  const upperRuns = title.split(/\s+/).filter((t) => t.length >= 2 && t === t.toUpperCase()).length;
  if (upperRuns > 3) readability -= 0.2;
  if (title.length < 20) readability -= 0.3;
  if (title.length > EBAY_TITLE_MAX) readability -= 0.2;
  if (/\s{2,}/.test(title)) readability -= 0.1;
  readability = Math.max(readability, 0);

  const overall =
    mobileCoverage * 0.5 +
    keywordMatch * 0.3 +
    readability * 0.2;

  return {
    overall: Math.round(overall * 100) / 100,
    mobileCoverage: Math.round(mobileCoverage * 100) / 100,
    keywordMatch: Math.round(keywordMatch * 100) / 100,
    readability: Math.round(readability * 100) / 100,
  };
}

module.exports = {
  EBAY_TITLE_MAX,
  KAUFLAND_TITLE_MAX,
  MOBILE_FIRST_WINDOW,
  EBAY_TITLE_SCHEMA,
  buildEbayTitle,
  scoreTitleQuality,
  pickBestKeywords,
  _internal: {
    tokenize,
    nonStopTokens,
    composeFromSchema,
    safeTruncate,
    stripBadPrefixes,
    pruneDoubleSpaces,
  },
};
