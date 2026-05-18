---
title: Schema — llm_call_telemetry
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Schema — `llm_call_telemetry`

> Quelle: [lib/llm-telemetry.js](../../../../backend/lib/llm-telemetry.js). Per-Call-Telemetrie aller LLM-Aufrufe in den AvyCloud-Pipelines (identify-v3/v4, chat-v2/v3, atomic-tools, quality-gate, …). Append-only, **sample-rate-gated**, batched-write.
>
> Verbindet sich mit der **LLM-Quality-Parity-Charta** ([docs/standards/llm-quality-parity.md](../../../standards/llm-quality-parity.md)).

## DocID-Strategie

Sharded zur Hotspot-Vermeidung: `${random8}-${ts}-${safeProductId}` ([llm-telemetry.js:199-204](../../../../backend/lib/llm-telemetry.js)).

- `random8` = 4 Random-Bytes als 8 Hex-Chars.
- `ts` = `Date.now()`.
- `safeProductId` = `productId` sanitized (`[^a-zA-Z0-9_-]/g → ''`, max 32 Chars), Fallback `'noprod'`.

Verhindert Konkurrenz auf `createdAt`-Wert-basierten Auto-IDs in High-Throughput-Pipelines.

## Felder (von `logLlmCall()`)

### Pipeline + Scope

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `pipeline` | string | ja | `'identify-v3'`, `'identify-v4'`, `'chat-v2'`, `'chat-v3'`, `'atomic-tools'`, `'quality-gate'`, … Default `'unknown'`. |
| `scope` | string | ja | Worker/Stage-Name innerhalb der Pipeline: `'stage3'`, `'identity-worker'`, `'category-worker'`, `'critic'`, …. Default `'unknown'`. |
| `scopeVersion` | string \| null | optional | Major-Version z. B. `'v3'`, `'v4'`. |

### Modell + Generation-Config

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `model` | string | ja | Gemini-Model-Name (`'gemini-3.1-pro-preview-customtools'`, `'gemini-3-flash-preview'`, …). Default `'unknown'`. Pricing-Lookup via `MODEL_PRICING_USD_PER_M`. |
| `temperature` | number \| null | optional | Effektive Temperature der Call-Config. |

### Quality

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `outputQualityScore` | number \| null | optional | 0..1. Typisch: `confidence` aus dem Worker-Output. |
| `schemaValid` | bool \| null | optional | Ergebnis der Zod-Validation (Charta-Phase F.3). `null` wenn kein Schema definiert. |

### Performance

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `latencyMs` | number \| null | optional | Wall-Clock-Latenz des LLM-Calls. |
| `promptTokens` | number \| null | optional | Input-Token-Count. |
| `completionTokens` | number \| null | optional | Output-Token-Count. |

### Cost

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `costUsdEstimate` | number | ja | USD-Kosten-Approximation. Caller kann via `costUsdEstimate`-Param explizit ueberschreiben, sonst auto-berechnet via `estimateCostUsd({ model, promptTokens, completionTokens })`. Pricing-Tabelle in [llm-telemetry.js:37-49](../../../../backend/lib/llm-telemetry.js). Auf 8 Nachkommastellen gerundet. |

### Tenant + Product

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `tenantId` | string | ja | Default `'default'`. |
| `productId` | string \| null | optional | Verknuepfung zum betroffenen Produkt (falls anwendbar). Geht in DocID-Shard-Schluessel ein. |

### Sampling-Metadaten

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `sampled` | `'forced'` \| `'random'` | ja | `'forced'` wenn Caller `sampled: true` explizit ueberschrieben hat, sonst `'random'`. |
| `sampleRateAtWrite` | number | ja | Effektive Sample-Rate beim Write (z. B. `0.1`). Erlaubt Hochrechnung Total-Volume = `count / sampleRateAtWrite`. |

### Timestamps

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `timestamp` | number (epoch ms) | Default `Date.now()`. Override fuer Tests via Caller. |
| `createdAt` | string (ISO) | ISO-Spiegel von `timestamp`. |

## Sampling-Logik

```
shouldLog = sampled === true                      // Caller-Force
         OR (sampled !== false
             AND (rate >= 1 OR Math.random() <= rate))
```

