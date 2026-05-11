'use strict';

/**
 * cassini-scorer.js
 *
 * Wrapper around `lib/datasheet-quality.evaluateEbayReady()` that produces a
 * Cassini-aligned 7-Pillar quality score for a product, mapped onto 5 sub-scores
 * (title, description, image, specifics, compliance) plus an overall weighted
 * mean in [0, 1].
 *
 * Quality baseline: `Strategischer eBay Leitfaden.md` — 80-char title
 * architecture, ~200-word description with 5–7% keyword density, white
 * background main image, GTIN/EAN/MPN obligatory, no Active Content, no
 * keyword spamming.
 *
 * Pure function (no I/O). Defensive try/catch around the underlying
 * `evaluateEbayReady` call so the Critic-Worker never crashes on a quality-lib
 * bug.
 */

// Required lazily inside scoreProductCassini() so tests can patch the module
// via require.cache mutation (CJS pattern from CLAUDE.md). Capturing the
// destructured function reference at require-time would break that.
const datasheetQualityModule = require('./datasheet-quality');

// F.2.0 — 9-Pattern-Title-Enforcement: lazy-loaded so tests can patch.
let _cassiniCategoryMap = null;
try {
  // eslint-disable-next-line global-require
  _cassiniCategoryMap = require('./cassini-category-map');
} catch (_err) {
  _cassiniCategoryMap = null;
}

const SEVERITY_ERROR = 'error';
const SEVERITY_WARNING = 'warning';
const SEVERITY_INFO = 'info';

const WEIGHTS = Object.freeze({
  title: 0.25,
  description: 0.20,
  image: 0.20,
  specifics: 0.25,
  compliance: 0.10,
});

const TITLE_BAD_CHAR_PATTERN = /[&!_]/;
const TITLE_DOUBLE_DASH_PATTERN = /--/;

const MOBILE_SNIPPET_TAG_PATTERN = /(itemprop\s*=\s*["']description["'])|(typeof\s*=\s*["']Product["'])|(property\s*=\s*["']description["'])/i;
const ACTIVE_CONTENT_PATTERNS = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
];

const STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'oder', 'mit', 'ohne', 'für', 'fuer', 'im', 'am',
  'in', 'an', 'auf', 'zu', 'von', 'bei', 'aus', 'ab', 'the', 'a', 'an', 'and',
  'or', 'of', 'to', 'for', 'on', 'at', 'by', 'is', 'are', 'wir', 'sie',
  'er', 'es', 'ist', 'hat', 'sein', 'werden', 'ihre', 'ihr',
]);

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
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
    .filter(Boolean);
}

function nonStopTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length >= 2);
}

function getProductTitle(product) {
  return safeString(product?.identification?.name);
}

function getProductDescription(product) {
  return safeString(
    product?.details?.short_description || product?.details?.description
  );
}

function getProductBrand(product) {
  return safeString(product?.identification?.brand);
}

function getProductImages(product) {
  const imgs = product?.details?.images;
  return Array.isArray(imgs) ? imgs.filter(Boolean) : [];
}

/**
 * F.3 — detectKeywordSpamming(text, threshold = 0.07)
 *
 * Berechnet die maximale Token-Frequenz (non-stop tokens) im Text.
 * Liefert `true` wenn max-Token-Density > threshold (default 7 %).
 *
 * Quelle Strategischer eBay Leitfaden Sektion 7 Compliance + Sektion 4
 * Keyword-Dichte-Sweet-Spot 5-7 %.
 *
 * Pure function, no I/O. Wird sowohl vom zod-Schema-Validator als auch vom
 * post-generation Cassini-Scorer aufgerufen.
 *
 * @param {string} text
 * @param {number} [threshold] default 0.07 (7 %)
 * @returns {boolean} true wenn spamming-Risk erkannt
 */
function detectKeywordSpamming(text, threshold = 0.07) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const plain = text.replace(/<[^>]+>/g, ' ');
  const tokens = nonStopTokens(plain);
  if (tokens.length < 20) return false; // zu kurz für statistisch sinnvolle Density-Messung
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  const maxFreq = Math.max(...freq.values());
  const density = maxFreq / tokens.length;
  return density > threshold;
}

function getRequiredAspectsList(product) {
  const required = product?.details?.attributes?.requiredAspects;
  if (Array.isArray(required)) return required.filter(Boolean);
  if (required && typeof required === 'object') return Object.keys(required);
  return [];
}

