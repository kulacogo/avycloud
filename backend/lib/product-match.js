'use strict';

/**
 * product-match.js — deterministische Produktsuche fuer die Erfassung.
 *
 * Warum es das gibt: der Duplikat-Check der Erfassung verglich bis 2026-08-18
 * ausschliesslich Barcodes (`findProductByStrictIdentifier`). Ein Produkt ohne
 * lesbaren Barcode bekam damit IMMER ein neues Datenblatt und eine neue SKU —
 * gemessen 64 Paare "gleiches Produkt zweimal erfasst".
 *
 * Rollenverteilung (Lehre aus Incident 2026-07-08): Kandidaten werden hier
 * DETERMINISTISCH gefunden. Die KI darf spaeter urteilen, ob ein Kandidat
 * derselbe Artikel ist — sie darf aber NIE den Schluessel liefern, auf dem
 * gesucht wird. Sonst ist der Suchraum wieder die ganze Datenbank und eine
 * Halluzination trifft ein beliebiges fremdes Produkt.
 */

const { normBrand, nameTokens } = require('./reuse-guard');

// Werte, die als Herstellernummer im Bestand stehen, aber keine sind.
const MPN_PLACEHOLDERS = new Set([
  'UNKNOWN', 'UNBEKANNT', 'NA', 'NONE', 'KEINE', 'OHNE', 'NULL', 'TBD', 'DIVERSE',
]);

/**
 * Herstellernummer auf einen vergleichbaren Schluessel bringen.
 * "13.0460-7256.2" und "1304607256 2" sind dieselbe Nummer.
 * @returns {string|null} null, wenn der Wert als Schluessel untauglich ist
 */
function normalizeMpn(value) {
  if (value == null) return null;
  const normalized = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length < 3) return null;
  if (MPN_PLACEHOLDERS.has(normalized)) return null;
  if (/^0+$/.test(normalized)) return null;
  return normalized;
}

/**
 * Modellnummern-Token: Wortteile die Buchstaben UND Ziffern mischen
 * ("40PHS6000", "GSR12V"). Reine Zahlen zaehlen bewusst NICHT — das waeren
 * Wattangaben, Groessen und Jahreszahlen (gleiche Regel wie im Mehrprodukt-
 * Dedup der Bilderkennung).
 */
function modelTokens(value) {
  const out = new Set();
  for (const token of String(value == null ? '' : value).toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 4) continue;
    if (!/[a-z]/.test(token) || !/[0-9]/.test(token)) continue;
    out.add(token);
  }
  return out;
}

function intersectionSize(a, b) {
  let n = 0;
  for (const v of a) if (b.has(v)) n += 1;
  return n;
}

function jaccardSets(a, b) {
  if (!a.size || !b.size) return 0;
  const inter = intersectionSize(a, b);
  return inter / (a.size + b.size - inter);
}

/**
 * Namens-Aehnlichkeit auf ZEICHEN-Ebene (Bigramm-Dice).
 *
 * Wortvergleich taugt im Deutschen nicht: "Belagsatz" und "Bremsbelagsatz"
 * teilen kein einziges Wort, meinen aber dasselbe Produkt. Zeichenpaare fangen
 * Komposita, Plural und Umstellungen.
 *
 * Gemessen an realistischen Paaren (2026-08-18): gleiche Produkte 0,667 bis
 * 0,848, verschiedene 0,267 bis 0,400.
 */
function namensAehnlichkeit(a, b) {
  const bigramme = (wert) => {
    const t = String(wert == null ? '' : wert).toLowerCase().replace(/[^a-z0-9]/g, '');
    const menge = new Set();
    for (let i = 0; i < t.length - 1; i += 1) menge.add(t.slice(i, i + 2));
    return menge;
  };
  const A = bigramme(a);
  const B = bigramme(b);
  if (!A.size || !B.size) return 0;
  return (2 * intersectionSize(A, B)) / (A.size + B.size);
}

/**
 * Verdichtet ein Produkt auf die Felder, die fuer den Vergleich zaehlen.
 * Bewusst klein: der Katalog wird komplett im Speicher gehalten.
 */
