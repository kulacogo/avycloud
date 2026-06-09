# FIX: LLM Pipeline Qualität — Identify + Review + Improve

> Schwere: **P0** — Produkte bekommen unvollständige/falsche Datenblätter
> Betrifft: `services/enrichment.js`, `services/improve.js`, `lib/datasheet-quality.js`

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

FIX P0: Die LLM-Pipeline (Identify → Review → Improve) produziert unvollständige
und fehlerhafte Produkt-Datenblätter. 5 konkrete Probleme müssen behoben werden.

---

## PROBLEM 1: Quality Gate ist deaktiviert

Datei: lib/datasheet-quality.js

Die Quality Gate ist per Default DEAKTIVIERT. Jedes Produkt bekommt `ok: true`
egal wie schlecht die Daten sind:

```javascript
const gateEnabled = enabled === '1' || enabled === 'true' || enabled === 'yes';
if (!gateEnabled && !force) {
  return { ok: true, issues: [], snapshot: { ... } };
}
```

### Fix:

Quality Gate DEFAULT AKTIVIEREN. Umkehren der Logik:

```javascript
// Gate ist aktiv AUSSER es wird explizit deaktiviert
const gateDisabled = enabled === '0' || enabled === 'false' || enabled === 'no';
if (gateDisabled && !force) {
  return { ok: true, issues: [], snapshot: { ... } };
}
```

Dann: Folgende PFLICHT-Checks müssen IMMER laufen (auch bei deaktivierter Gate):
- Titel vorhanden und >= 15 Zeichen
- Brand vorhanden und nicht leer
- Beschreibung vorhanden und >= 100 Zeichen
- Mindestens 3 Attribute
- Mindestens 1 Bild-URL

Wenn diese Minimum-Checks fehlschlagen: `sync_status: 'review_required'` setzen
statt `synced`. Das Produkt wird gespeichert aber NICHT automatisch gelistet.

---

## PROBLEM 2: Review-Fehler werden verschluckt

Datei: services/enrichment.js, Zeile ~2175-2183

```javascript
} catch (error) {
  console.warn(`Datasheet review failed for product ${product?.id}:`, error?.message);
  // NICHTS PASSIERT — Produkt bleibt mit kaputten Identify-Daten
}
```

### Fix:

Bei Review-Fehler: Produkt als `review_required` markieren UND Retry einbauen.

```javascript
} catch (error) {
  console.error(`[REVIEW FAILED] Product ${product?.id}:`, error?.message);

  // Retry einmal mit vereinfachtem Prompt
  try {
    const retryResult = await runDatasheetReviewSimplified(product, evidence);
    if (retryResult) {
      applyReviewResult(product, retryResult);
      console.log(`[REVIEW RETRY OK] Product ${product?.id}`);
      return;
    }
  } catch (retryError) {
    console.error(`[REVIEW RETRY FAILED] Product ${product?.id}:`, retryError?.message);
  }

  // Beide Versuche gescheitert → als review_required markieren
  if (product.ops) {
    product.ops.sync_status = 'review_required';
    product.ops.review_reason = `Datasheet review failed: ${error?.message || 'unknown'}`;
    product.ops.review_failed_at = new Date().toISOString();
  }
}
```

Die `runDatasheetReviewSimplified()` Funktion ist eine abgespeckte Version von
`runDatasheetReview()` mit:
- Weniger strenger Schema (minItems: 3 statt 10 für Attribute, minItems: 3 statt 5 für Highlights)
- Kürzerem Prompt (nur Kernfelder: Titel, Brand, Beschreibung, Gewicht, Top-5-Attribute)
- Kein Marketplace-Evidence (reduziert externe Abhängigkeiten)

---

## PROBLEM 3: Schema gleichzeitig zu streng und zu lasch

Datei: services/enrichment.js — DATASHEET_REVIEW_SCHEMA (~Zeile 1465)

A) ZU STRENG: `minItems: 10` für Attribute → Review scheitert bei 9 → silent catch
B) ZU LASCH: Name/Brand erlauben leere Strings (minLength: 0)

