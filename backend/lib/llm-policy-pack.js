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
    '1) Elektronik & Computer: [MARKE] [MODELL] [PRODUKTTYP] [HAUPT-SPEC/SPEICHER] [ZUSTAND]',
    '2) Auto & Motorrad (Teile): [TEILNAME] [EINBAUORT] für [FAHRZEUG/MODELL] [OE/MPN] [SPEC]',
    '3) Mode & Bekleidung: [MARKE] [GESCHLECHT] [PRODUKTART] [FARBE] Gr. [GRÖSSE] [SPEZIFIK]',
    '4) Schuhe: [MARKE] [SCHUHART] [GESCHLECHT] Gr. [EU] [FARBE] [SPEZIFIK]',
    '5) Haus, Garten & Baumarkt: [PRODUKTART] [MATERIAL] [MAßE] [HAUPT-ANWENDUNG/FEATURE]',
    '6) Küche & Haushalt: [MARKE] [PRODUKTART] [TECHNOLOGIE/KOMPATIBILITÄT] [MAßE/VOLUMEN]',
    '7) Beauty & Personal Care: [MARKE] [LINIE] [PRODUKTART] [WIRKUNG] [MENGE]',
    '8) Sport & Freizeit: [MARKE] [SPORTART] [PRODUKTART] [MODELL] [GRÖSSE]',
    '9) Spielzeug & Baby: [MARKE] [LIZENZ/THEMA] [SET/PRODUKT] [ALTER/GRÖSSE]',
    '10) Büro & Schreibwaren: [MARKE] [PRODUKTART] [MODELL] [MENGE/PACKUNG]',
    '11) Uhren & Schmuck: [MARKE] [MATERIAL/LEGIERUNG] [PRODUKTART] [STEIN/BESATZ] [ZUSTAND]',
    '12) Videospiele & Konsolen: [PLATTFORM] [SPIELTITEL] [EDITION] [ZUSTAND] [USK]',
    '13) Bücher: [AUTOR] [BUCHTITEL] [FORMAT] [SPRACHE] [BESONDERHEIT]',
    '14) Musik (CDs & Vinyl): [INTERPRET] [ALBUMTITEL] [FORMAT] [GENRE] [BESONDERHEIT]',
    '15) Filme & DVDs: [FILMTITEL] [FORMAT] [EDITION/CUT] [GENRE] [ZUSTAND]',
    '16) Haustierbedarf: [MARKE] [TIERART] [PRODUKTART] [GRÖSSE/GEWICHT] [FEATURE]',
    '17) Sammeln & Seltenes (Münzen/Briefmarken): [LAND] [NENNWERT/MOTIV] [JAHR] [ERHALTUNGSGRAD] [MATERIAL]',
    '18) Foto & Camcorder: [MARKE] [MODELL] [OBJEKTIV-TYP] [AUFLÖSUNG] [ZUSTAND]',
    '19) Musikinstrumente: [MARKE] [INSTRUMENT] [TYP/MODELL] [MATERIAL/STIMMUNG] [ZUBEHÖR]',
    '20) Heimwerker (Werkzeug): [MARKE] [WERKZEUGART] [VOLT/LEISTUNG] [ENERGIEQUELLE] [ZUBEHÖR]',
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
    '- Titel: Reihenfolge ist schema-/kategorieabhängig (siehe "TITLE-SCHEMA GUIDELINES"). NIE frei umsortieren.',
    '- Titel: Priorität A muss in den ersten 60 Zeichen sein (kategorieabhängig; siehe "TITLE-SCHEMA GUIDELINES").',
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


