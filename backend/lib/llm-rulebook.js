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
const { sanitizeDescriptionToHtml } = require('./listing-sanitize');
const { normalizeHighlightsStrict } = require('./highlights-policy');
const { canonicalizeAttributesStrict } = require('./attribute-policy');
const { getRulebookConfigCached } = require('./rulebook-config');

function isRulebookDisabled() {
  // Default: disabled (user request: "keine Regeln").
  // Opt-in only via RULEBOOK_ENABLED=true
  const enabled = (process.env.RULEBOOK_ENABLED || '').toString().trim().toLowerCase();
  return !(enabled === '1' || enabled === 'true' || enabled === 'yes');
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
      next.details.short_description = sanitizeDescriptionToHtml(next.details.short_description, {
        maxLen: 3000,
        minVisibleChars: 240,
      });
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
    minLen: titleMinLen,
    maxLen: titleMaxLen,
    softMaxLen: titleSoftMax,
  });
  const titleIssues =
    validateTitleToPolicy(next, coercedTitle, { minLen: titleMinLen, maxLen: titleMaxLen, mobileMaxLen: titleMobileMax }) || [];
  if (Array.isArray(titleIssues) && titleIssues.length) {
    issues.push(...titleIssues.map((x) => `title:${x}`));
  }

  // 2) Description sanitize (delete-only)
  if (typeof next.details.short_description === 'string') {
    next.details.short_description = sanitizeDescriptionToHtml(next.details.short_description, {
      maxLen: 3000,
      minVisibleChars: 240,
    });
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
      next.details.short_description = sanitizeDescriptionToHtml(next.details.short_description, {
        maxLen: 3000,
        minVisibleChars: 240,
      });
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
    minLen: titleMinLen,
    maxLen: titleMaxLen,
    softMaxLen: titleSoftMax,
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
    next.details.short_description = sanitizeDescriptionToHtml(next.details.short_description, {
      maxLen: 3000,
      minVisibleChars: 240,
    });
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

  return { ok: true, product: next, issues: Array.from(new Set(issues)), source };
}

module.exports = {
  normalizeProductStrict,
  normalizeProductForPolicyApply,
};

