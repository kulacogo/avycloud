---
title: LLM-Tools — atomic-tools + write-tools (Function Calling)
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Tools — Function-Calling

> Gemini wird in AvyCloud konsequent mit **vielen kleinen, präzise typisierten Tools** statt einem generischen `web_search(query)` gefüttert. Anthropic-Research zeigt: Hallucination skaliert mit Tool-Katalog-Größe **und** mit Generic-ness. Atomar + Poka-Yoke-typisiert reduziert Argument-Mixing.

## 1. Tool-Topologie

| Klasse | Wer ruft sie auf | Wo definiert |
|---|---|---|
| **Native Gemini-Tools** (`googleSearch`, `urlContext`) | Identify-Grounding, Chat V3 + V2, V4 Worker | inline in Gemini-Call-Config |
| **Atomic-Tools** (7+2 Function-Decls) | Chat V3, V4 Worker (Identity, Attributes), Improve | [backend/services/atomic-tools.js](../../../backend/services/atomic-tools.js) |
| **Write-Tools** (`update_product_datasheet`, `suggest_product_images`, `generate_ai_images`) | Chat V3, V2 | [services/product-chat-v3.js:111+188](../../../backend/services/product-chat-v3.js), [product-chat-v2.js](../../../backend/services/product-chat-v2.js) |
| **Agentic-Stage-3 Tools** (`research`, `write_datasheet`) | Identify-V3 Stage 3 Agentic | [backend/lib/identify-v3-stage3-agentic.js](../../../backend/lib/identify-v3-stage3-agentic.js) |
| **Legacy-Toolkit** (`serpapi`, `web_search` via BrightData, `web_fetch`) | Chat Legacy | [backend/services/toolkit.js](../../../backend/services/toolkit.js) |

## 2. Atomic-Tools — die 7 (+2) Function-Declarations

Quelle: [backend/services/atomic-tools.js](../../../backend/services/atomic-tools.js). Alle Executors folgen einer einheitlichen Response-Shape:

```js
{
  ok: boolean,
  source: string,        // tool-name
  data: any,             // tool-specific payload
  confidence: number,    // 0..1 self-assessed
  meta: { durationMs, tokensUsed?, rateLimited? },
  error?: { code, message }
}
```

Hard-Garantien:
- **Werfen nie** — Fehler kommen als `{ ok:false, error }` zurück.
- **Timeout** `ATOMIC_TOOLS_TIMEOUT_MS` (Default **15000 ms**, per-Executor).
- **Graceful Degradation** wenn optionale Deps fehlen (`NOT_IMPLEMENTED` Code).

### 2.1 `lookup_gtin`

| Was | Werte / Verhalten |
|---|---|
| **Beschreibung** | "Look up product information by GTIN/EAN/UPC barcode. Returns brand, model, category, images, specifications from multiple product databases." |
| **Parameters** | `gtin` (8/12/13/14 digits, **required**), `locale` (optional, z. B. `"de-DE"`) |
| **Executor** | `executeLookupGtin` |
| **Implementierung** | `lib/ean-database.js lookupEan()`. Wenn fehlt → `NOT_IMPLEMENTED`. |
| **Confidence-Mapping** | gefunden: `0.7` (0.65 wenn `source !== 'open_ean_db'`), nicht gefunden: `0.1` |

Vorab-Validation: `isValidGtinDigits()` über `lib/gtin.js isValidGtin()` (mod-10-Checksum).

### 2.2 `search_ebay_catalog`

| Was | Werte / Verhalten |
|---|---|
| **Beschreibung** | "Search eBay Catalog by GTIN or title. Returns eBay category id, suggested title, existing catalog entry, sample aspects." |
| **Parameters** | `gtin`, `query` (mind. eines erforderlich), `marketplace` (`EBAY_DE`\|`EBAY_COM`, default `EBAY_DE`) |
| **Executor** | `executeSearchEbayCatalog` |
| **Implementierung** | `lib/ebay-taxonomy-remote.searchCatalogByGtin` für GTIN-Pfad, `getCategorySuggestions` für Query-Pfad |
| **Confidence-Mapping** | GTIN-Match mit categoryId: `0.9`, Suggestions: `0.75`, leer: `0.25/0.3` |

