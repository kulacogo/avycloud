'use strict';

/**
 * aspect-cap-enforcer.js
 *
 * Hart-Cap für eBay Item Specifics. Die eBay Trading API `AddFixedPriceItem`
 * akzeptiert maximal 45 `ItemSpecifics/NameValueList`-Einträge pro Listing.
 * Wird das überschritten → Publish-Fehler oder stille Trunkierung.
 *
 * Dieser Enforcer:
 *   1. Normalisiert eingehende Aspects in eine einheitliche `[{key, value, confidence, priority}]`-Form
 *   2. Klassifiziert jeden Aspect als required | recommended | optional (case-insensitive Match)
 *   3. Sortiert nach (priority_rank, confidence_desc, insertion_order)
 *   4. Behält die Top-N (default 45), droppt den Rest
 *   5. Liefert zusätzlich die gedroppten Aspects + eine Trace-Meta zurück für Debugging
 *
 * Keine Gemini-Calls, keine Netzwerk-IO. Pure-function.
 */

const EBAY_ASPECT_HARD_CAP = 45;

const PRIORITY_RANK = Object.freeze({
  required: 0,
  recommended: 1,
  optional: 2,
  unknown: 3,
});

function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  return key
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/ẞ/g, 'ss')
    .trim()
    .toLowerCase();
}

function toStringSafe(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function toNameArray(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        return entry.localizedName || entry.name || entry.label || '';
      }
      return '';
    })
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

function coerceAspectArray(aspects) {
  if (Array.isArray(aspects)) {
    return aspects
      .map((item) => {
        if (!item) return null;
        if (typeof item === 'object') {
          const key = toStringSafe(item.key ?? item.name ?? item.aspect ?? '').trim();
          if (!key) return null;
          return {
            key,
            value: toStringSafe(item.value ?? item.values?.[0] ?? '').trim(),
            confidence: typeof item.confidence === 'number' ? item.confidence : null,
          };
        }
        return null;
      })
      .filter(Boolean);
  }
  if (aspects && typeof aspects === 'object') {
    return Object.entries(aspects)
      .map(([key, value]) => {
        const k = toStringSafe(key).trim();
        if (!k) return null;
        if (Array.isArray(value)) {
          return { key: k, value: toStringSafe(value[0]).trim(), confidence: null };
        }
        if (value && typeof value === 'object') {
          return {
            key: k,
            value: toStringSafe(value.value ?? value.text ?? '').trim(),
            confidence: typeof value.confidence === 'number' ? value.confidence : null,
          };
        }
        return { key: k, value: toStringSafe(value).trim(), confidence: null };
      })
      .filter(Boolean);
  }
  return [];
}

function classifyPriority(aspectKey, requiredSet, recommendedSet) {
  const norm = normalizeKey(aspectKey);
  if (!norm) return 'unknown';
  if (requiredSet.has(norm)) return 'required';
  if (recommendedSet.has(norm)) return 'recommended';
  return 'optional';
}

/**
 * Produziert eine deterministische Rangfolge pro Aspect:
 *   1. PRIORITY_RANK (required < recommended < optional < unknown)
 *   2. Confidence desc (fehlt → 0)
 *   3. Insertion order (stabil)
 *   4. Aspect-Key alphabetisch (deterministisches Tie-Break)
 */
function sortKey(aspect, index) {
  const rank = PRIORITY_RANK[aspect.priority] ?? PRIORITY_RANK.unknown;
  const conf = typeof aspect.confidence === 'number' ? aspect.confidence : 0;
  return [rank, -conf, index, normalizeKey(aspect.key)];
}

function compareSortKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Dedupliziert pro key: hält den Eintrag mit höchster confidence (bei
 * Gleichstand den zuerst eingefügten).
 */
function dedupeByKey(list) {
  const map = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const norm = normalizeKey(item.key);
    if (!norm) continue;
    const existing = map.get(norm);
    if (!existing) {
      map.set(norm, { ...item, _originalIndex: i });
      continue;
    }
    const currentConf = typeof item.confidence === 'number' ? item.confidence : -Infinity;
    const existingConf =
      typeof existing.confidence === 'number' ? existing.confidence : -Infinity;
    if (currentConf > existingConf) {
      map.set(norm, { ...item, _originalIndex: existing._originalIndex });
    }
  }
  return Array.from(map.values());
}

