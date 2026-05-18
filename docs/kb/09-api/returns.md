---
title: API — Returns
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Returns

Mount: `app.use('/api', returnsRouter)` ([backend/index.js#L250](../../../backend/index.js#L250)). Alle Routen erfordern `requireAuth` über die globale Middleware. **Keine** zusätzlichen `requirePermission`-Checks im Router (verify in code: ist das Absicht? — alle Order-Module verlangen sonst RBAC).

Quelle: [backend/routes/returns.js](../../../backend/routes/returns.js). Engine: [backend/services/returns-engine.js](../../../backend/services/returns-engine.js).

Tenant-Source pro Endpoint: `req.user?.tenantId || 'default'`.

---

### `GET /api/returns`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: Query `?status=<key>&limit=100`
- **Response**:
  ```json
  { "ok": true, "data": [{ "id": "...", "tenantId": "default", "orderId": "...", "status": "eingegangen", ... }] }
  ```
- **Side-Effects**: read-only
- **Idempotency**: read
- **Failure Modes**: `500 { code: 'INTERNAL' }`
- **Source**: [backend/routes/returns.js#L18-L33](../../../backend/routes/returns.js#L18-L33)

---

### `GET /api/returns/reasons`

- **Auth**: requireAuth
- **Tenant Source**: none (statisch)
- **Request**: `(empty)`
- **Response**:
  ```json
  { "ok": true, "data": [{ "key": "meinungsaenderung", "label": "Meinungsänderung", "refundDefault": "full" }] }
  ```
- **Side-Effects**: keine — liefert `RETURN_REASONS`-Konstante aus `services/returns-engine.js`.
- **Idempotency**: read
- **Failure Modes**: `500` bei Modul-Load-Fehler.
- **Source**: [backend/routes/returns.js#L39-L47](../../../backend/routes/returns.js#L39-L47)

---

### `POST /api/returns`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "orderId": "...", "customer": {...}, "product": {...}, "reason": "meinungsaenderung", "refundAmount": 0 }
  ```
- **Response**:
  ```json
  { "ok": true, "data": { "id": "...", "tenantId": "default", "status": "eingegangen", ... } }
  ```
- **Side-Effects**:
  - Schreibt nach `returns/{auto-id}` mit `createdBy: req.user.uid`, `status: 'eingegangen'`.
  - Emit `return:created` Sync-Event (source: `api:manual-return`).
- **Idempotency**: none (jeder Call erzeugt ein neues Return-Doc).
- **Failure Modes**:
  - `400 { code: 'VALIDATION' }` wenn `orderId` fehlt.
  - `500 { code: 'INTERNAL' }`.
- **Source**: [backend/routes/returns.js#L53-L81](../../../backend/routes/returns.js#L53-L81)

---

### `POST /api/returns/sync`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: Query `?days=30`
- **Response**:
  ```json
  { "ok": true, "data": { "synced": 12, "skipped": 3, ... } }
  ```
- **Side-Effects**: `syncAllReturns({ tenantId, lookbackDays })` → polled eBay + Kaufland für neue Returns, upsertet `returns`-Collection.
- **Idempotency**: ja (dedupliziert nach Marketplace-Return-ID).
- **Failure Modes**: `500` bei Marketplace-API-Failure.
- **Source**: [backend/routes/returns.js#L87-L99](../../../backend/routes/returns.js#L87-L99)

Route muss vor `:id`-Routes liegen (sonst greift Express `sync` als `:id`).

---

### `POST /api/returns/bulk-action`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "returnIds": ["..."], "action": "refund" | "close", "note": "optional" }
  ```
- **Response**:
  ```json
  { "ok": true, "data": { "total": 5, "success": 4, "results": [{ "returnId": "...", "ok": true }, { "returnId": "...", "ok": false, "error": "..." }] } }
  ```
- **Side-Effects**:
  - Pro Return: `issueMarketplaceRefund` oder `transitionReturn({ toStatus: 'abgeschlossen' })`.
  - Emit `return:status_changed` für jeden erfolgreichen Übergang.
- **Idempotency**: per-Return idempotent (engine handhabt „already refunded"-Fälle).
- **Failure Modes**:
  - `400` wenn `returnIds` leer oder > 50.
  - `400` wenn `action` nicht in `['refund','close']`.
- **Source**: [backend/routes/returns.js#L106-L145](../../../backend/routes/returns.js#L106-L145)

---

### `PATCH /api/returns/:id`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "status": "in_pruefung" | "...", "refundAmount": 12.50, "reason": "defekt", "note": "..." }
  ```
- **Response**:
  ```json
  { "ok": true, "data": { ...transitionResult oder ...updatedFields } }
  ```
- **Side-Effects**:
  - Mit `status`: `transitionReturn()` via Workflow-Engine + emit `return:status_changed`.
  - Ohne `status`: Direct-Update der erlaubten Felder.
- **Idempotency**: idempotent (engine ist gegen Doppel-Transitions robust).
- **Failure Modes**: `500` bei Engine-Failure oder ungültiger State-Transition.
- **Source**: [backend/routes/returns.js#L151-L184](../../../backend/routes/returns.js#L151-L184)

---

### `POST /api/returns/:id/process`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "itemCondition": "a_ware" | "b_ware" | "c_ware", "refundType": "full" | "partial" | "none", "refundAmount": 12.50, "note": "..." }
  ```
- **Response**: `{ "ok": true, "data": { ...processReturnResult } }` mit `status`-Feld.
- **Side-Effects**:
  - `processReturn()` aus engine: Inspektion, Restock falls passend, Refund-Buchung, Status-Update.
  - Emit `return:status_changed`.
- **Idempotency**: nicht idempotent — mehrfaches Process kann doppelt restocken (engine-Logik prüft TBD - verify in code).
- **Failure Modes**: `400` bei fehlenden Pflichtfeldern.
- **Source**: [backend/routes/returns.js#L190-L218](../../../backend/routes/returns.js#L190-L218)

---

### `POST /api/returns/:id/refund`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { ...refundResult } }`
- **Side-Effects**: `issueMarketplaceRefund()` → eBay/Kaufland-Refund-API + Status auf `refunded`. Emit `return:status_changed` source `api:refund`.
- **Idempotency**: ja (engine prüft `alreadyRefunded`).
- **Failure Modes**: `400 { code: 'REFUND_FAILED' }` wenn engine `ok: false` zurückgibt.
- **Source**: [backend/routes/returns.js#L223-L247](../../../backend/routes/returns.js#L223-L247)

---

### `POST /api/returns/:id/close`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `{ "note": "optional" }`
- **Response**: `{ "ok": true, "data": { ...transitionResult } }`
- **Side-Effects**: `transitionReturn({ toStatus: 'abgeschlossen' })` + emit `return:status_changed`.
- **Idempotency**: idempotent.
- **Failure Modes**: `500` bei Workflow-Fehler.
- **Source**: [backend/routes/returns.js#L252-L273](../../../backend/routes/returns.js#L252-L273)

---

### `GET /api/returns/:id/events`

- **Auth**: requireAuth
- **Tenant Source**: implizit über Return-ID (kein Tenant-Filter im Query — TBD - verify in code, ob Cross-Tenant-Lookup möglich)
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [{ "id": "...", "returnId": "...", "type": "...", "timestamp": "..." }] }`
- **Side-Effects**: read-only auf `return_events` collection.
- **Idempotency**: read.
- **Failure Modes**: `500` bei Firestore-Outage. **Erfordert composite-index** `return_events: (returnId ASC, timestamp ASC)`.
- **Source**: [backend/routes/returns.js#L278-L290](../../../backend/routes/returns.js#L278-L290)

---

## Hintergrund-Cron-Jobs

Aus [backend/index.js#L307-L321](../../../backend/index.js#L307-L321):

- `runReturnsSync()` alle 6 h (`RETURNS_SYNC_INTERVAL_MS`).
- `runRefundPush()` alle 4 h (`REFUND_PUSH_INTERVAL_MS`).

Beide laufen über `runForAllTenants` (siehe `BACKGROUND_JOB_TENANTS`-Flag in [conventions.md](conventions.md)).

## Verwandt

- [orders.md](orders.md) — Order-Lifecycle (Returns hängen an Orders).
- [webhooks.md](webhooks.md) — eBay/Kaufland-Return-Events triggern `return:created` Sync.
