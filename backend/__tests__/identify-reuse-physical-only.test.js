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

  it('alle Post-Identify-Reuse-Aufrufe laufen ueber physicalReuseBarcodes', () => {
    // Jeder Reuse-Lookup NACH einer KI-Pipeline muss die eine, physisch
    // belegte Quelle nutzen (explizite + OCR-Barcodes dieses Requests).
    // Ausnahme: der Pre-Check VOR jeder Identifikation nutzt bewusst nur
    // explizite Barcodes (multi-product Bilder, siehe Kommentar in der Route).
    const calls = routeSrc.match(/findProductByStrictIdentifier\(\{/g) || [];
    const physicalCalls = routeSrc.match(/findProductByStrictIdentifier\(\{\s*\n?\s*barcodes:\s*physicalReuseBarcodes/g) || [];
    const preCheckCalls = routeSrc.match(/findProductByStrictIdentifier\(\{\s*\n?\s*barcodes:\s*explicitBarcodes/g) || [];
    expect(physicalCalls.length).toBeGreaterThanOrEqual(3);
    expect(physicalCalls.length + preCheckCalls.length).toBe(calls.length);
  });

  it('Reuse-Lookups uebergeben keine sku mehr (LLM-SKU war Reuse-Vektor)', () => {
    // sku:-Property innerhalb eines findProductByStrictIdentifier-Aufrufs
    const skuInLookup = routeSrc.match(/findProductByStrictIdentifier\(\{[^}]*sku:\s*(?!null)[a-zA-Z]/g) || [];
    expect(skuInLookup).toEqual([]);
  });
});
