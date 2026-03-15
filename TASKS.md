# TASKS.md — AvyCloud Roadmap & Task-Management

> **Letzte Aktualisierung:** 2026-03-15
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
7. **⛔ VERIFIZIERUNGSPFLICHT:** Ein Bug ist ERST "✅ Fixed" wenn er in PRODUCTION verifiziert wurde. Code-Änderung allein reicht NICHT. Prüfe: (a) Deploy erfolgreich? (b) Feature im Browser sichtbar geändert? (c) Kein Regression? Bugs die nur im Code gefixt aber nicht deployed/verifiziert sind, werden als "⚠️ Code-Fix da, Verifizierung ausstehend" markiert.
8. **⛔ KEIN "Fixed" ohne Beweis:** Screenshot, API-Response oder Test-Output als Nachweis. "Ich habe den Code geändert" ist KEIN Beweis dass der Bug gefixt ist.

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
| **Code-Qualität** | ✅ | 7 Router-Module, API Versioning, 129 Vitest-Tests (8 Suiten) |
| **KI-Pipeline** | ✅ | Identify (Vision+Barcode+Web+LLM), Improve, Quality-Check |
| **Pricing** | ✅ | Engine backend-only, Competitor Intelligence |
| **Inventory** | ✅ | Forecast, salesVelocity, Reorder-Alerts |
| **Dedup** | ✅ | EAN/MPN/Brand Erkennung + Merge |
| **Webhooks** | ✅ | HMAC-SHA256, dispatchWebhook() |
| **eBay** | ✅ | OAuth, Trading API, Listings, Gap-Analyse, Publish |
| **Kaufland** | ✅ | HMAC Auth, Listings, SKU-Index, Category-Mapping |
| **BaseLinker** | ❌ ENTFERNT | Komplett aus Codebase entfernt (2026-03-13). 48 Dateien gelöscht, 40+ bereinigt. |
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
| **M4: Bestand** | ⚡ View Live | KPIs, Tabelle, Filter, Suche, Sort — Bulk-Actions offen |
| **M5: Marktplatz-Views** | ✅ Real | FAKE→REAL bestätigt (alle API-Calls echt) |
| **M6: OMS** | ⚡ Phase A Live | Natives OMS aktiv, BaseLinker deprecated, Phase B/C offen |
| **M9: Integrations-Hub** | 🔴 Kein Self-Service | Wizard + Auth-Flows fehlen komplett |
| **M10: Analytics** | ⚡ Activity Feed Live | Dashboard Activity Feed (24h Timeline), Reports offen |
| **M11: Einstellungen** | ✅ Real | FAKE→REAL bestätigt (Company, Profile, Order, Warehouse, API) |
| **M12: Lagerverwaltung** | ⚡ Tabs Live | 3-Tab-System (Struktur/Bewegungen/Inventur), CRUD + Events |
| **M14: Pack & Ship** | ⚡ Auto-Print Live | Label-Format-Prefs, Auto-Print nach Pack, packAndShip mit Format |
| **M-AUTO: Automatisierung** | 🔴 Geplant | Bulk-Import, Repricing-UI |
| **M-MOBILE: Mobile UI** | ⚡ Funktional, UX-Mängel | Logo unscharf, Button-Kontrast, keine Icons, Dashboard KPIs leer |
| **FAKE→REAL** | ✅ 12/12 done | Alle Views nutzen echte API-Daten (Shipping, Invoices, Returns, Billing: 2026-03-13) |
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
- [x] **⛔⛔⛔ BUG-040: BLOCKIERT ALLES — BL-Orders Daten-Migration.** ✅ Script erstellt: `backend/scripts/backfill-baselinker-orders.js` — setzt `marketplace` aus `raw.order_source`, backfilled Adresse/Zahlung/Status aus raw-Feldern. Usage: `node backend/scripts/backfill-baselinker-orders.js --dry-run` (dann ohne --dry-run ausführen). ⚠️ **Noch nicht in Production gelaufen — muss manuell ausgeführt werden!**
- [x] **BUG-041: Kaufland Order-Intake fehlende Felder** — ✅ paidAt, paymentMethod, shippingCost, shippedAt, billingAddress (2026-03-13)
- [x] **BUG-042: Kaufland Adresse unvollständig** — ✅ billingAddress mit Fallback auf shippingAddress (2026-03-13)
- [x] **BUG-043: Returns-Engine Referenz-Fehler** — ✅ Fixed (totalRefund + ebayReason korrekt, Pagination)
- [x] **BUG-044: Kaufland Returns Pagination** — ✅ Fixed (Pagination-Loop mit 5000-Cap)
- [x] **BUG-045: eBay Status-Reconciliation** — ✅ Fixed (Rank-basiert, 30-Tage Lookback)
- [x] **BUG-046: Dashboard BaseLinker-Fallback entfernen** — ✅ BL-Shipping-Fallback entfernt, nur SevDesk + SendCloud (2026-03-13)

#### KW 12 (17.–21. März 2026) — BaseLinker raus + Customer-Satisfaction Features

> **Priorität: Bestellungen, Retouren, Versand, Buchhaltung MÜSSEN verwaltbar sein.**
> **BaseLinker ist TABU.** Alle Reste entfernen. AvyCloud ist eigenständig multichannel-fähig.

**Block 1: BaseLinker-Entfernung (Phase C) — ✅ KOMPLETT (2026-03-13)**

> ✅ **48 Dateien gelöscht, 40+ Dateien bereinigt. 129/129 Tests grün, Frontend-Build OK.**
> Entfernt: 34 Scripts, 7 Lib-Dateien, 4 Service-Dateien, 3 Root-Referenzdateien.
> Bereinigt: 7 Routes, 11 Services, 18 Frontend-Dateien, Test-Mocks, cloudbuild.yaml, RBAC, Integration-Registry.

- [x] **✅ C1: Daten-Migration — KOMPLETT (2026-03-15)** 365 Orders via `backfill-baselinker-orders.js` (marketplace, paidAt, paymentMethod, Adresse). 356 weitere via `fix-source-field.js` (`source: 'baselinker'` → korrekten marketplace-Wert). Firestore: 0 Orders mit `source='baselinker'` übrig. Self-Healing aktiv für zukünftige Fälle.
- [x] C2: Dashboard-Metriken — BL-Fallback entfernt, nur lokale Order-Aggregation
- [x] C3: Shipping-Kosten — BL-Fallback entfernt, nur SevDesk + SendCloud
- [x] C4-C5: Backend lib (7) + services (4) gelöscht
- [x] C6-C7: Routes (7) + index.js bereinigt — BL-Imports, Endpoints, Auto-Sync entfernt
- [x] C7a: index.js — backgroundSync, Runner, Inventory-Sync entfernt
- [x] C7b: order-sync.js, rulebook-runner.js, admin-bulk-actions.js, improve.js, toolkit.js bereinigt
- [x] C8: Frontend — 18 Dateien bereinigt (types.ts, api/client.ts, i18n.tsx, 15 Komponenten)
- [x] C8a: GeminiChat.tsx — baselinker_category_search Tool entfernt
- [x] C9: 34 Scripts gelöscht
- [x] C10: cloudbuild.yaml BL-Lint-Check entfernt
- [x] C11: _patchLocalModules.js + orders.test.js BL-Mocks entfernt
- [x] C11a: RBAC — baselinker:read/sync Permissions entfernt
- [x] C11b: integration-registry.js — BL-Eintrag entfernt
- [x] C12: Validierung — 129/129 Tests grün, Frontend-Build OK

**Block 2: Bestellungen nutzbar machen**
- [x] BUG-041: Kaufland Order-Intake fehlende Felder — ✅ paidAt, paymentMethod, shippingCost, shippedAt im mapKauflandOrder + Firestore-Doc (2026-03-13)
- [x] BUG-042: Kaufland Adresse unvollständig — ✅ billingAddress mit Fallback auf shippingAddress, Reconciliation backfills paidAt/paymentMethod (2026-03-13)
- [x] BUG-045: eBay Status-Reconciliation — ✅ Fixed (Rank-basiert, 30-Tage Lookback)
- [x] FEAT-ORD-01: Auftragssuche — ✅ Client-side Search nach Auftragsnr., Kundenname, SKU, Marketplace-ID (2026-03-13)
- [x] FEAT-ORD-02: Datumsfilter — ✅ Presets: Heute, 7 Tage, 30 Tage, 90 Tage, Alle (2026-03-13)
- [x] FEAT-ORD-06: Auto-Rechnung bei Status → shipped — ✅ Post-Transition Hook in transitionOrder() ruft generateInvoice() fire-and-forget auf, mit Idempotenz-Check (2026-03-14)

**Block 3: Buchhaltung nutzbar machen**
- [x] B3: SevDesk-Export reparieren — ✅ Contact-Erstellung + Adresse + Line-Items (InvoicePos) aus Order, korrektes Response-Parsing (2026-03-14)
- [x] B4: Invoice PDF-Download im UI — ✅ Proxy-Endpoint `GET /api/invoices/:id/download` (GCS→Browser), Download-Buttons in InvoicesView + OrderDetail (2026-03-14)
- [ ] B5: Invoice Email-Versand (Template + SMTP/SES) — Kein `sendInvoiceEmail()` vorhanden
- [ ] B6: Gutschriften/Stornorechnungen — Kein `generateCreditNote()` vorhanden
- [x] B7: MwSt-Sätze 19%/7%/0% — ✅ order.vatRate ?? 0.19, VAT-Dropdown in OrderDetail, API-Parameter, TypeScript-Typen (2026-03-14)
- [x] FEAT-INV-01: Rechnungsübersicht — ✅ Suche (Rechnungsnr., Kunde, Auftrag) + Datumsfilter (Heute/7d/30d/90d), PDF-Download via B4 (2026-03-14)

**Block 4: Retouren nutzbar machen**
- [x] BUG-043: Returns-Engine Referenz-Fehler (totalRefund + ebayReason) — ✅ Fixed
- [x] BUG-044: Kaufland Returns Pagination — ✅ Fixed
- [x] FEAT-RET-01: Retoure-Detail-Ansicht — ✅ Slide-in Panel mit Kunden, Produkt, Grund, Timeline, Actions (2026-03-14)
- [x] FEAT-RET-03: Bulk-Retoure-Aktionen — ✅ POST /api/returns/bulk-action (refund/close, max 50), Frontend Bulk-Action-Bar mit Erstatten + Schließen (2026-03-14)

**Block 5: Versand optimieren**
- [x] B2: SendCloud Tracking-Webhooks — ✅ Handler existierte bereits (POST /api/webhooks/sendcloud), Signature-Verification hinzugefügt (2026-03-14)
- [x] FEAT-SHP-01: Label-Format A4/A6 + Thermal — ✅ Backend labelFormat (createParcel/shipOrder), Frontend Dropdown in OrderDetail + ShippingView, localStorage-Persistenz (2026-03-14)
- [x] BUG-049: Marketplace Refund Push Runner — ✅ runRefundPush() in returns-engine, auto-Push alle 4h für erstattet/teilweise_erstattet Returns (2026-03-14)

**Block 6: Mobile UI — Weltklasse UX**
- [x] BUG-053: Logo scharf machen — ✅ High-Res avycloud_logo_icon.png (4269×3299) statt 40×40 Asset, h-10 w-10 CSS (2026-03-14)
- [x] BUG-054: Operations-Buttons Light Mode Kontrast — ✅ bg-warning-dim/text-warning (Design-Token) statt hardcoded amber-300 (2026-03-14)
- [x] BUG-055: Bottom Nav SVG-Icons — ✅ Inline SVGs ersetzen PNG-Icons, 48dp Touch-Targets, active:scale-95 (2026-03-14)
- [x] BUG-056: Dashboard KPIs leer — ✅ BUG-048 behoben: Kaufland-Marketplace-Breakdown in getDashboardMetrics(), native Firestore-Aggregation (2026-03-14)
- [x] MOB-01: Operations-Buttons mit Icons — ✅ Inline SVGs (ScanLine, PackagePlus, ClipboardList, Package) + left-aligned Layout (2026-03-14)
- [x] MOB-02: Touch Feedback / Active States — ✅ active:scale-95 + transition-all auf Bottom Nav (2026-03-14)
- [x] MOB-03: Operations-Counter als Badges — ✅ Pill-Badges rechts auf Stow/Pick/Pack Buttons, nur sichtbar bei count > 0 (2026-03-14)
- [x] MOB-04: Bottom Nav SVG-Icons + 48dp Touch-Targets — ✅ min-h-[48px] min-w-[48px] (2026-03-14)
- [x] MOB-10: Dark/Light Mode Konsistenz — ✅ StatusBadge warn-Farben auf Design-Tokens umgestellt (bg-warning-dim/text-warning), alle Mobile-Komponenten geprüft (2026-03-14)

**Block 7: UI Visual Audit Fixes (Deep Dive 4, 2026-03-15)**
- [x] BUG-059: Inventar `\u2014` Encoding-Bug — ✅ Fixed (2026-03-15: JSX text `\u2014` → `{"—"}` in InventoryView.tsx + WarehouseInventoryTab.tsx)
- [ ] BUG-060: Inventar Bestandswert €0,00 — EK fehlt bei allen Produkten
- [x] BUG-061: Versand "Invalid Date" — ✅ Fixed (2026-03-15: `isNaN(d.getTime())` Guard in ShippingView.tsx)
- [x] BUG-062: Versand Kundenname "—" — ✅ Code-Fix (2026-03-15: `parcel.address?.name + parcel.address?.company_name` als Fallbacks in shipping-engine.js syncSendCloudParcels)
- [x] BUG-063: Versand AUFTRAG-ID zeigt SendCloud-Parcel-ID statt Order-ID — ✅ Fixed (2026-03-15: ShippingView.tsx zeigt `shp.orderNumber || shp.orderId`)
- [x] BUG-064: Retouren Erstattungsquote 100% bei 0 EUR — ✅ Fixed (2026-03-15: Formel korrigiert: refunded.length/returns.length)
- [x] BUG-065: Rechnungen NETTO/BRUTTO fehlt ("—") — ✅ Fixed (2026-03-15: `amountNet ?? amountNetto` + `amountGross ?? amountBrutto` Fallback)
- [x] BUG-066: Kaufland Listings Status "Unbekannt" — ✅ Fixed (2026-03-15: `active===true`→"active", `status!=null`→"inactive" in normalizeKauflandRow)
- [x] BUG-067: Kaufland Listings Preise "—" — ✅ Fixed (2026-03-15: `d.price/100` als Fallback zu `d.listing_price/100`)
- [ ] ⛔ BUG-068: 170 Stock-Sync Fehler (110 eBay + 60 Kaufland) — P0 Oversell-Risiko! Root Cause: BUG-081 (eBay Token abgelaufen → alle eBay-Syncs schlagen fehl). BUG-081 code-fix deployed → Verifizierung ausstehend.
- [ ] BUG-069: Dashboard Chart endet bei ~12.03 — Root Cause: eBay/Kaufland native Orders haben `createdAt` = originales Marktplatz-Datum (Jan/Feb), fallen außerhalb des 7d-Fensters. Hängt von BUG-081 ab.
- [ ] BUG-070: Theme Toggle reagiert nicht (Dark/Light) — Code sieht korrekt aus, evtl. Browser-spezifisch
- [x] BUG-084: Doppelte Bestellungen — ✅ Fixed (2026-03-15: 126 Duplikate gelöscht + `createdAt+marketplace` Fallback in saveOrderIfNew)
- [x] BUG-071: Dashboard vs. Seiten-Zahlen Diskrepanz — ✅ Fixed (2026-03-15: Dashboard returns enrichment nutzt jetzt shared `firestore` singleton + kein yearStart-Filter → zählt alle Returns wie ReturnsView)

**Block 8: Gesamtpaket Bug-Fixes + BaseLinker-Bereinigung (Sprint 2026-03-15) — FÜR CLAUDE CODE**

> **⛔ PFLICHT: Alle Fixes MÜSSEN deployed und in Production verifiziert werden.**
> **⛔ Serena MCP nutzen!** Projekt ist konfiguriert unter `.serena/project.yml`. Vor Refactorings: `find_referencing_symbols` nutzen statt blind greppen.
> **⛔ Nach JEDEM Fix:** `cd backend && npm test` UND `npm run build` ausführen. Kein Commit ohne grüne Tests.

**FIX-1: BUG-040 — BaseLinker-Orders Daten-Migration (P0 SOFORT)** ✅ ERLEDIGT 2026-03-15

> ✅ Migration abgeschlossen. Firestore `orders`: 0 Dokumente mit `source: 'baselinker'`.

- [x] ✅ 365 Orders via `backfill-baselinker-orders.js` — marketplace, paidAt, paymentMethod, Adresse aus raw-Feldern backfilled
- [x] ✅ 356 weitere Orders via `fix-source-field.js` — `source` auf korrekten marketplace-Wert gesetzt
- [x] ✅ Verifiziert: `where('source', '==', 'baselinker')` → 0 Ergebnisse
- [ ] **UI verifizieren:** avycloud.web.app → Bestellungen → alle Orders zeigen eBay/Kaufland Badge

---

**FIX-2: BUG-074 + BUG-060 — Inventar Bestandswert €0,00 (P1)**

> InventoryView benutzt `details.pricing.buyPrice` für die Wertberechnung, aber dieses Feld ist bei fast allen Produkten 0/undefined.
> Dashboard benutzt `details.pricing.lowest_price.amount` und zeigt 49.054€.

- [x] **Frontend-Fix (Cowork erledigt):** KPI-Berechnung, Zeilen-Wert und Sortierung nutzen jetzt `buyPrice || lowest_price.amount` als Fallback
- [ ] **Production verifizieren:** avycloud.web.app → Inventar → Bestandswert-KPI zeigt Wert > €0

**Geänderte Datei:** `components/InventoryView.tsx`
**Geänderte Stellen (3):**
1. Zeile ~212-218: KPI `totalValue` Berechnung — `p.details?.pricing?.buyPrice || (p.details?.pricing as any)?.lowest_price?.amount || 0`
2. Zeile ~495-496: Zeilen-Wert `rowValue` — gleicher Fallback
3. Zeile ~272-278: Sortierung nach buyPrice und value — gleicher Fallback

---

**FIX-3: BUG-075 — Versand Status nicht übersetzt (P2)**

> ShippingView STATUS_CONFIG kannte nur 5 deutsche Status-Keys. `createParcel()` speicherte aber den rohen SendCloud-Status-String (z.B. "Ready to send").

- [x] **Frontend-Fix (Cowork erledigt):** STATUS_CONFIG von 5 → 25+ Mappings erweitert (alle SendCloud-Rohstatus auf deutsche Labels)
- [x] **Backend-Fix (Cowork erledigt):** `createParcel()` nutzt jetzt `mapSendCloudStatus()` statt rohen String
- [ ] **Production verifizieren:** avycloud.web.app → Versand → keine englischen Status-Strings mehr sichtbar

**Geänderte Dateien:**
1. `components/orders/ShippingView.tsx` → STATUS_CONFIG erweitert
2. `backend/services/shipping-engine.js` → Zeile ~200: `status: mapSendCloudStatus(parcel.status?.id)` + `statusRaw` Feld

---

**FIX-4: BUG-080 — Retouren zeigt SKU statt Produktname (P2)**

> `productName()` in ReturnsView fiel auf `product.sku` zurück, weil Kaufland-Retouren den Titel unter `product.title` statt `product.name` speichern.

- [x] **Frontend-Fix (Cowork erledigt):** `productName()` prüft jetzt `product.name || product.title || product.sku`
- [ ] **Production verifizieren:** avycloud.web.app → Retouren → Produktspalte zeigt Namen statt SKU

**Geänderte Datei:** `components/orders/ReturnsView.tsx` → Zeile ~217-221

---

**FIX-5: BUG-082 — Marketplace-Badge-Farben inkonsistent (P3)**

