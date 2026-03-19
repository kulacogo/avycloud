# MP-001: Amazon.de Integration

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | MP-001 |
| **Title** | Amazon.de Integration |
| **Priority** | P1 |
| **Status** | Draft |
| **Change Level** | L3 (new external API integration) |
| **Effort** | XL |
| **Source** | competitive-analysis |
| **Dependencies** | Benefits from VAR-001 (variants), VAL-001 (validation) |
| **Protected Zones** | Will need new files in backend/lib/amazon-*.js, new route in backend/routes/marketplace.js |
| **TASKS.md Module** | Neue Marktplätze (Amazon) |

---

## Problem Statement

Amazon.de represents ~50% of German online retail. Every single competitor has Amazon integration -- PlentyONE, JTL, Billbee, magnalister, Channable, Rithum, Linnworks, even Sellbrite. AvyCloud currently only supports eBay and Kaufland. Without Amazon, AvyCloud cannot be considered a serious multi-channel platform for German sellers.

---

## User Story

As a German multichannel seller, I want to manage my Amazon.de listings alongside my eBay and Kaufland listings in AvyCloud, so that I can run my entire marketplace business from one platform.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Support Amazon SP-API authentication (OAuth2, refresh token) |
| FR-2 | MUST | Support product listing creation on Amazon.de |
| FR-3 | MUST | Support inventory sync (stock push to Amazon) |
| FR-4 | MUST | Support order import from Amazon.de |
| FR-5 | MUST | Support order status sync (shipped, tracking) |
| FR-6 | SHOULD | Support Amazon.de category mapping |
| FR-7 | SHOULD | Support variant listing (parent-child ASIN structure) |
| FR-8 | SHOULD | Support repricing rules for Amazon Buy Box |
| FR-9 | MAY | Support Amazon FBA inventory management |
| FR-10 | MAY | Support Amazon advertising data import |

---

## Implementation Note

Amazon SP-API is significantly more complex than eBay or Kaufland APIs. Requires Amazon Developer registration, app listing, and MWS migration awareness.

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **PlentyONE** | Full Amazon integration (listings, orders, FBA, returns) | AvyCloud has no Amazon support |
| **JTL** | Amazon integration via JTL-eazyAuction, FBA support | AvyCloud has no Amazon support |
| **Billbee** | Amazon order import, inventory sync, multi-account | AvyCloud has no Amazon support |
| **magnalister** | Amazon listing push from WooCommerce/Shopware | AvyCloud has no Amazon support |
| **Channable** | Amazon feed management, category mapping, repricing | AvyCloud has no Amazon support |
| **Rithum** | Full Amazon lifecycle (catalog, orders, advertising) | AvyCloud has no Amazon support |
| **Linnworks** | Amazon multi-account, FBA, MCF integration | AvyCloud has no Amazon support |
| **Sellbrite** | Amazon listing + inventory sync (basic) | AvyCloud has no Amazon support |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.
