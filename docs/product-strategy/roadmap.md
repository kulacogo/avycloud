# AvyCloud Product Roadmap — Prioritized Initiatives

**12 Features, 4 Phases, 18-Month Horizon**

---

## Priority Framework

Every feature is prioritized based on four criteria, in strict order:

1. **Production Safety** — Never break what works. No regressions, no downtime, no data loss.
2. **Competitive Gap Closure** — What blocks professional sellers from adopting AvyCloud today?
3. **USP Amplification** — What makes AvyCloud uniquely valuable and widens the AI moat?
4. **Revenue Enablement** — What unlocks new marketplace revenue or new customer segments?

### Effort Scale

| Label | Meaning | Approximate Duration |
|-------|---------|----------------------|
| **S** | Small — isolated feature, few files | 1 - 2 weeks |
| **M** | Medium — cross-cutting, multiple components | 3 - 5 weeks |
| **L** | Large — significant new system or integration | 6 - 10 weeks |
| **XL** | Extra Large — foundational architecture + multi-marketplace | 10 - 16 weeks |

---

## Phase 1: Foundation — Operational Parity (Q1 - Q2 2026)

> **Goal:** Close the critical gaps that prevent professional sellers from adopting AvyCloud.

These are table-stakes features. Without them, sellers with 50+ SKUs cannot run their business on AvyCloud. No amount of AI differentiation compensates for missing bulk operations or invisible errors.

| ID | Feature | Priority | Effort | Rationale |
|----|---------|----------|--------|-----------|
| **BULK-001** | Bulk Editing MVP | **P0** | M | Grundvoraussetzung fuer professionelle Nutzung. Managing 50+ SKUs one-by-one is impossible. Multi-select, bulk price update, bulk status change, bulk category assignment. This is the single biggest blocker for professional adoption. |
| **PRICE-001** | Pricing Engine UI | **P0** | S | Backend exists (`services/pricing-engine.js`), just needs frontend + runner activation. Quick win that delivers immediate value. Sellers need to see and control pricing rules, not just trust a black box. |
| **ERR-001** | Error Dashboard | **P0** | S | Centralized view for listing errors, sync failures, validation problems. Currently errors are scattered across logs and individual product views. Professional sellers need a single pane of glass for operational health. Essential for daily operations. |

### Phase 1 Success Criteria

- [ ] Seller can select 50 products and update price/status/category in one action
- [ ] Seller can view and configure pricing rules in the UI
- [ ] Seller can see all errors and sync problems in one dashboard view
- [ ] Zero regressions in existing functionality

---

## Phase 2: Intelligence — Deepen the Moat (Q2 - Q3 2026)

> **Goal:** Amplify AvyCloud's AI differentiation before competitors catch up.

The AI moat is AvyCloud's primary strategic advantage. This phase turns individual AI features (identify, enrich, improve) into a seamless pipeline and adds visual intelligence capabilities. Every month without these features is a month competitors use to close the gap.

| ID | Feature | Priority | Effort | Rationale |
|----|---------|----------|--------|-----------|
| **AI-001** | AI Listing Pipeline | **P1** | L | The killer feature: Photo -> Identify -> Enrich -> Optimize -> Publish in one continuous flow. Today these steps are disconnected. Connecting them creates the "magic moment" that no competitor can match. This is what makes sellers say "I could never go back." |
| **VAL-001** | Pre-Listing Validation | **P1** | M | Validate product data against marketplace-specific schemas before publish. Catch missing required fields, invalid categories, image size issues before they become listing errors. Channable and Rithum set the benchmark here. Reduces error rate and support load. |
| **IMG-001** | Image Enhancement | **P1** | M | Background removal, product staging, image optimization. Table stakes for 2026 — sellers expect it. Consider PhotoRoom API or remove.bg integration. Marketplace-compliant images directly from AvyCloud. |

### Phase 2 Success Criteria

