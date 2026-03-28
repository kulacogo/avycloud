# Improve Feature: Gemini entfesseln — Claude Code Prompt

> **Ziel:** Nach `Improve` soll ein Produkt ein **fertiges eBay-Angebot** haben.
> Titel, Beschreibung, Highlights, Item Specifics, Mobile Snippet — alles Cassini-optimiert.
> **Methode:** Kontrolliert testen. Oguzhan markiert Artikel → klickt "Improve" → evaluiert Ergebnis.
> **Scope:** NUR `services/improve.js` + `lib/llm-policy-pack.js` + `lib/gemini3-client.js`. Keine neuen Services/Collections.

---

## SESSION START (PFLICHT — vor jeder Arbeit)

1. Lies `CLAUDE.md` im Root — enthält goldene Regeln, Architektur, Code-Stil, nicht-verhandelbare Punkte
2. Lies `TASKS.md` im Root — aktive Bugs + Feature-Status. Insbesondere:
   - **PERF-001** (Grounding Pipeline) ist bereits implementiert und wartet auf Deploy+Live-Test
   - **BUG-085** (Dual-Write Duplikate) + **BUG-090** (Gruppierung) warten auf Deploy
   - **BUG-086** (Improve langsam) ist bekannt — diese Änderungen dürfen die Performance NICHT verschlechtern
3. Lies dieses Dokument komplett
4. `cd backend && npm test && npm run build` — Baseline muss GRÜN sein bevor du anfängst

### Kontext: Aktuelle Codebase-Situation

- **Backend:** Node.js 20, Express, CommonJS, 2 Spaces, Single Quotes, async/await
- **DB:** Firestore, Collection `products_v2` (USE_PRODUCTS_V2=true)
- **KI:** Gemini 3 Pro (via `@google/genai` SDK) mit Google Search Grounding
- **Tests:** Vitest, `cd backend && npm test`. Aktuell 300+ Tests. require.cache-Patching statt vi.mock() (CJS)
- **Deploy:** `main` → Cloud Build (Backend) → Cloud Run (europe-west3)
- **PERF-001 ist implementiert:** `identifyProductWithGrounding()` existiert bereits in `gemini3-client.js` und wird in `improve.js` genutzt (Zeile 966-1084). Das ist die Funktion die wir ERWEITERN, nicht neu bauen.

### Bekannte Abhängigkeiten

- BUG-085/090/091 warten auf Backend-Deploy → nach Deploy + Cleanup werden die "Anker Anker" Doppel-Brand Issues verschwinden
- Diese Änderungen hier sind UNABHÄNGIG von den pending Deploys und können parallel gebaut werden
- Die Improve-Pipeline wird nach Deploy schneller (BUG-086 Optimierungen), aber die Logik-Änderungen hier sind davon unberührt

---

## ⚠️ REGELN (NICHT VERHANDELBAR — aus CLAUDE.md)

1. **Production darf NIEMALS negativ beeinflusst werden** — kein Breaking Change, kein Datenverlust, kein Downtime
2. **Keine neuen Routes, keine neuen Collections, keine neuen Services**
3. **Abwärtskompatibel**: Output-Format bleibt identisch. `saveProductV2()` wird exakt wie bisher aufgerufen.
4. **Alle bestehenden Tests müssen grün bleiben**: `cd backend && npm test`
5. **Alle Produkt-Writes über `saveProductV2()` (lib/product-store.js)**
6. **Alle neuen Queries/Collections mit `tenantId`**
7. **Kein Force-Push auf main, keine BaseLinker-Referenzen**
8. **Keine Firestore-Felder umbenennen/löschen (additive only)**
9. **Keine Dependencies entfernen**
10. **Keine ENV-Vars umbenennen die in CI/CD referenziert werden**
11. **Protected Zones**: `lib/auth.js`, `lib/rbac.js`, `Dockerfile`, `cloudbuild.yaml`, `firebase.json` → NICHT ANFASSEN
12. **Git:** Conventional Commits (`feat:`, `fix:`, `refactor:`), kein Force-Push auf main
13. **Jede neue Funktion braucht min. 1 Test**

