# ERR-001: Error Dashboard

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | ERR-001 |
| **Title** | Error Dashboard |
| **Priority** | P0 |
| **Status** | Ready |
| **Change Level** | L1 |
| **Effort** | S (1–2 weeks) |
| **Source** | marktanalyse (S4.5) + SWOT W5 (Score 16) |
| **Dependencies** | None |
| **Protected Zones** | None (new views, new endpoints, new collection) |
| **TASKS.md Module** | Standalone — cross-cutting across all modules |

---

## 1. Problem Statement

AvyCloud logs errors extensively to Cloud Run's Log Explorer, but **zero persistent error history** is available to users in the UI. Errors from stock sync, marketplace API calls, webhook processing, job runners, and order intake are scattered across `console.error` calls and separate Firestore collections (`stock_sync_log`, `stock_sync_failures`, `deadLetterJobs`). There is no single place where a seller can see "what's broken and what needs fixing."

Competitors (Channable, Rithum, Linnworks) provide centralized error dashboards with channel-specific views, drilldown to affected products, and resolution tracking.

### User Story

```
As a multichannel seller,
I want one dashboard showing all errors and sync issues across my channels,
so that I can quickly identify, prioritize, and fix problems before they impact sales.
```

### Current State

- `stock_sync_log` / `stock_sync_failures` — persist stock sync errors (24h + persistent)
- `deadLetterJobs` — persist failed jobs after retry exhaustion
- `GET /api/orders/sync/status` — 24h summary of stock sync success/error counts
- `ToastContext` — transient toast notifications (disappear on reload)
- `AdminTable` — syncStatus badge per product, but `ops.sync_status` never set to `'failed'`
- All other errors: `console.error` only → Cloud Run Log Explorer, invisible to users

### Desired State

- One dashboard page showing all operational errors from all sources
- Errors categorized by type and channel, each linking to affected entity
- Error count badge in sidebar
- Errors can be acknowledged after resolution
- Summary KPIs: total open, by severity, trend

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Centralized `operationalErrors` collection aggregating all error sources |
| FR-2 | MUST | Error dashboard page with filterable, sortable error list |
| FR-3 | MUST | Group by type: `sync_failure`, `api_error`, `job_failure`, `validation_error`, `webhook_error` |
| FR-4 | MUST | Group by channel: `ebay`, `kaufland`, `sendcloud`, `internal` |
| FR-5 | MUST | Each error links to affected product/order |
| FR-6 | MUST | Error count badge in sidebar (unresolved count) |
| FR-7 | MUST | Severity levels: `critical`, `warning`, `info` |
| FR-8 | SHOULD | Acknowledge/resolve errors |
| FR-9 | SHOULD | Summary KPI tiles |
| FR-10 | SHOULD | Fix suggestions for common error types |
| FR-11 | MAY | Error trend chart (7-day) |

### 2.2 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Dashboard loads < 2s for 1,000 errors | Paginated, indexed |
| NFR-2 | Collection capped 10,000 docs/tenant | TTL cleanup resolved > 30d |
| NFR-3 | Dark + Light Mode | |
| NFR-4 | Multi-tenancy | tenantId on all docs |
| NFR-5 | error-collector is fire-and-forget | Never throws, never blocks |

---

## 3. Architecture

### 3.1 Backend Changes

**New Files:**

```
backend/lib/error-collector.js            — Write to operationalErrors (fire-and-forget)
backend/services/error-dashboard.js       — Query, aggregate, resolve
```

**Modified Files (1 line each — collectError() call):**

```
backend/routes/products.js                — 3 new endpoints
backend/services/stock-sync-dispatcher.js — collectError() on sync failure
backend/services/sync-event-bus.js        — collectError() on handler failure
backend/services/marketplace-tracking.js  — collectError() on push failure
backend/routes/webhooks.js                — collectError() on webhook failure
backend/lib/jobs.js                       — collectError() on dead-letter move
```

