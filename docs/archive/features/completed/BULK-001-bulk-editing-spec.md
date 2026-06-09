# BULK-001: Bulk Editing MVP

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | BULK-001 |
| **Title** | Bulk Editing MVP |
| **Priority** | P0 |
| **Status** | Ready |
| **Change Level** | L2 |
| **Effort** | M (3–5 weeks) |
| **Source** | marktanalyse + competitive-analysis + SWOT W1 (Score 25) |
| **Dependencies** | None — this is the keystone feature |
| **Protected Zones** | `backend/routes/products.js` (Yellow Zone) |
| **TASKS.md Module** | M3 (Produkte), M-AUTO (Automatisierung) |

---

## 1. Problem Statement

Users with >50 SKUs cannot efficiently update product data. Currently only single-product editing exists via the product detail sheet. The existing `BulkActions` component offers action-specific operations (KI Verbessern, Price Refresh, Titel fix, etc.) but no general-purpose field editing across multiple products.

This is the **#1 weakness** in the SWOT analysis (Score 25/25) and listed as **KRITISCH** in the Marktanalyse. Every competitor — Linnworks, SellerCloud, Zentail, JTL-Wawi, even Billbee — offers bulk editing. Without it, professional sellers with >50 SKUs cannot run their business on AvyCloud.

### User Story

```
As a multichannel seller with 200+ products,
I want to select multiple products and change their price, category, or status in one operation,
so that I can manage my catalog in minutes instead of hours.
```

### Current State

- `AdminTable` (~2,340 lines) renders a read-only product table with checkboxes
- `selectedIds: Set<string>` tracks selection (persists across page changes)
- `BulkActions.tsx` shows 7 action-specific bulk operations when selection > 0
- `handleSelectAll()` only selects current page, not all filtered products
- No inline editing — cells are purely display
- No "change field X to value Y for all selected" operation
- No CSV import/export
- No preview/diff before committing changes

### Desired State

- Seller can select products (including "select all filtered") and bulk-update any editable field
- Seller can toggle inline grid editing mode for quick cell-by-cell changes
- All changes show a preview/diff before commit
- CSV export and import provide offline bulk editing workflow
- All writes go through `saveProductV2({ mode: 'manual' })` — no shortcuts

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Checkbox multi-select in product list (already exists, needs cross-page "select all filtered") |
| FR-2 | MUST | Persistent bulk action bar with selection counter showing "N of M selected" (selected / total filtered) |
| FR-3 | MUST | Bulk field update: select products → choose field → enter new value → preview diff → commit |
| FR-4 | MUST | Editable fields for bulk update: `price`, `inventory`, `category`, `name`, `sync_status` |
| FR-5 | MUST | Inline grid editing: toggle "Edit Mode" → cells become editable → dirty tracking → commit all |
| FR-6 | MUST | DryRun preview before commit: show which products change, old → new values, skipped/error items |
| FR-7 | SHOULD | CSV export of selected/filtered products with column selection |
| FR-8 | SHOULD | CSV import for bulk updates with dry-run validation + diff preview |
| FR-9 | SHOULD | "Select all N filtered products" button (not just current page) |
| FR-10 | MAY | Undo last bulk operation (time-limited, stores previous values) |

### 2.2 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Bulk update of 500 products completes in < 30s | Backend batches writes (max 500 per request) |
| NFR-2 | DryRun preview renders in < 2s for 500 products | Frontend diff is computed client-side |
| NFR-3 | Grid edit mode works at 768px+ viewport | Horizontal scroll for overflow columns |
| NFR-4 | Theme support | Dark Mode AND Light Mode |
| NFR-5 | Multi-tenancy | All bulk endpoints include tenantId |
| NFR-6 | No data loss | All writes through saveProductV2() — normalization + validation enforced |

---

## 3. Architecture

### 3.1 Implementation Layers

The feature is built in three layers, each independently deployable and testable:

```
Layer 1: Bulk Field Update (MUST)         ← Backend endpoint + Modal UI
Layer 2: Inline Grid Editing (MUST)       ← EditableCell + useGridEdit hook
Layer 3: CSV Import/Export (SHOULD)       ← Backend endpoints + Upload/Download UI
```

