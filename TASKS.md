# Tasks

## Active

- [x] ~~**P0: Schreibpfade auf saveProductV2() umstellen**~~ (2026-03) — Alle aktiven Schreibpfade migriert.
  - ✅ Enrichment (job-runner.js) → saveProductV2 (war bereits umgestellt)
  - ✅ Improve Runner (improve.js) → saveProductV2 (war bereits umgestellt)
  - ✅ Manuelles Speichern (routes/products.js) → saveProductV2 (war bereits umgestellt)
  - ✅ Identify Route (routes/identify.js) → saveProductV2 (war bereits umgestellt)
  - ✅ Bulk Actions (admin-bulk-actions.js) → 10× saveProductV2 (2026-03-01)
  - ✅ Deduplizierung (deduplication.js) → 1× saveProductV2 (2026-03-01)
  - ✅ Rulebook Runner (rulebook-runner.js) → 1× saveProductV2 (2026-03-01)
  - ℹ️ Product Chat — kein saveProduct()-Aufruf vorhanden
  - ℹ️ Quality Gate — kein saveProduct()-Aufruf vorhanden
  - **Verbleibend:** Nur Scripts in `backend/scripts/` nutzen noch saveProduct() — einmalige Migrations-Scripts, keine aktiven Produktions-Pfade

- [ ] **P1: Integration-Tests für Top 20 API-Endpoints** — <1% Test-Coverage bei 149 Endpoints = blind fliegen
  - Vitest-Infrastruktur steht bereits (vitest.config.js)
  - Supertest für HTTP-Testing installieren
  - Mock-Setup für Firestore + Gemini benötigt
  - Starten mit: /api/products CRUD, /api/identify, /api/orders
  - Keine Tests die externe APIs aufrufen!

- [ ] **P1: Monitoring & Error-Tracking einrichten** — Wenn ein Runner hängt merkt das aktuell niemand
  - Sentry-Integration für Error-Tracking
  - Uptime-Monitoring für /health Endpoint
  - Job-Health-Dashboard (Runner-Status, Queue-Längen)
  - Alert-Regeln: Failed Jobs > 5/Stunde, Response Time > 5s

- [ ] **P1: Job-Timeout + Dead-Letter-Queue** — Hängender Gemini-Call blockiert Worker für immer
  - Timeout (5 Min) für alle Job-Runner implementieren
  - Dead-Letter-Collection für failed Jobs
  - Retry-Logik mit exponential backoff
  - Admin-UI zum Anzeigen/Retrying von failed Jobs

- [ ] **P1: CLAUDE.md aktualisieren** — Erledigte Tasks als DONE markieren, neue Prioritäten setzen
  - Phase 1 Tasks als erledigt markieren
  - Phase 2-3 Services-Status dokumentieren (pricing, forecast, dedup, webhooks existieren)
  - Neue offene Tasks aus dieser TASKS.md referenzieren
  - Token-in-Query-Parameter Issue dokumentieren

- [ ] **P1: UI/UX — Accessibility (WCAG 2.1 AA)** — Aktuell ~30% ARIA-Abdeckung, braucht ~150+ Attribute
  - Alle interaktiven Elemente (Buttons, Links, Inputs) brauchen `aria-label` wo kein sichtbarer Text vorhanden
  - Sort-Buttons in AdminTable: `aria-sort` Attribut hinzufügen
  - Expandable Sections: `aria-expanded` + `aria-controls` hinzufügen
  - Status-Badges: semantische `role="status"` hinzufügen
  - Bilder: alle `<img>` Tags brauchen `alt` Attribut (prüfen + ergänzen)
  - Formulare: alle Inputs brauchen zugeordnete `<label>` oder `aria-label`
  - Keyboard-Navigation: Tab-Reihenfolge prüfen in AdminTable, ProductSheet, EbayListingsView
  - **Dateien:** AdminTable.tsx (3.166 Z.), ProductSheet.tsx (2.001 Z.), EbayListingsView.tsx (1.900 Z.), MobileOperationsView.tsx (1.660 Z.), OperationsView.tsx (1.374 Z.), GeminiChat.tsx (1.082 Z.)
  - **NICHT** bestehende Funktionalität ändern — nur ARIA-Attribute und Labels ergänzen

