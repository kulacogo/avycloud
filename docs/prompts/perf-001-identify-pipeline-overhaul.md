# PERF-001: Identify Pipeline Overhaul — Sub-60s, Qualität wie Cowork

## Executive Summary

Die Identify-Pipeline wird von 10 sequenziellen Steps mit selbstgebauter Web-Suche
auf **1 Gemini-Call mit Google Search Grounding + Structured Output + Bildern** umgebaut.

Das ist der gleiche Ansatz den Cowork nutzt: Bilder sehen + im Web recherchieren +
strukturiertes Datenblatt — alles in einem Durchgang.

**Aktuell:** 125-270s, 2 Gemini-Calls (keiner hat beides: Bilder UND Web-Daten), oft Timeout
**Neu:** 30-60s, 1 Gemini-Call hat ALLES (Bilder + Google Search + Structured Output)

## Root Cause: Warum die Qualität nicht stimmt

### Problem 1: Zwei getrennte Gemini-Calls
- Call 1 (`generateStructuredProductRecord` in generative-identify.js): Sieht NUR Bilder + OCR. Kein Web-Wissen.
- Call 2 (`runDatasheetReview` in enrichment.js): Sieht NUR das Rohskelett + Web-Evidence als Text. Sieht KEINE Bilder.
- Kein Call hat beides gleichzeitig. DAS ist der Qualitätsunterschied.

### Problem 2: Web Evidence ist Müll
- `prefetchWebEvidenceForIdentify()` holt 600 Zeichen pro URL — oft Navigations-HTML, Cookie-Banner
- `fetchSerpSummary()` in runDatasheetReview liefert nur Titel + URL + Snippet. Keine echten Produktdaten.
- Alles selbstgebaut mit BrightData-Proxy. Google Search Grounding existiert als native Gemini-Feature.

### Problem 3: Alte SDK
- `@google/generative-ai` v0.24 (alt) → Kein Google Search Grounding Support
- `@google/genai` v1.44 (neu) → IST BEREITS INSTALLIERT aber nur in `gemini3-client.js` für simplen JSON

### Problem 4: Review-Prompt hat 100+ Zeilen Regeln
- Gemini ertrinkt in Policy-Text statt sich auf Produktdaten zu konzentrieren

## Lösung: Google Search Grounding + Structured Output + Bilder = 1 Call

### Was Google Search Grounding macht (eingebaut in Gemini API):
```js
const response = await ai.models.generateContent({
  model: 'gemini-3-pro-preview',
  contents: [prompt + images],
  config: {
    tools: [{ googleSearch: {} }],        // ← Gemini sucht SELBST im Web
    responseMimeType: 'application/json',  // ← Strukturierte Ausgabe
    responseJsonSchema: PRODUCT_SCHEMA,    // ← Exaktes Schema
  },
});
```

Gemini entscheidet SELBST welche Suchanfragen nötig sind, führt sie aus,
liest die Ergebnisse und liefert ein Schema-konformes JSON mit allen Produktdaten.

**Das ersetzt gleichzeitig:**
- `prefetchWebEvidenceForIdentify()` (30-60s → 0s, Gemini macht es intern)
- `runDatasheetReview()` (15-25s × 2 = 30-50s → 0s, Gemini macht es im gleichen Call)
- `enrichPriceForProductBestEffort()` (30-90s → im gleichen Call als Schema-Feld)
- `fetchMarketingImages()` (5-15s → im gleichen Call als Schema-Feld)

### Preismodell
- $14 pro 1.000 Search Queries (nicht pro API-Call)
- Gemini führt typisch 1-3 Queries pro Identify aus = $0.014-0.042 pro Produkt
- Das ist GÜNSTIGER als BrightData Proxy + SerpAPI Calls kombiniert

## Implementierung

### 1. Neue Funktion: `identifyProductWithGrounding()` in `backend/lib/gemini3-client.js`

Diese Funktion ist das Herzstück. Ein einziger Call an Gemini mit:
- Inline-Bilder (bis zu 4, komprimiert wie bisher)
- OCR-Text + Barcodes als Kontext
- Google Search Grounding aktiviert
- Structured Output mit dem vollständigen Produktschema

