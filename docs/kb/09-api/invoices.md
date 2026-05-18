---
title: API — Invoices
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Invoices

Mount: `app.use('/api', invoicesRouter)` ([backend/index.js#L251](../../../backend/index.js#L251)). Globale `requireAuth` greift.

Quelle: [backend/routes/invoices.js](../../../backend/routes/invoices.js). Engine: [backend/services/invoice-engine.js](../../../backend/services/invoice-engine.js).

Tenant-Source: `req.user?.tenantId || 'default'`.

Auch im `ordersRouter` definiert: `POST /api/invoices/:invoiceId/export-sevdesk` (siehe [orders.md](orders.md)).

---

### `GET /api/invoices`

- **Auth**: requireAuth (kein explizites `requirePermission`)
- **Tenant Source**: JWT
- **Request**: Query `?status=...&limit=2000`
- **Response**:
  ```json
  { "ok": true, "data": [{ "id": "...", "tenantId": "default", "invoiceNumber": "RE-2026-1234", "status": "entwurf", ... }] }
  ```
- **Side-Effects**: read-only
- **Idempotency**: read. Requires composite-index `invoices: (tenantId, status?, createdAt DESC)`.
- **Failure Modes**: `500 { code: 'INTERNAL' }`
- **Source**: [backend/routes/invoices.js#L15-L30](../../../backend/routes/invoices.js#L15-L30)

---

### `POST /api/invoices`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "orderId": "...", "customer": {...}, "invoiceNumber": "RE-2026-1234", "amountNet": 100, "amountGross": 119, "dueDate": "2026-06-01" }
  ```
- **Response**: `{ "ok": true, "data": { "id": "...", "status": "entwurf", "date": "2026-05-18", ... } }`
- **Side-Effects**: Firestore-Write nach `invoices/{auto-id}`. `invoiceNumber` wird wenn nicht mitgegeben automatisch generiert (`RE-<year>-<last4_of_timestamp>` — KEIN echter Sequenzgenerator, kann kollidieren). Für produktive Rechnungs-Nummern besser `generateInvoice` der Engine nutzen (siehe `/api/orders/:orderId/invoice` in [orders.md](orders.md)).
- **Idempotency**: none.
- **Failure Modes**: `400 { code: 'VALIDATION' }` ohne `orderId`. `500` bei Firestore-Fehler.
- **Source**: [backend/routes/invoices.js#L36-L60](../../../backend/routes/invoices.js#L36-L60)

---

### `PATCH /api/invoices/:id`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT (+ Tenant-Mismatch-Check)
- **Request**: `{ "status": "<entwurf|...>" }`
- **Response**: `{ "ok": true, "data": { "id": "...", "status": "..." } }`
- **Side-Effects**:
  - 404 wenn Doc nicht existiert.
  - 403 wenn `docData.tenantId !== tenantId`.
  - Backfill: setzt `tenantId` falls Legacy-Doc keinen hat (BUG-073).
- **Idempotency**: idempotent.
- **Failure Modes**: `400`, `403`, `404`, `500`.
- **Source**: [backend/routes/invoices.js#L66-L92](../../../backend/routes/invoices.js#L66-L92)

---

### `POST /api/invoices/import-sevdesk`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "imported": <n>, "matched": <n>, "skipped": <n> } }`
- **Side-Effects**: `importFromSevDesk({ tenantId })` aus engine — zieht alle SevDesk-Invoices, matched per Brutto ±€1 mit Orders, schreibt nach `invoices`.
- **Idempotency**: idempotent (skipped wenn schon importiert).
- **Failure Modes**: `500` bei SevDesk-API-Failure.
- **Source**: [backend/routes/invoices.js#L99-L109](../../../backend/routes/invoices.js#L99-L109)

---

### `POST /api/invoices/bulk-generate`

- **Auth**: `requirePermission('orders', 'write')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "generated": <n>, "skipped": <n>, "errors": [{ "orderId": "...", "error": "..." }] } }`
- **Side-Effects**:
  - Lookup `orders where tenantId == default AND omsStatus IN ('shipped','delivered','completed') AND !invoiceId`.
  - Pro Order: `generateInvoice({ orderId, tenantId, actor })` + fire-and-forget `exportToSevDesk` falls Invoice-PDF generiert. Batchgröße 5.
- **Idempotency**: ja — Orders mit `invoiceId` werden übersprungen.
- **Failure Modes**: einzelne Fehler werden in `errors[]` gesammelt; gesamt 500 nur bei Top-Level-Exception.
- **Source**: [backend/routes/invoices.js#L116-L174](../../../backend/routes/invoices.js#L116-L174)

Erfordert Firestore-Index pro Status: `orders: (tenantId, omsStatus)` (Single-Field reicht für jeden einzelnen Status; die Schleife macht drei separate Queries).

---

### `GET /api/invoices/:invoiceId/download`

- **Auth**: `requirePermission('orders', 'read')`
- **Tenant Source**: implizit über invoice-Doc (TBD - verify in code, ob ein Cross-Tenant-Lookup geblockt wird — der Code prüft `tenantId` hier nicht).
- **Request**: `(empty)`
- **Response**: `application/pdf` Stream — Header `Content-Disposition: inline; filename="Rechnung-<invoiceNumber>.pdf"`.
- **Side-Effects**: GCS-Read aus `<bucket>/<path>` (parsed aus `invoice.pdfUrl` = `gs://...`).
- **Idempotency**: read.
- **Failure Modes**:
  - `404 { code: 404, message: 'Invoice not found' | 'No PDF available for this invoice' }`.
  - `500 { code: 'INTERNAL' }`.
- **Source**: [backend/routes/invoices.js#L179-L208](../../../backend/routes/invoices.js#L179-L208)

---

## Hintergrund-Cron-Job

Aus [backend/index.js#L385-L404](../../../backend/index.js#L385-L404):

- `runInvoiceSync()` 5 min nach Boot und dann alle 24 h. Importiert alle SevDesk-Invoices + generiert fehlende.

## Verwandt

- [orders.md](orders.md) — `POST /api/orders/:orderId/invoice` ist der primäre Per-Order-Generator. `POST /api/invoices/:invoiceId/export-sevdesk` liegt im ordersRouter.
- SevDesk-Integration: [integrations.md](integrations.md).
