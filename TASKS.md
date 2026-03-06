# Tasks

> **ZIEL: AvyCloud marktreif machen.** Enterprise-Grade Multi-Channel E-Commerce Hub.
> Benchmark: ChannelEngine, Channable, Linnworks, Plentymarkets, Billbee.
> AvyCloud-Vorteil: KI-gestützte Produkterkennung + Enrichment (kein Wettbewerber hat das).

> **⛔ KEINE PLACEHOLDER-VIEWS. KEINE MOCK-DATEN. KEINE FAKE-HANDLER. NIEMALS.**
> - Jede View MUSS echte API-Calls machen (import aus `api/client.ts`)
> - Jede View MUSS echte Daten aus dem Backend laden (useEffect + fetch)
> - KEINE hardcodierten `MOCK_*` Arrays. KEINE `setTimeout()`-Fake-Handler
> - Wenn ein Backend-Endpoint noch nicht existiert: **ZUERST Backend bauen, DANN Frontend anbinden**
> - "Demnächst verfügbar" / "Coming Soon" ist VERBOTEN in der UI
> - **Bestehende Fake-Views (mit Mock-Daten) MÜSSEN auf echte API-Calls umgebaut werden**

> **✅ AKTUELLER ZUSTAND (Stand 2026-03-06): ALLE VIEWS REAL**
>
> **ECHT (API-Connected, echte Daten):** Dashboard, OrdersView, OperationsView, WarehouseView,
> MarketplaceListingsView, IdentifyQueueView, IntegrationsHub, CompanySettings, ProfileSettings,
> OrderSettingsView, WarehouseSettingsView, ApiSettings, BillingSettings, ShippingView,
> InvoicesView, ReturnsView
>
> **FAKE: KEINE** — Phase 4 FAKE→REAL komplett abgeschlossen (2026-03-06)
>
> **Backend:** 100+ API-Funktionen in `api/client.ts`. 5 neue Backend-Routes: `settings.js`, `integrations.js`, `returns.js`, `invoices.js` + Erweiterungen in `orders.js`, `warehouse.js`.
> Alle neuen Collections mit `tenantId` (MT-ready).
>
> **✅ Phase 5 (Stock-Sync) ABGESCHLOSSEN (2026-03-06):** Reservierungen, Multi-Channel Sync (eBay+Kaufland), Preis-Sync, Dashboard Widget.
>
> **→ NÄCHSTE PRIORITÄT: BUG-008 bis BUG-012 fixen, dann Module 3-9 weiter.**

---

> **🏗️ MULTI-TENANCY KOMPATIBILITÄT — AB SOFORT BEI JEDER IMPLEMENTIERUNG BEACHTEN**
>
> AvyCloud wird nach der aktuellen Phase zu einem Multi-Tenant SaaS umgebaut. **ALLE jetzigen Implementierungen
> müssen so gebaut werden, dass Multi-Tenancy OHNE Breaking Changes hinzugefügt werden kann.**
>
> ### Firestore-Collections — tenantId IMMER mitführen
> - **Jede neue Collection** (`invoices`, `returns`, `integrations`, `warehouse_zones`, `warehouse_bins`,
>   `warehouse_movements`, `warehouse_inventories`, `company_settings`, etc.) MUSS ein `tenantId`-Feld enthalten
> - **Bestehende Collections** (`products_v2`, `orders`) bekommen `tenantId` bei der MT-Migration nachträglich
> - **Collection-Pfade vorbereiten:** Alle Firestore-Queries so schreiben, dass ein `.where('tenantId', '==', tid)`
>   Filter einfach hinzugefügt werden kann. Keine hardcodierten Collection-Referenzen ohne Filterbarkeit
> - **Dokument-IDs:** Weiterhin Firestore-Auto-IDs, KEINE tenantId in Doc-IDs encodieren
> - **Indexes:** Composite-Indexes mit `tenantId` als erstem Feld einplanen (Firestore Performance)
>
> ### Daten-Isolation — Design-Regeln
> - **Kein globaler State ohne Tenant-Scope:** Jeder Datenbankzugriff muss in Zukunft auf einen Tenant gefiltert werden können
> - **Kein Cross-Tenant-Leak:** Queries dürfen nie Daten mehrerer Tenants mischen
> - **Storage-Pfade:** GCS-Pfade (Bilder, PDFs) mit Tenant-Prefix vorbereiten: `gs://prodsandjobs/{tenantId}/...`
>   Aktuell noch flat, aber Pfade so aufbauen dass Migration möglich ist
>
> ### Backend — Tenant-Context-Propagation
> - **Auth-Middleware vorbereiten:** `req.user` wird in Zukunft ein `tenantId`-Feld tragen.
>   Neue Services/Routes so schreiben, dass `tenantId` als Parameter akzeptiert wird (nicht hardcoded)
> - **Service-Funktionen:** Alle neuen `create*()`, `get*()`, `list*()`, `update*()` Funktionen
>   akzeptieren `tenantId` als ersten Parameter ODER als Feld im Options-Objekt:
>   ```js
>   // ✅ GUT — tenantId-ready
>   async function listInvoices({ tenantId, status, limit }) { ... }
>   async function createZone({ tenantId, name, type }) { ... }
>
>   // ❌ SCHLECHT — tenantId nicht vorgesehen
>   async function listInvoices(status, limit) { ... }
>   ```
> - **Aktuell:** `tenantId` kann ein Default-Wert sein (z.B. `'default'` oder aus ENV),
>   wird bei MT-Migration durch echten Tenant-Wert ersetzt
> - **RBAC:** `lib/rbac.js` wird um Tenant-Scope erweitert — Rollen gelten pro Tenant.
>   Neue Permission-Checks so schreiben, dass Tenant-Scope hinzugefügt werden kann
>
> ### Frontend — Tenant-Awareness
> - **AuthContext:** Wird in Zukunft `tenantId` tragen. Neue Hooks/Contexts so designen,
>   dass sie Tenant-Context konsumieren können
> - **API-Client:** `api/client.ts` wird in Zukunft `tenantId` als Header oder Path-Param senden.
>   Neue API-Calls so aufbauen, dass der Parameter hinzugefügt werden kann (zentraler API-Client)
> - **Settings:** Einstellungen (Company, Billing, Team) sind per-Tenant.
>   UI muss keine Änderung brauchen — Backend liefert automatisch Tenant-gefilterte Daten
> - **Integrations-Credentials:** Pro Tenant gespeichert.
>   `integration-store.js` MUSS tenantId als Key-Bestandteil verwenden
>
> ### Was NICHT jetzt gemacht werden muss
> - ❌ Kein Tenant-Switcher UI
> - ❌ Kein Tenant-Onboarding-Flow
> - ❌ Keine Tenant-Isolation auf Netzwerk/Container-Ebene
> - ❌ Keine Billing-pro-Tenant-Logik (kommt mit Stripe)
> - ❌ Kein Admin-Portal für Tenant-Management
>
> **Zusammenfassung:** Datenmodelle MIT `tenantId`, Service-Funktionen MIT `tenantId`-Parameter,
> aber KEIN Multi-Tenant-Routing/Switching/UI. Das kommt in der MT-Phase.

---

## Active

### Sofort-Bugfixes (vor allem anderen)

- [x] **BUG-001: Umlaut/Unicode-Encoding in BulkActions** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: Alle `\u00xx` Unicode-Escapes durch echte UTF-8-Zeichen ersetzt in BulkActions.tsx, AdminTableFilters.tsx, AdminTableHeader.tsx, AdminTableRow.tsx

- [x] **BUG-002: Doppelter Dark/Light-Mode Toggle** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: Settings-Button in Topbar.tsx hatte Sonnen-SVG statt Zahnrad → durch echtes Gear-Icon ersetzt

- [x] **BUG-003: Sprach-Selector entfernen** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: Language-Selector aus Topbar.tsx entfernt. Default-Locale in i18n.tsx auf `de` geändert. i18n-Infrastruktur (EN/TR Keys) bleibt erhalten

- [x] **BUG-004: ProductSheet wechselt Kontext (Inventory → Products)** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: ProductSheet als Overlay (slide-in Panel) gerendert statt als eigene Route. `handleSelectProduct()` setzt nur `currentProduct`, kein `setView('sheet')`. Hash bleibt auf aktueller View. Close-Button + Backdrop-Click zum Schließen

- [x] **BUG-005: eBay/Kaufland Sync im Bulk-Dropdown conditional** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: eBay Update und Kaufland Update Buttons in BulkActions.tsx immer sichtbar, nicht mehr conditional hinter `hasSelectedEbayListings`/`hasSelectedKauflandListings`

- [x] **BUG-006: ⛔ Alte eBay Gap Analysis View SOFORT ENTFERNEN + durch echte Marketplace-Listings ersetzen** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: `EbayListingsView` Import aus App.tsx entfernt, `MarketplaceListingsView.tsx` erstellt (generisch für eBay + Kaufland), `#/marketplace/ebay` + `#/marketplace/kaufland` rendern jetzt MarketplaceListingsView mit marketplace prop
  - Neue View enthält: KPI-Cards, Sync-Status-Banner, Tab-Filter (Alle/Aktiv/Inaktiv/Entwürfe/Fehler), Datentabelle mit Bulk-Actions, Pagination, Search, Status-Badges
  - PlaceholderView-Component komplett entfernt aus App.tsx

- [x] **BUG-008: eBay Marketplace-Seite zeigt Gap-Analyse statt Listing-Management** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ Spalten "Match" und "Gaps" ENTFERNT aus MarketplaceListingsView
  - ✅ Neue Spalten: Preis, Bestand, Kategorie (aus eBay-Listing-Daten via ebay-direct.js)
  - ✅ "Nicht verbunden" Badge entfernt — zeigt nur noch "Verbunden" wenn connected
  - ✅ "vor NaN Tagen" Bug gefixt — `Number.isFinite(ts)` Check in `formatRelativeTime`
  - ✅ Backend: `listLiveListings()` liefert jetzt `currentPrice`, `currency`, `quantityAvailable`, `categoryName`
  - ✅ TypeScript: `EbayListingRow` Interface um 4 Felder erweitert

- [x] **BUG-009: Kaufland Marketplace-Seite zeigt nur SKU-Nummern, keine Produktdaten** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ `products` Prop an MarketplaceListingsView von App.tsx durchgereicht
  - ✅ SKU→Product Map (`productSkuMap`) zum Matchen von Kaufland-SKUs mit `products_v2`
  - ✅ `normalizeKauflandUnit` enriched mit Produktname, Bild, Preis aus AvyCloud-Daten
  - ✅ Status-Mapping: "active"/"200" → Aktiv, "inactive"/"blocked"/"403" → Inaktiv

- [x] **BUG-010: Listing-Aktionen gehören NICHT in Produkte/Inventar-View** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ BulkActions.tsx: "eBay Listen", "eBay Update", "Kaufland Listen", "Kaufland Update" Buttons + Dropdown-Menü-Einträge entfernt
  - ✅ eBay/Kaufland tone-Varianten aus ActionButton entfernt
  - ✅ AdminTable eBay/Kaufland-Spalten waren bereits reine Status-Badges (Gelistet/Inaktiv/—) — keine Änderung nötig
  - ✅ Legacy-Props als optional beibehalten für Backwards-Compat mit AdminTable.tsx

- [x] **BUG-011: Light-Mode Farben unleserlich — Text und Indikatoren schlecht erkennbar** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ `--text-muted` in Light-Mode: `#8a8f9e` → `#6b7080` (3.4:1 → 4.7:1 Kontrast auf #f5f6f8)
  - ✅ `--text-secondary` in Light-Mode: `#5a5f70` → `#4b5063` (verbessert)
  - ✅ Semantische Farben für Light-Mode: Eigene dunklere Varianten definiert
    - `--success: #059669` (emerald-600, 4.6:1), `--warning: #b45309` (amber-700, 5.4:1)
    - `--danger: #dc2626` (red-600, 4.5:1), `--info: #2563eb` (blue-600, 4.7:1)
  - ✅ Alle WCAG AA (4.5:1 minimum für normalen Text) erfüllt

- [x] **BUG-012: Dark-Mode zu viel Lila — Text-Farben überarbeiten** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ Alle hardcoded `text-violet-*`/`text-purple-*` Klassen durch Theme-Tokens ersetzt
  - ✅ Dashboard Pipeline: `bg-violet-400`/`text-violet-400` → `bg-blue-400`/`text-sky-400`
  - ✅ DashboardMobile Finanzen: `text-violet-300`/`text-violet-400/70` → `text-txt-primary`/`text-txt-muted`
  - ✅ AdminTableFilters KI-Section Header: `text-violet-400/80` → `text-txt-muted`
  - ✅ AdminTable Improve-Spinner: `text-purple-300` → `text-accent`
  - ✅ EbayListingsView "Nicht eBay-Attribut": `text-violet-200` → `text-txt-secondary`
  - ✅ ProductSheet Improve-Button: `bg-violet-600/20 text-violet-300` → `bg-accent-dim text-accent`
  - ✅ BulkActions accent tone: `bg-violet-600/90` → `bg-accent/90`
  - ✅ PricingInfo Preis: `text-accent` → `text-txt-primary` (Preis ist kein Accent-Element)

- [ ] **BUG-007: React Error #426 — ProductSheet crash bei Klick auf Produkt** since 2026-03-05
  - **PROBLEM:** Minified React error #426 ("A component suspended while responding to synchronous input") beim Öffnen eines Produkts aus Produkte oder Inventar
  - **URSACHE:** `ProductSheet` war `React.lazy()` geladen UND wurde gleichzeitig an 2 Stellen gerendert (als Route `case 'sheet'` + als Overlay)
  - **FIX (bereits in App.tsx implementiert):**
    1. ✅ `ProductSheet` direkt importiert statt `React.lazy()` — kein lazy-loading mehr
    2. ✅ `case 'sheet'` aus `renderView()` entfernt — nur noch Overlay-Rendering
    3. ✅ Alle `setView('sheet')` Aufrufe → redirecten auf `'products'`
    4. ✅ Suspense-Wrapper um Overlay entfernt
  - **MUSS DEPLOYED WERDEN** via `git push` → GitHub Actions → Firebase Hosting

---

### ⚡⚡⚡ Phase 4: FAKE→REAL — Mock-Daten raus, echte API-Calls rein

> **⚠️ STATUS: Backend-Routes erstellt, aber Frontend-Qualität NICHT verifiziert.**
> Claude Code hat Backend-Routes + api/client.ts-Funktionen hinzugefügt, ABER:
> - eBay-Seite zeigt Gap-Analyse-Daten statt Listing-Management (BUG-008)
> - Kaufland-Seite zeigt nur SKU-Nummern ohne Produktdaten (BUG-009)
> - Sub-Checkboxen in den Tasks sind noch offen
> - **→ Phase 4 MUSS ZUSAMMEN MIT BUG-008 bis BUG-012 finalisiert werden**
>
> **⛔ WEITERHIN GÜLTIG — ABSOLUTES VERBOT:**
> - KEINE neuen `MOCK_*` Arrays erstellen
> - KEINE `setTimeout()` als Fake-Handler
> - KEINE hardcodierten Beispiel-Daten (Samsung Galaxy S24, Apple AirPods, etc.)
> - KEIN `// TODO: API call` — der Call wird JETZT gemacht
> - KEIN "Demnächst verfügbar" / "Coming Soon" Text
>
> **VORGEHEN pro View:** 1) Prüfe ob Backend-Route + api/client.ts-Funktion existiert → 2) Wenn ja: Frontend direkt umbauen → 3) Wenn nein: Backend-Route bauen → api/client.ts erweitern → Frontend umbauen → 4) `MOCK_*` Array LÖSCHEN