function withoutBrandTokens(tokens, brand) {
  const brandParts = new Set(
    String(brand == null ? '' : brand).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  const out = new Set();
  for (const t of tokens) if (!brandParts.has(t)) out.add(t);
  return out;
}

function buildCatalogEntry(product = {}) {
  return {
    id: product.id || null,
    brand: product?.identification?.brand || '',
    brandNorm: normBrand(product?.identification?.brand),
    name: product?.identification?.name || '',
    nameTokens: nameTokens(product?.identification?.name),
    // Der Markenname steht in fast jedem Titel und wuerde die Namens-
    // Aehnlichkeit jedes Geschwisterprodukts kuenstlich anheben.
    distinctTokens: withoutBrandTokens(nameTokens(product?.identification?.name), product?.identification?.brand),
    modelTokens: modelTokens(product?.identification?.name),
    mpnNorm: normalizeMpn(product?.details?.identifiers?.mpn),
  };
}

/**
 * Sicherer Treffer: Marke UND Herstellernummer stimmen ueberein.
 *
 * Herstellernummern sind nicht global eindeutig — "1234" von Bosch ist nicht
 * "1234" von ATE. Deshalb zaehlt die Nummer nur zusammen mit der Marke.
 * Namens-Aehnlichkeit allein loest hier NIE etwas aus (Incident 2026-07-08:
 * SONAX ScheibenReiniger und SONAX CockpitPfleger haben Namens-Jaccard 0,43).
 *
 * @returns {{id: string, reason: string}|null}
 */
function findConfirmedMatch(fresh, entries = []) {
  const freshEntry = buildCatalogEntry(fresh);
  if (!freshEntry.mpnNorm || !freshEntry.brandNorm) return null;

  for (const entry of entries) {
    if (!entry || entry.id === freshEntry.id) continue;
    if (!entry.mpnNorm || !entry.brandNorm) continue;
    if (entry.brandNorm !== freshEntry.brandNorm) continue;
    if (entry.mpnNorm !== freshEntry.mpnNorm) continue;
    return { id: entry.id, reason: 'mpn' };
  }
  return null;
}

// Ab hier gilt ein Produkt als betrachtenswerter Kandidat. Bewusst so gesetzt,
// dass eine reine Ueberschneidung in Allerweltswoertern ("LED", "Fernseher")
// nicht reicht — ein Kandidat kostet spaeter einen KI-Aufruf.
const MIN_CANDIDATE_SCORE = 0.15;
const MODEL_TOKEN_WEIGHT = 0.6;
const NAME_OVERLAP_WEIGHT = 0.4;

/**
 * Unscharfe Kandidatensuche — immer noch ohne KI.
 *
 * Harte Grenze: zwei bekannte, verschiedene Marken werden nie gemeinsam
 * betrachtet. Ist die Marke auf einer Seite unbekannt, qualifiziert nur eine
 * uebereinstimmende Modellnummer.
 *
 * @returns {Array<{id: string, score: number, reasons: string[], entry: object}>}
 */
function selectCandidates(fresh, entries = [], { limit = 5 } = {}) {
  const freshEntry = buildCatalogEntry(fresh);
  const scored = [];

  for (const entry of entries) {
    if (!entry || !entry.id || entry.id === freshEntry.id) continue;

    const brandsKnown = Boolean(entry.brandNorm && freshEntry.brandNorm);
    if (brandsKnown && entry.brandNorm !== freshEntry.brandNorm) continue;

    const reasons = [];
    const modelHits = intersectionSize(freshEntry.modelTokens, entry.modelTokens);
    if (modelHits > 0) reasons.push('model_token');

    const overlap = jaccardSets(freshEntry.distinctTokens, entry.distinctTokens);
    if (overlap > 0) reasons.push('name_overlap');

    // Ohne beidseitig bekannte Marke ist die Namens-Aehnlichkeit zu schwach,
    // um allein einen Kandidaten zu rechtfertigen.
    if (!brandsKnown && modelHits === 0) continue;

    const score = (modelHits > 0 ? MODEL_TOKEN_WEIGHT : 0) + NAME_OVERLAP_WEIGHT * overlap;
    if (score < MIN_CANDIDATE_SCORE) continue;

    scored.push({ id: entry.id, score, reasons, entry });
  }

  scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return scored.slice(0, limit);
}

module.exports = { normalizeMpn, modelTokens, namensAehnlichkeit, buildCatalogEntry, findConfirmedMatch, selectCandidates };