---

## IST-Zustand (was heute passiert)

### Datei: `services/improve.js` → `improveExistingProduct(productId, onProgress)`

```
1. getProduct(productId)
2. eBay Listing Snapshot laden (bestehend, für Kontext)
3. Title Insights laden (Top-Tokens aus eBay Browse API für die Kategorie)
4. Reference Images herunterladen (max 4)
5. Barcodes sammeln
6. IF GROUNDING_ENABLED (default: true):
   → identifyProductWithGrounding() (gemini3-client.js)
   → Single Gemini 3 Call mit Google Search + Bilder + JSON Schema
   → Output: title_ebay, description_ebay, brand, item_specifics, etc.
7. mergeProductRecords(existing, improved) — kein Datenverlust
8. applyEbayTaxonomy() + applyKauflandTaxonomy()
9. coerceTitleToPolicy() — 80 Zeichen
10. enrichPriceViaEbayBrowseBestEffort()
11. Web-Bilder suchen (SerpAPI)
12. sanitizeDescriptionToHtml()
13. normalizeProductForPolicyApply() — Rulebook
14. evaluateEbayReady() — Quality Snapshot
15. saveProductV2()
```

### Problem: Der Grounding-Prompt (gemini3-client.js, Zeile 244-284)

Der Prompt ist ein **Generalist**. Er sagt:
- "Identifiziere das Produkt PRAEZISE"
- "Erstelle ein vollstaendiges, marketplace-ready Produktdatenblatt"
- "Titel: 70-80 Zeichen, kaeufergerecht"
- "Beschreibung: 180-240 Woerter"

Was er NICHT sagt:
- Keine Anweisung für **Synonym-Integration** (Cassini belohnt semantische Breite)
- Keine Anweisung für **Keyword-Dichte** (Leitfaden: 5-7%, 10-14 Nennungen)
- Keine Anweisung für **Benefits > Features** in Highlights
- Keine Anweisung für **Mobile Snippet** (800 Zeichen, Schema.org)
- Keine **Wettbewerber-Titel** als Referenz (Title Insights werden geladen aber nicht in den Grounding-Prompt übergeben!)
- Keine **kategorie-spezifische Titel-Strategie** (Fashion ≠ Elektronik ≠ Auto-Teile)
- Die Policy (`llm-policy-pack.js`) limitiert auf "2-3 primäre Suchbegriffe" — zu wenig

### Was GUT funktioniert (NICHT kaputt machen)

- Grounding mit Google Search → findet echte Produktdaten
- Image-basierte Identifikation → korrekte Marke/Modell
- Merge-Logik → kein Datenverlust
- Title-Policy Coercion → 80 Zeichen werden eingehalten
- eBay Taxonomy Mapping → Kategorie wird korrekt zugeordnet
- Price Enrichment → Marktpreis wird ermittelt

---

## SOLL-Zustand (was nach dem Umbau passiert)

### Neuer Flow in `improve.js`

```
1-5: Identisch wie bisher (Produkt laden, Bilder, Barcodes)

6. VERBESSERT: identifyProductWithGrounding()
   → Grounding-Prompt enthält jetzt:
     a) Wettbewerber-Titel als Referenz (aus Title Insights)
     b) Kategorie-spezifische Titel-Anweisung
     c) Anweisung für Synonym-Integration
     d) Anweisung für Benefits-Format in Highlights
     e) Keyword-Dichte-Ziel (5-7%)
     f) Mobile Snippet Feld (max 800 Zeichen)

7-8: Identisch (Merge + Taxonomy)

9. VERBESSERT: Title Coercion
   → Nutzt Kategorie-Template wenn verfügbar

10-12: Identisch (Preis, Bilder, Sanitize)

13. VERBESSERT: Rulebook
   → Keyword-Dichte-Check (Warn wenn <3% oder >10%)
   → Benefits-Check in Highlights (Warn wenn <50% im Benefits-Format)

14-15: Identisch (Quality Snapshot + Save)

NEU: mobileSnippet wird als Feld gespeichert (additiv, kein Breaking Change)
```

