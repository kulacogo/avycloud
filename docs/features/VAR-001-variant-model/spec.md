# VAR-001: Variant Model (Parent-Child)

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | VAR-001 |
| **Title** | Variant Model (Parent-Child) |
| **Priority** | P1 |
| **Status** | Draft |
| **Change Level** | L3 (data model change) |
| **Effort** | L |
| **Source** | marktanalyse |
| **Dependencies** | None, but BULK-001 benefits from variant-aware editing |
| **Protected Zones** | `backend/lib/product-store.js`, `backend/lib/product-canonical.js`, `products_v2` schema |
| **TASKS.md Module** | Standalone — blocks fashion, electronics, household verticals |

---

## Problem Statement

AvyCloud has no concept of product variants. `products_v2` treats every item as a standalone product. Competitors (SellerCloud, PlentyONE, Linnworks) offer native parent-child structures with visual variant matrices. Without variants, AvyCloud cannot properly handle fashion (sizes/colors), electronics (storage/color), or household (size/quantity) products. Rated **HOCH** priority in the Marktanalyse.

---

## User Story

As a seller with variant products, I want to manage parent products with child variants (size, color, material), so that my listings correctly represent product families on each marketplace.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Support parent-child product relationships in `products_v2` |
| FR-2 | MUST | Support variant attributes (size, color, material, storage, quantity) |
| FR-3 | MUST | Support per-variant pricing, stock, SKU, EAN |
| FR-4 | MUST | Support attribute inheritance from parent to children |
| FR-5 | MUST | Support visual variant matrix in product detail view |
| FR-6 | SHOULD | Support channel-specific variant mapping (eBay item specifics vs. Kaufland attributes) |
| FR-7 | SHOULD | Support automatic SKU generation for variants |
| FR-8 | MUST | Maintain backward compatibility with existing non-variant products |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **SellerCloud** | Native parent-child with visual variant matrix | AvyCloud has no variant model |
| **PlentyONE** | Full variant handling with marketplace-specific mapping | AvyCloud treats all products as standalone |
| **Linnworks** | Variant groups with bulk editing support | AvyCloud has no variant awareness |
| **JTL-Wawi** | Deep variant/attribute management (DACH-native) | AvyCloud can't handle fashion/electronics |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.
