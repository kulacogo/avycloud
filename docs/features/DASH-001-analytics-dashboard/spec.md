# DASH-001: Analytics Dashboard

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | DASH-001 |
| **Title** | Analytics Dashboard |
| **Priority** | P1 |
| **Status** | Draft |
| **Change Level** | L1 |
| **Effort** | L |
| **Source** | marktanalyse + competitive-analysis |
| **Dependencies** | None |
| **Protected Zones** | None (new views, new endpoints) |
| **TASKS.md Module** | M10 (Analytics) |

---

## Problem Statement

AvyCloud has no operational analytics dashboard. Inventory Forecast exists as a backend service but has no frontend. The current M10 module only has an Activity Feed (24h Timeline) — no KPIs, no charts, no drill-down. Competitors (Linnworks, Rithum, SellerCloud) provide real-time dashboards with channel performance, sell-through rates, stock projections, and margin analysis. Rated **HOCH** priority in the Marktanalyse.

---

## User Story

As a seller, I want to see real-time KPIs across all my sales channels in one dashboard, so that I can make data-driven decisions about pricing, inventory, and marketplace allocation.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Show GMV, order count, conversion rate per channel (eBay, Kaufland) |
| FR-2 | MUST | Show inventory KPIs (total stock, low-stock alerts, predicted stockout) |
| FR-3 | MUST | Show sell-through rate and sales velocity per product/category |
| FR-4 | SHOULD | Support date range filtering (today, 7d, 30d, custom) |
| FR-5 | SHOULD | Support drill-down from channel to category to SKU level (3-click max) |
| FR-6 | SHOULD | Support trend charts (revenue over time, orders over time) |
| FR-7 | MAY | Support anomaly detection (alerts on unusual sales/stock changes) |
| FR-8 | MAY | Support PDF/CSV export for management reporting |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Linnworks** | Real-time dashboards with channel performance, sell-through rates | AvyCloud has Activity Feed only |
| **Rithum** | Deep analytics with margin analysis and channel attribution | AvyCloud has no analytics views |
| **SellerCloud** | SKU-level drill-down, inventory projection charts | AvyCloud forecast is backend-only |
| **Billbee** | Simple but effective order/revenue dashboard | AvyCloud dashboard shows no KPIs |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.