---

## ÄNDERUNG 1: Grounding-Prompt verbessern

### Datei: `backend/lib/gemini3-client.js`
### Funktion: `identifyProductWithGrounding()`

Der Prompt (Zeile 244-284) wird erweitert. **Wichtig:** Die bestehende Struktur (Barcodes, OCR, Recherche-Strategie) bleibt erhalten. Wir ERGÄNZEN die Qualitätsanforderungen.

#### Neuer Parameter: `improveContext`

Die Funktion bekommt einen optionalen Parameter `improveContext` der den bestehenden Kontext + Title Insights + Kategorie-Info enthält:

```javascript
async function identifyProductWithGrounding({
  imageParts = [],
  ocrText = '',
  barcodes = [],
  locale = 'de-DE',
  hint = null,
  improveContext = null, // NEU: { existingProduct, titleInsights, categoryTemplate }
} = {}) {
```

#### Prompt-Erweiterung

Nach dem bestehenden `QUALITAETSANFORDERUNGEN` Block (Zeile 268), VOR dem `WICHTIG` Block (Zeile 281), füge ein:

```
${improveContext ? buildImprovePromptExtension(improveContext) : ''}
```

Die Funktion `buildImprovePromptExtension` (in gemini3-client.js oder als Import):

```javascript
function buildImprovePromptExtension(ctx) {
  const lines = [];

  // Bestehende Produktdaten als Kontext
  if (ctx.existingProduct) {
    const p = ctx.existingProduct;
    lines.push('BESTEHENDE PRODUKTDATEN (verbessere diese, erfinde nichts Neues):');
    if (p.identification?.name) lines.push(`- Aktueller Titel: ${p.identification.name}`);
    if (p.identification?.brand) lines.push(`- Marke: ${p.identification.brand}`);
    if (p.details?.categoryPath) lines.push(`- Kategorie: ${p.details.categoryPath}`);
    if (p.details?.identifiers?.ean) lines.push(`- EAN: ${p.details.identifiers.ean}`);
    if (p.details?.identifiers?.mpn) lines.push(`- MPN: ${p.details.identifiers.mpn}`);
    lines.push('');
  }

  // Wettbewerber-Titel als Referenz
  if (ctx.titleInsights?.sampleTitles?.length) {
    lines.push('WETTBEWERBER-TITEL AUF EBAY (nutze als Referenz fuer Stil und Keywords):');
    ctx.titleInsights.sampleTitles.forEach(t => lines.push(`- ${t}`));
    lines.push('');
  }

  // Top Keywords der Kategorie
  if (ctx.titleInsights?.topTokens?.length) {
    lines.push(`TOP-KEYWORDS DIESER KATEGORIE AUF EBAY: ${ctx.titleInsights.topTokens.join(', ')}`);
    lines.push('Integriere relevante Keywords natuerlich in Titel und Beschreibung.');
    lines.push('');
  }

  // Cassini-Optimierungs-Anweisungen
  lines.push('CASSINI-OPTIMIERUNG (eBay Best-Match Algorithmus):');
  lines.push('- TITEL: Erste 3-5 Woerter sind CTR-kritisch (mobile Ansicht). Struktur: Marke + Produkttyp + Kernmerkmal.');
  lines.push('- TITEL: Nutze alle 80 Zeichen. Integriere Long-Tail-Keywords (z.B. "hoehenverstellbar elektrisch" statt nur "Schreibtisch").');
  lines.push('- TITEL: Studiere die Wettbewerber-Titel oben und uebernimm erfolgreiche Muster.');
  lines.push('- SYNONYME: Ergaenze in der Beschreibung Synonyme und semantische Variationen. Beispiel: "Schreibtisch" → auch "Arbeitstisch", "Buerotisch" erwaehnen.');
  lines.push('- KEYWORD-DICHTE: Verteile die wichtigsten 2-3 Suchbegriffe und ihre Synonyme so, dass sie insgesamt 10-14 Mal in der Beschreibung vorkommen (bei ~200 Woertern = 5-7% Dichte). Natuerlich einweben, KEIN Stuffing.');
  lines.push('- BESCHREIBUNG: ~200 Woerter. HTML: 1x <p> Einleitung (emotionaler Hook) + <ul> mit 5-7 Benefits + 1x <p> technische Details. Professionell und verkaufspsychologisch.');
  lines.push('- HIGHLIGHTS: Mindestens 50% der Bulletpoints im Benefits-Format: "[Kundennutzen] – [technische Spec]". SCHLECHT: "512GB SSD". GUT: "512GB SSD – genug Platz fuer Ihre gesamte Mediathek".');
  lines.push('- ITEM SPECIFICS: Alle Pflicht-UND-empfohlene Artikelmerkmale befuellen. Cassini macht Produkte in Filtern UNSICHTBAR wenn Merkmale fehlen.');
  lines.push('');

  // Mobile Snippet Anweisung
  lines.push('MOBILE SNIPPET (NEUES FELD — mobile_snippet):');
  lines.push('- Erstelle eine kompakte Kurzbeschreibung (max 800 Zeichen, plain text ohne HTML).');
  lines.push('- Diese wird als Schema.org itemprop="description" fuer die mobile eBay-Ansicht genutzt.');
  lines.push('- Muss die wichtigsten Kaufargumente und Keywords enthalten.');
  lines.push('- Kein Duplicate der Hauptbeschreibung, sondern eine eigenstaendige Zusammenfassung.');
  lines.push('');

  return lines.join('\n');
}
```