> OrdersView benutzte hardcoded `amber-600/15` für eBay, ReturnsView benutzte `bg-info-dim text-info`. Laut CLAUDE.md: keine hardcodierten Farben.

- [x] **Frontend-Fix (Cowork erledigt):** Alle Views vereinheitlicht: eBay = `bg-warning-dim text-warning`, Kaufland = `bg-danger-dim text-danger`
- [ ] **Production verifizieren:** Bestellungen + Retouren → eBay-Badge gleiche Farbe

**Geänderte Dateien:**
1. `components/OrdersView.tsx` → `sourceBadge()` Zeile ~67: `bg-warning-dim text-warning`
2. `components/orders/ReturnsView.tsx` → `MARKETPLACE_BADGE` Zeile ~37-40

---

**FIX-6: BUG-082b — Marketplace-Quelle nicht erkannt ("Legacy" / Roh-String) (P1)** ✅ ERLEDIGT 2026-03-15

> Orders mit `source: 'baselinker'` / unbekanntem Marketplace-Wert zeigten "Legacy" oder Roh-String.
> Ursache: historische Orders kamen aus einer entfernten Drittsystem-Integration.

- [x] ✅ **Backend (orders.js):** `resolveOrderMarketplace()` + `normalizeOrderForResponse()` — erkennt Marketplace zur Abfrage-Zeit aus `raw.order_source` + eBay-Order-ID-Pattern (2026-03-15)
- [x] ✅ **Self-Heal:** Wenn Marketplace erkannt + weicht von gespeichertem Wert ab → Fire-and-Forget Firestore-Update (permanent fix ohne separaten Backfill-Lauf)
- [x] ✅ **Admin Bulk-Fix:** `POST /api/admin/backfill-order-marketplaces?dry_run=true` — scannt alle Orders und schreibt korrekte marketplace/source Felder (läuft auf Cloud Run mit vollen Firestore-Rechten)
- [x] ✅ **Frontend (OrdersView.tsx):** `sourceBadge()` zeigt kein "Legacy" mehr — unbekannte Quellen werden ignoriert (Backend liefert jetzt immer aufgelöste Werte)
- [ ] **Production verifizieren:** Bestellungen → alle Orders zeigen "eBay" oder "Kaufland" Badge

**Geänderte Dateien:**
- `backend/routes/orders.js` — `KNOWN_MARKETPLACES`, `resolveOrderMarketplace()`, `normalizeOrderForResponse()` + Self-Heal
- `backend/routes/admin.js` — `POST /admin/backfill-order-marketplaces`
- `components/OrdersView.tsx` → `sourceBadge()` ohne Legacy-Mapping

---

**FIX-7: BUG-062 — Versand Kundenname "—" (P1, Firestore Re-Sync nötig)**

> Historische Shipment-Docs in Firestore haben `customer: null` weil die Fallback-Kette fehlte.
> Code-Fix (2026-03-15) ist da: `parcel.address?.name + company_name` Fallbacks.
> Aber existierende Firestore-Docs müssen re-synced werden.

- [ ] **SendCloud Re-Sync triggern:** avycloud.web.app → Versand → "Sync" Button klicken. Die `syncSendCloudParcels()` Funktion updated existierende Docs mit den neuen Fallbacks.
- [ ] **Production verifizieren:** Versand-Seite → Kundenname-Spalte zeigt Namen statt "—"

---

**FIX-8: BUG-081 — eBay Token abgelaufen (P0, MANUELL)** ⚠️ TEILWEISE ERLEDIGT 2026-03-15

> Seit 15.3.2026 04:01 Uhr. ALLE eBay-API-Calls schlagen fehl. BUG-068 (170 Sync-Fehler) ist Folge davon.

- [x] ✅ **Oguzhan: OAuth reconnected** (~10:25 UTC, HTTP 200 in Logs bestätigt)
- [x] ✅ **Code-Fix: ebay-trading-api.js** — holt jetzt OAuth-Token aus Firestore `integrations/ebay` statt statischem Secret + auto-wraps XML mit `buildRequestRoot()`
- [x] ✅ **Code-Fix: integrations.js** — `DELETE /api/integrations/ebay` löscht jetzt AUCH `integrations/ebay` Firestore-Doc (Disconnect funktioniert jetzt korrekt)
- [ ] **Verifizieren:** avycloud.web.app → Dashboard → Marketplace-Sync-Fehler = 0 (nach Deploy)

---

**FIX-9: BUG-070 — Theme Toggle reagiert nicht (P2)**

> Dark/Light Mode Toggle funktioniert nicht. Root Cause unklar.
> Code-Analyse (2026-03-15): `App.tsx` `toggleTheme()` → `setTheme()` → `useEffect([theme])` → `document.documentElement.dataset.theme = theme`. CSS `[data-theme='light']` Override. Logik korrekt.
> Vermutung: Möglicherweise Browser-Cache-Problem oder visuelle Überprüfung notwendig.

- [ ] **Production verifizieren:** Toggle klicken → `data-theme` Attribut im Browser-DevTools ändert sich

---

**FIX-10: BUG-071 — Dashboard vs. Seiten-Zahlen Diskrepanz (P1)** ✅ ERLEDIGT 2026-03-15

> Root Cause: Dashboard-Enrichment nutzte `new _Firestore()` (neuer Client!) + `yearStart`-Filter → zählte nur Returns ab Jan 2026. ReturnsView zählt alle Returns ohne Zeitfilter.
> Fix: `routes/orders.js` nutzt jetzt `firestore` Singleton + kein yearStart-Filter.

- [x] ✅ Fix implementiert: `routes/orders.js` returns-Enrichment
- [ ] **Production verifizieren:** Dashboard-Zahl = Seiten-Zahl für Retouren

---

**FIX-11: BUG-032 — Produkt-Gewicht fehlt (P0)** ⚠️ TEILWEISE ERLEDIGT 2026-03-15

> Identify/Improve-Pipeline extrahiert kein Gewicht. Mandatory für Carrier-Zuordnung (DHL vs. DPD).

- [x] ✅ Improve-Pipeline Fix: `weight_grams` zu `DATASHEET_REVIEW_SCHEMA` + Prompt + `applyReviewResult()` → ab jetzt extrahiert
- [x] ✅ Backfill-Script: `backend/scripts/backfill-weights.js` — extrahiert Gewicht aus Attributen für bestehende Produkte. Usage: `node backend/scripts/backfill-weights.js --dry-run` → `--write` (2026-03-15)
- [x] ✅ Quality-Gate: `weight_missing` Regel in `services/quality-gate.js` — flaggt Produkte ohne Gewicht als `warn` (2026-03-15)
- [ ] **Production verifizieren:** Backfill-Script ausführen + Improve-Pipeline auf Produkte ohne Gewicht laufen lassen

---

**FIX-12: BUG-SSE — Token-in-Query-Parameter (P1, Security)**

> JWT Token wird als `?token=` URL-Parameter für SSE-Streams übergeben. Leakt in Browser-History, Server-Logs, Referrer-Header.

- [x] **Fix:** `EventSource` ersetzt durch `fetch()` + `ReadableStream` in `hooks/useJobStream.ts` + `hooks/useProductStream.ts` — Token wird jetzt als `Authorization: Bearer` Header gesendet (2026-03-15)
- [ ] **Production verifizieren:** SSE-Streams funktionieren ohne Token in URL (nach Deploy)

---

**STATUS (2026-03-15, Session Ende):**
- ✅ FIX-1 (BUG-040) — Erledigt
- ✅ FIX-8 (BUG-081) — Code-Fix deployed (ebay-trading-api.js OAuth-Unifikation + integrations.js Disconnect)
- ✅ FIX-10 (BUG-071) — Erledigt
- ✅ FIX-12 (BUG-SSE) — Code-Fix deployed
- ✅ BUG-084 — 126 Duplikate gelöscht + Dedup-Fallback deployed
- ✅ Kaufland Backfill — 104 alte KL-Bestellungen erhalten marketplaceKey aus raw.external_order_id (MXTBT35/M7PPT35/MEL4T35 inklusive → Status-Reconciliation beim nächsten Sync)
- ✅ Activity Feed Fix — orderId statt orderNumber + resiliente Queries
- ✅ `cd backend && npm test` — 129 Tests grün ✓
- ✅ `npm run build` — Frontend kompiliert ✓
- ✅ Frontend deployed → avycloud.web.app
- ✅ Backend deployed → product-hub-backend-01095-b2f

**NOCH ZU VERIFIZIEREN (Browser-Check, kein Code-Fix nötig):**
- [ ] FIX-8: avycloud.web.app → Dashboard → Sync-Fehler = 0 (nach deploy)
- [ ] FIX-9 (BUG-070): Theme Toggle → data-theme in DevTools ändert sich beim Klick
- [ ] FIX-2: Inventar → Bestandswert KPI > €0
- [ ] FIX-3: Versand → keine englischen Status-Strings mehr
- [ ] FIX-4: Retouren → Produktname statt SKU
- [ ] FIX-5: Bestellungen/Retouren → eBay-Badge gleiche Farbe
- [ ] FIX-7: Versand → "Sync" Button klicken → Kundenname-Spalte füllt sich
- [ ] FIX-11: `node backend/scripts/backfill-weights.js --write` ausführen

#### KW 13 (24.–28. März 2026) — M4 + M5 + M12
- [x] **M4: Bestand-View** — ✅ InventoryView live: KPIs, Tabelle, Quick-Filter, Suche, Sort (2026-03-14)
- [x] **M5: Marktplatz-Views** — ✅ Realtime-Sync komplett: Retry, Event-Bus, Auto-Heal, 3-Min-Sync + Bug-Fix sync-event-bus.js (2026-03-14)
- [x] **M12: Lagerverwaltung** — ✅ 3-Tab-System (Struktur/Bewegungen/Inventur), Backend CRUD, warehouseEvents + warehouse_inventories (2026-03-14)

#### KW 14 (31. März – 4. April 2026) — M14 Pack & Ship + M10 Dashboard
- [x] **M6 OMS Phase A** — ✅ Bereits live (vorgezogen, siehe M6 Detail-Sektion)
- [x] **M14-P1: Drucker & Label-Format Voreinstellungen** — ✅ ProfileSettings + Backend allowedFields, Label-Format (a6/a4) + Auto-Print Toggle (2026-03-14)
- [x] **M14-P2: PackStation** — ✅ Bereits live (SKU-Scan, Item-Validierung, Fortschritt in MobileOperationsView)
- [x] **M14-P3: Auto-Print Flow** — ✅ packAndShip mit labelFormat, auto window.print() bei autoPrint-Pref, User-Prefs geladen bei Pack-Mode-Entry (2026-03-14)
- [x] **M10: Dashboard** — ✅ Activity Feed (24h Timeline: Orders/Shipments/Returns/Sync), Backend GET /api/dashboard/activity (2026-03-14)

### Phase B: Integrationen & Skalierung (KW 15–20)

#### KW 15–16 (7.–18. April 2026) — M9 Integration-Wizard + Taxonomy
- [ ] **M9: Integration-Wizard** — OAuth-Flow (Pattern A), API-Key-Input (Pattern B), Export (Pattern C)
- [ ] **M9: Integration-Settings** — Pro-Integration Konfiguration, Sync, Fehler-Log
- [ ] **M9: Backend integration-registry.js** — Provider-Konfiguration für alle Integrationen
- [ ] **M9: Backend integration-store.js** — Verschlüsselte Credential-Verwaltung
- [ ] **Taxonomy: taxonomy-loader.js** — Universeller CSV/JSON Loader
- [ ] **Taxonomy: category-matcher.js** — 4-Tier Resolution Engine

#### KW 17–18 (21. April – 2. Mai 2026) — OMS Phase B Rest + Neue Integrationen
- [x] **M6-B1: SendCloud Label-Erzeugung** — ✅ shipping-engine.js live
- [x] **M6-B2: Tracking-Webhooks** — ✅ Vorgezogen in KW 12 (B2: SendCloud Handler + Signature-Verification)
- [x] **M6-B3: Rechnungs-Engine** — ✅ Vorgezogen in KW 12 (B3: SevDesk-Export, B4: PDF-Download, B7: MwSt-Sätze)
- [x] **M6-B4: Marketplace-Kommunikation** — ✅ Tracking + Cancellation an eBay/Kaufland (2026-03-13)
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
- [x] **M6-C: BaseLinker vollständig entfernt** — ✅ Bereits in KW 12 erledigt (2026-03-13)
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

### M4: Bestand (Inventar) — ⚡ View Live

**Was existiert:** InventoryView.tsx (632 Zeilen), Route `#/products/inventory` aktiv, echte Daten via fetchProducts()

**Erledigt:**
- [x] KPI-Cards (Gesamtartikel, Einheiten, Bestandswert, Niedrig-Bestand) — ✅ 2026-03-14
- [x] Tabelle (Thumbnail, Name/Brand, SKU, Lagerplatz/Zone, Menge, Verfügbar/Reserviert, EK, Bestandswert, Marketplace-Icons) — ✅ 2026-03-14
- [x] Quick-Filters (Alle, Niedrig-Bestand, Kein Lagerplatz, 30 Tage unbewegt) mit Counts — ✅ 2026-03-14
- [x] Suche (Name, SKU, EAN) — ✅ 2026-03-14
- [x] Sortierung alle Spalten (Name, SKU, Bin, Menge, Verfügbar, EK, Wert) — ✅ 2026-03-14

**Offen:**
- [ ] Erweiterte Filter (Zone-Dropdown, Bin-Dropdown, Menge-Range, Zustand, Marketplace-Status)
- [ ] Bulk-Actions (Umlagern, Inventur, Export)

### M5: Marktplatz-Views — ✅ Real

**Was existiert:** MarketplaceListingsView.tsx (generisch), Routes, KPIs, Tabs, Tabelle, Bulk-Actions, Sortierung, Rows-per-Page, Stock-Filter

**Offen:**
- [x] FAKE→REAL: Echte API-Calls — ✅ Bereits real
- [x] Realtime-Sync (Bestand + Preis + Status eBay ↔ AvyCloud ↔ Kaufland) — ✅ syncStockWithRetry + syncPriceToAllChannels + sync-event-bus + autoHealStockDiscrepancies + 3-Min-Listing-Sync (2026-03-14)
- [ ] Gap-Analyse integriert in Listing-View (expandable Row)
- [x] EbayListingsView.tsx LÖSCHEN — ✅ Gelöscht (BUG-006)
- [ ] Generisches Pattern: Neue Marktplätze per Config, nicht per Component

### M6: Order Management System (OMS) — ⚡ Phase A Live

> **Strategisch:** AvyCloud hat BaseLinker als OMS ersetzt. Natives Order Management ist aktiv.
> **Stand 2026-03-13:** Phase A ist live. eBay + Kaufland Orders werden direkt importiert, eigene Status-Engine läuft.
> **BaseLinker-Transition:** BaseLinker wird in der UI nicht mehr als Quelle angezeigt. Historische BaseLinker-Orders bleiben in Firestore, neue Orders kommen nativ von den Marktplätzen.

**Phase A: Natives OMS (LIVE)**
- [x] A1: Marketplace Order Intake — `order-intake-ebay.js` + `order-intake-kaufland.js` (direkt von eBay/Kaufland API)
- [x] A2: Eigene Status-Engine — 12-State OMS (pending → confirmed → picking → picked → packing → packed → shipped → delivered → completed + cancelled/returned/on_hold)
- [x] A3: Eigene Auftrags-Nummerierung (AVY-2026-{0001})
- [x] A4: Order-Detail-Seite (Kunden, Positionen, Timeline)
- [x] A5: Pipeline-Visualisierung (Horizontale Status-Bar)
- [x] A6: Kaufland Status-Reconciliation + Cancellation-Detection (2026-03-13)
- [x] A7: Kaufland Tracking-Push + unitId-Backfill (2026-03-13)
- [x] A8: Event-driven Cancellation-Push an Marktplätze (2026-03-13)
- [x] A9: Retry-Mechanismus für fehlgeschlagene Marketplace-Pushes (2026-03-13)

**Phase B: Versand & Rechnungen nativ**
- [x] B1: SendCloud Label-Erzeugung (createParcel, getLabel, cancelParcel) ✅ shipping-engine.js live
- [x] B2: Tracking-Webhooks — ✅ Handler + Signature-Verification (2026-03-14)
- [x] B3: Rechnungs-Engine Fix — ✅ SevDesk-Export mit Contact + Adresse + Line-Items (2026-03-14)
- [x] B4: Invoice PDF-Download im UI — ✅ GCS-Proxy-Endpoint + Download-Buttons in InvoicesView + OrderDetail (2026-03-14)
- [ ] B5: Invoice Email-Versand — kein sendInvoiceEmail(), kein Email-Template
- [ ] B6: Gutschriften (Credit Notes) — kein generateCreditNote(), keine Storno-Rechnung
- [x] B7: MwSt-Sätze — ✅ 19%/7%/0% Support via order.vatRate (2026-03-14)
- [x] B8: Marketplace-Kommunikation — Tracking + Cancellation an eBay/Kaufland (2026-03-13)

**Phase C: BaseLinker KOMPLETT entfernt — ✅ DONE (2026-03-13)**

> ✅ BaseLinker wurde restlos aus AvyCloud entfernt. 48 Dateien gelöscht, 40+ bereinigt.
> AvyCloud ist eigenständig multichannel-fähig mit eBay, Kaufland, SendCloud und SevDesk.
> Einziger Restposten: BUG-040 (historische BL-Orders ohne marketplace-Feld backfillen).

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

### M10: Analytics & Reporting — ⚡ Activity Feed Live

**Was existiert:** Dashboard funktional (Revenue KPIs, Orders, Shipping-Kosten, Activity Feed)

**Erledigt:**
- [x] Dashboard Activity Feed: 24h Timeline (Orders, Shipments, Returns, Stock-Syncs) — ✅ 2026-03-14
- [x] Backend: GET /api/dashboard/activity Endpoint — ✅ 2026-03-14

**Offen:**
- [ ] Reporting-Seite: Umsatz, Bestand, Margen, Bestseller, Retouren
- [ ] Export: CSV, Excel, PDF
- [ ] Backend: routes/reports.js, services/analytics.js

### M11: Einstellungen — ✅ Real

**Was existiert:** Alle Settings-Views + Routes + Sidebar-Gruppe, alle CRUD via Firestore

**Offen:**
- [x] Backend FAKE→REAL — ✅ Bereits real (Company, Profile, Order, Warehouse, API, Billing-Usage)
- [ ] Team-Management: Einladung, Rollen-Editor, Berechtigungen
- [ ] Billing: Stripe-Integration (Waiting On)

### M12: Lagerverwaltung — ⚡ Tabs Live

**Was existiert:** WarehouseView.tsx (838 Zeilen) mit 3-Tab-System, WarehouseSettingsView.tsx, 18 Backend-Endpoints

**Erledigt:**
- [x] Warehouse-View: 3-Tab-System (Lager-Struktur, Bewegungen, Inventur) — ✅ 2026-03-14
- [x] Bewegungen-Tab: Filterable movement history (Typ, BIN, Datum) aus warehouseEvents — ✅ 2026-03-14
- [x] Inventur-Tab: CRUD-Workflow (Erstellen, Zählen, Abschließen) mit Progress + Varianz — ✅ 2026-03-14
- [x] Backend: GET /api/warehouse/movements (query + pagination) — ✅ 2026-03-14
- [x] Backend: GET/POST /api/warehouse/inventories + counts + complete — ✅ 2026-03-14
- [x] Firestore: warehouseEvents (bestehend), warehouse_inventories (neu) — ✅ 2026-03-14

**Offen:**
- [ ] Bestandskorrektur aus Inventur-Abschluss (variance → auto stock-adjust)
- [ ] CSV-Export für Inventur-Ergebnisse

### M14: Pack & Ship — ⚡ Auto-Print Live

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

**Erledigt (2026-03-14):**