### 2.3 `get_required_aspects`

| Was | Werte / Verhalten |
|---|---|
| **Beschreibung** | "Get the list of required/recommended/optional Item Specifics for a specific eBay category. Use BEFORE filling item_specifics to know which fields are mandatory." |
| **Parameters** | `categoryId` (**required**), `marketplace` (default `EBAY_DE`) |
| **Executor** | `executeGetRequiredAspects` |
| **Implementierung** | `lib/ebay-taxonomy.getCategoryAspectCatalog(categoryId)` — liefert `requiredAspects`, `recommendedAspects`, `optionalAspects`, `allAspects` |
| **Confidence-Mapping** | hat irgendwelche Aspects: `0.95`, sonst: `0.1` |

### 2.4 `verify_brand`

| Was | Werte / Verhalten |
|---|---|
| **Beschreibung** | "Verify that brand name + MPN combination exists (GS1 / manufacturer registry). Returns canonical brand name, manufacturer address, GPSR data if available. Use to resolve typos or aliases." |
| **Parameters** | `brand` (**required**), `mpn` (optional) |
| **Executor** | `executeVerifyBrand` |
| **Implementierung** | `lib/gpsr-manufacturer-registry.getManufacturerGpsrByName(brand)`. Fallback: `brandDomainGuess(brand)` mit hand-curated `BRAND_DOMAIN_MAP` (35 Marken) und Heuristik `<slug>.de`. |
| **Confidence-Mapping** | Registry-Hit: `record.confidence ?? 0.8`. Nur domain-guess: `0.3` (oder `0.1` wenn keine Domain) |

### 2.5 `search_amazon_product`

| Was | Werte / Verhalten |
|---|---|
| **Beschreibung** | "Search Amazon for a product by ASIN, GTIN, or title. Returns Amazon product page, price, reviews count, specifications. Use for cross-referencing pricing and completeness." |
| **Parameters** | `asin` (B0+8 alphanumeric), `gtin`, `query` (mind. eines erforderlich), `region` (`DE`\|`COM`, default `DE`) |
| **Executor** | `executeSearchAmazonProduct` |
| **Implementierung** | `toolkit.executeSerpapiToolCall({ engine: 'amazon', ... })`. **Kein** BrightData-Fallback (Sprint-1 entfernt) — bei SerpAPI-Error → `NO_RESULTS`. |
| **Confidence-Mapping** | Summary mit Items: `0.75`, sonst `0.3` |

### 2.6 `search_manufacturer_site`

| Was | Werte / Verhalten |
|---|---|
| **Beschreibung** | "Search the manufacturer's official website for product specifications. Use to get authoritative specs, manual PDFs, warranty info. Falls back to Google site: query if manufacturer site not known." |
| **Parameters** | `brand` (**required**), `model`, `mpn` |
| **Executor** | `executeSearchManufacturerSite` |
| **Implementierung** | `toolkit.executeWebSearchToolCall({ query: '"<model>" "<mpn>" site:<domain>', limit:8 })`. Domain via `brandDomainGuess()`. |
| **Confidence-Mapping** | Results vorhanden: `0.7`, sonst `0.25` |

### 2.7 `fetch_url_content`

| Was | Werte / Verhalten |
|---|---|
| **Beschreibung** | "Fetch and extract main text content from a URL. Use when Google Search returned a promising URL. Supports HTML, PDF, JSON. Max 34MB per URL." |
| **Parameters** | `url` (HTTPS, **required**), `extractImages` (boolean, default false) |
| **Executor** | `executeFetchUrlContent` |
| **Implementierung** | `toolkit.executeWebFetchToolCall({ url, method:'GET', format:'raw', timeout_ms: 15000 })` |
| **Confidence-Mapping** | Success: `0.8`, Failure: `0.2` |

### 2.8 `search_ebay_sold` (Pricing, V4-Addition)

