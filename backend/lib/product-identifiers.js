'use strict';

/**
 * Kanonische Produkt-Identifier: EAN / UPC / GTIN als je EIN Wert pro Typ.
 *
 * Hintergrund (Incident 2026-07-13): Das Barcode-Feld akkumulierte mehrere
 * Codes und ließ sich weder per Chat noch manuell korrigieren, weil drei
 * "additive-only"-Schichten (Chat-Union, Save-Rückfaltung aus identifiers,
 * nur identity.clear löscht) jede Reduktion rückgängig machten.
 *
 * Neues Modell: `details.identifiers.{ean,upc,gtin}` sind kanonisch (Einzelwert,
 * streng validiert). `identification.barcodes` wird daraus ABGELEITET (eindeutige
 * Liste) — nur noch Ausgabe/Index für Suche + Marktplatz-Matching.
 *
 * Stellenzahlen (GS1): EAN = 13 (oder EAN-8 = 8), UPC-A = 12, GTIN-14 = 14.
 * Jeder Wert muss zusätzlich die Prüfziffer bestehen (isValidGtin).
 */

const { normalizeDigits, isValidGtin } = require('./gtin');

// Erlaubte Stellenzahlen je kanonischem Feld.
const FIELD_LENGTHS = Object.freeze({
  ean: [13, 8],
  upc: [12],
  gtin: [14],
});

const CANONICAL_FIELDS = ['ean', 'upc', 'gtin'];

function toDigits(value) {
  return normalizeDigits(String(value == null ? '' : value));
}

/**
 * Ordnet einen rohen Code seinem kanonischen Feld zu (nach Stellenzahl) und
 * prüft die Prüfziffer.
 * @returns {{ field: 'ean'|'upc'|'gtin'|null, value: string, valid: boolean, reason: string }}
 */
function classifyCode(raw) {
  const value = toDigits(raw);
  if (!value) return { field: null, value: '', valid: false, reason: 'empty' };
  let field = null;
  if (value.length === 13 || value.length === 8) field = 'ean';
  else if (value.length === 12) field = 'upc';
  else if (value.length === 14) field = 'gtin';
  if (!field) return { field: null, value, valid: false, reason: 'unsupported_length' };
  if (!isValidGtin(value)) return { field, value, valid: false, reason: 'bad_checkdigit' };
  return { field, value, valid: true, reason: 'ok' };
}

/**
 * Validiert einen Wert, der GEZIELT in ein Feld (ean/upc/gtin) eingegeben wurde.
 * Leerer Wert = Feld leeren (ok:true, empty:true).
 * @returns {{ ok: boolean, value: string, empty?: boolean, reason?: string, expected?: number[] }}
 */
function validateFieldValue(field, raw) {
  const value = toDigits(raw);
  if (!value) return { ok: true, value: '', empty: true };
  const lengths = FIELD_LENGTHS[field] || [];
  if (!lengths.includes(value.length)) {
    return { ok: false, value, reason: 'length', expected: lengths };
  }
  if (!isValidGtin(value)) return { ok: false, value, reason: 'checkdigit', expected: lengths };
  return { ok: true, value, empty: false };
}

/**
 * Leitet die eindeutige barcodes-Liste aus den kanonischen Identifiern ab.
 */
function deriveBarcodes(identifiers = {}) {
  const out = [];
  for (const field of CANONICAL_FIELDS) {
    const v = toDigits(identifiers[field]);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Klassifiziert eine Barcode-Liste zu je einem Wert pro Feld (erster gültiger
 * Treffer gewinnt). Ungültige Codes werden gesammelt.
 */
function classifyList(barcodes = []) {
  const byField = { ean: null, upc: null, gtin: null };
  const invalid = [];
  for (const raw of Array.isArray(barcodes) ? barcodes : []) {
    const c = classifyCode(raw);
    if (!c.value) continue;
    if (c.valid && c.field && !byField[c.field]) byField[c.field] = c.value;
    else if (!c.valid) invalid.push(c.value);
  }
  return { byField, invalid };
}

/**
 * MAßGEBLICHER (manuell / Chat-auf-Anweisung) Reconcile.
 *
 * Der Nutzer/Chat ist Autorität: eingegebene Werte ERSETZEN, entfernte werden
 * entfernt. Nichts wird aus alten identifiers zurückgefaltet.
 *
 * Präzedenz je Feld:
 *   1. Explizit GEÄNDERTES identifier-Feld (incoming ≠ existing) — inkl. Leeren.
 *   2. Sonst: aus der eingehenden barcodes-Liste abgeleitet.
 *   3. Sonst: leer.
 *
 * @param {object} p
 * @param {object} p.existingIdentifiers  bisher gespeicherte details.identifiers
 * @param {object} p.incomingIdentifiers  eingehende (gemergte) details.identifiers
 * @param {string[]} p.incomingBarcodes   eingehende identification.barcodes
 * @returns {{ identifiers: object, barcodes: string[], invalid: string[], cleared: string[] }}
 */
function reconcileAuthoritative({ existingIdentifiers = {}, incomingIdentifiers = {}, incomingBarcodes = [] }) {
  const existing = existingIdentifiers || {};
  const incoming = incomingIdentifiers || {};
  const { byField, invalid } = classifyList(incomingBarcodes);
  const invalidSet = new Set(invalid);

  // Nicht-kanonische Felder (isbn/mpn/sku/…) unverändert übernehmen.
  const result = { ...incoming };
  const cleared = [];

  for (const field of CANONICAL_FIELDS) {
    const incVal = toDigits(incoming[field]);
    const existVal = toDigits(existing[field]);
    const edited = incVal !== existVal; // explizit geändert (auch Leeren zählt)

    let chosen = '';
    if (edited) {
      if (incVal === '') {
        chosen = ''; // explizit geleert
      } else {
        const v = validateFieldValue(field, incVal);
        if (v.ok && !v.empty) chosen = v.value;
        else {
          invalidSet.add(incVal);
          chosen = byField[field] || ''; // ungültige Eingabe → Fallback aus Barcodes
        }
      }
    } else {
      chosen = byField[field] || ''; // nicht geändert → aus Barcodes ableiten
    }

    if (chosen) result[field] = chosen;
    else {
      if (result[field]) cleared.push(field);
      delete result[field];
    }
  }

  const barcodes = deriveBarcodes(result);
  return { identifiers: result, barcodes, invalid: Array.from(invalidSet), cleared };
}

module.exports = {
  FIELD_LENGTHS,
  CANONICAL_FIELDS,
  classifyCode,
  validateFieldValue,
  deriveBarcodes,
  classifyList,
  reconcileAuthoritative,
};
