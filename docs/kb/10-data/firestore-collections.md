---
title: Firestore Collections — Vollstaendiges Inventar
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Firestore Collections — Vollstaendiges Inventar

> Quelle: Grep ueber `backend/lib/`, `backend/services/`, `backend/routes/`, `backend/scripts/` (Stand 2026-05-18). Bei Konflikten gewinnt der Code.

## Legende

- **Tenant-Scoping**:
  - `TS` — `tenantId` Pflichtfeld, alle Queries scoped.
  - `partial` — `tenantId` optional / Backfill laeuft; Compat-Branch noch aktiv.
  - `none` — kein `tenantId`, alle Mandanten teilen die Doku.
  - `N/A` — Singleton oder global-shared Config.
- **TTL**: Cloud-Firestore-TTL-Policy. AvyCloud hat **keinerlei** automatische TTLs konfiguriert. Drains/Expiry laufen rein applikativ.

## Produkt-Master + SKU

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `products_v2` | `saveProductV2()` ([lib/product-store.js](../../../backend/lib/product-store.js)), `saveProduct()` ([lib/firestore.js](../../../backend/lib/firestore.js)), `warehouse.refreshProductInventory()` ([lib/warehouse.js](../../../backend/lib/warehouse.js)), `stock-sync-dispatcher` (write-back von `ops.ebay.itemId`) | UI (Inventory, ProductSheet), Identify-Pipelines, Stock-Sync, Listing-Sync, Admin Bulk-Ops | partial — `tenantId` Backfill laeuft, Default-Tenant-Compat in `getAllProductsV2ForTenant` ([product-store.js:155](../../../backend/lib/product-store.js)) | keine | Aktiv wenn `USE_PRODUCTS_V2=true` (CLAUDE.md §3 Architektur). Schema: siehe [schemas/product-v2.md](schemas/product-v2.md). |
| `products` | `saveProduct()` ([lib/firestore.js](../../../backend/lib/firestore.js)) wenn `USE_PRODUCTS_V2!=true`; legacy Dual-Write von `warehouse.refreshProductInventory` ([lib/warehouse.js](../../../backend/lib/warehouse.js)) | Legacy-Scripts in `backend/scripts/`; aktive Lese-Pfade nur als Fallback | partial | keine | Legacy-Collection vor V2. Schema ist eine Untermenge von `products_v2`. Wird sukzessive abgebaut. |
| `sku_index` | `ensureSkuUniqueOrThrow()` + `allocateRandomSku10NoLeadingZero()` ([lib/firestore.js](../../../backend/lib/firestore.js)) | `saveProduct()` (dedupe via SKU/EAN/GTIN), Listing-Sync | none — `tenantId` nicht erfasst | keine | DocID-Schema: `sku:<digits>` / `ean:<digits>` / `gtin:<digits>`. Verhindert Duplikat-SKU pro Produkt. Wird in derselben Tx wie Product-Save beschrieben. |
| `categoryProfiles` | `scripts/import-category-profiles-draft-to-firestore.js`, Category-Management-UI | `lib/firestore.js`, `lib/ebay-direct.js`, `routes/products.js` (alle: `CATEGORY_PROFILES_COLLECTION`) | N/A | keine | DocID = eBay-Category-ID. Globale Profile (RequiredAspects-Mappings). |
| `gpsrManufacturers` | `lib/gpsr-manufacturer-registry.js upsertManufacturerGpsr()` | `routes/admin.js`, Identify Stage-3 GPSR-Resolver | N/A | keine | Markenname → Hersteller-Stammdaten (Adresse, EMail, Telefon, EntityCountry). |