- [ ] **P1: UI/UX — Code-Splitting mit React.lazy** — Alle 49 Komponenten in einem Bundle = langsamer Initial Load
  - `React.lazy()` + `<Suspense>` für Route-basiertes Splitting in App.tsx
  - Lazy-laden: Dashboard, AdminTable, ProductSheet, EbayListingsView, WarehouseView, GeminiChat, CategoryManagement
  - Fallback-Komponente: `<Spinner />` (existiert bereits in components/Spinner.tsx)
  - **Datei:** App.tsx (1.078 Zeilen) — dort die Imports auf `React.lazy(() => import(...))` umstellen
  - **NICHT** die Komponenten selbst ändern, nur die Import-Methode in App.tsx

- [ ] **P1: UI/UX — AdminTable aufteilen** — 3.166 Zeilen in einer Komponente = schwer wartbar
  - Extrahiere: `AdminTableHeader.tsx` (Spalten-Konfiguration, Presets, Visibility-Toggle)
  - Extrahiere: `AdminTableRow.tsx` (Einzelne Zeile mit Status-Badges, Inline-Edit)
  - Extrahiere: `AdminTableBulkActions.tsx` (Bulk-Action-Bar mit allen Buttons)
  - Extrahiere: `AdminTableFilters.tsx` (Such-/Filter-Logik)
  - AdminTable.tsx bleibt als Container-Komponente die die Teile zusammensetzt
  - **WICHTIG:** Alle Props und Callbacks müssen identisch bleiben — kein Breaking Change an der Schnittstelle zu App.tsx

- [ ] **P2: UI/UX — Formular-Validierung mit React Hook Form** — Aktuell native React-Forms, manuelle Validierung, fehleranfällig
  - `npm install react-hook-form` im Root (Frontend)
  - Starten mit: LoginScreen.tsx (144 Z.), ResetPasswordScreen.tsx (231 Z.), ProductInput.tsx (479 Z.)
  - Validierungsregeln: Required-Felder, Email-Format, Passwort-Mindestlänge
  - Fehleranzeige: Inline unter dem Feld, rote Border, i18n-kompatible Fehlermeldungen
  - **NICHT** alle Formulare auf einmal umstellen — schrittweise, ein Formular pro PR

- [ ] **P2: UI/UX — Error Boundary** — Kein Error Boundary vorhanden, ein JS-Fehler crasht die ganze App
  - Neue Komponente: `components/ErrorBoundary.tsx` (React Class Component mit componentDidCatch)
  - Fallback-UI: Fehlermeldung + "Seite neu laden" Button + optional Error-Details
  - In App.tsx um die Haupt-Render-Logik wrappen
  - Optional: Sentry-Integration im componentDidCatch (wenn Sentry eingerichtet ist)
  - **Datei:** Neue Datei `components/ErrorBoundary.tsx` + Edit in App.tsx

- [ ] **P2: UI/UX — State Management aufräumen** — 18 State-Variablen in App.tsx, viel Prop-Drilling
  - Prüfen ob Zustand oder ein zweiter React Context sinnvoll ist für Product-State
  - Kandidaten für Extraktion: `products`, `productsLoading`, `productsError`, `currentProduct`, `jobStatuses`, `improveJobStatuses`
  - Neuer Context: `ProductContext` mit useProducts() Hook
  - **NICHT** AuthContext oder InventoryContext ändern — die bleiben
  - **NICHT** alles auf einmal umbauen — erst ProductContext, dann evaluieren

- [ ] **P2: UI/UX — Polling durch SSE/Realtime ersetzen** — 60s-Polling für Produktliste ist ineffizient
  - useJobStream.ts Hook existiert bereits für Jobs — gleichen Ansatz auf Products erweitern
  - Neuer Hook: `useProductStream.ts` der Firestore onSnapshot oder SSE nutzt
  - Produkt-Liste soll sich automatisch aktualisieren wenn ein Identify/Improve-Job fertig ist
  - **NICHT** den Polling-Mechanismus entfernen — als Fallback behalten
  - **NICHT** Firestore Client-SDK einführen — SSE über Backend-Endpoint bevorzugen

## Waiting On

- [ ] **Multi-Tenancy (P3-002)** — Blocker für SaaS. Nur mit expliziter Anweisung starten. since 2026-03-01
  - orgId auf jedem Firestore-Dokument
  - Alle Queries um orgId-Filter erweitern
  - Super-Admin vs. Tenant-Admin Rollen
  - Geschätzt: 6-8 Wochen

- [ ] **Stripe Billing (P3-003)** — Blocker für SaaS. Nur mit expliziter Anweisung starten. since 2026-03-01
  - 3 Tiers: Starter (50 Produkte), Pro (500), Enterprise (unlimited)
  - Usage-Tracking: Identify-Calls, Storage, Active Listings
  - Geschätzt: 2-3 Wochen

