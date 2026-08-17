'use strict';

/**
 * Versandbuchungen im Kontoauszug einordnen.
 *
 * Drei Töpfe statt zwei, weil drei verschiedene Dinge im Auszug stehen:
 *
 *  - `fracht`        Die eigentlichen Versandkosten (DHL, DPD, Deutsche Post).
 *                    Das ist die Zahl für die Gewinnrechnung.
 *  - `plattform`     SendCloud-Rechnungen. Gehören zu den Versandkosten, sind
 *                    aber keine Fracht — nützlich, um sie getrennt zu zeigen.
 *  - `vorauszahlung` Portokassen-Aufladung. Das Geld ist abgeflossen, die
 *                    Leistung aber noch nicht bezogen. Als Verbrauch gezählt
 *                    würde ein halbes Jahr Briefporto in einem Monat landen.
 *
 * Gemessen 2026-08-17 an den echten Buchungen: Die alte Erkennung las nur
 * `payeePayerName` und übersah damit **341,81 € (10,1 %)** — 23 von 67
 * Buchungen sind Kartenzahlungen und haben dort gar keinen Namen
 * (304,91 € „SNDCLD SendCloud Munchen", 36,90 € „DHL WSI SHIPMENT BONN").
 *
 * Der Verwendungszweck wird deshalb ausgewertet — aber NUR, wenn kein Name da
 * ist. Sonst fiele die ursprüngliche Absicht weg: Eine Kundennotiz
 * „Rücksendung via DHL" darf keine Versandbuchung erzeugen.
 */

/** Frachtführer — im Namen ODER (bei Kartenzahlung) im Zweck. */
const FRACHT_MUSTER = [/\bdhl\b/i, /\bdpd\b/i, /\bgls\b/i, /deutsche\s*post/i, /\bdp\s*ag\b/i];

/** Die Versandplattform selbst. */
const PLATTFORM_MUSTER = [/sendcloud/i, /\bsndcld\b/i];

/** Vorauszahlung statt Verbrauch. */
const VORAUSZAHLUNG_MUSTER = [/portokasse/i, /porto\s*kasse/i];

function text(value) {
  return String(value == null ? '' : value);
}

/**
 * @param {{payeePayerName?: string|null, paymtPurpose?: string|null}|null} buchung
 * @returns {'fracht'|'plattform'|'vorauszahlung'|null}
 */
function kategorisiereVersandbuchung(buchung) {
  if (!buchung || typeof buchung !== 'object') return null;

  const name = text(buchung.payeePayerName).trim();
  const zweck = text(buchung.paymtPurpose).trim();

  // Der Zweck zählt NUR, wenn kein Name da ist (Kartenzahlungen).
  const durchsuchbar = name || zweck;
  if (!durchsuchbar) return null;

  // Portokasse zuerst: der Name lautet dort ebenfalls "Deutsche Post",
  // die Buchung ist aber keine Fracht.
  const gesamt = `${name} ${zweck}`;
  if (VORAUSZAHLUNG_MUSTER.some((re) => re.test(gesamt))) return 'vorauszahlung';

  if (PLATTFORM_MUSTER.some((re) => re.test(durchsuchbar))) return 'plattform';
  if (FRACHT_MUSTER.some((re) => re.test(durchsuchbar))) return 'fracht';
  return null;
}

module.exports = {
  kategorisiereVersandbuchung,
  FRACHT_MUSTER,
  PLATTFORM_MUSTER,
  VORAUSZAHLUNG_MUSTER,
};
