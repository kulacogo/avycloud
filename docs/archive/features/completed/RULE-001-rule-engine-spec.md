# RULE-001: Visual Rule Engine

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | RULE-001 |
| **Title** | Visual Rule Engine |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L2 |
| **Effort** | M (2–3 weeks) |
| **Source** | marktanalyse + competitive-analysis (Channable benchmark) |
| **Dependencies** | Benefits from BULK-001 infrastructure, reuses rulebook-runner.js job pattern |
| **Protected Zones** | New route `backend/routes/rules.js`, new collections `automationRules` + `automationJobs` |
| **TASKS.md Module** | Rule Engine |

---

## 1. Problem Statement

AvyCloud has a **rulebook system** for LLM-based product normalization (`llm-rulebook.js`, `rulebook-runner.js`) and a **pricing engine** with per-product pricing rules. But there is **no general-purpose automation engine** — no way for sellers to define "If X, then Y" rules that transform product data across their catalog.

Channable's visual rule engine is the industry gold standard (15K+ customers). Rithum has algorithmic repricing triggers. Zentail has SMART Types for auto-categorization. AvyCloud sellers currently do all data transformation manually.

**What exists today:**
- `rulebook-runner.js` — job runner with p-queue, Firestore job queue (`rulebookApplyJobs`), retry/backoff
- `rulebook-config.js` — admin-editable rulebook config (title rules, highlights, attributes)
- `pricing-engine.js` — per-product pricing rules with 4 strategies
- `saveProductV2()` — canonical write path for all product mutations

**What's missing:**
- A general rule engine that operates on arbitrary product fields
- A UI to create, manage, and monitor these rules
- Batch execution with dry-run capability
- Pre-built templates for common scenarios

### User Story

```
As a multichannel seller,
I want to define if/then rules that automatically transform my product data,
so that I can optimize listings without manual work on every product.
```

### Desired State

- Visual rule builder (form-based, not drag-and-drop — faster to build, easier to use)
- Rules operate on any product field in `products_v2`
- Dry-run mode to preview changes before applying
- Batch execution with progress tracking (reusing job runner pattern)
- 6+ pre-built templates for common scenarios
- Per-rule execution log for audit trail

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Rule CRUD: create, read, update, delete automation rules |
| FR-2 | MUST | Condition builder: field + operator + value (AND logic within a rule) |
| FR-3 | MUST | Action builder: set field, adjust price, text manipulation |
| FR-4 | MUST | Dry-run mode: preview affected products + planned changes without applying |
| FR-5 | MUST | Batch execution: apply rule to matching products with progress tracking |
| FR-6 | MUST | Enable/disable individual rules |
| FR-7 | MUST | Rule dashboard with list, status, last run, affected count |
| FR-8 | SHOULD | Template library: 6+ pre-built rules for common scenarios |
| FR-9 | SHOULD | Rule preview: show matching product count in real-time while editing |
| FR-10 | SHOULD | Execution history log per rule |
| FR-11 | MAY | Per-channel rules (eBay vs. Kaufland specific) |
| FR-12 | MAY | Rule scheduling (auto-run on interval) |

### 2.2 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Rule list loads < 1s | Simple Firestore query |
| NFR-2 | Dry-run for 1000 products < 5s | Stream results |
| NFR-3 | Batch execution: progress visible via SSE | Reuse existing job stream pattern |
| NFR-4 | Dark + Light Mode | Design token based |
| NFR-5 | Multi-tenancy | tenantId on all rules + jobs |

---

## 3. Architecture

### 3.1 Backend — New Files

```
backend/services/rule-engine.js      — Core: evaluateConditions(), applyActions(), executeRule()
backend/services/rule-runner.js      — Job runner (follows rulebook-runner.js pattern with p-queue)
backend/routes/rules.js              — REST API: 8 endpoints
```

### 3.2 Backend — Modified Files

```
backend/server.js                    — Mount /api/v1/rules routes
```

### 3.3 Frontend — New Files

```
components/RuleDashboard.tsx         — Main page with rule list + KPIs
components/rules/RuleList.tsx        — Table of all rules
components/rules/RuleForm.tsx        — Create/edit form with conditions + actions
components/rules/ConditionRow.tsx    — Single condition: field → operator → value
components/rules/ActionRow.tsx       — Single action: type → field → value
components/rules/RulePreview.tsx     — Dry-run results display
components/rules/RuleTemplates.tsx   — Template picker modal
hooks/useRules.ts                   — CRUD + execute + dry-run operations
```

