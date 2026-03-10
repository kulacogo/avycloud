# TASKS.md — AvyCloud Roadmap & Task-Management

> **Letzte Aktualisierung:** 2026-03-10
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
| **Code-Qualität** | ✅ | 7 Router-Module, API Versioning, 119 Vitest-Tests |
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
| **M5: Marktplatz-Views** | ⚡ UI fertig | FAKE→REAL Umbau (echte API-Calls) |
| **M6: OMS** | 🔴 Geplant | Eigenständiges Order Management |
| **M9: Integrations-Hub** | 🔴 Kein Self-Service | Wizard + Auth-Flows fehlen komplett |
| **M10: Analytics** | 🔴 Geplant | Dashboard-Überarbeitung + Reports |
| **M11: Einstellungen** | ⚡ UI fertig | Backend FAKE→REAL |
| **M12: Lagerverwaltung** | ⚡ Settings fertig | Zonen/Bins/Inventur fehlen |
| **M-AUTO: Automatisierung** | 🔴 Geplant | Bulk-Import, Repricing-UI |
| **FAKE→REAL** | 🔴 12 Views | Mock-Daten durch echte API-Calls ersetzen |
| **Universal Taxonomy** | 🔴 Geplant | Marktplatz-Kategorien für neue Integrationen |

---

## Roadmap — Wochen-Plan

> **Prinzip:** Erst stabilisieren (FAKE→REAL), dann ausbauen (neue Features), dann skalieren (Integrationen).

### Phase A: Foundation & Stabilisierung (KW 11–14)

#### KW 11 (10.–14. März 2026) — FAKE→REAL + Bug-Fixes
- [ ] **FAKE→REAL: MarketplaceListingsView** — Mock-Daten raus, echte eBay/Kaufland API-Calls
- [ ] **FAKE→REAL: IntegrationsHub** — Echte Verbindungsstatus aus Backend
- [ ] **FAKE→REAL: CompanySettings** — Firestore speichern/laden
- [ ] **FAKE→REAL: ProfileSettings** — Firestore + Firebase Auth
- [ ] **FAKE→REAL: OrderSettings** — Firestore speichern/laden
- [ ] **FAKE→REAL: WarehouseSettings** — Firestore speichern/laden
- [ ] **BUG: "Demnächst verfügbar" global entfernen** — Alle MOCK_*, setTimeout-Fakes, Coming-Soon
- [ ] **BUG: eBay Preis-Push** — Firestore-Update geht, aber Listing-Preis wird nicht zu eBay gepusht

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

#### KW 14 (31. März – 4. April 2026) — M6 OMS Phase A + M10
- [ ] **M6-A1: Marketplace Order Intake** — Bestellungen direkt von eBay/Kaufland
- [ ] **M6-A2: Eigene Status-Engine** — Unabhängig von BaseLinker
- [ ] **M6-A3: Eigene Auftrags-Nummerierung** — Konfigurierbare Nummernkreise
- [ ] **M6-A4: Order-Detail-Seite** — Komplettes Order-Detail-Panel
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
| 1 | MarketplaceListingsView | MOCK_LISTINGS | Alle eBay/Kaufland API-Calls in api/client.ts | 🔴 |
| 2 | IntegrationsHub | Hardcodierte Cards | GET /api/integrations/status | 🔴 |
| 3 | CompanySettings | Beispieldaten, setTimeout Save | — (Backend NEU) | 🔴 |
| 4 | ProfileSettings | Hardcodierte Profildaten | requestPasswordReset() existiert | 🔴 |
| 5 | OrderSettingsView | INITIAL_RULES/STATUSES/RANGES | — (Backend NEU) | 🔴 |
| 6 | WarehouseSettingsView | DEFAULT_ZONE_TYPES, setTimeout | Warehouse-Routes teilweise | 🔴 |
| 7 | ApiSettings | — | ✅ BEREITS REAL | ✅ |
| 8 | ShippingView | MOCK_SHIPMENTS | sendcloud.js, baselinker-shipping.js | 🔴 |
| 9 | InvoicesView | MOCK_INVOICES | sevdesk.js | 🔴 |
| 10 | ReturnsView | MOCK_RETURNS | returns-engine.js | 🔴 |
| 11 | BillingSettings | Hardcodierte Plan/Usage | adminGetProductCoverageMetrics() | 🔴 |
| 12 | Global | "Demnächst verfügbar", MOCK_*, setTimeout | — | 🔴 |

---

## Aktive Bugs

| ID | Beschreibung | Priorität | Status |
|----|-------------|-----------|--------|
| BUG-020 | eBay Preis wird in Firestore aktualisiert aber NICHT zum Listing gepusht | P0 | ✅ Fixed (property path mismatch: `product.pricing` → `product.details.pricing`) |
| BUG-021 | eBay Publish: Blocker-Gründe im UI nicht sichtbar | P1 | ✅ Fixed (nested response unwrapping + blocker display in UI) |
| BUG-022 | Inventar eBay-Indikator zeigt falschen Status | P1 | ✅ Fixed (SKU-index priority over stale ops.listingStatus) |
| BUG-023 | Kaufland-Tabelle zeigt nichts Brauchbares | P1 | ✅ Fixed (responsive classes, brand field, image thumbnail) |
| BUG-024 | Marketplace-Tabellen haben keinerlei UX | P1 | ✅ Fixed (column sorting, rows-per-page, stock filter) |
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
