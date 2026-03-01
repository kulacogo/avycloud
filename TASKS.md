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
