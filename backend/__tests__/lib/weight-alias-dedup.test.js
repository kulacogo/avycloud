'use strict';

/**
 * Gewichts-Korrektur muss bei eBay ankommen.
 *
 * Das Datenblatt schreibt eine Gewichts-Aenderung nach `details.weight`. Im
 * Speicherpfad wurde daraus zusaetzlich `attributes.weight` — ANGEHAENGT,
 * waehrend das alte `attributes['Gewicht (kg)']` weiter VORNE im Objekt stand.
 * Beide Schluessel zeigen ueber die Alias-Tabelle auf denselben kanonischen
 * Namen, und bei einer Dopplung gewinnt der ERSTE Eintrag.
 *
 * Folge: das Datenblatt zeigte den neuen Wert, das eBay-Angebot behielt den
 * alten — die Korrektur landete unbemerkt in `attributes_extra`.
 *
 * Dieser Test nagelt fest, dass veraltete Schreibweisen beim Speichern
 * verschwinden, damit gar keine Dopplung mehr entstehen kann.
 */

const fs = require('fs');
const path = require('path');

const QUELLE = fs.readFileSync(path.join(__dirname, '../../lib/firestore.js'), 'utf8');

describe('Gewichts-Schreibweisen im Speicherpfad', () => {
  it('kennt die veralteten Schreibweisen auf Modul-Ebene', () => {
    // Muss ausserhalb von enforceEbayAspects stehen — saveProduct braucht sie.
    // Ein Zugriff auf die dortige lokale Tabelle waere zur Laufzeit abgestuerzt.
    expect(QUELLE).toMatch(/^const WEIGHT_ALIAS_KEYS = new Set\(\[/m);
  });

  it('deckt die im Bestand vorkommenden Schreibweisen ab', () => {
    const block = QUELLE.split('const WEIGHT_ALIAS_KEYS = new Set([')[1].split(']);')[0];
    for (const key of ['gewicht (kg)', 'gewicht(kg)', 'gewicht', 'eigengewicht (kg)', 'versandgewicht']) {
      expect(block).toContain(`'${key}'`);
    }
  });

  it('raeumt veraltete Schreibweisen VOR dem Setzen von attributes.weight ab', () => {
    const idx = QUELLE.indexOf('WEIGHT_ALIAS_KEYS.has(');
    const setIdx = QUELLE.indexOf('mergedDetails.attributes.weight = normalizedWeight;');
    expect(idx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(-1);
    // Reihenfolge ist der ganze Punkt: erst raeumen, dann setzen.
    expect(idx).toBeLessThan(setIdx);
  });

  it('laesst den kanonischen Schluessel `weight` selbst stehen', () => {
    const block = QUELLE.slice(QUELLE.indexOf('for (const key of Object.keys(mergedDetails.attributes))'));
    expect(block.slice(0, 300)).toContain("if (key === 'weight') continue;");
  });
});
