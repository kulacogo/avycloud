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

> **⚠️ AKTUELLER ZUSTAND (Stand 2026-03-07): SPRINT 4 VORBEREITUNG**
>
> **✅ Abgeschlossen:**
> - Phase 1–3: Security, Daten-Normalisierung, Infrastruktur, Code-Qualität
> - Phase 4: FAKE→REAL (12 Module auf echte API-Calls umgebaut)
> - Phase 5: Stock-Sync (Reservierungen, Multi-Channel Sync, Preis-Sync)
> - Sprint 3 UI-Fixes: AUDIT-001–013 (Crashes, Marketplace-Enrichment, Farbe Blau, Badge-Semantik, Animationen)
>
> **🔴 OFFEN — Sprint 3 Restarbeiten:**
> - AUDIT-014: Gap-Analyse aus Marketplace-UI entfernen + beide Seiten vereinheitlichen
> - AUDIT-007: Erfassen-Route hat keinen eigenen View
> - AUDIT-009: Settings-Seiten verifizieren
> - UX-Cross-Check: Restliche Typografie, Spacing, Animationen
>
> **🚀 STRATEGISCHE ENTSCHEIDUNG (2026-03-07):**
> **AvyCloud wird ein eigenständiges Order Management System — komplett losgelöst von BaseLinker.**
> BaseLinker wird durch native Marketplace-API-Anbindung (eBay/Kaufland) für Order-Intake ersetzt.
> Rechnungen, Versandlabels, Retouren — alles nativ in AvyCloud.
>
> **→ NÄCHSTE PRIORITÄT:**
> 1. Sprint 3 Restarbeiten abschließen (AUDIT-014, AUDIT-007, AUDIT-009)
> 2. **OMS Phase A: Parallelbetrieb** — AvyCloud empfängt Bestellungen AUCH direkt von Marktplätzen
> 3. **OMS Phase B: AvyCloud Primary** — BaseLinker nur noch Fallback
> 4. **OMS Phase C: BaseLinker abschalten**

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
  - ✅ Frontend-SKU-Matching scheiterte an Format-Mismatch (Kaufland `id_offer` vs products_v2 `identification.sku`)
  - ✅ Neuer Backend-Endpoint `GET /api/marketplace/kaufland/listings` in `backend/routes/marketplace.js`
    - Fetcht `kauflandUnitsLive` + `products_v2` parallel
    - Multi-Key Matching: exakte SKU → SKU ohne Prefix → EAN/Barcode
    - Gibt enriched Rows zurück mit `title`, `brand`, `price`, `imageUrl`, `category`
  - ✅ Neue API-Client-Funktion `fetchKauflandListings()` + `KauflandListingRow` Interface
  - ✅ `MarketplaceListingsView` nutzt jetzt Backend-Endpoint statt Frontend-SKU-Map
  - ✅ `products` Prop entfernt (nicht mehr benötigt, Backend macht den Join)

- [x] **BUG-010: Listing-Aktionen gehören NICHT in Produkte/Inventar-View** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ BulkActions.tsx: eBay/Kaufland Buttons + Dropdown entfernt
  - ✅ ProductSheet: "eBay" Publish-Button komplett entfernt (Header + Aktionen-Sektion)
  - ✅ `handlePublishToEbay`, `isPublishingEbay`, `ebayPublishStatus` State/Funktion entfernt
  - ✅ `publishToEbay`, `verifyEbayPublish` Imports entfernt
  - ✅ Listing-Status-Badges bleiben als reine Status-Anzeige (eBay: Gelistet/Inaktiv, Kaufland: Gelistet/Inaktiv)
  - ✅ Badge-Farben auf Theme-Tokens umgestellt (`text-success`/`text-warning` statt hardcoded amber/danger)

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

- [x] **BUG-013: ProductSheet Titel wird VERTIKAL angezeigt — jeder Buchstabe auf neuer Zeile** ~~since 2026-03-06~~ (2026-03-06)
  - ✅ Ursache: `lg:flex-row` auf Header-Container zwang Titel und 4 Buttons nebeneinander — Buttons nahmen zu viel Breite, Titel-Container (`flex-1 min-w-0`) schrumpfte auf 1 Zeichen Breite
  - ✅ Fix: Layout auf `flex-col` geändert — Titel immer oberhalb der Buttons, volle Breite
  - ✅ Buttons: `w-full sm:w-auto` entfernt, nutzen jetzt `flex-wrap` für natürliches Wrapping

- [x] **BUG-018: ProductSheet komplett unbrauchbar — Redesign DRINGEND** since 2026-03-06 ✅ FIXED 2026-03-06: Complete rewrite with 6-tab layout (Stammdaten/Bilder/Attribute/Marktplätze/Qualität/KI-Assistent), compact header with product image + truncated title + inline meta + action buttons, panel width increased to 55vw, quality issues grouped with collapsible details, web evidence as clickable links with favicons
  - **PROBLEM:** Das Produkt-Datenblatt (Slide-in Panel rechts) ist nicht arbeitsfähig:
    1. **Zu schmal:** Panel nimmt nur ~25% der Bildschirmbreite ein → alles gequetscht
    2. **Titel zu groß:** Produktname in riesiger Schrift nimmt 30% des sichtbaren Bereichs
    3. **Kein Produktbild** im oberen Bereich sichtbar
    4. **Quality-Issues als Textwand:** Gelbe Badges mit rohen Attributnamen ("attributes_duplicate_value: Redundante Attribute: gleicher Wert '120 kg' in Belastbarkeit, Maximale Belastbarkeit") — unleserlich, nicht gruppiert
    5. **Keine Struktur/Tabs:** Alles untereinander: Titel, Brand, Kategorie, SKU, Barcodes, Quality, Web-Evidence, Assistant — kein Tab-System
    6. **GPT Assistant Panel nimmt Platz weg** und ist im Datenblatt-Kontext nutzlos
    7. **Web-Evidence als rohe URLs** — nehmen Platz, schlecht formatiert
    8. **Bearbeiten/Speichern ganz unten** — muss nach unten scrollen um Aktionen zu erreichen
    9. **Kein erkennbarer Edit-Modus** — wo ändert man Preis, Titel, Beschreibung, Attribute?
  - **SOLL-DESIGN (orientiert an Plentymarkets/Billbee/ChannelEngine):**
    - [ ] **Breite:** Mindestens 50% des Bildschirms (oder besser: eigene Full-Page-View statt Slide-in)
    - [ ] **Header:** Produktbild (groß) + Titel (1 Zeile, ellipsis) + Brand + SKU/EAN inline + Bearbeiten/Speichern Buttons OBEN
    - [ ] **Tab-Navigation:**
      - Tab 1: **Stammdaten** — Titel, Beschreibung, Brand, Kategorie, Preis, EAN, MPN, Gewicht, Maße (EDITIERBAR)
      - Tab 2: **Bilder** — Galerie mit Drag&Drop Sortierung, Bild-Upload, Hauptbild setzen
      - Tab 3: **Attribute** — Strukturierte Key-Value-Tabelle (Farbe: Schwarz, Material: Polyester, etc.)
      - Tab 4: **Marktplätze** — Status pro Channel (eBay: Gelistet, Item-ID: xxx | Kaufland: Gelistet, Unit-ID: xxx)
      - Tab 5: **Qualität** — Quality-Score, Issues gruppiert nach Typ, Verbesserungsvorschläge
      - Tab 6: **Historie** — Änderungslog, wann was von wem geändert
    - [ ] **Edit-Modus:** Klick auf "Bearbeiten" → alle Felder werden editierbar (Input-Felder statt Text)
    - [ ] **Quality-Issues:** Gruppiert nach Typ, Severity-Badge (Kritisch/Warnung/Info), aufklappbare Details
  - **Dateien:** `components/ProductSheet.tsx` (kompletter Rewrite)