function getAttrValue(attrs, key) {
  if (!attrs || typeof attrs !== 'object') return '';
  const direct = attrs[key];
  if (direct != null && String(direct).trim()) return String(direct).trim();
  const lowerKey = String(key).toLowerCase();
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof k !== 'string') continue;
    if (k.toLowerCase() === lowerKey && v != null && String(v).trim()) {
      return String(v).trim();
    }
  }
  return '';
}

/**
 * Defensive product-identifier lookup across all known write-paths.
 *
 * Real write-paths used by `assembleProductV4` (`services/identify-v4.js:686-709`)
 * und `assembleProduct` (`services/identify-v3.js:408-432`) — verified 2026-05-11:
 *   1. `details.identifiers.{gtin|ean|upc|mpn}`    ← V3 + V4 authoritative
 *   2. `identification.barcodes: string[]`         ← V3 + V4, mixed ean/gtin/upc
 *   3. `details.attributes.{gtin|ean|upc|mpn}`     ← V4 aspect-map / attributes-worker
 *   4. `identification.{gtin|ean|upc|mpn}`         ← legacy/manual, kept for compat
 *
 * First non-empty value wins. Pure function, no side effects.
 *
 * @param {object} product
 * @param {'gtin'|'ean'|'upc'|'mpn'} kind
 * @returns {string}
 */
function lookupIdentifier(product, kind) {
  if (!product || typeof product !== 'object') return '';
  const key = String(kind || '').toLowerCase();
  if (!key) return '';

  // 1. details.identifiers.<kind>  ← authoritative write-path of V3/V4
  const idMap = product.details && product.details.identifiers;
  if (idMap && typeof idMap === 'object') {
    const v = safeString(idMap[key]);
    if (v) return v;
  }

  // 2. identification.barcodes[] — mixed bag of ean/gtin/upc strings.
  //    Detect by digit-length: GTIN-13 (EAN) = 13, GTIN-12 (UPC) = 12, GTIN-8 = 8.
  //    For `gtin` we accept any. For `ean` we require 13. For `upc` we require 12.
  //    MPN cannot be detected via barcodes (alphanumeric, no fixed format).
  const barcodes = product.identification && product.identification.barcodes;
  if (Array.isArray(barcodes) && key !== 'mpn') {
    const digitsOnly = barcodes
      .map((b) => safeString(b).replace(/\D/g, ''))
      .filter(Boolean);
    if (digitsOnly.length) {
      let match = '';
      if (key === 'gtin') {
        match = digitsOnly.find((d) => d.length === 13 || d.length === 12 || d.length === 8) || '';
      } else if (key === 'ean') {
        match = digitsOnly.find((d) => d.length === 13) || '';
      } else if (key === 'upc') {
        match = digitsOnly.find((d) => d.length === 12) || '';
      }
      if (match) return match;
    }
  }

  // 3. details.attributes.<kind>  ← V4 aspect map (e.g. from attributes-worker)
  const attrs = product.details && product.details.attributes;
  const fromAttr = getAttrValue(attrs, key);
  if (fromAttr) return fromAttr;

  // 4. identification.<kind>  ← legacy/manual/test-fixtures fallback
  const ident = product.identification;
  if (ident && typeof ident === 'object') {
    const v = safeString(ident[key]);
    if (v) return v;
  }

  return '';
}

// ----------------------------------------------------------------------------
// Sub-scorers
// ----------------------------------------------------------------------------

/**
 * scoreTitle(product)
 *
 * Cassini-Pillar: Relevance + Listing-Qualität (Leitfaden §3 "80-Zeichen-Meisterschaft").
 *
 * Heuristics (F.0+ baseline — 9-pattern-implementation deferred to F.2):
 *   - 80-char usage: length / 80, capped at 1.0 (full usage rewarded).
 *   - Brand in first 5 words: penalize if absent (mobile CTR).
 *   - No special characters (&, !, _) outside basic punctuation.
 *   - No double-dashes / keyword-stuffing markers.
 */
