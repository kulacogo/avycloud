# KW 14: Pack & Ship Auto-Print + Dashboard Enhancements

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable auto-print after pack-scan (M14) and add Activity Feed + trend indicators to Dashboard (M10).

**Architecture:** M14 extends the existing pack flow in MobileOperationsView with user-configurable label format and auto-print. Settings stored in `user_profiles` Firestore collection. M10 adds an Activity Feed component to the existing Dashboard using a new lightweight backend endpoint that aggregates recent events from existing collections.

**Tech Stack:** React 18 + TypeScript (frontend), Node.js + Express CJS (backend), Firestore, SendCloud labels

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/routes/settings.js:96` | Modify | Add `printing` to allowedFields |
| `components/settings/ProfileSettings.tsx` | Modify | Add "Druckeinstellungen" card (label format + auto-print toggle) |
| `api/client.ts:3029-3065` | Modify | Pass `labelFormat` through `packAndShip()` |
| `api/client.ts:3041-3043` | Modify | Add `?format=` to label download URL |
| `components/MobileOperationsView.tsx:1486-1534` | Modify | Load user printing prefs, pass labelFormat, trigger auto-print |
| `backend/routes/orders.js:53-211` | Modify | Add activity feed endpoint |
| `components/Dashboard.tsx` | Modify | Add ActivityFeed section + trend indicators |
| `api/client.ts` | Modify | Add `fetchActivityFeed()` function |

---

## Chunk 1: M14-P1 — Printer & Label Settings

### Task 1: Backend — Accept `printing` in profile settings

**Files:**
- Modify: `backend/routes/settings.js:96`

- [ ] **Step 1: Add `printing` to allowedFields**

In `backend/routes/settings.js` line 96, change:
```javascript
const allowedFields = ['vorname', 'nachname', 'notifications', 'theme'];
```
to:
```javascript
const allowedFields = ['vorname', 'nachname', 'notifications', 'theme', 'printing'];
```

This allows the `printing` object to be stored in `user_profiles`. The object will contain:
```javascript
printing: {
  labelFormat: 'a6' | 'a4',       // SendCloud: 'a6' = label_printer (thermal 10×15), 'a4' = normal_printer
  autoPrint: true | false          // Auto-trigger print dialog after pack
}
```

- [ ] **Step 2: Verify with manual test**

Run: `cd backend && npm test`
Expected: All existing tests pass (no regression).

- [ ] **Step 3: Commit**

```bash
git add backend/routes/settings.js
git commit -m "feat(settings): accept printing preferences in user profile"
```

---

### Task 2: Frontend — Printing settings UI in ProfileSettings

**Files:**
- Modify: `components/settings/ProfileSettings.tsx`

- [ ] **Step 1: Add state for printing preferences**

After line 48 (`const [theme, setLocalTheme]`), add:
```typescript
const [labelFormat, setLabelFormat] = useState<"a6" | "a4">("a6");
const [autoPrint, setAutoPrint] = useState(false);
```

- [ ] **Step 2: Load printing preferences from profile**

In `loadProfile()` callback (after line 75), add:
```typescript
if (data.printing) {
  if (data.printing.labelFormat) setLabelFormat(data.printing.labelFormat);
  if (data.printing.autoPrint) setAutoPrint(data.printing.autoPrint);
}
```

- [ ] **Step 3: Include printing in save payload**

In `handleSave()` (line 102), change:
```typescript
await saveProfile({ vorname, nachname, notifications, theme });
```
to:
```typescript
await saveProfile({
  vorname, nachname, notifications, theme,
  printing: { labelFormat, autoPrint },
});
```

- [ ] **Step 4: Add "Druckeinstellungen" Card**

After the Design/Theme Card (after line 237 `</Card>`), add a new Card:

```tsx
{/* Druckeinstellungen */}
<Card>
  <h3 className="text-sm font-semibold text-txt-primary mb-4">Druckeinstellungen</h3>

  {/* Label-Format */}
  <div className="mb-4">
    <label className="block text-xs text-txt-muted mb-2">Label-Format</label>
    <div className="flex flex-wrap gap-3">
      {([
        { value: "a6" as const, label: "10×15 Thermodruck", desc: "Für Thermodrucker (Zebra, Brother etc.)" },
        { value: "a4" as const, label: "A4 Normaldrucker", desc: "Label auf DIN-A4 Seite" },
      ]).map((opt) => (
        <label
          key={opt.value}
          className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border cursor-pointer transition-colors ${
            labelFormat === opt.value
              ? "border-accent bg-accent-dim text-accent"
              : "border-app-border bg-app-elevated text-txt-secondary hover:border-accent/30"
          }`}
        >
          <input
            type="radio"
            name="labelFormat"
            value={opt.value}
            checked={labelFormat === opt.value}
            onChange={() => setLabelFormat(opt.value)}
            className="sr-only"
          />
          <span
            className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
              labelFormat === opt.value ? "border-accent" : "border-app-border"
            }`}
          >
            {labelFormat === opt.value && <span className="w-2 h-2 rounded-full bg-accent" />}
          </span>
          <div>
            <span className="text-sm font-medium block">{opt.label}</span>
            <span className="text-xs text-txt-muted">{opt.desc}</span>
          </div>
        </label>
      ))}
    </div>
  </div>

  {/* Auto-Print Toggle */}
  <label className="flex items-center gap-3 cursor-pointer group">
    <span
      className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
        autoPrint
          ? "bg-accent border-accent"
          : "bg-app-elevated border-app-border group-hover:border-accent/40"
      }`}
      onClick={() => setAutoPrint((prev) => !prev)}
    >
      {autoPrint && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
    </span>
    <div>
      <span className="text-sm text-txt-primary">Auto-Print nach Verpacken</span>
      <span className="block text-xs text-txt-muted">Druckdialog automatisch öffnen nach Pack & Ship</span>
    </div>
  </label>
</Card>
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: No TypeScript errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add components/settings/ProfileSettings.tsx
git commit -m "feat(settings): add printing preferences UI (label format + auto-print)"
```

