---
title: API — Marketplace (eBay + Kaufland)
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Marketplace

Mount: `app.use('/api', marketplaceRouter)` ([backend/index.js#L247](../../../backend/index.js#L247)). Globale `requireAuth` greift (Ausnahme: `/api/ebay/oauth/callback` ist in der Auth-Allowlist).

Quelle: [backend/routes/marketplace.js](../../../backend/routes/marketplace.js).

Libraries:
- [backend/lib/ebay-oauth.js](../../../backend/lib/ebay-oauth.js) — OAuth-Flow + Token-Verwaltung in `integrations/ebay`.
- [backend/lib/ebay-direct.js](../../../backend/lib/ebay-direct.js) — Trading + Sell API.
- [backend/lib/ebay-trading-api.js](../../../backend/lib/ebay-trading-api.js) — Trading API Auth'n'Auth Modus.
- [backend/lib/ebay-listings.js](../../../backend/lib/ebay-listings.js), [backend/lib/ebay-listing-audit.js](../../../backend/lib/ebay-listing-audit.js)
- [backend/lib/kaufland-api.js](../../../backend/lib/kaufland-api.js).
- [backend/services/kaufland-listings-sync.js](../../../backend/services/kaufland-listings-sync.js).
- [backend/services/kaufland-publish-audit.js](../../../backend/services/kaufland-publish-audit.js).

Tenant-Source: `req.user?.tenantId` (oder `'default'` für globale Reads). Listing-Links und Bulk-Publish-Audit-Runs sind tenant-scoped.

---

## eBay OAuth

### `GET /api/ebay/oauth/start`

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: none
- **Request**: Query `?locale=de-DE&prompt=login` (prompt optional)
- **Response**: `{ "ok": true, "data": { "url": "https://auth.ebay.com/oauth2/authorize?..." } }`
- **Side-Effects**:
  - `createOAuthState({ provider: 'ebay', actor: req.user })` legt nonce-Doc an.
  - `buildConsentUrl({ state, locale, prompt })` baut consent URL.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/marketplace.js#L196-L211](../../../backend/routes/marketplace.js#L196-L211)

### `GET /api/ebay/oauth/callback`

⚠️ **Public — in der Auth-Allowlist** ([backend/index.js#L237](../../../backend/index.js#L237)). eBay-Redirect ohne Authorization.

- **Auth**: none
- **Tenant Source**: aus consumed state (`actor`)
- **Request**: Query `?code=...&state=...`
- **Response**: HTML-Seite die das Popup schließt + `postMessage('avycloud:ebay_oauth_complete')` an Opener.
- **Side-Effects**:
  - `consumeOAuthState(state, 'ebay')` (one-shot).
  - `exchangeAuthorizationCodeForToken({ code })`.
  - `upsertEbayTokenSet(tokenSet, { actor })` → schreibt `integrations/ebay`.
- **Failure Modes**:
  - `400 'Missing code/state' | 'Invalid state'`.
  - `500` HTML-Fehlerseite.
- **Source**: [backend/routes/marketplace.js#L214-L268](../../../backend/routes/marketplace.js#L214-L268)

---

## eBay Status & Limits

### `GET /api/ebay/status`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": { "connected": true, "env": "production", "scopes": [...], "accessTokenExpiresAt": "..." } }`. Quelle: `publicStatus(integrationDoc)`.
- **Source**: [backend/routes/marketplace.js#L274-L283](../../../backend/routes/marketplace.js#L274-L283)

### `GET /api/ebay/rate-limit-status`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": {...usage} }` aus [backend/lib/ebay-rate-limiter.js](../../../backend/lib/ebay-rate-limiter.js).
- **Source**: [backend/routes/marketplace.js#L286-L294](../../../backend/routes/marketplace.js#L286-L294)

### `GET /api/ebay/trading/status`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": {...tradingStatus} }`. Failure: `400 { code: 'EBAY_TRADING_CONFIG_MISSING' }` wenn Auth'n'Auth-Token nicht konfiguriert.
- **Source**: [backend/routes/marketplace.js#L297-L313](../../../backend/routes/marketplace.js#L297-L313)

### `GET /api/ebay/seller-profiles`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": {...profiles} }` — Trading-API-Pfad (legacy).
- **Source**: [backend/routes/marketplace.js#L315-L328](../../../backend/routes/marketplace.js#L315-L328)

---

## eBay Categories & Specifics

### `GET /api/ebay/category-info/:categoryId`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": {...info} }`. Trading API `GetCategoryFeatures`.
- **Source**: [backend/routes/marketplace.js#L334-L345](../../../backend/routes/marketplace.js#L334-L345)

### `GET /api/ebay/category-specifics/:categoryId`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": {...specifics} }`.
- **Source**: [backend/routes/marketplace.js#L347-L358](../../../backend/routes/marketplace.js#L347-L358)

### `GET /api/ebay/categories`

⚠️ **Andere Response-Shape** — `{ items: [...] }` ohne `ok` Wrapper.

- **Auth**: requireAuth (kein `requirePermission`)
- **Request**: Query `?q=<text>&id=<id>&leafOnly=true&limit=50` (max 200)
- **Response**: `{ "items": [{ "id": "...", "name": "...", "breadcrumb": "...", "leaf": true|false }] }`
- **Source**: [backend/routes/marketplace.js#L1965-L1995](../../../backend/routes/marketplace.js#L1965-L1995)

### `GET /api/ebay/taxonomy/categories`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?includeBanned=false&leafOnly=false`
- **Response**: `{ "ok": true, "data": { "items": [...], "total": <int>, "includeBanned": false, "leafOnly": false } }`
- **Source**: [backend/routes/marketplace.js#L2002-L2042](../../../backend/routes/marketplace.js#L2002-L2042)

### `GET /api/ebay/taxonomy/categories/:id/aspects`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": { "category": {...}, "catalog": { "required": [...], "recommended": [...], "optional": [...] } } }`
- **Failure Modes**: `400` (missing id), `404`.
- **Source**: [backend/routes/marketplace.js#L2044-L2078](../../../backend/routes/marketplace.js#L2044-L2078)

---

## Competitor Prices

### `GET /api/competitor-prices`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?ean=<8-14 digits>&productId=<id>` (productId optional, für `priceHistory`-Log)
- **Response**: `{ "ok": true, "data": { ...prices, "cached": <bool> } }`
- **Side-Effects**: `getCompetitorPrices(ean)`. Falls `productId` und !cached: fire-and-forget `logPriceHistory()`.
- **Failure Modes**: `400` für ungültige EAN.
- **Source**: [backend/routes/marketplace.js#L364-L382](../../../backend/routes/marketplace.js#L364-L382)

---

## eBay Listings (Live Cache)

Cache-Collection (default): `ebayListingsLive`. Sync-Service: [backend/lib/ebay-direct.js](../../../backend/lib/ebay-direct.js).

### `GET /api/ebay/offers`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?sku=...`
- **Response**: `{ "ok": true, "data": [...offers] }` (eBay Sell API).
- **Failure Modes**: `400` ohne sku, `5xx`/`4xx` aus eBay-API.
- **Source**: [backend/routes/marketplace.js#L388-L402](../../../backend/routes/marketplace.js#L388-L402)

### `POST /api/ebay/listings/sync`

- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "maxPages": 10, "entriesPerPage": 100, "detailConcurrency": 4, "timeoutMs": 25000, "runId": "..." }`. Defaults siehe Code.
- **Response**: `{ "ok": true, "data": { ...summary, "ingest": { "activeListings": <int> } } }`
- **Side-Effects**: `syncLiveListingsAndAudit()` (Trading API ActiveList + per-Item GetItem); emit `listings:sync_completed`.
- **Failure Modes**: `400 { code: 'EBAY_TRADING_CONFIG_MISSING' }`, `500`.
- **Source**: [backend/routes/marketplace.js#L408-L444](../../../backend/routes/marketplace.js#L408-L444)

### `POST /api/ebay/listings/light-sync`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: `{ "maxPages": 50, "entriesPerPage": 200, "timeoutMs": 25000, "runId": "..." }`
- **Response**: `{ "ok": true, "data": { ...summary, "skipped": <bool> } }`
- **Side-Effects**: nur ActiveList (kein GetItem per Listing). Server-side cooldown/lock verhindert Spam.
- **Source**: [backend/routes/marketplace.js#L448-L482](../../../backend/routes/marketplace.js#L448-L482)

### `POST /api/ebay/listings/repair`

- **Auth**: `requirePermission('products', 'write')`
- **Response**: `{ "ok": true, "data": { "repaired": <int>, ... } }`
- **Side-Effects**: `reactivateWronglyDeactivatedListings()`; emit `listings:sync_completed` falls repaired > 0.
- **Source**: [backend/routes/marketplace.js#L486-L505](../../../backend/routes/marketplace.js#L486-L505)

### `GET /api/ebay/listings`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?limit=100&search=...&matchStatus=...&includeInactive=false`
- **Response**: `{ "ok": true, "data": [...listings] }`. ETag-fähig, 5 min Cache.
- **Source**: [backend/routes/marketplace.js#L507-L533](../../../backend/routes/marketplace.js#L507-L533)

### `GET /api/ebay/listings/:itemId/detail`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": {...detail} }` oder `404`.
- **Source**: [backend/routes/marketplace.js#L535-L554](../../../backend/routes/marketplace.js#L535-L554)

### `GET /api/ebay/listings/:itemId/audit`
### `POST /api/ebay/listings/:itemId/audit`

- **Auth**: `requirePermission('products', 'read')`
- **POST Request**: `{ "forceRefresh": false, "timeoutMs": 25000, "runId": "..." }`
- **Response**: `{ "ok": true, "data": {...audit} }` mit suggestions/gaps.
- **Failure Modes**: `404 { code: 'EBAY_LISTING_NOT_FOUND' }`.
- **Source**:
  - [backend/routes/marketplace.js#L556-L575](../../../backend/routes/marketplace.js#L556-L575)
  - [backend/routes/marketplace.js#L577-L604](../../../backend/routes/marketplace.js#L577-L604)

### `POST /api/ebay/listings/:itemId/apply`

- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "suggestionIds": [...], "patch": {...}, "timeoutMs": 25000, "runId": "..." }`
- **Response**: `{ "ok": true, "data": {...result} }`
- **Failure Modes**: `400` (missing inputs), `409 { code: 'EBAY_APPLY_INVENTORY_MODEL' }`, `500`.
- **Source**: [backend/routes/marketplace.js#L606-L643](../../../backend/routes/marketplace.js#L606-L643)

### `POST /api/ebay/listings/import/mip`

CSV-Import (Marketplace-Identifier-Mapping).

- **Auth**: `requirePermission('products', 'write')` + multer (`ktypeUploadMiddleware`)
- **Request**: `multipart/form-data` mit `file`
- **Response**: `{ "ok": true, "data": {...report} }`
- **Source**: [backend/routes/marketplace.js#L646-L662](../../../backend/routes/marketplace.js#L646-L662)

### `GET /api/ebay/listings/:sku`

⚠️ Muss **nach** `/api/ebay/listings/:itemId/...` und `/listings/import/...` definiert werden.

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": {...listing} }` oder `404`.
- **Source**: [backend/routes/marketplace.js#L665-L681](../../../backend/routes/marketplace.js#L665-L681)

---

## eBay Listing-Links (Product ↔ Listing)

Collection: `ebayListingLinks`.

### `POST /api/ebay/listing-links/rebuild`

- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "itemIds": [...], "runId": "..." }`
- **Response**: `{ "ok": true, "data": {...summary} }`
- **Side-Effects**: tenant-scoped `buildProductListingLinks()`.
- **Source**: [backend/routes/marketplace.js#L687-L709](../../../backend/routes/marketplace.js#L687-L709)

### `GET /api/ebay/listing-links`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?limit=200` (max 500)
- **Response**: `{ "ok": true, "data": [...rows] }`
- **Source**: [backend/routes/marketplace.js#L711-L724](../../../backend/routes/marketplace.js#L711-L724)

### `GET /api/ebay/sku-index`

- **Auth**: `requirePermission('products', 'read')`
- **Response**: `{ "ok": true, "data": [{ "itemId": "...", "sku": "...", "productId": "...", "viewItemUrl": "..." }] }`
- **Side-Effects**: Joint von `ebayListingsLive (active: true)` mit `ebayListingLinks (status: matched)`. Filtert stale Links.
- **Source**: [backend/routes/marketplace.js#L733-L790](../../../backend/routes/marketplace.js#L733-L790)

---

## eBay Gaps (Audit-Suggestions)

Collection: `ebayListingGaps`.

### `POST /api/ebay/gaps/rebuild`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "itemIds": [...], "runId": "..." }`
- **Response**: `{ "ok": true, "data": {...summary} }`
- **Source**: [backend/routes/marketplace.js#L1556-L1575](../../../backend/routes/marketplace.js#L1556-L1575)

### `GET /api/ebay/gaps`
- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?limit=200&status=...&severity=...&itemId=...`
- **Response**: `{ "ok": true, "data": [...rows] }`
- **Source**: [backend/routes/marketplace.js#L1577-L1607](../../../backend/routes/marketplace.js#L1577-L1607)

### `POST /api/ebay/gaps/:id/actions`
### `POST /api/ebay/gaps/:id/bulk-actions`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "gapId": "..." | "gapIds": [...], "action": "...", "note": "...", "alias": {...} }`
- **Response**: `{ "ok": true, "data": {...} }`. `400 { code: 'EBAY_GAP_...' }` für bekannte Errors.
- **Source**:
  - [backend/routes/marketplace.js#L1609-L1640](../../../backend/routes/marketplace.js#L1609-L1640)
  - [backend/routes/marketplace.js#L1642-L1673](../../../backend/routes/marketplace.js#L1642-L1673)

### `POST /api/ebay/gaps/bulk-prepare-missing`
### `POST /api/ebay/gaps/bulk-prepare-item-specifics`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "itemIds": [...], "mode": "missing_ebay" | "all" }`
- **Response**: `{ "ok": true, "data": {...} }`
- **Source**:
  - [backend/routes/marketplace.js#L1675-L1694](../../../backend/routes/marketplace.js#L1675-L1694)
  - [backend/routes/marketplace.js#L1696-L1715](../../../backend/routes/marketplace.js#L1696-L1715)

---

## eBay Sync / Update

### `POST /api/ebay/sync/dry-run`
### `POST /api/ebay/sync/apply`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "itemIds": [...] }` (null = all)
- **Response**: `{ "ok": true, "data": {...} }`
- **Source**:
  - [backend/routes/marketplace.js#L1721-L1738](../../../backend/routes/marketplace.js#L1721-L1738)
  - [backend/routes/marketplace.js#L1740-L1757](../../../backend/routes/marketplace.js#L1740-L1757)

### `POST /api/ebay/update/bulk`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "itemIds": [...] }` ODER `{ "applyAll": true }`
- **Response**: `{ "ok": true, "data": {...} }`
- **Failure Modes**: `400` wenn weder `itemIds` noch `applyAll`.
- **Source**: [backend/routes/marketplace.js#L1759-L1786](../../../backend/routes/marketplace.js#L1759-L1786)

---

## eBay End / Reports / Publish

### `POST /api/ebay/listings/end`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "itemId": "...", "reason": "NotAvailable" | "..." }`
- **Response**: `{ "ok": true, "data": {...result} }`
- **Side-Effects**: Trading-API `EndItem` oder `EndFixedPriceItem` (auto-detected via `GetItem`). Lokales `ebayListingsLive`-Doc → `active: false`, `endedAt`, `endingReason`.
- **Source**: [backend/routes/marketplace.js#L1792-L1843](../../../backend/routes/marketplace.js#L1792-L1843)

### `POST /api/ebay/reports/generate`
- **Auth**: `requirePermission('products', 'read')`
- **Request**: `{ "outDir": "/tmp/..." }` (optional)
- **Response**: `{ "ok": true, "data": {...report} }`
- **Source**: [backend/routes/marketplace.js#L1849-L1863](../../../backend/routes/marketplace.js#L1849-L1863)

### `POST /api/ebay/publish/verify`
### `POST /api/ebay/publish`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "productId": "...", "overrides": { /* shipping/return/payment policy IDs etc. */ } }`
- **Response**: `{ "ok": true, "data": {...result} }`
- **Side-Effects**:
  - `verifyPublishProduct` ist read-only Pre-Check.
  - `publishProduct` führt AddFixedPriceItem aus. Greift bei Fehler auf `services/ebay-auto-fix.js` (siehe CLAUDE.md).
  - Overrides werden mit Tenant-Defaults via `mergeEbayOverrides` gemergt.
- **Source**:
  - [backend/routes/marketplace.js#L1869-L1889](../../../backend/routes/marketplace.js#L1869-L1889)
  - [backend/routes/marketplace.js#L1891-L1913](../../../backend/routes/marketplace.js#L1891-L1913)

### `POST /api/ebay/publish/bulk/verify`
### `POST /api/ebay/publish/bulk`
- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "productIds": [...], "overrides": {...} }`
- **Response**: `{ "ok": true, "data": {...result} }`
- **Failure Modes**: `400` ohne `productIds`.
- **Source**:
  - [backend/routes/marketplace.js#L1915-L1935](../../../backend/routes/marketplace.js#L1915-L1935)
  - [backend/routes/marketplace.js#L1937-L1959](../../../backend/routes/marketplace.js#L1937-L1959)

---

## Kaufland — Sync & Listings

### `POST /api/kaufland/listings/sync`

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: JWT
- **Request**: Body/Query `?storefront=de`
- **Response**: `{ "ok": true, "data": { "storefront": "de", "fetched": <int>, "active": <int>, "driftsDetected": <int>, "reconciled": <int>, "reverseDriftsDetected": <int>, "reverseDriftSamples": [...] } }`
- **Side-Effects**: `syncKauflandListingsCache({ tenantId, storefront })` aus `services/kaufland-listings-sync.js`. Refresht `kauflandUnitsLive`, backfillt `ops.kaufland.unitId`.
- **Source**: [backend/routes/marketplace.js#L801-L815](../../../backend/routes/marketplace.js#L801-L815)

Auch als Safety-Net-Cron alle 15 min ([backend/index.js#L432-L452](../../../backend/index.js#L432-L452)).

### `GET /api/kaufland/bookings`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?from=YYYY-MM-DD&to=YYYY-MM-DD&storefront=de&limit=&offset=`
- **Response**: `{ "ok": true, "data": { "total_payout_cents": <int>, "total_payout_eur": <eur>, "currency": "EUR", "count": <int>, "bookings": [...], "reportId": "...", "reportUrl": "...", "endpointUsed": "..." } }`
- **Side-Effects**: Kaufland Reports API.
- **Failure Modes**:
  - `400 { code: 'INVALID_DATE_RANGE' | 'KAUFLAND_BOOKINGS_DATE_INVALID' }`.
  - `502 { code: 'KAUFLAND_BOOKINGS_ENDPOINT_UNKNOWN' }`.
  - `504 { code: 'KAUFLAND_BOOKINGS_TIMEOUT' }`.
- **Source**: [backend/routes/marketplace.js#L820-L869](../../../backend/routes/marketplace.js#L820-L869)

### `GET /api/kaufland/sku-index`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?storefront=de`
- **Response**: `{ "ok": true, "data": [{ "idUnit": "...", "sku": "...", "ean": "...", "status": "AVAILABLE|ONHOLD", "active": true, "productValid": true|false|null, "idProduct": <int>, "viewItemUrl": "..." }] }`
- **Source**: [backend/routes/marketplace.js#L872-L914](../../../backend/routes/marketplace.js#L872-L914)

### `GET /api/kaufland/listings`

Enriched Kaufland-Listings (Join `kauflandUnitsLive` + `products_v2` + Legacy `products.storageBins`).

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?storefront=de`
- **Response**: `{ "ok": true, "data": [{ "idUnit": "...", "sku": "...", "ean": "...", "title": "...", "brand": "...", "price": ..., "currentPrice": ..., "listingPrice": ..., "minimumPrice": ..., "quantity": ..., "warehouseStock": ..., "binLocation": "...", "stockMismatch": <bool>, "imageUrl": "...", "category": "..." }] }`
- **Side-Effects**: read-only; Multi-Key-Lookup (SKU + stripped SKU + EAN).
- **Source**: [backend/routes/marketplace.js#L917-L1093](../../../backend/routes/marketplace.js#L917-L1093)

---

## Kaufland Publish

### `POST /api/kaufland/publish`

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: implicit
- **Request**: `{ "productId": "...", "storefront": "de" }`
- **Response**: `201 { "ok": true, "data": {...result} }`.
- **Side-Effects**: `createUnit(product, { storefront })` aus kaufland-api.
- **Failure Modes**:
  - `400 { code: 'MISSING_PRODUCT_ID' | 'KAUFLAND_EAN_INVALID' | 'KAUFLAND_EAN_MISSING' }`.
  - `404 { code: 'PRODUCT_NOT_FOUND' }`.
  - `202 { ok: true, data: { productDataSubmitted: true, message: ... } }` — wenn Kaufland Produkt-Daten erstmal indizieren muss.
- **Source**: [backend/routes/marketplace.js#L1099-L1127](../../../backend/routes/marketplace.js#L1099-L1127)

### `POST /api/kaufland/publish/bulk`

Komplexer Bulk-Publish mit Auto-Fix pro Produkt (EAN, Price, Shipping Group, Warehouse, 0-Stock-Handling, GPSR-Web-Lookup).

- **Auth**: `requirePermission('products', 'write')`
- **Tenant Source**: JWT
- **Request**:
  ```json
  {
    "productIds": [...],
    "storefront": "de",
    "publishWithOnHold": true,
    "overrides": { "shippingGroupId": 144080, "warehouseId": 70462 }
  }
  ```
- **Response**: `{ "ok": true, "data": { "total": <int>, "ok": <int>, "failed": <int>, "skipped": <int>, "repaired": <int>, "results": [{ "productId": "...", "ok": true|false, "status": "published|fixed|skipped|failed", "fixes": [...], "reason": "...", "data": {...} }], "runId": "...", "auditUrl": "..." } }`
- **Side-Effects**:
  - Pro Produkt `autoFixProduct()` (siehe Code für Heuristiken — Price-Derive aus EK × 1.40, default Shipping-Group, Warehouse, GPSR-Web-Lookup).
  - Audit-Run via `services/kaufland-publish-audit.js` (`kaufland_publish_runs`-Collection).
  - 202-Path mit `KAUFLAND_PRODUCT_DATA_PENDING` → try-repair-hook via `kaufland-product-data-repair`.
- **Failure Modes**:
  - `400 { code: 'MISSING_PRODUCT_IDS' }`.
- **Source**: [backend/routes/marketplace.js#L1129-L1454](../../../backend/routes/marketplace.js#L1129-L1454) (komplexer Handler)

### `GET /api/kaufland/publish-runs`

- **Auth**: `requirePermission('products', 'read')`
- **Request**: Query `?limit=20` (max 50)
- **Response**: `{ "ok": true, "data": [...runs] }`. Tenant-filter wenn `req.user.tenantId` gesetzt.
- **Source**: [backend/routes/marketplace.js#L1456-L1468](../../../backend/routes/marketplace.js#L1456-L1468)

### `POST /api/kaufland/units/bulk-update`

Pusht Price + Stock pro Unit nach Kaufland.

- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "unitIds": [...] }` (max 100)
- **Response**: `{ "ok": true, "data": { "total": <int>, "success": <int>, "failed": <int>, "results": [{ "unitId": "...", "ok": true|false, "updated": <bool>, "error": "..." }] } }`
- **Side-Effects**: pro Unit `updateUnit(unitId, product, { storefront: 'de' })`.
- **Failure Modes**: `400 { code: 'MISSING_UNIT_IDS' }`.
- **Source**: [backend/routes/marketplace.js#L1471-L1517](../../../backend/routes/marketplace.js#L1471-L1517)

### `POST /api/kaufland/units/bulk-status`

Setzt Unit-Status auf `AVAILABLE` oder `ONHOLD`.

- **Auth**: `requirePermission('products', 'write')`
- **Request**: `{ "unitIds": [...], "status": "AVAILABLE" | "ONHOLD" }`. Max 100.
- **Response**: `{ "ok": true, "data": { "total": <int>, "success": <int>, "failed": <int>, "results": [...] } }`
- **Side-Effects**: pro Unit `setUnitStatus` + lokales `kauflandUnitsLive`-Update.
- **Failure Modes**: `400 { code: 'MISSING_UNIT_IDS' | 'INVALID_STATUS' }`.
- **Source**: [backend/routes/marketplace.js#L1520-L1550](../../../backend/routes/marketplace.js#L1520-L1550)

---

## K-Type CSV Upload

### `POST /api/ktype/upload`

⚠️ **Kein `requirePermission`** — Diskrepanz (sehr mächtiger Bulk-Update-Endpoint).

- **Auth**: requireAuth + multer (`ktypeUploadMiddleware`)
- **Tenant Source**: none
- **Request**: `multipart/form-data` mit `file` (eBay-CSV-Export). Optional Query/Body `?dryRun=true`.
- **Response**: `{ "ok": true, "report": { "dryRun": <bool>, "parsed": {...}, "processed": <int>, "updated": <int>, "unchanged": <int>, "notFound": [...], "errors": [...], "samples": { "updated": [...], "notFound": [...] } } }`
- **Side-Effects**: pro CSV-Zeile `SKU → KTyp` lookup + Update auf `products` (legacy collection!) `details.attributes["K-Typ"]` + `ops.revision++`, `ops.last_saved_source: 'ktype-upload'`. Concurrency 10.
- **Source**: [backend/routes/marketplace.js#L2085-L2221](../../../backend/routes/marketplace.js#L2085-L2221)