- [x] **BUG-014: eBay Listings auf 500 hardcoded-limitiert — zeigt nicht alle Angebote** since 2026-03-06 ✅ FIXED 2026-03-06: Removed Math.min(limit,500) cap, added batchGetAll() for Firestore getAll() 500-ref limit, frontend requests up to 2000 listings
  - **PROBLEM:** `listLiveListings()` in `backend/lib/ebay-direct.js` Zeile ~1571 hat ein hardcoded Limit: `Math.min(limit, 500)`. eBay-Seller hat 756+ Listings (340 aktiv + 410 nicht verkauft + 6 Entwürfe). AvyCloud zeigt nur 500.
  - **AUSWIRKUNG:** Nutzer sieht nicht alle seine Listings. KPI-Cards zeigen falsche Zahlen (130 aktiv statt 340 aktiv laut eBay-Cockpit).
  - **FIX:**
    - [ ] `listLiveListings()` in `ebay-direct.js`: 500-Cap ENTFERNEN → Cursor-Pagination mit `startAfter()`
    - [ ] `GET /api/marketplace/ebay/listings` in `routes/marketplace.js`: Pagination-Parameter akzeptieren (`page`, `pageSize`, `pageToken`)
    - [ ] Response: `{ data: [...], total: N, nextPageToken: '...' }` statt nur Array
    - [ ] KPI-Cards: Separate Firestore Count-Query (nicht aus gelimiteter Liste berechnen)
    - [ ] Frontend: Pagination-Controls (Seiten-Navigation oder "Mehr laden")
  - **MT-PFLICHT:** tenantId Filter vorbereiten
  - **Dateien:** `backend/lib/ebay-direct.js`, `backend/routes/marketplace.js`, `components/MarketplaceListingsView.tsx`, `api/client.ts`

- [x] **BUG-015: eBay "231 Fehler" sind KEINE echten Fehler — irreführende Status-Klassifizierung** since 2026-03-06 ✅ FIXED 2026-03-06: Removed gapCriticalCount from status classification, renamed "Fehler" tab to "Optimierung" with warning color, added gap count as warning icon tooltip next to listing title
  - **PROBLEM:** `normalizeEbayStatus()` in MarketplaceListingsView klassifiziert Listings als "Fehler" wenn `gapCriticalCount > 0`. Das sind Datenqualitäts-Gaps (fehlende Kategorie, Bilder etc.) — KEINE eBay-Fehler. Nutzer denkt seine eBay-Listings haben Probleme, obwohl sie auf eBay einwandfrei laufen.
  - **FIX:**
    - [ ] `normalizeEbayStatus()`: Gap-Analyse NICHT als "Fehler" klassifizieren
    - [ ] Status nur aus eBay-Listing-Daten: Aktiv (`active=true`) / Inaktiv (`listingStatus=Completed/Ended`) / Entwurf
    - [ ] Gaps als SEPARATE Spalte oder kleines Warn-Icon neben dem Titel (Tooltip: "3 Optimierungsvorschläge")
    - [ ] Tab "Fehler" umbenennen zu "Optimierung" oder entfernen
  - **Dateien:** `components/MarketplaceListingsView.tsx`

- [x] **BUG-016: Kein "Neues Listing erstellen" auf Marketplace-Seiten** since 2026-03-06 ✅ FIXED 2026-03-06: Added "Artikel listen" button + product search modal, eBay uses existing publishToEbay(), Kaufland publish via new POST /api/marketplace/kaufland/publish endpoint using existing createUnit()
  - **PROBLEM:** Kein Button/Flow um ein AvyCloud-Produkt auf eBay oder Kaufland zu listen. `publishToEbay()` existiert im Backend (AddFixedPriceItem), wurde aber in BUG-010 aus dem ProductSheet entfernt und nie auf die Marketplace-Seite verschoben. Für Kaufland existiert gar kein Publish-Endpoint.
  - **eBay:** `publishToEbay(productId, overrides)` in `api/client.ts` + `backend/lib/ebay-direct.js publishProduct()` — KOMPLETT implementiert
  - **Kaufland:** KEIN `publishToKaufland()` — muss neu gebaut werden (`POST /units` via Kaufland API)
  - **FIX:**
    - [ ] MarketplaceListingsView: "Artikel listen" Button oben rechts
    - [ ] eBay: Öffnet Wizard → Produkt auswählen → Listing-Details prüfen → Veröffentlichen (nutzt bestehendes `publishToEbay()`)
    - [ ] Kaufland: Neuer Endpoint `POST /api/marketplace/kaufland/publish` → `createUnit()` via Kaufland API
    - [ ] `lib/kaufland-api.js`: `createUnit({ sku, ean, title, price, quantity, ... })` implementieren
  - **MT-PFLICHT:** tenantId Parameter
  - **Dateien:** `components/MarketplaceListingsView.tsx`, `backend/routes/marketplace.js`, `backend/lib/kaufland-api.js`, `api/client.ts`

