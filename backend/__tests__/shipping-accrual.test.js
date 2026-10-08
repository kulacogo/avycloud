'use strict';

/**
 * Versand-Abgrenzung fuer verschickte, noch nicht abgerechnete Pakete.
 * Gemessen 09.10.2026: 235 Oktober-Pakete, 175 € gebucht (nur SendCloud/DPD),
 * Vormonats-Stueckpreis 8,58 € brutto (5.855,56 € / 682 Pakete).
 */

const { stueckpreisAusPeriode, ergaenzeOffenenVersand } = require('../lib/shipping-accrual');

describe('stueckpreisAusPeriode', () => {
  it('rechnet brutto je Paket aus einer abgeschlossenen Periode', () => {
    expect(stueckpreisAusPeriode({ brutto: 5855.56, parcelCount: 682 })).toBe(8.59);
  });

  it('liefert null, wenn die Periode nichts hergibt', () => {
    expect(stueckpreisAusPeriode({ brutto: 0, parcelCount: 682 })).toBeNull();
    expect(stueckpreisAusPeriode({ brutto: 500, parcelCount: 0 })).toBeNull();
    expect(stueckpreisAusPeriode({})).toBeNull();
  });
});

describe('ergaenzeOffenenVersand', () => {
  it('bewertet die offenen Pakete mit dem Vormonats-Stueckpreis und markiert es als Schaetzung', () => {
    const r = ergaenzeOffenenVersand({ gebuchtBrutto: 175.48, offeneParcels: 235, stueckpreis: 8.59 });
    expect(r.geschaetztParcels).toBe(235);
    expect(r.geschaetzt).toBe(2018.65);
    expect(r.brutto).toBe(2194.13);
    expect(r.approx).toBe(true);
    expect(r.grund).toBeNull();
  });

  it('aendert nichts, wenn alle Pakete abgerechnet sind', () => {
    const r = ergaenzeOffenenVersand({ gebuchtBrutto: 4920.64, offeneParcels: 0, stueckpreis: 8.59 });
    expect(r).toEqual({ brutto: 4920.64, geschaetzt: 0, geschaetztParcels: 0, approx: false, grund: null });
  });

  it('erfindet ohne Stueckpreis keine Zahl — Luecke bleibt sichtbar', () => {
    const r = ergaenzeOffenenVersand({ gebuchtBrutto: 175.48, offeneParcels: 235, stueckpreis: null });
    expect(r.brutto).toBe(175.48);
    expect(r.approx).toBe(false);
    expect(r.grund).toBe('kein_stueckpreis');
    expect(r.geschaetztParcels).toBe(235);
  });

  it('kommt mit gar keiner Buchung zurecht (null bleibt null, solange nichts offen ist)', () => {
    expect(ergaenzeOffenenVersand({ gebuchtBrutto: null, offeneParcels: 0, stueckpreis: 8 }).brutto).toBeNull();
    // Mit offenen Paketen wird aus null die reine Schaetzung.
    expect(ergaenzeOffenenVersand({ gebuchtBrutto: null, offeneParcels: 10, stueckpreis: 8 }).brutto).toBe(80);
  });
});
