---
title: API — Master Index
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Master Index

Vollständiger Endpoint-Index, sortiert nach Mount-Reihenfolge der Router in [backend/index.js](../../../backend/index.js).

Querverweise:
- [conventions.md](conventions.md) — Auth, Error-Shape, Pagination, Idempotency, Tenant-ID, `/api`-Prefix, 50 mb Body-Limit.
- Per-Router Deep-Dives: [auth.md](auth.md), [webhooks.md](webhooks.md), [warehouse.md](warehouse.md), [admin.md](admin.md), [orders.md](orders.md), [identify.md](identify.md), [products.md](products.md), [marketplace.md](marketplace.md), [integrations.md](integrations.md), [settings.md](settings.md), [returns.md](returns.md), [invoices.md](invoices.md), [rules.md](rules.md), [sessions.md](sessions.md), [sse.md](sse.md).

Legende:
- 🔓 = public (vor `requireAuth`)
- 🔑 = `requireAuth` only
- 🛡️ = `requirePermission(...)`
- ⚠️ = Anomalie (siehe verlinktes Dokument)

---

## Health (nicht unter /api)

| Method | Path | Auth | Doku |
|---|---|---|---|
| GET | `/` | 🔓 none | — |
| GET | `/health` | 🔓 none | — |
| GET | `/ready` | 🔓 none | — |

---

## Mount #1 — `/api/auth` ([auth.md](auth.md))

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/password-reset` | 🔓 none | Anti-Enumeration; immer `200 ok:true` |

---

## Mount #2 — `/api` Webhooks ([webhooks.md](webhooks.md))

⚠️ Signatur-Verifikation lückenhaft — siehe [webhooks.md](webhooks.md).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/webhooks/sendcloud` | 🔓 none + optional secret | always 200; status-mapping |
| POST | `/api/webhooks/kaufland` | 🔓 none + HMAC (wenn secret) | event-fan-out |
| POST | `/api/webhooks/ebay` | 🔓 none (POST **ungeprüft**) | challenge-code via GET nur |

---

## Mount #3 — `/api/warehouse` ([warehouse.md](warehouse.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/warehouse/zones` | 🛡️ warehouse.read |
| POST | `/api/warehouse/layouts` | 🛡️ warehouse.write |
| DELETE | `/api/warehouse/layouts/:zone/:etage/gangs/:gang` | 🛡️ warehouse.write |
| DELETE | `/api/warehouse/layouts/:zone/:etage/gangs/:gang/regale/:regal` | 🛡️ warehouse.write |
| DELETE | `/api/warehouse/layouts/:zone/:etage/gangs/:gang/regale/:regal/ebenen/:ebene` | 🛡️ warehouse.write |
| GET | `/api/warehouse/zones/:zone/:etage` | 🛡️ warehouse.read |
| GET | `/api/warehouse/bins/labels` | 🛡️ warehouse.read |
| POST | `/api/warehouse/bins/labels` | 🛡️ warehouse.read |
| GET | `/api/warehouse/bins/labels.pdf` | 🛡️ warehouse.read |
| POST | `/api/warehouse/bins/labels.pdf` | 🛡️ warehouse.read |
| GET | `/api/warehouse/bins/:code` | 🛡️ warehouse.read |
| GET | `/api/warehouse/bins/:code/label` | 🛡️ warehouse.read |
| POST | `/api/warehouse/bins/:code/assign` | 🛡️ warehouse.write |
| DELETE | `/api/warehouse/bins/:code/products/:productId` | 🛡️ warehouse.write |
| GET | `/api/warehouse/bins/:code/containers` | 🛡️ warehouse.read |
| POST | `/api/warehouse/bins/:code/containers` | 🛡️ warehouse.write |
| DELETE | `/api/warehouse/bins/:code/containers/:childCode` | 🛡️ warehouse.write |
| POST | `/api/warehouse/stock-in` | 🛡️ warehouse.write |
| POST | `/api/warehouse/stock-out` | 🛡️ warehouse.write |
| POST | `/api/warehouse/refresh-inventory` | 🛡️ warehouse.write |
| GET | `/api/warehouse/settings` | 🔑 requireAuth |
| PUT | `/api/warehouse/settings` | 🔑 requireAuth |
| GET | `/api/warehouse/movements` | 🛡️ warehouse.read |
| GET | `/api/warehouse/inventories` | 🛡️ warehouse.read |
| GET | `/api/warehouse/inventories/:id` | 🛡️ warehouse.read |
| POST | `/api/warehouse/inventories` | 🛡️ warehouse.write |
| POST | `/api/warehouse/inventories/:id/counts` | 🛡️ warehouse.write |
| POST | `/api/warehouse/inventories/:id/complete` | 🛡️ warehouse.write |

