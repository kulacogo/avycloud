---
title: LLM-Modelle — Welches Modell wo & warum
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Modelle

> **Single Source of Truth:** [backend/lib/model-select.js](../../../backend/lib/model-select.js) (Allow-List + Aliase) und [backend/lib/gemini-config.js](../../../backend/lib/gemini-config.js) (Default-Resolver + Generation-Config-Builder).

## 1. Default-Matrix

| Pipeline / Caller | Modell-Default | ENV-Override | Resolver |
|---|---|---|---|
| **Chat (V3 + V2 + Legacy)** | `gemini-3.1-pro-preview-customtools` | `CHAT_MODEL` | `resolveChatModel()` ([gemini-config.js:69](../../../backend/lib/gemini-config.js)) |
| **Intent-Detection (Legacy-Chat)** | `gemini-3-flash-preview` | `INTENT_MODEL` | `resolveIntentModel()` ([gemini-config.js:79](../../../backend/lib/gemini-config.js)) |
| **Identify (Stage 1 + Stage 3 + Grounding)** | `gemini-3-pro-preview` → aliased zu `gemini-3.1-pro-preview-customtools` | `IDENTIFY_MODEL` | `resolveIdentifyModel()` ([gemini-config.js:74](../../../backend/lib/gemini-config.js)), via `resolveModel()` ([model-select.js:60](../../../backend/lib/model-select.js)) |
| **Identify V4 Orchestrator + Worker** | `gemini-3.1-pro-preview-customtools` | `IDENTIFY_V4_MODEL` | `resolveIdentifyV4Model()` ([gemini-config.js:89](../../../backend/lib/gemini-config.js)) |
| **Identify V4 Image-Enhance** | `gemini-3-pro-image-preview` | `IDENTIFY_V4_IMAGE_MODEL` | `resolveImageEnhanceModel()` ([gemini-config.js:100](../../../backend/lib/gemini-config.js)) — Image-Modell ist NICHT in der `ALLOWED_MODELS`-Liste, daher direkter Lookup |
| **Critic-Worker (V4)** | `FLASH_MODEL` = `gemini-3-flash-preview` (cheap Pass) | implizit via `gemini-config.FLASH_MODEL` | hardcoded `temperature: 0.1` in [lib/identify-workers/critic-worker.js](../../../backend/lib/identify-workers/critic-worker.js) |
| **Structured-JSON-Wrapper** | `gemini-3.1-pro-preview-customtools` | `GEMINI_MULTIMODAL_MODEL` / `GEMINI_STRUCTURED_MODEL` | `getStructuredModelName()` ([gemini-structured.js:93](../../../backend/lib/gemini-structured.js)) |
| **Generic generateJSON / generateText** | Lokaler Default `gemini-3-pro-preview` → aliased zu Pro-Customtools | `GEMINI_MODEL` | `resolveModel()` mit lokaler DEFAULT_MODEL-Konstante in [gemini3-client.js:299](../../../backend/lib/gemini3-client.js) |

> **Hinweis:** Alle Aliase routen via `MODEL_ALIASES` ([model-select.js:18](../../../backend/lib/model-select.js)) — `gemini-3-pro-preview`, `gemini-2.5-pro`, `pro`, `default`, `thinking`, `gemini-pro` ➜ **alle** auf `gemini-3.1-pro-preview-customtools`. Das `customtools`-Suffix kennzeichnet die Variante mit stabilerem Function-Calling (gleicher Preis wie `gemini-3.1-pro-preview`).

## 2. Warum diese Defaults?

### `gemini-3.1-pro-preview-customtools` als Universal-Pro-Default
- **Function-Calling stabil:** customtools-Variante hat in unseren Atomic-Tools-Tests deutlich weniger Argument-Drop-Outs als die Basis-`pro-preview`.
- **Thinking-Modus Pflicht:** alle agentischen Use-Cases (Identify-Worker, Chat) brauchen `thinkingLevel: 'high'` ([gemini-config.js:15](../../../backend/lib/gemini-config.js) `defaultThinkingConfig`). Pro-Modell-Klasse ist dafür nötig.
- **Empfohlene Temperature `1.0`:** Gemini-3 dokumentiert explizit `DEFAULT_CHAT_TEMPERATURE = 1.0` ([gemini-config.js:23](../../../backend/lib/gemini-config.js)) für agentic Chat. Niedrigere Temperaturen (0.2–0.5) führen zum Looping. Für strenge Structured-Output-Calls (Stage 3 identifizieren) gilt `DEFAULT_STRUCTURED_TEMPERATURE = 0.4`.

