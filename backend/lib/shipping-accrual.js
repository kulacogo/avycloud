'use strict';

/**
 * Versand-Abgrenzung: Pakete, die verschickt, aber noch nicht abgerechnet sind.
 *
 * Mit dem Leistungsdatum (lib/shipping-leistungsdatum.js) landet jede Rechnung
 * im richtigen Monat. Dafuer entsteht am Monatsanfang die Gegenluecke: die
 * Pakete der ersten Tage sind verschickt, die DHL-Rechnung fuer den Zyklus
 * kommt erst zum 10. — gemessen 09.10.2026: 235 Oktober-Pakete gegen 175 €
 * gebuchten Versand, Marge 55,6 % statt real ~47 %. Eine Marge, die am
 * Monatsanfang nach oben springt, ist genauso falsch wie eine, die nach unten
 * springt.
 *
 * Deshalb werden die Pakete NACH dem letzten bekannten Rechnungsdatum mit dem
 * Stueckpreis des Vormonats bewertet und als SCHAETZUNG ausgewiesen. Sobald
 * die Rechnung gebucht ist, ersetzt der echte Betrag die Schaetzung von
 * selbst — das Leistungsdatum rueckt den Stichtag vor.
 *
 * Was NICHT geschaetzt wird: liegt kein Vormonats-Stueckpreis vor (erster
 * Monat, keine Pakete), bleibt es bei der Luecke — mit Hinweis, nicht mit
 * einer erfundenen Zahl.
 *
 * Reine Funktionen, kein I/O.
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function round2(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Stueckpreis (brutto je Paket) aus einer abgeschlossenen Periode.
 * @returns {number|null} null, wenn die Periode nichts hergibt.
 */
function stueckpreisAusPeriode({ brutto, parcelCount } = {}) {
  const b = num(brutto);
  const p = num(parcelCount);
  if (b <= 0 || p <= 0) return null;
  return round2(b / p);
}

/**
 * @param {object} args
 * @param {number|null} args.gebuchtBrutto     Versand im Fenster nach Leistungsdatum (null = nichts gebucht)
 * @param {number} args.offeneParcels          Pakete im Fenster NACH dem letzten Rechnungsdatum
 * @param {number|null} args.stueckpreis       brutto je Paket aus dem Vormonat
 * @returns {{brutto: number|null, geschaetzt: number, geschaetztParcels: number, approx: boolean, grund: string|null}}
 */
function ergaenzeOffenenVersand({ gebuchtBrutto = null, offeneParcels = 0, stueckpreis = null } = {}) {
  const offen = Math.max(0, Math.floor(num(offeneParcels)));
  const gebucht = gebuchtBrutto == null ? null : round2(gebuchtBrutto);

  if (offen === 0) {
    return { brutto: gebucht, geschaetzt: 0, geschaetztParcels: 0, approx: false, grund: null };
  }
  if (stueckpreis == null || num(stueckpreis) <= 0) {
    // Lieber eine sichtbare Luecke als eine erfundene Zahl.
    return { brutto: gebucht, geschaetzt: 0, geschaetztParcels: offen, approx: false, grund: 'kein_stueckpreis' };
  }
  const geschaetzt = round2(offen * num(stueckpreis));
  return {
    brutto: round2(num(gebucht) + geschaetzt),
    geschaetzt,
    geschaetztParcels: offen,
    approx: true,
    grund: null,
  };
}

module.exports = { stueckpreisAusPeriode, ergaenzeOffenenVersand };
