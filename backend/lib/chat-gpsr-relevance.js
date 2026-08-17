'use strict';

/**
 * Ist GPSR in diesem Chat-Zug überhaupt Thema?
 *
 * Hintergrund (Vorfall 2026-08-17): Der Etikett-Leser (`extractGpsrFromImages`)
 * legte bei einer gezielten K-Typ-Frage ungefragt eine Karte "GPSR-Angaben vom
 * Etikett abgelesen" an. Die vorhandene Sperre lautete `!scope || …` — frei
 * getippte Fragen haben aber nie einen Rahmen, die Sperre war also für genau
 * den Fall offen, für den sie gedacht war.
 *
 * Wer eine Sache anfragt, bekommt eine Sache. Alles andere kostet den Menschen
 * Prüfzeit für Arbeit, die er nicht bestellt hat — und Vertrauen: eine Karte,
 * die man nicht angefordert hat, liest man nicht, man klickt sie weg.
 *
 * Ausdrücklich NICHT hier geregelt: eine bereits vorhandene GPSR-Karte darf das
 * Etikett weiterhin korrigieren. Das ist Datenqualität an vorhandener Arbeit,
 * keine Zusatzarbeit.
 */

/** Wörter, die GPSR wirklich meinen. */
const GPSR_THEMA_RE =
  /\b(gpsr|produktsicherheit|hersteller\w*|manufacturer|eu-?verantwortlich\w*|verantwortliche[rn]?\s+person|responsible\s+person|importeur|inverkehrbringer|etikett\w*|typenschild|label|impressum|herstelleradresse|herstellernachweis)\b/i;

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function gpsrIstThema({ scope = null, message = '' } = {}) {
  const rahmen = safeString(scope).toLowerCase();
  if (rahmen.includes('gpsr') || rahmen.includes('datasheet')) return true;

  const text = safeString(message);
  if (!text) return false;
  return GPSR_THEMA_RE.test(text);
}

module.exports = { gpsrIstThema };