### Fix A — Schema-Grenzen lockern:

```javascript
// attributes: minItems von 10 auf 5 reduzieren
attributes: { type: 'array', minItems: 5, maxItems: 40, ... }

// highlights: minItems von 5 auf 3 reduzieren
highlights: { type: 'array', minItems: 3, maxItems: 7, ... }
```

### Fix B — Pflichtfelder erzwingen:

```javascript
// identification
name: { type: 'string', minLength: 5 },        // War: minLength: 0
brand: { type: 'string', minLength: 1 },        // War: minLength: 0
category: { type: 'string', minLength: 3 },     // War: minLength: 0

// details
short_description: { type: 'string', minLength: 50 },  // War: minLength: 0
```

### Fix C — Weight Validation:

```javascript
weight_grams: {
  type: ['integer', 'null'],
  minimum: 1,          // War: 0 (0g Produkte gibt es nicht)
  maximum: 500000,     // War: 5000000 (500kg max statt 5000kg)
}
```

---

## PROBLEM 4: Improve scheitert kaskadierend still

Datei: services/improve.js, Zeile ~936-1070

Drei hintereinander geschaltete try/catch Blöcke die alle nur console.warn machen:
1. Identify fails → logs warning → continues
2. Review fails → logs warning → continues
3. Post-review eval fails → logs warning → continues

Ergebnis: Produkt wird trotzdem gespeichert, mit den Daten die zufällig geklappt haben.

### Fix:

Erfolgstracking einführen. Am Ende prüfen ob MINDESTENS Identify ODER Review
erfolgreich war:

```javascript
let identifyOk = false;
let reviewOk = false;

try {
  // ... Identify ...
  identifyOk = true;
} catch (error) {
  console.error(`[IMPROVE] Identify failed for ${productId}:`, error.message);
}

try {
  // ... Review ...
  reviewOk = true;
} catch (error) {
  console.error(`[IMPROVE] Review failed for ${productId}:`, error.message);
}

// Mindestens EINER muss geklappt haben
if (!identifyOk && !reviewOk) {
  product.ops = product.ops || {};
  product.ops.sync_status = 'improve_failed';
  product.ops.improve_error = 'Weder Identify noch Review waren erfolgreich';
  product.ops.improve_failed_at = new Date().toISOString();
  // Trotzdem speichern — aber mit klarem Failed-Status
}
```

---

## PROBLEM 5: Kein Retry bei Gemini-Fehler

Datei: services/enrichment.js — runProductIdentification() (~Zeile 2913)
und runDatasheetReview() (~Zeile 1905)

Wenn Gemini einen Fehler wirft (Rate Limit, Timeout, Schema-Mismatch),
gibt es KEINEN Retry. Das Produkt wird sofort als gescheitert markiert.

### Fix: Retry-Wrapper für Gemini Calls

Neue Utility-Funktion in lib/gemini-retry.js:

```javascript
async function callGeminiWithRetry(fn, { maxRetries = 2, delayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error?.status === 429 ||         // Rate limit
        error?.status === 503 ||         // Service unavailable
        error?.message?.includes('timeout') ||
        error?.message?.includes('DEADLINE_EXCEEDED') ||
        error?.message?.includes('schema');  // Schema validation retry

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const wait = delayMs * Math.pow(2, attempt); // Exponential backoff
      console.warn(`[GEMINI RETRY] Attempt ${attempt + 1}/${maxRetries}, waiting ${wait}ms: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

module.exports = { callGeminiWithRetry };
```

Dann in runProductIdentification() und runDatasheetReview() wrappen:

```javascript
const { callGeminiWithRetry } = require('../lib/gemini-retry');

// In runProductIdentification:
const response = await callGeminiWithRetry(
  () => model.generateContent({ contents, generationConfig, ... }),
  { maxRetries: 2, delayMs: 3000 }
);

