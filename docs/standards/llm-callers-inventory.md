# LLM-Konsumenten-Inventar (Phase F.0)

> Auto-generiert von `backend/scripts/audit-llm-config.js` (Stand: 2026-05-10).
> Re-Run: `cd backend && node scripts/audit-llm-config.js` (READ-ONLY).
> JSON-Output: `/tmp/llm-config-audit.json`.

Dieses Dokument ist die **Ground-Truth-Liste aller LLM-Konsumenten** (Gemini-API-Caller) im AvyCloud-Backend. Es ist die Vorbedingung für Phase F.1a/F.1b/F.2 (Scope-Schema-Migration + Caller-Migration auf `resolveScopeConfig()`).

**Drift-Score-Definition**

| Score | Bedeutung |
|---|---|
| 0   | Caller nutzt zentrale Helper (`lib/gemini-config.js` / `lib/llm-config.js`); keine hardcoded LLM-Literals neben dem Helper. |
| 1   | Mixed — zentraler Helper ist eingebunden, aber zusätzlich existieren hardcoded `temperature`/`topK`/`topP`/`maxOutputTokens`-Literals. |
| 2   | Voll hardcoded — kein Require auf `gemini-config.js` / `llm-config.js`, alle LLM-Parameter als Literale im Code. |
| 3   | Inkonsistent — hardcoded UND Werte weichen von dokumentierten Defaults ab (z. B. Chat-Pfad mit `temperature < 0.5`, Identify ohne Thinking aber `temperature > 0.6`, mehrfach unterschiedliche `model:`-Strings). |
| –   | N/A — Caller-Datei wurde gescannt, aber es wurde kein direkter LLM-Generation-Config-Hit gefunden (Caller delegiert an einen anderen Helper, oder LLM wird via Sub-Service aufgerufen). |

---

## 1. Inventar

### 1.1 Bekannte Caller (aus Plan F.0, Z. 682–705)

