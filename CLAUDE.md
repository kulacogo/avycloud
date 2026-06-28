# CLAUDE.md — AvyCloud

> **GOLDENE REGEL: Production darf NIEMALS negativ beeinflusst werden.**
> Kein Breaking Change. Kein Datenverlust. Kein Downtime.

## Session-Start

1. Lies `AGENTS.md` im Repo-Root (oberster Einstieg)
2. Lies `docs/kb/00-INDEX.md` und `docs/kb/13-personas/for-coding-agents.md` falls in dieser Session noch nicht gelesen
3. Lies diese Datei (`CLAUDE.md`)
4. Lies `TASKS.md` — aktive Tasks + Bugs
5. Bei Feature-Arbeit: lies `docs/kb/06-features/<feature>.md` bzw. `docs/features/<ID>/spec.md`
6. `cd backend && npm test` + `npm run build` — Baseline prüfen

## Architektur (Kurzform)

- **Frontend:** React 18 + TypeScript + Vite + Tailwind → Firebase Hosting
- **Backend:** Node.js 20 + Express (CommonJS) → Cloud Run (europe-west3)
- **DB:** Firestore (Collection: `products_v2`, USE_PRODUCTS_V2=true)
- **KI:** Google Gemini API
- **Auth:** Firebase Authentication
- **Deployment:** `main` → GitHub Actions (Frontend) + Cloud Build (Backend)

## Nicht verhandelbar

1. Keine bestehende Route ändern ohne explizite Anweisung
2. Keine Firestore-Felder umbenennen/löschen (additive only)
3. Keine Dependencies entfernen
4. Keine ENV-Vars umbenennen die in CI/CD referenziert werden
5. Keine Änderung an Dockerfile, firebase.json, cloudbuild.yaml ohne Anweisung
6. Keine Änderung an Auth (lib/auth.js, lib/rbac.js) ohne Anweisung
7. Alle Produkt-Schreibpfade über `saveProductV2()` (lib/product-store.js)
8. Alle neuen Queries/Collections mit `tenantId`
9. **Retired Middleware ist TABU** — keine alten Middleware-Integrationen reaktivieren, importieren oder per ENV konfigurieren
10. **OVERSELL-VERBOT:** Kein Code-Pfad darf `products_v2.inventory.quantity` mutieren ohne `saveProductV2()` UND `emitSyncEvent('stock:changed', ...)`. Jede Stock-Mutation MUSS innerhalb <60s einen Marketplace-Sync-Versuch triggern. Fehlgeschlagene Syncs MÜSSEN in `stock_operation_failures` landen UND vom Drain-Worker (`services/stock-failure-drain.js`) automatisch aufgegriffen werden. Siehe Incident 2026-04-23 (SKU-9871561937).
11. **Kein `omsStatus`-Direct-Write:** Order-State-Übergänge laufen AUSSCHLIESSLICH über `transitionOrder()` (`services/order-state-machine.js`). Intake-Services (`order-intake-kaufland.js`, `order-intake-ebay.js`) dürfen `order.omsStatus` NIEMALS direkt via `orderRef.update()` schreiben — sonst fehlt `order:status_changed`, `_onOrderShipped` läuft nicht, Oversell-Risiko.
12. **Kein In-Memory-Stock-Lock mehr:** Kritische Stock-Mutationen laufen durch `withStockLock()` mit Firestore-Backend (`STOCK_LOCK_BACKEND=firestore`). In-Memory-Lock nur als Test-Helper erlaubt.
13. **STOCK SINGLE WRITER INVARIANT (seit 2026-04-29, Incident SKU-0000108900 + SKU-0000041030):** Für jede physische Einheit `(sku × order)` darf `products_v2.inventory.quantity` während des Order-Lifecycle **GENAU EINMAL** dekrementiert werden. Es existieren zwei legitime Decrement-Pfade — sie sind via `order.stockDecrementedAt`-Marker MUTUALLY EXCLUSIVE:
    - **Pfad A — Pick-with-Order** (`lib/warehouse.js bookStockOut` mit `meta.orderId`): authoritativer Decrement bei physischer Pick-Bewegung. MUSS in derselben Firestore-Tx den Marker `orders/{orderId}.stockDecrementedAt + stockDecrementedBy='pick' + stockDecrementedSkus=[…]` setzen via `lib/order-stock-claim.js claimOrderStockDecrementInTx()`.
    - **Pfad B — Ship-Decrement** (`services/order-state-machine.js _onOrderShipped` → `lib/warehouse.js decrementProductByIdOrSku`): authoritativer Decrement bei Versand, NUR wenn Pfad A nicht gelaufen ist. Wird durch existierenden `alreadyDecremented`-Skip-Pfad geschützt.
    - **Verboten:**
      a) `tx.update(productRef, { 'inventory.quantity': X })` außerhalb von `lib/warehouse.js`/`lib/product-store.js`. (Früherer Sünder `routes/marketplace.js` Kaufland-Reconcile ist seit 2026-06-28 RESOLVED — der Pfad ist heute eine read-only `kauflandUnitsLive`-Query, kein `inventory.quantity`-Write mehr; abgesichert durch `backend/__tests__/oversell-invariant.test.js`, das marketplace.js + kaufland-listings-sync.js gegen `reconBatch.update(...inventory.quantity)` grept.)
      b) `bookStockOut` mit `meta.orderId` ohne `claimOrderStockDecrementInTx()`-Aufruf in derselben Tx.
      c) Stock-Mutation ohne anschließenden `notifyStockChange()`-Call (sonst kein `inventory_ledger`-Eintrag, Telemetrie blind).
    - **Repair-Path:** `backend/scripts/repair-double-decrement.js` (read-only audit + opt-in `--apply`). Erkennt `(stock_out flow=pick) ⨯ (order_decrement)` Doppelpaare in `warehouseEvents`.
    - **Regression-Test:** `backend/__tests__/stock-pick-then-ship-no-double-decrement.test.js`.
