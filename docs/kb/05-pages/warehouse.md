---
title: Warehouse (Lager)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Lager-Verwaltung mit drei Tabs: **Struktur** (Zonen X/XS/S/M/L/XL/XQ/P × Etagen GA/UG/EG, BINs anlegen/löschen, Labels drucken), **Bewegungen** (`warehouseEvents`), **Bestand** (BIN-Bestand-Übersicht). Separate Settings-View für globale Lager-Konfiguration (Default-Zone, Druck-Defaults, etc.).

## Komponente(n)

- [components/WarehouseView.tsx](../../../components/WarehouseView.tsx) — Container, Tab-Logik (`structure | movements | inventory`).
- [components/warehouse/WarehouseInventoryTab.tsx](../../../components/warehouse/WarehouseInventoryTab.tsx) — BIN-Bestand-Übersicht.
- [components/warehouse/WarehouseMovementsTab.tsx](../../../components/warehouse/WarehouseMovementsTab.tsx) — Stock-In/Out-Historie.
- [components/warehouse/WarehouseSettingsView.tsx](../../../components/warehouse/WarehouseSettingsView.tsx) — Settings-View (separate Route `warehouse-settings`).

## API-Calls

WarehouseView:
- `fetchWarehouseZones()` — alle konfigurierten Zonen.
- `fetchWarehouseBins(zone, etage)` — BIN-Liste pro Zone+Etage.
- `fetchWarehouseBinDetail(binCode)` — Bestand und Bewegungen eines BINs.
- `createWarehouseLayoutApi(zone, etage, payload)` — neue Gang/Regal/Ebene-Struktur anlegen.
- `removeProductFromBinApi(binCode, productId)` — Produkt aus BIN entfernen (geht durch `bookStockOut` → `warehouseEvents`).
- `deleteWarehouseGangApi`, `deleteWarehouseRegalApi`, `deleteWarehouseEbeneApi` — Struktur-Lösch-Endpoints (nur wenn leer; BUG-078 hat hier den `nonEmpty`-Filter gefixt).
- `openBinLabelWindow(binCode)`, `openBinLabelsBatchWindow(binCodes)` — Label-Druck (öffnet PDF in neuem Tab).
- `createChildBinApi`, `deleteChildBinApi` — Child-BIN-Verwaltung (für Mehrfach-Bestände in einem Regalfach).

WarehouseSettingsView:
- `fetchWarehouseSettings()` — `/api/warehouse/settings` GET.
- `saveWarehouseSettings(payload)` — `/api/warehouse/settings` PUT/POST.

Pro-Endpunkt-Doku: `docs/kb/09-api/warehouse.md` (TBD).

## Datenquellen

- Lokaler `useState` — kein React-Query in dieser View.
- `useToast` (über `Notice`-/`ConfirmDialog`-Komponenten) für UX.
- Zonen-/Etagen-Konstanten lokal: `ZONE_OPTIONS = ['X','XS','S','M','L','XL','XQ','P']`, `ETAGE_OPTIONS = ['GA','UG','EG']`.

## Wichtige Edge-Cases

- **Empty-State**: ohne Zonen → Notice-Banner mit Hinweis auf Setup; ohne BINs in gewählter Zone+Etage → leere Tabelle.
- **Loading**: lokaler Spinner pro Tab.
- **Error**: Inline-Notice (`components/ui/Notice.tsx`) und `ConfirmDialog` für destruktive Aktionen.
- **Destruktiv**: Gang/Regal/Ebene-Lösch nur möglich wenn alle Child-BINs leer sind (siehe `nonEmpty`-Filter, BUG-078).
- **Label-Druck**: öffnet neue Fenster — Browser-Popup-Blocker muss erlaubt sein.
- **Mobile**: kein eigener Mobile-View; Struktur-Tab ist auf Tablet+ ausgelegt.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-078** BIN-Löschung blockiert obwohl Bestand = 0 (✅ gefixt). Falls erneut auftaucht → `nonEmpty`-Filter in `deleteWarehouseEbeneApi`-Backend-Pfad prüfen.
- **BUG-083** ProductSheet zeigt „keinem BIN zugeordnet" obwohl Tabelle + Warehouse BIN zeigen (✅ gefixt) — relevant für Cross-Konsistenz Warehouse ↔ ProductSheet.
- **CLAUDE.md §13** Stock-Single-Writer-Invariant: jede Stock-Mutation über `bookStockOut`/`bookStockIn` und `lib/warehouse.js`. Direkte `tx.update(productRef, { 'inventory.quantity': X })` ist verboten.
