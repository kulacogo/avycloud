'use strict';

/**
 * Best-effort web fallback for product weight when Stage 1 didn't find it.
 *
 * Strategy:
 *  - Build 2-3 localized queries (brand + model + weight/gewicht)
 *  - Call Brightdata search (toolkit.executeBrightdataSearchToolCall)
 *  - Parse snippets/titles of top results for weight patterns
 *  - Validate sanity (1g - 50000g) and combine signals across results
 *
 * Public API:
 *   lookupWeightFromWeb(identity, options?) -> { weight_grams, confidence, sources }
 *   brandDomainGuess(brand) -> domain string or null (used as site hint)
 */

// Weight regex: captures a number (with comma or dot decimal) + unit.
// Accepts "g", "gram", "grams", "gramm", "gramme" and "kg", "kilo", "kilogramm".
const WEIGHT_RE = /(\d+(?:[.,]\d+)?)\s*(kilogramm|kilogram|kilogramme|kilos?|kg|grams?|gramme|gramm|g)\b/gi;

// Plausibility window for typical product weight (1g - 50kg)
const MIN_WEIGHT_G = 1;
const MAX_WEIGHT_G = 50000;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function brandDomainGuess(brand) {
  if (!brand) return null;
  const cleaned = String(brand)
    .toLowerCase()
    .replace(/[ü]/g, 'ue')
    .replace(/[ö]/g, 'oe')
    .replace(/[ä]/g, 'ae')
    .replace(/[ß]/g, 'ss')
    .replace(/\b(gmbh|ag|inc\.?|ltd\.?|corp\.?|co\.?|kg|se|llc|bv|s\.a\.?)\b/gi, '')
    .replace(/[^a-z0-9]+/g, '');
  if (!cleaned) return null;
  return `${cleaned}.de`;
}

function parseWeightToGrams(rawValue, unit) {
  const numeric = Number(String(rawValue).replace(',', '.'));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const u = String(unit || '').toLowerCase();
  if (u.startsWith('kg') || u.startsWith('kilo')) {
    return Math.round(numeric * 1000);
  }
  // grams / gramm / g
  return Math.round(numeric);
}

function extractWeightCandidates(text) {
  const candidates = [];
  if (!text) return candidates;
  const haystack = String(text);
  let match;
  WEIGHT_RE.lastIndex = 0;
  while ((match = WEIGHT_RE.exec(haystack)) !== null) {
    const grams = parseWeightToGrams(match[1], match[2]);
    if (grams == null) continue;
    if (grams < MIN_WEIGHT_G || grams > MAX_WEIGHT_G) continue;
    candidates.push(grams);
  }
  return candidates;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function groupByTolerance(values, tolerance = 0.05) {
  // Returns the largest cluster where all members are within (tolerance) of the cluster's median.
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  let best = [sorted[0]];
  for (let i = 0; i < sorted.length; i += 1) {
    const cluster = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const cand = sorted[j];
      const center = median(cluster);
      if (center && Math.abs(cand - center) / center <= tolerance) {
        cluster.push(cand);
      }
    }
    if (cluster.length > best.length) best = cluster;
  }
  return best;
}

function buildQueries(identity = {}) {
  const brand = safeString(identity.brand);
  const model = safeString(identity.model) || safeString(identity.mpn);
  const ean = safeString(identity.ean) || safeString(identity.gtin) || safeString(identity.upc);

  const queries = [];
  if (brand || model) {
    const anchor = [brand, model].filter(Boolean).join(' ').trim();
    if (anchor) {
      queries.push(`"${anchor}" weight grams`);
      queries.push(`"${anchor}" Gewicht Gramm`);
      const domain = brandDomainGuess(brand);
      if (domain) {
        queries.push(`"${anchor}" specifications site:${domain}`);
      }
    }
  }
  if (!queries.length && ean) {
    queries.push(`${ean} weight grams`);
  }
  return queries.slice(0, 3);
}

async function runSearch(query, timeoutMs) {
  const { executeBrightdataSearchToolCall } = require('../services/toolkit.js');
  const toolCall = { arguments: JSON.stringify({ query, limit: 5 }) };
  const resultPromise = executeBrightdataSearchToolCall(toolCall);
  if (!timeoutMs) return resultPromise;
  return Promise.race([
    resultPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('weight web search timeout')), timeoutMs)),
  ]);
}

async function lookupWeightFromWeb(identity = {}, options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 8000;
  const queries = buildQueries(identity);
  if (!queries.length) {
    return { weight_grams: null, confidence: 0, sources: [] };
  }

  const allCandidates = [];
  const sourceUrls = [];

  for (const q of queries) {
    let res;
    try {
      res = await runSearch(q, timeout);
    } catch (err) {
      console.warn('[weight-web-lookup] search failed:', err?.message || err);
      continue;
    }
    const results = Array.isArray(res?.results) ? res.results.slice(0, 3) : [];
    for (const entry of results) {
      const url = safeString(entry?.url);
      const haystack = [entry?.title, entry?.snippet].filter(Boolean).join(' \n ');
      const found = extractWeightCandidates(haystack);
      if (found.length) {
        allCandidates.push(...found);
        if (url && !sourceUrls.includes(url)) sourceUrls.push(url);
      }
    }
    // If we already have >=2 candidates, early-exit to stay cheap
    if (allCandidates.length >= 2) break;
  }

  if (!allCandidates.length) {
    return { weight_grams: null, confidence: 0, sources: [] };
  }

  if (allCandidates.length === 1) {
    return {
      weight_grams: allCandidates[0],
      confidence: 0.6,
      sources: sourceUrls.slice(0, 5),
    };
  }

  const cluster = groupByTolerance(allCandidates, 0.05);
  if (cluster.length >= 2) {
    const consensus = median(cluster);
    return {
      weight_grams: consensus,
      confidence: 0.85,
      sources: sourceUrls.slice(0, 5),
    };
  }

  // Candidates disagreed: fall back to median with low confidence
  return {
    weight_grams: median(allCandidates),
    confidence: 0.4,
    sources: sourceUrls.slice(0, 5),
  };
}

module.exports = {
  lookupWeightFromWeb,
  brandDomainGuess,
  // exported for unit tests:
  parseWeightToGrams,
  extractWeightCandidates,
  buildQueries,
};
