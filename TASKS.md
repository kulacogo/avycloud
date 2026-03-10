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

> **⚠️ AKTUELLER ZUSTAND (Stand 2026-03-08)**
>
> **✅ Abgeschlossen:**
> - Phase 1–3: Security, Daten-Normalisierung, Infrastruktur, Code-Qualität
> - Phase 4: FAKE→REAL (12 Module auf echte API-Calls umgebaut)
> - Phase 5: Stock-Sync (Reservierungen, Multi-Channel Sync, Preis-Sync)
> - Sprint 3 UI-Fixes: AUDIT-001–013 (Crashes, Marketplace-Enrichment, Farbe Blau, Badge-Semantik, Animationen)
>
> **✅ SPRINT ABGESCHLOSSEN (2026-03-09):**
> 1. ~~Gap-Analyse aus eBay Marketplace-UI entfernen~~ ✅
> 2. ~~Kaufland Preis-Spalte fixen~~ ✅
> 3. ~~eBay fehlende Spalten~~ ✅
> 4. ~~Integration Self-Service (M9)~~ ✅
> 5. ~~OMS Phase A~~ ✅ — Order Intake, Status-Engine, Pipeline-Visualisierung
> 6. ~~OMS Phase B~~ ✅ — SendCloud Labels, Tracking-Webhooks, Rechnungs-PDF, Marketplace-Tracking
> 7. ~~OMS Phase C~~ ✅ — BaseLinker Feature-Flag-Decoupling (Strangler Fig)
> 8. ~~UX-Fixes~~ ✅ — Animationen, Breadcrumbs, Skeleton Loading, Toast System
> 9. ~~M7: Multi-Carrier Versand~~ ✅ — Labels, Regeln, Tracking-Dashboard, Bulk-Labels
> 10. ~~M8: Retouren-Management~~ ✅ — Marketplace-Intake, Workflow, Gründe, Erstattungen
>
> **✅ SPRINT 2 ABGESCHLOSSEN (2026-03-09):**
> - ~~Preis-Push zu Marktplätzen~~ ✅ — Auto-Push bei Product-Save, `syncPriceToAllChannels()`
> - ~~Marketplace Auto-Sync~~ ✅ — Periodic Returns-Sync (4h) + Order-Sync (2h)
> - ~~Pricing Engine Runner + UI~~ ✅ — Repricing-Button in OrderSettingsView
> - ~~Inventory Forecast Dashboard-Widget~~ ✅ — Nachbestellungs-Warnungen im Dashboard
>
> **🔴 NÄCHSTER SPRINT — OFFEN:**
> - ~~**BUG-019: Marketplace-Listings zeigen Produkte ohne Lagerbestand**~~ ✅
> - ~~**BUG-021: Versandlabel — Adress-Validation + Versandregeln-UI**~~ ✅ (teilweise — Validation + UI fertig, aber BUG-022 Root Cause noch offen)
> - ~~**BUG-022: ALLE BaseLinker-Bestellungen haben KEINE Versandadresse**~~ ✅ — Fixed: `mapBaseLinkerOrder()` mappt jetzt street/zip/phone/email + Backfill-Script + Address-Editing in OrderDetail
> - ~~**BUG-023: SendCloud Gewicht ×1000 + Label/Tracking Deep Dive**~~ ✅ — Sprint-Block 4
> - **🔴 BUG-024: SendCloud Sync Matching kaputt** — 0 von 4 Parcels gematcht, Matching-Logik fehlerhaft → Sprint-Block 9.1
> - **🔴 BUG-025: Retouren-Sync schlägt still fehl** — eBay Scopes fehlen (`sell.fulfillment`), Errors verschluckt → Sprint-Block 9.2
> - **🔴 BUG-026: Status-Diskrepanz Liste vs Detail** — OrdersView zeigt Legacy-Status, OrderDetail zeigt OMS-Status → Sprint-Block 9.3
> - **BUG-027: Tracking-Nummer nicht verlinkt** — Plain-Text statt klickbarer Link → Sprint-Block 9.4
> - **BUG-028: Carrier-Liste hardcoded** — Nicht aus SendCloud geladen → Sprint-Block 9.5
> - **BUG-029: Status-Dropdown zeigt ungültige Übergänge** — Alle 12 Status statt gültige Transitions → Sprint-Block 9.6
> - **FEAT: Mehr Integrationen** — Nur 3 aktiv, strategische Erweiterung nötig → Sprint-Block 9.7
> - **VERIFY: Tracking → Marktplätze** — Code existiert, Production-Test steht aus → Sprint-Block 9.8
> - **🔴 BUG-030: eBay "Trennen" funktioniert nicht** — `deleteIntegration` löscht `default__ebay`, aber OAuth-Token liegt in Doc `ebay` → Sprint-Block 9.9
> - ~~**FEAT: eBay Integration**~~ ✅ — OAuth funktioniert, eBay als Integration aktiv
> - ~~**FEAT: SendCloud Auto-Sync Runner**~~ ✅ — Runner + Button vorhanden, aber Matching kaputt (→ 9.1)
> - ~~Deduplizierung: Merge-UI + Auto-Merge~~ ✅
> - ~~Bulk-Import/Export (CSV/Excel)~~ ✅
> - ~~E-Mail-Templates~~ ✅
> - ~~Audit-Log~~ ✅
>
> **🚀 STRATEGISCHE ENTSCHEIDUNG (2026-03-07):**
> **AvyCloud wird ein eigenständiges Order Management System — komplett losgelöst von BaseLinker.**
> BaseLinker wird durch native Marketplace-API-Anbindung (eBay/Kaufland) für Order-Intake ersetzt.
> Rechnungen, Versandlabels, Retouren — alles nativ in AvyCloud.

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

## 📊 Feature-Übersicht (Stand 2026-03-09)

> **48 Features identifiziert — 46 fertig, 1 halb fertig, 1 fehlt komplett (~96% Fertigstellung)**

### ✅ Funktioniert (46 Features)

Dashboard, Produktkatalog, KI-Produkterkennung, KI-Datenverbesserung, KI-Chat, KI-Bildgenerierung, eBay Integration, Kaufland Integration, BaseLinker Integration, Bestellungen (BaseLinker + Native OMS), Pick & Pack (Mobile), Lagerverwaltung, Versand (Labels + Tracking + Bulk), Retouren (Workflow + Marketplace-Intake + Erstattung), Rechnungen (PDF + Nummernkreise + SevDesk-Export), Lieferscheine (PDF), Einstellungen, Admin-Panel, Wettbewerbspreise, Kategorie-Management, Barcode-Scanner, PDF-Labels, Webhooks, Dark/Light Mode, Integrations Self-Service (M9), Order Intake nativ (eBay/Kaufland), Status-Engine (OMS State Machine), Tracking-Webhooks (SendCloud → OMS), Marketplace Versandbestätigung, Auftrags-Detail-Seite, Pipeline-Visualisierung, Versand-Regeln (gewichtsbasiert), Retouren-Marketplace-Intake, Erstattungs-Engine, Auftrags-Nummerierung, BaseLinker Feature-Flag-Decoupling, Pricing Engine (Runner + UI + Auto-Repricing), Inventory Forecast (Dashboard-Widget + Reorder-Alerts), Marketplace Auto-Sync (Orders + Returns periodic), Preis-Push zu Marktplätzen (auto bei Produktspeicherung), Erfassen-Stepper (5-Schritt KI-Identify-Flow), Marketplace-Listings mit Inventory-Abgleich, Bulk-Import/Export (CSV), Deduplizierung (Merge-UI), E-Mail-Templates (branded Templates), Audit-Log (Aktivitätsprotokoll)

### ⚠️ Halb fertig (1 Feature)

| Feature | Was fehlt | Prio |
|---|---|---|
| ~~Versand / Versandlabels (BUG-022)~~ ✅ | Fixed: `mapBaseLinkerOrder()` + Backfill-Script + Address-Editing + Validation | ✅ |
| **Retouren (BUG-020)** | Implementiert, aber noch nicht auf Production verifiziert (Sync auslösen, Daten prüfen) | Mittel |

### 🔴 Fehlt komplett (1 Feature)

| Feature | Prio |
|---|---|
| Onboarding/Wizard | Niedrig |

---

## 🔧 Nächster Sprint — Arbeitsanweisungen

> **Claude Code:** Lies `CLAUDE.md` für Production-Safety-Regeln. Arbeite diese Blöcke IN REIHENFOLGE ab.
> Nach jedem Block: `cd backend && npm test` + `npm run build`. Commit nach jedem Block.

### Sprint-Block 1: ✅ BUG-022 — BaseLinker-Bestellungen haben KEINE Versandadresse (KRITISCH) — Fixed (2026-03-09)

**PROBLEM:** ALLE Bestellungen die über BaseLinker importiert werden haben KEINE Versandadresse (street, zip, phone fehlen). Dadurch kann kein einziges Versandlabel über SendCloud erstellt werden. Fehler: `SendCloud create parcel 400: address: "This field may not be blank."`

**ROOT CAUSE:** `backend/services/order-sync.js` — Funktion `mapBaseLinkerOrder()` (ca. Zeile 173-177).
Das Customer-Objekt mappt nur `name`, `city`, `country` — aber NICHT `street`, `zip`, `phone`, `email`.

**IST (kaputt):**
```js
customer: {
  name: entry?.delivery_fullname || entry?.invoice_fullname || entry?.buyer || 'Unbekannt',
  city: entry?.delivery_city || entry?.invoice_city || null,
  country: entry?.delivery_country_code || entry?.invoice_country_code || null,
},
```

**SOLL (fix):**
```js
customer: {
  name: entry?.delivery_fullname || entry?.invoice_fullname || entry?.buyer || 'Unbekannt',
  street: [entry?.delivery_address, entry?.delivery_address2].filter(Boolean).join(', ')
    || [entry?.invoice_address, entry?.invoice_address2].filter(Boolean).join(', ')
    || null,
  city: entry?.delivery_city || entry?.invoice_city || null,
  zip: entry?.delivery_postcode || entry?.invoice_postcode || null,
  country: entry?.delivery_country_code || entry?.invoice_country_code || null,
  phone: entry?.delivery_phone || entry?.invoice_phone || entry?.phone || null,
  email: entry?.email || entry?.invoice_email || null,
},
```

**BaseLinker API Felder (Referenz):**
- `delivery_fullname` → Name
- `delivery_address` → Straße + Hausnummer (FEHLT im Mapping!)
- `delivery_address2` → Adresszusatz (FEHLT!)
- `delivery_postcode` → PLZ (FEHLT!)
- `delivery_city` → Stadt ✅ (bereits gemappt)
- `delivery_country_code` → Land ✅ (bereits gemappt)
- `delivery_phone` → Telefon (FEHLT!)
- `email` → E-Mail (FEHLT!)
- Fallbacks: `invoice_address`, `invoice_postcode`, `invoice_phone`, `invoice_email`

