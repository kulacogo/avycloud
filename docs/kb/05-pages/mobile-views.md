---
title: Mobile Views (Mobile UI-Fallbacks)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

AvyCloud rendert auf schmalen Viewports (Mobile-Breakpoints) dedizierte Mobile-Komponenten statt der Desktop-Pendants. Drei zentrale Mobile-Views werden in [App.tsx](../../../App.tsx) per `addMediaQueryListener` ([utils/mediaQuery.ts](../../../utils/mediaQuery.ts)) eingeblendet. Mobile-Navigation läuft über [MobileTabBar.tsx](../../../components/MobileTabBar.tsx) statt Sidebar.

## Komponente(n)

- [components/DashboardMobile.tsx](../../../components/DashboardMobile.tsx) — Mobile-Dashboard (vgl. [dashboard.md](dashboard.md)).
- [components/MobileOperationsView.tsx](../../../components/MobileOperationsView.tsx) — Mobile-Operations (vgl. [operations.md](operations.md)).
- [components/MobileSearchView.tsx](../../../components/MobileSearchView.tsx) — Mobile-Volltextsuche über Produkte (Mobile-only, kein Desktop-Pendant; Sidebar-Suche ersetzt die Desktop-Variante).
- [components/MobileTabBar.tsx](../../../components/MobileTabBar.tsx) — Bottom-Tabbar-Navigation für Mobile.
- [components/operations/QuantityNumpad.tsx](../../../components/operations/QuantityNumpad.tsx) — Touch-Numpad (von MobileOperationsView verwendet).

## API-Calls

DashboardMobile (siehe [dashboard.md](dashboard.md) für Details):
- `fetchDashboardMetrics`, `fetchFinanceMetrics`, `fetchOrders`, `syncOrders`.

MobileOperationsView (siehe [operations.md](operations.md) für Details):
- `fetchOrders`, `syncOrders`, `completeOrder`, `packOrder`, `packAndShip`, `stockInProduct`, `stockOutProduct`, `fetchProfile`, `fetchShippingPreview`, `updateOrderWeight`.

MobileSearchView:
- Keine direkten API-Calls (Stand 2026-05-18). Sucht in `products`-Prop, der von App.tsx kommt. Nutzt `useI18n` und `getProductQuantity` aus [utils/product.ts](../../../utils/product.ts).

Pro-Endpunkt-Doku: siehe entsprechende Desktop-Page-Docs.

## Datenquellen

- Gleicher React-Query- bzw. `useState`-Cache wie die Desktop-Varianten (App.tsx reicht die `products`-Prop durch).
- `useI18n`, `compareBinCodesForPickRoute` für Pick-Routen-Sortierung.
- `addMediaQueryListener` für reaktiven Breakpoint-Switch.
- `UploadGroupPayload` aus `useIdentification` für Mobile-Identify-Trigger aus dem Stow-Modus.

## Wichtige Edge-Cases

- **Breakpoint-Race**: bei dynamischem Resize (z. B. Browser-Devtools) kann es kurzzeitig zu Doppel-Mount-Effekten kommen — `addMediaQueryListener` debounced nicht.
- **Scanner**: MobileOperationsView nutzt ZXing wie Desktop, aber mit größerem Overlay und Auto-Refocus.
- **Numpad**: `QuantityNumpad` ist Touch-optimiert (große Buttons, Haptic via vibration-API falls verfügbar).
- **Empty-State**: jeweils View-spezifisch — Search zeigt leere Liste mit Hinweis, Operations zeigt CTA, Dashboard rendert Skeleton.
- **Loading**: kompakte Skeletons.
- **Error**: Toast (über `ToastContext`).
- **PWA**: AvyCloud hat `manifest.webmanifest` ([manifest.webmanifest](../../../manifest.webmanifest)) — Mobile-Views sind für Standalone-Install ausgelegt.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-077** Mobile UI: Kommissionieren + Operationen (✅ gefixt, P2). MobileOperationsView ist der Hauptfix-Träger.
- **BUG-091** Multi-Identify hängt bei vielen Produkten (P0, Code-Fix ausstehend) — wirkt sich auf CaptureView aus, indirekt auf Mobile-Workflows die im Stow-Modus identifizieren.
