---
title: Feature-Flag-Katalog
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Feature-Flag-Katalog

> Vollständiger Katalog aller bekannten Backend-ENV-Vars mit Default, Wirkung und Code-Anker.
> Quelle: [CLAUDE.md](../../../CLAUDE.md) §Feature-Flags. Stand: 2026-05-18.

## Identify-Pipeline V4

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `IDENTIFY_V4` | `false` (dark-deployed seit 2026-04-23) | Master-Flag: aktiviert Orchestrator-Worker-Swarm-Pipeline. Wave 1 (identity + category) → Wave 2 (attributes/seo/pricing/image/gpsr) → Refinement-Loop → Critic. Autosave wenn `ebay_ready_score ≥ 0.6`. Fallback bei V4-Error auf V3. | [backend/services/identify-v4.js](../../../backend/services/identify-v4.js) |
| `IDENTIFY_V4_AUTOSAVE` | `true` | Erlaubt Autosave via `saveProductV2()` bei ausreichendem Score. | identify-v4.js |
| `IDENTIFY_V4_MAX_ITERATIONS` | `5` | Max Refinement-Loop-Iterationen pro Identify. | identify-v4.js |
| `IDENTIFY_V4_TIMEOUT_MS` | `180000` (3 min) | Pro-Pipeline-Timeout in V4. | identify-v4.js |
| `IDENTIFY_V4_IMAGE_ENHANCE` | `true` | Image-Worker führt Hintergrund-Removal aus. | [backend/lib/image-enhance.js](../../../backend/lib/image-enhance.js) |
| `IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY` | `true` | Image-Worker klassifiziert Aufnahmewinkel. | image-enhance.js |
| `IDENTIFY_V4_PRICING_SOLD` | `true` | Pricing-Worker nutzt eBay-Sold-Listings. | [backend/lib/ebay-sold-listings.js](../../../backend/lib/ebay-sold-listings.js) |
| `IDENTIFY_V4_CRITIC_FLASH` | `true` | Critic läuft als Flash-Model. | [backend/lib/identify-workers/critic-worker.js](../../../backend/lib/identify-workers/critic-worker.js) |
| `IDENTIFY_V4_CRITIC_HINTS` | `true` | Refinement-Loop konsumiert `critic.resolved.refinement_needed_workers` zusätzlich zur Confidence-Detection. Wave-1-Lock auf `identity`+`category` respektiert. `=false` revertet zu pre-fix Confidence-only-Verhalten. Siehe `mergeRefinementWorkers()`. | identify-v4.js |
| `IDENTIFY_V4_CRITIC_HINTS_VERIFIED` | `false` | Optionaler Promotion-Acknowledge-Flag. Beim Flip von `IDENTIFY_V4=true` in Production loggt [backend/index.js](../../../backend/index.js) Z. 48ff ein Startup-WARN (NIE Throw/Exit), wenn nicht `true`. Operator muss [docs/runbooks/identify-v4-promotion.md](../../runbooks/identify-v4-promotion.md) bestätigen. Best-effort Slack-Alert via `SLACK_ALERTS_URL`. | [backend/index.js](../../../backend/index.js) |
| `IDENTIFY_V4_CANARY_RATE` | `0` | Float 0..1. Randomer Canary-Anteil der V4 nutzt selbst wenn `IDENTIFY_V4=false`. `0.1` = 10 %. | [backend/routes/identify.js](../../../backend/routes/identify.js) Z. 265–289 |
| `IDENTIFY_V4_CANARY_TENANTS` | `''` | Komma-separierte Tenant-IDs die V4 nutzen, unabhängig vom Rate. | [backend/routes/identify.js](../../../backend/routes/identify.js) |

## Identify-Pipeline V3 + Master-Timeouts

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `IDENTIFY_V3` | `true` | Aktiviert Multi-Stage-V3-Pipeline. Bleibt als V4-Fallback. | [backend/services/identify-v3.js](../../../backend/services/identify-v3.js) |
| `IDENTIFY_TOTAL_TIMEOUT_MS` | `360000` (6 min) | Master-Timeout für gesamten `POST /api/identify`. Aligned mit Cloud-Run `--timeout 600` und Frontend `api/client.ts`. | [backend/routes/identify.js](../../../backend/routes/identify.js) |
| `IDENTIFY_GROUNDING` | `true` | V2-Identify mit Google-Search-Grounding aktiviert. | [backend/services/identify-grounding.js](../../../backend/services/identify-grounding.js), [backend/services/job-runner.js](../../../backend/services/job-runner.js) Z. 116 |
| `IDENTIFY_GROUNDING_TIMEOUT_MS` | `90000` (90 s) | Timeout für einzelnen Grounding-Call. | [backend/lib/gemini3-client.js](../../../backend/lib/gemini3-client.js) Z. 500 |