### 3.4 Frontend — Modified Files

```
App.tsx                              — Add route /rules → RuleDashboard
components/Sidebar.tsx               — Add "Regeln" nav item
api/client.ts                        — Add rule API functions
```

### 3.5 Data Model

#### Collection: `automationRules`

```javascript
{
  id: string,                        // auto-generated
  tenantId: string,                  // REQUIRED
  name: string,                      // "Preise runden auf .99"
  description: string,               // optional
  active: boolean,                   // default true
  conditions: [                      // AND logic — all must match
    {
      field: string,                 // "details.pricing.sellPrice"
      operator: string,              // "greater_than" | "less_than" | "equals" | "not_equals" |
                                     // "contains" | "not_contains" | "starts_with" | "ends_with" |
                                     // "is_empty" | "is_not_empty"
      value: any                     // comparison value (ignored for is_empty/is_not_empty)
    }
  ],
  actions: [                         // applied sequentially
    {
      type: string,                  // "set_field" | "adjust_price" | "prepend_text" |
                                     // "append_text" | "replace_text"
      field: string,                 // target field path
      value: any,                    // new value / adjustment amount / text
      params: {                      // type-specific params
        mode?: string,               // adjust_price: "percent" | "absolute"
        search?: string,             // replace_text: search string
        replace?: string             // replace_text: replacement string
      }
    }
  ],
  stats: {
    lastRunAt: string | null,        // ISO timestamp
    lastRunProducts: number,         // products matched
    lastRunApplied: number,          // products changed
    totalRuns: number
  },
  channel: string | null,            // null = all channels, "ebay" | "kaufland"
  createdAt: string,
  updatedAt: string,
  createdBy: string                  // userEmail
}
```

#### Collection: `automationJobs`

```javascript
{
  id: string,                        // auto-generated
  tenantId: string,
  ruleId: string,
  status: string,                    // "pending" | "processing" | "done" | "failed"
  mode: string,                      // "execute" | "dry_run"
  progress: {
    total: number,
    processed: number,
    applied: number,
    skipped: number,
    errors: number
  },
  result: {                          // populated when done
    summary: string,
    changes: [                       // first 100 changes for preview
      { productId: string, productName: string, field: string, oldValue: any, newValue: any }
    ]
  },
  error: string | null,
  attempts: number,
  createdAt: string,
  updatedAt: string
}
```

---

## 4. API Contracts

### 4.1 Rule CRUD

#### GET /api/v1/rules

```javascript
// Query: ?active=true (optional filter)
// Response (200):
{ "ok": true, "data": [{ id, name, description, active, conditions, actions, stats, channel, createdAt }] }
```

#### GET /api/v1/rules/:ruleId

```javascript
// Response (200):
{ "ok": true, "data": { id, name, description, active, conditions, actions, stats, channel, createdAt, updatedAt } }
// Response (404):
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Regel nicht gefunden" } }
```

#### POST /api/v1/rules

```javascript
// Body: { name, description?, conditions, actions, channel?, active? }
// Response (201):
{ "ok": true, "data": { id, name, ... } }
// Response (400):
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "Name ist erforderlich" } }
```

#### PUT /api/v1/rules/:ruleId

```javascript
// Body: { name?, description?, conditions?, actions?, channel?, active? }
// Response (200):
{ "ok": true, "data": { id, name, ... } }
```

#### DELETE /api/v1/rules/:ruleId

```javascript
// Response (200):
{ "ok": true }
// Response (404):
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Regel nicht gefunden" } }
```

### 4.2 Rule Execution

#### PATCH /api/v1/rules/:ruleId/toggle

```javascript
// Response (200):
{ "ok": true, "data": { "id": "...", "active": false } }
```

#### POST /api/v1/rules/:ruleId/execute

```javascript
// Body: { mode: "execute" | "dry_run", limit?: number }
// Response (202):
{ "ok": true, "data": { "jobId": "...", "status": "pending" } }
```

#### GET /api/v1/rules/jobs/:jobId