**ZUSÄTZLICH — Bestehende Bestellungen reparieren:**
1. Erstelle ein Migration-Script `backend/scripts/backfill-order-addresses.js`:
   - Lade ALLE Orders aus Firestore `orders` Collection
   - Für Orders die `customer.street` LEER haben UND `raw`-Feld haben (BaseLinker raw data):
     - Extrahiere `street`, `zip`, `phone`, `email` aus `raw.delivery_address` etc.
     - Update das Order-Dokument mit den fehlenden Feldern
   - Logging: Wie viele Orders repariert, wie viele ohne raw-Daten
2. Das Script soll als `node backend/scripts/backfill-order-addresses.js` ausführbar sein

**Vergleich mit korrektem Mapping (Referenz):**
- `backend/services/order-intake-ebay.js` Zeile 98-106 — mappt street, zip, phone, email KORREKT
- `backend/services/order-intake-kaufland.js` Zeile 92-100 — mappt street, zip, phone, email KORREKT

**Dateien:**
- `backend/services/order-sync.js` — `mapBaseLinkerOrder()` fixen
- `backend/scripts/backfill-order-addresses.js` — NEU erstellen (Migration)

**Test:** Nach dem Fix einen neuen BaseLinker-Sync auslösen und prüfen ob neue Orders jetzt Versandadresse haben.

### Sprint-Block 2: BUG-020 — Retouren auf Production verifizieren (Code-complete, needs prod test)

1. Production-Sync auslösen: POST /api/returns/sync testen
2. Prüfen ob ReturnsView echte Daten zeigt oder leer bleibt
3. Periodic Sync (alle 4h) verifizieren — läuft der Cron?
4. Wenn Probleme: Fixes dokumentieren und in TASKS.md Status aktualisieren

**Dateien:** `backend/services/returns-engine.js`, `components/ReturnsView.tsx`

### Sprint-Block 3: ✅ Order-Detail — Adresse editierbar machen — Done (2026-03-09)

**PROBLEM:** Selbst wenn BUG-022 gefixt ist, muss es möglich sein Adressen nachträglich zu bearbeiten (z.B. wenn Kunde anruft und Adresse ändert).

1. **Backend:** `PUT /api/orders/:orderId` — Endpoint zum Aktualisieren von Order-Feldern (customer.street, customer.city, customer.zip, customer.phone, customer.email). Nur erlaubte Felder, Audit-Log-Eintrag.
2. **Frontend:** `components/OrderDetail.tsx` — "Bearbeiten"-Button neben Kundendaten. Klick öffnet Inline-Edit-Form für Adressfelder. Speichern → PUT /api/orders/:orderId → Reload.
3. **Validation:** Bevor "Versandlabel erstellen" klickbar ist → prüfe ob street+city+zip vorhanden. Wenn nicht → Button disabled + Hinweis "Adresse unvollständig".

**Dateien:** `backend/routes/orders.js`, `components/OrderDetail.tsx`, `api/client.ts`

### Sprint-Block 4: ✅ BUG-023 — SendCloud Gewicht-Bug + Label/Tracking/Status Deep Dive — Fixed (2026-03-09)

**Fixes in diesem Block:**
1. ✅ **Gewicht ×1000** → `weight: String(totalWeight || 0.5)` (kg, nicht Gramm)
2. ✅ **labelUrl immer null** → Fallback-URL aus `parcel.id` konstruiert (`/labels/label_printer/{id}`)
3. ✅ **Tracking nie an Marktplätze gepusht** → `marketplace` + `marketplaceOrderId` Felder in `mapBaseLinkerOrder()` + `orderSource` Fallback in `marketplace-tracking.js`
4. ✅ **eBay CompleteSale XML kaputt** → `buildRequestRoot()` + `getEbayTradingConfig()` für SOAP-Envelope
5. ✅ **Artikelgewicht nie gemappt** → `weight: product.weight` in `mapBaseLinkerOrder()` Items
6. ✅ **Popup-Blocker** → `window.open('about:blank')` VOR async, dann navigieren
7. ✅ **Status nicht frei wählbar** → `force`-Modus in `transitionOrder()` + Status-Dropdown in OrderDetail
8. ✅ **Label stornieren** → `POST /cancel-label` Endpoint + "Label stornieren" Button
9. ✅ **Kaufland Carrier-Map** → `dhl_express`, `deutsche_post` ergänzt
10. ✅ **Firestore-Instanzen** → Shared `firestore` in Label/Cancel-Routen

---

### Sprint-Block 5: ✅ SendCloud Versandinfo-Abruf für manuell erstellte Labels — Done (2026-03-09)

**PROBLEM:** Versandlabels mussten heute manuell in SendCloud erstellt werden, weil der AvyCloud-Versand nicht funktionierte (Weight-Bug). Jetzt fehlen Tracking-Daten in AvyCloud. Es muss eine Funktion geben, die bestehende SendCloud-Parcels abholt und den AvyCloud-Bestellungen zuordnet.

**KONTEXT — vorhandene Infrastruktur:**
- `backend/lib/sendcloud.js` → `getShippingCostsSummary(from, to)` ruft bereits `GET /api/v2/parcels` auf (Pagination, Auth)
- `backend/routes/webhooks.js` → Webhook-Handler existiert (`POST /api/webhooks/sendcloud`), matcht über `sendcloudParcelId` in `shipments` Collection
- Beim Parcel-Erstellen schickt AvyCloud `order_number` + `external_reference` → diese Felder werden von SendCloud zurückgegeben
- `shipments` Collection: `{ orderId, sendcloudParcelId, trackingNumber, trackingUrl, carrier, status }`

**IMPLEMENTIERUNG:**

1. **Neue Funktion** in `backend/services/shipping-engine.js`:
   ```js
   async function syncSendCloudParcels({ tenantId = 'default', fromDate, toDate } = {}) {
     // 1. GET /api/v2/parcels mit Datumsfilter (Pagination wie in sendcloud.js)
     // 2. Für jeden Parcel:
     //    a. Prüfe ob sendcloudParcelId bereits in shipments Collection → skip
     //    b. Matche über parcel.order_number → orders.orderId
     //       ODER parcel.external_reference → orders.marketplaceOrderId
     //       ODER Fallback: parcel.name + parcel.postal_code → orders.customer.name + orders.customer.zip
     //    c. Wenn Match gefunden:
     //       - Erstelle shipments-Dokument (sendcloudParcelId, trackingNumber, trackingUrl, carrier, etc.)
     //       - Update Order: trackingNumber, trackingUrl, shippingService, shipmentId
     //       - Transition omsStatus → 'shipped' (wenn aktuell packed/picked)
     //    d. Wenn kein Match: Log als unmatched, return in Response
     // 3. Return { matched: [...], unmatched: [...], skipped: [...] }
   }
   ```

2. **Neuer Endpoint** in `backend/routes/orders.js`:
   ```
   POST /api/orders/sync-sendcloud
   Body: { fromDate?: string, toDate?: string }
   Response: { ok: true, data: { matched: number, unmatched: number, skipped: number, details: [...] } }
   ```

3. **Frontend-Button** in `components/orders/OrderSettingsView.tsx` oder `OrdersView.tsx`:
   - Button "SendCloud Labels synchronisieren" (📦 Icon)
   - Optionaler Datumsbereich-Filter
   - Zeigt Ergebnis: "X Labels zugeordnet, Y nicht zugeordnet, Z übersprungen"

**Matching-Priorität (Reihenfolge):**
1. `shipments.sendcloudParcelId` existiert → Skip (bereits synchronisiert)
2. `parcel.order_number` → `orders.orderId` (exakter Match)
3. `parcel.external_reference` → `orders.marketplaceOrderId` (eBay/Kaufland Order-ID)
4. Fallback: `parcel.name` + `parcel.postal_code` → `orders.customer.name` + `orders.customer.zip`

**Dateien:** `backend/services/shipping-engine.js`, `backend/routes/orders.js`, `components/orders/OrderSettingsView.tsx`, `api/client.ts`

---

### Sprint-Block 6: Retouren-Daten von Marktplätzen abrufen (Verifikation + Fixes)

**PROBLEM:** Das Retoure-Modul soll Retoure-Daten von eBay und Kaufland holen. Die Infrastruktur existiert bereits, muss aber verifiziert und ggf. repariert werden.

**VORHANDENE INFRASTRUKTUR:**
- `backend/services/returns-engine.js`:
  - `syncEbayReturns()` → eBay Post-Order REST API `GET /post-order/v2/return/search` ✅ Fixed (was broken Trading API)
  - `syncKauflandReturns()` → Kaufland REST API `GET /returns` ✅ Fixed (double /v2/ prefix removed)
  - `issueEbayRefund()` → Post-Order API `POST /post-order/v2/return/{id}/issue_refund` ✅ Fixed (was broken Trading API)
  - `issueKauflandRefund()` → `PATCH /returns/{id}/accept` ✅ Fixed (double /v2/ prefix removed)
- `backend/routes/returns.js`:
  - `POST /api/returns/sync` → triggert Marketplace-Sync
  - Auto-Sync periodic alle 4h (über Scheduler)
- Workflow: `eingegangen → in_pruefung → erstattet/teilweise_erstattet/abgelehnt → abgeschlossen`
- Reason-Maps: EBAY_REASON_MAP + KAUFLAND_REASON_MAP → interne Kategorien

**AUFGABEN:**

1. **Production-Test eBay Returns:**
   - [ ] `POST /api/returns/sync` aufrufen → prüfen ob eBay-Returns gefunden werden
   - [ ] Prüfen ob `GetReturnRequests` korrekte Credentials nutzt (Trading API Token ≠ OAuth Token)
   - [ ] Falls eBay Post-Order API nötig: `syncEbayReturns()` auf Post-Order API v2 umstellen (`GET /post-order/v2/return/search`)
   - [ ] Return-Daten in Firestore `returns` Collection prüfen

2. **Production-Test Kaufland Returns:**
   - [ ] Kaufland `GET /v2/returns` testen
   - [ ] Prüfen ob Returns korrekt in Firestore landen
   - [ ] Reason-Mapping verifizieren

3. **Frontend-Verifikation:**
   - [ ] ReturnsView.tsx öffnen → zeigt es echte Daten?
   - [ ] "Retouren synchronisieren" Button funktional?
   - [ ] Erstattungs-Workflow testen (Status-Übergang, Refund-Auslösung)

4. **Fehlende Features prüfen:**
   - [ ] eBay: Sind auch "Return Requests" (Pre-Approval) vs "Completed Returns" abgedeckt?
   - [ ] Auto-Sync: Läuft der 4h-Scheduler tatsächlich? Logs prüfen.

**Dateien:** `backend/services/returns-engine.js`, `backend/routes/returns.js`, `components/ReturnsView.tsx`

---

### Sprint-Block 7: eBay Integration über "Integrationen" — Deep Dive & Fix

**PROBLEM:** Die eBay-Anbindung über den Integrations-Hub (Self-Service OAuth) funktioniert nicht. User kann eBay nicht verbinden.

**VORHANDENE INFRASTRUKTUR:**