## Orders + Order-Lifecycle

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `orders` | `services/order-intake-*.js` (eBay/Kaufland-Intake), `services/order-state-machine.transitionOrder()` ([order-state-machine.js](../../../backend/services/order-state-machine.js)), `lib/firestore.saveOrders()` | UI (Orders, Dashboard), `_onOrderShipped()`, `_onOrderCancelled()`, Picking-Routes, Shipment-Sync | TS — alle aktiven Queries via `where('tenantId', '==', …)`; Aggregat-Queries in `services/order-state-machine.getStatusCounts()` | keine | DocID = `marketplaceOrderId` oder generated. Schema: siehe [schemas/order.md](schemas/order.md). `omsStatus` darf **nur** ueber `transitionOrder()` aktualisiert werden (CLAUDE.md §11). |
| `order_events` | `services/order-state-machine.transitionOrder()` (status_change), `routes/orders.js` (manuelle Notes), `services/shipping-engine.js:1559` (delivered) | `services/order-state-machine.getOrderTimeline()`, UI Order-Detail | TS (`tenantId` wird geschrieben, `orderId` ist der Lese-Key) | keine | Append-only Event-Log. Composite-Index `(orderId, timestamp desc)`. |
| `order_settings` | `routes/orders.js:766` (`/api/orders/settings`) | `routes/orders.js:719`, `services/shipping-engine.js:992` | TS — DocID = `tenantId` | keine | Singleton-Per-Tenant. Felder: Versand-Defaults, Auto-Status-Mapping. **TBD** — Felder im Code verifizieren (`routes/orders.js` GET/POST `/settings`). |

## Shipping

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `shipments` | `services/shipping-engine.js createParcel()` ([:470](../../../backend/services/shipping-engine.js)), `syncSendCloud()` ([:1303](../../../backend/services/shipping-engine.js)), `refreshShipmentFromSendCloud()`, `pollDeliveryStatus()` ([:1542](../../../backend/services/shipping-engine.js)) | UI (Shipments), Order-Detail-Page, `pollDeliveryStatus()` | TS | keine | Schema: siehe [schemas/shipment.md](schemas/shipment.md). Composite-Indexes auf `(tenantId, createdAt desc)`, `(tenantId, status, createdAt desc)`, `(orderId, createdAt desc)`. |
| `shipping_methods` | `services/shipping-engine.syncShippingMethods()` ([:1394](../../../backend/services/shipping-engine.js)) | `services/shipping-engine.getCachedShippingMethods()` | TS — DocID = `${tenantId}_${sendcloudId}` | keine | Cache der SendCloud-Methods. 1 h stale-Check, sonst Re-Sync. Felder: `sendcloudId`, `carrier`, `carrierName`, `name`, `minWeight`, `maxWeight`, `countries[]`, `servicePointInput`, `enabled`, `lastSyncedAt`. |

## Returns

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `returns` | `services/returns-engine.syncEbayReturns()`, `syncKauflandReturns()`, `transitionReturn()`, `processReturn()` ([returns-engine.js](../../../backend/services/returns-engine.js)) | UI (Returns), Cross-Check-Scripts, Sync-Event-Bus (`services/sync-event-bus.js:183`) | TS | keine | DocID-Schema deterministisch: `ebay__<marketplaceReturnId>` / `kaufland__<marketplaceReturnId>` (prevents Race-Duplicates). Schema: siehe [schemas/return.md](schemas/return.md). |
| `return_events` | `services/returns-engine.transitionReturn()` ([:170](../../../backend/services/returns-engine.js)) | UI Return-Detail | TS (via `returnId` → Return-Doc traegt `tenantId`) | keine | Append-only Event-Log. Composite-Index `(returnId, timestamp asc)`. |

## Invoices

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `invoices` | `services/invoice-engine.generateInvoice()` ([:305](../../../backend/services/invoice-engine.js)), `importFromSevDesk()` ([:915](../../../backend/services/invoice-engine.js)), `createCorrectionInvoice()` ([:1080](../../../backend/services/invoice-engine.js)) | `routes/invoices.js`, UI Invoices, Retry-Scripts | TS | keine | Beinhaltet Original-Rechnungen UND Stornos/Gutschriften (gleiche Collection). Composite-Indexes auf `(tenantId, createdAt desc)`, `(tenantId, status, createdAt desc)`. Schema: siehe [schemas/invoice.md](schemas/invoice.md). |

