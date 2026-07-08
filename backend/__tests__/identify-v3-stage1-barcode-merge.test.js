// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Stage-1 Barcode-Merge: physische Codes schlagen Grounding (Incident 2026-07-08)
//
// Stage 1 mischte OCR-/explizite Barcodes und Gemini-Grounding-EANs ohne
// Quellen-Trennung in barcodes.ranked. Eine bei Grounding-Ausfall
// halluzinierte Fremd-EAN landete so im Datenblatt (details.identifiers.ean)
// und vergiftete Bestandsdaten + Duplikat-Checks. Seither gilt:
// Grounding-Codes sind NUR Fallback, wenn weder OCR noch explizite Eingabe
// einen gueltigen GTIN geliefert haben.

const { mergeBarcodeCandidates } = require('../lib/barcode-merge');

describe('mergeBarcodeCandidates — physisch schlaegt Grounding', () => {
  const REAL_EAN = '4006633319577';       // auf dem Foto gelesen (OCR)
  const REAL_GTIN14 = '14006633314036';   // Karton-GTIN auf dem Label
  const HALLUCINATED_EAN = '4006633149839'; // Grounding-"Wissen", nicht auf dem Bild

  it('verwirft Grounding-EAN, wenn OCR einen gueltigen Barcode gelesen hat', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [REAL_EAN],
      groundingResult: { ean: HALLUCINATED_EAN },
    });
    expect(out.ean).toBe(REAL_EAN);
    expect(out.ranked.map((r) => r.code)).not.toContain(HALLUCINATED_EAN);
  });

  it('verwirft Grounding-Codes auch, wenn OCR nur einen GTIN-14 gelesen hat', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [REAL_GTIN14],
      groundingResult: { ean: HALLUCINATED_EAN, gtin: '' },
    });
    expect(out.gtin).toBe(REAL_GTIN14);
    expect(out.ean).toBe('');
    expect(out.ranked.map((r) => r.code)).not.toContain(HALLUCINATED_EAN);
  });

  it('akzeptiert Grounding-EAN als Fallback, wenn kein physischer Code existiert', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [],
      groundingResult: { ean: REAL_EAN },
    });
    expect(out.ean).toBe(REAL_EAN);
    expect(out.ranked.find((r) => r.code === REAL_EAN)?.source).toBe('grounding');
  });

  it('akzeptiert Grounding-Fallback auch bei nur UNGUELTIGEN physischen Codes', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: ['12345', 'abc'],
      groundingResult: { ean: REAL_EAN },
    });
    expect(out.ean).toBe(REAL_EAN);
  });

  it('markiert physische Codes mit source=physical', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [REAL_EAN, REAL_GTIN14],
      groundingResult: {},
    });
    expect(out.ranked.every((r) => r.source === 'physical')).toBe(true);
    expect(out.ranked.every((r) => r.valid === true)).toBe(true);
  });

  it('dedupliziert und normalisiert Grounding-Codes (digits-only)', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [],
      groundingResult: { ean: '4006633-319577', gtin: '4006633319577' },
    });
    expect(out.ranked.filter((r) => r.code === REAL_EAN)).toHaveLength(1);
  });
});

describe('mergeBarcodeCandidates — FIX C: OCR-EAN-8 nicht als Identity (Incident 2026-07-08)', () => {
  const PHONE_EAN8 = '08431530';   // SONAX-Servicenummer, checksum-gültige EAN-8
  const DATE_EAN8 = '20240530';    // Datum 2024-05-30, checksum-gültige EAN-8
  const REAL_EAN13 = '4006633319577';

  it('verwirft OCR-EAN-8 (nicht explizit) komplett aus ranked', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [PHONE_EAN8], // aus OCR, nicht explizit übergeben
      groundingResult: {},
      explicitBarcodes: [],
    });
    expect(out.ranked.map((r) => r.code)).not.toContain(PHONE_EAN8);
    expect(out.ean).toBe('');
    expect(out.ranked).toHaveLength(0);
  });

  it('behält EXPLIZIT gescannte/getippte EAN-8 (User-Autorität)', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [PHONE_EAN8],
      groundingResult: {},
      explicitBarcodes: [PHONE_EAN8],
    });
    expect(out.ranked.map((r) => r.code)).toContain(PHONE_EAN8);
  });

  it('lässt echten EAN-13 unangetastet, filtert nur die Garbage-EAN-8 daneben', () => {
    const out = mergeBarcodeCandidates({
      physicalBarcodes: [REAL_EAN13, DATE_EAN8],
      groundingResult: {},
      explicitBarcodes: [],
    });
    expect(out.ean).toBe(REAL_EAN13);
    expect(out.ranked.map((r) => r.code)).toContain(REAL_EAN13);
    expect(out.ranked.map((r) => r.code)).not.toContain(DATE_EAN8);
  });

  it('rückwärtskompatibel: ohne explicitBarcodes-Arg werden OCR-EAN-8 verworfen', () => {
    const out = mergeBarcodeCandidates({ physicalBarcodes: [PHONE_EAN8], groundingResult: {} });
    expect(out.ranked).toHaveLength(0);
  });
});