- **Frontend:** `IntegrationsHub.tsx` → klickt auf eBay-Karte → öffnet `IntegrationWizard.tsx`
- **IntegrationWizard:** Erkennt `authType === 'oauth2'` → zeigt "Jetzt verbinden" Button → ruft `handleOAuthConnect()` auf
- **OAuth-Flow:**
  1. Frontend: `startEbayOAuth({ locale: 'de-DE' })` → `GET /api/ebay/oauth/start`
  2. Backend: `createOAuthState()` + `buildConsentUrl()` → gibt eBay Auth-URL zurück
  3. Frontend: `window.open(url, 'ebay_oauth', 'width=600,height=700')` → Popup
  4. User autorisiert bei eBay
  5. eBay redirected zu `/api/ebay/oauth/callback?code=xxx&state=yyy`
  6. Backend: `consumeOAuthState()` + `exchangeAuthorizationCodeForToken()` + `upsertEbayTokenSet()`
  7. Backend: Gibt HTML mit `postMessage({ type: 'avycloud:ebay_oauth_complete' })` zurück
  8. Frontend: Empfängt Message → zeigt "eBay wurde erfolgreich verbunden!"

**MÖGLICHE FEHLERQUELLEN (ALLE PRÜFEN):**

1. **Fehlende Environment-Variablen:**
   - `EBAY_CLIENT_ID` — muss in Secret Manager oder .env gesetzt sein
   - `EBAY_CLIENT_SECRET` — muss in Secret Manager gesetzt sein
   - `EBAY_RU_NAME` — **RuName (Redirect URL Name)** aus eBay Developer Portal, NICHT die URL selbst
   - Prüfen: `getEbayOAuthConfig()` in `ebay-oauth.js` → wirft Error wenn einer fehlt
   - **FIX wenn fehlend:** Secrets in Google Cloud Secret Manager anlegen oder in Firestore `integrations` Collection

2. **RuName Mismatch:**
   - eBay RuName muss exakt dem im eBay Developer Portal hinterlegten Wert entsprechen
   - Callback-URL im eBay Dev Portal muss auf `https://<backend-url>/api/ebay/oauth/callback` zeigen
   - Wenn Production-Backend auf Cloud Run: URL ist `https://<service-name>-<hash>.run.app/api/ebay/oauth/callback`

3. **Scope-Probleme:**
   - Default-Scope: `https://api.ebay.com/oauth/api_scope/sell.inventory.readonly`
   - Für Orders + Returns braucht man erweiterte Scopes:
     - `https://api.ebay.com/oauth/api_scope/sell.fulfillment` (Orders)
     - `https://api.ebay.com/oauth/api_scope/sell.finances` (Returns/Refunds)
   - **FIX:** `EBAY_SCOPES` Environment-Variable mit allen benötigten Scopes setzen

4. **Popup-Blocker:**
   - Frontend fängt `!popup` ab und zeigt Fehlermeldung → das ist korrekt
   - Aber manche Browser blockieren `window.open()` wenn nicht in direktem Click-Handler

5. **Token-Exchange-Fehler:**
   - `exchangeAuthorizationCodeForToken()` macht POST zu eBay Token-Endpoint
   - Muss Basic Auth Header: `base64(clientId:clientSecret)` senden
   - `redirect_uri` im Token-Exchange muss der **RuName-Wert** sein (nicht die URL!)

6. **postMessage Cross-Origin:**
   - Callback-HTML macht `window.opener.postMessage(...)` mit `'*'` origin
   - Sollte funktionieren, aber prüfen ob Popup und Parent gleiche Origin haben

**DEBUGGING-ANLEITUNG:**

```bash
# 1. Prüfe ob Secrets gesetzt sind:
gcloud secrets versions access latest --secret=EBAY_CLIENT_ID --project=<project>
gcloud secrets versions access latest --secret=EBAY_CLIENT_SECRET --project=<project>
gcloud secrets versions access latest --secret=EBAY_RU_NAME --project=<project>

# 2. Prüfe Cloud Run Logs nach Fehler:
gcloud run logs read --service=<service-name> --region=europe-west3 --limit=50 | grep -i "ebay"

# 3. Manuell testen:
curl -H "Authorization: Bearer <jwt>" "https://<backend>/api/ebay/oauth/start?locale=de-DE"
# → Sollte { ok: true, data: { url: "https://auth.ebay.com/oauth2/authorize?..." } } zurückgeben
```

**Dateien:** `backend/lib/ebay-oauth.js`, `backend/routes/marketplace.js`, `backend/routes/integrations.js`, `components/IntegrationWizard.tsx`, `components/IntegrationsHub.tsx`

---

### Sprint-Block 8: 🔴 KRITISCH — SendCloud Auto-Sync Runner + Retouren-Debugging + Versand-Seite (2026-03-10) ✅ Code-Fixes erledigt

**KONTEXT:** Drei zusammenhängende Probleme — alle haben die gleiche Wurzel: fehlender automatischer Sync + fehlende Production-Verifikation.
**STATUS:** Task 8.1 ✅ (Runner in index.js), Task 8.2 ✅ (Sync-Button in ShippingView), Task 8.3 ✅ (Firestore-Index für return_events), Task 8.4 ✅ (OAuth-Callback Auth-Fix bereits deployed). Deploy + Production-Test steht aus.

---

#### Task 8.1: SendCloud Sync Runner erstellen (HAUPTPROBLEM)

**PROBLEM:** `syncSendCloudParcels()` existiert in `shipping-engine.js` und der Endpoint `POST /api/orders/sync-sendcloud` existiert — aber es gibt **KEINEN automatischen Runner**. Labels, die manuell in SendCloud erstellt werden, landen NIEMALS automatisch in AvyCloud. Die Versand/Labels-Seite (`shipments` Collection) bleibt leer.

**FIX — Neuer Runner in `backend/index.js`:**
```js
// --- SendCloud Parcel Sync (jede 2 Stunden) ---
const SENDCLOUD_SYNC_INTERVAL = parseInt(process.env.SENDCLOUD_SYNC_INTERVAL_MS || String(2 * 60 * 60 * 1000), 10);
setTimeout(async () => {
  logger.info('[sendcloud-sync] periodic sync enabled: every %d min', SENDCLOUD_SYNC_INTERVAL / 60000);
  const runSync = async () => {
    try {
      const { syncSendCloudParcels } = require('./services/shipping-engine');
      const result = await syncSendCloudParcels({ tenantId: 'default', lookbackDays: 14 });
      logger.info('[sendcloud-sync] periodic sync done: matched=%d, unmatched=%d, skipped=%d',
        result.matched?.length || 0, result.unmatched?.length || 0, result.skipped?.length || 0);
    } catch (err) {
      logger.error('[sendcloud-sync] periodic sync failed: %s', err.message);
    }
  };
  await runSync(); // Sofort beim Start
  setInterval(runSync, SENDCLOUD_SYNC_INTERVAL);
}, 90_000); // 90s nach Startup
```

**WICHTIG:**
- `syncSendCloudParcels()` muss `lookbackDays` Parameter unterstützen (falls noch nicht vorhanden: `fromDate = new Date(Date.now() - lookbackDays * 86400000)`)
- Der Runner erstellt `shipments`-Dokumente UND aktualisiert Orders mit trackingNumber/trackingUrl
- Sprint-Regel 5 ("KEINE Änderungen an Job-Runnern") gilt NICHT — dies ist ein NEUER Runner, kein bestehender

**Dateien:** `backend/index.js` (Runner hinzufügen), `backend/services/shipping-engine.js` (lookbackDays prüfen)

---

#### Task 8.2: Sofort-Sync manuell auslösen — heutige Labels abholen

**PROBLEM:** Heute wurden Labels manuell in SendCloud erstellt. Diese fehlen komplett in AvyCloud.

**FIX:** Nach Deploy des Runners (Task 8.1) sofort testen:
1. `POST /api/orders/sync-sendcloud` mit `{ "fromDate": "2026-03-10" }` aufrufen
2. Prüfen ob Bestellungen aktualisiert werden (trackingNumber, omsStatus → shipped)
3. Prüfen ob `shipments`-Collection befüllt wird
4. Prüfen ob Versand/Labels-Seite (ShippingView) Daten zeigt

**Frontend:** "Labels synchronisieren" Button muss in ShippingView.tsx vorhanden sein (nicht nur in OrderSettings). Falls fehlend: Button hinzufügen der `POST /api/orders/sync-sendcloud` aufruft.

---

#### Task 8.3: Retouren-Sync Debugging (Production-Test)

**PROBLEM:** Retouren-Seite zeigt KEINE Daten obwohl auf eBay/Kaufland abgeschlossene und offene Retouren existieren. Der Code ist vollständig implementiert (returns-engine.js, returns.js Route, ReturnsView.tsx, 4h Scheduler) — aber nie auf Production getestet.

**DEBUGGING-SCHRITTE (in dieser Reihenfolge):**

1. **Backend-Logs prüfen:** Nach `[returns-sync]` suchen — läuft der 4h-Scheduler überhaupt?
   ```bash
   gcloud run logs read --service=product-hub-backend --region=europe-west3 --limit=100 | grep -i "returns-sync"
   ```

2. **Manuellen Sync testen:** `POST /api/returns/sync` aufrufen und Response/Logs prüfen
   - Erwartete Logs: `[returns-engine] eBay returns sync:`, `[returns-engine] Kaufland returns sync:`
   - Wenn Fehler: Credential-Problem (eBay Token abgelaufen? Kaufland API-Key falsch?)

3. **Firestore prüfen:** `returns` Collection öffnen → Gibt es Dokumente? Welche `tenantId`?

4. **Firestore-Index prüfen:** Composite Index `(tenantId ASC, createdAt DESC)` auf `returns` Collection
   - Falls fehlend: In `firestore.indexes.json` ergänzen und deployen
   - Frontend zeigt "Datenbank-Index wird erstellt" wenn Index fehlt

5. **eBay Token-Situation:** eBay OAuth wurde gerade erst konfiguriert (Secrets gesetzt, Callback-URL gesetzt, Auth-Middleware gefixt). Der OAuth-Flow muss ZUERST erfolgreich durchlaufen werden bevor eBay Returns funktionieren können. → **Task 8.3 hängt von Sprint-Block 7 (eBay OAuth) ab!**

6. **Kaufland:** Kaufland-Credentials unabhängig von eBay — sollte bereits funktionieren wenn API-Key korrekt ist.

**Dateien:** `backend/services/returns-engine.js`, `backend/routes/returns.js`, `backend/index.js` (Scheduler), `firestore.indexes.json`

---

#### Task 8.4: eBay OAuth Callback Auth-Fix (BEREITS ERLEDIGT — nur verifizieren)

**PROBLEM:** eBay OAuth Callback (`GET /api/ebay/oauth/callback`) wurde von der globalen Auth-Middleware blockiert → 401 "Missing Authorization bearer token".

**FIX (bereits deployed in index.js):**
```js
if (req.path === '/ebay/oauth/callback') return next(); // eBay redirect — no auth header
```

