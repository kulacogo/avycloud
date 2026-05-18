---
title: LLM-Telemetrie — Status, Endpoints, Schema-Validation
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# LLM-Telemetrie

> **STATUS: LOGGER + DASHBOARD VORHANDEN, ABER KEINE PRODUCTION-WRITER.** Das Modul `lib/llm-telemetry.js` kann LLM-Call-Events in Firestore `llm_call_telemetry` schreiben — aber **kein Production-Code-Pfad** ruft `logLlmCall()` auf. Folge: der Admin-Endpoint `/api/admin/llm-parity` (live) meldet immer leere Daten.

## 1. Die zwei Telemetrie-Layer

| Layer | Datei | Was es trackt | Status |
|---|---|---|---|
| **LLM-Call-Telemetry** | [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js) | Pro LLM-Call: Pipeline, Scope, Model, Temperature, Latency, Tokens, Quality-Score, Cost, Tenant | **Code da, NICHT WIRKSAM** |
| **External-API-Tracker** | [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js) | Pro externem HTTP-Call (SerpAPI, BrightData, …): Service, Endpoint, Success, Latency, ErrorCode | **Live** (default 100 % Sample) |

## 2. LLM-Call-Telemetry — Aktueller Zustand

### Wer ruft `logLlmCall` auf?

```
$ rg 'logLlmCall|require.*llm-telemetry' backend/
backend/lib/llm-telemetry.js                  # selbst-Export
backend/__tests__/lib/llm-telemetry.test.js   # Test
```

**Keine Production-Caller.** Identify V3/V4, Chat V3/V2, Legacy-Chat, Improve, Quality-Gate — **niemand** loggt.

> **Drift-Source:** Hardening-Plan Top-7-Finding #7 + Wave-4-Aufgabe "logLlmCall aktivieren: zentraler Wrap in `gemini3GenerateJSON`/`gemini3GenerateText` + Chat-Sends; befüllt `llm_call_telemetry` aus `usageMetadata`". Quelle: `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md`.

### Was das Modul kann (sobald es aktiviert wird)

#### `logLlmCall(opts)` — never throws

| Feld | Typ | Beispiel |
|---|---|---|
| `pipeline` | string | `'identify-v4'`, `'chat-v3'`, `'atomic-tools'` |
| `scope` | string | `'stage3'`, `'identity-worker'`, `'chat.product'` |
| `scopeVersion` | string\|null | `'v-prod-2026-05-01'` |
| `model` | string | `'gemini-3.1-pro-preview-customtools'` |
| `temperature` | number\|null | `1.0` |
| `outputQualityScore` | number\|null | `0.82` (Cassini-Overall) |
| `schemaValid` | boolean\|null | true wenn zod-safeParse erfolgreich |
| `latencyMs` | number | `4321` |
| `promptTokens` | number | aus `usageMetadata.promptTokenCount` |
| `completionTokens` | number | aus `usageMetadata.candidatesTokenCount` |
| `costUsdEstimate` | number | auto via `MODEL_PRICING_USD_PER_M`, oder explizit |
| `tenantId` | string | `'avycloud'` / `'trendocean'` |
| `productId` | string | optional, geht in Doc-ID-Sharding |
| `sampled` | boolean | `true` → force-log (bypass sample-rate) |

### Sample-Rate + Auto-Downgrade

| Hebel | Default | Verhalten |
|---|---|---|
| `LLM_TELEMETRY_SAMPLE` | `0.1` | 10 % aller Events. `1.0` = jeden Call. Werte > 1 clamped auf 1, < 0 auf 0. |
| Auto-Downgrade | `> 0.5` nach **24 h** → Reset auf `0.1` | Cost-Guard. State in Firestore `system/llm-telemetry-state` (`{sampleRate, changedAt, previousRate, reason}`) |
| Firestore-Override | beliebige Sample-Rate per Admin | **ENV gewinnt immer** (CRITICAL-2 cross-check fix in `getSampleRateFromState`). Firestore-Wert greift nur wenn ENV unset. |
| In-Process-Cache | **60 s TTL** für Sample-Rate-Lookup | reduziert Firestore-Reads bei hoher Call-Rate |

### Batched Writer + Sharding

| Mechanismus | Wert | Zweck |
|---|---|---|
| `BATCH_FLUSH_MS` | `5000` | Sammeln, dann Bulk-Commit |
| `BATCH_MAX_SIZE` | `100` | Auto-Flush bei voller Queue |
| Doc-ID-Pattern | `${random8}-${ts}-${productId}` | Sharding gegen Firestore-Hotspots |
| Exit-Hook | `beforeExit` + `SIGTERM` + `SIGINT` | Flush bei Process-Shutdown |
| Firestore unavailable | drop + `console.warn` (kein Throw) | NIE die Host-Pipeline brechen |