// In runDatasheetReview:
const response = await callGeminiWithRetry(
  () => model.generateContent({ contents, generationConfig, ... }),
  { maxRetries: 1, delayMs: 2000 }
);
```

---

## PROBLEM 6: Evidence-Hierarchie fehlt — LLM halluziniert aus Bildern

Datei: services/enrichment.js — buildSystemPrompt() (~Zeile 646) und buildReviewPrompt() (~Zeile 1531)

KONKRETES BEISPIEL:
- Produkt: 288 FlaggenPins für Weltkarte von MagicHolz (EAN 4262551260005)
- LLM-Titel: "Deutschland Flaggen Länder Pin Anstecker Pins Flagge Metall"
- LLM hat eine Deutschland-Flagge auf dem Bild gesehen und daraus den Produktnamen abgeleitet
- Brand "MagicHolz" wurde zu "MaHo" verstümmelt
- Die EAN-Suche hätte sofort den richtigen Titel geliefert

### Fix — Evidence-Hierarchie im Prompt erzwingen:

In buildSystemPrompt() und buildReviewPrompt() folgende STRIKTE REGEL einfügen:

```
EVIDENCE-HIERARCHIE (PFLICHT, in dieser Reihenfolge):

1. BARCODE/EAN-SUCHE → Höchste Priorität
   Wenn eine Barcode-Suche ein Ergebnis liefert (Produktname, Brand, Hersteller):
   → DIESEN Titel und Brand als PRIMÄRQUELLE verwenden
   → Bilder dienen NUR zur Ergänzung von Details (Farbe, Maße, Zustand)
   → NIEMALS den Barcode-Titel mit eigenen Interpretationen überschreiben

2. OCR-TEXT auf Verpackung → Zweithöchste Priorität
   Text der direkt auf dem Produkt/Verpackung lesbar ist

3. WEB-EVIDENCE (Marketplace-Snippets) → Dritthöchste Priorität
   Titel von eBay/Amazon/Google Shopping Ergebnissen

4. BILD-ANALYSE → Niedrigste Priorität für Titel/Brand
   Bilder sind NICHT die Primärquelle für den Produktnamen!
   Bilder liefern: Farbe, Zustand, Material-Erkennung, Mengenangaben
   Bilder liefern NICHT: Produktname, Brand, Kategorie

ANTI-PATTERN (VERBOTEN):
- Ein einzelnes Element auf einem Bild sehen und daraus den Produktnamen ableiten
  (z.B. Deutschland-Flagge sehen → "Deutschland Pin" als Titel → FALSCH wenn es ein 288er-Set ist)