14. **KEIN DESTRUKTIVER MARKTPLATZ-FEHLERPFAD (seit 2026-06-16, Incident: 66 getötete eBay-Angebote):** Keine Fehlerbehandlung in `services/stock-sync-dispatcher.js`, `lib/ebay-trading-api.js`, `services/kaufland-listings-sync.js` darf als Reaktion auf einen Sync-/Revise-Fehler ein Listing beenden/löschen (kein Fail-safe-`EndFixedPriceItem` o. Ä.). Pflichtpfad: Fehler **klassifizieren** (keine Klasse ist destruktiv) → durable Queue → idempotenter Retry mit Backoff. Zementiert Brandfix `c339184`. Ergänzend: der Repricer darf den eBay-Sofortkaufpreis nie unter die Best-Offer-Auto-Ablehnungsschwelle senken (sonst un-synchronisierbares Listing). Plan/Detail: `docs/superpowers/avycloud-master-plan.md` (F0).

## Code-Stil

- **Backend:** CommonJS, 2 Spaces, Single Quotes, async/await, try/catch mit strukturiertem Error
- **Frontend:** TypeScript ESM, 2 Spaces, Double Quotes, Functional Components + Hooks
- **UI-Farben:** Nur Design-Tokens (`bg-accent`, nicht `bg-blue-500`). Siehe `styles/main.css`
- **Tests:** Vitest, `cd backend && npm test`. Jede neue Funktion braucht min. 1 Test
- **Git:** Conventional Commits (`feat:`, `fix:`, `refactor:`), kein Force-Push auf main

## Feature-Flags (Backend ENV-Vars)

