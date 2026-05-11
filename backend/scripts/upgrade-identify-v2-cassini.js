'use strict';
// D.0b-Followup: identify.v2-Scope mit Cassini-Hardening upgraden.
// Erweitert promptText + rulesText um eBay-Leitfaden-Regeln (80-char title,
// 200-Wort-Description, 5-7% Density, 9 Kategorie-Patterns, GPSR-Pflicht,
// 45-Aspect-Cap, Compliance-Sektion). append-Mode bleibt — existing
// Code-Defaults + existing User-Prompt werden präserviert.

const { firestore } = require('../lib/firestore');

const CASSINI_PROMPT_APPEND = `

## CASSINI-HARDENING (Strategischer eBay-Leitfaden — VERBINDLICH)

### Title (80-Zeichen-Meisterschaft)
- Maximal 80 Zeichen, voll ausnutzen.
- Erste 3-5 Wörter: [Marke] + [Modell/ProduktTyp]. Mobile CTR-kritisch.
- Sonderzeichen-Verbot: kein &, !, _, /, kein NEU:/TOP:/ANGEBOT:/PREMIUM:/ORIGINAL:/RABATT:.
- Kein Füllwort (der/die/das, für Damen wenn Kategorie das impliziert).
- Keyword-Repetition max 1x; nutze Long-Tail-Variationen.
- Kategorie-spezifische Patterns:
  * Fashion: Marke + Modell + Produkttyp + Zielgruppe + Größe + Farbe + Material
  * Electronics: Marke + Modellname + MPN + Hauptmerkmal + Farbe
  * Home/Garden: Marke + Produktbez. + Material + Maße + Farbe + Stil
  * Motors: Hersteller + Teilename + Einbauposition + OEM-Referenz (KEINE Fahrzeugmodelle im Titel)
  * Collectibles: Jahr/Epoche + Objektbez. + Edition + Zustand/Grading
  * Toys: Marke + Thema + Set-Nr + Produktart + Zustand
  * Books/Music/Films: Titel + Autor/Künstler + Format + Edition + Zustand
  * Business/Industrial: Marke + Modell + Spezifikation + MPN (B2B, keine Werbe-Adjektive)
  * Hobby/Sport: Marke + Modell + Sportart + Spezifikation + Farbe

### Description (Content-KPIs)
- ~200 Wörter sichtbarer Text (180-220 Toleranz).
- Keyword-Dichte 5-7% (10-14 Nennungen der Hauptkeywords).
- Synonyme einweben für semantische Breite.
- Strukturiert: kurzer Hero-Absatz, Bullet-Points für Benefits (NICHT Features), Specs-Tabelle, Compliance/GPSR.
- Bullet-Points für Kundennutzen, nicht für Eigenschaften.
- Mobile-Snippet als <div vocab="https://schema.org/" typeof="Product"><span property="description">…800 chars…</span></div>.
- Basis-Schriftgröße 16px.

### Item-Specifics / Aspects
- ALLE eBay-RequiredAspects befüllen — binäre Sichtbarkeit. Fehlt 'Größe 44' → unsichtbar in Filtern.
- 45-Aspect-Cap (eBay-Limit): Priorität Required > Recommended > Optional.
- Nischen-Keywords (Stilbegriffe wie Waffle Knit, Peplum, Lagenlook) in passende Aspects, NICHT in Title.
- Bei Unsicherheit: 'Unbekannt' als Wert (besser als leer → vermeidet Low-Effort-Penalty).

### Pricing
- Median-Pricing aus Sold-Listings (eBay-Browse, Amazon, Idealo).
- 30-Cent-unter-Median-Taktik: subtile Differenzierung.
- Outlier-Schutz: max ±15% vom Median.

### Bilder
- 800-1600 px Mindestauflösung.
- Hauptbild: rein weißer Hintergrund (Google-Shopping-Pflicht).
- Video an Position 2.
- Lifestyle-Bilder Position 3-12.
- Hauptbild stilistisch ähnlich zu Top-Wettbewerbern (Cassini Similar-Listings-Trigger).

### GPSR (EU 2023/988)
- Hersteller-Name, Anschrift (Straße + PLZ + Stadt), Land, Email, Telefon ALLE Pflicht.
- Source-Priorität: Registry (gpsrManufacturers Firestore) > Web-Impressum-Scrape > Stage3-LLM.
- Placeholder-Reject: '-', 'N/A', 'unknown', 'Beispiel.com', '+49 000', 'Musterstraße' → leer lassen.

### Compliance (eBay Cassini — VERBINDLICH)
- Niemals Active Content: kein <script>, <iframe>, <object>, <embed>, <form>, javascript:-URL, kein Flash.
- Niemals Keyword-Spamming: Token-Density max 7%, kein Wort > 2 Wiederholungen.
- Niemals Duplicate-Strings: keine wörtlichen Wiederholungen.

### Identifier-Pflicht
- GTIN/EAN/MPN obligatorisch (Google-Shopping-Sichtbarkeit).
- Mod-10-Checksumme bei GTIN validieren.
- Identifier-Konflikte: GS1 > Manufacturer-Website > EAN-DB > OCR.
`;