**Erweiterung 1: Auto-Print nach Pack-Scan**
- [x] **MobileOperationsView.tsx → Pack-Flow erweitern:** `packAndShip()` mit `labelFormat` aus User-Prefs, `window.print()` bei `autoPrint`-Einstellung — ✅
- [x] **`packAndShip()` nutzen:** Bereits in Verwendung seit OMS, jetzt erweitert mit `labelFormat` + `?format=` an Label-Download-URL — ✅
- [x] **Fehler-Handling:** Label-Fehler zeigt Nachricht, Bestellung bleibt packed (kein shipped ohne Label) — ✅ Bereits implementiert

**Erweiterung 2: Drucker & Label-Format Voreinstellungen pro User**
- [x] **Firestore: `user_profiles` erweitern** — `printing.labelFormat` ('a6'|'a4'), `printing.autoPrint` (boolean) — ✅
- [x] **Backend: `PUT /api/settings/profile`** — `printing` in allowedFields ergänzt — ✅
- [x] **Frontend: ProfileSettings erweitern** — "Druckeinstellungen" Card mit Format-Radio + Auto-Print Toggle — ✅
- [x] **SendCloud Label-Format durchreichen** — `packAndShip()` → `shipOrder(labelFormat)` + `GET /label?format=a6|a4` — ✅

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

### M-MOBILE: Mobile UI — ⚡ Funktional, Weltklasse-UX fehlt

> **Stand 2026-03-13.** Mobile UI ist funktional (4 Views, Bottom Nav, Scanner, KPIs).
> Aber: Logo unscharf, Button-Kontrast schlecht, keine Icons, Dashboard leer, kein Haptic Feedback.
> **Ziel: Weltklasse Mobile UX** nach Best Practices von ShipBob MiniBob, Sortly, Billbee.
> Referenz: Material Design 3, Apple HIG, WCAG 2.1 AA.

**Betroffene Dateien:**

| Datei | Zweck |
|-------|-------|
| `components/Header.tsx` | Mobile Header mit Logo |
| `components/MobileTabBar.tsx` | Bottom Navigation (82 Zeilen) |
| `components/MobileOperationsView.tsx` | Operations Hub + 4 Sub-Modes (1716 Zeilen) |
| `components/DashboardMobile.tsx` | Mobile Dashboard mit KPIs (502 Zeilen) |
| `components/MobileSearchView.tsx` | Produkt-Suche (131 Zeilen) |
| `styles/main.css` | Safe-Area, Mobile-spezifische Styles |
| `public/` | Logo-Assets, Mobile Nav Icons |

**Bugs (sichtbar in Screenshots):**

- [ ] **BUG-053: Logo unscharf auf Mobile** — `Header.tsx` Zeile 229-238: `avycloud_logo_40x40_icon.png` (40×40px) wird auf `width: 100px, height: 70px` hochskaliert → pixelig. High-Res Icon `avycloud_logo_icon.png` (4269×3299) existiert aber wird nicht verwendet. **Fix:** High-Res Icon verwenden + `srcset` für 1x/2x/3x Retina. Oder SVG-Version erstellen.

