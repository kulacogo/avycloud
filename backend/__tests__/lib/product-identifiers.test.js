'use strict';

/**
 * Spec + Regression für kanonische Identifier (Incident 2026-07-13).
 * EAN(13/8) · UPC(12) · GTIN(14), je EIN Wert, streng validiert; barcodes abgeleitet.
 * Kernbug: EAN-Korrektur ließ sich nicht durchsetzen, weil identifiers in barcodes
 * zurückgefaltet wurden.
 */

const { computeCheckDigit } = require('../../lib/gtin');
const {
  classifyCode,
  validateFieldValue,
  deriveBarcodes,
  reconcileAuthoritative,
} = require('../../lib/product-identifiers');

// Baut einen gültigen Code gegebener Länge aus einem Body (len-1 Ziffern).
const mkValid = (body) => body + String(computeCheckDigit(body + '0'));
const EAN13 = mkValid('400638133393'.slice(0, 12)); // 12 Body-Ziffern
const EAN13B = mkValid('978020137962'); // ein zweiter gültiger EAN-13
const UPC12 = mkValid('79113768984'); // 11 Body-Ziffern
const GTIN14 = mkValid('1234567890123'); // 13 Body-Ziffern
const EAN8 = mkValid('4006381'); // 7 Body-Ziffern

describe('classifyCode', () => {
  it('ordnet nach Stellenzahl zu und prüft Prüfziffer', () => {
    expect(classifyCode(EAN13)).toMatchObject({ field: 'ean', valid: true });
    expect(classifyCode(EAN8)).toMatchObject({ field: 'ean', valid: true });
    expect(classifyCode(UPC12)).toMatchObject({ field: 'upc', valid: true });
    expect(classifyCode(GTIN14)).toMatchObject({ field: 'gtin', valid: true });
  });
  it('lehnt falsche Prüfziffer ab (Feld erkannt, valid=false)', () => {
    const bad = EAN13.slice(0, 12) + String((Number(EAN13.slice(-1)) + 1) % 10);
    expect(classifyCode(bad)).toMatchObject({ field: 'ean', valid: false, reason: 'bad_checkdigit' });
  });
  it('lehnt unsinnige Länge ab', () => {
    expect(classifyCode('12345')).toMatchObject({ field: null, valid: false, reason: 'unsupported_length' });
    expect(classifyCode('')).toMatchObject({ field: null, valid: false, reason: 'empty' });
  });
  it('normalisiert Nicht-Ziffern weg', () => {
    expect(classifyCode(` ${EAN13.slice(0, 4)}-${EAN13.slice(4)} `)).toMatchObject({ field: 'ean', valid: true, value: EAN13 });
  });
});

describe('validateFieldValue', () => {
  it('EAN akzeptiert 13 und 8, nicht 12', () => {
    expect(validateFieldValue('ean', EAN13).ok).toBe(true);
    expect(validateFieldValue('ean', EAN8).ok).toBe(true);
    expect(validateFieldValue('ean', UPC12)).toMatchObject({ ok: false, reason: 'length' });
  });
  it('UPC akzeptiert nur 12', () => {
    expect(validateFieldValue('upc', UPC12).ok).toBe(true);
    expect(validateFieldValue('upc', EAN13)).toMatchObject({ ok: false, reason: 'length' });
  });
  it('GTIN akzeptiert nur 14', () => {
    expect(validateFieldValue('gtin', GTIN14).ok).toBe(true);
    expect(validateFieldValue('gtin', EAN13)).toMatchObject({ ok: false, reason: 'length' });
  });
  it('leerer Wert = Feld leeren', () => {
    expect(validateFieldValue('ean', '')).toMatchObject({ ok: true, empty: true });
  });
  it('richtige Länge aber falsche Prüfziffer wird abgelehnt', () => {
    const badEan = EAN13.slice(0, 12) + String((Number(EAN13.slice(-1)) + 1) % 10);
    expect(validateFieldValue('ean', badEan)).toMatchObject({ ok: false, reason: 'checkdigit' });
  });
});