```js
/**
 * PERF-001: Single-call product identification with Google Search Grounding.
 *
 * Replaces the entire pipeline:
 *   generateStructuredProductRecord() + prefetchWebEvidence() +
 *   runDatasheetReview() × 2 + enrichPrice() + fetchMarketingImages()
 *
 * With ONE Gemini call that sees images + searches the web + returns structured JSON.
 *
 * @param {{
 *   imageParts: Array<{data: string, mimeType: string}>,
 *   ocrText: string,
 *   barcodes: string[],
 *   locale: string,
 *   hint: string|null,
 *   categoryContext: object|null,
 * }} opts
 * @returns {Promise<object>} Full product record (parsed JSON)
 */
async function identifyProductWithGrounding({
  imageParts = [],
  ocrText = '',
  barcodes = [],
  locale = 'de-DE',
  hint = null,
  categoryContext = null,
}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(null, 'IDENTIFY_MODEL', 'gemini-3-pro-preview');

  const contents = [];

  // Inline images (already compressed, base64)
  for (const img of imageParts) {
    contents.push({
      inlineData: {
        mimeType: img.mimeType || 'image/jpeg',
        data: img.data,
      },
    });
  }

  // Build the prompt
  const hintBlock = hint
    ? `PRODUKTHINWEIS: Fokussiere dich NUR auf: ${hint}\nIgnoriere alle anderen Produkte auf dem Bild.\n\n`
    : '';

  const barcodeBlock = barcodes.length
    ? `BARCODES (vom Scanner/OCR): ${barcodes.join(', ')}`
    : 'BARCODES: keine vorhanden';

  const ocrBlock = ocrText.trim()
    ? `OCR-TEXT (vom Label/Verpackung):\n${ocrText.trim()}`
    : 'OCR-TEXT: nicht verfügbar';

  const promptText = `${hintBlock}Du bist ein professioneller Produktdaten-Kurator für eBay.de und Kaufland.de.

DEINE AUFGABE:
Identifiziere das Produkt anhand der Bilder, OCR-Daten und Barcodes.
Nutze Google Search um fehlende Informationen zu recherchieren (Hersteller-Specs, Preise, GPSR-Daten, Produktbilder).

${barcodeBlock}

${ocrBlock}

RECHERCHE-STRATEGIE:
1. Wenn EAN/GTIN vorhanden: Suche zuerst danach (höchste Treffergenauigkeit)
2. Wenn Marke+Modell erkennbar: Suche nach "[Marke] [Modell] Datenblatt" oder "[Marke] [Modell] specifications"
3. Für Preise: Suche nach dem Produkt auf idealo.de, geizhals.de oder direkt im Shop
4. Für GPSR: Suche nach Hersteller-Impressum oder Produktsicherheitsdaten
5. Für Bilder: Suche nach hochwertigen Produktfotos vom Hersteller

QUALITÄTSANFORDERUNGEN:
- Titel: 70-80 Zeichen, suchmaschinenoptimiert, Marke + Produkttyp + Kernmerkmal zuerst
- Beschreibung: 180-240 Wörter, HTML (<p>, <ul>, <li>, <strong>), faktenbasiert
- Highlights: 5-7 Bulletpoints, Format "[Nutzen] – [Eigenschaft]", je 70-120 Zeichen
- Attribute: mindestens 10, technisch/granular, keine Dubletten
- Gewicht: In Gramm, ganzzahlig. Aus Bild/OCR/Web extrahieren. Nie 0g.
- Preis: Aktueller Marktpreis in EUR mit Quelle. Wenn nicht findbar: null.
- Bilder: Bis zu 3 hochwertige Web-URLs von Hersteller/Shop-Seiten
- GPSR: Hersteller-Kontaktdaten wenn im Web findbar (Name, Adresse, E-Mail)
- Zustand: "Neu" als Default, nur "Gebraucht" wenn eindeutige Gebrauchsspuren sichtbar

WICHTIG:
- Nur belegbare Fakten. Nichts erfinden.
- EAN/GTIN nur wenn korrekte Checkdigit (13 bzw. 14 Ziffern)
- Wenn eine Information nicht findbar ist: Feld leer lassen, nicht raten
- Antwort ausschließlich als JSON gemäß dem bereitgestellten Schema`;

  contents.push({ text: promptText });

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts: contents }],
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseJsonSchema: FULL_PRODUCT_SCHEMA,
    },
  });

  let text = (response.text || '').trim();
  if (!text) {
    throw new Error(`Gemini (${modelName}) returned empty response for identify-with-grounding`);
  }

  // Strip markdown fences if present
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const jsonStart = text.indexOf('{');
  if (jsonStart > 0 && jsonStart < 200) text = text.slice(jsonStart);

  const record = JSON.parse(text);

  // Attach grounding metadata for traceability
  record._grounding = {
    model: modelName,
    searchQueries: response.candidates?.[0]?.groundingMetadata?.webSearchQueries || [],
    sources: (response.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map((c) => ({ title: c?.web?.title, url: c?.web?.uri }))
      .filter((s) => s.url),
  };

  return record;
}
```