| # | Caller | File | Was tut der Caller mit LLM | Aktuelle generationConfig (Auszug) |
|---|---|---|---|---|
| 1  | V3 Stage 3                        | `lib/identify-v3-stage3.js`                       | Strukturiertes Content-Generation (Titel/Beschreibung/Aspects)        | `temperature: 0.1`, `maxOutputTokens: 1024` (hardcoded, L501–502) |
| 2  | V3 Stage 3 Agentic                | `lib/identify-v3-stage3-agentic.js`               | Multi-Turn Tool-Calling Loop                                          | `temperature: _envFloat('STAGE3_AGENTIC_TEMPERATURE', DEFAULT_CHAT_TEMPERATURE)`, `thinkingConfig: defaultThinkingConfig({ level: 'high' })` (L418–420, central helper) |
| 3  | V4 Identity Worker                | `lib/identify-workers/identity-worker.js`         | Brand/Model/MPN-Identifizierung                                       | `temperature: DEFAULT_CHAT_TEMPERATURE`, `maxOutputTokens: MAX_OUTPUT_TOKENS`, `thinkingConfig: defaultThinkingConfig({ level: 'high', includeThoughts: false })` (L331–333) |
| 4  | V4 Category Worker                | `lib/identify-workers/category-worker.js`         | Kategorie-Resolution (delegiert an `services/category-resolver.js`)   | – (delegiert; keine eigene LLM-Config) |
| 5  | V4 Attributes Worker              | `lib/identify-workers/attributes-worker.js`       | Required-Aspects-Generation                                           | `temperature: DEFAULT_CHAT_TEMPERATURE`, `maxOutputTokens: MAX_OUTPUT_TOKENS`, `thinkingConfig: defaultThinkingConfig({ level: 'high', includeThoughts: false })` (L493–495) |
| 6  | V4 SEO Worker                     | `lib/identify-workers/seo-worker.js`              | Title/Description-Builder (deterministic)                             | – (kein direkter Gemini-Call, nutzt `lib/seo-title-builder.js` + `seo-description-builder.js`) |
| 7  | V4 Pricing Worker                 | `lib/identify-workers/pricing-worker.js`          | Sweet-Spot-Pricer (`lib/sweet-spot-pricer.js`)                        | – (kein direkter Gemini-Call) |
| 8  | V4 Image Worker                   | `lib/identify-workers/image-worker.js`            | Image enhance + angle classify; delegiert                              | – (delegiert an `lib/image-enhance.js`) |
| 9  | V4 GPSR Worker                    | `lib/identify-workers/gpsr-worker.js`             | Manufacturer-GPSR-Lookup; delegiert                                    | – (delegiert an `lib/gpsr-manufacturer-registry.js` / `gpsr-web-fallback.js`) |
| 10 | V4 Critic Worker                  | `lib/identify-workers/critic-worker.js`           | Critic / Quality-Scoring (Flash)                                       | `temperature: 0.1` (L175 hardcoded), nutzt aber `FLASH_MODEL` aus gemini-config |
| 11 | Chat V3                           | `services/product-chat-v3.js`                     | Customtools-Pipeline (Gemini 3.1 Pro, googleSearch + 7 atomic tools)   | `temperature: DEFAULT_CHAT_TEMPERATURE`, `maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS`, `thinkingConfig: defaultThinkingConfig({ level: 'high', includeThoughts: true })` (L756–758) |
| 12 | Chat V2                           | `services/product-chat-v2.js`                     | Grounding-Pipeline (urlContext + custom functions)                    | `temperature: enhanced ? 1.0 : 0.3`, `maxOutputTokens: enhanced ? 8192 : 4096` (L964–965, ternär) |
| 13 | Chat Legacy                       | `services/product-chat.js`                        | BrightData/SerpAPI + Gemini Agentic Loop                               | Intent-Detection: `generationConfig: { temperature: 0, maxOutputTokens: 10 }` (L118 hardcoded); Haupt-Loop nutzt `CHAT_MODEL` aus model-select |
| 14 | Atomic Tools                      | `services/atomic-tools.js`                        | 7 Tool-Executors (lookup_gtin, search_ebay_catalog, …)                | – (Schemas — LLM-Aufrufer ist Chat V3) |
| 15 | Category Resolver                 | `services/category-resolver.js`                   | Gemini-Fallback (Strategie 4) bei Categorize                          | – (LLM-Call delegiert an `lib/gemini-structured.js`) |
| 16 | Weight Web-Lookup                 | `lib/weight-web-lookup.js`                        | Web-Snippet-Parsing für Produktgewicht                                | – (delegiert an `lib/gemini.js` / `gemini3-client.js`) |
| 17 | GPSR Web Fallback                 | `lib/gpsr-web-fallback.js`                        | Impressum-Extraktion aus Hersteller-Sites                              | – (delegiert) |
| 18 | Image Enhance                     | `lib/image-enhance.js`                            | Hintergrund-Removal + Angle-Classify                                   | `model: 'gemini-3-pro-image-preview'` (L132), `model: 'gemini-3-flash-preview'` (L180), `temperature: 0.1` (L182) — alle hardcoded |
| 19 | Image Grouping                    | `services/image-grouping.js`                      | Vision-Klassifikation für Bild-Gruppen                                 | 3× hardcoded Block: `temperature: 0.1, topP: 0.8, topK: 16, maxOutputTokens: 8192/1024` (L165–168, 195–198, 371–374) |
| 20 | Image Grouping Fallback           | `lib/image-grouping-fallback.js`                  | Fallback bei Grouping-Fail                                             | – (delegiert) |
| 21 | Image Search                      | `lib/image-search.js`                             | Web-Image-Relevance                                                    | – (delegiert) |
| 22 | Marketing Images                  | `lib/marketing-images.js`                         | Image-Title-Scoring                                                    | – (delegiert) |
| 23 | Quality Gate                      | `services/quality-gate.js`                        | Optionale Gemini-Plausibilitäts-Prüfung                                | `temperature: 0.2, topP: 0.9, topK: 40` (L548–550 hardcoded), Helper teilweise eingebunden |
| 24 | eBay Auto-Fix                     | `services/ebay-auto-fix.js`                       | Aspect-Generation bei Publish-Error                                    | `generateText(prompt, { temperature: 0.3, maxOutputTokens: ASPECT_GEMINI_MAX_TOKENS })` (L229) |
| 25 | Enrichment Pipeline               | `services/enrichment.js`                          | Aktive Anreicherung (3 Sub-Calls)                                      | 3× hardcoded `generationConfig`: L2211–2214 (`temp 0.2, topP 0.95, topK 64`), L2440–2443 (`temp 0.7, topP 0.95, topK 64`), L3239–3242 (`temp 0.2, topP 0.8, topK 40`); nutzt `getActiveLlmConfig` aus llm-config.js (L2044) |
| 26 | Improve Pipeline                  | `services/improve.js`                             | Datasheet-Verbesserung (delegiert an `gemini3-client`)                 | – (delegiert; nutzt `llmScopeId: 'improve.product'` aus llm-config) |
| 27 | Admin Bulk Actions                | `services/admin-bulk-actions.js`                  | recategorize_v2 (delegiert an category-resolver)                       | – (delegiert) |
| 28 | Rulebook Runner                   | `services/rulebook-runner.js`                     | Cron-LLM-Calls (delegiert über `lib/llm-rulebook.js`)                  | – (delegiert) |
| 29 | Generative Identify (legacy)      | `services/generative-identify.js`                 | Legacy-Identify-Fallback                                               | `temperature: 0.0, topP: 0.8, topK: 16, maxOutputTokens: 1200` (L201–204 hardcoded) |
| 30 | Enrichment-V2 (legacy)            | `services/enrichment-v2.js`                       | Legacy-Enrichment-Fallback                                             | – (kein direkter Gemini-Call sichtbar; delegiert) |