#### JSON Schema erweitern

In `FULL_PRODUCT_SCHEMA` (gemini3-client.js) ein neues Feld hinzufügen:

```javascript
// Im Schema neben description_ebay, description_kaufland etc.:
mobile_snippet: { type: 'STRING', description: 'Compact product summary for mobile eBay view, max 800 chars, plain text, no HTML' },
```

---

## ÄNDERUNG 2: Improve übergibt Kontext an Grounding

### Datei: `backend/services/improve.js`
### Funktion: `improveExistingProduct()`

Aktuell (Zeile 986-992):
```javascript
const groundedRecord = await identifyProductWithGrounding({
  imageParts,
  ocrText: '',
  barcodes,
  locale: product.locale || 'de-DE',
  hint: null,
});
```

**Ändern zu:**
```javascript
const groundedRecord = await identifyProductWithGrounding({
  imageParts,
  ocrText: '',
  barcodes,
  locale: product.locale || 'de-DE',
  hint: null,
  improveContext: {
    existingProduct: product,
    titleInsights: initialTitleInsights,
    categoryTemplate: null, // Phase 2: kategorie-spezifisch
  },
});
```

Die Variable `initialTitleInsights` existiert bereits (Zeile 940-945) und enthält `topTokens` + `sampleTitles`. Sie wird aktuell nur für den Legacy-Path genutzt (buildImproveContext), aber **NICHT** an den Grounding-Call übergeben. Das ist der zentrale Fix.

### Mobile Snippet speichern

Nach dem Merge (Zeile 1112), das mobileSnippet aus dem groundedRecord übernehmen:

```javascript
// Nach mergeProductRecords()
if (improvedOutput?.marketplace?.ebay?.mobile_snippet) {
  mergedProduct.marketplace = mergedProduct.marketplace || {};
  mergedProduct.marketplace.ebay = mergedProduct.marketplace.ebay || {};
  mergedProduct.marketplace.ebay.mobile_snippet = improvedOutput.marketplace.ebay.mobile_snippet;
}
```