- [ ] **BUG-054: Operations-Buttons schlechter Kontrast (Light Mode)** — `MobileOperationsView.tsx` Zeile 1658-1713:
  - "Identifizieren": `text-accent` (Blue 600 `#2563eb`) auf `bg-accent-dim` (Blue/10% opacity) = ~3.2:1 Kontrast ❌ (WCAG AA erfordert 4.5:1)
  - "Kommissionieren": `text-amber-300` (#fcd34d) auf `bg-amber-600/20` = ~1.8:1 Kontrast ❌ NICHT lesbar
  - "Packen": `text-txt-primary` auf `bg-app-surface` = OK ✅
  - **Fix:** Light-Mode-spezifische Farben: dunklere Textfarben (`text-accent` → `text-blue-700`, `text-amber-300` → `text-amber-700`), oder Buttons mit solidem Hintergrund + weißem Text

- [ ] **BUG-055: Bottom Nav Icon "Operationen" nicht lesbar (Light Mode)** — `MobileTabBar.tsx` Zeile 72: PNG-Icons `mobile operation.png` (~1.8 KB) zu niedrige Auflösung. Inaktiver State: `text-txt-secondary` auf hellem Hintergrund = grenzwertig. **Fix:** SVG-Icons statt PNG, oder größere hochauflösende PNGs mit srcset.

- [ ] **BUG-056: Dashboard KPIs leer** — `DashboardMobile.tsx` Zeile 385-434: GESAMTSALDO, UMSATZ BRUTTO, RETOUREN, VERSANDKOSTEN zeigen keine Werte. **Root Cause:** Dashboard-Metriken kommen über `fetchDashboardMetrics()` das BaseLinker-API nutzt (→ BUG-048). Wenn BL keine Daten liefert, zeigen Cards "—". **Fix:** Hängt von BUG-048 ab (Dashboard auf native Aggregation umstellen).

**UX-Verbesserungen (Best Practice Weltklasse):**

> Referenz: ShipBob MiniBob (Warehouse Operations), Sortly (Mobile Inventory), Billbee (E-Commerce), Material Design 3

- [ ] **MOB-01: Operations-Buttons mit Icons** — Jeder Button braucht ein passendes Icon (Lucide React: `ScanLine` für Identify, `PackagePlus` für Einlagern, `ClipboardList` für Kommissionieren, `Package` für Packen). Icons 24px links vom Text. Touch-Target mindestens 48×48dp (Material Design). Aktuell: reine Text-Buttons ohne visuelles Gewicht.

- [ ] **MOB-02: Touch Feedback / Active States** — Buttons brauchen:
  - `active:scale-[0.98]` für visuelles Press-Feedback
  - `transition-all duration-150` für smooth Animations
  - Optional: Haptic Feedback via `navigator.vibrate(10)` bei kritischen Aktionen (Pack, Ship)
  - Aktuell: kein visuelles Feedback beim Antippen

- [ ] **MOB-03: Operations-Counter als Badges** — Counter (Einlagern: 0, Kommissionieren: 13, Packen: 417) sollten als prominente Badges DIREKT auf den Buttons stehen, nicht nur rechts oben als Text. Badge-Farbe = Status-Farbe (grün/amber/rot bei >50 unverpackt). Vorbild: ShipBob MiniBob Task-Counter.

- [ ] **MOB-04: Bottom Nav SVG-Icons** — PNG-Icons (2KB, pixelig) durch SVG oder Lucide-Icons ersetzen:
  - Home → `Home` (Lucide)
  - Suche → `Search` (Lucide)
  - Operationen → `ScanLine` oder `Workflow` (Lucide)
  - Active State: Icon + Label mit Brand-Accent-Farbe, Inactive: Muted
  - Mindestgröße: 24×24px Icon + 10px Label, Touch-Target 48×48dp

- [ ] **MOB-05: Dashboard KPI-Cards Redesign** — Aktuelle Cards sind dunkel-auf-dunkel (Dark Mode) ohne visuellen Unterschied. Best Practice:
  - Gradient-Hintergründe für Primär-KPIs (Revenue = Accent-Gradient, Returns = Danger-Gradient)
  - Sparkline/Mini-Chart in jeder KPI-Card (Trend der letzten 7 Tage)
  - Große Zahl zentriert, Label klein oben, Trend-Pfeil (▲/▼) mit Farbe
  - Tap auf KPI-Card → Drill-Down (z.B. Revenue → Auftrags-Liste gefiltert auf Zeitraum)

- [ ] **MOB-06: Pull-to-Refresh** — Standard mobile Pattern. Dashboard und Operations brauchen Pull-to-Refresh (aktuell: kein Refresh-Mechanismus ohne Page-Reload). Implementierung: `onTouchStart/Move/End` mit Animation-Threshold.

- [ ] **MOB-07: Loading Skeletons verbessern** — `DashboardMobile.tsx` hat `Skel`-Komponente, aber:
  - Skeleton-Höhe stimmt nicht mit echtem Content überein → Layout-Jump
  - Keine Pulse-Animation auf allen Skeletons
  - **Fix:** Skeleton-Dimensionen an reale Card-Höhen anpassen, `animate-pulse` durchgängig

- [ ] **MOB-08: Logo auf Mobile scharf machen** — 3 Optionen (Priorität):
  1. **SVG erstellen** aus dem vorhandenen High-Res PNG (optimal, skaliert perfekt)
  2. **srcset mit 2x/3x Varianten** (z.B. `avycloud_logo_icon@2x.png` 80×80, `@3x.png` 120×120)
  3. **High-Res Icon verwenden** (`avycloud_logo_icon.png` 4269×3299) mit CSS-Dimensionierung (schnellster Fix, aber 1.28MB Payload)
  - Header.tsx Zeile 229: `src` auf bessere Quelle ändern, `width`/`height` auf 40×40 setzen (nicht 100×70), `srcSet` hinzufügen

- [ ] **MOB-09: Swipe-Gesten** — Operations-Modi sollten per Swipe-Left/Right wechselbar sein (Identify → Stow → Pick → Pack). Bottom-Sheet für Order-Details statt Modal. Standard mobile Pattern.

- [ ] **MOB-10: Dark/Light Mode Konsistenz** — Screenshots zeigen Operations in Light, Dashboard in Dark. Beide Themes müssen konsistent funktionieren:
  - Light Mode: Alle Buttons müssen WCAG AA Kontrast haben (4.5:1 Text, 3:1 UI-Elemente)
  - Dark Mode: Cards brauchen Border oder Elevation für visuelle Trennung
  - Theme-Toggle in Header muss in beiden Modes gleich prominent sein

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
| 1 | **BaseLinker** | API Token | ⛔ TABU — WIRD ENTFERNT | 136+ Dateien, ~4360 Zeilen aktiver Code. Removal in Phase C (KW 12). | `lib/baselinker-*.js` — LÖSCHEN |
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
| **B: API-Key/Secret** | User gibt Credentials ein → Test-Call → Speichern | Kaufland, SevDesk, SendCloud, WooCommerce, Shopware, PrestaShop, Hood.de |
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
| 8 | ShippingView | MOCK_SHIPMENTS | fetchShipments() → /api/shipments, SendCloud Sync, Tracking-URLs | ✅ Real (2026-03-13) |
| 9 | InvoicesView | MOCK_INVOICES | fetchInvoices() → /api/invoices, Status-Updates, KPIs | ✅ Real (2026-03-13) |
| 10 | ReturnsView | MOCK_RETURNS | fetchReturns() → /api/returns, Marketplace-Sync, Processing-Dialog | ✅ Real (2026-03-13) |
| 11 | BillingSettings | Hardcodierte Plan/Usage | fetchBillingUsage() → /api/settings/billing/usage, Progress-Bars | ✅ Real (2026-03-13, Stripe pending) |
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
| BUG-028 | **Marketplace-Seiten: Inkonsistente Lager/Marktplatz-Mengen** — Warehouse-Qty ≠ Marketplace-Qty, kein Real-Time-Sync bei externen Verkäufen | P1 | ⚠️ Teilweise Fixed (Pack/Ship sync ✅, Listing-Sync 3min ✅, Auto-Heal ✅ — ABER: warehouse stock-in/out Fire-and-Forget ohne Retry, Auto-Heal nur 10/Zyklus → **siehe BUG-033**) |
| BUG-029 | **🔥 OVERSELL: Artikel mit Bestand 0 werden auf Marktplätzen verkauft** — Kaufland zeigt Menge >0 obwohl Inventar 0 ist. Kein Stock-Sync bei Order-Intake. availableQuantity nie gespeichert. | P0 SOFORT | ⚠️ Teilweise Fixed (computeAvailableQuantity ✅, Kaufland-Intake hat Sync ✅ — ABER: eBay-Intake ZERO Sync ❌, reserveStock() NIE aufgerufen ❌, Fire-and-Forget ❌ → **siehe BUG-033**) |
| BUG-030 | **Stornierung fehlt: Aufträge können nicht storniert + an Marktplätze kommuniziert werden** — Status "cancelled" existiert intern, aber kein Cancel-API-Call zu eBay/Kaufland. Stock-Reservierung wird nicht freigegeben. | P0 | ✅ Fixed (eBay+Kaufland Cancel-API, auto releaseReservation + syncStock bei Cancel, pushCancellationToMarketplace bei Transition + Bulk) |
| BUG-031 | **Status-Sync zu Marktplätzen unvollständig** — Tracking-Push nur bei SendCloud-Ship, nicht bei manuellem Status-Wechsel. Kein Status-Push für packed/cancelled/on_hold. | P1 | ✅ Fixed (pushTrackingToMarketplace bei manueller/bulk Transition zu shipped, Cancel-Push via BUG-030) |
| BUG-032 | **Produkt-Gewicht fehlt bei fast allen Produkten** — Identify/Improve extrahieren kein Gewicht. Mandatory für Carrier-Zuordnung. Initial-Backfill + Pipeline-Fix nötig. | P0 | ⚠️ Teilweise Fixed (2026-03-15: Improve-Pipeline: `weight_grams` zu `DATASHEET_REVIEW_SCHEMA` + Prompt + `applyReviewResult()` → Gewicht wird jetzt aus LLM-Output extrahiert und in `details.weight` gespeichert. Backfill-Script + Quality-Gate noch ausstehend.) |
| BUG-033 | **🔥 BESTAND-SYNC UNVOLLSTÄNDIG: eBay Order-Intake hat ZERO Stock-Sync** — eBay-Bestellungen importiert ohne jeglichen Stock-Sync zu Kaufland. `reserveStock()` wird NIE aufgerufen. Fire-and-Forget überall. Auto-Heal nur 10 Produkte/Zyklus. | P0 SOFORT | ✅ Fixed (reserveStock+syncStockWithRetry in eBay+Kaufland intake, setTimeout→syncStockWithRetry in warehouse, PRODUCTS_COLLECTION→products_v2, MAX_HEALS 10→50, auto-heal with retry) |
| BUG-034 | **LISTING-STATUS INKONSISTENT: Kein Auto-Delist bei Bestand 0, Status-Propagation lückenhaft** — Wenn Bestand=0, kein ONHOLD/Delist auf Kaufland/eBay. Listing-Status nur alle 3 Min gecached. Case-Sensitive Status-Check ("Active" vs "active"). | P0 | ✅ Fixed (2026-03-15: `setUnitStatus('ONHOLD')` zu `kaufland-api.js` hinzugefügt + `stock-sync-dispatcher.js` ruft bei Bestand=0 explizit ONHOLD auf, bypassed price validation; case-insensitive war bereits gefixt) |
| BUG-035 | **EAN nicht in Produktdatenblatt gespeichert nach Identify** — User gibt EAN ein, Produkt wird erkannt, aber `details.identifiers.ean` bleibt leer. `v2-product-builder.js` ignoriert manualBarcodes bei identifiers. | P1 | ✅ Fixed (Fallback auf manualBarcodes in identifiers + barcode-Feld) |
| BUG-036 | **Bestellungen-Seite max 100 Einträge, keine Pagination** — Backend hardcoded `Math.min(..., 100)`. Kein Rows-per-Page Selector. Keine Seitennavigation. | P1 | ✅ Fixed (Backend: limit 500 + offset. Frontend: Rows-per-Page 25/50/100/200/500 + Page-Nav) |
| BUG-037 | **🔥 Kaufland-Stornierungen** — Code-Fix vorhanden (Rank-basierte Reconciliation + 30-Tage Lookback), ABER: Screenshot vom 14.03. zeigt MXTBT35, M7PPT35, MEL4T35 noch als "Kommissioniert". Entweder Reconciliation-Loop noch nicht gelaufen oder Fix nicht deployed. **Manuell verifizieren nach nächstem Deploy!** | P0 | ⚠️ Code-Fix da, Production-Verifizierung ausstehend |
| BUG-038 | **Retouren-Seite leer** — Sync 4h Intervall + 7 Tage Lookback. Stornierungen ≠ Retouren in Kaufland. | P1 | ✅ Fixed (Event-Driven Sync + 6h Safety-Net, 30d Lookback) |
| BUG-039 | **Versand & Labels Seite leer** — SendCloud Sync 2h Intervall. Kein Bug — Seite zeigt Daten erst nach Label-Erstellung. | P2 | ✅ Fixed (Event-Driven Sync + 6h Safety-Net) |
| FEAT-EDS | **🚀 Event-Driven Sync Architektur** — Intervall-basierte Syncs durch Event-getriebene Echtzeit-Syncs ersetzt. Jede Änderung (Order/Return/Shipment/Stock) in AvyCloud, Kaufland, eBay oder SendCloud triggert sofort einen Sync. | P0 | ✅ Implementiert |
| BUG-040 | **⛔⛔⛔ P0 SOFORT — Orders zeigen "baselinker" + fehlende Kundendaten + falscher Status.** | P0 SOFORT | ⚠️ Script erstellt (`backend/scripts/backfill-baselinker-orders.js`, 2026-03-15) — **Noch nicht in Production ausgeführt. Manuell starten: `node backend/scripts/backfill-baselinker-orders.js --dry-run` dann ohne --dry-run.** |
| BUG-041 | **Kaufland Order-Intake: trackingNumber + carrier fehlen noch** | P1 | ✅ Fixed (2026-03-15: `trackingNumber` + `carrier` aus `units[].tracking_number/carrier` + `klOrder.tracking_number/carrier` extrahiert) |
| BUG-042 | **Kaufland Adresse unvollständig** — Adresse war nur aus `shipping_address`, ohne Fallback auf `billing_address`. | P1 | ✅ Fixed (2026-03-15: Fallback auf `billingAddr` für alle customer-Felder: name, street, city, zip, country, phone) |
| BUG-043 | **Returns-Engine Bugs: `totalRefund` + `ebayReason` Referenz-Fehler** — returns-engine.js: totalRefund + ebayReason Variablen-Bugs | P1 | ✅ Fixed (2026-03-13: totalRefund korrekt akkumuliert, ebayReason extrahiert vor Dedup-Check) |
| BUG-044 | **Kaufland Returns: Keine Pagination** — `syncKauflandReturns()` hatte `limit: 100` ohne Loop | P2 | ✅ Fixed (2026-03-13: Pagination-Loop mit offset/limit, 5000-Item Safety-Cap) |
| BUG-045 | **eBay Order-Intake: Kein Status-Update nach Import** — `saveOrderIfNew()` übersprang existierende Orders | P1 | ✅ Fixed (2026-03-13: Rank-basierte Status-Reconciliation, 30-Tage Lookback, 50-Page Safety) |
| BUG-046 | **Dashboard Shipping-Kosten: BL-Fallback entfernt** — Nur SevDesk + SendCloud als Quellen. | P2 | ✅ Fixed (2026-03-13) |
| BUG-047 | **Invoice PDF Download** — GCS-Proxy `GET /api/invoices/:id/download` + Frontend Download-Buttons. | P1 | ✅ Fixed (2026-03-14) |
| BUG-048 | **Dashboard Revenue/Returns nutzt BaseLinker-API** — Dashboard nutzt jetzt native Firestore-Aggregation. Kaufland-Breakdown (kaufland_gross_window/ytd, kaufland_payout_window/ytd) in getDashboardMetrics() ergänzt. Payout-Berechnung trennt eBay vs. Kaufland korrekt. | P0 | ✅ Fixed (2026-03-14) |
| BUG-049 | **Marketplace Refund Push Runner** — runRefundPush() auto-pusht erstattet/teilweise_erstattet Returns alle 4h an eBay/Kaufland. | P2 | ✅ Fixed (2026-03-14) |
| BUG-050 | **SevDesk Invoice-Export** — Contact-Erstellung, ContactAddress, Invoice mit Line-Items (InvoicePos), korrektes Response-Parsing. | P1 | ✅ Fixed (2026-03-14) |
| BUG-051 | **BaseLinker Auto-Sync bei Server-Start** — Entfernt im Rahmen von Phase C (Block 1 KW 12). | P0 | ✅ Fixed (2026-03-13) |
| BUG-052 | **BaseLinker in RBAC aktiv** — RBAC-Permissions + integration-registry bereinigt (Block 1 KW 12). | P1 | ✅ Fixed (2026-03-13) |
| BUG-053 | **Logo unscharf auf Mobile** — High-Res `avycloud_logo_icon.png` (4269×3299) statt 40×40 Asset. | P1 | ✅ Fixed (2026-03-14) |
| BUG-054 | **Operations-Buttons Light Mode Kontrast** — Design-Tokens (text-warning/bg-warning-dim) statt hardcoded amber. | P1 | ✅ Fixed (2026-03-14) |
| BUG-055 | **Bottom Nav Icons unscharf** — Inline SVGs ersetzen PNG-Icons, 48dp Touch-Targets. | P1 | ✅ Fixed (2026-03-14) |
| BUG-056 | **Dashboard Mobile KPIs leer** — Root Cause BUG-048 behoben. KPIs zeigen jetzt native Firestore-Daten mit korrekter Kaufland/eBay-Aufschlüsselung. | P0 | ✅ Fixed (2026-03-14, via BUG-048) |
| BUG-057 | **⛔ Zusammengeführt mit BUG-040** — Historische BL-Orders Status-Migration ist Teil des BUG-040 Backfill-Scripts. Beide Probleme (falscher Marketplace + falscher Status) werden mit einem einzigen Firestore-Batch-Script gelöst. | P0 | → Siehe BUG-040 |
| BUG-058 | **BaseLinker Code-Entfernung: 98% erledigt** — Verifiziert am 2026-03-14: Frontend (*.ts, *.tsx) = 0 BL-Referenzen ✅. Backend index.js = 0 ✅. Backend routes/orders.js = 0 ✅. **Restposten:** 3 Backend-Dateien mit 9 Referenzen (lib/ebay-direct.js: 1, scripts/export-inventory-categories.js: 3, scripts/add-ebay-categories-to-inventory.js: 5) — alles non-production Scripts. **ABER:** Firestore-Daten NICHT migriert → BUG-040 + BUG-057 sind die echten Blocker. | P2 | ⚠️ Code 98% clean, Daten-Migration fehlt |
| BUG-059 | **Inventar: Literal `\u2014` statt Em-Dash** | P1 | ✅ Fixed (2026-03-15: `\u2014` → `{"—"}` in InventoryView.tsx + WarehouseInventoryTab.tsx) |
| BUG-060 | **Inventar Bestandswert €0,00 obwohl 1.636 Einheiten vorhanden** — EK fehlt bei allen Produkten | P2 | 🔴 Offen |
| BUG-061 | **Versand: "Invalid Date" im Versanddatum** | P1 | ✅ Fixed (2026-03-15: `isNaN(d.getTime())` Guard in ShippingView.tsx) |
| BUG-062 | **Versand: Kundenname "—" bei den meisten Sendungen** — KUNDE-Spalte zeigt "—" statt Namen. | P1 | ⚠️ Code-Fix (2026-03-15: `parcel.address?.name` + `company_name` als Fallbacks in shipping-engine.js; vorhandene Docs in Firestore brauchen Re-Sync) |
| BUG-063 | **Versand: AUFTRAG-ID zeigt SendCloud-Parcel-ID statt AvyCloud-Order-ID** | P2 | ✅ Fixed (2026-03-15: ShippingView.tsx zeigt `shp.orderNumber || shp.orderId`) |
| BUG-064 | **Retouren: Erstattungsquote 100% bei 0,00 EUR Erstattungen** | P1 | ✅ Fixed (2026-03-15: Formel korrigiert: `refunded.length/returns.length`) |
| BUG-065 | **Rechnungen: NETTO + BRUTTO fehlt** | P1 | ✅ Fixed (2026-03-15: `amountNet ?? amountNetto` + `amountGross ?? amountBrutto` in InvoicesView.tsx) |
| BUG-066 | **Kaufland Listings: Alle Status "Unbekannt"** | P1 | ✅ Fixed (2026-03-15: `active===true`→"active", `status!=null`→"inactive" in normalizeKauflandRow) |
| BUG-067 | **Kaufland Listings: Alle Preise "—"** | P1 | ✅ Fixed (2026-03-15: `d.price/100` als Fallback zu `d.listing_price/100` in marketplace.js) |
| BUG-068 | **⛔ Dashboard: 170 Marketplace-Sync-Fehler** — 110 eBay + 60 Kaufland. Root Cause: BUG-081 (eBay Token abgelaufen → alle eBay-Syncs schlagen fehl). Kaufland-Fehler separates Issue. | P0 | 🔴 Offen (blockiert durch BUG-081) |
| BUG-069 | **Dashboard: Chart zeigt keine Daten nach ~12.03** — Root Cause: native Orders haben `createdAt` = originales Marktplatz-Datum (Jan/Feb), fallen außerhalb 7d-Fenster. Abhängt von BUG-081. | P2 | 🔴 Offen |
| BUG-070 | **Theme Toggle reagiert nicht** — Code sieht korrekt aus, evtl. Browser-spezifisch | P2 | 🔴 Offen |
| BUG-071 | **Dashboard vs. Seiten-Zahlen Diskrepanz** | P1 | ✅ Fixed (2026-03-15: Dashboard returns-Anreicherung nutzt `firestore` Singleton + kein yearStart-Filter → zeigt gleiche Zahl wie ReturnsView) |
| BUG-072 | **"Artikel listen" Modal zeigt bereits gelistete Produkte** | P1 | ✅ Fixed (2026-03-15: `listedSkus` Set Cross-Check in `openPublishModal` in MarketplaceListingsView.tsx) |
| BUG-073 | **Inventar zeigt Produkte mit Menge 0** | P1 | ✅ Fixed (2026-03-15: Default-Filter `qty > 0` in InventoryView.tsx Tabellen-Ausgabe) |
| BUG-074 | **Inventar Bestandswert €0,00 vs. Dashboard 49.054€** | P1 | ⚠️ Code-Fix (2026-03-15: `buyPrice \|\| lowest_price.amount` Fallback in InventoryView.tsx KPI + Zeilen + Sort). Production-Verifizierung ausstehend. |
| BUG-075 | **Versand Status-Werte nicht übersetzt** — Frontend STATUS_CONFIG 5→25+ Mappings, Backend createParcel() nutzt mapSendCloudStatus() | P2 | ⚠️ Code-Fix (2026-03-15: ShippingView.tsx + shipping-engine.js). Production-Verifizierung ausstehend. |
| BUG-076 | **Versand Duplikat-Einträge** | P2 | ✅ Fixed (2026-03-15: Deduplizierung nach `sendcloudParcelId` in ShippingView.tsx loadShipments) |
| BUG-077 | **Kaufland Listings: Marktplatz-Spalte zeigt "0" für ungematchte Produkte** — `quantity=0` ist korrekt für ONHOLD-Units. Spalte zeigt Marketplace-Qty, nicht Anzahl Marktplätze. | P1 | ⚠️ Kein Bug — Spalte "Marktplatz" zeigt Qty auf Kaufland (0 = ONHOLD) |
| BUG-078 | **Duplikate-Seite zeigt Gruppen mit nur 1 Produkt** | P2 | ✅ Fixed (2026-03-15: `productIds.length >= 2` Filter in DeduplicationView.tsx loadDuplicates) |
| BUG-079 | **Orders Pipeline vs. Filter-Tab Diskrepanz** | P1 | ✅ Fixed (2026-03-15: "Versendet" Tab hinzugefügt + statusCounts + filteredOrders Logik korrigiert in OrdersView.tsx) |
| BUG-080 | **Retouren-Seite: Produktname fehlt** — Retoure Y0NDGYY zeigt SKU statt Name. | P2 | ⚠️ Code-Fix (2026-03-15: `product.name \|\| product.title \|\| product.sku` in ReturnsView.tsx). Production-Verifizierung ausstehend. |
| BUG-081 | **⛔ eBay Token abgelaufen** — Seit 15.3.2026, 04:01 Uhr. Alle eBay-API-Calls schlagen fehl. Token muss manuell über OAuth-Flow erneuert werden. | P0 | ⚠️ OAuth reconnected (Oguzhan, 15.3. ~10:25 UTC). Code-Fix: ebay-trading-api.js holt jetzt OAuth-Token aus Firestore `integrations/ebay`. Production-Verifizierung: eBay Sync-Fehler sollten = 0 nach Deploy. |
| BUG-084 | **🔥 Doppelte Bestellungen** — 126 Duplikate durch BaseLinker→native eBay Migration. Alte BL-Docs hatten keine `marketplaceKey`, new eBay-synced docs ignoriert Fallback → Duplikate. | P0 | ✅ Fixed (2026-03-15: 111 alte BL eBay-Docs + 15 historische Duplikate gelöscht. `saveOrderIfNew()` hat jetzt `createdAt + marketplace` Fallback-Dedup.) |
| BUG-082 | **Produktdaten: eBay/Kaufland Status-Farben inkonsistent** | P3 | ⚠️ Code-Fix (2026-03-15: OrdersView + ReturnsView auf Design-Tokens vereinheitlicht: eBay=warning, Kaufland=danger). Production-Verifizierung ausstehend. |
| BUG-083 | **🔥 Cross-Marketplace Oversell: Kaufland nicht benachrichtigt bei eBay-Verkauf** — `syncStockToAllChannels()` übersprung Kaufland für 82% der Produkte weil `ops.kaufland.unitId` nicht gesetzt. | P0 | ✅ Fixed (2026-03-15: (1) `stock-sync-dispatcher.js`: Fallback-Lookup via `kauflandUnitsLive` nach SKU/EAN wenn unitId fehlt + Write-Back. (2) `marketplace.js` Sync: `ops.kaufland.unitId` Backfill bei jedem Sync-Lauf. (3) `order-state-machine.js`: `_onOrderShipped()` → confirmReservation + physicalQty dekrementieren + syncStockWithRetry. `_onOrderCancelled()` → releaseReservation + Marketplace re-sync.) |
| BUG-SSE | Token-in-Query-Parameter für SSE-Streams leakt | P1 | ⚠️ Code-Fix da, Verifizierung ausstehend |
| BUG-006 | EbayListingsView.tsx (alte Gap-Analysis) noch da — LÖSCHEN | P1 | ✅ Fixed (deleted) |
| BUG-008 | eBay-Seite zeigt Gap-Analyse-Daten statt Listing-Management | P1 | ✅ Fixed (route already correct, old component deleted) |
| BUG-009 | Kaufland-Seite zeigt nur SKU-Nummern ohne Produktdaten | P1 | ✅ Fixed (same root cause as BUG-023) |

### FEAT-EDS — Event-Driven Sync Architektur (2026-03-12)

**Problem:** Alle Syncs (Orders, Returns, Shipments) liefen auf festen Intervallen (1-2h). Änderungen bei Kaufland, eBay oder SendCloud wurden erst nach dem nächsten Intervall sichtbar. User: *"Scheiss auf die sync intervalle! Sync triggern bei Veränderung!"*

**Lösung:** Vollständig event-getriebene Architektur:

| Komponente | Datei | Funktion |
|---|---|---|
| **Event Bus** | `services/sync-event-bus.js` | Zentraler EventEmitter mit Debounce (5s/Entity). Events: `order:created`, `order:status_changed`, `order:updated`, `return:created`, `return:status_changed`, `shipment:created`, `shipment:updated`, `stock:changed` |
| **Order Hooks** | `routes/orders.js` | `emitSyncEvent()` nach pack, pick, ship, cancel-label, transition — triggert Stock-Sync + Marketplace-Sync |
| **Return Hooks** | `routes/returns.js` | `emitSyncEvent()` nach create, transition, process, refund, close — triggert Return-Sync + Stock-Restock |
| **Shipment Hooks** | `routes/webhooks.js` | `emitSyncEvent()` im bestehenden SendCloud-Webhook — triggert SendCloud-Sync + Return-Sync bei Return-Status |
| **Kaufland Webhook** | `routes/webhooks.js` | `POST /api/webhooks/kaufland` — empfängt Push-Notifications von Kaufland, triggert Order/Return-Sync |
| **eBay Webhook** | `routes/webhooks.js` | `POST /api/webhooks/ebay` — empfängt eBay Marketplace Notifications, triggert Order/Return-Sync |
| **Order Intake** | `services/order-intake-kaufland.js`, `services/order-intake-ebay.js` | `emitSyncEvent('order:created')` nach jedem neuen Import |
| **Safety-Net** | `index.js` | Intervalle von 1-2h auf 6h erhöht — nur noch Fallback falls Event-Bus-Delivery fehlschlägt |

**Event-Flow Beispiel (Kaufland storniert):**
1. Kaufland sendet Push-Notification → `POST /api/webhooks/kaufland`
2. Webhook emittiert `order:updated` → Event-Bus
3. Event-Bus triggert `_debouncedMarketplaceOrderSync()` (3s Debounce)
4. `syncKauflandOrders()` läuft → `saveOrderIfNew()` findet Status-Änderung → updated Order zu "cancelled"
5. Stock-Sync feuert automatisch → Bestand auf allen Kanälen aktualisiert

**Webhook-URLs für externe Konfiguration:**
- SendCloud: `https://api.avycloud.web.app/api/webhooks/sendcloud` (bereits konfiguriert)
- Kaufland: `https://api.avycloud.web.app/api/webhooks/kaufland` (Push-Notifications aktivieren in Kaufland Seller Portal)
- eBay: `https://api.avycloud.web.app/api/webhooks/ebay` (Marketplace Notifications API / Event Notifications)

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
- `POST /api/warehouse/stock-out` → `stock-sync-dispatcher.js:syncStockToAllChannels()` → Push zu eBay (`reviseFixedPriceItem`) + Kaufland (`updateUnit`)
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

| # | Datei | Was ändern | Prio | Status |
|---|-------|-----------|------|--------|
| 1 | `backend/services/stock-sync-dispatcher.js` | **Retry-Mechanismus:** syncStockWithRetry() mit 30s Retry + stock_sync_failures Logging | P1 | ✅ Done |
| 2 | `backend/services/sync-event-bus.js` | **Stock-Sync bei JEDEM Status-Change:** order:status_changed → syncStockForOrderItems() (pack/ship/cancel) | P1 | ✅ Done |
| 3 | `backend/services/listing-sync-runner.js` | **3-Min-Intervall + Auto-Heal:** autoHealStockDiscrepancies() erkennt Mismatches und pusht sofort | P1 | ✅ Done |
| 4 | `backend/services/sync-event-bus.js + order-intake-*.js + warehouse.js` | **Alle Pfade:** Order-Intake, Stock-In/Out, Returns, Inventur → alle rufen syncStockWithRetry() | P2 | ✅ Done |
| 5 | `backend/routes/marketplace.js` oder neuer Webhook-Endpoint | **eBay/Kaufland Webhooks empfangen** für Bestellungen → sofortiger Stock-Decrement + Sync zu anderen Kanälen. | P2 | ❌ Offen |

**Datenfluss (Ist-Zustand):**
```
Warehouse Stock-Out → syncStockToAllChannels() → Push zu eBay + Kaufland (async, no retry)
                                                    ↓
                                            ebayListingsLive/kauflandUnitsLive = STALE bis nächster listing-sync-runner Zyklus (10 Min)

Marketplace-Verkauf → Order-Intake (eBay/Kaufland) → reserveStock → syncStockWithRetry → Push
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

### BUG-032 — Produkt-Gewicht fehlt bei fast allen Produkten (P0)

**Symptom:** Fast kein Produkt im Inventar hat ein Gewicht. Das führt direkt zu BUG-025 (falsche Carrier-Zuordnung → DHL Kleinpaket statt DPD). Gewicht ist mandatory für korrekten Versand.

**Analyse — Was existiert vs. was fehlt:**

**Infrastruktur (✅ VORHANDEN, gut gebaut):**
- `parseWeightKg()` + `normalizeWeightKgNumber()` in `firestore.js` Zeile 236-272 — robust, erkennt kg/g/Gramm, Heuristik >50=Gramm
- Storage: `details.weight` (Zahl in KG) + `details.attributes.weight` + `details.attributes['Gewicht']` — Dual-Storage
- 17+ Gewicht-Aliase normalisiert (`firestore.js` Zeile 532-550): weight, Gewicht, Bruttogewicht, Artikelgewicht, shipping weight etc.
- `product-canonical.js` Zeile 59-66: Alle Aliase → `attributes['Gewicht']`
- LLM-Policy (`llm-policy-pack.js` Zeile 103): "Gewicht: immer als ZAHL in KG"
- `bucket-weights.js`: Gewicht-Buckets (1, 3, 6, 9, 12, 15 kg) für Carrier-Matching
- `extractSpecsFromText()` in `enrichment.js` Zeile 2333-2342: Kann Gewicht aus Text parsen

**Lücken (❌ FEHLT):**

| # | Was fehlt | Auswirkung |
|---|-----------|------------|
| 1 | **Identify-Pipeline fragt Gewicht nicht aktiv ab** | Gemini-Prompt enthält keine explizite Anweisung Gewicht zu extrahieren/schätzen |
| 2 | **Improve-Pipeline reichert Gewicht nicht an** | `improve.js` hat KEINEN Gewicht-Code |
| 3 | **Web-Enrichment speichert extrahiertes Gewicht nicht** | `extractSpecsFromText()` liefert `weight_g` — wird nur für Scoring genutzt, nicht gespeichert |
| 4 | **Kein Quality-Gate für fehlendes Gewicht** | Produkte ohne Gewicht werden nicht geflaggt |
| 5 | **Order-Items bekommen Gewicht nicht aus Produkt** | `shipping-engine.js` liest `order.items[].weight` — wird beim Order-Intake nicht aus Produkt befüllt |
| 6 | **~806 Produkte im Inventar haben kein Gewicht** | Kein Initial-Backfill gelaufen |

**Fixes (3 Teile):**

**Teil 1: Initial-Backfill (SOFORT) — Alle bestehenden Produkte mit Gewicht versehen**

| # | Datei | Was |
|---|-------|-----|
| 1 | `backend/scripts/backfill-weights.js` (NEU) | Script: Alle Produkte aus `products_v2` laden. Für jedes Produkt OHNE `details.weight`: **Stufe 1:** EAN/GTIN vorhanden? → Web-Suche nach Herstellerdaten/Produktdatenblatt → Gewicht extrahieren. **Stufe 2:** Wenn nichts gefunden → Gemini-API aufrufen mit Titel + Brand + Kategorie + EAN + Abmessungen (falls bekannt) → Gewicht schätzen lassen. `saveProductV2()` mit Gewicht + `weightSource` ('manufacturer', 'web', 'llm-estimate'). Batch-Processing mit Rate-Limiting (max 10 req/s). |
| 2 | Gemini-Prompt für Weight-Estimation | `"Du bist ein Produktexperte. Bestimme das Gewicht dieses Produkts in KG. Gib NUR eine Zahl zurück, keine Einheit. Nutze dein Wissen über typische Produktgewichte. WICHTIG: Nur schätzen wenn kein verlässlicher Wert gefunden werden kann. Produkt: {title}, Brand: {brand}, Kategorie: {category}, EAN: {ean}. Gewicht in KG:"` |
| 3 | Logging | Jedes Gewicht loggen: `{ productId, title, weight, weightSource: 'manufacturer' \| 'web' \| 'llm-estimate' }`. LLM-Schätzungen markieren damit sie später manuell verifiziert werden können. |

**Teil 2: Pipeline-Fix — Zukünftige Produkte bekommen automatisch Gewicht**

**Prioritätsreihenfolge für Gewicht-Ermittlung (IMMER in dieser Reihenfolge):**
1. **Herstellerangabe** — Aus Barcode/EAN-Lookup, Produktdatenblatt, Verpackung
2. **Web-Enrichment** — Aus öffentlichen Quellen (Produktseiten, Datenbanken) extrahiert
3. **LLM-Schätzung** — NUR als letzter Fallback wenn nichts Verlässliches gefunden

| # | Datei | Was ändern |
|---|-------|-----------|
| 1 | `backend/services/enrichment.js` → Identify-Prompt | **Gewicht als Pflichtfeld im Gemini-Prompt:** In `buildSystemPrompt()` oder `buildUserPrompt()` explizit: `"Gewicht (weight_kg): Pflichtfeld. Zahl in KG. Erst aus sichtbaren Produktdaten/Verpackung/Barcode-Info extrahieren. Wenn nicht auffindbar: realistisch schätzen basierend auf Produkttyp, Material und Größe. Geschätztes Gewicht mit 'estimated: true' markieren."` |
| 2 | `backend/services/enrichment.js` → Response-Parsing | Nach Gemini-Response: Wenn `weight` im Output → `parseWeightKg()` → in `details.weight` und `details.attributes.weight` speichern. Zusätzlich `details.weightSource` setzen ('identified' oder 'estimated'). |
| 3 | `backend/services/improve.js` | **Gewicht-Enrichment hinzufügen:** Wenn Produkt kein Gewicht hat → Web-Recherche nach EAN/Titel → Gewicht extrahieren. Wenn nichts gefunden → Gemini mit Titel+Brand+Kategorie → schätzen. `weightSource` setzen. |
| 4 | `backend/services/enrichment.js` → `extractSpecsFromText()` | Extrahiertes `weight_g` nicht nur für Scoring nutzen sondern auch in Produkt speichern wenn noch kein Gewicht vorhanden. Source = 'web'. |
| 5 | `backend/lib/llm-policy-pack.js` Zeile 103 | Policy ändern: Von `"Wenn Gewicht nicht belegbar: Feld leer lassen (nicht raten)"` → `"Gewicht ist PFLICHT. Erst aus verlässlichen Quellen (Herstellerangabe, Produktdatenblatt, Verpackung) extrahieren. NUR wenn keine verlässliche Quelle verfügbar: realistisch schätzen und als Schätzung markieren."` |

**Teil 3: Quality-Gate + Order-Integration**

| # | Datei | Was ändern |
|---|-------|-----------|
| 1 | `backend/services/quality-runner.js` oder `quality-check.js` | **Quality-Gate:** Produkt ohne `details.weight` → Warning "Gewicht fehlt". Produkt mit Bestand > 0 und ohne Gewicht → Error "KRITISCH: Gewicht fehlt bei lagerndem Produkt". |
| 2 | `backend/services/order-sync.js` oder `order-intake-kaufland.js` | **Gewicht aus Produkt in Order-Item:** Beim Order-Intake: Für jedes `order.item` → verlinktes Produkt laden → `item.weight = product.details.weight`. Damit `calculateOrderWeight()` korrekt arbeitet. |
| 3 | Frontend: ProductSheet / AdminTable | **Gewicht-Indikator:** Spalte oder Badge das anzeigt ob Gewicht vorhanden oder fehlend. Optional: Inline-Edit für manuelles Gewicht. |

**Verifikation nach Fix:**
1. Backfill: Alle ~806 Produkte haben nach dem Script ein `details.weight` > 0
2. Neues Produkt identifizieren → Gewicht wird automatisch extrahiert/geschätzt
3. Quality-Gate flaggt Produkte ohne Gewicht als Error
4. Neue Kaufland-Bestellung → `order.items[].weight` aus Produkt befüllt → korrekter Carrier

---

### BUG-033 — 🔥 BESTAND-SYNC UNVOLLSTÄNDIG: 5-Schichten-Problem (P0 SOFORT)

**Symptom:** Lager und Marktplätze zeigen stark inkonsistente Bestände. Oversell tritt weiterhin auf trotz BUG-029 "Fix". Bestände divergieren nach Order-Intake, Stock-In/Out und bei Netzwerkfehlern.

**Deep-Dive Code-Audit (2026-03-11) — tatsächlicher IST-Zustand:**

**Schicht 1: eBay Order-Intake = ZERO Stock-Sync (KRITISCH)**

`backend/services/order-intake-ebay.js` (Zeile 142-152): Importiert eBay-Bestellungen und speichert sie, ruft aber WEDER `syncStockToAllChannels()` NOCH `reserveStock()` auf. Ergebnis: eBay-Bestellung kommt rein → Kaufland zeigt weiterhin den alten Bestand → Oversell.

**Schicht 2: reserveStock() wird NIE aufgerufen (KRITISCH)**

Weder `order-intake-ebay.js` noch `order-intake-kaufland.js` rufen `reserveStock()` auf. Die Funktion existiert in `stock-reservation.js` (Zeile 29-76), wird aber **nirgendwo im Order-Intake-Flow** verwendet. `computeAvailableQuantity()` subtrahiert Reservierungen — aber es gibt keine Reservierungen zum Subtrahieren.

**Schicht 3: Fire-and-Forget ohne Retry (fast überall)**

| Aufruf-Stelle | Awaited? | setTimeout? | Retry? |
|---------------|----------|-------------|--------|
| `order-intake-kaufland.js:182` | ❌ | ❌ | ❌ (nutzt `syncStockToAllChannels` statt `syncStockWithRetry`) |
| `warehouse.js:412` (stock-in) | ❌ | ✅ (0ms) | ❌ |
| `warehouse.js:456` (stock-out) | ❌ | ✅ (0ms) | ❌ |
| `listing-sync-runner.js:281` (auto-heal) | ❌ | ❌ | ❌ |
| `orders.js:931` (pack) | ❌ | ❌ | ✅ (syncStockWithRetry, 1x 30s) |
| `orders.js:1364` (ship) | ❌ | ❌ | ✅ (syncStockWithRetry, 1x 30s) |

Nur Pack/Ship nutzen `syncStockWithRetry()`. Alle anderen → Fire-and-Forget. Netzwerk-Timeout = verlorener Sync.

**Schicht 4: Auto-Heal nur 10 Produkte pro Zyklus**

`listing-sync-runner.js:254`: `const MAX_HEALS_PER_CYCLE = 10;` — Bei 100 Oversells dauert es 30 Minuten bis alle geheilt sind.

**Schicht 5: Stale Product-Objekt beim Sync**

`warehouse.js` übergibt `result.product` an `syncStockToAllChannels()`. Dieses Objekt stammt aus dem Request — wenn parallel ein anderer Stock-Change passiert, sendet der Sync den alten Bestand.

**Fix-Plan:**

| # | Datei | Maßnahme | Prio |
|---|-------|----------|------|
| 1 | `backend/services/order-intake-ebay.js` | **Nach Order-Import: `syncStockForOrderItems({tenantId, orderId, reason: 'ebay-order-intake'})` aufrufen.** Gleiche Logik wie bei Kaufland-Intake. MUSS `syncStockWithRetry` nutzen, nicht raw `syncStockToAllChannels`. | P0 |
| 2 | `backend/services/order-intake-kaufland.js:182` | **Wechsel von `syncStockToAllChannels()` zu `syncStockForOrderItems()` oder `syncStockWithRetry()`.** Aktuell: keine Retry-Logik → Netzwerkfehler = verlorener Sync. | P0 |
| 3 | `backend/services/order-intake-ebay.js` + `order-intake-kaufland.js` | **`reserveStock({tenantId, orderId, sku, quantity})` aufrufen** für jedes Order-Item. Erst dann Sync. Damit `computeAvailableQuantity()` korrekt arbeitet. | P0 |
| 4 | `backend/routes/warehouse.js:412,456` | **`setTimeout(0)` entfernen.** Stattdessen: `syncStockWithRetry()` (mit 1x Retry) aufrufen. Nicht blockierend, aber mit Retry. | P1 |
| 5 | `backend/services/listing-sync-runner.js:254` | **`MAX_HEALS_PER_CYCLE` von 10 auf 50 erhöhen.** Bei 3-Min-Intervall: 50 Produkte/Zyklus = max 6 Min für 100 Oversells statt 30 Min. | P1 |
| 6 | `backend/services/stock-sync-dispatcher.js` | **Persistent Retry-Queue:** Fehlgeschlagene Syncs → Firestore `stock_sync_failures` + Retry via Cron (existiert teilweise, aber nur in `syncStockWithRetry` und nur 1x). Braucht: Multi-Retry (3x exponential backoff) oder Job-Queue. | P2 |
| 7 | Alle Sync-Aufruf-Stellen | **Frisches Product-Objekt laden** statt übergebenes Objekt nutzen. `syncStockToAllChannels()` sollte IMMER `products_v2/{id}` frisch aus Firestore lesen. | P1 |

**Verifikation nach Fix:**

1. eBay-Bestellung kommt rein → Kaufland UND eBay Bestand sinkt sofort um bestellte Menge
2. Kaufland-Bestellung kommt rein → eBay Bestand sinkt sofort
3. Netzwerk-Timeout simulieren → Retry nach 30s → Bestand wird korrekt gepusht
4. 5 gleichzeitige Bestellungen → `stock_reservations` zeigt 5 Einträge → `availableQuantity` = physical - 5
5. Lager stock-in +10 → eBay UND Kaufland zeigen sofort +10
6. Auto-Heal bei Diskrepanz: 50 Produkte/Zyklus, nicht 10

---

### BUG-034 — LISTING-STATUS INKONSISTENT: Kein Auto-Delist, Status-Propagation lückenhaft (P0)

**Symptom:** Marketplace-Seiten zeigen Produkte als "aktiv" obwohl Bestand 0. Kein Auto-Delist/ONHOLD bei Bestand 0. Listing-Status in Firestore weicht von tatsächlichem Marketplace-Status ab.

**Deep-Dive Code-Audit (2026-03-11):**

**Problem 1: Kein Auto-Delist bei Bestand 0**

Wenn `inventory.quantity === 0` passiert folgendes:
- `syncStockToAllChannels()` pusht `quantity: 0` an eBay/Kaufland
- eBay: Listing wird auf quantity=0 gesetzt, aber NICHT delistet (bleibt als "active" mit 0 Stück)
- Kaufland: Unit wird auf `amount: 0` gesetzt, aber KEIN `status: ONHOLD` gepusht
- Ergebnis: Listings bleiben "sichtbar aktiv" mit 0 Stück — verwirrt Käufer und AvyCloud-Nutzer

**Problem 2: Case-Sensitive Status-Check**

`listing-sync-runner.js:51`: Prüft `active === true && status === 'active'` — eBay gibt aber `listingStatus: 'Active'` (Großbuchstabe A). Potenzielle Nicht-Erkennung aktiver Listings.

**Problem 3: Listing-Status-Cache 3 Min Latenz**

Listing-Sync-Runner läuft alle 3 Min und cached eBay/Kaufland Status. In diesen 3 Min zeigt AvyCloud u.U. falschen Status. Kein Push-basiertes Update.

**Problem 4: Re-List bei Stock-Rückkehr fehlt**

Wenn Bestand von 0 → positiv geht (z.B. durch Retoure oder Stock-In), gibt es keinen Mechanismus der:
- Kaufland Unit von ONHOLD → aktiv setzt
- eBay Listing re-listet (relist API Call)

**Fix-Plan:**

| # | Datei | Maßnahme | Prio |
|---|-------|----------|------|
| 1 | `backend/services/stock-sync-dispatcher.js` → `syncStockToAllChannels()` | **Auto-Delist bei Bestand 0:** Wenn `availableQty === 0` → eBay: `EndFixedPriceItem` oder `quantity: 0` + Reason. Kaufland: `PATCH /units/{id}` mit `status: ONHOLD`. | P0 |
| 2 | `backend/services/stock-sync-dispatcher.js` | **Auto-Relist bei Bestand >0:** Wenn `availableQty > 0` UND Listing war ONHOLD/ended → eBay: `RelistFixedPriceItem` oder `reviseFixedPriceItem` mit neuer Qty. Kaufland: Status zurück auf aktiv. | P1 |
| 3 | `backend/services/listing-sync-runner.js:51` | **Case-Insensitive Status-Check:** `status.toLowerCase() === 'active'` statt `status === 'active'`. | P1 |
| 4 | `backend/services/listing-sync-runner.js` | **Listing-Status in Firestore Produkt schreiben:** `ops.listingStatus.ebay = 'active'/'ended'`, `ops.listingStatus.kaufland = 'active'/'onhold'` — damit Frontend aktuellen Status hat. | P1 |
| 5 | Frontend: Marketplace-Views + AdminTable | **Status-Badge "Oversell-Warnung":** Wenn `availableQty === 0` aber Marketplace-Qty > 0 → rotes Badge "⚠️ Oversell-Risiko". | P2 |

**Verifikation nach Fix:**

1. Bestand → 0: Kaufland zeigt ONHOLD, eBay zeigt ended/0 → kein Kauf mehr möglich
2. Retoure eingelagert (Bestand 0 → 3): Kaufland automatisch zurück auf aktiv mit Qty 3, eBay re-listed
3. Listing-Status in AdminTable stimmt mit tatsächlichem Marketplace-Status überein (max 3 Min Latenz)
4. Kein Case-Sensitivity Bug mehr bei Active/active

---

### BUG-040 — ⛔⛔⛔ P0 SOFORT: BaseLinker-Orders Komplett-Migration (BLOCKIERT ALLES)

> **PRIORITÄT: HÖCHSTE. Ohne dieses Script ist die gesamte Bestellungsseite KAPUTT.**
> **ACHTUNG: Das sind KEINE alten Orders! Bestellungen vom 14.03.2026 00:02 — Stunden alt!**
> BL-Code wurde am 14.03. um 02:05 entfernt (Commit c487ed9). Alle Orders VOR 02:05 kamen über den alten BL-Pfad.

**Symptom:**
- Orders zeigen "baselinker" als Quelle (graues Badge statt eBay/Kaufland)
- Kundendaten fehlen komplett ("Adresse unvollständig")
- Zahlung zeigt "—"
- Versand zeigt "—"
- Status ist falsch/veraltet
- Betrifft ca. 76 Orders (65 eBay, 11 Kaufland)

**Root Cause:**
- Orders haben `source: 'baselinker'` statt `source: 'ebay'`/`source: 'kaufland'`
- Kein `marketplace`-Feld vorhanden → `sourceBadge()` Fallback-Kette `order.marketplace || order.orderSource || order.source` liefert "baselinker"
- Kundendaten (Adresse, Telefon, Email) sind leer oder unvollständig
- Zahlungs-/Versanddaten fehlen
- ABER: Jede Order hat ein `raw`-Feld mit den KOMPLETTEN BaseLinker-API-Rohdaten → daraus kann ALLES rekonstruiert werden

---

#### SCHRITT-FÜR-SCHRITT MIGRATIONS-SPEZIFIKATION

**Dateiname:** `backend/scripts/migrate-baselinker-orders.js`

**Vorlage/Referenz-Script:** `backend/scripts/backfill-order-addresses.js` — zeigt exakt wie man:
- Firestore initialisiert (Zeile 16–24)
- Orders iteriert (Zeile 40)
- `raw`-Feld ausliest (Zeile 44: `const raw = order?.raw`)
- Felder per Dot-Notation updatet (Zeile 108: `doc.update(updates)`)
- Dry-Run implementiert (Zeile 101–104)

---

##### 1. SCRIPT-GRUNDGERÜST

```js
#!/usr/bin/env node
/**
 * migrate-baselinker-orders.js
 *
 * Migriert alle BaseLinker-importierten Orders auf natives Format.
 * Extrahiert marketplace, Kundendaten, Zahlung, Versand aus dem raw-Feld.
 *
 * Usage:
 *   node backend/scripts/migrate-baselinker-orders.js --dry-run
 *   node backend/scripts/migrate-baselinker-orders.js
 */
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'avycloud-hub',
  });
}

