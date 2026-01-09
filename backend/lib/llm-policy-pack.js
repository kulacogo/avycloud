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
    '1) Schuhe: {Marke} {Modell} {Zielgruppe} Sneaker {Farbe} Gr. {Größe} {Zustand}',
    '2) Bekleidung: {Marke} {Produktart} {Zielgruppe} {Farbe} Gr. {Größe} {Material} {Zustand}',
    '3) Taschen: {Marke} {Taschenart} {Modell} {Farbe} {Material} {Zustand}',
    '4) Schmuck: {Marke} {Schmuckart} {Material} {Stein/Farbe} {Größe} {Zustand}',
    '5) Uhren: {Marke} {Modell} {Zielgruppe} {Anzeige} {Material} {Zustand}',
    '6) Autoteile mechanisch: {Marke} {Teil} {MPN} für {Hersteller} {Maß} {Merkmal}',
    '7) Autoteile Zubehör: {Produktart} passgenau für {Marke} {Modell} {Baureihe} {Zustand}',
    '8) Motorradteile: {Marke} {Teil} für {Motorrad} {Baujahr} {Position} {Zustand}',
    '9) Fahrradteile: {Marke} {Teil} {Modell} {Maß} {Kompatibilität} {Zustand}',
    '10) Fahrrad Zubehör: {Produktart} für Fahrrad {Typ} {Eigenschaft} {Maß} {Zustand}',
    '11) Elektronik: {Marke} {Produkt} {Modell} {Variante} {Farbe} {Zustand}',
    '12) Elektronik Zubehör: {Produktart} für {Gerät} {Modell} {Eigenschaft} {Zustand}',
    '13) Smartphones: {Marke} {Modell} {Speicher} {Farbe} ohne Simlock {Zustand}',
    '14) Laptops: {Marke} {Modell} {CPU} {RAM} {SSD} {Zustand}',
    '15) PC Hardware: {Marke} {Komponente} {Modell} {Spezifikation} {Zustand}',
    '16) Haushalt: {Marke} {Produktart} {Modell} {Kapazität/Größe} {Zustand}',
    '17) Werkzeuge: {Marke} {Werkzeug} {Modell} {Leistung} {Zustand}',
    '18) Garten: {Marke} {Gerät} {Modell} {Leistung/Fläche} {Zustand}',
    '19) Spielzeug: {Marke} {Spielzeugart} {Serie/Thema} {Alter} {Zustand}',
    '20) Brettspiele: {Spielname} {Edition} {Spieleranzahl} {Sprache} {Zustand}',
    '21) Videospiele: {Titel} für {Plattform} {Edition} deutsch {Zustand}',
    '22) Konsolen: {Marke} {Konsole} {Modell} {Speicher} {Zustand}',
    '23) Filme: {Titel} {Format} {Edition} {Sprache} {Zustand}',
    '24) Musik: {Künstler} – {Album} {Format} {Edition} {Zustand}',
    '25) Bücher: {Autor} – {Titel} {Zeitraum/Ausgabe} {Einband} {Zustand}',
    '26) Bürobedarf: {Marke} {Produkt} {Modell} {Menge/Format} {Zustand}',
    '27) Sportartikel: {Marke} {Sportart} {Produkt} {Größe} {Zustand}',
    '28) Outdoor: {Marke} {Produkt} {Modell} {Kapazität/Größe} {Zustand}',
    '29) Beauty: {Marke} {Produkt} {Variante} {Inhalt} {Zustand}',
    '30) Sammelartikel: {Marke/Thema} {Objekt} {Serie/Jahr} {Edition} {Zustand}',
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
    '- Titel: TECHNISCH & suchbar, Ziel 70–80 Zeichen (nie > 80), keine SKU/IDs.',
    '- Keine Preise/Preisorientierung/€ oder EUR in Titel, Beschreibung oder Highlights.',
    '- Keine Platzhalter (z.B. "unknown", "unbekannt", "Beschreibung folgt", "Not Provided", "info@example.com"). Wenn unsicher: Feld leer lassen + in notes/warnings markieren.',
    '- Attribute müssen neutral sein (nicht marktplatz-spezifisch). KEINE Attribute/Keys, die "ebay" oder "kaufland" enthalten (z.B. ebay_*_id/path, ebayCategory*, kaufland_*_id/path).',
    '- Keine internen/Meta-Keys als Attribute (z.B. product-id, *_id, text_*, features|*).',
    '- Barcodes: niemals raten. Nur setzen, wenn der Code in den bereitgestellten Belegen (OCR/WEB-EVIDENZ) vorkommt UND die Checkdigit stimmt (8/12/13/14 Ziffern). Sonst leer lassen.',
    '- Zustand: Default NEU. "Gebraucht/Used" nur, wenn es explizit vom Nutzer gelockt wurde (condition_locked). Sonst niemals setzen.',
    '- Gewicht: immer als ZAHL in KG (ohne Einheit). Beispiele: 1 für 1kg, 0.75 für 750g. Wenn Gewicht nicht belegbar: Feld leer lassen (nicht raten).',
    '- K-Typ (Auto/KFZ/Motorrad): wenn vorhanden, beibehalten. Wenn nicht sicher ableitbar: leer lassen (nicht raten).',
    '- Kategorie: eBay.de Breadcrumb aus Taxonomie, mindestens 2 Ebenen (muss ">"). Keine Top-Level Kategorien als final.',
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


