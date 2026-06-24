# Spec — Admin-Finanzbericht (Umsatz, Kosten, Gewinn) mit Zeitraum-Filter

**Datum:** 2026-06-24
**Status:** Freigegeben (User-Approval im Brainstorming)
**Branch:** `feat/admin-financials`

## Problem / Ziel

Das Haupt-Dashboard zeigt bewusst keine Euro-Beträge mehr (Operations-Fokus). Der Owner
braucht die Finanzsicht aber weiterhin — **realistische, wahrheitsgemäße, plausible**
Kalkulationen (Umsatz, Kosten, Auszahlung, Gewinn, Bestandswert) im **Admin-Bereich**,
mit `von/bis`-Zeitraumfilter wie früher.

Wichtige Erkenntnis aus der Code-Analyse: Die Backend-Endpunkte rechnen alle Finanzwerte
weiterhin voll aus — beim Dashboard-Redesign (Commit `41a72e5`) wurden nur die Frontend-Karten
entfernt. Wir bauen also primär einen **neuen, konsolidierten, ehrlichen Bericht** auf bereits
erprobter Rechen-Logik, nicht eine neue Berechnung von Grund auf.

## Goldene Regel / Production-Safety

- **Additiv only.** Keine bestehende Route/Funktion/Feld ändern.
- **Keine Red-Zone-Datei** anfassen: `lib/rbac.js`, `index.js`, Dockerfile, CI bleiben unberührt.
  - Gating über `requirePermission('admin', 'reports.read')` — Admins passieren per `isAdmin`-Bypass,
    alle anderen 403. Faktisch admin-only, **ohne** `rbac.js` zu editieren.
  - Endpunkt wird an den **bereits gemounteten** `routes/admin.js` gehängt → kein `index.js`-Edit.
- **Keine Live-Route refactoren:** `orders.js` (`/dashboard/metrics`, `/dashboard/finance`) und
  `Dashboard.tsx` bleiben unverändert. Range-Resolver und Date-Picker werden **additiv neu**
  gebaut und spiegeln exakt die bestehende Semantik (durch Tests abgesichert).

## Architektur

```
Frontend (Admin → Tab "Finanzen")
  AdminFinancials.tsx  ──fetchFinancialReport(range)──►  GET /api/admin/financials
                                                              │ requirePermission('admin','reports.read')
                                                              ▼
                                                   services/financial-report.js
                                                     ├─ lib/date-range.js   (Zeitraum auflösen)
                                                     ├─ getDashboardMetrics() (roher Brutto-Umsatz, Kaufland gross/payout, range)
                                                     ├─ returns-Collection   (Retouren-Summe im Fenster)
                                                     ├─ getEbayNetRevenueSummary() (eBay-Auszahlung exakt, sonst Schätzung)
                                                     ├─ lib/cogs.js          (Produkt-Kostenindex + COGS je Auftrag)
                                                     ├─ getCheckAccountBalances() (Kontostand)
                                                     └─ getShippingCostsFromSevDesk()+getSendCloudShippingSummary() (Versand)
```

## Wahrheitsgemäße P&L-Definition (kein Doppelzählen)

Alle Werte für den gewählten Zeitraum. Jede Kennzahl trägt ein **Ehrlichkeits-Label**.

| Kennzahl | Formel | Label |
|---|---|---|
| **Umsatz (brutto)** | `getDashboardMetrics().revenue.window_non_cancelled_total` (ROH, vor Retouren) | `exakt` |
| **Marktplatz-Gebühren** | `Umsatz − Auszahlung` | `abgeleitet` |
| **Auszahlung** | eBay-Payout + Kaufland-Payout | `exakt` / `geschätzt` |
| ↳ eBay-Payout | `ebay_net_window` (Finances API) **oder** `max(0, Umsatz − kaufland_gross) × 0.75` | exakt/geschätzt |
| ↳ Kaufland-Payout | `kaufland_gross_window × 0.8334` (14% Provision + 19% MwSt) | geschätzt |
| **Versandkosten (brutto)** | `shipping_netto × 1.19` (SendCloud primär, SevDesk direkt) | `exakt` |
| **Retouren (Erstattungen)** | Σ `refundAmount` aus `returns` mit `createdAt` im Fenster | `exakt` |
| **Wareneinsatz (COGS)** | Σ über Aufträge im Fenster, über `items`: `qty × product.buyPrice` (SKU→EAN-Match) | `kalkulatorisch · X% Abdeckung` |
| **Rohgewinn / Deckungsbeitrag** | `Auszahlung − Versandkosten − COGS − Retouren` | `kalkulatorisch` |
| **Marge %** | `Rohgewinn / Umsatz × 100` | `kalkulatorisch` |

**Begründung „Rohgewinn" statt „Nettogewinn":** Fixkosten (Monatsgebühren etc.) sind nicht
verlässlich pro Zeitraum zuordenbar — wir nennen es ehrlich Deckungsbeitrag, nicht Reingewinn.

**Begründung „kalkulatorisch" bei COGS:** Aufträge speichern keinen Einkaufspreis zum
Verkaufszeitpunkt. COGS basiert auf dem **heutigen** `buyPrice` je verkauftem Artikel
(SKU-Match, EAN-Fallback). Historische Einkaufspreis-Änderungen sind nicht erfasst.
Die **Daten-Abdeckung %** (= zugeordneter Posten-Umsatz / gesamter Posten-Umsatz) wird
prominent angezeigt, damit der Gewinn nicht schöngerechnet wirkt.

