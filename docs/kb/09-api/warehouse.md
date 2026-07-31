---
title: API — Warehouse
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Warehouse

Mount: `app.use('/api/warehouse', warehouseRouter)` ([backend/index.js#L242](../../../backend/index.js#L242)). Globale `requireAuth` greift.

Quelle: [backend/routes/warehouse.js](../../../backend/routes/warehouse.js). Core-Library: [backend/lib/warehouse.js](../../../backend/lib/warehouse.js). Label-Printer: [backend/services/label-printer.js](../../../backend/services/label-printer.js).

Tenant-Source: für CRUD und Zone-Operations ohne Tenant-Scope (read global). Für Settings/Inventories: `req.user?.tenantId || 'default'`.

Permissions:
- Read: `requirePermission('warehouse', 'read')`
- Write: `requirePermission('warehouse', 'write')`
- Inventory-Read/Write benutzt `requirePermission('warehouse', '...')` für die unter `/warehouse/inventories/*`-Routes.

---

## Zones & Layouts

### `GET /api/warehouse/zones`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Tenant Source**: none — global
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [{ "zone": "Z01", "etage": "EG", "gangs": [...], "regale": [...], "ebenen": [...] }] }`
- **Side-Effects**: read.
- **Idempotency**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/warehouse.js#L102-L113](../../../backend/routes/warehouse.js#L102-L113)

### `POST /api/warehouse/layouts`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: none
- **Request**:
  ```json
  { "zone": "Z01", "etage": "EG", "gangs": [1,2,3], "regale": [1,2], "ebenen": ["A","B","C"] }
  ```
- **Response**: `{ "ok": true, "data": { ...createdLayout } }`
- **Side-Effects**: Bulk-Insert von BIN-Codes (`zone-etage-gang-regal-ebene`-Permutationen).
- **Idempotency**: idempotent (engine prüft Existenz).
- **Failure Modes**: `400` bei fehlenden Pflichtfeldern.
- **Source**: [backend/routes/warehouse.js#L115-L139](../../../backend/routes/warehouse.js#L115-L139)

### `DELETE /api/warehouse/layouts/:zone/:etage/gangs/:gang`
### `DELETE /api/warehouse/layouts/:zone/:etage/gangs/:gang/regale/:regal`
### `DELETE /api/warehouse/layouts/:zone/:etage/gangs/:gang/regale/:regal/ebenen/:ebene`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: none
- **Request**: Query `?dryRun=true|?confirm=true` — **default ist dryRun**. Erst mit `?confirm=true` wird tatsächlich gelöscht (`!parseTruthy(req.query?.confirm)` wird zu `dryRun=true`).
- **Response**: `{ "ok": true, "data": { ...counts, "dryRun": true|false } }`
- **Side-Effects**: löscht/zeigt BIN-Hierarchie für Gang/Regal/Ebene.
- **Idempotency**: idempotent.
- **Failure Modes**: `400` mit lesbarer engine-Fehlermeldung.
- **Source**:
  - [backend/routes/warehouse.js#L141-L157](../../../backend/routes/warehouse.js#L141-L157)
  - [backend/routes/warehouse.js#L159-L176](../../../backend/routes/warehouse.js#L159-L176)
  - [backend/routes/warehouse.js#L178-L196](../../../backend/routes/warehouse.js#L178-L196)

### `GET /api/warehouse/zones/:zone/:etage`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Tenant Source**: none
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [{ "code": "Z01-EG-1-1-A", "productCount": 3, "products": [...], "gang": 1, "regal": 1, "ebene": "A" }] }`
- **Side-Effects**: read.
- **Source**: [backend/routes/warehouse.js#L198-L211](../../../backend/routes/warehouse.js#L198-L211)

---

## Los-Struktur (L-/NL-Lose)

Lose sind die Einkaufs-Zugehörigkeit von Ware (`ops.sourceLot` am Produkt) — kein Lagerplatz, kein Bestand. Collection `warehouse_lots` (Doc-ID = Los-Code, mit `tenantId`). Formate: `L-MMYYNN` (Auktions-Los, Nummer 01–200 je Monat) und `NL-MMYY` (Non-Los, eins pro Monat). Lib: [backend/lib/warehouse-lots.js](../../../backend/lib/warehouse-lots.js).

### `GET /api/warehouse/lots`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Response**: `{ "ok": true, "data": [ { "code", "type", "month", "year", "number", "ekBrutto", "note", "productCount", ... } ] }` — `productCount` via Firestore-`count()` über `ops.sourceLot`.

### `POST /api/warehouse/lots`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Request**: `{ "type": "L"|"NL", "month": 7, "year": 2026, "numbers": "12" | "1-38" }` (`numbers` nur bei `L`)
- **Response**: `{ "ok": true, "data": { "created": [...], "skipped": [...] } }` — existierende Codes werden übersprungen (idempotent).

### `PATCH /api/warehouse/lots/:code`

- **Auth**: `warehouse write`. Body: `{ "ekBrutto": 14000 | null, "note": "..." | null }` — EK brutto wird am Los gepflegt (Einkaufspreis-Auswertung je Los).

### `DELETE /api/warehouse/lots/:code`

- **Auth**: `warehouse write`. Fail-closed: `400`, wenn dem Los noch Produkte zugeordnet sind.

### `GET /api/warehouse/lots/labels` / `GET /api/warehouse/lots/labels.pdf`

- **Auth**: `warehouse read`. `?codes=L-072612&codes=NL-0726` → gleiche Label-Pipeline wie BIN-Labels (62×29 mm, QR = roher Los-Code; HTML self-print bzw. PDF).

## BIN-Labels (Print)

Diese Routes liefern HTML/PDF zum Direktdruck und **müssen vor** `/bins/:code` definiert sein, damit Express nicht `labels` als `:code` matched.

### `GET /api/warehouse/bins/labels`
### `POST /api/warehouse/bins/labels`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Tenant Source**: none
- **Request** (Query oder Body): `?codes=A1,A2,A3` ODER `?zone=Z01&etage=EG&gang=1&regal=1`. Filter werden kombiniert.
- **Response**: `text/html; charset=utf-8` Label-Sheet zum Drucken.
- **Side-Effects**: read + HTML-Render.
- **Idempotency**: read.
- **Failure Modes**: `400 { code: 400, message: 'Keine BIN-Codes gefunden.' }`. `500`.
- **Source**: [backend/routes/warehouse.js#L214-L252](../../../backend/routes/warehouse.js#L214-L252)

### `GET /api/warehouse/bins/labels.pdf`
### `POST /api/warehouse/bins/labels.pdf`

Wie oben, aber `application/pdf`. Header: `Content-Disposition: inline; filename="bin-labels.pdf"`.

- **Source**: [backend/routes/warehouse.js#L254-L292](../../../backend/routes/warehouse.js#L254-L292)

### `GET /api/warehouse/bins/:code/label`

Single-BIN-Label als HTML (62×29mm).

- **Auth**: `requirePermission('warehouse', 'read')`
- **Response**: `text/html; charset=utf-8`. Berücksichtigt `parentBinCode` (Container-Label).
- **Failure Modes**: `400` bei leerem Code; trotzdem `200 HTML` auch wenn BIN nicht existiert (Warning-Log).
- **Source**: [backend/routes/warehouse.js#L311-L333](../../../backend/routes/warehouse.js#L311-L333)

---

## BIN-CRUD

### `GET /api/warehouse/bins/:code`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Tenant Source**: none
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "code": "Z01-EG-1-1-A", "products": [{"productId": "...", "quantity": 5}], "parentBinCode": "...", ... } }`
- **Side-Effects**: read.
- **Failure Modes**: `404` wenn nicht gefunden.
- **Source**: [backend/routes/warehouse.js#L294-L309](../../../backend/routes/warehouse.js#L294-L309)

### `POST /api/warehouse/bins/:code/assign`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: none
- **Request**: `{ "productId": "...", "quantity": 1 }`
- **Response**: `{ "ok": true, "data": { "bin": {...}, "product": {...} } }`
- **Side-Effects**: `assignProductToBin(code, productId, qty)` schreibt BIN-Allocation. Liefert aktualisiertes Produkt zurück.
- **Idempotency**: TBD - verify in code, ob doppelte Assigns Quantity addieren oder ersetzen.
- **Failure Modes**: `400 { code: 400 }` mit lesbarer engine-Message.
- **Source**: [backend/routes/warehouse.js#L335-L352](../../../backend/routes/warehouse.js#L335-L352)

### `DELETE /api/warehouse/bins/:code/products/:productId`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: none
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: `removeProductFromBin(code, productId)`.
- **Idempotency**: idempotent.
- **Failure Modes**: `400`.
- **Source**: [backend/routes/warehouse.js#L354-L367](../../../backend/routes/warehouse.js#L354-L367)

### `GET /api/warehouse/bins/:code/containers`
### `POST /api/warehouse/bins/:code/containers`
### `DELETE /api/warehouse/bins/:code/containers/:childCode`

Child-BIN (Container) Management. Parent-Child-Relation zwischen BINs (z.B. eine Palette enthält Kartons).

- **Auth**: `requirePermission('warehouse', 'read'/'write')`.
- **Tenant Source**: none.
- **Request (POST)**: `{ /* child bin payload */ }` — siehe `createChildBin` Signatur.
- **Response**: `{ "ok": true, "data": ... }` (POST: `201`).
- **Side-Effects**: Firestore-Mutationen auf BIN-Hierarchie.
- **Failure Modes**: `400 { code: 'BAD_REQUEST' }`.
- **Source**:
  - [backend/routes/warehouse.js#L371-L380](../../../backend/routes/warehouse.js#L371-L380)
  - [backend/routes/warehouse.js#L382-L391](../../../backend/routes/warehouse.js#L382-L391)
  - [backend/routes/warehouse.js#L393-L402](../../../backend/routes/warehouse.js#L393-L402)

---

## Stock-Buchungen

### `POST /api/warehouse/stock-in`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: JWT (für Stock-Sync-Dispatcher)
- **Request**:
  ```json
  {
    "sku": "SKU-...",
    "productId": "...",
    "barcode": "EAN13...",
    "binCode": "Z01-EG-1-1-A",
    "quantity": 5,
    "lotCode": "L-072612",
    "meta": { "...": "..." }
  }
  ```
  `sku`/`productId`/`barcode` müssen einen davon liefern. `binCode` Pflicht. `quantity` > 0.
- **Response**: `{ "ok": true, "data": { "product": {...}, "bin": {...}, "movement": {...} } }`
- **Side-Effects**:
  - `bookStockIn()` ([lib/warehouse.js](../../../backend/lib/warehouse.js)) — schreibt BIN-Allocation + `warehouseEvents`-Doc + `products_v2.inventory.quantity` += amount.
  - **Multi-Channel Stock-Push**: fire-and-forget `syncStockWithRetry({ tenantId, product, reason: 'stock-in' })` an eBay + Kaufland.
- **Idempotency**: nicht idempotent.
- **Failure Modes**: `400 { code: 400 }`.
- **Source**: [backend/routes/warehouse.js#L404-L442](../../../backend/routes/warehouse.js#L404-L442)

### `POST /api/warehouse/stock-out`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: JWT
- **Request**: wie stock-in, zusätzlich `orderId` und `orderItemId` (optional — Pick-with-Order Pfad).
- **Response**: `{ "ok": true, "data": { ...result } }`
- **Side-Effects**:
  - `bookStockOut()` mit `meta.orderId` ⇒ schreibt **Stock-Decrement-Marker** auf `orders/{orderId}.stockDecrementedAt + stockDecrementedBy='pick' + stockDecrementedSkus=[…]` via `claimOrderStockDecrementInTx()` (CLAUDE.md Punkt 13).
  - Multi-Channel Stock-Push fire-and-forget.
- **Idempotency**: NICHT idempotent (echter Decrement).
- **Failure Modes**: `400`.
- **Source**: [backend/routes/warehouse.js#L444-L491](../../../backend/routes/warehouse.js#L444-L491)

### `POST /api/warehouse/refresh-inventory`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: none
- **Request**: `{ "productId": "...", "sku": "...", "barcode": "..." }` — einer reicht.
- **Response**: `{ "ok": true, "data": { "product": {...} } }`
- **Side-Effects**: `refreshProductInventory(productId)` — rekalkuliert `products_v2.inventory.quantity` aus Summe der BIN-Allocations.
- **Idempotency**: idempotent.
- **Failure Modes**: `400`, `500`.
- **Source**: [backend/routes/warehouse.js#L493-L516](../../../backend/routes/warehouse.js#L493-L516)

---

## Warehouse-Settings

### `GET /api/warehouse/settings`
### `PUT /api/warehouse/settings`

- **Auth**: requireAuth (kein `requirePermission`)
- **Tenant Source**: JWT
- **Request (PUT)**: beliebige Felder (whitelisted: `zones`, `bins`, sonst durchgereicht).
- **Response**: `{ "ok": true, "data": {...} }`
- **Side-Effects**: merge auf `warehouse_settings/{tenantId}`.
- **Source**:
  - [backend/routes/warehouse.js#L526-L536](../../../backend/routes/warehouse.js#L526-L536)
  - [backend/routes/warehouse.js#L538-L553](../../../backend/routes/warehouse.js#L538-L553)

---

## Movements (Bewegungen)

### `GET /api/warehouse/movements`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Tenant Source**: none (Collection `warehouseEvents` global)
- **Request**: Query `?type=&binCode=&productId=&from=&to=&limit=50&offset=0`. `limit` max 200.
- **Response**:
  ```json
  {
    "ok": true,
    "movements": [{ "id": "...", "type": "stock-in|stock-out", "binCode": "...", "productId": "...", "quantity": 5, "createdAt": "..." }],
    "total": <int>,
    "hasMore": <bool>
  }
  ```
- **Side-Effects**: read auf `warehouseEvents`.
- **Idempotency**: read.
- **Failure Modes**: `500`. Date-Range + andere Filter benötigen evtl. Composite-Indexes (`warehouseEvents: (type, createdAt DESC)`, etc.).
- **Source**: [backend/routes/warehouse.js#L557-L602](../../../backend/routes/warehouse.js#L557-L602)

⚠️ Response-Shape verwendet `movements` als Top-Level statt `data` — siehe [conventions.md](conventions.md#standard-antwort-shape).

---

## Inventories (Inventur-Zyklen)

Collection: `warehouse_inventories`.

### `GET /api/warehouse/inventories`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "inventories": [{ "id": "...", "name": "...", "status": "active|completed", "scope": "full|zone", "summary": {...} }] }` (max 50, ohne `counts`)
- **Side-Effects**: read `warehouse_inventories where tenantId == default ORDER BY createdAt DESC LIMIT 50`. Composite-Index erforderlich.
- **Source**: [backend/routes/warehouse.js#L609-L635](../../../backend/routes/warehouse.js#L609-L635)

### `GET /api/warehouse/inventories/:id`

- **Auth**: `requirePermission('warehouse', 'read')`
- **Tenant Source**: implicit über Doc
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "inventory": { "id": "...", "counts": [...], "summary": {...} } }` (Full incl. counts)
- **Side-Effects**: read.
- **Failure Modes**: `404 { code: 'NOT_FOUND' }`.
- **Source**: [backend/routes/warehouse.js#L638-L658](../../../backend/routes/warehouse.js#L638-L658)

### `POST /api/warehouse/inventories`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "name": "Q2 2026", "scope": "full" | "zone", "zoneFilter": "Z01" }`
- **Response**: `{ "ok": true, "inventory": { "id": "...", "counts": [...], "summary": {...}, "status": "active" } }`
- **Side-Effects**: aggregiert alle aktuellen BIN-Allocations in `counts[]`, schreibt nach `warehouse_inventories`.
- **Idempotency**: none.
- **Failure Modes**: `400 { code: 'INVALID' }` bei zu kurzem Namen.
- **Source**: [backend/routes/warehouse.js#L661-L732](../../../backend/routes/warehouse.js#L661-L732)

### `POST /api/warehouse/inventories/:id/counts`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: implicit über Doc
- **Request**:
  ```json
  { "counts": [{ "binCode": "...", "productId": "...", "countedQty": 4 }] }
  ```
- **Response**: `{ "ok": true, "countedItems": <int>, "totalVariance": <int> }`
- **Side-Effects**:
  - Merge der Counts ins bestehende Doc; berechnet `variance = countedQty - systemQty` pro Eintrag.
  - Updates `summary`-Sub-Objekt.
- **Idempotency**: idempotent (überschreibt countedQty pro Eintrag).
- **Failure Modes**:
  - `404 { code: 'NOT_FOUND' }`.
  - `400 { code: 'COMPLETED' }` wenn schon abgeschlossen.
  - `400 { code: 'INVALID' }` bei leerem `counts`.
- **Source**: [backend/routes/warehouse.js#L735-L786](../../../backend/routes/warehouse.js#L735-L786)

### `POST /api/warehouse/inventories/:id/complete`

- **Auth**: `requirePermission('warehouse', 'write')`
- **Tenant Source**: implicit
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "variances": [...], "totalVariance": <int> }`
- **Side-Effects**: setzt `status: 'completed'` + `completedAt`. **Mutiert KEIN Produkt-Inventory** — Variance-Bereinigung muss separat über `/stock-in`/`/stock-out` erfolgen (TBD - verify in code).
- **Idempotency**: einmalig (zweiter Aufruf liefert `400 { code: 'COMPLETED' }`).
- **Source**: [backend/routes/warehouse.js#L789-L823](../../../backend/routes/warehouse.js#L789-L823)

---

## Hintergrund-Cron-Jobs

Aus [backend/index.js](../../../backend/index.js):

- `expireStaleReservations()` alle 5 min ([backend/index.js#L454-L472](../../../backend/index.js#L454-L472)).
- `reconcileRecentActivity()` + täglich 3 AM `reconcileFullScan()` ([backend/index.js#L474-L506](../../../backend/index.js#L474-L506)).
- `drainStockFailures()` alle 2 min ([backend/index.js#L508-L532](../../../backend/index.js#L508-L532)).

## Verwandt

- [products.md](products.md) — `/api/products/:id/bins`, `/api/products/:id/inventory`.
- CLAUDE.md Punkt 13 — Stock Single Writer Invariant.