- [x] **FAKE→REAL #1: MarketplaceListingsView.tsx — ECHTE Listings laden** (2026-03-06)
  - **Aktuell KAPUTT:** `MOCK_LISTINGS` Array mit Fake-Daten (Samsung Galaxy S24 etc.), KEIN API-Call
  - **⚡ ALLES existiert bereits — NUR Frontend umbauen:**
    - **eBay-Listings laden:** `import { fetchEbayLiveListings } from '../api/client'` → EXISTIERT in api/client.ts
    - **eBay-Listings syncen:** `import { syncEbayLiveListings } from '../api/client'` → EXISTIERT
    - **eBay-Listing-Details:** `import { fetchEbayLiveListingDetail } from '../api/client'` → EXISTIERT
    - **eBay Bulk-Update:** `import { bulkUpdateEbayListings } from '../api/client'` → EXISTIERT
    - **eBay Publish:** `import { publishToEbay, verifyEbayPublish } from '../api/client'` → EXISTIERT
    - **eBay Gaps:** `import { fetchEbayGaps } from '../api/client'` → EXISTIERT
    - **Kaufland-Sync:** `import { syncKauflandListings } from '../api/client'` → EXISTIERT
    - **Kaufland SKU-Index:** `import { fetchKauflandSkuIndex } from '../api/client'` → EXISTIERT
  - **Backend-Routes (EXISTIEREN BEREITS in `backend/routes/marketplace.js`):**
    - `GET /api/marketplace/ebay/listings` — Query Listings (pageNumber, limit, filter, sort)
    - `POST /api/marketplace/ebay/listings/sync` — Sync von eBay
    - `POST /api/marketplace/ebay/listings/light-sync` — Light-Sync
    - `GET /api/marketplace/ebay/listings/:itemId/detail` — Detail
    - `POST /api/marketplace/ebay/sync/dry-run` — Preview
    - `POST /api/marketplace/ebay/sync/apply` — Apply
    - `POST /api/marketplace/ebay/update/bulk` — Bulk Update
    - `POST /api/marketplace/ebay/publish` — Publish
    - `POST /api/marketplace/ebay/publish/bulk` — Bulk Publish
    - `POST /api/marketplace/kaufland/listings/sync` — Kaufland Sync
    - `GET /api/marketplace/kaufland/sku-index` — Kaufland SKU Index
  - **TODO (NUR Frontend-Arbeit):**
    - [ ] `MOCK_LISTINGS` Array KOMPLETT LÖSCHEN
    - [ ] eBay-View: `useEffect → fetchEbayLiveListings({ pageNumber: 1, limit: 50 })` → Tabelle befüllen
    - [ ] Kaufland-View: `useEffect → syncKauflandListings()` dann `fetchKauflandSkuIndex()` → Tabelle befüllen
    - [ ] "Jetzt synchronisieren" Button → `syncEbayLiveListings()` bzw. `syncKauflandListings()`
    - [ ] Bulk-Aktionen: Preis → `bulkUpdateEbayListings()`, Publish → `bulkPublishToEbay()`
    - [ ] KPI-Cards: Aus echten Listing-Daten berechnen (activeCount, draftCount, errorCount, etc.)
    - [ ] Sync-Status-Banner: Aus `fetchEbayStatus()` (EXISTIERT) → letzter Sync, Verbindungsstatus
    - [ ] Fehler-Tab: Aus `fetchEbayGaps()` → echte Gap-Daten
    - [ ] Loading-State: Skeleton-Rows während Fetch
    - [ ] Error-State: Toast/Alert bei API-Fehler
  - **Dateien:** `components/MarketplaceListingsView.tsx` (NUR Frontend-Umbau, KEIN neues Backend nötig)