---

## Mount #4 — `/api/admin` ([admin.md](admin.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/users` | 🛡️ admin.users.read |
| POST | `/api/admin/users` | 🛡️ admin.users.write |
| PUT | `/api/admin/users/:uid/roles` | 🛡️ admin.users.write |
| PUT | `/api/admin/users/:uid/groups` | 🛡️ admin.users.write |
| PUT | `/api/admin/users/:uid/overrides` | 🛡️ admin.users.write |
| GET | `/api/admin/groups` | 🛡️ admin.groups.read |
| POST | `/api/admin/groups` | 🛡️ admin.groups.write |
| PUT | `/api/admin/groups/:groupId` | 🛡️ admin.groups.write |
| DELETE | `/api/admin/groups/:groupId` | 🛡️ admin.groups.write |
| GET | `/api/admin/roles` | 🛡️ admin.roles.read |
| PUT | `/api/admin/roles/:roleId` | 🛡️ admin.roles.write |
| GET | `/api/admin/llm/scopes` | 🛡️ admin.llm.read |
| GET | `/api/admin/llm/health` | 🛡️ admin.llm.read |
| GET | `/api/admin/llm/scopes/:scopeId` | 🛡️ admin.llm.read |
| POST | `/api/admin/llm/scopes/:scopeId/versions` | 🛡️ admin.llm.write |
| POST | `/api/admin/llm/scopes/:scopeId/activate/:versionId` | 🛡️ admin.llm.write |
| GET | `/api/admin/rulebook` | 🛡️ admin.rules.read |
| PUT | `/api/admin/rulebook` | 🛡️ admin.rules.write |
| POST | `/api/admin/rulebook/apply` | 🛡️ admin.jobs.run |
| GET | `/api/admin/rulebook/apply/:id` | 🛡️ admin.jobs.read |
| GET | `/api/admin/metrics/product-coverage` | 🛡️ admin.users.read |
| POST | `/api/admin/bulk/run` | 🛡️ admin.jobs.run |
| GET | `/api/admin/bulk/jobs/:id` | 🛡️ admin.jobs.read |
| POST | `/api/admin/jobs/gpsr-web-enrich/run` | 🛡️ admin.jobs.run |
| GET | `/api/admin/jobs/status` | 🛡️ admin.jobs.read |
| GET | `/api/admin/email-templates` | 🛡️ admin.read |
| GET | `/api/admin/email-templates/:name/preview` | 🛡️ admin.read |
| GET | `/api/admin/pricing/runner-status` | 🛡️ admin.read |
| GET | `/api/admin/audit-log` | 🛡️ admin.read |
| POST | `/api/admin/admin/marketplace-tracking/retry` ⚠️ Doppel-Prefix | 🛡️ admin.write |
| POST | `/api/admin/admin/marketplace-tracking/push/:orderId` ⚠️ | 🛡️ admin.write |
| POST | `/api/admin/admin/backfill-order-marketplaces` ⚠️ | 🛡️ admin.write |
| GET | `/api/admin/sessions` | 🛡️ admin.read |
| GET | `/api/admin/sessions/active` | 🛡️ admin.read |
| GET | `/api/admin/batch-optimize/preview` | 🛡️ admin.products.write |
| POST | `/api/admin/stock/force-resync` | 🛡️ admin.write |
| POST | `/api/admin/stock/force-resync-batch` | 🛡️ admin.write |
| POST | `/api/admin/stock/drain-failures` | 🛡️ admin.jobs.run |
| GET | `/api/admin/identify-runs` | 🛡️ admin.read |
| GET | `/api/admin/llm-parity` | 🛡️ admin.read |
| POST | `/api/admin/batch-optimize/run` | 🛡️ admin.products.write |

