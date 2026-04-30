# CLAUDE.md — AvyCloud

> **GOLDENE REGEL: Production darf NIEMALS negativ beeinflusst werden.**
> Kein Breaking Change. Kein Datenverlust. Kein Downtime.

## Session-Start

1. Lies diese Datei
2. Lies `TASKS.md` — aktive Tasks + Bugs
3. Bei Feature-Arbeit: lies `docs/features/<ID>/spec.md`
4. `cd backend && npm test` + `npm run build` — Baseline prüfen

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
9. **BaseLinker ist TABU** — keine neuen Referenzen, Imports oder ENV-Vars
10. **OVERSELL-VERBOT:** Kein Code-Pfad darf `products_v2.inventory.quantity` mutieren ohne `saveProductV2()` UND `emitSyncEvent('stock:changed', ...)`. Jede Stock-Mutation MUSS innerhalb <60s einen Marketplace-Sync-Versuch triggern. Fehlgeschlagene Syncs MÜSSEN in `stock_operation_failures` landen UND vom Drain-Worker (`services/stock-failure-drain.js`) automatisch aufgegriffen werden. Siehe Incident 2026-04-23 (SKU-9871561937).
11. **Kein `omsStatus`-Direct-Write:** Order-State-Übergänge laufen AUSSCHLIESSLICH über `transitionOrder()` (`services/order-state-machine.js`). Intake-Services (`order-intake-kaufland.js`, `order-intake-ebay.js`) dürfen `order.omsStatus` NIEMALS direkt via `orderRef.update()` schreiben — sonst fehlt `order:status_changed`, `_onOrderShipped` läuft nicht, Oversell-Risiko.
12. **Kein In-Memory-Stock-Lock mehr:** Kritische Stock-Mutationen laufen durch `withStockLock()` mit Firestore-Backend (`STOCK_LOCK_BACKEND=firestore`). In-Memory-Lock nur als Test-Helper erlaubt.
13. **STOCK SINGLE WRITER INVARIANT (seit 2026-04-29, Incident SKU-0000108900 + SKU-0000041030):** Für jede physische Einheit `(sku × order)` darf `products_v2.inventory.quantity` während des Order-Lifecycle **GENAU EINMAL** dekrementiert werden. Es existieren zwei legitime Decrement-Pfade — sie sind via `order.stockDecrementedAt`-Marker MUTUALLY EXCLUSIVE:
    - **Pfad A — Pick-with-Order** (`lib/warehouse.js bookStockOut` mit `meta.orderId`): authoritativer Decrement bei physischer Pick-Bewegung. MUSS in derselben Firestore-Tx den Marker `orders/{orderId}.stockDecrementedAt + stockDecrementedBy='pick' + stockDecrementedSkus=[…]` setzen via `lib/order-stock-claim.js claimOrderStockDecrementInTx()`.
    - **Pfad B — Ship-Decrement** (`services/order-state-machine.js _onOrderShipped` → `lib/warehouse.js decrementProductByIdOrSku`): authoritativer Decrement bei Versand, NUR wenn Pfad A nicht gelaufen ist. Wird durch existierenden `alreadyDecremented`-Skip-Pfad geschützt.
    - **Verboten:**
      a) `tx.update(productRef, { 'inventory.quantity': X })` außerhalb von `lib/warehouse.js`/`lib/product-store.js`. Sünder: `routes/marketplace.js:966` (Kaufland-Reconcile) — als bekannte Schuld in TASKS.md (Gap C).
      b) `bookStockOut` mit `meta.orderId` ohne `claimOrderStockDecrementInTx()`-Aufruf in derselben Tx.
      c) Stock-Mutation ohne anschließenden `notifyStockChange()`-Call (sonst kein `inventory_ledger`-Eintrag, Telemetrie blind).
    - **Repair-Path:** `backend/scripts/repair-double-decrement.js` (read-only audit + opt-in `--apply`). Erkennt `(stock_out flow=pick) ⨯ (order_decrement)` Doppelpaare in `warehouseEvents`.
    - **Regression-Test:** `backend/__tests__/stock-pick-then-ship-no-double-decrement.test.js`.

