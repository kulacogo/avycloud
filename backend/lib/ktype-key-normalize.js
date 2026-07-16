/**
 * ktype-key-normalize.js — folds any non-canonical K-Typ attribute key onto the
 * canonical `K-Typ`.
 *
 * The canonical key is `K-Typ`. Every consumer only recognizes k-typ/ktyp/k typ:
 *   - Frontend K-Typ field (components/ProductSheet.tsx)
 *   - eBay ItemCompatibility extraction (lib/ebay-direct.js KTYPE_SPECIFIC_KEYS)
 *   - K-Typ enrichment (lib/ktype-enrichment.js)
 * But the chat LLM's update_datasheet sometimes writes the data under a
 * different key like `ktype`, which orphans it: the dedicated field stays empty,
 * it is NOT sent to eBay as compatibility (and being >65 chars it fails as a
 * regular ItemSpecific), and enrichment thinks no K-Typ exists (Incident
 * 2026-07-10). This normalizes synonym keys → `K-Typ` at the save boundary, so
 * it is self-healing across ALL writers and heals existing docs on next save.
 */

const CANONICAL_KEY = 'K-Typ';

function normKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Normalized (alnum-only) synonyms that mean K-Typ. Canonical forms (k-typ,
// ktyp, "k typ") all normalize to "ktyp".
const KTYP_SYNONYMS = new Set([
  'ktyp', 'ktype', 'ktypid', 'ktypids', 'ktypeid', 'ktypeids',
  'ktypnr', 'ktypenr', 'ktypnummer', 'ktypenummer', 'ktyps', 'ktypes',
  'tecdocktype', 'tecdocktyp',
]);

function isKTypSynonymKey(key) {
  return KTYP_SYNONYMS.has(normKey(key));
}

/**
 * Fold every K-Typ-synonym key onto the canonical `K-Typ`, preserving the value
 * and the position of the first K-Typ key. If several exist, an exact-canonical
 * non-empty value wins, otherwise the first non-empty value. All-empty K-Typ
 * keys are dropped (no empty canonical key). Non-K-Typ keys are untouched.
 *
 * @param {object} attrs
 * @returns {{ attributes: object, changed: boolean, movedFrom: string[] }}
 */
function normalizeKTypAttributeKeys(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return { attributes: attrs, changed: false, movedFrom: [] };
  }
  const keys = Object.keys(attrs);
  const ktypKeys = keys.filter(isKTypSynonymKey);
  if (ktypKeys.length === 0) {
    return { attributes: attrs, changed: false, movedFrom: [] };
  }
  // Already fully canonical: a single key that is literally "K-Typ".
  if (ktypKeys.length === 1 && ktypKeys[0] === CANONICAL_KEY) {
    return { attributes: attrs, changed: false, movedFrom: [] };
  }

  const valueOf = (k) => (attrs[k] == null ? '' : String(attrs[k]).trim());
  const exactCanonical = ktypKeys.find((k) => k === CANONICAL_KEY && valueOf(k));
  const firstNonEmpty = ktypKeys.find((k) => valueOf(k));
  const chosenValue = exactCanonical ? valueOf(exactCanonical) : (firstNonEmpty ? valueOf(firstNonEmpty) : '');

  const out = {};
  let placed = false;
  for (const k of keys) {
    if (isKTypSynonymKey(k)) {
      if (!placed && chosenValue) {
        out[CANONICAL_KEY] = chosenValue;
        placed = true;
      }
      continue;
    }
    out[k] = attrs[k];
  }
  if (chosenValue && !placed) out[CANONICAL_KEY] = chosenValue;

  const movedFrom = ktypKeys.filter((k) => k !== CANONICAL_KEY);
  return { attributes: out, changed: true, movedFrom };
}

/**
 * K-Typ-WERT-Plausibilität (Incident 2026-07-16): Der Chat schrieb erfundenen
 * Text ins K-Typ-Feld ("Siehe eBay Fahrzeugverwendungsliste / KBA 60872 (als
 * formaler Platzhalter…)"). K-Typ trägt ausschließlich numerische TecDoc-IDs —
 * Text macht das Feld für eBay-ItemCompatibility wertlos.
 *
 * Akzeptiert werden:
 *   - reine ID-Listen: "111|112|211" (auch , oder ; als Trenner)
 *   - das Legacy-CSV-Format mit Anmerkung PRO Segment: "18520,Vorderachse|31593,Vorderachse"
 *     (jedes |-Segment MUSS mit einer numerischen ID beginnen)
 * Abgelehnt wird alles, dessen Segmente nicht mit einer ID beginnen
 * ("Siehe eBay…", "Hyundai i30N Vor-Facelift 275PS").
 */
function isPlausibleKTypValue(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return false;
  const segments = s.split('|').map((x) => x.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((seg) => /^\d{1,7}([^0-9]|$)/.test(seg));
}

module.exports = { normalizeKTypAttributeKeys, isKTypSynonymKey, isPlausibleKTypValue, CANONICAL_KEY };
