---
title: API — Orders (OMS + Dashboard + Shipping + Invoices)
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Orders

Mount: `app.use('/api', ordersRouter)` ([backend/index.js#L244](../../../backend/index.js#L244)). Globale `requireAuth` greift.

Quelle: [backend/routes/orders.js](../../../backend/routes/orders.js). State Machine: [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js). Shipping Engine: [backend/services/shipping-engine.js](../../../backend/services/shipping-engine.js).

Tenant-Source: `req.user?.tenantId || 'default'`.

Dieser Router enthält neben Order-Endpoints auch das **Dashboard**, **Shipments**, **Shipping-Methods**, einige **Invoice/SevDesk**-Endpoints und **Sync-Status**.

## Order-Status (OMS)

Übergänge gehen **ausschließlich** über `transitionOrder()` (CLAUDE.md Punkt 11). Status-Definitionen aus state-machine: `pending`, `confirmed`, `picking`, `picked`, `packing`, `packed`, `shipped`, `delivered`, `completed`, `returned`, `cancelled`, `on_hold`.

---

## Order-Listing & Detail

### `GET /api/orders`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: Query `?limit=50&offset=0`. `limit` max 500.
- **Response**:
  ```json
  {
    "ok": true,
    "data": [{ "id": "...", "orderId": "...", "marketplace": "ebay|kaufland|...", "omsStatus": "...", "customer": {...}, "items": [...], "pickHints": {...} }],
    "meta": { "total": <int>, "limit": 50, "offset": 0, "hasMore": <bool> }
  }
  ```
  - ETag-fähig — 304 wenn `If-None-Match` matched.
  - `marketplace`/`source` werden client-side resolved (via `raw.order_source`, OrderID-Format-Detection). **Self-heal**: erkannter Marketplace wird fire-and-forget zurückgeschrieben.
- **Side-Effects**:
  - `listOrders(limit+offset)` aus Firestore.
  - `attachPickHintsToOrders()` aus pick-hints service.
  - Fire-and-forget `_backgroundSyncOrders()` (eBay+Kaufland-Intake mit Throttle 60 s).
- **Idempotency**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/orders.js#L83-L118](../../../backend/routes/orders.js#L83-L118)

### `GET /api/orders/:orderId/detail`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "order": { "id": "...", "omsStatus": "shipped", ... },
      "timeline": [{ "timestamp": "...", "event": "...", "actor": {...} }],
      "nextStatuses": [{ "key": "delivered", "label": "..." }],
      "allStatuses": { "shipped": { "label": "..." }, ... }
    }
  }
  ```
- **Side-Effects**: read.
- **Failure Modes**: `404 { code: 'NOT_FOUND' }`, `500`.
- **Source**: [backend/routes/orders.js#L939-L970](../../../backend/routes/orders.js#L939-L970)

### `GET /api/orders/:orderId/timeline`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: implicit
- **Request**: Query `?limit=50`. Max 200.
- **Response**: `{ "ok": true, "data": [{ "timestamp": "...", "event": "...", ... }] }`
- **Side-Effects**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/orders.js#L1071-L1081](../../../backend/routes/orders.js#L1071-L1081)

### `GET /api/orders/statuses`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "statuses": {...}, "counts": { "pending": 12, ... } } }`
- **Side-Effects**: read.
- **Source**: [backend/routes/orders.js#L924-L933](../../../backend/routes/orders.js#L924-L933)

### `GET /api/orders/sequences`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { ...sequenceStates } }` (Nummernkreise für Invoice, Order, …).
- **Source**: [backend/routes/orders.js#L1117-L1126](../../../backend/routes/orders.js#L1117-L1126)

### `PUT /api/orders/:orderId`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request** (Whitelist):
  ```json
  { "customer": { "name": "...", "street": "...", "city": "...", "zip": "...", "country": "...", "phone": "...", "email": "..." }, "weight": 1.2 }
  ```
- **Response**: `{ "ok": true }`
- **Side-Effects**: Direct-Update auf erlaubte Felder + Audit-Log `order.updated`. `weight` als Number, `zip` als String (Leading-Zero-safe).
- **Idempotency**: idempotent.
- **Failure Modes**: `400 { code: 'VALIDATION' }`, `500`.
- **Source**: [backend/routes/orders.js#L1790-L1848](../../../backend/routes/orders.js#L1790-L1848)

---

## Order-Lifecycle (Transitions)

### `POST /api/orders/:orderId/transition`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "toStatus": "shipped|delivered|cancelled|...", "note": "optional", "force": true|false }`
- **Response**:
  ```json
  { "ok": true, "data": { "fromStatus": "...", "toStatus": "...", "ok": true, "marketplacePush": { "ok": true, "skipped": false } } }
  ```
- **Side-Effects**:
  - `transitionOrder()` aus state-machine.
  - Emit `order:status_changed`.
  - Bei `cancelled`: `pushCancellationToMarketplace` + setImmediate `createCorrectionInvoice (storno)`.
  - Bei `shipped`: `pushTrackingToMarketplace` (synchron, time-critical).
  - Bei `picked`: setImmediate Auto-Invoice + SevDesk-Export (skipped wenn schon `invoiceId`).
- **Idempotency**: engine prüft „bereits in Zielzustand" → idempotent.
- **Failure Modes**: `400 { code: 'TRANSITION_DENIED' }` mit engine-message; `500`.
- **Source**: [backend/routes/orders.js#L976-L1065](../../../backend/routes/orders.js#L976-L1065)

### `POST /api/orders/:orderId/complete`

Pick-Workflow (Marketplace-spezifisch via `order-source-router`).

- **Auth**: `requirePermission('orders', 'pick')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**:
  - `pickOrder({ orderId, actor })` aus `services/order-source-router.js`.
  - Emit `order:status_changed` (toStatus `picked`).
  - setImmediate Auto-Invoice + SevDesk-Export falls noch keine.
- **Source**: [backend/routes/orders.js#L632-L679](../../../backend/routes/orders.js#L632-L679)

### `POST /api/orders/:orderId/pack`

- **Auth**: `requirePermission('orders', 'pack')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: `packOrder()` + emit `order:status_changed` toStatus `packed`. Triggert Stock-Sync zu allen Channels.
- **Source**: [backend/routes/orders.js#L681-L708](../../../backend/routes/orders.js#L681-L708)

### `POST /api/orders/bulk-transition`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "orderIds": [...], "toStatus": "...", "note": "...", "force": false }`. Max 50.
- **Response**: `{ "ok": true, "data": { "total": 50, "success": 48, "results": [...] } }`
- **Side-Effects**:
  - Per-Order `transitionOrder`. Erfolgreiche Cancellation triggert `releaseReservation`, `syncStockForOrderItems`, `pushCancellationToMarketplace`. Erfolgreiches `shipped` triggert `pushTrackingToMarketplace` falls Order eine `trackingNumber` hat.
- **Idempotency**: per-Order idempotent.
- **Failure Modes**: `400 { code: 'VALIDATION' }` für leeres Array oder fehlendes `toStatus`.
- **Source**: [backend/routes/orders.js#L1712-L1782](../../../backend/routes/orders.js#L1712-L1782)

---

## Order-Sync

### `POST /api/orders/sync`

- **Auth**: `requirePermission('orders', 'read')` (sic — `'read'`, nicht `'write'`)
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [...orders] }` (top 500 cached)
- **Side-Effects**: kicks background sync, antwortet sofort mit cached Daten.
- **Source**: [backend/routes/orders.js#L611-L630](../../../backend/routes/orders.js#L611-L630)

### `POST /api/orders/sync/marketplace`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: `{ "marketplace": "ebay" | "kaufland" | "all", "lookbackDays": 7 }`
- **Response**: `{ "ok": true, "data": { "results": { "ebay": {...}, "kaufland": {...} }, "totalSynced": <int> } }`
- **Side-Effects**: `syncEbayOrders` und/oder `syncKauflandOrders` (intake-services).
- **Failure Modes**: per-Marketplace gefangene Errors landen im result-Objekt.
- **Source**: [backend/routes/orders.js#L1087-L1111](../../../backend/routes/orders.js#L1087-L1111)

### `POST /api/orders/sync-sendcloud`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "fromDate": "2026-04-01", "toDate": "2026-05-01" }`
- **Response**: `{ "ok": true, "data": { "matched": <int>, "unmatched": <int>, "skipped": <int>, "details": {...} } }`
- **Side-Effects**: `syncSendCloudParcels()` aus shipping-engine.
- **Source**: [backend/routes/orders.js#L1627-L1651](../../../backend/routes/orders.js#L1627-L1651)

### `GET /api/sync/status`

- **Auth**: `requirePermission('dashboard', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "channels": { "ebay": {...}, "kaufland": {...} }, "reservations": { "count": <int>, "totalQuantity": <int> }, "summary": { "totalSyncs": <int>, "totalErrors": <int>, "since": "..." }, "generatedAt": "..." } }`
- **Side-Effects**: read auf `stock_sync_log` (last 24h, max 500) + `stock_reservations`.
- **Source**: [backend/routes/orders.js#L838-L903](../../../backend/routes/orders.js#L838-L903)

---

## Dashboard

### `GET /api/dashboard/metrics`

- **Auth**: `requirePermission('dashboard', 'read')`
- **Tenant Source**: JWT (Filter über orders implicit nicht — verify in code)
- **Request**: Query `?days=7&preset=...&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD`. `days` 1–60.
- **Response**: `{ "ok": true, "data": { "range": {...}, "orders": { "returns_total": <int>, "returns_ytd": <int> }, "revenue": { "all_non_cancelled_total": <eur>, "ebay_net_window": <eur>, "ebay_net_ytd": <eur>, "payout_brutto_window": <eur>, "payout_brutto_ytd": <eur>, "payout_source": "ebay_finances" | "estimated", ... }, "returns": { "total": {...}, "ytd": {...}, "window": {...} } } }`
- **Side-Effects**:
  - Background-Sync Trigger.
  - Holt Returns aus `returns`-Collection und subtrahiert von revenue.
  - eBay Finances API (`getEbayNetRevenueSummary`) für Net-Payout — silently skipped wenn `sell.finances`-Scope fehlt.
  - Fallback-Schätzung eBay-Payout: `gross × (1 - 0.25)`.
  - ETag-Support, 30 s Cache-Control.
- **Source**: [backend/routes/orders.js#L120-L285](../../../backend/routes/orders.js#L120-L285)

### `GET /api/dashboard/finance`

- **Auth**: `requirePermission('dashboard', 'read')`
- **Tenant Source**: JWT
- **Request**: Query — TBD - verify in code (kann von/bis Date sein, ähnlich metrics).
- **Response**: `{ "ok": true, "data": { /* SevDesk Bankkonto-Balances + SendCloud Versandkosten */ } }`
- **Side-Effects**: SevDesk + SendCloud API-Calls.
- **Source**: [backend/routes/orders.js#L290-L535](../../../backend/routes/orders.js#L290-L535)

### `GET /api/dashboard/activity`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: Query `?limit=50`
- **Response**: `{ "ok": true, "data": [{ "timestamp": "...", "type": "...", "title": "..." }] }`
- **Side-Effects**: Aggregiert aktuelle Order-Events.
- **Source**: [backend/routes/orders.js#L538-L609](../../../backend/routes/orders.js#L538-L609)

---

## Order-Settings

### `GET /api/orders/settings`
### `PUT /api/orders/settings`

- **Auth**: requireAuth (kein `requirePermission`)
- **Tenant Source**: JWT
- **Request (PUT)**: `{ "rules": [...], "statuses": [...], "numberRanges": {...}, "templates": {...}, "carrierRules": [{ "minWeight": 0, "maxWeight": 31.5, "shippingMethodId": 89, "carrier": "DHL", "order": 0 }] }`
- **Response**: `{ "ok": true, "data": {...gespeicherte Felder} }`
- **Side-Effects**:
  - PUT: merge auf `order_settings/{tenantId}`.
  - Validation: `carrierRules` muss Array sein, jede Rule braucht `maxWeight`, `shippingMethodId`, `carrier`.
- **Failure Modes**: `400 { code: 'INVALID_INPUT' }`.
- **Source**: [backend/routes/orders.js#L716-L772](../../../backend/routes/orders.js#L716-L772)

---

## Shipments

### `GET /api/shipments`
### `POST /api/shipments`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request (POST)**: `{ "orderId": "...", "customer": {...}, "carrier": "DHL", "trackingNumber": "...", "cost": 4.99 }`
- **Response**: GET `{ "ok": true, "data": [...] }`. POST `{ "ok": true, "data": { "id": "...", ... } }`.
- **Side-Effects**:
  - GET: read `shipments where tenantId == default` + Enrichment mit `lookupCsvPrice` falls cost fehlt.
  - POST: Write Shipment-Doc.
- **Source**:
  - [backend/routes/orders.js#L776-L808](../../../backend/routes/orders.js#L776-L808)
  - [backend/routes/orders.js#L810-L834](../../../backend/routes/orders.js#L810-L834)

---

## Shipping (SendCloud)

### `GET /api/shipping-methods`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: Query `?weight=...&country=DE`
- **Response**: `{ "ok": true, "data": [...] }` (gefiltert nach Weight+Country)
- **Side-Effects**: `getCachedShippingMethods()`.
- **Source**: [backend/routes/orders.js#L1134-L1148](../../../backend/routes/orders.js#L1134-L1148)

### `POST /api/shipping-methods/sync`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [...], "syncedAt": "..." }`
- **Side-Effects**: `syncShippingMethods(tenantId, { force: true })`.
- **Source**: [backend/routes/orders.js#L1153-L1163](../../../backend/routes/orders.js#L1153-L1163)

### `GET /api/shipping/methods`

Aliased read-only Endpoint — liefert `getShippingMethods()` direkt (ohne Caching/Filter). 

- **Auth**: `requirePermission('orders', 'read')`
- **Source**: [backend/routes/orders.js#L1592-L1601](../../../backend/routes/orders.js#L1592-L1601)

### `GET /api/orders/:orderId/shipping-preview`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "weight": { "value": 1.2, "origin": "order|items|...", ... }, "matchingRules": [...], "hasUsableAddress": <bool> } }`
- **Side-Effects**: read-only. Liefert Diagnose-Info für Pack/Ship-Flow.
- **Failure Modes**: `404`.
- **Source**: [backend/routes/orders.js#L1181-L1250](../../../backend/routes/orders.js#L1181-L1250)

### `POST /api/orders/:orderId/ship`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "shippingMethodId": <int>, "weight": 1.2, "labelFormat": "a4" | "a6" }`. Default `a6`.
- **Response**:
  ```json
  { "ok": true, "data": { "trackingNumber": "...", "labelUrl": "...", "carrier": "DHL", "marketplacePush": { "ok": true } } }
  ```
- **Side-Effects**:
  - `shipOrder()` aus shipping-engine — erzeugt SendCloud-Parcel + Label.
  - `transitionOrder({ toStatus: 'shipped' })`.
  - `pushTrackingToMarketplace()` (synchron).
  - Emit `order:status_changed` + `shipment:created`.
- **Idempotency**: NICHT idempotent (erzeugt neues Parcel).
- **Failure Modes**: `500`.
- **Source**: [backend/routes/orders.js#L1251-L1317](../../../backend/routes/orders.js#L1251-L1317)

### `POST /api/orders/:orderId/refresh-shipment`

Self-heal — pulled SendCloud-Parcel by `sendcloudParcelId`, writeback non-empty fields. Idempotent.

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "labelFormat": "a4" | "a6" }`
- **Response**: `{ "ok": true, "data": { "updated": [...], "trackingNumber": "...", "marketplacePush": {...} } }`
- **Side-Effects**: `refreshShipmentFromSendCloud()`; bei neuer Tracking-Nummer Marketplace-Push.
- **Failure Modes**: `404 { code: 'NOT_FOUND' }` bei „Kein Versand|Parcel.*konnte nicht"-Patterns; `500`.
- **Source**: [backend/routes/orders.js#L1331-L1365](../../../backend/routes/orders.js#L1331-L1365)

### `POST /api/orders/:orderId/cancel-label`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "message": "Label storniert..." } }`
- **Side-Effects**:
  - `cancelParcel({ parcelId, tenantId })` in SendCloud (Best-effort).
  - Shipment-Doc → `status: 'cancelled'`.
  - Order-Doc: Tracking-Felder auf null gesetzt.
  - `transitionOrder({ toStatus: 'packed', force: true })`.
  - Emit `order:status_changed` + `shipment:updated`.
- **Failure Modes**: `404` ohne Shipment, `400` ohne `sendcloudParcelId`.
- **Source**: [backend/routes/orders.js#L1370-L1441](../../../backend/routes/orders.js#L1370-L1441)

### `POST /api/orders/:orderId/tracking`

Manuelles Tracking-Setzen (z.B. wenn Versand außerhalb SendCloud).

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "trackingNumber": "...", "carrier": "DHL", "trackingUrl": "https://..." }`
- **Response**: `{ "ok": true, "data": { "trackingNumber": "...", "message": "..." } }`
- **Side-Effects**:
  - Order-Doc Update mit Tracking.
  - Shipment-Doc upsert (`source: 'manual'`).
  - Transition zu `shipped` falls noch nicht in `shipped|delivered|completed|cancelled`.
  - `pushTrackingToMarketplace` Best-effort.
- **Failure Modes**: `400 { code: 'BAD_REQUEST' }`, `404`.
- **Source**: [backend/routes/orders.js#L1447-L1537](../../../backend/routes/orders.js#L1447-L1537)

### `POST /api/orders/bulk-ship`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "orderIds": [...], "shippingMethodId": <int>, "labelFormat": "a4|a6" }`. Max 50.
- **Response**: `{ "ok": true, "data": { "total": 50, "success": 48, "results": [{ "orderId": "...", "ok": true, "trackingNumber": "...", "labelUrl": "..." }] } }`
- **Side-Effects**: per-order `shipOrder` + `transitionOrder` + fire-and-forget tracking-push.
- **Failure Modes**: per-order errors gesammelt; Bulk-400 für leere/zu große Arrays.
- **Source**: [backend/routes/orders.js#L1657-L1706](../../../backend/routes/orders.js#L1657-L1706)

---

## Labels

### `GET /api/orders/:orderId/label`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: implicit
- **Request**: Query `?format=a4|a6` (default `a6`)
- **Response**: `application/pdf` (PDF-Buffer). Header `Content-Disposition: inline; filename="label-<orderId>.pdf"`.
- **Side-Effects**: ruft SendCloud `getLabel({ parcelId, labelFormat })` ab und proxied das PDF.
- **Failure Modes**: `404 { code: 'NOT_FOUND' | 'NO_LABEL' }`.
- **Source**: [backend/routes/orders.js#L1856-L1900](../../../backend/routes/orders.js#L1856-L1900)

### `POST /api/orders/address-labels`

Adresslabels (62×29 mm, Dymo/Brother-format).

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: implicit
- **Request**: `{ "orderIds": [...] }`. Max 100.
- **Response**: `text/html; charset=utf-8` Label-Sheet.
- **Side-Effects**: read.
- **Failure Modes**:
  - `400 { code: 'INVALID_INPUT' }` für leeres oder zu großes Array.
  - `400 { code: 'INCOMPLETE_ADDRESS', incomplete: [...] }` wenn Adresse fehlt.
- **Source**: [backend/routes/orders.js#L1904-L1964](../../../backend/routes/orders.js#L1904-L1964)

---

## Invoices (Per-Order)

### `POST /api/orders/:orderId/invoice`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "vatRate": 0 | 0.07 | 0.19 }` (optional)
- **Response**: `{ "ok": true, "data": { "invoiceId": "...", "invoiceNumber": "...", "pdfUrl": "gs://..." } }`
- **Side-Effects**: schreibt `vatRate` falls valid, ruft `generateInvoice({ orderId, tenantId, actor })`.
- **Source**: [backend/routes/orders.js#L1542-L1569](../../../backend/routes/orders.js#L1542-L1569)

### `POST /api/orders/:orderId/delivery-note`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": {...deliveryNoteResult} }`
- **Side-Effects**: `generateDeliveryNote({ orderId, tenantId })`.
- **Source**: [backend/routes/orders.js#L1574-L1587](../../../backend/routes/orders.js#L1574-L1587)

### `POST /api/invoices/:invoiceId/export-sevdesk`

⚠️ Liegt im ordersRouter, NICHT im invoicesRouter.

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: implicit
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": {...} }` oder `400 { code: 'SEVDESK_EXPORT_FAILED' }`.
- **Side-Effects**: `exportToSevDesk({ invoiceId })`.
- **Source**: [backend/routes/orders.js#L1606-L1621](../../../backend/routes/orders.js#L1606-L1621)

---

## Background-Jobs (aus index.js)

- `backgroundSyncOrders()` — 10 s nach Boot + alle 6 h (`ORDER_SYNC_INTERVAL_MS`), Throttle 60 s.
- `runSendCloudSync` alle 6 h.
- `runTrackingCatchup` alle 2 h (retry failed marketplace pushes).
- `runDeliveryPoll` alle 2 h (delivery status polling).
- `runInvoiceSync` täglich.
- `runRefundPush` alle 4 h.

## Verwandt

- [returns.md](returns.md), [invoices.md](invoices.md), [marketplace.md](marketplace.md), [webhooks.md](webhooks.md).
- CLAUDE.md Punkt 11 — kein `omsStatus`-Direct-Write außerhalb von `transitionOrder()`.