### 3.2 Backend Changes

**New Files:**

```
backend/services/bulk-update.js           — Core bulk update logic (field patching + dryRun)
backend/lib/csv-export.js                 — Product-to-CSV transformation
backend/lib/csv-import.js                 — CSV parsing + validation + field mapping
```

**Modified Files:**

```
backend/routes/products.js                — Add 3 new endpoints (PATCH bulk-update, GET export/csv, POST import/csv)
```

**New API Endpoints:**

| Method | Path | Description | Layer |
|--------|------|-------------|-------|
| PATCH | `/api/v1/products/bulk-update` | Bulk update fields on multiple products | 1 |
| GET | `/api/v1/products/export/csv` | Export products as CSV | 3 |
| POST | `/api/v1/products/import/csv` | Import CSV with bulk updates | 3 |

### 3.3 Frontend Changes

**New Files:**

```
components/admin-table/BulkUpdateModal.tsx     — Field selection + value input + diff preview
components/admin-table/EditableCell.tsx         — Wrapper: read-only or input based on edit mode
components/admin-table/BulkDiffPreview.tsx      — Preview table showing old→new per product
components/admin-table/CsvImportModal.tsx       — CSV upload + mapping + dry-run preview
hooks/useGridEdit.ts                            — Grid edit state: dirtyFields, toggle, commit/discard
hooks/useBulkUpdate.ts                          — API call logic for bulk-update endpoint (with dryRun)
```

**Modified Files:**

```
components/AdminTable.tsx                       — Add grid edit toggle, wire useGridEdit, enhance select-all
components/admin-table/BulkActions.tsx           — Add "Feld ändern" + "Edit Mode" + "CSV Export/Import" buttons
components/admin-table/AdminTableRow.tsx         — Wrap editable columns in EditableCell
components/admin-table/AdminTableHeader.tsx      — Add "Select all N filtered" action
api/client.ts                                   — Add bulkUpdateProducts(), exportProductsCsv(), importProductsCsv()
```

### 3.4 Data Model Changes

**No Firestore schema changes required.**

All writes go through `saveProductV2(mergedProduct, { mode: 'manual' })`. The bulk-update service reads the full product, merges the changed fields, and calls saveProductV2(). No new fields, no new collections, no schema migration.

---

## 4. UI/UX Specification

### 4.1 User Flow — Bulk Field Update (Layer 1)

```
1. User is on AdminTable with products loaded
2. User selects products via checkboxes (individual or "Select all 247 filtered")
3. BulkActions bar appears: "12 von 247 ausgewählt" + action buttons
4. User clicks "Feld ändern" button
5. BulkUpdateModal opens:
   a. Step 1: Select field (dropdown: Preis, Lager, Kategorie, Name, Status)
   b. Step 2: Enter new value (input type depends on field: number, text, select)
   c. Step 3: Click "Vorschau" → dryRun API call
   d. Step 4: BulkDiffPreview shows table: Product | Altwert | Neuwert | Status
   e. Step 5: User reviews, clicks "Änderungen übernehmen"
6. Loading state while backend processes
7. Success toast: "12 Produkte aktualisiert, 0 übersprungen"
8. AdminTable refreshes affected products
```

### 4.2 User Flow — Inline Grid Editing (Layer 2)

```
1. User clicks "Edit-Modus" toggle in BulkActions area (or toolbar)
2. AdminTable switches to grid edit mode:
   - Editable columns show light edit indicator (pencil icon or subtle border)
   - Non-editable columns remain read-only
3. User clicks a cell → cell becomes an input field
4. User changes value → cell is marked as "dirty" (accent border/highlight)
5. Tab key moves to next editable cell in the row
6. Enter key confirms cell and moves down
7. Escape key discards cell change
8. Dirty counter shows: "5 Änderungen"
9. User clicks "Speichern" → dryRun preview → commit
10. Or clicks "Verwerfen" → all dirty cells revert
```

### 4.3 Component Hierarchy