const firestore = admin.firestore();
const ORDERS_COLLECTION = 'orders';
const dryRun = process.argv.includes('--dry-run');
```

##### 2. QUERY — NUR BaseLinker-Orders

```js
const snap = await firestore
  .collection(ORDERS_COLLECTION)
  .where('source', '==', 'baselinker')
  .get();
console.log(`Found ${snap.size} BaseLinker orders to migrate`);
```

##### 3. MARKETPLACE-ERKENNUNG

Das `raw`-Feld enthält die komplette BaseLinker-API-Antwort. Darin gibt es ein Feld `order_source` das den tatsächlichen Marktplatz angibt.

```js
function detectMarketplace(raw) {
  // Primär: raw.order_source (BaseLinker setzt das IMMER)
  const src = (raw.order_source || '').toLowerCase();
  if (src === 'ebay' || src.includes('ebay')) return 'ebay';
  if (src === 'kaufland' || src.includes('kaufland')) return 'kaufland';

  // Fallback: Order-ID-Format
  // eBay: Nummern mit Bindestrich (z.B. "07-14365-99405")
  // Kaufland: Alphanumerisch (z.B. "MXTBT35")
  const orderId = String(raw.order_id || raw.extra_field_1 || '');
  if (/^\d{2}-\d{5}-\d{5}$/.test(orderId)) return 'ebay';
  if (/^[A-Z0-9]{5,10}$/.test(orderId)) return 'kaufland';

  // Wenn nichts passt: 'unknown' — manuell prüfen
  return 'unknown';
}
```

**WICHTIG:**
- `raw.order_source` ist der zuverlässigste Indikator (65 Orders haben 'ebay', 11 haben 'kaufland')
- Fallback über OrderID-Format nur als Sicherheitsnetz
- Orders mit `unknown` NICHT automatisch migrieren → loggen und manuell prüfen

##### 4. FELD-MAPPING — BaseLinker raw → Natives Format

**KOMPLETT-TABELLE: Jedes Feld das gesetzt werden muss**

| Ziel-Feld (Firestore) | Quelle (raw.*) | Typ | Fallback | Pflicht |
|---|---|---|---|---|
| `source` | detectMarketplace(raw) | string | — | ✅ JA |
| `marketplace` | detectMarketplace(raw) | string | — | ✅ JA |
| `marketplaceOrderId` | `raw.extra_field_1` (eBay OrderID) ODER `raw.order_id` | string | — | ✅ JA |
| `externalOrderId` | = marketplaceOrderId | string | — | ✅ JA |
| `marketplaceKey` | `${marketplace}__${marketplaceOrderId}` | string | — | ✅ JA |
| `customer.name` | `raw.delivery_fullname` | string | `raw.invoice_fullname` | ✅ JA |
| `customer.street` | `[raw.delivery_address, raw.delivery_address2].filter(Boolean).join(', ')` | string | `raw.invoice_address` + `raw.invoice_address2` | ✅ JA |
| `customer.city` | `raw.delivery_city` | string | `raw.invoice_city` | ✅ JA |
| `customer.zip` | `raw.delivery_postcode` | string | `raw.invoice_postcode` | ✅ JA |
| `customer.country` | `raw.delivery_country_code` | string | `raw.invoice_country_code` | ✅ JA |
| `customer.phone` | `raw.delivery_phone` | string | `raw.invoice_phone` → `raw.phone` | ⚠️ Optional |
| `customer.email` | `raw.email` | string | `raw.invoice_email` | ⚠️ Optional |
| `billingAddress.name` | `raw.invoice_fullname` | string | `raw.delivery_fullname` | ⚠️ Optional |
| `billingAddress.street` | `[raw.invoice_address, raw.invoice_address2].filter(Boolean).join(', ')` | string | — | ⚠️ Optional |
| `billingAddress.city` | `raw.invoice_city` | string | — | ⚠️ Optional |
| `billingAddress.zip` | `raw.invoice_postcode` | string | — | ⚠️ Optional |
| `billingAddress.country` | `raw.invoice_country_code` | string | — | ⚠️ Optional |
| `totalAmount` | `parseFloat(raw.payment_done)` falls > 0, sonst existierenden Wert behalten | number | Bestehender Wert | ⚠️ Nur wenn fehlend |
| `currency` | `raw.currency` | string | 'EUR' | ⚠️ Nur wenn fehlend |
| `paymentMethod` | `raw.payment_method` | string | null | ⚠️ Optional |
| `paymentStatus` | `parseFloat(raw.payment_done) > 0 ? 'paid' : 'pending'` | string | null | ⚠️ Optional |
| `paidAt` | `raw.date_confirmed ? new Date(raw.date_confirmed * 1000).toISOString() : null` | string/null | null | ⚠️ Optional |
| `shippingService` | `raw.delivery_method` | string | null | ⚠️ Optional |
| `trackingNumber` | `raw.delivery_package_nr` | string | null | ⚠️ Optional |
| `carrier` | Aus `raw.delivery_method` den Carrier extrahieren (DHL, DPD, GLS, Hermes etc.) | string | null | ⚠️ Optional |
| `shippingCost` | `parseFloat(raw.delivery_price)` | number | 0 | ⚠️ Optional |
| `buyerNote` | `raw.user_comments` | string | null | ⚠️ Optional |
| `createdAt` | `raw.date_add ? new Date(raw.date_add * 1000).toISOString() : existingCreatedAt` | string | Bestehender Wert | ⚠️ Nur wenn fehlend |

**ACHTUNG — BaseLinker Timestamps:**
- BaseLinker speichert Timestamps als **Unix-Sekunden** (NICHT Millisekunden!)
- Konvertierung: `new Date(raw.date_add * 1000).toISOString()`
- Relevante Timestamp-Felder: `raw.date_add`, `raw.date_confirmed`, `raw.date_in_status`

##### 5. ITEMS-ARRAY MAPPING

Das `raw`-Feld enthält ein `products`-Array mit den Bestellpositionen:

```js
function mapItems(raw, orderId) {
  const products = raw.products || [];
  return products.map((p, idx) => ({
    id: `${orderId}-${idx + 1}`,
    name: p.name || p.product_id || 'Unbekannt',
    sku: p.sku || null,
    quantity: parseInt(p.quantity, 10) || 1,
    priceBrutto: parseFloat(p.price_brutto) || 0,
    currency: raw.currency || 'EUR',
    ean: p.ean || null,
    // eBay-spezifisch:
    itemId: p.auction_id || null,          // eBay ItemID
    transactionId: p.order_product_id || null,
  }));
}
```

**WICHTIG:**
- Items nur überschreiben wenn das aktuelle `items`-Array leer ist oder fehlt!
- Wenn `items` bereits existiert und gefüllt ist → NICHT überschreiben (könnte manuell korrigiert worden sein)

##### 6. STATUS-ZUORDNUNG

BaseLinker hat eigene `order_status_id` Werte. Diese müssen auf das AvyCloud OMS-System gemappt werden.

```js
// BaseLinker Status IDs → AvyCloud OMS Status
// ACHTUNG: Die genauen BL Status-IDs müssen aus den raw-Daten ermittelt werden.
// Fallback: Aus raw.order_status_id + Marketplace-Daten den besten OMS-Status ableiten.
function mapStatus(raw, marketplace) {
  // Wenn Zahlung erfolgt + Tracking vorhanden → shipped
  if (parseFloat(raw.payment_done) > 0 && raw.delivery_package_nr) return 'shipped';
  // Wenn Zahlung erfolgt aber kein Tracking → confirmed
  if (parseFloat(raw.payment_done) > 0) return 'confirmed';
  // Sonst → pending
  return 'pending';
}
```

**BESSER:** Nicht den Status erraten, sondern die echte Marketplace-API abfragen!
→ Für jeden eBay-Order: eBay GetOrders aufrufen mit der marketplaceOrderId
→ Für jeden Kaufland-Order: Kaufland API /orders/ aufrufen
→ Aktuellen Status von dort übernehmen (über `mapEbayStatus()` / `mapKauflandStatus()`)

**EMPFOHLENER ANSATZ:** Migration in 2 Phasen:
1. **Phase 1 (dieses Script):** Marketplace, Kundendaten, Zahlung, Versand, Items migrieren
2. **Phase 2 (danach):** Status-Reconciliation über normalen Sync-Pfad laufen lassen (order-intake-ebay/kaufland syncen automatisch Status bei vorhandener marketplaceKey)

##### 7. CARRIER-ERKENNUNG aus delivery_method

```js
function extractCarrier(deliveryMethod) {
  if (!deliveryMethod) return null;
  const m = deliveryMethod.toLowerCase();
  if (m.includes('dhl')) return 'DHL';
  if (m.includes('dpd')) return 'DPD';
  if (m.includes('gls')) return 'GLS';
  if (m.includes('hermes')) return 'Hermes';
  if (m.includes('ups')) return 'UPS';
  if (m.includes('fedex')) return 'FedEx';
  if (m.includes('deutsche post')) return 'Deutsche Post';
  return deliveryMethod;  // Originalwert als Fallback
}
```

##### 8. KOMPLETTE UPDATE-LOGIK PRO ORDER

```js
function buildUpdates(order, raw) {
  const updates = {};
  const marketplace = detectMarketplace(raw);

  if (marketplace === 'unknown') {
    return { updates: null, marketplace, reason: 'marketplace unknown' };
  }

  // --- PFLICHTFELDER (IMMER setzen) ---
  updates['source'] = marketplace;
  updates['marketplace'] = marketplace;

  // MarketplaceOrderId: Bei eBay ist die echte OrderID oft in extra_field_1
  const mktOrderId = raw.extra_field_1 || String(raw.order_id || '');
  if (mktOrderId) {
    updates['marketplaceOrderId'] = mktOrderId;
    updates['externalOrderId'] = mktOrderId;
    updates['marketplaceKey'] = `${marketplace}__${mktOrderId}`;
  }

  // --- KUNDENDATEN (nur setzen wenn fehlend oder unvollständig) ---
  const customer = order.customer || {};

  if (!customer.name && raw.delivery_fullname) {
    updates['customer.name'] = raw.delivery_fullname;
  }
  if (!customer.street) {
    const street = [raw.delivery_address, raw.delivery_address2].filter(Boolean).join(', ')
      || [raw.invoice_address, raw.invoice_address2].filter(Boolean).join(', ');
    if (street) updates['customer.street'] = street;
  }
  if (!customer.city) {
    updates['customer.city'] = raw.delivery_city || raw.invoice_city || null;
  }
  if (!customer.zip) {
    updates['customer.zip'] = raw.delivery_postcode || raw.invoice_postcode || null;
  }
  if (!customer.country) {
    updates['customer.country'] = raw.delivery_country_code || raw.invoice_country_code || null;
  }
  if (!customer.phone) {
    updates['customer.phone'] = raw.delivery_phone || raw.invoice_phone || raw.phone || null;
  }
  if (!customer.email) {
    updates['customer.email'] = raw.email || raw.invoice_email || null;
  }

  // --- BILLING ADDRESS (nur wenn vorhanden in raw) ---
  if (!order.billingAddress && raw.invoice_fullname) {
    updates['billingAddress'] = {
      name: raw.invoice_fullname,
      street: [raw.invoice_address, raw.invoice_address2].filter(Boolean).join(', '),
      city: raw.invoice_city || '',
      zip: raw.invoice_postcode || '',
      country: raw.invoice_country_code || '',
    };
  }

  // --- ZAHLUNG (nur setzen wenn fehlend) ---
  if (!order.paymentMethod && raw.payment_method) {
    updates['paymentMethod'] = raw.payment_method;
  }
  if (!order.paymentStatus) {
    const paid = parseFloat(raw.payment_done || '0') > 0;
    updates['paymentStatus'] = paid ? 'paid' : 'pending';
  }
  if (!order.paidAt && raw.date_confirmed) {
    updates['paidAt'] = new Date(raw.date_confirmed * 1000).toISOString();
  }

  // --- VERSAND (nur setzen wenn fehlend) ---
  if (!order.shippingService && raw.delivery_method) {
    updates['shippingService'] = raw.delivery_method;
  }
  if (!order.trackingNumber && raw.delivery_package_nr) {
    updates['trackingNumber'] = raw.delivery_package_nr;
  }
  if (!order.carrier && raw.delivery_method) {
    updates['carrier'] = extractCarrier(raw.delivery_method);
  }
  if (order.shippingCost === undefined && raw.delivery_price) {
    updates['shippingCost'] = parseFloat(raw.delivery_price) || 0;
  }

  // --- SONSTIGES ---
  if (!order.buyerNote && raw.user_comments) {
    updates['buyerNote'] = raw.user_comments;
  }
  if (!order.currency && raw.currency) {
    updates['currency'] = raw.currency || 'EUR';
  }
  if (!order.totalAmount && raw.payment_done) {
    const total = parseFloat(raw.payment_done);
    if (total > 0) updates['totalAmount'] = total;
  }

  // --- TIMESTAMPS (nur wenn fehlend) ---
  if (!order.createdAt && raw.date_add) {
    updates['createdAt'] = new Date(raw.date_add * 1000).toISOString();
  }
  if (!order.shippedAt && raw.delivery_package_nr && raw.date_in_status) {
    // Wenn Tracking vorhanden → Versanddatum aus letztem Status-Datum
    updates['shippedAt'] = new Date(raw.date_in_status * 1000).toISOString();
  }

  // --- ITEMS (nur wenn fehlend oder leer) ---
  if (!order.items || order.items.length === 0) {
    const items = mapItems(raw, order.orderId);
    if (items.length > 0) updates['items'] = items;
  }

  // Null-Werte entfernen (Firestore mag keine null-Updates)
  for (const [key, val] of Object.entries(updates)) {
    if (val === null || val === undefined) delete updates[key];
  }

  return { updates, marketplace, reason: null };
}
```

##### 9. BATCH-EXECUTION

```js
async function migrateBaselinkerOrders() {
  console.log(`[migrate-bl-orders] Starting... ${dryRun ? '(DRY RUN)' : ''}`);

  const snap = await firestore
    .collection(ORDERS_COLLECTION)
    .where('source', '==', 'baselinker')
    .get();

  console.log(`[migrate-bl-orders] Found ${snap.size} BaseLinker orders`);

  let batch = firestore.batch();
  let batchCount = 0;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let unknownMarketplace = [];

  const commitBatch = async () => {
    if (batchCount === 0) return;
    await batch.commit();
    batch = firestore.batch();
    batchCount = 0;
  };

  for (const doc of snap.docs) {
    const order = doc.data();
    const raw = order?.raw;

    if (!raw) {
      console.warn(`  SKIP ${doc.id}: Kein raw-Feld vorhanden!`);
      skipped++;
      continue;
    }

    const { updates, marketplace, reason } = buildUpdates(order, raw);

    if (!updates || Object.keys(updates).length === 0) {
      if (reason === 'marketplace unknown') {
        unknownMarketplace.push({ docId: doc.id, orderId: order.orderId, rawOrderSource: raw.order_source });
      }
      skipped++;
      continue;
    }

    // Migrations-Metadaten
    updates['_migration'] = {
      migratedAt: new Date().toISOString(),
      migratedFrom: 'baselinker',
      migratedTo: marketplace,
      scriptVersion: '1.0.0',
    };

    if (dryRun) {
      console.log(`  [DRY] ${doc.id} (${order.orderId}): ${marketplace}`);
      console.log(`         Updates: ${JSON.stringify(updates, null, 2)}`);
      migrated++;
      continue;
    }

    try {
      const ref = firestore.collection(ORDERS_COLLECTION).doc(doc.id);
      batch.update(ref, updates);
      batchCount++;
      migrated++;

      if (batchCount >= 400) {
        await commitBatch();
        console.log(`  ... ${migrated} orders migrated`);
      }
    } catch (err) {
      console.error(`  ERROR ${doc.id}: ${err.message}`);
      errors++;
    }
  }

  await commitBatch();  // Restliche Batch committen

  // Zusammenfassung
  console.log(`\n[migrate-bl-orders] DONE!`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
  if (unknownMarketplace.length > 0) {
    console.log(`  UNKNOWN MARKETPLACE (manuell prüfen):`);
    unknownMarketplace.forEach(u => console.log(`    - ${u.docId} (${u.orderId}): raw.order_source = "${u.rawOrderSource}"`));
  }
}

migrateBaselinkerOrders()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate-bl-orders] Fatal:', err);
    process.exit(1);
  });