## Warehouse + Bins + Stock

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `warehouseBins` | `routes/warehouse.js`, `lib/warehouse.js bookStockIn()/bookStockOut()` ([:930](../../../backend/lib/warehouse.js)) | `refreshProductInventory()`, `listBinsForProduct()`, UI Warehouse | none — `tenantId` derzeit nicht erfasst | keine | DocID = Bin-Code (z. B. `M-EG-3-2-A`). Array-Feld `products[]` mit `{productId, sku, quantity, name, firstStoredAt, lastUpdatedAt}`. |
| `warehouseEvents` | `lib/warehouse.js writeWarehouseEventTx()` ([:27](../../../backend/lib/warehouse.js)) — bei jedem `bookStockIn` / `bookStockOut` | Debug-Scripts (`scripts/deepdive-sku.js`), Audit | none | keine | Append-only Audit-Log fuer Bin-Bewegungen. Schema: siehe [schemas/stock-events.md](schemas/stock-events.md). |
| `warehouseZones` | `lib/warehouse.js` (Zonen-Setup) | `lib/warehouse.js` | none | keine | Liste der Lager-Zonen (X, XS, S, M, L, XL, XQ, P). **TBD** — Schema/Writer im Code verifizieren. |
| `warehouse_inventories` | `routes/warehouse.js` (CRUD) — als `INVENTORIES_COLLECTION = 'warehouse_inventories'` ([:606](../../../backend/routes/warehouse.js)) | `routes/warehouse.js` | TS — siehe Routen-Logik | keine | **Warenkorb-/Bestands-Listen** (separate vom Storage-Bin-Begriff). NICHT identisch mit `inventories` (siehe unten — legacy). |
| `warehouse_settings` | `routes/warehouse.js:547` | `routes/warehouse.js:529` | TS — DocID = `tenantId` | keine | Singleton-Per-Tenant. **TBD** — Feldliste im Code verifizieren. |
| `warehouse_movements` | `services/returns-engine.restockItem()` ([:304](../../../backend/services/returns-engine.js)) | Reporting | TS | keine | Logged Wiedereinlagerungen aus Retouren. Composite-Index `(tenantId, type, createdAt asc)`. Felder: `tenantId, type, productSku, productName, quantity, condition, returnId, orderId, note, createdAt`. |
| `inventory_ledger` | `lib/stock-change-events.notifyStockChange()` ([:74](../../../backend/lib/stock-change-events.js)) | Debug (`scripts/deepdive-sku.js`), Audit | TS (Feld wird beschrieben, nicht im Query genutzt) | keine | **Append-only Truth-Log fuer alle `inventory.quantity`-Mutationen.** Gated by `INVENTORY_LEDGER_ENABLED!=false`. Schema: siehe [schemas/stock-events.md](schemas/stock-events.md). |
| `stock_sync_log` | `services/stock-sync-dispatcher.js:429,515` | Debug, UI Stock-History | TS | keine | Log der Marketplace-Stock-Pushes (eBay/Kaufland). Composite-Indexes auf `(tenantId, createdAt desc)` und `(productId, createdAt desc)`. |
| `stock_reservations` | `services/stock-reservation.reserveStock()` ([:57](../../../backend/services/stock-reservation.js)), `releaseReservation()`, `confirmReservation()`, `expireStaleReservations()` | `getReservedQuantity()` (via `stock-sync-dispatcher.computeAvailableQuantity()`), UI Reservations | TS | none (applikativ via `expiresAt` + `expireStaleReservations()`) | Statuswerte: `reserved`, `confirmed`, `released`, `expired`. Default-Expiry `STOCK_RESERVATION_EXPIRY_HOURS=72`. Composite-Indexes `(tenantId, status)` + `(status, expiresAt asc)`. |
| `stock_operation_failures` | `services/order-state-machine.js:354` (Phase-B-Failures), `services/stock-sync-dispatcher.js:47` | `services/stock-failure-drain.js` (Retry), `scripts/diagnose-stock-sku.js` | TS | keine | Retry-Queue. Status: `pending`/`done`/`needs_manual`. Composite-Index `(tenantId, createdAt asc)`. Drain konsumiert nur `step: 'marketplaceSync'`. |
| `stock_sync_failures` | `services/stock-sync-dispatcher.persistSyncFailureForDrain()` ([:38](../../../backend/services/stock-sync-dispatcher.js)) | (Aktuell nur write — alerting/dashboard **TBD im Code verifizieren**) | TS | keine | Spiegelt Sync-Failures fuer Reporting. Parallel zu `stock_operation_failures`. |
| `stock_locks` | `lib/stock-lock.tryAcquireFirestoreLock()` ([:49](../../../backend/lib/stock-lock.js)) | dito (Tx-Read) | none — `tenantId` nicht erfasst | applikativ via `expiresAtMs`-Lease | DocID = encodeURIComponent(lockKey). Felder: `key, ownerId, acquiredAtMs, expiresAtMs, updatedAt`. Default-Lease `STOCK_LOCK_LEASE_MS=30000`. Backend ueber `STOCK_LOCK_BACKEND=firestore` aktiv (CLAUDE.md §12). |