## Identify-Stage-1 (V3) Härtungen

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `STAGE1_IMAGE_QUALITY_GATE` | `true` | Bild-Qualitäts-Analyse (Auflösung, Hintergrund, Perceptual Hash). Filtert NICHT, hängt Metadata an. | [backend/lib/image-quality.js](../../../backend/lib/image-quality.js) |
| `STAGE1_SKIP_FOCUSED_GROUNDING` | `false` | Emergency-Bypass: bei Gemini-Grounding-Outage Stage 1 springt direkt auf V2-Fallback. | [backend/lib/identify-v3-stage1.js](../../../backend/lib/identify-v3-stage1.js) Z. 116 |
| `STAGE1_SKIP_V2_FALLBACK` | `false` | Emergency-Bypass: bei Doppel-Outage läuft Stage 1 ohne Grounding (nur OCR + Images). Massive Quality-Drop. | identify-v3-stage1.js |

## Identify-Stage-2 (V3) Härtungen

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `STAGE2_WEIGHT_WEB_FALLBACK` | `true` | Web-Suche für Produktgewicht wenn Stage 1 leer lieferte. | [backend/lib/weight-web-lookup.js](../../../backend/lib/weight-web-lookup.js) |
| `STAGE2_GPSR_WEB_FALLBACK` | `true` | Hersteller-Impressum-Suche wenn Registry leer. | [backend/lib/gpsr-web-fallback.js](../../../backend/lib/gpsr-web-fallback.js) |

## Identify-Stage-3 (V3) Härtungen

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `STAGE3_ASPECT_ENFORCEMENT` | `true` | Stage 3 füllt systematisch alle eBay-RequiredAspects. Post-Gen-Validation + Backfill mit „Unbekannt". | [backend/lib/identify-v3-stage3.js](../../../backend/lib/identify-v3-stage3.js) |
| `STAGE3_ASPECT_REPAIR` | `true` | Bei > 30 % „Unbekannt"-Quote feuert zweiter Gemini-Call mit fokussiertem Repair-Prompt. | identify-v3-stage3.js |
| `STAGE3_AGENTIC` | `true` | Aktiviert agentic Stage-3-Pipeline (Multi-Tool-Loop research + write_datasheet). 3-Tier-Fallback: agentic → single-shot → V2-record. | [backend/lib/identify-v3-stage3-agentic.js](../../../backend/lib/identify-v3-stage3-agentic.js) Z. 647 `isAgenticEnabled()` |
| `STAGE3_AGENTIC_SAMPLE` | unset (n/a) | Float 0..1, deterministischer Canary-Anteil. **Nur** wirksam wenn `STAGE3_AGENTIC` selbst unset. | identify-v3-stage3-agentic.js |
| `STAGE3_AGENTIC_MAX_ITERATIONS` | `5` | Max Tool-Loop-Iterationen. | identify-v3-stage3-agentic.js |
| `STAGE3_AGENTIC_TIMEOUT_MS` | `90000` | Total-Timeout der agentic Stage 3. | identify-v3-stage3-agentic.js |
| `STAGE3_AGENTIC_TEMPERATURE` | `DEFAULT_CHAT_TEMPERATURE` | Override. | [backend/lib/gemini-config.js](../../../backend/lib/gemini-config.js) |
| `STAGE3_AGENTIC_MAX_TOKENS` | `12000` | `maxOutputTokens`. | identify-v3-stage3-agentic.js |
| `STAGE3_AGENTIC_MAX_IMAGES` | `4` | Max Bilder im Initial-Prompt. | identify-v3-stage3-agentic.js |
| `STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT` | `3` | Soft-Limit für Research-Tool-Calls bevor Modell zum Write gedrängt wird. | identify-v3-stage3-agentic.js |

## GPSR + Category-Resolver

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `IDENTIFY_V3_GPSR_CONSENSUS` | `false` | Drei Modi: `false` legacy `pickFrom()`-Fallback (strikte Priorität Registry > Stage-3 LLM > Web-Fallback). `shadow` läuft beide Pfade parallel und loggt Diffs (`[GPSR-Consensus-Shadow] Diff detected`), aber alter Pfad gewinnt. `true` nutzt `resolveConsensus()` aus [backend/lib/cross-reference.js](../../../backend/lib/cross-reference.js) (Source-Confidenzen: registry 0.85, gemini_inference 0.55, manufacturer_website 0.90). Rollout-Plan: [docs/runbooks/gpsr-consensus-rollout.md](../../runbooks/gpsr-consensus-rollout.md). | [backend/services/identify-v3.js](../../../backend/services/identify-v3.js) `assembleProduct()` |
| `CATEGORY_RESOLVER_V2` | `true` | Mehrstufiger Kategorie-Resolver: eBay Catalog GTIN → Taxonomy Suggestions → Local Lookup → Gemini. Schreibt nur bei `confidence ≥ 0.85`. UI-Save triggert fire-and-forget Auto-Correct für Produkte ohne `categorySource === 'manual'`. | [backend/services/category-resolver.js](../../../backend/services/category-resolver.js) |
| `CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE` | `true` | Confidence dynamisch berechnen statt hard-coded. Boosts: Keyword-Match, Brand-im-Breadcrumb. Penalties: Banned-Breadcrumb, Generic-Levels. | category-resolver.js |

