/**
 * Canonicalization for BaseLinker inventory category paths.
 *
 * Goal:
 * - Collapse known duplicate roots / naming variants into a single canonical taxonomy.
 * - Keep rules conservative: mostly prefix/root rewrites + a few safe aliases.
 *
 * This is used in:
 * - Sync to BaseLinker (prevent creating new duplicates)
 * - Import from BaseLinker (store canonical breadcrumb)
 * - Category cleanup scripts (semantic merge)
 */

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(text = '') {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[\u2010-\u2015]/g, '-') // dash variants
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBreadcrumb(breadcrumb) {
  return safeString(breadcrumb)
    .split('>')
    .map((s) => normalizeSpaces(s))
    .filter(Boolean);
}

// Prefix rewrite rules: match the FIRST segments and replace with a canonical prefix.
// IMPORTANT: match keys are normalized via normalizeForMatch().
const PREFIX_RULES = [
  // Auto roots: unify colon variants.
  { match: ['auto und motorrad: teile'], replace: ['Auto & Motorrad'] },
  { match: ['auto und motorrad: fahrzeuge'], replace: ['Auto & Motorrad'] },

  // Baby roots: unify to the broader root.
  { match: ['baby'], replace: ['Baby & Kind'] },

  // Clothing roots: unify to one canonical tree (Kleidung & Accessoires).
  { match: ['bekleidung'], replace: ['Kleidung & Accessoires'] },
  { match: ['bekleidung und accessoires'], replace: ['Kleidung & Accessoires'] },
  { match: ['mode'], replace: ['Kleidung & Accessoires'] },
  { match: ['mode und bekleidung'], replace: ['Kleidung & Accessoires'] },
  // "Mode & Accessoires" sometimes has an extra "Kleidung" level – collapse it.
  { match: ['mode und accessoires', 'kleidung'], replace: ['Kleidung & Accessoires'] },
  { match: ['mode und accessoires'], replace: ['Kleidung & Accessoires'] },

  // Female-specific roots: fold into canonical clothing paths.
  { match: ['damen'], replace: ['Kleidung & Accessoires', 'Damenmode'] },
  { match: ['damenmode'], replace: ['Kleidung & Accessoires', 'Damenmode'] },
  { match: ['damenbekleidung'], replace: ['Kleidung & Accessoires', 'Damenbekleidung'] },
  { match: ['damenunterwaesche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damenunterwäsche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damen unterwaesche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damen unterwäsche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damenwasche und nachtwasche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damenwäsche und nachtwäsche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },

  // Common "single-topic" clothing roots.
  { match: ['herrenhosen'], replace: ['Kleidung & Accessoires', 'Herrenmode', 'Hosen'] },
  { match: ['kinderbekleidung'], replace: ['Kleidung & Accessoires', 'Kinder'] },

  // Motorcycle roots: fold into auto domain root.
  { match: ['motorradteile'], replace: ['Auto & Motorrad'] },
  { match: ['motorradzubehor'], replace: ['Auto & Motorrad'] },
  { match: ['motorradzubehör'], replace: ['Auto & Motorrad'] },
];

const SEGMENT_ALIASES = new Map(
  Object.entries({
    // Truncation / typos
    'kostume und verkleid': 'Kostüme & Verkleidungen',
    'kostüme und verkleid': 'Kostüme & Verkleidungen',
    // Minor plural normalization
    'strings und tanga': 'Strings & Tangas',
    'strings und tangas': 'Strings & Tangas',
  })
);

function applyPrefixRules(segments) {
  const normSegs = segments.map((s) => normalizeForMatch(s));
  for (const rule of PREFIX_RULES) {
    const match = rule.match;
    if (normSegs.length < match.length) continue;
    let ok = true;
    for (let i = 0; i < match.length; i += 1) {
      if (normSegs[i] !== match[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const rest = segments.slice(match.length);
    return [...rule.replace, ...rest].map((s) => normalizeSpaces(s));
  }
  return segments.map((s) => normalizeSpaces(s));
}

function applySegmentAliases(segments) {
  return segments
    .map((seg) => {
      const norm = normalizeForMatch(seg);
      const aliased = SEGMENT_ALIASES.get(norm);
      return aliased ? aliased : normalizeSpaces(seg);
    })
    .filter(Boolean);
}

function canonicalizeBaselinkerCategoryPath(pathOrBreadcrumb) {
  const originalSegments = splitBreadcrumb(pathOrBreadcrumb);
  if (!originalSegments.length) return '';
  const afterPrefix = applyPrefixRules(originalSegments);
  const afterAliases = applySegmentAliases(afterPrefix);
  return afterAliases.join(' > ');
}

function canonicalKeyForPath(pathOrBreadcrumb) {
  const canonical = canonicalizeBaselinkerCategoryPath(pathOrBreadcrumb);
  if (!canonical) return '';
  const segs = splitBreadcrumb(canonical);
  return segs.map((s) => normalizeForMatch(s)).join(' > ');
}

module.exports = {
  canonicalizeBaselinkerCategoryPath,
  canonicalKeyForPath,
  splitBreadcrumb,
  normalizeForMatch,
  normalizeSpaces,
};

