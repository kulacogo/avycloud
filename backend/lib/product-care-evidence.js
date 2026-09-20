'use strict';

// A save is not a completed review. Only substantive before/after evidence or
// an explicit readiness transition supports a personal care contribution.
const CONTENT_FIELDS = new Set([
  'identification.name', 'identification.brand', 'details.title',
  'details.short_description', 'details.description', 'details.categoryId',
  'details.category_breadcrumb', 'details.identifiers.mpn',
]);
const ACTIVITIES = new Set(['capture', 'datasheet', 'ownership', 'pricing']);
function normalizeSaveActivity(value) { return ACTIVITIES.has(value) ? value : 'unspecified'; }
const scalar = (value) => value == null ? '' : String(value).trim().replace(/\s+/g, ' ');
const operationalAttribute = (key) => /^(condition|zustand|artikelzustand|lagerplatz|lagerort|bin|bestand|menge)$/i.test(key.trim()) || /^(gewicht|weight)(\s|\(|$)/i.test(key.trim());
const gpsrMetadata = (key) => /^(evidence|sources?|confidence|updated_at_iso|updatedAt|registry_key|status)$/i.test(key);

function canonical(value) {
  if (value == null || scalar(value) === '') return null;
  if (Array.isArray(value)) return value.map(canonical).filter((v) => v !== null).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const normalized = canonical(value[key]);
    return normalized === null ? [] : [[key, normalized]];
  }));
  return scalar(value);
}

function objectValue(value, omit) {
  if (value == null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch (_) { return null; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return canonical(Object.fromEntries(Object.entries(parsed).filter(([key]) => !omit(key))));
}

function hasContentChange(change) {
  if (!change || !Object.hasOwn(change, 'from') || !Object.hasOwn(change, 'to')) return false;
  const { field, from, to } = change;
  if (CONTENT_FIELDS.has(field)) return scalar(from) !== scalar(to);
  if (field === 'details.attributes' || field === 'details.gpsr') {
    if (field === 'details.gpsr') {
      // Product reads can hydrate registry data. Copying that enriched snapshot
      // back on save is not proof that this employee researched the address.
      try {
        const oldGpsr = typeof from === 'string' ? JSON.parse(from) : from;
        const newGpsr = typeof to === 'string' ? JSON.parse(to) : to;
        if (newGpsr?.evidence?.status === 'registry' && JSON.stringify(canonical(oldGpsr?.evidence)) !== JSON.stringify(canonical(newGpsr.evidence))) return false;
      } catch (_) { return false; }
    }
    const omit = field === 'details.attributes' ? operationalAttribute : gpsrMetadata;
    const before = objectValue(from, omit), after = objectValue(to, omit);
    return before !== null && after !== null && JSON.stringify(before) !== JSON.stringify(after);
  }
  if (field === 'details.key_features') {
    try {
      const before = from == null ? [] : typeof from === 'string' ? JSON.parse(from) : from;
      const after = to == null ? [] : typeof to === 'string' ? JSON.parse(to) : to;
      return Array.isArray(before) && Array.isArray(after) && JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after));
    } catch (_) { return false; }
  }
  // Capture/warehouse/price/photo operations do not prove data enrichment.
  return false;
}

function classifyCareEvent(event) {
  const activity = normalizeSaveActivity(event?.details?.activity);
  if (['capture', 'ownership', 'pricing'].includes(activity)) return { edited: false, ready: false };
  const changes = Array.isArray(event?.details?.changes) ? event.details.changes : [];
  return {
    edited: changes.some(hasContentChange),
    ready: changes.some((c) => c?.field === 'ops.readiness' && Object.hasOwn(c, 'from') && c.from !== 'ready' && c.to === 'ready'),
  };
}

module.exports = { classifyCareEvent, normalizeSaveActivity };
