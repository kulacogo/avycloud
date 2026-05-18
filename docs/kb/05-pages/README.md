---
title: UI Pages — Übersicht & View-zu-Komponente-zu-API Map
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

# 05-pages — UI-View-Dokumentation

> Diese Sektion enthält **eine Datei pro Top-Level-View** im AvyCloud Frontend.
> Quellverzeichnis: [components/](../../../components/). Routing-Quelle: [App.tsx](../../../App.tsx) (`View`-Union).
> KB-Konvention: nichts wird hier geraten. Wenn eine Komponente nicht eindeutig auffindbar ist, wird sie als `TBD` markiert.

## Wann welche Datei lesen

- **User**: lies nur den Zweck-Abschnitt der jeweiligen Page-Datei.
- **Developer**: lies "Komponente(n)" + "API-Calls" + "Datenquellen". Springe danach in den Code.
- **Admin / Operator**: lies "Bekannte Issues" + "Edge-Cases" — relevant für Support-Tickets und Daten-Recovery.

## Master-Map (View → Komponente → wichtigste API-Calls)

| Page-Doc | View-Key (App.tsx) | Haupt-Komponente | Wichtige API-Aufrufe |
|---|---|---|---|
| [dashboard.md](dashboard.md) | `dashboard` | [Dashboard.tsx](../../../components/Dashboard.tsx) / [DashboardMobile.tsx](../../../components/DashboardMobile.tsx) | `fetchDashboardMetrics`, `fetchFinanceMetrics`, `fetchSyncStatus`, `fetchReorderAlerts`, `fetchActivityFeed`, `fetchOrders` |
| [inventory.md](inventory.md) | `inventory` | [InventoryView.tsx](../../../components/InventoryView.tsx) | `fetchProducts`, `fetchEbaySkuIndex`, `fetchKauflandSkuIndex` |
| [orders.md](orders.md) | `orders` | [OrdersView.tsx](../../../components/OrdersView.tsx) | `useOrders` (`fetchOrders`), `syncOrders`, `syncMarketplaceOrders`, `bulkTransitionOrders`, `printAddressLabels` |
| [shipping.md](shipping.md) | `orders-shipping` | [orders/ShippingView.tsx](../../../components/orders/ShippingView.tsx) | `fetchShipments`, `bulkShipOrders`, `syncSendCloudParcels`, `fetchShippingMethods` |
| [returns.md](returns.md) | `orders-returns` | [orders/ReturnsView.tsx](../../../components/orders/ReturnsView.tsx) | `fetchReturns`, `fetchReturnEvents`, `updateReturn`, `syncReturns`, `processReturn`, `issueReturnRefund`, `closeReturn`, `bulkReturnAction` |
| [invoices.md](invoices.md) | `orders-invoices` | [orders/InvoicesView.tsx](../../../components/orders/InvoicesView.tsx) | `fetchInvoices`, `updateInvoiceStatus`, `downloadInvoicePdfBlob` |
| [warehouse.md](warehouse.md) | `warehouse`, `warehouse-settings` | [WarehouseView.tsx](../../../components/WarehouseView.tsx) + [warehouse/WarehouseSettingsView.tsx](../../../components/warehouse/WarehouseSettingsView.tsx) | `fetchWarehouseZones`, `fetchWarehouseBins`, `fetchWarehouseBinDetail`, `createWarehouseLayoutApi`, `removeProductFromBinApi`, `fetchWarehouseSettings`, `saveWarehouseSettings` |
| [operations.md](operations.md) | `operations`, `operations-identify`, `operations-stow`, `operations-pick`, `operations-pack` | [OperationsView.tsx](../../../components/OperationsView.tsx) / [MobileOperationsView.tsx](../../../components/MobileOperationsView.tsx) | `fetchWarehouseBinDetail`, `stockInProduct`, `stockOutProduct`, `fetchOrders`, `syncOrders`, `completeOrder`, `packOrder`, `packAndShip`, `fetchShippingPreview`, `updateOrderWeight` |
| [marketplace-listings.md](marketplace-listings.md) | `marketplace-ebay`, `marketplace-kaufland` | [MarketplaceListingsView.tsx](../../../components/MarketplaceListingsView.tsx) | `useEbayListings`, `useKauflandListings`, `syncEbayLiveListings`, `syncKauflandListings`, `bulkPublishToEbay`, `bulkPublishToKaufland`, `bulkUpdateEbayListings`, `endEbayListing`, `repairEbayListings`, `forceResyncStockBatch` |
| [capture.md](capture.md) | `input` | [capture/CaptureView.tsx](../../../components/capture/CaptureView.tsx) (+ Step-Komponenten) | `useIdentification` (Upload-Pipeline), `useImproveQueue` |
| [product-sheet.md](product-sheet.md) | `sheet` | [ProductSheet.tsx](../../../components/ProductSheet.tsx) | `saveProduct`, `fetchProductById`, `stockInProduct`, `stockOutProduct`, `fetchProductBins`, `generateProductImages`, `createQualityJobs`, `pollQualityJob`, `fetchEbayCategories`, `setProductInventoryId` |
| [chat.md](chat.md) | (im ProductSheet eingebettet) | [GeminiChat.tsx](../../../components/GeminiChat.tsx) + [chat/*](../../../components/chat/) | `startChatStream` (SSE), `getChatSession`, `clearChatSession` via `useChatStream` |
| [deduplication.md](deduplication.md) | `duplicates` | [DeduplicationView.tsx](../../../components/DeduplicationView.tsx) | `fetchDuplicates`, `fetchMergeSuggestion`, `executeMerge` |
| [audit-log.md](audit-log.md) | `audit-log` | [AuditLogView.tsx](../../../components/AuditLogView.tsx) (+ [UserSessionsTab.tsx](../../../components/UserSessionsTab.tsx)) | `fetchAuditLog`, `fetchSessions`, `fetchActiveSessions` |
| [identify-queue.md](identify-queue.md) | `queue` (Backlog-View, app-internal) | [IdentifyQueueView.tsx](../../../components/IdentifyQueueView.tsx) (+ [IdentifyHealthTile.tsx](../../../components/IdentifyHealthTile.tsx)) | `fetchIdentificationJobs`, `retryIdentificationJob`, `fetchIdentifyHealth` |
| [admin.md](admin.md) | `admin` | [AdminTable.tsx](../../../components/AdminTable.tsx) + [admin/AdminPanel.tsx](../../../components/admin/AdminPanel.tsx) | `fetchProducts`, `runProductBulkAction`, `getProductBulkJob`, `deleteProductsBulk`, `adminListUsers`, `adminRunBulkAction`, `adminGetBulkJob` |
| [settings.md](settings.md) | `orders-settings`, `settings-profile`, `settings-api`, `settings-billing` | [orders/OrderSettingsView.tsx](../../../components/orders/OrderSettingsView.tsx), [settings/CompanySettings.tsx](../../../components/settings/CompanySettings.tsx), [settings/ProfileSettings.tsx](../../../components/settings/ProfileSettings.tsx), [settings/ApiSettings.tsx](../../../components/settings/ApiSettings.tsx), [settings/BillingSettings.tsx](../../../components/settings/BillingSettings.tsx) | `fetchOrderSettings`, `saveOrderSettings`, `fetchCompanySettings`, `saveCompanySettings`, `fetchProfile`, `saveProfile`, `fetchApiKeys`, `createApiKey`, `revokeApiKey`, `fetchWebhooks`, `createWebhook`, `deleteWebhook`, `fetchBillingUsage`, `fetchShippingMethods`, `syncShippingMethods`, `syncSendCloudParcels` |
| [mobile-views.md](mobile-views.md) | `dashboard` / `operations*` / `search` (Mobile-Breakpoint) | [DashboardMobile.tsx](../../../components/DashboardMobile.tsx), [MobileOperationsView.tsx](../../../components/MobileOperationsView.tsx), [MobileSearchView.tsx](../../../components/MobileSearchView.tsx) | Wie Dashboard / Operations, plus Touch-/Scanner-spezifische Flows |

## Querverweise

- **Routing-Quelle**: [App.tsx](../../../App.tsx) `View`-Union (Stand 2026-05-18: ~40 View-Keys).
- **Sidebar/Topbar-Navigation**: [components/Sidebar.tsx](../../../components/Sidebar.tsx), [components/Topbar.tsx](../../../components/Topbar.tsx), [components/MobileTabBar.tsx](../../../components/MobileTabBar.tsx).
- **API-Layer**: [api/client.ts](../../../api/client.ts) — alle Frontend → Backend Calls laufen hier durch. Pro-Endpunkt-Doku unter [docs/kb/09-api/](../09-api/) (noch nicht angelegt; verlinkt sobald vorhanden).
- **Hooks**: [hooks/](../../../hooks/) — React-Query Wrapper (`useOrders`, `useListings`, `useInventories`, `useIdentification`, …) und SSE (`useSSE`, `useChatStream`).
- **Context**: [context/](../../../context/) — `AuthContext`, `InventoryContext`, `ToastContext`, `CookieConsentContext`.

## Konventionen für neue Page-Dateien

1. Frontmatter mit `title`, `for: [user, dev, admin]` (Untermenge möglich), `lastReviewed: YYYY-MM-DD`.
2. Sektionen in dieser Reihenfolge: **Zweck**, **Komponente(n)**, **API-Calls**, **Datenquellen**, **Wichtige Edge-Cases**, **Bekannte Issues**.
3. Niemals raten — wenn etwas nicht eindeutig im Code auffindbar ist: `TBD – Component nicht eindeutig auffindbar`.
4. Bekannte Issues immer mit `BUG-XXX`-Verweis auf [TASKS.md](../../../TASKS.md) verlinken, sonst nicht aufnehmen.
