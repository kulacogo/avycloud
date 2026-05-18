---
title: "Integration: Google Gemini"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Google Gemini (Generative AI)

> KI-Backbone für **Identify-V3/V4** (Produktanlage), **Chat-V3** (Assistant), **Vision** (Bild-Analyse), **Function-Calling** (atomic-tools), **Grounding** (Google Search), **Structured-Output**.
> Nicht in der `integration-registry.js` — Gemini ist Infrastruktur, kein Settings-konfigurierbarer Provider.

## Was integriert ist

- **Text-Generation** (klassisch + Thinking-Mode + Thoughts-Streaming)
- **Vision** (multi-image, multi-resolution: LOW/MEDIUM/HIGH/ULTRA_HIGH)
- **Function Calling** (Custom Tools + atomic-tools-Library)
- **Google Search Grounding** (Identify-V2, Chat-V2)
- **URL-Context** (Chat-V3 für direktes URL-Reading)
- **Structured Output** (`response_schema` + Zod-Validation, siehe `LLM_SCHEMA_STRICT`)
- **Context-Caching** (90% Kosten-Ersparnis für System-Prompts mit ≥4096 Tokens)
- **Telemetry-Sampling** (siehe CLAUDE.md §LLM-Quality-Parity)

## Auth + Credentials

### API-Key (Standard)

- Modul: [backend/lib/gemini-client.js](../../../backend/lib/gemini-client.js) (`@google/generative-ai` SDK) + [backend/lib/gemini3-client.js](../../../backend/lib/gemini3-client.js) (`@google/genai` SDK für Gemini 3).
- Resolution-Reihenfolge in `getGeminiApiKey()`:
  1. `process.env.GEMINI_API_KEY`
  2. `process.env.GOOGLE_GENAI_API_KEY`
  3. `getSecretValue('GEMINI_API_KEY')`
  4. `getSecretValue('GOOGLE_GENAI_API_KEY')`
- Wenn nichts gefunden: harter Throw `'Gemini API key is not configured…'`.
- Cache: `cachedKey` und `cachedKeySource` in-process; kein TTL — Restart nach Rotation nötig.

### Service-Account (alternativ, nicht primär genutzt)

- Gemini ist Teil von **Google AI Studio** (API-Key-basiert), nicht Vertex AI. Service-Account-Auth wird im Code **nicht verwendet** — ADC ist nur für Firestore/Secret-Manager relevant, nicht für Gemini-Calls.
- Wenn jemand auf Vertex umschalten will: Vertex AI hätte Service-Account-Auth + Region-Pinning (`europe-west3`), aber das ist ein größerer Umbau (anderer SDK-Endpoint).

### Direct-Fetch-Fallback (`gemini.js`)

- [backend/lib/gemini.js](../../../backend/lib/gemini.js) macht raw `fetch` gegen `https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key=…`.
- Nutzt direkt `process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY` (kein Secret-Manager-Fallback) — Legacy-Pfad.

## Hauptendpoints (call sites im Code)

### Zentrale Module

| Datei | Zweck |
|-------|-------|
| [backend/lib/gemini-config.js](../../../backend/lib/gemini-config.js) | Defaults (Model, Temperature, Thinking, Safety, MediaResolution) |
| [backend/lib/gemini-client.js](../../../backend/lib/gemini-client.js) | `@google/generative-ai` Wrapper (`callGeminiVision`) |
| [backend/lib/gemini3-client.js](../../../backend/lib/gemini3-client.js) | `@google/genai` Wrapper (Customtools, Grounding, URL-Context) |
| [backend/lib/gemini-retry.js](../../../backend/lib/gemini-retry.js) | Retry mit Backoff |
| [backend/lib/gemini-structured.js](../../../backend/lib/gemini-structured.js) | Structured-Output + Zod-Schema-Validation |
| [backend/lib/model-select.js](../../../backend/lib/model-select.js) | Per-Scope-Model-Override (Phase F.1b) |
| [backend/lib/prompt-cache.js](../../../backend/lib/prompt-cache.js) | Context-Caching |
| [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js) | Tracker-Wrap (`external_api_calls`) |

### Default-Models

Aus [backend/lib/gemini-config.js](../../../backend/lib/gemini-config.js):

| Konstante | Default | Override |
|-----------|---------|----------|
| `DEFAULT_MODEL` | `gemini-3.1-pro-preview-customtools` | `CHAT_MODEL`, `IDENTIFY_MODEL` |
| `FLASH_MODEL` | `gemini-3-flash-preview` | `INTENT_MODEL` |
| `IMAGE_MODEL` | `gemini-3-pro-image-preview` | — |
| `DEFAULT_CHAT_TEMPERATURE` | `1.0` (Gemini 3 empfiehlt high temp gegen Looping) | per-Call-Override |
| `DEFAULT_STRUCTURED_TEMPERATURE` | `0.4` | per-Call |

### Generation-Defaults

```js
buildGenerationConfig({ maxOutputTokens: 8192, temperature: 1.0 })
```

