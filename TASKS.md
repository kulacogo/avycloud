# TASKS.md — AvyCloud Roadmap & Task-Management

> **Letzte Aktualisierung:** 2026-03-11
> **Verantwortlich:** Oguzhan (Owner), Claude Code (Backend/Tests), Claude Cowork (Planung/Doku)

---

## Konventionen & Regeln

> **⚠️ JEDER der an AvyCloud arbeitet (Oguzhan, Claude Code, Claude Cowork) MUSS diese Regeln einhalten.**

### Task-Status
| Symbol | Bedeutung |
|--------|-----------|
| `- [ ]` | Offen — noch nicht begonnen |
| `- [~]` | In Arbeit — aktiv in Bearbeitung |
| `- [x]` | Erledigt — abgeschlossen und verifiziert |
| `⏳`    | Blockiert — wartet auf Abhängigkeit |

### Prioritäten
| Label | Bedeutung | SLA |
|-------|-----------|-----|
| **P0** | Blocker — Production-kritisch oder Launch-kritisch | Sofort |
| **P1** | Wichtig — nächster Sprint | Diese Woche |
| **P2** | Normal — geplant | Diesen Monat |
| **P3** | Nice-to-have — Backlog | Irgendwann |

### Arbeitsregeln
1. **Vor jeder Session:** CLAUDE.md lesen → TASKS.md lesen → offene Tasks abarbeiten
2. **Kein Task ohne Eintrag hier.** Wird etwas gemacht, steht es hier.
3. **Kein Freestyle.** Die Roadmap gibt die Reihenfolge vor. Abweichungen nur mit Oguzhan's OK.
4. **Nach Abschluss:** Task abhaken, Datum ergänzen, ggf. Folge-Tasks anlegen
5. **Keine separaten Sprint-Dateien.** Alles steht hier.
6. **Multi-Tenancy-Pflicht:** Alle neuen Collections/Services/Endpoints mit `tenantId` Parameter

### Multi-Tenancy Kompatibilität (PFLICHT für jeden neuen Code)
```
✅ saveProductV2({ tenantId, ...data })
✅ db.collection('products_v2').where('tenantId', '==', tenantId)
✅ Firestore Doc-IDs: tenantId als Feld ODER als Collection-Prefix
✅ GCS-Pfade: gs://prodsandjobs/{tenantId}/...
❌ Globale Queries ohne tenantId-Filter
❌ Hardcodierte 'default' tenantId (außer als Fallback)
```

---

## Projekt-Status Übersicht

### Was ist LIVE & funktioniert (Phase 1–3 abgeschlossen)

| Bereich | Status | Details |
|---------|--------|---------|
| **Security** | ✅ | Helmet.js, Rate-Limiting, .env bereinigt |
| **Datenbank** | ✅ | products_v2 live, Normalisierung, LLM-Policy + Rulebook |
| **Infrastruktur** | ✅ | Pino Logging, Health-Check, Graceful Shutdown, AppError |
| **Code-Qualität** | ✅ | 7 Router-Module, API Versioning, 129 Vitest-Tests |
| **KI-Pipeline** | ✅ | Identify (Vision+Barcode+Web+LLM), Improve, Quality-Check |
| **Pricing** | ✅ | Engine backend-only, Competitor Intelligence |
| **Inventory** | ✅ | Forecast, salesVelocity, Reorder-Alerts |
| **Dedup** | ✅ | EAN/MPN/Brand Erkennung + Merge |
| **Webhooks** | ✅ | HMAC-SHA256, dispatchWebhook() |
| **eBay** | ✅ | OAuth, Trading API, Listings, Gap-Analyse, Publish |
| **Kaufland** | ✅ | HMAC Auth, Listings, SKU-Index, Category-Mapping |
| **BaseLinker** | ✅ | Token Auth, Order-Sync, Stock-Sync, Inventory-Sync |
| **SendCloud** | ✅ | Basic Auth, Kosten-Aggregation |
| **SevDesk** | ✅ | Token Auth, Bankdaten |
| **Stock-Sync** | ✅ | Reservation, Multi-Channel Push (eBay+Kaufland), Preis-Push |
| **UI Components** | ✅ | 17 Base-Components (ui/), Sidebar, Topbar, Routing |
| **Versand** | ✅ | Shipping Engine, Carrier-Regeln, Bulk-Label, Tracking |
| **Retouren** | ✅ | Returns Engine, Marketplace-Sync, Workflow, Erstattung |
| **Erfassen (M13)** | ✅ | KI-Stepper-Flow komplett |
| **Accessibility** | ✅ | WCAG 2.1 AA, Keyboard-Nav |

### Was OFFEN ist (aktive Arbeit)

| Modul | Status | Blocker |
|-------|--------|---------|
| **M3: Produkte** | ⚡ Teilweise | Filter-System, ProductSheet komplett neu |
| **M4: Bestand** | 🔴 Placeholder | View muss implementiert werden |
| **M5: Marktplatz-Views** | ✅ Real | FAKE→REAL bestätigt (alle API-Calls echt) |
| **M6: OMS** | 🔴 Geplant | Eigenständiges Order Management |
| **M9: Integrations-Hub** | 🔴 Kein Self-Service | Wizard + Auth-Flows fehlen komplett |
| **M10: Analytics** | 🔴 Geplant | Dashboard-Überarbeitung + Reports |
| **M11: Einstellungen** | ✅ Real | FAKE→REAL bestätigt (Company, Profile, Order, Warehouse, API) |
| **M12: Lagerverwaltung** | ⚡ Settings fertig | Zonen/Bins/Inventur fehlen |
| **M14: Pack & Ship** | 🔴 Geplant | SKU-Scan → Auto-Label-Print, Drucker-Voreinstellungen |
| **M-AUTO: Automatisierung** | 🔴 Geplant | Bulk-Import, Repricing-UI |
| **FAKE→REAL** | ⚡ 8/12 done | 4 verbleibend: Shipping, Invoices, Returns, Billing |
| **Universal Taxonomy** | 🔴 Geplant | Marktplatz-Kategorien für neue Integrationen |

---

## Roadmap — Wochen-Plan

> **Prinzip:** Erst stabilisieren (FAKE→REAL), dann ausbauen (neue Features), dann skalieren (Integrationen).

### Phase A: Foundation & Stabilisierung (KW 11–14)

#### KW 11 (10.–14. März 2026) — FAKE→REAL + Bug-Fixes
- [x] **FAKE→REAL: MarketplaceListingsView** — Bereits 100% real, keine Mock-Daten gefunden
- [x] **FAKE→REAL: IntegrationsHub** — Bereits 100% real (Firestore + Secret Manager Status-Checks)
- [x] **FAKE→REAL: CompanySettings** — Bereits 100% real (GET/PUT /api/settings/company → Firestore)
- [x] **FAKE→REAL: ProfileSettings** — Bereits 100% real (GET/PUT /api/settings/profile → Firestore)
- [x] **FAKE→REAL: OrderSettings** — Bereits 100% real (GET/PUT /api/orders/settings → Firestore, Smart-Defaults)
- [x] **FAKE→REAL: WarehouseSettings** — Bereits real, hardcodiertes Inventur-Datum + nonfunktionaler Button entfernt
- [x] **BUG: "Demnächst verfügbar" global entfernen** — Codebase bereits clean, keine MOCK_*/setTimeout-Fakes/Coming-Soon gefunden
- [x] **BUG: eBay Preis-Push** — ✅ Fixed (BUG-020, property path mismatch)
- [x] **BUG-027: eBay-Filter falsche Ergebnisse** — Filter-Logik an Badge-Logik angeglichen (SKU-Index-Priorität)
- [x] **BUG-028: Inkonsistente Lager/Marktplatz-Mengen** — Retry-Mechanismus, Stock-Sync nach Pack/Ship, Listing-Sync 3 Min + Auto-Heal
- [x] **Aufträge Bulk-Status-Change** — Backend POST /api/orders/bulk-transition + Frontend Checkboxen + Bulk-Action-Bar
- [x] **BRAND: Sidebar-Logo ersetzen** — Logo-Icon immer sichtbar, Expanded: Icon + Theme-Wordmark (dark/light), CSS-Toggle via `.logo-dark`/`.logo-light`

#### KW 12 (17.–21. März 2026) — FAKE→REAL Part 2 + M3
- [ ] **FAKE→REAL: ShippingView** — Echte Versanddaten aus shipments Collection
- [ ] **FAKE→REAL: InvoicesView** — Echte Rechnungen + PDF-Generierung
- [ ] **FAKE→REAL: ReturnsView** — Echte Retouren-Daten
- [ ] **FAKE→REAL: BillingSettings** — Echte Usage-Stats
- [ ] **M3: Produkte-View** — Filter-System neu, Kategorien-Management
- [ ] **M3: ProductSheet** — 6-Tab Detail-Panel komplett neu

#### KW 13 (24.–28. März 2026) — M4 + M5 + M12
- [ ] **M4: Bestand-View** — Lager-fokussierte Inventar-Ansicht
- [ ] **M5: Marktplatz-Views** — eBay + Kaufland echte Listings, Realtime-Sync
- [ ] **M12: Lagerverwaltung** — Zonen, Bins, Inventur, Bewegungen

#### KW 14 (31. März – 4. April 2026) — M6 OMS Phase A + M14 Pack & Ship
- [ ] **M6-A1: Marketplace Order Intake** — Bestellungen direkt von eBay/Kaufland
- [ ] **M6-A2: Eigene Status-Engine** — Unabhängig von BaseLinker
- [ ] **M6-A3: Eigene Auftrags-Nummerierung** — Konfigurierbare Nummernkreise
- [ ] **M6-A4: Order-Detail-Seite** — Komplettes Order-Detail-Panel
- [ ] **M14-P1: Drucker & Label-Format Voreinstellungen** — User-Settings für Drucker, Format, Auto-Print
- [ ] **M14-P2: PackStation** — SKU-Scan Interface, Scan-Fortschritt, Item-Validierung
- [ ] **M14-P3: Auto-Print Flow** — Scan komplett → Auto-Ship → Auto-Label-Print
- [ ] **M10: Dashboard** — Revenue, Orders, Inventory KPIs, Charts

### Phase B: Integrationen & Skalierung (KW 15–20)

#### KW 15–16 (7.–18. April 2026) — M9 Integration-Wizard + Taxonomy
- [ ] **M9: Integration-Wizard** — OAuth-Flow (Pattern A), API-Key-Input (Pattern B), Export (Pattern C)
- [ ] **M9: Integration-Settings** — Pro-Integration Konfiguration, Sync, Fehler-Log
- [ ] **M9: Backend integration-registry.js** — Provider-Konfiguration für alle Integrationen
- [ ] **M9: Backend integration-store.js** — Verschlüsselte Credential-Verwaltung
- [ ] **Taxonomy: taxonomy-loader.js** — Universeller CSV/JSON Loader
- [ ] **Taxonomy: category-matcher.js** — 4-Tier Resolution Engine