```
<AdminTable>
  ├── <AdminTableHeader>
  │   └── Select-All checkbox (enhanced: "Alle N gefilterten auswählen" link)
  ├── <AdminTableFilters />
  ├── <BulkActions>                          ← enhanced
  │   ├── Selection counter: "12 von 247"
  │   ├── [Feld ändern] button → opens BulkUpdateModal
  │   ├── [Edit-Modus] toggle
  │   ├── [CSV Export] button
  │   ├── [CSV Import] button → opens CsvImportModal
  │   ├── ... existing actions (KI Verbessern, Löschen, etc.)
  │   └── (in edit mode) [Speichern (5)] + [Verwerfen]
  ├── <AdminTableRow>                        ← per product
  │   ├── <checkbox />
  │   ├── <EditableCell field="name">        ← new wrapper
  │   ├── <EditableCell field="category">
  │   ├── <EditableCell field="price">
  │   ├── <EditableCell field="inventory">
  │   └── ... read-only columns
  ├── <BulkUpdateModal>                      ← new (Layer 1)
  │   ├── Field selector (dropdown)
  │   ├── Value input (dynamic type)
  │   └── <BulkDiffPreview />                ← new
  └── <CsvImportModal>                       ← new (Layer 3)
      ├── File upload zone
      ├── Column mapping UI
      └── <BulkDiffPreview />                ← reused
```

### 4.4 Layout & Design

**BulkActions Bar (enhanced):**
- Position: sticky top, below filters, above table rows
- Background: `bg-app-elevated`
- Border: `border-b border-app-border`
- Left: Selection counter (`text-txt-primary` bold count + `text-txt-secondary` " von N")
- Right: Action buttons using `bg-accent` for primary, outline for secondary

**EditableCell (grid edit mode):**
- Default: normal cell render (read-only)
- Edit mode enabled + cell focused: `border border-accent rounded-sm` + input field
- Dirty cell: `bg-accent-dim` subtle highlight to indicate unsaved change
- Error cell: `border-danger` + tooltip with validation message

**BulkUpdateModal:**
- Standard modal pattern (`bg-app-surface`, `rounded-lg`, backdrop)
- Step indicator at top (3 dots: Select → Value → Preview)
- Field dropdown: `bg-app-elevated` select
- Preview table: alternating row colors, old value `text-txt-muted line-through`, new value `text-accent font-semibold`

**BulkDiffPreview:**
- Reusable component (used in BulkUpdateModal AND CsvImportModal)
- Table columns: `Produkt | Feld | Aktuell | Neu | Status`
- Status badges: `bg-success-dim text-success` (OK), `bg-warning-dim text-warning` (Übersprungen), `bg-danger-dim text-danger` (Fehler)
- Max height with scroll, shows first 50 rows + "und N weitere..." summary

### 4.5 States & Edge Cases

| State | UI Behavior |
|-------|-------------|
| No selection | BulkActions bar hidden (existing behavior) |
| Selection active | Bar visible with counter + all action buttons |
| Grid edit mode + no dirty cells | "Speichern" button disabled, "Verwerfen" disabled |
| Grid edit mode + dirty cells | "Speichern (N)" shows count, "Verwerfen" enabled |
| DryRun loading | Spinner in modal, "Vorschau wird erstellt..." |
| DryRun shows errors | Error rows highlighted, commit button shows "N von M übernehmen" |
| Bulk update in progress | Progress bar, action buttons disabled |
| Bulk update partial failure | Toast: "10 aktualisiert, 2 Fehler" + error detail expandable |
| Empty selection + grid edit | Edit mode still works (user edits individual cells) |
| 500+ products selected | Confirm dialog: "Du bist dabei, 500 Produkte zu ändern. Fortfahren?" |
| CSV with unknown columns | CsvImportModal shows unmapped columns, user can map or skip |

### 4.6 Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| Desktop (≥1280px) | Full grid edit with all editable columns visible |
| Tablet (≥768px) | Grid edit with horizontal scroll, fewer default columns |
| Mobile (<768px) | Grid edit disabled, only bulk field update modal available |

---

## 5. Technical Implementation

### 5.1 Build Sequence

Each step is independently testable. Steps within a layer can be done sequentially.