/**
 * prioritizeAspects(aspects, requiredList, recommendedList)
 *
 * Klassifiziert + sortiert, capped NICHT. Nützlich für Debugging oder externe
 * Weiterverarbeitung.
 */
function prioritizeAspects(aspects, requiredList = [], recommendedList = []) {
  const requiredSet = new Set(toNameArray(requiredList).map(normalizeKey));
  const recommendedSet = new Set(toNameArray(recommendedList).map(normalizeKey));

  const normalized = coerceAspectArray(aspects).map((entry) => ({
    ...entry,
    priority: classifyPriority(entry.key, requiredSet, recommendedSet),
  }));

  const deduped = dedupeByKey(normalized);

  return deduped
    .map((item, idx) => ({ ...item, _sortKey: sortKey(item, item._originalIndex ?? idx) }))
    .sort((a, b) => compareSortKeys(a._sortKey, b._sortKey))
    .map(({ _sortKey, _originalIndex, ...rest }) => rest);
}

/**
 * enforceAspectCap(aspects, { requiredAspects, recommendedAspects, maxCap })
 *
 * Trimmt auf maxCap (default EBAY_ASPECT_HARD_CAP = 45).
 * Liefert:
 *   {
 *     trimmed: Array<{key, value, confidence?, priority}>,
 *     removed: Array<{key, value, confidence?, priority}>,
 *     meta: {
 *       inputCount, outputCount, removedCount, cap,
 *       requiredCount, recommendedCount, optionalCount, unknownCount,
 *       requiredMissing: string[] // required Aspects die NICHT im Input waren
 *     }
 *   }
 */
function enforceAspectCap(aspects, options = {}) {
  const {
    requiredAspects = [],
    recommendedAspects = [],
    maxCap = EBAY_ASPECT_HARD_CAP,
  } = options;

  const cap = Math.max(1, Math.min(Number(maxCap) || EBAY_ASPECT_HARD_CAP, 500));
  const prioritized = prioritizeAspects(aspects, requiredAspects, recommendedAspects);

  const trimmed = prioritized.slice(0, cap);
  const removed = prioritized.slice(cap);

  const requiredSet = new Set(toNameArray(requiredAspects).map(normalizeKey));
  const presentKeys = new Set(trimmed.map((a) => normalizeKey(a.key)));
  const requiredMissing = [...requiredSet].filter((k) => !presentKeys.has(k));

  const countByPriority = { required: 0, recommended: 0, optional: 0, unknown: 0 };
  for (const a of trimmed) {
    countByPriority[a.priority] = (countByPriority[a.priority] || 0) + 1;
  }

  return {
    trimmed,
    removed,
    meta: {
      inputCount: prioritized.length,
      outputCount: trimmed.length,
      removedCount: removed.length,
      cap,
      requiredCount: countByPriority.required,
      recommendedCount: countByPriority.recommended,
      optionalCount: countByPriority.optional,
      unknownCount: countByPriority.unknown,
      requiredMissing,
    },
  };
}

/**
 * Hilfs-Konverter: Array → { key: value } record. Nützlich für das
 * `details.attributes`-Schema in products_v2.
 */
function aspectsToRecord(aspectArray) {
  const out = {};
  if (!Array.isArray(aspectArray)) return out;
  for (const a of aspectArray) {
    if (!a || typeof a !== 'object') continue;
    const key = toStringSafe(a.key).trim();
    const value = toStringSafe(a.value).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

module.exports = {
  EBAY_ASPECT_HARD_CAP,
  PRIORITY_RANK,
  enforceAspectCap,
  prioritizeAspects,
  aspectsToRecord,
  // exposed for unit tests only
  _internal: {
    normalizeKey,
    coerceAspectArray,
    classifyPriority,
    dedupeByKey,
    sortKey,
    toNameArray,
  },
};