- `IDENTIFY_V4=false` (default, dark-deployed seit 2026-04-23) — aktiviert die neue Orchestrator-Worker-Swarm-Pipeline (`backend/services/identify-v4.js`). Wave 1 (identity + category parallel) → Wave 2 (attributes, seo, pricing, image, gpsr parallel) → Refinement-Loop (max 5 Iterationen auf low-confidence Worker) → Critic. Autosave via saveProductV2 wenn `ebay_ready_score ≥ 0.6`. Fallback bei V4-Error: V3. Alle 8 Worker liefern einheitliche Shape `{ok, domain, resolved, confidence, sources, retriesRequested, meta}`. Kritische Libraries: `lib/sweet-spot-pricer.js`, `lib/seo-title-builder.js`, `lib/seo-description-builder.js`, `lib/aspect-cap-enforcer.js`, `lib/image-enhance.js`, `lib/ebay-sold-listings.js`, `lib/ebay-catalog.js`. Smoke-Test: `node backend/scripts/smoke-identify-v4.js`. Sub-Flags: `IDENTIFY_V4_AUTOSAVE=true`, `IDENTIFY_V4_MAX_ITERATIONS=5`, `IDENTIFY_V4_TIMEOUT_MS=180000`, `IDENTIFY_V4_IMAGE_ENHANCE=true`, `IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY=true`, `IDENTIFY_V4_PRICING_SOLD=true`, `IDENTIFY_V4_CRITIC_FLASH=true`, `IDENTIFY_V4_CRITIC_HINTS=true` (default — Refinement-Loop konsumiert `critic.resolved.refinement_needed_workers` zusätzlich zur Confidence-Detection; Wave-1-Lock auf `identity`+`category` wird respektiert; `=false` revertet zu pre-fix Confidence-only-Verhalten; siehe `mergeRefinementWorkers()`).
- `IDENTIFY_V4_CRITIC_HINTS_VERIFIED=false` (default, optionaler Promotion-Acknowledge-Flag) — beim Flip von `IDENTIFY_V4=true` in Production loggt `backend/index.js` ein Startup-WARN (NIE Throw/Exit), wenn dieser Flag nicht auf `true` steht. Operator muss `docs/runbooks/identify-v4-promotion.md` lesen + bestätigen. Best-effort Slack-Alert via `SLACK_ALERTS_URL`.
- `IDENTIFY_V3=true` — aktiviert Multi-Stage-Identify-Pipeline (`backend/services/identify-v3.js`). Bleibt als V4-Fallback. Produktions-ready (98% umgesetzt laut Audit 2026-04-21).
- `CATEGORY_RESOLVER_V2=true` — aktiviert mehrstufigen Kategorie-Resolver (`backend/services/category-resolver.js`). Strategie: eBay Catalog GTIN → Taxonomy Suggestions → Local Lookup → Gemini. Schreibt nur bei `confidence ≥ 0.85`. Default aus. Bei aktivem Flag: jeder UI-Save triggert fire-and-forget Auto-Correct für Produkte ohne `categorySource === 'manual'`.
- `QUALITY_GATE_ENABLED=false` — Quality-Gate abschalten (Default an).

### Chat-Assistant (neu seit 2026-04-22)
- `CHAT_V3=true` (default) — aktiviert die neue Chat-V3-Pipeline mit Gemini 3 Context Circulation (googleSearch + urlContext + custom functions + structured output in einem Request). Routing: V3 → V2 → Legacy Fallback-Chain. Siehe `backend/services/product-chat-v3.js`. **Code-Default: true (`product-chat-v3.js:80` `chatV3Enabled()`). CLAUDE.md zuvor falsch dokumentiert (false) — korrigiert 2026-05-10.** Set `CHAT_V3=false` zum Opt-out, `?pipeline=v2|legacy` per call.
- `CHAT_V2_ENHANCED=true` (default) — Gemini-3-Enhancements in V2: urlContext tool, Temperature 1.0, Thinking Mode (level=high, includeThoughts), maxOutputTokens 8192, mediaResolution HIGH. Fallback auf altes V2-Verhalten wenn `false`.
- `CHAT_LEGACY_ENHANCED=true` (default) — Legacy-Pipeline-Härtungen: ASIN-Detection, Amazon-Routing via SerpAPI `engine='amazon'`, forceOneEvidencePass bei allen Intents (nicht mehr nur `change`), Thinking Mode, erweitertes Evidence-URL-Scoring.
- `CHAT_MODEL` (optional override) — default via model-select.js: `gemini-3.1-pro-preview-customtools`
- `INTENT_MODEL` (optional override) — default: `gemini-3-flash-preview`

