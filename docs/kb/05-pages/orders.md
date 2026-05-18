---
title: Orders (Bestellungen)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Zentrale Order-Management-View: Marketplace-übergreifende Liste aller Bestellungen mit OMS-Status-Pipeline (`pending → confirmed → picking → picked → packing → packed → shipped`), Bulk-Aktionen, Filter (Status, Marketplace, Carrier, Datum), Sync-Trigger und KPI-Karten.

## Komponente(n)

- [components/OrdersView.tsx](../../../components/OrdersView.tsx) — Haupt-Container, Filter-Leiste, Tabelle, Bulk-Bar, Pipeline-Visualisierung.
- [components/OrderDetail.tsx](../../../components/OrderDetail.tsx) — Detail-Panel das per Row-Klick geöffnet wird (`selectedOrderId`-State).

## API-Calls

- `useOrders(500)` → `fetchOrders(500)` (`hooks/useOrders.ts`, React-Query, staleTime 60s, refetchOnWindowFocus). Cache-Key: `["orders", limit]`.
- `syncOrders()` — Sync von eBay (Single-Source).
- `syncMarketplaceOrders(marketplace, days)` — Multi-Marketplace-Sync (eBay + Kaufland).
- `bulkTransitionOrders(orderIds, targetStatus)` — bulk OMS-State-Transition; läuft serverseitig durch `transitionOrder()` ([backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js)).
- `printAddressLabels(orderIds)` — generiert PDFs mit Adress-Labels.
- `buildImageProxyUrl(url)` — Helper für Produkt-Thumbnails.

Pro-Endpunkt-Doku: `docs/kb/09-api/orders.md` (TBD).

## Datenquellen

- `useOrders(500)` (React-Query) als Primary Source. Aktualisierung über SSE-Cache-Invalidation aus [hooks/useSSE.ts](../../../hooks/useSSE.ts).
- `useQueryClient` für manuelle `invalidateQueries(['orders', 500])` nach Bulk-Aktionen.
- I18n via `useI18n()` (i18n-Keys: `orders.filter.*`, `orders.title`, …).

## Wichtige Edge-Cases

- **Empty-State**: `EmptyState`-Component aus [components/ui/EmptyState.tsx](../../../components/ui/EmptyState.tsx) wenn `orders.length === 0`.
- **Loading**: `loading`-Flag aus `useOrders` blendet Skeleton/Spinner ein.
- **Error**: `queryError` aus React-Query wird als Banner über der Tabelle gezeigt.
- **Filter-Kombinationen**: `filter` (Status), `marketplaceFilter`, `carrierFilter`, `datePreset` (`all|today|7d|30d|90d`) plus `dateFrom`/`dateTo` werden client-seitig kombiniert.
- **Bulk-Selection**: `selectedIds: Set<string>` mit `bulkBusy`-Lock während Aktionen, `bulkResult` als Inline-Feedback.
- **Pipeline-Counts** (Stand BUG-071): werden **client-seitig** aus den lokalen Orders berechnet, NICHT mehr aus separatem Backend-Endpoint — damit Tab-Counts und Pipeline-Counts immer konsistent sind.
- **Sort**: `sortField`: `createdAt | totalAmount | status`, `sortAsc: boolean`.
- **Pagination**: `rowsPerPage` (Default 50), `currentPage` — rein client-seitig auf dem 500er-Fetch.
- **Mobile**: kein eigener Mobile-View; Tabelle ist horizontal scrollbar. Mobile Operations laufen über [MobileOperationsView.tsx](../../../components/MobileOperationsView.tsx).

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-071** Bestellungen Pipeline-Zahlen inkonsistent mit Tab-Zahlen (✅ gefixt durch client-side `categorizeStatus`).
- Schreibpfade auf `omsStatus` MÜSSEN über `transitionOrder()` laufen ([CLAUDE.md §11](../../../CLAUDE.md)). Wenn ein neuer Bulk-Action auf Order-State gebaut wird → ausschließlich `bulkTransitionOrders` benutzen, nie direkten Firestore-Write.
