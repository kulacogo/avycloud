# AI-001: AI Listing Pipeline

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | AI-001 |
| **Title** | AI Listing Pipeline |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L2 |
| **Effort** | L |
| **Source** | competitive-analysis |
| **Dependencies** | Benefits from VAL-001 (validation) and IMG-001 (image enhancement) |
| **Protected Zones** | backend/routes/products.js (Yellow), App.tsx routing (Yellow), api/client.ts (Yellow) |
| **TASKS.md Module** | M13 (Erfassen / KI-Stepper-Flow) |

---

## Problem Statement

AvyCloud has powerful AI capabilities (Gemini product recognition, enrichment, quality scoring, chat) but they exist as separate, disconnected features. No competitor in the DACH market offers a unified flow: photo -> identify product -> enrich data -> optimize per channel -> validate -> publish. AI-first tools like Nifty AI offer 30-second photo-to-listing, but only for US reseller platforms. This is AvyCloud's opportunity to build the killer feature that no one else has.

---

## User Story

As a seller, I want to take a photo of a product and have AvyCloud automatically identify it, fill in all product data, optimize the listing for each marketplace, and publish it -- all in one streamlined flow.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Support photo upload as the starting point |
| FR-2 | MUST | Auto-identify product via Gemini (EAN, MPN, brand, specs) |
| FR-3 | MUST | Auto-enrich with web data (competitors, market prices, descriptions) |
| FR-4 | MUST | Generate marketplace-optimized titles and descriptions per channel |
| FR-5 | MUST | Auto-map to marketplace categories (eBay category, Kaufland category) |
| FR-6 | SHOULD | Suggest pricing based on competitor analysis |
| FR-7 | SHOULD | Validate listing against marketplace requirements before publish |
| FR-8 | SHOULD | Support barcode/EAN scanning as alternative entry point |
| FR-9 | MAY | Support batch processing (multiple photos -> multiple listings) |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Nifty AI** | 30-second photo-to-listing | US platforms only, shallow identification |
| **Underpriced AI** | Photo recognition + real sold-price valuation | eBay only |
| **Zentail SMART Types** | ML-based category mapping that self-updates | Category mapping only, no full pipeline |
| **CedCommerce UniCon** | Agentic AI operations via natural language | No photo-to-listing flow |
| **3Dsellers** | Bulk AI optimization of existing eBay listings | Optimization only, no identification |

---

## 3. Architecture

### 3.1 Backend Changes

The pipeline orchestrator is a NEW service that calls EXISTING services in sequence. No existing services are modified.

**New Files:**
```
backend/services/listing-pipeline.js  — Orchestrates the full identify -> enrich -> optimize -> validate flow
```

**Modified Files (Yellow Zone, additive only):**
```
backend/routes/products.js            — Add 1 new route: POST /api/products/listing-pipeline
```

**New API Endpoints:**

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| POST | `/api/products/listing-pipeline` | Run the full AI listing pipeline for a product | `{ productId, channels: ["ebay","kaufland"] }` | `{ ok: true, data: { productId, listings: { ebay: {...}, kaufland: {...} }, generated_at } }` |

### 3.2 Frontend Changes

The frontend extends the existing CaptureView stepper with a new "Channel Optimization" step that shows per-marketplace listing previews.

**New Files:**
```
components/capture/StepChannels.tsx    — Channel selection + per-marketplace listing preview/edit
hooks/useListingPipeline.ts            — Hook wrapping the listing-pipeline API call
```

**Modified Files (Yellow Zone, additive only):**
```
components/capture/CaptureView.tsx     — Add new "Channels" step between Pricing and Summary
api/client.ts                          — Add runListingPipeline() function
```

### 3.3 Data Model Changes

**Collection:** `products_v2` (additive fields only)

| Field | Type | Required | Description | New/Existing |
|-------|------|----------|-------------|-------------|
| `tenantId` | string | Yes | Tenant identifier | Existing |
| `marketplace_listings` | object | No | Per-channel optimized listing data | **New** |
| `marketplace_listings.ebay` | object | No | eBay-optimized title, description, category, aspects | **New** |
| `marketplace_listings.kaufland` | object | No | Kaufland-optimized title, description, category, attributes | **New** |
| `marketplace_listings.generated_at` | string | No | ISO-8601 timestamp when listings were generated | **New** |