```
=== LAYER 1: Bulk Field Update ===

Step 1: [Backend] Create services/bulk-update.js
        - Function: bulkUpdateProducts({ tenantId, productIds, updates, dryRun })
        - Reads each product via getProductV2()
        - Merges updates into product (deep field path support: "details.pricing.lowest_price.amount")
        - If dryRun: returns diff (oldValue, newValue) per product without writing
        - If !dryRun: calls saveProductV2(merged, { mode: 'manual' }) per product
        - Returns: { updated: N, skipped: N, errors: [{id, reason}], diff?: [...] }
        - Max 500 products per call (validation)
        Test: Unit test with mocked product-store

Step 2: [Backend] Add PATCH /api/v1/products/bulk-update to routes/products.js
        - Auth: requireAuth + permission 'products.write'
        - Input validation: productIds (array, max 500), updates (array of {field, value})
        - Calls bulkUpdateProducts()
        - Structured error response on failure
        Test: API integration test (happy path + validation + partial failure)

Step 3: [Frontend] Create hooks/useBulkUpdate.ts
        - Exposes: executeBulkUpdate({ productIds, updates, dryRun })
        - Returns: { loading, error, result, preview }
        - Handles dryRun mode and commit mode
        Test: Hook renders correctly, calls API client

Step 4: [Frontend] Add bulkUpdateProducts() to api/client.ts
        - PATCH /api/v1/products/bulk-update
        - Type-safe request/response
        Test: Build passes

Step 5: [Frontend] Create BulkDiffPreview.tsx
        - Props: diff array [{productId, productName, field, oldValue, newValue, status}]
        - Renders preview table with status badges
        - Reusable (used in Layer 1 modal AND Layer 3 import)
        Test: Component renders with mock data

Step 6: [Frontend] Create BulkUpdateModal.tsx
        - Step 1: Field selector (dropdown with editable field options)
        - Step 2: Value input (dynamic: NumberInput for price/inventory, Select for category/status, TextInput for name)
        - Step 3: DryRun trigger → BulkDiffPreview
        - Step 4: Commit button → executeBulkUpdate({ dryRun: false })
        Test: Component renders, field selection works, mock API integration

Step 7: [Frontend] Enhance BulkActions.tsx
        - Add "Feld ändern" button → opens BulkUpdateModal
        - Add selection counter: "N von M ausgewählt"
        Test: Button appears when selection > 0, modal opens

Step 8: [Frontend] Enhance AdminTableHeader.tsx — "Select all filtered"
        - When user checks "select all" on current page:
          show link "Alle N gefilterten Produkte auswählen"
        - Clicking it adds ALL filtered product IDs to selectedIds (not just current page)
        Test: Select all filtered adds correct IDs

=== LAYER 2: Inline Grid Editing ===

Step 9: [Frontend] Create hooks/useGridEdit.ts
        - State: isEditMode: boolean, dirtyFields: Map<string, Record<string, any>>
        - Functions: toggleEditMode(), setCellValue(productId, field, value),
          discardAll(), getDirtyCount(), getDirtyProducts()
        - Converts dirty map to bulk-update format for API call
        Test: Hook state management, dirty tracking, discard

Step 10: [Frontend] Create EditableCell.tsx
         - Props: productId, field, value, type ('text'|'number'|'select'), options?, isEditMode, onCellChange
         - Read mode: render value normally
         - Edit mode: render input, onBlur/onEnter → onCellChange
         - Dirty state: accent-dim background
         - Keyboard: Tab → next cell, Enter → confirm + move down, Escape → discard
         Test: Component switches modes, keyboard nav works

Step 11: [Frontend] Modify AdminTableRow.tsx
         - Wrap editable columns (name, category, price, inventory) in EditableCell
         - Pass isEditMode and onCellChange from useGridEdit
         - Non-editable columns unchanged
         Test: Editable cells appear in edit mode, non-editable stay read-only

Step 12: [Frontend] Wire grid edit into AdminTable.tsx
         - Initialize useGridEdit()
         - Pass isEditMode to AdminTableRow
         - Add "Edit-Modus" toggle to BulkActions (or toolbar)
         - Add "Speichern (N)" + "Verwerfen" buttons when dirtyCount > 0
         - Commit calls useBulkUpdate with dryRun preview first
         Test: End-to-end: toggle edit mode, change cells, preview, commit

=== LAYER 3: CSV Import/Export ===

Step 13: [Backend] Create lib/csv-export.js
         - Function: productsToCSV(products, columns)
         - Supports column selection (subset of all fields)
         - Handles nested field paths (e.g., details.pricing.lowest_price.amount → "price")
         - UTF-8 BOM for Excel compatibility
         Test: Unit test with sample products

Step 14: [Backend] Create lib/csv-import.js
         - Function: parseCSVForBulkUpdate(csvBuffer, columnMapping)
         - Validates required columns (id or sku for matching)
         - Returns array of { productId, updates: [{field, value}] }
         - Reports unmapped/unknown columns
         Test: Unit test with valid + malformed CSV

Step 15: [Backend] Add GET /api/v1/products/export/csv to routes/products.js
         - Query params: columns (comma-separated), productIds (optional), filters
         - Returns CSV file as download (Content-Disposition: attachment)
         - Auth: requireAuth + permission 'products.read'
         Test: API test, verify CSV output

Step 16: [Backend] Add POST /api/v1/products/import/csv to routes/products.js
         - Multipart file upload (CSV file)
         - Parses CSV → calls bulkUpdateProducts({ dryRun: true }) for preview
         - Returns diff preview (reuses Layer 1 logic)
         - Second call with dryRun: false to commit
         - Auth: requireAuth + permission 'products.write'
         Test: API test with sample CSV file

Step 17: [Frontend] Add CSV Export button to BulkActions.tsx
         - Triggers download via api client
         - Column selection dropdown (optional, defaults to visible columns)
         Test: Button triggers CSV download

Step 18: [Frontend] Create CsvImportModal.tsx
         - File drop zone / file picker
         - Column mapping preview (auto-map known columns, user maps unknown)
         - DryRun → BulkDiffPreview (reused component)
         - Commit button
         Test: File upload, mapping UI, preview renders
```

