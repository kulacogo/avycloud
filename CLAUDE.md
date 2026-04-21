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

## Code-Stil

- **Backend:** CommonJS, 2 Spaces, Single Quotes, async/await, try/catch mit strukturiertem Error
- **Frontend:** TypeScript ESM, 2 Spaces, Double Quotes, Functional Components + Hooks
- **UI-Farben:** Nur Design-Tokens (`bg-accent`, nicht `bg-blue-500`). Siehe `styles/main.css`
- **Tests:** Vitest, `cd backend && npm test`. Jede neue Funktion braucht min. 1 Test
- **Git:** Conventional Commits (`feat:`, `fix:`, `refactor:`), kein Force-Push auf main

## Feature-Flags (Backend ENV-Vars)

- `IDENTIFY_V3=true` — aktiviert Multi-Stage-Identify-Pipeline (`backend/services/identify-v3.js`). Default aus; V2-Fallback läuft automatisch wenn V3 failt. Produktions-ready (98% umgesetzt laut Audit 2026-04-21).
- `CATEGORY_RESOLVER_V2=true` — aktiviert mehrstufigen Kategorie-Resolver (`backend/services/category-resolver.js`). Strategie: eBay Catalog GTIN → Taxonomy Suggestions → Local Lookup → Gemini. Schreibt nur bei `confidence ≥ 0.85`. Default aus. Bei aktivem Flag: jeder UI-Save triggert fire-and-forget Auto-Correct für Produkte ohne `categorySource === 'manual'`.
- `QUALITY_GATE_ENABLED=false` — Quality-Gate abschalten (Default an).

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

## Weiterführende Regeln

Path-scoped Rules in `.claude/rules/` werden automatisch geladen wenn relevante Dateien bearbeitet werden.
Feature-Specs unter `docs/features/<ID>/spec.md` enthalten alle Details pro Feature.
Aktuelle Roadmap: `/Users/oguz/.claude/plans/avycloud-roadmap-nachhaltig.md`