Each channel listing object has the shape:
```json
{
  "title": "string (max 80 chars for eBay)",
  "description": "string (HTML for eBay, plain for Kaufland)",
  "categoryId": "string",
  "categoryName": "string",
  "attributes": { "key": "value" },
  "validation": { "ready": true, "issues": [] }
}
```

### 3.4 System Flow Diagram

```
Photo Upload
     |
     v
[Existing] identifyProductV2() — Gemini Vision + barcode + web enrichment
     |
     v
[Existing] saveProductV2() — Save identified product
     |
     v
[NEW] listingPipeline.generateChannelListings()
     |
     +---> [Existing] applyEbayTaxonomy() — category mapping
     +---> [Existing] applyKauflandTaxonomy() — category mapping
     +---> [NEW] generateOptimizedListing() — per-channel title/desc via Gemini
     |
     v
[NEW] listingPipeline.validateListings()
     |
     +---> eBay: title length, required aspects, category presence
     +---> Kaufland: required attributes, EAN presence
     |
     v
Frontend: StepChannels — user reviews/edits per-channel listings
     |
     v
[Existing] saveProductV2() — persist marketplace_listings
     |
     v
[Optional] publishToEbay() / publishToKaufland() — existing publish routes
```

---

## 4. UI/UX Specification

### 4.1 User Flow

```
1. User navigates to "Produkt erfassen" (CaptureView)
2. Step 1 (Upload): User uploads photos and/or enters barcode — EXISTING
3. Step 2 (Analysis): AI identifies product via Gemini Vision — EXISTING
4. Step 3 (Review): User reviews/edits identified data — EXISTING
5. Step 4 (Pricing): User sets sell/buy price, quantity, bin — EXISTING
6. Step 5 (Channels): NEW — User sees per-channel optimized listings
   6a. System auto-generates eBay + Kaufland titles/descriptions
   6b. User can toggle channels on/off
   6c. User can edit per-channel title and description
   6d. Validation badges show readiness per channel
7. Step 6 (Summary): User reviews final summary + saves — EXISTING (extended)
   7a. Summary now includes channel listing previews
   7b. "Save & Publish" button publishes to selected channels
```

### 4.2 Component Hierarchy

```
<CaptureView>
  +-- <Stepper steps={6} />
  +-- <StepUpload />           — existing
  +-- <StepAnalysis />         — existing
  +-- <StepReview />           — existing
  +-- <StepPricing />          — existing
  +-- <StepChannels />         — NEW
  |   +-- <ChannelCard channel="ebay">
  |   |   +-- <Badge variant="success|warning|danger" />
  |   |   +-- <Input label="eBay Titel" />
  |   |   +-- <textarea label="eBay Beschreibung" />
  |   |   +-- <span>Kategorie: {categoryName}</span>
  |   +-- <ChannelCard channel="kaufland">
  |       +-- <Badge variant="success|warning|danger" />
  |       +-- <Input label="Kaufland Titel" />
  |       +-- <textarea label="Kaufland Beschreibung" />
  |       +-- <span>Kategorie: {categoryName}</span>
  +-- <StepSummary />          — existing (extended with channel info)
```

### 4.3 Layout & Design

**StepChannels Layout:**
- Full width within max-w-4xl container (matches existing steps)
- Two channel cards stacked vertically
- Each card: `bg-app-surface border border-app-border rounded-md p-4`
- Channel header with marketplace name + toggle switch + validation badge
- Title input: standard `Input` component
- Description: `textarea` with `bg-app-elevated border-app-border rounded-sm`
- Category display: read-only text with `text-txt-secondary`
- Validation issues: inline list with `text-warning` or `text-danger`