### Identify-Module-Härtungen
- `STAGE3_ASPECT_ENFORCEMENT=true` (default) — Stage 3 des Identify-V3 füllt systematisch alle eBay-RequiredAspects. Post-Gen-Validation + Backfill mit "Unbekannt" für fehlende. Siehe `backend/lib/identify-v3-stage3.js`.
- `STAGE3_ASPECT_REPAIR=true` (default) — wenn > 30% der required Aspects "Unbekannt" nach Erstgenerierung, triggert ein zweiter Gemini-Call mit fokussiertem Prompt zur Reparatur.
- `STAGE3_AGENTIC=true` (default) — aktiviert die agentic Stage-3-Pipeline (`backend/lib/identify-v3-stage3-agentic.js:647` `isAgenticEnabled()`) als bevorzugten Content-Generator. Multi-Tool-Loop (research + write_datasheet) statt Single-Shot. 3-Tier-Fallback: agentic → single-shot → V2-record, daher kann Runtime-Failure die Pipeline nicht brechen — graceful degradation. Sub-Flag `STAGE3_AGENTIC_SAMPLE` (0..1, deterministischer Canary-Anteil) wird NUR konsultiert wenn `STAGE3_AGENTIC` selbst nicht gesetzt ist.
- `STAGE2_WEIGHT_WEB_FALLBACK=true` (default) — Stage 2 sucht Gewicht im Web wenn Stage 1 OCR/Grounding leer lieferte. Siehe `backend/lib/weight-web-lookup.js`.
- `STAGE2_GPSR_WEB_FALLBACK=true` (default) — Stage 2 sucht Hersteller-Impressum im Web wenn Registry leer. Siehe `backend/lib/gpsr-web-fallback.js`.
- `STAGE1_IMAGE_QUALITY_GATE=true` (default) — Bild-Qualitäts-Analyse in Stage 1 (Auflösung, Hintergrund, Perceptual Hash für Dedup). Filtert User-Uploads NICHT, hängt nur Metadata an. Siehe `backend/lib/image-quality.js`.
- `STAGE1_SKIP_FOCUSED_GROUNDING=false` (default) — Emergency-Bypass: setzt `=true` wenn Gemini Grounding API bekannte 503/504-Outages hat. Stage 1 springt dann direkt zum V2-Fallback (`backend/lib/identify-v3-stage1.js:116`). NUR während Incidents setzen, zurücksetzen sobald Grounding wieder gesund (siehe `routes/identify.js` Health-Check).
- `STAGE1_SKIP_V2_FALLBACK=false` (default) — Emergency-Bypass: setzt `=true` wenn beide Grounding-APIs (focused + V2) broken sind. Stage 1 läuft dann ohne Grounding (nur OCR + Images), Confidence sinkt entsprechend. NUR im Doppel-Outage-Fall setzen, sonst massive Quality-Drop für ID-Step.
- `CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE=true` (default) — Category-Resolver berechnet Confidence dynamisch statt hard-coded. Boosts: Keyword-Match, Brand-im-Breadcrumb. Penalties: Banned-Breadcrumb, Generic-Levels. Siehe `backend/services/category-resolver.js`.
- `IDENTIFY_V3_GPSR_CONSENSUS=false|shadow|true` (default `false`) — GPSR-Merge in `services/identify-v3.js assembleProduct()` (Felder: manufacturer_name, manufacturer_address, email, manufacturer_phone, entity_country). Drei Modi:
    - **`false` (default)**: legacy `pickFrom()`-Fallback — strikte Priorität Registry > Stage-3 LLM > Web-Fallback. Bestehendes Verhalten unverändert.
    - **`shadow`**: beide Pfade laufen (alt + neu), Diffs werden via `lib/logger` mit Tag `[GPSR-Consensus-Shadow] Diff detected` geprotokolliert, aber der **alte** Pfad gewinnt. Beobachtungs-Modus für Behavior-Change-Risiko.
    - **`true`**: `resolveConsensus()` aus `lib/cross-reference.js` wird genutzt. Source-Confidenzen aus `SOURCE_WEIGHTS`: registry=0.85, gemini_inference=0.55, manufacturer_website=0.90. Bei mehrfacher Zustimmung gewinnt die Mehrheit; sonst der Kandidat mit höchstem effective-support (confidence × unique-source-count). Rollout-Plan + Diff-Thresholds: `docs/runbooks/gpsr-consensus-rollout.md`.

