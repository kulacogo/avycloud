---
title: Dashboard
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Einstiegs-View nach Login: KPI-Karten (Umsatz, Bestellungen, Bestand, Margin), Finance-Chart (Recharts ComposedChart), Sync-Status, Reorder-Alerts und Activity-Feed. Default-Range konfigurierbar (Heute / 7 Tage / Monat / Letzter Monat / Jahr / Gesamt / Custom). Auf Mobile-Breakpoints wird `DashboardMobile` statt `Dashboard` gerendert.

## Komponente(n)

- [components/Dashboard.tsx](../../../components/Dashboard.tsx) — Desktop-Variante, Recharts-Charts, KPI-Karten mit Skeleton-Loading, Range-Preset-Selector (`PRESETS`: today, last7, this_week, month_to_date, last_month, year_to_date, all_time, custom).
- [components/DashboardMobile.tsx](../../../components/DashboardMobile.tsx) — Mobile-Variante mit kompakteren Cards, Touch-Targets und Bin-Code-Sort über `compareBinCodesForPickRoute` für Pick-Routen-Vorschauen.

## API-Calls

- `fetchDashboardMetrics({ days, preset, from?, to? })` — KPI-Aggregate (Umsatz, Orders, Margin). Siehe [api/client.ts](../../../api/client.ts).
- `fetchFinanceMetrics({ days, preset })` — Time-Series für Recharts (Bar + Line).
- `fetchSyncStatus()` — Marketplace-Sync-Health (`/api/sync/status`).
- `fetchReorderAlerts()` — Produkte mit Bestand ≤ Reorder-Threshold.
- `fetchActivityFeed()` — Letzte System-Events (Stock, Orders, Syncs).
- `fetchOrders(limit, { timeoutMs })` — auf Mobile zusätzlich für Pick-Backlog-Vorschau (DashboardMobile.tsx Z. 212).

Pro-Endpunkt-Details kommen in `docs/kb/09-api/dashboard.md` (TBD — Datei noch nicht angelegt).

## Datenquellen

- React-Hook `useState` + manuelle `useEffect`-Loads — **keine** React-Query-Wrapper im Dashboard (Stand 2026-05-18). Refetch-Trigger: Range-Preset-Wechsel, manueller Refresh-Button.
- `products`-Prop wird vom Parent (`App.tsx`) durchgereicht; Verfügbarkeit/Reserved über `getProductAvailableQuantity`, `getProductPhysicalQuantity`, `getProductReservedQuantity` aus [utils/product.ts](../../../utils/product.ts).
- Persistenz des Range-Presets über `App.tsx` `DASHBOARD_RANGE_PRESET_STORAGE_KEY` (`avystock:dashboard:rangePreset`).

## Wichtige Edge-Cases

- **Empty-State**: keine Daten in gewähltem Zeitraum → KPI-Karten zeigen `0` mit Sub-Text, Chart zeigt leere Y-Achse.
- **Loading**: `Skel`-Komponente (Tailwind `animate-pulse`) ersetzt Werte während des Initial-Loads und bei Range-Wechsel (`loading`-Prop pro `Card`).
- **Error**: keine zentrale Error-Banner — fehlgeschlagene `fetchDashboardMetrics`-Calls werden geloggt, KPI-Karten bleiben leer. Verbesserungsbedarf, nicht in TASKS.md getrackt.
- **Mobile-Fallback**: `App.tsx` schaltet zwischen `Dashboard` und `DashboardMobile` über `addMediaQueryListener('(max-width: …)`)` (utils/mediaQuery).
- **Custom-Range**: bei Preset `custom` werden `from`/`to`-Felder eingeblendet und an `fetchDashboardMetrics` gereicht; ungültige Bereiche werden vom Backend abgefangen.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-069** Dashboard Chart endet bei ~12.03 (✅ gefixt, Dashboard-Redesign mit korrektem Zeitraum-Mapping). Wenn Chart nochmal abreißt → erstes Verdachtskandidat ist `preset`-Mapping in Backend-Route.
