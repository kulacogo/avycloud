# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix incorrect dashboard numbers (returns, chart revenue) and redesign UX for a slimmer, finance-first layout.

**Architecture:** Backend fix in `routes/orders.js` adds `returns_ytd` and stops double-counting returns. Frontend rewrite of `Dashboard.tsx` restructures 6 sections into a cleaner 3+3 layout: hero KPIs, time-range metrics + chart, then compact operations (pipeline, inventory/sync). No new API endpoints needed.

**Tech Stack:** React 18 + TypeScript (Frontend), Node.js + Express CJS (Backend), Vitest (Tests)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/routes/orders.js` | Modify (lines 126-177) | Add `returns_ytd`, fix double-count |
| `types.ts` | Modify (lines 475-521) | Add `returns` interface to `DashboardMetrics` |
| `components/Dashboard.tsx` | Rewrite (lines 680-1002) | New layout, fix returns display, bigger chart |

---

### Task 1: Backend — Add `returns_ytd` and fix double-counting

**Files:**
- Modify: `backend/routes/orders.js:126-177`

The returns enrichment block currently counts `totalCount` (all-time) and `monthCount` but has no YTD count. Also, `getDashboardMetrics()` counts returns from order status strings, and then this block overwrites `returns_total` with the `returns` collection count — but the revenue deduction uses `totalValue` (all returns ever) against `all_non_cancelled_total` (which may be YTD), causing incorrect subtraction.

- [ ] **Step 1: Add `returns_ytd` counting and fix revenue deduction**

In `backend/routes/orders.js`, replace lines 127-174 (the returns enrichment block) with:

```js
    // Pull returns from Firestore `returns` collection for KPIs (net revenue + returns counts).
    // Single source of truth — order-status-based return counting in getDashboardMetrics() is ignored.
    try {
      const rangeStart = metrics?.range?.from_iso ? new Date(metrics.range.from_iso) : null;
      const rangeEndExclusive = metrics?.range?.to_iso ? new Date(metrics.range.to_iso) : null;
      const now = new Date();
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));

      const returnsSnap = await firestore.collection('returns')
        .select('refundAmount', 'currency', 'createdAt', 'status')
        .get();

      let totalCount = 0, totalValue = 0;
      let ytdCount = 0, ytdValue = 0;
      let windowCount = 0, windowValue = 0;

      for (const doc of returnsSnap.docs) {
        const d = doc.data();
        const amount = Number(d.refundAmount || 0) || 0;
        const created = d.createdAt ? new Date(d.createdAt) : null;

        totalCount++;
        totalValue += amount;

        if (created && created >= yearStart) {
          ytdCount++;
          ytdValue += amount;
        }
        if (created && rangeStart && rangeEndExclusive && created >= rangeStart && created < rangeEndExclusive) {
          windowCount++;
          windowValue += amount;
        }
      }

      if (metrics?.orders) {
        metrics.orders.returns_total = totalCount;
        metrics.orders.returns_ytd = ytdCount;
      }

      // Deduct returns from revenue — YTD value from YTD revenue, window value from window revenue
      if (metrics?.revenue) {
        if (typeof metrics.revenue.all_non_cancelled_total === 'number') {
          metrics.revenue.all_non_cancelled_total = Number((metrics.revenue.all_non_cancelled_total - ytdValue).toFixed(2));
        }
        if (typeof metrics.revenue.window_non_cancelled_total === 'number') {
          metrics.revenue.window_non_cancelled_total = Number((metrics.revenue.window_non_cancelled_total - windowValue).toFixed(2));
        }
      }

      metrics.returns = {
        total: { count: totalCount, value_by_currency: { EUR: Math.round(totalValue * 100) / 100 } },
        ytd: { count: ytdCount, value_by_currency: { EUR: Math.round(ytdValue * 100) / 100 } },
        window: { count: windowCount, value_by_currency: { EUR: Math.round(windowValue * 100) / 100 } },
      };
    } catch (err) {
      console.warn('Dashboard returns enrichment failed:', err?.message || err);
    }
