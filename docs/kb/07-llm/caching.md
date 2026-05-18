---
title: LLM Prompt-Caching — Status & Aktivierungs-Plan
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Prompt-Caching (Gemini Context-Cache)

> **STATUS: NICHT WIRKSAM IN PRODUCTION.** Das Modul existiert, das Feature-Flag `GEMINI_PROMPT_CACHE` ist code-default ON — aber es gibt **keine Production-Call-Sites**. Aktivierung steht im Hardening-Plan als Wave-4-Aufgabe an.

## 1. Was es ist

Wrapper-Modul für Gemini Context-Caching nach offizieller API (https://ai.google.dev/gemini-api/docs/caching). Ziel: System-Prompts bei wiederholten Calls (Bulk-Ops, Multi-Turn-Chat) Gemini-seitig cachen → ~10 % des normalen Input-Token-Preises laut Google.

**Code:** [backend/lib/prompt-cache.js](../../../backend/lib/prompt-cache.js).

**Tests:** [backend/__tests__/lib/prompt-cache.test.js](../../../backend/__tests__/lib/prompt-cache.test.js).

## 2. Aktueller Status — die harten Fakten

| Frage | Antwort |
|---|---|
| Modul vorhanden? | **Ja** (`backend/lib/prompt-cache.js`, ~250 LOC, getestet) |
| ENV-Flag `GEMINI_PROMPT_CACHE` greift? | **Nein** — `promptCacheEnabled()` wird nie konsultiert weil keine Call-Sites |
| In-Process LRU vorhanden? | Ja (`MEMORY_CACHE`, max 50 Einträge) |
| Wer ruft `getOrCreateCache()` in Produktion? | **Niemand** — nur der Unit-Test |
| Wer ruft `buildCachedConfig()` in Produktion? | **Niemand** |
| Folge | Jeder Identify-/Chat-Call zahlt vollen Input-Token-Preis für das System-Prompt — auch wenn der gleiche Prompt 100× pro Tag durch Bulk-Improve läuft |

> **Drift-Source:** Hardening-Plan Wave-4-Aufgabe "Prompt-Cache integrieren für Stage-3-System-Prompt + Chat-System-Instruction". Quelle: `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md` §Wave 4 + Top-7-Finding #7.

## 3. Was das Modul kann

### `getOrCreateCache({ ai, model, systemInstruction, tools, ttlSeconds })`

| Input | Verhalten |
|---|---|
| `ai` | `@google/genai` Client-Instanz (erwartet `ai.caches.create(...)`) |
| `model` | Voll-qualifizierter Modell-Name (z. B. `gemini-3.1-pro-preview-customtools`) |
| `systemInstruction` | String — wenn < **4096 Tokens** (`MIN_TOKENS`) → `{ name:null, cached:false, reason:'too_small' }` |
| `tools` | Array (wird in cache-key gehashed) |
| `ttlSeconds` | Default **3600** (60 min) |

**Return-Shape:**
```js
{
  name: 'caches/abc123' | null,  // null = kein Cache nutzbar
  cached: boolean,                // true = memory_hit, false = created/skipped
  tokensEstimated: number,
  reason: 'memory_hit' | 'created' | 'too_small' | 'no_client' | 'no_name_returned' | 'error',
  meta?: { key, model, expiresAt, createdAt },
  error?: string,
}
```

**Best-Effort-Garantie:** wirft NIE — bei jedem Fehler returniert `{ name: null, ... }` damit der Caller einfach auf non-cached Config zurückfallen kann.

### `buildCachedConfig(cacheResult, extraConfig)`

Helfer der `{ cachedContent: cacheResult.name }` in die `generateContent()`-Config einhängt — wenn kein Cache vorhanden, wird nur `extraConfig` durchgereicht.

```js
const cacheResult = await getOrCreateCache({ ai, model, systemInstruction: longPrompt, tools });
const config = buildCachedConfig(cacheResult, {
  temperature: 1.0,
  maxOutputTokens: 8192,
});
await ai.models.generateContent({ model, contents, config });
```

### `invalidateCache(ai, key)`

Bei Prompt-Updates (neue Scope-Version) — löscht lokalen + remote Cache. Kein Auto-Trigger.

### `promptCacheEnabled()`

Liest `GEMINI_PROMPT_CACHE`. Default an. Nur `'false'`/`'0'`/`'no'`/`'off'` deaktivieren.

### `computeCacheKey({ model, systemInstruction, tools })`

40-char sha256-Prefix über (normalisiertes) Input. Stabil — gleicher Prompt = gleicher Key.

### `estimateTokens(text)`

`Math.ceil(chars / 4)` — grobe Schätzung (ausreichend für die `MIN_TOKENS`-Schwelle).

## 4. Wo es greifen sollte (Aktivierungs-Plan)

| Caller | Warum lohnt es sich | Approx. System-Prompt-Tokens |
|---|---|---|
| **Chat V3** (`product-chat-v3.js buildSystemPromptV3`) | Multi-Turn-Sessions wiederholen den gleichen 4–6k-Token-System-Prompt | 4–6k (knapp über MIN_TOKENS) |
| **Identify Stage 3** (`gemini3-client.js generateProductContent`) | Bulk-Identify: gleicher Stage-3-Prompt für 50–500 Produkte hintereinander | 3–5k (knapp unter MIN_TOKENS — evtl. Prompt expandieren oder Tools mit-cachen) |
| **Identify V4 Worker** (identity, attributes) | Pro Wave 2 Aufrufe pro Worker (initial + Refinement) | 2–4k (oft zu klein für MIN_TOKENS) |
| **Improve** (`services/improve.js`) | Bulk-Operationen mit dem gleichen Cassini-Prompt-Block | 3–4k |

## 5. Aktivierungs-Plan (Wave-4)

Aus Hardening-Plan, Wave-4-Action: **"Prompt-Cache integrieren für Stage-3-System-Prompt + Chat-System-Instruction"**.

### Schritte

1. **Stage-3-Prompt** (`generateProductContent` in [gemini3-client.js:874](../../../backend/lib/gemini3-client.js)):
   - Vor `ai.models.generateContent` ein `getOrCreateCache({ ai, model, systemInstruction: prompt.text, tools, ttlSeconds: 3600 })` einbauen.
   - Config via `buildCachedConfig(cacheResult, contentConfig)`.
   - Logger-Hinweis bei `reason === 'too_small'` damit wir wissen wann Prompts den 4096-Token-Schwellwert reißen.
2. **Chat-V3-System-Instruction** (`runProductChatV3` in [product-chat-v3.js:822](../../../backend/services/product-chat-v3.js)):
   - Vor `ai.chats.create({ ..., config: { ..., systemInstruction: systemPrompt } })` ein `getOrCreateCache({ ai, model, systemInstruction: systemPrompt, tools })` einbauen.
   - `config.cachedContent = cacheResult.name` setzen (statt `config.systemInstruction`, wenn cached).
3. **Telemetrie ergänzen** (sobald `logLlmCall` aktiviert — siehe [telemetry.md](telemetry.md)): `cache_hit: boolean`, `cache_tokens_saved: number` in `meta`.
4. **Smoke-Test** mit `GEMINI_PROMPT_CACHE=false` → bestätige byte-identisches Verhalten (Fallback-Pfad).

### Erwartung

Bei 4096+-Token-System-Prompts und `gemini-3.1-pro-preview-customtools` Input-Preis `$1.25 / 1M tokens`:
- Pro Cache-Hit: ~$1.25 × 5000 / 1_000_000 × 0.9 (90 % Ersparnis) ≈ **$0.0056 pro Call gespart**.
- Bei Bulk-Improve über 500 Produkte: ~$2.81 Gemini-Cost-Reduction pro Run.
- Bei Chat-Multi-Turn 5+ Turns: pro Session zwischen $0.025 und $0.05.

(Werte konservativ — exakte Beträge erst messbar wenn Telemetrie + Cache live laufen.)

## 6. Module-API (für Aktivierungs-PRs)

```js
const {
  MIN_TOKENS,           // 4096
  DEFAULT_TTL_SECONDS,  // 3600
  MEMORY_CACHE_MAX,     // 50
  computeCacheKey,
  estimateTokens,
  getOrCreateCache,
  invalidateCache,
  buildCachedConfig,
  listActiveCaches,
  promptCacheEnabled,
} = require('../lib/prompt-cache');
```

## 7. Verweise

- Modul-Quelle: [backend/lib/prompt-cache.js](../../../backend/lib/prompt-cache.js).
- Tests: [backend/__tests__/lib/prompt-cache.test.js](../../../backend/__tests__/lib/prompt-cache.test.js).
- Google-API-Doku: https://ai.google.dev/gemini-api/docs/caching.
- Pricing: https://ai.google.dev/gemini-api/docs/pricing (cached input ~10 % of normal).
- Hardening-Plan Wave 4: `/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md` (Sektion 7 — Top-Findings, Wave 4 — LLM-Observability + Cost).
- Charta §4: [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md).
