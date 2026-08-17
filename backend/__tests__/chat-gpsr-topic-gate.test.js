'use strict';

/**
 * Eine gezielte Frage darf keine fremden Vorschlaege zurueckbringen.
 *
 * Vorfall 2026-08-17: Auf "K-Typ ermitteln" kam zusaetzlich eine Karte
 * "GPSR-Angaben vom Etikett abgelesen" — ungefragt. Ursache: der Etikett-Leser
 * lief immer dann, wenn KEIN Rahmen gesetzt war ("!scope"). Frei getippte
 * Fragen haben nie einen Rahmen — die Sperre war also fuer genau den Fall
 * offen, fuer den sie gebaut wurde.
 *
 * Neue Regel: eine NEUE GPSR-Karte entsteht nur, wenn GPSR wirklich Thema ist —
 * per Schnellaktion ODER weil der Mensch danach fragt. Liegt bereits eine
 * GPSR-Karte vor, darf das Etikett sie weiterhin korrigieren; das ist
 * Datenqualitaet und keine Zusatzarbeit.
 */

const { gpsrIstThema } = require('../lib/chat-gpsr-relevance');

describe('Wann GPSR Thema ist', () => {
  it('bei der GPSR-Schnellaktion', () => {
    expect(gpsrIstThema({ scope: 'gpsr' })).toBe(true);
  });

  it('beim Voll-Durchlauf ueber das ganze Datenblatt', () => {
    expect(gpsrIstThema({ scope: 'datasheet' })).toBe(true);
  });

  it('wenn der Mensch danach fragt', () => {
    for (const message of [
      'Bitte GPSR-Angaben ergaenzen',
      'Wer ist der Hersteller?',
      'Trage den EU-Verantwortlichen ein',
      'Lies das Etikett aus',
      'Fehlt die Herstelleradresse?',
      'Produktsicherheit pruefen',
    ]) {
      expect(gpsrIstThema({ message })).toBe(true);
    }
  });

  it('NICHT bei einer gezielten Frage zu etwas anderem', () => {
    for (const message of [
      'Ermittle den K-Typ',
      'Kuerze den Titel',
      'Was ist der Marktpreis?',
      'Finde die EAN',
      'Schreib die Beschreibung neu',
    ]) {
      expect(gpsrIstThema({ message })).toBe(false);
    }
  });

  it('NICHT bei leerer Eingabe', () => {
    expect(gpsrIstThema({})).toBe(false);
    expect(gpsrIstThema({ scope: null, message: '' })).toBe(false);
  });

  it('laesst sich vom Wort "Marke" nicht ueberreden', () => {
    // "Marke" ist Titel-/Identitaetsarbeit, kein GPSR-Thema.
    expect(gpsrIstThema({ message: 'Korrigiere die Marke im Titel' })).toBe(false);
  });
});