#### KW 17–18 (21. April – 2. Mai 2026) — OMS Phase B + Neue Integrationen
- [ ] **M6-B1: SendCloud Label-Erzeugung** — Labels erstellen, nicht nur Kosten
- [ ] **M6-B2: Tracking-Webhooks** — Zustellstatus automatisch
- [ ] **M6-B3: Rechnungs-Engine** — PDF-Generierung + SevDesk-Export
- [ ] **M6-B4: Marketplace-Kommunikation** — Tracking zurück an eBay/Kaufland
- [ ] **INT: Amazon SP-API** — OAuth + Produkte + Orders (Tier 2)
- [ ] **INT: Shopify** — OAuth + Produkte + Orders (Tier 2)

#### KW 19–20 (5.–16. Mai 2026) — Weitere Integrationen + Polish
- [ ] **INT: OTTO Market** — Client Credentials + Produkte (Tier 2)
- [ ] **INT: WooCommerce** — API-Keys + Produkte + Orders (Tier 2)
- [ ] **INT: lexoffice** — OAuth + Rechnungen (Tier 2)
- [ ] **M-AUTO: Bulk-Import/Export** — CSV/Excel
- [ ] **M-AUTO: Repricing-UI** — Dashboard + Regel-Editor
- [ ] **M11: Einstellungen** — Backend komplett real

### Phase C: Launch-Vorbereitung (KW 21–24)

#### KW 21–22 — Multi-Tenancy + Billing
- [ ] **Multi-Tenancy** — Tenant-Modell, Auth-Middleware, Migration
- [ ] **Stripe Billing** — Subscription-Management, Plans, Invoices

#### KW 23–24 — Polish, Testing, Launch
- [ ] **M6-C: BaseLinker abschalten** — Optional, nicht mehr Default
- [ ] **E2E-Tests** — Playwright für kritische Flows
- [ ] **Monitoring** — Sentry, Uptime, Job-Health
- [ ] **GDPR** — Data Export, Deletion, Privacy Policy
- [ ] **API-Dokumentation** — OpenAPI/Swagger

---

## Offene Module — Detail

### M3: Produkte (Katalog) — ⚡ Teilweise implementiert

**Was existiert:** ProductsPageHeader, AdminTable (18 Spaltentypen, 4 Presets, Filter, Bulk-Actions, Pagination)

