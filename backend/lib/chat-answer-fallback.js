'use strict';

/**
 * Ehrliche Antwort, wenn das Modell selbst keine geschrieben hat.
 *
 * Im Zwei-Phasen-Modus stammt die Nutzer-Antwort aus der Recherche (Phase A).
 * Kommt von dort nichts — weil die Frage gar keine Recherche braucht ("kürze den
 * Titel") oder die Suche leer blieb — und schreibt Phase B nur den
 * Werkzeug-Aufruf ohne Prosa, blieb bisher der Platzhalter "Antwort generiert."
 * übrig.
 *
 * Gemessen an 60 Chat-Läufen aus 14 Tagen: 36 % ohne Recherchetext, 61 % ohne
 * Quellen. Der Bediener sah dann Änderungskarten, aber keine Erklärung, was
 * geändert wird und worauf es sich stützt.
 *
 * Diese Zusammenfassung ist bewusst NÜCHTERN: sie erfindet nichts, sondern sagt
 * genau, was vorliegt — und wenn nichts vorliegt, sagt sie auch das.
 */

/** Technische Feldpfade in Wörter, die der Bediener im Datenblatt sieht. */
const FELD_NAMEN = {
  'identification.name': 'Titel',
  'identification.brand': 'Marke',
  'identification.category': 'Kategorie',
  'details.description': 'Beschreibung',
  'details.short_description': 'Kurzbeschreibung',
  'details.key_features': 'Highlights',
  'details.weight': 'Gewicht',
  'details.attributes': 'Merkmale',
  'details.pricing': 'Preis',
  'details.gpsr': 'GPSR-Angaben',
  'details.identifiers': 'Kennnummern',
};

function feldWort(pfad) {
  const key = String(pfad || '');
  if (FELD_NAMEN[key]) return FELD_NAMEN[key];
  // Auch Unterfelder sinnvoll benennen (details.gpsr.manufacturer_name → GPSR-Angaben)
  for (const [prefix, wort] of Object.entries(FELD_NAMEN)) {
    if (key.startsWith(`${prefix}.`)) return wort;
  }
  return key.split('.').pop() || key;
}

function buildFallbackAnswer(input) {
  const daten = input && typeof input === 'object' ? input : {};
  const changes = Array.isArray(daten.changes) ? daten.changes : [];
  const bilder = Number(daten.imageCount) || 0;
  const hatteRecherche = Boolean(String(daten.researchText || '').trim());

  const teile = [];

  if (changes.length) {
    const beschreibungen = changes
      .map((c) => {
        const s = String(c?.summary || '').trim();
        if (s) return s;
        const felder = Array.isArray(c?.fields) ? c.fields.map(feldWort) : [];
        return felder.length ? `${felder.join(', ')} angepasst` : '';
      })
      .filter(Boolean);

    if (changes.length === 1) {
      teile.push(`Ich schlage eine Änderung vor: ${beschreibungen[0] || 'siehe Karte unten'}.`);
    } else {
      teile.push(
        `Ich schlage ${changes.length} Änderungen vor: ${beschreibungen.slice(0, 5).join('; ')}` +
          (beschreibungen.length > 5 ? ' …' : '') + '.'
      );
    }
  }

  if (bilder > 0) {
    teile.push(`Dazu habe ich ${bilder} Produktbild${bilder === 1 ? '' : 'er'} gefunden.`);
  }

  if (!changes.length && !bilder) {
    teile.push('Ich habe nichts gefunden, was ich hier ändern würde — die vorhandenen Angaben bleiben wie sie sind.');
  }

  if (!hatteRecherche) {
    teile.push('Hinweis: Dazu lief keine Web-Recherche; die Vorschläge stützen sich auf die vorhandenen Bestandsdaten.');
  }

  teile.push('Prüf die Vorschläge bitte, bevor du sie übernimmst.');

  return teile.join(' ');
}

module.exports = { buildFallbackAnswer, feldWort };
