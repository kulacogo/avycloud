'use strict';

/**
 * Der Etikett-Leser darf ERGÄNZEN, nicht ERSETZEN.
 *
 * Vorfall 2026-08-10 (SKU-3154363905 / eBay 800481892205): Der Nutzer
 * diktierte Hersteller UND EU-Verantwortlichen in den Chat. Anschließend lief
 * in routes/identify.js der deterministische Etikett-Leser und machte
 *
 *     gpsrChange.gpsr = { ...extracted.gpsr, source: 'product_image' };
 *
 * Das Etikett zeigte nur den Hersteller. Der diktierte EU-Verantwortliche war
 * damit gelöscht — obwohl das Etikett zu ihm überhaupt nichts sagte.
 */

const { mergeLabelGpsrIntoCard } = require('../lib/gpsr-image-extract');

describe('mergeLabelGpsrIntoCard', () => {
  it('behält Felder, zu denen das Etikett schweigt (der eigentliche Vorfall)', () => {
    const diktiert = {
      manufacturer_name: 'Ningbo Shuaifan Information Technology Co., Ltd.',
      eu_responsible_name: 'SUCCESS COURIER S.L.',
      eu_responsible_city: 'Madrid',
    };
    const vomEtikett = { manufacturer_name: 'Ningbo Shuaifan Information Technology Co., Ltd.' };

    const merged = mergeLabelGpsrIntoCard(diktiert, vomEtikett);

    expect(merged.eu_responsible_name).toBe('SUCCESS COURIER S.L.');
    expect(merged.eu_responsible_city).toBe('Madrid');
  });

  it('lässt das Etikett gewinnen, wo es etwas sagt', () => {
    const geraten = { manufacturer_name: 'Falsch GmbH', manufacturer_city: 'Nirgendwo' };
    const vomEtikett = { manufacturer_name: 'Echt Co. Ltd.' };

    const merged = mergeLabelGpsrIntoCard(geraten, vomEtikett);

    expect(merged.manufacturer_name).toBe('Echt Co. Ltd.');
    // Wozu das Etikett schweigt, bleibt unangetastet.
    expect(merged.manufacturer_city).toBe('Nirgendwo');
  });

  it('überschreibt nicht mit leeren Etikett-Werten', () => {
    const merged = mergeLabelGpsrIntoCard(
      { eu_responsible_name: 'Rep SL' },
      { eu_responsible_name: '   ', manufacturer_name: 'ACME' }
    );
    expect(merged.eu_responsible_name).toBe('Rep SL');
    expect(merged.manufacturer_name).toBe('ACME');
  });

  it('ist robust gegen leere Eingaben', () => {
    expect(mergeLabelGpsrIntoCard(null, { manufacturer_name: 'A' })).toEqual({ manufacturer_name: 'A' });
    expect(mergeLabelGpsrIntoCard({ manufacturer_name: 'A' }, null)).toEqual({ manufacturer_name: 'A' });
    expect(mergeLabelGpsrIntoCard(null, null)).toEqual({});
  });
});