**Offen:**
- [ ] Filter-System komplett neu (Chip-Leiste, gespeicherte Presets)
- [ ] Kategorien-Management (Kategorie-Baum, Filter-Dimension, Marketplace-Mapping)
- [ ] ProductSheet komplett neu (6 Tabs: Übersicht, Bilder, Preise, Attribute, Marktplätze, Aktivität)
- [ ] Bulk-Actions erweitern (Preis, Kategorie, eBay/Kaufland listen)
- [ ] Migration bestehender HTML-Tags auf ui/* Components (Button, Input, Select, Badge, Modal, Tabs)
- [ ] Typography-Scale durchsetzen

### M4: Bestand (Inventar) — 🔴 Placeholder

**Was existiert:** Route `#/products/inventory` aktiv, Placeholder-View

**Offen:**
- [ ] KPI-Cards (Gesamtartikel, Einheiten, Bestandswert, Niedrig-Bestand)
- [ ] Tabelle (Thumbnail, Name, SKU, Bin, Menge, Zustand, EK, Bestandswert, Marketplace-Icons)
- [ ] Filter (Zone, Bin, Menge-Range, Zustand, Marketplace-Status)
- [ ] Quick-Filters (Niedrig-Bestand, Kein Lagerplatz, 30 Tage unbewegt)
- [ ] Bulk-Actions (Umlagern, Inventur, Export)

### M5: Marktplatz-Views — ⚡ UI fertig

**Was existiert:** MarketplaceListingsView.tsx (generisch), Routes, KPIs, Tabs, Tabelle, Bulk-Actions

**Offen:**
- [ ] FAKE→REAL: Echte API-Calls statt Mock-Daten
- [ ] Realtime-Sync (Bestand + Preis + Status eBay ↔ AvyCloud ↔ Kaufland)
- [ ] Gap-Analyse integriert in Listing-View (expandable Row)
- [ ] EbayListingsView.tsx LÖSCHEN (alte Gap-Analysis)
- [ ] Generisches Pattern: Neue Marktplätze per Config, nicht per Component

### M6: Order Management System (OMS) — 🔴 Geplant

> **Strategisch:** AvyCloud ersetzt BaseLinker als OMS. 3 Phasen: Parallelbetrieb → Nativ → BaseLinker optional.

**Phase A: Parallelbetrieb**
- [ ] A1: Marketplace Order Intake (eBay GetOrders + Kaufland GET /orders)
- [ ] A2: Eigene Status-Engine (pending → confirmed → picking → packed → shipped → delivered)
- [ ] A3: Eigene Auftrags-Nummerierung (AVY-2026-{0001})
- [ ] A4: Order-Detail-Seite (Kunden, Positionen, Zahlung, Versand, Timeline)
- [ ] A5: Pipeline-Visualisierung (Horizontale Status-Bar)

**Phase B: Versand & Rechnungen nativ**
- [ ] B1: SendCloud Label-Erzeugung (createParcel, getLabel, cancelParcel)
- [ ] B2: Tracking-Webhooks (parcel_shipped, parcel_delivered)
- [ ] B3: Rechnungs-Engine (PDF + SevDesk-Export)
- [ ] B4: Marketplace-Kommunikation (Tracking an eBay/Kaufland)

**Phase C: BaseLinker abschalten**
- [ ] C1: BaseLinker-Abhängigkeiten entfernen
- [ ] C2: Mobile Pick & Pack umstellen

### M9: Integrations-Hub — 🔴 Kein Self-Service

> **KRITISCH für SaaS:** Ohne Self-Service-Setup kann kein neuer Kunde AvyCloud nutzen.

**Was existiert:** IntegrationsHub.tsx (6 Karten), GET /api/integrations/status

**Offen:**
- [ ] Integration-Wizard (3 Varianten: OAuth, API-Key, Export)
- [ ] Integration-Settings (Sync-Intervall, Was syncen, Fehler-Log, Disconnect)
- [ ] Backend: integration-registry.js (Provider-Config)
- [ ] Backend: integration-store.js (Verschlüsselte Credentials, AES-256-GCM)
- [ ] Backend: routes/integrations.js (CRUD + OAuth Callback)
- [ ] Migration: Bestehende API-Clients mit Firestore-Fallback auf ENV

### M10: Analytics & Reporting — 🔴 Geplant

**Was existiert:** Dashboard funktional (Revenue KPIs, Orders, Shipping-Kosten)

**Offen:**
- [ ] Dashboard neu: Revenue/Order/Inventory KPIs mit Trends, Charts, Aktivitäts-Feed
- [ ] Reporting-Seite: Umsatz, Bestand, Margen, Bestseller, Retouren
- [ ] Export: CSV, Excel, PDF
- [ ] Backend: routes/reports.js, services/analytics.js

### M11: Einstellungen — ⚡ UI fertig

**Was existiert:** Alle Settings-Views + Routes + Sidebar-Gruppe

**Offen:**
- [ ] Backend FAKE→REAL: Firestore CRUD für Company, Profile, Team, Billing
- [ ] Team-Management: Einladung, Rollen-Editor, Berechtigungen
- [ ] Billing: Stripe-Integration (Waiting On)

### M12: Lagerverwaltung — ⚡ Settings fertig

**Was existiert:** WarehouseSettingsView.tsx, Routes

**Offen:**
- [ ] Warehouse-View: Zonen-Tab, Bins-Tab, Inventur-Tab, Bewegungen-Tab
- [ ] Backend: CRUD für Zonen, Bins, Inventur, Bewegungen
- [ ] Firestore: warehouse_zones, warehouse_bins, warehouse_movements, warehouse_inventories

### M14: Pack & Ship — ⚡ Pack existiert, Auto-Print fehlt

> **Ziel:** Versandlabel wird automatisch gedruckt sobald SKU im Pack-Modul gescannt wird. Drucker und Label-Format pro User vordefinierbar.

**Was BEREITS existiert (umfangreich):**
- `MobileOperationsView.tsx` — Vollständige Pack-UI mit `operations-pack` Mode
- `ScannerOverlay.tsx` — Kamera-basierter Barcode-Scanner (QR, EAN-13, CODE-128, CODE-39, UPC-A, AZTEC, DATA-MATRIX)
- SKU-Scan → Item in Bestellung finden → Feedback (Erfolg/Nicht gefunden/Mehrdeutig)
- "Verpackt" Button → `packOrder()` → Status-Transition nach "packed"
- `packAndShip()` in api/client.ts — Pack + Label-Generierung kombiniert
- Backend: `POST /api/orders/:id/pack` mit `orders.pack` Permission
- `order-source-router.js:packOrder()` → `order-sync.js:markOrderAsPacked()` → State-Machine
- State-Machine: picking → picked → packing → packed → shipped (Zeile 47-49)
- `GET /api/orders/:id/label` — Label-PDF Proxy zu SendCloud
- OrderDetail.tsx "Label drucken" → `window.open(blobUrl)` → `printWindow.print()`
- Carrier-Regeln nach Gewicht in `order_settings.carrierRules`
- i18n komplett (DE/EN/TR) für Pack-Modus
- RBAC: `orders.pack` Permission

**Was FEHLT:**

**Erweiterung 1: Auto-Print nach Pack-Scan**
- [ ] **MobileOperationsView.tsx → Pack-Flow erweitern:** Nach erfolgreichem "Verpackt" (packOrder) automatisch `shipOrder()` aufrufen → Label-PDF holen → Print-Dialog öffnen. Aktuell muss der User manuell in die Auftragsmaske wechseln und dort "Label drucken" klicken.
- [ ] **`packAndShip()` nutzen:** Die Funktion existiert bereits in api/client.ts — sie muss im MobileOperationsView Pack-Modus aufgerufen werden statt nur `packOrder()`. Nach Erfolg: Label-PDF automatisch an Drucker senden.
- [ ] **Fehler-Handling:** Wenn Label-Erstellung fehlschlägt → klare Fehlermeldung im Pack-Interface, Bestellung bleibt auf "packed" (KEIN "shipped" ohne bestätigtes Label).

**Erweiterung 2: Drucker & Label-Format Voreinstellungen pro User**
- [ ] **Firestore: `user_profiles` erweitern** — Neue Felder: `printing.labelFormat` ('thermal_10x15' | 'a4' | 'a6'), `printing.autoPrint` (boolean)
- [ ] **Backend: `PUT /api/settings/profile`** erweitern — `printing` Objekt akzeptieren und validieren
- [ ] **Frontend: ProfileSettings erweitern** — Sektion "Druckeinstellungen": Label-Format Dropdown (10x15 Thermodruck, A4, A6), Auto-Print Toggle
- [ ] **SendCloud Label-Format durchreichen** — `label_printer` (10x15 thermal) vs. `normal_printer` (A4). Format aus User-Setting an `downloadLabelPdf()` übergeben. Aktuell hardcoded auf `label_printer`.

**Betroffene Dateien:**

| Datei | Änderung |
|-------|----------|
| `components/MobileOperationsView.tsx` → Pack-Modus | Nach `packOrder()` automatisch `packAndShip()` oder `shipOrder()` + `fetchLabelPdfBlob()` + Print aufrufen |
| `api/client.ts` → `packAndShip()` | Prüfen ob Label-Format Parameter durchgereicht werden kann |
| `backend/routes/settings.js` → `PUT /api/settings/profile` | `printing` Objekt akzeptieren |
| `backend/services/shipping-engine.js` → `downloadLabelPdf()` | Label-Format-Parameter (thermal vs. A4) |
| `components/orders/ProfileSettings.tsx` | Druckeinstellungen UI-Sektion |

**Abhängigkeiten:**
- BUG-025 muss zuerst gefixt sein (Carrier-Zuordnung nach Gewicht)
- BUG-026 muss zuerst gefixt sein (Timestamps erst nach bestätigter Aktion)

### M-AUTO: Automatisierung & Bulk — 🔴 Geplant

**Was existiert:** Pricing Engine (backend-only), AdminTable Bulk-Actions

**Offen:**
- [ ] Bulk-Import: CSV/Excel Upload mit Preview
- [ ] Bulk-Export: Konfigurierbare Spalten
- [ ] Repricing-UI: Dashboard, Regel-Editor, Mindestmarge
- [ ] Workflow-Builder (Phase 2 nach Launch)

### Universal Taxonomy Engine — 🔴 Geplant

> **Siehe:** `Marketplace_Taxonomy_Masterplan.html` für Details

**Was existiert:** Kaufland (CSV, 50k Kategorien), eBay (JSON, 20k Kategorien), MarketplaceLookup, 3-4 Tier Fallback

**Offen:**
- [ ] taxonomy-loader.js — Universeller CSV/JSON Loader → TaxonomyIndex
- [ ] category-matcher.js — 4-Tier Resolution mit LRU Cache
- [ ] attribute-mapper.js — Feld-Mapping pro Marktplatz
- [ ] shop-taxonomy-sync.js — Dynamisches Fetching (WooCommerce, Shopware)
- [ ] Fetch-Scripts: Amazon, Otto, Etsy, Shopify (siehe Masterplan)
- [ ] taxonomy-refresh.js — Periodisches Update

---

## Integration-Platzhalter

> **Jede geplante Integration ist hier gelistet mit Auth-Typ, Priorität und Status.**
> **Nichts darf vergessen werden. Neue Integrationen werden hier ergänzt.**

### Marktplätze

| # | Integration | Auth-Typ | Tier | Status | Dateien |
|---|-------------|----------|------|--------|---------|
| 1 | **eBay** | OAuth 2.0 | ✅ Live | Backend + Frontend komplett | `lib/ebay-*.js` |
| 2 | **Kaufland** | HMAC-SHA256 (API-Key) | ✅ Live | Backend + Frontend komplett | `lib/kaufland-*.js` |
| 3 | **Amazon SP-API** | OAuth 2.0 (LWA) | P1 Tier 2 | 🔴 Nicht begonnen | `lib/amazon-api.js` (neu) |
| 4 | **OTTO Market** | OAuth 2.0 (Client Credentials) | P1 Tier 2 | 🔴 Nicht begonnen | `lib/otto-api.js` (neu) |
| 5 | **Etsy** | OAuth 2.0 + PKCE | P1 Tier 2 | 🔴 Nicht begonnen | `lib/etsy-api.js` (neu) |
| 6 | **Zalando ZFS** | Portal-basiert | P3 | ❌ Kein Self-Service API | — |
| 7 | **About You** | TBD | P3 | 🔴 Nicht begonnen | — |
| 8 | **Hood.de** | Basic Auth (API Password) | P3 Tier 3 | 🔴 Nicht begonnen | — |
| 9 | **Kleinanzeigen** | — | ❌ | Kein offizielles API | — |
| 10 | **Cdiscount** | TBD | P3 Phase 3 | 🔴 Nicht begonnen | — |
| 11 | **Allegro** | OAuth 2.0 | P3 Phase 3 | 🔴 Nicht begonnen | — |

### Shops / Webshops

| # | Integration | Auth-Typ | Tier | Status | Dateien |
|---|-------------|----------|------|--------|---------|
| 1 | **Shopify** | OAuth 2.0 | P1 Tier 2 | 🔴 Nicht begonnen | `lib/shopify-api.js` (neu) |
| 2 | **WooCommerce** | API-Keys (Consumer Key/Secret) | P1 Tier 2 | 🔴 Nicht begonnen | `lib/woocommerce-api.js` (neu) |
| 3 | **Shopware 6** | OAuth 2.0 (Client Credentials) | P2 | 🔴 Nicht begonnen | `lib/shopware-api.js` (neu) |
| 4 | **PrestaShop** | API-Key (32 Zeichen) | P2 | 🔴 Nicht begonnen | `lib/prestashop-api.js` (neu) |
| 5 | **Magento/Adobe Commerce** | OAuth 1.0a oder Token | P3 | 🔴 Nicht begonnen | — |
| 6 | **Wix** | OAuth 2.0 | P3 Phase 2 | 🔴 Nicht begonnen | — |
| 7 | **Squarespace** | OAuth 2.0 | P3 Phase 2 | 🔴 Nicht begonnen | — |
| 8 | **Gambio** | REST API Key | P3 Phase 2 | 🔴 Nicht begonnen | — |
| 9 | **JTL-Shop** | REST API | P3 Phase 2 | 🔴 Nicht begonnen | — |
| 10 | **Ecwid** | OAuth 2.0 | P3 Phase 3 | 🔴 Nicht begonnen | — |
| 11 | **BigCommerce** | OAuth 2.0 | P3 Phase 3 | 🔴 Nicht begonnen | — |

### Aggregatoren / Middleware

| # | Integration | Auth-Typ | Tier | Status | Dateien |
|---|-------------|----------|------|--------|---------|
| 1 | **BaseLinker** | API Token | ✅ Live | Backend komplett, wird langfristig optional | `lib/baselinker-*.js` |
| 2 | **BigBuy** | API Key | P3 Phase 3 | 🔴 Nicht begonnen | — |
| 3 | **Vidaxl** | API Key | P3 Phase 3 | 🔴 Nicht begonnen | — |

### Versand / Courier

| # | Integration | Auth-Typ | Tier | Status | Dateien |
|---|-------------|----------|------|--------|---------|
| 1 | **SendCloud** | Basic Auth (Public+Secret Key) | ✅ Live | Kosten-Aggregation + Label-Engine | `lib/sendcloud.js` |
| 2 | **DHL Paket** | OAuth 2.0 + Geschäftskundenvertrag | P1 | ⚡ Teilweise via SendCloud | — |
| 3 | **DPD** | JWT Bearer (Delis ID + Password) | P2 Tier 3 | 🔴 Nicht begonnen | — |
| 4 | **GLS** | Basic Auth + SHA512 | P2 Tier 3 | 🔴 Nicht begonnen | — |
| 5 | **Hermes** | TBD | P2 | 🔴 Nicht begonnen | — |
| 6 | **UPS** | OAuth 2.0 (Client Credentials) | P2 Tier 3 | 🔴 Nicht begonnen | — |
| 7 | **Amazon FBA** | SP-API (Teil von Amazon Integration) | P3 Phase 2 | 🔴 Nicht begonnen | — |

### Buchhaltung / Accounting

| # | Integration | Auth-Typ | Tier | Status | Dateien |
|---|-------------|----------|------|--------|---------|
| 1 | **SevDesk** | API Token (32 Hex) | ✅ Live | Bankdaten, teilweise Rechnungen | `lib/sevdesk.js` |
| 2 | **lexoffice** | OAuth 2.0 | P1 Tier 2 | 🔴 Nicht begonnen | `lib/lexoffice-api.js` (neu) |
| 3 | **DATEV** | Datei-Export (CSV/XML) | P2 Tier 3 | 🔴 Nicht begonnen | — |
| 4 | **Xero** | OAuth 2.0 (Multi-Org) | P3 | 🔴 Nicht begonnen | — |
| 5 | **SumUp/Debitoor** | TBD | P3 | 🔴 Nicht begonnen | — |
| 6 | **BuchhaltungsButler** | TBD | P3 Phase 2 | 🔴 Nicht begonnen | — |

### Payment

| # | Integration | Auth-Typ | Tier | Status | Dateien |
|---|-------------|----------|------|--------|---------|
| 1 | **Stripe** | API Keys (Secret + Publishable) | P2 Tier 3 | 🔴 Nicht begonnen | — |
| 2 | **PayPal** | OAuth 2.0 | P2 | 🔴 Nicht begonnen | — |
| 3 | **Klarna** | API Key | P3 | 🔴 Nicht begonnen | — |

### Sonstige

| # | Integration | Auth-Typ | Tier | Status | Dateien |
|---|-------------|----------|------|--------|---------|
| 1 | **Slack** | OAuth 2.0 | P3 | 🔴 Nicht begonnen | — |
| 2 | **Zapier** | Webhook/API | P3 | 🔴 Nicht begonnen | — |
| 3 | **Make.com** | Webhook/API | P3 | 🔴 Nicht begonnen | — |
| 4 | **HubSpot** | OAuth 2.0 | P3 Phase 2 | 🔴 Nicht begonnen | — |
| 5 | **Twilio** | API Key + Auth Token | P3 Phase 3 | 🔴 Nicht begonnen | — |
| 6 | **GA4** | OAuth 2.0 | P3 Phase 3 | 🔴 Nicht begonnen | — |

### Auth-Pattern Referenz

| Pattern | Beschreibung | Integrationen |
|---------|-------------|---------------|
| **A: OAuth 2.0** | Redirect → Login → Callback → Token | eBay, Amazon, OTTO, Etsy, Shopify, lexoffice, Xero, Stripe Connect, DHL, UPS |
| **B: API-Key/Secret** | User gibt Credentials ein → Test-Call → Speichern | Kaufland, BaseLinker, SevDesk, SendCloud, WooCommerce, Shopware, PrestaShop, Hood.de |
| **C: Datei-Export** | Konfiguration + CSV/XML Export | DATEV |

---

## FAKE→REAL — Mock-Daten ersetzen

> **Absolutes Verbot:** KEINE neuen MOCK_* Arrays, KEIN setTimeout() als Fake-Handler, KEINE hardcodierten Beispiel-Daten, KEIN "Coming Soon".

| # | View | Was ist FAKE | Was existiert schon | Status |
|---|------|-------------|---------------------|--------|
| 1 | MarketplaceListingsView | MOCK_LISTINGS | Alle eBay/Kaufland API-Calls in api/client.ts | ✅ Bereits real |
| 2 | IntegrationsHub | Hardcodierte Cards | GET /api/integrations/status | ✅ Bereits real |
| 3 | CompanySettings | Beispieldaten, setTimeout Save | GET/PUT /api/settings/company → Firestore | ✅ Bereits real |
| 4 | ProfileSettings | Hardcodierte Profildaten | GET/PUT /api/settings/profile → Firestore | ✅ Bereits real |
| 5 | OrderSettingsView | INITIAL_RULES/STATUSES/RANGES | GET/PUT /api/orders/settings → Firestore | ✅ Bereits real |
| 6 | WarehouseSettingsView | DEFAULT_ZONE_TYPES, setTimeout | Warehouse-Routes | ✅ Bereits real |
| 7 | ApiSettings | — | ✅ BEREITS REAL | ✅ |
| 8 | ShippingView | MOCK_SHIPMENTS | sendcloud.js, baselinker-shipping.js | 🔴 |
| 9 | InvoicesView | MOCK_INVOICES | sevdesk.js | 🔴 |
| 10 | ReturnsView | MOCK_RETURNS | returns-engine.js | 🔴 |
| 11 | BillingSettings | Hardcodierte Plan/Usage | adminGetProductCoverageMetrics() | 🔴 |
| 12 | Global | "Demnächst verfügbar", MOCK_*, setTimeout | — | ✅ Clean |

---

## Aktive Bugs

| ID | Beschreibung | Priorität | Status |
|----|-------------|-----------|--------|
| BUG-020 | eBay Preis wird in Firestore aktualisiert aber NICHT zum Listing gepusht | P0 | ✅ Fixed (property path mismatch: `product.pricing` → `product.details.pricing`) |
| BUG-021 | eBay Publish: Blocker-Gründe im UI nicht sichtbar | P1 | ✅ Fixed (nested response unwrapping + blocker display in UI) |
| BUG-022 | Inventar eBay-Indikator zeigt falschen Status | P1 | ✅ Fixed (SKU-index priority over stale ops.listingStatus) |
| BUG-023 | Kaufland-Tabelle zeigt nichts Brauchbares | P1 | ✅ Fixed (responsive classes, brand field, image thumbnail) |
| BUG-024 | Marketplace-Tabellen haben keinerlei UX | P1 | ✅ Fixed (column sorting, rows-per-page, stock filter) |
| BUG-025 | **KRITISCH: Versandlabel falsche Carrier-Zuordnung** — 4kg Paket bekommt DHL Kleinpaket 0-1kg statt DPD Classic 0-5kg | P0 | ✅ Fixed (order-level weight + type-safe rule matching) |
| BUG-026 | **Nicht versendete Bestellungen zeigen Verpackt/Versendet Zeitstempel** — State-Machine setzt Timestamps eager, bevor Aktion bestätigt ist | P1 | ✅ Fixed (caller-provided timestamps, tracking-gated transitions, defensive UI) |
| BUG-027 | **eBay-Filter in Inventar/Produktdaten zeigt falsche Ergebnisse** — "Gelistet" = 0 Ergebnisse, "Nicht gelistet" enthält gelistete Artikel | P1 | ✅ Fixed (Filter-Logik an Badge-Logik angeglichen: viewItemUrl/SKU-Index-Priorität für eBay + Kaufland) |
| BUG-028 | **Marketplace-Seiten: Inkonsistente Lager/Marktplatz-Mengen** — Warehouse-Qty ≠ Marketplace-Qty, kein Real-Time-Sync bei externen Verkäufen | P1 | ✅ Fixed (P1: Retry-Mechanismus, Stock-Sync nach Pack/Ship, Listing-Sync 10→3 Min, Auto-Heal bei Diskrepanz) |
| BUG-029 | **🔥 OVERSELL: Artikel mit Bestand 0 werden auf Marktplätzen verkauft** — Kaufland zeigt Menge >0 obwohl Inventar 0 ist. Kein Stock-Sync bei Order-Intake. availableQuantity nie gespeichert. | P0 SOFORT | ✅ Fixed (computeAvailableQuantity aus Reservierungen, Stock-Sync bei Order-Intake + Order-Sync, Auto-Heal mit Oversell-Detection, Kaufland-UI frischer Bestand) |
| BUG-030 | **Stornierung fehlt: Aufträge können nicht storniert + an Marktplätze kommuniziert werden** — Status "cancelled" existiert intern, aber kein Cancel-API-Call zu eBay/Kaufland. Stock-Reservierung wird nicht freigegeben. | P0 | 🔴 Offen |
| BUG-031 | **Status-Sync zu Marktplätzen unvollständig** — Tracking-Push nur bei SendCloud-Ship, nicht bei manuellem Status-Wechsel. Kein Status-Push für packed/cancelled/on_hold. | P1 | 🔴 Offen |
| BUG-SSE | Token-in-Query-Parameter für SSE-Streams leakt | P1 | 🔴 Offen |
| BUG-006 | EbayListingsView.tsx (alte Gap-Analysis) noch da — LÖSCHEN | P1 | ✅ Fixed (deleted) |
| BUG-008 | eBay-Seite zeigt Gap-Analyse-Daten statt Listing-Management | P1 | ✅ Fixed (route already correct, old component deleted) |
| BUG-009 | Kaufland-Seite zeigt nur SKU-Nummern ohne Produktdaten | P1 | ✅ Fixed (same root cause as BUG-023) |

### BUG-021 — eBay Publish Blocker-Gründe nicht sichtbar

**Symptom:** Einzeln oder Bulk Publish auf eBay zeigt nur "Fehlgeschlagen" ohne Grund.

**Root Cause:** Backend `POST /api/ebay/publish` (marketplace.js:1368) gibt HTTP 200 mit `{ ok: true, data: { ok: false, blockers: [...] } }` zurück. `api/client.ts:publishToEbay()` prüft nur `res.ok` und `data.ok`, nicht `data.data.ok`. Blocker-Info geht verloren.

**Betroffene Dateien:**

| Datei | Was ändern |
|-------|-----------|
| `api/client.ts` → `publishToEbay()` | Nach `parseResponse(res)` auch `result.ok === false` prüfen. Wenn `result.blockers?.length`, Error werfen mit `blockers.join(' \| ')`. `err.blockers` Array anhängen. |
| `components/MarketplaceListingsView.tsx` → `handlePublish` (~Zeile 304-322) | Im catch: `err.blockers` extrahieren, in Fehlermeldung anzeigen (`Fehlgeschlagen: ${blockers.join(' \| ')}`) |
| `components/MarketplaceListingsView.tsx` → `handleBulkPublish` (~Zeile 347-391) | Pro fehlgeschlagenem Ergebnis `r.blockers` sammeln. `failedDetails: string[]` Array mit `"Produktname: grund1, grund2"` befüllen. In der Bulk-Summary diese Details anzeigen (scrollbar, max 10 mit "+X weitere"). |
| `components/MarketplaceListingsView.tsx` → `bulkPublishSummary` State | Type erweitern: `failedDetails: string[]` hinzufügen |

### BUG-022 — Inventar eBay-Indikator zeigt falschen Status

**Symptom:** CAPAS Kurzflossen ist aktiv auf eBay (EUR 39.99, 6 Watchers) aber Inventar zeigt "Inaktiv".

**Root Cause (2 Schichten):**

1. **listing-sync-runner.js `propagateEbayStatusToProducts()` (Zeile 32-86):** Liest nur Produkte die in `ebayListingLinks` stehen. Wenn ein Produkt dort fehlt → `ops.listingStatus.ebay` wird nie auf `'active'` gesetzt. Außerdem: Zeile 51 prüft `active === true && status === 'active'` — Case-Sensitiv! eBay gibt `listingStatus: 'Active'` (Großbuchstabe A).

2. **AdminTable.tsx eBay-Spalte (Zeile 670-671):** `const isActive = ebayStatus === 'active' || (!ebayStatus && viewItemUrl)` — Wenn `ebayStatus === 'inactive'` (stale Wert vom Sync-Runner), gewinnt das über `viewItemUrl`. Der SKU-Index (ebayListingsLive) ist aber die echte Echtzeit-Quelle.

**Betroffene Dateien:**

| Datei | Was ändern |
|-------|-----------|
| `components/AdminTable.tsx` → eBay-Spalte (~Zeile 670-674) | `isActive` Logik ändern: `const isActive = !!viewItemUrl \|\| ebayStatus === 'active';` und `const isInactive = !isActive && ebayStatus === 'inactive';` — SKU-Index hat Vorrang vor stale `ops.listingStatus.ebay`. |
| `backend/services/listing-sync-runner.js` → `propagateEbayStatusToProducts()` (Zeile 51) | Case-insensitive Vergleich: `status.toLowerCase() === 'active'` statt `status === 'active'` |

**Datenfluss-Kontext:**
```
AdminTable.tsx lädt SKU-Index via fetchEbaySkuIndex() → ebayLinkedMap (SKU→URL), ebayProductIdMap (productId→itemId), ebayActiveItemIds (Set<itemId>)
Für jedes Produkt wird viewItemUrl aufgelöst über: SKU-Match → productId-Match → marketplace.ebay.itemId Check
Wenn viewItemUrl existiert → Listing IST aktiv auf eBay (Quelle: ebayListingsLive Collection)
```

### BUG-023 — Kaufland-Tabelle zeigt nichts Brauchbares

**Symptom:** Kaufland-Tab in MarketplaceListingsView zeigt keine Preise, keine Kategorien, keine nützlichen Daten.

**Root Cause:** Backend liefert ALLE Daten korrekt. Problem ist rein Frontend:

1. **Responsive Hiding zu aggressiv:** `hidden sm:table-cell` versteckt Preis/Menge/Lager unter 640px, `hidden lg:table-cell` versteckt Kategorie/Update unter 1024px.
2. **Brand-Feld existiert im Backend aber wurde nie in NormalizedListing/UI aufgenommen** — Kaufland-Backend gibt `brand` zurück (marketplace.js:997), wird in `normalizeKauflandRow()` nicht gemappt.
3. **Bild-Thumbnail fehlt** — Backend gibt `imageUrl` zurück, wird in `normalizeKauflandRow()` gesetzt aber nie in der Tabelle gerendert.

**Backend gibt diese Felder zurück (marketplace.js:983-1003):**
```
title, brand, price, imageUrl, category, sku, ean, status, active, quantity,
idUnit, idProduct, viewItemUrl, updatedAt, warehouseStock, binLocation, stockMismatch
```

**Betroffene Dateien:**

| Datei | Was ändern |
|-------|-----------|
| `components/MarketplaceListingsView.tsx` → `NormalizedListing` Interface | `brand?: string \| null` hinzufügen |
| `components/MarketplaceListingsView.tsx` → `normalizeKauflandRow()` | `brand: row.brand \|\| null` mappen |
| `components/MarketplaceListingsView.tsx` → Tabelle thead/tbody | Bild-Thumbnail in Titel-Spalte (wenn `listing.imageUrl`). Responsive Klassen lockern: Preis mindestens ab `xs` sichtbar, Kategorie ab `sm`. |

### BUG-024 — Marketplace-Tabellen haben keinerlei UX

**Symptom:** Keine Sortierung, keine Filter (außer Tab + Suche), kein Rows-per-Page.

**Bestandsaufnahme was FEHLT:**

| Feature | Status | Aufwand |
|---------|--------|---------|
| **Column Sorting** (klickbare Header, ↑/↓ Indikator) | ❌ Komplett fehlend | Mittel |
| **Rows-per-Page Selector** (25/50/100/250) | ❌ Hardcoded `PAGE_SIZE = 50` | Klein |
| **Preis-Filter** (Min/Max Range) | ❌ Fehlend | Mittel |
| **Kategorie-Filter** (Dropdown aus vorhandenen Werten) | ❌ Fehlend | Mittel |
| **Bestand-Filter** (Auf Lager / Niedrig / Leer) | ❌ Fehlend | Klein |
| **Ergebnis-Zähler pro Filter** | ❌ Fehlend | Klein |

**Betroffene Dateien:**

| Datei | Was ändern |
|-------|-----------|
| `components/MarketplaceListingsView.tsx` → State | Hinzufügen: `sortKey: SortKey`, `sortDir: 'asc' \| 'desc'`, `pageSize: number` (default 50) |
| `components/MarketplaceListingsView.tsx` → `PAGE_SIZE` | Ersetzen durch `PAGE_SIZE_OPTIONS = [25, 50, 100, 250]` + State |
| `components/MarketplaceListingsView.tsx` → `filteredListings` useMemo | Nach Filter: Sortierung anwenden basierend auf `sortKey`/`sortDir`. Null-Werte ans Ende. |
| `components/MarketplaceListingsView.tsx` → `<thead>` | Spaltenheader klickbar machen. onClick togglet `sortKey`/`sortDir`. Aktive Sortierung mit ↑/↓ Icon anzeigen. |
| `components/MarketplaceListingsView.tsx` → Pagination Footer | Rows-per-Page Dropdown: `<select>` mit Optionen 25, 50, 100, 250. Bei Änderung: `setPageSize()`, `setCurrentPage(1)`. |
| `components/MarketplaceListingsView.tsx` → Search Row | Filter-Leiste ergänzen: Kategorie-Dropdown (unique values aus `listings`), Bestand-Filter (Alle / Auf Lager / Niedrig / Leer). |

**Hinweis:** Backend-Endpoints unterstützen bereits `matchStatus` Parameter (fetchEbayLiveListings) — wird vom Frontend nie genutzt. Kann als zusätzlicher eBay-Filter eingebaut werden.

**Best Practice Referenz (AdminTable.tsx hat es richtig):**
AdminTable.tsx in der Inventar-Ansicht hat bereits: sortierbare Spalten, Pagination mit Rows-per-Page, Filter-Presets. Dasselbe Pattern in MarketplaceListingsView übernehmen.

### BUG-025 — Versandlabel falsche Carrier-Zuordnung (P0 KRITISCH)

**Symptom:** Bestellung MA8YQ35 hat Gewicht 4 kg, Versand dhl_de. DHL Kleinpaket 0-1kg Label erstellt. Laut Versandregeln müsste DPD Classic 0-5 kg (Method 111) gewählt werden.

**Root Cause (2 Probleme):**

**Problem 1 (Haupt-Ursache): `calculateOrderWeight()` ignoriert Order-Level Gewicht**

`backend/services/shipping-engine.js` Zeile 254-262:
```
function calculateOrderWeight(order) {
  const items = order.items || [];
  let totalKg = 0;
  for (const item of items) {
    const w = parseFloat(item.weight || '0') || 0;
    totalKg += w * (item.quantity || 1);
  }
  return totalKg > 0 ? totalKg : 0.5; // ← HIER: Default 0.5kg!
}
```

Die Funktion iteriert NUR über `order.items[].weight`. Kaufland-Bestellungen haben aber das Gewicht auf **Order-Ebene** (`order.weight = 4`), NICHT auf Item-Ebene. Wenn kein Item ein `weight`-Feld hat → `totalKg = 0` → **Return 0.5 kg** → matcht DHL Kleinpaket (0.5-1.99 kg).

In `shipOrder()` Zeile 328: `const orderWeight = weight || calculateOrderWeight(order);` — `weight` kommt nur wenn explizit per Request-Body übergeben. Bulk-Ship (Zeile 1522) übergibt KEIN weight → immer calculateOrderWeight.

**Problem 2 (Zusätzlich): `matchCarrierRule()` macht keine Typ-Sicherung**

`backend/services/shipping-engine.js` Zeile 277-308: `rule.minWeight` und `rule.maxWeight` werden direkt verglichen ohne `Number()` Konvertierung. Wenn Firestore-Daten als Strings gespeichert sind (z.B. durch Migration oder manuellen Edit), bricht die Sortierung und der Vergleich.

**Betroffene Dateien + Fixes:**

| Datei | Was ändern |
|-------|-----------|
| `backend/services/shipping-engine.js` → `calculateOrderWeight()` (Zeile 254-262) | **Order-Level Gewicht prüfen:** VOR der Items-Schleife: `if (order.weight && parseFloat(order.weight) > 0) return parseFloat(order.weight);`. Dann: Items-Gewicht als Fallback. Dann: 0.5 kg als letzter Fallback. |
| `backend/services/shipping-engine.js` → `matchCarrierRule()` (Zeile 284-287) | **Typ-Sicherung:** `const min = Number(rule.minWeight) \|\| 0;` und `const max = Number(rule.maxWeight) \|\| Infinity;` und `const w = Number(weight) \|\| 0;` |
| `backend/routes/orders.js` → PUT `/api/orders/settings` (Zeile 970-983) | **Numerische Normalisierung beim Speichern:** Vor dem Firestore-Write alle `carrierRules[].minWeight` und `maxWeight` mit `parseFloat()` konvertieren um sicherzustellen dass nur Zahlen gespeichert werden. |

**Datenfluss:**
```
Frontend "Label drucken" → POST /api/orders/:id/ship (orders.js:1291)
  → shipOrder({ orderId, tenantId, weight? }) (shipping-engine.js:319)
    → weight nicht übergeben? → calculateOrderWeight(order) (Zeile 254)
      → order.items[].weight iterieren → 0 gefunden → return 0.5 (DEFAULT!)
    → matchCarrierRule({ weight: 0.5, rules }) → 0.5 liegt in [0.5, 1.99] → DHL Kleinpaket ❌
```

**Verifikation nach Fix:**
1. Bestehende Bestellungen mit bekanntem Gewicht testen (4kg → DPD Classic 0-5kg erwartet)
2. Bestellungen OHNE Gewichtsdaten testen (Fallback 0.5kg → DHL Kleinpaket erwartet)
3. Prüfen ob `order.weight` in Kaufland-Orders korrekt importiert wird

### BUG-026 — Nicht versendete Bestellungen zeigen Verpackt/Versendet Zeitstempel

**Symptom:** Bestellungen die nicht tatsächlich versendet wurden haben trotzdem Zeitstempel für "Verpackt" und "Versendet" in der Detailansicht.

**Root Cause: Eager Timestamp Assignment in State-Machine**

`backend/services/order-state-machine.js` Zeile 145-163 — `transitionOrder()` setzt Timestamps **sofort beim Status-Wechsel**, BEVOR die eigentliche Aktion (Label-Erstellung etc.) bestätigt ist:
```
if (toStatus === 'packed') {
  update.packedAt = new Date().toISOString();  // ← Sofort gesetzt
}
if (toStatus === 'shipped') {
  update.shippedAt = new Date().toISOString();  // ← Sofort gesetzt
}
```

**Problematische Szenarien:**

1. **Ship-Flow (orders.js Zeile 1296-1330):** `shipOrder()` erstellt SendCloud-Parcel → `transitionOrder('shipped')` wird aufgerufen und setzt `shippedAt` → wenn danach `pushTrackingToMarketplace()` oder ein anderer Schritt fehlschlägt, bleibt der Timestamp stehen.

2. **SendCloud-Sync (shipping-engine.js Zeile 577-588):** `syncSendCloudParcels()` ruft `transitionOrder({ force: true })` auf. Mit `force: true` wird die State-Machine-Validierung umgangen — Bestellungen können von "pending" direkt auf "shipped" gesetzt werden.

3. **Kein Rollback:** Wenn `createParcel()` erfolgreich ist aber das Label null zurückgibt (z.B. Adressfehler bei SendCloud), wird die Bestellung trotzdem als "shipped" markiert mit Timestamp.

**Frontend (OrderDetail.tsx Zeile 444-453):** Rendert Timestamps bedingungslos wenn Felder existieren:
```
{order.packedAt && <Row label="Verpackt" value={...} />}
{order.shippedAt && <Row label="Versendet" value={...} />}
```
Keine Validierung ob `omsStatus` tatsächlich zum Timestamp passt.

**Betroffene Dateien + Fixes:**

| Datei | Was ändern |
|-------|-----------|
| `backend/services/order-state-machine.js` → `transitionOrder()` (Zeile 145-163) | Timestamps NICHT eager setzen. Stattdessen: Timestamp-Felder als optionale Parameter akzeptieren. Caller setzt Timestamp erst NACH erfolgreicher Aktion. |
| `backend/routes/orders.js` → `POST /orders/:id/ship` (Zeile 1296-1330) | Flow umbauen: 1) `shipOrder()` aufrufen, 2) Ergebnis prüfen (trackingNumber nicht null?), 3) ERST DANN `transitionOrder('shipped')` mit explizitem `shippedAt`. |
| `backend/services/shipping-engine.js` → `shipOrder()` (Zeile 367-373) | Vor dem Firestore-Update prüfen: `result.trackingNumber` muss vorhanden sein. Wenn null → Error werfen statt Order zu aktualisieren. |
| `backend/services/shipping-engine.js` → `syncSendCloudParcels()` (Zeile 577-588) | `force: true` entfernen. Nur auf "shipped" wechseln wenn aktueller Status in erlaubter Vorgängerliste ist UND Tracking-Nummer vorhanden. |
| `components/OrderDetail.tsx` → Zeitstempel-Sektion (Zeile 444-453) | **Defensive Anzeige:** `shippedAt` nur anzeigen wenn `omsStatus` tatsächlich `'shipped'` oder `'delivered'` ist. Gleiches für `packedAt` → nur bei `'packed'`, `'shipped'`, `'delivered'`. |

**Verifikation nach Fix:**
1. Bestellung erstellen → auf "packed" setzen → Ship fehlschlagen lassen → kein `shippedAt` Timestamp erwartet
2. Bestellung erfolgreich versenden → `shippedAt` korrekt gesetzt
3. SendCloud-Sync mit fehlenden Tracking-Nummern → Status darf NICHT auf "shipped" wechseln

### BUG-027 — eBay-Filter in Inventar/Produktdaten zeigt falsche Ergebnisse

**Symptom:** Filter "eBay: Gelistet" zeigt 0 Ergebnisse (leere Tabelle), obwohl Produkte auf eBay gelistet sind und grüne "Gelistet"-Badges haben. Filter "eBay: Nicht gelistet" zeigt 433 Ergebnisse, enthält aber Produkte die aktiv auf eBay gelistet sind (grünes Badge sichtbar). Betrifft Inventar- UND Produktdaten-Seite (beide nutzen AdminTable.tsx).

**Root Cause: Filter-Logik stimmt nicht mit Badge-Logik überein**

**Badge-Logik (Zeile 670-671) — KORREKT:**
```
const isActive = !!viewItemUrl || ebayStatus === 'active';
```
Badge zeigt "Gelistet" wenn: viewItemUrl existiert (SKU-Index = Echtzeit-Quelle) ODER ebayStatus === 'active'.

**Filter-Logik (Zeile 1090-1094) — FALSCH:**
```
const isEbayListed = pEbayStatus === 'active' || (!pEbayStatus && Boolean(
  hasSkuMatch || ebayProductIdMap.get(p.id) || (marketplaceItemId && ebayActiveItemIds.has(marketplaceItemId))
));
```
Filter erkennt als "gelistet" NUR wenn: `pEbayStatus === 'active'` ODER (`pEbayStatus` ist null/undefined UND Fallback-Quellen matchen).

**Das Problem:** Wenn `pEbayStatus === 'inactive'` (stale Wert vom listing-sync-runner), dann:
- Badge: `!!viewItemUrl` = true → zeigt grün "Gelistet" ✅
- Filter: `pEbayStatus === 'active'` = false, UND `!pEbayStatus` = false (weil 'inactive' truthy ist) → `isEbayListed = false` → Produkt erscheint NICHT unter "Gelistet" ❌

Umgekehrt: Filter "Nicht gelistet" zeigt dieses Produkt, obwohl Badge grün ist.

**Betroffene Dateien + Fixes:**

| Datei | Was ändern |
|-------|-----------|
| `components/AdminTable.tsx` → Filter-Logik (Zeile 1090-1094) | **Filter-Logik an Badge-Logik angleichen.** viewItemUrl MUSS im Filter genauso berechnet werden wie im Badge-Render. Neue Logik: `const pViewItemUrl = pSkuCandidates.map((sku) => ebayLinkedMap.get(sku)).find(Boolean) \|\| ebayProductIdMap.get(p.id) \|\| (marketplaceItemId && ebayActiveItemIds.has(marketplaceItemId));` dann: `const isEbayListed = !!pViewItemUrl \|\| pEbayStatus === 'active';` |

**Verifikation nach Fix:**
1. Filter "eBay: Gelistet" → muss alle Produkte zeigen die grünes "Gelistet"-Badge haben
2. Filter "eBay: Nicht gelistet" → darf KEINE Produkte mit grünem Badge enthalten
3. Anzahl "Gelistet" + "Nicht gelistet" = Gesamtzahl Artikel
4. Gleiches Verhalten auf Inventar- UND Produktdaten-Seite verifizieren

### BUG-028 — Inkonsistente Lager/Marktplatz-Mengen auf Marketplace-Seiten

**Symptom:** eBay-Seite und Kaufland-Seite zeigen unterschiedliche Mengen in "Marktplatz"-Spalte vs. "Lager"-Spalte, obwohl beide Marktplätze denselben Lagerbestand nutzen. Beispiel: Marktplatz zeigt "1", Lager zeigt "—" (oder umgekehrt). Extrem kritisch: Lagerbestand muss auf ALLEN aktiven Marktplätzen jederzeit synchron sein.

**Analyse — Wie Stock-Sync aktuell funktioniert:**

**Datenquellen auf Marketplace-Seiten:**
- **Marktplatz-Menge (eBay):** `ebayListingsLive` Collection → `quantityAvailable` — von eBay API geholt
- **Marktplatz-Menge (Kaufland):** `kauflandUnitsLive` Collection → `amount` — von Kaufland API geholt
- **Lager-Menge:** Errechnet aus verlinktem Produkt in `products_v2` → `storageBins[].quantity` summiert, Fallback auf `inventory.availableQuantity`

**Automatischer Push (Warehouse → Marktplätze):**
- `POST /api/warehouse/stock-out` → `stock-sync-dispatcher.js:syncStockToAllChannels()` → Push zu eBay (`reviseFixedPriceItem`) + Kaufland (`updateUnit`) + BaseLinker
- Trigger: NUR bei explizitem Stock-Out über Warehouse-Endpoint
- Non-blocking: `setTimeout(..., 0)` — Fire-and-forget, Fehler nur in Console geloggt

**Periodischer Fetch (Marktplätze → Cache):**
- `listing-sync-runner.js` läuft alle ~10 Minuten (LISTING_SYNC_INTERVAL_MS)
- Holt aktuelle Mengen von eBay/Kaufland APIs und schreibt in `ebayListingsLive`/`kauflandUnitsLive`

**Root Causes der Inkonsistenzen:**

| # | Ursache | Auswirkung |
|---|---------|------------|
| 1 | **Kein automatischer Stock-Sync bei Marketplace-Verkäufen** | Verkauf auf eBay → eBay-Menge sinkt sofort → AvyCloud-Lager weiß davon erst wenn Bestellung eingeht + verarbeitet wird → bis dahin Diskrepanz |
| 2 | **Listing-Sync nur alle 10 Min** | Marketplace-Mengen-Cache ist bis zu 10 Min veraltet → UI zeigt alte Daten |
| 3 | **Stock-Push nur bei stock-out Endpoint** | Manuelle Lageränderungen, Inventur, Retouren → kein automatischer Push zu Marktplätzen |
| 4 | **Kein Order-basierter Stock-Decrement** | Wenn eBay/Kaufland-Bestellung eingeht und kommissioniert wird → Stock-Sync zu ANDEREN Marktplätzen fehlt wenn nicht über stock-out Endpoint |
| 5 | **Fire-and-Forget Push** | `syncStockToAllChannels()` Fehler werden nur geloggt, nicht retried. Fehlgeschlagene Syncs → permanente Diskrepanz |
| 6 | **Kein Webhook-Empfang** | eBay/Kaufland Webhooks für Bestandsänderungen werden nicht empfangen → kein Real-Time-Update möglich |

**Betroffene Dateien + Fixes (nach Priorität):**

| # | Datei | Was ändern | Prio |
|---|-------|-----------|------|
| 1 | `backend/services/stock-sync-dispatcher.js` | **Retry-Mechanismus:** Bei Fehler 1x automatisch retrien nach 30s. Fehlgeschlagene Syncs in `stock_sync_failures` Collection speichern mit Retry-Counter. | P1 |
| 2 | `backend/routes/orders.js` → Pack/Ship-Endpoints | **Stock-Sync nach Kommissionierung:** Wenn Bestellung gepackt/versendet wird → `syncStockToAllChannels()` für ALLE betroffenen Produkte aufrufen. Nicht nur bei stock-out. | P1 |
| 3 | `backend/services/listing-sync-runner.js` | **Sync-Intervall verkürzen:** `LISTING_SYNC_INTERVAL_MS` Default von 10 Min auf 3 Min. Und: Bei erkannter Diskrepanz (warehouseStock ≠ marketplaceQty) → sofortigen Push triggern. | P1 |
| 4 | `backend/services/stock-sync-dispatcher.js` | **Alle Stock-Änderungen abfangen:** Nicht nur stock-out, auch: Inventur-Korrektur, Retouren-Einlagerung, manuelle Bestandsänderung → Überall `syncStockToAllChannels()` aufrufen. | P2 |
| 5 | `backend/routes/marketplace.js` oder neuer Webhook-Endpoint | **eBay/Kaufland Webhooks empfangen** für Bestellungen → sofortiger Stock-Decrement + Sync zu anderen Kanälen. | P2 |

**Datenfluss (Ist-Zustand):**
```
Warehouse Stock-Out → syncStockToAllChannels() → Push zu eBay + Kaufland (async, no retry)
                                                    ↓
                                            ebayListingsLive/kauflandUnitsLive = STALE bis nächster listing-sync-runner Zyklus (10 Min)

Marketplace-Verkauf → Bestellung in BaseLinker → irgendwann: order-sync → packOrder → stock-out → Push
                                                    ↓
                                            ABER: Andere Marktplätze wissen bis dahin nichts → Oversell-Risiko!
```

**Datenfluss (Soll-Zustand):**
```
JEDE Bestandsänderung (stock-out, pack, ship, inventur, retoure)
    → syncStockToAllChannels() mit Retry
    → Push zu ALLEN aktiven Marktplätzen
    → Bei Fehler: Queue + Retry nach 30s
    → listing-sync-runner alle 3 Min als Safety-Net
    → Bei Diskrepanz: sofort Push (Auto-Heal)
```

**Verifikation nach Fix:**
1. Produkt mit Bestand 5 → stock-out 1 Stück → eBay UND Kaufland zeigen sofort 4
2. Bestellung auf eBay → packen → Lager zeigt -1 → Kaufland zeigt auch -1
3. Sync-Fehler simulieren → Retry nach 30s → Bestand wird korrekt gepusht
4. listing-sync-runner erkennt Diskrepanz → Auto-Push korrigiert Marketplace-Menge

### BRAND — Sidebar-Logo ersetzen

**Symptom:** Sidebar zeigt Text "AvyCloud" (bold) + "Product Intelligence" (klein) neben dem Cloud-Icon. Soll stattdessen das Wordmark-Logo als Bild zeigen.

**Aktuell (Sidebar.tsx Zeile 454-461):**
```tsx
<img src="/avy_logo.png" alt="AvyCloud" className="w-8 h-8 rounded-md object-contain shrink-0" />
{!collapsed && (
  <div>
    <div className="text-[15px] font-bold text-txt-primary leading-tight">AvyCloud</div>
    <div className="text-[10px] text-txt-muted leading-none">Product Intelligence</div>
  </div>
)}
```

**Soll:**
```tsx
{collapsed ? (
  <img src="/avy_logo.png" alt="AvyCloud" className="w-8 h-8 rounded-md object-contain shrink-0" />
) : (
  <img src="/logo_darkmode.png" alt="AvyCloud" className="h-7 object-contain" />
)}
```

**Details:**
- **Collapsed:** Zeigt weiterhin das Cloud-Icon (`avy_logo.png`)
- **Expanded:** Zeigt das Wordmark-Logo (`logo_darkmode.png` für Dark-Theme, `logo_brightmode.png` für Light-Theme)
- **Theme-Aware:** Idealerweise mit `data-theme` Attribut oder Tailwind `dark:` Prefix das richtige Logo laden. Alternative: CSS `filter: invert()` oder zwei `<img>` mit `hidden dark:block` / `block dark:hidden`
- **Kein Text mehr:** Die `<div>` mit "AvyCloud" + "Product Intelligence" komplett entfernen

**Betroffene Dateien:**

| Datei | Was ändern |
|-------|-----------|
| `components/Sidebar.tsx` (Zeile 454-461) | Text durch Wordmark-Logo ersetzen. Collapsed: `avy_logo.png`. Expanded: `logo_darkmode.png` (dark) / `logo_brightmode.png` (light). |
| `components/Header.tsx` (Zeile ~230) | Prüfen ob dort auch Text "AvyCloud" steht → gleiche Logik anwenden |

### BUG-029 — 🔥 OVERSELL: Artikel mit Bestand 0 werden auf Marktplätzen verkauft (P0 SOFORT)

**Symptom:** SKU-9247228090 "CO2-Zylinder Aluminium SodaStream" hat Bestand 0 im Inventar (kein BIN zugewiesen). Kaufland zeigt trotzdem Menge 2 auf dem Marktplatz und Lager 6. Zwei Bestellungen (M7PPT35, MEL4T35) wurden angenommen — Oversell, Ware nicht lieferbar.

**Impact:** Finanzieller Schaden + Kaufland-Strafpunkte + Kundenstornierungen + Reputationsschaden

**Root Causes (5 Schichten):**

**1. KEIN Stock-Sync bei Order-Intake**
`order-intake-kaufland.js` und `order-sync.js` importieren Bestellungen und reservieren Stock — aber rufen NICHT `syncStockToAllChannels()` auf. Der Bestand wird lokal reserviert, aber Kaufland wird NICHT informiert dass weniger Bestand verfügbar ist.

**Vergleich:** `warehouse.js` POST `/stock-out` (Zeile 451-466) ruft `syncStockToAllChannels()` auf — aber Order-Intake tut das nicht.

**2. `availableQuantity` wird NIE gespeichert**
`availableQuantity` ist ein BERECHNETES Feld (`physicalQuantity - reservedQuantity`), wird on-demand in `routes/products.js:214` berechnet. Es wird NICHT in Firestore gespeichert. Wenn `syncStockToAllChannels()` aufgerufen wird, liest es:
```js
const availableQuantity = product?.inventory?.availableQuantity ?? quantity;
```
Da `availableQuantity` nie gespeichert wird → Fallback auf `quantity` → kann veraltet sein.

**3. Kaufland-Listings-Seite zeigt falschen Lagerbestand**
`marketplace.js:976-978` berechnet "Lager" aus `storageBins[].quantity` des verlinkten Produkts. Wenn das Produkt aus einem alten Firestore-Read stammt (gecachtes Objekt), zeigt es den alten Bestand (6 Stück) obwohl `inventory.quantity` bereits 0 ist.

**4. Stock-Sync nur bei explizitem Stock-Out**
`syncStockToAllChannels()` wird NUR aufgerufen bei:
- `POST /api/warehouse/stock-out` ✅
- Pack/Ship-Endpoints (seit BUG-028 Fix) ✅
- **NICHT bei:** Order-Intake, Inventur-Korrektur, manueller Bestandsänderung, Retouren-Einlagerung ❌

**5. Kein Oversell-Schutz**
Wenn Bestand = 0 aber Kaufland noch Menge > 0 zeigt, gibt es KEINEN Mechanismus der:
- Kaufland-Listing automatisch auf 0 setzt
- Kaufland-Listing automatisch deaktiviert
- Neue Bestellungen bei Bestand 0 ablehnt

**Betroffene Dateien + Fixes (ALLE P0 — SOFORT):**

| # | Datei | Was ändern |
|---|-------|-----------|
| 1 | `backend/services/order-intake-kaufland.js` | **SOFORT-FIX:** Nach jedem importierten Order → `syncStockToAllChannels()` für JEDES betroffene Produkt aufrufen. Menge = `inventory.quantity - Summe aktiver Reservierungen`. |
| 2 | `backend/services/order-sync.js` → `reserveStock()` (Zeile ~513) | **SOFORT-FIX:** Nach `reserveStock()` → available Qty berechnen (`quantity - reserved`) → `syncStockToAllChannels({ product: { ...product, inventory: { ...product.inventory, availableQuantity: computed } } })` |
| 3 | `backend/services/stock-sync-dispatcher.js` → `syncStockToAllChannels()` | **availableQuantity korrekt berechnen:** NICHT blind aus `product.inventory.availableQuantity` lesen (existiert nicht in Firestore). Stattdessen: `stock_reservations` Collection lesen, Summe der `status: 'reserved'` für dieses Produkt berechnen, `availableQty = max(0, inventory.quantity - reservedSum)`. NUR `availableQty` an Marktplätze pushen. |
| 4 | `backend/services/stock-sync-dispatcher.js` | **Zero-Stock → Auto-Delist:** Wenn `availableQty === 0` → Kaufland-Unit auf `status: 'ONHOLD'` setzen (über `updateUnit`). eBay-Listing auf `quantity: 0` setzen (über `reviseFixedPriceItem`). Dies verhindert weitere Verkäufe. |
| 5 | `backend/services/listing-sync-runner.js` → Auto-Heal | **Oversell-Detection:** Beim periodischen Sync: Für jedes Listing → wahren `availableQty` berechnen. Wenn Marketplace-Menge > availableQty → sofort Push mit korrektem Wert. Wenn availableQty === 0 und Marketplace zeigt > 0 → ALARM loggen + sofort pushen. |
| 6 | `backend/routes/marketplace.js` → Kaufland-Enrichment (Zeile ~976) | **Lager-Menge korrekt:** Nicht aus `storageBins` des gecachten Produkts lesen. Stattdessen: `inventory.quantity` direkt aus frischem Firestore-Read verwenden. Oder: `storageBins` und `inventory.quantity` vergleichen und den niedrigeren Wert nehmen. |

**Datenfluss (Ist → Soll):**

```
IST (KAPUTT):
Order-Intake Kaufland → reserveStock() → FERTIG (Kaufland weiß nichts!)
  → Kaufland verkauft weiter → OVERSELL

SOLL:
Order-Intake Kaufland → reserveStock()
  → availableQty berechnen (quantity - reserved)
  → syncStockToAllChannels({ availableQty })
  → Kaufland API: PATCH /units/{id} { amount: availableQty }
  → Wenn availableQty === 0: status: 'ONHOLD'
  → eBay API: reviseFixedPriceItem({ quantity: availableQty })
  → Kein weiterer Verkauf möglich ✅
```

**Sofort-Maßnahme (VOR dem Code-Fix):**
Manuell ALLE Produkte mit `inventory.quantity === 0` identifizieren und deren Kaufland/eBay-Listings auf Menge 0 setzen. Kann per Script oder manuell über Kaufland-Portal erfolgen.

**Verifikation nach Fix:**
1. Produkt mit Bestand 2 → 1 Kaufland-Bestellung kommt rein → Kaufland zeigt sofort Menge 1 (nicht 2)
2. Produkt mit Bestand 1 → Bestellung kommt rein → Kaufland zeigt 0 + Status ONHOLD → keine weitere Bestellung möglich
3. Produkt mit Bestand 0 → Kaufland UND eBay zeigen 0 → Auto-Delist/ONHOLD
4. listing-sync-runner erkennt Oversell-Situation → korrigiert sofort
5. Keine Bestellung mehr möglich für Produkte mit Bestand 0

### BUG-030 — Stornierung: Aufträge können nicht an Marktplätze kommuniziert werden (P0)

**Symptom:** In AvyCloud kann ein Auftrag auf "Storniert" gesetzt werden (Status "cancelled" existiert in State-Machine). Aber: eBay und Kaufland erfahren NICHTS davon. Reservierter Bestand wird nicht freigegeben. Stornierte Aufträge blockieren Lagerbestand.

**Was BEREITS existiert:**

| Funktion | Datei | Status |
|----------|-------|--------|
| Status "cancelled" in State-Machine | `order-state-machine.js` Zeile 36, 43-56 | ✅ Existiert |
| Transition-Regeln: pending/confirmed/picking/picked/packing/packed → cancelled | `order-state-machine.js` Zeile 43-50 | ✅ Existiert |
| `cancelledAt` Timestamp bei Transition | `order-state-machine.js` Zeile 151 | ✅ Existiert |
| `/api/orders/:id/transition` mit `{toStatus:'cancelled'}` | `orders.js` Zeile 1192-1220 | ✅ Existiert |
| Bulk-Transition inkl. cancelled | `orders.js` Zeile 1578-1616 | ✅ Existiert |
| `releaseReservation({tenantId, orderId})` | `stock-reservation.js` Zeile 86-107 | ✅ Code existiert, wird NIRGENDS aufgerufen |

**Was FEHLT:**

| # | Was | Datei | Fix |
|---|-----|-------|-----|
| 1 | **eBay Cancel API** | `backend/services/marketplace-tracking.js` oder neu | Neue Funktion `cancelOrderOnEbay({order})`: eBay Post-Order API `POST /post-order/v2/cancellation` mit `legacyOrderId` und `cancelReason`. Alternative: Seller-initiated Cancellation via `CancelTransaction` Trading API Call. |
| 2 | **Kaufland Cancel API** | `backend/services/marketplace-tracking.js` oder neu | Neue Funktion `cancelOrderOnKaufland({order})`: Für jede Order-Unit: `PATCH /v2/order-units/{unitId}/cancel` mit `reason` und `note`. Kaufland-API unterstützt Cancel pro Unit. |
| 3 | **Auto-Release Stock bei Cancel** | `backend/services/order-state-machine.js` → `transitionOrder()` | Wenn `toStatus === 'cancelled'` → automatisch `releaseReservation({tenantId, orderId})` aufrufen. Danach `syncStockToAllChannels()` für alle betroffenen Produkte → Bestand wieder auf Marktplätzen verfügbar. |
| 4 | **Marketplace-Cancel bei Transition** | `backend/routes/orders.js` → `/api/orders/:id/transition` (Zeile 1192-1220) | Nach erfolgreicher Transition zu "cancelled": `pushCancellationToMarketplace({order})` async aufrufen (ähnlich Pattern wie `pushTrackingToMarketplace` bei Ship). |
| 5 | **Cancel-Button im UI** | `components/OrderDetail.tsx` oder `MobileOperationsView.tsx` | "Stornieren" Button sichtbar wenn Status in [pending, confirmed, picking, picked, packing, packed]. Confirmation-Dialog mit Storno-Grund. |
| 6 | **Storno-Gründe** | `order-state-machine.js` oder `orders.js` | Cancel-Gründe definieren: "Nicht auf Lager", "Kunde hat storniert", "Defekt/Beschädigt", "Adresse ungültig", "Sonstiges". Grund wird mit `cancelReason` in Firestore gespeichert UND an Marktplatz übermittelt. |

**Datenfluss (Soll):**
```
User klickt "Stornieren" + wählt Grund
  → POST /api/orders/:id/transition { toStatus: 'cancelled', note: 'Grund' }
    → transitionOrder('cancelled') → setzt cancelledAt + cancelReason
    → releaseReservation({ orderId }) → reservierter Stock wird freigegeben
    → syncStockToAllChannels() → Bestand auf Marktplätzen aktualisiert
    → pushCancellationToMarketplace({ order })
      → eBay: POST /post-order/v2/cancellation ODER CancelTransaction
      → Kaufland: PATCH /v2/order-units/{unitId}/cancel
```

**Verifikation nach Fix:**
1. Auftrag stornieren → Status = "Storniert", cancelledAt gesetzt
2. Stock-Reservierung freigegeben → Bestand steigt
3. eBay/Kaufland erhalten Cancel-Benachrichtigung
4. Stornierter Bestand wird sofort auf anderen Marktplätzen wieder verfügbar
5. Bulk-Stornierung: Mehrere Aufträge gleichzeitig stornieren → alle Marktplätze informiert

### BUG-031 — Status-Sync zu Marktplätzen unvollständig (P1)

**Symptom:** Wenn ein Auftrag in AvyCloud auf "Versendet" gesetzt wird, wird der Marktplatz NUR informiert wenn das über den SendCloud-Ship-Flow passiert. Manueller Status-Wechsel (z.B. über Transition-Endpoint oder UI-Button) pusht NICHTS an eBay/Kaufland.

**Was BEREITS existiert (funktioniert):**

| Funktion | Datei | Zeile |
|----------|-------|-------|
| `pushTrackingToMarketplace({orderId, trackingNumber, carrier})` | `marketplace-tracking.js` | Hauptfunktion |
| eBay: `CompleteSale` mit Tracking + `<Shipped>true</Shipped>` | `marketplace-tracking.js` | 87-119 |
| Kaufland: `PATCH /v2/order-units/{unitId}/ship` mit Tracking + Carrier | `marketplace-tracking.js` | 129-180 |
| Carrier-Mapping eBay (6 Carrier) + Kaufland (8 Carrier) | `marketplace-tracking.js` | 24-48 |
| Aufruf bei Ship-Endpoint: async `pushTrackingToMarketplace()` | `orders.js` | 1328-1335 |

**Was FEHLT:**

| # | Problem | Fix |
|---|---------|-----|
| 1 | **Manueller Status→shipped pusht NICHT** | `orders.js` → `/api/orders/:id/transition` (Zeile 1192-1220): Wenn `toStatus === 'shipped'` UND Order hat `trackingNumber` → `pushTrackingToMarketplace()` aufrufen. |
| 2 | **Bulk-Transition→shipped pusht NICHT** | `orders.js` → `/api/orders/bulk-transition` (Zeile 1578-1616): Gleiche Logik — für jede auf "shipped" gesetzte Order mit Tracking → Push. |
| 3 | **Kein Status-Push für packed** | Optional P2: Kaufland unterstützt `PATCH /v2/order-units/{unitId}/send` mit Status-Updates. eBay hat kein explizites "packed" Signal. |
| 4 | **Kein Status-Push für cancelled** | → Siehe BUG-030 (separate Implementierung) |
| 5 | **Fehler-Handling: Fire-and-Forget** | `marketplace-tracking.js` loggt Fehler nur mit `console.error`. Kein Retry, kein Speichern fehlgeschlagener Pushes. → Retry-Queue analog zu BUG-028 Fix. |

**Betroffene Dateien:**

| Datei | Was ändern |
|-------|-----------|
| `backend/routes/orders.js` → `/api/orders/:id/transition` (Zeile 1192-1220) | Nach Transition: Wenn `toStatus === 'shipped'` und Order hat `trackingNumber` → `pushTrackingToMarketplace()`. Wenn `toStatus === 'cancelled'` → `pushCancellationToMarketplace()` (BUG-030). |
| `backend/routes/orders.js` → `/api/orders/bulk-transition` (Zeile 1578-1616) | Gleiche Logik für Bulk: Für jede transitionierte Order Status-spezifischen Marketplace-Push. |
| `backend/services/marketplace-tracking.js` | **Retry-Mechanismus:** Bei Fehler → in `marketplace_push_failures` Collection speichern. Listing-sync-runner oder separater Retry-Job pickt fehlgeschlagene Pushes auf. |

**Verifikation nach Fix:**
1. Auftrag manuell auf "shipped" setzen (mit vorhandener Tracking-Nr) → eBay/Kaufland erhalten Tracking
2. Bulk-Transition 5 Aufträge → shipped → alle 5 Marktplätze erhalten Tracking
3. Push-Fehler → Retry nach 60s → erfolgreicher Push beim 2. Versuch
4. Auftrag ohne Tracking auf "shipped" → Push wird übersprungen (kein leerer Tracking-Push)

---

## Waiting On

| Was | Abhängigkeit | Priorität |
|-----|-------------|-----------|
| **Multi-Tenancy** | Alle Module mit tenantId fertig, Stripe Billing | P2 |
| **Stripe Billing** | Multi-Tenancy, Pricing-Entscheidung | P3 |
| **Amazon SP-API Registrierung** | Dauert 2–4 Wochen, JETZT starten | P1 |
| **Etsy App Registrierung** | Developer Account + App Review | P2 |
| **Otto API Credentials** | OPC Portal Zugang beantragen | P2 |

---

## Someday / Backlog

- [ ] GDPR-Compliance (Data Export, Deletion, Privacy Policy, DPA-Template)
- [ ] API-Dokumentation (OpenAPI/Swagger)
- [ ] E2E-Tests mit Playwright
- [ ] CI-Integration für Tests
- [ ] Mobile App (React Native)
- [ ] White-Label-Option
- [ ] KI-Bildoptimierung ausbauen
- [ ] Request Body Limit 50MB → 10MB
- [ ] Workflow-Builder (visueller If-Then-Editor)
- [ ] International: Amazon.fr, Amazon.it, Amazon.es, Amazon.co.uk

---

## Abgeschlossene Arbeit (Archiv)

<details>
<summary>Phase 1: Security & Infrastruktur (Feb 2026) — ✅ Komplett</summary>

- ✅ P0-001: Security Headers (Helmet.js)
- ✅ P0-002: Rate-Limiting (identify: 30/15min, general: 120/min)
- ✅ P0-003: .env.local aus Git-Historie entfernt
- ✅ P0-004: Firestore Normalisierung (products_v2, USE_PRODUCTS_V2=true)
- ✅ P1-001: Structured Logging (Pino)
- ✅ P1-002: Health-Check & Graceful Shutdown
- ✅ P1-003: Vitest Infrastruktur (119 Tests, 7 Suiten)
- ✅ P1-004: Error Response Standardisierung (AppError + errorHandler)
- ✅ P1-005: Express Router Splitting (7 Module)
- ✅ P1-006: API Versioning
- ✅ P2-001: SSE für Job-Status
- ✅ P2-002: Pricing Engine
- ✅ P2-003: Inventory Forecasting
- ✅ P2-004: Webhook-System
- ✅ P2-005: Produkt-Deduplizierung
- ✅ P3-001: Competitor Intelligence
</details>

<details>
<summary>Phase 2: Daten & KI (Feb–März 2026) — ✅ Komplett</summary>

- ✅ LLM-Policy + Rulebook aktiv
- ✅ Alle Schreibpfade auf saveProductV2()
- ✅ Pricing Engine produktionsreif
- ✅ Listing-Status Realtime-Sync
- ✅ eBay/Kaufland Preis-Sync (Firestore-seitig)
- ✅ Konkurrenzpreise-System
- ✅ LLM Titel-Generierung
- ✅ Chat Intent-Detection per LLM
- ✅ Image-Generator Background Removal
- ✅ Job-Timeout + Dead-Letter-Queue
- ✅ Code-Splitting
- ✅ Error Boundary
- ✅ State Management
</details>

<details>
<summary>Phase 3: UI & Module (März 2026) — ✅ Komplett</summary>

- ✅ M1: 17 Base-Components (ui/*)
- ✅ M2: Sidebar + Topbar + Routing komplett neu
- ✅ M7: Multi-Carrier Versand-Management (Shipping Engine, Carrier-Regeln, Bulk-Label)
- ✅ M8: Retouren-Management (Returns Engine, Marketplace-Sync, Workflow)
- ✅ M13: Erfassen (KI-Stepper-Flow)
- ✅ Stock-Sync: Reservation, Multi-Channel Push, Preis-Push
- ✅ Accessibility WCAG 2.1 AA
- ✅ FAKE→REAL #1–#12 Backend-Routen erstellt (Frontend-Umbau noch offen)
</details>

<details>
<summary>Sprint-Block 9: Integrations-Strategie (März 2026) — ✅ Analyse komplett</summary>

- ✅ Task 9.4: BaseLinker Competitor-Analysis
- ✅ Task 9.5: Integration-Registrierung (integration-registry.js Konzept)
- ✅ Task 9.6: Capability-basierte Integration-Config
- ✅ Task 9.7: KI-First Auto-Config Strategie
- ✅ Task 9.7.1: Universal Taxonomy Engine Plan (Marketplace_Taxonomy_Masterplan.html)
</details>

---

## Referenz-Dokumente

| Dokument | Beschreibung | Pfad |
|----------|-------------|------|
| CLAUDE.md | Projektregeln, Architektur, Safety-Rules | `./CLAUDE.md` |
| Marketplace_Taxonomy_Masterplan.html | Taxonomy-Akquisitionsplan für alle Marktplätze | `./Marketplace_Taxonomy_Masterplan.html` |