function scoreTitle(product) {
  const issues = [];
  const title = getProductTitle(product);
  const brand = getProductBrand(product);

  if (!title) {
    issues.push({
      rule: 'title_missing',
      severity: SEVERITY_ERROR,
      message: 'Title is empty.',
      leitfaden_section: '3. 80-Zeichen-Meisterschaft',
    });
    return { score: 0, issues };
  }

  // Sub-component 1: 80-char usage.
  const lenScore = clamp01(title.length / 80);
  if (title.length < 40) {
    issues.push({
      rule: 'title_too_short',
      severity: SEVERITY_WARNING,
      message: `Title only uses ${title.length} of 80 chars; long-tail-keyword potential lost.`,
      leitfaden_section: '3. 80-Zeichen-Meisterschaft',
    });
  }
  if (title.length > 80) {
    issues.push({
      rule: 'title_over_max',
      severity: SEVERITY_WARNING,
      message: `Title exceeds 80 chars (${title.length}); tail will be truncated.`,
      leitfaden_section: '3. 80-Zeichen-Meisterschaft',
    });
  }

  // Sub-component 2: Brand in first 5 tokens.
  let brandScore = 0;
  const tokens = title.split(/\s+/).filter(Boolean);
  if (brand) {
    const first5 = tokens.slice(0, 5).join(' ').toLowerCase();
    if (first5.includes(brand.toLowerCase())) {
      brandScore = 1;
    } else {
      issues.push({
        rule: 'title_brand_not_first_5',
        severity: SEVERITY_WARNING,
        message: `Brand "${brand}" not in first 5 words; mobile CTR suffers.`,
        leitfaden_section: '3. Priorisierung — erste 3-5 Wörter',
      });
    }
  } else {
    // No brand recorded → defensive 0.5 (cannot positively reward).
    brandScore = 0.5;
    issues.push({
      rule: 'title_brand_unknown',
      severity: SEVERITY_INFO,
      message: 'No brand recorded on product; cannot verify first-5-words rule.',
      leitfaden_section: '3. Priorisierung — erste 3-5 Wörter',
    });
  }

  // Sub-component 3: Special-character / spam check.
  let specialCharScore = 1;
  if (TITLE_BAD_CHAR_PATTERN.test(title)) {
    specialCharScore -= 0.4;
    issues.push({
      rule: 'title_special_chars',
      severity: SEVERITY_WARNING,
      message: 'Title contains forbidden chars (& ! _); breaks Cassini token-indexing.',
      leitfaden_section: '3. Sonderzeichen-Verbot',
    });
  }
  if (TITLE_DOUBLE_DASH_PATTERN.test(title)) {
    specialCharScore -= 0.2;
    issues.push({
      rule: 'title_double_dash',
      severity: SEVERITY_INFO,
      message: 'Title has "--"; single hyphen is the optical-separator maximum.',
      leitfaden_section: '3. Sonderzeichen-Verbot',
    });
  }
  specialCharScore = clamp01(specialCharScore);

  // F.2.0 — 9-Pattern-Title-Enforcement (additive).
  // Wenn category bekannt: prüfe ob essentielle Pattern-Slots gefüllt sind.
  // titlePatternMatch = Anteil der erwarteten Slots, deren Inhalt im Titel
  // erkennbar ist. Brand zählt IMMER (wird oben bereits gemessen), Modell +
  // kategorie-spezifische Slots werden zusätzlich getestet.
  const patternResult = scoreTitlePatternMatch(product, title, tokens);
  let titlePatternMatch = patternResult.score;
  if (patternResult.bucket && patternResult.expectedSlots > 0) {
    if (titlePatternMatch < 0.5) {
      issues.push({
        rule: 'title_pattern_slots_missing',
        severity: SEVERITY_WARNING,
        message: `Titel füllt nur ${Math.round(titlePatternMatch * 100)}% der erwarteten Pattern-Slots für Bucket "${patternResult.bucket}" (${patternResult.missingSlots.join(', ') || 'mehrere'}).`,
        leitfaden_section: '9. Kategorie-spezifische Title-Patterns',
      });
    }
  }

  // Weighted (F.2.0):
  //   - kein Bucket / kein Pattern: alte Gewichtung (length 0.4, brand 0.4, specials 0.2).
  //   - mit Bucket: length 0.3, brand 0.3, specials 0.15, patternMatch 0.25.
  let score;
  if (patternResult.bucket && patternResult.expectedSlots > 0) {
    score = clamp01(
      lenScore * 0.3 + brandScore * 0.3 + specialCharScore * 0.15 + titlePatternMatch * 0.25
    );
  } else {
    score = clamp01(
      lenScore * 0.4 + brandScore * 0.4 + specialCharScore * 0.2
    );
  }

  return {
    score,
    titlePatternMatch: Math.round(titlePatternMatch * 1000) / 1000,
    patternBucket: patternResult.bucket || null,
    issues,
  };
}