---

## Mount #5 — `/api` Orders ([orders.md](orders.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/orders` | 🛡️ orders.read |
| GET | `/api/dashboard/metrics` | 🛡️ dashboard.read |
| GET | `/api/dashboard/finance` | 🛡️ dashboard.read |
| GET | `/api/dashboard/activity` | 🛡️ orders.read |
| POST | `/api/orders/sync` | 🛡️ orders.read |
| POST | `/api/orders/:orderId/complete` | 🛡️ orders.pick |
| POST | `/api/orders/:orderId/pack` | 🛡️ orders.pack |
| GET | `/api/orders/settings` | 🔑 requireAuth |
| PUT | `/api/orders/settings` | 🔑 requireAuth |
| GET | `/api/shipments` | 🔑 requireAuth |
| POST | `/api/shipments` | 🔑 requireAuth |
| GET | `/api/sync/status` | 🛡️ dashboard.read |
| GET | `/api/orders/statuses` | 🛡️ orders.read |
| GET | `/api/orders/:orderId/detail` | 🛡️ orders.read |
| POST | `/api/orders/:orderId/transition` | 🛡️ orders.write |
| GET | `/api/orders/:orderId/timeline` | 🛡️ orders.read |
| POST | `/api/orders/sync/marketplace` | 🛡️ orders.read |
| GET | `/api/orders/sequences` | 🛡️ orders.read |
| GET | `/api/shipping-methods` | 🛡️ orders.read |
| POST | `/api/shipping-methods/sync` | 🛡️ orders.write |
| GET | `/api/orders/:orderId/shipping-preview` | 🛡️ orders.read |
| POST | `/api/orders/:orderId/ship` | 🛡️ orders.write |
| POST | `/api/orders/:orderId/refresh-shipment` | 🛡️ orders.write |
| POST | `/api/orders/:orderId/cancel-label` | 🛡️ orders.write |
| POST | `/api/orders/:orderId/tracking` | 🛡️ orders.write |
| POST | `/api/orders/:orderId/invoice` | 🛡️ orders.write |
| POST | `/api/orders/:orderId/delivery-note` | 🛡️ orders.write |
| GET | `/api/shipping/methods` | 🛡️ orders.read |
| POST | `/api/invoices/:invoiceId/export-sevdesk` ⚠️ liegt im ordersRouter | 🛡️ orders.write |
| POST | `/api/orders/sync-sendcloud` | 🛡️ orders.write |
| POST | `/api/orders/bulk-ship` | 🛡️ orders.write |
| POST | `/api/orders/bulk-transition` | 🛡️ orders.write |
| PUT | `/api/orders/:orderId` | 🛡️ orders.write |
| GET | `/api/orders/:orderId/label` | 🛡️ orders.read |
| POST | `/api/orders/address-labels` | 🛡️ orders.read |

---

## Mount #6 — `/api` Identify ([identify.md](identify.md))