#### Stage3-Agentic Tuning (Sub-Flags)
Nur bei aktivem `STAGE3_AGENTIC=true` relevant. Werte ohne Suffix `_MS` sind Counts/Floats.
- `STAGE3_AGENTIC_SAMPLE` — 0.0..1.0, Canary-Sample (nur wirksam wenn `STAGE3_AGENTIC` unset).
- `STAGE3_AGENTIC_MAX_ITERATIONS=5` (default) — Max Tool-Loop-Iterationen.
- `STAGE3_AGENTIC_TIMEOUT_MS=90000` (default) — Total-Timeout der agentic Stage 3.
- `STAGE3_AGENTIC_TEMPERATURE` — default `DEFAULT_CHAT_TEMPERATURE` (siehe `lib/gemini-config.js`).
- `STAGE3_AGENTIC_MAX_TOKENS=12000` (default) — `maxOutputTokens` für agentic Calls.
- `STAGE3_AGENTIC_MAX_IMAGES=4` (default) — Max Bilder die im Initial-Prompt mitgereicht werden.
- `STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT=3` (default) — Soft-Limit für Research-Tool-Calls bevor Modell zum Write gedrängt wird.

### Feature-Flags (Canary + Timeouts)
Master-Timeouts und Canary-Steuerung für Identify-Pipelines (`routes/identify.js:265-289`, `lib/gemini3-client.js:500`).
- `IDENTIFY_TOTAL_TIMEOUT_MS=360000` (default, 6 min) — Master-Timeout für gesamten `POST /api/identify`-Request. Aligned mit Cloud Run `--timeout 600` und Frontend `api/client.ts`.
- `IDENTIFY_V4_CANARY_RATE=0` (default) — Float 0..1, randomer Canary-Anteil der V4 nutzt selbst wenn `IDENTIFY_V4=false`. `0.1` = 10 % der Requests gehen an V4.
- `IDENTIFY_V4_CANARY_TENANTS=''` (default) — Komma-separierte Tenant-IDs die V4 nutzen, unabhängig von `IDENTIFY_V4_CANARY_RATE`.
- `IDENTIFY_GROUNDING=true` (default) — V2-Identify-Pipeline mit Google Search Grounding aktiviert (`services/identify-grounding.js`, `services/job-runner.js:116`).
- `IDENTIFY_GROUNDING_TIMEOUT_MS=90000` (default) — Timeout für einzelnen Grounding-Call (`lib/gemini3-client.js:500`).
- `CHAT_GROUNDING=true` (default) — Chat-V2-Pipeline (Google Search Grounding) als Fallback hinter V3 (`services/product-chat-v2.js`, `routes/identify.js:1290`).

