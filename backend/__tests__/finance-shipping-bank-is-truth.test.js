'use strict';

/**
 * Versandkosten: die Bankabbuchung ist die Zahl, nicht der SendCloud-Preis.
 *
 * Gemessen 2026-08-17: Der Bericht zeigte **4.906,89 €**, tatsaechlich vom Konto
 * abgeflossen sind **3.380,57 €** — **+1.526,32 € (+45 %)**.
 *
 * Ursache: mergeShipping addierte den von SendCloud BERECHNETEN Paketpreis UND
 * dieselbe Sendung als echte Bankabbuchung. Belegt ueber die SendCloud-API:
 * alle drei Carrier-Vertraege sind `type:"direct"` — eigener Vertrag, der
 * Carrier bucht selbst ab. Genau das sind die SevDesk-Buchungen.
 *
 * Dazu: SendCloud liefert ueberhaupt keinen Preis (0 von 495 Paketen), die
 * Werte stammen aus zwei CSV-Tabellen vom 25.02.2026, und ALLE 95
 * Deutsche-Post-Sendungen stehen dort auf 0,00 €.
 *
 * Neue Regel: SevDesk = Geld, SendCloud/eigene Sendungsliste = Stueckzahl.
 */

const { mergeShippingBankFirst } = require('../lib/finance-shipping-merge');

describe('Die Bank liefert den Betrag', () => {
  it('addiert den SendCloud-Preis NICHT dazu — der Vorfall', () => {
    const res = mergeShippingBankFirst(
      { total_cost: 430.62, direct_shipping_cost: 375.19, sendcloud_cost: 55.43, voucher_count: 7 },
      { parcel_count: 203, total_cost: 427.63, dhl_count: 33, dpd_count: 80 },
    );
    // 430,62 — nicht 430,62 + 427,63.
    expect(res.brutto).toBe(430.62);
    expect(res.source).toBe('bank');
  });

  it('nimmt die Stueckzahl und die Aufteilung weiterhin aus der Sendungsliste', () => {
    const res = mergeShippingBankFirst(
      { total_cost: 430.62, direct_shipping_cost: 375.19, voucher_count: 7 },
      { parcel_count: 203, dhl_count: 33, dpd_count: 80, other_count: 90 },
    );
    expect(res.parcelCount).toBe(203);
    expect(res.dhl).toBe(33);
    expect(res.dpd).toBe(80);
    expect(res.other).toBe(90);
  });

  it('weist Fracht und Plattform getrennt aus', () => {
    const res = mergeShippingBankFirst(
      { total_cost: 430.62, direct_shipping_cost: 375.19, sendcloud_cost: 55.43, voucher_count: 7 },
      null,
    );
    expect(res.fracht).toBe(375.19);
    expect(res.plattform).toBe(55.43);
  });
});

describe('Fehlende Abbuchung ist NICHT null Euro', () => {
  it('liefert null statt 0, wenn im Zeitraum nichts abgebucht wurde', () => {
    // August 2026: 287 Sendungen, aber noch keine Rechnung — DHL und DPD
    // buchen mit Verzug ab. 0 € waere eine Luege, die die Marge aufblaest.
    const res = mergeShippingBankFirst(
      { total_cost: 0, direct_shipping_cost: 0, voucher_count: 0 },
      { parcel_count: 287, dhl_count: 150, dpd_count: 60 },
    );
    expect(res.brutto).toBe(null);
    expect(res.parcelCount).toBe(287);
    expect(res.pending).toBe(true);
  });

  it('meldet auch ohne jede Quelle sauber null', () => {
    const res = mergeShippingBankFirst(null, null);
    expect(res.brutto).toBe(null);
    expect(res.parcelCount).toBe(0);
  });
});

describe('Was NICHT mitgezaehlt wird', () => {
  it('laesst die Portokassen-Aufladung aussen vor', () => {
    // prepaid_cost steckt bewusst nicht in total_cost; hier nur zur Anzeige.
    const res = mergeShippingBankFirst(
      { total_cost: 430.62, direct_shipping_cost: 375.19, sendcloud_cost: 55.43, prepaid_cost: 200, voucher_count: 7 },
      null,
    );
    expect(res.brutto).toBe(430.62);
    expect(res.vorauszahlung).toBe(200);
  });
});

describe('Kein Netto-Umweg mehr', () => {
  it('gibt brutto direkt zurueck, ohne durch 1,19 und zurueck zu rechnen', () => {
    // Der alte Weg rundete: 430,62 → /1,19 → ×1,19 → 430,63.
    // Briefporto ist ausserdem umsatzsteuerfrei — ein pauschales /1,19 ist dort
    // schlicht falsch.
    const res = mergeShippingBankFirst({ total_cost: 430.62, voucher_count: 3 }, null);
    expect(res.brutto).toBe(430.62);
  });
});
