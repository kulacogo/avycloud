'use strict';

/**
 * Bildsuche: zu enge Anfragen liefern NICHTS.
 *
 * Gemessen gegen die echte SerpAPI (2026-08-16):
 *   "LIVARNO home Relaxsessel-Auflage 4052916309858"  ->  0 Treffer
 *   "LIVARNO home Relaxsessel-Auflage"                -> 96 Treffer
 *
 * Der Chat baut die Anfrage aus Marke + Name + EAN. Steht die EAN mit drin,
 * findet Google oft gar nichts — und der Code gab kommentarlos auf, statt es
 * eine Stufe breiter zu versuchen. Fuer den Bediener sah es so aus, als koenne
 * der Assistent keine Produktbilder mehr finden.
 */

const { broadenImageQuery } = require('../../lib/image-search');

describe('broadenImageQuery', () => {
  it('liefert die Ausgangsanfrage zuerst', () => {
    const stufen = broadenImageQuery('Bosch GSR 12V Akkuschrauber');
    expect(stufen[0]).toBe('Bosch GSR 12V Akkuschrauber');
  });

  it('entfernt die EAN als zweite Stufe', () => {
    const stufen = broadenImageQuery('LIVARNO home Relaxsessel-Auflage 4052916309858');
    expect(stufen).toContain('LIVARNO home Relaxsessel-Auflage');
  });

  it('entfernt auch mehrere lange Ziffernfolgen', () => {
    const stufen = broadenImageQuery('Marke Modell 4052916309858 0123456789012');
    expect(stufen.some((s) => !/\d{8,}/.test(s))).toBe(true);
  });

  it('laesst kurze Zahlen stehen — sie gehoeren oft zum Modellnamen', () => {
    // "12V", "8000", "IZ201EU" sind Teil des Produktnamens, keine Kennnummern.
    const stufen = broadenImageQuery('AEG Animal 8000 AB81A2DG Bodenstaubsauger');
    expect(stufen.every((s) => s.includes('8000'))).toBe(true);
  });

  it('kuerzt als letzte Stufe auf die ersten Woerter', () => {
    const stufen = broadenImageQuery('Marke Modell Zusatz Noch Mehr Text Und Weiteres');
    const letzte = stufen[stufen.length - 1];
    expect(letzte.split(/\s+/).length).toBeLessThan(8);
  });

  it('liefert keine Dubletten und nichts Leeres', () => {
    const stufen = broadenImageQuery('Bosch');
    expect(new Set(stufen).size).toBe(stufen.length);
    expect(stufen.every((s) => s && s.trim().length > 0)).toBe(true);
  });

  it('kommt mit leerer Eingabe zurecht', () => {
    expect(broadenImageQuery('')).toEqual([]);
    expect(broadenImageQuery(null)).toEqual([]);
  });

  it('macht aus einer bereits breiten Anfrage keine unnoetigen Stufen', () => {
    const stufen = broadenImageQuery('Bosch Bohrer');
    expect(stufen.length).toBeLessThanOrEqual(2);
  });
});
