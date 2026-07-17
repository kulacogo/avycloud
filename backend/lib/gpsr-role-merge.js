'use strict';

/**
 * Reine (I/O-freie) Merge-Logik für den GPSR-Etikett-Backfill.
 *
 * Aufgeteilt aus scripts/gpsr-backfill-from-images-instock.js, damit die
 * entscheidungsrelevante Logik (Material-Change-Gate, rollenweiser Merge,
 * Nicht-EU-Compliance-Default, Fake-Gate) ohne Firestore/Gemini isoliert
 * getestet werden kann.
 */

const { normalizeGpsrObject, normalizeCountryCode } = require('./gpsr-manufacturer-registry');
const { DEFAULT_EU_REP, isNonEuManufacturer } = require('./gpsr-eu-rep');
const { looksLikeFakePhone, looksLikeSuspectEmail } = require('./gpsr-evidence');

// Feldgruppen je GPSR-Rolle. Die Etikett-Extraktion mappt manufacturer_country
// -> entity_country und manufacturer_email -> email; country_code wird aus
// entity_country abgeleitet. Alle diese Felder gehören zur HERSTELLER-Rolle.
const MFR_KEYS = [
  'manufacturer_name', 'manufacturer_address', 'manufacturer_city',
  'manufacturer_postalcode', 'manufacturer_state_province', 'entity_country',
  'country_code', 'email', 'manufacturer_phone', 'phone',
];
const EUREP_KEYS = [
  'eu_responsible_name', 'eu_responsible_address', 'eu_responsible_city',
  'eu_responsible_postalcode', 'eu_responsible_state_province',
  'eu_responsible_country', 'eu_responsible_country_code',
  'eu_responsible_email', 'eu_responsible_phone',
];

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function stripKeys(obj, keys) {
  for (const k of keys) delete obj[k];
}

function assignRole(target, labelGpsr, keys) {
  stripKeys(target, keys);
  for (const k of keys) {
    const v = safeString(labelGpsr[k]);
    if (v) target[k] = v;
  }
}

function fillMissing(target, labelGpsr, keys) {
  for (const k of keys) {
    if (!safeString(target[k]) && safeString(labelGpsr[k])) target[k] = safeString(labelGpsr[k]);
  }
}

