'use strict';

/**
 * GPSR EU responsible person helpers (General Product Safety Regulation EU 2023/988).
 * Manufacturers outside the EU need a separate EU economic operator / authorized rep.
 */

const { normalizeCountryCode } = require('./gpsr-manufacturer-registry');

const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

const EU_REP_FIELD_KEYS = [
  'eu_responsible_name',
  'eu_responsible_address',
  'eu_responsible_city',
  'eu_responsible_postalcode',
  'eu_responsible_state_province',
  'eu_responsible_country',
  'eu_responsible_country_code',
  'eu_responsible_email',
  'eu_responsible_phone',
];

/** Default EU authorized representative used for non-EU imports (eVatmaster). */
const DEFAULT_EU_REP = Object.freeze({
  eu_responsible_name: 'eVatmaster Consulting GmbH',
  eu_responsible_address: 'Raiffeisenstr. 2 B11',
  eu_responsible_city: 'Rodgau',
  eu_responsible_postalcode: '63110',
  eu_responsible_country: 'Germany',
  eu_responsible_country_code: 'DE',
  eu_responsible_email: 'contact@evatmaster.com',
  eu_responsible_phone: '+4961068218660',
});

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function manufacturerCountryCode(gpsr) {
  if (!gpsr || typeof gpsr !== 'object') return '';
  return safeString(gpsr.country_code) || normalizeCountryCode(gpsr.entity_country) || '';
}

function isEuCountryCode(code) {
  const c = safeString(code).toUpperCase();
  return c ? EU_COUNTRY_CODES.has(c) : false;
}

function isNonEuManufacturer(gpsr) {
  const cc = manufacturerCountryCode(gpsr);
  if (cc) return !isEuCountryCode(cc);
  const country = safeString(gpsr?.entity_country).toLowerCase();
  if (!country) return false;
  if (/china|usa|united states|japan|korea|india|vietnam|thailand|türkei|turkey|taiwan|hong kong|australia|canada|mexico|brazil|singapore|malaysia|indonesia|pakistan|philippines|switzerland|united kingdom|uk|great britain|zhaoqing|guangdong|shenzhen/.test(country)) {
    return true;
  }
  if (/germany|deutschland|austria|france|italy|spain|netherlands|poland|belgium|sweden|denmark|finland|ireland|portugal|czech|hungary|romania|bulgaria|greece|slovakia|slovenia|croatia|estonia|latvia|lithuania|luxembourg|malta|cyprus/.test(country)) {
    return false;
  }
  return false;
}

function hasEuRepFields(gpsr) {
  if (!gpsr || typeof gpsr !== 'object') return false;
  return Boolean(
    safeString(gpsr.eu_responsible_name)
      && (safeString(gpsr.eu_responsible_address) || safeString(gpsr.eu_responsible_email) || safeString(gpsr.eu_responsible_phone)),
  );
}

function looksLikeEuRepContact(email, phone) {
  const blob = `${safeString(email)} ${safeString(phone)}`.toLowerCase();
  return /evatmaster|eu rep|eu-rep|authorized rep|bevollm/i.test(blob) || /\+49/.test(blob);
}

// Structural marker: an entity acting *on behalf of* a manufacturer is, by definition,
// not the manufacturer itself — it is the EU responsible person. A real manufacturer never
// names itself "X GmbH (für Y)".
const EU_REP_ON_BEHALF_RE = /\((?:f(?:ü|ue?)r|for|on behalf of|i\.?\s?a\.?)\s+([^)]+)\)|\bim auftrag(?:\s+von)?\s+(.+)$/i;

// Known professional EU-authorized-representative / responsible-person service providers.
// Conservative list — these names are essentially never an actual product manufacturer.
const EU_REP_PROVIDER_RE = /\b(?:apex\s*ce|evatmaster|ce\s*specialists|eu[-\s]?rep(?:resentative)?|authori[sz]ed\s+representative|eu[-\s]?verantwortlich|eu[-\s]?bevollm[aä]chtigt|obelis|global\s+compliance)\b/i;

/**
 * Detects whether a company name actually denotes an EU responsible person / authorized
 * representative rather than the product manufacturer. Used to repair LLM misclassifications
 * where the EU rep was written into the manufacturer fields.
 */
function looksLikeEuRepEntity(name) {
  const n = safeString(name);
  if (!n) return false;
  return EU_REP_ON_BEHALF_RE.test(n) || EU_REP_PROVIDER_RE.test(n);
}

