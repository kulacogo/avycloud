'use strict';

const { evaluateCaptureContent, isKnownValue } = require('../../lib/capture-content-readiness');

describe('capture content acceptance before first save', () => {
  it('does not count placeholders as researched product facts', () => {
    for (const value of ['', 'Unbekannt', 'unknown', 'Keine Angabe', 'N/A', 'k.A.']) {
      expect(isKnownValue(value)).toBe(false);
    }
    expect(isKnownValue('Schwarz')).toBe(true);
    expect(isKnownValue('0')).toBe(true);
  });

  it('returns actionable gaps for a draft instead of accepting its write call', () => {
    const result = evaluateCaptureContent({
      title_ebay: 'Sony Kopfhörer', description_ebay: 'Kurz.', key_features: [],
      item_specifics: [{ key: 'Farbe', value: 'Unbekannt' }],
      gpsr: { manufacturer_name: 'Sony' },
    }, { identity: { brand: 'Sony' }, enrichment: {
      category: { ebayBreadcrumb: 'Audio > Kopfhörer' },
      requiredAspects: [{ name: 'Farbe', values: ['Schwarz', 'Weiß'] }],
    }, imageParts: [{ data: 'image' }] });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'description_too_short', 'highlights_too_few', 'attributes_too_few',
      'missing_required_aspect:Farbe', 'gpsr_manufacturer_address_missing',
      'gpsr_manufacturer_contact_missing',
    ]));
    expect(result.issues).not.toContain('price_missing');
  });

  it('requires the EU responsible person separately for a non-EU manufacturer', () => {
    const { issues } = evaluateCaptureContent({ gpsr: {
      manufacturer_name: 'Example Ltd.', manufacturer_address: '1 Test Road',
      manufacturer_city: 'Tokyo', manufacturer_postalcode: '100-0001', entity_country: 'Japan',
      email: 'contact@example.jp',
    } });
    expect(issues).toContain('gpsr_eu_responsible_missing');
  });
});

it('explains the exact title tokens needed for a targeted correction', () => {
  const result = evaluateCaptureContent({ title_ebay: 'Blumtal Bettwäsche blau', item_specifics: [
    { key: 'Produktart', value: 'Bettwäschegarnitur' }, { key: 'Material', value: 'Baumwolle' }, { key: 'Größe', value: '135x200 cm' },
  ] }, { identity: { brand: 'Blumtal' }, enrichment: { category: { ebayBreadcrumb: 'Möbel & Wohnen > Bettwäsche' } } });
  expect(result.titleRequirements).toContain('Bettwäschegarnitur');
  expect(result.titleRequirements).toContain('Baumwolle');
});
