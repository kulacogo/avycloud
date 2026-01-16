/* eslint-disable no-console */
/**
 * Central, shared policy text for all LLM-facing prompts (Identify / Improve / Chat).
 *
 * Goals:
 * - Keep instructions consistent across modules to prevent drift.
 * - Encode non-negotiable business rules (title policy, no price/placeholder, category, barcodes, K-Typ).
 * - Make it explicit that LLMs may only use WEB evidence when it is provided by the system/tooling.
 */

function buildTitleSchemaLines() {
  return [
    // MASTER: 90% of items
    '1) Master: [MARKE] [PRODUKTART] [MODELL/MPN] [KERNMERKMAL] [VARIANTE] [ZUSTAND]',
    // Auto parts
    '2) Autoteile: [MARKE] [BAUTEIL] [MPN/OE] [FAHRZEUG/BAUREIHE] [TECHDATEN] [ZUSTAND]  (Fahrzeug immer vor Maße)',
    // Fashion
    '3) Mode/Textil: [MARKE] [ARTIKELTYP] [MODELL] [GESCHLECHT] Gr. [GRÖSSE] [FARBE] [ZUSTAND]  (Farbe nie vor Artikeltyp)',
    '4) Schuhe: [MARKE] [SCHUHART] [MODELL] [GESCHLECHT] EU [GRÖSSE] [FARBE] [ZUSTAND]',
    // Tech
    '5) Elektronik/Tech: [MARKE] [PRODUKT] [MODELL] [SCHLÜSSEL-SPEC] [FARBE] [ZUSTAND]  (Specs > Marketing)',
    '6) Computer/Komponenten: [MARKE] [KOMPONENTE] [MODELL] [SCHLÜSSEL-SPEC] [ZUSTAND]',
    // Home / tools
    '7) Haushalt/Wohnen: [MARKE] [PRODUKTART] [MODELL] [MAẞE/KAPAZITÄT] [MATERIAL] [FARBE] [ZUSTAND]',
    '8) Werkzeug/Bau/Garten: [MARKE] [WERKZEUGART] [MODELL] [MAẞE/LEISTUNG/SET] [ZUSTAND]',
    // Misc
    '9) Tierbedarf: [MARKE] [PRODUKTART] [TIERART] [GRÖSSE/VOLUMEN] [MATERIAL] [FARBE]',
    '10) Bücher/Medien: [AUTOR/KÜNSTLER] – [TITEL] [FORMAT] [SPRACHE] [ZUSTAND]',
  ];
}

function buildTitleSchemaGuideText() {
  return buildTitleSchemaLines().join('\n');
}

function buildCommonPolicyText({ locale = 'de-DE', allowWebEvidence = false } = {}) {
  return [
    `Sprache: ${locale}.`,
    '',
    'HARD RULES (immer):',
    '- Titel: Mobile-first. Die ersten ~55–60 Zeichen zählen (eBay App). Alles Wichtige MUSS vorne stehen.',
    '- Titel: Feste Reihenfolge (nie ändern): [MARKE] [PRODUKTART] [MODELL/MPN] [KERNMERKMAL] [VARIANTE] [ZUSTAND].',
    '- Titel: Priorität A muss in den ersten 60 Zeichen sein: Marke + Produkttyp + Modell/MPN/Teilenummer.',
    '- Titel: Länge: optimal 65–75 Zeichen, Hard-Max eBay: 80 Zeichen (nie > 80). Wenn >75: erst low-prio Tokens streichen.',
    '- Titel: Keine Marketingfloskeln, keine Emojis, keine Wiederholungen, keine Sonderzeichen am Anfang.',
    '- Keine Preise/Preisorientierung/€ oder EUR in Titel, Beschreibung oder Highlights.',
    '- Keine Platzhalter (z.B. "unknown", "unbekannt", "Beschreibung folgt", "Not Provided", "info@example.com").',
    '- Wenn unsicher: Feld leer lassen + in notes/warnings markieren. AUSNAHME: eBay Pflicht-Item-Specifics (required aspects) sollen nach bestem Wissen aus den Belegen ausgefüllt werden; nur wenn wirklich unbelegbar: "Unbekannt" + Warning.',
    '- Attribute müssen neutral sein (nicht marktplatz-spezifisch). KEINE Attribute/Keys, die "ebay" oder "kaufland" enthalten (z.B. ebay_*_id/path, ebayCategory*, kaufland_*_id/path).',
    '- Keine internen/Meta-Keys als Attribute (z.B. product-id, *_id, text_*, features|*).',
    '- Barcodes: niemals raten. Nur setzen, wenn der Code in den bereitgestellten Belegen (OCR/WEB-EVIDENZ) vorkommt UND die Checkdigit stimmt (8/12/13/14 Ziffern). Sonst leer lassen.',
    '- Zustand: Default NEU. "Gebraucht/Used" nur, wenn es explizit vom Nutzer gelockt wurde (condition_locked). Sonst niemals setzen.',
    '- Gewicht: immer als ZAHL in KG (ohne Einheit). Beispiele: 1 für 1kg, 0.75 für 750g. Wenn Gewicht nicht belegbar: Feld leer lassen (nicht raten).',
    '- K-Typ (Auto/KFZ/Motorrad): wenn vorhanden, beibehalten. Wenn nicht sicher ableitbar: leer lassen (nicht raten).',
    '- K-Typ Format (intern): Einträge mit "|" trennen. Eintrag ist "<KtypeId>" oder "<KtypeId>,<Note>". Beispiel: "57448|111981,Einbauposition Vorderachse".',
    '- Kategorie: eBay.de Breadcrumb aus Taxonomie, mindestens 2 Ebenen (muss ">"). Keine Top-Level Kategorien als final.',
    '',
    'DATASHEET FORMAT (wenn du Datenblattfelder erzeugst/änderst):',
    '- Beschreibung: exakt 3 Absätze mit jeweils 2 Sätzen. Keine Aufzählungen/Bullets.',
    '- Highlights: 5–7 Bulletpoints mit je 6–12 Wörtern, technisch/faktenbasiert, keine Verpackung, keine Dubletten.',
    '- Attribute: mindestens 10, sehr granular/technisch, keine Dubletten (auch nicht als Synonyme) und keine redundanten Keys mit identischem Wert.',
    '- Pflicht-Item-Specifics (required aspects): wenn Kategorie gesetzt ist, alle Pflicht-Aspekte vollständig ausfüllen (nur mit Belegen; sonst "Unbekannt" + Warning).',
    '',
    allowWebEvidence ? 'WEB-EVIDENZ:' : null,
    allowWebEvidence
      ? '- Du darfst WEB-EVIDENZ NUR verwenden, wenn sie dir im Prompt bereitgestellt wird oder über ein Tool geliefert wurde.'
      : null,
    allowWebEvidence
      ? '- Keine Behauptungen ohne Beleg: nutze nur Fakten, die in Bildern/OCR/Barcodes oder WEB-EVIDENZ enthalten sind.'
      : null,
    allowWebEvidence ? '' : null,
    'TITLE-SCHEMA GUIDELINES (best-effort je Kategorie):',
    buildTitleSchemaGuideText(),
  ]
    .filter((x) => x !== null && x !== undefined)
    .join('\n');
}

module.exports = {
  buildCommonPolicyText,
  buildTitleSchemaGuideText,
  buildTitleSchemaLines,
};


