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
    // enrichPriceParallel läuft im Promise.race gegen ein Timeout
    const block = src.slice(src.indexOf('HEBEL 1'), src.indexOf('HEBEL 2'));
    expect(block).toMatch(/Promise\.race\(\[/);
    expect(block).toMatch(/enrichPriceParallel\(product/);
  });

  it('Beschreibungs-Netz: gecappt, nur bei dünner Beschreibung (<140)', () => {
    const block = src.slice(src.indexOf('HEBEL 2'), src.indexOf('3.8) Compute'));
    expect(block).toMatch(/plain\.length < 140/);
    expect(block).toMatch(/const descBudget = Math\.min\(45000, remainingMs\(\) - 5000\)/);
    expect(block).toMatch(/Promise\.race\(\[/);
    expect(block).toMatch(/runDatasheetReview\(\[product\]/);
  });

  it('beide Netze nur im non-legacy-Zweig', () => {
    // Der gemeinsame Guard steht direkt vor HEBEL 1
    const guardIdx = src.lastIndexOf("if (pipelineUsed !== 'legacy') {", src.indexOf('HEBEL 1'));
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(src.indexOf('HEBEL 1'));
  });
});