### Stock Re-Credit Symmetry (WP4)
- `STOCK_RECREDIT_ENABLED='false'` (default `false`, Werte `false`|`shadow`|`true`) — gatet die symmetrische Bestands-Gutschrift bei Cancel/Return/Label-Cancel (`services/order-state-machine.js` `_onOrderCancelled`/`_onOrderReturned`/`_onLabelCancelled`, `services/returns-engine.js restockItem`). Spiegelt den Ship-Decrement: eine bereits dekrementierte Order, die storniert/label-gecancelt wird, schreibt den Bestand GENAU EINMAL via `bookStockIn` zurück. Idempotenz über den `claimOrderStockRecreditInTx`-Marker (`lib/order-stock-recredit-claim.js`): nie gutschreiben ohne vorherigen Decrement, höchstens eine Gutschrift pro Order. **`false`** = heutiges Verhalten exakt (nur `releaseReservation` + Resync, KEIN Re-Credit — INERT, null Verhaltensänderung). **`shadow`** = volle Entscheidung + Log `[recredit-shadow] order=… would bookStockIn sku=… qty=… bin=…`, aber KEINE Mutation/Marker. **`true`** = realer Re-Credit-Pfad (bookStockIn unter `withStockLock`, Total-Failure → Claim-Rollback + `stock_operation_failures` operation:`cancel-recredit`/`label-cancel-recredit` für den Drain). **Oversell-Guard:** der `returned`-Pfad ruft NIEMALS `bookStockIn` und erhöht NIE sellable stock — er setzt nur den neutralen Marker `stockReturnPendingGradingAt` + legt ggf. ein `returns`-Doc an; der echte Re-Credit passiert erst beim Operator-Grading (A-Ware via `restockItem` mit idempotentem `by:'return'`-Claim, B/C-Ware bleibt manuell). Optional `RECREDIT_FALLBACK_BIN` für Produkte ohne bekannten Storage-BIN. Unabhängig davon (immer aktiv, flag-frei): `FORCE_FORBIDDEN_TRANSITIONS` blockt selbst bei `force:true` eindeutig-illegale stock-relevante Moves (`shipped→shipped`, `completed→picking`).

### Background-Cron Multi-Tenant (Plan-D.0c)
- `BACKGROUND_JOB_TENANTS=''` (Komma-separiert, default leer == single tenant `'default'`) — fan-out der 6 Safety-Net-Cron-Jobs in `backend/index.js` (returns-sync, sendcloud-sync, tracking-catchup, delivery-poll, invoice-sync, refund-push) über mehrere Tenants. Mirror des `STOCK_FAILURE_DRAIN_TENANTS`-Patterns. Helpers: `lib/background-job-tenants.js` (`getBackgroundJobTenants()`, `runForEachBackgroundJobTenant()`). Bei leerem ENV unverändertes Single-Tenant-Verhalten (`tenantId:'default'`). Errors per-tenant werden gefangen + geloggt, eine bad-tenant-Iteration unterbricht nicht die übrigen.

### Gemini-Infrastructure
- `GEMINI_PROMPT_CACHE=true` (default) — aktiviert Prompt-Caching via `backend/lib/prompt-cache.js`. 90 % Kosten-Ersparnis auf System-Prompts bei wiederholten Calls (Bulk-Ops, Multi-Turn-Chats). Min. 4096 Tokens für Cache-Eligibility, default TTL 60min.
- `ATOMIC_TOOLS_TIMEOUT_MS=15000` (default) — Per-Executor-Timeout für atomic-tools Library (`lookup_gtin`, `search_ebay_catalog`, `get_required_aspects`, `verify_brand`, `search_amazon_product`, `search_manufacturer_site`, `fetch_url_content`).

### Observability (Sprint 1 Tag 1+2)
- `EXTERNAL_API_TRACKER_SAMPLE_RATE=1.0` (default, 0..1) — Sample-Rate für `external_api_calls`-Firestore-Writes (`backend/lib/external-api-tracker.js`). Tracker erfasst pro Call: service (`serpapi`, `brightdata`, …), endpoint, success, latencyMs, errorCode — fire-and-forget, NIE blocking. Default 1.0 sammelt jeden Call; nach Baseline-Daten (~2 Wochen) auf `0.1` drosseln, um Firestore-Write-Volumen zu reduzieren. Genutzt von `/api/health/identify` (Aggregat-Stats für Operator-Dashboard) — Antwort auf „brauchen wir BrightData noch?" mit Daten statt Meinungen.