/** Pull the real manufacturer out of an "(für X)" / "im Auftrag von X" suffix, if present. */
function extractRepresentedManufacturer(name) {
  const n = safeString(name);
  const m = n.match(EU_REP_ON_BEHALF_RE);
  if (!m) return '';
  return safeString(m[1] || m[2]).replace(/[.,;)]+$/, '').trim();
}

/** Strip the "(für X)" / "im Auftrag von X" suffix to get the clean rep company name. */
function cleanRepName(name) {
  return safeString(name)
    .replace(/\s*\((?:f(?:ü|ue?)r|for|on behalf of|i\.?\s?a\.?)\s+[^)]*\)/i, '')
    .replace(/\s*\bim auftrag(?:\s+von)?\s+.+$/i, '')
    .trim();
}

/**
 * Repair path for the common LLM/import mistake where the EU responsible person (e.g.
 * "Apex CE Specialists GmbH (für Ominia)") was stored in the manufacturer_* fields.
 *
 * When manufacturer_name looks like an EU rep AND eu_responsible_* is still empty, the whole
 * manufacturer contact block is moved into eu_responsible_*, and the real manufacturer (parsed
 * from the "(für X)" suffix when available) is restored into manufacturer_name. Conservative:
 * only triggers on strong markers, never overwrites an existing EU rep, returns input unchanged
 * otherwise. Additive and idempotent.
 */
function reclassifyEuRepAsManufacturer(gpsr) {
  if (!gpsr || typeof gpsr !== 'object') return gpsr;
  const mfgName = safeString(gpsr.manufacturer_name);
  if (!mfgName || !looksLikeEuRepEntity(mfgName)) return gpsr;
  if (hasEuRepFields(gpsr) || safeString(gpsr.eu_responsible_name)) return gpsr;

  const next = { ...gpsr };
  const repCountryCode = safeString(next.country_code) || normalizeCountryCode(next.entity_country) || '';

  // 1) Move the manufacturer contact block → EU responsible person.
  const repPatch = {
    eu_responsible_name: cleanRepName(mfgName) || mfgName,
    eu_responsible_address: safeString(next.manufacturer_address),
    eu_responsible_city: safeString(next.manufacturer_city),
    eu_responsible_postalcode: safeString(next.manufacturer_postalcode),
    eu_responsible_state_province: safeString(next.manufacturer_state_province),
    eu_responsible_country: safeString(next.entity_country),
    eu_responsible_country_code: repCountryCode,
    eu_responsible_email: safeString(next.email),
    eu_responsible_phone: safeString(next.manufacturer_phone),
  };
  for (const [k, v] of Object.entries(repPatch)) {
    if (v) next[k] = v;
  }

  // 2) Restore the real manufacturer (from "(für X)") and clear the rep's data from manufacturer_*.
  const realManufacturer = extractRepresentedManufacturer(mfgName);
  next.manufacturer_name = realManufacturer || '';
  for (const k of [
    'manufacturer_address',
    'manufacturer_city',
    'manufacturer_postalcode',
    'manufacturer_state_province',
    'email',
    'manufacturer_phone',
    'url',
    'entity_country',
    'country_code',
  ]) {
    delete next[k];
  }
  return next;
}

function normalizeEuRepFields(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? { ...gpsr } : {};
  const out = {};
  for (const key of EU_REP_FIELD_KEYS) {
    const v = safeString(g[key]);
    if (v) out[key] = v;
  }
  if (!out.eu_responsible_country_code && out.eu_responsible_country) {
    const cc = normalizeCountryCode(out.eu_responsible_country);
    if (cc) out.eu_responsible_country_code = cc;
  }
  return out;
}

function mergeEuRepPreferExisting(existing, incoming) {
  const a = normalizeEuRepFields(existing);
  const b = normalizeEuRepFields(incoming);
  return { ...a, ...Object.fromEntries(Object.entries(b).filter(([, v]) => safeString(v))) };
}

function applyDefaultEuRep(gpsr, defaults = DEFAULT_EU_REP) {
  const merged = mergeEuRepPreferExisting(gpsr, defaults);
  return { ...(gpsr || {}), ...merged };
}

/**
 * When manufacturer is non-EU but email/phone were mixed into manufacturer fields,
 * move EU-rep-looking contacts into eu_responsible_* and strip from manufacturer contact.
 */
