// globals: true in vitest.config.js — describe/it/expect global
//
// Reuse-Guard: verhindert Falsch-Reuse verschiedener Produkte gleicher Marke
// (Incident 2026-07-08, PRODUKTIONS-STOP: SONAX-Telefon 08431530 als EAN-8).

const { reuseMatchConsistent, buildReusePools, normBrand, jaccard, nameTokens } = require('../lib/reuse-guard');

describe('buildReusePools — explizit vs OCR trennen, OCR nur starker GTIN', () => {
  it('nimmt nackte OCR-EAN-8 (Länge 8) NICHT als Reuse-Trigger', () => {
    const { explicit, ocr } = buildReusePools([], ['08431530']); // SONAX-Telefon
    expect(explicit).toEqual([]);
    expect(ocr).toEqual([]); // Länge 8 raus
  });

  it('lässt OCR-EAN-13/GTIN-14 (Länge >= 12) als Reuse-Trigger zu', () => {
    const { ocr } = buildReusePools([], ['4006633149839', '00012345678905']);
    expect(ocr).toContain('4006633149839');
    expect(ocr).toContain('00012345678905');
  });

  it('EXPLIZITE Barcodes bleiben bei JEDER Länge (auch EAN-8 gescannt)', () => {
    const { explicit } = buildReusePools(['08431530'], []);
    expect(explicit).toEqual(['08431530']); // getippt/gescannt = User-Autorität
  });

  it('OCR-Codes, die auch explizit sind, landen nur im explicit-Pool', () => {
    const { explicit, ocr } = buildReusePools(['4006633149839'], ['4006633149839']);
    expect(explicit).toEqual(['4006633149839']);
    expect(ocr).toEqual([]);
  });

  it('dedupliziert und trimmt, ignoriert leere Werte', () => {
    const { explicit } = buildReusePools(['123', '123', '', '  '], []);
    expect(explicit).toEqual(['123']);
  });
});

describe('SONAX-Live-Incident — Verteidigung auf Pool-Ebene (EAN-8 08431530)', () => {
  // Der eigentliche Incident: zwei verschiedene SONAX-Produkte teilten die als
  // EAN-8 fehlgelesene SONAX-Servicenummer 08431530. Diese Kollision wird NICHT
  // von reuseMatchConsistent gelöst (gleiche Marke + geteilte Produktlinie
  // "Lemon Rocks" ⇒ Namens-Jaccard ~0.43, genau wie ein echtes Duplikat),
  // sondern eine Stufe FRÜHER: der EAN-8 fliegt aus dem OCR-Reuse-Pool.
  it('OCR-EAN-8 erreicht den Reuse-Check gar nicht → kein Reuse-Versuch', () => {
    const { explicit, ocr } = buildReusePools([], ['08431530']);
    expect(explicit).toEqual([]);
    expect(ocr).toEqual([]); // ⇒ findReuseMatch findet nichts, verschiedene SONAX bleiben getrennt
  });
});

describe('reuseMatchConsistent — Marken-/Namens-Konsistenz für lange OCR-Treffer', () => {
  it('LEHNT AB: verschiedene Hersteller (00000000 auf Costway UND KS Tools)', () => {
    const costway = { identification: { brand: 'Costway', name: 'Costway Kinder Elektro-Quad TQ10122 12V' } };
    const ksTools = { identification: { brand: 'KS Tools', name: 'KS Tools Evolution Steckschlüssel-Satz' } };
    expect(reuseMatchConsistent(costway, ksTools)).toBe(false);
  });

  it('ERLAUBT: identisches Produkt zweimal erfasst (Re-Scan)', () => {
    const a = { identification: { brand: 'ATE', name: 'ATE Bremsbelagsatz Hinterachse 13.0460-7195.2' } };
    const b = { identification: { brand: 'ATE', name: 'ATE Bremsbelagsatz Hinterachse 13.0460-7195.2 12kg' } };
    expect(reuseMatchConsistent(a, b)).toBe(true);
  });

  it('LEHNT AB: gleiche Marke, aber völlig andere Produktnamen', () => {
    const a = { identification: { brand: 'Bosch', name: 'Bosch Akkuschrauber GSR 18V Professional' } };
    const b = { identification: { brand: 'Bosch', name: 'Bosch Kühlschrank KGN36 Serie 4 NoFrost' } };
    expect(reuseMatchConsistent(a, b)).toBe(false);
  });

  it('normalisiert Marken-Suffixe (GmbH) und Groß/Klein', () => {
    const a = { identification: { brand: 'SONAX GmbH', name: 'Scheibenreiniger Lemon Rocks' } };
    const b = { identification: { brand: 'sonax', name: 'Scheibenreiniger Lemon Rocks' } };
    expect(reuseMatchConsistent(a, b)).toBe(true);
  });

  it('ohne verwertbare Namen: reuse nur bei gleicher bekannter Marke', () => {
    expect(reuseMatchConsistent(
      { identification: { brand: 'SONAX', name: '' } },
      { identification: { brand: 'SONAX', name: '' } }
    )).toBe(true);
    expect(reuseMatchConsistent(
      { identification: { brand: 'SONAX', name: '' } },
      { identification: { brand: 'Nigrin', name: '' } }
    )).toBe(false);
  });
});

describe('Hilfsfunktionen', () => {
  it('normBrand entfernt Rechtsform + Sonderzeichen', () => {
    expect(normBrand('SONAX GmbH')).toBe('sonax');
    expect(normBrand('Engelbert Strauss')).toBe('engelbertstrauss');
  });
  it('jaccard misst Token-Überlappung', () => {
    expect(jaccard(nameTokens('Bremsbelagsatz Hinterachse ATE'), nameTokens('Bremsbelagsatz Hinterachse ATE'))).toBe(1);
    expect(jaccard(nameTokens('Akkuschrauber'), nameTokens('Kühlschrank'))).toBe(0);
  });
});
