'use strict';

// Confidence-Scoring pro Produkt-Feld.
// Thresholds sind feldspezifisch. Über-Threshold = auto-write. Unter = human-in-loop flag.
// Quellen: Forschung zeigt, dass LLMs ~38pp überkonfident sind (arxiv 2602.06948).
// Lösung: Jede kritische Behauptung braucht 2+ unabhängige Quellen.

const FIELD_THRESHOLDS = Object.freeze({
  gtin: 0.95,            // hart — falsche GTIN = eBay reject
  ean: 0.95,
  upc: 0.95,
  categoryId: 0.85,
  category: 0.85,
  brand: 0.90,
  mpn: 0.85,
  title: 0.70,
  description: 0.60,
  requiredAspects: 0.80,
  price: 0.70,
  weight: 0.70,
  gpsr: 0.75,
  color: 0.70,
  size: 0.70,
  material: 0.65,
  _default: 0.70,
});

const SOURCE_WEIGHTS = Object.freeze({
  ebay_catalog: 0.95,
  gs1_verified: 0.98,
  ean_db: 0.85,
  upcitemdb: 0.80,
  icecat: 0.85,
  manufacturer_website: 0.90,
  amazon_product: 0.80,
  google_search_grounding: 0.70,
  url_context: 0.75,
  user_input: 1.0,
  ocr: 0.65,
  gemini_inference: 0.55,
  gemini_vision: 0.65,
  web_search_broad: 0.50,
});

// Aggregations-Gewichte für den Gesamt-Produkt-Score.
const AGGREGATION_WEIGHTS = Object.freeze({
  brand: 0.15,
  gtin: 0.10,
  category: 0.15,
  price: 0.10,
  title: 0.15,
  description: 0.10,
  requiredAspects: 0.15,
  gpsr: 0.10,
});

// Welche Felder müssen publish-ready sein (alle `passes === true`)?
const CRITICAL_FIELDS = Object.freeze(['brand', 'category', 'title', 'requiredAspects', 'gpsr']);

const MULTI_SOURCE_BOOST_STEP = 0.05;
const MULTI_SOURCE_BOOST_CAP = 0.15;
const DISAGREEMENT_PENALTY = 0.10;
const VALUE_FORMAT_BONUS = 0.05;
const MIN_EVIDENCE_FOR_FULL_BOOST = 3;

/**
 * Returns true if the digits-only GTIN candidate has a valid Mod-10 check digit.
 * Accepts EAN-8, UPC-12, EAN-13 and GTIN-14.
 * @param {string} str
 * @returns {boolean}
 */