```javascript
// Response (200):
{
  "ok": true,
  "data": {
    "id": "...",
    "ruleId": "...",
    "status": "processing",
    "mode": "dry_run",
    "progress": { "total": 500, "processed": 230, "applied": 180, "skipped": 50, "errors": 0 },
    "result": null
  }
}
// When done, result is populated with summary + first 100 changes
```

#### GET /api/v1/rules/:ruleId/preview

```javascript
// Query: ?limit=20 (default 20, max 100)
// Response (200) — quick preview of matching products without applying:
{
  "ok": true,
  "data": {
    "matchCount": 342,
    "sample": [
      { "productId": "...", "productName": "...", "changes": [{ "field": "...", "oldValue": "...", "newValue": "..." }] }
    ]
  }
}
```

---

## 5. UI/UX Specification

### 5.1 User Flow — Rule Dashboard

```
1. Seller clicks "Regeln" in sidebar
2. RuleDashboard opens:
   a. KPI bar: Aktive Regeln | Letzter Lauf | Produkte betroffen | Regeln gesamt
   b. Rule list table
   c. [+ Neue Regel] button + [Vorlagen] button
3. Rule list:
   - Each row: Name | Bedingungen (count) | Aktionen (count) | Active toggle | Letzter Lauf | Betroffen | [Ausführen] [Bearbeiten] [Löschen]
4. Click [+ Neue Regel] or [Bearbeiten] → RuleForm
5. Click [Ausführen] → confirmation modal with dry-run option
6. Click [Vorlagen] → RuleTemplates modal
```

### 5.2 User Flow — Rule Form

```
1. Header: "Neue Regel" or "Regel bearbeiten: {name}"
2. Name + Description fields
3. Conditions section:
   - [+ Bedingung hinzufügen] → ConditionRow (field dropdown → operator dropdown → value input)
   - Multiple conditions = AND logic
   - Live preview: "{N} Produkte treffen zu" (calls /preview endpoint)
4. Actions section:
   - [+ Aktion hinzufügen] → ActionRow (type dropdown → field → value/params)
   - Multiple actions = sequential execution
5. Channel selector: Alle Kanäle | eBay | Kaufland
6. Footer: [Vorschau] [Speichern] [Abbrechen]
   - [Vorschau] → RulePreview panel showing sample changes
```

### 5.3 Component Hierarchy

```
<RuleDashboard>
  ├── <RuleKPIs>                     — Active rules, last run, affected products
  ├── <RuleList>
  │   └── <RuleRow> × N             — Name, conditions badge, actions badge, toggle, actions
  ├── <RuleForm>                     — Modal/panel for create/edit
  │   ├── <ConditionRow> × N        — Field → operator → value
  │   ├── <ActionRow> × N           — Type → field → value/params
  │   └── <RulePreview>             — Dry-run results table
  └── <RuleTemplates>               — Template picker modal
```

### 5.4 Condition Fields (Dropdown Options)

| Field Path | Display Label | Operators |
|------------|---------------|-----------|
| `identification.name` | Produktname | contains, not_contains, starts_with, ends_with, is_empty, is_not_empty |
| `identification.brand` | Marke | equals, not_equals, contains, is_empty, is_not_empty |
| `identification.category` | Kategorie | equals, not_equals, contains |
| `details.pricing.sellPrice` | Verkaufspreis | greater_than, less_than, equals |
| `details.pricing.buyPrice` | Einkaufspreis | greater_than, less_than, equals, is_empty |
| `details.short_description` | Kurzbeschreibung | contains, not_contains, is_empty, is_not_empty |
| `details.key_features` | Highlights | is_empty, is_not_empty |
| `details.identifiers.ean` | EAN | equals, is_empty, is_not_empty |
| `inventory.quantity` | Bestand | greater_than, less_than, equals |
| `storage.binCode` | Lagerplatz | equals, is_empty, is_not_empty |

### 5.5 Action Types

| Type | Display Label | Fields | Description |
|------|---------------|--------|-------------|
| `set_field` | Feld setzen | field, value | Sets field to exact value |
| `adjust_price` | Preis anpassen | field, value, params.mode (percent/absolute) | Adds/subtracts from price field |
| `prepend_text` | Text voranstellen | field, value | Prepends text to string field |
| `append_text` | Text anhängen | field, value | Appends text to string field |
| `replace_text` | Text ersetzen | field, params.search, params.replace | Find & replace in string field |