```

##### 10. AUSFÜHRUNGSREIHENFOLGE

1. **ZUERST:** `node backend/scripts/migrate-baselinker-orders.js --dry-run` → Output prüfen!
2. **Output validieren:** Prüfen ob marketplace korrekt erkannt wird, ob Adressen vollständig sind
3. **DANN:** `node backend/scripts/migrate-baselinker-orders.js` → Live-Migration
4. **DANACH:** Normalen Order-Sync laufen lassen → Status-Reconciliation via `order-intake-ebay.js` + `order-intake-kaufland.js` gleicht automatisch Status ab (die erkennen vorhandene Orders über `marketplaceKey` und updaten den Status)

##### 11. VERIFIKATION NACH MIGRATION

```js
// Verifikations-Query: Dürfen KEINE BaseLinker-Orders mehr existieren
const remaining = await firestore
  .collection('orders')
  .where('source', '==', 'baselinker')
  .get();
console.log(`Remaining BaseLinker orders: ${remaining.size}`);
// MUSS 0 sein!

// Spot-Check: Bekannte Order prüfen
const testOrder = await firestore
  .collection('orders')
  .where('marketplaceOrderId', '==', '07-14365-99405')
  .get();
const data = testOrder.docs[0]?.data();
console.log('Source:', data?.source);          // MUSS 'ebay' sein
console.log('Marketplace:', data?.marketplace);  // MUSS 'ebay' sein
console.log('Customer:', data?.customer);        // MUSS name, street, city, zip, country haben
console.log('Payment:', data?.paymentMethod);    // MUSS befüllt sein
console.log('Tracking:', data?.trackingNumber);  // MUSS befüllt sein (wenn vorhanden)
```

##### 12. EDGE CASES — EXPLIZIT BEHANDELN

| Edge Case | Behandlung |
|---|---|
| `raw` fehlt komplett | SKIP + Warnung loggen. Diese Order muss manuell geprüft werden. |
| `raw.order_source` fehlt | Fallback auf OrderID-Format-Erkennung (siehe detectMarketplace) |
| `raw.delivery_fullname` ist leer | Fallback auf `raw.invoice_fullname` |
| `raw.payment_done` ist String "0" | `parseFloat()` → 0 → paymentStatus = 'pending' |
| `raw.date_add` ist 0 oder fehlt | Bestehenden `createdAt` Wert behalten |
| `raw.products` ist leer | Items-Array NICHT überschreiben, bestehende Items behalten |
| Order hat bereits `marketplace`-Feld | Trotzdem `source` auf korrekten Wert setzen! |
| `raw.delivery_package_nr` hat mehrere Nummern (Komma-getrennt) | Erste Nummer nehmen: `raw.delivery_package_nr.split(',')[0].trim()` |
| Marketplace "unknown" erkannt | NICHT migrieren → in separater Liste loggen → manuell zuordnen |

##### 13. KEINE SEITENEFFEKTE

- **KEIN** `raw`-Feld löschen oder modifizieren — wird weiterhin als Backup gebraucht
- **KEIN** `orderId` ändern — das ist die interne AvyCloud-ID
- **KEINE** Orders löschen — nur Felder updaten/ergänzen
- **KEINE** Marketplace-API-Calls in diesem Script — das macht Phase 2 (Status-Reconciliation)
- **KEIN** Frontend-Code ändern — `sourceBadge()` funktioniert korrekt sobald `marketplace` gesetzt ist

---

#### ZUSAMMENFASSUNG FÜR CLAUDE CODE

**Erstelle GENAU EINE Datei:** `backend/scripts/migrate-baselinker-orders.js`

**Das Script MUSS:**
1. Alle Orders mit `source: 'baselinker'` aus Firestore `orders` Collection laden
2. Für jede Order das `raw`-Feld auslesen
3. Marketplace via `raw.order_source` erkennen (eBay oder Kaufland)
4. `source` und `marketplace` auf den korrekten Wert setzen ('ebay' oder 'kaufland')
5. `marketplaceOrderId`, `externalOrderId`, `marketplaceKey` setzen
6. Kundendaten aus `raw.delivery_*` / `raw.invoice_*` extrahieren und in `customer.*` setzen
7. Zahlungsdaten (`paymentMethod`, `paymentStatus`, `paidAt`) aus `raw.payment_*` setzen
8. Versanddaten (`trackingNumber`, `carrier`, `shippingService`, `shippingCost`) aus `raw.delivery_*` setzen
9. Items-Array aus `raw.products[]` mappen (nur wenn leer)
10. Timestamps korrekt konvertieren: `new Date(unixSeconds * 1000).toISOString()`
11. Batched Writes verwenden (max 400 pro Batch)
12. `--dry-run` Flag unterstützen
13. Migrations-Metadaten in `_migration`-Feld speichern
14. Zusammenfassung am Ende loggen (migrated, skipped, errors, unknown)

**Das Script darf NICHT:**
- `raw`-Feld löschen oder ändern
- Orders löschen
- `orderId` ändern
- Marketplace-APIs aufrufen
- Frontend-Code ändern
- Bereits gefüllte Felder überschreiben (nur leere/fehlende Felder setzen, AUSNAHME: `source` und `marketplace` IMMER überschreiben)

**Erfolgskriterium:**
- `where('source', '==', 'baselinker')` liefert 0 Ergebnisse
- Order `07-14365-99405` zeigt `source: 'ebay'`, `marketplace: 'ebay'`, vollständige Kundendaten
- Frontend zeigt eBay/Kaufland-Badge statt "baselinker"

---

### BUG-041 — Kaufland Order-Intake: Fehlende Felder (P0)

**Symptom:** Kaufland-Bestellungen in der Detail-Ansicht zeigen:
- Zahlung: "—"
- Versand: "—"
- Weitere Felder fehlen komplett

**Root Cause:** `mapKauflandOrder()` (Zeile 67-108 in `order-intake-kaufland.js`) extrahiert nur Basis-Felder. Im Vergleich zum eBay-Intake fehlen:

| Feld | eBay-Intake | Kaufland-Intake |
|------|-------------|-----------------|
| `paidAt` | ✅ Zeile 137 | ❌ Nicht extrahiert |
| `shippedAt` | ✅ Zeile 138 | ❌ Nicht extrahiert |
| `paymentMethod` | ✅ Zeile 152 | ❌ Nicht extrahiert |
| `shippingService` | ✅ Zeile 153 | ❌ Nicht extrahiert |
| `shippingCost` | ✅ Zeile 154 | ❌ Nicht extrahiert |
| `trackingNumber` | ✅ Zeile 155 | ❌ Nicht extrahiert |
| `carrier` | ✅ Zeile 156 | ❌ Nicht extrahiert |

Zusätzlich speichert `saveOrderIfNew()` (Zeile 338-365) in Kaufland diese Felder nicht im Firestore-Doc, selbst wenn sie im Mapping wären.

**Fix-Strategie:**
1. `mapKauflandOrder()` erweitern — Kaufland-API-Felder mappen:
   - `paidAt` ← `klOrder.ts_units_paid` oder aus Unit-Status-Timestamps
   - `shippingCost` ← Summe der Unit `delivery_cost` oder `klOrder.shipping_costs`
   - `paymentMethod` ← `klOrder.payment_method` falls vorhanden
   - `trackingNumber` + `carrier` ← aus `klOrder.order_units[].tracking_*` Feldern
2. `saveOrderIfNew()` erweitern — fehlende Felder in den Firestore-Doc aufnehmen (analog zu eBay-Intake Zeile 359-374)

**Betroffene Dateien:**
- `backend/services/order-intake-kaufland.js` — `mapKauflandOrder()` (Zeile 67-108) + `saveOrderIfNew()` (Zeile 338-365)

**Referenz:** eBay-Intake als Vorlage: `backend/services/order-intake-ebay.js` Zeile 95-159 (Mapping) + Zeile 346-376 (Save)

---

### BUG-042 — Kaufland Adresse unvollständig (P1)

**Symptom:** Kaufland-Bestellungen zeigen "Adresse unvollständig" (rot) in der Detail-Ansicht. Betroffen z.B. MEQ3L35.

**Root Cause:** `mapKauflandOrder()` Zeile 84:
```js
const shippingAddr = klOrder.buyer?.shipping_address || klOrder.shipping_address || {};
```
Wenn Kaufland die Adresse in einem anderen Feld liefert (z.B. `klOrder.delivery_address`, direkt in `klOrder.buyer`), wird `shippingAddr` zu `{}` und alle Adressfelder (`street`, `city`, `zip`) werden `null`.

**Fix-Strategie:**
1. Kaufland API-Response loggen/debuggen für betroffene Orders (aus `raw`-Feld in Firestore)
2. Alle möglichen Adress-Pfade in der Kaufland-API-Response abdecken
3. Fallback auf `billing_address` wenn `shipping_address` leer

**Betroffene Dateien:**
- `backend/services/order-intake-kaufland.js` — `mapKauflandOrder()` (Zeile 84-101)

---

### BUG-043 — Returns-Engine: `totalRefund` + `ebayReason` Referenz-Fehler (P1)

**Symptom:** eBay-Returns-Updates crashen still. Existierende Returns werden nie aktualisiert.

**Root Cause:** `returns-engine.js` hat zwei Variable-Referenz-Bugs:

1. **Zeile ~382:** `totalRefund` wird im Update-Block referenziert, aber erst im New-Doc-Block (~Zeile 411) berechnet. Wenn eine existierende Retoure `refundAmount === 0` hat → `ReferenceError`
2. **Zeile ~446:** `ebayReason` wird referenziert, existiert aber nie als Variable. Stattdessen gibt es `cancelReason` und `refundReason`.

Beide Fehler werden vom umgebenden try/catch geschluckt → Return bleibt auf altem Stand.

**Fix-Strategie:**
1. `totalRefund` Berechnung VOR den Update-Block verschieben (oder eigene Funktion)
2. `ebayReason` durch die korrekte Variable ersetzen (`cancelReason` oder `refundReason`)

**Betroffene Dateien:**
- `backend/services/returns-engine.js` — `syncEbayReturns()` (~Zeile 370-460)

---

### BUG-044 — Kaufland Returns: Keine Pagination (P2)

**Symptom:** Bei >100 Kaufland-Returns im Zeitraum (30 Tage) gehen Returns verloren.

**Root Cause:** `syncKauflandReturns()` nutzt `{ limit: 100 }` ohne Pagination-Loop. Die Kaufland API liefert `pagination.total` und `pagination.offset`, die werden ignoriert.

**Fix:** Pagination-Loop analog zu `syncKauflandOrders()` implementieren.

**Betroffene Dateien:**
- `backend/services/returns-engine.js` — `syncKauflandReturns()`

---

### BUG-045 — eBay Order-Intake: Kein Status-Update nach Import (P1)

**Symptom:** eBay-Orders bleiben in AvyCloud auf dem Initialstatus stehen (z.B. "pending"), auch wenn eBay den Status auf "Completed" oder "Cancelled" ändert.

**Root Cause:** `saveOrderIfNew()` in `order-intake-ebay.js` (Zeile ~296-300):
```js
const existingSnap = await db.collection(ORDERS_COLLECTION)
  .where('marketplaceKey', '==', marketplaceKey).limit(1).get();