function isValidGtin(str) {
  if (str == null) return false;
  const digits = String(str).replace(/[^\d]/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  if (!/^\d+$/.test(digits)) return false;
  const nums = digits.split('').map((c) => parseInt(c, 10));
  let sum = 0;
  for (let i = nums.length - 2, weightIdx = 0; i >= 0; i -= 1, weightIdx += 1) {
    const weight = weightIdx % 2 === 0 ? 3 : 1;
    sum += nums[i] * weight;
  }
  const expected = (10 - (sum % 10)) % 10;
  const actual = nums[nums.length - 1];
  return expected === actual;
}

/**
 * Normalizes a value for loose equality comparison.
 * Keeps the behaviour field-agnostic and intentionally conservative.
 * @param {any} value
 * @returns {string}
 */
function normalizeValue(value) {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Returns true if the given category string looks like a valid eBay breadcrumb
 * (e.g. `Electronics > Audio > Headphones`).
 * @param {string} value
 */
function isBreadcrumbCategory(value) {
  if (typeof value !== 'string') return false;
  if (!value.includes('>')) return false;
  const parts = value.split('>').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2;
}

/**
 * Scores confidence for a single field given source evidence.
 * @param {string} field field name (gtin, brand, …)
 * @param {any} value actual value being scored
 * @param {Array<{source: string, value: any, meta?: any}>} evidence sources supporting this value
 * @returns {{score: number, threshold: number, passes: boolean, sources: string[], reasoning: string}}
 */
function scoreField(field, value, evidence = []) {
  const threshold = FIELD_THRESHOLDS[field] != null
    ? FIELD_THRESHOLDS[field]
    : FIELD_THRESHOLDS._default;

  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const normTarget = normalizeValue(value);

  const matching = [];
  const conflicting = [];
  for (const ev of evidenceList) {
    if (!ev || typeof ev !== 'object' || !ev.source) continue;
    if (normalizeValue(ev.value) === normTarget && normTarget !== '') {
      matching.push(ev);
    } else if (ev.value != null && ev.value !== '' && normTarget !== '') {
      conflicting.push(ev);
    }
  }

  const reasoningParts = [];

  if (matching.length === 0) {
    const reason = evidenceList.length === 0
      ? 'no evidence supplied'
      : 'no source matches the given value';
    return {
      score: 0,
      threshold,
      passes: false,
      sources: [],
      reasoning: reason,
    };
  }

  // 1. Base score = max weight of matching sources.
  let baseScore = 0;
  for (const ev of matching) {
    const w = SOURCE_WEIGHTS[ev.source];
    const weight = typeof w === 'number' ? w : 0.4; // unknown source gets low weight
    if (weight > baseScore) baseScore = weight;
  }
  reasoningParts.push(`base=${baseScore.toFixed(2)}`);

  // 2. Multi-source boost.
  let boost = 0;
  if (matching.length >= 2) {
    const extras = matching.length - 1; // one additional source at matching.length=2
    // Require 3+ matching sources to reach full cap
    let raw = extras * MULTI_SOURCE_BOOST_STEP;
    if (matching.length < MIN_EVIDENCE_FOR_FULL_BOOST) {
      raw = Math.min(raw, MULTI_SOURCE_BOOST_STEP);
    }
    boost = Math.min(raw, MULTI_SOURCE_BOOST_CAP);
    reasoningParts.push(`multi-source(+${boost.toFixed(2)})`);
  }

  // 3. Disagreement penalty.
  let penalty = 0;
  if (conflicting.length > 0) {
    penalty = DISAGREEMENT_PENALTY;
    reasoningParts.push(`disagreement(-${penalty.toFixed(2)})`);
  }

  // 4. Value-format bonus.
  let formatBonus = 0;
  const fieldLc = typeof field === 'string' ? field.toLowerCase() : '';
  if (['gtin', 'ean', 'upc'].includes(fieldLc) && isValidGtin(value)) {
    formatBonus = VALUE_FORMAT_BONUS;
    reasoningParts.push(`gtin-checksum(+${formatBonus.toFixed(2)})`);
  } else if (['category', 'categorypath'].includes(fieldLc) && isBreadcrumbCategory(value)) {
    formatBonus = VALUE_FORMAT_BONUS;
    reasoningParts.push(`breadcrumb(+${formatBonus.toFixed(2)})`);
  }

  // Invalid-GTIN: hart abwerten auch wenn Quellen übereinstimmen.
  let invalidGtinPenalty = 0;
  if (['gtin', 'ean', 'upc'].includes(fieldLc) && !isValidGtin(value)) {
    invalidGtinPenalty = 0.5;
    reasoningParts.push(`invalid-gtin(-${invalidGtinPenalty.toFixed(2)})`);
  }

  let score = baseScore + boost - penalty + formatBonus - invalidGtinPenalty;
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  const sources = matching.map((ev) => ev.source);

  return {
    score,
    threshold,
    passes: score >= threshold,
    sources,
    reasoning: reasoningParts.join(', '),
  };
}

/**
 * Aggregates per-field confidence scores into an overall product confidence.
 * @param {Record<string, {score: number, passes: boolean, threshold?: number}>} fieldScores
 * @returns {{score: number, readyForPublish: boolean, fieldsConsidered: string[], missingCritical: string[]}}
 */
function aggregateProductConfidence(fieldScores = {}) {
  const considered = [];
  let weightedSum = 0;
  let weightTotal = 0;

  for (const [field, weight] of Object.entries(AGGREGATION_WEIGHTS)) {
    const entry = fieldScores && fieldScores[field];
    if (!entry || typeof entry.score !== 'number') continue; // skip missing fields
    considered.push(field);
    weightedSum += weight * entry.score;
    weightTotal += weight;
  }

  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;

  const missingCritical = [];
  for (const field of CRITICAL_FIELDS) {
    const entry = fieldScores && fieldScores[field];
    if (!entry || !entry.passes) missingCritical.push(field);
  }

  return {
    score,
    readyForPublish: missingCritical.length === 0,
    fieldsConsidered: considered,
    missingCritical,
  };
}

module.exports = {
  scoreField,
  aggregateProductConfidence,
  isValidGtin,
  FIELD_THRESHOLDS,
  SOURCE_WEIGHTS,
  AGGREGATION_WEIGHTS,
  CRITICAL_FIELDS,
};
