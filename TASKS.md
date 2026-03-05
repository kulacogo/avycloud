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
  - ✅ Keyboard-Navigation (2026-03-05):
    - [x] AdminTableHeader: tabIndex + Enter/Space onKeyDown für sortierbare Spalten
    - [x] ImageGallery Lightbox: Escape schließt, Pfeiltasten navigieren, role=dialog, aria-modal, Backdrop-Click
    - [x] ScannerOverlay: Escape schließt, role=dialog, aria-modal, aria-label
  - **Offen:** Sidebar Arrow-Key-Navigation, MobileTabBar tablist-Pattern

- [x] **P1: UI/UX — AdminTable aufteilen** — ✅ (2026-03-05)
  - [x] Extrahiert: AdminTableHeader, AdminTableRow, BulkActions, AdminTableFilters → `components/admin-table/`
  - [x] AdminTable.tsx als Container, Sub-Komponenten via `admin-table/index.ts` exportiert

- [ ] **P1: UI Redesign — Soft Slate Dark Theme implementieren** since 2026-03-05
  - Referenz-Prototype: `prototype.html` (14 Seiten, interaktiv, Soft Slate Dark Theme)
  - **Cross-Check Ergebnis (Prototype vs. aktuelle App — 2026-03-05):**
  - **Design Tokens:** `--bg: #1a1d23`, `--sidebar: #15171c`, `--surface: #21242b`, `--elevated: #282c34`, `--border: #2a2d35`, `--accent: #7c75ff`, `--success: #34d399`, `--warning: #fbbf24`, `--danger: #f87171`, `--info: #60a5fa`
  - **Schritt 1 — Design-System (Tailwind Config + CSS-Variablen):** ✅ (2026-03-05)
    - [x] Tailwind `tailwind.config.cjs` mit Soft Slate Token-Palette erweitern (app, txt, accent, success, warning, danger, info)
    - [x] Globale CSS-Variablen in `styles/main.css` definieren (Dark Theme als Default, Light Theme aktualisiert)
    - [x] Inter-Font einbinden (Google Fonts, preconnect)
    - [x] Bestehende Farb-Referenzen (slate-800, sky-600 etc.) auf neue Tokens migriert — alle ~50 Komponentendateien (2026-03-05)
  - **Schritt 2 — Layout-Redesign:** ✅ (2026-03-05)
    - [x] Sidebar (220px, `--sidebar` Hintergrund, grouped sections: Haupt, Katalog, Lager, Marktplatz, Einstellungen) → `components/Sidebar.tsx`
    - [x] Topbar (56px, Sprach-Selector DE/EN/TR, Theme-Toggle, User-Avatar) → `components/Topbar.tsx`
    - [x] App.tsx Layout: Sidebar + Topbar (Desktop), Header + MobileTabBar (Mobile)
    - [x] MobileTabBar auf neue Design-Tokens migriert
    - [x] Responsive Breakpoint 768px (md): Sidebar hidden → Mobile Nav sichtbar
  - **Schritt 3 — Dashboard Redesign:** ✅ (2026-03-05)
    - [x] Revenue & Order KPIs mit Soft Slate Tokens (Umsatz YTD, Monat, Aufträge, Retouren)
    - [x] Order-Pipeline Visualisierung (5 Stufen) mit neuen Token-Farben
    - [x] Inventory KPIs (Im Bestand, Einheiten, Bestandswert, Synchronisierung)
    - [x] Zeitraum-Selector mit Soft Slate Dropdown
    - [x] Umsatz-Chart (Dual-Axis: Auftragsvolumen + Umsatz) mit Accent-Farben
    - [x] Finance-Card (Kontostand, Versandkosten YTD, Versand Zeitraum)
    - [ ] Aktivitäts-Feed (nicht vorhanden — neues Feature)
    - [ ] Marktplatz-Übersicht (nicht vorhanden — neues Feature)
  - **Schritt 4 — Aufträge-Seite (NEU):** ✅ (2026-03-05)
    - [x] Route `#/orders` + `OrdersView.tsx` erstellt (lazy-loaded, code-split 9kB)
    - [x] KPIs: Offene Aufträge, Heute kommissioniert, Verpackt, Ø Bearbeitungszeit
    - [x] Filter-Pills: Alle, Neu, In Bearbeitung, Kommissioniert, Verpackt, Sonstige
    - [x] Order-Tabelle: Auftrag-ID, Kunde, Artikel, Gesamt, Quelle (eBay/Kaufland Badge), Status, Datum
    - [x] Sidebar-Navigation + Permission-Check (orders:read/pick/pack)
    - [x] i18n: DE/EN/TR Übersetzungen
    - [x] Sync-Button (BaseLinker Auftragssync)
    - [x] Sortierbar nach Datum, Betrag, Status
    - [x] **Backend:** GET `/api/orders` bereits vorhanden (routes/orders.js)
  - **Schritt 5 — eBay Listings-Seite Redesign:** ✅ (2026-03-05)
    - [x] EbayListingsView mit neuem Theme restylen (95 Farb-Referenzen migriert)
    - [ ] Tab-Bar: Listings, Gaps, Kategorien, Sync (neues Feature)
    - [ ] KPIs: Aktive Listings, Gaps, Umsatz 30d, Sync-Status (neues Feature)
    - [x] Sync-Button prominent platziert
  - **Schritt 6 — Produkte/AdminTable Redesign:** Color-Migration ✅ (2026-03-05)
    - [x] Tabellenansicht mit Soft Slate Styles (79 Refs AdminTable + Sub-Komponenten migriert)
    - [x] Bulk-Action-Bar redesignen — Farb-Tokens migriert (BulkActions.tsx)
    - [x] Filter-System visuell angepasst (AdminTableFilters.tsx)
    - [x] Checkbox-Selection restyled (AdminTableRow.tsx, AdminTableHeader.tsx)
  - **Schritt 7 — Produkt-Detail Panel Redesign:** Color-Migration ✅ (2026-03-05)
    - [x] Slide-in Panel mit neuem Theme (136 Farb-Referenzen migriert)
    - [x] Tab-Bar, Übersicht, Bilder, Preise, Attribute, eBay — alle Soft Slate Tokens
    - [ ] Bilder: KI-Hintergrund-Entfernung, Rotation (neues Feature)
    - [ ] Preise: Competitor-Tabelle Integration (neues Feature)
  - **Schritt 8 — Lagerverwaltung Redesign:** Color-Migration ✅ (2026-03-05)
    - [x] WarehouseView mit Soft Slate Tokens migriert (46 Farb-Referenzen)
    - [x] Zone-Chips, Bin-Grid, Bin-Detail Card — alle Farb-Tokens
  - **Schritt 9 — Kategorien Redesign:** Color-Migration ✅ (2026-03-05)
    - [x] CategoryManagement mit Soft Slate Tokens migriert (28 Farb-Referenzen)
    - [x] Profil-Editor (Kanonische Attribute, Aliase, Notizen) — Farben migriert
  - **Schritt 10 — Admin-Bereich Redesign:** Color-Migration ✅ (2026-03-05)
    - [x] Alle 11 Admin-Dateien migriert (325 Farb-Referenzen gesamt)
    - [x] AdminPanel, AdminBulkActions, AdminEbayTaxonomy, AdminGroupManagement
    - [x] AdminIntegrations, AdminJobsManagement, AdminLlmManagement
    - [x] AdminProductCoverageDashboard, AdminRoleManagement, AdminRulebookManagement, AdminUserManagement
  - **Schritt 11 — Mobile UI (Responsive):** teilweise vorhanden
    - [x] Dashboard Mobile: KPI-Tiles existieren (DashboardMobile.tsx, Soft Slate Tokens migriert)
    - [x] Mobile Suche: MobileSearchView.tsx mit Produkt-Suche (Soft Slate Tokens migriert)
    - [x] Aktionen: MobileOperationsView.tsx mit Identify/Stow/Pick/Pack (Soft Slate Tokens migriert)
    - [x] MobileTabBar: Responsive Navigation (Soft Slate Tokens migriert)
    - [ ] Einlagern-Flow: Scan → Produkt erkennen → Bin wählen → Menge → Bestätigen (verbesserungsfähig)
    - [ ] Verpacken-Flow: Auftrag → Verpackung wählen → Label drucken (neues Feature)
    - [ ] Touch-Targets: Audit min 44px auf allen Buttons/Inputs
  - **Schritt 12 — Globale UI-Elemente:** teilweise ✅ (2026-03-05)
    - [x] Job-Status-Dock (StatusDock.tsx, fixed bottom-right): Aktive Identify + Improve Jobs
    - [x] JobStatusPopup mit Cancel/Dismiss
    - [ ] Notification-Bell mit Badge (neues Feature — benötigt Backend-Notification-System)
    - [x] Theme-Toggle (Dark/Light) in Topbar
    - [x] Sprach-Umschaltung (DE/EN/TR) in Topbar
  - **Dateien Referenz:** `prototype.html` (interaktiver Mockup mit allen 14 Seiten)

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