- [x] **BUG-017: Kaufland-Seite zeigt immer noch nur SKU-Nummern (Enrichment funktioniert nicht)** since 2026-03-06 ✅ FIXED 2026-03-06: Fixed image field path (url_or_base64), added EAN fallback matching, storefront filter fallback, quantity field, Kaufland product title/price as fallback when no AvyCloud match, added match count logging
  - **PROBLEM:** Screenshot zeigt: Kaufland-Seite hat jetzt Preis/Bestand/Status/Kategorie Spalten, aber Titel ist immer noch "SKU-9671499764", Preis "—", Status "Unbekannt", Kategorie "—". Enrichment-Endpoint wurde gebaut (`GET /api/marketplace/kaufland/listings`) aber Frontend nutzt ihn entweder nicht, oder SKU-Matching im Backend matcht nichts.
  - **DEBUG:**
    - [ ] Prüfe ob Frontend `fetchKauflandListings()` aufruft oder noch alte `syncKauflandListings()` + `fetchKauflandSkuIndex()`
    - [ ] Prüfe Backend-Logs: Wie viele von 301 Units werden tatsächlich gematcht? (`matched X of Y`)
    - [ ] Prüfe SKU-Format in `kauflandUnitsLive`: Ist das Feld `sku` oder `id_offer`? Format "SKU-9671499764" oder "9671499764"?
    - [ ] Prüfe `products_v2` SKU-Format: Ist es `identification.sku` = "SKU-9671499764" oder nur Nummer?
    - [ ] Wenn Matching 0% → SKU-Formate stimmen nicht überein → Backend-Matching-Logik erweitern
  - **Dateien:** `components/MarketplaceListingsView.tsx`, `backend/routes/marketplace.js`

- [x] **BUG-007: React Error #426 — ProductSheet crash bei Klick auf Produkt** since 2026-03-05 ✅ Fixed: ProductSheet direct import, removed lazy-loading + dual render
  - **PROBLEM:** Minified React error #426 ("A component suspended while responding to synchronous input") beim Öffnen eines Produkts aus Produkte oder Inventar
  - **URSACHE:** `ProductSheet` war `React.lazy()` geladen UND wurde gleichzeitig an 2 Stellen gerendert (als Route `case 'sheet'` + als Overlay)
  - **FIX (bereits in App.tsx implementiert):**
    1. ✅ `ProductSheet` direkt importiert statt `React.lazy()` — kein lazy-loading mehr
    2. ✅ `case 'sheet'` aus `renderView()` entfernt — nur noch Overlay-Rendering
    3. ✅ Alle `setView('sheet')` Aufrufe → redirecten auf `'products'`
    4. ✅ Suspense-Wrapper um Overlay entfernt
  - **MUSS DEPLOYED WERDEN** via `git push` → GitHub Actions → Firebase Hosting

---

### 🔴 LIVE-AUDIT 2026-03-06: Vollständiger UI/UX-Durchlauf avycloud.web.app

> **Methode:** Jede einzelne Seite der Live-App wurde im Browser geöffnet und gescreenshottet.
> **Ergebnis: Die App ist in Production NICHT nutzbar.** Massive Crashes, fehlende Daten, UI-Probleme.

#### P0 — CRASHES & FIRESTORE-INDEX-FEHLER (App unbenutzbar)

- [x] **AUDIT-001: "Unexpected token '<'" Crash auf mehreren Seiten** ✅ Fixed: Replaced ALL 20 React.lazy() imports with direct imports in App.tsx, removed Suspense wrapper
  - **Betroffene Routen:** `#/inventory`, `#/capture`, `#/orders/shipping`, `#/orders/invoices` (beim ersten Laden nach Cold-Start/Direct-Navigation)
  - **Symptom:** Error Boundary "Etwas ist schiefgelaufen — Unexpected token '<'" — kompletter Whitescreen
  - **Ursache:** Wahrscheinlich fehlendes Lazy-Loaded Chunk im Production Build. Wenn Seiten ÜBER die Sidebar-Navigation aufgerufen werden (statt direct URL), laden sie teils korrekt.
  - **FIX:** `React.lazy()` Imports prüfen. Alle lazy-geladenen Chunks in `vite.config.ts` / Build-Output validieren. Ggf. alle Lazy-Imports durch direkte Imports ersetzen (wie bei BUG-007 für ProductSheet).

- [x] **AUDIT-002: Firestore FAILED_PRECONDITION — Composite Indexes fehlen** ✅ Fixed: Created firestore.indexes.json with 9 composite indexes, deployed via `firebase deploy --only firestore:indexes`
  - **Betroffene Seiten:** Retouren, Versand & Labels, Rechnungen, API-Schlüssel (Settings/API)
  - **Symptom:** Roter Banner "FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/..."
  - **Ursache:** Neue Firestore-Collections (`returns`, `shipments`, `invoices`, `api-keys`) verwenden `orderBy`/`where`-Kombinationen, für die kein Composite-Index existiert.
  - **FIX:** ALLE Index-URLs aus den Fehlermeldungen aufrufen und Indexes in Firebase Console erstellen. Alternativ: `firestore.indexes.json` pflegen und deployen via `firebase deploy --only firestore:indexes`.

#### P1 — FEHLENDE DATEN IN MARKETPLACE-TABELLEN

- [x] **AUDIT-003: eBay Listings — Tabelle halb leer** ✅ Verified: Fields (categoryName, viewItemUrl, updatedAt) already mapped in listLiveListings()
  - **Sichtbar:** Titel/SKU ✅, Item-ID ✅, Preis ✅, Bestand ✅ (aber überall "1"), Status ✅
  - **FEHLT:** Kategorie (überall "—"), Letztes Update (überall "—"), Link (überall "—")
  - **Bestand unrealistisch:** Fast alle Listings zeigen "1" — das ist der eBay-Bestand, nicht der tatsächliche Lagerbestand
  - **FIX:** Backend `GET /api/marketplace/ebay/listings` muss eBay-Kategorie, lastModified, viewItemURL aus der GetSellerList-Response mappen und zurückgeben. Bestand-Spalte sollte AvyCloud-Bestand (aus products_v2) zeigen, nicht eBay-Quantity.

- [x] **AUDIT-004: Kaufland Listings — Preis, Bestand, Status, Kategorie komplett leer** ✅ Fixed: Kaufland sync now writes title + listing_price, GET response includes updatedAt
  - **Sichtbar:** Titel ✅ (Produktnamen statt SKU — Verbesserung!), Unit-ID ✅
  - **FEHLT:** Preis (überall "—"), Bestand (überall "0" rot), Status (überall "Unbekannt"), Kategorie (überall "—"), Letztes Update (überall "—"), Link (überall "—")
  - **FIX:** Backend `GET /api/marketplace/kaufland/listings` muss `price`, `amount`, `status`, `category`, `url` aus der Kaufland-API-Response zurückgeben. Server-Side-Enrichment (SKU→Product-Join) muss Preis+Bestand aus units-Response mappen.

- [x] **AUDIT-005: eBay auf Integrationen-Seite zeigt "Nicht verbunden" obwohl Listings geladen werden** ✅ Fixed: Fallback checks EBAY_CLIENT_SECRET when OAuth doc has no token
  - **Widerspruch:** IntegrationsHub zeigt eBay-Karte mit "Nicht verbunden / Nicht konfiguriert", aber eBay-Listings-Seite lädt 636 Listings erfolgreich.
  - **FIX:** IntegrationsHub muss den tatsächlichen eBay-Verbindungsstatus prüfen (z.B. Token-Validität, letzte erfolgreiche API-Antwort).

