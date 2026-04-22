'use strict';

// Cross-Referencing: prüft ob mehrere unabhängige Quellen bei kritischen Feldern übereinstimmen.
// Wird vom Confidence-Scoring zusätzlich eingesetzt, um bei konkurrierenden Werten den
// Kandidaten mit der höchsten kumulierten Quellen-Evidenz zu wählen.

const { scoreField, SOURCE_WEIGHTS } = require('./confidence-scoring');

const CORP_SUFFIXES = [
  'inc',
  'inc.',
  'incorporated',
  'corp',
  'corp.',
  'corporation',
  'co',
  'co.',
  'company',
  'gmbh',
  'mbh',
  'ug',
  'ag',
  'kg',
  'ohg',
  'ltd',
  'ltd.',
  'limited',
  'llc',
  'llc.',
  'plc',
  'sa',
  's.a.',
  'sas',
  'sarl',
  's.a.r.l.',
  'srl',
  'bv',
  'nv',
  'oy',
  'ab',
  'as',
  'pte',
  'pvt',
];

const CONFLICT_SUPPORT_RATIO = 0.7; // 2nd best > 70% of winner → conflict

function stripCorpSuffixes(value) {
  let v = String(value).trim().toLowerCase();
  // Strip trailing punctuation
  v = v.replace(/[,.;:]+$/g, '').trim();
  let changed = true;
  // Apply repeatedly — "Philips Electronics Inc." → "philips electronics"
  while (changed) {
    changed = false;
    for (const suffix of CORP_SUFFIXES) {
      const re = new RegExp('\\s+' + suffix.replace(/\./g, '\\.') + '\\.?$', 'i');
      const next = v.replace(re, '').trim();
      if (next !== v) {
        v = next;
        changed = true;
      }
    }
  }
  return v.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes a value per field type for cross-reference matching.
 * @param {string} field
 * @param {any} value
 * @returns {string}
 */
function normalizeForCompare(field, value) {
  if (value == null) return '';
  const fieldLc = typeof field === 'string' ? field.toLowerCase() : '';

  if (['gtin', 'ean', 'upc', 'mpn'].includes(fieldLc)) {
    // digits-only for GTIN family; alphanumeric for MPN
    if (fieldLc === 'mpn') {
      return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
    }
    return String(value).replace(/[^\d]/g, '');
  }

  if (fieldLc === 'brand') {
    return stripCorpSuffixes(value);
  }

  if (['categoryid', 'category_id'].includes(fieldLc)) {
    return String(value).trim();
  }

  if (['category', 'categorypath'].includes(fieldLc)) {
    return String(value)
      .toLowerCase()
      .split('>')
      .map((p) => p.trim())
      .filter(Boolean)
      .join(' > ');
  }

  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function sourceConfidenceFallback(source) {
  const w = SOURCE_WEIGHTS[source];
  return typeof w === 'number' ? w : 0.5;
}

/**
 * Collects candidate values for a field across source results and returns
 * a consensus view.
 *
 * @param {string} field
 * @param {Array<{source: string, value: any, confidence?: number}>} candidates
 * @returns {{
 *   value: any,
 *   support: string[],
 *   conflict: boolean,
 *   alternatives: Array<{value: any, sources: string[], support: number}>
 * }}
 */
function resolveConsensus(field, candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  const groups = new Map();

  for (const cand of list) {
    if (!cand || typeof cand !== 'object' || !cand.source) continue;
    if (cand.value == null || cand.value === '') continue;
    const key = normalizeForCompare(field, cand.value);
    if (!key) continue;
    const conf = typeof cand.confidence === 'number'
      ? cand.confidence
      : sourceConfidenceFallback(cand.source);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        value: cand.value, // preserve first-seen original casing/format
        sources: [],
        support: 0,
      });
    }
    const g = groups.get(key);
    g.sources.push(cand.source);
    // Support = sum(confidence) × sqrt(unique-source-count) weighting so more
    // independent sources dominate a single strong source.
    g.support += conf;
  }

  if (groups.size === 0) {
    return { value: null, support: [], conflict: false, alternatives: [] };
  }

  // Weight final support by number of unique sources (multi-source bias).
  const ranked = Array.from(groups.values())
    .map((g) => {
      const uniqueSources = new Set(g.sources);
      return {
        ...g,
        uniqueSourceCount: uniqueSources.size,
        effectiveSupport: g.support * uniqueSources.size,
      };
    })
    .sort((a, b) => b.effectiveSupport - a.effectiveSupport);

  const winner = ranked[0];
  const runnerUp = ranked[1];
  const conflict = Boolean(
    runnerUp && runnerUp.effectiveSupport >= CONFLICT_SUPPORT_RATIO * winner.effectiveSupport,
  );

  const alternatives = ranked.slice(1).map((g) => ({
    value: g.value,
    sources: Array.from(new Set(g.sources)),
    support: g.effectiveSupport,
  }));

  return {
    value: winner.value,
    support: Array.from(new Set(winner.sources)),
    conflict,
    alternatives,
  };
}

/**
 * Applies cross-reference to an entire product draft.
 *
 * @param {Record<string, any>} draft raw product draft values
 * @param {Array<{field: string, source: string, value: any, confidence?: number}>} sourceResults
 * @returns {{
 *   resolved: Record<string, any>,
 *   conflicts: Array<{field: string, alternatives: Array<{value: any, sources: string[]}>}>,
 *   confidence: Record<string, {score: number, threshold: number, passes: boolean, sources: string[], reasoning: string}>
 * }}
 */
function crossReferenceProduct(draft = {}, sourceResults = []) {
  const byField = new Map();
  const list = Array.isArray(sourceResults) ? sourceResults : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !entry.field) continue;
    if (!byField.has(entry.field)) byField.set(entry.field, []);
    byField.get(entry.field).push(entry);
  }

  const resolved = {};
  const conflicts = [];
  const confidence = {};

  // Union of draft keys + evidence keys so that evidence-only fields get resolved too.
  const draftKeys = draft && typeof draft === 'object' ? Object.keys(draft) : [];
  const fields = new Set([...draftKeys, ...byField.keys()]);

  for (const field of fields) {
    const draftValue = draft ? draft[field] : undefined;
    const candidates = byField.get(field) || [];

    let chosen = draftValue;
    if (candidates.length > 0) {
      const consensus = resolveConsensus(field, candidates);
      if (consensus.value != null) {
        chosen = consensus.value;
      }
      if (consensus.conflict) {
        conflicts.push({
          field,
          alternatives: [
            { value: consensus.value, sources: consensus.support },
            ...consensus.alternatives.map((a) => ({ value: a.value, sources: a.sources })),
          ],
        });
      }
    }

    if (chosen != null) resolved[field] = chosen;

    // Score confidence for whichever value we ended up with.
    const evidence = candidates.map((c) => ({ source: c.source, value: c.value, meta: c.meta }));
    // If draft provided a value but no candidates, score it as user_input.
    if (candidates.length === 0 && draftValue != null && draftValue !== '') {
      evidence.push({ source: 'user_input', value: draftValue });
    }
    confidence[field] = scoreField(field, chosen, evidence);
  }

  return { resolved, conflicts, confidence };
}

module.exports = {
  resolveConsensus,
  normalizeForCompare,
  crossReferenceProduct,
};