**New Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/errors` | List errors (paginated, filterable) |
| GET | `/api/v1/errors/summary` | KPI summary |
| PATCH | `/api/v1/errors/:errorId/resolve` | Mark resolved |

### 3.2 Frontend Changes

**New Files:**

```
components/ErrorDashboard.tsx
components/error-dashboard/ErrorList.tsx
components/error-dashboard/ErrorKPIs.tsx
components/error-dashboard/ErrorRow.tsx
hooks/useErrors.ts                         — fetch + 30s polling for badge
```

**Modified Files:**

```
App.tsx                   — route /errors → ErrorDashboard
components/Sidebar.tsx    — "Fehler" nav item with badge
api/client.ts             — fetchErrors(), fetchErrorSummary(), resolveError()
```

### 3.3 Data Model

**New Collection:** `operationalErrors`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | string | Yes | Tenant |
| `type` | string | Yes | `sync_failure` \| `api_error` \| `job_failure` \| `validation_error` \| `webhook_error` |
| `severity` | string | Yes | `critical` \| `warning` \| `info` |
| `channel` | string | Yes | `ebay` \| `kaufland` \| `sendcloud` \| `internal` |
| `message` | string | Yes | Human-readable description |
| `details` | string | No | Technical detail (stack, API response) |
| `entityType` | string | No | `product` \| `order` \| `shipment` \| `job` |
| `entityId` | string | No | Affected entity ID (for linking) |
| `entityName` | string | No | Display name |
| `source` | string | Yes | Service name |
| `status` | string | Yes | `open` \| `resolved` |
| `fixSuggestion` | string | No | Actionable fix suggestion |
| `createdAt` | timestamp | Yes | Error time |
| `resolvedAt` | timestamp | No | Resolution time |
| `resolvedBy` | string | No | User UID |

**Indexes:** `tenantId+status+createdAt(desc)`, `tenantId+type+status`, `tenantId+channel+status`

---

## 4. UI/UX Specification

### 4.1 User Flow

```
1. Seller sees red badge "3" on "Fehler" in sidebar
2. Clicks → ErrorDashboard
3. Top: KPI tiles (Total Open | Critical | Warning | Channels)
4. Below: Filterable error list
5. Each row: Severity dot | Message | Channel badge | Time ago | Entity link | [Erledigt]
6. Click entity link → product/order detail
7. Click "Erledigt" → resolved, badge decreases
```

### 4.2 Component Hierarchy

```
<ErrorDashboard>
  ├── <ErrorKPIs>         — 4 KPI tiles
  ├── <ErrorFilters>      — type, channel, severity, status dropdowns
  └── <ErrorList>
      └── <ErrorRow> × N  — severity dot, message, channel, link, action
```

### 4.3 Design

- KPI tiles: `bg-app-surface rounded-md border-app-border`, critical count in `text-danger`
- Error list: alternating rows, severity dots (danger/warning/info)
- Channel badges: small pills
- Entity link: `text-accent` underline
- Sidebar badge: red circle, white count, only when > 0

### 4.4 States

| State | UI |
|-------|----|
| No errors | Checkmark + "Alles in Ordnung" |
| Loading | Skeleton |
| Resolved | Row fades, KPIs update |
| > 50 | Pagination |

### 4.5 Fix Suggestion Mapping

| Pattern | Suggestion |
|---------|------------|
| Sync: no EAN | "EAN fehlt — Produkt bearbeiten und EAN ergänzen" |
| Sync: API timeout | "API temporär nicht erreichbar — wird erneut versucht" |
| Job: max retries | "Identifikation fehlgeschlagen — Bild prüfen, erneut versuchen" |
| Webhook: invalid sig | "Webhook-Secret in Einstellungen prüfen" |
| Tracking push failed | "Tracking manuell im Marktplatz eintragen" |

---

## 5. Technical Implementation

### 5.1 Build Sequence

```
Step 1: [Backend] Create lib/error-collector.js
        - collectError({ tenantId, type, severity, channel, message, ... })
        - Fire-and-forget: wraps all logic in try/catch, NEVER throws
        - Includes fix-suggestion pattern matching
        Test: Unit test — document structure, never-throws guarantee

