/* eslint-disable no-console */
/**
 * STRICT eBay title policy enforcement (Identify / Improve / Chat / Imports).
 *
 * 🔒 Non‑negotiable rules (mobile-first + SEO):
 * - Mobile-first: first ~55–60 chars matter. Priority A MUST be inside first 60 chars:
 *   - Schema-specific anchors:
 *     - Default/Tech/Auto: Brand + Product type + Model/MPN/Part number
 *     - Clothing/Shoes: Brand + Product type + Size (avoid meaningless code-like "models")
 * - Fixed order (always):
 *   [BRAND] [PRODUCT TYPE] [MODEL/MPN] [CORE SPEC] [VARIANT] [CONDITION]
 * - No marketing fluff, no emojis, no duplicates.
 * - Length:
 *   - Preferred: 70–80 chars
 *   - Hard max (eBay): 80 chars
 *
 * LLM output is treated only as a hint-source for specs; final titles are built deterministically here.
 */

const STOP_WORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einer', 'eines', 'einen',
  'und', 'oder', 'für', 'mit', 'ohne', 'im', 'in', 'am', 'an', 'auf', 'aus',
  'von', 'vom', 'zur', 'zum', 'bei', 'als', 'auch', 'nur', 'sehr', 'mehr',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden',
]);

/**
 * Escape hatch: disable ALL title rule logic (schema priority A, ordering, marketing-word stripping, etc.).
 * Intended for "web-only" marketplace enrichment pipelines where titles should come from evidence.
 *
 * When disabled, we still do minimal deterministic sanitization + hard max length enforcement.
 */
function parseBoolFlag(raw) {
  const v = safeString(raw).toLowerCase();
  if (!v) return null;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n') return false;
  return null;
}

function isTitlePolicyDisabled() {
  // Default: enabled. Explicit opt-out via TITLE_POLICY_DISABLED=true.
  const disabledFlag = parseBoolFlag(process.env.TITLE_POLICY_DISABLED ?? process.env.DISABLE_TITLE_POLICY);
  if (disabledFlag !== null) {
    return disabledFlag;
  }
  const enabledFlag = parseBoolFlag(process.env.TITLE_POLICY_ENABLED);
  if (enabledFlag !== null) {
    return !enabledFlag;
  }
  return false;
}

const SHORT_OK_WORDS = new Set([
  'xs',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'xxxl',
  'ps5',
  'ps4',
  'ps3',
  'xbox',
  'dvd',
  'blu-ray',
  'bluray',
  '4k',
  'uhd',
]);

// Marketing / fluff words that must not appear in titles (especially not early).
// We keep this conservative to avoid removing meaningful technical tokens.
const MARKETING_WORDS = new Set([
  'hochwertig',
  'robust',
  'vielseitig',
  'nachhaltig',
  'stilvoll',
  'stylish',
  'premium',
  'neu',
  'neuware',
  'top',
  'super',
  'mega',
  'perfekt',
  'ideal',
  'sale',
  'angebot',
  'original',
]);

function getRuntimeMarketingWords() {
  try {
    const { getRulebookConfigCached } = require('./rulebook-config');
    const cfg = getRulebookConfigCached();
    const extra = Array.isArray(cfg?.title?.marketingWords) ? cfg.title.marketingWords : [];
    const out = new Set(MARKETING_WORDS);
    extra.forEach((w) => {
      const v = typeof w === 'string' ? w.trim().toLowerCase() : '';
      if (v) out.add(v);
    });
    return out;
  } catch {
    return MARKETING_WORDS;
  }
}

const DEFAULT_TITLE_MAX_LEN = 80;
const DEFAULT_TITLE_SOFT_MAX_LEN = 80;
const DEFAULT_TITLE_TARGET_MIN_LEN = 70;
const DEFAULT_TITLE_MOBILE_PRIORITY_MAX_LEN = 60;
const { normalizeBrandDisplayCase } = require('./brand-normalize');

const TRAILING_CONNECTOR_WORDS = new Set([
  'und',
  'oder',
  'mit',
  'ohne',
  'für',
  'fur',
  'von',
  'vom',
  'zur',
  'zum',
  'im',
  'am',
  'an',
  'auf',
  'in',
  'bei',
  'als',
]);

const TITLE_LOWERCASE_WORDS = new Set([
  'und',
  'oder',
  'mit',
  'ohne',
  'für',
  'fur',
  'von',
  'vom',
  'zur',
  'zum',
  'im',
  'am',
  'an',
  'auf',
  'in',
  'bei',
  'als',
  'der',
  'die',
  'das',
  'des',
  'dem',
  'den',
  'ein',
  'eine',
  'einer',
  'eines',
  'einen',
]);

const TITLE_UNIT_WORDS = new Set([
  'mm',
  'cm',
  'm',
  'l',
  'ml',
  'kg',
  'g',
  'w',
  'kw',
  'v',
  'mah',
  'gb',
  'tb',
  'mhz',
  'ghz',
  'rpm',
]);

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function stripEmojis(text = '') {
  // Remove emojis/pictographic symbols (mobile titles must be clean).
  return String(text || '').replace(/\p{Extended_Pictographic}/gu, ' ');
}

function stripLeadingNonAlnum(text = '') {
  // No bullets/emojis/dashes/special chars at the beginning.
  return String(text || '').replace(/^[^\p{L}\p{N}]+/gu, '');
}

function compactApplicationToken(value = '') {
  // Keep "Anwendung" short so it fits in 70–75 char titles.
  // Deterministic cleanup only (no guessing): remove parentheticals and take the first clause.
  let s = safeString(value);
  if (!s) return '';
  // Drop parenthetical parts (often commentary like "(gerichtetes Licht)")
  s = s.replace(/\([^)]*\)/g, ' ');
  // Keep only first clause when multiple are provided
  s = s.split(';')[0];
  s = s.split(',')[0];
  s = normalizeSpaces(s);
  if (!s) return '';
  // Prefer compact slashes without spaces
  s = s.replace(/\s*\/\s*/g, '/');
  // Optional "für" prefix if it looks like a target surface/area and doesn't already include it.
  if (!/\bfür\b/i.test(s) && /(tisch|bar|theke|küche|bad|schlafzimmer|wohnzimmer|esstisch)/i.test(s)) {
    s = `für ${s}`;
  }
  return s;
}

