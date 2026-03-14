# CLAUDE.md — AvyCloud Development Guide

> **🛡️ GOLDENE REGEL: Die App in Production darf NIEMALS negativ beeinflusst werden.**
> Kein Breaking Change. Kein Datenverlust. Kein Downtime. Zero Regression.

---

## Workflow — Source of Truth

> **`TASKS.md` ist die EINZIGE Source of Truth für alle Tasks, Sprint-Anweisungen und Feature-Status.**
>
> **Beim Start einer Session:**
> 1. Lies `CLAUDE.md` (diese Datei) — Projektregeln, Architektur, Safety-Rules
> 2. Lies `TASKS.md` — offene Tasks, Sprint-Blöcke, Feature-Übersicht, Modulpläne
> 3. Arbeite die offenen Tasks/Sprint-Blöcke in TASKS.md ab
>
> **KEINE separaten Sprint-Prompt-Dateien.** Alles steht in TASKS.md.
> **KEINE separaten Feature-Status-Dateien.** Feature-Übersicht steht in TASKS.md.

---

## Projekt-Übersicht

AvyCloud ist ein Product Intelligence Hub für E-Commerce: KI-gestützte Produkterkennung, Multi-Marktplatz-Sync (eBay, Kaufland), Lagerverwaltung und Auftragsabwicklung.

> **⛔ BaseLinker ist TABU.** AvyCloud hat eigene vollumfängliche Multichannel-Integrationen (eBay, Kaufland, SendCloud, SevDesk).
> TrendOcean nutzt AvyCloud OHNE BaseLinker. Alle BaseLinker-Reste werden in Phase C entfernt.
> **Kein neuer Code darf BaseLinker referenzieren.** Keine Imports, keine Funktionsaufrufe, keine ENV-Vars.

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

---

## Brand & Design System

> **PFLICHT:** Jede UI-Änderung MUSS sich an diese Brand-Guidelines halten. Keine eigenen Farben erfinden, keine Fonts ändern, keine Logo-Varianten erstellen.

### Markenname

- **Offiziell:** `avycloud` (Kleinschreibung im Wordmark-Logo)
- **In Text/Code:** `AvyCloud` (CamelCase)
- **NICHT verwenden:** AvyStock, Avycloud, AVYCloud, avy cloud

### Logo-Assets (in `/public/`)

| Datei | Typ | Verwendung |
|-------|-----|------------|
| `avy_logo.png` | Cloud-Icon (aV-Form) | App-Icon, Favicon-Basis, Sidebar-Icon (collapsed) |
| `avy_brand.png` | Wordmark "avycloud" | Sidebar (expanded), Login-Screen, Marketing |
| `logo_darkmode.png` | Wordmark hell/grau | Für dunkle Hintergründe (Dark-Theme) |
| `logo_brightmode.png` | Wordmark dunkel | Für helle Hintergründe (Light-Theme) |
| `favicon.ico` | Favicon | Browser-Tab |
| `apple-touch-icon.png` | Touch-Icon | iOS Home-Screen |
| `android-chrome-*.png` | PWA-Icons | Android, Manifest |

**WICHTIG — Sidebar-Header:**
- Sidebar **expanded**: Zeigt Wordmark-Logo (`avy_brand.png` oder theme-abhängig `logo_darkmode.png`/`logo_brightmode.png`) — KEIN Text "AvyCloud" + "Product Intelligence"
- Sidebar **collapsed**: Zeigt nur Cloud-Icon (`avy_logo.png`)
- Logo-Render in `components/Sidebar.tsx` (Zeile ~454-461)

**Veraltete Assets (Legacy, NICHT verwenden):**
- `avystock_brand_logo.png`, `avystock_brand_logo_darkmode.png`, `avystock_full_logo.png`, `avystock_app_icon.png` — alter Markenname "AvyStock", DEPRECATED

### Farben — Design Tokens

Alle Farben sind als CSS Custom Properties in `styles/main.css` definiert und über Tailwind-Klassen verfügbar.

**Brand-Farbe (Accent):**

| Token | Dark Mode | Light Mode | Tailwind-Klasse |
|-------|-----------|------------|-----------------|
| `--accent` | `#3b82f6` (Blue 500) | `#2563eb` (Blue 600) | `bg-accent`, `text-accent` |
| `--accent-dim` | `rgba(59,130,246,0.15)` | `rgba(37,99,235,0.1)` | `bg-accent-dim` |