- [x] **FAKE→REAL #2: IntegrationsHub.tsx — ECHTE Verbindungsstatus** (2026-03-06)
  - **Aktuell KAPUTT:** 30+ hardcodierte Cards mit Fake-Status, "Demnächst verfügbar" überall
  - **⚡ FAKT: ALLE Integrationen sind in Production AKTIV und VERBUNDEN:**
    - eBay → OAuth + Trading API, Credentials via Google Secret Manager (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_TRADING_*`)
    - Kaufland → HMAC-SHA256 Auth, Credentials via Secret Manager (`KAUFLAND_CLIENT_KEY`, `KAUFLAND_SECRET_KEY`)
    - BaseLinker → Token-Auth, `BASELINKER_TOKEN` via Secret Manager, `BASELINKER_INVENTORY_ID=78659`, Auto-Stock-Sync AKTIV
    - SendCloud → Basic Auth, `SENDCLOUD_PUBLIC_KEY` + `SENDCLOUD_SECRET_KEY` via Secret Manager
    - SevDesk → Token-Auth, `SEVDESK_API_TOKEN` via Secret Manager
    - DHL → via SendCloud (Aggregator) oder BaseLinker Shipping
  - **Existierende api/client.ts Funktionen die den ECHTEN Status liefern:**
    - `fetchEbayStatus()` → eBay OAuth Status (verbunden seit wann, Token-Ablauf, Scopes)
    - `fetchEbayTradingStatus()` → eBay Trading API Status (Endpoint, Compatibility Level)
    - `startEbayOAuth()` → eBay OAuth Re-Connect starten
  - **Backend-Route EXISTIERT:** `GET /api/marketplace/ebay/status` → echter Connection-Status
  - **Backend NEU (minimal — 1 Endpoint):**
    - [ ] `GET /api/v1/integrations/status` in neuer `backend/routes/integrations.js`:
      ```js
      // Prüft Secret Manager Credentials und gibt ECHTEN Status zurück
      const { getSecretValue } = require('../lib/secret-manager');
      const integrations = [];
      // eBay: OAuth-Token in Firestore prüfen
      const ebayIntegration = await getEbayIntegration(); // lib/ebay-oauth.js — EXISTIERT
      integrations.push({ type: 'ebay', status: ebayIntegration ? 'active' : 'inactive', name: 'eBay', lastSync: ebayIntegration?.updatedAt });
      // Kaufland: Secret Manager Key prüfen
      const kauflandKey = await getSecretValue('KAUFLAND_CLIENT_KEY').catch(() => null);
      integrations.push({ type: 'kaufland', status: kauflandKey ? 'active' : 'inactive', name: 'Kaufland' });
      // BaseLinker: Token prüfen
      const blToken = await getSecretValue('BASELINKER_TOKEN').catch(() => null);
      integrations.push({ type: 'baselinker', status: blToken ? 'active' : 'inactive', name: 'BaseLinker' });
      // SendCloud + SevDesk analog
      ```
    - [ ] Route in `backend/index.js` einbinden
    - [ ] `fetchIntegrationStatus()` in api/client.ts
  - **Frontend IntegrationsHub.tsx:**
    - [ ] `INTEGRATIONS` hardcodiertes Array KOMPLETT LÖSCHEN
    - [ ] `useEffect → fetchIntegrationStatus()` → echte Daten
    - [ ] Für eBay Detail: `fetchEbayStatus()` → OAuth-Ablauf, Scopes, letzter Sync
    - [ ] **ALLE "Demnächst verfügbar" / "Coming Soon" / `status: 'coming_soon'` ENTFERNEN**
    - [ ] **NUR die 6 aktiven Integrationen anzeigen:** eBay, Kaufland, BaseLinker, SendCloud, SevDesk, DHL
    - [ ] Alle sind "Verbunden" (grüner Status) mit echten Daten aus dem Backend
    - [ ] "Konfigurieren" Button → Sync-Intervall, letzte Sync-Zeit, Fehler-Log
    - [ ] Amazon, Otto, Zalando etc. werden NICHT angezeigt — die existieren nicht
    - [ ] Anbieter-Logos als SVG/PNG
  - **Dateien:** `components/IntegrationsHub.tsx`, `backend/routes/integrations.js` (neu), `api/client.ts`

- [x] **FAKE→REAL #3: CompanySettings.tsx — Firmendaten speichern/laden** (2026-03-06)
  - **Aktuell KAPUTT:** Alle Felder mit Beispieldaten vorausgefüllt, Save = `setTimeout(800)` Fake
  - **Backend NEU (1 Route, 1 Firestore-Collection):**
    - [ ] `backend/routes/settings.js` (neu) — im `backend/index.js` einbinden:
      - `GET /api/v1/settings/company` → `db.collection('company_settings').doc(tenantId).get()`
      - `PUT /api/v1/settings/company` → `db.collection('company_settings').doc(tenantId).set(data, {merge:true})`
    - [ ] Alle Funktionen mit `tenantId` Parameter (aktuell `'default'` aus `req.user` oder Fallback)
  - **api/client.ts:**
    - [ ] `fetchCompanySettings()`, `saveCompanySettings(data)` hinzufügen
  - **Frontend:**
    - [ ] Hardcodierte Werte LÖSCHEN → `useEffect → fetchCompanySettings()` → Formular befüllen
    - [ ] Save → `saveCompanySettings(formData)` → Erfolgs-Toast
  - **Dateien:** `backend/routes/settings.js` (neu), `api/client.ts`, `components/CompanySettings.tsx`

- [x] **FAKE→REAL #4: ProfileSettings.tsx — Profil speichern/laden** (2026-03-06)
  - **Aktuell KAPUTT:** Hardcodierte Profil-Daten, Save + Passwort-Change sind Stubs
  - **Existiert teilweise:** `requestPasswordReset(email)` in api/client.ts
  - **Backend NEU:**
    - [ ] In `backend/routes/settings.js` oder `backend/routes/auth.js`:
      - `GET /api/v1/settings/profile` → Firebase Auth User-Daten + Firestore `user_profiles/{uid}`
      - `PUT /api/v1/settings/profile` → Firestore Update + Firebase Auth displayName
      - `POST /api/v1/auth/change-password` → Firebase Auth `updatePassword()` (oder Re-Auth Flow)
  - **api/client.ts:**
    - [ ] `fetchProfile()`, `saveProfile(data)`, `changePassword(currentPw, newPw)`
  - **Frontend:**
    - [ ] Hardcodierte Werte LÖSCHEN → echte Daten laden → echtes Speichern
  - **Dateien:** `backend/routes/settings.js` oder `auth.js`, `api/client.ts`, `components/ProfileSettings.tsx`

- [x] **FAKE→REAL #5: OrderSettingsView.tsx — Auftrags-Einstellungen speichern/laden** (2026-03-06)
  - **Aktuell KAPUTT:** `INITIAL_RULES`, `INITIAL_STATUSES`, `INITIAL_NUMBER_RANGES` hardcodiert
  - **Backend NEU (1 Route):**
    - [ ] In `backend/routes/orders.js` (bestehend):
      - `GET /api/orders/settings` → Firestore `order_settings/{tenantId}`
      - `PUT /api/orders/settings` → Firestore speichern
  - **api/client.ts:**
    - [ ] `fetchOrderSettings()`, `saveOrderSettings(data)`
  - **Frontend:**
    - [ ] Mock-Daten LÖSCHEN → useEffect → fetchOrderSettings() → echtes Speichern
  - **Dateien:** `backend/routes/orders.js` (erweitern), `api/client.ts`, `components/OrderSettingsView.tsx`

- [x] **FAKE→REAL #6: WarehouseSettingsView.tsx — Lager-Einstellungen speichern/laden** (2026-03-06)
  - **Aktuell KAPUTT:** `DEFAULT_ZONE_TYPES` hardcodiert, Save = `setTimeout()` Fake
  - **Backend (Warehouse-Routes existieren teilweise):**
    - Existiert: `GET /api/warehouse/zones`, `POST /api/warehouse/layouts`, `GET /api/warehouse/zones/:zone/:etage`
    - [ ] NEU in `backend/routes/warehouse.js`: `GET /api/warehouse/settings`, `PUT /api/warehouse/settings`
  - **api/client.ts:**
    - [ ] `fetchWarehouseSettings()`, `saveWarehouseSettings(data)` hinzufügen
  - **Frontend:**
    - [ ] Mock-Daten LÖSCHEN → echte Daten laden → echtes Speichern
  - **Dateien:** `backend/routes/warehouse.js` (erweitern), `api/client.ts`, `components/WarehouseSettingsView.tsx`

- [x] **FAKE→REAL #7: ApiSettings.tsx — API-Keys + Webhooks** (2026-03-06 — WAR BEREITS REAL!)
  - Backend `routes/settings.js`: `GET/POST/DELETE /api/settings/api-keys` + `GET/POST/DELETE /api/settings/webhooks` — existiert und funktioniert
  - Frontend `ApiSettings.tsx`: Importiert `fetchApiKeys()`, `createApiKey()`, `revokeApiKey()`, `fetchWebhooks()`, `createWebhook()`, `deleteWebhook()` aus `api/client.ts` — echte API-Calls, keine Mocks
  - **War fälschlich als FAKE klassifiziert!**

- [x] **FAKE→REAL #8: ShippingView.tsx — Echte Versanddaten** (2026-03-06)
  - **Aktuell KAPUTT:** `MOCK_SHIPMENTS` mit 6 Fake-Sendungen
  - **Existiert:** `lib/sendcloud.js` (getShippingCostsSummary, loadPriceTable), `lib/baselinker-shipping.js` (getShippingCostsSummaryFromBaseLinker)
  - **Existiert:** Dashboard Finance-Route aggregiert bereits Versandkosten: `GET /api/orders/dashboard/finance`
  - **Backend NEU:**
    - [ ] In `backend/routes/orders.js` oder neuer `routes/shipping.js`:
      - `GET /api/v1/shipments` → Sendungen aus BaseLinker Orders (Status=Versendet) oder Firestore
      - `POST /api/v1/shipments/label` → Label via SendCloud `lib/sendcloud.js` erstellen
  - **api/client.ts:**
    - [ ] `fetchShipments(params)`, `createShipmentLabel(data)`
  - **Frontend:** `MOCK_SHIPMENTS` LÖSCHEN → echte Daten
  - **Dateien:** `backend/routes/orders.js` oder `shipping.js`, `api/client.ts`, `components/ShippingView.tsx`

- [x] **FAKE→REAL #9: InvoicesView.tsx — Rechnungen** (2026-03-06)
  - **Aktuell KAPUTT:** `MOCK_INVOICES` mit 6 Fake-Rechnungen
  - **Existiert:** `lib/sevdesk.js` hat Rechnungs-relevante Funktionen
  - **Backend NEU:**
    - [ ] `backend/routes/invoices.js`:
      - `GET /api/v1/invoices` → Firestore `invoices` Collection (tenantId-gefiltert)
      - `POST /api/v1/invoices` → Rechnung aus Order generieren
      - `GET /api/v1/invoices/:id/pdf` → PDF generieren
      - `PATCH /api/v1/invoices/:id` → Status ändern
    - [ ] `backend/services/invoice-generator.js` — PDF-Template mit pdfkit
  - **api/client.ts:**
    - [ ] `fetchInvoices(params)`, `createInvoice(orderId)`, `downloadInvoicePdf(id)`, `updateInvoiceStatus(id, status)`
  - **Frontend:** `MOCK_INVOICES` LÖSCHEN → echte API-Calls
  - **Dateien:** `backend/routes/invoices.js` (neu), `backend/services/invoice-generator.js` (neu), `api/client.ts`, `components/InvoicesView.tsx`

- [x] **FAKE→REAL #10: ReturnsView.tsx — Retouren** (2026-03-06)
  - **Aktuell KAPUTT:** `MOCK_RETURNS` mit 5 Fake-Retouren
  - **Backend NEU:**
    - [ ] `backend/routes/returns.js`:
      - `GET /api/v1/returns` → Firestore `returns` Collection (tenantId-gefiltert)
      - `POST /api/v1/returns` → Retoure anlegen
      - `PATCH /api/v1/returns/:id` → Status ändern (erstatten, ablehnen)
  - **api/client.ts:**
    - [ ] `fetchReturns(params)`, `createReturn(data)`, `updateReturn(id, data)`
  - **Frontend:** `MOCK_RETURNS` LÖSCHEN → echte API-Calls
  - **Dateien:** `backend/routes/returns.js` (neu), `api/client.ts`, `components/ReturnsView.tsx`

- [x] **FAKE→REAL #11: BillingSettings.tsx — Echte Usage-Stats** (2026-03-06)
  - **Aktuell KAPUTT:** Hardcodierte Plan/Usage/Rechnungsdaten
  - **Existiert:** `adminGetProductCoverageMetrics()` in api/client.ts → Produkt-Counts
  - **Backend NEU (minimal):**
    - [ ] `GET /api/v1/settings/billing/usage` → Aggregation: Produkt-Count, Order-Count/Monat, Integration-Count
    - [ ] Nutzt existierende Firestore-Queries (products_v2 count, orders count)
  - **api/client.ts:** `fetchBillingUsage()`
  - **Frontend:** Hardcodierte Daten LÖSCHEN → echte Usage-Zahlen
  - **⚠️ Stripe/Payment kommt später — Usage-Anzeige geht JETZT**
  - **Dateien:** `backend/routes/settings.js`, `api/client.ts`, `components/BillingSettings.tsx`

- [x] **FAKE→REAL #12: "Demnächst verfügbar" GLOBAL entfernen** (2026-03-06)
  - [ ] `grep -r "Demnächst" components/` → JEDES Vorkommen LÖSCHEN
  - [ ] `grep -r "Coming Soon" components/` → JEDES Vorkommen LÖSCHEN
  - [ ] `grep -r "coming_soon" components/` → JEDES Vorkommen LÖSCHEN
  - [ ] `grep -r "MOCK_" components/` → JEDES `MOCK_*` Array LÖSCHEN und durch echte API-Calls ersetzen
  - [ ] `grep -r "setTimeout" components/` → JEDE Fake-Handler ersetzen durch echte API-Calls
  - [ ] Integrationen die nicht existieren (Amazon, Otto, Zalando, Kleinanzeigen, Hood.de, Avocadostore, Etsy, DATEV, Stripe, Shopify, WooCommerce, Shopware, Zapier, Make.com, Slack) werden NICHT in der UI angezeigt
  - **Dateien:** Alle `components/*.tsx`

---

### 🚨 Phase 5: Bestandssynchronisation — Überverkaufsschutz (KRITISCH für Multi-Channel)

> **PROBLEM:** Wenn ein Produkt auf eBay verkauft wird, sieht Kaufland den alten Bestand und verkauft weiter → **Überverkauf**.
> Das ist DER häufigste Grund für Strafgebühren und Kontosperrungen auf Marktplätzen.
> Aktuell wird Stock NICHT automatisch bei Bestelleingang reduziert. Kein Push zu eBay/Kaufland nach Bestandsänderung.
>
> **AKTUELLER FLOW (LÜCKEN):**
> ```
> Marktplatz-Bestellung → BaseLinker → AvyCloud (auto-sync) ✅
>     → Manuelles Warehouse-Picking → Stock-Out API → BaseLinker update (async) ✅
>     → eBay Bestand update: ❌ FEHLT
>     → Kaufland Bestand update: ❌ FEHLT
>     → Automatisches Stock-Decrement bei Bestelleingang: ❌ BEWUSST DEAKTIVIERT (Idempotenz)
> ```
>
> **ZIEL-FLOW:**
> ```
> Bestellung eingehend → Stock reserviert (soft-lock) → Picking → Stock-Out bestätigt
>     → BaseLinker update (existiert ✅)
>     → eBay Quantity update via Trading API (reviseInventoryStatus) → NEU
>     → Kaufland Quantity update via Unit API (PATCH /units) → NEU
>     → Alle weiteren verbundenen Marktplätze synchronisiert → NEU
> ```
>
> **ABHÄNGIGKEIT:** Phase 4 FAKE→REAL muss NICHT erst fertig sein — Stock-Sync ist Backend-only und Production-kritisch.
> Kann parallel entwickelt werden.

- [x] **STOCK-SYNC-1: Stock-Reservation bei Bestelleingang (Soft-Lock)** (2026-03-06)
  - `services/stock-reservation.js` — `reserveStock()`, `releaseReservation()`, `confirmReservation()`, `getReservedQuantity()`, `listReservations()`, `expireStaleReservations()`
  - Firestore: `stock_reservations` Collection — {tenantId, orderId, sku, productId, quantity, status, createdAt, expiresAt}
  - Idempotent: doppelte Reservierung per orderId verhindert
  - In `services/order-sync.js`: Nach Order-Save → `reserveStock()` für neue Bestellungen (non-blocking)
  - 10 Tests bestanden (reserve, release, confirm, idempotenz, edge cases)

- [x] **STOCK-SYNC-2: Multi-Channel Bestandspush nach Stock-Out** (2026-03-06)
  - `services/stock-sync-dispatcher.js` — `syncStockToAllChannels({ tenantId, product, reason })`
  - eBay: `reviseFixedPriceItem({ itemId, quantity })` — Quantity-Support zu `buildReviseItemRequestXml` hinzugefügt
  - Kaufland: `updateUnit(unitId, product)` — nutzt `inventory.availableQuantity`
  - BaseLinker: handled separately (existing `backgroundSyncProductStockToBaseLinker`)
  - In `routes/warehouse.js`: stock-out UND stock-in triggern `syncStockToAllChannels()` (non-blocking, best-effort)
  - Audit-Log: `stock_sync_log` Collection in Firestore

- [x] **STOCK-SYNC-3: Preis-Push zu Marktplätzen** (2026-03-06)
  - `syncPriceToAllChannels({ tenantId, product, prices })` in `services/stock-sync-dispatcher.js`
  - eBay: `reviseFixedPriceItem({ itemId, startPrice })` — bestehende Funktion
  - Kaufland: `updateUnit(unitId, product)` — `pickUnitData` liest `pricing.sellPrice`
  - Noch nicht automatisch getriggert bei Preisänderung (manueller Call möglich)

- [x] **STOCK-SYNC-4: Sync-Status Dashboard Widget** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ Backend: `GET /api/sync/status` in `routes/orders.js` — aggregiert `stock_sync_log` (letzte 24h) + `stock_reservations` (active)
  - ✅ Frontend: `fetchSyncStatus()` in `api/client.ts` mit TypeScript-Interface `SyncStatusData`
  - ✅ Dashboard: "Marketplace Sync" Section mit Per-Channel-Cards (eBay, Kaufland, BaseLinker) + Reservierungen-Card
  - ✅ Zeigt: success/total ratio, letzter Sync-Zeitpunkt, Fehlercount, aktive Reservierungen
  - ⏳ Alerts bei fehlgeschlagenen Stock-Syncs (Toast/Notification-Bell) — Folge-Task

---

### Modul 1: UI/UX Design-System Foundation

- [x] **M1: Komponentenbibliothek (`components/ui/`)** ~~since 2026-03-05~~ (2026-03-05)
  - ✅ 17 Base-Components erstellt: Button, Input, Select, Badge, Card, Modal, Tabs, Tooltip, EmptyState, Skeleton, Alert, Dropdown, Breadcrumb, ProgressBar, Avatar, Stepper + cn() Utility
  - ✅ Index-Export: `components/ui/index.ts` — Barrel-Export aller Komponenten + Types
  - ✅ Tailwind-Animationen: slide-in-right, modal-in, indeterminate
  - ✅ Alle Komponenten nutzen Design Tokens (CSS-Variablen), Tailwind-Klassen, TypeScript Props
  - **Offen (Phase 2): Migration bestehender Komponenten auf ui/* Base-Components**
    - [ ] Alle `<button>` Tags → `<Button>` Component
    - [ ] Alle `<input>` Tags → `<Input>` Component
    - [ ] Alle `<select>` Tags → `<Select>` Component
    - [ ] Alle inline Status-Badges → `<Badge>` Component
    - [ ] Alle Modal/Dialog-Elemente → `<Modal>` Component
    - [ ] Alle Tab-Navigationen → `<Tabs>` Component
  - **Offen: Typography-Scale durchsetzen (h1-h4, body, caption, label)**
  - **Note:** `ui/Table.tsx` bewusst ausgelassen — AdminTable ist zu komplex für generische Table-Component, bleibt eigenständig

---

### Modul 2: Navigation & Layout

- [x] **M2: Sidebar, Topbar & Routing komplett überarbeiten** ~~since 2026-03-05~~ (2026-03-05)
  - ✅ Sidebar komplett neu: Collapsible Sections (AUFTRÄGE, PRODUKTE, LAGER, MARKTPLÄTZE, EINSTELLUNGEN), 240px/64px Collapse-Mode, localStorage-Persistenz, Accent-Left-Border Active-Indicator, Permission-basierte Sichtbarkeit
  - ✅ Topbar bereinigt: Breadcrumbs für verschachtelte Views, Ctrl+K Shortcut für Suche, Notification-Bell Placeholder, Settings-Gear entfernt (jetzt via Sidebar)
  - ✅ Routing komplett neu: 15+ neue Routes (#/orders/returns, #/orders/shipping, #/marketplace/ebay, #/settings/*, etc.), parseHash mit verschachtelten Pfaden, viewToHashPath aktualisiert, Legacy-Route-Redirects (#/ebay → #/marketplace/ebay)
  - ✅ ⚠️ Placeholder-Views für M3-M10 existieren → MÜSSEN beim Implementieren des jeweiligen Moduls durch echte Views ERSETZT werden
  - ✅ View-Type-Union erweitert auf 30 Views, ALLOWED_VIEWS aktualisiert, VIEW_MIGRATIONS für Legacy-Kompatibilität
  - **Offen (für spätere Module): EbayListingsView.tsx löschen (wenn MarketplaceListingsView.tsx in M5 fertig), Mobile-Navigation anpassen**
  - **Sidebar — FINALE Navigationsstruktur (bestätigt 2026-03-05):**
    ```
    Dashboard                          (Icon: LayoutDashboard)
    ──────────────────────────────
    AUFTRÄGE
      ├── Bestellungen                 (Icon: ClipboardList)
      ├── Retouren                     (Icon: RotateCcw)
      ├── Versand & Labels             (Icon: Truck)
      ├── Rechnungen                   (Icon: FileText)
      └── Einstellungen                (Icon: SlidersHorizontal)
           ├── Automatisierung
           ├── Status-Konfiguration
           ├── Nummernkreise
           └── Dokumenten-Templates
    ──────────────────────────────
    PRODUKTE
      ├── Produktdaten                 (Icon: Package)
      ├── Inventar                     (Icon: Warehouse)
      └── Erfassen                     (Icon: ScanLine)
    ──────────────────────────────
    LAGER
      ├── Verwaltung                   (Icon: MapPin)
      └── Einstellungen                (Icon: SlidersHorizontal)
    ──────────────────────────────
    MARKTPLÄTZE (dynamisch — NUR verbundene)
      ├── eBay                         (Icon: ShoppingBag oder eBay-Logo)
      ├── Kaufland                     (Icon: Store oder Kaufland-Logo)
      └── (weitere erscheinen automatisch wenn Integration verbunden)
    ──────────────────────────────
    Integrationen                      (Icon: Plug)
    ──────────────────────────────
    EINSTELLUNGEN (ganz unten, über User-Footer)
      ├── Unternehmensdaten            (Icon: Building2)
      ├── Persönliche Daten            (Icon: User)
      ├── Mitarbeiter & Rollen         (Icon: Users)
      ├── API                          (Icon: Code)
      └── Plan & Abrechnung            (Icon: CreditCard)
    ```
  - **Navigations-Regeln:**
    - [ ] **MARKTPLÄTZE-Gruppe ist dynamisch:** Nur verbundene Marktplätze anzeigen. Keine Marktplatz-Links wenn keine Integration aktiv. Reihenfolge: Alphabetisch oder nach Umsatz
    - [ ] **⚠️ "eBay (Gap Analysis)" View KOMPLETT ENTFERNEN** — `EbayListingsView.tsx` löschen, Route `#/ebay` entfernen. Gap-Infos werden in die jeweilige Marktplatz-Listing-View integriert
    - [ ] **Aufträge > Versand & Labels** ist hochgezogen (nicht versteckt) — tägliche Nutzung für Label-Druck, Tracking
    - [ ] **Aufträge > Rechnungen** ist hochgezogen — tägliche Nutzung, nicht unter Sub-Sub-Einstellungen verstecken
    - [ ] **Aufträge > Einstellungen** enthält NUR Konfiguration: Automatisierungs-Regeln, Status-Workflows, Nummernkreise (Rechnungs-/Auftrags-Nummern), Dokumenten-Templates (Rechnung/Lieferschein-Layout)
    - [ ] **Stow/Pick/Pack sind NUR in der Mobile-UI** verfügbar (unter "Operationen" in MobileTabBar/MobileOperationsView). Desktop-Sidebar hat KEINE Operationen/Stow/Pick/Pack Links — dort läuft alles über die Auftrags-Tabelle
    - [ ] **Erfassen (KI-Identify)** bleibt unter PRODUKTE — konzeptionell "neues Produkt in Katalog aufnehmen"
    - [ ] **Expandable Sections:** AUFTRÄGE, PRODUKTE, LAGER, MARKTPLÄTZE sind collapsible (Chevron-Icon, State in localStorage persistiert)
  - **Sidebar — UI/UX Spezifikation:**
    - [ ] Breite: 240px (expanded), 64px (collapsed, Icon-Only Mode)
    - [ ] Collapse-Toggle: Chevron-Button oben rechts in der Sidebar-Header-Leiste
    - [ ] Aktiver Nav-Punkt: Accent-Left-Border (3px, --accent) + leichter Background (--accent mit 8% opacity) + Font-Weight 500
    - [ ] Gruppen-Labels (AUFTRÄGE, PRODUKTE, etc.): 11px, Uppercase, Letter-Spacing 0.05em, --text-muted, 24px Margin-Top, 8px Margin-Bottom. Klickbar zum Auf-/Zuklappen (Chevron-Icon rechts)
    - [ ] Nav-Items: 14px, 400 weight, 40px Höhe, 12px Padding-Left (16px bei Sub-Items), Lucide-Icons (18px, 1.5 Stroke-Width, --text-muted, Active: --accent)
    - [ ] Sub-Items (unter Aufträge > Einstellungen): 13px, 32px Höhe, 32px Padding-Left, kein Icon
    - [ ] Hover: Background --surface, Transition 150ms ease
    - [ ] Sidebar-Footer: User-Avatar (32px) + Name + Role-Badge (Admin/User) + Logout-Icon. Fixed am unteren Rand, Border-Top 1px --border, 12px Padding
    - [ ] Scroll: Wenn Nav-Items Viewport überschreiten → Scroll innerhalb Sidebar (overflow-y: auto), Footer bleibt fixed (position: sticky)
    - [ ] Responsive: Sidebar verschwindet unter 768px → Mobile-Navigation übernimmt
  - **Topbar — Bereinigung:**
    - [ ] Links: Page-Title (h2, 18px, 600 weight) oder Breadcrumb (`ui/Breadcrumb` — z.B. "Aufträge > Bestellungen > #ORD-2024-001")
    - [ ] Mitte: Such-Input (max-width 480px, `ui/Input` mit Search-Icon Prefix, Placeholder "Suche... (Ctrl+K)", Cmd+K/Ctrl+K Shortcut öffnet fokussiert). Globale Suche: Produkte, Aufträge, Kunden durchsuchbar
    - [ ] Rechts: NUR Theme-Toggle (1x, Sun/Moon Icon) + Notification-Bell (mit Badge-Counter für ungelesene) + User-Avatar (32px, Klick → Dropdown: Persönliche Daten, Einstellungen, Logout)
    - [ ] Kein Sprach-Selector. Keine doppelten Elemente. Keine unnötigen Icons
    - [ ] Höhe: 56px, Background: --bg, Border-Bottom: 1px --border, Padding: 0 24px
  - **Routing — Neue Route-Struktur:**
    - [ ] `#/dashboard` — Dashboard
    - [ ] `#/orders` — Bestellungen (Default für AUFTRÄGE-Gruppe)
    - [ ] `#/orders/returns` — Retouren
    - [ ] `#/orders/shipping` — Versand & Labels
    - [ ] `#/orders/invoices` — Rechnungen
    - [ ] `#/orders/settings` — Auftrags-Einstellungen (Automatisierung, Status, Nummernkreise, Templates)
    - [ ] `#/products` — Produktdaten (Default für PRODUKTE-Gruppe)
    - [ ] `#/products/inventory` — Inventar/Bestand
    - [ ] `#/products/identify` — Erfassen (KI-Identify)
    - [ ] `#/warehouse` — Lagerverwaltung
    - [ ] `#/warehouse/settings` — Lager-Einstellungen
    - [ ] `#/marketplace/ebay` — eBay Listings (dynamisch)
    - [ ] `#/marketplace/kaufland` — Kaufland Listings (dynamisch)
    - [ ] `#/marketplace/:slug` — Generisch für zukünftige Marktplätze
    - [ ] `#/integrations` — Integrations-Hub
    - [ ] `#/settings` — Einstellungen (Unternehmensdaten)
    - [ ] `#/settings/profile` — Persönliche Daten
    - [ ] `#/settings/team` — Mitarbeiter & Rollen
    - [ ] `#/settings/api` — API-Verwaltung
    - [ ] `#/settings/billing` — Plan & Abrechnung
    - [ ] **ENTFERNEN:** Route `#/ebay` (alte Gap Analysis), Route `#/sheet`, Route `#/search` (in Topbar-Suche integriert)
  - **Mobile Navigation (< 768px):**
    - [ ] Bottom-TabBar: 3 Items — Dashboard (Icon: LayoutDashboard), Suche (Icon: Search), Operationen (Icon: PackageCheck)
    - [ ] Operationen-Page: 4 Cards — Erfassen, Einlagern (Stow), Kommissionieren (Pick), Verpacken (Pack)
    - [ ] Hamburger-Menu (oben links) für Zugang zu allen anderen Bereichen (Aufträge, Produkte, etc.)
    - [ ] Stow/Pick/Pack sind AUSSCHLIESSLICH hier verfügbar — NICHT in der Desktop-Sidebar
  - **Dateien:** `components/Sidebar.tsx` (komplett neu), `components/Topbar.tsx` (bereinigen), `App.tsx` (Routing komplett neu), `components/MobileTabBar.tsx` (beibehalten), `components/MobileOperationsView.tsx` (beibehalten), `i18n.tsx` (neue Nav-Labels auf Deutsch)

---

### Modul 3: Produkte (Katalog)

- [ ] **M3: Produkte-View Enterprise-tauglich** since 2026-03-05 (⚡ Teilweise implementiert)
  - ✅ ProductsPageHeader-Component: Titel + Counter + "Produkt anlegen" (Primary) / Import / Export (Secondary) Buttons
  - ✅ AdminTable bereits production-grade: 18 Spaltentypen, 4 Presets, Spalten-Konfiguration, Sortierung, Pagination (50/100/200), Filter (12+ Filter), Bulk-Actions
  - ✅ BulkActions immer sichtbar (BUG-005 fix), ProductSheet als Overlay (BUG-004 fix)
  - **Offen:**
  - **Page-Header:**
    - [ ] Titel "Produkte" (h1) + Counter "{gefiltert} von {gesamt} Produkte"
    - [ ] Action-Buttons rechts: "Produkt anlegen" (Primary), "Import" (Secondary), "Export" (Secondary)
  - **Kategorien-Management (in Produktdaten integriert, KEIN eigener Nav-Punkt):**
    - [ ] Kategorie als Filter-Dimension in der Produkte-Tabelle (Dropdown-Filter)
    - [ ] Kategorie-Spalte in Tabelle: Badge mit Kategorie-Name, klickbar → filtert auf diese Kategorie
    - [ ] Kategorie-Verwaltung: Settings-Modal oder Section in `#/settings` → Kategorie-Baum (Hierarchisch: Elektronik > Smartphones > Apple), Erstellen/Bearbeiten/Löschen, Drag-Reorder
    - [ ] Kategorie-Zuordnung: Im ProductSheet (Attribute-Tab) + Bulk-Aktion "Kategorie zuweisen"
    - [ ] Marketplace-Kategorie-Mapping: Pro Marktplatz eine Zuordnung (AvyCloud-Kategorie → eBay-Kategorie-ID, Kaufland-Kategorie) — konfigurierbar im Integrations-Hub (M9)
  - **Filter-System komplett neu:**
    - [ ] Filter-Bar unterhalb Header: Horizontale Chip-Leiste mit aktiven Filtern
    - [ ] Jeder Chip: Label + Wert + X-Close (z.B. "Marke: Apple ✕", "Status: Aktiv ✕")
    - [ ] "Filter hinzufügen" Button → Dropdown mit allen Filteroptionen:
      - Marke, Kategorie, Status (Aktiv/Inaktiv/Entwurf), Zustand (Neu/Gebraucht), Marketplace (eBay ✓/✕, Kaufland ✓/✕), Preisbereich, EAN (vorhanden/fehlend), Bilder (vorhanden/fehlend), Qualitätsscore-Bereich, Lagerort/Bin, Erstellt (Datumsbereich), Letzte Änderung (Datumsbereich)
    - [ ] "Alle Filter zurücksetzen" Link (nur sichtbar wenn Filter aktiv)
    - [ ] Saved Filter Presets: Dropdown "Gespeicherte Filter" (z.B. "Ohne EAN", "eBay-ready", "Niedrig-Bestand", "Neue Produkte 7 Tage")
    - [ ] User kann eigene Filter-Presets speichern (Name + Filterkombination → localStorage oder Firestore)
  - **Tabelle (AdminTable mit `ui/Table`):**
    - [ ] Standard-Spalten: Checkbox, Thumbnail (40x40), Name (truncated, max 2 Zeilen), SKU, EAN, Marke, Kategorie (Badge), Preis (VK), Bestand (Menge + Bin), Qualität (Score-Badge), Marketplace-Status (eBay ✓/✕ + Kaufland ✓/✕ Icons), Aktionen (3-Dot Menu)
    - [ ] Spalten-Konfiguration: Zahnrad-Icon → Dropdown-Checklist aller verfügbaren Spalten, User wählt welche sichtbar
    - [ ] Sortierung: Klick auf Spalten-Header, 3-State (Asc → Desc → None), visueller Pfeil-Indikator
    - [ ] Sticky Header bei Scroll
    - [ ] Row-Hover: Subtle --elevated Background
    - [ ] Row-Click: Öffnet ProductSheet (Overlay, KEIN Route-Wechsel)
    - [ ] Pagination: "25 / 50 / 100 pro Seite", Prev/Next, "Zeige 1-25 von 342"
    - [ ] Empty-State: `ui/EmptyState` — "Keine Produkte gefunden. Passe deine Filter an oder erfasse ein neues Produkt."
    - [ ] Loading: Skeleton-Rows (5 Zeilen) statt Spinner
  - **Bulk-Actions (bei Selektion):**
    - [ ] Sticky-Bar am unteren Rand: "{n} ausgewählt" + Action-Buttons
    - [ ] Primär-Buttons (immer sichtbar): "Verbessern" (KI), "Löschen", "Exportieren"
    - [ ] Sekundär-Buttons: "Preis aktualisieren", "Kategorie zuweisen", "eBay listen", "Kaufland listen"
    - [ ] ALLE Buttons immer sichtbar (nicht in verschachteltem "Mehr"-Dropdown verstecken)
    - [ ] Destruktive Aktionen: Bestätigungs-Modal ("Möchtest du {n} Produkte wirklich löschen?")
  - **ProductSheet (Detail-Panel) KOMPLETT NEU:**
    - [ ] Slide-in von rechts, 520px Breite, --surface Background, 1px --border links
    - [ ] Header: Close-Button (X) links, Thumbnail (48px), Produktname (h3, truncated), SKU (caption), Status-Badge
    - [ ] Tab-Bar (`ui/Tabs`): Übersicht | Bilder | Preise | Attribute | Marktplätze | Aktivität
    - [ ] **Übersicht-Tab:**
      - [ ] Hero-Image (200px, klickbar → Lightbox)
      - [ ] Produkt-Info-Grid: Name (editierbar), Brand, SKU, EAN (mit Valid/Invalid Badge), Kategorie (Badge + Link), Zustand, Beschreibung (Textarea)
      - [ ] Status-Section: Qualitätsscore (Fortschrittsbalken + Prozent), Marketplace-Status (eBay ✓/✕, Kaufland ✓/✕ mit letztem Sync-Datum)
      - [ ] Quick-Actions-Row: "Verbessern" (Primary), "Quality Check" (Secondary), "Label drucken" (Ghost)
    - [ ] **Bilder-Tab:**
      - [ ] Gallery-Grid (3 Spalten), Drag-Reorder
      - [ ] Upload-Zone (Drag & Drop oder Click)
      - [ ] Pro Bild: Löschen, als Hauptbild setzen, KI-Hintergrund entfernen
      - [ ] Bildoptimierung: Auto-Crop, Weißabgleich (existierende Backend-Funktionen)
    - [ ] **Preise-Tab:**
      - [ ] KI-Preisvorschlag: Vorgeschlagener Preis + Konfidenz-Badge (Hoch/Mittel/Niedrig) + "Übernehmen" Button
      - [ ] Manuell: EK-Feld, VK-Feld, Marge (automatisch berechnet, angezeigt als Prozent + Betrag)
      - [ ] Marketplace-Preise: Pro Marktplatz (eBay VK, Kaufland VK) — editierbar, Sync-Button
      - [ ] Competitor-Vergleich: Mini-Tabelle (Top 5 Konkurrenten: Quelle, Preis, Zustand, Datum)
    - [ ] **Attribute-Tab:**
      - [ ] Key-Value Grid (2 Spalten): Marke, Modell, Farbe, Speicher, Zustand, Gewicht, Maße, etc.
      - [ ] Edit-in-Place: Click auf Wert → Input, Enter speichert, Escape cancelt
      - [ ] "Attribut hinzufügen" Button am Ende
      - [ ] KI-Vorschläge: Badge "KI" neben automatisch erkannten Attributen
    - [ ] **Marktplätze-Tab (NEU — ersetzt alten eBay-Tab):**
      - [ ] Pro verbundenem Marktplatz eine Card:
        - Marktplatz-Name + Logo
        - Status: "Aktiv", "Inaktiv", "Nicht gelistet", "Fehler"
        - Listing-URL (klickbar)
        - Letzter Sync + Sync-Button
        - Marketplace-spezifische Felder (eBay: Item-ID, Kategorie; Kaufland: Offer-ID, etc.)
        - "Auf {Marktplatz} listen" Button (wenn nicht gelistet)
        - Readiness-Check: Fehlende Pflichtfelder als Gap-Liste
    - [ ] **Aktivität-Tab (NEU):**
      - [ ] Timeline: Chronologische Liste aller Änderungen (Erstellt, Bearbeitet, Gelistet, Preis geändert, Verbessert, etc.)
      - [ ] Pro Eintrag: Timestamp, User/System, Beschreibung, Vorher→Nachher bei Wertänderungen
    - [ ] KI-Chat (GeminiChat): Minimiert am unteren Rand des Sheets. Click → Expand. Quick-Prompt-Buttons: "Beschreibung verbessern", "Titel optimieren", "Fehlende Attribute ergänzen"
  - **Dateien:** `components/admin-table/AdminTable.tsx`, `components/admin-table/AdminTableHeader.tsx`, `components/admin-table/AdminTableRow.tsx`, `components/admin-table/AdminTableFilters.tsx`, `components/admin-table/BulkActions.tsx`, `components/ProductSheet.tsx`, `components/GeminiChat.tsx`

---

### Modul 4: Bestand (Inventar)

- [ ] **M4: Bestand-View — Lager-fokussiert, OHNE Marketplace-Listing-Features** since 2026-03-05
  - ✅ Route `#/products/inventory` aktiv, ⚠️ Placeholder-View vorhanden → MUSS durch echte Implementierung ERSETZT werden, ProductsPageHeader mit "Inventar"-Modus
  - **Konzept:** Bestand = physischer Lagerbestand. KEIN Listing-Management hier. Nur Indikatoren welche Marktplätze aktiv sind (als Badges). Listings werden in den jeweiligen Marktplatz-Views verwaltet.
  - **Page-Header:**
    - [ ] Titel "Bestand" + Counter "{n} Artikel im Lager"
    - [ ] KPI-Cards (4er Row): Gesamtartikel, Gesamteinheiten, Bestandswert (Σ EK), Niedrig-Bestand Alerts
    - [ ] Action-Buttons: "Einlagern" (Primary, → Stow-Flow), "Export" (Secondary)
  - **Filter-System:**
    - [ ] Filter-Chips: Lagerzone, Bin, Bestandsmenge (Range), Zustand (Neu/Gebraucht/Defekt), Letzte Bewegung (Datumsbereich), Marketplace-Status (Auf eBay ✓/✕, Auf Kaufland ✓/✕)
    - [ ] Quick-Filters: "Niedrig-Bestand" (< Reorder-Point), "Kein Lagerplatz", "Seit 30 Tagen unbewegt"
  - **Tabelle:**
    - [ ] Spalten: Checkbox, Thumbnail, Produktname, SKU, Bin (Lagerplatz-Badge), Menge, Zustand, EK, Bestandswert (Menge × EK), Letzte Bewegung (Datum), Marketplace-Indikatoren (kleine Icons: eBay ✓, Kaufland ✓ — NUR als Anzeige, nicht klickbar), Aktionen
    - [ ] Aktionen pro Row: "Umlagern" (Bin ändern), "Menge anpassen", "Details" (→ ProductSheet Overlay)
    - [ ] Row-Click → ProductSheet (Overlay, Kontext bleibt "Bestand")
  - **Bulk-Actions:**
    - [ ] "Umlagern" (Bin-Zuweisung für mehrere), "Inventur" (Mengen prüfen), "Export"
    - [ ] KEINE Marketplace-Aktionen hier — die gehören in die Marktplatz-Views
  - **Dateien:** `components/InventoryView.tsx` (komplett überarbeiten oder neu erstellen)

---

### Modul 5: Marktplatz-Listings (pro Marktplatz)

- [ ] **M5: ⚡ PRIORITÄT — Dynamische Marktplatz-Views (eBay + Kaufland ECHTE Listings)** since 2026-03-05 (⚡ UI fertig)
  - ✅ Routes `#/marketplace/ebay` + `#/marketplace/kaufland` aktiv, Sidebar dynamische MARKTPLÄTZE-Gruppe
  - ✅ `MarketplaceListingsView.tsx` erstellt — generische View für alle Marktplätze via `marketplace` prop
  - ✅ KPI-Cards, Sync-Status-Banner, 5-Tab-Filter, Datentabelle, Bulk-Actions, Pagination, Search, Statusbadges
  - ✅ EbayListingsView Import entfernt aus App.tsx, PlaceholderViews ersetzt
  - **Konzept:** Pro verbundenem Marktplatz ein eigener Nav-Link und eine eigene View. Wenn eBay verbunden → "eBay" in Sidebar unter MARKTPLÄTZE. Wenn Kaufland verbunden → "Kaufland" erscheint. Nicht verbundene Marktplätze erscheinen NICHT in der Sidebar (nur im Integrations-Hub).
  - **eBay Listings View (`#/marketplace/ebay`):**
    - [ ] Page-Header: "eBay Listings" + eBay-Logo + Connection-Status (Grüner Dot + "Verbunden")
    - [ ] KPI-Cards: Aktive Listings, Entwürfe, Fehler/Gaps, Umsatz 30 Tage, Ø Verkaufspreis
    - [ ] Tab-Bar: Alle Listings | Aktiv | Inaktiv | Entwürfe | Fehler
    - [ ] Tabelle: Thumbnail, Titel, eBay-Item-ID (Link zum Listing), Preis, Menge, Status (Aktiv/Inaktiv/Fehler Badge), Kategorie, Watchers, Verkäufe 30d, Letzter Sync, Aktionen
    - [ ] Aktionen: "Bearbeiten", "Deaktivieren", "Preis ändern", "Sync erzwingen"
    - [ ] Bulk: "Preis aktualisieren", "Deaktivieren", "Sync alle"
    - [ ] "Neues Listing erstellen" Button → Produkt aus Katalog wählen → Listing-Felder ausfüllen → Publish
    - [ ] Gap-Analyse INTEGRIERT: Bei Listings mit Fehlern → Expandable Row mit Gap-Details (fehlende Felder, Kategorie-Fehler, etc.)
    - [ ] Sync-Status-Banner oben: "Letzter Sync: vor 5min | Nächster Sync: in 10min | {n} Fehler"
  - **Kaufland Listings View (`#/marketplace/kaufland`):**
    - [ ] Gleiche Struktur wie eBay, aber Kaufland-spezifische Felder (Offer-ID, Kaufland-Kategorie, etc.)
    - [ ] KPIs, Filter, Tabelle, Bulk-Actions analog zu eBay
  - **Generisches Marketplace-View-Pattern:**
    - [ ] `components/MarketplaceListingsView.tsx` — Generische Component die per Props den Marktplatz erhält
    - [ ] Marktplatz-spezifische Konfiguration: Welche Spalten, welche Aktionen, welche API-Calls
    - [ ] Neue Marktplätze (Amazon, Otto, Zalando) können durch Config hinzugefügt werden ohne neue View-Component
  - **Realtime-Sync (KRITISCH):**
    - [ ] Bestandsabgleich eBay ↔ AvyCloud: Wenn Bestand in AvyCloud geändert → eBay-Menge automatisch aktualisieren (über bestehende `lib/ebay-api.js`)
    - [ ] Listing-Status Sync: Ob ein Produkt auf eBay gelistet ist oder nicht MUSS in Realtime sichtbar sein (Badge in der Tabelle)
    - [ ] Preis-Sync: Preisänderung in AvyCloud → Push zu eBay (über bestehende `lib/ebay-trading-api.js`)
    - [ ] Gleiche Sync-Logik für Kaufland über `lib/kaufland-api.js`
    - [ ] Sync-Status-Indikator pro Listing: "Gesynct ✓" (grün) / "Sync ausstehend" (gelb) / "Sync-Fehler" (rot) mit Timestamp
  - **Alte eBay Gap Analysis View ENTFERNEN (siehe BUG-006):**
    - [ ] `EbayListingsView.tsx` **LÖSCHEN** — Datei komplett entfernen
    - [ ] Alle Imports/Referenzen in App.tsx, Sidebar.tsx entfernen
    - [ ] Route `#/ebay` → Redirect zu `#/marketplace/ebay`
  - **Dateien:** `components/MarketplaceListingsView.tsx` (NEU — ersetzt EbayListingsView), `App.tsx` (Routes), `Sidebar.tsx`

---

### Modul 6: Aufträge (Order Management)

- [ ] **M6: Multi-Channel Order Management** since 2026-03-05 (⚡ UI fertig)
  - ✅ Routes für alle Sub-Views aktiv: `#/orders`, `#/orders/returns`, `#/orders/shipping`, `#/orders/invoices`, `#/orders/settings`
  - ✅ Bestehende OrdersView unter `#/orders`
  - ✅ `ReturnsView.tsx` — KPI-Cards, Tab-Filter, Datentabelle mit Grund/Status-Badges, Bulk-Actions
  - ✅ `ShippingView.tsx` — KPI-Cards, Carrier-Badges (DHL/DPD/GLS), Tracking-URLs, Label-Druck
  - ✅ `InvoicesView.tsx` — KPI-Cards, Rechnungstabelle, PDF/Mail-Aktionen, Überfällig-Markierung
  - ✅ `OrderSettingsView.tsx` — Automatisierungsregeln, Status-Konfiguration, Nummernkreise, Dokumenten-Templates
  - **Konzept:** Zentrale Auftragsansicht über ALLE Marktplätze. Jeder Auftrag hat eine Fulfillment-Pipeline: Neu → Bestätigt → Kommissioniert → Verpackt → Versendet → Zugestellt.
  - **Page-Header:**
    - [ ] Titel "Aufträge" + Counter "{offen} offen, {heute} heute"
    - [ ] KPI-Cards: Offene Aufträge, Heute eingegangen, Heute versendet, Ø Bearbeitungszeit, Umsatz heute
    - [ ] Sync-Button: "Aufträge synchronisieren" (alle Marktplätze)
  - **Pipeline-Visualisierung (NEU):**
    - [ ] Horizontale Pipeline-Bar: Neu (n) → Bestätigt (n) → Kommissionierung (n) → Verpackung (n) → Versendet (n)
    - [ ] Klick auf Stage → Filtert Tabelle auf diesen Status
    - [ ] Farbcodierung: Neu=Info, Bestätigt=Warning, Komm.=Accent, Verpackt=Success, Versendet=Muted
  - **Filter:**
    - [ ] Status, Marktplatz (eBay/Kaufland/Amazon/...), Datumsbereich, Kunde, Zahlungsstatus (Bezahlt/Offen/Erstattet)
  - **Tabelle:**
    - [ ] Spalten: Auftrag-ID (Marketplace-Ref), Datum, Kunde (Name, abgekürzt), Artikel (Produktname × Menge, mehrere Zeilen bei Multi-Item), Gesamt (Betrag + Währung), Quelle (Marketplace-Badge: eBay blau, Kaufland orange, etc.), Zahlungsstatus, Fulfillment-Status (Badge), Aktionen
    - [ ] Row-Expand: Klick → Auftragsdetails (alle Positionen, Versandadresse, Notizen)
    - [ ] Aktionen: "Kommissionieren starten", "Versandlabel drucken", "Details", "Stornieren"
  - **Auftragsdetail-Panel (Slide-in oder Seite):**
    - [ ] Kundendaten: Name, Adresse, E-Mail, Telefon
    - [ ] Positionen: Produktbild, Name, SKU, Menge, Einzelpreis, Gesamtpreis
    - [ ] Zahlungsinfo: Methode, Status, Transaktions-ID
    - [ ] Versandinfo: Carrier, Tracking-Nummer (klickbar), Status, Versandkosten
    - [ ] Timeline: Auftragshistorie (Bestellt → Bezahlt → Kommissioniert → Verpackt → Versendet → Zugestellt)
    - [ ] Aktionen: "Rechnung generieren", "Lieferschein drucken", "Versandlabel drucken", "Nachricht an Kunden"
  - **Rechnungen-View (`#/orders/invoices`) — NEU:**
    - [ ] Tab-Bar: Alle | Entwürfe | Gesendet | Bezahlt | Überfällig | Storniert
    - [ ] Tabelle: Rechnungs-Nr., Datum, Kunde, Auftrag-ID, Betrag (Netto/Brutto), Status (Badge), Fälligkeitsdatum, Aktionen
    - [ ] Aktionen: "PDF generieren", "Per E-Mail senden", "Als bezahlt markieren", "Stornieren"
    - [ ] Bulk: "Alle offenen drucken", "Mahnlauf starten"
    - [ ] Auto-Generierung: Rechnung automatisch erstellen wenn Auftrag Status = "Versendet" (konfigurierbar in Einstellungen)
    - [ ] PDF-Template: Firmenlogo, Adresse, USt-IdNr., Bankverbindung, Positionen, MwSt-Ausweis
    - [ ] Lieferschein-Generierung analog (gleicher Flow, anderes Template — ohne Preise)
    - [ ] Integration: SevDesk/lexoffice-Export wenn Buchhaltungs-Integration aktiv
  - **Auftrags-Einstellungen (`#/orders/settings`) — NEU:**
    - [ ] **Automatisierung:** Rule-Engine für automatische Status-Übergänge
      - "Wenn Zahlung eingegangen → Status 'Bestätigt'"
      - "Wenn alle Items gepickt → Status 'Kommissioniert'"
      - "Wenn Versandlabel erstellt → Status 'Versendet'"
      - "Wenn Tracking 'Zugestellt' → Status 'Abgeschlossen'"
    - [ ] **Status-Konfiguration:** Benutzerdefinierte Status-Namen und Reihenfolge, Farben pro Status
    - [ ] **Nummernkreise:** Rechnungs-Nummernkreis (Prefix, Start, Format z.B. "RE-2026-{0001}"), Auftrags-Nummernkreis, Lieferschein-Nummernkreis
    - [ ] **Dokumenten-Templates:** WYSIWYG-Editor oder Template-Upload für Rechnung, Lieferschein, Auftragsbestätigung. Platzhalter: {firmenname}, {kundenname}, {positionen}, {gesamt}, {datum}, etc.
    - [ ] **E-Mail-Templates:** Auftragsbestätigung, Versandbenachrichtigung, Rechnungsversand — Text editierbar, Platzhalter
  - **Backend:**
    - [ ] Existiert: `routes/orders.js`, `lib/firestore.js::listOrders()`
    - [ ] Erweitern: Fulfillment-Status-Updates (PATCH `/api/orders/:id/status`), Multi-Channel-Aggregation
    - [ ] NEU: `routes/invoices.js` — CRUD für Rechnungen, PDF-Generierung (pdfkit oder puppeteer). **MT-PFLICHT:** Alle Queries mit `tenantId`-Filter
    - [ ] NEU: `services/invoice-generator.js` — Template-Rendering, Nummernkreis-Logik, PDF-Export. **MT-PFLICHT:** Nummernkreise pro Tenant isoliert
    - [ ] NEU: `services/order-automation.js` — Rule-Engine für automatische Status-Übergänge. **MT-PFLICHT:** Rules pro Tenant gespeichert
    - [ ] Firestore Collections: `invoices` — {invoiceId, **tenantId**, orderId, number, customer, items, total, tax, status, pdfUrl, ...} *(MT-ready: tenantId als erstes Feld, Composite-Index tenantId+status)*
    - [ ] Webhook: Bei Status-Änderung → Marketplace-API (eBay: Mark as Shipped, Kaufland: Confirm Shipment)
  - **Dateien:** `components/OrdersView.tsx` (überarbeiten), `components/OrderDetail.tsx` (neu), `components/InvoicesView.tsx` (neu), `components/OrderSettingsView.tsx` (neu), `backend/routes/orders.js`, `backend/routes/invoices.js` (neu), `backend/services/invoice-generator.js` (neu), `backend/services/order-automation.js` (neu)

---

### Modul 7: Versand (Courier Integration)

- [ ] **M7: Multi-Carrier Versand-Management** since 2026-03-05 (⚡ UI fertig)
  - ✅ Route `#/orders/shipping` aktiv mit `ShippingView.tsx` — KPI-Cards, Carrier-Badges, Tracking-URLs, Label-Druck
  - **Konzept:** Zentrale Versandverwaltung. Mehrere Carrier (DHL, DPD, GLS, Hermes, UPS, Deutsche Post), Label-Druck, Tracking, automatische Carrier-Wahl basierend auf Regeln.
  - **Versand-View (`#/shipping`):**
    - [ ] KPI-Cards: Heute versendet, Pakete in Zustellung, Zustellquote, Ø Versandkosten
    - [ ] Tab-Bar: Ausstehend (zu versenden) | In Zustellung | Zugestellt | Probleme
    - [ ] Tabelle: Auftrag-ID, Kunde, Carrier (Logo-Badge), Tracking-Nummer (klickbar → Tracking-URL), Status, Versanddatum, Zustelldatum (geschätzt), Versandkosten
    - [ ] "Label drucken" — Einzel oder Bulk (Multi-Label-PDF)
    - [ ] Carrier-Auswahl: Bei Einzelversand → Dropdown mit konfigurierten Carriern + geschätzten Kosten
  - **Versand-Regeln (Automatisierung):**
    - [ ] Rule-Engine: "Wenn Gewicht < 1kg UND Inland → Deutsche Post Warenpost"
    - [ ] "Wenn Gewicht > 5kg → DHL Paket"
    - [ ] "Wenn Expressversand → DPD Express"
    - [ ] Default-Carrier konfigurierbar
  - **Tracking-Integration:**
    - [ ] Tracking-Status automatisch von Carrier-API abrufen (Polling oder Webhook)
    - [ ] Status-Updates an Marktplatz-API weiterleiten (eBay: Upload Tracking, Kaufland: Confirm Shipment)
    - [ ] Kunde erhält Tracking-Info automatisch
  - **Backend:**
    - [ ] Existiert: `lib/sendcloud.js` (nur SendCloud, hardcoded)
    - [ ] Erweitern: Multi-Carrier-Abstraction-Layer
    - [ ] `services/shipping.js` — `createShipment()`, `getLabel()`, `getTracking()`, `listCarriers()`
    - [ ] Carrier-Adapter: `lib/carrier-dhl.js`, `lib/carrier-dpd.js`, `lib/carrier-gls.js`, etc.
    - [ ] Carrier-Config aus Firestore (nicht ENV) — via Integrations-Management
  - **Dateien:** `components/ShippingView.tsx` (neu), `components/ShippingRules.tsx` (neu), `backend/services/shipping.js` (neu), `backend/lib/carrier-*.js` (neu)

---

### Modul 8: Retouren (Returns Management)

- [ ] **M8: Retouren-Management** since 2026-03-05 (⚡ UI fertig)
  - ✅ Route `#/orders/returns` aktiv mit `ReturnsView.tsx` — KPI-Cards, Tab-Filter, Grund/Status-Badges, Bulk-Actions
  - **Konzept:** Return-Requests entgegennehmen, Grund kategorisieren, Rückerstattung auslösen, Ware prüfen, wieder einlagern oder entsorgen.
  - **Retouren-View (`#/returns`):**
    - [ ] KPI-Cards: Offene Retouren, Retourenquote (%), Erstattungen diese Woche, Ø Bearbeitungszeit
    - [ ] Tab-Bar: Neu eingegangen | In Prüfung | Erstattet | Abgeschlossen | Abgelehnt
    - [ ] Tabelle: Retoure-ID, Auftrag-ID, Kunde, Produkt(e), Retourengrund (Badge), Eingang-Datum, Status, Erstattungsbetrag, Aktionen
  - **Retouren-Gründe (kategorisiert):**
    - [ ] "Defekt/Beschädigt", "Falsche Lieferung", "Nicht wie beschrieben", "Zu spät geliefert", "Meinungsänderung", "Doppelbestellung", "Sonstiges"
    - [ ] Pro Marktplatz: Marketplace-spezifische Gründe mappen (eBay Return Reasons → interne Kategorien)
  - **Retouren-Workflow:**
    - [ ] Schritt 1: Retoure eingeht (automatisch via Marketplace-API oder manuell)
    - [ ] Schritt 2: Ware prüfen — Zustand bewerten (A-Ware → Wiederverkauf, B-Ware → Reduziert, C-Ware → Entsorgung)
    - [ ] Schritt 3: Erstattung — Voll, Teilweise, oder Ablehnung (mit Begründung)
    - [ ] Schritt 4: Wiedereinlagerung — Wenn A/B-Ware: Zurück ins Inventar mit neuem Zustand
    - [ ] Schritt 5: Abschluss — Marketplace-API-Update (Refund Issued, Return Closed)
  - **Backend:**
    - [ ] `backend/routes/returns.js` (neu) — CRUD für Retouren. **MT-PFLICHT:** Alle Queries mit `tenantId`-Filter
    - [ ] `backend/services/returns.js` (neu) — processReturn(), issueRefund(), restockItem(). **MT-PFLICHT:** Alle Funktionen mit `{ tenantId, ...params }` Signatur
    - [ ] Firestore Collection: `returns` — {returnId, **tenantId**, orderId, items, reason, status, refundAmount, condition, ...} *(MT-ready: tenantId als erstes Feld)*
    - [ ] Marketplace-Integration: eBay GetReturnRequests, Kaufland Returns-API
  - **Dateien:** `components/ReturnsView.tsx` (neu), `components/ReturnDetail.tsx` (neu), `backend/routes/returns.js` (neu), `backend/services/returns.js` (neu)

---

### Modul 9: Integrationen — Self-Service Integration Hub

- [ ] **M9: Integrations-Hub — Echte Verbindungen, echte Auth-Flows, kein Fake** since 2026-03-05 (⚠️ UI existiert aber FAKE — Phase 4 #2 muss zuerst)
  - ✅ `IntegrationsHub.tsx` erstellt — aber mit hardcodierten Cards und "Demnächst verfügbar"
  - ⚠️ **Phase 4 #2 zuerst:** IntegrationsHub auf echte API-Calls umbauen (aktive Integrationen aus Backend)
  - ⚠️ **KRITISCHSTER GAP FÜR SAAS:** Ohne Self-Service-Integrationen kann kein neuer Kunde AvyCloud nutzen

  ---

  #### Architektur: 3 Auth-Patterns für ALLE Integrationen

  > **Jede Integration in AvyCloud fällt in eine von 3 Kategorien. Der Integration-Wizard erkennt den Typ und zeigt den passenden Flow:**

  **Pattern A: OAuth 2.0 (Authorization Code Grant) — Seller wird zur Login-Seite weitergeleitet**
  ```
  Flow: User klickt "Verbinden" → Redirect zu Provider Login → User autorisiert → Callback mit Code → Backend tauscht Code gegen Token
  Credentials gespeichert: access_token + refresh_token (automatisch refreshed)
  User-Eingabe: KEINE (alles automatisch über OAuth)
  ```
  **Anbieter:** eBay, Amazon SP-API, OTTO Market, Etsy, Shopify, lexoffice, Xero, Stripe Connect, DHL Paket, UPS

  **Pattern B: API-Key/Secret (Seller generiert Credentials in seinem Dashboard)**
  ```
  Flow: User klickt "Verbinden" → Modal mit Input-Feldern → User gibt Key/Secret ein → Backend validiert mit Test-Call → Gespeichert
  Credentials gespeichert: api_key + api_secret (verschlüsselt in Firestore)
  User-Eingabe: 1-2 Felder (Key, Secret)
  ```
  **Anbieter:** Kaufland (Client Key + Secret Key), BaseLinker (API Token), SevDesk (API Token), SendCloud (Public Key + Secret Key), WooCommerce (Consumer Key + Consumer Secret), Shopware 6 (Access Key + Secret), PrestaShop (API Key), Hood.de (API Password), Avocadostore (API Key), GLS (MyGLS Email + Password), DPD (Delis ID + Password), Stripe (Secret Key + Publishable Key)

  **Pattern C: Datei-basiert / Portal-basiert (kein Standard-API-Zugang)**
  ```
  Flow: Konfiguration + Export/Import statt Live-API
  ```
  **Anbieter:** DATEV (CSV/XML-Export), Zalando ZFS (Portal-Einladung, Vertragsbasis)

  ---

  #### Integrations-Katalog (nach Priorität — was bringt die meisten User)

  **Tier 1 — MUSS zum Launch (Backend existiert bereits, nur Self-Service-Setup fehlt):**

  | Integration | Auth | Credentials | Status in AvyCloud |
  |---|---|---|---|
  | **eBay** | OAuth 2.0 | Client ID + Secret (App), User autorisiert | ✅ Backend KOMPLETT (`lib/ebay-oauth.js`, `ebay-api.js`, `ebay-trading-api.js`, `ebay-direct.js`) |
  | **Kaufland** | HMAC-SHA256 | Client Key (32 Zeichen) + Secret Key (64 Zeichen) | ✅ Backend KOMPLETT (`lib/kaufland-api.js`) |
  | **BaseLinker** | API Token | Token aus BaseLinker Dashboard | ✅ Backend KOMPLETT (`lib/baselinker.js`, `services/baselinker-sync-runner.js`) |
  | **SendCloud** | Basic Auth | Public Key + Secret Key | ✅ Backend KOMPLETT (`lib/sendcloud.js`) |
  | **SevDesk** | API Token | 32-Zeichen Hex-Token aus SevDesk Dashboard | ✅ Backend KOMPLETT (`lib/sevdesk.js`) |
  | **DHL Paket** | OAuth 2.0 | API Key + Secret + Geschäftskunden-Vertrag | ⚠️ Teilweise via SendCloud |

  **Tier 2 — Nächste Welle (maximale Marktabdeckung DE):**

  | Integration | Auth | Was der User eingeben/tun muss | Aufwand |
  |---|---|---|---|
  | **Amazon SP-API** | OAuth 2.0 (LWA) | User klickt "Verbinden" → Amazon Login → Autorisiert App | Mittel — OAuth + LWA Token Exchange + Refresh |
  | **OTTO Market** | OAuth 2.0 (Client Credentials) | User erstellt Self-App im OPC Portal → gibt Client ID + Secret ein | Mittel — Client Credentials Grant |
  | **Shopify** | OAuth 2.0 | User klickt "Installieren" → Shopify Login → Autorisiert Scopes | Mittel — Standard OAuth, gut dokumentiert |
  | **WooCommerce** | API Keys | User gibt Consumer Key + Consumer Secret ein (aus WP Dashboard) | Klein — REST API mit Basic Auth |
  | **lexoffice** | OAuth 2.0 | User klickt "Verbinden" → Lexware Login → Autorisiert | Mittel — OAuth 2.0 mit Domain-Migration beachten |
  | **Etsy** | OAuth 2.0 + PKCE | User klickt "Verbinden" → Etsy Login → Autorisiert Scopes | Mittel — OAuth 2.0 mit PKCE |
  | **Shopware 6** | OAuth 2.0 (Client Credentials) | User gibt Access Key ID + Secret Access Key ein (aus Admin) | Klein — Token TTL nur 10min, muss refreshed werden |

  **Tier 3 — Erweiterung (Nischen, spezielle Anforderungen):**

  | Integration | Auth | Besonderheit |
  |---|---|---|
  | **DPD** | JWT Bearer | Delis ID + Password aus DPD-Vertrag, kein Self-Service-Portal |
  | **GLS** | Basic Auth + SHA512 | MyGLS Account, Password wird SHA512-gehasht |
  | **UPS** | OAuth 2.0 | Client Credentials, gute Doku |
  | **Stripe** | API Keys | Secret + Publishable Key aus Dashboard |
  | **Xero** | OAuth 2.0 | Multi-Org Support via tenant_id Header |
  | **PrestaShop** | API Key | 32-Zeichen Key aus PrestaShop Backend |
  | **Hood.de** | Basic Auth | API Password, erfordert Platin Shop (kostenpflichtig) |
  | **Avocadostore** | API Key | API Key aus Seller Dashboard |
  | **DATEV** | Datei-Export | CSV/XML Export, kein Live-API — Steuerberater-Schnittstelle |

  **NICHT integrieren (kein API-Zugang):**
  - ❌ **Kleinanzeigen** — Kein offizielles API für Seller, nur inoffizielle Scraper
  - ❌ **Zalando ZFS** — Portal-basiert, erfordert Partnervertrag + Integrator-Einladung, kein Self-Service

  ---

  #### Integration-Wizard (3 Varianten je Auth-Pattern)

  - [ ] **Wizard Variante A — OAuth 2.0 Flow (eBay, Amazon, Shopify, Etsy, lexoffice, Xero, DHL, UPS, OTTO):**
    - [ ] Step 1: Übersicht — Was kann diese Integration? Feature-Liste, Voraussetzungen
    - [ ] Step 2: "Jetzt verbinden" Button → **Redirect zu Provider** (z.B. `https://auth.ebay.com/oauth2/authorize?...`)
      - Backend generiert State-Token (CSRF-Schutz) + speichert in Firestore
      - Callback-URL: `https://product-hub-backend-xxx.run.app/api/marketplace/{provider}/oauth/callback`
      - Nach Autorisierung: Provider redirected zurück → Backend tauscht Code gegen Tokens
      - Tokens verschlüsselt in Firestore `integrations/{tenantId}/{provider}` gespeichert
    - [ ] Step 3: "Verbindung erfolgreich!" → Sync-Konfiguration (Was syncen, wie oft)
    - [ ] Step 4: Test-Verbindung (API-Call → "Verbunden! 342 Produkte gefunden.")
    - [ ] Step 5: Aktivieren
    - **eBay existiert bereits:** `startEbayOAuth()` → `GET /api/marketplace/ebay/oauth/start` → `GET /api/marketplace/ebay/oauth/callback`
    - **Für neue OAuth-Provider:** Gleiche Architektur wie `lib/ebay-oauth.js` — pro Provider ein `lib/{provider}-oauth.js`

  - [ ] **Wizard Variante B — API-Key Input (Kaufland, BaseLinker, SevDesk, SendCloud, WooCommerce, Shopware, PrestaShop):**
    - [ ] Step 1: Übersicht — Was kann diese Integration? + Anleitung wo man die Keys findet (Screenshot/Link)
    - [ ] Step 2: Input-Formular:
      - Kaufland: "Client Key" (Input, 32 Zeichen) + "Secret Key" (Input/Password, 64 Zeichen)
      - BaseLinker: "API Token" (Input)
      - SevDesk: "API Token" (Input, 32 Zeichen Hex)
      - SendCloud: "Public Key" (Input) + "Secret Key" (Input/Password)
      - WooCommerce: "Shop-URL" (Input, z.B. https://meinshop.de) + "Consumer Key" (Input) + "Consumer Secret" (Input/Password)
      - Shopware: "Shop-URL" + "Access Key ID" + "Secret Access Key"
      - PrestaShop: "Shop-URL" + "API Key" (32 Zeichen)
    - [ ] Step 3: "Verbindung testen" → Backend macht Test-API-Call mit eingegebenen Credentials
      - Kaufland: `GET /v2/info/locale` → wenn 200 OK → "Verbindung erfolgreich!"
      - BaseLinker: `getInventoryProductsList` → wenn ok → "Verbunden! {n} Produkte gefunden."
      - SevDesk: Kontostände abrufen → wenn ok → "Verbunden!"
      - Bei Fehler: Klare Fehlermeldung ("Ungültiger API-Key", "Verbindung verweigert", etc.)
    - [ ] Step 4: Sync-Konfiguration
    - [ ] Step 5: Aktivieren + Credentials verschlüsselt speichern

  - [ ] **Wizard Variante C — Export-Integration (DATEV):**
    - [ ] Step 1: Übersicht — "DATEV Export generiert CSV/XML Dateien die Ihr Steuerberater importieren kann"
    - [ ] Step 2: Konfiguration — Export-Format (DATEV EXTF CSV / XML), Buchungszeitraum, Kontenrahmen (SKR03/SKR04)
    - [ ] Step 3: Test-Export — Generiert Beispiel-Datei zum Download
    - [ ] Step 4: Aktivieren — Automatischer Export konfigurierbar (Monatlich nach Monatsabschluss)

  ---

  #### Integration-Settings (pro verbundener Integration)

  - [ ] Connection-Status: Verbunden seit {Datum}, Auth-Typ (OAuth/API-Key), Token-Ablauf (bei OAuth)
  - [ ] Letzter Sync {Datum/Uhrzeit}, Nächster Sync {Datum/Uhrzeit}, Sync-Intervall änderbar
  - [ ] Was wird gesynct: Produkte ✓/✕, Aufträge ✓/✕, Preise ✓/✕, Bestand ✓/✕ (Toggle pro Kategorie)
  - [ ] Sync-Richtung: AvyCloud → Marktplatz / Marktplatz → AvyCloud / Bidirektional
  - [ ] Kategorie-Mapping: AvyCloud-Kategorie → Provider-Kategorie (Dropdown-Mapping-Tabelle)
  - [ ] Preis-Regeln: Aufschlag/Abzug (%, €), Mindestpreis, Rundung (pro Integration)
  - [ ] Fehler-Log: Letzte 50 Sync-Fehler mit Timestamp, Error-Message, betroffenes Produkt/Auftrag
  - [ ] "Credentials aktualisieren" Button (bei API-Key-Rotation oder OAuth Re-Auth)
  - [ ] "Trennen" Button (Disconnect) mit Bestätigungsdialog + Warnung

  ---

  #### Backend-Architektur

  - [ ] `backend/routes/integrations.js` (neu) — REST-CRUD für Integrationen:
    - `GET /api/v1/integrations` → Liste aller Integrationen (tenantId-gefiltert)
    - `GET /api/v1/integrations/:type` → Detail einer Integration
    - `POST /api/v1/integrations/:type/connect` → Neue Integration starten (OAuth redirect oder Key speichern)
    - `POST /api/v1/integrations/:type/test` → Test-Verbindung
    - `PUT /api/v1/integrations/:type/settings` → Sync-Settings aktualisieren
    - `DELETE /api/v1/integrations/:type` → Integration trennen
    - `GET /api/v1/integrations/:type/oauth/callback` → OAuth Callback Handler
    - `GET /api/v1/integrations/:type/errors` → Fehler-Log

  - [ ] `backend/services/integration-store.js` (neu) — Credentials-Management:
    - `listIntegrations({ tenantId })` → Alle Integrationen mit Status
    - `getIntegration({ tenantId, type })` → Einzelne Integration + decrypted Credentials
    - `saveIntegration({ tenantId, type, credentials, settings })` → Verschlüsselt speichern
    - `deleteIntegration({ tenantId, type })` → Löschen + Cleanup
    - `testConnection({ tenantId, type })` → Provider-spezifischer Health-Check
    - **Verschlüsselung:** AES-256-GCM, Encryption Key aus Google Secret Manager (`INTEGRATION_ENCRYPTION_KEY`)
    - **Fallback:** Wenn Firestore-Integration nicht existiert → ENV-Variablen als Fallback (Rückwärtskompatibilität)

  - [ ] `backend/lib/integration-registry.js` (neu) — Provider-Konfiguration:
    ```js
    // Jeder Provider definiert: Auth-Typ, benötigte Felder, Test-Funktion, Logo-URL
    const PROVIDERS = {
      ebay: { authType: 'oauth2', name: 'eBay', category: 'marketplace', logo: 'ebay.svg',
              testFn: async (creds) => { /* fetchEbayStatus() */ },
              oauthConfig: { authUrl: '...', tokenUrl: '...', scopes: [...] } },
      kaufland: { authType: 'api_key', name: 'Kaufland', category: 'marketplace', logo: 'kaufland.svg',
                  fields: [{ key: 'clientKey', label: 'Client Key', type: 'text' },
                           { key: 'secretKey', label: 'Secret Key', type: 'password' }],
                  testFn: async (creds) => { /* kauflandRequest('GET', '/v2/info/locale') */ } },
      // ... alle weiteren Provider
    };
    ```

  - [ ] Firestore Collection: `integrations` — {id, **tenantId**, type, authType, credentials: {encrypted}, settings: {syncInterval, syncProducts, syncOrders, syncPrices, syncStock, direction}, status: 'active'|'error'|'disconnected', connectedAt, lastSync, lastError}

  - [ ] **Migration (Rückwärtskompatibel):** Bestehende `lib/ebay-oauth.js`, `lib/kaufland-api.js`, `lib/baselinker.js`, `lib/sendcloud.js`, `lib/sevdesk.js` bekommen einen Wrapper:
    ```js
    // In jedem bestehenden API-Client:
    async function getCredentials() {
      // Erst Firestore (integration-store), dann ENV als Fallback
      const stored = await integrationStore.getIntegration({ tenantId: 'default', type: 'kaufland' });
      if (stored?.credentials) return stored.credentials;
      // Fallback auf Secret Manager / ENV (Rückwärtskompatibilität)
      return { clientKey: await getSecretValue('KAUFLAND_CLIENT_KEY'), secretKey: await getSecretValue('KAUFLAND_SECRET_KEY') };
    }
    ```

  - **Dateien:** `components/IntegrationsHub.tsx` (umbauen), `components/IntegrationWizard.tsx` (neu), `components/IntegrationSettings.tsx` (neu), `backend/routes/integrations.js` (neu), `backend/services/integration-store.js` (neu), `backend/lib/integration-registry.js` (neu)

---

### Modul 10: Analytics & Reporting

- [ ] **M10: Dashboard & Reporting Enterprise-Grade** since 2026-03-05
  - ✅ Bestehendes Dashboard funktional (Revenue KPIs, Orders, Shipping-Kosten)
  - **Dashboard überarbeiten:**
    - [ ] Revenue-KPIs: Umsatz heute, Umsatz Monat, Umsatz YTD — mit Trend-Pfeil (↑ +12% vs. Vormonat)
    - [ ] Order-KPIs: Aufträge heute, Offene Aufträge, Ø Bestellwert, Retourenquote
    - [ ] Inventory-KPIs: Artikel im Bestand, Gesamtwert, Niedrig-Bestand Alerts, Out-of-Stock
    - [ ] Umsatz-Chart: Dual-Axis (Umsatz + Auftragsanzahl) mit Zeitraum-Selector (7T/30T/90T/YTD/Custom)
    - [ ] Umsatz nach Marktplatz: Stacked Bar-Chart oder Pie-Chart (eBay vs. Kaufland vs. Direkt)
    - [ ] Aktivitäts-Feed: Letzte Aktionen (Produkt erstellt, Auftrag eingegangen, Listing gesynct, etc.) — Live-Updates
    - [ ] Marktplatz-Übersicht: Mini-Cards pro verbundenem Marktplatz (Status, Aktive Listings, Umsatz 30d)
  - **Reporting-Seite (NEU, unter Einstellungen oder eigener Nav-Punkt):**
    - [ ] Vordefinierte Reports:
      - "Umsatzreport" (Zeitraum, pro Marktplatz, pro Kategorie)
      - "Bestandsreport" (Aktueller Bestand, Wert, Bewegungen)
      - "Margenreport" (EK vs. VK vs. Gebühren vs. Versand = Nettomarge)
      - "Bestseller/Slowmover" (Top 20 Verkäufe, Bottom 20 ohne Verkäufe seit X Tagen)
      - "Retourenreport" (Quoten pro Marktplatz, Top-Retourengründe)
    - [ ] Export: CSV, Excel (.xlsx), PDF
    - [ ] Zeitraum wählbar, Marktplatz filterbar
  - **Backend:**
    - [ ] `backend/routes/reports.js` (neu) — GET `/api/reports/:type?from=&to=&marketplace=`
    - [ ] `backend/services/analytics.js` (neu) — Aggregation-Queries auf Firestore (oder BigQuery-Export für Performance)
  - **Dateien:** `components/DashboardView.tsx` (überarbeiten), `components/ReportsView.tsx` (neu), `backend/routes/reports.js` (neu), `backend/services/analytics.js` (neu)

---

### Modul 12: Lagerverwaltung (Warehouse)

- [ ] **M12: Lagerverwaltung — Zonen, Bins, Einstellungen** since 2026-03-05 (⚡ Settings UI fertig)
  - ✅ Routes `#/warehouse` + `#/warehouse/settings` aktiv
  - ✅ `WarehouseSettingsView.tsx` — Bin-Logik, Zonen-Typen, Barcode-Einstellungen, Bestandsgrenzen, Inventur-Konfiguration
  - **Konzept:** Verwaltung der physischen Lagerstruktur. Zonen, Regale, Bins definieren. Lagerplatz-Zuordnung, Umlagern, Inventur. NICHT das gleiche wie "Bestand" (M4) — M4 zeigt Artikel+Mengen, M12 verwaltet WO die Artikel liegen.
  - **Lagerverwaltung-View (`#/warehouse`):**
    - [ ] Page-Header: "Lagerverwaltung" + Counter "{n} Lagerorte"
    - [ ] KPI-Cards: Gesamte Bins, Belegte Bins (%), Freie Bins, Lagerbewegungen heute
    - [ ] Tab-Bar: Zonen | Bins | Inventur | Bewegungen
    - [ ] **Zonen-Tab:**
      - [ ] Grid von Zone-Cards: Zone-Name (z.B. "Regal A", "Hochregal 1", "Kleinteile"), Anzahl Bins, Belegung (%), Erstellt-Datum
      - [ ] "Zone anlegen" Button → Modal: Name, Beschreibung, Typ (Regal/Palette/Kleinteile/Kühlung)
      - [ ] Klick auf Zone → Zeigt Bins innerhalb dieser Zone
    - [ ] **Bins-Tab:**
      - [ ] Tabelle: Bin-Code (z.B. "A-01-03"), Zone, Typ (Standard/Palette/Kleinteile), Status (Frei/Belegt/Gesperrt), Inhalt (Produktname + Menge oder "Leer"), Kapazität (%), Letzte Bewegung
      - [ ] Filter: Zone, Status (Frei/Belegt/Gesperrt), Typ
      - [ ] "Bin anlegen" Button → Modal: Code (Auto-Generierung oder manuell), Zone (Dropdown), Typ, Max-Kapazität
      - [ ] Aktionen pro Bin: "Inhalt anzeigen", "Sperren/Freigeben", "Umbenennen", "Löschen" (nur wenn leer)
    - [ ] **Inventur-Tab:**
      - [ ] Inventur starten: Zone oder Bin-Bereich wählen → Inventur-Auftrag erstellen
      - [ ] Inventur-Liste: Bin-Code, Soll-Bestand (System), Ist-Bestand (gezählt), Differenz, Status (Offen/Geprüft/Abgeschlossen)
      - [ ] Ist-Bestand Eingabe: Inline-Edit in Tabelle oder per Barcode-Scanner (Mobile)
      - [ ] Abschluss: Differenzen bestätigen → Bestand automatisch korrigiert
      - [ ] Inventur-Protokoll als PDF exportieren
    - [ ] **Bewegungen-Tab:**
      - [ ] Timeline/Tabelle: Zeitstempel, Typ (Einlagerung/Auslagerung/Umlagerung/Korrektur), Produkt, Menge, Von-Bin, Nach-Bin, User
      - [ ] Filter: Typ, Zeitraum, Produkt, Zone
      - [ ] Export als CSV
  - **Lager-Einstellungen (`#/warehouse/settings`):**
    - [ ] **Bin-Logik:** Auto-Zuweisung aktivieren (ja/nein), Vergabe-Strategie (FIFO, nächste freie, gleicher Artikel zusammen)
    - [ ] **Zonen-Typen:** Custom Zonen-Typen definieren (Name, Icon, Standard-Kapazität)
    - [ ] **Barcode-Einstellungen:** Barcode-Format für Bins (Code128, QR), Prefix, Label-Druck-Template
    - [ ] **Reorder-Thresholds:** Default-Mindestbestand pro Zone oder Global, Alarm-Schwelle (z.B. < 5 Einheiten)
    - [ ] **Inventur-Einstellungen:** Pflicht-Inventur-Intervall (Monatlich/Quartalsweise/Jährlich), Inventur-Reminder
  - **Backend:**
    - [ ] `backend/routes/warehouse.js` (neu) — CRUD für Zonen, Bins, Inventur, Bewegungen
    - [ ] `backend/services/warehouse.js` (neu) — createZone(), createBin(), moveToBin(), startInventory(), completeInventory(). **MT-PFLICHT:** Alle Funktionen mit `{ tenantId, ...params }` Signatur
    - [ ] Firestore Collections *(ALLE mit tenantId als erstes Feld — MT-ready)*:
      - `warehouse_zones` — {id, **tenantId**, name, type, description, binCount, ...}
      - `warehouse_bins` — {id, **tenantId**, code, zoneId, type, status, maxCapacity, currentItems: [{productId, quantity}], ...}
      - `warehouse_movements` — {id, **tenantId**, type, productId, quantity, fromBin, toBin, userId, timestamp}
      - `warehouse_inventories` — {id, **tenantId**, status, zone, bins: [{binId, expected, counted, diff}], startedAt, completedAt}
    - [ ] Existiert teilweise: `lib/warehouse.js` mit bin-Logik — erweitern, nicht ersetzen
  - **Dateien:** `components/WarehouseView.tsx` (neu), `components/warehouse/ZonesTab.tsx`, `components/warehouse/BinsTab.tsx`, `components/warehouse/InventoryTab.tsx`, `components/warehouse/MovementsTab.tsx`, `components/WarehouseSettings.tsx` (neu), `backend/routes/warehouse.js` (neu), `backend/services/warehouse.js` (neu)

