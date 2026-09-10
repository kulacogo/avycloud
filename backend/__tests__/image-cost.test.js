/**
 * Tests für lib/image-cost.js — Kostenrechnung und Deckel je Lauf.
 *
 * Betreiber 2026-09-10: „bilder generierung ist teurer als text. wir müssen
 * effizient und sparsam sein sonst gehen die kosten durch die decke."
 *
 * In CLAUDE.md stand seit dem 02.09. als offener Punkt, dass es weder Zähler
 * noch Deckel gibt. Diese Datei hält beides fest.
 */

const { preisJeBild, neuerZaehler, schaetze, deckelJeLauf, PREISE } = require('../lib/image-cost');

beforeEach(() => {
  delete process.env.IMAGE_COST_CAP_USD;
});

describe('preisJeBild', () => {
  it('kennt die Preise der Google-Preisliste', () => {
    expect(preisJeBild('gemini-3-pro-image', '2K')).toBe(0.134);
    expect(preisJeBild('gemini-3.1-flash-image', '2K')).toBe(0.101);
    expect(preisJeBild('gemini-3.1-flash-image', '1K')).toBe(0.067);
    expect(preisJeBild('gemini-3.1-flash-lite-image', '1K')).toBe(0.034);
  });

  it('nimmt bei UNBEKANNTEM Modell den teuersten bekannten Preis', () => {
    // Fail-expensive: im Zweifel lieber zu früh bremsen als eine Rechnung,
    // die niemand erwartet hat.
    expect(preisJeBild('gemini-9-super-image', '2K')).toBe(0.24);
    expect(preisJeBild(null, null)).toBe(0.24);
  });

  it('faellt bei unbekannter Groesse auf den Standardpreis des Modells', () => {
    expect(preisJeBild('gemini-3.1-flash-image', 'XXL')).toBe(0.101);
  });

  it('nutzt keine Prototypkette', () => {
    // Sonst lieferte PREISE['toString'] eine Funktion statt undefined.
    expect(preisJeBild('toString', '1K')).toBe(0.24);
    expect(Object.getPrototypeOf(PREISE)).toBeNull();
  });
});

describe('Deckel', () => {
  it('traegt die volle Serie auf dem guenstigen Modell', () => {
    // 4 x 0,101 (Studio 2K) + 2 x 0,067 (Szene 1K) = 0,538 $
    const serie = 4 * preisJeBild('gemini-3.1-flash-image', '2K')
      + 2 * preisJeBild('gemini-3.1-flash-image', '1K');
    expect(serie).toBeLessThan(deckelJeLauf());
  });

  it('bremst dieselbe Serie auf dem TEUREN Modell aus', () => {
    // Deckel 0,90 $ (hergeleitet: 4 abgeleitete Studio-Ansichten je Render 2K
    // 0,101 + Leinwand-Maske 0,034, plus 2 Szenen zu 0,067 = 0,674, dazu Luft
    // fuer einen Rueckfall). Auf dem teuren Modell reisst schon eine Serie aus
    // sieben Aufrufen darueber.
    expect(7 * preisJeBild('gemini-3-pro-image', '2K')).toBeGreaterThan(deckelJeLauf());
    // Die reale Vollserie passt dagegen hinein.
    const vollserie = 4 * (preisJeBild('gemini-3.1-flash-image', '2K') + preisJeBild('gemini-3.1-flash-lite-image', '1K'))
      + 2 * preisJeBild('gemini-3.1-flash-image', '1K');
    expect(vollserie).toBeLessThan(deckelJeLauf());
  });

  it('laesst sich per ENV setzen', () => {
    process.env.IMAGE_COST_CAP_USD = '0.20';
    expect(deckelJeLauf()).toBe(0.2);
  });

  it('faellt bei Muell auf den Default zurueck', () => {
    process.env.IMAGE_COST_CAP_USD = 'billig';
    expect(deckelJeLauf()).toBe(0.9);
  });
});

describe('Zaehler', () => {
  it('bremst BEVOR das Budget ueberschritten wird', () => {
    const z = neuerZaehler({ deckel: 0.25 });
    expect(z.darfNoch('gemini-3.1-flash-image', '2K')).toBe(true);
    z.buche('gemini-3.1-flash-image', '2K');
    z.buche('gemini-3.1-flash-image', '2K');
    // 0,202 gebucht — ein drittes Bild (0,101) wuerde 0,303 ergeben.
    expect(z.darfNoch('gemini-3.1-flash-image', '2K')).toBe(false);
  });

  it('bucht auch ein spaeter VERWORFENES Bild — bezahlt ist bezahlt', () => {
    const z = neuerZaehler({ deckel: 1 });
    z.buche('gemini-3.1-flash-image', '2K', 'studio_front');
    expect(z.anzahl).toBe(1);
    expect(z.usd).toBe(0.101);
  });

  it('meldet den Deckel als erreicht', () => {
    const z = neuerZaehler({ deckel: 0.1 });
    expect(z.erschoepft).toBe(false);
    z.buche('gemini-3.1-flash-image', '2K');
    expect(z.erschoepft).toBe(true);
  });

  it('deckel 0 bedeutet KEIN Deckel', () => {
    const z = neuerZaehler({ deckel: 0 });
    for (let i = 0; i < 50; i += 1) z.buche('gemini-3-pro-image', '4K');
    expect(z.darfNoch('gemini-3-pro-image', '4K')).toBe(true);
    expect(z.erschoepft).toBe(false);
  });

  it('liefert einen nachvollziehbaren Bericht mit Einzelposten', () => {
    const z = neuerZaehler({ deckel: 1 });
    z.buche('gemini-3.1-flash-image', '2K', 'studio_front');
    z.buche('gemini-3.1-flash-image', '1K', 'lifestyle_inuse');
    const b = z.bericht();
    expect(b.bildaufrufe).toBe(2);
    expect(b.kostenUsd).toBe(0.168);
    expect(b.posten.map((p) => p.zweck)).toEqual(['studio_front', 'lifestyle_inuse']);
  });
});

describe('schaetze', () => {
  it('rechnet den Plan vorab hoch', () => {
    expect(schaetze([1, 2, 3, 4, 5, 6], 'gemini-3.1-flash-image', '2K')).toBe(0.606);
  });

  it('ist mit leerem Plan null', () => {
    expect(schaetze([], 'gemini-3-pro-image', '2K')).toBe(0);
    expect(schaetze(null, 'gemini-3-pro-image', '2K')).toBe(0);
  });
});