Step 2: [Backend] Create services/error-dashboard.js
        - listErrors({ tenantId, filters, page, pageSize })
        - getErrorSummary({ tenantId }) — counts by type/channel/severity
        - resolveError({ tenantId, errorId, resolvedBy })
        Test: Unit test with mocked Firestore

Step 3: [Backend] Add 3 endpoints to routes/products.js
        - GET /api/v1/errors (auth: products.read)
        - GET /api/v1/errors/summary (auth: products.read)
        - PATCH /api/v1/errors/:errorId/resolve (auth: products.write)
        Test: API integration tests

Step 4: [Backend] Instrument error sources — ONE LINE each
        - stock-sync-dispatcher.js, sync-event-bus.js, marketplace-tracking.js,
          routes/webhooks.js, lib/jobs.js
        Test: Existing tests still pass (zero behavior change)

Step 5: [Frontend] api/client.ts — 3 new functions
Step 6: [Frontend] hooks/useErrors.ts — fetch + 30s polling
Step 7: [Frontend] ErrorDashboard + sub-components
Step 8: [Frontend] App.tsx route + Sidebar.tsx badge
```

### 5.2 API Contracts

#### GET /api/v1/errors

```javascript
// ?type=sync_failure&channel=ebay&status=open&page=1&pageSize=50
{
  "ok": true,
  "data": {
    "errors": [{
      "id": "err_abc123", "type": "sync_failure", "severity": "critical",
      "channel": "ebay", "message": "Stock-Push fehlgeschlagen: eBay API Timeout",
      "entityType": "product", "entityId": "prod_xyz789",
      "entityName": "Samsung Galaxy S24 128GB",
      "source": "stock-sync-dispatcher",
      "fixSuggestion": "eBay API temporär nicht erreichbar — wird erneut versucht",
      "status": "open", "createdAt": "2026-03-19T14:30:00Z"
    }],
    "total": 42, "page": 1, "pageSize": 50
  }
}
```

#### GET /api/v1/errors/summary

```javascript
{
  "ok": true,
  "data": {
    "total": 42,
    "byStatus": { "open": 38, "resolved": 4 },
    "bySeverity": { "critical": 5, "warning": 28, "info": 9 },
    "byType": { "sync_failure": 20, "api_error": 10, "job_failure": 5, "webhook_error": 7 },
    "byChannel": { "ebay": 15, "kaufland": 18, "sendcloud": 5, "internal": 4 }
  }
}
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Test | File |
|------|------|
| `should write error document` | `error-collector.test.js` |
| `should never throw` | `error-collector.test.js` |
| `should match fix suggestions` | `error-collector.test.js` |
| `should list with filters` | `error-dashboard.test.js` |
| `should return summary` | `error-dashboard.test.js` |
| `should resolve error` | `error-dashboard.test.js` |

### 6.2 Manual Verification

```
□ Stock sync errors appear in dashboard
□ Dead-letter job errors appear
□ Entity links navigate correctly
□ Fix suggestions show for known patterns
□ "Erledigt" resolves, badge updates
□ Filters work
□ Dark + Light Mode
□ Existing flows unaffected (fire-and-forget)
```

---

## 7. References

| Source | Current Storage | Integration Point |
|--------|----------------|-------------------|
| Stock sync | `stock_sync_log`, `stock_sync_failures` | `stock-sync-dispatcher.js` |
| Job failures | `deadLetterJobs` | `lib/jobs.js` |
| Webhooks | console only | `routes/webhooks.js` |
| Sync bus | console only | `sync-event-bus.js` |
| Tracking | console only | `marketplace-tracking.js` |

| Related Feature | Relationship |
|-----------------|-------------|
| VAL-001 | Validation errors feed into dashboard |
| BULK-001 | Bulk fix from error dashboard |
| DASH-001 | Shares KPI tile pattern |

---

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-19 | 0.1 | Initial draft |
| 2026-03-19 | 1.0 | Complete spec |
