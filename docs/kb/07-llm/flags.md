---
title: LLM-Feature-Flags — Konsolidierte ENV-Var-Referenz
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# LLM-Feature-Flags (konsolidiert)

> Alle LLM-bezogenen ENV-Vars in einer Tabelle. Source-of-Truth ist [CLAUDE.md](../../../CLAUDE.md) "Feature-Flags"-Sektion; diese Seite spiegelt + bündelt sie KB-tauglich. Defaults sind die im Code aktiven, nicht-überschriebenen Werte.

## 1. Identify-V4 (Orchestrator-Wave-Swarm)

| ENV | Default | Wirkung |
|---|---|---|
| `IDENTIFY_V4` | `false` (default OFF, dark-deployed seit 2026-04-23) | Aktiviert die V4-Orchestrator-Pipeline ([services/identify-v4.js](../../../backend/services/identify-v4.js)). Bei OFF + ohne Canary läuft V3. |
| `IDENTIFY_V4_AUTOSAVE` | `true` | `saveProductV2` nach Critic wenn `ebay_ready_score ≥ 0.6` und identity+category OK. |
| `IDENTIFY_V4_MAX_ITERATIONS` | `5` | Max Refinement-Loop-Iterationen. |
| `IDENTIFY_V4_WAVE_TIMEOUT_MS` | `60000` | Per-Wave-Timeout (Worker `Promise.race` gegen diesen Wert). |
| `IDENTIFY_V4_TIMEOUT_MS` | `180000` (3 min) | Pipeline-Gesamt-Timeout. Bei Überschreitung: `{ ok:false, fallback:'v3' }`. |
| `IDENTIFY_V4_IMAGE_ENHANCE` | `true` | Image-Worker Hintergrund-Cleanup + Angle-Classify. |
| `IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY` | `true` | Sub-Feature des Image-Workers. |
| `IDENTIFY_V4_PRICING_SOLD` | `true` | Sweet-Spot-Pricing nutzt eBay SOLD-Listings. |
| `IDENTIFY_V4_CRITIC_FLASH` | `true` | Critic läuft auf `gemini-3-flash-preview` (statt Pro). |
| `IDENTIFY_V4_CRITIC_HINTS` | `true` | Refinement-Loop konsumiert `critic.refinement_needed_workers` zusätzlich zur Confidence-Detection. `false` → pre-fix Confidence-only-Verhalten. |
| `IDENTIFY_V4_CRITIC_HINTS_VERIFIED` | `false` | Promotion-Acknowledge — Operator hat das Runbook (`docs/runbooks/identify-v4-promotion.md`) gelesen und Best-effort-Slack-Alert akzeptiert. |
| `IDENTIFY_V4_MODEL` | resolveModel-Default = `gemini-3.1-pro-preview-customtools` | Per-Pipeline-Override-Slot. |
| `IDENTIFY_V4_IMAGE_MODEL` | `gemini-3-pro-image-preview` | Image-Enhance-Modell-Override (NICHT in `ALLOWED_MODELS`, daher direkter Lookup). |
| `IDENTIFY_V4_CANARY_RATE` | `0` (0..1 Float) | Randomer Canary-Anteil — Routing-Layer schickt N% der Requests an V4 auch bei `IDENTIFY_V4=false`. |
| `IDENTIFY_V4_CANARY_TENANTS` | (leer) | Komma-separierte Tenant-IDs die V4 nutzen, unabhängig von Rate. |

## 2. Identify-V3 (Multi-Stage Pipeline)