## Quality-Gate

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `QUALITY_GATE_ENABLED` | `true` (= Default an; `=false` schaltet ab) | Aktiviert Quality-Gate-Worker (`startQualityRunner`). | [backend/services/quality-gate.js](../../../backend/services/quality-gate.js), [backend/services/quality-runner.js](../../../backend/services/quality-runner.js) |

## Chat-Assistant

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `CHAT_V3` | `true` (Code-Default — `product-chat-v3.js:80 chatV3Enabled()`; CLAUDE.md korrigiert 2026-05-10) | Aktiviert V3-Pipeline mit Gemini 3 Customtools (googleSearch + urlContext + custom functions + structured output in einem Request). `=false` opt-out. `?pipeline=v2|legacy` pro Request. | [backend/services/product-chat-v3.js](../../../backend/services/product-chat-v3.js) |
| `CHAT_V2_ENHANCED` | `true` | V2-Härtungen: urlContext, Temperature 1.0, Thinking Mode (high, includeThoughts), maxOutputTokens 8192, mediaResolution HIGH. `=false` revertet auf altes V2-Verhalten. | [backend/services/product-chat-v2.js](../../../backend/services/product-chat-v2.js) |
| `CHAT_LEGACY_ENHANCED` | `true` | Legacy-Härtungen: ASIN-Detection, Amazon-Routing via SerpAPI `engine='amazon'`, forceOneEvidencePass bei allen Intents, Thinking Mode, erweitertes Evidence-URL-Scoring. | [backend/services/product-chat.js](../../../backend/services/product-chat.js) |
| `CHAT_GROUNDING` | `true` | Chat-V2 (Google Search Grounding) als Fallback hinter V3. | product-chat-v2.js, [backend/routes/identify.js](../../../backend/routes/identify.js) Z. 1290 |
| `CHAT_MODEL` | via model-select (`gemini-3.1-pro-preview-customtools`) | Optionaler Default-Chat-Model-Override. | [backend/lib/model-select.js](../../../backend/lib/model-select.js) |
| `INTENT_MODEL` | via model-select (`gemini-3-flash-preview`) | Optionaler Intent-Model-Override. | model-select.js |
| `GEMINI_CHAT_MODEL` | unset | Scope-Override (ENV-Key in [backend/lib/llm-prompts/scopes/chat-context.json](../../../backend/lib/llm-prompts/scopes/chat-context.json) `defaultModelEnvKey`). Nur für gezielte Canary/Rollback-Tests pro Scope. | llm-config.js |

## Gemini-Infrastructure

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `GEMINI_PROMPT_CACHE` | `true` | Aktiviert Prompt-Caching. 90 % Cost-Saving auf Sys-Prompts bei wiederholten Calls. Min. 4 096 Tokens Cache-Eligibility, default TTL 60 min. | [backend/lib/prompt-cache.js](../../../backend/lib/prompt-cache.js) |
| `ATOMIC_TOOLS_TIMEOUT_MS` | `15000` (15 s) | Per-Executor-Timeout für atomic-tools (`lookup_gtin`, `search_ebay_catalog`, `get_required_aspects`, `verify_brand`, `search_amazon_product`, `search_manufacturer_site`, `fetch_url_content`). | [backend/services/atomic-tools.js](../../../backend/services/atomic-tools.js) |