**STATUS:** ✅ Code-Fix ist eingecheckt. Nach Deploy testen:
1. In AvyCloud → Integrationen → eBay → "Jetzt verbinden" klicken
2. Bei eBay anmelden und Zugriff gewähren
3. Callback sollte NICHT mehr 401 zeigen
4. Popup schließt sich automatisch → "eBay wurde erfolgreich verbunden!"

**DANACH:** eBay OAuth Token ist gespeichert → Returns-Sync und Order-Sync können eBay-Daten holen.

---

**PRIORITÄT / REIHENFOLGE:**
1. Task 8.4 → Deploy + eBay OAuth testen (Voraussetzung für eBay Returns)
2. Task 8.1 → SendCloud Sync Runner in index.js einfügen
3. Task 8.2 → Nach Deploy: Manuellen Sync auslösen, Versand-Seite prüfen
4. Task 8.3 → Returns debuggen (Kaufland sofort, eBay nach erfolgreichem OAuth)

---

### Sprint-Block 9: 🔴 KRITISCH — Production-Bugs aus User-Testing (2026-03-10) ✅ Code-Fixes erledigt

**KONTEXT:** User hat nach Deploy getestet. 8 Probleme gefunden — alle verified. Hier die Arbeitsanweisungen.
**STATUS:** Task 9.9 ✅ (eBay Disconnect), Task 9.2 ✅ (Scopes + Error), Task 9.1 ✅ (SendCloud Matching), Task 9.3 ✅ (Status-Diskrepanz), Task 9.4 ✅ (Tracking-Links), Task 9.6 ✅ (Status-Dropdown Filter). Task 9.5/9.7/9.8 offen (nicht kritisch).

---

#### Task 9.1: 🔴 SendCloud Sync Matching ist kaputt (0 von 4 gematcht)

**PROBLEM:** `syncSendCloudParcels()` matcht 0 Parcels obwohl 4 unmatched und 316 skipped. Die Matching-Logik hat einen fundamentalen Fehler.

**ROOT CAUSE:**
- `createParcel()` (Zeile ~124) sendet `order_number: order.orderId || order.id` — BaseLinker-Orders haben KEIN `orderId`-Feld, also wird die Firestore-Doc-ID gesendet
- `syncSendCloudParcels()` baut Lookup-Maps: `ordersByNumber` nutzt `order.orderId`, `order.number`, `order.baselinkerId` — aber NICHT die Firestore-Doc-ID
- Die Priority-1-Suche (`ordersByNumber.get(orderNumber)`) findet die Firestore-Doc-ID nicht
- `ordersById.get()` wird zwar als Fallback aufgerufen, aber der Wert aus SendCloud (`order_number`) ist die Firestore-Doc-ID, und `ordersById` mapped `doc.id` → das SOLLTE matchen, tut es aber offenbar nicht

**FIX (2 Stellen):**

1. **`createParcel()` (shipping-engine.js ~Zeile 124)** — Bessere Werte an SendCloud senden:
   ```js
   // ALT (FALSCH):
   order_number: order.orderId || order.id || '',
   external_reference: order.marketplaceOrderId || order.id || '',

   // NEU (RICHTIG):
   order_number: order.number || order.baselinkerId || order.id || '',
   external_reference: order.marketplaceOrderId || order.baselinkerId || order.id || '',
   ```

2. **`syncSendCloudParcels()` Matching-Logik** — Priority-1 muss auch Firestore-Doc-ID finden:
   ```js
   // ALT:
   order = ordersByNumber.get(orderNumber) || ordersById.get(orderNumber) || null;

   // NEU: ordersById hat höhere Priorität (enthält doc.id)
   order = ordersById.get(orderNumber) || ordersByNumber.get(orderNumber) || null;
   ```

3. **Zusätzlich `ordersByNumber` erweitern** — Auch Firestore-Doc-ID in die Map:
   ```js
   // In der Schleife wo ordersByNumber gebaut wird:
   ordersByNumber.set(doc.id, o); // Firestore doc.id als Key hinzufügen
   ```

**TESTEN:** Nach Fix `POST /api/orders/sync-sendcloud` aufrufen → mindestens 4 sollten als "matched" zurückkommen.

**Dateien:** `backend/services/shipping-engine.js`

---

#### Task 9.2: 🔴 Retouren-Sync schlägt still fehl (eBay Scopes fehlen)

**PROBLEM:** Returns-Sync gibt "0 neue Retouren synchronisiert" obwohl 17+ Returns auf eBay existieren. Der Sync schlägt still fehl weil:

**ROOT CAUSE 1 — Fehlender OAuth Scope:**
- `getEbayScopes()` in `ebay-oauth.js` (Zeile ~63) hat Default: `sell.inventory.readonly`
- Post-Order API v2 (`GET /post-order/v2/return/search`) braucht `sell.fulfillment` Scope
- eBay gibt 403 zurück → Error wird verschluckt

**ROOT CAUSE 2 — Fehler werden nicht angezeigt:**
- `syncEbayReturns()` fängt den 403 mit try/catch, loggt ihn, gibt aber nur `errors: 1` zurück
- Frontend zeigt "0 neue Retouren" ohne Fehlerdetails

**FIX:**

1. **`ebay-oauth.js` Default-Scopes erweitern (Zeile ~63):**
   ```js
   const fallback = [
     'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
     'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
     'https://api.ebay.com/oauth/api_scope/sell.finances',
     'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
   ];
   ```

2. **`returns-engine.js` — Error-Details in Response exponieren:**
   ```js
   // In syncEbayReturns() catch-Block:
   catch (err) {
     logger.error(`[returns-engine] eBay returns sync failed: ${err.message}`);
     return { synced: 0, skipped: 0, errors: 1, errorMessage: err.message };
   }
   ```

3. **Frontend ReturnsView** — Error-Message anzeigen wenn `errorMessage` in Response

4. **WICHTIG:** Nach Scope-Änderung muss der User den eBay OAuth-Flow NOCHMAL durchlaufen (neuer Token mit erweiterten Scopes). Bestehender Token hat nur `sell.inventory.readonly`.

**Dateien:** `backend/lib/ebay-oauth.js`, `backend/services/returns-engine.js`, `backend/routes/returns.js`, `components/ReturnsView.tsx`

---

#### Task 9.3: Status-Diskrepanz zwischen Auftrags-Liste und Auftrags-Detail

**PROBLEM:** OrdersView zeigt "Verpackt" aber OrderDetail zeigt "Versendet" für die gleiche Bestellung.

**ROOT CAUSE:**
- OrdersView nutzt `order.statusLabel || order.status` (Legacy BaseLinker-Status)
- OrderDetail nutzt `order.omsStatus` (neues OMS-System)
- `order-sync.js` Zeile ~462 mappt BaseLinker "Versendet" → Legacy `status: 'picked'`, nicht `shipped`
- Wenn dann ein Versandlabel erstellt wird, wird `omsStatus` auf `shipped` gesetzt, aber der Legacy-Status bleibt `picked`

**FIX:**
- OrdersView MUSS `omsStatus` als primäre Quelle verwenden (mit Fallback auf Legacy):
  ```tsx
  // In OrdersView, Status-Anzeige:
  const displayStatus = order.omsStatus || order.status;
  const displayLabel = OMS_STATUS_LABELS[displayStatus] || order.statusLabel || displayStatus;
  ```
- ODER: `order-sync.js` muss beim Import auch `omsStatus` korrekt setzen

**Dateien:** `components/OrdersView.tsx`, `backend/services/order-sync.js`

---

#### Task 9.4: Tracking-Nummer nicht verlinkt

**PROBLEM:** Tracking-Nummer in OrderDetail ist Plain-Text, nicht klickbar.

**FIX:** Carrier-spezifische Tracking-URL generieren:
```tsx
// In OrderDetail.tsx:
const TRACKING_URLS: Record<string, string> = {
  dhl: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=',
  dhl_de: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=',
  dpd: 'https://tracking.dpd.de/parcelstatus?query=',
  gls: 'https://gls-group.eu/DE/de/paketverfolgung?match=',
  hermes: 'https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#',
  ups: 'https://www.ups.com/track?tracknum=',
  dhl_express: 'https://www.dhl.com/de-de/home/tracking/tracking-express.html?submit=1&tracking-id=',
};

// Tracking-Row mit Link:
{order.trackingNumber && (
  <Row label="Tracking" value={
    <a href={`${TRACKING_URLS[order.shippingService || 'dhl']}${order.trackingNumber}`}
       target="_blank" rel="noopener noreferrer"
       className="text-accent hover:underline">
      {order.trackingNumber}
    </a>
  } />
)}
```

Alternativ: `order.trackingUrl` verwenden wenn vorhanden (wird von SendCloud zurückgegeben).

**Dateien:** `components/OrderDetail.tsx`

---

#### Task 9.5: Versandregeln — Carrier-Liste hardcoded statt dynamisch

**PROBLEM:** Carrier-Dropdown in Versandregeln zeigt DHL, DPD, GLS, Hermes, UPS, DHL Express — unabhängig davon was in SendCloud oder als Integration aktiv ist.

**FIX:**
1. **Neuer Endpoint** `GET /api/shipping/methods` der `getShippingMethods()` aus `shipping-engine.js` aufruft
2. **Frontend** lädt Carrier/Methods beim Öffnen der Versandregeln-Seite
3. Dropdown zeigt nur Carrier die im SendCloud-Account tatsächlich verfügbar sind
4. Method-ID wird automatisch vorgeschlagen basierend auf gewähltem Carrier + Gewichtsklasse

**Dateien:** `backend/routes/orders.js`, `backend/services/shipping-engine.js`, `components/orders/OrderSettingsView.tsx`, `api/client.ts`

---

#### Task 9.6: Status-Dropdown zeigt ungültige Übergänge (kein Transition-Filter)

**PROBLEM:** "Status setzen..." Dropdown in OrderDetail zeigt ALLE 12 OMS-Status. User kann z.B. von "Versendet" auf "Kommissionierung" setzen — das ist logisch ungültig.

**FIX:**
1. **Neuer Endpoint** `GET /api/orders/:orderId/transitions` der gültige Übergänge zurückgibt
   - Liest `TRANSITIONS` Map aus `order-state-machine.js`
   - Gibt nur erlaubte Ziel-Status zurück basierend auf aktuellem Status
2. **Frontend** filtert Dropdown auf gültige Übergänge:
   ```tsx
   // Statt allStatuses:
   const validTransitions = TRANSITIONS[currentStatus] || [];
   // Dropdown zeigt nur validTransitions
   ```
3. "Force"-Override nur für Admin-Rolle sichtbar (nicht für normale User)

**Dateien:** `components/OrderDetail.tsx`, `backend/routes/orders.js`, `backend/services/order-state-machine.js`

---

#### Task 9.7: 🔴🔴🔴 KRITISCH — Integrationen = Kundengewinnung = Umsatz