### LLM-Quality-Parity (Phase F.3 + Telemetry)
Schema-Validation und Telemetrie-Sampling für die LLM-Quality-Parity-Charta (`docs/standards/llm-quality-parity.md`).
- `LLM_SCHEMA_STRICT=false` (default) — Phase F.3 Stufe 1 (safeParse-warn). Validiert LLM-Responses gegen Zod-Schemas und loggt nur Warnings bei Fehlern. Setze `true` für Stufe-2-strict-throw NUR nach min. 7d safeparse-Beobachtung pro Scope ohne neue Schema-Violations. ENV-Var. Sub-Flag `LLM_SCHEMA_VALIDATE_RATE` steuert das Sampling.
- `LLM_SCHEMA_VALIDATE_RATE=1.0` (default) — Sample-Rate für Stufe-1-Logging (Float 0..1). `1.0` validiert jeden Call, `0.1` nur 10 % der Calls. Volume-Drossel für hot scopes.
- `LLM_TELEMETRY_SAMPLE=0.1` (default) — Sample-Rate für `llm_call_telemetry`-Schreibungen in Firestore (Float 0..1). Auto-Downgrade auf 0.1 nach 24h wenn ENV-Wert >0.5 (Cost-Guard). Kann via Firestore-Doc `system/llm-telemetry-state` runtime-überschrieben werden — ENV gewinnt bei Konflikt. Siehe `docs/standards/llm-quality-parity.md` §Telemetrie.
- `TENANT_ID=avycloud` (default, Scripts-only) — Default-Tenant für CLI-Scripts ohne explizites `--tenant`-Flag. Operator muss explizit `--tenant trendocean` setzen oder `TENANT_ID=trendocean` exportieren für Multi-Tenant-Runs. NIE für Production-Backend-Code lesen; nur Scripts.

### Background-Jobs + LLM-Model-Overrides
- `BACKGROUND_JOB_TENANTS` (default empty) — Komma-separierte Liste von Tenant-IDs für den Multi-Tenant-Fan-Out der 6 safety-net cron jobs in `backend/index.js`. Leer → legacy single-tenant Mode (`tenantId='default'`). Per-Tenant-Errors werden gefangen und geloggt; ein kaputter Tenant blockt keinen anderen.
- `GEMINI_CHAT_MODEL` (optional override) — ENV-Key in `backend/lib/llm-prompts/scopes/chat-context.json` (`defaultModelEnvKey`) zur Override des Default-Chat-Models. Default kommt aus `model-select.js` (`gemini-3.1-pro-preview-customtools`). Setzen nur für gezielte Canary-/Rollback-Tests pro Scope.

## Admin Bulk-Actions

- `recategorize_v2` (via `POST /api/admin/bulk/run`): massen-Korrektur der Kategorie für Bestandsprodukte. DryRun-first (`apply: false`), Safety-Mechanismen: Pre/Post-Count-Guard (Toleranz 10), `MIN_APPLY_CONFIDENCE = 0.8` (auch bei `minConfidence`-Override min 0), skip `categorySource === 'manual'`, skip `ops.last_saved_source === 'ui'` (außer `includeUi: true`). Reports: `summary.json` + `apply_repairs.json`/`dryrun_repairs.json` in GCS.

## eBay Auto-Fix

Beim Publish-Fehler greift `backend/services/ebay-auto-fix.js` mit 4 Strategien (max 2 Retries):
1. Kategorie-Mismatch → `primaryCategoryId` droppen
2. Pflicht-Aspects fehlen → Gemini generiert Werte für `details.attributes`
3. Image-Konflikt (EPS vs. eigene Bilder) → `skipEbayCatalogLookup` (nur wenn eigene Bilder vorhanden)
4. Aspect-Cap >45 → Priorisierte Trimmung (Required > Recommended > Optional)

## Category-Source-Protection

- `details.categorySource: 'manual' | 'auto:catalog' | 'auto:suggestions' | 'auto:local' | 'auto:gemini'`
- Wenn `manual`: `enforceEbayAspects` (`backend/lib/firestore.js`) blockt auto-Overrides.
- UI setzt `manual` in `handleCategorySelect` (ProductSheet.tsx).

## Chat-Assistant-Architektur (seit 2026-04-22)

