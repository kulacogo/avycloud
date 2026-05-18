---
title: LLM-Kosten & Budgets — Pricing, Hebel, Empfehlungen
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# LLM-Kosten & Budgets

> Aktuelle Pricing-Annahmen, die im Code als Source-of-Truth für Cost-Estimates dienen, plus die Hebel zur Drosselung und Empfehlungen aus dem Hardening-Plan.

## 1. Token-Pricing-Tabelle (Code-Source)

Quelle: `MODEL_PRICING_USD_PER_M` in [backend/lib/llm-telemetry.js:37](../../../backend/lib/llm-telemetry.js).

| Modell | USD / 1M Input | USD / 1M Output | Klasse |
|---|---|---|---|
| `gemini-3.1-pro-preview-customtools` | **1.25** | **5.00** | Pro |
| `gemini-3.1-pro-preview` | 1.25 | 5.00 | Pro |
| `gemini-3-pro-preview` | 1.25 | 5.00 | Pro |
| `gemini-3-pro-image-preview` | 1.25 | 5.00 | Image/Pro |
| `gemini-3-flash-preview` | **0.10** | **0.40** | Flash |
| `gemini-2.5-pro` | 1.25 | 5.00 | Pro |
| `gemini-2.5-flash` | 0.10 | 0.40 | Flash |
| Fallback `__default` | 0.50 | 2.00 | — |
| Heuristik (unbekanntes Modell) | enthält `flash` → Flash-Preis, sonst Pro-Preis | — | — |

> Werte konservativ (Listen-Preise, Mai 2026). Bewusst eigene Quelle in `llm-telemetry.js`, weil `gemini-config.js` keine Preise exportiert. **Nicht für Buchhaltung** — nur Telemetrie-Aggregate.

### `estimateCostUsd({ model, promptTokens, completionTokens })`

Rundet auf 8 Nachkommastellen. Beispiel-Rechnung Chat-V3 Single-Turn mit 5000 prompt + 1500 completion Tokens auf Pro-Customtools:

```
cost = (5000 / 1_000_000) × 1.25  +  (1500 / 1_000_000) × 5.00
     = 0.00625                    +  0.0075
     = 0.01375 USD
```

Bei 200 Chat-Turns/Tag → ~$2.75/Tag. Bei Bulk-Identify über 500 Produkte mit Stage-3-Run ≈ 8000 Token-Total/Produkt → ~$5/Run.

## 2. Aktive Cost-Hebel (ENV-Vars)

