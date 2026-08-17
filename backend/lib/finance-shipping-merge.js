'use strict';

/**
 * Versandkosten für den Finanzbericht: Die Bankabbuchung ist die Zahl.
 *
 * Gemessen 2026-08-17: Der Bericht zeigte 4.906,89 €, tatsächlich vom Konto
 * abgeflossen sind 3.380,57 € — **+1.526,32 € (+45 %)**.
 *
 * Die alte Rechnung addierte den von SendCloud *berechneten* Paketpreis UND
 * dieselbe Sendung noch einmal als echte Bankabbuchung. Über die SendCloud-API
 * belegt: alle drei Verträge sind `type:"direct"` — eigener Vertrag mit dem
 * Frachtführer, der Carrier bucht direkt ab. Die SevDesk-Buchungen SIND diese
 * Pakete. Sie zusammenzuzählen heißt, dieselbe Sendung zweimal zu bezahlen.
 *
 * Dazu kommt: SendCloud liefert überhaupt keinen Preis (0 von 495 Paketen mit
 * API-Preis). Die Werte stammen aus zwei CSV-Tabellen vom 25.02.2026, und alle
 * 95 Deutsche-Post-Sendungen stehen dort auf 0,00 €. Als Geldquelle taugt das
 * nicht.
 *
 * Neue Aufteilung:
 *   Geld       → SevDesk (Kontoauszug, brutto, exakt)
 *   Stückzahl  → Sendungsliste / SendCloud (nur Anzeige)
 *
 * Kein Netto-Umweg mehr: Der alte Weg rechnete Bank-Brutto durch 1,19 und
 * später wieder mal 1,19 — das rundet (430,62 → 430,63) und ist beim Briefporto
 * der Deutschen Post sogar sachlich falsch, weil das umsatzsteuerfrei ist.
 *
 * WICHTIG — die Bank hinkt hinterher: Die Rechnung kommt nach der Sendung.
 * Gemessen: 88 DPD-Pakete gegen 70,68 € Bankabgang, die DPD-Rechnung war noch
 * nicht da. Ein junges Fenster zeigt deshalb immer zu wenig. Das darf NICHT
 * aufgefüllt werden — es muss beschriftet werden. Deshalb `pending`.
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

/**
 * @param {object|null} sevdesk   Ergebnis von getShippingCostsFromSevDesk().
 * @param {object|null} sendcloud Ergebnis von getShippingCostsSummary() — nur Stückzahl.
 * @returns {{brutto: number|null, fracht: number, plattform: number,
 *            vorauszahlung: number, parcelCount: number, dhl: number,
 *            dpd: number, other: number, pending: boolean, source: string}}
 */
function mergeShippingBankFirst(sevdesk, sendcloud) {
  const sv = sevdesk || null;
  const sc = sendcloud || null;

  const parcelCount = num(sc?.parcel_count);
  const dhl = num(sc?.dhl_count);
  const dpd = num(sc?.dpd_count);
  const other = sc?.other_count != null ? num(sc.other_count) : Math.max(0, parcelCount - dhl - dpd);

  const gebucht = round2(sv?.total_cost);
  const hatBuchung = Boolean(sv) && num(sv.voucher_count) > 0 && gebucht > 0;

  return {
    // null statt 0: "noch nicht abgebucht" ist etwas anderes als "kostenlos".
    // Eine 0 hier bläht die Marge auf und sieht aus wie ein Rekordmonat.
    brutto: hatBuchung ? gebucht : null,
    fracht: round2(sv?.direct_shipping_cost),
    plattform: round2(sv?.sendcloud_cost),
    vorauszahlung: round2(sv?.prepaid_cost),
    parcelCount,
    dhl,
    dpd,
    other,
    pending: !hatBuchung && parcelCount > 0,
    source: hatBuchung ? 'bank' : 'keine',
  };
}

module.exports = { mergeShippingBankFirst };