## Background-Cron Multi-Tenant (Plan-D.0c)

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `BACKGROUND_JOB_TENANTS` | leer → `['default']` | Fan-out der 6 Safety-Net-Cron-Jobs (`returns-sync`, `sendcloud-sync`, `tracking-catchup`, `delivery-poll`, `invoice-sync`, `refund-push`) + `kaufland-listings-sync`. Bei leerem ENV unverändertes Single-Tenant-Verhalten. Errors per-tenant gefangen + geloggt. | [backend/lib/background-job-tenants.js](../../../backend/lib/background-job-tenants.js), [backend/index.js](../../../backend/index.js) Z. 278ff |
| `STOCK_FAILURE_DRAIN_TENANTS` | `'trendocean'` | Tenant-Liste für Drain-Worker. Separater Default als historisches Erbe (Incident SKU-9871561937). | [backend/index.js](../../../backend/index.js) Z. 511 |
| `STOCK_FAILURE_DRAIN_ENABLED` | `true` (=`!=='false'`) | Drain-Worker abschalten via `=false`. | [backend/services/stock-failure-drain.js](../../../backend/services/stock-failure-drain.js) |
| `STOCK_FAILURE_DRAIN_INTERVAL_MS` | `120000` (2 min) | Drain-Intervall. | [backend/index.js](../../../backend/index.js) Z. 510 |
| `TENANT_ID` | `avycloud` (Scripts-only) | Default-Tenant für CLI-Scripts ohne explizites `--tenant`-Flag. Operator muss explizit `--tenant trendocean` setzen für Multi-Tenant-Runs. NIE für Production-Backend-Code lesen; nur Scripts. | Diverse `backend/scripts/*.js` |

## Observability + External-API

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `EXTERNAL_API_TRACKER_SAMPLE_RATE` | `1.0` | Sample-Rate für `external_api_calls`-Firestore-Writes (Float 0..1). Tracker erfasst pro Call: service, endpoint, success, latencyMs, errorCode — fire-and-forget. Nach Baseline-Daten (~2 Wochen) auf `0.1` drosseln. Genutzt von `/api/health/identify`. | [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js) |
| `SLACK_ALERTS_URL` | unset | Wenn gesetzt, sendet [backend/index.js](../../../backend/index.js) bei `IDENTIFY_V4`-Promotion-Gate-Miss einen best-effort Slack-Alert. | backend/index.js Z. 48ff |

## LLM-Quality-Parity (Phase F.3 + Telemetry)

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `LLM_SCHEMA_STRICT` | `false` | Phase F.3 Stufe 1 (safeParse-warn). Validiert LLM-Responses gegen Zod-Schemas und loggt Warnings bei Fehlern. `=true` für Stufe-2-strict-throw NUR nach ≥ 7 d safeparse-Beobachtung pro Scope ohne neue Violations. | [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md) |
| `LLM_SCHEMA_VALIDATE_RATE` | `1.0` | Sample-Rate für Stufe-1-Logging (Float 0..1). Volume-Drossel für hot scopes. | llm-quality-parity.md |
| `LLM_TELEMETRY_SAMPLE` | `0.1` | Sample-Rate für `llm_call_telemetry`-Schreibungen (Float 0..1). Auto-Downgrade auf 0.1 nach 24 h wenn ENV > 0.5 (Cost-Guard). Runtime-Override via Firestore-Doc `system/llm-telemetry-state` — ENV gewinnt bei Konflikt. | [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js) |
| `LLM_TELEMETRY_SAMPLE_MAX_DURATION_H` | `24` | Auto-Downgrade-Window in Stunden. | llm-quality-parity.md §Cost-Discipline |

## Performance + Timeouts (Backend-allgemein)

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `PORT` | `8080` | HTTP-Port. Cloud Run setzt das selbst. | [backend/index.js](../../../backend/index.js) Z. 36 |
| `API_REQUEST_BODY_LIMIT` / `REQUEST_BODY_LIMIT` | `50mb` | Body-Limit für `express.json` + `urlencoded` (Bild-Uploads). | [backend/index.js](../../../backend/index.js) Z. 37–40 |
| `ORDER_SYNC_TIMEOUT_MS` | `8000` | Safety-Lock-Release-Timer für `backgroundSyncOrders`. | [backend/index.js](../../../backend/index.js) Z. 73 |
| `ORDER_SYNC_THROTTLE_MS` | `60000` | Throttle zwischen `backgroundSyncOrders`-Calls. | [backend/index.js](../../../backend/index.js) Z. 74 |
| `ORDER_SYNC_INTERVAL_MS` | `21600000` (6 h) | Order-Safety-Net-Intervall. | [backend/index.js](../../../backend/index.js) Z. 297 |
| `RETURNS_SYNC_INTERVAL_MS` | `21600000` (6 h) | Returns-Safety-Net-Intervall. | [backend/index.js](../../../backend/index.js) Z. 307 |
| `SENDCLOUD_SYNC_INTERVAL_MS` | `21600000` (6 h) | SendCloud-Safety-Net-Intervall. | [backend/index.js](../../../backend/index.js) Z. 324 |
| `KAUFLAND_LISTINGS_SYNC_INTERVAL_MS` | `900000` (15 min) | Kaufland-Listings-Cache Refresh. | [backend/index.js](../../../backend/index.js) Z. 434 |
| `KAUFLAND_LISTINGS_SYNC_STOREFRONT` | `'de'` | Storefront-Code (klein, getrimmt). | [backend/index.js](../../../backend/index.js) Z. 438 |
| `RESERVATION_CLEANUP_INTERVAL_MS` | `300000` (5 min) | Cleanup-Intervall für `stock_reservations` `expireStaleReservations`. | [backend/index.js](../../../backend/index.js) Z. 455 |
| `RECONCILIATION_INTERVAL_MS` | `1800000` (30 min) | Stock-Reconciliation Activity-Intervall. Full-Scan zusätzlich täglich 03:00–03:29. | [backend/index.js](../../../backend/index.js) Z. 475 |
| `RESTOCK_ALERT_INTERVAL_MS` | `7200000` (2 h) | Restock-Alert-Check für Pending-Return-Restocks. | [backend/index.js](../../../backend/index.js) Z. 535 |