## Bestandswert (Stichtag heute — nicht zeitraumabhängig)

Ein Durchlauf über alle Produkte des Tenants (gleicher Load wie der COGS-Index):
- **Gebundenes Kapital** = Σ `inventory.quantity × (buyPrice || lowest_price.amount || 0)`
- **Potenzieller Umsatz** = Σ `inventory.quantity × (sellPrice || lowest_price.amount || 0)`
- Artikel- und Einheitenzahl

Kanonische Formel gespiegelt aus `components/InventoryView.tsx` (BUG-074).

## Kontostand (Stichtag heute)

`getCheckAccountBalances()` — Sichteinlagen + Business-Card, exakt.

## Verlaufs-Chart

Pro Bucket (Tag/Woche/Monat je nach Zeitraum): **Umsatz (brutto)** als Balken und
**Rohertrag (Umsatz − COGS)** als Linie. Beide pro Bucket **exakt** berechenbar
(keine erfundene Fee-/Versand-Allokation pro Bucket). Klar beschriftet, damit es nicht
mit dem vollen Rohgewinn der KPI-Karten verwechselt wird.

## Datenqualität-Panel (die „fehler-sind-luxus"-Garantie, sichtbar)

- COGS-Abdeckung % + Anzahl nicht zuordenbarer Posten
- Auszahlungs-Quelle: `eBay Finances (exakt)` vs. `geschätzt (×0.75)`
- Fehler externer Quellen (SevDesk/SendCloud/eBay) als `errors[]`, nie blockierend

## Module (Bausteine)

**Backend (neu, additiv):**
- `backend/lib/date-range.js` — `resolveRange({ preset, fromDate, toDate, now })` →
  `{ preset, label, fromIso, toIsoExclusive, fromDateStr, toDateStr, bucket }`.
  Spiegelt exakt die `orders.js`-Semantik (last7 = 7 Kalendertage inkl. heute, custom, month_YYYY_MM, …).
- `backend/lib/cogs.js` —
  - `buildProductCostIndex(products)` → `Map` von sku/ean → `{ buyPrice, sellPrice, lowestPrice }`.
  - `computeOrderCogs(order, index)` → `{ cogs, matchedRevenue, totalItemRevenue, unmatchedItems }`.
  - `computeInventoryValue(products)` → `{ capitalAtCost, potentialRevenue, articleCount, unitCount }`.
- `backend/services/financial-report.js` — `getFinancialReport({ preset, fromDate, toDate, tenantId })`
  orchestriert alle Quellen, baut P&L + Bestand + Verlauf + Datenqualität, degradiert sauber.

**Backend (additiver Edit, Yellow-Zone, mit Sorgfalt):**
- `backend/routes/admin.js` — `GET /financials` (gated `requirePermission('admin','reports.read')`,
  tenant-scoped, try/catch, ETag-Cache `private, max-age=30`).

**Frontend (additiv):**
- `components/admin/AdminFinancials.tsx` — Bericht-Seite (eigener von/bis-Picker, KPI-Karten mit
  Labels, Recharts-Chart, Marktplatz-Aufschlüsselung, Bestand, Kontostand, Datenqualität).
- `components/admin/AdminPanel.tsx` — neuer Tab `'financials'` → „Finanzen".
- `api/client.ts` — `fetchFinancialReport(preset, opts)`.
- `types.ts` — `FinancialReport`-Typen.

## Tests (TDD, Pflicht laut CLAUDE.md)

- `lib/date-range.test.js` — alle Presets, custom, month_YYYY_MM, Grenzen (last7 = 7 Tage), Default.
- `lib/cogs.test.js` — SKU-Match, EAN-Fallback, fehlender buyPrice → unmatched, Abdeckung %,
  lowest_price-Fallback, Inventory-Value (Verkaufs- + Einkaufspreis), Mengen.
- `services/financial-report.test.js` — Orchestrierung mit gemockten Quellen: korrekte P&L-Mathematik,
  **kein Doppelzählen** der Retouren, geschätzt-vs-exakt Auszahlung, graceful degradation bei Quelle-Fehler.
- Integrationstest Endpunkt — RBAC-Gate (403 ohne Recht, 200 als Admin), Response-Shape.

## Out of Scope (YAGNI)

- Kein Refactor bestehender Endpunkte/Komponenten.
- Kein historischer Einkaufspreis-Snapshot (separates, größeres Vorhaben).
- Keine Fixkosten/Reingewinn-Berechnung (Daten nicht verlässlich pro Zeitraum).
- Kein CSV/PDF-Export in dieser Iteration (kann später additiv folgen).

## Risiken & Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| Doppelzählung Retouren | P&L selbst aus rohen Primitiven, ein Ort; Test deckt es ab |
| N+1 Firestore bei COGS | Produkte einmal laden → In-Memory-Map; Report-Cache |
| Externe Quelle (SevDesk/eBay) down | `Promise.allSettled`, `errors[]`, Werte als „nicht verfügbar" markiert, nie 500 |
| Falsche Euro-Zahl unbemerkt | Plausibilitätsprüfung gegen echte Daten vor Commit (read-only Script) |
| buyPrice lückenhaft → falscher Gewinn | Abdeckung % sichtbar, Label „kalkulatorisch" |