### Cost-Pricing-Table (Approximation)

Quelle: `MODEL_PRICING_USD_PER_M` in [lib/llm-telemetry.js:37](../../../backend/lib/llm-telemetry.js).

| Modell | USD / 1M Input | USD / 1M Output |
|---|---|---|
| `gemini-3.1-pro-preview-customtools` | **1.25** | **5.00** |
| `gemini-3.1-pro-preview` | 1.25 | 5.00 |
| `gemini-3-pro-preview` | 1.25 | 5.00 |
| `gemini-3-pro-image-preview` | 1.25 | 5.00 |
| `gemini-3-flash-preview` | **0.10** | **0.40** |
| `gemini-2.5-pro` | 1.25 | 5.00 |
| `gemini-2.5-flash` | 0.10 | 0.40 |
| Fallback `__default` | 0.50 | 2.00 |
| Heuristik bei unbekanntem Modell | flash→Flash-Preis, sonst Pro-Preis | — |

`estimateCostUsd({ model, promptTokens, completionTokens })` returnt 8-decimal-gerundeten USD-Betrag.

## 3. LLM-Parity-Dashboard

**Endpoint:** `GET /api/admin/llm-parity` (live).
**Quelle:** [backend/services/llm-parity-dashboard.js](../../../backend/services/llm-parity-dashboard.js), Route in [backend/routes/admin.js:1469](../../../backend/routes/admin.js).
**Required Permission:** `admin:read`.

### Query-Parameter

| Parameter | Pflicht | Beschreibung |
|---|---|---|
| `tenantId` | Pflicht (aus `req.user.tenantId`, default `'default'`) | Tenant-Filter |
| `domain` | optional | Filter auf einen Scope-Namen |
| `pipeline` | optional | Filter auf eine Pipeline (`identify-v3`, `chat-v3`, …) |
| `dateFrom` | optional | ISO oder ms — untere `timestamp`-Grenze |
| `dateTo` | optional | ISO oder ms — obere `timestamp`-Grenze |

### Response-Shape

```json
{
  "ok": true,
  "data": {
    "pipelines": [
      {
        "pipeline": "chat-v3",
        "domain": "chat.product",
        "mean_quality": 0.7821,
        "mean_latency_ms": 4321.0,
        "mean_cost_usd": 0.0042,
        "count": 153,
        "models": ["gemini-3.1-pro-preview-customtools"]
      }
    ],
    "drift_alerts": [
      {
        "domain": "identify.identity",
        "gap": 0.18,
        "best_pipeline": "identify-v4",
        "best_mean_quality": 0.86,
        "worst_pipeline": "identify-v3",
        "worst_mean_quality": 0.68,
        "threshold": 0.15
      }
    ],
    "total": 153,
    "hard_cap": 5000
  }
}
```

### Drift-Detection

Für jede Domain die in ≥ 2 Pipelines vorkommt, wird `max_quality − min_quality` berechnet. Bei `gap > LLM_PARITY_DRIFT_THRESHOLD` (default `0.15`) → Alert.

### Aktueller praktischer Wert

**Da `llm_call_telemetry` leer ist** liefert der Endpoint aktuell `{ pipelines: [], drift_alerts: [], total: 0, hard_cap: 5000 }`. Dashboard ist bereit — sobald Wave-4 die Writer aktiviert, kommen Daten.

## 4. Zod-Schema-Validation (Telemetrie-relevant)

Phase F.3 ist 2-stufig (siehe [prompts.md](prompts.md) §4 und [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md)).

| ENV | Default | Effekt |
|---|---|---|
| `LLM_SCHEMA_STRICT` | `false` | Stufe 1: safeParse + logger-warn. KEIN Throw — Output unverändert zurück. |
| `LLM_SCHEMA_STRICT=true` | — | Stufe 2: `parse()` + Throw mit `LLM_SCHEMA_VALIDATION_FAILED`-Error (`scope` + `issues`). |
| `LLM_SCHEMA_VALIDATE_RATE` | `1.0` | Sample-Rate für Stufe-1-Logging (Float 0..1). `0.1` = 10 % der Calls loggen Drift. Volume-Drossel für hot scopes. |

