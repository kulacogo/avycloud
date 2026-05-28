// backend/__tests__/packstation.test.js
//
// Unit tests for lib/packstation.js — the shared DHL Packstation/Postfiliale
// address parser. Regression target: SendCloud 400
// "Die Postnummer des Empfängers fehlt oder ist ungültig" for Packstation
// orders (e.g. order 13-14686-13071, "DHL Packstation 142, 19053 Schwerin").
//
// The Postnummer (6–10 digit DHL customer number) can arrive BEFORE the station
// token, AFTER it (eBay Street2 join), or in a dedicated customer field.

const { parsePackstation, resolvePostNumber } = require('../lib/packstation');

describe('parsePackstation', () => {
  it('returns isPackstation=false for a normal street address', () => {
    const r = parsePackstation('Musterstraße 12');
    expect(r.isPackstation).toBe(false);
    expect(r.postNumber).toBe('');
    expect(r.stationNumber).toBe('');
  });

  it('detects a bare Packstation without a Postnummer', () => {
    const r = parsePackstation('DHL Packstation 142');
    expect(r.isPackstation).toBe(true);
    expect(r.kind).toBe('packstation');
    expect(r.stationNumber).toBe('142');
    expect(r.postNumber).toBe('');
  });

  it('extracts a Postnummer that appears BEFORE the station', () => {
    const r = parsePackstation('1818519, Packstation 514');
    expect(r.isPackstation).toBe(true);
    expect(r.stationNumber).toBe('514');
    expect(r.postNumber).toBe('1818519');
  });

  it('extracts a Postnummer that appears AFTER the station (eBay Street2 join)', () => {
    const r = parsePackstation('Packstation 142, 12345678');
    expect(r.isPackstation).toBe(true);
    expect(r.stationNumber).toBe('142');
    expect(r.postNumber).toBe('12345678');
  });

  it('does not mistake the station number for the Postnummer', () => {
    const r = parsePackstation('Packstation 142');
    expect(r.postNumber).toBe('');
  });

  it('detects a Postfiliale', () => {
    const r = parsePackstation('Postfiliale 451, 7654321');
    expect(r.isPackstation).toBe(true);
    expect(r.kind).toBe('postfiliale');
    expect(r.stationNumber).toBe('451');
    expect(r.postNumber).toBe('7654321');
  });

  it('handles null/undefined input safely', () => {
    expect(parsePackstation(null).isPackstation).toBe(false);
    expect(parsePackstation(undefined).isPackstation).toBe(false);
  });
});

describe('resolvePostNumber', () => {
  it('prefers an explicit customer.postNumber over the parsed one', () => {
    const parsed = parsePackstation('Packstation 142, 99999999');
    expect(resolvePostNumber(parsed, { postNumber: '1234567' })).toBe('1234567');
  });

  it('strips non-digits from the explicit field', () => {
    const parsed = parsePackstation('Packstation 142');
    expect(resolvePostNumber(parsed, { postNumber: 'Post Nr. 12 34 567' })).toBe('1234567');
  });

  it('falls back to the parsed Postnummer when no explicit field is set', () => {
    const parsed = parsePackstation('1818519, Packstation 514');
    expect(resolvePostNumber(parsed, {})).toBe('1818519');
  });

  it('accepts legacy snake_case / German field names', () => {
    const parsed = parsePackstation('Packstation 142');
    expect(resolvePostNumber(parsed, { post_number: '2223334' })).toBe('2223334');
    expect(resolvePostNumber(parsed, { postnummer: '4445556' })).toBe('4445556');
  });

  it('returns empty string when nothing is available', () => {
    const parsed = parsePackstation('DHL Packstation 142');
    expect(resolvePostNumber(parsed, {})).toBe('');
  });
});