describe('deriveBarcodes', () => {
  it('eindeutige Liste aus ean/upc/gtin', () => {
    expect(deriveBarcodes({ ean: EAN13, upc: UPC12, gtin: '' })).toEqual([EAN13, UPC12]);
    expect(deriveBarcodes({ ean: EAN13, upc: EAN13 })).toEqual([EAN13]);
  });
});

describe('reconcileAuthoritative — Kern-Bugfix', () => {
  it('BUG A/B: reduziert barcodes auf einen EAN; alte identifiers werden NICHT zurückgefaltet', () => {
    // Aktueller Textarea-Flow: User tippt nur EAN13, identifiers tragen noch alte Werte (Ballast, unverändert).
    const r = reconcileAuthoritative({
      existingIdentifiers: { ean: EAN13B, upc: UPC12, mpn: 'FX-1' },
      incomingIdentifiers: { ean: EAN13B, upc: UPC12, mpn: 'FX-1' }, // gemergter Ballast (unverändert)
      incomingBarcodes: [EAN13], // was der User will
    });
    expect(r.identifiers.ean).toBe(EAN13);
    expect(r.identifiers.upc).toBeUndefined(); // alter UPC verschwindet
    expect(r.identifiers.mpn).toBe('FX-1'); // nicht-kanonische Felder bleiben
    expect(r.barcodes).toEqual([EAN13]);
    expect(r.cleared).toContain('upc');
  });

  it('neue 3-Feld-UI: geänderter EAN + geleerter UPC wird durchgesetzt', () => {
    const r = reconcileAuthoritative({
      existingIdentifiers: { ean: EAN13B, upc: UPC12 },
      incomingIdentifiers: { ean: EAN13, upc: '' }, // User hat EAN geändert + UPC geleert
      incomingBarcodes: [EAN13],
    });
    expect(r.identifiers.ean).toBe(EAN13);
    expect(r.identifiers.upc).toBeUndefined();
    expect(r.barcodes).toEqual([EAN13]);
  });

  it('behält gültige verschiedene Typen (EAN + UPC + GTIN)', () => {
    const r = reconcileAuthoritative({
      existingIdentifiers: {},
      incomingIdentifiers: {},
      incomingBarcodes: [EAN13, UPC12, GTIN14],
    });
    expect(r.identifiers).toMatchObject({ ean: EAN13, upc: UPC12, gtin: GTIN14 });
    expect(r.barcodes).toEqual([EAN13, UPC12, GTIN14]);
  });

  it('ungültiger Code wird geflaggt, nicht gespeichert', () => {
    const badEan = EAN13.slice(0, 12) + String((Number(EAN13.slice(-1)) + 1) % 10);
    const r = reconcileAuthoritative({
      existingIdentifiers: {},
      incomingIdentifiers: {},
      incomingBarcodes: [badEan, UPC12],
    });
    expect(r.identifiers.ean).toBeUndefined();
    expect(r.identifiers.upc).toBe(UPC12);
    expect(r.invalid).toContain(badEan);
  });

  it('explizit gültiges Feld schlägt Barcode-Ableitung (Konflikt)', () => {
    const r = reconcileAuthoritative({
      existingIdentifiers: { ean: EAN13B },
      incomingIdentifiers: { ean: EAN13 }, // User änderte EAN gezielt
      incomingBarcodes: [EAN13B], // barcodes hinken hinterher
    });
    expect(r.identifiers.ean).toBe(EAN13);
  });

  it('leere Eingabe überall = alles geleert', () => {
    const r = reconcileAuthoritative({
      existingIdentifiers: { ean: EAN13, upc: UPC12 },
      incomingIdentifiers: { ean: '', upc: '' },
      incomingBarcodes: [],
    });
    expect(r.identifiers.ean).toBeUndefined();
    expect(r.identifiers.upc).toBeUndefined();
    expect(r.barcodes).toEqual([]);
  });
});
