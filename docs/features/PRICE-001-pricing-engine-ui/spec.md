# PRICE-001: Pricing Engine UI

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | PRICE-001 |
| **Title** | Pricing Engine UI |
| **Priority** | P0 |
| **Status** | Ready |
| **Change Level** | L1 |
| **Effort** | S (1–2 weeks) |
| **Source** | marktanalyse + SWOT W4 (Score 20) |
| **Dependencies** | None (backend exists: `services/pricing-engine.js`, `lib/competitor-prices.js`) |
| **Protected Zones** | None (new frontend pages, existing backend endpoints) |
| **TASKS.md Module** | Pricing Engine UI (standalone), M-AUTO (Automatisierung) |

---

## 1. Problem Statement

AvyCloud has a **fully functional pricing engine backend** with a 3-tier repricing algorithm (EAN match → category similarity → cost-plus fallback), a `pricingRules` Firestore collection, competitor price fetching (eBay + Kaufland), and batch repricing. But there is **no UI** for any of it. Sellers cannot see pricing suggestions, create repricing rules, or trigger repricing runs.

The backend code is ready. Four API endpoints already exist and work:
- `POST /api/v1/pricing/suggest/:productId` — calculate optimal price
- `POST /api/v1/pricing/rules` — create/update rule
- `GET /api/v1/pricing/rules` — list rules
- `POST /api/v1/pricing/reprice-batch` — batch repricing

Competitors charge $85–750/mo just for repricing (Repricer.com, Rithum Velocity Repricer). This is pure unrealized value — the engine works, it just needs a face.

### User Story

```
As a multichannel seller,
I want to see pricing suggestions, manage repricing rules, and trigger repricing runs through the UI,
so that I can optimize my margins without needing backend access.
```

### Current State

- `services/pricing-engine.js` — 3-tier pricing algorithm, fully implemented
- `services/pricing-runner.js` — exists but **disabled by default**
- `services/competitor-refresh-runner.js` — exists, disabled, 72h cycle
- `lib/competitor-prices.js` — eBay Browse API + Kaufland API lookup with 2h cache
- `pricingRules` collection — schema defined, CRUD works via API
- `priceHistory` collection — competitor price trends logged
- `components/CompetitorPrices.tsx` — displays competitor listings (already works)
- `components/CompetitorPriceChart.tsx` — price trend chart (exists but **unused in UI**)
- `components/capture/StepPricing.tsx` — shows `suggestedPrice` **only** in capture flow
- `components/orders/OrderSettingsView.tsx` — has a "Repricing" button, shows active rules count + top 20 suggestions after batch run. **No rule creation/edit UI.**

### Desired State

- Dedicated pricing page with rule management (CRUD)
- Per-product pricing detail in product detail sheet (current vs. suggested vs. competitors)
- Manual repricing trigger with progress feedback
- Pricing summary KPIs (avg margin, repricing coverage, suggestion acceptance rate)

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Pricing rules list view (all rules with status, last applied, product name) |
| FR-2 | MUST | Create new pricing rule (select product, choose strategy, set params) |
| FR-3 | MUST | Edit and delete existing rules |
| FR-4 | MUST | Enable/disable individual rules |
| FR-5 | MUST | Per-product pricing detail: current sellPrice, suggestedPrice, competitor prices, margin |
| FR-6 | MUST | Manual trigger of batch repricing with progress/results |
| FR-7 | SHOULD | Pricing suggestions table: products with active suggestions, accept/reject |
| FR-8 | SHOULD | CompetitorPriceChart integrated in product detail (already exists, just needs wiring) |
| FR-9 | MAY | Repricing schedule configuration (enable runner, set interval) |
| FR-10 | MAY | New vs. used price differentiation |

### 2.2 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Rule list loads < 1s | Simple Firestore query |
| NFR-2 | Batch repricing: progress visible via SSE or polling | Use existing job stream pattern |
| NFR-3 | Dark + Light Mode | |
| NFR-4 | Multi-tenancy | tenantId on all rules |

---

## 3. Architecture

### 3.1 Backend Changes

**No new backend files needed.** All endpoints exist and work:

