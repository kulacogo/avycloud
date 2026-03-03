# CLAUDE.md — AvyCloud Development Guide

> **🛡️ GOLDENE REGEL: Die App in Production darf NIEMALS negativ beeinflusst werden.**
> Kein Breaking Change. Kein Datenverlust. Kein Downtime. Zero Regression.

---

## Projekt-Übersicht

AvyCloud ist ein Product Intelligence Hub für E-Commerce: KI-gestützte Produkterkennung, Multi-Marktplatz-Sync (eBay, Kaufland, BaseLinker), Lagerverwaltung und Auftragsabwicklung.

### Architektur

```
Frontend:  React 18 + TypeScript + Vite + Tailwind → Firebase Hosting
Backend:   Node.js 20 + Express 4.19 (CommonJS) → Google Cloud Run (europe-west3)
Datenbank: Google Cloud Firestore (NoSQL) — aktive Collection: products_v2
Storage:   Google Cloud Storage (gs://prodsandjobs)
KI:        Google Gemini API (@google/generative-ai)
Auth:      Firebase Authentication
```

### Verzeichnisstruktur

```
/                        → Frontend (React/TypeScript/Vite)
├── components/          → React-Komponenten (~50 Dateien)
├── hooks/               → Custom React Hooks (u.a. useJobStream.ts)
├── context/             → AuthContext, InventoryContext
├── utils/               → Frontend-Utilities
├── api/client.ts        → API-Client (fetch wrapper)
├── types.ts             → TypeScript-Definitionen
├── i18n.tsx             → Internationalisierung (DE/EN/TR)
├── App.tsx              → Haupt-Routing & State
│
├── backend/             → Backend (Node.js/Express)
│   ├── index.js         → Express-Server Entry (~280 Zeilen)
│   ├── routes/          → 7 Router-Module (products, orders, warehouse, identify, marketplace, admin, auth)
│   ├── lib/             → 81+ Utility-Module
│   ├── services/        → 29+ Service-Module
│   ├── scripts/         → Utility/Migrations-Scripts
│   ├── __tests__/       → Vitest-Tests (119 Tests, 7 Suiten)
│   └── cloudbuild.yaml  → Cloud Build Deployment
│
├── Dockerfile           → Cloud Run Container-Definition
├── firebase.json        → Firebase Hosting Config
└── .github/workflows/   → GitHub Actions (Frontend CI/CD)
```

### Deployment

- **Frontend:** Push to `main` → GitHub Actions → `npm run build` → Firebase Hosting
- **Backend:** Push to `main` → Cloud Build → Docker Build → Cloud Run Deploy

### Aktiver Task-Stand

**Alle aktiven Tasks stehen in [`TASKS.md`](./TASKS.md)** — dort IMMER zuerst nachsehen.

**Abgeschlossen (Phase 1–3, Stand 2026-03):**
- ✅ Security: Helmet.js, Rate-Limiting (identify: 30/15min, general: 120/min), .env.local bereinigt
- ✅ Daten: Firestore-Normalisierung (products_v2 live, USE_PRODUCTS_V2=true), LLM-Policy + Rulebook aktiv
- ✅ Infrastruktur: Pino Logging, Health-Check, Graceful Shutdown, AppError + errorHandler
- ✅ Code-Qualität: Router Splitting (7 Module), API Versioning, Vitest (119 Tests)
- ✅ Services: Pricing Engine, Inventory Forecast, Webhooks, Deduplizierung, Competitor Intelligence
- ✅ Alle Schreibpfade auf `saveProductV2()` (product-store.js Abstraktionsschicht)

### Bekannte offene Issues

- **Token-in-Query-Parameter (SSE):** JWT als `?token=` URL-Parameter für SSE-Streams leakt in Logs/History
- **Pricing Engine:** Backend-only, kein Runner, kein Frontend, keine Neu/Gebraucht-Unterscheidung
- **Marketplace Sync:** Listing-Status (eBay/Kaufland) nur manuell per Button, kein automatischer Sync
- **eBay/Kaufland Update:** Preis wird in Firestore aktualisiert aber NICHT zum Marktplatz-Listing gepusht

---

## Regeln für alle Änderungen

### 🛡️ Production Safety (NICHT VERHANDELBAR)

1. **Keine bestehende Route ändern** ohne explizite Anweisung. Alle Routen in `backend/routes/` sind live.
2. **Keine Firestore-Collection-Struktur ändern.** Neue Felder erlaubt (additive only), keine Umbenennungen/Löschungen.
3. **Keine Dependencies entfernen** aus `backend/package.json` oder root `package.json`.
4. **Keine Environment-Variable umbenennen** die in `cloudbuild.yaml` oder `.github/workflows/` referenziert wird.
5. **Kein `require()`-Pfad in `backend/index.js` oder `backend/routes/*.js` ändern.**
6. **Keine Änderung an `Dockerfile`, `firebase.json`, `.firebaserc`, `cloudbuild.yaml`** ohne explizite Anweisung.
7. **Keine Änderung an Auth-Middleware** (`backend/lib/auth.js`, `backend/lib/rbac.js`) ohne explizite Anweisung.