## Code-Stil

- **Backend:** CommonJS, 2 Spaces, Single Quotes, async/await, try/catch mit strukturiertem Error
- **Frontend:** TypeScript ESM, 2 Spaces, Double Quotes, Functional Components + Hooks
- **UI-Farben:** Nur Design-Tokens (`bg-accent`, nicht `bg-blue-500`). Siehe `styles/main.css`
- **Tests:** Vitest, `cd backend && npm test`. Jede neue Funktion braucht min. 1 Test
- **Git:** Conventional Commits (`feat:`, `fix:`, `refactor:`), kein Force-Push auf main

## Feature-Flags (Backend ENV-Vars)

- `IDENTIFY_V4=false` (default, dark-deployed seit 2026-04-23) — aktiviert die neue Orchestrator-Worker-Swarm-Pipeline (`backend/services/identify-v4.js`). Wave 1 (identity + category parallel) → Wave 2 (attributes, seo, pricing, image, gpsr parallel) → Refinement-Loop (max 5 Iterationen auf low-confidence Worker) → Critic. Autosave via saveProductV2 wenn `ebay_ready_score ≥ 0.6`. Fallback bei V4-Error: V3. Alle 8 Worker liefern einheitliche Shape `{ok, domain, resolved, confidence, sources, retriesRequested, meta}`. Kritische Libraries: `lib/sweet-spot-pricer.js`, `lib/seo-title-builder.js`, `lib/seo-description-builder.js`, `lib/aspect-cap-enforcer.js`, `lib/image-enhance.js`, `lib/ebay-sold-listings.js`, `lib/ebay-catalog.js`. Smoke-Test: `node backend/scripts/smoke-identify-v4.js`. Sub-Flags: `IDENTIFY_V4_AUTOSAVE=true`, `IDENTIFY_V4_MAX_ITERATIONS=5`, `IDENTIFY_V4_TIMEOUT_MS=180000`, `IDENTIFY_V4_IMAGE_ENHANCE=true`, `IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY=true`, `IDENTIFY_V4_PRICING_SOLD=true`, `IDENTIFY_V4_CRITIC_FLASH=true`.
- `IDENTIFY_V3=true` — aktiviert Multi-Stage-Identify-Pipeline (`backend/services/identify-v3.js`). Bleibt als V4-Fallback. Produktions-ready (98% umgesetzt laut Audit 2026-04-21).
- `CATEGORY_RESOLVER_V2=true` — aktiviert mehrstufigen Kategorie-Resolver (`backend/services/category-resolver.js`). Strategie: eBay Catalog GTIN → Taxonomy Suggestions → Local Lookup → Gemini. Schreibt nur bei `confidence ≥ 0.85`. Default aus. Bei aktivem Flag: jeder UI-Save triggert fire-and-forget Auto-Correct für Produkte ohne `categorySource === 'manual'`.
- `QUALITY_GATE_ENABLED=false` — Quality-Gate abschalten (Default an).

### Chat-Assistant (neu seit 2026-04-22)
- `CHAT_V3=false` (default) — aktiviert die neue Chat-V3-Pipeline mit Gemini 3 Context Circulation (googleSearch + urlContext + custom functions + structured output in einem Request). Routing: V3 → V2 → Legacy Fallback-Chain. Siehe `backend/services/product-chat-v3.js`.
- `CHAT_V2_ENHANCED=true` (default) — Gemini-3-Enhancements in V2: urlContext tool, Temperature 1.0, Thinking Mode (level=high, includeThoughts), maxOutputTokens 8192, mediaResolution HIGH. Fallback auf altes V2-Verhalten wenn `false`.
- `CHAT_LEGACY_ENHANCED=true` (default) — Legacy-Pipeline-Härtungen: ASIN-Detection, Amazon-Routing via SerpAPI `engine='amazon'`, forceOneEvidencePass bei allen Intents (nicht mehr nur `change`), Thinking Mode, erweitertes Evidence-URL-Scoring.
- `CHAT_MODEL` (optional override) — default via model-select.js: `gemini-3.1-pro-preview-customtools`
- `INTENT_MODEL` (optional override) — default: `gemini-3-flash-preview`