### 1.2 Beim Scan zusätzlich gefundene Caller

Diese Files wurden als LLM-Touchpoint identifiziert, sind aber im Plan F.0 nicht explizit gelistet. Sie gehören zum Inventar:

| # | Caller | File | Was tut der Caller mit LLM | Aktuelle generationConfig |
|---|---|---|---|---|
| 31 | Identify-V4 Orchestrator     | `services/identify-v4.js`              | Wave/Refinement-Orchestrator (delegiert an Worker)               | – (delegiert) |
| 32 | Listing Pipeline             | `services/listing-pipeline.js`         | Listing-Post-Processing                                          | `temperature: 0.3, maxOutputTokens: 2048` (L111–112 hardcoded) |
| 33 | Product Validator            | `services/product-validator.js`        | Validierungs-Checks via Flash                                    | 3× hardcoded: `model: 'gemini-3-flash-preview'`, `temperature: 0.1`, `maxOutputTokens: 64/16384/16384` (L226–228, 375–377, 396–398) |
| 34 | gemini-structured (helper)   | `lib/gemini-structured.js`             | Shared structured-output wrapper (genutzt von ≥3 Callern)        | Default-Args: `temperature = 0.0, topP = 0.8, topK = 40, maxOutputTokens = 1024` (L81–84) — Caller können überschreiben |
| 35 | gemini-client (helper)       | `lib/gemini-client.js`                 | Shared Gemini-Client                                             | `temperature: options.temperature ?? 0.1, maxOutputTokens: options.maxOutputTokens ?? 2048` (L70–72) |
| 36 | gemini.js (helper)           | `lib/gemini.js`                        | Legacy-Wrapper                                                   | Defaults via options-Spread: `temp=0.7, maxOutTok=1024, topP=0.8, topK=40` (L24–28) |
| 37 | gemini3-client (helper)      | `lib/gemini3-client.js`                | Gemini-3 Grounding-Client                                        | 3 Pfade (Recognition / Grounding / Content-Identify) mit `_envFloat()`/`_envInt()`-Wrappers + `gemini-config` Helper-Fallbacks (L191–192, 254–255, 503–511, 606–614, 860–868) |
| 38 | gemini-config.js             | `lib/gemini-config.js`                 | Self-reference (zentraler Helper selbst)                         | `buildGenerationConfig()` Default: `temperature: DEFAULT_CHAT_TEMPERATURE (1.0)`, `maxOutputTokens: 8192` (L59–60) |
| 39 | prompt-cache.js              | `lib/prompt-cache.js`                  | Wrapper für Gemini Context-Caching                               | – (delegiert; kein eigenes generationConfig) |
| 40 | vertex-ai.js                 | `lib/vertex-ai.js`                     | Vertex-AI-Client (alternative Auth-Lane)                         | `generationConfig` inline ohne Literale (L42) — passt durch |

**Total: 40 LLM-Touchpoints** (30 aus Plan + 10 zusätzlich gefundene, davon 7 Shared-Helper, 3 Orchestrator/Pipeline-Files).

---

## 2. Drift-Score-Summary

| Score | Anzahl Caller | Beispiele |
|---|---|---|
| **0** — central helper only       | 8  | Chat V3, Chat V2, V4 Identity, V4 Attributes, V3 Stage 3 Agentic, gemini-client, gemini.js, vertex-ai |
| **1** — mixed                     | 7  | V4 Critic, Chat Legacy, Quality Gate, Enrichment Pipeline, gemini-structured, gemini3-client, gemini-config |
| **2** — fully hardcoded           | 5  | V3 Stage 3, eBay Auto-Fix, Image Grouping, Generative Identify (legacy), Listing Pipeline |
| **3** — hardcoded + inkonsistent  | 2  | Image Enhance, Product Validator |
| **N/A** (delegiert / kein Hit)    | 18 | V4 Category/SEO/Pricing/Image/GPSR Worker, Atomic Tools, Category Resolver, Weight Web-Lookup, GPSR Web-Fallback, Image Grouping Fallback, Image Search, Marketing Images, Improve, Admin Bulk Actions, Rulebook Runner, Enrichment-V2, Identify-V4 Orchestrator, prompt-cache |