Aktive Helper:
- `lib/gemini3-client._validateAgainstScope(payload, scopeConfig)` — `gemini3GenerateJSON` ruft das auf für Caller die `scopeConfig` mitliefern.
- `lib/gemini-structured._validateTextPayload(textPayload, scopeConfig)` — Mirror für die `callGeminiStructured`-Pfad.

> **Drift-Hinweis:** `identifyProductFocused`, `identifyProductWithGrounding`, `generateProductContent` (Identify-Hot-Paths) liefern keinen `scopeConfig` an die Helper — Validation wird dort übersprungen. Hardening-Plan §E2 Aufgabe.

## 5. External-API-Tracker (LIVE)

**Code:** [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js).
**Collection:** `external_api_calls`.

### `instrumentExternalCall(service, endpoint, fn)`

Wrapper für SerpAPI- und BrightData-Calls. Trackt Service, Endpoint, Success, Latency, ErrorCode + ErrorMessage (auf 100/300 chars beschnitten).

```js
const { instrumentExternalCall } = require('../lib/external-api-tracker');
const result = await instrumentExternalCall('serpapi', '/search', () =>
  fetch('https://serpapi.com/search?...')
);
```

### Aggregat-API für Operator-Dashboard

`getExternalApiStats({ service, windowMs })` — pro-Service-Stats: `total`, `success`, `failure`, `successRate`, `avgLatencyMs`, `latencyMax`, `topErrors`, `topEndpoints`. Wird in `GET /api/health/identify` aggregiert.

### Sample-Rate

| ENV | Default | Effekt |
|---|---|---|
| `EXTERNAL_API_TRACKER_SAMPLE_RATE` | `1.0` | 100 % Sample. Nach ~2 Wochen Baseline auf `0.1` drosseln (Firestore-Write-Volumen reduzieren). |

**Zweck:** datenbasierte Antwort auf "Brauchen wir BrightData noch?" — siehe [cost-and-budgets.md](cost-and-budgets.md).

## 6. Aktivierungs-Plan (Wave-4)

Aus Hardening-Plan:

1. **`logLlmCall` aktivieren — zentral wrap in `gemini3-client.js`**:
   - In `gemini3GenerateJSON` + `gemini3GenerateText`: nach `ai.models.generateContent(...)`-Call → `logLlmCall({ pipeline, scope, model: modelName, temperature, latencyMs, promptTokens: response.usageMetadata?.promptTokenCount, completionTokens: response.usageMetadata?.candidatesTokenCount, tenantId, productId })`.
   - Caller-Code (`product-chat-v3.js`, Identify-Worker, `improve.js`) leiten `pipeline + scope + tenantId + productId` per Option durch.
2. **Chat-Send-Telemetrie**: `withGeminiRetryV3` zentral wrap `chat.sendMessage` mit Latency + Token-Tracking.
3. **`logLlmCall` in `gemini3-client.js` integrieren — minimal**: mindestens Token + Latency + Pipeline + Tenant — auch wenn Quality-Score noch nicht da ist.
4. **Cost-Budget-Alert**: `LLM_PARITY_COST_BUDGET_USD_PER_DAY` ENV → Alert-Endpoint wenn `mean_cost_usd × count > Budget`.
5. **`truncation_repaired:true`-Flag** als Quality-Signal in der `meta` (siehe `repairTruncatedJson` in `gemini3-client.js`).

## 7. Test-Helpers

`backend/lib/llm-telemetry._testables` exposed:
- `state` — _stateCache (Sample-Rate)
- `writer` — _writerState (Queue + Timer)
- `reset()` — resettet für Test-Isolation
- `BATCH_FLUSH_MS`, `BATCH_MAX_SIZE`, `STATE_CACHE_TTL_MS`, `AUTO_DOWNGRADE_*` Konstanten
- `COLLECTION` (`'llm_call_telemetry'`)

## 8. Verweise

- Modul: [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js).
- Dashboard-Service: [backend/services/llm-parity-dashboard.js](../../../backend/services/llm-parity-dashboard.js).
- Route: [backend/routes/admin.js:1469](../../../backend/routes/admin.js) (`/api/admin/llm-parity`).
- Tests: [backend/__tests__/lib/llm-telemetry.test.js](../../../backend/__tests__/lib/llm-telemetry.test.js), [backend/__tests__/services/llm-parity-dashboard-service.test.js](../../../backend/__tests__/services/llm-parity-dashboard-service.test.js), [backend/__tests__/api/admin-llm-parity.test.js](../../../backend/__tests__/api/admin-llm-parity.test.js).
- External-API-Tracker: [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js).
- Charta §4 + §5: [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md).
- Hardening-Plan: `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md` (Wave 4).
