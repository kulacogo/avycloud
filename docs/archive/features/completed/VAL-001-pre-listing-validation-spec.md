# VAL-001: Pre-Listing Validation

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | VAL-001 |
| **Title** | Pre-Listing Validation |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L1 |
| **Effort** | M |
| **Source** | marktanalyse (S4.5) |
| **Dependencies** | None, but enhances AI-001 (AI Listing Pipeline) |
| **Protected Zones** | backend/routes/products.js (Yellow — adding new endpoint only) |
| **TASKS.md Module** | M5 (Marktplatz-Views) — pre-publish quality gate |

---

## Problem Statement

AvyCloud has LLM-Rulebook and Schema validation, but only for LLM output. There is no pre-listing validation against marketplace-specific requirements. Channable and Rithum validate product data against marketplace schemas before submission and show errors with correction suggestions. Without this, sellers discover listing errors only after failed submissions.

---

## User Story

As a seller, I want AvyCloud to check my product data against each marketplace's requirements before I try to publish, so that I can fix issues proactively instead of dealing with failed listings.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Validate product data against eBay listing requirements (required item specifics, category rules, image requirements) |
| FR-2 | MUST | Validate against Kaufland listing requirements (mandatory attributes, category mapping) |
| FR-3 | MUST | Show validation results with specific error messages and correction suggestions |
| FR-4 | MUST | Distinguish between errors (blocking) and warnings (non-blocking) |
| FR-5 | SHOULD | Provide auto-fix suggestions for common issues (missing EAN, wrong category, incomplete title) |
| FR-6 | SHOULD | Integrate with AI-001 pipeline (validate before publish step) |
| FR-7 | MAY | Support batch validation for multiple products at once |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Channable** | Quality Checks per channel, automatic error flagging, rule-based corrections | AvyCloud has no channel-specific validation |
| **Rithum** | Pre-submission validation against Amazon/eBay schemas, error dashboard with drilldown | AvyCloud validates LLM output only, not listing data |
| **Linnworks** | Listing error export for bulk fix, attribute validation per channel | AvyCloud has no bulk error handling |

---

## 3. Architecture

### 3.1 Backend Changes

**New Files:**
```
backend/services/listing-validator.js  — Core validation engine with per-marketplace profiles
```

**Modified Files:**
```
backend/routes/products.js             — Add endpoints: POST /api/v1/products/validate, POST /api/v1/products/validate-batch
```

**New API Endpoints:**

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| POST | `/api/v1/products/validate` | Validate a single product against marketplace rules | `{ product, marketplaces: ['ebay', 'kaufland'] }` | `{ ok: true, results: { ebay: {...}, kaufland: {...} } }` |
| POST | `/api/v1/products/validate-batch` | Validate multiple products | `{ productIds: [...], marketplaces: [...] }` | `{ ok: true, results: [...] }` |

### 3.2 Frontend Changes

**New Files:**
```
components/ValidationPanel.tsx         — Validation result display (errors, warnings, score)
hooks/useValidation.ts                 — Hook for calling validation API + state management
```

**Modified Files:**
```
components/ProductSheet.tsx            — Embed ValidationPanel in the "Marktplaetze" tab
api/client.ts                          — Add validateProduct(), validateProductBatch() functions
i18n.tsx                               — Add validation-related translation keys (additive only)
```

### 3.3 Data Model Changes

No Firestore schema changes required. Validation is computed on-demand and returned as API response only. No new collections, no field changes.

### 3.4 Dependency on Existing Modules

The validation engine leverages these existing modules (read-only, no modifications):
- `lib/ebay-taxonomy.js` — `getRequiredAspects()`, `isKnownEbayCategoryId()`, `getCategoryAspectCatalog()`
- `lib/ebay-category-governance.js` — `isBannedEbayBreadcrumb()`
- `lib/datasheet-quality.js` — `evaluateEbayReady()` (reused for eBay base checks)
- `lib/ebay-ready-issues.js` — `buildEbayReadyIssuesDetailed()`, `countSeverities()`
- `lib/product-canonical.js` — `validateCanonical()`

---

## 4. UI/UX Specification

### 4.1 User Flow

```
1. User opens a product in ProductSheet
2. User navigates to the "Marktplaetze" tab
3. ValidationPanel is visible at the top of the tab
4. User clicks "Validierung starten" button (or validation runs automatically on tab open)
5. System calls POST /api/v1/products/validate with the current product data
6. ValidationPanel displays results per marketplace:
   - Score badge (e.g. "eBay: 85%", "Kaufland: 92%")
   - List of errors (red, blocking) — must fix before publish
   - List of warnings (yellow, non-blocking) — recommended to fix
   - List of info items (blue) — best-practice suggestions
7. Each issue shows: message, affected field, fix suggestion
8. User fixes issues in other tabs, returns to see updated score
```