| Method | Path | Auth |
|---|---|---|
| POST | `/api/jobs` | 🔑 (410 Gone — tombstone) |
| POST | `/api/v2/enrich` | 🛡️ identify.run + identifyLimiter |
| POST | `/api/v2/identify` | 🛡️ identify.run + identifyLimiter |
| GET | `/api/health/external-apis` | 🔑 requireAuth |
| GET | `/api/health/identify` | 🔑 requireAuth |
| GET | `/api/jobs` | 🛡️ jobs.read |
| GET | `/api/jobs/:id` | 🛡️ jobs.read |
| GET | `/api/jobs/:id/stream` | 🛡️ jobs.read (SSE) |
| POST | `/api/jobs/:id/retry` ⚠️ kein RBAC | 🔑 requireAuth |
| POST | `/api/identify` | 🔑 (410 Gone — tombstone) |
| GET | `/api/chat/session/:productId` | 🛡️ ai.chat |
| DELETE | `/api/chat/session/:productId` | 🛡️ ai.chat |
| POST | `/api/chat` | 🛡️ ai.chat + identifyLimiter |
| POST | `/api/v2/group-images` | 🛡️ identify.run |

---

## Mount #7 — `/api` Products ([products.md](products.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/products/:id/bins` | 🛡️ warehouse.read |
| POST | `/api/products/bulk/run` | 🛡️ products.write |
| GET | `/api/products/bulk/jobs/:id` | 🛡️ products.read |
| GET | `/api/inventories` | 🛡️ inventories.read |
| GET | `/api/inventories/:id` | 🛡️ inventories.read |
| GET | `/api/inventories/:id/label.pdf` | 🛡️ inventories.read |
| POST | `/api/inventories/assign` | 🔑 (410 Gone — tombstone) |
| POST | `/api/products/:productId/inventory` | 🛡️ products.write |
| GET | `/api/me/permissions` | 🔑 requireAuth |
| GET | `/api/image-proxy` ⚠️ public | 🔓 none (Auth-Allowlist) |
| POST | `/api/intake/resolve` | 🔑 requireAuth |
| POST | `/api/generate-images` | 🔑 requireAuth |
| POST | `/api/listing-pipeline` | 🛡️ products.write |
| POST | `/api/scanner/capture` | 🛡️ identify.run |
| GET | `/api/categories/profiles` | 🛡️ categories.read |
| PUT | `/api/categories/profiles/:id` | 🛡️ categories.write |
| GET | `/api/products/labels` | 🛡️ products.read |
| POST | `/api/products/bulk-delete` | 🛡️ products.delete |
| DELETE | `/api/products/cleanup-by-alias/:alias` ⚠️ kein RBAC | 🔑 requireAuth |
| POST | `/api/products/bulk-improve` | 🛡️ ai.improve |
| GET | `/api/products` | 🛡️ products.read |
| GET | `/api/products/stream` ⚠️ cross-tenant-leak | 🛡️ products.read (SSE) |
| GET | `/api/products/:id` | 🛡️ products.read |
| GET | `/api/products/:id/label` | 🛡️ products.read |
| POST | `/api/save` | 🛡️ products.write |
| DELETE | `/api/products/:id` | 🛡️ products.delete |
| POST | `/api/price-refresh` ⚠️ kein RBAC | 🔑 requireAuth |
| POST | `/api/products/:id/improve` | 🛡️ ai.improve |
| POST | `/api/improve/jobs` | 🛡️ ai.improve |
| GET | `/api/improve/jobs/:id` | 🛡️ ai.improve |
| POST | `/api/quality/jobs` | 🛡️ jobs.read |
| GET | `/api/quality/jobs/:id` | 🛡️ jobs.read |
| POST | `/api/v1/pricing/suggest/:productId` | 🛡️ products.write |
| POST | `/api/v1/pricing/rules` | 🛡️ products.write |
| GET | `/api/v1/pricing/rules` | 🛡️ products.read |
| POST | `/api/v1/pricing/reprice-batch` | 🛡️ admin.jobs.run |
| DELETE | `/api/v1/pricing/rules/:ruleId` | 🛡️ products.write |
| PATCH | `/api/v1/pricing/rules/:ruleId/toggle` | 🛡️ products.write |
| GET | `/api/v1/forecast/:productId` | 🛡️ products.read |
| GET | `/api/v1/forecast/alerts` | 🛡️ products.read |
| POST | `/api/v1/webhooks` | 🛡️ admin.webhooks.write |
| GET | `/api/v1/webhooks` | 🛡️ admin.webhooks.read |
| DELETE | `/api/v1/webhooks/:id` | 🛡️ admin.webhooks.write |
| GET | `/api/v1/products/duplicates` | 🛡️ products.read |
| GET | `/api/v1/products/merge/suggest` | 🛡️ products.read |
| POST | `/api/v1/products/merge` | 🛡️ products.write |
| GET | `/api/v1/competitors/:productId/history` | 🛡️ products.read |
| GET | `/api/v1/competitors/overview` | 🛡️ products.read |
| PATCH | `/api/v1/products/bulk-update` | 🛡️ products.write |
| GET | `/api/products/export/csv` | 🛡️ products.read |
| POST | `/api/products/import/preview` | 🛡️ products.write |
| POST | `/api/products/import/execute` | 🛡️ products.write |
| POST | `/api/v1/products/validate` | 🛡️ products.read |
| POST | `/api/v1/products/validate-batch` | 🛡️ products.read |

