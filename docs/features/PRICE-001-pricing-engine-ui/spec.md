# PRICE-001: Pricing Engine UI

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | PRICE-001 |
| **Title** | Pricing Engine UI |
| **Priority** | P0 |
| **Status** | Draft |
| **Change Level** | L1 |
| **Effort** | S |
| **Source** | marktanalyse |
| **Dependencies** | None (backend already exists at `backend/services/pricing-engine.js`) |
| **Protected Zones** | None (new frontend, existing backend) |
| **TASKS.md Module** | Pricing Engine UI (standalone), M-AUTO (Automatisierung) |

---

## Problem Statement

AvyCloud has a working pricing engine backend (`services/pricing-engine.js`) with pricingRules and repricing logic, but there is no frontend UI, no runner triggering it, and no way for users to access it. Competitors charge $85-750/mo just for repricing (Repricer.com, Rithum Velocity Repricer). This is pure wasted value — the backend is ready, it just needs a face.

---

## User Story

As a seller, I want to view and manage pricing rules through the AvyCloud UI, so that I can control automated repricing without needing backend access.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Display existing pricing rules in a list/table view |
| FR-2 | MUST | Allow creating new pricing rules (min/max price, target margin, competitor-based) |
| FR-3 | MUST | Allow editing and deleting pricing rules |
| FR-4 | MUST | Show pricing suggestions per product |
| FR-5 | SHOULD | Allow manual trigger of repricing run |
| FR-6 | SHOULD | Show repricing history/log |
| FR-7 | MAY | Support new/used price differentiation |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Repricer.com** | Dedicated repricing tool, $85-750/mo | AvyCloud backend exists but no UI |
| **Rithum** | Velocity Repricer with algorithmic pricing | AvyCloud has no runner/trigger |
| **Channable** | Rule-based price transformations per channel | AvyCloud has no pricing rules UI |
| **SellerCloud** | Bulk price updates with margin calculations | AvyCloud has no bulk pricing |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.
