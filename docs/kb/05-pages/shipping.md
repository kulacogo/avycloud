---
title: Shipping (Versand)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Versand-Übersicht aller Pakete: zeigt aktuelle Sendungen aus SendCloud (DHL/DPD), erlaubt Bulk-Versand mehrerer Orders gleichzeitig und Sync der Parcel-Daten zurück aus SendCloud. Wird vom Versand-Operator nach `packed`-Status benutzt.

## Komponente(n)

- [components/orders/ShippingView.tsx](../../../components/orders/ShippingView.tsx) — Haupt-View.
- [components/orders/ShippingDecisionDialog.tsx](../../../components/orders/ShippingDecisionDialog.tsx) — `CarrierPickModal` + `WeightPromptModal`, beim Wechsel auf `shipped` über `MobileOperationsView` / `OrdersView` genutzt.

## API-Calls

- `fetchShipments(params)` — `/api/shipments`. Liefert `ShipmentData[]`.
- `bulkShipOrders(orderIds, options)` — bulk shipment-create (SendCloud-Backend).
- `syncSendCloudParcels()` — Pull der aktuellen Parcel-Stati von SendCloud.
- `fetchShippingMethods()` — verfügbare Versandmethoden für Carrier-Auswahl.

Pro-Endpunkt-Doku: `docs/kb/09-api/shipping.md`, `docs/kb/09-api/sendcloud.md` (TBD).

## Datenquellen

- Lokaler `useState` für `shipments`, `loading`, `error`, `selectedIds` — **kein** React-Query.
- `useToast` ([context/ToastContext.tsx](../../../context/ToastContext.tsx)) für User-Feedback nach Bulk-Aktionen.

## Wichtige Edge-Cases

- **Empty-State**: `EmptyState`-Component, wenn keine Sendungen im aktuellen Filter.
- **Loading**: lokaler Spinner während Initial-Fetch + während Bulk-Ship-Action.
- **Error**: Toast-Banner via `useToast.error(...)`.
- **Duplikate**: bei zwei aufeinanderfolgenden SendCloud-Syncs kann es zu temporären Duplikat-Anzeigen kommen — siehe BUG-092.
- **Mobile**: keine eigene Mobile-Variante; Tabelle scrollt horizontal.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-072** Versand-Tabelle: Geisterdaten + retired middleware-Referenz (✅ gefixt, P0!). Falls retired middleware-Felder neu auftauchen → CLAUDE.md §9 (retired middleware ist TABU) prüfen.
- **BUG-092** Versand: Duplikat-Einträge + falscher „Problem"-Status bei versendeten Paketen (P1, offen). Workaround: erneuter `syncSendCloudParcels`-Trigger.