**Design Token Usage:**
- Background: `bg-app-surface`
- Text: `text-txt-primary`, `text-txt-secondary`
- Accent: `bg-accent`, `text-accent`
- Borders: `border-app-border`
- Radius: `rounded-md` (cards), `rounded-sm` (inputs)
- Status: `text-success` (ready), `text-warning` (issues), `text-danger` (blocked)

### 4.4 States & Edge Cases

| State | UI Behavior |
|-------|-------------|
| Generating listings | Spinner + "KI optimiert Listings..." message inside each channel card |
| Generation failed | Error message with retry button, user can still proceed with manual data |
| No channels connected | Info message: "Verbinde eBay oder Kaufland in den Einstellungen" |
| Validation warnings | Yellow badge + expandable issue list |
| Validation errors (blocking) | Red badge + publish button disabled for that channel |
| Channel toggled off | Card grayed out, not included in save |

### 4.5 Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| Desktop (>=1280px) | Two channel cards side by side |
| Tablet (>=768px) | Channel cards stacked vertically |
| Mobile (<768px) | Channel cards stacked, compact layout |

### 4.6 Internationalization

All new UI strings added to `i18n.tsx` with DE/EN/TR translations. Key strings:
- "Marktplatz-Optimierung" / "Channel Optimization" / "Pazar Yeri Optimizasyonu"
- "KI optimiert Listings..." / "AI optimizing listings..." / "Yapay zeka listeleri optimize ediyor..."
- "Bereit zum Veröffentlichen" / "Ready to publish" / "Yayinlamaya hazir"

---

## 5. Technical Implementation

### 5.1 Build Sequence

```
Step 1: [Backend] Create backend/services/listing-pipeline.js
        — generateChannelListings() orchestrates Gemini call for per-channel optimization
        — validateListings() checks marketplace requirements
        Test: Unit test for listing generation and validation logic

Step 2: [Backend] Add POST /api/products/listing-pipeline route in products.js
        — Calls listing-pipeline service, returns optimized listings
        Test: Verify route returns expected shape

Step 3: [Frontend] Add runListingPipeline() to api/client.ts
        Test: Build passes

Step 4: [Frontend] Create hooks/useListingPipeline.ts
        — Wraps API call with loading/error state
        Test: Build passes

Step 5: [Frontend] Create components/capture/StepChannels.tsx
        — Channel cards with editable title/description per marketplace
        Test: Build passes

Step 6: [Frontend] Extend CaptureView.tsx with new Channels step
        — Insert between Pricing and Summary in stepper
        Test: Full stepper flow works, build passes

Step 7: [Testing] Run full test suite + frontend build
        Test: cd backend && npx vitest run && cd .. && npx vite build
```

### 5.2 API Contracts

```javascript
// POST /api/products/listing-pipeline
// Request:
{
  "productId": "string (required)",
  "channels": ["ebay", "kaufland"]  // optional, defaults to all
}

// Response (200):
{
  "ok": true,
  "data": {
    "productId": "abc123",
    "listings": {
      "ebay": {
        "title": "Apple iPhone 14 Pro 128GB Space Black - Sehr Gut - OVP",
        "description": "<p>Apple iPhone 14 Pro in Space Black...</p>",
        "categoryId": "9355",
        "categoryName": "Handys & Smartphones",
        "attributes": {
          "Marke": "Apple",
          "Modell": "iPhone 14 Pro",
          "Speicherkapazitaet": "128 GB"
        },
        "validation": {
          "ready": true,
          "issues": []
        }
      },
      "kaufland": {
        "title": "Apple iPhone 14 Pro 128GB Space Black Sehr Gut",
        "description": "Apple iPhone 14 Pro in Space Black...",
        "categoryId": "54321",
        "categoryName": "Smartphones",
        "attributes": {
          "brand": "Apple",
          "ean": "1234567890123"
        },
        "validation": {
          "ready": true,
          "issues": []
        }
      }
    },
    "generated_at": "2026-03-19T12:00:00.000Z"
  }
}

// Response (400):
{
  "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Missing productId" }
}

// Response (404):
{
  "ok": false,
  "error": { "code": "NOT_FOUND", "message": "Product not found" }
}

// Response (500):
{
  "ok": false,
  "error": { "code": "INTERNAL", "message": "Pipeline generation failed" }
}
```