| ENV | Default | Wirkung |
|---|---|---|
| `IDENTIFY_V3` | `true` | Multi-Stage Identify-Pipeline ([services/identify-v3.js](../../../backend/services/identify-v3.js)). Aktuell der V4-Fallback. Produktions-ready. |
| `IDENTIFY_MODEL` | resolveModel-Default | Override für `resolveIdentifyModel()`. |
| `IDENTIFY_GROUNDING` | `true` | Aktiviert Google Search Grounding in V2-Pipeline ([services/identify-grounding.js](../../../backend/services/identify-grounding.js)). |
| `IDENTIFY_GROUNDING_TIMEOUT_MS` | `90000` | Per-Grounding-Call-Timeout in `gemini3-client.js`. |
| `IDENTIFY_TOTAL_TIMEOUT_MS` | `360000` (6 min) | Master-Timeout für `POST /api/identify` — aligned mit Cloud-Run `--timeout 600` + Frontend `api/client.ts`. |
| `IDENTIFY_THINKING_LEVEL` | `high` (`low`/`medium`/`high`/`off`/`false`/`0`/`none`) | Thinking-Level der Identify-Calls. `off` schaltet `thinkingConfig` komplett ab. |
| `IDENTIFY_URL_CONTEXT` | `true` | `urlContext`-Tool für Identify-Grounding/Recognition. |
| `IDENTIFY_TEMP_RECOGNITION` | `0.4` (`DEFAULT_STRUCTURED_TEMPERATURE`) | Temperature Stage 1 focused JSON. |
| `IDENTIFY_TEMP_GROUNDING` | `0.6` | Temperature outer-Grounding. |
| `IDENTIFY_TEMP_CONTENT` | `0.7` | Temperature Stage 3 Content-Generation. |
| `IDENTIFY_MAX_TOKENS_RECOG` | `4096` | maxOutputTokens Stage 1. |
| `IDENTIFY_MAX_TOKENS_GROUND` | `8192` | maxOutputTokens Grounding. |
| `IDENTIFY_MAX_TOKENS_CONTENT` | `8192` | maxOutputTokens Stage 3. |
| `IDENTIFY_RECOGNITION_TIMEOUT_MS` | `45000` | Per-Call-Timeout Stage 1. |
| `STAGE3_GEMINI_TIMEOUT_MS` | `60000` | Per-Call-Timeout Stage 3 (single-shot). |
| `IDENTIFY_V3_GPSR_CONSENSUS` | `false` (`false`\|`shadow`\|`true`) | GPSR-Merge in `assembleProduct()`. `shadow` = beide Pfade laufen, alt gewinnt, Diff geloggt. `true` = `resolveConsensus()` aus `lib/cross-reference.js`. |
| `STAGE4_CROSS_REFERENCE` | `true` | Stage-4b Cross-Reference-Pass (additiv). |
| `QUALITY_GATE_ENABLED` | `true` | Quality-Gate-Check (`services/quality-gate.js`). |

## 3. Identify Stage 1 / 2 / 3 Sub-Härtungen

| ENV | Default | Wirkung |
|---|---|---|
| `STAGE1_IMAGE_QUALITY_GATE` | `true` | Bild-Qualitäts-Metadata in Stage 1 (Auflösung, Hintergrund, aHash). |
| `STAGE1_SKIP_FOCUSED_GROUNDING` | `false` | Emergency-Bypass bei Grounding-API-Outage. Stage 1 springt direkt zum V2-Fallback. |
| `STAGE1_SKIP_V2_FALLBACK` | `false` | Emergency-Bypass für Doppel-Outage (beide Grounding-APIs broken). |
| `STAGE2_WEIGHT_WEB_FALLBACK` | `true` | Web-Lookup für Gewicht wenn Stage 1 OCR/Grounding leer. |
| `STAGE2_GPSR_WEB_FALLBACK` | `true` | Hersteller-Impressum-Web-Lookup wenn Registry leer. |
| `STAGE3_ASPECT_ENFORCEMENT` | `true` | Stage 3 füllt systematisch alle eBay-RequiredAspects + Backfill `Unbekannt`. |
| `STAGE3_ASPECT_REPAIR` | `true` | Zweiter Gemini-Call zur Reparatur wenn > 30 % der required Aspects `Unbekannt`. |
| `STAGE3_AGENTIC` | `true` | Agentic Stage-3-Pipeline (Multi-Tool-Loop). 3-Tier-Fallback: agentic → single-shot → V2-record. |
| `STAGE3_AGENTIC_SAMPLE` | (unset → fallback an `STAGE3_AGENTIC`) | Float 0..1 Canary — nur wirksam wenn `STAGE3_AGENTIC` unset. |
| `STAGE3_AGENTIC_MAX_ITERATIONS` | `5` | Max Tool-Loop-Iterationen. |
| `STAGE3_AGENTIC_TIMEOUT_MS` | `90000` | Total-Timeout Stage 3 agentic. |
| `STAGE3_AGENTIC_TEMPERATURE` | `DEFAULT_CHAT_TEMPERATURE` (`1.0`) | Override für agentic Stage 3. |
| `STAGE3_AGENTIC_MAX_TOKENS` | `12000` | maxOutputTokens für agentic Calls. |
| `STAGE3_AGENTIC_MAX_IMAGES` | `4` | Max Bilder im Initial-Prompt. |
| `STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT` | `3` | Soft-Limit für Research-Tool-Calls bevor Modell zum Write gedrängt wird. |