### 2. Erweitertes Produktschema: `FULL_PRODUCT_SCHEMA`

Das Schema muss ALLE Felder enthalten die bisher über separate Steps befüllt wurden:

```js
const FULL_PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    // Identification
    brand: { type: 'string', description: 'Markenname des Herstellers' },
    model: { type: 'string', description: 'Modellbezeichnung/Modellnummer' },
    sku: { type: 'string', description: 'SKU wenn erkennbar' },
    variant: { type: 'string', description: 'Variante (Farbe, Größe etc.)' },
    gtin: { type: 'string', description: 'GTIN-14 (14 Ziffern) wenn verifiziert' },
    ean: { type: 'string', description: 'EAN-13 (13 Ziffern) wenn verifiziert' },
    upc: { type: 'string', description: 'UPC-12 wenn verifiziert' },
    mpn: { type: 'string', description: 'Herstellerteilenummer (MPN)' },
    color: { type: 'string', description: 'Hauptfarbe' },
    size: { type: 'string', description: 'Größe/Abmessung' },
    material: { type: 'string', description: 'Hauptmaterial' },
    condition: { type: 'string', description: 'Zustand: Neu oder Gebraucht' },
    weight_grams: { type: 'integer', description: 'Gewicht in Gramm (ganzzahlig, nie 0)' },

    // Category
    internalCategory: { type: 'string', description: 'Kategorie-Pfad z.B. "Elektronik > Kopfhörer"' },

    // Marketplace Titles (search-optimized)
    title_ebay: { type: 'string', description: 'eBay Titel, 70-80 Zeichen, SEO-optimiert' },
    title_kaufland: { type: 'string', description: 'Kaufland Titel, bis 100 Zeichen' },

    // Descriptions (HTML)
    description_ebay: { type: 'string', description: 'eBay Beschreibung in HTML, 180-240 Wörter' },
    description_kaufland: { type: 'string', description: 'Kaufland Beschreibung in HTML' },

    // Key Features / Highlights
    key_features: {
      type: 'array',
      items: { type: 'string' },
      description: '5-7 Bulletpoints, je 70-120 Zeichen, Format: [Nutzen] – [Eigenschaft]',
    },

    // Attributes / Item Specifics
    item_specifics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
      description: 'Mind. 10 technische Attribute als key-value Paare',
    },

    // Pricing (from web research)
    price_eur: { type: 'number', description: 'Aktueller Marktpreis in EUR (null wenn nicht findbar)' },
    price_source_url: { type: 'string', description: 'URL der Preisquelle' },
    price_source_name: { type: 'string', description: 'Name der Preisquelle (z.B. idealo.de)' },

    // Web Images
    web_image_urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Bis zu 3 hochwertige Produktbild-URLs von Hersteller/Shop-Seiten',
    },

    // GPSR / Compliance
    gpsr_manufacturer_name: { type: 'string', description: 'GPSR Hersteller-Name' },
    gpsr_manufacturer_address: { type: 'string', description: 'GPSR Hersteller-Adresse' },
    gpsr_manufacturer_email: { type: 'string', description: 'GPSR Hersteller-E-Mail' },
    gpsr_manufacturer_phone: { type: 'string', description: 'GPSR Hersteller-Telefon' },
    gpsr_manufacturer_country: { type: 'string', description: 'GPSR Hersteller-Land (ISO 2-letter)' },

    // Identifiers (additional)
    identifiers: {
      type: 'object',
      properties: {
        ean: { type: 'string' },
        gtin: { type: 'string' },
        upc: { type: 'string' },
        mpn: { type: 'string' },
        isbn: { type: 'string' },
      },
      description: 'Alle gefundenen Identifikatoren',
    },

    // Quality notes
    notes: { type: 'string', description: 'Hinweise zu Unsicherheiten oder fehlenden Daten' },
  },
  required: [
    'brand', 'model', 'internalCategory',
    'title_ebay', 'title_kaufland',
    'description_ebay', 'description_kaufland',
    'item_specifics',
  ],
};
```

### 3. Neue Pipeline in `backend/routes/identify.js`

Der gesamte Post-Processing-Block (Zeilen 321-439) wird durch einen einzigen
`identifyProductWithGrounding()`-Call ersetzt, mit anschließendem Mapping auf
das bestehende Produktformat.