- Brand aus dem Bild raten wenn EAN-Daten einen anderen Brand liefern
- Einen generischen Titel erstellen wenn spezifische Barcode-Daten vorliegen
```

Diese Regel muss SOWOHL im Identify-Prompt ALS AUCH im Review-Prompt stehen.
Im Chat-Prompt (GPT Assistant / KI-Assistent) ebenfalls.

### Fix — Brand-Validierung:

Zusätzlich in der Post-Processing Logik (nach Gemini-Response):

```javascript
// Wenn Barcode-Insights einen Brand liefern UND der LLM-Brand davon abweicht:
if (barcodeInsights?.brand && result.identification?.brand) {
  const barcodeNorm = barcodeInsights.brand.toLowerCase().trim();
  const llmNorm = result.identification.brand.toLowerCase().trim();
  if (barcodeNorm !== llmNorm && !barcodeNorm.includes(llmNorm) && !llmNorm.includes(barcodeNorm)) {
    console.warn(`[BRAND MISMATCH] Barcode says "${barcodeInsights.brand}", LLM says "${result.identification.brand}" → using barcode`);
    result.identification.brand = barcodeInsights.brand;
  }
}
```

---

## PROBLEM 7: Prompt-Qualität für Gewicht

Datei: services/enrichment.js, Zeile ~1557 (Review-Prompt) und ~1637 (Identify-Prompt)

Gewichtsschätzungen sind unrealistisch weil der Prompt zu vage ist.

### Fix — Gewichts-Prompt verschärfen:

Im Review-Prompt (DATASHEET_REVIEW_SCHEMA instructions) ersetzen:

ALT:
"realistisch schätzen basierend auf Produkttyp, Material und Kategorie"

NEU:
"GEWICHT (weight_grams) — STRIKTE REGELN:
1. Wenn im Titel oder in der Beschreibung ein Gewicht steht → DIESES verwenden
2. Wenn auf den Bildern ein Gewicht sichtbar ist → DIESES verwenden
3. NUR wenn kein Gewicht belegbar ist: Schätzung basierend auf:
   - Kategorie + typisches Gewicht (z.B. T-Shirt: 150-250g, Sneaker: 300-500g)
   - Material (Metall schwerer als Kunststoff)
   - Maße wenn verfügbar
4. NIEMALS 0g oder null wenn Produkt physisch existiert
5. Gewicht IMMER in Gramm, ganzzahlig
6. Bei Unsicherheit: lieber konservativ (leichter) schätzen"

---

## PROBLEM 8: Preis-Enrichment komplett tot — 6 Quellen vorhanden, ALLE deaktiviert

### Bestandsaufnahme — was GEBAUT ist aber nicht läuft:

| Quelle | Datei | Blocker |
|--------|-------|---------|
| Google Shopping | enrichment.js:2828 via SerpAPI | SERPAPI_ENABLED=false |
| Bing Shopping | enrichment.js:2731 via SerpAPI | SERPAPI_ENABLED=false |
| Amazon | enrichment.js:2732 via SerpAPI | SERPAPI_ENABLED=false |
| eBay Browse API | improve.js:104 direkt | min 3 Samples (Zeile 130) |
| eBay + Kaufland | lib/competitor-prices.js | COMPETITOR_REFRESH_ENABLED=false |
| Pricing Engine Tier 3 | pricing-engine.js:7 LLM | Stub, nicht implementiert |

PLUS: `ensurePriceCoverage()` (enrichment.js:2755) hat 2 Kill-Switches:

```javascript
const PRICE_ENRICH = (process.env.PRICE_ENRICHMENT_ENABLED || '').toLowerCase() === 'true';
if (!PRICE_ENRICH) return;  // ← EXIT 1 — ALLES stirbt hier
const SERPAPI_ENABLED = (process.env.SERPAPI_ENABLED || '').toLowerCase() === 'true';
if (!SERPAPI_ENABLED) return;  // ← EXIT 2
```

### Fix A — ensurePriceCoverage wird zur Multi-Source Preis-Kaskade:

Kill-Switches entfernen. Die Funktion läuft IMMER. Quellen werden kaskadiert
mit abnehmender Confidence. Wenn eine Quelle liefert → fertig, nächstes Produkt.

```javascript
async function ensurePriceCoverage(products = [], serpTrace = [], options = {}) {
  if (!Array.isArray(products) || !products.length) return;

  const SERPAPI_ON = (process.env.SERPAPI_ENABLED || '').toLowerCase() === 'true';

  for (const product of products) {
    const lowest = product?.details?.pricing?.lowest_price;
    const hasPrice = lowest && typeof lowest.amount === 'number' && lowest.amount > 0;
    if (hasPrice && !options.force) continue;

    let found = false;

    // ── Stufe 1: Competitor Prices (eBay Browse + Kaufland) ──────────
    // Nutzt getCompetitorPrices() aus lib/competitor-prices.js
    // Vorteil: Zwei Marktplätze, direkte API, kein SerpAPI-Kosten
    if (!found) {
      try {
        const ean = pickBestEan(product);
        if (ean) {
          const { getCompetitorPrices } = require('../lib/competitor-prices');
          const result = await getCompetitorPrices(ean);
          const allPrices = [...(result.ebay || []), ...(result.kaufland || [])]
            .filter(c => typeof c.price === 'number' && c.price >= 1)
            .map(c => c.price);
          if (allPrices.length >= 1) {
            const med = median(allPrices);
            const sources = [...(result.ebay || []), ...(result.kaufland || [])]
              .filter(c => c.price && c.url)
              .slice(0, 6)
              .map(c => ({ name: c.marketplace, url: c.url, price: c.price, checked_at: new Date().toISOString() }));
            product.details = product.details || {};
            product.details.pricing = product.details.pricing || {};
            product.details.pricing.lowest_price = {
              amount: med, currency: 'EUR', sources, last_checked_iso: new Date().toISOString()
            };
            product.details.pricing.price_confidence = allPrices.length >= 3 ? 0.85 : 0.5;
            product.details.pricing.price_source = 'competitor_api';
            found = true;
          }
        }
      } catch (e) {
        console.warn(`[PRICE] Competitor API failed for ${product.id}: ${e.message}`);
      }
    }

    // ── Stufe 2: SerpAPI (Google Shopping + Bing + Amazon) ───────────
    // Breite Marktabdeckung, aber kostet pro Request
    if (!found && SERPAPI_ON) {
      try {
        // ... bestehende SerpAPI Logik aus ensurePriceCoverage ...
        // Google Shopping, Bing Shopping, Amazon Kaskade
      } catch (e) {
        console.warn(`[PRICE] SerpAPI failed for ${product.id}: ${e.message}`);
      }
    }

    // ── Stufe 3: eBay Browse API solo (Fallback) ────────────────────
    // Wenn Competitor-API keinen Treffer hatte (z.B. kein EAN)
    if (!found) {
      try {
        const { enrichPriceViaEbayBrowseBestEffort } = require('./improve');
        const browseResult = await enrichPriceViaEbayBrowseBestEffort(product, { force: true });
        if (browseResult.ok && browseResult.updated) {
          product.details.pricing.price_source = 'ebay_browse';
          found = true;
        }
      } catch (e) {
        console.warn(`[PRICE] eBay Browse failed for ${product.id}: ${e.message}`);
      }
    }

    // ── Stufe 4: Gemini-Preisschätzung (letzter Fallback) ───────────
    // Wenn KEINE Marktdaten → LLM schätzt anhand Produktdaten + Kategorie
    if (!found) {
      try {
        const estimatedPrice = await estimatePriceViaGemini(product);
        if (estimatedPrice && estimatedPrice.amount > 0) {
          product.details = product.details || {};
          product.details.pricing = product.details.pricing || {};
          product.details.pricing.lowest_price = {
            amount: estimatedPrice.amount,
            currency: 'EUR',
            sources: [{ name: 'gemini_estimate', url: null, price: estimatedPrice.amount, checked_at: new Date().toISOString() }],
            last_checked_iso: new Date().toISOString()
          };
          product.details.pricing.price_confidence = 0.25;
          product.details.pricing.price_source = 'llm_estimate';
          found = true;
        }
      } catch (e) {
        console.warn(`[PRICE] Gemini estimate failed for ${product.id}: ${e.message}`);
      }
    }

    if (!found) {
      product.details = product.details || {};
      product.details.pricing = product.details.pricing || {};
      product.details.pricing.price_confidence = 0;
      product.details.pricing.price_source = 'none';
    }
  }
}
```

### Fix B — eBay Browse API Minimum-Samples senken:

Datei: services/improve.js, Zeile 130

```javascript
// VORHER: 3 Samples nötig — bei Nischenprodukten unmöglich
if (eur.length < 3) return { ok: false, updated: false, error: 'too_few_samples' };
```

Ändern auf:
```javascript
if (eur.length < 1) return { ok: false, updated: false, error: 'no_samples' };
```

Bei nur 1-2 Samples: `price_confidence: 0.3` statt 0.7 setzen.

### Fix C — Neue Funktion: estimatePriceViaGemini()

Neues Modul: `lib/price-estimation.js`

Wenn KEINE Marktdaten verfügbar sind, schätzt Gemini den Preis basierend auf:
- Produktkategorie + Brand + Zustand
- Ähnliche Produkte im eigenen Bestand (Firestore Query nach Kategorie)
- Allgemeinwissen des LLM

```javascript
async function estimatePriceViaGemini(product) {
  const { callGemini } = require('./gemini-client');
  const brand = product?.identification?.brand || 'unbekannt';
  const title = product?.identification?.name || '';
  const category = product?.identification?.category || '';
  const condition = product?.details?.attributes?.condition || 'Neu';

  const prompt = `Du bist ein Preisexperte für den deutschen Markt.
Schätze den aktuellen Marktpreis (Neuware, EUR) für:
- Produkt: ${title}
- Marke: ${brand}
- Kategorie: ${category}
- Zustand: ${condition}

Antworte NUR mit einer JSON-Zeile: {"amount": <Zahl>, "reasoning": "<kurz>"}
Wenn du keine sinnvolle Schätzung machen kannst, antworte: {"amount": 0, "reasoning": "insufficient_data"}`;

  const response = await callGemini(prompt, { temperature: 0.1 });
  const parsed = JSON.parse(response);
  if (parsed.amount > 0) return { amount: parsed.amount, reasoning: parsed.reasoning };
  return null;
}
```

### Fix D — Competitor Prices in Identify-Pipeline einbinden:

`lib/competitor-prices.js` hat bereits `getCompetitorPrices(ean)` mit eBay Browse
UND Kaufland API. Aktuell wird das NUR vom `competitor-refresh-runner.js` genutzt
(der auch disabled ist: `COMPETITOR_REFRESH_ENABLED=false`).

→ `ensurePriceCoverage()` soll `getCompetitorPrices()` als ERSTE Stufe nutzen.
Kein neuer ENV-Flag nötig — die APIs (eBay Browse + Kaufland) haben eigene Auth
die bereits konfiguriert ist.

### Fix E — Import-Pfade:

`enrichPriceViaEbayBrowseBestEffort` lebt in improve.js.
`getCompetitorPrices` lebt in lib/competitor-prices.js.
Beide müssen in enrichment.js importiert werden:

```javascript
const { getCompetitorPrices } = require('../lib/competitor-prices');
const { enrichPriceViaEbayBrowseBestEffort } = require('./improve');
```

Prüfe auf zirkuläre Imports! Wenn nötig, extrahiere die Preis-Funktionen
in ein eigenes `lib/price-enrichment.js`.

---

## Tests

1. Neuer Test: `__tests__/services/enrichment-retry.test.js`
   - Test callGeminiWithRetry: Retries bei 429, gibt auf bei 400
   - Test runDatasheetReview: Bei Fehler → sync_status = 'review_required'

2. Neuer Test: `__tests__/lib/datasheet-quality.test.js`
   - Test: Quality Gate ist default AN
   - Test: Produkt ohne Titel → `ok: false`
   - Test: Produkt mit leerem Brand → `ok: false`

3. Bestehende Tests: `npm test` muss passen

4. `npm run build` — keine Fehler

5. TASKS.md aktualisieren

---

## Zusammenfassung der Änderungen

| Problem | Datei | Fix |
|---------|-------|-----|
| Quality Gate deaktiviert | lib/datasheet-quality.js | Default AN, Minimum-Checks immer aktiv |
| Review silent catch | services/enrichment.js:2175 | Retry + review_required Status |
| Schema zu streng/lasch | services/enrichment.js:1465 | minItems lockern, minLength verschärfen |
| Improve kaskadiert still | services/improve.js:936 | Erfolgstracking, failed-Status |
| Kein Retry | NEU: lib/gemini-retry.js | Exponential backoff, 2 Retries |
| Evidence-Hierarchie fehlt | services/enrichment.js Prompts | Barcode > OCR > Web > Bild |
| Gewicht unrealistisch | services/enrichment.js Prompts | Strikte Gewichts-Regeln |
| Preis-Enrichment tot | services/enrichment.js:2755 | Kill-Switches weg, 4-Stufen-Kaskade: Competitor API → SerpAPI → eBay Browse → Gemini-Schätzung |
| Gewicht unrealistisch | services/enrichment.js:1557 | Strengerer Gewichts-Prompt |
```