### 4.2 Component Hierarchy

```
<ProductSheet>
  └── <TabPanel tabId="marktplaetze">
      ├── <ValidationPanel>                    (NEW)
      │   ├── <ValidationHeader />             (score badges + run button)
      │   ├── <ValidationMarketplace>          (per-marketplace result)
      │   │   ├── <ValidationIssue />          (individual issue row)
      │   │   └── <ValidationIssue />
      │   └── <ValidationMarketplace>
      └── ... (existing marketplace content)
```

### 4.3 Layout & Design

**ValidationPanel** sits at the top of the Marktplaetze tab. It uses a card layout with:
- Background: `bg-app-surface`
- Border: `border border-app-border rounded-2xl`
- Header row: marketplace logo/name + score badge + "Validate" button
- Issue list: grouped by severity

**Score Badge:**
- 90-100%: `bg-success-dim text-success` — "Bereit"
- 70-89%: `bg-warning-dim text-warning` — "Eingeschraenkt"
- 0-69%: `bg-danger-dim text-danger` — "Nicht bereit"

**Issue Row:**
- Error: left border `border-l-4 border-danger`, icon in `text-danger`
- Warning: left border `border-l-4 border-warning`, icon in `text-warning`
- Info: left border `border-l-4 border-info`, icon in `text-info`
- Text: `text-txt-primary` for message, `text-txt-secondary` for field path + suggestion

### 4.4 States & Edge Cases

| State | UI Behavior |
|-------|-------------|
| Loading | Spinner inside ValidationPanel header |
| No validation run yet | "Validierung starten" button, muted text |
| All checks pass | Green score badge, empty issue list, success message |
| Errors found | Red score badge, error issues listed first |
| API error | Inline error message with retry button |
| Product has no categoryId | Warning that category is required for marketplace validation |

### 4.5 Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| Desktop (>=1280px) | Full layout, side-by-side marketplace sections |
| Tablet (>=768px) | Stacked marketplace sections |
| Mobile (<768px) | Compact list, collapsible marketplace sections |

---

## 5. Technical Implementation

### 5.1 Build Sequence

```
Step 1: [Backend] Create backend/services/listing-validator.js
        — Validation engine with validateForMarketplace() and validateBatch()
        — eBay profile: title (<=80 chars), images (>=1), category (valid leaf),
          required aspects, description, EAN/identifiers, price, GPSR
        — Kaufland profile: title, images, EAN, category, mandatory attributes
        — Returns structured result: { marketplace, score, errors[], warnings[], info[] }
        Test: Unit test listing-validator.test.js

Step 2: [Backend] Add API endpoints in backend/routes/products.js
        — POST /api/v1/products/validate (single product)
        — POST /api/v1/products/validate-batch (multiple product IDs)
        Test: Existing test suite still passes

Step 3: [Frontend] Add validateProduct() to api/client.ts
        Test: Frontend build passes

Step 4: [Frontend] Create hooks/useValidation.ts
        — Manages validation state (loading, results, error)
        — Exposes runValidation(product, marketplaces) function
        Test: Frontend build passes

Step 5: [Frontend] Create components/ValidationPanel.tsx
        — Renders validation results per marketplace
        — Score badges, issue lists with severity icons
        Test: Frontend build passes

Step 6: [Frontend] Integrate ValidationPanel into ProductSheet.tsx Marktplaetze tab
        Test: Frontend build passes, full flow works

Step 7: [Frontend] Add i18n keys for validation strings
        Test: Frontend build passes
```

### 5.2 API Contracts

```javascript
// POST /api/v1/products/validate
// Request:
{
  "product": { /* full product object */ },
  "marketplaces": ["ebay", "kaufland"]  // optional, defaults to ["ebay", "kaufland"]
}

// Response (200):
{
  "ok": true,
  "results": {
    "ebay": {
      "marketplace": "ebay",
      "score": 85,
      "ready": false,
      "errors": [
        {
          "code": "missing_required_aspects",
          "severity": "error",
          "message": "Pflicht-Artikelmerkmale fehlen: Marke, Herstellernummer",
          "fields": ["details.attributes"],
          "suggestion": "Ergaenzen Sie die fehlenden Artikelmerkmale: Marke, Herstellernummer"
        }
      ],
      "warnings": [
        {
          "code": "title_short",
          "severity": "warning",
          "message": "Titel nutzt nur 45 von 80 Zeichen",
          "fields": ["identification.name"],
          "suggestion": "Ergaenzen Sie relevante Suchbegriffe (Marke, Modell, Groesse, Farbe)"
        }
      ],
      "info": [
        {
          "code": "few_images",
          "severity": "info",
          "message": "Nur 2 Bilder. eBay erlaubt bis zu 24.",
          "fields": ["details.images"],
          "suggestion": "Mehr Bilder aus verschiedenen Perspektiven erhoehen die Conversion"
        }
      ],
      "counts": { "errors": 1, "warnings": 1, "info": 1 }
    },
    "kaufland": {
      "marketplace": "kaufland",
      "score": 92,
      "ready": true,
      "errors": [],
      "warnings": [],
      "info": [],
      "counts": { "errors": 0, "warnings": 0, "info": 0 }
    }
  }
}

// Response (400):
{
  "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Product data is required" }
}

// Response (500):
{
  "ok": false,
  "error": { "code": "INTERNAL", "message": "..." }
}
```