```

Key changes:
- Added `ytdCount` / `ytdValue` tracking (since Jan 1 of current year)
- Revenue deduction: `all_non_cancelled_total` now subtracts `ytdValue` (not `totalValue`), matching the YTD scope
- `returns` object now has 3 levels: `total`, `ytd`, `window`
- Added `returns_ytd` to `metrics.orders`
- Removed `returns_month` (unused in new design)

- [ ] **Step 2: Run backend tests**

```bash
cd backend && npm test
```

Expected: All existing tests pass. The returns enrichment is not directly unit-tested (it runs inside the route handler), but no existing test should break.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/orders.js
git commit -m "fix: correct returns counting — add YTD, fix revenue deduction scope"
```

---

### Task 2: TypeScript — Extend `DashboardMetrics` interface

**Files:**
- Modify: `types.ts:475-521`

- [ ] **Step 1: Add `returns_ytd` to orders and add `returns` interface**

In `types.ts`, replace the `orders` block (lines 501-516) with:

```ts
  orders: {
    open_current: number;
    completed_total: number;
    completed_month: number;
    returns_total: number;
    returns_ytd?: number;
    returns_month: number;
    status_breakdown?: {
      neu: number;
      kommissioniert: number;
      verpackt: number;
      versendet: number;
      zugestellt: number;
      cancelled: number;
      other: number;
    };
  };
```

And add after the closing `}` of `DashboardMetrics` (before `export interface FinanceAccountBalance`), no — add `returns` as a field inside `DashboardMetrics`. After the `volume_7d` block (line 520), add:

```ts
  returns?: {
    total: { count: number; value_by_currency: Record<string, number> };
    ytd: { count: number; value_by_currency: Record<string, number> };
    window: { count: number; value_by_currency: Record<string, number> };
  };
```

- [ ] **Step 2: Build frontend to check types**

```bash
npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add types.ts
git commit -m "feat: extend DashboardMetrics with returns_ytd and returns interface"
```

---

### Task 3: Frontend — Rewrite Dashboard render section

**Files:**
- Modify: `components/Dashboard.tsx`

This is the main UX task. We rewrite the `ord` memo, then the entire render block (lines 680-1002).

- [ ] **Step 1: Update `ord` memo to use window returns**

Replace lines 623-658 in `Dashboard.tsx`:

```tsx
  const ord = useMemo(() => {
    const bd = metrics?.orders?.status_breakdown;
    const days = metrics?.volume_7d?.days ?? [];
    const bucket = metrics?.range?.bucket ?? 'day';
    const n = days.length;
    const chart: ChartDay[] = days.map(d => {
      const dt = (() => { try { return new Date(d.date); } catch { return null; } })();
      const label = (() => {
        if (!dt) return d.date;
        if (bucket === 'month') return dt.toLocaleDateString('de-DE', { month: 'short' });
        if (bucket === 'week') return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        if (bucket === 'hour') return dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        if (n <= 14) return dt.toLocaleDateString('de-DE', { weekday: 'short' });
        return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      })();
      return { key: d.date, label, count: Number(d.orders || 0), revenue: Number(d.revenue || 0) };
    });
    const totalOrdersInWindow = chart.reduce((s, d) => s + d.count, 0);
    return {
      neu: bd?.neu ?? 0,
      kommissioniert: bd?.kommissioniert ?? 0,
      verpackt: (bd as any)?.verpackt ?? 0,
      versendet: bd?.versendet ?? 0,
      zugestellt: bd?.zugestellt ?? 0,
      totalOrdersInWindow,
      revenueYtd: metrics?.revenue?.payout_brutto_ytd ?? metrics?.revenue?.all_non_cancelled_total ?? 0,
      revenueWindow: metrics?.revenue?.payout_brutto_window ?? metrics?.revenue?.window_non_cancelled_total ?? 0,
      returnsTotal: metrics?.orders?.returns_total ?? 0,
      returnsYtd: metrics?.orders?.returns_ytd ?? 0,
      returnsWindowCount: metrics?.returns?.window?.count ?? 0,
      returnsWindowValue: metrics?.returns?.window?.value_by_currency?.EUR ?? 0,
      currency: safeCur(metrics?.currency),
      chart,
    };
  }, [metrics]);
```

