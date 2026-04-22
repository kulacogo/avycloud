# Identify-V4 "E-Commerce-God"

## Status

- Umgesetzt: 2026-04-22 / 23
- Backend: **Dark-Deployed** (`IDENTIFY_V4=false` per Default auf Cloud Run)
- Frontend: **LIVE** (IdentifyV4Badge + Needs-Review-Banner via Firebase Hosting)
- Aktivierung: Einzelnes `gcloud run services update`-Kommando (siehe unten)

## Ziel

Aus minimalem Input (Bilder + optional Barcode) ein **eBay-qualifiziertes Produktdatenblatt** erzeugen — ohne dass der User nachbearbeiten muss. Kosten spielen keine Rolle, Accuracy > Speed > Cost.

## Architektur

Orchestrator-Worker-Swarm. 8 parallele Gemini-3.1-Pro-Customtools-Worker mit aggressivem Refinement-Loop.

```
POST /api/v2/identify → if IDENTIFY_V4 → identifyProductV4()
         │
         ▼
  Pre-Flight: runStage1Recognition (reuse aus V3)
         │
         ▼
  WAVE 1 (parallel):   identity + category
         │
         ▼  merge via crossReferenceProduct()
  WAVE 2 (parallel):   attributes + seo + pricing + image + gpsr
         │
         ▼  merge
  REFINEMENT LOOP (max 5 iter):
     findLowConfidenceWorkers → re-run only domains with score < 0.75
     Break wenn hasConfidenceImproved < 0.05
         │
         ▼
  CRITIC: evaluateEbayReady + GTIN-Checksum + Aspect-Cap-45 + GPSR-Check
         │
         ▼
  assembleProductV4() → ops.data_quality.identify_v4
         │
         ▼
  Autosave via saveProductV2 wenn score ≥ 0.6 UND identity+category ok
         │
         ▼
  Return { product, meta: { pipeline:'v4', waves, confidence, workerReports } }
```

## Worker-Details

| Worker | Datei | Primary Task | Quellen |
|---|---|---|---|
| identity | `lib/identify-workers/identity-worker.js` | GTIN/EAN/UPC/MPN + Brand Resolution | lookup_gtin, verify_brand, search_amazon_product + Gemini forced finalization |
| category | `lib/identify-workers/category-worker.js` | eBay-Kategorie + required Aspects | ebay-catalog lookupByGtin (priority) + category-resolver-v2 fallback chain |
| attributes | `lib/identify-workers/attributes-worker.js` | Item Specifics füllen | 3-source cross-reference + Gemini + enforceAspectCap 45 |
| seo | `lib/identify-workers/seo-worker.js` | Titel (80/150 char) + HTML-Beschreibung | Competitor-keyword mining + deterministic builders |
| pricing | `lib/identify-workers/pricing-worker.js` | Sweet-spot price | SOLD listings + Amazon + Idealo + enrichPriceParallel + fee-aware |
| image | `lib/identify-workers/image-worker.js` | Multi-source image aggregation | Upload + web + manufacturer + BG-removal (Gemini Image) + upscale |
| gpsr | `lib/identify-workers/gpsr-worker.js` | Hersteller-Compliance-Daten | Registry → web-fallback → manufacturer-site cascade |
| critic | `lib/identify-workers/critic-worker.js` | Quality-Gate + Fix-Hints | evaluateEbayReady + GTIN-Checksum + aspect-cap + GPSR-check |

Alle Worker: einheitliche Shape `{ok, domain, resolved, confidence, sources, retriesRequested, meta}`, `never throws`, `graceful degradation` bei fehlenden Dependencies.

## Feature-Flags (Cloud Run ENV)