## Identification + Improve Jobs

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `identificationJobs` | `lib/jobs.createJob()/updateJob()/claimJob()` ([jobs.js](../../../backend/lib/jobs.js)) | `services/job-runner.js`, `routes/identify.js:1185` (snapshot listener) | partial — `tenantId` ueber Payload | keine | Asynchrone Identify-V2/V3/V4-Jobs. Status: `pending`/`processing`/`completed`/`failed`. Dead-Letter via `moveToDeadLetter()` → `deadLetterJobs`. |
| `deadLetterJobs` | `lib/jobs.moveToDeadLetter()` ([:174](../../../backend/lib/jobs.js)) | `lib/jobs.listDeadLetterJobs()` | partial | keine | Failed Identify-Jobs nach Max-Retries. DocID = original jobId. |
| `improveJobs` | `lib/improve-jobs.createJob()/updateJob()/claimJob()` ([improve-jobs.js](../../../backend/lib/improve-jobs.js)) | `services/improve-runner.js` (TBD), `scripts/inspect-job.js` | partial | keine | Asynchrone Improve-Jobs (Quality-Verbesserung bestehender Produkte). Gleiches Pattern wie `identificationJobs`. |
| `jobs` | `scripts/purge-jobs.js` (purge), Legacy-Job-System | (Legacy) | partial | keine | Legacy-Collection vor `identificationJobs`/`improveJobs`. Sollte leer sein. **TBD** — pruefen ob noch beschrieben wird. |

## Chat

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `chatSessions` | `lib/chat-sessions.appendMessages()` ([chat-sessions.js](../../../backend/lib/chat-sessions.js)) | `lib/chat-sessions.getSession()/getGeminiHistory()`, `routes/identify.js:1313` | none — keyed nach `userId__productId`, kein `tenantId` | applikativ: `MAX_MESSAGES = 20` (10 Pairs, last-N-trim) | DocID-Schema: `sanitize(userId)__sanitize(productId)`. Felder: `id, userId, productId, messages[], createdAt, updatedAt`. |

## LLM-Config + Telemetry

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `llmScopes` | `lib/llm-config.js` (Scope-CRUD), `scripts/seed-llm-scopes.js`, `scripts/migrate-llm-scope-schema.js` | `lib/llm-config.getActiveConfig()`, `routes/admin.js`, alle LLM-Pipelines | N/A | keine | DocID = Scope-ID (`chat.product`, `identify.v2`, `improve.product`, `quality.gate`, `image.generation`, …). Aktive Version-Pointer + Default-Model-Env-Key. |
| `llmScopes/{id}/versions` | `lib/llm-config.createVersion()` ([:269](../../../backend/lib/llm-config.js)) | `lib/llm-config.getVersion()/listVersions()`, `routes/admin.js` | N/A | keine | Subcollection. Jede Scope-Version ist immutable + hat eine UUID-DocID. Promotion via Parent-Doc-Update. |
| `llm_call_telemetry` | `lib/llm-telemetry.logLlmCall()` → batched flush ([llm-telemetry.js:243](../../../backend/lib/llm-telemetry.js)) | Dashboard/Aggregation **TBD** (Charta §Telemetrie) | TS | keine | Sample-Rate-gated via `LLM_TELEMETRY_SAMPLE` (default 0.1, Auto-Downgrade nach 24 h ueber 0.5 via `system/llm-telemetry-state`). DocID-Sharding: `${random8}-${ts}-${productId}`. Schema: siehe [schemas/llm-telemetry.md](schemas/llm-telemetry.md). Composite-Index `(tenantId, scope, timestamp desc)`. |
| `external_api_calls` | `lib/external-api-tracker.trackExternalCall()` ([external-api-tracker.js](../../../backend/lib/external-api-tracker.js)) | `getExternalApiStats()` → `/api/health/identify` | TS | keine | Sample-Rate via `EXTERNAL_API_TRACKER_SAMPLE_RATE` (default 1.0). Felder: `tenantId, timestamp, service, endpoint, success, latencyMs, errorCode, errorMessage`. |