Plus Thinking-Mode (`thinkingLevel: 'high'`, `includeThoughts: true`) und Safety-Settings (`BLOCK_MEDIUM_AND_ABOVE` für Harassment / Hate / Sexual / Dangerous).

### Endpoint-Übersicht

- SDK `@google/genai` → `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- SDK `@google/generative-ai` → identisch
- Direct-Fetch in `gemini.js` → identisch

Alle Calls können (optional) durch `instrumentExternalCall('gemini', …)` getrackt werden für `external_api_calls` Telemetrie.

## Webhooks

**Keine.** Gemini ist request/response, kein Push.

## Rate-Limits + Quotas

- **API-Quotas** je nach Google AI Studio Tier (free vs paid):
  - Free Tier: typischerweise ~15 RPM, ~1 M Tokens/Tag (variiert).
  - Paid Tier: höher, dokumentiert in der Google-AI-Studio-Console.
- **Modell-Capping ENV-Vars:**
  - `IDENTIFY_TOTAL_TIMEOUT_MS=360000` (6 min Master-Timeout)
  - `IDENTIFY_GROUNDING_TIMEOUT_MS=90000` (Grounding-Call)
  - `STAGE3_AGENTIC_TIMEOUT_MS=90000` (Agentic Stage 3)
  - `ATOMIC_TOOLS_TIMEOUT_MS=15000` (atomic-tools)
- **Telemetry-Sample:** `LLM_TELEMETRY_SAMPLE=0.1` default (Auto-Downgrade nach 24 h wenn >0.5).
- **Schema-Validation:** `LLM_SCHEMA_STRICT=false` (Stufe-1 safeparse-warn), `LLM_SCHEMA_VALIDATE_RATE=1.0`.
- **Prompt-Cache:** `GEMINI_PROMPT_CACHE=true` (default), Min. 4096 Tokens, default TTL 60 min.

Retries via `gemini-retry.js`: exponentielles Backoff für 429/503/transient errors.

## Bekannte Schwächen

- **API-Key ist single-tenant, in-memory cached.** Rotation = Restart. Kein automatic key-rotation-detect.
- **Mehrere SDK-Versionen koexistieren:** `@google/generative-ai` (Gemini 1.5-Pfade) + `@google/genai` (Gemini 3 + Customtools). Module wechseln je nach Caller — Risiko inkonsistenter Defaults wenn neue Code-Pfade nicht über `gemini-config.js` gehen.
- **`lib/gemini.js` (direct-fetch) liest nur `process.env`** — Secret-Manager-Fallback fehlt. Legacy-Pfade können bei fehlendem ENV ungrazil failen.
- **Vertex-AI-Migration nicht eingeplant.** Wenn Google AI Studio API-Limits limitierend werden, müsste das auf Vertex umgezogen werden (Region `europe-west3` für Datenschutz). Aktuell kein Plan.
- **`includeThoughts: true` exposed Modell-Reasoning** — wenn Logs unredacted in Cloud Logging landen, kann sensitive Reasoning-Information leaken.
- **Promotion-Gate für `IDENTIFY_V4=true`:** wenn `IDENTIFY_V4_CRITIC_HINTS_VERIFIED !== 'true'`, loggt das Backend Startup-WARN (NIE throw). Best-effort Slack-Alert via `SLACK_ALERTS_URL`. Operator-Akknowledge ist Pflicht (`docs/runbooks/identify-v4-promotion.md`).
- **Telemetry-Auto-Downgrade auf 0.1** nach 24 h wenn ENV-Wert >0.5 ist nicht idempotent — nach Restart wird wieder der ENV-Wert genommen, bis 24 h später erneut downgegradet wird.
- **Safety-Settings:** `BLOCK_MEDIUM_AND_ABOVE` für alle Kategorien — Produktbeschreibungen können bei dual-use-Produkten (Werkzeug, Chemie) gefiltert werden. Workaround: Per-Call-Override. Keine automatische Detection.

## Owner / Docs

- **Code-Owner:** Backend-Team / AI-Sub-Team.
- **Externe Doku:**
  - Google AI Studio: [aistudio.google.com](https://aistudio.google.com/)
  - API-Reference: [ai.google.dev/api](https://ai.google.dev/api)
  - `@google/genai` SDK: [github.com/google-gemini/generative-ai-js](https://github.com/google-gemini/generative-ai-js)
  - Thinking-Mode: [ai.google.dev/gemini-api/docs/thinking](https://ai.google.dev/gemini-api/docs/thinking)
  - Grounding (Search): [ai.google.dev/gemini-api/docs/grounding](https://ai.google.dev/gemini-api/docs/grounding)
  - Context-Caching: [ai.google.dev/gemini-api/docs/caching](https://ai.google.dev/gemini-api/docs/caching)
- **Verwandte KB-Seiten:**
  - [07-llm/](../07-llm/) — Pipeline-Details, Worker-Architektur
  - CLAUDE.md §Chat-Assistant-Architektur + §Identify-Module-Härtungen
- **LLM-Quality-Parity-Charta:** [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md)