Key changes: added `returnsYtd`, `returnsWindowCount`, `returnsWindowValue`.

- [ ] **Step 2: Rewrite render sections (lines 680-998)**

Replace everything from `return (` (line 680) to the closing `);` (line 998) with:

```tsx
  return (
    <div className="space-y-5 pb-8">

      {/* ══ Header ══════════════════════════════════════════════════════ */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-txt-muted">
          {nowStr ? `Stand: ${nowStr}` : 'Wird geladen\u2026'}
        </p>
        <DateRangePicker
          activePreset={activePreset}
          presetLabel={presetLabel}
          onSelect={setPreset}
          onRefresh={loadAll}
          customFrom={customFrom}
          customTo={customTo}
          onCustomChange={(f, t) => { setCustomFrom(f); setCustomTo(t); }}
        />
      </div>

      {metricsError && (
        <div className="rounded-md border border-danger/20 bg-danger-dim px-4 py-2.5 text-sm text-danger">
          {metricsError}
        </div>
      )}

      {/* ══ 1. HERO-KPIs (3 Karten) ═══════════════════════════════════ */}
      <Section title="Jahres\u00fcberblick">
        <div className="grid grid-cols-3 gap-3">
          <Card
            label="Kontostand"
            value={totalBalance !== null ? fmtCur(totalBalance, 'EUR') : '\u2014'}
            sub="SevDesk"
            color={totalBalance !== null && totalBalance < 0 ? 'red' : 'violet'}
            loading={financeLoading}
            size="hero"
          />
          <Card
            label="Jahresumsatz"
            value={fmtCur(ord.revenueYtd, ord.currency, true)}
            sub="Brutto"
            color="green"
            loading={metricsLoading}
            size="hero"
          />
          <Card
            label="Versand (Jahr)"
            value={shippingYtd !== null ? fmtCur(shippingYtd, 'EUR', true) : '\u2014'}
            sub={shippingYtd !== null ? (
              <span className="flex flex-col gap-0.5">
                <span>{fmtNum(finance?.shipping_ytd?.parcel_count ?? 0)} Sendungen</span>
                {((finance?.shipping_ytd?.dhl_count ?? 0) > 0 || (finance?.shipping_ytd?.dpd_count ?? 0) > 0) && (
                  <span className="text-[10px] text-txt-muted">
                    {(finance?.shipping_ytd?.dhl_count ?? 0) > 0 && `DHL ${fmtNum(finance!.shipping_ytd!.dhl_count!)}`}
                    {(finance?.shipping_ytd?.dhl_count ?? 0) > 0 && (finance?.shipping_ytd?.dpd_count ?? 0) > 0 && ' \u00b7 '}
                    {(finance?.shipping_ytd?.dpd_count ?? 0) > 0 && `DPD ${fmtNum(finance!.shipping_ytd!.dpd_count!)}`}
                  </span>
                )}
              </span>
            ) : undefined}
            color="amber"
            loading={financeLoading && shippingYtd === null}
            size="hero"
          />
        </div>
        {finance?.errors && finance.errors.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {finance.errors.map((e, i) => (
              <span key={i} className="text-[11px] text-warning bg-warning-dim border border-warning/20 px-2 py-0.5 rounded">
                {e}
              </span>
            ))}
          </div>
        )}
      </Section>

      {/* ══ 2. KENNZAHLEN + CHART ═════════════════════════════════════ */}
      <Section title={`Kennzahlen \u00b7 ${presetLabel}`}>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Card
            label="Umsatz"
            value={fmtCur(ord.revenueWindow, ord.currency, true)}
            sub={`${fmtNum(ord.totalOrdersInWindow)} Auftr\u00e4ge`}
            color="green"
            loading={metricsLoading}
          />
          <Card
            label="Versand"
            value={shippingWindow !== null ? fmtCur(shippingWindow, 'EUR', true) : '\u2014'}
            sub={shippingWindow !== null ? `${fmtNum(finance?.shipping?.parcel_count ?? 0)} Sendungen` : undefined}
            color="amber"
            loading={financeLoading && shippingWindow === null}
          />
          <Card
            label="Retouren"
            value={fmtNum(ord.returnsWindowCount)}
            sub={ord.returnsWindowValue > 0 ? fmtCur(ord.returnsWindowValue, 'EUR') : undefined}
            color={ord.returnsWindowCount > 0 ? 'red' : 'neutral'}
            loading={metricsLoading}
          />
        </div>

        {/* Chart */}
        <div className="rounded-lg border border-app-border bg-app-surface p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-semibold text-txt-primary">Auftragsvolumen & Umsatz</p>
              <p className="text-[10px] text-txt-muted">{presetLabel}</p>
            </div>
            <div className="flex items-center gap-4 text-[10px] text-txt-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm bg-info" />
                Auftr\u00e4ge (links)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-1.5 rounded-full bg-success" />
                Umsatz (rechts)
              </span>
            </div>
          </div>
          <DualChart data={ord.chart} currency={ord.currency} loading={metricsLoading} />
        </div>
      </Section>

      {/* ══ 3. AUFTRAGSFLUSS (kompakt) ════════════════════════════════ */}
      <Section title="Auftragsfluss" badge={!metricsLoading && ord.neu > 0 ? `${ord.neu} offen` : undefined}>
        <div className="rounded-lg border border-app-border bg-app-surface px-5 py-3">
          {metricsLoading ? (
            <div className="h-8 w-full rounded bg-app-border/50 animate-pulse" />
          ) : (
            <div className="flex items-center gap-1">
              {STEPS.map((st, i) => {
                const count = ({ neu: ord.neu, kommissioniert: ord.kommissioniert, verpackt: ord.verpackt, versendet: ord.versendet, zugestellt: ord.zugestellt } as Record<string, number>)[st.key] || 0;
                return (
                  <React.Fragment key={st.key}>
                    <button
                      type="button"
                      onClick={() => navigateTo(st.key)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-app-elevated transition-colors cursor-pointer"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className="text-xs text-txt-muted">{st.label}</span>
                      <span className={`text-sm font-bold tabular-nums ${st.text}`}>{fmtNum(count)}</span>
                    </button>
                    {i < STEPS.length - 1 && (
                      <span className="text-app-border text-xs select-none">\u203A</span>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      </Section>

      {/* ══ 4. BESTAND & SYNC (kompakte Leiste) ══════════════════════ */}
      <Section title="Bestand & Sync">
        <div className="rounded-lg border border-app-border bg-app-surface px-5 py-3">
          {syncLoading && metricsLoading ? (
            <div className="h-6 w-full rounded bg-app-border/50 animate-pulse" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              {/* Inventory stats */}
              <span className="text-txt-primary">
                <span className="font-semibold">{fmtNum(inv.inStock)}</span>
                <span className="text-txt-muted"> Produkte</span>
              </span>
              <span className="text-txt-primary">
                <span className="font-semibold">{fmtNum(inv.available)}</span>
                <span className="text-txt-muted"> verf\u00fcgbar</span>
                {inv.reserved > 0 && (
                  <span className="text-txt-muted"> \u00b7 {fmtNum(inv.reserved)} reserviert</span>
                )}
              </span>
              <span className="text-txt-primary">
                <span className="text-txt-muted">Wert </span>
                <span className="font-semibold">{fmtCur(inv.totalValue, inv.primaryCur, true)}</span>
              </span>

              {/* Divider */}
              <span className="w-px h-4 bg-app-border" />

              {/* Sync badges */}
              {syncStatus && (['ebay', 'kaufland'] as const).map(ch => {
                const c = syncStatus.channels[ch];
                if (!c) return (
                  <span key={ch} className="text-xs text-txt-muted">{ch.charAt(0).toUpperCase() + ch.slice(1)} \u2014</span>
                );
                const hasErrors = c.errorCount > 0;
                return (
                  <span key={ch} className="flex items-center gap-1 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full ${hasErrors ? 'bg-danger' : 'bg-success'}`} />
                    <span className="text-txt-secondary">{ch.charAt(0).toUpperCase() + ch.slice(1)}</span>
                    <span className={`font-medium ${hasErrors ? 'text-danger' : 'text-success'}`}>
                      {c.successCount}/{c.totalCount}
                    </span>
                    {hasErrors && <span className="text-danger">\u00b7 {c.errorCount} Fehler</span>}
                  </span>
                );
              })}
              {!syncStatus && <span className="text-xs text-txt-muted">Sync: kein Status</span>}
            </div>
          )}
        </div>
      </Section>

      {/* ══ 5. NACHBESTELLUNGS-WARNUNGEN ══════════════════════════════ */}
      {!alertsLoading && reorderAlerts.length > 0 && (
        <Section title="Nachbestellungs-Warnungen" badge={String(reorderAlerts.length)}>
          <div className="rounded-lg border border-warning/20 bg-warning-dim/30 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-warning/10">
                    <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted">Produkt</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Bestand</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Verkauf/Tag</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Reichweite</th>
                  </tr>
                </thead>
                <tbody>
                  {reorderAlerts.slice(0, 10).map((a: any, i: number) => (
                    <tr
                      key={a.productId || i}
                      className="border-b border-warning/10 last:border-b-0 cursor-pointer hover:bg-warning-dim/50 transition"
                      onClick={() => _onSelectProduct(a.productId)}
                    >
                      <td className="px-4 py-2 text-txt-primary font-medium truncate max-w-[200px]">
                        {a.name || a.productId?.slice(0, 12)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-warning font-semibold">
                        {a.currentStock ?? '\u2014'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-txt-muted">
                        {typeof a.velocity === 'number' ? a.velocity.toFixed(1) : '\u2014'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className={`font-mono font-semibold ${(a.daysUntilStockout ?? 999) < 7 ? 'text-danger' : 'text-warning'}`}>
                          {typeof a.daysUntilStockout === 'number'
                            ? `${a.daysUntilStockout} Tage`
                            : '\u2014'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Section>
      )}

      {/* ══ 6. AKTIVIT\u00c4TS-FEED ══════════════════════════════════════ */}
      {activities.length > 0 && (
        <Section title="Aktivit\u00e4ts-Feed" badge="24h">
          <div className="rounded-lg border border-app-border bg-app-surface overflow-hidden">
            <div className="divide-y divide-app-border max-h-80 overflow-y-auto">
              {activities.map((a) => {
                const typeIcon = { order: '\uD83D\uDCE6', shipment: '\uD83D\uDE9A', return: '\u21A9\uFE0F', sync: '\uD83D\uDD04' }[a.type] || '\u2022';
                const statusColor = a.status === 'error' ? 'text-danger'
                  : a.status === 'shipped' || a.status === 'success' ? 'text-success'
                  : 'text-txt-secondary';
                const timeAgo = (() => {
                  const diff = Date.now() - new Date(a.timestamp).getTime();
                  const mins = Math.floor(diff / 60000);
                  if (mins < 1) return 'gerade eben';
                  if (mins < 60) return `vor ${mins} Min`;
                  const hrs = Math.floor(mins / 60);
                  if (hrs < 24) return `vor ${hrs} Std`;
                  return `vor ${Math.floor(hrs / 24)} Tag(en)`;
                })();
                return (
                  <div key={`${a.type}-${a.id}`} className="px-4 py-2.5 flex items-center gap-3 hover:bg-app-elevated/50 transition-colors">
                    <span className="text-base shrink-0">{typeIcon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-txt-primary truncate">{a.title}</p>
                      {a.detail && <p className="text-xs text-txt-muted truncate">{a.detail}</p>}
                    </div>
                    <span className={`text-xs font-medium ${statusColor} shrink-0`}>{a.status}</span>
                    <span className="text-xs text-txt-muted shrink-0 tabular-nums">{timeAgo}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>
      )}

    </div>
  );
```

Key changes:
- Hero: 3 cards (removed Retouren hero), `grid-cols-3` instead of `grid-cols-2 lg:grid-cols-4`
- Kennzahlen Retouren: shows `ord.returnsWindowCount` (window) instead of `ord.returnsTotal` (all-time), with refund value as sub
- Pipeline: compact inline flex instead of 5-column grid buttons
- Bestand + Sync: single compact flex row instead of 8 separate cards
- Removed standalone "Bestand" section (4 cards)
- Removed standalone "Marketplace Sync" section (4 cards)

- [ ] **Step 3: Increase chart height from 160px to 220px**

In `Dashboard.tsx`, find the `DualChart` component (around line 184). Change two things:

1. The `H` constant (line 192):
```tsx
  const W = 560, H = 220;
```

2. The fallback/loading height and the SVG style height (around lines 232-233 and 267):
Change `h-40` to `h-56` in the loading/empty states, and `height: '160px'` to `height: '220px'` in the SVG style.

```tsx
  // Loading state (around line 232)
  if (loading) {
    return (
      <div className="w-full h-56 flex items-end gap-1.5 px-2 pb-4">
```

```tsx
  // Empty state (around line 242)
  if (!data.length) {
    return (
      <div className="w-full h-56 flex items-center justify-center text-sm text-txt-muted">
```

```tsx
  // SVG element (around line 267)
        style={{ height: '220px' }}
```

- [ ] **Step 4: Build frontend to verify no type errors**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Visual check**

```bash
npx vite dev
```

Open the dashboard in the browser. Verify:
- Hero section: 3 cards (Kontostand, Jahresumsatz, Versand)
- Kennzahlen: Retouren card shows window-scoped count
- Pipeline: inline compact row
- Bestand & Sync: single compact line
- Chart: taller (220px)

- [ ] **Step 6: Commit**

```bash
git add components/Dashboard.tsx
git commit -m "feat: redesign dashboard — slimmer layout, correct returns, bigger chart"
```

---

### Task 4: Frontend — Responsive grid fix for hero on small screens

**Files:**
- Modify: `components/Dashboard.tsx`

The hero section uses `grid-cols-3` which may squeeze on small screens.

- [ ] **Step 1: Make hero grid responsive**

Change the hero grid class from:
```tsx
<div className="grid grid-cols-3 gap-3">
```
to:
```tsx
<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
```

Do the same for the Kennzahlen grid.

- [ ] **Step 2: Verify on narrow viewport**

Resize browser to ~375px width. Cards should stack vertically.

- [ ] **Step 3: Commit**

```bash
git add components/Dashboard.tsx
git commit -m "fix: responsive grid for dashboard hero and metrics cards"
```

---

### Task 5: Run full test suite and build

**Files:** None (verification only)

- [ ] **Step 1: Run backend tests**

```bash
cd backend && npm test
```

Expected: All tests pass (119+).

- [ ] **Step 2: Run frontend build**

```bash
npx vite build
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Final commit if any cleanup needed**

If any issues were found and fixed, commit with:
```bash
git commit -m "fix: dashboard post-redesign cleanup"
```
