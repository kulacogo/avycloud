'use strict';

// Source-Invarianten für die Erfassen-Sicherheitsnetze (Incident 2026-07-17:
// "kaum Beschreibung, keine Preise"). Der Route-Handler ist schwer isoliert
// testbar; diese Tests zementieren die kritischen Eigenschaften: gated auf
// non-legacy + leer/dünn, UND gegen die Rest-Wall-Clock gecappt (Promise.race),
// damit das Netz nie selbst den Frontend-Abbruch auslöst.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'identify.js'), 'utf8');

describe('Erfassen-Sicherheitsnetze', () => {
  it('Preis-Netz: gecappt gegen remainingMs, nur bei Preis 0', () => {
    expect(src).toMatch(/identify-safety-net/);
    expect(src).toMatch(/const priceBudget = Math\.min\(15000, remainingMs\(\) - 5000\)/);
    expect(src).toMatch(/if \(currentPrice <= 0 && priceBudget > 5000\)/);
    // enrichPriceParallel läuft im ehrlichen Budget-Race (seit 2026-08-04:
    // raceEnrichmentWithTracking statt nacktem Promise.race — spät fertige
    // Ergebnisse werden via lateEnrichments nachpersistiert statt verloren).
    const block = src.slice(src.indexOf('HEBEL 1'), src.indexOf('HEBEL 2'));
    expect(block).toMatch(/raceEnrichmentWithTracking\(pricePromise, priceBudget\)/);
    expect(block).toMatch(/enrichPriceParallel\(product/);
    expect(block).toMatch(/lateEnrichments\.push\(\{ label: 'price'/);
  });

  it('Beschreibungs-Netz: triggert bei dünner Beschreibung ODER Stage-3-Fallback-Stub', () => {
    // Incident 2026-08-04 (be quiet! 242dfa4f): Der Stub bläht sich mit
    // Kategorie/Gewicht/MPN-Boilerplate über die 140-Zeichen-Schwelle auf und
    // rutschte am reinen Längen-Gate vorbei. Muster-Erkennung ist Pflicht.
    const block = src.slice(src.indexOf('HEBEL 2'), src.indexOf('3.8) Compute'));
    expect(block).toMatch(/isStubDescription\(/);
    expect(block).toMatch(/isStubHighlights\(/);
    expect(block).toMatch(/const descBudget = Math\.min\(45000, remainingMs\(\) - 5000\)/);
    expect(block).toMatch(/raceEnrichmentWithTracking\(reviewPromise, descBudget\)/);
    expect(block).toMatch(/runDatasheetReview\(\[product\]/);
    expect(block).toMatch(/lateEnrichments\.push\(\{ label: 'description'/);
  });

  it('Late-Save: spät fertige Netze werden nach dem Primär-Save nachpersistiert', () => {
    const idx = src.indexOf('Late-Save (Incident 2026-08-04)');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/Promise\.allSettled\(lateEnrichments\.map/);
    expect(block).toMatch(/saveProductV2\(product/);
    expect(block).toMatch(/allowCategoryChange: false/);
  });

  it('beide Netze nur im non-legacy-Zweig', () => {
    // Der gemeinsame Guard steht direkt vor HEBEL 1
    const guardIdx = src.lastIndexOf("if (pipelineUsed !== 'legacy') {", src.indexOf('HEBEL 1'));
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(src.indexOf('HEBEL 1'));
  });
});