---

## Chunk 2: M14-P3 — Auto-Print Flow

### Task 3: API Client — Pass labelFormat through packAndShip

**Files:**
- Modify: `api/client.ts:3029-3065`

- [ ] **Step 1: Extend packAndShip signature to accept labelFormat**

Change function signature (line 3029-3031):
```typescript
export async function packAndShip(
  orderId: string,
  opts?: { weight?: number; labelFormat?: string }
): Promise<{ labelBlobUrl: string | null; trackingNumber: string | null; carrier: string | null; labelError?: string | null }> {
```

- [ ] **Step 2: Pass labelFormat to shipOrder**

Change line 3034:
```typescript
const result = await shipOrder(orderId, opts);
```
(This already works since `shipOrder` accepts `{ weight?, labelFormat? }` and we're passing opts through.)

- [ ] **Step 3: Add format query parameter to label download URL**

Change lines 3041-3043:
```typescript
const format = opts?.labelFormat || 'a6';
const pdfRes = await fetchApi(
  `${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/label?format=${encodeURIComponent(format)}`,
  { method: 'GET' }
);
```

- [ ] **Step 4: Commit**

```bash
git add api/client.ts
git commit -m "feat(api): pass labelFormat through packAndShip to ship + label download"
```

---

### Task 4: MobileOperationsView — Load prefs + auto-print

**Files:**
- Modify: `components/MobileOperationsView.tsx:1486-1534`

- [ ] **Step 1: Import fetchProfile**

Add to imports at top of file:
```typescript
import { fetchProfile } from "../api/client";
```
(Check if already imported — if not, add it.)

- [ ] **Step 2: Add printing prefs state**

Near the other pack-related state (find `packScopedOrderKey` or similar useState calls), add:
```typescript
const [printingPrefs, setPrintingPrefs] = useState<{ labelFormat?: string; autoPrint?: boolean }>({});
```

- [ ] **Step 3: Load printing prefs on pack mode entry**

Add a useEffect that loads printing prefs when entering pack mode:
```typescript
useEffect(() => {
  if (mode === 'operations-pack') {
    fetchProfile()
      .then((data) => {
        if (data.printing) setPrintingPrefs(data.printing);
      })
      .catch(() => {}); // Non-critical — defaults work fine
  }
}, [mode]);
```

- [ ] **Step 4: Modify submitPack to use labelFormat and auto-print**

Replace the pack flow section (lines ~1505-1525). The key changes:

1. Pass `labelFormat` to `packAndShip()`
2. After PDF loads, call `printWindow.print()` if `autoPrint` is enabled
3. Use `printWindow.onload` to trigger print at the right time

```typescript
} else {
  // Pre-open window BEFORE async work to avoid popup blocker
  const printWindow = window.open('about:blank', '_blank');

  // Pack + Ship + Print label
  const result = await packAndShip(selectedItem.orderId, {
    ...weightOpt,
    labelFormat: printingPrefs.labelFormat || 'a6',
  });
  if (result.labelBlobUrl && printWindow) {
    // Navigate pre-opened window to the PDF blob URL
    printWindow.location.href = result.labelBlobUrl;
    // Auto-print if user preference enabled
    if (printingPrefs.autoPrint) {
      printWindow.onload = () => {
        try { printWindow.print(); } catch (_) { /* cross-origin or blocked */ }
      };
    }
    // Revoke blob URL after 60s to free memory
    setTimeout(() => URL.revokeObjectURL(result.labelBlobUrl!), 60000);
    setPackMessage(
      `${selectedItem.orderNumber || selectedItem.orderId} verpackt & Label erstellt (${result.carrier || '?'}) — ${printingPrefs.autoPrint ? 'Druckdialog geöffnet.' : 'Label-Fenster geöffnet.'}`
    );
  } else {
    // Close the blank tab if no label available
    if (printWindow) printWindow.close();
    setPackMessage(
      `${selectedItem.orderNumber || selectedItem.orderId} verpackt & versendet — kein Label-PDF verfügbar.${result.labelError ? ` (${result.labelError})` : ''}`
    );
  }
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add components/MobileOperationsView.tsx
git commit -m "feat(pack): auto-print label after pack with user-configurable format"
```

---

## Chunk 3: M10 — Dashboard Activity Feed + Trends

### Task 5: Backend — Activity Feed endpoint

**Files:**
- Modify: `backend/routes/orders.js` (add new endpoint)

- [ ] **Step 1: Add GET /api/dashboard/activity endpoint**

Add after the existing `/api/dashboard/finance` handler (after line ~429):

```javascript
/**
 * GET /api/dashboard/activity
 * Returns recent activity events (orders, shipments, returns, stock syncs).
 * Aggregates from multiple collections into a unified timeline.
 */
router.get('/dashboard/activity', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const activities = [];

    // Recent orders (last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [ordersSnap, shipmentsSnap, returnsSnap, syncSnap] = await Promise.all([
      firestore.collection('orders')
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get(),
      firestore.collection('shipments')
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get(),
      firestore.collection('returns')
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get(),
      firestore.collection('stock_sync_log')
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get(),
    ]);

    for (const doc of ordersSnap.docs) {
      const d = doc.data();
      activities.push({
        type: 'order',
        id: doc.id,
        title: `Auftrag ${d.orderNumber || doc.id}`,
        detail: d.customer?.name || d.source || '',
        status: d.omsStatus || d.status || 'neu',
        timestamp: d.createdAt,
      });
    }

    for (const doc of shipmentsSnap.docs) {
      const d = doc.data();
      activities.push({
        type: 'shipment',
        id: doc.id,
        title: `Versand ${d.trackingNumber || ''}`,
        detail: d.carrier || '',
        status: 'shipped',
        timestamp: d.createdAt,
      });
    }

    for (const doc of returnsSnap.docs) {
      const d = doc.data();
      activities.push({
        type: 'return',
        id: doc.id,
        title: `Retoure ${d.returnNumber || doc.id}`,
        detail: d.reason || '',
        status: d.status || 'pending',
        timestamp: d.createdAt,
      });
    }

    for (const doc of syncSnap.docs) {
      const d = doc.data();
      const channels = (d.results || []).map((r) => r.channel).join(', ');
      const hasError = (d.results || []).some((r) => r.status === 'error');
      activities.push({
        type: 'sync',
        id: doc.id,
        title: `Stock-Sync ${d.productId || ''}`,
        detail: channels,
        status: hasError ? 'error' : 'success',
        timestamp: d.createdAt,
      });
    }

    // Sort by timestamp desc, take limit
    activities.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const trimmed = activities.slice(0, limit);

    res.json({ ok: true, data: trimmed });
  } catch (err) {
    console.error(`[GET /api/dashboard/activity] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});