---

## Mount #8 — `/api` Marketplace ([marketplace.md](marketplace.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/ebay/oauth/start` | 🛡️ products.write |
| GET | `/api/ebay/oauth/callback` ⚠️ public | 🔓 none (Auth-Allowlist) |
| GET | `/api/ebay/status` | 🛡️ products.read |
| GET | `/api/ebay/rate-limit-status` | 🛡️ products.read |
| GET | `/api/ebay/trading/status` | 🛡️ products.read |
| GET | `/api/ebay/seller-profiles` | 🛡️ products.read |
| GET | `/api/ebay/category-info/:categoryId` | 🛡️ products.read |
| GET | `/api/ebay/category-specifics/:categoryId` | 🛡️ products.read |
| GET | `/api/competitor-prices` | 🛡️ products.read |
| GET | `/api/ebay/offers` | 🛡️ products.read |
| POST | `/api/ebay/listings/sync` | 🛡️ products.write |
| POST | `/api/ebay/listings/light-sync` | 🛡️ products.read |
| POST | `/api/ebay/listings/repair` | 🛡️ products.write |
| GET | `/api/ebay/listings` | 🛡️ products.read |
| GET | `/api/ebay/listings/:itemId/detail` | 🛡️ products.read |
| GET | `/api/ebay/listings/:itemId/audit` | 🛡️ products.read |
| POST | `/api/ebay/listings/:itemId/audit` | 🛡️ products.read |
| POST | `/api/ebay/listings/:itemId/apply` | 🛡️ products.write |
| POST | `/api/ebay/listings/import/mip` | 🛡️ products.write |
| GET | `/api/ebay/listings/:sku` | 🛡️ products.read |
| POST | `/api/ebay/listing-links/rebuild` | 🛡️ products.write |
| GET | `/api/ebay/listing-links` | 🛡️ products.read |
| GET | `/api/ebay/sku-index` | 🛡️ products.read |
| POST | `/api/kaufland/listings/sync` | 🛡️ products.write |
| GET | `/api/kaufland/bookings` | 🛡️ products.read |
| GET | `/api/kaufland/sku-index` | 🛡️ products.read |
| GET | `/api/kaufland/listings` | 🛡️ products.read |
| POST | `/api/kaufland/publish` | 🛡️ products.write |
| POST | `/api/kaufland/publish/bulk` | 🛡️ products.write |
| GET | `/api/kaufland/publish-runs` | 🛡️ products.read |
| POST | `/api/kaufland/units/bulk-update` | 🛡️ products.write |
| POST | `/api/kaufland/units/bulk-status` | 🛡️ products.write |
| POST | `/api/ebay/gaps/rebuild` | 🛡️ products.write |
| GET | `/api/ebay/gaps` | 🛡️ products.read |
| POST | `/api/ebay/gaps/:id/actions` | 🛡️ products.write |
| POST | `/api/ebay/gaps/:id/bulk-actions` | 🛡️ products.write |
| POST | `/api/ebay/gaps/bulk-prepare-missing` | 🛡️ products.write |
| POST | `/api/ebay/gaps/bulk-prepare-item-specifics` | 🛡️ products.write |
| POST | `/api/ebay/sync/dry-run` | 🛡️ products.write |
| POST | `/api/ebay/sync/apply` | 🛡️ products.write |
| POST | `/api/ebay/update/bulk` | 🛡️ products.write |
| POST | `/api/ebay/listings/end` | 🛡️ products.write |
| POST | `/api/ebay/reports/generate` | 🛡️ products.read |
| POST | `/api/ebay/publish/verify` | 🛡️ products.write |
| POST | `/api/ebay/publish` | 🛡️ products.write |
| POST | `/api/ebay/publish/bulk/verify` | 🛡️ products.write |
| POST | `/api/ebay/publish/bulk` | 🛡️ products.write |
| GET | `/api/ebay/categories` ⚠️ no `ok` wrapper | 🔑 requireAuth |
| GET | `/api/ebay/taxonomy/categories` | 🛡️ products.read |
| GET | `/api/ebay/taxonomy/categories/:id/aspects` | 🛡️ products.read |
| POST | `/api/ktype/upload` ⚠️ kein RBAC | 🔑 requireAuth |

