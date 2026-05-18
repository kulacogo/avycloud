---
title: ADR-0005 — Chat V3 → V2 → Legacy Cascade
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# ADR-0005 — Chat V3 → V2 → Legacy Cascade

## Status

**Accepted** seit 2026-04-22. `CHAT_V3` Code-Default `true` (`product-chat-v3.js:80 chatV3Enabled()`), korrigiert in [CLAUDE.md](../../../../CLAUDE.md) §Chat-Assistant 2026-05-10.

## Kontext

Der Chat-Assistant im Produkt-Datenblatt muss:

- **Recherche** machen (Web-Search, GTIN-Lookup, eBay-Catalog, Amazon, Hersteller-Sites).
- **Updates** ins Datasheet schreiben (function-call `update_datasheet`).
- Per **Intent** unterschiedliche Antwort-Modi liefern (Question / Edit / Approve).
- **Evidence** liefern (URL-Quellen, Konfidenzen, Cross-Reference).

Drei historische Pfade existieren parallel — V3 ist heute der bevorzugte; V2 und Legacy bleiben als Fallback-Chain.

## Entscheidung

### Pipeline V3 (Default ON)

[backend/services/product-chat-v3.js](../../../../backend/services/product-chat-v3.js):

- Modell: Gemini 3.1 Pro Customtools (Default via [backend/lib/model-select.js](../../../../backend/lib/model-select.js), ENV-Override `CHAT_MODEL`).
- Tools in **einem** Request: `googleSearch` + `urlContext` + 7 atomic-tools + `update_datasheet`.
- **Thinking Mode** `high`, `includeThoughts: true` (Thoughts-Streaming an SPA).
- Cross-Reference + Confidence-Scoring **post-generation** via [backend/lib/cross-reference.js](../../../../backend/lib/cross-reference.js) + [backend/lib/confidence-scoring.js](../../../../backend/lib/confidence-scoring.js).

### Pipeline V2 (Fallback)

[backend/services/product-chat-v2.js](../../../../backend/services/product-chat-v2.js):

- Google Search Grounding + Custom Function Declarations.
- Mit `CHAT_V2_ENHANCED=true` (Default): zusätzlich `urlContext`, Temperature 1.0, Thinking Mode, `maxOutputTokens 8192`, `mediaResolution HIGH`.
- Default-Pipeline wenn V3 aus oder V3 wirft.

### Pipeline Legacy (letzter Fallback)

[backend/services/product-chat.js](../../../../backend/services/product-chat.js):

- BrightData + SerpAPI als externe Tools (außerhalb Gemini-Tools-API).
- Mit `CHAT_LEGACY_ENHANCED=true` (Default): ASIN-Detection + Amazon-Routing (`engine='amazon'`), `forceOneEvidencePass` bei allen Intents, Thinking Mode, erweitertes Evidence-URL-Scoring.

### Routing

- Default `req.body.pipeline = 'auto'` → V3 first.
- Explizit: `?pipeline=v2` oder `?pipeline=legacy` overridet.
- **Fail-Forward**: Error in einer Pipeline → automatischer Fallback zur nächsten.

## Confidence-Thresholds (per-field)

Aus [CLAUDE.md](../../../../CLAUDE.md):

| Field | Threshold |
|-------|-----------|
| `gtin` / `ean` / `upc` | 0.95 |
| `categoryId` | 0.85 |
| `brand` | 0.90 |
| `mpn` | 0.85 |
| `title` | 0.70 |
| `description` | 0.60 |
| `requiredAspects` | 0.80 |
| `price` | 0.70 |
| `weight` | 0.70 |
| `gpsr` | 0.75 |

## Neue Libraries (Phase Chat-V3, alle additiv)

- [backend/lib/gemini-config.js](../../../../backend/lib/gemini-config.js) — zentrale Defaults (Modell, Temperatur, Thinking, Safety, Media Resolution).
- [backend/lib/confidence-scoring.js](../../../../backend/lib/confidence-scoring.js) — Per-Field-Thresholds + Multi-Source-Boost + Disagreement-Penalty.
- [backend/lib/cross-reference.js](../../../../backend/lib/cross-reference.js) — Normalisierung (GTIN digits-only, Brand strip GmbH) + Konsens.
- [backend/lib/prompt-cache.js](../../../../backend/lib/prompt-cache.js) — Gemini Context Caching (in-process LRU + remote cache, 90 % Cost-Saving auf Sys-Prompts).
- [backend/lib/weight-web-lookup.js](../../../../backend/lib/weight-web-lookup.js).
- [backend/lib/gpsr-web-fallback.js](../../../../backend/lib/gpsr-web-fallback.js).
- [backend/lib/image-quality.js](../../../../backend/lib/image-quality.js).
- [backend/services/atomic-tools.js](../../../../backend/services/atomic-tools.js) — 7 atomare Gemini Function Declarations: `lookup_gtin`, `search_ebay_catalog`, `get_required_aspects`, `verify_brand`, `search_amazon_product`, `search_manufacturer_site`, `fetch_url_content`.

## Konsequenzen

| Positiv | Negativ |
|---------|---------|
| Bessere Qualität (Tools-in-one-Request), kürzere Latenz vs. sequenzielle Agentic-Loops. | Drei parallele Pipelines erhöhen Maintenance-Last. |
| Robuste Fallback-Chain — kein Single-Point-of-Failure. | Operator muss Pipeline-Choice / Telemetrie aktiv überwachen. |
| Confidence-Scoring + Cross-Reference verbessern Vertrauen in Auto-Updates. | Per-Tenant-Override (`tenantOverrides[tenantId].version`) erfordert disziplinierten Versions-Workflow ([docs/standards/llm-quality-parity.md](../../../standards/llm-quality-parity.md)). |

## Code-Anker

- V3: [backend/services/product-chat-v3.js](../../../../backend/services/product-chat-v3.js).
- V2: [backend/services/product-chat-v2.js](../../../../backend/services/product-chat-v2.js).
- Legacy: [backend/services/product-chat.js](../../../../backend/services/product-chat.js).
- Routing-Endpoint: [backend/routes/identify.js](../../../../backend/routes/identify.js) Z. 1290ff (siehe [CLAUDE.md](../../../../CLAUDE.md) §`CHAT_GROUNDING`).

## Querverweise

- Feature-Flags: [../../03-development/feature-flags.md](../../03-development/feature-flags.md).
- LLM-Quality-Charta: [docs/standards/llm-quality-parity.md](../../../standards/llm-quality-parity.md).
- Caller-Inventur: [docs/standards/llm-callers-inventory.md](../../../standards/llm-callers-inventory.md).