**Ablauf NEU:**
```
1. extractOcrPayload() + uploadReferenceImages()    ← parallel (Promise.all)
2. identifyProductWithGrounding()                    ← 1 Call, 20-40s
3. buildProductFromGroundedRecord()                  ← Mapping, sync
4. ensureCategories() + taxonomy                     ← 2-5s
5. enrichKTypIfPossible()                            ← 2-5s, parallel mit Save
6. evaluateEbayReady() + save                        ← <1s + 2s

TOTAL: ~30-50s
```

**Was ENTFÄLLT:**
- `generateStructuredProductRecord()` → ersetzt durch identifyProductWithGrounding
- `prefetchWebEvidenceForIdentify()` → ersetzt durch Google Search Grounding
- `runDatasheetReview()` × 2 → ersetzt durch Google Search Grounding
- `enrichPriceForProductBestEffort()` → Preis kommt aus dem gleichen Call
- `fetchMarketingImages()` → Web-Bilder kommen aus dem gleichen Call

### 4. Mapping-Funktion: `buildProductFromGroundedRecord()`

```js
/**
 * Maps the grounded Gemini response to the existing product format.
 * This ensures backward compatibility with saveProductV2() and all downstream code.
 */
function buildProductFromGroundedRecord(record, { fallbackId, barcodes, locale, inventoryId }) {
  const product = {
    id: fallbackId,
    identification: {
      name: record.title_ebay || '',
      brand: record.brand || 'unknown',
      category: record.internalCategory || '',
      sku: record.sku || '',
      barcodes: barcodes || [],
    },
    details: {
      categoryId: null, // Will be set by ensureCategories()
      short_description: record.description_ebay || '',
      key_features: Array.isArray(record.key_features) ? record.key_features : [],
      attributes: {},
      identifiers: {
        ean: record.ean || record.identifiers?.ean || '',
        gtin: record.gtin || record.identifiers?.gtin || '',
        upc: record.upc || record.identifiers?.upc || '',
        mpn: record.mpn || record.identifiers?.mpn || '',
      },
      images: [],
      pricing: {},
    },
    marketplace: {
      ebay: {
        title: record.title_ebay || '',
        description: record.description_ebay || '',
      },
      kaufland: {
        title: record.title_kaufland || '',
        description: record.description_kaufland || '',
      },
    },
    ops: {
      weight_grams: record.weight_grams || null,
    },
    notes: {},
  };

  // Map item_specifics array → attributes object
  if (Array.isArray(record.item_specifics)) {
    for (const spec of record.item_specifics) {
      if (spec?.key && spec?.value) {
        product.details.attributes[spec.key] = String(spec.value).slice(0, 60);
      }
    }
  }

  // Map price
  if (record.price_eur && record.price_eur > 0) {
    product.details.pricing = {
      lowest_price: {
        amount: record.price_eur,
        currency: 'EUR',
        sources: record.price_source_url
          ? [{ url: record.price_source_url, name: record.price_source_name || 'web' }]
          : [],
        last_checked_iso: new Date().toISOString(),
      },
      price_confidence: 0.75,
    };
  }

  // Map web images
  if (Array.isArray(record.web_image_urls)) {
    for (const url of record.web_image_urls.filter(Boolean).slice(0, 3)) {
      product.details.images.push({
        url_or_base64: url,
        source: 'web_search',
        variant: 'marketing',
      });
    }
  }

  // Map GPSR
  if (record.gpsr_manufacturer_name) {
    product.gpsr = {
      manufacturer_name: record.gpsr_manufacturer_name || '',
      manufacturer_address: record.gpsr_manufacturer_address || '',
      manufacturer_email: record.gpsr_manufacturer_email || '',
      manufacturer_phone: record.gpsr_manufacturer_phone || '',
      manufacturer_country: record.gpsr_manufacturer_country || '',
    };
  }

  // Map grounding metadata
  if (record._grounding) {
    product.ops.identify_grounding = record._grounding;
  }

  if (record.notes) {
    product.notes.identify_notes = record.notes;
  }

  return product;
}
```

### 5. Improve Pipeline anpassen

In `backend/services/improve.js` die gleiche Strategie nutzen:

**Aktuell (Zeilen 961-981):**
```js
const result = await runProductIdentification({ files, barcodes, ... });
// → Intern: generateStructuredProductRecord() ohne Web-Daten
```

**Neu:**
```js
const result = await identifyProductWithGrounding({ imageParts, ocrText, barcodes, ... });
// → 1 Call mit Bildern + Google Search + Structured Output
```

Dann `mergeProductRecords()` wie bisher, dann nur noch 1× `runDatasheetReview()`
(statt 2×), mit `marketplaceEvidence: false` weil Marketplace-Daten bereits
aus dem Grounding-Call kommen.