---

### Modul 13: Erfassen (KI-Identify Flow)

- [ ] **M13: Erfassen — KI-gestützte Produkterkennung als geführter Flow** since 2026-03-05
  - Route `#/products/identify` aktiv (⚠️ aktuell Placeholder → MUSS ersetzt werden)
  - ✅ Backend komplett vorhanden: `services/enrichment.js`, `services/improve.js`, `lib/gemini-structured.js`, `lib/image-search.js`, `services/job-runner.js`
  - **Konzept:** AvyClouds USP. Benutzer fotografiert/uploaded ein Produkt → KI erkennt automatisch: Was ist es? Marke? Modell? EAN? Preis? Der User bestätigt/korrigiert → Produkt wird im Katalog angelegt. Dies ist der Haupt-Workflow für Eingangsware.
  - **Erfassen-View (`#/products/identify`) — Stepper-Flow:**
    - [ ] **`ui/Stepper`-Component:** 5 Schritte, horizontal, aktiver Schritt hervorgehoben
    - [ ] **Schritt 1: Bild hochladen**
      - [ ] Drag & Drop Zone (zentral, groß, mind. 300px Höhe)
      - [ ] "Datei wählen" Button als Alternative
      - [ ] Kamera-Button (Mobile: öffnet Kamera direkt)
      - [ ] Mehrere Bilder möglich (Thumbnails unterhalb)
      - [ ] Akzeptierte Formate: JPG, PNG, WEBP, max 20MB
      - [ ] Upload-Progress-Bar
      - [ ] "Weiter" Button (Primary, nur aktiv wenn mind. 1 Bild)
    - [ ] **Schritt 2: KI-Erkennung (automatisch)**
      - [ ] Progress-Screen: "Produkt wird analysiert..."
      - [ ] Animierter Fortschritt: Bild-Analyse → Barcode-Scan → Web-Recherche → Preisermittlung → Zusammenfassung
      - [ ] Jeder Sub-Schritt mit Status-Icon (Spinner → Checkmark → Error)
      - [ ] SSE-Stream vom Backend (`useJobStream` Hook) für Live-Progress
      - [ ] Backend-Pipeline: Vision-API → Barcode-Detection → Web-Search → Title Insights → LLM-Synthese → Pricing
      - [ ] Dauer: 15-45 Sekunden typisch
      - [ ] Bei Fehler: Retry-Button + Fallback auf manuelle Eingabe
    - [ ] **Schritt 3: Ergebnisse prüfen & korrigieren**
      - [ ] Erkanntes Hero-Image links (200px)
      - [ ] Rechts: Formular mit vorausgefüllten KI-Ergebnissen:
        - Produktname (editierbar, Input)
        - Marke (editierbar, Input mit Autocomplete aus bestehendem Katalog)
        - Modell (editierbar)
        - EAN/UPC (editierbar, Validierung: 13-stellig, Prüfziffer)
        - Kategorie (Dropdown, vorausgewählt)
        - Zustand (Dropdown: Neu / Gebraucht - Sehr gut / Gebraucht - Gut / Gebraucht - Akzeptabel / Defekt)
        - Beschreibung (Textarea, KI-generiert, editierbar)
      - [ ] KI-Konfidenz pro Feld: Badge "Sicher" (grün, >80%) / "Unsicher" (gelb, 50-80%) / "Geschätzt" (rot, <50%)
      - [ ] Felder mit niedriger Konfidenz: Orange Umrandung, User soll prüfen
      - [ ] "Titel verbessern" Button (KI-Re-Generate mit editiertem Input)
    - [ ] **Schritt 4: Preis & Lager**
      - [ ] KI-Preisvorschlag: Angezeigter Preis + Quelle (eBay Sold, Amazon, etc.) + Konfidenz
      - [ ] Manueller VK-Override (Input)
      - [ ] EK-Eingabe (Input, Pflichtfeld falls bekannt)
      - [ ] Marge (automatisch berechnet: VK - EK, angezeigt als € + %)
      - [ ] Bestand: Menge (Input, Default: 1), Zustand (Dropdown), Lagerplatz/Bin (Dropdown aus existierenden Bins)
      - [ ] Marketplace-Quick-Select: "Direkt auf eBay listen" (Checkbox), "Direkt auf Kaufland listen" (Checkbox)
    - [ ] **Schritt 5: Zusammenfassung & Speichern**
      - [ ] Kompakte Übersicht aller eingegebenen Daten (Read-only)
      - [ ] Hero-Image + Thumbnails
      - [ ] Alle Attribute in 2-Spalten-Grid
      - [ ] Preis + Marge + Lagerplatz
      - [ ] Marktplatz-Optionen
      - [ ] "Speichern" Button (Primary) → `POST /api/v1/products` via `saveProductV2()`
      - [ ] "Speichern & Nächstes erfassen" Button (Secondary) → Speichert + Reset auf Schritt 1
      - [ ] Erfolgs-Toast: "Produkt '{Name}' erfolgreich angelegt!" mit Link zum ProductSheet
  - **Schnell-Erfassung (Alternative zum Stepper):**
    - [ ] Toggle oben: "Geführt" (Stepper, Default) / "Schnell" (Single-Page)
    - [ ] Schnell-Modus: Bild-Upload + Mini-Formular auf einer Seite, KI läuft im Hintergrund, Felder füllen sich live
    - [ ] Für erfahrene User die viele Produkte hintereinander erfassen
  - **Mobile-Optimierung:**
    - [ ] Camera-First: Upload-Zone ist auf Mobile ein großer Kamera-Button
    - [ ] Swipe-Navigation zwischen Stepper-Schritten
    - [ ] Barcode-Scanner-Button (Mobile Kamera → Barcode erkennen → EAN ausfüllen)
  - **Backend (existiert, Verbindung herstellen):**
    - [ ] `POST /api/v1/identify` → startet Job → SSE-Stream über `GET /api/v1/identify/:jobId/stream`
    - [ ] Pipeline in `services/enrichment.js`: `runFullIdentification()` → Vision + Barcode + Web + Pricing
    - [ ] `services/improve.js`: `improveProduct()` für Titel/Beschreibung-Optimierung
    - [ ] `saveProductV2()` am Ende des Flows
    - [ ] Existierende Hooks: `useJobStream.ts` für SSE-Progress
  - **Dateien:** `components/IdentifyView.tsx` (komplett neu als Stepper-Flow), `components/identify/StepUpload.tsx`, `components/identify/StepAnalysis.tsx`, `components/identify/StepReview.tsx`, `components/identify/StepPricing.tsx`, `components/identify/StepSummary.tsx`