/**
 * F.2.0 — scoreTitlePatternMatch(product, title, titleTokens)
 *
 * Bestimmt für das Produkt den Cassini-Bucket via cassini-category-map +
 * misst den Anteil der erwarteten Pattern-Slots, die im Titel auftauchen.
 *
 * Slots werden heuristisch geprüft:
 *  - Brand-Slots: identification.brand muss im Titel sein.
 *  - Modell/Modellname/Modellnummer/MPN: identification.model oder
 *    attributes.MPN/Modell/Modellnummer-Werte werden tokenisiert
 *    und auf Vorkommen geprüft.
 *  - Material/Farbe/Größe/Sportart/etc.: aspect-Werte aus details.attributes
 *    werden geprüft.
 *
 * Liefert { score: 0..1, bucket, expectedSlots, hitSlots, missingSlots }.
 */
function scoreTitlePatternMatch(product, title, titleTokens) {
  const empty = { score: 1, bucket: null, expectedSlots: 0, hitSlots: 0, missingSlots: [] };
  if (!title || !_cassiniCategoryMap) return empty;
  const getBucket = _cassiniCategoryMap.getCassiniCategoryBucket;
  const getPattern = _cassiniCategoryMap.getCategoryPattern;
  if (typeof getBucket !== 'function' || typeof getPattern !== 'function') return empty;

  const catId =
    safeString(product?.details?.categoryId) ||
    safeString(product?.details?.ebayCategoryId);
  const breadcrumb =
    product?.details?.categoryBreadcrumb ||
    product?.identification?.category ||
    null;
  const bucket = getBucket(catId, breadcrumb);
  if (!bucket || bucket === 'default') return empty;

  const pattern = getPattern(bucket);
  if (!pattern) return empty;

  // Extract slot-labels: alle [<slot>]-Tokens.
  const slotMatches = pattern.match(/\[[^\]]+\]/g) || [];
  if (!slotMatches.length) return empty;

  const titleLower = title.toLowerCase();
  const titleTokenSet = new Set(
    (Array.isArray(titleTokens) ? titleTokens : title.split(/\s+/))
      .map((t) => String(t).toLowerCase())
      .filter(Boolean)
  );
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  function slotPresent(slotLabel) {
    const labelLower = slotLabel.toLowerCase().replace(/[[\]]/g, '');
    // Slot → candidate attribute keys (rough heuristic, multiple keys per slot).
    const candidates = [];
    if (labelLower.includes('marke') || labelLower.includes('hersteller')) {
      candidates.push(getProductBrand(product));
    }
    if (labelLower.includes('modell') || labelLower.includes('mpn') || labelLower.includes('referenz') || labelLower.includes('oem')) {
      candidates.push(
        safeString(product?.identification?.model),
        getAttrValue(attrs, 'mpn'),
        getAttrValue(attrs, 'Modell'),
        getAttrValue(attrs, 'Modellname'),
        getAttrValue(attrs, 'Modellnummer'),
        getAttrValue(attrs, 'Herstellernummer'),
        getAttrValue(attrs, 'OEM-Nummer'),
        getAttrValue(attrs, 'Referenznummer')
      );
    }
    if (labelLower.includes('material')) {
      candidates.push(getAttrValue(attrs, 'Material'));
    }
    if (labelLower.includes('farbe')) {
      candidates.push(getAttrValue(attrs, 'Farbe'));
    }
    if (labelLower.includes('größe') || labelLower.includes('groesse') || labelLower.includes('maße')) {
      candidates.push(
        getAttrValue(attrs, 'Größe'),
        getAttrValue(attrs, 'Groesse'),
        getAttrValue(attrs, 'Maße'),
        getAttrValue(attrs, 'Maße (LxBxH)')
      );
    }
    if (labelLower.includes('produkttyp') || labelLower.includes('produktart') || labelLower.includes('objektbezeichnung') || labelLower.includes('teilename') || labelLower.includes('geraetetyp') || labelLower.includes('produktbezeichnung')) {
      candidates.push(
        getAttrValue(attrs, 'Produktart'),
        getAttrValue(attrs, 'Produkttyp'),
        getAttrValue(attrs, 'Typ')
      );
    }
    if (labelLower.includes('zielgruppe')) {
      candidates.push(
        getAttrValue(attrs, 'Geschlecht'),
        getAttrValue(attrs, 'Zielgruppe')
      );
    }
    if (labelLower.includes('zustand') || labelLower.includes('grading')) {
      candidates.push(getAttrValue(attrs, 'Zustand'));
    }
    if (labelLower.includes('hauptmerkmal') || labelLower.includes('prozessor') || labelLower.includes('spezifikation') || labelLower.includes('leistung')) {
      candidates.push(
        getAttrValue(attrs, 'Prozessor'),
        getAttrValue(attrs, 'Leistung'),
        getAttrValue(attrs, 'Spezifikation')
      );
    }
    if (labelLower.includes('thema') || labelLower.includes('charakter')) {
      candidates.push(
        getAttrValue(attrs, 'Thema'),
        getAttrValue(attrs, 'Charakter')
      );
    }
    if (labelLower.includes('set-nummer') || labelLower.includes('setnummer')) {
      candidates.push(getAttrValue(attrs, 'Set-Nummer'));
    }
    if (labelLower.includes('stil') || labelLower.includes('design')) {
      candidates.push(
        getAttrValue(attrs, 'Stil'),
        getAttrValue(attrs, 'Design')
      );
    }
    if (labelLower.includes('einbauposition')) {
      candidates.push(getAttrValue(attrs, 'Einbauposition'));
    }
    if (labelLower.includes('autor') || labelLower.includes('kuenstler') || labelLower.includes('plattform')) {
      candidates.push(
        getAttrValue(attrs, 'Autor'),
        getAttrValue(attrs, 'Künstler'),
        getAttrValue(attrs, 'Plattform')
      );
    }
    if (labelLower.includes('titel')) {
      candidates.push(
        getAttrValue(attrs, 'Titel'),
        safeString(product?.identification?.name)
      );
    }
    if (labelLower.includes('format') || labelLower.includes('medium')) {
      candidates.push(
        getAttrValue(attrs, 'Format'),
        getAttrValue(attrs, 'Medium')
      );
    }
    if (labelLower.includes('edition') || labelLower.includes('besonderheit')) {
      candidates.push(
        getAttrValue(attrs, 'Edition'),
        getAttrValue(attrs, 'Besonderheit')
      );
    }
    if (labelLower.includes('jahr') || labelLower.includes('epoche')) {
      candidates.push(
        getAttrValue(attrs, 'Jahr'),
        getAttrValue(attrs, 'Epoche'),
        getAttrValue(attrs, 'Baujahr')
      );
    }
    if (labelLower.includes('sportart') || labelLower.includes('aktivitaet')) {
      candidates.push(
        getAttrValue(attrs, 'Sportart'),
        getAttrValue(attrs, 'Aktivität')
      );
    }

    // Match: any candidate value tokenized must overlap with title tokens.
    for (const cand of candidates) {
      if (!cand) continue;
      const candStr = String(cand).toLowerCase().trim();
      if (!candStr) continue;
      // Exact substring match against full title.
      if (titleLower.includes(candStr)) return true;
      // Otherwise tokenize and require >=1 non-stop token overlap.
      const candToks = candStr.split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
      for (const ct of candToks) {
        if (titleTokenSet.has(ct)) return true;
      }
    }
    return false;
  }

  const hitSlots = [];
  const missingSlots = [];
  for (const slot of slotMatches) {
    if (slotPresent(slot)) hitSlots.push(slot);
    else missingSlots.push(slot);
  }
  const expected = slotMatches.length;
  const score = expected > 0 ? hitSlots.length / expected : 1;

  return {
    score: clamp01(score),
    bucket,
    expectedSlots: expected,
    hitSlots: hitSlots.length,
    missingSlots,
  };
}

