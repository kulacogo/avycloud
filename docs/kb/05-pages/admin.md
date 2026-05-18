---
title: Admin (Produkte-Tabelle & Admin-Panel)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Zwei verwandte aber separate Admin-Bereiche:

1. **AdminTable** (`view: 'admin'`) — Master-Produkt-Tabelle für Bulk-Bearbeitung: alle Produkte mit konfigurierbaren Spalten-Presets, Inline-Edit (`useGridEdit`), Bulk-Updates (`useBulkUpdate`), eBay-/Kaufland-Publish, Stock-Sync-Force, K-Type-Upload (KFZ-Fahrzeug-Daten).
2. **AdminPanel** (intern via Tabs in `view: 'admin'` Sub-Route — siehe Routing in App.tsx) — Tenant-Administrations-UI mit Tabs: **Users / Groups / Roles / LLM / Bulk / Integrations / eBay-Taxonomy / Identify-Runs**.

## Komponente(n)

- [components/AdminTable.tsx](../../../components/AdminTable.tsx) — Master-Produkt-Tabelle (Desktop-Centric, mit Mobile-Fallback über `addMediaQueryListener`).
- [components/admin-table/](../../../components/admin-table/) — Sub-Komponenten:
  - `AdminTableHeader.tsx`, `AdminTableRow.tsx`, `AdminTableFilters.tsx`, `BulkActions.tsx`, `BulkDiffPreview.tsx`, `BulkUpdateModal.tsx`, `EditableCell.tsx`.
- [components/admin/AdminPanel.tsx](../../../components/admin/AdminPanel.tsx) — Tab-Container für Admin-Sub-Bereiche.
- [components/admin/AdminUserManagement.tsx](../../../components/admin/AdminUserManagement.tsx) — User-Liste, Invite, Role-Assign.
- [components/admin/AdminGroupManagement.tsx](../../../components/admin/AdminGroupManagement.tsx).
- [components/admin/AdminRoleManagement.tsx](../../../components/admin/AdminRoleManagement.tsx).
- [components/admin/AdminLlmManagement.tsx](../../../components/admin/AdminLlmManagement.tsx) — LLM-Model-Selection / Feature-Flag-UI.
- [components/admin/AdminBulkActions.tsx](../../../components/admin/AdminBulkActions.tsx) — `/api/admin/bulk/run` UI mit DryRun-first.
- [components/admin/AdminIntegrations.tsx](../../../components/admin/AdminIntegrations.tsx).
- [components/admin/AdminEbayTaxonomy.tsx](../../../components/admin/AdminEbayTaxonomy.tsx) — eBay-Kategorie-Cache-Browser.
- [components/admin/AdminIdentifyRunsDashboard.tsx](../../../components/admin/AdminIdentifyRunsDashboard.tsx) — Identify-Run-Aggregate.
- [components/admin/AdminProductCoverageDashboard.tsx](../../../components/admin/AdminProductCoverageDashboard.tsx).
- [components/admin/AdminRulebookManagement.tsx](../../../components/admin/AdminRulebookManagement.tsx).
- [components/admin/AdminJobsManagement.tsx](../../../components/admin/AdminJobsManagement.tsx).

## API-Calls

AdminTable:
- `fetchProducts()` — Vollabzug.
- `runProductBulkAction(action, payload)` / `getProductBulkJob(jobId)` — `/api/products/bulk/run` und Job-Poll (`/api/products/bulk/jobs/{jobId}`).
- `deleteProductsBulk(productIds)`.
- `openProductLabelBatchWindow(productIds)`.
- `assignInventoryToProducts(productIds, inventoryId)`.
- `uploadKTypeCsv(file)` — KFZ-K-Type-Mappings hochladen.
- `bulkVerifyEbayPublish(productIds)`, `bulkPublishToEbay(productIds, overrides)`.
- `fetchEbaySkuIndex()`, `lightSyncEbayLiveListings(payload)`, `bulkUpdateEbayListings(updates)`.
- `fetchKauflandSkuIndex()`, `syncKauflandListings()`.

AdminPanel:
- `adminListUsers()`, `adminInviteUser(payload)`, `adminSetUserRoles(uid, roles)` (AdminUserManagement).
- `adminRunBulkAction(payload)`, `adminGetBulkJob(jobId)` (AdminBulkActions).
- Weitere Admin-Endpunkte pro Sub-Tab (Groups, Roles, LLM, eBay-Taxonomy) — siehe jeweilige Komponente.

Pro-Endpunkt-Doku: `docs/kb/09-api/admin.md`, `docs/kb/09-api/products.md` (TBD).

## Datenquellen

- AdminTable: lokaler `useState`-Produktcache + `InventoryContext`; **kein** React-Query für die Hauptliste.
- `useGridEdit` ([hooks/useGridEdit.ts](../../../hooks/useGridEdit.ts)) — Inline-Edit-Logic mit Dirty-Tracking.
- `useBulkUpdate` ([hooks/useBulkUpdate.ts](../../../hooks/useBulkUpdate.ts)) — Bulk-Diff-Preview + Apply.
- `useAuth` für RBAC-Sichtbarkeit Admin-Tabs.
- `useInventoryContext` für Inventory-Mapping.

## Wichtige Edge-Cases

- **Empty-State**: keine Produkte → Empty-State im Table-Body.
- **Loading**: lokaler Spinner während Initial-Fetch und Bulk-Action.
- **Error**: `Notice` + `ConfirmDialog` für destruktive Aktionen.
- **Bulk-Jobs (async)**: nach `runProductBulkAction` wird `jobId` zurückgegeben und über `getProductBulkJob` gepollt. UI zeigt Progress.
- **K-Type-Upload**: CSV-Validation client-seitig (Größe, Encoding); Backend macht Re-Validation und Diff-Report.
- **Mobile-Fallback**: `addMediaQueryListener` schaltet auf gestapeltes Layout um.
- **Admin-Bulk-Aktionen (z. B. `recategorize_v2`)**: DryRun-first (`apply: false`), Pre-/Post-Count-Guard (Toleranz 10), `MIN_APPLY_CONFIDENCE = 0.8` — siehe CLAUDE.md Admin Bulk-Actions.
- **Manuelle Kategorie-Source-Protection**: `details.categorySource === 'manual'` wird in Bulk-Aktionen geskippt.
- **UI-Source-Protection**: `ops.last_saved_source === 'ui'` wird in Bulk-Aktionen geskippt (außer `includeUi: true`).

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-082** ~1084 Ghost-Produkte in `products_v2` (P0, offen) — sichtbar in AdminTable als nicht-gepublishte Produkte ohne Bestand.
- **BUG-084**/**BUG-085** Dual-Write-Probleme (✅/Code-Fix) — Auswirkungen sichtbar bei AdminTable-Edits.
- **CLAUDE.md Admin Bulk-Actions** — bei jeder neuen Bulk-Action: DryRun, Pre-/Post-Count-Guard, MIN_APPLY_CONFIDENCE, manual-skip, UI-skip dokumentieren.