## 4. Category-Resolver

| ENV | Default | Wirkung |
|---|---|---|
| `CATEGORY_RESOLVER_V2` | `true` | Mehrstufiger Kategorie-Resolver ([services/category-resolver.js](../../../backend/services/category-resolver.js)) — eBay Catalog GTIN → Taxonomy Suggestions → Local Lookup → Gemini. Schreibt nur bei `confidence ≥ 0.85`. UI-Save triggert fire-and-forget Auto-Correct für Produkte ohne `categorySource === 'manual'`. |
| `CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE` | `true` | Dynamische Confidence-Berechnung (Boosts: Keyword-Match, Brand-im-Breadcrumb. Penalties: Banned-Breadcrumb, Generic-Levels). |

## 5. Chat-Assistant V3 / V2 / Legacy

| ENV | Default | Wirkung |
|---|---|---|
| `CHAT_V3` | `true` (Code-Default in `product-chat-v3.js chatV3Enabled()`) | Aktiviert Chat-V3-Pipeline (Gemini 3.1 Pro Customtools mit Context Circulation: googleSearch + urlContext + atomic-tools + structured output). Cascade-Fallback V3 → V2 → Legacy. |
| `CHAT_V2_ENHANCED` | `true` | Gemini-3-Enhancements in V2 (urlContext, Temperature 1.0, Thinking Mode level=high includeThoughts, maxOutputTokens 8192, mediaResolution HIGH). `false` → originales V2-Verhalten. |
| `CHAT_LEGACY_ENHANCED` | `true` | Legacy-Pipeline-Härtungen: ASIN-Detection, Amazon-Routing via SerpAPI `engine='amazon'`, `forceOneEvidencePass` bei allen Intents, Thinking Mode. |
| `CHAT_MODEL` | resolveModel-Default = `gemini-3.1-pro-preview-customtools` | Override für `resolveChatModel()`. |
| `INTENT_MODEL` | resolveModel-Default = `gemini-3-flash-preview` | Override für Intent-Detection (Flash). |
| `CHAT_GROUNDING` | `true` | Chat-V2-Pipeline (Google Search Grounding) als Fallback hinter V3. |
| `CHAT_IMAGE_TIMEOUT_MS` | `8000` | Per-Image-Part-Timeout in Chat V2/V3 (Produkt-Bilder-Anhang). |
| `GEMINI_RETRY_PER_ATTEMPT_TIMEOUT_MS` | `30000` | Per-Attempt-Timeout für `withGeminiRetry` (Chat V3 + V2). Vermeidet 90-s-Socket-Stalls bei Gemini regional outages. |
| `GEMINI_CHAT_MODEL` | — | Optional Override, gelesen via `chat-context.json defaultModelEnvKey`. |
| `GEMINI_IDENTIFY_MODEL` | — | Optional Override, gelesen via `identify-*.json defaultModelEnvKey`. |

## 6. LLM-Helper (gemini3-client + gemini-structured)

| ENV | Default | Wirkung |
|---|---|---|
| `GEMINI_MODEL` | — | Override für `gemini3GenerateJSON`/`gemini3GenerateText` lokalen `DEFAULT_MODEL`. |
| `GEMINI_GENERIC_TIMEOUT_MS` | `30000` | SDK-Level Safety-Net für `httpOptions.timeout` in Generic-Calls. |
| `GEMINI_STRUCTURED_MODEL` | — | Override für `gemini-structured.getStructuredModelName()`. |
| `GEMINI_MULTIMODAL_MODEL` | — | Erster Lookup in `getStructuredModelName()` chain. |
| `ATOMIC_TOOLS_TIMEOUT_MS` | `15000` | Per-Executor-Timeout für atomic-tools (`lookup_gtin`, `search_ebay_catalog`, …). |

## 7. Prompt-Cache (NICHT WIRKSAM)