```javascript
// POST /api/v1/products/validate-batch
// Request:
{
  "productIds": ["id1", "id2", "id3"],
  "marketplaces": ["ebay", "kaufland"]
}

// Response (200):
{
  "ok": true,
  "results": [
    { "productId": "id1", "productName": "...", "ebay": { "score": 85, "ready": false, "counts": {...} }, "kaufland": { "score": 92, "ready": true, "counts": {...} } },
    { "productId": "id2", "productName": "...", "ebay": { "score": 100, "ready": true, "counts": {...} }, "kaufland": { "score": 100, "ready": true, "counts": {...} } }
  ],
  "summary": { "total": 3, "ebay_ready": 1, "kaufland_ready": 2 }
}
```

### 5.3 Error Handling

| Error Scenario | HTTP Status | Error Code | User-Facing Message |
|---------------|-------------|------------|-------------------|
| Missing product in request body | 400 | VALIDATION_ERROR | Product data is required |
| Invalid marketplace name | 400 | VALIDATION_ERROR | Unknown marketplace: {name} |
| Product not found (batch) | 404 | NOT_FOUND | Product {id} not found |
| Batch too large (>100) | 400 | VALIDATION_ERROR | Batch size exceeds limit of 100 |
| Internal error | 500 | INTERNAL | Validation failed |

### 5.4 Edge Cases

| # | Edge Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | Product has no categoryId | Return error: "Kategorie fehlt" + score 0 for eBay |
| 2 | Product has no images at all | Return error for both marketplaces |
| 3 | Product has empty attributes object | Return errors for missing required aspects |
| 4 | CategoryId not in eBay taxonomy | Return error: "Kategorie-ID unbekannt" |
| 5 | Banned eBay category | Return error: "Kategorie ist gesperrt" |
| 6 | Very long title (>80 chars) | Return error for eBay, warning for Kaufland |
| 7 | Product has all required data | Return score 100%, ready=true |
| 8 | Batch with mix of valid/invalid products | Return individual results for each |
| 9 | EAN present but invalid format | Return warning about invalid EAN |

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Test | File | Description |
|------|------|-------------|
| `should return errors for product missing title` | `listing-validator.test.js` | Verifies title_missing error |
| `should return errors for product missing images` | `listing-validator.test.js` | Verifies images_missing error |
| `should return errors for missing required aspects` | `listing-validator.test.js` | Verifies missing_required_aspects error |
| `should return score 100 for fully valid product` | `listing-validator.test.js` | Happy path — all checks pass |
| `should reject banned eBay category` | `listing-validator.test.js` | Verifies banned category detection |
| `should validate Kaufland requirements separately` | `listing-validator.test.js` | Kaufland profile differs from eBay |
| `should handle product with no categoryId` | `listing-validator.test.js` | Edge case — missing category |
| `should flag invalid EAN format` | `listing-validator.test.js` | EAN validation |

### 6.2 Integration Tests

| Test | Endpoint | Description |
|------|----------|-------------|
| `should return 200 with validation results` | `POST /api/v1/products/validate` | Happy path |
| `should return 400 for missing product body` | `POST /api/v1/products/validate` | Input validation |

### 6.3 Manual Verification Checklist

```
[] Feature works in Dark Mode
[] Feature works in Light Mode
[] ValidationPanel renders in Marktplaetze tab
[] Score badges show correct colors (green/yellow/red)
[] Error/warning/info issues display with correct styling
[] Clicking "Validierung starten" triggers API call
[] Results update after fixing issues and re-validating
[] No console errors in browser
[] API responses match contract
```

---

## 7. References

### 7.1 Competitor Benchmarks

See Competitive Benchmarks section above.

### 7.2 Related Features

| Feature ID | Relationship |
|------------|-------------|
| AI-001 | VAL-001 validation runs before AI-001 publish step |

### 7.3 Source Documents

- `docs/guidelines/ebay-de-listing-requirements.md` — eBay DE specific rules
- `backend/lib/ebay-ready-issues.js` — Existing eBay issue code definitions
- `backend/lib/datasheet-quality.js` — Existing evaluateEbayReady() logic

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-19 | 0.1 | Initial draft — Problem, Requirements, Benchmarks |
| 2026-03-19 | 1.0 | Complete spec — Architecture, UI, Technical Design, Testing |