### 5.6 Templates

| # | Template Name | Conditions | Actions |
|---|---------------|------------|---------|
| 1 | **Preisrundung auf .99** | sellPrice > 0 | adjust_price: round down to .99 |
| 2 | **eBay Titel-Prefix** | channel = ebay, name is_not_empty | prepend_text: "✅ " to name |
| 3 | **Niedrigbestand markieren** | quantity < 5 | set_field: details.attributes.verfuegbarkeit = "Wenige verfügbar" |
| 4 | **Fehlende Beschreibung** | short_description is_empty | set_field: short_description = "{name} — Jetzt kaufen bei TrendOcean" |
| 5 | **Zustand standardisieren** | name contains "neu", brand is_not_empty | set_field: details.attributes.zustand = "Neu" |
| 6 | **Mindestpreis-Guard** | sellPrice < buyPrice | set_field: sellPrice = buyPrice * 1.15 |

### 5.7 Design

- Dashboard: same layout pattern as PricingDashboard / AdminTable
- KPI tiles: `bg-app-surface rounded-md`, reuse ERR-001 pattern
- Rule list: `bg-app-surface`, active toggle as accent switch
- Condition rows: `bg-app-elevated rounded-lg p-3`, field/operator/value in flex layout
- Action rows: same pattern, different accent color
- Preview badge: `text-accent font-semibold` showing "{N} Produkte"
- Template cards: `bg-app-surface border border-app-border rounded-lg`, icon + name + description

### 5.8 States

| State | UI |
|-------|----|
| No rules | Empty state: "Noch keine Regeln — Erste Regel erstellen oder Vorlage wählen" |
| Rule form — no conditions | Disabled preview, "Mindestens eine Bedingung erforderlich" |
| Dry-run running | Spinner + "Vorschau wird berechnet..." |
| Dry-run complete | Table: Product | Field | Alt → Neu, with accept/reject |
| Execution running | Progress bar + processed/total counter |
| Execution complete | Toast: "{N} Produkte aktualisiert", stats update |
| Rule disabled | Row grayed out, toggle off |

---

## 6. Technical Implementation

### 6.1 Build Sequence

```
Step 1:  [Backend] services/rule-engine.js — Core logic
         - evaluateConditions(product, conditions) → boolean
         - applyActions(product, actions) → { updatedProduct, changes[] }
         - executeRule(ruleId, mode, limit) → creates automationJob, returns jobId
         - getMatchingProducts(conditions, limit) → products[]
         - Auth: products.write for execute, products.read for preview
         Test: Unit tests for each condition operator + action type

Step 2:  [Backend] services/rule-runner.js — Job runner
         - Follow rulebook-runner.js pattern: p-queue, job claim, retry, backoff
         - processAutomationJob(jobId): claim → load rule → query products → evaluate → apply → update job
         - Writes product changes via saveProductV2()
         - Emits progress via job document updates (frontend polls or SSE)
         Test: Job lifecycle test (pending → processing → done)

Step 3:  [Backend] routes/rules.js — REST API
         - 8 endpoints as defined in Section 4
         - All endpoints require auth + tenantId
         - Mount in server.js: app.use('/api/v1/rules', requireAuth, rulesRouter)
         Test: API tests for CRUD + execute + preview

Step 4:  [Frontend] api/client.ts — Add rule API functions
         - listRules(), getRule(), createRule(), updateRule(), deleteRule()
         - toggleRule(), executeRule(), getJobStatus(), previewRule()
         Test: Build passes

Step 5:  [Frontend] hooks/useRules.ts — CRUD + execution hook
         - State management for rules list, loading, errors
         - Polling for job status during execution
         Test: Hook renders

Step 6:  [Frontend] ConditionRow.tsx + ActionRow.tsx — Form building blocks
         - ConditionRow: field dropdown, operator dropdown (filtered by field type), value input
         - ActionRow: type dropdown, field dropdown, value/params inputs
         - Both have [×] remove button
         Test: Components render, dropdowns populate

Step 7:  [Frontend] RuleForm.tsx — Create/edit form
         - Name, description, channel selector
         - Dynamic condition/action rows with add/remove
         - Live preview count (debounced /preview call)
         - Validation: name required, min 1 condition, min 1 action
         Test: Form renders, validates, submits

Step 8:  [Frontend] RulePreview.tsx — Dry-run results
         - Table: Product | Field | Alter Wert | Neuer Wert
         - Summary bar: {matched} Produkte, {changes} Änderungen
         Test: Component renders with mock data

Step 9:  [Frontend] RuleTemplates.tsx — Template picker
         - Grid of template cards with icon, name, description
         - Click → pre-fills RuleForm with template conditions + actions
         Test: Templates render, click applies template

Step 10: [Frontend] RuleList.tsx — Rules table
         - Columns: Name | Bedingungen | Aktionen | Aktiv | Letzter Lauf | Betroffen | Actions
         - Active toggle calls toggleRule()
         - Action buttons: [▶ Ausführen] [✏ Bearbeiten] [🗑 Löschen]
         - Delete with confirmation modal
         Test: Table renders with mock rules

Step 11: [Frontend] RuleDashboard.tsx — Main page
         - KPI bar: Aktive Regeln, Letzter Lauf, Produkte betroffen
         - RuleList below
         - [+ Neue Regel] → opens RuleForm
         - [Vorlagen] → opens RuleTemplates
         Test: Page renders with all sub-components

Step 12: [Frontend] Wire into App.tsx + Sidebar.tsx
         - Route /rules → RuleDashboard
         - Sidebar: "Regeln" nav item with icon
         Test: Navigation works, route renders

Step 13: [Integration] Audit log integration
         - Log rule.created, rule.updated, rule.deleted, rule.executed actions
         - Use existing audit log pattern (AuditLogView already handles these action types)
         Test: Actions appear in audit log

Step 14: [QA] Full verification
         - Create rule from template → dry-run → execute → verify product changes
         - All CRUD operations
         - Dark + Light Mode
         - Empty states
         - Error handling (invalid conditions, no matching products)
```