// Firmennamen normalisieren: Groß/Klein, Interpunktion, Rechtsform-Suffixe raus.
// Damit sind "SCT-Vertriebs GmbH" und "SCT Vertriebs GmbH" gleich, "Katadyn
// Deutschland" und "Katadyn Produkte AG" bleiben verschieden.
function normName(s) {
  return safeString(s)
    .toLowerCase()
    .replace(/[.,\-/&()]+/g, ' ')
    .replace(/\b(gmbh|mbh|ag|kg|ohg|ug|co|kgaa|ltd|limited|inc|llc|bv|sarl|srl|sa|sp z o o|s r o|oy|ab|as|nv|plc|gbr|e k|corp|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Gleiche Firma? Normalisiert identisch, echtes Teilstück, oder kleine Edit-
// Distanz (OCR-Drift wie Lühdorff/Lühdorf). Konservativ — im Zweifel "verschieden".
function sameCompany(a, b) {
  const na = normName(a); const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) return true;
  const d = levenshtein(na, nb);
  return d <= 2 && d / Math.max(na.length, nb.length) < 0.2;
}

// Gleiches Land? Unbekannt auf einer Seite -> nicht als Unterschied werten.
function sameCountry(a, b) {
  const ca = (normalizeCountryCode(a) || safeString(a).toLowerCase()).trim();
  const cb = (normalizeCountryCode(b) || safeString(b).toLowerCase()).trim();
  if (!ca || !cb) return true;
  return ca === cb;
}

/**
 * Rollenweiser Merge mit Material-Change-Gate.
 *  - Etikett zeigt Hersteller, der sich MATERIELL von der Bestandsangabe
 *    unterscheidet (andere Firma ODER anderes Land) -> Block ERSETZEN (Korrektur).
 *  - Gleiche Firma + gleiches Land (kosmetisch/OCR-Drift) -> Bestandsnamen
 *    BEHALTEN, nur echte Lücken aus dem Etikett füllen ("bestätigt").
 *  - Fehlt der Hersteller bisher ganz -> aus Etikett füllen.
 * Analog für EU-Rep. Die jeweils NICHT vom Etikett gezeigte Rolle bleibt unberührt.
 * Danach: Nicht-EU-Compliance-Default (eVatmaster) + Fake-Gate-Strip (nur auf
 * NEU eingelesene Werte — Bestandsdaten werden nie gelöscht).
 *
 * @returns {{ next, contributedRoles, gateStripped, euRepDefaultApplied, materialChange }}
 */
function buildMergedGpsr(existingGpsr, labelGpsr) {
  const next = { ...(existingGpsr && typeof existingGpsr === 'object' ? existingGpsr : {}) };
  const exist = existingGpsr && typeof existingGpsr === 'object' ? existingGpsr : {};
  const label = labelGpsr && typeof labelGpsr === 'object' ? labelGpsr : {};
  const contributedRoles = [];
  let materialChange = false;

  const labelMfr = safeString(label.manufacturer_name);
  const labelEuRep = safeString(label.eu_responsible_name);

  if (labelMfr) {
    const existMfr = safeString(exist.manufacturer_name);
    const cosmetic = existMfr
      && sameCompany(existMfr, labelMfr)
      && sameCountry(exist.entity_country, label.entity_country);
    if (cosmetic) {
      fillMissing(next, label, MFR_KEYS);
      contributedRoles.push('manufacturer_confirmed');
    } else {
      assignRole(next, label, MFR_KEYS);
      contributedRoles.push('manufacturer');
      materialChange = true;
    }
  }

  if (labelEuRep) {
    const existEu = safeString(exist.eu_responsible_name);
    const cosmetic = existEu && sameCompany(existEu, labelEuRep)
      && sameCountry(exist.eu_responsible_country, label.eu_responsible_country);
    if (cosmetic) {
      fillMissing(next, label, EUREP_KEYS);
      contributedRoles.push('eu_responsible_confirmed');
    } else {
      assignRole(next, label, EUREP_KEYS);
      contributedRoles.push('eu_responsible');
      materialChange = true;
    }
  }

  const normalized = normalizeGpsrObject(next) || next;

  // Nicht-EU-Hersteller OHNE benannten EU-Rep -> Firmen-Default eVatmaster.
  // WICHTIG: nur wenn gar KEIN eu_responsible_name existiert. Nennt das Etikett
  // (oder der Bestand) einen konkreten EU-Rep, ist DIESER der rechtlich
  // Verantwortliche — er darf NIE durch den Default ersetzt werden (das wären
  // falsche Regulatory-Daten). Ein nur teil-befüllter echter EU-Rep bleibt
  // bestehen; seine Vervollständigung ist Sache des Etiketts, nicht des Defaults.
  let euRepDefaultApplied = false;
  if (isNonEuManufacturer(normalized) && !safeString(normalized.eu_responsible_name)) {
    Object.assign(normalized, DEFAULT_EU_REP);
    euRepDefaultApplied = true;
    materialChange = true;
  }

  const gateStripped = [];
  const existPhone = safeString(exist.manufacturer_phone) || safeString(exist.phone);
  const phone = safeString(normalized.manufacturer_phone) || safeString(normalized.phone);
  if (phone && phone !== existPhone && looksLikeFakePhone(phone)) {
    delete normalized.manufacturer_phone;
    delete normalized.phone;
    gateStripped.push(`fake_phone:${phone}`);
  }
  const existEmail = safeString(exist.email);
  const email = safeString(normalized.email);
  if (email && email !== existEmail) {
    const chk = looksLikeSuspectEmail(email, {
      manufacturerUrl: normalized.url,
      brand: safeString(normalized.manufacturer_name),
    });
    if (chk.suspect) {
      delete normalized.email;
      gateStripped.push(`suspect_email:${chk.reason}:${email}`);
    }
  }

  return { next: normalized, contributedRoles, gateStripped, euRepDefaultApplied, materialChange };
}

module.exports = {
  buildMergedGpsr, sameCompany, sameCountry, normName, levenshtein,
  MFR_KEYS, EUREP_KEYS,
};
