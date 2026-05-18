---
title: LLM-Strategie — Overview
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# LLM bei AvyCloud — Strategie & Lage

> **Single Source of Truth für die LLM-Charta:** [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md).
> Diese KB-Seite ist die Einstiegs-Übersicht. Tiefere Details liegen in den
> Nachbar-Dateien (`models.md`, `pipelines.md`, `tools.md`, …).

## 1. In einem Satz

AvyCloud ist eine **Gemini-3-zentrische** Produktdaten-Plattform: jede Produkt-Identifikation, jede Listing-Generierung und jedes interaktive Chat-Update läuft über `@google/genai` mit Google Search Grounding, urlContext und atomaren Function-Calling-Tools — eingerahmt von einer Cross-Reference- + Confidence-Scoring-Schicht und (in der Charta dokumentiert) einer Scope-/Telemetrie-Bridge.

## 2. Verbindliche Charta

Alle neuen oder migrierten LLM-Caller MÜSSEN der Quality-Parity-Charta folgen:

- **Charta:** [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md) (TL;DR siehe §1 dort).
- **Inventar:** [docs/standards/llm-callers-inventory.md](../../standards/llm-callers-inventory.md) (40 Caller, Drift-Scores 0–3).
- **Defaults-Helfer:** [backend/lib/gemini-config.js](../../../backend/lib/gemini-config.js) (Model, Temperature, Thinking, Safety).
- **Config-Bridge (Firestore-Versioning):** `resolveScopeConfig()` in [backend/lib/llm-config.js](../../../backend/lib/llm-config.js).
- **Schema-Validation:** [backend/lib/llm-schemas/](../../../backend/lib/llm-schemas/) (Zod, 2-stufig).
- **Telemetrie:** [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js) (Firestore `llm_call_telemetry`).
- **Quality-Baseline:** [Strategischer eBay Leitfaden](../../../Strategischer%20eBay%20Leitfaden.md) + Cassini-Scorer ([backend/lib/cassini-scorer.js](../../../backend/lib/cassini-scorer.js)).

**Verbot (Auszug aus der Charta):** keine hardcoded `temperature`, `topP`, `topK`, `maxOutputTokens`, `thinkingConfig`, `model`-Strings in neuen Callern.

## 3. Was ist live, was nicht?

| Baustein | Status | Wo |
|---|---|---|
| Gemini-3-Client + Identify/Chat-Pipelines | **live** | [backend/lib/gemini3-client.js](../../../backend/lib/gemini3-client.js), [backend/services/identify-v4.js](../../../backend/services/identify-v4.js), [backend/services/product-chat-v3.js](../../../backend/services/product-chat-v3.js) |
| Atomic-Tools (7+2 Function-Decls) | **live** | [backend/services/atomic-tools.js](../../../backend/services/atomic-tools.js) |
| Scope-Konfiguration via Firestore + Admin-UI | **live** (additive, byte-identische Defaults) | [backend/lib/llm-config.js](../../../backend/lib/llm-config.js), [components/admin/AdminLlmManagement.tsx](../../../components/admin/AdminLlmManagement.tsx) |
| Zod-Schema-Validation (Stufe 1 safeParse-warn) | **live im Helper-Layer** | [backend/lib/gemini3-client.js](../../../backend/lib/gemini3-client.js) (`_validateAgainstScope`), [backend/lib/gemini-structured.js](../../../backend/lib/gemini-structured.js) |
| Cross-Reference + Confidence-Scoring | **live** | [backend/lib/cross-reference.js](../../../backend/lib/cross-reference.js), [backend/lib/confidence-scoring.js](../../../backend/lib/confidence-scoring.js) |
| LLM-Telemetrie-Logger (`logLlmCall`) | **Code vorhanden, NICHT WIRKSAM** — keine Production-Call-Sites (siehe [telemetry.md](telemetry.md)) | [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js) |
| LLM-Parity-Dashboard `/api/admin/llm-parity` | **Endpoint live, liefert aktuell leere Daten** | [backend/services/llm-parity-dashboard.js](../../../backend/services/llm-parity-dashboard.js), [backend/routes/admin.js](../../../backend/routes/admin.js) |
| Prompt-Cache (Gemini Context-Caching) | **Code vorhanden, NICHT WIRKSAM** — keine Production-Call-Sites (siehe [caching.md](caching.md)) | [backend/lib/prompt-cache.js](../../../backend/lib/prompt-cache.js) |
| External-API-Tracker (SerpAPI, BrightData) | **live** (Firestore `external_api_calls`) | [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js) |