**Logo-Blau (Wordmark "a"):**
- Hellblau/Himmelblau ~`#5BB5E8` — wird NUR im Logo-Asset selbst verwendet, NICHT als UI-Farbe

**Hintergründe:**

| Token | Dark Mode | Light Mode | Tailwind-Klasse |
|-------|-----------|------------|-----------------|
| `--bg` | `#1a1d23` | `#f5f6f8` | `bg-app-bg` |
| `--sidebar` | `#15171c` | `#ffffff` | `bg-app-sidebar` |
| `--surface` | `#21242b` | `#ffffff` | `bg-app-surface` |
| `--elevated` | `#282c34` | `#f0f1f3` | `bg-app-elevated` |
| `--border` | `#2a2d35` | `#e2e4e9` | `border-app-border` |

**Text:**

| Token | Dark Mode | Light Mode | Tailwind-Klasse |
|-------|-----------|------------|-----------------|
| `--text-primary` | `#ebeef5` | `#1a1d23` | `text-txt-primary` |
| `--text-secondary` | `#7a8090` | `#4b5063` | `text-txt-secondary` |
| `--text-muted` | `#8a8f9e` | `#6b7080` | `text-txt-muted` |

**Status-Farben:**

| Token | Dark Mode | Light Mode | Tailwind-Klasse |
|-------|-----------|------------|-----------------|
| `--success` | `#34d399` | `#059669` | `text-success`, `bg-success` |
| `--warning` | `#fbbf24` | `#b45309` | `text-warning`, `bg-warning` |
| `--danger` | `#f87171` | `#dc2626` | `text-danger`, `bg-danger` |
| `--info` | `#60a5fa` | `#2563eb` | `text-info`, `bg-info` |

Jede Status-Farbe hat eine `-dim` Variante für Hintergründe (z.B. `bg-success-dim`).

### UI-Dimensionen

| Token | Wert | Verwendung |
|-------|------|------------|
| `--radius-sm` | `6px` | Buttons, Inputs, Badges |
| `--radius-md` | `8px` | Cards, Dropdowns |
| `--radius-lg` | `12px` | Modals, große Panels |
| `--radius-xl` | `16px` | Spezial-Container |
| Sidebar-Breite | `220px` | `w-sidebar` |
| Topbar-Höhe | `56px` | `h-topbar` |

### Design-Regeln

1. **Keine hardcodierten Farben.** Immer CSS-Variablen oder Tailwind-Token verwenden (`bg-accent`, NICHT `bg-blue-500`)
2. **Dark Mode ist Default.** Light Mode wird über `[data-theme='light']` aktiviert
3. **Beide Themes testen.** Jede neue Komponente muss in Dark UND Light Mode funktionieren
4. **Logo nie verzerren.** Immer `object-contain`, nie `object-cover` oder feste Aspect-Ratios die nicht zum Logo passen
5. **Brand-Konsistenz:** Alle Marketplace-Badges, Status-Indikatoren, Buttons nutzen ausschließlich die definierten Token-Farben

### Konfigurationsdateien

| Datei | Inhalt |
|-------|--------|
| `styles/main.css` | CSS Custom Properties (alle Farb-Token, Dark/Light Theme) |
| `tailwind.config.cjs` | Tailwind-Mapping auf CSS-Variablen, Custom Sizes |
| `postcss.config.cjs` | PostCSS mit Tailwind + Autoprefixer |
| `index.html` | Meta-Tags: theme-color `#1a1d23`, Favicons, Manifest-Link |
| `public/manifest.webmanifest` | PWA-Config: background `#0f172a`, theme `#0f172a` |

---

### Aktiver Task-Stand

**Alle aktiven Tasks stehen in [`TASKS.md`](./TASKS.md)** — dort IMMER zuerst nachsehen.