/**
 * scoreDescription(product)
 *
 * Cassini-Pillar: Relevance + Quality (Leitfaden §4 "200 Wörter, 5-7% Keyword-Dichte"
 * und §5 "Mobile Kurzbeschreibung").
 *
 * Heuristics:
 *   - Word-count: 180-220 → 1.0; 100-179 or 221-260 → 0.5; sonst 0.2.
 *   - Keyword-density: top-3 title-tokens, 5-7% → 1.0; 3-8% → 0.6; sonst 0.3.
 *   - Mobile snippet present (itemprop="description" or schema.org Product).
 */
function scoreDescription(product) {
  const issues = [];
  const html = getProductDescription(product);

  if (!html) {
    issues.push({
      rule: 'description_missing',
      severity: SEVERITY_ERROR,
      message: 'Description is empty.',
      leitfaden_section: '4. KI-gestützte Content-Transformation',
    });
    return { score: 0, issues };
  }

  // Strip HTML for word-count.
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;

  let wordScore;
  if (wordCount >= 180 && wordCount <= 220) {
    wordScore = 1.0;
  } else if ((wordCount >= 100 && wordCount < 180) || (wordCount > 220 && wordCount <= 260)) {
    wordScore = 0.5;
    issues.push({
      rule: 'description_word_count_off_target',
      severity: SEVERITY_WARNING,
      message: `Description has ${wordCount} words; target is 180-220 (Leitfaden §4).`,
      leitfaden_section: '4. Content-KPIs',
    });
  } else {
    wordScore = 0.2;
    issues.push({
      rule: 'description_word_count_far_off',
      severity: SEVERITY_WARNING,
      message: `Description has ${wordCount} words; far from the 200-word target.`,
      leitfaden_section: '4. Content-KPIs',
    });
  }

  // Top-3 keyword density. Source: title non-stop tokens.
  const titleKeywords = nonStopTokens(getProductTitle(product)).slice(0, 3);
  const bodyTokens = tokenize(plainText).filter((t) => !STOPWORDS.has(t));
  const totalBodyTokens = bodyTokens.length;
  let densityPct = 0;
  if (titleKeywords.length && totalBodyTokens > 0) {
    let hits = 0;
    const freq = new Map();
    for (const t of bodyTokens) freq.set(t, (freq.get(t) || 0) + 1);
    for (const kw of titleKeywords) hits += freq.get(kw) || 0;
    densityPct = (hits / totalBodyTokens) * 100;
  }

  let densityScore;
  if (densityPct >= 5 && densityPct <= 7) {
    densityScore = 1.0;
  } else if (densityPct >= 3 && densityPct <= 8) {
    densityScore = 0.6;
    issues.push({
      rule: 'description_density_suboptimal',
      severity: SEVERITY_INFO,
      message: `Keyword-density ${densityPct.toFixed(2)}%; sweet-spot is 5-7%.`,
      leitfaden_section: '4. Keyword-Dichte 5-7%',
    });
  } else {
    densityScore = 0.3;
    issues.push({
      rule: 'description_density_off',
      severity: SEVERITY_WARNING,
      message: `Keyword-density ${densityPct.toFixed(2)}%; outside the 3-8% safe band.`,
      leitfaden_section: '4. Keyword-Dichte 5-7%',
    });
  }

  // Mobile-snippet presence (HTML tag with itemprop or schema.org marker).
  let mobileSnippetScore = 0;
  if (MOBILE_SNIPPET_TAG_PATTERN.test(html)) {
    mobileSnippetScore = 1;
  } else {
    issues.push({
      rule: 'description_no_mobile_snippet',
      severity: SEVERITY_INFO,
      message: 'No itemprop="description" / schema.org wrapper for mobile snippet.',
      leitfaden_section: '5. Mobile Kurzbeschreibung',
    });
  }

  // Weighted: words 0.5, density 0.3, mobile 0.2.
  const score = clamp01(
    wordScore * 0.5 + densityScore * 0.3 + mobileSnippetScore * 0.2
  );

  return { score, issues };
}