| ENV | Default | Wirkung (sobald Call-Sites existieren) |
|---|---|---|
| `GEMINI_PROMPT_CACHE` | `true` | Aktiviert Prompt-Caching via `lib/prompt-cache.js`. Default ON — aber **keine Production-Call-Sites** (siehe [caching.md](caching.md)). |

## 8. Schema-Validation + Telemetrie

| ENV | Default | Wirkung |
|---|---|---|
| `LLM_SCHEMA_STRICT` | `false` | Phase F.3 Stufe 1 (safeParse + warn). `true` → Stufe 2 (parse + throw). NUR nach min. 7d safeparse-Beobachtung pro Scope ohne Violations. |
| `LLM_SCHEMA_VALIDATE_RATE` | `1.0` | Sample-Rate für Stufe-1-Logging (Float 0..1). Volume-Drossel für hot scopes. |
| `LLM_TELEMETRY_SAMPLE` | `0.1` | Sample-Rate für `llm_call_telemetry`-Writes. Auto-Downgrade auf 0.1 nach 24 h wenn ENV-Wert > 0.5. ENV gewinnt über Firestore-State. |
| `LLM_TELEMETRY_SAMPLE_MAX_DURATION_H` | `24` (Charta) | Auto-Downgrade-Window (Charta §4). |
| `LLM_PARITY_DRIFT_THRESHOLD` | `0.15` | Drift-Alert-Schwelle für Quality-Gap zwischen Pipelines (`llm-parity-dashboard.js`). |

## 9. External-API-Tracker

| ENV | Default | Wirkung |
|---|---|---|
| `EXTERNAL_API_TRACKER_SAMPLE_RATE` | `1.0` | Sample-Rate für `external_api_calls`-Writes. Nach ~2 Wochen Baseline auf `0.1` drosseln. |

## 10. Multi-Tenant / Background-Jobs

| ENV | Default | Wirkung |
|---|---|---|
| `BACKGROUND_JOB_TENANTS` | (leer = single tenant `'default'`) | Komma-separiert — Multi-Tenant-Fan-Out der 6 safety-net cron jobs (returns-sync, sendcloud-sync, tracking-catchup, delivery-poll, invoice-sync, refund-push). |
| `STOCK_FAILURE_DRAIN_TENANTS` | siehe CLAUDE.md | Multi-Tenant-Pattern für Stock-Failure-Drain-Worker. |
| `TENANT_ID` | `avycloud` | Default-Tenant für CLI-Scripts (nur Scripts, NIE Backend-Code). Operator muss explizit `--tenant <id>` setzen. |

## 11. Snapshot — was steht aktuell auf "lebt nicht"?

| Flag / Feature | Status | Ursache |
|---|---|---|
| `GEMINI_PROMPT_CACHE` | Code-Default ON, aber wirkungslos | keine Production-Call-Sites (siehe [caching.md](caching.md)) |
| `LLM_TELEMETRY_SAMPLE` greift, ABER … | … `llm_call_telemetry` bleibt leer | kein Production-Code ruft `logLlmCall()` (siehe [telemetry.md](telemetry.md)) |
| `LLM_SCHEMA_STRICT` für Identify-Hot-Paths | NICHT WIRKSAM dort | `identifyProductFocused`, `identifyProductWithGrounding`, `generateProductContent` liefern keinen `scopeConfig` an `_validateAgainstScope` |
| `IDENTIFY_V4_CRITIC_HINTS_VERIFIED` | Promotion-Acknowledge nur Warn-Log | keine Hard-Failure wenn vergessen — siehe `backend/index.js` Startup-Warn |

Quelle für Drift-Analyse: `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md` (Top-7-Finding #7, Wave 4).

## 12. Verweise

- CLAUDE.md "Feature-Flags"-Sektion: [CLAUDE.md](../../../CLAUDE.md).
- KB-Detail-Seiten: [models.md](models.md), [pipelines.md](pipelines.md), [prompts.md](prompts.md), [tools.md](tools.md), [caching.md](caching.md), [telemetry.md](telemetry.md), [cost-and-budgets.md](cost-and-budgets.md).
- Charta: [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md).
- Promotion-Runbook: [docs/runbooks/identify-v4-promotion.md](../../runbooks/identify-v4-promotion.md).
- Alerts: [docs/runbooks/alerts.md](../../runbooks/alerts.md).