Und im Mapping (Zeile 995-1025) das Feld aus groundedRecord mappen:

```javascript
marketplace: {
  ebay: {
    title: groundedRecord.title_ebay || '',
    description: groundedRecord.description_ebay || '',
    mobile_snippet: groundedRecord.mobile_snippet || '', // NEU
  },
  kaufland: { ... },
},
```

---

## ÄNDERUNG 3: Policy-Pack für Improve lockern

### Datei: `backend/lib/llm-policy-pack.js`

Das Problem: Zeile 67 sagt "2-3 primäre Suchbegriffe natürlich verwenden; kein Keyword-Stuffing."
Für Identify ist das richtig (Produkt erkennen = Fakten). Für Improve (Listing optimieren) ist es zu restriktiv.

**Lösung:** `buildCommonPolicyText()` bekommt einen `context` Parameter:

```javascript
function buildCommonPolicyText({ locale = 'de-DE', allowWebEvidence = false, context = 'identify' } = {}) {
```

Wenn `context === 'improve'` oder `context === 'listing'`:
- Zeile 67 ("2-3 primäre Suchbegriffe") → wird zu:
  "Primäre Keywords und relevante Synonyme natürlich in Titel und Beschreibung verwenden. Ziel: 5-7% Keyword-Dichte in der Beschreibung (~10-14 Nennungen bei 200 Wörtern). Kein Keyword-Stuffing (>10%)."
- Zeile 107 ("ergänze relevante Synonyme/Long-Tail-Varianten nur, wenn sie zum konkreten Produkt belegbar passen") → wird zu:
  "Ergänze aktiv Synonyme, Long-Tail-Varianten und kategorie-typische Suchbegriffe. Du darfst dein Wissen über eBay-Suchverhalten nutzen. Erfinde keine Produktfakten (Maße, Material, Specs bleiben faktenbasiert)."

**Implementierung:**

```javascript
// In buildCommonPolicyText(), ersetze die fixen Keyword-Zeilen durch:
const keywordRule = (context === 'improve' || context === 'listing')
  ? '- Keyword-Governance: Primaere Keywords und relevante Synonyme natuerlich in Titel und Beschreibung verwenden. Ziel-Keyword-Dichte in Beschreibung: 5-7% (~10-14 Nennungen bei 200 Woertern). Kein Stuffing (>10%).'
  : '- Keyword-Governance: 2-3 primaere Suchbegriffe natuerlich verwenden; kein Keyword-Stuffing oder Keyword-Ketten.';

const synonymRule = (context === 'improve' || context === 'listing')
  ? '- Beschreibung: Ergaenze aktiv Synonyme und Long-Tail-Varianten (z.B. "Schreibtisch" + "Arbeitstisch" + "Buerotisch"). Du darfst dein Wissen ueber eBay-Suchverhalten nutzen. Produktfakten (Masse, Material, Specs) muessen belegbar sein.'
  : '- Beschreibung: ergaenze relevante Synonyme/Long-Tail-Varianten nur, wenn sie zum konkreten Produkt belegbar passen.';
```

### Wo wird `context: 'improve'` gesetzt?

In `services/improve.js`, überall wo `buildCommonPolicyText` aufgerufen wird (direkt oder indirekt über enrichment.js):

Der Grounding-Call in `gemini3-client.js` nutzt `buildCommonPolicyText` NICHT direkt — der Prompt ist inline. Die Policy wird nur vom Legacy-Pfad (runDatasheetReview) genutzt.

**Aber:** Die Policy beeinflusst den Rulebook-Check (`normalizeProductForPolicyApply`). Da müssen wir nichts ändern — der Rulebook ist deterministisch und prüft Längen/Formate, nicht Keyword-Dichte. Die Keyword-Dichte kommt als NEUER Check dazu (siehe Änderung 4).

---