```

- [ ] **Step 2: Verify tests still pass**

Run: `cd backend && npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/orders.js
git commit -m "feat(dashboard): add activity feed endpoint aggregating orders/shipments/returns/syncs"
```

---

### Task 6: API Client — fetchActivityFeed function

**Files:**
- Modify: `api/client.ts`

- [ ] **Step 1: Add ActivityEvent interface and fetch function**

Near the other dashboard-related functions (around line 2945), add:

```typescript
export interface ActivityEvent {
  type: 'order' | 'shipment' | 'return' | 'sync';
  id: string;
  title: string;
  detail: string;
  status: string;
  timestamp: string;
}

export async function fetchActivityFeed(limit = 20): Promise<ActivityEvent[]> {
  const res = await fetchApi(
    `${BACKEND_URL}/api/dashboard/activity?limit=${limit}`,
    { method: 'GET' }
  );
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Activity feed failed');
  }
  return data?.data || [];
}
```

- [ ] **Step 2: Commit**

```bash
git add api/client.ts
git commit -m "feat(api): add fetchActivityFeed client function"
```

---

### Task 7: Dashboard — Activity Feed component + trend indicators

**Files:**
- Modify: `components/Dashboard.tsx`

- [ ] **Step 1: Import fetchActivityFeed and add state**

Add to imports:
```typescript
import { fetchActivityFeed, ActivityEvent } from "../api/client";
```

Add state (near other state declarations):
```typescript
const [activities, setActivities] = useState<ActivityEvent[]>([]);
```

- [ ] **Step 2: Load activity feed in loadAll function**

In the existing `loadAll()` or `Promise.allSettled()` block (around line 563), add `fetchActivityFeed()` to the parallel requests and handle the result:

```typescript
const activityPromise = fetchActivityFeed(15).catch(() => []);
```

After `Promise.allSettled`, set the activities state:
```typescript
const activityResult = await activityPromise;
setActivities(activityResult);
```

- [ ] **Step 3: Add ActivityFeed section to JSX**

After the Nachbestellungs-Warnungen section (around line 957), add:

```tsx
{/* Aktivitäts-Feed */}
{activities.length > 0 && (
  <div className="rounded-xl bg-app-surface border border-app-border overflow-hidden">
    <div className="px-4 py-3 border-b border-app-border">
      <h3 className="text-sm font-semibold text-txt-primary">Aktivitäts-Feed · Letzte 24h</h3>
    </div>
    <div className="divide-y divide-app-border max-h-80 overflow-y-auto">
      {activities.map((a) => {
        const typeIcon = { order: '📦', shipment: '🚚', return: '↩️', sync: '🔄' }[a.type] || '•';
        const statusColor = a.status === 'error' ? 'text-danger'
          : a.status === 'shipped' ? 'text-success'
          : a.status === 'success' ? 'text-success'
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
)}
```

- [ ] **Step 4: Add trend indicators to Jahresüberblick KPI cards**

In the Jahresüberblick section (around line 702-757), each KPI card currently shows a raw value. Add a simple period-over-period comparison using the existing `volume_7d` data.

For the "Umsatz" (Revenue) card, after the main value, add a trend indicator:
```tsx
{metrics?.revenue?.payout_brutto_window != null && metrics?.revenue?.payout_brutto_ytd != null && (
  <span className={`text-xs font-medium ml-2 ${
    (metrics.revenue.payout_brutto_window || 0) > 0 ? 'text-success' : 'text-txt-muted'
  }`}>
    {metrics.revenue.payout_brutto_window > 0 ? '▲' : '—'} Zeitraum
  </span>
)}
```

(Keep this minimal — full trend comparison requires previous-period data which isn't in the current API response.)

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add components/Dashboard.tsx api/client.ts
git commit -m "feat(dashboard): add activity feed + trend indicators"
```

---

## Verification Checklist

- [ ] `cd backend && npm test` — All tests pass
- [ ] `npm run build` — Frontend builds without errors
- [ ] Profile settings shows new "Druckeinstellungen" card with label format + auto-print toggle
- [ ] Saving profile persists `printing` object to `user_profiles` collection
- [ ] Pack & Ship flow reads user's label format preference
- [ ] Pack & Ship flow triggers `window.print()` when autoPrint is enabled
- [ ] Dashboard shows Activity Feed with recent orders/shipments/returns/syncs
- [ ] No regressions in existing functionality