**PROBLEM:** AvyCloud hat 6 Integrationen. BaseLinker hat 1.800+. Ohne Integrationen keine Kunden, ohne Kunden kein Umsatz. Das ist der #1 Blocker für Go-to-Market.

**BENCHMARK (BaseLinker-Kategorien):**
- Marketplace: 364 | Shops: 86 | Couriers: 388 | Fulfillment: 58
- Accounting/ERP: 137 | SMS: 15 | Other: 44 | Wholesalers: 838

**AvyCloud IST-Stand: 6 Integrationen**
- eBay ✅ | Kaufland ✅ | BaseLinker ✅ | SendCloud ✅ | SevDesk ✅ | DHL (via SendCloud) ✅

---

**🔴 PHASE 1 — MUSS (KW 11-14) — Minimum Viable Integration Set**

> Ohne diese Integrationen ist AvyCloud für die meisten DACH-Händler nicht nutzbar.

**Marktplätze (Top 5 für DACH):**
| Integration | Marktanteil | API | Aufwand | Prio |
|---|---|---|---|---|
| Amazon SP-API | ~50% aller DACH-Käufer | OAuth 2.0 + Selling Partner API | 80-120h | 🔴 P0 |
| Otto Market | #2 DE Marktplatz | REST API + OAuth | 60-80h | 🔴 P0 |
| Zalando ZFS | Fashion + expanding | REST API | 40-60h | 🟠 P1 |
| Etsy | Handmade/Nische | OAuth 2.0 + REST | 30-40h | 🟠 P1 |
| About You | Fashion DACH | REST API | 30-40h | 🟡 P2 |

**Shops (Top 5 — eigene Webshops der Händler):**
| Integration | Verbreitung | API | Aufwand | Prio |
|---|---|---|---|---|
| Shopify | Global #1 | REST + GraphQL | 40-50h | 🔴 P0 |
| WooCommerce | DE sehr verbreitet | REST API | 30-40h | 🔴 P0 |
| Shopware 6 | DE Marktführer | REST + Admin API | 40-50h | 🟠 P1 |
| PrestaShop | EU verbreitet | REST API | 30h | 🟡 P2 |
| Magento/Adobe | Enterprise | REST + GraphQL | 50-60h | 🟡 P2 |

**Versand/Couriers (über SendCloud bereits ~35 Carrier abgedeckt, aber direkte Integrationen für Top-Carrier):**
| Integration | Status | Aufwand | Prio |
|---|---|---|---|
| DHL (direkt) | Via SendCloud ✅ | Direkt-API 20h | 🟠 P1 |
| DPD | Via SendCloud ✅ | Direkt-API 20h | 🟡 P2 |
| GLS | Via SendCloud ✅ | Direkt-API 20h | 🟡 P2 |
| Hermes | Via SendCloud ✅ | Direkt-API 15h | 🟡 P2 |
| UPS | Via SendCloud ✅ | Direkt-API 20h | 🟡 P2 |

> **Strategie Versand:** SendCloud bleibt Haupt-Carrier-Hub (388 Carrier). Direkte API nur wenn Händler SendCloud nicht nutzt.

**Buchhaltung/ERP:**
| Integration | Verbreitung DE | API | Aufwand | Prio |
|---|---|---|---|---|
| SevDesk | ✅ Bereits implementiert | — | — | ✅ |
| lexoffice | Sehr verbreitet DE | REST API | 25-30h | 🔴 P0 |
| DATEV | Standard Steuerberater DE | DATEV Connect | 40-50h | 🟠 P1 |
| Xero | International | OAuth + REST | 30h | 🟡 P2 |
| Debitoor/SumUp | KMU | REST API | 20h | 🟡 P2 |

**Other / Payment:**
| Integration | Zweck | Aufwand | Prio |
|---|---|---|---|
| Stripe | Zahlungen | 20-30h | 🟠 P1 |
| PayPal | Zahlungen | 20-30h | 🟠 P1 |
| Klarna | BNPL | 20h | 🟡 P2 |
| Slack | Notifications | 10h | 🟡 P2 |
| Zapier | Automation | 30h | 🟡 P2 |

---

**🟠 PHASE 2 — SOLL (KW 15-20) — Competitive Parity**

- Weitere Marktplätze: Kleinanzeigen, Hood.de, Avocadostore, real.de/Kaufland AT
- Shops: Wix, Squarespace, Gambio, JTL-Shop, OXID
- Fulfillment: Amazon FBA, DHL Fulfillment, Completio
- ERP: BuchhaltungsButler, FastBill, Billomat
- CRM: HubSpot, Salesforce (für größere Händler)

---

**🟡 PHASE 3 — KANN (KW 20+) — Market Leadership**

- Wholesalers/Dropshipping: BigBuy, Vidaxl, Suppliers via API
- SMS: Benachrichtigungen via Twilio/MessageBird
- Analytics: Google Analytics 4, Matomo
- Weitere Shops: Ecwid, BigCommerce, Volusion
- Internationalisierung: Amazon.com, Amazon.co.uk, Amazon.fr, Cdiscount, Allegro

---

**ARCHITEKTUR-ANFORDERUNGEN für Skalierung:**

1. **Integration Registry erweitern** — `integration-registry.js` um alle Kategorien erweitern:
   ```
   Kategorien: marketplace | shop | courier | fulfillment | accounting | payment | notification | automation | wholesaler
   ```

2. **IntegrationsHub UI komplett überarbeiten:**
   - Kategorie-Tabs: Marktplätze | Shops | Versand | Fulfillment | Buchhaltung | Payment | Sonstiges
   - Suchfeld für Integrationen
   - "Coming Soon"-Badge für geplante (mit Warteliste-Button)
   - Pro Integration: Logo, Name, Status, Kurzbeschreibung, Setup-Wizard-Link

3. **Integration-Adapter-Pattern:**
   ```
   backend/integrations/
   ├── marketplace/
   │   ├── amazon/     → adapter.js, api.js, mapper.js
   │   ├── otto/       → adapter.js, api.js, mapper.js
   │   ├── ebay/       → (refactor aus lib/ebay-*.js)
   │   └── kaufland/   → (refactor aus lib/kaufland-*.js)
   ├── shop/
   │   ├── shopify/    → adapter.js, api.js, mapper.js
   │   └── woocommerce/
   ├── accounting/
   │   ├── sevdesk/    → (refactor aus lib/sevdesk.js)
   │   └── lexoffice/
   └── _base/
       └── integration-adapter.js   → Gemeinsame Basis (connect, disconnect, sync, test)
   ```

4. **Jeder Adapter implementiert:**
   ```js
   class IntegrationAdapter {
     async connect(credentials) {}      // OAuth oder API-Key
     async disconnect(tenantId) {}      // Clean disconnect
     async testConnection() {}          // Health check
     async syncOrders(since) {}         // Order import
     async syncProducts(since) {}       // Product sync
     async pushTracking(order) {}       // Tracking an Marktplatz
     async pushPrice(product) {}        // Preis-Update
     async pushInventory(product) {}    // Bestand-Update
   }
   ```

5. **Multi-Tenancy ready:** Jede Integration speichert Credentials pro Tenant in `integrations_config`

---

---

**🔧 INTEGRATIONS-KONFIGURATION — KI-FIRST + Capability-basiert**

> **⚡ STRATEGISCHER VORTEIL: KI erledigt was User bei Wettbewerbern manuell machen müssen.**
>
> **IST-Stand:** AvyCloud hat nur Connect/Disconnect. Keinerlei Konfiguration.
> **SOLL:** Connect → KI konfiguriert automatisch → User überprüft/überschreibt nur bei Bedarf.
>
> **Wettbewerber zwingen User durch 5-8 manuelle Config-Tabs:**
> Kategorie-Mapping, Attribut-Mapping, Status-Mapping, Rückgabegrund-Mapping, Preis-Regeln...
> **AvyCloud macht das per KI.** DAS ist der Differentiator. DAS ist warum User wechseln.

**WETTBEWERBER-ANALYSE — Was User dort MANUELL konfigurieren müssen:**
- **ChannelEngine:** Setup → Product Selection → Categorization → Attribute-Mappings → Carrier-Mappings → Pricing Rules → Activation (6+ manuelle Schritte)
- **Channable:** Name/ID → Kategorisierung → Regeln → Attribut-Mapping → Kategorie-Mapping → Connect → Activate (7 manuelle Schritte)
- **Linnworks:** Connection → Order Download → Inventory Sync → Listing → SKU Mapping (SKU Mapping komplett manuell)
- **Billbee:** Verbindung → Allgemein → Umsatzsteuer → Nummernkreise → Bestandsabgleich → Versandprofile → Kategorie-Zuordnung → Synchronisierung (8 Tabs)
- **BaseLinker:** Connection → Orders → Offer Settings → Returns → Order Statuses → Prices → Stock + Competition BETA (7 Tabs pro Integration)

**KERN-ERKENNTNIS:** Config-Tabs nur per Capability zeigen. Aber der entscheidende Unterschied: **KI übernimmt die Config, User bestätigt nur.**

---

**🤖 KI-AUTOMATISIERUNG — Was die KI für den User erledigt:**

| Was Wettbewerber manuell machen | Was AvyCloud KI automatisch macht |
|---|---|
| **Kategorie-Mapping** — User ordnet jede Produktkategorie manuell dem Marktplatz zu (Channable: Schritt 2, ChannelEngine: Schritt 3) | **KI analysiert Produktdaten (Titel, Beschreibung, Bilder) und wählt automatisch die richtige Marktplatz-Kategorie.** Kaufland-Listing funktioniert bereits ohne manuelles Mapping! |
| **Attribut-Mapping** — User mappt jedes Produktfeld auf Marktplatz-Felder (Channable: Schritt 4+5, ChannelEngine: Content Mappings) | **KI erkennt welche internen Felder zu welchen Marktplatz-Attributen passen.** Schema-Matching via Gemini — Name→Title, Beschreibung→Description, EAN→GTIN etc. |
| **Status-Mapping** — User definiert manuell welcher interne Status welchem Marktplatz-Status entspricht (BaseLinker: Order Statuses Tab) | **KI schlägt Standard-Mapping vor basierend auf Status-Namen und Best Practices.** "Versendet"→"Shipped", "Storniert"→"Cancelled" — offensichtlich. |
| **Rückgabegrund-Mapping** — User mappt jeden Marktplatz-Rückgabegrund auf interne Gründe (BaseLinker: Returns Tab) | **KI clustert Rückgabegründe semantisch.** "Does not fit" + "Wrong size" → "Passt nicht". "Changed mind" + "Found better price" → "Meinung geändert". |
| **Preis-/Bestand-Regeln** — User stellt Sync-Intervalle, Schwellenwerte, Aktionen manuell ein | **KI schlägt optimale Defaults vor basierend auf Verkaufsvolumen und Produkttyp.** Hochdreher → Live-Sync. Langsamdreher → 4h-Intervall. |
| **Versandprofil-Zuordnung** — User mappt Shop-Versandprofile auf interne Versandprodukte (Billbee: Versandprofile Tab) | **KI matcht Versandprofile automatisch basierend auf Namen, Gewichtsgrenzen und Zielländern.** |
| **Listing-Erstellung** — User füllt Titel, Beschreibung, Bilder, Preis, Versand manuell pro Marktplatz | **KI generiert marktplatz-optimierte Listings aus Produktdaten.** Titel-Länge, Keywords, Beschreibungsformat — alles automatisch angepasst pro Marktplatz. |