- [ ] Seller can go from photo upload to live marketplace listing in under 5 minutes
- [ ] Pre-listing validation catches 90%+ of marketplace rejection reasons before publish
- [ ] Seller can enhance product images without leaving AvyCloud
- [ ] AI pipeline handles at least 100 products per batch run

---

## Phase 3: Scale — Professional Features (Q3 - Q4 2026)

> **Goal:** Make AvyCloud competitive with mid-market platforms for sellers at 1,000+ SKUs.

These features serve the upper end of the target segment — sellers who currently use PlentyONE or JTL because no lighter alternative supports their complexity. Variants, automation rules, and real analytics are the three pillars of professional-grade commerce tooling.

| ID | Feature | Priority | Effort | Rationale |
|----|---------|----------|--------|-----------|
| **RULE-001** | Visual Rule Engine | **P1** | XL | If/Then automation builder for product and order workflows. Examples: "If category = Electronics AND price > 100, set shipping = Versichert", "If stock < 5, pause listing on Kaufland". Channable's rule engine is the gold standard — this is a premium feature that justifies higher pricing tiers. |
| **VAR-001** | Variant Model | **P1** | L | Parent-child product relationships. A t-shirt in 5 colors and 4 sizes is 20 variants under 1 parent. Required for fashion, electronics (storage sizes), household (pack sizes). Without variants, entire product categories are unmanageable. Data model change in `products_v2`. |
| **DASH-001** | Analytics Dashboard | **P1** | L | Real-time KPIs: revenue by channel, sell-through rate, margin analysis, return rate trends, inventory turnover. Currently dashboard shows basic metrics. Professional sellers make decisions based on data — this is what keeps them logging in daily. |

### Phase 3 Success Criteria

- [ ] Seller can create automation rules via visual builder (no code)
- [ ] Products with variants display and edit correctly across all views
- [ ] Variant sync works correctly on eBay.de and Kaufland.de
- [ ] Analytics dashboard shows channel-level P&L with real margin data

---

## Phase 4: Growth — Marketplace Expansion (Q4 2026 - Q1 2027)

> **Goal:** Unlock new revenue channels and lower the barrier to entry.

Amazon.de is table stakes for any serious German multichannel platform. OTTO Market is a German differentiator that international competitors often skip. The onboarding wizard reduces time-to-value and improves conversion from signup to active seller.

| ID | Feature | Priority | Effort | Rationale |
|----|---------|----------|--------|-----------|
| **MP-001** | Amazon.de Integration | **P1** | XL | 50%+ of German online retail runs through Amazon. Not having Amazon support disqualifies AvyCloud for most professional sellers. SP-API integration: listings, orders, FBA/FBM, inventory sync. Complex but non-negotiable for growth. |
| **MP-002** | OTTO Market Integration | **P2** | L | German differentiator. OTTO is the #3 marketplace in Germany after Amazon and eBay. Rithum, PlentyONE, JTL, and magnalister all have it. OTTO's API is well-documented and the seller base overlaps heavily with AvyCloud's target segment. |
| **UX-001** | Onboarding Wizard | **P2** | M | Guided setup flow: connect marketplace -> import products -> first AI enrichment -> first listing. Reduces time-to-value from hours to minutes. Competitive with Billbee and Sellbrite ease-of-use. Critical for self-service growth without high-touch sales. |

### Phase 4 Success Criteria

- [ ] Seller can connect Amazon.de and sync products + orders
- [ ] Seller can connect OTTO Market and sync products + orders
- [ ] New seller completes onboarding wizard and has first enriched product in under 15 minutes

---

## Dependencies Graph

Features do not exist in isolation. This graph shows which initiatives enable or enhance others.

