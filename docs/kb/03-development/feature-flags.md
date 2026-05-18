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

## Hinweise

- **ENV-Var-Rename** ist verboten, wenn sie in CI/CD referenziert wird (Punkt 4 [CLAUDE.md](../../../CLAUDE.md)).
- **Neue ENV-Vars** MÜSSEN in dieser Datei dokumentiert werden (Post-Flight-Checklist [AGENTS.md](../../../AGENTS.md)).
- **Production-ENV-Katalog** mit Secret-Manager-Referenzen: [04-deployment/env-vars.md](../04-deployment/env-vars.md).
- **Identify-V4-Promotion** Runbook: [docs/runbooks/identify-v4-promotion.md](../../runbooks/identify-v4-promotion.md).
- **GPSR-Consensus-Rollout** Runbook: [docs/runbooks/gpsr-consensus-rollout.md](../../runbooks/gpsr-consensus-rollout.md).
