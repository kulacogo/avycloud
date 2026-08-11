'use strict';
// Regression: Auftrag 07-14991-66886 (2026-08-04). eBay lieferte für einen
// belgischen Käufer CityName="2000" und PostalCode="Antwerpen" — die Felder
// waren SEITENS EBAY vertauscht (Käufer hat sie falsch eingetippt, eBay
// validiert internationale Adressfelder nicht). Unser Intake mappte korrekt,
// SendCloud lehnte den Label-Call zurecht ab:
//   400 validation_error "Enter a valid zip code." pointer=postal_code
// Der Operator sah nur die rohe SendCloud-Meldung und probierte es 8× in 6 min.
//
// Diese Lib erkennt das Muster BEWEISBAR (nicht heuristisch): nur wenn die
// aktuelle PLZ für das Land nachweislich ungültig ist UND der Stadt-Wert eine
// gültige PLZ für dasselbe Land ist.

const {
  isValidPostalCode,
  detectSwappedZipCity,
} = require('../lib/postal-code-validate');

describe('isValidPostalCode', () => {
  it('akzeptiert gültige PLZ der Zielländer', () => {
    expect(isValidPostalCode('44532', 'DE')).toBe(true);
    expect(isValidPostalCode('2000', 'BE')).toBe(true);
    expect(isValidPostalCode('9645CW', 'NL')).toBe(true);
    expect(isValidPostalCode('9645 CW', 'NL')).toBe(true);
    expect(isValidPostalCode('75001', 'FR')).toBe(true);
  });

  it('lehnt einen Ortsnamen als PLZ ab', () => {
    expect(isValidPostalCode('Antwerpen', 'BE')).toBe(false);
    expect(isValidPostalCode('Berlin', 'DE')).toBe(false);
  });

  it('lehnt eine PLZ im falschen Landesformat ab', () => {
    // 4-stellig ist in DE ungültig (dort 5-stellig)
    expect(isValidPostalCode('2000', 'DE')).toBe(false);
  });

  it('urteilt NICHT über Länder ohne hinterlegtes Format (fail-open)', () => {
    // IE (Eircode) und GB sind bewusst nicht gemustert — lieber kein Urteil
    // als ein falsches Urteil, das eine gültige Adresse blockiert.
    expect(isValidPostalCode('D02 AF30', 'IE')).toBe(null);
    expect(isValidPostalCode('SW1A 1AA', 'GB')).toBe(null);
    expect(isValidPostalCode('12345', 'XX')).toBe(null);
    expect(isValidPostalCode('12345', '')).toBe(null);
  });
});

describe('detectSwappedZipCity', () => {
  it('erkennt den echten Vorfall (BE: zip="Antwerpen", city="2000")', () => {
    const res = detectSwappedZipCity('Antwerpen', '2000', 'BE');
    expect(res.swapped).toBe(true);
    expect(res.zip).toBe('2000');
    expect(res.city).toBe('Antwerpen');
  });

  it('lässt eine gültige NL-Adresse unangetastet', () => {
    // 9645CW/Veendam ist KORREKT — darf nie "korrigiert" werden.
    const res = detectSwappedZipCity('9645CW', 'Veendam', 'NL');
    expect(res.swapped).toBe(false);
    expect(res.zip).toBe('9645CW');
    expect(res.city).toBe('Veendam');
  });

  it('tauscht nicht, wenn die Stadt keine gültige PLZ ist', () => {
    // PLZ kaputt, aber Stadt ist kein PLZ-Kandidat → wir wissen es nicht
    // besser und raten NICHT.
    expect(detectSwappedZipCity('ABC', 'Antwerpen', 'BE').swapped).toBe(false);
  });

  it('tauscht nicht bei unbekanntem Land', () => {
    expect(detectSwappedZipCity('Dublin', 'D02AF30', 'IE').swapped).toBe(false);
  });

  it('tauscht nicht, wenn die PLZ bereits gültig ist', () => {
    // Beide Werte sähen wie PLZ aus — solange die PLZ gültig ist, wird nie
    // getauscht (sonst würde eine korrekte Adresse zerstört).
    expect(detectSwappedZipCity('2000', '1000', 'BE').swapped).toBe(false);
  });

  it('kommt mit leeren/fehlenden Werten klar', () => {
    expect(detectSwappedZipCity('', '', 'BE').swapped).toBe(false);
    expect(detectSwappedZipCity(null, undefined, 'BE').swapped).toBe(false);
  });
});