### 5.2 API Contracts

#### PATCH /api/v1/products/bulk-update

```javascript
// Request:
{
  "productIds": ["prod_abc123", "prod_def456"],   // max 500
  "updates": [
    { "field": "details.pricing.lowest_price.amount", "value": 29.99 },
    { "field": "identification.category", "value": "Elektronik > Smartphones" }
  ],
  "dryRun": true   // optional, default false
}

// Response (200, dryRun: true):
{
  "ok": true,
  "data": {
    "updated": 0,
    "skipped": 0,
    "errors": [],
    "diff": [
      {
        "productId": "prod_abc123",
        "productName": "Samsung Galaxy S24",
        "changes": [
          { "field": "details.pricing.lowest_price.amount", "oldValue": 39.99, "newValue": 29.99 }
        ],
        "status": "ready"
      },
      {
        "productId": "prod_def456",
        "productName": "iPhone 15 Pro",
        "changes": [
          { "field": "details.pricing.lowest_price.amount", "oldValue": 29.99, "newValue": 29.99 }
        ],
        "status": "skipped",
        "reason": "No change"
      }
    ]
  }
}

// Response (200, dryRun: false):
{
  "ok": true,
  "data": {
    "updated": 1,
    "skipped": 1,
    "errors": [],
    "duration_ms": 1240
  }
}

// Response (400):
{
  "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "productIds must contain 1-500 items" }
}

// Response (500):
{
  "ok": false,
  "error": { "code": "INTERNAL", "message": "Bulk update failed: [details]" }
}
```

#### GET /api/v1/products/export/csv

```javascript
// Request (query params):
// ?columns=name,brand,category,price,inventory,sku,ean
// &productIds=prod_abc123,prod_def456          (optional — if omitted, exports all filtered)
// &filterStatus=synced                          (optional — reuse existing filter params)

// Response: CSV file download
// Content-Type: text/csv; charset=utf-8
// Content-Disposition: attachment; filename="avycloud-products-2026-03-19.csv"
//
// BOM + header row + data rows
```

#### POST /api/v1/products/import/csv

