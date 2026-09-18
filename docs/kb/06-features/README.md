---
title: Feature-Index
for: [dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# Feature-Index

Diese KB-Sektion beschreibt die Produkt-Features von AvyCloud auf KB-Niveau (Was/Wie/Code-Pfade/Flags). Detaillierte Spezifikationen liegen unter `docs/features/<ID>/spec.md` und werden hier verlinkt.

## Was es macht

Jede `.md`-Datei in diesem Ordner dokumentiert ein Feature mit demselben Schema:

- **Was es macht** — 1–3 Sätze
- **Wie es funktioniert** — Sequenz, Liste oder Mermaid
- **Code-Pfade** — Backend + Frontend
- **Feature-Flags** — relevante ENV-Vars
- **API-Endpoints** — Verweis auf `docs/kb/09-api/`
- **UI-Pages** — Verweis auf `docs/kb/05-pages/`
- **Spec** — Link zu `docs/features/<ID>/spec.md` (falls vorhanden)
- **Bekannte Issues** — TASKS.md BUG-Nummern

## Feature-zu-Code-zu-Spec-Map

| Feature | KB-Doku | Backend (Hauptdateien) | Frontend (Hauptdateien) | Spec | Status |
|---|---|---|---|---|---|
| Identify Pipeline (V3 + V4) | [identify-pipeline.md](identify-pipeline.md) | `backend/services/identify-v3.js`, `backend/services/identify-v4.js`, `backend/lib/identify-v3-stage1..4.js`, `backend/lib/identify-workers/*`, `backend/routes/identify.js` | `components/IdentifyV4Badge.tsx`, `components/IdentifyHealthTile.tsx`, `components/IdentifyQueueView.tsx`, `components/AdminIdentifyRunsDashboard.tsx` | [identify-v4/spec.md](../../features/identify-v4/spec.md) | V3 default-on, V4 dark-deployed |
| Chat Assistant (V3 → V2 → Legacy Cascade) | [chat-assistant.md](chat-assistant.md) | `backend/services/product-chat-v3.js`, `backend/services/product-chat-v2.js`, `backend/services/product-chat.js`, `backend/services/atomic-tools.js`, `backend/lib/cross-reference.js`, `backend/lib/confidence-scoring.js` | `components/GeminiChat.tsx` | [archivierte Chat-V3-Spec](../../archive/features/implemented-llm/chat-assistant-v3-spec.md) | V3 default-on |
| Improve Pipeline | [improve-pipeline.md](improve-pipeline.md) | `backend/services/improve.js`, `backend/services/improve-runner.js`, `backend/lib/improve-jobs.js` | `components/ProductSheet.tsx` (Improve-Trigger) | TBD | Production |
| Pricing Engine | [pricing-engine.md](pricing-engine.md) | `backend/services/pricing-engine.js`, `backend/services/pricing-runner.js`, `backend/lib/sweet-spot-pricer.js`, `backend/lib/price-enrichment.js`, `backend/lib/competitor-prices.js` | `components/PricingDashboard.tsx`, `components/pricing/*` | [archivierte PRICE-001-Spec](../../archive/features/completed/PRICE-001-pricing-engine-ui-spec.md) | Backend prod, UI-Build |
| Rule Engine | [rule-engine.md](rule-engine.md) | `backend/services/rule-engine.js`, `backend/services/rule-runner.js`, `backend/routes/rules.js`, `backend/lib/rulebook-admin.js` | `components/RuleDashboard.tsx`, `components/rules/*` | [archivierte RULE-001-Spec](../../archive/features/completed/RULE-001-rule-engine-spec.md) | Production |
| Bulk Editing | [bulk-editing.md](bulk-editing.md) | `backend/services/bulk-update.js`, `backend/services/batch-optimize.js`, `backend/services/admin-bulk-actions.js`, `backend/services/admin-bulk-runner.js` | `components/AdminTable.tsx`, `components/admin-table/BulkDiffPreview.tsx`, `components/admin-table/BulkUpdateModal.tsx`, `components/admin-table/BulkActions.tsx` | [archivierte BULK-001-Spec](../../archive/features/completed/BULK-001-bulk-editing-spec.md) | Production |
| Stock Management | [stock-management.md](stock-management.md) | `backend/lib/warehouse.js`, `backend/lib/stock-lock.js`, `backend/lib/stock-change-events.js`, `backend/services/stock-failure-drain.js`, `backend/services/stock-reservation.js`, `backend/services/stock-sync-dispatcher.js`, `backend/lib/order-stock-claim.js` | `components/InventoryView.tsx`, `components/InventoryDrilldownPanel.tsx` | TBD (siehe `11-rules-and-invariants/stock-single-writer.md`) | Production |
| Order Lifecycle | [order-lifecycle.md](order-lifecycle.md) | `backend/services/order-state-machine.js`, `backend/services/order-intake-ebay.js`, `backend/services/order-intake-kaufland.js`, `backend/services/order-source-router.js`, `backend/services/order-sync.js`, `backend/services/sync-event-bus.js` | `components/OrdersView.tsx`, `components/OrderDetail.tsx`, `components/orders/ShippingDecisionDialog.tsx` | TBD (siehe `02-architecture/eventing.md`) | Production |
| Shipping Engine | [shipping-engine.md](shipping-engine.md) | `backend/services/shipping-engine.js`, `backend/services/marketplace-tracking.js`, `backend/lib/sendcloud.js` | `components/orders/ShippingView.tsx`, `components/orders/ShippingDecisionDialog.tsx` | TBD | Production |
| Returns Workflow | [returns-workflow.md](returns-workflow.md) | `backend/services/returns-engine.js`, `backend/routes/returns.js` | `components/orders/ReturnsView.tsx` | TBD | Production |
| Invoice Generation | [invoice-generation.md](invoice-generation.md) | `backend/services/invoice-engine.js`, `backend/routes/invoices.js`, `backend/lib/sevdesk.js`, `backend/services/number-sequence.js` | `components/orders/InvoicesView.tsx` | TBD | Production |
| Warehouse Bins | [warehouse-bins.md](warehouse-bins.md) | `backend/lib/warehouse.js`, `backend/routes/warehouse.js`, `backend/services/label-printer.js` | `components/WarehouseView.tsx`, `components/warehouse/WarehouseInventoryTab.tsx`, `components/warehouse/WarehouseMovementsTab.tsx`, `components/warehouse/WarehouseSettingsView.tsx` | TBD (WH-001 spec nicht vorhanden) | Production |
| Audit Log | [audit-log-feature.md](audit-log-feature.md) | `backend/services/audit-log.js`, `backend/routes/admin.js` (`/audit-log`) | `components/AuditLogView.tsx` | TBD | Production |
| Error Dashboard | [error-dashboard.md](error-dashboard.md) | `backend/lib/error-collector.js`, `backend/services/error-dashboard.js`, `backend/routes/products.js` (`/api/v1/errors*`) | `components/ErrorDashboard.tsx`, `components/error-dashboard/*` | [archivierte ERR-001-Spec](../../archive/features/completed/ERR-001-error-dashboard-spec.md) | Production |
| Pre-Listing Validation | [pre-listing-validation.md](pre-listing-validation.md) | `backend/services/listing-validator.js`, `backend/routes/products.js` (`/api/v1/products/validate*`) | `components/ValidationPanel.tsx` | [archivierte VAL-001-Spec](../../archive/features/completed/VAL-001-pre-listing-validation-spec.md) | Production |
| Recategorize V2 (Bulk) | [recategorize-v2.md](recategorize-v2.md) | `backend/services/admin-bulk-actions.js` (`runBulkRecategorizeV2`), `backend/services/category-resolver.js`, `backend/scripts/recategorize-disallowed-ebay-roots.js` | `components/admin/AdminBulkActions.tsx` | TBD | Production |

## Quereinstieg

- Architektur-Überblick: `docs/kb/02-architecture/`
- API-Referenz: `docs/kb/09-api/` (TBD)
- UI-Pages: `docs/kb/05-pages/` (TBD)
- Invarianten (z. B. Stock Single Writer): `docs/kb/11-rules-and-invariants/`
- Aktive Tasks/Bugs: `TASKS.md`
- Nicht-verhandelbare Regeln: `CLAUDE.md`

## Bekannte Issues

Konkrete Bug-IDs werden pro Feature unter `## Bekannte Issues` aufgelistet, sobald `TASKS.md` konsolidiert ist. Quelle bleibt `TASKS.md` im Repo-Root.
