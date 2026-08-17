'use strict';

/**
 * Die Retouren-Zahl im Finanzbericht muss zur Retouren-Seite passen — oder die
 * Luecke ERKLAEREN.
 *
 * Vorfall 2026-08-17, vom Betreiber gemeldet: Auf der Retouren-Seite standen im
 * August **11 Vorgaenge ueber 864,01 €**, im Finanz-Dashboard **425,77 €**.
 * Die Differenz von 438,24 € sind vier Retouren an STORNIERTEN Auftraegen.
 *
 * Rechnerisch ist der Abzug richtig: der Umsatz stornierter Auftraege ist gar
 * nicht gebucht, ein Abzug waere doppelt. Als Anzeige war es unbrauchbar — eine
 * Zahl, die man nirgendwo sonst wiederfindet, ist wertlos, egal wie sauber sie
 * hergeleitet ist.
 *
 * Deshalb reicht der Bericht die Luecke jetzt mit durch: abgezogener Betrag,
 * Storno-Anteil (Betrag UND Anzahl) und die Gesamtsumme, die der Bediener auf
 * seiner Retouren-Seite sieht.
 */

const { buildPnl: computePnl } = require('../lib/financial-pnl');

const BASIS = {
  umsatzBrutto: 20079.35,
  cogs: 2244.7,
  shippingBrutto: 2326.92,
  feeRateEbay: 0.13,
  feeRateKaufland: 0.13,
};

describe('Die Retouren-Luecke ist sichtbar', () => {
  it('weist den Storno-Anteil getrennt aus — der gemeldete Fall', () => {
    const p = computePnl({
      ...BASIS,
      returnsValue: 425.77,
      returnsCancelledValue: 438.24,
      returnsCancelledCount: 4,
    });

    expect(p.retouren).toBe(425.77);           // wird abgezogen
    expect(p.retourenStorno).toBe(438.24);     // wird NICHT abgezogen
    expect(p.retourenStornoAnzahl).toBe(4);
    expect(p.retourenGesamt).toBe(864.01);     // das sieht der Bediener
  });

  it('zieht den Storno-Anteil NICHT vom Gewinn ab', () => {
    const mit = computePnl({ ...BASIS, returnsValue: 425.77, returnsCancelledValue: 438.24 });
    const ohne = computePnl({ ...BASIS, returnsValue: 425.77 });
    expect(mit.rohgewinn).toBe(ohne.rohgewinn);
  });

  it('ohne Stornos ist Gesamt gleich abgezogen — keine Zusatzzeile noetig', () => {
    const p = computePnl({ ...BASIS, returnsValue: 425.77 });
    expect(p.retourenStorno).toBe(0);
    expect(p.retourenGesamt).toBe(425.77);
  });

  it('vertraegt fehlende Angaben (aelteres Backend)', () => {
    const p = computePnl({ ...BASIS, returnsValue: 100 });
    expect(p.retourenStornoAnzahl).toBe(0);
    expect(p.retourenGesamt).toBe(100);
  });
});
