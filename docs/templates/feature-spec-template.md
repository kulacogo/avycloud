# [ID]: [Feature Name]

> **Copy this template to `docs/features/<ID>/spec.md` and fill in all sections.**
> **Delete all instructional comments (lines starting with >) before finalizing.**

---

## Meta

| Field | Value |
|-------|-------|
| **ID** | `[CATEGORY-NNN]` (e.g., BULK-001, AI-002, MP-001) |
| **Priority** | `P0` / `P1` / `P2` / `P3` |
| **Status** | `Draft` / `Ready` / `In Progress` / `Complete` |
| **Change Level** | `L0` / `L1` / `L2` / `L3` (see AGENT_RULES.md §2) |
| **Effort Estimate** | `S` (1-3d) / `M` (3-7d) / `L` (1-3w) / `XL` (3w+) |
| **Dependencies** | List other feature IDs this depends on, or "None" |
| **Source** | `competitive-analysis` / `user-request` / `bug` / `marktanalyse` |
| **Protected Zones Affected** | List any Yellow/Red Zone files from AGENT_RULES.md §3 |

---

## 1. Problem Statement

> What gap does this fill? What problem does it solve? Who benefits?
> Reference competitive analysis findings where applicable.
> Be specific: "Users with >50 SKUs cannot efficiently update product data" not "Bulk editing is missing."

### User Story

```
As a [role],
I want to [action],
so that [benefit].
```

### Current State

> What does AvyCloud do today? What workaround exists (if any)?

### Desired State

> What should it do after this feature is implemented?

---

## 2. Requirements

### 2.1 Functional Requirements

> Numbered list. Each requirement is testable and unambiguous.
> Use MUST/SHOULD/MAY (RFC 2119) for priority.

| # | Requirement | Priority |
|---|-------------|----------|
| FR-1 | | MUST |
| FR-2 | | MUST |
| FR-3 | | SHOULD |
| FR-4 | | MAY |

### 2.2 Non-Functional Requirements

| # | Requirement | Target |
|---|-------------|--------|
| NFR-1 | Performance | e.g., "Bulk edit of 500 products completes in <5s" |
| NFR-2 | Accessibility | WCAG 2.1 AA compliance |
| NFR-3 | Responsiveness | Works on viewport ≥768px (tablet+) |
| NFR-4 | Theme Support | Must work in Dark Mode AND Light Mode |
| NFR-5 | Multi-Tenancy | All queries/writes include tenantId |

---

## 3. Architecture

### 3.1 Backend Changes

> List all backend files that need to be created or modified.
> For modified files, specify WHAT changes (new function, modified function, new route).

**New Files:**
```
backend/services/[new-service].js    — [purpose]
backend/lib/[new-lib].js            — [purpose]
```

**Modified Files:**
```
backend/routes/[router].js          — Add [routes]: [METHOD /api/v1/path]
backend/lib/[existing].js           — Add [function-name](): [purpose]
```

**New API Endpoints:**

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| GET | `/api/v1/...` | | — | `{ ok: true, data: [...] }` |
| POST | `/api/v1/...` | | `{ ... }` | `{ ok: true, ... }` |

### 3.2 Frontend Changes

> List all frontend files that need to be created or modified.

**New Files:**
```
components/[Component].tsx          — [purpose]
hooks/use[Hook].ts                  — [purpose]
```

**Modified Files:**
```
App.tsx                             — Add route: /[path] → [Component]
components/Sidebar.tsx              — Add navigation entry (if applicable)
```

### 3.3 Data Model Changes

> Firestore collection/field changes. Remember: ADDITIVE ONLY.

**Collection:** `[collection_name]`

| Field | Type | Required | Description | New/Existing |
|-------|------|----------|-------------|-------------|
| `tenantId` | string | Yes | Tenant identifier | Existing |
| `newField` | string | No | [purpose] | **New** |

> ⚠️ NEVER rename or delete existing fields. Only add new fields.

---

## 4. UI/UX Specification

### 4.1 User Flow

> Step-by-step flow from user perspective.
> Number each step. Include decision points (if/else).

```
1. User navigates to [page]
2. User sees [initial state]
3. User performs [action]
4. System responds with [feedback]
5. ...
```

### 4.2 Component Hierarchy

> Tree structure of React components for this feature.

```
<ParentComponent>
  ├── <ChildA>
  │   ├── <GrandchildA1 />
  │   └── <GrandchildA2 />
  └── <ChildB />
```

### 4.3 Layout & Design

