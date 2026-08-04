'use strict';

// Incident 2026-08-04: 31-Zeichen-Titel aus dem Chat. Die Sanitizer riefen
// coerceTitleToPolicy im Passthrough (Legacy: minLen wirkungslos; V2: sogar
// minLen 0) — es gab KEIN Mindestlängen-Enforcement. Neu: nach dem Coerce
// füllt fillTitleToMinLength (lib/title-min-fill.js) zu kurze Titel mit
// belegten Datenblatt-Tokens auf. Kill-Switch: CHAT_TITLE_MIN_FILL=off.

const { _testables } = require('../services/product-chat');

const { sanitizeDatasheetChange } = _testables;

function makeProduct() {
  return {
    id: 'p1',
    identification: {
      name: 'Fjällräven Färden Duffel 80L Reisetasche Sporttasche Coal Black',
      brand: 'FJALLRAVEN',
    },
    details: {
      attributes: {
        Produktart: 'Reisetasche',
        Modell: 'Färden Duffel 80',
        Farbe: 'Coal Black',
        Material: 'Polyamid',
        Volumen: '80 L',
      },
      identifiers: { mpn: 'F23200283' },
    },
  };
}

describe('sanitizeDatasheetChange (Legacy) — Titel-Mindestlänge', () => {
  it('füllt einen zu kurzen Titel-Vorschlag mit Datenblatt-Tokens auf', () => {
    const { change } = sanitizeDatasheetChange(
      { title: 'FJALLRAVEN Duffel Tasche' },
      makeProduct()
    );

    expect(change.title.startsWith('FJALLRAVEN Duffel Tasche')).toBe(true);
    expect(change.title.length).toBeGreaterThanOrEqual(60);
    expect(change.title.length).toBeLessThanOrEqual(80);
    // identity.name muss denselben aufgefüllten Titel tragen.
    expect(change.identity.name).toBe(change.title);
  });

  it('lässt ausreichend lange Titel unangetastet', () => {
    const long = 'FJALLRAVEN Färden Duffel 80L Reisetasche Sporttasche Coal Black Polyamid';
    const { change } = sanitizeDatasheetChange({ title: long }, makeProduct());
    expect(change.title).toBe(long);
  });

  it('Kill-Switch CHAT_TITLE_MIN_FILL=off stellt das alte Verhalten wieder her', () => {
    process.env.CHAT_TITLE_MIN_FILL = 'off';
    try {
      const { change } = sanitizeDatasheetChange(
        { title: 'FJALLRAVEN Duffel Tasche' },
        makeProduct()
      );
      expect(change.title).toBe('FJALLRAVEN Duffel Tasche');
    } finally {
      delete process.env.CHAT_TITLE_MIN_FILL;
    }
  });
});
