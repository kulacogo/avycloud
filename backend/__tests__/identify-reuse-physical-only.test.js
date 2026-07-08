// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Regression-Guard: Falsches Duplikat-Reuse beim Erfassen (Incident 2026-07-08)
//
// Drei verschiedene ATE-Produkte (klar lesbare, unterschiedliche EAN/MPN auf
// den Fotos) wurden beim Erfassen als EIN bereits bestehendes Produkt
// "wiedererkannt" (products_v2/4006633149839). Ursache: Der Duplikat-Check in
// routes/identify.js akzeptierte KI-/Web-aufgeloeste Identifier (Gemini
// Grounding EAN/GTIN/UPC + LLM-SKU) als Beweis. Bei Grounding-Timeouts
// halluzinierte das Modell eine bekannte Fremd-EAN → strikter Match auf ein
// fremdes Bestandsprodukt → das frische Identify-Ergebnis wurde
// stillschweigend durch den alten Datensatz ersetzt.
//
// Invariante seither:
//   Ein Duplikat-Reuse darf NUR durch physisch belegte Identifier ausgeloest
//   werden — explizit uebergebene Barcodes (Scanner/Eingabe) und per OCR aus
//   GENAU diesen Bildern gelesene Barcodes. LLM-/Grounding-aufgeloeste
//   EAN/GTIN/UPC/SKU duerfen das Datenblatt anreichern, aber NIE ein Reuse
//   triggern.

const fs = require('fs');
const path = require('path');

const routeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'identify.js'),
  'utf8'
);

describe('Identify Duplikat-Reuse — nur physische Barcodes (Incident 2026-07-08)', () => {
  it('Post-V3-Check baut keine Reuse-Barcodes aus KI-aufgeloesten Identifiern', () => {
    // Frueherer Suender: v3Barcodes aus product.details.identifiers.ean/gtin/upc
    // + product.identification.barcodes (enthielt Grounding-Halluzinationen).
    expect(routeSrc).not.toMatch(/const\s+v3Barcodes\s*=/);
    expect(routeSrc).not.toMatch(/v3Sku/);
  });

  it('Post-Grounding-Check nutzt keine groundedRecord-EANs und keine LLM-SKU', () => {
    expect(routeSrc).not.toMatch(/const\s+groundedBarcodes\s*=/);
    expect(routeSrc).not.toMatch(/groundedSku/);
  });

  it('Legacy-Check nutzt keine barcodeInsights-Aufloesungen und keine LLM-SKU', () => {
    expect(routeSrc).not.toMatch(/const\s+legacyBarcodes\s*=[\s\S]{0,400}barcodeInsights/);
    expect(routeSrc).not.toMatch(/legacySku/);
  });

  it('Post-Identify-Reuse laeuft ueber findReuseMatch (SONAX-Haertung 2026-07-08)', () => {
    // Nach dem SONAX-Incident laufen alle drei Post-Checks (V3/Grounding/Legacy)
    // ueber findReuseMatch(product) — explizit-vs-OCR getrennt + Konsistenz-Gate.
    const findReuseMatchCalls = routeSrc.match(/await\s+findReuseMatch\(/g) || [];
    expect(findReuseMatchCalls.length).toBeGreaterThanOrEqual(3);
    // Der alte, ungehaertete Sammel-Pool ist weg.
    expect(routeSrc).not.toMatch(/physicalReuseBarcodes/);
  });

  it('nutzt buildReusePools + reuseMatchConsistent (starker-GTIN-OCR + Marken-Gate)', () => {
    expect(routeSrc).toMatch(/buildReusePools/);
    expect(routeSrc).toMatch(/reuseMatchConsistent/);
    // OCR-Treffer muss durch das Konsistenz-Gate:
    expect(routeSrc).toMatch(/reuseMatchConsistent\(fresh,\s*m\)/);
  });

  it('OCR-Barcodes gehen nicht mehr ungefiltert in einen Reuse-Lookup', () => {
    // Frueher: findProductByStrictIdentifier({ barcodes: physicalReuseBarcodes })
    // = explicit ∪ OCR ohne Laengen-/Konsistenz-Gate. Darf es nicht mehr geben.
    // (mergedBarcodes bleibt im Response-Meta erlaubt — nur der LOOKUP zaehlt.)
    expect(routeSrc).not.toMatch(/findProductByStrictIdentifier\(\{\s*\n?\s*barcodes:\s*mergedBarcodes/);
    expect(routeSrc).not.toMatch(/findProductByStrictIdentifier\(\{\s*\n?\s*barcodes:\s*physicalReuseBarcodes/);
  });

  it('Reuse-Lookups uebergeben keine sku mehr (LLM-SKU war Reuse-Vektor)', () => {
    // sku:-Property innerhalb eines findProductByStrictIdentifier-Aufrufs
    const skuInLookup = routeSrc.match(/findProductByStrictIdentifier\(\{[^}]*sku:\s*(?!null)[a-zA-Z]/g) || [];
    expect(skuInLookup).toEqual([]);
  });
});
