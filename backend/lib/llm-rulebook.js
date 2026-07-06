/* eslint-disable no-console */
/**
 * Single, mandatory rulebook for ALL LLM outputs (Identify / Improve / Chat) and
 * for any downstream sync where deviations must never be propagated.
 *
 * Source-of-truth inputs:
 * - Titel_Regeln.csv (title schema & priorities)
 * - Highlights_Regeln.csv (bullets count/length/template)
 *
 * Enforced in code:
 * - Title: backend/lib/title-policy.js (coerce + validate)
 * - Highlights: backend/lib/highlights-policy.js (strict)
 * - Attributes: backend/lib/attribute-policy.js (strict canonicalization, no semantic duplicates)
 */

const { coerceTitleToPolicy, validateTitleToPolicy } = require('./title-policy');
const { sanitizeDescriptionProse } = require('./listing-sanitize');
const { normalizeHighlightsStrict } = require('./highlights-policy');
const { canonicalizeAttributesStrict } = require('./attribute-policy');
const { getRulebookConfigCached } = require('./rulebook-config');

function isRulebookDisabled() {
  // Default: enabled. Opt-out via RULEBOOK_ENABLED=false
  const val = (process.env.RULEBOOK_ENABLED || 'true').toString().trim().toLowerCase();
  return val === '0' || val === 'false' || val === 'no';
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

/**
 * Validate + normalize product fields according to rulebook.
 * - No "best effort": if strict checks fail, returns ok=false and does NOT return a modified product.
 */
function normalizeProductStrict(product, { source = 'unknown' } = {}) {
  if (isRulebookDisabled()) {
    // Minimal delete-only sanitization (still useful to prevent storing obvious placeholders/prices).
    const next = deepClone(product);
    next.identification = next.identification || {};
    next.details = next.details || {};
    if (typeof next.details.short_description === 'string') {
      next.details.short_description = sanitizeDescriptionProse(next.details.short_description, { maxLen: 3000 });
    }
    return { ok: true, product: next, issues: [], source };
  }
  const issues = [];
  const next = deepClone(product);
  const cfg = getRulebookConfigCached();

  next.identification = next.identification || {};
  next.details = next.details || {};

  // 1) Title policy (per Titel-Kategorie bucket)
  const { inferTitleCategory } = require('./title-policy');
  const currentTitle = safeString(next.identification.name);
  const bucket = inferTitleCategory(next);
  const bySchema = cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
  const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
  const titleMinLen = Number(rule?.minLen || 65);
  const titleMaxLen = Number(rule?.maxLen || 80);
  const titleSoftMax = Number(rule?.softMaxLen || 75);
  const titleMobileMax = Number(rule?.mobileMaxLen || 60);
  const coercedTitle = coerceTitleToPolicy(next, currentTitle, {
    minLen: 0,
    maxLen: titleMaxLen,
    softMaxLen: titleSoftMax,
    forcePolicy: false,
  });
  const titleIssues =
    validateTitleToPolicy(next, coercedTitle, { minLen: titleMinLen, maxLen: titleMaxLen, mobileMaxLen: titleMobileMax }) || [];
  if (Array.isArray(titleIssues) && titleIssues.length) {
    issues.push(...titleIssues.map((x) => `title:${x}`));
  }

  // 2) Description sanitize (delete-only)
  if (typeof next.details.short_description === 'string') {
    next.details.short_description = sanitizeDescriptionProse(next.details.short_description, { maxLen: 3000 });
  }

  // 3) Highlights strict
  const hi = normalizeHighlightsStrict(next, Array.isArray(next.details.key_features) ? next.details.key_features : []);
  if (!hi.ok) {
    issues.push(...hi.issues.map((x) => `highlights:${x}`));
  }

  // 4) Attributes strict canonicalization (only applies to object map attributes)
  if (next.details.attributes && typeof next.details.attributes === 'object' && !Array.isArray(next.details.attributes)) {
    const ca = canonicalizeAttributesStrict(next.details.attributes);
    if (!ca.ok) {
      issues.push(...ca.issues.map((x) => `attributes:${x}`));
    }
  }

  if (issues.length) {
    return { ok: false, issues: Array.from(new Set(issues)), source };
  }

  // Apply normalized values only after we know we're valid.
  next.identification.name = coercedTitle;
  next.details.key_features = hi.highlights;
  if (next.details.attributes && typeof next.details.attributes === 'object' && !Array.isArray(next.details.attributes)) {
    next.details.attributes = canonicalizeAttributesStrict(next.details.attributes).attributes;
  }

  return { ok: true, product: next, issues: [], source };
}

/**
 * Policy apply (best-effort but non-speculative):
 * - Always coerce title via title-policy (even if other parts are invalid).
 * - Highlights/attributes are only applied when their strict normalizers succeed.
 * - Returns issues per section for reporting and for data-quality dashboards.
 *
 * This is intended for bulk runs (rulebook apply runner) where we prefer
 * incremental improvements over "all-or-nothing" strict rejection.
 */
function normalizeProductForPolicyApply(product, { source = 'unknown' } = {}) {
  if (isRulebookDisabled()) {
    // Minimal delete-only sanitization, no coercion/validation.
    const next = deepClone(product);
    next.identification = next.identification || {};
    next.details = next.details || {};
    if (typeof next.details.short_description === 'string') {
      next.details.short_description = sanitizeDescriptionProse(next.details.short_description, { maxLen: 3000 });
    }
    return { ok: true, product: next, issues: [], source };
  }
  const issues = [];
  const next = deepClone(product);
  const cfg = getRulebookConfigCached();

  next.identification = next.identification || {};
  next.details = next.details || {};

  // Title policy (per Titel-Kategorie bucket)
  const { inferTitleCategory } = require('./title-policy');
  const currentTitle = safeString(next.identification.name);
  const bucket = inferTitleCategory(next);
  const bySchema =
    cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
  const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
  const titleMinLen = Number(rule?.minLen || 65);
  const titleMaxLen = Number(rule?.maxLen || 80);
  const titleSoftMax = Number(rule?.softMaxLen || 75);
  const titleMobileMax = Number(rule?.mobileMaxLen || 60);

  const coercedTitle = coerceTitleToPolicy(next, currentTitle, {
    minLen: 0,
    maxLen: titleMaxLen,
    softMaxLen: titleSoftMax,
    forcePolicy: false,
  });
  const titleIssues =
    validateTitleToPolicy(next, coercedTitle, { minLen: titleMinLen, maxLen: titleMaxLen, mobileMaxLen: titleMobileMax }) || [];
  if (Array.isArray(titleIssues) && titleIssues.length) {
    issues.push(...titleIssues.map((x) => `title:${x}`));
  }
  // Apply title regardless; if still invalid we keep issues so it shows up in dashboards.
  next.identification.name = coercedTitle;

  // Description sanitize (delete-only)
  if (typeof next.details.short_description === 'string') {
    next.details.short_description = sanitizeDescriptionProse(next.details.short_description, { maxLen: 3000 });
  }

  // Highlights strict (apply only when valid)
  const hi = normalizeHighlightsStrict(next, Array.isArray(next.details.key_features) ? next.details.key_features : []);
  if (!hi.ok) {
    issues.push(...hi.issues.map((x) => `highlights:${x}`));
  } else {
    next.details.key_features = hi.highlights;
  }

  // Attributes strict canonicalization (apply only when valid)
  if (next.details.attributes && typeof next.details.attributes === 'object' && !Array.isArray(next.details.attributes)) {
    const ca = canonicalizeAttributesStrict(next.details.attributes);
    if (!ca.ok) {
      issues.push(...ca.issues.map((x) => `attributes:${x}`));
    } else {
      next.details.attributes = ca.attributes;
    }
  }

  // Keyword-Density Check (warn only, best-effort)
  try {
    const desc = next?.details?.short_description || '';
    const title = next?.identification?.name || '';
    const brand = next?.identification?.brand || '';
    if (desc && title) {
      const visibleText = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const words = visibleText.split(/\s+/).filter(Boolean);
      if (words.length >= 50) {
        const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const brandLower = brand.toLowerCase();
        const searchTerms = titleWords.filter(w => w !== brandLower);
        const textLower = visibleText.toLowerCase();
        let keywordHits = 0;
        for (const term of searchTerms) {
          const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          keywordHits += (textLower.match(regex) || []).length;
        }
        const density = keywordHits / words.length;
        if (density < 0.03) {
          issues.push(`keyword-density:niedrig (${(density * 100).toFixed(1)}%). Empfohlen: 5-7% fuer eBay Cassini.`);
        }
      }
    }
  } catch { /* best-effort */ }

  // Benefits-Format Check (warn only, best-effort)
  try {
    const highlights = next?.details?.key_features || [];
    if (highlights.length >= 3) {
      const benefitIndicators = [' \u2013 ', ' \u2014 ', ' - ', ' fuer ', ' damit ', ' dank ', ' sorgt ', ' ermoeglicht ', ' bietet '];
      const benefitCount = highlights.filter(h =>
        typeof h === 'string' && benefitIndicators.some(ind => h.toLowerCase().includes(ind))
      ).length;
      if (benefitCount < Math.ceil(highlights.length * 0.4)) {
        issues.push(`highlights:benefits-format nur ${benefitCount}/${highlights.length}. Empfohlen: mindestens 50%.`);
      }
    }
  } catch { /* best-effort */ }

  return { ok: true, product: next, issues: Array.from(new Set(issues)), source };
}

module.exports = {
  normalizeProductStrict,
  normalizeProductForPolicyApply,
  isRulebookDisabled,
};