### Code-Stil

- **Backend:** CommonJS (`require`/`module.exports`), JavaScript, 2 Spaces, Single Quotes
- **Frontend:** TypeScript, ES Modules, React Functional Components + Hooks, 2 Spaces, Double Quotes
- **Async:** `async/await` bevorzugen, keine Callbacks
- **Error Handling:** Jeder neue Endpoint braucht try/catch:
  ```js
  try {
    // logic
  } catch (err) {
    console.error(`[POST /api/example] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
  ```

### Testing

- **Framework:** Vitest — `cd backend && npm test`
- **Testdateien:** `*.test.js` neben Quelldatei oder in `__tests__/`
- **API-Tests:** `__tests__/api/` mit require.cache-Patching (kein vi.mock für CJS)
  - `_patchGcp.js` → GCP-Packages mocken
  - `_patchLocalModules.js` → ~30 lokale Module mocken
  - `_setupMocks.js` → Firestore-Spies via vi.spyOn
- **Regel:** Jede neue Funktion/Service braucht mindestens 1 Test
- **Bestehende Tests NICHT löschen**

### Git-Workflow

- Feature-Branches: `feat/`, `fix/`, `refactor/`, `chore/`
- Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`, `test:`
- Kein Force-Push auf `main`

---

## Schlüssel-Module (Referenz)

### Produkt-Datenschicht

| Modul | Zweck |
|---|---|
| `lib/product-store.js` | Abstraktionsschicht: `saveProductV2()`, `getProductV2()`, `getAllProductsV2()` — erzwingt Normalisierung |
| `lib/product-canonical.js` | `normalizeProduct()`, `validateCanonical()` — kanonisches Schema für products_v2 |
| `lib/firestore.js` | Firestore-Client + Legacy-Funktionen (saveProduct, getProduct, listOrders etc.) |
| `lib/product-schema.js` | JSON-Schema-Validierung (Ajv) für LLM-Output |
| `lib/llm-policy-pack.js` | Strikte Prompt-Regeln (LLM_POLICY_ENABLED=true) |
| `lib/llm-rulebook.js` | Post-LLM-Validierung (RULEBOOK_ENABLED=true) |

### Services

| Service | Zweck | Status |
|---|---|---|
| `services/pricing-engine.js` | Preisvorschläge, pricingRules, Repricing | ⚠️ Backend-only, kein Runner |
| `services/inventory-forecast.js` | salesVelocity, predictedStockOut, Reorder-Alerts | ✅ Aktiv |
| `services/deduplication.js` | EAN/MPN/Brand Duplikat-Erkennung, Merge | ✅ Aktiv |
| `services/webhooks.js` | HMAC-SHA256, dispatchWebhook() | ✅ Aktiv |
| `services/enrichment.js` | Produktidentifikation via Gemini (Identify) | ✅ Aktiv |
| `services/improve.js` | Datenverbesserung via Gemini (Improve) | ✅ Aktiv |

### Externe Integrationen (NICHT ändern ohne explizite Anweisung)

| Integration | Dateien |
|---|---|
| eBay OAuth + Trading API | `lib/ebay-oauth.js`, `lib/ebay-api.js`, `lib/ebay-trading-api.js`, `lib/ebay-direct.js` |
| Kaufland API | `lib/kaufland-api.js`, `lib/kaufland-taxonomy.js` |
| BaseLinker API | `lib/baselinker-*.js`, `services/baselinker-*.js`, `services/inventory-sync.js` |
| Google Gemini | `lib/gemini-client.js`, `lib/gemini.js`, `lib/gemini-structured.js` |
| SerpApi / BrightData | `services/enrichment-v2.js`, `lib/web-unlocker.js` |
| SendCloud / SevDesk | `lib/sendcloud.js`, `lib/sevdesk.js` |

### Job-Runner (NICHT ändern)

| Runner | Datei |
|---|---|
| Job Runner | `services/job-runner.js` |
| Improve Runner | `services/improve-runner.js` |
| Quality Runner | `services/quality-runner.js` |
| BaseLinker Sync | `services/baselinker-sync-runner.js` |
| Admin Bulk | `services/admin-bulk-runner.js` |
| Rulebook Runner | `services/rulebook-runner.js` |

---

## Checkliste vor jedem Commit

- [ ] Bestehende Routen unverändert? (oder explizit angewiesen)
- [ ] Keine Firestore-Felder umbenannt/entfernt?
- [ ] Keine Dependencies entfernt?
- [ ] Neue Funktion hat try/catch mit strukturiertem Error?
- [ ] Neue Funktion hat mindestens 1 Test?
- [ ] `cd backend && npm test` erfolgreich?
- [ ] `npm run build` (Frontend) ohne Fehler?
- [ ] Kein Secret/Key im Code hardcoded?