| Hebel | ENV | Default | Wo |
|---|---|---|---|
| **Telemetrie-Sample-Rate** | `LLM_TELEMETRY_SAMPLE` | `0.1` | [llm-telemetry.js](../../../backend/lib/llm-telemetry.js) |
| **Schema-Validation-Rate** | `LLM_SCHEMA_VALIDATE_RATE` | `1.0` | [llm-schemas/_index.js](../../../backend/lib/llm-schemas/_index.js) |
| **Schema-Strict-Throw** | `LLM_SCHEMA_STRICT` | `false` | [llm-schemas/_index.js](../../../backend/lib/llm-schemas/_index.js) |
| **External-API-Sample-Rate** | `EXTERNAL_API_TRACKER_SAMPLE_RATE` | `1.0` | [external-api-tracker.js](../../../backend/lib/external-api-tracker.js) |
| **Atomic-Tool-Timeout** | `ATOMIC_TOOLS_TIMEOUT_MS` | `15000` (ms) | [atomic-tools.js](../../../backend/services/atomic-tools.js) |
| **Generic-Gemini-Timeout** | `GEMINI_GENERIC_TIMEOUT_MS` | `30000` (ms) | [gemini3-client.js](../../../backend/lib/gemini3-client.js) |
| **Grounding-Timeout (V2)** | `IDENTIFY_GROUNDING_TIMEOUT_MS` | `90000` | [gemini3-client.js](../../../backend/lib/gemini3-client.js) |
| **Recognition-Timeout (V3 Stage 1)** | `IDENTIFY_RECOGNITION_TIMEOUT_MS` | `45000` | [gemini3-client.js](../../../backend/lib/gemini3-client.js) |
| **Content-Timeout (V3 Stage 3)** | `STAGE3_GEMINI_TIMEOUT_MS` | `60000` | [gemini3-client.js](../../../backend/lib/gemini3-client.js) |
| **Identify-V4 Pipeline-Timeout** | `IDENTIFY_V4_TIMEOUT_MS` | `180000` | [identify-v4.js](../../../backend/services/identify-v4.js) |
| **Identify-V4 Wave-Timeout** | `IDENTIFY_V4_WAVE_TIMEOUT_MS` | `60000` | [identify-v4.js](../../../backend/services/identify-v4.js) |
| **Identify-V4 Max-Iterations (Refinement)** | `IDENTIFY_V4_MAX_ITERATIONS` | `5` | [identify-v4.js](../../../backend/services/identify-v4.js) |
| **Identify Total-Timeout (Route-Layer)** | `IDENTIFY_TOTAL_TIMEOUT_MS` | `360000` (6 min) | [routes/identify.js](../../../backend/routes/identify.js) |
| **Chat-Retry per-attempt-Timeout** | `GEMINI_RETRY_PER_ATTEMPT_TIMEOUT_MS` | `30000` | [product-chat-v2.js](../../../backend/services/product-chat-v2.js), [product-chat-v3.js](../../../backend/services/product-chat-v3.js) |
| **Stage3-Agentic-Loop-Iterations** | `STAGE3_AGENTIC_MAX_ITERATIONS` | `5` | [lib/identify-v3-stage3-agentic.js](../../../backend/lib/identify-v3-stage3-agentic.js) |
| **Stage3-Agentic-Token-Cap** | `STAGE3_AGENTIC_MAX_TOKENS` | `12000` | [lib/identify-v3-stage3-agentic.js](../../../backend/lib/identify-v3-stage3-agentic.js) |
| **Stage3-Agentic-Image-Cap** | `STAGE3_AGENTIC_MAX_IMAGES` | `4` | [lib/identify-v3-stage3-agentic.js](../../../backend/lib/identify-v3-stage3-agentic.js) |

## 3. Auto-Downgrade Telemetrie

| Schwelle | Verhalten |
|---|---|
| `LLM_TELEMETRY_SAMPLE > 0.5` AND `(now − changedAt) > 24 h` | Auto-Reset auf `0.1`. State in Firestore `system/llm-telemetry-state`. |
| `ENV` vs `Firestore-State` | **ENV gewinnt immer** — Firestore-Wert nur konsultiert wenn ENV unset (CRITICAL-2 cross-check fix). |

## 4. Cloud-Billing-Alert

Per Charta §4: GCP Billing-Alert `A5` triggert bei **$30 / Monat / Tenant**. Runbook: [docs/runbooks/alerts.md](../../runbooks/alerts.md) (A5 Cost). Cost-Estimate aus Charta:
- Sample-Rate `0.1`: ~$10/Monat/Tenant.
- Sample-Rate `1.0`: ~$50/Monat/Tenant.

Bei Überschreitung von $30/Monat triggert A5. Telemetrie-TTL pro Doc: **90 d** (Firestore-TTL-Policy auf `llm_call_telemetry`).

## 5. Cost-Hot-Spots im Code