## Marketplace-Mirror

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `ebayListingLinks` | `services/listing-sync-runner.js`, eBay-Publish-Routen ([routes/marketplace.js](../../../backend/routes/marketplace.js)) | Stock-Sync-Resolver, Listing-Audits | TS — siehe Code | keine | SKU ↔ eBay-ItemID-Mapping pro Listing-Variant. **TBD** — Feldliste im Code verifizieren. |
| `ebayListingsLive` | `services/listing-sync-runner.js`, eBay-Light-Sync | `services/stock-sync-dispatcher.resolveEbayItemIdFromLiveListing()` ([:69](../../../backend/services/stock-sync-dispatcher.js)) | TS | keine | Live-Snapshot der aktiven eBay-Listings. Felder: mindestens `sku, itemId, active, …`. **TBD** — vollstaendige Felder im Code verifizieren. |
| `ebayListingGaps` | `services/listing-sync-runner.js` (Audit) | UI eBay-Listings-Audit | TS | keine | Differenz-Report: in `products_v2` aber nicht auf eBay (oder umgekehrt). **TBD** — Schema im Code verifizieren. |
| `kauflandUnitsLive` | `services/kaufland-listings-sync.js:52` | `services/stock-sync-dispatcher.js:299,306` (lookup), Kaufland-Publish | TS | keine | Live-Snapshot der Kaufland-Unit-IDs pro SKU. **TBD** — vollstaendiges Schema im Code verifizieren. |
| `kaufland_publish_runs` | `services/kaufland-publish-audit.js` (`COLLECTION_NAME` ([:31](../../../backend/services/kaufland-publish-audit.js))) | `routes/marketplace.js:1459` | TS | keine | Audit-Doku pro Bulk-Publish-Run. Felder: `startedAt, finishedAt, totals, perItemStatus[], errors[]`. **TBD** — exakte Felder im Code verifizieren. |

## Pricing

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `pricingRules` | `routes/products.js:2383,2399` | `routes/products.js:2358`, Pricing-Engine | TS — siehe Code | keine | UI-konfigurierte Preisregeln. **TBD** — Felder im Code verifizieren. |
| `priceHistory` | `lib/competitor-prices.js:235`, `routes/products.js:2520,2536` | UI Price-History-Chart | TS | keine | Wettbewerber-Preise + History. **TBD** — Feldliste vollstaendig im Code verifizieren. |

## Settings + Auth

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `company_settings` | `routes/settings.js:51` | `routes/settings.js:19`, `services/invoice-engine.getCompanySettings()` | TS — DocID = `tenantId` | keine | Firmenstammdaten (Name, Adresse, Tax-ID, IBAN, Logo). Verwendet fuer Invoice-PDFs. |
| `user_profiles` | `routes/settings.js:106` | `routes/settings.js:72` | N/A — DocID = Firebase-`uid` | keine | User-Praeferenzen. **TBD** — Felder im Code verifizieren. |
| `api_keys` | `routes/settings.js:146` | `routes/settings.js:121`, API-Auth-Middleware | TS | keine | Per-Tenant API-Keys fuer Public-API. Composite-Index `(tenantId, createdAt desc)`. |
| `webhooks` | `routes/settings.js:195` | `routes/settings.js:169`, Webhook-Dispatcher | TS | keine | Outgoing Webhook-Subscriptions. **TBD** — Felder im Code verifizieren. |
| `tenants` | `scripts/cassini-backfill.js:189,207` (lesen) | dito | N/A — DocID = `tenantId` | keine | Tenant-Stammdaten (Name, ENV-Flags, Limits). **TBD** — Schema im Code/Operator-Doku verifizieren. |