/**
 * scoreImage(product)
 *
 * Cassini-Pillar: Quality + Visual Verkaufspsychologie (Leitfaden §6).
 *
 * Heuristics:
 *   - >=1 image (binary).
 *   - Main-image resolution >=800px.
 *   - Background-white score (uses image-quality lib's `backgroundScore`).
 *   - >=3 images ideal (else: -0.2 from final).
 */
function scoreImage(product) {
  const issues = [];
  const images = getProductImages(product);

  if (!images.length) {
    issues.push({
      rule: 'image_missing',
      severity: SEVERITY_ERROR,
      message: 'Product has zero images.',
      leitfaden_section: '6. Visual Optimierung',
    });
    return { score: 0, issues };
  }

  const main = images[0] || {};
  const width = Number(main.width) || Number(main?.quality?.width) || 0;
  const height = Number(main.height) || Number(main?.quality?.height) || 0;
  const minDim = Math.min(width || 0, height || 0);

  let resolutionScore;
  if (minDim >= 800) {
    resolutionScore = 1;
  } else if (minDim >= 500) {
    resolutionScore = 0.5;
    issues.push({
      rule: 'image_low_resolution',
      severity: SEVERITY_WARNING,
      message: `Main image only ${minDim}px on shortest edge; target is ≥800px.`,
      leitfaden_section: '6. Standards 800-1600px',
    });
  } else if (minDim > 0) {
    resolutionScore = 0.2;
    issues.push({
      rule: 'image_far_below_resolution',
      severity: SEVERITY_WARNING,
      message: `Main image only ${minDim}px shortest edge; far below 800px.`,
      leitfaden_section: '6. Standards 800-1600px',
    });
  } else {
    resolutionScore = 0.4;
    issues.push({
      rule: 'image_unknown_resolution',
      severity: SEVERITY_INFO,
      message: 'Main image has no width/height metadata; cannot validate resolution.',
      leitfaden_section: '6. Standards 800-1600px',
    });
  }

  // Background-white score (Google Shopping requirement).
  const bgScore =
    typeof main.backgroundScore === 'number'
      ? main.backgroundScore
      : typeof main?.analysis?.backgroundScore === 'number'
        ? main.analysis.backgroundScore
        : null;
  let backgroundScoreNorm;
  if (bgScore == null) {
    backgroundScoreNorm = 0.5;
    issues.push({
      rule: 'image_background_unknown',
      severity: SEVERITY_INFO,
      message: 'No background-score on main image; cannot verify white background.',
      leitfaden_section: '6. Reiner weißer Hintergrund',
    });
  } else {
    backgroundScoreNorm = clamp01(bgScore);
    if (backgroundScoreNorm < 0.7) {
      issues.push({
        rule: 'image_background_not_white',
        severity: SEVERITY_WARNING,
        message: `Main image background-score ${backgroundScoreNorm.toFixed(2)}; ≥0.7 needed.`,
        leitfaden_section: '6. Reiner weißer Hintergrund',
      });
    }
  }

  // Image-count: >=3 ideal, else penalty.
  let countScore = 1;
  if (images.length < 3) {
    countScore = 0.6;
    issues.push({
      rule: 'image_count_low',
      severity: SEVERITY_INFO,
      message: `Only ${images.length} image(s); 3+ ideal for engagement.`,
      leitfaden_section: '6. Lifestyle-Szenen für Plätze 3-12',
    });
  }

  // Weighted: resolution 0.4, background 0.4, count 0.2.
  const score = clamp01(
    resolutionScore * 0.4 + backgroundScoreNorm * 0.4 + countScore * 0.2
  );

  return { score, issues };
}

