/**
 * Manufacturer GPSR registry:
 * Keep one canonical GPSR record per manufacturer to avoid per-product variance.
 */

const { Firestore } = require('@google-cloud/firestore');

// IMPORTANT: This module must NOT import ./firestore to avoid circular dependencies.
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

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

function normalizeCountryToEnglish(raw) {
  const v = safeString(raw).trim();
  if (!v) return '';
  const upper = v.toUpperCase();
  const codeMap = {
    DE: 'Germany',
    AT: 'Austria',
    CH: 'Switzerland',
    NL: 'Netherlands',
    PL: 'Poland',
    SE: 'Sweden',
    FR: 'France',
    IT: 'Italy',
    ES: 'Spain',
    BE: 'Belgium',
    DK: 'Denmark',
    NO: 'Norway',
    FI: 'Finland',
    GB: 'United Kingdom',
    UK: 'United Kingdom',
    IE: 'Ireland',
    PT: 'Portugal',
    CZ: 'Czechia',
    SK: 'Slovakia',
    HU: 'Hungary',
    RO: 'Romania',
    BG: 'Bulgaria',
    GR: 'Greece',
    TR: 'Turkey',
  };
  if (/^[A-Z]{2}$/.test(upper) && codeMap[upper]) return codeMap[upper];
  const lower = v.toLowerCase();
  if (lower === 'deutschland') return 'Germany';
  if (lower === 'österreich' || lower === 'osterreich') return 'Austria';
  if (lower === 'schweiz') return 'Switzerland';
  return v;
}

function normalizeCountryCode(raw) {
  const v = safeString(raw).trim();
  if (!v) return '';
  const upper = v.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) {
    // User requirement: treat United Kingdom as "UK" (marketplace convention).
    if (upper === 'GB') return 'UK';
    return upper;
  }
  const normalized = normalizeCountryToEnglish(v);
  const key = safeString(normalized).toLowerCase();
  const nameToCode = {
    germany: 'DE',
    austria: 'AT',
    switzerland: 'CH',
    netherlands: 'NL',
    poland: 'PL',
    sweden: 'SE',
    france: 'FR',
    italy: 'IT',
    spain: 'ES',
    belgium: 'BE',
    denmark: 'DK',
    norway: 'NO',
    finland: 'FI',
    ireland: 'IE',
    portugal: 'PT',
    czechia: 'CZ',
    slovakia: 'SK',
    hungary: 'HU',
    romania: 'RO',
    bulgaria: 'BG',
    greece: 'GR',
    turkey: 'TR',
    'united kingdom': 'UK',
    'great britain': 'UK',
    england: 'UK',
    scotland: 'UK',
    wales: 'UK',
    'northern ireland': 'UK',
  };
  return nameToCode[key] || '';
}

function normalizeGpsrPhone(raw) {
  const v = safeString(raw);
  if (!v) return '';
  const first = v.split(/[;|,]+/).map((x) => safeString(x)).filter(Boolean)[0] || '';
  if (!first) return '';
  const trimmed = first.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed
    .replace(/\(0\)/g, '')
    .replace(/[^\d]/g, '')
    .trim();
  if (!digits) return '';
  if (!hasPlus && digits.startsWith('00') && digits.length > 2) {
    return `+${digits.slice(2)}`;
  }
  return hasPlus ? `+${digits}` : digits;
}

function normalizeStreetOnly(address) {
  const raw = safeString(address);
  if (!raw) return '';
  // Keep only street+house part (before commas) to match GPSR policy.
  const parts = raw.split(',').map((p) => safeString(p)).filter(Boolean);
  return safeString(parts[0] || raw);
}

function normalizeGpsrObject(gpsr) {
  const g = gpsr && typeof gpsr === 'object' && !Array.isArray(gpsr) ? { ...gpsr } : {};
  const out = {};
  [
    'entity_country',
    'country_code',
    'manufacturer_name',
    'manufacturer_address',
    'manufacturer_city',
    'manufacturer_postalcode',
    'manufacturer_state_province',
    'email',
    'manufacturer_phone',
    'url',
    'eu_responsible_name',
    'eu_responsible_address',
    'eu_responsible_city',
    'eu_responsible_postalcode',
    'eu_responsible_state_province',
    'eu_responsible_country',
    'eu_responsible_country_code',
    'eu_responsible_email',
    'eu_responsible_phone',
  ].forEach((k) => {
    let v = safeString(g[k]);
    if (!v) return;
    if (isGpsrPlaceholderLike(v)) return;
    if (k === 'entity_country') v = normalizeCountryToEnglish(v);
    if (k === 'manufacturer_phone') v = normalizeGpsrPhone(v);
    if (k === 'manufacturer_address') v = normalizeStreetOnly(v);
    out[k] = v;
  });

  // Derive country_code if possible (deterministic, no guessing)
  if (!safeString(out.country_code) && safeString(out.entity_country)) {
    const code = normalizeCountryCode(out.entity_country);
    if (code) out.country_code = code;
  }

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

function mergePreferIncoming(base, incoming) {
  const a = normalizeGpsrObject(base);
  const b = normalizeGpsrObject(incoming);
  // Overwrite only with non-empty, non-placeholder incoming fields.
  // Never delete existing fields by writing empty values.
  const out = { ...a, ...b };
  // Derive country_code if possible (deterministic, no guessing)
  if (!safeString(out.country_code) && safeString(out.entity_country)) {
    const code = normalizeCountryCode(out.entity_country);
    if (code) out.country_code = code;
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
  overwrite = false,
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

    const mergedGpsr = overwrite
      ? mergePreferIncoming(existing.gpsr, incomingGpsr)
      : mergePreferMoreComplete(existing.gpsr, incomingGpsr);
    const existingScore = scoreGpsr(existing.gpsr);
    const mergedScore = scoreGpsr(mergedGpsr);

    const existingConf = typeof existing.confidence === 'number' ? existing.confidence : 0;
    const incomingConf = typeof confidence === 'number' ? confidence : 0;

    const changed =
      JSON.stringify(normalizeGpsrObject(existing.gpsr)) !== JSON.stringify(normalizeGpsrObject(mergedGpsr));

    // Prefer higher completeness; break ties with confidence.
    const shouldUpdate = overwrite
      ? changed
      : mergedScore > existingScore ||
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
  manufacturerKeyCandidates,
  isGpsrPlaceholderLike,
  normalizeCountryToEnglish,
  normalizeCountryCode,
  normalizeGpsrPhone,
  normalizeGpsrObject,
  scoreGpsr,
  mergePreferIncoming,
  mergePreferMoreComplete,
  getManufacturerGpsrByName,
  upsertManufacturerGpsr,
};

