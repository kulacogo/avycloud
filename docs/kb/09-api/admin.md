---
title: API — Admin
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Admin

Mount: `app.use('/api/admin', adminRouter)` ([backend/index.js#L243](../../../backend/index.js#L243)). Globale `requireAuth` greift, zusätzlich überall `requirePermission('admin', '<action>')`.

Quelle: [backend/routes/admin.js](../../../backend/routes/admin.js).

Tenant-Source: `req.user?.tenantId || 'default'`. Bulk-Jobs erlauben `tenantId` im Body als Override.

⚠️ **Doppel-Prefix-Falle**: Manche Routes nutzen `'/admin/...'` ALS Path im Router, was bei Mount `/api/admin` zu `/api/admin/admin/...` führt. Konkrete betroffene Routes sind unten markiert.

---

## Users

### `GET /api/admin/users`
- **Auth**: `requirePermission('admin', 'users.read')`
- **Request**: Query `?limit=500` (1–1000)
- **Response**: `{ "ok": true, "data": [...users] }`
- **Source**: [backend/routes/admin.js#L57-L66](../../../backend/routes/admin.js#L57-L66)

### `POST /api/admin/users`
- **Auth**: `requirePermission('admin', 'users.write')`
- **Request**: `{ "email": "user@trendocean.de", "roles": ["catalog"] }`
- **Response**: `{ "ok": true, "data": { "uid": "...", "email": "..." } }`
- **Side-Effects**: `inviteUser()` aus `services/admin-api.js`.
- **Source**: [backend/routes/admin.js#L68-L79](../../../backend/routes/admin.js#L68-L79)

### `PUT /api/admin/users/:uid/roles`
- **Auth**: `requirePermission('admin', 'users.write')`
- **Request**: `{ "roles": ["catalog","operation"] }`
- **Response**: `{ "ok": true }`
- **Source**: [backend/routes/admin.js#L81-L92](../../../backend/routes/admin.js#L81-L92)

### `PUT /api/admin/users/:uid/groups`
- **Auth**: `requirePermission('admin', 'users.write')`
- **Request**: `{ "groupIds": ["group-a"] }`
- **Response**: `{ "ok": true }`
- **Source**: [backend/routes/admin.js#L94-L105](../../../backend/routes/admin.js#L94-L105)

### `PUT /api/admin/users/:uid/overrides`
- **Auth**: `requirePermission('admin', 'users.write')`
- **Request**: `{ "overrides": { "allow": {...}, "deny": {...} } }`
- **Response**: `{ "ok": true }`
- **Source**: [backend/routes/admin.js#L107-L118](../../../backend/routes/admin.js#L107-L118)

---

## Groups & Roles

### `GET /api/admin/groups`
### `POST /api/admin/groups`
### `PUT /api/admin/groups/:groupId`
### `DELETE /api/admin/groups/:groupId`
- **Auth**: `requirePermission('admin', 'groups.read' | 'groups.write')`
- **POST/PUT Request**: `{ "name": "...", "groupId": "...", "roleIds": ["catalog"] }`
- **DELETE Response**: `204` (No Content)
- **Source**: [backend/routes/admin.js#L124-L172](../../../backend/routes/admin.js#L124-L172)

### `GET /api/admin/roles`
### `PUT /api/admin/roles/:roleId`
- **Auth**: `requirePermission('admin', 'roles.read' | 'roles.write')`
- **PUT Request**: Patch der Permissions/Name.
- **Response**: `{ "ok": true, "data": ... }`
- **Source**: [backend/routes/admin.js#L178-L199](../../../backend/routes/admin.js#L178-L199)

---

## LLM Scopes

### `GET /api/admin/llm/scopes`
- **Auth**: `requirePermission('admin', 'llm.read')`
- **Response**: `{ "ok": true, "data": [...scopes] }`
- **Source**: [backend/routes/admin.js#L205-L213](../../../backend/routes/admin.js#L205-L213)

### `GET /api/admin/llm/health`
- **Auth**: `requirePermission('admin', 'llm.read')`
- **Response**: `{ "ok": true, "data": { "apiKeyConfigured": <bool>, "keySource": "...", "keyError": null, "models": [...], "modelsError": null, "flags": { "qualityGateEnabled": <bool>, "rulebookEnabled": <bool>, "titlePolicyDisabled": <bool>, "storageBucket": "..." } } }`
- **Side-Effects**: ruft `https://generativelanguage.googleapis.com/v1beta/models` mit konfiguriertem Gemini-Key.
- **Source**: [backend/routes/admin.js#L217-L294](../../../backend/routes/admin.js#L217-L294)

### `GET /api/admin/llm/scopes/:scopeId`
- **Auth**: `requirePermission('admin', 'llm.read')`
- **Response**: `{ "ok": true, "data": { "scope": {...}, "versions": [...] } }`
- **Failure Modes**: `404 { code: 404, message: 'Scope not found' }`
- **Source**: [backend/routes/admin.js#L296-L310](../../../backend/routes/admin.js#L296-L310)

### `POST /api/admin/llm/scopes/:scopeId/versions`
- **Auth**: `requirePermission('admin', 'llm.write')`
- **Request**: Version-Body (siehe `services/llm-config.js`).
- **Response**: `{ "ok": true, "data": {...createdVersion} }`
- **Source**: [backend/routes/admin.js#L312-L323](../../../backend/routes/admin.js#L312-L323)

### `POST /api/admin/llm/scopes/:scopeId/activate/:versionId`
- **Auth**: `requirePermission('admin', 'llm.write')`
- **Response**: `{ "ok": true }`
- **Side-Effects**: `activateScopeVersion()` schaltet die aktive Version.
- **Source**: [backend/routes/admin.js#L325-L336](../../../backend/routes/admin.js#L325-L336)

---

## Rulebook

### `GET /api/admin/rulebook`
- **Auth**: `requirePermission('admin', 'rules.read')`
- **Response**: `{ "ok": true, "data": {...activeRulebook} }`
- **Source**: [backend/routes/admin.js#L342-L350](../../../backend/routes/admin.js#L342-L350)

### `PUT /api/admin/rulebook`
- **Auth**: `requirePermission('admin', 'rules.write')`
- **Request**: `{ "config": {...rulebookConfig}, "note": "..." }`
- **Response**: `{ "ok": true, "data": { "versionId": "..." } }`
- **Side-Effects**: `createRulebookVersion()` legt neue Version an. Falls aktiv geschaltet, übernimmt der Background-Rulebook-Runner.
- **Failure Modes**: `400` ohne `config`.
- **Source**: [backend/routes/admin.js#L352-L366](../../../backend/routes/admin.js#L352-L366)

### `POST /api/admin/rulebook/apply`
- **Auth**: `requirePermission('admin', 'jobs.run')`
- **Request**: `{ "inventoryId": "78659", "limit": 0, "chunkSize": 200, "minQty": <int|null>, "requireBin": <bool|null> }`
- **Response** (`202`): `{ "ok": true, "data": { "jobId": "..." } }`
- **Side-Effects**: `createRulebookApplyJob` + `enqueueRulebookJob` → läuft via `services/rulebook-runner.js`.
- **Source**: [backend/routes/admin.js#L368-L387](../../../backend/routes/admin.js#L368-L387)

### `GET /api/admin/rulebook/apply/:id`
- **Auth**: `requirePermission('admin', 'jobs.read')`
- **Response**: `{ "ok": true, "data": {...job} }`. `404` falls Job fehlt.
- **Source**: [backend/routes/admin.js#L389-L398](../../../backend/routes/admin.js#L389-L398)

---

## Metrics — Product Coverage

### `GET /api/admin/metrics/product-coverage`

⚠️ **Heavy** — iteriert über ALLE Produkte des Tenants, validiert Title-Policy + GPSR + Pricing + Categories + K-Typ-Fitment.

- **Auth**: `requirePermission('admin', 'users.read')` (sic — `users.read`, scheinbar wegen Audit/HR-Sicht)
- **Tenant Source**: JWT → `getAllProductsForTenant(tenantId)`
- **Request**: Query
  - `?minPrice=...&maxPrice=...` — Price-Range für `priceOutOfRangeIds`.
  - `?priceMaxAgeDays=14` — älter ⇒ `priceStale`.
- **Response**: Sehr großes Objekt — siehe [backend/routes/admin.js#L729-L811](../../../backend/routes/admin.js#L729-L811):
  ```json
  {
    "ok": true,
    "data": {
      "title": { "okCount": ..., "notOkCount": ..., "idealLenCount": ... },
      "ktyp": { "withValue": ..., "fitmentTotal": ... },
      "gpsr": { "requiredFields": [...], "requiredFilledHistogram": {...}, "anyFieldPresent": ..., "fullRequiredFieldsPresent": ..., "fullRequiredFieldsNoPlaceholders": ..., "candidatesNeedingEnrich": ... },
      "gpsr_registry": { "brandsTotal": ..., "brandsWithVariance": ..., "brandsMissingRegistry": ..., "productsMismatchingRegistry": ..., "topBrandsByMismatch": [...] },
      "price": { "minPrice": ..., "maxPrice": ..., "missingCount": ..., "okCount": ..., "outOfRangeCount": ..., "noSourcesCount": ..., "staleCount": ..., "lowConfidenceCount": ..., "similarMatchCount": ..., "priceMaxAgeDays": 14 },
      "categories": { "mainCategoryCounts": {...} },
      "errors": { "count": ..., "sample": [...] } | null,
      "buckets": { /* arrays of product-IDs per bucket — used for bulk-action targeting */ }
    }
  }
  ```
- **Side-Effects**: read `gpsrManufacturers`-Collection für Registry-Cross-Check.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/admin.js#L404-L820](../../../backend/routes/admin.js#L404-L820)

---

## Admin Bulk Actions

### `POST /api/admin/bulk/run`

Genereller Bulk-Job-Trigger. Action-Liste lebt in `services/admin-bulk-runner.js`. Bekannt: `recategorize_v2`, `gpsr-web-enrich`, etc.

- **Auth**: `requirePermission('admin', 'jobs.run')`
- **Tenant Source**: JWT (default) — Override via `body.tenantId`.
- **Request**:
  ```json
  {
    "action": "<key>",
    "apply": false,
    "limit": 500,
    "offset": 0,
    "force": false,
    "includeUi": false,
    "productIds": [...],
    "concurrency": <int>,
    "expectedCount": <int>,
    "minConfidence": 0.8,
    "inventoryId": "...",
    "storefront": "de",
    "marketplaceId": "EBAY_DE",
    "titleInsights": <bool>,
    "titleInsightsQuery": "...",
    "titleInsightsForceRefresh": <bool>,
    "titleInsightsLimit": <int>,
    "titleInsightsMaxHints": <int>,
    "tenantId": "<override>",
    "debug": false,
    "maxAgeDays": <int>
  }
  ```
- **Response** (`202`): `{ "ok": true, "data": { "jobId": "..." } }`
- **Side-Effects**: `createAdminBulkJob` + `enqueueAdminBulkJob`. Status-Polling via `GET /api/admin/bulk/jobs/:id`.
- **Failure Modes**: `400` ohne `action`.
- **Source**: [backend/routes/admin.js#L826-L874](../../../backend/routes/admin.js#L826-L874)

### `GET /api/admin/bulk/jobs/:id`
- **Auth**: `requirePermission('admin', 'jobs.read')`
- **Response**: `{ "ok": true, "data": {...job} }`. `404`.
- **Source**: [backend/routes/admin.js#L876-L885](../../../backend/routes/admin.js#L876-L885)

---

## Cloud Run Jobs (GPSR Web-Enrich)

### `POST /api/admin/jobs/gpsr-web-enrich/run`
- **Auth**: `requirePermission('admin', 'jobs.run')`
- **Tenant Source**: none (uses ENV-config)
- **Request**:
  ```json
  { "limit": <int>, "concurrency": <int>, "minQty": <int>, "requireBin": <bool>, "apply": false, "debug": false }
  ```
- **Response**: `{ "ok": true, "data": {...cloudRunOperation} }`
- **Side-Effects**:
  - Triggert Cloud-Run-Job über `GPSR_WEB_ENRICH_JOB_NAME` (oder `CLOUD_RUN_JOBS_LOCATION + GPSR_WEB_ENRICH_JOB_ID`).
  - Optional Container-Overrides (Env-Vars `APPLY`, `LIMIT`, etc.).
  - Persistiert Run via `createJobRun({ type: 'gpsr-web-enrich', operationName, ... })`.
- **Failure Modes**: `400` wenn keine Cloud-Run-Config gesetzt; `500`.
- **Source**: [backend/routes/admin.js#L891-L977](../../../backend/routes/admin.js#L891-L977)

---

## Jobs Status (Aggregat)

### `GET /api/admin/jobs/status`
- **Auth**: `requirePermission('admin', 'jobs.read')`
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "rulebookApply": { "runningCount": <int>, "running": [...] },
      "adminBulk":     { "runningCount": <int>, "running": [...] },
      "gpsrWebEnrich": { "latestRun": {...}, "operation": {...}, "recentRuns": [...] }
    }
  }
  ```
- **Source**: [backend/routes/admin.js#L983-L1030](../../../backend/routes/admin.js#L983-L1030)

---

## Email Templates

### `GET /api/admin/email-templates`
- **Auth**: `requirePermission('admin', 'read')`
- **Response**: `{ "ok": true, "data": [...templates] }`
- **Source**: [backend/routes/admin.js#L1035-L1042](../../../backend/routes/admin.js#L1035-L1042)

### `GET /api/admin/email-templates/:name/preview`
- **Auth**: `requirePermission('admin', 'read')`
- **Response**: `{ "ok": true, "data": { "html": "...", "subject": "...", "templateName": "..." } }` mit Sample-Variablen befüllt.
- **Failure Modes**: `404` für unbekanntes Template.
- **Source**: [backend/routes/admin.js#L1044-L1071](../../../backend/routes/admin.js#L1044-L1071)

---

## Pricing Runner

### `GET /api/admin/pricing/runner-status`
- **Auth**: `requirePermission('admin', 'read')`
- **Response**: `{ "ok": true, "data": {...runnerState} }`
- **Source**: [backend/routes/admin.js#L1074-L1081](../../../backend/routes/admin.js#L1074-L1081)

---

## Audit-Log

### `GET /api/admin/audit-log`
- **Auth**: `requirePermission('admin', 'read')`
- **Request**: Query `?action=...&resourceType=...&resourceId=...&userId=...&limit=100&startAfter=<cursor>`
- **Response**: `{ "ok": true, "data": [...entries] }`
- **Source**: [backend/routes/admin.js#L1086-L1102](../../../backend/routes/admin.js#L1086-L1102)

---

## Marketplace-Tracking (Doppel-Prefix-Falle)

⚠️ Diese Routes sind als `'/admin/marketplace-tracking/...'` definiert — aufgrund des Router-Mount `/api/admin` werden sie unter `/api/admin/admin/marketplace-tracking/...` erreichbar. Vermutlich versehentlich; TBD - verify in code, ob die UI das tatsächlich so aufruft oder ob das ein Bug ist.

### `POST /api/admin/admin/marketplace-tracking/retry`
- **Auth**: `requirePermission('admin', 'write')`
- **Request**: `{ "maxAge": 7 }` (Tage)
- **Response**: `{ "ok": true, "data": {...result} }`
- **Side-Effects**: `retryFailedMarketplacePushes({ maxAge })`.
- **Source**: [backend/routes/admin.js#L1110-L1120](../../../backend/routes/admin.js#L1110-L1120)

### `POST /api/admin/admin/marketplace-tracking/push/:orderId`
- **Auth**: `requirePermission('admin', 'write')`
- **Response**: `{ "ok": true, "data": {...result} }`
- **Side-Effects**: `ensureMarketplaceTrackingPushed({ orderId })`.
- **Source**: [backend/routes/admin.js#L1126-L1136](../../../backend/routes/admin.js#L1126-L1136)

### `POST /api/admin/admin/backfill-order-marketplaces`
- **Auth**: `requirePermission('admin', 'write')`
- **Tenant Source**: none
- **Request**: Query `?dry_run=true`
- **Response**: `{ "ok": true, "data": { "checked": <int>, "fixed": <int>, "unchanged": <int>, "unresolvable": <int>, "dryRun": <bool> } }`
- **Side-Effects**: Full-Scan über `orders`, detect Marketplace, batch-update.
- **Source**: [backend/routes/admin.js#L1142-L1212](../../../backend/routes/admin.js#L1142-L1212)

---

## Sessions (Admin-Sicht)

### `GET /api/admin/sessions`
- **Auth**: `requirePermission('admin', 'read')`
- **Tenant Source**: hardcoded `'default'`
- **Request**: Query `?userId=...&limit=50&startAfter=...`
- **Response**: `{ "ok": true, "data": [...sessions] }`
- **Source**: [backend/routes/admin.js#L1217-L1231](../../../backend/routes/admin.js#L1217-L1231)

### `GET /api/admin/sessions/active`
- **Auth**: `requirePermission('admin', 'read')`
- **Tenant Source**: hardcoded `'default'`
- **Response**: `{ "ok": true, "data": [...activeSessions] }`
- **Source**: [backend/routes/admin.js#L1233-L1241](../../../backend/routes/admin.js#L1233-L1241)

---

## Batch-Optimize

### `GET /api/admin/batch-optimize/preview`
- **Auth**: `requirePermission('admin', 'products.write')`
- **Tenant Source**: JWT oder Query `?tenantId=...`
- **Response**: `{ "ok": true, "data": {...preview} }`
- **Source**: [backend/routes/admin.js#L1251-L1260](../../../backend/routes/admin.js#L1251-L1260)

### `POST /api/admin/batch-optimize/run`
- **Auth**: `requirePermission('admin', 'products.write')`
- **Request**: `{ "dryRun": false, "limit": 0, "offset": 0, "tenantId": "..." }`
- **Response** (synchron): `{ "ok": true, "data": {...result} }`. ⚠️ Long-running — Cloud Run Timeout kann zuschlagen.
- **Side-Effects**: `runBatchOptimize()` ruft Gemini "Alles optimieren" für BIN-assigned non-eBay Produkte.
- **Source**: [backend/routes/admin.js#L1488-L1507](../../../backend/routes/admin.js#L1488-L1507)

---

## Stock (Force-Resync + Drain)

Siehe CLAUDE.md Punkt 10 (Oversell-Verbot).

### `POST /api/admin/stock/force-resync`
- **Auth**: `requirePermission('admin', 'write')`
- **Tenant Source**: JWT oder Body `.tenantId`
- **Request**: `{ "sku": "...", "productId": "...", "reason": "manual-resync", "tenantId": "..." }`
- **Response**: `{ "ok": true, "data": { "productId": "...", "sku": "...", "result": {...} } }`
- **Side-Effects**: `syncStockWithRetry({ tenantId, product, reason: 'admin-force:<reason>' })`.
- **Feature-Flag**: `STOCK_ADMIN_FORCE_RESYNC_ENABLED=false` ⇒ `503 { code: 'DISABLED' }`.
- **Failure Modes**: `400 { code: 'INVALID_INPUT' }`, `403 { code: 'TENANT_MISMATCH' }`, `404 { code: 'NOT_FOUND' }`.
- **Source**: [backend/routes/admin.js#L1276-L1304](../../../backend/routes/admin.js#L1276-L1304)

### `POST /api/admin/stock/force-resync-batch`
- **Auth**: `requirePermission('admin', 'write')`
- **Tenant Source**: JWT oder Body `.tenantId`
- **Request**: `{ "skus": [...], "productIds": [...], "tenantId": "...", "reason": "batch-resync", "limit": <int> }`. Max total 200.
- **Response**: `{ "ok": true, "data": { "total": <int>, "resolved": <int>, "failed": <int>, "notFound": <int>, "results": [...] } }`
- **Side-Effects**: sequentielle `syncStockWithRetry` Calls (schont Rate-Limits).
- **Feature-Flag**: wie oben.
- **Source**: [backend/routes/admin.js#L1317-L1409](../../../backend/routes/admin.js#L1317-L1409)

### `POST /api/admin/stock/drain-failures`
- **Auth**: `requirePermission('admin', 'jobs.run')`
- **Request**: `{ "tenantId": "...", "limit": 50 }`
- **Response**: `{ "ok": true, "data": { "total": <int>, "resolved": <int>, "stillFailing": <int>, "abandoned": <int>, "needsManual": <int> } }`
- **Side-Effects**: `drainStockFailures({ tenantId, limit })` aus `services/stock-failure-drain.js`.
- **Source**: [backend/routes/admin.js#L1411-L1423](../../../backend/routes/admin.js#L1411-L1423)

---

## Identify-Runs Audit + LLM-Parity

### `GET /api/admin/identify-runs`
- **Auth**: `requirePermission('admin', 'read')`
- **Tenant Source**: JWT
- **Request**: Query `?confidence_min=...&confidence_max=...&domain=...&dateFrom=...&dateTo=...&pipeline=v3|v4|all&page=1&pageSize=20`. Pagesize-Cap 100.
- **Response**: `{ "ok": true, "data": { "runs": [...], "total": <int>, "page": 1, "pageSize": 20 } }`
- **Source**: [backend/routes/admin.js#L1437-L1458](../../../backend/routes/admin.js#L1437-L1458)

### `GET /api/admin/llm-parity`
- **Auth**: `requirePermission('admin', 'read')`
- **Request**: Query `?domain=...&dateFrom=...&dateTo=...&pipeline=...`
- **Response**: `{ "ok": true, "data": { "pipelines": [...], "drift_alerts": [...], "total": <int>, "hard_cap": <int> } }`
- **Source**: [backend/routes/admin.js#L1469-L1486](../../../backend/routes/admin.js#L1469-L1486)

---

## Default-Rollen

Aus [backend/lib/rbac.js#L20-L75](../../../backend/lib/rbac.js#L20-L75):

- `admin` — `*.*` (wildcard all)
- `manager` — `dashboard.read, products.read`
- `operation` — `dashboard.read, products.read, inventories.read, warehouse.read+write, orders.read+pick+pack, identify.run, jobs.read`
- `catalog` — `dashboard.read, products.read+write+delete, categories.read+write, identify.run, jobs.read, ai.chat+improve`

⚠️ Admin-Module-Permissions wie `admin.users.read`, `admin.groups.write`, `admin.llm.write` etc. sind in keinem Default-Role — sie sind ausschließlich `admin`-Role (Wildcard) zugänglich. Manueller Override via `setUserOverrides` möglich.
