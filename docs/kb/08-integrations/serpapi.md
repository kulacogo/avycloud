---
title: "Integration: SerpAPI"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# SerpAPI

> Search-Engine-Results-Aggregator. AvyCloud nutzt SerpAPI für **Preisrecherche** (Google Shopping, Amazon, eBay-Sold), **Bild-Suche** (Google Lens, Reverse Image), **Marken-/Datasheet-Discovery** (Google Search + Bing).
> Nicht in der `integration-registry.js` — SerpAPI ist Backend-Infrastruktur, kein Settings-konfigurierbarer Provider.

## Was integriert ist

- **Preisrecherche** (Pricing-Worker): Google Shopping, Amazon, eBay-Sold (LH_Sold=1&LH_Complete=1)
- **Bild-Suche** (Image-Worker): Google Images, Google Lens, Bing Images, Reverse-Image-Lookup
- **Manufacturer-Site-Discovery** (atomic-tools, Identify): Google + Bing Organic-Results
- **Chat-Assistant Legacy-Pfad**: Amazon-Routing via `engine='amazon'` (mit `CHAT_LEGACY_ENHANCED=true`)
- **Sold-Listings-Fallback** für eBay (siehe [ebay.md](ebay.md))

## Auth + Credentials

- **API-Key** in Query-String: `?api_key=…`.
- Resolution-Reihenfolge in `getSerpApiKey()` ([backend/lib/serpapi.js](../../../backend/lib/serpapi.js)):
  1. `process.env.SERPAPI_KEY`
  2. `getSecretValue('SERPAPI_KEY')`
- Wenn nichts gefunden: harter Throw `'SERPAPI_KEY is not configured'`.
- Cache: `cachedKey` in-process; Rotation = Restart.
- Base-URL hardcoded: `https://serpapi.com/search.json`.

## Hauptendpoints (call sites im Code)

Alle Calls in [backend/lib/serpapi.js](../../../backend/lib/serpapi.js) → `callSerpApi(engine, params)` bzw. `fetchSerpApi({engine, ...params})`.

### Allowed Engines (`ALLOWED_ENGINES`)

```
google, google_shopping, google_shopping_ai_overview, google_ai_overview,
google_ai_mode, google_images, google_images_shopping, google_lens,
google_reverse_image, google_immersive_product, google_product,
bing, bing_images, bing_shopping, bing_reverse_image,
duckduckgo, yahoo, yandex, naver,
ebay, ebay_product, walmart, home_depot, amazon
```

### Default-Parameter per Engine (`buildDefaultParams`)

| Engine-Klasse | Defaults |
|---------------|----------|
| Google-* | `gl=de`, `hl=de`, `google_domain=google.de` (override `SERPAPI_GL`, `SERPAPI_HL`, `SERPAPI_GOOGLE_DOMAIN`) |
| Bing-* | `cc=DE`, `mkt=de-DE` |
| DuckDuckGo | `kl=de-de` |
| eBay | `ebay_domain=ebay.de` |
| Amazon | `amazon_domain=amazon.de` |

### Wichtige Caller

| Caller | Engine(s) | Zweck |
|--------|-----------|-------|
| [backend/lib/ebay-sold-listings.js](../../../backend/lib/ebay-sold-listings.js) | `ebay` mit `LH_Sold=1` | Sold-Signal-Fallback |
| `services/atomic-tools.js` | `google`, `bing`, `amazon` | `search_manufacturer_site`, `search_amazon_product`, `fetch_url_content`-Erweiterung |
| `services/identify-v4.js` (Pricing-Worker) | `google_shopping`, `amazon`, `ebay_product` | Preis-Signal-Aggregation |
| `services/identify-v4.js` (Image-Worker) | `google_images`, `google_lens` | Bild-Discovery |
| Chat-Legacy-Pipeline | `amazon` (mit `CHAT_LEGACY_ENHANCED=true`) | ASIN-Detection |

### Output-Aggregation

`summarizeSerpEntries(engine, data, limit=5)` → einheitliches `{title, price, source, url, thumbnail, snippet, image_meta}`-Format. Filtert Low-Res-Images out (`MIN_IMAGE_WIDTH=900`, `MIN_IMAGE_HEIGHT=900`, override via ENV).

## Tracker-Wrap

`_fetchSerpApiRaw` wird durch `instrumentExternalCall('serpapi', engine, …)` ([backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js)) gewrappt:

- Fire-and-forget Firestore-Schreibung in `external_api_calls`:
  - `service: 'serpapi'`
  - `endpoint: '<engine>'`
  - `success`, `latencyMs`, `errorCode`
- **Cache-Hits werden NICHT getrackt** — der `instrumentExternalCall`-Wrap liegt INNERHALB des Cache-Miss-Pfads.
- Sample-Rate: `EXTERNAL_API_TRACKER_SAMPLE_RATE=1.0` default (alle Calls). Nach Baseline drosseln auf `0.1`.

## Webhooks

**Keine.** SerpAPI ist request/response.

## Rate-Limits + Quotas

### SerpAPI-Plan-Limit