function normalizeForSearch(text = '') {
  // Similar to normalizeMatch but keeps spaces to allow rough order checks.
  return safeString(text)
    .toLowerCase()
    .replace(/[\-_/.,:;()\\[\]{}'"`´’“”!?+*=<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactUnitToken(value = '') {
  // Make common patterns more compact: "120 x 30 cm" -> "120x30cm", "314 mm" -> "314mm"
  let s = safeString(value);
  if (!s) return '';
  // Avoid leaking parentheses into titles (they get stripped inconsistently later).
  s = s.replace(/[()]/g, ' ');
  s = s
    .replace(/×/g, 'x')
    // Join dimension separators only when used as multiplier/dimension marker.
    // - "120 x 30" -> "120x30"
    // - "2 x Flasche" -> "2x Flasche"
    // Avoid touching normal words/acronyms like "ISOFIX" or model codes containing "X".
    .replace(/(\d)\s*[xX]\s*(\d)/g, '$1x$2')
    .replace(/(\d)\s*[xX]\s*(?=[A-Za-zÄÖÜäöü])/g, '$1x ')
    .replace(/(\d)\s+(mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb|mhz|ghz|rpm)\b/gi, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function formatPackSizeToken(value = '') {
  const raw = safeString(value);
  if (!raw) return '';
  const compact = compactUnitToken(raw);
  if (!compact) return '';

  // Plain counts -> prefer German "8er Set"
  if (/^\d{1,3}$/.test(compact)) {
    const n = parseInt(compact, 10);
    if (Number.isFinite(n) && n > 1) return `${n}er Set`;
    return '';
  }

  // "8 Stück", "8 Stk", "8 Teile", "8 tlg."
  const m = compact.match(/(\d{1,3})\s*(?:stk\.?|stück|teile|tlg\.?|teil|pcs?)\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 1) return `${n}er Set`;
    return '';
  }

  return compact;
}

function extractFirstDimensionRangeToken(text = '') {
  const raw = safeString(text);
  if (!raw) return '';
  const s = stripEmojis(raw);
  const re = /\b(\d{1,5}(?:[.,]\d+)?)\s*(mm|cm|m)\s*(?:bis|to|[-–—])\s*(\d{1,5}(?:[.,]\d+)?)\s*\2\b/i;
  const m = s.match(re);
  if (!m) return '';
  const a = String(m[1]).replace(',', '.').replace(/\.0$/g, '');
  const b = String(m[3]).replace(',', '.').replace(/\.0$/g, '');
  const unit = String(m[2] || '').toLowerCase();
  if (!a || !b || !unit) return '';
  return `${a}-${b}${unit}`;
}

function stripMarketingWords(text = '') {
  const raw = safeString(text);
  if (!raw) return '';
  const words = raw.split(/\s+/g);
  const kept = [];
  const roots = ['hochwert', 'robust', 'vielseit', 'nachhalt', 'stilvoll', 'stylish', 'premium', 'angebot', 'original', 'neu', 'top'];
  const runtime = getRuntimeMarketingWords();
  for (const w of words) {
    const cleaned = String(w).toLowerCase().replace(/[^a-z0-9äöüß\-]/gi, '');
    if (!cleaned) continue;
    if (runtime.has(cleaned)) continue;
    if (roots.some((r) => cleaned.startsWith(r))) continue;
    kept.push(w);
  }
  return normalizeSpaces(kept.join(' '));
}

function normalizeTitleToken(token = '') {
  let t = safeString(token);
  if (!t) return '';
  t = stripEmojis(t);
  t = stripMarkdownDecorations(t);
  t = stripMarketingWords(t);
  // Never allow internal SKU fragments into title tokens (CSV: "Nicht verwenden: SKU").
  t = stripSkuNoise(t);
  // Never allow barcode fragments (EAN/GTIN/UPC) inside title tokens.
  t = stripBarcodeNoise(t);
  // Remove bullet-like chars inside tokens (keep dots/hyphens for MPNs).
  t = t.replace(/[•·]/g, ' ');
  // Convert decimal comma to dot (avoid "8 5cm" after comma removal).
  t = t.replace(/(\d),(\d)/g, '$1.$2');
  // Replace comma/semicolon separators with spaces to avoid CSV-breaking punctuation and trailing commas
  t = t.replace(/[,;]+/g, ' ');
  // Replace ampersands with spaces (no marketing style "X & Y")
  t = t.replace(/&/g, ' ');
  // Remove explicit barcode labels and pure barcode tokens.
  t = t
    .split(/\s+/g)
    .filter((w) => w && !/^(ean|gtin|upc|isbn)$/i.test(w) && !isPureBarcodeToken(w))
    .join(' ');
  // Trim separators at ends (ASCII + Unicode punctuation/symbols)
  t = t.replace(/^[-–—,:;|]+/g, '').replace(/[-–—,:;|]+$/g, '');
  t = t.replace(/^[\p{P}\p{S}]+/gu, '').replace(/[\p{P}\p{S}]+$/gu, '');
  t = normalizeSpaces(t);
  return t;
}

function capitalizeFirstLetter(word = '', locale = 'de-DE') {
  if (!word) return '';
  return word.replace(/^\p{L}/u, (m) => m.toLocaleUpperCase(locale));
}

function applyBuyerSearchTitleCasing(title = '') {
  const raw = normalizeSpaces(title);
  if (!raw) return '';
  const words = raw.split(/\s+/g).filter(Boolean);
  const out = words.map((word, idx) => {
    const lower = word.toLowerCase();
    if (TITLE_UNIT_WORDS.has(lower)) return lower;
    if (idx > 0 && TITLE_LOWERCASE_WORDS.has(lower)) return lower;
    // Keep mixed-case/acronyms as-is (e.g. eBay, i-Size, BMW, ISOFIX, M.2).
    if (/[A-ZÄÖÜ]/.test(word.slice(1))) return word;
    if (/^\d/.test(word)) return word;
    return capitalizeFirstLetter(word);
  });
  return normalizeSpaces(out.join(' '));
}

function isSkuLikeToken(token = '') {
  const t = safeString(token);
  if (!t) return false;
  // Detect "SKU-123", "SKU 123" and also Unicode hyphen variants ("SKU‑123").
  if (/\bSKU[\s\-_‑–—]?\d+\b/i.test(t)) return true;
  if (/^sku[\s\-_‑–—]?\d+/i.test(t)) return true;
  return false;
}

function isPureBarcodeToken(token = '') {
  const normalized = safeString(token).replace(/[\s\-_.]/g, '');
  if (!normalized) return false;
  if (!/^\d+$/.test(normalized)) return false;
  return normalized.length === 8 || normalized.length === 12 || normalized.length === 13 || normalized.length === 14;
}

function extractModelCandidatesFromText(text = '') {
  const raw = safeString(text);
  if (!raw) return [];
  const parts = raw
    .split(/\s+/g)
    .map((p) => p.replace(/^[("'“”‘’`]+|[)"'“”‘’`,.]+$/g, ''))
    .filter(Boolean);
  const candidates = [];
  for (const part of parts) {
    const p = safeString(part);
    if (!p) continue;
    if (isSkuLikeToken(p)) continue;
    if (isPureBarcodeToken(p)) continue;
    // Exclude obvious dimension tokens like 120x30cm
    if (/\b\d{1,4}x\d{1,4}(?:x\d{1,4})?\s*(mm|cm|m)\b/i.test(p)) continue;
    if (/^\d{1,5}(?:[.,]\d+)?(mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb)\b/i.test(p)) continue;
    // Keep tokens that look like model/mpn (letters+digits and/or separators)
    if (/^[a-z0-9][a-z0-9._\-\/]{3,}$/i.test(p) && (/[a-z]/i.test(p) || /[._\-\/]/.test(p))) {
      candidates.push(p);
    }
  }
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = normalizeMatch(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, 6);
}

function isLikelyCodeLikeFashionModel(token = '') {
  const t = safeString(token);
  if (!t) return false;
  const compact = t.replace(/\s+/g, '');
  if (compact.length < 8) return false;
  // Very typical for apparel internal model/article numbers: long, no spaces, mixed letters+digits.
  const hasLetters = /[a-z]/i.test(compact);
  const hasDigits = /\d/.test(compact);
  if (!hasLetters || !hasDigits) return false;
  // If it contains separators it's more likely meaningful (e.g. "Air-Max 90"), keep those.
  if (/[._\-\/]/.test(compact)) return false;
  // Heuristic: code-like when long and vowel-poor (MW0MW28046DW5)
  const vowels = (compact.match(/[aeiouäöü]/gi) || []).length;
  const digits = (compact.match(/\d/g) || []).length;
  if (compact.length >= 10 && vowels <= 1 && digits >= 3) return true;
  if (compact.length >= 12 && digits >= 4) return true;
  return false;
}

function isLikelyOpaqueModelCode(token = '') {
  const t = safeString(token);
  if (!t) return false;
  const compact = t.replace(/\s+/g, '');
  if (compact.length < 6) return false;
  const hasLetters = /[a-z]/i.test(compact);
  const hasDigits = /\d/.test(compact);
  if (!hasLetters || !hasDigits) return false;
  // Classic opaque seller/manufacturer code pattern: all-caps alnum token with digits, no separators.
  if (/^[A-Z0-9]+$/.test(compact) && !/[._\-\/]/.test(compact) && compact.length >= 6) {
    if (hasDigits) return true;
  }
  const vowels = (compact.match(/[aeiouäöü]/gi) || []).length;
  const digits = (compact.match(/\d/g) || []).length;
  if (compact.length >= 6 && vowels <= 2 && digits >= 1 && !/[._\-\/]/.test(compact)) return true;
  if (compact.length >= 8 && vowels <= 2 && digits >= 2) return true;
  if (compact.length >= 10 && digits >= 3) return true;
  return false;
}

function shouldKeepModelTokenForSchema(schemaId, token = '') {
  const t = safeString(token);
  if (!t) return false;
  // Technical domains: model/OE/MPN style tokens are often buyer-relevant.
  if (schemaId === 'auto_parts' || schemaId === 'electronics_computer' || schemaId === 'photo_camcorder' || schemaId === 'tools_diy') {
    return true;
  }
  // Consumer domains: remove opaque internal codes unless they look readable.
  return !isLikelyOpaqueModelCode(t);
}

function parseSingleDimensionToken(token = '') {
  const t = compactUnitToken(token);
  const m = safeString(t).match(/^(\d{1,5}(?:[.,]\d+)?)(mm|cm|m)$/i);
  if (!m) return null;
  const value = String(m[1]).replace(',', '.').replace(/\.0$/g, '');
  const unit = String(m[2] || '').toLowerCase();
  if (!value || !unit) return null;
  return { value, unit };
}

function buildCompositeLwhToken(attrs = {}) {
  const length = parseSingleDimensionToken(pickAttr(attrs, 'Länge', 'Length'));
  const width = parseSingleDimensionToken(pickAttr(attrs, 'Breite', 'Width'));
  const height =
    parseSingleDimensionToken(pickAttr(attrs, 'Höhe', 'Height')) ||
    parseSingleDimensionToken(pickAttr(attrs, 'Dicke', 'Stärke', 'Tiefe', 'Depth'));
  if (!length || !width) return '';
  if (length.unit !== width.unit) return '';
  if (height && height.unit === length.unit) {
    return `${length.value}x${width.value}x${height.value}${length.unit}`;
  }
  return `${length.value}x${width.value}${length.unit}`;
}

function extractSpecTokensFromText(text = '') {
  const raw = safeString(text);
  if (!raw) return [];
  const s = stripEmojis(raw);
  let scan = s;
  const found = [];

  const push = (val) => {
    const t = normalizeTitleToken(compactUnitToken(val));
    if (!t) return;
    if (isSkuLikeToken(t)) return;
    if (isPureBarcodeToken(t)) return;
    uniqPush(found, t);
  };

  // Ranges like "43 cm bis 56 cm" or "43-56 cm" (keep as ONE token; otherwise unitRe would add both ends)
  const rangeRe =
    /\b(\d{1,5}(?:[.,]\d+)?)\s*(mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb|mhz|ghz|rpm)\s*(?:bis|to|[-–—])\s*(\d{1,5}(?:[.,]\d+)?)\s*\2\b/gi;
  let m;
  while ((m = rangeRe.exec(scan)) !== null) {
    const a = String(m[1]).replace(',', '.').replace(/\.0$/g, '');
    const b = String(m[3]).replace(',', '.').replace(/\.0$/g, '');
    const unit = String(m[2] || '').toLowerCase();
    if (!a || !b || !unit) continue;
    push(`${a}-${b}${unit}`);
  }
  rangeRe.lastIndex = 0;
  scan = scan.replace(rangeRe, ' ');

  // Dimensions like 120x30cm or 120 x 30 x 40 cm
  const dimRe = /\b\d{1,4}\s*(?:x|×)\s*\d{1,4}(?:\s*(?:x|×)\s*\d{1,4})?\s*(?:mm|cm|m)\b/gi;
  while ((m = dimRe.exec(scan)) !== null) {
    push(m[0]);
  }

  // Numeric units
  const unitRe =
    /\b\d{1,5}(?:[.,]\d+)?\s*(?:mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb|mhz|ghz|rpm)\b/gi;
  while ((m = unitRe.exec(scan)) !== null) {
    push(m[0]);
  }

  // Common tech keywords that matter for search
  const keywordTokens = [
    'm.2',
    'pcie',
    'gen3',
    'gen4',
    'ddr3',
    'ddr4',
    'ddr5',
    'sata',
    'nvme',
    'wifi',
    'bluetooth',
    'gps',
    'uhd',
    '4k',
  ];
  const lower = scan.toLowerCase();
  keywordTokens.forEach((kw) => {
    if (lower.includes(kw)) {
      push(kw);
    }
  });

  return found.slice(0, 10);
}

function extractAutoSpecTokensFromText(text = '') {
  const raw = safeString(text);
  if (!raw) return [];
  const s = stripEmojis(raw);
  const lower = s.toLowerCase();
  const found = [];

  const push = (val) => {
    const t = normalizeTitleToken(compactUnitToken(val));
    if (!t) return;
    if (isSkuLikeToken(t)) return;
    if (isPureBarcodeToken(t)) return;
    uniqPush(found, t);
  };

  // Poles / pins (high-signal for electrical car parts)
  const poligRe = /\b(\d{1,2})\s*[-\s]?\s*polig\b/gi;
  let m;
  while ((m = poligRe.exec(s)) !== null) {
    push(`${m[1]}-polig`);
  }
  const pinRe = /\b(\d{1,2})\s*[-\s]?\s*pin(?:s)?\b/gi;
  while ((m = pinRe.exec(s)) !== null) {
    push(`${m[1]}-Pin`);
  }

  // Common auto-part specs (keep list short + high-signal)
  if (/\belektrisch\b/.test(lower) || /\belectric(?:al)?\b/.test(lower)) push('elektrisch');
  if (/\bmanuell\b/.test(lower) || /\bmanual\b/.test(lower)) push('manuell');
  if (/\bbeheizt\b/.test(lower) || /\bheizbar\b/.test(lower) || /\bheated\b/.test(lower)) push('beheizt');
  if (/\b(anklappbar|klappbar)\b/.test(lower) || /\bfold(?:ing|able)\b/.test(lower)) push('anklappbar');
  if (/\b(asph[aä]risch|konvex|toter\s+w(?:i|ie)nkel|dead\s+angle)\b/i.test(s)) {
    // Keep localized tokens when present in the source text
    if (/\b(asph[aä]risch)\b/i.test(s)) push('asphärisch');
    if (/\bkonvex\b/i.test(s)) push('konvex');
    if (/\btoter\s+w(?:i|ie)nkel\b/i.test(s) || /\bdead\s+angle\b/i.test(s)) push('toter Winkel');
  }
  // Side / position (very high-signal for auto parts)
  if (/\brechts\b/.test(lower)) push('rechts');
  if (/\blinks\b/.test(lower)) push('links');

  return found.slice(0, 8);
}

function extractAutoCompatibilityFromTitle(titleText = '') {
  const raw = safeString(titleText);
  if (!raw) return '';

  // Generic compatibility phrasing (only if explicitly present)
  if (/\b(divers(?:e|er|es)?|verschieden(?:e|er|es)?|mehrere|viele)\s+fahrzeug(?:e|en)?\b/i.test(raw)) {
    return 'für diverse Fahrzeuge';
  }

  // If the title already contains a "für ..." phrase, attempt to keep it (bounded),
  // but avoid non-compatibility phrases like "für Zuhause" by requiring "für" to be followed by a likely vehicle token.
  const m = raw.match(/\bfür\s+([^,;.\n]{2,50})/i);
  if (m && m[1]) {
    const phrase = normalizeSpaces(m[1]);
    if (!phrase) return '';
    // If it explicitly talks about vehicles/models, keep a normalized generic form.
    if (/\bfahrzeug|fahrzeuge|modell|modelle\b/i.test(phrase)) {
      return 'für diverse Fahrzeuge';
    }
    // Heuristic: Accept phrases that contain at least one digit (e.g. "Fiat Ducato 250")
    // or at least one token starting with an uppercase letter (brand/model).
    const hasDigit = /\d/.test(phrase);
    const hasCapitalToken = phrase.split(/\s+/g).some((t) => /^[A-ZÄÖÜ]/.test(t));
    if (hasDigit || hasCapitalToken) {
      return `für ${phrase}`;
    }
  }

  return '';
}

function stripMarkdownDecorations(text = '') {
  let t = normalizeSpaces(text);
  if (!t) return '';

  // Remove wrapping quotes/backticks
  t = t.replace(/^`(.+)`$/s, '$1');
  t = t.replace(/^["“”](.+)["“”]$/s, '$1');

  // Remove common markdown bold/italic wrappers (only if they wrap the whole string)
  t = t.replace(/^\*{1,3}(.+?)\*{1,3}$/s, '$1');
  t = t.replace(/^_{1,3}(.+?)_{1,3}$/s, '$1');

  // Remove any remaining decoration markers
  t = t.replace(/\*\*/g, '').replace(/__/g, '');
  return normalizeSpaces(t);
}

function stripBarcodeNoise(text = '') {
  return normalizeSpaces(
    safeString(text)
      // Labeled barcode fragments.
      .replace(/\b(?:ean|gtin|upc|isbn)\b[\s:;#-]*\d{8,14}\b/gi, ' ')
      .replace(/\b(?:ean|gtin|upc|isbn)\b/gi, ' ')
      // Standalone long digit tokens are usually barcodes, not search keywords.
      .replace(/\b\d{12,14}\b/g, ' ')
  );
}

function stripSkuNoise(text = '') {
  return stripBarcodeNoise(
    stripMarkdownDecorations(text)
      // Remove SKU tokens, including common Unicode hyphen variants (e.g. "SKU‑123").
      .replace(/\bSKU[\s\-_‑–—]?\d+\b/gi, ' ')
      .replace(/\bSKU\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function stripUsedCondition(text = '') {
  return normalizeSpaces(
    safeString(text).replace(
      /\b(gebraucht|used|pre[-\s]?owned|second hand|b-ware|refurb(?:ished)?|renewed)\b/gi,
      ' '
    )
  );
}

function normalizeMatch(text = '') {
  return safeString(text)
    .toLowerCase()
    .replace(/[\s\-_/.,:;()\\[\]{}'"`´’“”!?+*=<>|]/g, '');
}

function containsToken(haystack, token) {
  const h = normalizeMatch(haystack);
  const t = normalizeMatch(token);
  if (!h || !t) return false;
  return h.includes(t);
}

function uniqPush(list, value) {
  const v = normalizeSpaces(value);
  if (!v) return;
  const key = normalizeMatch(v);
  if (!key) return;
  if (list.some((e) => normalizeMatch(e) === key)) return;
  list.push(v);
}

function truncateToMax(title, maxLen) {
  const t = normalizeSpaces(title);
  if (t.length <= maxLen) return t;
  // Try cutting at last space before maxLen
  const cut = t.slice(0, maxLen);
  const idx = cut.lastIndexOf(' ');
  if (idx > 40) return stripDanglingTailTokens(cut.slice(0, idx).trim());
  return stripDanglingTailTokens(cut.trim());
}

function stripDanglingTailTokens(value = '') {
  let out = normalizeSpaces(String(value || ''));
  if (!out) return '';
  // Remove punctuation/symbol tails first.
  out = out.replace(/[\p{P}\p{S}]+$/gu, '').trim();
  if (!out) return '';
  const words = out.split(/\s+/g).filter(Boolean);
  while (words.length > 1) {
    const tail = safeString(words[words.length - 1]).toLowerCase();
    if (!tail) break;
    if (!TRAILING_CONNECTOR_WORDS.has(tail)) break;
    words.pop();
  }
  out = normalizeSpaces(words.join(' '));
  out = out.replace(/[\p{P}\p{S}]+$/gu, '').trim();
  return out;
}

function extractWords(text = '', { max = 60 } = {}) {
  const raw = safeString(text);
  if (!raw) return [];
  const cleaned = raw
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s\-+./]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(/\s+/g).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const w = part.trim();
    if (!w) continue;
    const lower = w.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    // Keep short but meaningful tokens (sizes, model codes like i5/4K/PS5).
    if (lower.length < 3 && !/^\d+$/.test(lower) && !/\d/.test(lower) && !SHORT_OK_WORDS.has(lower)) {
      continue;
    }
    const key = normalizeMatch(lower);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function isUsedWordToken(word = '') {
  const w = safeString(word);
  if (!w) return false;
  return /\b(gebraucht|used|pre[-\s]?owned|secondhand|second|hand|b-ware|refurb(?:ished)?|renewed)\b/i.test(w);
}

function pickAttr(attrs, ...keys) {
  for (const key of keys) {
    const val = attrs?.[key];
    const s = safeString(val);
    if (!s) continue;
    if (/^unknown|unbekannt$/i.test(s)) continue;
    return s;
  }
  return '';
}

function compactVehicleCompat(makeRaw = '', seriesRaw = '', modelRaw = '') {
  const make = normalizeTitleToken(makeRaw);
  if (!make) return '';
  const series = normalizeTitleToken(seriesRaw);
  const model = normalizeTitleToken(modelRaw);

  // Prefer series over raw model lists (they are usually much shorter / more user-friendly).
  // Normalize list separators to slashes to save characters.
  const compactList = (val) =>
    normalizeSpaces(String(val || '').replace(/\s*,\s*/g, '/').replace(/\s*;\s*/g, '/').replace(/\s*\/\s*/g, '/'));

  const seriesCompact = compactList(series);
  const modelCompact = compactList(model);

  // Keep vehicle part short to preserve room for MPN/specs under the 80 char hard limit.
  // Heuristic: make + (series OR model), but truncate aggressively if it becomes too long.
  const candidate = normalizeSpaces([make, seriesCompact || modelCompact].filter(Boolean).join(' '));
  if (!candidate) return make;
  if (candidate.length <= 28) return candidate;
  // If it's too long, keep only the make (high-signal).
  return make;
}

function collectPaddingTokens(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  const tokens = [];
  uniqPush(tokens, safeString(product?.identification?.brand));

  // Product type (prefer explicit attribute, fallback to last category segment)
  const productType =
    pickAttr(attrs, 'Produktart', 'Produkttyp', 'Produkttyp (Produktart)') ||
    normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '');
  uniqPush(tokens, productType);

  // MPN / manufacturer number
  uniqPush(tokens, safeString(product?.details?.identifiers?.mpn));
  uniqPush(tokens, pickAttr(attrs, 'Herstellernummer'));

  // OEM reference
  uniqPush(tokens, pickAttr(attrs, 'OE/OEM Referenznummer(n)', 'Referenznummer(n) OEM', 'Referenznummer', 'OEM-Referenznummer'));

  // Model
  uniqPush(tokens, pickAttr(attrs, 'Modell', 'Model', 'Model Number'));

  // Category-specific common keys
  uniqPush(tokens, pickAttr(attrs, 'Farbe', 'Color'));
  const size =
    pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße', 'Größe', 'Size', 'Breite', 'Höhe', 'Länge', 'Durchmesser');
  if (size) {
    // Prefer "Gr." prefix only if it looks like a size
    if (/\b(gr\.?|größe)\b/i.test(String(size))) {
      uniqPush(tokens, size);
    } else {
      uniqPush(tokens, `Gr. ${size}`);
    }
  }
  uniqPush(tokens, pickAttr(attrs, 'Material', 'Obermaterial', 'Gewebeart', 'Futtermaterial'));

  // Auto parts / compatibility hints
  uniqPush(tokens, pickAttr(attrs, 'Einbauposition', 'Position'));
  uniqPush(tokens, pickAttr(attrs, 'Bremssystem', 'Bremssystem (Hersteller)'));
  uniqPush(tokens, pickAttr(attrs, 'Dicke', 'Dicke/Stärke'));
  uniqPush(tokens, pickAttr(attrs, 'Bremsscheibenart'));
  uniqPush(tokens, pickAttr(attrs, 'Lochkreis'));
  uniqPush(tokens, pickAttr(attrs, 'Einbaugröße'));
  uniqPush(tokens, pickAttr(attrs, 'Betriebssystem'));
  uniqPush(tokens, pickAttr(attrs, 'Bildschirmgröße'));
  uniqPush(tokens, pickAttr(attrs, 'Wiedergabeformate'));
  uniqPush(tokens, pickAttr(attrs, 'Anschlüsse'));
  uniqPush(tokens, pickAttr(attrs, 'Anzahl der Kanäle'));
  uniqPush(tokens, pickAttr(attrs, 'Besonderheiten'));
  uniqPush(tokens, pickAttr(attrs, 'Fahrzeugmarke', 'Kompatible Fahrzeugmarke', 'Kompatible Fahrzeugmarken', 'Hersteller'));
  uniqPush(tokens, pickAttr(attrs, 'Fahrzeugmodell', 'Kompatible Fahrzeugmodelle', 'Kompatible Fahrzeugmodel', 'Modell'));
  uniqPush(tokens, pickAttr(attrs, 'Baureihe', 'Kompatible Fahrzeugserie', 'Kompatible Fahrzeugserien'));
  uniqPush(tokens, pickAttr(attrs, 'Universelle Kompatibilität'));

  // Books/media
  uniqPush(tokens, pickAttr(attrs, 'Autor', 'Künstler'));
  uniqPush(tokens, pickAttr(attrs, 'Buchtitel', 'Titel'));
  uniqPush(tokens, pickAttr(attrs, 'Buchreihe', 'Serie', 'Thema'));
  uniqPush(tokens, pickAttr(attrs, 'Format', 'Einband'));
  uniqPush(tokens, pickAttr(attrs, 'Sprache'));
  uniqPush(tokens, pickAttr(attrs, 'Erscheinungsjahr', 'Herstellungsjahr', 'Baujahr'));
  uniqPush(tokens, pickAttr(attrs, 'Edition', 'Ausgabe'));

  // Condition (only if explicitly present)
  const explicitCondition = pickAttr(attrs, 'Zustand');
  if (explicitCondition) {
    // IMPORTANT: Do not allow "used/gebraucht" to leak into titles unless condition is explicitly locked by humans.
    // inferCondition() already enforces that rule.
    uniqPush(tokens, inferCondition(product));
  }

  return tokens.filter(Boolean);
}

function inferCondition(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const explicit = pickAttr(attrs, 'Zustand');
  if (explicit) {
    const normalized = explicit.toString().trim().toLowerCase();
    if (/ovp|originalverpack/.test(normalized)) return 'NEU OVP';
    if (/\bneu\b|\bnew\b/.test(normalized)) return 'NEU';
    if (/\bgebraucht\b|\bused\b|\bpre[-\s]?owned\b|\bsecond hand\b|\bb-ware\b|\brefurb/.test(normalized)) {
      // User requirement: "Gebraucht" only when explicitly curated by humans.
      const locked = Boolean(product?.ops?.condition_locked);
      return locked ? 'Gebraucht' : 'NEU';
    }
    return explicit;
  }
  return 'NEU';
}

function inferSchemaId(product) {
  const categoryRaw = safeString(product?.identification?.category);
  const category = categoryRaw.toLowerCase();
  const categoryNorm = normalizeForSearch(categoryRaw);
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const leaf = normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '').toLowerCase();

  // 2) Auto & Motorrad (Teile) — must win early.
  // Reason: some automotive category paths contain words like "Pflege" ("Öl, Pflege- & Schmiermittel")
  // which previously caused misclassification as "beauty".
  if (
    category.includes('kfz') ||
    category.includes('motorrad') ||
    category.includes('fahrzeug') ||
    category.includes('autoteile') ||
    /\b(motoröl|getriebeöl|ölfilter|luftfilter|brems|kupplung|stoßdämpfer|scheinwerfer|außenspiegel)\b/i.test(categoryNorm) ||
    Boolean(pickAttr(attrs, 'K-Typ', 'Ktyp', 'K typ')) ||
    Boolean(pickAttr(attrs, 'Fahrzeugtyp', 'Fahrzeugmarke', 'Kompatible Fahrzeugmarke'))
  ) {
    return 'auto_parts';
  }

  // 13) Bücher
  if (pickAttr(attrs, 'Autor') || pickAttr(attrs, 'Buchtitel') || category.includes('bücher') || category.includes('buch')) {
    return 'books';
  }
  // 14) Musik (CDs & Vinyl)
  if (category.includes('musik') || category.includes('vinyl') || category.includes('cd') || category.includes('schallplatte')) {
    return 'music';
  }
  // 15) Filme & DVDs
  if (category.includes('film') || category.includes('blu-ray') || category.includes('bluray') || category.includes('dvd')) {
    return 'movies';
  }
  // 12) Videospiele & Konsolen
  if (
    category.includes('videospiel') ||
    category.includes('konsole') ||
    /\b(ps5|ps4|ps3|xbox|switch|nintendo)\b/.test(categoryNorm)
  ) {
    return 'videogames';
  }
  // 4) Schuhe
  if (pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße') || category.includes('schuhe') || /sneaker|schuh/.test(leaf)) {
    return 'shoes';
  }
  // 3) Mode & Bekleidung
  // IMPORTANT:
  // Many non-fashion home categories contain "textil/textilien" (e.g. "Badzubehör & -textilien").
  // Classify as "fashion" only when the category clearly indicates apparel.
  if (category.includes('mode') || category.includes('kleidung') || category.includes('bekleidung')) {
    return 'fashion';
  }
  // 11) Uhren & Schmuck
  if (category.includes('uhren') || category.includes('schmuck')) return 'watches_jewelry';
  // 9) Spielzeug & Baby
  // IMPORTANT: "Kinder*" appears in many non-toy home categories (e.g. Kindermöbel). Don't auto-classify those as toys.
  if (category.includes('spielzeug') || category.includes('baby') || /\bkinderspielzeug\b/.test(categoryNorm)) return 'toys_baby';
  // 10) Büro & Schreibwaren
  if (category.includes('büro') || category.includes('schreibwaren')) return 'office';
  // 16) Haustierbedarf
  if (category.includes('tier') || category.includes('haustier')) return 'pet';
  // 7) Beauty & Personal Care
  // NOTE: Do NOT match "pflege" when this is an automotive path (handled above).
  if (category.includes('beauty') || category.includes('kosmetik') || category.includes('pflege') || category.includes('personal care')) return 'beauty';
  // 8) Sport & Freizeit
  if (category.includes('sport') || category.includes('fitness') || category.includes('freizeit')) return 'sport';
  // 18) Foto & Camcorder
  if (category.includes('foto') || category.includes('kamera') || category.includes('camcorder') || category.includes('objektiv')) return 'photo_camcorder';
  // 19) Musikinstrumente
  if (category.includes('musikinstrument') || category.includes('instrument')) return 'instruments';
  // 17) Sammeln & Seltenes (Münzen/Briefmarken)
  if (category.includes('sammeln') || category.includes('münz') || category.includes('briefmark')) return 'collectibles';
  // 20) Heimwerker (Werkzeug)
  if (category.includes('heimwerker') || category.includes('werkzeug') || (category.includes('akku') && category.includes('werkzeug'))) {
    return 'tools_diy';
  }
  // 6) Küche & Haushalt
  if (category.includes('küche') || category.includes('haushalt') || category.includes('haushaltsger')) return 'kitchen_household';
  // Treat furniture/living as Home/Garden bucket for title rules (CSV: "Haus, Garten & Baumarkt").
  if (category.includes('möbel') || category.includes('moebel') || category.includes('wohnen')) {
    return 'home_garden';
  }
  // 5) Haus, Garten & Baumarkt (avoid matching "Haushalt")
  if (
    category.includes('garten') ||
    category.includes('baumarkt') ||
    categoryNorm.includes('haus garten') ||
    (category.includes('haus') && !category.includes('haushalt'))
  ) {
    return 'home_garden';
  }
  // 1) Elektronik & Computer
  if (category.includes('elektronik') || category.includes('computer') || category.includes('laptop') || category.includes('notebook') || category.includes('pc')) {
    return 'electronics_computer';
  }
  return 'generic';
}

/**
 * Coarse "Titel-Kategorie" bucket for rulebook title rules.
 * This intentionally collapses fine schemas into a small set that admins manage.
 * These are NOT product categories; they exist only to apply title rules consistently.
 */
function inferTitleCategory(product) {
  const rawCategory = safeString(product?.identification?.category);
  const categoryNorm = normalizeForSearch(rawCategory);
  const fine = inferSchemaId(product);

  // IMPORTANT: Do NOT auto-force a CSV bucket purely from keywords (e.g. "Leuchte/Lampe").
  // The user controls the CSV bucket via the product's category bucket. If they define lighting
  // items as furniture ("Haus, Garten & Baumarkt"), we must respect that.

  // Map fine schemas -> coarse buckets
  if (fine === 'books' || fine === 'music' || fine === 'movies' || fine === 'videogames') return 'Bücher & Medien';
  if (fine === 'shoes' || fine === 'watches_jewelry') return 'Schuhe & Accessoires';
  if (fine === 'photo_camcorder') return 'Elektronik & Computer';
  if (fine === 'pet') return 'Haus, Garten & Baumarkt';
  if (fine === 'tools_diy') return 'Haus, Garten & Baumarkt';
  if (fine === 'collectibles' || fine === 'instruments') return 'Haus, Garten & Baumarkt';

  // Passthrough when already a bucket id
  const allowed = new Set([
    'Elektronik & Computer',
    'Auto & Motorrad (Teile)',
    'Mode & Bekleidung',
    'Schuhe & Accessoires',
    'Haus, Garten & Baumarkt',
    'Küche & Haushalt',
    'Beauty & Personal Care',
    'Sport & Freizeit',
    'Spielzeug & Baby',
    'Büro & Schreibwaren',
    'Beleuchtung & Elektromaterial',
    'Bücher & Medien',
  ]);
  // Map fine schema ids to CSV Kategorie labels
  const mapFineToCsv = {
    electronics_computer: 'Elektronik & Computer',
    auto_parts: 'Auto & Motorrad (Teile)',
    fashion: 'Mode & Bekleidung',
    kitchen_household: 'Küche & Haushalt',
    beauty: 'Beauty & Personal Care',
    sport: 'Sport & Freizeit',
    toys_baby: 'Spielzeug & Baby',
    office: 'Büro & Schreibwaren',
    books_media: 'Bücher & Medien',
  };
  const mapped = mapFineToCsv[fine] || '';
  if (mapped && allowed.has(mapped)) return mapped;
  // If product already uses a CSV bucket label in identification.category, allow passthrough.
  if (allowed.has(rawCategory)) return rawCategory;
  // Hard fallback to one of the 12 CSV categories (broad catch-all).
  return 'Haus, Garten & Baumarkt';
}

function buildTitlePlanBySchema(product, schemaId, { proposedTitle = '' } = {}) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  const brand =
    normalizeTitleToken(
      normalizeBrandDisplayCase(safeString(product?.identification?.brand), {
        titleHint: safeString(product?.identification?.name),
      })
    ) ||
    normalizeTitleToken(pickAttr(attrs, 'Marke', 'Brand')) ||
    '';

  const productTypeRaw =
    pickAttr(
      attrs,
      'Produktart',
      'Produkttyp',
      'Produkttyp (Produktart)',
      // Common real-world variants across categories (Beauty/Tech/Tools/Auto)
      'Gerätetyp',
      'Artikeltyp',
      'Artikel-Typ',
      'Bauteil',
      'Komponente',
      'Werkzeugart',
      'Schuhart'
    ) ||
    normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '');
  const productType = normalizeTitleToken(productTypeRaw);

  const mpn =
    normalizeTitleToken(safeString(product?.details?.identifiers?.mpn)) ||
    normalizeTitleToken(pickAttr(attrs, 'Herstellernummer', 'MPN')) ||
    '';
  const model = normalizeTitleToken(pickAttr(attrs, 'Modell', 'Model', 'Model Number'));
  const series = normalizeTitleToken(
    pickAttr(attrs, 'Serie', 'Produktserie', 'Reihe', 'Produktlinie', 'Serienname', 'Baureihe')
  );
  const oem = normalizeTitleToken(
    pickAttr(attrs, 'OE/OEM Referenznummer(n)', 'Referenznummer(n) OEM', 'Referenznummer', 'OEM-Referenznummer')
  );

  const hintText = [proposedTitle, product?.identification?.name, product?.details?.short_description]
    .map((x) => safeString(x))
    .filter(Boolean)
    .join(' ');
  const extractedCodes = extractModelCandidatesFromText(hintText);
  const extractedCode = normalizeTitleToken(extractedCodes[0] || '');
  let modelOrMpn = '';
  if (schemaId === 'auto_parts' || schemaId === 'electronics_computer' || schemaId === 'photo_camcorder' || schemaId === 'tools_diy') {
    modelOrMpn = mpn || model || oem || extractedCode;
  } else {
    const modelCandidate = shouldKeepModelTokenForSchema(schemaId, model) ? model : '';
    const mpnCandidate = shouldKeepModelTokenForSchema(schemaId, mpn) ? mpn : '';
    const oemCandidate = shouldKeepModelTokenForSchema(schemaId, oem) ? oem : '';
    const extractedCandidate = shouldKeepModelTokenForSchema(schemaId, extractedCode) ? extractedCode : '';
    modelOrMpn = modelCandidate || mpnCandidate || oemCandidate || extractedCandidate;
  }
  const modelOrSeries = series || model || modelOrMpn;

  // Never inject "NEU/Gebraucht" into titles by default. Only include condition when explicitly curated.
  const condition = normalizeTitleToken(
    (Boolean(product?.ops?.condition_locked) || Boolean(pickAttr(attrs, 'Zustand')))
      ? inferCondition(product)
      : ''
  );

  const color = normalizeTitleToken(pickAttr(attrs, 'Farbe', 'Color'));
  const sizeRaw = pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße', 'Größe', 'Size');
  const size = sizeRaw ? (/\b(gr\.?|größe)\b/i.test(sizeRaw) ? sizeRaw : `Gr. ${sizeRaw}`) : '';
  const normSize = normalizeTitleToken(compactUnitToken(size));
  const material = normalizeTitleToken(pickAttr(attrs, 'Material', 'Obermaterial', 'Gewebeart', 'Futtermaterial'));

  const vehicleMake = normalizeTitleToken(
    pickAttr(attrs, 'Fahrzeugmarke', 'Kompatible Fahrzeugmarke', 'Kompatible Fahrzeugmarken', 'Hersteller')
  );
  const vehicleModel = normalizeTitleToken(
    pickAttr(attrs, 'Fahrzeugmodell', 'Kompatible Fahrzeugmodelle', 'Kompatible Fahrzeugmodel', 'Modell')
  );
  const vehicleSeries = normalizeTitleToken(pickAttr(attrs, 'Baureihe', 'Kompatible Fahrzeugserie', 'Kompatible Fahrzeugserien'));
  const position = normalizeTitleToken(pickAttr(attrs, 'Einbauposition', 'Position'));

  let measure = normalizeTitleToken(
    compactUnitToken(
      pickAttr(attrs, 'Maße', 'Abmessungen', 'Durchmesser', 'Länge', 'Breite', 'Höhe', 'Tiefe', 'Lochkreis', 'Einbaugröße')
    )
  );
  const capacity = normalizeTitleToken(
    compactUnitToken(pickAttr(attrs, 'Fassungsvermögen gesamt', 'Fassungsvermögen', 'Volumen', 'Kapazität', 'Speicherkapazität', 'Speicher'))
  );
  const power = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Leistung', 'Power')));
  const voltage = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Spannung', 'Volt', 'Voltage')));
  const audience = normalizeTitleToken(pickAttr(attrs, 'Abteilung', 'Zielgruppe', 'Geschlecht'));
  const function1 = normalizeTitleToken(
    compactApplicationToken(
      pickAttr(
      attrs,
      'Funktion 1',
      'Funktion',
      'Anwendung',
      'Anwendungsbereich',
      'Einsatzbereich',
      'Verwendungszweck',
      'Verwendung',
      'Geeignet für'
      )
    )
  );
  const coreFeature = measure || capacity || power || voltage || material || '';

  const specsFromText = extractSpecTokensFromText(
    [
      proposedTitle,
      product?.identification?.name,
      productTypeRaw,
      modelOrMpn,
      product?.details?.short_description,
    ]
      .filter(Boolean)
      .join(' ')
  );

  const a = [];
  const b = [];
  const c = [];
  const pushA = (v) => uniqPush(a, normalizeTitleToken(compactUnitToken(v)));
  const pushB = (v) => uniqPush(b, normalizeTitleToken(compactUnitToken(v)));
  const pushC = (v) => uniqPush(c, normalizeTitleToken(compactUnitToken(v)));

  const titleHint = [proposedTitle, product?.identification?.name].filter(Boolean).join(' ');

  const line = normalizeTitleToken(pickAttr(attrs, 'Linie', 'Produktlinie', 'Serie'));
  const effect = normalizeTitleToken(pickAttr(attrs, 'Wirkung', 'Effekt', 'Anwendungsgebiet'));
  const amount = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Menge', 'Inhalt', 'Füllmenge', 'Nettofüllmenge')));
  const sportType = normalizeTitleToken(pickAttr(attrs, 'Sportart', 'Sport'));
  const theme = normalizeTitleToken(pickAttr(attrs, 'Lizenz', 'Thema', 'Serie', 'Charakter'));
  const age = normalizeTitleToken(pickAttr(attrs, 'Altersempfehlung', 'Alter'));
  const packSize = normalizeTitleToken(formatPackSizeToken(pickAttr(attrs, 'Menge', 'Packung', 'Stückzahl', 'Anzahl', 'Anzahl der Teile')));
  const alloy = normalizeTitleToken(pickAttr(attrs, 'Material', 'Legierung', 'Metall'));
  const stone = normalizeTitleToken(pickAttr(attrs, 'Stein', 'Besatz', 'Edelstein'));
  const platform =
    normalizeTitleToken(pickAttr(attrs, 'Plattform', 'Platform', 'System')) ||
    normalizeTitleToken((extractWords(titleHint, { max: 20 }).find((w) => /\b(ps5|ps4|ps3|xbox|switch|nintendo)\b/i.test(w)) || ''));
  const usk = normalizeTitleToken(pickAttr(attrs, 'USK'));
  const edition = normalizeTitleToken(pickAttr(attrs, 'Edition', 'Ausgabe', 'Cut'));
  const genre = normalizeTitleToken(pickAttr(attrs, 'Genre'));
  const animal = normalizeTitleToken(pickAttr(attrs, 'Tierart', 'Haustier', 'Tier'));
  const sizeWeight = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Größe', 'Gewicht', 'Volumen', 'Kapazität')));
  const extraFeature = normalizeTitleToken(pickAttr(attrs, 'Feature', 'Besonderheiten', 'Eigenschaft', 'Hauptmerkmal'));
  const country = normalizeTitleToken(pickAttr(attrs, 'Land', 'Herkunftsland'));
  const faceValue = normalizeTitleToken(pickAttr(attrs, 'Nennwert', 'Motiv', 'Thema'));
  const year = normalizeTitleToken(pickAttr(attrs, 'Jahr', 'Erscheinungsjahr', 'Herstellungsjahr'));
  const grade = normalizeTitleToken(pickAttr(attrs, 'Erhaltungsgrad'));
  const lensType = normalizeTitleToken(pickAttr(attrs, 'Objektiv', 'Objektivtyp', 'Objektiv-Typ', 'Lens'));
  const resolution = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Auflösung', 'Megapixel', 'MP')));
  const instrument = normalizeTitleToken(pickAttr(attrs, 'Instrument', 'Instrumententyp'));
  const tuning = normalizeTitleToken(pickAttr(attrs, 'Stimmung', 'Tuning'));
  const accessories = normalizeTitleToken(pickAttr(attrs, 'Zubehör', 'Lieferumfang', 'Set', 'Set-Inhalt'));
  const energySource = normalizeTitleToken(pickAttr(attrs, 'Energiequelle', 'Energieversorgung', 'Stromversorgung', 'Akkutyp'));
  const techCompat = normalizeTitleToken(pickAttr(attrs, 'Technologie', 'Kompatibilität', 'Betriebsart', 'Anschlüsse', 'Geeignet für'));
  const mounting = normalizeTitleToken(pickAttr(attrs, 'Montage', 'Montageart', 'Befestigung', 'Installation'));

  // Prefer LxBxH style when dimensions are split across separate attributes.
  // This is especially relevant for buyer decisions in consumer categories (e.g., sport/home goods).
  const lwhMeasure = normalizeTitleToken(buildCompositeLwhToken(attrs));
  if (lwhMeasure) {
    measure = lwhMeasure;
  }

  // Prefer explicit dimension ranges from text (e.g. "43 cm bis 56 cm") for the primary measure token.
  const measureRange = normalizeTitleToken(extractFirstDimensionRangeToken(hintText));
  if (measureRange) {
    measure = measureRange;
  }

  switch (schemaId) {
    case 'electronics_computer': {
      // [MARKE] [MODELL] [PRODUKTTYP] [HAUPT-SPEC/SPEICHER] [ZUSTAND]
      pushA(brand);
      pushA(modelOrMpn);
      pushA(productType);
      pushB(capacity);
      specsFromText.forEach((t) => pushB(t));
      pushC(color);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'auto_parts': {
      // [TEILNAME] [EINBAUORT] für [FAHRZEUG/MODELL] [OE/MPN] [SPEC]
      const vehicle = compactVehicleCompat(vehicleMake, vehicleSeries, vehicleModel);
      // For motor oil / lubricants, "compat" is often engine/application scope, not a vehicle make/model.
      const isOil =
        /\b(motoröl|getriebeöl|öl)\b/i.test(productTypeRaw) ||
        /\b(motoröl|getriebeöl|öl)\b/i.test(productType) ||
        Boolean(pickAttr(attrs, 'Viskosität', 'SAE', 'ACEA Spezifikation', 'API Spezifikation'));
      const oilScope =
        normalizeTitleToken(
          pickAttr(attrs, 'Einsatzbereich', 'Motortyp', 'Anwendungsbereich', 'Einsatz')
        ) || '';
      const compat = vehicle
        ? `für ${vehicle}`
        : isOil && oilScope
          ? `für ${oilScope}`
          : extractAutoCompatibilityFromTitle(titleHint);
      const brakeSystem = normalizeTitleToken(pickAttr(attrs, 'Bremssystem', 'Bremssystem (Hersteller)'));
      const thickness = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Dicke', 'Dicke/Stärke')));
      // Match Titel_Regeln.csv for Auto & Motorrad (Teile):
      // [Hersteller] [Teil] [Position/Spec] für [Marke Modell] [OE/MPN]
      const posSpec = normalizeTitleToken(
        normalizeSpaces([position, brakeSystem, thickness].filter(Boolean).join(' '))
      );
      pushA(brand); // Hersteller
      pushA(productType); // Teil
      pushA(posSpec); // Position/Spec
      pushA(compat); // für Marke/Modell
      pushB(modelOrMpn); // OE/MPN
      // Motor oil specifics: prefer deterministic, factual tokens from attributes.
      if (isOil) {
        const viscosity = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Viskosität', 'SAE')));
        const acea = normalizeTitleToken(pickAttr(attrs, 'ACEA Spezifikation', 'ACEA'));
        const api = normalizeTitleToken(pickAttr(attrs, 'API Spezifikation', 'API'));
        const volume =
          normalizeTitleToken(
            compactUnitToken(pickAttr(attrs, 'Inhalt', 'Volumen', 'Füllmenge', 'Nettofüllmenge', 'Menge'))
          ) || '';
        const bmw = normalizeTitleToken(pickAttr(attrs, 'BMW Freigabe', 'BMW-Freigabe'));
        const mb = normalizeTitleToken(pickAttr(attrs, 'Mercedes-Benz Freigabe', 'MB Freigabe', 'Mercedes Freigabe'));
        const gm = normalizeTitleToken(pickAttr(attrs, 'GM Freigabe', 'Dexos', 'Dexos Freigabe'));
        // include model name for oils (e.g. Helix Ultra ECT C3)
        pushB(model);
        pushB(viscosity);
        pushB(volume);
        pushB(acea);
        pushB(api);
        pushB(bmw);
        pushB(mb);
        pushB(gm);
      }
      extractAutoSpecTokensFromText(titleHint).forEach((t) => pushB(t));
      specsFromText.forEach((t) => pushB(t));
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'fashion': {
      // [MARKE] [GESCHLECHT] [PRODUKTART] [FARBE] Gr. [GRÖSSE] [SPEZIFIK]
      pushA(brand);
      pushA(audience);
      pushA(productType);
      pushB(color);
      pushB(normSize);
      pushB(material);
      if (modelOrMpn && !isLikelyCodeLikeFashionModel(modelOrMpn)) {
        pushB(modelOrMpn);
      }
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'shoes': {
      // [MARKE] [SCHUHART] [GESCHLECHT] Gr. [EU] [FARBE] [SPEZIFIK]
      pushA(brand);
      pushA(productType);
      pushA(audience);
      pushB(normSize);
      pushB(color);
      pushB(material);
      if (modelOrMpn && !isLikelyCodeLikeFashionModel(modelOrMpn)) {
        pushB(modelOrMpn);
      }
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'home_garden': {
      // Titel_Regeln.csv (Haus, Garten & Baumarkt):
      // Template: [Produktart] [Material/Merkmal] [Maße/Menge] [Anwendung] [Marke]
      // Priorities: Produktart -> Maß/Menge -> Anwendung -> Material (brand at end).
      const primaryMeasure = measure || capacity || packSize;
      pushA(productType);
      // Material/Merkmal early (as template suggests)
      pushA(material || extraFeature);
      pushA(primaryMeasure);

      // Anwendung MUST appear for this bucket when we have it
      pushB(function1);
      // Pack size is a strong search token for home/organization items (prefer "8er Set").
      if (packSize && packSize !== primaryMeasure) {
        pushB(packSize);
      }

      // Additional factual tokens (no marketing, no SKU)
      const rawFeatures = pickAttr(attrs, 'Besonderheiten', 'Feature', 'Eigenschaft', 'Hauptmerkmal');
      const featureTokens = safeString(rawFeatures)
        .split(/[,;]+/g)
        .map((x) => normalizeTitleToken(x))
        .filter(Boolean)
        .slice(0, 3);
      if (featureTokens.length) {
        featureTokens.forEach((t) => pushB(t));
      } else {
        pushB(extraFeature);
      }
      // Ensure brand is present; keep it AFTER main spec tokens so it doesn't crowd out measure/pack/feature.
      pushB(brand);
      pushB(mounting);

      // Keep short model/series tokens only (e.g. IKEA RANARP). Avoid long generic phrases.
      const modelWords = safeString(modelOrSeries).split(/\s+/g).filter(Boolean);
      if (modelOrSeries && modelWords.length <= 2 && safeString(modelOrSeries).length <= 20) {
        pushB(modelOrSeries);
      }
      pushB(power);

      // As last resort, keep only high-signal spec tokens (avoid clutter like "1.5cm").
      const keepHomeSpec = (tok) => {
        const t = safeString(tok).toLowerCase();
        if (!t) return false;
        if (/\b\d{1,4}x\d{1,4}(?:x\d{1,4})?(mm|cm|m)\b/.test(t)) return true;
        if (/\b\d{1,5}(?:\.\d+)?[-–]\d{1,5}(?:\.\d+)?(mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb|mhz|ghz|rpm)\b/.test(t)) return true;
        // Big single dimensions only (>=10cm / >=100mm)
        const dim = t.match(/^(\d{1,5}(?:\.\d+)?)(mm|cm|m)\b/);
        if (dim) {
          const val = parseFloat(dim[1]);
          if (!Number.isFinite(val)) return false;
          if (dim[2] === 'cm' && val < 10) return false;
          if (dim[2] === 'mm' && val < 100) return false;
          return true;
        }
        // Non-length units can be relevant
        if (/^(\d{1,5}(?:\.\d+)?)(l|ml|kg|g|w|kw|v|mah|gb|tb|mhz|ghz|rpm)\b/.test(t)) return true;
        return false;
      };
      specsFromText.filter(keepHomeSpec).forEach((t) => pushB(t));

      // Keep color only if we still have space (it is not part of the CSV template).
      // Note: brand already added above; keep condition last only if explicitly curated.
      pushC(color);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'kitchen_household': {
      // [MARKE] [PRODUKTART] [TECHNOLOGIE/KOMPATIBILITÄT] [MAßE/VOLUMEN]
      pushA(brand);
      pushA(productType);
      pushA(techCompat);
      // If tech-compat is missing but "Induktion" is clearly present, keep it.
      if (!techCompat && /\binduktion\b/i.test(titleHint)) pushB('Induktion');
      pushB(measure);
      pushB(capacity);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'beauty': {
      // [MARKE] [LINIE] [PRODUKTART] [WIRKUNG] [MENGE]
      pushA(brand);
      pushA(line);
      pushA(productType);
      pushB(effect);
      pushB(amount);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'sport': {
      // [MARKE] [SPORTART] [PRODUKTART] [MASSE] [GROESSE] [MODELL (falls buyer-relevant)]
      pushA(brand);
      pushA(sportType);
      pushA(productType);
      pushB(measure);
      pushB(normSize);
      pushB(material);
      pushB(function1);
      if (modelOrMpn && shouldKeepModelTokenForSchema(schemaId, modelOrMpn)) {
        pushB(modelOrMpn);
      }
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'toys_baby': {
      // Toys/Baby is broad. Special-case child car seats for better buyer-keyword titles.
      const categoryCtx = safeString(product?.identification?.category);
      const hintNorm = normalizeForSearch([categoryCtx, productTypeRaw, proposedTitle, titleHint].filter(Boolean).join(' '));
      const isChildSeat =
        /\b(kind(?:er)?sitz|autokindersitz|autositz)\b/.test(hintNorm) ||
        /\bi[-\s]?size\b/.test(hintNorm) ||
        /\bece\b/.test(hintNorm);

      if (isChildSeat) {
        const seatType =
          /\bauto\b/.test(hintNorm) || /\bauto[-\s]?kindersitz/.test(hintNorm) || /\bauto[-\s]?kindersitze/.test(hintNorm)
            ? 'Autokindersitz'
            : productType || 'Kindersitz';
        const rotation = /360\s*°|360°|\b360\s*(?:grad|degree)\b/i.test(hintText) ? '360°' : '';
        const isize = /\bi[-\s]?size\b/i.test(hintText) ? 'i-Size' : '';
        const ece = /\bece\b/i.test(hintText) && /\br\s*129\b/i.test(hintText) ? 'ECE R129' : '';
        const range = normalizeTitleToken(extractFirstDimensionRangeToken(hintText));
        const isofix = /\bisofix\b/i.test(hintText) ? 'ISOFIX' : '';

        // [MARKE] [MODELL] [AUTOKINDERSITZ] [360°] [i-Size] [40-150cm] [ECE R129] [FARBE] [MPN]
        pushA(brand);
        pushA(model);
        pushA(seatType);
        pushB(rotation);
        pushB(isize);
        pushB(range);
        pushB(ece);
        pushB(isofix);
        pushB(color);
        pushC(mpn || modelOrMpn);
        return { schemaId, a, b, c };
      }

      // Default template: [MARKE] [LIZENZ/THEMA] [PRODUKT] [MODELL] [ALTER/GRÖSSE]
      pushA(brand);
      pushA(theme);
      pushA(productType);
      pushB(modelOrMpn);
      pushB(age);
      pushB(normSize);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'office': {
      // [MARKE] [PRODUKTART] [MODELL] [MENGE/PACKUNG]
      pushA(brand);
      pushA(productType);
      pushA(modelOrMpn);
      pushB(packSize);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'watches_jewelry': {
      // [MARKE] [MATERIAL/LEGIERUNG] [PRODUKTART] [STEIN/BESATZ] [ZUSTAND]
      pushA(brand);
      pushA(alloy);
      pushA(productType);
      pushB(stone);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'videogames': {
      // [PLATTFORM] [SPIELTITEL] [EDITION] [ZUSTAND] [USK]
      const gameTitle =
        normalizeTitleToken(pickAttr(attrs, 'Spieltitel', 'Titel')) ||
        normalizeTitleToken(stripSkuNoise(product?.identification?.name || proposedTitle || ''));
      pushA(platform);
      pushA(gameTitle);
      pushB(edition);
      pushB(condition);
      pushC(usk);
      return { schemaId, a, b, c };
    }
    case 'books': {
      // [AUTOR] [BUCHTITEL] [FORMAT] [SPRACHE] [BESONDERHEIT]
      const author = normalizeTitleToken(pickAttr(attrs, 'Autor'));
      const bookTitle =
        normalizeTitleToken(pickAttr(attrs, 'Buchtitel', 'Titel')) ||
        normalizeTitleToken(stripSkuNoise(product?.identification?.name || ''));
      const format = normalizeTitleToken(pickAttr(attrs, 'Einband', 'Format'));
      const language = normalizeTitleToken(pickAttr(attrs, 'Sprache'));
      const special = normalizeTitleToken(pickAttr(attrs, 'Besonderheit', 'Edition', 'Ausgabe'));
      pushA(author);
      pushA(bookTitle);
      pushB(format);
      pushB(language);
      pushC(special);
      return { schemaId, a, b, c };
    }
    case 'music': {
      // [INTERPRET] [ALBUMTITEL] [FORMAT] [GENRE] [BESONDERHEIT]
      const artist = normalizeTitleToken(pickAttr(attrs, 'Künstler', 'Interpret', 'Autor'));
      const album = normalizeTitleToken(pickAttr(attrs, 'Albumtitel', 'Titel')) || normalizeTitleToken(stripSkuNoise(product?.identification?.name || ''));
      const format = normalizeTitleToken(pickAttr(attrs, 'Format'));
      const special = normalizeTitleToken(pickAttr(attrs, 'Besonderheit', 'Edition', 'Ausgabe'));
      pushA(artist);
      pushA(album);
      pushB(format);
      pushB(genre);
      pushC(special);
      return { schemaId, a, b, c };
    }
    case 'movies': {
      // [FILMTITEL] [FORMAT] [EDITION/CUT] [GENRE] [ZUSTAND]
      const film = normalizeTitleToken(pickAttr(attrs, 'Filmtitel', 'Titel')) || normalizeTitleToken(stripSkuNoise(product?.identification?.name || ''));
      const format = normalizeTitleToken(pickAttr(attrs, 'Format'));
      pushA(film);
      pushA(format);
      pushB(edition);
      pushB(genre);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'pet': {
      // [MARKE] [TIERART] [PRODUKTART] [GRÖSSE/GEWICHT] [FEATURE]
      pushA(brand);
      pushA(animal);
      pushA(productType);
      pushB(sizeWeight);
      pushB(extraFeature);
      pushC(color);
      return { schemaId, a, b, c };
    }
    case 'collectibles': {
      // [LAND] [NENNWERT/MOTIV] [JAHR] [ERHALTUNGSGRAD] [MATERIAL]
      pushA(country);
      pushA(faceValue);
      pushA(year);
      pushB(grade);
      pushC(material);
      return { schemaId, a, b, c };
    }
    case 'photo_camcorder': {
      // [MARKE] [MODELL] [OBJEKTIV-TYP] [AUFLÖSUNG] [ZUSTAND]
      pushA(brand);
      pushA(modelOrMpn);
      pushA(lensType || productType);
      pushB(resolution);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'instruments': {
      // [MARKE] [INSTRUMENT] [TYP/MODELL] [MATERIAL/STIMMUNG] [ZUBEHÖR]
      pushA(brand);
      pushA(instrument || productType);
      pushA(modelOrMpn);
      pushB(material);
      pushB(tuning);
      pushC(accessories);
      return { schemaId, a, b, c };
    }
    case 'tools_diy': {
      // [MARKE] [WERKZEUGART] [VOLT/LEISTUNG] [ENERGIEQUELLE] [ZUBEHÖR]
      pushA(brand);
      pushA(productType);
      pushA(voltage || power);
      pushB(power);
      pushB(voltage);
      pushB(energySource);
      pushC(accessories);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    default: {
      // Generic fallback
      pushA(brand);
      pushA(productType);
      pushA(modelOrMpn);
      pushB(measure);
      pushB(capacity);
      pushB(power);
      pushB(voltage);
      pushB(audience);
      pushB(normSize);
      pushB(material);
      specsFromText.forEach((t) => pushB(t));
      pushC(color);
      pushC(condition);
      return { schemaId: schemaId || 'generic', a, b, c };
    }
  }
}

function assembleTitleFromPlan(plan, { targetMinLen, softMaxLen, maxLen } = {}) {
  const hardMax = Number.isFinite(maxLen) ? maxLen : DEFAULT_TITLE_MAX_LEN;
  const softMax = Number.isFinite(softMaxLen) ? softMaxLen : DEFAULT_TITLE_SOFT_MAX_LEN;
  const targetMin = Number.isFinite(targetMinLen) ? targetMinLen : DEFAULT_TITLE_TARGET_MIN_LEN;

  const parts = [];

  const add = (token) => {
    const t = normalizeTitleToken(token);
    if (!t) return;
    if (parts.some((p) => normalizeMatch(p) === normalizeMatch(t))) return;
    const tentative = normalizeSpaces([...parts, t].join(' '));
    if (!tentative) return;
    if (tentative.length > hardMax) return;
    parts.push(t);
  };

  // Priority A (must be first)
  (plan?.a || []).forEach((t) => add(t));

  // Priority B (reach targetMin if possible, but prefer staying <= softMax)
  for (const t of plan?.b || []) {
    const current = normalizeSpaces(parts.join(' '));
    if (current.length >= softMax && current.length >= targetMin) break;
    add(t);
  }

  // Priority C (end tokens)
  for (const t of plan?.c || []) {
    const current = normalizeSpaces(parts.join(' '));
    if (current.length >= softMax && current.length >= targetMin) break;
    add(t);
  }

  // Token-level cleanup (avoid word-level truncation artifacts)
  if (parts.length) {
    parts[0] = normalizeSpaces(stripLeadingNonAlnum(parts[0]));
  }

  // Remove repeated words across tokens, but preserve token boundaries
  const seenWords = new Set();
  const cleanedTokens = [];
  for (const token of parts) {
    const words = safeString(token).split(/\s+/g).filter(Boolean);
    const kept = [];
    for (const w of words) {
      const key = normalizeMatch(w);
      if (!key) continue;
      if (seenWords.has(key)) continue;
      seenWords.add(key);
      kept.push(w);
    }
    const rebuilt = normalizeSpaces(kept.join(' '));
    if (rebuilt) cleanedTokens.push(rebuilt);
  }

  const aCount = Array.isArray(plan?.a) ? plan.a.filter(Boolean).length : 0;

  // If > softMax, drop tail TOKENS (never drop A tokens)
  // IMPORTANT: softMax is a preference, minLen/targetMin is the policy requirement.
  // Never drop below targetMin just to satisfy softMax.
  while (normalizeSpaces(cleanedTokens.join(' ')).length > softMax && cleanedTokens.length > aCount) {
    const nextTokens = cleanedTokens.slice(0, -1);
    const nextTitle = normalizeSpaces(nextTokens.join(' '));
    if (nextTitle.length < targetMin) break;
    cleanedTokens.pop();
  }

  let title = normalizeSpaces(cleanedTokens.join(' '));
  if (title.length > hardMax) {
    title = truncateToMax(title, hardMax);
  }
  // Final: no trailing punctuation/symbols
  title = title.replace(/[\p{P}\p{S}]+$/gu, '').trim();
  return title;
}

function validateTitleToPolicy(
  product,
  title,
  { minLen = DEFAULT_TITLE_TARGET_MIN_LEN, maxLen = DEFAULT_TITLE_MAX_LEN, mobileMaxLen = DEFAULT_TITLE_MOBILE_PRIORITY_MAX_LEN } = {}
) {
  // When title policy is disabled, validation is a no-op (we rely on deterministic truncate/sanitize only).
  if (isTitlePolicyDisabled()) {
    return [];
  }
  const issues = [];
  const raw = safeString(title);
  const t = normalizeSpaces(stripEmojis(raw));

  if (!t) return ['title_missing'];
  if (Number.isFinite(Number(minLen)) && t.length < Number(minLen)) issues.push('title_too_short');
  if (t.length > maxLen) issues.push('title_too_long');

  if (raw && raw.match(/^[^\p{L}\p{N}]+/u)) {
    issues.push('title_starts_with_symbol');
  }
  const cleanedTail = stripDanglingTailTokens(t);
  if (cleanedTail !== t) {
    issues.push('title_dangling_tail');
  }
  const firstWord = safeString(t.split(/\s+/g)[0] || '').toLowerCase();
  const runtime = getRuntimeMarketingWords();
  if (runtime.has(firstWord) || ['hochwert', 'robust', 'vielseit', 'nachhalt', 'stilvoll', 'stylish', 'premium', 'angebot', 'original', 'neu', 'top'].some((r) => firstWord.startsWith(r))) {
    issues.push('title_starts_with_marketing');
  }

  const schemaId = inferSchemaId(product);
  const plan = buildTitlePlanBySchema(product, schemaId, { proposedTitle: '' });
  const aTokens = Array.isArray(plan?.a) ? plan.a.filter(Boolean) : [];

  // Schema-driven Priority A enforcement:
  // - If aTokens are missing (empty/"Unbekannt"), we surface a source-quality issue.
  // - If present, they must appear in the title and start within the first ~60 chars.
  if (aTokens.length) {
    const hasMissingA = aTokens.some((tok) => !tok || /^unbekannt$/i.test(tok));
    if (hasMissingA) issues.push('priority_a_source_missing');

    const firstN = t.slice(0, mobileMaxLen);
    for (const tok of aTokens) {
      if (!tok) continue;
      if (!containsToken(t, tok)) issues.push('priority_a_missing_in_title');
      const anchor = safeString(tok).split(/\s+/g).filter(Boolean)[0] || tok;
      if (!containsToken(firstN, anchor)) issues.push('priority_a_not_in_first_60');
    }

    // Order check: Priority A tokens must appear in the same order as the schema plan.
    const norm = normalizeForSearch(t);
    const idx = (token) => {
      const q = normalizeForSearch(token);
      if (!q) return -1;
      return norm.indexOf(q);
    };
    const indices = aTokens.map((tok) => idx(tok)).filter((i) => i !== -1);
    for (let i = 1; i < indices.length; i++) {
      if (indices[i - 1] > indices[i]) {
        issues.push('order_priority_a');
        break;
      }
    }
  }

  // Duplicate words
  const words = t.split(/\s+/g).filter(Boolean);
  const seenWords = new Set();
  for (const w of words) {
    const key = normalizeMatch(w);
    if (!key) continue;
    if (seenWords.has(key)) {
      issues.push('duplicate_word');
      break;
    }
    seenWords.add(key);
  }

  return Array.from(new Set(issues));
}

function buildBaseTitleBySchema(product, schemaId) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  const brand = safeString(product?.identification?.brand);
  const productType =
    pickAttr(attrs, 'Produktart', 'Produkttyp', 'Produkttyp (Produktart)') ||
    normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '');
  const model = pickAttr(attrs, 'Modell', 'Model', 'Model Number');
  const color = pickAttr(attrs, 'Farbe', 'Color');
  const sizeRaw = pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße', 'Größe', 'Size');
  const size = sizeRaw ? (/\bgr\.?|größe\b/i.test(sizeRaw) ? sizeRaw : `Gr. ${sizeRaw}`) : '';
  const material = pickAttr(attrs, 'Material', 'Obermaterial', 'Gewebeart', 'Futtermaterial');
  const condition = inferCondition(product);
  const mpn = safeString(product?.details?.identifiers?.mpn) || pickAttr(attrs, 'Herstellernummer');

  const join = (...parts) => normalizeSpaces(parts.filter(Boolean).join(' '));

  switch (schemaId) {
    case 'books': {
      const author = pickAttr(attrs, 'Autor');
      const title = pickAttr(attrs, 'Buchtitel') || stripSkuNoise(product?.identification?.name || '');
      const year = pickAttr(attrs, 'Erscheinungsjahr');
      const binding = pickAttr(attrs, 'Einband', 'Format');
      const state = condition;
      const dash = author ? `${author} – ${title}` : title;
      return join(dash, year, binding, state);
    }
    case 'clothing': {
      const audience = pickAttr(attrs, 'Abteilung', 'Zielgruppe');
      return join(brand, productType, audience, color, size, material, condition);
    }
    case 'home_build': {
      const series = pickAttr(attrs, 'Serie', 'Produktserie', 'Reihe', 'Produktlinie', 'Serienname', 'Baureihe');
      const function1 = pickAttr(
        attrs,
        'Funktion 1',
        'Funktion',
        'Anwendung',
        'Anwendungsbereich',
        'Einsatzbereich',
        'Verwendungszweck',
        'Verwendung',
        'Geeignet für'
      );
      const measure = pickAttr(attrs, 'Maße', 'Abmessungen', 'Durchmesser', 'Länge', 'Breite', 'Höhe', 'Tiefe');
      const capacity = pickAttr(attrs, 'Fassungsvermögen gesamt', 'Fassungsvermögen', 'Volumen', 'Kapazität');
      const power = pickAttr(attrs, 'Leistung', 'Power');
      const voltage = pickAttr(attrs, 'Spannung', 'Volt', 'Voltage');
      const core = measure || capacity || power || voltage || material || '';
      const modelOrSeries = series || model || mpn || '';
      return join(brand, modelOrSeries, productType, function1, core, condition);
    }
    case 'auto_mech': {
      const vehicleMake = pickAttr(attrs, 'Fahrzeugmarke', 'Hersteller');
      const measure = pickAttr(attrs, 'Durchmesser', 'Breite', 'Dicke', 'Bildschirmgröße', 'Lochkreis');
      const feature = pickAttr(attrs, 'Bremsscheibenart', 'Einbauposition', 'Oberflächenbeschaffenheit');
      // Keep "für" as structural keyword
      return join(brand, productType, mpn, vehicleMake ? `für ${vehicleMake}` : '', measure, feature, condition);
    }
    case 'auto_accessory': {
      const vehicleMake = pickAttr(attrs, 'Fahrzeugmarke', 'Hersteller');
      const vehicleModel = pickAttr(attrs, 'Fahrzeugmodell', 'Modell');
      const series = pickAttr(attrs, 'Baureihe');
      return join(productType, 'passgenau für', vehicleMake, vehicleModel, series, condition);
    }
    case 'electronics': {
      const variant = pickAttr(attrs, 'Variante');
      return join(brand, productType, model, variant, color, condition);
    }
    default:
      return join(brand, productType, model, mpn, color, size, material, condition);
  }
}

function appendTokens(title, tokens, { minLen, maxLen }) {
  let out = normalizeSpaces(title);
  for (const token of tokens) {
    if (!token) continue;
    if (containsToken(out, token)) continue;
    const tentative = normalizeSpaces(`${out} ${token}`);
    if (tentative.length > maxLen) continue;
    out = tentative;
    if (out.length >= minLen) break;
  }
  return out;
}

function coerceTitleToPolicy(
  product,
  proposedTitle,
  {
    minLen = DEFAULT_TITLE_TARGET_MIN_LEN,
    maxLen = DEFAULT_TITLE_MAX_LEN,
    softMaxLen = DEFAULT_TITLE_SOFT_MAX_LEN,
    extraHintTokens = [],
    forcePolicy = false,
  } = {}
) {
  // Web-only mode: do NOT apply schema rules. Keep only minimal sanitization + hard max length.
  if (!forcePolicy && isTitlePolicyDisabled()) {
    let t = stripEmojis(proposedTitle || '');
    t = stripMarkdownDecorations(t);
    t = stripSkuNoise(t);
    t = normalizeSpaces(t);
    t = stripLeadingNonAlnum(t);
    t = normalizeSpaces(t);
    t = applyBuyerSearchTitleCasing(t);
    if (t.length > maxLen) t = truncateToMax(t, maxLen);
    return t;
  }
  const conditionLocked = Boolean(product?.ops?.condition_locked);

  // Clean the incoming title: we only use it as a hint source for specs.
  let hintTitle = stripSkuNoise(proposedTitle || '');
  hintTitle = stripEmojis(hintTitle);
  hintTitle = stripMarketingWords(hintTitle);
  if (!conditionLocked) {
    hintTitle = stripUsedCondition(hintTitle);
  }
  const injectedHints = Array.isArray(extraHintTokens)
    ? extraHintTokens.map((v) => normalizeTitleToken(v)).filter(Boolean).slice(0, 12)
    : [];
  if (injectedHints.length) {
    hintTitle = normalizeSpaces([hintTitle, ...injectedHints].join(' '));
  }
  hintTitle = normalizeSpaces(hintTitle);

  const schemaId = inferSchemaId(product);
  const plan = buildTitlePlanBySchema(product, schemaId, { proposedTitle: hintTitle });
  // If we have explicit hint tokens (eBay top search tokens), treat them as additional spec candidates.
  // This helps reach the target length without inventing new facts.
  if (injectedHints.length) {
    plan.b = Array.isArray(plan?.b) ? [...plan.b, ...injectedHints] : [...injectedHints];
  }

  const targetMinLen = Math.min(Math.max(20, Number(minLen) || DEFAULT_TITLE_TARGET_MIN_LEN), maxLen);

  let title = assembleTitleFromPlan(plan, {
    targetMinLen,
    softMaxLen,
    maxLen,
  });
  // If we still didn't reach the target length, append remaining hint tokens (best-effort, still deterministic).
  if (injectedHints.length && title.length < targetMinLen) {
    title = appendTokens(title, injectedHints, { minLen: targetMinLen, maxLen });
  }

  if (!conditionLocked) {
    title = stripUsedCondition(title);
    title = normalizeSpaces(title);
  }
  title = stripLeadingNonAlnum(title);
  title = normalizeSpaces(title);
  if (title.length > maxLen) title = truncateToMax(title, maxLen);
  title = stripDanglingTailTokens(title);
  title = applyBuyerSearchTitleCasing(title);
  title = normalizeSpaces(title);
  if (title.length > maxLen) title = truncateToMax(title, maxLen);
  return title;
}

module.exports = {
  coerceTitleToPolicy,
  validateTitleToPolicy,
  inferTitleCategory,
};