---

## Mount #9 — `/api` Integrations ([integrations.md](integrations.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/integrations/status` | 🔑 requireAuth |
| GET | `/api/integrations/providers` | 🔑 requireAuth |
| POST | `/api/integrations/:type/connect` | 🛡️ integrations.write |
| POST | `/api/integrations/:type/test` | 🛡️ integrations.read |
| PUT | `/api/integrations/:type/settings` | 🛡️ integrations.write |
| DELETE | `/api/integrations/:type` | 🛡️ integrations.write |
| GET | `/api/integrations/:type` | 🛡️ integrations.read |
| GET | `/api/integrations/:type/config` | 🛡️ integrations.read |
| POST | `/api/integrations/:type/sync` | 🛡️ integrations.write |
| PUT | `/api/integrations/:type/defaults` | 🛡️ integrations.write |

---

## Mount #10 — `/api` Settings ([settings.md](settings.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/settings/company` | 🔑 requireAuth |
| PUT | `/api/settings/company` | 🔑 requireAuth |
| GET | `/api/settings/profile` | 🔑 requireAuth |
| PUT | `/api/settings/profile` | 🔑 requireAuth |
| GET | `/api/settings/api-keys` | 🔑 requireAuth |
| POST | `/api/settings/api-keys` | 🔑 requireAuth |
| DELETE | `/api/settings/api-keys/:id` | 🔑 requireAuth |
| GET | `/api/settings/webhooks` | 🔑 requireAuth |
| POST | `/api/settings/webhooks` | 🔑 requireAuth |
| DELETE | `/api/settings/webhooks/:id` | 🔑 requireAuth |
| GET | `/api/settings/billing/usage` | 🔑 requireAuth |

---

## Mount #11 — `/api` Returns ([returns.md](returns.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/returns` | 🔑 requireAuth |
| GET | `/api/returns/reasons` | 🔑 requireAuth |
| POST | `/api/returns` | 🔑 requireAuth |
| POST | `/api/returns/sync` | 🔑 requireAuth |
| POST | `/api/returns/bulk-action` | 🔑 requireAuth |
| PATCH | `/api/returns/:id` | 🔑 requireAuth |
| POST | `/api/returns/:id/process` | 🔑 requireAuth |
| POST | `/api/returns/:id/refund` | 🔑 requireAuth |
| POST | `/api/returns/:id/close` | 🔑 requireAuth |
| GET | `/api/returns/:id/events` | 🔑 requireAuth |