## ÄNDERUNG 4: Keyword-Dichte und Benefits-Check im Rulebook

### Datei: `backend/lib/llm-rulebook.js`

Ergänze zwei neue Warn-Level Checks (KEIN Error, nur Warn — blockiert nichts):

```javascript
// Am Ende von normalizeProductForPolicyApply(), VOR return:

// Keyword-Density Check (warn only)
try {
  const desc = product?.details?.short_description || '';
  const title = product?.identification?.name || '';
  const brand = product?.identification?.brand || '';
  if (desc && title) {
    const visibleText = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const words = visibleText.split(/\s+/).filter(Boolean);
    if (words.length >= 50) { // Only check if description is substantial
      const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const brandLower = brand.toLowerCase();
      const searchTerms = titleWords.filter(w => w !== brandLower);
      const textLower = visibleText.toLowerCase();
      let keywordHits = 0;
      for (const term of searchTerms) {
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        keywordHits += (textLower.match(regex) || []).length;
      }
      const density = keywordHits / words.length;
      if (density < 0.03) {
        issues.push(`Keyword-Dichte niedrig (${(density * 100).toFixed(1)}%). Empfohlen: 5-7% fuer eBay Cassini.`);
      }
    }
  }
} catch { /* best-effort */ }

// Benefits-Format Check (warn only)
try {
  const highlights = product?.details?.key_features || [];
  if (highlights.length >= 3) {
    const benefitIndicators = [' – ', ' — ', ' - ', ' fuer ', ' damit ', ' dank ', ' sorgt ', ' ermoeglicht ', ' bietet '];
    const benefitCount = highlights.filter(h =>
      typeof h === 'string' && benefitIndicators.some(ind => h.toLowerCase().includes(ind))
    ).length;
    if (benefitCount < Math.ceil(highlights.length * 0.4)) {
      issues.push(`Nur ${benefitCount}/${highlights.length} Highlights im Benefits-Format. Empfohlen: mindestens 50%.`);
    }
  }
} catch { /* best-effort */ }
```

**Wichtig:** Diese Checks sind `issues.push()` (Warn), NICHT `errors.push()`. Sie blockieren NICHTS. Sie erscheinen nur in `ops.data_quality.rulebook_apply_v1.issues` und `notes.warnings` — so kann Oguzhan in der UI sehen, wo noch Potenzial ist.

---

## ÄNDERUNG 5: Mobile Snippet in Description einbetten

### Datei: `backend/services/improve.js`

Nach der Description-Sanitization (Zeile 1230-1235), VOR dem Rulebook-Apply:

```javascript
// Mobile Snippet als Schema.org Markup in die Description einbetten
try {
  const mobileSnippet = mergedProduct?.marketplace?.ebay?.mobile_snippet || '';
  const description = mergedProduct?.details?.short_description || '';
  if (mobileSnippet && description && !description.includes('itemprop="description"')) {
    const schemaDiv = `<div vocab="https://schema.org/" typeof="Product"><span property="description">${mobileSnippet.replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 800)}</span></div>`;
    mergedProduct.details.short_description = schemaDiv + '\n' + description;
  }
} catch { /* best-effort */ }
```

---

## TESTING

### Bestehende Tests

```bash
cd backend && npm test
```

Alle bestehenden Tests MÜSSEN grün bleiben. Die Änderungen sind:
- `identifyProductWithGrounding()` → neuer optionaler Parameter → abwärtskompatibel
- `buildCommonPolicyText()` → neuer optionaler Parameter → abwärtskompatibel (Default: 'identify')
- `normalizeProductForPolicyApply()` → neue Warn-Checks → blockieren nichts
- `improve.js` → selber Output, nur besserer Input an Gemini

### Neue Tests

Datei: `backend/__tests__/improve-unleash.test.js`

