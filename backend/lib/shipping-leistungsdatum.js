'use strict';

/**
 * Leistungsdatum einer Versand-Abbuchung — statt des Abbuchungstags.
 *
 * Betreiber-Auftrag 2026-10-09: die Marge sprang am Monatsanfang von 50 % auf
 * 36 %, und 7 der 14 Punkte waren ein reiner Zeiteffekt. DHL und Deutsche Post
 * rechnen in 10-Tage-Zyklen ab und buchen ERST NACH dem Zyklus vom Konto ab:
 * die DHL-Rechnung vom 30.09.2026 (1.482,32 €) ging am 05.10. vom Konto und
 * landete damit im Oktober — zu 235 Oktober-Paketen, die sie gar nicht
 * betraf. Gemessen: 10,58 € je Paket im Oktober gegen 7,29 € im September.
 *
 * Der Kontoauszug traegt das Rechnungsdatum im Verwendungszweck:
 *   DHL:            ".../RG 1041606335/30.09.2026/VFTN 0101"
 *   Deutsche Post:  "... DAT30.09.2026 DHL PAKET International ..."
 * Das Rechnungsdatum ist das Ende des abgerechneten Zyklus — damit faellt
 * jede Rechnung in den Monat, in dem die Pakete verschickt wurden.
 *
 * DPD ("DPD RECHNUNG RE-66841150") und SendCloud ("2-26-DE0063740") tragen
 * KEIN Datum im Text. Dort bleibt es beim Abbuchungstag — ehrlich, nicht
 * geraten. Der Anteil ist ausgewiesen (`ohneLeistungsdatum`).
 *
 * Reine Funktionen, kein I/O.
 */

const TAG_MS = 24 * 3600 * 1000;

/** Rechnungsdatum darf hoechstens so weit VOR der Abbuchung liegen. */
const MAX_VORLAUF_TAGE = 60;
/** ... und hoechstens so weit danach (ein Datum in der Zukunft ist ein Tippfehler). */
const MAX_NACHLAUF_TAGE = 2;

function parseIsoDay(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Liest ein Datum dd.mm.yyyy aus dem Verwendungszweck.
 * @returns {string|null} ISO-Tag (YYYY-MM-DD) oder null
 */
function datumAusVerwendungszweck(text) {
  // Kein \b: bei "DAT30.09.2026" steht ein Buchstabe direkt vor der Ziffer.
  // Statt dessen: links und rechts weder Ziffer noch Punkt.
  const m = String(text || '').match(/(?<![\d.])(\d{2})\.(\d{2})\.(\d{4})(?![\d.])/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const iso = `${yyyy}-${mm}-${dd}`;
  const d = parseIsoDay(iso);
  if (!d) return null;
  // Rueckwaerts-Probe gegen den 31.02.
  if (d.getUTCDate() !== Number(dd) || d.getUTCMonth() + 1 !== Number(mm)) return null;
  return iso;
}

/**
 * Leistungsdatum einer Abbuchung.
 *
 * @param {{ valueDate?: string, paymtPurpose?: string }} buchung  SevDesk CheckAccountTransaction
 * @returns {{ datum: string|null, quelle: 'rechnung'|'abbuchung'|'keins' }}
 *   datum = ISO-Tag, der fuer die Periodenzuordnung gilt.
 */
function leistungsdatum(buchung) {
  const abbuchung = parseIsoDay(buchung?.valueDate);
  const rechnungIso = datumAusVerwendungszweck(buchung?.paymtPurpose);
  const rechnung = rechnungIso ? parseIsoDay(rechnungIso) : null;

  if (rechnung && abbuchung) {
    const diffTage = (abbuchung.getTime() - rechnung.getTime()) / TAG_MS;
    // Plausibel: Rechnung liegt kurz VOR der Abbuchung. Alles andere ist eine
    // Kundennummer, ein Fremddatum oder ein Tippfehler -> Abbuchungstag.
    if (diffTage >= -MAX_NACHLAUF_TAGE && diffTage <= MAX_VORLAUF_TAGE) {
      return { datum: rechnungIso, quelle: 'rechnung' };
    }
  }
  if (abbuchung) return { datum: String(buchung.valueDate).slice(0, 10), quelle: 'abbuchung' };
  return { datum: null, quelle: 'keins' };
}

/** true, wenn der ISO-Tag im Fenster [von, bis] (beide inklusiv) liegt. */
function imFenster(isoTag, von, bis) {
  if (!isoTag) return false;
  return isoTag >= String(von).slice(0, 10) && isoTag <= String(bis).slice(0, 10);
}

/**
 * Wie weit das Abfragefenster beim Kontoauszug nach HINTEN verlaengert werden
 * muss, damit eine Rechnung vom Monatsende, die erst im Folgemonat abgebucht
 * wird, noch gefunden wird. Gemessen: DHL 5 Tage, Deutsche Post 6 Tage;
 * 35 Tage decken auch einen verspaeteten Lastschriftlauf ab.
 */
const NACHLAUF_FENSTER_TAGE = 35;

function addDays(isoTag, tage) {
  const d = parseIsoDay(isoTag);
  if (!d) return isoTag;
  return new Date(d.getTime() + tage * TAG_MS).toISOString().slice(0, 10);
}

module.exports = {
  datumAusVerwendungszweck,
  leistungsdatum,
  imFenster,
  addDays,
  NACHLAUF_FENSTER_TAGE,
  MAX_VORLAUF_TAGE,
};
