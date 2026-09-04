---
title: API — Products
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Products

Mount: `app.use('/api', productsRouter)` ([backend/index.js#L246](../../../backend/index.js#L246)). Globale `requireAuth` greift (Ausnahme: `GET /api/image-proxy` ist in der Auth-Allowlist).

Quelle: [backend/routes/products.js](../../../backend/routes/products.js). Hauptlibrary: [backend/lib/firestore.js](../../../backend/lib/firestore.js), Save-Path: [backend/lib/product-store.js](../../../backend/lib/product-store.js).

Tenant-Source: `req.user?.tenantId || 'default'`. Schreibpfad **immer** über `saveProductV2()` (CLAUDE.md Punkt 7).

Collection: `products_v2` (mit `USE_PRODUCTS_V2=true`, default-on).

---

## Read-Pfade

### `GET /api/products`

- **Auth**: `requirePermission('products', 'read')`
- **Tenant Source**: JWT → `getAllProductsForTenant(tenantId)`
- **Request**: `(empty)`
- **Response**:
  ```json
  { "ok": true, "products": [{ "id": "...", "identification": {...}, "details": {...}, "completeness": {...}, "storageBins": [...], "reservedQuantity": <int>, "soldQuantity": <int> }] }
  ```
  ⚠️ `products` als Top-Level — kein `data`-Wrapper.
- **Side-Effects**:
  - Parallel: `getAllProductsForTenant` + `buildReservedOpenOrderMap` + `buildSoldQuantityMap`.
  - Filtert Ghost-Products (early-stub Docs ohne Mindestdaten).
  - Enrichment: BIN-Summaries + Reserved/Sold + Completeness.
- **Source**: [backend/routes/products.js#L1501-L1538](../../../backend/routes/products.js#L1501-L1538)

### `GET /api/products/stream`

SSE Realtime-Stream via Firestore `onSnapshot`.

- **Auth**: `requirePermission('products', 'read')`
- **Tenant Source**: none (kein Filter im snapshot!)
- **Response**: `(stream)` — `text/event-stream`. Skippt initial snapshot, schickt nur Deltas: `event: update\ndata: { changes: [{ type, id, data }], ts }`.
- **Source**: [backend/routes/products.js#L1541-L1577](../../../backend/routes/products.js#L1541-L1577)

⚠️ Cross-Tenant-Leak — der Stream-Endpoint filtert nicht nach tenantId.

### `GET /api/products/:id`

- **Auth**: `requirePermission('products', 'read')`
- **Tenant Source**: implicit über Doc-Lookup
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "product": { "id": "...", "completeness": {...}, ...productFields } }`
- **Source**: [backend/routes/products.js#L1580-L1612](../../../backend/routes/products.js#L1580-L1612)

### `GET /api/products/:id/label`

Single-Product-Label als HTML (SKU + Name).

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `text/html`. `Content-Disposition: inline`.
- **Failure Modes**: `404`, `400` (kein SKU), `500`.
- **Source**: [backend/routes/products.js#L1615-L1668](../../../backend/routes/products.js#L1615-L1668)

### `GET /api/products/labels`

Batch-Labels.

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?ids=id1,id2,...`
- **Response**: `text/html` Label-Sheet.
- **Failure Modes**: `400` ohne `ids` oder wenn alle ungültig.
- **Source**: [backend/routes/products.js#L1266-L1332](../../../backend/routes/products.js#L1266-L1332)

### `GET /api/products/:id/bins`

- **Auth**: `requirePermission('warehouse', 'read')` (sic — Warehouse-Permission)
- **Tenant Source**: implicit
- **Response**: `{ "ok": true, "data": [...bins] }`
- **Source**: [backend/routes/products.js#L644-L655](../../../backend/routes/products.js#L644-L655)

---

## Write-Pfade

### `POST /api/save`

**Primary save endpoint** für UI-Saves. Validiert vor `saveProductV2`.

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: JWT
- **Request**:
  ```json
  {
    "id": "...",
    "identification": { "name": "...", "sku": "...", "barcodes": [...], "brand": "...", "category": "...>...>" },
    "details": { "categoryId": "12345", "categorySource": "manual|auto:*", "images": [{ "url_or_base64": "data:image/jpeg;base64,..." | "https://..." }], "pricing": {...}, "attributes": {...}, ... },
    "locale": "de-DE"
  }
  ```
- **Response**: `{ "ok": true, "data": { ...savedProduct } }`
- **Side-Effects**:
  - **Hard-Guard**: blockt mit `400` wenn SKU/Name/Beschreibung/Bilder/Kategorie fehlen oder Banned-Kategorie verwendet wird.
  - Image-Upload: base64 → GCS via `uploadBase64Image()`; filtert AI-generated metadata (außer Vertex AI).
  - `saveProductV2(product, { allowCategoryChange: true, mode: 'manual', source: 'ui', overwriteTextFields: true, replaceAttributes: true, syncIdentifiersFromBarcodes: true })`.
  - Auto-Quality-Job (createQualityJob + enqueueQualityJob).
  - Falls `CATEGORY_RESOLVER_V2=true` und Kategorie schwach: fire-and-forget Category-Resolver-Trigger (dedupliziert über 60 s `categoryResolverPostSaveDedupe`).
- **Idempotency**: idempotent für gleichen Product-State; bei Identity-Alias-Match wird gemerged.
- **Failure Modes**:
  - `400 { code: 400, message: "Produkt unvollständig: ..." }`.
  - `400` ohne `id`.
  - `500`.
- **Source**: [backend/routes/products.js#L1671-L1986](../../../backend/routes/products.js#L1671-L1986)

### `DELETE /api/products/:id`

- **Auth**: `requirePermission('products', 'delete')`
- **Tenant Source**: implicit
- **Request**: Query `?purgeDuplicates=true` (default false)
- **Response**: `{ "ok": true, "purgedDuplicates": [...ids] }`
- **Side-Effects**:
  - `deleteProductImages(id)` + `deleteProduct(id)`.
  - Audit-Log `product.deleted`.
  - Optional: `findProductIdsByAliases` + `deleteProduct` für gefundene Duplikate.
- **Idempotency**: idempotent (404 wenn schon weg).
- **Source**: [backend/routes/products.js#L1989-L2068](../../../backend/routes/products.js#L1989-L2068)

### `DELETE /api/products/cleanup-by-alias/:alias`

⚠️ **Kein `requirePermission`** — Diskrepanz.

- **Auth**: requireAuth
- **Tenant Source**: none
- **Request**: Query `?limit=...`
- **Response**: `{ "ok": true, ...result }`
- **Side-Effects**: `deleteProductsByIdentityAlias(alias, { limit })`.
- **Source**: [backend/routes/products.js#L1417-L1444](../../../backend/routes/products.js#L1417-L1444)

### `POST /api/products/bulk-delete`

- **Auth**: `requirePermission('products', 'delete')`
- **Tenant Source**: none direct (verarbeitet IDs aus Body)
- **Request**: `{ "ids": ["..."], "purgeDuplicates": false }`
- **Response**: `{ "ok": true, "deleted": [...], "notFound": [...], "failed": [{ "id": "...", "error": "..." }], "purgedDuplicatesById": { "<id>": ["...dup-ids"] } }`
- **Side-Effects**: pro ID `deleteProductImages` + `deleteProduct`; optional Duplikat-Purge.
- **Source**: [backend/routes/products.js#L1335-L1414](../../../backend/routes/products.js#L1335-L1414)

### `PATCH /api/v1/products/bulk-update`

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "productIds": [...], "updates": [{ "field": "...", "value": "..." }], "dryRun": false }`
- **Response**: `{ "ok": true, "data": { "updated": <int>, "skipped": <int>, "errors": [...] } }`
- **Side-Effects**: `bulkUpdateProducts()` aus `services/bulk-update.js`. Audit-Log nur bei `!dryRun`.
- **Source**: [backend/routes/products.js#L2555-L2592](../../../backend/routes/products.js#L2555-L2592)

---

## Bulk-Jobs

### `POST /api/products/bulk/run`

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "action": "<action>", "productIds": [...], "apply": true, "force": false, ... }` (gleiche Felder wie admin bulk/run aber `productIds` Pflicht)
- **Response** (`202`): `{ "ok": true, "data": { "jobId": "..." } }`
- **Side-Effects**: legt Admin-Bulk-Job an und enqueued. Backed by [services/admin-bulk-runner.js](../../../backend/services/admin-bulk-runner.js).
- **Failure Modes**: `400` ohne `action` oder `productIds`.
- **Source**: [backend/routes/products.js#L659-L699](../../../backend/routes/products.js#L659-L699)

### `GET /api/products/bulk/jobs/:id`

- **Auth**: `requirePermission('products', 'read')`
- **Tenant Source**: implicit
- **Response**: `{ "ok": true, "data": { ...job } }`
- **Failure Modes**: `404`.
- **Source**: [backend/routes/products.js#L701-L710](../../../backend/routes/products.js#L701-L710)

### `POST /api/products/bulk-improve`

Enqueued einen Improve-Job pro Produkt (Tenant-scoped).

- **Auth**: `requirePermission('ai', 'improve')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "enqueuedParams": <int>, "jobs": [{ "jobId": "...", "productId": "..." }] } }`
- **Side-Effects**: `createImproveJob` + `enqueueImproveJob` für jedes Produkt im Tenant.
- **Source**: [backend/routes/products.js#L1447-L1498](../../../backend/routes/products.js#L1447-L1498)

---

## Inventory-Records (legacy "Wareneingang")

Diese Inventories sind **andere Entität** als Warehouse-Inventures (siehe [warehouse.md](warehouse.md)).

### `GET /api/inventories`

- **Auth**: `requirePermission('inventories', 'read')`
- **Tenant Source**: TBD - verify in code (`listInventories` Signatur)
- **Request**: Query `?limit=500&vendor=<code>&search=<text>`
- **Response**: `{ "ok": true, "data": [...], "meta": { "limit": 500, "vendor": "...", "search": "..." } }`
- **Source**: [backend/routes/products.js#L713-L740](../../../backend/routes/products.js#L713-L740)

### `GET /api/inventories/:id`

- **Auth**: `requirePermission('inventories', 'read')`
- **Response**: `{ "ok": true, "data": {...inventory} }`
- **Failure Modes**: `404`.
- **Source**: [backend/routes/products.js#L742-L767](../../../backend/routes/products.js#L742-L767)

### `GET /api/inventories/:id/label.pdf`

- **Auth**: `requirePermission('inventories', 'read')`
- **Response**: `application/pdf` (buildInventoryLabelPdf).
- **Source**: [backend/routes/products.js#L769-L790](../../../backend/routes/products.js#L769-L790)

### `POST /api/inventories/assign` — Tombstone

- **Response**: `410 Gone` — `'Inventory-Zuordnung wird nicht mehr unterstützt.'`
- **Source**: [backend/routes/products.js#L792-L805](../../../backend/routes/products.js#L792-L805)

### `POST /api/products/:productId/inventory`

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: implicit
- **Request**: `{ "inventoryId": "..." }`
- **Response**: `{ "ok": true, "data": { "productId": "...", "inventoryId": "..." } }`
- **Side-Effects**: `setProductInventory(productId, inventory)`.
- **Failure Modes**: `400`, `404`.
- **Source**: [backend/routes/products.js#L807-L839](../../../backend/routes/products.js#L807-L839)

---

## Identity & Permissions

### `GET /api/me/permissions`

- **Auth**: requireAuth (kein `requirePermission` — selbst-Lookup)
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "roles": ["catalog"], "permissions": { "products": { "read": true, "write": true }, ... }, "profile": { "uid": "...", "email": "...", "roles": [...], "groupIds": [...] } } }`
- **Side-Effects**: `resolvePermissionsForUser(uid)` aus rbac.
- **Failure Modes**: `401` ohne uid. Bei Resolver-Error: `200 { ok: true, data: { roles: [], permissions: {}, profile: null } }` (UI-soft-fail).
- **Source**: [backend/routes/products.js#L842-L869](../../../backend/routes/products.js#L842-L869)

---

## Misc

### `GET /api/image-proxy`

⚠️ **Public — in der Auth-Allowlist** ([backend/index.js#L236](../../../backend/index.js#L236)). `<img src>` kann keine Header senden, also kein Auth möglich.

- **Auth**: none
- **Tenant Source**: none
- **Request**: Query `?url=<encoded>`
- **Response**: Image-Body (`image/*`, `Cache-Control: public, max-age=86400, immutable`)
- **Side-Effects**:
  - Eigenes GCS-Bucket (`storage.googleapis.com/prodsandjobs/...`): direkter `fetch`.
  - Sonst: Direct-Fetch mit Browser-User-Agent; bei Fehler Fallback auf BrightData-Unlocker (`fetchWithUnlocker`).
  - Body-Size-Limit `IMAGE_PROXY_MAX_BYTES` (default 5 MB), Timeout `IMAGE_PROXY_TIMEOUT_MS` (default 10 s).
- **Failure Modes**:
  - `400` ohne URL / ungültige URL / falsches Protokoll.
  - `413` wenn zu groß.
  - `502 { code: 502 }` wenn Upstream fehlschlägt.
- **Source**: [backend/routes/products.js#L872-L1012](../../../backend/routes/products.js#L872-L1012)

### `POST /api/intake/resolve`

Stock-Protection-Resolver. Wird vom Identify-Pfad aufgerufen (nicht direkt von UI).

- **Auth**: requireAuth (kein `requirePermission`)
- **Tenant Source**: none (uses identifier match)
- **Request**: `{ "barcodes": "ean1,ean2", "sku": "SKU-...", "inventoryId": "..." }`
- **Response**: `{ "ok": true, "data": { "matched": false } }` ODER `{ "ok": true, "data": { "matched": true, "product": {...}, "pendingIntakeQuantity": <int> } }`
- **Side-Effects**: `adjustPendingIntakeQuantity(productId, 1)` + `setProductInventory` falls Inventory wechselt.
- **Source**: [backend/routes/products.js#L1017-L1079](../../../backend/routes/products.js#L1017-L1079)

### `POST /api/generate-images`

Studio-Aufbereitung der **vorhandenen** Produktansichten (Gemini-Bildmodell). Erzeugt seit dem Umbau
2026-09-02 **keine Perspektiven mehr, die nicht fotografiert wurden** — siehe CLAUDE.md,
Abschnitt „Bildvarianten: aufbereiten statt erfinden".

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: none
- **Request**: `{ "productId": "...", "product": {...}, "referenceImage": { "url_or_base64": "..." }, "maxVariants": 4 }`
  (productId ODER product muss da sein; `maxVariants` optional, Default 4)
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "images": [{
        "url_or_base64": "https://…", "variant": "studio_front", "viewpoint": "front",
        "source": "generated", "generatedByAi": true, "derivedFrom": "https://… (Quellfoto)",
        "identityChecked": true, "warnings": ["…"], "width": 1200, "height": 1200
      }],
      "prompts": { "studio": { "front": "…" } },
      "plan":     [{ "viewpoint": "front", "label": "Vorderansicht", "sourceIndex": 0, "variant": "studio_front" }],
      "skipped":  [{ "viewpoint": "back", "label": "Rückansicht", "reason": "kein_foto" }],
      "evidence": { "belegt": ["front"], "belegtLabels": ["Vorderansicht"], "referenceCount": 3,
                    "classified": true, "sameProductThroughout": true },
      "report":   { "mode": "faithful", "requestedVariants": 1, "producedVariants": 1, "durationMs": 41230 }
    }
  }
  ```
- **`skipped[].reason`**: `kein_foto` · `kontingent_erschoepft` · `keine_ansichtserkennung` ·
  `zeitbudget_erschoepft` · `erzeugung_fehlgeschlagen` (mit `attempts[]`) · `upload_fehlgeschlagen: …`
- **WICHTIG für Aufrufer**: `ok:true` mit **leerem** `images` ist möglich und normal. `skipped`
  MUSS dem Bediener gezeigt werden — sonst hält er ein unvollständiges Ergebnis für vollständig.
- **Side-Effects**: 1 Vision-Call zur Ansichtsbestimmung, je geplanter Ansicht 1–2 Bildmodell-Calls
  plus 1 Identitäts-Urteil; Upload nach GCS. Nebenläufig (`IMAGE_VARIANTS_CONCURRENCY`), Gesamtbudget
  `IMAGE_VARIANTS_TOTAL_TIMEOUT_MS` (300 s).
- **Failure Modes**: `400` ohne Produkt/Referenz oder wenn das Referenzbild nicht zum **gespeicherten**
  Produkt gehört; `500` wenn kein echtes Referenzbild vorhanden ist oder kein Referenzbild geladen
  werden konnte.
- **Source**: [backend/routes/products.js](../../../backend/routes/products.js) (Suche nach `'/generate-images'`)

### `POST /api/listing-pipeline`

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: none direct
- **Request**: `{ "productId": "...", "channels": ["ebay", "kaufland"] }`
- **Response**: `{ "ok": true, "data": { ...generatedListings } }`
- **Side-Effects**: `generateChannelListings(productId, { channels })` aus `services/listing-pipeline.js`.
- **Source**: [backend/routes/products.js#L1142-L1158](../../../backend/routes/products.js#L1142-L1158)

### `POST /api/scanner/capture`

- **Auth**: `requirePermission('identify', 'run')`
- **Tenant Source**: none
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "mimeType": "image/png", "base64": "..." } }`
- **Side-Effects**: ruft `scanToBuffer()` (lokaler/dedizierter Scanner — TBD - verify in code).
- **Source**: [backend/routes/products.js#L1161-L1180](../../../backend/routes/products.js#L1161-L1180)

---

## Category-Profiles

### `GET /api/categories/profiles`

- **Auth**: `requirePermission('categories', 'read')`
- **Tenant Source**: none
- **Request**: Query `?ids=cat1,cat2` ODER `?enabledOnly=true`
- **Response**: `{ "ok": true, "items": [{ "id": "...", "name": "...", "enabled": true, "canonicalAttributes": [...], "attributeAliases": {...}, "notes": "..." }] }`
- **Source**: [backend/routes/products.js#L1183-L1218](../../../backend/routes/products.js#L1183-L1218)

### `PUT /api/categories/profiles/:id`

- **Auth**: `requirePermission('categories', 'write')`
- **Tenant Source**: none
- **Request**: `{ "enabled": true, "canonicalAttributes": [...], "attributeAliases": {...}, "notes": "..." }`
- **Response**: `{ "ok": true, "data": {...payload} }`
- **Side-Effects**: validiert ID gegen eBay-Taxonomy (`getEbayCategoryById`), schreibt nach `<CATEGORY_PROFILES_COLLECTION>/{id}`.
- **Failure Modes**: `400` für unbekannte Category-ID.
- **Source**: [backend/routes/products.js#L1220-L1263](../../../backend/routes/products.js#L1220-L1263)

---

## Improve & Quality Jobs

### `POST /api/products/:id/improve`

Inline (sync) AI-Improve.

- **Auth**: `requirePermission('ai', 'improve')`
- **Tenant Source**: none
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": {...improvedProduct} }`
- **Failure Modes**: `404`/`500`.
- **Source**: [backend/routes/products.js#L2131-L2149](../../../backend/routes/products.js#L2131-L2149)

### `POST /api/improve/jobs`

Batch enqueue.

- **Auth**: `requirePermission('ai', 'improve')`
- **Tenant Source**: none direct
- **Request**: `{ "productIds": [...] }` — Max `MAX_IMPROVE_BATCH` (default 100).
- **Response**: `{ "ok": true, "data": { "jobs": [{ "jobId": "...", "productId": "..." }], "missing": [...] } }`
- **Side-Effects**: createImproveJob + enqueueImproveJob. Optional inline für ≤3 Produkte wenn `IMPROVE_INLINE=true`.
- **Failure Modes**: `400` bei leerem oder zu großem Array.
- **Source**: [backend/routes/products.js#L2152-L2231](../../../backend/routes/products.js#L2152-L2231)

### `GET /api/improve/jobs/:id`

- **Auth**: `requirePermission('ai', 'improve')`
- **Response**: `{ "ok": true, "data": {...job} }`. `Cache-Control: no-store`.
- **Failure Modes**: `404`.
- **Source**: [backend/routes/products.js#L2233-L2251](../../../backend/routes/products.js#L2233-L2251)

### `POST /api/quality/jobs`

- **Auth**: `requirePermission('jobs', 'read')` (sic — `read`, nicht `run` oder `write`)
- **Request**: `{ "productIds": [...], "reason": "manual", "requestedBy": "ui", "force": false }`. Max `MAX_QUALITY_BATCH` (50).
- **Response**: `{ "ok": true, "data": { "jobs": [...], "missing": [...] } }`
- **Side-Effects**: createQualityJob + enqueueQualityJob.
- **Source**: [backend/routes/products.js#L2254-L2311](../../../backend/routes/products.js#L2254-L2311)

### `GET /api/quality/jobs/:id`

- **Auth**: `requirePermission('jobs', 'read')`
- **Response**: `{ "ok": true, "data": {...job} }`.
- **Failure Modes**: `404`.
- **Source**: [backend/routes/products.js#L2313-L2331](../../../backend/routes/products.js#L2313-L2331)

---

## Pricing (v1)

### `POST /api/v1/pricing/suggest/:productId`

- **Auth**: `requirePermission('products', 'write')`
- **Response**: `{ "ok": true, "data": {...analysis} }`
- **Source**: [backend/routes/products.js#L2334-L2342](../../../backend/routes/products.js#L2334-L2342)

### `POST /api/v1/pricing/rules`

- **Auth**: `requirePermission('products', 'write')`
- **Request**: Pricing-Rule-Objekt (TBD - verify in code, Schema in `services/pricing-engine.js`).
- **Response**: `{ "ok": true, "data": {...rule} }` oder `400 { code: 'VALIDATION' }`.
- **Source**: [backend/routes/products.js#L2344-L2352](../../../backend/routes/products.js#L2344-L2352)

### `GET /api/v1/pricing/rules`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?all=true` (sonst nur active)
- **Response**: `{ "ok": true, "data": [...rules] }`
- **Source**: [backend/routes/products.js#L2354-L2368](../../../backend/routes/products.js#L2354-L2368)

### `POST /api/v1/pricing/reprice-batch`

- **Auth**: `requirePermission('admin', 'jobs.run')`
- **Response**: `{ "ok": true, "data": {...results} }`
- **Side-Effects**: `runRepricingJob()`.
- **Source**: [backend/routes/products.js#L2370-L2378](../../../backend/routes/products.js#L2370-L2378)

### `DELETE /api/v1/pricing/rules/:ruleId`

- **Auth**: `requirePermission('products', 'write')`
- **Response**: `{ "ok": true }`. `404` falls Rule nicht existiert.
- **Source**: [backend/routes/products.js#L2380-L2394](../../../backend/routes/products.js#L2380-L2394)

### `PATCH /api/v1/pricing/rules/:ruleId/toggle`

- **Auth**: `requirePermission('products', 'write')`
- **Response**: `{ "ok": true, "data": { "id": "...", "active": <new> } }`. **Nicht idempotent** (flip).
- **Source**: [backend/routes/products.js#L2396-L2411](../../../backend/routes/products.js#L2396-L2411)

---

## Forecasting (v1)

### `GET /api/v1/forecast/:productId`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?days=30`
- **Response**: `{ "ok": true, "data": { ...salesVelocity, ...stockOut } }`
- **Source**: [backend/routes/products.js#L2414-L2424](../../../backend/routes/products.js#L2414-L2424)

### `GET /api/v1/forecast/alerts`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": [...alerts] }`
- **Source**: [backend/routes/products.js#L2426-L2434](../../../backend/routes/products.js#L2426-L2434)

---

## Webhooks (v1, Outbound)

Diese sind eine zweite, parallele Implementierung zu `/api/settings/webhooks` (siehe [settings.md](settings.md)) — backed by `services/webhooks.js`.

### `POST /api/v1/webhooks`
### `GET /api/v1/webhooks`
### `DELETE /api/v1/webhooks/:id`

- **Auth**: `requirePermission('admin', 'webhooks.write' | 'webhooks.read' | 'webhooks.write')`
- **Tenant Source**: none direct
- **Request (POST)**: TBD - verify in code (`createWebhook`-Schema).
- **Response**: `{ "ok": true, "data": ... }`
- **Source**: [backend/routes/products.js#L2437-L2465](../../../backend/routes/products.js#L2437-L2465)

---

## Deduplication (v1)

### `GET /api/v1/products/duplicates`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": [...duplicates] }`
- **Side-Effects**: `findDuplicates()` aus `services/deduplication.js`.
- **Source**: [backend/routes/products.js#L2468-L2476](../../../backend/routes/products.js#L2468-L2476)

### `GET /api/v1/products/merge/suggest`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?a=<id1>&b=<id2>`
- **Response**: `{ "ok": true, "data": {...mergeSuggestion} }`
- **Failure Modes**: `400 { code: 'VALIDATION' }`.
- **Source**: [backend/routes/products.js#L2478-L2490](../../../backend/routes/products.js#L2478-L2490)

### `POST /api/v1/products/merge`

- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "keepId": "...", "removeId": "..." }`
- **Response**: `{ "ok": true, "data": { "merged": ... } }`
- **Side-Effects**: `executeMerge(keepId, removeId)` + Audit-Log `product.merged`.
- **Source**: [backend/routes/products.js#L2492-L2513](../../../backend/routes/products.js#L2492-L2513)

---

## Competitor-Intelligence (v1)

### `GET /api/v1/competitors/:productId/history`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?days=30`
- **Response**: `{ "ok": true, "data": [...priceHistory] }`. Erfordert composite-index `priceHistory: (productId, timestamp DESC)`.
- **Source**: [backend/routes/products.js#L2516-L2532](../../../backend/routes/products.js#L2516-L2532)

### `GET /api/v1/competitors/overview`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": [...top 100 priceHistory entries] }`
- **Source**: [backend/routes/products.js#L2534-L2546](../../../backend/routes/products.js#L2534-L2546)

---

## Validation (Pre-Listing)

### `POST /api/v1/products/validate`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: `{ "product": {...productData}, "marketplaces": ["ebay", "kaufland"] }` (default alle SUPPORTED_MARKETPLACES)
- **Response**:
  ```json
  { "ok": true, "results": { "ebay": { "score": 0.85, "ready": true, "counts": {...} }, "kaufland": {...} } }
  ```
- **Source**: [backend/routes/products.js#L2706-L2735](../../../backend/routes/products.js#L2706-L2735)

### `POST /api/v1/products/validate-batch`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: `{ "productIds": [...], "marketplaces": [...] }`. Max 100.
- **Response**: `{ "ok": true, "results": [...], "summary": { "total": ..., "ebay_ready": ..., "kaufland_ready": ... } }`
- **Source**: [backend/routes/products.js#L2737-L2805](../../../backend/routes/products.js#L2737-L2805)

---

## CSV-Export / Import

### `GET /api/products/export/csv`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?columns=name,brand,sku` (optional Subset)
- **Response**: `text/csv; charset=utf-8` mit BOM (`\uFEFF`). `Content-Disposition: attachment; filename="avycloud-produkte-<date>.csv"`.
- **Source**: [backend/routes/products.js#L2601-L2615](../../../backend/routes/products.js#L2601-L2615)

### `POST /api/products/import/preview`

- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "csvText": "...", "mapping": [...ColumnMapping], "delimiter": ";" }`
- **Response**: `{ "ok": true, "data": { "headers": [...], "totalRows": <int>, "validCount": <int>, "errorCount": <int>, "errors": [...max 50], "preview": [...max 10] } }`
- **Failure Modes**: `400 { code: 'VALIDATION' }`.
- **Source**: [backend/routes/products.js#L2622-L2652](../../../backend/routes/products.js#L2622-L2652)

### `POST /api/products/import/execute`

- **Auth**: `requirePermission('products', 'write')`
- **Request**: wie preview
- **Response**: `{ "ok": true, "data": { "imported": <int>, "failed": <int>, "totalRows": <int>, "validationErrors": [...], "importErrors": [...] } }`
- **Side-Effects**: `importProducts(valid, tenantId)` + Audit-Log `product.bulk_import`.
- **Failure Modes**: `400` wenn keine validen Zeilen.
- **Source**: [backend/routes/products.js#L2659-L2701](../../../backend/routes/products.js#L2659-L2701)

---

## Interne Notizen (Gelesen-Stand)

Bestehende Notiz-Routen (`GET /api/products/notes-counts`, `GET/POST /api/products/:id/notes`) unverändert. Neu seit 2026-08-29 für den Notizen-Filter der Produkttabelle:

### `GET /api/products/notes-overview`

- **Auth**: `requirePermission('products', 'read')`
- **Tenant Source**: `req.user.tenantId`
- **Response**: `{ "ok": true, "data": { "<productId>": { "count": <int>, "lastNoteAt": "<iso|null>", "seenAt": "<iso|null>" } } }` — `seenAt` ist der Gelesen-Stand des ANGEMELDETEN Nutzers (Doc `product_note_reads/{tenantId}__{uid}`, Map `seen`). „Ungelesen" entscheidet das Frontend: `lastNoteAt > seenAt` (`utils/productFilters.ts hasUnreadNotes` — eine Quelle).
- **Source**: [backend/routes/products.js#L733](../../../backend/routes/products.js#L733)

### `POST /api/products/:id/notes/seen`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: leer.
- **Response**: `{ "ok": true, "data": { "productId": "...", "seenAt": "<iso>" } }`
- **Side-Effects**: merge-Write auf `product_note_reads/{tenantId}__{uid}` (`seen.<productId> = now`). Ausgelöst beim Öffnen der Notizen im Produktdatenblatt — bewusst KEIN Auto-Read beim Tabellen-Scrollen.
- **Failure Modes**: `400 { code: 'VALIDATION' }` ohne Nutzer/Produkt.
- **Source**: [backend/routes/products.js#L749](../../../backend/routes/products.js#L749)

---

## Price-Refresh

### `POST /api/price-refresh`

- **Auth**: requireAuth (kein `requirePermission`)
- **Tenant Source**: none
- **Request**: `{ "productId": "...", "force": false }`
- **Response**: `{ "ok": true, "data": {...result}, "serpTrace": [...] }` ODER `{ "ok": false, "error": { "code": 404, "message": "..." }, "serpTrace": [...] }`
- **Side-Effects**: `enrichPriceForProductBestEffort` (SerpAPI / external lookup). `saveProductV2()` falls aktualisiert.
- **Failure Modes**: `400`, `404`, `500`.
- **Source**: [backend/routes/products.js#L2071-L2128](../../../backend/routes/products.js#L2071-L2128)