`executeSearchEbaySold` — wraps `lib/ebay-sold-listings.searchSoldListings`. Liefert recent SOLD-Preise + `extractPricingSignals(items)`. Für Sweet-Spot-Pricing (sweet-spot-pricer.js).

### 2.9 `search_idealo` (Pricing, V4-Addition)

`executeSearchIdealo` — wraps `lib/serpapi.fetchSerpApi({ engine: 'google_shopping', q: '<gtin> site:idealo.de', ... })`. Liefert `offers[]` mit Preis, Quelle, Link.

## 3. Tool-List-Builder

```js
const list = atomicTools.buildToolList({
  includeAmazon: true,        // search_amazon_product
  includeManufacturer: true,  // search_manufacturer_site
  includePricing: true,       // search_ebay_sold + search_idealo
});
// always-on: lookup_gtin, search_ebay_catalog, get_required_aspects, verify_brand, fetch_url_content
```

`buildToolExecutorMap()` liefert das `name → executor`-Mapping für die Function-Call-Dispatch-Schleife.

## 4. Write-Tools (Chat-Pipelines)

### `update_product_datasheet`

Quelle: [backend/services/product-chat-v3.js:111](../../../backend/services/product-chat-v3.js) (Declaration), [product-chat-v3.js:577](../../../backend/services/product-chat-v3.js) `ownExecutor` (Executor).

**Pflicht-Tool für Chat V3/V2.** Ohne diesen Call sieht der User keinen "Übernehmen"-Button. Das Sanitizer-Whitelist garantiert dass keine ungeprüften Felder im Datasheet landen:

| Top-Level-Feld | Max | Sanitizer |
|---|---|---|
| `summary` | 500 chars | `sanitizeString` |
| `title` | 120 chars | `sanitizeString` |
| `confidence` | clamp `[0,1]` | numeric parse |
| `short_description` | 8000 chars | `sanitizeString` (kein active-content check hier — separater `sanitizeListingText`) |
| `key_features[]` | max 12, je 240 chars | `sanitizeStringArray` |
| `identity` | `{ name, brand, category, sku, barcodes, ean, gtin, upc, mpn, clear[] }` | Field-by-field, `clear` Whitelist `['barcodes','ean','gtin','upc']` |
| `attributes[]` | max 40 Einträge, key ≤ 60, value ≤ 240 | `sanitizeString` per Eintrag |
| `gpsr` | 9 Felder (manufacturer_*, email, url, country_code, entity_country) | Field-by-field |
| `pricing` | `amount` (numeric), `currency`, `source_url`, `last_checked_iso` | numeric+string |
| `notes` | `unsure[]`, `warnings[]` (max 10, je 240) | string-array |

**Sicherheitsgarantie:** alles ausserhalb der Whitelist wird vom Server stillschweigend verworfen. Der Modus `functionCallingConfig.mode='ANY' + allowedFunctionNames=['update_product_datasheet']` zwingt Gemini in den Write-Modus wenn `searchOnlyIters > SOFT_RESEARCH_LIMIT (3)`.

### `suggest_product_images`

Quelle: [product-chat-v3.js:188](../../../backend/services/product-chat-v3.js).

| Parameters | Verhalten |
|---|---|
| `query` (string, **required**) | Suchanfrage für Bild-Resolver (Brand + Modell + EAN). |
| `rationale` (string) | Optionale Begründung für die Bild-Suche. |

Das **System** löst die URLs auf (über `lib/image-search.js`) — das LLM darf **keine** URLs erfinden. Der Executor packt nur `{ query, rationale }` in `state.imageSuggestions` für die Post-Processing-Phase.

### `generate_ai_images` (nur Chat V2)

Quelle: [backend/services/product-chat-v2.js](../../../backend/services/product-chat-v2.js).

Triggert `services/image-generation.js generateImagesForProduct()` — Imagen-Generation für Marketing-Bilder.

## 5. Agentic-Stage-3 Tools (Identify V3)

Quelle: [backend/lib/identify-v3-stage3-agentic.js](../../../backend/lib/identify-v3-stage3-agentic.js). Aktiv wenn `STAGE3_AGENTIC=true` (default).