---

## Mount #12 — `/api` Invoices ([invoices.md](invoices.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/invoices` | 🔑 requireAuth |
| POST | `/api/invoices` | 🔑 requireAuth |
| PATCH | `/api/invoices/:id` | 🛡️ orders.write |
| POST | `/api/invoices/import-sevdesk` | 🛡️ orders.write |
| POST | `/api/invoices/bulk-generate` | 🛡️ orders.write |
| GET | `/api/invoices/:invoiceId/download` | 🛡️ orders.read |

(Hinweis: `POST /api/invoices/:invoiceId/export-sevdesk` liegt im **ordersRouter** — siehe [orders.md](orders.md).)

---

## Mount #13 — `/api/v1/rules` ([rules.md](rules.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/v1/rules` | 🔑 requireAuth |
| GET | `/api/v1/rules/jobs/:jobId` | 🔑 requireAuth |
| GET | `/api/v1/rules/:ruleId` | 🔑 requireAuth |
| POST | `/api/v1/rules` | 🔑 requireAuth |
| PUT | `/api/v1/rules/:ruleId` | 🔑 requireAuth |
| DELETE | `/api/v1/rules/:ruleId` | 🔑 requireAuth |
| PATCH | `/api/v1/rules/:ruleId/toggle` | 🔑 requireAuth |
| POST | `/api/v1/rules/:ruleId/execute` | 🔑 requireAuth |
| GET | `/api/v1/rules/:ruleId/preview` | 🔑 requireAuth |

---

## Mount #14 — `/api/sessions` ([sessions.md](sessions.md))

| Method | Path | Auth |
|---|---|---|
| POST | `/api/sessions` | 🔑 requireAuth |
| POST | `/api/sessions/:id/heartbeat` | 🔑 requireAuth |
| POST | `/api/sessions/:id/end` | 🔑 requireAuth |

---

## Mount #15 — `/api` SSE ([sse.md](sse.md))

| Method | Path | Auth |
|---|---|---|
| GET | `/api/events` | 🛡️ dashboard.read (SSE) |

Weitere SSE-Endpoints in anderen Routern:
- `GET /api/products/stream` (productsRouter)
- `GET /api/jobs/:id/stream` (identifyRouter)
- `POST /api/chat?stream=true` (identifyRouter)

---

## Bekannte Anomalien & Hardening-TODOs

| Symptom | Wo | Details |
|---|---|---|
| Webhook-Signatur fehlt/schwach | [webhooks.md](webhooks.md) | eBay POST ungeprüft, Kaufland HMAC kippt bei fehlendem Secret, SendCloud nutzt `String.includes` |
| Doppel-Prefix `/api/admin/admin/...` | [admin.md](admin.md) | Marketplace-Tracking + Backfill-Routes |
| Cross-Tenant-Leak | [products.md](products.md) | `GET /api/products/stream` filtert nicht nach tenantId |
| `tenantId` aus JWT fehlt | [conventions.md](conventions.md) | requireAuth setzt aktuell nur uid/email, kein tenantId → alle Routes fallen auf `'default'` |
| `requirePermission` fehlt auf Schreibe-Routes | mehrere | `POST /api/jobs/:id/retry`, `DELETE /api/products/cleanup-by-alias/:alias`, `POST /api/price-refresh`, `POST /api/ktype/upload`, gesamter `/api/v1/rules` Router, gesamter `/api/returns` Router |
| `POST /api/settings/api-keys` generiert Keys ohne Auth-Verifikations-Layer | [settings.md](settings.md) | Keys werden gespeichert, aber kein Code-Pfad prüft sie |