---

### Modul Bonus: Automatisierung & Bulk-Operationen

- [ ] **M-AUTO: Workflow-Automatisierung & Bulk-Import/Export** since 2026-03-05
  - ✅ Pricing Engine existiert backend-only (`services/pricing-engine.js`), AdminTable hat bereits Bulk-Actions (Sync, Improve, Delete, Label, eBay/Kaufland)
  - **Bulk-Import/Export:**
    - [ ] Import: CSV/Excel Upload → Produkte, Preise oder Bestände aktualisieren
    - [ ] Template-Download: Leere Excel-Vorlage mit korrekten Spalten
    - [ ] Import-Preview: Vorschau der Änderungen vor Ausführung (Zeile für Zeile, Fehler markiert)
    - [ ] Export: Produkte, Bestand, Aufträge als CSV/Excel mit konfigurierbaren Spalten
  - **Repricing-Engine (existiert Backend-only, braucht UI):**
    - [ ] Repricing-Dashboard: Aktive Regeln, letzte Preisänderungen, Savings
    - [ ] Regel-Editor: "Wenn Wettbewerber-Preis < mein Preis → unterbiete um X€/X%"
    - [ ] Mindestmarge-Schutz: Nie unter EK + definierte Marge verkaufen
    - [ ] Pro Marktplatz: Separate Pricing-Regeln
    - [ ] Schedule: Repricing alle X Stunden oder manuell
  - **Workflow-Builder (Phase 2 — nach Launch):**
    - [ ] Visueller Editor (If-Then Regeln, kein Code): Trigger → Bedingung → Aktion
    - [ ] Beispiele: "Wenn Bestand < 5 → eBay-Listing pausieren", "Wenn neues Produkt erfasst → Auto-Improve starten"
    - [ ] Dies ist ein Phase-2-Feature nach dem initialen Launch
  - **Dateien:** `components/BulkImportView.tsx` (neu), `components/RepricingDashboard.tsx` (neu), `backend/routes/bulk.js` (erweitern), `backend/services/pricing-engine.js` (existiert, UI anbinden)

