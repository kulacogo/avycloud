'use strict';

/**
 * Echte Kaufland-Erstattungen aus dem Buchungsbericht.
 *
 * Die Retouren-API gibt keinen Erstattungsbetrag heraus (live geprueft, es gibt
 * kein Feld). Der BUCHUNGSBERICHT dagegen enthaelt Zeilen wie
 *   booking_text: "Erstattung Bestell-Nr. M3GHCL5"
 *   id_order_unit: "314568011900043"
 *   amount: "-10,00"
 * — und `id_order_unit` ist genau der Schluessel, ueber den eine
 * Retouren-Position verknuepft ist. Damit laesst sich der ECHTE Betrag zuordnen.
 *
 * ABER, gemessen am 17.08.2026 ueber 01.06.–17.08.: von 13 Retouren-Positionen
 * hat **null** eine Erstattungsbuchung. Die drei vorhandenen Erstattungen
 * (34,93 €) gehoeren zu anderen Bestellungen. Grund steht in denselben Daten:
 * 57 Buchungen heissen "Freigabe Verkaufserloes" — Kaufland gibt den Erloes erst
 * Wochen nach Lieferung frei; kommt die Retoure vorher, wird das Geld nie
 * ausgezahlt statt erstattet, es entsteht also gar keine Gegenbuchung.
 *
 * Deshalb: echter Betrag wenn vorhanden, sonst die Naeherung aus dem
 * Bestellpreis. `amountBasis` haelt fest, welcher Fall vorlag.
 */

const { indexRefundBookingsByOrderUnit } = require('../lib/kaufland-refund-bookings');

const buchung = (text, unit, cents) => ({
  amount_cents: cents,
  raw: { booking_text: text, id_order_unit: unit, amount: (cents / 100).toFixed(2) },
});

describe('Erstattungsbuchungen nach Bestellposition', () => {
  it('erkennt eine echte Erstattung', () => {
    const idx = indexRefundBookingsByOrderUnit([
      buchung('Erstattung Bestell-Nr. M3GHCL5', '314568011900043', -1000),
    ]);
    expect(idx.get('314568011900043')).toBe(10);
  });

  it('summiert mehrere Buchungen auf dieselbe Position', () => {
    const idx = indexRefundBookingsByOrderUnit([
      buchung('Erstattung Bestell-Nr. X', '111', -1000),
      buchung('Storno Wareneingang', '111', -500),
    ]);
    expect(idx.get('111')).toBe(15);
  });

  it('ignoriert die Erloes-Freigaben — das sind keine Erstattungen', () => {
    // 57 von 66 Buchungen heissen so. Wuerde man sie mitzaehlen, waere jede
    // ausgezahlte Bestellung ploetzlich eine Retoure.
    const idx = indexRefundBookingsByOrderUnit([
      buchung('Freigabe Verkaufserlös zu Bestell-Nr. M3GHCL5', '111', 3799),
    ]);
    expect(idx.size).toBe(0);
  });

  it('ignoriert Auszahlungen, Werbekosten und Gebuehren', () => {
    const idx = indexRefundBookingsByOrderUnit([
      buchung('Payout', '', -194635),
      buchung('Netto Sponsored Product Ads Click Costs', '', -2063),
      buchung('Fees for cancelled orders July 26', '', -3001),
      buchung('Umsatzsteuer Sponsored Product Ads Click Costs', '', -392),
    ]);
    expect(idx.size).toBe(0);
  });

  it('zaehlt nur Abgaenge — eine positive Buchung ist keine Erstattung', () => {
    const idx = indexRefundBookingsByOrderUnit([
      buchung('Erstattung Bestell-Nr. X', '111', 1000),
    ]);
    expect(idx.size).toBe(0);
  });

  it('braucht die Bestellposition als Schluessel', () => {
    const idx = indexRefundBookingsByOrderUnit([
      buchung('Erstattung Bestell-Nr. X', '', -1000),
    ]);
    expect(idx.size).toBe(0);
  });

  it('vertraegt leere Eingaben', () => {
    expect(indexRefundBookingsByOrderUnit(null).size).toBe(0);
    expect(indexRefundBookingsByOrderUnit([]).size).toBe(0);
    expect(indexRefundBookingsByOrderUnit([{}]).size).toBe(0);
  });

  it('erkennt auch Gutschrift und Rueckerstattung', () => {
    const idx = indexRefundBookingsByOrderUnit([
      buchung('Gutschrift zu Bestell-Nr. X', '111', -100),
      buchung('Rückerstattung Bestell-Nr. Y', '222', -200),
    ]);
    expect(idx.get('111')).toBe(1);
    expect(idx.get('222')).toBe(2);
  });
});