**FLOW FÜR DEN USER:**

```
1. User klickt "Verbinden" bei z.B. Amazon
2. OAuth/API-Key-Eingabe
3. AvyCloud KI analysiert:
   - Bestehende Produkte in AvyCloud
   - Amazon-Kategoriestruktur
   - Attribut-Anforderungen pro Kategorie
   - Bestehende Config-Muster anderer User (langfristig)
4. KI erstellt automatisch:
   ✅ Kategorie-Mapping (Produkt → Amazon-Kategorie)
   ✅ Attribut-Mapping (interne Felder → Amazon-Felder)
   ✅ Status-Mapping (Standard-Defaults)
   ✅ Preis/Bestand-Sync (optimale Intervalle)
   ✅ Versandregeln (basierend auf aktiven Carriern)
5. User sieht: "KI hat 47 Produkte automatisch konfiguriert. 3 brauchen Aufmerksamkeit."
6. User prüft/bestätigt oder überschreibt per Config-Tab (nur wenn nötig!)
```

**CONFIG-TABS BLEIBEN — aber als Override/Review, nicht als Pflicht-Setup:**

User MUSS nie durch 7 Tabs klicken um loszulegen. Die KI hat schon alles vorkonfiguriert.
Die Tabs dienen als Experten-Zugang für User die Fein-Tuning wollen.
UX: "Automatisch konfiguriert ✅" Badge auf jedem Tab. Gelbes Badge "Prüfung empfohlen" wenn KI unsicher.

---

**CAPABILITY-DEKLARATION pro Integration in `integration-registry.js`:**

```js
const INTEGRATIONS = {
  ebay: {
    type: 'marketplace', auth: 'oauth2',
    capabilities: ['orders', 'listings', 'prices', 'stock', 'returns', 'statusMapping', 'tracking'],
    sites: ['ebay.de', 'ebay.com', 'ebay.co.uk', 'ebay.fr', 'ebay.it', 'ebay.at', 'ebay.ch'],
  },
  kaufland: {
    type: 'marketplace', auth: 'apikey',
    capabilities: ['orders', 'listings', 'prices', 'stock', 'tracking'],
    // KEINE returns → kein Returns-Tab
  },
  amazon: {
    type: 'marketplace', auth: 'oauth2',
    capabilities: ['orders', 'listings', 'prices', 'stock', 'returns', 'statusMapping', 'tracking', 'fba'],
    // fba = extra Tab für FBA-Settings
  },
  shopify: {
    type: 'shop', auth: 'oauth2',
    capabilities: ['orders', 'products', 'stock', 'prices', 'webhooks'],
    // KEIN statusMapping, KEIN returns
  },
  woocommerce: {
    type: 'shop', auth: 'apikey',
    capabilities: ['orders', 'products', 'stock', 'prices'],
  },
  sendcloud: {
    type: 'shipping', auth: 'apikey',
    capabilities: ['labels', 'tracking', 'carriers', 'returns'],
    // KEINE orders, listings, prices, stock
  },
  sevdesk: {
    type: 'accounting', auth: 'apikey',
    capabilities: ['invoices', 'contacts', 'export'],
  },
  lexoffice: {
    type: 'accounting', auth: 'apikey',
    capabilities: ['invoices', 'contacts'],
    // KEIN export
  },
};
```

**CONFIG-BEREICHE — zeigt NUR wenn Integration die Capability hat:**

| Capability | Tab-Name | Einstellungen |
|---|---|---|
| *(immer)* | **Verbindung** | Status, Test, Re-Connect, Token-Info, Account-Name |
| `orders` | **Bestellungen** | Sync-Intervall, Auto-Import, Status-Filter |
| `listings` | **Angebote** | Site-Auswahl (nur Multi-Site), Versandvorlage, Listing-Queue |
| `products` | **Produkt-Sync** | Sync-Richtung, Intervall, Felder-Mapping |
| `prices` | **Preise** | Sync-Intervall (aus/4h/1h/live), Preis-0-Handling, Rundung, Limit |
| `stock` | **Bestand** | Sync-Intervall, Empty-Stock-Aktion, Max-Menge, Schwellenwert |
| `returns` | **Retouren** | Auto-Fetch, Grund-Mapping (Marktplatz → intern) |
| `statusMapping` | **Status-Zuordnung** | Intern → Marktplatz, bidirektionale Regeln |
| `tracking` | **Tracking** | Auto-Push, Carrier-Mapping |
| `fba` | **FBA/Fulfillment** | FBA vs. FBM, Warehouse-Zuordnung |
| `labels` | **Labels** | Standard-Carrier, Gewichts-Default, Absender |
| `carriers` | **Versandregeln** | Carrier nach Gewicht/Ziel/Preis |
| `invoices` | **Rechnungen** | Auto-Erstellen, Nummernkreis, MwSt |
| `contacts` | **Kontakte** | Kunden-Sync |
| `export` | **Export** | Format, Intervall, Konten |
| `webhooks` | **Webhooks** | URLs, Events |
| `tax` | **Umsatzsteuer** | Modus, Sätze (wie Billbee) |
| `categoryMapping` | **Kategorien** | Intern → Marktplatz (wie Channable) |
| `attributeMapping` | **Attribute** | Felder → Marktplatz-Felder (wie ChannelEngine) |

**WAS JEDE INTEGRATION TATSÄCHLICH ZEIGT:**

```
eBay:           Verbindung | Bestellungen | Angebote | Preise | Bestand | Retouren | Status-Zuordnung | Tracking
Kaufland:       Verbindung | Bestellungen | Angebote | Preise | Bestand | Tracking
Amazon:         Verbindung | Bestellungen | Angebote | Preise | Bestand | Retouren | Status-Zuordnung | Tracking | FBA
Otto:           Verbindung | Bestellungen | Angebote | Preise | Bestand | Attribut-Mapping | Kategorien
Etsy:           Verbindung | Bestellungen | Angebote | Preise | Bestand
Shopify:        Verbindung | Bestellungen | Produkt-Sync | Preise | Bestand | Webhooks
WooCommerce:    Verbindung | Bestellungen | Produkt-Sync | Preise | Bestand
SendCloud:      Verbindung | Labels | Tracking | Versandregeln | Retouren
SevDesk:        Verbindung | Rechnungen | Kontakte | Export
lexoffice:      Verbindung | Rechnungen | Kontakte
```

**IMPLEMENTIERUNG:**

1. **`integration-registry.js`** — Capabilities pro Integration deklarieren (s.o.)

2. **`integrations_config/{tenantId}__{type}`** — `settings`-Objekt NUR mit Capabilities:
   ```js
   // eBay (7 Capabilities → 7 Settings-Blöcke)
   { settings: { orders: {...}, listings: {...}, prices: {...}, stock: {...}, returns: {...}, statusMapping: {...}, tracking: {...} } }
   // SendCloud (4 Capabilities → 4 Settings-Blöcke)
   { settings: { labels: {...}, tracking: {...}, carriers: {...}, returns: {...} } }
   // lexoffice (2 Capabilities → 2 Settings-Blöcke)
   { settings: { invoices: {...}, contacts: {...} } }
   ```

3. **Frontend `IntegrationConfigView.tsx`** — Dynamische Tab-Generierung:
   ```tsx
   const tabs = integration.capabilities.map(cap => CONFIG_TAB_REGISTRY[cap]).filter(Boolean);
   // Rendert NUR Tabs die zur Integration passen
   ```

4. **Backend `PATCH /api/integrations/:type/settings`** — Validiert gegen erlaubte Capabilities

5. **Sync-Runner lesen Settings** — `order-sync.js`, `shipping-engine.js` etc. respektieren Intervalle/Regeln

---

**SOFORT-MASSNAHME (diese Woche):**
1. **KI-Auto-Config Service** — `services/integration-ai-config.js`: Gemini-basierte Auto-Konfiguration (Kategorie-Mapping, Attribut-Mapping, Status-Mapping, Rückgabegrund-Mapping)
2. **IntegrationsHub UI** überarbeiten mit allen Kategorien + "Coming Soon" + KI-Badge
3. **IntegrationConfigView.tsx** — Capability-basierte Tabs als Override/Review (NICHT als Pflicht-Setup)
4. **Amazon SP-API** Integration starten (P0 — ohne Amazon kein ernsthafter Händler)
5. **lexoffice** Integration starten (P0 — Buchhaltung ist Pflicht für DE-Händler)
6. **Shopify** Integration starten (P0 — größte Shop-Plattform)

**KI-Auto-Config nutzt bestehende Infrastruktur:**
- `lib/gemini-client.js` + `lib/gemini-structured.js` — bereits vorhanden für Produkterkennung
- `lib/llm-policy-pack.js` + `lib/llm-rulebook.js` — Policy + Validierung bereits aktiv
- Erweiterung: Neues Prompt-Template für Integration-Config statt Produkt-Identifizierung

**Dateien:** `services/integration-ai-config.js` (NEU), `components/IntegrationsHub.tsx`, `components/IntegrationConfigView.tsx` (NEU), `components/IntegrationWizard.tsx`, `backend/lib/integration-registry.js`, `backend/services/integration-store.js`, `backend/routes/integrations.js`, neue Dateien unter `backend/integrations/`

---

#### Task 9.7.1: 🔴🔴🔴 Universal Taxonomy Engine — Marktplatz-Daten Akquisition

> **Detaillierter Plan: `Marketplace_Taxonomy_Masterplan.html`**
> Ohne Taxonomie-Daten kann KI-Auto-Config nicht funktionieren. BLOCKER für alle neuen Integrationen.

**ZIEL:** Das bewährte Kaufland-Pattern (CSV → 4-Tier Resolution → Auto-Matching) auf ALLE neuen Marktplätze ausrollen.

**ARCHITEKTUR — Universal Taxonomy Engine:**

```
taxonomy-data/           ← Zentral für ALLE MP-Taxonomien
├── kaufland/categories.csv       (bestehend, ~50k Kategorien)
├── ebay/categories.json          (bestehend, ~20k)
├── amazon/browse-tree-de.csv     (NEU: Browse Tree Report → XML→CSV)
├── amazon/type-schemas/          (NEU: Product Type Definitions)
├── otto/categories.json          (NEU: API-paginiert)
├── etsy/seller-taxonomy.json     (NEU: Tree API)
├── etsy/properties.json          (NEU: Attributes pro Kategorie)
├── shopify/taxonomy.json         (NEU: GitHub Open Source!)
├── zalando/fashion-categories.csv (NEU: Manuell + API-Filter)
└── _schema/config.json           (Unified Schema)

lib/taxonomy-loader.js   ← NEU: Universal CSV/JSON Loader → TaxonomyIndex
lib/category-matcher.js  ← NEU: 4-Tier Resolution (ID → Path → Token → Gemini)
lib/attribute-mapper.js  ← NEU: Feld → Marktplatz-Feld Mapping
lib/shop-taxonomy-sync.js ← NEU: Dynamisches Fetching bei Shop-Connect

scripts/fetch-*-taxonomy.js ← NEU: Pro-MP Fetch Scripts
services/taxonomy-refresh.js ← NEU: Periodischer Cron-Refresh
```

