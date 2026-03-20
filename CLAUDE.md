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

## Weiterführende Regeln

Path-scoped Rules in `.claude/rules/` werden automatisch geladen wenn relevante Dateien bearbeitet werden.
Feature-Specs unter `docs/features/<ID>/spec.md` enthalten alle Details pro Feature.