- Plan-abhängig (typisch 5 000 Searches/Monat im kleinsten Paid-Tier; 100/Stunde im Free-Tier).
- Kein automatischer Plan-Detect — Overuse wirft `SERPAPI_API_ERROR` mit Body `…exceeded rate limit…`.

### In-Code-Drossel ([backend/lib/serpapi.js](../../../backend/lib/serpapi.js))

| Limit | Default | Override |
|-------|---------|----------|
| Max pro Sekunde | 5 | `SERPAPI_MAX_PER_SECOND` |
| Max parallele Calls | 20 | `SERPAPI_MAX_CONCURRENT` |
| Wait-Queue-Max | 1000 | `SERPAPI_RATE_QUEUE_MAX` |
| Request-Timeout | 20 000 ms | `SERPAPI_TIMEOUT_MS` |
| Disable Rate-Limit | false | `SERPAPI_DISABLE_RATE_LIMIT=true` |

### Caching

| Cache | Default | Override |
|-------|---------|----------|
| Positive-TTL | 6 h | `SERPAPI_CACHE_TTL_MS` |
| Negative-TTL (empty results) | 1 h | `SERPAPI_NEG_CACHE_TTL_MS` |
| Positive-Max | 500 entries | `SERPAPI_CACHE_MAX` |
| Negative-Max | 1000 entries | `SERPAPI_NEG_CACHE_MAX` |
| Disable Cache | false | `SERPAPI_DISABLE_CACHE=true` |

### Circuit Breaker

| Setting | Default | Override |
|---------|---------|----------|
| Schwelle (consecutive errors) | 5 | `SERPAPI_BREAKER_THRESHOLD` |
| Open-Duration | 60 s | `SERPAPI_BREAKER_OPEN_MS` |
| Disable Breaker | false | `SERPAPI_DISABLE_BREAKER=true` |

Wichtig: **Empty Results sind kein Fehler.** SerpAPI gibt für „Google hasn't returned any results …" HTTP 200 mit `error`-Body — `isEmptyResultPayload()` erkennt das und behandelt es als „successful empty"; Cache + Breaker bleiben unbeeinflusst.

### Logging

`SERPAPI_LOG_THROTTLE_MS=60000` default — gleicher Fehler/Empty-Reason wird max. einmal pro Minute geloggt (Map mit Auto-Cleanup).

## Cost

- **Pro Search etwa USD 0.005–0.015** (plan-abhängig). Bei 1000 Identify-Calls/Tag mit 3–4 SerpAPI-Calls pro Identify schnell auf USD 30–50/Tag.
- Positive Caching (6 h TTL) drosselt typische Repeat-Lookups massiv (z. B. Identify-Re-Runs auf gleichen EAN).
- **Cost-Tracking ist via `external_api_calls` Telemetrie + Operator-Dashboard** (`/api/health/identify` aggregiert success-rate + latency, kein Cost-Lookup gegen SerpAPI direkt). Konto-Limits müssen manuell im SerpAPI-Portal überwacht werden.

## Bekannte Schwächen

- **Single API-Key, in-memory cached.** Rotation = Restart.
- **Tracker-Wrap nur innerhalb Cache-Miss-Pfad.** Cache-Hits werden nicht in `external_api_calls` aufgezeichnet — Operator-Dashboard zeigt also nur **echte** Calls, nicht den Cache-Effekt. Für Cost-Modelling reicht das, aber für volle Visibility nicht.
- **Circuit-Breaker greift nicht auf empty-results** (per Design). Wenn SerpAPI in einen Quasi-Outage geht, der nur empty-Antworten liefert, läuft der Breaker nie an.
- **Engine-Whitelist ist hardcoded.** Neue SerpAPI-Engines müssen in `ALLOWED_ENGINES` ergänzt werden, sonst `Unsupported SerpAPI engine`.
- **Image-Quality-Filter (`MIN_IMAGE_WIDTH=900`)** kann legitime Thumbnails verwerfen. Fallback-Pfad in `summarizeSerpEntries` schaltet den Filter dann ab (`skipQualityCheck=true`), aber nur engine-spezifisch (`google_images`, `google_lens`, …).
- **`SERPAPI_DISABLE_CACHE=true` schaltet auch Negativ-Cache aus** — Empty-Results führen dann zu wiederholten Calls. Vorsicht bei Debugging.
- **Engine `amazon` ist regional pinned** (`amazon_domain=amazon.de` default). Marktplatz-übergreifende Recherche braucht expliziten Override pro Call.

## Owner / Docs

- **Code-Owner:** Backend-Team / AI-Sub-Team.
- **Externe Doku:**
  - SerpAPI Docs: [serpapi.com/search-api](https://serpapi.com/search-api)
  - Error-Codes: [serpapi.com/api-status-and-error-codes](https://serpapi.com/api-status-and-error-codes)
  - eBay-Engine: [serpapi.com/ebay-search-api](https://serpapi.com/ebay-search-api)
  - Amazon-Engine: [serpapi.com/amazon-search-api](https://serpapi.com/amazon-search-api)
- **Verwandte KB-Seiten:**
  - [ebay.md](ebay.md) — Sold-Listings-Fallback
  - [brightdata.md](brightdata.md) — HTML-Fallback wenn SerpAPI nicht reicht
