/**
 * Manufacturer GPSR registry:
 * Keep one canonical GPSR record per manufacturer to avoid per-product variance.
 */

const { firestore } = require('./firestore');

const COLLECTION = 'gpsrManufacturers';

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeManufacturerKey(name) {
  const raw = safeString(name);
  if (!raw) return '';
  return raw
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[’'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-') // keep stable doc ids
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function manufacturerKeyCandidates(name) {
  const base = normalizeManufacturerKey(name);
  if (!base) return [];

  const variants = new Set([base]);

  // If name already includes a corporate suffix, also try without it.
  const stripSuffixes = [
    '-ag',
    '-gmbh',
    '-se',
    '-inc',
    '-ltd',
    '-llc',
    '-s-a',
    '-sa',
    '-bv',
    '-kg',
    '-gmbh-co-kg',
    '-co-kg',
  ];
  for (const suf of stripSuffixes) {
    if (base.endsWith(suf)) {
      const stripped = base.slice(0, -suf.length);
      if (stripped) variants.add(stripped);
    } else {
      // Also try "base + suffix" when product stores brand without legal form.
      variants.add(`${base}${suf}`);
    }
  }

  return Array.from(variants);
}

function isGpsrPlaceholderLike(val) {
  const v = safeString(val).toLowerCase();
  if (!v) return false;
  if (v === '-' || v === '—' || v === 'n/a' || v === 'na' || v === 'k.a.' || v === 'unknown') return true;
  if (v.includes('not provided')) return true;
  if (v.includes('example.com')) return true;
  if (v === 'info@example.com') return true;
  if (v.includes('musterstraße') || v.includes('muster str') || v.includes('musterstadt') || v.includes('musterbundesland')) return true;
  if (v.includes('+49 000')) return true;
  return false;
}

function normalizeGpsrObject(gpsr) {
  const g = gpsr && typeof gpsr === 'object' && !Array.isArray(gpsr) ? { ...gpsr } : {};
  const out = {};
  [
    'entity_country',
    'manufacturer_name',
    'manufacturer_address',
    'manufacturer_city',
    'manufacturer_postalcode',
    'manufacturer_state_province',
    'email',
    'manufacturer_phone',
    'url',
  ].forEach((k) => {
    const v = safeString(g[k]);
    if (!v) return;
    if (isGpsrPlaceholderLike(v)) return;
    out[k] = v;
  });
  return out;
}

function scoreGpsr(gpsr) {
  const g = normalizeGpsrObject(gpsr);
  let score = 0;
  const has = (k) => Boolean(g[k]);
  // Weight more important fields higher
  if (has('manufacturer_name')) score += 3;
  if (has('manufacturer_address')) score += 3;
  if (has('manufacturer_city')) score += 2;
  if (has('manufacturer_postalcode')) score += 2;
  if (has('entity_country')) score += 2;
  if (has('email')) score += 2;
  if (has('manufacturer_phone')) score += 1;
  if (has('manufacturer_state_province')) score += 1;
  if (has('url')) score += 1;
  return score;
}

function mergePreferMoreComplete(base, incoming) {
  const a = normalizeGpsrObject(base);
  const b = normalizeGpsrObject(incoming);
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!v) continue;
    const cur = safeString(out[k]);
    if (!cur || isGpsrPlaceholderLike(cur)) out[k] = v;
  }
  return out;
}

async function getManufacturerGpsrByName(name) {
  const candidates = manufacturerKeyCandidates(name);
  const found = [];
  for (const key of candidates) {
    const snap = await firestore.collection(COLLECTION).doc(key).get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    const gpsr = normalizeGpsrObject(data.gpsr);
    found.push({
      key,
      manufacturer_name: safeString(data.manufacturer_name),
      gpsr,
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      sources: Array.isArray(data.sources) ? data.sources.map((x) => safeString(x)).filter(Boolean) : [],
      updated_at_iso: data.updated_at_iso || null,
      _score: scoreGpsr(gpsr),
    });
  }
  if (!found.length) return null;
  // Pick most complete; tie-break by confidence.
  found.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    const ac = typeof a.confidence === 'number' ? a.confidence : 0;
    const bc = typeof b.confidence === 'number' ? b.confidence : 0;
    return bc - ac;
  });
  const best = found[0];
  delete best._score;
  return best;
}

async function upsertManufacturerGpsr({
  manufacturer_name,
  gpsr,
  confidence = null,
  sources = [],
  from_product_id = null,
} = {}) {
  const name = safeString(manufacturer_name);
  const key = normalizeManufacturerKey(name);
  if (!key) return { ok: false, reason: 'missing_manufacturer_name' };

  const incomingGpsr = normalizeGpsrObject(gpsr || {});
  if (!incomingGpsr.manufacturer_name) incomingGpsr.manufacturer_name = name;
  if (!Object.keys(incomingGpsr).length) return { ok: false, reason: 'empty_gpsr' };

  const docRef = firestore.collection(COLLECTION).doc(key);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const existing = snap.exists ? snap.data() || {} : {};

    const mergedGpsr = mergePreferMoreComplete(existing.gpsr, incomingGpsr);
    const existingScore = scoreGpsr(existing.gpsr);
    const mergedScore = scoreGpsr(mergedGpsr);

    const existingConf = typeof existing.confidence === 'number' ? existing.confidence : 0;
    const incomingConf = typeof confidence === 'number' ? confidence : 0;

    // Prefer higher completeness; break ties with confidence.
    const shouldUpdate =
      mergedScore > existingScore ||
      (mergedScore === existingScore && incomingConf > existingConf);

    const next = {
      manufacturer_name: name,
      gpsr: mergedGpsr,
      confidence: Math.max(existingConf || 0, incomingConf || 0),
      sources: Array.from(new Set([...(existing.sources || []), ...(sources || [])]))
        .map((x) => safeString(x))
        .filter(Boolean)
        .slice(0, 20),
      updated_at_iso: new Date().toISOString(),
      last_product_id: from_product_id ? String(from_product_id) : existing.last_product_id || null,
      score: mergedScore,
    };

    if (!snap.exists) {
      tx.set(docRef, next);
    } else if (shouldUpdate) {
      tx.set(docRef, next, { merge: true });
    } else {
      // Still refresh sources/confidence minimally without downgrading GPSR
      tx.set(
        docRef,
        {
          confidence: Math.max(existingConf || 0, incomingConf || 0),
          sources: next.sources,
          updated_at_iso: new Date().toISOString(),
        },
        { merge: true }
      );
    }
  });

  return { ok: true, key };
}

module.exports = {
  normalizeManufacturerKey,
  isGpsrPlaceholderLike,
  normalizeGpsrObject,
  scoreGpsr,
  mergePreferMoreComplete,
  getManufacturerGpsrByName,
  upsertManufacturerGpsr,
};