### `gemini-3-flash-preview` für Intent + Critic
- **Schnell & billig:** ~10 % der Kosten des Pro-Modells (siehe [cost-and-budgets.md](cost-and-budgets.md)).
- **Genug für 1-Token-Klassifikation:** Intent-Detection im Legacy-Chat braucht nur ein Label aus `change` / `info` / `analysis` (Temperature 0, maxOutputTokens 10 — hardcoded in [services/product-chat.js:118](../../../backend/services/product-chat.js)).
- **Critic-Worker:** Quality-Score-Pass + Issue-Detection. Pro-Modell wäre Overkill und teuer wenn V4 in jedem Refinement-Loop läuft.

### `gemini-3-pro-image-preview` für Image-Enhance
- Spezialisiert auf Image-Generation (Hintergrund-Entfernung, Cleanup). NICHT in der `ALLOWED_MODELS`-Liste, weil es nicht via `resolveModel()` geroutet wird — direkter Lookup in `resolveImageEnhanceModel()`.

## 3. Allow-List

```js
// backend/lib/model-select.js
const ALLOWED_MODELS = new Set([
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-exp-1206',
  'gemini-1.5-pro-002',
]);
```

Jeder Modell-String, der NICHT in der Allow-List ist, wird automatisch auf den Universal-Default `gemini-3.1-pro-preview-customtools` umgebogen — Fallback-Fallback ist auch dieser String. Das verhindert Drift durch Tippfehler in ENV-Vars und ehrt deprecated Upstream-Routings (z. B. legacy `gemini-3-pro-preview` → `gemini-3.1-pro-preview-customtools` seit 2026-03-26).

## 4. Per-Caller-Override-Pattern

Ein einzelner Caller kann das Modell explizit setzen, sollte aber Scope-Config respektieren (siehe Charta):

```js
const { resolveChatModel } = require('../lib/gemini-config');
// callerOverrides > scopeConfig.modelOverride > resolveChatModel() default
const model = modelOverride || _scopeModel || resolveChatModel();
```

Beispiel aus [services/product-chat-v3.js:763](../../../backend/services/product-chat-v3.js).

## 5. Generation-Config-Defaults

`buildGenerationConfig(overrides)` ([gemini-config.js:57](../../../backend/lib/gemini-config.js)) liefert:

| Key | Default | Begründung |
|---|---|---|
| `temperature` | `1.0` (`DEFAULT_CHAT_TEMPERATURE`) | Gemini-3 Empfehlung für agentic Use-Cases |
| `maxOutputTokens` | `8192` | Konservativer Standard; Chat-V3 nutzt `12000`, Identify-Stage-3 `8192` |
| `thinkingConfig` | `{ thinkingLevel: 'high', includeThoughts: true }` (Chat) / `{ ..., includeThoughts: false }` (Identify-JSON-Producer) | Chat zeigt Thoughts im UI-Panel; Identify discardet sie |
| `safetySettings` | medium für Harassment/Hate/Sex/Dangerous | E-Commerce-Produktdaten sind meist unproblematisch |

`PERMISSIVE_SAFETY` in [gemini-structured.js:83](../../../backend/lib/gemini-structured.js) setzt `BLOCK_NONE` für alle Kategorien, weil Lagerfotos sonst gelegentlich fälschlich geblockt werden (z. B. Rasierklingen → DANGEROUS_CONTENT).

## 6. Cassini-relevante Modell-Eigenschaften

| Eigenschaft | Welches Modell | Warum wichtig |
|---|---|---|
| Function-Calling stabil | `customtools` | Atomic-Tools (siehe [tools.md](tools.md)) brauchen ≥ 0,9 Argument-Validity-Rate |
| Google Search Grounding | alle Pro/Flash-3-Modelle | Identify-Grounding-Pfad ([gemini3-client.js:611](../../../backend/lib/gemini3-client.js) `identifyProductWithGrounding`) |
| urlContext-Tool | Pro-3.1 | Tiefes Lesen von Hersteller-Datenblättern (Phase 2 Identify, Chat-V3) |
| `responseMimeType: 'application/json'` + `responseJsonSchema` | alle Pro-3-Modelle | Schema-erzwungenes Output für V3 Stage 1/3 + V4-Worker |
| Thinking + Thoughts-Stream | Pro-3.1 | Chat-UI "Thinking…"-Panel; Identify-Worker zur Recherche-Trace-Aufnahme |
