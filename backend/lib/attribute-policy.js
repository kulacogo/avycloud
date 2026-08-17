/* eslint-disable no-console */
/**
 * Attribute policy for AvyCloud (shared across Identify/Improve/Chat/Imports/Sync).
 *
 * Goals (strict):
 * - Canonicalize keys (case/whitespace/synonyms) deterministically.
 * - Prevent duplicate attributes (structural + semantic duplicates).
 * - Hard-block marketplace/internal/meta keys from being stored/synced.
 *
 * IMPORTANT:
 * - We do not invent values.
 * - If two keys map to the same canonical key with conflicting values, that's a policy violation.
 */

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function normKey(key = '') {
  return normalizeSpaces(key).toLowerCase();
}

function normVal(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return normalizeSpaces(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return normalizeSpaces(JSON.stringify(value));
  } catch {
    return normalizeSpaces(String(value));
  }
}

const DEFAULT_ATTRIBUTE_VALUE_MAX_LEN = 60;

function isKTypAttributeKey(key = '') {
  const k = normKey(key).replace(/[^a-z0-9]/g, '');
  return k === 'ktyp';
}

function truncateToMaxChars(text = '', maxLen = DEFAULT_ATTRIBUTE_VALUE_MAX_LEN) {
  const raw = normalizeSpaces(text);
  if (!raw) return '';
  const limit = Math.max(1, Math.min(400, Number(maxLen) || DEFAULT_ATTRIBUTE_VALUE_MAX_LEN));
  const chars = Array.from(raw);
  if (chars.length <= limit) return raw;
  const cut = chars.slice(0, limit).join('');
  const idx = cut.lastIndexOf(' ');
  const minBreak = Math.max(18, Math.floor(limit * 0.6));
  const out = idx >= minBreak ? cut.slice(0, idx) : cut;
  return normalizeSpaces(out);
}

function coerceAttributeValueToPolicy(key, value, { maxLen = DEFAULT_ATTRIBUTE_VALUE_MAX_LEN } = {}) {
  const v = normVal(value);
  if (!v) return '';
  if (isKTypAttributeKey(key)) return v;
  return truncateToMaxChars(v, maxLen);
}

// Hard-block keys that must never be stored as attributes (internal/marketplace/meta).
function isBlockedAttributeKey(key) {
  const k = normKey(key);
  if (!k) return true;
  if (k.includes('ebay')) return true;
  if (k.includes('kaufland')) return true;
  if (k.endsWith('_id') || k === 'id' || k === 'product_id') return true;
  if (k.includes('category_id') || k.includes('category path') || k.includes('category_path')) return true;
  if (k.startsWith('text_') || k.startsWith('features') || k.includes('integration')) return true;
  // GPSR must be stored under details.gpsr, never as a regular attribute.
  if (k.startsWith('gpsr ')) return true;
  return false;
}

/**
 * Zusätzliche Sperre NUR für den Chat-Schreibweg (Vorfall 2026-08-17).
 *
 * Der K-Typ ist eine Zahlen-Kennung aus eBays Fahrzeugliste (MVL). Er wird von
 * lib/ktype-enrichment.js NACHGESCHLAGEN — ausdrücklich ohne Raten. Ein vom
 * Modell geschätzter K-Typ geht als Fahrzeug-Verwendungsliste an eBay und
 * behauptet Passgenauigkeit für Fahrzeuge, die nie geprüft wurden.
 * HSN/TSN sind der BELEG für diesen Nachschlag, kein Datenblattfeld.
 *
 * Bewusst NICHT in isBlockedAttributeKey(): dieselbe Funktion läuft über jedes
 * gespeicherte Produkt (llm-rulebook, identify-v3-stage3, product-validator).
 * Dort zu sperren würde beim nächsten Speichern jeden echten K-Typ im Bestand
 * löschen — aus einer Schutzmaßnahme würde ein Datenverlust.
 */
function isChatWriteBlockedAttributeKey(key) {
  // Umlaute zuerst auflösen — sonst wird aus "Schlüsselnummer" beim Entfernen
  // der Sonderzeichen "schlsselnummer" und die Sperre greift nicht.
  const k = normKey(key)
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
  if (!k) return true;
  if (k === 'ktyp' || k === 'ktype' || k === 'ktypnummer' || k === 'ktypen') return true;
  if (k === 'hsn' || k === 'tsn' || k === 'hsntsn' || k === 'tsnhsn') return true;
  if (k === 'kba' || k.startsWith('kbanummer') || k.startsWith('kbaschluessel')) return true;
  if (k.startsWith('schluesselnummer')) return true;
  if (k.startsWith('typschluessel')) return true;
  return isBlockedAttributeKey(key);
}