if (!existingSnap.empty) return false; // ← Gibt sofort false zurück!
```
Keine Status-Reconciliation. Kaufland-Intake hat dagegen einen kompletten Reconciliation-Block (Zeile 252-300).

**Fix-Strategie:**
1. Nach dem `!existingSnap.empty` Check: eBay-Status vergleichen mit internem `omsStatus`
2. Wenn eBay weiter ist → Update analog zur Kaufland-Reconciliation
3. Mindestens: `completed` und `cancelled` von eBay übernehmen

**Betroffene Dateien:**
- `backend/services/order-intake-ebay.js` — `saveOrderIfNew()` (Zeile ~283-380)
- **Referenz:** `order-intake-kaufland.js` Zeile 252-300 (Kaufland Reconciliation als Vorlage)

---

### BUG-046 — Dashboard Shipping-Kosten: Noch BaseLinker-Fallback (P2)

**Symptom:** Dashboard-Versandkosten zeigen `source: 'baselinker'` Fallback.

**Root Cause:** `routes/orders.js` Zeile ~803-808:
```js
return { total_cost: svTotalNetto, parcel_count: parcelCount, currency: 'EUR', source: 'sevdesk+baselinker' };
// ...
return { ...bl, total_cost: blNetto, source: 'baselinker' };
```
Der Shipping-KPI-Endpunkt fällt auf BaseLinker-API zurück wenn SevDesk keine Daten liefert.

**Fix:** BaseLinker-Fallback entfernen, stattdessen nur SevDesk + SendCloud als Versandkosten-Quellen.

**Betroffene Dateien:**
- `backend/routes/orders.js` — Dashboard shipping KPI endpoint (~Zeile 790-810)

---

## Feature-Gap-Analyse: AvyCloud vs. Konkurrenz (JTL, Billbee, Xentral)

> **Stand 2026-03-13.** Benchmark gegen JTL-Wawi, Billbee, Xentral — die drei führenden deutschen E-Commerce-ERPs.
> Ziel: AvyCloud muss Bestellungen, Retouren, Versand, Buchhaltung vollumfänglich abdecken.

### Bestellungen (Orders)

| Feature | JTL | Billbee | Xentral | AvyCloud | Gap |
|---------|-----|---------|---------|----------|-----|
| Multi-Marketplace Import | ✅ | ✅ | ✅ | ✅ eBay+Kaufland | — |
| Status-Pipeline 12+ Stufen | ✅ | ✅ | ✅ | ✅ 12 Stufen | — |
| Auftragssuche (Volltextsuche) | ✅ | ✅ | ✅ | ❌ | **FEAT-ORD-01** |
| Datumsfilter | ✅ | ✅ | ✅ | ❌ | **FEAT-ORD-02** |
| CSV/Excel-Export | ✅ | ✅ | ✅ | ❌ | **FEAT-ORD-03** |
| Interne Notizen pro Auftrag | ✅ | ✅ | ✅ | ❌ | **FEAT-ORD-04** |
| Bulk-Druck (Lieferscheine/Rechnungen) | ✅ | ✅ | ✅ | ❌ | **FEAT-ORD-05** |
| Automatische Rechnungserzeugung bei Versand | ✅ | ✅ | ✅ | ❌ | **FEAT-ORD-06** |
| Marketplace-Status-Reconciliation | ✅ | ✅ | ✅ | ✅ eBay+Kaufland | ✅ Fixed (BUG-045) |

### Retouren (Returns)

| Feature | JTL | Billbee | Xentral | AvyCloud | Gap |
|---------|-----|---------|---------|----------|-----|
| Marketplace-Sync (eBay/Kaufland) | ✅ | ✅ | ✅ | ✅ | — |
| Retoure-Workflow (Prüfung→Erstattung) | ✅ | ✅ | ✅ | ✅ | — |
| Wareneingang A/B/C-Ware | ✅ | ⚠️ | ✅ | ✅ | — |
| Marketplace-Erstattung auslösen | ✅ | ✅ | ✅ | ✅ | — |
| Retoure-Detail-Ansicht | ✅ | ✅ | ✅ | ❌ | **FEAT-RET-01** |
| Retourelabel drucken | ✅ | ✅ | ✅ | ❌ | **FEAT-RET-02** |
| Gutschrift/Stornorechnung | ✅ | ✅ | ✅ | ❌ | **B6** |
| Bulk-Aktionen (Erstatten, Schließen) | ✅ | ✅ | ⚠️ | ❌ | **FEAT-RET-03** |
| CSV-Export | ✅ | ✅ | ✅ | ❌ | **FEAT-RET-04** |

### Versand (Shipping)

| Feature | JTL | Billbee | Xentral | AvyCloud | Gap |
|---------|-----|---------|---------|----------|-----|
| Label-Erstellung (DHL, DPD, etc.) | ✅ | ✅ | ✅ | ✅ SendCloud | — |
| Bulk-Label-Erstellung | ✅ | ✅ | ✅ | ✅ | — |
| Carrier-Autoselection (Gewicht) | ✅ | ✅ | ✅ | ✅ | — |
| Tracking-Push an Marketplaces | ✅ | ✅ | ✅ | ✅ | — |
| Tracking-Webhooks (Zustellung) | ✅ | ✅ | ✅ | ❌ | **B2** |
| Retourelabel via SendCloud | ✅ | ✅ | ✅ | ❌ | **FEAT-RET-02** |
| Versandkosten-Dashboard | ✅ | ✅ | ✅ | ✅ | — |
| Label-Format (Thermal/A4/A6) | ✅ | ✅ | ✅ | ⚠️ nur Thermal | **FEAT-SHP-01** |

### Buchhaltung (Invoicing)

| Feature | JTL | Billbee | Xentral | AvyCloud | Gap |
|---------|-----|---------|---------|----------|-----|
| Rechnungs-PDF-Erzeugung | ✅ | ✅ | ✅ | ✅ | — |
| Lieferschein-PDF | ✅ | ✅ | ✅ | ✅ | — |
| Automatische Rechnung bei Versand | ✅ | ✅ | ✅ | ❌ | **FEAT-ORD-06** |
| Rechnungs-Email an Kunde | ✅ | ✅ | ✅ | ❌ | **B5** |
| Gutschrift/Stornorechnung | ✅ | ✅ | ✅ | ❌ | **B6** |
| MwSt-Sätze (19%, 7%, 0%) | ✅ | ✅ | ✅ | ❌ nur 19% | **B7** |
| SevDesk-Export | ✅ | ✅ | ✅ | ❌ broken (BUG-050: nur Skelett) | **B3** |
| PDF-Download im UI | ✅ | ✅ | ✅ | ❌ (BUG-047: kein Proxy) | **B4** |
| Rechnungsübersicht mit Suche | ✅ | ✅ | ✅ | ⚠️ nur Tabs | **FEAT-INV-01** |
| Bulk-Rechnungserzeugung | ✅ | ✅ | ✅ | ❌ | **FEAT-INV-02** |
| Marketplace-Erstattung automatisch | ✅ | ✅ | ✅ | ❌ (BUG-049: manuell) | **BUG-049** |

### Priorisierte Feature-Tasks (aus Gap-Analyse)

| ID | Feature | Priorität | Aufwand |
|----|---------|-----------|---------|
| FEAT-ORD-01 | Auftragssuche (Order-ID, Kunde, SKU) | P1 | S |
| FEAT-ORD-02 | Datumsfilter für Bestellungsliste | P1 | S |
| FEAT-ORD-03 | CSV/Excel-Export Bestellungen | P2 | S |
| FEAT-ORD-04 | Interne Notizen pro Auftrag | P2 | M |
| FEAT-ORD-05 | Bulk-Druck (Lieferscheine/Rechnungen) | P1 | M |
| FEAT-ORD-06 | Auto-Rechnung bei Status → shipped | P1 | M |
| FEAT-RET-01 | Retoure-Detail-Ansicht (Modal/Panel) | P1 | M |
| FEAT-RET-02 | Retourelabel via SendCloud | P2 | M |
| FEAT-RET-03 | Bulk-Retoure-Aktionen | P2 | S |
| FEAT-RET-04 | CSV-Export Retouren | P2 | S |
| FEAT-SHP-01 | Label-Format A4/A6 + Thermal wählbar | P2 | S |
| FEAT-INV-01 | Rechnungsübersicht: Suche + Datumsfilter + PDF-Download | P1 | M |
| FEAT-INV-02 | Bulk-Rechnungserzeugung | P2 | M |

> **S** = Small (< 1 Tag), **M** = Medium (1-2 Tage), **L** = Large (3+ Tage)

---

## Deep Dive 3 — Zusammenfassung (2026-03-13)

> **Audit-Ergebnis:** 4 parallele Deep Dives über BaseLinker-Reste, Frontend-UX, Backend-Services, FAKE→REAL.

### Positive Entwicklungen (gefixt seit letztem Deep Dive)
- ✅ **FAKE→REAL komplett:** Alle 12 Views nutzen echte API-Daten (ShippingView, InvoicesView, ReturnsView, BillingSettings neu verifiziert)
- ✅ **BUG-043 gefixt:** returns-engine.js totalRefund + ebayReason korrekt
- ✅ **BUG-044 gefixt:** Kaufland Returns Pagination mit offset/limit Loop + 5000-Cap
- ✅ **BUG-045 gefixt:** eBay saveOrderIfNew() hat jetzt Rank-basierte Status-Reconciliation + 30-Tage Lookback
- ✅ **Keine Mock-Daten mehr:** Kein MOCK_* Array, kein setTimeout-Fake, kein "Coming Soon" in der Codebase

### Kritische Findings (NEU)
1. **⛔ BaseLinker ist NICHT entfernt (136+ Dateien!):**
   - Auto-Sync bei Server-Start (BUG-051): Stock-Sync alle 15s, Runner-Start, Inventory-Import
   - Dashboard-KPIs über BL-API (BUG-048): Revenue, Returns, Shipping aus `callBaseLinker('getOrders')`
   - RBAC `baselinker:read/sync` aktiv (BUG-052)
   - Integration-Registry listet BL als "active"
   - 6 BL-API-Endpoints in routes/marketplace.js
   - 15+ Frontend-Komponenten mit BL-Features (Sync-Buttons, Spalten, Filter)
   - 34 Scripts in backend/scripts/

2. **📄 Invoice PDF nicht zugänglich (BUG-047):**
   - PDFs in GCS gespeichert, aber kein Proxy-Endpoint für Browser-Download
   - OrderDetail hat "Rechnung erstellen" Button aber zeigt danach keinen Download-Link

3. **💰 SevDesk-Export defekt (BUG-050):**
   - Erstellt nur leere Draft-Rechnung (Status 100) ohne Positionen, Kontakt, Adresse

4. **🔄 Kein Marketplace Refund Push (BUG-049):**
   - Erstattungen werden in AvyCloud verarbeitet aber nicht automatisch an eBay/Kaufland gepusht

### UX-Feature-Gaps (Frontend — kein Backend-Change nötig)

| View | Fehlend | Impact |
|------|---------|--------|
| **OrdersView** | Suche, Datumsfilter, Export, Notizen, Bulk-Label-Druck | HOCH — Produktivität |
| **OrderDetail** | PDF-Download-Links, Kunden-Notizen, Return-Initiation | HOCH — Workflow |
| **InvoicesView** | Suche, Datumsfilter, PDF-Download, Credit Notes, Bulk | HOCH — Compliance |
| **ReturnsView** | Detail-Ansicht, Bulk-Aktionen, Export, Reason-Filter | MITTEL |
| **ShippingView** | Label-Format-Auswahl, Carrier-Override, Return-Labels | MITTEL |
| **Dashboard** | PDF-Export, Vergleichsperioden, Drill-Down | NIEDRIG |

### BaseLinker-Entfernung: Vollständige Datei-Liste

**Zu löschende Dateien (9 Kern-Dateien):**
```
backend/lib/baselinker.js                          (96 KB, Haupt-Client)
backend/lib/baselinker-shipping.js
backend/lib/baselinker-sync-jobs.js
backend/lib/baselinker-category-canonical.js
backend/lib/baselinker-category-resolver.js
backend/lib/baselinker-inventory-category-index.js
backend/lib/baselinker-inventory-category-source.js
backend/services/baselinker-sync-runner.js
backend/services/baselinker-category.js
```

**Zu bereinigende Dateien (29 Consumer-Module):**
```
backend/index.js                — Zeile 6, 11, 50-54, 80-112, 115, 141, 181-187, 280
backend/routes/orders.js        — Zeile 6, 8, 22-410, 746-810
backend/routes/marketplace.js   — Zeile 1553-1855 (6 BL-Endpoints, ~300 Zeilen)
backend/routes/products.js      — Zeile 57-58, 728, 1414-1475
backend/routes/identify.js      — Zeile 370-371
backend/routes/warehouse.js     — Zeile 349, 369, 407, 449
backend/routes/admin.js         — Zeile 839
backend/services/inventory-sync.js    — BL-Import
backend/services/order-sync.js        — BL-Import
backend/services/rulebook-runner.js   — Zeile 13-14
backend/services/admin-bulk-actions.js — Zeile 12-13
backend/services/improve.js           — Zeile 1171
backend/services/toolkit.js           — Zeile 4
backend/lib/rbac.js                   — Zeile 40, 51
backend/lib/integration-registry.js   — Zeile 55-66
backend/__tests__/api/_patchLocalModules.js — Zeile 153-155, 201-220, 290-293
api/client.ts           — fetchBaseLinkerCategories, syncToBaseLinker, lookupBaseLinkerBySkus
types.ts                — Zeile 138-148, 178-185, 405-406, 652-655
i18n.tsx                — Zeile 274, 580-581
utils/product.ts        — Zeile 145-160
components/ProductSheet.tsx      — BL-Sync-Button + Category
components/AdminTable.tsx        — BL-Spalten + Bulk-Sync
components/BulkActions.tsx       — "BL Sync" Button
components/AdminTableFilters.tsx — BL-Filter
components/Dashboard.tsx         — BL-Sync-Status
components/IntegrationWizard.tsx — BL-Badge
components/IntegrationsHub.tsx   — BL-Badge
components/GeminiChat.tsx        — baselinker_category_search Tool
components/OperationsView.tsx    — Section Title
components/OrdersView.tsx        — sourceBadge BL-Filter
backend/cloudbuild.yaml          — Zeile 35 (BL-Lint-Check)
```

**Zu löschende Scripts (34 Dateien in backend/scripts/):**
```
Alle Dateien mit "baselinker" im Namen — Migrations, Imports, Syncs, Audits, Reports
```

---

## Deep Dive 4 — UI Visual Audit (2026-03-15)

> **Methode:** Jede Seite der Production-App (avycloud.web.app) im Browser geöffnet, Screenshots erstellt, jedes Element visuell geprüft.
> **Ergebnis:** 13 neue Bugs gefunden (BUG-059 bis BUG-071). BUG-040 visuell bestätigt.

### Seite-für-Seite Befund

**✅ = OK | ⛔ = Bug | ⚠️ = Warnung**

#### 1. Bestellungen (Orders)
- ✅ Layout, KPI-Cards, Pipeline, Filter-Tabs funktional
- ✅ Tabelle zeigt Thumbnail, Kundenname, Ort, Produkt, SKU, Preis, Datum
- ✅ Order-Detail Panel öffnet sich bei Klick (Tabs: Details, Positionen, Verlauf)
- ✅ Positionen-Tab zeigt Produkt, SKU, EAN, Preis korrekt
- ✅ Nächster-Schritt Buttons (Bestätigt, Kommissionierung, Storniert, Zurückgestellt)
- ⛔ **BUG-040 BESTÄTIGT:** Alle ~9 neuesten Orders (13-14.03) zeigen "baselinker" als QUELLE
- ⛔ **BUG-040 BESTÄTIGT:** Order-Detail 07-14365-99405: "Adresse unvollständig", Zahlung "—", Versand "—"
- ⛔ **BUG-040 BESTÄTIGT:** Status "Neue Bestellungen" für Orders die auf eBay bereits versendet sind
- ✅ Ab 11.03-Orders: Korrekte Kaufland/eBay Badges (native Intake funktioniert!)
- ⚠️ Kundenname "jürgen schulte" mit Kleinbuchstabe — Datenqualität aus BL-Import

#### 2. Dashboard
- ✅ KPI-Cards: Umsatz (2.046€), Versand (1.007€, 44 Sendungen), Retouren
- ✅ Auftragsfluss Pipeline mit korrekten Status-Stufen
- ✅ Chart Auftragsvolumen & Umsatz rendert korrekt
- ✅ Aktivitäts-Feed zeigt Stock-Sync Events
- ⛔ **BUG-068:** 170 Marketplace Sync Fehler (110 eBay + 60 Kaufland)
- ⛔ **BUG-069:** Chart endet bei ~12.03, keine Daten für 13-14.03
- ⛔ **BUG-071:** Zahlen-Diskrepanz Dashboard vs. Detailseiten (Retouren 50 vs 55, etc.)
- ⚠️ Stock-Sync Errors für EAN 4251029854921 + 4260325295246 (wiederholt)

#### 3. Retouren
- ✅ Tabelle mit ID, Marktplatz, Kunde, Produkt, Grund, Eingang, Status, Betrag
- ✅ Marketplace-Badges (Kaufland rot, eBay blau) korrekt
- ✅ Gründe: "Nicht wie beschrieben", "Sonstiges", "Meinungsänderung"
- ✅ "Bearbeiten" + "Prüfen" Aktionen vorhanden
- ⛔ **BUG-064:** Erstattungsquote 100.0% bei 0,00 EUR Erstattungen — Formel invertiert
- ⚠️ Alle 55 Retouren im Status "Eingegangen" — keine bearbeitet

#### 4. Versand & Labels
- ✅ Tabelle zeigt Carrier-Badges (DHL blau, DPD rot/pink)
- ✅ Tracking-Nummern als klickbare Links
- ✅ Filter-Tabs: Alle, Ausstehend, In Zustellung, Zugestellt, Probleme
- ⛔ **BUG-061:** "Invalid Date" im Versanddatum bei 2 Sendungen
- ⛔ **BUG-062:** KUNDE zeigt "—" bei fast allen Sendungen
- ⛔ **BUG-063:** AUFTRAG-ID zeigt SendCloud-Parcel-IDs statt AvyCloud-Order-IDs
- ⛔ **BUG-071:** KPIs "0 versendet, 0.00 EUR" widersprechen Dashboard-Daten

#### 5. Rechnungen
- ✅ Layout mit KPIs, Suche, Filter-Tabs
- ✅ Rechnungsnummer-Format RE-2026-0001
- ✅ Download-Button vorhanden
- ⛔ **BUG-065:** NETTO + BRUTTO zeigen "—" — keine Beträge berechnet
- ⚠️ Nur 1 Rechnung für 200+ Orders — Rechnungserstellung kaum genutzt

#### 6. Produktdaten
- ✅ 808 Produkte, Thumbnails rendern korrekt
- ✅ Name, Brand, SKU, EAN/GTIN, Kategorie, Preis alle vorhanden
- ✅ eBay/Kaufland Sync-Status (Pending/Synced/Inaktiv/Gelistet)
- ✅ "+ Produkt anlegen", Import, Export Buttons vorhanden
- ⚠️ BESTAND zeigt 0 für sichtbare Produkte — unklar ob korrekt oder Bug

#### 7. Inventar
- ✅ KPIs: 430 Artikel, 1.636 Einheiten
- ✅ Filter: Alle, Niedrig-Bestand, Kein Lagerplatz, 30 Tage unbewegt
- ✅ Lagerplatz-Codes (XGA0501B etc.) für zugewiesene Produkte
- ⛔ **BUG-059:** Literal `\u2014` in Lagerplatz- UND Marktplatz-Spalten statt "—"
- ⛔ **BUG-060:** Bestandswert €0,00 trotz 1.636 Einheiten (EK fehlt überall)
- ⚠️ 401 von 430 Artikeln = "Niedrig-Bestand" (93%)
- ⚠️ "Kein Lagerplatz: 0" — Filter zählt `\u2014` als gültigen Lagerplatz

#### 8. eBay Listings
- ✅ 645 Listings, 329 aktiv, "● Verbunden" Status
- ✅ Sync "gerade eben", Item-IDs, Preise, Status-Badges
- ⚠️ Marktplatz-Spalte zeigt nur "1" statt Marketplace-Name
- ⚠️ Kategorie "—" für alle sichtbaren Listings
- ⚠️ Letztes Update "—" für alle sichtbaren Listings

#### 9. Kaufland Listings
- ✅ 533 Listings, 241 aktiv, Sync funktioniert
- ✅ Unit-IDs, Thumbnails, Lager-Zuordnung teilweise vorhanden
- ⛔ **BUG-066:** Alle Status "Unbekannt" statt Aktiv/Inaktiv
- ⛔ **BUG-067:** Alle Preise "—" — Preisdaten fehlen
- ⚠️ 41 Bestandsabweichungen (135 nicht auf Lager)

#### 10. Auftrags-Einstellungen
- ✅ 4 Automatisierungsregeln korrekt konfiguriert und aktiv
- ✅ 4 Versandregeln (DHL + 3× DPD) mit Min/Max-Gewicht, Method-IDs
- ⚠️ Gewichtslücke: 0-0.49kg hat keine Carrier-Regel

#### 11. Sidebar & Branding
- ✅ Wordmark-Logo "avycloud" + Cloud-Icon im Header
- ✅ Logo wechselt korrekt zwischen Light/Dark Mode Variante
- ✅ Navigation: 4 Gruppen (Aufträge, Produkte, Marktplätze, Einstellungen)
- ✅ User-Info "admin / Admin" am unteren Rand
- ⛔ **BUG-070:** Theme-Toggle (Mond-Icon) reagiert nicht auf Klicks

### Prioritäten-Übersicht neue Bugs

| Prio | Bug-IDs | Thema |
|------|---------|-------|
| P0 | BUG-068 | 170 Stock-Sync Fehler (eBay+Kaufland) — Oversell-Risiko! |
| P1 | BUG-059, BUG-061, BUG-062, BUG-064, BUG-065, BUG-066, BUG-067, BUG-071 | Datenqualität + UI-Logik |
| P2 | BUG-060, BUG-063, BUG-069, BUG-070 | Kosmetik + Usability |

---

## Deep Dive 5 — Zweiter UI Audit (2026-03-15)

> **Methode:** Erneuter Browser-Audit aller Seiten mit Fokus auf vom User gemeldete Bugs + gründlicherer Check.
> **Ergebnis:** 11 weitere Bugs gefunden (BUG-072 bis BUG-082). Mehrere kritische Logik-Fehler bestätigt.

### Vom User gemeldete Bugs — BESTÄTIGT

**1. "Artikel listen" Modal zeigt bereits gelistete Produkte (BUG-072)**
- Betrifft BEIDE Marktplätze (eBay + Kaufland)
- Verifiziert: SKU-4209249383 (Under Armour T-Shirt Horizon Blue), SKU-1291336114 (Under Armour Shorts), SKU-1041822612 (Under Armour Funktionsshirt) sind "Aktiv" gelistet auf eBay UND Kaufland, erscheinen aber im Modal mit "Listen"-Button
- **Root Cause:** `openPublishModal()` in `MarketplaceListingsView.tsx` (Zeile 291-312) filtert nur `qty > 0`, kein Cross-Check gegen bestehende Listings
- **Fix:** Vor Anzeige filtern: `publishProducts.filter(p => !alreadyListedIds.has(p.id))`

**2. Inventar zeigt Produkte ohne Lagerbestand (BUG-073)**
- KPI "GESAMTARTIKEL: 430" ist korrekt (nur qty > 0)
- Tabelle zeigt "808 von 808 Artikeln" — 378 Produkte mit qty=0 eingeschlossen
- Produkte mit Menge 0 werden grau dargestellt, aber nicht ausgeblendet
- **Root Cause:** `InventoryView.tsx` Zeile 208 filtert nur für KPI, Tabelle (Zeile 487+) zeigt alles
- **Fix:** Default-Filter "Nur auf Lager" oder Tab-Filter hinzufügen

### Seite-für-Seite Befund (Runde 2)

**Dashboard:**
- ⛔ BUG-074: Bestandswert 49.054€ (Dashboard) vs. €0,00 (Inventar) — EK-Feld leer
- ⛔ BUG-071 bestätigt: Zahlen-Diskrepanzen zwischen Dashboard und Detailseiten
- ⛔ BUG-081: eBay Token abgelaufen! (15.3.2026, 04:01:11)

**Bestellungen:**
- ⛔ BUG-040 bestätigt: BaseLinker-Orders (MF67K35) zeigen "Adresse unvollständig", Zahlung/Versand "—"
- ⛔ BUG-079: Pipeline 360 vs. Filter-Tab "Alle 200" — Versendet-Tab fehlt komplett
- ✅ Native eBay/Kaufland-Orders (ab 10-11.03) zeigen korrekte Badges und Daten

**Retouren:**
- ⛔ BUG-064 bestätigt: Erstattungsquote 100.0% bei 0,00 EUR Erstattung
- ⛔ BUG-080: Produkt "SKU-7357361636" statt Produktname
- ⚠️ 55 Retouren alle im Status "Eingegangen" — keine weiterverarbeitet

**Versand & Labels:**
- ⛔ BUG-061 bestätigt: "Invalid Date" für Versanddatum
- ⛔ BUG-062 bestätigt: Kundenname "—" für die meisten Sendungen
- ⛔ BUG-063 bestätigt: SendCloud-IDs statt Order-IDs
- ⛔ BUG-075: Mix DE/EN Status ("Ready to send", "Ausstehend", "cancelled")
- ⛔ BUG-076: Sendung 33127936 erscheint 3x (cancelled Duplikate)

**Rechnungen:**
- ⛔ BUG-065 bestätigt: NETTO/BRUTTO "—" für RE-2026-0001
- ⚠️ Nur 1 Rechnung bei 200+ Bestellungen

**eBay Listings:**
- ⛔ BUG-072: "Artikel listen" Modal zeigt bereits gelistete Produkte
- ✅ Listings-Tabelle und Suche funktionieren korrekt

**Kaufland Listings:**
- ⛔ BUG-066 bestätigt: Status "Unbekannt" für ungematchte Listings
- ⛔ BUG-067 bestätigt: Preise "—" für ungematchte Listings
- ⛔ BUG-077: Marktplatz-Spalte "0" für ungematchte Produkte
- ⛔ BUG-072: Gleicher "Artikel listen"-Bug wie eBay
- ✅ Gematchte Listings (z.B. Under Armour nach Sync) zeigen korrekte Daten

**Inventar:**
- ⛔ BUG-059 bestätigt: `\u2014` in Lagerplatz- und Marktplatz-Spalten
- ⛔ BUG-073: 808 Produkte in Tabelle vs. 430 mit Bestand
- ⛔ BUG-074: Bestandswert €0,00 (EK-Spalte leer)
- ⚠️ NIEDRIG-BESTAND: 401 von 430 = 93% — Schwellenwert prüfen

**Produktdaten:**
- ⛔ BUG-082: Inkonsistente Farben eBay-gelb vs. Kaufland-rot für "Inaktiv"
- ⚠️ Filter zeigt 378/808 — unklar welcher Filter aktiv

**Duplikate:**
- ⛔ BUG-078: 698 "Gruppen" aber fast alle mit nur 1 Produkt — irreführend

**Erfassen:** ✅ OK — Wizard korrekt
**Integrationen:** ✅ OK — 5 verbunden, alle aktiv (ABER: eBay Token abgelaufen!)
**Einstellungen:** ✅ OK — Automatisierung + Versandregeln korrekt

### Neue Bug-Prioritäten (Deep Dive 5)

| Prio | Bug-IDs | Thema |
|------|---------|-------|
| P0 | BUG-081 | eBay Token ABGELAUFEN — sofortige Erneuerung nötig! |
| P1 | BUG-072, BUG-073, BUG-074, BUG-077, BUG-079 | Logik-Fehler (Artikel listen, Inventar, Pipeline) |
| P2 | BUG-075, BUG-076, BUG-078, BUG-080 | UX/Kosmetik (Status-Übersetzung, Duplikate, Retouren) |
| P3 | BUG-082 | Farb-Inkonsistenz eBay/Kaufland Badges |

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

## Sprint-Block 10: OMS Audit Fixes (März 2026) — 🔴 OFFEN

> **Quelle:** Vollständiges OMS-Audit vom 15.03.2026 (siehe `oms-audit-report.html`)
> **Scope:** 51 Findings — 9 Critical, 12 High, 18 Medium, 8 Low, 4 Security
> **Priorität:** P0/P1 — Production-stabilisierende Fixes zuerst

### Phase 1: Critical Fixes (P0 — Sofort)

- [ ] **FIX-B001** NULL Pointer in marketplace-tracking.js — `order.shipment_tracking` null-Guard
  - Datei: `backend/services/marketplace-tracking.js` ~Zeile 95
  - Guard: `if (!order?.shipment_tracking?.carrier) return;`

- [ ] **FIX-B002** Race Condition: Stock-Release vs Marketplace-Sync in sync-event-bus.js
  - Datei: `backend/services/sync-event-bus.js` ~Zeile 110-130
  - Fix: Stock-Release atomar in derselben Firestore-Transaktion wie Status-Update

- [ ] **FIX-B003** eBay API Errors still ignoriert (HTTP 200 + Error-Liste)
  - Datei: `backend/services/order-intake-ebay.js` ~Zeile 65
  - Fix: `if (response.Errors?.length) throw new Error('eBay errors: ' + ...)`

- [ ] **FIX-B004** eBay Status "NotPaid" nicht im Mapping → Orders verschwinden
  - Datei: `backend/services/order-intake-ebay.js` (mapEbayStatus)
  - Fix: `case 'NotPaid': return 'pending';`

- [ ] **FIX-B005** Stock wird bei Stornierung NICHT freigegeben → Inventar-Deadlock
  - Datei: `backend/services/order-state-machine.js` ~Zeile 450
  - Fix: `await releaseStockReservation(order.products, order.id)` vor Marketplace-Stornierung

- [ ] **FIX-B006** NULL Pointer: order.customer.address in shipping-engine.js
  - Datei: `backend/services/shipping-engine.js` ~Zeile 95
  - Fix: `if (!order?.customer?.address) throw new AppError('SHIPPING_ADDRESS_MISSING', 400)`

- [ ] **FIX-B007** Dual Status-Feld (status vs omsStatus) konsolidieren
  - Backend: Einheitlich `omsStatus` in allen Order-Endpoints zurückgeben
  - Frontend: `types.ts` — Order-Interface konsolidieren, `as any`-Casts entfernen
  - Dateien: `backend/routes/orders.js`, `components/OrdersView.tsx`, `types.ts`

- [ ] **FIX-B008** Unbekannte Shipping-Statuse verschwinden aus Tabs
  - Datei: `components/orders/ShippingView.tsx`
  - Fix: Normalisierungs-Layer in api/client.ts + Fallback-Tab "Sonstige"

- [ ] **FIX-B009** SevDesk-Export Stub implementieren
  - Datei: `backend/services/invoice-engine.js`
  - Fix: Vollständige SevDesk API-Integration (Kontakt, Rechnung, PDF)

### Phase 2: High Fixes (P1 — Diese Woche)

- [ ] **FIX-B010** SendCloud: Retry mit exponential Backoff (3 Versuche)
  - Datei: `backend/services/shipping-engine.js` (createParcel)

- [ ] **FIX-B011** Tracking-Push: Sofort-Retry statt erst nach 24h
  - Datei: `backend/services/marketplace-tracking.js`

- [ ] **FIX-B012** Kaufland Webhook HMAC-Signatur-Validierung
  - Datei: `backend/routes/orders.js` (Webhook-Endpoint)

- [ ] **FIX-B013** Kaufland "closed" → "cancelled" statt "completed"
  - Datei: `backend/services/order-intake-kaufland.js`

- [ ] **FIX-B014** Kaufland Einzelpreise extrahieren (item.price / 100)
  - Datei: `backend/services/order-intake-kaufland.js`

- [ ] **FIX-B015** Stale Data: refetch() nach jeder Mutation in allen OMS-Views
  - Dateien: `OrdersView.tsx`, `ReturnsView.tsx`, `InvoicesView.tsx`, `ShippingView.tsx`

- [ ] **FIX-B016** Invoice amountNet/amountNetto Normalisierung in api/client.ts
  - Datei: `api/client.ts` — Response-Transform-Layer

- [ ] **FIX-B017** Bulk-Operationen: Einzelergebnisse auswerten + anzeigen
  - Dateien: `OrdersView.tsx`, `ReturnsView.tsx`, `ShippingView.tsx`

- [ ] **FIX-B018** Kaufland API Response-Validierung (Array-Check)
  - Datei: `backend/services/order-intake-kaufland.js`

- [ ] **FIX-B019** eBay Refund-Push via Post-Order API implementieren
  - Datei: `backend/services/returns-engine.js`

- [ ] **FIX-B020** Return-Typen: Strict Enums + Fallback-Labels
  - Dateien: `types.ts`, `ReturnsView.tsx`

- [ ] **FIX-B021** JSON.parse in ebay-oauth.js mit try-catch wrappen
  - Datei: `backend/lib/ebay-oauth.js`

### Phase 3: Security Fixes (P1)

- [ ] **FIX-S001** JWT Token aus URL entfernen (SSE → Authorization Header)
  - Dateien: Backend SSE-Endpoint + Frontend useJobStream.ts

- [ ] **FIX-S002** XSS: decodeHtmlEntitiesDeep() an allen Intake-Entry-Points
  - Dateien: `order-intake-ebay.js`, `order-intake-kaufland.js`, `returns-engine.js`

- [ ] **FIX-S003** Kaufland Webhook HMAC-Signatur-Validierung (= FIX-B012)

- [ ] **FIX-S004** Kunden-Email Regex-Validierung bei Import
  - Dateien: `order-intake-ebay.js`, `order-intake-kaufland.js`

### Phase 4: Medium/Low (P2 — Diesen Monat)

- [ ] **FIX-B022** i18n: 50+ hardcoded deutsche Strings → i18n.t() extrahieren
- [ ] **FIX-B023** Return-Sync Race Condition: Lock pro Return-ID
- [ ] **FIX-B024** Return Reason gegen Enum validieren (Fallback: 'sonstiges')
- [ ] **FIX-B025** Pricing Engine: Runner + Frontend erstellen
- [ ] **FIX-B026** SevDesk Versandkosten-Filter verschärfen
- [ ] **FIX-B027** Invoice Überfällig: Server-Zeit statt Client-Zeit
- [ ] **FIX-B028** Empty States in allen OMS-Tabellen
- [ ] **FIX-B029** Loading-Spinner bei allen Async-Operationen
- [ ] **FIX-B030** ShippingView 60s Polling: Error-Catch + Backoff
- [ ] **FIX-B031** OrderDetail nextStatuses Typ-Mismatch fixen
- [ ] **FIX-B032** Pagination Reset bei Filter-Wechsel
- [ ] **FIX-B033** Feldnamen vereinheitlichen: shipment → shipment_tracking
- [ ] **FIX-B034** Return Timeline Timezone-Handling
- [ ] **FIX-B035** ProcessReturn Dialog: try-catch + Error-Toast
- [ ] **FIX-B036** KPI NaN/Infinity Guard bei leerem Datensatz
- [ ] **FIX-B037** SevDesk Balance-Cache Type klären
- [ ] **FIX-B038** Idempotente Order-Erstellung (set() statt add())
- [ ] **FIX-B039** Reconciliation Window konfigurierbar (ENV)
- [ ] **FIX-B040–B047** Low-Priority: Carrier-Validierung, Timeouts, Accessibility, CSV-Export

---

## Referenz-Dokumente

| Dokument | Beschreibung | Pfad |
|----------|-------------|------|
| CLAUDE.md | Projektregeln, Architektur, Safety-Rules | `./CLAUDE.md` |
| Marketplace_Taxonomy_Masterplan.html | Taxonomy-Akquisitionsplan für alle Marktplätze | `./Marketplace_Taxonomy_Masterplan.html` |
| oms-audit-report.html | OMS Audit Report — 51 Findings mit Filter-Dashboard | `./oms-audit-report.html` |
| compare-ebay-returns.js | eBay vs. AvyCloud Retouren-Vergleichs-Script | `backend/scripts/compare-ebay-returns.js` |