### 3 Pipelines in Kaskade
1. **V3** (`backend/services/product-chat-v3.js`, flag `CHAT_V3`): Gemini 3.1 Pro Customtools mit `googleSearch + urlContext + 7 atomic-tools + update_datasheet` in einem Request. Thinking Mode high, Thoughts-Streaming, Cross-Reference + Confidence-Scoring post-generation. **Default ON (Code-Default: true).**
2. **V2** (`backend/services/product-chat-v2.js`): Google Search Grounding + custom function declarations. Mit `CHAT_V2_ENHANCED=true` zusätzlich urlContext, Temperature 1.0, Thinking. Default-Pipeline wenn V3 aus.
3. **Legacy** (`backend/services/product-chat.js`): BrightData/SerpAPI external tools. Mit `CHAT_LEGACY_ENHANCED=true` Amazon-Routing, forceEvidencePass für alle Intents. Fallback-only.

Routing: `req.body.pipeline` kann `'v3'|'v2'|'legacy'|'auto'` (default) setzen. Bei Error in einer Pipeline automatischer Fallback zur nächsten.

### Neue Libraries (alle additiv)
- `backend/lib/gemini-config.js` — zentrale Defaults (Model, Temperature, Thinking, Safety, Media Resolution)
- `backend/lib/confidence-scoring.js` — Per-Field-Thresholds (GTIN 0.95, category 0.85, brand 0.9, etc.) + Multi-Source-Boost + Disagreement-Penalty
- `backend/lib/cross-reference.js` — normalisiert Werte (GTIN digits-only, Brand strip GmbH), ermittelt Konsens aus mehreren Source-Results
- `backend/lib/prompt-cache.js` — Gemini Context Caching wrapper (in-process LRU + remote cache)
- `backend/lib/weight-web-lookup.js` — Best-effort Web-Search für Product-Gewicht
- `backend/lib/gpsr-web-fallback.js` — Best-effort Impressum-Scrape für GPSR
- `backend/lib/image-quality.js` — Bild-Analyse mit sharp (Auflösung, Hintergrund, aHash)
- `backend/services/atomic-tools.js` — 7 atomare Gemini Function Declarations + Executors (lookup_gtin, search_ebay_catalog, get_required_aspects, verify_brand, search_amazon_product, search_manufacturer_site, fetch_url_content)

### Confidence-Thresholds (per-field)
gtin/ean/upc=0.95, categoryId=0.85, brand=0.90, mpn=0.85, title=0.70, description=0.60, requiredAspects=0.80, price=0.70, weight=0.70, gpsr=0.75

### Pipeline-Rollout-Strategie
1. Aktuell: **CHAT_V3=true default (Code seit `product-chat-v3.js:80`)**. V2+Legacy mit allen Härtungen aktiv (CHAT_V2_ENHANCED + CHAT_LEGACY_ENHANCED default on) als Fallback-Chain.
2. Routing-Cascade: V3 → V2 → Legacy. Bei Error in einer Pipeline automatischer Fallback zur nächsten.
3. Legacy bleibt auf unbestimmte Zeit als Notfall-Fallback.

## Weiterführende Regeln

Path-scoped Rules in `.claude/rules/` werden automatisch geladen wenn relevante Dateien bearbeitet werden.
Feature-Specs unter `docs/features/<ID>/spec.md` enthalten alle Details pro Feature.
Aktuelle Roadmap: `/Users/oguz/.claude/plans/avycloud-roadmap-nachhaltig.md`
Aktiver Stabilisierungs-/Fundament-Plan (verbindlich für Reliability/Bestand/Sync): `docs/superpowers/avycloud-master-plan.md` — Umsetzung **Track 1** in Teil K. Übergabe-/Abnahme-Logik für Coding-Agenten (ein Branch/PR pro Arbeitspaket, Tests zuerst, Owner-Abnahme): `docs/superpowers/avycloud-execution-guide.md`.
- LLM-Quality-Parity-Charta: alle LLM-Calls folgen [docs/standards/llm-quality-parity.md](docs/standards/llm-quality-parity.md). Inventur in [docs/standards/llm-callers-inventory.md](docs/standards/llm-callers-inventory.md).