| Endpoint | Status | Notes |
|----------|--------|-------|
| `POST /api/v1/pricing/suggest/:productId` | ✅ Working | Returns suggestion with tier, confidence, matchBasis |
| `POST /api/v1/pricing/rules` | ✅ Working | Create/update rule |
| `GET /api/v1/pricing/rules` | ✅ Working | List all rules |
| `POST /api/v1/pricing/reprice-batch` | ✅ Working | Batch run, returns suggestions |
| `GET /competitor-prices?ean=` | ✅ Working | Live competitor lookup |
| `GET /competitor-history?productId=` | ✅ Working | 30-day price trends |

**One small backend addition:**

```
backend/routes/products.js    — Add DELETE /api/v1/pricing/rules/:ruleId
                                 (currently only create/update exists, no delete)
```

**Optional backend enhancement:**

```
backend/routes/products.js    — Add PATCH /api/v1/pricing/rules/:ruleId/toggle
                                 (enable/disable without full update)
```

### 3.2 Frontend Changes

**New Files:**

```
components/PricingDashboard.tsx                — Main pricing page (rules + suggestions + batch trigger)
components/pricing/PricingRuleList.tsx          — Table of all rules
components/pricing/PricingRuleForm.tsx          — Create/edit rule form (modal or inline)
components/pricing/PricingSuggestions.tsx        — Products with active suggestions, accept/reject
components/pricing/ProductPricingDetail.tsx      — Per-product: current + suggested + competitors + chart
hooks/usePricingRules.ts                        — CRUD operations for pricing rules
hooks/usePricingSuggestion.ts                   — Fetch suggestion for single product
```

**Modified Files:**

```
App.tsx                         — Add route /pricing → PricingDashboard
components/Sidebar.tsx          — Add "Preise" nav item
api/client.ts                   — Add deletePricingRule(), togglePricingRule(), fetchPricingSuggestion()
components/ProductDetail.tsx    — Add ProductPricingDetail tab/section (wire CompetitorPriceChart)
```

### 3.3 Data Model

**No schema changes.** The `pricingRules` collection already exists with the correct schema:

```javascript
{
  id: productId,              // document ID = product ID
  productId: string,
  ruleType: string,           // 'competitor_median' | 'category_match' | 'manual' | 'cost_plus'
  params: {
    minMargin?: number,       // e.g., 0.10 (10%)
    maxPrice?: number,
    minPrice?: number,
    targetMargin?: number,
    competitorFilter?: string  // 'new_only' | 'all'
  },
  active: boolean,
  lastApplied: string,        // ISO timestamp
  updatedAt: string
}
```

**Product pricing fields already exist** in `products_v2.details.pricing`:
- `sellPrice`, `buyPrice`, `suggestedPrice`, `pricingTier`, `pricingConfidence`, `pricingMatchBasis`, `lastPriceCheck`, `competitorPrices[]`

---

## 4. UI/UX Specification

### 4.1 User Flow — Pricing Dashboard

```
1. Seller clicks "Preise" in sidebar
2. PricingDashboard opens with 3 sections:
   a. KPI bar: Active Rules | Products with Suggestion | Avg Margin | Last Batch Run
   b. Rules tab: Table of all pricing rules
   c. Suggestions tab: Products with pending suggestions (accept/reject)
3. Rules tab:
   - Each row: Product name | Strategy | Params | Active toggle | Last Applied | [Edit] [Delete]
   - [+ Neue Regel] button → PricingRuleForm modal
4. Suggestions tab:
   - Each row: Product | Current Price | Suggested | Margin | Confidence | [Übernehmen] [Ablehnen]
   - [Repricing starten] button → triggers batch run, shows progress
5. Clicking a product name → navigates to product detail with pricing tab
```

### 4.2 User Flow — Product Pricing Detail

```
1. Seller opens product detail sheet
2. New "Preise" tab/section shows:
   a. Current: sellPrice, buyPrice, margin calculation
   b. Suggested: suggestedPrice with tier badge, confidence bar, matchBasis text
   c. Competitors: CompetitorPrices component (already exists)
   d. Trend: CompetitorPriceChart (already exists, needs wiring)
   e. [Vorschlag übernehmen] button → sets sellPrice = suggestedPrice
   f. [Preisregel erstellen] button → opens PricingRuleForm pre-filled
```

### 4.3 Component Hierarchy