> Describe the visual layout using AvyCloud design tokens.
> Reference existing components where patterns should be reused.
> Include wireframes or ASCII mockups for complex layouts.

**Design Token Usage:**
- Background: `bg-app-surface`
- Text: `text-txt-primary`, `text-txt-secondary`
- Accent: `bg-accent`, `text-accent`
- Borders: `border-app-border`
- Radius: `rounded-md` (cards), `rounded-sm` (buttons/inputs)
- Status: `text-success`, `text-warning`, `text-danger`

> See `styles/main.css` and `tailwind.config.cjs` for full token list.
> See `CLAUDE.md` Brand & Design System section for rules.

### 4.4 States & Edge Cases

| State | UI Behavior |
|-------|-------------|
| Loading | Skeleton loader / spinner |
| Empty | Empty state message with CTA |
| Error | Error toast / inline error |
| Success | Success toast / visual confirmation |
| Large dataset (1000+ items) | Pagination / virtual scroll |

### 4.5 Responsive Behavior

> How does this feature behave at different viewport sizes?

| Breakpoint | Behavior |
|------------|----------|
| Desktop (≥1280px) | Full layout |
| Tablet (≥768px) | Adapted layout |
| Mobile (<768px) | Simplified / hidden |

---

## 5. Technical Implementation

### 5.1 Build Sequence

> Ordered list of implementation steps. An agent follows this sequence exactly.
> Each step should be independently testable.

```
Step 1: [Backend] Create [service/lib]
        Test: [what to verify]

Step 2: [Backend] Add API endpoint [route]
        Test: [what to verify]

Step 3: [Frontend] Create [component]
        Test: [what to verify]

Step 4: [Frontend] Wire up [hook/context]
        Test: [what to verify]

Step 5: [Integration] End-to-end flow
        Test: [what to verify]
```

### 5.2 API Contracts

> Detailed request/response shapes for each new endpoint.

```javascript
// POST /api/v1/example
// Request:
{
  "tenantId": "string (required)",
  "items": [
    { "id": "string", "field": "value" }
  ]
}

// Response (200):
{
  "ok": true,
  "data": { ... },
  "meta": { "count": 0, "duration_ms": 0 }
}

// Response (400):
{
  "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "..." }
}

// Response (500):
{
  "ok": false,
  "error": { "code": "INTERNAL", "message": "..." }
}
```

### 5.3 Error Handling

> List expected error scenarios and how they should be handled.

| Error Scenario | HTTP Status | Error Code | User-Facing Message |
|---------------|-------------|------------|-------------------|
| Invalid input | 400 | VALIDATION_ERROR | [specific message] |
| Not found | 404 | NOT_FOUND | [specific message] |
| External API failure | 502 | UPSTREAM_ERROR | [specific message] |
| Internal error | 500 | INTERNAL | [specific message] |

### 5.4 Edge Cases

> List edge cases the implementation must handle.

| # | Edge Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | Empty selection | Show validation message |
| 2 | Network timeout | Retry once, then show error |
| 3 | Concurrent modification | Last-write-wins / optimistic locking |

---

## 6. Testing Strategy

### 6.1 Unit Tests

> List specific test cases for backend services/libs.

| Test | File | Description |
|------|------|-------------|
| `should [behavior]` | `[file].test.js` | [what it verifies] |
| `should reject [invalid input]` | `[file].test.js` | [negative case] |

### 6.2 Integration Tests

> List API-level test cases.

| Test | Endpoint | Description |
|------|----------|-------------|
| `should return 200 with valid data` | `POST /api/v1/...` | Happy path |
| `should return 400 for invalid input` | `POST /api/v1/...` | Validation |

### 6.3 Manual Verification Checklist

> Steps a human must verify after implementation (especially for L2+ changes).

```
□ Feature works in Dark Mode
□ Feature works in Light Mode
□ Feature works at 768px viewport
□ No console errors in browser
□ API responses match contract
□ Error states display correctly
□ Loading states display correctly
□ Empty states display correctly
```

---

## 7. References

### 7.1 Competitor Benchmarks

> How do competitors implement this feature? What can we learn?
> Reference specific competitor findings from docs/competitive-analysis/

### 7.2 Related Features

> Other feature specs that interact with or depend on this one.

| Feature ID | Relationship |
|------------|-------------|
| [ID] | [how they relate] |

### 7.3 Source Documents

> Links to research, analysis, or discussions that informed this spec.

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| YYYY-MM-DD | 0.1 | Initial draft |