---

### Modul 11: Einstellungen (Settings)

- [ ] **M11: Einstellungen-Bereich komplett neu** since 2026-03-05 (⚡ UI fertig)
  - ✅ Routes `#/settings`, `#/settings/profile`, `#/settings/team`, `#/settings/api`, `#/settings/billing` aktiv
  - ✅ Sidebar EINSTELLUNGEN-Gruppe mit allen Sub-Items
  - ✅ `#/settings/team` rendert bestehendes AdminPanel (User/Role-Management)
  - ✅ `CompanySettings.tsx` — Firmendaten, Adresse, Kontakt, Bankverbindung, Logo-Upload
  - ✅ `ProfileSettings.tsx` — Profildaten, Passwort ändern, Benachrichtigungen, Theme-Auswahl
  - ✅ `ApiSettings.tsx` — API-Keys, Webhooks, Nutzungsstatistiken, Dokumentation
  - ✅ `BillingSettings.tsx` — Planübersicht, Nutzung, Zahlungsmethode, Rechnungshistorie
  - **Konzept:** Zentraler Bereich für Unternehmens-, User- und System-Konfiguration. Ersetzt den bisherigen "Admin"-Bereich mit einer klareren Struktur.
  - **Unternehmensdaten (`#/settings`):**
    - [ ] Firmenname, Rechtsform, USt-IdNr., Steuernummer
    - [ ] Adresse (Straße, PLZ, Ort, Land)
    - [ ] Logo-Upload (für Rechnungen, Lieferscheine, E-Mails)
    - [ ] Bankverbindung (IBAN, BIC, Bank — für Rechnungs-Templates)
    - [ ] Kontakt-E-Mail, Telefon, Website
    - [ ] Impressum-Daten (für Marketplace-Listings)
  - **Persönliche Daten (`#/settings/profile`):**
    - [ ] Name, E-Mail, Telefon
    - [ ] Passwort ändern
    - [ ] Profilbild/Avatar
    - [ ] Benachrichtigungs-Präferenzen (E-Mail bei: Neuer Auftrag, Niedrig-Bestand, Sync-Fehler, Retoure)
    - [ ] Theme-Präferenz (Dark/Light/System)
  - **Mitarbeiter & Rollen (`#/settings/team`):**
    - [ ] Mitarbeiter-Liste: Name, E-Mail, Rolle, Status (Aktiv/Deaktiviert), Letzter Login
    - [ ] "Mitarbeiter einladen" Button → E-Mail-Einladung
    - [ ] Rollen-Management: Admin, Manager, Lagermitarbeiter, Viewer (oder Custom)
    - [ ] Berechtigungen pro Rolle: Welche Module sichtbar (Aufträge ✓, Produkte ✓, Einstellungen ✕), welche Aktionen erlaubt (Lesen/Schreiben/Löschen)
    - [ ] Existiert teilweise: `AdminRoleManagement.tsx`, `AdminUserManagement.tsx` — in neues UI migrieren
  - **API-Verwaltung (`#/settings/api`):**
    - [ ] API-Keys generieren / widerrufen
    - [ ] Webhook-Konfiguration: Endpoints, Events (order.created, product.updated, etc.), Secret
    - [ ] API-Usage-Stats: Requests/Tag, Rate-Limit-Status
    - [ ] API-Dokumentation Link (→ Swagger/OpenAPI, wenn verfügbar)
  - **Plan & Abrechnung (`#/settings/billing`):**
    - [ ] Aktueller Plan: Name, Preis, Features, Limits
    - [ ] Usage-Anzeige: Produkte (342 / 1.000), Aufträge/Monat (89 / 500), Integrationen (2 / 5), API-Calls
    - [ ] Plan upgraden / downgraden
    - [ ] Zahlungsmethode verwalten (Stripe-Integration → "Waiting On")
    - [ ] Rechnungshistorie: Datum, Betrag, PDF-Download
    - [ ] ⚠️ Stripe-Integration ist in "Waiting On" — UI kann vorbereitet werden mit Placeholder-Daten
  - **Backend:**
    - [ ] Existiert teilweise: `routes/admin.js`, `lib/rbac.js`
    - [ ] NEU: `routes/settings.js` — Unternehmens-, Profil-, Team-CRUD. **MT-PFLICHT:** Settings per Tenant, `req.user.tenantId` als Scope
    - [ ] NEU: Firestore Collection `company_settings` — {**tenantId** (= Doc-ID), companyName, address, logo, taxId, bankDetails, ...} *(MT-ready: tenantId IST die Doc-ID — ein Dokument pro Tenant)*
    - [ ] Erweiterung `routes/auth.js` — Profil-Update, Passwort-Change
  - **Dateien:** `components/SettingsView.tsx` (neu, Tab-basiert), `components/settings/CompanySettings.tsx`, `components/settings/ProfileSettings.tsx`, `components/settings/TeamSettings.tsx`, `components/settings/ApiSettings.tsx`, `components/settings/BillingSettings.tsx`, `backend/routes/settings.js` (neu)

