'use strict';

/**
 * Der echte Kaufland-Gebuehrensatz.
 *
 * Der Finanzbericht rechnete mit hinterlegten 13 %. Gemessen am
 * Buchungsbericht (August 2026, 48 abgerechnete Positionen):
 * 374,92 € Gebuehren auf 2.423,94 € Umsatz = **15,47 %**.
 *
 * Der Bericht liefert `fee_gross` und `price_gross` je Position — als EURO MIT
 * KOMMA ("-10,00"), waehrend die uebrige Kaufland-API Cent als Ganzzahl nutzt.
 * Genau die Art Falle, die stille Faktor-100-Fehler erzeugt.
 */

const { measureKauflandFeeRate, MIN_POSITIONEN } = require('../lib/kaufland-fee-rate');

const zeile = (fee, preis) => ({ raw: { fee_gross: fee, price_gross: preis } });

/** 12 Zeilen mit exakt 15 % — ueber der Mindestmenge. */
function zeilen(n, fee, preis) {
  return Array.from({ length: n }, () => zeile(fee, preis));
}

describe('Gebuehrensatz messen', () => {
  it('rechnet den Satz aus den Buchungszeilen', () => {
    const r = measureKauflandFeeRate(zeilen(12, '15,00', '100,00'));
    expect(r.rate).toBe(0.15);
    expect(r.positions).toBe(12);
    expect(r.feeSum).toBe(180);
    expect(r.revenueSum).toBe(1200);
  });

  it('liest Euro MIT KOMMA — der Bericht nutzt nicht Cent', () => {
    const r = measureKauflandFeeRate(zeilen(12, '5,88', '37,99'));
    expect(r.feeSum).toBe(70.56);
    expect(r.rate).toBeCloseTo(0.1548, 3);
  });

  it('trifft den gemessenen August-Wert', () => {
    // 48 Positionen, 374,92 € auf 2.423,94 € = 15,47 %
    const je = 374.92 / 48;
    const preis = 2423.94 / 48;
    const r = measureKauflandFeeRate(zeilen(48, je.toFixed(2).replace('.', ','), preis.toFixed(2).replace('.', ',')));
    expect(r.rate).toBeCloseTo(0.1547, 3);
  });
});

describe('Wann der gemessene Satz NICHT genutzt wird', () => {
  it('zu wenige Positionen', () => {
    expect(measureKauflandFeeRate(zeilen(MIN_POSITIONEN - 1, '15,00', '100,00'))).toBe(null);
  });

  it('unplausibel niedriger Satz', () => {
    // Deutet auf falsch gelesene Spalten hin — dann lieber der hinterlegte Wert.
    expect(measureKauflandFeeRate(zeilen(20, '1,00', '100,00'))).toBe(null);
  });

  it('unplausibel hoher Satz', () => {
    expect(measureKauflandFeeRate(zeilen(20, '50,00', '100,00'))).toBe(null);
  });

  it('Zeilen ohne Gebuehr zaehlen nicht mit', () => {
    // "Freigabe Verkaufserloes"-Zeilen tragen keine fee_gross.
    const gemischt = zeilen(12, '15,00', '100,00').concat(
      Array.from({ length: 40 }, () => ({ raw: { booking_text: 'Freigabe Verkaufserlös' } })),
    );
    const r = measureKauflandFeeRate(gemischt);
    expect(r.positions).toBe(12);
  });

  it('vertraegt leere Eingaben', () => {
    expect(measureKauflandFeeRate(null)).toBe(null);
    expect(measureKauflandFeeRate([])).toBe(null);
    expect(measureKauflandFeeRate([{}, { raw: {} }])).toBe(null);
  });
});
