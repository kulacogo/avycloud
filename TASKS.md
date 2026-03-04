# Tasks

## Active

- [ ] **P0: Identify-Modul stärken — API-Nutzung koordinieren**
  - ✅ Preisanreicherung Doppel-Gate aufgetrennt (2026-03-03)
  - ✅ eBay Title Insights: Keyword-Fallback wenn keine Kategorie bekannt (2026-03-03)
  - ✅ Dedizierte `image-search.js` erstellt (2026-03-04) — SerpAPI google_images + bing_images Fallback
  - ✅ `enrichment.js::runSmartImageRecovery()` nutzt jetzt `image-search.js` (2026-03-04)
  - **Offen — API-Nutzung nicht koordiniert:**
    - Orchestrierte Enrichment-Pipeline: Vision → Barcode → Web-Recherche → Title Insights → LLM-Synthese
  - **Dateien:** `enrichment.js`, `image-search.js`

- [ ] **P1: Monitoring & Error-Tracking** — Wenn ein Runner hängt merkt das niemand
  - Sentry, Uptime-Monitoring, Job-Health-Dashboard, Alerts

- [ ] **P1: UI/UX — Accessibility (WCAG 2.1 AA)** — In Arbeit
  - ✅ AdminTable: aria-label, aria-sort, Checkbox-Labels (2026-03-04)
  - ✅ GeminiChat: role=log, aria-live, aria-label (2026-03-04)
  - ✅ ProductSheet: role=alert, aria-label auf Inputs/Buttons (2026-03-04)
  - ✅ EbayListingsView, MobileOperationsView, OperationsView (2026-03-04)
  - **Offen:** Keyboard-Navigation

- [ ] **P1: UI/UX — AdminTable aufteilen** — In Arbeit
  - Extrahieren: Header, Row, BulkActions, Filters → AdminTable als Container

## Waiting On

- [ ] **Multi-Tenancy (P3)** — Blocker für SaaS. Nur mit expliziter Anweisung. since 2026-03-01
- [ ] **Stripe Billing (P3)** — Blocker für SaaS. Nur mit expliziter Anweisung. since 2026-03-01
- [ ] **Amazon SP-API Integration** — Größter DE-Marktplatz fehlt. since 2026-03-01

## Someday

- [ ] GDPR-Compliance — Data Export, Deletion, Privacy Policy, DPA-Template
- [ ] API-Dokumentation (OpenAPI/Swagger)
- [ ] Zapier/Make.com Integration
- [ ] E2E-Tests mit Playwright
- [ ] Token-in-Query-Parameter fixen — JWT als URL-Param leakt in Logs
- [ ] Request Body Limit 50MB → 10MB
- [ ] CI-Integration für Tests
- [ ] Mobile App (React Native)
- [ ] White-Label-Option
- [ ] KI-Bildoptimierung ausbauen

## Done

- [x] ~~P0: Listing-Status Frontend-Badge~~ (2026-03-04) — AdminTable + ProductSheet nutzen ops.listingStatus.ebay/kaufland, Inaktiv-Badge, Sync-Timestamp
- [x] ~~P1: Chat Intent-Detection per LLM~~ (2026-03-04) — Gemini-basiert mit 3s Timeout, Regex-Fallback
- [x] ~~P2: Formular-Validierung~~ (2026-03-04) — React Hook Form für LoginScreen + ResetPasswordScreen, Domain-/Passwort-Validierung
- [x] ~~P2: Polling durch SSE ersetzen~~ (2026-03-04) — SSE Endpoint (Firestore onSnapshot), useProductStream.ts, ProductContext mit SSE + Polling-Fallback
- [x] ~~P0: Image-Generator Background Removal~~ (2026-03-04) — Sharp-basiertes BG-Removal + Gradient-Composite als Primärmethode, Gemini als Fallback
- [x] ~~P1: Job-Timeout + Dead-Letter-Queue~~ (2026-03-04) — 5min Timeout, Dead-Letter-Collection, Exponential Backoff, Stale-Job-Erkennung
- [x] ~~P1: Code-Splitting~~ (2026-03-04) — React.lazy() + Suspense für 7 View-Komponenten
- [x] ~~P1: Chat-Qualität verbessern~~ (2026-03-04) — QUALITY RULES, CHAT_STRICT_RULES_ENABLED=ON, Web-Evidence 20KB, LLM Intent-Detection
- [x] ~~P2: Error Boundary~~ (2026-03-04) — ErrorBoundary.tsx mit Reload-Button + Sentry-ready
- [x] ~~P2: State Management~~ (2026-03-04) — ProductContext + useProducts() Hook erstellt (`context/ProductContext.tsx`)
- [x] ~~P0: Listing-Status Realtime-Sync~~ (2026-03-04) — Runner mit Kaufland API, LISTING_SYNC_ENABLED=ON, 10min Intervall
- [x] ~~P0: Schreibpfade auf saveProductV2()~~ (2026-03) — Alle aktiven Pfade migriert
- [x] ~~P0: Pricing Engine produktionsreif~~ (2026-03) — Runner, Neu/Gebraucht-Filter, 3-Tier-Fallback, Frontend
- [x] ~~P0: eBay/Kaufland Update synct Preis~~ (2026-03) — Preis wird jetzt zum Marktplatz gepusht
- [x] ~~P0: Marketplace Listing-Status automatisch~~ (2026-03) — 20min-Intervall Runner
- [x] ~~P0: Konkurrenzpreise-System~~ (2026-03) — BrightData, 7 Marketplaces, 72h-Runner, Frontend
- [x] ~~P0: LLM Titel-Generierung~~ (2026-03) — LLM_POLICY ON, RULEBOOK ON, Few-Shot Top-Titel, Bugfix sampleTitles→titles
- [x] ~~P1: Integration-Tests~~ (2026-03) — 119 Tests, 7 Suiten, require.cache-Patching
- [x] ~~P1: CLAUDE.md aktualisieren~~ (2026-03) — 850→179 Zeilen
- [x] ~~P0-001: Security Headers (Helmet.js)~~ (2026-02)
- [x] ~~P0-002: Rate-Limiting~~ (2026-02) — identify: 30/15min, general: 120/min
- [x] ~~P0-003: .env.local aus Git-Historie~~ (2026-02)
- [x] ~~P0-004: Firestore Normalisierung~~ (2026-02) — products_v2 live, 786 Produkte migriert
- [x] ~~P1-001: Structured Logging (Pino)~~ (2026-02)
- [x] ~~P1-002: Health-Check & Graceful Shutdown~~ (2026-02)
- [x] ~~P1-003: Vitest Infrastruktur~~ (2026-02)
- [x] ~~P1-004: Error Response Standardisierung~~ (2026-02)
- [x] ~~P1-005: Express Router Splitting~~ (2026-02) — 7.571→280 Zeilen
- [x] ~~P1-006: API Versioning~~ (2026-02)
- [x] ~~P2-001: SSE für Job-Status~~ (2026-02)
- [x] ~~P2-002: Pricing Engine~~ (2026-02)
- [x] ~~P2-003: Inventory Forecasting~~ (2026-02)
- [x] ~~P2-004: Webhook-System~~ (2026-02)
- [x] ~~P2-005: Produkt-Deduplizierung~~ (2026-02)
- [x] ~~P3-001: Competitor Intelligence~~ (2026-02)