| Hot-Spot | Warum teuer | Empfehlung |
|---|---|---|
| **Identify V4 Refinement-Loop** | Bis zu 5 Iterationen × N Worker × Pro-Tokens | `IDENTIFY_V4_MAX_ITERATIONS=3` für Cost-Sensitive Tenants. `hasConfidenceImproved`-Break ist schon aktiv. |
| **Stage 3 Agentic Multi-Tool-Loop** | Mehrere Research-Calls + Write-Call | `STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT=3` (Modell wird zum Write gedrängt). Sub-Flags siehe CLAUDE.md. |
| **Chat V3 mit hohem `DEFAULT_MAX_OUTPUT_TOKENS=12000`** | Output-Tokens kosten 4× Input | Reduzieren auf 8192 wenn Antwort-Längen-Analyse zeigt dass nie ausgeschöpft wird. |
| **Gemini Grounding bei Full-Schema Identify** | `googleSearch` + 8192 Out-Tokens + Thinking | bestehender 90-s-Timeout schützt vor Runaway. Cost selbst nicht weiter limitiert. |
| **External-API-Tracker bei Bulk-Ops** | 100 % Sample = 1 Firestore-Write pro SerpAPI/BrightData-Call | Nach Baseline → `EXTERNAL_API_TRACKER_SAMPLE_RATE=0.1`. |
| **Atomic-Tool-Loop in Chat V3** | Jeder Tool-Call kann externe API treffen (SerpAPI, BrightData, EAN-DB) | `ATOMIC_TOOLS_TIMEOUT_MS=15000` per Executor + `SOFT_RESEARCH_LIMIT=3` triggert Force-Write-Mode. |

## 6. Empfehlungen aus dem Hardening-Plan

Aus `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md` (Wave 4 — LLM-Observability + Cost):

1. **`logLlmCall` aktivieren** (siehe [telemetry.md](telemetry.md)) — ohne das fliegen wir blind. Sobald Daten da sind, kann ein Cost-Budget-Alarm pro Tenant gebaut werden.
2. **Prompt-Cache aktivieren** (siehe [caching.md](caching.md)) — Stage-3 + Chat-System-Instruction, ~90 % Input-Token-Ersparnis bei wiederholten Prompts.
3. **Fallback-Counter** als `chat_pipeline_fallbacks`-Collection — sichtbar machen wie oft V3 → V2 → Legacy fallbacked (Latenz + Kosten-Multiplikator).
4. **`truncation_repaired:true`** als Quality-Signal in Telemetrie + optionaler Re-Try in `gemini3-client.js` — heute maskiert `repairTruncatedJson` Truncation als Success, ohne dass die Confidence reduziert wird.
5. **`/api/admin/llm-parity`** mit Drift-Threshold-Konfig (`LLM_PARITY_DRIFT_THRESHOLD`, Default `0.15`) — sobald Daten da sind: A/B von Modell- oder Prompt-Versionen pro Tenant ohne Risiko.
6. **External-API-Sampling drosseln** nach 2 Wochen Baseline (`EXTERNAL_API_TRACKER_SAMPLE_RATE=0.1`) — bei aktuell 1.0 schreiben wir jeden SerpAPI/BrightData-Call.

## 7. Operator-Cheatsheet

```bash
# Telemetrie kurzzeitig auf 100% hochziehen (Debugging)
export LLM_TELEMETRY_SAMPLE=1.0
# läuft 24 h, dann Auto-Downgrade auf 0.1 (Firestore: system/llm-telemetry-state)

# Schema-Drift härter beobachten
export LLM_SCHEMA_STRICT=false                   # Stufe 1 (default)
export LLM_SCHEMA_VALIDATE_RATE=1.0              # jeden Call validieren

# Identify-V4 Refinement begrenzen für Cost-Sensitive Tenant
export IDENTIFY_V4_MAX_ITERATIONS=3              # statt 5

# Atomic-Tool-Timeout für sehr lahme Quellen (z. B. EAN-DB-Outage)
export ATOMIC_TOOLS_TIMEOUT_MS=8000              # statt 15000

# Prompt-Cache deaktivieren (sobald Wave-4 live ist) — Fallback-Test
export GEMINI_PROMPT_CACHE=false

# Identify-V4 komplett deaktivieren (Notfall-Bypass)
export IDENTIFY_V4=false
```

## 8. Verweise

- Pricing-Source: [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js) `MODEL_PRICING_USD_PER_M`.
- Cost-Discipline Charta §4: [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md).
- Alerts-Runbook (A5 Cost, A7 Quality-Drift): [docs/runbooks/alerts.md](../../runbooks/alerts.md).
- Hardening-Plan: `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md`.
- Modul-Quellen: `lib/llm-telemetry.js`, `lib/external-api-tracker.js`, `services/atomic-tools.js`, `services/identify-v4.js`, `services/product-chat-v3.js`.
