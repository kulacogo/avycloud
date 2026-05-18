---
title: LLM-Prompts — Wo Prompts leben & wie sie gebaut werden
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Prompts

> Es gibt **zwei Quellen** für LLM-Prompts: Firestore-versionierte Scope-Configs (Charta-konform) und Inline-Builder im Code (legacy, additiv überlagert). Ziel-Architektur (Phase F): alle Prompts → Scopes. Aktueller Zustand: dual-source mit additiver Bridge.

## 1. Quellen-Übersicht

| Quelle | Wo | Live? | Wer nutzt es |
|---|---|---|---|
| **Scope-JSONs** (Source-of-Truth, in Git versioniert + per Firestore live-editierbar) | [backend/lib/llm-prompts/scopes/*.json](../../../backend/lib/llm-prompts/scopes/) | live | `resolveScopeConfig()` ([backend/lib/llm-config.js](../../../backend/lib/llm-config.js)) — Chat V3/V2, Improve, einige Identify-Worker |
| **Zod-Output-Schemas** (Stufe-1 safeParse, Stufe-2 strict) | [backend/lib/llm-schemas/*.js](../../../backend/lib/llm-schemas/) | live (Helper-Layer) | `gemini3-client._validateAgainstScope`, `gemini-structured._validateTextPayload` |
| **Inline System-Prompts** im Code | `gemini3-client.js` (`identifyProductWithGrounding`, `identifyProductFocused`, `generateProductContent`), `services/product-chat-v3.js` (`buildSystemPromptV3`), `services/product-chat-v2.js`, `services/product-chat.js` | live | Identify-Hot-Paths + Chat-Pipelines |
| **Cassini-Prompt-Builder** | `buildImprovePromptExtension()` ([gemini3-client.js:537](../../../backend/lib/gemini3-client.js)) | live | Improve-Pipeline + Stage-3-Content-Generation |
| **Schema-Konstanten** (`FULL_PRODUCT_SCHEMA`, `RECOGNITION_SCHEMA`, `CONTENT_SCHEMA`) | [gemini3-client.js:473, 743, 841](../../../backend/lib/gemini3-client.js) | live | als `responseJsonSchema` der Gemini-Calls |
| **Policy-Pack** (gemeinsame Compliance-Texte) | `buildCommonPolicyText()` ([backend/lib/llm-policy-pack.js](../../../backend/lib/llm-policy-pack.js)) | live | Chat V2 + Legacy |

## 2. Scope-Layout

Pro Scope existiert eine JSON-Datei mit identischer Struktur:

```json
{
  "scopeId": "chat.product",
  "name": "...",
  "purpose": "...",
  "defaultModelEnvKey": "GEMINI_CHAT_MODEL",
  "version": {
    "promptMode": "replace",
    "rulesMode": "append",
    "note": "Versions-Note + Quellenhinweis",
    "promptText": "Du bist ein Produkt-Research-Agent ...",
    "rulesText": "1. Jede neue Faktenbehauptung MUSS ...",
    "userTemplate": "{{userMessage}}\n\nAktueller Produkt-Snapshot:\n{{productSnapshot}}",
    "outputSchemaHint": "{ \"answer\": string, \"sources\": [...] }",
    "modelOverride": null,
    "generationConfig": {
      "temperature": 1.0,
      "maxOutputTokens": 8192,
      "thinkingConfig": { "thinkingLevel": "high", "includeThoughts": true }
    },
    "leitfadenSections": ["Sektion 3 — Titel", "Sektion 7 — Compliance"]
  },
  "tenantOverrides": {}
}
```

### Aktive Scopes (Stand 2026-05-18)

| Scope | Datei | Nutzer |
|---|---|---|
| `chat.product` | [chat-context.json](../../../backend/lib/llm-prompts/scopes/chat-context.json) | Chat V3 + V2 (`product-chat-v3.js _tryResolveScopeConfig`, `product-chat-v2.js _tryResolveScopeConfigChatV2`) |
| `chat.update_datasheet` | [chat-update-datasheet.json](../../../backend/lib/llm-prompts/scopes/chat-update-datasheet.json) | Chat V3 + V2 Tool-Use-Pipeline |
| `identify.identity` | [identify-identity.json](../../../backend/lib/llm-prompts/scopes/identify-identity.json) | V4 identity-worker |
| `identify.category` | [identify-category.json](../../../backend/lib/llm-prompts/scopes/identify-category.json) | V4 category-worker (delegiert) |
| `identify.attributes` | [identify-attributes.json](../../../backend/lib/llm-prompts/scopes/identify-attributes.json) | V4 attributes-worker |
| `identify.seo_title` | [identify-seo-title.json](../../../backend/lib/llm-prompts/scopes/identify-seo-title.json) | V4 seo-worker |
| `identify.seo_description` | [identify-seo-description.json](../../../backend/lib/llm-prompts/scopes/identify-seo-description.json) | V4 seo-worker |
| `identify.pricing` | [identify-pricing.json](../../../backend/lib/llm-prompts/scopes/identify-pricing.json) | V4 pricing-worker |
| `identify.image` | [identify-image.json](../../../backend/lib/llm-prompts/scopes/identify-image.json) | V4 image-worker |
| `identify.gpsr` | [identify-gpsr.json](../../../backend/lib/llm-prompts/scopes/identify-gpsr.json) | V4 gpsr-worker |
| `identify.critic` | [identify-critic.json](../../../backend/lib/llm-prompts/scopes/identify-critic.json) | V4 critic-worker (Flash) |
| `quality.gate` | [quality-gate.json](../../../backend/lib/llm-prompts/scopes/quality-gate.json) | `services/quality-gate.js` (optional) |

`improve.product` ist als Scope-ID in der Charta referenziert; konkrete JSON-Datei steht noch aus (TODO in Phase F).

### Merge-Order (Charta §1)

```
gemini-config-Defaults  <  Scope.generationConfig  <  tenantOverrides[tenantId]  <  callerOverrides
```

Beispiel — Chat-V3 nutzt `_tryResolveScopeConfig('chat.product', tenantId, { temperature: DEFAULT_CHAT_TEMPERATURE, maxOutputTokens: 12000, thinkingConfig: defaultThinkingConfig({ level: 'high', includeThoughts: true }) })`. Das sind **Legacy-Defaults als `callerOverrides`**, die als Schutz vor "Scope verschwunden / Firestore-Fehler" stehen bleiben. Diese Defaults werden bei vorhandenem Scope vom Scope-Wert überschrieben.

### Versioning-Workflow

| Trigger | Neue Version Pflicht? |
|---|---|
| Prompt-Text-Änderung | **Ja** |
| Rules-Text-Änderung | **Ja** |
| `modelOverride`-Wechsel | **Ja** |
| `generationConfig`-Änderung | **Ja** |
| `outputSchemaHint`-Erweiterung | **Ja** |
| `tenantOverrides`-Hinzufügen | Nein (kein Versions-Bump nötig) |

Versionen sind unveränderlich (`createScopeVersion()`). Activation läuft separat via `activateScopeVersion()`. A/B per Tenant über `tenantOverrides[tenantId].version`. Volltext: [docs/standards/llm-quality-parity.md §3](../../standards/llm-quality-parity.md).

## 3. Builder-Pattern

### `buildSystemPromptV3(product, opts)`

Quelle: [backend/services/product-chat-v3.js:425](../../../backend/services/product-chat-v3.js).

Strukturiert den System-Prompt aus:
1. Statischer Header ("Du bist ein Produkt-Research-Agent…").
2. **Snapshot des Produkts** (`summarizeProduct(product)`) — nur `identification`, `identifiers`, top-20 `attributes`, `categoryId`, `imageCount`. Truncated auf 160/120/40 chars für UI-relevante Felder.
3. **Tool-Liste** generiert aus `atomicTools.buildToolList()` (Names + Descriptions).
4. **Arbeitsfluss** (Recherche-Phase → Write-Phase mit `update_product_datasheet` Pflicht).
5. **Regeln** (Cross-Reference ≥ 2 Quellen, keine erfundenen URLs, Quellen inline als `[Quelle: URL]`).
6. **Output-Format** + Locale.

### `buildImprovePromptExtension(ctx)`

Quelle: [backend/lib/gemini3-client.js:537](../../../backend/lib/gemini3-client.js).

Liefert Cassini-spezifische Anweisungen als String, der in Stage-3- oder Improve-Prompts eingehängt wird:
- Bestehende Produktdaten als Kontext ("verbessere, erfinde nichts Neues").
- Wettbewerber-Titel aus `ctx.titleInsights.sampleTitles` (eBay-Browse-API).
- Top-Keywords aus `ctx.titleInsights.topTokens`.
- Cassini-Optimierungs-Regeln (Titel-Struktur, Keyword-Dichte 5–7 %, HTML-Beschreibungs-Struktur, Highlights als "Nutzen — Eigenschaft", Mobile-Snippet ≤ 800 chars).

### `FULL_PRODUCT_SCHEMA` (Identify-Grounding)

Quelle: [backend/lib/gemini3-client.js:473](../../../backend/lib/gemini3-client.js).

Vollständiges OBJECT-Schema mit:
- Identity: `brand`, `model`, `sku`, `variant`, `gtin`, `ean`, `upc`, `mpn`, `color`, `size`, `material`, `condition`, `weight_grams`.
- Category: `internalCategory` (Pfad-String).
- Marketplace-Output: `title_ebay` (70–80 chars), `title_kaufland` (≤ 100), `description_ebay` (HTML 180–240 Wörter), `description_kaufland`.
- `key_features` (5–7 Bulletpoints, je 70–120 chars).
- `item_specifics` (Array `{key, value}`, mind. 10 Einträge).
- Pricing: `price_eur`, `price_source_url`, `price_source_name`.
- Web-Bilder: `web_image_urls` (max 3).
- GPSR: `gpsr_manufacturer_name/address/email/phone/country`.
- `mobile_snippet` (compact, ≤ 800 chars, plain text).

`required`: `brand`, `model`, `internalCategory`, beide `title_*`, beide `description_*`, `item_specifics`.

### Weitere Schema-Konstanten

| Konstante | Wo | Nutzer |
|---|---|---|
| `RECOGNITION_SCHEMA` | [gemini3-client.js:743](../../../backend/lib/gemini3-client.js) | `identifyProductFocused` (V3 Stage 1) — Identity-Only, keine Content-Felder |
| `CONTENT_SCHEMA` | [gemini3-client.js:841](../../../backend/lib/gemini3-client.js) | `generateProductContent` (V3 Stage 3) — Titles + Description + Item-Specifics + GPSR + Mobile-Snippet |

## 4. Zod-Schema-Validation

**Two-Stage-Modell** (Phase F.3, [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md)):

| Stufe | ENV | Verhalten |
|---|---|---|
| Stufe 1 (Default) | `LLM_SCHEMA_STRICT=false` | `safeParse()` + Logger-Warn bei Drift. Returniert Original-Payload (kein Throw). Sampling via `LLM_SCHEMA_VALIDATE_RATE` (Default `1.0`). |
| Stufe 2 (opt-in) | `LLM_SCHEMA_STRICT=true` | `parse()` + Throw mit `LLM_SCHEMA_VALIDATION_FAILED`-Error. Empfohlen erst nach ≥ 7 d safeParse-Beobachtung pro Scope ohne neue Violations. |

**Schema-Registry:** [backend/lib/llm-schemas/_index.js](../../../backend/lib/llm-schemas/_index.js) (`SCHEMA_REGISTRY` + `getSchemaForScope(name)` + Aliase wie `identity`, `chat_context`, `quality_gate`).

**Lookup-Strategie** in `_resolveScopeForValidation(scopeConfig)` ([gemini3-client.js:43](../../../backend/lib/gemini3-client.js)):
1. `scopeConfig.outputSchemaHint` wenn String und nicht JSON-Object-Form (z. B. `"chat_context"`).
2. `scopeConfig.scopeId` als Fallback.
3. Sonst: keine Validation (additiv — kein Breaking).

> **Drift-Hinweis (Hardening-Plan Finding #7):** Identify-Hot-Paths `identifyProductFocused`, `identifyProductWithGrounding`, `generateProductContent` skippen die Helper-Validation — sie nutzen `responseJsonSchema` (Gemini-konstrainiertes Decoding), aber NICHT `_validateAgainstScope()`. Damit wirkt `LLM_SCHEMA_STRICT` dort nicht. Behebung: Wave-4-TODO im Hardening-Plan (`/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md` §E).

## 5. Active-Content + Compliance-Regeln in Prompts

Alle Scope-Prompts (Stand F.3-Compliance-Hardening 2026-05-10) enthalten eine eigene "Compliance"-Sektion:
- Kein Active Content (`<script>`, `<iframe>`, `<object>`, `<embed>`, `javascript:`-URLs, `<form>`, Flash).
- Keyword-Spamming-Limit: max 2 Wiederholungen pro Keyword pro Antwort. Token-Density < 7 %.
- Keine Duplicate-Strings: keine wörtlichen Phrasen-Wiederholungen.

Die Whitelist-Sanitizer (`sanitizeDatasheetChangeV3` in [product-chat-v3.js](../../../backend/services/product-chat-v3.js), `sanitizeListingText` in [lib/listing-sanitize.js](../../../backend/lib/listing-sanitize.js)) sind die zweite Verteidigungslinie wenn das Modell die Regel verletzt.

## 6. Wie ein neuer Prompt landet

1. **Scope identifizieren** (oder neu anlegen via Admin-UI / Firestore).
2. **JSON in `backend/lib/llm-prompts/scopes/`** anlegen mit Boilerplate (siehe `chat-context.json`).
3. **Zod-Schema** in `backend/lib/llm-schemas/` + Registrierung in `_index.js`.
4. **Caller** baut den Prompt NICHT mehr selbst, sondern lädt via `resolveScopeConfig(scopeId, tenantId, callerOverrides)` und gibt das Result als `scopeConfig` an `gemini3GenerateJSON({ ..., scopeConfig })` oder `callGeminiStructured({ ..., scopeConfig })`.
5. **Snapshot-Test** vor/nach Migration (Charta §6 Migrationsweg).
6. **`logLlmCall({ ..., scope })`** wenn Telemetrie greift (siehe [telemetry.md](telemetry.md) — aktuell nicht-wirksam).