```
BULK-001 (Bulk Editing)
    |
    +---> RULE-001 (Rule Engine)
    |         Bulk editing infrastructure (multi-select, batch operations)
    |         provides the execution layer for rule-triggered actions.
    |
    +---> AI-001 (AI Listing Pipeline)
              Bulk operations enable batch AI processing
              (enrich 100 products, not just one).

AI-001 (AI Listing Pipeline)
    |
    +---> benefits from VAL-001 (Pre-Listing Validation)
    |         Validation gates in the pipeline catch errors
    |         before they reach the marketplace.
    |
    +---> benefits from IMG-001 (Image Enhancement)
              Enhanced images feed into the listing pipeline
              for marketplace-ready visual content.

VAL-001 (Pre-Listing Validation)
    |
    +---> MP-001 (Amazon.de)
    |         Amazon has the strictest listing requirements.
    |         Validation must be in place before Amazon launch.
    |
    +---> MP-002 (OTTO Market)
              OTTO also requires structured, validated product data.

VAR-001 (Variant Model)
    |
    +---> MP-001 (Amazon.de)
    |         Amazon variant handling (parent-child ASINs) requires
    |         the variant data model to be in place.
    |
    +---> MP-002 (OTTO Market)
              OTTO uses variant groups for size/color combinations.

ERR-001 (Error Dashboard)
    |
    +---> All features benefit
              Every new integration and pipeline adds potential
              error states. Centralized error visibility is foundational.
```

### Dependency Summary Table

| Feature | Hard Dependencies | Soft Dependencies (Benefits From) |
|---------|-------------------|-----------------------------------|
| BULK-001 | None | — |
| PRICE-001 | None | BULK-001 (bulk price updates) |
| ERR-001 | None | — |
| AI-001 | None | VAL-001, IMG-001, BULK-001 |
| VAL-001 | None | — |
| IMG-001 | None | — |
| RULE-001 | BULK-001 (execution layer) | VAL-001 |
| VAR-001 | None (data model change) | — |
| DASH-001 | None | — |
| MP-001 | VAR-001, VAL-001 | AI-001, RULE-001 |
| MP-002 | VAR-001, VAL-001 | AI-001, RULE-001 |
| UX-001 | AI-001 (first enrichment flow) | — |

### Critical Path

The longest dependency chain determines the minimum timeline:

```
BULK-001 (Q1) --> RULE-001 (Q3-Q4)
VAR-001 (Q3) + VAL-001 (Q2) --> MP-001 (Q4) --> full marketplace parity
AI-001 (Q2) + IMG-001 (Q2) --> UX-001 (Q1 2027) --> self-service growth
```

**BULK-001 is the keystone.** It establishes patterns (multi-select, batch operations, progress tracking) that nearly every subsequent feature builds upon. It ships first.

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| AI-001 pipeline complexity leads to scope creep | Delays Phase 2 by 4+ weeks | Ship MVP pipeline (identify + enrich + publish) first, add optimize step later |
| Amazon SP-API approval and integration complexity | Delays Phase 4 by 8+ weeks | Start SP-API application in Q2 2026, build integration in parallel with approval |
| Variant model requires products_v2 schema changes | Data migration risk in production | Additive-only changes (new fields), never rename or delete existing fields |
| Rule engine UX is hard to get right | Low adoption despite high effort | User-test with 3-5 sellers before full build. Ship templates first, custom rules second |
| German marketplace API changes (eBay/Kaufland) | Sync breakage in production | Webhook-first architecture, version-pinned API calls, monitoring via ERR-001 |

---

## Quarterly Summary

| Quarter | Theme | Deliverables |
|---------|-------|-------------|
| **Q1 2026** | Foundation | BULK-001, PRICE-001, ERR-001 |
| **Q2 2026** | Intelligence | AI-001 (MVP), VAL-001, IMG-001 |
| **Q3 2026** | Scale | RULE-001 (start), VAR-001, DASH-001 |
| **Q4 2026** | Growth (start) | RULE-001 (ship), MP-001 (start) |
| **Q1 2027** | Growth (ship) | MP-001 (ship), MP-002, UX-001 |
