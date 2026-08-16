'use strict';

/**
 * Der Chat darf nie "Antwort generiert." zeigen.
 *
 * Gemessen an den Produktionsprotokollen (60 Chat-Laeufe, 14 Tage):
 *   36 % der Laeufe liefern KEINEN Recherchetext, 61 % keine einzige Quelle.
 *
 * Im Zwei-Phasen-Modus stammt die Nutzer-Antwort aus der Recherche (Phase A).
 * Kommt von dort nichts — weil die Frage gar keine Recherche braucht ("kuerze
 * den Titel") oder die Suche leer blieb — und schreibt Phase B nur den
 * Werkzeug-Aufruf ohne Prosa, blieb als Antwort der Platzhalter
 * "Antwort generiert." uebrig. Der sagt dem Bediener nichts: er sieht
 * Aenderungskarten, aber nicht, WAS geaendert wird und warum.
 */

const { buildFallbackAnswer } = require('../lib/chat-answer-fallback');

describe('buildFallbackAnswer', () => {
  it('fasst die vorgeschlagenen Aenderungen zusammen', () => {
    const text = buildFallbackAnswer({
      changes: [{ summary: 'Titel gekürzt', fields: ['identification.name'] }],
      researchText: '',
    });
    expect(text).toContain('Titel gekürzt');
    expect(text).not.toContain('Antwort generiert');
  });

  it('nennt die Anzahl, wenn mehrere Aenderungen vorliegen', () => {
    const text = buildFallbackAnswer({
      changes: [
        { summary: 'Titel gekürzt' },
        { summary: 'Beschreibung neu' },
        { summary: 'Gewicht ergänzt' },
      ],
      researchText: '',
    });
    expect(text).toMatch(/3/);
    expect(text).toContain('Titel gekürzt');
  });

  it('sagt ehrlich Bescheid, wenn es nichts vorzuschlagen gibt', () => {
    const text = buildFallbackAnswer({ changes: [], researchText: '' });
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toContain('Antwort generiert');
    // Muss erklaeren, dass nichts gefunden wurde — nicht so tun, als sei alles gut.
    expect(text).toMatch(/nichts|keine/i);
  });

  it('erwaehnt gefundene Bilder', () => {
    const text = buildFallbackAnswer({ changes: [], researchText: '', imageCount: 4 });
    expect(text).toMatch(/4/);
    expect(text).toMatch(/Bild/i);
  });

  it('weist darauf hin, wenn ohne Web-Recherche gearbeitet wurde', () => {
    const text = buildFallbackAnswer({
      changes: [{ summary: 'Titel gekürzt' }],
      researchText: '',
    });
    expect(text).toMatch(/ohne Web-Recherche|keine Web-Recherche|Bestandsdaten/i);
  });

  it('nutzt Feldnamen, wenn eine Zusammenfassung fehlt', () => {
    const text = buildFallbackAnswer({
      changes: [{ fields: ['identification.name', 'details.weight'] }],
      researchText: '',
    });
    expect(text).toMatch(/Titel|Name/i);
  });

  it('kommt mit kaputten Eingaben zurecht', () => {
    expect(typeof buildFallbackAnswer({})).toBe('string');
    expect(typeof buildFallbackAnswer(null)).toBe('string');
    expect(buildFallbackAnswer(null)).not.toContain('Antwort generiert');
  });
});