### 6. Chat Pipeline — kein Umbau nötig

Der Chat nutzt bereits:
- `gemini-3-pro-preview` mit Function Calling
- BrightData Web Search + SerpAPI als Tools
- Multi-Turn Conversation mit Tool Execution

Das ist bereits ein guter Ansatz. **Einzige Verbesserung:** Optional Google Search
Grounding als zusätzliches Tool neben den bestehenden Function Declarations.
Das ist ein separater, risikoarmer Change — NICHT Teil dieser Überarbeitung.

## Fallback-Strategie

Falls Google Search Grounding fehlschlägt (Quota, Billing, API-Änderung):

```js
const GROUNDING_ENABLED = String(process.env.IDENTIFY_GROUNDING || 'true').toLowerCase() === 'true';

if (GROUNDING_ENABLED) {
  try {
    record = await identifyProductWithGrounding({ ... });
  } catch (e) {
    console.warn('Grounding failed, falling back to legacy pipeline:', e?.message);
    record = null;
  }
}

// Fallback: Legacy-Pipeline (langsamer, aber funktioniert)
if (!record) {
  const result = await runSerpapiFreePipeline({ ... });
  // ... rest of legacy pipeline
}
```

## ENV-Variablen

Neue:
- `IDENTIFY_GROUNDING=true|false` — Google Search Grounding an/aus (default: true)
- `IDENTIFY_MODEL=gemini-3-pro-preview` — Modell für Grounding-Call

Bestehende (werden weiterhin für Fallback verwendet):
- `GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` — API-Key (gleicher wie bisher)
- `IDENTIFY_PREFETCH_WEB_EVIDENCE` — nur noch für Fallback relevant

## Tests

### Neue Tests: `backend/__tests__/identify-grounding.test.js`

1. `identifyProductWithGrounding` — gibt valides Produktobjekt zurück
2. `identifyProductWithGrounding` — mit leeren Bildern → nutzt nur Barcodes
3. `buildProductFromGroundedRecord` — mappt alle Felder korrekt
4. `buildProductFromGroundedRecord` — fehlendes Preis-Feld → leeres pricing
5. `buildProductFromGroundedRecord` — GPSR Mapping
6. Fallback auf Legacy wenn Grounding fehlschlägt
7. Schema-Validierung: Alle required Felder vorhanden

### Bestehende Tests:
- `cd backend && npm test` — alle Tests weiterhin grün
- Keine bestehende Funktion wird geändert (additive only)

## Kein Breaking Change

- `generateStructuredProductRecord()` bleibt bestehen (für Fallback + andere Caller)
- `runDatasheetReview()` bleibt bestehen (für Improve + andere Caller)
- `prefetchWebEvidenceForIdentify()` bleibt bestehen (für Fallback)
- `enrichPriceForProductBestEffort()` bleibt bestehen (für Improve + andere Caller)
- Neue Funktion: `identifyProductWithGrounding()` + `buildProductFromGroundedRecord()`
- ENV-basierter Switch: `IDENTIFY_GROUNDING=true` (default) vs. `false` (legacy)

## Erwartete Ergebnisse

### Speed
```
Vorher:  125-270s (10 sequenzielle Steps, 2 Gemini-Calls, 12 HTTP-Fetches)
Nachher: 30-50s (1 Gemini-Call mit eingebautem Google Search)
```

### Qualität
```
Vorher:  Gemini sieht in keinem Call gleichzeitig Bilder + Web-Daten
Nachher: Gemini sieht ALLES in 1 Call (Bilder + OCR + Barcodes + Web-Recherche)
         → Gleiche Qualität wie Cowork-Demo (Kogata GC357 in 90s)
```

### Kosten
```
Vorher:  2× Gemini Pro + 6× Marketplace-Search + 12× BrightData-Fetch + 3× Price-Source
Nachher: 1× Gemini Pro + 1-3× Google Search Queries ($0.014/Query)
         → Günstiger
```

## Validierung

1. `cd backend && npm test` — alle Tests grün
2. `node --check backend/lib/gemini3-client.js` — Syntax OK
3. `node --check backend/routes/identify.js` — Syntax OK
4. Deploy + Test: 3 Bilder (Kogata GC357) → Datenblatt in <60s
5. Vergleich: Gleiche Qualität wie Cowork-Demo? Preis? GPSR? Specs? Web-Bilder?
6. Fallback-Test: `IDENTIFY_GROUNDING=false` → Legacy-Pipeline funktioniert weiterhin
