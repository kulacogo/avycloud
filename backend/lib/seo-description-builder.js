'use strict';

/**
 * seo-description-builder.js
 *
 * Template-based HTML description builder for eBay + Kaufland.
 *
 * Produces a mobile-first, responsive, SEO-friendly product description
 * with deterministic sections:
 *
 *   <section class="hero"><p>Intro</p></section>
 *   <section class="features"><ul><li>…</li></ul></section>
 *   <section class="specs"><table>…</table></section>
 *   <section class="condition"><p>…</p></section>
 *   <section class="gpsr"><p>Hersteller + Adresse + Email</p></section>
 *
 * Plus helper functions for TF-IDF-style keyword-density scoring.
 *
 * Pure function. No I/O. Reuses sanitizeDescriptionToHtml for final cleaning.
 */

const EBAY_HARD_MAX = 500000; // eBay accepts very long descriptions
const EBAY_RECOMMENDED_MAX = 3000;
const MIN_VISIBLE_CHARS = 320;

const HTML_DESCRIPTION_TEMPLATE = Object.freeze({
  sections: ['hero', 'features', 'specs', 'condition', 'gpsr'],
});

// Stopwords for keyword density scoring (German + English common terms)
const DENSITY_STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'oder', 'mit', 'ohne', 'für', 'fuer', 'im', 'am',
  'in', 'an', 'auf', 'zu', 'von', 'bei', 'aus', 'ab', 'the', 'a', 'an', 'and',
  'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'is', 'are', 'wir', 'sie',
  'er', 'es', 'ist', 'hat', 'habe', 'sein', 'werden', 'ihre', 'ihr', 'sein',
]);

function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * computeKeywordDensity(htmlText, keywords) → { perKeyword: {kw: density}, overall }
 *
 * density = occurrence_count / total_content_tokens
 * overall = sum over keywords (capped at 0.2 for UI display, raw ≤ 1.0)
 */
function computeKeywordDensity(htmlText, keywords = []) {
  const tokens = tokenize(htmlText).filter((t) => !DENSITY_STOPWORDS.has(t));
  const total = tokens.length;

  if (!total) {
    return { perKeyword: {}, overall: 0, totalTokens: 0 };
  }

  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  const perKeyword = {};
  let overall = 0;
  for (const raw of keywords) {
    const kw = String(raw || '').toLowerCase().trim();
    if (!kw || DENSITY_STOPWORDS.has(kw)) continue;
    const count = freq.get(kw) || 0;
    const density = count / total;
    perKeyword[kw] = Math.round(density * 1000) / 1000;
    overall += density;
  }

  return {
    perKeyword,
    overall: Math.round(overall * 1000) / 1000,
    totalTokens: total,
  };
}

// -------- SECTION BUILDERS --------

function buildHeroSection({ brand, title, productType, shortDescription } = {}) {
  const parts = [];
  if (shortDescription) {
    parts.push(escapeHtml(shortDescription));
  } else {
    const b = escapeHtml(brand || '');
    const pt = escapeHtml(productType || '');
    const t = escapeHtml(title || '');
    if (b && pt) parts.push(`${b} ${pt}${t ? ` — ${t}` : ''}.`);
    else if (t) parts.push(`${t}.`);
  }
  if (!parts.length) return '';
  return `<section class="hero"><p>${parts.join(' ')}</p></section>`;
}

function buildFeaturesSection(features = []) {
  const items = (Array.isArray(features) ? features : [])
    .map(safeString)
    .filter(Boolean)
    .slice(0, 12);
  if (!items.length) return '';
  const lis = items.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  return `<section class="features"><ul>${lis}</ul></section>`;
}

function buildSpecsSection(aspects = []) {
  const list = Array.isArray(aspects) ? aspects : Object.entries(aspects || {}).map(([k, v]) => ({ key: k, value: v }));
  const cleaned = list
    .map((a) => ({
      key: safeString(a?.key ?? a?.name),
      value: safeString(a?.value),
    }))
    .filter((a) => a.key && a.value)
    .slice(0, 20);
  if (!cleaned.length) return '';
  const rows = cleaned
    .map((a) => `<tr><th>${escapeHtml(a.key)}</th><td>${escapeHtml(a.value)}</td></tr>`)
    .join('');
  return `<section class="specs"><table><tbody>${rows}</tbody></table></section>`;
}