### Identify-Module-Härtungen
- `STAGE3_ASPECT_ENFORCEMENT=true` (default) — Stage 3 des Identify-V3 füllt systematisch alle eBay-RequiredAspects. Post-Gen-Validation + Backfill mit "Unbekannt" für fehlende. Siehe `backend/lib/identify-v3-stage3.js`.
- `STAGE3_ASPECT_REPAIR=true` (default) — wenn > 30% der required Aspects "Unbekannt" nach Erstgenerierung, triggert ein zweiter Gemini-Call mit fokussiertem Prompt zur Reparatur.
- `STAGE2_WEIGHT_WEB_FALLBACK=true` (default) — Stage 2 sucht Gewicht im Web wenn Stage 1 OCR/Grounding leer lieferte. Siehe `backend/lib/weight-web-lookup.js`.
- `STAGE2_GPSR_WEB_FALLBACK=true` (default) — Stage 2 sucht Hersteller-Impressum im Web wenn Registry leer. Siehe `backend/lib/gpsr-web-fallback.js`.
- `STAGE1_IMAGE_QUALITY_GATE=true` (default) — Bild-Qualitäts-Analyse in Stage 1 (Auflösung, Hintergrund, Perceptual Hash für Dedup). Filtert User-Uploads NICHT, hängt nur Metadata an. Siehe `backend/lib/image-quality.js`.
- `CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE=true` (default) — Category-Resolver berechnet Confidence dynamisch statt hard-coded. Boosts: Keyword-Match, Brand-im-Breadcrumb. Penalties: Banned-Breadcrumb, Generic-Levels. Siehe `backend/services/category-resolver.js`.

### Gemini-Infrastructure
- `GEMINI_PROMPT_CACHE=true` (default) — aktiviert Prompt-Caching via `backend/lib/prompt-cache.js`. 90 % Kosten-Ersparnis auf System-Prompts bei wiederholten Calls (Bulk-Ops, Multi-Turn-Chats). Min. 4096 Tokens für Cache-Eligibility, default TTL 60min.
- `ATOMIC_TOOLS_TIMEOUT_MS=15000` (default) — Per-Executor-Timeout für atomic-tools Library (`lookup_gtin`, `search_ebay_catalog`, `get_required_aspects`, `verify_brand`, `search_amazon_product`, `search_manufacturer_site`, `fetch_url_content`).

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
1. **V3** (`backend/services/product-chat-v3.js`, flag `CHAT_V3`): Gemini 3.1 Pro Customtools mit `googleSearch + urlContext + 7 atomic-tools + update_datasheet` in einem Request. Thinking Mode high, Thoughts-Streaming, Cross-Reference + Confidence-Scoring post-generation. Opt-in, default aus.
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
1. Aktuell: CHAT_V3=false default. V2+Legacy mit allen Härtungen aktiv (CHAT_V2_ENHANCED + CHAT_LEGACY_ENHANCED default on).
2. Nächster Schritt: CHAT_V3=true in Staging → A/B-Test 10% Traffic → schrittweise Rollout.
3. Legacy bleibt auf unbestimmte Zeit als Notfall-Fallback.

## Weiterführende Regeln

Path-scoped Rules in `.claude/rules/` werden automatisch geladen wenn relevante Dateien bearbeitet werden.
Feature-Specs unter `docs/features/<ID>/spec.md` enthalten alle Details pro Feature.
Aktuelle Roadmap: `/Users/oguz/.claude/plans/avycloud-roadmap-nachhaltig.md`