`rate` wird ueber `getSampleRateFromState()` ([llm-telemetry.js:115](../../../../backend/lib/llm-telemetry.js)) aufgeloest:

1. ENV `LLM_TELEMETRY_SAMPLE` (0..1) gewinnt IMMER wenn gesetzt.
2. Sonst Firestore-Doc `system/llm-telemetry-state` (Feld `sampleRate`).
3. Sonst Default `0.1`.
4. Cache TTL 60 s (`STATE_CACHE_TTL_MS`).

### Auto-Downgrade

Wenn `sampleRate > 0.5` UND `now - changedAt > 24 h`:
- Auto-Write `sampleRate = 0.1, previousRate, reason: 'auto_downgrade_24h'` zurueck nach `system/llm-telemetry-state`.
- Cost-Guard gegen vergessene High-Volume-Sampling-Runs.

ENV-Override umgeht das (ENV gewinnt immer — siehe CRITICAL-2-Fix-Kommentar in der Source).

## Batched Writer

`_enqueue()` → in-Memory-Queue + `setTimeout(BATCH_FLUSH_MS = 5000 ms)`.

- **Size-Trigger:** Bei `queue.length >= BATCH_MAX_SIZE (100)` sofortiger Flush.
- **Exit-Hook:** `beforeExit`, `SIGTERM`, `SIGINT` → letzter Flush.
- **Firestore-Batch:** `db.batch().set(ref, payload)` × N → `commit()`.
- **Defensiv:** Jede Failure ist `console.warn`-only, **nie** Throw. Telemetrie darf die Host-Pipeline nicht brechen.

## Composite-Index

`(tenantId ASC, scope ASC, timestamp DESC)` — fuer Per-Scope-Dashboards (Charta-§Telemetrie). Erlaubt Queries der Form "letzte 7 Tage Calls fuer Scope `identify.v3.stage3`, Tenant `default`, sortiert nach Zeit".

## Lese-Patterns

Aktuell **kein** Production-Dashboard. Tooling steht aus (Charta-Backlog). Ad-hoc-Analyse via Firestore-Console / `gcloud firestore export`.

Erwartet:
- Per-Scope Cost-Trends ueber Zeit.
- Quality-Drops (`outputQualityScore`-Histogramm) als Regression-Detektion.
- `schemaValid: false`-Counts pro Scope fuer Charta-Phase-F.3-Promotion-Entscheidung (Stufe 1 → Stufe 2 nach min 7 d 0-Violations).

## Pricing-Tabelle (Snapshot Mai 2026)

| Model | Input USD/1M | Output USD/1M |
|-------|-------------:|--------------:|
| `gemini-3.1-pro-preview-customtools` | 1.25 | 5.00 |
| `gemini-3.1-pro-preview` | 1.25 | 5.00 |
| `gemini-3-pro-preview` | 1.25 | 5.00 |
| `gemini-3-pro-image-preview` | 1.25 | 5.00 |
| `gemini-3-flash-preview` | 0.10 | 0.40 |
| `gemini-2.5-pro` (Fallback) | 1.25 | 5.00 |
| `gemini-2.5-flash` (Fallback) | 0.10 | 0.40 |
| `__default` (Heuristik) | 0.50 | 2.00 |

Heuristisches Matching: Models mit `/flash/i` → Flash-Pricing; `/pro|customtools/i` → Pro-Pricing.

**Wichtig:** Werte sind Listen-Preise (USD), nicht Buchhaltung. Nur fuer interne Cost-Trends und Quoten-Steuerung gedacht.

## TTL

Keine Auto-Expiry. Wachstum ist sample-rate-bedingt aber ungekappt. Bei langfristiger Analyse-Ueberlegungen: Tooling fuer Aging-Cleanup steht aus.

## Verwandte Sammlungen

- `system/llm-telemetry-state` (Single-Doc, NICHT in dieser Collection) — steuert Sample-Rate.
- `llmScopes` + `llmScopes/{id}/versions` — Scope-/Version-Definitionen (Source-of-Truth fuer Prompts, Models, Temperatures).
- `external_api_calls` — analoge Telemetrie fuer externe HTTP-Services (SerpAPI, BrightData). Sample-Rate via `EXTERNAL_API_TRACKER_SAMPLE_RATE`.