function buildConditionSection(condition) {
  if (!condition) return '';
  const val = safeString(condition);
  return `<section class="condition"><p>Zustand: <strong>${escapeHtml(val)}</strong></p></section>`;
}

function buildGpsrSection(gpsr = {}) {
  if (!gpsr || typeof gpsr !== 'object') return '';
  const name = safeString(gpsr.manufacturer_name);
  const address = safeString(gpsr.manufacturer_address);
  const email = safeString(gpsr.email || gpsr.manufacturer_email);
  const url = safeString(gpsr.url || gpsr.manufacturer_url);
  if (!name && !address && !email && !url) return '';
  const lines = [];
  if (name) lines.push(`<strong>Hersteller:</strong> ${escapeHtml(name)}`);
  if (address) lines.push(escapeHtml(address));
  if (email) lines.push(`E-Mail: ${escapeHtml(email)}`);
  if (url) lines.push(`Web: ${escapeHtml(url)}`);
  return `<section class="gpsr"><p>${lines.join('<br>')}</p></section>`;
}

/**
 * buildEbayDescription({ productData, keyFeatures, aspects, gpsr, locale, marketplace })
 *
 * Returns:
 *   {
 *     html: string,
 *     length: number,
 *     sectionsPresent: string[],
 *     keywordDensity: { perKeyword, overall, totalTokens },
 *     warnings: string[]
 *   }
 */
function buildEbayDescription(input = {}) {
  const {
    productData = {},
    keyFeatures = [],
    aspects = [],
    gpsr = {},
    marketplace = 'EBAY_DE',
    seoKeywords = [],
    maxLen = EBAY_RECOMMENDED_MAX,
  } = input;

  const warnings = [];

  const sections = {
    hero: buildHeroSection({
      brand: productData.brand,
      title: productData.title,
      productType: productData.productType,
      shortDescription: productData.short_description,
    }),
    features: buildFeaturesSection(keyFeatures),
    specs: buildSpecsSection(aspects),
    condition: buildConditionSection(productData.condition || 'Neu'),
    gpsr: buildGpsrSection(gpsr),
  };

  const sectionsPresent = HTML_DESCRIPTION_TEMPLATE.sections.filter(
    (name) => sections[name] && sections[name].length > 0
  );

  if (!sectionsPresent.includes('hero')) warnings.push('missing_hero');
  if (!sectionsPresent.includes('features')) warnings.push('missing_features');
  if (!sectionsPresent.includes('gpsr')) warnings.push('missing_gpsr');

  const rawHtml = HTML_DESCRIPTION_TEMPLATE.sections
    .map((name) => sections[name])
    .filter(Boolean)
    .join('\n');

  // Length enforcement: soft cap via maxLen, hard cap via EBAY_HARD_MAX.
  // Content is already HTML-escaped during section building, no XSS risk.
  // We deliberately DON'T pipe through listing-sanitize.js because that
  // strips our structured <section>/<table>/<ul> markup and rebuilds plain
  // <p>-tags from flattened sentences. For template-HTML that's destructive.
  const effectiveMax = Math.min(Number(maxLen) || EBAY_RECOMMENDED_MAX, EBAY_HARD_MAX);
  let finalHtml = rawHtml;
  if (finalHtml.length > effectiveMax) {
    finalHtml = finalHtml.slice(0, effectiveMax);
    warnings.push('truncated_to_maxLen');
  }

  const keywordDensity = computeKeywordDensity(finalHtml, seoKeywords);

  // Flag under-density warning when keywords provided but overall density < 0.5%
  if (seoKeywords.length > 0 && keywordDensity.overall < 0.005) {
    warnings.push('low_keyword_density');
  }

  return {
    html: finalHtml,
    length: finalHtml.length,
    sectionsPresent,
    keywordDensity,
    warnings,
    marketplace,
  };
}

module.exports = {
  EBAY_HARD_MAX,
  EBAY_RECOMMENDED_MAX,
  MIN_VISIBLE_CHARS,
  HTML_DESCRIPTION_TEMPLATE,
  buildEbayDescription,
  computeKeywordDensity,
  _internal: {
    tokenize,
    escapeHtml,
    buildHeroSection,
    buildFeaturesSection,
    buildSpecsSection,
    buildConditionSection,
    buildGpsrSection,
  },
};
