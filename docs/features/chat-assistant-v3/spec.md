# Chat Assistant V3 — Gemini 3 Context Circulation

## Ziel
Produkt-Recherche-Assistent der aus minimalem Input (Bild + MPN + Marke) ein vollständiges, eBay-ready Produktdatenblatt erzeugt. Nutzt Gemini 3.1 Pro Customtools mit googleSearch + urlContext + atomic tools in einem Request.

## Status
- Umgesetzt: 2026-04-22
- Feature-Flag: `CHAT_V3=false` (Dark Deploy)
- Rollout: Staging → 10% A/B → 100%

## Architektur
- Route: POST /api/chat (bestehend), neuer Pipeline-Routing: V3 → V2 → Legacy
- Service: backend/services/product-chat-v3.js
- System-Prompt: Produktkontext + Tool-Übersicht + Working-Style-Guide
- Tools:
  - googleSearch (native Gemini grounding)
  - urlContext (20 URLs/Request, liest tief)
  - 7 atomic tools: lookup_gtin, search_ebay_catalog, get_required_aspects, verify_brand, search_amazon_product, search_manufacturer_site, fetch_url_content
  - update_product_datasheet, suggest_product_images (writable)
- Generation Config: Temperature 1.0, thinking_level='high', includeThoughts=true, maxOutputTokens=12000, mediaResolution='HIGH'

## Post-Processing
1. crossReferenceProduct(draft, sourceResults) — Konsens aus 2+ Quellen
2. aggregateProductConfidence(fieldScores) — readyForPublish? missingCritical?
3. Wenn readyForPublish=false → SSE 'needs_human' Event

## Fallback-Chain
- V3 wirft 'chat-v3 failed:*' → automatisch V2
- V2 wirft → Legacy
- Alle 3 fehl → 500 mit CHAT_ALL_PIPELINES_FAILED

## Metriken (geplant)
- `chat_pipeline_used{pipeline=v3|v2|legacy}` — Counter
- `chat_confidence_overall` — Histogram
- `chat_needs_human_rate` — % calls mit readyForPublish=false
- `chat_tool_call_latency{tool=...}` — Histogram

## Tests
- Unit: backend/__tests__/services/product-chat-v3.test.js (17 tests)
- Integration (future): siehe routes/identify.js integration task

## Related Files
- backend/services/product-chat-v3.js
- backend/services/atomic-tools.js
- backend/lib/confidence-scoring.js
- backend/lib/cross-reference.js
- backend/lib/gemini-config.js
- backend/lib/prompt-cache.js