**Eine-Zeile-Summary:** `8/40 score-0, 7/40 score-1, 5/40 score-2, 2/40 score-3, 18/40 N/A (delegiert)` → **14 Caller mit aktivem Drift-Risiko (Score ≥ 1) müssen in F.1b migriert werden**.

---

## 3. Migration-Priorität (Top-10)

Sortiert nach (1) Drift-Score absteigend, (2) Anzahl gefundener Hits absteigend.

| Rang | Score | Caller | File | Hits | Notiz |
|---|---|---|---|---|---|
| 1  | 3 | Product Validator       | `services/product-validator.js`                | 9  | 3× identische Hardcode-Blöcke (`gemini-3-flash-preview`, `temperature: 0.1`) → ein Helper-Aufruf wäre trivial. Critic-Tier candidate. |
| 2  | 3 | Image Enhance           | `lib/image-enhance.js`                         | 3  | Model-Strings hardcoded (`gemini-3-pro-image-preview`, `gemini-3-flash-preview`) → muss `resolveImageEnhanceModel()` nutzen. |
| 3  | 2 | Image Grouping          | `services/image-grouping.js`                   | 12 | 3× identische `{ temp:0.1, topP:0.8, topK:16, maxOutTok:8192/1024 }`-Blöcke → 1× Helper-Konstante reicht. |
| 4  | 2 | Generative Identify     | `services/generative-identify.js`              | 4  | Legacy-File. Wird ggf. in B.2 deprecated, aber bis dahin: Migration auf gemini-config nicht nötig. **DEPRECATE statt MIGRATE** empfohlen. |
| 5  | 2 | V3 Stage 3              | `lib/identify-v3-stage3.js`                    | 2  | Nur 2 Literale (`temp 0.1`, `maxOutTok 1024`) — kleinste Migration im Top-10. |
| 6  | 2 | eBay Auto-Fix           | `services/ebay-auto-fix.js`                    | 2  | `generateText(..., { temperature: 0.3, maxOutputTokens: ASPECT_GEMINI_MAX_TOKENS })` → ein Inline-Spread auf `buildGenerationConfig()` reicht. |
| 7  | 2 | Listing Pipeline        | `services/listing-pipeline.js`                 | 2  | `temp: 0.3, maxOutTok: 2048` — Migration trivial. |
| 8  | 1 | gemini3-client (helper) | `lib/gemini3-client.js`                        | 13 | **WICHTIG:** Dieser Helper wird von vielen Callern genutzt — Migration hier erhöht den Score-0-Anteil indirekt für mehrere upstream-Caller. Hoher ROI. |
| 9  | 1 | Enrichment Pipeline     | `services/enrichment.js`                       | 12 | 3 separate Sub-Pipelines mit unterschiedlichen Temperaturen (0.2, 0.7, 0.2). Konsolidierung in F.1b nötig. |
| 10 | 1 | gemini-structured (helper) | `lib/gemini-structured.js`                  | 5  | Default-Args sehr alt (`temp: 0.0, topP: 0.8, topK: 40`) — könnte Drift gegenüber neuen Gemini-3-Empfehlungen erzeugen. |

**Migration-Reihenfolge-Empfehlung (für F.1b, Round-3-Plan):**

1. **Batch 1 — Helper-Layer** (höchster ROI): `gemini3-client`, `gemini-structured` (#8, #10) → reduziert Drift bei vielen Up-Stream-Callern, ohne dass diese geändert werden müssen.
2. **Batch 2 — Identify** (aktive Pipeline): `V3 Stage 3` (#5), `Image Enhance` (#2), `Product Validator` (#1).
3. **Batch 3 — Tools/Other**: `Image Grouping` (#3), `Listing Pipeline` (#7), `eBay Auto-Fix` (#6), `Enrichment Pipeline` (#9).
4. **Defer / Sunset**: `Generative Identify (legacy)` (#4) — Phase B.2 deprecated den File. Migration **nicht nötig**, statt dessen Sunset-Datum dokumentieren.

---

## 4. Audit-Reproduktion

```bash
cd /Users/oguz/Dev/avycloud/backend
node scripts/audit-llm-config.js
# Stdout: Markdown-Tabelle + Top-10 + Per-Caller-Detail
# JSON: /tmp/llm-config-audit.json
# Exit: 0 = erfolgreich
```

Das Skript ist **read-only** und touched keine Caller-Files. Es ist sicher in CI als Audit-Step einsetzbar (z. B. als Phase-F.6-Erfolgs-Metrik: „Drift-Score-Reduktion über Zeit").