// Canonicalize common synonym keys (German/English variants) to one canonical key.
// This list is intentionally conservative; add more synonyms as they appear.
const CANONICAL_KEY_MAP = new Map([
  // Brand
  ['marke', 'Marke'],
  ['brand', 'Marke'],
  ['hersteller', 'Hersteller'],
  ['manufacturer', 'Hersteller'],

  // Product type
  ['produktart', 'Produktart'],
  ['produkttyp', 'Produktart'],
  ['product type', 'Produktart'],
  ['product_type', 'Produktart'],

  // Identifiers
  ['mpn', 'Herstellernummer'],
  ['herstellernummer', 'Herstellernummer'],
  ['manufacturer number', 'Herstellernummer'],
  ['manufacturernummer', 'Herstellernummer'],
  ['oem', 'OE/OEM Referenznummer(n)'],
  ['oem-referenznummer', 'OE/OEM Referenznummer(n)'],
  ['oe/oem referenznummer(n)', 'OE/OEM Referenznummer(n)'],
  ['referenznummer(n) oem', 'OE/OEM Referenznummer(n)'],
  ['referenznummer', 'Referenznummer'],

  // Condition
  ['zustand', 'Zustand'],
  ['condition', 'Zustand'],

  // Color / Size / Material
  ['farbe', 'Farbe'],
  ['color', 'Farbe'],
  ['colour', 'Farbe'],
  ['größe', 'Größe'],
  ['groesse', 'Größe'],
  ['size', 'Größe'],
  ['material', 'Material'],

  // Compatibility
  ['k-typ', 'K-Typ'],
  ['ktyp', 'K-Typ'],
  ['k typ', 'K-Typ'],
]);

function canonicalizeAttributeKey(rawKey) {
  const key = normalizeSpaces(rawKey);
  if (!key) return '';
  // Allow runtime overrides from admin rulebook config.
  try {
    const { getRulebookConfigCached } = require('./rulebook-config');
    const cfg = getRulebookConfigCached();
    const map = cfg?.attributes?.canonicalKeyMap && typeof cfg.attributes.canonicalKeyMap === 'object' ? cfg.attributes.canonicalKeyMap : null;
    const lower = normKey(key);
    if (map && Object.prototype.hasOwnProperty.call(map, lower)) {
      const v = normalizeSpaces(map[lower]);
      if (v) return v;
    }
  } catch {
    // ignore config read errors
  }

  const mapped = CANONICAL_KEY_MAP.get(normKey(key));
  return mapped || key;
}

/**
 * Canonicalize + validate attributes.
 * Returns:
 * - ok=false with issues if duplicates/conflicts exist
 * - ok=true with canonical attributes map
 */
function canonicalizeAttributesStrict(input) {
  const attrs = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const issues = [];

  const out = {};
  const seen = new Map(); // canonicalKeyLower -> { key, valueNorm, rawKey, rawVal }

  for (const [rawKey, rawVal] of Object.entries(attrs)) {
    const originalKey = normalizeSpaces(rawKey);
    if (!originalKey) continue;
    if (isBlockedAttributeKey(originalKey)) {
      issues.push(`attribute_key_blocked:${originalKey}`);
      continue;
    }

    const canonicalKey = canonicalizeAttributeKey(originalKey);
    if (!canonicalKey) continue;

    const value = coerceAttributeValueToPolicy(canonicalKey, rawVal);
    if (!value) continue;

    const ck = normKey(canonicalKey);
    const existing = seen.get(ck);
    if (!existing) {
      seen.set(ck, { key: canonicalKey, valueNorm: value, rawKey: originalKey });
      out[canonicalKey] = value;
      continue;
    }

    // Duplicate key (structural or semantic). If values are equal (case-insensitive), keep one.
    const a = existing.valueNorm.toLowerCase();
    const b = value.toLowerCase();
    if (a === b) {
      // ok: identical duplicate -> ignore silently
      continue;
    }

    // Conflict: same canonical key, different value -> violation (no best-effort merge).
    issues.push(`attribute_duplicate_conflict:${existing.key}<-${existing.rawKey} vs ${canonicalKey}<-${originalKey}`);
  }

  return { ok: issues.length === 0, attributes: out, issues };
}

module.exports = {
  canonicalizeAttributesStrict,
  canonicalizeAttributeKey,
  coerceAttributeValueToPolicy,
  isBlockedAttributeKey,
  isChatWriteBlockedAttributeKey,
};