- [ ] **Amazon SP-API Integration** — Größter Marktplatz DE fehlt. since 2026-03-01
  - Bestehende Multi-Marketplace-Architektur als Grundlage
  - Amazon SP-API ist komplex (Auth, Throttling, Reports)
  - Geschätzt: 4-6 Wochen für MVP

## Someday

- [ ] **GDPR-Compliance** — Data Export (Art. 15), Data Deletion (Art. 17), Privacy Policy, DPA-Template
- [ ] **API-Dokumentation (OpenAPI/Swagger)** — Für externe Entwickler und SaaS-Kunden
- [ ] **Zapier/Make.com Integration** — Webhook-Grundlage existiert, Marketplace-Listing fehlt
- [ ] **E2E-Tests mit Playwright** — Playwright ist als Dependency vorhanden, kein Test existiert
- [ ] **Token-in-Query-Parameter fixen** — JWT als URL-Param für SSE leakt in Logs/History
- [ ] **Request Body Limit reduzieren** — 50MB → 10MB, separater Upload-Endpoint für Bilder
- [ ] **CI-Integration für Tests** — Tests laufen nicht in GitHub Actions / Cloud Build
- [ ] **Mobile App (React Native)** — Native Scanner-Workflows für Lager-Mitarbeiter
- [ ] **White-Label-Option** — Agenturen/3PLs eigene Instanz ermöglichen
- [ ] **KI-Bildoptimierung ausbauen** — Background Removal, Lifestyle-Bilder, A/B-Testing

## Done

- [x] ~~**P0-001: Security Headers mit Helmet.js**~~ (2026-02)
- [x] ~~**P0-002: Rate-Limiting auf kostenintensive Endpoints**~~ (2026-02)
  - identifyLimiter: 30 Requests / 15 Min
  - generalLimiter: 120 Requests / Min
- [x] ~~**P0-003: .env.local aus Git-Historie prüfen**~~ (2026-02)
- [x] ~~**P0-004: Firestore Daten-Normalisierung**~~ (2026-02)
  - Schritt 0: LLM-Validierung aktiviert (LLM_POLICY_ENABLED + RULEBOOK_ENABLED)
  - Schritt 1: product-canonical.js (normalizeProduct, validateCanonical, _pickCanonicalId)
  - Schritt 2: product-store.js (Dual-Write saveProductV2)
  - Schritt 3: Migration erfolgreich (786 → 784 Produkte, 364 IDs kanonisiert, 2 Duplikate gemerged)
  - Schritt 4: Cutover auf products_v2 live (USE_PRODUCTS_V2=true)
  - Schritt 5: Schreibpfade umstellen → ✅ DONE (2026-03-01, alle aktiven Services/Routes migriert)
- [x] ~~**P1-001: Structured Logging (Pino)**~~ (2026-02)
- [x] ~~**P1-002: Health-Check & Graceful Shutdown**~~ (2026-02)
- [x] ~~**P1-003: Vitest Infrastruktur**~~ (2026-02)
  - 4 Test-Suiten: gtin, product-identity, brand-normalize, product-canonical
- [x] ~~**P1-004: Error Response Standardisierung**~~ (2026-02)
  - AppError-Klasse + errorHandler Middleware
- [x] ~~**P1-005: Express Router Splitting**~~ (2026-02)
  - index.js: 7.571 → 280 Zeilen
  - 7 Router-Module: products, orders, warehouse, identify, marketplace, admin, auth
- [x] ~~**P1-006: API Versioning Strategie**~~ (2026-02)
- [x] ~~**P2-001: SSE für Job-Status**~~ (2026-02)
  - useJobStream.ts Hook im Frontend
- [x] ~~**P2-002: Pricing Engine**~~ (2026-02)
  - pricing-engine.js (156 Zeilen), priceHistory Collection
- [x] ~~**P2-003: Inventory Forecasting**~~ (2026-02)
  - inventory-forecast.js (119 Zeilen), salesVelocity + predictedStockOut
- [x] ~~**P2-004: Webhook-System**~~ (2026-02)
  - webhooks.js (88 Zeilen), HMAC-SHA256 Signierung
- [x] ~~**P2-005: Produkt-Deduplizierung**~~ (2026-02)
  - deduplication.js (172 Zeilen), EAN/MPN/Brand-Matching
- [x] ~~**P3-001: Competitor Intelligence**~~ (2026-02)
  - priceHistory Collection, Trend-Analyse