## Rule-Engine

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `rulebookConfigs` | `lib/rulebook-admin.js`, `lib/rulebook-config.js` | Rulebook-Runner, Admin-UI | TS | keine | Konfigurierbare Regelsaetze (Quality-Gate, Pricing-Hints). |
| `rulebookConfigs/{id}/versions` | `lib/rulebook-admin.js` (Promotion) | Rulebook-Runner | TS | keine | Subcollection. Immutable Versionen, Active-Pointer im Parent-Doc. |

## Runtime-Flags + Ops

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `config` | Admin (manuell via Firestore-Console / Admin-UI) | `lib/firestore.getRuntimeFlagsCached()` ([:131](../../../backend/lib/firestore.js)) | N/A | applikativ (60 s TTL-Cache via `RUNTIME_FLAGS_TTL_MS`) | DocID = `runtimeFlags`. Bool-Feature-Flags ohne Redeploy. ENV-Override via `RUNTIME_FLAG_<NAME>`. |
| `system/llm-telemetry-state` | `lib/llm-telemetry.getSampleRateFromState()` (Auto-Downgrade-Write) | dito | N/A | keine | Single-Doc. Felder: `sampleRate, changedAt, previousRate, reason`. |
| `ops/ebayLightSync` | `lib/ebay-direct.js:1550` (Lock) | dito | N/A | applikativ ueber TTL-Feld im Doc | DocID = `ebayLightSync` in `ops`-Collection. Distributed-Lock fuer eBay-Light-Sync-Cron. |

## Legacy + Sonstiges

| Collection | Primary Writers | Primary Readers | Tenant-Scoping | TTL | Notes |
|------------|-----------------|-----------------|----------------|-----|-------|
| `inventories` | `lib/firestore.js:170` (`INVENTORIES_COLLECTION = 'inventories'`) | `lib/firestore.js` (inventoryCollection-Helper) | partial | keine | **Legacy** — Inventur/Bestands-Liste. NICHT identisch mit `warehouse_inventories` aus `routes/warehouse.js`. **TBD** — pruefen welche Collection aktiv genutzt wird; Hinweis: konkurrierende Definitionen. |
| `inventorySyncLogs` | `lib/firestore.js:3990` | (Reporting) | partial | keine | Log der Inventur-Sync-Aktionen. **TBD** — Felder verifizieren. |
| `trendocean/product_images` (Subcollection `images`) | `lib/product-images.recordManualProductImage()` ([product-images.js](../../../backend/lib/product-images.js)) | (Audit) | none — Pfad ist fest auf `trendocean` gemappt | keine | Subcollection-Struktur: `trendocean` (Collection) → `product_images` (Doc, traegt `last_activity`/`last_product_id`) → `images` (Subcollection) mit Per-Upload-Doku. **Tenant-fest auf `trendocean`** — Multi-Tenant-Migration steht aus. |

## Aussortiert / Nicht in Use

Es existieren **keine** Referenzen mehr auf:
- `baselinker_*` (BaseLinker ist TABU, CLAUDE.md §9)
- Externe SQL/Redis-Connectoren

---

**Vollstaendigkeits-Hinweis.** Diese Liste basiert auf einer Grep-Inventur (Stand 2026-05-18). Wenn ein Caller eine Collection via Variable adressiert (z. B. `firestore.collection(varName)`), kann sie hier fehlen. Bei Unsicherheit: in `backend/` mit `rg "\.collection\(['\\\"]<name>['\\\"]\)"` verifizieren.