/**
 * scoreSpecifics(product)
 *
 * Cassini-Pillar: Completeness + Relevance (Leitfaden §5 "Pflichtmerkmale" und
 * §3 Anhang "EAN/GTIN/MPN obligatorisch"). Critical: zero if no GTIN/EAN/MPN.
 */
function scoreSpecifics(product) {
  const issues = [];
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  // Defensive multi-path lookup — covers all real write-paths from V3/V4
  // assembleProduct (`details.identifiers.*`, `identification.barcodes[]`),
  // V4 aspect-map (`details.attributes.*`) and legacy/manual
  // (`identification.*`). See lookupIdentifier() doc for rationale.
  const gtin = lookupIdentifier(product, 'gtin');
  const ean = lookupIdentifier(product, 'ean');
  const upc = lookupIdentifier(product, 'upc');
  const mpn = lookupIdentifier(product, 'mpn');

  const hasIdentifier = Boolean(gtin || ean || upc || mpn);
  if (!hasIdentifier) {
    issues.push({
      rule: 'specifics_no_identifier',
      severity: SEVERITY_ERROR,
      message: 'No GTIN/EAN/UPC/MPN — obligatorisch für Google Shopping (Leitfaden §5).',
      leitfaden_section: '5. Artikelmerkmale',
    });
    return { score: 0, issues };
  }

  // Required-aspects fill rate.
  const required = getRequiredAspectsList(product);
  let fillRate = 0.7; // default if unknown
  if (required.length) {
    let filled = 0;
    for (const aspect of required) {
      const key = typeof aspect === 'string' ? aspect : aspect?.name;
      if (!key) continue;
      const val = getAttrValue(attrs, key);
      if (val && val.toLowerCase() !== 'unbekannt') filled += 1;
    }
    fillRate = required.length > 0 ? filled / required.length : 0;
    if (fillRate < 0.8) {
      issues.push({
        rule: 'specifics_required_aspects_underfilled',
        severity: SEVERITY_WARNING,
        message: `Only ${Math.round(fillRate * 100)}% of required aspects filled (${filled}/${required.length}).`,
        leitfaden_section: '5. Pflichtmerkmale',
      });
    }
  }

  // Weighted: identifier presence 0.5, required-aspects fill 0.5.
  const identifierScore = hasIdentifier ? 1 : 0;
  const score = clamp01(identifierScore * 0.5 + clamp01(fillRate) * 0.5);

  return { score, issues };
}

/**
 * scoreCompliance(product)
 *
 * Cassini-Pillar: Compliance (Leitfaden §7 — kein Active Content, kein
 * Keyword-Spamming).
 */