| Flag | Default | Wirkung |
|---|---|---|
| `IDENTIFY_V4` | `false` | Master-Switch. Default off = Dark-Deploy |
| `IDENTIFY_V4_AUTOSAVE` | `true` | Direkt via saveProductV2 schreiben |
| `IDENTIFY_V4_MAX_ITERATIONS` | `5` | Refinement-Loop-Limit |
| `IDENTIFY_V4_WAVE_TIMEOUT_MS` | `60000` | Timeout pro Wave |
| `IDENTIFY_V4_TIMEOUT_MS` | `180000` | Hard-Pipeline-Cap |
| `IDENTIFY_V4_IMAGE_ENHANCE` | `true` | Gemini Image BG-Removal + Upscale |
| `IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY` | `true` | Multi-Angle via Gemini Flash |
| `IDENTIFY_V4_PRICING_SOLD` | `true` | eBay SOLD-Listings |
| `IDENTIFY_V4_CRITIC_FLASH` | `true` | Critic darf Gemini-Flash für Fix-Hints |
| `IDENTIFY_V4_FALLBACK` | `v3` | Pipeline bei V4-Error |

## Tests

- **Unit**: 1027 Tests (alle Libraries + alle 8 Workers + Orchestrator)
- **Smoke**: `node backend/scripts/smoke-identify-v4.js` — end-to-end gegen live Gemini mit Fixture-Produkten (Sony WH-1000XM5, Anker Powerbank, Philips Sonicare)
- **Regression**: V3/V2/Legacy-Pfade unverändert, alle ursprünglichen Tests weiterhin grün

## Rollout-Plan

### Vor dem Flip
```bash
# Smoke-Test gegen echtes Gemini (beweist dass V4 real funktioniert)
GEMINI_API_KEY=$(gcloud secrets versions access latest --secret=GEMINI_API_KEY) \
  node backend/scripts/smoke-identify-v4.js --dry-run

# Für 3 Fixtures durchtesten (Elektronik, Auto, Kosmetik):
SMOKE_FIXTURE=sony-wh1000xm5 GEMINI_API_KEY=... node backend/scripts/smoke-identify-v4.js
SMOKE_FIXTURE=anker-powerbank GEMINI_API_KEY=... node backend/scripts/smoke-identify-v4.js
SMOKE_FIXTURE=philips-hx9903 GEMINI_API_KEY=... node backend/scripts/smoke-identify-v4.js
```

Ziel: Jeder Smoke-Test liefert `ebay_ready_score ≥ 0.6` und `ok: true`.

### Activation (nach Staging-Grün)
```bash
gcloud run services update product-hub-backend \
  --region=europe-west3 \
  --update-env-vars=IDENTIFY_V4=true
```

### Notfall-Rollback
```bash
gcloud run services update product-hub-backend \
  --region=europe-west3 \
  --update-env-vars=IDENTIFY_V4=false
```

V3 bleibt dabei immer aktiv als Fallback — kein Downtime.

## UI-Sichtbarkeit

Das Frontend zeigt V4-Provenance automatisch, sobald ein Produkt `ops.data_quality.identify_v4` trägt:
- **Kompakter Badge** (`V4 83%`) inline mit Listing-Status im ProductSheet-Header
- **Full-Banner** oberhalb der Tabs bei `ebay_ready_score < 0.8` oder `needsHumanReview=true` mit max 3 Critic-Issues

Komponente: `components/IdentifyV4Badge.tsx`. Fallback: silently no-op für V3/Legacy-Produkte.

## Referenz-Dateien

**Backend:**
- `backend/services/identify-v4.js` — Orchestrator
- `backend/lib/identify-workers/*.js` — 8 Workers
- `backend/lib/{sweet-spot-pricer,seo-title-builder,seo-description-builder,aspect-cap-enforcer,image-enhance,ebay-sold-listings,ebay-catalog}.js` — pure libraries (Phase A)
- `backend/services/atomic-tools.js` — 9 Gemini function declarations
- `backend/routes/identify.js` — V4-Branch vor V3

**Frontend:**
- `components/IdentifyV4Badge.tsx` — Badge + Banner

**Scripts:**
- `backend/scripts/smoke-identify-v4.js` — Live-Gemini smoke test

## Related Commits

- `4d6edac` feat(identify-v4): phase A foundation libraries (7 libs, 164 tests)
- `8c94182` feat(identify-v4): phase B orchestrator + wave 1 workers + route (65 new tests)
- `896a442` feat(identify-v4): phase C wave 2 domain workers + refinement loop (36 new tests)
- `6a893cb` feat(identify-v4): UI V4 badge + needs-review banner + smoke test