```javascript
// Request: multipart/form-data
// Field: file (CSV file, max 10MB)
// Field: dryRun (boolean, default true)

// Response (200, dryRun: true):
{
  "ok": true,
  "data": {
    "parsed": 150,
    "matched": 142,
    "unmatched": 8,
    "diff": [ /* same format as bulk-update dryRun */ ],
    "unmappedColumns": ["custom_field_xyz"]
  }
}
```

### 5.3 Error Handling

| Error Scenario | HTTP Status | Error Code | User-Facing Message |
|---------------|-------------|------------|---------------------|
| No productIds provided | 400 | VALIDATION_ERROR | "Mindestens 1 Produkt auswählen" |
| productIds > 500 | 400 | VALIDATION_ERROR | "Maximal 500 Produkte pro Bulk-Update" |
| Invalid field path | 400 | VALIDATION_ERROR | "Unbekanntes Feld: {field}" |
| Product not found | 404 (in diff) | NOT_FOUND | Skipped in result, listed in errors array |
| saveProductV2 validation failure | 200 (partial) | — | Product listed in errors: "Validierung fehlgeschlagen: {reason}" |
| Firestore timeout | 502 | UPSTREAM_ERROR | "Datenbank-Timeout. Bitte erneut versuchen." |
| CSV parse error | 400 | CSV_PARSE_ERROR | "CSV konnte nicht gelesen werden: {detail}" |
| CSV missing ID column | 400 | CSV_MISSING_ID | "CSV muss eine 'id' oder 'sku' Spalte enthalten" |

### 5.4 Edge Cases

| # | Edge Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | User selects 0 products, clicks "Feld ändern" | Button disabled when selectedIds.size === 0 |
| 2 | DryRun shows all products would be skipped (no actual change) | "Keine Änderungen erkannt" message, commit button disabled |
| 3 | User sets price to negative number | Client-side validation: "Preis muss ≥ 0 sein" |
| 4 | User is in grid edit mode and navigates away | Confirm dialog: "Du hast N ungespeicherte Änderungen. Verwerfen?" |
| 5 | Two users bulk-edit same product simultaneously | Last-write-wins (saveProductV2 semantics). No optimistic locking needed for MVP. |
| 6 | CSV contains product ID not in database | Listed as "unmatched" in import preview, skipped on commit |
| 7 | CSV contains duplicate IDs | Last row wins (with warning in preview) |
| 8 | User toggles edit mode with dirty changes | Confirm: "Ungespeicherte Änderungen verwerfen?" |
| 9 | Grid edit: user changes price, then changes it back to original | Cell removed from dirtyFields (no-op change detection) |
| 10 | Bulk update during active marketplace sync | saveProductV2 handles this — sync_status may reset. Note in preview. |

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Test | File | Description |
|------|------|-------------|
| `should merge updates into product` | `services/bulk-update.test.js` | Verify field path merge (flat + nested) |
| `should return diff in dryRun mode` | `services/bulk-update.test.js` | DryRun returns changes without writing |
| `should skip products with no actual change` | `services/bulk-update.test.js` | Same value = skipped |
| `should reject invalid field paths` | `services/bulk-update.test.js` | Unknown field → error |
| `should call saveProductV2 with mode manual` | `services/bulk-update.test.js` | Verify { mode: 'manual' } is passed |
| `should limit to 500 products` | `services/bulk-update.test.js` | > 500 → validation error |
| `should handle partial failures` | `services/bulk-update.test.js` | 1 product fails, others succeed |
| `should export valid CSV with BOM` | `lib/csv-export.test.js` | Output matches expected CSV format |
| `should parse CSV with various delimiters` | `lib/csv-import.test.js` | Comma, semicolon, tab support |
| `should report unmapped columns` | `lib/csv-import.test.js` | Unknown columns listed in result |

### 6.2 Integration Tests

| Test | Endpoint | Description |
|------|----------|-------------|
| `should return 200 with valid bulk update` | `PATCH /api/v1/products/bulk-update` | Happy path: 3 products, 1 field |
| `should return diff on dryRun` | `PATCH /api/v1/products/bulk-update` | dryRun: true returns preview |
| `should return 400 for empty productIds` | `PATCH /api/v1/products/bulk-update` | Validation error |
| `should return 400 for > 500 productIds` | `PATCH /api/v1/products/bulk-update` | Limit validation |
| `should return 401 without auth` | `PATCH /api/v1/products/bulk-update` | Auth required |
| `should export CSV with selected columns` | `GET /api/v1/products/export/csv` | Column filtering works |
| `should import CSV and return dry-run diff` | `POST /api/v1/products/import/csv` | Parse + match + preview |

