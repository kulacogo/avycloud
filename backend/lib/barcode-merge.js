'use strict';

const { isValidGtin, normalizeDigits, getGtinType } = require('./gtin');

/**
 * Merge der Barcode-Kandidaten fuer Identify (Stage 1 / V2 grounding).
 *
 * Invariante (Incident 2026-07-08): physisch belegte Codes — explizit
 * uebergebene Barcodes und per OCR aus GENAU diesen Bildern gelesene —
 * schlagen IMMER KI-/Grounding-aufgeloeste Codes. Grounding-EAN/GTIN/UPC
 * werden nur als Fallback akzeptiert, wenn kein einziger physischer Code
 * gueltig ist. Eine bei Grounding-Ausfall halluzinierte Fremd-EAN darf weder
 * ins Datenblatt noch in Duplikat-Checks gelangen.
 *
 * @param {object} opts
 * @param {string[]} opts.physicalBarcodes  explizite + OCR-Barcodes
 * @param {object}   opts.groundingResult   { ean, gtin, upc } aus Gemini Grounding
 * @returns {{ ean: string, gtin: string, upc: string, ranked: Array<{code, type, valid, source}> }}
 */
function mergeBarcodeCandidates({ physicalBarcodes = [], groundingResult = {}, explicitBarcodes = [] } = {}) {
  const physical = [
    ...new Set(
      physicalBarcodes
        .map((c) => (c == null ? '' : String(c).trim()))
        .filter(Boolean)
    ),
  ].filter((b) => isValidGtin(b));

  let candidates = physical.map((code) => ({ code, source: 'physical' }));

  if (!physical.length) {
    const groundingCodes = [
      normalizeDigits(groundingResult.ean || ''),
      normalizeDigits(groundingResult.gtin || ''),
      normalizeDigits(groundingResult.upc || ''),
    ].filter(Boolean);
    const uniqueGrounding = [...new Set(groundingCodes)].filter((b) => isValidGtin(b));
    candidates = uniqueGrounding.map((code) => ({ code, source: 'grounding' }));
  }

  // FIX C (Incident 2026-07-08, SONAX 08431530): EAN-8 nur behalten, wenn
  // EXPLIZIT gescannt/getippt. OCR-/Grounding-abgeleitete EAN-8 sind fast immer
  // Nicht-Barcodes (Hersteller-Telefon/Datum/Groessenlauf), die die schwache
  // EAN-8-Pruefziffer zufaellig bestehen — sie duerfen nicht als Identity-Barcode
  // ins Datenblatt (sonst Falsch-Reuse-Attraktor + falsche Listing-EAN).
  const explicitSet = new Set((explicitBarcodes || []).map((c) => String(c).trim()).filter(Boolean));
  candidates = candidates.filter(
    (c) => getGtinType(c.code) !== 'ean8' || explicitSet.has(c.code)
  );

  const ranked = candidates.map(({ code, source }) => ({
    code,
    type: getGtinType(code),
    valid: true,
    source,
  }));

  return {
    ean: ranked.find((b) => b.type === 'ean13')?.code || '',
    gtin: ranked.find((b) => b.type === 'gtin14')?.code || '',
    upc: ranked.find((b) => b.type === 'upc12')?.code || '',
    ranked,
  };
}

module.exports = { mergeBarcodeCandidates };