### 6.2 rule-engine.js — Core Logic Detail

```javascript
// Condition evaluation
function evaluateCondition(product, condition) {
  const value = getNestedField(product, condition.field);
  switch (condition.operator) {
    case 'equals':        return value === condition.value;
    case 'not_equals':    return value !== condition.value;
    case 'greater_than':  return Number(value) > Number(condition.value);
    case 'less_than':     return Number(value) < Number(condition.value);
    case 'contains':      return String(value || '').toLowerCase().includes(String(condition.value).toLowerCase());
    case 'not_contains':  return !String(value || '').toLowerCase().includes(String(condition.value).toLowerCase());
    case 'starts_with':   return String(value || '').toLowerCase().startsWith(String(condition.value).toLowerCase());
    case 'ends_with':     return String(value || '').toLowerCase().endsWith(String(condition.value).toLowerCase());
    case 'is_empty':      return value == null || value === '' || (Array.isArray(value) && value.length === 0);
    case 'is_not_empty':  return value != null && value !== '' && !(Array.isArray(value) && value.length === 0);
    default: return false;
  }
}

// All conditions must match (AND logic)
function evaluateConditions(product, conditions) {
  return conditions.every(c => evaluateCondition(product, c));
}

// Action application — returns changes array for audit
function applyAction(product, action) {
  const oldValue = getNestedField(product, action.field);
  let newValue;
  switch (action.type) {
    case 'set_field':
      newValue = action.value;
      break;
    case 'adjust_price':
      const current = Number(oldValue) || 0;
      newValue = action.params?.mode === 'percent'
        ? +(current * (1 + Number(action.value) / 100)).toFixed(2)
        : +(current + Number(action.value)).toFixed(2);
      break;
    case 'prepend_text':
      newValue = `${action.value}${oldValue || ''}`;
      break;
    case 'append_text':
      newValue = `${oldValue || ''}${action.value}`;
      break;
    case 'replace_text':
      newValue = String(oldValue || '').replaceAll(action.params.search, action.params.replace);
      break;
  }
  setNestedField(product, action.field, newValue);
  return { field: action.field, oldValue, newValue };
}
```

### 6.3 rule-runner.js — Job Runner Pattern