### 6.3 Manual Verification Checklist

```
□ Bulk field update works: select 5 products, change price, preview shows correct diff, commit succeeds
□ Grid edit mode: toggle on, change 3 cells across 2 rows, preview, commit
□ Grid edit keyboard nav: Tab moves right, Enter moves down, Escape discards
□ Select all filtered: check select-all, click "Alle N auswählen", verify count
□ CSV Export: export 50 products, open in Excel, verify all columns present
□ CSV Import: modify exported CSV, re-import, preview shows correct changes
□ Feature works in Dark Mode
□ Feature works in Light Mode
□ Feature works at 768px viewport (tablet)
□ No console errors in browser
□ Existing BulkActions (KI Verbessern, Löschen, etc.) still work
□ Product detail sheet still opens on click
□ API responses match contract
□ Error states display correctly (validation, partial failure, timeout)
```

---

## 7. References

### 7.1 Competitor Benchmarks

- **Linnworks**: Attribute-Export → CSV-artige Bulk-Korrektur (see `docs/competitive-analysis/sources/international.md`)
- **SellerCloud**: Grid-View mit 50 editierbaren Spalten, Inline-Speicherung (see `docs/competitive-analysis/sources/international.md`)
- **Zentail**: Smart-Bulk-Rules, kaskadierende Änderungen über alle Kanäle (see `docs/competitive-analysis/sources/ai-first-tools.md`)
- **UX Best Practice**: Persistent Action Bar pattern, selection counter, preview-before-commit (see `docs/competitive-analysis/market-overview.md`)

### 7.2 Related Features

| Feature ID | Relationship |
|------------|-------------|
| RULE-001 | Rule Engine builds on BULK-001 batch infrastructure (dependency) |
| PRICE-001 | Pricing Engine UI can reuse BulkUpdateModal for price rule application |
| VAR-001 | Variant model needs variant-aware grid editing (future enhancement) |
| AI-001 | AI pipeline batch processing uses BULK-001 select-all pattern |
| ERR-001 | Error dashboard may link to bulk-fix actions using BULK-001 endpoints |

### 7.3 Source Documents

- `docs/competitive-analysis/market-overview.md` — Feature gap analysis
- `docs/competitive-analysis/swot.md` — W1 (Score 25, highest priority weakness)
- `docs/product-strategy/roadmap.md` — Phase 1 keystone, dependency for RULE-001 and AI-001
- `AvyCloud_Marktanalyse_MultiChannel.docx` — Original Marktanalyse (Section 4.1, 5.1)

### 7.4 Codebase References

| File | Relevance |
|------|-----------|
| `components/AdminTable.tsx` | Main table component (~2,340 lines) — Layer 2 modifies this |
| `components/admin-table/BulkActions.tsx` | Existing bulk actions — enhanced in Layer 1 |
| `components/admin-table/AdminTableRow.tsx` | Row rendering — wrapped with EditableCell in Layer 2 |
| `components/admin-table/AdminTableHeader.tsx` | Select-all — enhanced for "select all filtered" |
| `components/admin-table/types.ts` | Column definitions — EditableCell maps to ColumnId |
| `backend/routes/products.js` | Product routes (~2,341 lines) — 3 new endpoints added |
| `backend/lib/product-store.js` | Abstraction layer — `saveProductV2({ mode: 'manual' })` |
| `backend/lib/product-canonical.js` | `normalizeProduct()` — called by saveProductV2 |
| `api/client.ts` | API client — 3 new functions added |
| `hooks/useGridEdit.ts` | New hook — grid edit state management |
| `hooks/useBulkUpdate.ts` | New hook — bulk update API integration |
| `types.ts` | Product type — field paths reference this |

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-19 | 0.1 | Initial draft — problem statement, requirements, benchmarks |
| 2026-03-19 | 1.0 | Complete spec — architecture, UI/UX, technical design, testing strategy |