**DREI AKQUISITIONS-STRATEGIEN:**
1. **Statisch** (Kaufland, eBay, Amazon, Shopify): CSV/JSON vorinstallieren, periodisch refreshen
2. **API-Driven** (Otto, Etsy, Zalando): Bei Connect/periodisch aus API ziehen und cachen
3. **Shop-spezifisch** (WooCommerce, Shopware): Pro Shop-Instanz bei Connect holen, in Firestore speichern

**DATENQUELLEN PRO MARKTPLATZ:**

| MP | Endpoint / Quelle | Format | Auth | ~Kategorien | Rate Limit | Refresh |
|---|---|---|---|---|---|---|
| Amazon | SP-API Browse Tree Report + Product Type Definitions | XML→CSV + JSON Schema | OAuth 2.0 + AWS IAM | ~30k+ Types | Token Bucket | Wöchentlich |
| Otto | `GET /products/categories` (paginiert) | Flat JSON | OAuth 2.0 Bearer | ~5k+ | 20 req/s | Täglich |
| Etsy | `/v3/application/seller-taxonomy/nodes` + `/properties` | Hierarchical JSON | API Key + OAuth | ~10k+ | 10k/Tag, 10/s | Monatlich |
| Shopify | GitHub `Shopify/product-taxonomy` (Open Source!) | JSON | Keiner! | 5.595 | — | Bei Release |
| Zalando | FCI API (Brand Readiness) | CSV | OAuth 2.0 | Brand-limitiert | — | Quartalsweise |
| WooCommerce | `/wp-json/wc/v3/products/categories` (pro Shop) | Flat JSON | Basic Auth | Shop-spezifisch | Server-abhängig | Täglich |

**IMPLEMENTIERUNGS-REIHENFOLGE:**

| Woche | Was | Output | Aufwand |
|---|---|---|---|
| **KW 11** | Foundation: `taxonomy-loader.js`, `category-matcher.js`, `attribute-mapper.js` + Shopify | Universal Engine + Shopify | 28h |
| **KW 12** | Otto API Fetch + eBay Migration in Engine | Otto + eBay über Engine | 18h |
| **KW 13** | Amazon SP-API (Teil 1): Browse Tree Report + XML→CSV | Amazon Browse Tree | 16h |
| **KW 14** | Amazon (Teil 2): Product Type Definitions + Etsy Taxonomy | Amazon + Etsy in Engine | 22h |
| **KW 15** | WooCommerce Dynamic Sync + `shop-taxonomy-sync.js` | WooCommerce Dynamic | 16h |
| **KW 16** | Zalando Fashion-Set + Refresh Service + Integration Tests | Alle 7+ MPs fertig | 25h |

**Gesamt: ~130h (6 Wochen)**

**⚠️ SOFORT-AKTION:**
1. **Amazon SP-API Registrierung JETZT starten** — dauert 2-4 Wochen!
2. **Etsy App registrieren** — API Key beantragen
3. **Otto Partner Connect** — Credentials besorgen

**ERFOLGS-METRIKEN:**
- Auto-Match Rate (Tier 1-3): >85%
- Gesamt-Match Rate (Tier 1-4): >97%
- Genauigkeit: >92% (Stichproben)
- Gemini-Kosten: <$0.20/1000 Produkte

---

#### Task 9.8: Tracking → Marktplätze Kommunikation verifizieren

**PROBLEM:** Unklar ob Tracking-Nummern erfolgreich an eBay/Kaufland gepusht werden.

**STATUS:** Code existiert in `marketplace-tracking.js` (`pushTrackingToEbay()` via CompleteSale, `pushTrackingToKaufland()`). War in Sprint-Block 4 gefixt (eBay XML repariert, Kaufland Carrier-Map erweitert).

**VERIFIKATION:**
1. Bestellung öffnen die Tracking-Nummer hat
2. Cloud Run Logs prüfen: `grep "marketplace-tracking"` — gibt es Erfolgs- oder Fehlermeldungen?
3. Auf eBay Seller Hub prüfen: Bestellung → Versandstatus → Tracking-Nummer vorhanden?
4. Falls nicht: `pushTrackingToEbay()` manuell debuggen (Token, XML, OrderID)

**Dateien:** `backend/services/marketplace-tracking.js`, `backend/lib/ebay-trading-api.js`

---

#### Task 9.9: 🔴 eBay Integration "Trennen" funktioniert nicht (Doc-ID Mismatch)

**PROBLEM:** User klickt "Trennen" bei eBay-Integration, aber Status bleibt "Verbunden". Re-Connect mit neuen Scopes ist daher nicht möglich.

**ROOT CAUSE — Zwei verschiedene Firestore-Doc-IDs:**
- `integration-store.js` → `deleteIntegration()` löscht Doc `default__ebay` (Collection `integrations`)
- `ebay-oauth.js` → `upsertEbayTokenSet()` speichert in Doc `ebay` (Collection `integrations`)
- `getEbayIntegration()` liest Doc `ebay` → findet Token → zeigt "Verbunden"
- `deleteIntegration()` löscht `default__ebay` → aber `ebay` Doc (mit dem echten Token) bleibt erhalten!

**FIX (2 Optionen — Option A empfohlen):**

**Option A: `deleteIntegration` für eBay erweitern:**
```js
// In integration-store.js → deleteIntegration():
async function deleteIntegration({ tenantId = 'default', type }) {
  const docId = `${tenantId}__${type}`;
  await getDb().collection(COLLECTION).doc(docId).delete();

  // eBay speichert OAuth-Token in separatem Doc
  if (type === 'ebay') {
    await getDb().collection(COLLECTION).doc('ebay').delete();
  }

  return { ok: true, type, status: 'disconnected' };
}
```

**Option B: eBay OAuth auf `{tenantId}__ebay` Doc-ID umstellen:**
- Alle Referenzen in `ebay-oauth.js` von `doc('ebay')` → `doc(`${tenantId}__ebay`)` umstellen
- Multi-Tenancy-ready, aber größerer Umbau

**WICHTIG:** Nach diesem Fix muss der User:
1. eBay trennen (löscht Token)
2. eBay neu verbinden (OAuth-Flow mit erweiterten Scopes aus Task 9.2)
3. Dann funktionieren Returns-Sync und Order-Sync

**Dateien:** `backend/services/integration-store.js`, `backend/lib/ebay-oauth.js`

---

**PRIORITÄT / REIHENFOLGE:**
1. **Task 9.9** — eBay Disconnect fixen (Blocker für Task 9.2!) ✅
2. **Task 9.2** — eBay Scopes erweitern + Error-Handling (kritisch, Retouren leer) ✅
3. **Task 9.1** — SendCloud Matching fixen (kritisch, Versand-Seite leer) ✅
4. **Task 9.3** — Status-Diskrepanz (verwirrend für User) ✅
5. **Task 9.4** — Tracking-Link (quick win) ✅
6. **Task 9.6** — Status-Dropdown filtern (UX) ✅
7. **Task 9.5** — Carrier dynamisch laden (mittel)
8. **Task 9.8** — Tracking-Push verifizieren (nach Deploy)
9. **Task 9.7** — 🔴🔴🔴 INTEGRATIONEN = KUNDEN = UMSATZ (strategisch KRITISCH, Phasenplan in Task 9.7)

---

### Sprint-Regeln

1. **KEIN `// TODO` im Code.** Fertig machen oder explizit dokumentieren was fehlt.
2. **KEINE neuen Mock-Daten.** Wenn Endpoint fehlt, BAU ihn.
3. **TESTE nach jedem Block:** `cd backend && npm test` + `npm run build`
4. **Commit nach jedem Block:** Conventional Commit (`fix(shipping): ...`, `feat(orders): ...`)
5. **KEINE Änderungen an:** `Dockerfile`, `cloudbuild.yaml`, `.firebaserc`, Auth-Middleware, Job-Runnern.
6. **AUSNAHME:** `firebase.json` darf für Firestore-Indexes ergänzt werden.

---

## Active

### Sofort-Bugfixes (vor allem anderen)

- [x] **BUG-019: Marketplace-Listings ohne Inventory-Abgleich — Produkte ohne Lagerbestand werden gelistet** since 2026-03-09 ✅ Fixed: eBay + Kaufland listings now include warehouseStock, binLocation, stockMismatch from products_v2. Split stock into Marktplatz + Lager columns with mismatch badges. KPI card shows discrepancy count. **+ "Artikel listen"-Modal:** Nur Produkte mit Lagerbestand > 0 werden im Publish-Modal angezeigt (BUG-019b, 2026-03-09). Bestand + Bin-Code sichtbar im Modal.
  - **PROBLEM:** eBay- und Kaufland-Marketplace-Seiten zeigen ALLE Listings unabhängig davon, ob das Produkt im Lager ist.
    - `Bestand`-Spalte zeigt den **Marketplace-Wert** (eBay `quantityAvailable`, Kaufland `amount`), NICHT den echten AvyCloud-Lagerbestand
    - Produkte mit Menge 0 in `products_v2` und ohne BIN-Zuordnung im Warehouse werden ohne Warnung angezeigt
    - Kein Join zwischen `ebayListingsLive`/`kauflandUnitsLive` und Warehouse/Inventory-Daten
  - **SOLL:**
    - Marketplace-Listings-Tabelle muss ZWEI Bestand-Spalten haben: **"Marktplatz-Bestand"** (was der Marktplatz denkt) + **"Lagerbestand"** (was wirklich da ist)
    - Wenn Lagerbestand = 0 oder kein BIN zugewiesen → **Warning-Badge "⚠️ Nicht auf Lager"** an der Zeile
    - Diskrepanz-Indikator: Wenn Marktplatz-Bestand ≠ Lagerbestand → **Gelbes "Abweichung"**-Badge
    - Optional: Filter/Tab "Bestandsabweichung" um alle Listings mit Diskrepanz zu finden
  - **FIX Backend:**
    - [ ] eBay: `listLiveListings()` in `ebay-direct.js` — Join mit `products_v2` Inventory-Daten (`inventory.availableQuantity`, `warehouse.binLocation`)
    - [ ] Kaufland: `GET /api/kaufland/listings` in `routes/marketplace.js` — Inventory-Daten aus dem bereits existierenden `products_v2`-Join enrichen
    - [ ] Response-Felder erweitern: `warehouseStock`, `binLocation`, `stockMismatch: boolean`
  - **FIX Frontend:**
    - [ ] `MarketplaceListingsView.tsx` — Neue Spalte "Lagerbestand", Warning-Badge bei Diskrepanz
    - [ ] KPI-Card "Bestandsabweichungen" — Anzahl Listings wo Marktplatz-Bestand ≠ Lagerbestand
  - **Dateien:** `backend/lib/ebay-direct.js`, `backend/routes/marketplace.js`, `components/MarketplaceListingsView.tsx`

