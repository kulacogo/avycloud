'use strict';

const { enforceDescriptionProse } = require('../../lib/listing-sanitize');

describe('enforceDescriptionProse (universal save-boundary prose guard)', () => {
  it('flattens a bulleted short_description into prose (no <ul>/<li>)', () => {
    const product = {
      details: {
        short_description:
          '<p>Erlebe Gaming auf einem neuen Level.</p>' +
          '<ul><li>QD-OLED-Technologie mit brillanten Farben und tiefem Schwarz.</li>' +
          '<li>144 Hz Refresh-Rate fuer verzoegerungsfreie Action im Spiel.</li></ul>' +
          '<p>Der Monitor setzt neue Massstaebe in Sachen Immersion.</p>',
      },
    };
    const out = enforceDescriptionProse(product);
    expect(out.details.short_description).not.toContain('<ul>');
    expect(out.details.short_description).not.toContain('<li>');
    expect(out.details.short_description).toContain('<p>');
    // content is preserved, just not as bullets
    expect(out.details.short_description).toContain('QD-OLED-Technologie');
    expect(out.details.short_description).toContain('144 Hz');
    expect(out.details.short_description).toContain('neue Massstaebe');
  });

  it('leaves an already-prose short_description untouched (idempotent, no data loss)', () => {
    const desc = '<p>Erster Absatz mit Fliesstext.</p><p>Zweiter Absatz ebenfalls Prosa.</p>';
    const product = { details: { short_description: desc } };
    const out = enforceDescriptionProse(product);
    expect(out.details.short_description).toBe(desc);
  });

  it('leaves a plain-text short_description untouched', () => {
    const desc = 'Ein einfacher Beschreibungstext ohne jegliche Listen.';
    const product = { details: { short_description: desc } };
    expect(enforceDescriptionProse(product).details.short_description).toBe(desc);
  });

  it('does NOT touch key_features (Highlights stay bullets)', () => {
    const product = {
      details: {
        short_description: '<p>Prosa.</p>',
        key_features: ['Immersives Gaming - 49 Zoll', 'Maximale Speed - 144 Hz'],
      },
    };
    const out = enforceDescriptionProse(product);
    expect(out.details.key_features).toEqual(['Immersives Gaming - 49 Zoll', 'Maximale Speed - 144 Hz']);
  });

  it('handles products without details safely', () => {
    expect(() => enforceDescriptionProse({})).not.toThrow();
    expect(() => enforceDescriptionProse(null)).not.toThrow();
    expect(enforceDescriptionProse({ details: {} }).details.short_description).toBeUndefined();
  });

  it('does not mutate the input object', () => {
    const product = { details: { short_description: '<p>x</p><ul><li>list item here for sure</li></ul>' } };
    const before = product.details.short_description;
    enforceDescriptionProse(product);
    expect(product.details.short_description).toBe(before);
  });
});