---

### Bestehende Tasks (beibehalten)

- [ ] **P0: Identify-Modul stärken — API-Nutzung koordinieren**
  - ✅ Preisanreicherung Doppel-Gate aufgetrennt (2026-03-03)
  - ✅ eBay Title Insights: Keyword-Fallback (2026-03-03)
  - ✅ Dedizierte `image-search.js` (2026-03-04)
  - ✅ `enrichment.js::runSmartImageRecovery()` nutzt `image-search.js` (2026-03-04)
  - **Offen:** Orchestrierte Enrichment-Pipeline: Vision → Barcode → Web-Recherche → Title Insights → LLM-Synthese
  - **Dateien:** `enrichment.js`, `image-search.js`

- [ ] **P1: Monitoring & Error-Tracking** — Wenn ein Runner hängt merkt das niemand
  - Sentry, Uptime-Monitoring, Job-Health-Dashboard, Alerts

- [x] **P1: UI/UX — Accessibility (WCAG 2.1 AA)** ~~In Arbeit~~ (2026-03-05)
  - ✅ AdminTable, GeminiChat, ProductSheet, EbayListingsView, MobileOperationsView (2026-03-04)
  - ✅ Keyboard-Navigation, Sidebar Arrow-Keys (2026-03-05)
  - ✅ MobileTabBar: `role="tablist"` + `role="tab"` + `aria-selected` Pattern (2026-03-05)