- [x] **🔴 BUG-022: BaseLinker-Bestellungen haben KEINE Versandadresse (KRITISCH)** ~~since 2026-03-09~~ (2026-03-09) ✅
  - **PROBLEM:** ALLE BaseLinker-importierten Bestellungen haben leere Adressfelder (street, zip, phone fehlen). Kein Versandlabel erstellbar.
  - **ROOT CAUSE:** `backend/services/order-sync.js` → `mapBaseLinkerOrder()` mappt nur name/city/country, NICHT street/zip/phone/email.
  - **FIX 1:** `mapBaseLinkerOrder()` um `street`, `zip`, `phone`, `email` aus BaseLinker `delivery_*` / `invoice_*` Feldern erweitern
  - **FIX 2:** Migration-Script `backend/scripts/backfill-order-addresses.js` — bestehende Orders aus `raw`-Feld nachträglich reparieren
  - **FIX 3:** Order-Detail-Seite: Adresse editierbar machen (Inline-Edit-Form)
  - **FIX 4:** "Versandlabel erstellen" Button nur aktiv wenn Adresse vollständig
  - **Dateien:** `backend/services/order-sync.js`, `backend/scripts/backfill-order-addresses.js` (NEU), `backend/routes/orders.js`, `components/OrderDetail.tsx`
  - **Siehe Sprint-Block 1 + 3 für detaillierte Arbeitsanweisungen**

- [x] **🔴 BUG-023: SendCloud Gewicht-Bug + Label/Tracking/Status Deep Dive** ~~since 2026-03-09~~ (2026-03-09) ✅
  - Fixed: Weight ×1000, labelUrl null, Marketplace-Tracking nie gepusht, eBay XML kaputt, item.weight nicht gemappt, Popup-Blocker, Status nicht wählbar, Label-Stornierung, Carrier-Maps
  - **Siehe Sprint-Block 4**

- [x] **FEAT: SendCloud Versandinfo-Abruf** ~~since 2026-03-09~~ (2026-03-09) ✅
  - `syncSendCloudParcels()` in shipping-engine.js — holt Parcels, matcht per order_number/external_reference/Name+PLZ
  - `POST /api/orders/sync-sendcloud` Endpoint + "Labels synchronisieren" Button in OrderSettingsView
  - Auto-Transition zu shipped + Tracking-Daten auf Order gesetzt

- [ ] **FEAT: eBay Integration über Integrationen nicht möglich** since 2026-03-09
  - **PROBLEM:** eBay OAuth-Flow über den IntegrationsHub schlägt fehl. User kann eBay nicht selbstständig verbinden.
  - **MÖGLICHE URSACHEN:** Fehlende Secrets (EBAY_CLIENT_ID/SECRET/RU_NAME), RuName-Mismatch, Scope-Limitierung, Callback-URL stimmt nicht
  - **DEBUGGING:** Logs prüfen, Secrets verifizieren, manueller OAuth-Start-Test
  - **Dateien:** `backend/lib/ebay-oauth.js`, `backend/routes/marketplace.js`, `components/IntegrationWizard.tsx`
  - **Siehe Sprint-Block 7 für vollständige Debugging-Anleitung**

- [ ] **BUG-020: Retouren-Status verifizieren** since 2026-03-09
  - **KONTEXT:** Returns-Engine Bugs gefixt (Sprint-Block 6): eBay → Post-Order REST API, Kaufland → /v2/ prefix fix, shared Firestore instance, route ordering fix. Aber:
    - [ ] Muss verifiziert werden ob Sync auf Production funktioniert (Button "Retouren synchronisieren" klicken)
    - [ ] Prüfen ob die ReturnsView echte Daten zeigt oder leer bleibt
    - [ ] Prüfen ob Auto-Sync (periodic returns-sync alle 4h) tatsächlich läuft
  - **Dateien:** `backend/services/returns-engine.js`, `components/ReturnsView.tsx`

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

- [x] **AUDIT-007: Erfassen-Route hat keinen eigenen View** ✅ Fixed: New 5-step CaptureView stepper (Upload → KI-Erkennung → Prüfen → Preis/Lager → Zusammenfassung) at `#/products/capture`, replaces old ProductInput
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
    - **Die APIs existieren bereits!** `ebay-trading-api.js` + `kaufland-api.js` sind aktiv — nur die Order-Endpoints werden noch nicht genutzt.
    - **eBay:** `GetOrders` (Trading API) — liefert: OrderID, BuyerInfo, TransactionArray (Items, SKU, Quantity, TransactionPrice), ShippingAddress, PaymentStatus, OrderStatus, ShippedTime. Auch: `GetReturnRequests` für Retouren.
    - **Kaufland:** `GET /orders` + `GET /order-units` — liefert: id_order, buyer (name, email, address), items (id_offer/sku, quantity, price), status, ts_created. Auch: `GET /returns` für Retouren.
    - `backend/services/order-intake-ebay.js` (NEU) — eBay GetOrders Polling (alle 5 Min oder Webhook via eBay Platform Notifications)
    - `backend/services/order-intake-kaufland.js` (NEU) — Kaufland Orders API Polling (alle 5 Min)
    - Eigene `orderId`-Generierung (nicht mehr BaseLinker-ID als Primary Key)
    - Neues Feld `source: 'ebay' | 'kaufland' | 'manual'` (BaseLinker wird Fallback, nicht Default)
    - Deduplizierung: Marketplace-OrderID als Unique Key → keine Duplikate
    - **Retouren gleich mitziehen:** eBay `GetReturnRequests` + Kaufland `GET /returns` direkt in `returns` Collection
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

- [x] **M7: Multi-Carrier Versand-Management** since 2026-03-05 ✅ Komplett (2026-03-09)
  - ✅ `lib/sendcloud.js` existiert (Kosten-Aggregation, NICHT Label-Erstellung)
  - ✅ `ShippingView.tsx` UI existiert (KPI-Cards, Carrier-Badges, Tracking-URLs, Bulk-Label-Button)

  **Implementierung via OMS-B1 + OMS-B2 (siehe Modul 6)**

  - [x] **M7-1: SendCloud Label-API** — `backend/services/shipping-engine.js`: createParcel(), getLabel(), cancelParcel()
  - [x] **M7-2: Versand-Regeln** — `matchCarrierRule()` in shipping-engine.js, Regeln aus `order_settings.carrierRules`
  - [x] **M7-3: Tracking-Dashboard** — ShippingView.tsx: Tabs, KPIs, clickable Tracking-URLs, echte `shipments` Collection
  - [x] **M7-4: Bulk-Label-Druck** — `POST /api/orders/bulk-ship` (max 50), UI-Button in ShippingView
  - **Backend:** `backend/services/shipping-engine.js`, `backend/routes/webhooks.js`
  - **Dateien:** `components/orders/ShippingView.tsx`, `backend/services/shipping-engine.js`

---

### Modul 8: Retouren (Returns Management)

- [x] **M8: Retouren-Management** since 2026-03-05 ✅ Komplett (2026-03-09)
  - ✅ `ReturnsView.tsx` UI: Marketplace-Sync-Button, Prozess-Dialog (Warenprüfung + Erstattung), Marketplace-Badges
  - ✅ `backend/routes/returns.js`: 8 Endpoints (CRUD + process + refund + close + sync + events)
  - ✅ `backend/services/returns-engine.js`: Komplette Returns Engine

  - [x] **M8-1: Marketplace-Retouren empfangen**
    - `syncEbayReturns()`: GetReturnRequests API, Deduplizierung via `marketplaceReturnId`
    - `syncKauflandReturns()`: GET /v2/returns API, Deduplizierung via `marketplaceReturnId`
    - `syncAllReturns()`: Combined sync, `POST /api/returns/sync`

  - [x] **M8-2: Retouren-Workflow**
    - Status-Flow: `eingegangen → in_pruefung → erstattet | teilweise_erstattet | abgelehnt → abgeschlossen`
    - `transitionReturn()`: Validierte Statusübergänge, Event-Logging in `return_events` Collection
    - `processReturn()`: Warenprüfung (A/B/C-Ware), Erstattungsentscheidung, Auto-Restock
    - `restockItem()`: Wiedereinlagerung als `warehouse_movements` Eintrag

  - [x] **M8-3: Retouren-Gründe (kategorisiert)**
    - 7 interne Kategorien: defekt, falsche_lieferung, nicht_wie_beschrieben, zu_spaet, meinungsaenderung, doppelbestellung, sonstiges
    - `EBAY_REASON_MAP` + `KAUFLAND_REASON_MAP`: Marketplace → interne Zuordnung

  - [x] **M8-4: Erstattungs-Kommunikation**
    - `issueEbayRefund()`: IssueRefund via Trading API
    - `issueKauflandRefund()`: PATCH /v2/returns/{id}/accept via Kaufland API
    - Frontend: "Erstatten" Button nach Verarbeitung → Marketplace-Refund

  - **Backend:** `backend/services/returns-engine.js`, `backend/routes/returns.js`
  - **Frontend:** `components/orders/ReturnsView.tsx` (ProcessDialog, Marketplace-Sync, Workflow-Buttons)

---

### Modul 9: Integrationen — Self-Service Integration Hub

- [ ] **M9: Integrations-Hub — Echte Verbindungen, echte Auth-Flows, kein Fake** since 2026-03-05 (⚠️ UI existiert aber KEINE Konfiguration möglich)
  - ✅ `IntegrationsHub.tsx` zeigt 6 Karten mit Verbindungsstatus
  - ✅ `GET /api/integrations/status` prüft ob Secrets vorhanden sind
  - ❌ **KEIN Self-Service-Setup:** Man kann keine Integration verbinden oder konfigurieren
  - ❌ **KEIN OAuth-Flow-Start** aus der UI (eBay OAuth existiert im Backend, aber kein Button im IntegrationsHub)
  - ❌ **KEIN API-Key-Input-Modal** für Kaufland/BaseLinker/SendCloud/SevDesk
  - ❌ **KEIN Integration-Settings-Panel** (Sync-Intervall, Was syncen, Fehler-Log)
  - ⚠️ **KRITISCH FÜR OMS:** Ohne Self-Service-Integrationen kann das OMS keine Marketplace-Bestellungen empfangen. Modul 9 ist VORAUSSETZUNG für OMS Phase A.
  - ⚠️ **KRITISCH FÜR SAAS:** Ohne Self-Service-Integrationen kann kein neuer Kunde AvyCloud nutzen

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

- [x] **M13: Erfassen — KI-gestützte Produkterkennung als geführter Flow** since 2026-03-05 ✅ Komplett (2026-03-09)
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