const CASSINI_RULES_APPEND = `

CASSINI-PFLICHTREGELN (D.0b-Phase-F Cassini-Hardening — append):
- Title: max 80 chars, Brand+Modell in ersten 5 Wörtern, keine Sonderzeichen [& ! _ /], keine Bad-Prefixes [NEU/TOP/ANGEBOT/PREMIUM/ORIGINAL/RABATT].
- Description: 180-220 Wörter, Keyword-Density 5-7%, Bullet-Points für Benefits, schema.org/Product Mobile-Snippet.
- Aspects: ALLE Required befüllen (eBay-binäre-Sichtbarkeit), max 45 (eBay-Cap), 'Unbekannt' bei Unklarheit.
- GPSR: name + address + email + country + phone, kein Placeholder.
- Pricing: ≤30 Cent unter Median, Outlier-Schutz ±15%.
- Bilder: 800-1600 px, Hauptbild reiner weißer Hintergrund.
- Compliance: kein Active-Content, kein Keyword-Spamming, keine Duplicates.
- Output: Felder leer lassen wenn nicht belegbar (nie halluzinieren).
`;

(async () => {
  const scopeRef = firestore.collection('llmScopes').doc('identify.v2');
  const scopeSnap = await scopeRef.get();
  if (!scopeSnap.exists) { console.log('identify.v2 not found'); process.exit(1); }
  const scope = scopeSnap.data();
  const oldVersionSnap = await scopeRef.collection('versions').doc(scope.activeVersionId).get();
  const oldV = oldVersionSnap.data();

  console.log('Old version:', scope.activeVersionId);
  console.log('Old prompt length:', (oldV.promptText || '').length);

  const newPromptText = (oldV.promptText || '') + CASSINI_PROMPT_APPEND;
  const newRulesText = (oldV.rulesText || '') + CASSINI_RULES_APPEND;

  console.log('New prompt length:', newPromptText.length);
  console.log('New rules length:', newRulesText.length);

  if (process.argv.includes('--dry-run')) {
    console.log('[DRY-RUN] would create new version + activate. Use --apply.');
    process.exit(0);
  }

  if (!process.argv.includes('--apply')) {
    console.log('Use --dry-run or --apply.');
    process.exit(0);
  }

  // Create new version
  const newVersionRef = scopeRef.collection('versions').doc();
  await newVersionRef.set({
    promptMode: oldV.promptMode || 'append',
    rulesMode: oldV.rulesMode || 'append',
    note: 'D.0b-Phase-F Cassini-Hardening — eBay-Leitfaden-Regeln (80-char Title, 200-Wort Description, 5-7% Density, 9 Kategorie-Patterns, 45-Aspect-Cap, GPSR-Pflicht, Compliance). Append-Mode preserves existing prompt.',
    promptText: newPromptText,
    rulesText: newRulesText,
    createdByUid: 'd0b-phase-f-script',
    createdAt: new Date(),
  });
  console.log('New version created:', newVersionRef.id);

  // Activate new version
  await scopeRef.update({ activeVersionId: newVersionRef.id });
  console.log('Activated new version. identify.v2 now uses Cassini-Hardened prompt.');

  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