---

## Waiting On

- [ ] **Multi-Tenancy (P2 — NÄCHSTE PHASE nach aktuellem Ausbau)** since 2026-03-01
  - **Vorbereitung läuft JETZT:** Alle neuen Collections/Services mit `tenantId` (siehe MT-Kompatibilitätsblock oben)
  - **Was in der MT-Phase kommt:**
    - [ ] Tenant-Modell in Firestore: `tenants` Collection — {tenantId, name, plan, owner, createdAt, settings}
    - [ ] Auth-Middleware erweitern: `req.user.tenantId` aus Firebase Custom Claims
    - [ ] Tenant-Onboarding-Flow (Registrierung → Tenant erstellen → Admin-User)
    - [ ] Tenant-Switcher UI (für Admins mit Zugang zu mehreren Tenants)
    - [ ] Migration bestehender `products_v2` + `orders` → `tenantId: 'default'` hinzufügen
    - [ ] GCS-Pfade migrieren: `/{tenantId}/images/...`
    - [ ] Alle bestehenden Service-Funktionen (`saveProductV2`, `getProduct`, `listOrders` etc.) um `tenantId`-Filter erweitern
    - [ ] Rate-Limiting pro Tenant
    - [ ] Firestore Security Rules pro Tenant
  - **Abhängigkeit:** Stripe Billing (Tenant ↔ Subscription)
- [ ] **Stripe Billing (P3)** — Blocker für SaaS. Nur mit expliziter Anweisung. since 2026-03-01

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

- [x] ~~P1: UI/UX — AdminTable aufteilen~~ (2026-03-05) — AdminTableHeader, AdminTableRow, BulkActions, AdminTableFilters extrahiert
- [x] ~~P0: Listing-Status Frontend-Badge~~ (2026-03-04)
- [x] ~~P1: Chat Intent-Detection per LLM~~ (2026-03-04)
- [x] ~~P2: Formular-Validierung~~ (2026-03-04)
- [x] ~~P2: Polling durch SSE ersetzen~~ (2026-03-04)
- [x] ~~P0: Image-Generator Background Removal~~ (2026-03-04)
- [x] ~~P1: Job-Timeout + Dead-Letter-Queue~~ (2026-03-04)
- [x] ~~P1: Code-Splitting~~ (2026-03-04)
- [x] ~~P1: Chat-Qualität verbessern~~ (2026-03-04)
- [x] ~~P2: Error Boundary~~ (2026-03-04)
- [x] ~~P2: State Management~~ (2026-03-04)
- [x] ~~P0: Listing-Status Realtime-Sync~~ (2026-03-04)
- [x] ~~P0: Schreibpfade auf saveProductV2()~~ (2026-03)
- [x] ~~P0: Pricing Engine produktionsreif~~ (2026-03)
- [x] ~~P0: eBay/Kaufland Update synct Preis~~ (2026-03)
- [x] ~~P0: Marketplace Listing-Status automatisch~~ (2026-03)
- [x] ~~P0: Konkurrenzpreise-System~~ (2026-03)
- [x] ~~P0: LLM Titel-Generierung~~ (2026-03)
- [x] ~~P1: Integration-Tests~~ (2026-03)
- [x] ~~P1: CLAUDE.md aktualisieren~~ (2026-03)
- [x] ~~P0-001: Security Headers (Helmet.js)~~ (2026-02)
- [x] ~~P0-002: Rate-Limiting~~ (2026-02)
- [x] ~~P0-003: .env.local aus Git-Historie~~ (2026-02)
- [x] ~~P0-004: Firestore Normalisierung~~ (2026-02)
- [x] ~~P1-001: Structured Logging (Pino)~~ (2026-02)
- [x] ~~P1-002: Health-Check & Graceful Shutdown~~ (2026-02)
- [x] ~~P1-003: Vitest Infrastruktur~~ (2026-02)
- [x] ~~P1-004: Error Response Standardisierung~~ (2026-02)
- [x] ~~P1-005: Express Router Splitting~~ (2026-02)
- [x] ~~P1-006: API Versioning~~ (2026-02)
- [x] ~~P2-001: SSE für Job-Status~~ (2026-02)
- [x] ~~P2-002: Pricing Engine~~ (2026-02)
- [x] ~~P2-003: Inventory Forecasting~~ (2026-02)
- [x] ~~P2-004: Webhook-System~~ (2026-02)
- [x] ~~P2-005: Produkt-Deduplizierung~~ (2026-02)
- [x] ~~P3-001: Competitor Intelligence~~ (2026-02)