#### P2 — DASHBOARD-PROBLEME

- [x] **AUDIT-006: Dashboard MARKETPLACE SYNC zeigt "Sync-Status nicht verfügbar"** ✅ Fixed: Shows per-channel cards with "Kein Sync in 24h" instead of bare error text
  - **Symptom:** Die 4 MARKETPLACE SYNC Karten im Dashboard sind leer, nur der Text "Sync-Status nicht verfügbar" wird angezeigt.
  - **FIX:** Dashboard muss Marketplace-Sync-Status von Backend abrufen (letzte Sync-Zeit, Erfolg/Fehler pro Marktplatz).

#### P3 — NAVIGATION & ROUTING

- [ ] **AUDIT-007: Erfassen-Route hat keinen eigenen View**
  - **Symptom:** Sidebar "Erfassen" klicken → leitet zu `#products` (Produktdaten) weiter. Kein dedizierter Capture/Identify-Flow.
  - **FIX:** Eigene Route `#/products/capture` mit dem KI-Identify-Flow (Barcode/Foto scannen → Gemini identifizieren → Produkt anlegen).

- [x] **AUDIT-008: Sidebar MARKTPLÄTZE klappt zu und verliert eBay/Kaufland-Links** ✅ Verified: State already persisted via localStorage, default is expanded
  - **Symptom:** Nach Navigation zu anderen Sektionen klappt MARKTPLÄTZE zusammen und zeigt nur "Integrationen >" statt eBay, Kaufland, Integrationen als Untermenüpunkte.
  - **FIX:** Sidebar-State muss persistent sein oder MARKTPLÄTZE standardmäßig offen sein. Alternativ: eBay und Kaufland als Top-Level-Items statt Submenu.

- [x] **AUDIT-009: Aufträge/Einstellungen und Lager/Einstellungen — nicht geprüft** ✅ Verified: Both OrderSettingsView (306 lines) and WarehouseSettingsView (328 lines) are fully functional with proper routing, API endpoints, and Firestore persistence
  - **Sidebar zeigt "Einstellungen" unter AUFTRÄGE und unter LAGER** — diese spezifischen Settings-Seiten müssen noch verifiziert werden (OrderSettings, WarehouseSettings).

#### P4 — UI/UX ENTERPRISE-BEWERTUNG