| Tool | Zweck |
|---|---|
| `research(query)` | Web-Recherche-Tool (delegiert an Toolkit) |
| `write_datasheet(payload)` | Finales JSON-Output gemäß `CONTENT_SCHEMA` |

Loop-Eigenschaften:
- `STAGE3_AGENTIC_MAX_ITERATIONS` Default `5`.
- `STAGE3_AGENTIC_TIMEOUT_MS` Default `90000`.
- `STAGE3_AGENTIC_MAX_IMAGES` Default `4` (Initial-Prompt).
- `STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT` Default `3` (Soft-Push zum Write nach N Research-Calls).
- 3-Tier-Fallback: agentic → single-shot (`generateProductContent`) → V2-record. Runtime-Failures können die Pipeline nicht brechen.

## 6. Legacy-Toolkit (Chat Legacy)

Quelle: [backend/services/toolkit.js](../../../backend/services/toolkit.js).

| Tool | Backend | Beschreibung |
|---|---|---|
| `serpapi` | SerpAPI (Google + Amazon + Shopping) | `executeSerpapiToolCall` — primärer Web-Such-Provider |
| `web_search` | BrightData (Sprint-1: phase-out) | `executeWebSearchToolCall` — Fallback wenn SerpAPI rate-limited |
| `web_fetch` | BrightData + native fetch | `executeWebFetchToolCall` — URL-Content extrahieren |

**External-API-Tracking:** alle 3 Tools laufen durch `lib/external-api-tracker.js instrumentExternalCall()` → Firestore `external_api_calls` (default 100 % Sample). Aggregat via `getExternalApiStats()` — Endpoint-Inputs für die "Brauchen-wir-BrightData-noch?"-Entscheidung.

## 7. Tool-Source-Mapping zu Confidence-Weights

Quelle: [backend/services/product-chat-v3.js:629](../../../backend/services/product-chat-v3.js) (`ATOMIC_SOURCE_TO_WEIGHT_KEY`).

| Tool-source | confidence-scoring Weight-Key |
|---|---|
| `lookup_gtin` | `ean_db` |
| `search_ebay_catalog` | `ebay_catalog` |
| `get_required_aspects` | `ebay_catalog` |
| `verify_brand` | `gs1_verified` |
| `search_amazon_product` | `amazon_product` |
| `search_manufacturer_site` | `manufacturer_website` |
| `fetch_url_content` | `url_context` |
| (Fallback) | `web_search_broad` |

Die Weights aus `lib/confidence-scoring.js SOURCE_WEIGHTS`:
- `gs1_verified` `0.98`
- `ebay_catalog` `0.95`
- `manufacturer_website` `0.90`
- `ean_db` `0.85`
- `amazon_product` `0.75`
- `url_context` `0.70`
- `web_search_broad` `0.55`
- `gemini_inference` `0.55`

Multi-Source-Boost: gleiche Werte aus ≥ 2 Quellen → Confidence + 0.1 (max 1.0). Disagreement: Confidence − 0.3.

## 8. Sicherheits- & Performance-Notes

- **Timeouts** `ATOMIC_TOOLS_TIMEOUT_MS=15000` (per-Executor) und `withTimeout`-Race in jedem Executor — late rejections werden via `guarded.catch(()=>{})` absorbiert (verhindert UnhandledPromiseRejection-Kaskaden).
- **Domain-Heuristik** `brandDomainGuess(brand)` ist konservativ — Hand-Curated für 35 Marken, sonst `<slug>.de`. NICHT als Source-of-Truth, nur als `site:`-Hint für Google.
- **Sanitizer-Defense** ist die letzte Linie — selbst wenn ein Tool aus Versehen XSS-fähigen HTML zurückliefert, wird er durch `sanitizeListingText`/`sanitizeDescriptionToHtml` ([lib/listing-sanitize.js](../../../backend/lib/listing-sanitize.js)) gefiltert.
- **External-API-Sampling** `EXTERNAL_API_TRACKER_SAMPLE_RATE` (default `1.0`) — Operator kann nach Baseline-Daten auf `0.1` drosseln.
