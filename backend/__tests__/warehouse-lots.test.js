/**
 * Los-Code-Lib — reine Funktionstests (kein Firestore).
 *
 * Format seit 2026-10-08 (Betreiber: „L-0726XX konsolidieren zu L-0726"):
 *   L-MMYY     — Auktions-Los, EINS je Monat.
 *   NL-MMYY    — Non-Los, eins pro Monat.
 * Das Altformat L-MMYYNN (2026-07-31 bis 2026-10-08) wird nur noch gelesen.
 */
const {
  buildLotCode,
  parseLotCode,
  isValidLotCode,
  parseLotNumberSelection,
} = require('../lib/warehouse-lots');

describe('buildLotCode', () => {
  it('baut ein Los je Art und Monat — Betreiber-Beispiele exakt', () => {
    expect(buildLotCode({ type: 'L', month: 7, year: 2026 })).toBe('L-0726');
    expect(buildLotCode({ type: 'L', month: 9, year: 2026 })).toBe('L-0926');
    expect(buildLotCode({ type: 'NL', month: 6, year: 2026 })).toBe('NL-0626');
    expect(buildLotCode({ type: 'NL', month: 8, year: 2026 })).toBe('NL-0826');
  });

  it('akzeptiert zweistelliges Jahr', () => {
    expect(buildLotCode({ type: 'NL', month: 12, year: 26 })).toBe('NL-1226');
    expect(buildLotCode({ type: 'L', month: 1, year: 27 })).toBe('L-0127');
  });

  it('nimmt KEINE Nummer mehr an — das Altformat darf nicht neu entstehen', () => {
    expect(() => buildLotCode({ type: 'L', month: 7, year: 2026, number: 12 })).toThrow(/keine Nummer/);
    expect(() => buildLotCode({ type: 'NL', month: 7, year: 2026, number: 1 })).toThrow(/keine Nummer/);
  });

  it('wirft bei ungültigem Monat oder Typ', () => {
    expect(() => buildLotCode({ type: 'L', month: 0, year: 2026 })).toThrow();
    expect(() => buildLotCode({ type: 'L', month: 13, year: 2026 })).toThrow();
    expect(() => buildLotCode({ type: 'X', month: 7, year: 2026 })).toThrow();
  });
});

describe('parseLotCode', () => {
  it('parst das Monatsformat beider Arten', () => {
    expect(parseLotCode('L-0726')).toEqual({ code: 'L-0726', type: 'L', month: 7, year: 2026, number: null });
    expect(parseLotCode('NL-0626')).toEqual({ code: 'NL-0626', type: 'NL', month: 6, year: 2026, number: null });
  });

  it('liest das Altformat L-MMYYNN weiter — als legacy gekennzeichnet', () => {
    // Gedruckte Labels und warehouseEvents-Meta tragen diese Codes; sie
    // duerfen nicht ploetzlich als Fremdformat gelten.
    expect(parseLotCode('L-072612')).toEqual({
      code: 'L-072612', type: 'L', month: 7, year: 2026, number: 12, legacy: true,
    });
    expect(parseLotCode('L-0726100')).toEqual({
      code: 'L-0726100', type: 'L', month: 7, year: 2026, number: 100, legacy: true,
    });
    // Das neue Format traegt KEIN legacy-Flag.
    expect(parseLotCode('L-0726').legacy).toBeUndefined();
  });

  it('normalisiert Kleinschreibung und Whitespace (Scanner-Robustheit)', () => {
    expect(parseLotCode('  l-0726 ')).toEqual({ code: 'L-0726', type: 'L', month: 7, year: 2026, number: null });
  });

  it('lehnt Fremdformate ab (PEG-Bins, BIN-Codes, kaputte Nummern)', () => {
    expect(parseLotCode('PEG001')).toBeNull();
    expect(parseLotCode('XGA0101A')).toBeNull();
    expect(parseLotCode('L-072600')).toBeNull();   // Alt-Nummer 00
    expect(parseLotCode('L-0726201')).toBeNull();  // Alt-Nummer > 200
    expect(parseLotCode('L-072601 0')).toBeNull(); // Muell hinter Nummer
    expect(parseLotCode('L-0026')).toBeNull();     // Monat 00
    expect(parseLotCode('L-1326')).toBeNull();     // Monat 13
    expect(parseLotCode('NL-072612')).toBeNull();  // NL mit Nummer
    expect(parseLotCode('L-072')).toBeNull();      // zu kurz
    expect(parseLotCode('')).toBeNull();
    expect(parseLotCode(null)).toBeNull();
  });

  it('Roundtrip build → parse für alle Monate', () => {
    for (let month = 1; month <= 12; month += 1) {
      for (const type of ['L', 'NL']) {
        const code = buildLotCode({ type, month, year: 2026 });
        expect(parseLotCode(code)).toEqual({ code, type, month, year: 2026, number: null });
      }
    }
  });
});

describe('isValidLotCode', () => {
  it('true für gültige, false für ungültige Codes', () => {
    expect(isValidLotCode('L-0726')).toBe(true);
    expect(isValidLotCode('L-072612')).toBe(true); // Altformat bleibt lesbar
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