> **Drift-Hinweis (Hardening-Plan Finding #7):** `llm_call_telemetry` wird in Production nie geschrieben, `prompt-cache` hat keine Call-Sites, einige Identify-Hot-Paths skippen die zentrale Schema-Validation. Quelle: `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md` (Wave 4 — LLM-Observability + Cost). Aktivierung ist als offene Aufgabe in den jeweiligen Dateien dokumentiert.

## 4. Pipeline-Landkarte (Kurzform)

| Pipeline | Eintritt | Modell-Default | Doku |
|---|---|---|---|
| **Identify V4** (Orchestrator-Wave-Swarm) | `POST /api/identify` + Flag `IDENTIFY_V4=true` / Canary | `gemini-3.1-pro-preview-customtools` | [pipelines.md](pipelines.md) |
| **Identify V3** (Multi-Stage Stage 1–4) | Default sobald V4 aus / Fallback nach V4-Error | `gemini-3.1-pro-preview-customtools` | [pipelines.md](pipelines.md) |
| **Identify Grounding (V2)** | Single-Call `identifyProductWithGrounding` | `gemini-3-pro-preview` (Default in `gemini3-client.js`) | [pipelines.md](pipelines.md) |
| **Improve (Datasheet-Verbesserung)** | `services/improve.js` (Scope `improve.product`) | scope-resolved | [pipelines.md](pipelines.md) |
| **Chat V3** (Context-Circulation) | `POST /api/identify/chat` Default | `gemini-3.1-pro-preview-customtools` | [pipelines.md](pipelines.md) |
| **Chat V2** (Grounding + Function-Decls) | Cascade-Fallback | `gemini-3.1-pro-preview-customtools` | [pipelines.md](pipelines.md) |
| **Chat Legacy** (BrightData/SerpAPI + Agentic Loop) | Letzter Fallback | `gemini-3.1-pro-preview-customtools` (`CHAT_MODEL`), Intent `gemini-3-flash-preview` (`INTENT_MODEL`) | [pipelines.md](pipelines.md) |

## 5. Kosten & Beobachtung

| Hebel | Aktuell | Wo dokumentiert |
|---|---|---|
| Telemetrie-Sample-Rate | `LLM_TELEMETRY_SAMPLE=0.1` (Auto-Downgrade ≥ 0.5 nach 24 h) | [telemetry.md](telemetry.md) |
| Schema-Validation-Rate | `LLM_SCHEMA_VALIDATE_RATE=1.0` | [telemetry.md](telemetry.md) |
| Schema-Strict-Throw | `LLM_SCHEMA_STRICT=false` (Stufe 1, safeParse-warn) | [telemetry.md](telemetry.md), [flags.md](flags.md) |
| Atomic-Tool-Timeout | `ATOMIC_TOOLS_TIMEOUT_MS=15000` | [cost-and-budgets.md](cost-and-budgets.md), [tools.md](tools.md) |
| External-API-Sample | `EXTERNAL_API_TRACKER_SAMPLE_RATE=1.0` | [cost-and-budgets.md](cost-and-budgets.md) |
| Cloud-Billing-Alert | `$30 / Monat` (Runbook A5) | [docs/standards/llm-quality-parity.md §4](../../standards/llm-quality-parity.md) |

## 6. Quick Reference

- Neuer LLM-Call? → erst Charta lesen ([docs/standards/llm-quality-parity.md §2 Boilerplate](../../standards/llm-quality-parity.md)).
- Welches Modell wo? → [models.md](models.md).
- Wo leben Prompts? → [prompts.md](prompts.md).
- Welche Tools darf Gemini callen? → [tools.md](tools.md).
- Caching aktivieren? → [caching.md](caching.md) (aktuell nicht-wirksam).
- Telemetrie auswerten? → [telemetry.md](telemetry.md) (aktuell keine Writer in Prod).
- Alle ENV-Flags? → [flags.md](flags.md).