```javascript
// Test 1: identifyProductWithGrounding akzeptiert improveContext
// Test 2: buildImprovePromptExtension generiert Prompt mit Title Insights
// Test 3: buildImprovePromptExtension ohne Daten → leerer String
// Test 4: mobile_snippet wird aus groundedRecord gemappt
// Test 5: mobile_snippet wird als Schema.org in Description eingebettet
// Test 6: Keyword-Density-Check erkennt niedrige Dichte (Warn, kein Error)
// Test 7: Benefits-Check erkennt fehlende Benefits (Warn, kein Error)
// Test 8: buildCommonPolicyText mit context='improve' hat erweiterte Keyword-Regeln
// Test 9: buildCommonPolicyText ohne context (Default) behält bisheriges Verhalten
```

---

## BUILD-REIHENFOLGE

```
Schritt 0: CLAUDE.md lesen, TASKS.md lesen, npm test + npm run build → Baseline GRÜN
Schritt 1: FULL_PRODUCT_SCHEMA in gemini3-client.js erweitern (mobile_snippet Feld)
Schritt 2: buildImprovePromptExtension() Funktion in gemini3-client.js schreiben
Schritt 3: identifyProductWithGrounding() um improveContext Parameter erweitern
Schritt 4: improve.js — initialTitleInsights an Grounding-Call übergeben
Schritt 5: improve.js — mobile_snippet aus groundedRecord mappen + speichern
Schritt 6: improve.js — Schema.org Markup in Description einbetten
Schritt 7: llm-policy-pack.js — context Parameter für Keyword-Regeln
Schritt 8: llm-rulebook.js — Keyword-Dichte + Benefits Warn-Checks
Schritt 9: Tests schreiben (backend/__tests__/improve-unleash.test.js)
Schritt 10: cd backend && npm test && npm run build → MUSS GRÜN sein
Schritt 11: git add + Conventional Commit (feat: unleash gemini in improve pipeline)
```

### Referenz-Dokumente (für Kontext, nicht zwingend zu lesen)

- `Strategischer eBay Leitfaden.md` (Root) — Cassini-Algorithmus, Titel-Architektur, Keyword-Dichte, Kategorie-Templates
- `docs/prompts/ebay-masterplan-listing-excellence.md` — Langfrist-Roadmap (Phase 2-4 kommen später)
- `docs/prompts/perf-001-identify-pipeline-overhaul.md` — Grounding-Pipeline Doku (bereits implementiert)

---

## WAS SICH FÜR DEN USER ÄNDERT

**Vorher:** Improve generiert korrekte aber generische Produktdaten.
**Nachher:** Improve generiert eBay-optimierte Listings mit:
- Titel die Wettbewerber-Keywords integrieren
- Beschreibungen mit 5-7% Keyword-Dichte und Synonym-Integration
- Highlights im Benefits-Format ("Nutzen – Spec")
- Mobile Snippet für Schema.org
- Warnings wenn Keyword-Dichte oder Benefits-Format zu niedrig

**Was sich NICHT ändert:**
- Kein neues UI nötig
- Kein neuer API-Endpoint
- Kein neues Firestore-Schema (nur additive Felder)
- Bestehende Improve-Logik bleibt intakt (Merge, Taxonomy, Preis, etc.)
- Bulk-Improve funktioniert identisch (selbe Funktion)

---

## RISIKEN & MITIGATIONEN

| Risiko | Mitigation |
|--------|-----------|
| Gemini-Prompt wird zu lang | improveContext ist optional, nur bei Improve übergeben. Identify bleibt schlank. |
| Title Insights haben schlechte Daten | Werden nur als "Referenz" präsentiert, Gemini entscheidet selbst. |
| Keyword-Dichte-Check false positives | Ist nur Warn, blockiert nichts. Threshold konservativ (3%). |
| Mobile Snippet Qualität unklar | Neues Feld, additiv. Kann ignoriert werden wenn schlecht. |
| Schema.org Markup bricht eBay | Wird escaped, nur eingebettet wenn description vorhanden. eBay supportet Schema.org offiziell. |