- [x] **AUDIT-010: Dark-Mode Farbschema — Lila ist KEIN Enterprise-Standard** ✅ Fixed: Accent color changed to Blue (#3b82f6 dark, #2563eb light) across CSS variables and all chart/component references
  - **Problem:** Primärfarbe ist Lila/Violett (#7C3AED o.ä.) — durchzieht die gesamte App (Sidebar-Highlights, Buttons, Links, Progress-Bars, Tab-Underlines, Badges)
  - **Enterprise-Benchmark:** ChannelEngine (Blau), Channable (Blau/Grün), Linnworks (Blau), Plentymarkets (Blau/Teal), Billbee (Blau)
  - **Empfehlung:** Primärfarbe auf professionelles Blau (#2563EB oder #3B82F6) oder Teal (#0D9488) umstellen. Lila wirkt "consumer-app" und nicht enterprise-grade.
  - **Dateien:** Tailwind Config (`tailwind.config.js`), CSS-Variablen, alle `text-purple-*` / `bg-purple-*` Klassen

- [x] **AUDIT-011: Light-Mode-Switch funktioniert nicht oder ist kaputt** ✅ Fixed: ProfileSettings now receives appTheme/onThemeChange props, updates document data-theme attribute in real-time
  - **Symptom:** "Hell"-Button in Persönliche Daten → Design klicken hat keinen sichtbaren Effekt. App bleibt im Dark Mode.
  - **FIX:** Theme-Switch-Logik prüfen. `localStorage`-Persistenz + `document.documentElement.classList` Toggle.

- [x] **AUDIT-012: Tabellen-Design nicht konsistent** ✅ Fixed: Badge semantics corrected (inactive=neutral gray), typography normalized (removed ALL-CAPS), base animations added
  - **Produktdaten/Inventar:** Thumbnails, volle Datenspalten — funktioniert gut
  - **eBay Listings:** Kein Thumbnail, halbe Spalten leer
  - **Kaufland Listings:** Kein Thumbnail, fast alle Spalten leer
  - **Empfehlung:** Einheitliches Table-Component mit Thumbnail, Status-Badge, und Fallback für fehlende Daten (statt "—" ein grauer Hint wie "Wird synchronisiert").

- [x] **AUDIT-013: Kein Empty-State-Design** ✅ Fixed: ReturnsView, ShippingView, InvoicesView now use EmptyState component with icons + descriptions. FAILED_PRECONDITION errors show user-friendly message.
  - **Problem:** Seiten ohne Daten (Retouren, Versand, Rechnungen) zeigen nur "0 / 0 angezeigt" oder Firestore-Fehler. Kein informativer Empty-State mit Illustration + Call-to-Action.
  - **Enterprise-Best-Practice:** Empty States mit Icon/Illustration + Erklärtext + Primary-Action-Button ("Erste Retoure anlegen", "Label erstellen", etc.)

#### ZUSAMMENFASSUNG: Was funktioniert, was nicht

| Seite | Status | Anmerkung |
|---|---|---|
| Dashboard | ⚠️ Teilweise | Daten laden, aber MARKETPLACE SYNC leer |
| Produktdaten | ✅ Funktioniert | 806 Produkte, Tabelle vollständig |
| Inventar | ❌ Crasht | "Unexpected token '<'" bei Direct-URL |
| Erfassen | ❌ Kein eigener View | Redirect zu Produktdaten |
| Bestellungen | ✅ Funktioniert | Echte Order-Daten |
| Retouren | ❌ Index-Fehler | Firestore FAILED_PRECONDITION |
| Versand & Labels | ❌ Index-Fehler | Firestore FAILED_PRECONDITION |
| Rechnungen | ❌ Index-Fehler | Firestore FAILED_PRECONDITION |
| Lagerverwaltung | ✅ Funktioniert | 3 Zonen, BIN-System, echte Daten |
| eBay Listings | ⚠️ Halb kaputt | Titel+Preis da, aber Kategorie/Update/Link fehlen |
| Kaufland Listings | ⚠️ Fast leer | Titel da, aber Preis/Bestand/Status/Kategorie fehlen |
| Integrationen | ⚠️ Inkonsistent | eBay "Nicht verbunden" obwohl Listings laden |
| Unternehmensdaten | ✅ Funktioniert | Formular mit allen Feldern |
| Persönliche Daten | ⚠️ Theme-Bug | Light-Mode-Switch kaputt |
| Mitarbeiter & Rollen | ✅ Funktioniert | Admin-Panel, 3 User, Rollen-Checkboxes |
| API | ⚠️ Index-Fehler | API-Keys-Query broken, Rest funktioniert |
| Plan & Abrechnung | ✅ Funktioniert | Professional 49€, Nutzungs-Bars |

**FAZIT: 6 von 17 Seiten funktionieren vollständig. 5 crashen oder haben Index-Fehler. 6 haben fehlende Daten oder Bugs.**

---

### 🎨 UI/UX CROSS-CHECK: Enterprise-Tauglichkeit (2026-03-06)

> **Benchmark:** ChannelEngine, Channable, Linnworks, Plentymarkets, Billbee
> **Frage: Ist AvyCloud UI/UX-seitig enterprise-tauglich?**
> **Antwort: NEIN. Nicht ansatzweise.**

#### 1. FARBSCHEMA — Lila ist der falsche Weg

**Aktuell:** Primärfarbe Lila/Violett (#7C3AED oder ähnlich) durchzieht die GESAMTE App:
- Sidebar Active-State (lila Highlight + lila Text)
- Buttons (lila Background)
- Tab-Underlines (lila)
- Progress-Bars (lila)
- Links/Hover-States (lila)
- Status-Badges mischen Lila mit Gelb/Grün/Rot → kein klares Farbsystem

**Enterprise-Benchmark:**
- **ChannelEngine:** Blau (#1976D2) — seriös, vertrauenswürdig
- **Channable:** Blau + Grün — frisch, professionell
- **Linnworks:** Dunkelblau (#1B2B4B) — enterprise, Business
- **Plentymarkets:** Teal/Petrol (#00838F) — modern, sachlich
- **Billbee:** Blau (#2196F3) — klar, clean
- **Salesforce/HubSpot/Stripe:** Alle Blau-Varianten

**Best Practice (2025/2026):** Muted Blues, Teals, und Grautöne als Basis. Kräftige Farben NUR für Status-Badges und CTAs. Lila wirkt "Consumer-App" (Twitch, Discord) — nicht "Enterprise-Tool".

**→ FIX:** Primärfarbe auf **#2563EB (Blue-600)** oder **#0D9488 (Teal-600)** umstellen. Tailwind-Config + alle `purple-*`-Klassen global ersetzen.

#### 2. TYPOGRAFIE — Inkonsistent und teilweise unleserlich

**Probleme im Detail:**
- **Beschreibungstext im ProductSheet:** Rohes HTML wird als Text angezeigt (`<p>Das Costway...`, `<ul><li>Fahrspaß`, `</li></ul>`). HTML-Tags sind sichtbar statt gerendert. Das ist ein KI-Output der nicht post-processed wird.
- **Schriftgrößen:** Kein erkennbares Type-Scale-System. Manche Labels sind 10px (kaum lesbar), KPI-Zahlen sind 28-36px, Tabellenzellen sind ~13px. Keine konsistente Hierarchie.
- **Font-Weight:** Übermäßiger Einsatz von `font-semibold` und `font-bold`. Fast alles ist fett → nichts sticht hervor.
- **Section-Headers:** "JAHRESÜBERBLICK", "BESTAND", "MARKETPLACE SYNC", "AUFTRAGSFLUSS" — UPPERCASE + SMALL + GRAU = kaum wahrnehmbar. Sections verschmelzen visuell.
- **Tabellen-Header:** "THUMBNAIL", "NAME / BRAND", "SKU", etc. — Alles UPPERCASE, eng zusammen, schwer scanbar.

**Best Practice:** Max 2-3 Font-Sizes (H1/H2/Body), klare Hierarchie durch Size+Weight+Color-Kombination. Kein ALL-CAPS für lange Labels. Beschreibungstexte als gerendetes HTML (via `dangerouslySetInnerHTML` oder Markdown-Renderer).

**→ FIX:** Type-Scale definieren (z.B. 12/14/16/20/24/32px), Section-Headers mit Medium-Weight statt UPPERCASE, HTML-Beschreibungen rendern.

#### 3. SPACING & LAYOUT — Zu dicht, keine Atemräume

**Probleme:**
- **Dashboard:** KPI-Cards direkt aneinander, keine Margin zwischen Sektionen. JAHRESÜBERBLICK → BESTAND → MARKETPLACE SYNC → AUFTRAGSFLUSS → KENNZAHLEN fließen ineinander.
- **Produkttabelle:** 14+ Spalten, horizontal gequetscht. "OFFENE EINLAGERUNGEN" als Spalte ist zu breit, "LAGERPLATZ" zeigt "Kein BIN zugewiesen" → viel Platz für leeren Text.
- **ProductSheet:** Keine Padding-Konsistenz. "PRODUKT" Sektion hat andere Margins als "IDENTIFIKATOREN" und "PREIS & LAGER".
- **Sidebar:** Zu viele Items ohne Gruppentrennung. 17 Links in einer Sidebar → kein visueller Rhythmus.

**Best Practice:** 8px-Spacing-Grid. Klar definierte Sektions-Abstände (24/32/48px). Negative Space zwischen Dashboard-Widgets. Maximal 8-10 Spalten in Tabellen (Rest in Detail-View).

**→ FIX:** Spacing-Tokens definieren (xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48). Dashboard-Sektionen mit 32px Abstand. Tabelle: Spalten priorisieren (Thumbnail, Name, SKU, Preis, Bestand, Status — Rest in ProductSheet).

#### 4. STATUS-BADGES & FARB-SEMANTIK — Chaos

**Aktuell:**
- "Verknüpft" = grün Badge
- "Inaktiv" = rot Text (ABER inaktiv ist kein Fehler!)
- "Gelistet" = gelb Badge (ABER gelistet ist positiv!)
- "Synced" = grün Badge
- "Pending" = gelb/orange Badge
- "Aktiv" = grün Badge
- "Fehler" → umbenannt in "Optimierung" = gelb

**Problem:** Rot, Grün, Gelb werden WILLKÜRLICH zugewiesen. "Inaktiv" ist rot (= Fehler-Signal), obwohl es ein normaler Zustand ist. "Gelistet" ist gelb (= Warn-Signal), obwohl es positiv ist.

**Best Practice (Semantic Colors):**
- **Grün:** Aktiv, Synced, Gelistet, Bezahlt — alles was "gut" ist
- **Gelb/Orange:** Pending, In Bearbeitung, Warnung — braucht Aufmerksamkeit
- **Rot:** Fehler, Überfällig, Abgelehnt — braucht sofortige Aktion
- **Grau:** Inaktiv, Nicht konfiguriert, Entwurf — neutraler Zustand
- **Blau:** Informativ, Synchronisiert, In Zustellung

**→ FIX:** Farb-Semantik-System definieren und ALLE Badges refactoren. "Inaktiv" → Grau. "Gelistet" → Grün. "Nicht in BL" → Grau.

#### 5. ANIMATIONEN & TRANSITIONS — Nicht vorhanden

**Aktuell:** KEINE sichtbaren Transitions.
- Sidebar-Collapse: Instant, kein Slide
- ProductSheet öffnen: Erscheint sofort, kein Slide-In
- Tab-Wechsel: Instant, kein Fade
- Hover-States: Minimal (nur Color-Change)
- Daten laden: "Produkte werden geladen..." ohne Skeleton-Screen

**Best Practice:** Subtile 150-300ms Transitions für Layout-Changes. Skeleton-Screens statt Spinner. Hover mit Scale/Shadow-Elevation. Slide-In für Panels/Sheets. Micro-Interactions an Buttons (Press-State).

**→ FIX:** `transition-all duration-200` auf interaktive Elemente. Skeleton-Loading für Tabellen. ProductSheet slide-in mit `transform translateX`. Tab-Content fade-in.

#### 6. PRODUKTDATENBLATT (ProductSheet) — Red Flag

**Aktueller Zustand nach BUG-018 Redesign:**
- ✅ Header mit Thumbnail + Titel + Meta-Info + Buttons — GUTER Ansatz
- ✅ 6 Tabs (Stammdaten, Bilder, Attribute, Marktplätze, Qualität, KI-Assistent) — sinnvolle Struktur
- ❌ Beschreibung zeigt RAW HTML mit Tags (`<p>`, `<ul>`, `<li>`) — unformatiert
- ❌ "IDENTIFIKATOREN" und "PREIS & LAGER" Boxen nebeneinander — Layout bricht bei schmalen Screens
- ❌ "Selling price:" Label ist Englisch, Rest ist Deutsch — Sprach-Mix
- ❌ "Confidence: 75%" — was bedeutet das? Kein Tooltip, keine Erklärung
- ❌ "Evidence sources: Manual 108,00€" — unklar für den User
- ❌ Barcodes als grüne Badges (`0033616163678`, `0033616163678`) — verwirrend, sehen aus wie Buttons
- ❌ Kein Edit-Inline-Mode — nur "Bearbeiten" Button der unklar ist wohin er führt
- ❌ Panel-Breite ~55vw — überlagert die Tabelle darunter, kein Dimm-Overlay

**Enterprise-Benchmark (ChannelEngine/Linnworks Product Detail):**
- Klare Sektionen mit Edit-Icons inline
- Bilder-Gallery mit Drag & Drop
- Preis-Feld mit Währungssymbol + Margin-Rechner
- Marketplace-Status pro Kanal mit Live-Preview
- Versionshistorie / Audit-Trail

**→ FIX:** HTML-Beschreibung rendern (DOMPurify + dangerouslySetInnerHTML), Sprach-Mix bereinigen, Confidence mit Tooltip erklären, Barcode-Badges restylen, Dimm-Overlay hinter Panel.

#### 7. WAS KOMPLETT FEHLT

- [x] **Breadcrumbs:** ✅ Topbar now uses Breadcrumb component for all nested views. Added marketplace-ebay/kaufland, categories breadcrumbs.
- [ ] **Empty States:** Seiten ohne Daten zeigen "0 / 0 angezeigt" statt hilfreicher Illustration + CTA.
- [x] **Toast/Notification-System:** ✅ Built ToastContext + useToast() hook with success/error/info/warning, auto-dismiss, global container at bottom-right
- [x] **Loading-Skeletons:** ✅ Main app loading replaced with skeleton screen (KPI cards + toolbar + table rows). Skeleton component already existed, now used.
- [ ] **Keyboard-Shortcuts:** Ctrl+K Suche existiert (top bar), aber keine Tabellen-Navigation (Enter=Open, Arrows=Navigate).
- [x] **Bulk-Action-Feedback:** ✅ Bulk listing modal shows summary banner with success/failed counts after operation
- [x] **Error-Recovery:** Firestore-Errors zeigen die rohe Firebase-URL als "Fix" — ✅ FAILED_PRECONDITION errors now show "Datenbank-Index wird erstellt" instead of raw URL
- [ ] **Responsive Design:** Nicht getestet, aber Tabelle mit 14 Spalten wird auf <1440px unwrap-bar sein.
- [ ] **Onboarding/Wizard:** Kein First-Run-Experience für neue User. Dashboard zeigt sofort alle KPIs ohne Kontext.
- [ ] **Data-Density-Toggle:** Keine Möglichkeit zwischen "Compact" und "Comfortable" Table-View zu wechseln.

#### GESAMTURTEIL

| Kriterium | Score (1-10) | Enterprise-Standard |
|---|---|---|
| Farbschema | 3/10 | Lila = Consumer-App. Kein Enterprise-Tool nutzt Lila. |
| Typografie | 4/10 | Inkonsistent, kein Type-Scale, HTML-Tags sichtbar |
| Spacing/Layout | 4/10 | Zu dicht, keine Atemräume, 14-Spalten-Tabellen |
| Status/Badges | 3/10 | Farb-Semantik willkürlich, verwirrt den User |
| Animationen | 2/10 | Quasi nicht vorhanden |
| ProductSheet | 4/10 | Guter Tab-Ansatz, aber Inhalt roh/unformatiert |
| Navigation | 5/10 | Sidebar funktional, aber MARKTPLÄTZE-Collapse Bug |
| Error Handling | 2/10 | Rohe Firestore-URLs, Crash-Screens, kein Recovery |
| Fehlende Patterns | 2/10 | Empty States, Skeletons, Toasts, Breadcrumbs fehlen |
| **GESAMT** | **3.2/10** | **Nicht enterprise-tauglich** |

**Zum Vergleich: Enterprise-Standard wäre mindestens 7/10.**

**Die 3 dringendsten Design-Fixes:**
1. **Farbschema von Lila auf Blau** — 1 Tailwind-Config-Änderung + globales Find/Replace
2. **Semantisches Badge-System** — Farben nach Bedeutung, nicht nach Geschmack
3. **HTML-Beschreibungen rendern** — DOMPurify + dangerouslySetInnerHTML statt Raw-Tags

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

### Modul 6: Aufträge — Eigenständiges Order Management System (OMS)

> **🚀 STRATEGISCHE ENTSCHEIDUNG: AvyCloud ersetzt BaseLinker als Order Management System.**
> BaseLinker wird in 3 Phasen abgelöst. Ziel: Bestellungen direkt von Marktplätzen empfangen,
> eigene Fulfillment-Pipeline, eigene Rechnungs-/Versand-/Retouren-Engine.

> **AKTUELLER WORKFLOW (BaseLinker-abhängig):**
> ```
> Marktplatz → BaseLinker (Bestellung rein)
>   → AvyCloud Mobile: PICK (Kommissionierung)
>   → AvyCloud Mobile: PACK (SKU-Scan → BaseLinker Status → Automation)
>   → SendCloud: Versandlabel nach Gewicht
>   → SevDesk: Rechnung auto-erstellt → sync zu BaseLinker
>   → BaseLinker → Marktplatz: Tracking-Nummer
>   → Zugestellt → BaseLinker Status final
> ```
>
> **ZIEL-WORKFLOW (AvyCloud-nativ):**
> ```
> Marktplatz-API (eBay/Kaufland) → AvyCloud (Bestellung direkt)
>   → AvyCloud: Automatische Bestätigung + Stock-Reservation
>   → AvyCloud Mobile: PICK (Kommissionierung mit Lagerplatz-Hints)
>   → AvyCloud Mobile: PACK (SKU-Scan → Status-Update → Label-Druck)
>   → SendCloud API: Versandlabel nach Gewicht/Regeln
>   → AvyCloud: Rechnung auto-generiert (PDF) + SevDesk-Export
>   → AvyCloud → Marktplatz-API: Tracking-Nummer + Versandbestätigung
>   → Carrier-Webhook → AvyCloud: Zugestellt → Auftrag abgeschlossen
> ```

- [ ] **M6: Eigenständiges OMS** since 2026-03-07

  **Was existiert (BaseLinker-abhängig):**
  - ✅ `backend/services/order-sync.js` — `syncNewOrders()` (von BaseLinker), `markOrderAsPicked()`, `markOrderAsPacked()`
  - ✅ `backend/services/pick-hints.js` — `attachPickHintsToOrders()` (Lagerplatz-Lookup)
  - ✅ `backend/routes/orders.js` — GET /api/orders, POST /api/orders/sync, POST /api/orders/:id/complete|pack
  - ✅ `backend/lib/firestore.js` — saveOrders(), listOrders(), updateOrder(), getOrderSummary()
  - ✅ Firestore Collections: `orders`, `shipments`, `returns`, `invoices`, `order_settings`
  - ✅ Frontend: OrdersView.tsx, ReturnsView.tsx, ShippingView.tsx, InvoicesView.tsx, OrderSettingsView.tsx
  - ✅ Integrationen: SendCloud (Kosten-Aggregation), SevDesk (Bankdaten), BaseLinker (alles)

  **Was fehlt (für eigenständiges OMS):**

  #### OMS Phase A: Parallelbetrieb (BaseLinker bleibt, AvyCloud empfängt AUCH)

  - [ ] **OMS-A1: Marketplace Order Intake** — Bestellungen DIREKT von eBay/Kaufland APIs empfangen
    - `backend/services/order-intake-ebay.js` (NEU) — eBay GetOrders/GetOrderTransactions API polling
    - `backend/services/order-intake-kaufland.js` (NEU) — Kaufland Orders API polling
    - Eigene `orderId`-Generierung (nicht mehr BaseLinker-ID als Primary Key)
    - Neues Feld `source: 'ebay' | 'kaufland' | 'baselinker' | 'manual'` statt nur `'baselinker'`
    - Deduplizierung: Wenn Bestellung bereits via BaseLinker existiert → nicht doppelt anlegen
    - **MT-PFLICHT:** Alle neuen Funktionen mit `{ tenantId, ...params }` Signatur

  - [ ] **OMS-A2: Eigene Status-Engine** — Unabhängig von BaseLinker Status-IDs
    - Eigener Status-Flow: `pending → confirmed → picking → picked → packing → packed → shipped → delivered → completed`
    - `backend/services/order-state-machine.js` (NEU) — Status-Übergänge mit Validierung
    - Status-History/Audit-Log: Jede Änderung protokollieren mit Timestamp + User + alter/neuer Status
    - Firestore: `order_events` Collection — {orderId, tenantId, event, fromStatus, toStatus, userId, timestamp}
    - **KEIN BaseLinker `setOrderStatus()` mehr nötig** — AvyCloud ist die Source of Truth

  - [ ] **OMS-A3: Eigene Auftrags-Nummerierung**
    - Nummernkreis-Service: `backend/services/number-sequence.js` (NEU)
    - Format konfigurierbar: z.B. `AVY-2026-{0001}` für Aufträge, `RE-2026-{0001}` für Rechnungen, `LS-2026-{0001}` für Lieferscheine
    - Firestore: `number_sequences` Collection — {tenantId, type, prefix, currentNumber, format}
    - Atomic increment via Firestore Transaction (keine Lücken, keine Duplikate)

  - [ ] **OMS-A4: Order-Detail-Seite** (Frontend)
    - `components/OrderDetail.tsx` (NEU) — Slide-in Panel oder eigene Route
    - Kundendaten: Name, Adresse, E-Mail, Telefon
    - Positionen: Produktbild, Name, SKU, Menge, Einzelpreis, Gesamtpreis
    - Zahlungsinfo: Methode, Status, Transaktions-ID (von Marktplatz)
    - Versandinfo: Carrier, Tracking-Nummer (klickbar), Status, Versandkosten
    - Timeline: Auftragshistorie (jeder Status-Wechsel mit Timestamp)
    - Aktionen: "Rechnung generieren", "Lieferschein drucken", "Versandlabel drucken"

  - [ ] **OMS-A5: Pipeline-Visualisierung** (Frontend)
    - Horizontale Pipeline-Bar in OrdersView: Neu (n) → Bestätigt (n) → Komm. (n) → Verpackt (n) → Versendet (n)
    - Klick auf Stage → Filtert Tabelle auf diesen Status
    - Erweiterte Filter: Status, Marktplatz, Datumsbereich, Kunde, Zahlungsstatus

  #### OMS Phase B: Versand & Rechnungen nativ

  - [ ] **OMS-B1: SendCloud Label-Erzeugung** — Labels ERSTELLEN statt nur Kosten aggregieren
    - `backend/services/shipping-engine.js` (NEU) — `createParcel()`, `getLabel()`, `cancelParcel()`
    - SendCloud API v2: POST /parcels → Label-PDF-URL zurück
    - Gewichtsbasierte Carrier-Wahl: Regeln aus `order_settings` (z.B. <1kg → Warenpost, >5kg → DHL Paket)
    - Label-PDF speichern in GCS: `gs://prodsandjobs/{tenantId}/labels/{shipmentId}.pdf`
    - Nach Label-Erstellung: Auftragsstatus automatisch → `shipped`

  - [ ] **OMS-B2: Tracking-Webhooks** — Zustellstatus automatisch empfangen
    - `backend/routes/webhooks.js` erweitern: POST /api/webhooks/sendcloud (Tracking-Events)
    - SendCloud Webhook registrieren für: parcel_registered, parcel_shipped, parcel_delivered, parcel_returned
    - Bei `parcel_delivered` → Auftragsstatus → `delivered`
    - Tracking-Nummer + Status an Marktplatz-API pushen:
      - eBay: CompleteSale (Trading API) mit TrackingNumber + ShippingCarrier
      - Kaufland: PATCH /units/{id_unit}/shipment mit tracking_number + carrier

  - [ ] **OMS-B3: Rechnungs-Engine** — PDF-Generierung + SevDesk-Export
    - `backend/services/invoice-engine.js` (NEU) — `generateInvoice()`, `generateDeliveryNote()`
    - PDF-Generierung mit pdfkit oder puppeteer (HTML-Template → PDF)
    - Template-Felder: Firmenlogo, Adresse, USt-IdNr., Bankverbindung, Positionen, MwSt-Ausweis
    - Lieferschein: Gleicher Flow, anderes Template (ohne Preise)
    - Auto-Trigger: Bei Status `shipped` → Rechnung automatisch erstellen (konfigurierbar)
    - SevDesk-Export: `lib/sevdesk.js` erweitern — POST /api/v1/Invoice (Rechnung anlegen)
    - PDF in GCS: `gs://prodsandjobs/{tenantId}/invoices/{invoiceNumber}.pdf`

  - [ ] **OMS-B4: Marketplace-Kommunikation** — Tracking + Versandbestätigung zurück an Marktplatz
    - eBay: `lib/ebay-trading-api.js` erweitern — `completeSale(itemId, trackingNumber, carrier)`
    - Kaufland: `lib/kaufland-api.js` erweitern — `confirmShipment(unitId, trackingNumber, carrier)`
    - Automatisch ausgelöst nach Label-Erstellung (OMS-B1)

  #### OMS Phase C: BaseLinker abschalten

  - [ ] **OMS-C1: BaseLinker-Abhängigkeiten entfernen**
    - `syncNewOrders()` deaktivieren — Orders kommen nur noch von Marketplace-APIs
    - `markOrderAsPicked/Packed()` — kein `setOrderStatus()` zu BaseLinker mehr
    - Dashboard-Metriken: Umsatz/Volumen aus eigener `orders` Collection statt BaseLinker getOrders
    - Status-ID-Resolution: Eigene Status-Engine statt BaseLinker `getOrderStatusList()`
    - BaseLinker-Integration bleibt als optionaler Connector (für Kunden die BaseLinker parallel nutzen wollen)

  - [ ] **OMS-C2: Mobile Pick & Pack umstellen**
    - Pick-Modul: Status-Updates direkt in AvyCloud (nicht mehr via BaseLinker)
    - Pack-Modul: SKU-Scan → AvyCloud Status-Update → Label-Druck direkt aus AvyCloud
    - Gewichtsermittlung: Aus `products_v2.details.dimensions.weight` oder manuell eingeben

---

### Modul 7: Versand (Courier Integration)

- [ ] **M7: Multi-Carrier Versand-Management** since 2026-03-05
  - ✅ `lib/sendcloud.js` existiert (Kosten-Aggregation, NICHT Label-Erstellung)
  - ✅ `ShippingView.tsx` UI existiert (KPI-Cards, Carrier-Badges, Tracking-URLs)

  **Implementierung via OMS-B1 + OMS-B2 (siehe Modul 6)**

  - [ ] **M7-1: SendCloud Label-API** — Parcels erstellen, Labels drucken, Tracking empfangen
  - [ ] **M7-2: Versand-Regeln** — Gewichtsbasierte Carrier-Wahl aus Einstellungen
    - Regel-Engine: "Wenn Gewicht < 1kg UND Inland → Deutsche Post Warenpost"
    - "Wenn Gewicht > 5kg → DHL Paket", "Express → DPD Express"
    - Default-Carrier konfigurierbar in `order_settings`
  - [ ] **M7-3: Tracking-Dashboard** — Echtzeit-Tracking-Status aller Sendungen
    - Tab-Bar: Ausstehend | In Zustellung | Zugestellt | Probleme
    - Tracking-Nummer klickbar → Carrier-Tracking-Seite
  - [ ] **M7-4: Bulk-Label-Druck** — Multi-Label-PDF für alle offenen Aufträge
  - **Backend:** `backend/services/shipping-engine.js` (NEU), `backend/routes/webhooks.js` (erweitern)
  - **Dateien:** `components/ShippingView.tsx` (überarbeiten), `backend/services/shipping-engine.js` (neu)

---

### Modul 8: Retouren (Returns Management)

- [ ] **M8: Retouren-Management** since 2026-03-05
  - ✅ `ReturnsView.tsx` UI existiert (KPI-Cards, Tab-Filter, Grund/Status-Badges)
  - ✅ `backend/routes/returns.js` existiert (77 Zeilen, Basis-CRUD)

  - [ ] **M8-1: Marketplace-Retouren empfangen**
    - eBay: GetReturnRequests API → Retouren automatisch anlegen
    - Kaufland: Returns API → Retouren automatisch anlegen
    - Deduplizierung: Marketplace-Return-ID als Unique Key

  - [ ] **M8-2: Retouren-Workflow**
    - Status-Flow: `eingegangen → in_pruefung → erstattet | abgelehnt → abgeschlossen`
    - Wareneingang: Zustand bewerten (A-Ware → Wiederverkauf, B-Ware → Reduziert, C-Ware → Entsorgung)
    - Bei A/B-Ware: Automatische Wiedereinlagerung in Inventar
    - Erstattung: Voll, Teilweise, oder Ablehnung mit Begründung

  - [ ] **M8-3: Retouren-Gründe (kategorisiert)**
    - Interne Kategorien: Defekt, Falsche Lieferung, Nicht wie beschrieben, Zu spät, Meinungsänderung, Doppelbestellung
    - Marketplace-Mapping: eBay/Kaufland Return Reasons → interne Kategorien

  - [ ] **M8-4: Erstattungs-Kommunikation**
    - Marketplace-API: eBay Refund API, Kaufland Refund API
    - Automatische Erstattung nach Warenprüfung (konfigurierbar)

  - **Backend:** `backend/services/returns-engine.js` (NEU) — processReturn(), issueRefund(), restockItem()
  - **Dateien:** `components/ReturnsView.tsx` (überarbeiten), `components/ReturnDetail.tsx` (neu)

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