## Auth

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `AUTH_ALLOWED_EMAIL_DOMAIN` | `trendocean.de` | Whitelist E-Mail-Domain. | [backend/lib/auth.js](../../../backend/lib/auth.js) |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | `admin@trendocean.de` | Bootstrap-Admin (umgeht `email_verified`-Check, ist `isAdmin: true`). | [backend/lib/auth.js](../../../backend/lib/auth.js) |

## Data-Layer

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `USE_PRODUCTS_V2` | `true` (Production via [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) `--update-env-vars`) | Schaltet die Lese-/Schreibcollection auf `products_v2`. | [backend/lib/firestore.js](../../../backend/lib/firestore.js) Z. 98–100 |

## Frontend (Vite-Build)

| ENV | Wirkung | Anker |
|-----|---------|-------|
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID` | Pflicht-Build-Variablen für Firebase-SDK. | [.env.example](../../../.env.example), [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml) Z. 14ff |
| `VITE_BACKEND_URL` | Backend-Origin-Override (origin-only Pflicht; CI validiert). | [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml) Z. 49 |
| `VITE_BACKEND_FALLBACK_URLS` | Komma-separierte Backup-Origins. | firebase-hosting.yml |
| `VITE_AUTH_PERSISTENCE` | Firebase Auth Persistence (`'session' \| 'local' \| 'none'`). Code-Default: `'session'`. | firebase-hosting.yml |

## Weitere referenzierte ENV-Vars (nicht in CLAUDE.md kategorisiert)

| ENV | Default | Hinweis |
|-----|---------|---------|
| `GOOGLE_APPLICATION_CREDENTIALS` | unset | Standard-GCP-Pfad zu Service-Account-JSON für lokales Dev. **Annahme** — wird in Cloud Run via metadata-server bereitgestellt. |
| `GEMINI_API_KEY` | unset | API-Key wenn nicht ADC. **Muss verifiziert werden** wie heute genau in Production aufgelöst. |
| `STOCK_LOCK_BACKEND` | unset (in-memory) | Plan-Soll `firestore` (Punkt 12 [CLAUDE.md](../../../CLAUDE.md)). Heute Gap E — siehe [TASKS.md](../../../TASKS.md). |

## F0 Slice 1 — Durable, non-destructive Sync-Recovery (WP1)

Kill-Switches für den durable Stock-Sync-Recovery-Pfad (Master-Plan Teil E, Tasks 4–6).
Beide **default OFF** → exakt heutiges Verhalten. Rollback = Flag auf `false`.

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `SYNC_DURABLE_DRAIN` | `false` | `true` → der Dispatcher persistiert Sync-Failures **synchron** in die durable Queue (statt In-Process-`setTimeout`-Retry) und stempelt `classification` (Klassifizierer) + `nextRetryAt` (Backoff); der Drain retried nur **fällige** Docs (`nextRetryAt <= now`, Legacy-Docs ohne Feld = sofort fällig) und stempelt bei Fehlschlag den nächsten Backoff. `false` = In-Process-30s-Retry wie bisher. | [services/stock-sync-dispatcher.js](../../../backend/services/stock-sync-dispatcher.js) (`durableDrainEnabled`), [services/stock-failure-drain.js](../../../backend/services/stock-failure-drain.js) (`isDue`) |
| `EBAY_QUOTA_BREAKER_SHARED` | `false` | `true` → der In-Process-eBay-Quota-Breaker delegiert zusätzlich an den **Firestore-shared** Breaker (`system/ebay_quota_breaker`, 10s-Cache), sodass alle Cloud-Run-Instanzen gemeinsam zurückfallen. Der synchrone In-Call-Guard bleibt. Fail-safe: ein Breaker-Read-Fehler blockt nie einen Call. | [lib/ebay-trading-api.js](../../../backend/lib/ebay-trading-api.js) (`sharedQuotaBreakerEnabled`), [lib/ebay-quota-breaker.js](../../../backend/lib/ebay-quota-breaker.js) |

> Zugehörige reine Libs (additiv, immer aktiv, kein Flag): [lib/marketplace-error-classifier.js](../../../backend/lib/marketplace-error-classifier.js) (5 Klassen, keine destruktiv), [lib/retry-backoff.js](../../../backend/lib/retry-backoff.js) (60/120/240s, Cap 30 min), [lib/ebay-quota-breaker.js](../../../backend/lib/ebay-quota-breaker.js).

## F1 — Stock-Ledger Shadow (WP3, sicher)

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `STOCK_LEDGER_SHADOW` | `false` | `true` → nach jeder echten Bestandsbewegung (`notifyStockChange`) rechnet das neue Ledger PARALLEL nach (Σ `warehouseEvents.delta` vs. Projektion) und LOGGT nur die Differenz (+ bei Drift ein Doc in `stock_ledger_shadow`). **Ändert NICHTS am Bestand/Verhalten**, fail-safe (Fehler bricht nie die Mutation). Das „messbare Shadow"-Tor vor dem Cutover. | [lib/stock-ledger-shadow.js](../../../backend/lib/stock-ledger-shadow.js), [lib/stock-change-events.js](../../../backend/lib/stock-change-events.js) |
| `STOCK_LEDGER` | (not set) | **CUTOVER — owner-gated, NICHT scharfschalten** ohne Export+PITR+Restore-Probe. Schaltet die Projektion auf den Ledger um (`applyMovement` wird Wahrheit). | [lib/stock-core.js](../../../backend/lib/stock-core.js) (`applyMovement`, dark) |

## F0.X — Best-Offer-/Preis-Schutz (WP2)

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `BEST_OFFER_PRICE_GUARD` | `false` | `true` → vor jedem eBay-Preis-Push (`syncPriceToAllChannels`) wird die Best-Offer-Auto-Ablehnungsschwelle (`MinimumBestOfferPrice`) live via `getEbayItem` gelesen; ein Sofortkaufpreis **≤ Schwelle** wird NICHT gesendet (Status `skipped`, `reason:'best-offer-guard'`) → das Listing kann nicht un-änderbar werden (Incident 2026-06-16). Fail-open: Schwelle nicht lesbar → Push läuft normal. `false` = heutiges Verhalten. | [services/stock-sync-dispatcher.js](../../../backend/services/stock-sync-dispatcher.js) (`bestOfferGuardEnabled`), [lib/best-offer-guard.js](../../../backend/lib/best-offer-guard.js) |

> Zugehörige reine Lib (immer aktiv, kein Flag): [lib/best-offer-guard.js](../../../backend/lib/best-offer-guard.js) (`guardListingPrice`). Lese-Pfad: `mapListingDetail` in [lib/ebay-trading-api.js](../../../backend/lib/ebay-trading-api.js) liest jetzt `minimumBestOfferPrice`/`bestOfferAutoAcceptPrice`/`bestOfferEnabled` in den `observed`-Detail.

## eBay-Listings-Deaktivierung — Confirm-Mode

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `EBAY_DEACTIVATION_CONFIRM_MODE` | `false` | `true` → ein **großer** Listing-Rückgang (über der 60%-Catastrophic-Schwelle) auf einem **vollständigen** eBay-Abruf wird nicht mehr dauerhaft blockiert, sondern über **zwei aufeinanderfolgende vollständige Abrufe bestätigt** (gleiche Active-Set-Größe) und dann ausgeführt → echter Rückgang heilt sich in ~2 Sync-Zyklen, ein einmaliger Fehlabruf wird weiterhin geblockt. Unvollständige Abrufe bleiben hart geblockt. `false` = altes Verhalten (Dauer-Block). Pending-State im Lock-Doc `ops/ebayLightSync.pendingLargeDeactivation`. | [lib/ebay-deactivation-guard.js](../../../backend/lib/ebay-deactivation-guard.js) (`decideLargeDeactivation`), [lib/ebay-direct.js](../../../backend/lib/ebay-direct.js) (`deactivateListingsMissingFromActiveSet`) |

> Hintergrund: 2026-06-22 fror der Sync bei 305 aktiv ein, obwohl eBay nur 106 hatte (199 bewusst beendet = 65% Rückgang → über der 60%-Schwelle → als „kaputter Abruf" fehlinterpretiert). Verwandter Incident 2026-05-26.

## Automatische Rechnungserstellung (B2C)

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `INVOICE_SEVDESK_PUSH` | *(leer = AUS)* | **Nur `on`.** Aus = eine Rechnung landet NIE in SevDesk — sie bleibt in AvyCloud (PDF + Firestore) und ist ein Beleg für den Kunden, keine Buchung. Nummer dann aus `number-sequence.js` Typ `invoice` (`RE-<Jahr>-<0001>`, kollidiert nicht mit SevDesks `RE-1636`). Gatet den Prägeblock in `generateInvoice`, `exportToSevDesk` und die SevDesk-Aufrufe in `createCorrectionInvoice`. **Andere Frage als `AUTO_INVOICE`:** *darf AvyCloud von selbst?* vs. *darf es überhaupt nach SevDesk?* Der Knopf im Auftrag = ja / nein. | [lib/auto-invoice-gate.js](../../../backend/lib/auto-invoice-gate.js) (`invoiceSevdeskPushEnabled`), [services/invoice-engine.js](../../../backend/services/invoice-engine.js) |
| `AUTO_INVOICE` | *(leer = AUS)* | **Nur der exakte Wert `on` schaltet ein** — `true`/`1`/`yes` bewusst NICHT. Aus = AvyCloud erzeugt von sich aus keine Rechnung, Gutschrift oder Stornorechnung mehr. Betroffen: der `bulkGenerateForShippedOrders`-Cron, der `refund-sync`-Cron, der Auto-Beleg beim Übergang auf `shipped`/`picked`, der Auto-Storno beim Stornieren, die Korrekturrechnung bei Retouren, der Massen-Endpunkt `POST /api/invoices/bulk-generate` **und** die Betrags-Zuordnung (±1 €) in `importFromSevDesk`. **Nicht** betroffen (immer erreichbar): `POST /api/orders/:orderId/invoice` (Knopf „Rechnung erstellen" im Auftrag), `POST /api/invoices/:invoiceId/export-sevdesk`, der Lieferschein und das reine Spiegeln von SevDesk. | [lib/auto-invoice-gate.js](../../../backend/lib/auto-invoice-gate.js) (`autoInvoiceEnabled`), [services/invoice-engine.js](../../../backend/services/invoice-engine.js), [services/order-state-machine.js](../../../backend/services/order-state-machine.js), [routes/orders.js](../../../backend/routes/orders.js), [routes/invoices.js](../../../backend/routes/invoices.js), [index.js](../../../backend/index.js) |

> Hintergrund (Betreiber-Anweisung 2026-08-17): TrendOcean ist B2C-Händler und muss keine Rechnung ausstellen; Rechnungen, Gutschriften, Retouren und Stornos rechnen eBay und Kaufland in ihren eigenen Reports ab. Gemessen im SevDesk-Bestand: **467 fällige Rechnungen über 18.158,48 €**, EBIT-Kachel −17.626,30 €, UStVA verzerrt. Ursache war vor allem `bulkGenerateForShippedOrders` — es durchsucht fünf Auftragsstatus **ohne Datumsgrenze**, 5 Minuten nach *jedem* Prozessstart und danach alle 24 h; jeder Cloud-Run-Neustart war ein Volldurchlauf über die gesamte Historie.
>
> **Vier weitere Automatik-Wege** (SendCloud-Webhook, eBay-Abgleich, Kaufland-Abgleich, SendCloud-Paket-Sync) lösen die Rechnung nicht selbst aus, sondern über `transitionOrder(… 'shipped')` — sie sind durch das eine Gate in der State-Machine mit abgedeckt.
>
> **Vor jedem Flip auf `on` lesen:** `generateInvoice` verwendet `order.invoiceSevdeskId` als „schon geprägt"-Marker **wieder** ([invoice-engine.js:285](../../../backend/services/invoice-engine.js#L285), Schutz gegen den Doppel-Rechnungs-Vorfall vom 20.07.2026). Zeigt das Feld auf einen in SevDesk gelöschten Beleg, läuft jeder Versuch gegen eine tote ID und der Auftrag bekommt **nie wieder** eine Rechnung. Deshalb räumt [scripts/purge-invoices.js](../../../backend/scripts/purge-invoices.js) SevDesk und Firestore immer zusammen auf.

## Duplikat-Suche beim Erfassen (seit 2026-08-18)

| ENV | Default | Wirkung | Anker |
|-----|---------|---------|-------|
| `DEDUP_SEARCH` | `on` (`off`\|`shadow`\|`on`) | Sucht nach der Identifikation, ob das Produkt schon existiert — nicht nur über Barcodes. `off` = exaktes Verhalten vor 2026-08-18 (reiner Barcode-Vergleich). `shadow` = entscheidet und protokolliert, liefert den Treffer aber NICHT aus (Beobachtungsmodus). `on` = ein gefundenes Bestandsprodukt wird wiederverwendet, es entsteht kein zweites Datenblatt und keine zweite SKU. | [services/duplicate-search.js](../../../backend/services/duplicate-search.js), [routes/identify.js](../../../backend/routes/identify.js) (`findReuseMatch`) |
| `DEDUP_JUDGE_MIN_CONFIDENCE` | `0.85` | Ab welcher Sicherheit ein KI-Urteil „gleiches Produkt" als Treffer zählt. Darunter wird regulär neu angelegt. | [services/duplicate-judge.js](../../../backend/services/duplicate-judge.js) |
| `CATALOG_INDEX_TTL_MS` | `300000` (5 min) | Gültigkeit des Katalog-Index im Speicher. Ein fehlgeschlagenes Nachladen behält den letzten guten Stand — ein leerer Index fände keine Duplikate. | [lib/catalog-index.js](../../../backend/lib/catalog-index.js) |

> **Warum:** Der Duplikat-Check verglich ausschließlich Barcodes ([findProductByStrictIdentifier](../../../backend/lib/firestore.js#L3231) prüft `identification.barcodes`, `details.identifiers.ean`, `.gtin`, `.sku` — sonst nichts). Ohne lesbaren Barcode entstand IMMER ein neues Datenblatt mit neuer SKU. Gemessen aus der Konfliktanalyse vom 08.07.2026: **64 Paare „gleiches Produkt zweimal erfasst"**, 30 davon mit Bestand. Die Herstellernummer war nicht verdrahtet, obwohl 581 von 765 Bestandsprodukten eine haben.
>
> **Die eigentliche Lücke war ein Gate:** `if (hasReuseBarcode)` sperrte die Prüfung genau für die Produkte aus, um die es geht. Ohne Barcode wurde `findReuseMatch` nie aufgerufen.
>
> **Rollenverteilung (nicht verhandelbar, Lehre aus Incident 2026-07-08):** Kandidaten werden DETERMINISTISCH gefunden ([lib/product-match.js](../../../backend/lib/product-match.js)). Die KI darf einen vorgelegten Kandidaten nur BESTÄTIGEN oder VERWERFEN — nennt ihr Urteil eine ID, die nicht in der Vorlage stand, wird es verworfen. Würde die KI den Schlüssel liefern, wäre der Suchraum wieder die ganze Datenbank und eine Halluzination träfe ein beliebiges fremdes Datenblatt (damals: drei ATE-Produkte auf einem).
>
> **Drei Stufen, nur die letzte ist KI:** (1) Marke + Herstellernummer stimmen überein → sicherer Treffer ohne KI-Aufruf. (2) Modellnummer / Namensüberlappung → Kandidaten. (3) KI urteilt über die Kandidaten mit den Fotos.
>
> **Absicherung der ersten Stufe:** widersprechen sich die Bezeichnungen bei gleicher Herstellernummer deutlich, wird der Treffer NICHT blind übernommen, sondern der KI vorgelegt. Die Schwelle (0,5 Zeichen-Bigramm-Dice) ist gemessen, nicht geschätzt: gleiche Produkte lagen bei 0,667–0,848, verschiedene bei 0,267–0,400. Wort-Token taugen im Deutschen nicht — „Belagsatz" und „Bremsbelagsatz" teilen kein einziges Wort.
>
> **Fehlerrichtung:** im Zweifel KEIN Treffer. Ein verpasstes Duplikat kostet ein zusätzliches Datenblatt, das ein Mensch zusammenführen kann; ein falscher Treffer überschreibt ein fremdes, womöglich handgepflegtes Datenblatt. Fehler in der Suche brechen die Erfassung nie ab — dann wird angelegt wie vorher.
>
> **Sichtbarkeit:** wird ein Bestandsprodukt wiederverwendet, zeigt der Prüfschritt der Erfassung ein bleibendes Hinweisfeld ([utils/reuseNotice.ts](../../../utils/reuseNotice.ts), [components/capture/StepReview.tsx](../../../components/capture/StepReview.tsx)). Ohne diesen Hinweis hielte der Bediener die Bestandsdaten für das Ergebnis der frischen Erkennung — die Datenverlust-Klasse aus [CLAUDE.md](../../../CLAUDE.md) Punkt 16.

## Hinweise

- **ENV-Var-Rename** ist verboten, wenn sie in CI/CD referenziert wird (Punkt 4 [CLAUDE.md](../../../CLAUDE.md)).
- **Neue ENV-Vars** MÜSSEN in dieser Datei dokumentiert werden (Post-Flight-Checklist [AGENTS.md](../../../AGENTS.md)).
- **Production-ENV-Katalog** mit Secret-Manager-Referenzen: [04-deployment/env-vars.md](../04-deployment/env-vars.md).
- **Identify-V4-Promotion** Runbook: [docs/runbooks/identify-v4-promotion.md](../../runbooks/identify-v4-promotion.md).
- **GPSR-Consensus-Rollout** Runbook: [docs/runbooks/gpsr-consensus-rollout.md](../../runbooks/gpsr-consensus-rollout.md).