```
<PricingDashboard>
  ├── <PricingKPIs>              — Active rules, products with suggestions, avg margin
  ├── <Tabs>
  │   ├── Tab "Regeln"
  │   │   └── <PricingRuleList>
  │   │       └── <PricingRuleRow> × N (product, strategy, params, toggle, actions)
  │   └── Tab "Vorschläge"
  │       └── <PricingSuggestions>
  │           └── <SuggestionRow> × N (product, prices, margin, accept/reject)
  └── <PricingRuleForm>          — Modal for create/edit (shared)

<ProductDetail>
  └── Tab "Preise"
      └── <ProductPricingDetail>
          ├── Current/Suggested price comparison
          ├── <CompetitorPrices />         ← existing, already works
          └── <CompetitorPriceChart />     ← existing, needs wiring
```

### 4.4 PricingRuleForm Fields

| Field | Type | Description |
|-------|------|-------------|
| Product | Search/select | Product picker (name/SKU/EAN search) |
| Strategy | Select | `Wettbewerber-Median` \| `Kategorie-Durchschnitt` \| `Kosten + Aufschlag` \| `Manuell` |
| Min. Marge | Number (%) | Mindest-Marge (default 10%) |
| Min. Preis | Number (€) | Absolute Preisuntergrenze |
| Max. Preis | Number (€) | Absolute Preisobergrenze |
| Aktiv | Toggle | Rule enabled/disabled |

### 4.5 Design

- Dashboard: same layout pattern as existing AdminTable view
- KPI tiles: `bg-app-surface rounded-md`, reuse pattern from ERR-001
- Rules table: `bg-app-surface`, active toggle as accent switch
- Suggestion rows: suggestedPrice in `text-accent font-semibold`, margin in green/red
- Confidence: small bar or badge (0.9 = "Hoch", 0.6 = "Mittel", 0.3 = "Niedrig")
- Strategy badges: colored pills per strategy type

### 4.6 States

| State | UI |
|-------|----|
| No rules | Empty state: "Noch keine Preisregeln — Erste Regel erstellen" |
| No suggestions | "Keine offenen Vorschläge — Repricing starten" |
| Batch running | Progress bar + processed/total counter |
| Batch complete | Results table: updated, skipped, errors |
| Rule deleted | Row removed with confirmation toast |

---

## 5. Technical Implementation

### 5.1 Build Sequence

```
Step 1: [Backend] Add DELETE /api/v1/pricing/rules/:ruleId
        - Deletes rule from pricingRules collection
        - Auth: products.write
        Test: API test — delete + 404 for non-existent

Step 2: [Backend] Add PATCH /api/v1/pricing/rules/:ruleId/toggle
        - Toggles active field
        - Auth: products.write
        Test: API test — toggle on/off

Step 3: [Frontend] hooks/usePricingRules.ts
        - listRules(), createRule(), updateRule(), deleteRule(), toggleRule()
        - Wraps existing + new API endpoints
        Test: Hook renders

Step 4: [Frontend] hooks/usePricingSuggestion.ts
        - fetchSuggestion(productId) → POST /api/v1/pricing/suggest/:id
        - acceptSuggestion(productId, price) → saves sellPrice via saveProduct()
        Test: Hook renders

Step 5: [Frontend] api/client.ts — add deletePricingRule, togglePricingRule
        Test: Build passes

Step 6: [Frontend] PricingRuleForm.tsx — create/edit modal
        - Product search field (reuse existing product search)
        - Strategy dropdown, margin/min/max inputs
        - Calls createRule() or updateRule()
        Test: Form renders, validates, submits

Step 7: [Frontend] PricingRuleList.tsx — rules table
        - Columns: Product | Strategy | Params | Active | Last Applied | Actions
        - Active toggle calls toggleRule()
        - Edit → PricingRuleForm pre-filled
        - Delete → confirmation + deleteRule()
        Test: Table renders with mock rules

Step 8: [Frontend] PricingSuggestions.tsx — suggestions table
        - Columns: Product | Current | Suggested | Margin | Confidence | Actions
        - [Übernehmen] → acceptSuggestion()
        - [Repricing starten] → repriceBatch() → poll/stream progress
        Test: Table renders, accept flow works

Step 9: [Frontend] PricingDashboard.tsx — main page with tabs
        - Tab "Regeln" → PricingRuleList
        - Tab "Vorschläge" → PricingSuggestions
        - KPI bar from rules + latest batch results
        Test: Page renders with tabs

Step 10: [Frontend] ProductPricingDetail.tsx — product detail tab
         - Current vs. suggested price display
         - Wire existing CompetitorPrices + CompetitorPriceChart
         - [Vorschlag übernehmen] + [Regel erstellen] buttons
         Test: Component renders in product detail

Step 11: [Frontend] Wire into App.tsx + Sidebar.tsx
         - Route /pricing → PricingDashboard
         - Sidebar "Preise" nav item
         - Product detail: add pricing tab
         Test: Navigation works
```

