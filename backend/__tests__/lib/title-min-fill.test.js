'use strict';

// Incident 2026-08-04: Der Chat schlug einen 31-Zeichen-Titel vor. Die
// 70-80-Regel stand im Prompt UND als minLen-Parameter an coerceTitleToPolicy —
// aber im Passthrough-Modus (forcePolicy=false) ist minLen wirkungslos, nur
// die 80er-Kappe greift. fillTitleToMinLength ist das deterministische Netz:
// es hängt fehlende Datenblatt-Tokens (MPN, Produktart, Modell, Farbe, ...)
// hinten an, bis die Mindestlänge erreicht ist. NIEMALS umbauen/kürzen/
// umsortieren (Veredler-Vorfall: Marke darf nie verloren gehen) — nur anhängen.

const { fillTitleToMinLength } = require('../../lib/title-min-fill');

function makeProduct() {
  return {
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

describe('fillTitleToMinLength', () => {
  it('füllt einen zu kurzen Titel mit Datenblatt-Tokens bis zur Mindestlänge auf', () => {
    const short = 'FJALLRAVEN Färden Duffel 80';
    const filled = fillTitleToMinLength(short, makeProduct(), { minLen: 70, maxLen: 80 });

    expect(filled.startsWith(short)).toBe(true);
    expect(filled.length).toBeGreaterThanOrEqual(60);
    expect(filled.length).toBeLessThanOrEqual(80);
  });

  it('hängt keine Tokens an, die schon im Titel stehen (diakritik-/case-tolerant)', () => {
    const filled = fillTitleToMinLength('FJALLRAVEN Färden Duffel 80', makeProduct(), { minLen: 70, maxLen: 80 });
    // "Färden Duffel 80" steht schon drin — das Modell darf nicht doppelt rein.
    const lower = filled.toLowerCase();
    expect(lower.split('duffel').length - 1).toBe(1);
  });

  it('lässt Titel >= minLen unverändert', () => {
    const long = 'FJALLRAVEN Färden Duffel 80L Reisetasche Sporttasche Coal Black Polyamid';
    expect(fillTitleToMinLength(long, makeProduct(), { minLen: 70, maxLen: 80 })).toBe(long);
  });

  it('überschreitet maxLen nie (Token das nicht mehr passt wird ausgelassen)', () => {
    const filled = fillTitleToMinLength('FJALLRAVEN Färden Duffel 80', makeProduct(), { minLen: 70, maxLen: 80 });
    expect(filled.length).toBeLessThanOrEqual(80);
  });

  it('gibt bei leerem Titel den Input unverändert zurück (kein Erfinden)', () => {
    expect(fillTitleToMinLength('', makeProduct(), { minLen: 70, maxLen: 80 })).toBe('');
    expect(fillTitleToMinLength(null, makeProduct(), { minLen: 70, maxLen: 80 })).toBe(null);
  });

  it('funktioniert ohne Attribute (nur identifiers/Name) und erfindet nichts', () => {
    const product = { identification: { name: 'Teufel Rockster Air 2' }, details: { identifiers: {} } };
    const filled = fillTitleToMinLength('Teufel Rockster', product, { minLen: 70, maxLen: 80 });
    // Nur belegte Tokens aus dem Datenblatt-Namen dürfen angehängt werden.
    expect(filled.startsWith('Teufel Rockster')).toBe(true);
    expect(filled).not.toMatch(/Unbekannt/i);
  });
});