### 5.3 Error Handling

| Error Scenario | HTTP Status | Error Code | User-Facing Message |
|---------------|-------------|------------|-------------------|
| Missing productId | 400 | VALIDATION_ERROR | "productId ist erforderlich" |
| Product not found | 404 | NOT_FOUND | "Produkt nicht gefunden" |
| Gemini API failure | 502 | UPSTREAM_ERROR | "KI-Service nicht erreichbar. Bitte erneut versuchen." |
| Category mapping failure | 200 (partial) | — | Listing returned without category, validation.ready=false |
| Internal error | 500 | INTERNAL | "Interner Fehler bei der Listing-Generierung" |

### 5.4 Edge Cases

| # | Edge Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | Product has no images | Pipeline still runs using text data only |
| 2 | Product has no EAN | Kaufland validation.ready=false (EAN required) |
| 3 | Title exceeds 80 chars for eBay | Auto-truncated by title-policy, validation warning |
| 4 | Gemini returns empty response | Fallback to product's existing title/description |
| 5 | Category not found | validation.ready=false, user can manually select |
| 6 | Network timeout | 30s timeout, returns error for affected channel |

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Test | File | Description |
|------|------|-------------|
| `should generate ebay listing from product data` | `listing-pipeline.test.js` | Verifies eBay title/description generation |
| `should generate kaufland listing from product data` | `listing-pipeline.test.js` | Verifies Kaufland title/description generation |
| `should validate eBay listing requirements` | `listing-pipeline.test.js` | Title length, category, required aspects |
| `should validate Kaufland listing requirements` | `listing-pipeline.test.js` | EAN presence, required attributes |
| `should handle missing product gracefully` | `listing-pipeline.test.js` | Returns appropriate error |
| `should fallback when Gemini fails` | `listing-pipeline.test.js` | Uses existing product data as fallback |

### 6.2 Integration Tests

| Test | Endpoint | Description |
|------|----------|-------------|
| `should return 200 with valid product` | `POST /api/products/listing-pipeline` | Happy path with full pipeline |
| `should return 400 for missing productId` | `POST /api/products/listing-pipeline` | Input validation |
| `should return 404 for non-existent product` | `POST /api/products/listing-pipeline` | Product lookup failure |

### 6.3 Manual Verification Checklist

```
[ ] Full stepper flow works: Upload -> Analysis -> Review -> Pricing -> Channels -> Summary
[ ] Channel step shows eBay and Kaufland cards
[ ] Titles and descriptions are pre-filled by AI
[ ] User can edit per-channel title and description
[ ] Validation badges show correct status
[ ] Channel toggle works (on/off)
[ ] Save persists marketplace_listings to product
[ ] Feature works in Dark Mode
[ ] Feature works in Light Mode
[ ] Feature works at 768px viewport
[ ] No console errors in browser
```

---

## 7. References

### 7.1 Existing Services Used

| Service | How Used |
|---------|----------|
| `services/enrichment.js` | `applyEbayTaxonomy()`, `applyKauflandTaxonomy()` for category mapping |
| `services/improve.js` | Pattern reference for Gemini-based text generation |
| `lib/gemini-structured.js` | Structured Gemini output for listing generation |
| `lib/title-policy.js` | `coerceTitleToPolicy()` for eBay title constraints |
| `lib/listing-sanitize.js` | `sanitizeDescriptionToHtml()` for eBay HTML |
| `lib/product-store.js` | `saveProductV2()` for persisting listings |
| `lib/ebay-direct.js` | `publishProduct()` for eBay publish |
| `lib/kaufland-api.js` | `createUnit()` for Kaufland publish |

### 7.2 Related Features

| Feature ID | Relationship |
|------------|-------------|
| VAL-001 | Validation rules could extend listing validation |
| IMG-001 | Enhanced images would improve listing quality |

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-19 | 0.1 | Initial draft — problem statement, requirements, competitive benchmarks |
| 2026-03-19 | 1.0 | Complete spec — architecture, UI, technical design, testing strategy |