### 5.2 API Contracts

#### DELETE /api/v1/pricing/rules/:ruleId (NEW)

```javascript
// Response (200): { "ok": true }
// Response (404): { "ok": false, "error": { "code": "NOT_FOUND", "message": "Regel nicht gefunden" } }
```

#### PATCH /api/v1/pricing/rules/:ruleId/toggle (NEW)

```javascript
// Response (200): { "ok": true, "data": { "id": "...", "active": false } }
```

All other endpoints already exist and are documented in `pricing-engine.js`:

```javascript
// POST /api/v1/pricing/suggest/:productId → { suggestedPrice, margin, tier, confidence, matchBasis }
// POST /api/v1/pricing/rules → { id, productId, ruleType, params, active }
// GET  /api/v1/pricing/rules → [...rules]
// POST /api/v1/pricing/reprice-batch → { processed, updated, errors, suggestions[] }
```

### 5.3 Edge Cases

| # | Edge Case | Behavior |
|---|-----------|----------|
| 1 | Product has no EAN → Tier 1 skipped | Falls to Tier 2 (category) or Tier 0 (cost-plus) |
| 2 | Product has no buyPrice → margin unknown | Show "Einkaufspreis fehlt" warning |
| 3 | Suggested price < minPrice in rule | Clamp to minPrice, show note |
| 4 | No competitors found | Tier 0 cost-plus fallback, confidence 0.3 |
| 5 | Rule for product that was deleted | Rule listed with "Produkt nicht gefunden" badge |
| 6 | Batch repricing with 0 active rules | Info message: "Keine aktiven Regeln" |
| 7 | Accept suggestion → sellPrice unchanged (same value) | Toast: "Preis war bereits aktuell" |

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Test | File |
|------|------|
| `should delete pricing rule` | API test |
| `should toggle rule active state` | API test |
| `should return 404 for non-existent rule` | API test |

### 6.2 Manual Verification

```
□ Rule list shows all pricing rules
□ Create rule → rule appears in list
□ Edit rule → changes persisted
□ Delete rule → rule removed
□ Toggle → active/inactive state changes
□ Batch repricing → progress + results
□ Suggestions: accept sets sellPrice
□ Product detail: pricing tab shows current + suggested + competitors + chart
□ Dark + Light Mode
□ Empty states (no rules, no suggestions)
□ Products without EAN/buyPrice show appropriate warnings
```

---

## 7. References

### 7.1 Existing Backend

| File | Purpose |
|------|---------|
| `services/pricing-engine.js` | 3-tier algorithm, rules CRUD, batch repricing |
| `services/pricing-runner.js` | Scheduled runner (disabled) |
| `services/competitor-refresh-runner.js` | Background competitor fetcher (disabled) |
| `lib/competitor-prices.js` | eBay + Kaufland price lookup with cache |
| `routes/products.js` (L2057–2095) | 4 existing pricing endpoints |

### 7.2 Existing Frontend

| File | Purpose |
|------|---------|
| `components/CompetitorPrices.tsx` | Competitor listing display — **reuse** |
| `components/CompetitorPriceChart.tsx` | 30-day trend chart — **wire into product detail** |
| `components/capture/StepPricing.tsx` | Suggestion display in capture — **reference pattern** |
| `components/orders/OrderSettingsView.tsx` | Existing repricing trigger — **replace with PricingDashboard** |

### 7.3 Related Features

| Feature | Relationship |
|---------|-------------|
| BULK-001 | Bulk price updates use same saveProduct flow |
| RULE-001 | Visual rule engine can incorporate pricing rules |
| DASH-001 | Analytics dashboard may show pricing KPIs |

---

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-19 | 0.1 | Initial draft |
| 2026-03-19 | 1.0 | Complete spec — leverages existing backend, frontend-focused |