function scoreCompliance(product) {
  const issues = [];
  const html = getProductDescription(product);
  const title = getProductTitle(product);

  let activeContentScore = 1;
  for (const pattern of ACTIVE_CONTENT_PATTERNS) {
    if (pattern.test(html)) {
      activeContentScore = 0;
      issues.push({
        rule: 'compliance_active_content',
        severity: SEVERITY_ERROR,
        message: `Description contains forbidden tag matching ${pattern}; eBay blocks Active Content.`,
        leitfaden_section: '7. Compliance-Matrix',
      });
      break;
    }
  }

  // Keyword-spamming: max-token-frequency in title >2.
  let spamScore = 1;
  if (title) {
    const tokens = nonStopTokens(title);
    if (tokens.length) {
      const freq = new Map();
      for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
      const maxFreq = Math.max(...freq.values());
      if (maxFreq > 2) {
        spamScore = 0.3;
        issues.push({
          rule: 'compliance_keyword_spam',
          severity: SEVERITY_WARNING,
          message: `Title contains a token repeated ${maxFreq}× — Cassini straft Keyword-Stuffing ab.`,
          leitfaden_section: '7. Keyword-Spamming',
        });
      } else if (maxFreq === 2) {
        spamScore = 0.7;
      }
    }
  }

  // F.3 — Description-level Keyword-Spamming check (max-token-density > 7%).
  if (html && detectKeywordSpamming(html, 0.07)) {
    spamScore = Math.min(spamScore, 0.4);
    issues.push({
      rule: 'compliance_description_keyword_spam',
      severity: SEVERITY_WARNING,
      message: 'Description has max-token-density >7%; Cassini straft Keyword-Spamming ab.',
      leitfaden_section: '7. Keyword-Spamming',
    });
  }

  // Weighted: active-content 0.7 (binary critical), spam 0.3.
  const score = clamp01(activeContentScore * 0.7 + spamScore * 0.3);

  return { score, issues };
}

// ----------------------------------------------------------------------------
// Main entry point
// ----------------------------------------------------------------------------

/**
 * scoreProductCassini(product) → {
 *   overall: number in [0,1],
 *   title_score, description_score, image_score, specifics_score, compliance_score,
 *   issues: Array<{rule, severity, message, leitfaden_section}>,
 *   datasheet_quality_raw: result-of-evaluateEbayReady (or fallback object)
 * }
 *
 * Defensive: on error inside `evaluateEbayReady` we return a fallback
 * `datasheet_quality_raw` shape so the Critic-Worker never crashes.
 */
function scoreProductCassini(product, options = {}) {
  const safeProduct = product && typeof product === 'object' ? product : {};

  const titleR = scoreTitle(safeProduct);
  const descR = scoreDescription(safeProduct);
  const imageR = scoreImage(safeProduct);
  const specsR = scoreSpecifics(safeProduct);
  const complR = scoreCompliance(safeProduct);

  let datasheetRaw;
  try {
    // Resolve at call-time so tests can patch the module via require.cache.
    const evaluate = datasheetQualityModule && typeof datasheetQualityModule.evaluateEbayReady === 'function'
      ? datasheetQualityModule.evaluateEbayReady
      : null;
    if (!evaluate) {
      throw new Error('evaluateEbayReady is not a function');
    }
    datasheetRaw = evaluate(safeProduct, options) || null;
  } catch (err) {
    datasheetRaw = {
      ok: false,
      issues: [],
      issuesDetailed: [],
      snapshot: null,
      error: { message: err && err.message ? err.message : String(err) },
    };
  }

  const overall = clamp01(
    titleR.score * WEIGHTS.title +
      descR.score * WEIGHTS.description +
      imageR.score * WEIGHTS.image +
      specsR.score * WEIGHTS.specifics +
      complR.score * WEIGHTS.compliance
  );

  const issues = []
    .concat(titleR.issues, descR.issues, imageR.issues, specsR.issues, complR.issues);

  return {
    overall: Math.round(overall * 1000) / 1000,
    title_score: Math.round(titleR.score * 1000) / 1000,
    description_score: Math.round(descR.score * 1000) / 1000,
    image_score: Math.round(imageR.score * 1000) / 1000,
    specifics_score: Math.round(specsR.score * 1000) / 1000,
    compliance_score: Math.round(complR.score * 1000) / 1000,
    titlePatternMatch: typeof titleR.titlePatternMatch === 'number' ? titleR.titlePatternMatch : null,
    patternBucket: titleR.patternBucket || null,
    issues,
    datasheet_quality_raw: datasheetRaw,
  };
}

module.exports = {
  scoreProductCassini,
  scoreTitle,
  scoreTitlePatternMatch,
  scoreDescription,
  scoreImage,
  scoreSpecifics,
  scoreCompliance,
  detectKeywordSpamming,
  WEIGHTS,
  _internal: {
    tokenize,
    nonStopTokens,
    clamp01,
    lookupIdentifier,
  },
};