```javascript
// Follows rulebook-runner.js pattern exactly:
const PQueue = require('p-queue').default;
const queue = new PQueue({ concurrency: Number(process.env.RULE_JOB_CONCURRENCY || 1) });

async function processAutomationJob(jobId) {
  // 1. Claim job (Firestore transaction — prevents double-processing)
  // 2. Load rule from automationRules
  // 3. Query products_v2 with tenantId
  // 4. Filter by evaluateConditions()
  // 5. If mode === 'dry_run': collect changes without writing
  // 6. If mode === 'execute': applyActions() + saveProductV2() for each match
  // 7. Update job: progress, result, status
  // 8. Update rule stats: lastRunAt, lastRunProducts, lastRunApplied, totalRuns++
}

// Env vars:
// RULE_JOB_CONCURRENCY (default: 1)
// RULE_JOB_MAX_ATTEMPTS (default: 2)
// RULE_JOB_SWEEP_MS (default: 45000)
```

### 6.4 Edge Cases

| # | Edge Case | Behavior |
|---|-----------|----------|
| 1 | Rule with no matching products | Job completes with 0 applied, info toast |
| 2 | Product field doesn't exist (nested path) | Treat as null/empty for condition check |
| 3 | Action would set same value | Skip product, count as "skipped" not "applied" |
| 4 | Concurrent rule executions on same product | p-queue concurrency 1 prevents conflicts |
| 5 | Rule deleted while job running | Job completes current batch, then fails with "rule deleted" |
| 6 | adjust_price on non-numeric field | Skip product, log error in job |
| 7 | replace_text: search string not found | No change, product skipped |
| 8 | Condition field contains array (key_features) | is_empty checks .length, contains checks array.includes |
| 9 | Very large catalog (10K+ products) | Chunked processing (200 per batch), progress updates per chunk |
| 10 | saveProductV2 fails for single product | Log error, continue with next, increment errors count |

---

## 7. Testing Strategy

### 7.1 Unit Tests

| Test | File |
|------|------|
| `evaluateCondition — all 10 operators` | `backend/__tests__/rule-engine.test.js` |
| `evaluateConditions — AND logic, all true/one false` | same |
| `applyAction — all 5 action types` | same |
| `adjust_price — percent and absolute modes` | same |
| `getNestedField / setNestedField — deep paths` | same |
| `edge: null field, empty string, missing path` | same |

### 7.2 API Tests

| Test | File |
|------|------|
| `CRUD: create, list, get, update, delete rule` | `backend/__tests__/rules-api.test.js` |
| `toggle rule active state` | same |
| `preview returns matching products` | same |
| `execute creates job with pending status` | same |
| `validation: missing name, no conditions` | same |
| `404 for non-existent rule` | same |
| `tenantId isolation` | same |

### 7.3 Manual Verification

```
□ Rule list shows all automation rules
□ Create rule with 2 conditions + 1 action → appears in list
□ Edit rule → changes persisted
□ Delete rule → rule removed with confirmation
□ Toggle → active/inactive state changes
□ Preview shows matching product count while editing
□ Dry-run → preview table with old/new values
□ Execute → progress bar → completion toast with stats
□ Template picker → pre-fills form correctly
□ Products actually updated after execution (verify in product detail)
□ Audit log shows rule.created, rule.executed entries
□ Dark + Light Mode
□ Empty states (no rules, no matching products)
□ Error handling (invalid conditions, API errors)
```

---

## 8. References

### 8.1 Existing Backend (reuse patterns)

| File | Purpose |
|------|---------|
| `services/rulebook-runner.js` | **Job runner pattern** — p-queue, claim, retry, backoff |
| `lib/rulebook-apply-jobs.js` | **Job storage** — Firestore CRUD for jobs collection |
| `services/pricing-engine.js` | **Per-product rules** — rule evaluation + batch execution |
| `lib/product-store.js` | **saveProductV2()** — canonical write path |
| `lib/product-canonical.js` | **Product schema** — all available fields |
| `routes/admin.js` | **Rulebook endpoints** — pattern for auth + tenantId |

### 8.2 Related Features

| Feature | Relationship |
|---------|-------------|
| PRICE-001 | Pricing rules are a specialization; RULE-001 is the general engine |
| BULK-001 | Bulk editing applies changes to multiple products; shares UI patterns |
| VAR-001 | Variant model may add variant-specific rule conditions later |
| AI-001 | AI pipeline could trigger rules post-normalization |

---

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-19 | 0.1 | Initial skeleton |
| 2026-03-20 | 1.0 | Complete spec — full architecture, API contracts, data model, build sequence, templates |
