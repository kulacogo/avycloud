function safeString(value) {
  return typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
}

function normalizeSpaces(value) {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

function hasVowel(word = '') {
  return /[aeiouäöü]/i.test(word);
}

function normalizeMatch(value) {
  return normalizeSpaces(value)
    .toLowerCase()
    // Keep & for brands like H&M
    .replace(/[^\p{L}\p{N}&]+/gu, '');
}

function splitTokens(value) {
  return normalizeSpaces(value).split(/\s+/g).filter(Boolean);
}

function extractBrandFromTitlePrefix(brand, title) {
  const b = normalizeSpaces(brand);
  const t = normalizeSpaces(title);
  if (!b || !t) return null;

  const brandTokens = splitTokens(b);
  const titleTokens = splitTokens(t);
  if (!brandTokens.length || titleTokens.length < brandTokens.length) return null;

  for (let i = 0; i < brandTokens.length; i += 1) {
    if (normalizeMatch(titleTokens[i]) !== normalizeMatch(brandTokens[i])) {
      return null;
    }
  }

  const extracted = titleTokens.slice(0, brandTokens.length).join(' ');
  return normalizeSpaces(extracted) || null;
}

/**
 * Deterministic brand casing normalizer for UI + title consistency.
 *
 * Goals:
 * - Fix common drift: "adidas" -> "Adidas"
 * - Preserve stylized brands that already contain uppercase/lowercase mix: "iPhone", "eBay", "McLaren"
 * - Preserve ALL CAPS brands: "BOSCH", "BMW"
 * - Best-effort acronyms: short vowel-less tokens -> ALL CAPS ("bmw" -> "BMW", "hp" -> "HP")
 *
 * Non-goal:
 * - Perfect casing for every brand in the world (that requires a reference dictionary).
 */
function normalizeBrandDisplayCase(rawBrand, { titleHint = '' } = {}) {
  const s = normalizeSpaces(rawBrand);
  if (!s) return '';

  // Best: if the title already starts with this brand, reuse the exact casing from the title.
  // This preserves correct stylization (e.g. "ALKAR", "eBay", "H&M") even if the brand field drifted to lowercase.
  const fromTitle = extractBrandFromTitlePrefix(s, titleHint);
  if (fromTitle) {
    const titleHasUpper = /[A-ZÄÖÜ]/.test(fromTitle);
    const titleHasLower = /[a-zäöüß]/.test(fromTitle);
    // Only trust the title casing if it looks intentionally styled (has uppercase).
    // If the title also drifted to lowercase ("adidas ..."), fall back to deterministic normalization.
    if (titleHasUpper && !titleHasLower) return fromTitle; // ALL CAPS
    if (titleHasUpper && titleHasLower) return fromTitle; // mixed case
  }

  const hasUpper = /[A-ZÄÖÜ]/.test(s);
  const hasLower = /[a-zäöüß]/.test(s);
  // Already stylized (mixed case) or explicitly all caps
  if (hasUpper && hasLower) return s;
  if (hasUpper && !hasLower) return s;

  // All-lower (or no letters): apply per-letter-run heuristics while preserving separators.
  const out = s.replace(/[A-Za-zÄÖÜäöüß]+/g, (word) => {
    const lower = word.toLowerCase();
    // Acronym heuristic: very short + no vowels -> upper (bmw/hp/ibm)
    if (lower.length <= 3 && !hasVowel(lower)) {
      return lower.toUpperCase();
    }
    // Title-case otherwise
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });

  return normalizeSpaces(out);
}

module.exports = {
  normalizeBrandDisplayCase,
};

