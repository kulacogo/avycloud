'use strict';

/**
 * Klassifizierung der von der invalid-reasons-Phase
 * (services/kaufland-listings-sync.js) geschriebenen Listing-Fehler.
 * Eigene Testdatei — __tests__/lib/listing-error-classify.test.js bleibt
 * unberührt.
 */

const { classifyListingError } = require('../../lib/listing-error-classify');

describe('classifyListingError — KAUFLAND_PRODUCT_DATA_INVALID', () => {
  const MESSAGE = 'Kaufland-Angebot inaktiv — fehlende Produktdaten: Bild, Signalwort; abgelehnt: picture (media_not_ready_yet)';

  it('klassifiziert per explizitem Code', () => {
    const r = classifyListingError({ code: 'KAUFLAND_PRODUCT_DATA_INVALID', message: MESSAGE });
    expect(r.groupKey).toBe('KAUFLAND_PRODUCT_DATA_INVALID');
    expect(r.label).toBe('Kaufland: Produktdaten unvollständig/abgelehnt');
    expect(r.code).toBe('KAUFLAND_PRODUCT_DATA_INVALID');
    expect(r.message).toBe(MESSAGE);
  });

  it('klassifiziert per Message-Pattern (Code fehlt)', () => {
    expect(classifyListingError(MESSAGE).groupKey).toBe('KAUFLAND_PRODUCT_DATA_INVALID');
    expect(classifyListingError('Kaufland-Angebot inaktiv — fehlende Produktdaten: Titel').groupKey)
      .toBe('KAUFLAND_PRODUCT_DATA_INVALID');
  });

  it('Code gewinnt vor generischen Message-Patterns (z.B. Bild → IMAGE_ISSUE)', () => {
    // Message enthält 'Bild … abgelehnt … invalid' — ohne Code-Priorität
    // würde IMAGE_ISSUE/REQUIRED_ASPECT_MISSING das Bucket stehlen.
    const r = classifyListingError({
      code: 'KAUFLAND_PRODUCT_DATA_INVALID',
      message: 'Kaufland-Angebot inaktiv — abgelehnt: Bild (invalid_url), Pflichtattribut (value_declined)',
    });
    expect(r.groupKey).toBe('KAUFLAND_PRODUCT_DATA_INVALID');
  });

  it('bestehende Klassifizierungen bleiben unberührt', () => {
    expect(classifyListingError({ code: 'KAUFLAND_EAN_INVALID', message: 'bla' }).groupKey).toBe('EAN_ISSUE');
    expect(classifyListingError('Irgendein exotischer Fehler xyz').groupKey).toBe('OTHER');
  });
});