**Abgeschlossen (Phase 1–3 + OMS Phase A, Stand 2026-03-13):**
- ✅ Security: Helmet.js, Rate-Limiting (identify: 30/15min, general: 120/min), .env.local bereinigt
- ✅ Daten: Firestore-Normalisierung (products_v2 live, USE_PRODUCTS_V2=true), LLM-Policy + Rulebook aktiv
- ✅ Infrastruktur: Pino Logging, Health-Check, Graceful Shutdown, AppError + errorHandler
- ✅ Code-Qualität: Router Splitting (7 Module), API Versioning, Vitest (129 Tests, 8 Suiten)
- ✅ Services: Pricing Engine, Inventory Forecast, Webhooks, Deduplizierung, Competitor Intelligence
- ✅ Alle Schreibpfade auf `saveProductV2()` (product-store.js Abstraktionsschicht)
- ✅ OMS Phase A: Natives Order Management (eBay + Kaufland direkt), 12-State Engine, Pipeline-UI
- ✅ Event-Driven Sync: Echtzeit-Sync bei Änderungen (Order/Return/Shipment/Stock), Webhooks für eBay/Kaufland/SendCloud
- ✅ Marketplace-Kommunikation: Tracking-Push + Cancellation-Push an eBay/Kaufland
- ✅ FAKE→REAL: Alle 12 Views nutzen echte API-Daten (Shipping, Invoices, Returns, Billing: 2026-03-13)
- ✅ Sidebar Logo: Wordmark-Logo ersetzt Text-Header

### Bekannte offene Issues

> **Vollständige Bug-Liste mit Root-Cause-Analyse:** Siehe `TASKS.md` → Aktive Bugs

- **Token-in-Query-Parameter (SSE):** JWT als `?token=` URL-Parameter für SSE-Streams leakt in Logs/History (BUG-SSE)
- **Pricing Engine:** Backend-only, kein Runner, kein Frontend, keine Neu/Gebraucht-Unterscheidung
- **BaseLinker-Entfernung (Phase C):** Code + ENV-Vars + Scripts müssen bereinigt werden (136+ Dateien referenzieren noch BL)

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
| `services/order-intake-ebay.js` | eBay Order-Import + Status-Reconciliation | ✅ Aktiv |
| `services/order-intake-kaufland.js` | Kaufland Order-Import + Status-Reconciliation | ✅ Aktiv |
| `services/order-state-machine.js` | 12-State OMS Engine, Transitions, Timestamps | ✅ Aktiv |
| `services/marketplace-tracking.js` | Tracking + Cancellation Push an eBay/Kaufland | ✅ Aktiv |
| `services/sync-event-bus.js` | Event-Driven Sync (Order/Return/Shipment/Stock) | ✅ Aktiv |
| `services/returns-engine.js` | Retouren-Workflow, Marketplace-Sync, Erstattung | ✅ Aktiv |
| `services/shipping-engine.js` | SendCloud Labels, Carrier-Regeln, Tracking | ✅ Aktiv |
| `services/invoice-engine.js` | Rechnungs-Generierung, SevDesk-Export | ⚠️ Draft-only, SevDesk-Export unvollständig |

### Externe Integrationen (NICHT ändern ohne explizite Anweisung)

| Integration | Dateien |
|---|---|
| eBay OAuth + Trading API | `lib/ebay-oauth.js`, `lib/ebay-api.js`, `lib/ebay-trading-api.js`, `lib/ebay-direct.js` |
| Kaufland API | `lib/kaufland-api.js`, `lib/kaufland-taxonomy.js` |
| ~~BaseLinker API~~ | ⛔ **TABU — WIRD ENTFERNT** (Phase C). `lib/baselinker-*.js` + `services/baselinker-*.js` werden gelöscht. Keine neuen Referenzen! |
| Google Gemini | `lib/gemini-client.js`, `lib/gemini.js`, `lib/gemini-structured.js` |
| SerpApi / BrightData | `services/enrichment-v2.js`, `lib/web-unlocker.js` |
| SendCloud / SevDesk | `lib/sendcloud.js`, `lib/sevdesk.js` |

### Job-Runner (NICHT ändern)

| Runner | Datei |
|---|---|
| Job Runner | `services/job-runner.js` |
| Improve Runner | `services/improve-runner.js` |
| Quality Runner | `services/quality-runner.js` |
| ~~BaseLinker Sync~~ | ⛔ **WIRD ENTFERNT** — `services/baselinker-sync-runner.js` wird gelöscht |
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