function demixManufacturerEuRepContacts(gpsr) {
  if (!gpsr || typeof gpsr !== 'object') return gpsr;
  if (!isNonEuManufacturer(gpsr)) return gpsr;
  const next = { ...gpsr };
  const email = safeString(next.email);
  const phone = safeString(next.manufacturer_phone);

  if (looksLikeEuRepContact(email, phone)) {
    const repPatch = {};
    if (email && /evatmaster|eu rep/i.test(email.toLowerCase())) {
      if (!safeString(next.eu_responsible_email)) repPatch.eu_responsible_email = email;
      delete next.email;
    }
    if (phone && /\+49|evatmaster|eu rep/i.test(phone.toLowerCase())) {
      if (!safeString(next.eu_responsible_phone)) repPatch.eu_responsible_phone = phone.replace(/\s*\(EU Rep\)\s*/gi, '').trim();
      delete next.manufacturer_phone;
    }
    Object.assign(next, repPatch);
  }

  if (isNonEuManufacturer(next) && !hasEuRepFields(next)) {
    return applyDefaultEuRep(next);
  }
  return next;
}

function buildResponsiblePersonFromGpsr(gpsr, envFallback = {}) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  const useEuRep = isNonEuManufacturer(g) || hasEuRepFields(g);
  if (!useEuRep) return null;

  const rep = hasEuRepFields(g) ? g : applyDefaultEuRep(g);
  const companyName = safeString(rep.eu_responsible_name);
  const street = safeString(rep.eu_responsible_address);
  const city = safeString(rep.eu_responsible_city);
  const postalCode = safeString(rep.eu_responsible_postalcode);
  const countryCode = safeString(rep.eu_responsible_country_code) || normalizeCountryCode(rep.eu_responsible_country) || 'DE';
  const phone = safeString(rep.eu_responsible_phone);
  const email = safeString(rep.eu_responsible_email);

  if (companyName && (street || email || phone)) {
    return { companyName, street: street || undefined, city: city || undefined, postalCode: postalCode || undefined, countryCode, phone: phone || undefined, email: email || undefined };
  }

  return {
    companyName: safeString(envFallback.companyName) || DEFAULT_EU_REP.eu_responsible_name,
    street: safeString(envFallback.street) || DEFAULT_EU_REP.eu_responsible_address,
    city: safeString(envFallback.city) || DEFAULT_EU_REP.eu_responsible_city,
    postalCode: safeString(envFallback.postalCode) || DEFAULT_EU_REP.eu_responsible_postalcode,
    countryCode: safeString(envFallback.countryCode) || DEFAULT_EU_REP.eu_responsible_country_code,
    phone: safeString(envFallback.phone) || DEFAULT_EU_REP.eu_responsible_phone,
    email: safeString(envFallback.email) || DEFAULT_EU_REP.eu_responsible_email,
  };
}

function buildKauflandContactFromGpsr(gpsr, fallbackName = '') {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  if (isNonEuManufacturer(g) || hasEuRepFields(g)) {
    const rep = hasEuRepFields(g) ? g : applyDefaultEuRep(g);
    const name = safeString(rep.eu_responsible_name);
    const addressParts = [
      safeString(rep.eu_responsible_address),
      safeString(rep.eu_responsible_city),
      safeString(rep.eu_responsible_postalcode),
      safeString(rep.eu_responsible_country_code) || normalizeCountryCode(rep.eu_responsible_country),
    ].filter(Boolean);
    const address = addressParts.join(', ');
    if (!name || !address) return null;
    const contact = { name, address };
    const email = safeString(rep.eu_responsible_email);
    const phone = safeString(rep.eu_responsible_phone);
    if (email) contact.email_address = email;
    if (phone) contact.phone_number = phone;
    return contact;
  }
  return null;
}

function productStock(p) {
  const bins = Array.isArray(p?.storageBins) ? p.storageBins : [];
  const binSum = bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
  if (binSum > 0) return binSum;
  return Number(p?.inventory?.quantity) || 0;
}

module.exports = {
  EU_REP_FIELD_KEYS,
  EU_COUNTRY_CODES,
  DEFAULT_EU_REP,
  manufacturerCountryCode,
  isEuCountryCode,
  isNonEuManufacturer,
  hasEuRepFields,
  looksLikeEuRepContact,
  looksLikeEuRepEntity,
  extractRepresentedManufacturer,
  reclassifyEuRepAsManufacturer,
  normalizeEuRepFields,
  mergeEuRepPreferExisting,
  applyDefaultEuRep,
  demixManufacturerEuRepContacts,
  buildResponsiblePersonFromGpsr,
  buildKauflandContactFromGpsr,
  productStock,
};
