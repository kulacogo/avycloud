/* eslint-disable no-console */
/**
 * Highlights (bullet points) policy for AvyCloud.
 *
 * Source-of-truth: Highlights_Regeln.csv (user-provided).
 *
 * Goals (strict):
 * - Category-aware bullet count + length bounds.
 * - No duplicates.
 * - No banned/placeholder/pricing text.
 * - Enforce "[Benefit] – [Spec]" style via dash separator to avoid fluffy one-liners.
 */

const { containsBannedListingText, sanitizeHighlights } = require('./listing-sanitize');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function inferSchemaId(product) {
  const categoryRaw = safeString(product?.identification?.category);
  const category = categoryRaw.toLowerCase();

  if (category.includes('auto') || category.includes('kfz') || category.includes('motorrad') || category.includes('fahrzeug')) {
    return 'auto_parts';
  }
  if (category.includes('mode') || category.includes('bekleidung') || category.includes('kleidung')) {
    return 'fashion';
  }
  if (category.includes('schuhe') || category.includes('shoe') || category.includes('accessoire') || category.includes('tasche')) {
    return 'shoes_accessories';
  }
  if (category.includes('elektronik') || category.includes('computer') || category.includes('laptop') || category.includes('notebook') || category.includes('pc')) {
    return 'electronics_computer';
  }
  if (category.includes('haus') || category.includes('garten') || category.includes('baumarkt')) {
    return 'home_garden';
  }
  if (category.includes('küche') || category.includes('kueche') || category.includes('haushalt')) {
    return 'kitchen_household';
  }
  if (category.includes('beauty') || category.includes('kosmetik') || category.includes('pflege')) {
    return 'beauty';
  }
  if (category.includes('sport') || category.includes('freizeit')) {
    return 'sport';
  }
  if (category.includes('spielzeug') || category.includes('baby')) {
    return 'toys_baby';
  }
  if (category.includes('büro') || category.includes('buero') || category.includes('schreibwaren')) {
    return 'office';
  }
  if (category.includes('beleuchtung') || category.includes('elektromaterial') || category.includes('lampe')) {
    return 'lighting';
  }
  if (category.includes('bücher') || category.includes('buch') || category.includes('medien')) {
    return 'books_media';
  }
  return 'generic';
}

const RULES_BY_SCHEMA = {
  electronics_computer: { min: 4, max: 6, minLen: 80, maxLen: 120 },
  auto_parts: { min: 4, max: 5, minLen: 70, maxLen: 110 },
  fashion: { min: 4, max: 5, minLen: 70, maxLen: 100 },
  shoes_accessories: { min: 4, max: 5, minLen: 70, maxLen: 100 },
  home_garden: { min: 4, max: 6, minLen: 80, maxLen: 120 },
  kitchen_household: { min: 4, max: 5, minLen: 70, maxLen: 100 },
  beauty: { min: 4, max: 5, minLen: 70, maxLen: 100 },
  sport: { min: 4, max: 5, minLen: 70, maxLen: 100 },
  toys_baby: { min: 4, max: 6, minLen: 70, maxLen: 100 },
  office: { min: 3, max: 5, minLen: 70, maxLen: 100 },
  lighting: { min: 4, max: 5, minLen: 70, maxLen: 110 },
  books_media: { min: 3, max: 5, minLen: 70, maxLen: 100 },
  generic: { min: 4, max: 6, minLen: 70, maxLen: 110 },
};

function hasDashSeparator(text) {
  const t = safeString(text);
  if (!t) return false;
  // Accept hyphen or en-dash, require spaces to avoid "ABC-123" model numbers counting.
  return /\s[–-]\s/.test(t);
}

function normalizeHighlightsStrict(product, list) {
  const schemaId = inferSchemaId(product);
  const rules = RULES_BY_SCHEMA[schemaId] || RULES_BY_SCHEMA.generic;
  const issues = [];

  // First pass: basic cleaning (no placeholders/prices, basic dedupe, max count cap).
  const sanitized = sanitizeHighlights(Array.isArray(list) ? list : [], {
    minLen: 8,
    maxItems: Math.max(10, rules.max + 2),
  }).map((x) => normalizeSpaces(x));

  // Validate each bullet strictly.
  const kept = [];
  const seen = new Set();
  for (const raw of sanitized) {
    const v = normalizeSpaces(raw);
    if (!v) continue;
    if (containsBannedListingText(v)) {
      issues.push('highlight_banned_text');
      continue;
    }
    const key = v.toLowerCase();
    if (seen.has(key)) {
      issues.push('highlight_duplicate');
      continue;
    }
    seen.add(key);
    if (!hasDashSeparator(v)) {
      issues.push('highlight_missing_dash_template');
      continue;
    }
    if (v.length < rules.minLen) {
      issues.push('highlight_too_short');
      continue;
    }
    if (v.length > rules.maxLen) {
      issues.push('highlight_too_long');
      continue;
    }
    kept.push(v);
    if (kept.length >= rules.max) break;
  }

  if (kept.length < rules.min) {
    issues.push('highlights_too_few');
  }

  return {
    ok: issues.length === 0,
    schemaId,
    highlights: kept,
    rules,
    issues: Array.from(new Set(issues)),
  };
}

module.exports = {
  normalizeHighlightsStrict,
  inferHighlightsSchemaId: inferSchemaId,
};

