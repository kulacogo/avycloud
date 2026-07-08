'use strict';

/**
 * reuse-guard.js — Schutz gegen Falsch-Reuse beim Produkt-Erfassen.
 *
 * Incident 2026-07-08 (PRODUKTIONS-STOP): OCR liest auf Verpackungen gedruckte
 * Nicht-Barcodes (Hersteller-Telefonnummern, Datumsangaben, Größenläufe,
 * entstrichelte MPNs, "00000000") als vermeintliche EAN-8. Die schwache
 * EAN-8-Prüfziffer (nur mod-10) besteht ~1 von 10 beliebiger 8-stelliger Zahlen.
 * Solche Codes wurden als Identity-Key persistiert; findProductByStrictIdentifier
 * matchte sie OHNE Marken-/Namens-Check → zwei VERSCHIEDENE Produkte desselben
 * Herstellers (z.B. zwei SONAX-Artikel, geteilte Servicenummer 08431530)
 * kollabierten auf EIN Datenblatt, das frische Ergebnis wurde verworfen.
 *
 * Zwei Bausteine:
 *  - buildReusePools(): trennt EXPLIZITE Barcodes (gescannt/getippt → trusted,
 *    jede Länge) von OCR-abgeleiteten (nur STARKER GTIN Länge >= 12 darf Reuse
 *    triggern; nackte OCR-EAN-8 sind praktisch immer Nicht-Barcodes).
 *  - reuseMatchConsistent(): ein OCR-getriggerter Treffer wird nur akzeptiert,
 *    wenn Marke des Treffers zum frisch erkannten Produkt passt UND die
 *    Namens-Token signifikant überlappen. Verschiedene Hersteller ⇒ nie Reuse.
 *
 * Fehlerrichtung by design: Ein False-Negative erzeugt höchstens eine reguläre,
 * manuell mergebare Dublette (eigene UUID via saveProductV2) — NIE ein
 * Überschreiben eines fremden Datenblatts. Strikt sicherer als der Status quo.
 */

const BRAND_SUFFIX = /\b(gmbh|kgaa|kg|ag|ltd|inc|co|se|mbh|bv|srl|sarl|oy|ab|as|llc|plc)\b/g;

function normBrand(s) {
  return (s == null ? '' : String(s))
    .toLowerCase()
    .replace(BRAND_SUFFIX, '')
    .replace(/[^a-z0-9]/g, '');
}

function nameTokens(s) {
  return new Set(
    (s == null ? '' : String(s))
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Ist ein OCR-getriggerter Reuse-Treffer plausibel DASSELBE Produkt?
 * @param {object} fresh    frisch identifiziertes Produkt ({identification:{brand,name}})
 * @param {object} matched  Bestandsprodukt aus findProductByStrictIdentifier
 * @param {object} opts     { minJaccard = 0.3 }
 * @returns {boolean}       true = reuse erlaubt
 */
function reuseMatchConsistent(fresh, matched, { minJaccard = 0.3 } = {}) {
  const fb = normBrand(fresh?.identification?.brand);
  const mb = normBrand(matched?.identification?.brand);
  // Zwei bekannte, verschiedene Marken ⇒ NIE reusen (Kern des Incidents).
  if (fb && mb && fb !== mb) return false;

  const fn = nameTokens(fresh?.identification?.name);
  const mn = nameTokens(matched?.identification?.name);
  // Ohne verwertbare Namen: nur reusen, wenn beide Marken bekannt UND gleich.
  if (!fn.size || !mn.size) return Boolean(fb && mb && fb === mb);

  return jaccard(fn, mn) >= minJaccard;
}

/**
 * Trennt Reuse-Barcodes in vertrauenswürdige (explizit) und OCR-abgeleitete Pools.
 * @param {string[]} explicitBarcodes  vom Request (gescannt/getippt)
 * @param {string[]} ocrBarcodes       aus den Bildern extrahiert
 * @param {object} opts { limit = 12, minOcrLen = 12 }
 * @returns {{explicit: string[], ocr: string[]}}
 */
function buildReusePools(explicitBarcodes = [], ocrBarcodes = [], { limit = 12, minOcrLen = 12 } = {}) {
  const explicit = [
    ...new Set((explicitBarcodes || []).map((c) => String(c).trim()).filter(Boolean)),
  ].slice(0, limit);
  const explicitSet = new Set(explicit);
  const ocr = [
    ...new Set((ocrBarcodes || []).map((c) => String(c).trim()).filter(Boolean)),
  ]
    .filter((c) => !explicitSet.has(c))
    .filter((c) => c.length >= minOcrLen) // nackte OCR-EAN-8 (Länge 8) fliegen raus
    .slice(0, limit);
  return { explicit, ocr };
}

module.exports = { reuseMatchConsistent, buildReusePools, normBrand, nameTokens, jaccard };
