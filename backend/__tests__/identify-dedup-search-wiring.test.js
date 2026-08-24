// globals: true in vitest.config.js
//
// Verdrahtung der Duplikat-Suche in der Erfassung.
//
// Bis 2026-08-18 entschied `findReuseMatch` allein anhand von Barcodes. Ein
// Produkt ohne lesbaren Barcode bekam damit immer ein neues Datenblatt und eine
// neue SKU. Seither haengt hinter dem Barcode-Vergleich die dreistufige Suche
// aus services/duplicate-search.js.
//
// Was hier gesichert wird, ist die REIHENFOLGE und die ROLLENVERTEILUNG — das
// Verhalten der Stufen selbst liegt in duplicate-search.test.js,
// product-match.test.js und duplicate-judge.test.js.

const fs = require('fs');
const path = require('path');

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'identify.js'), 'utf8');

describe('Erfassung — Duplikat-Suche hinter dem Barcode-Vergleich', () => {
  it('ruft die Suche in findReuseMatch auf', () => {
    expect(routeSrc).toMatch(/searchExistingProduct/);
  });

  it('prueft Barcodes zuerst und sucht erst danach', () => {
    const barcodeLookup = routeSrc.indexOf('explicitReuseBarcodes.length');
    const suche = routeSrc.indexOf('searchExistingProduct');
    expect(barcodeLookup).toBeGreaterThan(-1);
    expect(suche).toBeGreaterThan(barcodeLookup);
  });

  it('gibt der Suche die Fotos der Erfassung mit', () => {
    expect(routeSrc).toMatch(/searchExistingProduct\(\{[\s\S]{0,200}images:\s*files/);
  });

  it('uebergibt der Suche das Produkt, nicht KI-aufgeloeste Identifier', () => {
    // Die Suche baut ihre Schluessel selbst aus Marke/Herstellernummer. Wuerde
    // die Route ihr Barcodes reichen, waere das der Vektor aus Juli 2026.
    const aufruf = routeSrc.match(/searchExistingProduct\(\{[\s\S]{0,300}?\}\)/);
    expect(aufruf).toBeTruthy();
    expect(aufruf[0]).not.toMatch(/barcodes/);
  });

  it('laesst den Treffer der Suche ueber getProduct laufen', () => {
    // Der Reuse-Pfad erwartet ein vollstaendiges Produktdokument, nicht nur eine id.
    expect(routeSrc).toMatch(/searchExistingProduct[\s\S]{0,600}getProduct\(/);
  });
});

describe('Erfassung — die Suche laeuft auch ohne Barcode', () => {
  it('koppelt die Duplikat-Pruefung nicht mehr an hasReuseBarcode', () => {
    // Der Gate war die eigentliche Luecke: `if (hasReuseBarcode)` sperrte die
    // Pruefung genau fuer die Produkte aus, um die es geht — die ohne lesbaren
    // Barcode. Die Barcode-Zweige INNERHALB von findReuseMatch sind selbst
    // gegated, ohne Barcode laeuft dort also nur die neue Suche.
    expect(routeSrc).not.toMatch(/if\s*\(hasReuseBarcode\)\s*\{/);
    expect(routeSrc).not.toMatch(/hasReuseBarcode\s*\?\s*await\s+findReuseMatch/);
  });

  it('ruft findReuseMatch weiterhin an allen drei Stellen', () => {
    const aufrufe = routeSrc.match(/await\s+findReuseMatch\(/g) || [];
    expect(aufrufe.length).toBeGreaterThanOrEqual(3);
  });
});
