/**
 * Los-Code-Lib — reine Funktionstests (kein Firestore).
 *
 * Format (Owner-Vorgabe 2026-07-31):
 *   L-MMYYNN   — Auktions-Los. NN = 01-99 zweistellig, 100-200 dreistellig.
 *   NL-MMYY    — Non-Los, eins pro Monat, ohne Nummer.
 * Beispiele des Owners: L-072612, L-072620, L-072638, NL-0726, NL-0826.
 */
const {
  buildLotCode,
  parseLotCode,
  isValidLotCode,
  parseLotNumberSelection,
} = require('../lib/warehouse-lots');

describe('buildLotCode', () => {
  it('baut die Owner-Beispiele exakt', () => {
    expect(buildLotCode({ type: 'L', month: 7, year: 2026, number: 12 })).toBe('L-072612');
    expect(buildLotCode({ type: 'L', month: 7, year: 2026, number: 20 })).toBe('L-072620');
    expect(buildLotCode({ type: 'L', month: 7, year: 2026, number: 38 })).toBe('L-072638');
    expect(buildLotCode({ type: 'NL', month: 6, year: 2026 })).toBe('NL-0626');
    expect(buildLotCode({ type: 'NL', month: 8, year: 2026 })).toBe('NL-0826');
  });

  it('padded Nummern 1-9 zweistellig, 100-200 dreistellig', () => {
    expect(buildLotCode({ type: 'L', month: 7, year: 2026, number: 1 })).toBe('L-072601');
    expect(buildLotCode({ type: 'L', month: 7, year: 2026, number: 9 })).toBe('L-072609');
    expect(buildLotCode({ type: 'L', month: 7, year: 2026, number: 100 })).toBe('L-0726100');
    expect(buildLotCode({ type: 'L', month: 7, year: 2026, number: 200 })).toBe('L-0726200');
  });

  it('akzeptiert zweistelliges Jahr', () => {
    expect(buildLotCode({ type: 'NL', month: 12, year: 26 })).toBe('NL-1226');
  });

  it('wirft bei ungültigem Monat, Nummer oder Typ', () => {
    expect(() => buildLotCode({ type: 'L', month: 0, year: 2026, number: 1 })).toThrow();
    expect(() => buildLotCode({ type: 'L', month: 13, year: 2026, number: 1 })).toThrow();
    expect(() => buildLotCode({ type: 'L', month: 7, year: 2026, number: 0 })).toThrow();
    expect(() => buildLotCode({ type: 'L', month: 7, year: 2026, number: 201 })).toThrow();
    expect(() => buildLotCode({ type: 'L', month: 7, year: 2026 })).toThrow();
    expect(() => buildLotCode({ type: 'X', month: 7, year: 2026, number: 1 })).toThrow();
  });
});

describe('parseLotCode', () => {
  it('parst L-Codes inkl. dreistelliger Nummern', () => {
    expect(parseLotCode('L-072612')).toEqual({
      code: 'L-072612', type: 'L', month: 7, year: 2026, number: 12,
    });
    expect(parseLotCode('L-0726100')).toEqual({
      code: 'L-0726100', type: 'L', month: 7, year: 2026, number: 100,
    });
  });

  it('parst NL-Codes', () => {
    expect(parseLotCode('NL-0626')).toEqual({
      code: 'NL-0626', type: 'NL', month: 6, year: 2026, number: null,
    });
  });

  it('normalisiert Kleinschreibung und Whitespace (Scanner-Robustheit)', () => {
    expect(parseLotCode('  l-072612 ')).toEqual({
      code: 'L-072612', type: 'L', month: 7, year: 2026, number: 12,
    });
  });

  it('lehnt Fremdformate ab (PEG-Bins, BIN-Codes, kaputte Nummern)', () => {
    expect(parseLotCode('PEG001')).toBeNull();
    expect(parseLotCode('XGA0101A')).toBeNull();
    expect(parseLotCode('L-072600')).toBeNull();   // Nummer 00
    expect(parseLotCode('L-0726201')).toBeNull();  // > 200
    expect(parseLotCode('L-072601 0')).toBeNull(); // Muell hinter Nummer
    expect(parseLotCode('L-002601')).toBeNull();   // Monat 00
    expect(parseLotCode('L-132601')).toBeNull();   // Monat 13
    expect(parseLotCode('NL-072612')).toBeNull();  // NL mit Nummer
    expect(parseLotCode('L-0726')).toBeNull();     // L ohne Nummer
    expect(parseLotCode('')).toBeNull();
    expect(parseLotCode(null)).toBeNull();
  });

  it('Roundtrip build → parse für alle Grenzwerte', () => {
    for (const number of [1, 9, 10, 99, 100, 199, 200]) {
      const code = buildLotCode({ type: 'L', month: 1, year: 2026, number });
      expect(parseLotCode(code)).toEqual({ code, type: 'L', month: 1, year: 2026, number });
    }
  });
});

describe('isValidLotCode', () => {
  it('true für gültige, false für ungültige Codes', () => {
    expect(isValidLotCode('L-072612')).toBe(true);
    expect(isValidLotCode('nl-0726')).toBe(true);
    expect(isValidLotCode('PEG001')).toBe(false);
    expect(isValidLotCode(undefined)).toBe(false);
  });
});

describe('parseLotNumberSelection', () => {
  it('einzelne Nummer und Bereich', () => {
    expect(parseLotNumberSelection('12')).toEqual([12]);
    expect(parseLotNumberSelection('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseLotNumberSelection(' 198 - 200 ')).toEqual([198, 199, 200]);
  });

  it('wirft bei 0, >200, verdrehtem Bereich oder Muell', () => {
    expect(() => parseLotNumberSelection('0')).toThrow();
    expect(() => parseLotNumberSelection('201')).toThrow();
    expect(() => parseLotNumberSelection('5-3')).toThrow();
    expect(() => parseLotNumberSelection('1-201')).toThrow();
    expect(() => parseLotNumberSelection('abc')).toThrow();
    expect(() => parseLotNumberSelection('')).toThrow();
  });
});
